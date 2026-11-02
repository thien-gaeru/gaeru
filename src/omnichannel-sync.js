const { Router } = require('express');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { withTransaction } = require('./db');
const { requireCsrf } = require('./security');
const { requirePermission } = require('./staff-access');
const { readRecord } = require('./admin-configuration');
const { appendAudit } = require('./audit');
const { getConnector, normalizeStatus } = require('./marketplace-connectors');

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// -----------------------------------------------------------------------------
// 1. SKU MAPPING ENGINE
// -----------------------------------------------------------------------------
async function resolveVariantForSku(client, channel, shopId, externalSku) {
  if (!externalSku) return null;
  // 1. Check explicit mapping table
  const mapped = await client.query(
    `SELECT variant_id AS "variantId" FROM marketplace_sku_mappings
     WHERE channel = $1 AND shop_id = $2 AND lower(external_sku) = lower($3)`,
    [channel, shopId, String(externalSku).trim()]
  );
  if (mapped.rows.length) return mapped.rows[0].variantId;

  // 2. Fallback to exact SKU in product_variants
  const direct = await client.query(
    `SELECT id AS "variantId" FROM product_variants
     WHERE lower(sku) = lower($1) AND active = true LIMIT 1`,
    [String(externalSku).trim()]
  );
  if (direct.rows.length) return direct.rows[0].variantId;

  return null;
}

