const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');

function fixture(fetchImpl) {
  class Target {
    constructor() { this.listeners = []; }
    addEventListener(type, listener, options) {
      const capture = Boolean(typeof options === 'boolean' ? options : options?.capture);
      if (!this.listeners.some(x => x.type === type && x.listener === listener && x.capture === capture)) this.listeners.push({type, listener, capture});
    }
    removeEventListener(type, listener, options) {
      const capture = Boolean(typeof options === 'boolean' ? options : options?.capture);
      this.listeners = this.listeners.filter(x => !(x.type === type && x.listener === listener && x.capture === capture));
    }
  }
  class Element extends Target {
    constructor(tag = 'button') {
      super(); this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.children = [];
      this.isConnected = true; this.disabled = false; this.textContent = ''; this.classes = new Set();
      this.classList = {add: c => this.classes.add(c), remove: c => this.classes.delete(c), contains: c => this.classes.has(c)};
    }
    set className(v) { this.classes = new Set(v.split(' ')); }
    get className() { return [...this.classes].join(' '); }
    setAttribute(k, v) { this.attrs.set(k, v); }
    getAttribute(k) { return this.attrs.get(k) ?? null; }
    hasAttribute(k) { return this.attrs.has(k); }
    removeAttribute(k) { this.attrs.delete(k); }
    closest(selector) {
      if (selector === 'form') return this.form || null;
      if (selector === '.gaeru-action-notices') return this.parent?.closest(selector) || (this.classes.has('gaeru-action-notices') ? this : null);
      return this.tagName === 'BUTTON' || this.tagName === 'INPUT' ? this : null;
    }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); this.isConnected = false; }
    contains(node) { return node.form === this || node.parent === this; }
    get parentElement() { return this.parent; }
    get firstElementChild() { return this.children[0]; }
    querySelector() { return this.button || null; }
    insertAdjacentElement(_position, node) { this.parent?.append(node); }
  }
  for (const name of ['onclick', 'onsubmit']) Object.defineProperty(Element.prototype, name, {
    configurable: true, get() { return this['native_' + name]; }, set(value) { this['native_' + name] = value; }
  });
  const document = new Target(); document.body = new Element('body');
  document.statuses = []; document.querySelectorAll = selector => selector === 'dialog[open]' ? [] : document.statuses;
  document.createElement = tag => new Element(tag);
  const window = {fetch: fetchImpl};
  const context = {window, document, EventTarget: Target, HTMLElement: Element, URL, Request, Promise,
    location: {href: 'https://gaeru.example/account.html', origin: 'https://gaeru.example'},
    queueMicrotask, clearTimeout, setTimeout(fn, ms) { const timer = setTimeout(fn, ms); if (ms > 1000) timer.unref(); return timer; }, console: {error() {}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../action-feedback.js'), 'utf8'), context);
  function emit(target, type = 'click', submitter) {
    const event = {type, target, submitter, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }};
    for (const x of document.listeners.filter(x => x.type === type && x.capture)) { x.listener.call(document, event); if (event.stopped) return {event, results: []}; }
    const results = target.listeners.filter(x => x.type === type).map(x => x.listener.call(target, event));
    const property = target['native_on' + type]; if (property) results.push(property.call(target, event));
    return {event, results};
  }
  const notices = () => document.body.children.find(x => x.classes.has('gaeru-action-notices'))?.children || [];
  return {window, document, Element, emit, notices};
}
const tick = () => new Promise(r => setTimeout(r, 10));
const response = (status, data) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});

test('submit spinner blocks duplicate clicks, preserves labels and application disabled state, and reports success', async () => {
  let release, calls = 0; const gate = new Promise(r => release = r);
  const f = fixture(async () => { calls++; await gate; return response(200, {message: 'Đã lưu cài đặt.'}); });
  const button = new f.Element(), form = new f.Element('form'); button.form = form; form.button = button; button.textContent = 'Lưu cài đặt';
  form.addEventListener('submit', async event => { event.preventDefault(); await f.window.fetch('/api/settings', {method: 'POST'}); button.disabled = true; });
  const first = f.emit(form, 'submit', button); await tick();
  assert.equal(button.getAttribute('aria-busy'), 'true'); assert.equal(button.classList.contains('gaeru-action-busy'), true); assert.equal(button.textContent, 'Lưu cài đặt');
  assert.equal(f.emit(button).event.stopped, true); assert.equal(f.emit(form, 'submit', button).event.stopped, true); assert.equal(calls, 1);
  assert.equal(f.emit(form, 'submit').event.stopped, true);
  release(); await Promise.all(first.results); await tick();
  assert.equal(button.getAttribute('aria-busy'), null); assert.equal(button.classList.contains('gaeru-action-busy'), false); assert.equal(button.disabled, true);
  assert.equal(f.notices()[0].children[0].textContent, 'Đã lưu cài đặt.');
});

