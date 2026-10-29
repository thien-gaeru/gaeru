const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');
const { createProductReview, getProductReviews, generateReviewSchema } = require('../src/product-reviews');
const { lookupOrderTracking, calculateTimeline } = require('../src/tracking-api');
const { createProductBundle, getProductBundles } = require('../src/product-bundles');
const { createFlashSale, getActiveFlashSale } = require('../src/flash-sale');
const { registerPartner, attributeOrderCommission } = require('../src/affiliate-system');
const { normalizeZaloPhone, sendZaloZns } = require('../src/zalo-zns');
const { processCodReconciliation } = require('../src/cod-reconciliation');
const { searchAutocomplete } = require('../src/instant-search');
const { savePushSubscription, broadcastPushNotification } = require('../src/web-push');

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

test('Product Reviews calculates 5-star ratings, aggregate statistics and Schema.org JSON-LD', async () => {
  const { db, pool } = await setupTestDb();
  try {
    // 1. Submit reviews
    await createProductReview(pool, {
      productSlug: 'k9',
      authorName: 'Trần Văn B',
      rating: 5,
      title: 'Mic thu rất ấm và rõ',
      comment: 'Cắm vào iPhone 15 dùng ngay không cần cài đặt. Lọc ồn rất tốt khi quay ngoài trời.'
    });

    await createProductReview(pool, {
      productSlug: 'k9',
      authorName: 'Lê Thị C',
      rating: 4,
      title: 'Sản phẩm tốt',
      comment: 'Hài lòng với tầm giá, giao hàng Shopee Express nhanh.'
    });

    // 2. Fetch reviews and stats
    const result = await getProductReviews(pool, 'k9');
    assert.equal(result.stats.totalCount, 2);
    assert.equal(result.stats.averageRating, 4.5);
    assert.equal(result.stats.distribution[5], 1);
    assert.equal(result.stats.distribution[4], 1);
    assert.equal(result.reviews.length, 2);

    // 3. Schema.org generator
    const schema = generateReviewSchema({ name: 'GAERU K9', description: 'Mic thu âm' }, result.stats);
    assert.equal(schema['@type'], 'Product');
    assert.equal(schema.aggregateRating.ratingValue, '4.5');
    assert.equal(schema.aggregateRating.reviewCount, '2');
  } finally {
    await db.close();
  }
});

