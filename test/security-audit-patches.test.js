'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { _webhookAuthMiddleware, processOmnichannelEvent, createOmnichannelRouter } = require('../src/omnichannel-sync');
const { lookupOrderTracking } = require('../src/tracking-api');
const { getRecentSocialProof } = require('../src/social-proof');
const { createAffiliatePublicRouter } = require('../src/affiliate-system');
const { applyPromotions } = require('../src/product-promotions');
const { createFlashSale } = require('../src/flash-sale');

async function setupTestDb() {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise(r => release = r);
    await previous;
    return release;
  }
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try {
        return await query(sql, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    }
  };
  await migrateDatabase(pool);
  return { db, pool };
}

test('P0: Webhook omnichannel sync rejects missing or invalid signatures', async () => {
  const secret = 'super-secret-key-at-least-32-chars-long!';
  const middleware = _webhookAuthMiddleware({ OMNICHANNEL_WEBHOOK_SECRET: secret });

  // 1. Missing headers -> 401
  let status = 0, jsonMsg = null;
  const fakeRes1 = { status(s) { status = s; return this; }, json(j) { jsonMsg = j; } };
  middleware({ headers: {}, body: {} }, fakeRes1, () => {});
  assert.equal(status, 401);
  assert.match(jsonMsg.error, /thiếu tiêu đề/);

  // 2. Expired timestamp -> 401
  let calledNext = false;
  const oldTs = Math.floor(Date.now() / 1000) - 600; // 10 mins ago
  middleware({
    headers: {
      'x-webhook-timestamp': String(oldTs),
      'x-webhook-signature': 'deadbeef'
    },
    body: {}
  }, fakeRes1, () => { calledNext = true; });
  assert.equal(status, 401);
  assert.match(jsonMsg.error, /hết hạn/);
  assert.equal(calledNext, false);

  // 3. Valid signature and timestamp -> next() called
  const validTs = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ sku: 'TEST', delta: 5 });
  const validSig = crypto.createHmac('sha256', secret).update(`${validTs}.${payload}`).digest('hex');
  let successNext = false;
  middleware({
    headers: {
      'x-webhook-timestamp': String(validTs),
      'x-webhook-signature': validSig
    },
    body: { sku: 'TEST', delta: 5 }
  }, fakeRes1, () => { successNext = true; });
  assert.equal(successNext, true);
});

