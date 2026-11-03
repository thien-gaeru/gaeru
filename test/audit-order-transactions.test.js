'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { randomUUID } = require('node:crypto');
const { migrateDatabase } = require('../src/migrate');
const { withTransaction } = require('../src/db');
const { appendAudit } = require('../src/audit');
const inventory = require('../src/inventory');
const finance = require('../src/finance-api');
const { createStoreApi } = require('../src/store-api');
const { deleteOrderPermanently } = require('../src/order-deletion');
const { updateRmaInboundTracking, updateRmaLogisticsByAdmin } = require('../src/rma-tickets');

async function fixture(t) {
  const db = await PGlite.create();
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = { query, connect: async () => ({ query, release() {} }) };
  t.after(() => db.close());
  await migrateDatabase(pool);
  const actor = { username: 'transaction-audit', role: 'owner', source: 'bootstrap', permissions: ['orders.write', 'payments.write', 'inventory.approve'] };
  const customer = (await query("INSERT INTO customers(email,full_name,phone) VALUES('transaction@example.invalid','Transaction Buyer','0900000000') RETURNING id")).rows[0];
  const product = (await query("INSERT INTO products(name,slug,category,active) VALUES('Transaction Product','transaction-product','audio',true) RETURNING id")).rows[0];
  const variant = (await query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'TRANSACTION-SKU','Default',100000,10,true) RETURNING id", [product.id])).rows[0];
  await withTransaction(pool, c => inventory.initializeVariantStock(c, { variantId: variant.id, quantity: 10, actor }));
  async function order(status = 'pending') {
    const row = (await query(`INSERT INTO orders(order_number,customer_id,customer_name,email,phone,address,city,payment_method,status,subtotal_vnd,shipping_fee_vnd,total_vnd)
      VALUES($1,$2,'Transaction Buyer','transaction@example.invalid','0900000000','Fixture Street','Hà Nội','cod',$3,200000,0,200000) RETURNING *`, [randomUUID(), customer.id, status])).rows[0];
    await query("INSERT INTO order_items(order_id,variant_id,product_name,variant_name,sku,unit_price_vnd,quantity,line_total_vnd) VALUES($1,$2,'Transaction Product','Default','TRANSACTION-SKU',100000,2,200000)", [row.id, variant.id]);
    await withTransaction(pool, c => inventory.reserveStock(c, { variantId: variant.id, quantity: 2, orderId: row.id, actor }));
    return row;
  }
  const state = async id => (await query('SELECT status,payment_status FROM orders WHERE id=$1', [id])).rows[0];
  return { pool, query, actor, customer, variant, order, state };
}

async function callOrderHandler(pool, actor, path, method, body, id) {
  const router = createStoreApi(pool, { inventory, finance, audit: appendAudit });
  const handler = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
  let status = 200, result, error;
  const res = { status(code) { status = code; return this; }, json(value) { result = value; return this; } };
  await handler({ params: { id }, body, admin: actor }, res, e => { error = e; });
  if (error) throw error;
  return { status, result };
}

test('admin cancellation rolls back reserved inventory and order status when loyalty refund fails', async t => {
  const f = await fixture(t), order = await f.order();
  const broken = { connect: async () => ({ release() {}, query(sql, args) {
    if (sql.includes('FROM customer_loyalty_ledger')) throw new Error('loyalty unavailable during cancellation');
    return f.query(sql, args);
  } }) };
  await assert.rejects(callOrderHandler(broken, f.actor, '/gaeru_ceo/orders/:id', 'patch', { status: 'cancelled' }, order.id), /loyalty unavailable/);
  assert.equal((await f.state(order.id)).status, 'pending');
  assert.equal((await f.query('SELECT stock_quantity FROM product_variants WHERE id=$1', [f.variant.id])).rows[0].stock_quantity, 8);
  assert.equal((await f.query('SELECT count(*)::int AS n FROM order_stock_allocations WHERE order_id=$1 AND released_at IS NULL', [order.id])).rows[0].n, 1);
});

test('admin completion keeps COD receipt and status atomic with loyalty policy validation', async t => {
  const f = await fixture(t), order = await f.order('shipped');
  await f.query("INSERT INTO store_settings(setting_key,setting_value) VALUES('loyalty_policy','{}')");
  const failed = await callOrderHandler(f.pool, f.actor, '/gaeru_ceo/orders/:id', 'patch', { status: 'completed', paymentStatus: 'paid' }, order.id);
  assert.equal(failed.status, 503, 'invalid loyalty policy must fail the whole completion');
  assert.deepEqual(await f.state(order.id), { status: 'shipped', payment_status: 'pending' });
  assert.equal((await f.query('SELECT count(*)::int AS n FROM sales_receipts WHERE order_id=$1', [order.id])).rows[0].n, 0);
  await f.query("DELETE FROM store_settings WHERE setting_key='loyalty_policy'");
  assert.equal((await callOrderHandler(f.pool, f.actor, '/gaeru_ceo/orders/:id', 'patch', { status: 'completed', paymentStatus: 'paid' }, order.id)).status, 200);
  assert.equal((await f.query('SELECT count(*)::int AS n FROM sales_receipts WHERE order_id=$1', [order.id])).rows[0].n, 1);
  assert.equal((await f.query("SELECT points FROM customer_loyalty_ledger WHERE order_id=$1 AND type='earn'", [order.id])).rows[0].points, 2000);
});

