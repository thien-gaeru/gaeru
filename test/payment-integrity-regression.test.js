const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { verifyGatewayPayload } = require('../src/payment-channels');

const orderNumber = 'GR-20261028-ABCDEF1234';
const momo = { partnerCode: 'MOMO_FIXTURE', accessKey: 'fixture-access-key', secretKey: 'fixture-secret-key-for-contract-tests' };
const zalo = { appId: '2554', key1: 'fixture-create-key', key2: 'fixture-callback-key' };
const hmac = (key, value) => createHmac('sha256', key).update(value, 'utf8').digest('hex');

test('MoMo accepts its complete documented IPN signature and rejects invented compact signatures', () => {
  const payload = {
    partnerCode: momo.partnerCode, orderId: orderNumber, amount: 230000,
    resultCode: 0, transId: 4088878653, extraData: '', message: 'Successful.',
    orderInfo: 'Fixture order', orderType: 'momo_wallet', payType: 'qr',
    requestId: 'fixture-request-id', responseTime: 1793155200000
  };
  const raw = `accessKey=${momo.accessKey}&amount=${payload.amount}&extraData=${payload.extraData}&message=${payload.message}&orderId=${payload.orderId}&orderInfo=${payload.orderInfo}&orderType=${payload.orderType}&partnerCode=${payload.partnerCode}&payType=${payload.payType}&requestId=${payload.requestId}&responseTime=${payload.responseTime}&resultCode=${payload.resultCode}&transId=${payload.transId}`;
  assert.equal(verifyGatewayPayload('momo', { ...payload, signature: hmac(momo.secretKey, raw) }, momo).valid, true);
  const compact = `partnerCode=${momo.partnerCode}&orderId=${orderNumber}&amount=230000&resultCode=0&transId=4088878653`;
  assert.equal(verifyGatewayPayload('momo', { ...payload, signature: hmac(momo.secretKey, compact) }, momo).valid, false);
});

test('ZaloPay accepts signed JSON callback data and rejects an invented query signature', () => {
  const data = JSON.stringify({ app_id: 2554, app_trans_id: `261028_${orderNumber}`, amount: 230000, zp_trans_id: 200904000000389 });
  assert.equal(verifyGatewayPayload('zalopay', { data, mac: hmac(zalo.key2, data), type: 1 }, zalo).valid, true);
  const query = { app_trans_id: `261028_${orderNumber}`, amount: 230000, status: '1' };
  query.mac = hmac(zalo.key2, `${zalo.appId}|${query.app_trans_id}|${query.amount}|${query.status}`);
  assert.equal(verifyGatewayPayload('zalopay', query, zalo).valid, false);
});

test('a signed ZaloPay envelope still requires the callback merchant identity', () => {
  for (const appId of [undefined, 9999]) {
    const data = JSON.stringify({ ...(appId === undefined ? {} : { app_id: appId }), app_trans_id: `261028_${orderNumber}`, amount: 230000, zp_trans_id: 200904000000389 });
    assert.equal(verifyGatewayPayload('zalopay', { data, mac: hmac(zalo.key2, data), type: 1 }, zalo).valid, false);
  }
});

test('MoMo signed failures never become paid and malformed or tampered transaction fields are rejected', () => {
  function signed(changes = {}) {
    const p = {
      partnerCode: momo.partnerCode, orderId: orderNumber, amount: 230000,
      resultCode: 0, transId: 4088878653, extraData: '', message: 'Successful.',
      orderInfo: 'Fixture order', orderType: 'momo_wallet', payType: 'qr',
      requestId: 'fixture-request-id', responseTime: 1793155200000, ...changes
    };
    const raw = `accessKey=${momo.accessKey}&amount=${p.amount}&extraData=${p.extraData}&message=${p.message}&orderId=${p.orderId}&orderInfo=${p.orderInfo}&orderType=${p.orderType}&partnerCode=${p.partnerCode}&payType=${p.payType}&requestId=${p.requestId}&responseTime=${p.responseTime}&resultCode=${p.resultCode}&transId=${p.transId}`;
    return { ...p, signature: hmac(momo.secretKey, raw) };
  }
  const failed = verifyGatewayPayload('momo', signed({ resultCode: 1006, transId: 0, message: 'User cancelled' }), momo);
  assert.equal(failed.valid, true);
  assert.equal(failed.successful, false);
  const valid = signed();
  for (const changes of [
    { amount: 0 }, { amount: -1 }, { amount: 1.5 }, { amount: 2000000001 },
    { transId: '' }, { transId: 0 }, { requestId: '' },
    { orderId: 'prefix-' + orderNumber }, { partnerCode: 'OTHER_MERCHANT' },
    { resultCode: 'SUCCESS' }, { amount: [230000] }
  ]) assert.equal(verifyGatewayPayload('momo', signed(changes), momo).valid, false, JSON.stringify(changes));
  assert.equal(verifyGatewayPayload('momo', { ...valid, amount: 230001 }, momo).valid, false);
  assert.equal(verifyGatewayPayload('momo', { ...valid, requestId: 'other-request' }, momo).valid, false);
  assert.equal(verifyGatewayPayload('momo', { ...valid, partnerCode: undefined }, momo).valid, false);
});

test('ZaloPay rejects bad MAC, wrong event types and signed malformed transaction data', () => {
  const original = { app_id: 2554, app_trans_id: `261028_${orderNumber}`, amount: 230000, zp_trans_id: 200904000000389 };
  function signed(value = original, type = 1) {
    const data = JSON.stringify(value);
    return { data, mac: hmac(zalo.key2, data), type };
  }
  const valid = signed();
  assert.equal(verifyGatewayPayload('zalopay', { ...valid, mac: '0'.repeat(64) }, zalo).valid, false);
  assert.equal(verifyGatewayPayload('zalopay', signed(original, 2), zalo).valid, false);
  assert.equal(verifyGatewayPayload('zalopay', { data: '{', mac: hmac(zalo.key2, '{'), type: 1 }, zalo).valid, false);
  for (const changes of [
    { amount: 0 }, { amount: -1 }, { amount: 1.5 }, { amount: 2000000001 },
    { zp_trans_id: '' }, { zp_trans_id: 0 }, { app_trans_id: orderNumber },
    { app_trans_id: `261028_prefix-${orderNumber}` }
  ]) assert.equal(verifyGatewayPayload('zalopay', signed({ ...original, ...changes }), zalo).valid, false, JSON.stringify(changes));
  assert.equal(verifyGatewayPayload('zalopay', signed([]), zalo).valid, false);
});

test('9Pay and bank transfer cannot settle through unverified generic callback formats', () => {
  const settings = { checksumKey: 'fixture-unverified-9pay-key' };
  const payload = { invoice_no: orderNumber, amount: 230000, status: 'PAID' };
  payload.checksum = hmac(settings.checksumKey, `${orderNumber}:230000:PAID`);
  assert.equal(verifyGatewayPayload('9pay', payload, settings).valid, false);
  assert.equal(verifyGatewayPayload('bank_transfer', payload, settings).valid, false);
  assert.equal(verifyGatewayPayload('momo', null, momo).valid, false);
  assert.equal(verifyGatewayPayload('zalopay', [], zalo).valid, false);
});
