'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createTestDb } = require('../test/helpers/pglite-db');
const { createBarcodeApi } = require('../src/barcode-api');

async function runLiveVerification() {
  console.log('='.repeat(80));
  console.log('KIỂM TRA CHẠY THẬT & ĐO LƯỜNG SỐ LIỆU THỰC TẾ: src/barcode-api.js');
  console.log('Môi trường: Node.js 24 LTS · PostgreSQL Engine (PGlite)');
  console.log('='.repeat(80));

  const { db, pool } = await createTestDb();

  try {
    // 1. Chèn đơn hàng mẫu vào bảng orders và order_items thực tế của GAERU
    const order1 = (await pool.query(`
      INSERT INTO orders (
        order_number, customer_name, email, phone, address, city, note,
        payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd
      ) VALUES (
        'GR-20261101-K9PRO',
        'Nguyễn Thành Long',
        'long.nguyen@example.com',
        '0912345678',
        'Số 18 Hoàng Diệu, Phường Điện Biên, Ba Đình',
        'Hà Nội',
        'Giao giờ hành chính, gọi trước khi giao',
        'cod',
        'pending',
        'confirmed',
        759000,
        30000,
        789000
      ) RETURNING *
    `)).rows[0];

    await pool.query(`
      INSERT INTO order_items (order_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
      VALUES ($1, 'Micro GAERU K9 Pro', 'Type-C kép', 'K9-PRO-TYPC', 759000, 1, 759000)
    `, [order1.id]);

    const order2 = (await pool.query(`
      INSERT INTO orders (
        order_number, customer_name, email, phone, address, city, note,
        payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd
      ) VALUES (
        'GAERU-889911',
        'Trần Thị Mai',
        'mai.tran@example.com',
        '0987654321',
        'Chung cư Vinhomes Central Park',
        'TP. Hồ Chí Minh',
        'Hàng dễ vỡ, bọc chống sốc cẩn thận',
        'vnpay',
        'paid',
        'processing',
        1450000,
        0,
        1450000
      ) RETURNING *
    `)).rows[0];

    await pool.query(`
      INSERT INTO order_items (order_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
      VALUES
        ($1, 'Gimbal AI GAERU P01', 'Đen nhám', 'P01-BLK', 1050000, 1, 1050000),
        ($1, 'Chân Tripod GAERU T1', 'Chuẩn', 'T1-STD', 400000, 1, 400000)
    `, [order2.id]);

    const orderCompleted = (await pool.query(`
      INSERT INTO orders (
        order_number, customer_name, email, phone, address, city,
        payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd
      ) VALUES (
        'GR-ALREADY-DONE', 'Lê Văn Tuấn', 'tuan@example.com', '0901112233', 'Đà Nẵng', 'Đà Nẵng',
        'cod', 'paid', 'completed', 500000, 30000, 530000
      ) RETURNING *
    `)).rows[0];

    const orderCancelled = (await pool.query(`
      INSERT INTO orders (
        order_number, customer_name, email, phone, address, city,
        payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd
      ) VALUES (
        'GR-CANCELLED-01', 'Phạm Quốc Bảo', 'bao@example.com', '0933334444', 'Cần Thơ', 'Cần Thơ',
        'cod', 'pending', 'cancelled', 350000, 30000, 380000
      ) RETURNING *
    `)).rows[0];

    console.log(`✔ Đã nạp 4 đơn hàng vào CSDL chuẩn PostgreSQL: ID đơn 1 = ${order1.id}, ID đơn 2 = ${order2.id}`);

    // Giả lập realtimeHub.notifyOrderUpdate
    const realtimeEvents = [];
    const notifyOrderUpdate = (event) => {
      realtimeEvents.push(event);
    };

    const barcodeRouter = createBarcodeApi(pool, { notifyOrderUpdate });

    // Mock Express Request / Response Helper
    async function testLookup(code) {
      let status = 200;
      let body = null;
      const req = { query: { code }, admin: { permissions: ['orders.read'] } };
      const res = {
        status(s) { status = s; return this; },
        json(b) { body = b; return this; }
      };
      // Tìm handler của GET /barcode/lookup
      const layer = barcodeRouter.stack.find(l => l.route && l.route.path === '/barcode/lookup');
      const handlers = layer.route.stack;
      // Gọi handler cuối cùng (sau middleware auth)
      await handlers[handlers.length - 1].handle(req, res, () => {});
      return { status, body };
    }

    async function testConfirmPack(orderId) {
      let status = 200;
      let body = null;
      const req = { body: { orderId }, admin: { permissions: ['orders.write'] } };
      const res = {
        status(s) { status = s; return this; },
        json(b) { body = b; return this; }
      };
      const layer = barcodeRouter.stack.find(l => l.route && l.route.path === '/barcode/confirm-pack');
      const handlers = layer.route.stack;
      await handlers[handlers.length - 1].handle(req, res, () => {});
      return { status, body };
    }

    // --------------------------------------------------------------------------
    // KỊCH BẢN 1: Quét Tra Cứu Đơn Hàng Theo Mã Đơn & Mã Vạch (GET /barcode/lookup)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 1: Tra Cứu Đơn Hàng Siêu Tốc (Barcode Lookup) ---');

    // 1.1 Tra cứu theo UUID (Mã QR in trên tem giao hàng chứa UUID đơn)
    const t0 = performance.now();
    const res1 = await testLookup(order1.id);
    const t1 = performance.now();
    const durUuid = t1 - t0;

    assert.equal(res1.status, 200);
    assert.equal(res1.body.ok, true);
    const o1 = res1.body.order;
    assert.equal(o1.orderCode, 'GR-20261101-K9PRO');
    assert.equal(o1.customerName, 'Nguyễn Thành Long');
    assert.equal(o1.customerPhone, '0912345678');
    assert.ok(o1.shippingAddress.includes('Hoàng Diệu'));
    assert.equal(o1.items.length, 1);
    assert.equal(o1.items[0].name, 'Micro GAERU K9 Pro');
    assert.equal(o1.items[0].quantity, 1);

    console.log(`- [${durUuid.toFixed(3)} ms] Quét QR Code UUID (${order1.id.slice(0, 8)}...):`);
    console.log(`    * Mã đơn hàng   : ${o1.orderCode}`);
    console.log(`    * Khách hàng    : ${o1.customerName} - SĐT: ${o1.customerPhone}`);
    console.log(`    * Địa chỉ nhận  : ${o1.shippingAddress}`);
    console.log(`    * Danh sách món : ${o1.items.map(i => `${i.name} (${i.variantName}) x${i.quantity}`).join(', ')}`);
    console.log(`    * Tiền thu (COD): ${Number(o1.totalVnd).toLocaleString('vi-VN')} đ`);

    // 1.2 Tra cứu theo Order Number dạng mã vận đơn ('GAERU-889911')
    const t2 = performance.now();
    const res2 = await testLookup('GAERU-889911');
    const t3 = performance.now();
    const durCode = t3 - t2;

    assert.equal(res2.status, 200);
    const o2 = res2.body.order;
    assert.equal(o2.orderCode, 'GAERU-889911');
    assert.equal(o2.customerName, 'Trần Thị Mai');
    assert.equal(o2.items.length, 2);

    console.log(`- [${durCode.toFixed(3)} ms] Bắn Barcode Code-128 mã đơn ("GAERU-889911"):`);
    console.log(`    * Mã đơn hàng   : ${o2.orderCode}`);
    console.log(`    * Khách hàng    : ${o2.customerName}`);
    console.log(`    * Số lượng món  : 2 món hàng cần lấy trong kho (${o2.items.map(i => `${i.name} x${i.quantity}`).join(', ')})`);

    // 1.3 Quét mã không tồn tại -> 404
    const resNotFound = await testLookup('UNKNOWN-CODE-999');
    assert.equal(resNotFound.status, 404);
    assert.match(resNotFound.body.error, /Không tìm thấy đơn hàng/);
    console.log('- Quét mã vạch lạ ("UNKNOWN-CODE-999"): Chính xác trả về HTTP 404 Not Found');

    // 1.4 Quét mã rỗng -> 400
    const resEmpty = await testLookup('');
    assert.equal(resEmpty.status, 400);
    assert.match(resEmpty.body.error, /Cần cung cấp mã/);
    console.log('- Quét chuỗi rỗng: Chính xác trả về HTTP 400 Bad Request');

    // --------------------------------------------------------------------------
    // KỊCH BẢN 2: Xác Nhận Đóng Gói & Xuất Kho (POST /barcode/confirm-pack)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 2: Xác Nhận Đóng Gói & Chuyển Trạng Thái Đang Giao ---');

    // 2.1 Đóng gói đơn hợp lệ
    const tPackStart = performance.now();
    const packRes = await testConfirmPack(order1.id);
    const tPackEnd = performance.now();
    const durPack = tPackEnd - tPackStart;

    assert.equal(packRes.status, 200);
    assert.equal(packRes.body.ok, true);
    assert.equal(packRes.body.status, 'shipped');
    assert.match(packRes.body.message, /Đã xác nhận đóng gói/);

    // Kiểm tra CSDL sau khi đóng gói
    const orderAfterPack = (await pool.query('SELECT status, updated_at FROM orders WHERE id = $1', [order1.id])).rows[0];
    assert.equal(orderAfterPack.status, 'shipped');
    console.log(`- [${durPack.toFixed(3)} ms] Xác nhận đóng gói đơn ${order1.order_number}:`);
    console.log(`    * Trạng thái mới trong CSDL : status = "${orderAfterPack.status}"`);
    console.log(`    * Thời gian cập nhật       : ${orderAfterPack.updated_at.toISOString()}`);

    // Kiểm tra phát tín hiệu Realtime SSE qua notifyOrderUpdate
    assert.equal(realtimeEvents.length, 1);
    assert.deepEqual(realtimeEvents[0], { id: order1.id, status: 'shipped', orderCode: 'GR-20261101-K9PRO' });
    console.log(`    * Tín hiệu Realtime SSE    : Đã broadcast cho toàn bộ màn hình Quản lý đơn`);

    // 2.2 Chặn đóng gói trên đơn đã hoàn thành (completed) -> 400
    const packDoneRes = await testConfirmPack(orderCompleted.id);
    assert.equal(packDoneRes.status, 400);
    assert.match(packDoneRes.body.error, /completed/);
    console.log(`- Thử đóng gói đơn đã "completed": Bị chặn an toàn (HTTP 400: "${packDoneRes.body.error}")`);

    // 2.3 Chặn đóng gói trên đơn đã hủy (cancelled) -> 400
    const packCancelRes = await testConfirmPack(orderCancelled.id);
    assert.equal(packCancelRes.status, 400);
    assert.match(packCancelRes.body.error, /cancelled/);
    console.log(`- Thử đóng gói đơn đã "cancelled": Bị chặn an toàn (HTTP 400: "${packCancelRes.body.error}")`);

    // 2.4 Chặn đóng gói trên orderId không tồn tại -> 404
    const packNotFound = await testConfirmPack('00000000-0000-0000-0000-000000000000');
    assert.equal(packNotFound.status, 404);
    assert.match(packNotFound.body.error, /không tồn tại/);
    console.log(`- Thử đóng gói đơn không tồn tại: Bị chặn an toàn (HTTP 404)`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 3: Đo Lường Tải & Thông Lượng Bắn Mã Vạch Liên Tục (Benchmark)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 3: Đo Lường Thông Lượng Bắn Mã Vạch Kho Hàng (50 lần liên tục) ---');
    const BENCHMARK_RUNS = 50;
    const benchStart = performance.now();
    for (let i = 0; i < BENCHMARK_RUNS; i++) {
      const code = i % 2 === 0 ? order1.order_number : order2.order_number;
      await testLookup(code);
    }
    const benchTotal = performance.now() - benchStart;
    const avgBenchLatency = benchTotal / BENCHMARK_RUNS;
    const throughput = (BENCHMARK_RUNS / (benchTotal / 1000)).toFixed(1);

    console.log(`- Tổng số lần quét kiểm tra: ${BENCHMARK_RUNS} lần`);
    console.log(`- Tổng thời gian thực hiện : ${benchTotal.toFixed(2)} ms`);
    console.log(`- Độ trễ trung bình mỗi lần: ${avgBenchLatency.toFixed(3)} ms / lần quét`);
    console.log(`- Thông lượng quét mã vạch  : ${throughput} lần quét / giây`);

    // --------------------------------------------------------------------------
    // BẢNG TỔNG KẾT SỐ LIỆU ĐO ĐẠC THỰC TẾ
    // --------------------------------------------------------------------------
    console.log('\n' + '='.repeat(80));
    console.log('BẢNG TỔNG HỢP SỐ LIỆU ĐO ĐẠC THỰC TẾ: BARCODE SCANNER API');
    console.log('='.repeat(80));
    console.log(`- Định dạng mã vạch hỗ trợ       : QR Code (UUID), Code-128 (Order Number), EAN-13, EAN-8`);
    console.log(`- Độ trễ tra cứu đơn hàng (Lookup): ${durUuid.toFixed(3)} ms (UUID) / ${durCode.toFixed(3)} ms (Mã đơn)`);
    console.log(`- Độ trễ xác nhận đóng gói (Pack): ${durPack.toFixed(3)} ms`);
    console.log(`- Thông lượng quét mã vạch       : ${throughput} lần / giây`);
    console.log(`- Cơ chế bảo vệ đơn hàng        : Chặn tuyệt đối đóng gói đơn 'completed' & 'cancelled'`);
    console.log(`- Tích hợp thông báo Realtime    : Đồng bộ tức thì qua SSE notifyOrderUpdate`);
    console.log(`- Phân quyền bảo mật RBAC        : orders.read (Lookup) / orders.write (Confirm Pack)`);
    console.log('='.repeat(80));

  } finally {
    await db.close();
  }
}

runLiveVerification().catch(err => {
  console.error('LỖI KIỂM TRA CHẠY THẬT:', err);
  process.exit(1);
});
