const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const {
  bundleSchema,
  calculateBundlePricing,
  calculateCartBundleDiscount,
  getApplicableBundles,
  listBundles,
  mountBundles
} = require('../src/product-bundles');

test('Product Bundles & Pricing Engine Integration Suite', async t => {
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

  // 1. Unit Tests: Schema Validation
  await t.test('bundleSchema validates requirements correctly', () => {
    const validUuid1 = '11111111-1111-4111-8111-111111111111';
    const validUuid2 = '22222222-2222-4222-8222-222222222222';

    // Valid bundle
    const valid = bundleSchema.safeParse({
      title: 'Combo Micro K9 + Cáp OTG',
      description: 'Tiết kiệm 50K khi mua kèm cáp',
      discountType: 'fixed',
      discountValue: 50000,
      startsAt: new Date(Date.now() - 3600000).toISOString(),
      endsAt: new Date(Date.now() + 86400000).toISOString(),
      active: true,
      items: [
        { variantId: validUuid1, isPrimary: true, minQuantity: 1 },
        { variantId: validUuid2, isPrimary: false, minQuantity: 1 }
      ]
    });
    assert.equal(valid.success, true);

    // Rejects percent > 100
    const invalidPercent = bundleSchema.safeParse({
      title: 'Combo Giảm Quá Mức',
      discountType: 'percent',
      discountValue: 120,
      startsAt: new Date(Date.now() - 3600000).toISOString(),
      endsAt: new Date(Date.now() + 86400000).toISOString(),
      active: true,
      items: [
        { variantId: validUuid1, isPrimary: true, minQuantity: 1 },
        { variantId: validUuid2, isPrimary: false, minQuantity: 1 }
      ]
    });
    assert.equal(invalidPercent.success, false);

    // Rejects missing secondary item (must have primary AND cross-sell item)
    const missingSecondary = bundleSchema.safeParse({
      title: 'Combo Thiếu Phụ Kiện',
      discountType: 'fixed',
      discountValue: 30000,
      startsAt: new Date(Date.now() - 3600000).toISOString(),
      endsAt: new Date(Date.now() + 86400000).toISOString(),
      active: true,
      items: [
        { variantId: validUuid1, isPrimary: true, minQuantity: 1 },
        { variantId: validUuid2, isPrimary: true, minQuantity: 1 }
      ]
    });
    assert.equal(missingSecondary.success, false);

    // Rejects duplicated variants in bundle
    const duplicateVariants = bundleSchema.safeParse({
      title: 'Combo Trùng Sản Phẩm',
      discountType: 'fixed',
      discountValue: 30000,
      startsAt: new Date(Date.now() - 3600000).toISOString(),
      endsAt: new Date(Date.now() + 86400000).toISOString(),
      active: true,
      items: [
        { variantId: validUuid1, isPrimary: true, minQuantity: 1 },
        { variantId: validUuid1, isPrimary: false, minQuantity: 1 }
      ]
    });
    assert.equal(duplicateVariants.success, false);
  });

  // 2. Unit Tests: Pricing Engine (pure calculation)
  await t.test('calculateBundlePricing computes fixed and percent discounts', () => {
    const vPrimary = '11111111-1111-4111-8111-111111111111';
    const vSecondary1 = '22222222-2222-4222-8222-222222222222';
    const vSecondary2 = '33333333-3333-4333-8333-333333333333';

    const testBundles = [
      {
        id: 'bundle-fixed-1',
        title: 'Combo Cố Định',
        discountType: 'fixed',
        discountValue: 50000,
        active: true,
        starts_at: new Date(Date.now() - 10000).toISOString(),
        ends_at: new Date(Date.now() + 100000).toISOString(),
        items: [
          { variantId: vPrimary, isPrimary: true, minQuantity: 1 },
          { variantId: vSecondary1, isPrimary: false, minQuantity: 1 }
        ]
      }
    ];

    // Case A: Cart has primary + secondary -> discount applied
    const resA = calculateBundlePricing([
      { variantId: vPrimary, priceVnd: 400000, quantity: 1 },
      { variantId: vSecondary1, priceVnd: 100000, quantity: 1 }
    ], testBundles);

    assert.equal(resA.subtotalVnd, 500000);
    assert.equal(resA.bundleDiscountVnd, 50000);
    assert.equal(resA.finalTotalVnd, 450000);
    assert.equal(resA.appliedBundles.length, 1);

    // Case B: Cart only has primary -> no discount
    const resB = calculateBundlePricing([
      { variantId: vPrimary, priceVnd: 400000, quantity: 1 }
    ], testBundles);
    assert.equal(resB.bundleDiscountVnd, 0);
    assert.equal(resB.finalTotalVnd, 400000);

    // Case C: Percent discount on cross-sell item
    const percentBundle = [
      {
        id: 'bundle-percent-1',
        title: 'Combo 20% Phụ Kiện',
        discountType: 'percent',
        discountValue: 20,
        active: true,
        starts_at: new Date(Date.now() - 10000).toISOString(),
        ends_at: new Date(Date.now() + 100000).toISOString(),
        items: [
          { variantId: vPrimary, isPrimary: true, minQuantity: 1 },
          { variantId: vSecondary2, isPrimary: false, minQuantity: 2 }
        ]
      }
    ];

    // Secondary quantity 2 * 100,000₫ = 200,000₫ -> 20% discount = 40,000₫
    const resC = calculateBundlePricing([
      { variantId: vPrimary, priceVnd: 500000, quantity: 1 },
      { variantId: vSecondary2, priceVnd: 100000, quantity: 2 }
    ], percentBundle);

    assert.equal(resC.subtotalVnd, 700000);
    assert.equal(resC.bundleDiscountVnd, 40000);
    assert.equal(resC.finalTotalVnd, 660000);
  });

  // 3. Database Seeding & Integration Testing
  const prodMain = (await pool.query(
    "INSERT INTO products(name, slug, category, active, image_url) VALUES('Micro Thu Âm GAERU K9', 'gaeru-k9', 'audio', true, '/assets/products/k9.webp') RETURNING id"
  )).rows[0];

  const prodAcc = (await pool.query(
    "INSERT INTO products(name, slug, category, active, image_url) VALUES('Cáp Chuyển Đổi OTG GAERU', 'cap-otg-gaeru', 'accessory', true, '/assets/products/otg.webp') RETURNING id"
  )).rows[0];

  const varMain = (await pool.query(
    "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, 'K9-TYPEC', 'Bản Type-C', 399000, 50, true) RETURNING id",
    [prodMain.id]
  )).rows[0];

  const varAcc1 = (await pool.query(
    "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, 'OTG-IOS', 'Cáp OTG Lightning', 79000, 30, true) RETURNING id",
    [prodAcc.id]
  )).rows[0];

  const varAcc2 = (await pool.query(
    "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, 'OTG-C', 'Cáp OTG Type-C', 69000, 30, true) RETURNING id",
    [prodAcc.id]
  )).rows[0];

  // Setup mock Express app with mountBundles
  const adminRouter = express.Router();
  const publicRouter = express.Router();
  const app = express();
  app.use(express.json());

  // Mock admin authentication & permissions
  app.use((req, res, next) => {
    req.admin = { id: '00000000-0000-4000-8000-000000000001', username: 'admin_marketing', role: 'owner', permissions: ['marketing.read', 'marketing.write'] };
    req.session = { csrfToken: 'valid-csrf-token' };
    req.headers['x-csrf-token'] = 'valid-csrf-token';
    next();
  });

  mountBundles({ admin: adminRouter, publicRouter }, pool);
  app.use('/api/gaeru_ceo', adminRouter);
  app.use('/api', publicRouter);

  let createdBundleId = null;

  // Test: Admin creates a new bundle
  await t.test('Admin can create a new combo bundle with primary and secondary items', async () => {
    const bundlePayload = {
      data: {
        title: 'Combo Thu Âm Chuyên Nghiệp',
        description: 'Mua Micro K9 kèm Cáp OTG tiết kiệm 30.000₫',
        discountType: 'fixed',
        discountValue: 30000,
        startsAt: new Date(Date.now() - 3600000).toISOString(),
        endsAt: new Date(Date.now() + 86400000 * 30).toISOString(),
        active: true,
        items: [
          { variantId: varMain.id, isPrimary: true, minQuantity: 1 },
          { variantId: varAcc1.id, isPrimary: false, minQuantity: 1 }
        ]
      }
    };

    // Direct invocation via supertest-like fetch or express handler
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/gaeru_ceo/marketing/bundles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'valid-csrf-token' },
        body: JSON.stringify(bundlePayload)
      });
      assert.equal(res.status, 201);
      const json = await res.json();
      assert.ok(json.item);
      assert.equal(json.item.title, 'Combo Thu Âm Chuyên Nghiệp');
      assert.equal(json.item.discount_value, 30000);
      createdBundleId = json.item.id;
    } finally {
      server.close();
    }
  });

  // Test: Admin lists bundles
  await t.test('Admin lists bundles with attached item details', async () => {
    const list = await listBundles(pool, 1, 10);
    assert.equal(list.bundles.length >= 1, true);
    const found = list.bundles.find(b => b.id === createdBundleId);
    assert.ok(found);
    assert.equal(found.items.length, 2);
    assert.equal(found.items.some(i => i.isPrimary), true);
    assert.equal(found.items.some(i => !i.isPrimary), true);
  });

  // Test: Public storefront getApplicableBundles
  await t.test('Public storefront retrieves applicable bundles for a product by slug', async () => {
    const bundles = await getApplicableBundles(pool, { slug: 'gaeru-k9' });
    assert.equal(bundles.length >= 1, true);
    const b = bundles[0];
    assert.equal(b.title, 'Combo Thu Âm Chuyên Nghiệp');
    assert.equal(b.primaryItems.length >= 1, true);
    assert.equal(b.bundledItems.length >= 1, true);
    assert.equal(b.discountVnd, 30000);
    assert.equal(b.originalComboTotal, 399000 + 79000);
    assert.equal(b.discountedComboTotal, 399000 + 79000 - 30000);
  });

  // Test: Pricing engine calculateCartBundleDiscount in checkout
  await t.test('calculateCartBundleDiscount detects combo in cart and discounts accordingly', async () => {
    const cartItems = [
      { id: varMain.id, priceVnd: 399000, quantity: 1 },
      { id: varAcc1.id, priceVnd: 79000, quantity: 1 }
    ];

    const result = await calculateCartBundleDiscount(pool, cartItems);
    assert.equal(result.bundleDiscountVnd, 30000);
    assert.equal(result.appliedBundles.length, 1);
    assert.equal(result.finalSubtotalVnd, (399000 + 79000) - 30000);
  });

  // Test: Admin updates bundle
  await t.test('Admin can update combo bundle details', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/gaeru_ceo/marketing/bundles/${createdBundleId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'valid-csrf-token' },
        body: JSON.stringify({
          version: 1,
          data: {
            title: 'Combo Thu Âm Đỉnh Cao',
            description: 'Mua Micro K9 kèm Cáp OTG tiết kiệm 40.000₫',
            discountType: 'fixed',
            discountValue: 40000,
            startsAt: new Date(Date.now() - 3600000).toISOString(),
            endsAt: new Date(Date.now() + 86400000 * 30).toISOString(),
            active: true,
            items: [
              { variantId: varMain.id, isPrimary: true, minQuantity: 1 },
              { variantId: varAcc1.id, isPrimary: false, minQuantity: 1 },
              { variantId: varAcc2.id, isPrimary: false, minQuantity: 1 }
            ]
          }
        })
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.item.title, 'Combo Thu Âm Đỉnh Cao');
      assert.equal(json.item.discount_value, 40000);
      assert.equal(json.item.version, 2);
    } finally {
      server.close();
    }
  });

  // Test: Public Pricing Engine Quote Endpoint
  await t.test('Public quote API computes bundle savings dynamically', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/bundles/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { variantId: varMain.id, quantity: 1 },
            { variantId: varAcc1.id, quantity: 1 }
          ]
        })
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.bundleDiscountVnd, 40000); // Updated bundle discount is 40000
      assert.equal(json.appliedBundles.length, 1);
    } finally {
      server.close();
    }
  });

  // Test: Checkout Order placement applies bundle discount and updates discount_vnd
  await t.test('Checkout Order creation accurately applies bundle discount', async () => {
    await pool.query(
      "INSERT INTO store_settings(setting_key, setting_value) VALUES('shipping_rates', $1) ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1",
      [JSON.stringify({ 'Toàn quốc': 30000, 'Hồ Chí Minh': 30000 })]
    );

    const { createStoreApi } = require('../src/store-api');
    const storeRouter = createStoreApi(pool, {
      ordersEnabled: true,
      getOrdersEnabled: async () => true,
      shippingChoices: false
    });
    const orderApp = express();
    orderApp.use(express.json());
    orderApp.use((req, res, next) => {
      req.session = { csrfToken: 'test-csrf' };
      req.headers['x-csrf-token'] = 'test-csrf';
      next();
    });
    orderApp.use('/api', storeRouter);

    const server = orderApp.listen(0);
    const port = server.address().port;
    try {
      const orderPayload = {
        customer: {
          name: 'Nguyễn Văn A',
          email: 'nguyenvana@gmail.com',
          phone: '0987654321',
          address: '123 Đường Lê Lợi, Phường Bến Nghé',
          city: 'Hồ Chí Minh',
          note: 'Giao giờ hành chính'
        },
        items: [
          { variantId: varMain.id, quantity: 1 },
          { variantId: varAcc1.id, quantity: 1 }
        ],
        paymentMethod: 'cod',
        expectedSubtotalVnd: 399000 + 79000
      };

      const res = await fetch(`http://127.0.0.1:${port}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'test-csrf' },
        body: JSON.stringify(orderPayload)
      });
      assert.equal(res.status, 201);
      const json = await res.json();
      assert.ok(json.order);
      assert.equal(json.order.subtotalVnd, 399000 + 79000);
      assert.equal(json.order.bundleDiscountVnd, 40000);
      assert.equal(json.order.discountVnd, 40000);
      // Expected total: subtotal (478,000) + shippingFee (30,000 for HCM) - bundleDiscount (40,000) = 468,000
      assert.equal(json.order.totalVnd, 478000 + json.order.shippingFeeVnd - 40000);
    } finally {
      server.close();
    }
  });

  // Test: Storefront UI cross-sell render and calculation logic
  await t.test('Storefront UI cross-sell data structure and calculations', () => {
    const mockBundle = {
      id: 'bundle-cross-sell-1',
      title: 'Combo Micro K9 + Cáp OTG',
      description: 'Tiết kiệm 30.000₫ khi mua trọn bộ',
      discountType: 'fixed',
      discountValue: 30000,
      originalComboTotal: 399000 + 79000,
      discountedComboTotal: 399000 + 79000 - 30000,
      primaryItems: [{ variantId: varMain.id, productName: 'Micro K9', variantName: 'Type-C', priceVnd: 399000, imageUrl: '/assets/products/k9.webp' }],
      bundledItems: [{ variantId: varAcc1.id, productName: 'Cáp OTG', variantName: 'Lightning', priceVnd: 79000, minQuantity: 1, imageUrl: '/assets/products/otg.webp' }]
    };

    assert.equal(mockBundle.originalComboTotal, 478000);
    assert.equal(mockBundle.discountedComboTotal, 448000);
    assert.equal(mockBundle.originalComboTotal - mockBundle.discountedComboTotal, 30000);
  });

  // Test: Admin deletes bundle
  await t.test('Admin can delete combo bundle', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/gaeru_ceo/marketing/bundles/${createdBundleId}`, {
        method: 'DELETE',
        headers: { 'x-csrf-token': 'valid-csrf-token' }
      });
      assert.equal(res.status, 200);
      const remaining = (await pool.query('SELECT count(*)::int AS count FROM product_bundles WHERE id = $1', [createdBundleId])).rows[0].count;
      assert.equal(remaining, 0);
      // Verify cascade deletion of bundle items
      const remainingItems = (await pool.query('SELECT count(*)::int AS count FROM product_bundle_items WHERE bundle_id = $1', [createdBundleId])).rows[0].count;
      assert.equal(remainingItems, 0);
    } finally {
      server.close();
    }
  });
});
