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
const { discount, MAX_DISCOUNT_PERCENT } = require('../src/marketing');
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
     VALUES ($1, 'GR-EXPIRED-PA', 'Expired Buyer', 'pa-expired@gaeru.com', '0912345680', 'District 5', 'TP. Hồ Chí Minh', 'momo', 'pending', 'pending', 500000, 500000, 0, now() - interval '30 hours')`,
    [order3Id]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES (gen_random_uuid(), $1, $2, 'Tai Nghe Active', 'Trắng', 'SKU-ACTIVE-01', 1, 500000, 500000)`,
    [order3Id, vId]
  );
  await pool.query(
    `INSERT INTO payment_attempts (id, order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES (gen_random_uuid(), $1, 'momo', 'GR-EXPIRED-PA', 500000, 'pending', now() - interval '1 hour')`,
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

  // Run OrderExpirationService
  const cancelled = await OrderExpirationService.cancelExpiredUnpaidOrders(pool);
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

