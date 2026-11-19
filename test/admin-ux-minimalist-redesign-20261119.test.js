'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('Package 1: Sidebar 5-group domain IA, Hub sub-tabs, Morning Briefing & collapsible Diagnostics Drawer', () => {
  const html = fs.readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
  const uiJs = fs.readFileSync(path.join(ROOT, 'admin/admin-ui.js'), 'utf8');
  const wsCss = fs.readFileSync(path.join(ROOT, 'admin/admin-workspace.css'), 'utf8');
  const mobCss = fs.readFileSync(path.join(ROOT, 'admin/admin-mobile.css'), 'utf8');
  const enterpriseJs = fs.readFileSync(path.join(ROOT, 'admin/enterprise.js'), 'utf8');

  // 5 semantic groups exist
  assert.ok(html.includes('data-nav-group="sales"'));
  assert.ok(html.includes('data-nav-group="care"'));
  assert.ok(html.includes('data-nav-group="inventory"'));
  assert.ok(html.includes('data-nav-group="finance"'));
  assert.ok(html.includes('data-nav-group="organization"'));

  // Marketplace & Reports moved into Sales group
  const salesBlock = html.slice(html.indexOf('data-nav-group="sales"'), html.indexOf('data-nav-group="care"'));
  assert.ok(salesBlock.includes('data-view="marketplace"'), 'Marketplace belongs in Sales');
  assert.ok(salesBlock.includes('data-view="reports"'), 'Business reports belong in Sales');

  // Secondary sibling views marked as hub children & Hub Tab Switcher exists
  assert.ok(html.includes('id="admin-hub-tabs"'));
  for (const child of ['loyalty', 'warehouses', 'suppliers', 'tax', 'pages', 'file-library', 'departments', 'audit', 'security', 'oauth']) {
    assert.match(html, new RegExp(`data-view="${child}"[^>]*data-hub-child="`), `${child} should be marked data-hub-child`);
  }
  assert.ok(uiJs.includes('const HUBS = ['));
  assert.ok(uiJs.includes('function syncHubTabs()'));

  // Sidebar live badges for warranty & care + no duplicate PWA install button in topbar
  assert.ok(html.includes('data-warranty-nav-badge'));
  assert.ok(html.includes('data-care-nav-badge'));
  const pwaInstallCount = (html.match(/data-pwa-install-action/g) || []).length;
  assert.equal(pwaInstallCount, 1, 'Only one PWA install trigger should exist (no topbar duplicate)');

  // Morning Briefing 4 actionable cards & collapsible diagnostics drawer
  assert.ok(html.includes('class="action-queue-grid"'));
  assert.ok(html.includes('id="pending-warranty-count"'));
  assert.ok(html.includes('id="pending-care-count"'));
  assert.ok(html.includes('id="overview-diagnostics-drawer"'));

  // Inventory SKU rows no longer expose dangerous full-product deletion button
  assert.ok(!enterpriseJs.includes('data-e-trash-product="${index}"'), 'Inventory SKU rows must not expose Xóa sản phẩm');

  // Desktop button size normalized (no global 16px button bloat)
  assert.ok(mobCss.includes('.admin-shell .view-panel button,.admin-shell .view-panel .row-button{font-size:13.5px;line-height:1.4}'));
  assert.ok(wsCss.includes('.admin-hub-tabs'));
});

test('Package 2: 3-tier Orders Workspace, Floating Bulk Bar, One-Stop Modal Print & Quick Advance', () => {
  const html = fs.readFileSync(path.join(ROOT, 'admin/index.html'), 'utf8');
  const adminJs = fs.readFileSync(path.join(ROOT, 'admin/admin.js'), 'utf8');
  const ordersCss = fs.readFileSync(path.join(ROOT, 'admin/orders-workspace.css'), 'utf8');

  assert.ok(html.includes('class="orders-utility-strip"'));
  assert.ok(html.includes('class="orders-export-menu"'));
  assert.ok(html.includes('class="orders-unified-toolbar filter-bar order-filters"'));
  assert.ok(html.includes('class="order-bulk-actions is-empty"'));

  assert.ok(adminJs.includes('data-modal-print="invoice"'), 'Order modal header includes In phiếu button');
  assert.ok(adminJs.includes('data-modal-print="label"'), 'Order modal header includes In tem button');
  assert.ok(adminJs.includes('data-quick-advance'), 'Order modal includes 1-click quick advance');
  assert.ok(adminJs.includes('data-inline-review-form'), 'Order modal includes inline phone review resolution');
  assert.ok(adminJs.includes("classList.toggle('is-empty', count === 0)"), 'Bulk action bar hides when 0 orders selected');
  assert.ok(!adminJs.includes('title="Xóa vĩnh viễn đơn hàng này"'), 'Order table rows must not expose raw Xóa vĩnh viễn button');
  assert.ok(ordersCss.includes('#orders-view .order-bulk-actions.is-empty'));
});

test('Package 3: Warranty 1-click quick approve & bulk spam clean, Product Editor identity-first, Marketing modal overlay', () => {
  const warrantyJs = fs.readFileSync(path.join(ROOT, 'admin/warranty.js'), 'utf8');
  const editorHtml = fs.readFileSync(path.join(ROOT, 'admin/product-editor.html'), 'utf8');
  const marketingJs = fs.readFileSync(path.join(ROOT, 'admin/marketing.js'), 'utf8');
  const wsCss = fs.readFileSync(path.join(ROOT, 'admin/admin-workspace.css'), 'utf8');
  const storeApi = fs.readFileSync(path.join(ROOT, 'src/store-api.js'), 'utf8');

  assert.ok(warrantyJs.includes('data-w-quick-approve'));
  assert.ok(warrantyJs.includes('data-w-quick-reject'));
  assert.ok(warrantyJs.includes('data-w-bulk-delete-spam'));

  const nameIdx = editorHtml.indexOf('name="name"');
  const galleryIdx = editorHtml.indexOf('id="gallery"');
  assert.ok(nameIdx > 0 && galleryIdx > 0 && nameIdx < galleryIdx, 'Product identity fields appear before gallery & advanced cutout settings');

  assert.ok(marketingJs.includes("e.key==='Escape'"), 'Marketing modal editor dismisses with Escape');
  assert.ok(wsCss.includes('#marketing-view [data-marketing-editor]:not(:empty)'));

  assert.ok(storeApi.includes('warranties: { pending: pendingWarranties }'));
  assert.ok(storeApi.includes('care: { open: openCareRequests }'));
});
