'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');
const { productBody } = require('../src/seo-pages');

test('Product marketplace purchase links (Shopee & TikTok Shop) lifecycle and rendering', { timeout: 60000 }, async (t) => {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise((r) => (release = r));
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

  // Check columns exist in products
  const colRes = await pool.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'products' AND column_name IN ('shopee_url', 'tiktok_shop_url')
  `);
  assert.equal(colRes.rows.length, 2, 'shopee_url and tiktok_shop_url must exist on products');

  const password = 'Marketplace-Owner-2026';
  const app = createApp({
    pool,
    sessionStore: new session.MemoryStore(),
    config: {
      NODE_ENV: 'test',
      SESSION_SECRET: 'marketplace-secret-32-chars-long!',
      ADMIN_USERNAME: 'marketplace-admin',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync(password, 4)
    }
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await db.close();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrf = '';

  async function api(path, method = 'GET', body, withCsrf = true) {
    const r = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        ...(withCsrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {})
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
    });
    if (r.headers.get('set-cookie')) {
      cookie = r.headers.get('set-cookie').split(';')[0];
    }
    const data = r.headers.get('content-type')?.includes('application/json') ? await r.json() : null;
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: r.status, data };
  }

  // Login as admin
  await api('/api/csrf');
  const loginRes = await api('/api/auth/login', 'POST', { username: 'marketplace-admin', password });
  assert.equal(loginRes.status, 200, 'Admin login must succeed');

  // Create product with Shopee & TikTok links
  const initialPayload = {
    product: {
      name: 'Micro GAERU M3 Pro',
      slug: 'gaeru-m3-pro',
      category: 'audio',
      descriptor: 'Micro thu âm đa năng',
      cardTitle: 'M3 Pro',
      cardSummary: 'Âm thanh chuyên nghiệp cho mọi nhà sáng tạo.',
      description: 'Mô tả chi tiết sản phẩm M3 Pro.',
      imageUrl: '/assets/products/k9.webp',
      imageAlt: 'Micro M3 Pro',
      active: true,
      sortOrder: 1,
      shopeeUrl: 'https://shopee.vn/gaeru-m3-pro-official',
      tiktokShopUrl: 'https://vn.tiktok.com/@gaerustore/live-m3'
    },
    gallery: ['/assets/products/k9.webp'],
    groups: [],
    variants: [
      {
        sku: 'M3PRO-01',
        name: 'Bản Tiêu Chuẩn',
        options: {},
        priceVnd: 450000,
        stockQuantity: 20,
        active: true,
        imageUrl: '/assets/products/k9.webp'
      }
    ]
  };

  const createRes = await api('/api/gaeru_ceo/product-workspace', 'POST', initialPayload);
  assert.equal(createRes.status, 201, `Create must succeed: ${JSON.stringify(createRes.data)}`);
  assert.equal(createRes.data.product.shopeeUrl, 'https://shopee.vn/gaeru-m3-pro-official');
  assert.equal(createRes.data.product.tiktokShopUrl, 'https://vn.tiktok.com/@gaerustore/live-m3');

  const productId = createRes.data.id;

  // Read product back from admin workspace
  const readRes = await api(`/api/gaeru_ceo/product-workspace/${productId}`);
  assert.equal(readRes.status, 200);
  assert.equal(readRes.data.product.shopeeUrl, 'https://shopee.vn/gaeru-m3-pro-official');
  assert.equal(readRes.data.product.tiktokShopUrl, 'https://vn.tiktok.com/@gaerustore/live-m3');

  // Check public storefront API
  const publicRes = await api('/api/products');
  assert.equal(publicRes.status, 200);
  const publicProduct = publicRes.data.products.find((p) => p.id === productId);
  assert.ok(publicProduct, 'Product must appear in public catalog');
  assert.equal(publicProduct.shopeeUrl, 'https://shopee.vn/gaeru-m3-pro-official');
  assert.equal(publicProduct.tiktokShopUrl, 'https://vn.tiktok.com/@gaerustore/live-m3');

  // SSR Rendering Tests
  // Case 1: Both Shopee & TikTok Shop links provided
  const ssrBoth = productBody(publicProduct);
  assert.ok(ssrBoth.includes('product-marketplace-actions'), 'Should contain marketplace actions block');
  assert.ok(ssrBoth.includes('marketplace-divider'), 'Should contain marketplace divider');
  assert.ok(ssrBoth.includes('Hoặc đặt mua chính hãng tại'), 'Should contain marketplace title divider text');
  assert.ok(ssrBoth.includes('button-marketplace button-shopee'), 'Should have Shopee marketplace button class');
  assert.ok(ssrBoth.includes('button-marketplace button-tiktok'), 'Should have TikTok marketplace button class');
  assert.ok(ssrBoth.includes('shopee-icon'), 'Should contain Shopee icon SVG');
  assert.ok(ssrBoth.includes('tiktok-icon'), 'Should contain TikTok icon SVG');
  assert.ok(ssrBoth.includes('#25F4EE') && ssrBoth.includes('#FE2C55'), 'TikTok icon should have authentic chromatic colors');
  assert.ok(ssrBoth.includes('Mua ở Shopee'), 'Should contain Shopee button');
  assert.ok(ssrBoth.includes('Mua ở TikTok Shop'), 'Should contain TikTok Shop button');
  assert.ok(ssrBoth.includes('https://shopee.vn/gaeru-m3-pro-official'), 'Shopee URL should be in href');
  assert.ok(ssrBoth.includes('https://vn.tiktok.com/@gaerustore/live-m3'), 'TikTok URL should be in href');
  assert.ok(ssrBoth.includes('target="_blank"'), 'Must open in new tab');
  assert.ok(ssrBoth.includes('rel="noopener noreferrer"'), 'Must have safe rel attribute');

  // Case 2: Only Shopee provided
  const productShopeeOnly = { ...publicProduct, shopeeUrl: 'https://shopee.vn/gaeru-shopee', tiktokShopUrl: '' };
  const ssrShopee = productBody(productShopeeOnly);
  assert.ok(ssrShopee.includes('product-marketplace-actions'));
  assert.ok(ssrShopee.includes('Mua ở Shopee'));
  assert.ok(!ssrShopee.includes('Mua ở TikTok Shop'), 'TikTok button must NOT appear');

  // Case 3: Only TikTok Shop provided
  const productTikTokOnly = { ...publicProduct, shopeeUrl: '', tiktokShopUrl: 'https://vn.tiktok.com/@gaeru/shop' };
  const ssrTikTok = productBody(productTikTokOnly);
  assert.ok(ssrTikTok.includes('product-marketplace-actions'));
  assert.ok(!ssrTikTok.includes('Mua ở Shopee'), 'Shopee button must NOT appear');
  assert.ok(ssrTikTok.includes('Mua ở TikTok Shop'));

  // Case 4: Neither provided
  const productNone = { ...publicProduct, shopeeUrl: '', tiktokShopUrl: '' };
  const ssrNone = productBody(productNone);
  assert.ok(!ssrNone.includes('product-marketplace-actions'), 'Marketplace block must NOT be rendered when no URLs');
  assert.ok(!ssrNone.includes('Mua ở Shopee'));
  assert.ok(!ssrNone.includes('Mua ở TikTok Shop'));

  // Update product to change TikTok URL and clear Shopee URL
  const updatePayload = {
    ...readRes.data,
    product: {
      ...readRes.data.product,
      shopeeUrl: '',
      tiktokShopUrl: 'https://shop.tiktok.com/view/product/999'
    }
  };

  const updateRes = await api('/api/gaeru_ceo/product-workspace', 'POST', updatePayload);
  assert.equal(updateRes.status, 200, 'Update must succeed');
  assert.equal(updateRes.data.product.shopeeUrl, '');
  assert.equal(updateRes.data.product.tiktokShopUrl, 'https://shop.tiktok.com/view/product/999');

  const readUpdated = await api(`/api/gaeru_ceo/product-workspace/${productId}`);
  assert.equal(readUpdated.data.product.shopeeUrl, '');
  assert.equal(readUpdated.data.product.tiktokShopUrl, 'https://shop.tiktok.com/view/product/999');
});

test('commerce.js storefront client-side rendering for Shopee & TikTok Shop buttons', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const full = fs.readFileSync(require('node:path').join(__dirname, '../commerce.js'), 'utf8');
  const source = full.split('function renderProduct() {')[1].split('function renderCart() {')[0];
  const safeImage = full.slice(full.indexOf('function getPriceLabel'), full.indexOf('function renderProduct'));
  const helperFns = 'const formatPrice=(n)=>n+"₫"; const escapeHtml=(s)=>String(s??""); const normalizeExternalUrl=(u)=>!u?"":(u.startsWith("http")?u:"https://"+u); ';

  function runRender(product) {
    let renderedHtml = '';
    const root = {
      innerHTML: '',
      querySelector: () => ({ addEventListener: () => {}, dataset: {}, textContent: '' }),
      querySelectorAll: () => [],
      addEventListener: () => {}
    };
    const document = {
      title: '',
      querySelector: (sel) => {
        if (sel === '#product-detail') return root;
        return { textContent: '' };
      }
    };
    const location = { search: '?id=' + product.slug, pathname: '/product.html' };

    vm.runInNewContext(helperFns + safeImage + 'function renderProduct(){' + source + '\nrenderProduct();', {
      document,
      location,
      products: [product],
      window: {},
      URLSearchParams
    });
    return root.innerHTML;
  }

  // 1. Both links present
  const htmlBoth = runRender({
    slug: 'test-item',
    name: 'Test Item',
    descriptor: 'Desc',
    imageUrl: '/assets/products/k9.webp',
    variants: [{ id: 'v1', name: 'Var 1', sku: 'V1', active: true, priceVnd: 100000, stockQuantity: 10 }],
    shopeeUrl: 'https://shopee.vn/test-item',
    tiktokShopUrl: 'https://vn.tiktok.com/@shop/item'
  });
  assert.ok(htmlBoth.includes('product-marketplace-actions'));
  assert.ok(htmlBoth.includes('marketplace-divider'));
  assert.ok(htmlBoth.includes('button-shopee'));
  assert.ok(htmlBoth.includes('shopee-icon'));
  assert.ok(htmlBoth.includes('Mua ở Shopee'));
  assert.ok(htmlBoth.includes('https://shopee.vn/test-item'));
  assert.ok(htmlBoth.includes('button-tiktok'));
  assert.ok(htmlBoth.includes('tiktok-icon'));
  assert.ok(htmlBoth.includes('#25F4EE') && htmlBoth.includes('#FE2C55'));
  assert.ok(htmlBoth.includes('Mua ở TikTok Shop'));
  assert.ok(htmlBoth.includes('https://vn.tiktok.com/@shop/item'));

  // 2. Shopee only
  const htmlShopee = runRender({
    slug: 'test-shopee-only',
    name: 'Test Shopee Only',
    imageUrl: '/assets/products/k9.webp',
    variants: [{ id: 'v1', name: 'Var 1', sku: 'V1', active: true, priceVnd: 100000, stockQuantity: 10 }],
    shopeeUrl: 'shopee.vn/normalized',
    tiktokShopUrl: ''
  });
  assert.ok(htmlShopee.includes('product-marketplace-actions'));
  assert.ok(htmlShopee.includes('button-shopee'));
  assert.ok(htmlShopee.includes('https://shopee.vn/normalized'));
  assert.ok(!htmlShopee.includes('button-tiktok'));

  // 3. Neither
  const htmlNeither = runRender({
    slug: 'test-neither',
    name: 'Test Neither',
    imageUrl: '/assets/products/k9.webp',
    variants: [{ id: 'v1', name: 'Var 1', sku: 'V1', active: true, priceVnd: 100000, stockQuantity: 10 }],
    shopeeUrl: '',
    tiktokShopUrl: ''
  });
  assert.ok(!htmlNeither.includes('product-marketplace-actions'));
  assert.ok(!htmlNeither.includes('Mua ở Shopee'));
  assert.ok(!htmlNeither.includes('Mua ở TikTok Shop'));
});

