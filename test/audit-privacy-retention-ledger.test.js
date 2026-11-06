const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { withTransaction } = require('../src/db');
const { purgeDeletedAccounts } = require('../src/account-retention');
const { deleteOrderPermanently, deleteCustomerOrdersPermanently, anonymizeCustomerOrders } = require('../src/order-deletion');

async function createFixture() {
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
  return { pool, db };
}

test('A01: Purging expired accounts (>1 year) anonymizes customer orders, keeping ledger receipts and total revenue intact', async t => {
  const { pool, db } = await createFixture();
  t.after(() => db.close());

  const passwordHash = await bcrypt.hash('secret123', 4);
  const customerId = (await pool.query(
    `INSERT INTO customers (full_name, email, phone, password_hash, active, deleted_at, deletion_recoverable)
     VALUES ('Nguyễn Văn A', 'nguyenvana@example.invalid', '0901234567', $1, false, now() - interval '400 days', true)
     RETURNING id`,
    [passwordHash]
  )).rows[0].id;

  // Insert 2 orders with sales receipts
  const o1 = (await pool.query(
    `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
     VALUES ('ORD-RET-01', $1, 'Nguyễn Văn A', 'nguyenvana@example.invalid', '0901234567', '123 Phố Huế', 'Hà Nội', 'cod', 'paid', 'completed', 500000, 500000)
     RETURNING id`,
    [customerId]
  )).rows[0];

  const o2 = (await pool.query(
    `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
     VALUES ('ORD-RET-02', $1, 'Nguyễn Văn A', 'nguyenvana@example.invalid', '0901234567', '123 Phố Huế', 'Hà Nội', 'bank_transfer', 'paid', 'completed', 750000, 750000)
     RETURNING id`,
    [customerId]
  )).rows[0];

  await pool.query(
    `INSERT INTO sales_receipts (order_id, amount_vnd, method, reference, request_key, request_hash, created_by)
     VALUES ($1, 500000, 'cash', 'COD-001', $2, 'hash1', 'accountant'),
            ($3, 750000, 'bank_transfer', 'VNPAY-002', $4, 'hash2', 'accountant')`,
    [o1.id, randomUUID(), o2.id, randomUUID()]
  );

  // Initial financial state
  const initialReceipts = Number((await pool.query('SELECT SUM(amount_vnd)::bigint AS sum FROM sales_receipts')).rows[0].sum);
  assert.equal(initialReceipts, 1250000);

  // Run purgeDeletedAccounts
  const purgedCount = await purgeDeletedAccounts(pool);
  assert.equal(purgedCount, 1);

  // Customer account is purged
  assert.equal((await pool.query('SELECT id FROM customers WHERE id = $1', [customerId])).rows.length, 0);

  // Orders are preserved and anonymized
  const orders = (await pool.query('SELECT * FROM orders WHERE id IN ($1, $2) ORDER BY order_number', [o1.id, o2.id])).rows;
  assert.equal(orders.length, 2);

  for (const o of orders) {
    assert.equal(o.customer_id, null, 'customer_id must be unlinked');
    assert.equal(o.customer_name, 'Khách hàng ẩn danh (Lưu trữ theo luật)');
    assert.equal(o.email, 'anonymized@privacy.gaeru.com');
    assert.equal(o.phone, '0000000000');
    assert.equal(o.address, 'Đã ẩn danh theo quy định lưu trữ');
    assert.equal(o.payment_status, 'paid');
  }

  // Financial receipts are 100% intact!
  const finalReceipts = Number((await pool.query('SELECT SUM(amount_vnd)::bigint AS sum FROM sales_receipts')).rows[0].sum);
  assert.equal(finalReceipts, 1250000, 'Total sales receipts must remain exactly equal to preserve ledger integrity');
});

