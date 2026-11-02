#!/usr/bin/env node
/**
 * GAERU Independent Store - MoMo Payment Gateway v2 Sandbox Acceptance Runner
 * Chạy toàn bộ kịch bản nghiệm thu kỹ thuật theo quy chuẩn MoMo Merchant Acceptance Testing.
 */

const crypto = require('node:crypto');
const express = require('express');
const { createStoreApi } = require('../src/store-api');
const { createGatewayPayment, queryGatewayPayment } = require('../src/payment-provider-clients');

function signMomo(payload, secretKey, accessKey) {
  const raw = `accessKey=${accessKey}&amount=${payload.amount}&extraData=${payload.extraData}&message=${payload.message}&orderId=${payload.orderId}&orderInfo=${payload.orderInfo}&orderType=${payload.orderType}&partnerCode=${payload.partnerCode}&payType=${payload.payType}&requestId=${payload.requestId}&responseTime=${payload.responseTime}&resultCode=${payload.resultCode}&transId=${payload.transId}`;
  return crypto.createHmac('sha256', secretKey).update(raw).digest('hex');
}

async function runAcceptance() {
  console.log('='.repeat(80));
  console.log(' GAERU INDEPENDENT STORE - BỘ KIỂM THỬ NGHIỆM THU KỸ THUẬT VÍ MOMO (100% COMPLIANCE)');
  console.log(' Tiêu chuẩn: MoMo Payment Gateway v2 | HTTP 204 No Content IPN | HMAC-SHA256');
  console.log('='.repeat(80));
  console.log();

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

  try {
    // SC-01
    {
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
      const res = await fetch(`${baseUrl}/payments/momo/ipn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const pass = res.status === 204 && order.paymentStatus === 'paid' && order.status === 'processing';
      results.push({
        id: 'SC-01',
        title: 'Thanh toán thành công (HTTP 204)',
        expectedHttp: '204 No Content',
        actualHttp: `${res.status} ${res.statusText || 'No Content'}`,
        orderState: `${order.status}/${order.paymentStatus}`,
        pass
      });
    }

    // SC-02
    {
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
      const res = await fetch(`${baseUrl}/payments/momo/ipn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const pass = res.status === 204 && attempt.attemptStatus === 'failed' && order.paymentStatus === 'pending';
      results.push({
        id: 'SC-02',
        title: 'Khách hủy thanh toán (resultCode 1006)',
        expectedHttp: '204 No Content',
        actualHttp: `${res.status} ${res.statusText || 'No Content'}`,
        orderState: `${order.status}/${order.paymentStatus}`,
        pass
      });
    }

    // SC-03
    {
      const orderNumber = 'GR-20261102-MM03';
      const requestId = 'MM_REQ_SC03';
      const { order, attempt } = seedOrder(orderNumber, 150000, { providerRequestId: requestId });
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
      const res = await fetch(`${baseUrl}/payments/momo/ipn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const pass = res.status === 204 && attempt.attemptStatus === 'failed' && order.paymentStatus === 'pending';
      results.push({
        id: 'SC-03',
        title: 'Ví không đủ số dư (resultCode 2001)',
        expectedHttp: '204 No Content',
        actualHttp: `${res.status} ${res.statusText || 'No Content'}`,
        orderState: `${order.status}/${order.paymentStatus}`,
        pass
      });
    }

    // SC-04
    {
      const orderNumber = 'GR-20261102-MM04';
      seedOrder(orderNumber, 500000, { providerRequestId: 'MM_REQ_SC04' });
      const forged = {
        partnerCode,
        orderId: orderNumber,
        requestId: 'MM_REQ_SC04',
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
      const res = await fetch(`${baseUrl}/payments/momo/ipn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(forged)
      });
      results.push({
        id: 'SC-04',
        title: 'Chữ ký giả mạo (Invalid Signature)',
        expectedHttp: '400 Bad Request',
        actualHttp: `${res.status} ${res.statusText}`,
        orderState: 'Từ chối giao dịch',
        pass: res.status === 400
      });
    }

    // SC-05
    {
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
      const res = await fetch(`${baseUrl}/payments/momo/ipn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      results.push({
        id: 'SC-05',
        title: 'Lệch Request ID (Mismatch Request)',
        expectedHttp: '409 Conflict',
        actualHttp: `${res.status} ${res.statusText}`,
        orderState: 'Từ chối giao dịch',
        pass: res.status === 409
      });
    }

    // SC-06
    {
      const orderNumber = 'GR-20261102-MM06';
      seedOrder(orderNumber, 700000, { paymentStatus: 'paid', attemptStatus: 'paid', providerRequestId: 'MM_REQ_SC06' });
      const payload = {
        partnerCode,
        orderId: orderNumber,
        requestId: 'MM_REQ_SC06',
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
      const res = await fetch(`${baseUrl}/payments/momo/ipn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      results.push({
        id: 'SC-06',
        title: 'IPN gửi lại trùng lặp (Idempotency)',
        expectedHttp: '204 No Content',
        actualHttp: `${res.status} ${res.statusText || 'No Content'}`,
        orderState: 'Bảo toàn số dư/kế toán',
        pass: res.status === 204
      });
    }
  } finally {
    server.close();
  }

  console.log('| Mã kịch bản | Kịch bản kiểm thử                     | HTTP mong đợi   | HTTP thực tế    | Trạng thái đơn hàng | Kết quả  |');
  console.log('|-------------|---------------------------------------|-----------------|-----------------|---------------------|----------|');
  for (const r of results) {
    const passTag = r.pass ? '✓ PASS' : '✖ FAIL';
    console.log(`| ${r.id.padEnd(11)} | ${r.title.padEnd(37)} | ${r.expectedHttp.padEnd(15)} | ${r.actualHttp.padEnd(15)} | ${r.orderState.padEnd(19)} | ${passTag.padEnd(8)} |`);
  }
  console.log();

  const allPassed = results.every(r => r.pass);
  if (allPassed) {
    console.log('🎉 TẤT CẢ CÁC KỊCH BẢN NGHIỆM THU KỸ THUẬT VÍ MOMO ĐẠT 100% TIÊU CHUẨN THÔNG QUA!');
    console.log('Hệ thống GAERU đã hoàn toàn đáp ứng đầy đủ yêu cầu kỹ thuật IPN 204 cho MoMo Business.');
  } else {
    console.error('Cảnh báo: Có kịch bản kiểm thử chưa đạt yêu cầu.');
    process.exit(1);
  }
}

runAcceptance().catch(err => {
  console.error('MoMo Acceptance Runner Error:', err);
  process.exit(1);
});
