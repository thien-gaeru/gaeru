'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { once } = require('node:events');
const { PGlite } = require('@electric-sql/pglite');
const { parseHTML } = require('linkedom');

const ROOT = path.join(__dirname, '..');
const { migrateDatabase } = require('../src/migrate');
const payments = require('../src/payment-channels');
const { renderStorefrontErrorHtml } = require('../src/error-pages');
const {
  earnPoints,
  refundPoints,
  previewEarnClawback,
  expireDueLoyaltyPoints
} = require('../src/loyalty-api');
const { createWarrantyAdminApi } = require('../src/warranty-api');

test('P1.1 & P1.5: CSP connect-src authorizes VietQR downloads and error pages include interactive footer scripts', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
  const connectSrcLine = appSource.split('\n').find(line => line.includes('connectSrc:'));
  assert.ok(connectSrcLine, 'connectSrc directive must exist in src/app.js');
  assert.ok(connectSrcLine.includes('https://img.vietqr.io'), 'connectSrc must allow https://img.vietqr.io for QR blob downloads');

  const html404 = renderStorefrontErrorHtml({ status: 404, title: 'Không tìm thấy sản phẩm' });
  assert.match(html404, /\/action-feedback\.js/);
  assert.match(html404, /\/action-feedback\.css/);
  assert.match(html404, /\/product-services\.js/);
});

test('P1.2: bank_transfer channel verification enforces >= 16-char webhookSecret consistently with callback validator', async () => {
  const baseBank = {
    bankName: 'Vietcombank',
    accountNumber: '0123456789',
    accountHolder: 'HO KINH DOANH GAERU',
    transferSyntax: 'GAERU {MA_DON}',
    enabled: true
  };
  await assert.rejects(
    () => payments.verifyPaymentChannel('bank_transfer', { ...baseBank, webhookSecret: 'short-890123' }),
    err => err.status === 400 && /16 ký tự/.test(err.message)
  );
  const validAuto = await payments.verifyPaymentChannel('bank_transfer', {
    ...baseBank,
    webhookSecret: 'secret-at-least-16-chars'
  });
  assert.equal(validAuto.webhookConfigured, true);
  const manualOnly = await payments.verifyPaymentChannel('bank_transfer', { ...baseBank, webhookSecret: '' });
  assert.equal(manualOnly.webhookConfigured, false);
});

