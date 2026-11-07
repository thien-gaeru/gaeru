'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { once, EventEmitter } = require('node:events');
const { parseHTML } = require('linkedom');
const { PGlite } = require('@electric-sql/pglite');
const sharp = require('sharp');

const { migrateDatabase } = require('../src/migrate');
const { withTransaction, createPriorityPoolController } = require('../src/db');
const { createApp, attachTransactionalCacheInvalidation } = require('../src/app');
const { seal } = require('../src/totp');
const { receiptTotal, recordFullOrderPayment } = require('../src/finance-api');
const { deleteOrderPermanently } = require('../src/order-deletion');
const { permanentDeleteCustomer } = require('../src/customer-lifecycle');
const { applyPromotions } = require('../src/product-promotions');
const { createSeoPages } = require('../src/seo-pages');
const inventory = require('../src/inventory');
const { setReady, readinessMiddleware } = require('../src/lib/readiness-gate');
const {
  sendPublicImage,
  getCachedImageRow,
  clearImageLookupCache,
  enqueueImageWarm,
  getImageRenditionStats,
  resetImageRenditionStats,
  resetRenditionCache,
  MAX_ROW_CACHE_BYTES
} = require('../src/lib/image-renditions');
const {
  resolveViettelProvinceId,
  syncViettelProvinceCatalog,
  getAdapter
} = require('../src/shipping-adapters');
const {
  createWaybill,
  cancelWaybill,
  settleCarrierCod,
  settleCarrierCodBatch,
  listCodSettlements,
  confirmCarrierPortalStatus,
  handleCarrierWebhook,
  sanitizeWebhookPayload,
  purgeExpiredCarrierWebhookEvents,
  invalidateShippingQuoteCache
} = require('../src/shipping-management');
const {
  smartPageCache,
  flushAllCache,
  getNextPromotionBoundary
} = require('../cache');

async function createPglitePool({ skipLatestReconciliationMigration = false } = {}) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  const rawExec = async (sql, values) => {
    const res = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...res, rows: res?.rows || [], rowCount: res?.affectedRows ?? res?.rows?.length ?? 0 };
  };
  async function lock() {
    const prev = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await prev;
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
    },
    end: () => db.close()
  };

  if (skipLatestReconciliationMigration) {
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await pool.query("INSERT INTO schema_migrations(name) VALUES ('audit-reconciliation-v2-20261107.sql') ON CONFLICT DO NOTHING");
  }
  await migrateDatabase(pool);
  return { db, pool, rawExec };
}

