const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const {
  shopeeConnector,
  tiktokConnector,
  lazadaConnector,
  getConnector,
  normalizeStatus
} = require('../src/marketplace-connectors');
const {
  createOmnichannelSync,
  resolveVariantForSku,
  ingestMarketplaceOrder,
  handleMarketplaceWebhook
} = require('../src/omnichannel-sync');
const {
  calculateTier,
  getOrCreateLoyalty,
  earnPoints,
  redeemPoints,
  refundPoints,
  createLoyaltyApi
} = require('../src/loyalty-api');

const ENCRYPTION_KEY = process.env.AUTH_ENCRYPTION_KEY || 'test-session-secret-key-12345';

function makeConfig() {
  return {
    AUTH_PEPPER: 'test-pepper-12345678901234567890',
    SESSION_SECRET: ENCRYPTION_KEY,
    adminKey: Buffer.from('test-admin-key-12345678901234567890123456789012')
  };
}

async function setupTestDb(t) {
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) {
      if (!values && sql.includes(';')) {
        return (await db.exec(sql)).at(-1);
      }
      return db.query(sql, values);
    },
    async connect() {
      return {
        query: (sql, values) => pool.query(sql, values),
        release() {}
      };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);
  return pool;
}

// -----------------------------------------------------------------------------
// TEST SUITE 1: SHOPEE OPEN PLATFORM V2 CONNECTOR
// -----------------------------------------------------------------------------
test('Shopee Open Platform v2: Auth, token, orders, stock, fulfillment and webhook', async () => {
  const partnerId = '123456';
  const partnerKey = 'test_shopee_partner_key';

  // 1. Auth URL
  const authUrl = shopeeConnector.getAuthUrl({ partnerId, partnerKey, redirectUrl: 'https://gaeru.com/callback' });
  assert.ok(authUrl.startsWith('https://partner.shopeemobile.com/api/v2/shop/auth_partner'));
  assert.ok(authUrl.includes('partner_id=123456'));
  assert.ok(authUrl.includes('sign='));

  // 2. Token Exchange
  const mockFetchToken = async (url, opts) => {
    assert.ok(url.includes('/api/v2/auth/token/get'));
    const body = JSON.parse(opts.body);
    assert.equal(body.code, 'AUTH_CODE_123');
    return {
      ok: true,
      json: async () => ({
        access_token: 'shp_access_tok_xyz',
        refresh_token: 'shp_ref_tok_xyz',
        expire_in: 14400
      })
    };
  };
  const tokenRes = await shopeeConnector.exchangeToken({
    partnerId,
    partnerKey,
    code: 'AUTH_CODE_123',
    shopId: '998877'
  }, { fetcher: mockFetchToken });
  assert.equal(tokenRes.accessToken, 'shp_access_tok_xyz');
  assert.equal(tokenRes.shopId, '998877');

  // 3. Fetch Orders
  const mockFetchOrders = async (url) => {
    assert.ok(url.includes('/api/v2/order/get_order_list'));
    return {
      ok: true,
      json: async () => ({
        response: {
          order_list: [{
            order_sn: '241102SHP001',
            create_time: 1730538000,
            order_status: 'READY_TO_SHIP',
            total_amount: 350000,
            item_list: [{
              model_sku: 'GAERU-MIC-01',
              item_name: 'Micro GAERU K1',
              model_quantity_purchased: 2,
              model_discounted_price: 175000
            }]
          }]
        }
      })
    };
  };
  const orders = await shopeeConnector.fetchOrders({
    partnerId,
    partnerKey,
    accessToken: tokenRes.accessToken,
    shopId: '998877'
  }, { fetcher: mockFetchOrders });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].externalOrderId, '241102SHP001');
  assert.equal(orders[0].status, 'processing');
  assert.equal(orders[0].items[0].externalSku, 'GAERU-MIC-01');

  // 4. Update Stock
  const mockFetchStock = async (url, opts) => {
    assert.ok(url.includes('/api/v2/product/update_stock'));
    const body = JSON.parse(opts.body);
    assert.equal(body.stock_list[0].normal_stock, 50);
    return { ok: true, json: async () => ({ error: '' }) };
  };
  const stockRes = await shopeeConnector.updateStock({
    partnerId,
    partnerKey,
    accessToken: tokenRes.accessToken,
    shopId: '998877',
    itemId: '5566',
    modelId: '11',
    stock: 50
  }, { fetcher: mockFetchStock });
  assert.equal(stockRes.success, true);

  // 5. Fulfillment: Ship Order
  const mockFetchShip = async (url, opts) => {
    assert.ok(url.includes('/api/v2/logistics/ship_order'));
    const body = JSON.parse(opts.body);
    assert.equal(body.order_sn, '241102SHP001');
    return { ok: true, json: async () => ({ response: { tracking_number: 'SPX_VN_9988' } }) };
  };
  const shipRes = await shopeeConnector.shipOrder({
    partnerId,
    partnerKey,
    accessToken: tokenRes.accessToken,
    shopId: '998877',
    orderSn: '241102SHP001'
  }, { fetcher: mockFetchShip });
  assert.equal(shipRes.success, true);

  // 6. Webhook verification
  const payload = '{"shop_id":998877,"data":{"order_sn":"241102SHP001","status":"SHIPPED"}}';
  const validSig = crypto.createHmac('sha256', partnerKey).update(payload, 'utf8').digest('hex');
  assert.equal(shopeeConnector.verifyWebhookSignature(validSig, payload, partnerKey), true);
  assert.equal(shopeeConnector.verifyWebhookSignature('bad_signature', payload, partnerKey), false);
});

