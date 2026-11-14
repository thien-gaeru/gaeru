const { z } = require('zod');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');
const { withTransaction } = require('./db');
const { appendAudit } = require('./audit');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const itemSchema = z.object({
  variantId: z.string().uuid(),
  isPrimary: z.boolean().default(false),
  minQuantity: z.number().int().min(1).max(99).default(1)
});

const bundleSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(500).nullable().default(null),
  discountType: z.enum(['fixed', 'percent']),
  discountValue: z.number().int().min(1).max(20000000),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  active: z.boolean().default(true),
  items: z.array(itemSchema).min(2).max(20)
}).strict().refine(d => new Date(d.endsAt) > new Date(d.startsAt) && (d.discountType !== 'percent' || d.discountValue <= 100), {
  message: 'Thời gian kết thúc phải sau bắt đầu, phần trăm giảm tối đa 100%.'
}).refine(d => {
  const ids = new Set(d.items.map(i => i.variantId));
  return ids.size === d.items.length;
}, {
  message: 'Các sản phẩm trong combo không được trùng lặp.'
}).refine(d => {
  const hasPrimary = d.items.some(i => i.isPrimary);
  const hasSecondary = d.items.some(i => !i.isPrimary);
  return hasPrimary && hasSecondary;
}, {
  message: 'Combo phải có ít nhất 1 sản phẩm chính và 1 sản phẩm mua kèm.'
});

/**
 * Calculates bundle discount given a list of prepared cart/order items and a list of active bundles.
 * @param {Array<{ variantId: string, id?: string, priceVnd: number, quantity: number }>} items
 * @param {Array<Object>} bundles
 */
function calculateBundlePricing(items, bundles = []) {
  const itemMap = new Map();
  let subtotalVnd = 0;

  for (const item of items) {
    const vId = item.variantId || item.id;
    const qty = Number(item.quantity) || 1;
    const price = Number(item.priceVnd) || 0;
    subtotalVnd += price * qty;
    itemMap.set(vId, {
      variantId: vId,
      quantity: (itemMap.get(vId)?.quantity || 0) + qty,
      priceVnd: price
    });
  }

  let totalDiscountVnd = 0;
  const appliedBundles = [];

  for (const bundle of bundles) {
    if (!bundle.active) continue;
    const now = new Date();
    if (bundle.starts_at && new Date(bundle.starts_at) > now) continue;
    if (bundle.ends_at && new Date(bundle.ends_at) <= now) continue;

    const bItems = bundle.items || [];
    const primaryItems = bItems.filter(i => i.is_primary ?? i.isPrimary);
    const secondaryItems = bItems.filter(i => !(i.is_primary ?? i.isPrimary));

    // Check if at least one primary item is in the cart with sufficient remaining unallocated quantity
    const matchingPrimary = primaryItems.find(pi => {
      const vId = pi.variant_id ?? pi.variantId;
      const inCart = itemMap.get(vId);
      const reqQty = pi.min_quantity ?? pi.minQuantity ?? 1;
      return inCart && (inCart.quantity - (inCart.usedQuantity || 0)) >= reqQty;
    });

    if (!matchingPrimary) continue;

    // Check if at least one secondary/cross-sell item is in the cart with sufficient remaining unallocated quantity
    const matchingSecondaries = secondaryItems.filter(si => {
      const vId = si.variant_id ?? si.variantId;
      const inCart = itemMap.get(vId);
      const reqQty = si.min_quantity ?? si.minQuantity ?? 1;
      return inCart && (inCart.quantity - (inCart.usedQuantity || 0)) >= reqQty;
    });

    if (!matchingSecondaries.length) continue;

    // Calculate bundle discount & cap against the matched combo items' value
    let discount = 0;
    const discountType = bundle.discount_type ?? bundle.discountType;
    const discountValue = Number(bundle.discount_value ?? bundle.discountValue) || 0;

    const primaryVId = matchingPrimary.variant_id ?? matchingPrimary.variantId;
    const primaryReqQty = matchingPrimary.min_quantity ?? matchingPrimary.minQuantity ?? 1;
    const primaryValue = (itemMap.get(primaryVId)?.priceVnd || 0) * primaryReqQty;
    const secondaryTotal = matchingSecondaries.reduce((sum, si) => {
      const vId = si.variant_id ?? si.variantId;
      const inCart = itemMap.get(vId);
      return sum + ((inCart?.priceVnd || 0) * (si.min_quantity ?? si.minQuantity ?? 1));
    }, 0);
    const matchedBundleItemsValue = primaryValue + secondaryTotal;

    if (discountType === 'percent') {
      discount = Math.floor(secondaryTotal * discountValue / 100);
    } else {
      discount = Math.min(discountValue, matchedBundleItemsValue);
    }

    if (discount > 0) {
      discount = Math.min(discount, matchedBundleItemsValue, subtotalVnd - totalDiscountVnd);
      if (discount <= 0) continue;
      const pEntry = itemMap.get(primaryVId);
      if (pEntry) pEntry.usedQuantity = (pEntry.usedQuantity || 0) + primaryReqQty;
      for (const si of matchingSecondaries) {
        const sEntry = itemMap.get(si.variant_id ?? si.variantId);
        if (sEntry) sEntry.usedQuantity = (sEntry.usedQuantity || 0) + (si.min_quantity ?? si.minQuantity ?? 1);
      }
      totalDiscountVnd += discount;
      appliedBundles.push({
        bundleId: bundle.id,
        title: bundle.title,
        discountType,
        discountValue,
        discountVnd: discount,
        primaryVariantId: matchingPrimary.variant_id ?? matchingPrimary.variantId,
        secondaryVariantIds: matchingSecondaries.map(s => s.variant_id ?? s.variantId)
      });
    }
  }

  const finalTotalVnd = Math.max(0, subtotalVnd - totalDiscountVnd);

  return {
    subtotalVnd,
    bundleDiscountVnd: totalDiscountVnd,
    finalTotalVnd,
    appliedBundles
  };
}

