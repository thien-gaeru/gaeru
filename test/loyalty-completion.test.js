const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { withTransaction } = require('../src/db');
const { createLoyaltyApi, earnPoints, DEFAULT_POLICY, readPolicy, tierBenefits } = require('../src/loyalty-api');

async function setup(t) {
  const db = new PGlite();
  const query = async (sql, values) => { const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values); return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 }; };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  t.after(() => db.close()); await migrateDatabase(pool);
  const customer = (await pool.query("INSERT INTO customers(full_name,email,phone,password_hash) VALUES('Loyalty Test','loyalty@example.invalid','0900000000','hash') RETURNING id")).rows[0];
  async function order() { return (await pool.query("INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,subtotal_vnd,total_vnd) VALUES($1,'Test','loyalty@example.invalid','0900000000','Test','Hà Nội','cod',1000000,1000000) RETURNING id", [randomUUID()])).rows[0].id; }
  return { pool, customerId: customer.id, order };
}

test('each earning tier uses the advertised policy rate before order points and preserves historical replay', async t => {
  const { pool, customerId, order } = await setup(t);
  for (const [start, tier, expected] of [[0, 'bronze', 10000], [100000, 'silver', 12000], [500000, 'gold', 15000], [2000000, 'platinum', 20000]]) {
    await pool.query("INSERT INTO customer_loyalty(customer_id,points_balance,lifetime_earned,tier) VALUES($1,$2,$2,$3) ON CONFLICT(customer_id) DO UPDATE SET points_balance=$2,lifetime_earned=$2,tier=$3", [customerId, start, tier]);
    const id = await order();
    const result = await withTransaction(pool, c => earnPoints(c, { customerId, orderId: id, orderTotalVnd: 1000000 }));
    assert.equal(result.earnedPoints, expected);
    const policy = { ...DEFAULT_POLICY, version: 1, tiers: DEFAULT_POLICY.tiers.map(row => ({ ...row, earnBasisPoints: 1 })) };
    await pool.query("INSERT INTO store_settings(setting_key,setting_value) VALUES('loyalty_policy',$1) ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1", [JSON.stringify(policy)]);
    assert.equal((await withTransaction(pool, c => earnPoints(c, { customerId, orderId: id, orderTotalVnd: 1000000 }))).earnedPoints, expected);
    await pool.query("DELETE FROM store_settings WHERE setting_key='loyalty_policy'");
  }
  // An order crossing the threshold earns using the tier before that order, not the promoted tier.
  await pool.query("UPDATE customer_loyalty SET points_balance=99000,lifetime_earned=99000,tier='bronze' WHERE customer_id=$1", [customerId]);
  const result = await withTransaction(pool, async c => earnPoints(c, { customerId, orderId: await order(), orderTotalVnd: 1000000 }));
  assert.equal(result.earnedPoints, 10000); assert.equal(result.tier, 'silver');
  assert.equal(tierBenefits(await readPolicy(pool)).gold.earnRate, '1.5%');
});

test('loyalty settings and adjustments enforce permission, optimistic version, CSRF, replay and ledger pagination', async t => {
  const express = require('express');
  const { pool, customerId } = await setup(t);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.admin = { username: 'test-admin', role: 'admin', permissions: req.headers['x-viewer'] ? ['customers.read'] : ['customers.read', 'customers.write', 'settings.write'] }; req.session = { csrfToken: 'loyalty-test-token' }; next(); });
  app.use('/api', createLoyaltyApi(pool).admin);
  app.use((e, _req, res, _next) => res.status(e.status || (e.name === 'ZodError' ? 400 : 500)).json({ error: e.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); t.after(() => new Promise(r => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api';
  const call = (route, data, extra = {}) => fetch(base + route, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'loyalty-test-token', ...extra }, body: data ? JSON.stringify(data) : undefined });
  const policyUrl = base + '/customers/loyalty-policy';
  const updated = { version: 0, tiers: DEFAULT_POLICY.tiers.map(tier => ({ ...tier, earnBasisPoints: tier.id === 'gold' ? 175 : tier.earnBasisPoints })) };
  assert.equal((await fetch(policyUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'loyalty-test-token', 'X-Viewer': 'yes' }, body: JSON.stringify(updated) })).status, 403);
  assert.equal((await fetch(policyUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updated) })).status, 403);
  const put = data => fetch(policyUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'loyalty-test-token' }, body: JSON.stringify(data) });
  assert.equal((await put(updated)).status, 200); assert.equal((await put(updated)).status, 409);
  const bad = { version: 1, tiers: updated.tiers.map(tier => ({ ...tier })) }; bad.tiers[1].minPoints = 0;
  assert.equal((await put(bad)).status, 400);
  assert.equal((await (await call('/customers/loyalty-policy')).json()).tierBenefits.gold.earnRate, '1.75%');
  const key = randomUUID(), route = '/customers/' + customerId + '/loyalty/adjust';
  const payload = { points: 500, reason: 'Confirmed support adjustment', requestKey: key };
  assert.equal((await call(route, payload, { 'X-Viewer': 'yes' })).status, 403);
  assert.equal((await call(route, payload)).status, 200); assert.equal((await call(route, payload)).status, 200);
  assert.equal((await call(route, { ...payload, points: 501 })).status, 409);
  assert.equal((await call(route, { ...payload, requestKey: randomUUID(), points: -501 })).status, 409);
  const balance = (await pool.query('SELECT points_balance FROM customer_loyalty WHERE customer_id=$1', [customerId])).rows[0].points_balance;
  assert.equal(balance, 500);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM customer_loyalty_ledger WHERE customer_id=$1", [customerId])).rows[0].n, 1);
  await pool.query("INSERT INTO customer_loyalty_ledger(customer_id,type,points,balance_after,reason,event_key) SELECT $1,'adjustment',1,500+i,'Fixture entry','fixture:'||i FROM generate_series(1,55) i", [customerId]);
  await pool.query('UPDATE customer_loyalty SET points_balance=555,lifetime_earned=555 WHERE customer_id=$1', [customerId]);
  const ledger = await (await call('/customers/' + customerId + '/loyalty?ledgerPage=2')).json();
  assert.equal(ledger.ledger.length, 6); assert.equal(ledger.pagination.total, 56); assert.equal(ledger.pagination.pageCount, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='loyalty.policy.update'")).rows[0].n, 1);
});

test('customer loyalty rendering provides escaped ledger and only exposes adjust controls to writers', () => {
  const source = fs.readFileSync(require.resolve('../admin/admin.js'), 'utf8');
  const start = source.indexOf('function renderCustomerLoyalty('), end = source.indexOf('\nasync function showCustomerDetail', start);
  let writable = false;
  const context = { can: () => writable, escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const data = { loyalty: { pointsBalance: 50, lifetimeEarned: 50, lifetimeSpent: 0, tier: 'bronze' }, ledger: [{ type: 'adjustment', points: 50, balanceAfter: 50, reason: '<img src=x onerror=alert(1)>', createdAt: '2026-11-03T00:00:00Z' }], pagination: { page: 2, pageCount: 3, total: 120 } };
  let html = context.renderCustomerLoyalty('customer', data);
  assert.doesNotMatch(html, /data-customer-adjust-xu/); assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/); assert.match(html, /Trang 2\/3/);
  writable = true; html = context.renderCustomerLoyalty('customer', data); assert.match(html, /data-customer-adjust-xu/); assert.match(html, /Lịch sử Xu/);
});