test('P1.3, P1.4 & P2.4: DB warranty excludes legacy pending accessories, admin blocks accessory approval, and loyalty expiry/clawback stay consistent', async (t) => {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise(r => { release = r; });
    await previous;
    return release;
  }
  async function rawQuery(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try { return await rawQuery(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      return { query: rawQuery, release };
    },
    end: () => db.close()
  };
  t.after(() => pool.end());
  await migrateDatabase(pool);

  // 1. Loyalty clawback preview ignores expired points and refund clears expires_at on zero balance
  const custId = randomUUID();
  const orderId = randomUUID();
  await pool.query(
    `INSERT INTO customers (id, full_name, email, phone, password_hash, active)
     VALUES ($1, 'Khách Kiểm Toán', $2, '0912345678', 'x', true)`,
    [custId, `audit-${custId}@example.com`]
  );
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_id, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, payment_method, payment_status, status)
     VALUES ($1, 'GR-20261126-AUD1', $2, 'Khách Kiểm Toán', 'a@example.com', '0912345678', '1 Đường A', 'Hà Nội', 1000000, 0, 1000000, 'cod', 'paid', 'completed')`,
    [orderId, custId]
  );
  await earnPoints(pool, { customerId: custId, orderId, orderTotalVnd: 1000000 });

  // Simulate points expired 1 minute ago before background sweep
  await pool.query("UPDATE customer_loyalty SET expires_at = now() - interval '1 minute' WHERE customer_id = $1", [custId]);
  const previewUnlocked = await previewEarnClawback(pool, { customerId: custId, orderId, lock: false });
  assert.equal(previewUnlocked.currentBalance, 0, 'Unlocked clawback preview must treat expired points as 0');
  assert.equal(previewUnlocked.shortfallPoints, 10000);

  // Restore non-expired balance, then refund earned points down to 0 -> expires_at must become NULL
  await pool.query("UPDATE customer_loyalty SET expires_at = now() + interval '30 days' WHERE customer_id = $1", [custId]);
  await refundPoints(pool, { customerId: custId, orderId, reason: 'Trả hàng lỗi kỹ thuật' });
  const afterRefund = (await pool.query('SELECT points_balance, expires_at FROM customer_loyalty WHERE customer_id = $1', [custId])).rows[0];
  assert.equal(afterRefund.points_balance, 0);
  assert.equal(afterRefund.expires_at, null, 'Zero-balance loyalty row must clear expires_at');

  // Batch expiry sweep (>100 rows)
  for (let i = 0; i < 105; i++) {
    const cid = randomUUID();
    await pool.query(
      `INSERT INTO customers (id, full_name, email, phone, password_hash, active)
       VALUES ($1, 'Batch User', $2, $3, 'x', true)`,
      [cid, `batch-${i}-${cid}@example.com`, `0987${String(i).padStart(6, '0')}`]
    );
    await pool.query(
      `INSERT INTO customer_loyalty (customer_id, points_balance, lifetime_earned, lifetime_spent, tier, expires_at)
       VALUES ($1, 500, 500, 0, 'bronze', now() - interval '2 days')`,
      [cid]
    );
  }
  const swept = await expireDueLoyaltyPoints(pool);
  assert.equal(swept, 105, 'expireDueLoyaltyPoints must drain >100 expired accounts in batches');

  // 2. Legacy pending automatic warranty on accessory does NOT activate on order completion
  const accProdId = randomUUID();
  const accVarId = randomUUID();
  const accOrderId = randomUUID();
  const accItemId = randomUUID();
  await pool.query(
    `INSERT INTO products (id, slug, name, category, descriptor, description, image_url, image_alt, active)
     VALUES ($1, 'gaeru-p185', 'GAERU P185', 'accessory', 'Tripod', 'Desc', '/assets/products/p185.webp', 'P185', true)`,
    [accProdId]
  );
  await pool.query(
    `INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, $2, 'SKU-P185-AUD', 'Tiêu chuẩn', 450000, 10, true)`,
    [accVarId, accProdId]
  );
  await pool.query(
    `INSERT INTO orders (id, order_number, customer_id, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, payment_method, payment_status, status)
     VALUES ($1, 'GR-20261126-ACC1', $2, 'Khách Kiểm Toán', 'a@example.com', '0912345678', '1 Đường A', 'Hà Nội', 450000, 0, 450000, 'cod', 'pending', 'pending')`,
    [accOrderId, custId]
  );
  await pool.query(
    `INSERT INTO order_items (id, order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES ($1, $2, $3, 'GAERU P185', 'Tiêu chuẩn', 'SKU-P185-AUD', 1, 450000, 450000)`,
    [accItemId, accOrderId, accVarId]
  );
  const legacyAutoId = randomUUID();
  await pool.query(
    `INSERT INTO warranty_activations (id, customer_id, order_item_id, request_key, automatic, unit_number, status, contact_name, contact_phone, contact_address, contact_city)
     VALUES ($1, $2, $3, $4, true, 1, 'pending', 'Khách', '0912345678', '1 Đường A', 'Hà Nội')`,
    [legacyAutoId, custId, accItemId, randomUUID()]
  );
  await pool.query("UPDATE orders SET status = 'completed', payment_status = 'paid' WHERE id = $1", [accOrderId]);
  await pool.query('SELECT sync_website_warranty($1)', [accOrderId]);
  const legacyRow = (await pool.query('SELECT status FROM warranty_activations WHERE id = $1', [legacyAutoId])).rows[0];
  assert.notEqual(legacyRow.status, 'active', 'Accessory pending automatic warranty must never transition to active');

  // 3. Admin manual PATCH /warranties/:id blocks approving accessory warranty
  const manualAccId = randomUUID();
  await pool.query(
    `INSERT INTO warranty_activations (id, request_key, automatic, status, channel, external_order_number, external_product_name, contact_name, contact_phone, contact_address, contact_city)
     VALUES ($1, $2, false, 'pending', 'shopee', 'SPX-P185-001', 'Gậy chụp hình GAERU P185', 'Khách Sàn', '0912345678', '1 Đường A', 'Hà Nội')`,
    [manualAccId, randomUUID()]
  );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { admin: { id: 'adm', username: 'owner', role: 'owner', permissions: ['warranty.approve'] } };
    req.admin = req.session.admin;
    req.headers['x-csrf-token'] = require('../src/security').getCsrfToken(req);
    next();
  });
  app.use('/api/gaeru_ceo', createWarrantyAdminApi(pool));
  const srv = app.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  t.after(() => new Promise(resolve => srv.close(resolve)));
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/gaeru_ceo/warranties/${manualAccId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'active', purchaseDate: '2026-11-20', reason: 'Kiểm tra duyệt phụ kiện', version: 1 })
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /phụ kiện/i);
});

test('P2 & P3: Admin safe JSON parse, keepalive, soft-delete guards, touchstart rail, hidden scrollbars & policy commerce sync', () => {
  const mktJs = fs.readFileSync(path.join(ROOT, 'admin/marketing.js'), 'utf8');
  assert.match(mktJs, /parseCartItems/);
  assert.doesNotMatch(mktJs, /JSON\.parse\(c\.items\|\|'\[\]'\)\.map/);

  const editorJs = fs.readFileSync(path.join(ROOT, 'admin/product-editor.js'), 'utf8');
  assert.match(editorJs, /fetch\('\/api\/auth\/me'/);

  for (const rel of ['src/customer-experience.js', 'src/marketing.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /FROM customers WHERE (?:id|lower\(email\))=\$1 AND active=true(?!\s+AND deleted_at IS NULL)/);
  }

  // Verify news rail touchstart pauses cleanly and pointer-focus on card without :focus-visible does not lock autoplay
  const { document, window } = parseHTML('<html><body><button data-news-autoplay hidden></button><div data-news-strip><a class="news-card" href="/tin-tuc/a">A</a><a class="news-card" href="/tin-tuc/b">B</a></div></body></html>');
  const rail = document.querySelector('[data-news-strip]');
  Object.defineProperties(rail, { scrollWidth: { value: 700 }, clientWidth: { value: 350 }, scrollLeft: { value: 0, writable: true } });
  [0, 350].forEach((off, idx) => Object.defineProperty(rail.children[idx], 'offsetLeft', { value: off }));
  rail.scrollTo = ({ left }) => { rail.scrollLeft = left; };
  let tick = null, resume = null;
  window.matchMedia = q => ({ matches: q === '(min-width: 0px)', addEventListener() {}, removeEventListener() {} });
  window.IntersectionObserver = undefined;
  window.setInterval = fn => (tick = fn, 1);
  window.clearInterval = () => { tick = null; };
  window.setTimeout = fn => (resume = fn, 2);
  window.clearTimeout = () => { resume = null; };
  delete require.cache[require.resolve('../auto-product-rail')];
  require('../auto-product-rail').mountNews(window);
  assert.equal(typeof tick, 'function');
  rail.children[0].matches = () => false;
  const focusEvt = new window.Event('focusin', { bubbles: true });
  rail.children[0].dispatchEvent(focusEvt);
  assert.equal(typeof tick, 'function', 'Non-keyboard focus on news card must not freeze autoplay permanently');
  rail.dispatchEvent(new window.Event('touchstart'));
  assert.equal(tick, null, 'touchstart must pause news rail temporarily');
  resume();
  assert.equal(typeof tick, 'function', 'news rail must resume after interaction timeout');

  const stylesCss = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const qpCss = fs.readFileSync(path.join(ROOT, 'quick-purchase.css'), 'utf8');
  assert.match(stylesCss, /\.filter-row::-webkit-scrollbar\s*\{\s*display:\s*none;\s*\}/);
  assert.match(qpCss, /\.quick-cart-premium \.qc-thumbs::-webkit-scrollbar\s*\{\s*display:\s*none;\s*\}/);

  for (const f of ['complaints.html', 'delivery-returns.html', 'gaeru-xu.html', 'legal.html', 'payment.html', 'pricing.html', 'privacy.html', 'terms.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(html, /data-policy-commerce="\/commerce\.js\?v=20261125-qc-compact"/, `${f} must match unified commerce.js version`);
  }
});
