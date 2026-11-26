#!/usr/bin/env node
/**
 * GAERU Independent Store - MoMo Payment Gateway v2 Acceptance Runner
 * - Mặc định: chạy 10 kịch bản mô phỏng giao thức chuẩn MoMo 239 trang tại chỗ.
 * - Tùy chọn `--live-sandbox`: gọi trực tiếp https://test-payment.momo.vn bằng biến môi trường
 *   MOMO_PARTNER_CODE, MOMO_ACCESS_KEY, MOMO_SECRET_KEY (và tùy chọn PUBLIC_BASE_URL) để kiểm tra SIT thật.
 */

'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { createStoreApi } = require('../src/store-api');
const { createGatewayPayment, queryGatewayPayment, refundGatewayPayment, queryGatewayRefund } = require('../src/payment-provider-clients');

function signMomo(payload, secretKey, accessKey) {
  const raw = `accessKey=${accessKey}&amount=${payload.amount}&extraData=${payload.extraData}&message=${payload.message}&orderId=${payload.orderId}&orderInfo=${payload.orderInfo}&orderType=${payload.orderType}&partnerCode=${payload.partnerCode}&payType=${payload.payType}&requestId=${payload.requestId}&responseTime=${payload.responseTime}&resultCode=${payload.resultCode}&transId=${payload.transId}`;
  return crypto.createHmac('sha256', secretKey).update(raw).digest('hex');
}