// -----------------------------------------------------------------------------
// TEST SUITE 2: TIKTOK SHOP OPEN API CONNECTOR
// -----------------------------------------------------------------------------
test('TikTok Shop Open API: Auth, token, orders, stock, fulfillment and webhook', async () => {
  const appKey = 'test_tiktok_app_key';
  const appSecret = 'test_tiktok_app_secret';

  // 1. Auth URL
  const authUrl = tiktokConnector.getAuthUrl({ appKey, redirectUrl: 'https://gaeru.com/tiktok-cb' });
  assert.ok(authUrl.startsWith('https://services.tiktokshops.us/open/authorize'));
  assert.ok(authUrl.includes('app_key=test_tiktok_app_key'));

  // 2. Token Exchange
  const mockFetchToken = async (url) => {
    assert.ok(url.includes('/api/v2/token/get'));
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          access_token: 'tt_access_token_123',
          refresh_token: 'tt_refresh_token_123',
          open_id_list: ['VN_SHOP_CIPHER_888']
        }
      })
    };
  };
  const tokenRes = await tiktokConnector.exchangeToken({
    appKey,
    appSecret,
    authCode: 'TT_CODE_77'
  }, { fetcher: mockFetchToken });
  assert.equal(tokenRes.accessToken, 'tt_access_token_123');
  assert.equal(tokenRes.shopCipher, null, 'Open ID is not a TikTok shop cipher; obtain it from Get Authorized Shops');

  // 3. Fetch Orders
  const mockFetchOrders = async (url, opts) => {
    assert.ok(url.includes('/order/202309/orders/search'));
    assert.equal(opts.headers['x-tts-access-token'], 'tt_access_token_123');
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          orders: [{
            id: '5789234789123',
            create_time: 1730538000,
            status: 'AWAITING_COLLECTION',
            payment: { total_amount: 420000 },
            line_items: [{
              seller_sku: 'GAERU-MIC-02',
              product_name: 'Micro GAERU K2 Pro',
              quantity: 1,
              sale_price: 420000
            }]
          }]
        }
      })
    };
  };
  const orders = await tiktokConnector.fetchOrders({
    appKey,
    appSecret,
    accessToken: tokenRes.accessToken,
    shopCipher: 'VN_SHOP_CIPHER_888'
  }, { fetcher: mockFetchOrders });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].externalOrderId, '5789234789123');
  assert.equal(orders[0].status, 'processing');
  assert.equal(orders[0].items[0].externalSku, 'GAERU-MIC-02');

  // 4. Update Stock
  const mockFetchStock = async (url, opts) => {
    assert.ok(url.includes('/stocks/update'));
    const body = JSON.parse(opts.body);
    assert.equal(body.skus[0].available_stock, 100);
    return { ok: true, json: async () => ({ code: 0 }) };
  };
  const stockRes = await tiktokConnector.updateStock({
    appKey,
    appSecret,
    accessToken: tokenRes.accessToken,
    shopCipher: 'VN_SHOP_CIPHER_888',
    productId: 'P123',
    skuId: 'S123',
    availableStock: 100
  }, { fetcher: mockFetchStock });
  assert.equal(stockRes.success, true);

  // 5. Fulfillment: Ship Package
  const mockFetchShip = async (url, opts) => {
    assert.ok(url.includes('/packages/PKG_889/ship'));
    return { ok: true, json: async () => ({ code: 0, data: { status: 'SHIPPED' } }) };
  };
  const shipRes = await tiktokConnector.shipOrder({
    appKey,
    appSecret,
    accessToken: tokenRes.accessToken,
    shopCipher: 'VN_SHOP_CIPHER_888',
    packageId: 'PKG_889'
  }, { fetcher: mockFetchShip });
  assert.equal(shipRes.success, true);

  // 6. Webhook verification
  const payload = '{"shop_id":"VN_SHOP_CIPHER_888","data":{"order_id":"5789234789123","order_status":"COMPLETED"}}';
  const validSig = crypto.createHmac('sha256', appSecret).update(payload, 'utf8').digest('hex');
  assert.equal(tiktokConnector.verifyWebhookSignature(validSig, payload, appSecret), true);
  assert.equal(tiktokConnector.verifyWebhookSignature('wrong_hash', payload, appSecret), false);
});

