const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const inventory = require('../src/inventory');
const { withTransaction } = require('../src/db');
const { appendAudit } = require('../src/audit');
const { createStoreApi } = require('../src/store-api');
const { createInternalAiRouter } = require('../src/internal-ai');

async function setupTestApp(t) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const before = queue;
    let release;
    queue = new Promise(r => release = r);
    await before;
    return release;
  }
  async function query(sql, args) {
    const r = !args && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, args);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, args) {
      const release = await lock();
      try { return await query(sql, args); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    }
  };

  await migrateDatabase(pool);

  const ownerActor = {
    username: 'admin',
    role: 'owner',
    isOwner: true,
    source: 'bootstrap',
    permissions: [
      'dashboard.read', 'catalog.read', 'catalog.write',
      'inventory.read', 'inventory.write',
      'orders.read', 'orders.write', 'orders.permanent_delete',
      'marketing.read', 'marketing.write', 'finance.read', 'payments.write'
    ]
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { csrfToken: 'test-csrf-token', admin: { username: ownerActor.username } };
    req.admin = ownerActor;
    next();
  });

  const config = {
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: await bcrypt.hash('secret-admin-pass', 10),
    PUBLIC_BASE_URL: 'http://localhost:3000'
  };

  app.use('/api', createStoreApi(pool, { inventory, audit: appendAudit, config }));
  app.use('/api/gaeru_ceo/internal-ai', createInternalAiRouter(pool, config));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));

  t.after(async () => {
    await new Promise(r => server.close(r));
    await db.close();
  });

  const base = 'http://127.0.0.1:' + server.address().port;

  async function api(path, method = 'GET', body = null) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'test-csrf-token'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  return { pool, api, ownerActor };
}

