const { Router } = require('express');
const { z } = require('zod');
const { withTransaction } = require('./db');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');
const { appendAudit } = require('./audit');
const { rateLimit } = require('express-rate-limit');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const reviewSubmissionSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(120).optional().nullable(),
  comment: z.string().trim().min(5, 'Đánh giá cần có ít nhất 5 ký tự').max(2000, 'Đánh giá tối đa 2000 ký tự'),
  customerName: z.string().trim().min(2, 'Họ và tên ít nhất 2 ký tự').max(100),
  customerEmail: z.string().trim().email('Email không đúng định dạng').max(254).transform(v => v.toLowerCase()),
  orderNumber: z.string().trim().max(50).optional().nullable(),
  images: z.array(z.string().url().max(500)).max(5).default([])
}).strict();

const moderationSchema = z.object({
  action: z.enum(['approve', 'reject', 'hide']),
  moderatorNote: z.string().trim().max(1000).optional().nullable()
}).strict();

const replySchema = z.object({
  reply: z.string().trim().min(2, 'Nội dung phản hồi ít nhất 2 ký tự').max(2000)
}).strict();

/**
 * Mask customer name for privacy on public storefront (e.g. "Nguyễn Văn A" -> "Nguyễn V***")
 */
function maskName(name) {
  if (!name) return 'Khách hàng';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) {
    const single = parts[0];
    return single.length <= 2 ? single + '***' : single.slice(0, 2) + '***';
  }
  const last = parts[parts.length - 1];
  const initial = last ? last.charAt(0).toUpperCase() : '';
  const first = parts.slice(0, -1).join(' ');
  return `${first} ${initial}***`;
}

/**
 * Check whether a customer actually purchased this product in a completed/shipped order
 */
async function verifyBuyer(pool, { productId, email, orderNumber = null, customerId = null }) {
  const normEmail = String(email || '').trim().toLowerCase();
  if (!normEmail && !customerId && !orderNumber) {
    return { isVerified: false, orderId: null, orderNumber: null };
  }

  const query = `
    SELECT o.id, o.order_number, o.created_at, o.customer_name, o.email
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN product_variants pv ON pv.id = oi.variant_id
    WHERE pv.product_id = $1
      AND (
        (lower(trim(o.email)) = $2 AND ($3::text IS NULL OR o.order_number = $3))
        OR (o.customer_id = $4 AND $4::uuid IS NOT NULL)
      )
      AND o.status NOT IN ('cancelled')
    ORDER BY o.created_at DESC
    LIMIT 1
  `;

  const rows = (await pool.query(query, [productId, normEmail, orderNumber || null, customerId || null])).rows;
  if (rows.length > 0) {
    return {
      isVerified: true,
      orderId: rows[0].id,
      orderNumber: rows[0].order_number
    };
  }

  return { isVerified: false, orderId: null, orderNumber: null };
}

/**
 * Submit a customer product review
 */
