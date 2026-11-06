'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { withTransaction } = require('../src/db');
const { migrateDatabase } = require('../src/migrate');
const { cancelCustomerOrder } = require('../src/customer-order-cancellation');
const { refundPoints, getOrCreateLoyalty } = require('../src/loyalty-api');
const inventory = require('../src/inventory');
const { checkReturnEligibility } = require('../src/order-after-sales');
const { afterSalesRouter } = require('../src/order-after-sales');

async function fixture(t) {
  const db = await PGlite.create();
  const pool = {
    async query(sql, params) {
      const result = !params && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, params);
      return { ...result, rowCount: result?.affectedRows ?? result?.rows?.length ?? 0, rows: result?.rows || [] };
    },
    async connect() { return { query: pool.query, release() {} }; }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);
  const customer = (await pool.query("INSERT INTO customers(email,full_name,phone) VALUES('audit@example.test','Audit Buyer','0912345678') RETURNING id")).rows[0];
  const product = (await pool.query("INSERT INTO products(name,slug,category,active) VALUES('Audit Product','audit-product','audio',true) RETURNING id")).rows[0];
  const variant = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'AUDIT-1','Default',100000,7,true) RETURNING id", [product.id])).rows[0];
  const warehouse = (await pool.query("SELECT id FROM warehouses WHERE code='MAIN'")).rows[0];
  await pool.query('INSERT INTO warehouse_stock(warehouse_id,variant_id,quantity) VALUES($1,$2,7)', [warehouse.id,variant.id]);
  const order = (await pool.query(`INSERT INTO orders(order_number,customer_id,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,total_vnd)
    VALUES('AUDIT-ORDER-1',$1,'Audit Buyer','audit@example.test','0912345678','1 Test Street','Ha Noi','cod','pending','pending',500000,500000) RETURNING id`, [customer.id])).rows[0];
  for (const quantity of [2,3]) await pool.query(`INSERT INTO order_items(order_id,variant_id,product_name,variant_name,sku,quantity,unit_price_vnd,line_total_vnd)
    VALUES($1,$2,'Audit Product','Default','AUDIT-1',$3,100000,$4)`, [order.id,variant.id,quantity,quantity*100000]);
  return { pool, customer, variant, warehouse, order };
}

test('Audit: rollback failure preserves original operation error and releases connection', async () => {
  const original = new Error('business operation failed');
  let released = false;
  const pool = { connect: async () => ({ query: async sql => { if (sql === 'ROLLBACK') throw new Error('connection lost'); }, release: () => { released = true; } }) };
  await assert.rejects(withTransaction(pool, async () => { throw original; }), error => error === original);
  assert.equal(released,true);
});

test('Audit: cancelling a legacy order restores the SUM of repeated SKU lines to both stock balances', async t => {
  const f = await fixture(t);
  await withTransaction(f.pool, client => cancelCustomerOrder(client, { orderId:f.order.id, customerId:f.customer.id, inventory }));
  const result = (await f.pool.query('SELECT v.stock_quantity,s.quantity FROM product_variants v JOIN warehouse_stock s ON s.variant_id=v.id WHERE v.id=$1', [f.variant.id])).rows[0];
  assert.equal(result.stock_quantity,12);
  assert.equal(result.quantity,12);
  const moves = (await f.pool.query("SELECT SUM(delta)::int AS delta FROM inventory_movements WHERE reference_id=$1", [f.order.id])).rows[0];
  assert.equal(moves.delta,5);
  await assert.rejects(withTransaction(f.pool, client => cancelCustomerOrder(client, { orderId:f.order.id, customerId:f.customer.id, inventory })), {status:409});
  assert.equal((await f.pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[f.variant.id])).rows[0].stock_quantity,12);
});

