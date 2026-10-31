'use strict';

const express = require('express');
const { AdminAction } = require('./admin-action');

async function getProductBundles(pool, mainProductSlug) {
  const slug = String(mainProductSlug || '').trim();
  const result = await pool.query(
    `SELECT b.id, b.main_product_slug AS "mainProductSlug", b.bundle_product_slug AS "bundleProductSlug",
            b.bundle_title AS "bundleTitle", b.discount_percent AS "discountPercent",
            p.name AS "bundleProductName", p.image_url AS "bundleProductImage",
            (SELECT MIN(price_vnd) FROM product_variants WHERE product_id = p.id AND active = true) AS "originalPriceVnd"
     FROM product_bundles b
     LEFT JOIN products p ON p.slug = b.bundle_product_slug
     WHERE b.main_product_slug = $1 AND b.active = true
     ORDER BY b.sort_order ASC, b.created_at ASC`,
    [slug]
  );

  return result.rows.map(b => {
    const orig = Number(b.originalPriceVnd) || 0;
    const discounted = Math.round(orig * (1 - (b.discountPercent / 100)));
    return {
      ...b,
      originalPriceVnd: orig,
      bundlePriceVnd: discounted,
      savingsVnd: orig - discounted
    };
  });
}

async function createProductBundle(pool, { mainProductSlug, bundleProductSlug, bundleTitle, discountPercent = 20, sortOrder = 0 }) {
  const main = String(mainProductSlug || '').trim();
  const bundle = String(bundleProductSlug || '').trim();
  const title = String(bundleTitle || '').trim();
  const discount = Math.max(1, Math.min(90, Number.parseInt(discountPercent, 10) || 20));

  if (!main || !bundle || !title) {
    throw Object.assign(new Error('mainProductSlug, bundleProductSlug và bundleTitle là bắt buộc.'), { status: 400 });
  }

  const result = await pool.query(
    `INSERT INTO product_bundles (main_product_slug, bundle_product_slug, bundle_title, discount_percent, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [main, bundle, title, discount, sortOrder]
  );
  return result.rows[0];
}

function createBundlesPublicRouter(pool) {
  const router = express.Router();
  router.get('/products/:slug/bundles', async (req, res, next) => {
    try {
      const bundles = await getProductBundles(pool, req.params.slug);
      res.json({ bundles });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

function createBundlesAdminRouter(pool) {
  const router = express.Router();
  const { requireAdminAction } = require('./admin-action');

  router.get('/bundles', requireAdminAction('catalog.read'), async (req, res, next) => {
    try {
      const result = await pool.query(`SELECT * FROM product_bundles ORDER BY created_at DESC`);
      res.json({ bundles: result.rows });
    } catch (err) {
      next(err);
    }
  });
  router.post('/bundles', requireAdminAction('catalog.write'), express.json(), async (req, res, next) => {
    try {
      const bundle = await createProductBundle(pool, req.body || {});
      res.status(201).json({ ok: true, bundle });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

module.exports = {
  getProductBundles,
  createProductBundle,
  createBundlesPublicRouter,
  createBundlesAdminRouter
};
