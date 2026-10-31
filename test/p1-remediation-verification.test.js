const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { PGlite } = require('@electric-sql/pglite');
const { createApp } = require('../src/app');
const publicFiles = require('../src/public-files');
const { precheckAndQuarantineDuplicates } = require('../src/migrate');
const { validatePushSubscriptionData } = require('../src/web-push');

test('P1-01: customer-experience.js compiles without SyntaxError', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'customer-experience.js'), 'utf8');
  assert.doesNotThrow(() => {
    new Function(code);
  });
});

test('P1-02: sw.js is public and served with proper Service Worker headers', async () => {
  assert.ok(publicFiles.has('sw.js'), 'sw.js must be present in public-files set');

  const dummyPool = { query: async () => ({ rows: [] }), on() {} };
  const dummyStore = { on() {} };
  const app = createApp({
    config: { PUBLIC_BASE_URL: 'https://gaeru.com', PORT: 3000, SESSION_SECRET: 'test-secret-at-least-32-chars-long-1234567890' },
    pool: dummyPool,
    sessionStore: dummyStore,
    readinessChecker: async () => true
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/sw.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.equal(res.headers.get('service-worker-allowed'), '/');
    const body = await res.text();
    assert.ok(body.includes('Service Worker'), 'Body contains service worker code');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('P1-03: Health endpoint returns 503 when readiness fails (no false positive 200)', async () => {
  const dummyPool = {
    query: async () => { throw new Error('Database connection failed'); },
    on() {}
  };
  const dummyStore = { on() {} };
  let simulatedReady = false;

  const app = createApp({
    config: { PUBLIC_BASE_URL: 'https://gaeru.com', PORT: 3000, SESSION_SECRET: 'test-secret-at-least-32-chars-long-1234567890' },
    pool: dummyPool,
    sessionStore: dummyStore,
    readinessChecker: async () => {
      if (!simulatedReady) throw new Error('SCHEMA_NOT_READY');
      return true;
    }
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. When readiness fails, /api/health must return 503
    const healthApiRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(healthApiRes.status, 503);
    const healthApiData = await healthApiRes.json();
    assert.equal(healthApiData.error, 'Hệ thống đang khởi động hoặc chưa sẵn sàng kết nối CSDL.');

    // 2. /health must also return 503
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthRes.status, 503);

    // 3. Normal API calls must also return 503
    const otherRes = await fetch(`http://127.0.0.1:${port}/api/customer-auth/me`);
    assert.equal(otherRes.status, 503);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('P1-04: In-flight HTTP requests unblock and receive 503 when startup fails (no infinite hang)', async () => {
  let resolveStartup, rejectStartup;
  const startupPromise = new Promise((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });

  const dummyPool = { query: async () => ({ rows: [] }), on() {} };
  const dummyStore = { on() {} };

  const app = createApp({
    config: { PUBLIC_BASE_URL: 'https://gaeru.com', PORT: 3000, SESSION_SECRET: 'test-secret-at-least-32-chars-long-1234567890' },
    pool: dummyPool,
    sessionStore: dummyStore,
    readinessChecker: async () => startupPromise
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // Fire request while startup is still in progress
    const reqPromise = fetch(`http://127.0.0.1:${port}/api/customer-auth/me`);

    // Simulate startup failure after 50ms
    setTimeout(() => {
      rejectStartup(new Error('MIGRATION_FAILED_SIMULATED'));
    }, 50);

    // Request MUST resolve with 503 within reasonable time (e.g. < 500ms), NOT hang infinitely
    const res = await Promise.race([
      reqPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_HANG')), 2000))
    ]);

    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.error, 'Hệ thống đang khởi động hoặc chưa sẵn sàng kết nối CSDL.');
    assert.match(data.message, /MIGRATION_FAILED_SIMULATED/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('P1-05: precheckAndQuarantineDuplicates prevents duplicate quarantine writes on repeated runs', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE payment_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL DEFAULT gen_random_uuid(),
      provider text NOT NULL,
      provider_request_id text,
      transaction_ref text,
      amount_vnd bigint,
      status text
    );
    -- Insert 2 duplicates with the same (provider, provider_request_id)
    INSERT INTO payment_attempts (provider, provider_request_id, amount_vnd, status)
    VALUES 
      ('momo', 'MM-REQ-DUP-1', 500000, 'pending'),
      ('momo', 'MM-REQ-DUP-1', 500000, 'failed');
  `);

  // First run of precheck
  const run1 = await precheckAndQuarantineDuplicates(db);
  assert.equal(run1.hasDuplicates, true);
  assert.equal(run1.count, 1);

  const count1 = await db.query('SELECT count(*) AS total FROM payment_attempts_quarantine_duplicates');
  assert.equal(Number(count1.rows[0].total), 2);

  // Second run of precheck with same database (MUST NOT insert duplicate quarantine rows)
  const run2 = await precheckAndQuarantineDuplicates(db);
  assert.equal(run2.hasDuplicates, true);

  const count2 = await db.query('SELECT count(*) AS total FROM payment_attempts_quarantine_duplicates');
  assert.equal(Number(count2.rows[0].total), 2, 'Quarantine table must NOT contain duplicate writes for the same attempt_id');

  await db.close();
});

test('P1-06: validatePushSubscriptionData enforces Base64/Base64url character integrity', () => {
  const sampleEp = 'https://fcm.googleapis.com/fcm/send/device-valid-1';
  const sampleKey = Buffer.alloc(65, 5).toString('base64');
  const sampleAuth = Buffer.alloc(16, 8).toString('base64');

  // Valid Base64 & Base64url accepted
  assert.doesNotThrow(() => validatePushSubscriptionData({
    endpoint: sampleEp,
    p256dh: sampleKey.replace(/\+/g, '-').replace(/\//g, '_'),
    auth: sampleAuth.replace(/\+/g, '-').replace(/\//g, '_')
  }));

  // Rejects invalid characters (e.g. non-base64 characters, emojis, script tags)
  assert.throws(() => validatePushSubscriptionData({
    endpoint: sampleEp,
    p256dh: sampleKey + '<script>',
    auth: sampleAuth
  }), /Base64/);

  assert.throws(() => validatePushSubscriptionData({
    endpoint: sampleEp,
    p256dh: sampleKey,
    auth: sampleAuth + ' @invalid'
  }), /Base64/);
});

test('P1-07: Push Admin API provides accurate statistics and guards broadcast against invalid payloads', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE web_push_subscriptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      endpoint text UNIQUE NOT NULL,
      p256dh text NOT NULL,
      auth text NOT NULL,
      active boolean NOT NULL DEFAULT true
    );
    INSERT INTO web_push_subscriptions (endpoint, p256dh, auth, active)
    VALUES 
      ('https://ep1', 'key1', 'auth1', true),
      ('https://ep2', 'key2', 'auth2', true),
      ('https://ep3', 'key3', 'auth3', false);
  `);

  const { createPushAdminRouter } = require('../src/web-push');
  const express = require('express');
  const routerApp = express();
  // Mock staff session with marketing.read & marketing.write permissions
  routerApp.use((req, res, next) => {
    req.admin = { id: 'admin-1', role: 'admin', permissions: ['marketing.read', 'marketing.write'] };
    next();
  });
  routerApp.use('/push', createPushAdminRouter(db));

  const server = http.createServer(routerApp);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. Stats endpoint returns accurate counts
    const statsRes = await fetch(`http://127.0.0.1:${port}/push/push/stats`);
    assert.equal(statsRes.status, 200);
    const stats = await statsRes.json();
    assert.equal(stats.total, 3);
    assert.equal(stats.active, 2);
    assert.equal(stats.inactive, 1);

    // 2. Broadcast guards against empty title/body
    const emptyRes = await fetch(`http://127.0.0.1:${port}/push/push/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ', body: '' })
    });
    assert.equal(emptyRes.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.close();
  }
});
