'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { writeRecord, publicRecord, schemas } = require('../src/admin-configuration');
const { withTransaction } = require('../src/db');
const {
  getCheckoutPaymentChannels,
  listPaymentChannels,
  assertPaymentConfigurationChange,
  verifyGatewayPayload,
  reconcilePrepaidOrder
} = require('../src/payment-channels');
const {
  createGatewayPayment,
  refundGatewayPayment,
  queryGatewayRefund
} = require('../src/payment-provider-clients');
const {
  initiateMomoRefund,
  queryMomoRefundStatus,
  listMomoRefunds,
  reconcileNextMomoRefund
} = require('../src/momo-refunds');
const momoProtocol = require('../src/momo-protocol');
const finance = require('../src/finance-api');
const { appendAudit } = require('../src/audit');

const config = {
  NODE_ENV: 'test',
  AUTH_ENCRYPTION_KEY: require('node:crypto').randomBytes(32).toString('hex'),
  SESSION_SECRET: 'momo-aio-refund-fixture-encryption-key',
  PUBLIC_BASE_URL: 'https://gaeru.com'
};
const momoAioSettings = {
  partnerCode: 'MOMO_AIO_TEST',
  accessKey: 'fixture_aio_access',
  secretKey: 'fixture-aio-secret-key-not-live',
  environment: 'sandbox',
  requestType: 'payWithMethod',
  enabled: true
};
const owner = { username: 'owner_fixture', role: 'owner', source: 'bootstrap' };
const sign = (secret, raw) => createHmac('sha256', secret).update(raw, 'utf8').digest('hex');

