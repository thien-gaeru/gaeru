const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../src/app');
const publicFiles = require('../src/public-files');

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
