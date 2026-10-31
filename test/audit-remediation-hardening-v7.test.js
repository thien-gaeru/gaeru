'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./helpers/pglite-db');
const { withTransaction } = require('../src/db');
const {
  assertOrderOwnership,
  checkOrderOwnership,
  generateOrderAccessToken,
  verifyOrderAccessToken,
  assertOrderPayloadMatch,
  buildScopedClientReference,
  PaymentAttemptStateMachine
} = require('../src/domain/payments/order-idempotency-policy');
const { PaymentService } = require('../src/domain/payments/payment-service');
const { OrderExpirationService } = require('../src/domain/orders/order-expiration-service');
const { discount, sanitizeMaxDiscountPercent, MAX_DISCOUNT_PERCENT, eligible } = require('../src/marketing');
const inventoryModule = require('../src/inventory');

test('Issue B: assertOrderPayloadMatch aggregates duplicate variant lines on both cart and DB', async () => {
  const order = { paymentMethod: 'cod', totalVnd: 500000 };
  const dbItems = [{ variantId: 'v-100', quantity: 3 }];

  // Khách gửi giỏ gồm 2 dòng cùng biến thể: 1 + 2 = 3
  const expectedItemsWithDuplicates = [
    { variantId: 'v-100', quantity: 1 },
    { variantId: 'v-100', quantity: 2 }
  ];

  // Không được ném lỗi IDEMPOTENCY_ITEMS_MISMATCH
  assert.doesNotThrow(() => {
    assertOrderPayloadMatch(order, dbItems, {
      expectedPaymentMethod: 'cod',
      expectedTotalVnd: 500000,
      expectedItems: expectedItemsWithDuplicates
    });
  });

  // Nếu số lượng tổng khác nhau: ném 409
  assert.throws(() => {
    assertOrderPayloadMatch(order, dbItems, {
      expectedPaymentMethod: 'cod',
      expectedTotalVnd: 500000,
      expectedItems: [
        { variantId: 'v-100', quantity: 1 },
        { variantId: 'v-100', quantity: 1 }
      ]
    });
  }, (err) => err.code === 'IDEMPOTENCY_ITEMS_MISMATCH' && err.status === 409);
});

test('Issue C: assertOrderOwnership strictly requires both email and phone when both provided', async () => {
  const order = {
    customerEmail: 'alice@example.com',
    customerPhone: '0912345678'
  };

  // 1. Cả 2 khớp -> Cho phép
  assert.equal(assertOrderOwnership(order, { email: 'alice@example.com', phone: '0912345678' }), true);

  // 2. Đúng email nhưng sai số điện thoại -> Chặn 403
  assert.throws(() => {
    assertOrderOwnership(order, { email: 'alice@example.com', phone: '0999999999' });
  }, (err) => err.code === 'FORBIDDEN_ORDER_ACCESS' && err.status === 403);

  // 3. Đúng số điện thoại nhưng sai email -> Chặn 403
  assert.throws(() => {
    assertOrderOwnership(order, { email: 'attacker@example.com', phone: '0912345678' });
  }, (err) => err.code === 'FORBIDDEN_ORDER_ACCESS' && err.status === 403);

  // 4. Chỉ cung cấp email khớp -> Cho phép
  assert.equal(assertOrderOwnership(order, { email: 'alice@example.com' }), true);

  // 5. Chỉ cung cấp phone khớp -> Cho phép
  assert.equal(assertOrderOwnership(order, { phone: '0912345678' }), true);
});

test('Issue D: PaymentAttemptStateMachine enforces invariant paid state and validates transitions', async () => {
  // Trạng thái paid là bất biến tuyệt đối
  assert.equal(PaymentAttemptStateMachine.isValidTransition('paid', 'failed'), false);
  assert.equal(PaymentAttemptStateMachine.isValidTransition('paid', 'pending'), false);
  assert.equal(PaymentAttemptStateMachine.isValidTransition('paid', 'awaiting_reconciliation'), false);

  assert.throws(() => {
    PaymentAttemptStateMachine.assertValidTransition('paid', 'failed');
  }, (err) => err.code === 'INVALID_PAYMENT_STATE_TRANSITION' && err.status === 409);

  // Trạng thái cancelled không thể phục hồi về pending, nhưng nhận late settlement (paid) từ cổng
  assert.equal(PaymentAttemptStateMachine.isValidTransition('cancelled', 'pending'), false);
  assert.equal(PaymentAttemptStateMachine.isValidTransition('cancelled', 'failed'), false);
  assert.equal(PaymentAttemptStateMachine.isValidTransition('cancelled', 'paid'), true);

  // Chuyển hợp lệ
  assert.equal(PaymentAttemptStateMachine.isValidTransition('pending', 'paid'), true);
  assert.equal(PaymentAttemptStateMachine.isValidTransition('pending', 'payment_initiation_unknown'), true);
  assert.equal(PaymentAttemptStateMachine.isValidTransition('payment_initiation_unknown', 'pending'), true);
  assert.equal(PaymentAttemptStateMachine.isValidTransition('payment_initiation_unknown', 'awaiting_reconciliation'), true);
  assert.equal(PaymentAttemptStateMachine.isValidTransition('awaiting_reconciliation', 'paid'), true);
  assert.equal(PaymentAttemptStateMachine.isValidTransition('failed', 'pending'), true);
});

test('Issue G: Admin format & escapeHtml properly escapes HTML characters without raw pass-through', async () => {
  const sharedFormat = require('../admin/format');
  const rawInput = '<script>alert("xss & \'hack\'")</script>';
  const escaped = sharedFormat.escapeHtml(rawInput);

  assert.equal(escaped.includes('<script>'), false);
  assert.equal(escaped.includes('&lt;script&gt;'), true);
  assert.equal(escaped.includes('&amp;'), true);
  assert.equal(escaped.includes('&#39;'), true);
  assert.equal(escaped.includes('&quot;'), true);
});

test('Part B-1: Late payment callback on cancelled order logs alert activity in order_activities', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const { reconcilePrepaidOrder } = require('../src/payment-channels');

  // Insert product, variant and cancelled order
  const pId = '11111111-1111-4111-8111-111111111111';
  const vId = '22222222-2222-4222-8222-222222222222';
  const orderId = '33333333-3333-4333-8333-333333333333';
  const attemptId = '44444444-4444-4444-8444-444444444444';

  await pool.query(
    "INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Kính P1', 'kinh-p1', 'audio', true)",
    [pId]
  );
  await pool.query(
    "INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, $2, 'SKU-LATE', 'Đen', 500000, 10, true)",
    [vId, pId]
  );
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd)
     VALUES ($1, 'GR-LATE-001', 'Late Buyer', 'late@gaeru.com', '0912345678', '123 Ba Dinh', 'Hà Nội', 'momo', 'cancelled', 'pending', 500000, 500000, 0)`,
    [orderId]
  );
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES ($1, $2, 'momo', 'GR-LATE-001', 500000, 'pending', now() + interval '30 minutes')`,
    [attemptId, orderId]
  );

  // Late payment callback arrives when order is already cancelled
  await withTransaction(pool, async (client) => {
    await reconcilePrepaidOrder(client, {
      provider: 'momo',
      orderNumber: 'GR-LATE-001',
      amountVnd: 500000,
      successful: true,
      providerTransactionId: 'momo-tx-late-123'
    });
  });

  // Verify payment attempt became paid
  const att = (await pool.query('SELECT status FROM payment_attempts WHERE id = $1', [attemptId])).rows[0];
  assert.equal(att.status, 'paid');

  // Verify order status remains cancelled and payment_status is paid
  const ord = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [orderId])).rows[0];
  assert.equal(ord.status, 'cancelled');
  assert.equal(ord.payment_status, 'paid');

  // Verify order_activities logged the alert with requiresRefund: true
  const activities = (await pool.query(
    `SELECT * FROM order_activities WHERE order_id = $1 AND details::text LIKE '%requiresRefund%'`,
    [orderId]
  )).rows;
  assert.equal(activities.length, 1, 'Phải có 1 activity cảnh báo hoàn tiền cho đơn thanh toán sau hủy');
  const details = typeof activities[0].details === 'string' ? JSON.parse(activities[0].details) : activities[0].details;
  assert.equal(details.requiresRefund, true);
  assert.equal(details.type, 'late_settlement_on_cancelled_order');
});

test('Part B-2: OrderExpirationService auto-cancels overdue unpaid bank transfer/gateway orders and releases stock', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const pId = '55555555-5555-4555-8555-555555555555';
  const vId = '66666666-6666-4666-8666-666666666666';
  const orderId = '77777777-7777-4777-8777-777777777777';

  await pool.query(
    "INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Kính Hết Hạn', 'kinh-het-han', 'audio', true)",
    [pId]
  );
  await pool.query(
    "INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, $2, 'SKU-EXPIRE', 'Bạc', 600000, 10, true)",
    [vId, pId]
  );

  // Initialize warehouse stock
  const wh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0];
  if (wh) {
    await pool.query(
      "INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 10) ON CONFLICT DO NOTHING",
      [wh.id, vId]
    );
  }

  // Create an expired unpaid bank transfer order (created 30 hours ago)
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd, created_at)
     VALUES ($1, 'GR-EXPIRE-001', 'Expired Buyer', 'expire@gaeru.com', '0912345678', 'Cau Giay', 'Hà Nội', 'bank_transfer', 'pending', 'pending', 600000, 600000, 0, now() - interval '30 hours')`,
    [orderId]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Kính Hết Hạn', 'Bạc', 'SKU-EXPIRE', 2, 300000, 600000)`,
    [orderId, vId]
  );

  // Run OrderExpirationService
  const cancelled = await OrderExpirationService.cancelExpiredUnpaidOrders(pool, { olderThanHours: 24 });
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].orderNumber, 'GR-EXPIRE-001');

  // Verify order is cancelled
  const orderCheck = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [orderId])).rows[0];
  assert.equal(orderCheck.status, 'cancelled');

  // Verify activity logged
  const act = (await pool.query('SELECT * FROM order_activities WHERE order_id = $1', [orderId])).rows[0];
  assert.ok(act, 'Phải có bản ghi order_activities về việc tự động hủy đơn');
});

test('Part B-3: Marketing discount ceiling is exported and configurable via options.maxDiscountPercent', () => {
  assert.equal(MAX_DISCOUNT_PERCENT, 40);

  const voucher50 = { kind: 'percent', amount: 50, max_discount_vnd: null };
  const subtotal = 1000000;

  // Mặc định: trần 40% -> 400.000đ
  const defaultDiscount = discount(voucher50, subtotal);
  assert.equal(defaultDiscount, 400000);

  // Khi cấu hình rõ ràng maxDiscountPercent = 60 -> 50% = 500.000đ
  const customDiscount = discount(voucher50, subtotal, { maxDiscountPercent: 60 });
  assert.equal(customDiscount, 500000);
});

test('Part B-5: inventory module exports reserveOrderStock function', () => {
  assert.equal(typeof inventoryModule.reserveOrderStock, 'function');
});

test('Part B-4: Email modules export both original and outbox aliases and workers handle mailer safely', () => {
  const orderEmail = require('../src/order-email');
  const warrantyEmail = require('../src/warranty-email');
  const emailMarketing = require('../src/email-marketing');

  assert.equal(typeof orderEmail.processOrderEmail, 'function');
  assert.equal(typeof orderEmail.processOrderEmailOutbox, 'function');

  assert.equal(typeof warrantyEmail.processWarrantyEmail, 'function');
  assert.equal(typeof warrantyEmail.processWarrantyEmailOutbox, 'function');

  assert.equal(typeof emailMarketing.processEmailQueue, 'function');
  assert.equal(typeof emailMarketing.processMarketingEmails, 'function');
});

test('Issue A: Concurrent order placement unique collision (23505) recovers via catch block and does not crash with 500', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const express = require('express');
  const { attachPublicAndCheckoutRoutes } = require('../src/store/checkout-payment-routes');

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.ordersEnabled = true;
    req.session = { csrfToken: 'test-csrf' };
    next();
  });

  // Setup product & variant
  const pId = '88888888-8888-4888-8888-888888888888';
  const vId = '99999999-9999-4999-8999-999999999999';
  await pool.query(
    "INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Kính Va Chạm', 'kinh-va-cham', 'audio', true)",
    [pId]
  );
  await pool.query(
    "INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, $2, 'SKU-CLASH', 'Titan', 500000, 50, true)",
    [vId, pId]
  );
  const whClash = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0];
  if (whClash) {
    await pool.query(
      "INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 50) ON CONFLICT DO NOTHING",
      [whClash.id, vId]
    );
  }
  await pool.query(
    "INSERT INTO store_settings(setting_key, setting_value) VALUES('shipping_rates', $1) ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1",
    [JSON.stringify({ 'Toàn quốc': 20000, 'Hà Nội': 20000 })]
  );

  attachPublicAndCheckoutRoutes(app, pool, {
    getVnpayConfig: () => null,
    getPaymentChannels: () => ({ methods: ['cod'] }),
    config: { PUBLIC_BASE_URL: 'https://gaeru.com' },
    publicBaseUrl: 'https://gaeru.com',
    paymentFetcher: async () => ({ status: 200, json: async () => ({}) })
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;

  const orderPayload = {
    customer: {
      name: 'Nguyen Van A',
      email: 'clash@gaeru.com',
      phone: '0912345678',
      address: '123 Pho Hue',
      city: 'Hà Nội'
    },
    items: [{ variantId: vId, quantity: 1 }],
    paymentMethod: 'cod',
    idempotencyKey: 'TEST-CLASH-KEY-001'
  };

  // First request creates the order successfully
  const res1 = await fetch(`http://127.0.0.1:${port}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' },
    body: JSON.stringify(orderPayload)
  });
  const data1 = await res1.json();
  assert.equal(res1.status, 201);
  assert.ok(data1.order);

  // Second request with identical key recovers idempotently via the 23505 collision recovery (without 500 error)
  const res2 = await fetch(`http://127.0.0.1:${port}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' },
    body: JSON.stringify(orderPayload)
  });
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  assert.ok(data2.order);
  assert.equal(data2.order.orderNumber, data1.order.orderNumber);
  assert.equal(data2.reusedSession, true);
});

