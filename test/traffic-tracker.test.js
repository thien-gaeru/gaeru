const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
const { migrateDatabase } = require('../src/migrate');
const { recordVisit, getTrafficSummary, createTrafficTracker, _testReset } = require('../src/traffic-tracker');

test('traffic-tracker: records pageviews and deduplicates daily unique visitors', async (t) => {
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) {
      const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
      return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
    },
    async connect() {
      return { query: pool.query, release() {} };
    }
  };
  t.after(() => db.close());

  await migrateDatabase(pool);
  _testReset();

  // First visit from visitor A
  await recordVisit(pool, { path: '/', ip: '1.2.3.4', userAgent: 'Mozilla/5.0' });
  let summary = await getTrafficSummary(pool);
  assert.equal(summary.todayPageviews, 1);
  assert.equal(summary.todayVisitors, 1);
  assert.equal(summary.totalPageviews, 1);
  assert.equal(summary.activeNow, 1);

  // Second visit from visitor A (same page or different page)
  await recordVisit(pool, { path: '/product.html', ip: '1.2.3.4', userAgent: 'Mozilla/5.0' });
  summary = await getTrafficSummary(pool);
  assert.equal(summary.todayPageviews, 2, 'Pageviews should increment to 2');
  assert.equal(summary.todayVisitors, 1, 'Visitor count must remain 1 for same visitor');
  assert.equal(summary.totalPageviews, 2);
  assert.equal(summary.activeNow, 1);

  // Third visit from visitor B (different IP)
  await recordVisit(pool, { path: '/care.html', ip: '5.6.7.8', userAgent: 'Safari/605.1' });
  summary = await getTrafficSummary(pool);
  assert.equal(summary.todayPageviews, 3);
  assert.equal(summary.todayVisitors, 2, 'Visitor count should increment to 2 for new visitor');
  assert.equal(summary.totalPageviews, 3);
  assert.equal(summary.activeNow, 2);
});

test('traffic-tracker: middleware ignores bots, APIs, admin, and static assets', async (t) => {
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) {
      const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
      return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
    },
    async connect() {
      return { query: pool.query, release() {} };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);
  _testReset();

  const middleware = createTrafficTracker(pool);

  const ignoredRequests = [
    { method: 'POST', path: '/' },
    { method: 'GET', path: '/api/products' },
    { method: 'GET', path: '/gaeru_ceo/summary' },
    { method: 'GET', path: '/styles.css' },
    { method: 'GET', path: '/bundle.js' },
    { method: 'GET', path: '/assets/logo.webp' },
    { method: 'GET', path: '/', headers: { 'user-agent': 'Googlebot/2.1' } },
    { method: 'GET', path: '/', headers: { 'user-agent': 'Mozilla/5.0 (compatible; bingbot/2.0)' } },
  ];

  for (const req of ignoredRequests) {
    let nextCalled = false;
    const fullReq = {
      method: req.method,
      path: req.path,
      headers: req.headers || { 'user-agent': 'Mozilla/5.0' },
      ip: '9.9.9.9'
    };
    middleware(fullReq, {}, () => { nextCalled = true; });
    assert.ok(nextCalled, 'Middleware must call next()');
  }

  // Wait a small moment for any potential setImmediate
  await new Promise((r) => setTimeout(r, 50));

  const summary = await getTrafficSummary(pool);
  assert.equal(summary.todayPageviews, 0, 'No ignored requests should increment traffic');
});

test('Trang tong quan contains traffic section, metrics and live indicators', () => {
  const html = fs.readFileSync(path.join(__dirname, '../admin/index.html'), 'utf8');
  assert.ok(html.includes('id="overview-traffic-section"'), 'Must have #overview-traffic-section');
  assert.ok(html.includes('id="traffic-today-visits"'), 'Must have #traffic-today-visits in stat-grid');
  assert.ok(html.includes('id="traffic-total-visits"'), 'Must have #traffic-total-visits in stat-grid');
  assert.ok(html.includes('id="metric-today-pageviews"'), 'Must have #metric-today-pageviews');
  assert.ok(html.includes('id="metric-today-visitors"'), 'Must have #metric-today-visitors');
  assert.ok(html.includes('id="metric-total-pageviews"'), 'Must have #metric-total-pageviews');
  assert.ok(html.includes('id="metric-active-count"'), 'Must have #metric-active-count');
  assert.ok(html.includes('id="btn-refresh-traffic"'), 'Must have #btn-refresh-traffic');

  const adminJs = fs.readFileSync(path.join(__dirname, '../admin/admin.js'), 'utf8');
  assert.ok(adminJs.includes('renderTrafficMetrics'), 'Must define renderTrafficMetrics in admin.js');
  assert.ok(adminJs.includes('loadTrafficSummary'), 'Must define loadTrafficSummary in admin.js');
  assert.ok(adminJs.includes('btn-refresh-traffic'), 'Must bind btn-refresh-traffic event listener');

  const css = fs.readFileSync(path.join(__dirname, '../admin/admin-workspace.css'), 'utf8');
  assert.ok(css.includes('.overview-traffic-card'), 'Must style .overview-traffic-card in admin-workspace.css');
  assert.ok(css.includes('.traffic-pulse-dot'), 'Must define .traffic-pulse-dot');
  assert.ok(css.includes('.traffic-live-dot'), 'Must define .traffic-live-dot');
});
