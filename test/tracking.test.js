'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const {
  createTrackingApi,
  getOrderTrackingDetails,
  verifyOrderChallenge,
  maskName,
  maskPhone,
  maskEmail,
  maskAddress,
  normalizePhone,
  getCarrierTrackingUrl,
  buildOrderTimeline
} = require('../src/tracking-api');

test('Public Order Tracking & Verification Suite', async (t) => {
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

  // Run full database migrations
  await migrateDatabase(pool);

  // 1. Seed Customer, Product, Variant, and Orders
  const cust = (await pool.query(
    "INSERT INTO customers(email, full_name, phone, active) VALUES('khach.hang@gaeru.com', 'Nguyễn Văn An', '0912345678', true) RETURNING id"
  )).rows[0];

  const prod = (await pool.query(
    "INSERT INTO products(name, slug, category, image_url, active) VALUES('Micro Thu Âm GAERU K9', 'micro-gaeru-k9', 'audio', '/assets/products/k9.webp', true) RETURNING id"
  )).rows[0];

  const variant = (await pool.query(
    "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, 'K9-LIGHTNING', 'Đầu thu Lightning', 450000, 100, true) RETURNING id",
    [prod.id]
  )).rows[0];

  // Seed Order 1: Active processing order
  const order1 = (await pool.query(
    `INSERT INTO orders (
      order_number, customer_id, customer_name, email, phone, address, city,
      payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd,
      discount_vnd, voucher_code, total_vnd
    ) VALUES (
      'GAE-261028-1111', $1, 'Nguyễn Văn An', 'khach.hang@gaeru.com', '0912345678', 'Số 123 Đường Lê Lợi, Phường Bến Nghé, Quận 1', 'TP. Hồ Chí Minh',
      'bank_transfer', 'paid', 'processing', 450000, 30000,
      50000, 'GIAM50K', 430000
    ) RETURNING id, order_number`,
    [cust.id]
  )).rows[0];

  await pool.query(
    `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES ($1, $2, 'Micro Thu Âm GAERU K9', 'Đầu thu Lightning', 'K9-LIGHTNING', 450000, 1, 450000)`,
    [order1.id, variant.id]
  );

  // Seed Shipment for Order 1
  await pool.query(
    `INSERT INTO carrier_shipments (
      order_id, carrier_id, tracking_number, status, carrier_status_desc,
      shipping_fee_vnd, cod_amount_vnd, tracking_history
    ) VALUES (
      $1, 'viettel', 'VT889922110', 'delivering', 'Đang vận chuyển qua bưu cục trung chuyển',
      30000, 0,
      '[{"time":"2026-10-28T09:00:00Z","description":"Bưu cục đã tiếp nhận kiện hàng","location":"Kho Rạng Đông"},{"time":"2026-10-28T14:30:00Z","description":"Đang xuất kho đi bưu cục phát","location":"Trung tâm khai thác Ninh Bình"}]'::jsonb
    )`,
    [order1.id]
  );

  // Seed Order 2: Cancelled order
  const order2 = (await pool.query(
    `INSERT INTO orders (
      order_number, customer_name, email, phone, address, city,
      payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd,
      discount_vnd, total_vnd, cancellation_reason
    ) VALUES (
      'GAE-261028-2222', 'Trần Thị Bích', 'bich.tran@gmail.com', '0988776655', 'Thôn 3, Xã Bình Minh', 'Hà Nội',
      'cod', 'pending', 'cancelled', 450000, 30000,
      0, 480000, 'Khách hàng thay đổi nhu cầu đặt mẫu khác'
    ) RETURNING id, order_number`
  )).rows[0];

  await pool.query(
    `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES ($1, $2, 'Micro Thu Âm GAERU K9', 'Đầu thu Lightning', 'K9-LIGHTNING', 450000, 1, 450000)`,
    [order2.id, variant.id]
  );

  await t.test('Unit: PII masking functions sanitize names, phones, emails and addresses', () => {
    // 1. Name
    const maskedName = maskName('Nguyễn Văn An');
    assert.ok(!maskedName.includes('Văn'), 'Middle name should be masked');
    assert.ok(maskedName.startsWith('N'), 'Initial letter should remain');
    assert.equal(maskName(''), '');
    assert.equal(maskName('A'), '*');
    assert.equal(maskName('An'), 'A*');

    // 2. Phone
    const maskedPhone = maskPhone('0912345678');
    assert.equal(maskedPhone, '091****678');
    assert.ok(!maskedPhone.includes('2345'), 'Middle digits must not be exposed');
    assert.equal(maskPhone(''), '');

    // 3. Email
    const maskedEmail = maskEmail('khach.hang@gaeru.com');
    assert.ok(maskedEmail.endsWith('@gaeru.com'), 'Domain must be preserved');
    assert.ok(!maskedEmail.includes('khach.hang'), 'Full local part must not be exposed');
    assert.equal(maskedEmail[0], 'k');
    assert.equal(maskEmail(''), '');
    assert.equal(maskEmail('ab@domain.com'), 'a*@domain.com');

    // 4. Address
    const maskedAddr = maskAddress('Số 123 Đường Lê Lợi, Phường Bến Nghé, Quận 1', 'TP. Hồ Chí Minh');
    assert.ok(!maskedAddr.includes('123'), 'House number must be masked');
    assert.ok(maskedAddr.includes('Phường Bến Nghé'), 'District/Ward context remains recognizable to owner');
    assert.equal(maskAddress('', 'Hà Nội'), 'Hà Nội');
  });

  await t.test('Unit: Phone normalization and challenge verification logic', () => {
    assert.equal(normalizePhone('+84912345678'), '0912345678');
    assert.equal(normalizePhone('84912345678'), '0912345678');
    assert.equal(normalizePhone('091 234 5678'), '0912345678');
    assert.equal(normalizePhone('091-234-5678'), '0912345678');

    const fakeOrder = {
      phone: '0912345678',
      email: 'buyer@gaeru.com'
    };

    // Correct phone matches
    assert.equal(verifyOrderChallenge(fakeOrder, '0912345678'), true);
    assert.equal(verifyOrderChallenge(fakeOrder, '+84 912 345 678'), true);
    assert.equal(verifyOrderChallenge(fakeOrder, '84912345678'), true);

    // Correct email matches
    assert.equal(verifyOrderChallenge(fakeOrder, 'buyer@gaeru.com'), true);
    assert.equal(verifyOrderChallenge(fakeOrder, ' BUYER@GAERU.COM '), true);

    // Incorrect challenge fails
    assert.equal(verifyOrderChallenge(fakeOrder, '0999999999'), false);
    assert.equal(verifyOrderChallenge(fakeOrder, 'other@gaeru.com'), false);
    assert.equal(verifyOrderChallenge(fakeOrder, ''), false);
    assert.equal(verifyOrderChallenge(null, '0912345678'), false);
  });

  await t.test('Unit: getCarrierTrackingUrl creates correct third-party URLs', () => {
    assert.equal(getCarrierTrackingUrl('viettel', 'VT123'), 'https://viettelpost.vn/tra-cuu-hanh-trinh-don/?orderNumber=VT123');
    assert.equal(getCarrierTrackingUrl('ghn', 'GHN456'), 'https://tracking.ghn.vn/?order_code=GHN456');
    assert.equal(getCarrierTrackingUrl('ghtk', 'GHTK789'), 'https://i.ghtk.vn/GHTK789');
    assert.equal(getCarrierTrackingUrl('jt', 'JT001'), 'https://jtexpress.vn/vi/tracking?type=track&billcode=JT001');
    assert.equal(getCarrierTrackingUrl('spx', 'SPX999'), 'https://spx.vn/track?SPX999');
    assert.equal(getCarrierTrackingUrl('unknown', '123'), null);
    assert.equal(getCarrierTrackingUrl('viettel', ''), null);
  });

  await t.test('Unit: buildOrderTimeline builds progress stages and handles cancellation', () => {
    const processingOrder = {
      order_number: 'GAE-1',
      status: 'processing',
      payment_status: 'paid',
      payment_method: 'bank_transfer',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const timeline = buildOrderTimeline(processingOrder, null);
    assert.equal(timeline.length, 5);
    assert.equal(timeline[0].status, 'completed'); // placed
    assert.equal(timeline[1].status, 'completed'); // confirmed
    assert.equal(timeline[2].status, 'completed'); // processing

    const cancelledOrder = {
      order_number: 'GAE-2',
      status: 'cancelled',
      cancellation_reason: 'Khách muốn đổi màu',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const cancelledTimeline = buildOrderTimeline(cancelledOrder, null);
    assert.equal(cancelledTimeline.length, 2);
    assert.equal(cancelledTimeline[1].status, 'cancelled');
    assert.ok(cancelledTimeline[1].description.includes('Khách muốn đổi màu'));
  });

  await t.test('Service: getOrderTrackingDetails succeeds with phone challenge and redacts PII', async () => {
    const res = await getOrderTrackingDetails(pool, {
      orderNumber: 'GAE-261028-1111',
      challenge: '0912345678'
    });

    assert.equal(res.found, true);
    assert.ok(res.order);
    assert.equal(res.order.orderNumber, 'GAE-261028-1111');
    assert.equal(res.order.status, 'processing');
    assert.equal(res.order.paymentStatus, 'paid');

    // Check PII redaction
    assert.ok(!res.order.customer.phone.includes('2345'), 'Raw phone number must not be exposed');
    assert.ok(!res.order.customer.email.includes('khach.hang'), 'Raw email must not be exposed');
    assert.ok(!res.order.customer.address.includes('123'), 'House number must not be exposed');
    assert.equal(res.order.customer.city, 'TP. Hồ Chí Minh');

    // Check items
    assert.equal(res.order.items.length, 1);
    assert.equal(res.order.items[0].sku, 'K9-LIGHTNING');
    assert.equal(res.order.items[0].quantity, 1);
    assert.equal(res.order.items[0].unitPriceVnd, 450000);

    // Check shipment
    assert.ok(res.order.shipment);
    assert.equal(res.order.shipment.carrierId, 'viettel');
    assert.equal(res.order.shipment.trackingNumber, 'VT889922110');
    assert.ok(res.order.shipment.trackingUrl.includes('viettelpost.vn'));
    assert.equal(res.order.shipment.history.length, 2);
  });

  await t.test('Service: getOrderTrackingDetails succeeds with email challenge', async () => {
    const res = await getOrderTrackingDetails(pool, {
      orderNumber: 'GAE-261028-1111',
      challenge: 'KHACH.HANG@GAERU.COM'
    });

    assert.equal(res.found, true);
    assert.ok(res.order);
    assert.equal(res.order.orderNumber, 'GAE-261028-1111');
  });

  await t.test('Service: getOrderTrackingDetails returns uniform security error for wrong challenge or missing order', async () => {
    // 1. Wrong challenge for existing order
    const resWrongChallenge = await getOrderTrackingDetails(pool, {
      orderNumber: 'GAE-261028-1111',
      challenge: '0999999999'
    });
    assert.equal(resWrongChallenge.found, false);
    assert.ok(resWrongChallenge.error.includes('Không tìm thấy đơn hàng hoặc thông tin xác thực'));

    // 2. Non-existent order
    const resNonExistent = await getOrderTrackingDetails(pool, {
      orderNumber: 'GAE-NOT-EXIST-999',
      challenge: '0912345678'
    });
    assert.equal(resNonExistent.found, false);
    assert.equal(resNonExistent.error, resWrongChallenge.error, 'Security errors must be identical to prevent enumeration');
  });

  await t.test('HTTP API: POST /tracking/lookup and GET /tracking/lookup integration tests', async () => {
    const app = express();
    app.use(express.json());
    app.use(createTrackingApi(pool));

    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. POST Happy Path with Phone
      const postRes = await fetch(`${baseUrl}/tracking/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber: 'GAE-261028-1111',
          challenge: '0912345678'
        })
      });
      assert.equal(postRes.status, 200);
      const postData = await postRes.json();
      assert.equal(postData.found, true);
      assert.equal(postData.order.orderNumber, 'GAE-261028-1111');

      // 2. GET Happy Path with Email
      const getRes = await fetch(`${baseUrl}/tracking/lookup?orderNumber=GAE-261028-1111&challenge=khach.hang@gaeru.com`);
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.equal(getData.found, true);

      // 3. POST Mismatched Challenge returns 404 with generic error
      const badChallengeRes = await fetch(`${baseUrl}/tracking/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber: 'GAE-261028-1111',
          challenge: '0977000111'
        })
      });
      assert.equal(badChallengeRes.status, 404);
      const badChallengeData = await badChallengeRes.json();
      assert.ok(badChallengeData.error.includes('Không tìm thấy đơn hàng hoặc thông tin xác thực'));

      // 4. Bad request (missing required fields)
      const invalidRes = await fetch(`${baseUrl}/tracking/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber: 'GA'
        })
      });
      assert.equal(invalidRes.status, 400);
      const invalidData = await invalidRes.json();
      assert.ok(invalidData.error);
    } finally {
      server.close();
    }
  });

  await t.test('Clean URLs & Static Files: tracking.html is registered in clean-urls and public-files', () => {
    const publicFiles = require('../src/public-files');
    assert.ok(publicFiles.has('tracking.html'), 'tracking.html must be in public-files');
    assert.ok(publicFiles.has('tracking.js'), 'tracking.js must be in public-files');
    assert.ok(publicFiles.has('tracking.css'), 'tracking.css must be in public-files');

    const cleanUrls = require('../clean-urls');
    assert.equal(cleanUrls.paths['tracking.html'], '/tra-cuu-don-hang');
    assert.equal(cleanUrls.clean('/tracking.html'), '/tra-cuu-don-hang');
  });
});
