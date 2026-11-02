const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

async function fixture() {
  const { document } = parseHTML('<html><body><section id="system-configuration"></section></body></html>');
  const listeners = {};
  document.addEventListener = (type, handler) => (listeners[type] ||= []).push(handler);
  const records = Object.fromEntries(['profile', 'security', 'operations', 'chat_ai', 'misa', 'shopee', 'tiktok', 'shipping_ghn', 'payment_cod'].map(id => [id, { version: 0, data: {} }]));
  records.security = { version: 1, data: { idleMinutes: 30, absoluteHours: 8 } };
  const requests = [];
  const admin = {
    user: { role: 'owner', source: 'bootstrap' }, showGlobal() {},
    async request(path, options = {}) {
      if (!options.method) return { records: structuredClone(records), services: {}, callbacks: {} };
      const body = JSON.parse(options.body);
      requests.push({ path, body });
      const result = { version: body.version + 1, data: body.data, message: 'Đã lưu.' };
      records.security = result;
      return result;
    }
  };
  const context = { window: { GAERUAdmin: admin }, document, setTimeout: fn => fn() };
  vm.runInNewContext(fs.readFileSync(require.resolve('../admin/configuration.js'), 'utf8'), context);
  await context.window.GAERUConfiguration.load();
  const status = { textContent: '' }, button = { disabled: false };
  const fields = {
    idleMinutes: { value: '30' }, absoluteHours: { value: '8' },
    password: { value: 'owner-password-fixture', focus() { this.focused = true; } },
    factorCode: { value: '123456' }
  };
  const form = {
    elements: fields, dataset: { configForm: 'security', version: '1' }, closest: () => null,
    querySelector: selector => selector === '[type=submit]' ? button : status,
    querySelectorAll: () => [fields.password, fields.factorCode]
  };
  return {
    document, context, requests, fields, status, listeners,
    async save() {
      for (const handler of listeners.submit) await handler({ preventDefault() {}, target: { closest: selector => selector === '[data-config-form]' ? form : null } });
    }
  };
}

test('sensitive configuration requires a fresh password for each saved change', async () => {
  const f = await fixture();
  await f.save();
  assert.equal(f.requests.length, 1);
  assert.equal(f.fields.password.value, '');
  await f.save();
  assert.equal(f.requests.length, 1, 'a prior password must not authorize a later change');
  assert.match(f.status.textContent, /nhập mật khẩu/i);
  assert.equal(f.fields.password.focused, true);
});

test('opening another configuration popup never restores a previously used owner password', async () => {
  const f = await fixture();
  await f.save();
  f.context.window.GAERUConfiguration.openConfigModal('security');
  assert.equal(f.document.querySelector('#config-popup-modal input[name=password]').value, '');
});

test('configuration modal contains keyboard focus and restores its trigger and prior scrolling state', async () => {
  const f = await fixture();
  const trigger = f.document.createElement('button');
  f.document.body.append(trigger);
  let active = trigger;
  Object.defineProperty(f.document, 'activeElement', { get: () => active });
  trigger.focus = () => { active = trigger; };
  f.document.body.style.overflow = 'clip';
  f.context.window.GAERUConfiguration.openConfigModal('security');
  const backdrop = f.document.getElementById('config-popup-modal');
  const controls = [...backdrop.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
  for (const control of controls) control.focus = () => { active = control; };
  async function key(key, shiftKey = false) {
    const event = { key, shiftKey, prevented: false, preventDefault() { this.prevented = true; } };
    for (const handler of f.listeners.keydown) await handler(event);
    return event;
  }
  active = controls.at(-1);
  assert.equal((await key('Tab')).prevented, true);
  assert.equal(active, controls[0]);
  assert.equal((await key('Tab', true)).prevented, true);
  assert.equal(active, controls.at(-1));
  assert.equal((await key('Escape')).prevented, true);
  assert.equal(active, trigger);
  assert.equal(backdrop.hidden, true);
  assert.equal(f.document.body.style.overflow, 'clip');
  assert.equal((await key('Escape')).prevented, false);
  assert.equal(f.document.body.style.overflow, 'clip');
});

test('shipping and payment availability confirmations use the newly entered modal credentials', async () => {
  for (const type of ['shipping', 'payment']) {
    const f = await fixture();
    const id = type === 'shipping' ? 'ghn' : 'cod';
    const panel = f.document.createElement('article');
    panel.id = 'config-panel-' + (type === 'shipping' ? 'shipping_' : 'payment_') + id;
    panel.innerHTML = '<button type="button" data-' + type + '-enable="' + id + '" data-enabled="true">Bật kênh</button>';
    f.document.body.append(panel);
    const trigger = panel.querySelector('button');
    async function click(target) { for (const handler of f.listeners.click) await handler({ target }); }
    await click(trigger);
    assert.equal(f.requests.length, 0);
    const modal = f.document.getElementById('config-popup-modal');
    const form = modal.querySelector('form');
    const elements = Object.fromEntries([...form.querySelectorAll('input,select')].map(input => [input.name, input]));
    Object.defineProperty(form, 'elements', { value: elements });
    elements.password.value = 'fresh-owner-password';
    elements.factorCode.value = '654321';
    form.dataset.version = '2';
    await click(modal.querySelector('[data-' + type + '-enable]'));
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].path, '/api/gaeru_ceo/owner/' + (type === 'shipping' ? 'shipping' : 'payments') + '/' + id + '/availability');
    assert.equal(f.requests[0].body.password, 'fresh-owner-password');
    assert.equal(f.requests[0].body.factorCode, '654321');
    assert.equal(f.requests[0].body.version, 2);
    assert.equal(f.requests[0].body.enabled, true);
    assert.equal(elements.password.value, '');
    assert.equal(elements.factorCode.value, '');
  }
});
