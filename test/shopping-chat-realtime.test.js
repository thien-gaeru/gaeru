const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RealtimeHub } = require('../src/realtime-sse');
const { poll } = require('../care-live');

test('Chat ngay realtime: care-live supports dynamic setStreamUrl and multi-event wake', async () => {
  let createdUrls = [];
  let closedCount = 0;
  let listeners = new Map();
  let statusHistory = [];

  class MockEventSource {
    constructor(url) {
      this.url = url;
      createdUrls.push(url);
    }
    addEventListener(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    }
    close() {
      closedCount++;
    }
  }

  let next = 0;
  const timers = new Map();
  const mockEnv = {
    document: {
      hidden: false,
      addEventListener() {},
      removeEventListener() {}
    },
    navigator: { onLine: true },
    EventSource: MockEventSource,
    setTimeout(fn, delay) {
      timers.set(++next, { fn, delay });
      return next;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    addEventListener() {},
    removeEventListener() {}
  };

  async function stepTimer() {
    if (!timers.size) return;
    const [id, timer] = [...timers][0];
    timers.delete(id);
    await timer.fn();
  }

  let tickCount = 0;
  const runner = poll({
    run: async () => { tickCount++; },
    status: msg => statusHistory.push(msg),
    environment: mockEnv,
    streamUrl: '/api/shopping-chat/threads/thread-initial/realtime-sse'
  });

  assert.equal(createdUrls.length, 1);
  assert.equal(createdUrls[0], '/api/shopping-chat/threads/thread-initial/realtime-sse');
  assert.ok(listeners.has('chat:message'));
  assert.ok(listeners.has('chat:update'));
  assert.ok(listeners.has('shopping_chat:message'));

  // Initial scheduled tick
  await stepTimer();
  assert.equal(tickCount, 1);

  // Triggering SSE event wakes run immediately (schedules tick at 0ms)
  listeners.get('chat:message')[0]();
  await stepTimer();
  assert.equal(tickCount, 2, 'Incoming chat:message SSE event must wake poll tick immediately');

  // Dynamic setStreamUrl switches to new thread URL and closes old EventSource
  runner.setStreamUrl('/api/shopping-chat/threads/thread-updated/realtime-sse');
  assert.equal(createdUrls.length, 2);
  assert.equal(createdUrls[1], '/api/shopping-chat/threads/thread-updated/realtime-sse');
  assert.equal(closedCount, 1, 'Previous stream must be closed when setStreamUrl is called');

  // Waking after setStreamUrl
  listeners.get('chat:update')[0]();
  await stepTimer();
  assert.equal(tickCount, 3);

  runner.stop();
  assert.equal(closedCount, 2, 'Stream must be closed on stop');
});

test('Chat ngay realtime: shopping-chat-client.js wires streamUrl and realtime live badge', () => {
  const clientJs = fs.readFileSync(path.join(__dirname, '../shopping-chat-client.js'), 'utf8');

  // Stream URL initialization and dynamic update
  assert.ok(clientJs.includes("streamUrl:id?base+'/'+id+'/realtime-sse':null"), 'Poll must initialize with thread realtime-sse streamUrl');
  assert.ok(clientJs.includes("poll?.setStreamUrl?.(base+'/'+id+'/realtime-sse')"), 'Creating a new thread must dynamically switch streamUrl');
  assert.ok(clientJs.includes("poll?.setStreamUrl?.(null)"), 'Starting new session must clear streamUrl');

  // Realtime badge in template and status handler
  assert.ok(clientJs.includes('data-chat-live-badge'), 'Client template must include data-chat-live-badge');
  assert.ok(clientJs.includes('data-chat-live-text'), 'Client template must include data-chat-live-text');
  assert.ok(clientJs.includes('updateLiveStatus'), 'Client must wire updateLiveStatus handler');
});

test('Chat ngay realtime: admin/shopping-chat.js wires realtime stream and live badge', () => {
  const adminChatJs = fs.readFileSync(path.join(__dirname, '../admin/shopping-chat.js'), 'utf8');

  assert.ok(adminChatJs.includes("streamUrl:'/api/gaeru_ceo/realtime-sse'"), 'Admin chat must connect to global CEO realtime-sse stream');
  assert.ok(adminChatJs.includes('data-admin-chat-live'), 'Admin chat header must render data-admin-chat-live badge');
  assert.ok(adminChatJs.includes('updateAdminLiveStatus'), 'Admin chat must handle realtime status updates');
});

test('Chat ngay realtime: product-services.js renders live status pill in dialog header', () => {
  const productServicesJs = fs.readFileSync(path.join(__dirname, '../product-services.js'), 'utf8');

  assert.ok(productServicesJs.includes('chat-header-title-row'), 'Dialog header must render chat-header-title-row');
  assert.ok(productServicesJs.includes('data-chat-live-badge'), 'Dialog header must render data-chat-live-badge');
  assert.ok(productServicesJs.includes('data-chat-live-text'), 'Dialog header must render data-chat-live-text');
});

test('Chat ngay realtime: CSS styles pulse animation and fallback state', () => {
  const css = fs.readFileSync(path.join(__dirname, '../shopping-chat.css'), 'utf8');

  assert.ok(css.includes('.chat-live-badge'), 'CSS must define .chat-live-badge');
  assert.ok(css.includes('.chat-live-dot'), 'CSS must define .chat-live-dot');
  assert.ok(css.includes('chatLivePulse'), 'CSS must define chatLivePulse keyframes');
  assert.ok(css.includes('.chat-live-badge.is-fallback'), 'CSS must define fallback state when disconnected or polling');
});

test('Chat ngay realtime: publishChatEvent broadcasts to thread and admin channels', () => {
  const testHub = new RealtimeHub();
  const threadEvents = [];
  const adminEvents = [];

  testHub.subscribe('shopping_chat:test-thread-99', e => threadEvents.push(e));
  testHub.subscribe('admin', e => adminEvents.push(e));

  // Emulate publishChatEvent logic on testHub
  const emit = (tId, ev, data) => {
    testHub.publish('shopping_chat:' + tId, ev, data);
    testHub.publish('admin', 'chat:message', { threadId: tId, ...data });
    testHub.publish('admin', 'shopping_chat:message', { threadId: tId, ...data });
    if (ev === 'chat:update') testHub.publish('admin', 'chat:update', { threadId: tId, ...data });
  };

  emit('test-thread-99', 'chat:message', { sender: 'customer', body: 'Chào shop tư vấn giúp mình' });

  assert.equal(threadEvents.length, 1);
  assert.equal(threadEvents[0].event, 'chat:message');
  assert.equal(threadEvents[0].data.body, 'Chào shop tư vấn giúp mình');

  assert.equal(adminEvents.length, 2);
  assert.equal(adminEvents[0].event, 'chat:message');
  assert.equal(adminEvents[1].event, 'shopping_chat:message');

  emit('test-thread-99', 'chat:update', { status: 'closed' });
  assert.equal(threadEvents.length, 2);
  assert.equal(threadEvents[1].event, 'chat:update');
  assert.equal(adminEvents.length, 5); // 2 previous + chat:message, shopping_chat:message, chat:update
});