test('permanent deletion rejects warehouse reconciliation failure without falling back to aggregate stock', async t => {
  const f = await fixture(t), order = await f.order();
  await f.query('UPDATE warehouse_stock SET quantity=7 WHERE variant_id=$1', [f.variant.id]);
  await assert.rejects(withTransaction(f.pool, c => deleteOrderPermanently(c, order.id, { inventory, actor: f.actor })), { status: 409 });
  assert.equal((await f.state(order.id)).status, 'pending');
  assert.equal((await f.query('SELECT stock_quantity FROM product_variants WHERE id=$1', [f.variant.id])).rows[0].stock_quantity, 8);
  assert.equal((await f.query('SELECT count(*)::int AS n FROM order_items WHERE order_id=$1', [order.id])).rows[0].n, 1);
});

test('permanent deletion rolls back order, stock and loyalty on a refund failure', async t => {
  const f = await fixture(t), order = await f.order();
  await assert.rejects(withTransaction(f.pool, client => deleteOrderPermanently({ query(sql, args) {
    if (sql.includes('FROM customer_loyalty_ledger')) throw new Error('deletion loyalty unavailable');
    return client.query(sql, args);
  } }, order.id, { inventory, actor: f.actor })), /deletion loyalty unavailable/);
  assert.equal((await f.state(order.id)).status, 'pending');
  assert.equal((await f.query('SELECT stock_quantity FROM product_variants WHERE id=$1', [f.variant.id])).rows[0].stock_quantity, 8);
});

test('RMA logistics changes invalidate stale case versions and customers cannot undo warehouse reception', async t => {
  const f = await fixture(t), order = await f.order('completed');
  const row = (await f.query(`INSERT INTO order_after_sales(order_id,kind,status,reason,rma_number,rma_token,return_type)
    VALUES($1,'return','approved','Faulty item','RMA-261103-TEST','fixture-rma-capability','refund') RETURNING *`, [order.id])).rows[0];
  const inbound = await updateRmaInboundTracking(f.pool, { rmaNumber: row.rma_number, token: row.rma_token, inboundCarrier: 'ghn', inboundTrackingNumber: 'ABC123' });
  assert.equal(inbound.version, row.version + 1);
  const received = await updateRmaLogisticsByAdmin(f.pool, { caseId: row.id, inboundStatus: 'delivered_to_warehouse', restockEligible: true, actor: f.actor });
  assert.equal(received.version, inbound.version + 1);
  await assert.rejects(updateRmaInboundTracking(f.pool, { rmaNumber: row.rma_number, token: row.rma_token, inboundCarrier: 'ghtk', inboundTrackingNumber: 'REPLACE123' }), { status: 409 });
  const final = (await f.query('SELECT inbound_status,inbound_tracking_number FROM order_after_sales WHERE id=$1', [row.id])).rows[0];
  assert.deepEqual(final, { inbound_status: 'delivered_to_warehouse', inbound_tracking_number: 'ABC123' });
});

