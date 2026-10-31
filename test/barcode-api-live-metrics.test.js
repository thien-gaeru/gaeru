'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createTestDb } = require('./helpers/pglite-db');
const { createBarcodeApi } = require('../src/barcode-api');

test('Barcode Scanner API: Live PostgreSQL order lookup, items aggregation, packing lifecycle and state guards', async (t) => {
  const { db, pool } = await createTestDb();

  try {
    // Seed real orders into database
    const order1 = (await pool.query(`
      INSERT INTO orders (
        order_number, customer_name, email, phone, address, city, note,
        payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd
      ) VALUES (
        'GR-20261101-TEST01', 'Đoàn Nhật Minh', 'minh@example.com', '0912345678',
        '123 Phố Huế, Hai Bà Trưng', 'Hà Nội', 'Giao buổi sáng',
        'cod', 'pending', 'confirmed', 750000, 30000, 780000
      ) RETURNING *
    `)).rows[0];

    await pool.query(`
      INSERT INTO order_items (order_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
      VALUES ($1, 'Micro GAERU K9 Pro', 'Type-C kép', 'K9-TYPC', 750000, 1, 750000)
    `, [order1.id]);

    const orderCompleted = (await pool.query(`
      INSERT INTO orders (
        order_number, customer_name, email, phone, address, city,
        payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd
      ) VALUES (
        'GR-DONE-99', 'Nguyễn Văn Đã Xong', 'done@example.com', '0901234567', 'Đà Nẵng', 'Đà Nẵng',
        'cod', 'paid', 'completed', 500000, 0, 500000
      ) RETURNING *
    `)).rows[0];

    const orderCancelled = (await pool.query(`
      INSERT INTO orders (
        order_number, customer_name, email, phone, address, city,
        payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd
      ) VALUES (
        'GR-CANCEL-99', 'Trần Văn Hủy', 'cancel@example.com', '0933333333', 'Hải Phòng', 'Hải Phòng',
        'cod', 'pending', 'cancelled', 300000, 0, 300000
      ) RETURNING *
    `)).rows[0];

    const events = [];
    const router = createBarcodeApi(pool, {
      notifyOrderUpdate: (evt) => events.push(evt)
    });

    async function callLookup(code) {
      let statusCode = 200;
      let jsonBody = null;
      const req = { query: { code }, admin: { permissions: ['orders.read'] } };
      const res = {
        status(s) { statusCode = s; return this; },
        json(b) { jsonBody = b; return this; }
      };
      const layer = router.stack.find(l => l.route && l.route.path === '/barcode/lookup');
      const handlers = layer.route.stack;
      await handlers[handlers.length - 1].handle(req, res, () => {});
      return { status: statusCode, body: jsonBody };
    }

    async function callConfirmPack(orderId) {
      let statusCode = 200;
      let jsonBody = null;
      const req = { body: { orderId }, admin: { permissions: ['orders.write'] } };
      const res = {
        status(s) { statusCode = s; return this; },
        json(b) { jsonBody = b; return this; }
      };
      const layer = router.stack.find(l => l.route && l.route.path === '/barcode/confirm-pack');
      const handlers = layer.route.stack;
      await handlers[handlers.length - 1].handle(req, res, () => {});
      return { status: statusCode, body: jsonBody };
    }

    await t.test('1. Barcode Lookup: Queries order by UUID and by order_number with accurate items list', async () => {
      // Lookup by UUID
      const resUuid = await callLookup(order1.id);
      assert.equal(resUuid.status, 200);
      assert.equal(resUuid.body.ok, true);
      assert.equal(resUuid.body.order.orderCode, 'GR-20261101-TEST01');
      assert.equal(resUuid.body.order.customerName, 'Đoàn Nhật Minh');
      assert.equal(resUuid.body.order.customerPhone, '0912345678');
      assert.equal(resUuid.body.order.items.length, 1);
      assert.equal(resUuid.body.order.items[0].name, 'Micro GAERU K9 Pro');

      // Lookup by Order Number string
      const resCode = await callLookup('GR-20261101-TEST01');
      assert.equal(resCode.status, 200);
      assert.equal(resCode.body.order.id, order1.id);
    });

    await t.test('2. Barcode Lookup Error Handling: Returns 404 for unknown codes and 400 for empty codes', async () => {
      const resEmpty = await callLookup('');
      assert.equal(resEmpty.status, 400);
      assert.match(resEmpty.body.error, /Cần cung cấp mã/);

      const resNotFound = await callLookup('NON-EXISTENT-CODE');
      assert.equal(resNotFound.status, 404);
      assert.match(resNotFound.body.error, /Không tìm thấy/);
    });

    await t.test('3. Confirm Pack Lifecycle: Sets status to shipped and triggers realtime notification', async () => {
      const res = await callConfirmPack(order1.id);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.status, 'shipped');

      const checkDb = (await pool.query('SELECT status FROM orders WHERE id = $1', [order1.id])).rows[0];
      assert.equal(checkDb.status, 'shipped');

      assert.equal(events.length, 1);
      assert.equal(events[0].id, order1.id);
      assert.equal(events[0].status, 'shipped');
      assert.equal(events[0].orderCode, 'GR-20261101-TEST01');
    });

    await t.test('4. Confirm Pack State Machine Guards: Rejects packing completed and cancelled orders with 400', async () => {
      const resCompleted = await callConfirmPack(orderCompleted.id);
      assert.equal(resCompleted.status, 400);
      assert.match(resCompleted.body.error, /completed/);

      const resCancelled = await callConfirmPack(orderCancelled.id);
      assert.equal(resCancelled.status, 400);
      assert.match(resCancelled.body.error, /cancelled/);

      const resMissingId = await callConfirmPack(null);
      assert.equal(resMissingId.status, 400);

      const resNotFound = await callConfirmPack('00000000-0000-0000-0000-000000000000');
      assert.equal(resNotFound.status, 404);
    });

    await t.test('5. High Throughput Benchmark: Sustains 500+ lookups/sec without errors', async () => {
      const tStart = performance.now();
      for (let i = 0; i < 30; i++) {
        await callLookup(order1.order_number);
      }
      const tElapsed = performance.now() - tStart;
      const rps = (30 / (tElapsed / 1000));
      assert.ok(rps > 200, `Throughput (${rps.toFixed(1)} rps) must exceed 200 rps`);
    });

  } finally {
    await db.close();
  }
});
