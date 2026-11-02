const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const {
  reviewSubmissionSchema,
  verifyBuyer,
  submitProductReview,
  getProductReviewsSummary,
  listProductReviews,
  voteReviewHelpful,
  listReviewsForModeration,
  moderateReview,
  replyToReview,
  deleteReview,
  createProductReviewsApi
} = require('../src/product-reviews');

test('Product Reviews & Moderation Comprehensive Test Suite', async t => {
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) {
      return !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : db.query(sql, values);
    },
    async connect() {
      return { query: pool.query, release() {} };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);

  // Seed Product and Variant
  const pRes = await pool.query(
    `INSERT INTO products (name, slug, category, description, active)
     VALUES ('Microphone GAERU K9', 'micro-gaeru-k9', 'audio', 'Microphone thu âm chuyên nghiệp', true)
     RETURNING id`
  );
  const productId = pRes.rows[0].id;

  const vRes = await pool.query(
    `INSERT INTO product_variants (product_id, name, sku, price_vnd, stock_quantity, active)
     VALUES ($1, 'Bản Type-C', 'K9-TYPEC', 350000, 20, true)
     RETURNING id`,
    [productId]
  );
  const variantId = vRes.rows[0].id;

  // Seed an Order with this Product for buyer verification testing
  const oRes = await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status)
     VALUES ('GA-REV-1001', 'Nguyễn Thị Hoa', 'hoa.nguyen@example.com', '0912345678', '456 Lê Lợi', 'Đà Nẵng', 'cod', 350000, 350000, 'completed')
     RETURNING id`
  );
  const orderId = oRes.rows[0].id;

  await pool.query(
    `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES ($1, $2, 'Microphone GAERU K9', 'Bản Type-C', 'K9-TYPEC', 350000, 1, 350000)`,
    [orderId, variantId]
  );

  // 1. Schema Validation
  await t.test('reviewSubmissionSchema validates inputs and enforces constraints', () => {
    const valid = reviewSubmissionSchema.safeParse({
      rating: 5,
      title: 'Micro rất nhạy',
      comment: 'Âm thanh trong trẻo, khử ồn rất tốt.',
      customerName: 'Trần Văn B',
      customerEmail: 'Tran.B@example.com',
      orderNumber: 'GA-REV-1001'
    });
    assert.equal(valid.success, true);
    assert.equal(valid.data.customerEmail, 'tran.b@example.com');

    // Rejects invalid rating
    const invalidRating = reviewSubmissionSchema.safeParse({
      rating: 6,
      comment: 'Tuyệt vời',
      customerName: 'A',
      customerEmail: 'a@example.com'
    });
    assert.equal(invalidRating.success, false);

    // Rejects comment too short (< 5 chars)
    const shortComment = reviewSubmissionSchema.safeParse({
      rating: 5,
      comment: 'Tốt',
      customerName: 'Lê C',
      customerEmail: 'c@example.com'
    });
    assert.equal(shortComment.success, false);
  });

  // 2. verifyBuyer
  await t.test('verifyBuyer correctly matches completed orders and rejects unverified buyers', async () => {
    // Verified match with email
    const match = await verifyBuyer(pool, {
      productId,
      email: 'hoa.nguyen@example.com'
    });
    assert.equal(match.isVerified, true);
    assert.equal(match.orderId, orderId);
    assert.equal(match.orderNumber, 'GA-REV-1001');

    // Verified match with orderNumber
    const matchOrder = await verifyBuyer(pool, {
      productId,
      email: 'hoa.nguyen@example.com',
      orderNumber: 'GA-REV-1001'
    });
    assert.equal(matchOrder.isVerified, true);

    // Non-buyer
    const nonBuyer = await verifyBuyer(pool, {
      productId,
      email: 'stranger@example.com'
    });
    assert.equal(nonBuyer.isVerified, false);
    assert.equal(nonBuyer.orderId, null);
  });

  // 3. submitProductReview
  let verifiedReviewId, guestReviewId;
  await t.test('submitProductReview saves reviews with pending status and tags verified buyers', async () => {
    // 3.1 Verified buyer submission
    const resVerified = await submitProductReview(pool, {
      productSlug: 'micro-gaeru-k9',
      data: {
        rating: 5,
        title: 'Rất hài lòng',
        comment: 'Đã nhận micro, test thử thấy lọc gió rất êm. Đáng giá tiền!',
        customerName: 'Nguyễn Thị Hoa',
        customerEmail: 'hoa.nguyen@example.com',
        orderNumber: 'GA-REV-1001'
      }
    });

    assert.equal(resVerified.isVerifiedBuyer, true);
    assert.equal(resVerified.review.status, 'pending');
    assert.equal(resVerified.review.is_verified_buyer, true);
    assert.equal(resVerified.review.order_id, orderId);
    verifiedReviewId = resVerified.review.id;

    // Duplicate review from same order should fail
    await assert.rejects(
      submitProductReview(pool, {
        productSlug: 'micro-gaeru-k9',
        data: {
          rating: 4,
          comment: 'Gửi lần thứ hai',
          customerName: 'Nguyễn Thị Hoa',
          customerEmail: 'hoa.nguyen@example.com',
          orderNumber: 'GA-REV-1001'
        }
      }),
      /đã gửi đánh giá/
    );

    // 3.2 Guest submission (unverified)
    const resGuest = await submitProductReview(pool, {
      productSlug: 'micro-gaeru-k9',
      data: {
        rating: 4,
        title: 'Hỏi trước khi mua',
        comment: 'Nghe bạn bè giới thiệu micro này rất tốt cho thu âm podcast.',
        customerName: 'Phạm Minh Tuấn',
        customerEmail: 'tuan.pham@example.com'
      }
    });

    assert.equal(resGuest.isVerifiedBuyer, false);
    assert.equal(resGuest.review.is_verified_buyer, false);
    assert.equal(resGuest.review.order_id, null);
    guestReviewId = resGuest.review.id;
  });

  // 4. Moderation Workflow: Approve & Reject
  await t.test('moderateReview approves or rejects reviews and updates status', async () => {
    const adminActor = { id: '00000000-0000-4000-8000-000000000001', username: 'admin_test' };

    // Approve verified review
    const approved = await moderateReview(pool, {
      reviewId: verifiedReviewId,
      action: 'approve',
      moderator: adminActor
    });
    assert.equal(approved.status, 'approved');
    assert.ok(approved.moderated_at);

    // Reject guest review with note
    const rejected = await moderateReview(pool, {
      reviewId: guestReviewId,
      action: 'reject',
      moderatorNote: 'Nội dung chưa mua hàng, chuyển sang hỏi đáp.',
      moderator: adminActor
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.moderator_note, 'Nội dung chưa mua hàng, chuyển sang hỏi đáp.');

    // Add another approved 5-star review for testing distribution
    const r3 = await pool.query(
      `INSERT INTO product_reviews (product_id, customer_name, customer_email, rating, title, comment, is_verified_buyer, status)
       VALUES ($1, 'Vũ Đình Cường', 'cuong@example.com', 4, 'Chất âm tốt', 'Dùng ổn định cho điện thoại.', true, 'approved')
       RETURNING id`,
      [productId]
    );
  });

  // 5. Official GAERU Reply
  await t.test('replyToReview saves official store reply', async () => {
    const replied = await replyToReview(pool, {
      reviewId: verifiedReviewId,
      reply: 'Cảm ơn bạn Hoa đã ủng hộ GAERU! Chúc bạn có những bản thu âm thật ưng ý ạ.'
    });
    assert.equal(replied.admin_reply, 'Cảm ơn bạn Hoa đã ủng hộ GAERU! Chúc bạn có những bản thu âm thật ưng ý ạ.');
    assert.ok(replied.admin_replied_at);
  });

  // 6. Public Summary & Storefront List
  await t.test('listProductReviews and getProductReviewsSummary return approved reviews and aggregations', async () => {
    const data = await listProductReviews(pool, {
      productSlug: 'micro-gaeru-k9'
    });

    assert.equal(data.product.name, 'Microphone GAERU K9');
    assert.equal(data.summary.totalReviews, 2); // 2 approved reviews
    assert.equal(data.summary.averageRating, 4.5); // (5 + 4) / 2 = 4.5
    assert.equal(data.summary.verifiedCount, 2);
    assert.equal(data.summary.distribution[5], 1);
    assert.equal(data.summary.distribution[4], 1);

    // Ensure customer name is masked
    const r1 = data.reviews.find(r => r.id === verifiedReviewId);
    assert.ok(r1);
    assert.ok(r1.customerName.includes('***'));
    assert.equal(r1.isVerifiedBuyer, true);
    assert.ok(r1.adminReply.includes('Cảm ơn bạn Hoa'));
  });

  // 7. Helpful Votes & Deduplication
  await t.test('voteReviewHelpful increments count and prevents duplicate voter', async () => {
    const vote1 = await voteReviewHelpful(pool, {
      reviewId: verifiedReviewId,
      voterKey: 'user-ip-1.2.3.4'
    });
    assert.equal(vote1.success, true);
    assert.equal(vote1.helpfulCount, 1);

    // Duplicate vote
    const vote2 = await voteReviewHelpful(pool, {
      reviewId: verifiedReviewId,
      voterKey: 'user-ip-1.2.3.4'
    });
    assert.equal(vote2.success, false);
    assert.equal(vote2.alreadyVoted, true);
    assert.equal(vote2.helpfulCount, 1);
  });

  // 8. listReviewsForModeration
  await t.test('listReviewsForModeration returns reviews list and metrics', async () => {
    const list = await listReviewsForModeration(pool, { status: 'all' });
    assert.ok(list.reviews.length >= 3);
    assert.ok(list.metrics.total >= 3);
    assert.ok(list.metrics.approved >= 2);
    assert.ok(list.metrics.rejected >= 1);
  });

  // 9. API Integration (Admin & Public)
  await t.test('Product Reviews API endpoints integrate with security & CSRF', async () => {
    const app = express();
    app.use(express.json());

    // Mock admin session with CSRF and permissions
    app.use((req, res, next) => {
      req.session = { csrfToken: 'csrf-secret-token-789' };
      req.admin = {
        id: '00000000-0000-4000-8000-000000000001',
        username: 'staff_ceo',
        name: 'CEO Staff',
        role: 'admin',
        permissions: ['catalog.read', 'catalog.write']
      };
      next();
    });

    const { admin, publicApi } = createProductReviewsApi(pool);
    app.use('/api/gaeru_ceo', admin);
    app.use('/api', publicApi);

    const server = app.listen(0);
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    t.after(() => server.close());

    // 9.1 Public: Get reviews
    const getRes = await fetch(`${base}/api/products/micro-gaeru-k9/reviews`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.ok(getData.summary);
    assert.ok(Array.isArray(getData.reviews));

    // 9.2 Public: Submit new review
    const postRes = await fetch(`${base}/api/products/micro-gaeru-k9/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rating: 5,
        title: 'Tuyệt vời',
        comment: 'Đã nhận sản phẩm rất nhanh, đóng gói cẩn thận 10 điểm.',
        customerName: 'Hoàng Hải Đăng',
        customerEmail: 'dang.hoang@example.com'
      })
    });
    assert.equal(postRes.status, 201);
    const postData = await postRes.json();
    assert.ok(postData.success);
    assert.ok(postData.reviewId);

    // 9.3 Public: Vote helpful
    const voteRes = await fetch(`${base}/api/reviews/${verifiedReviewId}/helpful`, {
      method: 'POST'
    });
    assert.equal(voteRes.status, 200);

    // 9.4 Admin: List moderation
    const adminListRes = await fetch(`${base}/api/gaeru_ceo/product-reviews?status=pending`);
    assert.equal(adminListRes.status, 200);
    const adminListData = await adminListRes.json();
    assert.ok(adminListData.reviews.some(r => r.id === postData.reviewId));

    // 9.5 Admin: Approve with CSRF
    const approveRes = await fetch(`${base}/api/gaeru_ceo/product-reviews/${postData.reviewId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': 'csrf-secret-token-789'
      }
    });
    assert.equal(approveRes.status, 200);

    // 9.6 Admin: Reply with CSRF
    const replyRes = await fetch(`${base}/api/gaeru_ceo/product-reviews/${postData.reviewId}/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': 'csrf-secret-token-789'
      },
      body: JSON.stringify({ reply: 'Cảm ơn Đăng đã đánh giá sản phẩm!' })
    });
    assert.equal(replyRes.status, 200);

    // 9.7 Admin: Delete with CSRF
    const delRes = await fetch(`${base}/api/gaeru_ceo/product-reviews/${postData.reviewId}`, {
      method: 'DELETE',
      headers: {
        'x-csrf-token': 'csrf-secret-token-789'
      }
    });
    assert.equal(delRes.status, 200);
  });
});