test('A02: deleteOrderPermanently rejects orders with issued MISA e-invoices with HTTP 409', async t => {
  const { pool, db } = await createFixture();
  t.after(() => db.close());

  const order = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status)
     VALUES ('ORD-INV-01', 'Doanh Nghiệp B', 'corp@example.invalid', '0912345678', '456 Lê Duẩn', 'Hà Nội', 'bank_transfer', 2000000, 2000000, 'completed')
     RETURNING id`
  )).rows[0];

  // Insert an issued MISA e-invoice
  await pool.query(
    `INSERT INTO misa_einvoices (order_id, order_number, invoice_number, invoice_series, template_code, transaction_id, view_url, total_vnd, buyer_name, status)
     VALUES ($1, 'ORD-INV-01', '0000123', '1C26TGA', '1/001', 'TX-999', 'https://einvoice.example/view', 2000000, 'Doanh Nghiệp B', 'issued')`,
    [order.id]
  );

  // Attempting permanent deletion must be rejected with 409
  await assert.rejects(
    () => withTransaction(pool, client => deleteOrderPermanently(client, order.id)),
    err => {
      assert.equal(err.status, 409);
      assert.match(err.message, /Không thể xóa vĩnh viễn đơn hàng đã xuất hóa đơn điện tử hợp lệ/);
      assert.match(err.message, /Nghị định 123\/2020\/NĐ-CP/);
      return true;
    }
  );

  // Order still exists
  assert.equal((await pool.query('SELECT id FROM orders WHERE id = $1', [order.id])).rows.length, 1);

  // Once invoice is marked cancelled on tax authority system, deletion can proceed
  await pool.query("UPDATE misa_einvoices SET status = 'cancelled' WHERE order_id = $1", [order.id]);
  await withTransaction(pool, client => deleteOrderPermanently(client, order.id));
  assert.equal((await pool.query('SELECT id FROM orders WHERE id = $1', [order.id])).rows.length, 0);
});

test('A03: Deleting a registered customer never deletes or affects guest orders sharing the same email', async t => {
  const { pool, db } = await createFixture();
  t.after(() => db.close());

  const sharedEmail = 'common.buyer@example.invalid';
  const passwordHash = await bcrypt.hash('secret123', 4);

  const customerId = (await pool.query(
    `INSERT INTO customers (full_name, email, phone, password_hash, active)
     VALUES ('Khách Đã Đăng Ký', $1, '0988776655', $2, true)
     RETURNING id`,
    [sharedEmail, passwordHash]
  )).rows[0].id;

  // Order 1: Registered customer order
  const registeredOrder = (await pool.query(
    `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status)
     VALUES ('ORD-REG-01', $1, 'Khách Đã Đăng Ký', $2, '0988776655', 'Registered Address', 'Hà Nội', 'cod', 300000, 300000, 'completed')
     RETURNING id`,
    [customerId, sharedEmail]
  )).rows[0];

  // Order 2: Guest checkout order with the same email
  const guestOrder = (await pool.query(
    `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status)
     VALUES ('ORD-GUEST-01', NULL, 'Khách Vãng Lai Tự Do', $1, '0911223344', 'Guest Delivery Address', 'Đà Nẵng', 'cod', 450000, 450000, 'processing')
     RETURNING id`,
    [sharedEmail]
  )).rows[0];

  // Delete customer orders via deleteCustomerOrdersPermanently
  await withTransaction(pool, client =>
    deleteCustomerOrdersPermanently(client, customerId, sharedEmail, {
      actor: { username: 'test-admin', source: 'test' }
    })
  );

  // Registered order is deleted
  assert.equal((await pool.query('SELECT id FROM orders WHERE id = $1', [registeredOrder.id])).rows.length, 0);

  // Guest order is COMPLETELY UNTOUCHED!
  const guestRows = (await pool.query('SELECT * FROM orders WHERE id = $1', [guestOrder.id])).rows;
  assert.equal(guestRows.length, 1);
  assert.equal(guestRows[0].customer_id, null);
  assert.equal(guestRows[0].customer_name, 'Khách Vãng Lai Tự Do');
  assert.equal(guestRows[0].email, sharedEmail);
  assert.equal(guestRows[0].phone, '0911223344');
  assert.equal(guestRows[0].address, 'Guest Delivery Address');
  assert.equal(guestRows[0].city, 'Đà Nẵng');
  assert.equal(guestRows[0].total_vnd, 450000);
});
