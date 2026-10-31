'use strict';

/**
 * Empirical Live Verification Script for P3-02 Action Feedback Timing & Concurrency Fix
 * Verifies deterministic state waiting, mock clock operations, and resilience under high load.
 */

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const vm = require('node:vm');

function createHarness(fetchImpl) {
  class Target {
    constructor() { this.listeners = []; }
    addEventListener(type, listener, options) {
      const capture = Boolean(typeof options === 'boolean' ? options : options?.capture);
      if (!this.listeners.some(x => x.type === type && x.listener === listener && x.capture === capture)) {
        this.listeners.push({ type, listener, capture });
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
    insertAdjacentElement(_pos, node) { this.parent?.append(node); }
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
  const window = { fetch: fetchImpl };

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
    location: { href: 'https://gaeru.example/account.html', origin: 'https://gaeru.example' },
    queueMicrotask,
    clearTimeout: customClearTimeout,
    setTimeout: customSetTimeout,
    console: { error() {} }
  };

  vm.runInNewContext(fs.readFileSync(require.resolve('../action-feedback.js'), 'utf8'), context);

  function emit(target, type = 'click', submitter) {
    const event = { type, target, submitter, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    for (const x of document.listeners.filter(x => x.type === type && x.capture)) {
      x.listener.call(document, event);
      if (event.stopped) return { event, results: [] };
    }
    const results = target.listeners.filter(x => x.type === type).map(x => x.listener.call(target, event));
    const property = target['native_on' + type];
    if (property) results.push(property.call(target, event));
    return { event, results };
  }

  const notices = () => document.body.children.find(x => x.classes.has('gaeru-action-notices'))?.children || [];
  return { window, document, Element, emit, notices, clock, waitFor };
}

const response = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function runLiveVerification() {
  console.log('='.repeat(70));
  console.log('🔬 GAERU STORE - P3-02 ACTION FEEDBACK TIMING & CONCURRENCY VERIFICATION');
  console.log('='.repeat(70));

  const initialMemory = process.memoryUsage().heapUsed;

  // Phase 1: Baseline Single Fire-and-Forget Deterministic Transition
  console.log('\n[Phase 1] Deterministic State Waiting vs Wall-Clock Timing');
  console.log('-'.repeat(70));

  let release;
  const gate = new Promise(r => release = r);
  const paths = [];

  const f1 = createHarness(async path => {
    paths.push(path);
    if (path === '/api/setup') await gate;
    return response(200, path === '/api/setup' ? { message: 'Đã hoàn tất.' } : { csrfToken: 'tok123' });
  });

  const btn1 = new f1.Element();
  btn1.onclick = () => {
    f1.window.fetch('/api/csrf').then(() => f1.window.fetch('/api/setup', { method: 'POST' }));
  };

  const t0 = performance.now();
  f1.emit(btn1);

  // Asserting busy state via predicate
  await f1.waitFor(() => paths.length === 2 && btn1.classList.contains('gaeru-action-busy'), 'paths and busy state');
  assert.equal(btn1.classList.contains('gaeru-action-busy'), true);
  assert.deepEqual(paths, ['/api/csrf', '/api/setup']);
  console.log('  ✓ Button entered busy state deterministically.');
  console.log('  ✓ Chained fetch reached /api/setup in order.');

  // Unblock gate and assert settled state
  release();
  await f1.waitFor(() => !btn1.classList.contains('gaeru-action-busy') && f1.notices().length > 0, 'unbusy and notice');
  const t1 = performance.now();

  assert.equal(btn1.classList.contains('gaeru-action-busy'), false);
  assert.equal(f1.notices()[0].children[0].textContent, 'Đã hoàn tất.');
  console.log(`  ✓ Button cleared busy state and appended notice in ${(t1 - t0).toFixed(2)} ms.`);
  console.log('  ✅ No wall-clock sleep required. 100% deterministic.');

  // Phase 2: Mock Clock Auto-Dismissal
  console.log('\n[Phase 2] Mock Clock Auto-Dismissal (Immediate Virtual Time Advancement)');
  console.log('-'.repeat(70));

  assert.equal(f1.notices().length, 1);
  console.log('  ✓ Notice currently present in DOM.');

  // Advance virtual time by 6500ms
  const tc0 = performance.now();
  f1.clock.tick(6500);
  const tc1 = performance.now();

  assert.equal(f1.notices().length, 0);
  console.log(`  ✓ Notice dismissed after virtual 6500ms in ${(tc1 - tc0).toFixed(4)} ms CPU time.`);
  console.log('  ✅ Zero wall-clock wait; eliminated 6.5s delay completely.');

  // Phase 3: High-Concurrency Stress Test (100 Concurrent Chains)
  console.log('\n[Phase 3] High-Concurrency Stress Test (100 Concurrent Chains Under Heavy Load)');
  console.log('-'.repeat(70));

  const CONCURRENCY = 100;
  const ts0 = performance.now();

  await Promise.all(Array.from({ length: CONCURRENCY }, async (_, idx) => {
    let unblock;
    const itemGate = new Promise(r => unblock = r);
    const itemPaths = [];

    const f = createHarness(async path => {
      // Inject synthetic microtask jitter
      await new Promise(r => setImmediate ? setImmediate(r) : setTimeout(r, 0));
      itemPaths.push(path);
      if (path.startsWith('/api/action')) await itemGate;
      return response(200, path.startsWith('/api/action') ? { message: `OK ${idx}` } : { csrf: `c-${idx}` });
    });

    const btn = new f.Element();
    btn.onclick = () => {
      f.window.fetch(`/api/csrf?id=${idx}`).then(() => f.window.fetch(`/api/action?id=${idx}`, { method: 'POST' }));
    };

    f.emit(btn);

    await f.waitFor(() => itemPaths.length === 2 && btn.classList.contains('gaeru-action-busy'), `busy state ${idx}`);
    assert.equal(btn.classList.contains('gaeru-action-busy'), true);

    unblock();

    await f.waitFor(() => !btn.classList.contains('gaeru-action-busy') && f.notices().length > 0, `unbusy ${idx}`);
    assert.equal(btn.classList.contains('gaeru-action-busy'), false);
    assert.equal(f.notices()[0].children[0].textContent, `OK ${idx}`);
  }));

  const ts1 = performance.now();
  const stressDurationMs = ts1 - ts0;
  console.log(`  ✓ Successfully executed ${CONCURRENCY} concurrent chains in ${stressDurationMs.toFixed(2)} ms.`);
  console.log(`  ⚡ Throughput: ${Math.round((CONCURRENCY / stressDurationMs) * 1000).toLocaleString()} chains/sec.`);
  console.log(`  ✅ 100/${CONCURRENCY} concurrent chains completed with 0 assertion failures or timing flakes.`);

  const finalMemory = process.memoryUsage().heapUsed;
  const memDiffMb = ((finalMemory - initialMemory) / (1024 * 1024)).toFixed(2);
  console.log(`  💾 Memory Delta: ${memDiffMb} MB`);

  console.log('\n' + '='.repeat(70));
  console.log('🎉 ALL P3-02 ACTION FEEDBACK VERIFICATIONS PASSED SUCCESSFULLY!');
  console.log('='.repeat(70));
}

runLiveVerification().catch(err => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
