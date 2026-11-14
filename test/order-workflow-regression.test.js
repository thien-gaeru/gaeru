'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const express = require('express');
const {PGlite} = require('@electric-sql/pglite');
const {migrateDatabase} = require('../src/migrate');
const {withTransaction} = require('../src/db');
const inventory = require('../src/inventory');
const finance = require('../src/finance-api');
const {appendAudit} = require('../src/audit');
const {createStoreApi} = require('../src/store-api');
const {createInternalAiRouter} = require('../src/internal-ai');
const shipping = require('../src/shipping-management');
const {getAdapter} = require('../src/shipping-adapters');

async function fixture(t) {
  const db = await PGlite.create();
  let queue = Promise.resolve(), connections = 0;
  async function lock() {const previous=queue;let release;queue=new Promise(r=>release=r);await previous;return release;}
  async function query(sql,values) {const r=!values&&sql.includes(';')?(await db.exec(sql)).at(-1):await db.query(sql,values);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};}
  const pool = {
    async query(sql,values){const release=await lock();try{return await query(sql,values);}finally{release();}},
    async connect(){const release=await lock();connections++;return {query,release(){connections--;release();}};}
  };
  await migrateDatabase(pool);
  const actor={username:'workflow-owner',role:'owner',source:'bootstrap',permissions:['orders.read','orders.write','payments.write']};
  const customer=(await pool.query("INSERT INTO customers(full_name,email,phone) VALUES('Workflow Buyer','workflow@example.invalid','0900000000') RETURNING id")).rows[0];
  const product=(await pool.query("INSERT INTO products(slug,name,category,active) VALUES('workflow-product','Workflow Product','audio',true) RETURNING id")).rows[0];
  const variant=(await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'WORKFLOW-SKU','Default',100000,20,true) RETURNING id",[product.id])).rows[0];
  await withTransaction(pool,c=>inventory.initializeVariantStock(c,{variantId:variant.id,quantity:20,actor}));
  const app=express();app.use(express.json());app.use((q,r,n)=>{q.admin=actor;q.session={admin:{username:actor.username},csrfToken:'workflow-csrf'};n();});
  const config={NODE_ENV:'test',SESSION_SECRET:'synthetic-workflow-secret-32-characters'};
  app.use('/api',createStoreApi(pool,{config,inventory,finance,audit:appendAudit,checkoutAccounts:true}));
  app.use('/ai',createInternalAiRouter(pool,config));
  app.use((e,q,r,n)=>r.status(e.status||500).json({error:e.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();});
  const base='http://127.0.0.1:'+server.address().port;
  async function api(path,body={},method='POST'){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':'workflow-csrf'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
  async function order(method='cod',reserve=true) {
    const row=(await pool.query(`INSERT INTO orders(order_number,customer_id,customer_name,email,phone,address,city,payment_method,status,subtotal_vnd,shipping_fee_vnd,total_vnd)
      VALUES($1,$2,'Workflow Buyer','workflow@example.invalid','0900000000','Test Street','Hà Nội',$3,'pending',100000,0,100000) RETURNING *`,['GR-20261110-'+randomUUID().slice(0,8).toUpperCase(),customer.id,method])).rows[0];
    await pool.query("INSERT INTO order_items(order_id,variant_id,product_name,variant_name,sku,unit_price_vnd,quantity,line_total_vnd) VALUES($1,$2,'Workflow Product','Default','WORKFLOW-SKU',100000,1,100000)",[row.id,variant.id]);
    if(reserve)await withTransaction(pool,c=>inventory.reserveStock(c,{variantId:variant.id,quantity:1,orderId:row.id,actor}));
    return row;
  }
  async function action(type,o){return (await pool.query("INSERT INTO internal_ai_action_logs(action_type,payload,created_by) VALUES($1,$2,'admin') RETURNING id",[type,{orderId:o.id,orderNumber:o.order_number}])).rows[0].id;}
  async function shipment(o,carrier='viettel'){return (await pool.query("INSERT INTO carrier_shipments(order_id,carrier_id,tracking_number,status,cod_amount_vnd,cod_settlement_status) VALUES($1,$2,$3,'created',100000,'unsettled') RETURNING *",[o.id,carrier,'TRACK-'+randomUUID()])).rows[0];}
  const stock=async()=>Number((await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[variant.id])).rows[0].stock_quantity);
  const current=async o=>(await pool.query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
  function stubCarrier(fn){const adapter=getAdapter('viettel'),original=adapter.cancelWaybill;adapter.cancelWaybill=fn;t.after(()=>{adapter.cancelWaybill=original;});}
  return {pool,api,order,action,shipment,stock,current,customer,variant,actor,stubCarrier,connections:()=>connections};
}

test('AI confirmation uses the same payment and review gates, and reserves real stock',async t=>{
  const f=await fixture(t),unpaid=await f.order('bank_transfer');
  assert.equal((await f.api('/api/gaeru_ceo/orders/'+unpaid.id,{status:'processing'},'PATCH')).status,409);
  const action=await f.action('confirm_order',unpaid);
  const rejected=await f.api('/ai/actions/'+action+'/execute');assert.equal(rejected.status,409);assert.match(rejected.data.error,/trả trước/);
  assert.equal((await f.current(unpaid)).status,'pending');
  const review=await f.order();await f.pool.query("INSERT INTO order_reviews(order_id,reason) VALUES($1,'audit-review')",[review.id]);
  assert.equal((await f.api('/ai/actions/'+await f.action('confirm_order',review)+'/execute')).status,409);
  const cod=await f.order('cod',false),before=await f.stock();
  assert.equal((await f.api('/ai/actions/'+await f.action('confirm_order',cod)+'/execute')).status,200);
  assert.equal((await f.current(cod)).status,'processing');assert.equal(await f.stock(),before-1);
  assert.equal((await f.pool.query('SELECT quantity FROM order_stock_allocations WHERE order_id=$1',[cod.id])).rows[0].quantity,1);
});

test('AI cancellation atomically restores stock, Xu, voucher quota and expires payment attempts once',async t=>{
  const f=await fixture(t),o=await f.order('bank_transfer');
  await f.pool.query('INSERT INTO customer_loyalty(customer_id,points_balance,lifetime_earned,lifetime_spent) VALUES($1,0,1000,1000)',[f.customer.id]);
  await f.pool.query("INSERT INTO customer_loyalty_ledger(customer_id,order_id,type,points,balance_after,reason,event_key) VALUES($1,$2,'redeem',-1000,0,'Used on order',$3)",[f.customer.id,o.id,'redeem:'+o.id]);
  const voucher=(await f.pool.query("INSERT INTO marketing_vouchers(code,title,kind,amount,starts_at,ends_at,total_limit,active) VALUES('WORKFLOW','Test voucher','fixed',1000,now()-interval '1 day',now()+interval '1 day',10,true) RETURNING id")).rows[0];
  await f.pool.query("UPDATE orders SET voucher_code='WORKFLOW',discount_vnd=2000,total_vnd=98000 WHERE id=$1",[o.id]);
  await f.pool.query('INSERT INTO voucher_redemptions(order_id,voucher_id,customer_id,discount_vnd) VALUES($1,$2,$3,1000)',[o.id,voucher.id,f.customer.id]);
  await f.pool.query("INSERT INTO payment_attempts(order_id,provider,transaction_ref,amount_vnd,status,expires_at) VALUES($1,'bank_transfer',$2,98000,'pending',now()+interval '1 hour')",[o.id,o.order_number]);
  const id=await f.action('cancel_order',o),before=await f.stock();
  assert.equal((await f.api('/ai/actions/'+id+'/execute')).status,200);
  assert.equal((await f.current(o)).status,'cancelled');assert.equal(await f.stock(),before+1);
  const loyalty=(await f.pool.query('SELECT points_balance,lifetime_spent FROM customer_loyalty WHERE customer_id=$1',[f.customer.id])).rows[0];
  assert.equal(loyalty.points_balance,1000);assert.equal(loyalty.lifetime_spent,0);
  assert.equal((await f.pool.query('SELECT released FROM voucher_redemptions WHERE order_id=$1',[o.id])).rows[0].released,true);
  assert.equal((await f.pool.query('SELECT status FROM payment_attempts WHERE order_id=$1',[o.id])).rows[0].status,'failed');
  assert.equal((await f.api('/ai/actions/'+id+'/execute')).status,400);
  assert.equal(await f.stock(),before+1);
  assert.equal((await f.pool.query("SELECT count(*)::int AS count FROM customer_loyalty_ledger WHERE order_id=$1 AND type='refund'",[o.id])).rows[0].count,1);
});

test('single-order cancellation calls the actual carrier workflow outside DB transactions; bulk never fakes it',async t=>{
  const f=await fixture(t),o=await f.order();await f.shipment(o);let calls=0;
  f.stubCarrier(async()=>{calls++;assert.equal(f.connections(),0);return {success:true};});
  assert.equal((await f.api('/api/gaeru_ceo/orders/'+o.id,{status:'cancelled'},'PATCH')).status,409);
  assert.equal((await f.api('/api/gaeru_ceo/orders/bulk',{action:'cancel',orders:[{id:o.id,expectedStatus:'pending',expectedPaymentStatus:'pending',expectedTotalVnd:100000}]})).status,409);
  assert.equal(calls,0);
  const before=await f.stock(),r=await f.api('/api/gaeru_ceo/orders/'+o.id,{status:'cancelled',cancelActiveWaybill:true},'PATCH');
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(calls,1);assert.equal(await f.stock(),before+1);
  const s=(await f.pool.query('SELECT status,tracking_history FROM carrier_shipments WHERE order_id=$1',[o.id])).rows[0];
  assert.equal(s.status,'cancelled');assert.equal(s.tracking_history.at(-1).rawStatus,'cancelled_by_shop');
});

test('invalid combined cancellation rejects excessive totals before contacting the carrier',async t=>{
  const f=await fixture(t),o=await f.order();await f.shipment(o);const before=await f.stock();let calls=0;
  await f.pool.query('UPDATE orders SET subtotal_vnd=1500000000,total_vnd=1500000000 WHERE id=$1',[o.id]);
  f.stubCarrier(async()=>{calls++;return {success:true};});
  const r=await f.api('/api/gaeru_ceo/orders/'+o.id,{status:'cancelled',cancelActiveWaybill:true,shippingFeeVnd:1000000000},'PATCH');
  assert.equal(r.status,400);assert.match(r.data.error,/Tổng đơn hàng vượt giới hạn/);assert.equal(calls,0);
  const current=await f.current(o);
  assert.equal(current.status,'pending');assert.equal(current.shipping_fee_vnd,0);assert.equal(current.total_vnd,1500000000);
  assert.equal(await f.stock(),before);
  assert.equal((await f.pool.query('SELECT status FROM carrier_shipments WHERE order_id=$1',[o.id])).rows[0].status,'created');
  assert.equal((await f.pool.query('SELECT released_at FROM order_stock_allocations WHERE order_id=$1',[o.id])).rows[0].released_at,null);
});

test('AI cancellation preserves order and stock on definitive or ambiguous carrier failure',async t=>{
  const f=await fixture(t);let mode='reject';
  f.stubCarrier(async()=>{assert.equal(f.connections(),0);if(mode==='reject')throw Object.assign(Error('Carrier rejected'),{status:400,definitiveRejection:true});throw Error('Synthetic timeout');});
  for(const [state,expectedHttp,expectedShipment] of [['reject',400,'created'],['unknown',502,'cancel_reconciliation_required']]){
    mode=state;const o=await f.order();await f.shipment(o);const before=await f.stock();
    const r=await f.api('/ai/actions/'+await f.action('cancel_order',o)+'/execute');assert.equal(r.status,expectedHttp,JSON.stringify(r.data));
    assert.equal((await f.current(o)).status,'pending');assert.equal(await f.stock(),before);
    assert.equal((await f.pool.query('SELECT status FROM carrier_shipments WHERE order_id=$1',[o.id])).rows[0].status,expectedShipment);
  }
});

test('final cancellation rechecks a payment received while the carrier request was in flight',async t=>{
  const f=await fixture(t),o=await f.order();await f.shipment(o);const before=await f.stock();
  f.stubCarrier(async()=>{assert.equal(f.connections(),0);await f.pool.query("UPDATE orders SET payment_status='paid' WHERE id=$1",[o.id]);return {success:true};});
  const r=await f.api('/ai/actions/'+await f.action('cancel_order',o)+'/execute');
  assert.equal(r.status,409);assert.equal((await f.current(o)).status,'pending');assert.equal(await f.stock(),before);
  assert.equal((await f.pool.query('SELECT status FROM carrier_shipments WHERE order_id=$1',[o.id])).rows[0].status,'cancelled');
});

test('a new active shipment appearing after carrier cancellation blocks order finalization',async t=>{
  const f=await fixture(t),o=await f.order();await f.shipment(o);const before=await f.stock();
  f.stubCarrier(async()=>({success:true}));
  const original=shipping.cancelWaybill;
  shipping.cancelWaybill=async(...args)=>{const result=await original(...args);await f.shipment(o,'jt');return result;};
  t.after(()=>{shipping.cancelWaybill=original;});
  const r=await f.api('/api/gaeru_ceo/orders/'+o.id,{status:'cancelled',cancelActiveWaybill:true},'PATCH');
  assert.equal(r.status,409);assert.equal((await f.current(o)).status,'pending');assert.equal(await f.stock(),before);
  assert.equal((await f.pool.query("SELECT carrier_id FROM carrier_shipments WHERE order_id=$1 AND status<>'cancelled'",[o.id])).rows[0].carrier_id,'jt');
});

test('an unresolved carrier creation attempt prevents stock release even before a label is stored',async t=>{
  const f=await fixture(t),o=await f.order(),before=await f.stock();let calls=0;
  f.stubCarrier(async()=>{calls++;return {success:true};});
  await f.pool.query("INSERT INTO carrier_shipment_attempts(order_id,carrier_id,config_version,status) VALUES($1,'viettel',1,'unknown')",[o.id]);
  const r=await f.api('/ai/actions/'+await f.action('cancel_order',o)+'/execute');
  assert.equal(r.status,409);assert.equal(calls,0);assert.equal((await f.current(o)).status,'pending');assert.equal(await f.stock(),before);
});
