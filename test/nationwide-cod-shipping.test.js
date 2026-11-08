'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const flow = require('../checkout-flow');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { createStoreApi } = require('../src/store-api');
const { recordFullOrderPayment, receiptTotal } = require('../src/finance-api');
const express = require('express');

function makePool(db) {
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  return {
    query,
    connect: async () => ({ query, release() {} })
  };
}

test('shippingFee correctly resolves nationwide COD rates with mixed case and diacritics', () => {
  // Case 1: Standard 'Toàn quốc'
  const ratesStandard = { 'Toàn quốc': 0 };
  assert.equal(flow.shippingFee(ratesStandard, 'Hà Nội'), 0);
  assert.equal(flow.shippingFee(ratesStandard, 'Hồ Chí Minh'), 0);
  assert.equal(flow.shippingFee(ratesStandard, 'Đà Nẵng'), 0);
  assert.equal(flow.shippingFee(ratesStandard, 'Cà Mau'), 0);

  // Case 2: Upper-case Q: 'Toàn Quốc' (as saved in live production)
  const ratesUpper = { 'Toàn Quốc': 0 };
  assert.equal(flow.shippingFee(ratesUpper, 'Hà Nội'), 0);
  assert.equal(flow.shippingFee(ratesUpper, 'Hồ Chí Minh'), 0);
  assert.equal(flow.shippingFee(ratesUpper, 'Bình Dương'), 0);

  // Case 3: ALL CAPS: 'TOÀN QUỐC' with fixed fee 30.000 đ
  const ratesAllCaps = { 'TOÀN QUỐC': 30000 };
  assert.equal(flow.shippingFee(ratesAllCaps, 'Cần Thơ'), 30000);
  assert.equal(flow.shippingFee(ratesAllCaps, 'Hải Phòng'), 30000);

  // Case 4: No diacritics: 'toan quoc'
  const ratesNoDiacritics = { 'toan quoc': 25000 };
  assert.equal(flow.shippingFee(ratesNoDiacritics, 'Nghệ An'), 25000);

  // Case 5: Specific province overrides nationwide rate
  const ratesMixed = { 'Hà Nội': 15000, 'Hồ Chí Minh': 20000, 'Toàn quốc': 35000 };
  assert.equal(flow.shippingFee(ratesMixed, 'Hà Nội'), 15000);
  assert.equal(flow.shippingFee(ratesMixed, 'Thành phố Hà Nội'), 15000);
  assert.equal(flow.shippingFee(ratesMixed, 'Hồ Chí Minh'), 20000);
  assert.equal(flow.shippingFee(ratesMixed, 'TP. Hồ Chí Minh'), 20000);
  assert.equal(flow.shippingFee(ratesMixed, 'Đà Nẵng'), 35000); // Falls back to nationwide
  assert.equal(flow.shippingFee(ratesMixed, 'Cần Thơ'), 35000); // Falls back to nationwide

  // Case 6: Invalid inputs
  assert.equal(flow.shippingFee(ratesMixed, ''), undefined);
  assert.equal(flow.shippingFee(ratesMixed, null), undefined);
  assert.equal(flow.shippingFee({}, 'Hà Nội'), undefined);
});

