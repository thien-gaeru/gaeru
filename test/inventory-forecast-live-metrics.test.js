'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDb } = require('./helpers/pglite-db');
const {
  getInventoryForecast,
  createInventoryForecastAdmin
} = require('../src/inventory-forecast');

test('Inventory Forecast (Smart ROP): 30-day velocity, ROP calculation, Urgency classification, Manual override, and Admin endpoints', async (t) => {
  const { db, pool } = await createTestDb({ migrate: true });

  t.after(async () => {
    await pool.end().catch(() => {});
  });

  // Setup seed products
  const p1 = (await pool.query(
    `INSERT INTO products (name, slug, category, active)
     VALUES ('Bàn Phím Cơ K9 Pro', 'ban-phim-co-k9-pro', 'accessory', true) RETURNING id`
  )).rows[0];

  const p2 = (await pool.query(
    `INSERT INTO products (name, slug, category, active)
     VALUES ('Chuột Gaming M1', 'chuot-gaming-m1', 'accessory', true) RETURNING id`
  )).rows[0];

  const p3 = (await pool.query(
    `INSERT INTO products (name, slug, category, active)
     VALUES ('Tai Nghe Air-5', 'tai-nghe-air-5', 'audio', true) RETURNING id`
  )).rows[0];

  const v1 = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-K9-01', 'RGB Đen', 1500000, 0, true) RETURNING id`,
    [p1.id]
  )).rows[0];

  const v2 = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-M1-02', 'Đen Nhám', 750000, 3, true) RETURNING id`,
    [p2.id]
  )).rows[0];

  const v3 = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-AIR5-03', 'Trắng', 990000, 80, true) RETURNING id`,
    [p3.id]
  )).rows[0];

  await t.test('1. Sales velocity: accurately aggregates 30-day sales and filters out cancelled orders', async () => {
    // Valid order: 30 items
    const oValid = (await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES ('GR-TEST-01', 'KH Test', 'test@gaeru.com', '0912345678', 'Hà Nội', 'Hà Nội', 'cod', 'completed', 22500000, 22500000, now() - interval '3 days')
       RETURNING id`
    )).rows[0];
    await pool.query(
      `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
       VALUES ($1, $2, 'Chuột Gaming M1', 'Đen Nhám', 'SKU-M1-02', 750000, 30, 22500000)`,
      [oValid.id, v2.id]
    );

    // Cancelled order: 100 items (must be excluded)
    const oCancel = (await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES ('GR-TEST-CANCEL', 'KH Huỷ', 'cancel@gaeru.com', '0900000000', 'Hà Nội', 'Hà Nội', 'cod', 'cancelled', 75000000, 75000000, now() - interval '1 days')
       RETURNING id`
    )).rows[0];
    await pool.query(
      `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
       VALUES ($1, $2, 'Chuột Gaming M1', 'Đen Nhám', 'SKU-M1-02', 750000, 100, 75000000)`,
      [oCancel.id, v2.id]
    );

    const res = await getInventoryForecast(pool);
    const m1 = res.forecastList.find(f => f.sku === 'SKU-M1-02');
    assert.ok(m1);
    assert.equal(m1.sold30d, 30);
    assert.equal(m1.dailyVelocity, 1.0);
  });

  await t.test('2. Urgency classification: flags out_of_stock, critical, and healthy statuses correctly', async () => {
    const res = await getInventoryForecast(pool);

    // K9: stock = 0 -> out_of_stock
    const k9 = res.forecastList.find(f => f.sku === 'SKU-K9-01');
    assert.equal(k9.currentStock, 0);
    assert.equal(k9.urgency, 'out_of_stock');
    assert.equal(k9.statusText, 'HẾT HÀNG');

    // M1: stock = 3, velocity = 1.0/day -> daysRemaining = 3 -> critical
    const m1 = res.forecastList.find(f => f.sku === 'SKU-M1-02');
    assert.equal(m1.currentStock, 3);
    assert.equal(m1.daysRemaining, 3);
    assert.equal(m1.urgency, 'critical');
    assert.equal(m1.statusText, 'Cấp bách (Hết trong 1-3 ngày)');

    // AIR5: stock = 80, velocity = 0 -> healthy
    const air5 = res.forecastList.find(f => f.sku === 'SKU-AIR5-03');
    assert.equal(air5.currentStock, 80);
    assert.equal(air5.urgency, 'healthy');
    assert.equal(air5.suggestedReorderQty, 0);

    // Summary counts
    assert.equal(res.summary.totalSkus, 3);
    assert.equal(res.summary.criticalCount, 2); // K9 out of stock + M1 critical
    assert.equal(res.summary.healthyCount, 1); // AIR5
    assert.equal(res.summary.hasReorderRecommendations, true);
  });

  await t.test('3. Manual Override ROP: custom reorder point overrides formula and updates recommendation', async () => {
    // Override AIR5 ROP to 100 (while stock is 80)
    await pool.query(
      `INSERT INTO inventory_reorder_points (sku, product_name, lead_time_days, safety_stock_units, min_order_qty, manual_override_rop)
       VALUES ('SKU-AIR5-03', 'Tai Nghe Air-5', 7, 5, 20, 100)`
    );

    const res = await getInventoryForecast(pool);
    const air5 = res.forecastList.find(f => f.sku === 'SKU-AIR5-03');
    assert.equal(air5.reorderPoint, 100);
    assert.equal(air5.urgency, 'reorder_needed');
    // suggestedReorderQty = Math.max(20, 100 * 2 - 80) = 120
    assert.equal(air5.suggestedReorderQty, 120);
  });

  await t.test('4. Admin Router: GET /inventory/forecast and POST /inventory/reorder-settings', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.admin = { id: 'admin_1', permissions: ['inventory.read', 'inventory.write'] };
      next();
    });
    app.use(createInventoryForecastAdmin(pool));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const port = server.address().port;

    try {
      // 1. GET /inventory/forecast
      const getRes = await fetch(`http://127.0.0.1:${port}/inventory/forecast`);
      assert.equal(getRes.status, 200);
      const data = await getRes.json();
      assert.ok(data.summary);
      assert.ok(Array.isArray(data.forecastList));

      // 2. POST /inventory/reorder-settings with valid body
      const postRes = await fetch(`http://127.0.0.1:${port}/inventory/reorder-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: 'SKU-K9-01',
          productName: 'Bàn Phím Cơ K9 Pro',
          leadTimeDays: 14,
          safetyStockUnits: 10,
          minOrderQty: 30,
          manualOverrideRop: 25
        })
      });
      assert.equal(postRes.status, 200);
      const postJson = await postRes.json();
      assert.equal(postJson.success, true);

      // Verify DB update
      const dbRow = (await pool.query(`SELECT * FROM inventory_reorder_points WHERE sku = 'SKU-K9-01'`)).rows[0];
      assert.equal(dbRow.lead_time_days, 14);
      assert.equal(dbRow.manual_override_rop, 25);

      // 3. POST /inventory/reorder-settings without SKU returns 400
      const badRes = await fetch(`http://127.0.0.1:${port}/inventory/reorder-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(badRes.status, 400);
    } finally {
      server.close();
    }
  });
});
