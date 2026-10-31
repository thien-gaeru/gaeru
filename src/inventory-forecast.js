'use strict';
const { Router } = require('express');
const { AdminAction } = require('./admin-action');

async function getInventoryForecast(pool) {
  // 1. Fetch 30-day sales velocity from order_items
  const salesQuery = await pool.query(
    `SELECT oi.product_name AS "productName",
            COALESCE(SUM(oi.quantity), 0)::int AS "totalSold30d"
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.created_at >= now() - interval '30 days'
       AND o.status NOT IN ('cancelled')
     GROUP BY oi.product_name`
  );
  const salesMap = new Map();
  for (const row of salesQuery.rows) {
    salesMap.set(row.productName, row.totalSold30d);
  }

  // 2. Fetch current active variants and stock
  const variantsQuery = await pool.query(
    `SELECT v.id, v.sku, v.name AS "variantName", v.stock_quantity AS "stock",
            p.name AS "productName", p.slug AS "productSlug"
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     WHERE v.active = true AND p.active = true
     ORDER BY p.name, v.name`
  );

  // 3. Fetch custom reorder points overrides
  const ropConfigQuery = await pool.query(
    `SELECT * FROM inventory_reorder_points`
  );
  const ropConfigMap = new Map();
  for (const cfg of ropConfigQuery.rows) {
    ropConfigMap.set(cfg.sku, cfg);
  }

  // 4. Compute forecast metrics for each SKU
  const forecastList = variantsQuery.rows.map(v => {
    const sold30d = salesMap.get(v.productName) || 0;
    const dailyVelocity = parseFloat((sold30d / 30).toFixed(2));
    const effectiveVelocity = Math.max(0.1, dailyVelocity);

    const cfg = ropConfigMap.get(v.sku) || {};
    const leadTimeDays = cfg.lead_time_days || 7;
    const safetyStock = cfg.safety_stock_units || 5;
    const minOrderQty = cfg.min_order_qty || 10;

    // ROP formula: (Velocity * LeadTime) + SafetyStock
    const calculatedRop = Math.ceil(effectiveVelocity * leadTimeDays + safetyStock);
    const reorderPoint = cfg.manual_override_rop !== null && cfg.manual_override_rop !== undefined
      ? cfg.manual_override_rop
      : calculatedRop;

    const currentStock = Number(v.stock) || 0;
    const daysRemaining = dailyVelocity > 0 ? Math.floor(currentStock / dailyVelocity) : 999;

    let urgency = 'healthy';
    let statusText = 'Tồn kho an toàn';
    if (currentStock <= 0) {
      urgency = 'out_of_stock';
      statusText = 'HẾT HÀNG';
    } else if (daysRemaining <= 3 || currentStock <= Math.ceil(reorderPoint * 0.4)) {
      urgency = 'critical';
      statusText = 'Cấp bách (Hết trong 1-3 ngày)';
    } else if (currentStock <= reorderPoint) {
      urgency = 'reorder_needed';
      statusText = 'Cần nhập thêm';
    }

    const suggestedReorderQty = ['out_of_stock', 'critical', 'reorder_needed'].includes(urgency)
      ? Math.max(minOrderQty, reorderPoint * 2 - currentStock)
      : 0;

    return {
      sku: v.sku || `SKU-${v.id.slice(0, 8)}`,
      productName: v.productName,
      variantName: v.variantName,
      productSlug: v.productSlug,
      currentStock,
      sold30d,
      dailyVelocity,
      leadTimeDays,
      safetyStock,
      reorderPoint,
      daysRemaining: daysRemaining === 999 ? 'N/A' : daysRemaining,
      urgency,
      statusText,
      suggestedReorderQty
    };
  });

  const criticalCount = forecastList.filter(f => ['out_of_stock', 'critical'].includes(f.urgency)).length;
  const warningCount = forecastList.filter(f => f.urgency === 'reorder_needed').length;

  return {
    forecastList,
    summary: {
      totalSkus: forecastList.length,
      criticalCount,
      warningCount,
      healthyCount: forecastList.length - criticalCount - warningCount,
      hasReorderRecommendations: criticalCount + warningCount > 0
    }
  };
}

function createInventoryForecastAdmin(pool) {
  const router = Router();

  router.get('/inventory/forecast', AdminAction('inventory.read'), async (_req, res, next) => {
    try {
      const data = await getInventoryForecast(pool);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.post('/inventory/reorder-settings', AdminAction('inventory.write'), async (req, res, next) => {
    try {
      const { sku, productName, leadTimeDays, safetyStockUnits, minOrderQty, manualOverrideRop } = req.body || {};
      if (!sku) return res.status(400).json({ error: 'Thiếu SKU' });

      await pool.query(
        `INSERT INTO inventory_reorder_points (sku, product_name, lead_time_days, safety_stock_units, min_order_qty, manual_override_rop, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (sku) DO UPDATE SET
           product_name = EXCLUDED.product_name,
           lead_time_days = EXCLUDED.lead_time_days,
           safety_stock_units = EXCLUDED.safety_stock_units,
           min_order_qty = EXCLUDED.min_order_qty,
           manual_override_rop = EXCLUDED.manual_override_rop,
           updated_at = now()`,
        [
          sku,
          productName || sku,
          Number(leadTimeDays) || 7,
          Number(safetyStockUnits) || 5,
          Number(minOrderQty) || 10,
          manualOverrideRop !== undefined && manualOverrideRop !== '' ? Number(manualOverrideRop) : null
        ]
      );

      res.json({ success: true, message: 'Đã lưu cấu hình ROP cho SKU: ' + sku });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  getInventoryForecast,
  createInventoryForecastAdmin
};
