const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');
const { createLocalPool } = require('../src/local-server');
const { migrateDatabase } = require('../src/migrate');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

test('Verification: Complete Removal of Manual COD Reconciliation UI & Seamless Auto-Completion', async (t) => {
  // 1. Kiểm tra tĩnh trên tệp admin/index.html & admin/admin.js: chức năng đối soát thủ công bị xóa hoàn toàn
  const indexHtml = fs.readFileSync(path.join(__dirname, '../admin/index.html'), 'utf8');
  assert.equal(indexHtml.includes('id="cod-settlement-panel"'), false, 'Panel đối soát lô COD thủ công đã bị xóa hoàn toàn');
  assert.equal(indexHtml.includes('id="cod-settlement-toggle"'), false, 'Nút "Đối soát thu hộ COD" đã bị xóa hoàn toàn');

  const adminJs = fs.readFileSync(path.join(__dirname, '../admin/admin.js'), 'utf8');
  assert.equal(adminJs.includes('Đối soát COD theo lô'), false, 'Nút "Đối soát COD theo lô" đã được gỡ bỏ khỏi renderOrderWaybillCard trong admin/admin.js');
  assert.equal(adminJs.includes('name="reconciliationRef"'), false, 'Ô nhập mã đối soát COD (reconciliationRef) đã được gỡ bỏ khỏi orderPaymentControl trong admin/admin.js');
  assert.equal(adminJs.includes('loadCodSettlementWorkspace'), false, 'Hàm loadCodSettlementWorkspace đã bị xóa hoàn toàn khỏi admin/admin.js');

  // 2. Kiểm tra nghiệp vụ Runtime: Đơn COD có vận đơn Viettel Post được hoàn tất và thanh toán trơn tru
  const pool = await createLocalPool();
  await migrateDatabase(pool);

  const client = await pool.connect();
  let orderId;
  try {
    const p = (await client.query("INSERT INTO products (name, slug, category, active) VALUES ('Test Item', 'test-item', 'audio', true) RETURNING id")).rows[0];
    await client.query("INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'SKU-02', 'V2', 202300, 10, true)", [p.id]);

    const ord = (await client.query(`
      INSERT INTO orders (
        order_number, customer_name, email, phone, address, city,
        subtotal_vnd, shipping_fee_vnd, total_vnd, payment_method, payment_status, status, delivered_at
      ) VALUES (
        'GR-20261106-AB67EA7050', 'Đỗ Thiện', 'dothien@example.com', '0912345678', 'Hà Nội', 'Hà Nội',
        202300, 0, 202300, 'cod', 'pending', 'shipped', now()
      ) RETURNING id
    `)).rows[0];
    orderId = ord.id;

    await client.query(`
      INSERT INTO carrier_shipments (
        order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status
      ) VALUES (
        $1, 'viettel', '156668075672', 'delivered', 202300, 'unsettled'
      )
    `, [orderId]);
  } finally {
    client.release();
  }

  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-secret-32-chars-long-enough-ok',
    DATABASE_URL: 'local-pglite',
    ADMIN_USERNAME: 'gaeru',
    ADMIN_PASSWORD_HASH: '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'
  });

  const app = createApp({
    config,
    pool,
    sessionStore: new session.MemoryStore(),
    customerMailer: { sendMail: async () => ({}) }
  });

  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(r => server.close(r)));
  t.after(() => pool.end());
  await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Lấy CSRF & Đăng nhập Owner
  const csrfRes = await fetch(`${baseUrl}/api/csrf`);
  const csrfCookies = csrfRes.headers.getSetCookie ? csrfRes.headers.getSetCookie() : [csrfRes.headers.get('set-cookie')];
  const { csrfToken } = await csrfRes.json();
  const initCookie = csrfCookies.map(c => c.split(';')[0]).join('; ');

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken, cookie: initCookie },
    body: JSON.stringify({ username: 'gaeru', password: 'password' })
  });
  assert.equal(loginRes.status, 200);
  const authCookie = (loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')]).map(c => c.split(';')[0]).join('; ');
  const authJson = await loginRes.json();

  // Mô phỏng chính xác thao tác trong Ảnh 1 của người dùng:
  // Quản trị viên lưu cập nhật đơn hàng thành "Đã thanh toán" (hoàn tất đơn hàng COD)
  const patchRes = await fetch(`${baseUrl}/api/gaeru_ceo/orders/${orderId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': authJson.csrfToken,
      cookie: authCookie
    },
    body: JSON.stringify({
      status: 'completed',
      paymentStatus: 'paid',
      confirmReceived: true
    })
  });

  const patchBody = await patchRes.json();
  assert.equal(patchRes.status, 409, 'Giao thành công không chứng minh hãng đã chuyển tiền: ' + JSON.stringify(patchBody));
  const settlement = await fetch(`${baseUrl}/api/gaeru_ceo/shipping/orders/${orderId}/settle-cod`, {
    method:'POST',
    headers:{'Content-Type':'application/json','x-csrf-token':authJson.csrfToken,cookie:authCookie},
    body:JSON.stringify({providerTransactionRef:'VTP-REAL-PAYOUT-20261108',settledAmountVnd:202300})
  });
  assert.equal(settlement.status,200,'Chỉ xác nhận tiền COD bằng mã giao dịch thực');

  // Kiểm tra CSDL
  const finalOrder = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [orderId])).rows[0];
  assert.equal(finalOrder.status, 'completed');
  assert.equal(finalOrder.payment_status, 'paid');

  const finalShipment = (await pool.query('SELECT cod_settlement_status, cod_settlement_ref FROM carrier_shipments WHERE order_id = $1', [orderId])).rows[0];
  assert.equal(finalShipment.cod_settlement_status, 'settled');
  assert.equal(finalShipment.cod_settlement_ref,'VTP-REAL-PAYOUT-20261108');

  const receipt = (await pool.query('SELECT * FROM sales_receipts WHERE order_id = $1', [orderId])).rows[0];
  assert.ok(receipt, 'Phiếu thu kế toán tự động được ghi nhận đầy đủ');
  assert.equal(Number(receipt.amount_vnd), 202300);
});
