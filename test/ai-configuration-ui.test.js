const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('External Chat AI configuration is completely removed from admin configuration UI', async () => {
  const records = Object.fromEntries(['profile', 'security', 'operations', 'vnpay', 'misa', 'shopee', 'tiktok'].map(id => [id, { version: 0, data: {} }]));
  const listeners = {};
  const root = { innerHTML: '', isConnected: true };
  const panel = { open: false, querySelector: () => ({ textContent: '' }) };
  const admin = {
    user: { role: 'owner', source: 'bootstrap' },
    showGlobal() {},
    request: async (path) => {
      if (path === '/api/gaeru_ceo/owner/configuration') {
        return { records: structuredClone(records), services: { turnstileConfigured: true, smtpConfigured: true }, callbacks: {} };
      }
      return {};
    }
  };
  const context = {
    window: { GAERUAdmin: admin },
    document: {
      addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
      querySelector: (s) => (s === '#system-configuration' ? root : null),
      getElementById: () => panel
    }
  };

  vm.runInNewContext(fs.readFileSync(require.resolve('../admin/configuration.js'), 'utf8'), context);
  await context.window.GAERUConfiguration.load();

  // Kiểm tra không còn bất kỳ thành phần nào của Chat AI bên ngoài trong giao diện cấu hình
  assert.ok(!root.innerHTML.includes('Chat AI · GPT, Gemini, Claude'), 'Should not render external Chat AI heading');
  assert.ok(!root.innerHTML.includes('Model OpenAI / GPT'), 'Should not render OpenAI configuration input');
  assert.ok(!root.innerHTML.includes('Model Gemini'), 'Should not render Gemini configuration input');
  assert.ok(!root.innerHTML.includes('Model Claude'), 'Should not render Claude configuration input');
  assert.ok(!root.innerHTML.includes('data-chat-ai-test'), 'Should not render external AI test button');
  assert.ok(!root.innerHTML.includes('config-panel-chat_ai'), 'Should not render chat_ai config panel');

  // Kiểm tra các panel vận hành và bảo mật chuẩn vẫn hoạt động nguyên vẹn
  assert.ok(root.innerHTML.includes('config-panel-security'), 'Should retain security panel');
  assert.ok(root.innerHTML.includes('config-panel-oauth'), 'Should retain oauth panel');
  assert.ok(root.innerHTML.includes('config-panel-misa'), 'Should retain misa panel');
});
