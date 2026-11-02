const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { seal } = require('../src/totp');
const shipping = require('../src/shipping-choice');
const {
  createShippingManagement,
  createWaybill,
  cancelWaybill,
  syncShipmentTracking,
  handleCarrierWebhook,
  quoteShippingFee
} = require('../src/shipping-management');
const { jtAdapter, viettelAdapter, ghnAdapter, ghtkAdapter, spxAdapter } = require('../src/shipping-adapters');

const ENCRYPTION_KEY = process.env.AUTH_ENCRYPTION_KEY || 'test-session-secret-key-12345';

function makeConfig() {
  return {
    AUTH_PEPPER: 'test-pepper-12345678901234567890',
    SESSION_SECRET: ENCRYPTION_KEY,
    adminKey: Buffer.from('test-admin-key-12345678901234567890123456789012'),
    accountSecurity: {
      authorize: async (_req, callback) => callback(null, null)
    }
  };
}

async function setupTestDb(t) {
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) {
      if (!values && sql.includes(';')) {
        return (await db.exec(sql)).at(-1);
      }
      return db.query(sql, values);
    },
    async connect() {
      return {
        query: (sql, values) => pool.query(sql, values),
        release() {}
      };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);
  return pool;
}

test('Shipping Carriers Acceptance: J&T adapter verification, supported set and available carriers', async t => {
  const pool = await setupTestDb(t);
  const config = makeConfig();

  // Verify J&T connection check with mock fetcher
  const fetchCalls = [];
  const mockFetcher = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return {
      ok: true,
      text: async () => JSON.stringify({ code: '1', desc: 'success', data: { details: [] } })
    };
  };

  const result = await shipping.verifyCarrier('jt', {
    accountId: 'VIP0099',
    secret: 'jt_private_secret_key'
  }, { fetcher: mockFetcher });

  assert.equal(result.id, 'jt');
  assert.equal(result.name, 'J&T Express');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /jtexpress\.vn/);
  assert.equal(fetchCalls[0].opts.method, 'POST');

  // Verify missing accountId throws 409
  await assert.rejects(
    () => shipping.verifyCarrier('jt', { secret: 'secret' }, { fetcher: mockFetcher }),
    err => err.status === 409 && err.message.includes('Mã khách hàng')
  );

  // Verify availableCarriers returns J&T when enabled & verified
  const cipher = seal(JSON.stringify({
    accountId: 'VIP0099',
    partnerCode: 'PARTNER_JT',
    pickupName: 'GAERU Central',
    pickupPhone: '0901234567',
    pickupAddress: 'Hà Nội',
    secret: 'jt_secret'
  }), ENCRYPTION_KEY);

  await pool.query(
    "INSERT INTO store_settings(setting_key, setting_value) VALUES('private_admin:shipping_jt', $1)",
    [JSON.stringify({ version: 1, cipher })]
  );
  await pool.query(
    "INSERT INTO shipping_carrier_connections(carrier_id, config_version, verified_at, enabled) VALUES('jt', 1, now(), true)"
  );

  const available = await shipping.availableCarriers(pool);
  assert.ok(available.some(c => c.id === 'jt' && c.name === 'J&T Express'));
});

