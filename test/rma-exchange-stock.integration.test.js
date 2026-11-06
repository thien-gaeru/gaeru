'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const inventory = require('../src/inventory');
const { withTransaction } = require('../src/db');
const { appendAudit } = require('../src/audit');
const { issueExchange, voidExchange, exchangeOptions } = require('../src/rma-exchange');
const { createRmaApi, updateRmaLogisticsByAdmin } = require('../src/rma-tickets');
const { afterSalesRouter } = require('../src/order-after-sales');
const { deleteOrderPermanently } = require('../src/order-deletion');

async function fixture(t) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() { const before = queue; let release; queue = new Promise(r => { release = r; }); await before; return release; }
  async function query(sql, args) { const result = !args && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, args); return { ...result, rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 }; }
  const pool = { async query(sql, args) { const release = await lock(); try { return await query(sql, args); } finally { release(); } }, async connect() { const release = await lock(); return { query, release }; } };
  await migrateDatabase(pool);
  const actor = { username: 'rma-owner', role: 'owner', source: 'bootstrap', permissions: ['orders.read', 'orders.write', 'inventory.read', 'inventory.approve', 'payments.write'] };
  const product = (await pool.query("INSERT INTO products(name,slug,category,active) VALUES('RMA Fixture','rma-exchange-fixture','audio',true) RETURNING id")).rows[0];
  const warehouse = (await pool.query("SELECT id FROM warehouses WHERE code='MAIN'")).rows[0];
  const variants = [];
  for (const [sku, price] of [['RMA-ORIGINAL', 100000], ['RMA-REPLACEMENT', 100000], ['RMA-EXPENSIVE', 110000]]) {
    const variant = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,$2,$2,$3,10,true) RETURNING *", [product.id, sku, price])).rows[0];
    await withTransaction(pool, c => inventory.initializeVariantStock(c, { variantId: variant.id, quantity: 10, actor }));
    variants.push(variant);
  }
  const order = (await pool.query("INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,status,payment_status,subtotal_vnd,shipping_fee_vnd,total_vnd) VALUES('RMA-EXCHANGE-ORDER','RMA Buyer','rma@example.invalid','0900000000','Fixture Street','Hà Nội','cod','completed','paid',200000,0,200000) RETURNING *")).rows[0];
  const items = [];
  for (const quantity of [1, 1]) items.push((await pool.query("INSERT INTO order_items(order_id,variant_id,product_name,variant_name,sku,unit_price_vnd,quantity,line_total_vnd) VALUES($1,$2,'RMA Fixture','Original','RMA-ORIGINAL',100000,$3,$4) RETURNING *", [order.id, variants[0].id, quantity, quantity * 100000])).rows[0]);
  await withTransaction(pool, c => inventory.reserveStock(c, { orderId: order.id, variantId: variants[0].id, quantity: 2, actor }));
  const row = (await pool.query("INSERT INTO order_after_sales(order_id,kind,return_type,status,reason,rma_number,inbound_status,inspection_notes) VALUES($1,'return','exchange','received','Original item faulty','RMA-261103-X001','delivered_to_warehouse','Đã nhận đủ và thẩm định lỗi kỹ thuật') RETURNING *", [order.id])).rows[0];
  const state = async () => (await pool.query('SELECT * FROM order_after_sales WHERE id=$1', [row.id])).rows[0];
  const stock = async id => (await pool.query('SELECT v.stock_quantity,s.quantity FROM product_variants v JOIN warehouse_stock s ON s.variant_id=v.id WHERE v.id=$1 AND s.warehouse_id=$2', [id, warehouse.id])).rows[0];
  const body = (version = 1) => ({ version, requestKey: randomUUID(), warehouseId: warehouse.id, confirmedReceivedAll: true, reason: 'Xuất đổi mới sau khi kiểm tra đầy đủ', items: items.map(item => ({ orderItemId: item.id, replacementVariantId: variants[1].id, quantity: item.quantity })) });
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.session = { csrfToken: 'rma-fixture' }; req.admin = { ...actor, permissions: req.get('X-Readonly') ? ['orders.read', 'orders.write', 'inventory.read'] : actor.permissions }; next(); });
  app.use('/api/gaeru_ceo', createRmaApi(pool).admin); app.use('/api/gaeru_ceo', afterSalesRouter(pool)); app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); await db.close(); });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/gaeru_ceo/orders/after-sales/' + row.id;
  const api = async (path, method = 'GET', data, headers = {}) => { const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'rma-fixture', ...headers }, body: data ? JSON.stringify(data) : undefined }); return { status: response.status, data: await response.json() }; };
  return { pool, actor, warehouse, variants, order, items, row, body, state, stock, api };
}