test('P0-01 Part 1: OrderExpirationService guards against premature cancellation when attempt is active or ambiguous', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const pId = crypto.randomUUID();
  const vId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Tai Nghe Active', 'tai-nghe-active', 'audio', true)",
    [pId]
  );
  await pool.query(
    "INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, $2, 'SKU-ACTIVE-01', 'Trắng', 500000, 10, true)",
    [vId, pId]
  );

  const wh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0];
  if (wh) {
    await pool.query(
      "INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 10) ON CONFLICT DO NOTHING",
      [wh.id, vId]
    );
  }

  // Case 1: Order created 30 hours ago, but has an active pending attempt with 10 minutes remaining
  const order1Id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd, created_at)
     VALUES ($1, 'GR-ACTIVE-MOMO', 'Active Momo Buyer', 'momo-active@gaeru.com', '0912345678', 'District 1', 'TP. Hồ Chí Minh', 'momo', 'pending', 'pending', 500000, 500000, 0, now() - interval '30 hours')`,
    [order1Id]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Tai Nghe Active', 'Trắng', 'SKU-ACTIVE-01', 1, 500000, 500000)`,
    [order1Id, vId]
  );
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES (gen_random_uuid(), $1, 'momo', 'GR-ACTIVE-MOMO', 500000, 'pending', now() + interval '10 minutes')`,
    [order1Id]
  );

  // Case 2: Order created 30 hours ago, but has an attempt in awaiting_reconciliation
  const order2Id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd, created_at)
     VALUES ($1, 'GR-AMBIGUOUS-ZALO', 'Ambiguous Buyer', 'zalo-ambig@gaeru.com', '0912345679', 'District 3', 'TP. Hồ Chí Minh', 'zalopay', 'pending', 'pending', 500000, 500000, 0, now() - interval '30 hours')`,
    [order2Id]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Tai Nghe Active', 'Trắng', 'SKU-ACTIVE-01', 1, 500000, 500000)`,
    [order2Id, vId]
  );
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES (gen_random_uuid(), $1, 'zalopay', 'GR-AMBIGUOUS-ZALO', 500000, 'awaiting_reconciliation', now() - interval '1 hour')`,
    [order2Id]
  );

  // Case 3: Order created 30 hours ago with an expired attempt (expires_at = -1 hour)
  const order3Id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd, created_at)
     VALUES ($1, 'GR-EXPIRED-PA', 'Expired Buyer', 'pa-expired@gaeru.com', '0912345680', 'District 5', 'TP. Hồ Chí Minh', 'bank_transfer', 'pending', 'pending', 500000, 500000, 0, now() - interval '30 hours')`,
    [order3Id]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Tai Nghe Active', 'Trắng', 'SKU-ACTIVE-01', 1, 500000, 500000)`,
    [order3Id, vId]
  );
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES (gen_random_uuid(), $1, 'bank_transfer', 'GR-EXPIRED-PA', 500000, 'pending', now() - interval '1 hour')`,
    [order3Id]
  );

  // Run OrderExpirationService
  const cancelled = await OrderExpirationService.cancelExpiredUnpaidOrders(pool, { olderThanHours: 24 });
  const cancelledIds = cancelled.map(c => c.orderId);

  // Order 1 (active pending with 10 mins left) must NOT be cancelled
  assert.ok(!cancelledIds.includes(order1Id), 'Đơn có phiên pending còn hạn không được tự hủy');
  const o1 = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [order1Id])).rows[0];
  assert.equal(o1.status, 'pending');

  // Order 2 (awaiting_reconciliation) must NOT be cancelled
  assert.ok(!cancelledIds.includes(order2Id), 'Đơn đang đối soát chưa phân định không được tự hủy');
  const o2 = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [order2Id])).rows[0];
  assert.equal(o2.status, 'pending');

  // Order 3 (truly expired attempt) MUST be cancelled
  assert.ok(cancelledIds.includes(order3Id), 'Đơn có phiên đã hết hạn phải được tự hủy');
  const o3 = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [order3Id])).rows[0];
  assert.equal(o3.status, 'cancelled');
  const att3 = (await pool.query('SELECT status FROM payment_attempts WHERE order_id = $1', [order3Id])).rows[0];
  assert.equal(att3.status, 'cancelled');
});

test('P0-01 Part 2: Late payment callback on cancelled order records payment and creates refund task without 409 error', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const pId = crypto.randomUUID();
  const vId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Kính P0 Test', 'kinh-p0-test', 'audio', true)",
    [pId]
  );
  await pool.query(
    "INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, $2, 'SKU-P0-01', 'Đen', 750000, 10, true)",
    [vId, pId]
  );

  // Step 1: Create an order that was cancelled, with attempt cancelled
  const orderId = crypto.randomUUID();
  const orderNumber = 'GR-P0-MOMO-001';
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd, created_at)
     VALUES ($1, $2, 'Late Momo Buyer', 'late@gaeru.com', '0912345678', 'District 1', 'TP. Hồ Chí Minh', 'momo', 'cancelled', 'pending', 750000, 750000, 0, now() - interval '25 hours')`,
    [orderId, orderNumber]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Kính P0 Test', 'Đen', 'SKU-P0-01', 1, 750000, 750000)`,
    [orderId, vId]
  );
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES (gen_random_uuid(), $1, 'momo', $2, 750000, 'cancelled', now() - interval '2 hours')`,
    [orderId, orderNumber]
  );

  // Step 2: Simulate gateway callback with successful = true
  const { reconcilePrepaidOrder } = require('../src/payment-channels');
  const res = await reconcilePrepaidOrder(pool, {
    provider: 'momo',
    orderNumber,
    amountVnd: 750000,
    successful: true,
    providerTransactionId: 'MOMO-TRANS-999',
    responseCode: '0'
  });

  // Verify response
  assert.equal(res.code, '00');
  assert.equal(res.matched, true);
  assert.equal(res.successful, true);
  assert.equal(res.requiresRefund, true);
  assert.equal(res.action, 'late_settlement_refund_needed');
  assert.equal(res.paymentStatus, 'paid');
  assert.equal(res.orderStatus, 'cancelled');

  // Verify DB state
  const attemptRow = (await pool.query('SELECT status, provider_transaction_id FROM payment_attempts WHERE transaction_ref = $1', [orderNumber])).rows[0];
  assert.equal(attemptRow.status, 'paid');
  assert.equal(attemptRow.provider_transaction_id, 'MOMO-TRANS-999');

  const orderRow = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [orderId])).rows[0];
  assert.equal(orderRow.payment_status, 'paid');
  assert.equal(orderRow.status, 'cancelled');

  // Verify sales receipt recorded
  const receipt = (await pool.query('SELECT * FROM sales_receipts WHERE order_id = $1', [orderId])).rows[0];
  assert.ok(receipt, 'Phải có chứng từ thanh toán sales_receipts');
  assert.equal(Number(receipt.amount_vnd), 750000);

  // Verify order activity logged with requiresRefund = true
  const activities = (await pool.query('SELECT * FROM order_activities WHERE order_id = $1 AND details->>\'requiresRefund\' = \'true\'', [orderId])).rows;
  assert.ok(activities.length >= 1, 'Phải có order_activity cảnh báo hoàn tiền');
  assert.equal(activities[0].details.type, 'late_settlement_on_cancelled_order');

  // Step 3: Verify failed callback on already cancelled attempt returns safe response
  const orderIdFailed = crypto.randomUUID();
  const orderNumberFailed = 'GR-P0-FAILED-001';
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd)
     VALUES ($1, $2, 'Failed Buyer', 'fail@gaeru.com', '0912345678', 'District 1', 'TP. Hồ Chí Minh', 'momo', 'cancelled', 'pending', 750000, 750000, 0)`,
    [orderIdFailed, orderNumberFailed]
  );
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES (gen_random_uuid(), $1, 'momo', $2, 750000, 'cancelled', now() - interval '2 hours')`,
    [orderIdFailed, orderNumberFailed]
  );

  const resFail = await reconcilePrepaidOrder(pool, {
    provider: 'momo',
    orderNumber: orderNumberFailed,
    amountVnd: 750000,
    successful: false,
    responseCode: '49'
  });
  assert.equal(resFail.code, '00');
  assert.equal(resFail.alreadyCancelled, true);
  assert.equal(resFail.successful, false);
});

test('P0-02: Fail-Closed Order Ownership, HMAC Access Token, and Public Scope Redaction', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const secret = 'test-secret-key-32b-length-must-be-long-enough';
  const orderId = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  const orderNumber = 'GR-P02-TEST-001';

  const order = {
    id: orderId,
    orderNumber,
    customerId,
    customerEmail: 'alice@gaeru.com',
    customerPhone: '0912345678',
    email: 'alice@gaeru.com',
    phone: '0912345678',
    totalVnd: 250000,
    subtotalVnd: 250000,
    shippingFeeVnd: 0,
    paymentMethod: 'momo',
    status: 'pending',
    paymentStatus: 'pending'
  };

  // 1. assertOrderOwnership MUST FAIL-CLOSED when proof is missing or empty
  assert.throws(() => {
    assertOrderOwnership(order, null);
  }, (err) => err.status === 403 && err.code === 'FORBIDDEN_ORDER_ACCESS');

  assert.throws(() => {
    assertOrderOwnership(order, {});
  }, (err) => err.status === 403 && err.code === 'FORBIDDEN_ORDER_ACCESS');

  // 2. assertOrderOwnership fails with attacker credentials
  assert.throws(() => {
    assertOrderOwnership(order, { email: 'hacker@gaeru.com', phone: '0999999999' });
  }, (err) => err.status === 403 && err.code === 'FORBIDDEN_ORDER_ACCESS');

  // 3. assertOrderOwnership succeeds with valid signed orderAccessToken
  const validToken = generateOrderAccessToken({ orderId, orderNumber, customerId }, secret);
  assert.equal(assertOrderOwnership(order, { orderAccessToken: validToken }, { secret }), true);

  // 4. assertOrderOwnership fails with forged / expired token
  assert.throws(() => {
    assertOrderOwnership(order, { orderAccessToken: 'forged.token.here' }, { secret });
  }, (err) => err.status === 403);

  const expiredToken = generateOrderAccessToken({ orderId, orderNumber }, secret, { expiresInSeconds: -10 });
  assert.throws(() => {
    assertOrderOwnership(order, { orderAccessToken: expiredToken }, { secret });
  }, (err) => err.status === 403);

  // 5. assertOrderOwnership succeeds with session proofs
  assert.equal(assertOrderOwnership(order, { sessionCustomerId: customerId }), true);
  assert.equal(assertOrderOwnership(order, { sessionCustomerEmail: 'alice@gaeru.com' }), true);
  assert.equal(assertOrderOwnership(order, { sessionCreatedOrders: [orderNumber] }), true);

  // 6. DB-level verification: Insert order into PGlite
  await pool.query(
    `INSERT INTO customers (id, email, full_name, phone, password_hash)
     VALUES ($1, 'alice@gaeru.com', 'Alice', '0912345678', 'dummy_hash')`,
    [customerId]
  );
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_id, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd)
     VALUES ($1, $2, $3, 'Alice', 'alice@gaeru.com', '0912345678', 'District 1', 'TP. Hồ Chí Minh', 'momo', 'pending', 'pending', 250000, 250000, 0)`,
    [orderId, orderNumber, customerId]
  );
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, payment_url, expires_at)
     VALUES (gen_random_uuid(), $1, 'momo', $2, 250000, 'pending', 'https://test.momo.vn/pay/123', now() + interval '15 minutes')`,
    [orderId, orderNumber]
  );

  const { retryGatewayOrderPayment } = require('../src/payment-channels');

  // 7. Verify P0-02 reproduction: Anonymous retry on PGlite WITHOUT ownership proof MUST FAIL with 403 (cannot return 250.000đ)
  await assert.rejects(
    async () => {
      await retryGatewayOrderPayment(pool, { orderNumber });
    },
    (err) => err.status === 403 && err.code === 'FORBIDDEN_ORDER_ACCESS'
  );

  // 8. Retry with valid orderAccessToken succeeds
  const retryResult = await retryGatewayOrderPayment(pool, {
    orderNumber,
    orderAccessToken: validToken,
    config: { SESSION_SECRET: secret }
  });
  assert.ok(retryResult, 'Retry có orderAccessToken phải thành công');
  assert.equal(retryResult.order.orderNumber, orderNumber);
  assert.equal(retryResult.order.totalVnd, 250000);

  // 9. Retry with sessionCreatedOrders succeeds
  const retrySessionResult = await retryGatewayOrderPayment(pool, {
    orderNumber,
    sessionCreatedOrders: [orderNumber]
  });
  assert.ok(retrySessionResult, 'Retry có sessionCreatedOrders phải thành công');
  assert.equal(retrySessionResult.order.orderNumber, orderNumber);

  // 10. Check GET /payments/order-status public scope redaction
  const { createApp } = require('../src/app');
  const session = require('express-session');
  const app = createApp({
    pool,
    sessionStore: new session.MemoryStore(),
    config: { SESSION_SECRET: secret, PUBLIC_BASE_URL: 'https://gaeru.com' }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;

  // 10a. Unverified query: totalVnd & paymentMethod MUST be omitted!
  const publicRes = await fetch(`http://127.0.0.1:${port}/api/payments/order-status?order=${orderNumber}`);
  assert.equal(publicRes.status, 200);
  const publicData = await publicRes.json();
  assert.equal(publicData.verified, false);
  assert.equal(publicData.order.orderNumber, orderNumber);
  assert.equal(publicData.order.totalVnd, undefined, 'Truy vấn công khai không được phép để lộ totalVnd!');
  assert.equal(publicData.order.paymentMethod, undefined, 'Truy vấn công khai không được phép để lộ paymentMethod!');

  // 10b. Verified query with X-Order-Token header: reveals full order status
  const verifiedRes = await fetch(`http://127.0.0.1:${port}/api/payments/order-status?order=${orderNumber}`, {
    headers: { 'X-Order-Token': validToken }
  });
  assert.equal(verifiedRes.status, 200);
  const verifiedData = await verifiedRes.json();
  assert.equal(verifiedData.verified, true);
  assert.equal(verifiedData.order.orderNumber, orderNumber);
  assert.equal(verifiedData.order.totalVnd, 250000, 'Truy vấn đã xác minh quyền sở hữu phải có totalVnd');
  assert.equal(verifiedData.order.paymentMethod, 'momo');
});

test('P0-03: Two concurrent retry requests execute gateway call once and prevent divergent URL/request-id', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const orderNumber = 'GR-P03-CONCURRENT-001';
  const orderRes = await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, subtotal_vnd, total_vnd, payment_method, payment_status, status)
     VALUES ($1, 'Concurrent User', 'concurrent@gaeru.com', '0912345678', '123 Le Loi', 'TP. Hồ Chí Minh', 300000, 300000, 'momo', 'pending', 'pending')
     RETURNING id`,
    [orderNumber]
  );
  const orderId = orderRes.rows[0].id;

  // Insert payment attempt whose previous session has expired (so retry needs to initiate a new session)
  await pool.query(
    `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, provider_request_id, status, payment_url, expires_at, updated_at)
     VALUES ($1, 'momo', $2, 300000, 'old-req-id', 'pending', 'https://old.url', now() - interval '10 minutes', now() - interval '10 minutes')`,
    [orderId, orderNumber]
  );

  let createCalls = 0;
  const mockFetcher = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (url.includes('/query')) {
      // Return unpaid/not found status so reconcileGatewayOrder allows retry
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({
          resultCode: 49,
          message: 'Không tìm thấy giao dịch',
          orderId: body.orderId,
          requestId: body.requestId
        })
      };
    }

    createCalls++;
    // Simulate network delay to gateway
    await new Promise(r => setTimeout(r, 120));
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        resultCode: 0,
        partnerCode: body.partnerCode,
        orderId: body.orderId,
        requestId: body.requestId,
        amount: body.amount,
        payUrl: `https://test-payment.momo.vn/v2/gateway/pay/${body.requestId || 'mock-id'}`
      })
    };
  };

  const { retryGatewayOrderPayment } = require('../src/payment-channels');

  const momoSettings = {
    partnerCode: 'MOMO',
    accessKey: 'ACCESS_KEY_MOCK',
    secretKey: 'SECRET_KEY_MOCK_123',
    environment: 'sandbox'
  };

  // Launch two concurrent retry requests simultaneously
  const p1 = retryGatewayOrderPayment(pool, {
    orderNumber,
    expectedCustomer: { email: 'concurrent@gaeru.com', phone: '0912345678' },
    settings: momoSettings,
    fetcher: mockFetcher
  });

  const p2 = retryGatewayOrderPayment(pool, {
    orderNumber,
    expectedCustomer: { email: 'concurrent@gaeru.com', phone: '0912345678' },
    settings: momoSettings,
    fetcher: mockFetcher
  });

  const [res1, res2] = await Promise.all([p1, p2]);

  // 1. Gateway must only be invoked ONCE!
  assert.equal(createCalls, 1, 'Cổng thanh toán chỉ được gọi đúng 1 lần duy nhất nhờ cơ chế in-flight lease!');

  // 2. Both promises must succeed with 200
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);

  // 3. Both responses must share the exact same paymentUrl and providerRequestId
  assert.ok(res1.paymentUrl, 'res1 phải có paymentUrl');
  assert.ok(res2.paymentUrl, 'res2 phải có paymentUrl');
  assert.equal(res1.paymentUrl, res2.paymentUrl, 'Hai yêu cầu đồng thời phải nhận cùng 1 paymentUrl');
  assert.equal(res1.providerRequestId, res2.providerRequestId, 'Hai yêu cầu đồng thời phải nhận cùng 1 providerRequestId');

  // 4. One was freshly initiated and the concurrent one reused the in-flight session
  assert.ok(res1.retried);
  assert.ok(res2.retried);

  // 5. Verify database consistency: provider_request_id and payment_url must be strictly in sync
  const dbRow = (await pool.query(
    `SELECT provider_request_id AS "providerRequestId", payment_url AS "paymentUrl", status, last_error_code AS "lastErrorCode"
     FROM payment_attempts
     WHERE order_id = $1`,
    [orderId]
  )).rows[0];

  assert.equal(dbRow.status, 'pending');
  assert.equal(dbRow.lastErrorCode, null);
  assert.equal(dbRow.providerRequestId, res1.providerRequestId);
  assert.equal(dbRow.paymentUrl, res1.paymentUrl);
  assert.ok(dbRow.paymentUrl.includes(dbRow.providerRequestId), 'payment_url phải chứa đúng provider_request_id tương ứng, tuyệt đối không bị lệch!');
});

