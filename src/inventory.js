const { randomUUID } = require("node:crypto");
const { appendAudit } = require("./audit");

const MAX_STOCK = 1_000_000_000;

function operationError(message, status = 409) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function actorName(actor) {
  return actor?.username || "system";
}

function validateQuantity(quantity, { allowZero = true } = {}) {
  if (!Number.isSafeInteger(quantity) || quantity < (allowZero ? 0 : 1) || quantity > MAX_STOCK) {
    throw operationError("Số lượng tồn kho không hợp lệ.", 400);
  }
}

async function lockVariant(client, variantId) {
  const result = await client.query(
    `SELECT v.id,v.sku,v.name AS "variantName",p.name AS "productName",v.stock_quantity AS "stockQuantity"
     FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 FOR UPDATE OF v`, [variantId]
  );
  if (!result.rows[0]) throw operationError("Không tìm thấy phiên bản sản phẩm.", 404);
  return result.rows[0];
}

async function lockWarehouse(client, warehouseId) {
  const result = await client.query("SELECT id,active FROM warehouses WHERE id=$1 FOR SHARE", [warehouseId]);
  if (!result.rows[0] || !result.rows[0].active) throw operationError("Kho không tồn tại hoặc đã ngừng hoạt động.");
}

async function getMainWarehouse(client) {
  const result = await client.query("SELECT id FROM warehouses WHERE code='MAIN' AND active=true");
  if (!result.rows[0]) throw operationError("Kho chính chưa sẵn sàng.");
  return result.rows[0].id;
}

async function lockBalance(client, warehouseId, variantId) {
  await client.query(
    "INSERT INTO warehouse_stock (warehouse_id,variant_id,quantity) VALUES ($1,$2,0) ON CONFLICT (warehouse_id,variant_id) DO NOTHING",
    [warehouseId, variantId]
  );
  const result = await client.query(
    "SELECT quantity FROM warehouse_stock WHERE warehouse_id=$1 AND variant_id=$2 FOR UPDATE", [warehouseId, variantId]
  );
  return result.rows[0].quantity;
}

async function allBalances(client, variantId) {
  const result = await client.query(
    `SELECT s.warehouse_id AS "warehouseId",s.quantity,w.active FROM warehouse_stock s
     JOIN warehouses w ON w.id=s.warehouse_id WHERE s.variant_id=$1 ORDER BY s.warehouse_id FOR UPDATE OF s`, [variantId]
  );
  return result.rows;
}

function verifyBalanceTotal(variant, balances) {
  if (balances.reduce((sum, row) => sum + row.quantity, 0) !== variant.stockQuantity) {
    throw operationError("Tồn kho tổng chưa khớp các kho. Cần đối soát trước khi thay đổi.");
  }
}

