'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const webpush = require('web-push');

const {
  savePushSubscription,
  broadcastPushNotification,
  retryPushDelivery,
  ensurePushAttemptsTable
} = require('../src/web-push');

const testVapid = webpush.generateVAPIDKeys();
const sampleP256dh = Buffer.alloc(65, 4).toString('base64');
const sampleAuth = Buffer.alloc(16, 9).toString('base64');

async function createTestDb() {
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
  await ensurePushAttemptsTable(db);
  return db;
}

test('P2-02 Timeout Indeterminate: Push timeout reports status timed_out with indeterminate: true and does not report definite failure', async () => {
  const db = await createTestDb();

  const origPub = process.env.VAPID_PUBLIC_KEY;
  const origPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = testVapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = testVapid.privateKey;

  const endpoint = 'https://fcm.googleapis.com/fcm/send/timeout-test-device-p202';
  await savePushSubscription(db, {
    endpoint,
    p256dh: sampleP256dh,
    auth: sampleAuth
  });

  // Client that simulates gateway hanging until aborted by timeout
  const hangingClient = {
    async sendNotification(_sub, _payload, options) {
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
      title: 'Khuyến mãi đặc biệt',
      body: 'Nội dung kiểm thử timeout'
    }, {
      webpushClient: hangingClient,
      campaignId: 'camp-timeout-p202'
    });

    // 1. Must NOT report definite failure
    assert.equal(outcome.status, 'timed_out', 'Status must be timed_out, NOT failed');
    assert.equal(outcome.indeterminate, true, 'Outcome must be flagged indeterminate: true');
    assert.equal(outcome.failedCount, 0, 'Failed count must be 0 for timed out requests');
    assert.equal(outcome.timedOutCount, 1, 'Timed out count must be 1');
    assert.match(outcome.message, /bất định|timed out/, 'Message must explain delivery state is unconfirmed');

    // 2. Individual result item must enforce no-retry policy
    const item = outcome.results.timedOut[0];
    assert.equal(item.status, 'timed_out');
    assert.equal(item.indeterminate, true, 'Item must be marked indeterminate');
    assert.equal(item.retryAllowed, false, 'retryAllowed must be false to prevent blind duplicate sends');

    // 3. Subscription in web_push_subscriptions remains active
    const subRow = (await db.query('SELECT active FROM web_push_subscriptions WHERE endpoint = $1', [endpoint])).rows[0];
    assert.equal(subRow.active, true, 'Timed out subscription must remain active');

    // 4. Delivery attempt must be logged in web_push_delivery_attempts
    const attemptRow = (await db.query('SELECT * FROM web_push_delivery_attempts WHERE endpoint = $1', [endpoint])).rows[0];
    assert.ok(attemptRow, 'Delivery attempt must be recorded in web_push_delivery_attempts');
    assert.equal(attemptRow.status, 'timed_out');
    assert.equal(attemptRow.indeterminate, true);
    assert.equal(attemptRow.retry_allowed, false);
  } finally {
    if (origPub) process.env.VAPID_PUBLIC_KEY = origPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (origPriv) process.env.VAPID_PRIVATE_KEY = origPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
    await db.close();
  }
});

test('P2-02 Cấm Retry Mù: retryPushDelivery blocks retry on timed out / indeterminate attempts', async () => {
  const db = await createTestDb();

  const endpoint = 'https://fcm.googleapis.com/fcm/send/retry-guard-device';
  const campaignId = 'camp-guard-01';

  // Seed attempt log directly with timed_out / indeterminate
  await db.query(
    `INSERT INTO web_push_delivery_attempts 
     (endpoint, campaign_id, attempt_number, status, indeterminate, retry_allowed, status_code, error_message)
     VALUES ($1, $2, 1, 'timed_out', true, false, 408, 'Quá thời gian chờ phản hồi từ Push Gateway')`,
    [endpoint, campaignId]
  );

  // Attempting to retry an indeterminate push must be strictly blocked
  await assert.rejects(
    async () => {
      await retryPushDelivery(db, { endpoint, campaignId });
    },
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'BLIND_RETRY_FORBIDDEN');
      assert.equal(err.indeterminate, true);
      assert.match(err.message, /bất định|tránh gửi trùng lặp/);
      return true;
    },
    'Blind retry on timed out / indeterminate attempt must be rejected'
  );

  // But definite failure (e.g. status=failed, retry_allowed=true) can be retried
  const definiteFailedEndpoint = 'https://fcm.googleapis.com/fcm/send/definite-failed-device';
  await db.query(
    `INSERT INTO web_push_delivery_attempts 
     (endpoint, campaign_id, attempt_number, status, indeterminate, retry_allowed, status_code, error_message)
     VALUES ($1, $2, 1, 'failed', false, true, 500, 'Push Gateway 500 Internal Error')`,
    [definiteFailedEndpoint, campaignId]
  );

  const retryRes = await retryPushDelivery(db, { endpoint: definiteFailedEndpoint, campaignId });
  assert.equal(retryRes.ok, true);
  assert.equal(retryRes.retryAllowed, true);

  await db.close();
});

