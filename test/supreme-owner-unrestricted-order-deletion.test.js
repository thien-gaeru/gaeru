const { test } = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('node:crypto');
const { createLocalPool } = require('../src/local-server');
const { migrateDatabase } = require('../src/migrate');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { deleteOrderPermanently } = require('../src/order-deletion');

test('Supreme Owner Order Deletion - Unrestricted Purge vs Authorized Staff Safeguards', async (t) => {
  const pool = await createLocalPool();
  await migrateDatabase(pool);
  t.after(() => pool.end());

  const client = await pool.connect();
  let orderId, orderNumber, shipmentId, batchId;
  try {
    // 1. Create product & variant
    const pRes = await client.query(`
      INSERT INTO products (name, slug, category, active)
      VALUES ('Supreme Purge Test Product', 'supreme-purge-prod', 'audio', true)
      RETURNING id
    `);
    const pvRes = await client.query(`
      INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
      VALUES ($1, 'SUPREME-SKU', 'Standard', 350000, 20, true)
      RETURNING id
    `, [pRes.rows[0].id]);

    // 2. Create customer
    const cRes = await client.query(`
      INSERT INTO customers (full_name, email, phone, active)
      VALUES ('Khách hàng Kiểm tra Purge', 'supreme-purge@example.com', '0988776655', true)
      RETURNING id
    `);

    // 3. Create full-fledged order with all dependent relationships
    const oRes = await client.query(`
      INSERT INTO orders (
        order_number, customer_id, customer_name, email, phone, address, city,
        subtotal_vnd, shipping_fee_vnd, total_vnd, payment_method, payment_status, status, delivered_at
      ) VALUES (
        'GR-SUPREME-PURGE-01', $1, 'Khách hàng Kiểm tra Purge', 'supreme-purge@example.com', '0988776655', 'Hà Nội', 'Hà Nội',
        350000, 0, 350000, 'cod', 'paid', 'completed', now()
      ) RETURNING id, order_number
    `, [cRes.rows[0].id]);
    orderId = oRes.rows[0].id;
    orderNumber = oRes.rows[0].order_number;

    await client.query(`
      INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
      VALUES ($1, $2, 'Supreme Purge Test Product', 'Standard', 'SUPREME-SKU', 350000, 1, 350000)
    `, [orderId, pvRes.rows[0].id]);

    // Shipment & carrier shipment attempt
    const sRes = await client.query(`
      INSERT INTO carrier_shipments (
        order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status
      ) VALUES (
        $1, 'viettel', 'VT-PURGE-999', 'delivered', 350000, 'settled'
      ) RETURNING id
    `, [orderId]);
    shipmentId = sRes.rows[0].id;

    await client.query(`
      INSERT INTO carrier_shipment_attempts (order_id, carrier_id, config_version, status, provider_result)
      VALUES ($1, 'viettel', 1, 'succeeded', '{"trackingNumber":"VT-PURGE-999"}'::jsonb)
    `, [orderId]);

    // Sales receipt (accounting ledger)
    const rRes = await client.query(`
      INSERT INTO sales_receipts (order_id, amount_vnd, method, reference, request_key, request_hash, created_by)
      VALUES ($1, 350000, 'bank_transfer', 'REF-PURGE-01', 'req-purge-01', 'hash-purge-01', 'admin')
      RETURNING id
    `, [orderId]);

    // COD settlement batch & allocation
    const bRes = await client.query(`
      INSERT INTO cod_settlement_batches (carrier_id, provider_transaction_ref, declared_payout_vnd, allocated_total_vnd, method, attestation_level, created_by)
      VALUES ('viettel', 'VCB-BATCH-PURGE', 1000000, 350000, 'bank_transfer', 'statement_verified', 'accountant')
      RETURNING id
    `);
    batchId = bRes.rows[0].id;

    await client.query(`
      INSERT INTO cod_settlement_allocations (batch_id, order_id, shipment_id, allocated_amount_vnd, receipt_id, request_key, created_by)
      VALUES ($1, $2, $3, 350000, $4, 'alloc-purge-01', 'accountant')
    `, [batchId, orderId, shipmentId, rRes.rows[0].id]);

    // MISA e-invoice (issued)
    await client.query(`
      INSERT INTO misa_einvoices (order_id, order_number, invoice_number, invoice_series, template_code, transaction_id, view_url, total_vnd, buyer_name, status)
      VALUES ($1, $2, '00000888', '1C26TGA', '1/001', 'tx-888', 'https://view.misa.vn', 350000, 'Test Buyer', 'issued')
    `, [orderId, orderNumber]);

    // Paid payment attempt
    await client.query(`
      INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, status, expires_at)
      VALUES ($1, 'vnpay', 'TX-PURGE-01', 350000, 'paid', now() + interval '15 minutes')
    `, [orderId]);

    // Physical return intake
    await client.query(`
      INSERT INTO cod_return_intakes (order_id, shipment_id, carrier_id, tracking_number, order_number, package_condition, inspector)
      VALUES ($1, $2, 'viettel', 'VT-PURGE-999', $3, 'intact', 'inspector_qa')
    `, [orderId, shipmentId, orderNumber]);
  } finally {
    client.release();
  }

  // Set up HTTP app to test full endpoint security stack
  const adminPassword = 'SupremeOwnerPassword123!';
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-secret-supreme-owner-32-chars',
    DATABASE_URL: 'local-pglite',
    ADMIN_USERNAME: 'owner_supreme',
    ADMIN_PASSWORD_HASH: await bcrypt.hash(adminPassword, 10)
  });

  const app = createApp({
    config,
    pool,
    sessionStore: new session.MemoryStore(),
    customerMailer: { sendMail: async () => ({}) }
  });

  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(r => server.close(r)));
  await new Promise(r => server.once('listening', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Step 1: Login as Supreme Owner to obtain authenticated session
  const csrfRes = await fetch(`${baseUrl}/api/csrf`);
  const csrfCookies = csrfRes.headers.getSetCookie ? csrfRes.headers.getSetCookie() : [csrfRes.headers.get('set-cookie')];
  const { csrfToken } = await csrfRes.json();
  const initialCookieStr = csrfCookies.map(c => c.split(';')[0]).join('; ');

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
      cookie: initialCookieStr
    },
    body: JSON.stringify({ username: 'owner_supreme', password: adminPassword })
  });
  assert.equal(loginRes.status, 200);
  const loginCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')];
  const authedCookieStr = loginCookies.map(c => c.split(';')[0]).join('; ');
  const loginJson = await loginRes.json();
  const sessionCsrf = loginJson.csrfToken;

  await t.test('1. Authorized staff (role: staff) is strictly BLOCKED from deleting order with active records (HTTP 409)', async () => {
    const staffClient = await pool.connect();
    try {
      await assert.rejects(
        () => deleteOrderPermanently(staffClient, orderId, {
          actor: {
            username: 'staff_auditor',
            role: 'staff',
            permissions: ['orders.permanent_delete', 'orders.write', 'orders.read']
          }
        }),
        (err) => {
          assert.equal(err.status, 409);
          assert.match(err.message, /hóa đơn điện tử|phiếu thu kế toán|vận đơn/i);
          return true;
        }
      );
    } finally {
      staffClient.release();
    }

    // Verify order and dependent records remain completely intact
    const orderCheck = (await pool.query('SELECT id FROM orders WHERE id = $1', [orderId])).rows;
    assert.equal(orderCheck.length, 1);
    const receiptCheck = (await pool.query('SELECT id FROM sales_receipts WHERE order_id = $1', [orderId])).rows;
    assert.equal(receiptCheck.length, 1);
  });

  await t.test('2. Supreme Owner (role: owner) PERMANENTLY deletes order via HTTP API without ANY restrictions (HTTP 200)', async () => {
    const deleteRes = await fetch(`${baseUrl}/api/gaeru_ceo/orders/${orderId}/permanent-delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': sessionCsrf,
        cookie: authedCookieStr
      },
      body: JSON.stringify({
        password: adminPassword,
        reason: 'Quản trị tối cao xóa vĩnh viễn đơn hàng thử nghiệm'
      })
    });

    const deleteJson = await deleteRes.json();
    assert.equal(deleteRes.status, 200, 'Delete response: ' + JSON.stringify(deleteJson));
    assert.match(deleteJson.message, /Đã xóa vĩnh viễn đơn hàng/);

    // Verify clean purge across all tables:
    assert.equal((await pool.query('SELECT id FROM orders WHERE id = $1', [orderId])).rows.length, 0, 'Orders table purged');
    assert.equal((await pool.query('SELECT id FROM order_items WHERE order_id = $1', [orderId])).rows.length, 0, 'Order items purged');
    assert.equal((await pool.query('SELECT id FROM carrier_shipments WHERE order_id = $1', [orderId])).rows.length, 0, 'Carrier shipments purged');
    assert.equal((await pool.query('SELECT id FROM carrier_shipment_attempts WHERE order_id = $1', [orderId])).rows.length, 0, 'Carrier attempts purged');
    assert.equal((await pool.query('SELECT id FROM sales_receipts WHERE order_id = $1', [orderId])).rows.length, 0, 'Sales receipts purged');
    assert.equal((await pool.query('SELECT id FROM cod_settlement_allocations WHERE order_id = $1', [orderId])).rows.length, 0, 'COD allocations purged');
    assert.equal((await pool.query('SELECT id FROM misa_einvoices WHERE order_id = $1', [orderId])).rows.length, 0, 'MISA e-invoices purged');
    assert.equal((await pool.query('SELECT id FROM cod_return_intakes WHERE order_id = $1', [orderId])).rows.length, 0, 'COD return intakes purged');
    assert.equal((await pool.query('SELECT id FROM payment_attempts WHERE order_id = $1', [orderId])).rows.length, 0, 'Payment attempts purged');

    // Verify batch allocated_total_vnd was accurately decremented
    const batchRow = (await pool.query('SELECT allocated_total_vnd FROM cod_settlement_batches WHERE id = $1', [batchId])).rows[0];
    assert.equal(Number(batchRow.allocated_total_vnd), 0, 'Batch allocated total rebalanced to 0');
  });
});
