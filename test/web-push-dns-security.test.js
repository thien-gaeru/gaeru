'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const webpush = require('web-push');

const {
  verifyPushEndpointDns,
  validatePushSubscriptionData,
  savePushSubscription,
  broadcastPushNotification,
  isKnownPushProvider,
  isPrivateOrLoopbackHost
} = require('../src/web-push');

// Genuine test cryptographic keys
const testVapid = webpush.generateVAPIDKeys();
const sampleP256dh = Buffer.alloc(65, 4).toString('base64');
const sampleAuth = Buffer.alloc(16, 9).toString('base64');
const validFcmEndpoint = 'https://fcm.googleapis.com/fcm/send/valid-client-sub-999';

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
  return db;
}

test('P1-01 DNS Security: Rejects ETIMEOUT on save and does NOT store subscription in DB', async () => {
  const db = await createTestDb();

  const mockDns = async (hostname) => {
    const err = new Error(`getaddrinfo ETIMEOUT ${hostname}`);
    err.code = 'ETIMEOUT';
    throw err;
  };

  await assert.rejects(
    async () => {
      await savePushSubscription(db, {
        endpoint: validFcmEndpoint,
        p256dh: sampleP256dh,
        auth: sampleAuth
      }, { dnsLookup: mockDns });
    },
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /DNS lookup failed: ETIMEOUT/);
      return true;
    }
  );

  const res = await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions WHERE endpoint = $1', [validFcmEndpoint]);
  assert.equal(parseInt(res.rows[0].cnt, 10), 0, 'Subscription must NOT be saved when DNS lookup times out');
  await db.close();
});

test('P1-01 DNS Security: Rejects SERVFAIL on save and does NOT store subscription in DB', async () => {
  const db = await createTestDb();

  const mockDns = async (hostname) => {
    const err = new Error(`queryA SERVFAIL ${hostname}`);
    err.code = 'SERVFAIL';
    throw err;
  };

  await assert.rejects(
    async () => {
      await savePushSubscription(db, {
        endpoint: validFcmEndpoint,
        p256dh: sampleP256dh,
        auth: sampleAuth
      }, { dnsLookup: mockDns });
    },
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /DNS lookup failed: SERVFAIL/);
      return true;
    }
  );

  const res = await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions WHERE endpoint = $1', [validFcmEndpoint]);
  assert.equal(parseInt(res.rows[0].cnt, 10), 0, 'Subscription must NOT be saved when DNS server returns SERVFAIL');
  await db.close();
});

test('P1-01 DNS Security: Rejects ENODATA on save and does NOT store subscription in DB', async () => {
  const db = await createTestDb();

  const mockDns = async (hostname) => {
    const err = new Error(`queryA ENODATA ${hostname}`);
    err.code = 'ENODATA';
    throw err;
  };

  await assert.rejects(
    async () => {
      await savePushSubscription(db, {
        endpoint: validFcmEndpoint,
        p256dh: sampleP256dh,
        auth: sampleAuth
      }, { dnsLookup: mockDns });
    },
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /DNS lookup failed: ENODATA/);
      return true;
    }
  );

  const res = await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions WHERE endpoint = $1', [validFcmEndpoint]);
  assert.equal(parseInt(res.rows[0].cnt, 10), 0, 'Subscription must NOT be saved when DNS returns ENODATA');
  await db.close();
});

test('P1-01 DNS Security: Rejects empty DNS records array on save', async () => {
  const db = await createTestDb();

  const mockDns = async () => [];

  await assert.rejects(
    async () => {
      await savePushSubscription(db, {
        endpoint: validFcmEndpoint,
        p256dh: sampleP256dh,
        auth: sampleAuth
      }, { dnsLookup: mockDns });
    },
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /kết quả rỗng/);
      return true;
    }
  );

  const res = await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions WHERE endpoint = $1', [validFcmEndpoint]);
  assert.equal(parseInt(res.rows[0].cnt, 10), 0, 'Subscription must NOT be saved when DNS returns empty record set');
  await db.close();
});

test('P1-01 DNS Security: Rejects private/loopback/metadata IP addresses returned by DNS', async () => {
  const db = await createTestDb();

  const privateIps = [
    '127.0.0.1',
    '10.0.0.5',
    '172.16.50.1',
    '192.168.1.100',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1'
  ];

  for (const privIp of privateIps) {
    const mockDns = async () => [{ address: privIp, family: privIp.includes(':') ? 6 : 4 }];

    await assert.rejects(
      async () => {
        await savePushSubscription(db, {
          endpoint: validFcmEndpoint,
          p256dh: sampleP256dh,
          auth: sampleAuth
        }, { dnsLookup: mockDns });
      },
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /mạng riêng không được phép/);
        return true;
      },
      `Must reject private IP ${privIp} from DNS response`
    );
  }

  const res = await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions WHERE endpoint = $1', [validFcmEndpoint]);
  assert.equal(parseInt(res.rows[0].cnt, 10), 0, 'Subscription must NOT be saved for any private IP resolution');
  await db.close();
});

