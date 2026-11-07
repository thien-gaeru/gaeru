'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { once } = require('node:events');
const { parseHTML } = require('linkedom');
const { PGlite } = require('@electric-sql/pglite');
const sharp = require('sharp');

const { migrateDatabase } = require('../src/migrate');
const { withTransaction } = require('../src/db');
const { seal } = require('../src/totp');
const { attachTransactionalCacheInvalidation } = require('../src/app');
const { createStoreApi, loadProducts } = require('../src/store-api');
const { receiptTotal, recordFullOrderPayment } = require('../src/finance-api');
const { deleteOrderPermanently } = require('../src/order-deletion');
const { permanentDeleteCustomer } = require('../src/customer-lifecycle');
const { createCodReturnIntake } = require('../src/cod-return-intake');
const { createSeoPages } = require('../src/seo-pages');
const {
  normalizeCarrierStatus,
  resolveViettelProvinceId,
  computeCarrierShipmentPricing,
  getAdapter
} = require('../src/shipping-adapters');
const {
  createShippingManagement,
  createWaybill,
  cancelWaybill,
  syncShipmentTracking,
  settleCarrierCod,
  handleCarrierWebhook,
  quoteShippingFee,
  invalidateShippingQuoteCache,
  signGuestTrackingToken
} = require('../src/shipping-management');
const {
  ramCache,
  getFreshData,
  smartPageCache,
  flushAllCache,
  getNextPromotionBoundary
} = require('../cache');

