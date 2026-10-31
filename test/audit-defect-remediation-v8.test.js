'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const webpush = require('web-push');

const {
  validatePushSubscriptionData,
  savePushSubscription,
  broadcastPushNotification,
  createPushPublicRouter
} = require('../src/web-push');

test('Lỗi 1 (SSRF DNS Resolution): verifyPushEndpointDns blocks SSRF to private/loopback/cloud metadata', async () => {
  const db = new PGlite();
  await db.exec(`
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
  `);

  const sampleP256dh = Buffer.alloc(65, 4).toString('base64');
  const sampleAuth = Buffer.alloc(16, 9).toString('base64');

  // Loopback / Private IP endpoints must be blocked
  await assert.rejects(
    async () => {
      await savePushSubscription(db, {
        endpoint: 'https://127.0.0.1/push',
        p256dh: sampleP256dh,
        auth: sampleAuth
      });
    },
    /mạng riêng|nội bộ|loopback/
  );

  // Cloud metadata endpoint must be blocked
  await assert.rejects(
    async () => {
      await savePushSubscription(db, {
        endpoint: 'https://169.254.169.254/latest/meta-data',
        p256dh: sampleP256dh,
        auth: sampleAuth
      });
    },
    /mạng riêng|nội bộ|loopback/
  );

  await db.close();
});

