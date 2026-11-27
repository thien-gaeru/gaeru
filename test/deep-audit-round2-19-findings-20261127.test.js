'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.resolve(__dirname, '..');
const { migrateDatabase } = require('../src/migrate');

async function createPglitePool() {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const prev = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await prev;
    return release;
  }
  async function rawQuery(sql, values) {
    const res = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...res, rows: res?.rows || [], rowCount: res?.affectedRows ?? res?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try { return await rawQuery(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      let released = false;
      return {
        query: (sql, values) => rawQuery(sql, values),
        release: () => { if (!released) { released = true; release(); } }
      };
    },
    end: () => db.close()
  };
  await migrateDatabase(pool);
  return { db, pool };
}

async function seedProduct(pool, { name = 'GAERU K9', sku, priceVnd = 500000, stock = 20, active = true, variantActive = true, deletedAt = null } = {}) {
  const productId = randomUUID();
  const variantId = randomUUID();
  const realSku = sku || ('SKU-' + variantId.slice(0, 8).toUpperCase());
  const whMain = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN' LIMIT 1")).rows[0]?.id;
  await pool.query(
    `INSERT INTO products (id, slug, name, category, active, deleted_at)
     VALUES ($1, $2, $3, 'audio', $4, $5)`,
    [productId, 'gaeru-' + productId.slice(0, 8), name, active, deletedAt]
  );
  await pool.query(
    `INSERT INTO product_variants (id, product_id, sku, name, price_vnd, cost_price_vnd, stock_quantity, active)
     VALUES ($1, $2, $3, 'Standard', $4, 300000, $5, $6)`,
    [variantId, productId, realSku, priceVnd, stock, variantActive]
  );
  if (whMain) {
    await pool.query(
      `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
       VALUES ($1, $2, $3) ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [whMain, variantId, stock]
    );
  }
  return { productId, variantId, sku: realSku, whMain };
}

async function startRouter(mountPath, router, { sessionData = {}, adminUser = null } = {}) {
  const app = express();
  app.use(express.json());
  const activeSession = { csrfToken: 'test-csrf-token', ...sessionData };
  app.use((req, _res, next) => {
    req.session = activeSession;
    req.session.regenerate = (cb) => cb(null);
    req.session.save = (cb) => cb(null);
    if (adminUser) req.admin = adminUser;
    next();
  });
  app.use(mountPath, router);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'Internal error' });
  });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return {
    base,
    session: activeSession,
    async req(urlPath, method = 'GET', body = undefined) {
      const r = await fetch(base + urlPath, {
        method,
        headers: {
          'X-CSRF-Token': activeSession.csrfToken || 'test-csrf-token',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const data = await r.json().catch(() => ({}));
      return { status: r.status, data };
    },
    close: () => new Promise((r) => srv.close(r))
  };
}

test('Deep Audit Round 2 (19 findings #01-#19) — full PGlite & script verification', { timeout: 120000 }, async (t) => {
  const { db, pool } = await createPglitePool();
  t.after(async () => { await db.close(); });

  const ownerAdmin = {
    id: randomUUID(),
    username: 'owner',
    role: 'owner',
    source: 'bootstrap',
    permissions: [
      'dashboard.read', 'orders.read', 'orders.write', 'payments.write',
      'inventory.read', 'inventory.write', 'inventory.approve',
      'purchases.read', 'purchases.write', 'purchases.approve',
      'suppliers.read', 'suppliers.write', 'invoice.read', 'invoice.write',
      'marketplace.read', 'marketplace.write', 'customers.read', 'customers.write',
      'customers.permanent_delete', 'finance.read', 'warranty.read', 'chat.read'
    ]
  };

  // =========================================================================
  // #01 (BUNDLE-QUOTE-01): commerce.js reads bundleDiscountVnd; quote ignores inactive/deleted items
  // =========================================================================
  await t.test('#01 BUNDLE-QUOTE-01: bundle quote field alignment & inactive/deleted variant filtering', async () => {
    const commerceSrc = fs.readFileSync(path.join(ROOT, 'commerce.js'), 'utf8');
    const matches = commerceSrc.match(/bundleDiscountVnd \?\? q\?\.totalBundleDiscountVnd/g) || [];
    assert.equal(matches.length, 2, 'commerce.js must read bundleDiscountVnd on both cart and checkout');

    const p1 = await seedProduct(pool, { name: 'K9 Primary', priceVnd: 1000000 });
    const p2 = await seedProduct(pool, { name: 'K9 Dock', priceVnd: 300000 });
    const pDeleted = await seedProduct(pool, { name: 'Deleted Accessory', priceVnd: 200000, deletedAt: new Date().toISOString() });

    const bundleId = randomUUID();
    await pool.query(
      `INSERT INTO product_bundles (id, title, discount_type, discount_value, starts_at, ends_at, active)
       VALUES ($1, 'Combo K9 + Dock', 'fixed', 100000, now() - interval '1 hour', now() + interval '1 day', true)`,
      [bundleId]
    );
    await pool.query(
      `INSERT INTO product_bundle_items (bundle_id, variant_id, is_primary, min_quantity) VALUES ($1, $2, true, 1), ($1, $3, false, 1)`,
      [bundleId, p1.variantId, p2.variantId]
    );

    const deadBundleId = randomUUID();
    await pool.query(
      `INSERT INTO product_bundles (id, title, discount_type, discount_value, starts_at, ends_at, active)
       VALUES ($1, 'Dead Combo', 'fixed', 50000, now() - interval '1 hour', now() + interval '1 day', true)`,
      [deadBundleId]
    );
    await pool.query(
      `INSERT INTO product_bundle_items (bundle_id, variant_id, is_primary, min_quantity) VALUES ($1, $2, true, 1), ($1, $3, false, 1)`,
      [deadBundleId, p1.variantId, pDeleted.variantId]
    );

    const { mountBundles, calculateCartBundleDiscount } = require('../src/product-bundles');
    const pubRouter = express.Router();
    mountBundles({ admin: express.Router(), publicRouter: pubRouter }, pool);
    const srv = await startRouter('/api', pubRouter);
    t.after(() => srv.close());

    const quoteRes = await srv.req('/api/bundles/quote', 'POST', {
      items: [{ variantId: p1.variantId, quantity: 1 }, { variantId: p2.variantId, quantity: 1 }]
    });
    assert.equal(quoteRes.status, 200);
    assert.equal(quoteRes.data.bundleDiscountVnd, 100000);
    assert.equal(quoteRes.data.finalSubtotalVnd, 1200000);

    // Passing a deleted variant must NOT trigger deadBundleId or leak 0-priced item
    const deletedQuote = await srv.req('/api/bundles/quote', 'POST', {
      items: [{ variantId: p1.variantId, quantity: 1 }, { variantId: pDeleted.variantId, quantity: 1 }]
    });
    assert.equal(deletedQuote.status, 200);
    assert.equal(deletedQuote.data.bundleDiscountVnd, 0);

    const directCalc = await calculateCartBundleDiscount(pool, [
      { variantId: p1.variantId, quantity: 1, priceVnd: 1000000 },
      { variantId: pDeleted.variantId, quantity: 1, priceVnd: 200000 }
    ]);
    assert.equal(directCalc.bundleDiscountVnd, 0);

    // Multi-secondary bundle with 1 soft-deleted secondary + 1 cheap active secondary (60k) & 120k fixed discount:
    // Must preserve [P0-05] anti-siphon cap at 60k (NOT let cheap cable siphon full 120k onto primary!)
    const pCable = await seedProduct(pool, { name: 'Cheap Cable', priceVnd: 60000 });
    const multiSecBundleId = randomUUID();
    await pool.query(
      `INSERT INTO product_bundles (id, title, discount_type, discount_value, starts_at, ends_at, active)
       VALUES ($1, 'Multi-Sec Anti-Siphon', 'fixed', 120000, now() - interval '1 hour', now() + interval '1 day', true)`,
      [multiSecBundleId]
    );
    await pool.query(
      `INSERT INTO product_bundle_items (bundle_id, variant_id, is_primary, min_quantity) VALUES ($1, $2, true, 1), ($1, $3, false, 1), ($1, $4, false, 1)`,
      [multiSecBundleId, p1.variantId, pDeleted.variantId, pCable.variantId]
    );
    const antiSiphonCalc = await calculateCartBundleDiscount(pool, [
      { variantId: p1.variantId, quantity: 1, priceVnd: 1000000 },
      { variantId: pCable.variantId, quantity: 1, priceVnd: 60000 }
    ]);
    assert.equal(antiSiphonCalc.bundleDiscountVnd, 60000, 'Multi-secondary bundle with deleted sibling must cap fixed discount at active secondaryTotal');
  });

  // =========================================================================
  // #02 (RMA-ANON-01) & #03 (CUST-DEL-GUARD-01): Anonymized RMA auth blocked & customer delete guard
  // =========================================================================
  await t.test('#02 RMA-ANON-01 & #03 CUST-DEL-GUARD-01: customer deletion blocks open MoMo refund/RMA and anonymized RMA rejects 0000000000', async () => {
    const custId = randomUUID();
    const orderId = randomUUID();
    const rmaId = randomUUID();
    const rmaToken = 'tok_' + randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '').slice(0, 16);
    await pool.query(
      `INSERT INTO customers (id, full_name, email, phone, password_hash)
       VALUES ($1, 'RMA Guard Customer', $2, '0912345678', $3)`,
      [custId, `rma-${custId.slice(0, 8)}@example.test`, bcrypt.hashSync('Secret123456', 4)]
    );
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_id, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method, payment_status)
       VALUES ($1, $2, $3, 'RMA Guard Customer', $4, '0912345678', '123 Test St', 'Hà Nội', 1000000, 0, 1000000, 'completed', 'momo', 'paid')`,
      [orderId, 'GA-RMA-' + orderId.slice(0, 6).toUpperCase(), custId, `rma-${custId.slice(0, 8)}@example.test`]
    );

    const { hasBlockingCustomerActivity, permanentDeleteCustomer } = require('../src/customer-lifecycle');
    const { withTransaction } = require('../src/db');

    // Case 1: Open momo_refunds (pending_provider) must block deletion (#03)
    const refundId = randomUUID();
    await pool.query(
      `INSERT INTO momo_refunds (id, order_id, order_number, original_trans_id, refund_order_id, request_id, amount_vnd, status, environment, created_by)
       VALUES ($1, $2, 'GA-RMA', 1234567890, $3, $4, 500000, 'pending_provider', 'sandbox', 'owner')`,
      [refundId, orderId, 'RF-' + refundId.slice(0, 8), randomUUID()]
    );
    const guardMomo = await withTransaction(pool, (c) => hasBlockingCustomerActivity(c, custId));
    assert.equal(guardMomo.blocked, true, 'pending_provider momo_refund must block customer deletion');
    await assert.rejects(() => permanentDeleteCustomer(pool, custId, ownerAdmin), /hoàn tiền MoMo|đổi trả/);

    // Resolve momo refund, open RMA ticket -> must still block (#03)
    await pool.query("UPDATE momo_refunds SET status = 'failed' WHERE id = $1", [refundId]);
    await pool.query(
      `INSERT INTO order_after_sales (id, order_id, rma_number, rma_token, kind, return_type, reason, status, requested_by)
       VALUES ($1, $2, 'RMA-261127-TEST', $3, 'return', 'exchange', 'Lỗi kỹ thuật', 'approved', 'customer')`,
      [rmaId, orderId, rmaToken]
    );
    const guardRma = await withTransaction(pool, (c) => hasBlockingCustomerActivity(c, custId));
    assert.equal(guardRma.blocked, true, 'open order_after_sales must block customer deletion');

    // Close RMA -> deletion now succeeds and anonymizes the order
    await pool.query("UPDATE order_after_sales SET status = 'resolved' WHERE id = $1", [rmaId]);
    const deleted = await permanentDeleteCustomer(pool, custId, ownerAdmin);
    assert.ok(deleted?.id === custId);

    // Reopen a historical anonymized order's RMA in DB to verify #02 defense-in-depth
    await pool.query("UPDATE order_after_sales SET status = 'approved' WHERE id = $1", [rmaId]);
    const { updateRmaInboundTracking, createRmaApi } = require('../src/rma-tickets');
    await assert.rejects(
      () => updateRmaInboundTracking(pool, {
        rmaNumber: 'RMA-261127-TEST',
        phone: '0000000000',
        inboundCarrier: 'ATTACKER',
        inboundTrackingNumber: 'HIJACK999'
      }),
      (err) => err.status === 403
    );

    const rmaSrv = await startRouter('/api', createRmaApi(pool, { NODE_ENV: 'test' }).publicApi);
    t.after(() => rmaSrv.close());
    const lookupAttack = await rmaSrv.req('/api/rma/RMA-261127-TEST?phone=0000000000');
    assert.equal(lookupAttack.status, 403, 'GET /api/rma must reject anonymized 0000000000 phone challenge');

    // Capability token still works legitimately
    const lookupToken = await rmaSrv.req('/api/rma/RMA-261127-TEST?token=' + encodeURIComponent(rmaToken));
    assert.equal(lookupToken.status, 200);
  });

  // =========================================================================
  // #04 (MOMO-LOYALTY-EARN-01): Pre-completion MoMo refunds subtract from Xu earn base
  // =========================================================================
  await t.test('#04 MOMO-LOYALTY-EARN-01: MoMo refund before completion subtracts from Xu accrual & blocks unsettled completion', async () => {
    const custId = randomUUID();
    await pool.query(
      `INSERT INTO customers (id, full_name, email, phone, password_hash)
       VALUES ($1, 'Loyalty MoMo User', $2, '0913334444', $3)`,
      [custId, `loy-${custId.slice(0, 8)}@example.test`, bcrypt.hashSync('Secret123456', 4)]
    );

    const { createOrderWorkflow } = require('../src/order-workflow');
    const workflow = createOrderWorkflow({ inventory: require('../src/inventory'), finance: require('../src/finance-api') });

    // Order A: 1,000,000 VND fully refunded (1,000,000) before completion -> must earn 0 Xu
    const ordFull = randomUUID();
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_id, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method, payment_status)
       VALUES ($1, 'GA-MOMO-FULL', $2, 'Loyalty MoMo User', 'loy@example.test', '0913334444', 'Addr', 'HCM', 1000000, 0, 1000000, 'shipped', 'momo', 'paid')`,
      [ordFull, custId]
    );
    await pool.query(
      `INSERT INTO momo_refunds (id, order_id, order_number, original_trans_id, refund_order_id, request_id, amount_vnd, status, environment, created_by)
       VALUES ($1, $2, 'GA-MOMO-FULL', 99887766, 'RF-FULL-1', $3, 1000000, 'succeeded', 'sandbox', 'owner')`,
      [randomUUID(), ordFull, randomUUID()]
    );
    await workflow.updateOrder(pool, ordFull, { status: 'completed' }, ownerAdmin);
    const balFull = (await pool.query('SELECT points_balance FROM customer_loyalty WHERE customer_id = $1', [custId])).rows[0];
    assert.equal(Number(balFull?.points_balance || 0), 0, 'Fully refunded MoMo order must award 0 Xu');

    // Order B: 1,000,000 VND partially refunded (400,000) before completion -> must earn 6,000 Xu (1% of 600,000)
    const ordPart = randomUUID();
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_id, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method, payment_status)
       VALUES ($1, 'GA-MOMO-PART', $2, 'Loyalty MoMo User', 'loy@example.test', '0913334444', 'Addr', 'HCM', 1000000, 0, 1000000, 'shipped', 'momo', 'paid')`,
      [ordPart, custId]
    );
    await pool.query(
      `INSERT INTO momo_refunds (id, order_id, order_number, original_trans_id, refund_order_id, request_id, amount_vnd, status, environment, created_by)
       VALUES ($1, $2, 'GA-MOMO-PART', 99887767, 'RF-PART-1', $3, 400000, 'succeeded', 'sandbox', 'owner')`,
      [randomUUID(), ordPart, randomUUID()]
    );
    await workflow.updateOrder(pool, ordPart, { status: 'completed' }, ownerAdmin);
    const balPart = (await pool.query('SELECT points_balance FROM customer_loyalty WHERE customer_id = $1', [custId])).rows[0];
    assert.equal(Number(balPart?.points_balance || 0), 6000, 'Partially refunded MoMo order must earn Xu only on net unrefunded amount');

    // Order C: unsettled MoMo refund blocks manual completion (409)
    const ordPend = randomUUID();
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_id, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method, payment_status)
       VALUES ($1, 'GA-MOMO-PEND', $2, 'Loyalty MoMo User', 'loy@example.test', '0913334444', 'Addr', 'HCM', 1000000, 0, 1000000, 'shipped', 'momo', 'paid')`,
      [ordPend, custId]
    );
    await pool.query(
      `INSERT INTO momo_refunds (id, order_id, order_number, original_trans_id, refund_order_id, request_id, amount_vnd, status, environment, created_by)
       VALUES ($1, $2, 'GA-MOMO-PEND', 99887768, 'RF-PEND-1', $3, 200000, 'pending_provider', 'sandbox', 'owner')`,
      [randomUUID(), ordPend, randomUUID()]
    );
    await assert.rejects(
      () => workflow.updateOrder(pool, ordPend, { status: 'completed' }, ownerAdmin),
      (err) => err.status === 409
    );
  });

  // =========================================================================
  // #05 (SHIP-COD-01) & #07 (SHIP-COD-LIST-01): createWaybill fee guard, confirmed_at, returned COD excluded
  // =========================================================================
  await t.test('#05 SHIP-COD-01 & #07 SHIP-COD-LIST-01: waybill null-fee guard, confirmed_at stamp & returned COD exclusion', async () => {
    const { createWaybill, listCodSettlements } = require('../src/shipping-management');
    const { dispatchByBarcode } = require('../src/barcode-api');

    const ordNullFee = randomUUID();
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method, payment_status)
       VALUES ($1, 'GA-COD-NULL', 'COD Buyer', 'cod@example.test', '0914445555', 'Addr', 'HCM', 500000, NULL, NULL, 'pending', 'cod', 'pending')`,
      [ordNullFee]
    );
    await assert.rejects(
      () => createWaybill(pool, {}, { orderId: ordNullFee, carrierId: 'viettel', actor: ownerAdmin }),
      (err) => err.status === 409 && /phí giao hàng/.test(err.message)
    );
    await assert.rejects(
      () => dispatchByBarcode(pool, { orderId: ordNullFee, actor: ownerAdmin }),
      (err) => err.status === 409 && /phí giao hàng/.test(err.message)
    );

    // Returned COD shipment must NOT appear in unsettled COD settlements (#07)
    const ordRet = randomUUID();
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method, payment_status)
       VALUES ($1, 'GA-COD-RET', 'COD Return Buyer', 'codr@example.test', '0914445556', 'Addr', 'HCM', 700000, 30000, 730000, 'shipped', 'cod', 'pending')`,
      [ordRet]
    );
    await pool.query(
      `INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, status, shipping_fee_vnd, cod_amount_vnd, cod_settlement_status)
       VALUES ($1, 'viettel', 'VTP-RET-001', 'returned', 30000, 730000, 'unsettled')`,
      [ordRet]
    );
    const settlements = await listCodSettlements(pool, { q: 'VTP-RET-001' });
    assert.equal(settlements.shipments.length, 0, 'Returned COD shipment must be excluded from COD settlements list');
    assert.equal(settlements.summary.unsettled.count, 0, 'Returned COD shipment must not inflate unsettled COD summary');

    // Returned COD shipment must also be blocked from owner pre-delivery COD settlement override
    const { settleCarrierCod } = require('../src/shipping-management');
    await assert.rejects(
      () => settleCarrierCod(pool, {
        orderId: ordRet,
        providerTransactionRef: 'STMT-RET-999',
        settledAmountVnd: 730000,
        evidenceRef: 'BANK-REF-001',
        allowPreDeliveryOverride: true,
        overrideReason: 'Thử nghiệm cưỡng bức đối soát đơn đã hoàn kho',
        actor: ownerAdmin
      }),
      (err) => err.status === 409 && /hoàn trả/.test(err.message)
    );

    // Check confirmed_at is set on dispatchByBarcode for pending order with finalized fee
    const pShip = await seedProduct(pool, { name: 'Ship Item', priceVnd: 400000, stock: 10 });
    const ordReady = randomUUID();
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method, payment_status, confirmed_at)
       VALUES ($1, 'GA-COD-READY', 'Ready Buyer', 'ready@example.test', '0914445557', 'Addr', 'HCM', 400000, 30000, 430000, 'pending', 'cod', 'pending', NULL)`,
      [ordReady]
    );
    await pool.query(
      `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
       VALUES ($1, $2, 'Ship Item', 'Standard', $3, 1, 400000, 400000)`,
      [ordReady, pShip.variantId, pShip.sku]
    );
    await pool.query(
      `INSERT INTO order_pack_verifications (order_id, status, total_items, scanned_items, items_checklist)
       VALUES ($1, 'verified', 1, 1, '[]'::jsonb)`,
      [ordReady]
    );
    await dispatchByBarcode(pool, { orderId: ordReady, actor: ownerAdmin });
    const dispatchedOrd = (await pool.query('SELECT status, confirmed_at FROM orders WHERE id = $1', [ordReady])).rows[0];
    assert.equal(dispatchedOrd.status, 'shipped');
    assert.ok(dispatchedOrd.confirmed_at !== null, 'dispatchByBarcode must set confirmed_at when advancing pending order');
  });

  // =========================================================================
  // #06 (CONTACT-CHANGE-01): Reject non-VN mobile phone & preserve phone_invalid_at on email-only change
  // =========================================================================
  await t.test('#06 CONTACT-CHANGE-01: contact-change enforces VN mobile and preserves phone_invalid_at', async () => {
    const custId = randomUUID();
    const password = 'Password-2026-Strong!';
    const oldCreated = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    const freshInvalid = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago (still 11h remaining!)
    await pool.query(
      `INSERT INTO customers (id, full_name, email, phone, password_hash, phone_invalid_at, created_at)
       VALUES ($1, 'Contact User', 'cc-old@example.test', '02438251234', $2, $3, $4)`,
      [custId, bcrypt.hashSync(password, 4), freshInvalid, oldCreated]
    );

    const sent = [];
    const { createContactChangeApi } = require('../src/contact-change-api');
    const router = createContactChangeApi(pool, {
      smtpConfig: { from: 'support@example.test', publicBaseUrl: 'https://gaeru.com' },
      mailer: { async sendMail(m) { sent.push(m); return { accepted: [m.to] }; } },
      config: { NODE_ENV: 'test' }
    });
    const srv = await startRouter('/api/customer-auth/contact-change', router, {
      sessionData: { customer: { id: custId } }
    });
    t.after(() => srv.close());

    // Changing to non-VN phone must be rejected with 400
    const badPhone = await srv.req('/api/customer-auth/contact-change/request', 'POST', {
      email: 'cc-old@example.test',
      phone: '02838259999',
      password
    });
    assert.equal(badPhone.status, 400);

    // Email-only change while keeping legacy non-VN phone must preserve phone_invalid_at (not clear to NULL!)
    const emailOnly = await srv.req('/api/customer-auth/contact-change/request', 'POST', {
      email: 'cc-new@example.test',
      phone: '02438251234',
      password
    });
    assert.equal(emailOnly.status, 200);
    assert.equal(sent.length, 2);
    const t1 = new URL(sent[0].text.match(/https:\/\/\S+/)[0]).searchParams.get('contactVerify');
    const t2 = new URL(sent[1].text.match(/https:\/\/\S+/)[0]).searchParams.get('contactVerify');
    assert.equal((await srv.req('/api/customer-auth/contact-change/complete', 'POST', { token: t1 })).status, 200);
    assert.equal((await srv.req('/api/customer-auth/contact-change/complete', 'POST', { token: t2 })).status, 200);

    const afterRow = (await pool.query('SELECT email, phone, phone_invalid_at, created_at FROM customers WHERE id = $1', [custId])).rows[0];
    assert.equal(afterRow.email, 'cc-new@example.test');
    assert.ok(afterRow.phone_invalid_at !== null, 'phone_invalid_at must NOT be cleared to NULL when phone is still invalid');
    const { checkCustomerPhoneStatus } = require('../src/customer-lifecycle');
    const statusAfter = checkCustomerPhoneStatus(afterRow);
    assert.equal(statusAfter.isExpired, false, 'Customer must NOT be immediately auto-locked after email-only change');
  });

  // =========================================================================
  // #08 (COD-RET-01) & #09 (COD-RET-02): Lookup deduplication, active waybill selection & legacy warehouse parity
  // =========================================================================
  await t.test('#08 COD-RET-01 & #09 COD-RET-02: COD lookup avoids Cartesian product/cancelled waybill & legacy restock hits selected warehouse', async () => {
    const pA = await seedProduct(pool, { name: 'Item A', priceVnd: 200000, stock: 10 });
    const pB = await seedProduct(pool, { name: 'Item B', priceVnd: 300000, stock: 10 });
    const branchWhId = randomUUID();
    await pool.query("INSERT INTO warehouses (id, code, name, active) VALUES ($1, 'HCM_BRANCH', 'Kho TP.HCM', true)", [branchWhId]);

    // Order with 2 items, 2 stock allocations, 1 cancelled shipment + 1 returned shipment
    const ordMulti = randomUUID();
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method, payment_status)
       VALUES ($1, 'GA-LOOKUP-1', 'Lookup Buyer', 'lk@example.test', '0915556666', 'Addr', 'HCM', 500000, 30000, 530000, 'shipped', 'cod', 'pending')`,
      [ordMulti]
    );
    await pool.query(
      `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
       VALUES ($1, $2, 'Item A', 'Std', $3, 1, 200000, 200000), ($1, $4, 'Item B', 'Std', $5, 1, 300000, 300000)`,
      [ordMulti, pA.variantId, pA.sku, pB.variantId, pB.sku]
    );
    await pool.query(
      `INSERT INTO order_stock_allocations (order_id, variant_id, warehouse_id, quantity)
       VALUES ($1, $2, $4, 1), ($1, $3, $4, 1)`,
      [ordMulti, pA.variantId, pB.variantId, pA.whMain]
    );
    await pool.query(
      `INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, status, shipping_fee_vnd, cod_amount_vnd, cod_settlement_status, created_at)
       VALUES ($1, 'viettel', 'VTP-OLD-CANC', 'cancelled', 30000, 530000, 'not_applicable', now() - interval '2 hours'),
              ($1, 'viettel', 'VTP-NEW-RET', 'returned', 30000, 530000, 'unsettled', now() - interval '1 hour')`,
      [ordMulti]
    );

    const { createCodReturnIntake } = require('../src/cod-return-intake');
    const srv = await startRouter('/api/gaeru_ceo', createCodReturnIntake(pool), { adminUser: ownerAdmin });
    t.after(() => srv.close());

    const lookupRes = await srv.req('/api/gaeru_ceo/cod-returns/lookup?q=GA-LOOKUP-1');
    assert.equal(lookupRes.status, 200);
    assert.equal(lookupRes.data.shipment.trackingNumber, 'VTP-NEW-RET', 'Must pick active/returned shipment, not cancelled');
    assert.equal(lookupRes.data.shipment.items.length, 2, 'Must NOT duplicate items via Cartesian product with allocations');

    // Legacy order (zero order_stock_allocations) returned intact into chosen HCM_BRANCH warehouse (#09)
    const pLegacy = await seedProduct(pool, { name: 'Legacy Item', priceVnd: 250000, stock: 5 });
    const ordLegacy = randomUUID();
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method, payment_status)
       VALUES ($1, 'GA-LEGACY-RET', 'Legacy Buyer', 'leg@example.test', '0915556667', 'Addr', 'HCM', 250000, 30000, 280000, 'shipped', 'cod', 'pending')`,
      [ordLegacy]
    );
    await pool.query(
      `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
       VALUES ($1, $2, 'Legacy Item', 'Std', $3, 2, 250000, 500000)`,
      [ordLegacy, pLegacy.variantId, pLegacy.sku]
    );
    await pool.query(
      `INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, status, shipping_fee_vnd, cod_amount_vnd, cod_settlement_status)
       VALUES ($1, 'viettel', 'VTP-LEGACY-01', 'returned', 30000, 280000, 'unsettled')`,
      [ordLegacy]
    );

    const intakeRes = await srv.req('/api/gaeru_ceo/cod-returns/intake', 'POST', {
      trackingNumber: 'VTP-LEGACY-01',
      packageCondition: 'intact',
      warehouseId: branchWhId
    });
    assert.equal(intakeRes.status, 200, JSON.stringify(intakeRes.data));
    const branchStock = (await pool.query('SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2', [branchWhId, pLegacy.variantId])).rows[0];
    const mainStock = (await pool.query('SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2', [pLegacy.whMain, pLegacy.variantId])).rows[0];
    assert.equal(Number(branchStock?.quantity || 0), 2, 'Legacy intact return must restock into selected warehouse');
    assert.equal(Number(mainStock?.quantity || 0), 5, 'MAIN warehouse stock must remain unchanged when another warehouse was chosen');
    const shipAfter = (await pool.query("SELECT cod_settlement_status FROM carrier_shipments WHERE tracking_number = 'VTP-LEGACY-01'")).rows[0];
    assert.equal(shipAfter.cod_settlement_status, 'not_applicable');
  });

  // =========================================================================
  // #10 (PROFILE-01): PATCH /api/customer/profile requires currentPassword, enforces 12h window, handles 23505
  // =========================================================================
  await t.test('#10 PROFILE-01: PATCH /profile requires password, enforces 12h expiry, and maps duplicate email to 409', async () => {
    const password = 'Profile-Password-2026!';
    const custId = randomUUID();
    const otherId = randomUUID();
    await pool.query(
      `INSERT INTO customers (id, full_name, email, phone, password_hash, phone_invalid_at, reg_email_failed_at)
       VALUES ($1, 'Profile Fixer', 'pfix@example.test', '0000000000', $2, now() - interval '1 hour', now() - interval '1 hour'),
              ($3, 'Existing Email', 'taken@example.test', '0917778888', $2, NULL, NULL)`,
      [custId, bcrypt.hashSync(password, 4), otherId]
    );

    const { createCustomerExperience } = require('../src/customer-experience');
    const srv = await startRouter('/api/customer', createCustomerExperience(pool), {
      sessionData: { customer: { id: custId } }
    });
    t.after(() => srv.close());

    // Missing password on password account -> 401
    const noPass = await srv.req('/api/customer/profile', 'PATCH', {
      fullName: 'Profile Fixer',
      phone: '0916667777'
    });
    assert.equal(noPass.status, 401);

    // Duplicate email with valid password -> 409 (not 500)
    const dupEmail = await srv.req('/api/customer/profile', 'PATCH', {
      fullName: 'Profile Fixer',
      email: 'taken@example.test',
      currentPassword: password
    });
    assert.equal(dupEmail.status, 409);

    // Expired (>12h) phone_invalid_at -> 403
    await pool.query("UPDATE customers SET phone_invalid_at = now() - interval '13 hours' WHERE id = $1", [custId]);
    const expiredPhone = await srv.req('/api/customer/profile', 'PATCH', {
      fullName: 'Profile Fixer',
      phone: '0916667777',
      currentPassword: password
    });
    assert.equal(expiredPhone.status, 403);

    // Within 12h + valid password -> 200
    await pool.query("UPDATE customers SET phone_invalid_at = now() - interval '1 hour' WHERE id = $1", [custId]);
    const okRes = await srv.req('/api/customer/profile', 'PATCH', {
      fullName: 'Profile Fixer',
      phone: '0916667777',
      currentPassword: password
    });
    assert.equal(okRes.status, 200);
    assert.equal(okRes.data.customer.phone, '0916667777');
  });

  // =========================================================================
  // #11 (BIZ-INV-01): Invoice drafting checks MoMo refund ledger
  // =========================================================================
  await t.test('#11 BIZ-INV-01: POST /business/invoice blocks fully/unsettled MoMo refunds and nets partial refunds', async () => {
    const { createBusinessApi } = require('../src/business-api');
    const srv = await startRouter('/api/gaeru_ceo', createBusinessApi(pool, {}), { adminUser: ownerAdmin });
    t.after(() => srv.close());

    const mkOrder = async (num, refundStatus, refundAmt) => {
      const oid = randomUUID();
      await pool.query(
        `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method, payment_status)
         VALUES ($1, $2, 'Inv Buyer', 'inv@example.test', '0918889999', 'Addr', 'HCM', 1000000, 0, 1000000, 'completed', 'momo', 'paid')`,
        [oid, num]
      );
      if (refundStatus) {
        await pool.query(
          `INSERT INTO momo_refunds (id, order_id, order_number, original_trans_id, refund_order_id, request_id, amount_vnd, status, environment, created_by)
           VALUES ($1, $2, $3, 776655, $4, $5, $6, $7, 'sandbox', 'owner')`,
          [randomUUID(), oid, num, 'RF-' + oid.slice(0, 8), randomUUID(), refundAmt, refundStatus]
        );
      }
      return oid;
    };

    const fullId = await mkOrder('GA-INV-FULL', 'succeeded', 1000000);
    const fullRes = await srv.req('/api/gaeru_ceo/business/invoice', 'POST', {
      requestKey: randomUUID(), period: '2026-11', orderId: fullId, buyerName: 'Buyer A', buyerTaxCode: '0101234567', buyerAddress: '123 Nguyễn Huệ, TP.HCM', buyerEmail: 'a@example.test', note: ''
    });
    assert.equal(fullRes.status, 409);

    const ambId = await mkOrder('GA-INV-AMB', 'ambiguous', 300000);
    const ambRes = await srv.req('/api/gaeru_ceo/business/invoice', 'POST', {
      requestKey: randomUUID(), period: '2026-11', orderId: ambId, buyerName: 'Buyer B', buyerTaxCode: '0101234567', buyerAddress: '123 Nguyễn Huệ, TP.HCM', buyerEmail: 'b@example.test', note: ''
    });
    assert.equal(ambRes.status, 409);

    const partId = await mkOrder('GA-INV-PART', 'succeeded', 400000);
    const partRes = await srv.req('/api/gaeru_ceo/business/invoice', 'POST', {
      requestKey: randomUUID(), period: '2026-11', orderId: partId, buyerName: 'Buyer C', buyerTaxCode: '0101234567', buyerAddress: '123 Nguyễn Huệ, TP.HCM', buyerEmail: 'c@example.test', note: ''
    });
    assert.equal(partRes.status, 201, JSON.stringify(partRes.data));
    const doc = (await pool.query('SELECT calculation FROM business_documents WHERE id = $1', [partRes.data.id])).rows[0];
    assert.equal(doc.calculation.orderTotalVnd, 600000);
    assert.equal(doc.calculation.grossOrderTotalVnd, 1000000);
    assert.equal(doc.calculation.refundedVnd, 400000);

    // 100% refunded with Xu clawback (990k cash + 10k clawback = 1M) must be rejected with 409
    const clawId = randomUUID();
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method, payment_status)
       VALUES ($1, 'GA-INV-CLAW', 'Inv Buyer D', 'invd@example.test', '0918889998', 'Addr', 'HCM', 1000000, 0, 1000000, 'completed', 'momo', 'paid')`,
      [clawId]
    );
    await pool.query(
      `INSERT INTO momo_refunds (id, order_id, order_number, original_trans_id, refund_order_id, request_id, amount_vnd, loyalty_clawback_vnd, status, environment, created_by)
       VALUES ($1, $2, 'GA-INV-CLAW', 776656, 'RF-CLAW-1', $3, 990000, 10000, 'succeeded', 'sandbox', 'owner')`,
      [randomUUID(), clawId, randomUUID()]
    );
    const clawRes = await srv.req('/api/gaeru_ceo/business/invoice', 'POST', {
      requestKey: randomUUID(), period: '2026-11', orderId: clawId, buyerName: 'Buyer D', buyerTaxCode: '0101234567', buyerAddress: '123 Nguyễn Huệ, TP.HCM', buyerEmail: 'd@example.test', note: ''
    });
    assert.equal(clawRes.status, 409);
  });

  // =========================================================================
  // #12 (INV-OPS-01): PO requestKey idempotency & ROP forecast cache invalidation
  // =========================================================================
  await t.test('#12 INV-OPS-01: POST /purchase-orders requestKey idempotency & forecast cache invalidation', async () => {
    const p = await seedProduct(pool, { name: 'PO Item', priceVnd: 300000, stock: 10 });
    const supId = randomUUID();
    await pool.query("INSERT INTO suppliers (id, code, name, active) VALUES ($1, 'SUP01', 'NCC Test', true)", [supId]);

    const { createOperationsApi } = require('../src/operations-api');
    const forecast = require('../src/inventory-forecast');
    const srv = await startRouter('/api/gaeru_ceo', createOperationsApi(pool), { adminUser: ownerAdmin });
    t.after(() => srv.close());

    // Populate forecast cache first
    await forecast.calculateInventoryForecast(pool, { warehouseId: p.whMain });
    assert.ok(forecast.globalForecastCache.size() > 0, 'Forecast cache should be populated before mutation');

    const rk = 'po-' + randomUUID();
    const payload = {
      requestKey: rk,
      supplierId: supId,
      warehouseId: p.whMain,
      reference: 'REF-1',
      note: 'Test idempotent PO',
      items: [{ variantId: p.variantId, quantity: 5, unitCostVnd: 150000 }]
    };
    const r1 = await srv.req('/api/gaeru_ceo/purchase-orders', 'POST', payload);
    assert.equal(r1.status, 201, JSON.stringify(r1.data));
    assert.equal(forecast.globalForecastCache.size(), 0, 'PO creation must invalidate forecast cache');

    // Replay same requestKey + payload -> same PO ID, no duplicate row
    const r2 = await srv.req('/api/gaeru_ceo/purchase-orders', 'POST', payload);
    assert.equal(r2.status, 201);
    assert.equal(r2.data.purchaseOrder.id, r1.data.purchaseOrder.id);
    const poCount = Number((await pool.query("SELECT count(*)::int AS c FROM purchase_orders WHERE reference = 'REF-1'")).rows[0].c);
    assert.equal(poCount, 1);

    // Same requestKey + different payload -> 409 conflict
    const rConflict = await srv.req('/api/gaeru_ceo/purchase-orders', 'POST', { ...payload, note: 'Tampered' });
    assert.equal(rConflict.status, 409);

    // Verify enterprise.js sends requestKey in purchase editor/submit
    const enterpriseJs = fs.readFileSync(path.join(ROOT, 'admin/enterprise.js'), 'utf8');
    assert.match(enterpriseJs, /data-e-form="purchase"><input type="hidden" name="requestKey"/);
    assert.match(enterpriseJs, /requestKey: values\.requestKey, supplierId: values\.supplierId/);
  });

  // =========================================================================
  // #13 (CART-01): Customer cart rejects/filters soft-deleted & inactive products
  // =========================================================================
  await t.test('#13 CART-01: customer cart /item and /merge reject soft-deleted and inactive products', async () => {
    const custId = randomUUID();
    await pool.query(
      `INSERT INTO customers (id, full_name, email, phone, password_hash)
       VALUES ($1, 'Cart User', 'cart-u@example.test', '0919991111', $2)`,
      [custId, bcrypt.hashSync('Secret123456', 4)]
    );
    const pActive = await seedProduct(pool, { name: 'Active Cart Item', priceVnd: 200000 });
    const pSoftDel = await seedProduct(pool, { name: 'Deleted Cart Item', priceVnd: 200000, deletedAt: new Date().toISOString() });
    const pInactive = await seedProduct(pool, { name: 'Inactive Cart Item', priceVnd: 200000, active: false });

    // Pre-seed a stale cart item referencing the soft-deleted product
    await pool.query(
      'INSERT INTO customer_cart_items (customer_id, variant_id, quantity) VALUES ($1, $2, 1)',
      [custId, pSoftDel.variantId]
    );

    const { createCustomerCartRouter } = require('../src/customer-cart');
    const srv = await startRouter('/api/customer/cart', createCustomerCartRouter(pool), {
      sessionData: { customer: { id: custId } }
    });
    t.after(() => srv.close());

    assert.equal((await srv.req('/api/customer/cart/item', 'POST', { variantId: pSoftDel.variantId, quantity: 1 })).status, 404);
    assert.equal((await srv.req('/api/customer/cart/item', 'POST', { variantId: pInactive.variantId, quantity: 1 })).status, 404);
    assert.equal((await srv.req('/api/customer/cart/item', 'POST', { variantId: pActive.variantId, quantity: 1 })).status, 200);

    const mergeRes = await srv.req('/api/customer/cart/merge', 'POST', { localItems: [] });
    assert.equal(mergeRes.status, 200);
    assert.deepEqual(mergeRes.data.items.map((i) => i.variantId), [pActive.variantId]);
  });

  // =========================================================================
  // #14 (OMNI-01): resolveVariantForSku excludes deleted products; partial sync records failure event
  // =========================================================================
  await t.test('#14 OMNI-01: resolveVariantForSku skips soft-deleted products & syncMarketplaceOrders logs mid-batch failure', async () => {
    const pDeleted = await seedProduct(pool, { name: 'Deleted MP SKU', sku: 'MP-DEL-SKU-1', deletedAt: new Date().toISOString() });
    const pLive = await seedProduct(pool, { name: 'Live MP SKU', sku: 'MP-LIVE-SKU-1', stock: 10 });

    const { resolveVariantForSku, syncMarketplaceOrders } = require('../src/omnichannel-sync');
    assert.equal(await resolveVariantForSku(pool, 'shopee', 'shop-1', pDeleted.sku), null);
    assert.equal(await resolveVariantForSku(pool, 'shopee', 'shop-1', pLive.sku), pLive.variantId);

    // Seed shopee credentials in admin_configurations (encrypted via writeRecord)
    const { writeRecord } = require('../src/admin-configuration');
    const cfg = { SESSION_SECRET: 'test-omni-secret-12345678901234567890' };
    await writeRecord(pool, cfg, 'shopee', {
      enabled: true,
      shopId: '12345',
      partnerId: '999',
      secret: 'partner-secret-key',
      accessToken: 'tok-1234567890',
      connectionVerifiedAt: new Date().toISOString()
    }, 0, ownerAdmin);

    const mockFetcher = async (url) => {
      const u = String(url);
      if (u.includes('get_order_list')) {
        return {
          ok: true, status: 200,
          async json() { return { response: { order_list: [{ order_sn: 'SP-OK-1' }, { order_sn: 'SP-BAD-2' }] } }; }
        };
      }
      const isBad = u.includes('SP-BAD-2');
      return {
        ok: true, status: 200,
        async json() {
          return {
            response: {
              order_list: [
                isBad
                  ? {
                      order_sn: 'SP-BAD-2',
                      order_status: 'PROCESSED',
                      total_amount: 500000,
                      create_time: Math.floor(Date.now() / 1000),
                      item_list: [] // triggers mid-batch 502!
                    }
                  : {
                      order_sn: 'SP-OK-1',
                      order_status: 'PROCESSED',
                      total_amount: 500000,
                      create_time: Math.floor(Date.now() / 1000),
                      item_list: [{ model_sku: pLive.sku, item_name: 'Live MP SKU', model_quantity_purchased: 1, model_discounted_price: 500000 }]
                    }
              ]
            }
          };
        }
      };
    };

    const omniPool = {
      query: (sql, vals) => pool.query(sql, vals),
      connect: async () => ({ query: (sql, vals) => pool.query(sql, vals), release() {} })
    };
    await assert.rejects(
      () => syncMarketplaceOrders(omniPool, cfg, 'shopee', { fetcher: mockFetcher, actor: ownerAdmin, autoDeductStock: false, days: 1 }),
      (err) => err.status === 502
    );
    const syncEvent = (await pool.query(
      "SELECT processed, payload, error_message FROM marketplace_sync_events WHERE channel = 'shopee' AND event_type = 'sync_orders' ORDER BY created_at DESC LIMIT 1"
    )).rows[0];
    assert.ok(syncEvent, 'Mid-batch sync failure must still log marketplace_sync_events');
    assert.equal(syncEvent.processed, false);
    assert.equal(syncEvent.payload.syncedCount, 1);
    assert.equal(syncEvent.payload.failedCount, 1);
  });

  // =========================================================================
  // #15 (WARR-BADGE-01): Withdrawn warranties excluded & internal AI paid_revenue subtracts MoMo refunds
  // =========================================================================
  await t.test('#15 WARR-BADGE-01: withdrawn pending warranties excluded from summary/AI and AI paid_revenue nets MoMo refunds', async () => {
    const storeSrc = fs.readFileSync(path.join(ROOT, 'src/store-api.js'), 'utf8');
    assert.match(storeSrc, /warranty_activations WHERE status = 'pending' AND withdrawn_at IS NULL/);

    const aiSrc = fs.readFileSync(path.join(ROOT, 'src/internal-ai.js'), 'utf8');
    assert.match(aiSrc, /FROM warranty_activations\s+WHERE withdrawn_at IS NULL/);
    assert.match(aiSrc, /FROM momo_refunds\s+WHERE status = 'succeeded'/);

    // Execute the exact SQL queries on PGlite with withdrawn warranty + MoMo refunded order
    const wCustId = randomUUID();
    const wProd = await seedProduct(pool, { name: 'K9 War', priceVnd: 500000 });
    const wOrdId = randomUUID();
    const wItem1 = randomUUID();
    const wItem2 = randomUUID();
    await pool.query(
      `INSERT INTO customers (id, full_name, email, phone, password_hash) VALUES ($1, 'War User', 'war-u@example.test', '0911112222', $2)`,
      [wCustId, bcrypt.hashSync('Secret123456', 4)]
    );
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_id, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method, payment_status)
       VALUES ($1, 'GA-WAR-BADGE', $2, 'War User', 'war-u@example.test', '0911112222', 'Addr', 'HCM', 1000000, 0, 1000000, 'completed', 'cod', 'paid')`,
      [wOrdId, wCustId]
    );
    await pool.query(
      `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
       VALUES ($1, $3, $4, 'K9 War', 'Std', $5, 1, 500000, 500000),
              ($2, $3, $4, 'K9 War', 'Std', $5, 1, 500000, 500000)`,
      [wItem1, wItem2, wOrdId, wProd.variantId, wProd.sku]
    );
    await pool.query(
      `INSERT INTO warranty_activations (id, customer_id, order_item_id, request_key, status, withdrawn_at)
       VALUES ($1, $3, $4, $5, 'pending', NULL),
              ($2, $3, $6, $7, 'pending', now())`,
      [randomUUID(), randomUUID(), wCustId, wItem1, randomUUID(), wItem2, randomUUID()]
    );
    const pendingCnt = Number((await pool.query(
      "SELECT COUNT(*)::int AS pending FROM warranty_activations WHERE customer_id = $1 AND status = 'pending' AND withdrawn_at IS NULL",
      [wCustId]
    )).rows[0].pending);
    assert.equal(pendingCnt, 1, 'Withdrawn pending warranty must not be counted');

    const aiRev = (await pool.query(`
      SELECT COALESCE(SUM(CASE WHEN o.payment_status = 'paid' AND o.status <> 'cancelled' AND o.return_completed_at IS NULL
        THEN GREATEST(0::bigint, COALESCE(o.total_vnd, 0)::bigint - COALESCE(mr.refunded, 0)::bigint) ELSE 0 END), 0)::bigint AS paid_revenue
      FROM orders o
      LEFT JOIN (SELECT order_id, SUM(amount_vnd)::bigint AS refunded FROM momo_refunds WHERE status = 'succeeded' GROUP BY order_id) mr ON mr.order_id = o.id
      WHERE o.order_number IN ('GA-MOMO-FULL', 'GA-MOMO-PART')
    `)).rows[0];
    // GA-MOMO-FULL (1M - 1M = 0) + GA-MOMO-PART (1M - 400k = 600k) = 600,000
    assert.equal(Number(aiRev.paid_revenue), 600000);
  });

  // =========================================================================
  // #16 (DR-GDRIVE-01): gdrive-sync verifies full matched set & failover-restore-to-pc.ps1 falls back to older complete set
  // =========================================================================
  await t.test('#16 DR-GDRIVE-01: gdrive-sync verifies all matched PG files & failover-restore-to-pc selects complete matching set', async () => {
    const gdriveSh = fs.readFileSync(path.join(ROOT, 'scripts/mi6-backup/gaeru-gdrive-sync.sh'), 'utf8');
    assert.ok(!gdriveSh.includes('\r'), 'gaeru-gdrive-sync.sh must remain pure LF');
    assert.match(gdriveSh, /select_latest_local_pg_set\(\)/);
    assert.match(gdriveSh, /for vf in "\$\{verify_files\[@\]\}"; do/);
    assert.match(gdriveSh, /remote_file_verified "\$src_chroot" "pg" "\$vf"/);

    // Run real PowerShell verification of Get-LatestCompletePgBackupSet & Get-LatestCompleteMediaBackup
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-dr-r2-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const pgDir = path.join(tmpDir, 'pg');
    const mediaDir = path.join(tmpDir, 'media');
    fs.mkdirSync(pgDir);
    fs.mkdirSync(mediaDir);

    const writeWithSha = (dir, name, content) => {
      const full = path.join(dir, name);
      fs.writeFileSync(full, content);
      const hex = createHash('sha256').update(content).digest('hex');
      fs.writeFileSync(full + '.sha256', `${hex}  ${name}\n`);
      return full;
    };

    // Older COMPLETE set (20261126-030000)
    writeWithSha(pgDir, 'gaeru_store-20261126-030000.dump.gpg', 'OLD-DUMP-DATA');
    writeWithSha(pgDir, 'gaeru_store-20261126-030000.sql.gz.gpg', 'OLD-SQL-DATA');
    // Newer INCOMPLETE set (20261127-030000): dump exists with sha, sql missing!
    writeWithSha(pgDir, 'gaeru_store-20261127-030000.dump.gpg', 'NEW-DUMP-ONLY');
    // Media: older complete, newer missing sha
    writeWithSha(mediaDir, 'gaeru-media-config-20261126.tar.gz.gpg', 'OLD-MEDIA-DATA');
    fs.writeFileSync(path.join(mediaDir, 'gaeru-media-config-20261127.tar.gz.gpg'), 'NEW-MEDIA-PARTIAL');

    const psScript = `
      $ErrorActionPreference = 'Stop'
      . '${path.join(ROOT, 'scripts/database-backup.ps1').replaceAll("'", "''")}'
      $src = Get-Content -LiteralPath '${path.join(ROOT, 'scripts/failover-restore-to-pc.ps1').replaceAll("'", "''")}' -Raw
      $fnBlock = $src.Substring($src.IndexOf('function Get-NewestBackupFile'), $src.IndexOf('if ($Mode -eq "PullFromGoogleDrive")') - $src.IndexOf('function Get-NewestBackupFile'))
      Invoke-Expression $fnBlock
      $pgSet = Get-LatestCompletePgBackupSet -Dir '${pgDir.replaceAll("'", "''")}'
      $media = Get-LatestCompleteMediaBackup -Dir '${mediaDir.replaceAll("'", "''")}'
      [pscustomobject]@{ stamp = $pgSet.Stamp; dump = (Split-Path -Leaf $pgSet.DumpFile); sql = (Split-Path -Leaf $pgSet.SqlFile); media = (Split-Path -Leaf $media) } | ConvertTo-Json -Compress
    `;
    const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const out = JSON.parse(run.stdout.trim());
    assert.equal(out.stamp, '20261126-030000');
    assert.equal(out.dump, 'gaeru_store-20261126-030000.dump.gpg');
    assert.equal(out.sql, 'gaeru_store-20261126-030000.sql.gz.gpg');
    assert.equal(out.media, 'gaeru-media-config-20261126.tar.gz.gpg');
  });

  // =========================================================================
  // #17 (CUST-AUTH-01): email-verification/request blocks inactive/deleted; /api/me enforces phone/email lock
  // =========================================================================
  await t.test('#17 CUST-AUTH-01: email-verification/request rejects inactive account and /api/me auto-locks expired invalid phone', async () => {
    const { createApp } = require('../src/app');
    const pw = 'Auth-Guard-2026!';
    const inactiveId = randomUUID();
    const expiredPhoneId = randomUUID();
    await pool.query(
      `INSERT INTO customers (id, full_name, email, phone, password_hash, active, deleted_at, phone_invalid_at)
       VALUES ($1, 'Inactive User', 'inactive-v@example.test', '0911002200', $2, true, NULL, NULL),
              ($3, 'Expired Phone User', 'expired-me@example.test', '02438251234', $2, true, NULL, now() - interval '13 hours')`,
      [inactiveId, bcrypt.hashSync(pw, 4), expiredPhoneId]
    );

    const app = createApp({
      pool,
      sessionStore: new session.MemoryStore(),
      config: {
        NODE_ENV: 'test',
        SESSION_SECRET: 'test-secret-round2-audit-1234567890',
        ADMIN_USERNAME: 'owner',
        ADMIN_PASSWORD_HASH: bcrypt.hashSync(pw, 4),
        smtp: { from: 'support@example.test', publicBaseUrl: 'https://gaeru.com' }
      },
      customerMailer: { async sendMail() { return { accepted: ['x'] }; } }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const mkClient = () => {
      let cookie = '', csrf = '';
      return async (urlPath, method = 'GET', body = undefined) => {
        const r = await fetch(base + urlPath, {
          method,
          headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined
        });
        const sc = r.headers.get('set-cookie');
        if (sc) cookie = sc.split(';')[0];
        const data = await r.json().catch(() => ({}));
        if (data.csrfToken) csrf = data.csrfToken;
        return { status: r.status, data };
      };
    };

    // Login active user, then soft-delete in DB, then call email-verification/request -> must return 401 (NOT 200 verified:true!)
    const c1 = mkClient();
    await c1('/api/csrf');
    assert.equal((await c1('/api/customer-auth/login', 'POST', { email: 'inactive-v@example.test', password: pw })).status, 200);
    await pool.query('UPDATE customers SET active = false, deleted_at = now() WHERE id = $1', [inactiveId]);
    const verRes = await c1('/api/customer-auth/email-verification/request', 'POST', {});
    assert.equal(verRes.status, 401, 'Deactivated/deleted account must receive 401 on email-verification/request');

    // Login user with valid phone, then set expired invalid phone in DB, then call legacy GET /api/me -> must lock & return 401
    await pool.query("UPDATE customers SET phone = '0911003300', phone_invalid_at = NULL WHERE id = $1", [expiredPhoneId]);
    const c2 = mkClient();
    await c2('/api/csrf');
    assert.equal((await c2('/api/customer-auth/login', 'POST', { email: 'expired-me@example.test', password: pw })).status, 200);
    await pool.query("UPDATE customers SET phone = '02438251234', phone_invalid_at = now() - interval '13 hours' WHERE id = $1", [expiredPhoneId]);
    const meRes = await c2('/api/me');
    assert.equal(meRes.status, 401, 'Legacy GET /api/me must enforce 12h phone lock');
    const lockedRow = (await pool.query('SELECT active, lock_reason FROM customers WHERE id = $1', [expiredPhoneId])).rows[0];
    assert.equal(lockedRow.active, false);
    assert.equal(lockedRow.lock_reason, 'invalid_phone_timeout');
  });

  // =========================================================================
  // #18 (BULK-UI-01) & #19 (WATCHDOG-CF-01): Admin bulk prepare fee check & watchdog cloudflared disable guard
  // =========================================================================
  await t.test('#18 BULK-UI-01 & #19 WATCHDOG-CF-01: admin bulk prepare requires shippingFeeVnd & watchdog respects cloudflared disabled', async () => {
    const adminJs = fs.readFileSync(path.join(ROOT, 'admin/admin.js'), 'utf8');
    assert.match(adminJs, /\(!\["confirmed","processing"\]\.includes\(target\)\|\|o\.shippingFeeVnd!=null\)/);
    assert.match(adminJs, /const missingShipFee = order\.shippingFeeVnd == null \|\| order\.totalVnd == null;/);

    const watchdogSh = fs.readFileSync(path.join(ROOT, 'scripts/network_watchdog.sh'), 'utf8');
    assert.ok(!watchdogSh.includes('\r'), 'network_watchdog.sh must remain pure LF');
    assert.match(watchdogSh, /\/etc\/init\/cloudflared\.override/);
    assert.match(watchdogSh, /\/etc\/default\/cloudflared/);
    assert.match(watchdogSh, /\/etc\/rc2\.d\/S\*cloudflared/);
    assert.match(watchdogSh, /CF_DISABLED/);
  });
});
