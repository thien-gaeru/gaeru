const { Router } = require('express');
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
      const found = await pool.query('SELECT id FROM customers WHERE id=$1 AND active=true', [id]);
      if (!found.rows.length) {
        return res.status(401).json({ error: 'Tài khoản không còn hoạt động.' });
      }
      req.customerId = id;
      next();
    } catch (e) {
      next(e);
    }
  });

  // POST /api/customer/cart/check-prices: Đối chiếu giá niêm yết hiện hành với giá giỏ hàng
  router.post('/check-prices', async (req, res, next) => {
    try {
      const itemsToCheck = Array.isArray(req.body?.items) ? req.body.items : [];
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
      const dbItems = cartQuery.rows;
      const priceChanges = [];
      let totalCurrentVnd = 0;

      for (const item of dbItems) {
        totalCurrentVnd += item.priceVnd * item.quantity;
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
        currentSubtotalVnd: totalCurrentVnd,
        items: dbItems.map((r) => ({
          variantId: r.variantId,
          quantity: r.quantity,
          priceVnd: r.priceVnd,
          stockQuantity: r.stockQuantity,
          productName: r.productName,
          variantName: r.variantName
        }))
      });
    } catch (e) {
      next(e);
    }
  });

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
      res.json({
        items: result.rows.map(r => ({
          variantId: r.variantId,
          quantity: r.quantity,
          stockQuantity: r.stockQuantity,
          priceVnd: r.priceVnd,
          variantName: r.variantName,
          productName: r.productName,
          productSlug: r.productSlug
        }))
      });
    } catch (e) {
      next(e);
    }
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
        return (await client.query(
          `SELECT variant_id AS "variantId", quantity
           FROM customer_cart_items
           WHERE customer_id=$1 ORDER BY updated_at DESC`,
          [req.customerId]
        )).rows;
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

        for (const item of localItems) {
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

        return (await client.query(
          `SELECT c.variant_id AS "variantId", c.quantity
           FROM customer_cart_items c
           JOIN product_variants pv ON pv.id = c.variant_id
           JOIN products p ON p.id = pv.product_id
           WHERE c.customer_id = $1 AND pv.active = true AND p.active = true
           ORDER BY c.updated_at DESC`,
          [req.customerId]
        )).rows;
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
        await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [req.customerId]);
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