test('P2-02 Late Completion (reproducing evidence/push_timeout_late_node24.log): Gateway completes late after timeout', async () => {
  const db = await createTestDb();

  const origPub = process.env.VAPID_PUBLIC_KEY;
  const origPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = testVapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = testVapid.privateKey;

  const endpoint = 'https://fcm.googleapis.com/fcm/send/late-arrival-device';
  await savePushSubscription(db, {
    endpoint,
    p256dh: sampleP256dh,
    auth: sampleAuth
  });

  const campaignId = 'camp-late-arrival';

  // Client that does NOT abort immediately and resolves 100ms after timeout
  let resolveLate;
  const lateClient = {
    sendNotification(_sub, _payload, options) {
      return new Promise((resolve) => {
        resolveLate = resolve;
        if (options?.signal) {
          options.signal.addEventListener('abort', () => {
            // Simulator ignores abort signal (as found in real HTTP gateway lag)
          });
        }
      });
    }
  };

  try {
    const outcomePromise = broadcastPushNotification(db, {
      title: 'Late Test',
      body: 'Late resolution test'
    }, {
      webpushClient: lateClient,
      campaignId
    });

    const outcome = await outcomePromise;
    assert.equal(outcome.status, 'timed_out');
    assert.equal(outcome.timedOutCount, 1);

    // Initial attempt row in DB is timed_out / indeterminate
    let attemptRow = (await db.query('SELECT * FROM web_push_delivery_attempts WHERE endpoint = $1', [endpoint])).rows[0];
    assert.equal(attemptRow.status, 'timed_out');
    assert.equal(attemptRow.indeterminate, true);

    // Now push gateway finishes late (e.g. 100ms later) with 201 Created
    resolveLate({ statusCode: 201 });

    // Allow promise microtasks to run
    await new Promise(r => setTimeout(r, 50));

    // Database attempt log is updated to delivered_late with status_code 201
    attemptRow = (await db.query('SELECT * FROM web_push_delivery_attempts WHERE endpoint = $1', [endpoint])).rows[0];
    assert.equal(attemptRow.status, 'delivered_late');
    assert.equal(attemptRow.indeterminate, false);
    assert.equal(attemptRow.status_code, 201);
  } finally {
    if (origPub) process.env.VAPID_PUBLIC_KEY = origPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (origPriv) process.env.VAPID_PRIVATE_KEY = origPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
    await db.close();
  }
});

test('P2-02 Campaign Idempotency: Re-broadcasting same campaign skips indeterminate and delivered subscriptions', async () => {
  const db = await createTestDb();

  const origPub = process.env.VAPID_PUBLIC_KEY;
  const origPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = testVapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = testVapid.privateKey;

  const endpoint = 'https://fcm.googleapis.com/fcm/send/idempotency-device';
  await savePushSubscription(db, {
    endpoint,
    p256dh: sampleP256dh,
    auth: sampleAuth
  });

  const campaignId = 'camp-idempotency-check';

  let sendCalls = 0;
  const mockClient = {
    async sendNotification() {
      sendCalls++;
      return { statusCode: 201 };
    }
  };

  try {
    // Run 1: Sends notification
    const res1 = await broadcastPushNotification(db, {
      title: 'Flash Sale 50%',
      body: 'Nội dung Flash Sale'
    }, {
      webpushClient: mockClient,
      campaignId
    });

    assert.equal(res1.ok, true);
    assert.equal(res1.sentCount, 1);
    assert.equal(sendCalls, 1);

    // Run 2: Re-executing with the same campaignId must NOT re-send (Idempotency Guard)
    const res2 = await broadcastPushNotification(db, {
      title: 'Flash Sale 50%',
      body: 'Nội dung Flash Sale'
    }, {
      webpushClient: mockClient,
      campaignId
    });

    assert.equal(res2.status, 'idempotent_skipped');
    assert.equal(res2.sentCount, 0, 'Must NOT re-dispatch notification for already handled campaign');
    assert.equal(sendCalls, 1, 'sendNotification must NOT be called again on idempotent repeat');
  } finally {
    if (origPub) process.env.VAPID_PUBLIC_KEY = origPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (origPriv) process.env.VAPID_PRIVATE_KEY = origPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
    await db.close();
  }
});

