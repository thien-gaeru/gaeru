'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

test('Forensic Audit: safeTokenEqual resists Unicode multi-byte length differences without throwing RangeError', async () => {
  const { createRmaApi, generateRmaToken, updateRmaInboundTracking } = require('../src/rma-tickets');
  
  const tokenA = generateRmaToken(); // 48 hex chars
  const unicodeToken = 'é'.repeat(48); // 48 chars, but 96 bytes!

  // Calling timingSafeEqual directly with different byte lengths would throw RangeError:
  assert.throws(() => {
    crypto.timingSafeEqual(Buffer.from(tokenA), Buffer.from(unicodeToken));
  }, { name: 'RangeError' });

  // 1. Direct unit test of updateRmaInboundTracking with unicode token
  const mockClient = {
    query: async (sql) => {
      if (sql.includes('SELECT id FROM order_after_sales')) return { rows: [{ id: 'case-1' }] };
      if (sql.includes('SELECT order_id FROM order_after_sales')) return { rows: [{ order_id: 'order-1' }] };
      if (sql.includes('FROM orders')) return { rows: [{ id: 'order-1', customer_id: 'cust-1' }] };
      if (sql.includes('SELECT * FROM order_after_sales')) {
        return {
          rows: [{
            id: 'case-1',
            order_id: 'order-1',
            rma_number: 'RMA-261102-TEST',
            rma_token: tokenA,
            status: 'approved',
            customer_id: 'cust-1'
          }]
        };
      }
      return { rows: [] };
    }
  };

  const poolWrapper = {
    connect: async () => ({
      query: mockClient.query,
      release: () => {}
    })
  };

  await assert.rejects(
    async () => {
      await updateRmaInboundTracking(poolWrapper, {
        rmaNumber: 'RMA-261102-TEST',
        token: unicodeToken,
        inboundCarrier: 'Viettel Post',
        inboundTrackingNumber: 'VT123456789'
      });
    },
    (err) => {
      // Must throw 403 Forbidden, NOT RangeError 500
      assert.equal(err.status, 403);
      assert.match(err.message, /Mã xác thực RMA \(Token\) không hợp lệ/);
      return true;
    }
  );

  // 2. HTTP route test with Express app and fetch
  const mockPool = {
    query: async () => ({
      rows: [{
        id: '11111111-1111-1111-1111-111111111111',
        rma_number: 'RMA-261102-TEST',
        rma_token: tokenA,
        status: 'approved',
        phone: '0912345678',
        customer_name: 'Nguyen Van A',
        email: 'test@example.com',
        city: 'Ha Noi'
      }]
    })
  };

  const app = express();
  const { publicApi } = createRmaApi(mockPool);
  app.use('/api', publicApi);

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rma/RMA-261102-TEST?token=${encodeURIComponent(unicodeToken)}`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.ok(body.error);
  } finally {
    server.close();
  }
});

test('Forensic Audit: calculateInventoryForecast parameterizes warehouseId without SQL injection risk', async () => {
  const { calculateInventoryForecast } = require('../src/inventory-forecast');

  let executedSql = '';
  let executedParams = [];

  const mockPool = {
    query: async (sql, params) => {
      executedSql += ' ' + sql;
      executedParams.push(...(params || []));

      if (sql.includes('FROM warehouses')) {
        return { rows: [{ id: 'wh-1', code: 'MAIN', name: 'Kho Tong', active: true }] };
      }
      if (sql.includes('FROM product_variants')) {
        return { rows: [] };
      }
      if (sql.includes('osa_sales')) {
        return { rows: [] };
      }
      if (sql.includes('purchase_order_items')) {
        return { rows: [] };
      }
      if (sql.includes('inventory_reorder_settings')) {
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  await calculateInventoryForecast(mockPool, {
    warehouseId: '11111111-1111-1111-1111-111111111111',
    search: 'Ao Khoac',
    useCache: false
  });

  // Verify that warehouseId is NOT interpolated as a raw literal in the stock query
  assert.ok(!executedSql.includes("'11111111-1111-1111-1111-111111111111'"));
  assert.ok(executedParams.includes('11111111-1111-1111-1111-111111111111'));
  assert.ok(executedParams.includes('%ao khoac%'));
});

test('Forensic Audit: Bank transfer reconciliation fallback queries orders when payment_attempts is missing', async () => {
  const { reconcilePrepaidOrder } = require('../src/payment-channels');

  let orderUpdated = false;
  let attemptInserted = false;

  const mockClient = {
    query: async (sql, params) => {
      if (sql.includes('SELECT p.id') && sql.includes('payment_attempts')) {
        // Return no initial attempt
        return { rows: [] };
      }
      if (sql.includes('SELECT id AS "orderId"') && sql.includes('FROM orders')) {
        // Return existing order matching bank_transfer
        return {
          rows: [{
            orderId: 'order-uuid-123',
            orderNumber: 'GR-20261102-BT01',
            orderStatus: 'pending',
            paymentMethod: 'bank_transfer',
            subtotalVnd: 500000,
            shippingFeeVnd: 30000,
            discountVnd: 0,
            totalVnd: 530000,
            paymentStatus: 'pending'
          }]
        };
      }
      if (sql.includes('INSERT INTO payment_attempts')) {
        attemptInserted = true;
        return { rows: [{ id: 'attempt-uuid-456', amountVnd: 530000, attemptStatus: 'pending' }] };
      }
      if (sql.includes('UPDATE payment_attempts SET status=$2')) {
        return { rows: [] };
      }
      if (sql.includes("UPDATE orders SET payment_status='paid'")) {
        orderUpdated = true;
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const result = await reconcilePrepaidOrder(mockClient, {
    provider: 'bank_transfer',
    orderNumber: 'GR-20261102-BT01',
    amountVnd: 530000,
    successful: true,
    providerTransactionId: 'VCB_TXN_9999',
    actor: { username: 'casso_webhook', source: 'bank_transfer_webhook' },
    audit: async () => {}
  });

  assert.equal(result.matched, true);
  assert.equal(result.successful, true);
  assert.equal(result.paymentStatus, 'paid');
  assert.equal(attemptInserted, true);
  assert.equal(orderUpdated, true);
});
