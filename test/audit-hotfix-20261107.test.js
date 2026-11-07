const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { createPriorityPoolController } = require('../src/db');
const { createStoreApi } = require('../src/store-api');
const { createFinanceApi, receiptTotal, recordFullOrderPayment } = require('../src/finance-api');
const { createShippingManagement, settleCarrierCodBatch } = require('../src/shipping-management');
const { applyPromotions } = require('../src/product-promotions');
const express = require('express');

async function createTestPool() {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  const rawExec = async (sql, values) => {
    const res = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...res, rows: res?.rows || [], rowCount: res?.affectedRows ?? res?.rows?.length ?? 0 };
  };
  async function lock() {
    const prev = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await prev;
    return release;
  }
  const pool = {
    async query(sql, values, cb) {
      if (typeof values === 'function') {
        cb = values;
        values = undefined;
      }
      if (typeof cb === 'function') {
        lock().then(release => {
          rawExec(sql, values)
            .then(res => { release(); cb(null, res); })
            .catch(err => { release(); cb(err); });
        });
        return;
      }
      const release = await lock();
      try {
        return await rawExec(sql, values);
      } finally {
        release();
      }
    },
    async connect(cb) {
      if (typeof cb === 'function') {
        lock().then(release => {
          cb(null, { query: rawExec, release }, () => release());
        });
        return;
      }
      const release = await lock();
      return { query: rawExec, release };
    },
    end: () => db.close()
  };
  await migrateDatabase(pool, { lockTimeoutMs: 10000 });
  return { pool, db };
}

test('FX01 & P0-01: Priority pool controller provides getStats() and handles callback-style queries with semaphore bounds', async () => {
  const { pool } = await createTestPool();
  const controller = createPriorityPoolController(pool, { maxLowPriorityOps: 2 });
  assert.equal(typeof controller.getStats, 'function');
  const initial = controller.getStats();
  assert.equal(initial.activeHighOps, 0);
  assert.equal(initial.activeLowOps, 0);
  assert.equal(initial.queuedLowOps, 0);
  assert.equal(initial.maxLowPriorityOps, 2);

  // Test that resource monitor telemetry formatting never throws ReferenceError
  const stats = controller.getStats();
  const telemetry = JSON.stringify({
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    dbPoolTotal: Number(pool?.totalCount || 0),
    bgWorkerHighActive: stats.activeHighOps ?? 0,
    bgWorkerLowActive: stats.activeLowOps ?? 0,
    bgWorkerLowQueued: stats.queuedLowOps ?? 0
  });
  assert.ok(telemetry.includes('"bgWorkerHighActive":0'));
  assert.ok(telemetry.includes('"bgWorkerLowActive":0'));

  // Test callback-style query
  await new Promise((resolve, reject) => {
    controller.lowPriorityPool.query('SELECT 1 AS num', (err, res) => {
      if (err) return reject(err);
      assert.equal(res.rows[0].num, 1);
      resolve();
    });
  });

  const after = controller.getStats();
  assert.equal(after.activeLowOps, 0, 'Callback slot must be released after completion');
});

