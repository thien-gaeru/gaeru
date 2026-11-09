'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const http = require('http');

const { createServerAdminRouter } = require('../src/server-admin');

test('Server Admin Portal - full authentication & endpoints flow', async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    secret: 'test-secret-at-least-32-chars-long-xxx',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  }));

  const mockConfig = {
    ADMIN_USERNAME: 'admin',
    // Hash for Anhthien1!
    ADMIN_PASSWORD_HASH: '$2b$10$wE9mHlPcfiUaM7.gS94W8OqQk4E93i7GvI6m7s9gQ1tQ7E7r7G9gW'
  };

  // Generate real bcrypt hash for test verification
  const bcrypt = require('bcryptjs');
  mockConfig.ADMIN_PASSWORD_HASH = await bcrypt.hash('Anhthien1!', 10);

  app.use(createServerAdminRouter(mockConfig, null));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let cookie = '';

  // Helper fetch
  async function api(path, options = {}) {
    const headers = options.headers || {};
    if (cookie) headers['cookie'] = cookie;
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
      redirect: 'manual'
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      cookie = setCookie.split(';')[0];
    }
    return res;
  }

  try {
    // 1. /server redirects to /server_admin
    const rRedirect = await api('/server');
    assert.equal(rRedirect.status, 302);
    assert.equal(rRedirect.headers.get('location'), '/server_admin');

    // 2. /server_admin returns 200 HTML
    const rHtml = await api('/server_admin');
    assert.equal(rHtml.status, 200);
    const htmlText = await rHtml.text();
    assert.ok(htmlText.includes('Bảng Điều Khiển Máy Chủ GAERU'));
    assert.ok(htmlText.includes('/server_admin/server-admin.css'));
    assert.ok(htmlText.includes('/server_admin/server-admin.js'));

    // 3. /server_admin/server-admin.css returns 200
    const rCss = await api('/server_admin/server-admin.css');
    assert.equal(rCss.status, 200);
    assert.ok(rCss.headers.get('content-type').includes('text/css'));

    // 4. /server_admin/server-admin.js returns 200
    const rJs = await api('/server_admin/server-admin.js');
    assert.equal(rJs.status, 200);
    assert.ok(rJs.headers.get('content-type').includes('application/javascript'));

    // 5. CSRF Token endpoint
    const rCsrf = await api('/server_admin/api/csrf');
    assert.equal(rCsrf.status, 200);
    const csrfData = await rCsrf.json();
    assert.ok(csrfData.csrfToken, 'Should return csrfToken');
    const csrfToken = csrfData.csrfToken;

    // 6. /server_admin/api/me unauthenticated
    const rMe1 = await api('/server_admin/api/me');
    assert.equal(rMe1.status, 200);
    const me1 = await rMe1.json();
    assert.equal(me1.authenticated, false);

    // 7. /server_admin/api/stats without auth -> 401
    const rStats401 = await api('/server_admin/api/stats');
    assert.equal(rStats401.status, 401);

    // 8. Login fail (wrong password)
    const rLoginFail = await api('/server_admin/api/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken
      },
      body: JSON.stringify({ username: 'admin', password: 'WrongPassword' })
    });
    assert.equal(rLoginFail.status, 401);

    // 9. Login success (Anhthien1!)
    const rLoginSuccess = await api('/server_admin/api/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken
      },
      body: JSON.stringify({ username: 'admin', password: 'Anhthien1!' })
    });
    assert.equal(rLoginSuccess.status, 200);
    const loginData = await rLoginSuccess.json();
    assert.equal(loginData.ok, true);
    assert.equal(loginData.user.username, 'admin');

    // 10. /server_admin/api/me authenticated
    const rMe2 = await api('/server_admin/api/me');
    assert.equal(rMe2.status, 200);
    const me2 = await rMe2.json();
    assert.equal(me2.authenticated, true);
    assert.equal(me2.user.username, 'admin');

    // 11. /server_admin/api/stats with auth -> 200
    const rStats200 = await api('/server_admin/api/stats');
    assert.equal(rStats200.status, 200);
    const stats = await rStats200.json();
    assert.equal(stats.ok, true);
    assert.ok(stats.system, 'stats.system present');
    assert.ok(stats.cpu, 'stats.cpu present');
    assert.ok(stats.memory, 'stats.memory present');
    assert.ok(stats.services, 'stats.services present');

    // 12. /server_admin/api/logs with auth -> 200
    const rLogs = await api('/server_admin/api/logs?source=app&lines=20');
    assert.equal(rLogs.status, 200);
    const logs = await rLogs.json();
    assert.equal(logs.ok, true);
    assert.ok(Array.isArray(logs.lines));

    // 13. Logout
    const rLogout = await api('/server_admin/api/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }
    });
    assert.equal(rLogout.status, 200);

    // 14. /server_admin/api/stats after logout -> 401 again
    const rStatsAfterLogout = await api('/server_admin/api/stats');
    assert.equal(rStatsAfterLogout.status, 401);

    console.log('✅ ALL SERVER ADMIN TESTS PASSED PERFECTLY!');
  } finally {
    server.close();
  }
});
