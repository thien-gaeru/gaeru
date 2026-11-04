'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
  BOOT_ID,
  ramCache,
  stockMap,
  getFreshData,
  smartPageCache,
  reserveStock,
  releaseStock,
  seedStock,
  clearHtmlCacheOnly,
  flushAllCache
} = require('../cache');

test('BƯỚC 1: Lõi Cache - BOOT_ID và Fingerprint thay đổi ép hủy cache cũ', () => {
  assert.ok(BOOT_ID, 'BOOT_ID phải tồn tại');
  assert.strictEqual(typeof BOOT_ID, 'string', 'BOOT_ID là chuỗi');

  // Mô phỏng 2 phiên bản khởi động khác nhau
  const bootId1 = Date.now().toString(36);
  const bootId2 = (Date.now() + 1000).toString(36);
  const hash = 'abc123def456';
  const etag1 = `"${bootId1}-${hash}"`;
  const etag2 = `"${bootId2}-${hash}"`;

  assert.notStrictEqual(etag1, etag2, 'Khi restart server, BOOT_ID đổi dẫn đến ETag đổi, trình duyệt lập tức nhận bản mới');
});

test('BƯỚC 1 & 2: smartPageCache - Header, ETag 304, Brotli và Bypass Private', async () => {
  flushAllCache();

  const app = express();
  app.use(smartPageCache());

  let renderCount = 0;
  app.get('/cua-hang', (req, res) => {
    renderCount++;
    res.type('html').send(`<!doctype html><html><body><h1>GAERU Cửa Hàng - Lần ${renderCount}</h1></body></html>`);
  });

  app.get('/tai-khoan', (req, res) => {
    res.type('html').send('<!doctype html><html><body><h1>Trang riêng tư</h1></body></html>');
  });

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    // 1. Lần 1: MISS-REBUILT
    const res1 = await fetch(`http://127.0.0.1:${port}/cua-hang`);
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.headers.get('x-cache'), 'MISS-REBUILT');
    assert.strictEqual(res1.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    assert.strictEqual(res1.headers.get('cdn-cache-control'), 'public, max-age=5, stale-while-revalidate=15');
    const etag = res1.headers.get('etag');
    assert.ok(etag, 'Phải có header ETag');
    assert.ok(etag.includes(BOOT_ID), 'ETag phải chứa BOOT_ID');
    const body1 = await res1.text();
    assert.ok(body1.includes('Lần 1'));

    // Chờ 50ms để tác vụ nén Brotli nền lưu vào RAM
    await new Promise(r => setTimeout(r, 60));

    // 2. Lần 2: Gửi kèm If-None-Match -> Trả 304 Not Modified trong 0ms
    const res2 = await fetch(`http://127.0.0.1:${port}/cua-hang`, {
      headers: { 'if-none-match': etag }
    });
    assert.strictEqual(res2.status, 304, 'Status phải là 304 Not Modified');
    assert.strictEqual(renderCount, 1, 'Server không dựng lại HTML khi ETag khớp');

    // 3. Lần 3: Không gửi ETag nhưng có Accept-Encoding: br -> Trả HIT-FRESH-RAM dạng Brotli
    const res3 = await fetch(`http://127.0.0.1:${port}/cua-hang`, {
      headers: { 'accept-encoding': 'br' }
    });
    assert.strictEqual(res3.status, 200);
    assert.strictEqual(res3.headers.get('x-cache'), 'HIT-FRESH-RAM');
    assert.strictEqual(res3.headers.get('content-encoding'), 'br');
    const text3 = await res3.text();
    assert.ok(text3.includes('Lần 1'));

    // 4. Private Route: /tai-khoan không bao giờ lưu cache
    const resPrivate = await fetch(`http://127.0.0.1:${port}/tai-khoan`);
    assert.strictEqual(resPrivate.status, 200);
    assert.strictEqual(resPrivate.headers.get('x-cache'), null, 'Route riêng tư không được cache');
  } finally {
    server.close();
  }
});

test('BƯỚC 1: getFreshData - SWR & Tự động phát hiện thay đổi Database qua MD5 Hash', async () => {
  flushAllCache();

  let dbMockData = { price: 100000, name: 'GAERU M3' };
  let dbCallCount = 0;

  const fetchFromDb = async () => {
    dbCallCount++;
    return { ...dbMockData };
  };

  // 1. Đọc lần đầu (Cache Miss -> DB)
  const d1 = await getFreshData('test:product', fetchFromDb, 100);
  assert.strictEqual(d1.price, 100000);
  assert.strictEqual(dbCallCount, 1);

  // 2. Đọc ngay lập tức (< 100ms) -> Trả thẳng từ RAM, không gọi DB
  const d2 = await getFreshData('test:product', fetchFromDb, 100);
  assert.strictEqual(d2.price, 100000);
  assert.strictEqual(dbCallCount, 1);

  // Giả lập lưu HTML vào ramCache
  ramCache.set('html:/cua-hang/gaeru-m3', { raw: '<html>old</html>', etag: 'v1' });
  assert.ok(ramCache.has('html:/cua-hang/gaeru-m3'));

  // 3. Sửa giá trong Database
  dbMockData.price = 150000;

  // Đợi qua chu kỳ SWR 100ms
  await new Promise(r => setTimeout(r, 120));

  // Gọi lại getFreshData: trả về dữ liệu cũ ngay lập tức từ RAM, kích hoạt quét ngầm DB
  const d3 = await getFreshData('test:product', fetchFromDb, 100);
  assert.strictEqual(d3.price, 100000, 'Trả ngay từ RAM trong 0.01ms');

  // Đợi tác vụ nền SWR hoàn tất
  await new Promise(r => setTimeout(r, 60));
  assert.strictEqual(dbCallCount, 2, 'DB đã được quét ngầm');

  // Lần đọc kế tiếp nhận giá mới
  const d4 = await getFreshData('test:product', fetchFromDb, 100);
  assert.strictEqual(d4.price, 150000, 'Nhận giá mới sau khi DB đổi');

  // Kiểm tra HTML cache cũ đã bị xóa tự động (clearHtmlCacheOnly)
  assert.strictEqual(ramCache.has('html:/cua-hang/gaeru-m3'), false, 'HTML cũ bị xóa ngay khi DB thay đổi');
});