test('MoMo Package B (payWithMethod AIO) & Package C (Refund + Query Refund) full integration', { timeout: 60000 }, async (suite) => {
  const db = await PGlite.create();
  suite.after(() => db.close());

  let queue = Promise.resolve();
  let connections = 0;
  async function lock() {
    const old = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await old;
    return release;
  }
  async function rawQuery(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) { const release = await lock(); try { return await rawQuery(sql, values); } finally { release(); } },
    async connect() { const release = await lock(); connections++; return { query: rawQuery, release() { connections--; release(); } }; }
  };

  await migrateDatabase(pool);
  await writeRecord(pool, config, 'payment_momo', momoAioSettings, 0, owner);

  async function seedPaidOrder({ amountVnd = 300000, transId = '4088878653', payType = 'aio_qr', paymentStatus = 'paid', paymentMethod = 'momo' } = {}) {
    const ref = 'GR-20261126-' + randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
    const order = (await pool.query(
      `INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,status,payment_status,subtotal_vnd,total_vnd)
       VALUES($1,'Buyer','buyer@example.invalid','0900000000','123 Test','TP.HCM',$2,'processing',$3,$4,$4)
       RETURNING id, order_number`,
      [ref, paymentMethod, paymentStatus, amountVnd]
    )).rows[0];
    await pool.query(
      `INSERT INTO payment_attempts(order_id,provider,transaction_ref,provider_request_id,provider_transaction_id,amount_vnd,status,response_code,expires_at)
       VALUES($1,'momo',$2,$2,$3,$4,$5,'0',now()+interval '15 minutes')`,
      [order.id, ref, transId, amountVnd, paymentStatus === 'paid' ? 'paid' : 'pending']
    );
    if (paymentStatus === 'paid') {
      await appendAudit(pool, {
        actor: { username: 'momo', source: 'payment_gateway' },
        action: 'payment.momo.callback',
        entityType: 'order',
        entityId: order.id,
        metadata: { successful: true, amountVnd, responseCode: '0', providerMeta: { payType } }
      });
    }
    return order;
  }

  await suite.test('Package B: payWithMethod config validation, public channel exposure, signed create & shortLink', async () => {
    const parsed = schemas.payment_momo.parse(momoAioSettings);
    assert.equal(parsed.requestType, 'payWithMethod');
    assert.throws(() => schemas.payment_momo.parse({ ...momoAioSettings, requestType: 'invalidType' }));
    assert.equal(publicRecord('payment_momo', { version: 1, data: { ...momoAioSettings, requestType: undefined } }).data.requestType, 'captureWallet');

    const channels = await getCheckoutPaymentChannels(pool, config);
    assert.equal(channels.momo?.requestType, 'payWithMethod');
    assert.equal(channels.momo?.cardMinAmountVnd, 10000);
    const listed = (await listPaymentChannels(pool, config)).channels.find((c) => c.id === 'momo');
    assert.equal(listed.requestType, 'payWithMethod');

    let captured = null;
    const created = await createGatewayPayment('momo', momoAioSettings, {
      txnRef: 'GR-20261126-AIO0000001',
      amountVnd: 250000,
      baseUrl: 'https://gaeru.com',
      storeName: 'GAERU',
      items: [{ id: 'K9', name: 'GAERU K9', price: 250000, quantity: 1 }],
      deliveryInfo: { deliveryAddress: 'TP.HCM', deliveryFee: '0', quantity: '1' },
      userInfo: { name: 'Buyer', phoneNumber: '0900000000', email: 'buyer@gaeru.com' },
      fetcher: async (_url, init) => {
        captured = JSON.parse(init.body);
        return new Response(JSON.stringify({
          partnerCode: momoAioSettings.partnerCode,
          orderId: captured.orderId,
          requestId: captured.requestId,
          amount: captured.amount,
          responseTime: Date.now(),
          message: 'Success',
          resultCode: 0,
          payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=aio-session',
          shortLink: 'https://test-payment.momo.vn/shortlink/abc123'
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    assert.equal(captured.requestType, 'payWithMethod');
    assert.equal(captured.deliveryInfo, undefined, 'payWithMethod sends only documented Collection Link fields');
    assert.equal(captured.signature, sign(momoAioSettings.secretKey, `accessKey=${momoAioSettings.accessKey}&amount=250000&extraData=&ipnUrl=https://gaeru.com/api/payments/momo/ipn&orderId=GR-20261126-AIO0000001&orderInfo=Thanh toan don hang GR-20261126-AIO0000001&partnerCode=${momoAioSettings.partnerCode}&redirectUrl=https://gaeru.com/api/payments/momo/return&requestId=GR-20261126-AIO0000001&requestType=payWithMethod`));
    assert.equal(created.requestType, 'payWithMethod');
    assert.equal(created.shortLink, 'https://test-payment.momo.vn/shortlink/abc123');

    // Hostile shortLink host must fail closed
    await assert.rejects(createGatewayPayment('momo', momoAioSettings, {
      txnRef: 'GR-20261126-AIO0000002',
      amountVnd: 250000,
      baseUrl: 'https://gaeru.com',
      fetcher: async (_url, init) => {
        const b = JSON.parse(init.body);
        return new Response(JSON.stringify({
          partnerCode: b.partnerCode, orderId: b.orderId, requestId: b.requestId, amount: b.amount,
          responseTime: Date.now(), message: 'Success', resultCode: 0,
          payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=ok',
          shortLink: 'https://evil.example/phish'
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }), (e) => e.code === 'PAYMENT_RESPONSE_INVALID');

    // IPN from payWithMethod credit/napas carries orderType=momo_wallet and payType=credit|napas
    for (const payType of ['credit', 'napas']) {
      const p = {
        partnerCode: momoAioSettings.partnerCode,
        orderId: 'GR-20261126-AIO0000001',
        requestId: 'GR-20261126-AIO0000001',
        amount: 250000,
        orderInfo: 'Thanh toan don hang GR-20261126-AIO0000001',
        orderType: 'momo_wallet',
        transId: 55667788,
        resultCode: 0,
        message: 'Successful.',
        payType,
        responseTime: Date.now(),
        extraData: ''
      };
      const raw = `accessKey=${momoAioSettings.accessKey}&amount=${p.amount}&extraData=${p.extraData}&message=${p.message}&orderId=${p.orderId}&orderInfo=${p.orderInfo}&orderType=${p.orderType}&partnerCode=${p.partnerCode}&payType=${p.payType}&requestId=${p.requestId}&responseTime=${p.responseTime}&resultCode=${p.resultCode}&transId=${p.transId}`;
      const verified = verifyGatewayPayload('momo', { ...p, signature: sign(momoAioSettings.secretKey, raw) }, momoAioSettings);
      assert.equal(verified.valid, true);
      assert.equal(verified.successful, true);
      assert.equal(verified.payType, payType);
    }
  });

  await suite.test('Package C client: exact 7-field refund signature, 4-field refund query, refundTrans matching & 1080/1081/1088 codes', async () => {
    await assert.rejects(
      refundGatewayPayment('momo', momoAioSettings, {
        originalOrderId: 'GR-20261126-SAME1',
        refundOrderId: 'GR-20261126-SAME1',
        originalTransId: 4088878653,
        amountVnd: 10000
      }),
      (e) => e.status === 400
    );

    let capturedRefund = null;
    const ok = await refundGatewayPayment('momo', momoAioSettings, {
      originalOrderId: 'GR-20261126-ORIG1',
      refundOrderId: 'RF-20261126-ORIG1-AA11',
      requestId: 'RF-REQ-1',
      originalTransId: 4088878653,
      amountVnd: 100000,
      description: 'Hoan tien 1 phan',
      fetcher: async (url, init) => {
        capturedRefund = { url, body: JSON.parse(init.body) };
        return new Response(JSON.stringify({
          partnerCode: momoAioSettings.partnerCode,
          orderId: capturedRefund.body.orderId,
          requestId: capturedRefund.body.requestId,
          amount: 100000,
          transId: 2820086739,
          resultCode: 0,
          message: 'Successful.',
          responseTime: Date.now()
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    assert.equal(capturedRefund.url, 'https://test-payment.momo.vn/v2/gateway/api/refund');
    assert.equal(
      capturedRefund.body.signature,
      sign(momoAioSettings.secretKey, `accessKey=${momoAioSettings.accessKey}&amount=100000&description=Hoan tien 1 phan&orderId=RF-20261126-ORIG1-AA11&partnerCode=${momoAioSettings.partnerCode}&requestId=RF-REQ-1&transId=4088878653`)
    );
    assert.equal(ok.successful, true);
    assert.equal(ok.refundTransId, '2820086739');

    for (const code of [1080, 1081, 1088]) {
      assert.equal(momoProtocol.refundState(code), 'failed');
      assert.match(momoProtocol.refundFailureMessage(code), new RegExp(String(code)));
    }

    // Per MoMo p. 222 example: top-level orderId may echo the original orderId while refundTrans[] carries refundOrderId
    let capturedQuery = null;
    const q = await queryGatewayRefund('momo', momoAioSettings, {
      refundOrderId: 'RF-20261126-ORIG1-AA11',
      queryRequestId: 'QRF-1',
      amountVnd: 100000,
      fetcher: async (url, init) => {
        capturedQuery = { url, body: JSON.parse(init.body) };
        return new Response(JSON.stringify({
          partnerCode: momoAioSettings.partnerCode,
          orderId: 'GR-20261126-ORIG1',
          requestId: 'QRF-1',
          resultCode: 0,
          message: 'Successful.',
          responseTime: Date.now(),
          refundTrans: [
            { orderId: 'RF-20261126-ORIG1-OTHER', amount: 50000, resultCode: 1002, transId: 0, createdTime: Date.now() },
            { orderId: 'RF-20261126-ORIG1-AA11', amount: 100000, resultCode: 0, transId: 2820086739, createdTime: Date.now() }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    assert.equal(capturedQuery.url, 'https://test-payment.momo.vn/v2/gateway/api/refund/query');
    assert.equal(
      capturedQuery.body.signature,
      sign(momoAioSettings.secretKey, `accessKey=${momoAioSettings.accessKey}&orderId=RF-20261126-ORIG1-AA11&partnerCode=${momoAioSettings.partnerCode}&requestId=QRF-1`)
    );
    assert.equal(q.found, true);
    assert.equal(q.successful, true);
    assert.equal(q.refundTransId, '2820086739');
  });

  await suite.test('Package C workflow: 3-phase partial refunds, idempotency, ATM 10k floor, pending reconciliation & credential lock', async () => {
    const order = await seedPaidOrder({ amountVnd: 300000, transId: '4088878653', payType: 'aio_qr' });

    // Partial refund 1 (100,000 VND) with zero DB connections held during HTTP call
    const r1 = await initiateMomoRefund(pool, config, {
      orderNumber: order.order_number,
      amountVnd: 100000,
      description: 'Hoan lan 1',
      requestKey: 'refund-key-1',
      actor: owner,
      fetcher: async (_url, init) => {
        assert.equal(connections, 0, 'refund HTTP call must not hold any DB connection');
        const b = JSON.parse(init.body);
        assert.notEqual(b.orderId, order.order_number);
        return new Response(JSON.stringify({
          partnerCode: b.partnerCode, orderId: b.orderId, requestId: b.requestId,
          amount: b.amount, transId: 777111222, resultCode: 0, message: 'Successful.', responseTime: Date.now()
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    assert.equal(r1.replayed, false);
    assert.equal(r1.refund.status, 'succeeded');
    assert.equal(r1.refund.refundTransId, '777111222');

    // Replay same requestKey must not call MoMo again
    let extraCalls = 0;
    const replay = await initiateMomoRefund(pool, config, {
      orderNumber: order.order_number,
      amountVnd: 100000,
      requestKey: 'refund-key-1',
      actor: owner,
      fetcher: async () => { extraCalls++; throw new Error('must not call'); }
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.refund.id, r1.refund.id);
    assert.equal(extraCalls, 0);

    // Over-limit refund (200,001 > remaining 200,000) must be rejected 409
    await assert.rejects(
      initiateMomoRefund(pool, config, { orderNumber: order.order_number, amountVnd: 200001, actor: owner, fetcher: async () => { throw new Error('must not call'); } }),
      (e) => e.status === 409
    );

    // Partial refund 2 returns 7002 (pending) -> blocks MoMo credential rotation until reconciled
    const r2 = await initiateMomoRefund(pool, config, {
      orderNumber: order.order_number,
      amountVnd: 200000,
      description: 'Hoan lan 2',
      actor: owner,
      fetcher: async (_url, init) => {
        const b = JSON.parse(init.body);
        return new Response(JSON.stringify({
          partnerCode: b.partnerCode, orderId: b.orderId, requestId: b.requestId,
          amount: b.amount, transId: 0, resultCode: 7002, message: 'Processing.', responseTime: Date.now()
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    assert.equal(r2.refund.status, 'pending');

    await assert.rejects(
      withTransaction(pool, (c) => assertPaymentConfigurationChange(c, 'momo', momoAioSettings, { ...momoAioSettings, secretKey: 'rotated-secret' })),
      (e) => e.status === 409
    );

    // Reconcile pending refund via /v2/gateway/api/refund/query
    await pool.query("UPDATE momo_refunds SET last_checked_at = now() - interval '5 minutes' WHERE id = $1", [r2.refund.id]);
    const rec = await reconcileNextMomoRefund(pool, config, {
      fetcher: async (_url, init) => {
        const b = JSON.parse(init.body);
        return new Response(JSON.stringify({
          partnerCode: b.partnerCode,
          orderId: order.order_number,
          requestId: b.requestId,
          resultCode: 0,
          message: 'Successful.',
          responseTime: Date.now(),
          refundTrans: [{ orderId: r2.refund.refundOrderId, amount: 200000, resultCode: 0, transId: 777111333, createdTime: Date.now() }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    assert.equal(rec.checked, true);
    assert.equal(rec.refund.status, 'succeeded');
    assert.equal(rec.refund.refundTransId, '777111333');

    const listed = await listMomoRefunds(pool, { orderNumber: order.order_number });
    assert.equal(listed.refunds.length, 2);
    assert.equal(listed.summary.totalSucceededVnd, 300000);

    // ATM (napas) order requires >= 10,000 VND minimum refund per MoMo p. 218
    const atmOrder = await seedPaidOrder({ amountVnd: 100000, transId: '5099988877', payType: 'napas' });
    await assert.rejects(
      initiateMomoRefund(pool, config, { orderNumber: atmOrder.order_number, amountVnd: 5000, actor: owner, fetcher: async () => { throw new Error('must not call'); } }),
      (e) => e.status === 400 && /10\.000/.test(e.message)
    );

    // Manual order without numeric transId cannot call API refund
    const manualOrder = await seedPaidOrder({ amountVnd: 100000, transId: 'OWNER-RECONCILE' });
    await assert.rejects(
      initiateMomoRefund(pool, config, { orderNumber: manualOrder.order_number, amountVnd: 50000, actor: owner, fetcher: async () => { throw new Error('must not call'); } }),
      (e) => e.status === 409 && /transId/.test(e.message)
    );

    // Network failure produces ambiguous refund & blocks duplicate refund until queried
    const ambOrder = await seedPaidOrder({ amountVnd: 120000, transId: '6011122233' });
    const amb = await initiateMomoRefund(pool, config, {
      orderNumber: ambOrder.order_number,
      amountVnd: 120000,
      actor: owner,
      fetcher: async () => { throw new Error('network reset'); }
    });
    assert.equal(amb.refund.status, 'ambiguous');
    await assert.rejects(
      initiateMomoRefund(pool, config, { orderNumber: ambOrder.order_number, amountVnd: 120000, actor: owner, fetcher: async () => { throw new Error('must not call'); } }),
      (e) => e.status === 409 && /Tra cứu trạng thái/.test(e.message)
    );

    // Query resolves ambiguous refund as failed (1081)
    const resolved = await queryMomoRefundStatus(pool, config, amb.refund.id, {
      actor: owner,
      fetcher: async (_url, init) => {
        const b = JSON.parse(init.body);
        return new Response(JSON.stringify({
          partnerCode: b.partnerCode,
          orderId: ambOrder.order_number,
          requestId: b.requestId,
          resultCode: 0,
          message: 'Done',
          responseTime: Date.now(),
          refundTrans: [{ orderId: amb.refund.refundOrderId, amount: 120000, resultCode: 1081, transId: 0, createdTime: Date.now() }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    assert.equal(resolved.refund.status, 'failed');
    assert.equal(resolved.refund.resultCode, '1081');

    // Production environment refuses Sandbox refund
    await assert.rejects(
      initiateMomoRefund(pool, { ...config, NODE_ENV: 'production' }, { orderNumber: ambOrder.order_number, amountVnd: 120000, actor: owner }),
      (e) => e.status === 400
    );

    // Refund success without positive numeric transId or invalid amount must fail closed (PAYMENT_RESPONSE_MISMATCH)
    await assert.rejects(
      refundGatewayPayment('momo', momoAioSettings, {
        originalOrderId: 'GR-20261126-ORIG1',
        refundOrderId: 'RF-20261126-ORIG1-NOID',
        requestId: 'RF-REQ-NOID',
        originalTransId: 4088878653,
        amountVnd: 10000,
        fetcher: async (_u, init) => {
          const b = JSON.parse(init.body);
          return new Response(JSON.stringify({ partnerCode: b.partnerCode, orderId: b.orderId, requestId: b.requestId, amount: b.amount, transId: 0, resultCode: 0 }), { status: 200 });
        }
      }),
      (e) => e.code === 'PAYMENT_RESPONSE_MISMATCH'
    );
    await assert.rejects(
      queryGatewayRefund('momo', momoAioSettings, {
        refundOrderId: 'RF-20261126-ORIG1-NOID',
        amountVnd: 10000,
        fetcher: async (_u, init) => {
          const b = JSON.parse(init.body);
          return new Response(JSON.stringify({
            partnerCode: b.partnerCode, requestId: b.requestId, resultCode: 0,
            refundTrans: [{ orderId: 'RF-20261126-ORIG1-NOID', amount: 'bad', resultCode: 0, transId: 123456 }]
          }), { status: 200 });
        }
      }),
      (e) => e.code === 'PAYMENT_RESPONSE_MISMATCH'
    );

    // Crashed pending_provider refund older than 2 minutes is recovered automatically by reconcileNextMomoRefund
    const crashOrder = await seedPaidOrder({ amountVnd: 80000, transId: '7022233344' });
    const crashed = (await pool.query(
      `INSERT INTO momo_refunds (order_id, order_number, refund_order_id, request_id, original_trans_id, amount_vnd, status, environment, created_by, created_at)
       VALUES ($1, $2, 'RF-CRASH-001', 'REQ-CRASH-001', 7022233344, 80000, 'pending_provider', 'sandbox', 'owner', now() - interval '5 minutes')
       RETURNING id`,
      [crashOrder.id, crashOrder.order_number]
    )).rows[0];
    const recovered = await reconcileNextMomoRefund(pool, config, {
      fetcher: async (_u, init) => {
        const b = JSON.parse(init.body);
        return new Response(JSON.stringify({
          partnerCode: b.partnerCode, orderId: crashOrder.order_number, requestId: b.requestId, resultCode: 0,
          refundTrans: [{ orderId: 'RF-CRASH-001', amount: 80000, resultCode: 0, transId: 888999000, createdTime: Date.now() }]
        }), { status: 200 });
      }
    });
    assert.equal(recovered.checked, true);
    assert.equal(recovered.refund.id, crashed.id);
    assert.equal(recovered.refund.status, 'succeeded');
    assert.equal(recovered.refund.refundTransId, '888999000');

    // Merchant rotation mid-refund-query must abort with PAYMENT_CONFIGURATION_CHANGED
    const rotOrder = await seedPaidOrder({ amountVnd: 90000, transId: '7033344455' });
    const rotRow = (await pool.query(
      `INSERT INTO momo_refunds (order_id, order_number, refund_order_id, request_id, original_trans_id, amount_vnd, status, environment, created_by)
       VALUES ($1, $2, 'RF-ROT-001', 'REQ-ROT-001', 7033344455, 90000, 'ambiguous', 'sandbox', 'owner')
       RETURNING id`,
      [rotOrder.id, rotOrder.order_number]
    )).rows[0];
    await assert.rejects(
      queryMomoRefundStatus(pool, config, rotRow.id, {
        actor: owner,
        fetcher: async (_u, init) => {
          const b = JSON.parse(init.body);
          await writeRecord(pool, config, 'payment_momo', { ...momoAioSettings, partnerCode: 'MOMO_CHANGED_MID_QUERY' }, 1, owner);
          return new Response(JSON.stringify({
            partnerCode: b.partnerCode, orderId: rotOrder.order_number, requestId: b.requestId, resultCode: 0,
            refundTrans: [{ orderId: 'RF-ROT-001', amount: 90000, resultCode: 0, transId: 888999111, createdTime: Date.now() }]
          }), { status: 200 });
        }
      }),
      (e) => e.code === 'PAYMENT_CONFIGURATION_CHANGED'
    );
    await writeRecord(pool, config, 'payment_momo', momoAioSettings, 2, owner);
  });
});
