'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { adapters, normalizeCarrierStatus } = require('../src/shipping-adapters');
const { verifyCarrier } = require('../src/shipping-choice');
const settings = { protocol: 'jt-vn-open-platform-v1', environment: 'sandbox', partnerCode: '10000000000000001', customerPassword: '00000000000000000000000000000000', pickupProvince: 'Hà Nội', pickupArea: 'Phường Ba Đình', payType: 'PP_CASH', serviceType: 1, secret: 'fixture-api-secret', accountId: '123', pickupName: 'Fixture', pickupPhone: '0900000000', pickupAddress: 'Fixture' };
const order = { orderNumber: 'FIXTURE-ORDER', customerName: 'Fixture', phone: '0900000000', address: 'Fixture', city: 'Hà Nội', receiver: {name:'Fixture',mobile:'0900000000',prov:'Hà Nội',area:'Phường Ba Đình',address:'Fixture'}, subtotalVnd:100000,totalVnd:100000,weightGrams:500,items: [{productName:'Fixture',quantity:1,priceVnd:100000}], codAmountVnd: 0 };
const response = data => ({ fetcher: async () => ({ ok: true, json: async () => data, text: async () => JSON.stringify(data) }) });

test('failed HTTP-200 carrier envelopes cannot verify accounts, cancel shipments or reset tracking', async () => {
  for (const id of ['jt', 'spx']) {
    for (const data of [{ code: 401, data: {}, desc: 'Unauthorized' }, { code: 403, success: true, data: { status: 'active' } }, { desc: 'arbitrary server message' }]) {
      await assert.rejects(() => verifyCarrier(id, settings, response(data)), e => e.status === 502, id);
    }
  }
  for (const [id, adapter] of Object.entries(adapters)) {
    const failure = { code: 401, status: 401, error: true, success: false, data: {}, desc: 'unauthorized' };
    await assert.rejects(() => adapter.cancelWaybill(settings, { trackingNumber: 'FIXTURE', carrierOrderId: 'FIXTURE' }, response(failure)), e => e.status === 502, id + ' cancellation');
    await assert.rejects(() => adapter.queryTracking(settings, { trackingNumber: 'FIXTURE' }, response(failure)), e => e.status === 502, id + ' tracking');
  }
});

test('a positive envelope without a provider tracking number never fabricates a waybill', async () => {
  for (const [id, data] of [['jt', { code: '1', data: {} }], ['spx', { code: 0, data: {} }], ['viettel', { status: 200, error: false, data: {} }]]) {
    await assert.rejects(() => adapters[id].createWaybill(settings, order, response(data)), e => e.status === 502 && e.ambiguous === true, id);
  }
  const result = await adapters.jt.createWaybill(settings, order, response({ code: '1', data: { billCode: 'PROVIDER-TRACKING', txlogisticId: order.orderNumber, inquiryFee: 0, codFee:0, insuranceFee:0 } }));
  assert.equal(result.trackingNumber, 'PROVIDER-TRACKING');
  assert.equal(result.shippingFeeVnd, 0, 'zero quoted fee must not become a fabricated fee');
  const unknownFee = await adapters.spx.createWaybill(settings, order, response({ code: 0, data: { tracking_number: 'PROVIDER-SPX' } }));
  assert.equal(unknownFee.shippingFeeVnd, null, 'missing fee is unknown, not a made-up amount');
});

test('carrier prices are accepted only from valid responses and SPX never labels a fixed fallback realtime', async () => {
  for (const id of ['jt', 'viettel']) {
    await assert.rejects(() => adapters[id].quoteShippingFee(settings, { ...order, city: 'Hà Nội' }, response({ code: 401, status: 401, error: true, success: false })), e => e.status === 502, id);
  }
  for (const [id, data] of [['jt', { code: '1', data: {} }]]) {
    await assert.rejects(() => adapters[id].quoteShippingFee(settings, order, response(data)), e => e.status === 502, id);
  }
  await assert.rejects(() => adapters.spx.quoteShippingFee(settings, {}, response({})), e => e.status === 501);
});

test('negative and unknown status words cannot be mistaken for successful delivery', () => {
  for (const value of ['undelivered', 'unsuccessful', 'delivery_success_pending', 'not_received', 'unknown', 'delivery_fail', 'success', 'finish', 'received']) assert.equal(normalizeCarrierStatus('spx', value), 'pending', value);
  assert.equal(normalizeCarrierStatus('spx', 'delivered'), 'delivered');
});
