'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { completeDeliveredOrder } = require('../src/order-delivery');
const { applyCarrierDeliveryTransition } = require('../src/shipping-management');

function mockTransaction() {
  const calls = [];
  return {
    calls,
    client: {
      async query(sql, params = []) {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
    }
  };
}

test('four steps: verified COD delivery automatically completes fulfillment but not payment', async () => {
  const { client, calls } = mockTransaction();
  const status = await applyCarrierDeliveryTransition(client, {
    order_id: 'order-cod',
    orderStatus: 'shipped',
    orderPaymentMethod: 'cod',
    orderPaymentStatus: 'pending',
    orderCustomerId: null,
    orderTotalVnd: 250000,
    orderReturnCompletedAt: null
  }, 'delivered', { username: 'carrier_webhook' });
  assert.equal(status, 'completed');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['order-cod', 'completed']);
  assert.match(calls[0].sql, /delivered_at/);
  const allSql = calls.map(c => c.sql).join('\n');
  assert.doesNotMatch(allSql, /payment_status\s*=|cod_settlement_status\s*=|INSERT INTO sales_receipts|UPDATE payment_attempts/i);
});

test('four steps: prepaid verified delivery completes without changing the already paid status', async () => {
  const { client, calls } = mockTransaction();
  const status = await applyCarrierDeliveryTransition(client, {
    order_id: 'order-paid',
    orderStatus: 'shipped',
    orderPaymentMethod: 'vnpay',
    orderPaymentStatus: 'paid',
    orderCustomerId: null,
    orderTotalVnd: 450000
  }, 'delivered', { username: 'carrier_webhook' });
  assert.equal(status, 'completed');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['order-paid', 'completed']);
});

test('four steps: manual delivery succeeds on shipped COD and is idempotent on replay', async () => {
  const { client, calls } = mockTransaction();
  const shipped = {
    id: 'manual-cod',
    status: 'shipped',
    payment_status: 'pending',
    payment_method: 'cod',
    total_vnd: 180000,
    customer_id: null
  };
  const first = await completeDeliveredOrder(client, shipped);
  assert.equal(first.orderStatus, 'completed');
  assert.equal(first.changed, true);
  assert.equal(first.paymentStatus, 'pending');
  const again = await completeDeliveredOrder(client, { ...shipped, status: 'completed' });
  assert.equal(again.orderStatus, 'completed');
  assert.equal(again.changed, false);
  assert.equal(calls.filter(c => /SET status = \$2/.test(c.sql)).length, 1);
  assert.equal(calls.length, 2);
});

test('four steps: cancellation and completed returns never advance to delivered', async () => {
  const blocked = [
    { id: 'cancelled-order', status: 'cancelled', payment_status: 'pending' },
    { id: 'returned-order', status: 'shipped', payment_status: 'paid', return_completed_at: new Date().toISOString() }
  ];
  for (const row of blocked) {
    const { client, calls } = mockTransaction();
    const result = await completeDeliveredOrder(client, row);
    assert.equal(result.blocked, true);
    assert.equal(result.changed, false);
    assert.equal(calls.length, 0);
  }
});

test('four steps: delivery is not confirmed merely because a waybill is delivering', async () => {
  const { client, calls } = mockTransaction();
  const next = await applyCarrierDeliveryTransition(client, {
    order_id: 'order-shipping',
    orderStatus: 'confirmed',
    orderPaymentMethod: 'cod',
    orderPaymentStatus: 'pending'
  }, 'delivering');
  assert.equal(next, 'shipped');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['order-shipping', 'shipped']);
  assert.doesNotMatch(calls[0].sql, /delivered_at/);
});

test('four steps: unpaid prepaid orders are not marked delivered by an unrelated event', async () => {
  const { client, calls } = mockTransaction();
  const next = await applyCarrierDeliveryTransition(client, {
    order_id: 'order-prepaid-unpaid',
    orderStatus: 'shipped',
    orderPaymentMethod: 'vnpay',
    orderPaymentStatus: 'pending'
  }, 'delivered');
  assert.equal(next, 'shipped');
  assert.equal(calls.length, 0);
});
