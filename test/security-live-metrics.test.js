'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const {
  getCsrfToken,
  requireCsrf,
  requireAdmin,
  setCsrfToken
} = require('../src/security');

test('Security Subsystem: CSRF 256-bit entropy, timingSafeEqual comparison, Unicode resilience, requireAdmin, and setCsrfToken', async (t) => {
  function makeMockRes() {
    return {
      statusCode: 200,
      body: null,
      locals: {},
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
  }

  await t.test('1. getCsrfToken generates 256-bit cryptographic hex and is idempotent per session', () => {
    const req = { session: {} };
    const token1 = getCsrfToken(req);

    assert.equal(typeof token1, 'string');
    assert.equal(token1.length, 64);
    assert.match(token1, /^[0-9a-f]{64}$/);

    const token2 = getCsrfToken(req);
    assert.equal(token1, token2);
    assert.equal(req.session.csrfToken, token1);
  });

  await t.test('2. requireCsrf enforces constant-time matching and rejects missing, invalid, or forged tokens', () => {
    const valid = 'f'.repeat(64);

    // 2A. Matching token
    let passed = false;
    requireCsrf({ session: { csrfToken: valid }, get: () => valid }, makeMockRes(), () => { passed = true; });
    assert.equal(passed, true);

    // 2B. Missing session token
    const resNoSess = makeMockRes();
    requireCsrf({ session: {}, get: () => valid }, resNoSess, () => assert.fail('Must not call next'));
    assert.equal(resNoSess.statusCode, 403);

    // 2C. Missing header token
    const resNoHdr = makeMockRes();
    requireCsrf({ session: { csrfToken: valid }, get: () => undefined }, resNoHdr, () => assert.fail('Must not call next'));
    assert.equal(resNoHdr.statusCode, 403);

    // 2D. Same length, wrong characters
    const resMismatch = makeMockRes();
    const wrong = 'f'.repeat(63) + 'e';
    requireCsrf({ session: { csrfToken: valid }, get: () => wrong }, resMismatch, () => assert.fail('Must not call next'));
    assert.equal(resMismatch.statusCode, 403);

    // 2E. Different length
    const resShort = makeMockRes();
    requireCsrf({ session: { csrfToken: valid }, get: () => 'f'.repeat(32) }, resShort, () => assert.fail('Must not call next'));
    assert.equal(resShort.statusCode, 403);

    // 2F. Multi-byte Unicode payload
    const resUnicode = makeMockRes();
    assert.doesNotThrow(() => {
      requireCsrf({ session: { csrfToken: valid }, get: () => 'é'.repeat(64) }, resUnicode, () => assert.fail('Must not call next'));
    });
    assert.equal(resUnicode.statusCode, 403);
  });

  await t.test('3. requireAdmin guards admin routes by session state', () => {
    // Unauthenticated
    const resUnauth = makeMockRes();
    requireAdmin({ session: {} }, resUnauth, () => assert.fail('Must not call next'));
    assert.equal(resUnauth.statusCode, 401);
    assert.match(resUnauth.body.error, /Vui lòng đăng nhập/);

    // Authenticated
    let adminPassed = false;
    requireAdmin({ session: { admin: { id: 'admin_1', username: 'ceo' } } }, makeMockRes(), () => { adminPassed = true; });
    assert.equal(adminPassed, true);
  });

  await t.test('4. setCsrfToken injects session token into res.locals.csrfToken', () => {
    const req = { session: {} };
    const res = makeMockRes();
    let nextCalled = false;

    setCsrfToken(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(typeof res.locals.csrfToken, 'string');
    assert.equal(res.locals.csrfToken.length, 64);
    assert.equal(res.locals.csrfToken, req.session.csrfToken);
  });

  await t.test('5. Live HTTP integration with Express session cookie workflow', async () => {
    const app = express();
    app.use(express.json());
    app.use(session({
      secret: 'test_sec_key_123',
      resave: false,
      saveUninitialized: true
    }));

    app.get('/token', (req, res) => res.json({ token: getCsrfToken(req) }));
    app.post('/transfer', requireCsrf, (req, res) => res.json({ ok: true }));
    app.get('/admin-panel', requireAdmin, (req, res) => res.json({ ok: true }));
    app.post('/login', (req, res) => {
      req.session.admin = { user: 'owner' };
      res.json({ ok: true });
    });

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      // 1. Get token and session cookie
      const getRes = await fetch(`${baseUrl}/token`);
      const cookie = getRes.headers.get('set-cookie');
      const { token } = await getRes.json();

      // 2. Valid POST
      const postOk = await fetch(`${baseUrl}/transfer`, {
        method: 'POST',
        headers: { 'x-csrf-token': token, 'Cookie': cookie }
      });
      assert.equal(postOk.status, 200);

      // 3. Forged POST
      const postBad = await fetch(`${baseUrl}/transfer`, {
        method: 'POST',
        headers: { 'x-csrf-token': 'bad'.repeat(21) + 'b', 'Cookie': cookie }
      });
      assert.equal(postBad.status, 403);

      // 4. Admin unauthorized
      const adminBad = await fetch(`${baseUrl}/admin-panel`, { headers: { 'Cookie': cookie } });
      assert.equal(adminBad.status, 401);

      // 5. Admin login and access
      await fetch(`${baseUrl}/login`, { method: 'POST', headers: { 'Cookie': cookie } });
      const adminOk = await fetch(`${baseUrl}/admin-panel`, { headers: { 'Cookie': cookie } });
      assert.equal(adminOk.status, 200);
    } finally {
      server.close();
    }
  });
});
