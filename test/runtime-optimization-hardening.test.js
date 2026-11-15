const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { PGlite } = require("@electric-sql/pglite");

const { loadConfig } = require("../src/config");
const { createPriorityPoolController } = require("../src/db");
const { readBoundedText, readBoundedJson } = require("../src/lib/http-response");
const { ForecastCache } = require("../src/inventory-forecast");
const { smartPageCache, flushAllCache } = require("../cache");
const { migrateDatabase } = require("../src/migrate");
const { attachTransactionalCacheInvalidation } = require("../src/app");
const { releaseExpiredCheckoutIntents } = require("../src/store-api");

const VALID_BCRYPT_HASH = "$2a$04$012345678901234567890u0123456789012345678901234567890";

function createSingleMutexPglitePool(t) {
  let db = null;
  let queue = Promise.resolve();
  async function acquireLock() {
    const prev = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await prev;
    return release;
  }
  return PGlite.create().then(async (instance) => {
    db = instance;
    async function rawQuery(sql, values) {
      const res = !values && sql.includes(";")
        ? (await db.exec(sql)).at(-1)
        : await db.query(sql, values);
      return {
        ...res,
        rows: res?.rows || [],
        rowCount: res?.affectedRows ?? res?.rows?.length ?? 0
      };
    }
    const pool = {
      async query(sql, values) {
        const release = await acquireLock();
        try {
          return await rawQuery(sql, values);
        } finally {
          release();
        }
      },
      async connect() {
        const release = await acquireLock();
        let released = false;
        return {
          query: rawQuery,
          release() {
            if (!released) {
              released = true;
              release();
            }
          }
        };
      }
    };
    t.after(async () => {
      if (db) await db.close();
    });
    await migrateDatabase(pool);
    return pool;
  });
}

test("loadConfig validates PostgreSQL and HTTP timeout bounds", () => {
  const baseEnv = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://gaeru:pass@127.0.0.1:5432/gaeru",
    SESSION_SECRET: "gaeru-test-session-secret-minimum-32-chars",
    ADMIN_USERNAME: "gaeru_admin",
    ADMIN_PASSWORD_HASH: VALID_BCRYPT_HASH
  };

  const valid = loadConfig({
    ...baseEnv,
    PG_STATEMENT_TIMEOUT_MS: "15000",
    PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: "20000",
    PG_LOCK_TIMEOUT_MS: "5000",
    PG_IDLE_TIMEOUT_MS: "30000",
    PG_CONNECTION_TIMEOUT_MS: "4000",
    HTTP_REQUEST_TIMEOUT_MS: "60000"
  });
  assert.equal(valid.PG_STATEMENT_TIMEOUT_MS, 15000);
  assert.equal(valid.PG_IDLE_IN_TRANSACTION_TIMEOUT_MS, 20000);
  assert.equal(valid.PG_LOCK_TIMEOUT_MS, 5000);
  assert.equal(valid.PG_IDLE_TIMEOUT_MS, 30000);
  assert.equal(valid.PG_CONNECTION_TIMEOUT_MS, 4000);
  assert.equal(valid.HTTP_REQUEST_TIMEOUT_MS, 60000);

  assert.throws(
    () => loadConfig({ ...baseEnv, PG_STATEMENT_TIMEOUT_MS: "500" }),
    /Invalid environment configuration.*PG_STATEMENT_TIMEOUT_MS/
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, PG_LOCK_TIMEOUT_MS: "100" }),
    /Invalid environment configuration.*PG_LOCK_TIMEOUT_MS/
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, HTTP_REQUEST_TIMEOUT_MS: "1000" }),
    /Invalid environment configuration.*HTTP_REQUEST_TIMEOUT_MS/
  );
});

