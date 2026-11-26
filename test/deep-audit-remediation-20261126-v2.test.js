'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { createLocalPool } = require('../src/local-server');
const { migrateDatabase } = require('../src/migrate');
const { withTransaction } = require('../src/db');
const inventory = require('../src/inventory');
const { createFinanceApi, recordFullOrderPayment } = require('../src/finance-api');
const { deleteOrderPermanently } = require('../src/order-deletion');
const { calculateBundlePricing } = require('../src/product-bundles');
const { FailoverSyncManager } = require('../src/failover-sync');
const { earnPoints, redeemPoints, refundPoints } = require('../src/loyalty-api');
const { checkAdminSessionDbValid } = require('../src/realtime-sse');
const { createOperationsQueues } = require('../src/operations-queues');
const GAERUAnalytics = require('../google-analytics');
const createCustomerSession = require('../customer-session');

const REPO_ROOT = path.join(__dirname, '..');

test('Deep Audit v2 — [P0-01 & P2-04] Unsettled carrier COD stays in receivables and allows settlement without Catch-22', { timeout: 60000 }, async (t) => {
  const pool = await createLocalPool();
  t.after(() => pool.end());
  await migrateDatabase(pool);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { csrfToken: 'cod-csrf' };
    req.admin = {
      username: 'owner',
      role: 'owner',
      source: 'bootstrap',
      isOwner: true,
      permissions: ['finance.read', 'finance.write', 'payments.write', 'orders.read', 'orders.write']
    };
    next();
  });
  app.use('/api/gaeru_ceo', createFinanceApi(pool));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/gaeru_ceo`;

  const orderRes = await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd, delivered_at)
     VALUES ('GR-20261126-COD01', 'Khách COD', 'cod@example.test', '0912345678', '123 Lê Lợi', 'Hồ Chí Minh', 'cod', 'paid', 'completed', 450000, 450000, now())
     RETURNING id`
  );
  const orderId = orderRes.rows[0].id;

  await pool.query(
    `INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status, delivered_at)
     VALUES ($1, 'viettel', 'VTP-COD-001', 'delivered', 450000, 'unsettled', now())`,
    [orderId]
  );

  // 1. Before COD settlement: salesPaidVnd must be 0 and salesOutstandingVnd must be 450,000
  const ovBefore = await (await fetch(`${base}/finance/summary`)).json();
  assert.equal(ovBefore.summary.salesPaidVnd, 0);
  assert.equal(ovBefore.summary.salesOutstandingVnd, 450000);

  const recBefore = await (await fetch(`${base}/finance/receivables`)).json();
  assert.ok(recBefore.receivables.some(o => o.id === orderId && Number(o.outstandingVnd) === 450000));

  // 2. Settle COD via POST /finance/customer-payments (must NOT fail with 409 Catch-22)
  const payRes = await fetch(`${base}/finance/customer-payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'cod-csrf' },
    body: JSON.stringify({
      orderId,
      amountVnd: 450000,
      method: 'bank_transfer',
      reference: 'VTP-BATCH-20261126',
      note: 'Đối soát lô COD Viettel Post',
      requestKey: randomUUID()
    })
  });
  assert.equal(payRes.status, 201);

  const batchRow = (await pool.query(
    `SELECT allocated_total_vnd FROM cod_settlement_batches WHERE carrier_id = 'viettel' AND provider_transaction_ref = 'VTP-BATCH-20261126'`
  )).rows[0];
  assert.equal(Number(batchRow.allocated_total_vnd), 450000);

  const shipRow = (await pool.query(`SELECT cod_settlement_status FROM carrier_shipments WHERE order_id = $1`, [orderId])).rows[0];
  assert.equal(shipRow.cod_settlement_status, 'settled');

  // 3. After settlement: salesPaidVnd = 450,000 and salesOutstandingVnd = 0
  const ovAfter = await (await fetch(`${base}/finance/summary`)).json();
  assert.equal(ovAfter.summary.salesPaidVnd, 450000);
  assert.equal(ovAfter.summary.salesOutstandingVnd, 0);
});

test('Deep Audit v2 — [P0-02] momo_refunds integrates cleanly with finance overview, pre-shipment cancel, and order deletion', { timeout: 60000 }, async (t) => {
  const pool = await createLocalPool();
  t.after(() => pool.end());
  await migrateDatabase(pool);

  const orderRes = await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
     VALUES ('GR-20261126-MOMO1', 'Khách MoMo', 'momo@example.test', '0988777666', '10 Nguyễn Huệ', 'Hồ Chí Minh', 'momo', 'paid', 'processing', 300000, 300000)
     RETURNING id`
  );
  const orderId = orderRes.rows[0].id;

  const attemptRes = await pool.query(
    `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, status, provider_transaction_id, expires_at)
     VALUES ($1, 'momo', 'GR-20261126-MOMO1-A1', 300000, 'paid', '9988776655', now() + interval '15 minutes')
     RETURNING id`,
    [orderId]
  );
  const attemptId = attemptRes.rows[0].id;

  await withTransaction(pool, client => recordFullOrderPayment(
    client,
    orderId,
    { username: 'momo_ipn' },
    { method: 'bank_transfer', reference: '9988776655', requestKey: randomUUID() }
  ));

  // 1. In-flight momo_refunds blocks even Owner permanent deletion with 409
  const pendingRefundRes = await pool.query(
    `INSERT INTO momo_refunds (order_id, payment_attempt_id, order_number, refund_order_id, request_id, original_trans_id, amount_vnd, description, status, environment, request_key, created_by)
     VALUES ($1, $2, 'GR-20261126-MOMO1', 'RF-MOMO-01', 'REQ-MOMO-01', 9988776655, 300000, 'Hoàn đơn MoMo', 'pending_provider', 'sandbox', $3, 'owner')
     RETURNING id`,
    [orderId, attemptId, randomUUID()]
  );
  const refundId = pendingRefundRes.rows[0].id;

  await assert.rejects(
    () => withTransaction(pool, client => deleteOrderPermanently(client, orderId, {
      actor: { username: 'owner', role: 'owner', source: 'bootstrap', isOwner: true },
      inventory
    })),
    err => err.status === 409
  );

  // 2. Mark refund succeeded -> Finance summary nets salesPaidVnd down to 0
  await pool.query(`UPDATE momo_refunds SET status = 'succeeded', result_code = '0', updated_at = now() WHERE id = $1`, [refundId]);

  const app = express();
  app.use((req, _res, next) => {
    req.admin = { username: 'owner', role: 'owner', source: 'bootstrap', isOwner: true, permissions: ['finance.read'] };
    next();
  });
  app.use('/api/gaeru_ceo', createFinanceApi(pool));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const ov = await (await fetch(`http://127.0.0.1:${server.address().port}/api/gaeru_ceo/finance/summary`)).json();
  assert.equal(ov.summary.salesPaidVnd, 0);

  // 3. Staff deletion is still blocked (409), while Owner permanent purge deletes momo_refunds cleanly without 23503 FK crash
  await pool.query(`UPDATE orders SET status = 'cancelled', cancellation_reason = 'Đã hoàn MoMo 100%' WHERE id = $1`, [orderId]);
  await assert.rejects(
    () => withTransaction(pool, client => deleteOrderPermanently(client, orderId, {
      actor: { username: 'staff1', role: 'admin', source: 'staff', isOwner: false },
      inventory
    })),
    err => err.status === 409
  );

  const purged = await withTransaction(pool, client => deleteOrderPermanently(client, orderId, {
    actor: { username: 'owner', role: 'owner', source: 'bootstrap', isOwner: true },
    inventory
  }));
  assert.equal(purged.id, orderId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM momo_refunds WHERE order_id = $1', [orderId])).rows[0].n, 0);
});

