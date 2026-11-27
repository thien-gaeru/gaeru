'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const session = require('express-session');
const { PGlite } = require('@electric-sql/pglite');

const { migrateDatabase } = require('../src/migrate');
const { createApp } = require('../src/app');
const { withTransaction } = require('../src/db');
const {
  RealtimeHub,
  acquireSseSlot,
  openSseStream,
  sseHandler,
  getActiveSseCount,
  createRealtimeRouter,
  publishChatEvent,
  defaultHub
} = require('../src/realtime-sse');
const { isPrivateOrReservedIp, assertSafePushEndpoint, isAllowedWebPushHost } = require('../src/audit-fixes/push-url-guard');
const { resolveGoogleIdentity } = require('../src/customer-oauth');
const { restoreOrder } = require('../src/order-restoration');
const { createOrderWorkflow } = require('../src/order-workflow');
const { earnPoints, redeemPoints, getOrCreateLoyalty } = require('../src/loyalty-api');
const { initiateMomoRefund } = require('../src/momo-refunds');
const { writeRecord } = require('../src/admin-configuration');
const { permanentDeleteCustomer } = require('../src/customer-lifecycle');
const { sendRecoveryEmail: sendAbandonedCartReminder } = require('../src/abandoned-cart');
const { createPurchaseOrderFromForecast } = require('../src/inventory-forecast');
const { verifyPackItem, dispatchByBarcode } = require('../src/barcode-api');
const { totp: totpGenerate, base32, seal } = require('../src/totp');

const REPO_ROOT = path.resolve(__dirname, '..');

async function createPglitePool(t) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const prev = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await prev;
    return release;
  }
  async function rawQuery(sql, values) {
    const res = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...res, rows: res?.rows || [], rowCount: res?.affectedRows ?? res?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try { return await rawQuery(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      return { query: rawQuery, release };
    },
    end: () => db.close()
  };
  t.after(() => db.close());
  await migrateDatabase(pool);
  return pool;
}

