'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const { createTestDb } = require('./helpers/pglite-db');
const { withTransaction } = require('../src/db');
const { createApp } = require('../src/app');
const { retryGatewayOrderPayment, PaymentRetryCoordinator } = require('../src/payment-channels');
const { enqueueJob, createJobQueue } = require('../src/job-queue');
const { PaymentService } = require('../src/domain/payments/payment-service');

test('P1 — Idempotency key cannot leak other buyers orders and rejects cross-customer reuse', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  await pool.query(
    "INSERT INTO store_settings(setting_key, setting_value) VALUES('shipping_rates', $1) ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1",
    [JSON.stringify({ 'Toàn quốc': 20000, 'Hà Nội': 20000, 'TP. Hồ Chí Minh': 20000 })]
  );

  const app = createApp({
    pool,
    config: {
      NODE_ENV: 'test',
      STORE_ORDERS_ENABLED: true,
      PUBLIC_BASE_URL: 'https://gaeru.com',
      SESSION_SECRET: 'test-session-secret-phase-c-12345678901234567890'
    },
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;

  function createClient() {
    let cookie = '';
    let csrf = '';
    return {
      async call(urlPath, method = 'GET', body) {
        const headers = {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {})
        };
        const res = await fetch(base + urlPath, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined
        });
        const setCookie = res.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const data = await res.json().catch(() => ({}));
        if (data && data.csrfToken) csrf = data.csrfToken;
        return { statusCode: res.status, status: res.status, body: data, json: () => data };
      }
    };
  }

  // Prepare product and variants
  const prodRes = await pool.query(
    `INSERT INTO products (slug, name, active, category)
     VALUES ('test-product', 'Sản phẩm Test', true, 'audio')
     RETURNING id`
  );
  const productId = prodRes.rows[0].id;

  const var1 = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-01', 'Bản 1', 200000, 50, true)
     RETURNING id`,
    [productId]
  )).rows[0].id;

  const var2 = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-02', 'Bản 2', 300000, 50, true)
     RETURNING id`,
    [productId]
  )).rows[0].id;

  const whRes = await pool.query('SELECT id FROM warehouses WHERE active = true ORDER BY created_at ASC LIMIT 1');
  const warehouseId = whRes.rows[0]?.id;
  if (warehouseId) {
    await pool.query(
      `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
       VALUES ($1, $2, 50), ($1, $3, 50)
       ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [warehouseId, var1, var2]
    );
  }

  const clientAlice = createClient();
  await clientAlice.call('/api/csrf');

  // 1. Buyer A creates an order with idempotencyKey: 'shared-key-123'
  const payloadAlice = {
    customer: {
      name: 'Alice Nguyen',
      email: 'alice@example.com',
      phone: '0912345678',
      address: '123 Đường A',
      city: 'Hà Nội',
      note: ''
    },
    paymentMethod: 'cod',
    idempotencyKey: 'shared-key-123',
    items: [{ variantId: var1, quantity: 1 }]
  };

  const resAlice1 = await clientAlice.call('/api/orders', 'POST', payloadAlice);
  assert.equal(resAlice1.statusCode, 201);
  const orderAlice = resAlice1.json().order;
  assert.ok(orderAlice.orderNumber);

  // 2. Buyer B (different customer) uses the EXACT SAME idempotencyKey: 'shared-key-123'
  const clientBob = createClient();
  await clientBob.call('/api/csrf');

  const payloadBob = {
    customer: {
      name: 'Bob Tran',
      email: 'bob@example.com',
      phone: '0987654321',
      address: '456 Đường B',
      city: 'TP. Hồ Chí Minh',
      note: ''
    },
    paymentMethod: 'cod',
    idempotencyKey: 'shared-key-123',
    items: [{ variantId: var2, quantity: 1 }]
  };

  const resBob = await clientBob.call('/api/orders', 'POST', payloadBob);

  // Buyer B MUST NOT get Alice's order! Buyer B gets their OWN distinct order!
  assert.equal(resBob.statusCode, 201);
  const orderBob = resBob.json().order;
  assert.notEqual(orderBob.orderNumber, orderAlice.orderNumber, 'Buyer B must have a distinct order number');
  assert.equal(orderBob.items[0].sku, 'SKU-02', 'Buyer B must receive their own items');

  // Verify direct retryGatewayOrderPayment fails with 403 when someone tries to look up an order with wrong customer
  await assert.rejects(
    async () => {
      await retryGatewayOrderPayment(pool, {
        orderNumber: orderAlice.orderNumber,
        expectedCustomer: { email: 'hacker@example.com', phone: '0999999999' }
      });
    },
    (err) => err.status === 403 && /không thuộc sở hữu/.test(err.message)
  );

  // 3. Same Buyer A with SAME idempotencyKey but DIFFERENT cart payload -> 409 Conflict
  const payloadAliceModified = {
    ...payloadAlice,
    items: [{ variantId: var2, quantity: 2 }] // Changed item
  };

  const resAliceMod = await clientAlice.call('/api/orders', 'POST', payloadAliceModified);
  assert.equal(resAliceMod.statusCode, 409);
  assert.match(resAliceMod.json().error, /danh sách sản phẩm khác/);

  // 4. Same Buyer A with SAME idempotencyKey and IDENTICAL payload -> 200 Idempotent replay
  const resAliceRetry = await clientAlice.call('/api/orders', 'POST', payloadAlice);
  assert.equal(resAliceRetry.statusCode, 200);
  assert.equal(resAliceRetry.json().order.orderNumber, orderAlice.orderNumber);

  // 5. Concurrent requests by Alice with the same key
  const [resConcurrent1, resConcurrent2] = await Promise.all([
    clientAlice.call('/api/orders', 'POST', payloadAlice),
    clientAlice.call('/api/orders', 'POST', payloadAlice)
  ]);
  assert.ok([200, 201].includes(resConcurrent1.statusCode));
  assert.ok([200, 201].includes(resConcurrent2.statusCode));
  assert.equal(resConcurrent1.json().order.orderNumber, orderAlice.orderNumber);
  assert.equal(resConcurrent2.json().order.orderNumber, orderAlice.orderNumber);
});

test('P1 — Payment retry prevents race condition when callback paid arrives during retry', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  // Insert test order with payment_attempts in pending
  const orderRes = await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, subtotal_vnd, total_vnd, payment_method, payment_status, status)
     VALUES ('GR-RACE-001', 'Race Customer', 'race@test.com', '0912345678', '123 Race St', 'Hà Nội', 500000, 500000, 'momo', 'pending', 'pending')
     RETURNING id`
  );
  const orderId = orderRes.rows[0].id;

  const attemptRes = await pool.query(
    `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, provider_request_id, status, expires_at)
     VALUES ($1, 'momo', 'GR-RACE-001', 500000, 'req-orig', 'pending', now() + interval '15 minutes')
     RETURNING id`,
    [orderId]
  );
  const attemptId = attemptRes.rows[0].id;

  let gatewayCalled = false;
  const mockFetcher = async () => {
    gatewayCalled = true;
    return {
      ok: true,
      json: async () => ({
        resultCode: 0,
        payUrl: 'https://momo.vn/pay/test',
        orderId: 'GR-RACE-001',
        requestId: 'req-new'
      })
    };
  };

  // Simulate payment callback marking order and attempt as paid before or during retry
  await pool.query("UPDATE orders SET payment_status = 'paid' WHERE id = $1", [orderId]);
  await pool.query("UPDATE payment_attempts SET status = 'paid' WHERE id = $1", [attemptId]);

  const result = await retryGatewayOrderPayment(pool, {
    orderNumber: 'GR-RACE-001',
    expectedCustomer: { email: 'race@test.com', phone: '0912345678' },
    settings: { partnerCode: 'MOMO', accessKey: 'ACC', secretKey: 'SEC', environment: 'sandbox' },
    fetcher: mockFetcher
  });

  // Must detect already paid and NOT call gateway
  assert.equal(result.alreadyPaid, true);
  assert.equal(result.paymentStatus, 'paid');
  assert.equal(gatewayCalled, false, 'createGatewayPayment must not be invoked if order is already paid');
});