test('Deep Audit v2 — [P0-05] Multi-item fixed bundle requires full secondary set and scales across multiple sets', () => {
  const bundles = [{
    id: 'b-fixed-1',
    title: 'Combo Studio 3 món',
    active: true,
    discount_type: 'fixed',
    discount_value: 120000,
    items: [
      { variant_id: 'v-mic', is_primary: true, min_quantity: 1 },
      { variant_id: 'v-stand', is_primary: false, min_quantity: 1 },
      { variant_id: 'v-cable', is_primary: false, min_quantity: 1 }
    ]
  }];

  // Partial secondary set (only 60,000 cable) -> capped at 60,000 instead of siphoning 120,000 off primary item
  const partial = calculateBundlePricing([
    { variantId: 'v-mic', quantity: 1, priceVnd: 500000 },
    { variantId: 'v-cable', quantity: 1, priceVnd: 60000 }
  ], bundles);
  assert.equal(partial.bundleDiscountVnd, 60000);

  // 1 complete set -> 120,000 discount
  const singleSet = calculateBundlePricing([
    { variantId: 'v-mic', quantity: 1, priceVnd: 500000 },
    { variantId: 'v-stand', quantity: 1, priceVnd: 150000 },
    { variantId: 'v-cable', quantity: 1, priceVnd: 60000 }
  ], bundles);
  assert.equal(singleSet.bundleDiscountVnd, 120000);

  // 2 complete sets -> 240,000 discount
  const doubleSet = calculateBundlePricing([
    { variantId: 'v-mic', quantity: 2, priceVnd: 500000 },
    { variantId: 'v-stand', quantity: 2, priceVnd: 150000 },
    { variantId: 'v-cable', quantity: 2, priceVnd: 60000 }
  ], bundles);
  assert.equal(doubleSet.bundleDiscountVnd, 240000);
});

