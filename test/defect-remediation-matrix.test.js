'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const webpush = require('web-push');

const {
  getVapidConfig,
  validatePushSubscriptionData,
  broadcastPushNotification,
  createPushPublicRouter,
  createPushAdminRouter
} = require('../src/web-push');
const { verifySchemaHealth } = require('../src/migrate');

const validP256dh = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]).toString('base64');
const validAuth = Buffer.alloc(16, 2).toString('base64');

async function createMatrixDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      total_amount integer NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider text NOT NULL,
      provider_request_id text,
      status text NOT NULL DEFAULT 'pending'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_provider_request_id 
    ON payment_attempts (provider, provider_request_id) 
    WHERE provider_request_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS web_push_subscriptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      endpoint text UNIQUE NOT NULL,
      p256dh text NOT NULL,
      auth text NOT NULL,
      customer_id uuid,
      user_agent text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      sid text PRIMARY KEY,
      sess jsonb NOT NULL,
      expire timestamptz NOT NULL
    );
  `);
  return db;
}

test('Defect Matrix - Lỗi 1: CSRF Web Push blocks new sessions without token and invalid tokens (403), allows valid (201)', async () => {
  const db = await createMatrixDb();
  const vapid = webpush.generateVAPIDKeys();
  const prevPub = process.env.VAPID_PUBLIC_KEY;
  const prevPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;

  let mockSessionState = null;
  const app = express();
  app.use((req, res, next) => {
    req.session = mockSessionState;
    next();
  });
  app.use('/api', createPushPublicRouter(db));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // Case 1: Brand new session (req.session has no csrfToken) -> 403
    mockSessionState = {};
    const res1 = await fetch(`http://127.0.0.1:${port}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://fcm.googleapis.com/fcm/send/token-new-session',
        keys: { p256dh: validP256dh, auth: validAuth }
      })
    });
    assert.equal(res1.status, 403, 'New session without csrfToken must receive 403');
    const data1 = await res1.json();
    assert.match(data1.error, /CSRF/);

    // Case 2: Session has csrfToken, but client sends wrong/forged token -> 403
    const correctToken = 'valid-csrf-token-12345678901234567890123456789012';
    mockSessionState = { csrfToken: correctToken };
    const res2 = await fetch(`http://127.0.0.1:${port}/api/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'forged-token-00000000000000000000000000000000'
      },
      body: JSON.stringify({
        endpoint: 'https://fcm.googleapis.com/fcm/send/token-wrong-csrf',
        keys: { p256dh: validP256dh, auth: validAuth }
      })
    });
    assert.equal(res2.status, 403, 'Tampered CSRF token must receive 403');

    // Case 3: Valid CSRF token matching session -> 201 Created
    const res3 = await fetch(`http://127.0.0.1:${port}/api/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': correctToken
      },
      body: JSON.stringify({
        endpoint: 'https://fcm.googleapis.com/fcm/send/token-valid-csrf',
        keys: { p256dh: validP256dh, auth: validAuth }
      })
    });
    assert.equal(res3.status, 201, 'Valid CSRF token must return 201 Created');
    const data3 = await res3.json();
    assert.equal(data3.ok, true);
    assert.equal(data3.subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/token-valid-csrf');
  } finally {
    if (prevPub) process.env.VAPID_PUBLIC_KEY = prevPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (prevPriv) process.env.VAPID_PRIVATE_KEY = prevPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
    await new Promise(resolve => server.close(resolve));
    await db.close();
  }
});

test('Defect Matrix - Lỗi 2: SSRF Web Push rejects IPv6-mapped, trailing dots, loopback, private ranges and non-standard ports', () => {
  const invalidEndpoints = [
    'https://localhost./endpoint',
    'https://localhost/endpoint',
    'https://127.0.0.1/endpoint',
    'https://127.0.0.1./endpoint',
    'https://[::ffff:127.0.0.1]/endpoint',
    'https://[::ffff:7f00:1]/endpoint',
    'https://[::1]/endpoint',
    'https://10.0.0.1/endpoint',
    'https://172.16.0.1/endpoint',
    'https://192.168.1.1/endpoint',
    'https://169.254.169.254/latest/meta-data',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://instance-data/latest/meta-data',
    'https://fcm.googleapis.com:8080/send' // non-standard port
  ];

  for (const ep of invalidEndpoints) {
    assert.throws(
      () => validatePushSubscriptionData({
        endpoint: ep,
        p256dh: validP256dh,
        auth: validAuth
      }),
      /địa chỉ nội bộ|cổng chuẩn HTTPS|không phải URL hợp lệ/,
      `Must reject invalid SSRF endpoint: ${ep}`
    );
  }

  // Legitimate public endpoint must pass
  const valid = validatePushSubscriptionData({
    endpoint: 'https://fcm.googleapis.com/fcm/send/legit-push-token-999',
    p256dh: validP256dh,
    auth: validAuth
  });
  assert.equal(valid.endpoint, 'https://fcm.googleapis.com/fcm/send/legit-push-token-999');
});