test('Shipping Carriers Acceptance: [P0] Create Waybill real API call with Idempotency enforcement', async t => {
  const pool = await setupTestDb(t);
  const config = makeConfig();

  // Seed J&T configuration
  const cipher = seal(JSON.stringify({
    accountId: 'VIP0099',
    pickupName: 'GAERU Kho',
    pickupPhone: '0901234567',
    pickupAddress: '123 Cầu Giấy, Hà Nội',
    secret: 'my_jt_secret'
  }), ENCRYPTION_KEY);

  await pool.query(
    "INSERT INTO store_settings(setting_key, setting_value) VALUES('private_admin:shipping_jt', $1)",
    [JSON.stringify({ version: 1, cipher })]
  );
  await pool.query(
    "INSERT INTO shipping_carrier_connections(carrier_id, config_version, verified_at, enabled) VALUES('jt', 1, now(), true)"
  );

  // Create an order
  const orderRes = await pool.query(
    `INSERT INTO orders (
       order_number, customer_name, email, phone, address, city,
       payment_method, payment_status, status, subtotal_vnd, total_vnd
     ) VALUES (
       'GR-20261102-TEST01', 'Nguyễn Văn A', 'a@example.com', '0912345678',
       'Số 10 Tràng Tiền', 'Hà Nội', 'cod', 'pending', 'confirmed', 250000, 275000
     ) RETURNING id`
  );
  const orderId = orderRes.rows[0].id;

  await pool.query(
    `INSERT INTO order_items (order_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES ($1, 'Micro GAERU Wireless', 'Lightning', 'M3-LT', 250000, 1, 250000)`,
    [orderId]
  );

  let jtApiCallCount = 0;
  const mockFetcher = async (url, opts) => {
    jtApiCallCount++;
    return {
      ok: true,
      json: async () => ({
        code: '1',
        desc: 'success',
        data: {
          mailno: '840012345678',
          txlogisticid: 'GR-20261102-TEST01',
          shippingFee: 25000,
          expectedDelivery: '2026-11-04'
        }
      })
    };
  };

  // 1. Create waybill first time
  const res1 = await createWaybill(pool, config, {
    orderId,
    carrierId: 'jt',
    autoShip: false,
    actor: { username: 'admin_test' },
    fetcher: mockFetcher
  });

  assert.equal(res1.success, true);
  assert.equal(res1.existing, false);
  assert.equal(res1.shipment.trackingNumber, '840012345678');
  assert.equal(res1.shipment.carrierId, 'jt');
  assert.equal(res1.shipment.codAmountVnd, 275000);
  assert.equal(jtApiCallCount, 1);

  // Order status should be transitioned to 'processing'
  const checkOrder = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  assert.equal(checkOrder.rows[0].status, 'processing');

  // Check database shipment record
  const checkShipment = await pool.query('SELECT * FROM carrier_shipments WHERE order_id = $1', [orderId]);
  assert.equal(checkShipment.rows.length, 1);
  assert.equal(checkShipment.rows[0].tracking_number, '840012345678');

  // 2. IDEMPOTENCY CHECK: Call createWaybill second time on the same order
  const res2 = await createWaybill(pool, config, {
    orderId,
    carrierId: 'jt',
    autoShip: false,
    actor: { username: 'admin_test' },
    fetcher: mockFetcher
  });

  assert.equal(res2.success, true);
  assert.equal(res2.existing, true);
  assert.equal(res2.shipment.trackingNumber, '840012345678');
  // API was NOT called again!
  assert.equal(jtApiCallCount, 1, 'Idempotency must prevent calling carrier API again');

  // Database shipment table still has only 1 row!
  const finalCheck = await pool.query('SELECT count(*)::int AS count FROM carrier_shipments WHERE order_id = $1', [orderId]);
  assert.equal(finalCheck.rows[0].count, 1);
});

