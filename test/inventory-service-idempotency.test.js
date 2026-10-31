'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDb } = require('./helpers/pglite-db');
const { withTransaction } = require('../src/db');
const { InventoryService } = require('../src/domain/inventory/inventory-service');
const inventory = require('../src/inventory');

/**
 * Bộ mô phỏng truy vấn SQL tối giản tái hiện chính xác kịch bản kiểm toán P0:
 * kể cả khi bỏ qua SELECT kiểm tra sớm để ép đi tới nhánh INSERT ... ON CONFLICT DO NOTHING,
 * service lõi vẫn phải chặn cập nhật warehouse_stock / product_variants khi ON CONFLICT xảy ra.
 */
function createQuerySimulator({ initialStock = 5, skipSelectPrecheck = false } = {}) {
  const mainWarehouseId = '11111111-1111-4111-8111-111111111111';
  const variantId = '22222222-2222-4222-8222-222222222222';
  const state = {
    variantStock: initialStock,
    warehouseStock: new Map([[mainWarehouseId, initialStock]]),
    movements: new Map() // eventKey -> row
  };

  const client = {
    async query(sql, params = []) {
      const norm = sql.replace(/\s+/g, ' ').trim();

      if (norm.startsWith('SELECT v.id, v.sku')) {
        return {
          rows: [{
            id: variantId,
            sku: 'SKU-SIM-01',
            variantName: 'Bản Chuẩn',
            productName: 'GAERU Sim Mic',
            stockQuantity: state.variantStock
          }]
        };
      }

      if (norm.startsWith('SELECT id, warehouse_id AS "warehouseId", variant_id AS "variantId", delta')) {
        if (skipSelectPrecheck) return { rows: [] };
        const found = state.movements.get(params[0]);
        return { rows: found ? [found] : [] };
      }

      if (norm.startsWith('SELECT s.warehouse_id AS "warehouseId", s.quantity')) {
        return {
          rows: [...state.warehouseStock.entries()].map(([whId, qty]) => ({
            warehouseId: whId,
            quantity: qty,
            code: 'MAIN',
            active: true
          }))
        };
      }

      if (norm.startsWith('SELECT id, active FROM warehouses')) {
        return { rows: [{ id: params[0], active: true }] };
      }

      if (norm.startsWith("SELECT id FROM warehouses WHERE code = 'MAIN'")) {
        return { rows: [{ id: mainWarehouseId }] };
      }

      if (norm.startsWith('INSERT INTO warehouse_stock')) {
        const [whId, , qty = 0] = params;
        if (!state.warehouseStock.has(whId)) {
          state.warehouseStock.set(whId, qty);
        }
        return { rows: [], rowCount: 0 };
      }

      if (norm.startsWith('SELECT quantity FROM warehouse_stock')) {
        const [whId] = params;
        return { rows: [{ quantity: state.warehouseStock.get(whId) ?? 0 }] };
      }

      if (norm.startsWith('INSERT INTO inventory_movements')) {
        const eventKey = params[0];
        if (state.movements.has(eventKey)) {
          // ON CONFLICT (event_key) DO NOTHING RETURNING id -> 0 rows!
          return { rows: [], rowCount: 0 };
        }
        const row = {
          id: `mov-${state.movements.size + 1}`,
          eventKey,
          warehouseId: params[1],
          variantId: params[2],
          movementType: params[6],
          delta: params[7],
          quantityBefore: params[8],
          quantityAfter: params[9]
        };
        state.movements.set(eventKey, row);
        return { rows: [{ id: row.id }], rowCount: 1 };
      }

      if (norm.startsWith('UPDATE warehouse_stock SET quantity')) {
        const [whId, , newBalance] = params;
        state.warehouseStock.set(whId, newBalance);
        return { rows: [], rowCount: 1 };
      }

      if (norm.startsWith('SELECT COALESCE(SUM(quantity), 0)::int AS total FROM warehouse_stock')) {
        let total = 0;
        for (const q of state.warehouseStock.values()) total += q;
        return { rows: [{ total }] };
      }

      if (norm.startsWith('UPDATE product_variants SET stock_quantity')) {
        state.variantStock = params[1];
        return { rows: [], rowCount: 1 };
      }

      if (norm.startsWith('INSERT INTO audit_events')) {
        return { rows: [{ id: 'aud-1' }], rowCount: 1 };
      }

      throw new Error(`Truy vấn chưa được mô phỏng: ${norm}`);
    }
  };

  return { client, state, variantId, mainWarehouseId };
}