test('P1: Tracking API masks PII and limits exposure', async () => {
  const { db, pool } = await setupTestDb();
  try {
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, subtotal_vnd, total_vnd, status, payment_method, payment_status)
       VALUES ('11111111-2222-3333-4444-555555555555', 'GAERU-SEC-01', 'Nguyễn Văn Hoàng', 'hoang@example.com', '0912345678', '123 Đường Hai Bà Trưng, Phường 6, Quận 3, TP. Hồ Chí Minh', 'TP. Hồ Chí Minh', 650000, 650000, 'shipped', 'cod', 'pending')`
    );

    const result = await lookupOrderTracking(pool, 'GAERU-SEC-01');
    assert.equal(result.found, true);
    const order = result.orders[0];

    // Verify PII is masked
    assert.equal(order.customerPhoneMasked, '091****678');
    assert.notEqual(order.customerName, 'Nguyễn Văn Hoàng');
    assert.match(order.customerName, /H\./); // e.g. "Văn H."
    assert.doesNotMatch(order.shippingAddress, /123 Đường Hai Bà Trưng/);
    assert.match(order.shippingAddress, /TP\. Hồ Chí Minh/);
  } finally {
    await db.close();
  }
});

test('P1: Flash Sale campaigns synchronize with product promotions and checkout pricing', async () => {
  const { db, pool } = await setupTestDb();
  try {
    // 1. Create a product and active flash sale for slug 'k9'
    const now = new Date();
    await createFlashSale(pool, {
      title: 'Flash Sale Đồng Bộ',
      startsAt: new Date(now.getTime() - 3600000),
      endsAt: new Date(now.getTime() + 7200000),
      discountPercent: 20,
      productSlugs: ['k9']
    });

    // 2. Run applyPromotions on variants of k9
    const dummyVariant = {
      id: '22222222-3333-4444-5555-666666666666',
      productSlug: 'k9',
      priceVnd: 1000000
    };

    const priced = await applyPromotions(pool, [dummyVariant]);
    assert.equal(priced[0].priceVnd, 800000); // 20% off from 1,000,000
    assert.equal(priced[0].promotion.type, 'flash');
    assert.equal(priced[0].promotion.discountPercent, 20);
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
    // Should return fallback sales with clear transparent flag isSimulated: true
    assert.ok(Array.isArray(items));
    assert.ok(items.length > 0);
    assert.ok(items.every(i => i.isSimulated === true));
    assert.ok(items.every(i => typeof i.note === 'string'));
  } finally {
    await db.close();
  }
});

test('P1: Admin Helmet CSP compliance: All admin markup and dynamic templates have zero inline onclick / onsubmit', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const adminIndex = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  const upgradesHub = fs.readFileSync(path.join(__dirname, '..', 'admin', 'upgrades-hub.js'), 'utf8');

  // Verify no inline event handler attributes exist in admin/index.html or generated templates in upgrades-hub.js
  assert.doesNotMatch(adminIndex, /\bonclick\s*=/i, 'admin/index.html must not contain inline onclick attributes');
  assert.doesNotMatch(adminIndex, /\bonsubmit\s*=/i, 'admin/index.html must not contain inline onsubmit attributes');
  assert.doesNotMatch(upgradesHub, /<[^>]*\bonclick\s*=/i, 'admin/upgrades-hub.js templates must not contain inline onclick');
  assert.doesNotMatch(upgradesHub, /<[^>]*\bonsubmit\s*=/i, 'admin/upgrades-hub.js templates must not contain inline onsubmit');
});

test('P1: Marketing eligible rejects vouchers when product is in active Flash Sale', async () => {
  const { db, pool } = await setupTestDb();
  try {
    const { eligible } = require('../src/marketing');
    // Create customer and voucher
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

    // Active flash sale with product slug 'flash-item'
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

test('P2: Phone normalization in order tracking handles local 0..., E.164 +84..., and raw 84... formats', async () => {
  const { db, pool } = await setupTestDb();
  try {
    const { normalizeVietnamPhone } = require('../src/tracking-api');
    assert.equal(normalizeVietnamPhone('+84901234567'), '0901234567');
    assert.equal(normalizeVietnamPhone('+84 901 234 567'), '0901234567');
    assert.equal(normalizeVietnamPhone('84901234567'), '0901234567');
    assert.equal(normalizeVietnamPhone('090-123-4567'), '0901234567');

    // Insert order stored with local '0901234567'
    await pool.query(
      `INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, subtotal_vnd, total_vnd, status, payment_method, payment_status)
       VALUES ('55555555-6666-7777-8888-999999999999', 'GAERU-PHONE-01', 'Lê Thị Mai', 'mai@example.com', '0901234567', '456 Phố Huế, Hai Bà Trưng, Hà Nội', 'Hà Nội', 450000, 450000, 'processing', 'bank_transfer', 'pending')`
    );

    // 1. Lookup with E.164 format: '+84 901 234 567'
    const resE164 = await lookupOrderTracking(pool, '+84 901 234 567');
    assert.equal(resE164.found, true);
    assert.equal(resE164.orders[0].orderCode, 'GAERU-PHONE-01');

    // 2. Lookup with 84 format: '84901234567'
    const res84 = await lookupOrderTracking(pool, '84901234567');
    assert.equal(res84.found, true);
    assert.equal(res84.orders[0].orderCode, 'GAERU-PHONE-01');

    // 3. Lookup with hyphenated local format: '090-123-4567'
    const resHyphen = await lookupOrderTracking(pool, '090-123-4567');
    assert.equal(resHyphen.found, true);
    assert.equal(resHyphen.orders[0].orderCode, 'GAERU-PHONE-01');
  } finally {
    await db.close();
  }
});

