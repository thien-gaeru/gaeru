'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const webpush = require('web-push');

const {
  validatePushSubscriptionData,
  savePushSubscription,
  broadcastPushNotification
} = require('../src/web-push');

const sampleP256dh = Buffer.alloc(65, 4).toString('base64');
const sampleAuth = Buffer.alloc(16, 9).toString('base64');

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

test('P2-01 Quota: Re-registering existing active endpoint maintains exactly 10 active devices (no eviction of other devices)', async () => {
  const db = await createTestDb();

  const custRes = await db.query("INSERT INTO customers (email) VALUES ('quota-test-1@gaeru.com') RETURNING id");
  const customerId = custRes.rows[0].id;

  // Register 10 distinct devices
  for (let i = 0; i < 10; i++) {
    await savePushSubscription(db, {
      endpoint: `https://fcm.googleapis.com/fcm/send/device-quota-token-${i}`,
      p256dh: sampleP256dh,
      auth: sampleAuth,
      customerId
    });
  }

  // Verify before state
  let countRes = await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions WHERE customer_id = $1 AND active = true', [customerId]);
  assert.equal(parseInt(countRes.rows[0].cnt, 10), 10, 'Must have exactly 10 active subscriptions before re-register');

  // Verify device 0 is active
  const dev0Before = await db.query('SELECT active FROM web_push_subscriptions WHERE endpoint = $1', ['https://fcm.googleapis.com/fcm/send/device-quota-token-0']);
  assert.equal(dev0Before.rows[0].active, true, 'device 0 must be active');

  // Re-register device 5 (an existing active subscription)
  const updatedSub = await savePushSubscription(db, {
    endpoint: `https://fcm.googleapis.com/fcm/send/device-quota-token-5`,
    p256dh: sampleP256dh,
    auth: sampleAuth,
    customerId,
    userAgent: 'Updated User Agent on Device 5'
  });

  assert.equal(updatedSub.endpoint, 'https://fcm.googleapis.com/fcm/send/device-quota-token-5');
  assert.equal(updatedSub.active, true);

  // CRITICAL CHECK: After re-registering the same endpoint, active count must STILL be 10 (NOT 9!)
  countRes = await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions WHERE customer_id = $1 AND active = true', [customerId]);
  assert.equal(parseInt(countRes.rows[0].cnt, 10), 10, 'DEFECT P2-01 FIX: Active count must remain 10, NOT decrease to 9!');

  // CRITICAL CHECK: Device 0 must NOT have been wrongly evicted!
  const dev0After = await db.query('SELECT active FROM web_push_subscriptions WHERE endpoint = $1', ['https://fcm.googleapis.com/fcm/send/device-quota-token-0']);
  assert.equal(dev0After.rows[0].active, true, 'Device 0 must remain active when Device 5 re-registers!');

  await db.close();
});

test('P2-01 Quota: Adding 11th distinct device evicts exactly one oldest device according to FIFO policy', async () => {
  const db = await createTestDb();

  const custRes = await db.query("INSERT INTO customers (email) VALUES ('quota-test-2@gaeru.com') RETURNING id");
  const customerId = custRes.rows[0].id;

  // Register 10 distinct devices
  for (let i = 0; i < 10; i++) {
    await savePushSubscription(db, {
      endpoint: `https://fcm.googleapis.com/fcm/send/fifo-device-${i}`,
      p256dh: sampleP256dh,
      auth: sampleAuth,
      customerId
    });
  }

  // Register 11th device
  await savePushSubscription(db, {
    endpoint: `https://fcm.googleapis.com/fcm/send/fifo-device-10`,
    p256dh: sampleP256dh,
    auth: sampleAuth,
    customerId
  });

  const countRes = await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions WHERE customer_id = $1 AND active = true', [customerId]);
  assert.equal(parseInt(countRes.rows[0].cnt, 10), 10, 'Active subscriptions count must remain strictly capped at 10');

  // Verify device 0 (oldest) was evicted
  const dev0 = await db.query('SELECT active FROM web_push_subscriptions WHERE endpoint = $1', ['https://fcm.googleapis.com/fcm/send/fifo-device-0']);
  assert.equal(dev0.rows[0].active, false, 'Oldest device 0 must be evicted');

  // Verify devices 1 through 10 are all active
  for (let i = 1; i <= 10; i++) {
    const dev = await db.query('SELECT active FROM web_push_subscriptions WHERE endpoint = $1', [`https://fcm.googleapis.com/fcm/send/fifo-device-${i}`]);
    assert.equal(dev.rows[0].active, true, `Device ${i} must be active`);
  }

  await db.close();
});