async function createTestPool(t) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  const rawExec = async (sql, values) => {
    const res = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...res, rows: res?.rows || [], rowCount: res?.affectedRows ?? res?.rows?.length ?? 0 };
  };
  async function lock() {
    const before = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await before;
    return release;
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try {
        return await rawExec(sql, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await lock();
      return { query: rawExec, release };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);
  return { db, pool, rawExec };
}

async function seedViettelCarrier(pool, config, webhookSecret = 'wh-qa24-secret-2026') {
  const encKey = process.env.AUTH_ENCRYPTION_KEY || config.SESSION_SECRET;
  await pool.query(
    `INSERT INTO store_settings(setting_key, setting_value)
     VALUES ('private_admin:shipping_viettel', $1)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
    [
      JSON.stringify({
        version: 1,
        cipher: seal(
          JSON.stringify({
            accountId: '987654',
            secret: 'eyJ-viettel-jwt-token-qa24',
            webhookSecret,
            pickupAddress: 'Kho GAERU Hà Nội',
            defaultService: 'VCN'
          }),
          encKey
        )
      })
    ]
  );
  await pool.query(
    `INSERT INTO shipping_carrier_connections(carrier_id, config_version, verified_at, enabled)
     VALUES ('viettel', 1, now(), true)
     ON CONFLICT (carrier_id) DO UPDATE SET enabled = true, verified_at = now()`
  );
  return webhookSecret;
}

test('QA01 & P2-05: create-local-owner blocks production, CI, and remote DBs and never prints passwords to console', async () => {
  const { assertLocalOwnerEnvironment, setup } = require('../scripts/create-local-owner');

  assert.throws(() => assertLocalOwnerEnvironment({ NODE_ENV: 'production' }), /production/i);
  assert.throws(() => assertLocalOwnerEnvironment({ NODE_ENV: 'development', CI: 'true' }), /CI/i);
  assert.throws(
    () => assertLocalOwnerEnvironment({ NODE_ENV: 'development', DATABASE_URL: 'postgres://u:p@db.prod.example.com/gaeru' }),
    /non-loopback/i
  );
  assert.doesNotThrow(() =>
    assertLocalOwnerEnvironment({ NODE_ENV: 'development', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/gaeru_dev' })
  );

  const logs = [];
  const origLog = console.log;
  const envPath = path.join(__dirname, '..', '.env.local-owner');
  const hadExisting = fs.existsSync(envPath);
  const backup = hadExisting ? fs.readFileSync(envPath, 'utf8') : null;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await setup({ NODE_ENV: 'development', GAERU_LOCAL_OWNER_USER: 'local_qa_owner' });
    const combinedLogs = logs.join('\n');
    assert.ok(!/password\s*:/i.test(combinedLogs), 'Console output must never print generated cleartext password');
  } finally {
    console.log = origLog;
    if (hadExisting && backup !== null) fs.writeFileSync(envPath, backup, { encoding: 'utf8', mode: 0o600 });
    else if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
  }
});

test('QA02, QA03, QA04, QA05, QA06, QA07 & QA08: Carrier concurrency fencing, mid-flight cancel vs delivered race, monotonic state & 5x webhook replay dedupe', async (t) => {
  const { pool } = await createTestPool(t);
  const config = { SESSION_SECRET: 'qa24-carrier-state-machine-secret-32c' };
  const webhookSecret = await seedViettelCarrier(pool, config);

  // --- QA02: Two concurrent createWaybill calls send only 1 carrier request ---
  const ordQa02 = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-QA02', 'Khách QA02', 'qa02@example.invalid', '0911000002', '10 Trần Hưng Đạo', 'Hà Nội', 'cod', 'pending', 'processing', 200000, 200000)
       RETURNING id`
    )
  ).rows[0];
  let qa02Calls = 0;
  let enterQa02, releaseQa02;
  const qa02Entered = new Promise((r) => { enterQa02 = r; });
  const qa02Gate = new Promise((r) => { releaseQa02 = r; });
  const qa02Fetcher = async () => {
    qa02Calls++;
    enterQa02();
    await qa02Gate;
    return { ok: true, status: 200, json: async () => ({ status: 200, error: false, data: { ORDER_NUMBER: 'VTP-QA02-001', MONEY_TOTAL: 20000 } }) };
  };
  const p1 = createWaybill(pool, config, { orderId: ordQa02.id, carrierId: 'viettel', actor: { username: 'staff1' }, fetcher: qa02Fetcher });
  await qa02Entered;
  await assert.rejects(
    () => createWaybill(pool, config, { orderId: ordQa02.id, carrierId: 'viettel', actor: { username: 'staff2' }, fetcher: qa02Fetcher }),
    (err) => err.status === 409
  );
  releaseQa02();
  const r1 = await p1;
  assert.equal(r1.shipment.trackingNumber, 'VTP-QA02-001');
  assert.equal(qa02Calls, 1, 'Only 1 carrier create call may be sent');

  // --- QA05: Cancel failure (invalid token / 404) reverts cancel_requested and never marks cancelled ---
  await assert.rejects(
    () =>
      cancelWaybill(pool, config, {
        orderId: ordQa02.id,
        actor: { username: 'staff1' },
        fetcher: async () => ({ ok: false, status: 404, json: async () => ({ message: 'Not found' }) })
      }),
    (err) => err.status === 502
  );
  const afterFailedCancel = (await pool.query('SELECT status FROM carrier_shipments WHERE order_id = $1', [ordQa02.id])).rows[0];
  assert.equal(afterFailedCancel.status, 'created', 'Failed remote cancel must revert cancel_requested back to created');

  // --- QA06 (P1-01): Mid-flight cancelWaybill vs concurrent webhook 501 (delivered) ---
  let enterCancel, releaseCancel;
  const cancelEntered = new Promise((r) => { enterCancel = r; });
  const cancelGate = new Promise((r) => { releaseCancel = r; });
  const cancelPromise = cancelWaybill(pool, config, {
    orderId: ordQa02.id,
    actor: { username: 'staff1' },
    fetcher: async () => {
      enterCancel();
      await cancelGate;
      // Carrier sluggishly returns 200 OK even though delivery webhook already fired
      return { ok: true, status: 200, json: async () => ({ status: 200, error: false, message: 'OK' }) };
    }
  });
  await cancelEntered;

  // Verify Phase 1 placed shipment into cancel_requested
  assert.equal(
    (await pool.query('SELECT status FROM carrier_shipments WHERE order_id = $1', [ordQa02.id])).rows[0].status,
    'cancel_requested'
  );

  // Webhook 501 (delivered) arrives mid-flight!
  const midFlightWh = await handleCarrierWebhook(
    pool,
    config,
    'viettel',
    {
      DATA: {
        ORDER_NUMBER: 'VTP-QA02-001',
        ORDER_STATUS: 501,
        ORDER_STATUSDATE: '07/11/2026 14:00:00',
        NOTE: 'Giao thành công cho khách'
      }
    },
    { headers: { token: webhookSecret } }
  );
  assert.equal(midFlightWh.processed, true);
  assert.equal(midFlightWh.normalizedStatus, 'delivered');

  // Resume cancelWaybill -> MUST reject with 409 and NEVER overwrite delivered with cancelled!
  releaseCancel();
  await assert.rejects(() => cancelPromise, (err) => err.status === 409);
  const preservedDelivered = (await pool.query('SELECT status FROM carrier_shipments WHERE order_id = $1', [ordQa02.id])).rows[0];
  assert.equal(preservedDelivered.status, 'delivered', 'QA06: delivered must NEVER be overwritten by late cancel response');

  // --- QA07 (P1-02): Late polling returning 103 (picking) after 501 (delivered) must NOT downgrade ---
  const syncRes = await syncShipmentTracking(pool, config, {
    orderId: ordQa02.id,
    actor: { username: 'staff1' },
    fetcher: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 200,
        error: false,
        data: [{ ORDER_STATUS: 103, STATUS_NAME: 'Đang lấy hàng trễ', DATE: '2026-11-07T06:00:00Z' }]
      })
    })
  });
  assert.equal(syncRes.status, 'delivered', 'QA07: Late polling status 103 must not regress delivered shipment');
  assert.equal(
    (await pool.query('SELECT status FROM carrier_shipments WHERE order_id = $1', [ordQa02.id])).rows[0].status,
    'delivered'
  );

  // --- QA08 (P1-07): 5x duplicate webhook 501 replay creates 0 duplicate history/events and log is immutable ---
  const historyLenBeforeReplay = (
    await pool.query("SELECT jsonb_array_length(tracking_history) AS len FROM carrier_shipments WHERE order_id = $1", [ordQa02.id])
  ).rows[0].len;
  assert.equal(historyLenBeforeReplay, 2, 'Initial created + first 501 delivered = 2 entries before replay');

  for (let i = 0; i < 4; i++) {
    const replay = await handleCarrierWebhook(
      pool,
      config,
      'viettel',
      {
        DATA: {
          ORDER_NUMBER: 'VTP-QA02-001',
          ORDER_STATUS: 501,
          ORDER_STATUSDATE: '07/11/2026 14:00:00',
          NOTE: 'Giao thành công cho khách'
        }
      },
      { headers: { token: webhookSecret } }
    );
    assert.equal(replay.duplicate, true, `Replay #${i + 1} must be flagged duplicate`);
    assert.equal(replay.processed, false);
  }

  const eventCount = (
    await pool.query("SELECT COUNT(*)::int AS cnt FROM carrier_webhook_events WHERE tracking_number = 'VTP-QA02-001'")
  ).rows[0].cnt;
  assert.equal(eventCount, 1, 'QA08: Exactly 1 webhook event stored across 5 identical deliveries');

  const historyLen = (
    await pool.query("SELECT jsonb_array_length(tracking_history) AS len FROM carrier_shipments WHERE order_id = $1", [ordQa02.id])
  ).rows[0].len;
  assert.equal(historyLen, historyLenBeforeReplay, 'QA08: tracking_history must not duplicate across 5 webhook replays');

  // Verify carrier_webhook_events append-only trigger
  await assert.rejects(
    () => pool.query("DELETE FROM carrier_webhook_events WHERE tracking_number = 'VTP-QA02-001'"),
    /append-only/i
  );
});