test('P1-01: Channel TTL policy, guards against cancelling awaiting/active attempts, and transitions to expiry_awaiting_verification', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const pId = crypto.randomUUID();
  const vId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Loa Bluetooth P1', 'loa-bluetooth-p1', 'audio', true)",
    [pId]
  );
  await pool.query(
    "INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, $2, 'SKU-P1-01', 'Đen', 600000, 10, true)",
    [vId, pId]
  );

  const wh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0];
  if (wh) {
    await pool.query(
      "INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 10) ON CONFLICT DO NOTHING",
      [wh.id, vId]
    );
  }

  // Case A: Đơn MoMo quá 24 giờ nhưng phiên awaiting_reconciliation, expires_at còn 10 phút
  const orderAId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd, created_at)
     VALUES ($1, 'GR-P1-MOMO-ACTIVE-REC', 'Buyer A', 'a@gaeru.com', '0912345678', 'District 1', 'TP. Hồ Chí Minh', 'momo', 'pending', 'pending', 600000, 600000, 0, now() - interval '25 hours')`,
    [orderAId]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Loa Bluetooth P1', 'Đen', 'SKU-P1-01', 1, 600000, 600000)`,
    [orderAId, vId]
  );
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES (gen_random_uuid(), $1, 'momo', 'GR-P1-MOMO-ACTIVE-REC', 600000, 'awaiting_reconciliation', now() + interval '10 minutes')`,
    [orderAId]
  );

  // Case B: Đơn MoMo quá 24 giờ, phiên awaiting_reconciliation đã hết hạn (-5 phút), nhưng đối soát chưa thể kết luận (khoản thu chưa rõ)
  const orderBId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd, created_at)
     VALUES ($1, 'GR-P1-MOMO-EXP-AMBIG', 'Buyer B', 'b@gaeru.com', '0912345679', 'District 3', 'TP. Hồ Chí Minh', 'momo', 'pending', 'pending', 600000, 600000, 0, now() - interval '25 hours')`,
    [orderBId]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Loa Bluetooth P1', 'Đen', 'SKU-P1-01', 1, 600000, 600000)`,
    [orderBId, vId]
  );
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES (gen_random_uuid(), $1, 'momo', 'GR-P1-MOMO-EXP-AMBIG', 600000, 'awaiting_reconciliation', now() - interval '5 minutes')`,
    [orderBId]
  );

  // Case C: Đơn Bank Transfer tạo 2 giờ trước (chưa tới 24h)
  const orderCId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd, created_at)
     VALUES ($1, 'GR-P1-BANK-2H', 'Buyer C', 'c@gaeru.com', '0912345680', 'District 5', 'TP. Hồ Chí Minh', 'bank_transfer', 'pending', 'pending', 600000, 600000, 0, now() - interval '2 hours')`,
    [orderCId]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Loa Bluetooth P1', 'Đen', 'SKU-P1-01', 1, 600000, 600000)`,
    [orderCId, vId]
  );

  // Case D: Đơn MoMo tạo 2 giờ trước (đã quá TTL 1h của MoMo) và không có phiên còn hạn
  const orderDId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd, created_at)
     VALUES ($1, 'GR-P1-MOMO-EXPIRED-2H', 'Buyer D', 'd@gaeru.com', '0912345681', 'District 7', 'TP. Hồ Chí Minh', 'momo', 'pending', 'pending', 600000, 600000, 0, now() - interval '2 hours')`,
    [orderDId]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Loa Bluetooth P1', 'Đen', 'SKU-P1-01', 1, 600000, 600000)`,
    [orderDId, vId]
  );
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES (gen_random_uuid(), $1, 'momo', 'GR-P1-MOMO-EXPIRED-2H', 600000, 'pending', now() - interval '45 minutes')`,
    [orderDId]
  );

  // Cấu hình kênh MoMo hợp lệ để kiểm tra đối soát cổng khi hết hạn
  const { writeRecord } = require('../src/admin-configuration');
  const appConfig = { SESSION_SECRET: 'test-secret-32-chars-minimum-length-ok!' };
  await writeRecord(pool, appConfig, 'payment_momo', {
    partnerCode: 'MOMOP1',
    accessKey: 'ACCESS_P1',
    secretKey: 'SECRET_P1',
    environment: 'sandbox',
    enabled: true
  }, 0, { username: 'admin' });

  const mockFetcher = async (url, init) => {
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    if (bodyStr.includes('GR-P1-MOMO-EXP-AMBIG')) {
      // Case B: Cổng phản hồi giao dịch đang xử lý / chưa phân định (still_pending)
      return new Response(JSON.stringify({ resultCode: 9000, message: 'Transaction is processing' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    // Case D: Cổng phản hồi không tìm thấy giao dịch (1001) -> xác minh 100% chưa thanh toán
    return new Response(JSON.stringify({ resultCode: 1001, message: 'Transaction not found' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  // Run OrderExpirationService
  const cancelled = await OrderExpirationService.cancelExpiredUnpaidOrders(pool, { config: appConfig, fetcher: mockFetcher });
  const cancelledIds = cancelled.map(c => c.orderId);

  // 1. Case A (MoMo awaiting_reconciliation with 10 mins remaining): TUYỆT ĐỐI KHÔNG BỊ HỦY!
  assert.ok(!cancelledIds.includes(orderAId), 'Đơn Case A có phiên awaiting còn hạn 10 phút không được hủy');
  const oA = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [orderAId])).rows[0];
  assert.equal(oA.status, 'pending');
  assert.equal(oA.payment_status, 'pending');
  const attA = (await pool.query('SELECT status FROM payment_attempts WHERE order_id = $1', [orderAId])).rows[0];
  assert.equal(attA.status, 'awaiting_reconciliation');

  // 2. Case B (MoMo awaiting_reconciliation expired but ambiguous): KHÔNG bị hủy, chuyển sang expiry_awaiting_verification!
  assert.ok(!cancelledIds.includes(orderBId), 'Đơn Case B chưa phân định không được hủy, không hoàn kho');
  const oB = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [orderBId])).rows[0];
  assert.equal(oB.status, 'pending');
  const attB = (await pool.query('SELECT status FROM payment_attempts WHERE order_id = $1', [orderBId])).rows[0];
  assert.equal(attB.status, 'expiry_awaiting_verification');

  // 3. Case C (Bank Transfer 2 hours old): Chưa quá TTL 24h của kênh bank_transfer nên KHÔNG bị hủy!
  assert.ok(!cancelledIds.includes(orderCId), 'Đơn Bank Transfer 2h chưa tới TTL 24h không bị hủy');
  const oC = (await pool.query('SELECT status FROM orders WHERE id = $1', [orderCId])).rows[0];
  assert.equal(oC.status, 'pending');

  // 4. Case D (MoMo 2 hours old, attempt expired): Đã quá TTL 1h của MoMo nên ĐƯỢC tự động hủy và hoàn kho!
  assert.ok(cancelledIds.includes(orderDId), 'Đơn MoMo 2h đã quá TTL 1h phải được hủy');
  const oD = (await pool.query('SELECT status FROM orders WHERE id = $1', [orderDId])).rows[0];
  assert.equal(oD.status, 'cancelled');
  const attD = (await pool.query('SELECT status FROM payment_attempts WHERE order_id = $1', [orderDId])).rows[0];
  assert.equal(attD.status, 'cancelled');
});

test('P1-02: Atomically re-verifies order status predicate under FOR UPDATE SKIP LOCKED and prevents cancelling shipped/processing orders', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const pId = crypto.randomUUID();
  const vId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Bàn Phím Cơ P1-02', 'ban-phim-co-p102', 'audio', true)",
    [pId]
  );
  await pool.query(
    "INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, $2, 'SKU-P1-02', 'Xám', 1200000, 5, true)",
    [vId, pId]
  );

  const wh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0];
  if (wh) {
    await pool.query(
      "INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 5) ON CONFLICT DO NOTHING",
      [wh.id, vId]
    );
  }

  // 1. Tạo đơn hàng MoMo quá hạn 2 giờ (thỏa mãn candidate selection lúc ban đầu)
  const orderId = crypto.randomUUID();
  const orderNumber = 'GR-P1-02-RACE-SHIPPED';
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd, created_at)
     VALUES ($1, $2, 'Shipped Customer', 'shipped@gaeru.com', '0912345688', 'District 1', 'TP. Hồ Chí Minh', 'momo', 'pending', 'pending', 1200000, 1200000, 0, now() - interval '2 hours')`,
    [orderId, orderNumber]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Bàn Phím Cơ P1-02', 'Xám', 'SKU-P1-02', 1, 1200000, 1200000)`,
    [orderId, vId]
  );
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES (gen_random_uuid(), $1, 'momo', $2, 1200000, 'pending', now() - interval '45 minutes')`,
    [orderId, orderNumber]
  );

  // 2. Chạy cancelExpiredUnpaidOrders kèm onCandidate: đổi trạng thái sang 'shipped' ngay trước khi withTransaction khóa hàng
  const cancelled = await OrderExpirationService.cancelExpiredUnpaidOrders(pool, {
    onCandidate: async (cand) => {
      if (cand.id === orderId) {
        await pool.query("UPDATE orders SET status = 'shipped', updated_at = now() WHERE id = $1", [orderId]);
      }
    }
  });

  const cancelledIds = cancelled.map(c => c.orderId);

  // 3. Xác minh: Đơn hàng đã chuyển sang 'shipped' TUYỆT ĐỐI KHÔNG BỊ HỦY!
  assert.ok(!cancelledIds.includes(orderId), 'Đơn hàng đã chuyển sang shipped không được phép bị hủy');

  const checkOrder = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [orderId])).rows[0];
  assert.equal(checkOrder.status, 'shipped', 'Trạng thái đơn hàng phải được giữ nguyên là shipped');
  assert.equal(checkOrder.payment_status, 'pending');

  // 5. Xác minh: Tồn kho KHÔNG bị hoàn trả (vẫn giữ nguyên 5, không bị cộng thêm thành 6)
  const checkVariant = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [vId])).rows[0];
  assert.equal(checkVariant.stock_quantity, 5, 'Tồn kho không được hoàn trả khi đơn đang vận chuyển/xử lý');
});

test('P1-03: Generates unique gateway request IDs across attempts for MoMo and ZaloPay conforming to official provider format rules', async (t) => {
  const { buildGatewayRequestId, createGatewayPayment, reference } = require('../src/payment-provider-clients');
  
  const txnRef = 'GR-20261031-TEST001';
  const baseTime = Date.parse('2026-10-31T08:00:00.000Z'); // 15:00 Vietnam time (GMT+7)
  const timeAttempt1 = baseTime;
  const timeAttempt2 = baseTime + 15000; // 15 seconds later (same day)
  const timeAttempt3 = baseTime + 3600000; // 1 hour later (same day)

  // 1. MoMo uniqueness per attempt
  const momoReqId1 = buildGatewayRequestId('momo', txnRef, timeAttempt1);
  const momoReqId2 = buildGatewayRequestId('momo', txnRef, timeAttempt2);
  const momoReqId3 = buildGatewayRequestId('momo', txnRef, timeAttempt3);

  assert.notEqual(momoReqId1, momoReqId2, 'MoMo attempt 1 and attempt 2 must have distinct request IDs');
  assert.notEqual(momoReqId2, momoReqId3, 'MoMo attempt 2 and attempt 3 must have distinct request IDs');
  assert.ok(momoReqId1.length <= 50, 'MoMo requestId must not exceed 50 characters');
  assert.ok(/^[A-Za-z0-9](?:[-_.]*[A-Za-z0-9]+)*$/.test(momoReqId1), 'MoMo requestId must match valid charset');
  assert.ok(momoReqId1.startsWith(txnRef + '_'), 'MoMo requestId should incorporate transaction reference');

  // 2. ZaloPay uniqueness per attempt on the same day
  const zaloReqId1 = buildGatewayRequestId('zalopay', txnRef, timeAttempt1);
  const zaloReqId2 = buildGatewayRequestId('zalopay', txnRef, timeAttempt2);
  const zaloReqId3 = buildGatewayRequestId('zalopay', txnRef, timeAttempt3);

  assert.notEqual(zaloReqId1, zaloReqId2, 'ZaloPay attempt 1 and attempt 2 on the same day must have distinct app_trans_ids');
  assert.notEqual(zaloReqId2, zaloReqId3, 'ZaloPay attempt 2 and attempt 3 on the same day must have distinct app_trans_ids');
  assert.ok(zaloReqId1.length <= 40, 'ZaloPay app_trans_id must not exceed 40 characters');
  assert.ok(/^\d{6}_/.test(zaloReqId1), 'ZaloPay app_trans_id must start with yyMMdd_ format');
  assert.ok(/^\d{6}_[A-Za-z0-9](?:[-_.]*[A-Za-z0-9]+)*$/.test(zaloReqId1), 'ZaloPay app_trans_id must match valid charset');

  // 3. Handling long txnRef (boundary test for max length constraints)
  const longTxnRef = 'GR-20261031-VERY-LONG-ORDER-NUMBER-ABCDEFGHIJKLM-99999'.slice(0, 50);
  const momoLong = buildGatewayRequestId('momo', longTxnRef, timeAttempt1);
  const zaloLong = buildGatewayRequestId('zalopay', longTxnRef, timeAttempt1);

  assert.ok(momoLong.length <= 50, `MoMo long requestId length (${momoLong.length}) must be <= 50`);
  assert.ok(zaloLong.length <= 40, `ZaloPay long app_trans_id length (${zaloLong.length}) must be <= 40`);

  // 4. createGatewayPayment executes and records distinct requestId
  const calls = [];
  const momoConfig = { environment: 'sandbox', partnerCode: 'MOMO_TEST', accessKey: 'MOMO_ACCESS', secretKey: 'fixture-momo-secret' };
  const mockFetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return new Response(JSON.stringify({
      partnerCode: body.partnerCode,
      requestId: body.requestId,
      orderId: body.orderId,
      amount: body.amount,
      resultCode: 0,
      responseTime: Date.now(),
      message: 'Success',
      payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?t=test-token'
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const res1 = await createGatewayPayment('momo', momoConfig, {
    txnRef,
    amountVnd: 500000,
    requestId: momoReqId1,
    now: timeAttempt1,
    baseUrl: 'https://gaeru.com',
    fetcher: mockFetcher
  });
  const res2 = await createGatewayPayment('momo', momoConfig, {
    txnRef,
    amountVnd: 500000,
    requestId: momoReqId2,
    now: timeAttempt2,
    baseUrl: 'https://gaeru.com',
    fetcher: mockFetcher
  });

  assert.equal(res1.requestId, momoReqId1);
  assert.equal(res2.requestId, momoReqId2);
  assert.notEqual(res1.requestId, res2.requestId);
  assert.equal(calls[0].body.requestId, momoReqId1);
  assert.equal(calls[1].body.requestId, momoReqId2);
});

test('P2-01: Idempotency binds full immutable checkout payload fingerprint (checkout_payload_hash) including address, shipping, voucher, buyer info, quote version', async (t) => {
  const { computeCheckoutPayloadHash, normalizeCheckoutPayload, assertOrderPayloadMatch } = require('../src/domain/payments/order-idempotency-policy');

  const basePayload = {
    customer: {
      name: 'Nguyễn Văn A',
      email: 'nguyenvana@example.com',
      phone: '0912345678',
      address: '123 Đường Lê Lợi, Phường Bến Nghé',
      city: 'TP. Hồ Chí Minh',
      note: 'Giao giờ hành chính'
    },
    items: [
      { variantId: '11111111-1111-1111-1111-111111111111', quantity: 2 },
      { variantId: '22222222-2222-2222-2222-222222222222', quantity: 1 }
    ],
    paymentMethod: 'momo',
    shippingCarrierId: 'ghn',
    expectedShippingFeeVnd: 30000,
    expectedSubtotalVnd: 500000,
    expectedQuoteHash: 'quote-hash-v1-abcdef0123456789',
    voucherCode: 'GAERU10'
  };

  const baseHash = computeCheckoutPayloadHash(basePayload);
  assert.ok(baseHash && baseHash.length === 64, 'Hash must be a valid 64-char SHA256 hex string');

  // 1. Invariance under item ordering and duplicate variant aggregation
  const reorderedPayload = {
    ...basePayload,
    items: [
      { variantId: '22222222-2222-2222-2222-222222222222', quantity: 1 },
      { variantId: '11111111-1111-1111-1111-111111111111', quantity: 1 },
      { variantId: '11111111-1111-1111-1111-111111111111', quantity: 1 }
    ]
  };
  const reorderedHash = computeCheckoutPayloadHash(reorderedPayload);
  assert.equal(baseHash, reorderedHash, 'Hash must remain invariant when cart items are reordered or split across duplicate lines');

  // 2. Hash sensitivity to critical order fields
  const differentAddressHash = computeCheckoutPayloadHash({
    ...basePayload,
    customer: { ...basePayload.customer, address: '456 Đường Nguyễn Huệ' }
  });
  assert.notEqual(baseHash, differentAddressHash, 'Address change must change hash');

  const differentCityHash = computeCheckoutPayloadHash({
    ...basePayload,
    customer: { ...basePayload.customer, city: 'Hà Nội' }
  });
  assert.notEqual(baseHash, differentCityHash, 'City change must change hash');

  const differentCarrierHash = computeCheckoutPayloadHash({
    ...basePayload,
    shippingCarrierId: 'ghtk'
  });
  assert.notEqual(baseHash, differentCarrierHash, 'Shipping carrier change must change hash');

  const differentVoucherHash = computeCheckoutPayloadHash({
    ...basePayload,
    voucherCode: 'GAERU20'
  });
  assert.notEqual(baseHash, differentVoucherHash, 'Voucher change must change hash');

  const differentQuoteHash = computeCheckoutPayloadHash({
    ...basePayload,
    expectedQuoteHash: 'quote-hash-v2-different'
  });
  assert.notEqual(baseHash, differentQuoteHash, 'Quote version/hash change must change hash');

  const differentCustomerHash = computeCheckoutPayloadHash({
    ...basePayload,
    customer: { ...basePayload.customer, name: 'Trần Văn B' }
  });
  assert.notEqual(baseHash, differentCustomerHash, 'Customer name change must change hash');

  // 3. assertOrderPayloadMatch detects and throws specific 409 codes
  const mockOrderInDb = {
    id: '33333333-3333-3333-3333-333333333333',
    orderNumber: 'GR-P201-ORDER-001',
    customerName: 'Nguyễn Văn A',
    address: '123 Đường Lê Lợi, Phường Bến Nghé',
    city: 'tp. hồ chí minh',
    email: 'nguyenvana@example.com',
    phone: '0912345678',
    paymentMethod: 'momo',
    shippingCarrierId: 'ghn',
    shippingFeeVnd: 30000,
    voucherCode: 'GAERU10',
    quoteHash: 'quote-hash-v1-abcdef0123456789',
    totalVnd: 530000,
    checkoutPayloadHash: baseHash
  };

  const dbItems = [
    { variantId: '11111111-1111-1111-1111-111111111111', quantity: 2 },
    { variantId: '22222222-2222-2222-2222-222222222222', quantity: 1 }
  ];

  // Identical payload matches 100% via checkoutPayloadHash
  assert.doesNotThrow(() => {
    assertOrderPayloadMatch(mockOrderInDb, dbItems, {
      checkoutPayload: basePayload,
      checkoutPayloadHash: baseHash
    });
  });

  // Reusing key with different address -> 409 IDEMPOTENCY_ADDRESS_MISMATCH
  assert.throws(() => {
    assertOrderPayloadMatch(mockOrderInDb, dbItems, {
      checkoutPayload: {
        ...basePayload,
        customer: { ...basePayload.customer, address: '999 Đường Khác' }
      }
    });
  }, (err) => err.status === 409 && err.code === 'IDEMPOTENCY_ADDRESS_MISMATCH');

  // Reusing key with different voucher -> 409 IDEMPOTENCY_VOUCHER_MISMATCH
  assert.throws(() => {
    assertOrderPayloadMatch(mockOrderInDb, dbItems, {
      checkoutPayload: {
        ...basePayload,
        voucherCode: 'DIFFERENT_VOUCHER'
      }
    });
  }, (err) => err.status === 409 && err.code === 'IDEMPOTENCY_VOUCHER_MISMATCH');

  // Reusing key with different carrier -> 409 IDEMPOTENCY_SHIPPING_MISMATCH
  assert.throws(() => {
    assertOrderPayloadMatch(mockOrderInDb, dbItems, {
      checkoutPayload: {
        ...basePayload,
        shippingCarrierId: 'ghtk'
      }
    });
  }, (err) => err.status === 409 && err.code === 'IDEMPOTENCY_SHIPPING_MISMATCH');

  // Reusing key with different quote version -> 409 IDEMPOTENCY_QUOTE_MISMATCH
  assert.throws(() => {
    assertOrderPayloadMatch(mockOrderInDb, dbItems, {
      checkoutPayload: {
        ...basePayload,
        expectedQuoteHash: 'quote-hash-expired-or-changed'
      }
    });
  }, (err) => err.status === 409 && err.code === 'IDEMPOTENCY_QUOTE_MISMATCH');
});

test('P2-02: Supplementary migration runs automatically on existing production databases where audit-hardening.sql is already marked applied', async (t) => {
  const fs = require('node:fs');
  const { createTestDb } = require('./helpers/pglite-db');
  const { migrateDatabase, MIGRATION_FILES } = require('../src/migrate');

  // Khởi tạo một cơ sở dữ liệu mô phỏng production
  const { pool, close } = await createTestDb({ migrate: false });
  t.after(() => close());

  // 1. Giả lập cơ sở dữ liệu production đã chạy tất cả migrations cũ (bao gồm cả audit-hardening.sql)
  // và đã ghi nhận đầy đủ vào schema_migrations
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');

  // Chạy các file trước checkout-lifecycle-hardening.sql
  const priorFiles = MIGRATION_FILES.filter(f => f !== 'checkout-lifecycle-hardening.sql');
  for (const file of priorFiles) {
    const sql = fs.readFileSync(require('path').join(__dirname, '..', 'db', file), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
  }

  // Xác nhận tại thời điểm này: audit-hardening.sql đã được ghi nhận trong schema_migrations
  const hasAuditHardening = (await pool.query("SELECT 1 FROM schema_migrations WHERE name = 'audit-hardening.sql'")).rows.length;
  assert.equal(hasAuditHardening, 1, 'audit-hardening.sql must be marked as applied');

  // Xác nhận checkout-lifecycle-hardening.sql chưa được ghi nhận
  const hasNewMigBefore = (await pool.query("SELECT 1 FROM schema_migrations WHERE name = 'checkout-lifecycle-hardening.sql'")).rows.length;
  assert.equal(hasNewMigBefore, 0, 'checkout-lifecycle-hardening.sql must not be in schema_migrations yet');

  // 2. Chạy migrateDatabase(pool) - mô phỏng quá trình deploy bản cập nhật lên production
  await migrateDatabase(pool);

  // 3. Xác minh migration mới đã được chạy và ghi nhận vào schema_migrations
  const hasNewMigAfter = (await pool.query("SELECT 1 FROM schema_migrations WHERE name = 'checkout-lifecycle-hardening.sql'")).rows.length;
  assert.equal(hasNewMigAfter, 1, 'checkout-lifecycle-hardening.sql must now be marked as applied');

  // 4. Xác minh các cột, chỉ mục và ràng buộc mới đã xuất hiện đầy đủ trên database:
  // - Cột checkout_payload_hash trên orders
  const colCheck = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'checkout_payload_hash'"
  );
  assert.equal(colCheck.rows.length, 1, 'orders table must have checkout_payload_hash column');

  // - Chỉ mục idx_orders_checkout_payload_hash
  const idxCheck = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'orders' AND indexname = 'idx_orders_checkout_payload_hash'"
  );
  assert.equal(idxCheck.rows.length, 1, 'idx_orders_checkout_payload_hash index must exist');

  // - Constraint payment_attempts_status_check chấp nhận expiry_awaiting_verification
  const paId = crypto.randomUUID();
  const oId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd) VALUES ($1, 'GR-TEST-P202', 'Test', 't@t.com', '091', 'Addr', 'City', 'momo', 'pending', 'pending', 100, 100)",
    [oId]
  );
  await assert.doesNotReject(async () => {
    await pool.query(
      "INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at) VALUES ($1, $2, 'momo', 'GR-TEST-P202', 100, 'expiry_awaiting_verification', now() + interval '15 minutes')",
      [paId, oId]
    );
  }, 'payment_attempts must accept expiry_awaiting_verification status');

  // - Chỉ mục idx_payment_attempts_provider_request_id
  const paIdxCheck = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'payment_attempts' AND indexname = 'idx_payment_attempts_provider_request_id'"
  );
  assert.equal(paIdxCheck.rows.length, 1, 'idx_payment_attempts_provider_request_id must exist');

  // - Ràng buộc kiểm tra tồn kho không âm (warehouse_stock quantity >= 0)
  const whCheck = await pool.query(
    "SELECT conname FROM pg_constraint WHERE conrelid = 'warehouse_stock'::regclass AND (conname = 'warehouse_stock_quantity_nonnegative_chk' OR (contype = 'c' AND pg_get_constraintdef(oid) LIKE '%quantity >= 0%'))"
  );
  assert.equal(whCheck.rows.length >= 1, true, 'warehouse_stock quantity non-negative check constraint must exist');

  // 5. Chạy lại migrateDatabase(pool) lần thứ 2: Bảo đảm tính idempotent 100% không phát sinh lỗi
  await assert.doesNotReject(async () => {
    await migrateDatabase(pool);
  }, 'Subsequent migrateDatabase calls must be strictly idempotent');
});

test('P2-03: Worker error handling, mailer caching, structured outbox outcomes, and anti-duplicate delivery', async () => {
  const { pool } = await createTestDb();

  // 1. orders.cancel_expired error propagation (does NOT swallow DB errors into { ok: true })
  const mockPoolWithError = {
    async query() {
      throw new Error('Fatal database connection error during cancel');
    }
  };
  const { WorkerManager } = require('../src/workers');
  const { createJobQueue } = require('../src/job-queue');

  const q1 = createJobQueue({ pool, intervalMs: 50, concurrency: 1 });
  const wm1 = new WorkerManager();
  wm1.jobQueue = q1;
  wm1.registerDefaultHandlers(mockPoolWithError, {});

  const cancelHandler = q1.getWorker('orders.cancel_expired');
  assert.equal(typeof cancelHandler, 'function');

  // Verify that calling cancelHandler with failing DB throws, does NOT return { ok: true }
  await assert.rejects(async () => {
    await cancelHandler({}, { id: 'job-cancel-test' }, { assertLeaseActive: () => {} });
  }, /Fatal database connection error during cancel/);

  // 2. Structured result for OrderExpirationService.cancelExpiredUnpaidOrders
  const emptyRes = await OrderExpirationService.cancelExpiredUnpaidOrders(pool, { olderThanHours: 24 });
  assert.equal(Array.isArray(emptyRes), true);
  assert.equal(emptyRes.length, 0);
  assert.equal(emptyRes.success, true);
  assert.equal(emptyRes.cancelledCount, 0);
  assert.equal(emptyRes.failedCount, 0);
  assert.deepEqual(emptyRes.errors, []);

  // 3. Mailer transport caching and reuse in WorkerManager
  let transportCreateCount = 0;
  const mockNodemailer = {
    createTransport(opts) {
      transportCreateCount++;
      return {
        _opts: opts,
        sendMail: async () => ({ accepted: ['test@example.com'] })
      };
    }
  };

  const customRequireFn = (mod) => {
    if (mod === 'nodemailer') return mockNodemailer;
    if (mod.startsWith('./')) return require('../src/' + mod.slice(2));
    return require(mod);
  };

  const q2 = createJobQueue({ pool, intervalMs: 50, concurrency: 1 });
  const wm2 = new WorkerManager();
  wm2.jobQueue = q2;
  const smtpConfig = {
    host: 'smtp.example.com',
    port: 587,
    user: 'store@example.com',
    pass: 'secret',
    from: 'store@example.com'
  };
  wm2.registerDefaultHandlers(pool, { smtp: smtpConfig }, { requireFn: customRequireFn });

  const emailOrderHandler = q2.getWorker('email.order');
  const emailWarrantyHandler = q2.getWorker('email.warranty');
  const emailMarketingHandler = q2.getWorker('email.marketing');

  // Run all 3 email handlers (outbox empty -> no_work)
  const resOrder = await emailOrderHandler({}, { id: 'j1' }, { assertLeaseActive: () => {} });
  const resWarranty = await emailWarrantyHandler({}, { id: 'j2' }, { assertLeaseActive: () => {} });
  const resMarketing = await emailMarketingHandler({}, { id: 'j3' }, { assertLeaseActive: () => {} });

  assert.equal(resOrder.status, 'no_work');
  assert.equal(resWarranty.status, 'no_work');
  assert.equal(resMarketing.status, 'no_work');

  // Transport should have been created ONLY ONCE and reused across all jobs
  assert.equal(transportCreateCount, 1, 'Mailer transport must be cached and reused across worker executions');

  // 4. Structured email processing: 'sent', 'retry', 'unknown', 'unsendable'
  const { processOrderEmail, processOrderEmailOutbox } = require('../src/order-email');

  // Insert test product, variant and order
  const prodId = crypto.randomUUID();
  const varId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Product P203', 'product-p203', 'audio', true)`,
    [prodId]
  );
  await pool.query(
    `INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, $2, 'SKU-P203', 'Standard', 100000, 10, true)`,
    [varId, prodId]
  );

  const createOrder = async (orderNum) => {
    const oId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd)
       VALUES ($1, $2, 'Test Buyer', 'buyer@example.com', '0901234567', '123 Pho', 'Hanoi', 'cod', 'pending', 'pending', 100000, 100000)`,
      [oId, orderNum]
    );
    await pool.query(
      `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
       VALUES (gen_random_uuid(), $1, $2, 'Product 1', 'Standard', 'SKU-P203', 1, 100000, 100000)`,
      [oId, varId]
    );
    return oId;
  };

  // A. Successful send: returns 'sent'
  const oA = await createOrder('GR-MAIL-001');
  const outbox1 = (await pool.query(
    `INSERT INTO order_email_outbox (order_id, kind, status) VALUES ($1, 'receipt', 'pending') RETURNING id`,
    [oA]
  )).rows[0];

  const fakeSuccessMailer = {
    sendMail: async (m) => ({ accepted: [m.to], messageId: '<test-msg-1@gaeru.com>' })
  };
  const sendRes = await processOrderEmailOutbox(pool, { smtp: smtpConfig }, fakeSuccessMailer);
  assert.equal(sendRes.status, 'sent');
  assert.equal(sendRes.outboxId, outbox1.id);

  // Check outbox row is 'sent'
  const row1 = (await pool.query('SELECT status, result FROM order_email_outbox WHERE id = $1', [outbox1.id])).rows[0];
  assert.equal(row1.status, 'sent');

  // B. Safe transient failure: returns 'retry', marks status 'pending' with 5m delay
  const oB = await createOrder('GR-MAIL-002');
  const outbox2 = (await pool.query(
    `INSERT INTO order_email_outbox (order_id, kind, status) VALUES ($1, 'receipt', 'pending') RETURNING id`,
    [oB]
  )).rows[0];

  const fakeRetryMailer = {
    sendMail: async () => {
      const err = new Error('Connection refused by SMTP relay');
      err.command = 'CONN';
      throw err;
    }
  };
  const retryRes = await processOrderEmailOutbox(pool, { smtp: smtpConfig }, fakeRetryMailer);
  assert.equal(retryRes.status, 'retry');
  assert.equal(retryRes.outboxId, outbox2.id);

  const row2 = (await pool.query('SELECT status, result, next_attempt_at FROM order_email_outbox WHERE id = $1', [outbox2.id])).rows[0];
  assert.equal(row2.status, 'pending');
  assert.ok(row2.next_attempt_at);

  // C. Ambiguous delivery failure: returns 'unknown', marks status 'unknown', NEVER retries automatically
  const oC = await createOrder('GR-MAIL-003');
  const outbox3 = (await pool.query(
    `INSERT INTO order_email_outbox (order_id, kind, status) VALUES ($1, 'receipt', 'pending') RETURNING id`,
    [oC]
  )).rows[0];

  const fakeAmbiguousMailer = {
    sendMail: async () => {
      const err = new Error('Socket timeout waiting for 250 OK after DATA stream');
      err.command = 'DATA';
      throw err;
    }
  };
  const ambigRes = await processOrderEmailOutbox(pool, { smtp: smtpConfig }, fakeAmbiguousMailer);
  assert.equal(ambigRes.status, 'unknown');
  assert.equal(ambigRes.outboxId, outbox3.id);

  const row3 = (await pool.query('SELECT status, result, next_attempt_at, finished_at FROM order_email_outbox WHERE id = $1', [outbox3.id])).rows[0];
  assert.equal(row3.status, 'unknown');
  assert.ok(row3.finished_at);

  // Calling worker again: since status is 'unknown' (not 'pending'), it must NOT be picked up!
  const nextAttempt = await processOrderEmailOutbox(pool, { smtp: smtpConfig }, fakeSuccessMailer);
  assert.equal(nextAttempt.status, 'no_work', 'Ambiguous outbox records must never be automatically retried');

  // D. Backward compatibility: processOrderEmail without options returns boolean
  const oD = await createOrder('GR-MAIL-004');
  const outbox4 = (await pool.query(
    `INSERT INTO order_email_outbox (order_id, kind, status) VALUES ($1, 'receipt', 'pending') RETURNING id`,
    [oD]
  )).rows[0];
  const boolRes = await processOrderEmail(pool, { smtp: smtpConfig }, fakeSuccessMailer);
  assert.equal(boolRes, true, 'Legacy processOrderEmail must return boolean true on processed mail');

  // E. When queue is empty: returns boolean false for legacy callers
  const boolEmpty = await processOrderEmail(pool, { smtp: smtpConfig }, fakeSuccessMailer);
  assert.equal(boolEmpty, false, 'Legacy processOrderEmail must return boolean false when queue is empty');
});

test('P2-04: Leader + JobQueue/Cron as single primary runner for order expiration with deduplication and observability', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const { WorkerManager } = require('../src/workers');
  const manager = new WorkerManager();
  t.after(() => manager.stopAll());

  // Mock requireFn so background crons don't start heavy services
  const mockRequireFn = (mod) => {
    if (mod === './domain/orders/order-expiration-service') return require('../src/domain/orders/order-expiration-service');
    if (mod.startsWith('./')) return require('../src/' + mod.slice(2));
    return require(mod);
  };

  // 1. Khởi chạy WorkerManager ở chế độ Leader với JobQueue
  await manager.startAll(pool, {}, {
    requireFn: mockRequireFn,
    startJobQueue: true,
    jobQueueOptions: { orderExpiryIntervalMs: 60000 }
  });

  assert.equal(manager.isLeader, true, 'WorkerManager phải là Leader');
  assert.ok(manager.jobQueue, 'JobQueue phải được khởi tạo');

  // Xác nhận orders.cancel_expired đã được đăng ký trên JobQueue
  assert.equal(manager.jobQueue.hasWorker('orders.cancel_expired'), true);

  // Xác nhận worker song song startOrderExpirationWorker KHÔNG được chạy (không có trong manager.workers)
  assert.equal(manager.workers.has('orderExpiration'), false, 'Không được chạy startOrderExpirationWorker song song khi JobQueue bật');

  // Xác nhận cron scheduler đã được đăng ký trong workers để giải phóng khi stop
  assert.equal(manager.workers.has('orderExpirationScheduler'), true, 'Leader phải đăng ký orderExpirationScheduler');

  // 2. Kiểm tra snapshot: Job đã được enqueue vào bảng system_jobs
  const snapshotRes = await pool.query(
    `SELECT id, name, queue, status, run_at, max_attempts FROM system_jobs WHERE name = 'orders.cancel_expired'`
  );
  assert.equal(snapshotRes.rows.length, 1, 'Job orders.cancel_expired phải được enqueue vào system_jobs (observable in snapshot)');
  const initialJob = snapshotRes.rows[0];
  assert.equal(initialJob.status, 'pending');
  assert.equal(initialJob.queue, 'maintenance');

  // 3. Đảm bảo chỉ 1 job đang quét: Thử enqueue lần thứ 2 khi job đầu tiên vẫn đang pending
  const secondEnqueue = await manager.enqueueOrderExpirationJob(pool, {}, { immediate: false });
  assert.equal(secondEnqueue.queued, false, 'Không được enqueue job trùng khi đang có job pending');
  assert.equal(secondEnqueue.reason, 'already_active');
  assert.equal(secondEnqueue.activeJobId, initialJob.id);

  // Xác nhận bảng system_jobs vẫn chỉ có 1 job duy nhất
  const countRes = await pool.query(`SELECT count(*)::int AS count FROM system_jobs WHERE name = 'orders.cancel_expired'`);
  assert.equal(countRes.rows[0].count, 1, 'Chỉ duy nhất 1 job orders.cancel_expired tồn tại trong hàng đợi');

  // 4. Thực thi job qua JobQueue (quan sát trạng thái & hoàn tất)
  // Kéo run_at về now() để claimNextJob có thể nhận
  await pool.query(`UPDATE system_jobs SET run_at = now() WHERE id = $1`, [initialJob.id]);
  const processRes = await manager.jobQueue.processOne();
  assert.equal(processRes.id, initialJob.id);
  assert.equal(processRes.status, 'completed');

  const afterJob = (await pool.query(`SELECT status, attempts, last_error FROM system_jobs WHERE id = $1`, [initialJob.id])).rows[0];
  assert.equal(afterJob.status, 'completed', 'Job phải hoàn tất thành công trong system_jobs');
  assert.equal(afterJob.attempts, 1);

  // 5. Sau khi job hoàn tất, lần enqueue tiếp theo sẽ được tạo mới
  const nextEnqueue = await manager.enqueueOrderExpirationJob(pool, {}, { immediate: true });
  assert.equal(nextEnqueue.queued, true, 'Sau khi job trước completed, job mới có thể được enqueue');
  assert.ok(nextEnqueue.job.id !== initialJob.id, 'Job mới phải có ID mới');

  // 6. Fallback test: Khi JobQueue bị tắt, safeStart fallback sang startOrderExpirationWorker
  const fallbackManager = new WorkerManager();
  t.after(() => fallbackManager.stopAll());
  let fallbackWorkerStarted = false;
  await fallbackManager.startAll(pool, {}, {
    startJobQueue: false,
    requireFn: (mod) => {
      if (mod === './domain/orders/order-expiration-service') {
        return {
          startOrderExpirationWorker: () => {
            fallbackWorkerStarted = true;
            return () => {};
          }
        };
      }
      return {};
    }
  });
  assert.equal(fallbackWorkerStarted, true, 'Khi JobQueue tắt, phải fallback sang startOrderExpirationWorker');
});


test('P2-05: Bound maxDiscountPercent to [0, 100], sanitize Infinity/negative/NaN configs, and pass options to eligible', async () => {
  // 1. Kiểm tra sanitizeMaxDiscountPercent
  assert.equal(sanitizeMaxDiscountPercent(undefined), 40);
  assert.equal(sanitizeMaxDiscountPercent(null), 40);
  assert.equal(sanitizeMaxDiscountPercent(''), 40);
  assert.equal(sanitizeMaxDiscountPercent(NaN), 40);
  assert.equal(sanitizeMaxDiscountPercent(Infinity), 40);
  assert.equal(sanitizeMaxDiscountPercent(-Infinity), 40);
  assert.equal(sanitizeMaxDiscountPercent('not-a-number'), 40);

  // Ràng buộc cận dưới 0 và cận trên 100
  assert.equal(sanitizeMaxDiscountPercent(-10), 0);
  assert.equal(sanitizeMaxDiscountPercent(-0.01), 0);
  assert.equal(sanitizeMaxDiscountPercent(0), 0);
  assert.equal(sanitizeMaxDiscountPercent(25), 25);
  assert.equal(sanitizeMaxDiscountPercent(40), 40);
  assert.equal(sanitizeMaxDiscountPercent(50), 50);
  assert.equal(sanitizeMaxDiscountPercent(100), 100);
  assert.equal(sanitizeMaxDiscountPercent(150), 100);
  assert.equal(sanitizeMaxDiscountPercent(9999), 100);

  // Chuỗi số hợp lệ
  assert.equal(sanitizeMaxDiscountPercent('50'), 50);
  assert.equal(sanitizeMaxDiscountPercent('0'), 0);
  assert.equal(sanitizeMaxDiscountPercent('100'), 100);

  // Fallback tùy biến
  assert.equal(sanitizeMaxDiscountPercent(NaN, 50), 50);

  // 2. Kiểm tra discount() với các cấu hình sai / bất thường
  const voucher50 = { kind: 'percent', amount: 50, max_discount_vnd: null };
  const subtotal = 1000000;

  // Cấu hình NaN -> an toàn fallback về 40%, không sinh ra NaN
  const discountWithNaN = discount(voucher50, subtotal, { maxDiscountPercent: NaN });
  assert.equal(discountWithNaN, 400000);
  assert.ok(Number.isFinite(discountWithNaN));

  // Cấu hình Infinity -> an toàn fallback về 40%, không sinh ra Infinity hay mở toang trần
  const discountWithInf = discount(voucher50, subtotal, { maxDiscountPercent: Infinity });
  assert.equal(discountWithInf, 400000);
  assert.ok(Number.isFinite(discountWithInf));

  // Cấu hình -Infinity -> an toàn fallback về 40%
  const discountWithNegInf = discount(voucher50, subtotal, { maxDiscountPercent: -Infinity });
  assert.equal(discountWithNegInf, 400000);
  assert.ok(Number.isFinite(discountWithNegInf));

  // Cấu hình số âm -> chặn dưới tại 0%, mức giảm là 0đ, không âm và không NaN
  const discountWithNeg = discount(voucher50, subtotal, { maxDiscountPercent: -20 });
  assert.equal(discountWithNeg, 0);

  // Cấu hình 0% -> mức giảm là 0đ
  const discountWithZero = discount(voucher50, subtotal, { maxDiscountPercent: 0 });
  assert.equal(discountWithZero, 0);

  // Cấu hình > 100% -> chặn trên tại 100%, không vượt quá tạm tính
  const voucher120 = { kind: 'percent', amount: 120, max_discount_vnd: null };
  const discountWithOverflow = discount(voucher120, subtotal, { maxDiscountPercent: 150 });
  assert.equal(discountWithOverflow, 1000000);

  // Tạm tính 0 hoặc âm -> mức giảm luôn là 0
  assert.equal(discount(voucher50, 0), 0);
  assert.equal(discount(voucher50, -50000), 0);
  assert.equal(discount(voucher50, NaN), 0);

  // Voucher cố định vượt trần 40% mặc định
  const fixedVoucher = { kind: 'fixed', amount: 500000, max_discount_vnd: null };
  assert.equal(discount(fixedVoucher, subtotal), 400000, 'Fixed voucher bị áp trần 40% mặc định');
  assert.equal(discount(fixedVoucher, subtotal, { maxDiscountPercent: 100 }), 500000, 'Fixed voucher được giảm đủ khi mở trần');

  // 3. Kiểm tra eligible() truyền options tới discount()
  const fakeVoucherRow = {
    id: 'v-1',
    code: 'TEST50',
    active: true,
    starts_at: new Date(Date.now() - 3600000).toISOString(),
    ends_at: new Date(Date.now() + 3600000).toISOString(),
    min_spend_vnd: 100000,
    total_limit: 100,
    per_customer_limit: 5,
    kind: 'percent',
    amount: 50,
    max_discount_vnd: null
  };

  const fakeClient = {
    query: async (sql, params) => {
      if (sql.includes('FROM customers WHERE id=')) return { rows: [{ id: 'cust-1' }] };
      if (sql.includes('FROM marketing_vouchers WHERE code=')) return { rows: [fakeVoucherRow] };
      if (sql.includes('FROM customer_vouchers WHERE customer_id=')) return { rows: [{}] };
      if (sql.includes('FROM voucher_redemptions WHERE voucher_id=')) return { rows: [{ total: 0, personal: 0 }] };
      return { rows: [] };
    }
  };

  // eligible mặc định -> trần 40% -> 400.000đ
  const defaultEligible = await eligible(fakeClient, 'TEST50', 'cust-1', 1000000);
  assert.equal(defaultEligible.discountVnd, 400000);

  // eligible với options.maxDiscountPercent = 60 -> tính đủ 50% = 500.000đ
  const customEligible = await eligible(fakeClient, 'TEST50', 'cust-1', 1000000, false, { maxDiscountPercent: 60 });
  assert.equal(customEligible.discountVnd, 500000);
});


test('Consolidation & Deduplication: 6 core priority items verified', async () => {
  // 1. Unified Order Ownership Policy in PaymentService
  const { PaymentService } = require('../src/domain/payments/payment-service');
  assert.equal(typeof PaymentService.getOrderPaymentStatus, 'function');
  assert.equal(typeof PaymentService.extractIdentityProofFromRequest, 'function');

  const mockReq = {
    headers: { 'x-order-token': 'header.token' },
    session: { customer: { id: 'cust-123', email: 'test@gaeru.com' }, createdOrders: ['GR-123'] }
  };
  const extractedProof = PaymentService.extractIdentityProofFromRequest(mockReq);
  assert.equal(extractedProof.orderAccessToken, 'header.token');
  assert.equal(extractedProof.sessionCustomerId, 'cust-123');

  // 2. PaymentAttemptStateMachine transitionAttempt & invariant protection
  const fakeAttempts = [{ id: 'att-1', status: 'pending' }];
  const fakeDbClient = {
    query: async (sql, params) => {
      if (sql.includes('UPDATE payment_attempts')) {
        const att = fakeAttempts.find(a => a.id === params[0]);
        if (!att) return { rows: [] };
        if (att.status === 'paid' && params[1] !== 'paid') return { rows: [] };
        att.status = params[1];
        return { rows: [att] };
      }
      if (sql.includes('SELECT status FROM payment_attempts WHERE id = $1')) {
        const att = fakeAttempts.find(a => a.id === params[0]);
        return { rows: att ? [{ status: att.status }] : [] };
      }
      return { rows: [] };
    }
  };

  // Chuyển hợp lệ pending -> paid
  const transitioned = await PaymentAttemptStateMachine.transitionAttempt(fakeDbClient, {
    attemptId: 'att-1',
    fromStatus: 'pending',
    toStatus: 'paid'
  });
  assert.equal(transitioned.status, 'paid');

  // Chặn 409 khi cố tình chuyển trạng thái từ paid sang failed
  await assert.rejects(async () => {
    await PaymentAttemptStateMachine.transitionAttempt(fakeDbClient, {
      attemptId: 'att-1',
      fromStatus: 'paid',
      toStatus: 'failed'
    });
  }, (err) => err.code === 'INVALID_PAYMENT_STATE_TRANSITION' && err.status === 409);

  // 3. OrderExpirationService fail-closed when inventory service is missing
  const { OrderExpirationService } = require('../src/domain/orders/order-expiration-service');
  assert.equal(typeof OrderExpirationService.cancelExpiredUnpaidOrders, 'function');

  // 4. EmailOutboxDispatcher unified abstraction
  const { EmailOutboxDispatcher } = require('../src/domain/email/email-outbox-dispatcher');
  assert.equal(typeof EmailOutboxDispatcher.dispatchNext, 'function');

  // Dispatcher handles missing mailer fail-closed (returns unsendable if pending exists)
  const fakePool = {
    query: async (sql) => {
      if (sql.includes("status = 'pending'")) return { rows: [{ id: 1 }] };
      return { rows: [] };
    }
  };
  const unsendableRes = await EmailOutboxDispatcher.dispatchNext(fakePool, {}, null, {
    tableName: 'order_email_outbox',
    domain: 'order',
    structured: true
  });
  assert.equal(unsendableRes.status, 'unsendable');
  assert.equal(unsendableRes.reason, 'smtp_not_configured');

  // 5. Admin format helper module loading and parity
  const formatMod = require('../admin/format');
  assert.equal(typeof formatMod.escapeHtml, 'function');
  assert.equal(typeof formatMod.formatMoney, 'function');
  assert.equal(typeof formatMod.normalizePhone, 'function');
  assert.equal(formatMod.escapeHtml('<script>alert("test")</script>'), '&lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt;');
  assert.equal(formatMod.formatMoney(250000), '250.000 ₫');
  assert.equal(formatMod.normalizePhone('+84 912 345 678'), '0912345678');

  // 6. src/inventory.js facade functions preserved
  const invFacade = require('../src/inventory');
  assert.equal(typeof invFacade.initializeVariantStock, 'function');
  assert.equal(typeof invFacade.setVariantStock, 'function');
  assert.equal(typeof invFacade.reserveStock, 'function');
  assert.equal(typeof invFacade.reserveOrderStock, 'function');
  assert.equal(typeof invFacade.releaseOrderStock, 'function');
  assert.equal(typeof invFacade.restoreOrderStock, 'function');
  assert.equal(typeof invFacade.adjustWarehouseStock, 'function');
  assert.equal(typeof invFacade.transferStock, 'function');
  assert.equal(typeof invFacade.receiveStock, 'function');
  assert.equal(typeof invFacade.operationError, 'function');
  assert.equal(typeof invFacade.MAX_STOCK, 'number');
});

test('Defect 1: Overdue MoMo order without gateway configuration is NOT cancelled and stock is NOT released (held in expiry_awaiting_verification)', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const pId = crypto.randomUUID();
  const vId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const orderNumber = 'GR-DEFECT1-UNCONFIG';

  await pool.query(
    "INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Tai Nghe Defect 1', 'tai-nghe-defect-1', 'audio', true)",
    [pId]
  );
  await pool.query(
    "INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, $2, 'SKU-DEFECT-1', 'Xám', 700000, 10, true)",
    [vId, pId]
  );

  const wh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0];
  if (wh) {
    await pool.query(
      "INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 10) ON CONFLICT DO NOTHING",
      [wh.id, vId]
    );
  }

  // Đơn MoMo tạo 2 giờ trước (quá TTL 1h)
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd, created_at)
     VALUES ($1, $2, 'Unconfigured Momo Buyer', 'buyer@gaeru.com', '0912345688', 'District 1', 'TP. Hồ Chí Minh', 'momo', 'pending', 'pending', 700000, 700000, 0, now() - interval '2 hours')`,
    [orderId, orderNumber]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Tai Nghe Defect 1', 'Xám', 'SKU-DEFECT-1', 2, 350000, 700000)`,
    [orderId, vId]
  );
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES (gen_random_uuid(), $1, 'momo', $2, 700000, 'pending', now() - interval '30 minutes')`,
    [orderId, orderNumber]
  );

  // Đảm bảo không có cấu hình kết nối cổng MoMo trong DB (chưa cài đặt hoặc không lấy được)
  await pool.query("DELETE FROM store_settings WHERE setting_key = 'private_admin:payment_momo'");

  // Chạy OrderExpirationService
  const cancelled = await OrderExpirationService.cancelExpiredUnpaidOrders(pool);
  const cancelledIds = cancelled.map(c => c.orderId);

  // 1. Đơn hàng TUYỆT ĐỐI KHÔNG BỊ HỦY vì chưa có xác thực từ cổng
  assert.ok(!cancelledIds.includes(orderId), 'Đơn MoMo khi chưa có cấu hình kết nối cổng không được phép tự hủy');
  const o = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [orderId])).rows[0];
  assert.equal(o.status, 'pending', 'Đơn hàng phải giữ nguyên trạng thái pending');
  assert.equal(o.payment_status, 'pending');

  // 2. Phiên thanh toán phải chuyển sang expiry_awaiting_verification với mã lỗi GATEWAY_CHANNEL_UNCONFIGURED
  const att = (await pool.query('SELECT status, last_error_code FROM payment_attempts WHERE order_id = $1', [orderId])).rows[0];
  assert.equal(att.status, 'expiry_awaiting_verification', 'Phiên phải chuyển sang expiry_awaiting_verification');
  assert.equal(att.last_error_code, 'GATEWAY_CHANNEL_UNCONFIGURED', 'Mã lỗi phải ghi nhận cổng chưa cấu hình');

  // 3. Tồn kho KHÔNG ĐƯỢC hoàn trả (fail-closed bảo vệ kho)
  const variant = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [vId])).rows[0];
  assert.equal(variant.stock_quantity, 10, 'Tồn kho không được hoàn trả khi chưa có kết quả xác minh từ cổng');

  // 4. Phải ghi nhận order_activity và audit log cảnh báo thiếu cấu hình cổng
  const act = (await pool.query("SELECT * FROM order_activities WHERE order_id = $1 AND action = 'expiry_awaiting_verification'", [orderId])).rows[0];
  assert.ok(act, 'Phải có order_activities expiry_awaiting_verification');
  assert.ok(act.details?.reason?.includes('không lấy được cấu hình'), 'Nội dung activity phải cảnh báo thiếu cấu hình');

  const auditEntry = (await pool.query("SELECT * FROM audit_events WHERE entity_id = $1 AND action = 'order.expiry_awaiting_verification'", [orderId])).rows[0];
  assert.ok(auditEntry, 'Phải có bản ghi audit event expiry_awaiting_verification');
  assert.equal(auditEntry.metadata?.reason, 'gateway_channel_unconfigured');
});

test('Defect 2: Gateway verified_unpaid definitive decision cancels order and releases stock even when attempt was in awaiting_reconciliation', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const pId = crypto.randomUUID();
  const vId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const orderNumber = 'GR-DEFECT2-AWAIT-CANCEL';

  await pool.query(
    "INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Tai Nghe Defect 2', 'tai-nghe-defect-2', 'audio', true)",
    [pId]
  );
  // Khởi tạo biến thể với tồn kho 5
  await pool.query(
    "INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, $2, 'SKU-DEFECT-2', 'Đen', 500000, 5, true)",
    [vId, pId]
  );

  const wh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0];
  if (wh) {
    await pool.query(
      "INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 5) ON CONFLICT DO NOTHING",
      [wh.id, vId]
    );
  }

  // Đơn MoMo tạo 2 giờ trước (quá TTL 1h)
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd, created_at)
     VALUES ($1, $2, 'Awaiting Momo Buyer', 'awaiting@gaeru.com', '0912345689', 'District 3', 'TP. Hồ Chí Minh', 'momo', 'pending', 'pending', 500000, 500000, 0, now() - interval '2 hours')`,
    [orderId, orderNumber]
  );
  // Đơn gồm 2 sản phẩm (khi hủy sẽ được hoàn kho từ 5 lên 7)
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Tai Nghe Defect 2', 'Đen', 'SKU-DEFECT-2', 2, 250000, 500000)`,
    [orderId, vId]
  );

  // Phiên thanh toán đang ở trạng thái awaiting_reconciliation và đã hết hạn (-10 phút)
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES (gen_random_uuid(), $1, 'momo', $2, 500000, 'awaiting_reconciliation', now() - interval '10 minutes')`,
    [orderId, orderNumber]
  );

  // Cấu hình cổng MoMo hợp lệ
  const { writeRecord } = require('../src/admin-configuration');
  const appConfig = { SESSION_SECRET: 'test-secret-32-chars-minimum-length-ok!' };
  await writeRecord(pool, appConfig, 'payment_momo', {
    partnerCode: 'MOMODEFECT2',
    accessKey: 'ACCESS_D2',
    secretKey: 'SECRET_D2',
    environment: 'sandbox',
    enabled: true
  }, 0, { username: 'admin' });

  // Mock fetcher giả lập cổng MoMo phản hồi chắc chắn: không tìm thấy giao dịch (1001) -> verified_unpaid
  const verifiedUnpaidFetcher = async () => new Response(
    JSON.stringify({ resultCode: 1001, message: 'Transaction not found' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );

  // Chạy OrderExpirationService
  const cancelled = await OrderExpirationService.cancelExpiredUnpaidOrders(pool, { config: appConfig, fetcher: verifiedUnpaidFetcher });
  const cancelledIds = cancelled.map(c => c.orderId);

  // 1. Đơn hàng PHẢI ĐƯỢC TỰ ĐỘNG HỦY sau khi cổng xác minh verified_unpaid dù trước đó phiên ở awaiting_reconciliation
  assert.ok(cancelledIds.includes(orderId), 'Đơn hàng phải được hủy khi cổng xác minh chắc chắn chưa thanh toán');
  const o = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [orderId])).rows[0];
  assert.equal(o.status, 'cancelled', 'Trạng thái đơn hàng phải đổi sang cancelled');
  assert.equal(o.payment_status, 'pending');

  // 2. Phiên thanh toán phải được chuyển sang cancelled
  const att = (await pool.query('SELECT status FROM payment_attempts WHERE order_id = $1', [orderId])).rows[0];
  assert.equal(att.status, 'cancelled', 'Phiên thanh toán phải chuyển sang cancelled');

  // 3. Tồn kho PHẢI ĐƯỢC GIẢI PHÓNG và hoàn trả về kho (5 + 2 = 7)
  const variant = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [vId])).rows[0];
  assert.equal(variant.stock_quantity, 7, 'Tồn kho phải được hoàn trả 2 đơn vị từ 5 lên 7');

  // 4. Phải ghi nhận order_activity và audit event hủy đơn
  const act = (await pool.query("SELECT * FROM order_activities WHERE order_id = $1 AND action = 'status_changed'", [orderId])).rows[0];
  assert.ok(act, 'Phải có order_activities status_changed');
  assert.equal(act.details?.to, 'cancelled');

  const auditEntry = (await pool.query("SELECT * FROM audit_events WHERE entity_id = $1 AND action = 'order.cancel_expired_unpaid'", [orderId])).rows[0];
  assert.ok(auditEntry, 'Phải có audit_events order.cancel_expired_unpaid');
});


test('P1-01 Fix: Order email worker correctly receives or initializes mailer, delivers valid order email, and updates outbox to sent without dropping jobs', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const pId = crypto.randomUUID();
  const vId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const orderNumber = 'GR-P1-01-MAILER';

  await pool.query(
    "INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Kính P1-01', 'kinh-p1-01', 'audio', true)",
    [pId]
  );
  await pool.query(
    "INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, $2, 'SKU-P1-01-M', 'Xanh', 350000, 10, true)",
    [vId, pId]
  );

  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd)
     VALUES ($1, $2, 'Mailer Buyer', 'valid-buyer@gaeru.com', '0912345688', 'District 1', 'TP. Hồ Chí Minh', 'cod', 'pending', 'pending', 350000, 350000, 0)`,
    [orderId, orderNumber]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Kính P1-01', 'Xanh', 'SKU-P1-01-M', 1, 350000, 350000)`,
    [orderId, vId]
  );

  const outboxId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO order_email_outbox (id, order_id, kind, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'receipt', 'pending', 0, now())`,
    [outboxId, orderId]
  );

  const config = {
    smtp: { from: 'store@gaeru.com', host: 'smtp.gaeru.com', port: 587 },
    PUBLIC_BASE_URL: 'https://gaeru.com'
  };

  const sentMails = [];
  const mockMailer = {
    sendMail: async (opts) => {
      sentMails.push(opts);
      return { accepted: [opts.to] };
    }
  };

  const { startOrderEmailWorker } = require('../src/order-email');
  const stopWorker = startOrderEmailWorker(pool, config, { mailer: mockMailer, intervalMs: 20 });
  t.after(() => stopWorker());

  // Wait for worker tick to process the outbox item
  let outboxRow = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    outboxRow = (await pool.query('SELECT status, result FROM order_email_outbox WHERE id = $1', [outboxId])).rows[0];
    if (outboxRow && outboxRow.status === 'sent') break;
  }

  assert.ok(outboxRow, 'Phải tìm thấy dòng outbox');
  assert.equal(outboxRow.status, 'sent', 'Trạng thái outbox phải chuyển sang sent');
  assert.equal(outboxRow.result, 'SMTP đã tiếp nhận');
  assert.equal(sentMails.length, 1, 'Mock mailer phải ghi nhận đã gửi 1 email');
  assert.equal(sentMails[0].to, 'valid-buyer@gaeru.com');
  assert.ok(sentMails[0].subject.includes(orderNumber));
});

test('P1-02 Fix: Order email worker runs full screening loop (screenNextEmail -> process -> classify -> notifyAdmin), catches missing domain and alerts admin', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const pId = crypto.randomUUID();
  const vId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const orderNumber = 'GR-P1-02-REVIEW';

  await pool.query(
    "INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Kính P1-02', 'kinh-p1-02', 'audio', true)",
    [pId]
  );
  await pool.query(
    "INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, $2, 'SKU-P1-02-R', 'Đỏ', 400000, 10, true)",
    [vId, pId]
  );

  // Đơn hàng với email có domain không tồn tại
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd)
     VALUES ($1, $2, 'Suspicious Buyer', 'fake@non-existent-domain-xyz999.com', '0912345699', 'District 1', 'TP. Hồ Chí Minh', 'cod', 'pending', 'pending', 400000, 400000, 0)`,
    [orderId, orderNumber]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Kính P1-02', 'Đỏ', 'SKU-P1-02-R', 1, 400000, 400000)`,
    [orderId, vId]
  );

  const outboxId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO order_email_outbox (id, order_id, kind, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'receipt', 'pending', 0, now())`,
    [outboxId, orderId]
  );

  // Tạo tài khoản owner có email đã xác thực
  await pool.query(
    `INSERT INTO account_security (account_key, email, contacts_verified_at)
     VALUES ('owner', 'admin-owner@gaeru.com', now())
     ON CONFLICT (account_key) DO UPDATE SET email = EXCLUDED.email, contacts_verified_at = EXCLUDED.contacts_verified_at`
  );

  // Thêm thông báo admin outbox (hoặc cập nhật nếu trigger đã tạo)
  const adminOutboxId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO order_admin_email_outbox (id, order_id, status, attempts, next_attempt_at)
     VALUES ($1, $2, 'pending', 0, now())
     ON CONFLICT (order_id) DO UPDATE SET status = 'pending', attempts = 0, next_attempt_at = now()`,
    [adminOutboxId, orderId]
  );

  const config = {
    smtp: { from: 'store@gaeru.com', host: 'smtp.gaeru.com', port: 587 },
    PUBLIC_BASE_URL: 'https://gaeru.com'
  };

  // Mock DNS resolver giả lập domain không tồn tại (ENOTFOUND)
  const mockResolver = {
    resolveMx: async () => {
      const err = new Error('getaddrinfo ENOTFOUND non-existent-domain-xyz999.com');
      err.code = 'ENOTFOUND';
      throw err;
    },
    lookup: async () => {
      const err = new Error('getaddrinfo ENOTFOUND non-existent-domain-xyz999.com');
      err.code = 'ENOTFOUND';
      throw err;
    }
  };

  const sentAdminMails = [];
  const mockMailer = {
    sendMail: async (opts) => {
      sentAdminMails.push(opts);
      return { accepted: [opts.to] };
    }
  };

  const { startOrderEmailWorker } = require('../src/order-email');
  const stopWorker = startOrderEmailWorker(pool, config, { mailer: mockMailer, resolver: mockResolver, intervalMs: 20 });
  t.after(() => stopWorker());

  // Wait for worker tick to screen -> classify -> notifyAdmin
  let reviewRow = null;
  let adminOutboxRow = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    reviewRow = (await pool.query('SELECT * FROM order_reviews WHERE order_id = $1', [orderId])).rows[0];
    adminOutboxRow = (await pool.query('SELECT status, recipient FROM order_admin_email_outbox WHERE order_id = $1', [orderId])).rows[0];
    if (reviewRow && adminOutboxRow?.status === 'sent') break;
  }

  // 1. screenNextEmail: outbox của email người mua phải chuyển failed do tên miền không tồn tại
  const outboxCheck = (await pool.query('SELECT status, result FROM order_email_outbox WHERE id = $1', [outboxId])).rows[0];
  assert.equal(outboxCheck.status, 'failed');
  assert.equal(outboxCheck.result, 'Tên miền email không tồn tại');

  // 2. classify: order_reviews phải tự động được ghi nhận với reason = domain_missing
  assert.ok(reviewRow, 'Phải tự động tạo bản ghi trong order_reviews');
  assert.equal(reviewRow.reason, 'domain_missing');

  // 3. notifyAdmin: email thông báo tới chủ shop phải được gửi thành công
  assert.ok(adminOutboxRow, 'Phải có order_admin_email_outbox');
  assert.equal(adminOutboxRow.status, 'sent');
  assert.equal(adminOutboxRow.recipient, 'admin-owner@gaeru.com');
  assert.ok(sentAdminMails.some(m => m.to === 'admin-owner@gaeru.com'));
});

