'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { performance } = require('node:perf_hooks');
const { createTestDb } = require('../test/helpers/pglite-db');
const {
  getActiveFlashSale,
  createFlashSale,
  createFlashSalePublicRouter,
  createFlashSaleAdminRouter
} = require('../src/flash-sale');
const { PricingEngine } = require('../src/domain/pricing/pricing-engine');

async function runLiveVerification() {
  console.log('='.repeat(80));
  console.log('KIỂM TRA CHẠY THẬT & ĐO LƯỜNG SỐ LIỆU THỰC TẾ: src/flash-sale.js');
  console.log('Môi trường: Node.js 24 LTS · PostgreSQL Engine (PGlite) · PricingEngine Dynamic');
  console.log('='.repeat(80));

  const { db, pool } = await createTestDb({ migrate: false });

  try {
    // --------------------------------------------------------------------------
    // 0. Khởi tạo CSDL chuẩn: Products, Variants, Promotions, Flash Sales, Realtime Traffic
    // --------------------------------------------------------------------------
    console.log('\n--- 0. KHỞI TẠO CẤU TRÚC BẢNG CSDL THỰC TẾ ---');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id serial PRIMARY KEY,
        slug text NOT NULL UNIQUE,
        name text NOT NULL,
        price numeric(12, 2) NOT NULL DEFAULT 0,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS product_variants (
        id serial PRIMARY KEY,
        product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        sku text NOT NULL UNIQUE,
        title text NOT NULL,
        price numeric(12, 2) NOT NULL,
        inventory_quantity integer NOT NULL DEFAULT 100,
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
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
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

    // Chèn sản phẩm và biến thể mẫu
    const prodRes = await pool.query(`
      INSERT INTO products (slug, name, price, active) VALUES
      ('k9-pro-wireless', 'Micro Thu Âm Không Dây K9 Pro GAERU', 500000, true),
      ('c01-typec-cable', 'Cáp Sạc Siêu Nhanh 65W GAERU C01', 150000, true)
      RETURNING id, slug;
    `);

    const pK9Id = prodRes.rows.find(r => r.slug === 'k9-pro-wireless').id;
    const pC01Id = prodRes.rows.find(r => r.slug === 'c01-typec-cable').id;

    const varRes = await pool.query(`
      INSERT INTO product_variants (product_id, sku, title, price, inventory_quantity, active) VALUES
      ($1, 'K9-BLK', 'Bản Đen Tiêu Chuẩn', 500000, 50, true),
      ($1, 'K9-SLV', 'Bản Bạc Cao Cấp', 550000, 30, true),
      ($2, 'C01-1M', 'Dài 1.0 Mét', 150000, 100, true)
      RETURNING id, sku, price;
    `, [pK9Id, pC01Id]);

    console.log(`✔ Đã tạo bảng CSDL và chèn 2 sản phẩm, 3 biến thể giá từ 150.000₫ đến 550.000₫`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 1: Kiểm Tra Trạng Thái Khi Chưa Có Chiến Dịch Flash Sale
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 1: Kiểm Tra Trạng Thái Mặc Định (Chưa Có Flash Sale) ---');
    const initialSale = await getActiveFlashSale(pool);
    assert.equal(initialSale.active, false);
    assert.equal(initialSale.sale, null);
    console.log('✔ getActiveFlashSale: Trả về { active: false, sale: null } chính xác.');

    // --------------------------------------------------------------------------
    // KỊCH BẢN 2: Tạo Chiến Dịch Flash Sale Giờ Vàng (createFlashSale Transactional)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 2: Tạo Chiến Dịch Flash Sale Giờ Vàng (Giao Dịch Gắn Kết) ---');
    const t0 = performance.now();
    const created = await createFlashSale(pool, {
      title: '⚡ SIÊU SALE GIỜ VÀNG GAERU 2026',
      startsAt: new Date(Date.now() - 3600000), // Bắt đầu 1 giờ trước
      endsAt: new Date(Date.now() + 7200000),   // Kết thúc sau 2 giờ nữa
      discountPercent: 20,                     // Giảm 20%
      productSlugs: ['k9-pro-wireless']
    });
    const t1 = performance.now();
    const createDurationMs = t1 - t0;

    assert.ok(created.id);
    assert.equal(created.discount_percent, 20);
    assert.deepEqual(created.product_slugs, ['k9-pro-wireless']);

    // Kiểm tra liên kết bảng product_promotions & product_promotion_variants
    const promoRows = (await pool.query(`SELECT * FROM product_promotions WHERE type = 'flash'`)).rows;
    assert.equal(promoRows.length, 1);
    assert.equal(Number(promoRows[0].amount), 20);

    const promoVarRows = (await pool.query(`SELECT * FROM product_promotion_variants WHERE promotion_id = $1`, [promoRows[0].id])).rows;
    assert.equal(promoVarRows.length, 2); // Cả 2 biến thể của K9 (K9-BLK và K9-SLV) được tự động gán khuyến mãi!

    console.log(`- Thời gian tạo chiến dịch         : ${createDurationMs.toFixed(3)} ms`);
    console.log(`- Mã chiến dịch Flash Sale (UUID) : ${created.id}`);
    console.log(`- Tỷ lệ giảm giá                  : ${created.discount_percent}%`);
    console.log(`- Tự động liên kết Promotion ID   : ${promoRows[0].id}`);
    console.log(`- Số biến thể được gắn ưu đãi     : ${promoVarRows.length} biến thể`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 3: Đo Lường Người Xem Thời Gian Thực & Countdown Timer
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 3: Đo Lường Người Xem Thật (site_traffic_realtime) & Đếm Ngược ---');
    // Chèn 12 khách đang xem trong vòng 10 phút qua
    for (let i = 1; i <= 12; i++) {
      await pool.query(`
        INSERT INTO site_traffic_realtime (visitor_hash, path, last_seen_at)
        VALUES ($1, '/san-pham/k9-pro-wireless', now() - ($2 || ' minutes')::interval)
      `, [`visitor_${i}`, i]);
    }
    // Chèn 3 khách cũ từ 45 phút trước (ngoài cửa sổ 30 phút)
    for (let i = 13; i <= 15; i++) {
      await pool.query(`
        INSERT INTO site_traffic_realtime (visitor_hash, path, last_seen_at)
        VALUES ($1, '/san-pham/k9-pro-wireless', now() - '45 minutes'::interval)
      `, [`visitor_${i}`]);
    }

    const activeSale = await getActiveFlashSale(pool);
    assert.equal(activeSale.active, true);
    assert.ok(activeSale.sale.remainingSeconds > 7100 && activeSale.sale.remainingSeconds <= 7200);
    assert.equal(activeSale.sale.viewingCount, 12); // Đúng 12 người xem trong 30 phút, lọc bỏ 3 người cũ
    assert.equal(activeSale.sale.discountPercent, 20);
    assert.match(activeSale.sale.bannerText, /Giảm đến 20%/);

    console.log(`- Trạng thái chiến dịch           : ĐANG HOẠT ĐỘNG (active = true)`);
    console.log(`- Thời gian đếm ngược còn lại     : ${activeSale.sale.remainingSeconds} giây (~ ${(activeSale.sale.remainingSeconds / 3600).toFixed(2)} giờ)`);
    console.log(`- Số khách hàng đang xem thực tế  : ${activeSale.sale.viewingCount} người (lọc chính xác trong 30 phút, không số ảo)`);
    console.log(`- Nội dung Banner FOMO            : "${activeSale.sale.bannerText}"`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 4: Tích Hợp PricingEngine — Giá Giảm Tự Động Khi Khách Mua Hàng
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 4: Tích Hợp PricingEngine Tính Giá Thực Tế Khi Mua Hàng ---');
    const k9VariantId = varRes.rows.find(r => r.sku === 'K9-BLK').id;
    const c01VariantId = varRes.rows.find(r => r.sku === 'C01-1M').id;

    // Tính giá cho giỏ hàng gồm: 1 K9 (nằm trong Flash Sale 20%) và 1 C01 (không nằm trong Flash Sale)
    const testCart = [
      {
        id: k9VariantId,
        sku: 'K9-BLK',
        productSlug: 'k9-pro-wireless',
        priceVnd: 500000,
        quantity: 1
      },
      {
        id: c01VariantId,
        sku: 'C01-1M',
        productSlug: 'c01-typec-cable',
        priceVnd: 150000,
        quantity: 1
      }
    ];

    const quote = await PricingEngine.quoteCartPrices(pool, testCart);
    const k9Item = quote.items.find(it => it.id === k9VariantId);
    const c01Item = quote.items.find(it => it.id === c01VariantId);

    // Giá gốc K9: 500.000₫ -> Giảm 20% còn: 400.000₫
    assert.equal(k9Item.priceVnd, 400000);
    assert.equal(k9Item.promotion?.type, 'flash');
    assert.equal(k9Item.promotion?.discountPercent, 20);

    // C01 không giảm: 150.000₫
    assert.equal(c01Item.priceVnd, 150000);
    assert.equal(c01Item.promotion, null);

    // Tổng tiền đơn hàng: 400.000 + 150.000 = 550.000₫
    assert.equal(quote.subtotalVnd, 550000);

    console.log(`- Sản phẩm trong Flash Sale (K9)  : 500.000₫ -> ${k9Item.priceVnd.toLocaleString('vi-VN')}₫ (Giảm 20% - Loại: ${k9Item.promotion.type})`);
    console.log(`- Sản phẩm ngoài Flash Sale (C01) : 150.000₫ -> ${c01Item.priceVnd.toLocaleString('vi-VN')}₫ (Không giảm)`);
    console.log(`- Tổng tiền sau giảm giá tự động  : ${quote.subtotalVnd.toLocaleString('vi-VN')}₫`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 5: Chuyển Trạng Thái Khi Hết Giờ Flash Sale (Tự Động Hết Hiệu Lực)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 5: Chuyển Trạng Thái Tự Động Khi Hết Giờ Vàng ---');
    await pool.query(`UPDATE flash_sales SET ends_at = now() - INTERVAL '1 second' WHERE id = $1`, [created.id]);
    await pool.query(`UPDATE product_promotions SET ends_at = now() - INTERVAL '1 second' WHERE id = $1`, [promoRows[0].id]);

    const expiredSale = await getActiveFlashSale(pool);
    assert.equal(expiredSale.active, false);
    assert.equal(expiredSale.sale, null);

    const quoteAfterExpiry = await PricingEngine.quoteCartPrices(pool, [
      {
        id: k9VariantId,
        sku: 'K9-BLK',
        productSlug: 'k9-pro-wireless',
        priceVnd: 500000,
        quantity: 1
      }
    ]);
    // Hết giờ, giá K9 quay về 500.000₫ ban đầu
    assert.equal(quoteAfterExpiry.items[0].priceVnd, 500000);
    assert.equal(quoteAfterExpiry.items[0].promotion, null);

    console.log(`✔ Ngay khi hết giờ: getActiveFlashSale trả về active = false.`);
    console.log(`✔ Giá sản phẩm K9 trên PricingEngine tự động trở về giá gốc: ${quoteAfterExpiry.items[0].priceVnd.toLocaleString('vi-VN')}₫.`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 6: Kiểm Thử Router HTTP (Public & Admin Endpoints)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 6: Kiểm Thử Router HTTP Public & Quản Trị Admin ---');
    const app = express();
    app.use(express.json());
    // Giả lập admin middleware
    app.use((req, res, next) => {
      req.admin = { id: 'admin_1', username: 'ceo_gaeru', permissions: ['marketing.read', 'marketing.write'] };
      next();
    });
    app.use('/api', createFlashSalePublicRouter(pool));
    app.use('/api/gaeru_ceo', createFlashSaleAdminRouter(pool));
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ error: err.message });
    });

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. GET /api/marketing/flash-sale
      const pubRes = await fetch(`${baseUrl}/api/marketing/flash-sale`);
      assert.equal(pubRes.status, 200);
      const pubData = await pubRes.json();
      assert.equal(typeof pubData.active, 'boolean');
      console.log(`✔ GET /api/marketing/flash-sale -> HTTP 200 OK (active: ${pubData.active})`);

      // 2. GET /api/gaeru_ceo/flash-sales
      const adminListRes = await fetch(`${baseUrl}/api/gaeru_ceo/flash-sales`);
      assert.equal(adminListRes.status, 200);
      const adminListData = await adminListRes.json();
      assert.ok(Array.isArray(adminListData.sales));
      assert.equal(adminListData.sales.length, 1);
      console.log(`✔ GET /api/gaeru_ceo/flash-sales -> HTTP 200 OK (Tìm thấy ${adminListData.sales.length} chiến dịch)`);

      // 3. POST /api/gaeru_ceo/flash-sales (Tạo thành công)
      const adminPostRes = await fetch(`${baseUrl}/api/gaeru_ceo/flash-sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Flash Sale Test Admin Router',
          discountPercent: 25,
          productSlugs: ['c01-typec-cable']
        })
      });
      assert.equal(adminPostRes.status, 201);
      const adminPostData = await adminPostRes.json();
      assert.equal(adminPostData.ok, true);
      assert.equal(adminPostData.sale.discount_percent, 25);
      console.log(`✔ POST /api/gaeru_ceo/flash-sales -> HTTP 201 Created (Tạo mới thành công chiến dịch 25%)`);

      // 4. POST /api/gaeru_ceo/flash-sales (Kiểm tra validate: thiếu sản phẩm -> 400)
      const adminFailRes = await fetch(`${baseUrl}/api/gaeru_ceo/flash-sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Flash Sale Lỗi Thiếu Sản Phẩm',
          discountPercent: 15,
          productSlugs: []
        })
      });
      assert.equal(adminFailRes.status, 400);
      console.log(`✔ POST /api/gaeru_ceo/flash-sales với mảng rỗng -> Chặn đứng HTTP 400 Bad Request`);
    } finally {
      server.close();
    }

    console.log('\n' + '='.repeat(80));
    console.log('BẢNG TỔNG HỢP SỐ LIỆU ĐO ĐẠC THỰC TẾ: FLASH SALE');
    console.log('='.repeat(80));
    console.log(`- Độ trễ tạo chiến dịch (Transactional) : ${createDurationMs.toFixed(3)} ms`);
    console.log(`- Liên kết khuyến mãi đa bảng           : flash_sales + product_promotions + product_promotion_variants`);
    console.log(`- Cơ chế đếm người xem (Social Proof)   : Đo lường từ site_traffic_realtime (Không số ảo)`);
    console.log(`- Tích hợp Định giá (PricingEngine)     : Tự động trừ tiền sản phẩm khi checkout`);
    console.log(`- Quản lý hết hạn (Expiry Transition)   : Tức thì (Real-time expiry, hoàn trả giá gốc)`);
    console.log(`- Điểm cuối API Công khai & Admin       : GET /api/marketing/flash-sale | POST /api/gaeru_ceo/flash-sales`);
    console.log('='.repeat(80));

  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  runLiveVerification()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Verification Failed]', err);
      process.exit(1);
    });
}

module.exports = { runLiveVerification };
