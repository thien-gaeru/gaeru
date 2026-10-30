'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { _webhookAuthMiddleware, processOmnichannelEvent, createOmnichannelRouter } = require('../src/omnichannel-sync');
const { lookupOrderTracking, normalizeVietnamPhone } = require('../src/tracking-api');
const { getRecentSocialProof } = require('../src/social-proof');
const { createAffiliatePublicRouter } = require('../src/affiliate-system');
const { applyPromotions } = require('../src/product-promotions');
const { createFlashSale } = require('../src/flash-sale');
const { createProductReview } = require('../src/product-reviews');
const { createTestDb: setupTestDb } = require('./helpers/pglite-db');

test('P0: Social proof toast strictly differentiates simulated vs authentic sales', () => {
  const toastScript = fs.readFileSync(path.join(__dirname, '..', 'social-proof-toast.js'), 'utf8');

  // Verify toast distinguishes isSimulated
  assert.match(toastScript, /const isSimulated = Boolean\(item\.isSimulated\);/, 'Toast must check isSimulated flag');
  assert.match(toastScript, /'Gợi ý sản phẩm nổi bật'/, 'Toast must show product recommendation title for simulated items');
  assert.match(toastScript, /'Đề xuất mua sắm • Minh họa'/, 'Toast must show transparent simulated note');
  assert.doesNotMatch(toastScript, /onclick="event\.stopPropagation\(\)/, 'Toast must not use inline onclick handlers violating CSP');
});

test('P1: Webhook inventory sync strictly requires 32-char secret across ALL environments', () => {
  // 1. Missing secret in development / test -> 503
  const middlewareNoSecret = _webhookAuthMiddleware({});
  let status1 = 0, jsonMsg1 = null;
  const fakeRes1 = { status(s) { status1 = s; return this; }, json(j) { jsonMsg1 = j; } };
  middlewareNoSecret({ headers: {}, body: {} }, fakeRes1, () => {});
  assert.equal(status1, 503);
  assert.match(jsonMsg1.error, /chưa được cấu hình khóa bí mật/);

  // 2. Secret too short (< 32 chars) -> 503
  const middlewareShortSecret = _webhookAuthMiddleware({ OMNICHANNEL_WEBHOOK_SECRET: 'short-key-16-chars' });
  let status2 = 0, jsonMsg2 = null;
  const fakeRes2 = { status(s) { status2 = s; return this; }, json(j) { jsonMsg2 = j; } };
  middlewareShortSecret({ headers: {}, body: {} }, fakeRes2, () => {});
  assert.equal(status2, 503);
  assert.match(jsonMsg2.error, /tối thiểu 32 ký tự/);

  // 3. Valid secret (>= 32 chars) but missing headers -> 401
  const validSecret = 'super-secret-key-at-least-32-chars-long!';
  const middlewareValid = _webhookAuthMiddleware({ OMNICHANNEL_WEBHOOK_SECRET: validSecret });
  let status3 = 0, jsonMsg3 = null;
  const fakeRes3 = { status(s) { status3 = s; return this; }, json(j) { jsonMsg3 = j; } };
  middlewareValid({ headers: {}, body: {} }, fakeRes3, () => {});
  assert.equal(status3, 401);
  assert.match(jsonMsg3.error, /thiếu tiêu đề xác thực/);

  // 4. Valid signature and timestamp -> next() called
  const validTs = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ sku: 'TEST', delta: 5 });
  const validSig = crypto.createHmac('sha256', validSecret).update(`${validTs}.${payload}`).digest('hex');
  let successNext = false;
  middlewareValid({
    headers: {
      'x-webhook-timestamp': String(validTs),
      'x-webhook-signature': validSig
    },
    body: { sku: 'TEST', delta: 5 }
  }, fakeRes3, () => { successNext = true; });
  assert.equal(successNext, true);
});