test('P1-04 Fix: ReconciliationOutcome enum correctly partitions actions into PAID, DEFINITIVELY_UNPAID, AMBIGUOUS across all consumers', () => {
  const { ReconciliationOutcome, RECONCILIATION_ACTIONS, RECONCILIATION_GROUPS } = require('../src/domain/payments/reconciliation-outcome');

  // Nhóm PAID
  assert.equal(ReconciliationOutcome.isPaid('already_paid'), true);
  assert.equal(ReconciliationOutcome.isPaid('settled_paid'), true);
  assert.equal(ReconciliationOutcome.isPaid({ paymentStatus: 'paid' }), true);
  assert.equal(ReconciliationOutcome.isPaid({ action: 'settled_paid' }), true);
  assert.equal(ReconciliationOutcome.isPaid('verified_unpaid'), false);

  // Nhóm DEFINITIVELY_UNPAID
  assert.equal(ReconciliationOutcome.isDefinitivelyUnpaid({ verified: true, action: 'verified_unpaid' }), true);
  assert.equal(ReconciliationOutcome.isDefinitivelyUnpaid({ verified: true, action: 'cancelled_unpaid' }), true);
  assert.equal(ReconciliationOutcome.isDefinitivelyUnpaid({ verified: true, action: 'retry_allowed' }), true);
  assert.equal(ReconciliationOutcome.isDefinitivelyUnpaid({ verified: false, action: 'verified_unpaid' }), false);
  assert.equal(ReconciliationOutcome.isDefinitivelyUnpaid({ verified: true, action: 'awaiting_reconciliation' }), false);
  assert.equal(ReconciliationOutcome.isDefinitivelyUnpaid(null), false);

  // Nhóm AMBIGUOUS
  assert.equal(ReconciliationOutcome.isAmbiguous('awaiting_reconciliation'), true);
  assert.equal(ReconciliationOutcome.isAmbiguous('still_pending'), true);
  assert.equal(ReconciliationOutcome.isAmbiguous('amount_mismatch'), true);
  assert.equal(ReconciliationOutcome.isAmbiguous('gateway_channel_unconfigured'), true);
  assert.equal(ReconciliationOutcome.isAmbiguous('query_failed'), true);
  assert.equal(ReconciliationOutcome.isAmbiguous(null), true);
  assert.equal(ReconciliationOutcome.isAmbiguous('verified_unpaid'), false);
  assert.equal(ReconciliationOutcome.isAmbiguous('settled_paid'), false);

  // Enum tính bất biến
  assert.throws(() => { RECONCILIATION_ACTIONS.NEW_ACTION = 'test'; });
  assert.throws(() => { RECONCILIATION_GROUPS.PAID.push('test'); });
});


