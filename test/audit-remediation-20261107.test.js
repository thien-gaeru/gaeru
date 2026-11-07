'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { seal } = require('../src/totp');
const { getAdapter, normalizeCarrierStatus } = require('../src/shipping-adapters');
const {
  createShippingManagement,
  createWaybill,
  handleCarrierWebhook
} = require('../src/shipping-management');
const { createStoreApi } = require('../src/store-api');

async function createIsolatedDb(t) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  const query = async (sql, values) =>
    !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : db.query(sql, values);
  async function lock() {
    const before = queue;
    let release;
    queue = new Promise((r) => {
      release = r;
    });
    await before;
    return release;
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try {
        return await query(sql, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);
  return pool;
}

test('QA-01: scripts contain no hardcoded credentials or personal host paths and fail closed without local env', () => {
  const scriptsDir = path.join(__dirname, '..', 'scripts');
  const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 4);

  for (const file of files) {
    const src = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
    assert.ok(!/Users[\\/]+imdot/i.test(src), `${file} must not contain personal user directory paths`);
    assert.ok(
      !/password\s*[:=]\s*['"][^'"]{6,}['"]/i.test(src),
      `${file} must not hardcode literal passwords`
    );
  }

  const { assertAuditEnvironment } = require('../scripts/capture-all-views');
  assert.throws(
    () => assertAuditEnvironment('http://127.0.0.1:3000/gaeru_ceo', { NODE_ENV: 'production', GAERU_AUDIT_USERNAME: 'u', GAERU_AUDIT_PASSWORD: 'p' }),
    /production/i
  );
  assert.throws(
    () => assertAuditEnvironment('http://127.0.0.1:3000/gaeru_ceo', { NODE_ENV: 'development' }),
    /GAERU_AUDIT_USERNAME.*GAERU_AUDIT_PASSWORD/
  );
  assert.throws(
    () =>
      assertAuditEnvironment('https://gaeru.vn/gaeru_ceo', {
        NODE_ENV: 'development',
        GAERU_AUDIT_USERNAME: 'u',
        GAERU_AUDIT_PASSWORD: 'p'
      }),
    /loopback/i
  );
  assert.throws(
    () =>
      assertAuditEnvironment('http://127.0.0.1:3000/gaeru_ceo', {
        NODE_ENV: 'development',
        GAERU_AUDIT_USERNAME: 'u',
        GAERU_AUDIT_PASSWORD: 'p',
        DATABASE_URL: 'postgres://user:pass@ep-prod.aws.neon.tech/neondb'
      }),
    /DATABASE_URL/
  );
});

test('QA-03 & QA-04: createWaybill blocks HTTP forceRetry and preserves unknown status when local 409 occurs after carrier acknowledgement', async (t) => {
  const pool = await createIsolatedDb(t);
  const config = { SESSION_SECRET: 'audit-remediation-secret-key-32chars' };
  await pool.query(
    "INSERT INTO store_settings(setting_key,setting_value) VALUES('private_admin:shipping_viettel',$1)",
    [
      JSON.stringify({
        version: 1,
        cipher: seal(
          JSON.stringify({
            accountId: '123',
            secret: 'eyJ-valid-jwt-token',
            webhookSecret: 'webhook-secret-audit'
          }),
          process.env.AUTH_ENCRYPTION_KEY || config.SESSION_SECRET
        )
      })
    ]
  );
  await pool.query(
    "INSERT INTO shipping_carrier_connections(carrier_id,config_version,verified_at,enabled) VALUES('viettel',1,now(),true)"
  );
  const order = (
    await pool.query(
      "INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,shipping_fee_vnd,total_vnd) VALUES('ORD-P0-03','Khách Test','p03@example.invalid','0912345678','123 Phố Huế','Hà Nội','cod','pending','processing',200000,0,200000) RETURNING id"
    )
  ).rows[0];

  let providerCalls = 0;
  const driftFetcher = async () => {
    providerCalls += 1;
    // Mutate order mid-flight right before carrier response returns, triggering local 409 drift guard
    await pool.query("UPDATE orders SET note = 'changed-during-carrier-call' WHERE id = $1", [order.id]);
    return {
      ok: true,
      json: async () => ({
        status: 200,
        error: false,
        data: { ORDER_NUMBER: 'VTP-ACK-DRIFT-01', MONEY_TOTAL: 22000 }
      })
    };
  };

  await assert.rejects(
    () =>
      createWaybill(pool, config, {
        orderId: order.id,
        carrierId: 'viettel',
        actor: { username: 'sales1', role: 'sales', source: 'staff' },
        fetcher: driftFetcher
      }),
    (err) => err.status === 502
  );

  const attempt = (
    await pool.query('SELECT id, status, provider_result FROM carrier_shipment_attempts WHERE order_id = $1', [
      order.id
    ])
  ).rows[0];
  assert.equal(attempt.status, 'unknown', 'Acknowledged attempt must remain unknown, never downgraded to failed');
  assert.equal(attempt.provider_result.trackingNumber, 'VTP-ACK-DRIFT-01');
  assert.equal(providerCalls, 1);

  // Subsequent createWaybill call must be fenced (409) and never call carrier again
  await assert.rejects(
    () =>
      createWaybill(pool, config, {
        orderId: order.id,
        carrierId: 'viettel',
        actor: { username: 'sales1', role: 'sales', source: 'staff' },
        fetcher: driftFetcher
      }),
    (err) => err.status === 409
  );
  assert.equal(providerCalls, 1);

  // HTTP endpoint must explicitly reject forceRetry: true with 403
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { csrfToken: 'csrf-ok' };
    req.admin = { username: 'sales1', role: 'sales', source: 'staff', permissions: ['orders.write'] };
    next();
  });
  app.use(createShippingManagement(pool, config, { fetcher: driftFetcher }).admin);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));

  const resp = await fetch(
    `http://127.0.0.1:${server.address().port}/shipping/orders/${order.id}/create-waybill`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'csrf-ok' },
      body: JSON.stringify({ carrierId: 'viettel', forceRetry: true })
    }
  );
  assert.equal(resp.status, 403);
  assert.equal(providerCalls, 1);
});

