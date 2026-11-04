'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
  ramCache,
  tagIndex,
  getOrSetCache,
  purgeTagsLocal,
  invalidateTags,
  withCache,
  generateETag,
  cacheEvents,
  flushAllCache
} = require('../cache');
const { sseHandler, realtimeClients } = require('../src/realtime-sse');

test('TEST 1: getOrSetCache - Singleflight, ETag generation và Tag indexing', async () => {
  flushAllCache();

  let fetchCount = 0;
  const mockFetch = async () => {
    fetchCount++;
    await new Promise((r) => setTimeout(r, 20));
    return { id: 101, name: 'Micro GAERU K9 Pro', price: 1590000 };
  };

  // Chạy 5 request đồng thời vào cùng 1 key (Singleflight test)
  const results = await Promise.all([
    getOrSetCache('product:detail:101', ['product:101', 'product:list'], mockFetch),
    getOrSetCache('product:detail:101', ['product:101', 'product:list'], mockFetch),
    getOrSetCache('product:detail:101', ['product:101', 'product:list'], mockFetch),
    getOrSetCache('product:detail:101', ['product:101', 'product:list'], mockFetch),
    getOrSetCache('product:detail:101', ['product:101', 'product:list'], mockFetch)
  ]);

  // Singleflight phải gom lại chỉ gọi DB 1 lần duy nhất
  assert.strictEqual(fetchCount, 1, 'Singleflight phải gom 5 request thành 1 lần gọi fetchFn');
  for (const res of results) {
    assert.strictEqual(res.data.id, 101);
    assert.ok(res.etag.startsWith('"') && res.etag.endsWith('"'), 'ETag phải bọc trong ngoặc kép');
  }

  // Tag Index phải ánh xạ đúng key vào các tag
  assert.ok(tagIndex.has('product:101'), 'tagIndex phải có tag product:101');
  assert.ok(tagIndex.get('product:101').has('product:detail:101'), 'tag product:101 phải trỏ tới key');
  assert.ok(tagIndex.has('product:list'), 'tagIndex phải có tag product:list');
  assert.ok(tagIndex.get('product:list').has('product:detail:101'), 'tag product:list phải trỏ tới key');
});

test('TEST 2: purgeTagsLocal - Xóa chính xác theo nhãn, bảo toàn các nhãn không liên quan', async () => {
  flushAllCache();

  // Nạp 3 mục cache với các tag khác nhau
  await getOrSetCache('prod:1', ['product:1', 'catalog'], async () => ({ id: 1 }));
  await getOrSetCache('prod:2', ['product:2', 'catalog'], async () => ({ id: 2 }));
  await getOrSetCache('config:store', ['config'], async () => ({ storeName: 'GAERU' }));

  assert.ok(ramCache.has('prod:1'));
  assert.ok(ramCache.has('prod:2'));
  assert.ok(ramCache.has('config:store'));

  // Xóa chỉ tag product:1
  const purged = purgeTagsLocal(['product:1']);
  assert.deepStrictEqual(purged, ['prod:1']);

  // prod:1 bị xóa, nhưng prod:2 và config:store vẫn còn nguyên vẹn trong RAM
  assert.strictEqual(ramCache.has('prod:1'), false, 'prod:1 phải bị xóa');
  assert.strictEqual(ramCache.has('prod:2'), true, 'prod:2 phải được bảo toàn');
  assert.strictEqual(ramCache.has('config:store'), true, 'config:store phải được bảo toàn');

  // Xóa tag catalog -> prod:2 bị xóa vì gắn nhãn catalog
  purgeTagsLocal(['catalog']);
  assert.strictEqual(ramCache.has('prod:2'), false, 'prod:2 phải bị xóa khi purge tag catalog');
  assert.strictEqual(ramCache.has('config:store'), true, 'config:store vẫn được bảo toàn');
});

test('TEST 3: invalidateTags - Micro-batching gom nhiều tag trong cùng tick và phát SSE event duy nhất', async () => {
  flushAllCache();

  let eventEmittedCount = 0;
  let receivedTags = null;

  const onInvalidated = (payload) => {
    eventEmittedCount++;
    receivedTags = payload.tags;
  };

  cacheEvents.on('invalidated', onInvalidated);

  try {
    // Gọi invalidateTags 3 lần liên tiếp trong cùng một tick
    invalidateTags(['product:1', 'catalog']);
    invalidateTags(['product:2']);
    invalidateTags(['catalog', 'search-index']); // Trùng tag catalog

    // Ngay trong microtask kế tiếp, sự kiện được dispatch một lần duy nhất
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.strictEqual(eventEmittedCount, 1, 'Chỉ được phát 1 sự kiện invalidated duy nhất cho toàn bộ batch');
    assert.ok(Array.isArray(receivedTags), 'Tags phải là mảng');

    // Kiểm tra danh sách tags đã được deduplicate và gom đủ
    const expectedTags = ['product:1', 'catalog', 'product:2', 'search-index'];
    for (const tag of expectedTags) {
      assert.ok(receivedTags.includes(tag), `Tag ${tag} phải có trong danh sách batched`);
    }
    assert.strictEqual(receivedTags.length, 4, 'Số lượng tags sau deduplication phải đúng');
  } finally {
    cacheEvents.off('invalidated', onInvalidated);
  }
});

