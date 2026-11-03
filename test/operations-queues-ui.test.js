'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const source = fs.readFileSync('admin/operational-tools.js', 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const counts = { pending: 0, retry: 0, processing: 0, unknown: 1, dead: 0, completed: 0, skipped: 0 };
const summary = { checkedAt: '2026-11-03T01:00:00Z', queues: [
  { id: 'order-email', title: 'Email đơn hàng', href: '#orders', kind: 'email', counts, total: 1, availability: 'measured', health: 'attention' },
  { id: 'chat-compression', title: 'Tối ưu tệp', href: '#shopping-chat', kind: 'compression', counts, total: 1, availability: 'measured' },
  { id: 'care-email', title: 'Email Care+', href: '#care', kind: 'email', counts: null, total: null, availability: 'unavailable' }
] };
function fixture(handler) {
  const { window, document } = parseHTML('<html><body><section id="overview-view"></section></body></html>');
  const calls = [], admin = { user: { username: 'owner', role: 'owner', source: 'bootstrap' }, can: () => true,
    async request(url, options) {
      calls.push({ url, options });
      if (handler) { const result = await handler(url, options); if (result !== undefined) return result; }
      if (url.endsWith('system-health')) return { checks: { failedOrUnknown: 3, smtp: { status: 'configured_unverified' } }, security: { tlsEnforced: true } };
      if (url.endsWith('/queues')) return summary;
      if (url.includes('/jobs?')) return { jobs: [{ id: 'fixture-job', state: 'unknown', attempts: 1, createdAt: '2026-11-03', retryAllowed: false }], total: 21, pageSize: 20 };
      return { message: 'Đã đưa tệp trở lại hàng đợi tối ưu.' };
    } };
  window.GAERUAdmin = admin;
  vm.runInNewContext(source, { window, document, location: { hash: '#overview' }, Date });
  return { window, document, admin, calls };
}
async function click(f, selector) { f.document.querySelector(selector).click(); await flush(); await flush(); }

test('operations UI keeps ambiguous delivery read only, supports filters and pages, and distinguishes unavailable data', async () => {
  const f = fixture(); await f.window.GAERUOperations.load();
  assert.equal(f.document.querySelectorAll('.operations-queue').length, 3);
  assert.ok(f.document.body.textContent.includes('Chưa đọc được dữ liệu; số lượng chưa xác định.'));
  assert.ok(f.document.body.textContent.includes('chưa xác nhận thư đến hộp thư'));
  await click(f, '[data-operations-queue="order-email"]');
  assert.equal(f.document.querySelectorAll('[data-operations-retry]').length, 0);
  await click(f, '[data-operations-page="1"]');
  assert.ok(f.calls.some(call => call.url.endsWith('/order-email/jobs?state=all&page=2')));
  const select = f.document.querySelector('[data-operations-state]');
  select.querySelector('[value="unknown"]').selected = true; select.dispatchEvent(new f.window.Event('change', { bubbles: true })); await flush();
  assert.ok(f.calls.some(call => call.url.endsWith('/order-email/jobs?state=unknown&page=1')));
  assert.ok(f.document.querySelector('[data-operations-jobs]').textContent.includes('Chưa rõ kết quả'));
});

test('operations UI retries only eligible compression through the existing endpoint', async () => {
  const f = fixture(url => url.includes('/chat-compression/jobs?') ? { jobs: [{ id: 'eligible-job', state: 'dead', attempts: 3, retryAllowed: true }], total: 1, pageSize: 20 } : undefined);
  await f.window.GAERUOperations.load(); await click(f, '[data-operations-queue="chat-compression"]');
  await click(f, '[data-operations-retry="eligible-job"]');
  assert.equal(f.calls.filter(call => call.options?.method === 'POST').length, 1);
  assert.ok(f.calls.some(call => call.url === '/api/gaeru_ceo/shopping-chat/compression-jobs/eligible-job/retry'));
});

test('operations UI visibly reports and escapes load failures without retaining successful-looking counts', async () => {
  let fail = false;
  const f = fixture(url => { if (fail && url.endsWith('/queues')) throw Error('<img src=x onerror=unsafe()>'); });
  await f.window.GAERUOperations.load(); fail = true; await f.window.GAERUOperations.load();
  assert.equal(f.document.querySelector('[data-operations-queues]').childElementCount, 0);
  assert.ok(f.document.querySelector('[role="alert"]').textContent.includes('<img'));
  assert.equal(f.document.querySelectorAll('img').length, 0);
  assert.equal(f.document.querySelector('[data-operations-refresh]').disabled, false);
});

test('operations UI discards owner responses if the active account changes while data is loading', async () => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  const f = fixture(url => { if (url.endsWith('/queues')) { started(); return pending; } });
  const load = f.window.GAERUOperations.load(); await requested;
  f.admin.user = { role: 'viewer', source: 'staff' };
  f.document.dispatchEvent(new f.window.Event('gaeru:admin-ready'));
  release(summary); await load; await flush();
  assert.equal(f.document.querySelectorAll('.operations-queue').length, 0);
  assert.ok(f.document.body.textContent.includes('Chủ doanh nghiệp có thể xem chi tiết'));
});