test('FX03 & P1-01: POST /finance/customer-payments creates cod_settlement_batches and allocations for carrier COD', async () => {
  const { pool } = await createTestPool();
  const order = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
     VALUES ('GR-FX03', 'Khách FX03', 'fx03@example.invalid', '0912345678', '123 Phố', 'Hà Nội', 'cod', 'pending', 'shipped', 300000, 0, 300000)
     RETURNING *`
  )).rows[0];

  const ship = (await pool.query(
    `INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status)
     VALUES ($1, 'viettel', '156668075673', 'delivered', 300000, 'unsettled')
     RETURNING *`,
    [order.id]
  )).rows[0];

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.admin = { username: 'test-accountant', role: 'accountant', permissions: ['finance.read', 'finance.write', 'payments.write'] };
    req.session = { admin: req.admin, csrfToken: 'tok123' };
    next();
  });
  app.use('/api', createFinanceApi(pool));

  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/finance/customer-payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'tok123'
      },
      body: JSON.stringify({
        orderId: order.id,
        amountVnd: 300000,
        method: 'bank_transfer',
        reference: 'VTP-STMT-20261107',
        note: 'Đối soát sao kê ngân hàng',
        requestKey: 'req-fx03-key-12345'
      })
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);

    // Verify allocations table has the entry
    const alloc = (await pool.query('SELECT * FROM cod_settlement_allocations WHERE order_id = $1', [order.id])).rows[0];
    assert.ok(alloc, 'Must insert into cod_settlement_allocations');
    assert.equal(Number(alloc.allocated_amount_vnd), 300000);
    assert.equal(alloc.created_by, 'test-accountant');

    // Verify batch was created and updated
    const batch = (await pool.query('SELECT * FROM cod_settlement_batches WHERE id = $1', [alloc.batch_id])).rows[0];
    assert.ok(batch, 'Must create cod_settlement_batches');
    assert.equal(batch.carrier_id, 'viettel');
    assert.equal(batch.provider_transaction_ref, 'VTP-STMT-20261107');
    assert.equal(Number(batch.allocated_total_vnd), 300000);

    // Verify shipment is marked settled
    const updatedShip = (await pool.query('SELECT * FROM carrier_shipments WHERE id = $1', [ship.id])).rows[0];
    assert.equal(updatedShip.cod_settlement_status, 'settled');
    assert.equal(updatedShip.cod_settlement_ref, 'VTP-STMT-20261107');
  } finally {
    server.close();
  }
});

test('FX05 & P1-02: Flash sale promotion is properly applied in shipping quote and pricing computation', async () => {
  const { pool } = await createTestPool();
  const prod = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('tai-nghe-k9', 'Tai nghe K9', 'audio', true) RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'K9-TEST', 'Bản Chuẩn', 400000, 50, true) RETURNING id, sku, name, price_vnd`,
    [prod.id]
  )).rows[0];

  // Insert Flash sale discount 20%
  const promo = (await pool.query(
    `INSERT INTO product_promotions (title, type, kind, amount, starts_at, ends_at, active)
     VALUES ('Flash Sale 20%', 'flash', 'percent', 20, now() - interval '1 hour', now() + interval '2 hours', true)
     RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO product_promotion_variants (promotion_id, variant_id) VALUES ($1, $2)`,
    [promo.id, variant.id]
  );

  // Test applyPromotions with both price_vnd and priceVnd format
  const rows1 = [{ id: variant.id, sku: variant.sku, price_vnd: 400000 }];
  const promoted1 = await applyPromotions(pool, rows1);
  assert.equal(promoted1[0].priceVnd, 320000, '400k - 20% must be 320k');
  assert.equal(promoted1[0].price_vnd, 320000, 'price_vnd must also reflect 320k');

  const rows2 = [{ id: variant.id, sku: variant.sku, priceVnd: 400000 }];
  const promoted2 = await applyPromotions(pool, rows2);
  assert.equal(promoted2[0].priceVnd, 320000);
});

test('FX08 & P1-06: Pre-acquiring advisory lock in settleSingleCarrierCodInTx prevents deadlock between batch and single settlements', async () => {
  const { pool } = await createTestPool();
  const orderA = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
     VALUES ('GR-DEADLOCK-A', 'Khách A', 'a@example.invalid', '0912000001', 'Đống Đa', 'Hà Nội', 'cod', 'pending', 'shipped', 200000, 0, 200000)
     RETURNING *`
  )).rows[0];
  const orderB = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
     VALUES ('GR-DEADLOCK-B', 'Khách B', 'b@example.invalid', '0912000002', 'Ba Đình', 'Hà Nội', 'cod', 'pending', 'shipped', 200000, 0, 200000)
     RETURNING *`
  )).rows[0];

  await pool.query(
    `INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status)
     VALUES ($1, 'viettel', 'VTP-DL-A', 'delivered', 200000, 'unsettled'),
            ($2, 'viettel', 'VTP-DL-B', 'delivered', 200000, 'unsettled')`,
    [orderA.id, orderB.id]
  );

  // Run batch settlement for both orders
  const batchRes = await settleCarrierCodBatch(pool, {
    carrierId: 'viettel',
    providerTransactionRef: 'VTP-BATCH-CONCURRENCY-1',
    declaredPayoutVnd: 400000,
    evidenceRef: 'STMT-400K-VALID',
    allocations: [
      { orderId: orderA.id, amountVnd: 200000 },
      { orderId: orderB.id, amountVnd: 200000 }
    ],
    actor: { username: 'test-admin', role: 'owner' }
  });

  assert.equal(batchRes.success, true);
  assert.equal(batchRes.allocations.length, 2);
  assert.equal(batchRes.batch.allocatedTotalVnd, 400000);
});