/**
 * Retrieves applicable active bundles for a product by slug or variantId
 */
async function getApplicableBundles(client, { slug = null, variantId = null } = {}) {
  let targetVariantIds = [];
  if (variantId) {
    targetVariantIds = [variantId];
  } else if (slug) {
    const vRows = (await client.query(
      `SELECT v.id FROM product_variants v
       JOIN products p ON p.id = v.product_id
       WHERE (p.slug = $1 OR p.slug = $2) AND v.active = true AND p.active = true AND p.deleted_at IS NULL`,
      [slug, `gaeru-${slug}`]
    )).rows;
    targetVariantIds = vRows.map(r => r.id);
  }

  if (!targetVariantIds.length) return [];

  // Query active bundles where any of targetVariantIds is primary
  const bundleRows = (await client.query(
    `SELECT DISTINCT b.*
     FROM product_bundles b
     JOIN product_bundle_items bi ON bi.bundle_id = b.id
     WHERE bi.variant_id = ANY($1::uuid[])
       AND bi.is_primary = true
       AND b.active = true
       AND b.starts_at <= statement_timestamp()
       AND b.ends_at > statement_timestamp()
     ORDER BY b.created_at DESC`,
    [targetVariantIds]
  )).rows;

  if (!bundleRows.length) return [];

  const bundleIds = bundleRows.map(b => b.id);

  // Fetch all items with variant and product details for these bundles
  const itemRows = (await client.query(
    `SELECT bi.bundle_id, bi.variant_id, bi.is_primary, bi.min_quantity,
            v.sku, v.name AS variant_name, v.price_vnd, v.stock_quantity, v.image_url AS variant_image,
            p.id AS product_id, p.name AS product_name, p.slug AS product_slug, p.image_url AS product_image
     FROM product_bundle_items bi
     JOIN product_variants v ON v.id = bi.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE bi.bundle_id = ANY($1::uuid[])
       AND v.active = true AND p.active = true
     ORDER BY bi.is_primary DESC, bi.created_at ASC`,
    [bundleIds]
  )).rows;

  return bundleRows.map(b => {
    const items = itemRows.filter(i => i.bundle_id === b.id).map(i => ({
      variantId: i.variant_id,
      isPrimary: i.is_primary,
      minQuantity: i.min_quantity,
      sku: i.sku,
      variantName: i.variant_name,
      priceVnd: Number(i.price_vnd),
      stockQuantity: Number(i.stock_quantity),
      productId: i.product_id,
      productName: i.product_name,
      productSlug: i.product_slug,
      imageUrl: i.variant_image || i.product_image
    }));

    const primaryItems = items.filter(i => i.isPrimary);
    const bundledItems = items.filter(i => !i.isPrimary);

    const primaryPrice = primaryItems[0]?.priceVnd || 0;
    const secondaryOriginalTotal = bundledItems.reduce((s, it) => s + it.priceVnd * it.minQuantity, 0);
    const originalComboTotal = primaryPrice + secondaryOriginalTotal;

    let discountVnd = 0;
    if (b.discount_type === 'percent') {
      discountVnd = Math.floor(secondaryOriginalTotal * b.discount_value / 100);
    } else {
      discountVnd = Math.min(originalComboTotal, b.discount_value);
    }

    const discountedComboTotal = Math.max(0, originalComboTotal - discountVnd);

    return {
      id: b.id,
      title: b.title,
      description: b.description,
      discountType: b.discount_type,
      discountValue: b.discount_value,
      discountVnd,
      originalComboTotal,
      discountedComboTotal,
      startsAt: b.starts_at,
      endsAt: b.ends_at,
      primaryItems,
      bundledItems,
      items
    };
  });
}