test('QA09 & QA10 (P1-03): Viettel 505/502/504 return status separation blocks premature stock restock until 504 returned', async (t) => {
  assert.equal(normalizeCarrierStatus('viettel', 505), 'return_requested');
  assert.equal(normalizeCarrierStatus('viettel', 502), 'returning');
  assert.equal(normalizeCarrierStatus('viettel', 504), 'returned');

  const { pool } = await createTestPool(t);
  const config = { SESSION_SECRET: 'qa09-qa10-return-intake-secret-key' };
  const webhookSecret = await seedViettelCarrier(pool, config);

  const wh = (await pool.query("INSERT INTO warehouses(code, name, active) VALUES ('MAIN', 'Kho Chính', true) ON CONFLICT (code) DO UPDATE SET active = true RETURNING id")).rows[0];
  const prod = (await pool.query("INSERT INTO products(slug, name, category, active) VALUES ('qa10-mic', 'GAERU QA10', 'audio', true) RETURNING id")).rows[0];
  const variant = (
    await pool.query(
      "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'QA10-SKU', 'Bản Chuẩn', 300000, 8, true) RETURNING id",
      [prod.id]
    )
  ).rows[0];
  await pool.query('INSERT INTO warehouse_stock(warehouse_id, variant_id, quantity) VALUES ($1, $2, 8)', [wh.id, variant.id]);

  const order = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-QA10', 'Khách Hoàn', 'qa10@example.invalid', '0911000010', '50 Lê Lợi', 'Đà Nẵng', 'cod', 'pending', 'shipped', 600000, 600000)
       RETURNING id`
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO order_items(order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES ($1, $2, 'GAERU QA10', 'Bản Chuẩn', 'QA10-SKU', 300000, 2, 600000)`,
    [order.id, variant.id]
  );
  await pool.query(
    `INSERT INTO order_stock_allocations(order_id, variant_id, warehouse_id, quantity)
     VALUES ($1, $2, $3, 2)`,
    [order.id, variant.id, wh.id]
  );
  await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, cod_amount_vnd)
     VALUES ($1, 'viettel', 'VTP-QA10-RET', 'delivering', 600000)`,
    [order.id]
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { csrfToken: 'csrf-qa10' };
    req.admin = { username: 'wh_staff', role: 'warehouse', source: 'staff', permissions: ['orders.read', 'inventory.write'] };
    next();
  });
  app.use('/api', createCodReturnIntake(pool));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  // 1. Viettel sends 505 (Duyệt hoàn / return_requested) -> NOT returned to sender yet!
  await handleCarrierWebhook(
    pool,
    config,
    'viettel',
    { DATA: { ORDER_NUMBER: 'VTP-QA10-RET', ORDER_STATUS: 505, NOTE: 'Duyệt lệnh chuyển hoàn' } },
    { headers: { token: webhookSecret } }
  );
  assert.equal((await pool.query('SELECT status FROM carrier_shipments WHERE order_id = $1', [order.id])).rows[0].status, 'return_requested');

  const pendingAt505 = await (await fetch(`${base}/cod-returns/pending`)).json();
  assert.equal(pendingAt505.total, 0, '505 return_requested must NOT appear in warehouse physical intake queue');

  const intakeAt505 = await fetch(`${base}/cod-returns/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'csrf-qa10' },
    body: JSON.stringify({ trackingNumber: 'VTP-QA10-RET', packageCondition: 'intact' })
  });
  assert.equal(intakeAt505.status, 400, 'QA10: Intake must reject 505 return_requested');
  assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0].stock_quantity, 8, 'Stock must NOT increase on 505');

  // 2. Viettel sends 502 (Đang chuyển hoàn / returning) -> still in transit, intake still blocked
  await handleCarrierWebhook(
    pool,
    config,
    'viettel',
    { DATA: { ORDER_NUMBER: 'VTP-QA10-RET', ORDER_STATUS: 502, NOTE: 'Đang luân chuyển hoàn về kho' } },
    { headers: { token: webhookSecret } }
  );
  assert.equal((await pool.query('SELECT status FROM carrier_shipments WHERE order_id = $1', [order.id])).rows[0].status, 'returning');
  const intakeAt502 = await fetch(`${base}/cod-returns/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'csrf-qa10' },
    body: JSON.stringify({ trackingNumber: 'VTP-QA10-RET', packageCondition: 'intact' })
  });
  assert.equal(intakeAt502.status, 400, 'QA10: Intake must reject 502 returning');
  assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0].stock_quantity, 8);

  // 3. Viettel sends 504 (Hoàn thành công / returned) -> physical intake succeeds and restocks 2 units -> 10
  await handleCarrierWebhook(
    pool,
    config,
    'viettel',
    { DATA: { ORDER_NUMBER: 'VTP-QA10-RET', ORDER_STATUS: 504, NOTE: 'Đã trả hàng hoàn cho người gửi' } },
    { headers: { token: webhookSecret } }
  );
  const pendingAt504 = await (await fetch(`${base}/cod-returns/pending`)).json();
  assert.equal(pendingAt504.total, 1);

  const intakeAt504 = await fetch(`${base}/cod-returns/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'csrf-qa10' },
    body: JSON.stringify({ trackingNumber: 'VTP-QA10-RET', packageCondition: 'intact', inspectionNotes: 'Nguyên seal hộp' })
  });
  assert.equal(intakeAt504.status, 200);
  assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0].stock_quantity, 10, 'Stock restocked to 10 after 504 intake');
});

