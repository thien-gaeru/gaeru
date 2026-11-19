const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function createActionFeedbackHarness() {
  const scheduled = [];
  let timerSeq = 1;
  class Target {
    constructor() { this.listeners = []; }
    addEventListener(type, listener, options) {
      const capture = Boolean(typeof options === 'boolean' ? options : options?.capture);
      const once = Boolean(typeof options === 'object' && options?.once);
      this.listeners.push({ type, listener, capture, once });
    }
    removeEventListener(type, listener, options) {
      const capture = Boolean(typeof options === 'boolean' ? options : options?.capture);
      this.listeners = this.listeners.filter(x => !(x.type === type && x.listener === listener && x.capture === capture));
    }
    dispatch(type) {
      const list = [...this.listeners.filter(x => x.type === type)];
      for (const entry of list) {
        if (entry.once) this.listeners = this.listeners.filter(x => x !== entry);
        entry.listener.call(this, { type, target: this });
      }
    }
  }
  class Element extends Target {
    constructor(tag = 'div') {
      super();
      this.tagName = tag.toUpperCase();
      this.attrs = new Map();
      this.children = [];
      this.isConnected = true;
      this.disabled = false;
      this.textContent = '';
      this.classes = new Set();
      this.style = { props: new Map(), setProperty(k, v) { this.props.set(k, v); } };
      this.classList = {
        add: (...cs) => cs.forEach(c => this.classes.add(c)),
        remove: (...cs) => cs.forEach(c => this.classes.delete(c)),
        contains: (c) => this.classes.has(c)
      };
    }
    set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(' '); }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.get(k) ?? null; }
    hasAttribute(k) { return this.attrs.has(k); }
    removeAttribute(k) { this.attrs.delete(k); }
    closest() { return null; }
    append(...nodes) {
      for (const node of nodes) {
        if (node.parent) node.parent.children = node.parent.children.filter(x => x !== node);
        node.parent = this;
        node.isConnected = true;
        this.children.push(node);
      }
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this);
      this.parent = null;
      this.isConnected = false;
    }
    get parentElement() { return this.parent || null; }
    get firstElementChild() { return this.children[0] || null; }
  }
  const document = new Target();
  document.body = new Element('body');
  document.openDialogs = [];
  document.querySelectorAll = (sel) => sel === 'dialog[open]' ? document.openDialogs : [];
  document.querySelector = () => null;
  document.createElement = (tag) => new Element(tag);
  const window = { fetch: async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) };
  const context = {
    window,
    document,
    EventTarget: Target,
    HTMLElement: Element,
    URL,
    Request,
    Promise,
    location: { href: 'https://gaeru.example/gaeru_ceo', origin: 'https://gaeru.example', pathname: '/gaeru_ceo' },
    queueMicrotask,
    setTimeout(fn, ms) {
      const id = timerSeq++;
      scheduled.push({ id, fn, ms, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const entry = scheduled.find(t => t.id === id);
      if (entry) entry.cleared = true;
    },
    console: { error() {} }
  };
  vm.runInNewContext(read('action-feedback.js'), context);
  return { window, document, Element, scheduled };
}

test('action-feedback.js toasts default to exact 3000ms auto-dismiss for success, error, warning and info', () => {
  const h = createActionFeedbackHarness();
  h.window.GAERUNotify.success('Đã xác nhận đơn hàng.');
  h.window.GAERUNotify.error('Không thể kết nối máy chủ.');
  h.window.GAERUNotify.warning('Tồn kho thấp.');

  const activeTimers = h.scheduled.filter(t => !t.cleared);
  assert.equal(activeTimers.length, 3);
  for (const t of activeTimers) {
    assert.equal(t.ms, 3000, 'Every default toast must auto-dismiss in exactly 3000ms');
  }

  // Firing all 3 timers removes all 3 notices cleanly (no stuck notices)
  const region = h.document.body.children.find(c => c.classList.contains('gaeru-action-notices'));
  assert.equal(region.children.length, 3);
  for (const t of activeTimers) t.fn();
  assert.equal(region.children.length, 0, 'All toasts must be removed after 3000ms');
});

test('action-feedback.js reparents active notices to document.body when hosting dialog closes', () => {
  const h = createActionFeedbackHarness();
  const dialog = new h.Element('dialog');
  dialog.setAttribute('open', '');
  h.document.openDialogs = [dialog];

  h.window.GAERUNotify.success('Đã xác nhận & chuyển đơn sang Đang xử lý.');
  const region = dialog.children.find(c => c.classList.contains('gaeru-action-notices'));
  assert.ok(region, 'Toast region mounts inside active top-layer dialog');
  assert.equal(region.children.length, 1);

  // Simulate closing dialog: toast region must survive and reparent to document.body
  h.document.openDialogs = [];
  dialog.dispatch('close');
  assert.equal(region.parentElement, h.document.body, 'Notice region must reparent to document.body on dialog close');
  assert.equal(region.children.length, 1, 'Active toast must remain visible until 3s elapses');
});

test('action-feedback.js clear("error") dismisses only error notices and cancels their timers', () => {
  const h = createActionFeedbackHarness();
  h.window.GAERUNotify.success('Thành công');
  h.window.GAERUNotify.error('Lỗi tạm thời');

  const region = h.document.body.children.find(c => c.classList.contains('gaeru-action-notices'));
  assert.equal(region.children.length, 2);

  h.window.GAERUNotify.clear('error');
  assert.equal(region.children.length, 1);
  assert.equal(region.children[0].children[0].textContent, 'Thành công');
  assert.equal(h.scheduled.filter(t => t.cleared).length, 1, 'Cleared error toast timer must be cancelled');
});

test('action-feedback.css positions notices top-right with 3s progress animation and real-time button spinner', () => {
  const css = read('action-feedback.css');
  const aiCss = read('admin/internal-ai.css');
  assert.match(css, /\.gaeru-action-notices\s*\{[^}]*top:\s*20px\s*!important;[^}]*right:\s*20px\s*!important;[^}]*bottom:\s*auto\s*!important;[^}]*height:\s*auto\s*!important;/s);
  assert.doesNotMatch(aiCss, /\.gaeru-action-notices\s*\{[^}]*bottom:/s, 'internal-ai.css must not override bottom on .gaeru-action-notices and stretch it across viewport');
  assert.match(css, /gaeru-toast-progress/);
  assert.match(css, /button\.is-processing/);
  assert.match(css, /pointer-events:\s*none;/);
});

