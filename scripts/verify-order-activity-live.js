'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { performance } = require('node:perf_hooks');
const { createTestDb } = require('../test/helpers/pglite-db');
const {
  ACTIVITY_LABELS,
  logOrderActivity,
  getOrderActivities,
  createOrderActivityAdminRouter
} = require('../src/order-activity');

async function runLiveVerification() {
  console.log('='.repeat(80));
  console.log('KIỂM TRA CHẠY THẬT & ĐO LƯỜNG SỐ LIỆU THỰC TẾ: src/order-activity.js');
  console.log('Môi trường: Node.js 24 LTS · PostgreSQL Engine (PGlite) · Vết Kiểm Toán Đơn Hàng');
  console.log('='.repeat(80));

  const { db, pool } = await createTestDb({ migrate: true });

  try {
    // --------------------------------------------------------------------------
    // 1. KHỞI TẠO ĐƠN HÀNG THỰC TẾ
    // --------------------------------------------------------------------------
    console.log('\n--- 1. KHỞI TẠO ĐƠN HÀNG MẪU TRONG CSDL ---');
    const orderRes = await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES ('GR-ORD-TIMELINE-01', 'Trần Bảo Ngọc', 'baongoc@gaeru.com', '0918889999', '123 Hai Bà Trưng', 'Hà Nội', 'momo', 'pending', 1250000, 1250000, now())
       RETURNING id, order_number`
    );
    const order = orderRes.rows[0];
    console.log(`✔ Đã tạo đơn hàng kiểm thử: ID = ${order.id} | Mã đơn = ${order.order_number}`);

    // --------------------------------------------------------------------------
    // 2. GHI NHẬN VÒNG ĐỜI VẾT KIỂM TOÁN THỰC TẾ (TIMELINE EVENT LOGGING)
    // --------------------------------------------------------------------------
    console.log('\n--- 2. MÔ PHỎNG VÒNG ĐỜI ĐƠN HÀNG: 8 SỰ KIỆN KIỂM TOÁN BẤT BIẾN ---');

    const sampleEvents = [
      {
        action: 'created',
        actorType: 'customer',
        actorName: 'Khách hàng Trần Bảo Ngọc',
        details: { channel: 'web_storefront', ip: '14.225.210.12' }
      },
      {
        action: 'paid',
        actorType: 'gateway',
        actorName: 'Cổng thanh toán MoMo',
        details: { transactionId: 'MOMO_TX_2026110199', amountVnd: 1250000, payType: 'qr' }
      },
      {
        action: 'status_changed',
        actorType: 'system',
        actorName: 'Hệ thống GAERU Core',
        details: { fromStatus: 'pending', toStatus: 'confirmed', reason: 'Tự động duyệt đơn đã thanh toán' }
      },
      {
        action: 'printed_packing_slip',
        actorType: 'staff',
        actorName: 'Kho Thủ Đức (Nguyễn Văn Kho)',
        details: { printer: 'Xprinter_XP420B', slipCode: 'SLIP-889900' }
      },
      {
        action: 'scanned_barcode',
        actorType: 'staff',
        actorName: 'Trạm Kiểm Soát Đóng Gói PDA-02',
        details: { sku: 'K9-PRO-RGB', barcode: '8938501234567', serialNumber: 'SN2026110101' }
      },
      {
        action: 'tracking_assigned',
        actorType: 'staff',
        actorName: 'Bộ phận Điều phối Vận chuyển',
        details: { carrier: 'SPX Express', trackingCode: 'SPX_VN_2026_998877' }
      },
      {
        action: 'note_added',
        actorType: 'staff',
        actorName: 'CSKH Ca Sáng (Lê Thị Mai)',
        details: { note: 'Khách dặn gọi điện trước khi giao 15 phút, giao sau 17h chiều.' }
      },
      {
        action: 'rma_opened',
        actorType: 'staff',
        actorName: 'Trung Tâm Bảo Hành & CSKH',
        details: { ticketNumber: 'RMA-2026-999', issue: 'Hỗ trợ thay switch blue' }
      }
    ];

    const t0 = performance.now();
    for (const ev of sampleEvents) {
      const logged = await logOrderActivity(pool, {
        orderId: order.id,
        orderNumber: order.order_number,
        actorType: ev.actorType,
        actorName: ev.actorName,
        action: ev.action,
        details: ev.details
      });
      assert.ok(logged.id, 'Bản ghi vết kiểm toán phải có ID duy nhất');
    }
    const t1 = performance.now();
    const durInsertAllMs = t1 - t0;
    const avgInsertMs = durInsertAllMs / sampleEvents.length;

    console.log(`- Đã ghi thành công toàn bộ ${sampleEvents.length} sự kiện kiểm toán.`);
    console.log(`- Tổng thời gian ghi nhận       : ${durInsertAllMs.toFixed(3)} ms`);
    console.log(`- Độ trễ trung bình / 1 sự kiện  : ${avgInsertMs.toFixed(3)} ms`);

    // --------------------------------------------------------------------------
    // 3. TRUY VẤN LỊCH SỬ DÒNG THỜI GIAN (ORDER TIMELINE QUERY)
    // --------------------------------------------------------------------------
    console.log('\n--- 3. TRUY VẤN DÒNG THỜI GIAN THEO UUID VÀ MÃ ĐƠN HÀNG ---');
    const t2 = performance.now();
    // 3.1. Truy vấn theo UUID
    const activitiesById = await getOrderActivities(pool, order.id);
    const t3 = performance.now();
    const durQueryMs = t3 - t2;

    assert.equal(activitiesById.length, 8);
    assert.equal(activitiesById[0].action, 'created');
    assert.equal(activitiesById[0].actionLabel, 'Đơn hàng được tạo thành công');
    assert.equal(activitiesById[1].actor_type, 'gateway');
    assert.equal(activitiesById[6].action, 'note_added');
    assert.equal(activitiesById[6].details.note, 'Khách dặn gọi điện trước khi giao 15 phút, giao sau 17h chiều.');

    // 3.2. Truy vấn theo mã đơn hàng String (Human-readable order_number)
    const activitiesByNumber = await getOrderActivities(pool, order.order_number);
    assert.equal(activitiesByNumber.length, 8);

    console.log(`- Thời gian truy vấn Timeline     : ${durQueryMs.toFixed(3)} ms`);
    console.log(`- Số lượng mốc thời gian ghi nhận : ${activitiesById.length} mốc`);
    console.log(`- Khả năng tra cứu đa dạng        : Hỗ trợ cả UUID lẫn Order Number String`);

    console.log('\n--- LỊCH SỬ DÒNG THỜI GIAN ĐƠN HÀNG (TIMELINE REPORT) ---');
    activitiesById.forEach((act, idx) => {
      console.log(`[${idx + 1}] [${act.formattedTime}] [${String(act.actor_type).toUpperCase().padEnd(8)}] (${act.actor_name}): ${act.actionLabel}`);
      if (act.details && Object.keys(act.details).length > 0) {
        console.log(`    ↳ Chi tiết: ${JSON.stringify(act.details)}`);
      }
    });

    // --------------------------------------------------------------------------
    // 4. KIỂM THỬ ROUTER QUẢN TRỊ ADMIN (GET & POST NOTES)
    // --------------------------------------------------------------------------
    console.log('\n--- 4. KIỂM THỬ ROUTER QUẢN TRỊ ADMIN (API ENDPOINTS) ---');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.admin = { id: 'admin_lead', username: 'tran_manager', permissions: ['orders.read', 'orders.write'] };
      next();
    });
    app.use(createOrderActivityAdminRouter(pool));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      // 4.1. GET /orders/:id/activities
      const getRes = await fetch(`${baseUrl}/orders/${order.id}/activities`);
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.ok(Array.isArray(getData.activities));
      assert.equal(getData.activities.length, 8);
      console.log(`✔ GET /orders/:id/activities -> HTTP 200 OK (Truy xuất thành công ${getData.activities.length} sự kiện)`);

      // 4.2. POST /orders/:id/notes (Thêm ghi chú nhân viên)
      const postRes = await fetch(`${baseUrl}/orders/${order.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Đã xác nhận thanh toán phụ phí gói quà cao cấp.' })
      });
      assert.equal(postRes.status, 200);
      const postData = await postRes.json();
      assert.equal(postData.success, true);
      assert.equal(postData.activity.actor_name, 'tran_manager');
      assert.equal(postData.activity.action, 'note_added');
      console.log(`✔ POST /orders/:id/notes -> HTTP 200 OK (Ghi chú mới được tạo bởi staff: ${postData.activity.actor_name})`);

      // 4.3. POST /orders/:id/notes (Validation chặn ghi chú rỗng)
      const badRes = await fetch(`${baseUrl}/orders/${order.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: '   ' })
      });
      assert.equal(badRes.status, 400);
      const badData = await badRes.json();
      assert.equal(badData.error, 'Nội dung ghi chú không được để trống.');
      console.log(`✔ Validation an toàn: Chặn thành công ghi chú rỗng -> HTTP 400 (${badData.error})`);

      // 4.4. Kiểm tra lại Timeline sau khi thêm note
      const recheck = await getOrderActivities(pool, order.id);
      assert.equal(recheck.length, 9, 'Timeline phải tăng lên 9 sự kiện');
    } finally {
      server.close();
    }

    console.log('\n' + '='.repeat(80));
    console.log('BẢNG TỔNG HỢP SỐ LIỆU ĐO ĐẠC THỰC TẾ: ORDER ACTIVITY TIMELINE');
    console.log('='.repeat(80));
    console.log(`- Độ trễ ghi nhận sự kiện trung bình: ${avgInsertMs.toFixed(3)} ms`);
    console.log(`- Độ trễ truy vấn dòng thời gian    : ${durQueryMs.toFixed(3)} ms`);
    console.log(`- Nhóm tác nhân hỗ trợ (Actor Types): 4 nhóm (customer, staff, system, gateway)`);
    console.log(`- Khả năng truy xuất linh hoạt     : Cả UUID (order_id) lẫn String (order_number)`);
    console.log(`- Chuẩn hóa thời gian địa phương    : Múi giờ Asia/Ho_Chi_Minh (vi-VN)`);
    console.log(`- Bảo vệ ghi chú nhân viên         : Validate chống ghi chú trống, gắn username staff`);
    console.log(`- Điểm cuối Quản trị viên          : GET /orders/:id/activities | POST /orders/:id/notes`);
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
