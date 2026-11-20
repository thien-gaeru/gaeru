const { Router } = require('express');
const { createHash } = require('node:crypto');
const { z } = require('zod');
const { requireCsrf } = require('./security');
const { withTransaction } = require('./db');

const cartItemSchema = z.object({
  variantId: z.string().uuid(),
  quantity: z.number().int().min(1).max(99)
}).strict();

const syncCartSchema = z.object({
  items: z.array(cartItemSchema).max(100)
}).strict();

const mergeCartSchema = z.object({
  localItems: z.array(cartItemSchema).max(100).default([])
}).strict();

const cartOperationSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{20,80}$/),
  kind: z.enum(['change','import','legacy']),
  items: z.array(z.object({
    variantId: z.string().uuid(),
    quantity: z.number().int().min(-99).max(99)
  }).strict()).max(200)
}).strict().refine(op =>
  new Set(op.items.map(i=>i.variantId)).size===op.items.length &&
  op.items.every(i=>op.kind==="change" ? i.quantity!==0 : i.quantity>0)
);

const cartUpdateSchema = z.object({
  customerId: z.string().uuid(),
  operations: z.array(cartOperationSchema).max(25)
}).strict();

async function markLegacyCart(client, req, items) {
  if(!req.sessionID || !items.length) return true;
  const sorted=items.map(i=>[i.variantId,i.quantity]).sort(([a],[b])=>a.localeCompare(b));
  const id='v2-'+createHash('sha256').update(JSON.stringify([req.sessionID,req.customerId,sorted])).digest('hex');
  const result=await client.query(
    'INSERT INTO customer_cart_operations(operation_id,customer_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING operation_id',
    [id,req.customerId]
  );
  return result.rows.length>0;
}