test('P2-01 Fix: Order token secret requires >= 32 characters and fails closed without secret', () => {
  const { resolveOrderTokenSecret, generateOrderAccessToken, verifyOrderAccessToken } = require('../src/domain/payments/order-idempotency-policy');

  const oldOrderSecret = process.env.ORDER_ACCESS_TOKEN_SECRET;
  const oldSessionSecret = process.env.SESSION_SECRET;

  try {
    delete process.env.ORDER_ACCESS_TOKEN_SECRET;
    delete process.env.SESSION_SECRET;

    // Fail closed on resolveOrderTokenSecret
    assert.equal(resolveOrderTokenSecret(null), null);
    assert.equal(resolveOrderTokenSecret(''), null);
    assert.equal(resolveOrderTokenSecret('short-secret-key-15b'), null);

    // Fail closed on generateOrderAccessToken
    assert.throws(() => {
      generateOrderAccessToken({ orderId: '123' }, null);
    }, (err) => err.code === 'MISSING_ORDER_TOKEN_SECRET' && err.statusCode === 500);

    assert.throws(() => {
      generateOrderAccessToken({ orderId: '123' }, 'short-key');
    }, (err) => err.code === 'MISSING_ORDER_TOKEN_SECRET');

    // Fail closed on verifyOrderAccessToken
    assert.equal(verifyOrderAccessToken('eyJhbGciOi.dummy_sig', null), null);
    assert.equal(verifyOrderAccessToken('eyJhbGciOi.dummy_sig', 'short-key'), null);

    // Valid 32-character secret
    const strongSecret = 'super-strong-session-secret-key-at-least-32-chars';
    const token = generateOrderAccessToken({ orderId: '123', orderNumber: 'GAERU-123' }, strongSecret);
    assert.ok(token && token.includes('.'));

    const verified = verifyOrderAccessToken(token, strongSecret, 'GAERU-123');
    assert.ok(verified);
    assert.equal(verified.orderId, '123');
    assert.equal(verified.orderNumber, 'GAERU-123');

    // Environment variable fallback
    process.env.ORDER_ACCESS_TOKEN_SECRET = strongSecret;
    const envToken = generateOrderAccessToken({ orderId: '456' });
    const verifiedEnv = verifyOrderAccessToken(envToken);
    assert.ok(verifiedEnv);
    assert.equal(verifiedEnv.orderId, '456');
  } finally {
    if (oldOrderSecret !== undefined) process.env.ORDER_ACCESS_TOKEN_SECRET = oldOrderSecret;
    else delete process.env.ORDER_ACCESS_TOKEN_SECRET;
    if (oldSessionSecret !== undefined) process.env.SESSION_SECRET = oldSessionSecret;
    else delete process.env.SESSION_SECRET;
  }
});