test('QA-05, QA-06 & QA-07: Viettel Post cancelWaybill and queryTracking reject error statuses and only accept exact already-cancelled confirmation', async () => {
  const viettel = getAdapter('viettel');
  const settings = { secret: 'eyJ-jwt-token' };

  // 1. Token error 201 must fail 502
  await assert.rejects(
    () =>
      viettel.cancelWaybill(
        settings,
        { trackingNumber: '156668075672' },
        {
          fetcher: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ status: 201, error: true, message: 'Token invalid' })
          })
        }
      ),
    (err) => err.status === 502
  );

  // 2. HTTP 404 containing word "cancel" must fail 502 (never synthesize 205)
  await assert.rejects(
    () =>
      viettel.cancelWaybill(
        settings,
        { trackingNumber: '156668075672' },
        {
          fetcher: async () => ({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            json: async () => ({ message: 'Cannot cancel order at current stage' })
          })
        }
      ),
    (err) => err.status === 502
  );

  // 3. HTTP 500 containing word "cancel" must fail 502
  await assert.rejects(
    () =>
      viettel.cancelWaybill(
        settings,
        { trackingNumber: '156668075672' },
        {
          fetcher: async () => ({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: async () => ({ error: 'Cancel service unavailable' })
          })
        }
      ),
    (err) => err.status === 502
  );

  // 4. Status 205 with "Đơn hàng không tồn tại" must fail 502
  await assert.rejects(
    () =>
      viettel.cancelWaybill(
        settings,
        { trackingNumber: '156668075672' },
        {
          fetcher: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ status: 205, error: true, message: 'Đơn hàng không tồn tại' })
          })
        }
      ),
    (err) => err.status === 502
  );

  // 5. Exact Viettel confirmation "Đơn hàng đã hủy!" succeeds cleanly
  const alreadyCancelled = await viettel.cancelWaybill(
    settings,
    { trackingNumber: '156668075672' },
    {
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 205, error: true, message: 'Đơn hàng đã hủy!' })
      })
    }
  );
  assert.equal(alreadyCancelled.cancelled, true);

  // 6. queryTracking HTTP 405 & 404 throw 502 without faking 200
  for (const code of [404, 405]) {
    await assert.rejects(
      () =>
        viettel.queryTracking(
          settings,
          { trackingNumber: '156668075672' },
          { fetcher: async () => ({ ok: false, status: code, json: async () => ({}) }) }
        ),
      (err) => err.status === 502
    );
  }
});

test('QA-08..10: admin.js has no escaped template literals and no forceRetry prompt', () => {
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'admin', 'admin.js'), 'utf8');
  assert.ok(!adminJs.includes('\\${'), 'admin/admin.js must not contain escaped \\${ inside template literals');
  assert.ok(!adminJs.includes('forceRetry'), 'admin/admin.js must not send forceRetry bypass');
});