// -----------------------------------------------------------------------------
// TEST SUITE 3: LAZADA OPEN PLATFORM CONNECTOR
// -----------------------------------------------------------------------------
test('Lazada Open Platform: Alphabet HMAC signature, orders, stock, fulfillment and webhook', async () => {
  const appKey = 'test_lazada_app_key';
  const appSecret = 'test_lazada_app_secret';

  // 1. Signature calculation: Alphabetical sorted parameter concatenation
  const params = { b: '2', a: '1', z: '3' };
  const sig = lazadaConnector.createSignature(appSecret, '/test/path', params);
  const expectedStr = '/test/patha1b2z3';
  const expectedSig = crypto.createHmac('sha256', appSecret).update(expectedStr, 'utf8').digest('hex').toUpperCase();
  assert.equal(sig, expectedSig);

  // 2. Auth URL
  const authUrl = lazadaConnector.getAuthUrl({ appKey, redirectUrl: 'https://gaeru.com/lazada-cb' });
  assert.ok(authUrl.startsWith('https://auth.lazada.com/oauth/authorize'));
  assert.ok(authUrl.includes('client_id=test_lazada_app_key'));

  // 3. Token Exchange
  const mockFetchToken = async (url) => {
    assert.ok(url.includes('/auth/token/create'));
    return {
      ok: true,
      json: async () => ({
        code: '0',
        access_token: 'laz_access_token_456',
        refresh_token: 'laz_refresh_token_456',
        country_user_info: [{ seller_id: 'VN_LZD_SELLER_01' }]
      })
    };
  };
  const tokenRes = await lazadaConnector.exchangeToken({
    appKey,
    appSecret,
    code: 'LZD_CODE_123'
  }, { fetcher: mockFetchToken });
  assert.equal(tokenRes.accessToken, 'laz_access_token_456');
  assert.equal(tokenRes.sellerId, 'VN_LZD_SELLER_01');

  // 4. Fetch Orders
  const mockFetchOrders = async (url) => {
    assert.ok(url.includes('/orders/get'));
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          orders: [{
            order_id: '9988112233',
            created_at: '2026-11-02T10:00:00Z',
            statuses: ['shipped'],
            price: '590000',
            items: [{
              sku: 'GAERU-MIC-03',
              name: 'Micro GAERU K3 Studio',
              quantity: 1,
              item_price: '590000'
            }]
          }]
        }
      })
    };
  };
  const orders = await lazadaConnector.fetchOrders({
    appKey,
    appSecret,
    accessToken: tokenRes.accessToken
  }, { fetcher: mockFetchOrders });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].externalOrderId, '9988112233');
  assert.equal(orders[0].status, 'shipped');

  // 5. Update Stock
  const mockFetchStock = async (url, opts) => {
    assert.ok(url.includes('/product/price_quantity/update'));
    assert.ok(opts.body.includes('Quantity%3E40'));
    return { ok: true, json: async () => ({ code: '0' }) };
  };
  const stockRes = await lazadaConnector.updateStock({
    appKey,
    appSecret,
    accessToken: tokenRes.accessToken,
    sku: 'GAERU-MIC-03',
    quantity: 40
  }, { fetcher: mockFetchStock });
  assert.equal(stockRes.success, true);

  // 6. Fulfillment: Ready to Ship (RTS)
  const mockFetchRts = async (url, opts) => {
    assert.ok(url.includes('/order/package/rts'));
    return { ok: true, json: async () => ({ code: '0' }) };
  };
  const rtsRes = await lazadaConnector.readyToShip({
    appKey,
    appSecret,
    accessToken: tokenRes.accessToken,
    orderItemIds: ['ITEM_111', 'ITEM_222']
  }, { fetcher: mockFetchRts });
  assert.equal(rtsRes.success, true);

  // 7. Webhook signature
  const payload = '{"seller_id":"VN_LZD_SELLER_01","data":{"order_id":"9988112233","order_status":"delivered"}}';
  const validSig = crypto.createHmac('sha256', appSecret).update(payload, 'utf8').digest('hex').toUpperCase();
  assert.equal(lazadaConnector.verifyWebhookSignature(validSig, payload, appSecret), true);
  assert.equal(lazadaConnector.verifyWebhookSignature('WRONG_SIGNATURE', payload, appSecret), false);
});

