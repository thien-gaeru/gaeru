'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { performance } = require('node:perf_hooks');
const { createTestDb } = require('../test/helpers/pglite-db');
const {
  RFM_SEGMENTS,
  scoreRecency,
  scoreFrequency,
  scoreMonetary,
  determineSegment,
  getRfmCustomerSegmentation,
  createRfmAdminRouter
} = require('../src/rfm-analytics');

async function runLiveVerification() {
  console.log('='.repeat(80));
  console.log('KIỂM TRA CHẠY THẬT & ĐO LƯỜNG SỐ LIỆU THỰC TẾ: src/rfm-analytics.js');
  console.log('Môi trường: Node.js 24 LTS · PostgreSQL Engine (PGlite) · Phân Khúc RFM Analytics');
  console.log('='.repeat(80));

  const { db, pool } = await createTestDb({ migrate: true });

  try {
    // --------------------------------------------------------------------------
    // KỊCH BẢN 1: KIỂM THỬ THUẬT TOÁN CHẤM ĐIỂM TOÁN HỌC (SCORING MATRIX)
    // --------------------------------------------------------------------------
    console.log('\n--- 1. KIỂM THỬ MA TRẬN CHẤM ĐIỂM TOÁN HỌC (R - F - M) ---');

    // 1. Recency Scoring (R)
    assert.equal(scoreRecency(10), 5, 'R=5 khi mua trong vòng 30 ngày');
    assert.equal(scoreRecency(45), 4, 'R=4 khi mua từ 31-60 ngày');
    assert.equal(scoreRecency(75), 3, 'R=3 khi mua từ 61-90 ngày');
    assert.equal(scoreRecency(150), 2, 'R=2 khi mua từ 91-180 ngày');
    assert.equal(scoreRecency(200), 1, 'R=1 khi mua > 180 ngày');
    assert.equal(scoreRecency(null), 1, 'R=1 khi chưa có ngày mua');

    // 2. Frequency Scoring (F)
    assert.equal(scoreFrequency(6), 5, 'F=5 khi mua >= 5 lần');
    assert.equal(scoreFrequency(4), 4, 'F=4 khi mua 3-4 lần');
    assert.equal(scoreFrequency(2), 3, 'F=3 khi mua 2 lần');
    assert.equal(scoreFrequency(1), 2, 'F=2 khi mua 1 lần');
    assert.equal(scoreFrequency(0), 1, 'F=1 khi 0 đơn');

    // 3. Monetary Scoring (M)
    assert.equal(scoreMonetary(6000000), 5, 'M=5 khi chi tiêu >= 5.000.000₫');
    assert.equal(scoreMonetary(3500000), 4, 'M=4 khi chi tiêu 3.000.000 - 4.999.999₫');
    assert.equal(scoreMonetary(2000000), 3, 'M=3 khi chi tiêu 1.500.000 - 2.999.999₫');
    assert.equal(scoreMonetary(800000), 2, 'M=2 khi chi tiêu 500.000 - 1.499.999₫');
    assert.equal(scoreMonetary(300000), 1, 'M=1 khi chi tiêu < 500.000₫');

    // 4. Phân loại phân khúc (determineSegment)
    assert.equal(determineSegment(5, 5, 5), 'champions');
    assert.equal(determineSegment(3, 3, 3), 'loyal');
    assert.equal(determineSegment(5, 1, 2), 'promising');
    assert.equal(determineSegment(2, 4, 3), 'at_risk');
    assert.equal(determineSegment(1, 1, 1), 'lost');

    console.log('✔ Toàn bộ 5 thang điểm R, 5 thang điểm F, 5 thang điểm M và 5 phân khúc hoạt động chuẩn xác 100%.');

    // --------------------------------------------------------------------------
    // KỊCH BẢN 2: KHỞI TẠO DỮ LIỆU ĐƠN HÀNG THỰC TẾ TRÊN POSTGRESQL
    // --------------------------------------------------------------------------
    console.log('\n--- 2. KHỞI TẠO CÁC TẬP KHÁCH HÀNG & ĐƠN HÀNG THỰC TẾ ---');

    // KH 1: VIP Champions (0911000001) - 4 đơn, gần đây (10 ngày), tổng chi 7.500.000₫
    await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES 
         ('ORD-VIP-01', 'Nguyễn Thái Hoàng', 'hoang.vip@gaeru.com', '0911000001', 'Ba Đình', 'Hà Nội', 'momo', 'completed', 2500000, 2500000, now() - interval '25 days'),
         ('ORD-VIP-02', 'Nguyễn Thái Hoàng', 'hoang.vip@gaeru.com', '0911000001', 'Ba Đình', 'Hà Nội', 'zalopay', 'completed', 2000000, 2000000, now() - interval '18 days'),
         ('ORD-VIP-03', 'Nguyễn Thái Hoàng', 'hoang.vip@gaeru.com', '0911000001', 'Ba Đình', 'Hà Nội', 'vnpay', 'completed', 1500000, 1500000, now() - interval '12 days'),
         ('ORD-VIP-04', 'Nguyễn Thái Hoàng', 'hoang.vip@gaeru.com', '0911000001', 'Ba Đình', 'Hà Nội', '9pay', 'completed', 1500000, 1500000, now() - interval '10 days')`
    );

    // KH 2: Loyal (0911000002) - 2 đơn, mua 45 ngày trước, tổng chi 2.200.000₫
    await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES 
         ('ORD-LOYAL-01', 'Trần Thu Trang', 'trang.loyal@gaeru.com', '0911000002', 'Hải Châu', 'Đà Nẵng', 'bank_transfer', 'completed', 1200000, 1200000, now() - interval '50 days'),
         ('ORD-LOYAL-02', 'Trần Thu Trang', 'trang.loyal@gaeru.com', '0911000002', 'Hải Châu', 'Đà Nẵng', 'cod', 'completed', 1000000, 1000000, now() - interval '45 days')`
    );

    // KH 3: At-Risk (0911000003) - 3 đơn, nhưng đã 130 ngày chưa mua lại, tổng chi 3.200.000₫
    await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES 
         ('ORD-RISK-01', 'Lê Hữu Nghĩa', 'nghia.risk@gaeru.com', '0911000003', 'Quận 1', 'TP.HCM', 'cod', 'completed', 1000000, 1000000, now() - interval '150 days'),
         ('ORD-RISK-02', 'Lê Hữu Nghĩa', 'nghia.risk@gaeru.com', '0911000003', 'Quận 1', 'TP.HCM', 'cod', 'completed', 1200000, 1200000, now() - interval '140 days'),
         ('ORD-RISK-03', 'Lê Hữu Nghĩa', 'nghia.risk@gaeru.com', '0911000003', 'Quận 1', 'TP.HCM', 'cod', 'completed', 1000000, 1000000, now() - interval '130 days')`
    );

    // KH 4: Đơn Bom / Huỷ (0911000004) - Đơn hàng bị huỷ (cancelled), hệ thống PHẢI loại trừ hoàn toàn!
    await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES 
         ('ORD-BOM-01', 'Kẻ Gian Lận', 'scam@gaeru.com', '0911000004', 'Ninh Kiều', 'Cần Thơ', 'cod', 'cancelled', 50000000, 50000000, now() - interval '5 days')`
    );

    console.log('✔ Đã khởi tạo 7 đơn hàng thành công và 1 đơn huỷ thử nghiệm trong CSDL.');

    // --------------------------------------------------------------------------
    // KỊCH BẢN 3: THỰC THI PHÂN TÍCH RFM TRÊN TOÀN BỘ CƠ SỞ DỮ LIỆU
    // --------------------------------------------------------------------------
    console.log('\n--- 3. THỰC THI THUẬT TOÁN PHÂN TÍCH RFM TRÊN CSDL THỰC TẾ ---');
    const t0 = performance.now();
    const rfmResult = await getRfmCustomerSegmentation(pool);
    const t1 = performance.now();
    const durRfmMs = t1 - t0;

    const { totalCustomers, totalRevenueVnd, summary, customers } = rfmResult;

    console.log(`- Thời gian xử lý RFM toàn bộ CSDL : ${durRfmMs.toFixed(3)} ms`);
    console.log(`- Tổng số khách hàng hợp lệ       : ${totalCustomers} khách (Đã loại trừ 100% đơn huỷ)`);
    console.log(`- Tổng doanh thu phân tích         : ${totalRevenueVnd.toLocaleString('vi-VN')}₫`);

    assert.equal(totalCustomers, 3, 'Chỉ có 3 khách hàng hợp lệ vì khách bom hàng đã bị lọc');
    assert.equal(totalRevenueVnd, 7500000 + 2200000 + 3200000); // 12.900.000₫

    // Kiểm tra chi tiết từng khách hàng
    const vipCust = customers.find(c => c.phone === '0911000001');
    assert.ok(vipCust);
    assert.equal(vipCust.segment, 'champions');
    assert.equal(vipCust.badge, '👑 VIP');
    assert.equal(vipCust.orderCount, 4);
    assert.equal(vipCust.totalSpendVnd, 7500000);
    assert.equal(vipCust.scores.r, 5); // 10 ngày -> R=5
    assert.equal(vipCust.scores.f, 4); // 4 đơn -> F=4
    assert.equal(vipCust.scores.m, 5); // 7.5 triệu -> M=5

    const loyalCust = customers.find(c => c.phone === '0911000002');
    assert.ok(loyalCust);
    assert.equal(loyalCust.segment, 'loyal');
    assert.equal(loyalCust.badge, '🌟 Thân thiết');
    assert.equal(loyalCust.orderCount, 2);
    assert.equal(loyalCust.totalSpendVnd, 2200000);

    const riskCust = customers.find(c => c.phone === '0911000003');
    assert.ok(riskCust);
    assert.equal(riskCust.segment, 'at_risk');
    assert.equal(riskCust.badge, '⚠️ Nguy cơ');
    assert.equal(riskCust.orderCount, 3);
    assert.equal(riskCust.scores.r, 2); // 130 ngày -> R=2
    assert.equal(riskCust.scores.f, 4); // 3 đơn -> F=4

    // Kiểm tra khách hàng huỷ đơn không có trong danh sách
    const cancelledCust = customers.find(c => c.phone === '0911000004');
    assert.equal(cancelledCust, undefined, 'Khách hàng chỉ có đơn huỷ không được xuất hiện');

    console.log('\n--- BẢNG CHI TIẾT 5 PHÂN KHÚC KHÁCH HÀNG (RFM CLUSTERING) ---');
    summary.forEach(s => {
      console.log(`[${s.badge.padEnd(16)}] Số KH: ${String(s.customerCount).padStart(2)} (${String(s.percentage).padStart(5)}%) | Doanh thu: ${s.totalRevenueVnd.toLocaleString('vi-VN').padStart(12)}₫ | Hành động: ${s.recommendedAction}`);
    });

    // --------------------------------------------------------------------------
    // KỊCH BẢN 4: ROUTER QUẢN TRỊ ADMIN (GET /customers/rfm & SYNC MARKETING)
    // --------------------------------------------------------------------------
    console.log('\n--- 4. KIỂM THỬ ROUTER QUẢN TRỊ & ĐỒNG BỘ CHIẾN DỊCH MARKETING ---');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.admin = { id: 'admin_cmo', permissions: ['customers.read', 'customers.write'] };
      next();
    });
    app.use(createRfmAdminRouter(pool));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      // 1. GET /customers/rfm (Báo cáo RFM tổng quan)
      const getRes = await fetch(`${baseUrl}/customers/rfm`);
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.equal(getData.totalCustomers, 3);
      assert.equal(getData.summary.length, 5);
      console.log(`✔ GET /customers/rfm -> HTTP 200 OK (Truy vấn thành công 3 khách hàng & 5 phân khúc)`);

      // 2. GET /customers/rfm/sync-marketing (Đồng bộ chiến dịch Remarketing tự động)
      const syncRes = await fetch(`${baseUrl}/customers/rfm/sync-marketing`);
      assert.equal(syncRes.status, 200);
      const syncData = await syncRes.json();
      assert.equal(syncData.success, true);
      assert.equal(syncData.segments.atRisk.count, 1);
      assert.equal(syncData.segments.champions.count, 1);
      assert.ok(syncData.segments.atRisk.campaignSuggestion.includes('Ưu đãi tri ân'));
      console.log(`✔ GET /customers/rfm/sync-marketing -> HTTP 200 OK (Đồng bộ 3 chiến dịch: At-Risk, Lost, Champions)`);
    } finally {
      server.close();
    }

    console.log('\n' + '='.repeat(80));
    console.log('BẢNG TỔNG HỢP SỐ LIỆU ĐO ĐẠC THỰC TẾ: RFM CUSTOMER SEGMENTATION');
    console.log('='.repeat(80));
    console.log(`- Thời gian tính toán RFM        : ${durRfmMs.toFixed(3)} ms`);
    console.log(`- Nhận diện khách hàng qua       : Số điện thoại (Phone Unique Grouping)`);
    console.log(`- Quy mô phân khúc               : 5 cấp độ (Champions, Loyal, Promising, At-Risk, Lost)`);
    console.log(`- Độ chính xác lọc đơn huỷ       : 100% (WHERE status NOT IN ('cancelled'))`);
    console.log(`- Hành động chiến dịch đề xuất   : Voucher VIP 15%, CTV Affiliate 8%, Tri ân 10%...`);
    console.log(`- Điểm cuối Quản trị viên        : GET /customers/rfm | GET /customers/rfm/sync-marketing`);
    console.log('='.repeat(80));

  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  runLiveVerification()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Verification Failed]', err);
      process.exit(1);
    });
}

module.exports = { runLiveVerification };