test('Deep Audit v2 — [P0-03] FailoverSyncManager preserves originalPriceVnd, deactivates removed items, and maps public settings', { timeout: 60000 }, async (t) => {
  const pool = await createLocalPool();
  t.after(() => pool.end());
  await migrateDatabase(pool);

  // Seed an old product that is no longer present on Primary
  const staleProd = (await pool.query(
    `INSERT INTO products (slug, name, category, description, active)
     VALUES ('old-discontinued', 'Sản phẩm cũ', 'accessory', 'Cũ', true) RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'OLD-SKU-1', 'Mặc định', 99000, 0, true)`,
    [staleProd.id]
  );

  const stateFile = path.join(require('node:os').tmpdir(), `gaeru-failover-test-${randomUUID()}.json`);
  t.after(() => { try { fs.unlinkSync(stateFile); } catch (_) {} });

  const mgr = new FailoverSyncManager({ SERVER_ROLE: 'standby', FAILOVER_STATE_PATH: stateFile }, pool);
  const syncRes = await mgr.syncFromPrimary({
    fetcher: async (url) => {
      if (String(url).endsWith('/api/products')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            products: [{
              slug: 'gaeru-m3-test',
              name: 'GAERU M3 Flash',
              category: 'audio',
              description: 'Test',
              active: true,
              variants: [{
                sku: 'M3-FLASH-SKU',
                name: 'Type-C',
                priceVnd: 399000,          // Discounted Flash Sale price
                originalPriceVnd: 550000,  // True base price
                stockQuantity: 12,
                active: true
              }]
            }]
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          shippingRates: { 'Toàn quốc': 25000 },
          shippingNote: 'Giao nhanh 24h',
          gaMeasurementId: 'G-TEST123456'
        })
      };
    }
  });
  assert.equal(syncRes.ok, true);

  const syncedVar = (await pool.query(`SELECT price_vnd, stock_quantity FROM product_variants WHERE sku = 'M3-FLASH-SKU'`)).rows[0];
  assert.equal(Number(syncedVar.price_vnd), 550000, 'Must store originalPriceVnd, not Flash Sale priceVnd');
  assert.equal(Number(syncedVar.stock_quantity), 12);

  const oldProdAfter = (await pool.query(`SELECT active FROM products WHERE id = $1`, [staleProd.id])).rows[0];
  assert.equal(oldProdAfter.active, false, 'Removed primary product must be deactivated on standby');

  const ratesRow = (await pool.query(`SELECT setting_value FROM store_settings WHERE setting_key = 'shipping_rates'`)).rows[0];
  assert.equal(ratesRow.setting_value['Toàn quốc'], 25000);
});

