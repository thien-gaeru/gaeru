'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDb } = require('./helpers/pglite-db');
const {
  searchAutocomplete,
  createSearchRouter
} = require('../src/instant-search');

test('Instant Search: Multi-field matching (name, slug, descriptor, variant), prefix prioritization, dynamic minPriceVnd, and public HTTP router', async (t) => {
  const { pool } = await createTestDb({ migrate: false });

  // 0. Tạo bảng
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text UNIQUE NOT NULL,
      name text NOT NULL,
      category text,
      descriptor text,
      image_url text,
      sort_order integer NOT NULL DEFAULT 100,
      active boolean NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS product_variants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      sku text NOT NULL UNIQUE,
      name text NOT NULL,
      price_vnd integer NOT NULL CHECK (price_vnd >= 0),
      stock_quantity integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true
    );
  `);

  const p1 = (await pool.query(`
    INSERT INTO products (slug, name, category, descriptor, image_url, sort_order, active)
    VALUES ('k9-mic', 'Micro Không Dây K9', 'audio', 'Khử nhiễu lọc âm thông minh', '/img/k9.png', 1, true)
    RETURNING id;
  `)).rows[0];

  const p2 = (await pool.query(`
    INSERT INTO products (slug, name, category, descriptor, image_url, sort_order, active)
    VALUES ('m3-speaker', 'Loa GAERU M3 Âm Trầm', 'audio', 'Tích hợp micro đàm thoại', '/img/m3.png', 2, true)
    RETURNING id;
  `)).rows[0];

  const pInactive = (await pool.query(`
    INSERT INTO products (slug, name, category, descriptor, sort_order, active)
    VALUES ('k7-old', 'Micro K7 Đã Ẩn', 'audio', 'Không hiển thị', 3, false)
    RETURNING id;
  `)).rows[0];

  await pool.query(`
    INSERT INTO product_variants (product_id, sku, name, price_vnd, active) VALUES
    ($1, 'K9-V1', 'Bản Type-C', 350000, true),
    ($1, 'K9-V2', 'Bản Lightning', 390000, true),
    ($2, 'M3-V1', 'Bản Tiêu Chuẩn', 750000, true),
    ($3, 'K7-V1', 'Bản Cũ', 100000, false);
  `, [p1.id, p2.id, pInactive.id]);

  t.after(async () => {
    await pool.end().catch(() => {});
  });

  await t.test('1. Empty or whitespace query returns empty array immediately', async () => {
    assert.deepEqual(await searchAutocomplete(pool, ''), []);
    assert.deepEqual(await searchAutocomplete(pool, '   '), []);
    assert.deepEqual(await searchAutocomplete(pool, null), []);
  });

  await t.test('2. Prioritizes exact prefix match in product name over descriptor match', async () => {
    const results = await searchAutocomplete(pool, 'micro', 5);
    assert.ok(results.length >= 2);
    // K9 ("Micro Không Dây K9") bắt đầu bằng chữ Micro -> phải đứng trước M3 (chỉ có chữ micro trong mô tả)
    assert.equal(results[0].slug, 'k9-mic');
    assert.equal(results[0].minPriceVnd, 350000);
    assert.equal(results[1].slug, 'm3-speaker');
  });

  await t.test('3. Matches products by slug and variant name', async () => {
    const bySlug = await searchAutocomplete(pool, 'm3-speaker');
    assert.equal(bySlug.length, 1);
    assert.equal(bySlug[0].slug, 'm3-speaker');

    const byVariant = await searchAutocomplete(pool, 'lightning');
    assert.equal(byVariant.length, 1);
    assert.equal(byVariant[0].slug, 'k9-mic');
  });

  await t.test('4. Excludes inactive products from search results', async () => {
    const results = await searchAutocomplete(pool, 'k7');
    assert.equal(results.length, 0);
  });

  await t.test('5. Limits result count accurately', async () => {
    const results = await searchAutocomplete(pool, 'a', 1);
    assert.equal(results.length, 1);
  });

  await t.test('6. Public Router GET /products/search/autocomplete responds with results array', async () => {
    const app = express();
    app.use('/api', createSearchRouter(pool));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      const res = await fetch(`${base}/api/products/search/autocomplete?q=k9`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.results));
      assert.equal(data.results.length, 1);
      assert.equal(data.results[0].slug, 'k9-mic');
      assert.equal(data.results[0].minPriceVnd, 350000);
    } finally {
      server.close();
    }
  });
});