test("createPriorityPoolController clamps low/high caps and makes client.release idempotent", async () => {
  const mockPool = {
    options: { max: 4 },
    async query() {
      return { rows: [] };
    },
    async connect() {
      let innerReleased = 0;
      return {
        async query() {
          return { rows: [] };
        },
        release() {
          innerReleased++;
          return innerReleased;
        }
      };
    }
  };

  const ctrl = createPriorityPoolController(mockPool, {
    maxLowPriorityOps: 99,
    maxHighPriorityOps: 99
  });
  assert.equal(ctrl.getStats().maxLowPriorityOps, 3);
  assert.equal(ctrl.getStats().maxHighPriorityOps, 4);

  const singleSlotCtrl = createPriorityPoolController({ options: { max: 1 }, async query() {} }, {
    maxLowPriorityOps: 5,
    maxHighPriorityOps: 5
  });
  assert.equal(singleSlotCtrl.getStats().maxLowPriorityOps, 1);
  assert.equal(singleSlotCtrl.getStats().maxHighPriorityOps, 1);

  const lowClient = await ctrl.lowPriorityPool.connect();
  assert.equal(ctrl.getStats().activeLowOps, 1);
  lowClient.release();
  lowClient.release();
  assert.equal(ctrl.getStats().activeLowOps, 0);

  const highClient = await ctrl.highPriorityPool.connect();
  assert.equal(ctrl.getStats().activeHighOps, 1);
  highClient.release();
  highClient.release();
  assert.equal(ctrl.getStats().activeHighOps, 0);
});

test("readBoundedText and readBoundedJson enforce content-length and streaming byte caps", async () => {
  const headerOverflowRes = {
    headers: { get: (k) => (k.toLowerCase() === "content-length" ? "4096" : null) },
    body: null
  };
  await assert.rejects(
    () => readBoundedText(headerOverflowRes, { maxBytes: 1024, label: "TestHeader" }),
    (err) => err && err.status === 502 && /exceeded 1024 bytes/.test(err.message)
  );

  let cancelled = false;
  let pulled = 0;
  const streamOverflowRes = {
    headers: { get: () => null },
    body: new ReadableStream({
      pull(controller) {
        pulled++;
        if (pulled <= 4) {
          controller.enqueue(new Uint8Array(600));
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      }
    })
  };
  await assert.rejects(
    () => readBoundedText(streamOverflowRes, { maxBytes: 1000, label: "TestStream" }),
    (err) => err && err.status === 502 && /exceeded 1000 bytes/.test(err.message)
  );
  assert.equal(cancelled, true);

  const jsonOkRes = {
    headers: { get: () => null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, count: 42 })));
        controller.close();
      }
    })
  };
  assert.deepEqual(await readBoundedJson(jsonOkRes, { maxBytes: 1024, label: "TestJson" }), { ok: true, count: 42 });

  const mockJsonRes = {
    headers: { get: () => null },
    async json() {
      return { legacy: true };
    }
  };
  assert.deepEqual(await readBoundedJson(mockJsonRes, { maxBytes: 1024 }), { legacy: true });
});

test("ForecastCache bounds entry count and prunes expired items", async () => {
  const cache = new ForecastCache(60_000, 3);
  assert.equal(cache.maxEntries, 10);

  cache.set("expired-1", { v: 0 }, -10);
  assert.equal(cache.get("expired-1"), null);

  for (let i = 0; i < 15; i++) {
    cache.set(`key-${i}`, { i }, 60_000);
  }
  assert.equal(cache.size(), 10);
  assert.equal(cache.get("key-0"), null);
  assert.deepEqual(cache.get("key-14"), { i: 14 });
});

