'use strict';

/**
 * src/domain/inventory/inventory-service.js
 *
 * Single Source of Truth cho các thao tác ghi sổ và điều chỉnh tồn kho tại GAERU:
 * - Áp dụng biến động tồn kho ghi sổ nguyên tử (applyMovement): ghi/khẳng định khóa sự kiện
 *   duy nhất trong inventory_movements TRƯỚC KHI cập nhật warehouse_stock và product_variants
 * - Khấu trừ kho khi tạo đơn hàng (reserveOrderStock) qua order_stock_allocations
 * - Hoàn tồn kho khi hủy đơn / xóa đơn (restoreOrderStock & releaseOrderStock),
 *   bao gồm cả đơn phân bổ đa kho, chu kỳ khôi phục đơn (reservation_cycle) và đơn hàng cũ (legacy)
 * - Đồng bộ tồn kho đa kênh (omnichannel sync)
 */

const { randomUUID } = require('node:crypto');
const { appendAudit } = require('../../audit');

function normalizeActor(actor, fallbackUsername = 'system', fallbackSource = 'system') {
  if (!actor) return { username: fallbackUsername, source: fallbackSource };
  if (typeof actor === 'string') return { username: actor, source: fallbackSource };
  return {
    ...actor,
    username: actor.username || fallbackUsername,
    source: actor.source || fallbackSource
  };
}

function resolveMovementType(source) {
  const validMovementTypes = [
    'opening',
    'adjustment',
    'transfer_in',
    'transfer_out',
    'sale_reservation',
    'sale_release',
    'legacy_sale_release',
    'purchase_receipt'
  ];
  if (validMovementTypes.includes(source)) return source;
  if (source === 'order_reservation') return 'sale_reservation';
  if (source === 'order_restoration' || source === 'order_cancellation') return 'sale_release';
  if (source === 'legacy_release') return 'legacy_sale_release';
  return 'adjustment';
}