async function seedViettelCarrier(pool, config, webhookSecret = 'wh-u22-secret-2026') {
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
            secret: 'eyJ-viettel-jwt-token-u22',
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

let shared = null;
let legacyUpgradeCtx = null;

test.before(async () => {
  const { pool } = await createPglitePool();
  const ownerPassword = 'Owner-u22-fixture-pass!';
  const sessionSecret = crypto.randomBytes(48).toString('hex');
  const momoSettings = {
    partnerCode: 'MOMOU22',
    accessKey: 'MOMOACCESSU22',
    secretKey: 'momo-secret-key-u22-fixture',
    environment: 'sandbox',
    enabled: true
  };
  const zaloSettings = {
    appId: '2554',
    key1: 'zalopay-key1-u22-fixture',
    key2: 'zalopay-key2-u22-fixture',
    environment: 'sandbox',
    enabled: true
  };
  const vnpaySettings = {
    tmnCode: 'GAERUU22',
    hashSecret: 'vnpay-hash-secret-u22-fixture',
    environment: 'sandbox',
    enabled: true
  };

  const providerCalls = [];
  const paymentFetcher = async (url, options = {}) => {
    const jsonRes = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (options.method === 'GET') return new Response('Gateway OK', { status: 200 });
    const body = options.body ? JSON.parse(options.body) : {};
    if (url === 'https://test-payment.momo.vn/v2/gateway/api/query') {
      return jsonRes({ resultCode: 1001, message: 'No order yet' });
    }
    if (url === 'https://sb-openapi.zalopay.vn/v2/query') {
      return jsonRes({ return_code: 2, sub_return_code: -49, return_message: 'No order yet' });
    }
    if (url === 'https://test-payment.momo.vn/v2/gateway/api/create') {
      providerCalls.push({ provider: 'momo', body });
      return jsonRes({
        resultCode: 0,
        partnerCode: body.partnerCode,
        requestId: body.requestId,
        orderId: body.orderId,
        amount: body.amount,
        payUrl: 'https://test-payment.momo.vn/v2/gateway/pay?token=u22-momo'
      });
    }
    if (url === 'https://sb-openapi.zalopay.vn/v2/create') {
      providerCalls.push({ provider: 'zalopay', body });
      return jsonRes({
        return_code: 1,
        sub_return_code: 1,
        app_id: body.app_id,
        app_trans_id: body.app_trans_id,
        amount: body.amount,
        order_url: 'https://qcgateway.zalopay.vn/openinapp?order=u22-zalo'
      });
    }
    throw new Error(`Unexpected payment provider URL: ${url}`);
  };

  const config = {
    NODE_ENV: 'test',
    SESSION_SECRET: sessionSecret,
    ADMIN_USERNAME: 'u22-owner',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(ownerPassword, 4),
    PUBLIC_BASE_URL: 'https://gaeru.com',
    STORE_ORDERS_ENABLED: true,
    paymentFetcher
  };
  const webhookSecret = await seedViettelCarrier(pool, config);
  await pool.query(
    `INSERT INTO store_settings(setting_key, setting_value)
     VALUES ('shipping_rates', '{"Hà Nội":30000,"Lai Châu":35000,"Thành phố Hồ Chí Minh":30000}'::jsonb)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`
  );

  const app = createApp({
    config,
    pool,
    sessionStore: new session.MemoryStore()
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  setReady(true);
  const base = `http://127.0.0.1:${server.address().port}`;

  let adminCookie = '';
  let adminCsrf = '';
  async function adminApi(urlPath, method = 'GET', body) {
    const res = await fetch(base + urlPath, {
      method,
      redirect: 'manual',
      headers: {
        Cookie: adminCookie,
        'X-CSRF-Token': adminCsrf,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) adminCookie = setCookie.split(';')[0];
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (data.csrfToken) adminCsrf = data.csrfToken;
    return { status: res.status, headers: res.headers, data, text };
  }

  await adminApi('/api/csrf');
  const loginRes = await adminApi('/api/auth/login', 'POST', { username: 'u22-owner', password: ownerPassword });
  assert.equal(loginRes.status, 200);

  await adminApi('/api/gaeru_ceo/owner/configuration/payment_bank_transfer', 'PUT', {
    version: 0,
    password: ownerPassword,
    data: {
      bankName: 'Vietcombank',
      accountNumber: '0123456789',
      accountHolder: 'CONG TY TNHH GAERU',
      branch: 'Hà Nội',
      transferSyntax: 'GAERU {MA_DON}',
      enabled: true
    }
  });
  await adminApi('/api/gaeru_ceo/owner/configuration/vnpay', 'PUT', {
    version: 0,
    password: ownerPassword,
    data: vnpaySettings
  });
  await adminApi('/api/gaeru_ceo/owner/configuration/payment_momo', 'PUT', {
    version: 0,
    password: ownerPassword,
    data: momoSettings
  });
  await adminApi('/api/gaeru_ceo/owner/configuration/payment_zalopay', 'PUT', {
    version: 0,
    password: ownerPassword,
    data: zaloSettings
  });

  shared = {
    pool,
    config,
    webhookSecret,
    server,
    base,
    adminApi,
    ownerPassword,
    momoSettings,
    zaloSettings,
    vnpaySettings,
    providerCalls
  };
});

test.after(async () => {
  if (legacyUpgradeCtx?.pool) {
    await legacyUpgradeCtx.pool.end().catch(() => {});
  }
  if (shared?.server) {
    await new Promise((r) => shared.server.close(r));
  }
  if (shared?.pool) {
    await shared.pool.end().catch(() => {});
  }
});

// ============================================================================
// U01: Legacy COD auto-paid without statement must NOT remain verified 'settled'
// ============================================================================
test('U01: Legacy COD auto-marked paid without bank statement is classified verification_required while preserving sales_receipts', async () => {
  legacyUpgradeCtx = await createPglitePool({ skipLatestReconciliationMigration: true });
  const { pool } = legacyUpgradeCtx;
  await seedViettelCarrier(pool, { SESSION_SECRET: 'u01-legacy-upgrade-secret-key-32ch' });

  const legacyOrder = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-U01-LEGACY', 'Khách Lịch Sử', 'u01@example.invalid', '0901000001', '12 Trần Phú', 'Hà Nội', 'cod', 'paid', 'completed', 202300, 202300)
       RETURNING *`
    )
  ).rows[0];
  await recordFullOrderPayment(pool, {
    order: legacyOrder,
    actor: { username: 'legacy_auto_webhook', role: 'system' },
    options: { requestKey: 'legacy:u01:auto', note: 'Auto COD cũ trước đối soát' }
  });
  await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status, cod_settlement_ref)
     VALUES ($1, 'viettel', 'VTP-U01-NOREF', 'delivered', 202300, 'settled', NULL)`,
    [legacyOrder.id]
  );

  const attestedOrder = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-U01-HASREF', 'Khách Có Sao Kê', 'u01b@example.invalid', '0901000002', '15 Lê Lợi', 'Hà Nội', 'cod', 'paid', 'completed', 310000, 310000)
       RETURNING *`
    )
  ).rows[0];
  await recordFullOrderPayment(pool, {
    order: attestedOrder,
    actor: { username: 'ketoan_cu', role: 'owner' },
    options: { requestKey: 'legacy:u01:hasref', reference: 'VCB-OLD-999', method: 'bank_transfer', note: 'Sao kê cũ' }
  });
  await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status, cod_settlement_ref)
     VALUES ($1, 'viettel', 'VTP-U01-HASREF', 'delivered', 310000, 'settled', 'VCB-OLD-999')`,
    [attestedOrder.id]
  );

  await pool.query("DELETE FROM schema_migrations WHERE name = 'audit-reconciliation-v2-20261107.sql'");
  const mig = await migrateDatabase(pool, { lockTimeoutMs: 5000 });
  assert.equal(mig.appliedCount, 1);

  const s1 = (await pool.query('SELECT cod_settlement_status, cod_attestation_level FROM carrier_shipments WHERE order_id = $1', [legacyOrder.id])).rows[0];
  assert.equal(s1.cod_settlement_status, 'verification_required', 'U01: Unreferenced legacy COD must become verification_required');
  assert.equal(s1.cod_attestation_level, 'none');
  assert.equal(await receiptTotal(pool, legacyOrder.id), 202300, 'U01: Historical sales_receipts must remain intact');

  const s2 = (await pool.query('SELECT cod_settlement_status, cod_attestation_level FROM carrier_shipments WHERE order_id = $1', [attestedOrder.id])).rows[0];
  assert.equal(s2.cod_settlement_status, 'settled', 'U01: Order with existing settlement ref stays settled');
  assert.equal(s2.cod_attestation_level, 'manually_attested');

  legacyUpgradeCtx.legacyOrderId = legacyOrder.id;
});

// ============================================================================
// U02: Legacy COD with real bank statement reconciles without duplicate receipt
// ============================================================================
test('U02: Reconciling verification_required legacy COD with real bank statement marks statement_verified without duplicating receipt', async () => {
  const { pool, legacyOrderId } = legacyUpgradeCtx;
  const beforeReceipts = (await pool.query('SELECT COUNT(*)::int AS cnt FROM sales_receipts WHERE order_id = $1', [legacyOrderId])).rows[0].cnt;
  assert.equal(beforeReceipts, 1);

  const batchRes = await settleCarrierCodBatch(pool, {
    carrierId: 'viettel',
    providerTransactionRef: 'VCB-STMT-20261107-LEGACY',
    declaredPayoutVnd: 202300,
    method: 'bank_transfer',
    payoutPeriod: '2026-W45',
    evidenceRef: 'SAOKE-VCB-20261107-PDF-01',
    note: 'Đối chiếu sao kê ngân hàng cho đơn lịch sử',
    allocations: [{ orderId: legacyOrderId, amountVnd: 202300 }],
    actor: { id: null, username: 'ketoan_truong', role: 'owner' }
  });

  assert.equal(batchRes.success, true);
  assert.equal(batchRes.batch.attestationLevel, 'statement_verified');
  assert.equal(batchRes.allocations[0].wasLegacyVerified, true);

  const afterReceipts = (await pool.query('SELECT COUNT(*)::int AS cnt FROM sales_receipts WHERE order_id = $1', [legacyOrderId])).rows[0].cnt;
  assert.equal(afterReceipts, 1, 'U02: Reconciling legacy paid COD must NOT insert a second sales_receipt');
  assert.equal(await receiptTotal(pool, legacyOrderId), 202300);

  const ship = (
    await pool.query(
      'SELECT cod_settlement_status, cod_attestation_level, cod_settlement_ref, cod_evidence_ref FROM carrier_shipments WHERE order_id = $1',
      [legacyOrderId]
    )
  ).rows[0];
  assert.equal(ship.cod_settlement_status, 'settled');
  assert.equal(ship.cod_attestation_level, 'statement_verified');
  assert.equal(ship.cod_settlement_ref, 'VCB-STMT-20261107-LEGACY');
  assert.equal(ship.cod_evidence_ref, 'SAOKE-VCB-20261107-PDF-01');
});

// ============================================================================
// U03: Provider cancel success + concurrent non-terminal version bump COMMITs conflict
// ============================================================================
test('U03: Provider cancel success with concurrent non-terminal version bump returns 409 AND commits cancel_reconciliation_required + audit', async () => {
  const { pool, config } = shared;
  const order = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-U03-RACE', 'Khách U03', 'u03@example.invalid', '0903000003', '10 Phố Huế', 'Hà Nội', 'cod', 'pending', 'shipped', 210000, 210000)
       RETURNING id`
    )
  ).rows[0];
  const ship = (
    await pool.query(
      `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, status_version, cod_amount_vnd, cod_settlement_status)
       VALUES ($1, 'viettel', 'VTP-U03-001', 'created', 1, 210000, 'unsettled')
       RETURNING id`,
      [order.id]
    )
  ).rows[0];

  const fetcher = async () => {
    // Simulate concurrent webhook advancing shipment to 'delivering' and bumping status_version while HTTP cancel is in flight
    await pool.query(
      `UPDATE carrier_shipments SET status = 'delivering', status_version = status_version + 1 WHERE id = $1`,
      [ship.id]
    );
    return { ok: true, status: 200, json: async () => ({ status: 200, error: false, message: 'Hủy thành công' }) };
  };

  await assert.rejects(
    () => cancelWaybill(pool, config, { orderId: order.id, actor: { username: 'ops_u03', role: 'owner' }, fetcher }),
    (err) => err.status === 409
  );

  const afterShip = (await pool.query('SELECT status FROM carrier_shipments WHERE id = $1', [ship.id])).rows[0];
  assert.equal(afterShip.status, 'cancel_reconciliation_required', 'U03: cancel_reconciliation_required MUST be committed despite 409');

  const auditRows = (
    await pool.query(
      `SELECT action, metadata FROM audit_events WHERE entity_id = $1 AND action = 'shipping.waybill.cancel_reconciliation_required'`,
      [order.id]
    )
  ).rows;
  assert.equal(auditRows.length, 1, 'U03: shipping.waybill.cancel_conflict audit row MUST be committed');
});

// ============================================================================
// U04: Provider cancel success + concurrent delivered webhook preserves delivered + commits audit
// ============================================================================
test('U04: Provider cancel success racing with concurrent delivered webhook preserves delivered state and commits conflict audit', async () => {
  const { pool, config } = shared;
  const order = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-U04-DELIV', 'Khách U04', 'u04@example.invalid', '0904000004', '20 Hàng Bài', 'Hà Nội', 'cod', 'pending', 'shipped', 260000, 260000)
       RETURNING id`
    )
  ).rows[0];
  const ship = (
    await pool.query(
      `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, status_version, cod_amount_vnd, cod_settlement_status)
       VALUES ($1, 'viettel', 'VTP-U04-001', 'delivering', 2, 260000, 'unsettled')
       RETURNING id`,
      [order.id]
    )
  ).rows[0];

  const fetcher = async () => {
    await pool.query(
      `UPDATE carrier_shipments SET status = 'delivered', status_version = status_version + 1 WHERE id = $1`,
      [ship.id]
    );
    return { ok: true, status: 200, json: async () => ({ status: 200, error: false, message: 'OK' }) };
  };

  await assert.rejects(
    () => cancelWaybill(pool, config, { orderId: order.id, actor: { username: 'ops_u04', role: 'owner' }, fetcher }),
    (err) => err.status === 409
  );

  const afterShip = (await pool.query('SELECT status FROM carrier_shipments WHERE id = $1', [ship.id])).rows[0];
  assert.equal(afterShip.status, 'delivered', 'U04: Terminal delivered status must NEVER be overwritten by late cancel');

  const auditRows = (
    await pool.query(
      `SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'shipping.waybill.cancel_conflict'`,
      [order.id]
    )
  ).rows;
  assert.equal(auditRows.length, 1, 'U04: Conflict audit row must survive in committed DB state');
});