test('RMA full-order exchange issues stock once, records linked proof, advances delivery and closes without changing sale or points', async t => {
  const f = await fixture(t), body = f.body();
  const options = await f.api('/exchange-options'); assert.equal(options.status, 200); assert.equal(options.data.eligible, true); assert.equal(options.data.items.length, 2); assert.equal(options.data.items[0].candidates.some(v => v.variantId === f.variants[2].id), false);
  assert.equal((await f.api('/exchange-issue', 'POST', body, { 'X-Readonly': '1' })).status, 403);
  assert.equal((await f.api('/exchange-issue', 'POST', body, { 'X-CSRF-Token': 'wrong' })).status, 403);
  const created = await f.api('/exchange-issue', 'POST', body); assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.issue.items.length, 2); assert.equal(created.data.version, 2);
  assert.deepEqual(await f.stock(f.variants[1].id), { stock_quantity: 8, quantity: 8 });
  assert.equal((await f.api('/exchange-issue', 'POST', body)).data.existing, true);
  assert.equal((await f.api('/exchange-issue', 'POST', { ...body, reason: 'Khác nội dung cùng mã yêu cầu' })).status, 409);
  const close = version => f.api('', 'PATCH', { version, status: 'resolved', resolution: 'Đã đối chiếu hàng giao đổi hoàn tất' });
  assert.equal((await close(2)).status, 409);
  assert.equal((await f.api('/logistics', 'PATCH', { version: 1, outboundStatus: 'in_transit', outboundCarrier: 'viettel', outboundTrackingNumber: 'RMA-TRACK-1' })).status, 409);
  assert.equal((await f.api('/logistics', 'PATCH', { version: 2, outboundStatus: 'delivered', outboundCarrier: 'viettel', outboundTrackingNumber: 'RMA-TRACK-1' })).status, 409);
  assert.equal((await f.api('/logistics', 'PATCH', { version: 2, outboundStatus: 'in_transit' })).status, 409);
  assert.equal((await f.api('/logistics', 'PATCH', { version: 2, outboundStatus: 'in_transit', outboundCarrier: 'viettel', outboundTrackingNumber: 'RMA-TRACK-1' })).status, 200);
  assert.equal((await f.api('/exchange-issue/void', 'POST', { version: 3, requestKey: randomUUID(), issueId: created.data.issue.id, reason: 'Không được hoàn lại khi đang giao' })).status, 409);
  assert.equal((await f.api('/logistics', 'PATCH', { version: 3, outboundTrackingNumber: 'CHANGED-TRACK' })).status, 409);
  assert.equal((await f.api('/logistics', 'PATCH', { version: 3, outboundStatus: 'delivered' })).status, 200);
  assert.equal((await close(4)).status, 200);
  assert.equal((await close(4)).status, 409);
  assert.deepEqual((await f.pool.query('SELECT total_vnd,payment_status,return_completed_at FROM orders WHERE id=$1', [f.order.id])).rows[0], { total_vnd: 200000, payment_status: 'paid', return_completed_at: null });
  assert.equal((await f.pool.query('SELECT COUNT(*)::int AS n FROM customer_loyalty_ledger')).rows[0].n, 0);
  assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM inventory_movements WHERE event_key LIKE 'adjustment:rma-issue:%'")).rows[0].n, 1, 'repeated original SKU lines share one atomic summed movement');
  assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM audit_events WHERE action='rma.exchange.issue'")).rows[0].n, 1);
});