test('Deep Audit v2 — [P1-09] GAERU Xu preserves original expires_at across full redeem and COD cancel refund', { timeout: 60000 }, async (t) => {
  const pool = await createLocalPool();
  t.after(() => pool.end());
  await migrateDatabase(pool);

  const custId = (await pool.query(
    `INSERT INTO customers (full_name, email, phone, password_hash)
     VALUES ('Khách Xu', 'xu@example.test', '0901234567', 'hash') RETURNING id`
  )).rows[0].id;
  const orderId = (await pool.query(
    `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd)
     VALUES ('GR-XU-01', $1, 'Khách Xu', 'xu@example.test', '0901234567', '1 Đường A', 'Hà Nội', 'cod', 500000, 500000) RETURNING id`,
    [custId]
  )).rows[0].id;

  // Earn points and set a specific near-term expiry (30 days from now)
  await withTransaction(pool, c => earnPoints(c, { customerId: custId, orderId, orderTotalVnd: 1000000 }));
  const targetExpiry = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  await pool.query(`UPDATE customer_loyalty SET expires_at = $2 WHERE customer_id = $1`, [custId, targetExpiry.toISOString()]);

  const balBefore = Number((await pool.query(`SELECT points_balance FROM customer_loyalty WHERE customer_id = $1`, [custId])).rows[0].points_balance);
  assert.ok(balBefore > 0);

  // Redeem 100% of balance -> balance hits 0, then cancel & refundPoints
  const order2Id = (await pool.query(
    `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd)
     VALUES ('GR-XU-02', $1, 'Khách Xu', 'xu@example.test', '0901234567', '1 Đường A', 'Hà Nội', 'cod', 500000, 500000) RETURNING id`,
    [custId]
  )).rows[0].id;

  await withTransaction(pool, c => redeemPoints(c, { customerId: custId, orderId: order2Id, pointsToRedeem: balBefore, orderTotalVnd: 500000 }));
  await withTransaction(pool, c => refundPoints(c, { customerId: custId, orderId: order2Id }));

  const afterRow = (await pool.query(`SELECT points_balance, expires_at FROM customer_loyalty WHERE customer_id = $1`, [custId])).rows[0];
  assert.equal(Number(afterRow.points_balance), balBefore);
  const diffMs = Math.abs(new Date(afterRow.expires_at).getTime() - targetExpiry.getTime());
  assert.ok(diffMs < 5000, `Expected original expires_at (~30d) to be preserved, got ${afterRow.expires_at}`);
});