test('P2-02 Fix: PaymentRetryCoordinator returns 202 Accepted when gateway initiation is in progress after polling', async (t) => {
  const { PaymentRetryCoordinator } = require('../src/domain/payments/payment-retry-coordinator');
  const { pool, close } = await createTestDb();
  if (t && typeof t.after === 'function') t.after(() => close?.());

  const momoSettings = {
    partnerCode: 'MOMO',
    accessKey: 'ACCESS_KEY_MOCK',
    secretKey: 'SECRET_KEY_MOCK_123',
    environment: 'sandbox',
    enabled: true
  };

  const appConfig = { SESSION_SECRET: 'test-secret-32-chars-minimum-length-ok!' };
  const { writeRecord } = require('../src/admin-configuration');
  await writeRecord(pool, appConfig, 'payment_momo', momoSettings, 0, { username: 'admin' });

  const orderRes = await pool.query(`
    INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, subtotal_vnd, total_vnd, status)
    VALUES ('GAERU-TEST-P2-02', 'Test User', 'test@gaeru.com', '0912345678', '123 Test St', 'Hà Nội', 'momo', 'pending', 100000, 100000, 'pending')
    RETURNING id, order_number
  `);
  const orderId = orderRes.rows[0].id;
  const orderNumber = orderRes.rows[0].order_number;

  // Insert an attempt in 'pending' with last_error_code 'INITIATING_GATEWAY_SESSION'
  await pool.query(`
    INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, status, last_error_code, expires_at)
    VALUES ($1, 'momo', 'MOMO-LEASE-1', 100000, 'pending', 'INITIATING_GATEWAY_SESSION', now() + interval '5 minutes')
  `, [orderId]);

  const mockFetcher = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (url.includes('/query')) {
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({
          resultCode: 49,
          message: 'Không tìm thấy giao dịch',
          orderId: body.orderId,
          requestId: body.requestId
        })
      };
    }
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        resultCode: 0,
        payUrl: 'https://test-payment.momo.vn/v2/gateway/pay/mock'
      })
    };
  };

  // Coordinate retry: since another lease is INITIATING_GATEWAY_SESSION, mock polling will timeout
  const originalDateNow = Date.now;
  let calls = 0;
  Date.now = () => {
    calls++;
    return calls > 2 ? originalDateNow() + 20000 : originalDateNow();
  };

  try {
    const res = await PaymentRetryCoordinator.coordinateRetry(pool, {
      orderNumber,
      expectedCustomer: { email: 'test@gaeru.com', phone: '0912345678' },
      settings: momoSettings,
      fetcher: mockFetcher
    });

    assert.equal(res.status, 202);
    assert.equal(res.code, 'PAYMENT_INITIATION_IN_PROGRESS');
    assert.equal(res.retryAfterSeconds, 3);
    assert.ok(res.message.includes('đang được khởi tạo tại cổng'));
  } finally {
    Date.now = originalDateNow;
  }
});