// ============================================================================
// U05: Ambiguous timeout on cancelWaybill locks into cancel_reconciliation_required
// ============================================================================
test('U05: Ambiguous provider timeout on cancelWaybill locks shipment into cancel_reconciliation_required instead of reverting to created', async () => {
  const { pool, config } = shared;
  const order = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-U05-TIMEOUT', 'Khách U05', 'u05@example.invalid', '0905000005', '30 Kim Mã', 'Hà Nội', 'cod', 'pending', 'shipped', 180000, 180000)
       RETURNING id`
    )
  ).rows[0];
  const ship = (
    await pool.query(
      `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, status_version, cod_amount_vnd, cod_settlement_status)
       VALUES ($1, 'viettel', 'VTP-U05-001', 'created', 1, 180000, 'unsettled')
       RETURNING id`,
      [order.id]
    )
  ).rows[0];

  const timeoutFetcher = async () => {
    const abortErr = new Error('The operation was aborted due to timeout');
    abortErr.name = 'AbortError';
    throw abortErr;
  };

  await assert.rejects(
    () => cancelWaybill(pool, config, { orderId: order.id, actor: { username: 'ops_u05', role: 'owner' }, fetcher: timeoutFetcher }),
    (err) => err.status === 502 || err.status === 504 || /timeout|chưa xác định|đối soát/i.test(err.message)
  );

  const afterTimeout = (await pool.query('SELECT status FROM carrier_shipments WHERE id = $1', [ship.id])).rows[0];
  assert.equal(afterTimeout.status, 'cancel_reconciliation_required', 'U05: Must NOT revert to created for blind retry');

  const timeoutAudit = (
    await pool.query(
      `SELECT action FROM audit_events WHERE entity_id = $1 AND action = 'shipping.waybill.cancel_ambiguous_timeout'`,
      [order.id]
    )
  ).rows;
  assert.equal(timeoutAudit.length, 1);

  const resolved = await confirmCarrierPortalStatus(pool, {
    orderId: order.id,
    targetStatus: 'cancelled',
    evidenceNote: 'Đã kiểm tra trên cổng viettelpost.vn: vận đơn VTP-U05-001 đã hủy thành công lúc 15:10',
    actor: { username: 'ops_u05', role: 'owner' }
  });
  assert.equal(resolved.status, 'cancelled');
});

// ============================================================================
// U06: Single bank payout ref allocated across two COD orders matches declaredPayoutVnd
// ============================================================================
test('U06: One bank payout reference allocates cleanly across two delivered COD orders and enforces declaredPayoutVnd ceiling', async () => {
  const { pool, adminApi } = shared;
  const o1 = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-U06-A', 'Khách U06 A', 'u06a@example.invalid', '0906000001', '1 Cầu Giấy', 'Hà Nội', 'cod', 'pending', 'shipped', 250000, 250000)
       RETURNING id`
    )
  ).rows[0];
  const o2 = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-U06-B', 'Khách U06 B', 'u06b@example.invalid', '0906000002', '2 Cầu Giấy', 'Hà Nội', 'cod', 'pending', 'shipped', 300000, 300000)
       RETURNING id`
    )
  ).rows[0];
  const o3 = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-U06-C', 'Khách U06 C', 'u06c@example.invalid', '0906000003', '3 Cầu Giấy', 'Hà Nội', 'cod', 'pending', 'shipped', 100000, 100000)
       RETURNING id`
    )
  ).rows[0];

  await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status)
     VALUES ($1, 'viettel', 'VTP-U06-A', 'delivered', 250000, 'unsettled'),
            ($2, 'viettel', 'VTP-U06-B', 'delivered', 300000, 'unsettled'),
            ($3, 'viettel', 'VTP-U06-C', 'delivered', 100000, 'unsettled')`,
    [o1.id, o2.id, o3.id]
  );

  const res = await adminApi('/api/gaeru_ceo/shipping/cod-settlements/batch', 'POST', {
    carrierId: 'viettel',
    providerTransactionRef: 'VCB-PAYOUT-U06-550K',
    declaredPayoutVnd: 550000,
    method: 'bank_transfer',
    payoutPeriod: '2026-11-K1',
    evidenceRef: 'UNC-VCB-550K-0711',
    allocations: [
      { orderId: o1.id, amountVnd: 250000 },
      { orderId: o2.id, amountVnd: 300000 }
    ]
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.batch.declaredPayoutVnd, 550000);
  assert.equal(res.data.batch.allocatedTotalVnd, 550000);
  assert.equal(res.data.batch.unallocatedVnd, 0);
  assert.equal(res.data.batch.attestationLevel, 'statement_verified');
  assert.equal(await receiptTotal(pool, o1.id), 250000);
  assert.equal(await receiptTotal(pool, o2.id), 300000);

  const overAlloc = await adminApi('/api/gaeru_ceo/shipping/cod-settlements/batch', 'POST', {
    carrierId: 'viettel',
    providerTransactionRef: 'VCB-PAYOUT-U06-550K',
    declaredPayoutVnd: 550000,
    method: 'bank_transfer',
    allocations: [{ orderId: o3.id, amountVnd: 100000 }]
  });
  assert.equal(overAlloc.status, 409);

  shared.u06Order1Id = o1.id;
});

// ============================================================================
// U07: Replaying allocation for same order creates zero duplicate receipts & allocations are append-only
// ============================================================================
test('U07: Replaying COD settlement allocation for the same order is idempotent and cod_settlement_allocations is append-only', async () => {
  const { pool, u06Order1Id } = shared;
  const replay = await settleCarrierCod(pool, {
    orderId: u06Order1Id,
    providerTransactionRef: 'VCB-PAYOUT-U06-550K',
    settledAmountVnd: 250000,
    declaredPayoutVnd: 550000,
    method: 'bank_transfer',
    actor: { username: 'u22-owner', role: 'owner' }
  });
  assert.equal(replay.replayed, true);

  const rcptCount = (await pool.query('SELECT COUNT(*)::int AS cnt FROM sales_receipts WHERE order_id = $1', [u06Order1Id])).rows[0].cnt;
  assert.equal(rcptCount, 1, 'U07: Zero duplicate sales_receipts on replay');

  await assert.rejects(
    () => pool.query('DELETE FROM cod_settlement_allocations WHERE order_id = $1', [u06Order1Id]),
    /append-only|immutable/i
  );
});

// ============================================================================
// U08: settle-cod on picking shipment / shipped order refuses premature completion
// ============================================================================
test('U08: settle-cod and order update on picking shipment refuse premature completion before physical delivery', async () => {
  const { pool, adminApi } = shared;
  const order = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-U08-PICKING', 'Khách U08', 'u08@example.invalid', '0908000008', '88 Láng Hạ', 'Hà Nội', 'cod', 'pending', 'shipped', 290000, 290000)
       RETURNING id`
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status)
     VALUES ($1, 'viettel', 'VTP-U08-PICK', 'picking', 290000, 'unsettled')`,
    [order.id]
  );

  await assert.rejects(
    () =>
      settleCarrierCod(pool, {
        orderId: order.id,
        providerTransactionRef: 'VCB-U08-EARLY',
        settledAmountVnd: 290000,
        actor: { username: 'staff_acct', role: 'staff', permissions: ['payments.write'] }
      }),
    (err) => err.status === 409
  );

  const patchRes = await adminApi(`/api/gaeru_ceo/orders/${order.id}`, 'PATCH', {
    status: 'completed',
    paymentStatus: 'paid',
    shippingFeeVnd: 0
  });
  assert.equal(patchRes.status, 409);

  const overrideRes = await settleCarrierCod(pool, {
    orderId: order.id,
    providerTransactionRef: 'VCB-U08-ADVANCE-BANK',
    settledAmountVnd: 290000,
    declaredPayoutVnd: 290000,
    evidenceRef: 'SAOKE-UNG-TRUOC-U08',
    allowPreDeliveryOverride: true,
    overrideReason: 'Đối tác Viettel Post ứng trước 100% COD theo hợp đồng khung tháng 11',
    actor: { username: 'u22-owner', role: 'owner' }
  });
  assert.equal(overrideRes.paymentStatus, 'paid');
  assert.equal(overrideRes.orderStatus, 'shipped', 'U08: Order must stay shipped until physical delivery even under owner payment override');
});

// ============================================================================
// U09: /api/shipping/quote reflects codAmountVnd & verifies cart items server-side
// ============================================================================
test('U09: POST /api/shipping/quote reflects codAmountVnd and verifies cart items + promotions from DB rather than trusting client totals', async () => {
  const { pool, base } = shared;
  invalidateShippingQuoteCache();

  const prod = (
    await pool.query(
      `INSERT INTO products(slug, name, category, image_url, active)
       VALUES ('gaeru-u09-mic', 'GAERU U09 Mic', 'audio', '/assets/products/k9.webp', true)
       RETURNING id`
    )
  ).rows[0];
  const variant = (
    await pool.query(
      `INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'U09-SKU-1', 'Bản Chuẩn', 400000, 10, true)
       RETURNING id`,
      [prod.id]
    )
  ).rows[0];

  const seenBodies = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('viettelpost.vn')) {
      const parsed = JSON.parse(init.body);
      seenBodies.push(parsed);
      const fee = parsed.MONEY_COLLECTION > 0 ? 32000 : 21000;
      return new Response(
        JSON.stringify({ status: 200, error: false, data: [{ MA_DV_CHINH: 'VCN', GIA_CUOC: fee, THOI_GIAN: '2 ngày' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return originalFetch(url, init);
  };
  try {
    const prepaidRes = await originalFetch(`${base}/api/shipping/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carrierId: 'viettel', city: 'Hà Nội', paymentMethod: 'bank_transfer', totalVnd: 400000, codAmountVnd: 0 })
    });
    const prepaidJson = await prepaidRes.json();
    assert.equal(prepaidRes.status, 200);
    assert.equal(prepaidJson.feeVnd, 21000);
    assert.equal(prepaidJson.advisoryOnly, true);
    assert.equal(seenBodies.at(-1).MONEY_COLLECTION, 0);

    const cartRes = await originalFetch(`${base}/api/shipping/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        carrierId: 'viettel',
        city: 'Hà Nội',
        paymentMethod: 'cod',
        totalVnd: 1000,
        codAmountVnd: 0,
        items: [{ variantId: variant.id, quantity: 2 }]
      })
    });
    const cartJson = await cartRes.json();
    assert.equal(cartRes.status, 200);
    assert.equal(cartJson.quoteBasis, 'server_cart_verified');
    assert.equal(cartJson.feeVnd, 32000);
    assert.equal(seenBodies.at(-1).PRODUCT_PRICE, 800000, 'U09: Server must use DB price (800,000), ignoring spoofed client totalVnd=1000');
    assert.equal(seenBodies.at(-1).MONEY_COLLECTION, 800000);
  } finally {
    global.fetch = originalFetch;
  }
});

// ============================================================================
// U10: Unmapped city on Viettel Post throws clear 400 and NEVER defaults to Hanoi (1)
// ============================================================================
test('U10: Unmapped Viettel Post city returns 400 error and never falls back to Hanoi province ID 1', async () => {
  const { base } = shared;
  assert.throws(
    () => resolveViettelProvinceId('Thành phố Atlantis'),
    (err) => err.status === 400
  );

  let outboundCalled = false;
  const viettel = getAdapter('viettel');
  await assert.rejects(
    () =>
      viettel.createWaybill(
        { secret: 'eyJ-u10-token', pickupAddress: 'Kho Hà Nội' },
        {
          orderNumber: 'GR-U10-BAD-CITY',
          customerName: 'Khách U10',
          phone: '0910000010',
          address: '1 Đường Biển',
          city: 'Atlantis Unknown Province',
          paymentMethod: 'cod',
          totalVnd: 200000,
          items: [{ productName: 'GAERU K9', quantity: 1, priceVnd: 200000 }]
        },
        {
          fetcher: async () => {
            outboundCalled = true;
            throw new Error('Must never call Viettel API with fallback Hanoi province');
          }
        }
      ),
    (err) => err.status === 400
  );
  assert.equal(outboundCalled, false, 'U10: Outbound carrier API must NOT be called when province cannot be resolved');

  const quoteRes = await fetch(`${base}/api/shipping/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ carrierId: 'viettel', city: 'Atlantis Unknown Province', totalVnd: 200000 })
  });
  assert.equal(quoteRes.status, 400);
});

