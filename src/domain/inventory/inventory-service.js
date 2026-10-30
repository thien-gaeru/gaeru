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
   * 4. Ghi nhận nhật ký biến động inventory_movements (ON CONFLICT DO NOTHING)
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

    // 1. Kiểm tra toàn bộ số dư kho hiện có của biến thể này
    let existingStockRes = { rows: [] };
    try {
      existingStockRes = await client.query(
        `SELECT s.warehouse_id AS "warehouseId", s.quantity, w.code, w.active
         FROM warehouse_stock s
         JOIN warehouses w ON w.id = s.warehouse_id
         WHERE s.variant_id = $1
         ORDER BY CASE WHEN w.code = 'MAIN' THEN 0 ELSE 1 END, s.quantity DESC`,
        [variant.id]
      );
    } catch (_) {}

    // 2. Xác định kho đích (targetWarehouseId)
    let targetWarehouseId = warehouseId;
    if (!targetWarehouseId) {
      if (existingStockRes.rows.length === 0) {
        // Biến thể chưa có dòng kho nào -> chọn kho MAIN hoặc bất kỳ kho nào đang active
        try {
          const whRes = await client.query(`SELECT id FROM warehouses WHERE code = 'MAIN' AND active = true LIMIT 1`);
          targetWarehouseId = whRes.rows[0]?.id;
          if (!targetWarehouseId) {
            const anyWh = await client.query(`SELECT id FROM warehouses WHERE active = true LIMIT 1`);
            targetWarehouseId = anyWh.rows[0]?.id;
          }
        } catch (_) {}
      } else {
        // Đã có kho. Nếu delta < 0 (giảm kho): tìm kho có đủ số dư
        if (delta < 0) {
          const needed = Math.abs(delta);
          const adequateWh = existingStockRes.rows.find(r => r.active && r.quantity >= needed);
          if (adequateWh) {
            targetWarehouseId = adequateWh.warehouseId;
          } else {
            // Không có kho đơn lẻ nào đủ, ưu tiên kho MAIN hoặc kho có tồn cao nhất
            targetWarehouseId = existingStockRes.rows[0]?.warehouseId;
          }
        } else {
          // delta >= 0 (tăng kho): ưu tiên MAIN nếu có và active
          const mainWh = existingStockRes.rows.find(r => r.code === 'MAIN' && r.active);
          targetWarehouseId = mainWh ? mainWh.warehouseId : existingStockRes.rows[0]?.warehouseId;
        }
      }
    }

    let finalStock = variant.stockQuantity;

    if (targetWarehouseId) {
      // P0 FIX: Chỉ khởi tạo số dư từ variant.stockQuantity khi biến thể CHƯA TỪNG CÓ bản ghi kho nào!
      // Nếu biến thể đã có tồn ở kho khác, kho mới CHỈ ĐƯỢC khởi tạo số dư là 0, tuyệt đối không nhân đôi variant.stockQuantity!
      if (existingStockRes.rows.length === 0) {
        await client.query(
          `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
           VALUES ($1, $2, $3)
           ON CONFLICT (warehouse_id, variant_id) DO NOTHING`,
          [targetWarehouseId, variant.id, variant.stockQuantity]
        );
        if (variant.stockQuantity > 0) {
          await client.query(
            `INSERT INTO inventory_movements (
               event_key, warehouse_id, variant_id, sku, product_name, variant_name,
               movement_type, delta, quantity_before, quantity_after, reference_type, reference_id, reason, actor_username
             ) VALUES ($1, $2, $3, $4, $5, $6, 'opening', $7, 0, $7, 'opening', $8, 'Khởi tạo tồn kho ban đầu', 'system')
             ON CONFLICT (event_key) DO NOTHING`,
            [`opening:${variant.id}:${targetWarehouseId}`, targetWarehouseId, variant.id, variant.sku, variant.productName, variant.variantName, variant.stockQuantity, String(variant.id)]
          );
        }
      } else {
        await client.query(
          `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
           VALUES ($1, $2, 0)
           ON CONFLICT (warehouse_id, variant_id) DO NOTHING`,
          [targetWarehouseId, variant.id]
        );
      }

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

      // P1 FIX: Chuẩn hóa event_key bao gồm channel, eventId, variantId để tránh collision xuyên kênh
      const channelPrefix = metadata.channel ? `${metadata.channel}:` : '';
      const eventKey = eventId
        ? `${source}:${channelPrefix}${eventId}:${variant.id}`
        : `${source}:${variant.id}:${targetWarehouseId}:${Date.now()}`;

      const validMovementTypes = ['opening', 'adjustment', 'transfer_in', 'transfer_out', 'sale_reservation', 'sale_release', 'legacy_sale_release', 'purchase_receipt'];
      let movementType = 'adjustment';
      if (validMovementTypes.includes(source)) {
        movementType = source;
      } else if (source === 'order_reservation' || source === 'sale_reservation') {
        movementType = 'sale_reservation';
      } else if (source === 'order_restoration' || source === 'order_cancellation' || source === 'sale_release') {
        movementType = 'sale_release';
      } else if (source === 'legacy_release') {
        movementType = 'legacy_sale_release';
      }

      // Ghi sổ biến động với ON CONFLICT (event_key) DO NOTHING để không hỏng transaction PostgreSQL
      await client.query(
        `INSERT INTO inventory_movements (
           event_key, warehouse_id, variant_id, sku, product_name, variant_name,
           movement_type, delta, quantity_before, quantity_after, reference_type, reference_id, reason, actor_id, actor_username
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (event_key) DO NOTHING`,
        [
          eventKey, targetWarehouseId, variant.id, variant.sku, variant.productName, variant.variantName,
          movementType, delta, currentBalance, newBalance, source, String(eventId || ''),
          reason, actor?.id || null, actor?.username || 'system'
        ]
      );

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
      // Khi không có bất kỳ kho nào trong CSDL (môi trường mock hoặc đơn giản hóa)
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
   * Khấu trừ tồn kho khi tạo đơn hàng mới (ưu tiên tạo phân bổ kho chuẩn qua order_stock_allocations)
   */
  static async reserveOrderStock(client, { items, orderId, actor }) {
    if (!items || !items.length) return;
    const inv = require('../../inventory');

    for (const item of items) {
      const variantId = item.id || item.variantId;
      let hasWarehouseStock = false;
      if (orderId && variantId) {
        try {
          const whCheck = await client.query(
            `SELECT EXISTS (SELECT 1 FROM warehouse_stock WHERE variant_id = $1) AS present`,
            [variantId]
          );
          hasWarehouseStock = Boolean(whCheck.rows[0]?.present);
        } catch (_) {}
      }

      if (orderId && variantId && hasWarehouseStock) {
        await inv.reserveStock(client, {
          variantId,
          quantity: item.quantity,
          orderId,
          actor: actor || { username: 'customer', source: 'customer' }
        });
      } else {
        await InventoryService.applyMovement(client, {
          source: 'order_reservation',
          variantId,
          sku: item.sku,
          delta: -item.quantity,
          eventId: `reserve:${orderId}:${variantId}`,
          actor: actor || { username: 'customer', source: 'customer' },
          reason: `Đặt hàng ${orderId}`
        });
      }
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

  static async initializeVariantStock(client, params) {
    return require('../../inventory').initializeVariantStock(client, params);
  }

  static async setVariantStock(client, params) {
    return require('../../inventory').setVariantStock(client, params);
  }

  static async reserveStock(client, params) {
    return require('../../inventory').reserveStock(client, params);
  }

  static async releaseOrderStock(client, params) {
    return require('../../inventory').releaseOrderStock(client, params);
  }

  static async adjustWarehouseStock(client, params) {
    return require('../../inventory').adjustWarehouseStock(client, params);
  }

  static async transferStock(client, params) {
    return require('../../inventory').transferStock(client, params);
  }

  static async receiveStock(client, params) {
    return require('../../inventory').receiveStock(client, params);
  }

  /**
   * Hoàn trả tồn kho từ các món của đơn hàng (khi đơn hủy hoặc bị xóa)
   * Tuân thủ phân bổ kho trong order_stock_allocations và chống hoàn trùng
   */
  static async restoreOrderStock(client, { orderId, actor, reason = 'order_cancellation' }) {
    if (!orderId) return [];

    // 1. Kiểm tra các phân bổ kho thực tế trong order_stock_allocations chưa được hoàn trả
    let allocRes = { rows: [] };
    try {
      allocRes = await client.query(
        `SELECT a.variant_id AS "variantId", a.warehouse_id AS "warehouseId", a.quantity, v.sku
         FROM order_stock_allocations a
         JOIN product_variants v ON v.id = a.variant_id
         WHERE a.order_id = $1 AND a.released_at IS NULL
         ORDER BY a.variant_id, a.warehouse_id
         FOR UPDATE OF a`,
        [orderId]
      );
    } catch (_) {}

    const restored = [];
    if (allocRes.rows.length > 0) {
      for (const alloc of allocRes.rows) {
        const res = await InventoryService.applyMovement(client, {
          source: 'sale_release',
          variantId: alloc.variantId,
          sku: alloc.sku,
          warehouseId: alloc.warehouseId,
          delta: alloc.quantity,
          eventId: `release:${orderId}:${alloc.variantId}:${alloc.warehouseId}`,
          actor: actor || { username: 'system' },
          reason: `Hoàn tồn kho phân bổ cho đơn ${orderId}`
        });
        await client.query(
          `UPDATE order_stock_allocations SET released_at = now() WHERE order_id = $1 AND variant_id = $2 AND warehouse_id = $3`,
          [orderId, alloc.variantId, alloc.warehouseId]
        );
        restored.push(res);
      }
    } else {
      // 2. Nếu không có dòng released_at IS NULL: kiểm tra xem đơn này đã từng có allocation nào không
      let anyAlloc = { rows: [{ allocated: false }] };
      try {
        anyAlloc = await client.query(
          `SELECT EXISTS (SELECT 1 FROM order_stock_allocations WHERE order_id = $1) AS allocated`,
          [orderId]
        );
      } catch (_) {}

      if (anyAlloc.rows[0]?.allocated) {
        // Đã được hoàn trả đầy đủ trước đó (chống hoàn trùng!)
        return [];
      }

      // 3. Đơn hàng legacy chưa từng ghi nhận order_stock_allocations
      const itemsRes = await client.query(
        `SELECT i.variant_id AS "variantId", i.sku, i.quantity FROM order_items i WHERE i.order_id = $1 AND i.variant_id IS NOT NULL`,
        [orderId]
      );
      for (const item of (itemsRes.rows || [])) {
        const res = await InventoryService.applyMovement(client, {
          source: 'legacy_release',
          variantId: item.variantId,
          sku: item.sku,
          delta: item.quantity,
          eventId: `legacy-release:${orderId}:${item.variantId}`,
          actor: actor || { username: 'system' },
          reason
        });
        restored.push(res);
      }
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
