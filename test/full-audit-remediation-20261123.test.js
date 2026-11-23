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