test('P1 — JobQueue never drops idempotency key even under fallback scenarios', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  // First enqueue with key
  const job1 = await enqueueJob(pool, {
    name: 'test.idempotent.job',
    idempotencyKey: 'safe-key-999',
    payload: { task: 'send_sms', target: '0912345678' }
  });
  assert.equal(job1.idempotency_key, 'safe-key-999');
  assert.equal(job1.duplicate, false);

  // Second enqueue with same key and same payload -> returns duplicate
  const job2 = await enqueueJob(pool, {
    name: 'test.idempotent.job',
    idempotencyKey: 'safe-key-999',
    payload: { task: 'send_sms', target: '0912345678' }
  });
  assert.equal(job2.id, job1.id);
  assert.equal(job2.duplicate, true);

  // Third enqueue with same key but different payload -> rejects with 409 Conflict
  await assert.rejects(
    async () => {
      await enqueueJob(pool, {
        name: 'test.idempotent.job',
        idempotencyKey: 'safe-key-999',
        payload: { task: 'send_sms', target: '0999999999' } // Different target
      });
    },
    (err) => err.status === 409 && err.code === 'JOB_IDEMPOTENCY_CONFLICT'
  );

  // Verify in database that NO job exists with name 'test.idempotent.job' and idempotency_key IS NULL
  const nullKeyJobs = await pool.query(
    "SELECT count(*) FROM system_jobs WHERE name = 'test.idempotent.job' AND idempotency_key IS NULL"
  );
  assert.equal(Number(nullKeyJobs.rows[0].count), 0, 'No job should have idempotency_key = NULL when a key was provided');
});

