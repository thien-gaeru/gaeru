'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { seal } = require('../src/totp');
const { createWaybill, cancelWaybill, handleCarrierWebhook } = require('../src/shipping-management');
const { withTransaction } = require('../src/db');

async function fixture(t) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  const query = async (sql, values) => !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : db.query(sql, values);
  async function lock() { const before = queue; let release; queue = new Promise(r => { release = r; }); await before; return release; }
  const pool = { async query(sql, values) { const release = await lock(); try { return await query(sql, values); } finally { release(); } }, async connect() { const release = await lock(); return { query, release }; } };
  t.after(() => db.close());
  await migrateDatabase(pool);
  const config = { SESSION_SECRET: 'isolated-shipment-attempt-fixture-secret' };
  await pool.query("INSERT INTO store_settings(setting_key,setting_value) VALUES('private_admin:shipping_viettel',$1)", [JSON.stringify({ version: 1, cipher: seal(JSON.stringify({ accountId: '123', secret: 'fixture', webhookSecret:'dedicated-shipment-fixture-webhook-secret' }), process.env.AUTH_ENCRYPTION_KEY || config.SESSION_SECRET) })]);
  await pool.query("INSERT INTO shipping_carrier_connections(carrier_id,config_version,verified_at,enabled) VALUES('viettel',1,now(),true)");
  const order = (await pool.query("INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,total_vnd) VALUES('SHIPMENT-FENCING','Fixture','fixture@example.invalid','0900000000','Fixture','Hà Nội','cod','pending','confirmed',100000,100000) RETURNING id")).rows[0];
  return { pool, config, orderId: order.id };
}
const success = () => ({ ok: true, json: async () => ({ status: 200, error: false, data: { ORDER_NUMBER: 'PROVIDER-FENCING', MONEY_TOTAL: 20000 } }) });

test('shipment claim is committed before the provider call and concurrent requests cannot send twice', async t => {
  const f = await fixture(t);
  let calls = 0, entered, release;
  const started = new Promise(r => { entered = r; });
  const gate = new Promise(r => { release = r; });
  const fetcher = async () => { calls++; entered(); await gate; return success(); };
  const first = createWaybill(f.pool, f.config, { orderId: f.orderId, carrierId: 'viettel', actor:{username:'fixture'}, fetcher });
  await started;
  assert.equal((await f.pool.query('SELECT status FROM carrier_shipment_attempts')).rows[0].status, 'sending');
  await assert.rejects(() => createWaybill(f.pool, f.config, { orderId: f.orderId, carrierId: 'viettel', actor:{username:'fixture'}, fetcher }), e => e.status === 409);
  assert.equal(calls, 1);
  release();
  assert.equal((await first).shipment.trackingNumber, 'PROVIDER-FENCING');
  assert.equal((await f.pool.query('SELECT status FROM carrier_shipment_attempts')).rows[0].status, 'succeeded');
  assert.equal((await createWaybill(f.pool, f.config, { orderId: f.orderId, carrierId: 'viettel', actor:{username:'fixture'}, fetcher })).existing, true);
  assert.equal(calls, 1);
});

test('ambiguous provider timeout remains durably fenced across later create calls', async t => {
  const f = await fixture(t);
  let calls = 0;
  const fetcher = async () => { calls++; throw Object.assign(Error('fixture timeout after remote acceptance'), { name: 'TimeoutError' }); };
  await assert.rejects(() => createWaybill(f.pool, f.config, { orderId: f.orderId, carrierId: 'viettel', actor:{username:'fixture'}, fetcher }), e => e.status === 502);
  assert.equal((await f.pool.query('SELECT status FROM carrier_shipment_attempts')).rows[0].status, 'unknown');
  await assert.rejects(() => createWaybill(f.pool, f.config, { orderId: f.orderId, carrierId: 'viettel', actor:{username:'fixture'}, fetcher }), e => e.status === 409);
  assert.equal(calls, 1);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM carrier_shipments')).rows[0].n, 0);
});