test('onclick actions retain handler identity and show server errors without claiming success', async () => {
  const f = fixture(async () => response(403, {error: 'Mật khẩu hiện tại không đúng.'})); const button = new f.Element();
  const listener = async () => { await f.window.fetch('/api/account-security/setup', {method: 'POST'}); };
  button.onclick = listener; assert.equal(button.onclick, listener);
  await Promise.all(f.emit(button).results); await tick();
  assert.equal(f.notices().length, 1); assert.match(f.notices()[0].className, /is-error/); assert.equal(f.notices()[0].children[0].textContent, 'Mật khẩu hiện tại không đúng.');
  let called = 0; const detached = () => called++; button.addEventListener('click', detached); button.removeEventListener('click', detached);
  button.onclick = null; f.emit(button); assert.equal(called, 0);
});

test('fire-and-forget CSRF and write chains stay busy until completion; background reads stay silent', async () => {
  let release; const gate = new Promise(r => release = r); const paths = [];
  const f = fixture(async path => { paths.push(path); if (path === '/api/setup') await gate; return response(200, path === '/api/setup' ? {message: 'Đã thiết lập.'} : {csrfToken: 'fixture'}); });
  const button = new f.Element();
  button.onclick = () => { f.window.fetch('/api/csrf').then(() => f.window.fetch('/api/setup', {method: 'POST'})); };
  f.emit(button); await tick(); assert.equal(button.classList.contains('gaeru-action-busy'), true);
  assert.deepEqual(paths, ['/api/csrf', '/api/setup']); release(); await tick();
  assert.equal(button.classList.contains('gaeru-action-busy'), false); assert.equal(f.notices()[0].children[0].textContent, 'Đã thiết lập.');
  await f.window.fetch('/api/poll'); await tick(); assert.equal(f.notices().length, 1);
});

test('network failure unlocks the action, warns to check the result and never retries', async () => {
  let calls = 0; const f = fixture(async () => { calls++; throw new Error('Failed to fetch'); }); const button = new f.Element();
  button.onclick = async () => { try { await f.window.fetch('/api/order', {method: 'POST'}); } catch {} };
  await Promise.all(f.emit(button).results); await tick();
  assert.equal(calls, 1); assert.equal(button.getAttribute('aria-busy'), null);
  assert.match(f.notices()[0].children[0].textContent, /Kiểm tra kết quả trước khi gửi lại/);
});

test('quick local validation displays the existing field error without sending a request', async () => {
  let calls = 0; const f = fixture(async () => { calls++; return response(200, {}); });
  const button = new f.Element(), form = new f.Element('form'), status = new f.Element('p');
  button.form = form; status.form = form; f.document.statuses.push(status);
  button.onclick = async () => { status.textContent = 'Nhập mật khẩu hiện tại.'; };
  await Promise.all(f.emit(button).results); await tick();
  assert.equal(calls, 0); assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(f.notices()[0].children[0].textContent, status.textContent); assert.match(f.notices()[0].className, /is-error/);
});

test('a successful application-managed retry clears the earlier network error', async () => {
  let calls = 0; const f = fixture(async () => { if (++calls === 1) throw Error('offline'); return response(200, {message: 'Đã lưu thành công.'}); });
  const button = new f.Element();
  button.onclick = async () => {
    try { await f.window.fetch('/api/save', {method: 'POST'}); }
    catch { await f.window.fetch('/api/save', {method: 'POST'}); }
  };
  await Promise.all(f.emit(button).results); await tick();
  assert.equal(calls, 2); assert.equal(f.notices().length, 1);
  assert.equal(f.notices()[0].children[0].textContent, 'Đã lưu thành công.'); assert.ok(!f.notices()[0].className.includes('is-error'));
});