// ============================================================================
// U11: 5 provinces/regions (pre & post administrative boundary updates) match official Viettel catalog
// ============================================================================
test('U11: 5 provinces/regions including pre- and post-merger names resolve accurately and sync against Viettel province catalog', async () => {
  const cases = [
    ['Lai Châu', '', 29],
    ['Thành phố Huế', '', 37],
    ['Điện Biên', '', 64],
    ['TP. Hồ Chí Minh', 'Thành phố Thủ Đức, Phường Hiệp Bình', 2],
    ['Cần Thơ', 'Quận Ninh Kiều', 5]
  ];
  for (const [city, address, expectedId] of cases) {
    assert.equal(resolveViettelProvinceId(city, address), expectedId, `Mismatch for ${city} / ${address}`);
  }
  assert.equal(resolveViettelProvinceId('Thừa Thiên Huế'), 37);

  const syncResult = await syncViettelProvinceCatalog({
    fetcher: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 200,
        error: false,
        data: [
          { PROVINCE_ID: 1, PROVINCE_CODE: 'HNI', PROVINCE_NAME: 'Hà Nội' },
          { PROVINCE_ID: 29, PROVINCE_CODE: 'LCU', PROVINCE_NAME: 'Tỉnh Lai Châu' },
          { PROVINCE_ID: 37, PROVINCE_CODE: 'HUE', PROVINCE_NAME: 'Thành phố Huế' },
          { PROVINCE_ID: 64, PROVINCE_CODE: 'DBN', PROVINCE_NAME: 'Tỉnh Điện Biên' }
        ]
      })
    })
  });
  assert.equal(syncResult.syncedCount, 4);
  assert.equal(resolveViettelProvinceId('Lai Châu'), 29);
});

// ============================================================================
// U12: Bulk complete with 3 unsettled carrier-COD orders is blocked in UI & rejected 409 in API
// ============================================================================
test('U12: Bulk complete with 3 unsettled carrier-COD orders disables unverified UI submission and rejects 409 at API', async () => {
  const { pool, adminApi } = shared;
  const orders = [];
  for (let i = 1; i <= 3; i++) {
    const o = (
      await pool.query(
        `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
         VALUES ($1, $2, $3, '0912000012', '12 Đống Đa', 'Hà Nội', 'cod', 'pending', 'shipped', 200000, 200000)
         RETURNING id, order_number AS "orderNumber"`,
        [`GR-U12-COD-${i}`, `Khách U12 ${i}`, `u12_${i}@example.invalid`]
      )
    ).rows[0];
    await pool.query(
      `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status)
       VALUES ($1, 'viettel', $2, 'delivered', 200000, 'unsettled')`,
      [o.id, `VTP-U12-COD-${i}`]
    );
    orders.push({
      id: o.id,
      orderNumber: o.orderNumber,
      status: 'shipped',
      paymentMethod: 'cod',
      paymentStatus: 'pending',
      totalVnd: 200000,
      carrierShipment: { trackingNumber: `VTP-U12-COD-${i}`, status: 'delivered', codSettlementStatus: 'unsettled' }
    });
  }

  // 1. Verify Admin UI openBulkProcessing disables submit and surfaces COD reconciliation callout
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'admin', 'admin.js'), 'utf8');
  const { document, window } = parseHTML(html);
  Object.defineProperty(window.HTMLElement.prototype, 'elements', {
    configurable: true,
    get() {
      return new Proxy({}, { get: (_, name) => this.querySelector('[name="' + String(name) + '"]') });
    }
  });
  let bulkApiCalled = false;
  const context = {
    document,
    window,
    state: {
      orders,
      selectedOrders: new Set(orders.map((o) => o.id)),
      openOrders: new Set(),
      orderPagination: { page: 1, pageCount: 1, total: 3 },
      orderPage: 1
    },
    can: () => true,
    orderTransitions: { shipped: ['completed'] },
    labels: { shipped: 'Đang giao', completed: 'Hoàn tất', cod: 'COD' },
    formatPrice: (n) => `${n} ₫`,
    escapeHtml: (s) => String(s ?? ''),
    showGlobal() {},
    loadOrders: async () => {},
    loadSummary: async () => {},
    request: async () => { bulkApiCalled = true; return {}; }
  };
  vm.createContext(context);
  vm.runInContext(js.slice(js.indexOf('function isLiveVnpayAttempt'), js.indexOf('async function updateOrder')), context);
  context.openBulkProcessing();

  const dialog = document.getElementById('order-bulk-dialog');
  assert.ok(dialog);
  assert.equal(dialog.querySelector('[name="action"]').value || dialog.querySelector('[name="action"] option[selected]')?.getAttribute('value'), 'complete');
  assert.equal(dialog.querySelector('[data-bulk-cod-callout]').hidden, false, 'U12: COD reconciliation callout must be visible');
  assert.match(dialog.querySelector('[data-bulk-cod-msg]').textContent, /3 đơn COD thu hộ qua hãng chưa đối soát sao kê/);
  assert.equal(dialog.querySelector('button[type="submit"]').disabled, true, 'U12: Submit button must be disabled for unsettled carrier-COD');
  dialog.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(bulkApiCalled, false, 'U12: UI must never send unverified bulk complete request');

  // 2. Direct API bypass attempt must also be rejected with 409
  const directBulk = await adminApi('/api/gaeru_ceo/orders/bulk', 'POST', {
    action: 'complete',
    confirmReceived: true,
    orders: orders.map((o) => ({
      id: o.id,
      expectedStatus: 'shipped',
      expectedPaymentStatus: 'pending',
      expectedTotalVnd: 200000
    }))
  });
  assert.equal(directBulk.status, 409);
});

