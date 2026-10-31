const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { createStoreApi } = require('../src/store-api');

test('Checkout SQL SAVEPOINT Protection: Legacy missing checkout_payload_hash falls back cleanly via SAVEPOINT', async (t) => {
  const db = await PGlite.create();
  t.after(() => db.close());

  // Connect helper supporting real transactions
  const pool = {
    async query(sql, values) {
      const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
      return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
    },
    async connect() {
      return {
        query: (sql, values) => pool.query(sql, values),
        release() {}
      };
    }
  };

  await migrateDatabase(pool);

  // Simulate legacy schema by dropping column checkout_payload_hash if exists
  try {
    await pool.query('ALTER TABLE orders DROP COLUMN IF EXISTS checkout_payload_hash');
  } catch {}

  const product = (await pool.query("INSERT INTO products(slug,name,category,active) VALUES('sp-test-mic','Test Mic','audio',true) RETURNING id")).rows[0];
  const variant = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'SP-TEST','Test Variant',200000,10,true) RETURNING id",[product.id])).rows[0];
  await pool.query("INSERT INTO store_settings(setting_key,setting_value) VALUES('shipping_rates',$1) ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1",[JSON.stringify({'Toàn quốc':30000})]);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { csrfToken: 'test-token' };
    next();
  });
  app.use('/api', createStoreApi(pool, { ordersEnabled: true, checkoutAccounts: false }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));

  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' },
    body: JSON.stringify({
      customer: {
        name: 'Nguyen Van A',
        email: 'nguyenvana@example.com',
        phone: '0912345678',
        address: '123 Pho Hue',
        city: 'Hà Nội'
      },
      paymentMethod: 'cod',
      items: [{ variantId: variant.id, quantity: 2 }]
    })
  });

  assert.equal(response.status, 201, `Expected 201 Created but got ${response.status}: ${await response.clone().text()}`);
  const data = await response.json();
  assert.ok(data.order, 'Order must be returned');
  assert.equal(data.order.totalVnd, 430000); // 200000*2 + 30000

  // Verify variant inventory was decremented correctly
  const updatedVariant = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0];
  assert.equal(updatedVariant.stock_quantity, 8);
});

test('Checkout SQL Error Handling: Unrecoverable SQL error rolls back entire transaction safely without dangling order or inventory loss', async (t) => {
  const db = await PGlite.create();
  t.after(() => db.close());

  const pool = {
    async query(sql, values) {
      const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
      return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
    },
    async connect() {
      return {
        query: (sql, values) => pool.query(sql, values),
        release() {}
      };
    }
  };

  await migrateDatabase(pool);

  // Drop pricing_snapshot column to force an unrecoverable SQL error inside UPDATE orders
  await pool.query('ALTER TABLE orders DROP COLUMN pricing_snapshot');

  const product = (await pool.query("INSERT INTO products(slug,name,category,active) VALUES('sp-fail-mic','Fail Mic','audio',true) RETURNING id")).rows[0];
  const variant = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'SP-FAIL','Fail Variant',150000,5,true) RETURNING id",[product.id])).rows[0];
  await pool.query("INSERT INTO store_settings(setting_key,setting_value) VALUES('shipping_rates',$1) ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1",[JSON.stringify({'Toàn quốc':25000})]);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { csrfToken: 'test-token' };
    next();
  });
  app.use('/api', createStoreApi(pool, { ordersEnabled: true, checkoutAccounts: false }));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));

  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' },
    body: JSON.stringify({
      customer: {
        name: 'Le Thi B',
        email: 'lethib@example.com',
        phone: '0987654321',
        address: '456 Tran Phu',
        city: 'Đà Nẵng'
      },
      paymentMethod: 'cod',
      items: [{ variantId: variant.id, quantity: 3 }]
    })
  });

  // Must fail safely with 500
  assert.equal(response.status, 500);

  // Verify ZERO orders exist in orders table
  const orderCount = (await pool.query('SELECT count(*)::int AS count FROM orders')).rows[0].count;
  assert.equal(orderCount, 0, 'No dangling order should be created when transaction fails');

  // Verify ZERO order items exist
  const itemCount = (await pool.query('SELECT count(*)::int AS count FROM order_items')).rows[0].count;
  assert.equal(itemCount, 0, 'No dangling order items should exist');

  // Verify stock quantity was NOT decremented (transaction rollback)
  const variantCheck = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0];
  assert.equal(variantCheck.stock_quantity, 5, 'Stock quantity must remain unchanged after rollback');
});