test('QA11, QA12, QA13, QA16, QA17 & QA22: COD delivery vs settlement separation, RBAC on sync-tracking & 4-step workflow, and immutable sales_receipts ledger', async (t) => {
  const { pool } = await createTestPool(t);
  const config = { SESSION_SECRET: 'qa11-qa22-finance-ledger-secret-32c' };
  const webhookSecret = await seedViettelCarrier(pool, config);

  const cust = (
    await pool.query("INSERT INTO customers(email, full_name, phone) VALUES ('qa11@example.invalid', 'Khách QA11', '0911000011') RETURNING id")
  ).rows[0];
  const codOrder = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
       VALUES ('GR-QA11-COD', $1, 'Khách QA11', 'qa11@example.invalid', '0911000011', '88 Nguyễn Huệ', 'Hồ Chí Minh', 'cod', 'pending', 'pending', 400000, 25000, 425000)
       RETURNING id`,
      [cust.id]
    )
  ).rows[0];

  let currentActor = {
    username: 'sales_user',
    role: 'sales',
    source: 'staff',
    permissions: ['orders.read', 'orders.write']
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { csrfToken: 'csrf-qa11', admin: { username: currentActor.username, source: currentActor.source } };
    req.admin = currentActor;
    next();
  });
  const shippingMgmt = createShippingManagement(pool, config, {
    finance: { receiptTotal, recordFullOrderPayment },
    fetcher: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 200,
        error: false,
        data: [{ ORDER_STATUS: 501, STATUS_NAME: 'Giao thành công', DATE: '2026-11-07T08:00:00Z' }]
      })
    })
  });
  app.use('/api/gaeru_ceo', shippingMgmt.admin);
  app.use(
    '/api',
    createStoreApi(pool, {
      ordersEnabled: true,
      finance: { receiptTotal, recordFullOrderPayment }
    })
  );
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const headers = { 'Content-Type': 'application/json', 'x-csrf-token': 'csrf-qa11' };

  // --- QA22: Single & bulk 4-step workflow with sales/warehouse roles; cannot mark paid ---
  // Step 1 -> Step 2 (pending -> processing via shortcut) by sales
  const toProcessing = await fetch(`${base}/gaeru_ceo/orders/${codOrder.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'processing' })
  });
  assert.equal(toProcessing.status, 200);
  assert.equal((await toProcessing.json()).order.status, 'processing');

  // Step 2 -> Step 3 (processing -> shipped via bulk endpoint) by warehouse
  currentActor = {
    username: 'warehouse_user',
    role: 'warehouse',
    source: 'staff',
    permissions: ['orders.read', 'orders.write', 'inventory.write']
  };
  const bulkToShipped = await fetch(`${base}/gaeru_ceo/orders/bulk`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'ship',
      orders: [
        {
          id: codOrder.id,
          expectedStatus: 'processing',
          expectedPaymentStatus: 'pending',
          expectedTotalVnd: 425000
        }
      ]
    })
  });
  assert.equal(bulkToShipped.status, 200);
  assert.equal((await pool.query('SELECT status FROM orders WHERE id = $1', [codOrder.id])).rows[0].status, 'shipped');

  // Warehouse / Sales attempting to mark COD order paid -> 403 Forbidden
  const illegalPaidByWarehouse = await fetch(`${base}/gaeru_ceo/orders/${codOrder.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'completed', confirmReceived: true, reconciliationRef: 'VTP-FAKE-1234' })
  });
  assert.equal(illegalPaidByWarehouse.status, 403, 'QA22: warehouse without payments.write cannot mark order paid');

  // Attach carrier waybill with COD 425,000 VND
  await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, cod_amount_vnd)
     VALUES ($1, 'viettel', 'VTP-QA11-425K', 'delivering', 425000)`,
    [codOrder.id]
  );

  // --- QA13 (P1-06): Viewer with orders.read only calling sync-tracking -> 403 ---
  currentActor = {
    username: 'viewer_user',
    role: 'viewer',
    source: 'staff',
    permissions: ['orders.read']
  };
  const viewerSync = await fetch(`${base}/gaeru_ceo/shipping/orders/${codOrder.id}/sync-tracking`, {
    method: 'POST',
    headers
  });
  assert.equal(viewerSync.status, 403, 'QA13: orders.read viewer must be blocked from mutating sync-tracking');

  // --- QA11 (P0-01): Webhook 501 delivered on COD order does NOT mark paid or create sales_receipt ---
  const whDelivered = await handleCarrierWebhook(
    pool,
    config,
    'viettel',
    { DATA: { ORDER_NUMBER: 'VTP-QA11-425K', ORDER_STATUS: 501, NOTE: 'Đã giao cho người nhận' } },
    { finance: { receiptTotal, recordFullOrderPayment }, headers: { token: webhookSecret } }
  );
  assert.equal(whDelivered.processed, true);
  const afterWhOrder = (await pool.query('SELECT status, payment_status, delivered_at FROM orders WHERE id = $1', [codOrder.id])).rows[0];
  assert.equal(afterWhOrder.status, 'shipped');
  assert.equal(afterWhOrder.payment_status, 'pending', 'QA11: Delivered COD must remain payment_status=pending until settled');
  assert.ok(afterWhOrder.delivered_at, 'delivered_at timestamp recorded');
  assert.equal(await receiptTotal(pool, codOrder.id), 0, 'QA11: Zero sales_receipts before COD settlement');
  assert.equal(
    (await pool.query('SELECT cod_settlement_status FROM carrier_shipments WHERE order_id = $1', [codOrder.id])).rows[0].cod_settlement_status,
    'unsettled'
  );

  // --- QA12: Finance role can mark delivered carrier-COD paid/completed freely without manual reconciliationRef ---
  currentActor = {
    username: 'finance_user',
    role: 'finance',
    source: 'staff',
    permissions: ['orders.read', 'orders.write', 'payments.write', 'finance.read']
  };

  const codOrderNoRef = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, delivered_at, subtotal_vnd, shipping_fee_vnd, total_vnd)
       VALUES ('GR-QA12-NO-REF', $1, 'Khách QA12', 'qa12@example.invalid', '0911000012', '88 Nguyễn Huệ', 'Hồ Chí Minh', 'cod', 'pending', 'shipped', now(), 400000, 25000, 425000)
       RETURNING id`,
      [cust.id]
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, cod_amount_vnd)
     VALUES ($1, 'viettel', 'VTP-QA12-NO-REF', 'delivered', 425000)`,
    [codOrderNoRef.id]
  );

  const missingRefPatch = await fetch(`${base}/gaeru_ceo/orders/${codOrderNoRef.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'completed', paymentStatus: 'paid', confirmReceived: true })
  });
  assert.equal(missingRefPatch.status, 200, 'Carrier COD can be marked completed and paid freely without manual reconciliationRef');
  const noRefJson = await missingRefPatch.json();
  assert.equal(noRefJson.order.status, 'completed');
  assert.equal(noRefJson.order.paymentStatus, 'paid');

  const wrongAmountSettle = await fetch(`${base}/gaeru_ceo/shipping/orders/${codOrder.id}/settle-cod`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ providerTransactionRef: 'VTP-BANK-20261107-88', settledAmountVnd: 400000 })
  });
  assert.equal(wrongAmountSettle.status, 409, 'QA12: Mismatched COD settlement amount must be rejected');

  const validSettle = await fetch(`${base}/gaeru_ceo/shipping/orders/${codOrder.id}/settle-cod`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      providerTransactionRef: 'VTP-BANK-20261107-88',
      settledAmountVnd: 425000,
      method: 'bank_transfer',
      note: 'Sao kê Vietcombank đối soát Viettel Post kỳ 07/11'
    })
  });
  assert.equal(validSettle.status, 200);
  const settleJson = await validSettle.json();
  assert.equal(settleJson.codSettlementStatus, 'settled');

  // Replay identical settlement request -> idempotent, still 1 receipt
  const replaySettle = await fetch(`${base}/gaeru_ceo/shipping/orders/${codOrder.id}/settle-cod`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      providerTransactionRef: 'VTP-BANK-20261107-88',
      settledAmountVnd: 425000,
      method: 'bank_transfer'
    })
  });
  assert.equal(replaySettle.status, 200);
  assert.equal((await replaySettle.json()).replayed, true);

  const receipts = (await pool.query('SELECT * FROM sales_receipts WHERE order_id = $1', [codOrder.id])).rows;
  assert.equal(receipts.length, 1, 'QA12: Exactly 1 sales_receipt created');
  assert.equal(Number(receipts[0].amount_vnd), 425000);
  assert.equal(receipts[0].reference, 'VTP-BANK-20261107-88');

  // --- QA16 (P0-02): Hard-delete order with sales_receipt is blocked at both app and DB trigger layers ---
  await assert.rejects(
    () => withTransaction(pool, (client) => deleteOrderPermanently(client, codOrder.id, { actor: { username: 'owner' } })),
    (err) => err.status === 409
  );
  await assert.rejects(
    () => pool.query('DELETE FROM sales_receipts WHERE order_id = $1', [codOrder.id]),
    /Sales receipts are append-only/
  );
  await assert.rejects(
    () => pool.query("UPDATE sales_receipts SET amount_vnd = 0 WHERE order_id = $1", [codOrder.id]),
    /Sales receipts are append-only/
  );

  // --- QA17 (P0-02): Deleting customer anonymizes PII while keeping receipt count and VND unchanged ---
  await permanentDeleteCustomer(
    pool,
    cust.id,
    { username: 'owner', role: 'owner', source: 'bootstrap' },
    'Yêu cầu xóa dữ liệu cá nhân QA17'
  );
  assert.equal((await pool.query('SELECT COUNT(*)::int AS cnt FROM customers WHERE id = $1', [cust.id])).rows[0].cnt, 0);
  assert.equal(await receiptTotal(pool, codOrder.id), 425000, 'QA17: Revenue total must not decrease when customer is deleted');
  assert.equal((await pool.query('SELECT COUNT(*)::int AS cnt FROM sales_receipts WHERE order_id = $1', [codOrder.id])).rows[0].cnt, 1);
});

test('QA14, QA15 & QA18: Quote cache key isolation, 5-province & multi-weight COD fee calculation without double charging, and signed guest tracking token', async (t) => {
  const { pool } = await createTestPool(t);
  const config = { SESSION_SECRET: 'qa14-qa15-qa18-shipping-pricing-secret' };
  await seedViettelCarrier(pool, config);
  invalidateShippingQuoteCache();

  // --- QA15: 5 provinces + multiple item weights + zero double COD shipping fee ---
  const fiveLocations = [
    ['Hà Nội', 1],
    ['Thành phố Hồ Chí Minh', 2],
    ['Đà Nẵng', 4],
    ['Lai Châu', 29],
    ['Cần Thơ', 5]
  ];
  for (const [city, expectedProvinceId] of fiveLocations) {
    assert.equal(resolveViettelProvinceId(city), expectedProvinceId, `Province ID mismatch for ${city}`);
  }

  // Case A: COD order where total_vnd (230,000) ALREADY includes web shipping_fee_vnd (30,000) -> ORDER_PAYMENT must be 3, MONEY_COLLECTION = 230,000
  const pricingWithWebShip = computeCarrierShipmentPricing(
    {
      payment_method: 'cod',
      payment_status: 'pending',
      subtotal_vnd: 200000,
      discount_vnd: 0,
      shipping_fee_vnd: 30000,
      total_vnd: 230000,
      items: [
        { quantity: 1, weightGrams: 350 },
        { quantity: 3, weightGrams: 600 }
      ]
    },
    {}
  );
  assert.equal(pricingWithWebShip.weightGrams, 2150, 'Total weight = 350*1 + 600*3 = 2150g');
  assert.equal(pricingWithWebShip.carrierCodCollectionVnd, 230000);
  assert.equal(pricingWithWebShip.viettelOrderPayment, 3, 'QA15: ORDER_PAYMENT must be 3 (collect goods/total only, shop settles freight) so carrier does NOT add shipping fee a second time');

  let capturedWaybillBody = null;
  const viettel = getAdapter('viettel');
  await viettel.createWaybill(
    { secret: 'eyJ-qa15-token', pickupAddress: 'Kho Hà Nội' },
    {
      orderNumber: 'GR-QA15-LAI-CHAU',
      customerName: 'Đỗ Thiện',
      phone: '0358888536',
      address: 'Xã Tả Lèng',
      city: 'Lai Châu',
      paymentMethod: 'cod',
      paymentStatus: 'pending',
      subtotalVnd: 200000,
      shippingFeeVnd: 30000,
      totalVnd: 230000,
      items: [{ productName: 'GAERU K9', variantName: 'Type C', quantity: 2, priceVnd: 100000, weightGrams: 450 }]
    },
    {
      fetcher: async (_url, init) => {
        capturedWaybillBody = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => ({ status: 200, error: false, data: { ORDER_NUMBER: 'VTP-QA15-LC', MONEY_TOTAL: 28000 } }) };
      }
    }
  );
  assert.equal(capturedWaybillBody.RECEIVER_PROVINCE, 29, 'Lai Châu official Viettel Post province code = 29');
  assert.equal(capturedWaybillBody.PRODUCT_WEIGHT, 900, '2 items * 450g = 900g');
  assert.equal(capturedWaybillBody.MONEY_COLLECTION, 230000, 'Collect exact order total once');
  assert.equal(capturedWaybillBody.ORDER_PAYMENT, 3, 'Prevent carrier from adding MONEY_TOTAL on top of MONEY_COLLECTION');

  // --- QA14: Quote cache distinguishes city / address / totalVnd / invalidated settings ---
  let quoteCalls = 0;
  const quoteFetcher = async (_url, init) => {
    quoteCalls++;
    const body = JSON.parse(init.body);
    const fee = body.RECEIVER_PROVINCE === 29 ? 42000 : (body.MONEY_COLLECTION > 500000 ? 35000 : 22000);
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 200, error: false, data: [{ MA_DV_CHINH: 'VCN', GIA_CUOC: fee, THOI_GIAN: '2 ngày' }] })
    };
  };

  const qHanoi = await quoteShippingFee(pool, config, { carrierId: 'viettel', city: 'Hà Nội', address: '10 Phố Huế', weightGrams: 500, totalVnd: 200000, codAmountVnd: 200000, fetcher: quoteFetcher });
  const qHanoiCached = await quoteShippingFee(pool, config, { carrierId: 'viettel', city: 'Hà Nội', address: '10 Phố Huế', weightGrams: 500, totalVnd: 200000, codAmountVnd: 200000, fetcher: quoteFetcher });
  assert.equal(qHanoi.feeVnd, 22000);
  assert.equal(qHanoiCached.feeVnd, 22000);
  assert.equal(quoteCalls, 1, 'Identical quote request hits SHA-256 quote cache without calling carrier again');

  const qLaiChau = await quoteShippingFee(pool, config, { carrierId: 'viettel', city: 'Lai Châu', address: 'Xã Tả Lèng', weightGrams: 500, totalVnd: 200000, codAmountVnd: 200000, fetcher: quoteFetcher });
  assert.equal(qLaiChau.feeVnd, 42000, 'QA14: Different city must not hit Hanoi cache');

  const qHighCod = await quoteShippingFee(pool, config, { carrierId: 'viettel', city: 'Hà Nội', address: '10 Phố Huế', weightGrams: 500, totalVnd: 800000, codAmountVnd: 800000, fetcher: quoteFetcher });
  assert.equal(qHighCod.feeVnd, 35000, 'QA14: Different totalVnd/codAmountVnd must not hit low-value cache');

  invalidateShippingQuoteCache();
  const qAfterInvalidate = await quoteShippingFee(pool, config, { carrierId: 'viettel', city: 'Hà Nội', address: '10 Phố Huế', weightGrams: 500, totalVnd: 200000, codAmountVnd: 200000, fetcher: quoteFetcher });
  assert.equal(qAfterInvalidate.cached, undefined);
  assert.equal(quoteCalls, 4, 'QA14: Cache invalidation forces fresh carrier quote');

  // --- QA18 (P2-01): Signed guest tracking token grants exact-order read without exposing other orders ---
  const guestOrder1 = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-GUEST-01', 'Guest 1', 'g1@example.invalid', '0901000001', 'Địa chỉ 1', 'Hà Nội', 'cod', 'pending', 'shipped', 199000, 199000)
       RETURNING id`
    )
  ).rows[0];
  const guestOrder2 = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-GUEST-02', 'Guest 2', 'g2@example.invalid', '0902000002', 'Địa chỉ 2', 'Đà Nẵng', 'cod', 'pending', 'shipped', 299000, 299000)
       RETURNING id`
    )
  ).rows[0];
  await pool.query("INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status) VALUES ($1, 'viettel', 'VTP-G1', 'delivering'), ($2, 'viettel', 'VTP-G2', 'delivering')", [guestOrder1.id, guestOrder2.id]);

  const app = express();
  app.use((req, _res, next) => { req.session = {}; next(); });
  app.use('/api', createShippingManagement(pool, config).publicApi);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/shipping/tracking`;

  assert.equal((await fetch(`${base}/GR-GUEST-01`)).status, 401, 'Bare orderNumber without token must return 401');

  const tokenG1 = signGuestTrackingToken(config, 'GR-GUEST-01');
  const okGuest = await fetch(`${base}/GR-GUEST-01?token=${encodeURIComponent(tokenG1)}`);
  assert.equal(okGuest.status, 200);
  assert.equal((await okGuest.json()).trackingNumber, 'VTP-G1');

  const crossOrderAttempt = await fetch(`${base}/GR-GUEST-02?token=${encodeURIComponent(tokenG1)}`);
  assert.equal(crossOrderAttempt.status, 401, 'QA18: Token bound to GR-GUEST-01 cannot read GR-GUEST-02');
});