test('a failed local shipment transaction retains the acknowledged tracking reference and blocks another provider call', async t => {
  const f = await fixture(t);
  const connect = f.pool.connect.bind(f.pool);
  f.pool.connect = async () => {
    const client = await connect();
    const query = client.query;
    client.query = (sql, values) => sql.includes('INSERT INTO carrier_shipments (') ? Promise.reject(Error('fixture local write failure')) : query(sql, values);
    return client;
  };
  let calls = 0;
  const fetcher = async () => { calls++; return success(); };
  await assert.rejects(() => createWaybill(f.pool, f.config, { orderId: f.orderId, carrierId: 'viettel', actor:{username:'fixture'}, fetcher }), e => e.status === 502);
  const attempt = (await f.pool.query('SELECT status,provider_result FROM carrier_shipment_attempts')).rows[0];
  assert.equal(attempt.status, 'unknown');
  assert.equal(attempt.provider_result.trackingNumber, 'PROVIDER-FENCING');
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM carrier_shipments')).rows[0].n, 0);
  await assert.rejects(() => createWaybill(f.pool, f.config, { orderId: f.orderId, carrierId: 'viettel', actor:{username:'fixture'}, fetcher }), e => e.status === 409);
  assert.equal(calls, 1);
});

test('explicit carrier selection cannot bypass disabled/unverified credentials or an abandoned durable claim', async t => {
  const f = await fixture(t);
  let calls = 0;
  const options = { orderId: f.orderId, carrierId: 'viettel', actor:{username:'fixture'}, fetcher: async () => { calls++; return success(); } };
  await f.pool.query("UPDATE shipping_carrier_connections SET enabled=false WHERE carrier_id='viettel'");
  await assert.rejects(() => createWaybill(f.pool, f.config, options), e => e.status === 409);
  await f.pool.query("UPDATE shipping_carrier_connections SET enabled=true,verified_at=NULL WHERE carrier_id='viettel'");
  await assert.rejects(() => createWaybill(f.pool, f.config, options), e => e.status === 409);
  await f.pool.query("UPDATE shipping_carrier_connections SET verified_at=now() WHERE carrier_id='viettel'");
  await f.pool.query("INSERT INTO carrier_shipment_attempts(order_id,carrier_id,config_version,created_at) VALUES($1,'viettel',1,now()-interval '1 day')", [f.orderId]);
  await assert.rejects(() => createWaybill(f.pool, f.config, options), e => e.status === 409);
  assert.equal(calls, 0, 'claims never expire into automatic re-sending');
});

