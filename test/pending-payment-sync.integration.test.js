const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { PGlite } = require('@electric-sql/pglite');
const { createStoreApi } = require('../src/store-api');
const { migrateDatabase } = require('../src/migrate');

test('admin orders workspace correctly syncs and filters pending-payment orders', async (t) => {
  const db = await PGlite.create();
  const pool = {
    async query(sql, args) {
      const r = !args && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, args);
      return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
    },
    async connect() {
      return { query: pool.query, release() {} };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);

  // Seed orders:
  // 1. Pending payment (COD, active pending) -> SHOULD match pending_payment
  await pool.query(`INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, total_vnd)
    VALUES ('GR-UNPAID-1', 'Buyer Unpaid 1', 'unpaid1@example.invalid', '0900000001', 'Street 1', 'Hà Nội', 'cod', 'pending', 'pending', 100000, 100000)`);

  // 2. Pending payment (Bank transfer, active confirmed) -> SHOULD match pending_payment
  await pool.query(`INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, total_vnd)
    VALUES ('GR-UNPAID-2', 'Buyer Unpaid 2', 'unpaid2@example.invalid', '0900000002', 'Street 2', 'Hà Nội', 'bank_transfer', 'confirmed', 'pending', 200000, 200000)`);

  // 3. Paid order (VNPAY, processing) -> SHOULD NOT match pending_payment
  await pool.query(`INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, total_vnd)
    VALUES ('GR-PAID-1', 'Buyer Paid', 'paid@example.invalid', '0900000003', 'Street 3', 'Hà Nội', 'vnpay', 'processing', 'paid', 300000, 300000)`);

  // 4. Cancelled order with payment_status=pending -> SHOULD NOT match pending_payment (prevent count mismatch)
  await pool.query(`INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, total_vnd)
    VALUES ('GR-CANCELLED-1', 'Buyer Cancelled', 'cancel@example.invalid', '0900000004', 'Street 4', 'Hà Nội', 'cod', 'cancelled', 'pending', 400000, 400000)`);

  // 5. Returned order -> SHOULD NOT match pending_payment
  await pool.query(`INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, total_vnd, return_completed_at)
    VALUES ('GR-RETURNED-1', 'Buyer Returned', 'return@example.invalid', '0900000005', 'Street 5', 'Hà Nội', 'cod', 'completed', 'pending', 500000, 500000, now())`);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { admin: { username: 'manager', permissions: ['orders.read', 'dashboard.read'] }, csrfToken: 'valid-token' };
    req.admin = { username: 'manager', permissions: ['orders.read', 'dashboard.read'] };
    next();
  });
  const router = createStoreApi(pool, { ordersEnabled: true });
  app.use('/api', router);

  const server = app.listen(0);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Check 1: GET /api/gaeru_ceo/summary returns paymentPending = 2
  const summaryRes = await fetch(`${baseUrl}/api/gaeru_ceo/summary`);
  assert.equal(summaryRes.status, 200);
  const summary = await summaryRes.json();
  assert.equal(summary.orders.paymentPending, 2, 'Summary counts only active unpaid orders (excludes cancelled and returned)');

  // Check 2: GET /api/gaeru_ceo/orders?status=payment_pending returns exactly the 2 active unpaid orders
  const pendingOrdersRes = await fetch(`${baseUrl}/api/gaeru_ceo/orders?status=payment_pending`);
  assert.equal(pendingOrdersRes.status, 200);
  const pendingOrders = await pendingOrdersRes.json();
  assert.equal(pendingOrders.pagination.total, 2, 'Pending payment filter returns exactly 2 orders');
  const orderNumbers = pendingOrders.orders.map(o => o.orderNumber);
  assert.deepEqual(new Set(orderNumbers), new Set(['GR-UNPAID-1', 'GR-UNPAID-2']));

  // Check 3: GET /api/gaeru_ceo/orders?paymentStatus=pending also returns 2 (synchronized with summary)
  const paymentFilterRes = await fetch(`${baseUrl}/api/gaeru_ceo/orders?paymentStatus=pending`);
  assert.equal(paymentFilterRes.status, 200);
  const paymentFilterData = await paymentFilterRes.json();
  assert.equal(paymentFilterData.pagination.total, 2, 'Payment status filter excludes cancelled orders when not in cancelled view');

  // Check 4: UI integration - tab and button exist and click handlers work
  const markup = fs.readFileSync(require.resolve('../admin/index.html'), 'utf8');
  const { document, window } = parseHTML(markup);
  const source = fs.readFileSync(require.resolve('../admin/admin.js'), 'utf8');

  // Verify markup has the unpaid filter button and clickable stat card
  assert.ok(document.querySelector('#btn-unpaid-orders'), 'Nút Đơn chờ thanh toán exists in orders filter bar');
  assert.ok(document.querySelector('#card-unpaid-orders'), 'Card Đơn chờ thanh toán exists on overview');
  assert.equal(document.querySelector('#btn-unpaid-orders').dataset.orderTab, 'payment_pending');

  // Check UI state functions
  const state = { orders: [], selectedOrders: new Set(), orderPagination: { page: 1, pageCount: 1, total: 2 }, orderPage: 1 };
  const context = {
    document, window, location: { search: '' }, state,
    can: () => true,
    orderTransitions: {},
    labels: { pending: 'Chờ xác nhận', cod: 'COD' },
    reviewReasonLabels: { domain_missing: 'Email tên miền không tồn tại · Cần gọi xác nhận' },
    formatPrice: n => String(n),
    escapeHtml: s => String(s ?? ''),
    showGlobal() {},
    loadOrders: async () => {},
    request: async () => ({})
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function renderOrderOverview'), source.indexOf("document.querySelector('#export-order-page')")), context);

  context.renderOrderOverview({ pending: 1, confirmed: 1, processing: 0, shipped: 0, completed: 1, cancelled: 1, returned: 1, payment_pending: 2 });
  const tabs = [...document.querySelectorAll('#order-tabs button')];
  assert.equal(tabs.length, 7, 'Tabs include Đơn chờ thanh toán');
  assert.equal(tabs[1].dataset.orderTab, 'payment_pending');
  assert.match(tabs[1].textContent, /Đơn chờ thanh toán/);
  assert.equal(tabs[1].querySelector('span').textContent, '2', 'Tab badge reflects exact unpaid count');
  assert.equal(document.querySelector('#unpaid-orders-count').textContent, '2', 'Button badge reflects exact unpaid count');
});