// ============================================================================
// U13: Accounting COD batch reconciliation panel & API expose period, evidence, amounts & staff audit
// ============================================================================
test('U13: Accounting COD batch reconciliation UI & GET /shipping/cod-settlements expose payout period, evidence, amounts, attestation & staff audit', async () => {
  const { pool, adminApi } = shared;
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  const { document } = parseHTML(html);

  const panel = document.querySelector('#cod-settlement-panel');
  assert.ok(panel, 'U13: #cod-settlement-panel must exist in admin/index.html');
  assert.ok(panel.querySelector('#cod-batch-form [name="providerTransactionRef"]'), 'U13: Bank reference input must exist');
  assert.ok(panel.querySelector('#cod-batch-form [name="declaredPayoutVnd"]'), 'U13: Declared payout input must exist');
  assert.ok(panel.querySelector('#cod-batch-form [name="payoutPeriod"]'), 'U13: Payout period input must exist');
  assert.ok(panel.querySelector('#cod-batch-form [name="evidenceRef"]'), 'U13: Statement evidence input must exist');

  const res = await adminApi('/api/gaeru_ceo/shipping/cod-settlements?carrierId=viettel');
  assert.equal(res.status, 200);
  assert.ok(res.data.summary);
  const u06Batch = res.data.batches.find((b) => b.providerTransactionRef === 'VCB-PAYOUT-U06-550K');
  assert.ok(u06Batch, 'U13: Batch created in U06 must appear in accounting settlement ledger');
  assert.equal(u06Batch.payoutPeriod, '2026-11-K1');
  assert.equal(u06Batch.evidenceRef, 'UNC-VCB-550K-0711');
  assert.equal(u06Batch.declaredPayoutVnd, 550000);
  assert.equal(u06Batch.allocatedTotalVnd, 550000);
  assert.equal(u06Batch.attestationLevel, 'statement_verified');
  assert.equal(u06Batch.createdBy, 'u22-owner');

  const directLedger = await listCodSettlements(pool, { settlementStatus: 'settled' });
  assert.ok(directLedger.shipments.some((s) => s.codAttestedBy === 'u22-owner' && s.codAttestationLevel === 'statement_verified'));
});

// ============================================================================
// U14: Low-priority worker transactions via .connect() obey concurrency cap & yield to high priority
// ============================================================================
test('U14: Concurrent low-priority worker transactions via pool.connect() never exceed maxLowPriorityOps and yield to highPriorityPool', async () => {
  let rawActiveCheckouts = 0;
  let peakRawLowCheckouts = 0;
  const mockPool = {
    async query() {
      return { rows: [{ ok: 1 }] };
    },
    async connect() {
      rawActiveCheckouts++;
      return {
        async query() {
          await new Promise((r) => setTimeout(r, 15));
          return { rows: [] };
        },
        release() {
          rawActiveCheckouts--;
        }
      };
    }
  };

  const controller = createPriorityPoolController(mockPool, { maxLowPriorityOps: 2 });
  const observedLowConcurrency = [];

  const lowTasks = Array.from({ length: 10 }, (_, idx) =>
    withTransaction(controller.lowPriorityPool, async (client) => {
      const stats = controller.getStats();
      observedLowConcurrency.push(stats.activeLowOps);
      if (stats.activeLowOps > peakRawLowCheckouts) peakRawLowCheckouts = stats.activeLowOps;
      await client.query(`SELECT ${idx}`);
      return idx;
    })
  );

  const highTask = (async () => {
    await new Promise((r) => setTimeout(r, 10));
    return withTransaction(controller.highPriorityPool, async (client) => {
      assert.ok(controller.getStats().activeHighOps >= 1);
      await client.query('SELECT 999');
      return 'high-done';
    });
  })();

  const [lowResults, highResult] = await Promise.all([Promise.all(lowTasks), highTask]);
  assert.equal(lowResults.length, 10);
  assert.equal(highResult, 'high-done');
  assert.ok(peakRawLowCheckouts <= 2, `U14: Low-priority .connect() concurrency exceeded cap: ${peakRawLowCheckouts}`);
  assert.ok(observedLowConcurrency.every((n) => n <= 2));
  assert.equal(rawActiveCheckouts, 0, 'U14: All pooled clients released cleanly');
});