/**
 * Calculates bundle discount during checkout given the prepared cart items
 */
async function calculateCartBundleDiscount(client, cartItems) {
  if (!cartItems || !cartItems.length) {
    return { bundleDiscountVnd: 0, appliedBundles: [], finalSubtotalVnd: 0 };
  }

  const vIds = cartItems.map(i => i.variantId || i.id);

  // Fetch active bundles that might apply to these variants
  const activeBundles = (await client.query(
    `SELECT DISTINCT b.*
     FROM product_bundles b
     JOIN product_bundle_items bi ON bi.bundle_id = b.id
     WHERE bi.variant_id = ANY($1::uuid[])
       AND b.active = true
       AND b.starts_at <= statement_timestamp()
       AND b.ends_at > statement_timestamp()`,
    [vIds]
  )).rows;

  if (!activeBundles.length) {
    const subtotalVnd = cartItems.reduce((s, i) => s + (i.priceVnd * i.quantity), 0);
    return { bundleDiscountVnd: 0, appliedBundles: [], finalSubtotalVnd: subtotalVnd };
  }

  const bIds = activeBundles.map(b => b.id);
  const items = (await client.query(
    `SELECT bundle_id, variant_id, is_primary, min_quantity
     FROM product_bundle_items
     WHERE bundle_id = ANY($1::uuid[])`,
    [bIds]
  )).rows;

  for (const b of activeBundles) {
    b.items = items.filter(it => it.bundle_id === b.id);
  }

  const result = calculateBundlePricing(cartItems, activeBundles);
  return {
    bundleDiscountVnd: result.bundleDiscountVnd,
    appliedBundles: result.appliedBundles,
    finalSubtotalVnd: result.finalTotalVnd
  };
}

/**
 * List bundles for admin panel
 */