test('Deep Audit v2 — [P0-06, P1-04, P1-12, P1-13, P1-16] Scripts DR, GA4 DLP, CustomerSession.get(), SSE MemoryStore & Queue Resolve', { timeout: 60000 }, async (t) => {
  // 1. gaeru-full-restore.sh & pull-mi6-backups.ps1 invariants
  const restoreSh = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'mi6-backup', 'gaeru-full-restore.sh'), 'utf8');
  assert.ok(!restoreSh.includes('\r'), 'gaeru-full-restore.sh must strictly use LF line endings');
  assert.match(restoreSh, /DEPLOY_LOCK="\/run\/gaeru-deploy\.lock"/);
  assert.match(restoreSh, /flock -n 9/);
  assert.match(restoreSh, /initctl stop node-app APP=gaeru/);
  assert.match(restoreSh, /initctl start node-app APP=gaeru/);
  assert.ok(!/initctl (?:stop|start) node-app(?:\s+2>|\s*$)/m.test(restoreSh), 'Must never call initctl stop/start node-app without APP=gaeru');

  const pullPs1 = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'pull-mi6-backups.ps1'), 'utf8');
  assert.match(pullPs1, /\$expectedHash -notmatch '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(pullPs1, /portable-database-backup\.cjs/);
  assert.match(pullPs1, /watchdog-supervisor\.js/);

  // 2. GA4 DLP URL sanitization
  const dirtyUrl = 'https://gaeru.com/tai-khoan?confirmDeletion=sec123&securityReset=rst456&trackingToken=trk789&challenge=0912345678&setup=stp000&utm_source=zalo';
  const cleanUrl = GAERUAnalytics.sanitizeUrl(dirtyUrl);
  for (const secret of ['sec123', 'rst456', 'trk789', '0912345678', 'stp000']) {
    assert.ok(!cleanUrl.includes(secret), `Secret ${secret} must be redacted from GA4 URL`);
  }
  assert.ok(cleanUrl.includes('utm_source=zalo'));

  // 3. GAERUCustomerSession.get()
  const sess = createCustomerSession({ fetch: async () => ({ ok: false }) });
  sess.set({ id: 'c1', fullName: 'Minh', email: 'minh@gaeru.com', phone: '0912345678', emailVerified: true });
  assert.equal(typeof sess.get, 'function');
  assert.equal(sess.get().phone, '0912345678');

  // 4. SSE MemoryStore vs PgSessionStore check + Operations Queue unknown resolver
  const pool = await createLocalPool();
  t.after(() => pool.end());
  await migrateDatabase(pool);

  const now = Date.now();
  const memoryReq = {
    sessionID: 'mem-sid-1',
    sessionStore: new (class MemoryStore {})(),
    session: {
      admin: { username: 'owner', role: 'owner', source: 'bootstrap' },
      adminAuthenticatedAt: now - 1000,
      adminLastSeenAt: now - 500
    }
  };
  assert.equal(await checkAdminSessionDbValid(pool, memoryReq), true);

  const pgReqMissingRow = {
    sessionID: 'pg-sid-missing',
    sessionStore: new (class PgStore {})(),
    session: {
      admin: { username: 'owner', role: 'owner', source: 'bootstrap' },
      adminAuthenticatedAt: now - 1000,
      adminLastSeenAt: now - 500
    }
  };
  assert.equal(await checkAdminSessionDbValid(pool, pgReqMissingRow), false);

  // 5. Operations queue resolve endpoint for 'unknown' email job
  const oId = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd)
     VALUES ('GR-OPS-UNK-1', 'Ops Buyer', 'ops@example.test', '0911222333', '1 Đường B', 'Hà Nội', 'cod', 100000, 100000) RETURNING id`
  )).rows[0].id;
  const jobId = (await pool.query(
    `INSERT INTO order_email_outbox (order_id, kind, status, attempts) VALUES ($1, 'receipt', 'unknown', 1) RETURNING id`,
    [oId]
  )).rows[0].id;

  const qApp = express();
  qApp.use(express.json());
  qApp.use((req, _res, next) => {
    req.session = { csrfToken: 'ops-csrf' };
    req.admin = { username: 'owner', role: 'owner', source: 'bootstrap', isOwner: true };
    next();
  });
  qApp.use(createOperationsQueues(pool, {}));
  const qServer = qApp.listen(0, '127.0.0.1');
  await new Promise(resolve => qServer.once('listening', resolve));
  t.after(() => new Promise(resolve => qServer.close(resolve)));

  const resRetry = await fetch(`http://127.0.0.1:${qServer.address().port}/owner/operations/queues/order-email/jobs/${jobId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'ops-csrf' },
    body: JSON.stringify({ action: 'retry' })
  });
  assert.equal(resRetry.status, 200);
  const jobAfter = (await pool.query(`SELECT status FROM order_email_outbox WHERE id = $1`, [jobId])).rows[0];
  assert.equal(jobAfter.status, 'pending');
});