test('P0 Query Simulator: applyMovement gọi 2 lần cùng eventId giữ nguyên tồn kho 7 (không tăng thành 9), kể cả khi ép qua nhánh ON CONFLICT DO NOTHING', async () => {
  for (const skipSelectPrecheck of [false, true]) {
    const { client, state, variantId, mainWarehouseId } = createQuerySimulator({
      initialStock: 5,
      skipSelectPrecheck
    });

    const first = await InventoryService.applyMovement(client, {
      source: 'inventory',
      eventId: 'EVT-DUP-PLUS-2',
      variantId,
      delta: 2,
      reason: 'Nhập bổ sung'
    });
    assert.equal(first.stockQuantity, 7);
    assert.equal(first.duplicate, false);
    assert.equal(state.variantStock, 7);
    assert.equal(state.warehouseStock.get(mainWarehouseId), 7);
    assert.equal(state.movements.size, 1);

    const second = await InventoryService.applyMovement(client, {
      source: 'inventory',
      eventId: 'EVT-DUP-PLUS-2',
      variantId,
      delta: 2,
      reason: 'Nhập bổ sung (gọi lặp)'
    });
    assert.equal(second.stockQuantity, 7, `Tồn kho lần 2 phải giữ nguyên là 7 (skipSelectPrecheck=${skipSelectPrecheck})`);
    assert.equal(second.duplicate, true);
    assert.equal(state.variantStock, 7);
    assert.equal(state.warehouseStock.get(mainWarehouseId), 7);
    assert.equal(state.movements.size, 1, 'Sổ biến động chỉ có đúng 1 bản ghi');
  }
});

test('P0 Real PostgreSQL: applyMovement bất biến khi gọi lặp cộng/trừ (kể cả khi tồn đã về 0) và chặn 409 nếu tái dùng eventId với delta khác', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const prod = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('p0-idem-prod', 'GAERU Idempotent Mic', 'audio', true) RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-P0-IDEM', 'Bản Chuẩn', 500000, 5, true) RETURNING id`,
    [prod.id]
  )).rows[0];

  const mainWh = (await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN'`)).rows[0];
  await pool.query(`INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 5)`, [mainWh.id, variant.id]);

  // 1. Cộng +2 hai lần cùng eventId: 5 -> 7, lần 2 giữ nguyên 7
  const plus1 = await withTransaction(pool, client =>
    InventoryService.applyMovement(client, {
      source: 'purchase_receipt',
      eventId: 'PO-REC-001',
      variantId: variant.id,
      delta: 2,
      actor: { username: 'warehouse_admin' }
    })
  );
  assert.equal(plus1.stockQuantity, 7);
  assert.equal(plus1.duplicate, false);

  const plus2 = await withTransaction(pool, client =>
    InventoryService.applyMovement(client, {
      source: 'purchase_receipt',
      eventId: 'PO-REC-001',
      variantId: variant.id,
      delta: 2,
      actor: { username: 'warehouse_admin' }
    })
  );
  assert.equal(plus2.stockQuantity, 7, 'Gọi lặp +2 cùng eventId không được cộng thêm lên 9');
  assert.equal(plus2.duplicate, true);

  // 2. Gọi cùng eventId nhưng đổi delta từ +2 sang +5 -> Phải báo lỗi 409 Conflict!
  await assert.rejects(
    async () => {
      await withTransaction(pool, client =>
        InventoryService.applyMovement(client, {
          source: 'purchase_receipt',
          eventId: 'PO-REC-001',
          variantId: variant.id,
          delta: 5
        })
      );
    },
    (err) => err.status === 409
  );

  // 3. Trừ hết sạch tồn kho (-7 từ 7 -> 0), sau đó gọi lặp lại cùng eventId (-7):
  //    Lần 2 phải trả về duplicate: true với stockQuantity = 0 (không trừ âm và không báo lỗi hết hàng giả!)
  const minus1 = await withTransaction(pool, client =>
    InventoryService.applyMovement(client, {
      source: 'sale_reservation',
      eventId: 'ORD-RES-ALL',
      variantId: variant.id,
      delta: -7
    })
  );
  assert.equal(minus1.stockQuantity, 0);
  assert.equal(minus1.duplicate, false);

  const minus2 = await withTransaction(pool, client =>
    InventoryService.applyMovement(client, {
      source: 'sale_reservation',
      eventId: 'ORD-RES-ALL',
      variantId: variant.id,
      delta: -7
    })
  );
  assert.equal(minus2.stockQuantity, 0);
  assert.equal(minus2.duplicate, true);

  // 4. Đối soát bảo toàn: warehouse_stock == product_variants == 5 + SUM(movements.delta)
  const whBal = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [mainWh.id, variant.id])).rows[0].quantity;
  const varBal = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity;
  const movRows = (await pool.query(`SELECT delta FROM inventory_movements WHERE variant_id = $1`, [variant.id])).rows;
  assert.equal(whBal, 0);
  assert.equal(varBal, 0);
  assert.equal(movRows.length, 2, 'Chỉ có đúng 2 dòng biến động thực tế (+2 và -7)');
  assert.equal(5 + movRows.reduce((s, r) => s + r.delta, 0), varBal);
});

