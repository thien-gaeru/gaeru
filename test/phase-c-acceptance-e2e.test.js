'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');
const { createTestDb } = require('./helpers/pglite-db');
const { withTransaction } = require('../src/db');
const { createApp } = require('../src/app');
const { writeRecord } = require('../src/admin-configuration');
const { processOmnichannelEvent } = require('../src/omnichannel-sync');
const { processCodReconciliation } = require('../src/cod-reconciliation');
const { transitionPaymentStatus } = require('../src/domain/payments/payment-policy');
const { CatalogService } = require('../src/domain/catalog/catalog-service');
const { InventoryService } = require('../src/domain/inventory/inventory-service');
const { verifyPageIntegrity } = require('../src/clean-routes');
const sharedFormat = require('../src/shared/format');
const adminFormat = require('../admin/format');

test('Phase C - 10: Gộp Browser Helpers (UMD format.js), chuẩn hóa HTML Layout và dọn sạch file dư thừa', async () => {
  // 1. Kiểm tra src/shared/format.js và admin/format.js là cùng một nguồn UMD duy nhất
  assert.equal(sharedFormat.escapeHtml, adminFormat.escapeHtml);
  assert.equal(sharedFormat.formatMoney(1500000), '1.500.000 ₫');
  assert.equal(sharedFormat.escapeHtml('<script>"alert"</script>'), '&lt;script&gt;&quot;alert&quot;&lt;/script&gt;');
  assert.equal(sharedFormat.normalizePhone('+84 912 345 678'), '0912345678');

  // 2. Kiểm tra các file trùng lặp / không được tham chiếu đã được loại bỏ sạch sẽ
  const rootDir = path.resolve(__dirname, '..');
  assert.equal(fs.existsSync(path.join(rootDir, 'admin', 'shared', 'format.js')), false, 'admin/shared/format.js trùng lặp đã được dọn dẹp');
  assert.equal(fs.existsSync(path.join(rootDir, 'scripts', 'update-product-stories.cjs')), false, 'scripts/update-product-stories.cjs dư thừa đã được dọn dẹp');
  assert.equal(fs.existsSync(path.join(rootDir, 'scripts', 'generate-html-layouts.js')), false, 'scripts/generate-html-layouts.js đã được gộp vào src/clean-routes.js');

  // 3. Kiểm tra tính toàn vẹn template HTML qua verifyPageIntegrity trong src/clean-routes.js
  for (const page of ['terms.html', 'legal.html', 'privacy.html', 'delivery-returns.html', 'index.html', 'shop.html', 'checkout.html']) {
    const res = verifyPageIntegrity(page, rootDir);
    assert.equal(res.status, 'valid', `Trang ${page} phải tuân thủ chuẩn layout dùng chung`);
  }
});