test('Audit: loyalty refund failure rolls back cancellation and stock movements', async t => {
  const f = await fixture(t);
  await assert.rejects(withTransaction(f.pool, client => {
    const broken = { query: (sql, params) => {
      if (sql.includes('FROM customer_loyalty_ledger')) throw new Error('loyalty refund unavailable');
      return client.query(sql,params);
    } };
    return cancelCustomerOrder(broken, { orderId:f.order.id,customerId:f.customer.id,inventory });
  }), /loyalty refund unavailable/);
  assert.equal((await f.pool.query('SELECT status FROM orders WHERE id=$1',[f.order.id])).rows[0].status,'pending');
  assert.equal((await f.pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[f.variant.id])).rows[0].stock_quantity,7);
});

test('Audit: audit-log failure rolls back cancellation instead of returning success', async t => {
  const f = await fixture(t);
  await assert.rejects(withTransaction(f.pool, client => cancelCustomerOrder(client, {
    orderId:f.order.id,customerId:f.customer.id,inventory,audit:async()=>{throw new Error('audit unavailable');}
  })), /audit unavailable/);
  assert.equal((await f.pool.query('SELECT status FROM orders WHERE id=$1',[f.order.id])).rows[0].status,'pending');
});

test('Audit: zero-balance earned-points reversal is recorded exactly once across retries', async t => {
  const f = await fixture(t);
  await f.pool.query('INSERT INTO customer_loyalty(customer_id,points_balance,lifetime_earned,lifetime_spent) VALUES($1,0,200,200)',[f.customer.id]);
  await f.pool.query("INSERT INTO customer_loyalty_ledger(customer_id,order_id,type,points,balance_after,reason,event_key) VALUES($1,$2,'earn',100,100,'Original earning',$3)",[f.customer.id,f.order.id,'earn:'+f.order.id]);
  const first = await withTransaction(f.pool, c => refundPoints(c,{customerId:f.customer.id,orderId:f.order.id}));
  assert.equal(first.unrecoveredEarn,100);
  await withTransaction(f.pool,c=>refundPoints(c,{customerId:f.customer.id,orderId:f.order.id}));
  const account = (await f.pool.query('SELECT points_balance,lifetime_earned FROM customer_loyalty WHERE customer_id=$1',[f.customer.id])).rows[0];
  assert.equal(account.lifetime_earned,100);
  assert.equal(account.points_balance,0);
  assert.equal((await f.pool.query('SELECT COUNT(*)::int AS count FROM customer_loyalty_ledger WHERE event_key=$1',['refund-earn:'+f.order.id])).rows[0].count,1);
});

test('Audit: an invalid delivery timestamp never qualifies an order for a return', () => {
  assert.equal(checkReturnEligibility({status:'completed',updated_at:'invalid-date'}).eligible,false);
});

test('Audit: a future delivery timestamp never extends the seven-day return window', () => {
  const result=checkReturnEligibility({status:'completed',updated_at:new Date(Date.now()+86400000).toISOString()});
  assert.equal(result.eligible,false);
});

test('Audit: editing a completed order does not restart its return window', () => {
  const result=checkReturnEligibility({status:'completed',delivered_at:new Date(Date.now()-10*86400000).toISOString(),updated_at:new Date().toISOString()});
  assert.equal(result.eligible,false);
  assert.equal(result.code,'RETURN_WINDOW_EXPIRED');
});

test('Audit: carrier resynchronization does not restart its return window', () => {
  const result=checkReturnEligibility({status:'completed',updated_at:new Date().toISOString()},null,null,{
    status:'delivered',delivered_at:new Date(Date.now()-10*86400000).toISOString(),last_synced_at:new Date().toISOString()
  });
  assert.equal(result.eligible,false);
  assert.equal(result.code,'RETURN_WINDOW_EXPIRED');
});

test('Audit: loyalty initialization tolerates another transaction creating the account after selection', async t => {
  const f=await fixture(t);
  await f.pool.query('INSERT INTO customer_loyalty(customer_id,points_balance,lifetime_earned,lifetime_spent) VALUES($1,150,150,0)',[f.customer.id]);
  let first=true;
  const client={query:(sql,params)=>{
    if(first&&sql.includes('FROM customer_loyalty WHERE customer_id')){first=false;return {rows:[]};}
    return f.pool.query(sql,params);
  }};
  assert.equal((await getOrCreateLoyalty(client,f.customer.id)).pointsBalance,150);
});

