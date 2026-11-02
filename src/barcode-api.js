const { Router } = require("express");
const { z } = require("zod");
const { withTransaction } = require("./db");
const { requirePermission } = require("./staff-access");
const { requireCsrf } = require("./security");
const { appendAudit } = require("./audit");
const { rateLimit } = require("express-rate-limit");

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// -------------------------------------------------------------
// Pure JavaScript Code 128 (Subset B) Barcode Generator
// Standard 107 pattern table (modules widths: Bar-Space-Bar-Space-Bar-Space)
// -------------------------------------------------------------
const CODE128_PATTERNS = Object.freeze([
  [2,1,2,2,2,2], [2,2,2,1,2,2], [2,2,2,2,2,1], [1,2,1,2,2,3], [1,2,1,3,2,2], [1,3,1,2,2,2], [1,2,2,2,1,3],
  [1,2,2,3,1,2], [1,3,2,2,1,2], [2,2,1,2,1,3], [2,2,1,3,1,2], [2,3,1,2,1,2], [1,1,2,2,3,2], [1,2,2,1,3,2],
  [1,2,2,2,3,1], [1,1,3,2,2,2], [1,2,3,1,2,2], [1,2,3,2,2,1], [2,2,3,2,1,1], [2,2,1,1,3,2], [2,2,1,2,3,1],
  [2,1,3,2,1,2], [2,2,3,1,1,2], [3,1,2,1,3,1], [3,1,1,2,2,2], [3,2,1,1,2,2], [3,2,1,2,2,1], [3,1,2,2,1,2],
  [3,2,2,1,1,2], [3,2,2,2,1,1], [2,1,2,1,2,3], [2,1,2,3,2,1], [2,3,2,1,2,1], [1,1,1,3,2,3], [1,3,1,1,2,3],
  [1,3,1,3,2,1], [1,1,2,3,1,3], [1,3,2,1,1,3], [1,3,2,3,1,1], [2,1,1,3,1,3], [2,3,1,1,1,3], [2,3,1,3,1,1],
  [1,1,2,1,3,3], [1,1,2,3,3,1], [1,3,2,1,3,1], [1,1,3,1,2,3], [1,1,3,3,2,1], [1,3,3,1,2,1], [3,1,3,1,2,1],
  [2,1,1,3,3,1], [2,3,1,1,3,1], [2,1,3,1,1,3], [2,1,3,3,1,1], [2,1,3,1,3,1], [3,1,1,1,2,3], [3,1,1,3,2,1],
  [3,3,1,1,2,1], [3,1,2,1,1,3], [3,1,2,3,1,1], [3,3,2,1,1,1], [3,1,4,1,1,1], [2,2,1,4,1,1], [4,3,1,1,1,1],
  [1,1,1,2,2,4], [1,1,1,4,2,2], [1,2,1,1,2,4], [1,2,1,4,2,1], [1,4,1,1,2,2], [1,4,1,2,2,1], [1,1,2,2,1,4],
  [1,1,2,4,1,2], [1,2,2,1,1,4], [1,2,2,4,1,1], [1,4,2,1,1,2], [1,4,2,2,1,1], [2,4,1,2,1,1], [2,2,1,1,1,4],
  [4,1,3,1,1,1], [2,4,1,1,1,2], [1,3,4,1,1,1], [1,1,1,2,4,2], [1,2,1,1,4,2], [1,2,1,2,4,1], [1,1,4,2,1,2],
  [1,2,4,1,1,2], [1,2,4,2,1,1], [4,1,1,2,1,2], [4,2,1,1,1,2], [4,2,1,2,1,1], [2,1,2,1,4,1], [2,1,4,1,2,1],
  [4,1,2,1,2,1], [1,1,1,1,4,3], [1,1,1,3,4,1], [1,3,1,1,4,1], [1,1,4,1,1,3], [1,1,4,3,1,1], [4,1,1,1,1,3],
  [4,1,1,3,1,1], [1,1,3,1,4,1], [1,1,4,1,3,1], [3,1,1,1,4,1], [4,1,1,1,3,1], [2,1,1,4,1,2], [2,1,1,2,1,4],
  [2,1,1,2,3,2], [2,3,3,1,1,1,2]
]);

const START_B = 104;
const STOP = 106;

/**
 * Generate clean SVG for Code 128 (Subset B)
 */
