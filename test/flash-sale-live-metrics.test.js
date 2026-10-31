'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDb } = require('./helpers/pglite-db');
const {
  getActiveFlashSale,
  createFlashSale,
  createFlashSalePublicRouter,
  createFlashSaleAdminRouter
} = require('../src/flash-sale');
const { PricingEngine } = require('../src/domain/pricing/pricing-engine');

test('Flash Sale: Live database lifecycle, transactional promotions linking, real-time traffic viewer count, and PricingEngine discounting', async (t) => {
  const { pool } = await createTestDb({ migrate: false });

  // 0. Khởi tạo cấu trúc bảng CSDL
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id serial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      name text NOT NULL,
      price numeric(12, 2) NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS product_variants (
      id serial PRIMARY KEY,
      product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      sku text NOT NULL UNIQUE,
      title text NOT NULL,
      price numeric(12, 2) NOT NULL,
      active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS product_promotions (
      id serial PRIMARY KEY,
      title text NOT NULL,
      type text NOT NULL DEFAULT 'standard',
      kind text NOT NULL DEFAULT 'percent',
      amount numeric(12, 2) NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS product_promotion_variants (
      promotion_id integer NOT NULL REFERENCES product_promotions(id) ON DELETE CASCADE,
      variant_id integer NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
      PRIMARY KEY (promotion_id, variant_id)
    );
    CREATE TABLE IF NOT EXISTS flash_sales (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      discount_percent integer NOT NULL DEFAULT 15 CHECK (discount_percent >= 1 AND discount_percent <= 90),
      product_slugs text[] NOT NULL DEFAULT '{}',
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS site_traffic_realtime (
      visitor_hash text PRIMARY KEY,
      path text NOT NULL,
      last_seen_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const pRes = await pool.query(`
    INSERT INTO products (slug, name, price, active) VALUES
    ('gaeru-speaker-m3', 'Loa Bluetooth GAERU M3', 800000, true),
    ('gaeru-case-pro', 'Bao Da Cao Cấp GAERU', 200000, true)
    RETURNING id, slug;
  `);

  const pM3Id = pRes.rows.find(r => r.slug === 'gaeru-speaker-m3').id;
  const pCaseId = pRes.rows.find(r => r.slug === 'gaeru-case-pro').id;

  const vRes = await pool.query(`
    INSERT INTO product_variants (product_id, sku, title, price, active) VALUES
    ($1, 'M3-BLK', 'Bản Đen', 800000, true),
    ($2, 'CASE-BRN', 'Bản Nâu', 200000, true)
    RETURNING id, sku;
  `, [pM3Id, pCaseId]);

  const m3VariantId = vRes.rows.find(r => r.sku === 'M3-BLK').id;
  const caseVariantId = vRes.rows.find(r => r.sku === 'CASE-BRN').id;

  t.after(async () => {
    await pool.end().catch(() => {});
  });

  await t.test('1. getActiveFlashSale returns false when no campaign is active', async () => {
    const res = await getActiveFlashSale(pool);
    assert.equal(res.active, false);
    assert.equal(res.sale, null);
  });

  await t.test('2. createFlashSale creates campaign, links product_promotions and product_promotion_variants', async () => {
    const created = await createFlashSale(pool, {
      title: 'Flash Sale Cuối Tuần Loa M3',
      startsAt: new Date(Date.now() - 10000),
      endsAt: new Date(Date.now() + 3600000),
      discountPercent: 25,
      productSlugs: ['gaeru-speaker-m3']
    });

    assert.ok(created.id);
    assert.equal(created.discount_percent, 25);
    assert.deepEqual(created.product_slugs, ['gaeru-speaker-m3']);

    // Kiểm tra liên kết khuyến mãi tự động
    const promo = await pool.query(`SELECT * FROM product_promotions WHERE type = 'flash'`);
    assert.equal(promo.rows.length, 1);
    assert.equal(Number(promo.rows[0].amount), 25);

    const promoVar = await pool.query(`SELECT * FROM product_promotion_variants WHERE promotion_id = $1`, [promo.rows[0].id]);
    assert.equal(promoVar.rows.length, 1);
    assert.equal(promoVar.rows[0].variant_id, m3VariantId);
  });

  await t.test('3. Real-time traffic measurement & Countdown Timer', async () => {
    // Thêm 5 lượt xem trong 15 phút
    for (let i = 1; i <= 5; i++) {
      await pool.query(`
        INSERT INTO site_traffic_realtime (visitor_hash, path, last_seen_at)
        VALUES ($1, '/san-pham/gaeru-speaker-m3', now() - interval '10 minutes')
      `, [`traffic_user_${i}`]);
    }
    // Thêm 2 lượt xem quá hạn (> 30 phút)
    for (let i = 6; i <= 7; i++) {
      await pool.query(`
        INSERT INTO site_traffic_realtime (visitor_hash, path, last_seen_at)
        VALUES ($1, '/san-pham/gaeru-speaker-m3', now() - interval '40 minutes')
      `, [`traffic_user_${i}`]);
    }

    const active = await getActiveFlashSale(pool);
    assert.equal(active.active, true);
    assert.equal(active.sale.discountPercent, 25);
    assert.equal(active.sale.viewingCount, 5); // Chính xác 5 người xem trong 30 phút
    assert.ok(active.sale.remainingSeconds > 3500 && active.sale.remainingSeconds <= 3600);
    assert.match(active.sale.bannerText, /Giảm đến 25%/);
  });

  await t.test('4. PricingEngine applies 25% discount to Flash Sale product only', async () => {
    const quote = await PricingEngine.quoteCartPrices(pool, [
      {
        id: m3VariantId,
        sku: 'M3-BLK',
        productSlug: 'gaeru-speaker-m3',
        priceVnd: 800000,
        quantity: 1
      },
      {
        id: caseVariantId,
        sku: 'CASE-BRN',
        productSlug: 'gaeru-case-pro',
        priceVnd: 200000,
        quantity: 1
      }
    ]);

    const m3 = quote.items.find(it => it.id === m3VariantId);
    const c = quote.items.find(it => it.id === caseVariantId);

    // M3: 800.000₫ giảm 25% còn 600.000₫
    assert.equal(m3.priceVnd, 600000);
    assert.equal(m3.promotion?.type, 'flash');

    // Case: 200.000₫ giữ nguyên
    assert.equal(c.priceVnd, 200000);
    assert.equal(c.promotion, null);

    // Tổng phụ: 600.000 + 200.000 = 800.000₫
    assert.equal(quote.subtotalVnd, 800000);
  });

  await t.test('5. Public & Admin Routers HTTP endpoints', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.admin = { id: 'admin_test', username: 'test_admin', permissions: ['marketing.read', 'marketing.write'] };
      next();
    });
    app.use('/api', createFlashSalePublicRouter(pool));
    app.use('/api/gaeru_ceo', createFlashSaleAdminRouter(pool));
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ error: err.message });
    });

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const pubRes = await fetch(`${baseUrl}/api/marketing/flash-sale`);
      assert.equal(pubRes.status, 200);
      const pubData = await pubRes.json();
      assert.equal(pubData.active, true);

      const listRes = await fetch(`${baseUrl}/api/gaeru_ceo/flash-sales`);
      assert.equal(listRes.status, 200);
      const listData = await listRes.json();
      assert.equal(listData.sales.length, 1);

      // Thất bại khi gửi mảng rỗng
      const failRes = await fetch(`${baseUrl}/api/gaeru_ceo/flash-sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Invalid Sale', productSlugs: [] })
      });
      assert.equal(failRes.status, 400);
    } finally {
      server.close();
    }
  });
});