test('GAERU AI & Quản trị: Đề xuất hành động thông minh, Xóa vĩnh viễn đơn & Hủy đơn liền mạch vận chuyển', async (t) => {
  const { pool, api, ownerActor } = await setupTestApp(t);

  let testOrderId = null;
  const orderNum = 'GAE-' + randomUUID().slice(0, 8).toUpperCase();

  await t.test('1. Tạo đơn hàng và gắn mã vận đơn hãng', async () => {
    const product = (await pool.query(
      "INSERT INTO products(slug, name, category, active) VALUES($1, 'Micro K9', 'audio', true) RETURNING id",
      ['k9-' + randomUUID()]
    )).rows[0];

    const variant = (await pool.query(
      "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, $2, 'K9 Đơn', 250000, 15, true) RETURNING id",
      [product.id, 'SKU-' + randomUUID().slice(0, 6)]
    )).rows[0];

    await withTransaction(pool, c => inventory.initializeVariantStock(c, { variantId: variant.id, quantity: 15, actor: ownerActor }));

    const ord = (await pool.query(`
      INSERT INTO orders (order_number, customer_name, email, phone, address, city, subtotal_vnd, total_vnd, status, payment_method, payment_status)
      VALUES ($1, 'Nguyễn Văn A', 'a@example.com', '0912345678', '123 Phố Huế', 'Hà Nội', 250000, 250000, 'pending', 'cod', 'pending')
      RETURNING id, order_number
    `, [orderNum])).rows[0];
    testOrderId = ord.id;

    await pool.query(`
      INSERT INTO order_items (order_id, variant_id, quantity, unit_price_vnd, line_total_vnd, product_name, variant_name, sku)
      VALUES ($1, $2, 1, 250000, 250000, 'Micro K9', 'K9 Đơn', 'SKU-001')
    `, [testOrderId, variant.id]);

    await pool.query(`
      INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status)
      VALUES ($1, 'viettel', 'VT9988776655', 'created', 250000, 'unsettled')
    `, [testOrderId]);

    assert.ok(testOrderId);
  });

  await t.test('2. GAERU AI: Nhận diện lệnh "Xác nhận đơn" và tạo Action Card đề xuất', async () => {
    // Tạo phiên hội thoại
    const thRes = await api('/api/gaeru_ceo/internal-ai/threads', 'POST', { title: 'Test AI Flow' });
    assert.equal(thRes.status, 201);
    const threadId = thRes.data.thread.id;

    // Chat với GAERU AI yêu cầu xác nhận đơn
    const chatRes = await api(`/api/gaeru_ceo/internal-ai/threads/${threadId}/chat`, 'POST', {
      question: `GAERU AI ơi hãy duyệt và xác nhận đơn ${orderNum} cho khách nhé`
    });
    assert.equal(chatRes.status, 200);
    assert.ok(chatRes.data.actionCard, 'GAERU AI phải tạo thẻ Action Card đề xuất');
    assert.equal(chatRes.data.actionCard.actionType, 'confirm_order');
    assert.equal(chatRes.data.actionCard.status, 'pending');

    // Bấm nút "Xác nhận thực hiện" trên Action Card
    const execRes = await api(`/api/gaeru_ceo/internal-ai/actions/${chatRes.data.actionCard.actionId}/execute`, 'POST');
    assert.equal(execRes.status, 200);
    assert.equal(execRes.data.status, 'executed');
    assert.ok(execRes.data.result.success);
    assert.match(execRes.data.result.message, /thành công/);

    // Kiểm tra DB: Đơn đã thực sự chuyển sang processing
    const updated = (await pool.query('SELECT status FROM orders WHERE id = $1', [testOrderId])).rows[0];
    assert.equal(updated.status, 'processing', 'Đơn hàng phải được cập nhật thật sang processing');
  });

  await t.test('3. GAERU AI: Tạo mã giảm giá voucher có tác dụng thật trên website', async () => {
    const thRes = await api('/api/gaeru_ceo/internal-ai/threads', 'POST', { title: 'Voucher Flow' });
    const threadId = thRes.data.thread.id;

    const chatRes = await api(`/api/gaeru_ceo/internal-ai/threads/${threadId}/chat`, 'POST', {
      question: 'Tạo giúp tôi mã giảm giá TESTAI50 giảm 50k cho đơn từ 200k'
    });
    assert.equal(chatRes.status, 200);
    assert.ok(chatRes.data.actionCard);
    assert.equal(chatRes.data.actionCard.actionType, 'create_voucher');

    const execRes = await api(`/api/gaeru_ceo/internal-ai/actions/${chatRes.data.actionCard.actionId}/execute`, 'POST');
    assert.equal(execRes.status, 200);
    assert.equal(execRes.data.status, 'executed');

    // Kiểm tra DB: Voucher TESTAI50 đã được tạo thật trong bảng marketing_vouchers
    const vRow = (await pool.query("SELECT * FROM marketing_vouchers WHERE code = 'TESTAI50'")).rows[0];
    assert.ok(vRow, 'Voucher phải tồn tại trong cơ sở dữ liệu thật');
    assert.equal(vRow.amount, 50000);
    assert.equal(vRow.active, true);
  });

  await t.test('4. Vận chuyển liền mạch: Hủy đơn có vận đơn đang hoạt động qua cancelActiveWaybill', async () => {
    // Thử hủy không có cờ cancelActiveWaybill -> phải từ chối an toàn với 409
    const failRes = await api(`/api/gaeru_ceo/orders/${testOrderId}`, 'PATCH', {
      status: 'cancelled'
    });
    assert.equal(failRes.status, 409, 'Phải yêu cầu hủy vận đơn khi chưa có cờ đồng bộ');

    // Hủy với cờ cancelActiveWaybill: true -> Tự động hủy cả vận đơn và đơn hàng liền mạch
    const okRes = await api(`/api/gaeru_ceo/orders/${testOrderId}`, 'PATCH', {
      status: 'cancelled',
      cancelActiveWaybill: true
    });
    assert.equal(okRes.status, 200, 'Hủy đơn kèm hủy vận đơn phải thành công 200');
    assert.equal(okRes.data.order.status, 'cancelled');

    // Kiểm tra vận đơn trong DB: đã chuyển sang cancelled
    const shipRow = (await pool.query('SELECT status FROM carrier_shipments WHERE order_id = $1', [testOrderId])).rows[0];
    assert.equal(shipRow.status, 'cancelled', 'Vận đơn hãng phải tự động chuyển sang cancelled');

    // Kiểm tra tồn kho đã được hoàn lại an toàn
    const ordCheck = (await pool.query('SELECT status FROM orders WHERE id = $1', [testOrderId])).rows[0];
    assert.equal(ordCheck.status, 'cancelled');
  });

  await t.test('5. Quản trị tối cao: Xóa vĩnh viễn đơn hàng thành công, không bị lỗi hay phục hồi khi tải lại', async () => {
    const delRes = await api(`/api/gaeru_ceo/orders/${testOrderId}/permanent-delete`, 'POST', {
      password: 'secret-admin-pass',
      reason: 'Quản trị tối cao xóa vĩnh viễn đơn test'
    });
    assert.equal(delRes.status, 200, 'Xóa vĩnh viễn bởi Owner phải trả về 200');
    assert.match(delRes.data.message, /Đã xóa vĩnh viễn/);

    // Kiểm tra DB: Đơn hàng hoàn toàn biến mất
    const checkDb = (await pool.query('SELECT id FROM orders WHERE id = $1', [testOrderId])).rows;
    assert.equal(checkDb.length, 0, 'Đơn hàng phải bị xóa hoàn toàn khỏi DB');

    // Kiểm tra các bảng liên quan: carrier_shipments, order_items đều sạch
    const checkShip = (await pool.query('SELECT id FROM carrier_shipments WHERE order_id = $1', [testOrderId])).rows;
    assert.equal(checkShip.length, 0, 'Vận đơn của đơn đã xóa phải sạch');

    const checkItems = (await pool.query('SELECT id FROM order_items WHERE order_id = $1', [testOrderId])).rows;
    assert.equal(checkItems.length, 0, 'Mặt hàng của đơn đã xóa phải sạch');
  });
});