function makeHttpClient(baseUrl) {
  let cookie = '';
  let csrf = '';
  return {
    async request(urlPath, { method = 'GET', body, headers = {} } = {}) {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(method !== 'GET' && method !== 'HEAD' && csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const ct = res.headers.get('content-type') || '';
      const data = res.status === 204 ? null : (ct.includes('application/json') ? await res.json() : await res.text());
      if (data && typeof data === 'object' && data.csrfToken) csrf = data.csrfToken;
      return { status: res.status, headers: res.headers, data };
    }
  };
}

// =========================================================================
// SEC-01 & SEC-02: SSE leak protection + RBAC filtering & redaction
// =========================================================================
test('SEC-01: pre-closed SSE responses leak 0 slots/listeners and throwing res.write cleans up safely', () => {
  const beforeCount = getActiveSseCount();
  const makeDeadRes = () => Object.assign(new EventEmitter(), {
    closed: true,
    destroyed: true,
    writableEnded: false,
    writeHead() { throw new Error('must not writeHead on closed res'); },
    write() { throw new Error('must not write on closed res'); },
    end() {},
    destroy() {}
  });

  const req = { ip: '127.0.0.1', aborted: false, socket: { destroyed: true } };
  assert.equal(acquireSseSlot(req, makeDeadRes()), false);
  openSseStream(req, makeDeadRes(), 'admin', { hub: new RealtimeHub() });
  sseHandler(req, makeDeadRes());
  assert.equal(getActiveSseCount(), beforeCount, 'Pre-closed SSE streams must not leak active slots');

  // Throwing res.write during hub.publish must not crash delivery to other subscribers
  const hub = new RealtimeHub();
  let healthyReceived = 0;
  let badWrites = 0;
  const badRes = Object.assign(new EventEmitter(), {
    closed: false,
    destroyed: false,
    writableEnded: false,
    writeHead() {},
    write(chunk) {
      badWrites++;
      if (String(chunk).includes('order:new')) throw new Error('EPIPE');
    },
    end() {},
    destroy() { this.destroyed = true; }
  });
  const goodRes = Object.assign(new EventEmitter(), {
    closed: false,
    destroyed: false,
    writableEnded: false,
    writeHead() {},
    write(chunk) {
      if (String(chunk).includes('order:new')) healthyReceived++;
    },
    end() {},
    destroy() { this.destroyed = true; }
  });
  openSseStream({ ip: '10.0.0.1' }, badRes, 'admin', { hub });
  openSseStream({ ip: '10.0.0.2' }, goodRes, 'admin', { hub });

  assert.doesNotThrow(() => hub.publish('admin', 'order:new', { orderNumber: 'GR-1' }));
  assert.equal(healthyReceived, 1, 'Healthy subscriber must still receive event when peer write throws');
  goodRes.emit('close');
  badRes.emit('close');
  assert.equal(getActiveSseCount(), beforeCount, 'All slots must release cleanly');
});

test('SEC-02: warehouse staff on /api/gaeru_ceo/realtime-sse cannot receive chat events & shared admin channel redacts body', async (t) => {
  const pool = await createPglitePool(t);
  const app = express();
  let currentAdmin = null;
  app.use((req, _res, next) => {
    req.admin = currentAdmin;
    req.session = { admin: currentAdmin };
    next();
  });
  const realtime = createRealtimeRouter({ pool, config: {}, hub: defaultHub });
  app.use('/api/gaeru_ceo', realtime.adminRouter);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Capture raw admin broadcast from publishChatEvent to verify plaintext redaction
  const rawAdminEvents = [];
  const rawThreadEvents = [];
  const unsubA = defaultHub.subscribe('admin', (e) => rawAdminEvents.push(e));
  const unsubT = defaultHub.subscribe('shopping_chat:t-sec02', (e) => rawThreadEvents.push(e));
  t.after(() => { unsubA(); unsubT(); });

  // Connect warehouse staff (has dashboard.read + orders.read, NO customers.read)
  currentAdmin = { username: 'kho1', role: 'warehouse', permissions: ['dashboard.read', 'orders.read', 'inventory.read'] };
  const whCtrl = new AbortController();
  const whRes = await fetch(`${baseUrl}/api/gaeru_ceo/realtime-sse`, { signal: whCtrl.signal });
  assert.equal(whRes.status, 200);
  const whReader = whRes.body.getReader();
  const dec = new TextDecoder();
  await whReader.read(); // init

  // Publish customer chat message with sensitive plaintext, then an order event warehouse IS allowed to see
  publishChatEvent('t-sec02', 'chat:message', { sender: 'customer', body: 'SĐT mật 0999888777 địa chỉ nhà riêng' });
  defaultHub.publish('admin', 'order:new', { orderNumber: 'GR-WH-OK' });

  const nextChunk = dec.decode((await whReader.read()).value);
  whCtrl.abort();

  assert.match(nextChunk, /GR-WH-OK/, 'Warehouse must still receive permitted order events');
  assert.doesNotMatch(nextChunk, /chat:message|shopping_chat:message|0999888777/, 'Warehouse must NOT receive shopping chat events');

  // Verify thread channel still has full body while shared admin channel redacted body
  assert.equal(rawThreadEvents.length, 1);
  assert.equal(rawThreadEvents[0].data.body, 'SĐT mật 0999888777 địa chỉ nhà riêng');
  const chatBroadcast = rawAdminEvents.find((e) => e.event === 'chat:message');
  assert.ok(chatBroadcast);
  assert.equal(chatBroadcast.data.body, undefined, 'Shared admin SSE broadcast must redact plaintext body');
  assert.equal(chatBroadcast.data.sender, 'customer');
});

// =========================================================================
// SEC-03 & SEC-04: Pre-MFA OAuth link deferral, MFA + pendingOAuthLink 200, email change unlinks Google
// =========================================================================
test('SEC-03 & SEC-04: OAuth defers link before MFA, MFA+pendingOAuthLink succeeds 200 (not 401), email change clears Google link', async (t) => {
  const pool = await createPglitePool(t);
  const encKey = crypto.randomBytes(32).toString('hex');
  const secret = base32(crypto.randomBytes(20));
  const custPass = 'Customer-Pass-2026!';
  const custHash = bcrypt.hashSync(custPass, 4);

  // 1. SEC-03: Verified email customer with MFA enabled must NOT be pre-linked in resolveGoogleIdentity
  const c1 = (await pool.query(
    `INSERT INTO customers(full_name, email, phone, password_hash, active, email_verified_at)
     VALUES('MFA User', 'mfa-user@example.test', '0901234567', $1, true, now()) RETURNING id`,
    [custHash]
  )).rows[0];
  await pool.query(
    `INSERT INTO account_security(account_key, method, encrypted_secret, last_counter, recovery_hashes, version)
     VALUES($1, 'app', $2, -1, '[]', 1)`,
    [`customer:${c1.id}`, seal(secret, encKey)]
  );
  const resolved = await resolveGoogleIdentity(pool, {
    sub: 'google-sub-mfa-1',
    email: 'mfa-user@example.test',
    emailVerified: true,
    name: 'MFA User',
    picture: null
  });
  assert.equal(resolved.kind, 'existing');
  assert.ok(resolved.deferredOAuthLink, 'Must defer OAuth linking until MFA succeeds');
  const preLinkIdentities = (await pool.query('SELECT * FROM auth_identities WHERE customer_id = $1', [c1.id])).rows;
  assert.equal(preLinkIdentities.length, 0, 'Must NOT insert auth_identities prior to MFA');

  // 2. SEC-04: Unverified email customer with MFA + pendingOAuthLink completes MFA with HTTP 200 (not 401)
  const secret2 = base32(crypto.randomBytes(20));
  const c2 = (await pool.query(
    `INSERT INTO customers(full_name, email, phone, password_hash, active, email_verified_at)
     VALUES('Unverified MFA', 'unverified-mfa@example.test', '0902345678', $1, true, NULL) RETURNING id`,
    [custHash]
  )).rows[0];
  await pool.query(
    `INSERT INTO account_security(account_key, method, encrypted_secret, last_counter, recovery_hashes, version)
     VALUES($1, 'app', $2, -1, '[]', 1)`,
    [`customer:${c2.id}`, seal(secret2, encKey)]
  );

  const sentMails = [];
  const app = createApp({
    pool,
    config: {
      NODE_ENV: 'test',
      PORT: 0,
      PUBLIC_BASE_URL: 'https://gaeru.com',
      SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
      AUTH_ENCRYPTION_KEY: encKey,
      ADMIN_USERNAME: 'sec-owner',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync('Owner-Pass-2026!', 4),
      GOOGLE_CLIENT_ID: 'test-client-id',
      oauthClient: {
        async verifyIdToken() {
          return {
            getPayload: () => ({
              iss: 'https://accounts.google.com',
              aud: 'test-client-id',
              exp: Math.floor(Date.now() / 1000) + 3600,
              sub: 'google-sub-unverified-2',
              email: 'unverified-mfa@example.test',
              email_verified: true,
              name: 'Unverified MFA'
            })
          };
        }
      },
      smtp: { host: 'smtp.example.test', port: 587, from: 'noreply@gaeru.com', publicBaseUrl: 'https://gaeru.com' }
    },
    customerMailer: {
      async sendMail(m) { sentMails.push(m); return { accepted: [m.to], messageId: '<test@gaeru.com>' }; }
    },
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const client = makeHttpClient(`http://127.0.0.1:${server.address().port}`);

  await client.request('/api/csrf');
  const gRes = await client.request('/api/customer-auth/oauth/google', { method: 'POST', body: { credential: 'fake-id-token-string-1234567890' } });
  assert.equal(gRes.status, 409, 'Unverified email collision must return link_required (409)');

  const loginRes = await client.request('/api/customer-auth/login', {
    method: 'POST',
    body: { identifier: 'unverified-mfa@example.test', password: custPass }
  });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.data.mfaRequired, true);

  const code = totpGenerate(secret2, Math.floor(Date.now() / 30000));
  const completeRes = await client.request('/api/account-security/login/complete', {
    method: 'POST',
    body: { code }
  });
  assert.equal(completeRes.status, 200, `MFA complete with pendingOAuthLink must return 200, got ${completeRes.status}: ${JSON.stringify(completeRes.data)}`);
  assert.equal(completeRes.data.customer.emailVerified, true);

  const c2After = (await pool.query('SELECT google_id, email_verified_at FROM customers WHERE id = $1', [c2.id])).rows[0];
  assert.equal(c2After.google_id, 'google-sub-unverified-2');
  assert.ok(c2After.email_verified_at);

  // 3. SEC-03 part 2: Changing customer email removes stale Google auth_identities & customers.google_id
  const reqChange = await client.request('/api/customer-auth/contact-change/request', {
    method: 'POST',
    body: { email: 'new-email@example.test', phone: '0902345678', password: custPass }
  });
  assert.equal(reqChange.status, 200);
  assert.equal(sentMails.length, 2);
  const tokens = sentMails.map((m) => String(m.text).match(/contactVerify=([A-Za-z0-9_-]+)/)[1]);
  const cStep1 = await client.request('/api/customer-auth/contact-change/complete', { method: 'POST', body: { token: tokens[0] } });
  assert.equal(cStep1.status, 200);
  const cStep2 = await client.request('/api/customer-auth/contact-change/complete', { method: 'POST', body: { token: tokens[1] } });
  assert.equal(cStep2.status, 200);

  const c2EmailChanged = (await pool.query('SELECT email, google_id FROM customers WHERE id = $1', [c2.id])).rows[0];
  assert.equal(c2EmailChanged.email, 'new-email@example.test');
  assert.equal(c2EmailChanged.google_id, null, 'Email change must clear customers.google_id');
  const staleIdentities = (await pool.query("SELECT * FROM auth_identities WHERE customer_id = $1 AND provider = 'google'", [c2.id])).rows;
  assert.equal(staleIdentities.length, 0, 'Email change must delete stale Google auth_identities');
});

// =========================================================================
// SEC-05 & SEC-07: Mandatory MFA gate on order-status + Proxy XFF hardening
// =========================================================================
test('SEC-05 & SEC-07: /api/payments/order-status enforces mandatory admin MFA; TRUST_LOCAL_X_FORWARDED_FOR uses rightmost hop and ignores spoofed CF headers', async (t) => {
  const pool = await createPglitePool(t);
  const ownerPass = 'Owner-Hardened-2026!';
  await pool.query(
    `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, shipping_fee_vnd, total_vnd)
     VALUES('GR-20261127-SEC05', 'Buyer', 'b@example.test', '0909999999', '123 St', 'HCM', 'cod', 'pending', 'pending', 100000, 0, 100000)`
  );

  const app = createApp({
    pool,
    config: {
      NODE_ENV: 'test',
      PORT: 0,
      SECURITY_HARDENING: true,
      TRUST_LOCAL_X_FORWARDED_FOR: 'true',
      SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
      ADMIN_USERNAME: 'mfa-owner',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync(ownerPass, 4)
    },
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // SEC-05: Owner logs in WITHOUT MFA enabled while SECURITY_HARDENING=true -> must NOT read arbitrary order status
  const owner = makeHttpClient(baseUrl);
  await owner.request('/api/csrf');
  const login = await owner.request('/api/auth/login', { method: 'POST', body: { username: 'mfa-owner', password: ownerPass } });
  assert.equal(login.status, 200);
  const orderStatus = await owner.request('/api/payments/order-status?order=GR-20261127-SEC05');
  assert.equal(orderStatus.status, 401, 'Admin without mandatory MFA enrollment must be denied /api/payments/order-status');

  // SEC-07: Spoofed CF-Connecting-IP + leftmost XFF must NOT override rightmost proxy-appended IP in PgRateLimitStore
  await pool.query('DELETE FROM security_rate_limits');
  const spoofClient = makeHttpClient(baseUrl);
  await spoofClient.request('/api/csrf');
  await spoofClient.request('/api/customer-auth/login', {
    method: 'POST',
    headers: {
      'cf-connecting-ip': '198.51.100.9',
      'cf-ray': '0123456789abcdef-SIN',
      'x-forwarded-for': '1.2.3.4, 203.0.113.50'
    },
    body: { identifier: 'nobody@example.test', password: 'WrongPassword123!' }
  });
  const rlKeys = (await pool.query('SELECT key FROM security_rate_limits')).rows.map((r) => r.key);
  const hashIp = (ip) => crypto.createHash('sha256').update(ip).digest('hex');
  assert.ok(rlKeys.some((k) => k.endsWith(hashIp('203.0.113.50'))), `Rate limiter must key on rightmost proxy IP 203.0.113.50, got keys: ${JSON.stringify(rlKeys)}`);
  assert.equal(rlKeys.some((k) => k.endsWith(hashIp('1.2.3.4'))), false, 'Must NOT key on spoofable leftmost XFF hop');
  assert.equal(rlKeys.some((k) => k.endsWith(hashIp('198.51.100.9'))), false, 'Must NOT key on spoofable CF-Connecting-IP when TRUST_LOCAL_X_FORWARDED_FOR=true');
});

// =========================================================================
// SEC-06: IPv6 bypass filters, Web Push allowlist & per-account cap
// =========================================================================
test('SEC-06: IPv6 bypass representations blocked and Web Push host allowlist enforced', async () => {
  for (const badIp of [
    '0:0:0:0:0:0:0:1',
    '::127.0.0.1',
    '::ffff:0:127.0.0.1',
    '::ffff:7f00:1',
    'fec0::1',
    '100::1',
    '64:ff9b::127.0.0.1',
    '2001:db8::1',
    'fe80::1',
    'fc00::1'
  ]) {
    assert.equal(isPrivateOrReservedIp(badIp), true, `Must classify ${badIp} as private/reserved`);
  }
  assert.equal(isPrivateOrReservedIp('2606:4700:4700::1111'), false);
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);

  assert.equal(isAllowedWebPushHost('fcm.googleapis.com'), true);
  assert.equal(isAllowedWebPushHost('updates.push.services.mozilla.com'), true);
  assert.equal(isAllowedWebPushHost('web.push.apple.com'), true);
  assert.equal(isAllowedWebPushHost('evil.attacker.example'), false);

  await assert.rejects(
    assertSafePushEndpoint('https://evil.attacker.example/push', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }]
    }),
    (e) => e.status === 400
  );
  const ok = await assertSafePushEndpoint('https://fcm.googleapis.com/fcm/send/abc', {
    lookup: async () => [{ address: '142.250.190.10', family: 4 }]
  });
  assert.deepEqual(ok.addresses, ['142.250.190.10']);
});

