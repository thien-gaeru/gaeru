'use strict';

const { z } = require('zod');
const { withTransaction } = require('./db');

/**
 * Memory cache for Inventory Forecast calculations with TTL
 */
class ForecastCache {
  constructor(defaultTtlMs = 300_000) {
    this.cache = new Map();
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return item.data;
  }

  set(key, data, ttlMs = this.defaultTtlMs) {
    this.cache.set(key, {
      data,
      cachedAt: new Date().toISOString(),
      expiresAt: Date.now() + ttlMs
    });
  }

  invalidate(prefix = '') {
    if (!prefix) {
      this.cache.clear();
      return;
    }
    for (const key of this.cache.keys()) {
      if (key.includes(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

const globalForecastCache = new ForecastCache(300_000); // 5 mins default

function round(val, decimals = 2) {
  if (val === null || val === undefined || isNaN(val)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

const reorderSettingsSchema = z.object({
  warehouseId: z.string().uuid(),
  variantId: z.string().uuid(),
  leadTimeDays: z.number().int().min(1).max(365).default(7),
  safetyStockDays: z.number().int().min(0).max(365).default(7),
  manualSafetyStock: z.number().int().min(0).nullable().optional(),
  manualReorderPoint: z.number().int().min(0).nullable().optional(),
  minOrderQuantity: z.number().int().min(1).max(1_000_000).default(1),
  targetStockDays: z.number().int().min(1).max(365).default(30)
});

/**
 * Query sales velocity per warehouse and variant over a given period in days.
 */
async function getSalesVelocityMap(pool, days = 30, warehouseId = null) {
  const periodDays = Math.max(1, parseInt(days, 10) || 30);
  const params = [periodDays];
  let whFilterOsa = '';
  let whFilterIm = '';

  if (warehouseId) {
    params.push(warehouseId);
    whFilterOsa = `AND osa.warehouse_id = $2`;
    whFilterIm = `AND im.warehouse_id = $2`;
  }

  // Aggregate sales from order_stock_allocations and inventory_movements
  const query = `
    WITH osa_sales AS (
      SELECT
        osa.warehouse_id,
        osa.variant_id,
        COALESCE(SUM(osa.quantity), 0)::integer AS sold_units
      FROM order_stock_allocations osa
      JOIN orders o ON o.id = osa.order_id
      WHERE o.status NOT IN ('cancelled', 'refunded')
        AND o.created_at >= now() - ($1 || ' days')::interval
        ${whFilterOsa}
      GROUP BY osa.warehouse_id, osa.variant_id
    ),
    im_sales AS (
      SELECT
        im.warehouse_id,
        im.variant_id,
        COALESCE(SUM(ABS(im.delta)), 0)::integer AS sold_units
      FROM inventory_movements im
      WHERE im.movement_type = 'sale_reservation'
        AND im.created_at >= now() - ($1 || ' days')::interval
        ${whFilterIm}
      GROUP BY im.warehouse_id, im.variant_id
    )
    SELECT
      COALESCE(o.warehouse_id, m.warehouse_id) AS "warehouseId",
      COALESCE(o.variant_id, m.variant_id) AS "variantId",
      GREATEST(COALESCE(o.sold_units, 0), COALESCE(m.sold_units, 0)) AS "soldUnits"
    FROM osa_sales o
    FULL OUTER JOIN im_sales m
      ON o.warehouse_id = m.warehouse_id AND o.variant_id = m.variant_id
  `;

  const rows = (await pool.query(query, params)).rows;
  const map = new Map();
  for (const row of rows) {
    const key = `${row.warehouseId}:${row.variantId}`;
    const sold = Number(row.soldUnits) || 0;
    const velocity = round(sold / periodDays, 2);
    map.set(key, { soldUnits: sold, velocity });
  }
  return map;
}

/**
 * Query incoming stock from open purchase orders
 */
async function getIncomingStockMap(pool, warehouseId = null) {
  const params = [];
  let whFilter = '';
  if (warehouseId) {
    params.push(warehouseId);
    whFilter = 'AND po.warehouse_id = $1';
  }

  const query = `
    SELECT
      po.warehouse_id AS "warehouseId",
      poi.variant_id AS "variantId",
      COALESCE(SUM(GREATEST(0, poi.ordered_quantity - poi.received_quantity)), 0)::integer AS "incomingUnits"
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    WHERE po.status IN ('submitted', 'approved', 'partially_received')
      ${whFilter}
    GROUP BY po.warehouse_id, poi.variant_id
  `;

  const rows = (await pool.query(query, params)).rows;
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.warehouseId}:${row.variantId}`, Number(row.incomingUnits) || 0);
  }
  return map;
}

/**
 * Query inventory reorder settings for warehouses and variants
 */
async function getReorderSettingsMap(pool, warehouseId = null) {
  const params = [];
  let whFilter = '';
  if (warehouseId) {
    params.push(warehouseId);
    whFilter = 'WHERE warehouse_id = $1';
  }

  const query = `
    SELECT
      warehouse_id AS "warehouseId",
      variant_id AS "variantId",
      lead_time_days AS "leadTimeDays",
      safety_stock_days AS "safetyStockDays",
      manual_safety_stock AS "manualSafetyStock",
      manual_reorder_point AS "manualReorderPoint",
      min_order_quantity AS "minOrderQuantity",
      target_stock_days AS "targetStockDays",
      updated_at AS "updatedAt"
    FROM inventory_reorder_settings
    ${whFilter}
  `;

  try {
    const rows = (await pool.query(query, params)).rows;
    const map = new Map();
    for (const r of rows) {
      map.set(`${r.warehouseId}:${r.variantId}`, r);
    }
    return map;
  } catch (err) {
    // If table not migrated yet in some test harnesses
    return new Map();
  }
}

/**
 * Calculate full inventory forecast & reorder points
 */
async function calculateInventoryForecast(pool, {
  warehouseId = null,
  days = 30,
  search = '',
  status = null,
  useCache = true
} = {}) {
  const periodDays = Math.max(1, parseInt(days, 10) || 30);
  const cacheKey = `forecast:${warehouseId || 'all'}:${periodDays}:${search || ''}:${status || 'all'}`;

  if (useCache) {
    const cached = globalForecastCache.get(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  // 1. Fetch active warehouses
  const whQuery = warehouseId
    ? `SELECT id, code, name, active FROM warehouses WHERE id = $1 AND active = true`
    : `SELECT id, code, name, active FROM warehouses WHERE active = true ORDER BY (code = 'MAIN') DESC, name ASC`;
  const whParams = warehouseId ? [warehouseId] : [];
  const warehouses = (await pool.query(whQuery, whParams)).rows;
  if (!warehouses.length && warehouseId) {
    throw Object.assign(new Error('Kho không tồn tại hoặc đã ngừng hoạt động.'), { status: 404 });
  }

  // 2. Fetch variants and current stock across these warehouses
  const variantParams = [];
  let whFilter = '';
  if (warehouseId) {
    variantParams.push(warehouseId);
    whFilter = `AND w.id = $${variantParams.length}`;
  }
  let searchCondition = '';
  if (search && search.trim()) {
    variantParams.push(`%${search.trim().toLowerCase()}%`);
    searchCondition = `AND (lower(p.name) LIKE $${variantParams.length} OR lower(v.name) LIKE $${variantParams.length} OR lower(v.sku) LIKE $${variantParams.length})`;
  }

  const stockQuery = `
    SELECT
      v.id AS "variantId",
      v.sku,
      v.name AS "variantName",
      v.price_vnd AS "priceVnd",
      v.cost_price_vnd AS "costPriceVnd",
      v.image_url AS "imageUrl",
      p.id AS "productId",
      p.name AS "productName",
      p.category,
      w.id AS "warehouseId",
      w.code AS "warehouseCode",
      w.name AS "warehouseName",
      COALESCE(ws.quantity, 0) AS "currentStock"
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    CROSS JOIN warehouses w
    LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id AND ws.variant_id = v.id
    WHERE w.active = true AND v.active = true AND p.deleted_at IS NULL
      ${whFilter}
      ${searchCondition}
    ORDER BY p.name ASC, v.name ASC, w.name ASC
  `;

  const stockRows = (await pool.query(stockQuery, variantParams)).rows;

  // 3. Fetch velocity, incoming stock, and reorder settings maps in parallel
  const [velocityMap, incomingMap, settingsMap] = await Promise.all([
    getSalesVelocityMap(pool, periodDays, warehouseId),
    getIncomingStockMap(pool, warehouseId),
    getReorderSettingsMap(pool, warehouseId)
  ]);

  // 4. Compute forecast metrics per variant / warehouse
  let totalSkus = 0;
  let outOfStockCount = 0;
  let criticalCount = 0;
  let reorderNeededCount = 0;
  let optimalCount = 0;
  let overstockedCount = 0;
  let totalSuggestedUnits = 0;
  let estimatedTotalCostVnd = 0;
  let totalVelocity = 0;

  const items = [];

  for (const row of stockRows) {
    const key = `${row.warehouseId}:${row.variantId}`;
    const velocityData = velocityMap.get(key) || { soldUnits: 0, velocity: 0 };
    const incomingUnits = incomingMap.get(key) || 0;
    const settings = settingsMap.get(key) || {};

    const dailyVelocity = velocityData.velocity;
    const soldUnits = velocityData.soldUnits;
    const currentStock = Number(row.currentStock) || 0;
    const availableStock = currentStock + incomingUnits;

    const leadTimeDays = settings.leadTimeDays || 7;
    const safetyStockDays = settings.safetyStockDays || 7;
    const minOrderQuantity = settings.minOrderQuantity || 1;
    const targetStockDays = settings.targetStockDays || 30;

    // Formulas
    const leadTimeDemand = round(dailyVelocity * leadTimeDays, 2);
    const calculatedSafetyStock = Math.ceil(dailyVelocity * safetyStockDays);
    const safetyStock = settings.manualSafetyStock != null
      ? settings.manualSafetyStock
      : calculatedSafetyStock;

    const calculatedRop = Math.ceil(leadTimeDemand) + safetyStock;
    const reorderPoint = settings.manualReorderPoint != null
      ? settings.manualReorderPoint
      : calculatedRop;

    // Days of supply
    const daysOfSupply = dailyVelocity > 0
      ? round(currentStock / dailyVelocity, 1)
      : null;

    // Status evaluation
    let alertStatus = 'optimal';
    if (currentStock <= 0) {
      alertStatus = 'out_of_stock';
    } else if (currentStock <= Math.ceil(reorderPoint * 0.4) || (daysOfSupply !== null && daysOfSupply <= 3)) {
      alertStatus = 'critical';
    } else if (currentStock <= reorderPoint) {
      alertStatus = 'reorder_needed';
    } else if (availableStock <= reorderPoint) {
      alertStatus = 'low_stock';
    } else if ((daysOfSupply !== null && daysOfSupply > 90) || (currentStock > Math.max(reorderPoint * 3, 50))) {
      alertStatus = 'overstocked';
    } else {
      alertStatus = 'optimal';
    }

    // Suggested order quantity
    let suggestedOrderQuantity = 0;
    if (availableStock <= reorderPoint) {
      const targetStock = Math.ceil(dailyVelocity * targetStockDays) + safetyStock;
      const needed = targetStock - availableStock;
      suggestedOrderQuantity = Math.max(minOrderQuantity, Math.max(needed, reorderPoint - availableStock + 1));
    }

    // Estimated reorder cost
    const unitCost = Number(row.costPriceVnd) || Math.round(Number(row.priceVnd) * 0.6) || 0;
    const estimatedCostVnd = suggestedOrderQuantity * unitCost;

    const item = {
      variantId: row.variantId,
      sku: row.sku,
      variantName: row.variantName,
      productId: row.productId,
      productName: row.productName,
      category: row.category,
      imageUrl: row.imageUrl,
      warehouseId: row.warehouseId,
      warehouseCode: row.warehouseCode,
      warehouseName: row.warehouseName,
      priceVnd: Number(row.priceVnd),
      costPriceVnd: unitCost,
      periodDays,
      soldUnits,
      salesVelocity: dailyVelocity,
      currentStock,
      incomingStock: incomingUnits,
      availableStock,
      leadTimeDays,
      safetyStockDays,
      safetyStock,
      reorderPoint,
      daysOfSupply,
      status: alertStatus,
      suggestedOrderQuantity,
      estimatedCostVnd,
      hasCustomSettings: Boolean(settings.leadTimeDays || settings.manualReorderPoint != null),
      settings: {
        leadTimeDays,
        safetyStockDays,
        manualSafetyStock: settings.manualSafetyStock ?? null,
        manualReorderPoint: settings.manualReorderPoint ?? null,
        minOrderQuantity,
        targetStockDays
      }
    };

    // Filter by status if specified
    if (status && status !== 'all') {
      if (status === 'reorder_needed' && !['out_of_stock', 'critical', 'reorder_needed'].includes(alertStatus)) {
        continue;
      } else if (status !== 'reorder_needed' && alertStatus !== status) {
        continue;
      }
    }

    // Tally metrics
    totalSkus++;
    totalVelocity += dailyVelocity;
    if (alertStatus === 'out_of_stock') outOfStockCount++;
    else if (alertStatus === 'critical') criticalCount++;
    else if (alertStatus === 'reorder_needed' || alertStatus === 'low_stock') reorderNeededCount++;
    else if (alertStatus === 'optimal') optimalCount++;
    else if (alertStatus === 'overstocked') overstockedCount++;

    totalSuggestedUnits += suggestedOrderQuantity;
    estimatedTotalCostVnd += estimatedCostVnd;

    items.push(item);
  }

  const result = {
    periodDays,
    warehouseId: warehouseId || null,
    metrics: {
      totalSkus,
      outOfStockCount,
      criticalCount,
      reorderNeededCount: reorderNeededCount + outOfStockCount + criticalCount,
      optimalCount,
      overstockedCount,
      totalSuggestedUnits,
      estimatedTotalCostVnd,
      averageSalesVelocity: round(totalSkus ? totalVelocity / totalSkus : 0, 2)
    },
    warehouses,
    items,
    cached: false,
    generatedAt: new Date().toISOString()
  };

  // Cache result for 5 minutes
  globalForecastCache.set(cacheKey, result);

  return result;
}

/**
 * Get multi-period forecast detail for a single variant across all warehouses
 */
async function getVariantForecastDetail(pool, variantId, { days = 30 } = {}) {
  const variant = (await pool.query(
    `SELECT v.id, v.sku, v.name AS "variantName", v.price_vnd AS "priceVnd", v.cost_price_vnd AS "costPriceVnd",
            v.image_url AS "imageUrl", p.id AS "productId", p.name AS "productName", p.category
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     WHERE v.id = $1 AND p.deleted_at IS NULL`,
    [variantId]
  )).rows[0];

  if (!variant) {
    throw Object.assign(new Error('Không tìm thấy phiên bản sản phẩm.'), { status: 404 });
  }

  const periods = [7, 14, 30, 90];
  const velocityByPeriod = {};

  for (const p of periods) {
    const vMap = await getSalesVelocityMap(pool, p);
    let totalSold = 0;
    for (const [key, val] of vMap.entries()) {
      if (key.endsWith(`:${variantId}`)) {
        totalSold += val.soldUnits;
      }
    }
    velocityByPeriod[`${p}d`] = {
      periodDays: p,
      soldUnits: totalSold,
      velocity: round(totalSold / p, 2)
    };
  }

  // Current stock per warehouse
  const whStock = (await pool.query(
    `SELECT w.id AS "warehouseId", w.code AS "warehouseCode", w.name AS "warehouseName",
            COALESCE(ws.quantity, 0) AS "currentStock",
            irs.lead_time_days AS "leadTimeDays",
            irs.safety_stock_days AS "safetyStockDays",
            irs.manual_reorder_point AS "manualReorderPoint",
            irs.manual_safety_stock AS "manualSafetyStock",
            irs.min_order_quantity AS "minOrderQuantity",
            irs.target_stock_days AS "targetStockDays"
     FROM warehouses w
     LEFT JOIN warehouse_stock ws ON ws.warehouse_id = w.id AND ws.variant_id = $1
     LEFT JOIN inventory_reorder_settings irs ON irs.warehouse_id = w.id AND irs.variant_id = $1
     WHERE w.active = true
     ORDER BY (w.code = 'MAIN') DESC, w.name ASC`,
    [variantId]
  )).rows;

  const incomingMap = await getIncomingStockMap(pool);
  const velocity30 = velocityByPeriod['30d'].velocity;

  const warehousesBreakdown = whStock.map(wh => {
    const key = `${wh.warehouseId}:${variantId}`;
    const incomingStock = incomingMap.get(key) || 0;
    const currentStock = Number(wh.currentStock) || 0;
    const availableStock = currentStock + incomingStock;
    const leadTimeDays = wh.leadTimeDays || 7;
    const safetyStockDays = wh.safetyStockDays || 7;
    const calculatedRop = Math.ceil(velocity30 * leadTimeDays) + Math.ceil(velocity30 * safetyStockDays);
    const reorderPoint = wh.manualReorderPoint != null ? wh.manualReorderPoint : calculatedRop;

    return {
      warehouseId: wh.warehouseId,
      warehouseCode: wh.warehouseCode,
      warehouseName: wh.warehouseName,
      currentStock,
      incomingStock,
      availableStock,
      reorderPoint,
      leadTimeDays,
      safetyStockDays,
      manualReorderPoint: wh.manualReorderPoint,
      manualSafetyStock: wh.manualSafetyStock,
      daysOfSupply: velocity30 > 0 ? round(currentStock / velocity30, 1) : null
    };
  });

  return {
    variant: {
      id: variant.id,
      sku: variant.sku,
      variantName: variant.variantName,
      productId: variant.productId,
      productName: variant.productName,
      category: variant.category,
      imageUrl: variant.imageUrl,
      priceVnd: Number(variant.priceVnd),
      costPriceVnd: Number(variant.costPriceVnd) || Math.round(Number(variant.priceVnd) * 0.6)
    },
    velocityByPeriod,
    warehousesBreakdown
  };
}

/**
 * Configure ROP and Lead time parameters for a variant in a warehouse
 */
async function upsertReorderSettings(pool, data) {
  const parsed = reorderSettingsSchema.parse(data);

  const query = `
    INSERT INTO inventory_reorder_settings (
      warehouse_id, variant_id, lead_time_days, safety_stock_days,
      manual_safety_stock, manual_reorder_point, min_order_quantity, target_stock_days, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
    ON CONFLICT (warehouse_id, variant_id)
    DO UPDATE SET
      lead_time_days = EXCLUDED.lead_time_days,
      safety_stock_days = EXCLUDED.safety_stock_days,
      manual_safety_stock = EXCLUDED.manual_safety_stock,
      manual_reorder_point = EXCLUDED.manual_reorder_point,
      min_order_quantity = EXCLUDED.min_order_quantity,
      target_stock_days = EXCLUDED.target_stock_days,
      updated_at = now()
    RETURNING
      id, warehouse_id AS "warehouseId", variant_id AS "variantId",
      lead_time_days AS "leadTimeDays", safety_stock_days AS "safetyStockDays",
      manual_safety_stock AS "manualSafetyStock", manual_reorder_point AS "manualReorderPoint",
      min_order_quantity AS "minOrderQuantity", target_stock_days AS "targetStockDays",
      updated_at AS "updatedAt"
  `;

  const values = [
    parsed.warehouseId,
    parsed.variantId,
    parsed.leadTimeDays,
    parsed.safetyStockDays,
    parsed.manualSafetyStock ?? null,
    parsed.manualReorderPoint ?? null,
    parsed.minOrderQuantity,
    parsed.targetStockDays
  ];

  const result = (await pool.query(query, values)).rows[0];

  // Invalidate cache for this warehouse
  globalForecastCache.invalidate(parsed.warehouseId);
  globalForecastCache.invalidate('all');

  return result;
}

/**
 * Batch create a purchase order directly from forecast ROP recommendations
 */
async function createPurchaseOrderFromForecast(pool, {
  supplierId,
  warehouseId,
  items,
  reference = '',
  note = '',
  actor
}) {
  if (!supplierId || !warehouseId) {
    throw Object.assign(new Error('Vui lòng chọn nhà cung cấp và kho nhận hàng.'), { status: 400 });
  }
  if (!Array.isArray(items) || !items.length) {
    throw Object.assign(new Error('Danh sách đặt hàng không được để trống.'), { status: 400 });
  }

  return await withTransaction(pool, async (client) => {
    // 1. Verify supplier
    const supplier = (await client.query(
      `SELECT id, name FROM suppliers WHERE id = $1 AND active = true`,
      [supplierId]
    )).rows[0];
    if (!supplier) throw Object.assign(new Error('Nhà cung cấp không tồn tại hoặc đã ngừng giao dịch.'), { status: 404 });

    // 2. Verify warehouse
    const warehouse = (await client.query(
      `SELECT id, name FROM warehouses WHERE id = $1 AND active = true`,
      [warehouseId]
    )).rows[0];
    if (!warehouse) throw Object.assign(new Error('Kho hàng không tồn tại hoặc đã ngừng hoạt động.'), { status: 404 });

    // 3. Generate PO number
    const countResult = (await client.query(`SELECT COUNT(*)::integer AS total FROM purchase_orders`)).rows[0];
    const seq = (countResult.total + 1).toString().padStart(5, '0');
    const poNumber = `PO-${new Date().getFullYear()}-${seq}`;

    // 4. Calculate items & total
    let totalVnd = 0;
    const validatedItems = [];

    for (const item of items) {
      const variant = (await client.query(
        `SELECT v.id, v.sku, v.name AS "variantName", v.cost_price_vnd AS "costPriceVnd",
                v.price_vnd AS "priceVnd", p.name AS "productName"
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         WHERE v.id = $1`,
        [item.variantId]
      )).rows[0];

      if (!variant) continue;

      const qty = parseInt(item.quantity, 10);
      if (qty <= 0) continue;

      const unitCost = parseInt(item.unitCostVnd, 10) || Number(variant.costPriceVnd) || Math.round(Number(variant.priceVnd) * 0.6) || 0;
      const lineTotal = qty * unitCost;
      totalVnd += lineTotal;

      validatedItems.push({
        variantId: variant.id,
        sku: variant.sku,
        productName: variant.productName,
        variantName: variant.variantName,
        quantity: qty,
        unitCostVnd: unitCost,
        totalVnd: lineTotal
      });
    }

    if (!validatedItems.length) {
      throw Object.assign(new Error('Không có sản phẩm hợp lệ để lập đơn mua.'), { status: 400 });
    }

    // 5. Insert purchase order
    const po = (await client.query(
      `INSERT INTO purchase_orders (
         number, supplier_id, warehouse_id, supplier_name, reference, note,
         status, total_vnd, created_by, created_by_username
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'submitted', $7, $8, $9)
       RETURNING id, number, status, total_vnd AS "totalVnd", created_at AS "createdAt"`,
      [
        poNumber, supplierId, warehouseId, supplier.name, reference.trim(),
        (note || 'Tự động tạo từ dự báo tồn kho & ROP').trim(),
        totalVnd, actor?.id || null, actor?.username || 'system'
      ]
    )).rows[0];

    // 6. Insert items
    for (const it of validatedItems) {
      await client.query(
        `INSERT INTO purchase_order_items (
           purchase_order_id, variant_id, sku, product_name, variant_name,
           ordered_quantity, received_quantity, unit_cost_vnd, total_cost_vnd
         )
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)`,
        [po.id, it.variantId, it.sku, it.productName, it.variantName, it.quantity, it.unitCostVnd, it.totalVnd]
      );
    }

    // Invalidate cache
    globalForecastCache.invalidate(warehouseId);
    globalForecastCache.invalidate('all');

    return {
      purchaseOrder: po,
      itemsCount: validatedItems.length,
      totalVnd,
      message: `Đã tạo đơn mua hàng ${po.number} thành công từ gợi ý ROP.`
    };
  });
}

/**
 * Express router for Inventory Forecast API
 */
function createInventoryForecastApi(pool) {
  const { Router } = require('express');
  const router = Router();

  function requirePerm(permission) {
    return (req, res, next) => {
      const permissions = req.admin?.permissions || [];
      if (req.admin?.role === 'owner' || req.admin?.role === 'admin' || permissions.includes(permission) || permissions.includes('all')) {
        return next();
      }
      res.status(403).json({ error: 'Bạn không có quyền thực hiện nghiệp vụ này.' });
    };
  }

  // GET /api/gaeru_ceo/inventory/forecast
  router.get(['/forecast', '/inventory/forecast'], requirePerm('inventory.read'), async (req, res, next) => {
    try {
      const warehouseId = req.query.warehouseId || null;
      const days = parseInt(req.query.days, 10) || 30;
      const search = req.query.search || '';
      const status = req.query.status || null;
      const refresh = req.query.refresh === 'true' || req.query.refresh === '1';

      const forecast = await calculateInventoryForecast(pool, {
        warehouseId,
        days,
        search,
        status,
        useCache: !refresh
      });

      res.set('Cache-Control', 'no-store').json(forecast);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  // GET /api/gaeru_ceo/inventory/forecast/variant/:variantId
  router.get(['/forecast/variant/:variantId', '/inventory/forecast/variant/:variantId'], requirePerm('inventory.read'), async (req, res, next) => {
    try {
      const detail = await getVariantForecastDetail(pool, req.params.variantId);
      res.set('Cache-Control', 'no-store').json(detail);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  // PUT /api/gaeru_ceo/inventory/forecast/settings
  router.put(['/forecast/settings', '/inventory/forecast/settings'], requirePerm('inventory.approve'), async (req, res, next) => {
    try {
      const saved = await upsertReorderSettings(pool, req.body);
      res.json({ success: true, settings: saved });
    } catch (err) {
      if (err.name === 'ZodError') {
        return res.status(400).json({ error: 'Dữ liệu cấu hình ROP không hợp lệ.', details: err.errors });
      }
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  // POST /api/gaeru_ceo/inventory/forecast/create-po
  router.post(['/forecast/create-po', '/inventory/forecast/create-po'], requirePerm('purchases.write'), async (req, res, next) => {
    try {
      const result = await createPurchaseOrderFromForecast(pool, {
        supplierId: req.body.supplierId,
        warehouseId: req.body.warehouseId,
        items: req.body.items,
        reference: req.body.reference || '',
        note: req.body.note || '',
        actor: req.admin
      });
      res.status(201).json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  // POST /api/gaeru_ceo/inventory/forecast/clear-cache
  router.post(['/forecast/clear-cache', '/inventory/forecast/clear-cache'], requirePerm('inventory.read'), (_req, res) => {
    globalForecastCache.clear();
    res.json({ success: true, message: 'Đã xóa bộ nhớ đệm dự báo kho.' });
  });

  return router;
}

module.exports = {
  ForecastCache,
  globalForecastCache,
  round,
  getSalesVelocityMap,
  getIncomingStockMap,
  getReorderSettingsMap,
  calculateInventoryForecast,
  getVariantForecastDetail,
  upsertReorderSettings,
  createPurchaseOrderFromForecast,
  createInventoryForecastApi
};
