'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cluster = require('node:cluster');
const { IpcFanoutHub } = require('../src/lib/cluster-fanout');
const { ramCache, stockMap, cacheEvents } = require('../cache');

test('TEST 1: IpcFanoutHub - Điều phối Fan-out Cache Tags loại trừ Worker nguồn', () => {
  const hub = new IpcFanoutHub();

  // Tạo mock workers
  const sentMessages = {
    w1: [],
    w2: [],
    w3: []
  };

  const mockWorkers = {
    '1': {
      id: 1,
      isConnected: () => true,
      send: (msg) => sentMessages.w1.push(msg)
    },
    '2': {
      id: 2,
      isConnected: () => true,
      send: (msg) => sentMessages.w2.push(msg)
    },
    '3': {
      id: 3,
      isConnected: () => true,
      send: (msg) => sentMessages.w3.push(msg)
    }
  };

  // Giả lập cluster.workers
  cluster.workers = mockWorkers;

  // Giả lập Worker 1 gửi tin nhắn xóa nhãn
  const senderWorker = mockWorkers['1'];
  const result = hub.handleWorkerMessage(senderWorker, {
    type: 'CACHE_INVALIDATE_TAGS',
    tags: ['product:123', 'catalog']
  });

  // Kiểm tra: Worker 1 (nguồn) KHÔNG được nhận lại tin nhắn (chống vòng lặp phản xạ)
  assert.strictEqual(sentMessages.w1.length, 0, 'Worker nguồn không được nhận lại tin nhắn của chính mình');

  // Kiểm tra: Worker 2 và Worker 3 đều nhận được tin nhắn fan-out
  assert.strictEqual(sentMessages.w2.length, 1, 'Worker 2 phải nhận được tin nhắn Fan-out');
  assert.strictEqual(sentMessages.w3.length, 1, 'Worker 3 phải nhận được tin nhắn Fan-out');
  assert.deepStrictEqual(sentMessages.w2[0].tags, ['product:123', 'catalog']);
  assert.deepStrictEqual(sentMessages.w3[0].tags, ['product:123', 'catalog']);

  // Kiểm tra metrics
  const metrics = hub.getMetrics();
  assert.strictEqual(metrics.messagesFannedOut, 1);
  assert.strictEqual(metrics.tagsFannedOut, 2);
  assert.strictEqual(metrics.activeWorkers, 3);
});

test('TEST 2: IpcFanoutHub - Đồng bộ tồn kho tức thời (STOCK_SYNC) qua IPC Fan-out', () => {
  const hub = new IpcFanoutHub();
  stockMap.clear();

  const sentMessages = {
    w1: [],
    w2: []
  };

  cluster.workers = {
    '1': { id: 1, isConnected: () => true, send: (m) => sentMessages.w1.push(m) },
    '2': { id: 2, isConnected: () => true, send: (m) => sentMessages.w2.push(m) }
  };

  // Worker 2 vừa trừ tồn kho SKU "GAERU-M3-BLK" còn 8 cái
  const senderWorker = cluster.workers['2'];
  hub.handleWorkerMessage(senderWorker, {
    type: 'STOCK_SYNC',
    skuOrId: 'GAERU-M3-BLK',
    qty: 8
  });

  // Tồn kho trên Master được cập nhật tức thì
  assert.strictEqual(stockMap.get('GAERU-M3-BLK'), 8, 'Tồn kho trên Master phải cập nhật bằng 8');

  // Worker 1 nhận được tin nhắn đồng bộ tồn kho
  assert.strictEqual(sentMessages.w1.length, 1);
  assert.strictEqual(sentMessages.w1[0].skuOrId, 'GAERU-M3-BLK');
  assert.strictEqual(sentMessages.w1[0].qty, 8);

  // Worker 2 (nguồn) không nhận tin nhắn thừa
  assert.strictEqual(sentMessages.w2.length, 0);

  // Metrics
  assert.strictEqual(hub.getMetrics().stockSyncs, 1);
});

test('TEST 3: IpcFanoutHub - Master Cache Invalidation đồng thời khi nhận tín hiệu từ Worker', () => {
  const hub = new IpcFanoutHub();

  // Nạp cache vào Master
  ramCache.set('product:detail:99', { data: 'test' });
  assert.ok(ramCache.has('product:detail:99'));

  let eventFired = false;
  const onInvalidated = () => { eventFired = true; };
  cacheEvents.on('invalidated', onInvalidated);

  try {
    cluster.workers = {
      '1': { id: 1, isConnected: () => true, send: () => {} }
    };

    hub.handleWorkerMessage(cluster.workers['1'], {
      type: 'CACHE_INVALIDATE_TAGS',
      tags: ['*']
    });

    // Master cache bị xóa sạch
    assert.strictEqual(ramCache.has('product:detail:99'), false, 'Master cache phải được xóa khi nhận tag *');
    assert.strictEqual(eventFired, true, 'Sự kiện cacheEvents trên Master phải được kích hoạt');
  } finally {
    cacheEvents.off('invalidated', onInvalidated);
    cluster.workers = {};
  }
});

test('TEST 4: IpcFanoutHub - Trình xử lý tùy biến mở rộng (Custom Handlers)', () => {
  const hub = new IpcFanoutHub();
  let customActionPayload = null;

  hub.registerHandler('ORDER_REALTIME_ALERT', (worker, message) => {
    customActionPayload = message.payload;
    return { handled: true };
  });

  const res = hub.handleWorkerMessage(null, {
    action: 'ORDER_REALTIME_ALERT',
    payload: { orderNumber: 'GAERU-20261104-9999', total: 1590000 }
  });

  assert.strictEqual(res.handled, true);
  assert.strictEqual(customActionPayload.orderNumber, 'GAERU-20261104-9999');
});