test("smartPageCache canonicalizes query strings by allowlist and ignores tracking params", async (t) => {
  flushAllCache();
  t.after(() => flushAllCache());

  let renderCount = 0;
  const app = express();
  app.use(smartPageCache(60_000));
  app.get("/san-pham", (req, res) => {
    renderCount++;
    res.type("html").send(`<html><body>id=${String(req.query.id || "")} count=${renderCount}</body></html>`);
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const r1 = await fetch(`${baseUrl}/san-pham?id=k9&fbclid=fb123&utm_source=ads`);
  assert.equal(r1.status, 200);
  const body1 = await r1.text();
  assert.match(body1, /id=k9 count=1/);

  const r2 = await fetch(`${baseUrl}/san-pham?utm_campaign=tet&gclid=gg456&id=k9`);
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get("x-cache"), "HIT-FRESH-RAM");
  assert.equal(renderCount, 1);

  const r3 = await fetch(`${baseUrl}/san-pham?id=m8&fbclid=fb123`);
  assert.equal(r3.status, 200);
  assert.notEqual(r3.headers.get("x-cache"), "HIT-FRESH-RAM");
  assert.equal(renderCount, 2);
});

test("releaseExpiredCheckoutIntents restores held inventory on single-mutex PGlite without deadlock", async (t) => {
  const pool = await createSingleMutexPglitePool(t);

  const whRes = await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN' LIMIT 1");
  const warehouseId = whRes.rows[0].id;

  const prodRes = await pool.query(
    `INSERT INTO products (slug, name, category, active)
     VALUES ('lock-test-mic', 'Lock Test Mic', 'audio', true)
     RETURNING id`
  );
  const varRes = await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-LOCK-1', 'Standard', 1000000, 5, true)
     RETURNING id`,
    [prodRes.rows[0].id]
  );
  const variantId = varRes.rows[0].id;

  await pool.query(
    `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
     VALUES ($1, $2, 5)`,
    [warehouseId, variantId]
  );

  const intentRes = await pool.query(
    `INSERT INTO checkout_payment_intents (order_number, provider, provider_request_id, amount_vnd, status, expires_at)
     VALUES ('GR-EXP-001', 'momo', 'REQ-EXP-001', 2000000, 'pending_provider', now() - interval '10 minutes')
     RETURNING id`
  );
  const intentId = intentRes.rows[0].id;

  await pool.query(
    `INSERT INTO checkout_stock_holds (intent_id, variant_id, warehouse_id, quantity)
     VALUES ($1, $2, $3, 2)`,
    [intentId, variantId, warehouseId]
  );

  await Promise.race([
    releaseExpiredCheckoutIntents(pool),
    new Promise((_, reject) => setTimeout(() => reject(new Error("releaseExpiredCheckoutIntents timed out (possible deadlock)")), 5000))
  ]);

  const updatedIntent = await pool.query("SELECT status FROM checkout_payment_intents WHERE id = $1", [intentId]);
  assert.equal(updatedIntent.rows[0].status, "expired");

  const updatedHold = await pool.query("SELECT released_at FROM checkout_stock_holds WHERE intent_id = $1", [intentId]);
  assert.ok(updatedHold.rows[0].released_at instanceof Date);

  const updatedVariant = await pool.query("SELECT stock_quantity FROM product_variants WHERE id = $1", [variantId]);
  assert.equal(updatedVariant.rows[0].stock_quantity, 7);

  const updatedWhStock = await pool.query(
    "SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2",
    [warehouseId, variantId]
  );
  assert.equal(updatedWhStock.rows[0].quantity, 7);
});

test("attachTransactionalCacheInvalidation on priority proxy never recurses or leaks pool slots", async () => {
  let rawQueryCalls = 0;
  let rawConnectCalls = 0;
  let rawReleaseCalls = 0;
  const origQuery = async (sql) => {
    rawQueryCalls++;
    return { rows: [{ sql }] };
  };
  const origConnect = (cb) => {
    rawConnectCalls++;
    const client = {
      async query(sql) {
        rawQueryCalls++;
        return { rows: [{ sql }] };
      },
      release() {
        rawReleaseCalls++;
      }
    };
    if (typeof cb === "function") return cb(null, client, () => rawReleaseCalls++);
    return Promise.resolve(client);
  };
  const rawPool = { options: { max: 4 }, query: origQuery, connect: origConnect };

  const ctrl = createPriorityPoolController(rawPool, { maxLowPriorityOps: 1, maxHighPriorityOps: 3 });
  attachTransactionalCacheInvalidation(ctrl.highPriorityPool);

  assert.equal(rawPool.connect, origConnect);
  assert.equal(rawPool.query, origQuery);
  assert.equal(rawPool.__gaeruCacheHooked, undefined);
  assert.equal(ctrl.highPriorityPool.__gaeruCacheHooked, true);

  const client = await Promise.race([
    ctrl.highPriorityPool.connect(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("connect timeout (proxy recursion)")), 2000))
  ]);
  assert.equal(ctrl.getStats().activeHighOps, 1);
  await client.query("BEGIN");
  await client.query("UPDATE products SET active = true WHERE id = $1", ["x"]);
  await client.query("COMMIT");
  client.release();
  client.release();

  await new Promise((resolve, reject) => {
    ctrl.highPriorityPool.connect((err, cbClient, done) => {
      if (err) return reject(err);
      assert.equal(ctrl.getStats().activeHighOps, 1);
      cbClient.release();
      done();
      resolve();
    });
  });

  await ctrl.highPriorityPool.query("SELECT 1");
  assert.equal(ctrl.getStats().activeHighOps, 0);
  assert.equal(rawConnectCalls, 2);
  assert.equal(rawReleaseCalls, 2);
  assert.ok(rawQueryCalls >= 4);
});

{
  const fs = require("node:fs");
  const path = require("node:path");
  const http = require("node:http");
  const crypto = require("node:crypto");
  const zlib = require("node:zlib");
  const session = require("express-session");
  const { createApp } = require("../src/app");
  const { createDdosShield } = require("../src/security-shield");
  const { _clearCacheForTest } = require("../src/lib/static-asset-cache");

  const httpRequest = (url, headers = {}, method = "GET") =>
    new Promise((resolve, reject) => {
      const req = http.request(url, { method, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      });
      req.on("error", reject);
      req.end();
    });

  test("static CSS/JS serve pre-compressed br/gzip from RAM and grant immutable only for verified SHA-256 hash", async (t) => {
    _clearCacheForTest();
    const pool = { query: async () => ({ rows: [] }) };
    const app = createApp({
      pool,
      sessionStore: new session.MemoryStore(),
      config: { NODE_ENV: "test", SESSION_SECRET: "runtime-opt-fixture-secret-at-least-32-chars" }
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(() => new Promise((r) => server.close(r)));

    const base = "http://127.0.0.1:" + server.address().port;
    const stylesRaw = fs.readFileSync(path.join(__dirname, "..", "styles.css"));
    const stylesHash12 = crypto.createHash("sha256").update(stylesRaw).digest("hex").slice(0, 12);

    const brRes = await httpRequest(`${base}/styles.css?v=${stylesHash12}`, { "Accept-Encoding": "gzip, br" });
    assert.equal(brRes.status, 200);
    assert.equal(brRes.headers["content-encoding"], "br");
    assert.equal(brRes.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(brRes.headers["content-type"], "text/css; charset=utf-8");
    assert.match(brRes.headers.vary, /Accept-Encoding/i);
    assert.deepEqual(zlib.brotliDecompressSync(brRes.body), stylesRaw);

    const res304 = await httpRequest(`${base}/styles.css?v=${stylesHash12}`, {
      "Accept-Encoding": "br, gzip",
      "If-None-Match": brRes.headers.etag
    });
    assert.equal(res304.status, 304);
    assert.equal(res304.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(res304.body.length, 0);

    const qZeroRes = await httpRequest(`${base}/styles.css?v=${stylesHash12}`, {
      "Accept-Encoding": "br;q=0, gzip;q=1"
    });
    assert.equal(qZeroRes.status, 200);
    assert.equal(qZeroRes.headers["content-encoding"], "gzip");
    assert.notEqual(qZeroRes.headers.etag, brRes.headers.etag);
    assert.deepEqual(zlib.gunzipSync(qZeroRes.body), stylesRaw);

    const unhashedRes = await httpRequest(`${base}/styles.css?v=20261025-arbitrary`, { "Accept-Encoding": "gzip" });
    assert.equal(unhashedRes.status, 200);
    assert.equal(unhashedRes.headers["content-encoding"], "gzip");
    assert.equal(unhashedRes.headers["cache-control"], "public, max-age=0, must-revalidate");

    const scriptRaw = fs.readFileSync(path.join(__dirname, "..", "script.js"));
    const scriptHash12 = crypto.createHash("sha256").update(scriptRaw).digest("hex").slice(0, 12);
    const jsRes = await httpRequest(`${base}/script.js?v=${scriptHash12}`, { "Accept-Encoding": "br, gzip" });
    assert.equal(jsRes.status, 200);
    assert.equal(jsRes.headers["content-encoding"], "br");
    assert.equal(jsRes.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(jsRes.headers["cache-control"], "public, max-age=31536000, immutable");

    const accountJs = await httpRequest(`${base}/account.js?v=${stylesHash12}`, { "Accept-Encoding": "gzip" });
    assert.equal(accountJs.status, 200);
    assert.equal(accountJs.headers["cache-control"], "no-store");

    const privateJs = await httpRequest(`${base}/cache.js`);
    assert.equal(privateJs.status, 404);
  });

  test("createDdosShield skips PostgreSQL writes on public cached reads while enforcing 429 and PG persistence on mutations/queries", async (t) => {
    const rateLimitQueries = [];
    const pool = {
      async query(sql, params) {
        if (String(sql).includes("security_rate_limits")) {
          rateLimitQueries.push({ sql, params });
          if (String(sql).includes("INSERT INTO security_rate_limits")) {
            return { rows: [{ hits: 1, expires_at: new Date(Date.now() + 60000).toISOString() }] };
          }
        }
        return { rows: [] };
      }
    };

    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let shield;
    try {
      shield = createDdosShield({ NODE_ENV: "production", DDOS_RATE_LIMIT: 2 }, pool);
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }

    const app = express();
    app.use(["/api", "/server_admin/api"], shield);
    app.get("/api/products", (_req, res) => res.json({ ok: true }));
    app.get("/api/products/:slug", (_req, res) => res.json({ ok: true }));
    app.get("/api/products/:slug/bundles", (_req, res) => res.json({ ok: true }));
    app.get("/api/search-index.json", (_req, res) => res.json({ ok: true }));
    app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
    app.get("/api/bot-protection", (_req, res) => res.json({ enabled: false }));
    app.all("/api/orders", (_req, res) => res.json({ ok: true }));
    app.post("/server_admin/api/login", (_req, res) => res.json({ ok: true }));

    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = "http://127.0.0.1:" + server.address().port;

    for (const p of ["/api/products", "/api/products/m3", "/api/products/m3/bundles", "/api/search-index.json"]) {
      const r = await httpRequest(base + p);
      assert.equal(r.status, 200, "Expected 200 for " + p);
    }
    assert.equal(rateLimitQueries.length, 0, "Public cached reads must not write to security_rate_limits");

    const limited = await httpRequest(base + "/api/health");
    assert.equal(limited.status, 429);
    assert.equal(JSON.parse(limited.body.toString()).code, "DDOS_RATE_LIMITED");
    assert.equal(rateLimitQueries.length, 0);

    for (const [method, p] of [
      ["POST", "/api/orders"],
      ["GET", "/api/orders"],
      ["GET", "/api/products?q=m3"],
      ["POST", "/server_admin/api/login"]
    ]) {
      const before = rateLimitQueries.length;
      const r = await httpRequest(base + p, {}, method);
      assert.equal(r.status, 200);
      assert.ok(rateLimitQueries.length > before, `Expected PG rate limit write for ${method} ${p}`);
    }
  });
}