test('Phase C - 12.1 & 12.4: Song song 2 khách cùng đặt SKU cuối cùng (chặn oversell) & MoMo Timeout tự động Rollback bù', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const appConfig = {
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-secret-phase-c-123456789012345678901234567890',
    PUBLIC_BASE_URL: 'https://gaeru.com',
    STORE_ORDERS_ENABLED: true
  };

  const momoConfig = {
    partnerCode: 'MOMO_PHASE_C',
    accessKey: 'ACCESS_PHASE_C',
    secretKey: 'SECRET_PHASE_C_1234567890123456',
    environment: 'sandbox',
    enabled: true
  };

  await pool.query(
    `INSERT INTO store_settings(setting_key, setting_value)
     VALUES('shipping_rates', '{"Hà Nội": 30000, "TP. Hồ Chí Minh": 35000}'::jsonb)
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

  // Tạo sản phẩm chỉ còn ĐÚNG 1 chiếc cuối cùng trong kho!
  const prod = (await pool.query(
    `INSERT INTO products(slug, name, category, image_url, active)
     VALUES('gaeru-last-sku', 'GAERU Last Item', 'audio', '/assets/products/k9.webp', true) RETURNING id`
  )).rows[0];
  const lastVariant = (await pool.query(
    `INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES($1, 'SKU-LAST-ONE', 'Phiên Bản Giới Hạn', 500000, 1, true) RETURNING id`,
    [prod.id]
  )).rows[0];
  const mainWh = (await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN' LIMIT 1`)).rows[0];
  await pool.query(
    `INSERT INTO warehouse_stock(warehouse_id, variant_id, quantity) VALUES($1, $2, 1)
     ON CONFLICT(warehouse_id, variant_id) DO UPDATE SET quantity = 1`,
    [mainWh.id, lastVariant.id]
  );

  // Giả lập MoMo: bước create bị Timeout (504), bước query xác nhận không có giao dịch (resultCode: 1001)
  const timeoutFetcher = async (url) => {
    if (String(url).includes('/v2/gateway/api/query')) {
      return new Response(
        JSON.stringify({ resultCode: 1001, message: 'Transaction not found' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const err = new Error('Gateway request timed out after 10000ms');
    err.status = 504;
    throw err;
  };

  const app = createApp({
    pool,
    sessionStore: new session.MemoryStore(),
    config: {
      ...appConfig,
      paymentFetcher: timeoutFetcher
    }
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((r) => server.close(r)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function createBuyerSession() {
    const r = await fetch(`${baseUrl}/api/csrf`);
    const cookie = r.headers.get('set-cookie')?.split(';')[0] || '';
    const { csrfToken } = await r.json();
    return { cookie, csrfToken };
  }

  // --- Kịch bản 12.4: Khách đặt qua MoMo nhưng MoMo bị Timeout (504) -> Giữ nguyên đơn ở payment_initiation_unknown (KHÔNG xóa đơn), sau đó đối soát xác minh chưa thu tiền mới hủy đơn & hoàn kho! ---
  const momoBuyer = await createBuyerSession();
  const momoRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': momoBuyer.cookie,
      'X-CSRF-Token': momoBuyer.csrfToken
    },
    body: JSON.stringify({
      customer: {
        name: 'Khách MoMo Timeout',
        email: 'timeout@example.com',
        phone: '0911222333',
        address: '10 Lê Lợi',
        city: 'TP. Hồ Chí Minh',
        note: ''
      },
      paymentMethod: 'momo',
      items: [{ variantId: lastVariant.id, quantity: 1 }]
    })
  });
  assert.equal(momoRes.status, 502, 'Khi MoMo timeout, API phải trả mã lỗi cổng thanh toán (502)');
  const momoErrBody = await momoRes.json();
  assert.equal(momoErrBody.reconciliationStatus, 'payment_initiation_unknown', 'Trạng thái phải là payment_initiation_unknown, không xóa đơn');
  assert.equal(
    (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [lastVariant.id])).rows[0].stock_quantity,
    0,
    'Khi trạng thái thanh toán chưa xác định, tồn kho phải tiếp tục được giữ cho đến khi đối soát xong'
  );

  // Đối soát với cổng MoMo: xác minh chắc chắn found=false (không có tiền) -> khóa transaction hủy đơn & hoàn kho
  const recOutcome = await require('../src/payment-channels').reconcileGatewayOrder(pool, {
    orderId: momoErrBody.orderId,
    provider: 'momo',
    settings: momoConfig,
    fetcher: timeoutFetcher
  });
  assert.equal(recOutcome.action, 'cancelled_unpaid');

  const stockAfterTimeout = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [lastVariant.id])).rows[0].stock_quantity;
  const whStockAfterTimeout = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [mainWh.id, lastVariant.id])).rows[0].quantity;
  assert.equal(stockAfterTimeout, 1, 'Sau khi đối soát xác minh không thu tiền, tồn kho phải được hoàn trả về đúng 1');
  assert.equal(whStockAfterTimeout, 1, 'Tồn kho tại kho MAIN phải được hoàn trả về đúng 1');
  const keptTimeoutOrder = (await pool.query(`SELECT status FROM orders WHERE id = $1`, [momoErrBody.orderId])).rows[0];
  assert.equal(keptTimeoutOrder.status, 'cancelled', 'Bản ghi đơn hàng vẫn được lưu giữ ở trạng thái cancelled để phục vụ kiểm toán');

  // --- Kịch bản 12.1: 2 khách hàng cùng lúc bấm đặt mua 1 chiếc SKU cuối cùng (Promise.all) ---
  const [buyerA, buyerB] = await Promise.all([createBuyerSession(), createBuyerSession()]);

  const [resA, resB] = await Promise.all([
    fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': buyerA.cookie,
        'X-CSRF-Token': buyerA.csrfToken
      },
      body: JSON.stringify({
        customer: {
          name: 'Khách Hàng A',
          email: 'buyer-a@example.com',
          phone: '0901111111',
          address: '1 Cầu Giấy',
          city: 'Hà Nội',
          note: ''
        },
        paymentMethod: 'cod',
        items: [{ variantId: lastVariant.id, quantity: 1 }]
      })
    }),
    fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': buyerB.cookie,
        'X-CSRF-Token': buyerB.csrfToken
      },
      body: JSON.stringify({
        customer: {
          name: 'Khách Hàng B',
          email: 'buyer-b@example.com',
          phone: '0902222222',
          address: '2 Cầu Giấy',
          city: 'Hà Nội',
          note: ''
        },
        paymentMethod: 'cod',
        items: [{ variantId: lastVariant.id, quantity: 1 }]
      })
    })
  ]);

  const statuses = [resA.status, resB.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [201, 409], 'Đúng 1 khách đặt thành công (201) và 1 khách bị từ chối hết hàng (409)');

  const finalStock = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [lastVariant.id])).rows[0].stock_quantity;
  const finalWhStock = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [mainWh.id, lastVariant.id])).rows[0].quantity;
  assert.equal(finalStock, 0, 'Tồn kho cuối cùng bằng 0, tuyệt đối không bị âm');
  assert.equal(finalWhStock, 0);
});