function generateCode128Svg(rawText, options = {}) {
  const text = String(rawText || "").trim();
  if (!text) throw fail("Nội dung tạo mã vạch không được để trống", 400);

  const codes = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch < 32 || ch > 126) {
      throw fail(`Ký tự '${text[i]}' không được hỗ trợ trong mã vạch Code 128 B`, 400);
    }
    codes.push(ch - 32);
  }

  // Checksum calculation: Start B (104) + sum(pos * code) modulo 103
  let checksum = START_B;
  for (let i = 0; i < codes.length; i++) {
    checksum += codes[i] * (i + 1);
  }
  const checkDigit = checksum % 103;

  const sequence = [START_B, ...codes, checkDigit, STOP];
  const moduleWidth = Math.max(1, parseInt(options.moduleWidth || 2, 10));
  const barHeight = Math.max(20, parseInt(options.height || 60, 10));
  const quietZone = Math.max(10, parseInt(options.quietZone || 14, 10)) * moduleWidth;
  const includeText = options.includeText !== false && options.includeText !== "false";
  const fontSize = Math.max(11, Math.round(moduleWidth * 6));

  let totalModules = 0;
  for (const sym of sequence) {
    const pattern = CODE128_PATTERNS[sym];
    totalModules += pattern.reduce((a, b) => a + b, 0);
  }

  const svgWidth = totalModules * moduleWidth + quietZone * 2;
  const textHeight = includeText ? fontSize + 8 : 0;
  const svgHeight = barHeight + textHeight + 16;
  const topMargin = 8;

  let currentX = quietZone;
  const rects = [];

  for (const sym of sequence) {
    const pattern = CODE128_PATTERNS[sym];
    let isBar = true;
    for (const w of pattern) {
      const barPixelWidth = w * moduleWidth;
      if (isBar) {
        rects.push(`<rect x="${currentX}" y="${topMargin}" width="${barPixelWidth}" height="${barHeight}" fill="#111827"/>`);
      }
      currentX += barPixelWidth;
      isBar = !isBar;
    }
  }

  const escapedText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const textElem = includeText
    ? `<text x="${svgWidth / 2}" y="${topMargin + barHeight + fontSize + 2}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="${fontSize}px" font-weight="600" text-anchor="middle" fill="#111827">${escapedText}</text>`
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}" role="img" aria-label="Mã vạch ${escapedText}"><rect width="100%" height="100%" fill="#ffffff"/>${rects.join("")}${textElem}</svg>`;

  return { svg, width: svgWidth, height: svgHeight, text };
}

