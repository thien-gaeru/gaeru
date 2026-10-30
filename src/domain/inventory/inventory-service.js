'use strict';

/**
 * src/domain/inventory/inventory-service.js
 * 
 * Single Source of Truth cho các thao tác ghi sổ và điều chỉnh tồn kho tại GAERU:
 * - Áp dụng biến động tồn kho ghi sổ đầy đủ (applyMovement)
 * - Khấu trừ kho khi tạo đơn hàng (reserveOrderStock)
 * - Hoàn tồn kho khi hủy đơn / xóa đơn (restoreOrderStock)
 * - Đồng bộ tồn kho đa kênh (omnichannel sync)
 */

const { appendAudit } = require('../../audit');

class InventoryService {
  /**
   * Áp dụng biến động tồn kho ghi sổ (Authoritative Ledger):
   * 1. Khóa hàng biến thể bằng FOR UPDATE
   * 2. Kiểm tra kho hàng (warehouse) và khóa dòng warehouse_stock
   * 3. Kiểm tra tính toàn vẹn tồn kho (chặn âm nếu allowNegative = false)
   * 4. Ghi nhận nhật ký biến động inventory_movements
   * 5. Cập nhật tồn kho kho hàng và đối soát tổng tồn kho product_variants
   */
  static async applyMovement(client, {
    source = 'inventory',
    eventId,
    sku,
    variantId,
    delta = 0,
    warehouseId,
    actor,
    reason = 'Authoritative stock movement',
    allowNegative = false,
    metadata = {}
  }) {
    if (!sku && !variantId) {
      throw Object.assign(new Error('Yêu cầu sku hoặc variantId để điều chỉnh tồn kho.'), { status: 400 });
    }
    if (!Number.isInteger(delta)) {
      throw Object.assign(new Error('Lượng biến động tồn kho (delta) phải là số nguyên.'), { status: 400 });
    }

    let variantRes;
    if (variantId) {
      variantRes = await client.query(
        `SELECT v.id, v.sku, v.name AS "variantName", p.name AS "productName", v.stock_quantity AS "stockQuantity"
         FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1 FOR UPDATE OF v`,
        [variantId]
      );
    } else {
      variantRes = await client.query(
        `SELECT v.id, v.sku, v.name AS "variantName", p.name AS "productName", v.stock_quantity AS "stockQuantity"
         FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.sku = $1 FOR UPDATE OF v`,
        [sku]
      );
    }

    const variant = variantRes.rows[0];
    if (!variant) {
      throw Object.assign(new Error(`Không tìm thấy sản phẩm với SKU: "${sku || variantId}".`), { status: 404 });
    }

    // Xác định kho hàng chính (MAIN warehouse)
    let targetWarehouseId = warehouseId;
    if (!targetWarehouseId) {
      try {
        const whRes = await client.query(`SELECT id FROM warehouses WHERE code = 'MAIN' AND active = true LIMIT 1`);
        targetWarehouseId = whRes.rows[0]?.id;
        if (!targetWarehouseId) {
          const anyWh = await client.query(`SELECT id FROM warehouses WHERE active = true LIMIT 1`);
          targetWarehouseId = anyWh.rows[0]?.id;
        }
      } catch (_) {}
    }

    let finalStock = variant.stockQuantity;

    if (targetWarehouseId) {
      await client.query(
        `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (warehouse_id, variant_id) DO NOTHING`,
        [targetWarehouseId, variant.id, variant.stockQuantity]
      );

      const balRes = await client.query(
        `SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2 FOR UPDATE`,
        [targetWarehouseId, variant.id]
      );

      const currentBalance = Number(balRes.rows[0]?.quantity) || 0;
      const newBalance = currentBalance + delta;

      if (!allowNegative && newBalance < 0) {
        throw Object.assign(
          new Error(`Tồn kho không đủ để trừ (tồn hiện tại: ${currentBalance}, yêu cầu giảm: ${Math.abs(delta)}).`),
          { status: 409 }
        );
      }

      await client.query(
        `UPDATE warehouse_stock SET quantity = $3, updated_at = now() WHERE warehouse_id = $1 AND variant_id = $2`,
        [targetWarehouseId, variant.id, newBalance]
      );

      const eventKey = eventId || `${source}:${variant.id}:${Date.now()}`;
      const validMovementTypes = ['opening', 'adjustment', 'transfer_in', 'transfer_out', 'sale_reservation', 'sale_release', 'legacy_sale_release', 'purchase_receipt'];
      const movementType = validMovementTypes.includes(source) ? source : 'adjustment';
      try {
        await client.query(
          `INSERT INTO inventory_movements (
             event_key, warehouse_id, variant_id, sku, product_name, variant_name,
             movement_type, delta, quantity_before, quantity_after, reference_type, reference_id, reason, actor_id, actor_username
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            eventKey, targetWarehouseId, variant.id, variant.sku, variant.productName, variant.variantName,
            movementType, delta, currentBalance, newBalance, source, String(eventId || ''),
            reason, actor?.id || null, actor?.username || 'system'
          ]
        );
      } catch (movErr) {
        // Nếu event_key bị trùng lặp trong inventory_movements
        if (movErr.code === '23505') {
          console.warn(`Inventory movement event_key collision: ${eventKey}`);
        } else {
          throw movErr;
        }
      }

      // Đối soát và cập nhật tổng tồn kho product_variants từ warehouse_stock
      const sumRes = await client.query(
        `SELECT COALESCE(SUM(quantity), 0)::int AS total FROM warehouse_stock WHERE variant_id = $1`,
        [variant.id]
      );
      finalStock = sumRes.rows[0]?.total ?? newBalance;

      await client.query(
        `UPDATE product_variants SET stock_quantity = $2, updated_at = now() WHERE id = $1`,
        [variant.id, finalStock]
      );
    } else {
      // Fallback khi bảng warehouses chưa được khởi tạo
      const newStock = variant.stockQuantity + delta;
      if (!allowNegative && newStock < 0) {
        throw Object.assign(new Error(`Tồn kho không đủ để điều chỉnh.`), { status: 409 });
      }
      finalStock = Math.max(0, newStock);
      await client.query(
        `UPDATE product_variants SET stock_quantity = $2, updated_at = now() WHERE id = $1`,
        [variant.id, finalStock]
      );
    }

    if (actor) {
      await appendAudit(client, {
        actor,
        action: 'inventory.stock.movement',
        entityType: 'product_variant',
        entityId: variant.id,
        metadata: { sku: variant.sku, delta, finalStock, source, eventId, reason, ...metadata }
      }).catch(() => {});
    }

    return {
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      stockQuantity: finalStock
    };
  }

  /**
   * Điều chỉnh tồn kho tương thích ngược (adapter gọi applyMovement)
   */
  static async adjustStock(client, { variantId, sku, delta, reason = 'manual_adjustment', actor, metadata = {}, allowNegative = false }) {
    return InventoryService.applyMovement(client, {
      source: 'manual_adjustment',
      sku,
      variantId,
      delta,
      actor,
      reason,
      allowNegative,
      metadata
    });
  }

  /**
   * Khấu trừ tồn kho khi tạo đơn hàng mới
   */
  static async reserveOrderStock(client, { items, orderId, actor }) {
    if (!items || !items.length) return;

    for (const item of items) {
      await InventoryService.applyMovement(client, {
        source: 'order_reservation',
        variantId: item.id,
        sku: item.sku,
        delta: -item.quantity,
        eventId: `reserve:${orderId}:${item.id}`,
        actor: actor || { username: 'customer', source: 'customer' },
        reason: `Đặt hàng ${orderId}`
      });
    }

    if (actor && orderId) {
      await appendAudit(client, {
        actor,
        action: 'inventory.stock.reserve_order',
        entityType: 'order',
        entityId: orderId,
        metadata: { itemCount: items.length }
      }).catch(() => {});
    }
  }

  /**
   * Hoàn trả tồn kho từ các món của đơn hàng (khi đơn hủy hoặc bị xóa)
   */
  static async restoreOrderStock(client, { orderId, actor, reason = 'order_cancellation' }) {
    if (!orderId) return [];

    const itemsRes = await client.query(
      `SELECT i.variant_id AS "variantId", i.sku, i.quantity FROM order_items i WHERE i.order_id = $1`,
      [orderId]
    );

    const restored = [];
    for (const item of (itemsRes.rows || [])) {
      const res = await InventoryService.applyMovement(client, {
        source: 'order_restoration',
        variantId: item.variantId,
        sku: item.sku,
        delta: item.quantity,
        eventId: `restore:${orderId}:${item.variantId}`,
        actor: actor || { username: 'system' },
        reason
      });
      restored.push(res);
    }

    if (actor && restored.length) {
      await appendAudit(client, {
        actor,
        action: 'inventory.stock.restore_order',
        entityType: 'order',
        entityId: orderId,
        metadata: { restoredCount: restored.length, reason }
      }).catch(() => {});
    }

    return restored;
  }
}

module.exports = {
  InventoryService
};
