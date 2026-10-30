'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDb } = require('./helpers/pglite-db');
const { InventoryService } = require('../src/domain/inventory/inventory-service');
const { processOmnichannelEvent } = require('../src/omnichannel-sync');
const { deleteOrderPermanently } = require('../src/order-deletion');
const { PricingEngine } = require('../src/domain/pricing/pricing-engine');
const inventory = require('../src/inventory');
const { withTransaction } = require('../src/db');

test('Phase A - 1.1: P0 Fix - Không cộng trùng tồn kho khi kho phụ (AUX) có tồn nhưng kho MAIN chưa có dòng', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  // Tạo sản phẩm và biến thể với tổng tồn = 5
  const prod = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('p0-test-prod', 'GAERU P0 Mic', 'audio', true) RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-P0-AUX', 'Bản Tiêu Chuẩn', 500000, 5, true) RETURNING id`,
    [prod.id]
  )).rows[0];

  // Tạo kho phụ AUX và gán toàn bộ 5 sản phẩm vào kho AUX (kho MAIN hoàn toàn chưa có dòng cho biến thể này)
  const auxWh = (await pool.query(
    `INSERT INTO warehouses (code, name, active) VALUES ('AUX', 'Kho Phụ Hà Nội', true) RETURNING id`
  )).rows[0];
  const mainWh = (await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN'`)).rows[0];

  await pool.query(`DELETE FROM warehouse_stock WHERE variant_id = $1`, [variant.id]);
  await pool.query(
    `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 5)`,
    [auxWh.id, variant.id]
  );

  // Kiểm tra điều kiện ban đầu: AUX = 5, MAIN chưa có dòng
  const mainBefore = await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [mainWh.id, variant.id]);
  assert.equal(mainBefore.rows.length, 0, 'Kho MAIN chưa có dòng trước khi đồng bộ');

  // Thực hiện webhook trừ 1 sản phẩm
  const syncRes = await processOmnichannelEvent(pool, {
    channel: 'shopee',
    sku: 'SKU-P0-AUX',
    quantityDelta: -1,
    payload: { eventId: 'evt-p0-aux-1' }
  });

  assert.equal(syncRes.ok, true);
  // Tồn kho đúng phải là 4 (tuyệt đối không được thành 9!)
  assert.equal(syncRes.variant.stockQuantity, 4, 'Tổng tồn kho phải giảm từ 5 xuống 4, không được cộng trùng thành 9');

  const varAfter = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0];
  assert.equal(varAfter.stock_quantity, 4);

  const auxAfter = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [auxWh.id, variant.id])).rows[0];
  assert.equal(auxAfter.quantity, 4, 'Kho AUX giảm từ 5 xuống 4');

  // Nếu ép trừ trực tiếp tại kho MAIN (nơi có số dư = 0), hệ thống phải chặn âm kho (409) chứ không tự sinh số dư
  await assert.rejects(
    async () => {
      await withTransaction(pool, client =>
        InventoryService.applyMovement(client, {
          source: 'adjustment',
          eventId: 'evt-p0-main-fail',
          variantId: variant.id,
          warehouseId: mainWh.id,
          delta: -1,
          allowNegative: false
        })
      );
    },
    (err) => err.status === 409
  );
});

