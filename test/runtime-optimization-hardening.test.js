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
