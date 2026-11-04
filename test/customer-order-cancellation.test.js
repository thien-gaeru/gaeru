const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { createCustomerExperience } = require('../src/customer-experience');
const {
  validateCancellationEligibility,
  cancelCustomerOrder
} = require('../src/customer-order-cancellation');

test('Customer Order Cancellation - Unit & Integration Test Suite', async (t) => {
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

  // Run full database migrations
  await migrateDatabase(pool);

  // 1. Seed Customer, Product, Variant
  const custA = (await pool.query(
    "INSERT INTO customers(email, full_name, phone, active) VALUES('buyerA@gaeru.com', 'Nguyen Van A', '0912345678', true) RETURNING id"
  )).rows[0];

  const custB = (await pool.query(
    "INSERT INTO customers(email, full_name, phone, active) VALUES('buyerB@gaeru.com', 'Tran Thi B', '0987654321', true) RETURNING id"
  )).rows[0];

  const product = (await pool.query(
    "INSERT INTO products(name, slug, category, active) VALUES('Tai nghe GAERU Pro', 'tai-nghe-gaeru-pro', 'audio', true) RETURNING id"
  )).rows[0];

  const variant = (await pool.query(
    "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, 'PRO-BLACK', 'Màu Đen', 500000, 20, true) RETURNING id",
    [product.id]
  )).rows[0];

  const mainWh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0];
  if (mainWh) {
    await pool.query(
      'INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 20) ON CONFLICT DO NOTHING',
      [mainWh.id, variant.id]
    );
  }

  // Seed Voucher
  const voucher = (await pool.query(
    `INSERT INTO marketing_vouchers (code, title, kind, amount, min_spend_vnd, total_limit, per_customer_limit, starts_at, ends_at, active, public_claim)
     VALUES ('GIAM50K', 'Giảm 50K', 'fixed', 50000, 300000, 10, 1, now() - interval '1 day', now() + interval '30 days', true, true)
     RETURNING id`
  )).rows[0];

  await pool.query(
    "INSERT INTO customer_vouchers (customer_id, voucher_id, source) VALUES ($1, $2, 'saved')",
    [custA.id, voucher.id]
  );

  // Setup Express App
  const app = express();
  app.use(express.json());

  let activeCustomerId = custA.id;
  const csrfTokenValue = 'valid-test-csrf-token';

  app.use((req, res, next) => {
    req.session = {
      customer: activeCustomerId ? { id: activeCustomerId, email: 'buyerA@gaeru.com', fullName: 'Nguyen Van A' } : null,
      csrfToken: csrfTokenValue
    };
    next();
  });

  // Mock requireCsrf
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (req.headers['x-csrf-token'] !== csrfTokenValue) {
        return res.status(403).json({ error: 'CSRF token không hợp lệ.' });
      }
    }
    next();
  });

  app.use('/api/customer', createCustomerExperience(pool));

  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => {
    server.closeAllConnections?.();
    server.close(r);
  }));

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/customer`;
  const defaultHeaders = {
    'Content-Type': 'application/json',
    'x-csrf-token': csrfTokenValue
  };

  // ----------------------------------------------------
  // Unit Tests: validateCancellationEligibility
  // ----------------------------------------------------
  await t.test('validateCancellationEligibility rejects missing, cancelled, processed, or paid orders', () => {
    assert.throws(() => validateCancellationEligibility(null), { status: 404 });
    assert.throws(() => validateCancellationEligibility({ status: 'cancelled' }), { status: 409 });
    assert.throws(() => validateCancellationEligibility({ status: 'processing', payment_status: 'pending' }), { status: 409 });
    assert.throws(() => validateCancellationEligibility({ status: 'shipped', payment_status: 'pending' }), { status: 409 });
    assert.throws(() => validateCancellationEligibility({ status: 'completed', payment_status: 'paid' }), { status: 409 });
    assert.throws(() => validateCancellationEligibility({ status: 'pending', payment_status: 'paid' }), { status: 409 });

    assert.equal(validateCancellationEligibility({ status: 'pending', payment_status: 'pending' }), true);
    assert.equal(validateCancellationEligibility({ status: 'confirmed', payment_status: 'pending' }), true);
  });

  // ----------------------------------------------------
  // Integration Test 1: Unauthenticated access blocked (401)
  // ----------------------------------------------------
  await t.test('POST /orders/:id/cancel returns 401 when customer is not authenticated', async () => {
    activeCustomerId = null;
    const res = await fetch(`${baseUrl}/orders/00000000-0000-0000-0000-000000000001/cancel`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ reason: 'Đổi ý' })
    });
    assert.equal(res.status, 401);
    activeCustomerId = custA.id;
  });

  // ----------------------------------------------------
  // Integration Test 2: IDOR Protection & non-existent order (404)
  // ----------------------------------------------------
  await t.test('POST /orders/:id/cancel rejects other customers order or missing ID with 404', async () => {
    // Create order for Customer B
    const orderB = (await pool.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-20261102-00001', $1, 'Tran Thi B', 'buyerB@gaeru.com', '0987654321', '123 Vo Van Tan', 'TP HCM', 'cod', 'pending', 'pending', 500000, 500000)
       RETURNING id`,
      [custB.id]
    )).rows[0];

    // Customer A attempts to cancel Customer B's order
    const res = await fetch(`${baseUrl}/orders/${orderB.id}/cancel`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ reason: 'Hủy trộm' })
    });
    assert.equal(res.status, 404);
  });

  // ----------------------------------------------------
  // Integration Test 3: Cannot cancel paid order (409)
  // ----------------------------------------------------
  await t.test('POST /orders/:id/cancel rejects paid orders with 409', async () => {
    const paidOrder = (await pool.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-20261102-00002', $1, 'Nguyen Van A', 'buyerA@gaeru.com', '0912345678', '456 Le Loi', 'TP HCM', 'vnpay', 'paid', 'pending', 500000, 500000)
       RETURNING id`,
      [custA.id]
    )).rows[0];

    const res = await fetch(`${baseUrl}/orders/${paidOrder.id}/cancel`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ reason: 'Muốn hủy' })
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.ok(data.error.includes('thanh toán'));
  });

  // ----------------------------------------------------
  // Integration Test 4: Cannot cancel processing or shipped order (409)
  // ----------------------------------------------------
  await t.test('POST /orders/:id/cancel rejects processing or shipped orders with 409', async () => {
    const processingOrder = (await pool.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-20261102-00003', $1, 'Nguyen Van A', 'buyerA@gaeru.com', '0912345678', '456 Le Loi', 'TP HCM', 'cod', 'pending', 'processing', 500000, 500000)
       RETURNING id`,
      [custA.id]
    )).rows[0];

    const res = await fetch(`${baseUrl}/orders/${processingOrder.id}/cancel`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ reason: 'Đổi ý' })
    });
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.ok(data.error.includes('chuẩn bị') || data.error.includes('vận chuyển'));
  });

  // ----------------------------------------------------
  // Integration Test 5: Successful cancellation of pending COD order with atomic stock restoration
  // ----------------------------------------------------
  await t.test('Customer successfully cancels pending unpaid COD order and restores stock atomically', async () => {
    // Set variant stock to 10
    await pool.query('UPDATE product_variants SET stock_quantity = 10 WHERE id = $1', [variant.id]);
    await pool.query('UPDATE warehouse_stock SET quantity = 10 WHERE variant_id = $1', [variant.id]);

    // Create Order with 2 items
    const order = (await pool.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-20261102-00004', $1, 'Nguyen Van A', 'buyerA@gaeru.com', '0912345678', '456 Le Loi', 'TP HCM', 'cod', 'pending', 'pending', 1000000, 1000000)
       RETURNING id`,
      [custA.id]
    )).rows[0];

    await pool.query(
      `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
       VALUES ($1, $2, 'Tai nghe GAERU Pro', 'Màu Đen', 'PRO-BLACK', 2, 500000, 1000000)`,
      [order.id, variant.id]
    );

    // Simulate stock deduction at checkout: 10 - 2 = 8
    await pool.query('UPDATE product_variants SET stock_quantity = 8 WHERE id = $1', [variant.id]);
    await pool.query('UPDATE warehouse_stock SET quantity = 8 WHERE variant_id = $1', [variant.id]);

    // Create a pending payment attempt
    await pool.query(
      `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, status, expires_at)
       VALUES ($1, 'bank_transfer', 'GR-20261102-00004', 1000000, 'pending', now() + interval '1 hour')`,
      [order.id]
    );

    // Cancel order via API
    const res = await fetch(`${baseUrl}/orders/${order.id}/cancel`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ reason: 'Tìm được sản phẩm khác phù hợp hơn' })
    });

    const body = await res.json();
    if (res.status !== 200) console.error('FAILED TEST 5 STATUS:', res.status, body);
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.order.status, 'cancelled');
    assert.equal(body.order.cancellationReason, 'Tìm được sản phẩm khác phù hợp hơn');

    // Verify DB: Order status is cancelled
    const checkOrder = (await pool.query('SELECT status, note, cancellation_reason FROM orders WHERE id = $1', [order.id])).rows[0];
    assert.equal(checkOrder.status, 'cancelled');
    assert.equal(checkOrder.cancellation_reason, 'Tìm được sản phẩm khác phù hợp hơn');
    assert.ok(checkOrder.note.includes('Khách hủy'));

    // Verify DB: Stock restored to 10
    const checkVariant = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0];
    assert.equal(checkVariant.stock_quantity, 10, 'Stock must be atomically restored from 8 to 10');

    // Verify DB: Payment attempt marked failed
    const checkAttempt = (await pool.query('SELECT status FROM payment_attempts WHERE order_id = $1', [order.id])).rows[0];
    assert.equal(checkAttempt.status, 'failed');

    // Verify DB: Audit event recorded
    const auditEvent = (await pool.query(
      "SELECT action, entity_type, entity_id, metadata FROM audit_events WHERE entity_id = $1 AND action = 'order.customer_cancel'",
      [order.id]
    )).rows[0];
    assert.ok(auditEvent, 'Must record order.customer_cancel in audit log');
  });

  // ----------------------------------------------------
  // Integration Test 6: Atomic Voucher Restoration
  // ----------------------------------------------------
  await t.test('Cancellation atomically releases redeemed voucher for customer to use again', async () => {
    const order = (await pool.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, discount_vnd, voucher_code, total_vnd)
       VALUES ('GR-20261102-00005', $1, 'Nguyen Van A', 'buyerA@gaeru.com', '0912345678', '456 Le Loi', 'TP HCM', 'bank_transfer', 'pending', 'pending', 500000, 50000, 'GIAM50K', 450000)
       RETURNING id`,
      [custA.id]
    )).rows[0];

    await pool.query(
      `INSERT INTO voucher_redemptions (order_id, voucher_id, customer_id, discount_vnd, released)
       VALUES ($1, $2, $3, 50000, false)`,
      [order.id, voucher.id, custA.id]
    );

    // Before cancel: voucher is used (released = false)
    const beforeUsage = (await pool.query(
      'SELECT count(*)::int AS count FROM voucher_redemptions WHERE voucher_id = $1 AND customer_id = $2 AND released = false',
      [voucher.id, custA.id]
    )).rows[0].count;
    assert.equal(beforeUsage, 1);

    // Cancel order
    const res = await fetch(`${baseUrl}/orders/${order.id}/cancel`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ reason: 'Nhập sai địa chỉ' })
    });
    assert.equal(res.status, 200);

    // After cancel: voucher is released (released = true)
    const afterUsage = (await pool.query(
      'SELECT count(*)::int AS count FROM voucher_redemptions WHERE voucher_id = $1 AND customer_id = $2 AND released = false',
      [voucher.id, custA.id]
    )).rows[0].count;
    assert.equal(afterUsage, 0, 'Voucher redemption must be released (count active usage = 0)');
  });

  // ----------------------------------------------------
  // Integration Test 7: Atomic GAERU Xu (loyalty points) Refund
  // ----------------------------------------------------
  await t.test('Cancellation atomically refunds redeemed loyalty GAERU Xu back to customer wallet', async () => {
    // Initialize customer loyalty account with 20000 points
    await pool.query(
      `INSERT INTO customer_loyalty (customer_id, points_balance, lifetime_earned, tier)
       VALUES ($1, 20000, 20000, 'bronze')
       ON CONFLICT (customer_id) DO UPDATE SET points_balance = 20000`,
      [custA.id]
    );

    const order = (await pool.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-20261102-00006', $1, 'Nguyen Van A', 'buyerA@gaeru.com', '0912345678', '456 Le Loi', 'TP HCM', 'bank_transfer', 'pending', 'pending', 500000, 480000)
       RETURNING id`,
      [custA.id]
    )).rows[0];

    // Customer used 20,000 points (balance: 20000 -> 0)
    await pool.query(
      `INSERT INTO customer_loyalty_ledger (customer_id, order_id, points, type, balance_after, reason, event_key)
       VALUES ($1, $2, -20000, 'redeem', 0, 'Dùng 20,000 Xu giảm 20,000 ₫', $3)`,
      [custA.id, order.id, `redeem:${order.id}`]
    );
    await pool.query('UPDATE customer_loyalty SET points_balance = 0 WHERE customer_id = $1', [custA.id]);

    // Check balance is 0 before cancel
    const beforeBal = (await pool.query('SELECT points_balance FROM customer_loyalty WHERE customer_id = $1', [custA.id])).rows[0].points_balance;
    assert.equal(beforeBal, 0);

    // Cancel order
    const res = await fetch(`${baseUrl}/orders/${order.id}/cancel`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ reason: 'Không cần mua nữa' })
    });
    assert.equal(res.status, 200);

    // Check balance is restored back to 20,000
    const afterBal = (await pool.query('SELECT points_balance FROM customer_loyalty WHERE customer_id = $1', [custA.id])).rows[0].points_balance;
    assert.equal(afterBal, 20000, 'GAERU Xu balance must be refunded back to 20,000');
  });

  // ----------------------------------------------------
  // Integration Test 8: Cannot cancel an already cancelled order (409)
  // ----------------------------------------------------
  await t.test('Repeated cancellation attempt returns 409 with idempotent message', async () => {
    const order = (await pool.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-20261102-00007', $1, 'Nguyen Van A', 'buyerA@gaeru.com', '0912345678', '456 Le Loi', 'TP HCM', 'cod', 'pending', 'pending', 300000, 300000)
       RETURNING id`,
      [custA.id]
    )).rows[0];

    // First cancel -> 200
    const res1 = await fetch(`${baseUrl}/orders/${order.id}/cancel`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ reason: 'Hủy lần 1' })
    });
    assert.equal(res1.status, 200);

    // Second cancel -> 409
    const res2 = await fetch(`${baseUrl}/orders/${order.id}/cancel`, {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ reason: 'Hủy lần 2' })
    });
    assert.equal(res2.status, 409);
    const body2 = await res2.json();
    assert.ok(body2.error.includes('trước đó'));
  });

  // ----------------------------------------------------
  // Integration Test 9: Orders list reflects cancellation reason
  // ----------------------------------------------------
  await t.test('GET /orders and GET /orders/:id return cancellationReason field', async () => {
    const listRes = await fetch(`${baseUrl}/orders`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    const cancelled = listData.orders.find(o => o.orderNumber === 'GR-20261102-00007');
    assert.ok(cancelled);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancellationReason, 'Hủy lần 1');

    const detailRes = await fetch(`${baseUrl}/orders/${cancelled.id}`);
    assert.equal(detailRes.status, 200);
    const detailData = await detailRes.json();
    assert.equal(detailData.order.cancellationReason, 'Hủy lần 1');
  });

  // ----------------------------------------------------
  // Integration Test 10: Storefront UI contains data-cancel-order
  // ----------------------------------------------------
  await t.test('Client-side customer-experience.js renders data-cancel-order action for pending orders', async () => {
    const fs = require('fs');
    const path = require('path');
    const clientCode = fs.readFileSync(path.join(__dirname, '..', 'customer-experience.js'), 'utf8');
    assert.ok(clientCode.includes('data-cancel-order'), 'Must contain data-cancel-order action in client markup');
    assert.ok(clientCode.includes('/orders/\' + orderId + \'/cancel') || clientCode.includes('/orders/\'+orderId+\'/cancel'), 'Must dispatch POST /orders/:id/cancel on user confirmation');
  });
});