test('RMA exchange rejects unreceived goods, partial quantities, price differences, foreign products, stale versions and insufficient stock atomically', async t => {
  const f = await fixture(t);
  const reject = async (body, status = 409) => assert.equal((await f.api('/exchange-issue', 'POST', body)).status, status);
  await f.pool.query("UPDATE order_after_sales SET inbound_status='in_transit' WHERE id=$1", [f.row.id]); await reject(f.body());
  await f.pool.query("UPDATE order_after_sales SET inbound_status='delivered_to_warehouse',inspection_notes='' WHERE id=$1", [f.row.id]); await reject(f.body());
  await f.pool.query("UPDATE order_after_sales SET inspection_notes='Đã kiểm tra đầy đủ' WHERE id=$1", [f.row.id]);
  await reject({ ...f.body(), items: f.body().items.slice(0, 1) });
  await reject({ ...f.body(), items: f.body().items.map(item => ({ ...item, quantity: 2 })) });
  await reject({ ...f.body(), items: f.body().items.map(item => ({ ...item, replacementVariantId: f.variants[2].id })) });
  const foreignProduct = (await f.pool.query("INSERT INTO products(name,slug,category,active) VALUES('Other Product','rma-other-product','audio',true) RETURNING id")).rows[0];
  const foreignVariant = (await f.pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'RMA-FOREIGN','Foreign same price',100000,10,true) RETURNING id", [foreignProduct.id])).rows[0];
  await reject({ ...f.body(), items: f.body().items.map(item => ({ ...item, replacementVariantId: foreignVariant.id })) });
  await reject(f.body(9));
  await f.pool.query('UPDATE warehouse_stock SET quantity=1 WHERE variant_id=$1', [f.variants[1].id]); await f.pool.query('UPDATE product_variants SET stock_quantity=1 WHERE id=$1', [f.variants[1].id]);
  await reject(f.body()); assert.deepEqual(await f.stock(f.variants[1].id), { stock_quantity: 1, quantity: 1 });
  assert.equal((await f.pool.query('SELECT COUNT(*)::int AS n FROM rma_exchange_issues')).rows[0].n, 0);
  assert.equal((await f.state()).version, 1);
});

test('RMA issue and void replay safely; concurrent requests cannot double-issue and a corrected replacement can be posted', async t => {
  const f = await fixture(t), body = f.body();
  const concurrent = await Promise.allSettled([issueExchange(f.pool, { caseId: f.row.id, data: body, actor: f.actor }), issueExchange(f.pool, { caseId: f.row.id, data: f.body(), actor: f.actor })]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1);
  const first = concurrent.find(result => result.status === 'fulfilled').value;
  const data = { version: 2, requestKey: randomUUID(), issueId: first.issue.id, reason: 'Hoàn lại trước giao để đổi phiên bản' };
  const results = await Promise.all([voidExchange(f.pool, { caseId: f.row.id, data, actor: f.actor }), voidExchange(f.pool, { caseId: f.row.id, data, actor: f.actor })]);
  assert.equal(results.filter(result => result.existing).length, 1); assert.deepEqual(await f.stock(f.variants[1].id), { stock_quantity: 10, quantity: 10 });
  assert.equal((await f.state()).outbound_status, 'none');
  const corrected = await issueExchange(f.pool, { caseId: f.row.id, data: f.body(3), actor: f.actor }); assert.equal(corrected.version, 4);
  assert.deepEqual(await f.stock(f.variants[1].id), { stock_quantity: 8, quantity: 8 });
  assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM rma_exchange_issues WHERE status='posted'")).rows[0].n, 1);
});

test('RMA issue rolls back movement, document and version when audit persistence fails', async t => {
  const f = await fixture(t);
  const broken = { connect: async () => { const client = await f.pool.connect(); return { release: client.release, query(sql, values) { if (sql.includes('INSERT INTO audit_events')) throw new Error('audit unavailable'); return client.query(sql, values); } }; } };
  await assert.rejects(issueExchange(broken, { caseId: f.row.id, data: f.body(), actor: f.actor }), /audit unavailable/);
  assert.deepEqual(await f.stock(f.variants[1].id), { stock_quantity: 10, quantity: 10 });
  assert.equal((await f.pool.query('SELECT COUNT(*)::int AS n FROM rma_exchange_issues')).rows[0].n, 0);
  assert.equal((await f.state()).version, 1);
});