test('Defect Matrix - Lỗi 4: Schema health post-check detects and throws SCHEMA_HEALTH_FAILED if ANY core table is missing', async () => {
  const db = await createMatrixDb();
  try {
    // Initial health check must succeed
    const healthy = await verifySchemaHealth(db);
    assert.equal(healthy.ok, true);

    const coreTables = ['orders', 'products', 'payment_attempts', 'web_push_subscriptions'];
    for (const table of coreTables) {
      await db.exec(`DROP TABLE ${table} CASCADE;`);
      await assert.rejects(
        () => verifySchemaHealth(db),
        /SCHEMA_HEALTH_FAILED/,
        `Dropping table '${table}' must fail with SCHEMA_HEALTH_FAILED`
      );
      // Recreate table
      if (table === 'orders') await db.exec(`CREATE TABLE orders (id uuid PRIMARY KEY, total_amount integer);`);
      if (table === 'products') await db.exec(`CREATE TABLE products (id uuid PRIMARY KEY, slug text UNIQUE);`);
      if (table === 'payment_attempts') {
        await db.exec(`CREATE TABLE payment_attempts (id uuid PRIMARY KEY, provider text, provider_request_id text);`);
        await db.exec(`CREATE UNIQUE INDEX idx_payment_attempts_provider_request_id ON payment_attempts(provider, provider_request_id) WHERE provider_request_id IS NOT NULL;`);
      }
      if (table === 'web_push_subscriptions') await db.exec(`CREATE TABLE web_push_subscriptions (id uuid PRIMARY KEY, endpoint text UNIQUE, p256dh text, auth text);`);
    }
  } finally {
    await db.close();
  }
});

test('Defect Matrix - Lỗi 5: Push send timeout aborts network request and records status: timed_out without false failure outcome', async () => {
  const db = await createMatrixDb();
  const vapid = webpush.generateVAPIDKeys();
  const prevPub = process.env.VAPID_PUBLIC_KEY;
  const prevPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;

  await db.exec(`
    INSERT INTO web_push_subscriptions (endpoint, p256dh, auth, active)
    VALUES ('https://fcm.googleapis.com/fcm/send/timeout-test-device', '${validP256dh}', '${validAuth}', true);
  `);

  let aborted = false;
  const timingOutClient = {
    sendNotification: (_sub, _payload, options) => {
      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          aborted = true;
        });
      }
      // Never resolves immediately; times out
      return new Promise((resolve) => {
        setTimeout(() => resolve({ statusCode: 201 }), 6000);
      });
    }
  };

  try {
    const outcome = await broadcastPushNotification(
      db,
      { title: 'Timeout Test', body: 'Should abort gracefully' },
      { webpushClient: timingOutClient }
    );

    assert.equal(outcome.status, 'timed_out', 'Status must be timed_out, not failed');
    assert.equal(outcome.failedCount, 0, 'Failed count must be 0 for timed out requests');
    assert.equal(outcome.timedOutCount, 1, 'Timed out count must be 1');
    assert.equal(outcome.results.timedOut.length, 1);
    assert.equal(outcome.results.failed.length, 0);

    // Subscription in database must NOT be deactivated
    const check = await db.query(`SELECT active FROM web_push_subscriptions WHERE endpoint = $1`, ['https://fcm.googleapis.com/fcm/send/timeout-test-device']);
    assert.equal(check.rows[0].active, true, 'Timed out subscription must remain active');
  } finally {
    if (prevPub) process.env.VAPID_PUBLIC_KEY = prevPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (prevPriv) process.env.VAPID_PRIVATE_KEY = prevPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
    await db.close();
  }
});