test('Public Order Tracking generates 5-step timeline and Shopee Express tracking links', async () => {
  const { db, pool } = await setupTestDb();
  try {
    // Insert test order
    const orderRes = await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd, note)
       VALUES ('GAERU-998877', 'Nguyễn Thị Hoa', 'hoa@example.com', '0987654321', 'Số 123 Đường Cầu Giấy', 'Hà Nội', 'cod', 'pending', 'shipped', 750000, 750000, 'Mã vận đơn SPX: SPX123456789VN')
       RETURNING id`
    );
    await pool.query(
      `INSERT INTO order_items (order_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
       VALUES ($1, 'GAERU K9', 'Type-C', 'K9-TPC', 750000, 1, 750000)`,
      [orderRes.rows[0].id]
    );

    // Lookup by phone
    const byPhone = await lookupOrderTracking(pool, '0987654321');
    assert.equal(byPhone.found, true);
    assert.equal(byPhone.orders[0].orderCode, 'GAERU-998877');
    assert.equal(byPhone.orders[0].spxTrackingCode, 'SPX123456789VN');
    assert.match(byPhone.orders[0].spxTrackingUrl, /SPX123456789VN/);

    // Timeline calculation
    const timeline = byPhone.orders[0].timeline;
    assert.equal(timeline.length, 5);
    // 'shipped' is step index 3
    assert.equal(timeline[0].completed, true);
    assert.equal(timeline[1].completed, true);
    assert.equal(timeline[2].completed, true);
    assert.equal(timeline[3].current, true);
    assert.equal(timeline[4].completed, false);
  } finally {
    await db.close();
  }
});

test('Product Bundles calculates savings and discounts for cross-sell accessories', async () => {
  const { db, pool } = await setupTestDb();
  try {
    // Create products
    const mainProd = (await pool.query(
      `INSERT INTO products (slug, name, category, active) VALUES ('k9', 'GAERU K9', 'audio', true) RETURNING id`
    )).rows[0];
    const accProd = (await pool.query(
      `INSERT INTO products (slug, name, category, active) VALUES ('bong-loc-k9', 'Bông lọc gió K9', 'accessory', true) RETURNING id`
    )).rows[0];

    await pool.query(
      `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'K9-WIND-01', 'Tiêu chuẩn', 60000, 50, true)`,
      [accProd.id]
    );

    // Create bundle: 30% discount
    await createProductBundle(pool, {
      mainProductSlug: 'k9',
      bundleProductSlug: 'bong-loc-k9',
      bundleTitle: 'Mua kèm bông lọc gió chuyên dụng ngoài trời',
      discountPercent: 30
    });

    const bundles = await getProductBundles(pool, 'k9');
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].originalPriceVnd, 60000);
    assert.equal(bundles[0].bundlePriceVnd, 42000); // 60k * 0.7 = 42k
    assert.equal(bundles[0].savingsVnd, 18000);
  } finally {
    await db.close();
  }
});

test('Flash Sale calculates active status, remaining seconds, and viewing counters', async () => {
  const { db, pool } = await setupTestDb();
  try {
    await createFlashSale(pool, {
      title: 'Flash Sale Cuối Tuần',
      startsAt: new Date(Date.now() - 3600000), // 1h ago
      endsAt: new Date(Date.now() + 7200000), // in 2h
      discountPercent: 20,
      productSlugs: ['k9', 'p01']
    });

    const activeSale = await getActiveFlashSale(pool);
    assert.equal(activeSale.active, true);
    assert.ok(activeSale.sale.remainingSeconds > 7000);
    assert.ok(activeSale.sale.viewingCount >= 10);
    assert.match(activeSale.sale.bannerText, /FLASH SALE/);
  } finally {
    await db.close();
  }
});

test('Affiliate System registers partners, attributes orders, and computes commissions', async () => {
  const { db, pool } = await setupTestDb();
  try {
    const partner = await registerPartner(pool, {
      partnerCode: 'KOC_TUAN',
      name: 'Tuấn Reviewer',
      commissionPercent: 10.0,
      bankName: 'MB Bank',
      bankAccount: '0988776655'
    });

    assert.equal(partner.partnerCode, 'KOC_TUAN');
    assert.equal(partner.commissionPercent, '10.00');

    // Attribute commission for an order of 2,000,000 VND
    const comm = await attributeOrderCommission(pool, {
      orderCode: 'GAERU-112233',
      totalVnd: 2000000,
      partnerCode: 'KOC_TUAN'
    });

    assert.equal(comm.commissionVnd, 200000); // 10% of 2M = 200k
    assert.equal(comm.status, 'pending');

    const updatedPartner = (await pool.query(`SELECT * FROM affiliate_partners WHERE partner_code = 'KOC_TUAN'`)).rows[0];
    assert.equal(updatedPartner.total_earnings_vnd, 200000);
    assert.equal(updatedPartner.total_orders, 1);
  } finally {
    await db.close();
  }
});

test('Zalo ZNS normalizes phone numbers and supports API dispatch', async () => {
  assert.equal(normalizeZaloPhone('0912345678'), '84912345678');
  assert.equal(normalizeZaloPhone('+84912345678'), '84912345678');

  // Test dry-run dispatch
  const result = await sendZaloZns({
    phone: '0912345678',
    templateId: 'tpl_order_confirmed',
    templateData: { order_code: 'GAERU-123' }
  });
  assert.equal(result.ok, true);
  assert.equal(result.phone, '84912345678');
});

test('COD Financial Reconciliation matches orders, calculates fees, and updates paid status', async () => {
  const { db, pool } = await setupTestDb();
  try {
    // Insert order pending COD payment
    await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd, note)
       VALUES ('GAERU-COD-01', 'Khách COD', 'cod@example.com', '0911223344', 'Số 1 Phố Huế', 'Hà Nội', 'cod', 'pending', 'shipped', 500000, 500000, 'SPX998877')`
    );

    const recResult = await processCodReconciliation(pool, {
      carrier: 'spx',
      fileName: 'doi-soat-t10.csv',
      items: [
        { trackingCode: 'SPX998877', orderCode: 'GAERU-COD-01', carrierCollectedVnd: 500000, feeVnd: 25000 }
      ]
    });

    assert.equal(recResult.ok, true);
    assert.equal(recResult.totalCollectedVnd, 500000);
    assert.equal(recResult.totalFeeVnd, 25000);
    assert.equal(recResult.netTransferredVnd, 475000);
    assert.equal(recResult.status, 'reconciled');

    // Order should now be marked as paid!
    const orderAfter = (await pool.query(`SELECT payment_status FROM orders WHERE order_number = 'GAERU-COD-01'`)).rows[0];
    assert.equal(orderAfter.payment_status, 'paid');
  } finally {
    await db.close();
  }
});

