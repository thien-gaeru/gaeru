'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { performance } = require('node:perf_hooks');
const { createTestDb } = require('../test/helpers/pglite-db');
const {
  processCodReconciliation,
  createCodReconciliationAdmin
} = require('../src/cod-reconciliation');

async function runLiveVerification() {
  console.log('='.repeat(80));
  console.log('KIỂM TRA CHẠY THẬT & ĐO LƯỜNG SỐ LIỆU THỰC TẾ: src/cod-reconciliation.js');
  console.log('Môi trường: Node.js 24 LTS · PostgreSQL Engine (PGlite) · Multi-Carrier COD Reconcile');
  console.log('='.repeat(80));

  const { db, pool } = await createTestDb({ migrate: false });

  try {
    // --------------------------------------------------------------------------
    // 0. Khởi tạo cấu trúc bảng CSDL chuẩn cho Orders và Đối Soát COD
    // --------------------------------------------------------------------------
    console.log('\n--- 0. KHỞI TẠO CẤU TRÚC BẢNG CSDL THỰC TẾ ---');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_number text UNIQUE NOT NULL,
        customer_name text NOT NULL,
        payment_method text NOT NULL DEFAULT 'cod',
        payment_status text NOT NULL DEFAULT 'pending',
        status text NOT NULL DEFAULT 'shipped',
        total_vnd bigint NOT NULL,
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS cod_reconciliations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_code text UNIQUE NOT NULL,
        carrier text NOT NULL DEFAULT 'spx',
        total_orders integer NOT NULL DEFAULT 0,
        total_collected_vnd bigint NOT NULL DEFAULT 0,
        total_fee_vnd bigint NOT NULL DEFAULT 0,
        net_transferred_vnd bigint NOT NULL DEFAULT 0,
        file_name text NOT NULL,
        status text NOT NULL DEFAULT 'reconciled' CHECK (status IN ('reconciled', 'discrepancy')),
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS cod_reconciliation_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id uuid NOT NULL REFERENCES cod_reconciliations(id) ON DELETE CASCADE,
        tracking_code text NOT NULL,
        order_code text,
        order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
        system_cod_vnd bigint NOT NULL DEFAULT 0,
        carrier_collected_vnd bigint NOT NULL DEFAULT 0,
        fee_vnd bigint NOT NULL DEFAULT 0,
        discrepancy_vnd bigint NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'matched' CHECK (status IN ('matched', 'mismatch', 'not_found', 'overdue')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS cod_items_batch_idx ON cod_reconciliation_items (batch_id);
    `);

    // Chèn 3 đơn hàng thực tế với các tình huống nghiệp vụ khác nhau
    await pool.query(`
      INSERT INTO orders (order_number, customer_name, payment_method, payment_status, status, total_vnd, note) VALUES
      ('GR-COD-MATCH-01', 'Nguyễn Văn Khớp', 'cod', 'pending', 'shipped', 500000, 'SPX: SPX99881122'),
      ('GR-COD-DIFF-02', 'Lê Thị Lệch Tiền', 'cod', 'pending', 'shipped', 800000, 'GHN: GHN77665544'),
      ('GR-ONLINE-GATEWAY-03', 'Trần Online VNPAY', 'vnpay', 'pending', 'shipped', 350000, 'VNPAY Đơn hàng bảo vệ');
    `);

    console.log('✔ Đã khởi tạo cấu trúc 3 bảng: `orders`, `cod_reconciliations`, `cod_reconciliation_items`');
    console.log('✔ Đã nạp 3 đơn hàng mẫu: Đơn COD chuẩn 500k, Đơn COD lệch tiền 800k, Đơn VNPAY 350k');

    // --------------------------------------------------------------------------
    // KỊCH BẢN 1: Bảng Kê Đối Soát Khớp Tiền 100% (Perfect Match)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 1: Đối Soát Bảng Kê Khớp Tiền 100% (Tự Động Đánh Dấu PAID) ---');
    const t0 = performance.now();
    const batchResult1 = await processCodReconciliation(pool, {
      carrier: 'spx',
      fileName: 'bang-ke-spx-khop-20261101.csv',
      items: [
        {
          trackingCode: 'SPX99881122',
          orderCode: 'GR-COD-MATCH-01',
          carrierCollectedVnd: 500000, // Thu hộ đúng 500.000₫
          feeVnd: 22000               // Phí giao hàng SPX 22.000₫
        }
      ]
    });
    const t1 = performance.now();
    const dur1 = t1 - t0;

    assert.equal(batchResult1.ok, true);
    assert.equal(batchResult1.totalOrders, 1);
    assert.equal(batchResult1.totalCollectedVnd, 500000);
    assert.equal(batchResult1.totalFeeVnd, 22000);
    assert.equal(batchResult1.netTransferredVnd, 478000); // 500k - 22k = 478k
    assert.equal(batchResult1.status, 'reconciled');

    // Kiểm tra đơn hàng được tự động chuyển thành 'paid' và 'completed'
    const order1After = (await pool.query(`SELECT status, payment_status FROM orders WHERE order_number = 'GR-COD-MATCH-01'`)).rows[0];
    assert.equal(order1After.payment_status, 'paid');
    assert.equal(order1After.status, 'completed');

    console.log(`- Thời gian xử lý đối soát        : ${dur1.toFixed(3)} ms`);
    console.log(`- Mã đợt đối soát (Batch Code)    : ${batchResult1.batchCode}`);
    console.log(`- Tổng thu hộ từ đơn vị vận chuyển: ${batchResult1.totalCollectedVnd.toLocaleString('vi-VN')}₫`);
    console.log(`- Tổng cước phí vận chuyển        : ${batchResult1.totalFeeVnd.toLocaleString('vi-VN')}₫`);
    console.log(`- Thực nhận chuyển khoản ngân hàng: ${batchResult1.netTransferredVnd.toLocaleString('vi-VN')}₫`);
    console.log(`- Trạng thái đợt đối soát         : ${batchResult1.status.toUpperCase()}`);
    console.log(`- Tự động cập nhật đơn hàng       : payment_status = PAID, status = COMPLETED ✔`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 2: Bảng Kê Đa Đơn Hỗn Hợp (Khớp, Lệch Tiền, Không Tìm Thấy, Bảo Vệ Cổng Online)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 2: Đối Soát Bảng Kê Đa Dạng (Lệch Tiền, Đơn Lạ, Chống Đè Cổng Online) ---');
    const batchResult2 = await processCodReconciliation(pool, {
      carrier: 'ghn',
      fileName: 'bang-ke-ghn-tong-hop-20261101.csv',
      items: [
        // 1. Đơn lệch tiền: Hệ thống 800k, GHN thu 750k (discrepancy = -50k)
        {
          trackingCode: 'GHN77665544',
          orderCode: 'GR-COD-DIFF-02',
          carrierCollectedVnd: 750000,
          feeVnd: 35000
        },
        // 2. Đơn không tồn tại trên hệ thống
        {
          trackingCode: 'GHN_UNKNOWN_9999',
          orderCode: 'GR-UNKNOWN-999',
          carrierCollectedVnd: 300000,
          feeVnd: 18000
        },
        // 3. Đơn cổng Online VNPAY (Không được phép ghi đè trạng thái qua COD)
        {
          trackingCode: 'VNPAY_FAKE_CODE',
          orderCode: 'GR-ONLINE-GATEWAY-03',
          carrierCollectedVnd: 350000,
          feeVnd: 15000
        }
      ]
    });

    assert.equal(batchResult2.ok, true);
    assert.equal(batchResult2.totalOrders, 3);
    assert.equal(batchResult2.totalCollectedVnd, 750000 + 300000 + 350000); // 1.400.000₫
    assert.equal(batchResult2.totalFeeVnd, 35000 + 18000 + 15000);          // 68.000₫
    assert.equal(batchResult2.netTransferredVnd, 1400000 - 68000);           // 1.332.000₫
    assert.equal(batchResult2.status, 'discrepancy'); // Do có lệch tiền và đơn không tìm thấy

    // Kiểm tra chi tiết từng dòng trong bảng cod_reconciliation_items
    const batch2Row = (await pool.query(`SELECT id FROM cod_reconciliations WHERE batch_code = $1`, [batchResult2.batchCode])).rows[0];
    const itemsBatch2 = (await pool.query(`SELECT * FROM cod_reconciliation_items WHERE batch_id = $1 ORDER BY carrier_collected_vnd DESC`, [batch2Row.id])).rows;

    const itemMismatch = itemsBatch2.find(it => it.order_code === 'GR-COD-DIFF-02');
    assert.equal(itemMismatch.status, 'mismatch');
    assert.equal(Number(itemMismatch.discrepancy_vnd), -50000); // Lệch thiếu 50k

    const itemNotFound = itemsBatch2.find(it => it.order_code === 'GR-UNKNOWN-999');
    assert.equal(itemNotFound.status, 'not_found');

    const itemOnline = itemsBatch2.find(it => it.order_code === 'GR-ONLINE-GATEWAY-03');
    assert.equal(itemOnline.status, 'matched');

    // Kiểm tra đơn lệch tiền không bị đổi thành 'paid'
    const order2After = (await pool.query(`SELECT payment_status FROM orders WHERE order_number = 'GR-COD-DIFF-02'`)).rows[0];
    assert.equal(order2After.payment_status, 'pending');

    // Kiểm tra đơn VNPAY không bị ghi đè thanh toán qua bảng kê COD
    const order3After = (await pool.query(`SELECT payment_status FROM orders WHERE order_number = 'GR-ONLINE-GATEWAY-03'`)).rows[0];
    assert.equal(order3After.payment_status, 'pending');

    console.log(`- Trạng thái đợt đối soát 2       : ${batchResult2.status.toUpperCase()} (Phát hiện sai lệch cần xử lý)`);
    console.log(`- Dòng 1 [Lệch tiền]              : Thu ${Number(itemMismatch.carrier_collected_vnd).toLocaleString('vi-VN')}₫ vs Hệ thống ${Number(itemMismatch.system_cod_vnd).toLocaleString('vi-VN')}₫ -> Lệch: ${Number(itemMismatch.discrepancy_vnd).toLocaleString('vi-VN')}₫ (Giữ nguyên pending)`);
    console.log(`- Dòng 2 [Không tìm thấy]         : Đơn lạ "${itemNotFound.order_code}" -> Trạng thái: ${itemNotFound.status}`);
    console.log(`- Dòng 3 [Bảo vệ cổng Online]     : Cổng ${order3After.payment_status} VNPAY không bị ghi đè trái phép bởi bảng kê COD ✔`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 3: Kiểm Thử Router Quản Trị Hệ Thống (Admin Endpoints)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 3: Kiểm Thử Điểm Cuối Quản Trị Hệ Thống & Kế Toán ---');
    const app = express();
    app.use(express.json());
    // Giả lập admin session với quyền kế toán và thanh toán
    app.use((req, res, next) => {
      req.admin = { id: 'admin_kt', username: 'ketoan_truong', permissions: ['payments.write', 'finance.read'] };
      next();
    });
    app.use('/api/gaeru_ceo', createCodReconciliationAdmin(pool));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      // 1. GET /api/gaeru_ceo/cod/batches (Xem danh sách các đợt đối soát)
      const batchesRes = await fetch(`${baseUrl}/api/gaeru_ceo/cod/batches`);
      assert.equal(batchesRes.status, 200);
      const batchesData = await batchesRes.json();
      assert.equal(batchesData.batches.length, 2);
      console.log(`✔ GET /api/gaeru_ceo/cod/batches -> HTTP 200 OK (Danh sách 2 đợt đối soát SPX và GHN)`);

      // 2. GET /api/gaeru_ceo/cod/batches/:id (Xem chi tiết từng đơn hàng trong đợt đối soát)
      const detailRes = await fetch(`${baseUrl}/api/gaeru_ceo/cod/batches/${batch2Row.id}`);
      assert.equal(detailRes.status, 200);
      const detailData = await detailRes.json();
      assert.equal(detailData.items.length, 3);
      assert.equal(detailData.batch.batchCode, batchResult2.batchCode);
      console.log(`✔ GET /api/gaeru_ceo/cod/batches/:id -> HTTP 200 OK (Chi tiết 3 dòng đơn hàng của đợt đối soát)`);

      // 3. POST /api/gaeru_ceo/cod/reconcile với danh sách rỗng -> Bắt lỗi 400
      const emptyPostRes = await fetch(`${baseUrl}/api/gaeru_ceo/cod/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ carrier: 'spx', fileName: 'empty.csv', items: [] })
      });
      assert.equal(emptyPostRes.status, 400);
      console.log(`✔ POST /api/gaeru_ceo/cod/reconcile với danh sách rỗng -> Chặn đứng HTTP 400 Bad Request`);
    } finally {
      server.close();
    }

    console.log('\n' + '='.repeat(80));
    console.log('BẢNG TỔNG HỢP SỐ LIỆU ĐO ĐẠC THỰC TẾ: COD RECONCILIATION');
    console.log('='.repeat(80));
    console.log(`- Độ trễ đối soát tự động          : ${dur1.toFixed(3)} ms`);
    console.log(`- Cơ chế khớp đơn hàng             : Khớp theo Mã đơn hàng (order_number) hoặc Mã vận đơn (note)`);
    console.log(`- Tự động hoàn tất (Auto Complete) : Chuyển đơn COD sang PAID và COMPLETED khi khớp tiền`);
    console.log(`- Phát hiện sai lệch (Discrepancy) : Đánh dấu MISMATCH, lưu vết discrepancy_vnd, giữ nguyên PENDING`);
    console.log(`- Bảo vệ cổng Online Gateway       : Tuyệt đối không ghi đè đơn hàng MoMo/ZaloPay/VNPAY`);
    console.log(`- Tính toán tài chính thực nhận    : netTransferred = totalCollected - totalFee`);
    console.log(`- Điểm cuối API Kế toán            : POST /api/gaeru_ceo/cod/reconcile | GET /api/gaeru_ceo/cod/batches`);
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
