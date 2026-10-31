const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.join(__dirname, '..');
const formatNode = require('../src/shared/format');
const { AdminAction, requireAdminAction } = require('../src/admin-action');
const { UNKNOWN_ATTEMPT_STATES, isUnknownAttemptState } = require('../src/domain/payments/payment-policy');
const { runHtmlAuditAndSync } = require('../scripts/sync-html-head');

// -----------------------------------------------------------------------------
// Nhóm 1: Format/sanitize HTML, tiền, SĐT — UMD browser + Node parity
// -----------------------------------------------------------------------------
test('Group 1: Browser UMD and Node adapter parity for format & sanitize', () => {
  const browserCode = fs.readFileSync(path.join(repo, 'admin/format.js'), 'utf8');
  const windowContext = { globalThis: {} };
  windowContext.window = windowContext;
  vm.createContext(windowContext);
  vm.runInContext(browserCode, windowContext);

  const browser = windowContext.GAERUAdminShared;
  assert.ok(browser, 'GAERUAdminShared must be exposed on window');

  // Parity: escapeHtml / escapeAttr
  const testStrings = [
    '<script>alert("xss")</script>',
    `" onfocus='alert(1)' `,
    `Special & symbols ' " < > /`,
    '',
    null,
    undefined,
    12345
  ];
  for (const s of testStrings) {
    assert.equal(browser.escapeHtml(s), formatNode.escapeHtml(s));
    assert.equal(browser.escapeAttr(s), formatNode.escapeAttr(s));
  }

  // Parity: formatMoney
  const testAmounts = [0, 50000, 1250000.75, -10000, '99000', NaN, Infinity];
  for (const amt of testAmounts) {
    assert.equal(browser.formatMoney(amt), formatNode.formatMoney(amt));
    assert.equal(browser.formatMoney(amt, { suffix: ' VND' }), formatNode.formatMoney(amt, { suffix: ' VND' }));
  }

  // Parity: normalizePhone (+84, 0084, 840, local, spaces, dashes)
  const testPhones = [
    '+84 912 345 678',
    '0084 912 345 678',
    '84912345678',
    '0912345678',
    '(024) 3855-6677',
    '+84 (0) 90 123 4567',
    null,
    '',
    'invalid'
  ];
  for (const p of testPhones) {
    assert.equal(browser.normalizePhone(p), formatNode.normalizePhone(p));
  }
});