// ============================================================================
// U15: Permanent customer deletion leaves zero cleartext email in customers, orders, or audit_events
// ============================================================================
test('U15: permanentDeleteCustomer hashes email fingerprint in audit_events and leaves zero cleartext email PII in database', async () => {
  const { pool } = shared;
  const rawEmail = 'privacy.delete.u15@gaeru-vip.example';
  const cust = (
    await pool.query(
      `INSERT INTO customers(email, full_name, phone, active)
       VALUES ($1, 'Nguyễn Bảo Mật U15', '0915888999', false)
       RETURNING id`,
      [rawEmail]
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
     VALUES ('GR-U15-PRIVACY', $1, 'Nguyễn Bảo Mật U15', $2, '0915888999', '99 Nguyễn Chí Thanh', 'Hà Nội', 'cod', 'paid', 'completed', 150000, 150000)`,
    [cust.id, rawEmail]
  );

  await permanentDeleteCustomer(
    pool,
    cust.id,
    { id: null, username: 'u22-owner', role: 'owner' },
    'Khách yêu cầu xóa dữ liệu cá nhân theo Nghị định 13/2023/NĐ-CP'
  );

  const custLeft = (await pool.query('SELECT COUNT(*)::int AS cnt FROM customers WHERE email = $1', [rawEmail])).rows[0].cnt;
  const orderLeft = (await pool.query('SELECT COUNT(*)::int AS cnt FROM orders WHERE email = $1', [rawEmail])).rows[0].cnt;
  const auditRows = (
    await pool.query(`SELECT before_state, after_state, metadata FROM audit_events WHERE entity_id = $1`, [cust.id])
  ).rows;

  assert.equal(custLeft, 0);
  assert.equal(orderLeft, 0);
  assert.ok(auditRows.length >= 1);
  const serializedAudit = JSON.stringify(auditRows);
  assert.ok(!serializedAudit.includes(rawEmail), 'U15: Cleartext email MUST NOT appear anywhere in audit_events');
  assert.match(serializedAudit, /sha256:[0-9a-f]{64}/, 'U15: Audit event records irreversible SHA-256 emailFingerprint');
});

// ============================================================================
// U16: Webhook payload deep secret redaction, PII masking & >= 90-day retention purge
// ============================================================================
test('U16: Carrier webhook redacts nested secrets and masks PII before storage while enforcing >= 90-day retention purge', async () => {
  const { pool, config, webhookSecret } = shared;
  const sanitized = sanitizeWebhookPayload({
    TOKEN: 'eyJhbGciOiJIUzI1NiJ9.super-secret-jwt',
    RECEIVER_PHONE: '0987654321',
    RECEIVER_EMAIL: 'khach.vip@gmail.com',
    RECEIVER_FULLNAME: 'Trần Văn Khách',
    NOTE: 'Giao gấp gọi 0912345678 hoặc mail support.khach@domain.vn nhé',
    nested: {
      auth: {
        webhookSecret: 'top-secret-hmac',
        apiKey: 'secret-api-key-123'
      }
    }
  });
  assert.equal(sanitized.TOKEN, '[REDACTED_SECRET]');
  assert.equal(sanitized.nested.auth.webhookSecret, '[REDACTED_SECRET]');
  assert.equal(sanitized.nested.auth.apiKey, '[REDACTED_SECRET]');
  assert.ok(!JSON.stringify(sanitized).includes('0987654321'));
  assert.ok(!JSON.stringify(sanitized).includes('khach.vip@gmail.com'));
  assert.ok(!JSON.stringify(sanitized).includes('0912345678'));
  assert.ok(!JSON.stringify(sanitized).includes('support.khach@domain.vn'));

  const order = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-U16-WH', 'Khách U16', 'u16@example.invalid', '0916000016', '16 Hai Bà Trưng', 'Hà Nội', 'cod', 'pending', 'shipped', 175000, 175000)
       RETURNING id`
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status)
     VALUES ($1, 'viettel', 'VTP-U16-WH1', 'created', 175000, 'unsettled')`,
    [order.id]
  );

  await handleCarrierWebhook(
    pool,
    config,
    'viettel',
    {
      DATA: {
        ORDER_NUMBER: 'VTP-U16-WH1',
        ORDER_STATUS: 200,
        NOTE: 'Bưu tá liên hệ khách 0916000016 email u16.real@gmail.com',
        TOKEN: 'carrier-inline-secret-token'
      }
    },
    { headers: { 'x-webhook-secret': webhookSecret } }
  );

  const savedWh = (
    await pool.query(`SELECT raw_payload FROM carrier_webhook_events WHERE tracking_number = 'VTP-U16-WH1' LIMIT 1`)
  ).rows[0];
  const savedStr = JSON.stringify(savedWh.raw_payload);
  assert.ok(!savedStr.includes('carrier-inline-secret-token'));
  assert.ok(!savedStr.includes('0916000016'));
  assert.ok(!savedStr.includes('u16.real@gmail.com'));

  await assert.rejects(
    () => pool.query(`DELETE FROM carrier_webhook_events WHERE tracking_number = 'VTP-U16-WH1'`),
    /immutable|append-only/i
  );

  await assert.rejects(() => purgeExpiredCarrierWebhookEvents(pool, { retentionDays: 30 }), (err) => err.status === 400);

  await pool.query(
    `INSERT INTO carrier_webhook_events(carrier_id, tracking_number, event_fingerprint, normalized_status, raw_status, raw_payload, applied, received_at)
     VALUES ('viettel', 'VTP-U16-OLD', 'u16-old-event-120d', 'delivering', '200', '{"ok":true}'::jsonb, true, now() - interval '120 days')`
  );
  const purgeRes = await purgeExpiredCarrierWebhookEvents(pool, { retentionDays: 90 });
  assert.equal(purgeRes.purgedCount, 1);

  const recentStillExists = (
    await pool.query(`SELECT COUNT(*)::int AS cnt FROM carrier_webhook_events WHERE tracking_number = 'VTP-U16-WH1'`)
  ).rows[0].cnt;
  assert.equal(recentStillExists, 1, 'U16: Recent webhook events (< 90 days) must remain protected');
});

// ============================================================================
// U17: Two Flash Sale groups (early boundary vs later boundary) expire Group A HTML on time
// ============================================================================
test('U17: Loading Variant Group B (later Flash Sale) never overwrites Variant Group A earlier boundary, expiring Group A HTML on time', async (t) => {
  const { pool } = await createPglitePool();
  t.after(() => pool.end());
  attachTransactionalCacheInvalidation(pool);
  flushAllCache();

  const pA = (
    await pool.query(
      `INSERT INTO products(slug, name, category, descriptor, description, card_summary, image_url, active)
       VALUES ('gaeru-u17-group-a', 'GAERU Group A', 'audio', 'Mic A', 'Desc A', 'Sum A', '/assets/products/k9.webp', true)
       RETURNING id`
    )
  ).rows[0];
  const vA = (
    await pool.query(
      `INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'U17-A', 'Type-C', 300000, 10, true)
       RETURNING id, price_vnd AS "priceVnd"`,
      [pA.id]
    )
  ).rows[0];

  const pB = (
    await pool.query(
      `INSERT INTO products(slug, name, category, descriptor, description, card_summary, image_url, active)
       VALUES ('gaeru-u17-group-b', 'GAERU Group B', 'audio', 'Mic B', 'Desc B', 'Sum B', '/assets/products/p01.webp', true)
       RETURNING id`
    )
  ).rows[0];
  const vB = (
    await pool.query(
      `INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'U17-B', 'Lightning', 500000, 10, true)
       RETURNING id, price_vnd AS "priceVnd"`,
      [pB.id]
    )
  ).rows[0];

  const boundaryAMs = Date.now() + 900;
  const boundaryBMs = Date.now() + 20000;

  const promoA = (
    await pool.query(
      `INSERT INTO product_promotions(title, type, kind, amount, starts_at, ends_at, active)
       VALUES ('Flash A', 'flash', 'fixed', 60000, now() - interval '2 minutes', $1, true) RETURNING id`,
      [new Date(boundaryAMs).toISOString()]
    )
  ).rows[0];
  await pool.query('INSERT INTO product_promotion_variants(promotion_id, variant_id) VALUES ($1, $2)', [promoA.id, vA.id]);

  const promoB = (
    await pool.query(
      `INSERT INTO product_promotions(title, type, kind, amount, starts_at, ends_at, active)
       VALUES ('Flash B', 'flash', 'fixed', 100000, now() - interval '2 minutes', $1, true) RETURNING id`,
      [new Date(boundaryBMs).toISOString()]
    )
  ).rows[0];
  await pool.query('INSERT INTO product_promotion_variants(promotion_id, variant_id) VALUES ($1, $2)', [promoB.id, vB.id]);

  const app = express();
  app.use(smartPageCache(60000));
  app.use(createSeoPages(pool, 'https://gaeru.com'));
  const srv = app.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => new Promise((r) => srv.close(r)));
  const urlA = `http://127.0.0.1:${srv.address().port}/product.html?id=gaeru-u17-group-a`;

  const htmlDuring = await (await fetch(urlA)).text();
  assert.match(htmlDuring, /240\.000\s*₫/);

  await applyPromotions(pool, [vB]);
  assert.ok(
    Math.abs(getNextPromotionBoundary() - boundaryAMs) <= 50,
    `U17: Global boundary (${getNextPromotionBoundary()}) must remain at Group A's earlier boundary (${boundaryAMs})`
  );

  await new Promise((r) => setTimeout(r, 1050));
  const htmlAfter = await (await fetch(urlA)).text();
  assert.match(htmlAfter, /300\.000\s*₫/, 'U17: Group A page must expire right at Group A boundary without waiting 20s for Group B');
});

// ============================================================================
// U18: 100 cold GET image misses while warm-up runs: zero GET encodes & bounded row cache bytes / RSS
// ============================================================================
test('U18: 100 cold GET image misses while background warm-up runs perform zero GET encodes and enforce row-cache byte cap + RSS guard', async (t) => {
  resetRenditionCache();
  resetImageRenditionStats();

  const pngBytes = await sharp({
    create: { width: 500, height: 360, channels: 4, background: { r: 30, g: 120, b: 200, alpha: 1 } }
  }).png().toBuffer();

  const fakePool = { __gaeruCacheHooked: true };
  clearImageLookupCache(fakePool);

  enqueueImageWarm({ content: pngBytes, mime_type: 'image/png' }, pngBytes);

  const app = express();
  app.get('/img/:id', async (req, res, next) => {
    try {
      const row = await getCachedImageRow(fakePool, req.params.id, async () => ({
        content: Buffer.concat([pngBytes, Buffer.from(req.params.id)]),
        mime_type: 'image/png'
      }));
      await sendPublicImage(req, res, row, 'u18');
    } catch (e) {
      next(e);
    }
  });
  const srv = app.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => new Promise((r) => srv.close(r)));
  const imgBase = `http://127.0.0.1:${srv.address().port}`;

  const responses = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      fetch(`${imgBase}/img/cold-${i}?w=480`, { headers: { Accept: 'image/avif,image/webp,*/*' } })
    )
  );
  for (const r of responses) {
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
  }

  const twoMb = Buffer.alloc(2 * 1024 * 1024, 7);
  for (let i = 0; i < 15; i++) {
    await getCachedImageRow(fakePool, `heavy-${i}`, async () => ({ content: twoMb, mime_type: 'image/webp' }));
  }

  const stats = getImageRenditionStats(fakePool);
  assert.equal(stats.getRuntimeEncodeCount, 0, 'U18: Zero runtime Sharp/AVIF encodes on GET');
  assert.ok(stats.rowCacheBytes <= MAX_ROW_CACHE_BYTES, `U18: Row cache bytes (${stats.rowCacheBytes}) must stay <= ${MAX_ROW_CACHE_BYTES}`);

  const prevMaxRss = process.env.MAX_IMAGE_WARM_RSS_BYTES;
  process.env.MAX_IMAGE_WARM_RSS_BYTES = '1024';
  try {
    enqueueImageWarm({ content: pngBytes, mime_type: 'image/png' }, pngBytes);
    assert.ok(getImageRenditionStats(fakePool).skippedWarmByRssCount >= 1, 'U18: Warm-up must shed load when RSS exceeds budget');
  } finally {
    if (prevMaxRss === undefined) delete process.env.MAX_IMAGE_WARM_RSS_BYTES;
    else process.env.MAX_IMAGE_WARM_RSS_BYTES = prevMaxRss;
  }
});