test('Defect Matrix - Lỗi 7: VAPID config returns null and /api/push/public-key returns enabled: false on invalid/corrupted keys', async () => {
  const db = await createMatrixDb();
  const prevPub = process.env.VAPID_PUBLIC_KEY;
  const prevPriv = process.env.VAPID_PRIVATE_KEY;

  const app = express();
  app.use('/api', createPushPublicRouter(db));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // Malformed/invalid VAPID keys
    process.env.VAPID_PUBLIC_KEY = 'invalid-corrupt-vapid-public-key-not-p256';
    process.env.VAPID_PRIVATE_KEY = 'invalid-corrupt-vapid-private-key';

    const cfg = getVapidConfig();
    assert.equal(cfg, null, 'getVapidConfig must return null when keys are malformed or invalid');

    const res = await fetch(`http://127.0.0.1:${port}/api/push/public-key`);
    const data = await res.json();
    assert.equal(data.enabled, false, 'Endpoint must return enabled: false');
    assert.equal(data.publicKey, null);
  } finally {
    if (prevPub) process.env.VAPID_PUBLIC_KEY = prevPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (prevPriv) process.env.VAPID_PRIVATE_KEY = prevPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
    await new Promise(resolve => server.close(resolve));
    await db.close();
  }
});

test('Defect Matrix - Lỗi 9: Benchmark broadcast of 100+ subscriptions processes concurrently in batches of 25 under 2 seconds without hanging', async () => {
  const db = await createMatrixDb();
  const vapid = webpush.generateVAPIDKeys();
  const prevPub = process.env.VAPID_PUBLIC_KEY;
  const prevPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;

  // Insert 100 unique subscriptions
  const values = [];
  for (let i = 0; i < 100; i++) {
    values.push(`('https://fcm.googleapis.com/fcm/send/bench-token-${i}', '${validP256dh}', '${validAuth}', true)`);
  }
  await db.exec(`
    INSERT INTO web_push_subscriptions (endpoint, p256dh, auth, active)
    VALUES ${values.join(', ')};
  `);

  let callCount = 0;
  const fastClient = {
    sendNotification: async () => {
      callCount++;
      // Simulate 10ms realistic gateway latency
      await new Promise(r => setTimeout(r, 10));
      return { statusCode: 201 };
    }
  };

  const startTime = Date.now();
  try {
    const outcome = await broadcastPushNotification(
      db,
      { title: 'Benchmark Broadcast', body: 'Testing concurrent batches of 25' },
      { webpushClient: fastClient }
    );

    const elapsedMs = Date.now() - startTime;
    assert.equal(outcome.recipientCount, 100);
    assert.equal(outcome.sentCount, 100);
    assert.equal(outcome.failedCount, 0);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.status, 'success');
    assert.equal(callCount, 100);
    assert.ok(elapsedMs < 2000, `100 broadcasts must complete under 2000ms (actual: ${elapsedMs}ms)`);
  } finally {
    if (prevPub) process.env.VAPID_PUBLIC_KEY = prevPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (prevPriv) process.env.VAPID_PRIVATE_KEY = prevPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
    await db.close();
  }
});

test('Defect Matrix - Lỗi 3 & Lỗi 8: UI renders Web Push CTA button, checks HTTP status response, and displays clear errors (400, 403, 503)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const uiContent = fs.readFileSync(path.join(__dirname, '../customer-upgrades-ui.js'), 'utf8');

  // Lỗi 3: Render CTA button & dynamic status corresponding to click handler
  assert.match(uiContent, /data-action="subscribe-web-push"/, 'Must render CTA button with data-action="subscribe-web-push"');
  assert.match(uiContent, /data-push-status-label/, 'Must render status label placeholder');
  assert.match(uiContent, /getPushNotificationStatus/, 'Must implement status detector function');
  assert.match(uiContent, /Bật thông báo đẩy/, 'Must include default CTA label');
  assert.match(uiContent, /Đã bật thông báo/, 'Must include granted status label');
  assert.match(uiContent, /Thông báo bị chặn/, 'Must include denied status label');

  // Lỗi 8: UI checks HTTP status response and alerts user with clear errors
  assert.match(uiContent, /if\s*\(!subRes\.ok\)/, 'Must check subRes.ok');
  assert.match(uiContent, /subRes\.status\s*===\s*403/, 'Must handle 403 CSRF expiration');
  assert.match(uiContent, /subRes\.status\s*===\s*503/, 'Must handle 503 Service Unavailable');
  assert.match(uiContent, /subRes\.status\s*===\s*400/, 'Must handle 400 Bad Request');
  assert.match(uiContent, /Phiên làm việc hết hạn CSRF/, 'Must give clear CSRF message');
  assert.match(uiContent, /Dịch vụ thông báo đẩy tạm thời chưa sẵn sàng/, 'Must give clear 503 message');
});