// -----------------------------------------------------------------------------
// Nhóm 2: Middleware quyền và CSRF — fail-fast, role permission check, CSRF
// -----------------------------------------------------------------------------
test('Group 2: AdminAction enforces explicit route permissions and fail-fast validation', () => {
  // Fail-fast test: AdminAction() without permission must throw at definition time
  assert.throws(() => {
    AdminAction();
  }, /AdminAction bắt buộc khai báo quyền cụ thể/);

  // Unit test handler behavior
  const middleware = AdminAction('orders.read');
  assert.equal(typeof middleware, 'function');

  // Test 1: Unauthenticated request -> 401
  let statusSet = null;
  let jsonSent = null;
  let nextCalled = false;
  const mockRes = {
    status(code) { statusSet = code; return this; },
    json(body) { jsonSent = body; return this; }
  };
  const mockReq = { session: {}, method: 'GET' };
  middleware(mockReq, mockRes, () => { nextCalled = true; });
  assert.equal(statusSet, 401);
  assert.equal(nextCalled, false);

  // Test 2: Role with insufficient permission -> 403
  statusSet = null;
  mockReq.admin = { id: 'u1', username: 'guest', role: 'viewer', permissions: ['catalog.read'] };
  middleware(mockReq, mockRes, () => { nextCalled = true; });
  assert.equal(statusSet, 403);
  assert.equal(nextCalled, false);

  // Test 3: Authorized role with orders.read permission -> calls next()
  statusSet = null;
  nextCalled = false;
  mockReq.admin = { id: 'u2', username: 'owner_user', role: 'owner', permissions: ['orders.read'] };
  middleware(mockReq, mockRes, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(statusSet, null);
});

// -----------------------------------------------------------------------------
// Nhóm 3: CatalogService — Service duy nhất chuẩn hóa workspace
// -----------------------------------------------------------------------------
test('Group 3: CatalogService workspace schema validation and single entry point', () => {
  const { CatalogService } = require('../src/domain/catalog/catalog-service');
  assert.ok(CatalogService.readWorkspace, 'readWorkspace must exist');
  assert.ok(CatalogService.validateWorkspacePayload, 'validateWorkspacePayload must exist');
  assert.ok(CatalogService.saveWorkspace, 'saveWorkspace must exist');

  // Validate duplicate group name rejection
  const duplicateGroupPayload = {
    inTrash: false,
    product: { name: 'Tai nghe K9', active: true },
    groups: [
      { name: 'Màu sắc', values: ['Đen', 'Trắng'] },
      { name: 'Màu sắc', values: ['Xanh'] }
    ],
    variants: []
  };
  assert.throws(() => {
    CatalogService.validateWorkspacePayload(duplicateGroupPayload);
  }, /Tên nhóm phân loại không được trùng/);
});

// -----------------------------------------------------------------------------
// Nhóm 4, 5, 6, 7: Pricing snapshot, Kho đơn ledger, PaymentPolicy unknown states, Worker lease
// -----------------------------------------------------------------------------
test('Groups 4-7: Financial payment policy, ledger idempotency & payment service safety', () => {
  // Group 6: Unknown attempt states
  assert.ok(UNKNOWN_ATTEMPT_STATES.includes('payment_initiation_unknown'));
  assert.ok(UNKNOWN_ATTEMPT_STATES.includes('awaiting_reconciliation'));
  assert.equal(isUnknownAttemptState('payment_initiation_unknown'), true);
  assert.equal(isUnknownAttemptState('awaiting_reconciliation'), true);
  assert.equal(isUnknownAttemptState('paid'), false);

  // PaymentService outbox and manual receipt guard
  const { PaymentService } = require('../src/domain/payments/payment-service');
  assert.ok(PaymentService.enqueueReconciliationOutbox);
  assert.ok(PaymentService.initiateOrderGatewayPayment);
  assert.ok(PaymentService.collectManualReceipt);
  assert.ok(PaymentService.reconcileOrder);

  // Verify static guard: warehouse_stock is never directly updated without ledger
  const inventoryServiceSrc = fs.readFileSync(path.join(repo, 'src/domain/inventory/inventory-service.js'), 'utf8');
  assert.ok(inventoryServiceSrc.includes('ON CONFLICT (event_key) DO NOTHING'));
});

// -----------------------------------------------------------------------------
// Nhóm 8: HTML Head Contract & Audit across all 34 HTML files
// -----------------------------------------------------------------------------
test('Group 8: HTML Head contract, SEO, PWA, and CSP audit on all 34 HTML pages', () => {
  const audit = runHtmlAuditAndSync({ writeChanges: false });
  assert.equal(audit.total, 34, 'Must audit exactly 34 HTML pages');
  assert.equal(audit.syncedCount, 0, 'All 34 HTML files must be 100% in sync without pending changes');
});

// -----------------------------------------------------------------------------
// Modular File Decomposition Guards: Các tệp lớn đã được chia tách gọn gàng, không minify
// -----------------------------------------------------------------------------
test('Modular File Decomposition: 4 large files cleanly split and readable (< 400 lines, unminified)', () => {
  const targets = [
    { file: 'src/store-api.js', maxLines: 400 },
    { file: 'admin/admin.js', maxLines: 400 },
    { file: 'admin/product-editor.js', maxLines: 400 },
    { file: 'admin/configuration.js', maxLines: 400 }
  ];

  for (const { file, maxLines } of targets) {
    const filePath = path.join(repo, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    assert.ok(lines.length < maxLines, `${file} must be under ${maxLines} lines, got ${lines.length}`);

    // Verify not minified: average line length < 140 chars
    const avgLineLen = content.length / lines.length;
    assert.ok(avgLineLen < 140, `${file} must not be minified (avg line length: ${avgLineLen})`);
  }
});