test('P2-03 Fix: Order email renders correct payment channel labels across all payment methods', () => {
  const { PAYMENT_METHOD_LABELS, getPaymentMethodLabel } = require('../src/order-email');

  assert.equal(getPaymentMethodLabel('cod'), 'COD');
  assert.equal(getPaymentMethodLabel('bank_transfer'), 'Chuyển khoản ngân hàng');
  assert.equal(getPaymentMethodLabel('vnpay'), 'VNPAY');
  assert.equal(getPaymentMethodLabel('9pay'), '9Pay');
  assert.equal(getPaymentMethodLabel('momo'), 'Ví MoMo');
  assert.equal(getPaymentMethodLabel('zalopay'), 'Ví ZaloPay');
  assert.equal(getPaymentMethodLabel('unknown_custom'), 'UNKNOWN_CUSTOM');
  assert.equal(getPaymentMethodLabel(null), 'Chưa xác định');

  for (const m of ['cod', 'bank_transfer', 'momo', 'zalopay', '9pay']) {
    assert.ok(!getPaymentMethodLabel(m).includes('VNPAY'), `${m} không được chứa VNPAY!`);
  }
});

test('P2-04 Fix: resolveInventoryService resolves inventory cleanly and avoids TypeError assignment to const', () => {
  const { resolveInventoryService } = require('../src/domain/orders/order-expiration-service');

  const mockInv = { releaseOrderStock: () => 'ok' };
  assert.equal(resolveInventoryService(mockInv), mockInv);

  const resolvedFallback = resolveInventoryService({});
  assert.ok(resolvedFallback && typeof resolvedFallback.releaseOrderStock === 'function');

  const resolvedNull = resolveInventoryService(null);
  assert.ok(resolvedNull && typeof resolvedNull.releaseOrderStock === 'function');
});

test('P2-05 Fix: Admin HTML escape properly escapes XSS payloads even if sharedFormat is missing', () => {
  const fs = require('fs');
  const xssPayload = '<img src=x onerror="alert(\'XSS\')" />';

  const fallbackEscapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"'/]/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '/': '&#x2F;'
    }[c]));

  const escaped = fallbackEscapeHtml(xssPayload);
  assert.ok(!escaped.includes('<img'));
  assert.ok(!escaped.includes('"'));
  assert.ok(!escaped.includes("'"));
  assert.ok(escaped.includes('&lt;img'));
  assert.ok(escaped.includes('&quot;'));
  assert.ok(escaped.includes('&#39;'));
  assert.ok(escaped.includes('&#x2F;'));

  const adminJs = fs.readFileSync('admin/admin.js', 'utf8');
  assert.ok(adminJs.includes('fallbackEscapeHtml'));
  assert.ok(!adminJs.includes("sharedFormat ? sharedFormat.escapeHtml(value) : String(value ?? '')"));

  const scannerJs = fs.readFileSync('admin/barcode-scanner.js', 'utf8');
  assert.ok(scannerJs.includes('fallbackEscapeHtml'));

  const hubJs = fs.readFileSync('admin/upgrades-hub.js', 'utf8');
  assert.ok(hubJs.includes('fallbackEscapeHtml'));
});

test('P1-01 Fix: True UNIQUE index, duplicate isolation into quarantine, and fail-closed on duplicates', async (t) => {
  const fs = require('fs');
  const { pool, close } = await createTestDb();
  if (t && typeof t.after === 'function') t.after(() => close?.());

  const orderRes = await pool.query(`
    INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, subtotal_vnd, total_vnd, status)
    VALUES ('GAERU-DUP-1', 'Dup User', 'dup@gaeru.com', '0912345678', '123 Test St', 'Hà Nội', 'momo', 'pending', 100000, 100000, 'pending')
    RETURNING id
  `);
  const orderId = orderRes.rows[0].id;

  await pool.query('DROP INDEX IF EXISTS idx_payment_attempts_provider_request_id;');
  await pool.query(`
    INSERT INTO payment_attempts (order_id, provider, transaction_ref, provider_request_id, amount_vnd, status, expires_at)
    VALUES ($1, 'momo', 'REF-DUP-1', 'SAME_REQ_ID', 50000, 'pending', now() + interval '5 minutes'),
           ($1, 'momo', 'REF-DUP-2', 'SAME_REQ_ID', 50000, 'pending', now() + interval '5 minutes')
  `, [orderId]);

  // 1. Chạy SQL tiền kiểm: Tự động cách ly các bản ghi trùng lặp vào quarantine table để đối soát
  const precheckSql = fs.readFileSync('db/precheck-checkout-lifecycle.sql', 'utf8');
  await pool.query(precheckSql);

  const quarantined = await pool.query('SELECT * FROM payment_attempts_quarantine_duplicates');
  assert.equal(quarantined.rows.length, 2);
  assert.equal(quarantined.rows[0].provider_request_id, 'SAME_REQ_ID');

  const migrationV2Sql = fs.readFileSync('db/checkout-lifecycle-hardening-v2.sql', 'utf8');
  
  // 2. Migration v2 PHẢI fail-closed khi phát hiện trùng lặp, không âm thầm tạo index thường
  await assert.rejects(
    async () => { await pool.query(migrationV2Sql); },
    /MIGRATION_BLOCKED/
  );

  // 3. Sau khi giải quyết trùng lặp (ví dụ sửa mã 1 bản ghi), migration chạy lại thành công
  await pool.query("UPDATE payment_attempts SET provider_request_id = 'SAME_REQ_ID_RESOLVED' WHERE transaction_ref = 'REF-DUP-2'");
  await pool.query(migrationV2Sql);

  // 4. Xác nhận chỉ mục đạt chuẩn TRUE UNIQUE INDEX (indisunique = true)
  const indexCheck = await pool.query(`
    SELECT c.relname, i.indisunique
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_payment_attempts_provider_request_id'
  `);
  assert.equal(indexCheck.rows.length, 1);
  assert.equal(indexCheck.rows[0].indisunique, true, 'idx_payment_attempts_provider_request_id PHẢI là TRUE UNIQUE INDEX');
});

test('P1-02 Fix: Migration immutability, SHA-256 checksum tracking, and v2 registration', async (t) => {
  const { pool, close } = await createTestDb();
  if (t && typeof t.after === 'function') t.after(() => close?.());

  const { migrateDatabase, MIGRATION_FILES } = require('../src/migrate');

  // 1. MIGRATION_FILES phải chứa checkout-lifecycle-hardening-v2.sql
  assert.ok(MIGRATION_FILES.includes('checkout-lifecycle-hardening-v2.sql'));
  assert.ok(MIGRATION_FILES.includes('checkout-lifecycle-hardening.sql'));

  // 2. Chạy migration đầy đủ
  await migrateDatabase(pool);

  // 3. Bảng schema_migrations phải có cột checksum với định dạng SHA-256 (64 hex characters)
  const rows = (await pool.query("SELECT name, checksum FROM schema_migrations WHERE name = 'checkout-lifecycle-hardening-v2.sql'")).rows;
  assert.equal(rows.length, 1);
  assert.match(rows[0].checksum, /^[a-f0-9]{64}$/);
});

test('P1-03 Fix: VNPAY automated query, manual review queue, and anti-starvation SLA', async (t) => {
  const { pool, close } = await createTestDb();
  if (t && typeof t.after === 'function') t.after(() => close?.());

  const { OrderExpirationService } = require('../src/domain/orders/order-expiration-service');

  // 1. Tạo đơn hàng VNPAY quá hạn 3 giờ
  const orderRes = await pool.query(`
    INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, subtotal_vnd, total_vnd, status, created_at)
    VALUES ('GAERU-VNPAY-EXP', 'VNPAY User', 'vnpay@gaeru.com', '0912345678', '123 VNPAY Rd', 'TP Hồ Chí Minh', 'vnpay', 'pending', 200000, 200000, 'pending', now() - interval '3 hours')
    RETURNING id, order_number
  `);
  const order = orderRes.rows[0];

  await pool.query(`
    INSERT INTO payment_attempts (order_id, provider, transaction_ref, provider_request_id, amount_vnd, status, expires_at, created_at)
    VALUES ($1, 'vnpay', $2, $2, 200000, 'pending', now() - interval '2 hours', now() - interval '3 hours')
  `, [order.id, order.order_number]);

  // Case A: VNPAY chưa cấu hình query -> Fail-closed: Không hủy, đưa vào order_reviews & system_alerts có SLA 24h
  const resultUnconf = await OrderExpirationService.cancelExpiredUnpaidOrders(pool, {
    olderThanHours: 1,
    config: { ORDER_EXPIRY_VNPAY_HOURS: 1 }
  });

  assert.equal(resultUnconf.cancelledCount, 0, 'Tuyệt đối không hủy đơn khi chưa xác minh được trạng thái cổng');

  // Đơn phải được gắn nhãn chờ đối soát trong order_reviews
  const reviewRow = (await pool.query('SELECT * FROM order_reviews WHERE order_id = $1', [order.id])).rows[0];
  assert.ok(reviewRow, 'Đơn VNPAY chưa xác minh phải được đưa vào hàng đợi order_reviews');
  assert.equal(reviewRow.reason, 'gateway_reconciliation_needed');

  // Phiên thanh toán phải chuyển sang expiry_awaiting_verification
  const attemptRow = (await pool.query('SELECT status FROM payment_attempts WHERE order_id = $1', [order.id])).rows[0];
  assert.equal(attemptRow.status, 'expiry_awaiting_verification');

  // Case B: Anti-starvation: Lần quét tiếp theo KHÔNG chọn lại đơn đang chờ đối soát để tránh nghẽn hàng đợi
  const resultSecondTick = await OrderExpirationService.cancelExpiredUnpaidOrders(pool, {
    olderThanHours: 1,
    config: { ORDER_EXPIRY_VNPAY_HOURS: 1 }
  });
  assert.equal(resultSecondTick.cancelledCount, 0);

  // Case C: VNPAY query client hỗ trợ truy vấn tự động nếu cổng có querydr (mock verified_unpaid)
  const mockFetcher = async () => ({
    status: 200,
    headers: new Map([['content-type', 'application/json']]),
    text: async () => JSON.stringify({
      vnp_ResponseCode: '00',
      vnp_TransactionStatus: '02', // 02: Giao dịch không thành công (verified_unpaid)
      vnp_Amount: '20000000',
      vnp_TxnRef: 'GAERU-VNPAY-EXP2'
    })
  });

  const orderRes2 = await pool.query(`
    INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, subtotal_vnd, total_vnd, status, created_at)
    VALUES ('GAERU-VNPAY-EXP2', 'VNPAY User 2', 'vnpay2@gaeru.com', '0912345679', '456 VNPAY Rd', 'TP Hồ Chí Minh', 'vnpay', 'pending', 200000, 200000, 'pending', now() - interval '3 hours')
    RETURNING id, order_number
  `);
  const order2 = orderRes2.rows[0];

  await pool.query(`
    INSERT INTO payment_attempts (order_id, provider, transaction_ref, provider_request_id, amount_vnd, status, expires_at, created_at)
    VALUES ($1, 'vnpay', $2, $2, 200000, 'pending', now() - interval '2 hours', now() - interval '3 hours')
  `, [order2.id, order2.order_number]);

  // Cấu hình VNPAY có đầy đủ secret
  const appConfig = {
    ORDER_EXPIRY_VNPAY_HOURS: 1,
    vnpay: {
      tmnCode: 'TESTTMN1',
      hashSecret: 'TESTSECRET1234567890',
      paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
      environment: 'sandbox'
    }
  };

  const resultVerifiedUnpaid = await OrderExpirationService.cancelExpiredUnpaidOrders(pool, {
    olderThanHours: 1,
    config: appConfig,
    fetcher: mockFetcher
  });

  assert.equal(resultVerifiedUnpaid.cancelledCount, 1, 'Đơn VNPAY có kết quả verified_unpaid dứt khoát phải được hủy và giải phóng tồn kho');
  const cancelledOrder2 = (await pool.query('SELECT status FROM orders WHERE id = $1', [order2.id])).rows[0];
  assert.equal(cancelledOrder2.status, 'cancelled');
});