test('unpaid order in review queue is visible and actionable when filtering by payment_pending and searching', async (t) => {
  const db = await PGlite.create();
  const pool = {
    async query(sql, args) {
      const r = !args && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, args);
      return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
    },
    async connect() {
      return { query: pool.query, release() {} };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);

  // 1 unpaid order with broken email domain
  const order = (await pool.query(`INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, total_vnd)
    VALUES ('GR-REVIEW-1', 'Review Buyer', 'buyer@bad-domain.invalid', '0912345678', 'Street 9', 'Hà Nội', 'cod', 'pending', 'pending', 250000, 250000)
    RETURNING id, order_number, status, payment_status`)).rows[0];

  // Placed in order_reviews
  await pool.query(`INSERT INTO order_reviews (order_id, reason) VALUES ($1, 'domain_missing')`, [order.id]);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { admin: { username: 'manager', permissions: ['orders.read', 'orders.write', 'dashboard.read'] }, csrfToken: 'valid-token' };
    req.admin = { username: 'manager', permissions: ['orders.read', 'orders.write', 'dashboard.read'] };
    next();
  });
  const router = createStoreApi(pool, { checkoutAccounts: true, ordersEnabled: true });
  app.use('/api', router);

  const server = app.listen(0);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 1. Summary reports 1 paymentPending
  const summaryRes = await fetch(`${baseUrl}/api/gaeru_ceo/summary`);
  assert.equal(summaryRes.status, 200);
  const summary = await summaryRes.json();
  assert.equal(summary.orders.paymentPending, 1);

  // 2. Default queue (no params) excludes review order from fulfillment stream
  const defaultRes = await fetch(`${baseUrl}/api/gaeru_ceo/orders`);
  assert.equal(defaultRes.status, 200);
  const defaultData = await defaultRes.json();
  assert.equal(defaultData.orders.length, 0);

  // 3. But when clicking "Đơn chờ thanh toán" (status=payment_pending), the order is returned!
  const unpaidRes = await fetch(`${baseUrl}/api/gaeru_ceo/orders?status=payment_pending`);
  assert.equal(unpaidRes.status, 200);
  const unpaidData = await unpaidRes.json();
  assert.equal(unpaidData.orders.length, 1);
  assert.equal(unpaidData.pagination.total, 1);
  assert.equal(unpaidData.orders[0].id, order.id);
  assert.equal(unpaidData.orders[0].reviewReason, 'domain_missing');

  // 4. Searching by phone finds the order
  const searchRes = await fetch(`${baseUrl}/api/gaeru_ceo/orders?q=0912345678`);
  assert.equal(searchRes.status, 200);
  const searchData = await searchRes.json();
  assert.equal(searchData.orders.length, 1);
  assert.equal(searchData.orders[0].id, order.id);
  assert.equal(searchData.orders[0].reviewReason, 'domain_missing');

  // 5. Test UI status warning pill and review callout
  const markup = fs.readFileSync(require.resolve('../admin/index.html'), 'utf8');
  const { document, window } = parseHTML(markup);
  const source = fs.readFileSync(require.resolve('../admin/admin.js'), 'utf8');

  const state = {
    orders: unpaidData.orders,
    selectedOrders: new Set(),
    orderPagination: unpaidData.pagination,
    orderPage: 1,
    paymentPending: 1
  };
  const context = {
    document, window, state,
    can: () => true,
    orderTransitions: { pending: ['confirmed', 'cancelled'] },
    labels: { pending: 'Chờ xác nhận', cod: 'COD' },
    formatPrice: n => String(n),
    escapeHtml: s => String(s ?? ''),
    showGlobal() {},
    loadOrders: async () => {},
    request: async () => ({}),
    isLiveVnpayAttempt: () => false,
    canEditShipping: () => true,
    orderRestoreReason: () => '',
    orderPaymentControl: () => '',
    updateOrderSelection: () => {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(0, source.indexOf('const state =')), context);
  vm.runInContext(source.slice(source.indexOf('function renderOrders'), source.indexOf('async function updateOrder')), context);
  vm.runInContext(source.slice(source.indexOf('function renderOrderOverview'), source.indexOf("document.querySelector('#export-order-page')")), context);

  // Render orders
  context.renderOrders();
  const root = document.querySelector('#order-list');
  assert.ok(root.innerHTML.includes('Chờ xác minh SĐT'), 'Order card includes warning badge for unreviewed contact');
  assert.ok(root.innerHTML.includes('GR-REVIEW-1'), 'Order number rendered');

  // Render overview tab retains unpaid count
  context.renderOrderOverview({ pending: 0 });
  const unpaidTab = document.querySelector('[data-order-tab="payment_pending"]');
  assert.equal(unpaidTab.querySelector('span').textContent, '1', 'Unpaid tab retains count 1 without resetting to 0');
});