async function listBundles(pool, page = 1, pageSize = 25) {
  const p = Math.max(1, Number(page) || 1);
  const offset = (p - 1) * pageSize;

  const bundles = (await pool.query(
    `SELECT b.*,
       COALESCE(
         (SELECT jsonb_agg(
           jsonb_build_object(
             'variantId', bi.variant_id,
             'isPrimary', bi.is_primary,
             'minQuantity', bi.min_quantity,
             'sku', v.sku,
             'variantName', v.name,
             'priceVnd', v.price_vnd,
             'productName', p.name
           ) ORDER BY bi.is_primary DESC, bi.created_at ASC
         )
         FROM product_bundle_items bi
         JOIN product_variants v ON v.id = bi.variant_id
         JOIN products p ON p.id = v.product_id
         WHERE bi.bundle_id = b.id),
         '[]'::jsonb
       ) AS items
     FROM product_bundles b
     ORDER BY b.created_at DESC, b.id
     LIMIT $1 OFFSET $2`,
    [pageSize, offset]
  )).rows;

  const total = Number((await pool.query('SELECT count(*)::int AS count FROM product_bundles')).rows[0]?.count || 0);

  return { bundles, total, page: p, pageSize };
}

/**
 * Mounts bundle management and public APIs
 */
function mountBundles({ admin, publicRouter }, pool) {
  // Admin list
  admin.get('/marketing/bundles', async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const data = await listBundles(pool, page);
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // Admin create & update
  for (const method of ['post', 'put']) {
    admin[method]('/marketing/bundles' + (method === 'put' ? '/:id' : ''), requirePermission('marketing.write'), requireCsrf, async (req, res, next) => {
      try {
        const d = bundleSchema.parse(req.body.data);
        const id = method === 'put' ? z.string().uuid().parse(req.params.id) : null;

        const saved = await withTransaction(pool, async c => {
          // Verify all variants exist and are active
          const variantIds = d.items.map(i => i.variantId);
          const found = (await c.query('SELECT id FROM product_variants WHERE id = ANY($1::uuid[]) FOR SHARE', [variantIds])).rows;
          if (found.length !== variantIds.length) {
            throw fail('Một số phiên bản sản phẩm đã chọn không tồn tại hoặc đã bị xóa.', 409);
          }

          let bundleRow;
          const values = [d.title, d.description, d.discountType, d.discountValue, d.startsAt, d.endsAt, d.active];

          if (id) {
            const version = z.number().int().positive().parse(req.body.version);
            bundleRow = (await c.query(
              `UPDATE product_bundles
               SET title = $3, description = $4, discount_type = $5, discount_value = $6,
                   starts_at = $7, ends_at = $8, active = $9, version = version + 1, updated_at = now()
               WHERE id = $1 AND version = $2
               RETURNING *`,
              [id, version, ...values]
            )).rows[0];
          } else {
            bundleRow = (await c.query(
              `INSERT INTO product_bundles (title, description, discount_type, discount_value, starts_at, ends_at, active)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               RETURNING *`,
              values
            )).rows[0];
          }

          if (!bundleRow) {
            throw fail('Dữ liệu combo đã thay đổi bởi người khác. Vui lòng tải lại trước khi lưu.', 409);
          }

          // Replace items
          await c.query('DELETE FROM product_bundle_items WHERE bundle_id = $1', [bundleRow.id]);
          for (const item of d.items) {
            await c.query(
              `INSERT INTO product_bundle_items (bundle_id, variant_id, is_primary, min_quantity)
               VALUES ($1, $2, $3, $4)`,
              [bundleRow.id, item.variantId, item.isPrimary, item.minQuantity]
            );
          }

          await appendAudit(c, {
            actor: req.admin,
            action: id ? 'marketing.product_bundle.update' : 'marketing.product_bundle.create',
            entityType: 'marketing',
            entityId: bundleRow.id,
            after: d,
            metadata: { version: bundleRow.version }
          });

          return bundleRow;
        });

        try { require('./cache').flushAllCache(); } catch (_) {}
        res.status(id ? 200 : 201).json({ item: saved });
      } catch (e) {
        if (e instanceof z.ZodError) {
          return res.status(400).json({ error: e.issues.map(i => i.message).join(' ') || 'Thông tin combo không hợp lệ.' });
        }
        next(e);
      }
    });
  }

  // Admin cancel (deactivate)
  admin.post('/marketing/bundles/:id/cancel', requirePermission('marketing.write'), requireCsrf, async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const item = await withTransaction(pool, async c => {
        const old = (await c.query('SELECT * FROM product_bundles WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!old) throw fail('Combo không tồn tại hoặc đã bị xóa.', 404);
        const r = await c.query('UPDATE product_bundles SET active = false, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *', [id]);
        await appendAudit(c, {
          actor: req.admin,
          action: 'marketing.product_bundle.cancel',
          entityType: 'marketing',
          entityId: id,
          before: { active: old.active },
          after: { active: false }
        });
        return r.rows[0];
      });
      try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: 'bundles', id, active: false }); } catch (_) {}
      try { require('./cache').flushAllCache(); } catch (_) {}
      res.json({ success: true, item, message: 'Đã dừng gói combo thành công.' });
    } catch (e) {
      next(e);
    }
  });

  // Admin delete
  admin.delete('/marketing/bundles/:id', requirePermission('marketing.write'), requireCsrf, async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      await withTransaction(pool, async c => {
        const old = (await c.query('SELECT * FROM product_bundles WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!old) throw fail('Combo không tồn tại hoặc đã bị xóa.', 404);
        await c.query('DELETE FROM product_bundles WHERE id = $1', [id]);
        await appendAudit(c, {
          actor: req.admin,
          action: 'marketing.product_bundle.delete',
          entityType: 'marketing',
          entityId: id,
          before: old
        });
      });
      try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: 'bundles', id, deleted: true }); } catch (_) {}
      try { require('./cache').flushAllCache(); } catch (_) {}
      res.json({ success: true, message: 'Đã xóa combo.' });
    } catch (e) {
      next(e);
    }
  });

  // Public storefront endpoint: Get applicable bundles for a product by slug
  if (publicRouter) {
    publicRouter.get('/products/:slug/bundles', async (req, res, next) => {
      try {
        const bundles = await getApplicableBundles(pool, { slug: req.params.slug });
        res.json({ bundles });
      } catch (e) {
        next(e);
      }
    });

    // Public endpoint: Quote combo pricing for given items
    publicRouter.post('/bundles/quote', async (req, res, next) => {
      try {
        const quoteSchema = z.object({
          items: z.array(z.object({
            variantId: z.string().uuid(),
            quantity: z.number().int().min(1).max(99)
          })).min(1).max(50)
        });
        const parsed = quoteSchema.parse(req.body);
        const vIds = parsed.items.map(i => i.variantId);

        const vRows = (await pool.query(
          `SELECT v.id, v.price_vnd AS "priceVnd" FROM product_variants v
           JOIN products p ON p.id = v.product_id
           WHERE v.id = ANY($1::uuid[]) AND v.active = true AND p.active = true AND p.deleted_at IS NULL`,
          [vIds]
        )).rows;

        const pricedItems = parsed.items.map(it => {
          const v = vRows.find(r => r.id === it.variantId);
          return {
            variantId: it.variantId,
            quantity: it.quantity,
            priceVnd: v ? Number(v.priceVnd) : 0
          };
        });

        const pricing = await calculateCartBundleDiscount(pool, pricedItems);
        res.json(pricing);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return res.status(400).json({ error: 'Danh sách sản phẩm định giá không hợp lệ.' });
        }
        next(e);
      }
    });
  }
}

module.exports = {
  bundleSchema,
  calculateBundlePricing,
  calculateCartBundleDiscount,
  getApplicableBundles,
  listBundles,
  mountBundles
};
