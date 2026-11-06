'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { createCodReturnIntake } = require('../src/cod-return-intake');

test('COD Return Intake Workflow: pending listing, barcode lookup, condition inspection, inventory restocking, and carrier claim tracking', async t => {
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

  // Áp dụng toàn bộ database migrations (bao gồm cod-return-intake.sql)
  await migrateDatabase(pool);

  // 1. Khởi tạo sản phẩm, biến thể, kho bãi và tồn kho
  const warehouse = (await pool.query(
    "INSERT INTO warehouses(code, name, address, active) VALUES('KHO-HN', 'Kho Hà Nội', '123 Cầu Giấy', true) RETURNING id, name"
  )).rows[0];

  const product = (await pool.query(
    "INSERT INTO products(slug, name, category, active) VALUES('gaeru-m3-mic', 'Micro GAERU M3', 'audio', true) RETURNING id"
  )).rows[0];

  const variant = (await pool.query(
    `INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES($1, 'GR-M3-BL', 'Đen nhám', 1500000, 10, true) RETURNING id`,
    [product.id]
  )).rows[0];

  await pool.query(
    `INSERT INTO warehouse_stock(warehouse_id, variant_id, quantity)
     VALUES($1, $2, 10) ON CONFLICT(warehouse_id, variant_id) DO UPDATE SET quantity=10`,
    [warehouse.id, variant.id]
  );

  // 2. Tạo đơn hàng COD 1: Chuyển hoàn nguyên seal (intact)
  const order1 = (await pool.query(
    `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status)
     VALUES('ORD-COD-RETURN-1', 'Nguyễn Văn A', 'a@example.com', '0912345678', '456 Phố Huế', 'Hà Nội', 'cod', 1500000, 1500000, 'shipped', 'pending')
     RETURNING id`
  )).rows[0];

  await pool.query(
    `INSERT INTO order_items(order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES($1, $2, 'Micro GAERU M3', 'Đen nhám', 'GR-M3-BL', 1500000, 1, 1500000)`,
    [order1.id, variant.id]
  );

  await pool.query(
    `INSERT INTO order_stock_allocations(order_id, variant_id, warehouse_id, quantity)
     VALUES($1, $2, $3, 1)`,
    [order1.id, variant.id, warehouse.id]
  );

  // Cập nhật tồn kho trừ 1 khi xuất hàng (còn 9)
  await pool.query('UPDATE product_variants SET stock_quantity = 9 WHERE id = $1', [variant.id]);
  await pool.query('UPDATE warehouse_stock SET quantity = 9 WHERE warehouse_id = $1 AND variant_id = $2', [warehouse.id, variant.id]);

  const shipment1 = (await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, carrier_status_raw, cod_amount_vnd)
     VALUES($1, 'viettel', 'VT-RET-001', 'returned', 'Delivery Failed - Returning to sender', 1500000)
     RETURNING id`,
    [order1.id]
  )).rows[0];

  // 3. Tạo đơn hàng COD 2: Chuyển hoàn bị vỡ hộp/hỏng thiết bị (damaged)
  const order2 = (await pool.query(
    `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status)
     VALUES('ORD-COD-RETURN-2', 'Trần Thị B', 'b@example.com', '0987654321', '789 Lê Lợi', 'Đà Nẵng', 'cod', 1500000, 1500000, 'shipped', 'pending')
     RETURNING id`
  )).rows[0];

  await pool.query(
    `INSERT INTO order_items(order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES($1, $2, 'Micro GAERU M3', 'Đen nhám', 'GR-M3-BL', 1500000, 1, 1500000)`,
    [order2.id, variant.id]
  );

  await pool.query(
    `INSERT INTO order_stock_allocations(order_id, variant_id, warehouse_id, quantity)
     VALUES($1, $2, $3, 1)`,
    [order2.id, variant.id, warehouse.id]
  );

  await pool.query('UPDATE product_variants SET stock_quantity = 8 WHERE id = $1', [variant.id]);
  await pool.query('UPDATE warehouse_stock SET quantity = 8 WHERE warehouse_id = $1 AND variant_id = $2', [warehouse.id, variant.id]);

  const shipment2 = (await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, carrier_status_raw, cod_amount_vnd)
     VALUES($1, 'jt', 'JT-DAMAGED-002', 'returned', 'Return completed - Broken box', 1500000)
     RETURNING id`,
    [order2.id]
  )).rows[0];

  // Khởi tạo Express Test App
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { csrfToken: 'test-csrf-token' };
    req.admin = {
      username: 'warehouse_tester',
      permissions: req.headers['x-no-perm'] ? [] : ['orders.read', 'orders.write', 'inventory.read', 'inventory.write']
    };
    next();
  });
  app.use('/api/gaeru_ceo', createCodReturnIntake(pool));
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/gaeru_ceo`;

  // --- TEST CASE 1: Lấy danh sách bưu phẩm chuyển hoàn chờ kiểm nhận ---
  const pendingRes = await fetch(`${base}/cod-returns/pending`);
  assert.equal(pendingRes.status, 200);
  const pendingData = await pendingRes.json();
  assert.equal(pendingData.total, 2);
  assert.equal(pendingData.pendingReturns.length, 2);
  assert.ok(pendingData.pendingReturns.some(r => r.trackingNumber === 'VT-RET-001'));
  assert.ok(pendingData.pendingReturns.some(r => r.trackingNumber === 'JT-DAMAGED-002'));

  // --- TEST CASE 2: Tra cứu nhanh bằng Barcode scanner (/lookup) ---
  const lookupRes = await fetch(`${base}/cod-returns/lookup?q=VT-RET-001`);
  assert.equal(lookupRes.status, 200);
  const lookupData = await lookupRes.json();
  assert.equal(lookupData.shipment.trackingNumber, 'VT-RET-001');
  assert.equal(lookupData.shipment.orderNumber, 'ORD-COD-RETURN-1');
  assert.equal(lookupData.intakeStatus, 'pending');
  assert.equal(lookupData.shipment.items.length, 1);

  // Tra cứu theo mã đơn hàng ORD-COD-RETURN-2
  const lookupOrderRes = await fetch(`${base}/cod-returns/lookup?q=ORD-COD-RETURN-2`);
  assert.equal(lookupOrderRes.status, 200);
  const lookupOrderData = await lookupOrderRes.json();
  assert.equal(lookupOrderData.shipment.trackingNumber, 'JT-DAMAGED-002');

  // Tra cứu mã không tồn tại -> 404
  const notFoundRes = await fetch(`${base}/cod-returns/lookup?q=NON-EXISTENT`);
  assert.equal(notFoundRes.status, 404);

  // --- TEST CASE 3: Kiểm nhận kiện hàng 1 NGUYÊN SEAL (intact) -> Tái nhập kho khả dụng ---
  const intakeRes1 = await fetch(`${base}/cod-returns/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
    body: JSON.stringify({
      trackingNumber: 'VT-RET-001',
      packageCondition: 'intact',
      inspectionNotes: 'Hộp nguyên seal, phụ kiện đầy đủ, đủ chuẩn bán mới'
    })
  });
  assert.equal(intakeRes1.status, 200);
  const intakeData1 = await intakeRes1.json();
  assert.equal(intakeData1.packageCondition, 'intact');
  assert.equal(intakeData1.restocked, true);
  assert.equal(intakeData1.claimedDamage, false);

  // Xác minh đơn hàng 1 đã chuyển sang cancelled
  const orderCheck1 = (await pool.query('SELECT status, cancellation_reason FROM orders WHERE id = $1', [order1.id])).rows[0];
  assert.equal(orderCheck1.status, 'cancelled');
  assert.ok(orderCheck1.cancellation_reason.includes('Nguyên vẹn'));

  // Xác minh tồn kho đã được hoàn lại (+1: từ 8 lên 9 cho variant này)
  const variantCheck1 = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0];
  assert.equal(variantCheck1.stock_quantity, 9);

  // --- TEST CASE 4: Ngăn chặn kiểm nhận trùng lặp cho cùng một vận đơn (Idempotency -> 409) ---
  const duplicateRes = await fetch(`${base}/cod-returns/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
    body: JSON.stringify({
      trackingNumber: 'VT-RET-001',
      packageCondition: 'intact'
    })
  });
  assert.equal(duplicateRes.status, 409);
  const duplicateErr = await duplicateRes.json();
  assert.ok(duplicateErr.error.includes('trước đó'));

  // --- TEST CASE 5: Kiểm nhận kiện hàng 2 HƯ HỎNG (damaged) -> KHÔNG nhập kho bán, lập hồ sơ khiếu nại ---
  const intakeRes2 = await fetch(`${base}/cod-returns/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
    body: JSON.stringify({
      trackingNumber: 'JT-DAMAGED-002',
      packageCondition: 'damaged',
      carrierFault: true,
      inspectionNotes: 'Hộp móp méo nặng, gãy chân thu âm micro do vận chuyển cẩu thả',
      evidenceUrls: ['https://example.com/photos/box-broken.jpg']
    })
  });
  assert.equal(intakeRes2.status, 200);
  const intakeData2 = await intakeRes2.json();
  assert.equal(intakeData2.packageCondition, 'damaged');
  assert.equal(intakeData2.restocked, false);
  assert.equal(intakeData2.claimedDamage, true);

  // Tồn kho bán hàng KHÔNG ĐƯỢC TĂNG (vẫn giữ nguyên 9, không đưa hàng hỏng vào bán lại)
  const variantCheck2 = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0];
  assert.equal(variantCheck2.stock_quantity, 9);

  // Đơn 2 đã huỷ với lý do hư hỏng / khiếu nại
  const orderCheck2 = (await pool.query('SELECT status, cancellation_reason FROM orders WHERE id = $1', [order2.id])).rows[0];
  assert.equal(orderCheck2.status, 'cancelled');
  assert.ok(orderCheck2.cancellation_reason.toLowerCase().includes('hư hỏng'));

  // --- TEST CASE 6: Danh sách chờ kiểm nhận giờ đây phải = 0 ---
  const pendingAfterRes = await fetch(`${base}/cod-returns/pending`);
  const pendingAfterData = await pendingAfterRes.json();
  assert.equal(pendingAfterData.total, 0);

  // --- TEST CASE 7: Xem lịch sử kiểm nhận (/history) ---
  const historyRes = await fetch(`${base}/cod-returns/history`);
  assert.equal(historyRes.status, 200);
  const historyData = await historyRes.json();
  assert.equal(historyData.total, 2);

  // Lọc lịch sử theo condition=intact
  const intactHistory = await (await fetch(`${base}/cod-returns/history?condition=intact`)).json();
  assert.equal(intactHistory.total, 1);
  assert.equal(intactHistory.history[0].trackingNumber, 'VT-RET-001');

  // Lọc lịch sử theo condition=damaged
  const damagedHistory = await (await fetch(`${base}/cod-returns/history?condition=damaged`)).json();
  assert.equal(damagedHistory.total, 1);
  assert.equal(damagedHistory.history[0].trackingNumber, 'JT-DAMAGED-002');

  // --- TEST CASE 8: Danh sách hồ sơ khiếu nại hãng vận chuyển (/claims) ---
  const claimsRes = await fetch(`${base}/cod-returns/claims`);
  assert.equal(claimsRes.status, 200);
  const claimsData = await claimsRes.json();
  assert.equal(claimsData.totalClaims, 1);
  assert.equal(claimsData.claims[0].trackingNumber, 'JT-DAMAGED-002');
  assert.equal(claimsData.claims[0].carrierId, 'jt');
  assert.equal(claimsData.claims[0].claimAmountVnd, 1500000);
  assert.equal(claimsData.claims[0].carrierFault, true);

  // --- TEST CASE 9: Quyền truy cập - Không có quyền thì từ chối (403) ---
  const noPermRes = await fetch(`${base}/cod-returns/pending`, {
    headers: { 'X-No-Perm': '1' }
  });
  assert.equal(noPermRes.status, 403);

  // --- TEST CASE 10 (GAERU-02): Chặn kiểm nhận đơn trả trước VNPAY qua luồng COD (400) ---
  const order3 = (await pool.query(
    `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status)
     VALUES('ORD-PREPAID-3', 'Lê Văn C', 'c@example.com', '0933333333', '12 Nguyễn Trãi', 'Hà Nội', 'vnpay', 1500000, 1500000, 'shipped', 'paid')
     RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, carrier_status_raw, cod_amount_vnd)
     VALUES($1, 'viettel', 'VNPAY-SHIP-003', 'returned', 'Delivery Failed - Return', 0)`,
    [order3.id]
  );
  const prepaidRes = await fetch(`${base}/cod-returns/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
    body: JSON.stringify({ trackingNumber: 'VNPAY-SHIP-003', packageCondition: 'intact' })
  });
  assert.equal(prepaidRes.status, 400);
  const prepaidErr = await prepaidRes.json();
  assert.ok(prepaidErr.error.includes('VNPAY'), 'Phải thông báo rõ không phải đơn COD');

  // Đơn hàng VNPAY không bị hủy ngoài ý muốn
  const checkOrder3 = (await pool.query('SELECT status FROM orders WHERE id = $1', [order3.id])).rows[0];
  assert.equal(checkOrder3.status, 'shipped');

  // --- TEST CASE 11 (GAERU-02): Chặn đơn COD đã thanh toán/đối soát (409) ---
  const order4 = (await pool.query(
    `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status)
     VALUES('ORD-PAID-COD-4', 'Phạm Văn D', 'd@example.com', '0944444444', '88 Cầu Giấy', 'Hà Nội', 'cod', 1500000, 1500000, 'shipped', 'paid')
     RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, carrier_status_raw, cod_amount_vnd)
     VALUES($1, 'viettel', 'COD-PAID-004', 'returned', 'Return completed', 1500000)`,
    [order4.id]
  );
  const paidCodRes = await fetch(`${base}/cod-returns/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
    body: JSON.stringify({ trackingNumber: 'COD-PAID-004', packageCondition: 'intact' })
  });
  assert.equal(paidCodRes.status, 409);
  const paidCodErr = await paidCodRes.json();
  assert.ok(paidCodErr.error.includes('thanh toán/đối soát'), 'Phải yêu cầu đối soát kế toán trước');

  // --- TEST CASE 12 (GAERU-02): Chặn kiện hàng đang đi giao / chưa có xác nhận hoàn từ bưu cục (400) ---
  const order5 = (await pool.query(
    `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status)
     VALUES('ORD-DELIVERING-5', 'Hoàng Văn E', 'e@example.com', '0955555555', '99 Hai Bà Trưng', 'Hà Nội', 'cod', 1500000, 1500000, 'shipped', 'pending')
     RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, carrier_status_raw, cod_amount_vnd)
     VALUES($1, 'viettel', 'COD-DELIVERING-005', 'delivering', 'Shipper is delivering package to customer', 1500000)`,
    [order5.id]
  );
  const deliveringRes = await fetch(`${base}/cod-returns/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
    body: JSON.stringify({ trackingNumber: 'COD-DELIVERING-005', packageCondition: 'intact' })
  });
  assert.equal(deliveringRes.status, 400);
  const deliveringErr = await deliveringRes.json();
  assert.ok(deliveringErr.error.includes('delivering') || deliveringErr.error.includes('chuyển hoàn'), 'Phải chặn kiện hàng đang đi giao');

  // --- TEST CASE 13 (GAERU-03): Chặn kiểm nhận nếu kho tiếp nhận khác kho xuất ban đầu (400) ---
  const warehouseHCM = (await pool.query(
    "INSERT INTO warehouses(code, name, address, active) VALUES('KHO-HCM', 'Kho Hồ Chí Minh', '456 Quận 1', true) RETURNING id"
  )).rows[0];
  const order6 = (await pool.query(
    `INSERT INTO orders(order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status)
     VALUES('ORD-DIFF-WH-6', 'Đỗ Văn F', 'f@example.com', '0966666666', '101 Kim Mã', 'Hà Nội', 'cod', 1500000, 1500000, 'shipped', 'pending')
     RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO order_stock_allocations(order_id, variant_id, warehouse_id, quantity)
     VALUES($1, $2, $3, 1)`,
    [order6.id, variant.id, warehouse.id]
  );
  await pool.query(
    `INSERT INTO carrier_shipments(order_id, carrier_id, tracking_number, status, carrier_status_raw, cod_amount_vnd)
     VALUES($1, 'viettel', 'COD-DIFF-WH-006', 'returned', 'Returning to sender', 1500000)`,
    [order6.id]
  );
  const diffWhRes = await fetch(`${base}/cod-returns/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
    body: JSON.stringify({ trackingNumber: 'COD-DIFF-WH-006', packageCondition: 'intact', warehouseId: warehouseHCM.id })
  });
  assert.equal(diffWhRes.status, 400);
  const diffWhErr = await diffWhRes.json();
  assert.ok(diffWhErr.error.includes('khác kho xuất'), 'Phải cảnh báo sai lệch kho tiếp nhận');

  // --- TEST CASE 14 (GAERU-11): Validate dữ liệu không hợp lệ trả về 400 Bad Request (không bị lỗi 500 TypeError) ---
  const invalidRes = await fetch(`${base}/cod-returns/intake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'test-csrf-token' },
    body: JSON.stringify({ trackingNumber: '', packageCondition: 'not_valid_condition' })
  });
  assert.equal(invalidRes.status, 400);
  const invalidData = await invalidRes.json();
  assert.ok(invalidData.error, 'Phải có thông báo lỗi rõ ràng');
});