class InventoryService {
  /**
   * Áp dụng biến động tồn kho ghi sổ nguyên tử (Authoritative Ledger-First Movement):
   * 1. Khóa dòng biến thể bằng FOR UPDATE OF v
   * 2. Kiểm tra trước sự kiện trùng lặp (event_key) trong inventory_movements:
   *    - Nếu đã tồn tại và khớp tham số: trả về kết quả idempotent (duplicate: true), KHÔNG sửa tồn kho
   *    - Nếu đã tồn tại nhưng lệch delta/variant/warehouse: chặn 409 Conflict
   * 3. Khóa số dư các kho (FOR UPDATE OF s), đối soát SUM(warehouse_stock) === variant.stock_quantity
   * 4. Ghi nhận dòng biến động vào inventory_movements với ON CONFLICT (event_key) DO NOTHING RETURNING id
   *    NGAY TRƯỚC KHI cập nhật warehouse_stock và product_variants
   * 5. Chỉ khi INSERT vào sổ biến động thành công (claimed === true) mới cập nhật tồn kho thực tế
   */
  static async applyMovement(client, {
    source = 'inventory',
    eventId,
    eventKey: explicitEventKey,
    sku,
    variantId,
    delta = 0,
    warehouseId,
    actor,
    reason = 'Authoritative stock movement',
    referenceType,
    referenceId,
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

    if (delta === 0) {
      return {
        id: variant.id,
        sku: variant.sku,
        name: variant.variantName,
        stockQuantity: variant.stockQuantity,
        duplicate: false,
        noOp: true
      };
    }

    const channelPrefix = metadata.channel ? `${metadata.channel}:` : '';
    const hasEventId = eventId !== undefined && eventId !== null && String(eventId) !== '';
    const deterministicKey = explicitEventKey
      ? String(explicitEventKey)
      : (hasEventId ? `${source}:${channelPrefix}${eventId}:${variant.id}` : null);

    // Bước 1: Kiểm tra sớm tính bất biến sự kiện trong sổ biến động TRƯỚC KHI chạm vào bất kỳ bảng tồn kho nào
    if (deterministicKey) {
      const existingMov = await client.query(
        `SELECT id, warehouse_id AS "warehouseId", variant_id AS "variantId", delta, quantity_after AS "quantityAfter"
         FROM inventory_movements
         WHERE event_key = $1`,
        [deterministicKey]
      );
      if (existingMov.rows.length > 0) {
        const prev = existingMov.rows[0];
        if (
          (prev.variantId && String(prev.variantId) !== String(variant.id)) ||
          Number(prev.delta) !== Number(delta) ||
          (warehouseId && prev.warehouseId && String(prev.warehouseId) !== String(warehouseId))
        ) {
          throw Object.assign(
            new Error(`Mã sự kiện tồn kho "${deterministicKey}" đã tồn tại nhưng thông tin điều chỉnh không khớp bản ghi gốc.`),
            { status: 409 }
          );
        }
        return {
          id: variant.id,
          sku: variant.sku,
          name: variant.variantName,
          stockQuantity: variant.stockQuantity,
          duplicate: true,
          movementId: prev.id
        };
      }
    }

    // Bước 2: Khóa và kiểm tra toàn bộ số dư kho hiện có của biến thể
    const existingStockRes = await client.query(
      `SELECT s.warehouse_id AS "warehouseId", s.quantity, w.code, w.active
       FROM warehouse_stock s
       JOIN warehouses w ON w.id = s.warehouse_id
       WHERE s.variant_id = $1
       ORDER BY CASE WHEN w.code = 'MAIN' THEN 0 ELSE 1 END, s.quantity DESC
       FOR UPDATE OF s`,
      [variant.id]
    );

    if (existingStockRes.rows.length > 0) {
      const sumWarehouse = existingStockRes.rows.reduce((sum, r) => sum + Number(r.quantity), 0);
      if (sumWarehouse !== Number(variant.stockQuantity)) {
        throw Object.assign(
          new Error(`Tồn kho tổng (${variant.stockQuantity}) không khớp tổng số dư các kho (${sumWarehouse}). Cần đối soát trước khi thay đổi.`),
          { status: 409 }
        );
      }
    }

    // Bước 3: Xác định kho đích (targetWarehouseId) - Fail-closed nếu không có kho hợp lệ
    let targetWarehouseId = warehouseId || null;
    if (targetWarehouseId) {
      const whCheck = await client.query(`SELECT id, active FROM warehouses WHERE id = $1 FOR SHARE`, [targetWarehouseId]);
      if (!whCheck.rows[0] || !whCheck.rows[0].active) {
        throw Object.assign(new Error('Kho không tồn tại hoặc đã ngừng hoạt động.'), { status: 409 });
      }
    } else if (existingStockRes.rows.length === 0) {
      const whRes = await client.query(`SELECT id FROM warehouses WHERE code = 'MAIN' AND active = true LIMIT 1`);
      targetWarehouseId = whRes.rows[0]?.id || null;
      if (!targetWarehouseId) {
        const anyWh = await client.query(`SELECT id FROM warehouses WHERE active = true LIMIT 1`);
        targetWarehouseId = anyWh.rows[0]?.id || null;
      }
    } else if (delta < 0) {
      const needed = Math.abs(delta);
      const adequateWh = existingStockRes.rows.find(r => r.active && Number(r.quantity) >= needed);
      if (adequateWh) {
        targetWarehouseId = adequateWh.warehouseId;
      } else {
        const firstActive = existingStockRes.rows.find(r => r.active);
        targetWarehouseId = firstActive ? firstActive.warehouseId : existingStockRes.rows[0]?.warehouseId;
      }
    } else {
      // delta > 0: Ưu tiên kho MAIN đang hoạt động (kể cả khi MAIN chưa có dòng số dư cho biến thể này)
      const mainInRows = existingStockRes.rows.find(r => r.code === 'MAIN' && r.active);
      if (mainInRows) {
        targetWarehouseId = mainInRows.warehouseId;
      } else {
        const mainWhRes = await client.query(`SELECT id FROM warehouses WHERE code = 'MAIN' AND active = true LIMIT 1`);
        if (mainWhRes.rows[0]?.id) {
          targetWarehouseId = mainWhRes.rows[0].id;
        } else {
          const firstActive = existingStockRes.rows.find(r => r.active);
          targetWarehouseId = firstActive ? firstActive.warehouseId : existingStockRes.rows[0]?.warehouseId;
        }
      }
    }

    if (!targetWarehouseId) {
      throw Object.assign(new Error('Không tìm thấy kho hàng hoạt động để ghi sổ tồn kho.'), { status: 409 });
    }

    // Bước 4: Đảm bảo dòng warehouse_stock tồn tại (chỉ mở sổ từ variant.stockQuantity khi chưa có bất kỳ kho nào)
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

    if ((!allowNegative && newBalance < 0) || newBalance < 0) {
      throw Object.assign(
        new Error(`Tồn kho không đủ để trừ (tồn hiện tại: ${currentBalance}, yêu cầu giảm: ${Math.abs(delta)}).`),
        { status: 409 }
      );
    }

    // Bước 5 (BẤT BIẾN P0): Ghi nhận khóa sự kiện vào inventory_movements TRƯỚC KHI cập nhật warehouse_stock!
    // Nếu ON CONFLICT (event_key) DO NOTHING không chèn được dòng mới -> Dừng ngay lập tức, KHÔNG SỬA TỒN KHO!
    const eventKey = deterministicKey || `${source}:${variant.id}:${targetWarehouseId}:${randomUUID()}`;
    const movementType = resolveMovementType(source);
    const normalizedActor = actor ? normalizeActor(actor) : null;

    const movInsert = await client.query(
      `INSERT INTO inventory_movements (
         event_key, warehouse_id, variant_id, sku, product_name, variant_name,
         movement_type, delta, quantity_before, quantity_after, reference_type, reference_id, reason, actor_id, actor_username
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id`,
      [
        eventKey,
        targetWarehouseId,
        variant.id,
        variant.sku,
        variant.productName,
        variant.variantName,
        movementType,
        delta,
        currentBalance,
        newBalance,
        referenceType || source,
        String(referenceId ?? eventId ?? eventKey),
        reason,
        normalizedActor?.id || null,
        normalizedActor?.username || 'system'
      ]
    );

    const claimed = (Array.isArray(movInsert?.rows) && movInsert.rows.length > 0)
      || (typeof movInsert?.rowCount === 'number' && movInsert.rowCount > 0);

    if (!claimed) {
      const conflictRes = await client.query(
        `SELECT id, warehouse_id AS "warehouseId", variant_id AS "variantId", delta
         FROM inventory_movements WHERE event_key = $1`,
        [eventKey]
      );
      if (conflictRes.rows.length > 0) {
        const prev = conflictRes.rows[0];
        if (
          (prev.variantId && String(prev.variantId) !== String(variant.id)) ||
          Number(prev.delta) !== Number(delta) ||
          (warehouseId && prev.warehouseId && String(prev.warehouseId) !== String(warehouseId))
        ) {
          throw Object.assign(
            new Error(`Mã sự kiện tồn kho "${eventKey}" đã tồn tại nhưng thông tin điều chỉnh không khớp bản ghi gốc.`),
            { status: 409 }
          );
        }
      }
      return {
        id: variant.id,
        sku: variant.sku,
        name: variant.variantName,
        stockQuantity: variant.stockQuantity,
        duplicate: true,
        movementId: conflictRes.rows[0]?.id || null
      };
    }

    // Bước 6: Chỉ cập nhật warehouse_stock và tổng tồn product_variants SAU KHI đã giữ khóa sự kiện thành công
    await client.query(
      `UPDATE warehouse_stock SET quantity = $3, updated_at = now() WHERE warehouse_id = $1 AND variant_id = $2`,
      [targetWarehouseId, variant.id, newBalance]
    );

    const sumRes = await client.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS total FROM warehouse_stock WHERE variant_id = $1`,
      [variant.id]
    );
    const finalStock = sumRes.rows[0]?.total ?? newBalance;

    await client.query(
      `UPDATE product_variants SET stock_quantity = $2, updated_at = now() WHERE id = $1`,
      [variant.id, finalStock]
    );

    if (normalizedActor) {
      await appendAudit(client, {
        actor: normalizedActor,
        action: 'inventory.stock.movement',
        entityType: 'product_variant',
        entityId: variant.id,
        metadata: { sku: variant.sku, delta, finalStock, source, eventId, eventKey, reason, ...metadata }
      }).catch(() => {});
    }

    return {
      id: variant.id,
      sku: variant.sku,
      name: variant.variantName,
      stockQuantity: finalStock,
      duplicate: false,
      movementId: movInsert.rows?.[0]?.id || null
    };
  }

  /**
   * Điều chỉnh tồn kho tương thích ngược (adapter gọi applyMovement)
   */
  static async adjustStock(client, {
    variantId,
    sku,
    delta,
    eventId,
    warehouseId,
    reason = 'manual_adjustment',
    actor,
    metadata = {},
    allowNegative = false
  }) {
    return InventoryService.applyMovement(client, {
      source: 'manual_adjustment',
      eventId,
      sku,
      variantId,
      warehouseId,
      delta,
      actor,
      reason,
      allowNegative,
      metadata
    });
  }

  /**
   * Khấu trừ tồn kho khi tạo đơn hàng mới (luôn ưu tiên ghi nhận phân bổ kho chuẩn qua order_stock_allocations)
   */
  static async reserveOrderStock(client, { items, orderId, actor }) {
    if (!items || !items.length) return;
    const inv = require('../../inventory');
    const normalizedActor = normalizeActor(actor, 'customer', 'customer');

    // Gộp các dòng trùng variantId trong cùng một đơn để tránh va chạm khóa phân bổ
    const groupedMap = new Map();
    const rawFallbackItems = [];
    for (const item of items) {
      const vId = item.id || item.variantId;
      if (vId) {
        const existing = groupedMap.get(vId);
        if (existing) {
          existing.quantity += Number(item.quantity) || 0;
        } else {
          groupedMap.set(vId, {
            variantId: vId,
            sku: item.sku,
            quantity: Number(item.quantity) || 0
          });
        }
      } else {
        rawFallbackItems.push(item);
      }
    }

    for (const item of groupedMap.values()) {
      const variantId = item.variantId;
      let hasWarehouseStock = false;
      if (orderId && variantId) {
        const whCheck = await client.query(
          `SELECT EXISTS (SELECT 1 FROM warehouse_stock WHERE variant_id = $1) AS present`,
          [variantId]
        );
        hasWarehouseStock = Boolean(whCheck.rows[0]?.present);
        if (!hasWarehouseStock) {
          // Mở sổ kho MAIN một lần cho biến thể chưa có dòng kho để đảm bảo tạo order_stock_allocations chuẩn
          const varRow = (await client.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variantId])).rows[0];
          if (varRow) {
            await inv.initializeVariantStock(client, {
              variantId,
              quantity: Number(varRow.stock_quantity) || 0,
              actor: normalizedActor
            });
            hasWarehouseStock = true;
          }
        }
      }

      if (orderId && variantId && hasWarehouseStock) {
        await inv.reserveStock(client, {
          variantId,
          quantity: item.quantity,
          orderId,
          actor: normalizedActor
        });
      } else {
        await InventoryService.applyMovement(client, {
          source: 'order_reservation',
          eventKey: orderId ? `reserve:${orderId}:${variantId}` : undefined,
          referenceType: orderId ? 'order' : 'order_reservation',
          referenceId: orderId,
          variantId,
          sku: item.sku,
          delta: -item.quantity,
          actor: normalizedActor,
          reason: `Đặt hàng ${orderId || ''}`.trim()
        });
      }
    }

    for (const item of rawFallbackItems) {
      await InventoryService.applyMovement(client, {
        source: 'order_reservation',
        eventId: orderId ? `${orderId}:${item.sku}` : undefined,
        referenceType: orderId ? 'order' : 'order_reservation',
        referenceId: orderId,
        sku: item.sku,
        delta: -(Number(item.quantity) || 0),
        actor: normalizedActor,
        reason: `Đặt hàng ${orderId || ''}`.trim()
      });
    }

    if (actor && orderId) {
      await appendAudit(client, {
        actor: normalizedActor,
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

  static async releaseOrderStock(client, params = {}) {
    const normalizedActor = normalizeActor(params.actor, 'system', 'system');
    return require('../../inventory').releaseOrderStock(client, { ...params, actor: normalizedActor });
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
   * Hoàn trả tồn kho từ các món của đơn hàng (khi đơn hủy hoặc bị xóa):
   * - Đơn có phân bổ kho: hoàn đúng từng kho theo order_stock_allocations (hỗ trợ cả reservation_cycle)
   * - Đơn đã hoàn hết phân bổ (released_at IS NOT NULL) hoặc đã có bút toán sale_release: chặn hoàn trùng tuyệt đối
   * - Đơn hàng cũ (legacy - trước khi phân kho): gộp SUM(quantity) theo variant_id, hoàn về kho MAIN
   *   với khóa chuẩn `legacy-release:${orderId}:${variantId}` đồng nhất 100% với src/inventory.js
   */
  static async restoreOrderStock(client, { orderId, actor, reason = 'order_cancellation' }) {
    if (!orderId) return [];
    const normalizedActor = normalizeActor(actor, 'system', 'system');

    // 1. Kiểm tra các phân bổ kho thực tế trong order_stock_allocations chưa được hoàn trả
    const allocRes = await client.query(
      `SELECT a.variant_id AS "variantId",
              a.warehouse_id AS "warehouseId",
              a.quantity,
              a.reservation_cycle AS "reservationCycle",
              v.sku
       FROM order_stock_allocations a
       JOIN product_variants v ON v.id = a.variant_id
       WHERE a.order_id = $1 AND a.released_at IS NULL
       ORDER BY a.variant_id, a.warehouse_id
       FOR UPDATE OF a`,
      [orderId]
    );

    const restored = [];
    if (allocRes.rows.length > 0) {
      for (const alloc of allocRes.rows) {
        const cycleSuffix = alloc.reservationCycle ? `:cycle:${alloc.reservationCycle}` : '';
        const allocEventKey = `release:${orderId}:${alloc.variantId}:${alloc.warehouseId}${cycleSuffix}`;

        const res = await InventoryService.applyMovement(client, {
          source: 'sale_release',
          eventKey: allocEventKey,
          referenceType: 'order',
          referenceId: orderId,
          variantId: alloc.variantId,
          sku: alloc.sku,
          warehouseId: alloc.warehouseId,
          delta: alloc.quantity,
          actor: normalizedActor,
          reason: `Hoàn tồn kho phân bổ cho đơn ${orderId}`
        });

        await client.query(
          `UPDATE order_stock_allocations
           SET released_at = now()
           WHERE order_id = $1 AND variant_id = $2 AND warehouse_id = $3 AND released_at IS NULL`,
          [orderId, alloc.variantId, alloc.warehouseId]
        );

        if (!res.duplicate) {
          restored.push(res);
        }
      }
    } else {
      // 2. Nếu không có dòng released_at IS NULL: kiểm tra xem đơn này đã từng có allocation nào không
      const anyAlloc = await client.query(
        `SELECT EXISTS (SELECT 1 FROM order_stock_allocations WHERE order_id = $1) AS allocated`,
        [orderId]
      );
      if (anyAlloc.rows[0]?.allocated) {
        // Tất cả phân bổ của đơn đã được hoàn trả trước đó -> chống hoàn trùng
        return [];
      }

      // 3. Phòng vệ trường hợp bảng order_stock_allocations đã bị dọn dẹp nhưng sổ cái đã từng ghi sale_release cho đơn này
      const priorSaleRelease = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM inventory_movements
           WHERE reference_type = 'order'
             AND reference_id = $1
             AND movement_type = 'sale_release'
         ) AS released`,
        [String(orderId)]
      );
      if (priorSaleRelease.rows[0]?.released) {
        return [];
      }

      // 4. Đường hoàn kho đơn hàng cũ (Legacy Order):
      //    - Gộp SUM(quantity) theo variant_id để không va chạm event_key khi đơn cũ có nhiều dòng cùng biến thể
      //    - Bỏ qua các dòng biến thể đã bị xóa (variant_id IS NULL) nhưng ghi nhận số dòng bỏ qua vào audit
      //    - Dùng đúng khóa chuẩn `legacy-release:${orderId}:${variantId}` và kho MAIN đồng nhất với src/inventory.js
      const itemsRes = await client.query(
        `SELECT i.variant_id AS "variantId",
                MAX(i.sku) AS sku,
                SUM(i.quantity)::int AS quantity
         FROM order_items i
         WHERE i.order_id = $1 AND i.variant_id IS NOT NULL AND i.quantity > 0
         GROUP BY i.variant_id
         ORDER BY i.variant_id`,
        [orderId]
      );
      const skippedRes = await client.query(
        `SELECT COUNT(*)::int AS count FROM order_items WHERE order_id = $1 AND variant_id IS NULL`,
        [orderId]
      );
      const skippedDeletedVariantLines = Number(skippedRes.rows[0]?.count) || 0;

      if (itemsRes.rows.length > 0) {
        const mainWhRes = await client.query(
          `SELECT id FROM warehouses WHERE code = 'MAIN' AND active = true LIMIT 1`
        );
        const mainWarehouseId = mainWhRes.rows[0]?.id;
        if (!mainWarehouseId) {
          throw Object.assign(new Error('Kho chính chưa sẵn sàng để hoàn tồn đơn hàng cũ.'), { status: 409 });
        }

        const legacyReason = reason === 'order_cancellation'
          ? 'Đơn trước khi phân kho; hoàn về Kho tổng theo quy tắc chuyển đổi'
          : reason;

        for (const item of itemsRes.rows) {
          const legacyEventKey = `legacy-release:${orderId}:${item.variantId}`;
          const res = await InventoryService.applyMovement(client, {
            source: 'legacy_sale_release',
            eventKey: legacyEventKey,
            referenceType: 'order',
            referenceId: orderId,
            variantId: item.variantId,
            sku: item.sku,
            warehouseId: mainWarehouseId,
            delta: item.quantity,
            actor: normalizedActor,
            reason: legacyReason
          });
          if (!res.duplicate) {
            restored.push(res);
          }
        }
      }

      if ((restored.length > 0 || skippedDeletedVariantLines > 0) && actor) {
        await appendAudit(client, {
          actor: normalizedActor,
          action: 'inventory.stock.restore_order',
          entityType: 'order',
          entityId: orderId,
          metadata: {
            restoredCount: restored.length,
            skippedDeletedVariantLines,
            policy: 'legacy_order_release_to_main',
            reason
          }
        }).catch(() => {});
      }

      return restored;
    }

    if (actor && restored.length > 0) {
      await appendAudit(client, {
        actor: normalizedActor,
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