test('Shipping Carriers Acceptance: [P0] Tracking sync & Webhook automatic status and COD settlement', async t => {
  const pool = await setupTestDb(t);
  const config = makeConfig();

  // Create order with COD payment pending
  const orderRes = await pool.query(
    `INSERT INTO orders (
       order_number, customer_name, email, phone, address, city,
       payment_method, payment_status, status, subtotal_vnd, total_vnd
     ) VALUES (
       'GR-20261102-TEST02', 'Trần Thị B', 'b@example.com', '0988776655',
       '456 Lê Lợi', 'Đà Nẵng', 'cod', 'pending', 'processing', 300000, 325000
     ) RETURNING id`
  );
  const orderId = orderRes.rows[0].id;

  // Insert active carrier shipment
  await pool.query(
    `INSERT INTO carrier_shipments (
       order_id, carrier_id, tracking_number, carrier_order_id,
       status, cod_amount_vnd, tracking_history
     ) VALUES ($1, 'viettel', 'VT88990011', 'GR-20261102-TEST02', 'created', 325000, '[]'::jsonb)`,
    [orderId]
  );

  let recordedPaymentOrderId = null;
  const mockFinance = {
    async recordFullOrderPayment(_client, id, _actor) {
      recordedPaymentOrderId = id;
    }
  };

  // 1. Webhook delivers 'delivering' status
  const webhookRes1 = await handleCarrierWebhook(pool, config, 'viettel', {
    ORDER_NUMBER: 'VT88990011',
    ORDER_STATUS: 'delivering',
    desc: 'Bưu tá đang phát hàng'
  }, { finance: mockFinance });

  assert.equal(webhookRes1.success, true);
  assert.equal(webhookRes1.normalizedStatus, 'delivering');

  // Verify order transitioned to 'shipped'
  const orderAfterDelivering = await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [orderId]);
  assert.equal(orderAfterDelivering.rows[0].status, 'shipped');
  assert.equal(orderAfterDelivering.rows[0].payment_status, 'pending');

  // 2. Webhook delivers 'delivered' (giao thành công)
  const webhookRes2 = await handleCarrierWebhook(pool, config, 'viettel', {
    ORDER_NUMBER: 'VT88990011',
    ORDER_STATUS: 'delivered',
    desc: 'Khách hàng đã nhận và thanh toán tiền'
  }, { finance: mockFinance });

  assert.equal(webhookRes2.success, true);
  assert.equal(webhookRes2.normalizedStatus, 'delivered');

  // Verify order transitioned to 'completed' and COD marked 'paid'
  const orderAfterDelivered = await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [orderId]);
  assert.equal(orderAfterDelivered.rows[0].status, 'completed');
  assert.equal(orderAfterDelivered.rows[0].payment_status, 'paid');
  assert.equal(recordedPaymentOrderId, orderId, 'Finance accounting hook must be triggered on COD delivery');
});

test('Shipping Carriers Acceptance: [P1] Cancel waybill and print carrier label redirection', async t => {
  const pool = await setupTestDb(t);
  const config = makeConfig();

  // Seed GHN configuration
  const cipher = seal(JSON.stringify({
    accountId: '12345',
    pickupName: 'GAERU Kho',
    pickupPhone: '0901234567',
    pickupAddress: 'Hà Nội',
    secret: 'ghn_token_secret'
  }), ENCRYPTION_KEY);

  await pool.query(
    "INSERT INTO store_settings(setting_key, setting_value) VALUES('private_admin:shipping_ghn', $1)",
    [JSON.stringify({ version: 1, cipher })]
  );

  const orderRes = await pool.query(
    `INSERT INTO orders (
       order_number, customer_name, email, phone, address, city,
       payment_method, payment_status, status, subtotal_vnd, total_vnd
     ) VALUES (
       'GR-20261102-TEST03', 'Hoàng Văn C', 'c@example.com', '0933221100',
       '789 Nguyễn Huệ', 'Hồ Chí Minh', 'bank_transfer', 'paid', 'processing', 500000, 520000
     ) RETURNING id`
  );
  const orderId = orderRes.rows[0].id;

  const labelUrl = 'https://online-gateway.ghn.vn/a5/public-api/printA5?token=GHN998877';
  await pool.query(
    `INSERT INTO carrier_shipments (
       order_id, carrier_id, tracking_number, carrier_order_id, label_url,
       status, cod_amount_vnd, tracking_history
     ) VALUES ($1, 'ghn', 'GHN998877', 'GHN998877', $2, 'created', 0, '[]'::jsonb)`,
    [orderId, labelUrl]
  );

  // 1. Test Carrier Label URL
  const { createOrderPrint } = require('../src/order-print');
  const printApp = express();
  printApp.use((req, res, next) => {
    req.admin = { permissions: ['orders.read'] };
    next();
  });
  printApp.use(createOrderPrint(pool));
  const server = printApp.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const labelResp = await fetch(`${base}/orders/${orderId}/carrier-label`, { redirect: 'manual' });
  assert.equal(labelResp.status, 302);
  assert.equal(labelResp.headers.get('location'), labelUrl);

  // 2. Test Cancel Waybill
  let cancelCalled = false;
  const mockFetcher = async (url, opts) => {
    cancelCalled = true;
    return {
      ok: true,
      json: async () => ({ code: 200, message: 'Success' })
    };
  };

  const cancelResult = await cancelWaybill(pool, config, {
    orderId,
    reason: 'Khách muốn đổi sang giao hỏa tốc',
    actor: { username: 'admin_test' },
    fetcher: mockFetcher
  });

  assert.equal(cancelResult.success, true);
  assert.equal(cancelResult.cancelled, true);
  assert.equal(cancelCalled, true);

  // Check database shipment marked cancelled
  const checkShipment = await pool.query('SELECT status FROM carrier_shipments WHERE order_id = $1', [orderId]);
  assert.equal(checkShipment.rows[0].status, 'cancelled');
});

