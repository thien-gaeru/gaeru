'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { performance } = require('node:perf_hooks');
const { createTestDb } = require('../test/helpers/pglite-db');
const {
  getInventoryForecast,
  createInventoryForecastAdmin
} = require('../src/inventory-forecast');

async function runLiveVerification() {
  console.log('='.repeat(80));
  console.log('KIỂM TRA CHẠY THẬT & ĐO LƯỜNG SỐ LIỆU THỰC TẾ: src/inventory-forecast.js');
  console.log('Môi trường: Node.js 24 LTS · PostgreSQL Engine (PGlite) · Smart ROP Forecasting');
  console.log('='.repeat(80));

  const { db, pool } = await createTestDb({ migrate: true });

  try {
    console.log('\n--- 1. KHỞI TẠO DỮ LIỆU SẢN PHẨM & ĐƠN HÀNG THỰC TẾ TRONG 30 NGÀY ---');

    // 1. Tạo 4 sản phẩm với các biến thể đại diện các mức tồn kho khác nhau
    // P1: Bàn Phím Cơ K9 Pro (SKU-K9-OUT: Hết hàng, tồn 0)
    // P2: Chuột Công Thái Học M1 (SKU-M1-CRIT: Cấp bách, tồn 2, bán 60 cái / 30 ngày -> vận tốc 2 cái/ngày)
    // P3: Cáp Sạc Type-C GaN 100W (SKU-C100-WARN: Cần nhập thêm, tồn 8, bán 15 cái / 30 ngày)
    // P4: Tai Nghe Bluetooth Air-5 (SKU-AIR5-OK: Tồn kho dồi dào an toàn, tồn 120, bán 30 cái / 30 ngày)
    const p1 = (await pool.query(
      `INSERT INTO products (name, slug, category, active)
       VALUES ('Bàn Phím Cơ K9 Pro', 'ban-phim-co-k9-pro', 'accessory', true)
       RETURNING id`
    )).rows[0];

    const p2 = (await pool.query(
      `INSERT INTO products (name, slug, category, active)
       VALUES ('Chuột Công Thái Học M1', 'chuot-cong-thai-hoc-m1', 'accessory', true)
       RETURNING id`
    )).rows[0];

    const p3 = (await pool.query(
      `INSERT INTO products (name, slug, category, active)
       VALUES ('Cáp Sạc Type-C GaN 100W', 'cap-sac-type-c-gan-100w', 'accessory', true)
       RETURNING id`
    )).rows[0];

    const p4 = (await pool.query(
      `INSERT INTO products (name, slug, category, active)
       VALUES ('Tai Nghe Bluetooth Air-5', 'tai-nghe-bluetooth-air-5', 'audio', true)
       RETURNING id`
    )).rows[0];

    // Tạo biến thể cho từng sản phẩm
    const v1 = (await pool.query(
      `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'SKU-K9-OUT', 'Đen RGB', 1500000, 0, true) RETURNING id`,
      [p1.id]
    )).rows[0];

    const v2 = (await pool.query(
      `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'SKU-M1-CRIT', 'Xám Không Gian', 750000, 2, true) RETURNING id`,
      [p2.id]
    )).rows[0];

    const v3 = (await pool.query(
      `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'SKU-C100-WARN', 'Trắng Bện Dù 1.5m', 250000, 8, true) RETURNING id`,
      [p3.id]
    )).rows[0];

    const v4 = (await pool.query(
      `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'SKU-AIR5-OK', 'Trắng Tinh Khôi', 990000, 120, true) RETURNING id`,
      [p4.id]
    )).rows[0];

    // Tạo đơn hàng thật trong 30 ngày qua
    // Đơn 1: Mua 60 con chuột M1 (Hoàn thành)
    const o1 = (await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES ('GR-ORD-01', 'KH Vận Tốc Cao', 'vt@gaeru.com', '0912345678', '123 Cầu Giấy', 'Hà Nội', 'cod', 'completed', 45000000, 45000000, now() - interval '5 days')
       RETURNING id`
    )).rows[0];
    await pool.query(
      `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
       VALUES ($1, $2, 'Chuột Công Thái Học M1', 'Xám Không Gian', 'SKU-M1-CRIT', 750000, 60, 45000000)`,
      [o1.id, v2.id]
    );

    // Đơn 2: Mua 15 cáp sạc C100 (Đang giao hàng -> status 'shipped')
    const o2 = (await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES ('GR-ORD-02', 'KH Tiêu Chuẩn', 'tc@gaeru.com', '0987654321', '456 Lê Duẩn', 'Đà Nẵng', 'bank_transfer', 'shipped', 3750000, 3750000, now() - interval '10 days')
       RETURNING id`
    )).rows[0];
    await pool.query(
      `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
       VALUES ($1, $2, 'Cáp Sạc Type-C GaN 100W', 'Trắng Bện Dù 1.5m', 'SKU-C100-WARN', 250000, 15, 3750000)`,
      [o2.id, v3.id]
    );

    // Đơn 3: Mua 30 tai nghe Air-5 (Hoàn thành)
    const o3 = (await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES ('GR-ORD-03', 'KH Âm Nhạc', 'music@gaeru.com', '0977889900', '789 Nguyễn Huệ', 'TP.HCM', 'momo', 'completed', 29700000, 29700000, now() - interval '15 days')
       RETURNING id`
    )).rows[0];
    await pool.query(
      `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
       VALUES ($1, $2, 'Tai Nghe Bluetooth Air-5', 'Trắng Tinh Khôi', 'SKU-AIR5-OK', 990000, 30, 29700000)`,
      [o3.id, v4.id]
    );

    // Đơn 4: Đơn BỊ HỦY (Cancelled) mua 100 Bàn phím K9 -> Hệ thống PHẢI loại trừ khỏi vận tốc bán!
    const o4 = (await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES ('GR-ORD-CANCELLED', 'KH Bom Hàng', 'bom@gaeru.com', '0900000000', 'Huế', 'Huế', 'cod', 'cancelled', 150000000, 150000000, now() - interval '2 days')
       RETURNING id`
    )).rows[0];
    await pool.query(
      `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
       VALUES ($1, $2, 'Bàn Phím Cơ K9 Pro', 'Đen RGB', 'SKU-K9-OUT', 1500000, 100, 150000000)`,
      [o4.id, v1.id]
    );

    console.log('✔ Đã khởi tạo 4 sản phẩm, 4 biến thể tồn kho và 4 đơn hàng 30 ngày (bao gồm đơn hủy).');

    // --------------------------------------------------------------------------
    // KỊCH BẢN 2: CHẠY THẬT THUẬT TOÁN DỰ BÁO NHẬP HÀNG TỰ ĐỘNG (SMART ROP)
    // --------------------------------------------------------------------------
    console.log('\n--- 2. CHẠY THẬT THUẬT TOÁN DỰ BÁO NHẬP HÀNG TỰ ĐỘNG (SMART ROP) ---');
    const t0 = performance.now();
    const forecastResult = await getInventoryForecast(pool);
    const t1 = performance.now();
    const durForecastMs = t1 - t0;

    const { forecastList, summary } = forecastResult;

    console.log(`- Thời gian tính toán dự báo toàn bộ kho: ${durForecastMs.toFixed(3)} ms`);
    console.log(`- Tổng số SKU theo dõi                : ${summary.totalSkus}`);
    console.log(`- Số SKU Cấp bách / Hết hàng (Critical): ${summary.criticalCount}`);
    console.log(`- Số SKU Cần nhập thêm (Warning)      : ${summary.warningCount}`);
    console.log(`- Số SKU Tồn kho an toàn (Healthy)    : ${summary.healthyCount}`);
    console.log(`- Cảnh báo có khuyến nghị nhập hàng   : ${summary.hasReorderRecommendations ? 'CÓ (BẬT ALARM)' : 'KHÔNG'}`);

    // Kiểm tra SKU-K9-OUT (Hết hàng)
    const k9 = forecastList.find(f => f.sku === 'SKU-K9-OUT');
    assert.ok(k9);
    assert.equal(k9.currentStock, 0);
    assert.equal(k9.sold30d, 0, 'Đơn huỷ không được tính vào số lượng bán 30 ngày');
    assert.equal(k9.urgency, 'out_of_stock');
    assert.equal(k9.statusText, 'HẾT HÀNG');
    assert.ok(k9.suggestedReorderQty >= 10, 'Gợi ý nhập tối thiểu minOrderQty (10)');

    // Kiểm tra SKU-M1-CRIT (Cấp bách: tồn 2, bán 60 cái/30d -> vận tốc 2 cái/ngày -> còn 1 ngày hết hàng)
    const m1 = forecastList.find(f => f.sku === 'SKU-M1-CRIT');
    assert.ok(m1);
    assert.equal(m1.currentStock, 2);
    assert.equal(m1.sold30d, 60);
    assert.equal(m1.dailyVelocity, 2.0);
    assert.equal(m1.daysRemaining, 1);
    assert.equal(m1.urgency, 'critical');
    // ROP = ceil(2.0 * 7 lead time + 5 safety stock) = 19
    assert.equal(m1.reorderPoint, 19);
    // Gợi ý đặt hàng = Math.max(10, 19 * 2 - 2) = 36
    assert.equal(m1.suggestedReorderQty, 36);

    // Kiểm tra SKU-C100-WARN (Cần nhập: tồn 8, bán 15/30d -> vận tốc 0.5 cái/ngày)
    // ROP = ceil(0.5 * 7 + 5) = ceil(8.5) = 9. Tồn 8 <= 9 -> reorder_needed
    const c100 = forecastList.find(f => f.sku === 'SKU-C100-WARN');
    assert.ok(c100);
    assert.equal(c100.currentStock, 8);
    assert.equal(c100.dailyVelocity, 0.5);
    assert.equal(c100.reorderPoint, 9);
    assert.equal(c100.urgency, 'reorder_needed');
    // Gợi ý đặt hàng = Math.max(10, 9 * 2 - 8) = 10
    assert.equal(c100.suggestedReorderQty, 10);

    // Kiểm tra SKU-AIR5-OK (Tồn 120, bán 30/30d -> 1 cái/ngày -> còn 120 ngày -> healthy)
    const air5 = forecastList.find(f => f.sku === 'SKU-AIR5-OK');
    assert.ok(air5);
    assert.equal(air5.currentStock, 120);
    assert.equal(air5.dailyVelocity, 1.0);
    assert.equal(air5.urgency, 'healthy');
    assert.equal(air5.suggestedReorderQty, 0);

    console.log('\n--- CHI TIẾT TỪNG MÃ SKU THEO DÕI THỰC TẾ ---');
    forecastList.forEach(item => {
      console.log(`[${item.sku.padEnd(14)}] Tồn: ${String(item.currentStock).padStart(3)} | Bán 30d: ${String(item.sold30d).padStart(2)} | Vận tốc: ${item.dailyVelocity}/ngày | ROP: ${String(item.reorderPoint).padStart(2)} | Còn: ${String(item.daysRemaining).padStart(3)} ngày | Mức: ${item.urgency.padEnd(14)} | Gợi ý nhập: ${item.suggestedReorderQty}`);
    });

    // --------------------------------------------------------------------------
    // KỊCH BẢN 3: CẤU HÌNH GHI ĐÈ THỦ CÔNG (MANUAL OVERRIDE ROP)
    // --------------------------------------------------------------------------
    console.log('\n--- 3. KIỂM THỬ CẤU HÌNH THAY ĐỔI THAM SỐ & GHI ĐÈ THỦ CÔNG (MANUAL OVERRIDE) ---');
    // Đặt cấu hình ghi đè cho SKU-AIR5-OK: bình thường đang healthy (tồn 120),
    // Nhà quản lý yêu cầu ghi đè ROP lên 150 để chuẩn bị cho mùa Black Friday
    await pool.query(
      `INSERT INTO inventory_reorder_points (sku, product_name, lead_time_days, safety_stock_units, min_order_qty, manual_override_rop, updated_at)
       VALUES ('SKU-AIR5-OK', 'Tai Nghe Bluetooth Air-5', 14, 20, 50, 150, now())
       ON CONFLICT (sku) DO UPDATE SET manual_override_rop = 150`
    );

    const recheckResult = await getInventoryForecast(pool);
    const air5Overridden = recheckResult.forecastList.find(f => f.sku === 'SKU-AIR5-OK');
    assert.ok(air5Overridden);
    assert.equal(air5Overridden.reorderPoint, 150);
    assert.equal(air5Overridden.urgency, 'reorder_needed', 'Sau khi ghi đè ROP 150, tồn 120 lập tức chuyển sang Cần nhập thêm');
    assert.equal(air5Overridden.suggestedReorderQty, 180, 'Gợi ý nhập = max(50, 150*2 - 120) = 180');
    console.log(`✔ Ghi đè ROP thành công: SKU-AIR5-OK ROP chuyển thành 150 -> Trạng thái đổi thành "${air5Overridden.statusText}" -> Gợi ý nhập: ${air5Overridden.suggestedReorderQty} cái.`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 4: ROUTER QUẢN TRỊ ADMIN (GET & POST)
    // --------------------------------------------------------------------------
    console.log('\n--- 4. KIỂM THỬ ROUTER QUẢN TRỊ HỆ THỐNG (ADMIN ENDPOINTS) ---');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.admin = { id: 'admin_lead', permissions: ['inventory.read', 'inventory.write'] };
      next();
    });
    app.use(createInventoryForecastAdmin(pool));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      // 1. GET /inventory/forecast
      const getRes = await fetch(`${baseUrl}/inventory/forecast`);
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.ok(Array.isArray(getData.forecastList));
      assert.equal(getData.forecastList.length, 4);
      console.log(`✔ GET /inventory/forecast -> HTTP 200 OK (Truy xuất thành công dự báo 4 SKU)`);

      // 2. POST /inventory/reorder-settings
      const postRes = await fetch(`${baseUrl}/inventory/reorder-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: 'SKU-M1-CRIT',
          productName: 'Chuột Công Thái Học M1',
          leadTimeDays: 10,
          safetyStockUnits: 8,
          minOrderQty: 50,
          manualOverrideRop: 30
        })
      });
      assert.equal(postRes.status, 200);
      const postData = await postRes.json();
      assert.equal(postData.success, true);
      console.log(`✔ POST /inventory/reorder-settings -> HTTP 200 OK (${postData.message})`);

      // Kiểm tra lại trong CSDL
      const dbSaved = (await pool.query(`SELECT * FROM inventory_reorder_points WHERE sku = 'SKU-M1-CRIT'`)).rows[0];
      assert.equal(dbSaved.lead_time_days, 10);
      assert.equal(dbSaved.safety_stock_units, 8);
      assert.equal(dbSaved.min_order_qty, 50);
      assert.equal(dbSaved.manual_override_rop, 30);
      console.log('✔ CSDL ghi nhận chuẩn xác toàn bộ tham số ROP tùy chỉnh.');
    } finally {
      server.close();
    }

    console.log('\n' + '='.repeat(80));
    console.log('BẢNG TỔNG HỢP SỐ LIỆU ĐO ĐẠC THỰC TẾ: SMART INVENTORY FORECAST (ROP)');
    console.log('='.repeat(80));
    console.log(`- Thời gian tính toán dự báo kho : ${durForecastMs.toFixed(3)} ms`);
    console.log(`- Công thức Điểm Nhập Hàng (ROP) : (Vận tốc bán 30d x Lead Time ngày) + Tồn kho an toàn`);
    console.log(`- Phân loại mức độ cấp bách      : 4 tầng (out_of_stock, critical, reorder_needed, healthy)`);
    console.log(`- Loại trừ đơn hàng bị huỷ       : 100% chính xác (WHERE status NOT IN ('cancelled'))`);
    console.log(`- Tính toán Gợi ý số lượng nhập  : max(min_order_qty, ROP * 2 - currentStock)`);
    console.log(`- Ghi đè tham số thủ công        : Hỗ trợ linh hoạt theo từng SKU riêng biệt`);
    console.log(`- Điểm cuối Quản trị viên        : GET /inventory/forecast | POST /inventory/reorder-settings`);
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
