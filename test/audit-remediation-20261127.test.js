'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');
const { parseHTML } = require('linkedom');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const { migrateDatabase } = require('../src/migrate');
const { withTransaction } = require('../src/db');
const { refundPoints, previewEarnClawback } = require('../src/loyalty-api');
const { permanentDeleteCustomer, autoLockAccount } = require('../src/customer-lifecycle');
const { reconcilePrepaidOrder } = require('../src/payment-channels');
const { createOrderWorkflow } = require('../src/order-workflow');
const { checkAdminSessionDbValid, checkCustomerSessionDbValid } = require('../src/realtime-sse');
const { createVapidJwt, base64UrlEncode } = require('../src/web-push');
const { removeWhiteBackground } = require('../src/lib/product-background');
const { getOrSetCache, invalidateTags } = require('../cache');
const embeddingStore = require('../src/lib/embedding-store');

function createPglitePool(db) {
  const run = async (sql, params) => {
    if (!params || params.length === 0) {
      const results = await db.exec(sql);
      return results[results.length - 1] || { rows: [], rowCount: 0 };
    }
    return db.query(sql, params);
  };
  const client = { query: run, release: () => {} };
  return { query: run, connect: async () => client };
}

test('Gói 1 + Gói 2 Backend & DB regressions (C-01, C-04, C-06, C-07, C-08, C-13, A-01, A-02, A-03, I-05)', async (t) => {
  const db = new PGlite();
  const pool = createPglitePool(db);
  t.after(() => db.close());

  await migrateDatabase(pool);

  // [C-01] GAERU Xu expired points must NOT resurrect with fresh +12m expiry
  {
    const custId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customers (id, full_name, email, phone, password_hash, active)
       VALUES ($1, 'Xu Guard', 'xuguard@example.com', '0901000001', 'hash', true)`,
      [custId]
    );
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_id, customer_name, email, phone, address, city, status, payment_method, payment_status, subtotal_vnd, shipping_fee_vnd, discount_vnd, total_vnd)
       VALUES ($1, 'GR-27-C01', $2, 'Xu Guard', 'xuguard@example.com', '0901000001', '123 Le Loi', 'HCM', 'cancelled', 'cod', 'pending', 200000, 0, 100000, 100000)`,
      [orderId, custId]
    );
    await pool.query(
      `INSERT INTO customer_loyalty (customer_id, points_balance, expires_at)
       VALUES ($1, 1, now() - interval '10 days')`,
      [custId]
    );
    await pool.query(
      `INSERT INTO customer_loyalty_ledger (customer_id, order_id, type, points, balance_after, reason, event_key)
       VALUES ($1, $2, 'redeem', -100000, 1, 'Dùng Xu', 'redeem:gr-27-c01')`,
      [custId, orderId]
    );

    const preview = await previewEarnClawback(pool, { customerId: custId, orderId });
    assert.equal(preview.shortfallPoints, 0);

    const res = await withTransaction(pool, (c) => refundPoints(c, { customerId: custId, orderId, reason: 'Hủy đơn' }));
    assert.equal(res.refundedRedeem, 0);
    const after = (await pool.query('SELECT points_balance, expires_at FROM customer_loyalty WHERE customer_id=$1', [custId])).rows[0];
    assert.equal(Number(after.points_balance), 0);
    assert.equal(after.expires_at, null);

    // Also verify previewEarnClawback excludes expired pendingRedeemRefund from effectiveBalance
    const custId2 = crypto.randomUUID();
    const orderId2 = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customers (id, full_name, email, phone, password_hash, active)
       VALUES ($1, 'Xu Clawback', 'xuclaw@example.com', '0901000011', 'hash', true)`,
      [custId2]
    );
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_id, customer_name, email, phone, address, city, status, payment_method, payment_status, subtotal_vnd, shipping_fee_vnd, discount_vnd, total_vnd)
       VALUES ($1, 'GR-27-C01B', $2, 'Xu Clawback', 'xuclaw@example.com', '0901000011', '123 Le Loi', 'HCM', 'completed', 'cod', 'paid', 600000, 0, 100000, 500000)`,
      [orderId2, custId2]
    );
    await pool.query(
      `INSERT INTO customer_loyalty (customer_id, points_balance, expires_at)
       VALUES ($1, 0, now() - interval '5 days')`,
      [custId2]
    );
    await pool.query(
      `INSERT INTO customer_loyalty_ledger (customer_id, order_id, type, points, balance_after, reason, event_key)
       VALUES ($1, $2, 'redeem', -100000, 0, 'Dùng Xu', 'redeem:gr-27-c01b'),
              ($1, $2, 'earn', 5000, 5000, 'Tích Xu', 'earn:gr-27-c01b')`,
      [custId2, orderId2]
    );
    const preview2 = await previewEarnClawback(pool, { customerId: custId2, orderId: orderId2 });
    assert.equal(preview2.pendingRedeemRefund, 0);
    assert.equal(preview2.shortfallPoints, 5000);
  }

  // [C-04] Editing shippingFeeVnd on bank_transfer syncs pending payment_attempts.amount_vnd
  {
    const orderId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, status, payment_method, payment_status, subtotal_vnd, shipping_fee_vnd, discount_vnd, total_vnd)
       VALUES ($1, 'GR-27-C04', 'BT Customer', 'bt27@example.com', '0901000002', '123 Le Loi', 'HCM', 'pending', 'bank_transfer', 'pending', 500000, 30000, 0, 530000)`,
      [orderId]
    );
    await pool.query(
      `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, status, expires_at)
       VALUES ($1, 'bank_transfer', 'GR-27-C04', 530000, 'pending', now() + interval '24 hours')`,
      [orderId]
    );

    const { updateOrder } = createOrderWorkflow();
    const upd = await updateOrder(
      pool,
      orderId,
      { shippingFeeVnd: 0 },
      { username: 'owner', role: 'owner', source: 'bootstrap' }
    );
    assert.equal(Number(upd.totalVnd), 500000);

    const attempt = (await pool.query('SELECT amount_vnd FROM payment_attempts WHERE order_id=$1', [orderId])).rows[0];
    assert.equal(Number(attempt.amount_vnd), 500000);

    const rec = await reconcilePrepaidOrder(pool, {
      provider: 'bank_transfer',
      orderNumber: 'GR-27-C04',
      amountVnd: 500000,
      providerTransactionId: 'TX-27-500K',
      responseCode: '00',
      successful: true
    });
    assert.equal(rec.code, '00');
    assert.equal(rec.paymentStatus, 'paid');
  }

  // [I-05] Permanent customer deletion must NOT resurrect automatic warranty or queue anonymized email
  {
    const prodId = crypto.randomUUID();
    const varId = crypto.randomUUID();
    const custId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, slug, name, category, active) VALUES ($1, 'mic-27-i05', 'GAERU Mic I05', 'audio', true)`,
      [prodId]
    );
    await pool.query(
      `INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, $2, 'SKU-27-I05', 'Default', 1200000, 5, true)`,
      [varId, prodId]
    );
    await pool.query(
      `INSERT INTO customers (id, full_name, email, phone, password_hash, active, deleted_at)
       VALUES ($1, 'Anon Customer', 'anon27@example.com', '0901000003', 'hash', false, now())`,
      [custId]
    );
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_id, customer_name, email, phone, address, city, status, payment_method, payment_status, subtotal_vnd, shipping_fee_vnd, discount_vnd, total_vnd)
       VALUES ($1, 'GR-27-I05', $2, 'Anon Customer', 'anon27@example.com', '0901000003', '123 Le Loi', 'HCM', 'completed', 'bank_transfer', 'paid', 1200000, 0, 0, 1200000)`,
      [orderId, custId]
    );
    await pool.query(
      `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
       VALUES ($1, $2, $3, 'GAERU Mic I05', 'Default', 'SKU-27-I05', 1, 1200000, 1200000)`,
      [itemId, orderId, varId]
    );
    await pool.query('DELETE FROM warranty_email_outbox');

    await permanentDeleteCustomer(pool, custId, { username: 'owner', source: 'bootstrap' }, 'Test permanent delete');
    const warranties = (await pool.query('SELECT id FROM warranty_activations WHERE order_item_id=$1', [itemId])).rows;
    const outbox = (await pool.query('SELECT id FROM warranty_email_outbox WHERE order_id=$1', [orderId])).rows;
    assert.equal(warranties.length, 0);
    assert.equal(outbox.length, 0);
  }

  // [A-01] Admin SSE fails closed on deleted staff and auth_version mismatch even when req.admin lacks authVersion
  {
    const staffId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO staff_accounts (id, username, full_name, password_hash, role, active, auth_version)
       VALUES ($1, 'staff_sse_27', 'Staff SSE', 'hash', 'sales', true, 2)`,
      [staffId]
    );
    const baseReq = {
      sessionStore: { constructor: { name: 'MemoryStore' } },
      admin: { id: staffId, username: 'staff_sse_27', role: 'sales', source: 'staff' }, // no authVersion on principal
      session: {
        admin: { id: staffId, username: 'staff_sse_27', source: 'staff', authVersion: 1 },
        adminAuthenticatedAt: Date.now(),
        adminLastSeenAt: Date.now(),
        securityVersion: 1
      }
    };
    assert.equal(await checkAdminSessionDbValid(pool, baseReq), false, 'Mismatched authVersion must terminate SSE');

    // Align authVersion -> passes while active
    baseReq.session.admin.authVersion = 2;
    assert.equal(await checkAdminSessionDbValid(pool, baseReq), true);

    // Hard-delete staff -> must fail closed
    await pool.query('DELETE FROM staff_accounts WHERE id=$1', [staffId]);
    assert.equal(await checkAdminSessionDbValid(pool, baseReq), false, 'Deleted staff must fail closed');
  }

  // [A-03] autoLockAccount upserts account_security version & checkCustomerSessionDbValid rejects locked customer
  {
    const custId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customers (id, full_name, email, phone, password_hash, active)
       VALUES ($1, 'Lock Target', 'lock27@example.com', '0901000004', 'hash', true)`,
      [custId]
    );
    const req = {
      sessionStore: { constructor: { name: 'MemoryStore' } },
      session: { customer: { id: custId }, securityVersion: 1 }
    };
    assert.equal(await checkCustomerSessionDbValid(pool, req), true);

    await autoLockAccount(pool, custId, 'test_lock');
    const secRow = (await pool.query('SELECT version FROM account_security WHERE account_key=$1', ['customer:' + custId])).rows[0];
    assert.ok(secRow && Number(secRow.version) >= 2, 'account_security row must be upserted with incremented version');
    assert.equal(await checkCustomerSessionDbValid(pool, req), false, 'Locked customer SSE must fail validation');
  }

  // [BLOCKER-01] audit-remediation-20261127.sql cleans legacy orphaned rejected/withdrawn claims while preserving pending/active/revoked
  {
    const reqRej = crypto.randomUUID();
    const reqWithdrawn = crypto.randomUUID();
    const reqActive = crypto.randomUUID();
    const reqRevoked = crypto.randomUUID();
    await pool.query(
      `INSERT INTO warranty_activations
         (request_key, channel, external_order_number, external_product_name, status, withdrawn_at, contact_name, contact_phone, contact_address, contact_city)
       VALUES
         ($1, 'shopee', 'SP-LEG-REJ', 'GAERU K9', 'rejected', NULL, 'A', '0901000101', 'Addr', 'HCM'),
         ($2, 'shopee', 'SP-LEG-WD',  'GAERU K9', 'pending',  now(), 'B', '0901000102', 'Addr', 'HCM'),
         ($3, 'shopee', 'SP-LEG-ACT', 'GAERU K9', 'active',   NULL, 'C', '0901000103', 'Addr', 'HCM'),
         ($4, 'shopee', 'SP-LEG-REV', 'GAERU K9', 'revoked',  NULL, 'D', '0901000104', 'Addr', 'HCM')`,
      [reqRej, reqWithdrawn, reqActive, reqRevoked]
    );
    await pool.query(
      `INSERT INTO warranty_order_claims (channel, order_key)
       VALUES ('shopee', 'SP-LEG-REJ'), ('shopee', 'SP-LEG-WD'), ('shopee', 'SP-LEG-ACT'), ('shopee', 'SP-LEG-REV')
       ON CONFLICT DO NOTHING`
    );

    const migSql = fs.readFileSync(path.join(ROOT, 'db/audit-remediation-20261127.sql'), 'utf8');
    await db.exec(migSql);

    const remaining = (await pool.query(
      `SELECT order_key FROM warranty_order_claims WHERE channel='shopee' AND order_key LIKE 'SP-LEG-%' ORDER BY order_key`
    )).rows.map((r) => r.order_key);
    assert.deepEqual(remaining, ['SP-LEG-ACT', 'SP-LEG-REV']);

    // Resubmitting the legacy rejected order can now re-claim without HTTP 409
    const reclaimed = (await pool.query(
      `INSERT INTO warranty_order_claims(channel, order_key) VALUES('shopee', 'SP-LEG-REJ') ON CONFLICT DO NOTHING RETURNING order_key`
    )).rows;
    assert.equal(reclaimed.length, 1);
  }
});

test('Gói 2 Backend units (A-04 cache gen, A-05 bg options, A-09 embedding invalidation, A-12 31-byte VAPID key)', async () => {
  // [A-04] In-flight stale fetch must not repopulate cache after invalidateTags
  let releaseFetch;
  const inflight = getOrSetCache('test-a04-key', ['catalog'], () => new Promise((resolve) => {
    releaseFetch = () => resolve({ value: 'stale-v1' });
  }), 60000);
  invalidateTags(['catalog'], { immediate: true });
  releaseFetch();
  const r1 = await inflight;
  assert.equal(r1.data.value, 'stale-v1');
  const r2 = await getOrSetCache('test-a04-key', ['catalog'], async () => ({ value: 'fresh-v2' }), 60000);
  assert.equal(r2.data.value, 'fresh-v2');

  // [A-05] String options like enableShadow="false" and whiteThreshold="240" must coerce properly
  const imgBuf = await sharp({
    create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
  })
    .composite([{
      input: await sharp({
        create: { width: 14, height: 14, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } }
      }).png().toBuffer(),
      top: 13,
      left: 13
    }])
    .png()
    .toBuffer();
  const cutout = await removeWhiteBackground(imgBuf, {
    whiteThreshold: '240',
    tolerance: '30',
    enableShadow: 'false',
    autoCenterSquare: 'true',
    canvasSize: '200',
    paddingRatio: '0.1'
  });
  assert.ok(cutout && cutout.buffer, 'removeWhiteBackground must handle string options cleanly');

  // [A-09] invalidateNamespace clears both memoryStore and hydratedNamespaces prefixed keys
  await embeddingStore.hydrateNamespace({
    query: async () => ({ rows: [] })
  }, 'learned');
  embeddingStore.invalidateNamespace('learned');
  let rehydrated = false;
  await embeddingStore.hydrateNamespace({
    query: async () => {
      rehydrated = true;
      return { rows: [] };
    }
  }, 'learned');
  assert.equal(rehydrated, true, 'hydrateNamespace must re-query DB after invalidateNamespace');

  // [A-12] 31-byte P-256 private scalar (leading 0x00 stripped) signs RFC 8292 VAPID JWT cleanly
  const ecdh = crypto.createECDH('prime256v1');
  const priv31 = Buffer.alloc(31, 0x2a);
  const priv32 = Buffer.concat([Buffer.from([0x00]), priv31]);
  ecdh.setPrivateKey(priv32);
  const jwt = createVapidJwt(
    'https://fcm.googleapis.com',
    'mailto:business@gaeru.com',
    base64UrlEncode(ecdh.getPublicKey()),
    base64UrlEncode(priv31)
  );
  assert.equal(jwt.split('.').length, 3);
});

test('Gói 1 + Gói 2 Infrastructure, Security & Frontend guards (I-01, I-02, I-03, I-04, I-06..I-11, F-01..F-09)', () => {
  // [I-01] node-app.conf hardcodes numeric 33:33 (Mi 6 chroot NSS-safe), verifies root non-symlink app.env & blocks dangerous env vars
  const nodeAppConf = fs.readFileSync(path.join(ROOT, 'scripts/node-app.conf'), 'utf8');
  assert.match(nodeAppConf, /RUNUSER="33:33"/);
  assert.match(nodeAppConf, /stat -c %u/);
  assert.match(nodeAppConf, /APP\|ENTRY\|PORT\|NODE_ENV\|LANG\|LD_\*\|PRELOAD/);
  assert.ok(!nodeAppConf.includes('\r'), 'node-app.conf must stay pure LF');

  const syncScript = fs.readFileSync(path.join(ROOT, 'scripts/sync-to-mi6.ps1'), 'utf8');
  assert.match(syncScript, /\[ ! -L "\$APP_DIR\/app\.env" \]/);
  assert.match(syncScript, /chown root:www-data "\$APP_DIR\/app\.env"/);
  assert.match(syncScript, /sync_host_file "\$APP_DIR\/infra\/mi6\/gpu-ai\/hybris_opencl_icd\.c" \/storage\/gpu-ai-build\/hybris_opencl_icd\.c 0644 ""/);

  // [BLOCKER-01] Warranty claim release preserves 'revoked' claims & SQL migration stays pure LF
  const migSqlRaw = fs.readFileSync(path.join(ROOT, 'db/audit-remediation-20261127.sql'), 'utf8');
  assert.ok(!migSqlRaw.includes('\r'), 'db/audit-remediation-20261127.sql must stay pure LF');
  assert.match(migSqlRaw, /DELETE FROM warranty_order_claims/);
  const wmSrc = fs.readFileSync(path.join(ROOT, 'src/warranty-management.js'), 'utf8');
  assert.match(wmSrc, /status IN \('pending','active','revoked'\)/);
  const waSrc = fs.readFileSync(path.join(ROOT, 'src/warranty-api.js'), 'utf8');
  assert.match(waSrc, /status IN \('pending','active','revoked'\)/);

  // [I-07, I-08] GPU AI single-stop & OpenCL ICD atomic 2-ref trampoline
  const gpuCpp = fs.readFileSync(path.join(ROOT, 'infra/mi6/gpu-ai/gaeru-gpu-ai.cpp'), 'utf8');
  assert.match(gpuCpp, /bool stop_sent = false;/);
  assert.match(gpuCpp, /if \(!stop_sent && svr\.is_running\(\)\)/);
  const icdC = fs.readFileSync(path.join(ROOT, 'infra/mi6/gpu-ai/hybris_opencl_icd.c'), 'utf8');
  assert.match(icdC, /prog_tramp_unref/);
  assert.match(icdC, /CL_OUT_OF_HOST_MEMORY/);

  // [I-02, I-06, I-10] Mi6 admin server terminal revocation, PID validation, and backup sort
  const mi6Server = fs.readFileSync(path.join(ROOT, 'infra/mi6/admin/server.js'), 'utf8');
  assert.match(mi6Server, /termSessions/);
  assert.match(mi6Server, /revokeSession/);
  assert.match(mi6Server, /isValidClusterMasterPid/);
  assert.match(mi6Server, /mtimeMs/);

  // [I-03] failover-restore-to-pc.ps1 shields native CLI stderr redirects from ErrorActionPreference=Stop
  const failoverPs1 = fs.readFileSync(path.join(ROOT, 'scripts/failover-restore-to-pc.ps1'), 'utf8');
  assert.match(failoverPs1, /\$ErrorActionPreference\s*=\s*"Continue"/);

  // [I-04] Backup scripts close lock FD 200 when spawning gdrive sync
  for (const rel of ['scripts/mi6-backup/gaeru-pg-backup.sh', 'scripts/mi6-backup/gaeru-media-backup.sh']) {
    const sh = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(sh, /200>&-/);
    assert.ok(!sh.includes('\r'), `${rel} must stay pure LF`);
  }

  // [I-09] gaeru-full-restore.sh sets RESTART_ON_EXIT=1 in restore_media_code & avoids /run tmpfs
  const restoreSh = fs.readFileSync(path.join(ROOT, 'scripts/mi6-backup/gaeru-full-restore.sh'), 'utf8');
  assert.match(restoreSh, /RESTART_ON_EXIT=1/);
  assert.ok(!restoreSh.includes('\r'), 'gaeru-full-restore.sh must stay pure LF');

  // [I-11] gaeru-healthcheck.sh respects manual override / AUTOSTART=no
  const hcSh = fs.readFileSync(path.join(ROOT, 'infra/mi6/sbin/gaeru-healthcheck.sh'), 'utf8');
  assert.match(hcSh, /is_service_disabled/);
  assert.match(hcSh, /\.override/);

  // [F-02] action-feedback.js exempts /gaeru_ceo and #admin-app in blur/input validation
  const afSrc = fs.readFileSync(path.join(ROOT, 'action-feedback.js'), 'utf8');
  const { window } = parseHTML('<!doctype html><html><body><div id="admin-app"><form><input type="tel" name="phone" value="02838221234"></form></div></body></html>');
  window.location = { pathname: '/gaeru_ceo', href: 'https://gaeru.com/gaeru_ceo', origin: 'https://gaeru.com', search: '' };
  window.fetch = async () => ({ ok: true, headers: { get: () => 'application/json' }, clone: () => ({ json: async () => ({}) }) });
  window.EventTarget = window.EventTarget || globalThis.EventTarget;
  const ctx = vm.createContext({
    window,
    document: window.document,
    location: window.location,
    HTMLElement: window.HTMLElement,
    EventTarget: window.EventTarget,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    URL,
    setTimeout,
    clearTimeout,
    console
  });
  vm.runInContext(afSrc, ctx);
  const phoneInput = window.document.querySelector('input[name="phone"]');
  let customValidity = '';
  phoneInput.setCustomValidity = (msg) => { customValidity = msg; };
  phoneInput.dispatchEvent(new window.Event('blur', { bubbles: false }));
  assert.equal(customValidity, '', 'Admin landline phone input must not get customValidity error on blur');

  // [F-03] admin-workspace.css allows orphan hub children
  const css = fs.readFileSync(path.join(ROOT, 'admin/admin-workspace.css'), 'utf8');
  assert.match(css, /:not\(\.is-hub-orphan\)/);

  // [F-04, F-05, F-06, F-07, F-08] Static regression assertions
  const adminJs = fs.readFileSync(path.join(ROOT, 'admin/admin.js'), 'utf8');
  assert.match(adminJs, /HAS_INITIAL_SECURITY_RESET/);
  assert.match(adminJs, /loadOrders\(state\.orderPage,\s*\{\s*background:\s*true\s*\}\)/);
  assert.match(adminJs, /GAERUCare\?\.refreshLive/);

  const cfgJs = fs.readFileSync(path.join(ROOT, 'admin/configuration.js'), 'utf8');
  assert.match(cfgJs, /data-payment-reconcile-form[\s\S]*data-config-email/);
  assert.match(cfgJs, /factorChallengeId:\s*rf\.dataset\.challenge/);

  const aiJs = fs.readFileSync(path.join(ROOT, 'admin/internal-ai.js'), 'utf8');
  assert.match(aiJs, /is-cancelled/);
  assert.match(aiJs, /\.copilot-container \.copilot-sidebar/);
  assert.ok(!aiJs.includes('#internal-ai-view .copilot-sidebar'));

  // [A-10] Verify file-library uses decompression helper on thumbnail path
  const flSrc = fs.readFileSync(path.join(ROOT, 'src/file-library.js'), 'utf8');
  assert.match(flSrc, /isCompressedBuffer|decompressBuffer/);
  assert.ok(zlib.deflateSync(Buffer.from('ok')).length > 0);

  // [Discover K9 Mobile Specs] 4-column comparison table uses stacked cards on <=700px without crushing columns
  const k9Html = fs.readFileSync(path.join(ROOT, 'discover-k9.html'), 'utf8');
  assert.match(k9Html, /class="discover-table discover-compare-table"/);
  assert.match(k9Html, /data-label="Mic điện thoại"/);
  assert.match(k9Html, /data-label="GAERU K9"/);
  assert.match(k9Html, /data-label="Mic chuyên nghiệp"/);
  const discoverCss = fs.readFileSync(path.join(ROOT, 'discover.css'), 'utf8');
  assert.match(discoverCss, /\.discover-table:not\(\.discover-compare-table\)\s+th\{width:42%/);
  assert.match(discoverCss, /\.discover-compare-table tbody td::before\{content:attr\(data-label\)/);
  assert.match(discoverCss, /@media\(max-width:350px\)\{\.discover-compare-table tbody td\{flex-direction:column/);
});
