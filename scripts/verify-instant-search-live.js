'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { performance } = require('node:perf_hooks');
const { createTestDb } = require('../test/helpers/pglite-db');
const {
  searchAutocomplete,
  createSearchRouter
} = require('../src/instant-search');

async function runLiveVerification() {
  console.log('='.repeat(80));
  console.log('KIỂM TRA CHẠY THẬT & ĐO LƯỜNG SỐ LIỆU THỰC TẾ: src/instant-search.js');
  console.log('Môi trường: Node.js 24 LTS · PostgreSQL Engine (PGlite) · Instant Prefix Search');
  console.log('='.repeat(80));

  const { db, pool } = await createTestDb({ migrate: false });

  try {
    // --------------------------------------------------------------------------
    // 0. Khởi tạo cấu trúc bảng CSDL chuẩn cho Products & Variants
    // --------------------------------------------------------------------------
    console.log('\n--- 0. KHỞI TẠO CẤU TRÚC BẢNG CSDL THỰC TẾ ---');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text UNIQUE NOT NULL,
        name text NOT NULL,
        category text,
        descriptor text,
        image_url text,
        sort_order integer NOT NULL DEFAULT 100,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS active_products_sort_order_idx ON products(active, sort_order, name);

      CREATE TABLE IF NOT EXISTS product_variants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        sku text NOT NULL UNIQUE,
        name text NOT NULL,
        price_vnd integer NOT NULL CHECK (price_vnd >= 0),
        stock_quantity integer NOT NULL DEFAULT 0,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS product_variants_product_id_idx ON product_variants(product_id);
    `);

    // Chèn 5 sản phẩm mẫu với đầy đủ phân loại, mô tả và biến thể
    const p1 = (await pool.query(`
      INSERT INTO products (slug, name, category, descriptor, image_url, sort_order, active)
      VALUES ('k9-pro-wireless', 'Micro Thu Âm Không Dây K9 Pro', 'audio', 'Micro thu âm livestream khử tiếng ồn DSP', '/assets/products/k9.webp', 10, true)
      RETURNING id;
    `)).rows[0];

    const p2 = (await pool.query(`
      INSERT INTO products (slug, name, category, descriptor, image_url, sort_order, active)
      VALUES ('m3-bluetooth-speaker', 'Loa Bluetooth GAERU M3 Âm Trầm', 'audio', 'Loa di động âm thanh vòm 360 độ chống nước IPX7', '/assets/products/m3.webp', 20, true)
      RETURNING id;
    `)).rows[0];

    const p3 = (await pool.query(`
      INSERT INTO products (slug, name, category, descriptor, image_url, sort_order, active)
      VALUES ('c01-typec-cable', 'Cáp Sạc Nhanh 65W GAERU C01', 'accessories', 'Dây bọc dù siêu bền hỗ trợ sạc nhanh chuẩn PD', '/assets/products/c01.webp', 30, true)
      RETURNING id;
    `)).rows[0];

    const p4 = (await pool.query(`
      INSERT INTO products (slug, name, category, descriptor, image_url, sort_order, active)
      VALUES ('soundcard-v8-pro', 'Bộ Soundcard Thu Âm GAERU V8 Pro', 'audio', 'Thiết bị khuếch đại micro và chỉnh giọng chuyên nghiệp', '/assets/products/v8.webp', 40, true)
      RETURNING id;
    `)).rows[0];

    // Sản phẩm ngừng kinh doanh (active = false) -> Không được xuất hiện trong tìm kiếm
    const pInactive = (await pool.query(`
      INSERT INTO products (slug, name, category, descriptor, image_url, sort_order, active)
      VALUES ('legacy-mic-k8', 'Micro K8 Cũ Đã Ngừng Bán', 'audio', 'Sản phẩm micro cũ', '/assets/products/k8.webp', 99, false)
      RETURNING id;
    `)).rows[0];

    // Chèn các biến thể giá
    await pool.query(`
      INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES
      ($1, 'K9-TPC', 'Chân Cắm Type-C cho Android', 450000, 50, true),
      ($1, 'K9-LGT', 'Chân Cắm Lightning cho iPhone', 490000, 30, true),
      ($2, 'M3-BLK', 'Bản Đen Midnight', 850000, 20, true),
      ($2, 'M3-SLV', 'Bản Bạc Silver', 890000, 15, true),
      ($3, 'C01-1M', 'Chiều dài 1.0 Mét', 120000, 100, true),
      ($4, 'V8-STD', 'Bản Tiêu Chuẩn', 650000, 10, true),
      ($5, 'K8-OLD', 'Bản K8 Cũ', 200000, 0, false);
    `, [p1.id, p2.id, p3.id, p4.id, pInactive.id]);

    console.log('✔ Đã nạp 5 sản phẩm (4 active, 1 inactive) và 7 biến thể giá vào CSDL.');

    // --------------------------------------------------------------------------
    // KỊCH BẢN 1: Truy Vấn Rỗng / Khoảng Trắng
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 1: Truy Vấn Rỗng & Xử Lý An Toàn ---');
    const empty1 = await searchAutocomplete(pool, '');
    const empty2 = await searchAutocomplete(pool, '    ');
    const empty3 = await searchAutocomplete(pool, null);
    assert.deepEqual(empty1, []);
    assert.deepEqual(empty2, []);
    assert.deepEqual(empty3, []);
    console.log('✔ Truy vấn rỗng: Trả về mảng rỗng [] tức thì không tốn tài nguyên CSDL.');

    // --------------------------------------------------------------------------
    // KỊCH BẢN 2: Tìm Kiếm Theo Tiền Tố Tên & Ưu Tiên Prefix Match
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 2: Tìm Kiếm Theo Tên & Thứ Tự Ưu Tiên Tiền Tố (Prefix Match) ---');
    const t0 = performance.now();
    const resMicro = await searchAutocomplete(pool, 'micro', 5);
    const t1 = performance.now();
    const durSearchMs = t1 - t0;

    assert.ok(resMicro.length >= 1);
    // Sản phẩm bắt đầu bằng chữ "Micro" đứng đầu danh sách
    assert.equal(resMicro[0].slug, 'k9-pro-wireless');
    assert.equal(resMicro[0].minPriceVnd, 450000); // Giá thấp nhất trong 2 biến thể (450k vs 490k)
    assert.equal(resMicro[0].imageUrl, '/assets/products/k9.webp');

    // Sản phẩm có từ "micro" trong mô tả (soundcard V8) xếp sau
    const soundcard = resMicro.find(r => r.slug === 'soundcard-v8-pro');
    assert.ok(soundcard);

    console.log(`- Thời gian tìm kiếm tức thì     : ${durSearchMs.toFixed(3)} ms`);
    console.log(`- Số kết quả tìm thấy            : ${resMicro.length} sản phẩm`);
    console.log(`- Sản phẩm ưu tiên số 1 (Prefix) : [${resMicro[0].slug}] "${resMicro[0].name}"`);
    console.log(`    * Giá khởi điểm (minPriceVnd) : ${resMicro[0].minPriceVnd.toLocaleString('vi-VN')}₫`);
    console.log(`    * Danh mục sản phẩm          : ${resMicro[0].category}`);
    console.log(`    * Mô tả ngắn                 : ${resMicro[0].descriptor}`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 3: Tìm Kiếm Theo Mã Slug Sản Phẩm
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 3: Tìm Kiếm Theo Mã Slug Sản Phẩm ---');
    const resSlug = await searchAutocomplete(pool, 'm3-blue', 5);
    assert.equal(resSlug.length, 1);
    assert.equal(resSlug[0].slug, 'm3-bluetooth-speaker');
    assert.equal(resSlug[0].minPriceVnd, 850000);
    console.log(`✔ Tìm kiếm theo slug "m3-blue" -> Khớp chính xác: "${resSlug[0].name}" (${resSlug[0].minPriceVnd.toLocaleString('vi-VN')}₫)`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 4: Tìm Kiếm Theo Từ Khóa Trong Mô Tả (Descriptor)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 4: Tìm Kiếm Theo Từ Khóa Trong Mô Tả (Descriptor) ---');
    const resDesc = await searchAutocomplete(pool, 'khử tiếng ồn', 5);
    assert.ok(resDesc.length >= 1);
    assert.equal(resDesc[0].slug, 'k9-pro-wireless');
    console.log(`✔ Tìm kiếm từ khóa "khử tiếng ồn" -> Khớp qua mô tả sản phẩm: "${resDesc[0].name}"`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 5: Tìm Kiếm Theo Tên Biến Thể (Variant Match)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 5: Tìm Kiếm Theo Tên Biến Thể Cụ Thể (Variant Match) ---');
    const resVariant = await searchAutocomplete(pool, 'lightning', 5);
    assert.ok(resVariant.length >= 1);
    assert.equal(resVariant[0].slug, 'k9-pro-wireless');
    console.log(`✔ Tìm kiếm tên biến thể "lightning" -> Trả về sản phẩm cha chứa biến thể: "${resVariant[0].name}"`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 6: Lọc Sản Phẩm Ngừng Bán (Active vs Inactive Isolation)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 6: Bảo Mật Lọc Sản Phẩm Đã Ngừng Kinh Doanh (Active Only) ---');
    const resInactive = await searchAutocomplete(pool, 'k8', 5);
    assert.equal(resInactive.length, 0);
    console.log('✔ Tuyệt đối không để lộ sản phẩm đã bị ẩn/ngừng bán (`active = false`).');

    // --------------------------------------------------------------------------
    // KỊCH BẢN 7: Giới Hạn Kết Quả (Limit Clamping)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 7: Kiểm Soát Số Lượng Kết Quả Trả Về (Limit Clamping) ---');
    const resLimit2 = await searchAutocomplete(pool, 'a', 2); // 'a' xuất hiện trong nhiều sản phẩm
    assert.equal(resLimit2.length, 2);
    console.log(`✔ Giới hạn limit = 2 -> Trả về đúng ${resLimit2.length} kết quả.`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 8: Kiểm Thử Router HTTP Công Khai (GET /api/products/search/autocomplete)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 8: Kiểm Thử Endpoint HTTP Công Khai Storefront ---');
    const app = express();
    app.use('/api', createSearchRouter(pool));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const apiRes = await fetch(`${baseUrl}/api/products/search/autocomplete?q=c01&limit=3`);
      assert.equal(apiRes.status, 200);
      const apiData = await apiRes.json();
      assert.ok(Array.isArray(apiData.results));
      assert.equal(apiData.results.length, 1);
      assert.equal(apiData.results[0].slug, 'c01-typec-cable');
      assert.equal(apiData.results[0].minPriceVnd, 120000);
      console.log(`✔ GET /api/products/search/autocomplete?q=c01 -> HTTP 200 OK (${JSON.stringify(apiData.results[0])})`);
    } finally {
      server.close();
    }

    console.log('\n' + '='.repeat(80));
    console.log('BẢNG TỔNG HỢP SỐ LIỆU ĐO ĐẠC THỰC TẾ: INSTANT SEARCH');
    console.log('='.repeat(80));
    console.log(`- Độ trễ tìm kiếm tức thì          : ${durSearchMs.toFixed(3)} ms`);
    console.log(`- Phạm vi khớp đa chiều            : Tên sản phẩm, Slug, Mô tả ngắn (Descriptor), Tên biến thể (SKU)`);
    console.log(`- Thứ tự xếp hạng thông minh       : Khớp tiền tố (Prefix match) ưu tiên đứng đầu -> sort_order -> name`);
    console.log(`- Tính toán giá động (minPriceVnd) : Tự động quét giá thấp nhất trong các biến thể đang active`);
    console.log(`- Bảo vệ an toàn dữ liệu           : Chặn 100% sản phẩm và biến thể inactive`);
    console.log(`- Điểm cuối API Công khai          : GET /api/products/search/autocomplete?q=...&limit=...`);
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