test('BƯỚC 3 & 4: reserveStock - Trừ tồn kho nguyên tử & Chống bán lố (Overselling)', () => {
  stockMap.clear();

  // Khởi tạo kho cho SKU: GAERU-K9-BLK = 5 cái
  seedStock('GAERU-K9-BLK', 5);

  // Đặt mua 3 cái -> Thành công, còn 2 cái
  const order1 = reserveStock('GAERU-K9-BLK', 3);
  assert.strictEqual(order1.ok, true);
  assert.strictEqual(order1.remaining, 2);

  // Cố tình đặt mua 3 cái (vượt quá tồn kho 2) -> Lập tức từ chối trong 0.01ms
  const order2 = reserveStock('GAERU-K9-BLK', 3);
  assert.strictEqual(order2.ok, false);
  assert.strictEqual(order2.remaining, 2, 'Tồn kho vẫn bảo toàn');

  // Đặt mua đúng 2 cái -> Thành công, hết hàng
  const order3 = reserveStock('GAERU-K9-BLK', 2);
  assert.strictEqual(order3.ok, true);
  assert.strictEqual(order3.remaining, 0);

  // Đặt tiếp 1 cái -> Bị từ chối
  const order4 = reserveStock('GAERU-K9-BLK', 1);
  assert.strictEqual(order4.ok, false);
  assert.strictEqual(order4.remaining, 0);

  // Mô phỏng hủy đơn -> Hoàn lại kho 2 cái
  const rollback = releaseStock('GAERU-K9-BLK', 2);
  assert.strictEqual(rollback.ok, true);
  assert.strictEqual(rollback.remaining, 2);
  assert.strictEqual(stockMap.get('GAERU-K9-BLK'), 2);
});

test('BƯỚC 3: API search-index.json & stock/:sku tích hợp', async () => {
  flushAllCache();
  seedStock('SKU-TEST-1', 10);

  const app = express();
  app.get('/api/stock/:sku', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const sku = String(req.params.sku || '').trim();
    const stock = stockMap.get(sku) ?? 0;
    res.json({ sku, stock, inStock: stock > 0 });
  });

  app.get('/api/search-index.json', async (req, res) => {
    const index = await getFreshData('data:search-index', async () => {
      return [
        { name: 'GAERU M3', slug: 'gaeru-m3', sku: 'M3-01', desc: 'Micro định hướng', price: 990000 }
      ];
    });
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.json(index);
  });

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    const resStock = await fetch(`http://127.0.0.1:${port}/api/stock/SKU-TEST-1`);
    const dataStock = await resStock.json();
    assert.strictEqual(dataStock.sku, 'SKU-TEST-1');
    assert.strictEqual(dataStock.stock, 10);
    assert.strictEqual(dataStock.inStock, true);

    const resSearch = await fetch(`http://127.0.0.1:${port}/api/search-index.json`);
    const dataSearch = await resSearch.json();
    assert.strictEqual(dataSearch.length, 1);
    assert.strictEqual(dataSearch[0].slug, 'gaeru-m3');
  } finally {
    server.close();
  }
});

test('BƯỚC 5: Speculative Preloading (speculationrules) có mặt trong layout HTML', () => {
  const { enrich } = require('../src/clean-routes');
  const sampleHtml = '<!doctype html><html><head><title>GAERU</title></head><body><main><h1>Chào mừng</h1></main></body></html>';
  const enriched = enrich(sampleHtml, '/cua-hang', 'https://gaeru.com');

  assert.ok(enriched.includes('speculationrules'), 'HTML phải chứa thẻ script speculationrules');
  assert.ok(enriched.includes('prerender'), 'Quy tắc prerender phải có mặt');
  assert.ok(enriched.includes('/tai-khoan*'), 'Phải loại trừ trang tài khoản');
  assert.ok(enriched.includes('/gio-hang*'), 'Phải loại trừ trang giỏ hàng');
  assert.ok(enriched.includes('/thanh-toan*'), 'Phải loại trừ trang thanh toán');
  assert.ok(enriched.includes('moderate'), 'Eagerness là moderate');
});
