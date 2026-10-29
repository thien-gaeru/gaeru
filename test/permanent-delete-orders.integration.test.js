const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const inventory = require('../src/inventory');
const { withTransaction } = require('../src/db');
const { appendAudit } = require('../src/audit');
const { createRetentionAdmin } = require('../src/account-retention');
const { createFinanceApi } = require('../src/finance-api');

async function createTestFixture(t) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const before = queue;
    let release;
    queue = new Promise(r => release = r);
    await before;
    return release;
  }
  async function query(sql, args) {
    const r = !args && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, args);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, args) {
      const release = await lock();
      try { return await query(sql, args); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    }
  };

  await migrateDatabase(pool);

  const actor = {
    username: 'admin-owner',
    role: 'owner',
    source: 'bootstrap',
    permissions: ['orders.read', 'orders.write', 'customers.read', 'customers.write', 'finance.read', 'payments.write']
  };

  const adminPassword = 'AdminSecretPassword123!';
  const adminPasswordHash = await bcrypt.hash(adminPassword, 10);

  const product = (await pool.query(
    "INSERT INTO products(slug,name,category,active) VALUES($1,'Test Deletion Product','audio',true) RETURNING id",
    ['delete-' + randomUUID()]
  )).rows[0];

  const variant = (await pool.query(
    "INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,$2,'Variant 1',150000,20,true) RETURNING id",
    [product.id, 'DEL-' + randomUUID()]
  )).rows[0];

  await withTransaction(pool, c => inventory.initializeVariantStock(c, { variantId: variant.id, quantity: 20, actor }));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { csrfToken: 'fixture-csrf', admin: { username: actor.username } };
    req.admin = { ...actor, permissions: req.headers['x-readonly'] ? ['orders.read', 'customers.read', 'finance.read'] : actor.permissions };
    next();
  });

  const config = { ADMIN_PASSWORD_HASH: adminPasswordHash, PUBLIC_BASE_URL: 'http://localhost:3000' };
  app.use('/api', require('../src/store-api').createStoreApi(pool, { inventory, audit: appendAudit, config }));
  app.use('/api/gaeru_ceo', createRetentionAdmin(pool, config));
  app.use('/api/gaeru_ceo', createFinanceApi(pool));
  app.use((e, _req, res, _next) => res.status(e.status || 500).json({ error: e.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => {
    await new Promise(r => server.close(r));
    await db.close();
  });

  const base = 'http://127.0.0.1:' + server.address().port;

  async function api(path, method = 'GET', body, headers = {}) {
    const r = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'fixture-csrf',
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }

  async function createCustomer({ email, fullName = 'Test Customer', phone = '0901234567' }) {
    const pwdHash = await bcrypt.hash('customerpass123', 10);
    const c = (await pool.query(
      `INSERT INTO customers(full_name, email, phone, password_hash, active, email_verified_at)
       VALUES($1, $2, $3, $4, true, now()) RETURNING *`,
      [fullName, email, phone, pwdHash]
    )).rows[0];
    return c;
  }

  async function createOrder({
    customerId = null,
    email = 'buyer@example.invalid',
    status = 'pending',
    paymentStatus = 'pending',
    amount = 300000,
    quantity = 2
  } = {}) {
    const orderNumber = 'GR-DEL-' + randomUUID().slice(0, 8);
    const o = (await pool.query(
      `INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status)
       VALUES($1, $2, 'Order Buyer', $3, '0912345678', '123 Street', 'Hà Nội', 'cod', $4, $4, $5, $6)
       RETURNING *`,
      [orderNumber, customerId, email, amount, status, paymentStatus]
    )).rows[0];

    const item = (await pool.query(
      `INSERT INTO order_items(order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
       VALUES($1, $2, 'Test Deletion Product', 'Variant 1', 'DEL-SKU', $3, $4, $5)
       RETURNING *`,
      [o.id, variant.id, Math.floor(amount / quantity), quantity, amount]
    )).rows[0];

    // Reserve stock if active
    if (status !== 'cancelled' && status !== 'completed') {
      await withTransaction(pool, c => inventory.reserveStock(c, { variantId: variant.id, quantity, orderId: o.id, actor }));
    }

    // Insert sales receipt if paid
    if (paymentStatus === 'paid') {
      await pool.query(
        `INSERT INTO sales_receipts(order_id, amount_vnd, method, request_key, request_hash, created_by)
         VALUES($1, $2, 'bank_transfer', $3, 'fixture-hash', $4)`,
        [o.id, amount, randomUUID(), actor.username]
      );
    }

    // Insert care request
    if (customerId) {
      await pool.query(
        `INSERT INTO care_requests(customer_id, order_id, request_key, subject, description, channel)
         VALUES($1, $2, $3, 'Support request', 'Order help', 'website')`,
        [customerId, o.id, randomUUID()]
      );
    }

    return { ...o, item };
  }

  const stock = async () => (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0].stock_quantity;

  return { pool, actor, adminPassword, variant, api, createCustomer, createOrder, stock };
}

test('Admin can permanently delete order: cleans all dependent rows, releases stock, and excludes from sales & order history', async t => {
  const f = await createTestFixture(t);

  // Initial stock is 20
  assert.equal(await f.stock(), 20);

  // Create an active paid order
  const order = await f.createOrder({ status: 'confirmed', paymentStatus: 'paid', amount: 300000, quantity: 2 });
  // Stock reserved 2 => stock is 18
  assert.equal(await f.stock(), 18);

  // Check sales figures include this 300,000 VND
  const financeBefore = await f.api('/api/gaeru_ceo/finance/summary');
  assert.equal(financeBefore.status, 200);
  assert.equal(financeBefore.data.summary.salesPaidVnd, 300000);

  // Summary reports 1 order
  const summaryBefore = await f.api('/api/gaeru_ceo/summary');
  assert.equal(summaryBefore.status, 200);
  assert.equal(summaryBefore.data.orders.total, 1);

  // Orders list returns the order
  const ordersListBefore = await f.api('/api/gaeru_ceo/orders');
  assert.equal(ordersListBefore.status, 200);
  assert.equal(ordersListBefore.data.orders.length, 1);
  assert.equal(ordersListBefore.data.orders[0].id, order.id);

  // Unauthorized attempts
  assert.equal((await f.api(`/api/gaeru_ceo/orders/${order.id}/permanent-delete`, 'POST', {}, { 'X-Readonly': '1' })).status, 403);
  assert.equal((await f.api(`/api/gaeru_ceo/orders/${order.id}/permanent-delete`, 'POST', {}, { 'X-CSRF-Token': 'wrong' })).status, 403);

  // Perform permanent deletion
  const deleteRes = await f.api(`/api/gaeru_ceo/orders/${order.id}/permanent-delete`, 'POST');
  assert.equal(deleteRes.status, 200);
  assert.match(deleteRes.data.message, /Đã xóa vĩnh viễn đơn hàng/);

  // Stock is released back to 20
  assert.equal(await f.stock(), 20);

  // Database verification: order and all children are completely gone!
  assert.equal((await f.pool.query('SELECT * FROM orders WHERE id = $1', [order.id])).rows.length, 0);
  assert.equal((await f.pool.query('SELECT * FROM order_items WHERE order_id = $1', [order.id])).rows.length, 0);
  assert.equal((await f.pool.query('SELECT * FROM sales_receipts WHERE order_id = $1', [order.id])).rows.length, 0);
  assert.equal((await f.pool.query('SELECT * FROM warranty_activations WHERE order_item_id = $1', [order.item.id])).rows.length, 0);
  assert.equal((await f.pool.query('SELECT * FROM care_requests WHERE order_id = $1', [order.id])).rows.length, 0);

  // Sales figures immediately exclude the deleted order
  const financeAfter = await f.api('/api/gaeru_ceo/finance/summary');
  assert.equal(financeAfter.status, 200);
  assert.equal(financeAfter.data.summary.salesPaidVnd, 0);

  // Summary reports 0 orders
  const summaryAfter = await f.api('/api/gaeru_ceo/summary');
  assert.equal(summaryAfter.status, 200);
  assert.equal(summaryAfter.data.orders.total, 0);

  // Orders list is empty
  const ordersListAfter = await f.api('/api/gaeru_ceo/orders');
  assert.equal(ordersListAfter.status, 200);
  assert.equal(ordersListAfter.data.orders.length, 0);

  // Deleting again returns 404
  const secondDelete = await f.api(`/api/gaeru_ceo/orders/${order.id}/permanent-delete`, 'POST');
  assert.equal(secondDelete.status, 404);
});

test('Customer permanent deletion automatically purges their order history and excludes orders from sales', async t => {
  const f = await createTestFixture(t);

  // Create customer
  const customer = await f.createCustomer({ email: 'delete.me@example.invalid', fullName: 'Customer To Delete' });

  // Create 2 orders for this customer (one paid, one unpaid)
  const order1 = await f.createOrder({
    customerId: customer.id,
    email: customer.email,
    status: 'completed',
    paymentStatus: 'paid',
    amount: 500000,
    quantity: 2
  });

  const order2 = await f.createOrder({
    customerId: customer.id,
    email: customer.email,
    status: 'pending',
    paymentStatus: 'pending',
    amount: 200000,
    quantity: 1
  });

  // Verify before state
  const financeBefore = await f.api('/api/gaeru_ceo/finance/summary');
  assert.equal(financeBefore.data.summary.salesPaidVnd, 500000);

  const summaryBefore = await f.api('/api/gaeru_ceo/summary');
  assert.equal(summaryBefore.data.orders.total, 2);

  // Customer permanently deleted by admin
  const delCustRes = await f.api(`/api/gaeru_ceo/customers/${customer.id}/permanent-delete`, 'POST', {
    password: f.adminPassword,
    reason: 'Khách hàng xóa vĩnh viễn'
  });
  assert.equal(delCustRes.status, 200);

  // Customer is deleted
  assert.equal((await f.pool.query('SELECT * FROM customers WHERE id = $1', [customer.id])).rows.length, 0);

  // All customer's orders are automatically permanently deleted!
  assert.equal((await f.pool.query('SELECT * FROM orders WHERE id = $1', [order1.id])).rows.length, 0);
  assert.equal((await f.pool.query('SELECT * FROM orders WHERE id = $1', [order2.id])).rows.length, 0);
  assert.equal((await f.pool.query('SELECT * FROM sales_receipts WHERE order_id = $1', [order1.id])).rows.length, 0);

  // Sales figures automatically exclude the deleted customer's orders!
  const financeAfter = await f.api('/api/gaeru_ceo/finance/summary');
  assert.equal(financeAfter.data.summary.salesPaidVnd, 0);

  // Summary reports 0 total orders!
  const summaryAfter = await f.api('/api/gaeru_ceo/summary');
  assert.equal(summaryAfter.data.orders.total, 0);

  // Orders list is completely empty!
  const ordersListAfter = await f.api('/api/gaeru_ceo/orders');
  assert.equal(ordersListAfter.data.orders.length, 0);
});
