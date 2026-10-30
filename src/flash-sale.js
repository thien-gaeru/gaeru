'use strict';

const express = require('express');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');

async function getActiveFlashSale(pool) {
  const result = await pool.query(
    `SELECT id, title, starts_at AS "startsAt", ends_at AS "endsAt", discount_percent AS "discountPercent",
            product_slugs AS "productSlugs"
     FROM flash_sales
     WHERE active = true AND starts_at <= now() AND ends_at > now()
     ORDER BY ends_at ASC
     LIMIT 1`
  );

  if (!result.rows.length) {
    return { active: false, sale: null };
  }

  const row = result.rows[0];
  const slugs = Array.isArray(row.productSlugs)
    ? row.productSlugs
    : (typeof row.productSlugs === 'string' ? JSON.parse(row.productSlugs || '[]') : []);

  if (!slugs.length) {
    return { active: false, sale: null };
  }

  const now = Date.now();
  const ends = new Date(row.endsAt).getTime();
  const remainingSeconds = Math.max(0, Math.floor((ends - now) / 1000));

  // Đo lường số người xem thực tế từ bảng traffic thời gian thực (không áp sàn giả định)
  let viewingCount = 0;
  try {
    const activeRes = await pool.query(`SELECT COUNT(*)::int AS active FROM site_traffic_realtime WHERE last_seen_at >= now() - INTERVAL '30 minutes'`);
    const count = Number(activeRes.rows[0]?.active) || 0;
    viewingCount = Math.max(0, count);
  } catch {}

  return {
    active: true,
    sale: {
      ...row,
      remainingSeconds,
      viewingCount,
      bannerText: `⚡ FLASH SALE: Giảm đến ${row.discountPercent}% cho thiết bị GAERU chính hãng`
    }
  };
}

async function createFlashSale(pool, { title, startsAt, endsAt, discountPercent = 15, productSlugs = [] }) {
  const t = String(title || 'Flash Sale Giờ Vàng').trim();
  const start = startsAt ? new Date(startsAt) : new Date();
  const end = endsAt ? new Date(endsAt) : new Date(Date.now() + 24 * 3600000);
  const discount = Math.max(1, Math.min(90, Number.parseInt(discountPercent, 10) || 15));
  const slugs = Array.isArray(productSlugs) ? productSlugs.filter(Boolean) : [];

  if (!slugs.length) {
    throw Object.assign(new Error('Chiến dịch Flash Sale cần ít nhất một sản phẩm áp dụng.'), { status: 400 });
  }

  const { withTransaction } = require('./db');
  return await withTransaction(pool, async (client) => {
    const result = await client.query(
      `INSERT INTO flash_sales (title, starts_at, ends_at, discount_percent, product_slugs, active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING *`,
      [t, start, end, discount, slugs]
    );

    const varRes = await client.query(
      `SELECT v.id FROM product_variants v
       JOIN products p ON p.id = v.product_id
       WHERE p.slug = ANY($1::text[])`,
      [slugs]
    );
    if (varRes.rows.length > 0) {
      const promoRes = await client.query(
        `INSERT INTO product_promotions (title, type, kind, amount, starts_at, ends_at, active)
         VALUES ($1, 'flash', 'percent', $2, $3, $4, true)
         RETURNING id`,
        [t, discount, start, end]
      );
      const promoId = promoRes.rows[0]?.id;
      if (promoId) {
        for (const v of varRes.rows) {
          await client.query(
            `INSERT INTO product_promotion_variants (promotion_id, variant_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [promoId, v.id]
          );
        }
      }
    }

    return result.rows[0];
  });
}

const { requireAdminAction } = require('./admin-action');

function createFlashSalePublicRouter(pool) {
  const router = express.Router();
  router.get(['/marketing/flash-sale', '/flash-sales/active'], async (req, res, next) => {
    try {
      const data = await getActiveFlashSale(pool);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });
  return router;
}

function createFlashSaleAdminRouter(pool) {
  const router = express.Router();
  router.get('/flash-sales', async (req, res, next) => {
    try {
      const result = await pool.query(`SELECT * FROM flash_sales ORDER BY created_at DESC`);
      res.json({ sales: result.rows });
    } catch (err) {
      next(err);
    }
  });
  router.post('/flash-sales', requireAdminAction('marketing.write'), express.json(), async (req, res, next) => {
    try {
      const sale = await createFlashSale(pool, req.body || {});
      res.status(201).json({ ok: true, sale });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

module.exports = {
  getActiveFlashSale,
  createFlashSale,
  createFlashSalePublicRouter,
  createFlashSaleAdminRouter
};