test('checkout persists idempotent response with the order and rolls back when response persistence fails', async t => {
  const f = await fixture(t);
  await f.query("UPDATE store_settings SET setting_value=$1 WHERE setting_key='shipping_rates'", [JSON.stringify({ 'Toàn quốc': 20000 })]);
  let failResponse = true;
  const pool = { query: f.query, connect: async () => ({ release() {}, query(sql, args) {
    if (failResponse && sql.includes("SET status = 'completed', order_id")) {
      failResponse = false;
      throw new Error('idempotent response persistence unavailable');
    }
    return f.query(sql, args);
  } }) };
  const router = createStoreApi(pool, { ordersEnabled: true, inventory, finance, audit: appendAudit });
  const handler = router.stack.find(layer => layer.route?.path === '/orders' && layer.route.methods.post).route.stack.at(-1).handle;
  const body = { customer: { name: 'Transaction Buyer', email: 'transaction@example.invalid', phone: '0900000000', address: 'Fixture Street', city: 'Hà Nội' }, paymentMethod: 'cod', idempotencyKey: 'transaction-failure-key', items: [{ variantId: f.variant.id, quantity: 2 }] };
  async function checkout() {
    let result, status = 200, error;
    await handler({ body, get: () => undefined, session: { customer: { id: f.customer.id } } }, {
      status(value) { status = value; return this; }, json(value) { result = value; return this; }
    }, e => { error = e; });
    if (error) throw error;
    return { status, result };
  }
  await assert.rejects(checkout(), /idempotent response persistence unavailable/);
  assert.equal((await f.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 0, 'failed checkout must leave no committed order');
  assert.equal((await f.query('SELECT stock_quantity FROM product_variants WHERE id=$1', [f.variant.id])).rows[0].stock_quantity, 10);
  const created = await checkout(), replay = await checkout();
  assert.equal(created.status, 201);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.result, JSON.parse(JSON.stringify(created.result)));
  assert.equal((await f.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 1);
  assert.equal((await f.query('SELECT stock_quantity FROM product_variants WHERE id=$1', [f.variant.id])).rows[0].stock_quantity, 8);
});

test('finance COD settlement rolls back the receipt and completion when loyalty policy is invalid', async t => {
  const f = await fixture(t), order = await f.order('shipped');
  await f.query("INSERT INTO store_settings(setting_key,setting_value) VALUES('loyalty_policy','{}')");
  const router = finance.createFinanceApi(f.pool);
  const handler = router.stack.find(layer => layer.route?.path === '/finance/customer-payments' && layer.route.methods.post).route.stack.at(-1).handle;
  const body = { orderId: order.id, amountVnd: 200000, method: 'cash', requestKey: 'finance-loyalty-audit' };
  let status = 200, error;
  await handler({ body, admin: f.actor }, { status(value) { status = value; return this; }, json() {} }, e => { error = e; });
  if (error) throw error;
  assert.equal(status, 503);
  assert.deepEqual(await f.state(order.id), { status: 'shipped', payment_status: 'pending' });
  assert.equal((await f.query('SELECT count(*)::int AS n FROM sales_receipts WHERE order_id=$1', [order.id])).rows[0].n, 0);
});

test('paid return closure requires authorized manual refund evidence and records it atomically', async t => {
  const f = await fixture(t), order = await f.order('completed');
  await f.query("UPDATE orders SET payment_status='paid' WHERE id=$1", [order.id]);
  const row = (await f.query("INSERT INTO order_after_sales(order_id,kind,status,reason,return_type) VALUES($1,'return','received','Faulty item','refund') RETURNING *", [order.id])).rows[0];
  const router = require('../src/order-after-sales').afterSalesRouter(f.pool);
  const handler = router.stack.find(layer => layer.route?.path === '/orders/after-sales/:id' && layer.route.methods.patch).route.stack.at(-1).handle;
  async function resolve(extra = {}, actor = f.actor) {
    let status = 200, result, error;
    await handler({ params: { id: row.id }, body: { version: 1, status: 'resolved', resolution: 'Đã đối soát giao dịch hoàn tiền', ...extra }, admin: actor }, {
      status(value) { status = value; return this; }, json(value) { result = value; return this; }
    }, e => { error = e; });
    return error ? { status: error.status || 500, error } : { status, result };
  }
  assert.equal((await resolve()).status, 409, 'a note alone cannot certify a paid refund');
  const manualRefund = { amountVnd: 200000, method: 'bank_transfer', reference: 'BANK-REFUND-200000', confirmedSent: true };
  assert.equal((await resolve({ manualRefund }, { ...f.actor, permissions: ['orders.write'] })).status, 403);
  assert.equal((await resolve({ manualRefund: { ...manualRefund, amountVnd: 199999 } })).status, 409);
  assert.equal((await f.query('SELECT status FROM order_after_sales WHERE id=$1', [row.id])).rows[0].status, 'received');
  const closed = await resolve({ manualRefund });
  assert.equal(closed.status, 200);
  assert.equal(closed.result.settlementScope, 'manual_refund_recorded');
  assert.equal(closed.result.refund_amount_vnd, 200000);
  const evidence = (await f.query("SELECT metadata FROM audit_events WHERE action='order.after_sales.update' AND entity_id=$1", [order.id])).rows[0].metadata;
  assert.deepEqual(evidence.manualRefund, manualRefund);
  await assert.rejects(updateRmaLogisticsByAdmin(f.pool, { caseId: row.id, restockEligible: true, actor: f.actor }), { status: 409 });
});

test('replacement shipment metadata cannot claim stock dispatch without a linked inventory document', async t => {
  const f = await fixture(t), order = await f.order('completed');
  const row = (await f.query("INSERT INTO order_after_sales(order_id,kind,status,reason,return_type) VALUES($1,'return','received','Faulty item','exchange') RETURNING *", [order.id])).rows[0];
  await assert.rejects(updateRmaLogisticsByAdmin(f.pool, { caseId: row.id, outboundCarrier: 'ghn', outboundTrackingNumber: 'REPLACEMENT123', outboundStatus: 'in_transit', actor: f.actor }), { status: 409 });
  assert.equal((await f.query('SELECT outbound_status FROM order_after_sales WHERE id=$1', [row.id])).rows[0].outbound_status, 'none');
  assert.equal((await f.query('SELECT stock_quantity FROM product_variants WHERE id=$1', [f.variant.id])).rows[0].stock_quantity, 8);
});
