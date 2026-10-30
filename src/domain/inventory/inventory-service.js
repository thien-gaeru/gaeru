'use strict';

/**
 * src/domain/inventory/inventory-service.js
 * 
 * Single Source of Truth cho các thao tác ghi sổ và điều chỉnh tồn kho tại GAERU:
 * - Trừ kho khi đặt hàng (reserveOrderStock)
 * - Hoàn tồn kho khi hủy đơn / xóa đơn (restoreOrderStock)
 * - Đồng bộ tồn kho từ webhook đa kênh (syncOmnichannelStock)
 * - Khóa và cập nhật biến thể có audit trail
 */

const { appendAudit } = require('../../audit');

class InventoryService {
  /**
   * Điều chỉnh tồn kho của biến thể theo SKU hoặc Variant ID
   */
  static async adjustStock(client, { variantId, sku, delta, reason = 'manual_adjustment', actor, metadata = {} }) {
    if (!variantId && !sku) {
      throw new Error('Yêu cầu variantId hoặc sku để điều chỉnh tồn kho.');
    }

    let queryText;
    let params;

    if (variantId) {
      queryText = `UPDATE product_variants 
                   SET stock_quantity = GREATEST(0, stock_quantity + $1), updated_at = now() 
                   WHERE id = $2 
                   RETURNING id, sku, name, stock_quantity AS "stockQuantity"`;
      params = [delta, variantId];
    } else {
      queryText = `UPDATE product_variants 
                   SET stock_quantity = GREATEST(0, stock_quantity + $1), updated_at = now() 
                   WHERE sku = $2 
                   RETURNING id, sku, name, stock_quantity AS "stockQuantity"`;
      params = [delta, sku];
    }

    const res = await client.query(queryText, params);
    const row = res.rows[0];

    if (row && actor) {
      await appendAudit(client, {
        actor,
        action: 'inventory.stock.adjust',
        entityType: 'product_variant',
        entityId: row.id,
        metadata: { sku: row.sku, delta, reason, newStock: row.stockQuantity, ...metadata }
      }).catch(() => {});
    }

    return row || null;
  }

  /**
   * Khấu trừ tồn kho khi tạo đơn hàng mới
   */
  static async reserveOrderStock(client, { items, orderId, actor }) {
    if (!items || !items.length) return;

    for (const item of items) {
      await client.query(
        `UPDATE product_variants 
         SET stock_quantity = stock_quantity - $2, updated_at = now() 
         WHERE id = $1`,
        [item.id, item.quantity]
      );
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
    if (!orderId) return;

    const res = await client.query(
      `UPDATE product_variants v 
       SET stock_quantity = v.stock_quantity + i.quantity, updated_at = now() 
       FROM order_items i 
       WHERE i.order_id = $1 AND i.variant_id = v.id 
       RETURNING v.id, v.sku, i.quantity`,
      [orderId]
    );

    if (actor && res.rows?.length) {
      await appendAudit(client, {
        actor,
        action: 'inventory.stock.restore_order',
        entityType: 'order',
        entityId: orderId,
        metadata: { restoredCount: res.rows.length, reason }
      }).catch(() => {});
    }

    return res.rows || [];
  }
}

module.exports = {
  InventoryService
};
