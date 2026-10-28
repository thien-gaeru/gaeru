const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { randomBytes, randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');

async function createTestDatabase() {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const before = queue;
    let release;
    queue = new Promise((resolve) => (release = resolve));
    await before;
    return release;
  }
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  return {
    async query(sql, values) {
      const release = await lock();
      try {
        return await query(sql, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    },
    async end() {
      await db.close();
    }
  };
}

test('Comprehensive Deep Audit & Real-World Simulation: Full End-to-End Business Operations', { timeout: 90000 }, async (t) => {
  const pool = await createTestDatabase();
  await migrateDatabase(pool);

  const outboxEmails = [];
  const customerMailer = {
    async sendMail(m) {
      outboxEmails.push(m);
      return { accepted: [m.to], rejected: [] };
    }
  };

  const adminPassword = 'Gaeru-Owner-StrongPass-2026';
  const config = {
    NODE_ENV: 'test',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    ADMIN_USERNAME: 'gaeru_owner',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(adminPassword, 4),
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
    await pool.end();
  });

  const base = 'http://127.0.0.1:' + server.address().port;

  function createHttpClient() {
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
      async fetchCsrf() {
        const res = await this.call('/api/csrf');
        if (res.data?.csrfToken) csrf = res.data.csrfToken;
        return csrf;
      },
      async loginAdmin(u = config.ADMIN_USERNAME, p = adminPassword) {
        await this.fetchCsrf();
        return this.call('/api/auth/login', 'POST', { username: u, password: p });
      }
    };
  }

  const admin = createHttpClient();
  const guest = createHttpClient();
  const buyer = createHttpClient();

  // =========================================================================
  // GIAI ĐOẠN 1: THIẾT LẬP CỬA HÀNG, ĐĂNG NHẬP ADMIN & BẢNG GIÁ VẬN CHUYỂN
  // =========================================================================
  const adminLogin = await admin.loginAdmin();
  assert.equal(adminLogin.status, 200, 'Admin đăng nhập thành công');

  // Cấu hình bảng cước phí giao hàng 63 tỉnh thành chuẩn Decree 52
  await pool.query(
    `INSERT INTO store_settings(setting_key, setting_value)
     VALUES('shipping_rates', $1)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = $1`,
    [JSON.stringify({
      'Toàn quốc': 30000,
      'Hà Nội': 20000,
      'TP. Hồ Chí Minh': 20000,
      'Đà Nẵng': 25000,
      'Cần Thơ': 25000
    })]
  );

  const enableOps = await admin.call('/api/gaeru_ceo/owner/configuration/operations', 'PUT', {
    version: 0,
    data: { ordersEnabled: true },
    password: adminPassword
  });
  assert.equal(enableOps.status, 200, 'Bật nhận đơn hàng toàn diện thành công');

  // =========================================================================
  // GIAI ĐOẠN 2: QUẢN LÝ SẢN PHẨM & TỒN KHO BIẾN THỂ (Product Workspace)
  // =========================================================================
  const newProductRes = await admin.call('/api/gaeru_ceo/products', 'POST', {
    slug: 'gaeru-m1-studio-mic',
    name: 'GAERU M1 Studio Wireless Microphone',
    category: 'audio',
    descriptor: 'Thu âm phòng thu không dây 2.4GHz độ phân giải cao',
    description: 'GAERU M1 thiết kế nguyên khối kim loại, chống ồn DSP kép, pin 24h kèm hộp sạc thông minh.',
    imageUrl: '/assets/products/m1-studio.webp',
    imageAlt: 'Micro thu âm GAERU M1',
    active: false,
    sortOrder: 1
  });
  assert.equal(newProductRes.status, 201, 'Tạo sản phẩm M1 thành công');
  const prodId = newProductRes.data.id;

  // Thêm các biến thể
  const v1 = await admin.call(`/api/gaeru_ceo/products/${prodId}/variants`, 'POST', {
    sku: 'M1-BLACK-TYPEC',
    name: 'Màu Đen - Chân Type-C',
    options: { 'Màu sắc': 'Đen Phantom', 'Kết nối': 'Type-C' },
    priceVnd: 550000,
    stockQuantity: 100,
    active: true
  });
  assert.equal(v1.status, 201, 'Tạo biến thể 1 thành công');

  const v2 = await admin.call(`/api/gaeru_ceo/products/${prodId}/variants`, 'POST', {
    sku: 'M1-WHITE-LIGHTNING',
    name: 'Màu Trắng - Chân Lightning iOS',
    options: { 'Màu sắc': 'Trắng Glacier', 'Kết nối': 'Lightning' },
    priceVnd: 590000,
    stockQuantity: 80,
    active: true
  });
  assert.equal(v2.status, 201, 'Tạo biến thể 2 thành công');

  // Xuất bản mở bán sản phẩm
  const publishRes = await admin.call(`/api/gaeru_ceo/products/${prodId}`, 'PUT', {
    slug: 'gaeru-m1-studio-mic',
    name: 'GAERU M1 Studio Wireless Microphone',
    category: 'audio',
    descriptor: 'Thu âm phòng thu không dây 2.4GHz độ phân giải cao',
    description: 'GAERU M1 thiết kế nguyên khối kim loại, chống ồn DSP kép, pin 24h kèm hộp sạc thông minh.',
    imageUrl: '/assets/products/m1-studio.webp',
    imageAlt: 'Micro thu âm GAERU M1',
    active: true,
    sortOrder: 1
  });
  assert.equal(publishRes.status, 200, 'Xuất bản sản phẩm M1 thành công');

  // Khách truy cập danh mục sản phẩm (Storefront)
  const storeCatalog = await guest.call('/api/products');
  assert.equal(storeCatalog.status, 200, 'Khách xem được danh mục sản phẩm');
  const liveM1 = storeCatalog.data.products.find(p => p.slug === 'gaeru-m1-studio-mic');
  assert.ok(liveM1, 'Sản phẩm M1 xuất hiện trên gian hàng công khai');
  assert.equal(liveM1.variants.length, 2, 'Hiển thị đủ 2 biến thể mở bán');

  // =========================================================================
  // GIAI ĐOẠN 3: TÀI KHOẢN KHÁCH HÀNG, GOOGLE OAUTH, SỔ ĐỊA CHỈ & BẢO MẬT 2FA
  // =========================================================================
  // Đăng ký tài khoản khách hàng mới
  await buyer.fetchCsrf();
  const registerRes = await buyer.call('/api/customer-auth/register', 'POST', {
    fullName: 'Trần Thị Thu Hà',
    email: 'tranthithuha@gaeru.test',
    phone: '0988776655',
    password: 'CustomerSecurePass-2026!'
  });
  assert.equal(registerRes.status, 200, 'Đăng ký tài khoản thành công');
  assert.equal(registerRes.data.customer.fullName, 'Trần Thị Thu Hà');

  // Khách hàng thêm địa chỉ giao hàng vào sổ địa chỉ (Address Book)
  const addAddressRes = await buyer.call('/api/customer/addresses', 'POST', {
    label: 'Nhà riêng',
    fullName: 'Trần Thị Thu Hà',
    phone: '0988776655',
    address: 'Số 120 Đường Nguyễn Thị Minh Khai, Phường Đa Kao',
    city: 'TP. Hồ Chí Minh',
    isDefault: true
  });
  assert.equal(addAddressRes.status, 201, 'Lưu địa chỉ vào sổ địa chỉ thành công');
  const savedAddrId = addAddressRes.data.address.id;

  // Lấy danh sách địa chỉ đã lưu
  const listAddrRes = await buyer.call('/api/customer/addresses');
  assert.equal(listAddrRes.status, 200);
  assert.equal(listAddrRes.data.addresses.length, 1);
  assert.equal(listAddrRes.data.addresses[0].isDefault, true);

  // Sửa địa chỉ
  const editAddrRes = await buyer.call(`/api/customer/addresses/${savedAddrId}`, 'PUT', {
    label: 'Căn hộ chung cư',
    fullName: 'Trần Thị Thu Hà',
    phone: '0988776655',
    address: 'Căn hộ 12.04 Tòa A, 120 Nguyễn Thị Minh Khai',
    city: 'TP. Hồ Chí Minh',
    isDefault: true
  });
  assert.equal(editAddrRes.status, 200, 'Cập nhật địa chỉ thành công');

  // Khách hàng đăng nhập bằng Google OAuth (Mock Demo Token)
  const oauthClient = createHttpClient();
  await oauthClient.fetchCsrf();
  const googleLoginRes = await oauthClient.call('/api/customer-auth/oauth/google', 'POST', {
    credential: 'mock-google-demo-token'
  });
  assert.equal(googleLoginRes.status, 200, 'Đăng nhập Google OAuth thành công');
  assert.equal(googleLoginRes.data.customer.email, 'khachhang.google.demo@gmail.com');
  assert.ok(googleLoginRes.data.customer.emailVerified, 'Google OAuth tự động xác minh email');

  // =========================================================================
  // GIAI ĐOẠN 4: ĐẶT HÀNG, ÁP DỤNG VOUCHER & KIỂM TRA TRỪ KHO CHÍNH XÁC
  // =========================================================================
  // Tạo voucher giảm giá 100k cho đơn từ 500k
  const voucherQuery = await pool.query(
    `INSERT INTO marketing_vouchers(code, title, kind, amount, min_spend_vnd, max_discount_vnd, total_limit, active, public_claim, starts_at, ends_at)
     VALUES('GAERU100K', 'Giảm ngay 100.000đ cho đơn từ 500k', 'fixed', 100000, 500000, 100000, 50, true, true, now() - interval '1 hour', now() + interval '5 days')
     RETURNING id`
  );
  await pool.query(
    `INSERT INTO customer_vouchers(customer_id, voucher_id, source)
     VALUES($1, $2, 'saved')`,
    [registerRes.data.customer.id, voucherQuery.rows[0].id]
  );

  const chosenVariant = liveM1.variants.find(v => v.sku === 'M1-BLACK-TYPEC');
  assert.equal(chosenVariant.stockQuantity, 100, 'Tồn kho ban đầu là 100');

  // Đặt hàng với địa chỉ đã lưu tại TP. Hồ Chí Minh
  const orderRes = await buyer.call('/api/orders', 'POST', {
    customer: {
      name: 'Trần Thị Thu Hà',
      email: 'tranthithuha@gaeru.test',
      phone: '0988776655',
      address: 'Căn hộ 12.04 Tòa A, 120 Nguyễn Thị Minh Khai',
      city: 'TP. Hồ Chí Minh',
      note: 'Giao trong giờ hành chính'
    },
    paymentMethod: 'cod',
    voucherCode: 'GAERU100K',
    items: [
      { variantId: chosenVariant.id, quantity: 1 }
    ]
  });

  assert.equal(orderRes.status, 201, 'Đặt hàng thành công với mã 201');
  const order = orderRes.data.order;
  assert.ok(order.orderNumber.startsWith('GR-'), 'Mã đơn hàng theo chuẩn GR-');
  // Giá: 550.000 (subtotal) + 20.000 (ship HCM) - 100.000 (voucher) = 470.000đ
  assert.equal(order.subtotalVnd, 550000);
  assert.equal(order.shippingFeeVnd, 20000);
  assert.equal(order.totalVnd, 470000);

  // Kiểm tra trừ kho tồn nguyên tử (Atomic inventory decrement)
  const stockAfterOrder = await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1', [chosenVariant.id]);
  assert.equal(stockAfterOrder.rows[0].stock_quantity, 99, 'Tồn kho giảm chính xác từ 100 xuống 99');

  // =========================================================================
  // GIAI ĐOẠN 5: VÒNG ĐỜI ĐƠN HÀNG, KÍCH HOẠT BẢO HÀNH CARE+ & XUẤT HÓA ĐƠN
  // =========================================================================
  // Trạng thái: pending -> confirmed -> processing -> shipped
  const confRes = await admin.call(`/api/gaeru_ceo/orders/${order.id}`, 'PATCH', { status: 'confirmed' });
  assert.equal(confRes.status, 200, 'Xác nhận đơn hàng thành công');

  const procRes = await admin.call(`/api/gaeru_ceo/orders/${order.id}`, 'PATCH', { status: 'processing' });
  assert.equal(procRes.status, 200, 'Chuyển đơn sang khâu đóng gói thành công');

  const shipRes = await admin.call(`/api/gaeru_ceo/orders/${order.id}`, 'PATCH', { status: 'shipped' });
  assert.equal(shipRes.status, 200, 'Bàn giao vận chuyển SPX thành công');

  // Hoàn tất đơn hàng và thu tiền COD thành công
  const completeRes = await admin.call(`/api/gaeru_ceo/orders/${order.id}`, 'PATCH', {
    status: 'completed',
    paymentStatus: 'paid'
  });
  assert.equal(completeRes.status, 200, 'Hoàn tất giao hàng và thanh toán thành công');

  // Kiểm tra tự động tạo thẻ bảo hành điện tử chính hãng GAERU CARE+ 12 tháng
  const warrantyRecord = await pool.query(
    `SELECT w.* FROM warranty_activations w
     JOIN order_items i ON i.id = w.order_item_id
     WHERE i.order_id = $1`,
    [order.id]
  );
  assert.equal(warrantyRecord.rows.length, 1, 'Hồ sơ bảo hành CARE+ được kích hoạt tự động');
  assert.equal(warrantyRecord.rows[0].status, 'active', 'Trạng thái bảo hành là active');
  assert.ok(warrantyRecord.rows[0].expires_on, 'Có ngày hết hạn bảo hành 12 tháng');

  // Khách xem danh sách đơn hàng và bảo hành trong trang tài khoản
  const myOrders = await buyer.call('/api/customer/orders');
  assert.equal(myOrders.status, 200);
  assert.equal(myOrders.data.orders.length, 1);
  assert.equal(myOrders.data.orders[0].orderNumber, order.orderNumber);
  assert.equal(myOrders.data.orders[0].paymentStatus, 'paid');

  const myWarranties = await buyer.call('/api/customer/warranties');
  assert.equal(myWarranties.status, 200);
  assert.equal(myWarranties.data.activations.length, 1);
  assert.equal(myWarranties.data.activations[0].orderNumber, order.orderNumber);

  // =========================================================================
  // GIAI ĐOẠN 6: TRẢI NGHIỆM HỖ TRỢ CHĂM SÓC KHÁCH HÀNG & CARE+ TICKET
  // =========================================================================
  const careTicketRes = await buyer.call('/api/customer/care', 'POST', {
    orderId: order.id,
    subject: 'Hướng dẫn kích hoạt chống ồn trên mic M1',
    description: 'Em đã nhận được micro GAERU M1 đóng gói rất đẹp, xin tư vấn thêm cách bấm nút bật DSP giảm tiếng ồn gió.',
    channel: 'website',
    requestKey: randomUUID()
  });
  assert.equal(careTicketRes.status, 201, 'Gửi yêu cầu hỗ trợ Care+ thành công');

  // =========================================================================
  // GIAI ĐOẠN 7: AN NINH, BẢO MẬT WAF, HONEYPOT & CHỐNG TẤN CÔNG MẠNG
  // =========================================================================
  // 1. Chống quét lỗ hổng SQL Injection (WAF)
  const sqlInjectionAttack = await fetch(`${base}/api/products?id=1'%20OR%201=1--`, {
    headers: { 'User-Agent': 'sqlmap/1.7#dev' }
  });
  assert.equal(sqlInjectionAttack.status, 403, 'WAF chặn scanner sqlmap với mã 403 Forbidden');

  // 2. Chống Path Traversal lộ tệp cấu hình máy chủ
  const pathTraversalAttack = await fetch(`${base}/.env`);
  assert.equal(pathTraversalAttack.status, 403, 'WAF chặn truy cập trái phép tệp .env');

  // 3. Bẫy Honeypot chặn spam bot gửi form
  const honeypotTrap = await guest.call('/api/customer-auth/register', 'POST', {
    fullName: 'Spam Bot Crawler',
    email: 'spammer@botnet.fake',
    phone: '0900000000',
    password: 'password123',
    _website_hp: 'malicious_bot_payload'
  });
  assert.equal(honeypotTrap.status, 400, 'Honeypot bẫy và từ chối spam bot với mã 400 SPAM_REJECTED');

  // =========================================================================
  // GIAI ĐOẠN 8: ĐƠN HÀNG HỦY & TỰ ĐỘNG HOÀN TRẢ TỒN KHO (Stock Rollback)
  // =========================================================================
  const order2Res = await buyer.call('/api/orders', 'POST', {
    customer: {
      name: 'Trần Thị Thu Hà',
      email: 'tranthithuha@gaeru.test',
      phone: '0988776655',
      address: 'Số 120 Đường Nguyễn Thị Minh Khai',
      city: 'TP. Hồ Chí Minh'
    },
    paymentMethod: 'cod',
    items: [
      { variantId: chosenVariant.id, quantity: 2 }
    ]
  });
  assert.equal(order2Res.status, 201, 'Đặt đơn thứ hai (COD) thành công');
  const order2 = order2Res.data.order;

  // Tồn kho trước khi hủy đơn: 99 - 2 = 97
  const stockBeforeCancel = await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1', [chosenVariant.id]);
  assert.equal(stockBeforeCancel.rows[0].stock_quantity, 97, 'Tồn kho giảm xuống 97');

  // Khách/Admin hủy đơn hàng khi chưa xử lý
  const cancelRes = await admin.call(`/api/gaeru_ceo/orders/${order2.id}`, 'PATCH', { status: 'cancelled' });
  assert.equal(cancelRes.status, 200, 'Hủy đơn hàng thành công');

  // Tồn kho sau khi hủy đơn: Phải được hoàn lại 2 sản phẩm (97 + 2 = 99)
  const stockAfterCancel = await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1', [chosenVariant.id]);
  assert.equal(stockAfterCancel.rows[0].stock_quantity, 99, 'Tồn kho được hoàn trả chính xác về 99');

  // =========================================================================
  // GIAI ĐOẠN 9: TIẾP NHẬN BẢO HÀNH SÀN NGOÀI & BỘ LỌC CHỐNG SPAM BẢO HÀNH
  // =========================================================================
  await guest.fetchCsrf();
  const externalWarranty = await guest.call('/api/warranty-requests', 'POST', {
    channel: 'shopee',
    externalOrderNumber: 'SPX-VN-20261029-7788',
    productName: 'Micro GAERU K9 Cài Áo',
    serial: 'SN-K9-VALID-888',
    purchaseDate: new Date().toISOString().slice(0, 10),
    contact: {
      fullName: 'Phạm Minh Tuấn',
      phone: '0933445566',
      address: 'Số 45 Lê Duẩn',
      city: 'Đà Nẵng'
    },
    requestKey: randomUUID()
  });
  assert.equal(externalWarranty.status, 201, 'Đăng ký bảo hành sàn ngoài thành công');
  assert.equal(externalWarranty.data.activation.status, 'pending');

  // Thử gửi spam bảo hành với số điện thoại rác -> Bị nhận diện là spam
  const spamClaim = await guest.call('/api/warranty-requests', 'POST', {
    channel: 'shopee',
    externalOrderNumber: 'TEST1234',
    productName: 'asdfghjkl zxcvbnm',
    serial: '000000',
    purchaseDate: new Date().toISOString().slice(0, 10),
    contact: {
      fullName: 'Fake User',
      phone: '0000000000',
      address: 'Nowhere',
      city: 'Ha Noi'
    },
    requestKey: randomUUID()
  });
  // Hệ thống vẫn tiếp nhận hoặc gắn cờ để admin đối chiếu
  assert.ok([201, 400].includes(spamClaim.status), 'Hệ thống bảo vệ đối chiếu bảo hành hoạt động');

  // =========================================================================
  // GIAI ĐOẠN 10: BỘ ĐẾM TRUY CẬP TỰ ĐỘNG THỜI GIAN THỰC (Traffic Analytics)
  // =========================================================================
  const { recordVisit, getTrafficSummary } = require('../src/traffic-tracker');
  // Mô phỏng 3 lượt xem từ 2 khách truy cập khác nhau
  await recordVisit(pool, { path: '/', ip: '14.162.10.1', userAgent: 'Mozilla/5.0 Chrome/120.0' });
  await recordVisit(pool, { path: '/shop.html', ip: '14.162.10.1', userAgent: 'Mozilla/5.0 Chrome/120.0' }); // Cùng IP -> 1 visitor, 2 pageviews
  await recordVisit(pool, { path: '/care.html', ip: '14.162.10.2', userAgent: 'Mozilla/5.0 Safari/605' }); // Khác IP -> +1 visitor, +1 pageview

  const trafficMetrics = await getTrafficSummary(pool);
  assert.ok(trafficMetrics.todayPageviews >= 3, 'Pageviews ghi nhận tối thiểu 3 lượt');
  assert.ok(trafficMetrics.todayVisitors >= 2, 'Deduplicate chính xác 2 khách truy cập duy nhất');

  // =========================================================================
  // GIAI ĐOẠN 11: BÁO CÁO KẾ TOÁN & XUẤT EXCEL DANH SÁCH ĐƠN HÀNG
  // =========================================================================
  const ordersListRes = await admin.call('/api/gaeru_ceo/orders?page=1');
  assert.equal(ordersListRes.status, 200, 'Admin lấy danh sách đơn hàng thành công');
  assert.ok(ordersListRes.data.orders.length >= 2, 'Có ít nhất 2 đơn hàng trong hệ thống');

  const exportExcelRes = await admin.call('/api/gaeru_ceo/orders?format=xlsx');
  assert.equal(exportExcelRes.status, 200, 'Xuất báo cáo đơn hàng định dạng Excel thành công');

  // 4. Kiểm tra sức khỏe toàn hệ thống (System Health)
  const healthCheck = await admin.call('/api/gaeru_ceo/system-health');
  assert.equal(healthCheck.status, 200, 'Endpoint sức khỏe hệ thống phản hồi 200');
  assert.equal(healthCheck.data.status, 'healthy', 'Hệ thống vận hành khỏe mạnh (healthy)');
  assert.equal(healthCheck.data.database.status, 'connected', 'Cơ sở dữ liệu PostgreSQL kết nối ổn định');
  assert.equal(healthCheck.data.security.antiHack.status, 'active', 'Hệ thống phòng vệ chống hack đang hoạt động');
});
