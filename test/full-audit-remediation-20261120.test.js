'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Smooth Curtain Animation: Menu, Search and Cart use GPU-composited top-down clip-path + translate3d glide', () => {
  const styles = read('styles.css');
  const shell = read('store-shell.js');

  assert.match(styles, /clip-path:\s*inset\(0 0 100% 0\)/, 'Closed panel must start clipped from top');
  assert.match(styles, /clip-path:\s*inset\(0 0 0% 0\)/, 'Open panel must unroll downward smoothly');
  assert.match(styles, /cubic-bezier\(\.22,\s*1,\s*\.36,\s*1\)/, 'Open curtain must use smooth deceleration curve');
  assert.match(styles, /cubic-bezier\(\.4,\s*0,\s*\.2,\s*1\)/, 'Close curtain must use smooth acceleration curve');
  assert.match(styles, /\.nav-panel\.cart-panel/, 'Cart panel must share smooth curtain animation');
  assert.match(styles, /prefers-reduced-motion:\s*reduce[\s\S]*clip-path:\s*none/, 'Reduced motion must disable curtain clip-path');
  assert.doesNotMatch(styles, /\.cart-signin-message a[\s\S]{0,200}backdrop-filter:\s*blur/, 'Cart signin CTA must not trigger blur storm');

  assert.match(shell, /closeTimer\s*=\s*(?:window\.)?setTimeout\(/, 'store-shell.js must keep closing panel mounted until transition ends');
  assert.match(shell, /gaeru:cart-updated/, 'store-shell.js must sync fallback badge on gaeru:cart-updated');
  assert.match(shell, /panel\.id\s*===\s*"cart-panel"[\s\S]{0,120}gaeru:cart-panel-open/, 'gaeru:cart-panel-open must dispatch only for cart-panel');
  assert.doesNotMatch(shell, /void\s+panel\.offsetWidth/, 'store-shell.js must never force synchronous reflow');
});