function createCustomerCartRouter(pool) {
  const router = Router();

  // Authentication check for all customer cart routes
  router.use(async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const id = req.session?.customer?.id;
      if (!id) {
        return res.status(401).json({ error: 'Vui lòng đăng nhập để đồng bộ giỏ hàng.' });
      }
      const found = await pool.query('SELECT id FROM customers WHERE id=$1 AND active=true AND deleted_at IS NULL', [id]);
      if (!found.rows.length) {
        return res.status(401).json({ error: 'Tài khoản không còn hoạt động.' });
      }
      req.customerId = id;
      next();
    } catch (e) {
      next(e);
    }
  });

  // GET / POST /api/customer/cart/check-prices: Đối chiếu giá niêm yết hiện hành (kèm promo + combo) với giá giỏ hàng
  const handleCheckPrices = async (req, res, next) => {
    try {
      const itemsSchema = z.array(z.object({
        variantId: z.string().uuid().optional(),
        expectedPriceVnd: z.number().finite().min(0).max(2000000000).optional()
      }).passthrough()).max(100);
      const rawItems = req.body?.items;
      const parsedItems = rawItems === undefined ? [] : itemsSchema.safeParse(rawItems);
      if (rawItems !== undefined && !parsedItems.success) {
        return res.status(400).json({ error: 'Danh sách kiểm tra giá không hợp lệ.' });
      }
      const itemsToCheck = rawItems === undefined ? [] : parsedItems.data;
      const cartQuery = await pool.query(
        `SELECT c.variant_id AS "variantId", c.quantity,
                pv.stock_quantity AS "stockQuantity", pv.price_vnd AS "priceVnd",
                pv.name AS "variantName", p.name AS "productName"
         FROM customer_cart_items c
         JOIN product_variants pv ON pv.id = c.variant_id
         JOIN products p ON p.id = pv.product_id
         WHERE c.customer_id = $1 AND pv.active = true AND p.active = true AND p.deleted_at IS NULL`,
        [req.customerId]
      );
      const rawItemsWithId = cartQuery.rows.map((r) => ({ ...r, id: r.variantId }));
      const dbItems = await require('./product-promotions').applyPromotions(pool, rawItemsWithId);
      const bundlePricing = await require('./product-bundles').calculateCartBundleDiscount(pool, dbItems);
      const priceChanges = [];

      for (const item of dbItems) {
        const expected = itemsToCheck.find((i) => i.variantId === item.variantId);
        if (expected && expected.expectedPriceVnd !== undefined && Number(expected.expectedPriceVnd) !== item.priceVnd) {
          priceChanges.push({
            variantId: item.variantId,
            productName: item.productName,
            variantName: item.variantName,
            oldPriceVnd: Number(expected.expectedPriceVnd),
            currentPriceVnd: item.priceVnd,
            differenceVnd: item.priceVnd - Number(expected.expectedPriceVnd)
          });
        }
      }

      res.json({
        hasPriceChanges: priceChanges.length > 0,
        priceChanges,
        currentSubtotalVnd: bundlePricing.finalSubtotalVnd,
        bundleDiscountVnd: bundlePricing.bundleDiscountVnd,
        appliedBundles: bundlePricing.appliedBundles,
        items: dbItems.map((r) => ({
          variantId: r.variantId,
          quantity: r.quantity,
          priceVnd: r.priceVnd,
          originalPriceVnd: r.originalPriceVnd,
          promotion: r.promotion || null,
          stockQuantity: r.stockQuantity,
          productName: r.productName,
          variantName: r.variantName
        }))
      });
    } catch (e) {
      next(e);
    }
  };
  router.get('/check-prices', handleCheckPrices);
  router.post('/check-prices', (req, res, next) => (req.session?.csrfToken ? requireCsrf(req, res, next) : next()), handleCheckPrices);

  // GET /api/customer/cart: Lấy toàn bộ sản phẩm trong giỏ hàng trên máy chủ
  router.get('/', async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT c.variant_id AS "variantId", c.quantity,
                pv.stock_quantity AS "stockQuantity", pv.price_vnd AS "priceVnd",
                pv.name AS "variantName", p.name AS "productName", p.slug AS "productSlug"
         FROM customer_cart_items c
         JOIN product_variants pv ON pv.id = c.variant_id
         JOIN products p ON p.id = pv.product_id
         WHERE c.customer_id = $1 AND pv.active = true AND p.active = true AND p.deleted_at IS NULL
         ORDER BY c.updated_at DESC`,
        [req.customerId]
      );
      const promoted = await require('./product-promotions').applyPromotions(
        pool,
        result.rows.map((r) => ({ ...r, id: r.variantId }))
      );
      res.json({
        items: promoted.map(r => ({
          variantId: r.variantId,
          quantity: r.quantity,
          stockQuantity: r.stockQuantity,
          priceVnd: r.priceVnd,
          originalPriceVnd: r.originalPriceVnd,
          promotion: r.promotion || null,
          variantName: r.variantName,
          productName: r.productName,
          productSlug: r.productSlug
        }))
      });
    } catch (e) {
      next(e);
    }
  });

  // Replaying an acknowledged browser operation must never reapply a quantity delta.
  router.post('/sync', requireCsrf, async (req, res, next) => {
    const parsed = cartUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Thay đổi giỏ hàng không hợp lệ.' });
    if (parsed.data.customerId !== req.customerId) return res.status(409).json({ error: 'Tài khoản đã thay đổi. Vui lòng tải lại trang.' });
    try {
      const result = await withTransaction(pool, async client => {
        const owner = (await client.query('SELECT cart_revision FROM customers WHERE id=$1 FOR UPDATE', [req.customerId])).rows[0];
        let revision = Number(owner.cart_revision);
        for (const op of parsed.data.operations) {
          const claim = await client.query(
            'INSERT INTO customer_cart_operations(operation_id,customer_id) VALUES ($1,$2) ON CONFLICT (operation_id) DO NOTHING RETURNING operation_id',
            [op.id, req.customerId]
          );
          if (!claim.rows.length) continue;
          await client.query(
            `WITH incoming AS (SELECT * FROM unnest($2::uuid[],$3::int[]) AS i(id,qty)),
               totals AS (
                 SELECT i.id, LEAST(99,CASE WHEN $4::text='legacy'
                   THEN GREATEST(COALESCE(c.quantity,0),i.qty) ELSE COALESCE(c.quantity,0)+i.qty END) AS qty
                 FROM incoming i JOIN product_variants v ON v.id=i.id AND v.active
                 JOIN products p ON p.id=v.product_id AND p.active AND p.deleted_at IS NULL
                 LEFT JOIN customer_cart_items c ON c.customer_id=$1 AND c.variant_id=i.id
               ), removed AS (
                 DELETE FROM customer_cart_items c USING totals t
                 WHERE c.customer_id=$1 AND c.variant_id=t.id AND t.qty<=0
               )
             INSERT INTO customer_cart_items(customer_id,variant_id,quantity)
             SELECT $1,id,qty FROM totals WHERE qty>0
             ON CONFLICT(customer_id,variant_id) DO UPDATE SET quantity=excluded.quantity,updated_at=now()`,
            [req.customerId,op.items.map(i=>i.variantId),op.items.map(i=>i.quantity),op.kind]
          );
          revision++;
        }
        if (revision !== Number(owner.cart_revision)) await client.query('UPDATE customers SET cart_revision=$2 WHERE id=$1',[req.customerId,revision]);
        const rows = (await client.query(
          `SELECT c.variant_id AS "variantId",c.quantity FROM customer_cart_items c
           JOIN product_variants v ON v.id=c.variant_id JOIN products p ON p.id=v.product_id
           WHERE c.customer_id=$1 AND v.active AND p.active AND p.deleted_at IS NULL ORDER BY c.variant_id`, [req.customerId]
        )).rows;
        return {customerId:req.customerId,revision,items:rows};
      });
      res.json(result);
    } catch (error) { next(error); }
  });

  // PUT /api/customer/cart: Đồng bộ ghi đè giỏ hàng từ máy khách lên máy chủ
  router.put('/', requireCsrf, async (req, res, next) => {
    const parsed = syncCartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dữ liệu giỏ hàng không hợp lệ.' });
    }
    try {
      const items = parsed.data.items;
      const current = await withTransaction(pool, async client => {
        await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [req.customerId]);
        await client.query('DELETE FROM customer_cart_items WHERE customer_id=$1', [req.customerId]);
        const mergedPut = new Map();
        for (const item of items) {
          mergedPut.set(item.variantId, Math.min(99, (mergedPut.get(item.variantId) || 0) + item.quantity));
        }
        for (const [variantId, quantity] of mergedPut.entries()) {
          const variant = (await client.query(
            'SELECT pv.id FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.id=$1 AND pv.active=true AND p.active=true AND p.deleted_at IS NULL',
            [variantId]
          )).rows[0];
          if (variant) {
            await client.query(
              `INSERT INTO customer_cart_items(customer_id, variant_id, quantity, updated_at)
               VALUES ($1, $2, $3, now())
               ON CONFLICT (customer_id, variant_id) DO UPDATE SET quantity=EXCLUDED.quantity, updated_at=now()`,
              [req.customerId, variantId, quantity]
            );
          }
        }
        const snapshot = (await client.query(
          `SELECT variant_id AS "variantId", quantity
           FROM customer_cart_items
           WHERE customer_id=$1 ORDER BY updated_at DESC`,
          [req.customerId]
        )).rows;
        await markLegacyCart(client,req,snapshot);
        return snapshot;
      });
      res.json({ message: 'Đã đồng bộ giỏ hàng.', items: current });
    } catch (e) {
      next(e);
    }
  });

  // POST /api/customer/cart/merge: Chiến lược hợp nhất thông minh giữa giỏ hàng cục bộ và giỏ hàng máy chủ
  router.post('/merge', requireCsrf, async (req, res, next) => {
    const parsed = mergeCartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Dữ liệu giỏ hàng không hợp lệ.' });
    }
    try {
      const localItems = parsed.data.localItems;
      const merged = await withTransaction(pool, async client => {
        await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [req.customerId]);
        const serverRows = (await client.query(
          'SELECT variant_id AS "variantId", quantity FROM customer_cart_items WHERE customer_id=$1',
          [req.customerId]
        )).rows;
        const serverMap = new Map(serverRows.map(r => [r.variantId, r.quantity]));

        const firstImport=await markLegacyCart(client,req,localItems);
        for (const item of firstImport ? localItems : []) {
          const variant = (await client.query(
            'SELECT pv.id FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.id=$1 AND pv.active=true AND p.active=true AND p.deleted_at IS NULL',
            [item.variantId]
          )).rows[0];
          if (!variant) continue;

          if (serverMap.has(item.variantId)) {
            // Đã có ở cả 2 nơi: cộng dồn số lượng và chặn trần 99 sản phẩm
            const combined = Math.min(99, serverMap.get(item.variantId) + item.quantity);
            serverMap.set(item.variantId, combined);
            await client.query(
              'UPDATE customer_cart_items SET quantity=$1, updated_at=now() WHERE customer_id=$2 AND variant_id=$3',
              [combined, req.customerId, item.variantId]
            );
          } else {
            // Mới thêm ở thiết bị này: bổ sung vào giỏ hàng máy chủ
            serverMap.set(item.variantId, item.quantity);
            await client.query(
              'INSERT INTO customer_cart_items(customer_id, variant_id, quantity, updated_at) VALUES($1, $2, $3, now())',
              [req.customerId, item.variantId, item.quantity]
            );
          }
        }

        const snapshot = (await client.query(
          `SELECT c.variant_id AS "variantId", c.quantity
           FROM customer_cart_items c
           JOIN product_variants pv ON pv.id = c.variant_id
           JOIN products p ON p.id = pv.product_id
           WHERE c.customer_id = $1 AND pv.active = true AND p.active = true
           ORDER BY c.updated_at DESC`,
          [req.customerId]
        )).rows;
        await markLegacyCart(client,req,snapshot);
        return snapshot;
      });
      res.json({ message: 'Đã hợp nhất giỏ hàng thành công.', items: merged });
    } catch (e) {
      next(e);
    }
  });

  // POST /api/customer/cart/item: Thêm hoặc tăng số lượng sản phẩm
  router.post('/item', requireCsrf, async (req, res, next) => {
    const parsed = cartItemSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Kiểm tra thông tin sản phẩm và số lượng.' });
    }
    try {
      const { variantId, quantity } = parsed.data;
      const variant = (await pool.query(
        'SELECT id FROM product_variants WHERE id=$1 AND active=true',
        [variantId]
      )).rows[0];
      if (!variant) {
        return res.status(404).json({ error: 'Phiên bản sản phẩm không còn kinh doanh.' });
      }

      await withTransaction(pool, async client => {
        const cust = (await client.query('SELECT id FROM customers WHERE id=$1 AND active=true AND deleted_at IS NULL FOR UPDATE', [req.customerId])).rows[0];
        if (!cust) {
          throw Object.assign(new Error('Tài khoản không còn hoạt động.'), { status: 401 });
        }
        const existing = (await client.query(
          'SELECT quantity FROM customer_cart_items WHERE customer_id=$1 AND variant_id=$2',
          [req.customerId, variantId]
        )).rows[0];

        if (existing) {
          const newQty = Math.min(99, existing.quantity + quantity);
          await client.query(
            'UPDATE customer_cart_items SET quantity=$1, updated_at=now() WHERE customer_id=$2 AND variant_id=$3',
            [newQty, req.customerId, variantId]
          );
        } else {
          await client.query(
            'INSERT INTO customer_cart_items(customer_id, variant_id, quantity, updated_at) VALUES($1, $2, $3, now())',
            [req.customerId, variantId, quantity]
          );
        }
      });
      res.json({ message: 'Đã thêm vào giỏ hàng.' });
    } catch (e) {
      next(e);
    }
  });

  // DELETE /api/customer/cart/item/:variantId: Xóa một sản phẩm khỏi giỏ
  router.delete('/item/:variantId', requireCsrf, async (req, res, next) => {
    if (!z.string().uuid().safeParse(req.params.variantId).success) {
      return res.status(400).json({ error: 'Mã phiên bản không hợp lệ.' });
    }
    try {
      await pool.query(
        'DELETE FROM customer_cart_items WHERE customer_id=$1 AND variant_id=$2',
        [req.customerId, req.params.variantId]
      );
      res.json({ message: 'Đã xóa sản phẩm khỏi giỏ hàng.' });
    } catch (e) {
      next(e);
    }
  });

  // DELETE /api/customer/cart: Xóa toàn bộ giỏ hàng
  router.delete('/', requireCsrf, async (req, res, next) => {
    try {
      await pool.query('DELETE FROM customer_cart_items WHERE customer_id=$1', [req.customerId]);
      res.json({ message: 'Đã xóa toàn bộ giỏ hàng.' });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createCustomerCartRouter };