test('Phase C - 12.2, 12.3, 12.5, 12.6, 12.7, 12.8: Webhook trùng/lệch, Combo 1:3, Hoàn COD, Rollback SQL, Quyền nhân viên & Xóa/Khôi phục sản phẩm', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  // --- 12.2: Webhook trùng nội dung (idempotent) vs cùng eventId nhưng khác nội dung (409) ---
  const mainProd = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('c12-main', 'GAERU C12 Main', 'audio', true) RETURNING id`
  )).rows[0];
  const accProd = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('c12-acc', 'GAERU C12 Acc', 'accessory', true) RETURNING id`
  )).rows[0];

  const mainVar = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-C12-MAIN', 'Main', 500000, 10, true) RETURNING id`,
    [mainProd.id]
  )).rows[0];
  const accVar = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-C12-ACC', 'Acc', 200000, 10, true) RETURNING id`,
    [accProd.id]
  )).rows[0];

  const mainWh = (await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN'`)).rows[0];
  await pool.query(
    `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 10), ($1, $3, 10)
     ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = 10`,
    [mainWh.id, mainVar.id, accVar.id]
  );

  const wh1 = await processOmnichannelEvent(pool, {
    channel: 'shopee',
    sku: 'SKU-C12-MAIN',
    quantityDelta: -1,
    payload: { eventId: 'EVT-C12-SYNC' }
  });
  assert.equal(wh1.variant.stockQuantity, 9);

  // Gửi trùng y hệt -> duplicate: true, tồn giữ nguyên 9
  const whDup = await processOmnichannelEvent(pool, {
    channel: 'shopee',
    sku: 'SKU-C12-MAIN',
    quantityDelta: -1,
    payload: { eventId: 'EVT-C12-SYNC' }
  });
  assert.equal(whDup.duplicate, true);

  // Gửi cùng eventId nhưng đổi SKU hoặc delta -> chặn 409
  await assert.rejects(
    async () => {
      await processOmnichannelEvent(pool, {
        channel: 'shopee',
        sku: 'SKU-C12-ACC',
        quantityDelta: -1,
        payload: { eventId: 'EVT-C12-SYNC' }
      });
    },
    (err) => err.status === 409
  );

  // --- 12.3: Giỏ Combo tỷ lệ 1:3 (1 chính 500k + 3 phụ kiện 200k, giảm 20% cho đúng 1 phụ kiện -> 500k + 160k + 400k = 1.060.000đ) ---
  await pool.query(
    `INSERT INTO product_bundles (main_product_slug, bundle_product_slug, bundle_title, discount_percent, active)
     VALUES ('c12-main', 'c12-acc', 'Combo C12 Giảm 20%', 20, true)`
  );
  const { PricingEngine } = require('../src/domain/pricing/pricing-engine');
  const cartQuote = await PricingEngine.quoteCartPrices(pool, [
    { id: mainVar.id, priceVnd: 500000, quantity: 1, productSlug: 'c12-main' },
    { id: accVar.id, priceVnd: 200000, quantity: 3, productSlug: 'c12-acc' }
  ]);
  assert.equal(cartQuote.subtotalVnd, 1060000);
  assert.equal(cartQuote.items[1].promotion.eligibleUnits, 1);
  assert.equal(cartQuote.items[1].promotion.regularUnits, 2);

  // --- 12.5: Đối soát & Hoàn COD (COD Reconciliation + PaymentPolicy) ---
  const codOrder = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_status)
     VALUES ('ORD-COD-C12', 'Khách COD', 'cod@example.com', '0903334444', '50 Nguyễn Trãi', 'Hà Nội', 'cod', 500000, 30000, 530000, 'shipped', 'pending')
     RETURNING id, order_number`
  )).rows[0];

  const recRes = await processCodReconciliation(pool, {
    carrier: 'ghn',
    fileName: 'doi-soat-ghn.csv',
    items: [
      { trackingCode: 'GHN-12345', orderCode: codOrder.order_number, carrierCollectedVnd: 530000, feeVnd: 15000 }
    ]
  });
  assert.equal(recRes.status, 'reconciled');
  const codAfterRec = (await pool.query(`SELECT payment_status FROM orders WHERE id = $1`, [codOrder.id])).rows[0];
  assert.equal(codAfterRec.payment_status, 'paid', 'Đối soát COD khớp tiền phải tự động chuyển payment_status sang paid');

  // Chặn chuyển ngược từ paid về pending (409) qua PaymentPolicy
  await assert.rejects(
    async () => {
      await transitionPaymentStatus(pool, { orderId: codOrder.id, targetStatus: 'pending' });
    },
    (err) => err.status === 409
  );

  // Đơn COD khách boom hàng / hoàn trả -> hoàn tồn kho chính xác về kho đã phân bổ
  const codReturnOrder = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_status)
     VALUES ('ORD-COD-RET-C12', 'Khách Hoàn COD', 'ret@example.com', '0904445555', '60 Lê Lợi', 'Hà Nội', 'cod', 200000, 30000, 230000, 'shipped', 'pending')
     RETURNING id`
  )).rows[0];
  await withTransaction(pool, client =>
    InventoryService.reserveOrderStock(client, {
      orderId: codReturnOrder.id,
      items: [{ variantId: accVar.id, quantity: 2 }],
      actor: 'customer:cod'
    })
  );
  const accStockAfterCodReserve = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [accVar.id])).rows[0].stock_quantity;
  assert.equal(accStockAfterCodReserve, 8, 'Tồn phụ kiện sau khi giữ 2 chiếc cho đơn COD phải giảm từ 10 còn 8');

  await withTransaction(pool, client =>
    InventoryService.releaseOrderStock(client, {
      orderId: codReturnOrder.id,
      reason: 'cod_return_to_sender',
      actor: 'admin:warehouse'
    })
  );
  const accStockAfterCodReturn = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [accVar.id])).rows[0].stock_quantity;
  assert.equal(accStockAfterCodReturn, 10, 'Hoàn đơn COD phải cộng trả đúng 2 chiếc phụ kiện về kho (tồn = 10)');

  // --- 12.6: Rollback SQL toàn vẹn khi có lỗi phát sinh giữa giao dịch ---
  const stockBeforeRollback = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [mainVar.id])).rows[0].stock_quantity;
  await assert.rejects(
    async () => {
      await withTransaction(pool, async (client) => {
        await client.query(`UPDATE product_variants SET stock_quantity = 999 WHERE id = $1`, [mainVar.id]);
        throw Object.assign(new Error('Forced mid-transaction failure'), { status: 500 });
      });
    },
    /Forced mid-transaction failure/
  );
  const stockAfterRollback = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [mainVar.id])).rows[0].stock_quantity;
  assert.equal(stockAfterRollback, stockBeforeRollback, 'Rollback SQL phải khôi phục chính xác trạng thái trước giao dịch');

  // --- 12.7 & 12.8: Quyền nhân viên (RBAC) và Xóa mềm / Khôi phục / Chặn xóa vĩnh viễn khi còn tồn kho ---
  // Nhân viên role 'sales' (không phải owner/admin) bị chặn 403 khi gọi purgeProduct
  await withTransaction(pool, client =>
    CatalogService.softDeleteProduct(client, {
      productId: accProd.id,
      actor: { username: 'sales_staff', role: 'sales' }
    })
  );

  await assert.rejects(
    async () => {
      await withTransaction(pool, client =>
        CatalogService.purgeProduct(client, {
          productId: accProd.id,
          confirmation: 'c12-acc',
          actor: { username: 'sales_staff', role: 'sales' }
        })
      );
    },
    (err) => err.status === 403
  );

  // Chủ doanh nghiệp (role 'owner') gọi purgeProduct nhưng sản phẩm còn tồn kho = 10 -> bị chặn 409!
  await assert.rejects(
    async () => {
      await withTransaction(pool, client =>
        CatalogService.purgeProduct(client, {
          productId: accProd.id,
          confirmation: 'c12-acc',
          actor: { username: 'owner_ceo', role: 'owner' }
        })
      );
    },
    (err) => err.status === 409 && /còn tồn kho/.test(err.message)
  );

  // Khôi phục lại sản phẩm từ thùng rác thành công
  const restoredAcc = await withTransaction(pool, client =>
    CatalogService.restoreProduct(client, {
      productId: accProd.id,
      activate: true,
      actor: { username: 'owner_ceo', role: 'owner' }
    })
  );
  assert.equal(restoredAcc.active, true);

  // --- 12.9: Minh bạch Social Proof (verifiedPurchase), che số tiền/vận đơn khi tra cứu không kèm SĐT & Cache Security Config ---
  const { getRecentSocialProof } = require('../src/social-proof');
  const { lookupOrderTracking } = require('../src/tracking-api');
  const { readRecord } = require('../src/admin-configuration');

  const socialItems = await getRecentSocialProof(pool);
  const paidItem = socialItems.find(i => i.customerName === 'Khách C.');
  const pendingItem = socialItems.find(i => i.customerName === 'Hoàn C.');
  assert.equal(paidItem?.verifiedPurchase, true, 'Đơn đã thanh toán (paid) mới được gắn cờ verifiedPurchase = true');
  assert.equal(pendingItem?.verifiedPurchase, false, 'Đơn mới tạo chưa thanh toán gắn cờ verifiedPurchase = false');

  const unverifiedLookup = await lookupOrderTracking(pool, codOrder.order_number);
  assert.equal(unverifiedLookup.orders[0].isPhoneVerified, false);
  assert.equal(unverifiedLookup.orders[0].totalVnd, null, 'Tra cứu chỉ bằng mã đơn không được lộ tổng tiền đơn hàng');
  assert.equal(unverifiedLookup.orders[0].paymentMethod, null, 'Tra cứu chỉ bằng mã đơn không được lộ phương thức thanh toán');
  assert.equal(unverifiedLookup.orders[0].trackingCode, null, 'Tra cứu chỉ bằng mã đơn không được lộ mã vận đơn');

  const testCfg = { SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef' };
  const sec0 = await readRecord(pool, testCfg, 'security');
  assert.equal(sec0.version, 0);
  await withTransaction(pool, c =>
    writeRecord(c, testCfg, 'security', { idleMinutes: 15, absoluteHours: 4 }, 0, { username: 'owner', role: 'owner' })
  );
  const sec1 = await readRecord(pool, testCfg, 'security');
  assert.equal(sec1.version, 1, 'Cache cấu hình security phải được vô hiệu hóa tức thì ngay khi writeRecord cập nhật');
  assert.equal(sec1.data.idleMinutes, 15);
});