test('RMA multivariant issue rolls back an earlier stock movement if a later replacement is unavailable', async t => {
  const f = await fixture(t), sorted = [f.variants[0], f.variants[1]].sort((a, b) => a.id.localeCompare(b.id));
  const firstBefore = await f.stock(sorted[0].id);
  await f.pool.query('UPDATE warehouse_stock SET quantity=0 WHERE variant_id=$1', [sorted[1].id]);
  await f.pool.query('UPDATE product_variants SET stock_quantity=0 WHERE id=$1', [sorted[1].id]);
  const body = f.body(); body.items = f.items.map((item, i) => ({ orderItemId: item.id, replacementVariantId: sorted[i].id, quantity: 1 }));
  assert.equal((await f.api('/exchange-issue', 'POST', body)).status, 409);
  assert.deepEqual(await f.stock(sorted[0].id), firstBefore);
  assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM inventory_movements WHERE event_key LIKE 'adjustment:rma-issue:%'")).rows[0].n, 0);
  assert.equal((await f.pool.query('SELECT COUNT(*)::int AS n FROM rma_exchange_issues')).rows[0].n, 0);
});

test('exchange closure restocks only approved original goods once and keeps replacement issue stock consumed', async t => {
  const f = await fixture(t);
  await f.pool.query('UPDATE order_after_sales SET restock_eligible=true WHERE id=$1', [f.row.id]);
  await issueExchange(f.pool, { caseId: f.row.id, data: f.body(), actor: f.actor });
  await updateRmaLogisticsByAdmin(f.pool, { caseId: f.row.id, version: 2, outboundStatus: 'in_transit', outboundCarrier: 'viettel', outboundTrackingNumber: 'EXCHANGE-APPROVED-1', actor: f.actor });
  await updateRmaLogisticsByAdmin(f.pool, { caseId: f.row.id, version: 3, outboundStatus: 'delivered', actor: f.actor });
  const close = () => f.api('', 'PATCH', { version: 4, status: 'resolved', resolution: 'Khách đã nhận đủ hàng đổi mới' });
  assert.equal((await close()).status, 200); assert.equal((await close()).status, 409);
  assert.deepEqual(await f.stock(f.variants[0].id), { stock_quantity: 10, quantity: 10 });
  assert.deepEqual(await f.stock(f.variants[1].id), { stock_quantity: 8, quantity: 8 });
  assert.ok((await f.state()).restocked_at);
});

test('RMA restock flag and saleable stock restoration require inventory approval', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/logistics', 'PATCH', { version: 1, restockEligible: true }, { 'X-Readonly': '1' })).status, 403);
  assert.equal((await f.state()).restock_eligible, false);
  await f.pool.query('UPDATE order_after_sales SET restock_eligible=true WHERE id=$1', [f.row.id]);
  await issueExchange(f.pool, { caseId: f.row.id, data: f.body(), actor: f.actor });
  await updateRmaLogisticsByAdmin(f.pool, { caseId: f.row.id, version: 2, outboundStatus: 'in_transit', outboundCarrier: 'viettel', outboundTrackingNumber: 'EXCHANGE-APPROVAL-1', actor: f.actor });
  await updateRmaLogisticsByAdmin(f.pool, { caseId: f.row.id, version: 3, outboundStatus: 'delivered', actor: f.actor });
  assert.equal((await f.api('', 'PATCH', { version: 4, status: 'resolved', resolution: 'Chưa có quyền duyệt tái nhập kho' }, { 'X-Readonly': '1' })).status, 403);
  assert.equal((await f.state()).status, 'received');
  assert.deepEqual(await f.stock(f.variants[0].id), { stock_quantity: 8, quantity: 8 });
});

test('permanent deletion preserves open replacement stock proof until pre-dispatch void or completed delivery', async t => {
  const f = await fixture(t), issued = await issueExchange(f.pool, { caseId: f.row.id, data: f.body(), actor: f.actor });
  const remove = () => withTransaction(f.pool, client => deleteOrderPermanently(client, f.order.id, { inventory, actor: f.actor }));
  await assert.rejects(remove(), { status: 409 });
  assert.equal((await f.state()).status, 'received');
  assert.equal((await f.pool.query("SELECT COUNT(*)::int AS n FROM rma_exchange_issues WHERE status='posted'")).rows[0].n, 1);
  assert.deepEqual(await f.stock(f.variants[1].id), { stock_quantity: 8, quantity: 8 });
  await voidExchange(f.pool, { caseId: f.row.id, data: { version: 2, requestKey: randomUUID(), issueId: issued.issue.id, reason: 'Hủy xuất trước khi xóa đơn theo yêu cầu' }, actor: f.actor });
  await remove();
  assert.equal((await f.pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE id=$1', [f.order.id])).rows[0].n, 0);
  assert.deepEqual(await f.stock(f.variants[1].id), { stock_quantity: 10, quantity: 10 });
});