async function returnedCase(f) {
  await f.pool.query("UPDATE orders SET status='completed',payment_status='paid' WHERE id=$1",[f.order.id]);
  return (await f.pool.query(`INSERT INTO order_after_sales(order_id,kind,status,reason,return_type,restock_eligible)
    VALUES($1,'return','received','Faulty product','refund',true) RETURNING id,version`,[f.order.id])).rows[0];
}

async function resolveReturn(pool, row) {
  const router=afterSalesRouter(pool);
  const handler=router.stack.find(layer=>layer.route?.path==='/orders/after-sales/:id'&&layer.route.methods.patch).route.stack.at(-1).handle;
  let error;
  await handler({params:{id:row.id},body:{version:row.version,status:'resolved',resolution:'Goods inspected and refund approved',manualRefund:{amountVnd:500000,method:'bank_transfer',reference:'FIXTURE-REFUND-1',confirmedSent:true}},admin:{username:'audit-owner',role:'owner',source:'bootstrap',permissions:['orders.write','payments.write','inventory.approve']}},
    {json:()=>{},status(){return this;}}, e=>{error=e;});
  if(error)throw error;
}

test('Audit: after-sales resolution rolls back when its loyalty refund fails', async t => {
  const f=await fixture(t),row=await returnedCase(f);
  const brokenPool={connect:async()=>{
    const client=await f.pool.connect();
    return {release:client.release,query:(sql,params)=>{
      if(sql.includes('FROM customer_loyalty_ledger'))throw new Error('return loyalty unavailable');
      return client.query(sql,params);
    }};
  }};
  await assert.rejects(resolveReturn(brokenPool,row),/return loyalty unavailable/);
  assert.equal((await f.pool.query('SELECT status FROM order_after_sales WHERE id=$1',[row.id])).rows[0].status,'received');
  assert.equal((await f.pool.query('SELECT return_completed_at FROM orders WHERE id=$1',[f.order.id])).rows[0].return_completed_at,null);
});

test('Audit: after-sales resolution rolls back when stock reconciliation fails', async t => {
  const f=await fixture(t),row=await returnedCase(f);
  await f.pool.query('UPDATE warehouse_stock SET quantity=6 WHERE variant_id=$1',[f.variant.id]);
  await assert.rejects(resolveReturn(f.pool,row),{status:409});
  assert.equal((await f.pool.query('SELECT status FROM order_after_sales WHERE id=$1',[row.id])).rows[0].status,'received');
});

test('Audit: delivery clocks survive shipment polling, order edits and repeated migration', async t => {
  const f=await fixture(t);
  const timestamp='2026-10-01T12:00:00.000Z';
  await f.pool.query(`INSERT INTO carrier_shipments(order_id,carrier_id,tracking_number,status,delivered_at)
    VALUES($1,'viettel','AUDIT-TRACK-1','delivered',$2)`,[f.order.id,timestamp]);
  await f.pool.query("UPDATE carrier_shipments SET status='delivered',last_synced_at=now(),updated_at=now(),delivered_at=now() WHERE order_id=$1",[f.order.id]);
  await f.pool.query("UPDATE orders SET status='completed',payment_status='paid',updated_at=now(),delivered_at=now() WHERE id=$1",[f.order.id]);
  await migrateDatabase(f.pool);
  const result=(await f.pool.query('SELECT delivered_at FROM orders WHERE id=$1',[f.order.id])).rows[0];
  assert.equal(new Date(result.delivered_at).toISOString(),timestamp);
  const shipped=(await f.pool.query('SELECT delivered_at FROM carrier_shipments WHERE order_id=$1',[f.order.id])).rows[0];
  assert.equal(new Date(shipped.delivered_at).toISOString(),timestamp);
});
