'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const express = require('express');
const { verifyGatewayPayload } = require('../src/payment-channels');
const { createStoreApi } = require('../src/store-api');
const merchant = { partnerCode: 'MOMO_CODEQL_FIXTURE', accessKey: 'fixture-access-key', secretKey: 'isolated-codeql-momo-signing-key' };
const bank = { webhookSecret: 'isolated-bank-webhook-secret-no-url', bankName: 'MB', accountNumber: '1234567890', accountHolder: 'Fixture Merchant' };
function signed(changes = {}) {
  const p = { partnerCode: merchant.partnerCode, orderId: 'GR-20261103-ABCDEF1234', amount: 230000, resultCode: 0, transId: 4088878653, extraData: '', message: 'Successful.', orderInfo: 'CodeQL fixture', orderType: 'momo_wallet', payType: 'qr', requestId: 'fixture-request-id', responseTime: 1793664000000, ...changes };
  const raw = `accessKey=${merchant.accessKey}&amount=${p.amount}&extraData=${p.extraData}&message=${p.message}&orderId=${p.orderId}&orderInfo=${p.orderInfo}&orderType=${p.orderType}&partnerCode=${p.partnerCode}&payType=${p.payType}&requestId=${p.requestId}&responseTime=${p.responseTime}&resultCode=${p.resultCode}&transId=${p.transId}`;
  return { ...p, signature: createHmac('sha256', merchant.secretKey).update(raw).digest('hex') };
}
async function fixture(t) {
  let reads = 0, transactions = 0;
  const pool = { query() { reads++; throw Error('Rejected input must never read the database'); }, connect() { transactions++; throw Error('Rejected input must never start a transaction'); } };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.session = { csrfToken: 'codeql-fixture', admin: { username: 'codeql-fixture' } }; req.admin = { username: 'codeql-fixture', permissions: ['orders.write', 'payments.write'] }; next(); });
  app.use('/api', createStoreApi(pool, { paymentChannels: { methods: ['momo', 'bank_transfer'], configs: { momo: merchant, bank_transfer: bank } } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base: 'http://127.0.0.1:' + server.address().port, counts: () => ({ reads, transactions }) };
}

test('MoMo requestId cannot bypass scalar validation with a correctly signed JSON array or object', async t => {
  assert.equal(verifyGatewayPayload('momo', signed(), merchant).valid, true);
  assert.equal(verifyGatewayPayload('momo', signed({ requestId: 'x'.repeat(100) }), merchant).valid, true);
  assert.equal(verifyGatewayPayload('momo', signed({ requestId: 'x'.repeat(101) }), merchant).valid, false);
  const f = await fixture(t);
  for (const requestId of [[], ['fixture-request-id'], ['fixture-request-id', 'second'], {}, null, 123, true, '']) {
    const payload = signed({ requestId });
    assert.equal(verifyGatewayPayload('momo', payload, merchant).valid, false, JSON.stringify(requestId));
    const response = await fetch(f.base + '/api/payments/momo/ipn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, '97');
  }
  assert.deepEqual(f.counts(), { reads: 0, transactions: 0 });
});

test('format specifiers in an order path are rejected before order writes or invoice-error logging', async t => {
  const f = await fixture(t), logs = [];
  t.mock.method(console, 'error', (...args) => { logs.push(args); });
  for (const id of ['%s', '%d', '%j', '%o', '%%', '4b4cfca4-96cd-47b1-a851-ed6f9944359f%s']) {
    const response = await fetch(f.base + '/api/gaeru_ceo/orders/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'codeql-fixture' }, body: JSON.stringify({ status: 'completed', paymentStatus: 'paid' }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /định danh/);
  }
  assert.deepEqual(f.counts(), { reads: 0, transactions: 0 });
  assert.equal(logs.length, 0);
});

test('bank webhook credentials must come from headers and URL/body aliases cannot authorize settlement', async t => {
  const payload = { orderNumber: 'GR-20261103-ABCD1234', amount: 199000, tid: 'BANK-CODEQL-FIXTURE' };
  assert.equal(verifyGatewayPayload('bank_transfer', payload, bank, { headers: { 'secure-token': bank.webhookSecret } }).valid, true);
  const signature = createHmac('sha256', bank.webhookSecret).update(JSON.stringify(payload)).digest('hex');
  assert.equal(verifyGatewayPayload('bank_transfer', payload, bank, { headers: { 'x-signature': signature } }).valid, true);
  const f = await fixture(t);
  for (const key of ['token', 'secret']) {
    assert.equal(verifyGatewayPayload('bank_transfer', payload, bank, { query: { [key]: bank.webhookSecret } }).valid, false, key);
    const response = await fetch(f.base + '/api/payments/bank_transfer/webhook?' + new URLSearchParams({ [key]: bank.webhookSecret }), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 400); assert.equal((await response.json()).code, '97');
  }
  for (const key of ['secureToken', 'secure_token', 'apiKey', 'token', 'secret']) {
    const body = { ...payload, [key]: bank.webhookSecret };
    assert.equal(verifyGatewayPayload('bank_transfer', body, bank).valid, false, key);
    const response = await fetch(f.base + '/api/payments/bank_transfer/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400); assert.equal((await response.json()).code, '97');
  }
  assert.equal(verifyGatewayPayload('bank_transfer', payload, bank, { headers: { 'secure-token': bank.webhookSecret }, query: { token: 'untrusted-url-input' } }).valid, true, 'URL values do not override the authenticated header');
  assert.equal(verifyGatewayPayload('bank_transfer', payload, bank, { headers: { authorization: [bank.webhookSecret] } }).valid, false);
  assert.deepEqual(f.counts(), { reads: 0, transactions: 0 });
});