test('Phase A - 1.2: P1 Fix - Xóa đơn vĩnh viễn hoàn tồn đúng từng kho theo phân bổ và chống hoàn trùng', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const prod = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('multi-wh-prod', 'GAERU Multi WH', 'audio', true) RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-MULTI-WH', 'Bản Pro', 800000, 10, true) RETURNING id`,
    [prod.id]
  )).rows[0];

  const mainWh = (await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN'`)).rows[0];
  const auxWh = (await pool.query(
    `INSERT INTO warehouses (code, name, active) VALUES ('AUX2', 'Kho Đà Nẵng', true) RETURNING id`
  )).rows[0];

  // Phân bổ tồn kho ban đầu: MAIN = 3, AUX2 = 3 (Tổng = 6)
  await pool.query(`DELETE FROM warehouse_stock WHERE variant_id = $1`, [variant.id]);
  await pool.query(`UPDATE product_variants SET stock_quantity = 6 WHERE id = $1`, [variant.id]);
  await pool.query(`INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 3), ($3, $2, 3)`, [mainWh.id, variant.id, auxWh.id]);

  // Tạo đơn hàng đặt 5 sản phẩm (chắc chắn lấy từ cả 2 kho: một kho 3, một kho 2)
  const order = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status)
     VALUES ('ORD-MULTI-01', 'Khách Đa Kho', 'multi@example.com', '0901112222', '123 Đường Láng', 'Hà Nội', 'cod', 4000000, 4000000, 'pending', 'pending')
     RETURNING id`
  )).rows[0];

  await pool.query(
    `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES ($1, $2, 'GAERU Multi WH', 'Bản Pro', 'SKU-MULTI-WH', 800000, 5, 4000000)`,
    [order.id, variant.id]
  );

  // Giữ kho qua inventory.reserveStock (sẽ phân bổ vào 2 kho tổng cộng 5 sản phẩm, còn dư 1)
  await withTransaction(pool, client =>
    inventory.reserveStock(client, {
      variantId: variant.id,
      quantity: 5,
      orderId: order.id,
      actor: { username: 'customer' }
    })
  );

  // Kiểm tra sau khi giữ kho: tổng 2 kho = 1 (một kho 0, một kho 1)
  const mainAfterReserve = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [mainWh.id, variant.id])).rows[0].quantity;
  const auxAfterReserve = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [auxWh.id, variant.id])).rows[0].quantity;
  assert.equal(mainAfterReserve + auxAfterReserve, 1);
  assert.deepEqual([mainAfterReserve, auxAfterReserve].sort(), [0, 1]);

  // Xóa vĩnh viễn đơn hàng -> phải trả lại đúng MAIN = 3 và AUX2 = 3
  await withTransaction(pool, client =>
    deleteOrderPermanently(client, order.id, { actor: { username: 'admin' }, inventory })
  );

  const mainAfterDelete = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [mainWh.id, variant.id])).rows[0].quantity;
  const auxAfterDelete = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [auxWh.id, variant.id])).rows[0].quantity;
  const totalAfterDelete = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity;

  assert.equal(mainAfterDelete, 3, 'Kho MAIN phải được hoàn đúng số lượng ban đầu là 3');
  assert.equal(auxAfterDelete, 3, 'Kho AUX2 phải được hoàn đúng số lượng ban đầu là 3');
  assert.equal(totalAfterDelete, 6, 'Tổng tồn kho phải trở về đúng 6');
});

test('Phase A - 4: Post-commit Gateway Flow - Callback IPN đến trước phản hồi createGatewayPayment và Rollback bù khi cổng lỗi', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());
  const crypto = require('node:crypto');
  const session = require('express-session');
  const { createApp } = require('../src/app');

  const momoConfig = {
    partnerCode: 'MOMO_TEST',
    accessKey: 'ACCESS_TEST',
    secretKey: 'SECRET_TEST_KEY_1234567890123456',
    environment: 'sandbox',
    enabled: true
  };

  const { writeRecord } = require('../src/admin-configuration');
  const appConfig = {
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-secret-phase-a-123456789012345678901234567890',
    PUBLIC_BASE_URL: 'https://gaeru.com',
    STORE_ORDERS_ENABLED: true
  };

  await pool.query(
    `INSERT INTO store_settings(setting_key, setting_value) VALUES('shipping_rates', '{"TP. Hồ Chí Minh": 30000}'::jsonb)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`
  );
  await withTransaction(pool, async (client) => {
    await writeRecord(client, appConfig, 'payment_momo', momoConfig, 0, { username: 'admin' });
    await client.query(
      `INSERT INTO payment_channel_connections(channel_id, config_version, enabled, verified_at, updated_at)
       VALUES('momo', 1, true, NULL, now())
       ON CONFLICT(channel_id) DO UPDATE SET config_version=1, enabled=true, updated_at=now()`
    );
  });

  const product = (await pool.query(
    `INSERT INTO products(slug, name, category, image_url, active) VALUES('gaeru-momo-early', 'GAERU MoMo Early', 'audio', '/assets/products/k9.webp', true) RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, 'MOMO-EARLY-SKU', 'USB-C', 200000, 15, true) RETURNING id, stock_quantity`,
    [product.id]
  )).rows[0];
  const warehouse = (await pool.query(`SELECT id FROM warehouses WHERE code='MAIN' LIMIT 1`)).rows[0];
  if (warehouse) {
    await pool.query(
      `INSERT INTO warehouse_stock(warehouse_id, variant_id, quantity) VALUES($1, $2, 15)
       ON CONFLICT(warehouse_id, variant_id) DO UPDATE SET quantity = 15`,
      [warehouse.id, variant.id]
    );
  }
  const initialStock = variant.stock_quantity;

  let server;
  let baseUrl;
  let ipnResponseDuringGatewayFlight = null;

  // Giả lập cổng MoMo phản hồi chậm, trong lúc đang chờ phản hồi thì IPN Webhook từ MoMo gọi về server trước!
  const customPaymentFetcher = async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    if (body.orderId && !ipnResponseDuringGatewayFlight) {
      const ipnPayload = {
        partnerCode: momoConfig.partnerCode,
        orderId: body.orderId,
        requestId: body.requestId,
        amount: body.amount,
        orderInfo: body.orderInfo,
        orderType: 'momo_wallet',
        transId: 9988776655,
        resultCode: 0,
        message: 'Successful.',
        payType: 'qr',
        responseTime: Date.now(),
        extraData: body.extraData || ''
      };
      const rawSig = `accessKey=${momoConfig.accessKey}&amount=${ipnPayload.amount}&extraData=${ipnPayload.extraData}&message=${ipnPayload.message}&orderId=${ipnPayload.orderId}&orderInfo=${ipnPayload.orderInfo}&orderType=${ipnPayload.orderType}&partnerCode=${ipnPayload.partnerCode}&payType=${ipnPayload.payType}&requestId=${ipnPayload.requestId}&responseTime=${ipnPayload.responseTime}&resultCode=${ipnPayload.resultCode}&transId=${ipnPayload.transId}`;
      ipnPayload.signature = crypto.createHmac('sha256', momoConfig.secretKey).update(rawSig).digest('hex');

      // Gọi IPN ngay khi createGatewayPayment còn chưa kết thúc!
      ipnResponseDuringGatewayFlight = await fetch(`${baseUrl}/api/payments/momo/ipn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ipnPayload)
      });
    }
    return new Response(
      JSON.stringify({
        resultCode: 0,
        partnerCode: body.partnerCode,
        orderId: body.orderId,
        amount: body.amount,
        payUrl: `https://test-payment.momo.vn/pay/${body.orderId}`,
        requestId: body.requestId
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const app = createApp({
    pool,
    sessionStore: new session.MemoryStore(),
    config: {
      ...appConfig,
      paymentFetcher: customPaymentFetcher
    }
  });

  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((r) => server.close(r)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Lấy CSRF token
  const sessionRes = await fetch(`${baseUrl}/api/csrf`);
  const setCookie = sessionRes.headers.get('set-cookie')?.split(';')[0] || '';
  const { csrfToken } = await sessionRes.json();

  // Đặt đơn MoMo: trong lúc gọi createGatewayPayment, IPN đến trước!
  const orderRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': setCookie,
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({
      customer: {
        name: 'Khách MoMo Sớm',
        email: 'momo-early@example.com',
        phone: '0912345678',
        address: '100 Nguyễn Huệ',
        city: 'TP. Hồ Chí Minh',
        note: ''
      },
      paymentMethod: 'momo',
      items: [{ variantId: variant.id, quantity: 1 }]
    })
  });

  assert.equal(orderRes.status, 201, 'Đặt hàng MoMo phải thành công dù IPN đến trước khi createGatewayPayment kết thúc');
  const orderData = await orderRes.json();
  assert.ok(ipnResponseDuringGatewayFlight, 'IPN phải được gọi trong lúc chờ phản hồi từ cổng thanh toán');
  assert.equal(ipnResponseDuringGatewayFlight.status, 204, 'IPN đến sớm phải tìm thấy đơn hàng đã commit và trả 204');

  // Kiểm tra trạng thái đơn hàng đã được thanh toán và đối soát chính xác
  const dbOrder = (await pool.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [orderData.order.id])).rows[0];
  assert.equal(dbOrder.payment_status, 'paid', 'Đơn hàng phải ở trạng thái paid');
  assert.equal(dbOrder.status, 'processing', 'Đơn hàng phải tự động chuyển sang processing');

  const stockAfterPaid = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity;
  assert.equal(stockAfterPaid, initialStock - 1, 'Tồn kho giảm đúng 1 đơn vị');
});

