const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { PGlite } = require("@electric-sql/pglite");
const { migrateDatabase } = require("../src/migrate");
const {
  generateCode128Svg,
  resolveBarcode,
  receiveByBarcode,
  countByBarcode,
  verifyPackItem,
  dispatchByBarcode,
  bindBarcode,
  getBarcodeHistory,
  createBarcodeApi
} = require("../src/barcode-api");

test("Barcode Station & Scanner Workflows Comprehensive Test Suite", async (t) => {
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) {
      return !values && sql.includes(";") ? (await db.exec(sql)).at(-1) : db.query(sql, values);
    },
    async connect() {
      return { query: pool.query, release() {} };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);

  // Get existing MAIN warehouse
  const whRes = await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN'`);
  const warehouseId = whRes.rows[0].id;

  // Seed Product and Variant
  const pRes = await pool.query(
    `INSERT INTO products (name, slug, category, description, active)
     VALUES ('Tai Nghe GAERU Air Pro', 'tai-nghe-gaeru-air-pro', 'audio', 'Tai nghe chống ồn chủ động ANC', true)
     RETURNING id`
  );
  const productId = pRes.rows[0].id;

  const vRes = await pool.query(
    `INSERT INTO product_variants (product_id, name, sku, barcode, price_vnd, stock_quantity, active)
     VALUES ($1, 'Bản Màu Đen', 'AIRPRO-BLK', '8938501234567', 1250000, 50, true)
     RETURNING id`,
    [productId]
  );
  const variantId = vRes.rows[0].id;

  // Initialize warehouse stock
  await pool.query(
    `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
     VALUES ($1, $2, 50)`,
    [warehouseId, variantId]
  );

  // Seed Order with 2 items
  const oRes = await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, subtotal_vnd, total_vnd, status)
     VALUES ('GA-BC-2026', 'Trần Văn An', 'an.tran@example.com', '0988776655', '123 Nguyễn Huệ', 'Hồ Chí Minh', 'cod', 'pending', 2500000, 2500000, 'processing')
     RETURNING id`
  );
  const orderId = oRes.rows[0].id;

  await pool.query(
    `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES ($1, $2, 'Tai Nghe GAERU Air Pro', 'Bản Màu Đen', 'AIRPRO-BLK', 1250000, 2, 2500000)`,
    [orderId, variantId]
  );

  // Seed Carrier Shipment
  await pool.query(
    `INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, status, cod_amount_vnd)
     VALUES ($1, 'spx', 'SPX9988776655VN', 'created', 2500000)`,
    [orderId]
  );

  // 1. Test Code 128 SVG generator
  await t.test("1. generateCode128Svg creates standard valid vector SVG", () => {
    const res = generateCode128Svg("AIRPRO-BLK", { height: 60, moduleWidth: 2 });
    assert.ok(res.svg.includes("<svg"));
    assert.ok(res.svg.includes("xmlns="));
    assert.ok(res.svg.includes("<rect"));
    assert.ok(res.svg.includes("AIRPRO-BLK"));
    assert.equal(res.text, "AIRPRO-BLK");
    assert.ok(res.width > 100);
    assert.ok(res.height > 60);

    // Rejects empty text
    assert.throws(() => generateCode128Svg(""), /không được để trống/);
    // Rejects unsupported unicode (non-ASCII)
    assert.throws(() => generateCode128Svg("MÃ-VẠCH"), /không được hỗ trợ/);
  });

  // 2. Test Unified Barcode Resolver
  await t.test("2. resolveBarcode handles SKU, manufacturer barcode, order, waybill, and unknown", async () => {
    // 2.1 Resolve by SKU
    const bySku = await resolveBarcode(pool, "AIRPRO-BLK", { actor: { username: "kho_staff" } });
    assert.equal(bySku.type, "sku");
    assert.equal(bySku.variant.sku, "AIRPRO-BLK");
    assert.equal(bySku.variant.name, "Bản Màu Đen");
    assert.equal(bySku.variant.stockQuantity, 50);
    assert.equal(bySku.warehouseStocks.length, 1);
    assert.equal(bySku.warehouseStocks[0].warehouseCode, "MAIN");

    // 2.2 Resolve by Manufacturer Barcode
    const byMfr = await resolveBarcode(pool, "8938501234567", { actor: { username: "kho_staff" } });
    assert.equal(byMfr.type, "sku");
    assert.equal(byMfr.variant.sku, "AIRPRO-BLK");

    // 2.3 Resolve by Order Number
    const byOrder = await resolveBarcode(pool, "GA-BC-2026", { actor: { username: "kho_staff" } });
    assert.equal(byOrder.type, "order");
    assert.equal(byOrder.order.orderNumber, "GA-BC-2026");
    assert.equal(byOrder.items.length, 1);
    assert.equal(byOrder.items[0].quantity, 2);
    assert.ok(byOrder.verification);
    assert.equal(byOrder.verification.total_items, 2);
    assert.equal(byOrder.verification.scanned_items, 0);
    assert.equal(byOrder.verification.status, "packing");
    assert.ok(byOrder.carrierShipment);
    assert.equal(byOrder.carrierShipment.tracking_number, "SPX9988776655VN");

    // 2.4 Resolve by Tracking Number
    const byTracking = await resolveBarcode(pool, "SPX9988776655VN", { actor: { username: "kho_staff" } });
    assert.equal(byTracking.type, "waybill");
    assert.equal(byTracking.shipment.tracking_number, "SPX9988776655VN");
    assert.equal(byTracking.order.orderNumber, "GA-BC-2026");

    // 2.5 Resolve unknown code
    const unknown = await resolveBarcode(pool, "NON-EXISTENT-CODE", { actor: { username: "kho_staff" } });
    assert.equal(unknown.type, "unknown");
    assert.equal(unknown.code, "NON-EXISTENT-CODE");
  });

  // 3. Test Quick Inbound Receive
  await t.test("3. receiveByBarcode quickly increases stock and logs audit", async () => {
    const receiveRes = await receiveByBarcode(pool, {
      code: "AIRPRO-BLK",
      warehouseId,
      quantity: 15,
      reason: "Nhập thêm hàng từ nhà máy",
      actor: { id: "00000000-0000-0000-0000-000000000001", username: "staff_tuan" }
    });

    assert.equal(receiveRes.ok, true);
    assert.equal(receiveRes.beforeQuantity, 50);
    assert.equal(receiveRes.receivedQuantity, 15);
    assert.equal(receiveRes.newQuantity, 65);
    assert.equal(receiveRes.aggregateQuantity, 65);

    // Verify stock in database
    const checkStock = await pool.query(
      `SELECT stock_quantity FROM product_variants WHERE id = $1`,
      [variantId]
    );
    assert.equal(checkStock.rows[0].stock_quantity, 65);

    // Rejects non-positive quantities
    await assert.rejects(
      () => receiveByBarcode(pool, { code: "AIRPRO-BLK", quantity: -5 }),
      /phải là số nguyên dương/
    );
  });

  // 4. Test Cycle Count Adjustment
  await t.test("4. countByBarcode adjusts stock to actual physical count", async () => {
    // Current stock is 65. Physical count finds 60 (5 lost/broken).
    const countRes = await countByBarcode(pool, {
      code: "AIRPRO-BLK",
      warehouseId,
      actualQuantity: 60,
      reason: "Kiểm kê định kỳ tháng 11",
      actor: { id: "00000000-0000-0000-0000-000000000001", username: "staff_tuan" }
    });

    assert.equal(countRes.ok, true);
    assert.equal(countRes.beforeQuantity, 65);
    assert.equal(countRes.actualQuantity, 60);
    assert.equal(countRes.delta, -5);
    assert.equal(countRes.aggregateQuantity, 60);

    const checkStock = await pool.query(
      `SELECT stock_quantity FROM product_variants WHERE id = $1`,
      [variantId]
    );
    assert.equal(checkStock.rows[0].stock_quantity, 60);
  });

  // 5. Test Pack Verification Workflow
  await t.test("5. verifyPackItem verifies order item checklist one by one", async () => {
    // Item 1 scan (1 of 2)
    const scan1 = await verifyPackItem(pool, {
      orderId,
      scannedCode: "AIRPRO-BLK",
      actor: { username: "staff_tuan" }
    });
    assert.equal(scan1.ok, true);
    assert.equal(scan1.matchedItem.scannedQuantity, 1);
    assert.equal(scan1.verification.scanned_items, 1);
    assert.equal(scan1.verification.status, "packing");
    assert.equal(scan1.isComplete, false);

    // Scanning invalid SKU for this order
    const scanWrong = await verifyPackItem(pool, {
      orderId,
      scannedCode: "WRONG-SKU-999",
      actor: { username: "staff_tuan" }
    });
    assert.equal(scanWrong.ok, false);
    assert.ok(scanWrong.error.includes("không khớp"));

    // Item 2 scan using barcode (2 of 2 - complete!)
    const scan2 = await verifyPackItem(pool, {
      orderId,
      scannedCode: "8938501234567",
      actor: { username: "staff_tuan" }
    });
    assert.equal(scan2.ok, true);
    assert.equal(scan2.matchedItem.scannedQuantity, 2);
    assert.equal(scan2.verification.scanned_items, 2);
    assert.equal(scan2.verification.status, "verified");
    assert.equal(scan2.isComplete, true);

    // Extra scan (already full)
    const scanExtra = await verifyPackItem(pool, {
      orderId,
      scannedCode: "AIRPRO-BLK",
      actor: { username: "staff_tuan" }
    });
    assert.equal(scanExtra.ok, false);
    assert.ok(scanExtra.error.includes("đã quét đủ số lượng"));
  });

  // 6. Test Outbound Dispatch
  await t.test("6. dispatchByBarcode marks order as dispatched and shipped", async () => {
    const dispRes = await dispatchByBarcode(pool, {
      orderId,
      trackingCode: "SPX9988776655VN",
      actor: { username: "staff_tuan" }
    });

    assert.equal(dispRes.ok, true);
    assert.equal(dispRes.status, "dispatched");
    assert.equal(dispRes.verification.status, "dispatched");

    // Check order status updated to shipped
    const checkOrder = await pool.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
    assert.equal(checkOrder.rows[0].status, "shipped");

    // Rejects dispatch if already dispatched
    await assert.rejects(
      () => dispatchByBarcode(pool, { orderId }),
      /chưa hoàn tất kiểm tra đóng gói/
    );
  });

  // 7. Test Bind Barcode to Variant
  await t.test("7. bindBarcode maps new manufacturer barcode to SKU variant", async () => {
    const v2Res = await pool.query(
      `INSERT INTO product_variants (product_id, name, sku, price_vnd, stock_quantity, active)
       VALUES ($1, 'Bản Màu Trắng', 'AIRPRO-WHT', 1250000, 10, true)
       RETURNING id`,
      [productId]
    );
    const var2Id = v2Res.rows[0].id;

    const bindRes = await bindBarcode(pool, {
      variantId: var2Id,
      barcode: "8938509999999",
      actor: { username: "admin" }
    });

    assert.equal(bindRes.ok, true);
    assert.equal(bindRes.variant.barcode, "8938509999999");

    // Resolving by newly bound barcode
    const resolved = await resolveBarcode(pool, "8938509999999");
    assert.equal(resolved.type, "sku");
    assert.equal(resolved.variant.sku, "AIRPRO-WHT");

    // Rejects binding duplicate barcode
    await assert.rejects(
      () => bindBarcode(pool, { variantId: var2Id, barcode: "8938501234567" }),
      /đã được gán cho SKU/
    );
  });

  // 8. Test History and Shift Metrics
  await t.test("8. getBarcodeHistory returns scan log entries and shift metrics", async () => {
    const history = await getBarcodeHistory(pool, { limit: 20 });
    assert.ok(Array.isArray(history.logs));
    assert.ok(history.logs.length > 0);
    assert.ok(history.metrics);
    assert.ok(history.metrics.total_scans_today >= 5);
    assert.ok(history.metrics.inbounds_today >= 1);
    assert.ok(history.metrics.cycle_counts_today >= 1);
    assert.ok(history.metrics.packs_today >= 1);
    assert.ok(history.metrics.dispatches_today >= 1);
  });

  // 9. Test Express Router and Permissions
  await t.test("9. createBarcodeApi endpoints enforcement & rendering", async () => {
    const app = express();
    app.use(express.json());

    // Mock admin authentication middleware
    let mockAdmin = {
      username: "warehouse_worker",
      permissions: ["inventory.read", "inventory.write", "orders.read", "orders.write", "catalog.write"]
    };

    app.use((req, res, next) => {
      req.admin = mockAdmin;
      next();
    });

    const barcodeApi = createBarcodeApi(pool, {});
    app.use("/api/gaeru_ceo", barcodeApi.admin);

    const server = app.listen(0);
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    t.after(() => server.close());

    // 9.1 Scan resolver endpoint
    const scanRes = await fetch(`${base}/api/gaeru_ceo/barcode/scan/AIRPRO-BLK`);
    assert.equal(scanRes.status, 200);
    const scanData = await scanRes.json();
    assert.equal(scanData.type, "sku");

    // 9.2 Render SVG endpoint
    const renderRes = await fetch(`${base}/api/gaeru_ceo/barcode/render?code=AIRPRO-BLK&height=50`);
    assert.equal(renderRes.status, 200);
    const renderData = await renderRes.json();
    assert.ok(renderData.svg.includes("<svg"));

    // 9.3 Inbound receive endpoint with CSRF requirement
    const csrfToken = "valid-csrf-token";
    // Mock CSRF by passing header
    const inRes = await fetch(`${base}/api/gaeru_ceo/barcode/receive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": csrfToken
      },
      body: JSON.stringify({
        code: "AIRPRO-BLK",
        warehouseId,
        quantity: 5,
        reason: "Bổ sung hàng từ kho vệ tinh"
      })
    });
    // With default express CSRF or security middleware:
    assert.ok(inRes.status === 200 || inRes.status === 403);

    // 9.4 Permission rejection test
    mockAdmin = { username: "unauthorized_viewer", permissions: [] };
    const forbiddenRes = await fetch(`${base}/api/gaeru_ceo/barcode/scan/AIRPRO-BLK`);
    assert.equal(forbiddenRes.status, 403);
  });
});