test('P2-01 Quota: Concurrent subscription registrations do not exceed 10 and do not drop to 9', async () => {
  const db = await createTestDb();

  const custRes = await db.query("INSERT INTO customers (email) VALUES ('quota-concurrent@gaeru.com') RETURNING id");
  const customerId = custRes.rows[0].id;

  // Pre-populate with 9 devices
  for (let i = 0; i < 9; i++) {
    await savePushSubscription(db, {
      endpoint: `https://fcm.googleapis.com/fcm/send/conc-device-${i}`,
      p256dh: sampleP256dh,
      auth: sampleAuth,
      customerId
    });
  }

  // Concurrently register device 9, device 10, and re-register device 3
  await Promise.all([
    savePushSubscription(db, {
      endpoint: `https://fcm.googleapis.com/fcm/send/conc-device-9`,
      p256dh: sampleP256dh,
      auth: sampleAuth,
      customerId
    }),
    savePushSubscription(db, {
      endpoint: `https://fcm.googleapis.com/fcm/send/conc-device-10`,
      p256dh: sampleP256dh,
      auth: sampleAuth,
      customerId
    }),
    savePushSubscription(db, {
      endpoint: `https://fcm.googleapis.com/fcm/send/conc-device-3`,
      p256dh: sampleP256dh,
      auth: sampleAuth,
      customerId
    })
  ]);

  const countRes = await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions WHERE customer_id = $1 AND active = true', [customerId]);
  assert.equal(parseInt(countRes.rows[0].cnt, 10), 10, 'Concurrent registration must strictly preserve quota at 10');

  // Re-register two existing devices concurrently
  await Promise.all([
    savePushSubscription(db, {
      endpoint: `https://fcm.googleapis.com/fcm/send/conc-device-2`,
      p256dh: sampleP256dh,
      auth: sampleAuth,
      customerId
    }),
    savePushSubscription(db, {
      endpoint: `https://fcm.googleapis.com/fcm/send/conc-device-4`,
      p256dh: sampleP256dh,
      auth: sampleAuth,
      customerId
    })
  ]);

  const countAfterRe = await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions WHERE customer_id = $1 AND active = true', [customerId]);
  assert.equal(parseInt(countAfterRe.rows[0].cnt, 10), 10, 'Concurrent re-registrations must NOT reduce active count below 10');

  await db.close();
});

test('P2-01 Ownership: Rejects hijacking of an endpoint belonging to another customer', async () => {
  const db = await createTestDb();

  const c1Res = await db.query("INSERT INTO customers (email) VALUES ('owner-1@gaeru.com') RETURNING id");
  const c2Res = await db.query("INSERT INTO customers (email) VALUES ('owner-2@gaeru.com') RETURNING id");
  const customer1 = c1Res.rows[0].id;
  const customer2 = c2Res.rows[0].id;

  const sharedEndpoint = 'https://fcm.googleapis.com/fcm/send/shared-endpoint-token-888';

  // Customer 1 registers the device
  await savePushSubscription(db, {
    endpoint: sharedEndpoint,
    p256dh: sampleP256dh,
    auth: sampleAuth,
    customerId: customer1
  });

  // Customer 2 attempts to register the same endpoint
  await assert.rejects(
    async () => {
      await savePushSubscription(db, {
        endpoint: sharedEndpoint,
        p256dh: sampleP256dh,
        auth: sampleAuth,
        customerId: customer2
      });
    },
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /thuộc quyền sở hữu của một tài khoản khách hàng khác/);
      return true;
    }
  );

  // Verify ownership remains with Customer 1
  const sub = await db.query('SELECT customer_id, active FROM web_push_subscriptions WHERE endpoint = $1', [sharedEndpoint]);
  assert.equal(sub.rows[0].customer_id, customer1);
  assert.equal(sub.rows[0].active, true);

  await db.close();
});

test('NEW-02 Ownership: A guest cannot take over a customer-owned endpoint', async () => {
  const db = await createTestDb();
  const ownerId = (await db.query(
    "INSERT INTO customers (email) VALUES ('push-owner@gaeru.test') RETURNING id"
  )).rows[0].id;
  const endpoint = 'https://fcm.googleapis.com/fcm/send/guest-takeover';

  await savePushSubscription(db, {
    endpoint,
    p256dh: sampleP256dh,
    auth: sampleAuth,
    customerId: ownerId
  });

  await assert.rejects(
    savePushSubscription(db, { endpoint, p256dh: sampleP256dh, auth: sampleAuth }),
    (error) => error.status === 403
  );
  const saved = (await db.query(
    'SELECT customer_id FROM web_push_subscriptions WHERE endpoint = $1',
    [endpoint]
  )).rows[0];
  assert.equal(saved.customer_id, ownerId);
  await db.close();
});