test('Phase A - 5: Đa chiến dịch chồng lấn (Flash Sale + Combo) và chống hoàn tồn kho kép khi đơn đã hủy trước khi xóa', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const mainProd = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('overlap-main', 'GAERU Overlap Main', 'audio', true) RETURNING id`
  )).rows[0];
  const accProd = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('overlap-acc', 'GAERU Overlap Acc', 'accessory', true) RETURNING id`
  )).rows[0];

  const mainVar = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-OVL-MAIN', 'Main Standard', 1000000, 10, true) RETURNING id`,
    [mainProd.id]
  )).rows[0];
  const accVar = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-OVL-ACC', 'Acc Standard', 200000, 10, true) RETURNING id`,
    [accProd.id]
  )).rows[0];

  const mainWh = (await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN'`)).rows[0];
  await pool.query(
    `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 10), ($1, $3, 10)
     ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = 10`,
    [mainWh.id, mainVar.id, accVar.id]
  );

  // Cùng lúc có Flash Sale giảm 15% toàn danh mục VÀ Combo giảm 20% cho phụ kiện
  await pool.query(
    `INSERT INTO flash_sales (title, discount_percent, starts_at, ends_at, active, product_slugs)
     VALUES ('Flash Sale 15%', 15, now() - interval '1 hour', now() + interval '1 hour', true, ARRAY['overlap-main', 'overlap-acc']::text[])`
  );
  await pool.query(
    `INSERT INTO product_bundles (main_product_slug, bundle_product_slug, bundle_title, discount_percent, active)
     VALUES ('overlap-main', 'overlap-acc', 'Combo Giảm 20%', 20, true)`
  );

  // Giỏ hàng gồm 1 sản phẩm chính + 2 phụ kiện:
  // - Sản phẩm chính hưởng Flash Sale 15%: 1.000.000 -> 850.000đ
  // - Phụ kiện: Flash Sale giảm 15% (170.000đ/chiếc, tổng 2 chiếc = 340.000đ);
  //   Combo giảm 20% cho 1 chiếc hợp lệ (160.000đ) + 1 chiếc giá thường (200.000đ) = 360.000đ.
  //   Vì 340.000đ < 360.000đ, PricingEngine phải chọn chương trình có lợi nhất cho khách là Flash Sale (340.000đ)!
  const quoted = await PricingEngine.applyPromotions(
    pool,
    [
      { id: mainVar.id, priceVnd: 1000000, quantity: 1 },
      { id: accVar.id, priceVnd: 200000, quantity: 2 }
    ],
    { context: 'cart' }
  );
  assert.equal(quoted[0].priceVnd, 850000);
  assert.equal(quoted[1].priceVnd, 170000, 'Khi 2 chiếc hưởng Flash Sale (340k) rẻ hơn 1 chiếc Combo + 1 chiếc thường (360k), hệ thống chọn mức giá tốt nhất');

  // Kiểm tra chống hoàn tồn kép: Tạo đơn, giữ kho 3 sản phẩm -> Hủy đơn (releaseOrderStock lần 1) -> Xóa vĩnh viễn đơn (deleteOrderPermanently gọi lần 2)
  const order = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status)
     VALUES ('ORD-CANCEL-DEL-01', 'Khách Hủy Rồi Xóa', 'cancel@example.com', '0909998888', '123 Lê Lợi', 'Đà Nẵng', 'cod', 3000000, 3000000, 'pending', 'pending')
     RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
     VALUES ($1, $2, 'GAERU Overlap Main', 'Main Standard', 'SKU-OVL-MAIN', 1000000, 3, 3000000)`,
    [order.id, mainVar.id]
  );

  await withTransaction(pool, client =>
    inventory.reserveStock(client, { variantId: mainVar.id, quantity: 3, orderId: order.id, actor: { username: 'customer' } })
  );
  assert.equal((await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [mainVar.id])).rows[0].stock_quantity, 7);

  // Hủy đơn trước (hoàn kho lần 1 -> tồn kho về 10)
  await withTransaction(pool, client =>
    inventory.releaseOrderStock(client, { orderId: order.id, actor: { username: 'admin' } })
  );
  await pool.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
  assert.equal((await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [mainVar.id])).rows[0].stock_quantity, 10);

  // Xóa vĩnh viễn đơn đã hủy -> KHÔNG được hoàn tồn lần 2 (tồn kho phải giữ nguyên 10, không được nhảy lên 13!)
  await withTransaction(pool, client =>
    deleteOrderPermanently(client, order.id, { actor: { username: 'admin' }, inventory })
  );
  assert.equal(
    (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [mainVar.id])).rows[0].stock_quantity,
    10,
    'Xóa vĩnh viễn đơn đã hủy không được cộng trùng tồn kho lần 2'
  );
});

test('Phase A - 2: Chuẩn hóa (channel, eventId, sku) + request hash và chống va chạm xuyên kênh', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const prod = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('hash-prod', 'GAERU Hash Prod', 'audio', true) RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-HASH-01', 'Standard', 300000, 20, true) RETURNING id`,
    [prod.id]
  )).rows[0];

  const mainWh = (await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN'`)).rows[0];
  await pool.query(
    `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 20)
     ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = 20`,
    [mainWh.id, variant.id]
  );

  // 1. Kênh Shopee gửi eventId = 'SHARED-EVT-100', delta = -2
  const res1 = await processOmnichannelEvent(pool, {
    channel: 'shopee',
    sku: 'SKU-HASH-01',
    quantityDelta: -2,
    payload: { eventId: 'SHARED-EVT-100' }
  });
  assert.equal(Boolean(res1.duplicate), false);
  assert.equal(res1.variant.stockQuantity, 18);

  // 2. Kênh Lazada gửi CÙNG eventId = 'SHARED-EVT-100', delta = -3 -> Phải được xử lý độc lập, không đụng độ event_key!
  const res2 = await processOmnichannelEvent(pool, {
    channel: 'lazada',
    sku: 'SKU-HASH-01',
    quantityDelta: -3,
    payload: { eventId: 'SHARED-EVT-100' }
  });
  assert.equal(Boolean(res2.duplicate), false, 'Sự kiện cùng eventId nhưng khác kênh phải được xử lý độc lập');
  assert.equal(res2.variant.stockQuantity, 15);

  // 3. Gửi lại đúng sự kiện Shopee (cùng channel, eventId, sku, delta) -> Idempotent replay
  const resReplay = await processOmnichannelEvent(pool, {
    channel: 'shopee',
    sku: 'SKU-HASH-01',
    quantityDelta: -2,
    payload: { eventId: 'SHARED-EVT-100' }
  });
  assert.equal(resReplay.duplicate, true);
  const stockAfterReplay = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity;
  assert.equal(stockAfterReplay, 15, 'Replay hợp lệ không làm thay đổi tồn kho');

  // 4. Gửi lại cùng (channel='shopee', eventId='SHARED-EVT-100') nhưng thay đổi delta thành -5 (Request hash mismatch) -> Phải chặn 409!
  await assert.rejects(
    async () => {
      await processOmnichannelEvent(pool, {
        channel: 'shopee',
        sku: 'SKU-HASH-01',
        quantityDelta: -5,
        payload: { eventId: 'SHARED-EVT-100' }
      });
    },
    (err) => err.status === 409 && /Xung đột Idempotency/.test(err.message)
  );
});

