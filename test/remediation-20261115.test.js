'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const session = require('express-session');
const { PGlite } = require('@electric-sql/pglite');

const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');
const { createStoreApi } = require('../src/store-api');
const { invalidateTags } = require('../cache');

async function createPglitePool() {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  }
  async function execQuery(sql, values) {
    const result = !values && sql.includes(';')
      ? (await db.exec(sql)).at(-1)
      : await db.query(sql, values);
    return {
      ...result,
      rows: result?.rows || [],
      rowCount: result?.affectedRows ?? result?.rows?.length ?? 0,
    };
  }
  return {
    async query(sql, values) {
      const release = await lock();
      try {
        return await execQuery(sql, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await lock();
      return { query: execQuery, release };
    },
    end: () => db.close(),
  };
}

function makeClient(baseUrl) {
  let cookie = '';
  let csrf = '';
  return {
    async request(url, { method = 'GET', body, headers = {} } = {}) {
      const mergedHeaders = {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== 'GET' && method !== 'HEAD' && csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(body && typeof body === 'object' ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      };
      const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers: mergedHeaders,
        body: body && typeof body === 'object' ? JSON.stringify(body) : body,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const ct = res.headers.get('content-type') || '';
      const data = res.status === 204
        ? null
        : ct.includes('application/json')
          ? await res.json()
          : await res.text();
      if (data && typeof data === 'object' && data.csrfToken) {
        csrf = data.csrfToken;
      }
      return { status: res.status, headers: res.headers, data };
    },
    async ok(url, opts) {
      const res = await this.request(url, opts);
      assert.equal(res.status, opts?.expected || 200, `${opts?.method || 'GET'} ${url}: ${JSON.stringify(res.data)}`);
      return res.data;
    },
  };
}

test('global error handler preserves 501, turns ZodError into 400 without schema leaks, serves /favicon.ico, and exposes iCloud-only mail status', async (t) => {
  const pool = await createPglitePool();
  t.after(() => pool.end());
  await migrateDatabase(pool);

  const ownerPass = 'Remediation-Owner-Pass-2026!';
  const app = createApp({
    config: {
      NODE_ENV: 'test',
      PORT: 0,
      PUBLIC_BASE_URL: 'https://gaeru.com',
      SESSION_SECRET: randomBytes(48).toString('hex'),
      ADMIN_USERNAME: 'remediation-owner',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync(ownerPass, 4),
      ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      STORE_ORDERS_ENABLED: true,
    },
    pool,
    sessionStore: new session.MemoryStore(),
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 1. /favicon.ico should not 404
  const fav = await fetch(`${baseUrl}/favicon.ico`);
  assert.equal(fav.status, 200);

  // 2. Public webhooks must return 501 (not 500) for unapproved channels and 400 (not 500) for invalid params
  for (const path501 of ['/api/shipping/jt/webhook', '/api/marketplace/shopee/webhook', '/api/marketplace/tiktok/webhook']) {
    const r = await fetch(`${baseUrl}${path501}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
    });
    assert.equal(r.status, 501, `${path501} expected 501, got ${r.status}`);
  }
  for (const path400 of ['/api/shipping/viettelpost/webhook', '/api/shipping/unknowncarrier/webhook', '/api/marketplace/tiki/webhook']) {
    const r = await fetch(`${baseUrl}${path400}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
    });
    assert.equal(r.status, 400, `${path400} expected 400, got ${r.status}`);
    const body = await r.json();
    assert.doesNotMatch(JSON.stringify(body), /invalid_enum_value|ZodError/i);
  }
  const badRecover = await fetch(`${baseUrl}/api/abandoned-cart/recover/short`);
  assert.equal(badRecover.status, 400);

  // 3. Authenticated admin invalid UUID/query Zod inputs return 400 (never 500)
  const owner = makeClient(baseUrl);
  await owner.ok('/api/csrf');
  await owner.ok('/api/auth/login', {
    method: 'POST',
    body: { username: 'remediation-owner', password: ownerPass },
  });

  for (const badRoute of [
    { url: '/api/gaeru_ceo/customers/not-a-uuid/loyalty', method: 'GET' },
    { url: '/api/gaeru_ceo/marketplace/orders?channel=bad_channel', method: 'GET' },
    { url: '/api/gaeru_ceo/shopping-chat/compression-jobs?state=invalid_state', method: 'GET' },
    { url: '/api/gaeru_ceo/marketing/bundles/not-a-uuid/cancel', method: 'POST', body: {} },
    { url: '/api/gaeru_ceo/marketing/promotions/not-a-uuid/cancel', method: 'POST', body: {} },
  ]) {
    const res = await owner.request(badRoute.url, { method: badRoute.method, body: badRoute.body });
    assert.equal(res.status, 400, `${badRoute.method} ${badRoute.url} expected 400, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert.doesNotMatch(JSON.stringify(res.data), /invalid_enum_value|Lỗi hệ thống/i);
  }

  // 4. Legacy productSchema rejects phishing/untrusted marketplace URLs
  const evilProductRes = await owner.request('/api/gaeru_ceo/products', {
    method: 'POST',
    body: {
      slug: 'evil-link-test',
      name: 'Evil Link Test Product',
      category: 'audio',
      descriptor: 'Test',
      description: 'Test product',
      imageUrl: '/assets/products/gaeru-k9.webp',
      imageAlt: 'Test',
      active: false,
      sortOrder: 1,
      shopeeUrl: 'https://evil-phishing.example/steal',
      tiktokShopUrl: 'https://malicious.example/bait',
    },
  });
  assert.equal(evilProductRes.status, 400);

  // 5. Legacy internal mail-accounts routes are removed (404) & iCloud-only mail status returns 200 without sidecar
  const legacyMailGet = await owner.request('/api/gaeru_ceo/notifications/mail-accounts');
  assert.equal(legacyMailGet.status, 404);
  const legacyMailPost = await owner.request('/api/gaeru_ceo/notifications/mail-accounts', {
    method: 'POST',
    body: { action: 'add', username: 'support', password: 'MailboxPass-2026!', adminPassword: ownerPass },
  });
  assert.equal(legacyMailPost.status, 404);

  const icloudStatus = await owner.ok('/api/gaeru_ceo/notifications/icloud-mail');
  assert.equal(icloudStatus.provider, 'iCloud+ Custom Email Domain');
  assert.equal(icloudStatus.internalMailDisabled, true);
  assert.equal(icloudStatus.webmailUrl, 'https://www.icloud.com/mail');
  assert.equal(icloudStatus.smtp.host, 'smtp.mail.me.com');
  assert.equal(icloudStatus.smtp.configured, false);
});

test('store-shell initRealtimeSSE disconnects unconditionally on pagehide (including bfcache persisted) and reconnects on persisted pageshow', async () => {
  const storeShellCode = fs.readFileSync(path.join(__dirname, '..', 'store-shell.js'), 'utf8');
  const startIdx = storeShellCode.indexOf('// Kênh lắng nghe Realtime SSE');
  assert.ok(startIdx !== -1, 'Expected initRealtimeSSE block in store-shell.js');
  const sseSnippet = storeShellCode.slice(startIdx);

  const listeners = new Map();
  const createdSources = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.closed = false;
      createdSources.push(this);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
  }

  const fakeWindow = {
    EventSource: FakeEventSource,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
  };
  fakeWindow.window = fakeWindow;
  fakeWindow.document = {
    readyState: 'complete',
    addEventListener() {},
  };
  fakeWindow.CustomEvent = class CustomEvent { constructor(t, o) { this.type = t; this.detail = o?.detail; } };

  vm.runInNewContext(sseSnippet, fakeWindow);
  assert.equal(createdSources.length, 1);
  assert.equal(createdSources[0].closed, false);

  // Even when entering bfcache (persisted: true), SSE socket must close immediately!
  for (const fn of listeners.get('pagehide') || []) {
    fn({ persisted: true });
  }
  assert.equal(createdSources[0].closed, true);

  // Returning from bfcache (persisted: true) must reconnect a fresh EventSource
  for (const fn of listeners.get('pageshow') || []) {
    fn({ persisted: true });
  }
  assert.equal(createdSources.length, 2);
  assert.equal(createdSources[1].closed, false);
});

test('store-api config cache invalidates immediately on cacheEvents store-config tag even when TTL > 0', async (t) => {
  let orderEnabledChecks = 0;
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  let storeRouter;
  try {
    storeRouter = createStoreApi(
      { async query() { return { rows: [] }; } },
      {
        config: { NODE_ENV: 'development' },
        getOrdersEnabled: async () => { orderEnabledChecks += 1; return true; },
        getVnpayConfig: async () => null,
        getPaymentChannels: async () => ({ callbackConfigs: {} }),
      }
    );
  } finally {
    process.env.NODE_ENV = prevEnv;
  }

  const app = express();
  app.use('/api', storeRouter);
  app.use('/api', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${baseUrl}/api/probe-config-cache`);
  assert.equal(orderEnabledChecks, 1);
  await fetch(`${baseUrl}/api/probe-config-cache`);
  assert.equal(orderEnabledChecks, 1, 'Expected cached store config within 5s TTL');

  invalidateTags(['store-config'], { immediate: true });
  await fetch(`${baseUrl}/api/probe-config-cache`);
  assert.equal(orderEnabledChecks, 2, 'Expected immediate invalidation after store-config tag');
});

test('site-pages renderPage and clean-routes enrich escape <title> and meta against </title><script> XSS', () => {
  const { renderPage } = require('../src/site-pages');
  const { enrich, setSafeTitle } = require('../src/clean-routes');
  const { parseHTML } = require('linkedom');

  const payloadTitle = 'Chính sách </title><script>alert("xss")</script> & Bảo mật';
  const payloadDesc = '"><script>alert(2)</script> Mô tả';
  const rendered = renderPage({
    path: '/trang/bao-mat',
    title: payloadTitle,
    description: payloadDesc,
    body: 'Nội dung an toàn <script>alert(3)</script>',
    status: 'published',
    version: 1,
    builtin: false,
  });
  assert.ok(!/<script>/i.test(rendered), 'Rendered page HTML must never contain raw <script>');
  assert.match(rendered, /&lt;\/title&gt;&lt;script&gt;/);

  const enriched = enrich(rendered, '/trang/bao-mat', 'https://gaeru.com');
  assert.ok(!/<script>/i.test(enriched), 'Enriched HTML round-trip must never emit raw <script>');
  assert.match(enriched, /&lt;\/title&gt;&lt;script&gt;/);

  const enrichedOverride = enrich(
    '<!doctype html><html lang="vi"><head><title>Gốc</title><meta name="description" content="d"></head><body><main><h1>OK</h1></main></body></html>',
    '/cua-hang',
    'https://gaeru.com',
    { title: payloadTitle, description: payloadDesc }
  );
  assert.ok(!/<script>/i.test(enrichedOverride), 'Enriched builtin override must never emit raw <script>');

  const { document: sampleDoc } = parseHTML('<!doctype html><html><head><title>a</title></head><body></body></html>');
  const plain = setSafeTitle(sampleDoc, payloadTitle);
  assert.equal(plain, payloadTitle);
  assert.ok(!/<script>/i.test(sampleDoc.documentElement.outerHTML));
});

test('createMarketing exposes publicApi with /bundles/quote reachable under /api', async (t) => {
  const { createMarketing } = require('../src/marketing');
  const fakePool = { async query() { return { rows: [] }; } };
  const marketing = createMarketing(fakePool);
  assert.ok(marketing.publicApi, 'Expected marketing.publicApi router');

  const app = express();
  app.use(express.json());
  app.use('/api/customer/marketing', marketing.customer);
  app.use('/api', marketing.publicApi);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Should validate body rather than 404 (400 empty items proves /api/bundles/quote handler is mounted publicly)
  const quoteRes = await fetch(`${baseUrl}/api/bundles/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [] }),
  });
  assert.equal(quoteRes.status, 400);
});

test('admin/admin.js binds pagehide to close adminRealtimeStream cleanly', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const adminCode = fs.readFileSync(path.join(__dirname, '..', 'admin', 'admin.js'), 'utf8');
  assert.match(adminCode, /addEventListener\(\s*['"]pagehide['"]\s*,\s*stopAdminRealtime\s*\)/);
});