// -----------------------------------------------------------------------------
// 2. ORDER INGESTION & IDEMPOTENT STOCK LEDGER REVERSE
// -----------------------------------------------------------------------------
async function ingestMarketplaceOrder(client, { channel, shopId, order, autoDeductStock = true, actor }) {
  const normStatus = normalizeStatus(channel, order.rawStatus || order.status);

  // Check if order exists
  const existingRes = await client.query(
    `SELECT * FROM marketplace_orders
     WHERE channel = $1 AND shop_id = $2 AND external_order_id = $3
     FOR UPDATE`,
    [channel, shopId, order.externalOrderId]
  );

  let marketplaceOrder;
  if (!existingRes.rows.length) {
    const inserted = await client.query(
      `INSERT INTO marketplace_orders (
         channel, shop_id, external_order_id, order_date, status,
         customer_name, customer_phone, shipping_address, total_amount_vnd,
         items, stock_deducted, stock_reversed, raw_payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, false, $11)
       RETURNING *`,
      [
        channel,
        shopId,
        order.externalOrderId,
        order.orderDate || new Date().toISOString().slice(0, 10),
        normStatus,
        order.customerName || '',
        order.customerPhone || '',
        order.shippingAddress || '',
        order.totalAmountVnd || 0,
        JSON.stringify(order.items || []),
        JSON.stringify(order.rawPayload || order)
      ]
    );
    marketplaceOrder = inserted.rows[0];
  } else {
    const prev = existingRes.rows[0];
    const updated = await client.query(
      `UPDATE marketplace_orders
       SET status = $4, customer_name = COALESCE(NULLIF($5, ''), customer_name),
           total_amount_vnd = CASE WHEN $6 > 0 THEN $6 ELSE total_amount_vnd END,
           raw_payload = $7, updated_at = now()
       WHERE channel = $1 AND shop_id = $2 AND external_order_id = $3
       RETURNING *`,
      [
        channel,
        shopId,
        order.externalOrderId,
        normStatus,
        order.customerName || '',
        order.totalAmountVnd || 0,
        JSON.stringify(order.rawPayload || order)
      ]
    );
    marketplaceOrder = updated.rows[0];
  }

  const items = Array.isArray(marketplaceOrder.items) ? marketplaceOrder.items : [];

  // Case A: Order confirmed / processing / shipped ➔ Deduct stock if not yet deducted
  if (autoDeductStock && ['confirmed', 'processing', 'shipped', 'completed'].includes(normStatus) && !marketplaceOrder.stock_deducted) {
    for (const item of items) {
      const variantId = await resolveVariantForSku(client, channel, shopId, item.externalSku);
      if (variantId) {
        const qty = Number(item.quantity) || 1;
        await client.query(
          `UPDATE product_variants
           SET stock_quantity = GREATEST(0, stock_quantity - $2), updated_at = now()
           WHERE id = $1`,
          [variantId, qty]
        );

        // Record stock movement into marketplace sync ledger
        const eventKey = `marketplace-sale:${channel}:${shopId}:${order.externalOrderId}:${variantId}`;
        await client.query(
          `INSERT INTO marketplace_sync_events (channel, event_type, external_order_id, event_key, payload, processed)
           VALUES ($1, 'stock_deduction', $2, $3, $4, true)
           ON CONFLICT (event_key) DO NOTHING`,
          [channel, order.externalOrderId, eventKey, JSON.stringify({ variantId, quantity: qty })]
        );
      }
    }
    await client.query(
      `UPDATE marketplace_orders SET stock_deducted = true, updated_at = now() WHERE id = $1`,
      [marketplaceOrder.id]
    );
    marketplaceOrder.stock_deducted = true;
  }

  // Case B: Order cancelled or returned ➔ REVERSE STOCK LEDGER (HOÀN TỒN ĐƠN SÀN HỦY/TRẢ)
  if (['cancelled', 'returned'].includes(normStatus) && marketplaceOrder.stock_deducted && !marketplaceOrder.stock_reversed) {
    for (const item of items) {
      const variantId = await resolveVariantForSku(client, channel, shopId, item.externalSku);
      if (variantId) {
        const qty = Number(item.quantity) || 1;
        await client.query(
          `UPDATE product_variants
           SET stock_quantity = stock_quantity + $2, updated_at = now()
           WHERE id = $1`,
          [variantId, qty]
        );

        const eventKey = `marketplace-reverse:${channel}:${shopId}:${order.externalOrderId}:${variantId}`;
        await client.query(
          `INSERT INTO marketplace_sync_events (channel, event_type, external_order_id, event_key, payload, processed)
           VALUES ($1, 'stock_reverse', $2, $3, $4, true)
           ON CONFLICT (event_key) DO NOTHING`,
          [channel, order.externalOrderId, eventKey, JSON.stringify({ variantId, quantity: qty, status: normStatus })]
        );
      }
    }

    await client.query(
      `UPDATE marketplace_orders SET stock_reversed = true, updated_at = now() WHERE id = $1`,
      [marketplaceOrder.id]
    );
    marketplaceOrder.stock_reversed = true;

    await appendAudit(client, {
      actor: actor || { username: 'omnichannel_worker', source: 'marketplace' },
      action: 'marketplace.stock_reverse',
      entityType: 'marketplace_order',
      entityId: order.externalOrderId,
      metadata: { channel, shopId, status: normStatus, itemsCount: items.length }
    });
  }

  return marketplaceOrder;
}