test('TEST 4: withCache Middleware - Phản hồi 200, ETag, Cache-Tag và 304 Not Modified', async () => {
  flushAllCache();

  const app = express();
  let dbFetchCallCount = 0;

  app.get(
    '/api/test-products/:id',
    withCache(
      (req) => `product:detail:${req.params.id}`,
      (req) => [`product:${req.params.id}`, 'product:list'],
      async (req) => {
        dbFetchCallCount++;
        return { id: req.params.id, name: 'Micro GAERU K9 Pro', stock: 25 };
      }
    )
  );

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    // 1. Request đầu tiên: 200 OK từ DB
    const res1 = await fetch(`http://127.0.0.1:${port}/api/test-products/55`);
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(dbFetchCallCount, 1);
    const data1 = await res1.json();
    assert.strictEqual(data1.id, '55');
    const etag = res1.headers.get('etag');
    assert.ok(etag, 'Phải có header ETag');
    assert.strictEqual(res1.headers.get('cache-tag'), 'product:55,product:list');
    assert.strictEqual(res1.headers.get('cache-control'), 'no-cache, must-revalidate');

    // 2. Request thứ hai không có If-None-Match: 200 OK trả trực tiếp từ RAM trong 0ms
    const res2 = await fetch(`http://127.0.0.1:${port}/api/test-products/55`);
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(dbFetchCallCount, 1, 'Không được gọi lại fetchFn khi có cache RAM');

    // 3. Request với If-None-Match khớp ETag: Trả 304 Not Modified ngay lập tức
    const res3 = await fetch(`http://127.0.0.1:${port}/api/test-products/55`, {
      headers: { 'if-none-match': etag }
    });
    assert.strictEqual(res3.status, 304, 'Status phải là 304 Not Modified');
    assert.strictEqual(dbFetchCallCount, 1);

    // 4. Invalidate tag product:55 -> Request tiếp theo phải gọi lại fetchFn
    invalidateTags(['product:55'], { immediate: true });
    const res4 = await fetch(`http://127.0.0.1:${port}/api/test-products/55`);
    assert.strictEqual(res4.status, 200);
    assert.strictEqual(dbFetchCallCount, 2, 'Sau khi invalidate tag, fetchFn phải được gọi lại để nạp mới');
  } finally {
    server.close();
  }
});

test('TEST 5: /api/realtime SSE Endpoint - Kết nối handshake và đẩy thông điệp CACHE_INVALIDATED tức thời', async () => {
  const app = express();
  app.get('/api/realtime', sseHandler);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const messages = [];

    // Kết nối tới SSE endpoint bằng http.get
    const sseReq = http.get(`http://127.0.0.1:${port}/api/realtime`, (res) => {
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/event-stream');
      assert.strictEqual(res.headers['cache-control'], 'no-cache, no-transform');
      assert.strictEqual(res.headers['x-accel-buffering'], 'no');

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              messages.push(JSON.parse(line.slice(6)));
            } catch (_) {}
          }
        }
      });
    });

    // Chờ 50ms để kết nối SSE được thiết lập và nhận tin CONNECTED
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(messages.length >= 1, 'Phải nhận được ít nhất 1 tin nhắn ban đầu');
    assert.strictEqual(messages[0].type, 'CONNECTED', 'Tin nhắn đầu tiên phải là CONNECTED');

    // Kích hoạt invalidateTags
    invalidateTags(['product:999', 'product:list'], { immediate: true });

    // Chờ 50ms để SSE broadcast gói tin xuống client
    await new Promise((r) => setTimeout(r, 60));

    const invalidationMsg = messages.find((m) => m.type === 'CACHE_INVALIDATED');
    assert.ok(invalidationMsg, 'Phải nhận được thông điệp CACHE_INVALIDATED');
    assert.ok(invalidationMsg.tags.includes('product:999'), 'Tags phải chứa product:999');
    assert.ok(invalidationMsg.tags.includes('product:list'), 'Tags phải chứa product:list');
    assert.ok(typeof invalidationMsg.timestamp === 'number', 'Phải có timestamp');

    sseReq.destroy();
  } finally {
    server.close();
  }
});
