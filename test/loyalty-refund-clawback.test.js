'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const { parseHTML } = require('linkedom');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { withTransaction } = require('../src/db');
const {
  earnPoints,
  redeemPoints,
  refundPoints,
  previewEarnClawback,
  getOrCreateLoyalty
} = require('../src/loyalty-api');
const { afterSalesRouter } = require('../src/order-after-sales');

async function setupEnv(t) {
  const db = new PGlite();
  let queue = Promise.resolve();
  async function lock() {
    const before = queue;
    let release;
    queue = new Promise(r => { release = r; });
    await before;
    return release;
  }
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try { return await query(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);

  const cust = (await pool.query(
    `INSERT INTO customers (full_name, email, phone, password_hash, active)
     VALUES ('Clawback Tester', 'clawback@example.invalid', '0900001122', 'hash', true)
     RETURNING id`
  )).rows[0];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.admin = {
      id: randomUUID(),
      username: 'owner_test',
      role: 'owner',
      isOwner: true,
      permissions: ['orders.read', 'orders.write', 'payments.write', 'inventory.approve', 'customers.read', 'customers.write']
    };
    next();
  });
  app.use('/api/gaeru_ceo', afterSalesRouter(pool));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise(r => server.close(r));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/gaeru_ceo`;

  async function createOrder({ totalVnd = 1000000, subtotalVnd = totalVnd, discountVnd = 0, status = 'completed', paymentStatus = 'paid' } = {}) {
    const row = (await pool.query(
      `INSERT INTO orders (
         order_number, customer_id, customer_name, email, phone, address, city,
         payment_method, status, payment_status, subtotal_vnd, discount_vnd, shipping_fee_vnd, total_vnd, delivered_at
       ) VALUES (
         $1, $2, 'Clawback Tester', 'clawback@example.invalid', '0900001122', '123 Test', 'Hà Nội',
         'cod', $3, $4, $5, $6, 0, $7, now()
       ) RETURNING *`,
      ['GR-TEST-' + randomUUID().slice(0, 8), cust.id, status, paymentStatus, subtotalVnd, discountVnd, totalVnd]
    )).rows[0];
    return row;
  }

  async function createReceivedReturnCase(orderId) {
    return (await pool.query(
      `INSERT INTO order_after_sales (order_id, kind, status, reason, return_type, restock_eligible)
       VALUES ($1, 'return', 'received', 'Khách trả hàng kiểm tra hoàn tiền', 'refund', false)
       RETURNING *`,
      [orderId]
    )).rows[0];
  }

  async function api(path, method = 'GET', body = null) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  return { pool, customerId: cust.id, createOrder, createReceivedReturnCase, api };
}

test('Scenario 1: Fully spent earned Xu is deducted from refund cash so customer cannot double-dip', async (t) => {
  const f = await setupEnv(t);
  const order1 = await f.createOrder({ totalVnd: 1000000 });
  const order2 = await f.createOrder({ totalVnd: 490000, subtotalVnd: 500000, discountVnd: 10000 });

  await withTransaction(f.pool, async c => {
    const earned = await earnPoints(c, { customerId: f.customerId, orderId: order1.id, orderTotalVnd: 1000000 });
    assert.equal(earned.earnedPoints, 10000);
    await redeemPoints(c, { customerId: f.customerId, orderId: order2.id, pointsToRedeem: 10000, orderTotalVnd: 500000 });
  });

  const retCase = await f.createReceivedReturnCase(order1.id);

  const list = await f.api('/orders/after-sales?status=received');
  assert.equal(list.status, 200);
  const entry = list.data.cases.find(c => c.id === retCase.id);
  assert.equal(entry.gross_refundable_amount_vnd, 1000000);
  assert.equal(entry.loyalty_clawback_preview_vnd, 10000);
  assert.equal(entry.refundable_amount_vnd, '990000');

  // Attempting to certify full 1,000,000 VND cash refund must fail with 409
  const inflated = await f.api(`/orders/after-sales/${retCase.id}`, 'PATCH', {
    version: retCase.version,
    status: 'resolved',
    resolution: 'Cố gắng hoàn đủ 100% khi chưa trừ Xu đã tiêu',
    manualRefund: { amountVnd: 1000000, method: 'bank_transfer', reference: 'REF-INFLATED', confirmedSent: true }
  });
  assert.equal(inflated.status, 409);
  assert.match(inflated.data.error, /990\.000/);

  // Exact net refund (990,000 VND) succeeds and closes with zero unrecovered debt
  const resolved = await f.api(`/orders/after-sales/${retCase.id}`, 'PATCH', {
    version: retCase.version,
    status: 'resolved',
    resolution: 'Đã hoàn tiền sau khi khấu trừ Xu đã tiêu',
    manualRefund: { amountVnd: 990000, method: 'bank_transfer', reference: 'REF-NET-990', confirmedSent: true }
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.refund_amount_vnd, 990000);
  assert.equal(resolved.data.loyalty_clawback_vnd, 10000);

  const loyalty = await withTransaction(f.pool, c => getOrCreateLoyalty(c, f.customerId));
  assert.equal(loyalty.pointsBalance, 0);
  assert.equal(loyalty.clawbackDebtPoints, 0);
  assert.equal(loyalty.lifetimeEarned, 0);
});

test('Scenario 2: Partially spent earned Xu revokes remaining balance and deducts only the shortfall from cash refund', async (t) => {
  const f = await setupEnv(t);
  const order1 = await f.createOrder({ totalVnd: 1000000 });
  const order2 = await f.createOrder({ totalVnd: 493000, subtotalVnd: 500000, discountVnd: 7000 });

  await withTransaction(f.pool, async c => {
    await earnPoints(c, { customerId: f.customerId, orderId: order1.id, orderTotalVnd: 1000000 });
    await redeemPoints(c, { customerId: f.customerId, orderId: order2.id, pointsToRedeem: 7000, orderTotalVnd: 500000 });
  });

  const retCase = await f.createReceivedReturnCase(order1.id);
  const resolved = await f.api(`/orders/after-sales/${retCase.id}`, 'PATCH', {
    version: retCase.version,
    status: 'resolved',
    resolution: 'Thu hồi 3000 từ số dư và trừ 7000 vào tiền hoàn',
    manualRefund: { amountVnd: 993000, method: 'cash', reference: 'REF-PARTIAL-993', confirmedSent: true }
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.refund_amount_vnd, 993000);
  assert.equal(resolved.data.loyalty_clawback_vnd, 7000);

  const loyalty = await withTransaction(f.pool, c => getOrCreateLoyalty(c, f.customerId));
  assert.equal(loyalty.pointsBalance, 0);
  assert.equal(loyalty.clawbackDebtPoints, 0);
});

test('Scenario 3: Order with both redeemed & earned Xu uses restored Xu before deducting cash refund', async (t) => {
  const f = await setupEnv(t);
  const seedOrder = await f.createOrder({ totalVnd: 5000000 });
  const order1 = await f.createOrder({ totalVnd: 950000, subtotalVnd: 1000000, discountVnd: 50000 });
  const drainOrder = await f.createOrder({ totalVnd: 200000 });

  await withTransaction(f.pool, async c => {
    await earnPoints(c, { customerId: f.customerId, orderId: seedOrder.id, orderTotalVnd: 5000000 }); // +50,000 Xu
    await redeemPoints(c, { customerId: f.customerId, orderId: order1.id, pointsToRedeem: 50000, orderTotalVnd: 1000000 }); // balance 0
    await earnPoints(c, { customerId: f.customerId, orderId: order1.id, orderTotalVnd: 950000 }); // +9,500 Xu
    await redeemPoints(c, { customerId: f.customerId, orderId: drainOrder.id, pointsToRedeem: 9500, orderTotalVnd: 200000 }); // balance back to 0
  });

  const retCase = await f.createReceivedReturnCase(order1.id);
  const list = await f.api('/orders/after-sales?status=received');
  const entry = list.data.cases.find(c => c.id === retCase.id);
  // Restoring 50,000 Xu covers the 9,500 Xu earn clawback cleanly, so full 950,000 cash is refundable!
  assert.equal(entry.loyalty_clawback_preview_vnd, 0);
  assert.equal(entry.refundable_amount_vnd, '950000');

  const resolved = await f.api(`/orders/after-sales/${retCase.id}`, 'PATCH', {
    version: retCase.version,
    status: 'resolved',
    resolution: 'Xu hoàn lại đủ bù trừ Xu đã tích',
    manualRefund: { amountVnd: 950000, method: 'bank_transfer', reference: 'REF-MIXED-950', confirmedSent: true }
  });
  assert.equal(resolved.status, 200);
  const loyalty = await withTransaction(f.pool, c => getOrCreateLoyalty(c, f.customerId));
  assert.equal(loyalty.pointsBalance, 40500);
  assert.equal(loyalty.clawbackDebtPoints, 0);
});

test('Scenario 4: Unrecovered earn fallback records clawback_debt_points and auto-settles on later earn & cancel refunds', async (t) => {
  const f = await setupEnv(t);
  const ord1 = await f.createOrder({ totalVnd: 1000000 });
  const ord2 = await f.createOrder({ totalVnd: 200000 });
  const ord3 = await f.createOrder({ totalVnd: 400000 });
  const ord4 = await f.createOrder({ totalVnd: 500000 });
  const ord5 = await f.createOrder({ totalVnd: 1500000 });

  await withTransaction(f.pool, async c => {
    await earnPoints(c, { customerId: f.customerId, orderId: ord1.id, orderTotalVnd: 1000000 }); // +10,000
    await redeemPoints(c, { customerId: f.customerId, orderId: ord2.id, pointsToRedeem: 10000, orderTotalVnd: 200000 }); // balance 0
    // Purge/direct refund without cash deduction creates 10,000 debt
    const ref = await refundPoints(c, { customerId: f.customerId, orderId: ord1.id, reason: 'Direct purge test' });
    assert.equal(ref.unrecoveredEarn, 10000);
    assert.equal(ref.debtAdded, 10000);
  });

  let state = await withTransaction(f.pool, c => getOrCreateLoyalty(c, f.customerId));
  assert.equal(state.pointsBalance, 0);
  assert.equal(state.clawbackDebtPoints, 10000);

  // Order 3 earns 4,000 -> auto-settles 4,000 of debt -> balance stays 0, debt 6,000
  await withTransaction(f.pool, async c => {
    const e3 = await earnPoints(c, { customerId: f.customerId, orderId: ord3.id, orderTotalVnd: 400000 });
    assert.equal(e3.debtSettled, 4000);
    assert.equal(e3.balanceAfter, 0);
    assert.equal(e3.clawbackDebtAfter, 6000);
  });

  // Cancelling Order 2 restores 10,000 redeemed Xu -> immediately settles remaining 6,000 debt -> net balance 4,000
  await withTransaction(f.pool, async c => {
    await refundPoints(c, { customerId: f.customerId, orderId: ord2.id, reason: 'Cancel ord2' });
  });
  state = await withTransaction(f.pool, c => getOrCreateLoyalty(c, f.customerId));
  assert.equal(state.clawbackDebtPoints, 0);
  assert.equal(state.pointsBalance, 4000);

  // Earning on Order 5 after debt is cleared credits full points cleanly
  await withTransaction(f.pool, async c => {
    const e5 = await earnPoints(c, { customerId: f.customerId, orderId: ord5.id, orderTotalVnd: 1500000 });
    assert.equal(e5.debtSettled, 0);
    assert.equal(e5.balanceAfter, 4000 + e5.earnedPoints);
  });
});

test('Scenario 5: Concurrent balance drain rejects stale full-refund submit until admin reloads net amount', async (t) => {
  const f = await setupEnv(t);
  const order1 = await f.createOrder({ totalVnd: 1000000 });
  const order2 = await f.createOrder({ totalVnd: 500000 });

  await withTransaction(f.pool, c => earnPoints(c, { customerId: f.customerId, orderId: order1.id, orderTotalVnd: 1000000 }));
  const retCase = await f.createReceivedReturnCase(order1.id);

  // Initially pointsBalance=10,000 so full 1,000,000 appears refundable
  const initialList = await f.api('/orders/after-sales?status=received');
  assert.equal(initialList.data.cases[0].refundable_amount_vnd, '1000000');

  // Customer drains 10,000 Xu on Order 2 right before Admin submits
  await withTransaction(f.pool, c => redeemPoints(c, { customerId: f.customerId, orderId: order2.id, pointsToRedeem: 10000, orderTotalVnd: 500000 }));

  const staleSubmit = await f.api(`/orders/after-sales/${retCase.id}`, 'PATCH', {
    version: retCase.version,
    status: 'resolved',
    resolution: 'Chứng từ hoàn đủ khi chưa hay biết khách vừa tiêu Xu',
    manualRefund: { amountVnd: 1000000, method: 'bank_transfer', reference: 'REF-STALE-1000', confirmedSent: true }
  });
  assert.equal(staleSubmit.status, 409);

  // Admin refreshes and submits updated net refund 990,000
  const freshList = await f.api('/orders/after-sales?status=received');
  assert.equal(freshList.data.cases[0].refundable_amount_vnd, '990000');
  const validSubmit = await f.api(`/orders/after-sales/${retCase.id}`, 'PATCH', {
    version: retCase.version,
    status: 'resolved',
    resolution: 'Hoàn theo số tiền thực tế đã khấu trừ Xu vừa tiêu',
    manualRefund: { amountVnd: 990000, method: 'bank_transfer', reference: 'REF-FRESH-990', confirmedSent: true }
  });
  assert.equal(validSubmit.status, 200);
  assert.equal(validSubmit.data.loyalty_clawback_vnd, 10000);
});

test('Scenario 6: Offset to 0 VND resolves via offset_by_loyalty_clawback and records any excess in debt', async (t) => {
  const f = await setupEnv(t);
  const order1 = await f.createOrder({ totalVnd: 150000 });
  const order2 = await f.createOrder({ totalVnd: 1000000 });

  // Inject large earn ratio (e.g. legacy 200,000 points) spent completely on order2
  await withTransaction(f.pool, async c => {
    await earnPoints(c, { customerId: f.customerId, orderId: order1.id, orderTotalVnd: 200000, pointsRatio: 1 }); // 200,000 Xu on 150k cash order
    await redeemPoints(c, { customerId: f.customerId, orderId: order2.id, pointsToRedeem: 200000, orderTotalVnd: 1000000 });
  });

  const retCase = await f.createReceivedReturnCase(order1.id);
  const list = await f.api('/orders/after-sales?status=received');
  assert.equal(list.data.cases[0].refundable_amount_vnd, '0');
  assert.equal(list.data.cases[0].loyalty_clawback_preview_vnd, 150000);

  // Supplying manualRefund when net is 0 must reject cleanly
  const bad = await f.api(`/orders/after-sales/${retCase.id}`, 'PATCH', {
    version: retCase.version,
    status: 'resolved',
    resolution: 'Thử gửi chứng từ hoàn 0đ',
    manualRefund: { amountVnd: 150000, method: 'cash', reference: 'REF-BAD-0', confirmedSent: true }
  });
  assert.equal(bad.status, 409);

  // Resolving without manualRefund succeeds, captures 150,000 cash + 50,000 residual Xu debt
  const ok = await f.api(`/orders/after-sales/${retCase.id}`, 'PATCH', {
    version: retCase.version,
    status: 'resolved',
    resolution: 'Khấu trừ 100% tiền hoàn vào Xu đã tiêu'
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.settlementScope, 'offset_by_loyalty_clawback');
  assert.equal(ok.data.refund_amount_vnd, 0);
  assert.equal(ok.data.loyalty_clawback_vnd, 150000);

  const loyalty = await withTransaction(f.pool, c => getOrCreateLoyalty(c, f.customerId));
  assert.equal(loyalty.clawbackDebtPoints, 50000);
});

test('Scenario 7: Admin after-sales & loyalty UIs render clawback deductions and debt cleanly', async () => {
  const { document, window } = parseHTML('<html><body><input id="order-filter" value="completed"><div id="order-workspace"></div><section id="after-sales-panel" hidden><button data-after-sales-refresh></button><div id="after-sales-list"></div></section></body></html>');
  Object.defineProperty(window.HTMLElement.prototype, 'elements', { configurable: true, get() { return new Proxy({}, { get: (_, name) => this.querySelector('[name="' + String(name) + '"]') }); } });
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true, get() { const o = [...this.querySelectorAll('option')]; return (o.find(x => x.hasAttribute('selected')) || o[0])?.getAttribute('value') || ''; }, set(v) { for (const x of this.querySelectorAll('option')) x.toggleAttribute('selected', x.getAttribute('value') === String(v)); } });
  window.GAERUAdmin = {
    can: () => true,
    showGlobal() {},
    request: async () => ({
      cases: [{
        id: 'clawback-ui-case',
        order_number: 'GR-CLAWBACK-1',
        kind: 'return',
        return_type: 'refund',
        status: 'received',
        version: 1,
        payment_status: 'paid',
        gross_refundable_amount_vnd: 1000000,
        loyalty_clawback_preview_vnd: 10000,
        refundable_amount_vnd: '990000',
        customer_name: 'Tester',
        phone: '0900000000',
        reason: 'Test UI',
        inbound_status: 'delivered_to_warehouse'
      }]
    })
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../admin/after-sales.js'), 'utf8'), { window, document, encodeURIComponent, Intl });
  await window.GAERUAfterSales.open();
  const note = document.querySelector('[data-loyalty-clawback-note]');
  assert.ok(note, 'Must render Xu clawback breakdown note');
  assert.match(note.textContent, /10\.000/);
  assert.match(note.textContent, /990\.000/);
  assert.equal(document.querySelector('[name=refundAmountVnd]').value, '990000');

  // Verify admin.js loyalty summary displays debt badge when clawbackDebtPoints > 0
  const adminSrc = fs.readFileSync(require.resolve('../admin/admin.js'), 'utf8');
  const start = adminSrc.indexOf('function renderCustomerLoyalty(');
  const end = adminSrc.indexOf('\nasync function showCustomerDetail', start);
  const ctx = { can: () => false, escapeHtml: v => String(v), Intl };
  vm.createContext(ctx);
  vm.runInContext(adminSrc.slice(start, end), ctx);
  const html = ctx.renderCustomerLoyalty('c1', { loyalty: { pointsBalance: 0, lifetimeEarned: 100, lifetimeSpent: 100, clawbackDebtPoints: 50, tier: 'bronze' }, ledger: [] });
  assert.match(html, /Nợ thu hồi: 50 Xu/);
});
