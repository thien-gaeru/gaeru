'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('2026-11-23 Full Audit Wave 1: Shopping Chat CRDT v3 cart integration and Markdown link whitelist', () => {
  const chatJs = read('shopping-chat-client.js');
  const commerceJs = read('commerce.js');
  const publicFilesJs = read('src/public-files.js');

  // 1. SAFE_CHAT_ACTION_URL must allow /care, /dang-ky-bao-hanh, /tra-cuu-don-hang, /tai-khoan, /tin-tuc
  assert.match(chatJs, /SAFE_CHAT_ACTION_URL\s*=\s*\/\^\\\/\(\?:thanh-toan[\s\S]*care\(\?:#\[a-z0-9-\]\+\)\?\|dang-ky-bao-hanh/);
  // 2. [data-chat-add-variant] must use GAERUStore.readCart/writeCart or v3 CRDT ops (/api/customer/cart/sync), never destructive PUT /api/customer/cart
  assert.doesNotMatch(chatJs, /request\('\/api\/customer\/cart',\s*\{method:'PUT'/);
  assert.match(chatJs, /window\.GAERUStore\?\.readCart/);
  assert.match(chatJs, /\/api\/customer\/cart\/sync/);
  // 3. commerce.js exports readCart, writeCart, shippingPresentation on window.GAERUStore
  assert.match(commerceJs, /window\.GAERUStore\s*=\s*Object\.freeze\(\{[\s\S]*readCart,[\s\S]*writeCart,[\s\S]*shippingPresentation,/);
  // 4. guide-p185.html is included in public-files allowlist
  assert.ok(publicFilesJs.includes('"guide-p185.html"'));
});

test('2026-11-23 Full Audit Wave 2: Admin RBAC permanent delete guard, MISA notice target alias, and enterprise multi-page variant lookup', () => {
  const adminJs = read('admin/admin.js');
  const enterpriseJs = read('admin/enterprise.js');
  const internalAiJs = read('admin/internal-ai.js');
  const bannerJs = read('admin/marketing-home-banner.js');

  assert.match(adminJs, /can\("customers\.permanent_delete"\)\s*\?\s*`<button class="danger-button" type="button" data-customer-permanent-delete=/);
  assert.match(adminJs, /if\s*\(view\s*===\s*"business"\)\s*return\s*activateView\("invoice"/);
  assert.match(enterpriseJs, /for\s*\(let\s+page\s*=\s*2;\s*page\s*<=\s*totalPages;\s*page\+\+\)\s*pages\.push\(api\(`\/products\?page=\$\{page\}`\)\)/);
  assert.match(internalAiJs, /data-id="\$\{escapeAttr\(t\.id\)\}"/);
  assert.match(internalAiJs, /data-action-id="\$\{escapeAttr\(card\.actionId\)\}"/);
  assert.match(bannerJs, /PNG, JPG, WebP, AVIF tối đa 8MB/);
});

test('2026-11-23 Full Audit Wave 3: Backend RMA notifications, batch exchange query, SQL bytea filter, and hot indexes', () => {
  const noticeFeedJs = read('src/admin-notice-feed.js');
  const rmaExchangeJs = read('src/rma-exchange.js');
  const afterSalesJs = read('src/order-after-sales.js');
  const retentionJs = read('src/shopping-chat-file-retention.js');
  const hotIndexesSql = read('db/audit-hot-indexes-20261120.sql');

  assert.match(noticeFeedJs, /FROM order_after_sales a JOIN orders o ON o\.id=a\.order_id WHERE a\.status IN \('requested','approved'\)/);
  assert.match(rmaExchangeJs, /async function readIssuesBatch\(client, caseIds\)/);
  assert.match(afterSalesJs, /rmaExchange\.readIssuesBatch\(pool,/);
  assert.match(retentionJs, /position\(convert_to\(\$1,'UTF8'\) in content\)>0/);
  assert.match(hotIndexesSql, /idx_order_after_sales_order_id_created/);
  assert.match(hotIndexesSql, /idx_orders_lower_email/);
  assert.match(hotIndexesSql, /idx_orders_customer_created_desc/);
});

test('2026-11-23 Full Audit Wave 4: Inventory operations, stock changes, L1 cache invalidations, and adjustment UX', () => {
  const operationsApiJs = read('src/operations-api.js');
  const inventoryJs = read('src/inventory.js');
  const barcodeApiJs = read('src/barcode-api.js');
  const enterpriseJs = read('admin/enterprise.js');

  // 1. operations-api.js invalidates L1 cache on adjustments, transfers, and PO receipts
  const invInvalidations = operationsApiJs.match(/invalidateTags\(\["product:list",\s*"catalog",\s*"search-index",\s*"stock"\]/g) || [];
  assert.equal(invInvalidations.length, 3);

  // 2. inventory.js prioritizes active and MAIN warehouses when reducing stock via setVariantStock
  assert.match(inventoryJs, /SELECT s\.warehouse_id AS "warehouseId",s\.quantity,w\.active,w\.code FROM warehouse_stock s/);
  assert.match(inventoryJs, /const orderedBalances = \[\.\.\.balances\]\.sort/);

  // 3. No broken require('../cache') remains inside src/*.js
  for (const rel of ['src/barcode-api.js', 'src/customer-experience.js', 'src/finance-api.js', 'src/omnichannel-sync.js', 'src/order-after-sales.js', 'src/shipping-management.js']) {
    assert.doesNotMatch(read(rel), /require\(['"]\.\.\/cache['"]\)/, `${rel} must use require('./cache')`);
  }
  assert.match(barcodeApiJs, /require\('\.\/cache'\)\.flushAllCache\(\)/);

  // 4. enterprise.js auto-loads movement history on loadInventory and auto-fills expectedQuantity on variant/warehouse change
  assert.match(enterpriseJs, /loadMovements\(\)\.catch\(\(\)\s*=>\s*\{\}\)/);
  assert.match(enterpriseJs, /\[data-e-form="adjustment"\]\s*\[name="variantId"\]/);
});

test('2026-11-23 Full Audit Wave 5: Top-layer dialog stacking, RegExp /v pattern escape, CARE+ single-message upload, SSE sender filtering, RMA exchange restock, and RamCache dispose', () => {
  const enterpriseJs = read('admin/enterprise.js');
  const adminHtml = read('admin/index.html');
  const careJs = read('admin/care.js');
  const careApiJs = read('src/care-api.js');
  const adminJs = read('admin/admin.js');
  const afterSalesJs = read('src/order-after-sales.js');
  const ramCacheJs = read('src/lib/ram-cache.js');
  const serverJs = read('src/server.js');
  const storeApiJs = read('src/store-api.js');
  const bundlesJs = read('src/product-bundles.js');

  // 1. RegExp /v pattern hyphen escaped in enterprise.js and admin/index.html
  assert.match(enterpriseJs, /pattern="\[A-Z0-9_\\\\-\]\+"/);
  assert.match(adminHtml, /pattern="\[a-zA-Z0-9\._\\-\]\+"/);

  // 2. Top-layer confirm dialog promotion and inventory filter reset in enterprise.js
  assert.match(enterpriseJs, /dialog\.enterprise-confirm-dialog\[open\]/);
  assert.match(enterpriseJs, /warehouseFilter\.value = selected/);

  // 3. CARE+ file upload updates status & response atomically without double PATCH
  assert.match(careJs, /fd\.append\('status',form\.elements\.status\.value\)/);
  assert.match(careApiJs, /UPDATE care_requests SET status=\$2,response=\$3,version=version\+1/);

  // 4. Admin SSE deduplicates chat events and suppresses customer-message toast for staff/AI senders
  assert.match(adminJs, /const normEvent = event === 'shopping_chat:message' \? 'chat:message' : event/);
  assert.match(adminJs, /const isStaffOrAi = \['admin', 'staff', 'ai', 'system'\]/);

  // 5. After-sales refund after 1-1 RMA exchange restocks replacement items and RamCache cleans tagIndex on dispose
  assert.match(afterSalesJs, /FROM rma_exchange_issues i/);
  assert.match(ramCacheJs, /dispose:\s*\(entry,\s*key\)\s*=>/);
  assert.match(serverJs, /attachTransactionalCacheInvalidation\(lowPriorityPool\)/);
  assert.match(storeApiJs, /semanticSearchCache\.clear\(\)/);
  assert.match(bundlesJs, /AND v\.active = true AND p\.active = true AND p\.deleted_at IS NULL/);
});

test('2026-11-23 Full Audit Wave 6 (U1-U4): AI Chat fast-read guard, DB hot indexes, waybill stock allocation, batch N+1 queries, disk media migration, and searchable SKU picker', () => {
  const aiChatJs = read('src/shopping-chat-ai-first.js');
  const hotIndexesSql = read('db/audit-hot-indexes-20261120.sql');
  const shippingJs = read('src/shipping-management.js');
  const warrantyApiJs = read('src/warranty-api.js');
  const marketingJs = read('src/marketing.js');
  const rmaExchangeJs = read('src/rma-exchange.js');
  const storedMediaJs = read('src/lib/stored-media.js');
  const enterpriseJs = read('admin/enterprise.js');

  // U1: Fast-read guard before opening transaction & new hot indexes
  assert.match(aiChatJs, /SELECT EXISTS \(SELECT 1 FROM shopping_chat_ai_jobs WHERE status='pending'/);
  assert.match(hotIndexesSql, /idx_shopping_chat_ai_jobs_active/);
  assert.match(hotIndexesSql, /idx_audit_events_created_id_desc/);

  // U2: Waybill stock allocation on pending order, SSE invalidation, and warranty email worker nudge
  assert.match(shippingJs, /SELECT 1 FROM order_stock_allocations WHERE order_id = \$1 AND released_at IS NULL/);
  assert.match(warrantyApiJs, /nudgeWarrantyEmailWorker\?\.\(\)/);

  // U3: Batch ANY($1::uuid[]) queries in marketing quote and rma-exchange
  assert.match(marketingJs, /WHERE v\.id=ANY\(\$1::uuid\[\]\) AND v\.active=true/);
  assert.match(rmaExchangeJs, /WHERE v\.product_id=ANY\(\$1::uuid\[\]\) AND v\.active=true/);

  // U4: Legacy bytea blob migration to disk & searchable SKU picker in enterprise.js
  assert.match(storedMediaJs, /async function migrateLegacyBlobsToDisk\(pool\)/);
  assert.match(enterpriseJs, /data-e-sku-filter/);
});

test('2026-11-24 Wave 7: Article image permission guard, non-cacheable error response hardening, and admin news thumbnails', () => {
  const fsMediaJs = read('src/lib/filesystem-media.js');
  const renditionsJs = read('src/lib/image-renditions.js');
  const appJs = read('src/app.js');
  const mediaAuditJs = read('src/media-storage-audit.js');
  const adminNewsJs = read('admin/news.js');

  // 1. Public media scopes use 0o644 and match parent directory owner when executed as root
  assert.match(fsMediaJs, /async function matchDirOwner\(handle,dir\)/);
  assert.match(fsMediaJs, /const fileMode=\['chat','care','documents'\]\.includes\(scope\)\?0o600:0o644/);
  assert.match(mediaAuditJs, /if\(st\.uid!==dirSt\.uid\|\|st\.gid!==dirSt\.gid\)await handle\.chown\(dirSt\.uid,dirSt\.gid\)/);

  // 2. sendPublicImage resolves readMedia bytes BEFORE setting Cache-Control/ETag/Content-Type headers
  const rawIdx = renditionsJs.indexOf('const bytes = process.env.MEDIA_CACHE_ENABLED');
  const headerIdx = renditionsJs.indexOf('res.type(row.mime_type).set(buildImageHeaders(rawEtag, requestedFormat === \'avif\'))');
  assert.ok(rawIdx > 0 && headerIdx > rawIdx, 'readMedia must resolve before setting public cache headers');

  // 3. Global error handler strips ETag and enforces Cache-Control: no-store and application/json
  assert.match(appJs, /res\.removeHeader\('ETag'\)/);
  assert.match(appJs, /res\.set\('Cache-Control', 'no-store, no-cache, must-revalidate'\)/);

  // 4. Admin news table displays cover image thumbnail preview per article row and uses hasMore pagination flag
  assert.match(adminNewsJs, /width="64" height="40" loading="lazy"/);
  assert.match(adminNewsJs, /data\.hasMore===false\|\|rows\.length<25/);

  // 5. Periodic checkout intent sweep, forecast PO random fallback, and admin request default AbortSignal timeout
  const serverJs = read('src/server.js');
  const forecastJs = read('src/inventory-forecast.js');
  const adminJs = read('admin/admin.js');
  assert.match(serverJs, /releaseExpiredCheckoutIntents\(lowPriorityPool\)/);
  assert.match(forecastJs, /attempt >= 18/);
  assert.match(adminJs, /AbortSignal\.timeout\(30000\)/);
});

test('2026-11-24 Wave 8: Mobile & legacy device compatibility (iOS 12-15.8 / Android 7-10 / Safari WebKit)', async () => {
  const vm = require('vm');
  const actionJs = read('action-feedback.js');
  const careCss = read('care.css');
  const warrantyJs = read('warranty.js');
  const internalAiCss = read('admin/internal-ai.css');
  const internalAiJs = read('admin/internal-ai.js');
  const adminMobileCss = read('admin/admin-mobile.css');
  const accountSecCss = read('account-security.css');
  const stylesCss = read('styles.css');

  // 1. Execute action-feedback.js polyfill block inside a stripped legacy browser VM
  const polyfillEnd = actionJs.indexOf('const add = EventTarget.prototype.addEventListener;');
  assert.ok(polyfillEnd > 500, 'action-feedback.js must begin with legacy browser polyfills');
  const polyfillSrc = actionJs.slice(0, polyfillEnd) + '})();';

  const FakeUnknownProto = {};
  const createdEls = [];
  const docListeners = {};
  class FakeEvent { constructor(type, opts) { this.type = type; this.cancelable = Boolean(opts && opts.cancelable); } }
  const makeFakeEl = (tag) => {
    const attrs = new Map();
    const classes = new Set();
    const el = Object.create(tag === 'dialog' ? FakeUnknownProto : Object.prototype);
    el.tagName = tag.toUpperCase();
    el.setAttribute = (k, v) => attrs.set(k, String(v));
    el.removeAttribute = (k) => attrs.delete(k);
    el.hasAttribute = (k) => attrs.has(k);
    el.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) };
    el.addEventListener = () => {};
    el.dispatchEvent = () => true;
    el.remove = () => {};
    return el;
  };
  const bodyChildren = [];
  const fakeDoc = {
    body: { appendChild: (c) => bodyChildren.push(c) },
    documentElement: {
      appendChild: () => {},
      classList: { add: () => {}, remove: () => {}, contains: () => false }
    },
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    createElement: (tag) => { const el = makeFakeEl(tag); el.style = {}; el.scrollHeight = 1; el.appendChild = () => {}; createdEls.push(el); return el; },
    addEventListener: (ev, fn) => { docListeners[ev] = fn; },
    querySelectorAll: () => createdEls.filter((el) => el.tagName === 'DIALOG' && el.hasAttribute('open') && el.classList.contains('gaeru-dialog-polyfilled'))
  };

  class FakeElement {}
  const sandbox = {
    window: {},
    document: fakeDoc,
    Element: FakeElement,
    Event: FakeEvent,
    AbortController,
    AbortSignal: {},
    crypto: { getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = (i * 37 + 11) & 0xff; return arr; } },
    setTimeout,
    clearTimeout,
    DOMException
  };
  const ctx = vm.createContext(sandbox);
  // Strip modern globals inside the isolated realm to simulate iOS 12 / Android 7
  vm.runInContext(`
    delete Object.hasOwn;
    delete Object.fromEntries;
    delete Promise.allSettled;
    delete Array.prototype.at;
    delete Array.prototype.flat;
    delete Array.prototype.flatMap;
    delete String.prototype.at;
    delete String.prototype.replaceAll;
  `, ctx);
  vm.runInContext(polyfillSrc, ctx);

  const checks = await vm.runInContext(`(async () => {
    const hasOwnOk = Object.hasOwn({ a: 1 }, 'a') === true && Object.hasOwn({ a: 1 }, 'toString') === false;
    const fromEntriesOk = Object.fromEntries([['k', 42]]).k === 42;
    const settled = await Promise.allSettled([Promise.resolve('ok'), Promise.reject('err')]);
    const settledOk = settled[0].status === 'fulfilled' && settled[1].status === 'rejected';
    const atOk = [10, 20, 30].at(-1) === 30 && 'gaeru'.at(-1) === 'u';
    const flatOk = [1, [2, [3]]].flat(2).join(',') === '1,2,3' && [1, 2].flatMap(x => [x, x * 2]).join(',') === '1,2,2,4';
    const replaceAllOk = 'a-b-c'.replaceAll('-', '_') === 'a_b_c';
    const replaceChildrenOk = typeof Element.prototype.replaceChildren === 'function';
    const cssEscapeOk = typeof window.CSS?.escape === 'function' && window.CSS.escape('1a:b') === '\\\\31 a\\\\:b';
    const uuid = crypto.randomUUID();
    const uuidOk = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid);
    const sig = AbortSignal.timeout(50);
    const abortOk = Boolean(sig && typeof sig.aborted === 'boolean');
    const dlg = document.createElement('dialog');
    dlg.showModal();
    const dlgOpenOk = dlg.open === true && dlg.hasAttribute('open');
    dlg.close('done');
    const dlgCloseOk = dlg.open === false && dlg.returnValue === 'done';
    return { hasOwnOk, fromEntriesOk, settledOk, atOk, flatOk, replaceAllOk, replaceChildrenOk, cssEscapeOk, uuidOk, abortOk, dlgOpenOk, dlgCloseOk };
  })()`, ctx);
  for (const [k, v] of Object.entries(checks)) {
    assert.strictEqual(v, true, 'Legacy polyfill failed: ' + k);
  }

  // 1b. Zero fatal iOS <= 16.3 RegExp lookbehind, iOS < 14 logical assignment, or numeric separators in client JS
  for (const dir of [ROOT, path.join(ROOT, 'admin')]) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.doesNotMatch(src, /\(\?<[=!]/, `${f} must not use RegExp lookbehind (crashes iOS <= 16.3 at parse time)`);
      assert.doesNotMatch(src, /(?:\|\|=|&&=|\?\?=)/, `${f} must not use logical assignment ||= &&= ??= (crashes iOS < 14 / Chrome < 85)`);
      assert.doesNotMatch(src, /\b\d+_\d+\b/, `${f} must not use numeric separators (crashes iOS < 13 / Chrome < 75)`);
    }
  }
  assert.match(read('action-feedback.css'), /dialog\.gaeru-dialog-polyfilled\.quick-cart-premium\[open\]/);

  // 2. Screenshot #1 fix: GAERU AI mobile modal respects safe areas, avoids 100vh overflow, syncs visualViewport
  assert.doesNotMatch(internalAiCss, /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.gaeru-ai-modal-dialog\s*\{[^}]*height:\s*100vh;/);
  assert.match(internalAiCss, /env\(safe-area-inset-top/);
  assert.match(internalAiCss, /env\(safe-area-inset-bottom/);
  assert.match(internalAiCss, /body\.gaeru-ai-modal-open/);
  assert.match(internalAiJs, /syncModalVisualViewport/);
  assert.match(internalAiJs, /window\.visualViewport/);

  // 3. Screenshot #2 fix: Warranty/Care/Security fieldsets avoid display:grid on <fieldset> & fix iOS date input
  assert.doesNotMatch(careCss, /(?:#warranty-form|#care-form)\s+fieldset\s*\{[^}]*display\s*:\s*grid/);
  assert.match(careCss, /#warranty-form\s+legend\{[^}]*float:none;width:100%/);
  assert.match(careCss, /input\[type="date"\]::-webkit-date-and-time-value/);
  assert.match(warrantyJs, /class="warranty-fieldset-body"/);
  assert.doesNotMatch(accountSecCss, /\.security-form\s+fieldset\s*\{[^}]*display\s*:\s*grid/);
  assert.match(adminMobileCss, /padding-top:calc\(10px \+ env\(safe-area-inset-top,0px\)\)/);
  assert.match(adminMobileCss, /\.admin-shell input\[type=date\]/);

  // 4. CSS legacy fallbacks across all storefront & admin stylesheets (no unfallback dvh or overflow-x:clip)
  assert.match(stylesCss, /-webkit-clip-path:/);
  const cssDirs = [ROOT, path.join(ROOT, 'admin')];
  for (const dir of cssDirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.css')) continue;
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (/\d+dvh\b/.test(line)) {
          const prev = lines[idx - 1] || '';
          assert.ok(/\d+vh\b|100%/.test(line) || /\d+vh\b|100%/.test(prev), `${f}:${idx + 1} uses dvh without vh/100% fallback`);
        }
        if (/overflow-x\s*:\s*clip\b/.test(line)) {
          const prev = lines[idx - 1] || '';
          assert.ok(/overflow-x\s*:\s*hidden/.test(line) || /overflow-x\s*:\s*hidden/.test(prev), `${f}:${idx + 1} uses overflow-x:clip without hidden fallback`);
        }
        assert.doesNotMatch(line, /rgb\(\s*\d+\s+\d+\s+\d+\s*\//, `${f}:${idx + 1} must use standard rgba() instead of space-separated rgb(r g b / a)`);
      });
    }
  }
});

test('2026-11-24 Wave 9: Premium quick-add-to-cart modal renders images, prices, Flash Sale/promotions, variant switcher & quantity stepper', () => {
  const vm = require('vm');
  const { parseHTML } = require('linkedom');
  const commerceSrc = read('commerce.js');
  const quickCss = read('quick-purchase.css');
  const checkoutFlow = require('../checkout-flow.js');

  assert.match(quickCss, /\.quick-cart-dialog\.quick-cart-premium/);
  assert.match(quickCss, /\.quick-cart-premium \.qc-promo-card/);
  assert.match(quickCss, /\.quick-cart-premium \.qc-variant-grid/);
  // Prevent iOS WebKit <dialog> collapse to 2px white line: never use height:100% or min-height:0 on .qc-shell
  assert.doesNotMatch(quickCss, /\.quick-cart-premium \.qc-shell\s*\{[^}]*height:\s*100%/);
  assert.doesNotMatch(quickCss, /\.quick-cart-premium \.qc-shell\s*\{[^}]*min-height:\s*0/);
  assert.match(quickCss, /\.quick-cart-dialog\.quick-cart-premium\[open\]\s*\{[^}]*display:\s*block/);

  const fixtureProducts = [{
    slug: 'gaeru-m3',
    name: 'GAERU M3',
    cardTitle: 'GAERU M3',
    descriptor: 'MIC KHÔNG DÂY CÀI ÁO CÓ HỘP SẠC CAO CẤP',
    cardSummary: 'Micro hộp sạc màn hình pin thông minh.',
    imageUrl: '/assets/products/m3-home-cutout.webp',
    gallery: ['/assets/products/m3-home-cutout.webp'],
    optionGroups: [{ name: 'Cổng kết nối', values: ['Type C', 'Type C + đầu chuyển Lightning'] }],
    variants: [
      {
        id: 'm3-v1', sku: 'M3-01', name: 'Type C', priceVnd: 840000, originalPriceVnd: 1200000,
        stockQuantity: 10, active: true, imageUrl: '/api/catalog-images/11111111-1111-4111-8111-111111111111',
        options: { 'Cổng kết nối': 'Type C' },
        promotion: { id: 'promo-1', title: 'Flash Sale 30%', type: 'flash', endsAt: '2026-11-30T05:16:00.000Z' }
      },
      {
        id: 'm3-v2', sku: 'M3-G4', name: 'Type C + đầu chuyển Lightning', priceVnd: 890000, originalPriceVnd: 1250000,
        stockQuantity: 5, active: true, imageUrl: '/api/catalog-images/22222222-2222-4222-8222-222222222222',
        options: { 'Cổng kết nối': 'Type C + đầu chuyển Lightning' },
        promotion: { id: 'promo-1', title: 'Flash Sale 30%', type: 'flash', endsAt: '2026-11-30T05:16:00.000Z' }
      }
    ]
  }];

  const { document, window } = parseHTML('<!doctype html><html><body><button type="button" data-choose-cart="gaeru-m3">Thêm vào giỏ hàng</button></body></html>');
  const origCreateElement = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = origCreateElement(tag);
    if (tag.toLowerCase() === 'dialog') {
      el.showModal = function () { this.open = true; this.setAttribute('open', ''); };
      el.close = function () { this.open = false; this.removeAttribute('open'); };
    }
    return el;
  };
  let savedCart = [];
  let navigated = null;
  const ctx = {
    window,
    document,
    location: { assign: (u) => { navigated = u; } },
    products: fixtureProducts,
    escapeHtml: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    formatPrice: (n) => `${new Intl.NumberFormat('vi-VN').format(n)} ₫`,
    cartRows: (items) => items.map((it) => {
      const p = fixtureProducts[0];
      const v = p.variants.find((x) => x.id === it.variantId);
      return v ? { variantId: it.variantId, quantity: it.quantity, product: p, variant: v } : null;
    }).filter(Boolean),
    readCart: () => savedCart.map((i) => ({ ...i })),
    writeCart: (next) => { savedCart = next.map((i) => ({ ...i })); return true; },
    CustomEvent: window.CustomEvent || class CustomEvent { constructor(t) { this.type = t; } },
    setTimeout,
    clearTimeout
  };
  vm.createContext(ctx);
  const bindStart = commerceSrc.indexOf('function bindGlobalControls(');
  const bindEnd = commerceSrc.indexOf('function updateSaleCountdowns()', bindStart);
  vm.runInContext(commerceSrc.slice(bindStart, bindEnd) + '\nbindGlobalControls();', ctx);

  // Open modal: initial image MUST be main product cover image and NO variant is pre-selected
  document.querySelector('[data-choose-cart]').dispatchEvent(new window.Event('click', { bubbles: true }));
  const dlg = document.querySelector('#quick-cart-dialog');
  assert.ok(dlg && dlg.classList.contains('quick-cart-premium'), 'Premium quick-cart dialog must open');
  assert.equal(dlg.querySelector('[data-qc-image]').getAttribute('src'), '/assets/products/m3-home-cutout.webp', 'Initial modal image must be the main product image');
  assert.equal(dlg.querySelectorAll('[data-qc-variant-id][aria-pressed="true"]').length, 0, 'Multi-variant modal must not pre-select an option');
  assert.equal(dlg.querySelector('[data-add-to-cart]').disabled, true, 'Add button stays disabled until user selects a variant');
  assert.equal(dlg.querySelector('[data-quick-buy-now]').disabled, true, 'Buy now button stays disabled until user selects a variant');
  assert.match(dlg.querySelector('[data-qc-price]').textContent, /840\.000/);
  assert.match(dlg.querySelector('[data-qc-orig]').textContent, /1\.200\.000/);
  assert.equal(dlg.querySelector('[data-qc-discount]').textContent, '-30%');
  assert.match(dlg.querySelector('[data-qc-savings]').textContent, /360\.000/);
  assert.equal(dlg.querySelector('[data-qc-sale-bar]').hidden, false);
  assert.ok(dlg.querySelector('.qc-promo-strip'), 'Compact icon-only promotion strip must render');
  assert.match(dlg.querySelector('[data-qc-promo-text]').textContent, /Flash Sale -30%/);
  assert.equal(dlg.querySelectorAll('.qc-variant-card').length, 2);

  // Switch to second variant & increment qty to 2
  dlg.querySelector('[data-qc-variant-id="m3-v2"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(dlg.querySelector('[data-qc-image]').getAttribute('src'), '/api/catalog-images/22222222-2222-4222-8222-222222222222');
  assert.equal(dlg.querySelector('[data-add-to-cart]').disabled, false, 'Add button enables after selecting a variant');
  assert.equal(dlg.querySelector('[data-quick-buy-now]').disabled, false, 'Buy now button enables after selecting a variant');
  assert.match(dlg.querySelector('[data-qc-price]').textContent, /890\.000/);
  dlg.querySelector('[data-qc-qty-inc]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(dlg.querySelector('[data-qc-qty-value]').textContent, '2');
  assert.match(dlg.querySelector('[data-qc-subtotal]').textContent, /1\.780\.000/);
  assert.equal(dlg.querySelector('[data-add-to-cart]').dataset.addQty, '2');

  // Add to cart writes exact qty=2 for variant m3-v2
  dlg.querySelector('[data-add-to-cart]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.deepEqual(savedCart, [{ variantId: 'm3-v2', quantity: 2 }]);

  // Checkout direct selection honors qty param clamped to stock
  const sel = checkoutFlow.selection(fixtureProducts, '?variant=m3-v2&qty=3');
  assert.deepEqual(sel, { direct: true, items: [{ variantId: 'm3-v2', quantity: 3 }] });
  const clamped = checkoutFlow.selection(fixtureProducts, '?variant=m3-v2&qty=99');
  assert.deepEqual(clamped, { direct: true, items: [{ variantId: 'm3-v2', quantity: 5 }] });
});