test('Instant Search Autocomplete finds products by prefix and keyword', async () => {
  const { db, pool } = await setupTestDb();
  try {
    const prod = (await pool.query(
      `INSERT INTO products (slug, name, descriptor, category, active)
       VALUES ('k9', 'GAERU K9', 'Micro thu âm cài áo chuyên nghiệp', 'audio', true)
       RETURNING id`
    )).rows[0];
    await pool.query(
      `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'K9-TPC', 'Type-C', 350000, 10, true)`,
      [prod.id]
    );

    const results = await searchAutocomplete(pool, 'mic', 5);
    assert.ok(results.length > 0);
    assert.equal(results[0].slug, 'k9');
    assert.equal(results[0].minPriceVnd, 350000);
  } finally {
    await db.close();
  }
});

test('Web Push Subscriptions registers browser endpoints and broadcasts notifications', async () => {
  const { db, pool } = await setupTestDb();
  try {
    const sub = await savePushSubscription(pool, {
      endpoint: 'https://fcm.googleapis.com/fcm/send/fake-endpoint-token-123',
      p256dh: 'BNcRdreAL...',
      auth: 'tBHIt8w...'
    });
    assert.equal(sub.endpoint, 'https://fcm.googleapis.com/fcm/send/fake-endpoint-token-123');

    const broadcast = await broadcastPushNotification(pool, {
      title: 'GAERU Giờ Vàng',
      body: 'Giảm giá 20% hôm nay!'
    });
    assert.equal(broadcast.ok, true);
    assert.equal(broadcast.recipientCount, 1);
  } finally {
    await db.close();
  }
});

test('HTTP Routes for Phase 2 upgrades mount and respond correctly', async () => {
  const { db, pool } = await setupTestDb();
  try {
    const app = createApp({
      pool,
      sessionStore: new session.MemoryStore(),
      config: {
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'https://gaeru.example',
        SESSION_SECRET: 'test-session-secret-phase2-32-chars-long',
        ADMIN_USERNAME: 'owner',
        ADMIN_PASSWORD_HASH: bcrypt.hashSync('Owner-phase2-123', 4)
      }
    });

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = 'http://127.0.0.1:' + server.address().port;

    try {
      // 1. Flash sale public route
      const flashRes = await fetch(`${base}/api/marketing/flash-sale`);
      assert.equal(flashRes.status, 200);

      // 2. Autocomplete search route
      const searchRes = await fetch(`${base}/api/products/search/autocomplete?q=k9`);
      assert.equal(searchRes.status, 200);

      // 3. Tracking static page route
      const trackPageRes = await fetch(`${base}/tra-cuu-don-hang`);
      assert.equal(trackPageRes.status, 200);
      const trackHtml = await trackPageRes.text();
      assert.match(trackHtml, /Tra cứu hành trình đơn hàng/);

      // 4. Push public key route
      const pushKeyRes = await fetch(`${base}/api/push/public-key`);
      assert.equal(pushKeyRes.status, 200);
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await db.close();
  }
});
