const { test } = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const { createLocalPool } = require('../src/local-server');
const { migrateDatabase } = require('../src/migrate');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

test('Live Reproduction of User Scenarios from Screenshots', async (t) => {
  const pool = await createLocalPool(); // in-memory PGlite
  await migrateDatabase(pool);

  const client = await pool.connect();
  let orderId, orderNumber, shipmentId;
  let order2Id, order2Number, shipment2Id;
  let order3Id, order3Number, shipment3Id;
  try {
    const pRes = await client.query(`
      INSERT INTO products (name, slug, category, active)
      VALUES ('Test Product', 'test-prod', 'audio', true)
      RETURNING id
    `);
    const pvRes = await client.query(`
      INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
      VALUES ($1, 'SKU-01', 'Standard', 202300, 10, true)
      RETURNING id
    `, [pRes.rows[0].id]);

    const oRes = await client.query(`
      INSERT INTO orders (
        order_number, customer_name, email, phone, address, city,
        subtotal_vnd, shipping_fee_vnd, total_vnd, payment_method, payment_status, status, delivered_at
      ) VALUES (
        'GR-20261106-AB67EA7050', 'Đỗ Thiện', 'dothien@example.com', '0912345678', 'Hà Nội', 'Hà Nội',
        202300, 0, 202300, 'cod', 'pending', 'shipped', now()
      ) RETURNING id, order_number
    `);
    orderId = oRes.rows[0].id;
    orderNumber = oRes.rows[0].order_number;

    const sRes = await client.query(`
      INSERT INTO carrier_shipments (
        order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status
      ) VALUES (
        $1, 'viettel', '156668075672', 'delivered', 202300, 'unsettled'
      ) RETURNING id
    `, [orderId]);
    shipmentId = sRes.rows[0].id;

    // Order 2 for modal test with ref
    const o2Res = await client.query(`
      INSERT INTO orders (
        order_number, customer_name, email, phone, address, city,
        subtotal_vnd, shipping_fee_vnd, total_vnd, payment_method, payment_status, status, delivered_at
      ) VALUES (
        'GR-20261106-MODAL00001', 'Đỗ Thiện', 'dothien@example.com', '0912345678', 'Hà Nội', 'Hà Nội',
        202300, 0, 202300, 'cod', 'pending', 'shipped', now()
      ) RETURNING id, order_number
    `);
    order2Id = o2Res.rows[0].id;
    order2Number = o2Res.rows[0].order_number;

    const s2Res = await client.query(`
      INSERT INTO carrier_shipments (
        order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status
      ) VALUES (
        $1, 'viettel', '156668075673', 'delivered', 202300, 'unsettled'
      ) RETURNING id
    `, [order2Id]);
    shipment2Id = s2Res.rows[0].id;

    // Order 3 for modal test WITHOUT reconciliationRef (User requested: remove mandatory COD ref)
    const o3Res = await client.query(`
      INSERT INTO orders (
        order_number, customer_name, email, phone, address, city,
        subtotal_vnd, shipping_fee_vnd, total_vnd, payment_method, payment_status, status, delivered_at
      ) VALUES (
        'GR-20261106-MODAL-NO-REF', 'Đỗ Thiện', 'dothien@example.com', '0912345678', 'Hà Nội', 'Hà Nội',
        202300, 0, 202300, 'cod', 'pending', 'shipped', now()
      ) RETURNING id, order_number
    `);
    order3Id = o3Res.rows[0].id;
    order3Number = o3Res.rows[0].order_number;

    const s3Res = await client.query(`
      INSERT INTO carrier_shipments (
        order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status
      ) VALUES (
        $1, 'viettel', '156668075674', 'delivered', 202300, 'unsettled'
      ) RETURNING id
    `, [order3Id]);
    shipment3Id = s3Res.rows[0].id;
  } finally {
    client.release();
  }

  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-secret-32-chars-long-enough-ok',
    DATABASE_URL: 'local-pglite',
    ADMIN_USERNAME: 'admin',
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

  // Get CSRF token
  const csrfRes = await fetch(`${baseUrl}/api/csrf`);
  const csrfCookies = csrfRes.headers.getSetCookie ? csrfRes.headers.getSetCookie() : [csrfRes.headers.get('set-cookie')];
  const { csrfToken } = await csrfRes.json();
  const initialCookieStr = csrfCookies.map(c => c.split(';')[0]).join('; ');

  // Log in as owner/admin
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
      cookie: initialCookieStr
    },
    body: JSON.stringify({ username: 'admin', password: 'password' })
  });
  assert.equal(loginRes.status, 200);
  const loginCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')];
  const authedCookieStr = loginCookies.map(c => c.split(';')[0]).join('; ');
  const loginJson = await loginRes.json();
  const sessionToken = loginJson.csrfToken;

  await t.test('Scenario 1: Settle COD Batch via HTTP (Image 1 & 4)', async () => {
    const payload = {
      carrierId: 'viettel',
      providerTransactionRef: 'vcb6516541',
      declaredPayoutVnd: 202300,
      method: 'cash',
      payoutPeriod: '10/11/2026',
      evidenceRef: '5646546',
      note: 'ds',
      allocations: [
        { orderId, amountVnd: 202300 }
      ]
    };

    const res = await fetch(`${baseUrl}/api/gaeru_ceo/shipping/cod-settlements/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': sessionToken,
        cookie: authedCookieStr
      },
      body: JSON.stringify(payload)
    });

    const json = await res.json();
    assert.equal(res.status, 200, 'Batch response: ' + JSON.stringify(json));
    assert.equal(json.success, true);
    assert.equal(json.batch.declaredPayoutVnd, 202300);

    const orderCheck = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [orderId])).rows[0];
    assert.equal(orderCheck.status, 'completed');
    assert.equal(orderCheck.payment_status, 'paid');
  });

  await t.test('Scenario 2: Modal Order Update with paid + vtp11 via HTTP (Image 2 & 3)', async () => {
    const payload = {
      paymentStatus: 'paid',
      reconciliationRef: 'vtp11'
    };

    const res = await fetch(`${baseUrl}/api/gaeru_ceo/orders/${order2Id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': sessionToken,
        cookie: authedCookieStr
      },
      body: JSON.stringify(payload)
    });

    const json = await res.json();
    assert.equal(res.status, 200, 'Modal patch response: ' + JSON.stringify(json));
    assert.equal(json.order.status, 'completed');
    assert.equal(json.order.paymentStatus, 'paid');

    const order2Check = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [order2Id])).rows[0];
    assert.equal(order2Check.status, 'completed');
    assert.equal(order2Check.payment_status, 'paid');
  });

  await t.test('Scenario 3: Modal Order Complete WITHOUT reconciliationRef (User Request: Remove manual COD reconciliation)', async () => {
    // When order is completed with status 'completed' and paymentStatus 'paid' without any reconciliationRef
    const payload = {
      status: 'completed',
      paymentStatus: 'paid'
    };

    const res = await fetch(`${baseUrl}/api/gaeru_ceo/orders/${order3Id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': sessionToken,
        cookie: authedCookieStr
      },
      body: JSON.stringify(payload)
    });

    const json = await res.json();
    assert.equal(res.status, 409, 'Carrier COD without bank reference must not be recorded paid: ' + JSON.stringify(json));
    const settle = await fetch(`${baseUrl}/api/gaeru_ceo/shipping/orders/${order3Id}/settle-cod`,{
      method:'POST',
      headers:{'Content-Type':'application/json','x-csrf-token':sessionToken,cookie:authedCookieStr},
      body:JSON.stringify({providerTransactionRef:'VTP-MODAL-REAL-PAYOUT',settledAmountVnd:202300})
    });
    assert.equal(settle.status,200,'COD settlement with real provider transaction reference succeeds');

    const order3Check = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [order3Id])).rows[0];
    assert.equal(order3Check.status, 'completed');
    assert.equal(order3Check.payment_status, 'paid');

    const shipment3Check = (await pool.query('SELECT cod_settlement_status, cod_settlement_ref FROM carrier_shipments WHERE id = $1', [shipment3Id])).rows[0];
    assert.equal(shipment3Check.cod_settlement_status, 'settled');
    assert.equal(shipment3Check.cod_settlement_ref,'VTP-MODAL-REAL-PAYOUT');
  });
});
