'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { createStoreApi } = require('../src/store-api');

test('Phương Án 5B: Khách hàng tự bấm chọn đích danh hãng vận chuyển (GHN, GHTK, Viettel Post, SPX) tại Checkout', async (t) => {
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

  // Setup sample product and variant
  const product = (await pool.query("INSERT INTO products(slug,name,category,active) VALUES('gaeru-earbuds','Tai nghe GAERU','audio',true) RETURNING id")).rows[0];
  const variant = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'GAERU-EAR-01','Bản Đen Nhám',350000,50,true) RETURNING id", [product.id])).rows[0];
  await pool.query("UPDATE store_settings SET setting_value='{\"Hà Nội\":20000,\"Hồ Chí Minh\":25000,\"Đà Nẵng\":30000,\"Cần Thơ\":35000}' WHERE setting_key='shipping_rates'");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { csrfToken: 'test-csrf-token' };
    next();
  });
  app.use(createStoreApi(pool, { ordersEnabled: true, shippingChoices: true }));
  app.use((e, req, res, next) => res.status(e.status || 500).json({ error: e.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;

  const postOrder = (body) => fetch(base + '/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf-token' },
    body: JSON.stringify(body)
  });

  await t.test('1. GET /settings/public returns full list of available carriers for customer selection (Phương Án 5B)', async () => {
    const res = await fetch(base + '/settings/public');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.shippingCarriers));
    assert.ok(data.shippingCarriers.length >= 3);
    const ids = data.shippingCarriers.map(c => c.id);
    assert.ok(ids.includes('ghn'), 'Must include GHN');
    assert.ok(ids.includes('ghtk'), 'Must include GHTK');
    assert.ok(ids.includes('viettel'), 'Must include Viettel Post');
    assert.ok(ids.includes('spx'), 'Must include Shopee Express (SPX)');
  });

  await t.test('2. Khách hàng bấm chọn đích danh Giao Hàng Nhanh (GHN)', async () => {
    const res = await postOrder({
      customer: {
        name: 'Nguyễn Văn An',
        email: 'an.nguyen@example.test',
        phone: '0912345678',
        address: '123 Hoàn Kiếm',
        city: 'Hà Nội'
      },
      paymentMethod: 'cod',
      shippingCarrierId: 'ghn',
      expectedShippingFeeVnd: 20000,
      items: [{ variantId: variant.id, quantity: 1 }]
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.order.shippingCarrierName, 'Giao Hàng Nhanh (GHN)');

    const saved = (await pool.query('SELECT * FROM order_shipping_selection WHERE order_id = $1', [json.order.id])).rows[0];
    assert.equal(saved.carrier_id, 'ghn');
    assert.equal(saved.carrier_name, 'Giao Hàng Nhanh (GHN)');
    assert.equal(saved.fee_vnd, 20000);
  });

  await t.test('3. Khách hàng bấm chọn đích danh Giao Hàng Tiết Kiệm (GHTK)', async () => {
    const res = await postOrder({
      customer: {
        name: 'Lê Thị Mai',
        email: 'mai.le@example.test',
        phone: '0987654321',
        address: '456 Quận 1',
        city: 'Hồ Chí Minh'
      },
      paymentMethod: 'cod',
      shippingCarrierId: 'ghtk',
      expectedShippingFeeVnd: 25000,
      items: [{ variantId: variant.id, quantity: 2 }]
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.order.shippingCarrierName, 'Giao Hàng Tiết Kiệm (GHTK)');

    const saved = (await pool.query('SELECT * FROM order_shipping_selection WHERE order_id = $1', [json.order.id])).rows[0];
    assert.equal(saved.carrier_id, 'ghtk');
    assert.equal(saved.carrier_name, 'Giao Hàng Tiết Kiệm (GHTK)');
    assert.equal(saved.fee_vnd, 25000);
  });

  await t.test('4. Khách hàng bấm chọn đích danh Viettel Post', async () => {
    const res = await postOrder({
      customer: {
        name: 'Trần Văn Cường',
        email: 'cuong.tran@example.test',
        phone: '0977112233',
        address: '789 Hải Châu',
        city: 'Đà Nẵng'
      },
      paymentMethod: 'cod',
      shippingCarrierId: 'viettel',
      expectedShippingFeeVnd: 30000,
      items: [{ variantId: variant.id, quantity: 1 }]
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.order.shippingCarrierName, 'Viettel Post');

    const saved = (await pool.query('SELECT * FROM order_shipping_selection WHERE order_id = $1', [json.order.id])).rows[0];
    assert.equal(saved.carrier_id, 'viettel');
    assert.equal(saved.carrier_name, 'Viettel Post');
  });

  await t.test('5. Khách hàng bấm chọn đích danh Shopee Express (SPX)', async () => {
    const res = await postOrder({
      customer: {
        name: 'Hoàng Minh Quân',
        email: 'quan.hoang@example.test',
        phone: '0966445566',
        address: '101 Ninh Kiều',
        city: 'Cần Thơ'
      },
      paymentMethod: 'cod',
      shippingCarrierId: 'spx',
      expectedShippingFeeVnd: 35000,
      items: [{ variantId: variant.id, quantity: 1 }]
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.order.shippingCarrierName, 'Shopee Express (SPX)');

    const saved = (await pool.query('SELECT * FROM order_shipping_selection WHERE order_id = $1', [json.order.id])).rows[0];
    assert.equal(saved.carrier_id, 'spx');
    assert.equal(saved.carrier_name, 'Shopee Express (SPX)');
  });

  await t.test('6. Tự động dự phòng: Khi khách không chọn đích danh, hệ thống tự động phân bổ theo tỉnh thành (Phương Án 5A fallback)', async () => {
    // Với Hà Nội -> SPX / GHN
    const resHn = await postOrder({
      customer: {
        name: 'Khách Tự Động',
        email: 'auto.hn@example.test',
        phone: '0911223344',
        address: 'Cầu Giấy',
        city: 'Hà Nội'
      },
      paymentMethod: 'cod',
      expectedShippingFeeVnd: 20000,
      items: [{ variantId: variant.id, quantity: 1 }]
    });
    assert.equal(resHn.status, 201);
    const jsonHn = await resHn.json();
    assert.ok(jsonHn.order.shippingCarrierName.includes('SPX') || jsonHn.order.shippingCarrierName.includes('GHN'));

    // Với Cần Thơ -> Viettel Post / GHTK
    const resCt = await postOrder({
      customer: {
        name: 'Khách Tỉnh Xa',
        email: 'auto.province@example.test',
        phone: '0922334455',
        address: 'Phong Điền',
        city: 'Cần Thơ'
      },
      paymentMethod: 'cod',
      expectedShippingFeeVnd: 35000,
      items: [{ variantId: variant.id, quantity: 1 }]
    });
    assert.equal(resCt.status, 201);
    const jsonCt = await resCt.json();
    assert.ok(jsonCt.order.shippingCarrierName.includes('Viettel') || jsonCt.order.shippingCarrierName.includes('GHTK'));
  });

  await t.test('7. Giao diện Checkout: CSS và commerce.js hiển thị thẻ chọn hãng sinh động và radio button', () => {
    const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
    assert.match(styles, /\.checkout-carrier-grid/, 'styles.css must style checkout-carrier-grid');
    assert.match(styles, /\.checkout-carrier-card/, 'styles.css must style checkout-carrier-card');
    assert.match(styles, /\.carrier-radio-check/, 'styles.css must style carrier-radio-check');

    const commerce = fs.readFileSync(path.join(__dirname, '..', 'commerce.js'), 'utf8');
    assert.match(commerce, /name="shippingCarrierId"/, 'commerce.js must render radio input for shippingCarrierId');
    assert.match(commerce, /checkout-carrier-card/, 'commerce.js must render carrier cards');
    assert.match(commerce, /Khách tự chọn hãng/, 'commerce.js must show carrier choice badge');
  });
});
