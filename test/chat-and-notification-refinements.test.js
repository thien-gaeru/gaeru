const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Request 1: "Gửi nhanh ngay" checkbox and label are removed from shopping chat', () => {
  const clientJs = fs.readFileSync(path.join(__dirname, '../shopping-chat-client.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../shopping-chat.css'), 'utf8');

  assert.equal(clientJs.includes('Gửi nhanh ngay'), false, 'Should not contain "Gửi nhanh ngay" text in client script');
  assert.equal(clientJs.includes('data-chat-instant-mode'), false, 'Should not contain data-chat-instant-mode in client script');
  assert.equal(css.includes('chat-instant-toggle'), false, 'Should not contain .chat-instant-toggle styling in chat css');
});

test('Request 2: Chat client prioritizes text message before uploading queued files', () => {
  const clientJs = fs.readFileSync(path.join(__dirname, '../shopping-chat-client.js'), 'utf8');
  assert.ok(clientJs.includes('insertOptimisticBubble(msgKey,nowLabel,textBody'), 'Should insert text bubble optimistically first');
  assert.ok(clientJs.includes('// 2. Tải tệp lên; file, video, ảnh chỉ hiển thị sau khi hoàn thành tải lên'), 'Should upload files and only render them after completion');
});

test('Request 3: Admin notifications defaults to desktop: true and sound: true', () => {
  const notificationsJs = fs.readFileSync(path.join(__dirname, '../admin/notifications.js'), 'utf8');
  const mockStorage = {
    getItem: () => null,
    setItem: () => {}
  };
  const context = {
    window: {
      GAERUAdmin: {
        user: { username: 'admin' },
        can: () => true,
        showGlobal: () => {},
        request: async () => ({ items: [], unread: 0 })
      },
      GAERUCareLive: { poll: () => ({ stop: () => {}, refresh: () => {} }) },
      addEventListener: () => {},
      localStorage: mockStorage
    },
    document: {
      querySelector: () => ({ addEventListener: () => {} }),
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    localStorage: mockStorage,
    Set,
    JSON,
    Boolean,
    Error,
    Date
  };
  context.window.window = context.window;
  context.window.document = context.document;

  vm.runInNewContext(notificationsJs, context);
  // Verify preference logic inside notifications.js: default returns {desktop:true, sound:true}
  assert.ok(notificationsJs.includes('if(!raw)return {desktop:true,sound:true};'));
  assert.ok(notificationsJs.includes('desktop:p.desktop!==false'));
  assert.ok(notificationsJs.includes('sound:p.sound!==false'));
});

test('Request 4: Shopee Express (SPX) is fully integrated into carriers and configurations', () => {
  const shipping = require('../src/shipping-choice');
  const clientConfig = fs.readFileSync(path.join(__dirname, '../admin/configuration.js'), 'utf8');

  assert.equal(shipping.names.spx, 'Shopee Express');
  assert.ok(clientConfig.includes('shipping_spx'));
  assert.ok(clientConfig.includes('Shopee Express (SPX)'));
  assert.ok(clientConfig.includes("activeCount+'/5"));
  assert.ok(clientConfig.includes("verifiedCount+'/5"));
});

test('Request 5: Admin shopping chat menu includes "Lịch sử đơn hàng" action tile', () => {
  const clientJs = fs.readFileSync(path.join(__dirname, '../shopping-chat-client.js'), 'utf8');
  assert.ok(clientJs.includes('data-offer="orders"'));
  assert.ok(clientJs.includes('Lịch sử đơn hàng'));
  assert.ok(clientJs.includes('Tra cứu và gửi thông tin đơn'));
  assert.ok(clientJs.includes("can('orders.read')"));
});

test('Request 6: Admin permanent order deletion requires explicit confirmation modal with matching order code', async () => {
  const adminJs = fs.readFileSync(path.join(__dirname, '../admin/admin.js'), 'utf8');
  assert.ok(adminJs.includes('confirmOrderPermanentDeletion(order)'));
  assert.ok(adminJs.includes('enterprise-confirm-dialog'));
  assert.ok(adminJs.includes('data-order-delete-input'));
  assert.ok(adminJs.includes('data-order-delete-accept'));
  assert.ok(adminJs.includes('data-order-delete-cancel'));

  const { parseHTML } = require('linkedom');
  const { document, window } = parseHTML('<!DOCTYPE html><html><body></body></html>');
  window.HTMLElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function() { this.removeAttribute('open'); };

  const context = {
    document,
    window,
    formatPrice: n => String(n) + ' đ',
    escapeHtml: s => String(s ?? ''),
    Boolean
  };
  vm.createContext(context);
  const fnCode = adminJs.slice(adminJs.indexOf('function confirmOrderPermanentDeletion'), adminJs.indexOf('async function handleOrderPermanentDeleteUI'));
  vm.runInContext(fnCode, context);

  const order = { id: 'order-uuid-123', orderNumber: 'DH-999888', customerName: 'Khách VIP', phone: '0912345678', totalVnd: 500000 };

  const promise = context.confirmOrderPermanentDeletion(order);
  const dialog = document.querySelector('dialog.enterprise-confirm-dialog');
  assert.ok(dialog, 'Dialog should be appended to document.body');
  assert.ok(dialog.textContent.includes('DH-999888'));
  assert.ok(dialog.textContent.includes('Khách VIP (0912345678)'));
  assert.ok(dialog.textContent.includes('500000 đ'));

  const input = dialog.querySelector('[data-order-delete-input]');
  const acceptBtn = dialog.querySelector('[data-order-delete-accept]');

  assert.equal(acceptBtn.disabled, true, 'Accept button must be initially disabled');

  input.value = 'DH-000';
  input.dispatchEvent(new window.Event('input'));
  assert.equal(acceptBtn.disabled, true);

  input.value = 'dh-999888';
  input.dispatchEvent(new window.Event('input'));
  assert.equal(acceptBtn.disabled, false);

  acceptBtn.click();
  const result = await promise;
  assert.equal(result, true);
  assert.equal(document.querySelector('dialog.enterprise-confirm-dialog'), null, 'Dialog should be removed');
});
