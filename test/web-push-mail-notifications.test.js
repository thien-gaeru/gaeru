'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { PGlite } = require('@electric-sql/pglite');
const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');
const { enqueueInvoiceRetry } = require('../src/misa-einvoice');
const {
  base64UrlEncode,
  base64UrlDecode,
  createVapidJwt,
  encryptWebPushPayload,
  decryptWebPushPayload,
  sendWebPushNotification
} = require('../src/web-push');
const { notices, dispatchAdminWebPush } = require('../src/admin-notifications');

function generateTestVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: base64UrlEncode(ecdh.getPublicKey()),
    privateKey: base64UrlEncode(ecdh.getPrivateKey()),
    subject: 'mailto:business@gaeru.com'
  };
}

test('RFC 8292 VAPID JWT & RFC 8291 aes128gcm encryption roundtrip', async () => {
  const vapid = generateTestVapidKeys();
  const jwt = createVapidJwt('https://fcm.googleapis.com', vapid.subject, vapid.publicKey, vapid.privateKey);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);

  const pubBuf = base64UrlDecode(vapid.publicKey);
  const verifyKey = crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: base64UrlEncode(pubBuf.subarray(1, 33)),
      y: base64UrlEncode(pubBuf.subarray(33, 65))
    },
    format: 'jwk'
  });
  const validSig = crypto.verify(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
    { key: verifyKey, dsaEncoding: 'ieee-p1363' },
    base64UrlDecode(parts[2])
  );
  assert.equal(validSig, true, 'VAPID ES256 signature must verify cleanly');

  const receiverEcdh = crypto.createECDH('prime256v1');
  receiverEcdh.generateKeys();
  const authSecret = base64UrlEncode(crypto.randomBytes(16));
  const subKeys = {
    p256dh: base64UrlEncode(receiverEcdh.getPublicKey()),
    auth: authSecret
  };

  const messageObj = {
    title: '✉️ GAERU Mail · iCloud+ Custom Domain <business@gaeru.com>',
    body: '[business@gaeru.com] Đơn hàng và hợp tác mới',
    target: 'webmail',
    url: 'https://www.icloud.com/mail'
  };
  const encrypted = encryptWebPushPayload(Buffer.from(JSON.stringify(messageObj), 'utf8'), subKeys);
  assert.ok(encrypted.length > 86, 'Encrypted payload must contain 86-byte aes128gcm header + ciphertext');

  const decrypted = decryptWebPushPayload(encrypted, receiverEcdh, authSecret);
  assert.deepEqual(JSON.parse(decrypted.toString('utf8')), messageObj);

  let capturedReq = null;
  const res = await sendWebPushNotification(
    { endpoint: 'https://fcm.googleapis.com/fcm/send/test-sub-1', keys: subKeys },
    messageObj,
    vapid,
    async (url, opts) => {
      capturedReq = { url, opts };
      return { status: 201 };
    }
  );
  assert.equal(res.ok, true);
  assert.equal(res.gone, false);
  assert.equal(capturedReq.opts.headers['Content-Encoding'], 'aes128gcm');
  assert.match(capturedReq.opts.headers.Authorization, /^vapid t=[^,]+, k=/);
});

test('admin notices no longer read inbound_mail_notifications and migration drops legacy table', async t => {
  const queries = [];
  const mockPool = {
    async query(sql) {
      queries.push(sql);
      return { rows: [] };
    }
  };

  const items = await notices(
    mockPool,
    { source: 'bootstrap', permissions: ['dashboard.read', 'settings.read'] },
    { TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's', smtp: {} }
  );
  assert.equal(queries.some(sql => sql.includes('inbound_mail_notifications')), false);
  assert.equal(items.some(i => i.key.startsWith('mail:')), false);

  const workerSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'admin', 'notification-worker.js'), 'utf8');
  assert.doesNotMatch(workerSrc, /mail\.gaeru\.com/);
  assert.match(workerSrc, /www\.icloud\.com/);

  const pool = await createTestPool(t);
  await pool.query('CREATE TABLE IF NOT EXISTS inbound_mail_notifications (id bigserial PRIMARY KEY)');
  await pool.query("DELETE FROM schema_migrations WHERE name = 'decommission-internal-mail-20261116.sql'");
  await migrateDatabase(pool);
  const tblRes = await pool.query("SELECT to_regclass('public.inbound_mail_notifications') AS tbl");
  assert.equal(tblRes.rows[0].tbl, null);
});