test('Push broadcast persists a unique claim before sending and gives identical content distinct campaigns', async () => {
  const db = await createTestDb();
  const origPub = process.env.VAPID_PUBLIC_KEY;
  const origPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = testVapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = testVapid.privateKey;
  let sendCalls = 0;
  const mockClient = {
    sendNotification() {
      sendCalls++;
      return Promise.resolve({ statusCode: 201 });
    }
  };
  const dnsLookup = async () => [{ address: '8.8.8.8' }];
  const endpoint = 'https://fcm.googleapis.com/fcm/send/atomic-claim-device';
  await savePushSubscription(db, { endpoint, p256dh: sampleP256dh, auth: sampleAuth }, { dnsLookup });

  try {
    const message = { title: 'Same title', body: 'Same body', url: '/shop.html' };
    const first = await broadcastPushNotification(db, message, { webpushClient: mockClient, dnsLookup });
    const second = await broadcastPushNotification(db, message, { webpushClient: mockClient, dnsLookup });
    assert.notEqual(first.campaignId, second.campaignId);
    assert.equal(sendCalls, 2, 'identical content must not implicitly reuse a campaign ID');

    sendCalls = 0;
    const campaignId = 'same-campaign-concurrent';
    const concurrent = await Promise.all([
      broadcastPushNotification(db, message, { webpushClient: mockClient, campaignId, dnsLookup }),
      broadcastPushNotification(db, message, { webpushClient: mockClient, campaignId, dnsLookup })
    ]);
    assert.equal(sendCalls, 1, 'a concurrent duplicate campaign must acquire exactly one endpoint claim');
    assert.equal(concurrent.reduce((sum, item) => sum + item.sentCount, 0), 1);
    const claims = await db.query(
      'SELECT count(*)::int AS count FROM web_push_delivery_claims WHERE campaign_id = $1 AND endpoint = $2',
      [campaignId, endpoint]
    );
    assert.equal(claims.rows[0].count, 1);
  } finally {
    if (origPub) process.env.VAPID_PUBLIC_KEY = origPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (origPriv) process.env.VAPID_PRIVATE_KEY = origPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
    await db.close();
  }
});

test('Push broadcast fails closed when persistence setup fails and isolates synchronous send throws', async () => {
  const origPub = process.env.VAPID_PUBLIC_KEY;
  const origPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = testVapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = testVapid.privateKey;

  let calls = 0;
  try {
    await assert.rejects(
      broadcastPushNotification({ query: async () => { throw new Error('delivery table unavailable'); } }, {
        title: 'Persistence test',
        body: 'Must not send without recording'
      }, {
        webpushClient: { sendNotification() { calls++; } }
      }),
      /delivery table unavailable/
    );
    assert.equal(calls, 0, 'push gateway must not be called when delivery persistence cannot be set up');

    const db = await createTestDb();
    try {
      const dnsLookup = async () => [{ address: '8.8.8.8' }];
      await Promise.all([
        savePushSubscription(db, { endpoint: 'https://fcm.googleapis.com/fcm/send/sync-throw-device', p256dh: sampleP256dh, auth: sampleAuth }, { dnsLookup }),
        savePushSubscription(db, { endpoint: 'https://fcm.googleapis.com/fcm/send/sync-success-device', p256dh: sampleP256dh, auth: sampleAuth }, { dnsLookup })
      ]);
      const outcome = await broadcastPushNotification(db, { title: 'Send test', body: 'One gateway throws synchronously' }, {
        webpushClient: {
          sendNotification(subscription) {
            if (subscription.endpoint.includes('sync-throw-device')) throw new Error('synchronous gateway error');
            return { statusCode: 201 };
          }
        },
        dnsLookup
      });
      assert.equal(outcome.sentCount, 1);
      assert.equal(outcome.failedCount, 1);
      assert.match(outcome.results.failed[0].error, /synchronous gateway error/);
    } finally {
      await db.close();
    }
  } finally {
    if (origPub) process.env.VAPID_PUBLIC_KEY = origPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (origPriv) process.env.VAPID_PRIVATE_KEY = origPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
  }
});