test('store settings API normalizes Toàn Quốc variant to canonical Toàn quốc', async (t) => {
  const db = await PGlite.create();
  const pool = makePool(db);
  t.after(() => db.close());
  await migrateDatabase(pool);

  const actor = { username: 'owner-test', role: 'owner', source: 'bootstrap', permissions: ['settings.read', 'settings.write'] };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { admin: actor, csrfToken: 'test-token' };
    req.admin = actor;
    req.csrfToken = () => 'test-token';
    req.headers['x-csrf-token'] = 'test-token';
    next();
  });
  app.use('/api', createStoreApi(pool, { ordersEnabled: true }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;

  // PUT with 'Toàn Quốc' (capital Q)
  const putRes = await fetch(`http://127.0.0.1:${port}/api/gaeru_ceo/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' },
    body: JSON.stringify({
      shippingNote: 'Miễn phí vận chuyển toàn quốc',
      shippingRates: { 'Toàn Quốc': 0 }
    })
  });

  assert.equal(putRes.status, 200);
  const data = await putRes.json();
  assert.equal(data.settings.shippingRates['Toàn quốc'], 0);
  assert.equal(data.settings.shippingRates['Toàn Quốc'], undefined);

  // Verify database row
  const dbRow = (await pool.query("SELECT setting_value FROM store_settings WHERE setting_key='shipping_rates'")).rows[0];
  assert.deepEqual(dbRow.setting_value, { 'Toàn quốc': 0 });
});

test('recordFullOrderPayment uses 8 distinct placeholders with valid SHA-256 request_hash', async (t) => {
  const db = await PGlite.create();
  const pool = makePool(db);
  t.after(() => db.close());
  await migrateDatabase(pool);

  // Create an order
  const order = (await pool.query(`
    INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, shipping_fee_vnd, total_vnd)
    VALUES ('ORD-TEST-REC', 'Test Buyer', 'test@example.com', '0901', 'Street', 'Hà Nội', 'cod', 'shipped', 'pending', 840000, 0, 840000)
    RETURNING *
  `)).rows[0];

  const client = await pool.connect();
  await recordFullOrderPayment(client, {
    order,
    actor: { username: 'test-admin' },
    options: { reference: 'COD-TEST', note: 'Xác nhận COD' }
  });

  const total = await receiptTotal(client, order.id);
  assert.equal(total, 840000);

  const receipt = (await client.query('SELECT * FROM sales_receipts WHERE order_id = $1', [order.id])).rows[0];
  assert.ok(receipt);
  assert.equal(Number(receipt.amount_vnd), 840000);
  assert.equal(receipt.method, 'cash');
  assert.equal(receipt.created_by, 'test-admin');
  assert.ok(receipt.request_key.startsWith('order-full:'));
  assert.equal(receipt.request_hash.length, 64); // SHA-256 hex digest
});

test('PATCH /api/gaeru_ceo/orders/:id completing COD order records sales_receipt with real finance', async (t) => {
  const db = await PGlite.create();
  const pool = makePool(db);
  t.after(() => db.close());
  await migrateDatabase(pool);

  const actor = {
    username: 'admin-ceo',
    role: 'owner',
    source: 'bootstrap',
    permissions: ['orders.read', 'orders.write', 'payments.read', 'payments.write']
  };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { admin: actor, csrfToken: 'test-token' };
    req.admin = actor;
    req.csrfToken = () => 'test-token';
    req.headers['x-csrf-token'] = 'test-token';
    next();
  });
  app.use('/api', createStoreApi(pool, {
    ordersEnabled: true,
    finance: { receiptTotal, recordFullOrderPayment }
  }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;

  // Insert a shipped COD order
  const order = (await pool.query(`
    INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, shipping_fee_vnd, total_vnd)
    VALUES ('ORD-COD-COMPLETE', 'Buyer COD', 'buyer@test.vn', '0988', '123 Phố', 'Hà Nội', 'cod', 'shipped', 'pending', 840000, 0, 840000)
    RETURNING *
  `)).rows[0];

  // Confirm physical delivery first, then record COD cash collection independently.
  const confirm = await fetch(`http://127.0.0.1:${port}/api/gaeru_ceo/orders/${order.id}/confirm-delivery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' },
    body: JSON.stringify({ evidenceNote:'Buyer signed for local COD delivery in person' })
  });
  assert.equal(confirm.status,200);
  const res = await fetch(`http://127.0.0.1:${port}/api/gaeru_ceo/orders/${order.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' },
    body: JSON.stringify({paymentStatus: 'paid'})
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.order.status, 'completed');
  assert.equal(data.order.paymentStatus, 'paid');

  // Verify the sales_receipt was written by real finance module
  const client = await pool.connect();
  const collected = await receiptTotal(client, order.id);
  assert.equal(collected, 840000);
});