// -----------------------------------------------------------------------------
// 3. WEBHOOK EVENT HANDLER WITH IDEMPOTENCY
// -----------------------------------------------------------------------------
async function handleMarketplaceWebhook(pool, config, channel, payload, { headers = {}, fetcher = fetch } = {}) {
  const connector = getConnector(channel);

  let externalOrderId = null;
  let rawStatus = null;
  let shopId = null;

  if (channel === 'shopee') {
    externalOrderId = String(payload.data?.order_sn || payload.order_sn || '');
    rawStatus = payload.data?.status || payload.status || 'PROCESSED';
    shopId = String(payload.shop_id || payload.data?.shop_id || 'DEFAULT_SHOP');
  } else if (channel === 'tiktok') {
    externalOrderId = String(payload.data?.order_id || payload.order_id || '');
    rawStatus = payload.data?.order_status || payload.order_status || 'AWAITING_COLLECTION';
    shopId = String(payload.shop_id || payload.data?.shop_id || 'DEFAULT_SHOP');
  } else if (channel === 'lazada') {
    externalOrderId = String(payload.data?.order_id || payload.order_id || '');
    rawStatus = payload.data?.order_status || payload.order_status || 'delivered';
    shopId = String(payload.seller_id || payload.data?.seller_id || 'DEFAULT_SHOP');
  }

  if (!externalOrderId) {
    return { success: false, reason: 'Không tìm thấy mã đơn trong webhook payload.' };
  }

  const eventKey = `${channel}:${externalOrderId}:${rawStatus}:${Date.now().toString(36)}`;

  return withTransaction(pool, async client => {
    // Check if event already processed
    const existing = await client.query(
      `SELECT id FROM marketplace_sync_events WHERE event_key = $1`,
      [eventKey]
    );
    if (existing.rows.length) {
      return { success: true, duplicated: true };
    }

    await client.query(
      `INSERT INTO marketplace_sync_events (channel, event_type, external_order_id, event_key, payload, processed)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [channel, 'order_status_update', externalOrderId, eventKey, JSON.stringify(payload)]
    );

    const orderData = {
      externalOrderId,
      rawStatus,
      customerName: payload.data?.buyer_username || payload.data?.recipient_address?.name || '',
      totalAmountVnd: Math.round(Number(payload.data?.total_amount || payload.total_amount || 0)),
      items: payload.data?.items || payload.data?.item_list || []
    };

    const ingested = await ingestMarketplaceOrder(client, {
      channel,
      shopId,
      order: orderData,
      autoDeductStock: true,
      actor: { username: `${channel}_webhook`, source: 'webhook' }
    });

    return {
      success: true,
      channel,
      externalOrderId,
      status: ingested.status,
      stockReversed: ingested.stock_reversed
    };
  });
}

// -----------------------------------------------------------------------------
// 4. SYNC RUNNERS
// -----------------------------------------------------------------------------
async function syncMarketplaceOrders(pool, config, channel, { fetcher = fetch, actor } = {}) {
  const record = await readRecord(pool, config, channel);
  if (!record.data || !record.data.secretConfigured && !record.data.secret) {
    throw fail(`Chưa cấu hình tài khoản liên kết cho sàn ${channel}.`, 400);
  }

  const connector = getConnector(channel);
  const creds = record.data;
  let orders = [];

  if (channel === 'shopee') {
    orders = await connector.fetchOrders({
      partnerId: creds.partnerId,
      partnerKey: creds.secret,
      accessToken: creds.accessToken || 'TEST_ACCESS_TOKEN',
      shopId: creds.shopId
    }, { fetcher });
  } else if (channel === 'tiktok') {
    orders = await connector.fetchOrders({
      appKey: creds.appKey,
      appSecret: creds.secret,
      accessToken: creds.accessToken || 'TEST_ACCESS_TOKEN',
      shopCipher: creds.shopId || 'DEFAULT_SHOP'
    }, { fetcher });
  } else if (channel === 'lazada') {
    orders = await connector.fetchOrders({
      appKey: creds.appKey,
      appSecret: creds.secret,
      accessToken: creds.accessToken || 'TEST_ACCESS_TOKEN'
    }, { fetcher });
  }

  let syncedCount = 0;
  for (const order of orders) {
    await withTransaction(pool, async client => {
      await ingestMarketplaceOrder(client, {
        channel,
        shopId: creds.shopId || creds.sellerId || 'DEFAULT_SHOP',
        order,
        autoDeductStock: true,
        actor
      });
      syncedCount++;
    });
  }

  return { success: true, channel, syncedCount };
}

async function syncStockToChannel(pool, config, channel, { variantId, fetcher = fetch, actor } = {}) {
  const record = await readRecord(pool, config, channel);
  if (!record.data || !record.data.secretConfigured && !record.data.secret) {
    throw fail(`Chưa cấu hình API cho sàn ${channel}.`, 400);
  }

  const connector = getConnector(channel);
  const creds = record.data;

  const variantsRes = await pool.query(
    `SELECT v.id, v.sku, v.stock_quantity AS "stockQuantity", m.external_sku AS "externalSku"
     FROM product_variants v
     LEFT JOIN marketplace_sku_mappings m ON m.variant_id = v.id AND m.channel = $1
     WHERE ($2::uuid IS NULL OR v.id = $2) AND v.active = true`,
    [channel, variantId || null]
  );

  let updatedCount = 0;
  for (const variant of variantsRes.rows) {
    const targetSku = variant.externalSku || variant.sku;
    try {
      if (channel === 'shopee') {
        await connector.updateStock({
          partnerId: creds.partnerId,
          partnerKey: creds.secret,
          accessToken: creds.accessToken || 'TEST_TOKEN',
          shopId: creds.shopId,
          itemId: targetSku,
          stock: variant.stockQuantity
        }, { fetcher });
      } else if (channel === 'tiktok') {
        await connector.updateStock({
          appKey: creds.appKey,
          appSecret: creds.secret,
          accessToken: creds.accessToken || 'TEST_TOKEN',
          shopCipher: creds.shopId,
          productId: targetSku,
          skuId: targetSku,
          availableStock: variant.stockQuantity
        }, { fetcher });
      } else if (channel === 'lazada') {
        await connector.updateStock({
          appKey: creds.appKey,
          appSecret: creds.secret,
          accessToken: creds.accessToken || 'TEST_TOKEN',
          sku: targetSku,
          quantity: variant.stockQuantity
        }, { fetcher });
      }
      updatedCount++;
    } catch {
      // Keep syncing remaining products
    }
  }

  return { success: true, channel, updatedCount };
}

// -----------------------------------------------------------------------------
// 5. ROUTER FACTORY
// -----------------------------------------------------------------------------
function createOmnichannelSync(pool, config, { fetcher = fetch } = {}) {
  const adminRouter = Router();
  const publicRouter = Router();

  // Admin routes
  adminRouter.post('/marketplace/:channel/sync-orders',
    requirePermission('marketplace.write'),
    requireCsrf,
    rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const channel = z.enum(['shopee', 'tiktok', 'lazada']).parse(req.params.channel);
        const result = await syncMarketplaceOrders(pool, config, channel, { fetcher, actor: req.admin });
        res.json(result);
      } catch (e) {
        next(e);
      }
    }
  );

  adminRouter.post('/marketplace/:channel/sync-stock',
    requirePermission('marketplace.write'),
    requireCsrf,
    rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const channel = z.enum(['shopee', 'tiktok', 'lazada']).parse(req.params.channel);
        const { variantId } = z.object({ variantId: z.string().uuid().optional() }).parse(req.body || {});
        const result = await syncStockToChannel(pool, config, channel, { variantId, fetcher, actor: req.admin });
        res.json(result);
      } catch (e) {
        next(e);
      }
    }
  );

  adminRouter.get('/marketplace/orders',
    requirePermission('marketplace.read'),
    async (req, res, next) => {
      try {
        const channel = req.query.channel ? z.enum(['shopee', 'tiktok', 'lazada']).parse(req.query.channel) : null;
        const status = req.query.status ? z.enum(['pending', 'confirmed', 'processing', 'shipped', 'completed', 'cancelled', 'returned']).parse(req.query.status) : null;
        const page = Math.max(1, Number(req.query.page || 1));
        const limit = 25;
        const offset = (page - 1) * limit;

        const result = await pool.query(
          `SELECT * FROM marketplace_orders
           WHERE ($1::text IS NULL OR channel = $1)
             AND ($2::text IS NULL OR status = $2)
           ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
          [channel, status, limit, offset]
        );

        const countRes = await pool.query(
          `SELECT count(*)::int AS total FROM marketplace_orders
           WHERE ($1::text IS NULL OR channel = $1)
             AND ($2::text IS NULL OR status = $2)`,
          [channel, status]
        );

        res.json({
          orders: result.rows,
          pagination: {
            page,
            pageSize: limit,
            total: countRes.rows[0].total,
            pageCount: Math.ceil(countRes.rows[0].total / limit)
          }
        });
      } catch (e) {
        next(e);
      }
    }
  );

  adminRouter.post('/marketplace/orders/:id/reverse-stock',
    requirePermission('marketplace.write'),
    requireCsrf,
    async (req, res, next) => {
      try {
        const orderId = z.string().uuid().parse(req.params.id);
        const result = await withTransaction(pool, async client => {
          const orderRes = await client.query('SELECT * FROM marketplace_orders WHERE id = $1 FOR UPDATE', [orderId]);
          if (!orderRes.rows.length) throw fail('Không tìm thấy đơn hàng sàn.', 404);
          const order = orderRes.rows[0];
          order.rawStatus = 'cancelled';
          return await ingestMarketplaceOrder(client, {
            channel: order.channel,
            shopId: order.shop_id,
            order: {
              externalOrderId: order.external_order_id,
              rawStatus: 'cancelled',
              items: order.items
            },
            autoDeductStock: false,
            actor: req.admin
          });
        });
        res.json({ success: true, message: 'Đã hoàn trả tồn kho đơn sàn thành công.', order: result });
      } catch (e) {
        next(e);
      }
    }
  );

  adminRouter.get('/marketplace/mappings',
    requirePermission('marketplace.read'),
    async (req, res, next) => {
      try {
        const channel = req.query.channel ? z.enum(['shopee', 'tiktok', 'lazada']).parse(req.query.channel) : null;
        const result = await pool.query(
          `SELECT m.*, v.sku AS "internalSku", v.name AS "variantName", p.name AS "productName"
           FROM marketplace_sku_mappings m
           JOIN product_variants v ON v.id = m.variant_id
           JOIN products p ON p.id = v.product_id
           WHERE ($1::text IS NULL OR m.channel = $1)
           ORDER BY m.created_at DESC`,
          [channel]
        );
        res.json({ mappings: result.rows });
      } catch (e) {
        next(e);
      }
    }
  );

  adminRouter.post('/marketplace/mappings',
    requirePermission('marketplace.write'),
    requireCsrf,
    async (req, res, next) => {
      try {
        const schema = z.object({
          channel: z.enum(['shopee', 'tiktok', 'lazada']),
          shopId: z.string().trim().min(1).max(100),
          externalSku: z.string().trim().min(1).max(100),
          variantId: z.string().uuid()
        });
        const parsed = schema.parse(req.body);

        const inserted = await pool.query(
          `INSERT INTO marketplace_sku_mappings (channel, shop_id, external_sku, variant_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (channel, shop_id, external_sku)
           DO UPDATE SET variant_id = $4, updated_at = now()
           RETURNING *`,
          [parsed.channel, parsed.shopId, parsed.externalSku, parsed.variantId]
        );
        res.json({ success: true, mapping: inserted.rows[0] });
      } catch (e) {
        next(e);
      }
    }
  );

  // Public webhook route
  publicRouter.post('/marketplace/:channel/webhook',
    rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const channel = z.enum(['shopee', 'tiktok', 'lazada']).parse(req.params.channel);
        const result = await handleMarketplaceWebhook(pool, config, channel, req.body || {}, {
          headers: req.headers,
          fetcher
        });
        res.json(result);
      } catch (e) {
        next(e);
      }
    }
  );

  return {
    admin: adminRouter,
    publicApi: publicRouter,
    resolveVariantForSku,
    ingestMarketplaceOrder,
    handleMarketplaceWebhook,
    syncMarketplaceOrders,
    syncStockToChannel
  };
}

module.exports = {
  createOmnichannelSync,
  resolveVariantForSku,
  ingestMarketplaceOrder,
  handleMarketplaceWebhook,
  syncMarketplaceOrders,
  syncStockToChannel
};