async function move(client, { variant, warehouseId, before, delta, type, eventKey, referenceType, referenceId, reason = "", actor }) {
  const after = before + delta;
  validateQuantity(after);
  if (!delta) return;
  await client.query(
    "UPDATE warehouse_stock SET quantity=$3,updated_at=now() WHERE warehouse_id=$1 AND variant_id=$2",
    [warehouseId, variant.id, after]
  );
  await client.query(
    `INSERT INTO inventory_movements (event_key,warehouse_id,variant_id,sku,product_name,variant_name,
      movement_type,delta,quantity_before,quantity_after,reference_type,reference_id,reason,actor_id,actor_username)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [eventKey, warehouseId, variant.id, variant.sku, variant.productName, variant.variantName,
      type, delta, before, after, referenceType, String(referenceId), reason, actor?.id || null, actorName(actor)]
  );
}

async function updateAggregate(client, variantId, quantity) {
  validateQuantity(quantity);
  await client.query("UPDATE product_variants SET stock_quantity=$2,updated_at=now() WHERE id=$1", [variantId, quantity]);
}

async function initializeVariantStock(client, { variantId, quantity, actor }) {
  validateQuantity(quantity);
  const variant = await lockVariant(client, variantId);
  const warehouseId = await getMainWarehouse(client);
  const inserted = await client.query(
    `INSERT INTO warehouse_stock (warehouse_id,variant_id,quantity)
     SELECT $1,$2,0 WHERE NOT EXISTS (SELECT 1 FROM warehouse_stock WHERE variant_id=$2)
     ON CONFLICT (warehouse_id,variant_id) DO NOTHING RETURNING variant_id`, [warehouseId, variantId]
  );
  if (!inserted.rowCount) return;
  if (quantity !== variant.stockQuantity) throw operationError("Số dư khởi tạo không khớp tồn kho sản phẩm.");
  await move(client, { variant, warehouseId, before: 0, delta: quantity, type: "opening", eventKey: `opening:${variantId}`,
    referenceType: "opening", referenceId: variantId, reason: "Số dư tồn khả dụng ban đầu", actor });
  await appendAudit(client, { actor, action: "inventory.initialize", entityType: "variant", entityId: variantId, after: { warehouseId, quantity } });
}

async function setVariantStock(client, { variantId, quantity, actor, reason = "Cập nhật tồn kho qua quản trị sản phẩm" }) {
  validateQuantity(quantity);
  const variant = await lockVariant(client, variantId);
  const balances = await allBalances(client, variantId);
  verifyBalanceTotal(variant, balances);
  const difference = quantity - variant.stockQuantity;
  if (!difference) return;
  const referenceId = randomUUID();
  if (difference > 0) {
    const warehouseId = await getMainWarehouse(client);
    await lockWarehouse(client, warehouseId);
    const before = await lockBalance(client, warehouseId, variantId);
    await move(client, { variant, warehouseId, before, delta: difference, type: "adjustment", eventKey: `adjustment:${referenceId}`,
      referenceType: "product_edit", referenceId, reason, actor });
  } else {
    let remaining = -difference;
    for (const balance of balances) {
      const amount = Math.min(remaining, balance.quantity);
      if (amount) await move(client, { variant, warehouseId: balance.warehouseId, before: balance.quantity, delta: -amount,
        type: "adjustment", eventKey: `adjustment:${referenceId}:${balance.warehouseId}`, referenceType: "product_edit", referenceId, reason, actor });
      remaining -= amount;
      if (!remaining) break;
    }
  }
  await updateAggregate(client, variantId, quantity);
  await appendAudit(client, { actor, action: "inventory.set", entityType: "variant", entityId: variantId,
    before: { quantity: variant.stockQuantity }, after: { quantity }, metadata: { reason } });
}

async function reserveStock(client, { variantId, quantity, orderId, actor }) {
  validateQuantity(quantity, { allowZero: false });
  const variant = await lockVariant(client, variantId);
  const existing = await client.query(
    "SELECT quantity,released_at FROM order_stock_allocations WHERE order_id=$1 AND variant_id=$2", [orderId, variantId]
  );
  if (existing.rows.length) {
    if (existing.rows.some((row) => row.released_at) || existing.rows.reduce((sum, row) => sum + row.quantity, 0) !== quantity) {
      throw operationError("Phân bổ kho của đơn hàng không khớp yêu cầu.");
    }
    return;
  }
  const balances = await allBalances(client, variantId);
  verifyBalanceTotal(variant, balances);
  if (variant.stockQuantity < quantity || balances.filter((row) => row.active).reduce((sum, row) => sum + row.quantity, 0) < quantity) {
    throw operationError("Tồn kho khả dụng không đủ để đặt hàng.");
  }
  let remaining = quantity;
  for (const balance of balances.filter((row) => row.active)) {
    const amount = Math.min(remaining, balance.quantity);
    if (amount) {
      await client.query(
        "INSERT INTO order_stock_allocations (order_id,variant_id,warehouse_id,quantity) VALUES ($1,$2,$3,$4)",
        [orderId, variantId, balance.warehouseId, amount]
      );
      await move(client, { variant, warehouseId: balance.warehouseId, before: balance.quantity, delta: -amount,
        type: "sale_reservation", eventKey: `reserve:${orderId}:${variantId}:${balance.warehouseId}`,
        referenceType: "order", referenceId: orderId, reason: "Giữ tồn khả dụng cho đơn hàng", actor });
    }
    remaining -= amount;
    if (!remaining) break;
  }
  await updateAggregate(client, variantId, variant.stockQuantity - quantity);
  await appendAudit(client, { actor, action: "inventory.reserve", entityType: "order", entityId: orderId, metadata: { variantId, quantity } });
}

async function releaseOrderStock(client, { orderId, actor }) {
  const result = await client.query(
    "SELECT DISTINCT variant_id AS id FROM order_stock_allocations WHERE order_id=$1 AND released_at IS NULL ORDER BY variant_id", [orderId]
  );
  if (!result.rows.length) {
    const anyAllocation = await client.query("SELECT EXISTS (SELECT 1 FROM order_stock_allocations WHERE order_id=$1) AS allocated", [orderId]);
    if (anyAllocation.rows[0].allocated) return;
    const legacyItems = await client.query(
      `SELECT variant_id AS "variantId",SUM(quantity)::int AS quantity FROM order_items
       WHERE order_id=$1 AND variant_id IS NOT NULL GROUP BY variant_id ORDER BY variant_id`, [orderId]
    );
    const skipped = await client.query("SELECT COUNT(*)::int AS count FROM order_items WHERE order_id=$1 AND variant_id IS NULL", [orderId]);
    const restored = [];
    for (const item of legacyItems.rows) {
      const variant = await lockVariant(client, item.variantId);
      const eventKey = `legacy-release:${orderId}:${item.variantId}`;
      const previous = await client.query("SELECT id FROM inventory_movements WHERE event_key=$1", [eventKey]);
      if (previous.rows.length) continue;
      const balances = await allBalances(client, item.variantId);
      verifyBalanceTotal(variant, balances);
      const warehouseId = await getMainWarehouse(client);
      await lockWarehouse(client, warehouseId);
      const before = await lockBalance(client, warehouseId, item.variantId);
      validateQuantity(variant.stockQuantity + item.quantity);
      await move(client, { variant, warehouseId, before, delta: item.quantity, type: "legacy_sale_release", eventKey,
        referenceType: "order", referenceId: orderId, reason: "Đơn trước khi phân kho; hoàn về Kho tổng theo quy tắc chuyển đổi", actor });
      await updateAggregate(client, item.variantId, variant.stockQuantity + item.quantity);
      restored.push({ variantId: item.variantId, warehouseId, quantity: item.quantity });
    }
    if (restored.length || skipped.rows[0].count) await appendAudit(client, { actor, action: "inventory.legacy_release", entityType: "order", entityId: orderId,
      metadata: { restored, skippedDeletedVariantLines: skipped.rows[0].count, policy: "legacy_order_release_to_main" } });
    return;
  }
  for (const { id: variantId } of result.rows) {
    const variant = await lockVariant(client, variantId);
    const allocations = await client.query(
      `SELECT warehouse_id AS "warehouseId",quantity FROM order_stock_allocations
       WHERE order_id=$1 AND variant_id=$2 AND released_at IS NULL ORDER BY warehouse_id FOR UPDATE`, [orderId, variantId]
    );
    const balances = await allBalances(client, variantId);
    verifyBalanceTotal(variant, balances);
    let released = 0;
    for (const allocation of allocations.rows) {
      const before = await lockBalance(client, allocation.warehouseId, variantId);
      await move(client, { variant, warehouseId: allocation.warehouseId, before, delta: allocation.quantity,
        type: "sale_release", eventKey: `release:${orderId}:${variantId}:${allocation.warehouseId}`,
        referenceType: "order", referenceId: orderId, reason: "Hoàn tồn khả dụng do hủy đơn", actor });
      await client.query(
        "UPDATE order_stock_allocations SET released_at=now() WHERE order_id=$1 AND variant_id=$2 AND warehouse_id=$3",
        [orderId, variantId, allocation.warehouseId]
      );
      released += allocation.quantity;
    }
    if (released) {
      await updateAggregate(client, variantId, variant.stockQuantity + released);
      await appendAudit(client, { actor, action: "inventory.release", entityType: "order", entityId: orderId, metadata: { variantId, quantity: released } });
    }
  }
}

async function adjustWarehouseStock(client, { warehouseId, variantId, delta, expectedQuantity, reason, requestKey, actor }) {
  if (!Number.isSafeInteger(delta) || !delta || Math.abs(delta) > MAX_STOCK) throw operationError("Mức điều chỉnh không hợp lệ.", 400);
  const variant = await lockVariant(client, variantId);
  await lockWarehouse(client, warehouseId);
  const balances = await allBalances(client, variantId);
  verifyBalanceTotal(variant, balances);
  const before = await lockBalance(client, warehouseId, variantId);
  if (before !== expectedQuantity) throw operationError("Tồn kho đã thay đổi. Hãy tải lại số dư trước khi duyệt điều chỉnh.");
  validateQuantity(before + delta);
  validateQuantity(variant.stockQuantity + delta);
  await move(client, { variant, warehouseId, before, delta, type: "adjustment", eventKey: `adjustment:${requestKey}`,
    referenceType: "adjustment", referenceId: requestKey, reason, actor });
  await updateAggregate(client, variantId, variant.stockQuantity + delta);
  await appendAudit(client, { actor, action: "inventory.adjust", entityType: "variant", entityId: variantId,
    before: { warehouseId, quantity: before }, after: { warehouseId, quantity: before + delta }, metadata: { reason, requestKey } });
  return { warehouseId, variantId, quantity: before + delta, aggregateQuantity: variant.stockQuantity + delta };
}

async function transferStock(client, { fromWarehouseId, toWarehouseId, variantId, quantity, reason, requestKey, actor }) {
  validateQuantity(quantity, { allowZero: false });
  if (fromWarehouseId === toWarehouseId) throw operationError("Kho nguồn và kho đích phải khác nhau.", 400);
  const variant = await lockVariant(client, variantId);
  for (const warehouseId of [fromWarehouseId, toWarehouseId].sort()) await lockWarehouse(client, warehouseId);
  const balances = await allBalances(client, variantId);
  verifyBalanceTotal(variant, balances);
  const from = await lockBalance(client, fromWarehouseId, variantId);
  const to = await lockBalance(client, toWarehouseId, variantId);
  if (from < quantity) throw operationError("Kho nguồn không đủ tồn khả dụng để chuyển.");
  validateQuantity(to + quantity);
  await move(client, { variant, warehouseId: fromWarehouseId, before: from, delta: -quantity, type: "transfer_out",
    eventKey: `transfer:${requestKey}:out`, referenceType: "transfer", referenceId: requestKey, reason, actor });
  await move(client, { variant, warehouseId: toWarehouseId, before: to, delta: quantity, type: "transfer_in",
    eventKey: `transfer:${requestKey}:in`, referenceType: "transfer", referenceId: requestKey, reason, actor });
  await appendAudit(client, { actor, action: "inventory.transfer", entityType: "variant", entityId: variantId,
    metadata: { fromWarehouseId, toWarehouseId, quantity, reason, requestKey } });
  return { variantId, fromWarehouseId, toWarehouseId, quantity, aggregateQuantity: variant.stockQuantity };
}

async function receiveStock(client, { warehouseId, variantId, quantity, receiptId, receiptItemId, actor }) {
  validateQuantity(quantity, { allowZero: false });
  const variant = await lockVariant(client, variantId);
  await lockWarehouse(client, warehouseId);
  const balances = await allBalances(client, variantId);
  verifyBalanceTotal(variant, balances);
  const before = await lockBalance(client, warehouseId, variantId);
  validateQuantity(variant.stockQuantity + quantity);
  await move(client, { variant, warehouseId, before, delta: quantity, type: "purchase_receipt",
    eventKey: `receipt:${receiptItemId}`, referenceType: "goods_receipt", referenceId: receiptId, reason: "Nhận hàng từ đơn mua", actor });
  await updateAggregate(client, variantId, variant.stockQuantity + quantity);
}

module.exports = { initializeVariantStock, setVariantStock, reserveStock, releaseOrderStock,
  adjustWarehouseStock, transferStock, receiveStock, operationError, MAX_STOCK };
