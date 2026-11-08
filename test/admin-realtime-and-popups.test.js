'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Admin Realtime & 100% Popup Notification Integration Suite', async (t) => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  const adminCss = fs.readFileSync(path.join(__dirname, '..', 'admin', 'admin.css'), 'utf8');
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'admin', 'admin.js'), 'utf8');
  const storeApiJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'store-api.js'), 'utf8');
  const realtimeSseJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'realtime-sse.js'), 'utf8');
  const internalAiJs = fs.readFileSync(path.join(__dirname, '..', 'admin', 'internal-ai.js'), 'utf8');

  await t.test('1. Admin UI contains Realtime LIVE status badge', () => {
    assert.ok(indexHtml.includes('id="admin-realtime-badge"'), 'index.html must include #admin-realtime-badge');
    assert.ok(indexHtml.includes('realtime-dot'), 'index.html must include realtime-dot indicator');
    assert.ok(indexHtml.includes('Realtime LIVE'), 'index.html must display Realtime LIVE label');
    assert.ok(adminCss.includes('.admin-realtime-badge'), 'admin.css must style .admin-realtime-badge');
    assert.ok(adminCss.includes('realtime-pulse'), 'admin.css must have realtime-pulse animation');
  });

  await t.test('2. Admin JS exports realtime and in-place refresh APIs', () => {
    assert.ok(adminJs.includes('refreshCurrentView'), 'admin.js must provide refreshCurrentView');
    assert.ok(adminJs.includes('initAdminRealtime'), 'admin.js must provide initAdminRealtime');
    assert.ok(adminJs.includes('stopAdminRealtime'), 'admin.js must provide stopAdminRealtime');
    assert.ok(!adminJs.includes('location.reload()'), 'admin.js must not call location.reload() on logout');
  });

  await t.test('3. showGlobal routes 100% of messages to GAERUNotify toast popup', () => {
    assert.ok(adminJs.includes('window.GAERUNotify?.toast'), 'showGlobal must trigger window.GAERUNotify.toast');
    assert.ok(adminJs.includes('window.notify(text, isError)'), 'showGlobal must fallback to window.notify popup');
  });

  await t.test('4. Backend emits order:new and order:update real-time events', () => {
    assert.ok(storeApiJs.includes("publishAdminEvent('order:new'"), 'store-api.js must emit order:new on completed checkout');
    assert.ok(storeApiJs.includes("publishAdminEvent('order:update'"), 'store-api.js must emit order:update on order PATCH');
  });

  await t.test('5. Realtime SSE propagates cache invalidation to admin channel', () => {
    assert.ok(realtimeSseJs.includes("defaultHub.publish('admin', 'cache:invalidated'"), 'realtime-sse must publish cache:invalidated to admin channel');
  });

  await t.test('6. Internal AI uses modal popups instead of native alerts and confirms', () => {
    assert.ok(!internalAiJs.includes("window.alert("), 'internal-ai.js must not call native window.alert');
    assert.ok(!internalAiJs.includes("window.confirm("), 'internal-ai.js must not call native window.confirm');
    assert.ok(internalAiJs.includes("window.GAERUNotify?.confirm"), 'internal-ai.js must use GAERUNotify.confirm');
  });
});
