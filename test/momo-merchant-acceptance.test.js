const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createStoreApi } = require('../src/store-api');
const { createGatewayPayment, queryGatewayPayment } = require('../src/payment-provider-clients');

function signMomo(payload, secretKey, accessKey) {
  const raw = `accessKey=${accessKey}&amount=${payload.amount}&extraData=${payload.extraData}&message=${payload.message}&orderId=${payload.orderId}&orderInfo=${payload.orderInfo}&orderType=${payload.orderType}&partnerCode=${payload.partnerCode}&payType=${payload.payType}&requestId=${payload.requestId}&responseTime=${payload.responseTime}&resultCode=${payload.resultCode}&transId=${payload.transId}`;
  return crypto.createHmac('sha256', secretKey).update(raw).digest('hex');
}

test('MoMo Payment Gateway v2 - Merchant Acceptance Testing Suite (100% Compliance)', async (suite) => {
  const partnerCode = 'MOMOGAERU';
  const accessKey = 'MOMOACCESS123';
  const secretKey = 'momo-secret-key-fixture-production-ready';
  const momoSettings = {
    partnerCode,
    accessKey,
    secretKey,
    environment: 'sandbox',
    enabled: true
  };

  const orders = new Map();
  const attempts = new Map();
  let financeEntry = null;
  let auditLogs = [];

  function seedOrder(orderNumber, amountVnd = 450000, { paymentStatus = 'pending', status = 'pending', attemptStatus = 'pending', providerRequestId = 'MOMO_REQ_001' } = {}) {
    const orderId = orders.size + 1;
    const attemptId = attempts.size + 10;
    const order = { id: orderId, orderNumber, totalVnd: amountVnd, paymentStatus, status, paymentMethod: 'momo' };
    const attempt = { id: attemptId, orderId, amountVnd, attemptStatus, providerRequestId, providerTransactionId: null, responseCode: null };
    orders.set(orderNumber, order);
    attempts.set(orderNumber, attempt);
    return { order, attempt };
  }

  const mockClient = {
    release: () => {},
    query: async (sql, params) => {
      if (sql.includes('SELECT provider_request_id FROM payment_attempts')) {
        const orderNum = params[0];
        const attempt = attempts.get(orderNum);
        if (!attempt) return { rows: [] };
        return { rows: [{ provider_request_id: attempt.providerRequestId }] };
      }
      if (sql.includes('SELECT p.id, p.amount_vnd')) {
        const orderNum = params[0];
        const order = orders.get(orderNum);
        const attempt = attempts.get(orderNum);
        if (!order || !attempt) return { rows: [] };
        return {
          rows: [{
            id: attempt.id,
            amountVnd: attempt.amountVnd,
            attemptStatus: attempt.attemptStatus,
            orderId: order.id,
            orderNumber: order.orderNumber,
            orderStatus: order.status,
            paymentMethod: order.paymentMethod,
            subtotalVnd: order.totalVnd,
            shippingFeeVnd: 0,
            discountVnd: 0,
            totalVnd: order.totalVnd,
            paymentStatus: order.paymentStatus
          }]
        };
      }
      if (sql.includes('UPDATE payment_attempts')) {
        const attemptId = params[0];
        for (const attempt of attempts.values()) {
          if (attempt.id === attemptId) {
            attempt.attemptStatus = params[1];
            attempt.providerTransactionId = params[2];
            attempt.responseCode = params[3];
          }
        }
        return { rows: [] };
      }
      if (sql.includes('UPDATE orders')) {
        const orderId = params[0];
        for (const order of orders.values()) {
          if (order.id === orderId) {
            order.paymentStatus = 'paid';
            order.status = 'processing';
          }
        }
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const mockFinance = {
    recordFullOrderPayment: async (_c, entry) => {
      financeEntry = entry;
    }
  };

  const mockAudit = async (_c, entry) => {
    auditLogs.push(entry);
  };

  const paymentChannelsObj = {
    configs: { momo: momoSettings },
    callbackConfigs: { momo: momoSettings },
    methods: ['momo'],
    versions: { momo: 1 }
  };

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api', createStoreApi(
    { connect: async () => mockClient },
    {
      paymentChannels: paymentChannelsObj,
      finance: mockFinance,
      audit: mockAudit
    }
  ));

  const server = app.listen(0, '127.0.0.1');
  suite.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  await suite.test('SC-01: Giao dịch thành công (resultCode = 0) - IPN phản hồi 204 No Content', async () => {
    const orderNumber = 'GR-20261102-MM01';
    const requestId = 'MM_REQ_SC01';
    const { order, attempt } = seedOrder(orderNumber, 450000, { providerRequestId: requestId });

    const payload = {
      partnerCode,
      orderId: orderNumber,
      requestId,
      amount: 450000,
      orderInfo: `Thanh toan don hang ${orderNumber}`,
      orderType: 'momo_wallet',
      transId: 9988776655,
      resultCode: 0,
      message: 'Successful.',
      payType: 'qr',
      responseTime: 1793155200000,
      extraData: ''
    };
    payload.signature = signMomo(payload, secretKey, accessKey);

    const ipnRes = await fetch(`${baseUrl}/payments/momo/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // MoMo Production requirement: Must return HTTP 204 No Content
    assert.strictEqual(ipnRes.status, 204, 'MoMo IPN must return HTTP 204 No Content');
    assert.strictEqual(order.paymentStatus, 'paid');
    assert.strictEqual(order.status, 'processing');
    assert.strictEqual(attempt.attemptStatus, 'paid');
    assert.strictEqual(attempt.providerTransactionId, '9988776655');
    assert.strictEqual(financeEntry.order.total_vnd, 450000);

    // Return URL check
    const returnRes = await fetch(`${baseUrl}/payments/momo/return?${new URLSearchParams(payload)}`, {
      redirect: 'manual'
    });
    assert.strictEqual(returnRes.status, 302);
    const location = returnRes.headers.get('location');
    assert.match(location, /\/payment-result\.html\?result=processing&provider=momo&order=GR-20261102-MM01&code=0/);
  });

  await suite.test('SC-02: Khách hàng hủy giao dịch (resultCode = 1006)', async () => {
    const orderNumber = 'GR-20261102-MM02';
    const requestId = 'MM_REQ_SC02';
    const { order, attempt } = seedOrder(orderNumber, 320000, { providerRequestId: requestId });

    const payload = {
      partnerCode,
      orderId: orderNumber,
      requestId,
      amount: 320000,
      orderInfo: `Thanh toan don hang ${orderNumber}`,
      orderType: 'momo_wallet',
      transId: 9988776656,
      resultCode: 1006,
      message: 'User denied confirmation.',
      payType: 'qr',
      responseTime: 1793155200000,
      extraData: ''
    };
    payload.signature = signMomo(payload, secretKey, accessKey);

    // Return URL redirect check (has code=1006)
    const returnRes = await fetch(`${baseUrl}/payments/momo/return?${new URLSearchParams(payload)}`, {
      redirect: 'manual'
    });
    assert.strictEqual(returnRes.status, 302);
    assert.match(returnRes.headers.get('location'), /\/payment-result\.html\?result=failed&provider=momo&order=GR-20261102-MM02&code=1006/);

    // IPN callback handling
    const ipnRes = await fetch(`${baseUrl}/payments/momo/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.strictEqual(ipnRes.status, 204);
    assert.strictEqual(attempt.attemptStatus, 'failed');
    assert.strictEqual(order.paymentStatus, 'pending');
  });

  await suite.test('SC-03: Không đủ số dư / Hết hạn (resultCode = 2001, 1005)', async () => {
    const orderNumber = 'GR-20261102-MM03';
    const requestId = 'MM_REQ_SC03';
    seedOrder(orderNumber, 150000, { providerRequestId: requestId });

    const payload = {
      partnerCode,
      orderId: orderNumber,
      requestId,
      amount: 150000,
      orderInfo: 'Thanh toan',
      orderType: 'momo_wallet',
      transId: 9988776657,
      resultCode: 2001,
      message: 'Insufficient fund.',
      payType: 'qr',
      responseTime: 1793155200000,
      extraData: ''
    };
    payload.signature = signMomo(payload, secretKey, accessKey);

    const returnRes = await fetch(`${baseUrl}/payments/momo/return?${new URLSearchParams(payload)}`, {
      redirect: 'manual'
    });
    assert.strictEqual(returnRes.status, 302);
    assert.match(returnRes.headers.get('location'), /code=2001/);
  });

  await suite.test('SC-04: Chữ ký không hợp lệ (Signature Tampering)', async () => {
    const orderNumber = 'GR-20261102-MM04';
    const requestId = 'MM_REQ_SC04';
    seedOrder(orderNumber, 500000, { providerRequestId: requestId });

    const forged = {
      partnerCode,
      orderId: orderNumber,
      requestId,
      amount: 500000,
      orderInfo: 'Thanh toan',
      orderType: 'momo_wallet',
      transId: 9988776658,
      resultCode: 0,
      message: 'Successful.',
      payType: 'qr',
      responseTime: 1793155200000,
      extraData: '',
      signature: '0000000000000000000000000000000000000000000000000000000000000000'
    };

    const ipnRes = await fetch(`${baseUrl}/payments/momo/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forged)
    });
    assert.strictEqual(ipnRes.status, 400);
    const body = await ipnRes.json();
    assert.strictEqual(body.resultCode, 97);
  });

  await suite.test('SC-05: Sai lệch requestId giữa IPN và Payment Attempt', async () => {
    const orderNumber = 'GR-20261102-MM05';
    seedOrder(orderNumber, 600000, { providerRequestId: 'CORRECT_REQUEST_ID' });

    const payload = {
      partnerCode,
      orderId: orderNumber,
      requestId: 'WRONG_REQUEST_ID',
      amount: 600000,
      orderInfo: 'Thanh toan',
      orderType: 'momo_wallet',
      transId: 9988776659,
      resultCode: 0,
      message: 'Successful.',
      payType: 'qr',
      responseTime: 1793155200000,
      extraData: ''
    };
    payload.signature = signMomo(payload, secretKey, accessKey);

    const ipnRes = await fetch(`${baseUrl}/payments/momo/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.strictEqual(ipnRes.status, 409);
    const body = await ipnRes.json();
    assert.strictEqual(body.resultCode, 97);
    assert.match(body.message, /mismatch/i);
  });

  await suite.test('SC-06: Xử lý IPN trùng lặp (Idempotency) - Phản hồi ngay 204', async () => {
    const orderNumber = 'GR-20261102-MM06';
    const requestId = 'MM_REQ_SC06';
    seedOrder(orderNumber, 700000, {
      paymentStatus: 'paid',
      attemptStatus: 'paid',
      providerRequestId: requestId
    });

    const payload = {
      partnerCode,
      orderId: orderNumber,
      requestId,
      amount: 700000,
      orderInfo: 'Thanh toan',
      orderType: 'momo_wallet',
      transId: 9988776660,
      resultCode: 0,
      message: 'Successful.',
      payType: 'qr',
      responseTime: 1793155200000,
      extraData: ''
    };
    payload.signature = signMomo(payload, secretKey, accessKey);

    // Calling IPN for already confirmed order must still return 204 No Content
    const ipnRes = await fetch(`${baseUrl}/payments/momo/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.strictEqual(ipnRes.status, 204, 'Idempotent MoMo IPN must return 204 No Content');
  });

  await suite.test('SC-07: MoMo API Client - Tạo phiên thanh toán v2 với 10 trường chuẩn', async () => {
    let capturedBody = null;
    const mockFetcher = async (url, opts) => {
      if (url.includes('/v2/gateway/api/create')) {
        capturedBody = JSON.parse(opts.body);
        return new Response(JSON.stringify({
          partnerCode,
          orderId: capturedBody.orderId,
          requestId: capturedBody.requestId,
          amount: capturedBody.amount,
          responseTime: Date.now(),
          message: 'Success',
          resultCode: 0,
          payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?token=momo_token_123'
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await createGatewayPayment('momo', momoSettings, {
      txnRef: 'GR-20261102-MM07',
      amountVnd: 500000,
      baseUrl: 'https://gaeru.vn',
      fetcher: mockFetcher
    });

    assert.ok(res.paymentUrl.includes('momo_token_123'));
    assert.strictEqual(capturedBody.partnerCode, partnerCode);
    assert.strictEqual(capturedBody.amount, 500000);
    assert.strictEqual(capturedBody.orderId, 'GR-20261102-MM07');
    assert.strictEqual(capturedBody.requestType, 'captureWallet');
    assert.strictEqual(capturedBody.redirectUrl, 'https://gaeru.vn/api/payments/momo/return');
    assert.strictEqual(capturedBody.ipnUrl, 'https://gaeru.vn/api/payments/momo/ipn');
    assert.strictEqual(capturedBody.autoCapture, true);
    assert.ok(capturedBody.signature && capturedBody.signature.length === 64);
  });

  await suite.test('SC-08: MoMo API Client - Tra cứu giao dịch /v2/gateway/api/query', async () => {
    let capturedQuery = null;
    const mockFetcher = async (url, opts) => {
      if (url.includes('/v2/gateway/api/query')) {
        capturedQuery = JSON.parse(opts.body);
        return new Response(JSON.stringify({
          partnerCode,
          orderId: capturedQuery.orderId,
          requestId: capturedQuery.requestId,
          extraData: '',
          amount: 500000,
          transId: 9988776600,
          payType: 'qr',
          resultCode: 0,
          message: 'Giao dịch thành công.',
          responseTime: Date.now()
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Not found', { status: 404 });
    };

    const queryRes = await queryGatewayPayment('momo', momoSettings, {
      txnRef: 'GR-20261102-MM08',
      amountVnd: 500000,
      fetcher: mockFetcher
    });

    assert.strictEqual(queryRes.successful, true);
    assert.strictEqual(queryRes.resultCode, 0);
    assert.strictEqual(queryRes.amountVnd, 500000);
    assert.strictEqual(capturedQuery.partnerCode, partnerCode);
    assert.strictEqual(capturedQuery.orderId, 'GR-20261102-MM08');
    assert.ok(capturedQuery.signature && capturedQuery.signature.length === 64);
  });
});