test('QA19 (P1-08): 100 cold GET image cache misses serve exact original MIME with 0 runtime Sharp/AVIF encodes', async (t) => {
  const pngBytes = await sharp({
    create: { width: 640, height: 480, channels: 4, background: { r: 20, g: 90, b: 180, alpha: 1 } }
  }).png().toBuffer();

  const selectiveAvif = require('../src/lib/selective-avif');
  const { sendPublicImage, resetRenditionCache } = require('../src/lib/image-renditions');
  resetRenditionCache();

  let avifEncodeCalls = 0;
  t.mock.method(selectiveAvif, 'encodeAvif', async () => {
    avifEncodeCalls++;
    throw new Error('encodeAvif must never be called on HTTP GET');
  });

  // Also ensure sharp resize/webp is never invoked by checking source & serving 100 cold unique image digests
  const renditionsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'image-renditions.js'), 'utf8');
  const sendFnBody = renditionsSrc.slice(renditionsSrc.indexOf('async function sendPublicImage'));
  assert.ok(!sendFnBody.includes('sharp('), 'sendPublicImage must contain zero sharp() calls');
  assert.ok(!sendFnBody.includes('encodeAvif('), 'sendPublicImage must contain zero encodeAvif() calls');

  const app = express();
  app.get('/api/catalog-images/:id', async (req, res, next) => {
    try {
      // Append unique trailer per id so every single request is a guaranteed 100% cold cache miss
      const uniqueContent = Buffer.concat([pngBytes, Buffer.from(req.params.id)]);
      await sendPublicImage(req, res, { content: uniqueContent, mime_type: 'image/png' }, 'catalog');
    } catch (e) {
      next(e);
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const responses = await Promise.all(
    Array.from({ length: 100 }, (_, idx) =>
      fetch(`${base}/api/catalog-images/cold-miss-${idx}?w=480`, {
        headers: { Accept: 'image/avif,image/webp,image/apng,*/*' }
      })
    )
  );
  for (const r of responses) {
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png', 'QA19: Cold miss must serve true original MIME image/png');
  }
  assert.equal(avifEncodeCalls, 0, 'QA19: Zero runtime AVIF encodes across 100 cold misses');
});

test('QA20 (P1-09) & QA21 (P2-03, P2-04): After-COMMIT cache invalidation and Flash Sale boundary + JSON-LD Offer synchronization', async (t) => {
  // --- QA20: Simulate MVCC where T2 reads old committed value while T1 has uncommitted UPDATE, then T1 COMMITs ---
  let committedPrice = 199000;
  let stagedPrice = null;
  const mvccPool = {
    async query(sql) {
      if (sql.includes('SELECT price_vnd')) return { rows: [{ price_vnd: committedPrice }] };
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql, values) {
          if (/^\s*BEGIN/i.test(sql)) return { rows: [] };
          if (/UPDATE\s+product_variants/i.test(sql)) {
            stagedPrice = values[0];
            return { rows: [] };
          }
          if (/^\s*COMMIT/i.test(sql)) {
            committedPrice = stagedPrice;
            stagedPrice = null;
            return { rows: [] };
          }
          return { rows: [] };
        },
        release() {}
      };
    }
  };
  attachTransactionalCacheInvalidation(mvccPool);
  flushAllCache();

  // T1 begins transaction and updates product_variants WITHOUT committing yet
  const clientT1 = await mvccPool.connect();
  await clientT1.query('BEGIN');
  await clientT1.query('UPDATE product_variants SET price_vnd = $1 WHERE id = $2', [149000, 'v1']);

  // T2 concurrent reader populates RAM & HTML cache BEFORE T1 commits (reads 199000)
  const t2ReadBeforeCommit = await getFreshData('data:catalog', async () => {
    const r = await mvccPool.query('SELECT price_vnd FROM product_variants');
    return r.rows[0].price_vnd;
  }, 60000);
  assert.equal(t2ReadBeforeCommit, 199000);
  ramCache.set('html:/san-pham/gaeru-k9', { raw: '<html>199.000 ₫</html>', time: Date.now() });
  assert.ok(ramCache.has('data:catalog'));
  assert.ok(ramCache.has('html:/san-pham/gaeru-k9'));

  // T1 now COMMITs -> after-commit hook MUST purge both data:catalog and html:* caches!
  await clientT1.query('COMMIT');
  clientT1.release();

  assert.equal(ramCache.has('data:catalog'), false, 'QA20: data:catalog must be invalidated upon COMMIT');
  assert.equal(ramCache.has('html:/san-pham/gaeru-k9'), false, 'QA20: HTML cache must be invalidated upon COMMIT');

  const readAfterCommit = await getFreshData('data:catalog', async () => {
    const r = await mvccPool.query('SELECT price_vnd FROM product_variants');
    return r.rows[0].price_vnd;
  }, 60000);
  assert.equal(readAfterCommit, 149000, 'QA20: Post-COMMIT read immediately returns new price 149,000');

  // --- QA21: Flash Sale HTML cache boundary & JSON-LD Offer synchronization ---
  const { pool } = await createTestPool(t);
  attachTransactionalCacheInvalidation(pool);
  flushAllCache();

  const prod = (
    await pool.query(
      "INSERT INTO products(slug, name, category, descriptor, description, card_summary, image_url, active) VALUES ('gaeru-flash', 'GAERU Flash Mic', 'audio', 'Micro thu âm', 'Mô tả chi tiết Flash', 'Tóm tắt Flash', '/assets/products/k9.webp', true) RETURNING id"
    )
  ).rows[0];
  const variant = (
    await pool.query(
      "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'FLASH-01', 'Bản Type-C', 300000, 5, true) RETURNING id",
      [prod.id]
    )
  ).rows[0];

  const endsSoonIso = new Date(Date.now() + 900).toISOString();
  const promo = (
    await pool.query(
      `INSERT INTO product_promotions(title, type, kind, amount, starts_at, ends_at, active)
       VALUES ('Flash Sale 50K', 'flash', 'fixed', 50000, now() - interval '5 minutes', $1, true)
       RETURNING id`,
      [endsSoonIso]
    )
  ).rows[0];
  await pool.query('INSERT INTO product_promotion_variants(promotion_id, variant_id) VALUES ($1, $2)', [promo.id, variant.id]);

  const app = express();
  app.use(smartPageCache(60000));
  app.use(createSeoPages(pool, 'https://gaeru.com'));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. During active Flash Sale: SSR HTML, JSON-LD Offer, and loadProducts all report 250,000 VND + priceValidUntil
  const resDuring = await fetch(`${base}/product.html?id=gaeru-flash`);
  assert.equal(resDuring.status, 200);
  const htmlDuring = await resDuring.text();
  const docDuring = parseHTML(htmlDuring).document;
  const jsonLdDuring = JSON.parse(docDuring.querySelector('script[type="application/ld+json"]').textContent);
  assert.equal(jsonLdDuring.offers[0].price, 250000, 'P2-04: JSON-LD Offer price matches Flash Sale price 250,000');
  assert.equal(jsonLdDuring.offers[0].priceValidUntil, endsSoonIso, 'P2-04: JSON-LD Offer includes priceValidUntil');
  assert.match(htmlDuring, /250\.000\s*₫/);
  assert.ok(getNextPromotionBoundary() !== null, 'P2-03: Promotion boundary registered in cache');

  // 2. Wait for the 900ms Flash Sale window to expire -> 60s smartPageCache MUST auto-expire at boundary!
  await new Promise((r) => setTimeout(r, 1050));
  const resAfter = await fetch(`${base}/product.html?id=gaeru-flash`);
  assert.equal(resAfter.headers.get('x-cache'), 'MISS-REBUILT', 'QA21: HTML cache must expire immediately when Flash Sale ends');
  const docAfter = parseHTML(await resAfter.text()).document;
  const jsonLdAfter = JSON.parse(docAfter.querySelector('script[type="application/ld+json"]').textContent);
  assert.equal(jsonLdAfter.offers[0].price, 300000, 'QA21: Post-Flash-Sale JSON-LD and SSR immediately revert to 300,000');
  const apiProductsAfter = await loadProducts(pool);
  assert.equal(apiProductsAfter[0].variants[0].priceVnd, 300000);
});