test('P0 Legacy Order & Cross-Service Release: Đường hoàn kho đơn hàng cũ (nhiều dòng cùng SKU, biến thể đã xóa, gọi lặp và gọi chéo giữa inventory.js / InventoryService) tuyệt đối không cộng trùng', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const prod = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('legacy-order-prod', 'GAERU Legacy Gimbal', 'audio', true) RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-LEGACY-01', 'Bản Tiêu Chuẩn', 900000, 5, true) RETURNING id`,
    [prod.id]
  )).rows[0];

  const mainWh = (await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN'`)).rows[0];
  const auxWh = (await pool.query(`INSERT INTO warehouses (code, name, active) VALUES ('LEG-AUX', 'Kho Phụ', true) RETURNING id`)).rows[0];

  // Tồn ban đầu: AUX = 5, MAIN chưa có dòng (tổng = 5)
  await pool.query(`INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 5)`, [auxWh.id, variant.id]);

  // --- Kịch bản A: Đơn cũ (không có order_stock_allocations), có 2 dòng cùng variantId (1 + 1 = 2) và 1 dòng variant_id = NULL ---
  const legacyOrder1 = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status)
     VALUES ('ORD-LEG-01', 'Khách Đơn Cũ 1', 'leg1@example.com', '0901110001', '10 Trần Hưng Đạo', 'Hà Nội', 'cod', 2700000, 2700000, 'pending', 'pending')
     RETURNING id`
  )).rows[0];

  await pool.query(
    `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES
       ($1, $2, 'GAERU Legacy Gimbal', 'Bản Tiêu Chuẩn', 'SKU-LEGACY-01', 900000, 1, 900000),
       ($1, $2, 'GAERU Legacy Gimbal', 'Bản Tiêu Chuẩn', 'SKU-LEGACY-01', 900000, 1, 900000),
       ($1, NULL, 'Sản phẩm đã ngừng kinh doanh', 'Bản Cũ', 'SKU-DELETED', 900000, 1, 900000)`,
    [legacyOrder1.id, variant.id]
  );

  // Lần 1: Gọi InventoryService.restoreOrderStock -> hoàn tổng 2 chiếc về kho MAIN (tổng tồn 5 -> 7: AUX=5, MAIN=2)
  const res1 = await withTransaction(pool, client =>
    InventoryService.restoreOrderStock(client, {
      orderId: legacyOrder1.id,
      actor: { username: 'admin' }
    })
  );
  assert.equal(res1.length, 1);
  assert.equal(res1[0].stockQuantity, 7);

  // Lần 2: Gọi lặp InventoryService.restoreOrderStock trên cùng đơn cũ -> trả về [], tồn giữ nguyên = 7 (không tăng thành 9!)
  const res2 = await withTransaction(pool, client =>
    InventoryService.restoreOrderStock(client, {
      orderId: legacyOrder1.id,
      actor: { username: 'admin' }
    })
  );
  assert.equal(res2.length, 0, 'Gọi lặp restoreOrderStock trên đơn cũ phải trả về mảng rỗng');

  // Lần 3: Gọi chéo inventory.releaseOrderStock (src/inventory.js) trên cùng đơn cũ -> vẫn nhận diện đúng khóa `legacy-release:...` và giữ nguyên tồn = 7!
  await withTransaction(pool, client =>
    inventory.releaseOrderStock(client, {
      orderId: legacyOrder1.id,
      actor: { username: 'admin' }
    })
  );

  const stockAfterLeg1 = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity;
  const mainBalAfterLeg1 = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [mainWh.id, variant.id])).rows[0].quantity;
  const auxBalAfterLeg1 = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [auxWh.id, variant.id])).rows[0].quantity;
  assert.equal(stockAfterLeg1, 7, 'Tổng tồn kho phải giữ đúng là 7 sau cả 3 lần gọi');
  assert.equal(mainBalAfterLeg1, 2, 'Kho MAIN nhận đúng 2 chiếc hoàn của đơn cũ');
  assert.equal(auxBalAfterLeg1, 5, 'Kho AUX bảo toàn nguyên vẹn 5 chiếc');

  // --- Kịch bản B: Chiều ngược lại - inventory.releaseOrderStock chạy trước, InventoryService.restoreOrderStock chạy sau ---
  const legacyOrder2 = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status)
     VALUES ('ORD-LEG-02', 'Khách Đơn Cũ 2', 'leg2@example.com', '0901110002', '20 Hai Bà Trưng', 'Hà Nội', 'cod', 2700000, 2700000, 'pending', 'pending')
     RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES ($1, $2, 'GAERU Legacy Gimbal', 'Bản Tiêu Chuẩn', 'SKU-LEGACY-01', 900000, 3, 2700000)`,
    [legacyOrder2.id, variant.id]
  );

  await withTransaction(pool, client =>
    inventory.releaseOrderStock(client, {
      orderId: legacyOrder2.id,
      actor: { username: 'admin' }
    })
  );
  const stockAfterFirstLeg2 = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity;
  assert.equal(stockAfterFirstLeg2, 10); // 7 + 3 = 10

  const crossRes = await withTransaction(pool, client =>
    InventoryService.restoreOrderStock(client, {
      orderId: legacyOrder2.id,
      actor: { username: 'admin' }
    })
  );
  assert.equal(crossRes.length, 0);
  const stockAfterSecondLeg2 = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity;
  assert.equal(stockAfterSecondLeg2, 10, 'Gọi chéo InventoryService.restoreOrderStock sau inventory.releaseOrderStock không được cộng trùng lên 13');

  // --- Kịch bản C: Chu kỳ Khôi phục đơn đã hủy (Cancel -> Restore w/ reservation_cycle -> Cancel lần 2 -> Gọi lặp Cancel lần 2) ---
  const cycleOrder = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status)
     VALUES ('ORD-CYCLE-01', 'Khách Chu Kỳ', 'cycle@example.com', '0901110003', '30 Lý Thường Kiệt', 'Hà Nội', 'cod', 1800000, 1800000, 'pending', 'pending')
     RETURNING id`
  )).rows[0];

  await withTransaction(pool, client =>
    InventoryService.reserveOrderStock(client, {
      orderId: cycleOrder.id,
      items: [{ variantId: variant.id, sku: 'SKU-LEGACY-01', quantity: 2 }],
      actor: { username: 'customer' }
    })
  );
  assert.equal((await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity, 8);

  // Hủy lần 1
  await withTransaction(pool, client =>
    InventoryService.restoreOrderStock(client, { orderId: cycleOrder.id, actor: { username: 'admin' } })
  );
  assert.equal((await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity, 10);

  // Khôi phục đơn đã hủy (tạo chu kỳ giữ kho mới với reservation_cycle)
  const cycleKey = randomUUID();
  await withTransaction(pool, client =>
    inventory.restoreOrderStock(client, {
      orderId: cycleOrder.id,
      items: [{ variantId: variant.id, quantity: 2 }],
      requestKey: cycleKey,
      actor: { username: 'admin' }
    })
  );
  assert.equal((await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity, 8);

  // Hủy lần 2 qua InventoryService.restoreOrderStock -> phải hoàn trả về 10 nhờ khóa `:cycle:<cycleKey>`
  const cancelAgain1 = await withTransaction(pool, client =>
    InventoryService.restoreOrderStock(client, { orderId: cycleOrder.id, actor: { username: 'admin' } })
  );
  assert.equal(cancelAgain1.length > 0, true);
  assert.equal((await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity, 10);

  // Gọi lặp sau khi đã hủy lần 2 -> giữ nguyên 10!
  const cancelAgainDup = await withTransaction(pool, client =>
    InventoryService.restoreOrderStock(client, { orderId: cycleOrder.id, actor: { username: 'admin' } })
  );
  assert.equal(cancelAgainDup.length, 0);
  assert.equal((await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity, 10);
});