test('order-workflow returns orderNumber for SSE and admin.js marks local actions before request to suppress echo', () => {
  const workflowJs = read('src/order-workflow.js');
  const adminJs = read('admin/admin.js');
  assert.match(workflowJs, /RETURNING id, order_number AS "orderNumber"/);
  assert.doesNotMatch(adminJs, /Đơn hàng #\$\{data\.orderNumber \|\| ''\}/, 'Must never render trailing # without order number');
  const markBeforePatch = adminJs.indexOf('markLocalOrderAction(order.orderNumber)');
  const patchCall = adminJs.indexOf('await request(`/api/gaeru_ceo/orders/${encodeURIComponent(form.dataset.orderForm)}`');
  assert.ok(markBeforePatch > 0 && patchCall > markBeforePatch, 'markLocalOrderAction must run before PATCH request to suppress SSE self-echo');
});

test('admin.js enforces 3s auto-clear on #global-feedback, safe single GET 502 retry, and real-time order modal button locks', () => {
  const adminJs = read('admin/admin.js');
  assert.match(adminJs, /const GLOBAL_NOTICE_MS = 3000;/);
  assert.match(adminJs, /let globalFeedbackTimer = null;/);
  assert.match(adminJs, /method === "GET" && \[502, 503, 504\]\.includes\(response\.status\)/);
  assert.doesNotMatch(adminJs, /Yêu cầu thất bại \(\$\{response\.status\}\)/, 'Must use friendly Vietnamese HTTP status messages');
  assert.match(adminJs, /function setButtonBusy\(button, busy, busyLabel\)/);
  assert.match(adminJs, /function lockOrderDialog\(dialog, activeButton, busyLabel\)/);
  assert.match(adminJs, /function clearStaleGlobalError\(\)/);
  assert.match(adminJs, /processing: "Đang xác nhận…"/);
  assert.match(adminJs, /shipped: "Đang chuyển Đang giao…"/);
  assert.match(adminJs, /completed: "Đang hoàn tất…"/);
  assert.match(adminJs, /cancelled: "Đang hủy đơn…"/);
  assert.match(adminJs, /dialog\.dataset\.confirming = "true"/);
  assert.match(adminJs, /inFlightOrderDeletes/);
});

test('order-after-sales.js passes distinct RMA restock reason to inventory.releaseOrderStock', () => {
  const invJs = read('src/inventory.js');
  const afterSalesJs = read('src/order-after-sales.js');
  assert.match(invJs, /async function releaseOrderStock\(client, \{ orderId, actor, reason \}/);
  assert.match(afterSalesJs, /reason:\s*'Tái nhập kho từ hồ sơ hoàn trả RMA'/);
});

test('order modal locks all buttons in real time on click, prevents duplicate PATCHes, and restores on failure', async () => {
  const { parseHTML } = require('linkedom');
  const { document, window } = parseHTML(read('admin/index.html'));
  const adminSource = read('admin/admin.js');
  const orderId = '11111111-2222-4333-8444-555555555555';
  const order = {
    id: orderId,
    orderNumber: 'GR-LOCK-TEST',
    customerName: 'QA Lock',
    phone: '0901234567',
    email: 'lock@example.invalid',
    address: '123 Test',
    city: 'HCM',
    createdAt: '2026-11-19T12:00:00Z',
    status: 'pending',
    paymentStatus: 'pending',
    paymentMethod: 'cod',
    totalVnd: 450000,
    subtotalVnd: 450000,
    shippingFeeVnd: 0,
    items: [{ productName: 'GAERU P185', variantName: 'Standard', sku: 'P185', quantity: 1, lineTotalVnd: 450000 }]
  };
  let releaseRequest;
  let patchCount = 0;
  const globalMessages = [];
  const state = {
    orders: [order],
    selectedOrders: new Set(),
    openOrders: new Set(),
    orderPagination: { page: 1, pageCount: 1, total: 1 },
    orderPage: 1
  };
  const context = {
    document,
    window,
    state,
    can: () => true,
    orderTransitions: { pending: ['processing', 'cancelled'] },
    labels: { pending: 'Chờ xác nhận', processing: 'Đang xử lý', cancelled: 'Đã hủy', cod: 'COD' },
    formatPrice: (n) => String(n),
    escapeHtml: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    showGlobal: (msg, isErr) => globalMessages.push({ msg, isErr: Boolean(isErr) }),
    updateOrderSelection: () => {},
    loadOrders: async () => {},
    loadSummary: async () => {},
    request: (url, opts) => {
      if (opts?.method === 'PATCH') {
        patchCount++;
        return new Promise((_resolve, reject) => { releaseRequest = () => reject(new Error('Simulated network error')); });
      }
      return Promise.resolve({});
    },
    setTimeout,
    clearTimeout
  };
  Object.defineProperty(window.HTMLElement.prototype, 'elements', {
    configurable: true,
    get() { return new Proxy({}, { get: (_, name) => this.querySelector('[name="' + String(name) + '"]') }); }
  });
  vm.createContext(context);
  vm.runInContext(
    adminSource.slice(adminSource.indexOf('function isLiveVnpayAttempt'), adminSource.indexOf('async function loadCustomers')),
    context
  );
  context.renderOrders();
  context.openOrderProcessing(orderId, null);

  const dialog = document.getElementById('order-processing-dialog');
  assert.ok(dialog);
  const confirmBtn = dialog.querySelector('[data-quick-advance="processing"]');
  const cancelBtn = dialog.querySelector('[data-quick-advance="cancelled"]');
  const waybillBtn = dialog.querySelector('[data-create-carrier-waybill]');
  assert.ok(confirmBtn && cancelBtn && waybillBtn);

  // First click enters real-time processing state immediately
  confirmBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(dialog.dataset.busy, 'true', 'Dialog must lock immediately on click');
  assert.equal(confirmBtn.disabled, true);
  assert.equal(confirmBtn.getAttribute('aria-busy'), 'true');
  assert.equal(confirmBtn.textContent, 'Đang xác nhận…');
  assert.equal(cancelBtn.disabled, true, 'Sibling cancel button must be locked while in-flight');
  assert.equal(waybillBtn.disabled, true, 'Sibling waybill button must be locked while in-flight');
  assert.equal(patchCount, 1);

  // Rapid duplicate clicks on both confirm and cancel must be ignored completely
  confirmBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  cancelBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(patchCount, 1, 'Duplicate clicks while in-flight must never send a second PATCH');

  // Simulate failure: dialog unlocks and restores exact original button text
  releaseRequest();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dialog.dataset.busy, undefined, 'Dialog busy lock must clear on error');
  assert.equal(confirmBtn.disabled, false);
  assert.equal(confirmBtn.getAttribute('aria-busy'), null);
  assert.match(confirmBtn.textContent, /Xác nhận & Chuẩn bị/);
  assert.equal(cancelBtn.disabled, false);
  assert.equal(waybillBtn.disabled, false);
  assert.equal(globalMessages.at(-1)?.isErr, true);
});