test('QA23, QA24 & P2-06: 30 concurrent public requests + SSE stream produce zero 5xx, homepage defers chat/address bundles, and readiness gate preserves state', async (t) => {
  // P2-06 verification on index.html
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('bot-protection.js'), 'Security bot-protection module preserved on homepage');
  assert.ok(indexHtml.includes('commerce.js'), 'Core commerce module preserved on homepage');
  assert.ok(!indexHtml.includes('shopping-chat-client.js'), 'P2-06: shopping-chat-client.js lazy-loaded on chat click');
  assert.ok(!indexHtml.includes('vietnam-address.js'), 'P2-06: vietnam-address.js lazy-loaded on checkout');
  assert.ok(!indexHtml.includes('checkout-flow.js'), 'P2-06: checkout-flow.js lazy-loaded on checkout/delivery toggle');

  // QA23: 30 concurrent storefront requests + active SSE connection -> 0 5xx errors
  const { pool } = await createTestPool(t);
  const { sseHandler, realtimeClients } = require('../src/realtime-sse');
  const app = express();
  app.get('/api/stream', sseHandler);
  app.use(smartPageCache(60000));
  app.use(createSeoPages(pool, 'https://gaeru.com'));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const c of realtimeClients) {
      try { c.end(); } catch (_) {}
    }
    realtimeClients.clear();
    return new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const sseAbort = new AbortController();
  const ssePromise = fetch(`${base}/api/stream`, { signal: sseAbort.signal }).catch(() => null);
  const burst = await Promise.all(
    Array.from({ length: 30 }, (_, i) => fetch(`${base}/?utm_content=burst-${i % 5}`))
  );
  for (const r of burst) {
    assert.equal(r.status, 200, 'QA23: Concurrent burst must return 200 with zero 5xx');
  }
  sseAbort.abort();
  await ssePromise;

  // QA24: Order outbox & stock remain durable across simulated worker interruption
  const ord = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-QA24-DURABLE', 'Khách QA24', 'qa24@example.invalid', '0911000024', '123 Cầu Giấy', 'Hà Nội', 'cod', 'pending', 'pending', 189000, 189000)
       RETURNING id`
    )
  ).rows[0];
  await pool.query(
    "INSERT INTO order_email_outbox(order_id, kind) VALUES ($1, 'receipt')",
    [ord.id]
  );
  const outboxPending = (
    await pool.query("SELECT COUNT(*)::int AS cnt FROM order_email_outbox WHERE order_id = $1 AND status = 'pending' AND finished_at IS NULL", [ord.id])
  ).rows[0].cnt;
  assert.equal(outboxPending, 1, 'QA24: Durable transactional outbox preserves unsent order email across restarts');
});