// ============================================================================
// U19: Migration on DB snapshot with 250 historical shipments completes fast within SLA
// ============================================================================
test('U19: migrateDatabase with lockTimeoutMs on snapshot of 250 historical carrier_shipments completes within SLA', async (t) => {
  const { pool } = await createPglitePool({ skipLatestReconciliationMigration: true });
  t.after(() => pool.end());

  await pool.query(`
    INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
    SELECT 'GR-U19-' || g, 'Khách ' || g, 'u19_' || g || '@example.invalid', '0919000111', 'Số ' || g || ' Phố Huế', 'Hà Nội',
           'cod', CASE WHEN g % 2 = 0 THEN 'paid' ELSE 'pending' END, 'completed', 200000, 200000
    FROM generate_series(1, 250) AS g
  `);
  await pool.query(`
    INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status, cod_settlement_ref)
    SELECT o.id, 'viettel', 'VTP-U19-' || o.order_number, 'delivered', 200000,
           CASE WHEN o.payment_status = 'paid' THEN 'settled' ELSE 'unsettled' END,
           CASE WHEN o.order_number LIKE '%0' THEN 'VCB-REF-' || o.order_number ELSE NULL END
    FROM orders o
    WHERE o.order_number LIKE 'GR-U19-%'
  `);

  await pool.query("DELETE FROM schema_migrations WHERE name = 'audit-reconciliation-v2-20261107.sql'");
  const started = Date.now();
  const mig = await migrateDatabase(pool, { lockTimeoutMs: 5000 });
  const elapsed = Date.now() - started;

  assert.equal(mig.appliedCount, 1);
  assert.equal(mig.timings[0].name, 'audit-reconciliation-v2-20261107.sql');
  assert.ok(elapsed < 3000, `U19: Migration over 250 shipments took ${elapsed}ms (must be < 3000ms SLA)`);

  const counts = (
    await pool.query(`
      SELECT cod_settlement_status, COUNT(*)::int AS cnt
      FROM carrier_shipments
      WHERE tracking_number LIKE 'VTP-U19-%'
      GROUP BY cod_settlement_status
    `)
  ).rows;
  const byStatus = Object.fromEntries(counts.map((r) => [r.cod_settlement_status, r.cnt]));
  assert.equal(byStatus.unsettled, 125);
  assert.equal(byStatus.settled, 25);
  assert.equal(byStatus.verification_required, 100);
});

// ============================================================================
// U20: Checkout across COD, Bank Transfer, VNPAY, MoMo & ZaloPay preserves stock, receipts & outbox
// ============================================================================
test('U20: Checkout across COD, Bank Transfer, VNPAY, MoMo and ZaloPay preserves inventory, payment_attempts, receipts and email outbox', async () => {
  const { pool, base, momoSettings } = shared;
  const prod = (
    await pool.query(
      `INSERT INTO products(slug, name, category, image_url, active)
       VALUES ('gaeru-u20-checkout', 'GAERU U20 Pro', 'audio', '/assets/products/k9.webp', true)
       RETURNING id`
    )
  ).rows[0];
  const variant = (
    await pool.query(
      `INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'U20-PRO-SKU', 'USB-C', 220000, 20, true)
       RETURNING id`,
      [prod.id]
    )
  ).rows[0];
  const mainWh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN' LIMIT 1")).rows[0];
  await pool.query(
    `INSERT INTO warehouse_stock(warehouse_id, variant_id, quantity)
     VALUES ($1, $2, 20)
     ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = 20`,
    [mainWh.id, variant.id]
  );

  let guestCookie = '';
  let guestCsrf = '';
  async function guestApi(urlPath, method = 'GET', body) {
    const res = await fetch(base + urlPath, {
      method,
      headers: {
        Cookie: guestCookie,
        'X-CSRF-Token': guestCsrf,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.get('set-cookie');
    if (sc) guestCookie = sc.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (data.csrfToken) guestCsrf = data.csrfToken;
    return { status: res.status, data };
  }
  await guestApi('/api/csrf');

  const createdOrders = {};
  const methods = ['cod', 'bank_transfer', 'vnpay', 'momo', 'zalopay'];
  for (let idx = 0; idx < methods.length; idx++) {
    const method = methods[idx];
    const r = await guestApi('/api/orders', 'POST', {
      customer: {
        name: `Khách U20 ${method}`,
        email: `u20.${method}@example.com`,
        phone: `092011122${idx + 1}`,
        address: '20 Nguyễn Trãi, Thanh Xuân',
        city: 'Hà Nội',
        note: ''
      },
      shippingCarrierId: 'viettel',
      paymentMethod: method,
      items: [{ variantId: variant.id, quantity: 1 }]
    });
    assert.equal(r.status, 201, `U20 checkout failed for ${method}: ${JSON.stringify(r.data)}`);
    createdOrders[method] = r.data;
  }

  assert.match(createdOrders.vnpay.paymentUrl, /vnpayment\.vn/);
  assert.match(createdOrders.momo.paymentUrl, /momo\.vn/);
  assert.match(createdOrders.zalopay.paymentUrl, /zalopay\.vn/);

  const stockAfter = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0].stock_quantity;
  assert.equal(stockAfter, 15, 'U20: 5 orders across 5 payment methods reserved exact 5 units');

  const momoOrder = createdOrders.momo.order;
  const momoAttempt = (await pool.query('SELECT provider_request_id FROM payment_attempts WHERE order_id = $1', [momoOrder.id])).rows[0];
  const momoReqBody = shared.providerCalls.filter((c) => c.provider === 'momo').at(-1).body;
  const ipn = {
    partnerCode: momoSettings.partnerCode,
    orderId: momoOrder.orderNumber,
    amount: momoOrder.totalVnd,
    resultCode: 0,
    transId: 9088877766,
    extraData: '',
    message: 'Successful.',
    orderInfo: momoReqBody.orderInfo,
    orderType: 'momo_wallet',
    payType: 'qr',
    requestId: momoAttempt.provider_request_id,
    responseTime: 1793155200000
  };
  const sigRaw = `accessKey=${momoSettings.accessKey}&amount=${ipn.amount}&extraData=${ipn.extraData}&message=${ipn.message}&orderId=${ipn.orderId}&orderInfo=${ipn.orderInfo}&orderType=${ipn.orderType}&partnerCode=${ipn.partnerCode}&payType=${ipn.payType}&requestId=${ipn.requestId}&responseTime=${ipn.responseTime}&resultCode=${ipn.resultCode}&transId=${ipn.transId}`;
  ipn.signature = crypto.createHmac('sha256', momoSettings.secretKey).update(sigRaw).digest('hex');

  const ipnRes = await fetch(`${base}/api/payments/momo/ipn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ipn)
  });
  assert.equal(ipnRes.status, 204);
  assert.equal(await receiptTotal(pool, momoOrder.id), momoOrder.totalVnd);

  const outboxCnt = (await pool.query('SELECT COUNT(*)::int AS cnt FROM order_email_outbox WHERE order_id = $1', [createdOrders.cod.order.id])).rows[0].cnt;
  assert.ok(outboxCnt >= 1, 'U20: Order confirmation email queued in order_email_outbox');
});

// ============================================================================
// U21: 4-step order workflow, Viettel "Đơn hàng đã hủy!" scenario & multi-warehouse return restock
// ============================================================================
test('U21: 4-step workflow, Viettel "Đơn hàng đã hủy!" idempotent cancel + delete, and multi-warehouse return restock preserve exact stock', async () => {
  const { pool, config, adminApi } = shared;

  const southWh = (
    await pool.query(
      `INSERT INTO warehouses(code, name, address, active)
       VALUES ('SOUTH_U21', 'Kho TP.HCM U21', 'Quận 7, TP.HCM', true)
       RETURNING id`
    )
  ).rows[0];
  const mainWh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN' LIMIT 1")).rows[0];

  const prod = (
    await pool.query(
      `INSERT INTO products(slug, name, category, image_url, active)
       VALUES ('gaeru-u21-multiwh', 'GAERU U21 MultiWH', 'audio', '/assets/products/k9.webp', true)
       RETURNING id`
    )
  ).rows[0];
  const variant = (
    await pool.query(
      `INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'U21-MWH-SKU', 'Dual Mic', 202300, 5, true)
       RETURNING id`,
      [prod.id]
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO warehouse_stock(warehouse_id, variant_id, quantity) VALUES ($1, $3, 2), ($2, $3, 3)`,
    [mainWh.id, southWh.id, variant.id]
  );

  const mwhOrder = (
    await pool.query(
      `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
       VALUES ('GR-U21-MULTIWH', 'Đỗ Thiện', 'u21@example.invalid', '0358888536', 'Xã Tả Lèng', 'Lai Châu', 'cod', 'pending', 'pending', 809200, 809200)
       RETURNING id`
    )
  ).rows[0];
  await pool.query(
    `INSERT INTO order_items(order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES ($1, $2, 'GAERU U21 MultiWH', 'Dual Mic', 'U21-MWH-SKU', 202300, 4, 809200)`,
    [mwhOrder.id, variant.id]
  );
  await withTransaction(pool, (client) =>
    inventory.reserveStock(client, { variantId: variant.id, quantity: 4, orderId: mwhOrder.id, actor: { username: 'u22-owner' } })
  );

  const allocCount = (await pool.query('SELECT COUNT(*)::int AS cnt FROM order_stock_allocations WHERE order_id = $1', [mwhOrder.id])).rows[0].cnt;
  assert.equal(allocCount, 2, 'U21: Order split across 2 warehouses');
  assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0].stock_quantity, 1);

  const stepProcessing = await adminApi(`/api/gaeru_ceo/orders/${mwhOrder.id}`, 'PATCH', {
    status: 'processing',
    paymentStatus: 'pending',
    shippingFeeVnd: 0
  });
  assert.equal(stepProcessing.status, 200);
  assert.equal(stepProcessing.data.order.status, 'processing');

  await createWaybill(pool, config, {
    orderId: mwhOrder.id,
    carrierId: 'viettel',
    actor: { username: 'u22-owner', role: 'owner' },
    fetcher: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 200, error: false, data: { ORDER_NUMBER: '156668075672', MONEY_TOTAL: 31000 } })
    })
  });

  const cancelRes = await cancelWaybill(pool, config, {
    orderId: mwhOrder.id,
    actor: { username: 'u22-owner', role: 'owner' },
    fetcher: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 200, error: true, message: 'Đơn hàng đã hủy!' })
    })
  });
  assert.equal(cancelRes.success, true, 'U21: "Đơn hàng đã hủy!" from Viettel Post must reconcile cleanly as cancelled');

  const deletedOrder = await withTransaction(pool, (client) =>
    deleteOrderPermanently(client, mwhOrder.id, {
      actor: { username: 'u22-owner', role: 'owner' },
      inventory
    })
  );
  assert.equal(deletedOrder?.id, mwhOrder.id);

  const restoredMain = (await pool.query('SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2', [mainWh.id, variant.id])).rows[0].quantity;
  const restoredSouth = (await pool.query('SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2', [southWh.id, variant.id])).rows[0].quantity;
  const restoredAgg = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0].stock_quantity;
  assert.equal(restoredMain, 2, 'U21: Exact 2 units restored to MAIN warehouse');
  assert.equal(restoredSouth, 3, 'U21: Exact 3 units restored to SOUTH warehouse');
  assert.equal(restoredAgg, 5, 'U21: Aggregate stock restored to 5 with zero drift');
});

