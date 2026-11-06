'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createStoreApi } = require('../src/store-api');

test('GAERU-05: GET /products and public catalog routes do NOT trigger payment queries', async (t) => {
  let paymentChannelQueries = 0;
  let ordersEnabledQueries = 0;
  let vnpayQueries = 0;

  const mockPool = {
    async query(sql) {
      if (sql.includes('FROM products')) {
        return { rows: [] };
      }
      if (sql.includes('FROM store_settings')) {
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const app = express();
  app.use('/api', createStoreApi(mockPool, {
    getPaymentChannels: async () => {
      paymentChannelQueries++;
      return { methods: ['cod'], configs: {}, callbackConfigs: {} };
    },
    getOrdersEnabled: async () => {
      ordersEnabledQueries++;
      return true;
    },
    getVnpayConfig: async () => {
      vnpayQueries++;
      return null;
    }
  }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  // 1. Browsing catalog products multiple times
  const r1 = await fetch(`${base}/products`);
  assert.equal(r1.status, 200);

  const r2 = await fetch(`${base}/products/gaeru-k9`);
  assert.equal(r2.status, 404); // product not found in mock, but route executed without payment queries

  const rStock = await fetch(`${base}/stock/TEST-SKU`);
  assert.equal(rStock.status, 200);

  // Assert ZERO payment queries executed during catalog browsing and stock lookup!
  assert.equal(paymentChannelQueries, 0, 'Catalog browsing must never trigger payment channel DB queries');
  assert.equal(ordersEnabledQueries, 0, 'Catalog browsing must never trigger ordersEnabled DB queries');
  assert.equal(vnpayQueries, 0, 'Catalog browsing must never trigger vnpay DB queries');

  // 2. Accessing checkout settings MUST trigger and resolve configs
  const rCheckout = await fetch(`${base}/settings/public`);
  assert.equal(rCheckout.status, 200);
  assert.equal(paymentChannelQueries, 1, 'Checkout route properly triggers payment channel query');

  // 3. Subsequent checkout calls within TTL share the in-memory cached config
  const rCheckout2 = await fetch(`${base}/settings/public`);
  assert.equal(rCheckout2.status, 200);
  assert.equal(paymentChannelQueries, 1, 'Subsequent checkout within 10s TTL uses cache, preventing DB storm');
});
