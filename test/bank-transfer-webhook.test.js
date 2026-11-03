const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyGatewayPayload, reconcilePrepaidOrder, formatBankTransferInstructions } = require('../src/payment-channels');

test('Bank Transfer Webhook Adapter - Security and Verification', async (t) => {
  const secret = 'super-secret-bank-webhook-token-12345';
  const settings = {
    bankName: 'MBBank',
    accountNumber: '0987654321',
    accountHolder: 'CONG TY TNHH GAERU',
    transferSyntax: 'GAERU {MA_DON}',
    webhookSecret: secret,
    enabled: true
  };

  await t.test('fails when webhookSecret is not configured on settings', () => {
    const unconfigured = { ...settings, webhookSecret: '' };
    const payload = {
      data: [{
        description: 'GAERU GR-12345678-ABCD',
        amount: 250000,
        tid: 'MB123456'
      }]
    };
    const res = verifyGatewayPayload('bank_transfer', payload, unconfigured, {
      headers: { 'secure-token': secret }
    });
    assert.strictEqual(res.valid, false);
    assert.match(res.reason, /disabled until a verified provider adapter is configured/);
  });

  await t.test('fails when incoming token is missing or invalid', () => {
    const payload = {
      data: [{
        description: 'GAERU GR-12345678-ABCD',
        amount: 250000,
        tid: 'MB123456'
      }]
    };
    // Missing token
    const resMissing = verifyGatewayPayload('bank_transfer', payload, settings, { headers: {} });
    assert.strictEqual(resMissing.valid, false);
    assert.match(resMissing.reason, /credentials/i);

    // Wrong token
    const resWrong = verifyGatewayPayload('bank_transfer', payload, settings, {
      headers: { 'secure-token': 'wrong-token' }
    });
    assert.strictEqual(resWrong.valid, false);
    assert.match(resWrong.reason, /credentials/i);
  });

  await t.test('successfully verifies Casso format via secure-token header', () => {
    const payload = {
      error: 0,
      data: [{
        id: 991,
        tid: 'CASSO_TXN_001',
        description: 'Chuyen khoan don hang GAERU GR-20261102-A1B2 noi dung',
        amount: 450000,
        when: '2026-11-02 10:00:00'
      }]
    };
    const res = verifyGatewayPayload('bank_transfer', payload, settings, {
      headers: { 'secure-token': secret }
    });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.orderNumber, 'GR-20261102-A1B2');
    assert.strictEqual(res.amountVnd, 450000);
    assert.strictEqual(res.providerTransactionId, 'CASSO_TXN_001');
    assert.strictEqual(res.successful, true);
  });

  await t.test('successfully verifies SeAPay format via x-api-key header', () => {
    const payload = {
      reference_number: 'FT261102888',
      content: 'GAERU GR-88889999-EF12 thanh toan tien tai nghe',
      transfer_amount: 320000,
      transfer_type: 'in'
    };
    const res = verifyGatewayPayload('bank_transfer', payload, settings, {
      headers: { 'x-api-key': secret }
    });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.orderNumber, 'GR-88889999-EF12');
    assert.strictEqual(res.amountVnd, 320000);
    assert.strictEqual(res.providerTransactionId, 'FT261102888');
  });

  await t.test('ignores outgoing money transactions', () => {
    const payload = {
      data: [{
        description: 'GAERU GR-11112222-3333 hoan tien',
        amount: 100000,
        transferType: 'out'
      }]
    };
    const res = verifyGatewayPayload('bank_transfer', payload, settings, {
      headers: { 'secure-token': secret }
    });
    assert.strictEqual(res.valid, false);
    assert.match(res.reason, /No matching GAERU order number/);
  });

  await t.test('successfully verifies HMAC SHA-256 signature', () => {
    const payload = {
      id: 'tx_9999',
      orderNumber: 'GR-55556666-7777',
      amount: 150000
    };
    const payloadStr = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');

    const res = verifyGatewayPayload('bank_transfer', payload, settings, {
      headers: { 'x-signature': signature }
    });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.orderNumber, 'GR-55556666-7777');
    assert.strictEqual(res.amountVnd, 150000);
  });

  await t.test('reconcilePrepaidOrder updates order to paid and processing atomically', async () => {
    const orderNumber = 'GR-20261102-1234';
    const amountVnd = 500000;
    let orderUpdated = null;
    let attemptUpdated = null;
    let auditLog = null;

    const mockClient = {
      query: async (sql, params) => {
        if (sql.includes('SELECT p.id, p.amount_vnd')) {
          return {
            rows: [{
              id: 101,
              amountVnd,
              attemptStatus: 'pending',
              orderId: 202,
              orderNumber,
              orderStatus: 'pending',
              paymentMethod: 'bank_transfer',
              subtotalVnd: 500000,
              shippingFeeVnd: 0,
              discountVnd: 0,
              totalVnd: 500000,
              paymentStatus: 'pending'
            }]
          };
        }
        if (sql.includes('UPDATE payment_attempts')) {
          attemptUpdated = { sql, params };
          return { rows: [] };
        }
        if (sql.includes('UPDATE orders')) {
          orderUpdated = { sql, params };
          return { rows: [] };
        }
        return { rows: [] };
      }
    };

    const mockFinance = {
      recordFullOrderPayment: async (_c, entry) => {
        assert.strictEqual(entry.order.id, 202);
      }
    };

    const mockAudit = async (_c, entry) => {
      auditLog = entry;
    };

    const result = await reconcilePrepaidOrder(mockClient, {
      provider: 'bank_transfer',
      orderNumber,
      amountVnd,
      successful: true,
      providerTransactionId: 'FT_TEST_001',
      responseCode: '00',
      finance: mockFinance,
      audit: mockAudit
    });

    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.orderId, 202);
    assert.strictEqual(result.orderNumber, orderNumber);
    assert.strictEqual(attemptUpdated.params[1], 'paid');
    assert.strictEqual(attemptUpdated.params[2], 'FT_TEST_001');
    assert.strictEqual(orderUpdated.params[0], 202);
    assert.strictEqual(auditLog.action, 'payment.bank_transfer.callback');
    assert.strictEqual(auditLog.metadata.autoApprovedToProcessing, true);
  });
  await t.test('formatBankTransferInstructions generates valid VietQR QuickPay URL', () => {
    const bt = formatBankTransferInstructions(settings, {
      orderNumber: 'GR-20261102-1234',
      amountVnd: 750000
    });

    assert.strictEqual(bt.bankName, 'MBBank');
    assert.strictEqual(bt.bankBin, '970422');
    assert.strictEqual(bt.bankId, 'MB');
    assert.strictEqual(bt.accountNumber, '0987654321');
    assert.strictEqual(bt.transferContent, 'GAERU GR-20261102-1234');
    assert.strictEqual(bt.amountVnd, 750000);
    assert.strictEqual(bt.autoReconcile, true);
    assert.ok(bt.qrUrl);
    assert.ok(bt.qrUrl.includes('https://img.vietqr.io/image/970422-0987654321-compact2.png'));
    assert.ok(bt.qrUrl.includes('amount=750000'));
    assert.ok(bt.qrUrl.includes('addInfo=GAERU+GR-20261102-1234'));
  });

  await t.test('successfully verifies PayOS webhook format with payload.data object', () => {
    const payosPayload = {
      code: '00',
      desc: 'success',
      data: {
        orderCode: 987654,
        amount: 880000,
        description: 'GAERU GR-20261102-PAYOS1234',
        accountNumber: '0987654321',
        reference: 'PAYOS_REF_001',
        transactionDateTime: '2026-11-02 14:00:00'
      }
    };
    const res = verifyGatewayPayload('bank_transfer', payosPayload, settings, {
      headers: { 'x-api-key': secret }
    });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.orderNumber, 'GR-20261102-PAYOS1234');
    assert.strictEqual(res.amountVnd, 880000);
    assert.strictEqual(res.providerTransactionId, 'PAYOS_REF_001');
    assert.strictEqual(res.successful, true);
  });

  await t.test('successfully extracts order number and reconciles when bank strips dashes', () => {
    // Bank stripped dashes: GR20261102AABBCC
    const bankSmsPayload = {
      data: [{
        description: 'MBVCB.12345678.GAERU GR20261102AABBCC.CT tu NGUYEN VAN A',
        amount: 350000,
        tid: 'MB_RAW_999'
      }]
    };
    const res = verifyGatewayPayload('bank_transfer', bankSmsPayload, settings, {
      headers: { 'secure-token': secret }
    });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.orderNumber, 'GR-20261102-AABBCC');
    assert.strictEqual(res.amountVnd, 350000);
    assert.strictEqual(res.providerTransactionId, 'MB_RAW_999');
  });

  await t.test('rejects credentials passed in URL query parameters or payload fields', () => {
    const payload = {
      orderNumber: 'GR-20261102-QUERY123',
      amount: 199000,
      tid: 'TID_QUERY'
    };
    const res = verifyGatewayPayload('bank_transfer', payload, settings, {
      headers: {},
      query: { token: secret }
    });
    assert.strictEqual(res.valid, false);
    for (const key of ['secureToken', 'secure_token', 'apiKey', 'token', 'secret']) {
      assert.strictEqual(verifyGatewayPayload('bank_transfer', { ...payload, [key]: secret }, settings).valid, false);
    }
  });
});