// ============================================================================
// U22: Hostinger reload/restart with active SSE stream + background workers + Readiness Gate
// ============================================================================
test('U22: Readiness Gate holds traffic with 503 Retry-After during startup and SSE + workers drain cleanly on reload', async () => {
  const gateApp = express();
  gateApp.use(readinessMiddleware);
  gateApp.get('/api/products', (_req, res) => res.status(200).json({ ready: true }));

  setReady(false);
  const srv = gateApp.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const gateBase = `http://127.0.0.1:${srv.address().port}`;

  try {
    const healthDuringInit = await fetch(`${gateBase}/healthz`);
    assert.equal(healthDuringInit.status, 200, 'U22: Hostinger watchdog /healthz stays 200 during migration');

    const gatedReq = await fetch(`${gateBase}/api/products`);
    assert.equal(gatedReq.status, 503, 'U22: Business traffic receives 503 while initializing');
    assert.ok(gatedReq.headers.get('retry-after'), 'U22: 503 includes Retry-After header');

    setReady(true);
    const liveReq = await fetch(`${gateBase}/api/products`);
    assert.equal(liveReq.status, 200);
  } finally {
    setReady(true);
    await new Promise((r) => srv.close(r));
  }

  const ac = new AbortController();
  const sseRes = await fetch(`${shared.base}/api/realtime`, { signal: ac.signal });
  assert.equal(sseRes.status, 200);
  assert.match(sseRes.headers.get('content-type') || '', /text\/event-stream/);
  ac.abort();

  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const procEvents = new EventEmitter();
  let stoppedWorkers = 0;
  let closedPool = 0;
  const mockServer = new EventEmitter();
  mockServer.close = (cb) => cb();
  const mockModules = {
    dotenv: { config() {} },
    'express-session': {},
    'connect-pg-simple': () => class { async close() {} },
    './config': { loadConfig: () => ({ PORT: 3000 }) },
    './db': {
      createPool: () => ({
        on() {},
        query: async () => ({ rows: [] }),
        connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
        end: async () => { closedPool++; }
      }),
      inspectDatabaseTls: async () => ({}),
      createPriorityPoolController
    },
    './app': { createApp: () => ({ listen(_p, _h, cb) { queueMicrotask(cb); return mockServer; } }) },
    './migrate': { migrateDatabase: async () => ({ appliedCount: 0, timings: [] }) },
    './lib/readiness-gate': require('../src/lib/readiness-gate'),
    'node:perf_hooks': require('node:perf_hooks'),
    './lib/filesystem-media': { probe: async () => ({ verified: true }) },
    './lib/cache-warmup': { warmUpCache: async () => {} },
    './persistent-assets': { syncAssets: async () => ({}) },
    './media-storage-audit': {
      runLocalMediaAudit: async () => ({ localization: {}, audit: { state: 'verified' } }),
      auditMediaStorage: async () => ({ state: 'verified' })
    }
  };
  for (const [m, fn] of Object.entries({
    './shopping-chat-file-retention': 'startChatFileRetentionWorker',
    './tiktok-ads': 'startTikTokAdsWorker',
    './shopping-chat-ai-first': 'startAIChatWorker',
    './shopping-chat-compression': 'startChatCompressionWorker',
    './shopping-chat-email': 'startChatEmailWorker',
    './order-email': 'startOrderEmailWorker',
    './warranty-email': 'startWarrantyEmailWorker',
    './care-api': 'startCareEmailWorker',
    './email-marketing': 'startEmailWorker',
    './abandoned-cart': 'startAbandonedCartWorker',
    './account-retention': 'startRetentionWorker'
  })) {
    mockModules[m] = { [fn]: () => () => { stoppedWorkers++; } };
  }
  vm.runInNewContext(serverSrc, {
    require: (name) => mockModules[name],
    console: { log() {}, error() {} },
    process: { env: { NODE_ENV: 'test' }, on: procEvents.on.bind(procEvents), exitCode: 0 }
  });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  procEvents.emit('SIGTERM');
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  setReady(true);

  assert.equal(stoppedWorkers, 11, 'U22: All 11 background workers stopped cleanly on SIGTERM reload');
  assert.equal(closedPool, 1, 'U22: DB pool closed cleanly after draining in-flight tasks');
});
