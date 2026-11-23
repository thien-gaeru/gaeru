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