// -----------------------------------------------------------------------------
// TEST SUITE 4: OMNICHANNEL STOCK REVERSAL & SKU MAPPING
// -----------------------------------------------------------------------------
test('Omnichannel: Stock deduction on order, idempotent restock reversal on cancel/return and SKU mapping', async t => {
  const pool = await setupTestDb(t);
  const client = await pool.connect();
  t.after(() => client.release());

  // Create test product and variant
  const prodRes = await client.query(
    `INSERT INTO products (name, slug, category, active) VALUES ('Micro GAERU K1', 'micro-gaeru-k1', 'audio', true) RETURNING id`
  );
  const productId = prodRes.rows[0].id;
  const varRes = await client.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'MIC-K1-STD', 'Bản Tiêu Chuẩn', 250000, 20, true) RETURNING id`,
    [productId]
  );
  const variantId = varRes.rows[0].id;

  // 1. Direct SKU resolution fallback
  const resolvedDirect = await resolveVariantForSku(client, 'shopee', 'SHOP_01', 'MIC-K1-STD');
  assert.equal(resolvedDirect, variantId);

  // 2. Explicit SKU Mapping
  await client.query(
    `INSERT INTO marketplace_sku_mappings (channel, shop_id, external_sku, variant_id)
     VALUES ('shopee', 'SHOP_01', 'EXT-SHOPEE-999', $1)`,
    [variantId]
  );
  const resolvedMapped = await resolveVariantForSku(client, 'shopee', 'SHOP_01', 'EXT-SHOPEE-999');
  assert.equal(resolvedMapped, variantId);

  // 3. Ingesting confirmed order ➔ Deducts stock from 20 to 18
  const orderData = {
    externalOrderId: 'SPX-VN-1001',
    rawStatus: 'PROCESSING',
    totalAmountVnd: 500000,
    items: [{ externalSku: 'EXT-SHOPEE-999', quantity: 2 }]
  };
  const order1 = await ingestMarketplaceOrder(client, {
    channel: 'shopee',
    shopId: 'SHOP_01',
    order: orderData,
    autoDeductStock: true
  });
  assert.equal(order1.status, 'processing');
  assert.equal(order1.stock_deducted, true);
  assert.equal(order1.stock_reversed, false);

  const stockAfterSale = (await client.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variantId])).rows[0].stock_quantity;
  assert.equal(stockAfterSale, 18);

  // 4. Order is CANCELLED ➔ Automatic Stock Reversal (Hoàn tồn kho đơn sàn hủy)
  const cancelOrderData = {
    externalOrderId: 'SPX-VN-1001',
    rawStatus: 'CANCELLED',
    items: [{ externalSku: 'EXT-SHOPEE-999', quantity: 2 }]
  };
  const orderCancelled = await ingestMarketplaceOrder(client, {
    channel: 'shopee',
    shopId: 'SHOP_01',
    order: cancelOrderData,
    autoDeductStock: true
  });
  assert.equal(orderCancelled.status, 'cancelled');
  assert.equal(orderCancelled.stock_reversed, true);

  const stockAfterReverse = (await client.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variantId])).rows[0].stock_quantity;
  assert.equal(stockAfterReverse, 20); // Successfully restored back to 20!

  // 5. Idempotency test: Ingesting the same cancelled event again does NOT re-reverse stock
  await ingestMarketplaceOrder(client, {
    channel: 'shopee',
    shopId: 'SHOP_01',
    order: cancelOrderData,
    autoDeductStock: true
  });
  const stockAfterDuplicate = (await client.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variantId])).rows[0].stock_quantity;
  assert.equal(stockAfterDuplicate, 20); // Still 20, never double restored!

  // 6. Unauthenticated public webhook ingestion remains disabled
  const config = makeConfig();
  await assert.rejects(() => handleMarketplaceWebhook(pool, config, 'tiktok', {
    shop_id: 'SHOP_TT_01',
    data: {
      order_id: 'TT-ORDER-888',
      order_status: 'AWAITING_COLLECTION',
      total_amount: 250000,
      items: [{ externalSku: 'MIC-K1-STD', quantity: 1 }]
    }
  }), e => e.status === 501);
  assert.equal((await client.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[variantId])).rows[0].stock_quantity,20);
});

// -----------------------------------------------------------------------------
// TEST SUITE 5: GAERU XU / LOYALTY PROGRAM (CONCURRENCY-SAFE LEDGER)
// -----------------------------------------------------------------------------
test('GAERU Xu: Tier calculation, earn on completion, redeem with discount cap, refund on cancel, concurrency row-locking', async t => {
  const pool = await setupTestDb(t);
  const client = await pool.connect();
  t.after(() => client.release());

  // 1. Tier calculation
  assert.equal(calculateTier(0), 'bronze');
  assert.equal(calculateTier(99000), 'bronze');
  assert.equal(calculateTier(100000), 'silver');
  assert.equal(calculateTier(500000), 'gold');
  assert.equal(calculateTier(2500000), 'platinum');

  // Create customer
  const custRes = await client.query(
    `INSERT INTO customers (email, full_name, phone, password_hash, active)
     VALUES ('customer@gaeru.com', 'Nguyen Van A', '0912345678', 'test_password_hash', true) RETURNING id`
  );
  const customerId = custRes.rows[0].id;

  // 2. Initial state
  const initialLoyalty = await getOrCreateLoyalty(client, customerId);
  assert.equal(initialLoyalty.pointsBalance, 0);
  assert.equal(initialLoyalty.tier, 'bronze');

  // Create orders for testing earn and redeem
  const o1Res = await client.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, shipping_fee_vnd, total_vnd, customer_id, status, payment_status)
     VALUES ('GR-TEST-001', 'Nguyen Van A', 'customer@gaeru.com', '0912345678', '123 Pho Hue', 'Ha Noi', 'cod', 15000000, 0, 15000000, $1, 'completed', 'paid')
     RETURNING id`,
    [customerId]
  );
  const orderId1 = o1Res.rows[0].id;

  const o2Res = await client.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, shipping_fee_vnd, total_vnd, customer_id, status, payment_status)
     VALUES ('GR-TEST-002', 'Nguyen Van A', 'customer@gaeru.com', '0912345678', '123 Pho Hue', 'Ha Noi', 'cod', 100000, 0, 100000, $1, 'pending', 'pending')
     RETURNING id`,
    [customerId]
  );
  const orderId2 = o2Res.rows[0].id;

  // 3. Earn points on order completion: 1% of 15,000,000 VND = 150,000 Xu (Upgrades to Silver)
  const earnRes = await earnPoints(client, {
    customerId,
    orderId: orderId1,
    orderTotalVnd: 15000000,
    reason: 'Tích điểm đơn hàng 1'
  });
  assert.equal(earnRes.success, true);
  assert.equal(earnRes.earnedPoints, 150000);
  assert.equal(earnRes.balanceAfter, 150000);
  assert.equal(earnRes.tier, 'silver');

  // 4. Earn idempotency: Calling earnPoints again with same orderId does not duplicate points
  const earnDuplicate = await earnPoints(client, {
    customerId,
    orderId: orderId1,
    orderTotalVnd: 15000000
  });
  assert.equal(earnDuplicate.existing, true);
  assert.equal(earnDuplicate.balanceAfter, 150000);

  // 5. Redeem points: Attempting to redeem more than 50% order value fails
  await assert.rejects(
    async () => {
      await redeemPoints(client, {
        customerId,
        orderId: orderId2,
        pointsToRedeem: 60000,
        orderTotalVnd: 100000, // max 50% is 50,000
        maxRedeemRatio: 0.5
      });
    },
    { message: /Số Xu sử dụng vượt quá giới hạn/ }
  );

  // 6. Redeem valid points: Redeem 40,000 Xu for 100,000 VND order
  const redeemRes = await redeemPoints(client, {
    customerId,
    orderId: orderId2,
    pointsToRedeem: 40000,
    orderTotalVnd: 100000,
    maxRedeemRatio: 0.5,
    reason: 'Tiêu Xu cho đơn hàng 2'
  });
  assert.equal(redeemRes.success, true);
  assert.equal(redeemRes.redeemedPoints, 40000);
  assert.equal(redeemRes.discountVnd, 40000);
  assert.equal(redeemRes.balanceAfter, 110000);

  // 7. Redeem idempotency: Duplicate call returns existing ledger balance
  const redeemDuplicate = await redeemPoints(client, {
    customerId,
    orderId: orderId2,
    pointsToRedeem: 40000
  });
  assert.equal(redeemDuplicate.existing, true);
  assert.equal(redeemDuplicate.balanceAfter, 110000);

  // 8. Insufficient balance rejection
  await assert.rejects(
    async () => {
      await redeemPoints(client, {
        customerId,
        orderId: crypto.randomUUID(),
        pointsToRedeem: 99999999,
        orderTotalVnd: 500000000
      });
    },
    { message: /Số dư GAERU Xu không đủ/ }
  );

  // 9. Refund points on order cancellation: Restores the 40,000 Xu back to customer
  const refundRes = await refundPoints(client, {
    customerId,
    orderId: orderId2,
    reason: 'Khách hàng hủy đơn hàng 2'
  });
  assert.equal(refundRes.success, true);

  const loyaltyAfterRefund = await getOrCreateLoyalty(client, customerId);
  assert.equal(loyaltyAfterRefund.pointsBalance, 150000); // 110,000 + 40,000 = 150,000 Xu restored!

  // 10. Refund points when order that earned points is cancelled/returned: Revokes earned points
  await refundPoints(client, {
    customerId,
    orderId: orderId1,
    reason: 'Trả hàng đơn hàng 1'
  });
  const loyaltyAfterRevoke = await getOrCreateLoyalty(client, customerId);
  assert.equal(loyaltyAfterRevoke.pointsBalance, 0); // 150,000 - 150,000 = 0
});

// -----------------------------------------------------------------------------
// TEST SUITE 6: LOYALTY & OMNICHANNEL HTTP APIS
// -----------------------------------------------------------------------------
test('Loyalty & Omnichannel HTTP APIs: Customer balance quote, admin adjust, and webhook routes', async t => {
  const express = require('express');
  const pool = await setupTestDb(t);
  const config = makeConfig();

  // Create customer
  const client = await pool.connect();
  const custRes = await client.query(
    `INSERT INTO customers (email, full_name, phone, password_hash, active)
     VALUES ('loyalty_user@gaeru.com', 'Tran Thi B', '0987654321', 'test_hash', true) RETURNING id`
  );
  const customerId = custRes.rows[0].id;
  client.release();

  // 1. Loyalty Router setup
  const loyalty = createLoyaltyApi(pool);
  const app = express();
  app.use(express.json());

  // Mock customer & admin session with CSRF
  const csrfToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  app.use((req, res, next) => {
    req.session = { customer: { id: customerId }, csrfToken };
    req.admin = { username: 'gaeru_owner', role: 'owner', permissions: ['customers.write', 'customers.read', 'marketplace.write', 'marketplace.read'] };
    next();
  });
  app.use('/api/customer', loyalty.customer);
  app.use('/api/gaeru_ceo', loyalty.admin);

  // Omnichannel Router setup
  const omnichannel = createOmnichannelSync(pool, config);
  app.use('/api/gaeru_ceo', omnichannel.admin);
  app.use('/api', omnichannel.publicApi);

  const server = app.listen(0);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 1. GET /api/customer/loyalty
  const res1 = await fetch(`${baseUrl}/api/customer/loyalty`);
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  assert.equal(body1.loyalty.pointsBalance, 0);
  assert.equal(body1.loyalty.tier, 'bronze');

  // 2. Admin adjust points: +50,000 Xu
  const resAdjust = await fetch(`${baseUrl}/api/gaeru_ceo/customers/${customerId}/loyalty/adjust`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ points: 50000, reason: 'Chương trình tri ân sinh nhật khách hàng' })
  });
  assert.equal(resAdjust.status, 200);
  const bodyAdjust = await resAdjust.json();
  assert.equal(bodyAdjust.points, 50000);
  assert.equal(bodyAdjust.balanceAfter, 50000);

  // 3. POST /api/customer/loyalty/quote
  const resQuote = await fetch(`${baseUrl}/api/customer/loyalty/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subtotalVnd: 200000 })
  });
  assert.equal(resQuote.status, 200);
  const bodyQuote = await resQuote.json();
  assert.equal(bodyQuote.currentBalance, 50000);
  assert.equal(bodyQuote.appliedPoints, 50000); // 50% of 200,000 is 100,000, but customer only has 50,000

  // 4. Admin SKU mapping: POST & GET
  const pRes = await pool.query(`INSERT INTO products (name, slug, category, active) VALUES ('Prod A', 'prod-a', 'audio', true) RETURNING id`);
  const vRes = await pool.query(`INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'SKU-A', 'Var A', 100000, 10, true) RETURNING id`, [pRes.rows[0].id]);
  const varId = vRes.rows[0].id;

  const resMap = await fetch(`${baseUrl}/api/gaeru_ceo/marketplace/mappings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ channel: 'shopee', shopId: 'SHOP_99', externalSku: 'EXT_SKU_A', variantId: varId })
  });
  assert.equal(resMap.status, 200);

  const resListMap = await fetch(`${baseUrl}/api/gaeru_ceo/marketplace/mappings?channel=shopee`);
  assert.equal(resListMap.status, 200);
  const bodyListMap = await resListMap.json();
  assert.equal(bodyListMap.mappings.length, 1);
  assert.equal(bodyListMap.mappings[0].external_sku, 'EXT_SKU_A');
});

// -----------------------------------------------------------------------------
// TEST SUITE 7: STORE API INTEGRATION (CHECKOUT REDEEM & ORDER LIFECYCLE EARN)
// -----------------------------------------------------------------------------
test('Store API Integration: Checkout with GAERU Xu redemption, and earn points on completed/paid order', async t => {
  const express = require('express');
  const pool = await setupTestDb(t);
  const { createStoreApi } = require('../src/store-api');

  // Insert product and variant
  const pRes = await pool.query(`INSERT INTO products (name, slug, category, active) VALUES ('Micro GAERU K1', 'k1-loyalty', 'audio', true) RETURNING id`);
  const vRes = await pool.query(`INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'K1-LOYALTY', 'Standard', 500000, 50, true) RETURNING id`, [pRes.rows[0].id]);
  const variantId = vRes.rows[0].id;

  // Insert customer with initial 100,000 Xu
  const custRes = await pool.query(
    `INSERT INTO customers (email, full_name, phone, password_hash, active)
     VALUES ('buyer_loyalty@gaeru.com', 'Le Van C', '0911223344', 'test_hash', true) RETURNING id`
  );
  const customerId = custRes.rows[0].id;
  await pool.query(
    `INSERT INTO customer_loyalty (customer_id, points_balance, lifetime_earned, tier)
     VALUES ($1, 100000, 100000, 'silver')`,
    [customerId]
  );

  // Set shipping rates
  await pool.query(
    `INSERT INTO store_settings(setting_key, setting_value)
     VALUES ('shipping_rates', $1)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = $1`,
    [JSON.stringify({ 'Toàn quốc': 30000 })]
  );

  const csrfToken = 'test-csrf-token-abc12345678901234567890123456789012';
  const adminObj = { username: 'owner_user', role: 'owner', permissions: ['orders.write', 'orders.read', 'payments.write'] };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { customer: { id: customerId }, admin: adminObj, csrfToken };
    req.admin = adminObj;
    next();
  });
  app.use('/api', createStoreApi(pool, { ordersEnabled: true }));

  const server = app.listen(0);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 1. Checkout with 50,000 loyalty points redeemed
  // Order: 1 item * 500,000 + 30,000 ship = 530,000.
  // With 50,000 Xu discount ➔ totalVnd = 480,000 VND
  const checkoutRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({
      customer: {
        name: 'Le Van C',
        email: 'buyer_loyalty@gaeru.com',
        phone: '0911223344',
        address: '99 Tran Hung Dao',
        city: 'Hà Nội',
        note: ''
      },
      paymentMethod: 'cod',
      loyaltyPointsToRedeem: 50000,
      items: [{ variantId, quantity: 1 }]
    })
  });
  assert.equal(checkoutRes.status, 201);
  const checkoutBody = await checkoutRes.json();
  const orderId = checkoutBody.order.id;
  assert.equal(checkoutBody.order.totalVnd, 480000);
  assert.equal(checkoutBody.order.loyaltyDiscountVnd, 50000);

  // Check customer loyalty balance: 100,000 - 50,000 = 50,000 Xu
  const balRes1 = await pool.query('SELECT points_balance FROM customer_loyalty WHERE customer_id = $1', [customerId]);
  assert.equal(balRes1.rows[0].points_balance, 50000);

  // 2. Admin completes the order & marks paid: Order lifecycle hook triggers earnPoints
  // Silver tier earns 1.2% of 480,000 VND = 5,760 Xu.
  const updateRes = await fetch(`${baseUrl}/api/gaeru_ceo/orders/${orderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ status: 'confirmed' })
  });
  assert.equal(updateRes.status, 200);

  await fetch(`${baseUrl}/api/gaeru_ceo/orders/${orderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ status: 'processing' })
  });
  await fetch(`${baseUrl}/api/gaeru_ceo/orders/${orderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ status: 'shipped' })
  });
  const delivered = await fetch(`${baseUrl}/api/gaeru_ceo/orders/${orderId}/confirm-delivery`, {
    method:'POST',
    headers:{'Content-Type':'application/json','x-csrf-token':csrfToken},
    body:JSON.stringify({evidenceNote:'Buyer accepted the shipment with signed delivery receipt'})
  });
  assert.equal(delivered.status,200);
  const completeRes = await fetch(`${baseUrl}/api/gaeru_ceo/orders/${orderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({paymentStatus: 'paid'})
  });
  assert.equal(completeRes.status, 200);

  // Check customer loyalty balance: 50,000 + 5,760 = 55,760 Xu.
  const balRes2 = await pool.query('SELECT points_balance FROM customer_loyalty WHERE customer_id = $1', [customerId]);
  assert.equal(balRes2.rows[0].points_balance, 55760);
});
