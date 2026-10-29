'use strict';

const express = require('express');

async function searchAutocomplete(pool, queryText, limit = 5) {
  const q = String(queryText || '').trim().toLowerCase();
  if (!q || q.length < 1) return [];

  const max = Math.min(20, Math.max(1, Number.parseInt(limit, 10) || 5));
  const pattern = `%${q}%`;

  const result = await pool.query(
    `SELECT p.id, p.slug, p.name, p.category, p.descriptor, p.image_url AS "imageUrl",
            COALESCE((SELECT MIN(price_vnd) FROM product_variants WHERE product_id = p.id AND active = true), 0) AS "minPriceVnd"
     FROM products p
     WHERE p.active = true
       AND (
         LOWER(p.name) LIKE $1
         OR LOWER(p.slug) LIKE $1
         OR LOWER(p.descriptor) LIKE $1
         OR EXISTS (
           SELECT 1 FROM product_variants v
           WHERE v.product_id = p.id AND v.active = true AND LOWER(v.name) LIKE $1
         )
       )
     ORDER BY
       CASE WHEN LOWER(p.name) LIKE $2 THEN 0 ELSE 1 END,
       p.sort_order ASC, p.name ASC
     LIMIT $3`,
    [pattern, `${q}%`, max]
  );

  return result.rows.map(r => ({
    slug: r.slug,
    name: r.name,
    category: r.category,
    descriptor: r.descriptor,
    imageUrl: r.imageUrl,
    minPriceVnd: Number(r.minPriceVnd) || 0
  }));
}

function createSearchRouter(pool) {
  const router = express.Router();
  router.get('/products/search/autocomplete', async (req, res, next) => {
    try {
      const results = await searchAutocomplete(pool, req.query.q || req.query.query, req.query.limit);
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

module.exports = {
  searchAutocomplete,
  createSearchRouter
};