async function submitProductReview(pool, { productSlug, data, customerId = null }) {
  const parsed = reviewSubmissionSchema.parse(data);

  // Look up product by slug
  const product = (await pool.query(
    `SELECT id, name, slug FROM products
     WHERE (slug = $1 OR slug = 'gaeru-' || $1) AND deleted_at IS NULL AND active = true`,
    [productSlug]
  )).rows[0];

  if (!product) {
    throw fail('Sản phẩm không tồn tại hoặc đã ngừng kinh doanh.', 404);
  }

  // Check buyer verification
  const verification = await verifyBuyer(pool, {
    productId: product.id,
    email: parsed.customerEmail,
    orderNumber: parsed.orderNumber,
    customerId
  });

  return await withTransaction(pool, async client => {
    // If verified buyer with order, check if they already reviewed for this order
    if (verification.isVerified && verification.orderId) {
      const existing = (await client.query(
        `SELECT id FROM product_reviews
         WHERE product_id = $1 AND order_id = $2`,
        [product.id, verification.orderId]
      )).rows[0];

      if (existing) {
        throw fail('Bạn đã gửi đánh giá cho sản phẩm này từ đơn hàng trước đó.', 409);
      }
    }

    const inserted = (await client.query(
      `INSERT INTO product_reviews
         (product_id, order_id, customer_id, customer_name, customer_email, rating, title, comment,
          is_verified_buyer, status, images)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        product.id,
        verification.orderId,
        customerId,
        parsed.customerName,
        parsed.customerEmail,
        parsed.rating,
        parsed.title || null,
        parsed.comment,
        verification.isVerified,
        'pending', // Requires moderation
        JSON.stringify(parsed.images || [])
      ]
    )).rows[0];

    return {
      review: inserted,
      isVerifiedBuyer: verification.isVerified,
      productName: product.name
    };
  });
}

/**
 * Get aggregate rating summary for a product
 */
async function getProductReviewsSummary(pool, productId) {
  const summaryRow = (await pool.query(
    `SELECT
       COALESCE(ROUND(AVG(rating)::numeric, 1), 0)::float AS average_rating,
       count(*)::int AS total_reviews,
       count(*) FILTER (WHERE is_verified_buyer = true)::int AS verified_count,
       count(*) FILTER (WHERE rating = 5)::int AS stars_5,
       count(*) FILTER (WHERE rating = 4)::int AS stars_4,
       count(*) FILTER (WHERE rating = 3)::int AS stars_3,
       count(*) FILTER (WHERE rating = 2)::int AS stars_2,
       count(*) FILTER (WHERE rating = 1)::int AS stars_1
     FROM product_reviews
     WHERE product_id = $1 AND status = 'approved'`,
    [productId]
  )).rows[0];

  const total = Number(summaryRow?.total_reviews || 0);

  return {
    averageRating: Number(summaryRow?.average_rating || 0),
    totalReviews: total,
    verifiedCount: Number(summaryRow?.verified_count || 0),
    distribution: {
      5: Number(summaryRow?.stars_5 || 0),
      4: Number(summaryRow?.stars_4 || 0),
      3: Number(summaryRow?.stars_3 || 0),
      2: Number(summaryRow?.stars_2 || 0),
      1: Number(summaryRow?.stars_1 || 0)
    },
    percentages: {
      5: total > 0 ? Math.round((Number(summaryRow?.stars_5 || 0) / total) * 100) : 0,
      4: total > 0 ? Math.round((Number(summaryRow?.stars_4 || 0) / total) * 100) : 0,
      3: total > 0 ? Math.round((Number(summaryRow?.stars_3 || 0) / total) * 100) : 0,
      2: total > 0 ? Math.round((Number(summaryRow?.stars_2 || 0) / total) * 100) : 0,
      1: total > 0 ? Math.round((Number(summaryRow?.stars_1 || 0) / total) * 100) : 0
    }
  };
}

/**
 * List approved reviews for storefront
 */
async function listProductReviews(pool, { productSlug, page = 1, pageSize = 20, rating = null, sort = 'newest' }) {
  const product = (await pool.query(
    `SELECT id, name, slug FROM products
     WHERE (slug = $1 OR slug = 'gaeru-' || $1) AND deleted_at IS NULL AND active = true`,
    [productSlug]
  )).rows[0];

  if (!product) {
    throw fail('Sản phẩm không tồn tại.', 404);
  }

  const p = Math.max(1, Number(page) || 1);
  const size = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const offset = (p - 1) * size;

  const whereParts = ['product_id = $1', "status = 'approved'"];
  const params = [product.id, size, offset];

  if (rating && Number(rating) >= 1 && Number(rating) <= 5) {
    whereParts.push(`rating = $${params.length + 1}`);
    params.push(Number(rating));
  }

  const orderBy = sort === 'helpful' ? 'helpful_count DESC, created_at DESC' : 'created_at DESC';

  const rows = (await pool.query(
    `SELECT id, customer_name, rating, title, comment, is_verified_buyer,
            admin_reply, admin_replied_at, helpful_count, images, created_at
     FROM product_reviews
     WHERE ${whereParts.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT $2 OFFSET $3`,
    params
  )).rows;

  const summary = await getProductReviewsSummary(pool, product.id);

  return {
    product: {
      id: product.id,
      name: product.name,
      slug: product.slug
    },
    summary,
    reviews: rows.map(r => ({
      id: r.id,
      customerName: maskName(r.customer_name),
      rating: r.rating,
      title: r.title,
      comment: r.comment,
      isVerifiedBuyer: r.is_verified_buyer,
      adminReply: r.admin_reply,
      adminRepliedAt: r.admin_replied_at,
      helpfulCount: r.helpful_count,
      images: Array.isArray(r.images) ? r.images : JSON.parse(r.images || '[]'),
      createdAt: r.created_at
    })),
    page: p,
    pageSize: size
  };
}

/**
 * Vote helpful for a review (with vote deduplication)
 */
async function voteReviewHelpful(pool, { reviewId, voterKey }) {
  if (!reviewId || !voterKey) throw fail('Thông tin không hợp lệ.', 400);

  return await withTransaction(pool, async client => {
    // Check if voter already voted
    const voted = (await client.query(
      `SELECT 1 FROM product_review_helpful_votes WHERE review_id = $1 AND voter_key = $2`,
      [reviewId, voterKey]
    )).rows.length > 0;

    if (voted) {
      const current = (await client.query(`SELECT helpful_count FROM product_reviews WHERE id = $1`, [reviewId])).rows[0];
      return { success: false, alreadyVoted: true, helpfulCount: current?.helpful_count || 0 };
    }

    await client.query(
      `INSERT INTO product_review_helpful_votes (review_id, voter_key) VALUES ($1, $2)`,
      [reviewId, voterKey]
    );

    const updated = (await client.query(
      `UPDATE product_reviews
       SET helpful_count = helpful_count + 1, updated_at = now()
       WHERE id = $1
       RETURNING helpful_count`,
      [reviewId]
    )).rows[0];

    return {
      success: true,
      alreadyVoted: false,
      helpfulCount: updated ? updated.helpful_count : 1
    };
  });
}

/**
 * List reviews for admin moderation
 */
async function listReviewsForModeration(pool, { status = 'all', productId = null, search = null, page = 1, pageSize = 25 } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.min(100, Math.max(1, Number(pageSize) || 25));
  const offset = (p - 1) * size;

  const whereParts = [];
  const params = [size, offset];

  if (status && status !== 'all') {
    whereParts.push(`r.status = $${params.length + 1}`);
    params.push(status);
  }

  if (productId) {
    whereParts.push(`r.product_id = $${params.length + 1}`);
    params.push(productId);
  }

  if (search && String(search).trim()) {
    const term = `%${String(search).trim().toLowerCase()}%`;
    whereParts.push(`(lower(r.customer_name) LIKE $${params.length + 1} OR lower(r.customer_email) LIKE $${params.length + 1} OR lower(r.comment) LIKE $${params.length + 1} OR lower(p.name) LIKE $${params.length + 1})`);
    params.push(term);
  }

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

  const rows = (await pool.query(
    `SELECT r.*, p.name AS product_name, p.slug AS product_slug, p.image_url AS product_image,
            o.order_number
     FROM product_reviews r
     JOIN products p ON p.id = r.product_id
     LEFT JOIN orders o ON o.id = r.order_id
     ${whereClause}
     ORDER BY
       CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END,
       r.created_at DESC
     LIMIT $1 OFFSET $2`,
    params
  )).rows;

  const countsRow = (await pool.query(
    `SELECT
       count(*)::int AS total_count,
       count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
       count(*) FILTER (WHERE status = 'approved')::int AS approved_count,
       count(*) FILTER (WHERE status = 'rejected')::int AS rejected_count,
       count(*) FILTER (WHERE is_verified_buyer = true)::int AS verified_buyer_count,
       COALESCE(ROUND(AVG(rating) FILTER (WHERE status = 'approved')::numeric, 1), 0)::float AS average_rating
     FROM product_reviews`
  )).rows[0];

  return {
    reviews: rows,
    metrics: {
      total: Number(countsRow.total_count || 0),
      pending: Number(countsRow.pending_count || 0),
      approved: Number(countsRow.approved_count || 0),
      rejected: Number(countsRow.rejected_count || 0),
      verifiedBuyers: Number(countsRow.verified_buyer_count || 0),
      averageRating: Number(countsRow.average_rating || 0)
    },
    page: p,
    pageSize: size
  };
}

/**
 * Moderate review (Approve / Reject / Hide)
 */
async function moderateReview(pool, { reviewId, action, moderatorNote = null, moderator = null }) {
  const statusMap = {
    approve: 'approved',
    reject: 'rejected',
    hide: 'hidden'
  };

  const targetStatus = statusMap[action];
  if (!targetStatus) throw fail('Hành động kiểm duyệt không hợp lệ.', 400);

  const updated = (await pool.query(
    `UPDATE product_reviews
     SET status = $2,
         moderator_note = COALESCE($3, moderator_note),
         moderated_by = $4,
         moderated_at = now(),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [reviewId, targetStatus, moderatorNote || null, moderator?.id || null]
  )).rows[0];

  if (!updated) throw fail('Đánh giá không tồn tại.', 404);
  return updated;
}

/**
 * Official GAERU Store reply to review
 */
async function replyToReview(pool, { reviewId, reply, actor = null }) {
  const normReply = String(reply || '').trim();
  if (!normReply) throw fail('Nội dung phản hồi không được để trống.', 400);

  const updated = (await pool.query(
    `UPDATE product_reviews
     SET admin_reply = $2,
         admin_replied_at = now(),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [reviewId, normReply]
  )).rows[0];

  if (!updated) throw fail('Đánh giá không tồn tại.', 404);
  return updated;
}

/**
 * Delete review permanently
 */
async function deleteReview(pool, reviewId) {
  const deleted = (await pool.query(
    `DELETE FROM product_reviews WHERE id = $1 RETURNING id`,
    [reviewId]
  )).rows[0];

  if (!deleted) throw fail('Đánh giá không tồn tại.', 404);
  return true;
}

/**
 * Express Router Factory for Product Reviews (Admin & Public APIs)
 */
function createProductReviewsApi(pool, config = {}) {
  const admin = Router();
  const publicApi = Router();

  const standardLimit = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
  const submitLimit = rateLimit({ windowMs: 60000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false });

  // --- Admin Moderation Endpoints ---
  admin.get('/product-reviews', standardLimit, requirePermission('catalog.read'), async (req, res, next) => {
    try {
      const data = await listReviewsForModeration(pool, {
        status: req.query.status,
        productId: req.query.productId,
        search: req.query.search,
        page: req.query.page,
        pageSize: req.query.pageSize
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  admin.post('/product-reviews/:id/approve', standardLimit, requirePermission('catalog.write'), requireCsrf, async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const review = await moderateReview(pool, { reviewId: id, action: 'approve', moderator: req.admin });

      await appendAudit(pool, {
        actor: req.admin,
        action: 'product.review.approve',
        entityType: 'product_review',
        entityId: id,
        metadata: { rating: review.rating, customerEmail: review.customer_email }
      });

      res.json({ success: true, message: 'Đã duyệt đánh giá thành công.', review });
    } catch (e) {
      next(e);
    }
  });

  admin.post('/product-reviews/:id/reject', standardLimit, requirePermission('catalog.write'), requireCsrf, async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const note = typeof req.body?.moderatorNote === 'string' ? req.body.moderatorNote.trim() : null;
      const review = await moderateReview(pool, { reviewId: id, action: 'reject', moderatorNote: note, moderator: req.admin });

      await appendAudit(pool, {
        actor: req.admin,
        action: 'product.review.reject',
        entityType: 'product_review',
        entityId: id,
        metadata: { reason: note }
      });

      res.json({ success: true, message: 'Đã từ chối đánh giá.', review });
    } catch (e) {
      next(e);
    }
  });

  admin.post('/product-reviews/:id/reply', standardLimit, requirePermission('catalog.write'), requireCsrf, async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const parsed = replySchema.parse(req.body);
      const review = await replyToReview(pool, { reviewId: id, reply: parsed.reply, actor: req.admin });

      await appendAudit(pool, {
        actor: req.admin,
        action: 'product.review.reply',
        entityType: 'product_review',
        entityId: id,
        metadata: { replyLength: parsed.reply.length }
      });

      res.json({ success: true, message: 'Đã lưu phản hồi của GAERU Official.', review });
    } catch (e) {
      next(e);
    }
  });

  admin.delete('/product-reviews/:id', standardLimit, requirePermission('catalog.write'), requireCsrf, async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      await deleteReview(pool, id);

      await appendAudit(pool, {
        actor: req.admin,
        action: 'product.review.delete',
        entityType: 'product_review',
        entityId: id
      });

      res.json({ success: true, message: 'Đã xóa đánh giá.' });
    } catch (e) {
      next(e);
    }
  });

  // --- Public Storefront Endpoints ---
  publicApi.get('/products/:slug/reviews', standardLimit, async (req, res, next) => {
    try {
      const data = await listProductReviews(pool, {
        productSlug: req.params.slug,
        page: req.query.page,
        pageSize: req.query.pageSize,
        rating: req.query.rating,
        sort: req.query.sort
      });
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  publicApi.post('/products/:slug/reviews', submitLimit, async (req, res, next) => {
    try {
      const customerId = req.session?.customer?.id || null;
      const result = await submitProductReview(pool, {
        productSlug: req.params.slug,
        data: req.body,
        customerId
      });

      res.status(201).json({
        success: true,
        message: result.isVerifiedBuyer
          ? 'Cảm ơn bạn đã đánh giá! Đánh giá đã được xác thực người mua và gửi tới ban quản trị kiểm duyệt.'
          : 'Cảm ơn bạn đã đánh giá! Đánh giá của bạn sẽ được hiển thị sau khi kiểm duyệt.',
        isVerifiedBuyer: result.isVerifiedBuyer,
        reviewId: result.review.id
      });
    } catch (e) {
      if (e instanceof z.ZodError) {
        return res.status(400).json({ error: e.errors[0]?.message || 'Thông tin đánh giá chưa hợp lệ.' });
      }
      next(e);
    }
  });

  publicApi.post('/reviews/:id/helpful', submitLimit, async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const voterKey = req.session?.id || req.ip || 'anonymous';
      const result = await voteReviewHelpful(pool, { reviewId: id, voterKey });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  return { admin, publicApi };
}

module.exports = {
  createProductReviewsApi,
  deleteReview,
  getProductReviewsSummary,
  listProductReviews,
  listReviewsForModeration,
  maskName,
  moderateReview,
  replySchema,
  replyToReview,
  reviewSubmissionSchema,
  submitProductReview,
  verifyBuyer,
  voteReviewHelpful
};
