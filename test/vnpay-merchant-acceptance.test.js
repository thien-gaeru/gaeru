const test = require('node:test');
const assert = require('node:assert/strict');
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

test('VNPAY Merchant Acceptance Testing Suite (100% Compliance)', async (suite) => {
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
  let financeEntry = null;
  let auditLogs = [];

  function seedOrder(orderNumber, amountVnd = 500000, { paymentStatus = 'pending', status = 'pending', attemptStatus = 'pending' } = {}) {
    const orderId = orders.size + 1;
    const attemptId = attempts.size + 10;
    const order = {
      id: orderId,
      orderNumber,
      totalVnd: amountVnd,
      paymentStatus,
      status,
      paymentMethod: 'vnpay'
    };
    const attempt = {
      id: attemptId,
      orderId,
      amountVnd,
      attemptStatus,
      providerTransactionId: null,
      responseCode: null
    };
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
  app.use((req, _res, next) => {
    req.vnpayCallbackConfig = vnpayConfig;
    next();
  });
  app.use('/api', createStoreApi(
    { connect: async () => mockClient },
    {
      vnpayConfig,
      finance: mockFinance,
      audit: mockAudit
    }
  ));

  const server = app.listen(0, '127.0.0.1');
  suite.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  await suite.test('SC-01: Giao dịch thành công (vnp_ResponseCode = "00") - IPN & Return URL', async () => {
    const orderNumber = 'GR-20261102-VN01';
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

    const ipnRes = await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(ipnParams)}`);
    const ipnData = await ipnRes.json();
    assert.deepEqual(ipnData, { RspCode: '00', Message: 'Confirm Success' });
    assert.strictEqual(order.paymentStatus, 'paid');
    assert.strictEqual(order.status, 'processing');
    assert.strictEqual(attempt.attemptStatus, 'paid');
    assert.strictEqual(financeEntry.order.total_vnd, 500000);

    // Return URL redirect check
    const returnParams = { ...ipnParams };
    delete returnParams.vnp_SecureHash;
    returnParams.vnp_SecureHash = signParams(returnParams, hashSecret);

    const returnRes = await fetch(`${baseUrl}/payments/vnpay/return?${new URLSearchParams(returnParams)}`, {
      redirect: 'manual'
    });
    assert.strictEqual(returnRes.status, 302);
    const location = returnRes.headers.get('location');
    assert.match(location, /\/payment-result\.html\?result=processing&provider=vnpay&order=GR-20261102-VN01&code=00/);
  });

  await suite.test('SC-02: Khách hàng bấm hủy giao dịch (vnp_ResponseCode = "24")', async () => {
    const cancelOrder = 'GR-20261102-VN02';
    const { order, attempt } = seedOrder(cancelOrder, 350000);

    const params = {
      vnp_TmnCode: tmnCode,
      vnp_Amount: '35000000',
      vnp_BankCode: 'NCB',
      vnp_OrderInfo: `Thanh toan don hang ${cancelOrder}`,
      vnp_ResponseCode: '24',
      vnp_TransactionStatus: '02',
      vnp_TxnRef: cancelOrder
    };
    params.vnp_SecureHash = signParams(params, hashSecret);

    // 1. Return URL redirects with code=24 and result=failed
    const returnRes = await fetch(`${baseUrl}/payments/vnpay/return?${new URLSearchParams(params)}`, {
      redirect: 'manual'
    });
    assert.strictEqual(returnRes.status, 302);
    const location = returnRes.headers.get('location');
    assert.match(location, /\/payment-result\.html\?result=failed&provider=vnpay&order=GR-20261102-VN02&code=24/);

    // 2. IPN acknowledges with 00 and updates attempt to failed
    const ipnRes = await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(params)}`);
    const ipnData = await ipnRes.json();
    assert.deepEqual(ipnData, { RspCode: '00', Message: 'Confirm Success' });
    assert.strictEqual(attempt.attemptStatus, 'failed');
    assert.strictEqual(attempt.responseCode, '24');
    assert.strictEqual(order.paymentStatus, 'pending');
  });

  await suite.test('SC-03: Thẻ chưa đăng ký Internet Banking (vnp_ResponseCode = "09")', async () => {
    const unregOrder = 'GR-20261102-VN03';
    const { order, attempt } = seedOrder(unregOrder, 200000);

    const params = {
      vnp_TmnCode: tmnCode,
      vnp_Amount: '20000000',
      vnp_BankCode: 'NCB',
      vnp_OrderInfo: 'Thanh toan',
      vnp_ResponseCode: '09',
      vnp_TransactionStatus: '02',
      vnp_TxnRef: unregOrder
    };
    params.vnp_SecureHash = signParams(params, hashSecret);

    const returnRes = await fetch(`${baseUrl}/payments/vnpay/return?${new URLSearchParams(params)}`, {
      redirect: 'manual'
    });
    assert.strictEqual(returnRes.status, 302);
    assert.match(returnRes.headers.get('location'), /code=09/);

    const ipnRes = await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(params)}`);
    assert.deepEqual(await ipnRes.json(), { RspCode: '00', Message: 'Confirm Success' });
    assert.strictEqual(attempt.attemptStatus, 'failed');
    assert.strictEqual(attempt.responseCode, '09');
    assert.strictEqual(order.paymentStatus, 'pending');
  });

  await suite.test('SC-04: Xác thực OTP sai / Thẻ hết hạn (vnp_ResponseCode = "10")', async () => {
    const otpOrder = 'GR-20261102-VN04';
    const { order, attempt } = seedOrder(otpOrder, 400000);

    const params = {
      vnp_TmnCode: tmnCode,
      vnp_Amount: '40000000',
      vnp_BankCode: 'NCB',
      vnp_OrderInfo: 'Thanh toan',
      vnp_ResponseCode: '10',
      vnp_TransactionStatus: '02',
      vnp_TxnRef: otpOrder
    };
    params.vnp_SecureHash = signParams(params, hashSecret);

    const returnRes = await fetch(`${baseUrl}/payments/vnpay/return?${new URLSearchParams(params)}`, {
      redirect: 'manual'
    });
    assert.strictEqual(returnRes.status, 302);
    assert.match(returnRes.headers.get('location'), /code=10/);

    const ipnRes = await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(params)}`);
    assert.deepEqual(await ipnRes.json(), { RspCode: '00', Message: 'Confirm Success' });
    assert.strictEqual(attempt.attemptStatus, 'failed');
    assert.strictEqual(attempt.responseCode, '10');
    assert.strictEqual(order.paymentStatus, 'pending');
  });

  await suite.test('SC-05: Chữ ký không hợp lệ (RspCode = "97")', async () => {
    const validOrder = 'GR-20261102-VN05';
    seedOrder(validOrder, 150000);

    const forged = {
      vnp_TmnCode: tmnCode,
      vnp_Amount: '15000000',
      vnp_TxnRef: validOrder,
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00',
      vnp_SecureHash: 'invalid-signature-hash-00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
    };
    const ipnRes = await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(forged)}`);
    assert.deepEqual(await ipnRes.json(), { RspCode: '97', Message: 'Invalid signature' });

    const returnRes = await fetch(`${baseUrl}/payments/vnpay/return?${new URLSearchParams(forged)}`, {
      redirect: 'manual'
    });
    assert.strictEqual(returnRes.status, 302);
    assert.match(returnRes.headers.get('location'), /result=invalid/);
  });

  await suite.test('SC-06: Sai số tiền giao dịch (RspCode = "04")', async () => {
    const amountOrder = 'GR-20261102-VN06';
    seedOrder(amountOrder, 600000); // 600.000₫

    const wrongAmount = {
      vnp_TmnCode: tmnCode,
      vnp_Amount: '50000000', // Khác 600.000₫
      vnp_TxnRef: amountOrder,
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00'
    };
    wrongAmount.vnp_SecureHash = signParams(wrongAmount, hashSecret);

    const ipnRes = await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(wrongAmount)}`);
    assert.deepEqual(await ipnRes.json(), { RspCode: '04', Message: 'Invalid amount' });
  });

  await suite.test('SC-07: Đơn hàng không tồn tại (RspCode = "01")', async () => {
    const notFound = {
      vnp_TmnCode: tmnCode,
      vnp_Amount: '10000000',
      vnp_TxnRef: 'GR-NONEXISTENT-999',
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00'
    };
    notFound.vnp_SecureHash = signParams(notFound, hashSecret);

    const ipnRes = await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(notFound)}`);
    assert.deepEqual(await ipnRes.json(), { RspCode: '01', Message: 'Order not found' });
  });

  await suite.test('SC-08: Xử lý trùng lặp Idempotency (RspCode = "02")', async () => {
    const paidOrder = 'GR-20261102-VN08';
    seedOrder(paidOrder, 250000, { paymentStatus: 'paid', attemptStatus: 'paid' });

    const dup = {
      vnp_TmnCode: tmnCode,
      vnp_Amount: '25000000',
      vnp_TxnRef: paidOrder,
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '00'
    };
    dup.vnp_SecureHash = signParams(dup, hashSecret);

    const ipnRes = await fetch(`${baseUrl}/payments/vnpay/ipn?${new URLSearchParams(dup)}`);
    assert.deepEqual(await ipnRes.json(), { RspCode: '02', Message: 'Order already confirmed' });
  });
});