test('QA-13: PATCH /gaeru_ceo/orders/:id rolls back atomically when finance.recordFullOrderPayment fails', async (t) => {
  const pool = await createIsolatedDb(t);
  const order = (
    await pool.query(
      "INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,shipping_fee_vnd,total_vnd) VALUES('ORD-P1-08','Khách COD','cod@example.invalid','0987654321','10 Nguyễn Trãi','Hà Nội','cod','pending','shipped',202300,0,202300) RETURNING id"
    )
  ).rows[0];

  const brokenFinance = {
    receiptTotal: async () => 0,
    recordFullOrderPayment: async () => {
      throw new Error('simulated sales_receipts constraint failure');
    }
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { csrfToken: 'csrf-p1-08', admin: { username: 'owner', source: 'bootstrap' } };
    req.admin = {
      username: 'owner',
      role: 'owner',
      source: 'bootstrap',
      permissions: ['orders.read', 'orders.write', 'payments.write']
    };
    next();
  });
  app.use(
    '/api',
    createStoreApi(pool, {
      ordersEnabled: true,
      finance: brokenFinance
    })
  );
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));

  const resp = await fetch(`http://127.0.0.1:${server.address().port}/api/gaeru_ceo/orders/${order.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'csrf-p1-08' },
    body: JSON.stringify({ status: 'completed', paymentStatus: 'paid', confirmReceived: true })
  });
  assert.equal(resp.status, 500);

  const after = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [order.id])).rows[0];
  assert.deepEqual(after, { status: 'shipped', payment_status: 'pending' });
});

test('QA-14: Viettel Post numeric status codes and nested DATA webhook envelope are normalized accurately', async (t) => {
  assert.equal(normalizeCarrierStatus('viettel', 501), 'delivered');
  assert.equal(normalizeCarrierStatus('viettel', '501'), 'delivered');
  assert.equal(normalizeCarrierStatus('viettel', '503'), 'cancelled');
  assert.equal(normalizeCarrierStatus('viettel', 107), 'cancelled');
  assert.equal(normalizeCarrierStatus('viettel', 504), 'returned');
  assert.equal(normalizeCarrierStatus('viettel', '505'), 'returned');
  assert.equal(normalizeCarrierStatus('viettel', 200), 'delivering');
  assert.equal(normalizeCarrierStatus('viettel', 103), 'picking');
  assert.equal(normalizeCarrierStatus('viettel', 999), 'pending');

  const pool = await createIsolatedDb(t);
  const config = { SESSION_SECRET: 'viettel-webhook-envelope-secret-key' };
  await pool.query(
    "INSERT INTO store_settings(setting_key,setting_value) VALUES('private_admin:shipping_viettel',$1)",
    [
      JSON.stringify({
        version: 1,
        cipher: seal(
          JSON.stringify({ accountId: '123', secret: 'tok', webhookSecret: 'vtp-wh-secret-2026' }),
          process.env.AUTH_ENCRYPTION_KEY || config.SESSION_SECRET
        )
      })
    ]
  );
  const order = (
    await pool.query(
      "INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,shipping_fee_vnd,total_vnd) VALUES('ORD-VTP-WH','Khách VTP','vtp@example.invalid','0901112222','1 Cầu Giấy','Hà Nội','cod','pending','shipped',150000,0,150000) RETURNING id"
    )
  ).rows[0];
  await pool.query(
    "INSERT INTO carrier_shipments(order_id,carrier_id,tracking_number,status,cod_amount_vnd) VALUES($1,'viettel','156668099999','delivering',150000)",
    [order.id]
  );

  const whRes = await handleCarrierWebhook(
    pool,
    config,
    'viettel',
    {
      DATA: {
        ORDER_NUMBER: '156668099999',
        ORDER_STATUS: 501,
        NOTE: 'Giao thành công - người nhận đã ký'
      }
    },
    { headers: { token: 'vtp-wh-secret-2026' } }
  );
  assert.equal(whRes.processed, true);
  assert.equal(whRes.normalizedStatus, 'delivered');

  const updatedShipment = (
    await pool.query('SELECT status, carrier_status_desc FROM carrier_shipments WHERE order_id = $1', [order.id])
  ).rows[0];
  assert.equal(updatedShipment.status, 'delivered');
  assert.equal(updatedShipment.carrier_status_desc, 'Giao thành công - người nhận đã ký');
});

test('QA-15: remove-ghn-and-ghtk.sql preserves historical ghn/ghtk records while blocking active connections', async (t) => {
  const pool = await createIsolatedDb(t);
  const order = (
    await pool.query(
      "INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,total_vnd) VALUES('ORD-LEGACY-GHN','Khách Cũ','legacy@example.invalid','0909998888','1 Lê Lợi','TP.HCM','cod','paid','completed',300000,300000) RETURNING id"
    )
  ).rows[0];

  await pool.query(
    "INSERT INTO order_shipping_selection(order_id,carrier_id,carrier_name,fee_vnd,config_version) VALUES($1,'ghn','Giao Hàng Nhanh',25000,1)",
    [order.id]
  );
  await pool.query(
    "INSERT INTO carrier_shipments(order_id,carrier_id,tracking_number,status) VALUES($1,'ghn','GHN-HIST-001','delivered')",
    [order.id]
  );
  await pool.query(
    "INSERT INTO carrier_shipment_attempts(order_id,carrier_id,config_version,status) VALUES($1,'ghtk',1,'succeeded')",
    [order.id]
  );

  const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'remove-ghn-and-ghtk.sql'), 'utf8');
  await pool.query(migrationSql);

  const hist = (await pool.query('SELECT carrier_id FROM carrier_shipments WHERE order_id = $1', [order.id])).rows[0];
  assert.equal(hist.carrier_id, 'ghn');

  await assert.rejects(() =>
    pool.query("INSERT INTO shipping_carrier_connections(carrier_id,config_version,enabled) VALUES('ghn',1,false)")
  );
});

test('QA-17: /shipping/tracking/:orderNumber enforces customer authentication and order ownership', async (t) => {
  const pool = await createIsolatedDb(t);
  const config = { SESSION_SECRET: 'tracking-idor-test-secret' };
  const custA = (
    await pool.query(
      "INSERT INTO customers(email,full_name,phone) VALUES('custa@example.invalid','Customer A','0911111111') RETURNING id"
    )
  ).rows[0];
  const custB = (
    await pool.query(
      "INSERT INTO customers(email,full_name,phone) VALUES('custb@example.invalid','Customer B','0922222222') RETURNING id"
    )
  ).rows[0];

  const orderB = (
    await pool.query(
      "INSERT INTO orders(order_number,customer_id,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,total_vnd) VALUES('GR-20261107-CUSTB',$1,'Customer B','custb@example.invalid','0922222222','Địa chỉ B','Đà Nẵng','cod','pending','shipped',199000,199000) RETURNING id",
      [custB.id]
    )
  ).rows[0];
  await pool.query(
    "INSERT INTO carrier_shipments(order_id,carrier_id,tracking_number,status,carrier_status_desc) VALUES($1,'viettel','VTP-SECRET-999','delivering','Đang phát tại bưu cục Đà Nẵng')",
    [orderB.id]
  );

  const app = express();
  app.use((req, _res, next) => {
    const uid = req.get('x-test-customer-id');
    req.session = uid ? { customer: { id: uid } } : {};
    next();
  });
  app.use('/api', createShippingManagement(pool, config).publicApi);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/shipping/tracking/GR-20261107-CUSTB`;

  // Unauthenticated -> 401
  const rUnauth = await fetch(baseUrl);
  assert.equal(rUnauth.status, 401);

  // Customer A reading Customer B's order -> 404
  const rWrongUser = await fetch(baseUrl, { headers: { 'x-test-customer-id': custA.id } });
  assert.equal(rWrongUser.status, 404);

  // Customer B reading own order -> 200
  const rOwner = await fetch(baseUrl, { headers: { 'x-test-customer-id': custB.id } });
  assert.equal(rOwner.status, 200);
  const body = await rOwner.json();
  assert.equal(body.trackingNumber, 'VTP-SECRET-999');
});

test('QA-19: persistent-assets local fallback preserves true MIME type when serving raw image bytes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'persistent-assets.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('const serveLocalFallback=');
  const end = src.indexOf('const row=await getCachedSnapshotRow', start);
  assert.ok(start > 0 && end > start);
  const fallbackBlock = src.slice(start, end);
  assert.ok(
    !fallbackBlock.includes("res.type('image/webp').set({'Cache-Control':cacheControl,'ETag':'\"'+hash(raw)"),
    'Raw non-webp bytes must never be labeled image/webp'
  );
  const mimeMatches = fallbackBlock.match(/res\.type\(mime\|\|'application\/octet-stream'\)/g) || [];
  assert.equal(mimeMatches.length, 2, 'Both width-image raw fallback and generic raw fallback must use actual MIME type');
});