test('Phase A - 3: PricingEngine tách biệt Catalog vs Cart và giới hạn số lượng Combo hợp lệ min(mainQty, accessoryQty)', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const mainProd = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('gaeru-k9-main', 'GAERU K9', 'audio', true) RETURNING id`
  )).rows[0];
  const accProd = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('filter-pop-acc', 'Màng lọc âm Pop Filter', 'accessory', true) RETURNING id`
  )).rows[0];

  const mainVar = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'K9-MAIN-01', 'K9 Bản Đen', 500000, 10, true) RETURNING id`,
    [mainProd.id]
  )).rows[0];
  const accVar = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'ACC-POP-01', 'Pop Filter Chuẩn', 200000, 10, true) RETURNING id`,
    [accProd.id]
  )).rows[0];

  // Tạo gói Combo giảm 20% cho phụ kiện khi mua kèm K9
  await pool.query(
    `INSERT INTO product_bundles (main_product_slug, bundle_product_slug, bundle_title, discount_percent, active)
     VALUES ('gaeru-k9-main', 'filter-pop-acc', 'Combo Thu Âm K9 + Màng Lọc', 20, true)`
  );

  // 1. Khi duyệt danh mục (context: 'catalog'): Phụ kiện KHÔNG được giảm giá dù cả 2 sản phẩm có mặt trong danh sách
  const catalogList = await PricingEngine.applyPromotions(
    pool,
    [
      { id: mainVar.id, priceVnd: 500000 },
      { id: accVar.id, priceVnd: 200000 }
    ],
    { context: 'catalog' }
  );
  assert.equal(catalogList[0].priceVnd, 500000);
  assert.equal(catalogList[1].priceVnd, 200000, 'Trên trang danh mục, phụ kiện phải hiển thị nguyên giá gốc 200.000đ');
  assert.equal(catalogList[1].promotion, null);

  // 2. Trong giỏ hàng tỷ lệ 1:3 (1 sản phẩm chính + 3 phụ kiện, không truyền sẵn productSlug để test tự động lookup slug khi không có Flash Sale)
  const cart1to3 = await PricingEngine.applyPromotions(
    pool,
    [
      { id: mainVar.id, priceVnd: 500000, quantity: 1 },
      { id: accVar.id, priceVnd: 200000, quantity: 3 }
    ],
    { context: 'cart' }
  );

  // Chỉ 1 phụ kiện được giảm 20% (còn 160.000đ), 2 phụ kiện còn lại tính nguyên giá 200.000đ -> Tổng dòng = 160.000 + 400.000 = 560.000đ
  assert.equal(cart1to3[1].lineTotalVnd, 560000, 'Tổng tiền 3 phụ kiện khi mua kèm 1 sản phẩm chính phải là 560.000đ (1 chiếc 160k + 2 chiếc 200k)');
  assert.equal(cart1to3[1].promotion.type, 'bundle');
  assert.equal(cart1to3[1].promotion.eligibleUnits, 1, 'Snapshot phải ghi nhận đúng 1 đơn vị được hưởng ưu đãi');
  assert.equal(cart1to3[1].promotion.regularUnits, 2, 'Snapshot phải ghi nhận đúng 2 đơn vị tính giá thường');

  // 3. Trong giỏ hàng tỷ lệ 3:1 (3 sản phẩm chính + 1 phụ kiện)
  const cart3to1 = await PricingEngine.applyPromotions(
    pool,
    [
      { id: mainVar.id, priceVnd: 500000, quantity: 3 },
      { id: accVar.id, priceVnd: 200000, quantity: 1 }
    ],
    { context: 'cart' }
  );
  assert.equal(cart3to1[1].lineTotalVnd, 160000);
  assert.equal(cart3to1[1].priceVnd, 160000);
  assert.equal(cart3to1[1].promotion.eligibleUnits, 1);
  assert.equal(cart3to1[1].promotion.regularUnits, 0);
});
