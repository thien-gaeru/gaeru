const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createStoreApi } = require('../src/store-api');
const { createGatewayPayment, queryGatewayPayment } = require('../src/payment-provider-clients');

function signZaloCallback(dataString, key2) {
  return crypto.createHmac('sha256', key2).update(dataString, 'utf8').digest('hex');
}

test('ZaloPay Payment Gateway v2 - Merchant Acceptance Testing Suite (100% Compliance)', async (suite) => {
  const appId = '2554';
  const key1 = 'zalopay-merchant-key1-secret-create';
  const key2 = 'zalopay-merchant-key2-secret-callback';
  const zaloSettings = {
    appId,
    key1,
    key2,
    environment: 'sandbox',
    enabled: true
  };

  const orders = new Map();
  const attempts = new Map();
  let financeEntry = null;
  let auditLogs = [];

  function seedOrder(orderNumber, amountVnd = 550000, { paymentStatus = 'pending', status = 'pending', attemptStatus = 'pending', appTransId = `261102_${orderNumber}` } = {}) {
    const orderId = orders.size + 1;
    const attemptId = attempts.size + 10;
    const order = { id: orderId, orderNumber, totalVnd: amountVnd, paymentStatus, status, paymentMethod: 'zalopay' };
    const attempt = { id: attemptId, orderId, amountVnd, attemptStatus, providerRequestId: appTransId, providerTransactionId: null, responseCode: null };
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

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api', createStoreApi(
    { connect: async () => mockClient },
    {
      paymentChannels: {
        configs: { zalopay: zaloSettings },
        callbackConfigs: { zalopay: zaloSettings },
        methods: ['zalopay'],
        versions: { zalopay: 1 }
      },
      finance: mockFinance,
      audit: mockAudit
    }
  ));

  const server = app.listen(0, '127.0.0.1');
  suite.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  await suite.test('SC-01: Giao dịch thành công - Phản hồi chuẩn { return_code: 1, return_message: "Confirm Success" }', async () => {
    const orderNumber = 'GR-20261102-ZL01';
    const appTransId = `261102_${orderNumber}`;
    const { order, attempt } = seedOrder(orderNumber, 550000, { appTransId });

    const callbackData = JSON.stringify({
      app_id: Number(appId),
      app_trans_id: appTransId,
      app_time: 1793155200000,
      app_user: 'gaeru',
      amount: 550000,
      embed_data: '{}',
      item: '[]',
      zp_trans_id: 200904000000389,
      server_time: 1793155201000,
      channel: 38
    });
    const mac = signZaloCallback(callbackData, key2);

    const ipnRes = await fetch(`${baseUrl}/payments/zalopay/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: callbackData, mac, type: 1 })
    });

    assert.strictEqual(ipnRes.status, 200);
    const body = await ipnRes.json();
    assert.strictEqual(body.return_code, 1, 'ZaloPay IPN success return_code must be 1');
    assert.strictEqual(body.return_message, 'Confirm Success');
    assert.strictEqual(order.paymentStatus, 'paid');
    assert.strictEqual(order.status, 'processing');
    assert.strictEqual(attempt.attemptStatus, 'paid');
    assert.strictEqual(attempt.providerTransactionId, '200904000000389');
    assert.strictEqual(financeEntry.order.total_vnd, 550000);
  });

  await suite.test('SC-02: Chữ ký MAC không hợp lệ (Signature Tampering)', async () => {
    const orderNumber = 'GR-20261102-ZL02';
    const appTransId = `261102_${orderNumber}`;
    seedOrder(orderNumber, 300000, { appTransId });

    const callbackData = JSON.stringify({
      app_id: Number(appId),
      app_trans_id: appTransId,
      amount: 300000,
      zp_trans_id: 200904000000390
    });
    const forgedMac = '0000000000000000000000000000000000000000000000000000000000000000';

    const ipnRes = await fetch(`${baseUrl}/payments/zalopay/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: callbackData, mac: forgedMac, type: 1 })
    });

    assert.strictEqual(ipnRes.status, 400);
    const body = await ipnRes.json();
    assert.strictEqual(body.return_code, -1);
    assert.match(body.message, /Invalid callback/);
  });

  await suite.test('SC-03: Mismatched app_id (Không đúng mã ứng dụng doanh nghiệp)', async () => {
    const orderNumber = 'GR-20261102-ZL03';
    const appTransId = `261102_${orderNumber}`;
    seedOrder(orderNumber, 200000, { appTransId });

    const callbackData = JSON.stringify({
      app_id: 999999, // Lệch app_id
      app_trans_id: appTransId,
      amount: 200000,
      zp_trans_id: 200904000000391
    });
    const mac = signZaloCallback(callbackData, key2);

    const ipnRes = await fetch(`${baseUrl}/payments/zalopay/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: callbackData, mac, type: 1 })
    });

    assert.strictEqual(ipnRes.status, 400);
    const body = await ipnRes.json();
    assert.strictEqual(body.return_code, -1);
  });

  await suite.test('SC-04: Đơn hàng không tồn tại (Order Not Found)', async () => {
    const callbackData = JSON.stringify({
      app_id: Number(appId),
      app_trans_id: '261102_GR-99999999-NOTFOUND',
      amount: 100000,
      zp_trans_id: 200904000000392
    });
    const mac = signZaloCallback(callbackData, key2);

    const ipnRes = await fetch(`${baseUrl}/payments/zalopay/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: callbackData, mac, type: 1 })
    });

    assert.strictEqual(ipnRes.status, 200);
    const body = await ipnRes.json();
    assert.strictEqual(body.return_code, 0);
    assert.strictEqual(body.return_message, 'Order not found');
  });

  await suite.test('SC-05: Sai lệch số tiền (Amount Tampering)', async () => {
    const orderNumber = 'GR-20261102-ZL05';
    const appTransId = `261102_${orderNumber}`;
    seedOrder(orderNumber, 700000, { appTransId }); // 700.000₫

    const callbackData = JSON.stringify({
      app_id: Number(appId),
      app_trans_id: appTransId,
      amount: 100000, // Lệch số tiền
      zp_trans_id: 200904000000393
    });
    const mac = signZaloCallback(callbackData, key2);

    const ipnRes = await fetch(`${baseUrl}/payments/zalopay/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: callbackData, mac, type: 1 })
    });

    assert.strictEqual(ipnRes.status, 200);
    const body = await ipnRes.json();
    assert.strictEqual(body.return_code, 0);
    assert.strictEqual(body.return_message, 'Invalid amount');
  });

  await suite.test('SC-06: Xử lý IPN trùng lặp (Idempotency) - Phản hồi return_code: 1', async () => {
    const orderNumber = 'GR-20261102-ZL06';
    const appTransId = `261102_${orderNumber}`;
    seedOrder(orderNumber, 400000, {
      appTransId,
      paymentStatus: 'paid',
      attemptStatus: 'paid'
    });

    const callbackData = JSON.stringify({
      app_id: Number(appId),
      app_trans_id: appTransId,
      amount: 400000,
      zp_trans_id: 200904000000394
    });
    const mac = signZaloCallback(callbackData, key2);

    const ipnRes = await fetch(`${baseUrl}/payments/zalopay/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: callbackData, mac, type: 1 })
    });

    assert.strictEqual(ipnRes.status, 200);
    const body = await ipnRes.json();
    assert.strictEqual(body.return_code, 1, 'Idempotent ZaloPay callback must return return_code: 1');
    assert.strictEqual(body.return_message, 'Order already confirmed');
  });

  await suite.test('SC-07: ZaloPay API Client - Tạo đơn hàng v2 /v2/create (Key 1)', async () => {
    let capturedBody = null;
    const mockFetcher = async (url, opts) => {
      if (url.includes('/v2/create')) {
        capturedBody = JSON.parse(opts.body);
        return new Response(JSON.stringify({
          return_code: 1,
          return_message: 'Giao dịch thành công',
          sub_return_code: 1,
          sub_return_message: 'Thành công',
          order_url: 'https://qcgateway.zalopay.vn/pay?order=eyJ6cHRyYW5zdG9rZW4iOiIxMjM0NTYifQ==',
          zp_trans_token: '123456',
          order_token: 'order_token_123'
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await createGatewayPayment('zalopay', zaloSettings, {
      txnRef: 'GR-20261102-ZL07',
      amountVnd: 500000,
      baseUrl: 'https://gaeru.vn',
      fetcher: mockFetcher
    });

    assert.ok(res.paymentUrl.includes('qcgateway.zalopay.vn'));
    assert.strictEqual(capturedBody.app_id, 2554);
    assert.strictEqual(capturedBody.amount, 500000);
    assert.match(capturedBody.app_trans_id, /^\d{6}_GR-20261102-ZL07$/);
    assert.strictEqual(capturedBody.callback_url, 'https://gaeru.vn/api/payments/zalopay/ipn');
    assert.ok(capturedBody.mac && capturedBody.mac.length === 64);
  });

  await suite.test('SC-08: ZaloPay API Client - Tra cứu trạng thái đơn hàng /v2/query (Key 1)', async () => {
    let capturedQuery = null;
    const mockFetcher = async (url, opts) => {
      if (url.includes('/v2/query')) {
        capturedQuery = JSON.parse(opts.body);
        return new Response(JSON.stringify({
          return_code: 1,
          return_message: 'Giao dịch thành công',
          sub_return_code: 1,
          sub_return_message: 'Thành công',
          is_processing: false,
          amount: 500000,
          zp_trans_id: 200904000000399,
          server_time: Date.now()
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Not found', { status: 404 });
    };

    const queryRes = await queryGatewayPayment('zalopay', zaloSettings, {
      txnRef: 'GR-20261102-ZL08',
      amountVnd: 500000,
      fetcher: mockFetcher
    });

    assert.strictEqual(queryRes.successful, true);
    assert.strictEqual(queryRes.resultCode, 1);
    assert.strictEqual(queryRes.amountVnd, 500000);
    assert.strictEqual(capturedQuery.app_id, 2554);
    assert.match(capturedQuery.app_trans_id, /^\d{6}_GR-20261102-ZL08$/);
    assert.ok(capturedQuery.mac && capturedQuery.mac.length === 64);
  });
});
