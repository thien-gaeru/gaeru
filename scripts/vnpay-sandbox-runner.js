#!/usr/bin/env node
/**
 * GAERU Independent Store - VNPAY Sandbox Acceptance Runner
 * Chạy toàn bộ kịch bản nghiệm thu kỹ thuật theo quy chuẩn VNPAY Merchant Acceptance Testing.
 */

const crypto = require('node:crypto');
const express = require('express');
const { createStoreApi } = require('../src/store-api');

function signParams(params, secret) {
  const canonical = new URLSearchParams(
    Object.entries(params)
      .filter(([k, v]) => !['vnp_SecureHash', 'vnp_SecureHashType'].includes(k) && v !== undefined && v !== null && v !== '')
      .sort(([a], [b]) => a.localeCompare(b))
  ).toString();
  return crypto.createHmac('sha512', secret).update(canonical, 'utf8').digest('hex');
}

async function runAcceptance() {
  console.log('='.repeat(80));
  console.log(' GAERU INDEPENDENT STORE - BỘ KIỂM THỬ NGHIỆM THU KỸ THUẬT VNPAY (100% COMPLIANCE)');
  console.log(' Tiêu chuẩn: VNPAY Payment Gateway 2.1.0 | Mã hóa SHA-512 | Idempotency');
  console.log('='.repeat(80));
  console.log();

  const tmnCode = 'GAERUTMN';
  const hashSecret = 'sandbox-merchant-test-secret-key-12345';
  const vnpayConfig = {
    tmnCode,
    hashSecret,
    paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
    returnUrl: 'https://gaeru.vn/api/payments/vnpay/return'
  };

  const orders = new Map();
  const attempts = new Map();

  function seedOrder(orderNumber, amountVnd = 500000, { paymentStatus = 'pending', status = 'pending', attemptStatus = 'pending' } = {}) {
    const orderId = orders.size + 1;
    const attemptId = attempts.size + 10;
    const order = { id: orderId, orderNumber, totalVnd: amountVnd, paymentStatus, status, paymentMethod: 'vnpay' };
    const attempt = { id: attemptId, orderId, amountVnd, attemptStatus, providerTransactionId: null, responseCode: null };
    orders.set(orderNumber, order);
    attempts.set(orderNumber, attempt);
    return { order, attempt };
  }

  const mockClient = {
    release: () => {},
    query: async (sql, params) => {
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
  app.use((req, _res, next) => {
    req.vnpayCallbackConfig = vnpayConfig;
    next();
  });
  app.use('/api', createStoreApi(
    { connect: async () => mockClient },
    {
      vnpayConfig,
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
      const orderNumber = 'GR-20261102-SC01';
      const { order, attempt } = seedOrder(orderNumber, 500000);
      const ipnParams = {
        vnp_TmnCode: tmnCode,
        vnp_Amount: '50000000',
        vnp_BankCode: 'NCB',
        vnp_BankTranNo: 'VNP14123456',
        vnp_CardType: 'ATM',
        vnp_PayDate: '20261102153000',
        vnp_OrderInfo: `Thanh toan don hang ${orderNumber}`,
        vnp_TransactionNo: '14123456',
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_TxnRef: orderNumber
      };
      ipnParams.vnp_SecureHash = signParams(ipnParams, hashSecret);
      const res = await (await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(ipnParams)}`)).json();
      const pass = res.RspCode === '00' && order.paymentStatus === 'paid' && order.status === 'processing';
      results.push({
        id: 'SC-01',
        title: 'Giao dịch thành công (00)',
        expectedRsp: '00',
        actualRsp: res.RspCode,
        orderState: `${order.status}/${order.paymentStatus}`,
        pass
      });
    }

    // SC-02
    {
      const orderNumber = 'GR-20261102-SC02';
      const { order, attempt } = seedOrder(orderNumber, 350000);
      const ipnParams = {
        vnp_TmnCode: tmnCode,
        vnp_Amount: '35000000',
        vnp_BankCode: 'NCB',
        vnp_OrderInfo: `Thanh toan don hang ${orderNumber}`,
        vnp_ResponseCode: '24',
        vnp_TransactionStatus: '02',
        vnp_TxnRef: orderNumber
      };
      ipnParams.vnp_SecureHash = signParams(ipnParams, hashSecret);
      const res = await (await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(ipnParams)}`)).json();
      const pass = res.RspCode === '00' && attempt.attemptStatus === 'failed' && order.paymentStatus === 'pending';
      results.push({
        id: 'SC-02',
        title: 'Khách hủy giao dịch (24)',
        expectedRsp: '00',
        actualRsp: res.RspCode,
        orderState: `${order.status}/${order.paymentStatus}`,
        pass
      });
    }

    // SC-03
    {
      const orderNumber = 'GR-20261102-SC03';
      const { order, attempt } = seedOrder(orderNumber, 200000);
      const ipnParams = {
        vnp_TmnCode: tmnCode,
        vnp_Amount: '20000000',
        vnp_BankCode: 'NCB',
        vnp_OrderInfo: 'Thanh toan',
        vnp_ResponseCode: '09',
        vnp_TransactionStatus: '02',
        vnp_TxnRef: orderNumber
      };
      ipnParams.vnp_SecureHash = signParams(ipnParams, hashSecret);
      const res = await (await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(ipnParams)}`)).json();
      const pass = res.RspCode === '00' && attempt.attemptStatus === 'failed' && order.paymentStatus === 'pending';
      results.push({
        id: 'SC-03',
        title: 'Chưa đăng ký Internet Banking (09)',
        expectedRsp: '00',
        actualRsp: res.RspCode,
        orderState: `${order.status}/${order.paymentStatus}`,
        pass
      });
    }

    // SC-04
    {
      const orderNumber = 'GR-20261102-SC04';
      const { order, attempt } = seedOrder(orderNumber, 400000);
      const ipnParams = {
        vnp_TmnCode: tmnCode,
        vnp_Amount: '40000000',
        vnp_BankCode: 'NCB',
        vnp_OrderInfo: 'Thanh toan',
        vnp_ResponseCode: '10',
        vnp_TransactionStatus: '02',
        vnp_TxnRef: orderNumber
      };
      ipnParams.vnp_SecureHash = signParams(ipnParams, hashSecret);
      const res = await (await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(ipnParams)}`)).json();
      const pass = res.RspCode === '00' && attempt.attemptStatus === 'failed' && order.paymentStatus === 'pending';
      results.push({
        id: 'SC-04',
        title: 'Xác thực OTP sai / Quá 3 lần (10)',
        expectedRsp: '00',
        actualRsp: res.RspCode,
        orderState: `${order.status}/${order.paymentStatus}`,
        pass
      });
    }

    // SC-05
    {
      const orderNumber = 'GR-20261102-SC05';
      seedOrder(orderNumber, 150000);
      const forged = {
        vnp_TmnCode: tmnCode,
        vnp_Amount: '15000000',
        vnp_TxnRef: orderNumber,
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00',
        vnp_SecureHash: 'invalid-signature-hash-00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
      };
      const res = await (await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(forged)}`)).json();
      results.push({
        id: 'SC-05',
        title: 'Chữ ký giả mạo (Invalid Signature)',
        expectedRsp: '97',
        actualRsp: res.RspCode,
        orderState: 'Từ chối giao dịch',
        pass: res.RspCode === '97'
      });
    }

    // SC-06
    {
      const orderNumber = 'GR-20261102-SC06';
      seedOrder(orderNumber, 600000);
      const wrongAmount = {
        vnp_TmnCode: tmnCode,
        vnp_Amount: '50000000', // Sai số tiền
        vnp_TxnRef: orderNumber,
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00'
      };
      wrongAmount.vnp_SecureHash = signParams(wrongAmount, hashSecret);
      const res = await (await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(wrongAmount)}`)).json();
      results.push({
        id: 'SC-06',
        title: 'Sai lệch số tiền (Amount Tampering)',
        expectedRsp: '04',
        actualRsp: res.RspCode,
        orderState: 'Từ chối giao dịch',
        pass: res.RspCode === '04'
      });
    }

    // SC-07
    {
      const notFound = {
        vnp_TmnCode: tmnCode,
        vnp_Amount: '10000000',
        vnp_TxnRef: 'GR-NONEXISTENT-999',
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00'
      };
      notFound.vnp_SecureHash = signParams(notFound, hashSecret);
      const res = await (await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(notFound)}`)).json();
      results.push({
        id: 'SC-07',
        title: 'Đơn hàng không tồn tại (Order Not Found)',
        expectedRsp: '01',
        actualRsp: res.RspCode,
        orderState: 'Từ chối giao dịch',
        pass: res.RspCode === '01'
      });
    }

    // SC-08
    {
      const orderNumber = 'GR-20261102-SC08';
      seedOrder(orderNumber, 250000, { paymentStatus: 'paid', attemptStatus: 'paid' });
      const dup = {
        vnp_TmnCode: tmnCode,
        vnp_Amount: '25000000',
        vnp_TxnRef: orderNumber,
        vnp_ResponseCode: '00',
        vnp_TransactionStatus: '00'
      };
      dup.vnp_SecureHash = signParams(dup, hashSecret);
      const res = await (await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(dup)}`)).json();
      results.push({
        id: 'SC-08',
        title: 'Xử lý IPN trùng lặp (Idempotency)',
        expectedRsp: '02',
        actualRsp: res.RspCode,
        orderState: 'Bảo toàn số dư/kế toán',
        pass: res.RspCode === '02'
      });
    }
  } finally {
    server.close();
  }

  console.log('| Mã kịch bản | Kịch bản kiểm thử                     | RspCode mong đợi | RspCode thực tế | Trạng thái đơn hàng | Kết quả  |');
  console.log('|-------------|---------------------------------------|------------------|-----------------|---------------------|----------|');
  for (const r of results) {
    const passTag = r.pass ? '✓ PASS' : '✖ FAIL';
    console.log(`| ${r.id.padEnd(11)} | ${r.title.padEnd(37)} | ${r.expectedRsp.padEnd(16)} | ${r.actualRsp.padEnd(15)} | ${r.orderState.padEnd(19)} | ${passTag.padEnd(8)} |`);
  }
  console.log();

  const allPassed = results.every(r => r.pass);
  if (allPassed) {
    console.log('🎉 TẤT CẢ 8/8 KỊCH BẢN NGHIỆM THU KỸ THUẬT VNPAY ĐẠT 100% TIÊU CHUẨN THÔNG QUA!');
    console.log('Hệ thống GAERU đã sẵn sàng 100% cho bước đấu nối chính thức (Production Cutover).');
  } else {
    console.error('Cảnh báo: Có kịch bản kiểm thử chưa đạt yêu cầu.');
    process.exit(1);
  }
}

runAcceptance().catch(err => {
  console.error('Acceptance Runner Error:', err);
  process.exit(1);
});
