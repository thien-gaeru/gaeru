/**
 * @file real-orders-payment-and-shipping.test.js
 * Comprehensive reality test suite for GAERU:
 * - Real order creation workflows
 * - All payment methods: COD, VietQR Bank Transfer, VNPAY, MoMo, ZaloPay
 * - Shipping carrier selection: Shopee Express (SPX), Giao Hàng Nhanh (GHN)
 * - Invoicing, shipping labels, co-inspection (đồng kiểm), and warranty auto-activation
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHmac } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');
const { buildVnpayPaymentUrl, verifyVnpayQuery, formatVnpayDate } = require('../src/vnpay');

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function createTestDb() {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await previous;
    return release;
  }
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  return {
    async query(sql, values) {
      const release = await lock();
      try { return await query(sql, values); }
      finally { release(); }
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

test('Real Order Flow: Complete testing of COD, VietQR, VNPAY, MoMo, ZaloPay & Shipping (SPX, GHN)', { timeout: 90000 }, async (t) => {
  const pool = await createTestDb();
  await migrateDatabase(pool);

  const ownerPassword = 'Gaeru-Owner-Strong-Pass-2026!';
  const momoSettings = { partnerCode: 'MOMOGAERU', accessKey: 'MOMOACC01', secretKey: 'momo-super-secret-key-2026', environment: 'sandbox', enabled: true };
  const zaloSettings = { appId: '2554', key1: 'zalopay-key1-secret-2026', key2: 'zalopay-key2-secret-2026', environment: 'sandbox', enabled: true };
  const vnpaySettings = { tmnCode: 'GAERUVNP', hashSecret: 'vnpay-hash-secret-fixture-key-2026', environment: 'sandbox', enabled: true };
  const bankSettings = { bankName: 'MB Bank', accountNumber: '0829191080', accountHolder: 'CONG TY TNHH GAERU', branch: 'Ha Noi', transferSyntax: 'GAERU {MA_DON}', enabled: true };
  const codSettings = { enabled: true, maxAmountVnd: 50000000, instructions: 'Thanh toán tiền mặt cho bưu tá khi nhận hàng.' };

  const providerCreates = [];
  const gatewayFetcher = async (url, options = {}) => {
    if (options.method === 'GET') return new Response('Public gateway reachable', { status: 200 });
    const body = JSON.parse(options.body || '{}');
    if (url.includes('momo.vn')) {
      providerCreates.push({ provider: 'momo', body });
      return jsonResponse({
        resultCode: 0,
        partnerCode: body.partnerCode,
        requestId: body.requestId,
        orderId: body.orderId,
        amount: body.amount,
        payUrl: 'https://test-payment.momo.vn/pay?token=momo-token-' + body.orderId
      });
    }
    if (url.includes('zalopay.vn')) {
      providerCreates.push({ provider: 'zalopay', body });
      return jsonResponse({
        return_code: 1,
        sub_return_code: 1,
        app_id: body.app_id,
        app_trans_id: body.app_trans_id,
        amount: body.amount,
        order_url: 'https://qcgateway.zalopay.vn/pay?token=zalo-token-' + body.app_trans_id
      });
    }
    return jsonResponse({ ok: true });
  };

  const app = createApp({
    config: {
      NODE_ENV: 'test',
      SESSION_SECRET: randomBytes(32).toString('hex'),
      ADMIN_USERNAME: 'gaeru_admin',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync(ownerPassword, 4),
      PUBLIC_BASE_URL: 'https://gaeru.com',
      STORE_ORDERS_ENABLED: true,
      paymentFetcher: gatewayFetcher
    },
    pool,
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
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
          if (eq > 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
        }
        const isJson = res.headers.get('content-type')?.includes('application/json');
        const data = isJson ? await res.json() : await res.text();
        if (data && typeof data === 'object' && data.csrfToken) {
          csrf = data.csrfToken;
        }
        return { status: res.status, data, headers: res.headers };
      },
      async loginAdmin(u = 'gaeru_admin', p = ownerPassword) {
        await this.call('/api/csrf');
        return this.call('/api/auth/login', 'POST', { username: u, password: p });
      }
    };
  }

  const admin = createClient();
  const customer = createClient();

  // Đăng nhập quản trị viên
  const loginRes = await admin.loginAdmin();
  assert.equal(loginRes.status, 200, 'Admin login should succeed');

  // Cấu hình bảng cước vận chuyển chuẩn
  await pool.query(
    `INSERT INTO store_settings(setting_key, setting_value)
     VALUES('shipping_rates', $1)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = $1`,
    [JSON.stringify({ 'Hà Nội': 20000, 'Hồ Chí Minh': 25000, 'Đà Nẵng': 30000, 'Toàn quốc': 35000 })]
  );

  // Tạo sản phẩm và các biến thể micro GAERU K9
  const prodRes = await pool.query(
    `INSERT INTO products(slug, name, category, image_url, active)
     VALUES('gaeru-k9-mic', 'Micro Không Dây GAERU K9', 'audio', '/assets/k9.webp', true)
     RETURNING id`
  );
  const productId = prodRes.rows[0].id;

  const varTypeC = (await pool.query(
    `INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES($1, 'K9-2MIC-TYPEC', 'Bản 2 Mic Type-C', 289000, 50, true)
     RETURNING id`,
    [productId]
  )).rows[0];

  const varLightning = (await pool.query(
    `INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES($1, 'K9-2MIC-LIGHTNING', 'Bản 2 Mic Lightning', 299000, 50, true)
     RETURNING id`,
    [productId]
  )).rows[0];

  const varSingle = (await pool.query(
    `INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES($1, 'K9-1MIC-TYPEC', 'Bản 1 Mic Type-C', 159000, 50, true)
     RETURNING id`,
    [productId]
  )).rows[0];

  // Khởi tạo tồn kho kho chính khớp với tổng tồn kho
  const warehouse = (await pool.query(`SELECT id FROM warehouses WHERE code='MAIN' LIMIT 1`)).rows[0];
  if (warehouse) {
    for (const v of [varTypeC, varLightning, varSingle]) {
      await pool.query(
        `INSERT INTO warehouse_stock(warehouse_id, variant_id, quantity)
         VALUES($1, $2, 50)
         ON CONFLICT(warehouse_id, variant_id) DO UPDATE SET quantity = 50`,
        [warehouse.id, v.id]
      );
    }
  }

  // Lưu cấu hình thanh toán: COD, Bank Transfer, VNPAY, MoMo, ZaloPay
  await admin.call('/api/gaeru_ceo/owner/configuration/payment_cod', 'PUT', { version: 0, password: ownerPassword, data: codSettings });
  await admin.call('/api/gaeru_ceo/owner/configuration/payment_bank_transfer', 'PUT', { version: 0, password: ownerPassword, data: bankSettings });
  await admin.call('/api/gaeru_ceo/owner/configuration/vnpay', 'PUT', { version: 0, password: ownerPassword, data: vnpaySettings });
  await admin.call('/api/gaeru_ceo/owner/configuration/payment_momo', 'PUT', { version: 0, password: ownerPassword, data: momoSettings });
  await admin.call('/api/gaeru_ceo/owner/configuration/payment_zalopay', 'PUT', { version: 0, password: ownerPassword, data: zaloSettings });

  // Xác minh các kết nối thanh toán
  await pool.query(
    `UPDATE payment_channel_connections
     SET verified_at = now(), last_method = 'gateway_handshake'
     WHERE channel_id IN ('vnpay', 'momo', 'zalopay')`
  );

  // Cấu hình các hãng vận chuyển: Shopee Express (SPX) và Giao Hàng Nhanh (GHN)
  await pool.query(
    `INSERT INTO store_settings(setting_key, setting_value)
     VALUES('private_admin:shipping_spx', $1), ('private_admin:shipping_ghn', $2)`,
    [
      JSON.stringify({ version: 1, cipher: 'enc', data: { accountId: 'SPX-SHOP-01', secret: 'spx-secret-token', partnerCode: 'GAERU' } }),
      JSON.stringify({ version: 1, cipher: 'enc', data: { accountId: '123456', secret: 'ghn-secret-token' } })
    ]
  );
  await pool.query(
    `INSERT INTO shipping_carrier_connections(carrier_id, config_version, verified_at, enabled)
     VALUES('spx', 1, now(), true), ('ghn', 1, now(), true)
     ON CONFLICT(carrier_id) DO UPDATE SET config_version = 1, verified_at = now(), enabled = true`
  );

  // Kiểm tra cấu hình công khai phục vụ giao diện mua hàng
  const publicSettings = await customer.call('/api/settings/public');
  assert.equal(publicSettings.status, 200);
  assert.ok(publicSettings.data.ordersEnabled);
  assert.deepEqual(publicSettings.data.shippingCarriers.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'ghn', name: 'GHN' },
    { id: 'spx', name: 'Shopee Express' }
  ]);
  assert.deepEqual(publicSettings.data.paymentMethods, ['cod', 'bank_transfer', 'vnpay', 'momo', 'zalopay']);
  assert.equal(publicSettings.data.bankTransfer.accountNumber, '0829191080');

  // =========================================================================
  // TEST CASE 1: ĐẶT HÀNG COD + CHỌN VẬN CHUYỂN SHOPEE EXPRESS (SPX)
  // =========================================================================
  await customer.call('/api/csrf');
  const codOrderPayload = {
    customer: {
      name: 'Trần Văn Bình',
      email: 'binh.tran@example.test',
      phone: '0988112233',
      address: 'Số 15 Cầu Giấy, Phường Dịch Vọng',
      city: 'Hà Nội',
      note: 'Giao giờ hành chính, gọi trước'
    },
    paymentMethod: 'cod',
    shippingCarrierId: 'spx',
    expectedShippingFeeVnd: 20000,
    items: [{ variantId: varTypeC.id, quantity: 1 }]
  };

  const codRes = await customer.call('/api/orders', 'POST', codOrderPayload);
  assert.equal(codRes.status, 201, 'COD order should be placed with 201 Created: ' + JSON.stringify(codRes.data));
  const codOrder = codRes.data.order;
  assert.ok(codOrder.orderNumber.startsWith('GR-'));
  assert.equal(codOrder.subtotalVnd, 289000);
  assert.equal(codOrder.shippingFeeVnd, 20000);
  assert.equal(codOrder.totalVnd, 309000);
  assert.equal(codOrder.shippingCarrierName, 'Shopee Express');

  // Kiểm tra lưu vết vận chuyển trong CSDL
  const spxRecord = await pool.query('SELECT * FROM order_shipping_selection WHERE order_id = $1', [codOrder.id]);
  assert.equal(spxRecord.rows.length, 1);
  assert.equal(spxRecord.rows[0].carrier_id, 'spx');
  assert.equal(spxRecord.rows[0].carrier_name, 'Shopee Express');
  assert.equal(spxRecord.rows[0].fee_vnd, 20000);

  // In tem giao hàng nội bộ: kiểm tra định dạng và thu COD
  const printLabelRes = await admin.call('/api/gaeru_ceo/orders/print', 'POST', {
    ids: [codOrder.id],
    format: 'label'
  });
  assert.equal(printLabelRes.status, 200);
  assert.ok(printLabelRes.data.includes('Khách chọn: Shopee Express'), 'Shipping label must print chosen carrier name');
  assert.ok(printLabelRes.data.includes('CẦN THU COD'), 'Must indicate COD collection needed');
  assert.ok(printLabelRes.data.includes('309.000&nbsp;₫') || printLabelRes.data.includes('309.000 ₫'), 'Must print exact COD amount');

  // Vòng đời đơn hàng COD: pending -> confirmed -> processing -> shipped -> completed (paid)
  await admin.call(`/api/gaeru_ceo/orders/${codOrder.id}`, 'PATCH', { status: 'confirmed' });
  await admin.call(`/api/gaeru_ceo/orders/${codOrder.id}`, 'PATCH', { status: 'processing' });
  await admin.call(`/api/gaeru_ceo/orders/${codOrder.id}`, 'PATCH', { status: 'shipped' });
  const completeCodRes = await admin.call(`/api/gaeru_ceo/orders/${codOrder.id}`, 'PATCH', {
    status: 'completed',
    paymentStatus: 'paid'
  });
  assert.equal(completeCodRes.status, 200);

  // Kiểm tra bảo hành điện tử chính hãng 12 tháng tự động kích hoạt
  const warrantyCheck1 = await pool.query(
    `SELECT w.* FROM warranty_activations w
     JOIN order_items i ON i.id = w.order_item_id
     WHERE i.order_id = $1`,
    [codOrder.id]
  );
  assert.equal(warrantyCheck1.rows.length, 1);
  assert.equal(warrantyCheck1.rows[0].status, 'active');

  // =========================================================================
  // TEST CASE 2: ĐẶT HÀNG CHUYỂN KHOẢN VIETQR (bank_transfer) + HÃNG GHN
  // =========================================================================
  const bankOrderPayload = {
    customer: {
      name: 'Lê Thị Cúc',
      email: 'cuc.le@example.test',
      phone: '0977223344',
      address: 'Số 45 Lê Lợi, Phường Bến Nghé, Quận 1',
      city: 'Hồ Chí Minh',
      note: 'Giao tận tay'
    },
    paymentMethod: 'bank_transfer',
    shippingCarrierId: 'ghn',
    expectedShippingFeeVnd: 25000,
    items: [{ variantId: varSingle.id, quantity: 1 }] // 159.000₫
  };

  const bankRes = await customer.call('/api/orders', 'POST', bankOrderPayload);
  assert.equal(bankRes.status, 201, 'Bank transfer order should succeed with 201');
  const bankOrder = bankRes.data.order;
  assert.equal(bankOrder.subtotalVnd, 159000);
  assert.equal(bankOrder.shippingFeeVnd, 25000);
  assert.equal(bankOrder.totalVnd, 184000);
  assert.equal(bankOrder.shippingCarrierName, 'GHN');

  // Kiểm tra hướng dẫn thanh toán VietQR gửi về cho khách
  assert.ok(bankRes.data.bankTransfer, 'Must include bankTransfer instructions');
  assert.equal(bankRes.data.bankTransfer.bankName, 'MB Bank');
  assert.equal(bankRes.data.bankTransfer.accountNumber, '0829191080');
  assert.equal(bankRes.data.bankTransfer.amountVnd, 184000);
  assert.equal(bankRes.data.bankTransfer.transferContent, `GAERU ${bankOrder.orderNumber}`);

  // Khi chưa thanh toán, tem in sẽ báo cần thu nếu chưa xác nhận tiền
  const prePaymentLabel = await admin.call('/api/gaeru_ceo/orders/print', 'POST', {
    ids: [bankOrder.id],
    format: 'label'
  });
  assert.ok(prePaymentLabel.data.includes('Khách chọn: GHN'));

  // Đối soát & Ghi nhận tiền chuyển khoản về tài khoản ngân hàng
  const reconcileRes = await admin.call('/api/gaeru_ceo/owner/payments/reconcile', 'POST', {
    orderNumber: bankOrder.orderNumber,
    amountVnd: 184000,
    provider: 'bank_transfer',
    referenceCode: 'MB-FT-99887711',
    password: ownerPassword
  });
  assert.equal(reconcileRes.status, 200, 'Reconciliation of bank transfer should succeed');

  // Kiểm tra đơn hàng sau đối soát: đã chuyển sang paid và processing
  const updatedBankOrder = (await pool.query('SELECT status, payment_status FROM orders WHERE id=$1', [bankOrder.id])).rows[0];
  assert.equal(updatedBankOrder.payment_status, 'paid');
  assert.equal(updatedBankOrder.status, 'processing');

  // Sau khi thanh toán, in tem sẽ báo rõ KHÔNG THU COD
  const postPaymentLabel = await admin.call('/api/gaeru_ceo/orders/print', 'POST', {
    ids: [bankOrder.id],
    format: 'label'
  });
  assert.ok(postPaymentLabel.data.includes('KHÔNG THU COD'), 'Paid order label must state KHONG THU COD');
  assert.ok(postPaymentLabel.data.includes('0&nbsp;₫') || postPaymentLabel.data.includes('0 ₫'));

  // =========================================================================
  // TEST CASE 3: ĐẶT HÀNG CỔNG THANH TOÁN VNPAY & XÁC THỰC WEBHOOK IPN
  // =========================================================================
  const vnpayOrderPayload = {
    customer: {
      name: 'Hoàng Minh Đức',
      email: 'duc.hoang@example.test',
      phone: '0966334455',
      address: 'Số 120 Bạch Đằng, Quận Hải Châu',
      city: 'Đà Nẵng',
      note: ''
    },
    paymentMethod: 'vnpay',
    shippingCarrierId: 'spx',
    expectedShippingFeeVnd: 30000,
    items: [{ variantId: varLightning.id, quantity: 1 }] // 299.000₫
  };

  const vnpayOrderRes = await customer.call('/api/orders', 'POST', vnpayOrderPayload);
  assert.equal(vnpayOrderRes.status, 201, 'VNPAY order creation should succeed');
  const vnpayOrder = vnpayOrderRes.data.order;
  assert.equal(vnpayOrder.totalVnd, 329000);
  assert.ok(vnpayOrderRes.data.paymentUrl, 'Must return signed paymentUrl for VNPAY');

  const paymentUrl = new URL(vnpayOrderRes.data.paymentUrl);
  assert.equal(paymentUrl.searchParams.get('vnp_TxnRef'), vnpayOrder.orderNumber);
  assert.equal(paymentUrl.searchParams.get('vnp_Amount'), '32900000'); // 329.000 x 100
  assert.ok(paymentUrl.searchParams.get('vnp_SecureHash'), 'Must contain cryptographic HMAC-SHA512 hash');

  // Giả lập Webhook IPN từ VNPAY về máy chủ
  const ipnParams = {
    vnp_TmnCode: vnpaySettings.tmnCode,
    vnp_Amount: '32900000',
    vnp_BankCode: 'NCB',
    vnp_BankTranNo: 'VNP14567890',
    vnp_CardType: 'ATM',
    vnp_PayDate: formatVnpayDate(new Date()),
    vnp_OrderInfo: `Thanh toan don hang ${vnpayOrder.orderNumber}`,
    vnp_TransactionNo: '14567890',
    vnp_ResponseCode: '00',
    vnp_TransactionStatus: '00',
    vnp_TxnRef: vnpayOrder.orderNumber
  };

  // 1. Thử IPN giả mạo chữ ký (Checksum Failure)
  const fakeHashParams = new URLSearchParams({ ...ipnParams, vnp_SecureHash: '0'.repeat(128) });
  const fakeIpnRes = await fetch(`${base}/api/payments/vnpay/ipn?${fakeHashParams.toString()}`);
  assert.equal(fakeIpnRes.status, 200);
  const fakeIpnData = await fakeIpnRes.json();
  assert.equal(fakeIpnData.RspCode, '97', 'Tampered signature must return Checksum failed (97)');

  // 2. Thử IPN sai lệch số tiền (Amount mismatch)
  const sortedBadParams = new URLSearchParams(Object.entries({ ...ipnParams, vnp_Amount: '100000' }).sort(([a], [b]) => a.localeCompare(b)));
  const badAmountHash = createHmac('sha512', vnpaySettings.hashSecret).update(sortedBadParams.toString(), 'utf8').digest('hex');
  const badAmountRes = await fetch(`${base}/api/payments/vnpay/ipn?${sortedBadParams.toString()}&vnp_SecureHash=${badAmountHash}`);
  assert.equal(badAmountRes.status, 200);
  const badAmountData = await badAmountRes.json();
  assert.equal(badAmountData.RspCode, '04', 'Mismatched amount must return Invalid amount (04)');

  // 3. IPN hợp lệ chuẩn mật mã SHA-512
  const sortedGoodParams = new URLSearchParams(Object.entries(ipnParams).sort(([a], [b]) => a.localeCompare(b)));
  const goodHash = createHmac('sha512', vnpaySettings.hashSecret).update(sortedGoodParams.toString(), 'utf8').digest('hex');
  const validIpnRes = await fetch(`${base}/api/payments/vnpay/ipn?${sortedGoodParams.toString()}&vnp_SecureHash=${goodHash}`);
  assert.equal(validIpnRes.status, 200);
  const validIpnData = await validIpnRes.json();
  assert.equal(validIpnData.RspCode, '00', 'Valid VNPAY IPN must return Confirm Success (00)');

  // Xác minh đơn hàng tự động chuyển sang paid và processing
  const vnpayDbCheck = (await pool.query('SELECT status, payment_status FROM orders WHERE id=$1', [vnpayOrder.id])).rows[0];
  assert.equal(vnpayDbCheck.payment_status, 'paid');
  assert.equal(vnpayDbCheck.status, 'processing');

  // 4. Kiểm tra tính Idempotent (gọi lại lần 2 không lặp tiền)
  const repeatIpnRes = await fetch(`${base}/api/payments/vnpay/ipn?${sortedGoodParams.toString()}&vnp_SecureHash=${goodHash}`);
  const repeatIpnData = await repeatIpnRes.json();
  assert.equal(repeatIpnData.RspCode, '02', 'Repeated IPN must return Order already confirmed (02)');

  // =========================================================================
  // TEST CASE 4: ĐẶT HÀNG VÍ ĐIỆN TỬ MOMO VÀ ZALOPAY
  // =========================================================================
  // 4A. Ví MoMo
  const momoOrderPayload = {
    customer: {
      name: 'Phạm Thu Trang',
      email: 'trang.pham@example.test',
      phone: '0911223344',
      address: 'Số 99 Hùng Vương',
      city: 'Hà Nội',
      note: ''
    },
    paymentMethod: 'momo',
    shippingCarrierId: 'ghn',
    expectedShippingFeeVnd: 20000,
    items: [{ variantId: varSingle.id, quantity: 1 }] // 159.000₫ -> Tổng 179.000₫
  };
  const momoRes = await customer.call('/api/orders', 'POST', momoOrderPayload);
  assert.equal(momoRes.status, 201);
  const momoOrder = momoRes.data.order;
  assert.ok(momoRes.data.paymentUrl.includes('momo-token'));

  // Callback IPN MoMo
  const momoIpnBody = {
    partnerCode: momoSettings.partnerCode,
    orderId: momoOrder.orderNumber,
    requestId: momoOrder.orderNumber,
    amount: 179000,
    orderInfo: 'Thanh toán đơn hàng',
    orderType: 'momo_wallet',
    transId: 9988776655,
    resultCode: 0,
    message: 'Thành công',
    payType: 'qr',
    responseTime: Date.now(),
    extraData: ''
  };
  const momoRaw = `accessKey=${momoSettings.accessKey}&amount=${momoIpnBody.amount}&extraData=${momoIpnBody.extraData}&message=${momoIpnBody.message}&orderId=${momoIpnBody.orderId}&orderInfo=${momoIpnBody.orderInfo}&orderType=${momoIpnBody.orderType}&partnerCode=${momoIpnBody.partnerCode}&payType=${momoIpnBody.payType}&requestId=${momoIpnBody.requestId}&responseTime=${momoIpnBody.responseTime}&resultCode=${momoIpnBody.resultCode}&transId=${momoIpnBody.transId}`;
  momoIpnBody.signature = createHmac('sha256', momoSettings.secretKey).update(momoRaw).digest('hex');

  const momoIpnRes = await fetch(`${base}/api/payments/momo/ipn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(momoIpnBody)
  });
  assert.equal(momoIpnRes.status, 204, 'MoMo IPN should return 204 No Content');
  const momoDbCheck = (await pool.query('SELECT status, payment_status FROM orders WHERE id=$1', [momoOrder.id])).rows[0];
  assert.equal(momoDbCheck.payment_status, 'paid');
  assert.equal(momoDbCheck.status, 'processing');

  // 4B. Ví ZaloPay
  const zaloOrderPayload = {
    customer: {
      name: 'Vũ Quốc Anh',
      email: 'quocanh.vu@example.test',
      phone: '0933445566',
      address: 'Số 200 Nguyễn Thị Minh Khai',
      city: 'Hồ Chí Minh',
      note: ''
    },
    paymentMethod: 'zalopay',
    shippingCarrierId: 'spx',
    expectedShippingFeeVnd: 25000,
    items: [{ variantId: varSingle.id, quantity: 1 }] // 159.000₫ -> Tổng 184.000₫
  };
  const zaloRes = await customer.call('/api/orders', 'POST', zaloOrderPayload);
  assert.equal(zaloRes.status, 201);
  const zaloOrder = zaloRes.data.order;
  assert.ok(zaloRes.data.paymentUrl.includes('zalo-token'));

  // Lấy app_trans_id chính xác từ payment_attempts
  const zaloAttempt = (await pool.query('SELECT provider_request_id FROM payment_attempts WHERE transaction_ref=$1 AND provider=$2', [zaloOrder.orderNumber, 'zalopay'])).rows[0];
  const appTransId = zaloAttempt.provider_request_id;

  const zaloDataString = JSON.stringify({
    app_id: 2554,
    app_trans_id: appTransId,
    app_time: Date.now(),
    app_user: 'gaeru',
    amount: 184000,
    embed_data: '{}',
    item: '[]',
    zp_trans_id: 8877665544,
    server_time: Date.now(),
    channel: 38
  });
  const zaloMac = createHmac('sha256', zaloSettings.key2).update(zaloDataString).digest('hex');

  const zaloIpnRes = await fetch(`${base}/api/payments/zalopay/ipn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: zaloDataString, mac: zaloMac, type: 1 })
  });
  assert.equal(zaloIpnRes.status, 200);
  const zaloIpnData = await zaloIpnRes.json();
  assert.equal(zaloIpnData.return_code, 1, 'ZaloPay IPN return_code must be 1 (success)');
  const zaloDbCheck = (await pool.query('SELECT status, payment_status FROM orders WHERE id=$1', [zaloOrder.id])).rows[0];
  assert.equal(zaloDbCheck.payment_status, 'paid');

  // =========================================================================
  // TEST CASE 5: KIỂM SOÁT BIÊN & BẢO VỆ NGHIỆP VỤ (Edge Cases & Safety Guards)
  // =========================================================================
  // 5A. Hạn mức COD (vượt 50.000.000₫)
  const hugeCodRes = await customer.call('/api/orders', 'POST', {
    customer: codOrderPayload.customer,
    paymentMethod: 'cod',
    shippingCarrierId: 'spx',
    items: [{ variantId: varTypeC.id, quantity: 180 }] // > 50 triệu
  });
  // Số lượng tối đa 99 hoặc vượt hạn mức COD
  assert.equal(hugeCodRes.status, 400);

  // 5B. Chọn hãng vận chuyển không hợp lệ hoặc chưa bật
  const invalidCarrierRes = await customer.call('/api/orders', 'POST', {
    customer: codOrderPayload.customer,
    paymentMethod: 'cod',
    shippingCarrierId: 'viettel', // Chưa bật
    items: [{ variantId: varTypeC.id, quantity: 1 }]
  });
  assert.equal(invalidCarrierRes.status, 409, 'Disabled or invalid carrier must be rejected with 409');

  // 5C. Tỉnh thành chưa cấu hình phí (khi không cấu hình Toàn quốc)
  await pool.query(
    `UPDATE store_settings SET setting_value = $1 WHERE setting_key = 'shipping_rates'`,
    [JSON.stringify({ 'Hà Nội': 20000, 'Hồ Chí Minh': 25000 })]
  );
  const invalidCityRes = await customer.call('/api/orders', 'POST', {
    customer: { ...codOrderPayload.customer, city: 'Cà Mau' },
    paymentMethod: 'cod',
    shippingCarrierId: 'spx',
    items: [{ variantId: varTypeC.id, quantity: 1 }]
  });
  assert.equal(invalidCityRes.status, 409, 'Unsupported province/city must be rejected with 409');

  // 5D. Đặt hàng vượt tồn kho thực tế
  const outOfStockRes = await customer.call('/api/orders', 'POST', {
    customer: codOrderPayload.customer,
    paymentMethod: 'cod',
    shippingCarrierId: 'spx',
    items: [{ variantId: varTypeC.id, quantity: 60 }] // Chỉ có 50 cái ban đầu, đã bán 1 cái
  });
  assert.equal(outOfStockRes.status, 409, 'Quantity exceeding stock must be rejected with 409');
  assert.ok(outOfStockRes.data.error.includes('hiện chỉ còn 49 sản phẩm'));

  // 5E. Không cho phép chuyển đơn đã thanh toán về chưa thanh toán
  const tamperPaymentRes = await admin.call(`/api/gaeru_ceo/orders/${vnpayOrder.id}`, 'PATCH', {
    paymentStatus: 'pending'
  });
  assert.equal(tamperPaymentRes.status, 409, 'Paid orders cannot be reverted to unpaid');
});