async function createTestPool(t) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  }
  async function query(sql, values) {
    const result = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...result, rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try { return await query(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);
  return pool;
}

function createPushReceiver(endpointSuffix) {
  const receiverEcdh = crypto.createECDH('prime256v1');
  receiverEcdh.generateKeys();
  const authSecret = base64UrlEncode(crypto.randomBytes(16));
  return {
    receiverEcdh,
    authSecret,
    subscription: {
      endpoint: `https://fcm.googleapis.com/fcm/send/${endpointSuffix}-${crypto.randomUUID()}`,
      expirationTime: null,
      keys: {
        p256dh: base64UrlEncode(receiverEcdh.getPublicKey()),
        auth: authSecret
      }
    }
  };
}

function createHttpClient(baseUrl) {
  let cookie = '';
  let csrf = '';
  return {
    async call(urlPath, method = 'GET', body, useCsrf = true) {
      const res = await fetch(baseUrl + urlPath, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(useCsrf && csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (data && typeof data === 'object' && data.csrfToken) csrf = data.csrfToken;
      return { status: res.status, data };
    },
    async login(username, password) {
      await this.call('/api/csrf');
      const res = await this.call('/api/auth/login', 'POST', { username, password });
      assert.equal(res.status, 200, `Login failed for ${username}: ${JSON.stringify(res.data)}`);
      await this.call('/api/csrf');
      return res;
    }
  };
}

test('admin push-subscribe accepts browser expirationTime:null, rejects invalid ECDH keys, and push-test sends GAERU CEO payload', { timeout: 60000 }, async t => {
  const pool = await createTestPool(t);
  const vapid = generateTestVapidKeys();
  const captured = [];
  const password = 'Push-owner-password-2026';
  const config = {
    NODE_ENV: 'test',
    SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
    ADMIN_USERNAME: 'push-owner',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(password, 4),
    PUBLIC_BASE_URL: 'https://gaeru.example',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: vapid.subject,
    webPushFetcher: async (url, opts) => {
      captured.push({ url, opts });
      return { status: 201, text: async () => '' };
    }
  };
  const app = createApp({ pool, config, sessionStore: new session.MemoryStore() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const owner = createHttpClient(baseUrl);
  await owner.login('push-owner', password);

  const keyRes = await owner.call('/api/gaeru_ceo/notifications/vapid-public-key');
  assert.equal(keyRes.status, 200);
  assert.equal(keyRes.data.publicKey, vapid.publicKey);

  const receiver = createPushReceiver('ceo-device');
  const subNullExp = await owner.call('/api/gaeru_ceo/notifications/push-subscribe', 'POST', receiver.subscription);
  assert.equal(subNullExp.status, 200, `Expected 200 for expirationTime:null, got ${JSON.stringify(subNullExp)}`);

  const subNumericExp = await owner.call('/api/gaeru_ceo/notifications/push-subscribe', 'POST', {
    ...receiver.subscription,
    expirationTime: 1893456000000
  });
  assert.equal(subNumericExp.status, 200);

  const badKey = await owner.call('/api/gaeru_ceo/notifications/push-subscribe', 'POST', {
    endpoint: receiver.subscription.endpoint,
    expirationTime: null,
    keys: {
      p256dh: base64UrlEncode(Buffer.alloc(65, 2)),
      auth: receiver.authSecret
    }
  });
  assert.equal(badKey.status, 400);

  const badAuth = await owner.call('/api/gaeru_ceo/notifications/push-subscribe', 'POST', {
    endpoint: receiver.subscription.endpoint,
    keys: {
      p256dh: receiver.subscription.keys.p256dh,
      auth: base64UrlEncode(crypto.randomBytes(4))
    }
  });
  assert.equal(badAuth.status, 400);

  const testPush = await owner.call('/api/gaeru_ceo/notifications/push-test', 'POST', {});
  assert.equal(testPush.status, 200);
  assert.equal(testPush.data.ok, true);
  assert.equal(testPush.data.sent, 1);
  assert.equal(captured.length, 1);
  const decryptedDefault = JSON.parse(
    decryptWebPushPayload(Buffer.from(captured[0].opts.body), receiver.receiverEcdh, receiver.authSecret).toString('utf8')
  );
  assert.equal(decryptedDefault.target, 'notifications');
  assert.match(decryptedDefault.title, /GAERU CEO/);

  const mailTestPush = await owner.call('/api/gaeru_ceo/notifications/push-test', 'POST', { channel: 'mail' });
  assert.equal(mailTestPush.status, 200);
  assert.equal(mailTestPush.data.sent, 1);
  assert.equal(captured.length, 2);
  const decryptedMail = JSON.parse(
    decryptWebPushPayload(Buffer.from(captured[1].opts.body), receiver.receiverEcdh, receiver.authSecret).toString('utf8')
  );
  assert.equal(decryptedMail.target, 'webmail');
  assert.equal(decryptedMail.url, 'https://www.icloud.com/mail');
});

test('dispatchAdminWebPush filters by staff permissions/active flag and prunes 410 gone endpoints', { timeout: 60000 }, async t => {
  const pool = await createTestPool(t);
  const vapid = generateTestVapidKeys();
  const ownerPassword = 'Dispatch-owner-password-2026';
  const staffPassword = 'Dispatch-staff-password-2026';
  const deliveredUrls = [];
  let returnGoneForOwner = false;

  const ownerSub = createPushReceiver('owner-sub');
  const whSub = createPushReceiver('wh-sub');
  const inactiveSub = createPushReceiver('inactive-sub');

  const config = {
    NODE_ENV: 'test',
    SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
    ADMIN_USERNAME: 'dispatch-owner',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(ownerPassword, 4),
    PUBLIC_BASE_URL: 'https://gaeru.example',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: vapid.subject,
    webPushFetcher: async url => {
      deliveredUrls.push(url);
      if (returnGoneForOwner && url === ownerSub.subscription.endpoint) {
        return { status: 410, text: async () => 'Gone' };
      }
      return { status: 201, text: async () => '' };
    }
  };
  const app = createApp({ pool, config, sessionStore: new session.MemoryStore() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(
    "INSERT INTO staff_accounts(username, full_name, password_hash, role, active) VALUES('wh-user', 'Kho', $1, 'warehouse', true), ('inactive-user', 'Cựu quản lý', $1, 'manager', true)",
    [bcrypt.hashSync(staffPassword, 4)]
  );

  const ownerClient = createHttpClient(baseUrl);
  const whClient = createHttpClient(baseUrl);
  const inactiveClient = createHttpClient(baseUrl);
  await ownerClient.login('dispatch-owner', ownerPassword);
  await whClient.login('wh-user', staffPassword);
  await inactiveClient.login('inactive-user', staffPassword);

  assert.equal((await ownerClient.call('/api/gaeru_ceo/notifications/push-subscribe', 'POST', ownerSub.subscription)).status, 200);
  assert.equal((await whClient.call('/api/gaeru_ceo/notifications/push-subscribe', 'POST', whSub.subscription)).status, 200);
  assert.equal((await inactiveClient.call('/api/gaeru_ceo/notifications/push-subscribe', 'POST', inactiveSub.subscription)).status, 200);

  await pool.query("UPDATE staff_accounts SET active = false WHERE username = 'inactive-user'");

  const result = await dispatchAdminWebPush(pool, config, {
    requiredPermissions: ['payments.write'],
    title: 'Giao dịch cần duyệt',
    body: 'Kiểm tra thanh toán đơn hàng mới',
    target: 'orders',
    tag: 'perm-check-1'
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(deliveredUrls, [ownerSub.subscription.endpoint]);

  deliveredUrls.length = 0;
  returnGoneForOwner = true;
  const goneRes = await dispatchAdminWebPush(pool, config, {
    requiredPermissions: ['payments.write'],
    title: 'Cleanup gone',
    body: 'Test 410 cleanup',
    target: 'notifications',
    tag: 'gone-check-1'
  });
  assert.equal(goneRes.gone, 1);
  assert.equal(goneRes.sent, 0);
  const remaining = await pool.query('SELECT endpoint FROM admin_push_subscriptions WHERE endpoint = $1', [ownerSub.subscription.endpoint]);
  assert.equal(remaining.rows.length, 0);
});

test('automatic background Web Push triggers fire for warranty requests, human-mode chat replies, and MISA 3rd-attempt failure', { timeout: 60000 }, async t => {
  const pool = await createTestPool(t);
  const vapid = generateTestVapidKeys();
  const ownerPassword = 'Trigger-owner-password-2026';
  const deliveries = [];
  const ownerSub = createPushReceiver('trigger-owner');

  const config = {
    NODE_ENV: 'test',
    SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
    ADMIN_USERNAME: 'trigger-owner',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(ownerPassword, 4),
    PUBLIC_BASE_URL: 'https://gaeru.example',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: vapid.subject,
    webPushFetcher: async (url, opts) => {
      deliveries.push({
        url,
        payload: JSON.parse(
          decryptWebPushPayload(Buffer.from(opts.body), ownerSub.receiverEcdh, ownerSub.authSecret).toString('utf8')
        )
      });
      return { status: 201, text: async () => '' };
    }
  };
  const app = createApp({ pool, config, sessionStore: new session.MemoryStore() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function waitForDeliveries(expectedCount) {
    const deadline = Date.now() + 2500;
    while (deliveries.length < expectedCount && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(deliveries.length >= expectedCount, `Expected >= ${expectedCount} deliveries, got ${deliveries.length}: ${JSON.stringify(deliveries)}`);
  }

  const ownerClient = createHttpClient(baseUrl);
  const guestClient = createHttpClient(baseUrl);
  await ownerClient.login('trigger-owner', ownerPassword);
  await guestClient.call('/api/csrf');
  assert.equal((await ownerClient.call('/api/gaeru_ceo/notifications/push-subscribe', 'POST', ownerSub.subscription)).status, 200);

  // 1. Warranty registration trigger
  const warRes = await guestClient.call('/api/warranty-requests', 'POST', {
    channel: 'shopee',
    externalOrderNumber: 'GR-WAR-PUSH-1',
    productName: 'GAERU K9',
    serial: 'SN-K9-PUSH-01',
    purchaseDate: '2026-01-10',
    contact: {
      fullName: 'Nguyễn Minh',
      phone: '0901234567',
      address: '123 Lê Lợi',
      city: 'Hà Nội',
      email: 'minh@example.test'
    },
    requestKey: crypto.randomUUID()
  });
  assert.equal(warRes.status, 201);
  await waitForDeliveries(1);
  assert.equal(deliveries[0].payload.target, 'warranty');

  // 2. Human-mode shopping chat customer message trigger
  const chatRes = await guestClient.call('/api/shopping-chat/threads', 'POST', {
    productSlug: null,
    body: 'Cho mình hỏi thêm về pin micro K9',
    requestKey: crypto.randomUUID()
  });
  assert.equal(chatRes.status, 201);
  const threadId = chatRes.data.thread.id;
  await pool.query("UPDATE shopping_chat_threads SET handling_mode = 'human' WHERE id = $1", [threadId]);
  const replyRes = await guestClient.call(`/api/shopping-chat/threads/${threadId}/messages`, 'POST', {
    body: 'Nhân viên hỗ trợ giúp mình với ạ',
    requestKey: crypto.randomUUID()
  });
  assert.equal(replyRes.status, 200);
  await waitForDeliveries(2);
  assert.equal(deliveries[1].payload.target, 'shopping-chat');
  assert.match(deliveries[1].payload.body, /Nhân viên hỗ trợ/);

  // 3. MISA invoice failure on 3rd attempt trigger
  const orderRow = (await pool.query(
    "INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status) VALUES('GR-MISA-PUSH-1', 'Khách Test', 'misa@example.test', '0902223334', '10 Tràng Tiền', 'Hà Nội', 'cod', 300000, 300000, 'completed', 'paid') RETURNING id"
  )).rows[0];
  await enqueueInvoiceRetry(pool, orderRow.id, new Error('MISA err 1'), config);
  await enqueueInvoiceRetry(pool, orderRow.id, new Error('MISA err 2'), config);
  assert.equal(deliveries.length, 2, 'Retries 1 and 2 must remain pending and not alert failed MISA push yet');
  await enqueueInvoiceRetry(pool, orderRow.id, new Error('MISA HTTP 500'), config);
  await waitForDeliveries(3);
  assert.equal(deliveries[2].payload.target, 'business');
  assert.match(deliveries[2].payload.title, /Hóa đơn MISA/);
});