test('manual no-waybill reconciliation requires owner reauthentication and evidence; acknowledged references cannot be unlocked', async t => {
  const f=await fixture(t),express=require('express');
  let authorizations=0;
  const config={...f.config,accountSecurity:{async authorize(req,fn){authorizations++;if(req.body.password!=='fresh-fixture-password')throw Object.assign(Error('Fresh password required'),{status:403});return withTransaction(f.pool,c=>fn({},c));}}};
  const attempt=(await f.pool.query("INSERT INTO carrier_shipment_attempts(order_id,carrier_id,config_version,status) VALUES($1,'viettel',1,'unknown') RETURNING id",[f.orderId])).rows[0];
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.session={csrfToken:'fixture-csrf'};req.admin={username:'fixture',role:req.get('x-fixture-staff')?'admin':'owner',source:'bootstrap',permissions:['orders.write']};next();});
  app.use(require('../src/shipping-management').createShippingManagement(f.pool,config).admin);
  app.use((err,_req,res,_next)=>res.status(err.status||500).json({error:err.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const body={confirmedNoWaybill:true,reason:'Đã kiểm tra mã đơn tại cổng hãng, chưa có vận đơn.',password:'fresh-fixture-password'};
  const post=(data=body,headers={})=>fetch('http://127.0.0.1:'+server.address().port+'/shipping/attempts/'+attempt.id+'/reconcile',{method:'POST',headers:{'Content-Type':'application/json','x-csrf-token':'fixture-csrf',...headers},body:JSON.stringify(data)});
  assert.equal((await post(body,{'x-fixture-staff':'1'})).status,403);assert.equal(authorizations,0);
  assert.equal((await post(body,{'x-csrf-token':'wrong'})).status,403);assert.equal(authorizations,0);
  assert.equal((await post({...body,password:'wrong'})).status,403);
  assert.equal((await post({...body,confirmedNoWaybill:false})).status,400);
  await f.pool.query("UPDATE carrier_shipment_attempts SET provider_result=$2 WHERE id=$1",[attempt.id,JSON.stringify({trackingNumber:'KNOWN-PROVIDER-REF'})]);
  assert.equal((await post()).status,409,'a known provider reference requires recovery, never another create');
  await f.pool.query("UPDATE carrier_shipment_attempts SET provider_result=NULL,status='sending' WHERE id=$1",[attempt.id]);
  assert.equal((await post()).status,409,'an actively sending request cannot be unlocked');
  await f.pool.query("UPDATE carrier_shipment_attempts SET status='unknown' WHERE id=$1",[attempt.id]);
  assert.equal((await post()).status,200);
  assert.equal((await f.pool.query('SELECT status FROM carrier_shipment_attempts WHERE id=$1',[attempt.id])).rows[0].status,'reconciled');
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='shipping.waybill.reconcile_not_created'")).rows[0].n,1);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM carrier_shipments')).rows[0].n,0,'manual reconciliation never creates or sends a shipment');
});

test('a late callback for a cancelled label cannot complete an order with a replacement label', async t=>{
  const f=await fixture(t),actor={username:'fixture'};let calls=0;
  const fetcher=async()=>({ok:true,json:async()=>({status:200,error:false,data:{ORDER_NUMBER:'PROVIDER-LABEL-'+(++calls)}})});
  await createWaybill(f.pool,f.config,{orderId:f.orderId,carrierId:'viettel',actor,fetcher});
  await cancelWaybill(f.pool,f.config,{orderId:f.orderId,actor,fetcher:async()=>({ok:true,json:async()=>({status:200,error:false})})});
  await createWaybill(f.pool,f.config,{orderId:f.orderId,carrierId:'viettel',actor,fetcher});
  const result=await handleCarrierWebhook(f.pool,f.config,'viettel',{ORDER_NUMBER:'PROVIDER-LABEL-1',ORDER_STATUS:'delivered'},{headers:{'x-webhook-secret':'dedicated-shipment-fixture-webhook-secret'}});
  assert.equal(result.processed,false);
  assert.deepEqual((await f.pool.query('SELECT status,payment_status FROM orders WHERE id=$1',[f.orderId])).rows[0],{status:'processing',payment_status:'pending'});
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM carrier_shipments WHERE order_id=$1',[f.orderId])).rows[0].n,2);
});

test('carrier completion rolls back order/payment and shipment when loyalty accounting fails',async t=>{
  const f=await fixture(t),customer=(await f.pool.query("INSERT INTO customers(email,full_name,phone) VALUES('loyalty-carrier@example.invalid','Fixture','0900000000') RETURNING id")).rows[0];
  await f.pool.query('UPDATE orders SET customer_id=$2 WHERE id=$1',[f.orderId,customer.id]);
  await f.pool.query("INSERT INTO carrier_shipments(order_id,carrier_id,tracking_number,status,cod_amount_vnd) VALUES($1,'viettel','LOYALTY-TRACKING','created',100000)",[f.orderId]);
  t.mock.method(require('../src/loyalty-api'),'earnPoints',async()=>{throw Error('fixture loyalty accounting failure');});
  // 1. COD delivered transitions shipment to delivered (unsettled), then settleCarrierCod rolls back atomically on loyalty failure
  await handleCarrierWebhook(f.pool,f.config,'viettel',{ORDER_NUMBER:'LOYALTY-TRACKING',ORDER_STATUS:'delivered'},{headers:{'x-webhook-secret':'dedicated-shipment-fixture-webhook-secret'}});
  const {settleCarrierCod}=require('../src/shipping-management');
  await assert.rejects(()=>settleCarrierCod(f.pool,{orderId:f.orderId,providerTransactionRef:'VTP-FAIL-LOYALTY',settledAmountVnd:100000,actor:{username:'fixture',role:'owner',source:'bootstrap'}}),/fixture loyalty accounting failure/);
  assert.deepEqual((await f.pool.query('SELECT status,payment_status FROM orders WHERE id=$1',[f.orderId])).rows[0],{status:'completed',payment_status:'pending'});
  assert.equal((await f.pool.query('SELECT cod_settlement_status FROM carrier_shipments WHERE order_id=$1',[f.orderId])).rows[0].cod_settlement_status,'unsettled');
  // 2. Prepaid order rolls back delivered webhook atomically on loyalty failure
  const prepaid=(await f.pool.query("INSERT INTO orders(order_number,customer_id,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,total_vnd) VALUES('PREPAID-LOYALTY-RB',$1,'Fixture','fixture@example.invalid','0900000000','Fixture','Hà Nội','bank_transfer','paid','shipped',100000,100000) RETURNING id",[customer.id])).rows[0];
  await f.pool.query("INSERT INTO carrier_shipments(order_id,carrier_id,tracking_number,status,cod_amount_vnd,cod_settlement_status) VALUES($1,'viettel','PREPAID-LOYALTY-TRK','delivering',0,'not_applicable')",[prepaid.id]);
  await assert.rejects(()=>handleCarrierWebhook(f.pool,f.config,'viettel',{ORDER_NUMBER:'PREPAID-LOYALTY-TRK',ORDER_STATUS:'delivered'},{headers:{'x-webhook-secret':'dedicated-shipment-fixture-webhook-secret'}}),/fixture loyalty accounting failure/);
  assert.equal((await f.pool.query('SELECT status FROM orders WHERE id=$1',[prepaid.id])).rows[0].status,'shipped');
  assert.equal((await f.pool.query('SELECT status FROM carrier_shipments WHERE order_id=$1',[prepaid.id])).rows[0].status,'delivering');
});

test('permanent deletion cannot erase an in-flight provider claim before its tracking reference is attached',async t=>{
  const f=await fixture(t),actor={username:'fixture'};let entered,release;
  const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const creating=createWaybill(f.pool,f.config,{orderId:f.orderId,carrierId:'viettel',actor,fetcher:async()=>{entered();await gate;return success();}}).catch(error=>error);
  await started;
  let deletionError;
  try{await withTransaction(f.pool,c=>require('../src/order-deletion').deleteOrderPermanently(c,f.orderId,{actor}));}catch(error){deletionError=error;}
  release();const result=await creating;
  assert.equal(deletionError?.status,409,'a durable sending claim must block deletion');
  assert.equal(result.success,true,'blocked deletion must leave the order available for provider finalization');
  assert.equal((await f.pool.query('SELECT provider_result FROM carrier_shipment_attempts WHERE order_id=$1',[f.orderId])).rows[0].provider_result.trackingNumber,'PROVIDER-FENCING');
});

test('permanent deletion preserves unknown carrier outcomes and active labels until reconciliation or cancellation',async t=>{
  const f=await fixture(t),actor={username:'fixture'};
  const remove=()=>withTransaction(f.pool,c=>require('../src/order-deletion').deleteOrderPermanently(c,f.orderId,{actor}));
  await f.pool.query("INSERT INTO carrier_shipment_attempts(order_id,carrier_id,config_version,status) VALUES($1,'viettel',1,'unknown')",[f.orderId]);
  await assert.rejects(remove,{status:409});
  assert.equal((await f.pool.query('SELECT status FROM carrier_shipment_attempts WHERE order_id=$1',[f.orderId])).rows[0].status,'unknown');
  await f.pool.query("UPDATE carrier_shipment_attempts SET status='reconciled' WHERE order_id=$1",[f.orderId]);
  await f.pool.query("INSERT INTO carrier_shipments(order_id,carrier_id,tracking_number,status) VALUES($1,'viettel','ACTIVE-DELETE-GUARD','created')",[f.orderId]);
  for(const status of ['created','picking','delivering']){
    await f.pool.query('UPDATE carrier_shipments SET status=$2 WHERE order_id=$1',[f.orderId,status]);
    await assert.rejects(remove,{status:409});
  }
  await f.pool.query("UPDATE carrier_shipments SET status='cancelled' WHERE order_id=$1",[f.orderId]);
  assert.equal((await remove()).id,f.orderId,'cancelled provider history follows the explicit permanent-delete policy');
});

test('an acknowledged provider reference must match reconciled terminal shipment history before permanent deletion',async t=>{
  const f=await fixture(t),actor={username:'fixture'};
  const remove=()=>withTransaction(f.pool,c=>require('../src/order-deletion').deleteOrderPermanently(c,f.orderId,{actor}));
  await f.pool.query("INSERT INTO carrier_shipment_attempts(order_id,carrier_id,config_version,status,provider_result) VALUES($1,'viettel',1,'succeeded',$2)",[f.orderId,JSON.stringify({trackingNumber:'ACKNOWLEDGED-TRACKING',carrierOrderId:'ACKNOWLEDGED-ORDER'})]);
  await assert.rejects(remove,{status:409},'a saved carrier acknowledgement cannot be discarded without local reconciliation evidence');
  await f.pool.query("INSERT INTO carrier_shipments(order_id,carrier_id,tracking_number,carrier_order_id,status) VALUES($1,'viettel','UNRELATED-TRACKING','UNRELATED-ORDER','cancelled')",[f.orderId]);
  await assert.rejects(remove,{status:409},'unrelated historical labels cannot satisfy the acknowledgement guard');
  await f.pool.query("INSERT INTO carrier_shipments(order_id,carrier_id,tracking_number,carrier_order_id,status) VALUES($1,'viettel','ACKNOWLEDGED-TRACKING','ACKNOWLEDGED-ORDER','cancelled')",[f.orderId]);
  assert.equal((await remove()).id,f.orderId,'matching cancelled history permits the existing explicit permanent-delete policy');
});


test('createWaybill rejects forceRetry bypass on unresolved attempts until explicit owner reconciliation', async t => {
  const f = await fixture(t), actor = { username: 'fixture', role: 'sales', source: 'staff' };
  const { createWaybill, reconcileWaybillAttempt } = require('../src/shipping-management');

  const inserted = (await f.pool.query("INSERT INTO carrier_shipment_attempts(order_id,carrier_id,config_version,status) VALUES($1,'viettel',1,'unknown') RETURNING id", [f.orderId])).rows[0];

  let providerCalls = 0;
  const mockFetcher = async () => {
    providerCalls++;
    return {
      ok: true,
      json: async () => ({ status: 200, error: false, data: { ORDER_NUMBER: 'VT-RETRY-OK', MONEY_TOTAL: 30000 } })
    };
  };

  await assert.rejects(
    () => createWaybill(f.pool, f.config, { orderId: f.orderId, carrierId: 'viettel', forceRetry: true, actor, fetcher: mockFetcher }),
    { status: 409 }
  );
  assert.equal(providerCalls, 0, 'forceRetry must never bypass durable attempt fencing');

  await withTransaction(f.pool, client => reconcileWaybillAttempt(client, {
    attemptId: inserted.id,
    reason: 'Chủ doanh nghiệp đã đối chiếu tại cổng Viettel Post, chưa tạo vận đơn.',
    actor: { username: 'owner', role: 'owner', source: 'bootstrap' }
  }));

  const res = await createWaybill(f.pool, f.config, {
    orderId: f.orderId,
    carrierId: 'viettel',
    actor,
    fetcher: mockFetcher
  });

  assert.equal(res.success, true);
  assert.equal(res.shipment.trackingNumber, 'VT-RETRY-OK');
  assert.equal(providerCalls, 1);

  const attempts = (await f.pool.query('SELECT status FROM carrier_shipment_attempts WHERE order_id = $1 ORDER BY created_at ASC', [f.orderId])).rows;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, 'reconciled');
  assert.equal(attempts[1].status, 'succeeded');
});