test('Lỗi 2 (Web Push Timeout & Indeterminate Delivery): sendWithTimeout flags timed_out with indeterminate: true and retryAllowed: false', async () => {
  const db = new PGlite();
  await db.exec(`
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
  `);

  const sampleP256dh = Buffer.alloc(65, 4).toString('base64');
  const sampleAuth = Buffer.alloc(16, 9).toString('base64');
  const testVapid = webpush.generateVAPIDKeys();

  const originalPub = process.env.VAPID_PUBLIC_KEY;
  const originalPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = testVapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = testVapid.privateKey;

  await savePushSubscription(db, {
    endpoint: 'https://fcm.googleapis.com/fcm/send/timeout-sub-test',
    p256dh: sampleP256dh,
    auth: sampleAuth
  });

  // Mock a client that hangs until aborted
  let receivedSignal = null;
  const hangingClient = {
    async sendNotification(_sub, _payload, options) {
      receivedSignal = options?.signal;
      return new Promise((resolve, reject) => {
        if (options?.signal) {
          options.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }
  };

  try {
    const outcome = await broadcastPushNotification(db, {
      title: 'Khuyến mãi',
      body: 'Nội dung'
    }, { webpushClient: hangingClient });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.timedOutCount, 1);
    assert.equal(outcome.results.timedOut.length, 1);
    const item = outcome.results.timedOut[0];
    assert.equal(item.status, 'timed_out');
    assert.equal(item.indeterminate, true, 'Timed out outcome must be marked indeterminate');
    assert.equal(item.retryAllowed, false, 'Must not allow blind immediate retry');
    assert.ok(receivedSignal && receivedSignal.aborted, 'AbortSignal must have been aborted');
  } finally {
    await db.close();
    if (originalPub) process.env.VAPID_PUBLIC_KEY = originalPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (originalPriv) process.env.VAPID_PRIVATE_KEY = originalPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
  }
});

test('Lỗi 3 (Configuration Synchronization): package.json, package-lock.json, .nvmrc and .node-version are consistent', () => {
  const root = path.join(__dirname, '..');
  const nodeVersion = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim();
  const nvmrc = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

  assert.equal(nodeVersion, '24.22.2', '.node-version must pin 24.22.2 LTS');
  assert.equal(nvmrc, '24.22.2', '.nvmrc must pin 24.22.2 LTS');
  assert.equal(pkg.engines?.node, lock.packages?.['']?.engines?.node, 'package.json and package-lock.json engines must match exactly');
});

test('Lỗi 4 (Push Rate Limiting & Customer Quota): Router sets rate limiting and respects 10 active subs quota', async () => {
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
      customer_id uuid,
      user_agent text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const sampleP256dh = Buffer.alloc(65, 4).toString('base64');
  const sampleAuth = Buffer.alloc(16, 9).toString('base64');

  const custRes = await db.query("INSERT INTO customers (email) VALUES ('test-quota@example.com') RETURNING id");
  const customerId = custRes.rows[0].id;

  // Insert 11 subscriptions for the same customer
  for (let i = 0; i < 11; i++) {
    await savePushSubscription(db, {
      endpoint: `https://fcm.googleapis.com/fcm/send/quota-device-${i}`,
      p256dh: sampleP256dh,
      auth: sampleAuth,
      customerId
    });
  }

  // Active count must be capped at 10
  const activeCountRes = await db.query(
    'SELECT count(*) AS cnt FROM web_push_subscriptions WHERE customer_id = $1 AND active = true',
    [customerId]
  );
  assert.equal(Number(activeCountRes.rows[0].cnt), 10, 'Active subscriptions per customer must not exceed quota of 10');

  await db.close();
});

test('Lỗi 5 (Migration Lock Deadlines & Startup/Shutdown Watchdog): src/server.js and migrate.js have full startup and shutdown deadlines', () => {
  const migrateSource = fs.readFileSync(path.join(__dirname, '../src/migrate.js'), 'utf8');
  assert.match(migrateSource, /SET LOCAL lock_timeout\s*=\s*'15s'/);
  assert.match(migrateSource, /SET LOCAL statement_timeout\s*=\s*'60s'/);

  const serverSource = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(serverSource, /STARTUP_TIMEOUT_MS/);
  assert.match(serverSource, /SHUTDOWN_TIMEOUT_MS/);
  assert.match(serverSource, /watchdogTimer/);
  assert.match(serverSource, /shutdownTimer/);
  assert.match(serverSource, /withTimeout\s*\(\s*migrateDatabase/);
  assert.match(serverSource, /withTimeout\s*\(\s*workerManager\.startAll/);
  assert.match(serverSource, /closeIdleConnections/);
});

test('Lỗi 6 (Client Push Auto-Sync Optimization): customer-upgrades-ui.js avoids duplicate sync and suppresses toasts in auto-sync', () => {
  const uiSource = fs.readFileSync(path.join(__dirname, '../customer-upgrades-ui.js'), 'utf8');
  assert.match(uiSource, /gaeru_push_synced_endpoint/, 'Must cache last synced endpoint in localStorage');
  assert.match(uiSource, /isRecentlySynced/, 'Must check recently synced flag');
  assert.match(uiSource, /isAutoSync:\s*true/, 'autoPromptWebPush must specify isAutoSync: true');
  assert.match(uiSource, /!isAutoSync && typeof window\.GAERUNotify === 'function'/, 'Must not show popup toasts on auto-sync');
});

test('WAF Malformed URI Handling: createWafShield handles invalid percent-encoding without HTTP 500 or URIError', async () => {
  const express = require('express');
  const { createWafShield } = require('../src/security-shield');

  const app = express();
  app.use(createWafShield());
  app.get('/test-waf', (req, res) => res.status(200).json({ ok: true, query: req.query }));

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Normal query must respond with HTTP 200
    const normalRes = await fetch(`${baseUrl}/test-waf?q=gaeru-audio`);
    assert.equal(normalRes.status, 200);

    // 2. Malformed percent-encoded query must NOT throw URIError or return HTTP 500
    const malformedRes = await fetch(`${baseUrl}/test-waf?q=%E0%A4%A`);
    assert.equal(malformedRes.status, 200, 'Malformed percent-encoding must not crash server with 500');

    // 3. Single dangling percent sign must NOT crash server
    const danglingPercentRes = await fetch(`${baseUrl}/test-waf?discount=50%&tag=sale`);
    assert.equal(danglingPercentRes.status, 200);

    // 4. Malformed query containing malicious SQLi or XSS injection must still be blocked with 403
    const attackRes = await fetch(`${baseUrl}/test-waf?q=%E0%A4%A<script>alert(1)</script>`);
    assert.equal(attackRes.status, 403, 'Malicious probe in malformed query must be blocked by WAF with 403');
    const attackData = await attackRes.json();
    assert.equal(attackData.code, 'WAF_INJECTION_BLOCKED');
  } finally {
    server.close();
  }
});

test('Email Domain Inspection: inspectDomain classifies email without @ as missing without querying DNS', async () => {
  const { inspectDomain } = require('../src/order-review');

  let resolverCalls = 0;
  const failingResolver = {
    resolveMx: async () => { resolverCalls++; const err = new Error('DNS failure'); err.code = 'ETIMEOUT'; throw err; },
    lookup: async () => { resolverCalls++; const err = new Error('DNS failure'); err.code = 'ETIMEOUT'; throw err; }
  };

  // 1. Email without @ sign must be classified as 'missing' without calling resolver
  assert.equal(await inspectDomain('invalid-no-at-sign', failingResolver), 'missing');
  assert.equal(resolverCalls, 0, 'Resolver must not be called when @ is missing');

  // 2. Null, undefined, empty, or missing domain must also return 'missing'
  assert.equal(await inspectDomain(null, failingResolver), 'missing');
  assert.equal(await inspectDomain(undefined, failingResolver), 'missing');
  assert.equal(await inspectDomain('', failingResolver), 'missing');
  assert.equal(await inspectDomain('user@', failingResolver), 'missing');
  assert.equal(await inspectDomain('user@nodot', failingResolver), 'missing');
  assert.equal(resolverCalls, 0, 'Resolver must never be called for malformed or missing domains');
});
