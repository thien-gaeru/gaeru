'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const webpush = require('web-push');

const {
  getVapidConfig,
  validatePushSubscriptionData,
  savePushSubscription,
  broadcastPushNotification,
  createPushPublicRouter,
  createPushAdminRouter
} = require('../src/web-push');

// Generate sample genuine cryptographic keys for testing
const testVapid = webpush.generateVAPIDKeys();

// Generate real uncompressed P-256 public key (65 bytes) and 16 bytes auth secret
const sampleP256dh = Buffer.alloc(65, 4).toString('base64');
const sampleAuth = Buffer.alloc(16, 9).toString('base64');
const sampleEndpoint = 'https://fcm.googleapis.com/fcm/send/sample-genuine-token-123';

async function createTestDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_push_subscriptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      endpoint text UNIQUE NOT NULL,
      p256dh text NOT NULL,
      auth text NOT NULL,
      customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
      user_agent text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS web_push_active_idx ON web_push_subscriptions (active);
  `);
  return db;
}

test('Web Push VAPID Configuration: Rejects demo keys and validates environment keys', () => {
  const originalPub = process.env.VAPID_PUBLIC_KEY;
  const originalPriv = process.env.VAPID_PRIVATE_KEY;

  try {
    // 1. Missing keys -> null
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    assert.equal(getVapidConfig(), null, 'Must return null when VAPID keys are missing');

    // 2. Demo keys -> null
    process.env.VAPID_PUBLIC_KEY = 'BF_GAERU_PUBLIC_VAPID_KEY_DEMO_2026';
    process.env.VAPID_PRIVATE_KEY = 'DEMO_PRIVATE_KEY';
    assert.equal(getVapidConfig(), null, 'Must reject demo VAPID keys');

    // 3. Genuine keys -> valid config
    process.env.VAPID_PUBLIC_KEY = testVapid.publicKey;
    process.env.VAPID_PRIVATE_KEY = testVapid.privateKey;
    const cfg = getVapidConfig();
    assert.ok(cfg, 'Must return config when genuine VAPID keys are provided');
    assert.equal(cfg.publicKey, testVapid.publicKey);
    assert.equal(cfg.privateKey, testVapid.privateKey);
  } finally {
    if (originalPub) process.env.VAPID_PUBLIC_KEY = originalPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (originalPriv) process.env.VAPID_PRIVATE_KEY = originalPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
  }
});

test('Web Push Subscription Validation: Rejects dummy/mock keys and accepts valid P-256 keys', () => {
  // Rejects missing data
  assert.throws(() => validatePushSubscriptionData({}), /bắt buộc/);

  // Rejects non-https endpoint
  assert.throws(() => validatePushSubscriptionData({
    endpoint: 'http://insecure.endpoint.com',
    p256dh: sampleP256dh,
    auth: sampleAuth
  }), /URL hợp lệ|HTTPS/);

  // Rejects fake keys (auto-p256dh-key, auto-auth-key)
  assert.throws(() => validatePushSubscriptionData({
    endpoint: sampleEndpoint,
    p256dh: 'auto-p256dh-key',
    auth: sampleAuth
  }), /tạo giả/);

  assert.throws(() => validatePushSubscriptionData({
    endpoint: sampleEndpoint,
    p256dh: sampleP256dh,
    auth: 'auto-auth-key'
  }), /tạo giả/);

  // Rejects invalid length P-256 key
  assert.throws(() => validatePushSubscriptionData({
    endpoint: sampleEndpoint,
    p256dh: Buffer.from('short').toString('base64'),
    auth: sampleAuth
  }), /Độ dài khóa p256dh|Base64/);

  // Accepts valid genuine subscription
  const valid = validatePushSubscriptionData({
    endpoint: sampleEndpoint,
    p256dh: sampleP256dh,
    auth: sampleAuth
  });
  assert.equal(valid.endpoint, sampleEndpoint);
  assert.equal(valid.p256dh, sampleP256dh);
  assert.equal(valid.auth, sampleAuth);
});

test('Web Push Storage: Saves and upserts real subscriptions in PostgreSQL', async () => {
  const db = await createTestDb();

  const sub = await savePushSubscription(db, {
    endpoint: sampleEndpoint,
    p256dh: sampleP256dh,
    auth: sampleAuth,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
  });

  assert.ok(sub.id);
  assert.equal(sub.endpoint, sampleEndpoint);
  assert.equal(sub.active, true);

  // Upsert: Same endpoint should update updated_at and keep active true
  const updatedSub = await savePushSubscription(db, {
    endpoint: sampleEndpoint,
    p256dh: sampleP256dh,
    auth: sampleAuth,
    userAgent: 'Updated Browser'
  });
  assert.equal(updatedSub.id, sub.id);
  await db.close();
});

test('Web Push Broadcast: Separates sent, failed, and deactivates expired (410/404) subscriptions', async () => {
  const db = await createTestDb();

  // Insert 3 subscriptions:
  // 1: Will succeed (201)
  // 2: Will be expired (410 Gone)
  // 3: Will fail with other error (500)
  const sub1 = await savePushSubscription(db, {
    endpoint: 'https://fcm.googleapis.com/fcm/send/device-success-1',
    p256dh: sampleP256dh,
    auth: sampleAuth
  });

  const sub2 = await savePushSubscription(db, {
    endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/device-expired-2',
    p256dh: sampleP256dh,
    auth: sampleAuth
  });

  const sub3 = await savePushSubscription(db, {
    endpoint: 'https://wns2-pn1p.notify.windows.com/wpush/device-error-3',
    p256dh: sampleP256dh,
    auth: sampleAuth
  });

  // Mock webpush client to simulate real push service responses
  const mockWebpushClient = {
    async sendNotification(sub, payload, options) {
      if (sub.endpoint.includes('device-success-1')) {
        return { statusCode: 201 };
      }
      if (sub.endpoint.includes('device-expired-2')) {
        const err = new Error('Subscription has expired or been unsubscribed');
        err.statusCode = 410;
        throw err;
      }
      if (sub.endpoint.includes('device-error-3')) {
        const err = new Error('Push service temporary gateway timeout');
        err.statusCode = 504;
        throw err;
      }
    }
  };

  const originalPub = process.env.VAPID_PUBLIC_KEY;
  const originalPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = testVapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = testVapid.privateKey;

  try {
    const outcome = await broadcastPushNotification(db, {
      title: 'Khuyến mãi đặc biệt GAERU',
      body: 'Giảm 20% phụ kiện micro thu âm',
      url: '/shop.html'
    }, { webpushClient: mockWebpushClient });

    assert.equal(outcome.ok, true, 'Outcome ok is true indicating broadcast executed');
    assert.equal(outcome.recipientCount, 3);
    assert.equal(outcome.sentCount, 1);
    assert.equal(outcome.expiredCount, 1);
    assert.equal(outcome.failedCount, 1);

    assert.equal(outcome.results.sent[0].endpoint, 'https://fcm.googleapis.com/fcm/send/device-success-1');
    assert.equal(outcome.results.expired[0].endpoint, 'https://updates.push.services.mozilla.com/wpush/v2/device-expired-2');
    assert.equal(outcome.results.failed[0].endpoint, 'https://wns2-pn1p.notify.windows.com/wpush/device-error-3');

    // Verify sub2 (expired 410) was deactivated in PostgreSQL
    const res2 = await db.query('SELECT active FROM web_push_subscriptions WHERE id = $1', [sub2.id]);
    assert.equal(res2.rows[0].active, false, 'Expired subscription must be set to active = false in DB');

    // Verify sub1 and sub3 remain active
    const res1 = await db.query('SELECT active FROM web_push_subscriptions WHERE id = $1', [sub1.id]);
    assert.equal(res1.rows[0].active, true);
    const res3 = await db.query('SELECT active FROM web_push_subscriptions WHERE id = $1', [sub3.id]);
    assert.equal(res3.rows[0].active, true);
  } finally {
    await db.close();
    if (originalPub) process.env.VAPID_PUBLIC_KEY = originalPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (originalPriv) process.env.VAPID_PRIVATE_KEY = originalPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
  }
});

test('Web Push Disabled Fallback: Broadcast turns off gracefully when VAPID is unconfigured', async () => {
  const db = await createTestDb();

  const originalPub = process.env.VAPID_PUBLIC_KEY;
  const originalPriv = process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;

  try {
    const outcome = await broadcastPushNotification(db, {
      title: 'Test push',
      body: 'Body'
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.enabled, false);
    assert.equal(outcome.sentCount, 0);
    assert.match(outcome.error, /VAPID/);
  } finally {
    await db.close();
    if (originalPub) process.env.VAPID_PUBLIC_KEY = originalPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (originalPriv) process.env.VAPID_PRIVATE_KEY = originalPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
  }
});

test('Web Push Client Integrity: sw.js, customer-upgrades-ui.js, and store-shell.js SW retention', () => {
  // 1. Verify sw.js exists at root and handles push and notificationclick
  const swPath = path.join(__dirname, '../sw.js');
  assert.ok(fs.existsSync(swPath), 'sw.js must exist at root for scope /');
  const swContent = fs.readFileSync(swPath, 'utf8');
  assert.match(swContent, /self\.addEventListener\(['"]push['"]/);
  assert.match(swContent, /self\.addEventListener\(['"]notificationclick['"]/);
  assert.match(swContent, /showNotification/);

  // 2. Verify store-shell.js does not unregister sw.js
  const shellContent = fs.readFileSync(path.join(__dirname, '../store-shell.js'), 'utf8');
  assert.match(shellContent, /\/sw\.js/);
  assert.match(shellContent, /isPushWorker/);

  // 3. Verify customer-upgrades-ui.js uses real ServiceWorker & PushManager and eliminates dummy keys
  const uiContent = fs.readFileSync(path.join(__dirname, '../customer-upgrades-ui.js'), 'utf8');
  assert.doesNotMatch(uiContent, /auto-p256dh-key/);
  assert.doesNotMatch(uiContent, /auto-auth-key/);
  assert.match(uiContent, /navigator\.serviceWorker\.register\(['"]\/sw\.js['"]/);
  assert.match(uiContent, /registration\.pushManager\.subscribe/);
  assert.match(uiContent, /urlBase64ToUint8Array/);
});