test('P1-01 DNS Security: Rejects untrusted push gateway domains and raw IP endpoints', async () => {
  const db = await createTestDb();

  // Untrusted domain
  await assert.rejects(
    async () => {
      await savePushSubscription(db, {
        endpoint: 'https://attacker-controlled-c2.com/push',
        p256dh: sampleP256dh,
        auth: sampleAuth
      });
    },
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /nhà cung cấp Push gateway đáng tin cậy/);
      return true;
    }
  );

  // Raw public IP endpoint
  await assert.rejects(
    async () => {
      await savePushSubscription(db, {
        endpoint: 'https://93.184.216.34/push',
        p256dh: sampleP256dh,
        auth: sampleAuth
      });
    },
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /nhà cung cấp Push gateway đáng tin cậy|không được sử dụng trực tiếp địa chỉ IP/);
      return true;
    }
  );

  await db.close();
});

test('P1-01 DNS Security: Prevents DNS rebinding SSRF (Public at save time -> Private at send time)', async () => {
  const db = await createTestDb();

  // 1. Save time: resolves to genuine public IP
  const initialDns = async () => [{ address: '216.239.38.57', family: 4 }];
  const saved = await savePushSubscription(db, {
    endpoint: validFcmEndpoint,
    p256dh: sampleP256dh,
    auth: sampleAuth
  }, { dnsLookup: initialDns });

  assert.ok(saved.id);
  assert.equal(saved.endpoint, validFcmEndpoint);

  // Configure VAPID
  const origPub = process.env.VAPID_PUBLIC_KEY;
  const origPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = testVapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = testVapid.privateKey;

  let sendNotificationCalls = 0;
  const spyClient = {
    async sendNotification() {
      sendNotificationCalls++;
      return { statusCode: 201 };
    }
  };

  try {
    // 2. Broadcast time: DNS rebinds to internal loopback / metadata service
    const rebindDns = async () => [{ address: '127.0.0.1', family: 4 }];

    const result = await broadcastPushNotification(db, {
      title: 'Khuyến mãi đặc biệt',
      body: 'Giảm giá 50%'
    }, {
      dnsLookup: rebindDns,
      webpushClient: spyClient
    });

    assert.equal(result.ok, false, 'Broadcast must fail when DNS rebinds to private IP');
    assert.equal(result.sentCount, 0, 'No push notifications should be sent to rebound private destination');
    assert.equal(result.failedCount, 1, 'Failed count must record the DNS security rejection');
    assert.equal(sendNotificationCalls, 0, 'CRITICAL: sendNotification must NEVER be invoked on private rebound IP!');
    assert.match(result.results.failed[0].error, /mạng riêng không được phép \(127\.0\.0\.1\)/);
  } finally {
    if (origPub) process.env.VAPID_PUBLIC_KEY = origPub;
    else delete process.env.VAPID_PUBLIC_KEY;
    if (origPriv) process.env.VAPID_PRIVATE_KEY = origPriv;
    else delete process.env.VAPID_PRIVATE_KEY;
    await db.close();
  }
});

test('P1-01 DNS Security: Prevents dispatch when DNS fails with ETIMEOUT at send time', async () => {
  const db = await createTestDb();

  // Save time with valid public IP
  const validDns = async () => [{ address: '216.239.38.57', family: 4 }];
  await savePushSubscription(db, {
    endpoint: validFcmEndpoint,
    p256dh: sampleP256dh,
    auth: sampleAuth
  }, { dnsLookup: validDns });

  process.env.VAPID_PUBLIC_KEY = testVapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = testVapid.privateKey;

  let sendCalls = 0;
  const spyClient = {
    async sendNotification() {
      sendCalls++;
      return { statusCode: 201 };
    }
  };

  // Send time: DNS resolution fails with ETIMEOUT
  const timeoutDns = async (hostname) => {
    const err = new Error(`getaddrinfo ETIMEOUT ${hostname}`);
    err.code = 'ETIMEOUT';
    throw err;
  };

  const result = await broadcastPushNotification(db, {
    title: 'Cập nhật đơn hàng',
    body: 'Đơn hàng của bạn đang được giao'
  }, {
    dnsLookup: timeoutDns,
    webpushClient: spyClient
  });

  assert.equal(result.ok, false);
  assert.equal(result.sentCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(sendCalls, 0, 'Must NOT attempt TLS connection when DNS resolution times out at send time');
  assert.match(result.results.failed[0].error, /DNS lookup failed: ETIMEOUT/);

  await db.close();
});

test('P1-01 DNS Security: Valid known gateway with genuine public IP succeeds end-to-end', async () => {
  const db = await createTestDb();

  const publicDns = async () => [{ address: '216.239.38.57', family: 4 }];

  const sub = await savePushSubscription(db, {
    endpoint: validFcmEndpoint,
    p256dh: sampleP256dh,
    auth: sampleAuth
  }, { dnsLookup: publicDns });

  assert.ok(sub.id);
  assert.equal(sub.active, true);

  process.env.VAPID_PUBLIC_KEY = testVapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = testVapid.privateKey;

  let sendCalls = 0;
  const spyClient = {
    async sendNotification() {
      sendCalls++;
      return { statusCode: 201 };
    }
  };

  const result = await broadcastPushNotification(db, {
    title: 'Thông báo hợp lệ',
    body: 'Nội dung hợp lệ'
  }, {
    dnsLookup: publicDns,
    webpushClient: spyClient
  });

  assert.equal(result.ok, true);
  assert.equal(result.sentCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(sendCalls, 1, 'Legitimate gateway with valid public IP successfully sends notification');

  await db.close();
});
