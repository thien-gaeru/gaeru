const { createTestDb } = require('./helpers/pglite-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { randomBytes } = require('crypto');
const { createApp } = require('../src/app');


test('Security Shield WAF & Anti-Hack / Anti-Spam protection', async (t) => {
  const { pool, close: closeDb } = await createTestDb();
  const app = createApp({
    config: {
      NODE_ENV: 'test',
      SESSION_SECRET: randomBytes(32).toString('hex'),
      ADMIN_USERNAME: 'shield-admin',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync('shield-secret-pass', 4),
      PUBLIC_BASE_URL: 'https://example.invalid',
      STORE_ORDERS_ENABLED: true
    },
    pool,
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
  });

  const base = 'http://127.0.0.1:' + server.address().port;

  // 1. Block Malicious Scanner UA
  const scannerRes = await fetch(`${base}/api/products`, {
    headers: { 'User-Agent': 'sqlmap/1.6.12#stable' }
  });
  assert.equal(scannerRes.status, 403, 'Scanner UA should be blocked with 403');
  const scannerBody = await scannerRes.json();
  assert.equal(scannerBody.code, 'WAF_SCANNER_BLOCKED');

  // 2. Block Path Traversal
  const traversalRes = await fetch(`${base}/.env`);
  assert.equal(traversalRes.status, 403, 'Path traversal to .env should be blocked with 403');
  const traversalBody = await traversalRes.json();
  assert.equal(traversalBody.code, 'WAF_PATH_BLOCKED');

  // 3. Block SQL Injection Probe in query
  const sqliRes = await fetch(`${base}/api/products?search=1%20union%20select%201,2,3`);
  assert.equal(sqliRes.status, 403, 'SQLi probe should be blocked with 403');
  const sqliBody = await sqliRes.json();
  assert.equal(sqliBody.code, 'WAF_INJECTION_BLOCKED');

  // 4. Honeypot Anti-Spam Detection
  const spamRes = await fetch(`${base}/api/customer-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'bot@spam.com',
      password: 'password123',
      _website_hp: 'automated_spam_input'
    })
  });
  assert.equal(spamRes.status, 400, 'Honeypot form submission should be caught with 400');
  const spamBody = await spamRes.json();
  assert.equal(spamBody.code, 'SPAM_REJECTED');

  // 5. System Health endpoint for admin
  // Unauthenticated -> 401
  const unauthRes = await fetch(`${base}/api/gaeru_ceo/system-health`);
  assert.equal(unauthRes.status, 401, 'Unauthenticated system health check should return 401');

  // Authenticate as admin
  const csrfRes = await fetch(`${base}/api/csrf`);
  const csrfData = await csrfRes.json();
  const cookie = csrfRes.headers.get('set-cookie')?.split(';')[0];

  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfData.csrfToken,
      Cookie: cookie
    },
    body: JSON.stringify({
      username: 'shield-admin',
      password: 'shield-secret-pass'
    })
  });
  assert.equal(loginRes.status, 200, 'Admin login should succeed');
  const adminCookie = loginRes.headers.get('set-cookie')?.split(';')[0] || cookie;

  // Authenticated health check
  const healthRes = await fetch(`${base}/api/gaeru_ceo/system-health`, {
    headers: { Cookie: adminCookie }
  });
  assert.equal(healthRes.status, 200, 'Authenticated system health should return 200');
  const health = await healthRes.json();
  assert.equal(health.status, 'healthy');
  assert.equal(health.database.status, 'connected');
  assert.ok(typeof health.database.latencyMs === 'number');
  assert.equal(health.security.antiDdos.status, 'active');
  assert.equal(health.security.antiHack.status, 'active');
  assert.ok(health.security.antiHack.threatsBlocked >= 3, 'Recorded blocked threats should be reflected');
  assert.ok(health.server.memoryUsage.heapUsedMb > 0);
});

test('Trang tong quan contains system health UI elements and scripts', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../admin/index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="overview-health-section"'), 'Must have #overview-health-section in admin/index.html');
  assert.ok(indexHtml.includes('id="health-overall-status"'), 'Must have #health-overall-status');
  assert.ok(indexHtml.includes('id="health-db-status"'), 'Must have #health-db-status');
  assert.ok(indexHtml.includes('id="health-ddos-status"'), 'Must have #health-ddos-status');
  assert.ok(indexHtml.includes('id="health-bot-status"'), 'Must have #health-bot-status');
  assert.ok(indexHtml.includes('id="health-waf-status"'), 'Must have #health-waf-status');
  assert.ok(indexHtml.includes('id="btn-refresh-health"'), 'Must have #btn-refresh-health');

  const adminJs = fs.readFileSync(path.join(__dirname, '../admin/admin.js'), 'utf8');
  assert.ok(adminJs.includes('loadSystemHealth'), 'Must define loadSystemHealth in admin/admin.js');
  assert.ok(adminJs.includes('/api/gaeru_ceo/system-health'), 'Must request /api/gaeru_ceo/system-health');
  assert.ok(adminJs.includes('btn-refresh-health'), 'Must bind btn-refresh-health in admin/admin.js');

  const css = fs.readFileSync(path.join(__dirname, '../admin/admin-workspace.css'), 'utf8');
  assert.ok(css.includes('.overview-health-card'), 'Must style .overview-health-card');
});