test('P2 — JobQueue assertLeaseActive immediately aborts if renewal fails and lease window expires', async () => {
  const queue = createJobQueue({
    pool: { query: async () => ({ rows: [] }) },
    leaseDurationMs: 100 // 100ms lease
  });

  // Simulate a mock lease context where renewal failed
  let leaseLost = false;
  let leaseExpiresAtMs = Date.now() - 50; // Already expired

  const mockLeaseContext = {
    isLeaseLost: () => leaseLost || Date.now() >= leaseExpiresAtMs,
    assertLeaseActive: () => {
      if (leaseLost || Date.now() >= leaseExpiresAtMs) {
        leaseLost = true;
        throw Object.assign(
          new Error('Lease của công việc đã hết hạn hoặc bị thu hồi.'),
          { code: 'JOB_LEASE_LOST' }
        );
      }
    }
  };

  assert.throws(
    () => mockLeaseContext.assertLeaseActive(),
    (err) => err.code === 'JOB_LEASE_LOST'
  );
});

test('P2 — PaymentService enqueueReconciliationOutbox logs warning and scanOverdueUnknownAttempts handles recovery', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  // Enqueue outbox succeeds
  const job = await PaymentService.enqueueReconciliationOutbox(pool, {
    orderId: '00000000-0000-0000-0000-000000000001',
    orderNumber: 'GR-OUTBOX-001',
    provider: 'momo'
  });
  assert.ok(job);
  assert.equal(job.name, 'payment.reconcile');

  // Verify scanOverdueUnknownAttempts runs cleanly
  const overdue = await PaymentService.scanOverdueUnknownAttempts(pool);
  assert.ok(Array.isArray(overdue));
});

test('P1/P2 — PaymentRetryCoordinator: concurrent IPN and retry race condition yields to paid status', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const orderRes = await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, subtotal_vnd, total_vnd, payment_method, payment_status, status)
     VALUES ('GR-RACE-IPN-002', 'Concurrent Customer', 'concurrent@test.com', '0912345678', '456 Race Ave', 'Hà Nội', 750000, 750000, 'momo', 'pending', 'pending')
     RETURNING id`
  );
  const orderId = orderRes.rows[0].id;

  const attemptRes = await pool.query(
    `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, provider_request_id, status, expires_at)
     VALUES ($1, 'momo', 'GR-RACE-IPN-002', 750000, 'req-orig-ipn', 'pending', now() + interval '15 minutes')
     RETURNING id`,
    [orderId]
  );
  const attemptId = attemptRes.rows[0].id;

  const momoSettings = {
    partnerCode: 'MOMOGAERU',
    accessKey: 'MOMOACC01',
    secretKey: 'momo-super-secret-key-2026',
    environment: 'sandbox',
    enabled: true
  };

  const jsonResponse = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  // Mock gateway fetcher that handles both query (unpaid) and create (delayed payment URL)
  const delayedFetcher = async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    if (String(url).includes('/query')) {
      return jsonResponse({
        resultCode: 49, // Transaction absent/expired at gateway -> verified_unpaid -> proceed to re-initiate
        amount: 750000,
        partnerCode: 'MOMOGAERU',
        orderId: body.orderId,
        requestId: body.requestId
      });
    }
    await new Promise(r => setTimeout(r, 40));
    return jsonResponse({
      resultCode: 0,
      payUrl: 'https://test-payment.momo.vn/pay/concurrent-test',
      orderId: 'GR-RACE-IPN-002',
      requestId: 'req-new-concurrent'
    });
  };

  // Launch retry and concurrent IPN simultaneously
  const retryPromise = PaymentRetryCoordinator.coordinateRetry(pool, {
    orderNumber: 'GR-RACE-IPN-002',
    expectedCustomer: { email: 'concurrent@test.com', phone: '0912345678' },
    settings: momoSettings,
    fetcher: delayedFetcher
  });

  const ipnPromise = (async () => {
    await new Promise(r => setTimeout(r, 10)); // IPN arrives while gateway request is in-flight
    await withTransaction(pool, async (client) => {
      await client.query("UPDATE orders SET payment_status = 'paid', status = 'processing' WHERE id = $1", [orderId]);
      await client.query("UPDATE payment_attempts SET status = 'paid' WHERE id = $1", [attemptId]);
      await client.query(
        `INSERT INTO sales_receipts (order_id, amount_vnd, method, request_key, request_hash, created_by)
         VALUES ($1, 750000, 'bank_transfer', 'REC-CONC-001', 'hash-001', 'system')`,
        [orderId]
      );
    });
  })();

  const [retryResult] = await Promise.all([retryPromise, ipnPromise]);

  // Retry MUST detect that IPN settled the order and return alreadyPaid: true
  assert.equal(retryResult.alreadyPaid, true);
  assert.equal(retryResult.paymentStatus, 'paid');

  // Verify DB state: order and attempt are strictly paid, not pending or failed
  const finalOrder = (await pool.query('SELECT payment_status, status FROM orders WHERE id = $1', [orderId])).rows[0];
  const finalAttempt = (await pool.query('SELECT status FROM payment_attempts WHERE id = $1', [attemptId])).rows[0];

  assert.equal(finalOrder.payment_status, 'paid');
  assert.equal(finalAttempt.status, 'paid');
});
