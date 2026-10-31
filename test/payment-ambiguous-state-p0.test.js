'use strict';

/**
 * test/payment-ambiguous-state-p0.test.js
 * Kiểm chứng toàn diện P0 — Chống xóa đơn thanh toán khi trạng thái giao dịch chưa xác định:
 * 1. IPN đến trước phản hồi createGatewayPayment
 * 2. IPN paid nhưng request create bị timeout (PAYMENT_TIMEOUT)
 * 3. Gateway tạo thành công nhưng ghi response DB thất bại
 * 4. Retry cùng order / reference (idempotencyKey & /retry-payment)
 * 5. Callback (IPN) đến sau timeout
 * 6. Callback trùng và số tiền lệch (cả qua IPN và qua active gateway query)
 * 7. Đối soát gateway xác minh không có tiền -> hủy đơn + hoàn kho có khóa, giữ nguyên bản ghi & audit; chặn xóa chứng từ tài chính
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomBytes } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');
const { withTransaction } = require('../src/db');
const { writeRecord } = require('../src/admin-configuration');
const { reconcileGatewayOrder } = require('../src/payment-channels');
const { deleteOrderPermanently } = require('../src/order-deletion');
const inventory = require('../src/inventory');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function buildSignedMomoIpn(settings, { orderId, requestId, amount, resultCode = 0, transId = 9988776655, orderInfo }) {
  const payload = {
    partnerCode: settings.partnerCode,
    orderId,
    requestId,
    amount,
    orderInfo: orderInfo || `Thanh toan don hang ${orderId}`,
    orderType: 'momo_wallet',
    transId,
    resultCode,
    message: resultCode === 0 ? 'Successful.' : 'Failed.',
    payType: 'qr',
    responseTime: 1793155200000,
    extraData: ''
  };
  const raw =
    `accessKey=${settings.accessKey}&amount=${payload.amount}&extraData=${payload.extraData}` +
    `&message=${payload.message}&orderId=${payload.orderId}&orderInfo=${payload.orderInfo}` +
    `&orderType=${payload.orderType}&partnerCode=${payload.partnerCode}&payType=${payload.payType}` +
    `&requestId=${payload.requestId}&responseTime=${payload.responseTime}&resultCode=${payload.resultCode}` +
    `&transId=${payload.transId}`;
  payload.signature = createHmac('sha256', settings.secretKey).update(raw, 'utf8').digest('hex');
  return payload;
}

async function createStagingFixture(t, { fetcherHook, failPostCreateUpdate = () => false } = {}) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const prev = queue;
    let release;
    queue = new Promise((r) => {
      release = r;
    });
    await prev;
    return release;
  }

  async function rawQuery(sql, values) {
    if (typeof sql === 'string' && sql.includes('payment_url = $5') && failPostCreateUpdate(sql, values)) {
      const dbErr = new Error('Simulated PostgreSQL connection drop while persisting gateway response');
      dbErr.code = '57P01';
      throw dbErr;
    }
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }

  const pool = {
    async query(sql, values) {
      const release = await lock();
      try {
        return await rawQuery(sql, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await lock();
      return { query: rawQuery, release };
    },
    end: () => db.close()
  };

  await migrateDatabase(pool);

  const momoSettings = {
    partnerCode: 'MOMOGAERU',
    accessKey: 'MOMOACCESS1',
    secretKey: 'momo-secret-key-p0-staging',
    environment: 'sandbox',
    enabled: true
  };
  const ownerPassword = 'Owner-P0-Password-2026!';
  const appConfig = {
    NODE_ENV: 'test',
    SESSION_SECRET: randomBytes(48).toString('hex'),
    ADMIN_USERNAME: 'owner-p0',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(ownerPassword, 4),
    PUBLIC_BASE_URL: 'https://gaeru.com',
    STORE_ORDERS_ENABLED: true
  };

  await pool.query(
    `INSERT INTO store_settings(setting_key, setting_value)
     VALUES('shipping_rates', '{"Hà Nội": 30000, "TP. Hồ Chí Minh": 35000}'::jsonb)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`
  );

  await withTransaction(pool, async (client) => {
    await writeRecord(client, appConfig, 'payment_momo', momoSettings, 0, { username: 'owner-p0' });
    await client.query(
      `INSERT INTO payment_channel_connections(channel_id, config_version, enabled, verified_at, updated_at)
       VALUES('momo', 1, true, NULL, now())
       ON CONFLICT(channel_id) DO UPDATE SET config_version = 1, enabled = true, updated_at = now()`
    );
  });

  const prod = (await pool.query(
    `INSERT INTO products(slug, name, category, image_url, active)
     VALUES('gaeru-p0-mic', 'GAERU P0 Studio Mic', 'audio', '/assets/products/k9.webp', true)
     RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES($1, 'SKU-P0-MIC', 'Standard', 400000, 10, true)
     RETURNING id`,
    [prod.id]
  )).rows[0];
  const mainWh = (await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN' LIMIT 1`)).rows[0];
  await pool.query(
    `INSERT INTO warehouse_stock(warehouse_id, variant_id, quantity)
     VALUES($1, $2, 10)
     ON CONFLICT(warehouse_id, variant_id) DO UPDATE SET quantity = 10`,
    [mainWh.id, variant.id]
  );

  let baseUrl = '';
  const state = { baseUrl: () => baseUrl };

  const app = createApp({
    pool,
    sessionStore: new session.MemoryStore(),
    config: {
      ...appConfig,
      paymentFetcher: (url, options) => fetcherHook(url, options, state)
    }
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  async function buyerSession() {
    const r = await fetch(`${baseUrl}/api/csrf`);
    const cookie = r.headers.get('set-cookie')?.split(';')[0] || '';
    const { csrfToken } = await r.json();
    return {
      cookie,
      csrfToken,
      async post(path, body, extraHeaders = {}) {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            'X-CSRF-Token': csrfToken,
            ...extraHeaders
          },
          body: JSON.stringify(body)
        });
        const text = await res.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = { raw: text };
        }
        return { status: res.status, data };
      }
    };
  }

  async function sendIpn(payload) {
    const res = await fetch(`${baseUrl}/api/payments/momo/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  }

  async function getStocks() {
    const v = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity;
    const w = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [mainWh.id, variant.id])).rows[0].quantity;
    return { variantStock: v, mainStock: w };
  }

  function sampleOrderPayload(overrides = {}) {
    return {
      customer: {
        name: 'Trần Minh Quân',
        email: `quan.${randomBytes(4).toString('hex')}@example.com`,
        phone: '0912345678',
        address: '88 Láng Hạ, Đống Đa',
        city: 'Hà Nội',
        note: ''
      },
      paymentMethod: 'momo',
      items: [{ variantId: variant.id, quantity: 2 }],
      ...overrides
    };
  }

  return { pool, momoSettings, appConfig, variant, mainWh, baseUrl, buyerSession, sendIpn, getStocks, sampleOrderPayload };
}

test('P0-1 & P0-2: IPN đến trước phản hồi VÀ IPN đã paid nhưng request create bị timeout -> giữ nguyên paid & chứng từ tài chính, tuyệt đối không xóa đơn', async (t) => {
  let mode = 'ipn_before_ok_response';
  let ipnStatuses = [];

  const f = await createStagingFixture(t, {
    fetcherHook: async (url, options, state) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/v2/gateway/api/create')) {
        // Kiểm tra provider_request_id đã được lưu bền vững vào DB TRƯỚC khi gọi cổng thanh toán
        const preSaved = (await f.pool.query(
          `SELECT provider_request_id, status FROM payment_attempts WHERE transaction_ref = $1`,
          [body.orderId]
        )).rows[0];
        assert.ok(preSaved, 'payment_attempts phải được commit trước khi gọi cổng');
        assert.equal(preSaved.provider_request_id, body.requestId, 'Khóa idempotency provider_request_id phải được lưu trước HTTP call');

        // Cổng thanh toán bắn IPN về server ngay lập tức (trước khi create trả kết quả!)
        const ipnPayload = buildSignedMomoIpn(f.momoSettings, {
          orderId: body.orderId,
          requestId: body.requestId,
          amount: body.amount,
          resultCode: 0,
          transId: mode === 'ipn_before_ok_response' ? 777000111 : 777000222,
          orderInfo: body.orderInfo
        });
        const ipnRes = await fetch(`${state.baseUrl()}/api/payments/momo/ipn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ipnPayload)
        });
        ipnStatuses.push(ipnRes.status);

        if (mode === 'ipn_paid_then_create_timeout') {
          const abortErr = new Error('The operation was aborted due to timeout');
          abortErr.name = 'AbortError';
          options.signal?.dispatchEvent?.(new Event('abort'));
          throw abortErr;
        }

        // Trả về create thành công (transId không có trong create response của MoMo -> không được ghi đè transId của IPN!)
        return jsonResponse({
          resultCode: 0,
          partnerCode: body.partnerCode,
          requestId: body.requestId,
          orderId: body.orderId,
          amount: body.amount,
          payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?token=early-ipn-ok'
        });
      }
      throw new Error('Unexpected URL: ' + url);
    }
  });

  // --- Kịch bản 1: IPN đến trước phản hồi create thành công ---
  const buyer1 = await f.buyerSession();
  const res1 = await buyer1.post('/api/orders', f.sampleOrderPayload());
  assert.equal(res1.status, 201);
  assert.equal(ipnStatuses[0], 204);

  const ord1 = (await f.pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [res1.data.order.id])).rows[0];
  const att1 = (await f.pool.query(`SELECT status, provider_transaction_id FROM payment_attempts WHERE order_id = $1`, [res1.data.order.id])).rows[0];
  assert.deepEqual(ord1, { status: 'processing', payment_status: 'paid' });
  assert.equal(att1.status, 'paid');
  assert.equal(att1.provider_transaction_id, '777000111', 'transId từ IPN đến sớm không được bị ghi đè thành null bởi create response');
  assert.equal((await f.pool.query(`SELECT count(*)::int AS cnt FROM sales_receipts WHERE order_id = $1`, [res1.data.order.id])).rows[0].cnt, 1);
  assert.deepEqual(await f.getStocks(), { variantStock: 8, mainStock: 8 });

  // --- Kịch bản 2: IPN đã ghi nhận paid, nhưng HTTP create bị TIMEOUT! ---
  mode = 'ipn_paid_then_create_timeout';
  const buyer2 = await f.buyerSession();
  const res2 = await buyer2.post('/api/orders', f.sampleOrderPayload());
  assert.equal(res2.status, 201, 'Khi IPN đã paid trong lúc create timeout, hệ thống phải bảo toàn đơn paid và trả kết quả an toàn');
  assert.equal(res2.data.paymentSettled, true);
  assert.equal(ipnStatuses[1], 204);

  const ord2 = (await f.pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [res2.data.order.id])).rows[0];
  const att2 = (await f.pool.query(`SELECT status, provider_transaction_id FROM payment_attempts WHERE order_id = $1`, [res2.data.order.id])).rows[0];
  assert.ok(ord2, 'Đơn hàng đã thanh toán TUYỆT ĐỐI không được bị xóa khi create timeout');
  assert.deepEqual(ord2, { status: 'processing', payment_status: 'paid' });
  assert.equal(att2.status, 'paid');
  assert.equal(att2.provider_transaction_id, '777000222');
  assert.equal((await f.pool.query(`SELECT count(*)::int AS cnt FROM sales_receipts WHERE order_id = $1`, [res2.data.order.id])).rows[0].cnt, 1);
  assert.deepEqual(await f.getStocks(), { variantStock: 6, mainStock: 6 }, 'Tồn kho của đơn đã paid phải tiếp tục được trừ đúng, không được hoàn trả nhầm');

  const audit2 = (await f.pool.query(
    `SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY created_at ASC`,
    [res2.data.order.id]
  )).rows.map((r) => r.action);
  assert.ok(audit2.includes('payment.momo.callback'));
  assert.ok(audit2.includes('payment.initiation.settled_during_timeout'));

  // Kiểm chứng thêm: gọi trực tiếp deleteOrderPermanently vào đơn đã paid phải bị từ chối 409!
  await assert.rejects(
    () => withTransaction(f.pool, (c) => deleteOrderPermanently(c, res2.data.order.id, { inventory })),
    (err) => err.status === 409 && err.code === 'PAID_ORDER_DELETION_FORBIDDEN'
  );
});

test('P0-3: Gateway tạo giao dịch thành công nhưng ghi response vào DB thất bại -> giữ nguyên đơn ở awaiting_reconciliation và khôi phục đối soát được', async (t) => {
  let injectDbFailureOnce = true;

  const f = await createStagingFixture(t, {
    failPostCreateUpdate: () => {
      if (injectDbFailureOnce) {
        injectDbFailureOnce = false;
        return true;
      }
      return false;
    },
    fetcherHook: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/v2/gateway/api/create')) {
        return jsonResponse({
          resultCode: 0,
          partnerCode: body.partnerCode,
          requestId: body.requestId,
          orderId: body.orderId,
          amount: body.amount,
          payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?token=db-fail-after-create'
        });
      }
      if (url.endsWith('/v2/gateway/api/query')) {
        return jsonResponse({
          resultCode: 0,
          partnerCode: body.partnerCode,
          requestId: body.requestId,
          orderId: body.orderId,
          amount: 830000,
          transId: 888999111
        });
      }
      throw new Error('Unexpected URL: ' + url);
    }
  });

  const buyer = await f.buyerSession();
  const res = await buyer.post('/api/orders', f.sampleOrderPayload());
  assert.equal(res.status, 502);
  assert.equal(res.data.code, 'PAYMENT_RESPONSE_PERSIST_FAILED');
  assert.equal(res.data.reconciliationStatus, 'awaiting_reconciliation');
  assert.ok(res.data.orderId);
  assert.ok(res.data.providerRequestId);

  // Đơn hàng, payment_attempts (cùng provider_request_id) và tồn kho giữ chỗ PHẢI còn nguyên vẹn!
  const ordBefore = (await f.pool.query(`SELECT status, payment_status, total_vnd FROM orders WHERE id = $1`, [res.data.orderId])).rows[0];
  const attBefore = (await f.pool.query(`SELECT status, provider_request_id, last_error_code FROM payment_attempts WHERE order_id = $1`, [res.data.orderId])).rows[0];
  assert.ok(ordBefore, 'Không được xóa đơn khi ghi response DB thất bại');
  assert.deepEqual({ status: ordBefore.status, payment_status: ordBefore.payment_status }, { status: 'pending', payment_status: 'pending' });
  assert.equal(attBefore.status, 'awaiting_reconciliation');
  assert.equal(attBefore.provider_request_id, res.data.orderNumber);
  assert.equal(attBefore.last_error_code, 'PAYMENT_RESPONSE_PERSIST_FAILED');
  assert.deepEqual(await f.getStocks(), { variantStock: 8, mainStock: 8 });

  // Chặn xóa đơn khi đang awaiting_reconciliation
  await assert.rejects(
    () => withTransaction(f.pool, (c) => deleteOrderPermanently(c, res.data.orderId, { inventory })),
    (err) => err.status === 409 && err.code === 'ORDER_AWAITING_RECONCILIATION'
  );

  // Đối soát chủ động với gateway (hoặc nhận IPN) chốt đơn sang paid & processing chính xác!
  const rec = await reconcileGatewayOrder(f.pool, {
    orderId: res.data.orderId,
    provider: 'momo',
    settings: f.momoSettings,
    fetcher: async (_url, options) => {
      const b = JSON.parse(options.body);
      return jsonResponse({
        resultCode: 0,
        partnerCode: b.partnerCode,
        requestId: b.requestId,
        orderId: b.orderId,
        amount: ordBefore.total_vnd,
        transId: 888999111
      });
    }
  });
  assert.equal(rec.action, 'settled_paid');

  const ordAfter = (await f.pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [res.data.orderId])).rows[0];
  assert.deepEqual(ordAfter, { status: 'processing', payment_status: 'paid' });
  assert.equal((await f.pool.query(`SELECT count(*)::int AS cnt FROM sales_receipts WHERE order_id = $1`, [res.data.orderId])).rows[0].cnt, 1);
});

test('P0-4: Retry cùng order / reference (idempotencyKey & /retry-payment) kiểm tra gateway trước, không trừ kho kép, không tạo đơn trùng', async (t) => {
  let createCalls = 0;
  let queryCalls = 0;
  let queryMode = 'not_found';

  const f = await createStagingFixture(t, {
    fetcherHook: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/v2/gateway/api/create')) {
        createCalls += 1;
        if (createCalls === 1) {
          // Lần gọi đầu tiên bị timeout mạng
          throw new Error('Socket hang up');
        }
        return jsonResponse({
          resultCode: 0,
          partnerCode: body.partnerCode,
          requestId: body.requestId,
          orderId: body.orderId,
          amount: body.amount,
          payUrl: `https://test-payment.momo.vn/v2/gateway/pay?token=retry-session-${createCalls}`
        });
      }
      if (url.endsWith('/v2/gateway/api/query')) {
        queryCalls += 1;
        if (queryMode === 'not_found') {
          return jsonResponse({ resultCode: 1001, message: 'Order not found at gateway' });
        }
        if (queryMode === 'already_paid') {
          return jsonResponse({
            resultCode: 0,
            partnerCode: body.partnerCode,
            requestId: body.requestId,
            orderId: body.orderId,
            amount: 830000,
            transId: 555666777
          });
        }
      }
      throw new Error('Unexpected URL: ' + url);
    }
  });

  const buyer = await f.buyerSession();
  const payload = f.sampleOrderPayload({ idempotencyKey: 'checkout-idem-ref-001' });

  // Lần 1: Timeout -> 502 payment_initiation_unknown, giữ kho 2 chiếc (còn 8)
  const firstTry = await buyer.post('/api/orders', payload);
  assert.equal(firstTry.status, 502);
  assert.equal(firstTry.data.reconciliationStatus, 'payment_initiation_unknown');
  assert.deepEqual(await f.getStocks(), { variantStock: 8, mainStock: 8 });

  // Lần 2: Retry cùng idempotencyKey -> hệ thống query gateway trước (found=false), khởi tạo lại phiên trên CÙNG đơn hàng!
  const secondTry = await buyer.post('/api/orders', payload);
  assert.equal(secondTry.status, 200);
  assert.equal(secondTry.data.retried, true);
  assert.equal(secondTry.data.order.orderNumber, firstTry.data.orderNumber);
  assert.match(secondTry.data.paymentUrl, /retry-session-2/);
  assert.equal(queryCalls, 1, 'Phải truy vấn kiểm tra gateway trước khi tạo lại phiên');
  assert.equal(createCalls, 2);
  assert.deepEqual(await f.getStocks(), { variantStock: 8, mainStock: 8 }, 'Retry tuyệt đối không trừ tồn kho lần 2');
  assert.equal((await f.pool.query(`SELECT count(*)::int AS cnt FROM orders`)).rows[0].cnt, 1, 'Chỉ có duy nhất 1 đơn hàng');
  assert.equal((await f.pool.query(`SELECT count(*)::int AS cnt FROM payment_attempts`)).rows[0].cnt, 1, 'Chỉ có duy nhất 1 bản ghi payment_attempts');

  // Lần 3: Gọi /retry-payment khi phiên đang pending và còn hạn -> tái sử dụng luôn paymentUrl hiện có, không gọi create lần 3!
  const thirdTry = await buyer.post(`/api/orders/${firstTry.data.orderNumber}/retry-payment`, {});
  assert.equal(thirdTry.status, 200);
  assert.equal(thirdTry.data.reusedSession, true);
  assert.equal(thirdTry.data.paymentUrl, secondTry.data.paymentUrl);
  assert.equal(createCalls, 2, 'Không gọi thêm createGatewayPayment khi phiên còn hiệu lực');

  // Lần 4: Giả sử đơn thứ hai bị timeout ở create, nhưng thực chất khách đã thanh toán trên cổng (query trả về already_paid)
  createCalls = 0;
  queryMode = 'already_paid';
  const payload2 = f.sampleOrderPayload({ idempotencyKey: 'checkout-idem-ref-002' });
  const timeoutPaidTry = await buyer.post('/api/orders', payload2);
  assert.equal(timeoutPaidTry.status, 502);

  const retrySettled = await buyer.post(`/api/orders/${timeoutPaidTry.data.orderNumber}/retry-payment`, {});
  assert.equal(retrySettled.status, 200);
  assert.equal(retrySettled.data.alreadyPaid, true);
  assert.equal(retrySettled.data.paymentStatus, 'paid');
  assert.equal(createCalls, 1, 'Khi đối soát phát hiện đã thu tiền, không được gọi create lần 2');
  assert.equal((await f.pool.query(`SELECT count(*)::int AS cnt FROM sales_receipts WHERE order_id = $1`, [timeoutPaidTry.data.orderId])).rows[0].cnt, 1);
});

test('P0-5, P0-6 & P0-7: Callback đến sau timeout; callback trùng & lệch số tiền; đối soát xác minh không có tiền hủy đơn + hoàn kho có khóa', async (t) => {
  let shouldTimeoutCreate = true;

  const f = await createStagingFixture(t, {
    fetcherHook: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/v2/gateway/api/create')) {
        if (shouldTimeoutCreate) {
          throw new Error('Gateway read ETIMEDOUT');
        }
        return jsonResponse({
          resultCode: 0,
          partnerCode: body.partnerCode,
          requestId: body.requestId,
          orderId: body.orderId,
          amount: body.amount,
          payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?token=ok'
        });
      }
      if (url.endsWith('/v2/gateway/api/query')) {
        return jsonResponse({ resultCode: 1001, message: 'No transaction' });
      }
      throw new Error('Unexpected URL: ' + url);
    }
  });

  // --- Kịch bản 5 & 6: Create bị timeout -> trạng thái payment_initiation_unknown -> Callback lệch tiền bị chặn -> Callback đúng đến muộn chốt đơn -> Callback trùng idempotent ---
  const buyerA = await f.buyerSession();
  const timeoutResA = await buyerA.post('/api/orders', f.sampleOrderPayload());
  assert.equal(timeoutResA.status, 502);
  assert.equal(timeoutResA.data.reconciliationStatus, 'payment_initiation_unknown');
  assert.deepEqual(await f.getStocks(), { variantStock: 8, mainStock: 8 });

  const orderRowA = (await f.pool.query(`SELECT id, order_number, total_vnd FROM orders WHERE id = $1`, [timeoutResA.data.orderId])).rows[0];
  const attemptRowA = (await f.pool.query(`SELECT status, provider_request_id FROM payment_attempts WHERE order_id = $1`, [orderRowA.id])).rows[0];
  assert.equal(attemptRowA.status, 'payment_initiation_unknown');

  // 6a. Callback có chữ ký hợp lệ nhưng SỐ TIỀN LỆCH (+1 VND) -> phải bị từ chối 409, không được ghi nhận thanh toán!
  const wrongAmountIpn = await f.sendIpn(
    buildSignedMomoIpn(f.momoSettings, {
      orderId: orderRowA.order_number,
      requestId: attemptRowA.provider_request_id,
      amount: orderRowA.total_vnd + 1,
      resultCode: 0,
      transId: 333444555
    })
  );
  assert.equal(wrongAmountIpn.status, 409);
  assert.equal(wrongAmountIpn.data.resultCode, 4);
  assert.equal((await f.pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [orderRowA.id])).rows[0].payment_status, 'pending');
  assert.equal((await f.pool.query(`SELECT count(*)::int AS cnt FROM sales_receipts WHERE order_id = $1`, [orderRowA.id])).rows[0].cnt, 0);

  // 5. Callback hợp lệ đến SAU timeout -> chuyển mượt từ payment_initiation_unknown sang paid & processing!
  const validLateIpnPayload = buildSignedMomoIpn(f.momoSettings, {
    orderId: orderRowA.order_number,
    requestId: attemptRowA.provider_request_id,
    amount: orderRowA.total_vnd,
    resultCode: 0,
    transId: 333444999
  });
  const lateIpn1 = await f.sendIpn(validLateIpnPayload);
  assert.equal(lateIpn1.status, 204);

  const settledOrderA = (await f.pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [orderRowA.id])).rows[0];
  const settledAttemptA = (await f.pool.query(`SELECT status, provider_transaction_id FROM payment_attempts WHERE order_id = $1`, [orderRowA.id])).rows[0];
  assert.deepEqual(settledOrderA, { status: 'processing', payment_status: 'paid' });
  assert.equal(settledAttemptA.status, 'paid');
  assert.equal(settledAttemptA.provider_transaction_id, '333444999');

  // 6b. Callback TRÙNG (gửi lại nhiều lần cùng giao dịch) -> hoàn toàn idempotent (204), đúng 1 sales_receipt!
  const lateIpn2 = await f.sendIpn(validLateIpnPayload);
  const lateIpn3 = await f.sendIpn(validLateIpnPayload);
  assert.equal(lateIpn2.status, 204);
  assert.equal(lateIpn3.status, 204);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS cnt FROM sales_receipts WHERE order_id = $1`, [orderRowA.id])).rows[0].cnt, 1);

  // --- Kịch bản 7: Create bị timeout -> Đối soát gateway xác minh found=false (không có tiền) -> Hủy đơn + hoàn kho trong transaction có khóa + lưu đầy đủ audit ---
  const buyerB = await f.buyerSession();
  const timeoutResB = await buyerB.post('/api/orders', f.sampleOrderPayload());
  assert.equal(timeoutResB.status, 502);
  assert.deepEqual(await f.getStocks(), { variantStock: 6, mainStock: 6 });

  // Trước tiên thử đối soát với kết quả lệch tiền từ query API -> phải giữ ở awaiting_reconciliation, không chốt paid và không hủy kho
  const mismatchQueryRec = await reconcileGatewayOrder(f.pool, {
    orderId: timeoutResB.data.orderId,
    provider: 'momo',
    settings: f.momoSettings,
    fetcher: async (_url, options) => {
      const b = JSON.parse(options.body);
      return jsonResponse({
        resultCode: 0,
        partnerCode: b.partnerCode,
        requestId: b.requestId,
        orderId: b.orderId,
        amount: 999999,
        transId: 123123123
      });
    }
  });
  assert.equal(mismatchQueryRec.action, 'amount_mismatch');
  assert.equal(mismatchQueryRec.attemptStatus, 'awaiting_reconciliation');
  assert.deepEqual(await f.getStocks(), { variantStock: 6, mainStock: 6 });

  // Tiếp theo đối soát xác minh chắc chắn found=false (resultCode: 1001) -> hủy đơn & hoàn trả đúng 2 sản phẩm về kho (6 -> 8)
  const cancelUnpaidRec = await reconcileGatewayOrder(f.pool, {
    orderId: timeoutResB.data.orderId,
    provider: 'momo',
    settings: f.momoSettings,
    fetcher: async () => jsonResponse({ resultCode: 1001, message: 'Not found' })
  });
  assert.equal(cancelUnpaidRec.action, 'cancelled_unpaid');
  assert.deepEqual(await f.getStocks(), { variantStock: 8, mainStock: 8 }, 'Hoàn kho chính xác 2 đơn vị sau khi xác minh không thu tiền');

  // Gọi đối soát lặp lại lần 2 -> idempotent, không hoàn kho kép!
  const cancelUnpaidRecAgain = await reconcileGatewayOrder(f.pool, {
    orderId: timeoutResB.data.orderId,
    provider: 'momo',
    settings: f.momoSettings,
    fetcher: async () => jsonResponse({ resultCode: 1001, message: 'Not found' })
  });
  assert.equal(cancelUnpaidRecAgain.action, 'already_cancelled');
  assert.deepEqual(await f.getStocks(), { variantStock: 8, mainStock: 8 }, 'Đối soát lặp lại không được cộng tồn kho lần 2');

  const finalOrderB = (await f.pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [timeoutResB.data.orderId])).rows[0];
  const finalAttemptB = (await f.pool.query(`SELECT status FROM payment_attempts WHERE order_id = $1`, [timeoutResB.data.orderId])).rows[0];
  assert.deepEqual(finalOrderB, { status: 'cancelled', payment_status: 'pending' });
  assert.equal(finalAttemptB.status, 'failed');

  const auditsB = (await f.pool.query(
    `SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY created_at ASC`,
    [timeoutResB.data.orderId]
  )).rows.map((r) => r.action);
  assert.deepEqual(auditsB, [
    'inventory.reserve',
    'order.create',
    'payment.initiation.unknown',
    'payment.reconciliation.amount_mismatch',
    'inventory.release',
    'payment.reconciliation.cancelled_unpaid'
  ]);
});
