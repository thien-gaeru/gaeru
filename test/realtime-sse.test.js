const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const {
  RealtimeHub,
  openSseStream,
  createRealtimeRouter,
  publishAdminEvent,
  publishCareEvent,
  publishChatEvent,
  defaultHub
} = require('../src/realtime-sse');
const { adminSessionPolicy, stampAdminSession } = require('../src/admin-session-policy');
const { poll } = require('../care-live');

test('RealtimeHub publish, subscribe, and channel segregation', () => {
  const hub = new RealtimeHub();
  const adminEvents = [];
  const chatEvents = [];

  const unsubAdmin = hub.subscribe('admin', e => adminEvents.push(e));
  const unsubChat = hub.subscribe('shopping_chat:thread-1', e => chatEvents.push(e));

  hub.publish('admin', 'order:new', { orderNumber: 'GR-123' });
  hub.publish('shopping_chat:thread-1', 'chat:message', { text: 'Hello' });

  assert.equal(adminEvents.length, 1);
  assert.equal(adminEvents[0].event, 'order:new');
  assert.equal(adminEvents[0].data.orderNumber, 'GR-123');

  assert.equal(chatEvents.length, 1);
  assert.equal(chatEvents[0].event, 'chat:message');
  assert.equal(chatEvents[0].data.text, 'Hello');

  unsubAdmin();
  unsubChat();

  hub.publish('admin', 'order:new', { orderNumber: 'GR-456' });
  assert.equal(adminEvents.length, 1, 'Unsubscribed listener must not receive further events');
});

test('Realtime SSE passive session boundary: SSE GET does not prolong idle session', () => {
  const session = { admin: { source: 'staff' } };
  stampAdminSession(session, Date.now() - 10000);
  const lastSeen = session.adminLastSeenAt;

  const req = { session, path: '/api/gaeru_ceo/realtime-sse', method: 'GET' };
  let called = 0;
  adminSessionPolicy(req, {}, () => called++);
  assert.equal(called, 1);
  assert.equal(session.adminLastSeenAt, lastSeen, 'realtime-sse must be passive and not reset adminLastSeenAt');
});

test('Realtime SSE Server & Client Integration Suite', async t => {
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) {
      return !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : db.query(sql, values);
    },
    async connect() {
      return { query: pool.query, release() {} };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);

  // Seed customers
  const custA = (await pool.query("INSERT INTO customers(email, full_name, active) VALUES('cust-a@gaeru.com', 'Khách A', true) RETURNING id")).rows[0];
  const custB = (await pool.query("INSERT INTO customers(email, full_name, active) VALUES('cust-b@gaeru.com', 'Khách B', true) RETURNING id")).rows[0];

  // Seed care request for cust A
  const careA = (await pool.query(
    "INSERT INTO care_requests(customer_id, request_key, subject, description, channel, external_order_number) VALUES($1, gen_random_uuid(), 'Hỗ trợ thiết bị', 'Mô tả chi tiết', 'shopee', 'SP-101') RETURNING id",
    [custA.id]
  )).rows[0];

  // Seed shopping chat thread for cust A
  const threadA = (await pool.query(
    "INSERT INTO shopping_chat_threads(owner_key, customer_id, product_name, request_key) VALUES('owner-key-a', $1, 'Micro GAERU K9', gen_random_uuid()) RETURNING id",
    [custA.id]
  )).rows[0];

  const app = express();
  app.use(express.json());

  let activeCustomer = custA.id;
  let activeAdmin = { username: 'ceo', permissions: ['dashboard.read', 'orders.read', 'customers.read'] };

  app.use((req, _res, next) => {
    req.session = {
      customer: activeCustomer ? { id: activeCustomer } : null,
      admin: activeAdmin
    };
    req.admin = activeAdmin;
    next();
  });

  const config = {};
  const testHub = new RealtimeHub();
  const realtime = createRealtimeRouter({ pool, config, hub: testHub });

  app.use('/api/gaeru_ceo', realtime.adminRouter);
  app.use('/api/customer', realtime.publicRouter);
  app.use('/api/shopping-chat', realtime.publicRouter);

  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. Admin connects to SSE stream
  const controller = new AbortController();
  const adminStreamPromise = fetch(`${baseUrl}/api/gaeru_ceo/realtime-sse`, {
    signal: controller.signal
  });

  const res = await adminStreamPromise;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  // Read initial connection & init event
  const initialChunk = await reader.read();
  const initialText = decoder.decode(initialChunk.value);
  assert.match(initialText, /: connected/);
  assert.match(initialText, /event: init/);

  // Broadcast an operational event and verify delivery in SSE
  testHub.publish('admin', 'order:new', { orderNumber: 'GR-TEST-999', totalVnd: 250000 });
  const eventChunk = await reader.read();
  const eventText = decoder.decode(eventChunk.value);
  assert.match(eventText, /event: order:new/);
  assert.match(eventText, /GR-TEST-999/);

  controller.abort();

  // 2. Customer Care SSE Stream
  activeCustomer = custA.id;
  const custCareController = new AbortController();
  const careStream = await fetch(`${baseUrl}/api/customer/care/${careA.id}/realtime-sse`, {
    signal: custCareController.signal
  });
  assert.equal(careStream.status, 200);
  assert.equal(careStream.headers.get('content-type'), 'text/event-stream');
  custCareController.abort();

  // 3. Access Control: Customer B cannot access Customer A's care stream
  activeCustomer = custB.id;
  const unauthorizedCare = await fetch(`${baseUrl}/api/customer/care/${careA.id}/realtime-sse`);
  assert.equal(unauthorizedCare.status, 404);

  // 4. Shopping Chat SSE Stream for Customer A
  activeCustomer = custA.id;
  const chatController = new AbortController();
  const chatStream = await fetch(`${baseUrl}/api/shopping-chat/threads/${threadA.id}/realtime-sse`, {
    signal: chatController.signal
  });
  assert.equal(chatStream.status, 200);
  assert.equal(chatStream.headers.get('content-type'), 'text/event-stream');
  chatController.abort();

  // 5. Admin Care & Shopping Chat SSE streams
  const adminCareCtrl = new AbortController();
  const adminCareRes = await fetch(`${baseUrl}/api/gaeru_ceo/care-requests/${careA.id}/realtime-sse`, { signal: adminCareCtrl.signal });
  assert.equal(adminCareRes.status, 200);
  adminCareCtrl.abort();

  const adminChatCtrl = new AbortController();
  const adminChatRes = await fetch(`${baseUrl}/api/gaeru_ceo/shopping-chat/${threadA.id}/realtime-sse`, { signal: adminChatCtrl.signal });
  assert.equal(adminChatRes.status, 200);
  adminChatCtrl.abort();

  // 6. Permission check: Admin without dashboard.read is rejected
  activeAdmin = { username: 'limited', permissions: ['orders.read'] };
  const forbiddenAdminSse = await fetch(`${baseUrl}/api/gaeru_ceo/realtime-sse`);
  assert.equal(forbiddenAdminSse.status, 403);

  // 7. Test client poll() with mock EventSource triggering immediate wake
  let pollRuns = 0;
  class MockEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
    }
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    }
    emit(name, data) {
      this.listeners[name]?.({ data: JSON.stringify(data) });
    }
    close() {
      this.closed = true;
    }
  }

  let mockEsInstance = null;
  const mockTimers = new Map();
  let timerId = 0;
  const mockEnv = {
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    navigator: { onLine: true },
    setTimeout(fn, delay) {
      const id = ++timerId;
      mockTimers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      mockTimers.delete(id);
    },
    addEventListener() {},
    removeEventListener() {},
    EventSource: function(url) {
      mockEsInstance = new MockEventSource(url);
      return mockEsInstance;
    }
  };

  const p = poll({
    environment: mockEnv,
    streamUrl: '/api/gaeru_ceo/realtime-sse',
    run: async () => { pollRuns++; },
    status: () => {}
  });

  assert.ok(mockEsInstance);
  assert.equal(pollRuns, 0);

  // Simulate an SSE incoming event: must immediately wake and schedule(0)
  mockEsInstance.emit('order:new', { orderNumber: 'GR-REALTIME-1' });
  // Find scheduled tick (delay === 0)
  const immediate = [...mockTimers.entries()].find(([, t]) => t.delay === 0);
  assert.ok(immediate, 'SSE event must schedule immediate tick');
  await immediate[1].fn();
  assert.equal(pollRuns, 1, 'EventSource message must trigger poll run()');

  p.stop();
  assert.equal(mockEsInstance.closed, true);
});

