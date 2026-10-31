'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(fetchImpl) {
  class Target {
    constructor() { this.listeners = []; }
    addEventListener(type, listener, options) {
      const capture = Boolean(typeof options === 'boolean' ? options : options?.capture);
      if (!this.listeners.some(x => x.type === type && x.listener === listener && x.capture === capture)) {
        this.listeners.push({type, listener, capture});
      }
    }
    removeEventListener(type, listener, options) {
      const capture = Boolean(typeof options === 'boolean' ? options : options?.capture);
      this.listeners = this.listeners.filter(x => !(x.type === type && x.listener === listener && x.capture === capture));
    }
  }

  class Element extends Target {
    constructor(tag = 'button') {
      super();
      this.tagName = tag.toUpperCase();
      this.attrs = new Map();
      this.children = [];
      this.isConnected = true;
      this.disabled = false;
      this.textContent = '';
      this.classes = new Set();
      this.classList = {
        add: c => this.classes.add(c),
        remove: c => this.classes.delete(c),
        contains: c => this.classes.has(c)
      };
    }
    set className(v) { this.classes = new Set(v ? v.split(' ').filter(Boolean) : []); }
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

  for (const name of ['onclick', 'onsubmit']) {
    Object.defineProperty(Element.prototype, name, {
      configurable: true,
      get() { return this['native_' + name]; },
      set(value) { this['native_' + name] = value; }
    });
  }

  const document = new Target();
  document.body = new Element('body');
  document.statuses = [];
  document.querySelectorAll = selector => selector === 'dialog[open]' ? [] : document.statuses;
  document.createElement = tag => new Element(tag);
  const window = {fetch: fetchImpl};

  // Mock Clock and Deterministic Timers
  const timers = new Map();
  let timerSeq = 1;
  let virtualTime = 0;

  function customSetTimeout(fn, ms = 0) {
    const id = timerSeq++;
    const delay = Math.max(0, Number(ms) || 0);
    const dueTime = virtualTime + delay;

    const realTimer = setTimeout(() => {
      if (timers.has(id)) {
        timers.delete(id);
        fn();
      }
    }, delay);
    if (delay > 1000 && realTimer.unref) realTimer.unref();

    timers.set(id, { fn, dueTime, realTimer });
    return id;
  }

  function customClearTimeout(id) {
    const item = timers.get(id);
    if (item) {
      clearTimeout(item.realTimer);
      timers.delete(id);
    }
  }

  const clock = {
    now: () => virtualTime,
    get count() { return timers.size; },
    tick(ms = 0) {
      virtualTime += ms;
      const due = [];
      for (const [id, t] of timers.entries()) {
        if (t.dueTime <= virtualTime) {
          clearTimeout(t.realTimer);
          due.push({ id, fn: t.fn });
          timers.delete(id);
        }
      }
      for (const t of due) {
        t.fn();
      }
    },
    runAll() {
      while (timers.size > 0) {
        let earliest = Infinity;
        for (const t of timers.values()) {
          if (t.dueTime < earliest) earliest = t.dueTime;
        }
        if (earliest === Infinity) break;
        this.tick(Math.max(0, earliest - virtualTime));
      }
    }
  };

  async function waitFor(predicate, description = 'Condition not met', timeoutMs = 3000) {
    const start = Date.now();
    while (true) {
      clock.tick(0);
      if (predicate()) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timeout after ${timeoutMs}ms waiting for condition: ${description}`);
      }
      await new Promise(r => setImmediate ? setImmediate(r) : setTimeout(r, 1));
    }
  }

  const context = {
    window,
    document,
    EventTarget: Target,
    HTMLElement: Element,
    URL,
    Request,
    Promise,
    location: {href: 'https://gaeru.example/account.html', origin: 'https://gaeru.example'},
    queueMicrotask,
    clearTimeout: customClearTimeout,
    setTimeout: customSetTimeout,
    console: {error() {}}
  };

  vm.runInNewContext(fs.readFileSync(require.resolve('../action-feedback.js'), 'utf8'), context);

  function emit(target, type = 'click', submitter) {
    const event = {type, target, submitter, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }};
    for (const x of document.listeners.filter(x => x.type === type && x.capture)) {
      x.listener.call(document, event);
      if (event.stopped) return {event, results: []};
    }
    const results = target.listeners.filter(x => x.type === type).map(x => x.listener.call(target, event));
    const property = target['native_on' + type];
    if (property) results.push(property.call(target, event));
    return {event, results};
  }

  const notices = () => document.body.children.find(x => x.classes.has('gaeru-action-notices'))?.children || [];
  return {window, document, Element, emit, notices, clock, waitFor};
}

const response = (status, data) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});

test('submit spinner blocks duplicate clicks, preserves labels and application disabled state, and reports success', async () => {
  let release, calls = 0;
  const gate = new Promise(r => release = r);
  const f = fixture(async () => {
    calls++;
    await gate;
    return response(200, {message: 'Đã lưu cài đặt.'});
  });

  const button = new f.Element(), form = new f.Element('form');
  button.form = form;
  form.button = button;
  button.textContent = 'Lưu cài đặt';

  form.addEventListener('submit', async event => {
    event.preventDefault();
    await f.window.fetch('/api/settings', {method: 'POST'});
    button.disabled = true;
  });

  const first = f.emit(form, 'submit', button);
  await f.waitFor(() => button.classList.contains('gaeru-action-busy'), 'button becomes busy');

  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.classList.contains('gaeru-action-busy'), true);
  assert.equal(button.textContent, 'Lưu cài đặt');
  assert.equal(f.emit(button).event.stopped, true);
  assert.equal(f.emit(form, 'submit', button).event.stopped, true);
  assert.equal(calls, 1);
  assert.equal(f.emit(form, 'submit').event.stopped, true);

  release();
  await Promise.all(first.results);
  await f.waitFor(() => !button.classList.contains('gaeru-action-busy') && f.notices().length > 0, 'button unbusy and notice displayed');

  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(button.classList.contains('gaeru-action-busy'), false);
  assert.equal(button.disabled, true);
  assert.equal(f.notices()[0].children[0].textContent, 'Đã lưu cài đặt.');
});

test('onclick actions retain handler identity and show server errors without claiming success', async () => {
  const f = fixture(async () => response(403, {error: 'Mật khẩu hiện tại không đúng.'}));
  const button = new f.Element();
  const listener = async () => { await f.window.fetch('/api/account-security/setup', {method: 'POST'}); };
  button.onclick = listener;
  assert.equal(button.onclick, listener);

  await Promise.all(f.emit(button).results);
  await f.waitFor(() => f.notices().length === 1, 'error notice displayed');

  assert.equal(f.notices().length, 1);
  assert.match(f.notices()[0].className, /is-error/);
  assert.equal(f.notices()[0].children[0].textContent, 'Mật khẩu hiện tại không đúng.');

  let called = 0;
  const detached = () => called++;
  button.addEventListener('click', detached);
  button.removeEventListener('click', detached);
  button.onclick = null;
  f.emit(button);
  assert.equal(called, 0);
});

test('fire-and-forget CSRF and write chains stay busy until completion; background reads stay silent', async () => {
  let release;
  const gate = new Promise(r => release = r);
  const paths = [];
  const f = fixture(async path => {
    paths.push(path);
    if (path === '/api/setup') await gate;
    return response(200, path === '/api/setup' ? {message: 'Đã thiết lập.'} : {csrfToken: 'fixture'});
  });

  const button = new f.Element();
  button.onclick = () => {
    f.window.fetch('/api/csrf').then(() => f.window.fetch('/api/setup', {method: 'POST'}));
  };

  f.emit(button);

  // Chờ điều kiện chuỗi fetch đạt đến /api/setup và button được đánh dấu busy
  await f.waitFor(() => paths.length === 2 && button.classList.contains('gaeru-action-busy'),
    'paths reach [/api/csrf, /api/setup] and button is busy');
  assert.equal(button.classList.contains('gaeru-action-busy'), true);
  assert.deepEqual(paths, ['/api/csrf', '/api/setup']);

  // Mở cổng gate
  release();

  // Chờ điều kiện button hết busy và thông báo hoàn tất xuất hiện
  await f.waitFor(() => !button.classList.contains('gaeru-action-busy') && f.notices().length > 0,
    'button is unbusy and notice is displayed');
  assert.equal(button.classList.contains('gaeru-action-busy'), false);
  assert.equal(f.notices()[0].children[0].textContent, 'Đã thiết lập.');

  // Background fetch không tạo notice mới
  await f.window.fetch('/api/poll');
  f.clock.tick(0);
  assert.equal(f.notices().length, 1);
});

test('network failure unlocks the action, warns to check the result and never retries', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('Failed to fetch'); });
  const button = new f.Element();
  button.onclick = async () => { try { await f.window.fetch('/api/order', {method: 'POST'}); } catch {} };

  await Promise.all(f.emit(button).results);
  await f.waitFor(() => button.getAttribute('aria-busy') === null && f.notices().length > 0, 'network error handled and button unlocked');

  assert.equal(calls, 1);
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.match(f.notices()[0].children[0].textContent, /Kiểm tra kết quả trước khi gửi lại/);
});

test('quick local validation displays the existing field error without sending a request', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return response(200, {}); });
  const button = new f.Element(), form = new f.Element('form'), status = new f.Element('p');
  button.form = form;
  status.form = form;
  f.document.statuses.push(status);
  button.onclick = async () => { status.textContent = 'Nhập mật khẩu hiện tại.'; };

  await Promise.all(f.emit(button).results);
  await f.waitFor(() => f.notices().length > 0, 'validation notice displayed');

  assert.equal(calls, 0);
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(f.notices()[0].children[0].textContent, status.textContent);
  assert.match(f.notices()[0].className, /is-error/);
});

test('a successful application-managed retry clears the earlier network error', async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1) throw Error('offline');
    return response(200, {message: 'Đã lưu thành công.'});
  });

  const button = new f.Element();
  button.onclick = async () => {
    try { await f.window.fetch('/api/save', {method: 'POST'}); }
    catch { await f.window.fetch('/api/save', {method: 'POST'}); }
  };

  await Promise.all(f.emit(button).results);
  await f.waitFor(() => calls === 2 && f.notices().length === 1 && !f.notices()[0].className.includes('is-error'), 'retry completes successfully');

  assert.equal(calls, 2);
  assert.equal(f.notices().length, 1);
  assert.equal(f.notices()[0].children[0].textContent, 'Đã lưu thành công.');
  assert.ok(!f.notices()[0].className.includes('is-error'));
});

test('notice auto-dismisses after 6500ms using mock clock without wall-clock delay', async () => {
  const f = fixture(async () => response(200, {message: 'Thông báo tự ẩn.'}));
  const button = new f.Element();
  button.onclick = async () => { await f.window.fetch('/api/temp', {method: 'POST'}); };

  await Promise.all(f.emit(button).results);
  await f.waitFor(() => f.notices().length === 1, 'notice is created');
  assert.equal(f.notices().length, 1);

  // Advance mock clock by 6500ms -> notice is immediately removed
  f.clock.tick(6500);
  assert.equal(f.notices().length, 0);
});

test('P3-02 Concurrency & Stress: multiple concurrent fire-and-forget chains across pages remain deterministic under simulated high load', async () => {
  const CONCURRENCY = 50;

  // Run 50 independent page instances concurrently with artificial CPU/event-loop jitter in CI
  await Promise.all(Array.from({ length: CONCURRENCY }, async (_, idx) => {
    let release;
    const gate = new Promise(r => release = r);
    const paths = [];

    const f = fixture(async path => {
      // Simulate event-loop jitter under heavy CI load
      await new Promise(r => setImmediate ? setImmediate(r) : setTimeout(r, 0));
      paths.push(path);
      if (path === '/api/setup') await gate;
      return response(200, path === '/api/setup' ? { message: `Đã thiết lập ${idx}.` } : { csrfToken: `fixture-${idx}` });
    });

    const button = new f.Element();
    button.onclick = () => {
      f.window.fetch('/api/csrf').then(() => f.window.fetch('/api/setup', { method: 'POST' }));
    };

    f.emit(button);

    // Chờ điều kiện: paths có đủ 2 endpoint và button chuyển busy
    await f.waitFor(() => paths.length === 2 && button.classList.contains('gaeru-action-busy'),
      `[Run ${idx}] paths reach [/api/csrf, /api/setup] and button becomes busy`);
    assert.equal(button.classList.contains('gaeru-action-busy'), true);
    assert.deepEqual(paths, ['/api/csrf', '/api/setup']);

    // Mở khóa cổng
    release();

    // Chờ điều kiện: button hết busy và notice hoàn tất hiển thị
    await f.waitFor(() => !button.classList.contains('gaeru-action-busy') && f.notices().length > 0,
      `[Run ${idx}] button is unbusy and notice is displayed`);
    assert.equal(button.classList.contains('gaeru-action-busy'), false);
    assert.equal(f.notices()[0].children[0].textContent, `Đã thiết lập ${idx}.`);

    // Background fetch không tạo notice mới
    await f.window.fetch('/api/poll');
    f.clock.tick(0);
    assert.equal(f.notices().length, 1);
  }));
});