test('P1: Webhook inventory sync enforces database uniqueness on (channel, event_id)', async () => {
  const { db, pool } = await setupTestDb();
  try {
    // Insert a product variant first
    await pool.query(
      `INSERT INTO products (id, name, slug, description, category, active)
       VALUES ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'SP Test', 'sp-test', 'Desc', 'audio', true)`
    );
    await pool.query(
      `INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ('bbbbbbbb-cccc-dddd-eeee-ffffffffffff', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'SKU-SYNC-01', 'Bản Chuẩn', 500000, 20, true)`
    );

    // First event: delta +5
    const res1 = await processOmnichannelEvent(pool, {
      channel: 'shopee',
      eventType: 'inventory_sync',
      externalSku: 'SKU-SYNC-01',
      quantityDelta: 5,
      payload: { eventId: 'EVT-UNIQUE-123', reason: 'sale_sync' }
    });
    assert.equal(res1.ok, true);
    assert.equal(res1.duplicate, undefined);
    assert.equal(res1.variant.stockQuantity, 25);

    // Second event with SAME eventId: must return duplicate and NOT modify stock again
    const res2 = await processOmnichannelEvent(pool, {
      channel: 'shopee',
      eventType: 'inventory_sync',
      externalSku: 'SKU-SYNC-01',
      quantityDelta: 5,
      payload: { eventId: 'EVT-UNIQUE-123', reason: 'replay_attack' }
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.duplicate, true);

    // Verify stock remains 25 (not 30)
    const varCheck = await pool.query(`SELECT stock_quantity FROM product_variants WHERE sku = 'SKU-SYNC-01'`);
    assert.equal(varCheck.rows[0].stock_quantity, 25);
  } finally {
    await db.close();
  }
});

test('P1: Tracking API protects PII, blocks phone-only lookup, and verifies order ownership', async () => {
  const { db, pool } = await setupTestDb();
  try {
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, subtotal_vnd, total_vnd, status, payment_method, payment_status)
       VALUES ('11111111-2222-3333-4444-555555555555', 'GAERU-SEC-01', 'Nguyễn Văn Hoàng', 'hoang@example.com', '0912345678', '123 Đường Hai Bà Trưng, Phường 6, Quận 3, TP. Hồ Chí Minh', 'TP. Hồ Chí Minh', 650000, 650000, 'shipped', 'cod', 'pending')`
    );

    // 1. Phone-only lookup is rejected with 400
    await assert.rejects(
      async () => {
        await lookupOrderTracking(pool, '0912345678');
      },
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /Mã đơn hàng cùng Số điện thoại/);
        return true;
      }
    );

    // 2. Order code only without phone: found, but items are hidden and verification requested
    const unverifiedRes = await lookupOrderTracking(pool, 'GAERU-SEC-01');
    assert.equal(unverifiedRes.found, true);
    const unverifiedOrder = unverifiedRes.orders[0];
    assert.equal(unverifiedOrder.isPhoneVerified, false);
    assert.equal(unverifiedOrder.requiresPhoneVerification, true);
    assert.deepEqual(unverifiedOrder.items, []); // Hidden items
    assert.equal(unverifiedOrder.shippingAddress, ''); // Hidden address

    // 3. Order code + Wrong phone: rejected with 403
    await assert.rejects(
      async () => {
        await lookupOrderTracking(pool, { code: 'GAERU-SEC-01', phone: '0999999999' });
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.match(err.message, /Số điện thoại không khớp/);
        return true;
      }
    );

    // 4. Order code + Correct phone (E.164): verified and returns masked PII
    const verifiedRes = await lookupOrderTracking(pool, { code: 'GAERU-SEC-01', phone: '+84 912 345 678' });
    assert.equal(verifiedRes.found, true);
    const verifiedOrder = verifiedRes.orders[0];
    assert.equal(verifiedOrder.isPhoneVerified, true);
    assert.equal(verifiedOrder.customerPhoneMasked, '091****678');
    assert.match(verifiedOrder.customerName, /H\./);
    assert.match(verifiedOrder.shippingAddress, /TP\. Hồ Chí Minh/);
  } finally {
    await db.close();
  }
});

test('P1: Product reviews for logged-in users without verified purchase default to pending moderation', async () => {
  const { db, pool } = await setupTestDb();
  try {
    const unverifiedCustId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
    await pool.query(
      `INSERT INTO customers (id, email, password_hash, full_name, active) VALUES ($1, 'guest_user@cust.com', 'hash', 'Trần Văn Chưa Mua', true)`,
      [unverifiedCustId]
    );

    // Logged in customer submits a review for 'gaeru-k9' without any completed order
    const review = await createProductReview(pool, {
      productSlug: 'gaeru-k9',
      customerId: unverifiedCustId,
      authorName: 'Trần Văn Chưa Mua',
      rating: 5,
      title: 'Đánh giá thử',
      comment: 'Sản phẩm trông rất đẹp',
      status: 'auto'
    });

    // Must be 'pending' and isVerifiedBuyer: false
    assert.equal(review.isVerifiedBuyer, false);
    assert.equal(review.status, 'pending');
  } finally {
    await db.close();
  }
});

test('P1: Flash Sale campaigns synchronize with product_promotions table and checkout pricing', async () => {
  const { db, pool } = await setupTestDb();
  try {
    // Create product and variant
    await pool.query(
      `INSERT INTO products (id, name, slug, description, category, active)
       VALUES ('cccccccc-dddd-eeee-ffff-000000000000', 'GAERU K9 Pro', 'k9', 'Desc', 'audio', true)`
    );
    const vId = 'dddddddd-eeee-ffff-0000-111111111111';
    await pool.query(
      `INSERT INTO product_variants (id, product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'cccccccc-dddd-eeee-ffff-000000000000', 'SKU-K9-01', 'Bản Đơn', 1000000, 50, true)`,
      [vId]
    );

    const now = new Date();
    await createFlashSale(pool, {
      title: 'Flash Sale Đồng Bộ 2 Chiều',
      startsAt: new Date(now.getTime() - 3600000),
      endsAt: new Date(now.getTime() + 7200000),
      discountPercent: 25,
      productSlugs: ['k9']
    });

    // Verify synced into product_promotions table
    const promoCheck = await pool.query(
      `SELECT p.id, p.amount, p.type FROM product_promotions p
       JOIN product_promotion_variants pv ON pv.promotion_id = p.id
       WHERE pv.variant_id = $1`,
      [vId]
    );
    assert.ok(promoCheck.rows.length > 0);
    assert.equal(promoCheck.rows[0].amount, 25);
    assert.equal(promoCheck.rows[0].type, 'flash');

    // Run applyPromotions on variant
    const priced = await applyPromotions(pool, [{ id: vId, productSlug: 'k9', priceVnd: 1000000, quantity: 1 }]);
    assert.equal(priced[0].priceVnd, 750000); // 25% off
    assert.equal(priced[0].promotion.type, 'flash');
  } finally {
    await db.close();
  }
});

test('P2: Affiliate tracking blocks open redirect attacks', () => {
  const router = createAffiliatePublicRouter();
  let redirectedTo = null;
  const fakeRes = {
    cookie() {},
    redirect(url) { redirectedTo = url; }
  };

  // 1. Attempted open redirect to external site
  router.handle({ method: 'GET', url: '/affiliate/track?ref=TEST&redirect=https://evil.com', query: { ref: 'TEST', redirect: 'https://evil.com' } }, fakeRes, () => {});
  assert.equal(redirectedTo, '/');

  // 2. Protocol-relative open redirect //evil.com
  router.handle({ method: 'GET', url: '/affiliate/track?ref=TEST&redirect=//evil.com', query: { ref: 'TEST', redirect: '//evil.com' } }, fakeRes, () => {});
  assert.equal(redirectedTo, '/');

  // 3. Valid internal relative path
  router.handle({ method: 'GET', url: '/affiliate/track?ref=TEST&redirect=/san-pham/gaeru-k9', query: { ref: 'TEST', redirect: '/san-pham/gaeru-k9' } }, fakeRes, () => {});
  assert.equal(redirectedTo, '/san-pham/gaeru-k9');
});

test('P2: Social proof marks fallback data with transparent isSimulated flag when DB has no recent sales', async () => {
  const { db, pool } = await setupTestDb();
  try {
    const items = await getRecentSocialProof(pool);
    assert.ok(Array.isArray(items));
    assert.ok(items.length > 0);
    assert.ok(items.every(i => i.isSimulated === true));
    assert.ok(items.every(i => typeof i.note === 'string'));
  } finally {
    await db.close();
  }
});

test('P1: Admin Helmet CSP compliance: All admin markup and dynamic templates have zero inline onclick / onsubmit', () => {
  const adminIndex = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  const upgradesHub = fs.readFileSync(path.join(__dirname, '..', 'admin', 'upgrades-hub.js'), 'utf8');

  assert.doesNotMatch(adminIndex, /\bonclick\s*=/i, 'admin/index.html must not contain inline onclick attributes');
  assert.doesNotMatch(adminIndex, /\bonsubmit\s*=/i, 'admin/index.html must not contain inline onsubmit attributes');
  assert.doesNotMatch(upgradesHub, /<[^>]*\bonclick\s*=/i, 'admin/upgrades-hub.js templates must not contain inline onclick');
  assert.doesNotMatch(upgradesHub, /<[^>]*\bonsubmit\s*=/i, 'admin/upgrades-hub.js templates must not contain inline onsubmit');
});

test('P1: Marketing eligible rejects vouchers when product is in active Flash Sale', async () => {
  const { db, pool } = await setupTestDb();
  try {
    const { eligible } = require('../src/marketing');
    const custId = '33333333-4444-5555-6666-777777777777';
    await pool.query(
      `INSERT INTO customers (id, email, password_hash, full_name, active) VALUES ($1, 'test@cust.com', 'hash', 'Test Cust', true)`,
      [custId]
    );
    const vId = '44444444-5555-6666-7777-888888888888';
    await pool.query(
      `INSERT INTO marketing_vouchers (id, code, title, kind, amount, min_spend_vnd, starts_at, ends_at, total_limit, per_customer_limit, public_claim, active)
       VALUES ($1, 'DISCOUNT10', 'Giảm 10%', 'percent', 10, 100000, now() - interval '1 hour', now() + interval '1 day', 100, 5, true, true)`,
      [vId]
    );
    await pool.query(
      `INSERT INTO customer_vouchers (customer_id, voucher_id, source) VALUES ($1, $2, 'saved')`,
      [custId, vId]
    );

    await createFlashSale(pool, {
      title: 'Flash Test',
      startsAt: new Date(Date.now() - 3600000),
      endsAt: new Date(Date.now() + 7200000),
      discountPercent: 15,
      productSlugs: ['flash-item']
    });

    // 1. Should reject when cart has 'flash-item'
    await assert.rejects(
      async () => {
        await eligible(pool, 'DISCOUNT10', custId, 500000, false, { productSlugs: ['flash-item', 'regular-item'] });
      },
      (err) => {
        assert.equal(err.status, 409);
        assert.match(err.message, /Flash Sale giờ vàng không áp dụng đồng thời/);
        return true;
      }
    );

    // 2. Should succeed when cart only has 'regular-item'
    const okResult = await eligible(pool, 'DISCOUNT10', custId, 500000, false, { productSlugs: ['regular-item'] });
    assert.equal(okResult.voucher.code, 'DISCOUNT10');
    assert.ok(okResult.discountVnd > 0);
  } finally {
    await db.close();
  }
});