test('Storefront P0/P1 fixes: inert guard, subnav hash rewrite, dark-mode contrast, chat retry, warranty CLS, lazy VN addresses', () => {
  const customerJs = read('customer-experience.js');
  assert.match(customerJs, /hasDialogBody/, 'settingsDialog must not open modal when content is empty');
  assert.match(customerJs, /_gaeruAddressCleanup/, 'address dialog must clean up window/document listeners');

  const prodJs = read('product-experience.js');
  const prodCss = read('product-experience.css');
  assert.match(prodJs, /data-nav-target/, 'product subnav must handle clean-URL rewritten hash links');
  assert.match(prodJs, /requestAnimationFrame/, 'product scroll handler must be rAF-throttled');
  assert.doesNotMatch(prodCss, /\.product-local-subnav[\s\S]{0,300}backdrop-filter:\s*blur\(20px\)/, 'subnav must not use heavy 20px backdrop blur');
  assert.match(prodCss, /prefers-color-scheme:\s*dark[\s\S]*\.detail-more/, 'OS dark mode contrast must be preserved');

  const servicesJs = read('product-services.js');
  assert.match(servicesJs, /if\s*\(!dialog\.open\)/, 'openChat must guard showModal against already-open dialog');
  assert.doesNotMatch(servicesJs, /window\.alert\(/, 'product-services.js must not use raw window.alert');

  const careCss = read('care.css');
  assert.match(careCss, /#warranty-activation\[data-standalone="true"\][\s\S]{0,120}min-height:\s*740px/, 'Standalone warranty page must reserve height to prevent CLS');

  const vnJs = read('vietnam-address.js');
  assert.match(vnJs, /\[name="city"\],\[data-delivery-city\]/, 'vietnam-address.js must lazy-load only on pages with city fields');

  const payResJs = read('payment-result.js');
  assert.match(payResJs, /payment-result-actions/, 'payment-result.js must render navigation actions for all states');

  const productGuides = read('src/product-guides.js');
  assert.match(productGuides, /\/ho-tro\/san-pham\/:slug/, 'product-guides.js must route /ho-tro/san-pham/:slug directly without redirect loop');
});

test('Admin Portal P0/P1 fixes: barcode dispatch reset, business submitter lock, table scroll, AI toast visibility & GPU pulse dots', () => {
  const barcodeJs = read('admin/barcode.js');
  assert.match(barcodeJs, /dispatchBtn\.style\.display\s*=\s*state\.verificationStatus\s*===\s*"dispatched"\s*\?\s*"none"\s*:\s*""/, 'barcode.js must reset dispatch button visibility between orders');
  assert.doesNotMatch(barcodeJs, /\bwindow\.alert\(/, 'barcode.js must not call raw window.alert');

  const businessJs = read('admin/business.js');
  assert.match(businessJs, /event\.submitter/, 'business.js must lock actual submit button');
  assert.match(businessJs, /dataset\.saving/, 'business.js must guard concurrent form submit');

  const refineCss = read('admin/admin-refinement.css');
  assert.match(refineCss, /\.enterprise-table-wrap,\s*\.variant-table-wrap[\s\S]{0,120}overflow-x:\s*auto/, 'Admin tables must allow horizontal scrolling');

  const ordersCss = read('admin/orders-workspace.css');
  assert.doesNotMatch(ordersCss, /#orders-view\s+\.orders-table-scroll\s*\{\s*overflow-x:\s*hidden/, 'Orders table must not clip actions at 1000-1080px');

  const aiCss = read('admin/internal-ai.css');
  assert.doesNotMatch(aiCss, /#gaeru-ai-modal:not\(\[hidden\]\)\)\s+\.gaeru-action-notices/, 'Action toasts must remain visible when GAERU AI modal is open');

  const aiJs = read('admin/internal-ai.js');
  assert.match(aiJs, /Promise\.resolve\(false\)/, 'deleteCurrentThread must fail-closed if confirm modal is unavailable');

  const wsCss = read('admin/admin-workspace.css');
  const admCss = read('admin/admin.css');
  assert.doesNotMatch(wsCss, /@keyframes\s+(?:healthPulse|trafficPulse|liveDotPulse)[\s\S]{0,220}box-shadow:/, 'Admin pulse animations must not repaint box-shadow');
  assert.doesNotMatch(admCss, /@keyframes\s+realtime-pulse[\s\S]{0,220}box-shadow:/, 'Realtime badge dot must not repaint box-shadow');
});

test('Backend P1: order-workflow enforces order_reviews after targetStatus resolution and allocates stock when owner completes pending COD', async () => {
  const { createOrderWorkflow } = require('../src/order-workflow');
  let reservedCalls = 0;
  const mockInventory = {
    async reserveStock() { reservedCalls++; },
    async releaseOrderStock() {}
  };
  const mockFinance = {
    async receiptTotal() { return 0; },
    async recordFullOrderPayment() {}
  };
  const wf = createOrderWorkflow({
    inventory: mockInventory,
    finance: mockFinance,
    audit: async () => {},
    checkoutAccounts: true
  });

  // Case 1: Pre-paid bank transfer with unresolved order_review must NOT auto-upgrade to processing via paymentStatus='paid'
  const unreviewedClient = {
    async query(sql) {
      if (sql.includes('SELECT * FROM orders WHERE id=$1 FOR UPDATE')) {
        return {
          rows: [{
            id: '11111111-1111-4111-8111-111111111111',
            order_number: 'GR-TEST-01',
            status: 'pending',
            payment_method: 'bank_transfer',
            payment_status: 'pending',
            subtotal_vnd: 500000,
            shipping_fee_vnd: 0,
            discount_vnd: 0,
            total_vnd: 500000,
            return_completed_at: null
          }]
        };
      }
      if (sql.includes('FROM order_reviews')) {
        return { rows: [{ order_id: '11111111-1111-4111-8111-111111111111' }] };
      }
      return { rows: [] };
    }
  };
  await assert.rejects(
    () => wf.applyOrderUpdate(unreviewedClient, '11111111-1111-4111-8111-111111111111', { paymentStatus: 'paid' }, { role: 'owner', username: 'ceo', permissions: ['*'] }),
    (err) => err.status === 409 && /chờ xác minh/.test(err.message)
  );

  // Case 2: Owner marking pending COD as paid (jumps to completed) MUST still reserve stock if unallocated
  const ownerCodClient = {
    async query(sql) {
      if (sql.includes('SELECT * FROM orders WHERE id=$1 FOR UPDATE')) {
        return {
          rows: [{
            id: '22222222-2222-4222-8222-222222222222',
            order_number: 'GR-TEST-02',
            status: 'pending',
            payment_method: 'cod',
            payment_status: 'pending',
            subtotal_vnd: 300000,
            shipping_fee_vnd: 0,
            discount_vnd: 0,
            total_vnd: 300000,
            return_completed_at: null,
            customer_id: null
          }]
        };
      }
      if (sql.includes('FROM order_reviews')) return { rows: [] };
      if (sql.includes('FROM carrier_shipments')) return { rows: [] };
      if (sql.includes('FROM order_stock_allocations')) return { rows: [] };
      if (sql.includes('FROM warehouses')) return { rows: [{ id: 'wh-1' }] };
      if (sql.includes('FROM order_items')) return { rows: [{ variant_id: 'v-1', quantity: 2 }] };
      if (sql.includes('UPDATE orders SET')) {
        return {
          rows: [{
            id: '22222222-2222-4222-8222-222222222222',
            orderNumber: 'GR-TEST-02',
            status: 'completed',
            paymentStatus: 'paid',
            shippingFeeVnd: 0,
            totalVnd: 300000
          }]
        };
      }
      return { rows: [] };
    }
  };
  const updated = await wf.applyOrderUpdate(
    ownerCodClient,
    '22222222-2222-4222-8222-222222222222',
    { paymentStatus: 'paid' },
    { role: 'owner', source: 'bootstrap', username: 'ceo', permissions: ['*'] }
  );
  assert.equal(updated.status, 'completed');
  assert.equal(reservedCalls, 1, 'Jumping pending COD -> completed must reserve unallocated stock');
});

test('Backend P1: adminPolicy allows PATCH /orders/:id through so accountant payments.write is enforced by route/workflow', () => {
  const { adminPolicy } = require('../src/admin-policy');
  let nextCalled = false;
  let statusSent = null;
  const req = {
    path: '/orders/11111111-1111-4111-8111-111111111111',
    method: 'PATCH',
    admin: { role: 'staff', permissions: ['orders.read', 'payments.write'] }
  };
  const res = {
    status(code) { statusSent = code; return { json() {} }; }
  };
  adminPolicy(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'PATCH /orders/:id must pass adminPolicy for fine-grained orders.write/payments.write check');
  assert.equal(statusSent, null);
});

test('Backend P1: permanently deleting a shipped order does NOT phantom-restock warehouse inventory', async () => {
  const { deleteOrderPermanently } = require('../src/order-deletion');
  let releasedCount = 0;
  const mockInventory = {
    async releaseOrderStock() { releasedCount++; }
  };
  const makeClient = (status) => ({
    async query(sql) {
      if (sql.includes('SELECT * FROM orders WHERE id = $1 FOR UPDATE')) {
        return {
          rows: [{
            id: '33333333-3333-4333-8333-333333333333',
            order_number: 'GR-SHIP-01',
            status,
            payment_status: 'pending',
            customer_id: null,
            return_completed_at: null
          }]
        };
      }
      if (sql.includes('DELETE FROM orders WHERE id = $1')) {
        return { rows: [{ id: '33333333-3333-4333-8333-333333333333', order_number: 'GR-SHIP-01' }] };
      }
      return { rows: [] };
    }
  });

  await deleteOrderPermanently(makeClient('shipped'), '33333333-3333-4333-8333-333333333333', {
    actor: { role: 'owner', source: 'bootstrap', username: 'ceo' },
    inventory: mockInventory
  });
  assert.equal(releasedCount, 0, 'Deleting a shipped order must not inflate warehouse stock');

  await deleteOrderPermanently(makeClient('processing'), '33333333-3333-4333-8333-333333333333', {
    actor: { role: 'owner', source: 'bootstrap', username: 'ceo' },
    inventory: mockInventory
  });
  assert.equal(releasedCount, 1, 'Deleting a processing order still in warehouse must release stock');
});

test('Backend P1/P2: SSE public tag scrubbing, zxing gzip compression, readiness-gate CSP, and responsive k9/footer/banner AVIF', () => {
  const { filterPublicCacheTags } = require('../src/realtime-sse');
  const filtered = filterPublicCacheTags(['orders', 'order:11111111-1111-4111-8111-111111111111', 'finance', 'settings', 'catalog', 'stock', 'product:gaeru-k9', 'promotions']);
  assert.deepEqual(filtered, ['catalog', 'stock', 'product:gaeru-k9', 'promotions']);

  const { shouldCompress } = require('../src/lib/public-compression');
  const mockRes = {
    headers: { 'content-type': 'text/javascript; charset=utf-8' },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    setHeader(name, val) { this.headers[name.toLowerCase()] = val; }
  };
  assert.equal(shouldCompress({ originalUrl: '/gaeru_ceo/assets/zxing-browser.min.js', headers: {} }, mockRes), true, 'zxing-browser.min.js must compress with gzip');

  const { setReady, readinessMiddleware, resetReadinessForTesting } = require('../src/lib/readiness-gate');
  setReady(false);
  try {
    const headers = {};
    let sentStatus = null, sentBody = '';
    const res = {
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      status(c) { sentStatus = c; return this; },
      type() { return this; },
      send(b) { sentBody = b; return this; }
    };
    readinessMiddleware({ path: '/', accepts: (t) => t === 'html' }, res, () => {});
    assert.equal(sentStatus, 503);
    assert.equal(headers['refresh'], '2');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.match(headers['content-security-policy'], /default-src 'none'/);
    assert.doesNotMatch(sentBody, /<script/i, '503 maintenance page must not contain inline scripts');
  } finally {
    resetReadinessForTesting();
  }

  const { renderHomeBanner } = require('../src/home-banner');
  const bannerHtml = renderHomeBanner({
    enabled: true,
    version: 3,
    desktopImageId: '11111111-1111-4111-8111-111111111111',
    mobileImageId: '22222222-2222-4222-8222-222222222222',
    alt: 'GAERU Hero Banner',
    href: '/cua-hang',
    desktop: { width: 1600, height: 600 },
    mobile: { width: 800, height: 600 }
  });
  assert.match(bannerHtml, /type="image\/avif"[\s\S]*format=avif&w=1600/, 'Home banner must offer AVIF desktop source');
  assert.match(bannerHtml, /type="image\/avif"[\s\S]*format=avif&w=800/, 'Home banner must offer AVIF mobile source');

  const { SITE_FOOTER_HTML } = require('../src/site-footer');
  assert.match(SITE_FOOTER_HTML, /gaeru-logo\.avif/, 'Footer logo must include AVIF source');
  assert.match(SITE_FOOTER_HTML, /aria-label="Địa chỉ email nhận bản tin GAERU"/, 'Footer newsletter input must have accessible aria-label');

  const { document } = parseHTML('<html><head></head><body><main><img src="/assets/products/k9-description/1.webp" alt="K9"></main></body></html>');
  require('../src/responsive-images').apply(document);
  const k9Pic = document.querySelector('picture');
  assert.ok(k9Pic, 'k9-description image must be wrapped in responsive <picture>');
  assert.match(k9Pic.querySelector('source[type="image/avif"]')?.getAttribute('srcset') || '', /1-w480\.avif 480w/);

  const { MIGRATION_FILES } = require('../src/migrate');
  assert.ok(MIGRATION_FILES.includes('audit-hot-indexes-20261120.sql'), 'Hot index migration must be registered in MIGRATION_FILES');
});
