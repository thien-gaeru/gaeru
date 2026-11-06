'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const {
  checkReturnEligibility,
  createCustomerReturnRequest,
  afterSalesRouter,
  RETURN_POLICY_DAYS
} = require('../src/order-after-sales');
const { createCustomerExperience } = require('../src/customer-experience');
const { createTrackingApi } = require('../src/tracking-api');

test('Customer After-Sales & Self-Service Return Suite', async (t) => {
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) {
      return !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : db.query(sql, values);
    },
    async connect() {
      return { query: pool.query, release() {} };
    }
  };
  t.after(() => db.close());

  // Run full database migrations
  await migrateDatabase(pool);

  // 1. Seed Customers
  const custA = (await pool.query(
    "INSERT INTO customers (email, full_name, phone, active) VALUES ('khachA@gaeru.com', 'Nguyen Van A', '0912345678', true) RETURNING id"
  )).rows[0];

  const custB = (await pool.query(
    "INSERT INTO customers (email, full_name, phone, active) VALUES ('khachB@gaeru.com', 'Tran Thi B', '0987654321', true) RETURNING id"
  )).rows[0];

  // 2. Seed Orders for Customer A
  // Order 1: Completed today (Eligible for 7-day return)
  const orderCompletedFresh = (await pool.query(
    `INSERT INTO orders (
      order_number, customer_id, customer_name, email, phone, address, city,
      payment_method, payment_status, status, subtotal_vnd, total_vnd, updated_at
    ) VALUES (
      'GAE-RETURN-01', $1, 'Nguyen Van A', 'khachA@gaeru.com', '0912345678', '123 Le Loi', 'TP. HCM',
      'cod', 'paid', 'completed', 500000, 500000, now() - interval '2 days'
    ) RETURNING id, order_number`,
    [custA.id]
  )).rows[0];

  // Order 2: Completed 10 days ago (Expired 7-day return window)
  const orderCompletedOld = (await pool.query(
    `INSERT INTO orders (
      order_number, customer_id, customer_name, email, phone, address, city,
      payment_method, payment_status, status, subtotal_vnd, total_vnd, updated_at
    ) VALUES (
      'GAE-RETURN-02', $1, 'Nguyen Van A', 'khachA@gaeru.com', '0912345678', '123 Le Loi', 'TP. HCM',
      'bank_transfer', 'paid', 'completed', 800000, 800000, now() - interval '10 days'
    ) RETURNING id, order_number`,
    [custA.id]
  )).rows[0];

  // Order 3: Pending order (Not yet delivered)
  const orderPending = (await pool.query(
    `INSERT INTO orders (
      order_number, customer_id, customer_name, email, phone, address, city,
      payment_method, payment_status, status, subtotal_vnd, total_vnd
    ) VALUES (
      'GAE-RETURN-03', $1, 'Nguyen Van A', 'khachA@gaeru.com', '0912345678', '123 Le Loi', 'TP. HCM',
      'cod', 'pending', 'pending', 300000, 300000
    ) RETURNING id, order_number`,
    [custA.id]
  )).rows[0];

  // Order 4: Cancelled order
  const orderCancelled = (await pool.query(
    `INSERT INTO orders (
      order_number, customer_id, customer_name, email, phone, address, city,
      payment_method, payment_status, status, subtotal_vnd, total_vnd
    ) VALUES (
      'GAE-RETURN-04', $1, 'Nguyen Van A', 'khachA@gaeru.com', '0912345678', '123 Le Loi', 'TP. HCM',
      'cod', 'pending', 'cancelled', 300000, 300000
    ) RETURNING id, order_number`,
    [custA.id]
  )).rows[0];

  await t.test('Unit: checkReturnEligibility verifies 7-day policy window and order states', () => {
    // 1. Fresh completed order -> Eligible
    const freshRes = checkReturnEligibility({
      status: 'completed',
      updated_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString()
    });
    assert.equal(freshRes.eligible, true);
    assert.equal(freshRes.policyWindowDays, 7);
    assert.ok(freshRes.daysRemaining >= 4 && freshRes.daysRemaining <= 6);

    // 2. Old completed order (10 days ago) -> Expired 7-day window
    const oldRes = checkReturnEligibility({
      status: 'completed',
      updated_at: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString()
    });
    assert.equal(oldRes.eligible, false);
    assert.equal(oldRes.code, 'RETURN_WINDOW_EXPIRED');
    assert.ok(oldRes.reason.includes('quá thời hạn đổi trả 7 ngày'));
    assert.ok(oldRes.reason.includes('GAERU Care+'));

    // 3. Pending order -> Not yet delivered
    const pendingRes = checkReturnEligibility({ status: 'pending' });
    assert.equal(pendingRes.eligible, false);
    assert.equal(pendingRes.code, 'ORDER_NOT_DELIVERED');

    // 4. Cancelled order -> Not eligible
    const cancelledRes = checkReturnEligibility({ status: 'cancelled' });
    assert.equal(cancelledRes.eligible, false);
    assert.equal(cancelledRes.code, 'ORDER_CANCELLED');

    // 5. Active case exists -> Block duplicate
    const activeCaseRes = checkReturnEligibility(
      { status: 'completed', updated_at: new Date().toISOString() },
      { id: '12345678-0000-0000-0000-000000000000', status: 'requested', kind: 'return' }
    );
    assert.equal(activeCaseRes.eligible, false);
    assert.equal(activeCaseRes.code, 'ACTIVE_CASE_EXISTS');

    // 6. Already returned -> Block duplicate
    const alreadyReturnedRes = checkReturnEligibility(
      { status: 'completed', return_completed_at: new Date().toISOString() }
    );
    assert.equal(alreadyReturnedRes.eligible, false);
    assert.equal(alreadyReturnedRes.code, 'ALREADY_RETURNED');
  });

  // Setup Customer Express Server
  const app = express();
  app.use(express.json());
  // Mock customer session
  app.use((req, res, next) => {
    const custHeader = req.headers['x-customer-id'] || custA.id;
    req.session = {
      csrfToken: 'test-csrf-token',
      customer: {
        id: custHeader,
        email: custHeader === custA.id ? 'khachA@gaeru.com' : 'khachB@gaeru.com',
        fullName: 'Nguyen Van A'
      }
    };
    next();
  });
  app.use('/api/customer', createCustomerExperience(pool));
  app.use('/api', createTrackingApi(pool));
  const rma = require('../src/rma-tickets').createRmaApi(pool);
  app.use('/api', rma.publicApi);
  app.use('/api/gaeru_ceo', afterSalesRouter(pool));

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => server.close());

  await t.test('Customer API: GET eligibility returns valid status for fresh vs expired orders', async () => {
    // 1. Check eligible order
    const resElig = await fetch(`${baseUrl}/api/customer/orders/${orderCompletedFresh.id}/after-sales/eligibility`, {
      headers: { 'X-Customer-Id': custA.id }
    });
    assert.equal(resElig.status, 200);
    const dataElig = await resElig.json();
    assert.equal(dataElig.eligible, true);
    assert.equal(dataElig.policyWindowDays, 7);

    // 2. Check expired order
    const resOld = await fetch(`${baseUrl}/api/customer/orders/${orderCompletedOld.id}/after-sales/eligibility`, {
      headers: { 'X-Customer-Id': custA.id }
    });
    assert.equal(resOld.status, 200);
    const dataOld = await resOld.json();
    assert.equal(dataOld.eligible, false);
    assert.equal(dataOld.code, 'RETURN_WINDOW_EXPIRED');

    // 3. Check pending order
    const resPending = await fetch(`${baseUrl}/api/customer/orders/${orderPending.id}/after-sales/eligibility`, {
      headers: { 'X-Customer-Id': custA.id }
    });
    assert.equal(resPending.status, 200);
    const dataPending = await resPending.json();
    assert.equal(dataPending.eligible, false);
    assert.equal(dataPending.code, 'ORDER_NOT_DELIVERED');
  });

  await t.test('Customer API: POST /orders/:id/after-sales creates return request with CSRF and validation', async () => {
    // 1. Customer submits return request for exchange
    const postRes = await fetch(`${baseUrl}/api/customer/orders/${orderCompletedFresh.id}/after-sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Customer-Id': custA.id,
        'X-CSRF-Token': 'test-csrf-token'
      },
      body: JSON.stringify({
        returnType: 'exchange',
        reasonCategory: 'faulty',
        reason: 'Micro bị rè âm thanh ở dải cao, muốn đổi sang sản phẩm mới'
      })
    });
    assert.equal(postRes.status, 201);
    const postData = await postRes.json();
    assert.equal(postData.ok, true);
    assert.equal(postData.case.kind, 'return');
    assert.equal(postData.case.status, 'requested');
    assert.equal(postData.case.requested_by, 'customer');
    assert.equal(postData.case.return_type, 'exchange');

    // 2. Duplicate submission fails
    const dupRes = await fetch(`${baseUrl}/api/customer/orders/${orderCompletedFresh.id}/after-sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Customer-Id': custA.id,
        'X-CSRF-Token': 'test-csrf-token'
      },
      body: JSON.stringify({
        returnType: 'exchange',
        reason: 'Muốn gửi lại yêu cầu lần 2'
      })
    });
    assert.equal(dupRes.status, 400);
    const dupData = await dupRes.json();
    assert.ok(dupData.error.includes('đang có yêu cầu'));

    // 3. Customer B cannot create return for Customer A's order
    const forbidRes = await fetch(`${baseUrl}/api/customer/orders/${orderCompletedFresh.id}/after-sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Customer-Id': custB.id,
        'X-CSRF-Token': 'test-csrf-token'
      },
      body: JSON.stringify({
        returnType: 'refund',
        reason: 'Yêu cầu không chính chủ'
      })
    });
    assert.equal(forbidRes.status, 404); // Order not found for Customer B

    // 4. Customer A views after-sales list for their order
    const casesRes = await fetch(`${baseUrl}/api/customer/orders/${orderCompletedFresh.id}/after-sales`, {
      headers: { 'X-Customer-Id': custA.id }
    });
    assert.equal(casesRes.status, 200);
    const casesData = await casesRes.json();
    assert.equal(casesData.cases.length, 1);
    assert.equal(casesData.cases[0].requestedBy, 'customer');
    assert.equal(casesData.cases[0].returnType, 'exchange');

    // 5. Customer A views orders list and sees afterSales summary badge
    const ordersRes = await fetch(`${baseUrl}/api/customer/orders`, {
      headers: { 'X-Customer-Id': custA.id }
    });
    assert.equal(ordersRes.status, 200);
    const ordersData = await ordersRes.json();
    const targetOrder = ordersData.orders.find(o => o.id === orderCompletedFresh.id);
    assert.ok(targetOrder);
    assert.ok(targetOrder.afterSales);
    assert.equal(targetOrder.afterSales.status, 'requested');
  });

  await t.test('Public / Guest Return Request via /api/tracking/return-request', async () => {
    // Seed Guest Order
    const guestOrder = (await pool.query(
      `INSERT INTO orders (
        order_number, customer_name, email, phone, address, city,
        payment_method, payment_status, status, subtotal_vnd, total_vnd, updated_at
      ) VALUES (
        'GAE-GUEST-RETURN', 'Khach Vang Lai', 'guest@example.com', '0933445566', '456 Tran Phu', 'Da Nang',
        'cod', 'paid', 'completed', 450000, 450000, now() - interval '1 day'
      ) RETURNING id, order_number`
    )).rows[0];

    // 1. Submit with valid challenge
    const guestRes = await fetch(`${baseUrl}/api/tracking/return-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderNumber: 'GAE-GUEST-RETURN',
        challenge: '0933445566',
        returnType: 'refund',
        reasonCategory: 'wrong_item',
        reason: 'Shop gửi sai màu tai nghe, muốn trả hàng hoàn tiền',
        bankInfo: {
          bankName: 'Vietcombank',
          accountNumber: '0071000123456',
          accountHolder: 'KHACH VANG LAI'
        }
      })
    });
    assert.equal(guestRes.status, 201);
    const guestData = await guestRes.json();
    assert.equal(guestData.ok, true);
    assert.equal(guestData.case.requested_by, 'guest');
    assert.equal(guestData.case.return_type, 'refund');
    assert.equal(guestData.case.bank_info.bankName, 'Vietcombank');

    // 2. Submit with wrong challenge fails
    const badChallengeRes = await fetch(`${baseUrl}/api/tracking/return-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderNumber: 'GAE-GUEST-RETURN',
        challenge: '0900000000',
        reason: 'Lý do gì đó'
      })
    });
    assert.equal(badChallengeRes.status, 404);
  });

  await t.test('RMA: return cases get RMA number + token; inbound tracking is token-gated; admin logistics updates outbound', async () => {
    const row = (await pool.query(
      "SELECT id, rma_number, rma_token FROM order_after_sales WHERE order_id = $1",
      [orderCompletedFresh.id]
    )).rows[0];
    assert.match(row.rma_number, /^RMA-\d{6}-[0-9A-F]{4}$/);
    assert.equal(row.rma_token.length, 48);

    // 1. Lookup without credentials by a different customer -> 403
    const denied = await fetch(`${baseUrl}/api/rma/${row.rma_number}`, { headers: { 'X-Customer-Id': custB.id } });
    assert.equal(denied.status, 403);

    // 2. Lookup by token -> masked PII + warehouse address
    const byToken = await fetch(`${baseUrl}/api/rma/${row.rma_number}?token=${row.rma_token}`, { headers: { 'X-Customer-Id': custB.id } });
    assert.equal(byToken.status, 200);
    const info = (await byToken.json()).rma;
    assert.equal(info.inbound.status, 'pending_shipment');
    assert.ok(info.inbound.warehouseAddress.address.includes('Ninh Bình'));
    assert.ok(!info.customer.phone.includes('2345'));

    // 3. Owner lookup works without token
    assert.equal((await fetch(`${baseUrl}/api/rma/${row.rma_number}`, { headers: { 'X-Customer-Id': custA.id } })).status, 200);

    // 4. Inbound update with wrong token by non-owner -> 403
    const badInbound = await fetch(`${baseUrl}/api/rma/${row.rma_number}/inbound`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Customer-Id': custB.id },
      body: JSON.stringify({ token: 'x'.repeat(48), inboundCarrier: 'viettel', inboundTrackingNumber: 'VT123456' })
    });
    assert.equal(badInbound.status, 403);

    // An owner cannot bypass CSRF by supplying an invalid capability token.
    const ownerForgedToken = await fetch(`${baseUrl}/api/rma/${row.rma_number}/inbound`, {
      method:'POST', headers:{'Content-Type':'application/json','X-Customer-Id':custA.id},
      body:JSON.stringify({token:'invalid-capability',inboundCarrier:'viettel',inboundTrackingNumber:'FORGED123'})
    });
    assert.equal(ownerForgedToken.status,403);
    const ownerWithoutCsrf = await fetch(`${baseUrl}/api/rma/${row.rma_number}/inbound`, {
      method:'POST',headers:{'Content-Type':'application/json','X-Customer-Id':custA.id},
      body:JSON.stringify({inboundCarrier:'viettel',inboundTrackingNumber:'FORGED456'})
    });
    assert.equal(ownerWithoutCsrf.status,403);
    assert.equal((await pool.query('SELECT inbound_status FROM order_after_sales WHERE id=$1',[row.id])).rows[0].inbound_status,'pending_shipment');

    // 5. Inbound update with valid token -> in_transit
    const okInbound = await fetch(`${baseUrl}/api/rma/${row.rma_number}/inbound`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Customer-Id': custB.id },
      body: JSON.stringify({ token: row.rma_token, inboundCarrier: 'viettel', inboundTrackingNumber: 'vt123456' })
    });
    assert.equal(okInbound.status, 200);
    const inboundData = await okInbound.json();
    assert.equal(inboundData.rma.inboundStatus, 'in_transit');
    assert.equal(inboundData.rma.inboundTrackingNumber, 'VT123456');

    // 6. Admin logistics update (service level)
    const { updateRmaLogisticsByAdmin } = require('../src/rma-tickets');
    const updated = await updateRmaLogisticsByAdmin(pool, {
      caseId: row.id,
      inboundStatus: 'delivered_to_warehouse',
      inspectionNotes: 'Lỗi mạch thu, đổi mới 1:1',
      actor: { username: 'fixture' }
    });
    assert.equal(updated.inbound_status, 'delivered_to_warehouse');
    assert.equal(updated.outbound_status, 'none');
    await assert.rejects(updateRmaLogisticsByAdmin(pool, { caseId: row.id, outboundCarrier: 'viettel', outboundTrackingNumber: 'VT777', outboundStatus: 'in_transit', actor: { username: 'fixture' } }), { status: 409 });
  });
});