test('Shipping Carriers Acceptance: [P1] Realtime fee quote with LRU Cache and graceful rate table fallback', async t => {
  const pool = await setupTestDb(t);
  const config = makeConfig();

  // Set standard rate table in store_settings
  await pool.query(
    "UPDATE store_settings SET setting_value = '{\"Hà Nội\": 20000, \"Hồ Chí Minh\": 30000}' WHERE setting_key = 'shipping_rates'"
  );

  // Seed GHTK
  const cipher = seal(JSON.stringify({
    accountId: 'GHTK123',
    pickupName: 'GAERU Kho',
    pickupPhone: '0901234567',
    pickupAddress: 'Hà Nội',
    secret: 'ghtk_secret_token'
  }), ENCRYPTION_KEY);

  await pool.query(
    "INSERT INTO store_settings(setting_key, setting_value) VALUES('private_admin:shipping_ghtk', $1)",
    [JSON.stringify({ version: 1, cipher })]
  );

  let ghtkApiCallCount = 0;
  const mockFetcher = async (url, opts) => {
    ghtkApiCallCount++;
    return {
      ok: true,
      json: async () => ({
        success: true,
        fee: { fee: 22000 }
      })
    };
  };

  // 1. First quote call - fetches from carrier
  const quote1 = await quoteShippingFee(pool, config, {
    carrierId: 'ghtk',
    city: 'Hà Nội',
    weightGrams: 500,
    totalVnd: 200000,
    fetcher: mockFetcher
  });

  assert.equal(quote1.feeVnd, 22000);
  assert.equal(quote1.source, 'carrier_realtime');
  assert.equal(ghtkApiCallCount, 1);

  // 2. Second quote call - hits RAM LRU cache
  const quote2 = await quoteShippingFee(pool, config, {
    carrierId: 'ghtk',
    city: 'Hà Nội',
    weightGrams: 500,
    totalVnd: 200000,
    fetcher: mockFetcher
  });

  assert.equal(quote2.feeVnd, 22000);
  assert.equal(ghtkApiCallCount, 1, 'Cache must prevent redundant API calls');

  // 3. Fallback Test: Carrier API failure falls back to rate table
  const failingFetcher = async () => {
    throw new Error('Carrier timeout 504');
  };

  const fallbackQuote = await quoteShippingFee(pool, config, {
    carrierId: 'ghtk',
    city: 'Hồ Chí Minh',
    weightGrams: 500,
    totalVnd: 200000,
    fetcher: failingFetcher
  });

  assert.equal(fallbackQuote.feeVnd, 30000, 'Must fall back to 30000 VND from shipping_rates table');
  assert.equal(fallbackQuote.source, 'fallback_rate_table');
  assert.ok(fallbackQuote.warning, 'Must provide warning message on fallback');
});
