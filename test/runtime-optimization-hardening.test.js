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
      shield = createDdosShield({ NODE_ENV: "production", DDOS_RATE_LIMIT: 5 }, pool);
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
    }

    const app = express();
    app.use("/api", shield);
    app.get("/api/products", (_req, res) => res.json({ ok: true }));
    app.get("/api/products/:slug", (_req, res) => res.json({ ok: true }));
    app.get("/api/products/:slug/bundles", (_req, res) => res.json({ ok: true }));
    app.get("/api/search-index.json", (_req, res) => res.json({ ok: true }));
    app.get("/api/settings/public", (_req, res) => res.json({ ok: true }));
    app.get("/api/news", (_req, res) => res.json({ ok: true }));
    app.get("/api/news/:slug", (_req, res) => res.json({ ok: true }));
    app.get("/api/news-images/:id", (_req, res) => res.json({ ok: true }));
    app.get("/api/home-banner/images/:id", (_req, res) => res.json({ ok: true }));
    app.get("/api/gaeru_ceo/news", (_req, res) => res.json({ ok: true }));
    app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
    app.get("/api/bot-protection", (_req, res) => res.json({ enabled: false }));
    app.all("/api/orders", (_req, res) => res.json({ ok: true }));
    app.post("/api/auth/login", (_req, res) => res.json({ ok: true }));

    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = "http://127.0.0.1:" + server.address().port;

    for (const p of [
      "/api/products",
      "/api/products/m3",
      "/api/products/m3/bundles",
      "/api/search-index.json",
      "/api/settings/public",
      "/api/news",
      "/api/news/le-audio",
      "/api/news-images/00000000-0000-4000-8000-000000000001",
      "/api/home-banner/images/00000000-0000-4000-8000-000000000002",
      "/api/bot-protection"
    ]) {
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
      ["GET", "/api/gaeru_ceo/news"],
      ["POST", "/api/auth/login"]
    ]) {
      const before = rateLimitQueries.length;
      const r = await httpRequest(base + p, {}, method);
      assert.equal(r.status, 200);
      assert.ok(rateLimitQueries.length > before, `Expected PG rate limit write for ${method} ${p}`);
    }
  });

  test("clearAssetSnapshotCache({ all: true }) invalidates stale asset snapshots across distinct pool references", async (t) => {
    const os = require("node:os");
    const tmpAssets = fs.mkdtempSync(path.join(os.tmpdir(), "gaeru-assets-epoch-"));
    const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gaeru-media-epoch-"));
    t.after(() => {
      fs.rmSync(tmpAssets, { recursive: true, force: true });
      fs.rmSync(mediaRoot, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(tmpAssets, "products"), { recursive: true });
    const imgPath = path.join(tmpAssets, "products", "sample.webp");
    const oldBytes = Buffer.from("RIFF1234WEBPVP8Xold-asset-bytes");
    const newBytes = Buffer.from("RIFF1234WEBPVP8Xnew-smaller");
    fs.writeFileSync(imgPath, oldBytes);

    const prevRoot = process.env.MEDIA_ROOT;
    const prevEnabled = process.env.MEDIA_CACHE_ENABLED;
    process.env.MEDIA_ROOT = mediaRoot;
    process.env.MEDIA_CACHE_ENABLED = "true";
    t.after(() => {
      if (prevRoot === undefined) delete process.env.MEDIA_ROOT;
      else process.env.MEDIA_ROOT = prevRoot;
      if (prevEnabled === undefined) delete process.env.MEDIA_CACHE_ENABLED;
      else process.env.MEDIA_CACHE_ENABLED = prevEnabled;
    });

    const snapshots = new Map();
    const makePool = () => ({
      async query(sql, params) {
        if (String(sql).includes("INSERT INTO site_asset_snapshots")) {
          const [rel, storageKey, mimeType, byteSize, sha256] = params;
          const prev = snapshots.get(rel);
          if (!prev || prev.sha256 !== sha256) {
            snapshots.set(rel, { path: rel, storage_key: storageKey, mime_type: mimeType, byte_size: byteSize, sha256 });
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (String(sql).includes("SELECT * FROM site_asset_snapshots WHERE path=$1")) {
          const row = snapshots.get(params[0]);
          return { rows: row ? [row] : [] };
        }
        return { rows: [], rowCount: 0 };
      }
    });

    const syncPool = makePool();
    const requestPool = makePool();
    const { syncAssets, serveAssets } = require("../src/persistent-assets");
    await syncAssets(syncPool, { source: tmpAssets });

    const app = express();
    app.use("/assets", serveAssets(requestPool));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = "http://127.0.0.1:" + server.address().port;

    const first = await httpRequest(base + "/assets/products/sample.webp");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, oldBytes);

    // Simulate updated asset synced on another pool wrapper (raw pool vs highPriorityPool)
    fs.writeFileSync(imgPath, newBytes);
    const result = await syncAssets(syncPool, { source: tmpAssets });
    assert.equal(result.updated, 1);

    const second = await httpRequest(base + "/assets/products/sample.webp");
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, newBytes);
  });

  test("cleanRoutes hashes all cacheable CSS/JS to immutable and omits DCB Vary tokens when DCB is disabled", async (t) => {
    flushAllCache();
    const { cleanRoutes, staticHtml } = require("../src/clean-routes");
    const { getAssetHash12 } = require("../src/lib/static-asset-cache");
    const projectRoot = path.resolve(__dirname, "..");

    const prevEnv = process.env.NODE_ENV;
    const prevDcb = process.env.ENABLE_DCB;
    process.env.NODE_ENV = "production";
    delete process.env.ENABLE_DCB;
    t.after(() => {
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
      if (prevDcb === undefined) delete process.env.ENABLE_DCB;
      else process.env.ENABLE_DCB = prevDcb;
    });

    const app = express();
    app.use(cleanRoutes("https://gaeru.com"));
    app.use(smartPageCache());
    app.use(staticHtml);

    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = "http://127.0.0.1:" + server.address().port;

    const home = await httpRequest(base + "/ho-tro", { "Accept-Encoding": "gzip" });
    assert.equal(home.status, 200);
    const html = (home.headers["content-encoding"] === "gzip" ? require("node:zlib").gunzipSync(home.body) : home.body).toString("utf8");
    for (const file of ["styles.css", "brand.css", "store-shell.js", "footer-products.js", "clean-urls.js"]) {
      const h12 = getAssetHash12(projectRoot, file);
      assert.ok(h12, `Expected SHA-256 hash12 for ${file}`);
      assert.ok(html.includes(`/${file}?v=${h12}`), `Rendered HTML must rewrite ${file} to ?v=${h12}`);
    }
    const vary = String(home.headers.vary || "");
    assert.match(vary, /Accept-Encoding/i);
    assert.doesNotMatch(vary, /Available-Dictionary|Sec-Purpose/i);

    await new Promise((r) => setTimeout(r, 60));
    const warmHome = await httpRequest(base + "/ho-tro", { "Accept-Encoding": "gzip" });
    assert.equal(warmHome.status, 200);
    assert.equal(warmHome.headers["x-cache"], "HIT-FRESH-RAM");
    assert.doesNotMatch(String(warmHome.headers.vary || ""), /Available-Dictionary|Sec-Purpose/i);

    const account = await httpRequest(base + "/tai-khoan");
    assert.equal(account.status, 200);
    const accountHtml = account.body.toString("utf8");
    assert.match(accountHtml, /\/account\.js\?v=/);
    const accountHash = getAssetHash12(projectRoot, "account.js");
    assert.equal(accountHash, null, "Private account.js must never receive immutable content hashing");
  });

  test("public API reads and DB images emit public cache headers without Vary: Cookie, Pragma, or Expires", async (t) => {
    const session = require("express-session");
    const { createApp } = require("../src/app");
    const { optimizeImage } = require("../src/lib/image-optimizer");
    const imgBuf = await require("sharp")({ create: { width: 12, height: 12, channels: 4, background: { r: 10, g: 120, b: 220, alpha: 1 } } }).png().toBuffer();
    const optimized = (await optimizeImage(imgBuf, "image/png")).buffer;
    const coverId = "a0000000-0000-4000-8000-000000000099";
    let newsSelects = 0;

    const pool = {
      async query(sql) {
        const s = String(sql);
        if (s.includes("INSERT INTO security_rate_limits")) {
          return { rows: [{ hits: 1, expires_at: new Date(Date.now() + 60000).toISOString() }] };
        }
        if (s.includes("FROM news_images")) {
          return { rows: [{ content: optimized, mime_type: "image/webp" }] };
        }
        if (s.includes("FROM products")) return { rows: [] };
        if (s.includes("FROM store_settings")) return { rows: [] };
        if (s.includes("FROM shipping_carrier_connections")) return { rows: [] };
        if (s.includes("FROM payment_channel_connections")) return { rows: [] };
        if (s.includes("FROM news_posts")) {
          newsSelects++;
          return { rows: [{ id: 1, slug: "test-post", title: "Bài thử", excerpt: "Tóm tắt thử nghiệm", coverId, imageAlt: "Ảnh", status: "published", version: 1, publishedAt: new Date("2026-11-16T00:00:00Z"), updatedAt: new Date("2026-11-16T00:00:00Z") }] };
        }
        return { rows: [] };
      }
    };

    const app = createApp({
      pool,
      sessionStore: new session.MemoryStore(),
      config: { NODE_ENV: "test", SESSION_SECRET: "cache-headers-test-secret-32chars-minimum" }
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = "http://127.0.0.1:" + server.address().port;

    for (const p of ["/api/products", "/api/settings/public", "/api/news", `/api/news-images/${coverId}`]) {
      const r = await httpRequest(base + p);
      assert.equal(r.status, 200, "Expected 200 for " + p);
      assert.doesNotMatch(String(r.headers.vary || ""), /\bCookie\b/i, `${p} must not vary on Cookie`);
      assert.equal(r.headers.pragma, undefined, `${p} must not send Pragma: no-cache`);
      assert.equal(r.headers.expires, undefined, `${p} must not send Expires: 0`);
      assert.match(String(r.headers["cache-control"] || ""), /^public,\s*max-age=/i, `${p} must use public cache-control`);
    }

    // Second /api/news request within 3s SWR reuses RAM cache
    const beforeSecond = newsSelects;
    const secondNews = await httpRequest(base + "/api/news");
    assert.equal(secondNews.status, 200);
    assert.equal(newsSelects, beforeSecond, "Expected /api/news within SWR TTL to skip DB");

    // Private routes keep strict no-store + Pragma + Vary: Cookie
    for (const p of ["/api/csrf", "/api/orders", "/api/stock/K9-C"]) {
      const r = await httpRequest(base + p);
      assert.match(String(r.headers["cache-control"] || ""), /no-store/i, `${p} must stay no-store`);
      assert.match(String(r.headers.vary || ""), /\bCookie\b/i, `${p} must retain Vary: Cookie`);
    }
  });

  test("responsiveImages, product-art, and k9-loop separate AVIF <picture> sources from WebP <img> srcset", () => {
    const { parseHTML } = require("linkedom");
    const responsive = require("../src/responsive-images");
    const art = require("../product-art");
    const k9Loop = require("../k9-loop");

    const newsId = "b0000000-0000-4000-8000-000000000011";
    const { window, document } = parseHTML(`<!doctype html><html><head></head><body class="home-page">
      <div id="top"><div class="hero-art"><img src="/assets/products/k9.webp" alt="K9"></div></div>
      <img id="m3d" src="/assets/products/m3-description/1.webp" alt="M3">
      <img id="g1" src="/assets/products/g1-ultra-clean.webp" alt="G1">
      <img id="news-img" src="/api/news-images/${newsId}?v=v1" alt="News">
      <div data-audio-art><img id="audio-art" src="/assets/products/k9.webp" alt="Audio"></div>
      <div id="detail-wrap"><picture><source type="image/avif" srcset="/assets/products/k9.avif"><img id="variant-img" src="/assets/products/k9.webp"></picture></div>
    </body></html>`);
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

    responsive.apply(document);

    const k9Img = document.querySelector("#top .hero-art img");
    assert.equal(k9Img.parentElement.tagName, "PICTURE");
    assert.equal(k9Img.getAttribute("src"), "/assets/products/k9.webp");
    assert.match(k9Img.getAttribute("srcset"), /k9-display-480-[a-f0-9]+\.webp\?format=webp 480w/);
    const k9AvifSource = k9Img.parentElement.querySelector('source[type="image/avif"]');
    assert.ok(k9AvifSource);
    assert.match(k9AvifSource.getAttribute("srcset"), /k9-display-480-[a-f0-9]+\.avif 480w/);
    assert.match(k9AvifSource.getAttribute("srcset"), /\/assets\/products\/k9\.avif 1254w/);

    const m3dSource = document.querySelector("#m3d").parentElement.querySelector('source[type="image/avif"]');
    assert.ok(m3dSource);
    assert.equal(
      m3dSource.getAttribute("srcset"),
      "/assets/products/m3-description/1-w480.avif 480w, /assets/products/m3-description/1-w800.avif 800w, /assets/products/m3-description/1.avif 842w"
    );
    assert.match(document.querySelector("#m3d").getAttribute("srcset"), /\?w=480&format=webp 480w/);

    const g1Source = document.querySelector("#g1").parentElement.querySelector('source[type="image/avif"]');
    assert.equal(g1Source.getAttribute("srcset"), "/assets/products/g1-ultra-clean.avif");

    const newsImg = document.querySelector("#news-img");
    const newsSource = newsImg.parentElement.querySelector('source[type="image/avif"]');
    assert.match(newsSource.getAttribute("srcset"), /\?v=v1&format=avif&w=480 480w/);
    assert.match(newsImg.getAttribute("srcset"), /\?v=v1&format=webp&w=480 480w/);

    assert.notEqual(document.querySelector("#audio-art").parentElement.tagName, "PICTURE");

    // product-art updateImage syncs and removes <source type="image/avif"> cleanly
    const variantImg = document.querySelector("#variant-img");
    art.updateImage(variantImg, "/assets/products/m3-home-cutout.webp");
    assert.match(
      variantImg.parentElement.querySelector('source[type="image/avif"]').getAttribute("srcset"),
      /m3-home-cutout-display-480-[a-f0-9]+\.avif 480w/
    );
    art.updateImage(variantImg, "/media/products/gallery.webp");
    assert.equal(variantImg.parentElement.querySelector('source[type="image/avif"]'), null);
    assert.equal(variantImg.getAttribute("srcset"), null);

    // k9-loop scans inside hero-art > picture > img and replaces the outer <picture>
    const ctrl = k9Loop.createController({ window, document });
    ctrl.scan();
    const k9LoopRoot = document.querySelector("#top .hero-art [data-k9-loop]");
    assert.ok(k9LoopRoot);
    assert.equal(document.querySelector("#top .hero-art picture"), null);
    ctrl.destroy();
  });

  test("explicit AVIF and WebP image URLs omit Vary: Accept while unqualified image URLs retain it", async (t) => {
    const os = require("node:os");
    const sharp = require("sharp");
    const session = require("express-session");
    const { createApp } = require("../src/app");
    const { warmPublicImage, resetRenditionCache } = require("../src/lib/image-renditions");

    const prevDir = process.env.MEDIA_RENDITIONS_DIR;
    const prevDisk = process.env.MEDIA_DISK_RENDITION_CACHE;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gaeru-avif-vary-"));
    process.env.MEDIA_RENDITIONS_DIR = tmpDir;
    process.env.MEDIA_DISK_RENDITION_CACHE = "true";
    resetRenditionCache();
    t.after(() => {
      if (prevDir === undefined) delete process.env.MEDIA_RENDITIONS_DIR;
      else process.env.MEDIA_RENDITIONS_DIR = prevDir;
      if (prevDisk === undefined) delete process.env.MEDIA_DISK_RENDITION_CACHE;
      else process.env.MEDIA_DISK_RENDITION_CACHE = prevDisk;
      resetRenditionCache();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const w = 960, h = 600;
    const rawPixels = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 3;
        rawPixels[idx] = (x * 7 + y * 3) & 255;
        rawPixels[idx + 1] = ((x ^ y) * 5) & 255;
        rawPixels[idx + 2] = (y * 11) & 255;
      }
    }
    const largeWebp = await sharp(rawPixels, { raw: { width: w, height: h, channels: 3 } }).webp({ quality: 88 }).toBuffer();
    const newsId = "b0000000-0000-4000-8000-000000000022";
    const newsRow = { content: largeWebp, mime_type: "image/webp" };
    await warmPublicImage(newsRow);

    const pool = {
      async query(sql) {
        const s = String(sql);
        if (s.includes("INSERT INTO security_rate_limits")) {
          return { rows: [{ hits: 1, expires_at: new Date(Date.now() + 60000).toISOString() }] };
        }
        if (s.includes("FROM news_images")) {
          return { rows: [newsRow] };
        }
        return { rows: [] };
      }
    };
    const app = createApp({
      pool,
      sessionStore: new session.MemoryStore(),
      config: { NODE_ENV: "test", SESSION_SECRET: "avif-vary-test-secret-32chars-min" }
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = "http://127.0.0.1:" + server.address().port;

    const k9Avif = await httpRequest(`${base}/assets/products/k9-display-480-f7433a67675b.avif`, { Accept: "*/*" });
    assert.equal(k9Avif.status, 200);
    assert.equal(k9Avif.headers["content-type"], "image/avif");
    assert.equal(k9Avif.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.doesNotMatch(String(k9Avif.headers.vary || ""), /\bAccept\b/i);

    const k9Webp = await httpRequest(`${base}/assets/products/k9-display-480-f7433a67675b.webp?format=webp`, { Accept: "image/avif,*/*" });
    assert.equal(k9Webp.status, 200);
    assert.equal(k9Webp.headers["content-type"], "image/webp");
    assert.doesNotMatch(String(k9Webp.headers.vary || ""), /\bAccept\b/i);

    const k9QueryAvif = await httpRequest(`${base}/assets/products/k9.webp?format=avif`, { Accept: "*/*" });
    assert.equal(k9QueryAvif.status, 200);
    assert.equal(k9QueryAvif.headers["content-type"], "image/avif");
    assert.doesNotMatch(String(k9QueryAvif.headers.vary || ""), /\bAccept\b/i);

    const k9Unqualified = await httpRequest(`${base}/assets/products/k9.webp`, { Accept: "image/avif,*/*" });
    assert.equal(k9Unqualified.status, 200);
    assert.match(String(k9Unqualified.headers.vary || ""), /\bAccept\b/i);

    const dbAvif = await httpRequest(`${base}/api/news-images/${newsId}?w=480&format=avif`, { Accept: "*/*" });
    assert.equal(dbAvif.status, 200);
    assert.equal(dbAvif.headers["content-type"], "image/avif");
    assert.doesNotMatch(String(dbAvif.headers.vary || ""), /\bAccept\b/i);

    const dbWebp = await httpRequest(`${base}/api/news-images/${newsId}?w=480&format=webp`, { Accept: "image/avif,*/*" });
    assert.equal(dbWebp.status, 200);
    assert.equal(dbWebp.headers["content-type"], "image/webp");
    assert.doesNotMatch(String(dbWebp.headers.vary || ""), /\bAccept\b/i);

    const dbUnqualified = await httpRequest(`${base}/api/news-images/${newsId}?w=480`, { Accept: "image/avif,*/*" });
    assert.equal(dbUnqualified.status, 200);
    assert.match(String(dbUnqualified.headers.vary || ""), /\bAccept\b/i);
  });

  test("audit fixes: ETag on 304, weak ETag, no double enrich with req.sitePage, DCB private guard, Free Cloudflare purge", async (t) => {
    const { cleanRoutes, staticHtml } = require("../src/clean-routes");
    const { EdgePurgeService } = require("../src/lib/edge-purge");

    // 1. ETag on 304 + weak ETag matching + no double enrich with req.sitePage
    flushAllCache();
    const app = express();
    app.use((req, _res, next) => {
      if (req.path === "/cua-hang") {
        req.sitePage = { title: "Cửa hàng SEO", description: "Mô tả SEO tùy chỉnh" };
      }
      next();
    });
    app.use(cleanRoutes("https://gaeru.com"));
    app.use(smartPageCache(60_000));
    app.use(staticHtml);

    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = "http://127.0.0.1:" + server.address().port;

    const first = await httpRequest(`${base}/cua-hang`);
    assert.equal(first.status, 200);
    const html = first.body.toString("utf8");
    const jsonLdCount = (html.match(/application\/ld\+json/g) || []).length;
    assert.equal(jsonLdCount, 2, "req.sitePage must enrich once cleanly without duplicating JSON-LD");
    const etag = first.headers.etag;
    assert.ok(etag);

    await new Promise((r) => setTimeout(r, 40));
    const weakNotModified = await httpRequest(`${base}/cua-hang`, { "If-None-Match": `W/${etag}` });
    assert.equal(weakNotModified.status, 304);
    assert.equal(weakNotModified.headers.etag, etag);

    // 2. DCB must never overwrite private/no-store HTML routes even if ENABLE_DCB=true
    const prevDcb = process.env.ENABLE_DCB;
    process.env.ENABLE_DCB = "true";
    t.after(() => {
      if (prevDcb === undefined) delete process.env.ENABLE_DCB;
      else process.env.ENABLE_DCB = prevDcb;
    });
    const privApp = express();
    privApp.use((_req, res, next) => {
      res.set({ "Cache-Control": "private, no-store, max-age=0" });
      res.vary("Cookie");
      next();
    });
    privApp.use(cleanRoutes("https://gaeru.com"));
    privApp.use(smartPageCache(60_000));
    privApp.use(staticHtml);
    const privSrv = privApp.listen(0, "127.0.0.1");
    await new Promise((r) => privSrv.once("listening", r));
    t.after(() => new Promise((r) => privSrv.close(r)));
    const privBase = "http://127.0.0.1:" + privSrv.address().port;
    const privRes = await httpRequest(`${privBase}/tai-khoan`, {
      "Accept-Encoding": "dcb, br, gzip",
      "Available-Dictionary": require("../src/lib/compression-dictionary").getDictionaryInfo().hashBase64Formatted
    });
    assert.equal(privRes.status, 200);
    assert.match(String(privRes.headers["cache-control"] || ""), /no-store/);
    assert.match(String(privRes.headers.vary || ""), /Cookie/i);
    assert.notEqual(privRes.headers["content-encoding"], "dcb");

    // 3. EdgePurgeService defaults to Cloudflare Free URL file purge instead of Enterprise tags
    const sentBodies = [];
    const purgeSvc = new EdgePurgeService({
      zoneId: "zone-test",
      apiToken: "tok-test",
      fetcher: async (_url, opts) => {
        sentBodies.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
    });
    await purgeSvc.purgeProduct("gaeru-k9");
    assert.ok(Array.isArray(sentBodies[0].files));
    assert.equal(sentBodies[0].tags, undefined);
    assert.ok(sentBodies[0].files.includes("https://gaeru.com/san-pham/gaeru-k9"));
  });

  test("audit fixes: commerce.js, shopping-chat-client, customer profile securityVersion, and AI voucher guards", async () => {
    const commerceSrc = fs.readFileSync(path.join(__dirname, "..", "commerce.js"), "utf8");
    assert.match(commerceSrc, /product\.slug === "gaeru-k9"/);
    assert.match(commerceSrc, /product\.slug === "gaeru-g1-ultra"/);
    assert.match(commerceSrc, /fetchCsrfToken/);
    assert.ok(
      commerceSrc.indexOf("Liên kết cổng thanh toán không hợp lệ") < commerceSrc.indexOf("if (!purchase.direct) writeCart([]);") ||
      commerceSrc.includes("if (!purchase.direct) writeCart([]);\n        location.assign(safePayUrl);") ||
      commerceSrc.includes("if (!purchase.direct) writeCart([]);\r\n        location.assign(safePayUrl);"),
      "commerce.js must validate safePayUrl before clearing local cart"
    );

    const chatSrc = fs.readFileSync(path.join(__dirname, "..", "shopping-chat-client.js"), "utf8");
    assert.match(chatSrc, /rootAbort\?\.abort/);
    assert.match(chatSrc, /sendEpoch!==sessionEpoch/);
    assert.match(chatSrc, /orphanBlobUrls/);

    // Customer profile email/phone clear must keep req.session.securityVersion in sync with account_security.version
    const { createCustomerExperience } = require("../src/customer-experience");
    const fakePool = {
      async connect() {
        return {
          async query(sql) {
            const s = String(sql);
            if (s.includes("SELECT email,phone,phone_invalid_at")) {
              return { rows: [{ email: "old@example.com", phone: "0000000000", phone_invalid_at: new Date(), reg_email_failed_at: null, password_hash: null }] };
            }
            if (s.includes("UPDATE customers")) {
              return { rows: [{ id: "c1", fullName: "Test", email: "old@example.com", phone: "0912345678", emailVerified: true }] };
            }
            if (s.includes("UPDATE account_security")) {
              return { rows: [{ version: 4 }] };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {}
        };
      },
      async query(sql) {
        const s = String(sql);
        if (s.includes("FROM customers WHERE id=$1 AND active=true")) {
          return { rows: [{ id: "c1" }] };
        }
        return { rows: [], rowCount: 0 };
      }
    };
    const app = express();
    app.use(express.json());
    const reqSession = { customer: { id: "c1" }, securityVersion: 3, csrfToken: "tok" };
    app.use((req, _res, next) => { req.session = reqSession; next(); });
    app.use("/api/customer", createCustomerExperience(fakePool));
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    try {
      const port = srv.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/customer/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": "tok" },
        body: JSON.stringify({ fullName: "Test", phone: "0912345678", email: "old@example.com" })
      });
      assert.equal(res.status, 200);
      assert.equal(reqSession.securityVersion, 4);
    } finally {
      await new Promise((r) => srv.close(r));
    }

    // Internal AI delete_voucher and create_voucher guards
    const aiSrc = fs.readFileSync(path.join(__dirname, "..", "src", "internal-ai.js"), "utf8");
    assert.match(aiSrc, /ON CONFLICT \(code\) DO NOTHING/);
    assert.match(aiSrc, /SELECT 1 FROM voucher_redemptions WHERE voucher_id=\$1 LIMIT 1/);
  });
}
