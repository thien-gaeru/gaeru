'use strict';

const express = require('express');

async function getProductReviews(pool, productSlug, { page = 1, limit = 10, rating = null } = {}) {
  const slug = String(productSlug || '').trim();
  const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
  const pageLimit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 10));
  const offset = (pageNum - 1) * pageLimit;

  const params = [slug];
  let filter = '';
  if (rating && Number.isInteger(Number(rating))) {
    params.push(Number(rating));
    filter = ' AND rating = $' + params.length;
  }

  // Summary stats
  const statsRes = await pool.query(
    `SELECT
       COUNT(*)::int AS "totalCount",
       ROUND(AVG(rating)::numeric, 1)::float AS "averageRating",
       COUNT(*) FILTER (WHERE rating = 5)::int AS "fiveStar",
       COUNT(*) FILTER (WHERE rating = 4)::int AS "fourStar",
       COUNT(*) FILTER (WHERE rating = 3)::int AS "threeStar",
       COUNT(*) FILTER (WHERE rating = 2)::int AS "twoStar",
       COUNT(*) FILTER (WHERE rating = 1)::int AS "oneStar"
     FROM product_reviews
     WHERE product_slug = $1 AND status = 'approved'`,
    [slug]
  );

  const stats = statsRes.rows[0] || {
    totalCount: 0,
    averageRating: 5.0,
    fiveStar: 0, fourStar: 0, threeStar: 0, twoStar: 0, oneStar: 0
  };

  const reviewsRes = await pool.query(
    `SELECT id, product_slug AS "productSlug", author_name AS "authorName", rating, title, comment,
            media_urls AS "mediaUrls", is_verified_buyer AS "isVerifiedBuyer", created_at AS "createdAt"
     FROM product_reviews
     WHERE product_slug = $1 AND status = 'approved' ${filter}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageLimit, offset]
  );

  return {
    stats: {
      totalCount: stats.totalCount || 0,
      averageRating: stats.averageRating || 5.0,
      distribution: {
        5: stats.fiveStar || 0,
        4: stats.fourStar || 0,
        3: stats.threeStar || 0,
        2: stats.twoStar || 0,
        1: stats.oneStar || 0
      }
    },
    reviews: reviewsRes.rows.map(r => ({
      ...r,
      mediaUrls: typeof r.mediaUrls === 'string' ? JSON.parse(r.mediaUrls) : (r.mediaUrls || [])
    })),
    page: pageNum,
    limit: pageLimit
  };
}

async function createProductReview(pool, { productSlug, customerId = null, orderId = null, authorName, rating, title, comment, mediaUrls = [] }) {
  const slug = String(productSlug || '').trim();
  const numRating = Number.parseInt(rating, 10);
  if (!slug || !numRating || numRating < 1 || numRating > 5) {
    throw Object.assign(new Error('Sản phẩm và số sao đánh giá (1-5) là bắt buộc.'), { status: 400 });
  }
  const name = String(authorName || 'Khách hàng GAERU').trim().slice(0, 100);
  const revTitle = String(title || 'Đánh giá sản phẩm').trim().slice(0, 200);
  const revComment = String(comment || '').trim().slice(0, 3000);
  if (!revComment) {
    throw Object.assign(new Error('Vui lòng nhập nội dung đánh giá.'), { status: 400 });
  }

  // Check verified buyer if customerId or orderId provided
  let isVerified = false;
  if (customerId) {
    const buyerCheck = await pool.query(
      `SELECT id FROM orders
       WHERE customer_id = $1 AND (status = 'completed' OR status = 'shipped')
       LIMIT 1`,
      [customerId]
    );
    if (buyerCheck.rows.length) isVerified = true;
  }

  const result = await pool.query(
    `INSERT INTO product_reviews (product_slug, customer_id, order_id, author_name, rating, title, comment, media_urls, is_verified_buyer, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'approved')
     RETURNING id, product_slug AS "productSlug", author_name AS "authorName", rating, title, comment, is_verified_buyer AS "isVerifiedBuyer", created_at AS "createdAt"`,
    [slug, customerId, orderId, name, numRating, revTitle, revComment, JSON.stringify(mediaUrls), isVerified]
  );

  return result.rows[0];
}

function generateReviewSchema(product, stats) {
  if (!stats || stats.totalCount === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    'name': product.name,
    'description': product.description,
    'aggregateRating': {
      '@type': 'AggregateRating',
      'ratingValue': String(stats.averageRating),
      'reviewCount': String(stats.totalCount),
      'bestRating': '5',
      'worstRating': '1'
    }
  };
}

function createReviewsPublicRouter(pool) {
  const router = express.Router();

  router.get('/products/:slug/reviews', async (req, res, next) => {
    try {
      const data = await getProductReviews(pool, req.params.slug, req.query);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.post('/products/:slug/reviews', express.json(), async (req, res, next) => {
    try {
      const customerId = req.session?.customer?.id || null;
      const { authorName, rating, title, comment, mediaUrls } = req.body || {};
      const review = await createProductReview(pool, {
        productSlug: req.params.slug,
        customerId,
        authorName: authorName || req.session?.customer?.full_name,
        rating,
        title,
        comment,
        mediaUrls
      });
      res.status(201).json({ ok: true, review });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function createReviewsAdminRouter(pool) {
  const router = express.Router();

  router.get('/reviews', async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT id, product_slug AS "productSlug", author_name AS "authorName", rating, title, comment,
               status, is_verified_buyer AS "isVerifiedBuyer", created_at AS "createdAt"
        FROM product_reviews
        ORDER BY created_at DESC
        LIMIT 50
      `);
      res.json({ reviews: result.rows });
    } catch (err) {
      next(err);
    }
  });

  router.put('/reviews/:id/status', express.json(), async (req, res, next) => {
    try {
      const { status } = req.body || {};
      if (!['approved', 'pending', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Trạng thái không hợp lệ.' });
      }
      await pool.query(`UPDATE product_reviews SET status = $1, updated_at = now() WHERE id = $2`, [status, req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  getProductReviews,
  createProductReview,
  generateReviewSchema,
  createReviewsPublicRouter,
  createReviewsAdminRouter
};