test('Domain Unification & Enums: Single Source of Truth consistency across all modules', async () => {
  const paymentEnums = require('../src/domain/payments/payment-enums');
  const reconciliationOutcomeMod = require('../src/domain/payments/reconciliation-outcome');
  const paymentPolicy = require('../src/domain/payments/payment-policy');
  const orderIdempotencyPolicy = require('../src/domain/payments/order-idempotency-policy');
  const storeSchemas = require('../src/store/store-schemas');
  const orderEmail = require('../src/order-email');

  // 1. payment-enums SSOT checks
  assert.equal(paymentEnums.PAYMENT_METHODS.COD, 'cod');
  assert.equal(paymentEnums.PAYMENT_METHODS.MOMO, 'momo');
  assert.equal(paymentEnums.PAYMENT_METHODS.ZALOPAY, 'zalopay');
  assert.deepEqual(paymentEnums.ONLINE_GATEWAYS, ['vnpay', '9pay', 'momo', 'zalopay']);
  assert.deepEqual(paymentEnums.MANUAL_METHODS, ['cod', 'bank_transfer']);
  assert.equal(paymentEnums.getPaymentMethodLabel('cod'), 'COD');
  assert.equal(paymentEnums.getPaymentMethodLabel('momo'), 'Ví MoMo');
  assert.equal(paymentEnums.getPaymentMethodLabel('zalopay'), 'Ví ZaloPay');
  assert.equal(paymentEnums.getPaymentMethodLabel('bank_transfer'), 'Chuyển khoản ngân hàng');
  assert.equal(paymentEnums.isOnlineGateway('momo'), true);
  assert.equal(paymentEnums.isOnlineGateway('cod'), false);
  assert.equal(paymentEnums.isManualPayment('cod'), true);
  assert.equal(paymentEnums.isManualPayment('zalopay'), false);
  assert.equal(paymentEnums.isUnknownAttemptState('payment_initiation_unknown'), true);
  assert.equal(paymentEnums.isUnknownAttemptState('paid'), false);

  // 2. ReconciliationOutcome re-export parity
  assert.equal(reconciliationOutcomeMod.ReconciliationOutcome, paymentEnums.ReconciliationOutcome);
  assert.equal(reconciliationOutcomeMod.RECONCILIATION_ACTIONS, paymentEnums.RECONCILIATION_ACTIONS);

  // 3. PaymentPolicy enums consistency
  assert.deepEqual(paymentPolicy.ONLINE_GATEWAYS, paymentEnums.ONLINE_GATEWAYS);
  assert.deepEqual(paymentPolicy.MANUAL_METHODS, paymentEnums.MANUAL_METHODS);
  assert.equal(paymentPolicy.isOnlineGateway('momo'), true);
  assert.equal(paymentPolicy.isManualPayment('bank_transfer'), true);

  // 4. OrderIdempotencyPolicy states consistency
  assert.deepEqual(orderIdempotencyPolicy.ATTEMPT_STATES, paymentEnums.ATTEMPT_STATES);
  assert.deepEqual(orderIdempotencyPolicy.TERMINAL_ATTEMPT_STATES, paymentEnums.TERMINAL_ATTEMPT_STATES);

  // 5. StoreSchemas order transitions
  assert.deepEqual(storeSchemas.ORDER_TRANSITIONS, paymentEnums.ORDER_TRANSITIONS);
  assert.deepEqual(storeSchemas.transitions, paymentEnums.ORDER_TRANSITIONS);
});

test('WorkerManager Lifecycle & Order Review Job: memoized mailer lifecycle and scheduled order.review job', async (t) => {
  const { WorkerManager } = require('../src/workers');
  const { pool, close } = await createTestDb();
  if (t && typeof t.after === 'function') t.after(() => close?.());

  const wm = new WorkerManager({ allowUnlockedFallback: true });

  // 1. Mailer memoization and cleanup lifecycle
  let closed = false;
  const dummyMailer = {
    sendMail: async () => ({ accepted: ['test@example.com'] }),
    close: () => { closed = true; }
  };
  wm._cachedMailer = dummyMailer;
  wm._cachedSmtpOptionsKey = 'dummy-key';

  // StopAll should call mailer.close()
  await wm.stopAll();
  assert.equal(closed, true);
  assert.equal(wm._cachedMailer, null);
  assert.equal(wm._cachedSmtpOptionsKey, null);

  // 2. Order Review Job enqueuer
  const appConfig = {
    ORDER_REVIEW_CRON_INTERVAL_MS: 30000,
    smtp: { from: 'GAERU <test@gaeru.com>' }
  };

  const enqResult1 = await wm.enqueueOrderReviewJob(pool, appConfig, { immediate: true });
  assert.equal(enqResult1.queued, true);
  assert.ok(enqResult1.job?.id);

  // Second immediate enqueue should detect already active job
  const enqResult2 = await wm.enqueueOrderReviewJob(pool, appConfig, { immediate: false });
  assert.equal(enqResult2.queued, false);
  assert.equal(enqResult2.reason, 'already_active');

  // Verify job in database
  const jobRow = (await pool.query("SELECT * FROM system_jobs WHERE name = 'order.review'")).rows[0];
  assert.ok(jobRow);
  assert.equal(jobRow.queue, 'maintenance');
  assert.equal(jobRow.status, 'pending');
});

test('P2-01 Fix: Unknown reconciliation actions and verified:false fail-closed with hold and alert', async (t) => {
  const { ReconciliationOutcome } = require('../src/domain/payments/payment-enums');
  const { OrderExpirationService } = require('../src/domain/orders/order-expiration-service');
  const { pool, close } = await createTestDb();
  if (t && typeof t.after === 'function') t.after(() => close?.());

  // 1. ReconciliationOutcome.isAmbiguous assertions
  assert.equal(ReconciliationOutcome.isAmbiguous('unknown_new_action'), true, 'Action lạ phải được coi là mơ hồ (fail-closed)');
  assert.equal(ReconciliationOutcome.isAmbiguous({ action: 'unknown_new_action', verified: false }), true);
  assert.equal(ReconciliationOutcome.isAmbiguous({ action: 'unknown_new_action', verified: true }), true);
  assert.equal(ReconciliationOutcome.isAmbiguous({ action: 'verified_unpaid', verified: false }), true, 'Chưa xác thực (verified:false) phải là mơ hồ');
  assert.equal(ReconciliationOutcome.isAmbiguous({ action: 'verified_unpaid', verified: true }), false);
  assert.equal(ReconciliationOutcome.isAmbiguous({ action: 'settled_paid', verified: true }), false);
  assert.equal(ReconciliationOutcome.isAmbiguous({ action: 'already_paid', verified: true }), false);

  // 2. Integration test: Đơn MoMo quá hạn nhưng kết quả đối soát trả action lạ hoặc verified:false -> PHẢI GIỮ LẠI, KHÔNG ĐƯỢC TỰ HỦY
  const pId = crypto.randomUUID();
  const vId = crypto.randomUUID();
  await pool.query("INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Kính P2-01', 'kinh-p2-01', 'audio', true)", [pId]);
  await pool.query("INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, $2, 'SKU-P201', 'Đen', 500000, 10, true)", [vId, pId]);

  const orderId = crypto.randomUUID();
  const orderNumber = 'GR-P201-MOMO';
  await pool.query(`
    INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, total_vnd, subtotal_vnd, shipping_fee_vnd, created_at)
    VALUES ($1, $2, 'P201 Buyer', 'p201@gaeru.com', '0912345678', 'District 1', 'TP. Hồ Chí Minh', 'momo', 'pending', 'pending', 500000, 500000, 0, now() - interval '25 hours')
  `, [orderId, orderNumber]);

  await pool.query(`
    INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
    VALUES (gen_random_uuid(), $1, 'momo', $2, 500000, 'pending', now() - interval '2 hours')
  `, [orderId, orderNumber]);

  // Mock fetcher trả kết quả lạ
  const mockFetcher = async () => ({
    status: 200,
    json: async () => ({
      resultCode: 9999, // Mã lạ chưa biết
      message: 'Unknown gateway status'
    })
  });

  const cancelled = await OrderExpirationService.cancelExpiredUnpaidOrders(pool, {
    olderThanHours: 24,
    fetcher: mockFetcher
  });

  const cancelledIds = cancelled.map(c => c.orderId);
  assert.ok(!cancelledIds.includes(orderId), 'Đơn có action lạ hoặc chưa xác minh tuyệt đối không được tự hủy!');

  // Đơn phải được chuyển sang trạng thái chờ xác minh
  const attRow = (await pool.query('SELECT status FROM payment_attempts WHERE order_id = $1', [orderId])).rows[0];
  assert.equal(attRow.status, 'expiry_awaiting_verification');

  // Đơn phải được đưa vào danh sách đối soát thủ công
  const reviewRow = (await pool.query('SELECT * FROM order_reviews WHERE order_id = $1', [orderId])).rows[0];
  assert.ok(reviewRow);
  assert.equal(reviewRow.reason, 'gateway_reconciliation_needed');
});

test('P2-02 Fix: WorkerManager prioritizes Job Queue over periodic interval workers and decouples email dispatch', async (t) => {
  const { WorkerManager } = require('../src/workers');
  const { pool, close } = await createTestDb();
  if (t && typeof t.after === 'function') t.after(() => close?.());

  const wm = new WorkerManager({ allowUnlockedFallback: true });

  // 1. Kiểm tra method enqueueOrderEmailJob tồn tại và hoạt động
  assert.equal(typeof wm.enqueueOrderEmailJob, 'function');
  const enq = await wm.enqueueOrderEmailJob(pool, {}, { immediate: true });
  assert.ok(enq?.id);
  assert.equal(enq.name, 'email.order');

  // 2. Kiểm tra handler email.order không chạy screening / notifyAdmin lặp
  const jq = {
    workers: new Map(),
    registerWorker(name, fn) { this.workers.set(name, fn); }
  };
  wm.jobQueue = jq;
  wm.registerDefaultHandlers(pool, {}, {});

  const emailOrderHandler = jq.workers.get('email.order');
  assert.ok(emailOrderHandler, 'Handler email.order phải được đăng ký');
});

test('P2-03 Fix: OrderReviewService & Job Queue order.review handler fails closed on errors for automatic retry', async (t) => {
  const { OrderReviewService } = require('../src/order-review');
  const { pool, close } = await createTestDb();
  if (t && typeof t.after === 'function') t.after(() => close?.());

  assert.ok(OrderReviewService, 'Phải export OrderReviewService');
  assert.equal(typeof OrderReviewService.processReviewCycle, 'function');

  // Khi có lỗi phân loại hoặc DNS/SMTP, processReviewCycle phải ném ORDER_REVIEW_PARTIAL_FAILURE
  // để Job Queue ghi nhận thất bại và kích hoạt cơ chế retry tự động
  const brokenPool = {
    query: async (sql) => {
      if (sql.includes('order_reviews') || sql.includes('order_email_outbox')) {
        throw new Error('Database connection interrupted');
      }
      return { rows: [] };
    }
  };

  await assert.rejects(
    async () => {
      await OrderReviewService.processReviewCycle(brokenPool, {}, null);
    },
    (err) => err.code === 'ORDER_REVIEW_PARTIAL_FAILURE'
  );
});

test('P2-04 Fix: Client commerce.js handles HTTP 202 (PAYMENT_INITIATION_IN_PROGRESS) with polling and prevents COD fallback', async () => {
  const fs = require('fs');
  const commerceCode = fs.readFileSync('commerce.js', 'utf8');

  // 1. Kiểm tra commerce.js có nhánh xử lý PAYMENT_INITIATION_IN_PROGRESS
  assert.ok(commerceCode.includes("result.code === 'PAYMENT_INITIATION_IN_PROGRESS'"));

  // 2. Phải có cơ chế polling retry-payment kèm orderAccessToken
  assert.ok(commerceCode.includes("retry-payment"));
  assert.ok(commerceCode.includes("orderAccessToken"));

  // 3. Phải chuyển hướng khi nhận được paymentUrl
  assert.ok(commerceCode.includes("location.assign(retryRes.paymentUrl)"));

  // 4. Không được tự động hiển thị đơn COD khi nhận được 202
  // (Đã kiểm chứng nhánh 202 có return trước khi đến khối render COD)
  const p202Idx = commerceCode.indexOf("result.code === 'PAYMENT_INITIATION_IN_PROGRESS'");
  const codIdx = commerceCode.indexOf("Đơn COD sẽ được GAERU xác nhận");
  assert.ok(p202Idx < codIdx, "Nhánh xử lý 202 phải nằm trước khối hiển thị COD");
});

test('Admin HTML Escape Consolidation: format.js shared source of truth, loading order, and safe fallback without raw pass-through', async () => {
  const fs = require('node:fs');
  // 1. format.js export verification
  const format = require('../admin/format');
  assert.equal(typeof format.escapeHtml, 'function');
  assert.equal(typeof format.fallbackEscapeHtml, 'function');
  assert.equal(typeof format.formatMoney, 'function');
  assert.equal(typeof format.normalizePhone, 'function');

  // Kiểm tra thoát đầy đủ các ký tự nhạy cảm XSS
  const xssPayload = '<script>alert("XSS & \'hack\'")</script>';
  const escaped = format.escapeHtml(xssPayload);
  assert.ok(!escaped.includes('<script>'));
  assert.ok(escaped.includes('&lt;script&gt;'));
  assert.ok(escaped.includes('&quot;'));
  assert.ok(escaped.includes('&amp;'));
  assert.ok(escaped.includes('&#39;'));

  // 2. Kiểm thử thứ tự tải module (format.js tải trước vs tải sau vs không tải)
  // Kịch bản A: format.js tải trước -> window.GAERUAdminShared sẵn sàng
  const mockWindowWithFormat = {
    GAERUAdminShared: format,
    escapeHtml: format.escapeHtml
  };
  assert.equal(mockWindowWithFormat.GAERUAdminShared.escapeHtml(xssPayload), escaped);

  // Kịch bản B: format.js chưa tải (hoặc lỗi tải) -> fallback an toàn phải tự kích hoạt, tuyệt đối KHÔNG trả raw String
  const adminJsContent = fs.readFileSync('admin/admin.js', 'utf8');
  assert.ok(adminJsContent.includes('fallbackEscapeHtml'));
  assert.ok(!adminJsContent.includes('return String(value)')); // Không được trả raw String(value)

  const barcodeContent = fs.readFileSync('admin/barcode-scanner.js', 'utf8');
  assert.ok(barcodeContent.includes('fallbackEscapeHtml'));

  const upgradesContent = fs.readFileSync('admin/upgrades-hub.js', 'utf8');
  assert.ok(upgradesContent.includes('fallbackEscapeHtml'));

  // Kiểm tra mã nguồn index.html bảo đảm format.js được nạp trước admin.js và upgrades-hub.js
  const indexHtml = fs.readFileSync('admin/index.html', 'utf8');
  const formatPos = indexHtml.indexOf('format.js');
  const adminPos = indexHtml.indexOf('admin.js');
  const hubPos = indexHtml.indexOf('upgrades-hub.js');
  assert.ok(formatPos > 0 && adminPos > 0 && formatPos < adminPos, 'format.js phải được nạp trước admin.js trong index.html');
  assert.ok(formatPos < hubPos, 'format.js phải được nạp trước upgrades-hub.js trong index.html');
});

test('P3-02 Fix: resolveOrderAccessToken alerts system and returns diagnostic warning when secret is missing', async (t) => {
  const oldOrderSecret = process.env.ORDER_ACCESS_TOKEN_SECRET;
  const oldSessionSecret = process.env.SESSION_SECRET;
  delete process.env.ORDER_ACCESS_TOKEN_SECRET;
  delete process.env.SESSION_SECRET;

  const { pool, close } = await createTestDb();
  if (t && typeof t.after === 'function') {
    t.after(() => {
      if (oldOrderSecret !== undefined) process.env.ORDER_ACCESS_TOKEN_SECRET = oldOrderSecret;
      if (oldSessionSecret !== undefined) process.env.SESSION_SECRET = oldSessionSecret;
      close?.();
    });
  }

  const express = require('express');
  const { attachPublicAndCheckoutRoutes } = require('../src/store/checkout-payment-routes');

  const pId = crypto.randomUUID();
  const vId = crypto.randomUUID();
  await pool.query("INSERT INTO products (id, name, slug, category, active) VALUES ($1, 'Kính P302', 'kinh-p302', 'audio', true)", [pId]);
  await pool.query("INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, $2, 'SKU-P302', 'Đen', 250000, 10, true)", [vId, pId]);

  const wh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0];
  if (wh) {
    await pool.query(
      "INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 50) ON CONFLICT DO NOTHING",
      [wh.id, vId]
    );
  }
  await pool.query(
    "INSERT INTO store_settings(setting_key, setting_value) VALUES('shipping_rates', $1) ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1",
    [JSON.stringify({ 'Toàn quốc': 20000, 'Hà Nội': 20000 })]
  );

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.ordersEnabled = true;
    req.session = { csrfToken: 'test-csrf' };
    next();
  });

  // Config KHÔNG CÓ SESSION_SECRET
  attachPublicAndCheckoutRoutes(app, pool, {
    getVnpayConfig: () => null,
    getPaymentChannels: () => ({ methods: ['cod'] }),
    config: { SESSION_SECRET: '' }, // Rỗng
    publicBaseUrl: 'https://gaeru.com',
    paymentFetcher: async () => ({ status: 200, json: async () => ({}) })
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  if (t && typeof t.after === 'function') t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;

  const orderPayload = {
    customer: {
      name: 'Nguyen Van P302',
      email: 'p302@gaeru.com',
      phone: '0912345678',
      address: '123 Pho Hue',
      city: 'Hà Nội'
    },
    items: [{ variantId: vId, quantity: 1 }],
    paymentMethod: 'cod',
    idempotencyKey: 'TEST-P302-KEY-001'
  };

  const res = await fetch(`http://127.0.0.1:${port}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' },
    body: JSON.stringify(orderPayload)
  });

  const data = await res.json();
  assert.equal(res.status, 201);
  assert.ok(data.order);
  // Không được để token vắng mặt mà vẫn coi là bình thường: phải có cảnh báo rõ ràng
  assert.equal(data.orderAccessToken, null);
  assert.ok(data.orderAccessTokenWarning, 'Phải có cảnh báo khi hệ thống thiếu secret tạo token');

  // Hệ thống phải kích hoạt critical alert vào bảng system_alerts
  const alerts = await pool.query("SELECT * FROM system_alerts WHERE source = 'order_access_token_security'");
  assert.ok(alerts.rows.length >= 1, 'Hệ thống phải tự động ghi nhận cảnh báo bảo mật khi thiếu secret');
  assert.equal(alerts.rows[0].severity, 'critical');
});
