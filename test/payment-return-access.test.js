'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const express = require('express');
const { createStoreApi } = require('../src/store-api');
const { verifyGatewayReturn } = require('../src/payment-return');
const { verifyGuestTrackingToken } = require('../src/shipping-management');

const orderNumber = 'GR-20261110-RETURN1234';
const config = { NODE_ENV: 'test', SESSION_SECRET: 'synthetic-return-access-secret-32-chars' };
const momo = { partnerCode: 'AUDITMOMO', accessKey: 'audit-access-key', secretKey: 'audit-momo-secret' };
const zalopay = { appId: '2554', key2: 'audit-zalo-callback-key' };

function signedMomo(changes = {}) {
  const p = { partnerCode: momo.partnerCode, orderId: orderNumber, requestId: 'audit-request',
    amount: '100000', resultCode: '0', transId: '12345', responseTime: '1794268800000',
    orderInfo: 'Synthetic order', orderType: 'momo_wallet', payType: 'qr', message: 'Successful.', extraData: '', ...changes };
  const raw = `accessKey=${momo.accessKey}&amount=${p.amount}&extraData=${p.extraData}&message=${p.message}&orderId=${p.orderId}&orderInfo=${p.orderInfo}&orderType=${p.orderType}&partnerCode=${p.partnerCode}&payType=${p.payType}&requestId=${p.requestId}&responseTime=${p.responseTime}&resultCode=${p.resultCode}&transId=${p.transId}`;
  return { ...p, signature: createHmac('sha256', momo.secretKey).update(raw).digest('hex') };
}
function signedZalo(changes = {}) {
  const p = { appid: zalopay.appId, apptransid: `261110_${orderNumber}`, pmcid: '38', bankcode: '',
    amount: '100000', discountamount: '0', status: '1', ...changes };
  const raw = ['appid','apptransid','pmcid','bankcode','amount','discountamount','status'].map(key => p[key]).join('|');
  return { ...p, checksum: createHmac('sha256', zalopay.key2).update(raw).digest('hex') };
}

test('wallet return access requires a valid signature and never settles payment', async t => {
  let writes = 0;
  const pool = { async query(sql) {
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes++;
    if (sql.includes('FROM orders WHERE order_number')) return { rows: [{ id: 'synthetic-order', orderNumber,
      customerId: 'another-customer', paymentMethod: 'momo', paymentStatus: 'pending', status: 'pending', totalVnd: 100000 }] };
    if (sql.includes('FROM order_items')) return { rows: [{ sku: 'PRIVATE-ITEM', quantity: 1 }] };
    return { rows: [] };
  } };
  const app = express();
  // Only this fixture marks an existing checkout session; HTTP input cannot set it.
  app.use((req, _res, next) => { if (req.get('x-fixture-checkout') === 'yes') req.session = { placedOrders: [orderNumber] }; next(); });
  app.use('/api', createStoreApi(pool, { config, paymentChannels: { methods: [], callbackConfigs: { momo, zalopay } } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [provider, signed] of [['momo', signedMomo], ['zalopay', signedZalo]]) {
    const before = await fetch(`${base}/api/payments/order-status?order=${orderNumber}`);
    assert.equal(before.status, 401);
    for (const params of [{ orderId: orderNumber }, { order: orderNumber, resultCode: '0' },
      { ...signed(), [provider === 'momo' ? 'signature' : 'checksum']: '0'.repeat(64) },
      { ...signed(), amount: '99999' }]) {
      const r = await fetch(`${base}/api/payments/${provider}/return?${new URLSearchParams(params)}`, { redirect: 'manual' });
      assert.equal(r.status, 302);
      const location = new URL(r.headers.get('location'), base);
      assert.equal(location.searchParams.has('token'), false, provider + ': unverified browser input must never mint a token');
      assert.equal(location.searchParams.get('result'), 'pending');
      assert.equal(location.searchParams.get('code'), '');
    }
    const r = await fetch(`${base}/api/payments/${provider}/return?${new URLSearchParams(signed())}`, { redirect: 'manual' });
    const location = new URL(r.headers.get('location'), base), token = location.searchParams.get('token');
    assert.equal(location.searchParams.get('order'), orderNumber);
    assert.equal(location.searchParams.get('result'), 'processing');
    assert.equal(verifyGuestTrackingToken(config, orderNumber, token), true);
    const status = await fetch(`${base}/api/payments/order-status?order=${orderNumber}&token=${encodeURIComponent(token)}`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).order.paymentStatus, 'pending');
    assert.equal(verifyGuestTrackingToken(config, 'GR-20261110-DIFFERENT', token), false);
  }
  const own = await fetch(`${base}/api/payments/order-status?order=${orderNumber}`, { headers: { 'x-fixture-checkout': 'yes' } });
  assert.equal(own.status, 200, 'existing checkout session still reads authoritative state without a return token');
  assert.equal(writes, 0);
});

test('ZaloPay return checksum verifies every field and merchant without accepting callback envelopes', () => {
  assert.equal(verifyGatewayReturn('zalopay', signedZalo(), zalopay).valid, true);
  for (const field of ['appid','apptransid','pmcid','bankcode','amount','discountamount','status','checksum']) {
    const p = signedZalo();
    assert.equal(verifyGatewayReturn('zalopay', { ...p, [field]: p[field] + 'x' }, zalopay).valid, false, field);
    assert.equal(verifyGatewayReturn('zalopay', { ...p, [field]: [p[field]] }, zalopay).valid, false, field + ' duplicates');
    delete p[field];
    assert.equal(verifyGatewayReturn('zalopay', p, zalopay).valid, false, field + ' missing');
  }
  for (const changes of [{ appid: '9999' }, { apptransid: 'invalid' }, { amount: '0' },
    { amount: '-1' }, { amount: '2000000001' }, { discountamount: '100001' }]) {
    assert.equal(verifyGatewayReturn('zalopay', signedZalo(changes), zalopay).valid, false);
  }
  assert.equal(verifyGatewayReturn('zalopay', signedZalo({ status: '-49' }), zalopay).successful, false);
  const data = JSON.stringify({ app_id: 2554, app_trans_id: `261110_${orderNumber}`, amount: 100000, zp_trans_id: 123 });
  assert.equal(verifyGatewayReturn('zalopay', { data, type: 1, mac: createHmac('sha256', zalopay.key2).update(data).digest('hex') }, zalopay).valid, false);
});