// -------------------------------------------------------------
// Core Barcode Resolver (Unified lookup for SKU, Order, Waybill)
// -------------------------------------------------------------
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveBarcode(pool, rawCode, { actor = null, logScan = true } = {}) {
  const code = String(rawCode || "").trim();
  if (!code) throw fail("Mã vạch quét vào không được để trống", 400);

  // 1. Check Product Variant (by SKU, manufacturer barcode, or ID)
  const isUuid = UUID_REGEX.test(code);
  const variantQuery = `
    SELECT pv.id, pv.product_id, pv.sku, pv.barcode, pv.name AS variant_name, pv.price_vnd, pv.stock_quantity,
           p.name AS product_name, p.slug, p.image_url, p.active AS product_active
    FROM product_variants pv
    JOIN products p ON p.id = pv.product_id
    WHERE pv.sku = $1 OR pv.barcode = $1 ${isUuid ? "OR pv.id = $2" : ""}
    LIMIT 1
  `;
  const variantParams = isUuid ? [code, code] : [code];
  const variantRes = await pool.query(variantQuery, variantParams);

  if (variantRes.rows.length > 0) {
    const v = variantRes.rows[0];
    const stockRes = await pool.query(`
      SELECT ws.warehouse_id, ws.quantity, w.name AS warehouse_name, w.code AS warehouse_code, w.active
      FROM warehouse_stock ws
      JOIN warehouses w ON w.id = ws.warehouse_id
      WHERE ws.variant_id = $1
      ORDER BY w.code
    `, [v.id]);

    const movRes = await pool.query(`
      SELECT id, movement_type, delta, quantity_before, quantity_after, reason, created_at, actor_username
      FROM inventory_movements
      WHERE variant_id = $1
      ORDER BY created_at DESC
      LIMIT 5
    `, [v.id]);

    if (logScan) {
      await pool.query(`
        INSERT INTO barcode_scan_logs (code, entity_type, entity_id, action, quantity, scanned_by, details)
        VALUES ($1, 'sku', $2, 'lookup', 1, $3, $4)
      `, [code, v.id, actor?.username || "scanner", JSON.stringify({ sku: v.sku, name: v.variant_name })]);
    }

    return {
      type: "sku",
      entityId: v.id,
      variant: {
        id: v.id,
        productId: v.product_id,
        sku: v.sku,
        barcode: v.barcode,
        name: v.variant_name,
        priceVnd: v.price_vnd,
        stockQuantity: v.stock_quantity,
        productName: v.product_name,
        imageUrl: v.image_url,
        slug: v.slug
      },
      warehouseStocks: stockRes.rows.map(r => ({
        warehouseId: r.warehouse_id,
        warehouseName: r.warehouse_name,
        warehouseCode: r.warehouse_code,
        quantity: r.quantity,
        active: r.active
      })),
      recentMovements: movRes.rows.map(r => ({
        id: r.id,
        type: r.movement_type,
        delta: r.delta,
        before: r.quantity_before,
        after: r.quantity_after,
        reason: r.reason,
        createdAt: r.created_at,
        actor: r.actor_username
      }))
    };
  }

  // 2. Check Order (by Order Number or ID)
  const orderQuery = `
    SELECT o.id, o.order_number, o.customer_name, o.phone, o.email, o.address, o.city,
           o.status, o.payment_method, o.payment_status, o.subtotal_vnd, o.shipping_fee_vnd, o.total_vnd, o.created_at
    FROM orders o
    WHERE o.order_number = $1 ${isUuid ? "OR o.id = $2" : ""}
    LIMIT 1
  `;
  const orderRes = await pool.query(orderQuery, isUuid ? [code, code] : [code]);

  if (orderRes.rows.length > 0) {
    const o = orderRes.rows[0];
    const itemsRes = await pool.query(`
      SELECT oi.id, oi.variant_id, oi.product_name, oi.variant_name, oi.sku, oi.unit_price_vnd, oi.quantity, oi.line_total_vnd,
             pv.barcode
      FROM order_items oi
      LEFT JOIN product_variants pv ON pv.id = oi.variant_id
      WHERE oi.order_id = $1
      ORDER BY oi.sku
    `, [o.id]);

    // Ensure pack verification record exists
    let verRes = await pool.query(`SELECT * FROM order_pack_verifications WHERE order_id = $1`, [o.id]);
    if (verRes.rows.length === 0) {
      const totalItems = itemsRes.rows.reduce((sum, it) => sum + it.quantity, 0);
      const checklist = itemsRes.rows.map(it => ({
        sku: it.sku,
        barcode: it.barcode || null,
        variantId: it.variant_id,
        productName: it.product_name,
        variantName: it.variant_name,
        requiredQuantity: it.quantity,
        scannedQuantity: 0
      }));

      verRes = await pool.query(`
        INSERT INTO order_pack_verifications (order_id, status, total_items, scanned_items, items_checklist)
        VALUES ($1, 'packing', $2, 0, $3)
        ON CONFLICT (order_id) DO UPDATE SET updated_at = order_pack_verifications.updated_at
        RETURNING *
      `, [o.id, totalItems, JSON.stringify(checklist)]);
    }

    const carrierRes = await pool.query(`
      SELECT * FROM carrier_shipments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [o.id]);

    if (logScan) {
      await pool.query(`
        INSERT INTO barcode_scan_logs (code, entity_type, entity_id, action, quantity, scanned_by, details)
        VALUES ($1, 'order', $2, 'lookup', 1, $3, $4)
      `, [code, o.id, actor?.username || "scanner", JSON.stringify({ orderNumber: o.order_number })]);
    }

    return {
      type: "order",
      entityId: o.id,
      order: {
        id: o.id,
        orderNumber: o.order_number,
        customerName: o.customer_name,
        phone: o.phone,
        email: o.email,
        address: o.address,
        city: o.city,
        status: o.status,
        paymentMethod: o.payment_method,
        paymentStatus: o.payment_status,
        subtotalVnd: o.subtotal_vnd,
        shippingFeeVnd: o.shipping_fee_vnd,
        totalVnd: o.total_vnd,
        createdAt: o.created_at
      },
      items: itemsRes.rows.map(it => ({
        id: it.id,
        variantId: it.variant_id,
        productName: it.product_name,
        variantName: it.variant_name,
        sku: it.sku,
        barcode: it.barcode,
        unitPriceVnd: it.unit_price_vnd,
        quantity: it.quantity,
        lineTotalVnd: it.line_total_vnd
      })),
      verification: verRes.rows[0],
      carrierShipment: carrierRes.rows[0] || null
    };
  }

  // 3. Check Carrier Waybill / Tracking Number
  const shipRes = await pool.query(`
    SELECT cs.*, o.order_number, o.customer_name, o.phone, o.address, o.city, o.status AS order_status
    FROM carrier_shipments cs
    JOIN orders o ON o.id = cs.order_id
    WHERE cs.tracking_number = $1 OR cs.carrier_order_id = $1
    LIMIT 1
  `, [code]);

  if (shipRes.rows.length > 0) {
    const s = shipRes.rows[0];
    if (logScan) {
      await pool.query(`
        INSERT INTO barcode_scan_logs (code, entity_type, entity_id, action, quantity, scanned_by, details)
        VALUES ($1, 'waybill', $2, 'lookup', 1, $3, $4)
      `, [code, s.id, actor?.username || "scanner", JSON.stringify({ trackingNumber: s.tracking_number, carrier: s.carrier_id })]);
    }

    return {
      type: "waybill",
      entityId: s.id,
      shipment: s,
      order: {
        id: s.order_id,
        orderNumber: s.order_number,
        customerName: s.customer_name,
        phone: s.phone,
        address: s.address,
        city: s.city,
        status: s.order_status
      }
    };
  }

  // 4. Unknown Code
  if (logScan) {
    await pool.query(`
      INSERT INTO barcode_scan_logs (code, entity_type, action, scanned_by)
      VALUES ($1, 'unknown', 'lookup', $2)
    `, [code, actor?.username || "scanner"]);
  }

  return { type: "unknown", code };
}

// -------------------------------------------------------------
// Quick Inbound Receive by Barcode (Nhập kho nhanh)
// -------------------------------------------------------------
async function receiveByBarcode(pool, { code, warehouseId, quantity, reason = "Nhập kho nhanh qua máy quét mã vạch", actor = null }) {
  const normCode = String(code || "").trim();
  const qty = parseInt(quantity, 10);
  if (!normCode) throw fail("Mã vạch / SKU không được để trống", 400);
  if (!Number.isSafeInteger(qty) || qty <= 0) throw fail("Số lượng nhập kho phải là số nguyên dương", 400);

  return await withTransaction(pool, async (client) => {
    // 1. Find variant
    const isUuid = UUID_REGEX.test(normCode);
    const varRes = await client.query(`
      SELECT pv.id, pv.sku, pv.barcode, pv.name AS variant_name, pv.stock_quantity, p.name AS product_name
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.sku = $1 OR pv.barcode = $1 ${isUuid ? "OR pv.id = $2" : ""}
      FOR UPDATE OF pv
    `, isUuid ? [normCode, normCode] : [normCode]);

    if (varRes.rows.length === 0) {
      throw fail(`Không tìm thấy sản phẩm có mã vạch / SKU: ${normCode}`, 404);
    }
    const variant = varRes.rows[0];

    // 2. Resolve warehouse
    let targetWhId = warehouseId;
    if (!targetWhId) {
      const whRes = await client.query(`SELECT id FROM warehouses WHERE code = 'MAIN' AND active = true LIMIT 1`);
      if (whRes.rows.length === 0) {
        const anyWh = await client.query(`SELECT id FROM warehouses WHERE active = true ORDER BY created_at ASC LIMIT 1`);
        if (anyWh.rows.length === 0) throw fail("Không tìm thấy kho hàng hoạt động nào trong hệ thống", 400);
        targetWhId = anyWh.rows[0].id;
      } else {
        targetWhId = whRes.rows[0].id;
      }
    }

    const whCheck = await client.query(`SELECT id, name, code FROM warehouses WHERE id = $1 AND active = true FOR SHARE`, [targetWhId]);
    if (whCheck.rows.length === 0) throw fail("Kho chỉ định không tồn tại hoặc đã ngừng hoạt động", 404);
    const warehouse = whCheck.rows[0];

    // 3. Lock or initialize warehouse stock balance
    await client.query(`
      INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
      VALUES ($1, $2, 0)
      ON CONFLICT (warehouse_id, variant_id) DO NOTHING
    `, [targetWhId, variant.id]);

    const balRes = await client.query(`
      SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2 FOR UPDATE
    `, [targetWhId, variant.id]);
    const beforeBalance = balRes.rows[0].quantity;
    const afterBalance = beforeBalance + qty;
    const newStock = variant.stock_quantity + qty;

    // 4. Update warehouse stock and aggregate
    await client.query(`
      UPDATE warehouse_stock SET quantity = $3, updated_at = now()
      WHERE warehouse_id = $1 AND variant_id = $2
    `, [targetWhId, variant.id, afterBalance]);

    await client.query(`
      UPDATE product_variants SET stock_quantity = $2, updated_at = now()
      WHERE id = $1
    `, [variant.id, newStock]);

    // 5. Insert movement record
    const eventKey = `barcode_inbound:${variant.id}:${targetWhId}:${Date.now()}:${require('node:crypto').randomUUID().slice(0, 8)}`;
    await client.query(`
      INSERT INTO inventory_movements (
        event_key, warehouse_id, variant_id, sku, product_name, variant_name,
        movement_type, delta, quantity_before, quantity_after,
        reference_type, reference_id, reason, actor_id, actor_username
      ) VALUES ($1, $2, $3, $4, $5, $6, 'purchase_receipt', $7, $8, $9, 'barcode_scanner', $10, $11, $12, $13)
    `, [
      eventKey, targetWhId, variant.id, variant.sku, variant.product_name, variant.variant_name,
      qty, beforeBalance, afterBalance,
      variant.id, reason, actor?.id || null, actor?.username || "scanner"
    ]);

    // 6. Log scan log
    await client.query(`
      INSERT INTO barcode_scan_logs (code, entity_type, entity_id, action, warehouse_id, quantity, scanned_by, details)
      VALUES ($1, 'sku', $2, 'inbound_receive', $3, $4, $5, $6)
    `, [
      normCode, variant.id, targetWhId, qty, actor?.username || "scanner",
      JSON.stringify({ warehouseCode: warehouse.code, before: beforeBalance, after: afterBalance, reason })
    ]);

    await appendAudit(client, {
      actor,
      action: "inventory.inbound_barcode",
      entityType: "variant",
      entityId: variant.id,
      before: { warehouseId: targetWhId, quantity: beforeBalance },
      after: { warehouseId: targetWhId, quantity: afterBalance },
      metadata: { sku: variant.sku, delta: qty, reason }
    });

    try { require('../cache').flushAllCache(); } catch {}
    return {
      ok: true,
      variantId: variant.id,
      sku: variant.sku,
      productName: variant.product_name,
      warehouseId: targetWhId,
      warehouseCode: warehouse.code,
      beforeQuantity: beforeBalance,
      receivedQuantity: qty,
      newQuantity: afterBalance,
      aggregateQuantity: newStock
    };
  });
}

// -------------------------------------------------------------
// Cycle Count Adjustment by Barcode (Kiểm kê kho thực tế)
// -------------------------------------------------------------
async function countByBarcode(pool, { code, warehouseId, actualQuantity, reason = "Kiểm kê kho qua máy quét mã vạch", actor = null }) {
  const normCode = String(code || "").trim();
  const actual = parseInt(actualQuantity, 10);
  if (!normCode) throw fail("Mã vạch / SKU không được để trống", 400);
  if (!Number.isSafeInteger(actual) || actual < 0) throw fail("Số lượng kiểm kê thực tế phải lớn hơn hoặc bằng 0", 400);

  return await withTransaction(pool, async (client) => {
    const isUuid = UUID_REGEX.test(normCode);
    const varRes = await client.query(`
      SELECT pv.id, pv.sku, pv.barcode, pv.name AS variant_name, pv.stock_quantity, p.name AS product_name
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.sku = $1 OR pv.barcode = $1 ${isUuid ? "OR pv.id = $2" : ""}
      FOR UPDATE OF pv
    `, isUuid ? [normCode, normCode] : [normCode]);

    if (varRes.rows.length === 0) {
      throw fail(`Không tìm thấy sản phẩm có mã vạch / SKU: ${normCode}`, 404);
    }
    const variant = varRes.rows[0];

    let targetWhId = warehouseId;
    if (!targetWhId) {
      const whRes = await client.query(`SELECT id FROM warehouses WHERE code = 'MAIN' AND active = true LIMIT 1`);
      if (whRes.rows.length === 0) {
        const anyWh = await client.query(`SELECT id FROM warehouses WHERE active = true ORDER BY created_at ASC LIMIT 1`);
        if (anyWh.rows.length === 0) throw fail("Không tìm thấy kho hàng hoạt động nào trong hệ thống", 400);
        targetWhId = anyWh.rows[0].id;
      } else {
        targetWhId = whRes.rows[0].id;
      }
    }

    const whCheck = await client.query(`SELECT id, name, code FROM warehouses WHERE id = $1 AND active = true FOR SHARE`, [targetWhId]);
    if (whCheck.rows.length === 0) throw fail("Kho chỉ định không tồn tại hoặc đã ngừng hoạt động", 404);
    const warehouse = whCheck.rows[0];

    await client.query(`
      INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
      VALUES ($1, $2, 0)
      ON CONFLICT (warehouse_id, variant_id) DO NOTHING
    `, [targetWhId, variant.id]);

    const balRes = await client.query(`
      SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2 FOR UPDATE
    `, [targetWhId, variant.id]);
    const beforeBalance = balRes.rows[0].quantity;
    const delta = actual - beforeBalance;
    const newStock = variant.stock_quantity + delta;
    if (newStock < 0) throw fail("Tổng tồn kho toàn hệ thống không thể âm sau kiểm kê", 400);

    if (delta !== 0) {
      await client.query(`
        UPDATE warehouse_stock SET quantity = $3, updated_at = now()
        WHERE warehouse_id = $1 AND variant_id = $2
      `, [targetWhId, variant.id, actual]);

      await client.query(`
        UPDATE product_variants SET stock_quantity = $2, updated_at = now()
        WHERE id = $1
      `, [variant.id, newStock]);

      const eventKey = `barcode_cycle_count:${variant.id}:${targetWhId}:${Date.now()}:${require('node:crypto').randomUUID().slice(0, 8)}`;
      try { require('../cache').flushAllCache(); } catch {}
      await client.query(`
        INSERT INTO inventory_movements (
          event_key, warehouse_id, variant_id, sku, product_name, variant_name,
          movement_type, delta, quantity_before, quantity_after,
          reference_type, reference_id, reason, actor_id, actor_username
        ) VALUES ($1, $2, $3, $4, $5, $6, 'adjustment', $7, $8, $9, 'cycle_count', $10, $11, $12, $13)
      `, [
        eventKey, targetWhId, variant.id, variant.sku, variant.product_name, variant.variant_name,
        delta, beforeBalance, actual,
        variant.id, reason, actor?.id || null, actor?.username || "scanner"
      ]);
    }

    await client.query(`
      INSERT INTO barcode_scan_logs (code, entity_type, entity_id, action, warehouse_id, quantity, scanned_by, details)
      VALUES ($1, 'sku', $2, 'cycle_count', $3, $4, $5, $6)
    `, [
      normCode, variant.id, targetWhId, actual, actor?.username || "scanner",
      JSON.stringify({ warehouseCode: warehouse.code, before: beforeBalance, actual, delta, reason })
    ]);

    await appendAudit(client, {
      actor,
      action: "inventory.cycle_count_barcode",
      entityType: "variant",
      entityId: variant.id,
      before: { warehouseId: targetWhId, quantity: beforeBalance },
      after: { warehouseId: targetWhId, quantity: actual },
      metadata: { sku: variant.sku, delta, reason }
    });

    return {
      ok: true,
      variantId: variant.id,
      sku: variant.sku,
      warehouseId: targetWhId,
      warehouseCode: warehouse.code,
      beforeQuantity: beforeBalance,
      actualQuantity: actual,
      delta,
      aggregateQuantity: newStock
    };
  });
}

// -------------------------------------------------------------
// Pack Item Verification (Kiểm tra từng món trong đơn hàng)
// -------------------------------------------------------------
async function verifyPackItem(pool, { orderId, scannedCode, actor = null }) {
  const normOrderId = String(orderId || "").trim();
  const code = String(scannedCode || "").trim();
  if (!normOrderId) throw fail("Mã đơn hàng không được để trống", 400);
  if (!code) throw fail("Mã vạch món hàng không được để trống", 400);

  return await withTransaction(pool, async (client) => {
    // 1. Lock order & verify fulfillment eligibility
    const ordRes = await client.query(
      `SELECT id, order_number, status, payment_method, payment_status, return_completed_at FROM orders WHERE id = $1 FOR UPDATE`,
      [normOrderId]
    );
    if (ordRes.rows.length === 0) throw fail("Không tìm thấy đơn hàng", 404);
    const order = ordRes.rows[0];
    if (order.status === "cancelled" || order.return_completed_at) {
      throw fail("Không thể đóng gói đơn hàng đã hủy hoặc đã hoàn trả.", 409);
    }
    if (order.payment_method !== "cod" && order.payment_status !== "paid") {
      throw fail("Đơn trả trước chưa hoàn tất thanh toán; không thể đóng gói xuất kho.", 409);
    }

    // 2. Fetch or create verification record
    let verRes = await client.query(`SELECT * FROM order_pack_verifications WHERE order_id = $1 FOR UPDATE`, [normOrderId]);
    if (verRes.rows.length === 0) {
      const itemsRes = await client.query(`
        SELECT oi.*, pv.barcode FROM order_items oi
        LEFT JOIN product_variants pv ON pv.id = oi.variant_id
        WHERE oi.order_id = $1
      `, [normOrderId]);
      const totalItems = itemsRes.rows.reduce((sum, it) => sum + it.quantity, 0);
      const checklist = itemsRes.rows.map(it => ({
        sku: it.sku,
        barcode: it.barcode || null,
        variantId: it.variant_id,
        productName: it.product_name,
        variantName: it.variant_name,
        requiredQuantity: it.quantity,
        scannedQuantity: 0
      }));

      verRes = await client.query(`
        INSERT INTO order_pack_verifications (order_id, status, total_items, scanned_items, items_checklist)
        VALUES ($1, 'packing', $2, 0, $3)
        RETURNING *
      `, [normOrderId, totalItems, JSON.stringify(checklist)]);
    }

    const verification = verRes.rows[0];
    if (verification.status === "dispatched") {
      throw fail("Đơn hàng này đã hoàn tất xuất kho, không thể quét đóng gói thêm.", 400);
    }

    // 3. Find matched item in checklist (by SKU or Barcode)
    const checklist = Array.isArray(verification.items_checklist) ? verification.items_checklist : [];
    const lowerCode = code.toLowerCase();
    const matchedItem = checklist.find(it =>
      (it.sku && it.sku.toLowerCase() === lowerCode) ||
      (it.barcode && it.barcode.toLowerCase() === lowerCode)
    );

    if (!matchedItem) {
      await client.query(`
        INSERT INTO barcode_scan_logs (code, entity_type, entity_id, action, scanned_by, details)
        VALUES ($1, 'unknown', $2, 'pack_verify', $3, $4)
      `, [code, normOrderId, actor?.username || "scanner", JSON.stringify({ match: false, error: "not_in_order" })]);

      return {
        ok: false,
        error: `Mã [${code}] không khớp bất kỳ sản phẩm nào trong đơn hàng ${order.order_number}!`,
        orderNumber: order.order_number,
        verification
      };
    }

    // 4. Check if already scanned enough
    if (matchedItem.scannedQuantity >= matchedItem.requiredQuantity) {
      return {
        ok: false,
        error: `Sản phẩm [${matchedItem.sku} - ${matchedItem.variantName}] đã quét đủ số lượng (${matchedItem.requiredQuantity})!`,
        orderNumber: order.order_number,
        matchedItem,
        verification
      };
    }

    // 5. Increment counts
    matchedItem.scannedQuantity += 1;
    const newScannedTotal = verification.scanned_items + 1;
    const isComplete = newScannedTotal >= verification.total_items;
    const newStatus = isComplete ? "verified" : "packing";

    const updatedRes = await client.query(`
      UPDATE order_pack_verifications
      SET scanned_items = $2, items_checklist = $3, status = $4,
          packed_by = CASE WHEN $4 = 'verified' THEN COALESCE($5, packed_by) ELSE packed_by END,
          packed_at = CASE WHEN $4 = 'verified' AND packed_at IS NULL THEN now() ELSE packed_at END,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `, [verification.id, newScannedTotal, JSON.stringify(checklist), newStatus, actor?.username || "scanner"]);

    await client.query(`
      INSERT INTO barcode_scan_logs (code, entity_type, entity_id, action, quantity, scanned_by, details)
      VALUES ($1, 'sku', $2, 'pack_verify', 1, $3, $4)
    `, [
      code, matchedItem.variantId, actor?.username || "scanner",
      JSON.stringify({ orderId: normOrderId, orderNumber: order.order_number, sku: matchedItem.sku, isComplete })
    ]);

    return {
      ok: true,
      orderNumber: order.order_number,
      matchedItem,
      verification: updatedRes.rows[0],
      isComplete
    };
  });
}

// -------------------------------------------------------------
// Outbound Dispatch by Barcode (Xuất kho bàn giao vận chuyển)
// -------------------------------------------------------------
async function dispatchByBarcode(pool, { orderId, trackingCode = null, actor = null }) {
  const normOrderId = String(orderId || "").trim();
  if (!normOrderId) throw fail("Mã đơn hàng không được để trống", 400);

  return await withTransaction(pool, async (client) => {
    const ordRes = await client.query(
      `SELECT id, order_number, status, payment_method, payment_status, return_completed_at FROM orders WHERE id = $1 FOR UPDATE`,
      [normOrderId]
    );
    if (ordRes.rows.length === 0) throw fail("Không tìm thấy đơn hàng", 404);
    const order = ordRes.rows[0];
    if (order.status === "cancelled" || order.return_completed_at) {
      throw fail("Không thể xuất kho đơn hàng đã hủy hoặc đã hoàn trả.", 409);
    }
    if (order.payment_method !== "cod" && order.payment_status !== "paid") {
      throw fail("Đơn trả trước chưa thanh toán; không thể xuất kho.", 409);
    }
    const openRev = await client.query(
      "SELECT 1 FROM order_reviews WHERE order_id = $1 AND resolved_at IS NULL LIMIT 1",
      [normOrderId]
    );
    if (openRev.rows.length > 0) {
      throw fail("Đơn hàng đang chờ xác minh; vui lòng đối chiếu trước khi xuất kho.", 409);
    }

    const verRes = await client.query(`SELECT * FROM order_pack_verifications WHERE order_id = $1 FOR UPDATE`, [normOrderId]);
    if (verRes.rows.length === 0 || verRes.rows[0].status !== "verified") {
      throw fail("Đơn hàng chưa hoàn tất kiểm tra đóng gói đủ món! Vui lòng quét kiểm tra trước khi xuất kho.", 400);
    }

    const updatedVer = await client.query(`
      UPDATE order_pack_verifications
      SET status = 'dispatched', dispatched_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING *
    `, [verRes.rows[0].id]);

    await client.query(`
      UPDATE orders
      SET status = 'shipped', updated_at = now()
      WHERE id = $1 AND status IN ('pending', 'confirmed', 'processing')
    `, [normOrderId]);

    if (trackingCode) {
      await client.query(`
        UPDATE carrier_shipments
        SET status = 'delivering', updated_at = now()
        WHERE order_id = $1 AND tracking_number = $2 AND status <> 'cancelled'
      `, [normOrderId, trackingCode]);
    }

    await client.query(`
      INSERT INTO barcode_scan_logs (code, entity_type, entity_id, action, quantity, scanned_by, details)
      VALUES ($1, 'order', $2, 'outbound_dispatch', 1, $3, $4)
    `, [order.order_number, normOrderId, actor?.username || "scanner", JSON.stringify({ trackingCode })]);

    await appendAudit(client, {
      actor,
      action: "order.dispatch_barcode",
      entityType: "order",
      entityId: normOrderId,
      metadata: { orderNumber: order.order_number, trackingCode }
    });

    return {
      ok: true,
      orderId: normOrderId,
      orderNumber: order.order_number,
      status: "dispatched",
      verification: updatedVer.rows[0],
      dispatchedAt: new Date().toISOString()
    };
  });
}

// -------------------------------------------------------------
// Bind Barcode to SKU (Gán mã vạch NSX vào phiên bản SKU)
// -------------------------------------------------------------
async function bindBarcode(pool, { variantId, barcode, actor = null }) {
  const normVarId = String(variantId || "").trim();
  const normBarcode = String(barcode || "").trim();
  if (!normVarId) throw fail("Mã phiên bản (variantId) không được để trống", 400);
  if (!normBarcode) throw fail("Mã vạch gán không được để trống", 400);

  return await withTransaction(pool, async (client) => {
    const check = await client.query(`
      SELECT id, sku, name FROM product_variants WHERE id = $1 FOR UPDATE
    `, [normVarId]);
    if (check.rows.length === 0) throw fail("Không tìm thấy phiên bản sản phẩm", 404);

    const dupCheck = await client.query(`
      SELECT id, sku FROM product_variants WHERE barcode = $1 AND id <> $2
    `, [normBarcode, normVarId]);
    if (dupCheck.rows.length > 0) {
      throw fail(`Mã vạch '${normBarcode}' đã được gán cho SKU '${dupCheck.rows[0].sku}'`, 409);
    }

    const updated = await client.query(`
      UPDATE product_variants SET barcode = $2, updated_at = now() WHERE id = $1
      RETURNING id, sku, barcode, name, stock_quantity
    `, [normVarId, normBarcode]);

    await appendAudit(client, {
      actor,
      action: "catalog.bind_barcode",
      entityType: "variant",
      entityId: normVarId,
      metadata: { sku: check.rows[0].sku, barcode: normBarcode }
    });

    return { ok: true, variant: updated.rows[0] };
  });
}

// -------------------------------------------------------------
// Barcode Scan History & Shift Metrics
// -------------------------------------------------------------
async function getBarcodeHistory(pool, { limit = 50, offset = 0, action = null, entityType = null } = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (action) {
    conditions.push(`action = $${paramIdx++}`);
    params.push(action);
  }
  if (entityType) {
    conditions.push(`entity_type = $${paramIdx++}`);
    params.push(entityType);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `
    SELECT id, code, entity_type, entity_id, action, warehouse_id, quantity, details, scanned_by, created_at
    FROM barcode_scan_logs
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${paramIdx++} OFFSET $${paramIdx++}
  `;
  params.push(safeLimit, safeOffset);

  const logsRes = await pool.query(query, params);

  // Today shift metrics (from 00:00:00 today)
  const metricsRes = await pool.query(`
    SELECT
      COUNT(*)::int AS total_scans_today,
      COUNT(*) FILTER (WHERE action = 'inbound_receive')::int AS inbounds_today,
      COUNT(*) FILTER (WHERE action = 'pack_verify')::int AS packs_today,
      COUNT(*) FILTER (WHERE action = 'cycle_count')::int AS cycle_counts_today,
      COUNT(*) FILTER (WHERE action = 'outbound_dispatch')::int AS dispatches_today
    FROM barcode_scan_logs
    WHERE created_at >= date_trunc('day', now())
  `);

  return {
    logs: logsRes.rows,
    metrics: metricsRes.rows[0] || {
      total_scans_today: 0,
      inbounds_today: 0,
      packs_today: 0,
      cycle_counts_today: 0,
      dispatches_today: 0
    }
  };
}

// -------------------------------------------------------------
// Express Router Factory
// -------------------------------------------------------------
function createBarcodeApi(pool, config = {}) {
  const admin = Router();
  const standardLimit = rateLimit({
    windowMs: 60000,
    limit: 300,
    standardHeaders: "draft-8",
    legacyHeaders: false
  });

  // Helper middleware for either inventory or orders permission
  const requireWarehouseAccess = (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: "Vui lòng đăng nhập quản trị viên." });
    const perms = Array.isArray(req.admin.permissions) ? req.admin.permissions : [];
    if (perms.includes("inventory.read") || perms.includes("orders.read") || perms.includes("catalog.read")) {
      return next();
    }
    return res.status(403).json({ error: "Tài khoản không có quyền truy cập nghiệp vụ mã vạch kho." });
  };

  // 1. Unified scan resolver
  admin.get("/barcode/scan/:code", standardLimit, requireWarehouseAccess, async (req, res, next) => {
    try {
      const result = await resolveBarcode(pool, req.params.code, { actor: req.admin, logScan: true });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // 2. Quick inbound receive
  admin.post("/barcode/receive", standardLimit, requirePermission("inventory.write"), requireCsrf, async (req, res, next) => {
    try {
      const { code, warehouseId, quantity, reason } = req.body || {};
      const result = await receiveByBarcode(pool, {
        code,
        warehouseId,
        quantity,
        reason,
        actor: req.admin
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // 3. Cycle count adjustment
  admin.post("/barcode/cycle-count", standardLimit, requirePermission("inventory.write"), requireCsrf, async (req, res, next) => {
    try {
      const { code, warehouseId, actualQuantity, reason } = req.body || {};
      const result = await countByBarcode(pool, {
        code,
        warehouseId,
        actualQuantity,
        reason,
        actor: req.admin
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // 4. Pack verify item
  admin.post("/barcode/pack-verify", standardLimit, requirePermission("orders.write"), requireCsrf, async (req, res, next) => {
    try {
      const { orderId, scannedCode } = req.body || {};
      const result = await verifyPackItem(pool, {
        orderId,
        scannedCode,
        actor: req.admin
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // 5. Outbound dispatch
  admin.post("/barcode/dispatch", standardLimit, requirePermission("orders.write"), requireCsrf, async (req, res, next) => {
    try {
      const { orderId, trackingCode } = req.body || {};
      const result = await dispatchByBarcode(pool, {
        orderId,
        trackingCode,
        actor: req.admin
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // 6. Bind barcode to SKU
  admin.post("/barcode/bind-sku", standardLimit, requirePermission("catalog.write"), requireCsrf, async (req, res, next) => {
    try {
      const { variantId, barcode } = req.body || {};
      const result = await bindBarcode(pool, {
        variantId,
        barcode,
        actor: req.admin
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // 7. Barcode scan history & shift metrics
  admin.get("/barcode/history", standardLimit, requireWarehouseAccess, async (req, res, next) => {
    try {
      const { limit, offset, action, entityType } = req.query || {};
      const result = await getBarcodeHistory(pool, { limit, offset, action, entityType });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // 8. Render Code 128 SVG
  admin.get("/barcode/render", standardLimit, requireWarehouseAccess, async (req, res, next) => {
    try {
      const { code, height, moduleWidth, includeText } = req.query || {};
      const result = generateCode128Svg(code, {
        height,
        moduleWidth,
        includeText: includeText !== "0" && includeText !== "false"
      });

      if (req.headers.accept && req.headers.accept.includes("image/svg+xml")) {
        res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
        return res.send(result.svg);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return { admin };
}

module.exports = {
  CODE128_PATTERNS,
  generateCode128Svg,
  resolveBarcode,
  receiveByBarcode,
  countByBarcode,
  verifyPackItem,
  dispatchByBarcode,
  bindBarcode,
  getBarcodeHistory,
  createBarcodeApi
};