test('GAERU-14: SSE connection budget rejects excessive concurrent sockets with 429 or 503', async () => {
  const { EventEmitter } = require('node:events');
  const { openSseStream, getActiveSseCount } = require('../src/realtime-sse');
  const initialActive = getActiveSseCount();
  const reqList = [];
  const responses = [];

  // Simulate reaching the per-IP limit (cap in test is 60)
  for (let i = 0; i < 70; i++) {
    const mockReq = new EventEmitter();
    mockReq.ip = '10.0.0.99';
    let writtenStatus = null;
    let jsonBody = null;
    const mockRes = new EventEmitter();
    mockRes.writeHead = (st) => { writtenStatus = st; };
    mockRes.write = () => {};
    mockRes.status = (code) => { writtenStatus = code; return mockRes; };
    mockRes.json = (d) => { jsonBody = d; return mockRes; };
    openSseStream(mockReq, mockRes, 'test-cap');
    reqList.push(mockReq);
    responses.push({ status: writtenStatus, body: jsonBody });
  }

  // Late connections must have been rejected with 429
  const rejected429 = responses.filter(r => r.status === 429);
  assert.ok(rejected429.length > 0, 'Must reject connections over the per-IP cap with 429');

  // Cleanup: trigger close on all connections
  for (const req of reqList) {
    req.emit('close');
  }
  assert.equal(getActiveSseCount(), initialActive, 'Active count must return to initial after close');
});

test('GAERU F-03: req.emit("end") does not prematurely release SSE slot while response is open', async () => {
  const { EventEmitter } = require('node:events');
  const { openSseStream, getActiveSseCount } = require('../src/realtime-sse');
  const initial = getActiveSseCount();
  const mockReq = new EventEmitter();
  mockReq.ip = '10.0.0.101';
  const mockRes = new EventEmitter();
  mockRes.writeHead = () => {};
  mockRes.write = () => {};
  openSseStream(mockReq, mockRes, 'test-f03');
  assert.equal(getActiveSseCount(), initial + 1);

  // Emitting req 'end' (which happens when GET headers finish) must NOT release slot
  mockReq.emit('end');
  assert.equal(getActiveSseCount(), initial + 1, 'Slot must stay occupied after req end');

  // Releasing happens on response or socket close
  mockRes.emit('close');
  assert.equal(getActiveSseCount(), initial, 'Slot released on response close');
});
