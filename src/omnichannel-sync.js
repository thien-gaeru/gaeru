const { Router } = require('express');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { withTransaction } = require('./db');
const { requireCsrf } = require('./security');
const { requirePermission } = require('./staff-access');
const { readRecord, writeRecord } = require('./admin-configuration');
const account = require('./marketplace-account');
const {randomUUID}=require('node:crypto');
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
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`marketplace-order:${channel}:${shopId}:${order.externalOrderId}`]);
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

  // Case A: Order confirmed / processing / shipped ➔ Deduct stock atomically across warehouse_stock & product_variants
  if (autoDeductStock && ['confirmed', 'processing', 'shipped', 'completed'].includes(normStatus) && !marketplaceOrder.stock_deducted) {
    let anyDeducted = false;
    const enrichedItems = [];
    for (const item of items) {
      const variantId = await resolveVariantForSku(client, channel, shopId, item.externalSku);
      const requestedQty = Math.max(1, Math.floor(Number(item.quantity) || 1));
      if (!variantId) {
        enrichedItems.push({ ...item, deductedQuantity: 0 });
        continue;
      }
      const varLock = (await client.query(
        'SELECT id, stock_quantity FROM product_variants WHERE id = $1 FOR UPDATE',
        [variantId]
      )).rows[0];
      if (!varLock) {
        enrichedItems.push({ ...item, variantId, deductedQuantity: 0 });
        continue;
      }

      const whRows = (await client.query(
        `SELECT ws.warehouse_id, ws.quantity
         FROM warehouse_stock ws
         JOIN warehouses w ON w.id = ws.warehouse_id
         WHERE ws.variant_id = $1 AND w.active = true
         ORDER BY (w.code = 'MAIN') DESC, ws.quantity DESC
         FOR UPDATE OF ws`,
        [variantId]
      )).rows;

      let actualDeducted = 0;
      const warehouseAllocations = [];
      if (whRows.length > 0) {
        let remaining = Math.min(requestedQty, Math.max(0, Number(varLock.stock_quantity) || 0));
        for (const wh of whRows) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, Math.max(0, Number(wh.quantity) || 0));
          if (take <= 0) continue;
          await client.query(
            'UPDATE warehouse_stock SET quantity = quantity - $3, updated_at = now() WHERE warehouse_id = $1 AND variant_id = $2',
            [wh.warehouse_id, variantId, take]
          );
          warehouseAllocations.push({ warehouseId: wh.warehouse_id, quantity: take });
          actualDeducted += take;
          remaining -= take;
        }
      } else {
        actualDeducted = Math.min(requestedQty, Math.max(0, Number(varLock.stock_quantity) || 0));
      }

      if (actualDeducted > 0) {
        anyDeducted = true;
        await client.query(
          `UPDATE product_variants
           SET stock_quantity = GREATEST(0, stock_quantity - $2), updated_at = now()
           WHERE id = $1`,
          [variantId, actualDeducted]
        );

        const eventKey = `marketplace-sale:${channel}:${shopId}:${order.externalOrderId}:${variantId}`;
        await client.query(
          `INSERT INTO marketplace_sync_events (channel, event_type, external_order_id, event_key, payload, processed)
           VALUES ($1, 'stock_deduction', $2, $3, $4, true)
           ON CONFLICT (event_key) DO NOTHING`,
          [channel, order.externalOrderId, eventKey, JSON.stringify({ variantId, quantity: actualDeducted, warehouseAllocations })]
        );
      }
      enrichedItems.push({ ...item, variantId, deductedQuantity: actualDeducted, warehouseAllocations });
    }
    if (anyDeducted || items.length > 0) {
      await client.query(
        `UPDATE marketplace_orders SET stock_deducted = true, items = $2::jsonb, updated_at = now() WHERE id = $1`,
        [marketplaceOrder.id, JSON.stringify(enrichedItems)]
      );
      marketplaceOrder.stock_deducted = true;
      marketplaceOrder.items = enrichedItems;
      try { require('../cache').flushAllCache(); } catch {}
    }
  }

  // Case B: Order cancelled or returned ➔ REVERSE STOCK LEDGER (HOÀN TỒN ĐƠN SÀN HỦY/TRẢ)
  if (['cancelled', 'returned'].includes(normStatus) && marketplaceOrder.stock_deducted && !marketplaceOrder.stock_reversed) {
    const sourceItems = Array.isArray(marketplaceOrder.items) ? marketplaceOrder.items : items;
    for (const item of sourceItems) {
      const variantId = item.variantId || await resolveVariantForSku(client, channel, shopId, item.externalSku);
      const qty = item.deductedQuantity !== undefined
        ? Math.max(0, Math.floor(Number(item.deductedQuantity) || 0))
        : Math.max(1, Math.floor(Number(item.quantity) || 1));
      if (variantId && qty > 0) {
        if (Array.isArray(item.warehouseAllocations) && item.warehouseAllocations.length > 0) {
          for (const alloc of item.warehouseAllocations) {
            if (!alloc?.warehouseId || !(Number(alloc.quantity) > 0)) continue;
            await client.query(
              'UPDATE warehouse_stock SET quantity = quantity + $3, updated_at = now() WHERE warehouse_id = $1 AND variant_id = $2',
              [alloc.warehouseId, variantId, Number(alloc.quantity)]
            );
          }
        }
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
    try { require('../cache').flushAllCache(); } catch {}

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

  const rawEventId = String(payload.event_id || payload.eventId || payload.request_id || payload.timestamp || payload.create_time || '').trim();
  const eventKey = rawEventId
    ? `${channel}:${externalOrderId}:${rawStatus}:${rawEventId}`
    : `${channel}:${externalOrderId}:${rawStatus}`;

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
async function recordSync(pool,channel,type,result,actor) {
  const summary={syncedCount:result.syncedCount||0,updatedCount:result.updatedCount||0,failedCount:result.failedCount||0,skippedCount:result.skippedCount||0};
  await pool.query(`INSERT INTO marketplace_sync_events(channel,event_type,event_key,payload,processed,error_message) VALUES($1,$2,$3,$4,$5,$6)`,[channel,type,'manual:'+randomUUID(),JSON.stringify(summary),result.success!==false,result.success===false?'Một hoặc nhiều mục chưa đồng bộ; xem chi tiết kết quả.':null]);
  await appendAudit(pool,{actor,action:'marketplace.'+type,entityType:'marketplace',entityId:channel,metadata:summary});
}
async function syncMarketplaceOrders(pool, config, channel, { fetcher = fetch, actor, autoDeductStock=false, days=3 } = {}) {
  const record=await readRecord(pool,config,channel),creds=account.credentials(channel,record.data);
  const start=Math.floor(Date.now()/1000)-days*86400;const orders=await getConnector(channel).fetchOrders({...account.transportCredentials(channel,creds),timeFrom:start,createTimeFrom:start,createdAfter:new Date(start*1000).toISOString()},{fetcher});
  let syncedCount=0;
  for(const order of orders){
    if(!order.externalOrderId||!Array.isArray(order.items)||!order.items.length)throw fail('Sàn chưa trả đầy đủ chi tiết sản phẩm của đơn. Không ghi đơn thiếu dữ liệu.',502);
    await withTransaction(pool,client=>ingestMarketplaceOrder(client,{channel,shopId:creds.shopId,order,autoDeductStock,actor}));syncedCount++;
  }
  const result={success:true,channel,syncedCount,autoDeductStock,windowDays:days};await recordSync(pool,channel,'sync_orders',result,actor);return result;
}
async function syncStockToChannel(pool, config, channel, { variantId, fetcher = fetch, actor } = {}) {
  const record=await readRecord(pool,config,channel),creds=account.credentials(channel,record.data);
  if(!account.connection(channel,record).verified)throw fail('Kiểm tra kết nối đọc thành công với cấu hình hiện tại trước khi gửi tồn kho lên sàn.');
  const connector=getConnector(channel),base=account.transportCredentials(channel,creds);
  const variants=(await pool.query(`SELECT v.id,v.sku,v.stock_quantity AS "stockQuantity",m.id AS "mappingId",m.external_sku AS "externalSku",m.external_product_id AS "externalProductId",m.external_variant_id AS "externalVariantId"
   FROM product_variants v JOIN products p ON p.id=v.product_id LEFT JOIN marketplace_sku_mappings m ON m.variant_id=v.id AND m.channel=$1 AND m.shop_id=$3
   WHERE ($2::uuid IS NULL OR v.id=$2) AND v.active=true AND p.active=true AND p.deleted_at IS NULL ORDER BY v.sku,m.external_sku`,[channel,variantId||null,creds.shopId])).rows;
  let updatedCount=0,failedCount=0,skippedCount=0;const results=[];
  for(const v of variants){
    if(!v.mappingId||(channel!=='lazada'&&!v.externalProductId)||(channel==='tiktok'&&!v.externalVariantId)){
      skippedCount++;results.push({sku:v.sku,state:'skipped',message:'Chưa có mapping và ID sản phẩm/biến thể sàn đầy đủ.'});continue;
    }
    try{
      const r=await connector.updateStock(channel==='shopee'?{...base,itemId:v.externalProductId,modelId:v.externalVariantId||'0',stock:v.stockQuantity}:channel==='tiktok'?{...base,productId:v.externalProductId,skuId:v.externalVariantId,availableStock:v.stockQuantity}:{...base,sku:v.externalSku,quantity:v.stockQuantity},{fetcher});
      if(r?.success!==true)throw fail('Sàn chưa xác nhận cập nhật tồn kho.',502);
      updatedCount++;results.push({sku:v.sku,state:'updated',message:'Sàn đã xác nhận cập nhật.'});
    }catch{failedCount++;results.push({sku:v.sku,state:'failed',message:'Sàn chưa xác nhận cập nhật. Kiểm tra token, quyền và ID mapping rồi thử lại.'});}
  }
  const result={success:failedCount===0&&skippedCount===0,channel,updatedCount,failedCount,skippedCount,results};await recordSync(pool,channel,'sync_stock',result,actor);return result;
}

// -----------------------------------------------------------------------------
// 5. ROUTER FACTORY
// -----------------------------------------------------------------------------
function createOmnichannelSync(pool, config, { fetcher = fetch } = {}) {
  const adminRouter = Router();
  const publicRouter = Router();

  // Admin routes
  adminRouter.get('/marketplace/connections',requirePermission('marketplace.read'),async(req,res,next)=>{try{const connections=[];for(const channel of account.channels)connections.push(account.connection(channel,await readRecord(pool,config,channel)));res.json({connections});}catch(e){next(e);}});
  adminRouter.post('/marketplace/:channel/verify',requirePermission('marketplace.write'),requireCsrf,rateLimit({windowMs:900000,limit:12,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{
    try{
      const channel=z.enum(account.channels).parse(req.params.channel);
      if(req.admin?.role!=='owner'||req.admin?.source!=='bootstrap'||!config.accountSecurity)throw fail('Chỉ chủ doanh nghiệp được xác minh khóa kết nối.',403);
      const snapshot=await config.accountSecurity.authorize(req,async(_a,c)=>{const record=await readRecord(c,config,channel);account.credentials(channel,record.data);return record;});
      await getConnector(channel).fetchOrders({...account.transportCredentials(channel,snapshot.data),verifyOnly:true},{fetcher});
      const saved=await withTransaction(pool,async c=>{const current=await readRecord(c,config,channel);if(current.version!==snapshot.version||account.fingerprint(channel,current.data)!==account.fingerprint(channel,snapshot.data))throw fail('Cấu hình vừa thay đổi. Kiểm tra lại.');return writeRecord(c,config,channel,{...current.data,connectionVerifiedAt:new Date().toISOString(),verificationFingerprint:account.fingerprint(channel,current.data)},current.version,req.admin);});
      res.json({message:'Sàn đã xác nhận quyền đọc đơn hàng. Chưa tạo hay sửa đơn/tồn kho.',connection:account.connection(channel,saved)});
    }catch(e){if(e.status&&e.status<500)return next(e);next(fail('Chưa xác minh được quyền đọc tại sàn. Kiểm tra token, gian hàng, quyền API và hạn token.',502));}
  });
  adminRouter.get('/marketplace/catalog',requirePermission('marketplace.read'),async(req,res,next)=>{try{const q=z.string().trim().max(100).parse(req.query.q||'');const variants=(await pool.query(`SELECT v.id,v.sku,v.name AS "variantName",p.name AS "productName" FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.deleted_at IS NULL AND (v.sku ILIKE $1 OR v.name ILIKE $1 OR p.name ILIKE $1) ORDER BY p.name,v.sku LIMIT 50`,['%'+q+'%'])).rows;res.json({variants});}catch(e){next(e);}});
  adminRouter.get('/marketplace/events',requirePermission('marketplace.read'),async(req,res,next)=>{try{const channel=z.enum(account.channels).parse(req.query.channel||'shopee');const events=(await pool.query(`SELECT id,event_type,processed,error_message,created_at,payload FROM marketplace_sync_events WHERE channel=$1 AND event_type IN ('sync_orders','sync_stock') ORDER BY created_at DESC LIMIT 30`,[channel])).rows;res.json({events});}catch(e){next(e);}});
  adminRouter.delete('/marketplace/mappings/:id',requirePermission('marketplace.write'),requireCsrf,async(req,res,next)=>{try{const id=z.string().uuid().parse(req.params.id);await withTransaction(pool,async c=>{const old=(await c.query('DELETE FROM marketplace_sku_mappings WHERE id=$1 RETURNING channel,shop_id',[id])).rows[0];if(!old)throw fail('Mapping không còn tồn tại.',404);await appendAudit(c,{actor:req.admin,action:'marketplace.mapping.delete',entityType:'marketplace_mapping',entityId:id,metadata:{channel:old.channel,shopId:old.shop_id}});});res.json({success:true});}catch(e){next(e);}});

  adminRouter.post('/marketplace/:channel/sync-orders',
    requirePermission('marketplace.write'),
    requireCsrf,
    rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const channel = z.enum(['shopee', 'tiktok', 'lazada']).parse(req.params.channel);
        const result = await syncMarketplaceOrders(pool, config, channel, { fetcher, actor: req.admin, autoDeductStock:z.boolean().default(false).parse(req.body?.autoDeductStock),days:z.number().int().min(1).max(3).default(3).parse(req.body?.days) });
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
          variantId: z.string().uuid(),
          externalProductId:z.string().trim().regex(/^[a-zA-Z0-9_-]{0,100}$/).default(''),
          externalVariantId:z.string().trim().regex(/^[a-zA-Z0-9_-]{0,100}$/).default('')
        }).strict();
        const parsed = schema.parse(req.body);

        if(parsed.channel==='shopee'&&((parsed.externalProductId&&!/^\d+$/.test(parsed.externalProductId))||(parsed.externalVariantId&&!/^\d+$/.test(parsed.externalVariantId))))throw fail('Shopee Item ID và Model ID phải là số.');
        const inserted=await withTransaction(pool,async client=>{
          const exists=(await client.query('SELECT v.id FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND p.deleted_at IS NULL',[parsed.variantId])).rows[0];if(!exists)throw fail('Không tìm thấy biến thể nội bộ.',404);
          const result=await client.query(`INSERT INTO marketplace_sku_mappings(channel,shop_id,external_sku,variant_id,external_product_id,external_variant_id) VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(channel,shop_id,external_sku) DO UPDATE SET variant_id=$4,external_product_id=$5,external_variant_id=$6,updated_at=now() RETURNING *`,[parsed.channel,parsed.shopId,parsed.externalSku,parsed.variantId,parsed.externalProductId,parsed.externalVariantId]);
          await appendAudit(client,{actor:req.admin,action:'marketplace.mapping.save',entityType:'marketplace_mapping',entityId:result.rows[0].id,metadata:{channel:parsed.channel,shopId:parsed.shopId,variantId:parsed.variantId}});return result;
        });
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
