const { createTestDb } = require('./helpers/pglite-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { randomBytes, randomUUID } = require('node:crypto');
const { createApp } = require('../src/app');


test('Full Business Workflow Simulation: End-to-end reality test for store launch readiness', { timeout: 90000 }, async (t) => {
  const { pool, close: closeDb } = await createTestDb();
  const outboxEmails = [];
  const customerMailer = {
    async sendMail(m) {
      outboxEmails.push(m);
      return { accepted: [m.to], rejected: [] };
    }
  };

  const password = 'Gaeru-Owner-Pass-2026';
  const config = {
    NODE_ENV: 'test',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    ADMIN_USERNAME: 'gaeru_owner',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(password, 4),
    PUBLIC_BASE_URL: 'https://gaeru.com',
    STORE_ORDERS_ENABLED: true,
    smtp: { from: 'business@gaeru.com', publicBaseUrl: 'https://gaeru.com' }
  };

  const app = createApp({
    config,
    pool,
    customerMailer,
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
  });

  const base = 'http://127.0.0.1:' + server.address().port;

  function createClient() {
    const cookies = new Map();
    let csrf = '';
    return {
      async call(urlPath, method = 'GET', body, sendCsrf = true) {
        const cookieHeader = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
        const headers = {
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(sendCsrf && csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {})
        };
        const res = await fetch(base + urlPath, {
          method,
          headers,
          body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
        });
        const rawSetCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
        for (const sc of rawSetCookies) {
          const part = sc.split(';')[0];
          const eq = part.indexOf('=');
          if (eq > 0) {
            cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
          }
        }
        const isJson = res.headers.get('content-type')?.includes('application/json');
        const data = isJson ? await res.json() : await res.text();
        if (data && typeof data === 'object' && data.csrfToken) {
          csrf = data.csrfToken;
        }
        return { status: res.status, data, headers: res.headers };
      },
      async loginAdmin(u = config.ADMIN_USERNAME, p = password) {
        await this.call('/api/csrf');
        return this.call('/api/auth/login', 'POST', { username: u, password: p });
      }
    };
  }

  const admin = createClient();
  const customer = createClient();

  // =========================================================================
  // BƯỚC 1: ĐĂNG NHẬP QUẢN TRỊ & THIẾT LẬP CỬA HÀNG (Admin Setup & Policies)
  // =========================================================================
  const loginRes = await admin.loginAdmin();
  assert.equal(loginRes.status, 200, 'Admin login must succeed');

  // Cấu hình bảng phí giao hàng chuẩn Nghị định 52/2013/NĐ-CP
  await pool.query(
    `INSERT INTO store_settings(setting_key, setting_value)
     VALUES('shipping_rates', $1)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = $1`,
    [JSON.stringify({ 'Toàn quốc': 30000, 'Hà Nội': 20000, 'TP. Hồ Chí Minh': 20000 })]
  );

  // Kích hoạt nhận đơn toàn sàn
  const enableOpsRes = await admin.call('/api/gaeru_ceo/owner/configuration/operations', 'PUT', {
    version: 0,
    data: { ordersEnabled: true },
    password
  });
  assert.equal(enableOpsRes.status, 200, 'Orders enablement should succeed when shipping rates exist');

  // =========================================================================
  // BƯỚC 2: QUẢN LÝ SẢN PHẨM & BIẾN THỂ (Product Catalog & Inventory)
  // =========================================================================
  // Tạo sản phẩm GAERU K9
  const createProdRes = await admin.call('/api/gaeru_ceo/products', 'POST', {
    slug: 'gaeru-k9-mic-thu-am',
    name: 'GAERU K9 Mic Thu Âm Không Dây Cài Áo',
    category: 'audio',
    descriptor: 'Giảm tiếng ồn thông minh, truyền xa 20m',
    description: 'Micro thu âm không dây cài áo GAERU K9 chuyên dụng cho điện thoại, máy tính, livestream và quay video.',
    imageUrl: '/assets/products/k9-clean.webp',
    imageAlt: 'Micro thu âm GAERU K9',
    active: false,
    sortOrder: 1
  });
  assert.equal(createProdRes.status, 201, 'Product creation should succeed');
  const productId = createProdRes.data.id;

  // Thêm các biến thể cho K9 (Type-C và Lightning)
  const addVar1 = await admin.call(`/api/gaeru_ceo/products/${productId}/variants`, 'POST', {
    sku: 'K9-1MIC-TYPEC',
    name: '1 Mic - Cổng Type-C',
    options: { 'Chân cắm': 'Type-C', 'Số lượng mic': '1' },
    priceVnd: 189000,
    stockQuantity: 50,
    active: true
  });
  assert.equal(addVar1.status, 201, 'Variant 1 creation should succeed');

  const addVar2 = await admin.call(`/api/gaeru_ceo/products/${productId}/variants`, 'POST', {
    sku: 'K9-2MIC-TYPEC',
    name: '2 Mic - Cổng Type-C',
    options: { 'Chân cắm': 'Type-C', 'Số lượng mic': '2' },
    priceVnd: 289000,
    stockQuantity: 30,
    active: true
  });
  assert.equal(addVar2.status, 201, 'Variant 2 creation should succeed');

  const addVar3 = await admin.call(`/api/gaeru_ceo/products/${productId}/variants`, 'POST', {
    sku: 'K9-1MIC-IPHONE',
    name: '1 Mic - Cổng Lightning iPhone',
    options: { 'Chân cắm': 'Lightning', 'Số lượng mic': '1' },
    priceVnd: 199000,
    stockQuantity: 40,
    active: true
  });
  assert.equal(addVar3.status, 201, 'Variant 3 creation should succeed');

  // Xuất bản sản phẩm (Bật mở bán)
  const pubRes = await admin.call(`/api/gaeru_ceo/products/${productId}`, 'PUT', {
    slug: 'gaeru-k9-mic-thu-am',
    name: 'GAERU K9 Mic Thu Âm Không Dây Cài Áo',
    category: 'audio',
    descriptor: 'Giảm tiếng ồn thông minh, truyền xa 20m',
    description: 'Micro thu âm không dây cài áo GAERU K9 chuyên dụng cho điện thoại, máy tính, livestream và quay video.',
    imageUrl: '/assets/products/k9-clean.webp',
    imageAlt: 'Micro thu âm GAERU K9',
    active: true,
    sortOrder: 1
  });
  assert.equal(pubRes.status, 200, 'Product publishing should succeed with active variants');

  // Khách hàng duyệt danh mục công khai
  const catalogRes = await customer.call('/api/products');
  assert.equal(catalogRes.status, 200);
  const foundProduct = catalogRes.data.products.find(p => p.slug === 'gaeru-k9-mic-thu-am');
  assert.ok(foundProduct, 'Published product must appear in customer catalog');
  assert.equal(foundProduct.variants.length, 3, 'Must have 3 active variants');

  // =========================================================================
  // BƯỚC 3: MUA SẮM, ĐẶT HÀNG & RÀ SOÁT CHECKOUT (Customer Checkout)
  // =========================================================================
  // Tạo tài khoản khách hàng và đăng nhập để áp dụng voucher ưu đãi
  const customerPassword = 'Customer-Password-123!';
  const customerHash = bcrypt.hashSync(customerPassword, 4);
  const customerId = (await pool.query(
    `INSERT INTO customers(full_name, email, phone, password_hash, active, email_verified_at)
     VALUES('Nguyễn Văn An', 'nguyenvanan@example.test', '0912345678', $1, true, now())
     RETURNING id`,
    [customerHash]
  )).rows[0].id;

  await customer.call('/api/csrf');
  const custLoginRes = await customer.call('/api/customer-auth/login', 'POST', {
    identifier: 'nguyenvanan@example.test',
    password: customerPassword
  });
  assert.equal(custLoginRes.status, 200, 'Customer login should succeed');

  // Tạo voucher khuyến mãi kích cầu & claim vào ví khách hàng
  const voucherInsert = await pool.query(
    `INSERT INTO marketing_vouchers(code, title, kind, amount, min_spend_vnd, max_discount_vnd, total_limit, active, public_claim, starts_at, ends_at)
     VALUES('GAERU50K', 'Giảm 50.000đ đơn từ 200k', 'fixed', 50000, 200000, 50000, 100, true, true, now() - interval '1 hour', now() + interval '7 days')
     RETURNING id`
  );
  await pool.query(
    `INSERT INTO customer_vouchers(customer_id, voucher_id, source)
     VALUES($1, $2, 'saved')`,
    [customerId, voucherInsert.rows[0].id]
  );

  const selectedVariant = foundProduct.variants.find(v => v.sku === 'K9-2MIC-TYPEC');

  // Đặt hàng COD
  const orderPayload = {
    customer: {
      name: 'Nguyễn Văn An',
      email: 'nguyenvanan@example.test',
      phone: '0912345678',
      address: 'Số 88 Phố Huế, Phường Hàng Bài',
      city: 'Hà Nội',
      note: 'Giao giờ hành chính, gọi trước khi giao'
    },
    paymentMethod: 'cod',
    voucherCode: 'GAERU50K',
    items: [
      { variantId: selectedVariant.id, quantity: 1 }
    ]
  };

  const placeOrderRes = await customer.call('/api/orders', 'POST', orderPayload);
  assert.equal(placeOrderRes.status, 201, 'Order placement must succeed with 201');
  const placedOrder = placeOrderRes.data.order;
  assert.ok(placedOrder.orderNumber.startsWith('GR-'));
  // 289.000 (subtotal) + 20.000 (shipping HN) - 50.000 (voucher) = 259.000đ
  assert.equal(placedOrder.subtotalVnd, 289000);
  assert.equal(placedOrder.shippingFeeVnd, 20000);
  assert.equal(placedOrder.totalVnd, 259000);

  // Kiểm tra trừ kho tồn chính xác
  const stockCheck = await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1', [selectedVariant.id]);
  assert.equal(stockCheck.rows[0].stock_quantity, 29, 'Inventory must be decremented from 30 to 29');

  // =========================================================================
  // BƯỚC 4: VÒNG ĐỜI ĐƠN HÀNG & XUẤT HÓA ĐƠN ĐIỆN TỬ (Order Fulfillment & MISA)
  // =========================================================================
  // Vòng đời đơn hàng nghiêm ngặt: pending -> confirmed -> processing -> shipped -> completed
  await admin.call(`/api/gaeru_ceo/orders/${placedOrder.id}`, 'PATCH', { status: 'confirmed' });
  await admin.call(`/api/gaeru_ceo/orders/${placedOrder.id}`, 'PATCH', { status: 'processing' });
  await admin.call(`/api/gaeru_ceo/orders/${placedOrder.id}`, 'PATCH', { status: 'shipped' });

  // Thu tiền COD thành công và hoàn thành đơn hàng (tự động kích hoạt hóa đơn điện tử MISA eShop)
  const completeRes = await admin.call(`/api/gaeru_ceo/orders/${placedOrder.id}`, 'PATCH', {
    status: 'completed',
    paymentStatus: 'paid'
  });
  assert.equal(completeRes.status, 200, 'Order completion should succeed');

  // Tự động kích hoạt bảo hành điện tử chính hãng 12 tháng theo từng thiết bị
  const warrantyRow = await pool.query(
    `SELECT w.* FROM warranty_activations w
     JOIN order_items i ON i.id = w.order_item_id
     WHERE i.order_id = $1`,
    [placedOrder.id]
  );
  assert.equal(warrantyRow.rows.length, 1, 'Unit warranty must be automatically created upon order completion & payment');
  assert.equal(warrantyRow.rows[0].status, 'active');
  assert.ok(warrantyRow.rows[0].expires_on, 'Warranty must have an expiration date 12 months later');

  // =========================================================================
  // BƯỚC 5: HỖ TRỢ BẢO HÀNH CARE+ & TIẾP NHẬN YÊU CẦU ĐA KÊNH
  // =========================================================================
  // Khách hàng gửi yêu cầu đăng ký bảo hành sàn ngoài (Shopee SPX)
  const claimRes = await customer.call('/api/warranty-requests', 'POST', {
    channel: 'shopee',
    externalOrderNumber: 'SPX-VN-987654321',
    productName: 'Micro không dây GAERU K9',
    serial: 'SN-K9-998877',
    purchaseDate: new Date().toISOString().slice(0, 10),
    contact: {
      fullName: 'Nguyễn Văn An',
      phone: '0912345678',
      address: 'Số 88 Phố Huế',
      city: 'Hà Nội'
    },
    requestKey: randomUUID()
  });
  assert.equal(claimRes.status, 201, 'Valid warranty claim should be accepted');
  assert.equal(claimRes.data.activation.status, 'pending');

  // Khách hàng gửi yêu cầu hỗ trợ Care+ về đơn hàng website
  const careRes = await customer.call('/api/customer/care', 'POST', {
    orderId: placedOrder.id,
    subject: 'Hỏi về cách dùng mic GAERU K9',
    description: 'Em đã nhận được hàng micro GAERU K9 rất ưng ý, xin tư vấn thêm cách kết nối cổng Type-C.',
    channel: 'website',
    requestKey: randomUUID()
  });
  assert.equal(careRes.status, 201, 'Care request for order should be submitted successfully');

  // =========================================================================
  // BƯỚC 6: BẢO VỆ AN NINH WAF, RATE LIMIT & SỨC KHỎE HỆ THỐNG
  // =========================================================================
  // WAF ngăn chặn tool dò quét
  const attackRes = await fetch(`${base}/api/products`, {
    headers: { 'User-Agent': 'sqlmap/1.7' }
  });
  assert.equal(attackRes.status, 403, 'Malicious scanner must be blocked by WAF');

  // WAF ngăn chặn duyệt file nhạy cảm
  const dotEnvRes = await fetch(`${base}/.env`);
  assert.equal(dotEnvRes.status, 403, 'Path traversal to .env must be blocked by WAF');

  // Bẫy Honeypot chống spam form
  const honeypotRes = await customer.call('/api/customer-auth/login', 'POST', {
    email: 'spammer@bot.net',
    password: 'password123',
    _website_hp: 'spam_payload_trapped'
  });
  assert.equal(honeypotRes.status, 400, 'Honeypot submission must be dropped with 400 SPAM_REJECTED');

  // Kiểm tra Sức khỏe hệ thống thời gian thực (Trang tổng quan)
  const healthRes = await admin.call('/api/gaeru_ceo/system-health');
  assert.equal(healthRes.status, 200, 'System health endpoint must return 200 for authenticated admin');
  assert.equal(healthRes.data.status, 'healthy');
  assert.equal(healthRes.data.database.status, 'connected');
  assert.equal(healthRes.data.security.antiHack.status, 'active');
  assert.ok(healthRes.data.security.antiHack.threatsBlocked >= 2, 'Blocked threats must be recorded in system health metrics');
});
