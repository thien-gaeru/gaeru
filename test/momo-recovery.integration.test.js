'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');
const { migrateDatabase } = require('../src/migrate');
const { writeRecord } = require('../src/admin-configuration');
const { withTransaction } = require('../src/db');
const { createStoreApi } = require('../src/store-api');
const { assertPaymentConfigurationChange } = require('../src/payment-channels');
const { reconcileNextMomoPayment } = require('../src/momo-reconciliation');
const finance = require('../src/finance-api');

const config = { NODE_ENV: 'test', SESSION_SECRET: 'momo-recovery-fixture-encryption-key', PUBLIC_BASE_URL: 'https://example.test' };
const settings = { partnerCode: 'MOMO_FIXTURE', accessKey: 'fixture_access', secretKey: 'fixture-secret-not-a-merchant-key', environment: 'sandbox', enabled: false };
const owner = { username: 'fixture', role: 'owner', source: 'bootstrap' };

test('MoMo recovery with PostgreSQL, signed HTTP IPN and real accounting', { timeout: 60000 }, async suite => {
  const db = await PGlite.create();
  suite.after(() => db.close());
  let queue = Promise.resolve(), connections = 0;
  async function lock() { const old = queue; let release; queue = new Promise(r => { release = r; }); await old; return release; }
  async function rawQuery(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) { const release = await lock(); try { return await rawQuery(sql, values); } finally { release(); } },
    async connect() { const release = await lock(); connections++; return { query: rawQuery, release() { connections--; release(); } }; }
  };
  await migrateDatabase(pool);
  await writeRecord(pool, config, 'payment_momo', settings, 0, owner);
  const app = express();
  app.use(express.json());
  const { appendAudit } = require('../src/audit');
  app.use('/api', createStoreApi(pool, { config, finance, audit: appendAudit, paymentChannels: { methods: [], configs: {}, callbackConfigs: { momo: settings }, versions: { momo: 1 } } }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  suite.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/payments/momo`;

  async function seed(status = 'pending') {
    const ref = 'GR-20261126-' + randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
    const order = (await pool.query(`INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,status,subtotal_vnd,total_vnd)
      VALUES($1,'Fixture','buyer@example.invalid','0900000000','Fixture street','Hà Nội','momo',$2,150000,150000) RETURNING id,order_number`, [ref, status])).rows[0];
    await pool.query(`INSERT INTO payment_attempts(order_id,provider,transaction_ref,provider_request_id,amount_vnd,expires_at)
      VALUES($1,'momo',$2,$2,150000,now()+interval '15 minutes')`, [order.id, ref]);
    return order;
  }
  async function due(order) {
    await pool.query("UPDATE payment_attempts SET next_status_check_at=now()+interval '1 day'");
    await pool.query('UPDATE payment_attempts SET next_status_check_at=now() WHERE order_id=$1', [order.id]);
  }
  async function state(order) {
    return (await pool.query(`SELECT o.status,o.payment_status,p.status AS attempt_status,p.response_code,p.status_check_error,p.status_check_token,
      (SELECT count(*)::int FROM sales_receipts WHERE order_id=o.id) AS receipts
      FROM orders o JOIN payment_attempts p ON p.order_id=o.id WHERE o.id=$1`, [order.id])).rows[0];
  }
  function payload(order, changes = {}) {
    const p = { partnerCode: settings.partnerCode, orderId: order.order_number, requestId: order.order_number, amount: 150000,
      resultCode: 0, transId: 4088878653, responseTime: Date.now(), orderInfo: 'Fixture order', orderType: 'momo_wallet', payType: 'qr', extraData: '', message: 'Fixture', ...changes };
    const fields = ['amount','extraData','message','orderId','orderInfo','orderType','partnerCode','payType','requestId','responseTime','resultCode','transId'];
    const raw = `accessKey=${settings.accessKey}&` + fields.map(key => `${key}=${p[key]}`).join('&');
    return { ...p, signature: createHmac('sha256', settings.secretKey).update(raw).digest('hex') };
  }
  const ipn = (order, changes) => fetch(base + '/ipn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(order, changes)) });
  function provider(changes = {}, beforeResponse) {
    return async (url, init) => {
      assert.equal(connections, 0, 'provider calls must release DB connections');
      assert.equal(url, 'https://test-payment.momo.vn/v2/gateway/api/query');
      const body = JSON.parse(init.body);
      assert.equal(body.signature, createHmac('sha256', settings.secretKey).update(`accessKey=${settings.accessKey}&orderId=${body.orderId}&partnerCode=${body.partnerCode}&requestId=${body.requestId}`).digest('hex'));
      await beforeResponse?.();
      return new Response(JSON.stringify({ partnerCode: settings.partnerCode, orderId: body.orderId, requestId: body.requestId,
        amount: 150000, resultCode: 0, transId: 4088878653, refundTrans: [], ...changes }));
    };
  }

  await suite.test('pending IPNs/returns remain pending; terminal and duplicate IPNs settle once', async () => {
    const order = await seed();
    for (const resultCode of [1000, 7000, 7002, 7654]) {
      assert.equal((await ipn(order, { resultCode })).status, 204);
      assert.equal((await state(order)).attempt_status, 'pending');
      assert.equal((await state(order)).receipts, 0);
      const returned = await fetch(base + '/return?' + new URLSearchParams(payload(order, { resultCode })), { redirect: 'manual' });
      assert.equal(new URL(returned.headers.get('location'), base).searchParams.get('result'), 'processing');
    }
    assert.equal((await ipn(order, { resultCode: 1001 })).status, 204);
    assert.equal((await state(order)).attempt_status, 'failed');
    await ipn(order, { resultCode: 7000 });
    assert.equal((await state(order)).attempt_status, 'failed', 'stale pending cannot revive final failure');
    for (const resultCode of [0, 9000, 1006]) assert.equal((await ipn(order, { resultCode })).status, 204);
    const s = await state(order);
    assert.equal(s.payment_status, 'paid'); assert.equal(s.status, 'processing'); assert.equal(s.receipts, 1);
    assert.equal(s.response_code, '0', 'late notifications cannot downgrade a payment');
  });

  await suite.test('9000 pays a one-step captureWallet order, but a browser return never does', async () => {
    const order = await seed();
    await fetch(base + '/return?' + new URLSearchParams(payload(order, { resultCode: 9000 })), { redirect: 'manual' });
    assert.equal((await state(order)).payment_status, 'pending');
    assert.equal((await ipn(order, { resultCode: 9000 })).status, 204);
    assert.equal((await state(order)).payment_status, 'paid'); assert.equal((await state(order)).receipts, 1);
  });

  await suite.test('a missed IPN is recovered through authenticated query even with checkout disabled', async () => {
    const order = await seed(); await due(order);
    const result = await reconcileNextMomoPayment(pool, config, { fetcher: provider() });
    assert.equal(result.outcome?.successful, true, JSON.stringify(result));
    assert.equal((await state(order)).payment_status, 'paid');
    await ipn(order);
    assert.equal((await state(order)).receipts, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='payment.momo.query' AND entity_id=$1", [order.id])).rows[0].n, 1);
    assert.equal((await reconcileNextMomoPayment(pool, config, { fetcher: provider() })).checked, false);
  });

  await suite.test('queries preserve pending and API errors, and finalize documented failures', async () => {
    const order = await seed();
    for (const resultCode of [1000, 7000, 7002, 42, 13, 7654]) {
      await due(order);
      const result = await reconcileNextMomoPayment(pool, config, { fetcher: provider({ resultCode, transId: 0 }) });
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal((await state(order)).attempt_status, 'pending'); assert.equal((await state(order)).receipts, 0);
    }
    await due(order);
    await reconcileNextMomoPayment(pool, config, { fetcher: provider({ resultCode: 1005, transId: 0 }) });
    assert.equal((await state(order)).attempt_status, 'failed'); assert.equal((await state(order)).payment_status, 'pending');
  });

  await suite.test('wrong identities, amounts, transaction IDs, refunds and network errors cannot settle', async () => {
    const order = await seed();
    for (const changes of [{ partnerCode: 'OTHER' }, { orderId: 'OTHER' }, { requestId: 'OTHER' }, { amount: 149999 }, { transId: 0 }, { transId: 1.2 }, { transId: Number.MAX_SAFE_INTEGER+1 }, { refundTrans: [{ resultCode: 0, amount: 150000 }] }]) {
      await due(order);
      const result = await reconcileNextMomoPayment(pool, config, { fetcher: provider(changes) });
      assert.match(result.error, /^PAYMENT_/); assert.equal((await state(order)).payment_status, 'pending'); assert.equal((await state(order)).receipts, 0);
      assert.equal((await state(order)).status_check_token, null);
    }
    await due(order);
    const result = await reconcileNextMomoPayment(pool, config, { fetcher: async () => { throw new Error(settings.secretKey); } });
    assert.equal(result.error, 'PAYMENT_NETWORK_ERROR'); assert.ok(!JSON.stringify(await state(order)).includes(settings.secretKey));
  });

  await suite.test('live query claims exclude other workers; an IPN during query wins over stale failure', async () => {
    const order = await seed(); await due(order);
    let resume, started;
    const gate = new Promise(r => { resume = r; });
    const ready = new Promise(r => { started = r; });
    const running = reconcileNextMomoPayment(pool, config, { fetcher: provider({ resultCode: 1006 }, async () => { started(); await gate; }) });
    await ready;
    assert.equal((await reconcileNextMomoPayment(pool, config, { fetcher: provider() })).checked, false);
    await ipn(order);
    resume(); await running;
    assert.equal((await state(order)).payment_status, 'paid'); assert.equal((await state(order)).receipts, 1);
  });

  await suite.test('expired query leases recover after a crash; superseded claims cannot write', async () => {
    const order = await seed(); await due(order);
    await pool.query("UPDATE payment_attempts SET status_check_token=$2,status_check_lease_until=now()-interval '1 second' WHERE order_id=$1", [order.id, randomUUID()]);
    const result = await reconcileNextMomoPayment(pool, config, { fetcher: provider({}, () => pool.query('UPDATE payment_attempts SET status_check_token=$2 WHERE order_id=$1', [order.id, randomUUID()])) });
    assert.equal(result.outcome, null); assert.equal((await state(order)).payment_status, 'pending');
    await pool.query("UPDATE payment_attempts SET status_check_lease_until=now()-interval '1 second' WHERE order_id=$1", [order.id]);
    await reconcileNextMomoPayment(pool, config, { fetcher: provider({ resultCode: 9000 }) });
    assert.equal((await state(order)).payment_status, 'paid'); assert.equal((await state(order)).receipts, 1);
  });

  await suite.test('late payment on a cancelled order records money once and requires review', async () => {
    for (const code of ['7000', '7654']) {
      const order = await seed('cancelled'); await due(order);
      await pool.query("UPDATE payment_attempts SET status='failed',response_code=$2,expires_at=now()-interval '1 hour' WHERE order_id=$1", [order.id,code]);
      await assert.rejects(withTransaction(pool, c => assertPaymentConfigurationChange(c, 'momo', settings, { ...settings, secretKey: 'changed-secret' })), e => e.status === 409);
      await reconcileNextMomoPayment(pool, config, { fetcher: provider() });
      const s = await state(order); assert.equal(s.status, 'cancelled'); assert.equal(s.payment_status, 'paid'); assert.equal(s.receipts, 1);
      assert.equal((await pool.query('SELECT reason FROM order_reviews WHERE order_id=$1', [order.id])).rows[0].reason, 'late_payment_on_cancelled_order');
    }
  });

  await suite.test('a changed merchant during query cannot settle with old evidence', async () => {
    const order = await seed(); await due(order);
    const result = await reconcileNextMomoPayment(pool, config, { fetcher: provider({}, () => writeRecord(pool, config, 'payment_momo', { ...settings, partnerCode: 'OTHER_MERCHANT' }, 1, owner)) });
    assert.equal(result.error, 'PAYMENT_CONFIGURATION_CHANGED'); assert.equal((await state(order)).receipts, 0);
    await writeRecord(pool, config, 'payment_momo', settings, 2, owner);
  });

  await suite.test('production never queries with Sandbox credentials', async () => {
    const order = await seed(); await due(order);
    let calls = 0;
    const result = await reconcileNextMomoPayment(pool, { ...config, NODE_ENV: 'production' }, { fetcher: async () => { calls++; throw Error('must not call'); } });
    assert.equal(result.error, 'PAYMENT_CONFIGURATION_INVALID'); assert.equal(calls, 0);
    assert.equal((await state(order)).payment_status, 'pending');
  });

  await suite.test('credential rotation is blocked while provider checkout is in flight; disabling is allowed', async () => {
    await pool.query("UPDATE payment_attempts SET status='failed',response_code='1006',expires_at=now()-interval '1 hour'");
    await pool.query("INSERT INTO checkout_payment_intents(order_number,provider,provider_request_id,amount_vnd) VALUES('GR-20261126-FLIGHT','momo','GR-20261126-FLIGHT',150000)");
    await assert.rejects(withTransaction(pool, c => assertPaymentConfigurationChange(c, 'momo', settings, { ...settings, secretKey: 'changed-secret' })), e => e.status === 409);
    await withTransaction(pool, c => assertPaymentConfigurationChange(c, 'momo', settings, { ...settings, enabled: true }));
    await pool.query("UPDATE checkout_payment_intents SET status='completed'");
    await withTransaction(pool, c => assertPaymentConfigurationChange(c, 'momo', settings, { ...settings, secretKey: 'changed-secret' }));
  });

  await suite.test('recovery migration rechecks old pending codes without creating payments', async () => {
    const order = await seed();
    await pool.query("UPDATE payment_attempts SET status='failed',response_code='9000' WHERE order_id=$1", [order.id]);
    await pool.query("DELETE FROM schema_migrations WHERE name='momo-payment-recovery.sql'");
    await migrateDatabase(pool); await migrateDatabase(pool);
    assert.equal((await state(order)).attempt_status, 'pending'); assert.equal((await state(order)).payment_status, 'pending'); assert.equal((await state(order)).receipts, 0);
    await pool.query("UPDATE payment_attempts SET status='failed',response_code='1006',expires_at=now()-interval '1 hour' WHERE order_id=$1", [order.id]);
  });

  await suite.test('abandoned unfound MoMo sessions expire cleanly after grace window without permanent config lockout', async () => {
    const order = await seed();
    await pool.query("UPDATE payment_attempts SET expires_at=now()-interval '3 hours', next_status_check_at=now() WHERE order_id=$1", [order.id]);
    await assert.rejects(withTransaction(pool, c => assertPaymentConfigurationChange(c, 'momo', settings, { ...settings, secretKey: 'rotated-secret-key' })), e => e.status === 409);
    const result = await reconcileNextMomoPayment(pool, config, { fetcher: provider({ resultCode: 42, transId: 0 }) });
    assert.equal(result.checked, true);
    assert.equal(result.found, false);
    const row = (await pool.query('SELECT status, status_check_error, next_status_check_at FROM payment_attempts WHERE order_id=$1', [order.id])).rows[0];
    assert.equal(row.status, 'failed');
    assert.equal(row.status_check_error, 'PAYMENT_SESSION_EXPIRED');
    assert.equal(row.next_status_check_at, null);
    assert.equal((await reconcileNextMomoPayment(pool, config, { fetcher: provider({ resultCode: 42, transId: 0 }) })).checked, false);
    await withTransaction(pool, c => assertPaymentConfigurationChange(c, 'momo', settings, { ...settings, secretKey: 'rotated-secret-key' }));
  });

  await suite.test('signed MoMo IPN accepts linked-card orderType while rejecting blank orderType, and audits unmatched IPNs', async () => {
    const order = await seed();
    const blankRes = await ipn(order, { orderType: '   ' });
    assert.equal(blankRes.status, 400);
    const napasRes = await ipn(order, { orderType: 'napas', payType: 'napas' });
    assert.equal(napasRes.status, 204);
    assert.equal((await state(order)).payment_status, 'paid');

    const orphanRef = 'GR-20261126-ORPHAN9999';
    const orphanRes = await ipn({ order_number: orphanRef }, { transId: 777888999 });
    assert.equal(orphanRes.status, 409);
    const orphanAudit = (await pool.query("SELECT metadata FROM audit_events WHERE action='payment.momo.unmatched_callback' AND entity_id=$1", [orphanRef])).rows[0];
    assert.ok(orphanAudit, 'unmatched signed IPN must be audited');
    assert.equal(orphanAudit.metadata.providerTransactionId, '777888999');
  });

  await suite.test('pending MoMo codes 1000/7000/7002 block premature cancellation after 15m expiry and name MoMo accurately', async () => {
    const { cancelCustomerOrder } = require('../src/customer-order-cancellation');
    const { createOrderWorkflow } = require('../src/order-workflow');
    const workflow = createOrderWorkflow({ finance, inventory: null, checkoutAccounts: false });
    const cust = (await pool.query("INSERT INTO customers(email,full_name,phone,password_hash,active) VALUES('momo.cancel@example.invalid','MoMo Buyer','0911222333','hash',true) RETURNING id")).rows[0];
    const order = await seed();
    await pool.query("UPDATE orders SET customer_id=$2 WHERE id=$1", [order.id, cust.id]);
    await pool.query("UPDATE payment_attempts SET response_code='7000', expires_at=now()-interval '20 minutes', next_status_check_at=now()+interval '1 hour' WHERE order_id=$1", [order.id]);

    await assert.rejects(
      withTransaction(pool, c => cancelCustomerOrder(c, { orderId: order.id, customerId: cust.id, reason: 'Đổi ý' })),
      err => err.status === 409
    );
    await assert.rejects(
      workflow.updateOrder(pool, order.id, { status: 'cancelled' }, owner),
      err => err.status === 409 && /MoMo/.test(err.message) && !/VNPAY/.test(err.message)
    );
    await pool.query("UPDATE payment_attempts SET status='failed', response_code='1006', next_status_check_at=NULL WHERE order_id=$1", [order.id]);
  });

  await suite.test('MoMo settlement enqueues and dispatches payment_confirmed customer email once', async () => {
    const { processOrderEmail } = require('../src/order-email');
    const order = await seed();
    assert.equal((await ipn(order)).status, 204);
    const outbox = (await pool.query("SELECT kind, status FROM order_email_outbox WHERE order_id=$1 AND kind='payment_confirmed'", [order.id])).rows[0];
    assert.ok(outbox, 'payment_confirmed email must be enqueued upon settlement');
    assert.equal(outbox.status, 'pending');
    const sentMails = [];
    const dispatched = await processOrderEmail(pool, { ...config, smtp: { from: 'GAERU <business@gaeru.com>', publicBaseUrl: 'https://gaeru.com' } }, {
      sendMail: async mail => { sentMails.push(mail); return { accepted: [mail.to], rejected: [] }; }
    });
    assert.equal(dispatched, true);
    assert.equal(sentMails.length, 1);
    assert.match(sentMails[0].subject, /Đã xác nhận thanh toán đơn hàng/);
    assert.match(sentMails[0].text, /Ví MoMo — trạng thái: Đã thanh toán/);
  });
});