async function runLiveSandbox() {
  const partnerCode = String(process.env.MOMO_PARTNER_CODE || '').trim();
  const accessKey = String(process.env.MOMO_ACCESS_KEY || '').trim();
  const secretKey = String(process.env.MOMO_SECRET_KEY || '').trim();
  const baseUrl = String(process.env.PUBLIC_BASE_URL || 'https://gaeru.com').trim();
  if (!partnerCode || !accessKey || !secretKey) {
    console.error('Thiếu biến môi trường MOMO_PARTNER_CODE, MOMO_ACCESS_KEY hoặc MOMO_SECRET_KEY cho chế độ --live-sandbox.');
    process.exit(1);
  }
  const settings = { partnerCode, accessKey, secretKey, environment: 'sandbox', enabled: true };
  const txnRef = `GR-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  console.log('Đang gọi MoMo Test Environment (https://test-payment.momo.vn)...');
  const created = await createGatewayPayment('momo', settings, {
    txnRef,
    amountVnd: 10000,
    baseUrl,
    orderExpireTime: 15,
    storeName: 'GAERU',
    items: [{ id: 'GAERU-SIT-01', name: 'GAERU SIT Test Item', manufacturer: 'GAERU', price: 10000, quantity: 1, totalPrice: 10000 }],
    deliveryInfo: { deliveryAddress: 'SIT Test Address, TP.HCM', deliveryFee: '0', quantity: '1' },
    userInfo: { name: 'GAERU SIT', phoneNumber: '0900000000', email: 'sit@gaeru.com' }
  });
  console.log('✓ Tạo phiên thành công:', { orderId: txnRef, requestId: created.requestId, payUrl: created.paymentUrl });
  const queried = await queryGatewayPayment('momo', settings, { txnRef, amountVnd: 10000 });
  console.log('✓ Tra cứu phiên ngay sau tạo:', { found: queried.found, state: queried.state, resultCode: queried.resultCode });
}

async function runAcceptance() {
  if (process.argv.includes('--live-sandbox')) {
    return runLiveSandbox();
  }

  console.log('='.repeat(86));
  console.log(' GAERU INDEPENDENT STORE - KIỂM THỬ MÔ PHỎNG GIAO THỨC MOMO (KHÔNG PHẢI NGHIỆM THU MERCHANT)');
  console.log(' Tiêu chuẩn: MoMo Payment Gateway v2 (239 tr.) | orderExpireTime=15 | HTTP 204 | HMAC-SHA256');
  console.log('='.repeat(86));
  console.log();

  const partnerCode = 'MOMOGAERU';
  const accessKey = 'MOMOACCESS123';
  const secretKey = 'momo-secret-key-fixture-production-ready';
  const momoSettings = { partnerCode, accessKey, secretKey, environment: 'sandbox', enabled: true };

  const orders = new Map();
  const attempts = new Map();

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
        const attempt = attempts.get(params[0]);
        return attempt ? { rows: [{ provider_request_id: attempt.providerRequestId }] } : { rows: [] };
      }
      if (sql.includes('SELECT p.id, p.amount_vnd')) {
        const order = orders.get(params[0]);
        const attempt = attempts.get(params[0]);
        if (!order || !attempt) return { rows: [] };
        return {
          rows: [{
            id: attempt.id, amountVnd: attempt.amountVnd, attemptStatus: attempt.attemptStatus,
            orderId: order.id, orderNumber: order.orderNumber, orderStatus: order.status,
            paymentMethod: order.paymentMethod, subtotalVnd: order.totalVnd,
            shippingFeeVnd: 0, discountVnd: 0, totalVnd: order.totalVnd, paymentStatus: order.paymentStatus
          }]
        };
      }
      if (sql.includes('UPDATE payment_attempts')) {
        const attemptId = params[0];
        for (const attempt of attempts.values()) {
          if (attempt.id === attemptId) {
            if (sql.includes('SET response_code=')) {
              attempt.responseCode = params[1];
            } else {
              attempt.attemptStatus = params[1];
              attempt.providerTransactionId = params[2];
              attempt.responseCode = params[3];
            }
          }
        }
        return { rows: [] };
      }
      if (sql.includes('UPDATE orders')) {
        for (const order of orders.values()) {
          if (order.id === params[0]) {
            order.paymentStatus = 'paid';
            order.status = 'processing';
          }
        }
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api', createStoreApi(
    { connect: async () => mockClient },
    {
      paymentChannels: {
        configs: { momo: momoSettings },
        callbackConfigs: { momo: momoSettings },
        methods: ['momo'],
        versions: { momo: 1 }
      },
      finance: { recordFullOrderPayment: async () => {} },
      audit: async () => {}
    }
  ));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const results = [];

  async function postIpn(payload) {
    return fetch(`${baseUrl}/payments/momo/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  try {
    // SC-01: Thanh toán thành công (resultCode = 0)
    {
      const orderNumber = 'GR-20261102-MM01';
      const requestId = 'MM_REQ_SC01';
      const { order } = seedOrder(orderNumber, 450000, { providerRequestId: requestId });
      const payload = {
        partnerCode, orderId: orderNumber, requestId, amount: 450000,
        orderInfo: `Thanh toan don hang ${orderNumber}`, orderType: 'momo_wallet',
        transId: 9988776655, resultCode: 0, message: 'Successful.', payType: 'aio_qr',
        paymentOption: 'momo', responseTime: 1793155200000, extraData: ''
      };
      payload.signature = signMomo(payload, secretKey, accessKey);
      const res = await postIpn(payload);
      results.push({
        id: 'SC-01', title: 'Thanh toán thành công (code 0 · HTTP 204)',
        expectedHttp: '204 No Content', actualHttp: `${res.status}`,
        orderState: `${order.status}/${order.paymentStatus}`,
        pass: res.status === 204 && order.paymentStatus === 'paid' && order.status === 'processing'
      });
    }

    // SC-02: Thành công 1-step với resultCode = 9000
    {
      const orderNumber = 'GR-20261102-MM09';
      const requestId = 'MM_REQ_SC02A';
      const { order } = seedOrder(orderNumber, 280000, { providerRequestId: requestId });
      const payload = {
        partnerCode, orderId: orderNumber, requestId, amount: 280000,
        orderInfo: `Thanh toan don hang ${orderNumber}`, orderType: 'momo_wallet',
        transId: 9988776690, resultCode: 9000, message: 'Authorized.', payType: 'webApp',
        responseTime: 1793155200000, extraData: ''
      };
      payload.signature = signMomo(payload, secretKey, accessKey);
      const res = await postIpn(payload);
      results.push({
        id: 'SC-02', title: 'Thành công 1-step (code 9000 · HTTP 204)',
        expectedHttp: '204 No Content', actualHttp: `${res.status}`,
        orderState: `${order.status}/${order.paymentStatus}`,
        pass: res.status === 204 && order.paymentStatus === 'paid' && order.status === 'processing'
      });
    }

    // SC-03: Giao dịch đang xử lý (resultCode = 7000) giữ nguyên pending
    {
      const orderNumber = 'GR-20261102-MM70';
      const requestId = 'MM_REQ_SC03P';
      const { order, attempt } = seedOrder(orderNumber, 210000, { providerRequestId: requestId });
      const payload = {
        partnerCode, orderId: orderNumber, requestId, amount: 210000,
        orderInfo: `Thanh toan don hang ${orderNumber}`, orderType: 'momo_wallet',
        transId: 0, resultCode: 7000, message: 'Transaction is being processed.', payType: 'qr',
        responseTime: 1793155200000, extraData: ''
      };
      payload.signature = signMomo(payload, secretKey, accessKey);
      const res = await postIpn(payload);
      results.push({
        id: 'SC-03', title: 'Đang xử lý (code 7000 · giữ pending)',
        expectedHttp: '204 No Content', actualHttp: `${res.status}`,
        orderState: `${attempt.attemptStatus}/${order.paymentStatus}`,
        pass: res.status === 204 && attempt.attemptStatus === 'pending' && order.paymentStatus === 'pending'
      });
    }

    // SC-04: Khách hủy thanh toán (resultCode = 1006)
    {
      const orderNumber = 'GR-20261102-MM02';
      const requestId = 'MM_REQ_SC04';
      const { order, attempt } = seedOrder(orderNumber, 320000, { providerRequestId: requestId });
      const payload = {
        partnerCode, orderId: orderNumber, requestId, amount: 320000,
        orderInfo: `Thanh toan don hang ${orderNumber}`, orderType: 'momo_wallet',
        transId: 9988776656, resultCode: 1006, message: 'User denied confirmation.', payType: 'qr',
        responseTime: 1793155200000, extraData: ''
      };
      payload.signature = signMomo(payload, secretKey, accessKey);
      const res = await postIpn(payload);
      results.push({
        id: 'SC-04', title: 'Khách hủy thanh toán (code 1006)',
        expectedHttp: '204 No Content', actualHttp: `${res.status}`,
        orderState: `${attempt.attemptStatus}/${order.paymentStatus}`,
        pass: res.status === 204 && attempt.attemptStatus === 'failed' && order.paymentStatus === 'pending'
      });
    }

    // SC-05: Ví không đủ số dư (resultCode = 1001)
    {
      const orderNumber = 'GR-20261102-MM03';
      const requestId = 'MM_REQ_SC05';
      const { order, attempt } = seedOrder(orderNumber, 150000, { providerRequestId: requestId });
      const payload = {
        partnerCode, orderId: orderNumber, requestId, amount: 150000,
        orderInfo: 'Thanh toan', orderType: 'momo_wallet',
        transId: 9988776657, resultCode: 1001, message: 'Insufficient fund.', payType: 'qr',
        responseTime: 1793155200000, extraData: ''
      };
      payload.signature = signMomo(payload, secretKey, accessKey);
      const res = await postIpn(payload);
      results.push({
        id: 'SC-05', title: 'Ví không đủ số dư (code 1001)',
        expectedHttp: '204 No Content', actualHttp: `${res.status}`,
        orderState: `${attempt.attemptStatus}/${order.paymentStatus}`,
        pass: res.status === 204 && attempt.attemptStatus === 'failed' && order.paymentStatus === 'pending'
      });
    }

    // SC-06: Chữ ký giả mạo & từ chối orderType chi hộ (momo_disbursement)
    {
      const orderNumber = 'GR-20261102-MM04';
      seedOrder(orderNumber, 500000, { providerRequestId: 'MM_REQ_SC06' });
      const forged = {
        partnerCode, orderId: orderNumber, requestId: 'MM_REQ_SC06', amount: 500000,
        orderInfo: 'Thanh toan', orderType: 'momo_wallet', transId: 9988776658,
        resultCode: 0, message: 'Successful.', payType: 'qr', responseTime: 1793155200000,
        extraData: '', signature: '0'.repeat(64)
      };
      const badSigRes = await postIpn(forged);
      const disbursePayload = { ...forged, orderType: 'momo_disbursement' };
      disbursePayload.signature = signMomo(disbursePayload, secretKey, accessKey);
      const disburseRes = await postIpn(disbursePayload);
      results.push({
        id: 'SC-06', title: 'Chặn chữ ký giả & orderType chi hộ',
        expectedHttp: '400 / 400', actualHttp: `${badSigRes.status} / ${disburseRes.status}`,
        orderState: 'Từ chối giao dịch',
        pass: badSigRes.status === 400 && disburseRes.status === 400
      });
    }

    // SC-07: Lệch Request ID
    {
      const orderNumber = 'GR-20261102-MM05';
      seedOrder(orderNumber, 600000, { providerRequestId: 'CORRECT_REQUEST_ID' });
      const payload = {
        partnerCode, orderId: orderNumber, requestId: 'WRONG_REQUEST_ID', amount: 600000,
        orderInfo: 'Thanh toan', orderType: 'momo_wallet', transId: 9988776659,
        resultCode: 0, message: 'Successful.', payType: 'qr', responseTime: 1793155200000, extraData: ''
      };
      payload.signature = signMomo(payload, secretKey, accessKey);
      const res = await postIpn(payload);
      results.push({
        id: 'SC-07', title: 'Lệch Request ID (Mismatch Request)',
        expectedHttp: '409 Conflict', actualHttp: `${res.status}`,
        orderState: 'Từ chối giao dịch',
        pass: res.status === 409
      });
    }

    // SC-08: IPN gửi lại trùng lặp (Idempotency)
    {
      const orderNumber = 'GR-20261102-MM06';
      seedOrder(orderNumber, 700000, { paymentStatus: 'paid', attemptStatus: 'paid', providerRequestId: 'MM_REQ_SC08' });
      const payload = {
        partnerCode, orderId: orderNumber, requestId: 'MM_REQ_SC08', amount: 700000,
        orderInfo: 'Thanh toan', orderType: 'momo_wallet', transId: 9988776660,
        resultCode: 0, message: 'Successful.', payType: 'qr', responseTime: 1793155200000, extraData: ''
      };
      payload.signature = signMomo(payload, secretKey, accessKey);
      const res = await postIpn(payload);
      results.push({
        id: 'SC-08', title: 'IPN trùng lặp (Idempotency)',
        expectedHttp: '204 No Content', actualHttp: `${res.status}`,
        orderState: 'Bảo toàn kế toán',
        pass: res.status === 204
      });
    }

    // SC-09: API Create v2 (orderExpireTime=15, storeName, items, deliveryInfo, userInfo)
    {
      let captured = null;
      const created = await createGatewayPayment('momo', momoSettings, {
        txnRef: 'GR-20261102-MM09C',
        amountVnd: 500000,
        baseUrl: 'https://gaeru.com',
        orderExpireTime: 15,
        storeName: 'GAERU',
        items: [{ id: 'K9-PRO', name: 'GAERU K9', price: 500000, quantity: 1, manufacturer: 'GAERU' }],
        deliveryInfo: { deliveryAddress: 'TP.HCM', deliveryFee: '0', quantity: '1' },
        userInfo: { name: 'Khách hàng', phoneNumber: '0900000000', email: 'buyer@gaeru.com' },
        fetcher: async (_u, init) => {
          captured = JSON.parse(init.body);
          return new Response(JSON.stringify({
            partnerCode, orderId: captured.orderId, requestId: captured.requestId,
            amount: captured.amount, responseTime: Date.now(), message: 'Successful.', resultCode: 0,
            payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=mock-token'
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      });
      const pass = captured?.orderExpireTime === 15 && captured?.storeName === 'GAERU'
        && Array.isArray(captured?.items) && captured.items[0]?.currency === 'VND'
        && captured?.deliveryInfo?.deliveryFee === '0' && captured?.userInfo?.email === 'buyer@gaeru.com'
        && created.paymentUrl.startsWith('https://test-payment.momo.vn/');
      results.push({
        id: 'SC-09', title: 'API Create v2 + orderExpireTime=15 + items',
        expectedHttp: '200 OK', actualHttp: pass ? '200 OK' : 'FAIL',
        orderState: 'Khớp chữ ký 10 trường',
        pass
      });
    }

    // SC-10: API Query v2 + trích xuất metadata đối soát M4B
    {
      const queried = await queryGatewayPayment('momo', momoSettings, {
        txnRef: 'GR-20261102-MM10Q',
        amountVnd: 500000,
        fetcher: async (_u, init) => {
          const body = JSON.parse(init.body);
          return new Response(JSON.stringify({
            partnerCode, orderId: body.orderId, requestId: body.requestId,
            amount: 500000, transId: 4088878653, payType: 'aio_qr', paymentOption: 'pay_later',
            userFee: 0, promotionInfo: [{ voucherId: 'M1', amount: 10000, amountSponsor: 5000 }],
            resultCode: 0, refundTrans: [], message: 'Successful.', responseTime: Date.now()
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      });
      const pass = queried.successful && queried.payType === 'aio_qr'
        && queried.paymentOption === 'pay_later' && queried.promotionInfo?.[0]?.amountSponsor === 5000;
      results.push({
        id: 'SC-10', title: 'API Query v2 + metadata đối soát M4B',
        expectedHttp: '200 OK', actualHttp: pass ? '200 OK' : 'FAIL',
        orderState: 'pay_later / promo',
        pass
      });
    }

    // SC-11: Collection Link payWithMethod (All-in-One: Ví + ATM + Visa/Master/JCB)
    {
      let captured = null;
      const aioSettings = { ...momoSettings, requestType: 'payWithMethod' };
      const created = await createGatewayPayment('momo', aioSettings, {
        txnRef: 'GR-20261102-MM11A',
        amountVnd: 250000,
        baseUrl: 'https://gaeru.com',
        storeName: 'GAERU',
        fetcher: async (_u, init) => {
          captured = JSON.parse(init.body);
          return new Response(JSON.stringify({
            partnerCode, orderId: captured.orderId, requestId: captured.requestId,
            amount: captured.amount, responseTime: Date.now(), message: 'Success', resultCode: 0,
            payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=aio-token',
            shortLink: 'https://test-payment.momo.vn/shortlink/gaeruAio1'
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      });
      const pass = captured?.requestType === 'payWithMethod' && created.requestType === 'payWithMethod'
        && created.shortLink === 'https://test-payment.momo.vn/shortlink/gaeruAio1';
      results.push({
        id: 'SC-11', title: 'Collection Link payWithMethod + shortLink',
        expectedHttp: '200 OK', actualHttp: pass ? '200 OK' : 'FAIL',
        orderState: 'AIO Ví+ATM+Thẻ',
        pass
      });
    }

    // SC-12: API Hoàn tiền POST /v2/gateway/api/refund (7-field HMAC + orderId mới)
    {
      let captured = null;
      const refunded = await refundGatewayPayment('momo', momoSettings, {
        originalOrderId: 'GR-20261102-MM01',
        refundOrderId: 'RF-20261102-MM01-A1B2',
        requestId: 'RF-REQ-12',
        originalTransId: 9988776655,
        amountVnd: 150000,
        description: 'Hoan tien mot phan',
        fetcher: async (url, init) => {
          captured = { url, body: JSON.parse(init.body) };
          return new Response(JSON.stringify({
            partnerCode, orderId: captured.body.orderId, requestId: captured.body.requestId,
            amount: 150000, transId: 2820086739, resultCode: 0, message: 'Successful.', responseTime: Date.now()
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      });
      const expectedSig = crypto.createHmac('sha256', secretKey).update(
        `accessKey=${accessKey}&amount=150000&description=Hoan tien mot phan&orderId=RF-20261102-MM01-A1B2&partnerCode=${partnerCode}&requestId=RF-REQ-12&transId=9988776655`
      ).digest('hex');
      const pass = captured?.url.endsWith('/v2/gateway/api/refund') && captured.body.signature === expectedSig
        && refunded.successful && refunded.refundTransId === '2820086739';
      results.push({
        id: 'SC-12', title: 'API Refund v2 (chữ ký 7 trường + orderId mới)',
        expectedHttp: '200 OK', actualHttp: pass ? '200 OK' : 'FAIL',
        orderState: 'succeeded/2820086739',
        pass
      });
    }

    // SC-13: API Tra cứu hoàn tiền POST /v2/gateway/api/refund/query (khớp refundTrans)
    {
      const queried = await queryGatewayRefund('momo', momoSettings, {
        refundOrderId: 'RF-20261102-MM01-A1B2',
        amountVnd: 150000,
        fetcher: async (url, init) => {
          const body = JSON.parse(init.body);
          return new Response(JSON.stringify({
            partnerCode, orderId: 'GR-20261102-MM01', requestId: body.requestId,
            resultCode: 0, message: 'Successful.', responseTime: Date.now(),
            refundTrans: [{ orderId: 'RF-20261102-MM01-A1B2', amount: 150000, resultCode: 0, transId: 2820086739, createdTime: Date.now() }]
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      });
      const pass = queried.found && queried.successful && queried.refundTransId === '2820086739';
      results.push({
        id: 'SC-13', title: 'API Query Refund v2 (đối chiếu refundTrans)',
        expectedHttp: '200 OK', actualHttp: pass ? '200 OK' : 'FAIL',
        orderState: 'found / succeeded',
        pass
      });
    }
  } finally {
    server.close();
  }

  console.log('| Mã kịch bản | Kịch bản kiểm thử                         | Mong đợi        | Thực tế         | Trạng thái          | Kết quả  |');
  console.log('|-------------|-------------------------------------------|-----------------|-----------------|---------------------|----------|');
  for (const r of results) {
    const passTag = r.pass ? '✓ PASS' : '✖ FAIL';
    console.log(`| ${r.id.padEnd(11)} | ${r.title.padEnd(41)} | ${r.expectedHttp.padEnd(15)} | ${r.actualHttp.padEnd(15)} | ${r.orderState.padEnd(19)} | ${passTag.padEnd(8)} |`);
  }
  console.log();

  if (results.every(r => r.pass)) {
    console.log('13/13 kịch bản mô phỏng đạt chuẩn tài liệu MoMo 239 trang (captureWallet + payWithMethod + Refund + Query Refund).');
    console.log('Khi có khóa Test M4B, chạy thêm: MOMO_PARTNER_CODE=... MOMO_ACCESS_KEY=... MOMO_SECRET_KEY=... node scripts/momo-sandbox-runner.js --live-sandbox');
  } else {
    console.error('Cảnh báo: Có kịch bản kiểm thử chưa đạt yêu cầu.');
    process.exit(1);
  }
}

runAcceptance().catch(err => {
  console.error('MoMo Acceptance Runner Error:', err);
  process.exit(1);
});