// =========================================================================
// COM-01, COM-02, COM-07: Bank transfer restoration/0-toggle, COD partial batch alloc, review+email
// =========================================================================
test('COM-01, COM-02, COM-07: bank_transfer restore/0-toggle reopens payment_attempt; partial COD alloc uses remaining amount; finance payment resolves review & queues email', async (t) => {
  const pool = await createPglitePool(t);
  const ownerActor = { username: 'owner', role: 'owner', source: 'bootstrap', permissions: ['orders.write', 'payments.write', 'finance.write'] };

  // Seed product & variant
  const prod = (await pool.query("INSERT INTO products(slug, name, category, active) VALUES('test-k9', 'GAERU K9', 'audio', true) RETURNING id")).rows[0];
  const variant = (await pool.query("INSERT INTO product_variants(product_id, name, sku, price_vnd, stock_quantity, active) VALUES($1, 'Std', 'SKU-COM01', 200000, 10, true) RETURNING id", [prod.id])).rows[0];
  const wh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN' LIMIT 1")).rows[0];
  await pool.query('INSERT INTO warehouse_stock(warehouse_id, variant_id, quantity) VALUES($1, $2, 10) ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = 10', [wh.id, variant.id]);

  // COM-01: Create cancelled bank_transfer order with failed payment_attempt -> restoreOrder must reopen pending attempt
  const btOrder = (await pool.query(
    `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, shipping_fee_vnd, total_vnd)
     VALUES('GR-20261127-BT01', 'Khach BT', 'bt@example.test', '0901112222', '1 St', 'HCM', 'bank_transfer', 'cancelled', 'pending', 200000, 0, 200000) RETURNING *`
  )).rows[0];
  await pool.query(
    `INSERT INTO order_items(order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES($1, $2, 'GAERU K9', 'Std', 'SKU-COM01', 200000, 1, 200000)`,
    [btOrder.id, variant.id]
  );
  await pool.query(
    `INSERT INTO payment_attempts(order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES($1, 'bank_transfer', $2, 200000, 'failed', now() + interval '24 hours')`,
    [btOrder.id, btOrder.order_number]
  );

  await withTransaction(pool, (c) => restoreOrder(c, {
    id: btOrder.id,
    data: { version: btOrder.management_version, requestKey: crypto.randomUUID(), reason: 'Khách yêu cầu khôi phục lại đơn hàng', confirmedUnpaid: true },
    actor: ownerActor
  }));
  const reopenedAttempt = (await pool.query("SELECT status, amount_vnd FROM payment_attempts WHERE order_id = $1 AND provider = 'bank_transfer'", [btOrder.id])).rows[0];
  assert.equal(reopenedAttempt.status, 'pending', 'restoreOrder must reopen bank_transfer payment_attempt to pending');

  // Toggle shipping fee via discount=subtotal so total goes 0 -> >0 -> attempt must reopen to pending
  await pool.query('UPDATE orders SET discount_vnd = 200000, shipping_fee_vnd = 30000, total_vnd = 30000 WHERE id = $1', [btOrder.id]);
  const wf = createOrderWorkflow({ config: {} });
  await wf.updateOrder(pool, btOrder.id, { shippingFeeVnd: 0 }, ownerActor);
  assert.equal((await pool.query("SELECT status FROM payment_attempts WHERE order_id = $1", [btOrder.id])).rows[0].status, 'failed');
  await wf.updateOrder(pool, btOrder.id, { shippingFeeVnd: 25000 }, ownerActor);
  const reopenedAfterShip = (await pool.query("SELECT status, amount_vnd FROM payment_attempts WHERE order_id = $1", [btOrder.id])).rows[0];
  assert.equal(reopenedAfterShip.status, 'pending');
  assert.equal(Number(reopenedAfterShip.amount_vnd), 25000);

  // COM-02 & COM-07 via HTTP app
  const ownerPass = 'Finance-Owner-2026!';
  const app = createApp({
    pool,
    config: {
      NODE_ENV: 'test',
      PORT: 0,
      SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
      ADMIN_USERNAME: 'fin-owner',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync(ownerPass, 4)
    },
    sessionStore: new session.MemoryStore()
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const admin = makeHttpClient(`http://127.0.0.1:${server.address().port}`);
  await admin.request('/api/csrf');
  await admin.request('/api/auth/login', { method: 'POST', body: { username: 'fin-owner', password: ownerPass } });

  // COM-07: Open order_review on bank_transfer order -> paying full receipt via finance API resolves review & enqueues payment_confirmed email
  await pool.query("INSERT INTO order_reviews(order_id, reason) VALUES($1, 'suspicious_test')", [btOrder.id]);
  const finBt = await admin.request('/api/gaeru_ceo/finance/customer-payments', {
    method: 'POST',
    body: { orderId: btOrder.id, amountVnd: 25000, method: 'bank_transfer', reference: 'VCB-20261127-01', note: 'Thu du CK', requestKey: 'fin-bt-' + crypto.randomUUID() }
  });
  assert.equal(finBt.status, 201);
  const revRow = (await pool.query('SELECT resolved_at FROM order_reviews WHERE order_id = $1', [btOrder.id])).rows[0];
  assert.ok(revRow.resolved_at, 'COM-07: bank_transfer full receipt must resolve open order_reviews');
  const mailRow = (await pool.query("SELECT kind FROM order_email_outbox WHERE order_id = $1 AND kind = 'payment_confirmed'", [btOrder.id])).rows[0];
  assert.ok(mailRow, 'COM-07: bank_transfer full receipt must enqueue payment_confirmed email');

  // COM-02: Partial receipt (400k) + final COD batch receipt (600k) against declared_payout_vnd = 600k
  const codOrder = (await pool.query(
    `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, shipping_fee_vnd, total_vnd)
     VALUES('GR-20261127-COD2', 'Khach COD', 'cod@example.test', '0903334444', '2 St', 'HCM', 'cod', 'shipped', 'pending', 1000000, 0, 1000000) RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status)
     VALUES($1, 'viettel', 'VTP-COM02-1', 'delivered', 1000000, 'unsettled')`,
    [codOrder.id]
  );
  await pool.query(
    `INSERT INTO cod_settlement_batches(carrier_id, provider_transaction_ref, declared_payout_vnd, allocated_total_vnd, method, attestation_level, created_by)
     VALUES('viettel', 'VTP-BATCH-600K', 600000, 0, 'bank_transfer', 'manually_attested', 'fin-owner')`
  );
  // Post partial receipt 400k first
  const p1 = await admin.request('/api/gaeru_ceo/finance/customer-payments', {
    method: 'POST',
    body: { orderId: codOrder.id, amountVnd: 400000, method: 'bank_transfer', reference: 'PARTIAL-400K', note: 'Thu truoc 400k', requestKey: 'cod-p1-' + crypto.randomUUID() }
  });
  assert.equal(p1.status, 201);
  // Post final 600k against batch with declared_payout_vnd = 600k -> MUST succeed and allocate 600k (NOT 1,000k!)
  const p2 = await admin.request('/api/gaeru_ceo/finance/customer-payments', {
    method: 'POST',
    body: { orderId: codOrder.id, amountVnd: 600000, method: 'bank_transfer', reference: 'VTP-BATCH-600K', note: 'Thu COD 600k', requestKey: 'cod-p2-' + crypto.randomUUID() }
  });
  assert.equal(p2.status, 201, `COM-02: final partial COD receipt must succeed against 600k batch, got ${p2.status}: ${JSON.stringify(p2.data)}`);
  const alloc = (await pool.query('SELECT allocated_amount_vnd FROM cod_settlement_allocations WHERE order_id = $1', [codOrder.id])).rows[0];
  assert.equal(Number(alloc.allocated_amount_vnd), 600000, 'COM-02: COD allocation must equal remaining 600,000 VND, not full 1,000,000 VND');
});

// =========================================================================
// COM-03: MoMo refund freezes earned Xu during pending_provider, revokes Xu & automatic warranty on success
// =========================================================================
test('COM-03: MoMo refund freezes earned Xu during Phase 2 and revokes earned Xu + automatic warranty on full refund', async (t) => {
  const pool = await createPglitePool(t);
  const encKey = crypto.randomBytes(32).toString('hex');
  const config = { NODE_ENV: 'test', AUTH_ENCRYPTION_KEY: encKey, SESSION_SECRET: 'momo-sec-test-key' };
  const owner = { username: 'owner', role: 'owner', source: 'bootstrap' };
  await writeRecord(pool, config, 'payment_momo', {
    partnerCode: 'MOMO_COM03', accessKey: 'acc', secretKey: 'sec-key-123456', environment: 'sandbox', requestType: 'captureWallet', enabled: true
  }, 0, owner);

  const cust = (await pool.query("INSERT INTO customers(full_name, email, phone, active) VALUES('VIP', 'vip@example.test', '0905556666', true) RETURNING id")).rows[0];
  const prod = (await pool.query("INSERT INTO products(slug, name, category, active) VALUES('k9-com03', 'GAERU K9', 'audio', true) RETURNING id")).rows[0];
  const variant = (await pool.query("INSERT INTO product_variants(product_id, name, sku, price_vnd, stock_quantity, active) VALUES($1, 'Std', 'SKU-COM03', 1000000, 5, true) RETURNING id", [prod.id])).rows[0];
  const ord = (await pool.query(
    `INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, shipping_fee_vnd, total_vnd)
     VALUES('GR-20261127-MM03', $1, 'VIP', 'vip@example.test', '0905556666', '1 St', 'HCM', 'momo', 'completed', 'paid', 1000000, 0, 1000000) RETURNING *`,
    [cust.id]
  )).rows[0];
  const item = (await pool.query(
    `INSERT INTO order_items(order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES($1, $2, 'GAERU K9', 'Std', 'SKU-COM03', 1000000, 1, 1000000) RETURNING id`,
    [ord.id, variant.id]
  )).rows[0];
  await pool.query(
    `INSERT INTO payment_attempts(order_id, provider, transaction_ref, provider_request_id, provider_transaction_id, amount_vnd, status, response_code, expires_at)
     VALUES($1, 'momo', $2, $2, '4088878699', 1000000, 'paid', '0', now() + interval '15 minutes')`,
    [ord.id, ord.order_number]
  );
  // Earn 10,000 Xu on completed order + active automatic website warranty
  await withTransaction(pool, (c) => earnPoints(c, { customerId: cust.id, orderId: ord.id, orderTotalVnd: 1000000, actor: owner }));
  const beforeLoy = await withTransaction(pool, (c) => getOrCreateLoyalty(c, cust.id));
  assert.equal(beforeLoy.pointsBalance, 10000);
  await pool.query(
    `INSERT INTO warranty_activations(customer_id, order_item_id, automatic, channel, external_order_number, external_product_name, status, purchase_date, expires_on, contact_name, contact_phone, request_key)
     VALUES($1, $2, true, 'website', $3, 'GAERU K9', 'active', '2026-11-27', '2027-11-27', 'VIP', '0905556666', $4)`,
    [cust.id, item.id, ord.order_number, crypto.randomUUID()]
  );

  // During Phase 2 HTTP (while momo_refunds is pending_provider), attempting to spend the earned 10,000 Xu MUST fail with 409!
  let raceRejected = false;
  const rfRes = await initiateMomoRefund(pool, config, {
    orderNumber: ord.order_number,
    amountVnd: 1000000,
    actor: owner,
    fetcher: async (_url, init) => {
      const b = JSON.parse(init.body);
      try {
        await withTransaction(pool, (c) => redeemPoints(c, {
          customerId: cust.id,
          orderId: crypto.randomUUID(),
          pointsToRedeem: 10000,
          orderTotalVnd: 500000
        }));
      } catch (err) {
        if (err.status === 409) raceRejected = true;
      }
      return new Response(JSON.stringify({
        partnerCode: b.partnerCode, orderId: b.orderId, requestId: b.requestId,
        amount: b.amount, transId: 998877665, resultCode: 0, message: 'Success', responseTime: Date.now()
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(raceRejected, true, 'COM-03: Customer MUST NOT spend earned Xu while MoMo refund is in-flight');
  assert.equal(rfRes.refund.status, 'succeeded');

  const afterLoy = await withTransaction(pool, (c) => getOrCreateLoyalty(c, cust.id));
  assert.equal(afterLoy.pointsBalance, 0, 'COM-03: Succeeded MoMo refund must revoke earned Xu');

  const warAfter = (await pool.query('SELECT status FROM warranty_activations WHERE order_item_id = $1', [item.id])).rows[0];
  assert.equal(warAfter.status, 'revoked', 'COM-03: Full MoMo refund outside RMA must revoke automatic website warranty');
});

// =========================================================================
// COM-04 & COM-05: Customer permanent delete hygiene + Abandoned cart hard-bounce stop
// =========================================================================
test('COM-04 & COM-05: permanentDeleteCustomer cleans warranty_order_claims/abandoned_carts/outbox & blocks partial receipt; abandoned cart stops on SMTP 550', async (t) => {
  const pool = await createPglitePool(t);
  const owner = { username: 'owner', role: 'owner', source: 'bootstrap' };

  // COM-04 part 1: Partial receipt blocks permanent delete
  const cBlock = (await pool.query("INSERT INTO customers(full_name, email, phone, active) VALUES('Partial', 'partial@example.test', '0906667777', true) RETURNING id")).rows[0];
  const ordPartial = (await pool.query(
    `INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, shipping_fee_vnd, total_vnd)
     VALUES('GR-20261127-PART', $1, 'Partial', 'partial@example.test', '0906667777', '1 St', 'HCM', 'bank_transfer', 'pending', 'pending', 500000, 0, 500000) RETURNING id`,
    [cBlock.id]
  )).rows[0];
  await pool.query(
    `INSERT INTO sales_receipts(order_id, amount_vnd, method, reference, note, request_key, request_hash, created_by)
     VALUES($1, 200000, 'bank_transfer', 'PART-1', '', 'req-part-1', 'hash1', 'owner')`,
    [ordPartial.id]
  );
  await assert.rejects(permanentDeleteCustomer(pool, cBlock.id, owner), (e) => e.status === 409);

  // COM-04 part 2: Clean deletion removes warranty_order_claims, abandoned_carts, and skips pending order_email_outbox
  const cClean = (await pool.query("INSERT INTO customers(full_name, email, phone, active) VALUES('Clean', 'clean@example.test', '0907778888', true) RETURNING id")).rows[0];
  const ordClean = (await pool.query(
    `INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, shipping_fee_vnd, total_vnd)
     VALUES('GR-20261127-CLN', $1, 'Clean', 'clean@example.test', '0907778888', '1 St', 'HCM', 'cod', 'completed', 'paid', 300000, 0, 300000) RETURNING id`,
    [cClean.id]
  )).rows[0];
  await pool.query(
    `INSERT INTO warranty_order_claims(channel, order_key) VALUES('shopee', 'SHP-CLEAN-99')`
  );
  await pool.query(
    `INSERT INTO warranty_activations(customer_id, automatic, channel, external_order_number, external_product_name, status, contact_name, contact_phone, request_key)
     VALUES($1, false, 'shopee', 'SHP-CLEAN-99', 'GAERU K9', 'pending', 'Clean', '0907778888', $2)`,
    [cClean.id, crypto.randomUUID()]
  );
  const tok = crypto.randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO abandoned_carts(customer_id, email, customer_name, phone, items, subtotal_vnd, recovery_token, recovery_token_hash, recovery_consent, consent_confirmed_at, status)
     VALUES($1, 'clean@example.test', 'Clean', '0907778888', '[]'::jsonb, 100000, $2, $3, true, now(), 'abandoned')`,
    [cClean.id, tok, crypto.createHash('sha256').update(tok).digest('hex')]
  );
  await pool.query("INSERT INTO order_email_outbox(order_id, kind, status) VALUES($1, 'payment_confirmed', 'pending')", [ordClean.id]);

  await permanentDeleteCustomer(pool, cClean.id, owner);
  assert.equal((await pool.query("SELECT * FROM warranty_order_claims WHERE order_key = 'SHP-CLEAN-99'")).rows.length, 0, 'COM-04: warranty_order_claims must be cleaned up');
  assert.equal((await pool.query('SELECT * FROM abandoned_carts WHERE email = $1', ['clean@example.test'])).rows.length, 0, 'COM-04: customer abandoned_carts PII must be deleted');
  assert.equal((await pool.query("SELECT status FROM order_email_outbox WHERE order_id = $1", [ordClean.id])).rows[0].status, 'skipped', 'COM-04: pending order_email_outbox must be skipped');

  // COM-05: Abandoned cart permanent SMTP 550 hard bounce stops retrying immediately
  const bTok = crypto.randomBytes(16).toString('hex');
  const cartRow = (await pool.query(
    `INSERT INTO abandoned_carts(email, customer_name, phone, items, subtotal_vnd, recovery_token, recovery_token_hash, recovery_consent, consent_confirmed_at, status, next_reminder_at)
     VALUES('nosuchuser@example.invalid', 'Ghost', '0900000000', '[{"productName":"K9","variantName":"Std","quantity":1,"priceVnd":289000}]'::jsonb, 289000, $1, $2, true, now(), 'abandoned', now() - interval '5 minutes')
     RETURNING *`,
    [bTok, crypto.createHash('sha256').update(bTok).digest('hex')]
  )).rows[0];
  const bounceRes = await sendAbandonedCartReminder(
    pool,
    { PUBLIC_BASE_URL: 'https://gaeru.com', smtp: { from: 'noreply@gaeru.com', publicBaseUrl: 'https://gaeru.com' } },
    cartRow,
    { async sendMail() { throw Object.assign(new Error('550 5.1.1 User unknown'), { responseCode: 550 }); } }
  );
  assert.equal(bounceRes.success, false);
  assert.equal(bounceRes.permanentFailure, true);
  const cartAfter = (await pool.query('SELECT status, next_reminder_at FROM abandoned_carts WHERE id = $1', [cartRow.id])).rows[0];
  assert.equal(cartAfter.status, 'expired', 'COM-05: SMTP 550 hard bounce must expire cart permanently');
  assert.equal(cartAfter.next_reminder_at, null);
});

// =========================================================================
// COM-08, COM-09, UI-01, SEC-08, AI-01
// =========================================================================
test('COM-08: createPurchaseOrderFromForecast validates inputs, avoids 500, sets submitted_by & audit, safe under concurrency', async (t) => {
  const pool = await createPglitePool(t);
  const wh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN' LIMIT 1")).rows[0];
  const sup = (await pool.query("INSERT INTO suppliers(code, name, active) VALUES('SUP-08', 'NCC Test', true) RETURNING id")).rows[0];
  const prod = (await pool.query("INSERT INTO products(slug, name, category, active) VALUES('k9-po', 'GAERU K9', 'audio', true) RETURNING id")).rows[0];
  const variant = (await pool.query("INSERT INTO product_variants(product_id, name, sku, price_vnd, cost_price_vnd, stock_quantity, active) VALUES($1, 'Std', 'SKU-PO08', 300000, 150000, 5, true) RETURNING id", [prod.id])).rows[0];

  // Invalid variantId -> 400 (not 500 22P02)
  await assert.rejects(
    createPurchaseOrderFromForecast(pool, { supplierId: sup.id, warehouseId: wh.id, items: [{ variantId: 'not-a-uuid', quantity: 5 }] }),
    (e) => e.status === 400
  );
  // Non-string reference -> 400 (not TypeError 500)
  await assert.rejects(
    createPurchaseOrderFromForecast(pool, { supplierId: sup.id, warehouseId: wh.id, reference: { bad: 1 }, items: [{ variantId: variant.id, quantity: 5 }] }),
    (e) => e.status === 400
  );
  // Out-of-bounds quantity -> 400
  await assert.rejects(
    createPurchaseOrderFromForecast(pool, { supplierId: sup.id, warehouseId: wh.id, items: [{ variantId: variant.id, quantity: 5_000_000 }] }),
    (e) => e.status === 400
  );

  // Concurrent creation must produce distinct PO numbers, submitted_by_username, and audit events
  const [po1, po2] = await Promise.all([
    createPurchaseOrderFromForecast(pool, { supplierId: sup.id, warehouseId: wh.id, items: [{ variantId: variant.id, quantity: 5 }], actor: { username: 'buyer1' } }),
    createPurchaseOrderFromForecast(pool, { supplierId: sup.id, warehouseId: wh.id, items: [{ variantId: variant.id, quantity: 3 }], actor: { username: 'buyer2' } })
  ]);
  assert.notEqual(po1.purchaseOrder.number, po2.purchaseOrder.number);
  const poRow = (await pool.query('SELECT submitted_by_username FROM purchase_orders WHERE id = $1', [po1.purchaseOrder.id])).rows[0];
  assert.equal(poRow.submitted_by_username, 'buyer1');
  const auditRow = (await pool.query("SELECT action FROM audit_events WHERE entity_type = 'purchase_order' AND entity_id = $1", [po1.purchaseOrder.id])).rows[0];
  assert.equal(auditRow?.action, 'purchase_order.create_from_forecast');
});

test('COM-09: barcode verifyPackItem and dispatchByBarcode reject shipped and completed orders with 409', async (t) => {
  const pool = await createPglitePool(t);
  for (const status of ['shipped', 'completed']) {
    const ord = (await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, shipping_fee_vnd, total_vnd)
       VALUES($1, 'Buyer', 'b@example.test', '0901234567', '1 St', 'HCM', 'cod', $2, 'paid', 100000, 0, 100000) RETURNING id`,
      ['GR-20261127-BC-' + status.toUpperCase(), status]
    )).rows[0];
    await assert.rejects(
      verifyPackItem(pool, { orderId: ord.id, scannedCode: 'SKU-ANY' }),
      (e) => e.status === 409
    );
    await assert.rejects(
      dispatchByBarcode(pool, { orderId: ord.id }),
      (e) => e.status === 409
    );
  }
});

test('UI-01, SEC-08 & AI-01: all CSS pass esbuild with 0 warnings; cluster-master drains all workers; internal-ai renders RBAC errors cleanly without undefined', async (t) => {
  // UI-01: esbuild check across ALL CSS files in repo
  const esbuild = require('esbuild');
  const cssFiles = [];
  function walkCss(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', 'test'].includes(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walkCss(p);
      else if (ent.name.endsWith('.css')) cssFiles.push(p);
    }
  }
  walkCss(REPO_ROOT);
  assert.ok(cssFiles.length >= 30);
  for (const cssFile of cssFiles) {
    const out = esbuild.transformSync(fs.readFileSync(cssFile, 'utf8'), { loader: 'css', minify: true });
    assert.equal(out.warnings.length, 0, `CSS syntax warning in ${path.relative(REPO_ROOT, cssFile)}: ${JSON.stringify(out.warnings)}`);
  }
  const adminRefCss = fs.readFileSync(path.join(REPO_ROOT, 'admin/admin-refinement.css'), 'utf8');
  assert.match(adminRefCss, /@media\s+\(max-width:1100px\)\s+and\s+\(min-width:761px\)/);

  // SEC-08: cluster-master gracefulShutdown covers cluster.workers & disconnected workers
  const clusterSrc = fs.readFileSync(path.join(REPO_ROOT, 'src/cluster-master.js'), 'utf8');
  assert.match(clusterSrc, /Object\.values\(cluster\.workers \|\| \{\}\)/);
  assert.match(clusterSrc, /kill\('SIGTERM'\)/);

  // AI-01: warehouse staff (lacking customers.read & settings.read) gets RBAC messages instead of "undefined" or "0 bài"
  const pool = await createPglitePool(t);
  const aiRouter = require('../src/internal-ai').createInternalAiRouter(pool, {});
  const whStaffId = crypto.randomUUID();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.admin = { id: whStaffId, username: 'kho_test', role: 'warehouse', permissions: ['dashboard.read', 'orders.read', 'inventory.read'] };
    next();
  });
  app.use('/api/gaeru_ceo/internal-ai', aiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const client = makeHttpClient(`http://127.0.0.1:${server.address().port}`);

  const th = await client.request('/api/gaeru_ceo/internal-ai/threads', { method: 'POST', body: { title: 'RBAC check' } });
  assert.equal(th.status, 201);
  const rOverview = await client.request(`/api/gaeru_ceo/internal-ai/threads/${th.data.thread.id}/chat`, {
    method: 'POST',
    body: { question: 'Báo cáo tổng quan kinh doanh hôm nay' }
  });
  assert.equal(rOverview.status, 200);
  assert.doesNotMatch(rOverview.data.answer, /\bundefined\b/, 'AI overview must not render undefined for restricted metrics');

  const rLearned = await client.request(`/api/gaeru_ceo/internal-ai/threads/${th.data.thread.id}/chat`, {
    method: 'POST',
    body: { question: 'Xem tri thức tự học AI' }
  });
  assert.equal(rLearned.status, 200);
  assert.match(rLearned.data.answer, /settings\.read/, 'AI learned knowledge must show RBAC error instead of fake 0 entries');
});

// =========================================================================
// COM-06: 3-phase MoMo checkout preserves inventory_movements running balance chain
// =========================================================================
test('COM-06: 3-phase MoMo checkout writes chronological inventory_movements in Phase 1 and sale_release on failed gateway', async (t) => {
  const pool = await createPglitePool(t);
  const encKey = crypto.randomBytes(32).toString('hex');
  const owner = { username: 'owner', role: 'owner', source: 'bootstrap' };
  const config = {
    NODE_ENV: 'test',
    PORT: 0,
    PUBLIC_BASE_URL: 'https://gaeru.com',
    AUTH_ENCRYPTION_KEY: encKey,
    SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
    ADMIN_USERNAME: 'inv-owner',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync('Inv-Owner-2026!', 4),
    STORE_ORDERS_ENABLED: true
  };
  await writeRecord(pool, config, 'payment_momo', {
    partnerCode: 'MOMO_COM06', accessKey: 'acc', secretKey: 'sec-key-123456', environment: 'sandbox', requestType: 'captureWallet', enabled: true
  }, 0, owner);

  const prod = (await pool.query("INSERT INTO products(slug, name, category, active) VALUES('k9-com06', 'GAERU K9', 'audio', true) RETURNING id")).rows[0];
  const variant = (await pool.query("INSERT INTO product_variants(product_id, name, sku, price_vnd, stock_quantity, active) VALUES($1, 'Std', 'SKU-COM06', 250000, 10, true) RETURNING id", [prod.id])).rows[0];
  const wh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN' LIMIT 1")).rows[0];
  await pool.query('INSERT INTO warehouse_stock(warehouse_id, variant_id, quantity) VALUES($1, $2, 10) ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = 10', [wh.id, variant.id]);
  await pool.query("INSERT INTO store_settings(setting_key, setting_value) VALUES('shipping_rates', '{\"TP. Hồ Chí Minh\": 0, \"Toàn quốc\": 0}'::jsonb) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value");

  let callNum = 0;
  const app = createApp({
    pool,
    config: {
      ...config,
      paymentFetcher: async (_url, init) => {
        callNum++;
        const b = JSON.parse(init.body);
        if (callNum === 1) {
          // Concurrent stock adjustment DURING Phase 2 (10 -> 8 held in Phase 1, now +5 inbound -> 13)
          await withTransaction(pool, async (c) => {
            await c.query('UPDATE warehouse_stock SET quantity = quantity + 5 WHERE warehouse_id = $1 AND variant_id = $2', [wh.id, variant.id]);
            await c.query('UPDATE product_variants SET stock_quantity = stock_quantity + 5 WHERE id = $1', [variant.id]);
            await c.query(
              `INSERT INTO inventory_movements(event_key, warehouse_id, variant_id, sku, product_name, variant_name, movement_type, delta, quantity_before, quantity_after, reference_type, reference_id, reason, actor_username)
               VALUES('adj-mid-phase2', $1, $2, 'SKU-COM06', 'GAERU K9', 'Std', 'adjustment', 5, 8, 13, 'manual', 'adj-1', 'Concurrent inbound', 'owner')`,
              [wh.id, variant.id]
            );
          });
          return new Response(JSON.stringify({
            partnerCode: b.partnerCode, orderId: b.orderId, requestId: b.requestId, amount: b.amount,
            responseTime: Date.now(), message: 'Success', resultCode: 0, payUrl: 'https://test-payment.momo.vn/pay?t=com06'
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        // Second checkout fails at gateway -> must release hold and record sale_release movement!
        return new Response(JSON.stringify({ resultCode: 99, message: 'Gateway down' }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    },
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const client = makeHttpClient(`http://127.0.0.1:${server.address().port}`);
  await client.request('/api/csrf');

  const okOrder = await client.request('/api/orders', {
    method: 'POST',
    body: {
      customer: { name: 'Buyer 1', email: 'b1@example.test', phone: '0901112233', address: '123 Le Loi', city: 'TP. Hồ Chí Minh', note: '' },
      items: [{ variantId: variant.id, quantity: 2 }],
      paymentMethod: 'momo'
    }
  });
  assert.equal(okOrder.status, 201, `Expected 201, got ${okOrder.status}: ${JSON.stringify(okOrder.data)}`);

  const failOrder = await client.request('/api/orders', {
    method: 'POST',
    body: {
      customer: { name: 'Buyer 2', email: 'b2@example.test', phone: '0901112244', address: '456 Le Loi', city: 'TP. Hồ Chí Minh', note: '' },
      items: [{ variantId: variant.id, quantity: 3 }],
      paymentMethod: 'momo'
    }
  });
  assert.ok(failOrder.status >= 400, 'Second checkout with gateway failure must fail');

  const moves = (await pool.query(
    `SELECT movement_type, delta, quantity_before, quantity_after
     FROM inventory_movements
     WHERE variant_id = $1
     ORDER BY created_at ASC, id ASC`,
    [variant.id]
  )).rows;
  assert.equal(moves.length, 4, `Expected 4 unbroken movements (hold1, adj, hold2, release2), got ${JSON.stringify(moves)}`);
  for (let i = 1; i < moves.length; i++) {
    assert.equal(moves[i].quantity_before, moves[i - 1].quantity_after, `Running balance broken between movement ${i - 1} and ${i}: ${JSON.stringify(moves)}`);
  }
  assert.equal(moves.at(-1).movement_type, 'sale_release');
  assert.equal(moves.at(-1).quantity_after, 13);
});
