'use strict';

const express = require('express');

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
  const now = Date.now();
  const ends = new Date(row.endsAt).getTime();
  const remainingSeconds = Math.max(0, Math.floor((ends - now) / 1000));

  // Dynamic social viewing counter based on time
  const viewingCount = 10 + (Math.floor(now / 60000) % 15);

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

  const result = await pool.query(
    `INSERT INTO flash_sales (title, starts_at, ends_at, discount_percent, product_slugs, active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING *`,
    [t, start, end, discount, Array.isArray(productSlugs) ? productSlugs : []]
  );
  return result.rows[0];
}

function createFlashSalePublicRouter(pool) {
  const router = express.Router();
  router.get('/marketing/flash-sale', async (req, res, next) => {
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
  router.post('/flash-sales', express.json(), async (req, res, next) => {
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
