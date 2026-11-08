'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { seal } = require('../src/totp');
const { handleCarrierWebhook, applyCarrierDeliveryTransition } = require('../src/shipping-management');

test('Fulfillment 4 bước & Tự động hoàn thành nghiệm thu khi nhận phản hồi giao thành công từ vận chuyển', async (t) => {
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) {
      return !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : db.query(sql, values);
    },
    async connect() {
      return { query: pool.query, release() {} };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);

  const config = { SESSION_SECRET: 'fulfillment-4steps-test-secret-32-chars' };
  const webhookSecret = 'viettel-webhook-4step-secret-key';
  const encrypted = JSON.stringify({
    version: 1,
    cipher: seal(JSON.stringify({ secret: 'test-token', webhookSecret }), config.SESSION_SECRET)
  });
  await pool.query("INSERT INTO store_settings(setting_key, setting_value) VALUES('private_admin:shipping_viettel', $1)", [encrypted]);

  // 1. Kiểm tra đơn COD: khi vận chuyển gửi webhook delivered -> tự động nghiệm thu hoàn thành (completed)
  const codOrder = (await pool.query(`
    INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
    VALUES('ORD-4STEP-COD', 'Nguyễn Văn A', 'a@example.com', '0901234567', '123 Phố Huế', 'Hà Nội', 'cod', 'pending', 'shipped', 250000, 30000, 280000)
    RETURNING id
  `)).rows[0];

  await pool.query(`
    INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, carrier_order_id, status, cod_amount_vnd)
    VALUES($1, 'viettel', 'VT-4STEP-01', 'ORD-4STEP-COD', 'delivering', 280000)
  `, [codOrder.id]);

  const whRes = await handleCarrierWebhook(pool, config, 'viettel', {
    ORDER_NUMBER: 'VT-4STEP-01',
    ORDER_STATUS: 'delivered',
    NOTE: 'Bưu tá đã giao hàng thành công và thu tiền'
  }, { headers: { 'x-webhook-secret': webhookSecret } });

  assert.equal(whRes.success, true);
  assert.equal(whRes.normalizedStatus, 'delivered');

  const afterCodDelivery = (await pool.query('SELECT status, payment_status, delivered_at FROM orders WHERE id = $1', [codOrder.id])).rows[0];
  assert.equal(afterCodDelivery.status, 'completed', 'Bước 4: Đơn COD tự động xác nhận hoàn thành nghiệm thu khi nhận phản hồi giao thành công');
  assert.equal(afterCodDelivery.payment_status, 'paid', 'Bưu tá giao thành công & thu tiền COD -> payment_status tự động cập nhật paid');
  assert.ok(afterCodDelivery.delivered_at, 'Ghi nhận mốc thời gian giao hàng & nghiệm thu delivered_at');

  // 2. Kiểm tra đơn trả trước: khi vận chuyển báo delivered -> tự động nghiệm thu hoàn thành (completed)
  const prepaidOrder = (await pool.query(`
    INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
    VALUES('ORD-4STEP-PREPAID', 'Trần Thị B', 'b@example.com', '0907654321', '456 Lê Lợi', 'Đà Nẵng', 'bank_transfer', 'paid', 'shipped', 500000, 0, 500000)
    RETURNING id
  `)).rows[0];

  await pool.query(`
    INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, carrier_order_id, status, cod_amount_vnd)
    VALUES($1, 'viettel', 'VT-4STEP-02', 'ORD-4STEP-PREPAID', 'delivering', 0)
  `, [prepaidOrder.id]);

  const whResPrepaid = await handleCarrierWebhook(pool, config, 'viettel', {
    ORDER_NUMBER: 'VT-4STEP-02',
    ORDER_STATUS: 'delivered',
    NOTE: 'Giao hàng thành công tới tay khách'
  }, { headers: { 'x-webhook-secret': webhookSecret } });

  assert.equal(whResPrepaid.success, true);
  const afterPrepaidDelivery = (await pool.query('SELECT status, payment_status, delivered_at FROM orders WHERE id = $1', [prepaidOrder.id])).rows[0];
  assert.equal(afterPrepaidDelivery.status, 'completed', 'Bước 4: Đơn trả trước tự động xác nhận hoàn thành nghiệm thu');
  assert.equal(afterPrepaidDelivery.payment_status, 'paid');
  assert.ok(afterPrepaidDelivery.delivered_at, 'Ghi nhận mốc delivered_at');
});

test('Kiểm tra hàm applyCarrierDeliveryTransition với các trạng thái 4 bước', async () => {
  const updates = [];
  const mockClient = {
    query: async (sql, params) => {
      updates.push({ sql, params });
      return { rows: [] };
    }
  };

  const shipment = {
    order_id: 'mock-order-id',
    orderStatus: 'shipped',
    orderPaymentMethod: 'cod',
    orderPaymentStatus: 'pending',
    orderTotalVnd: 350000,
    orderCustomerId: null
  };

  const finalStatus = await applyCarrierDeliveryTransition(mockClient, shipment, 'delivered', { username: 'test_actor' });
  assert.equal(finalStatus, 'completed', 'Tự động nghiệm thu hoàn thành khi hãng báo delivered');
  assert.ok(updates.some(u => u.params && u.params.includes('completed')), 'Query cập nhật status = completed');
  assert.ok(updates.some(u => u.params && u.params.includes('paid')), 'Query cập nhật payment_status = paid');
});
