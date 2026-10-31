const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes,createHmac}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite'),bcrypt=require('bcryptjs'),session=require('express-session');
const {createApp}=require('../src/app'),{migrateDatabase}=require('../src/migrate'),payments=require('../src/payment-channels');
const jsonResponse=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

test('payment checks distinguish configuration, public reachability and authenticated merchant evidence',async()=>{
 const seen=[];
 const fetcher=async(url,options={})=>{seen.push({url,options});return jsonResponse({error:'fixture not found'},404);};
 const cod=await payments.verifyPaymentChannel('cod',{maxAmountVnd:50000000,instructions:'Thanh toán khi nhận hàng',enabled:true});
 assert.equal(cod.id,'cod');assert.equal(cod.configured,true);assert.equal(cod.verified,false);assert.equal(cod.method,'configuration_validation');
 const bank=await payments.verifyPaymentChannel('bank_transfer',{bankName:'Vietcombank',accountNumber:'0123456789',accountHolder:'CONG TY GAERU',branch:'Hà Nội',transferSyntax:'GAERU {MA_DON}',enabled:true});
 assert.equal(bank.configured,true);assert.equal(bank.verified,false);assert.equal(bank.method,'configuration_validation');
 assert.match(bank.message,/Chưa xác minh quyền sở hữu/);
 const settings={
  vnpay:{tmnCode:'TEST1234',hashSecret:'deliberately-fake-vnpay-key',environment:'sandbox',enabled:true},
  '9pay':{merchantKey:'FAKE9PAY',secretKey:'fake-9pay-secret',checksumKey:'fake-9pay-checksum',environment:'sandbox',enabled:true},
  momo:{partnerCode:'FAKEMOMO',accessKey:'FAKEACCESS',secretKey:'fake-momo-secret',environment:'sandbox',enabled:true},
  zalopay:{appId:'2554',key1:'fake-zalopay-key1',key2:'fake-zalopay-key2',environment:'sandbox',enabled:true}
 };
 for(const id of ['vnpay','9pay','momo','zalopay']){
  const result=await payments.verifyPaymentChannel(id,settings[id],{config:{PUBLIC_BASE_URL:'https://gaeru.com'},fetcher});
  assert.equal(result.id,id);assert.equal(result.verified,false,id+' must not authenticate fake keys from HTTP404');
  assert.equal(result.callbackVerified,false);
  if(id==='9pay'){assert.equal(result.supported,false);assert.equal(result.method,'unsupported');}
 }
 assert.equal(seen.length,3,'9Pay must not contact an unsupported provider adapter');
 assert.equal(seen[0].options.method,'GET');
 for(const call of seen.slice(1)){
  assert.equal(call.options.method,'POST','wallet checks must use their authenticated query protocol');
  assert.match(call.url,/\/v2\/(?:gateway\/api\/query|query)$/);
  assert.ok(JSON.parse(call.options.body).signature||JSON.parse(call.options.body).mac);
 }
 const vnpayPublicPage=await payments.verifyPaymentChannel('vnpay',settings.vnpay,{fetcher:async()=>jsonResponse({ok:true})});
 assert.equal(vnpayPublicPage.reachable,true);assert.equal(vnpayPublicPage.verified,false,'a public HTTP200 does not authenticate merchant keys');
 await assert.rejects(()=>payments.verifyPaymentChannel('bank_transfer',{bankName:'VCB',accountNumber:'12',accountHolder:'GAERU',transferSyntax:'GAERU'}),e=>e.status===400);
 await assert.rejects(()=>payments.verifyPaymentChannel('vnpay',{tmnCode:'BAD',hashSecret:'short'}),e=>e.status===400);
 await assert.rejects(()=>payments.verifyPaymentChannel('momo',{partnerCode:'M',accessKey:'A',secretKey:'short'}),e=>e.status===400);
 await assert.rejects(()=>payments.verifyPaymentChannel('zalopay',{appId:'abc',key1:'short',key2:'short'}),e=>e.status===400);
});

test('official wallet creation, callback integrity, disabled pending channels and rollback work with PostgreSQL', {timeout:60000},async t=>{
 const db=await PGlite.create();
 let queue=Promise.resolve();
 async function lock(){const previous=queue;let release;queue=new Promise(r=>{release=r;});await previous;return release;}
 async function rawQuery(sql,values){const r=!values&&sql.includes(';')?(await db.exec(sql)).at(-1):await db.query(sql,values);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};}
 const pool={async query(sql,values){const release=await lock();try{return await rawQuery(sql,values);}finally{release();}},async connect(){const release=await lock();return {query:rawQuery,release};},end:()=>db.close()};
 t.after(()=>pool.end());
 await migrateDatabase(pool);
 await pool.query(`INSERT INTO store_settings(setting_key,setting_value) VALUES('shipping_rates','{"Hà Nội":30000}'::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value`);
 const product=(await pool.query(`INSERT INTO products(slug,name,category,image_url,active) VALUES('gaeru-k9-payment','GAERU K9','audio','/assets/products/k9.webp',true) RETURNING id`)).rows[0];
 const variant=(await pool.query(`INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'PAYMENT-FIXTURE-USBC','USB-C',200000,20,true) RETURNING id`,[product.id])).rows[0];
 const warehouse=(await pool.query(`SELECT id FROM warehouses WHERE code='MAIN' LIMIT 1`)).rows[0];
 if(warehouse)await pool.query(`INSERT INTO warehouse_stock(warehouse_id,variant_id,quantity) VALUES($1,$2,20) ON CONFLICT(warehouse_id,variant_id) DO UPDATE SET quantity=20`,[warehouse.id,variant.id]);
 const ownerPassword='Owner-payment-fixture-pass';
 const momoSettings={partnerCode:'MOMOGAERU',accessKey:'MOMOACCESS1',secretKey:'momo-secret-key-fixture',environment:'sandbox',enabled:true};
 const zaloSettings={appId:'2554',key1:'zalopay-key1-fixture',key2:'zalopay-key2-fixture',environment:'sandbox',enabled:true};
 let rejectCreate=false;
 const providerCreates=[];
 const fetcher=async(url,options={})=>{
  if(options.method==='GET')return new Response('Public gateway page',{status:200});
  assert.equal(options.method,'POST');
  const body=JSON.parse(options.body);
  if(url==='https://test-payment.momo.vn/v2/gateway/api/query')return jsonResponse({resultCode:1001,message:'Fixture query found no order'});
  if(url==='https://sb-openapi.zalopay.vn/v2/query')return jsonResponse({return_code:2,sub_return_code:-49,return_message:'Fixture query found no order'});
  if(url==='https://test-payment.momo.vn/v2/gateway/api/create'){
   providerCreates.push({provider:'momo',body});
   if(rejectCreate)return jsonResponse({resultCode:11,message:'Fixture provider rejected create'});
   const raw=`accessKey=${momoSettings.accessKey}&amount=${body.amount}&extraData=${body.extraData}&ipnUrl=${body.ipnUrl}&orderId=${body.orderId}&orderInfo=${body.orderInfo}&partnerCode=${body.partnerCode}&redirectUrl=${body.redirectUrl}&requestId=${body.requestId}&requestType=${body.requestType}`;
   assert.equal(body.signature,createHmac('sha256',momoSettings.secretKey).update(raw).digest('hex'));
   return jsonResponse({resultCode:0,partnerCode:body.partnerCode,requestId:body.requestId,orderId:body.orderId,amount:body.amount,payUrl:'https://test-payment.momo.vn/v2/gateway/pay?token=provider-issued-momo-session'});
  }
  if(url==='https://sb-openapi.zalopay.vn/v2/create'){
   providerCreates.push({provider:'zalopay',body});
   const raw=`${body.app_id}|${body.app_trans_id}|${body.app_user}|${body.amount}|${body.app_time}|${body.embed_data}|${body.item}`;
   assert.equal(body.mac,createHmac('sha256',zaloSettings.key1).update(raw).digest('hex'));
   return jsonResponse({return_code:1,sub_return_code:1,app_id:body.app_id,app_trans_id:body.app_trans_id,amount:body.amount,order_url:'https://qcgateway.zalopay.vn/openinapp?order=provider-issued-zalo-session'});
  }
  throw Error('Unexpected provider request '+url);
 };
 const app=createApp({config:{NODE_ENV:'test',SESSION_SECRET:randomBytes(48).toString('hex'),ADMIN_USERNAME:'payment-owner',ADMIN_PASSWORD_HASH:bcrypt.hashSync(ownerPassword,4),PUBLIC_BASE_URL:'https://gaeru.com',STORE_ORDERS_ENABLED:true,paymentFetcher:fetcher},pool,sessionStore:new session.MemoryStore()});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;let cookie='',csrf='';
 async function api(path,method='GET',body){
  const response=await fetch(base+path,{method,redirect:'manual',headers:{Cookie:cookie,'X-CSRF-Token':csrf,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  const text=await response.text();let data={};try{data=text?JSON.parse(text):{};}catch{data={raw:text};}
  if(data.csrfToken)csrf=data.csrfToken;return {status:response.status,headers:response.headers,data,text};
 }
 const customer={name:'Nguyễn Văn An',email:'payment.fixture@example.com',phone:'0900000000',address:'12 Nguyễn Trãi, Thanh Xuân',city:'Hà Nội',note:''};
 const orderBody=(paymentMethod,customCustomer=customer)=>({customer:customCustomer,paymentMethod,items:[{variantId:variant.id,quantity:1}]});
 async function save(id,data,version=0){return api('/api/gaeru_ceo/owner/configuration/'+id,'PUT',{version,password:ownerPassword,data});}
 async function state(order){return (await pool.query(`SELECT status,payment_status FROM orders WHERE id=$1`,[order.id])).rows[0];}
 async function snapshot(){return (await pool.query(`SELECT (SELECT count(*)::int FROM orders) AS orders,(SELECT stock_quantity FROM product_variants WHERE id=$1) AS stock,(SELECT count(*)::int FROM payment_attempts) AS attempts,(SELECT count(*)::int FROM order_email_outbox) AS outbox,(SELECT count(*)::int FROM customers) AS customers`,[variant.id])).rows[0];}
 await api('/api/csrf');assert.equal((await api('/api/auth/login','POST',{username:'payment-owner',password:ownerPassword})).status,200);
 assert.equal((await api('/api/gaeru_ceo/owner/payments')).data.channels.every(c=>c.verified===false),true);
 assert.equal((await save('payment_bank_transfer',{bankName:'Techcombank',accountNumber:'190388889999',accountHolder:'CONG TY GAERU',branch:'Hà Nội',transferSyntax:'GAERU {MA_DON}',enabled:true})).status,200);
 assert.equal((await save('vnpay',{tmnCode:'GAERU123',hashSecret:'vnpay-fixture-secret',environment:'sandbox',enabled:true})).status,200);
 assert.equal((await save('payment_9pay',{merchantKey:'FIXTURE9PAY',secretKey:'9pay-secret-fixture',checksumKey:'9pay-checksum-fixture',environment:'sandbox',enabled:false})).status,200);
 const savedMomo=await save('payment_momo',momoSettings);assert.equal(savedMomo.status,200);assert.equal(savedMomo.data.data.secretConfigured,true);assert.ok(!savedMomo.text.includes(momoSettings.secretKey));
 const savedZalo=await save('payment_zalopay',zaloSettings);assert.equal(savedZalo.status,200);assert.ok(!savedZalo.text.includes(zaloSettings.key1));assert.ok(!savedZalo.text.includes(zaloSettings.key2));
 for(const [id,version] of [['cod',0],['bank_transfer',1],['vnpay',1],['9pay',1],['momo',1],['zalopay',1]]){
  const checked=await api('/api/gaeru_ceo/owner/payments/'+id+'/test','POST',{version,password:ownerPassword});
  assert.equal(checked.status,200,JSON.stringify(checked.data));assert.equal(checked.data.verified,false,id);
 }
 await pool.query(`UPDATE payment_channel_connections SET verified_at=now(),last_method='gateway_handshake' WHERE channel_id IN ('vnpay','momo','zalopay')`);
 const listed=await api('/api/gaeru_ceo/owner/payments');assert.ok(listed.data.channels.every(c=>c.verified===false),'legacy public-probe evidence must remain unverified');
 const publicSettings=await api('/api/settings/public');assert.deepEqual(publicSettings.data.paymentMethods,['cod','bank_transfer','vnpay','momo','zalopay']);
 assert.equal(publicSettings.data.bankTransfer.accountNumber,'190388889999');
 assert.equal((await api('/api/gaeru_ceo/owner/payments/9pay/availability','PATCH',{version:1,enabled:true,password:ownerPassword})).status,409);
 const beforeUnsupported=await snapshot();assert.equal((await api('/api/orders','POST',orderBody('9pay'))).status,503);assert.deepEqual(await snapshot(),beforeUnsupported);
 assert.equal((await api('/api/payments/9pay/ipn','POST',{invoice_no:'fixture',status:'PAID'})).status,503);

 // A definite provider rejection cancels the unpaid order and releases stock under lock while keeping audit records.
 const beforeFailure=await snapshot();rejectCreate=true;
 const failed=await api('/api/orders','POST',orderBody('momo',{...customer,email:'failed.payment.fixture@example.com'}));
 assert.equal(failed.status,502,JSON.stringify(failed.data));
 assert.equal(failed.data.reconciliationStatus,'cancelled_unpaid');
 const afterFailure=await snapshot();
 assert.equal(afterFailure.stock,beforeFailure.stock);
 assert.equal(afterFailure.orders,beforeFailure.orders+1);
 assert.equal(afterFailure.attempts,beforeFailure.attempts+1);
 const rejectedOrder=(await pool.query('SELECT status,payment_status FROM orders WHERE id=$1',[failed.data.orderId])).rows[0];
 assert.deepEqual(rejectedOrder,{status:'cancelled',payment_status:'pending'});
 const rejectedAttempt=(await pool.query('SELECT status,provider_request_id FROM payment_attempts WHERE order_id=$1',[failed.data.orderId])).rows[0];
 assert.equal(rejectedAttempt.status,'failed');assert.ok(rejectedAttempt.provider_request_id);
 rejectCreate=false;

 const createdMomo=await api('/api/orders','POST',orderBody('momo'));assert.equal(createdMomo.status,201,JSON.stringify(createdMomo.data));
 assert.equal(createdMomo.data.paymentUrl,'https://test-payment.momo.vn/v2/gateway/pay?token=provider-issued-momo-session');
 const momoOrder=createdMomo.data.order;
 const momoAttempt=(await pool.query('SELECT provider_request_id,provider_transaction_id FROM payment_attempts WHERE order_id=$1',[momoOrder.id])).rows[0];
 const momoRequest=providerCreates.filter(c=>c.provider==='momo').at(-1).body;
 assert.equal(momoAttempt.provider_request_id,momoRequest.requestId);assert.equal(momoRequest.orderId,momoOrder.orderNumber);assert.equal(momoRequest.amount,momoOrder.totalVnd);
 assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[variant.id])).rows[0].stock_quantity,19);
 function momoPayload(changes={}){
  const p={partnerCode:momoSettings.partnerCode,orderId:momoOrder.orderNumber,amount:momoOrder.totalVnd,resultCode:0,transId:4088878653,extraData:'',message:'Successful.',orderInfo:momoRequest.orderInfo,orderType:'momo_wallet',payType:'qr',requestId:momoAttempt.provider_request_id,responseTime:1793155200000,...changes};
  const raw=`accessKey=${momoSettings.accessKey}&amount=${p.amount}&extraData=${p.extraData}&message=${p.message}&orderId=${p.orderId}&orderInfo=${p.orderInfo}&orderType=${p.orderType}&partnerCode=${p.partnerCode}&payType=${p.payType}&requestId=${p.requestId}&responseTime=${p.responseTime}&resultCode=${p.resultCode}&transId=${p.transId}`;
  return {...p,signature:createHmac('sha256',momoSettings.secretKey).update(raw).digest('hex')};
 }
 const payload=momoPayload();const query=new URLSearchParams(Object.entries(payload).map(([key,value])=>[key,String(value)]));
 const browserReturn=await api('/api/payments/momo/return?'+query);assert.equal(browserReturn.status,302);assert.deepEqual(await state(momoOrder),{status:'pending',payment_status:'pending'},'even a correctly signed browser return cannot settle');
 assert.equal((await api('/api/payments/momo/ipn','POST',{...payload,amount:payload.amount+1})).status,400);
 assert.equal((await api('/api/payments/momo/ipn','POST',momoPayload({requestId:'different-request'}))).status,409);
 assert.equal((await api('/api/payments/momo/ipn','POST',momoPayload({amount:payload.amount+1}))).status,409);
 assert.deepEqual(await state(momoOrder),{status:'pending',payment_status:'pending'});
 const editPending=await save('payment_momo',{...momoSettings,secretKey:'different-fixture-secret'},1);assert.equal(editPending.status,409,JSON.stringify(editPending.data));
 const disabled=await api('/api/gaeru_ceo/owner/payments/momo/availability','PATCH',{version:1,enabled:false,password:ownerPassword});assert.equal(disabled.status,200,JSON.stringify(disabled.data));
 assert.equal((await api('/api/settings/public')).data.paymentMethods.includes('momo'),false);
 const paidMomo=await api('/api/payments/momo/ipn','POST',payload);assert.equal(paidMomo.status,204,JSON.stringify(paidMomo.data));assert.equal(paidMomo.text,'');
 assert.deepEqual(await state(momoOrder),{status:'processing',payment_status:'paid'});
 assert.equal((await api('/api/payments/momo/ipn','POST',payload)).status,204);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM sales_receipts WHERE order_id=$1',[momoOrder.id])).rows[0].n,1);
 assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action='payment.momo.callback' AND entity_id=$1`,[momoOrder.id])).rows[0].n,1);
 const evidence=(await api('/api/gaeru_ceo/owner/payments')).data.channels.find(c=>c.id==='momo');assert.equal(evidence.enabled,false);assert.equal(evidence.verified,true);assert.equal(evidence.callbackVerified,true);

 const createdZalo=await api('/api/orders','POST',orderBody('zalopay'));assert.equal(createdZalo.status,201,JSON.stringify(createdZalo.data));
 assert.equal(createdZalo.data.paymentUrl,'https://qcgateway.zalopay.vn/openinapp?order=provider-issued-zalo-session');
 const zaloOrder=createdZalo.data.order;
 const zaloAttempt=(await pool.query('SELECT provider_request_id FROM payment_attempts WHERE order_id=$1',[zaloOrder.id])).rows[0];
 const zaloRequest=providerCreates.find(c=>c.provider==='zalopay').body;
 assert.equal(zaloAttempt.provider_request_id,zaloRequest.app_trans_id);assert.match(zaloAttempt.provider_request_id,new RegExp('^\\d{6}_'+zaloOrder.orderNumber+'$'));
 const officialReturn=await api('/api/payments/zalopay/return?'+new URLSearchParams({apptransid:zaloAttempt.provider_request_id,status:'1',checksum:'display-only-fixture'}));
 assert.equal(officialReturn.status,302);
 const returnUrl=new URL(officialReturn.headers.get('location'),'https://gaeru.com');
 assert.equal(returnUrl.searchParams.get('order'),zaloOrder.orderNumber);assert.equal(returnUrl.searchParams.get('result'),'pending');
 assert.deepEqual(await state(zaloOrder),{status:'pending',payment_status:'pending'},'official browser redirect never settles payment');
 function zaloPayload(changes={}){const data=JSON.stringify({app_id:2554,app_trans_id:zaloAttempt.provider_request_id,amount:zaloOrder.totalVnd,zp_trans_id:200904000000389,...changes});return {data,mac:createHmac('sha256',zaloSettings.key2).update(data).digest('hex'),type:1};}
 assert.equal((await api('/api/payments/zalopay/ipn','POST',zaloPayload({amount:zaloOrder.totalVnd+1}))).data.return_code,0);
 assert.equal((await api('/api/payments/zalopay/ipn','POST',zaloPayload({app_trans_id:'000000_'+zaloOrder.orderNumber}))).data.return_code,0);
 assert.deepEqual(await state(zaloOrder),{status:'pending',payment_status:'pending'});
 const paidZalo=await api('/api/payments/zalopay/ipn','POST',zaloPayload());assert.equal(paidZalo.status,200);assert.equal(paidZalo.data.return_code,1);assert.deepEqual(await state(zaloOrder),{status:'processing',payment_status:'paid'});
 assert.equal((await api('/api/payments/zalopay/ipn','POST',zaloPayload())).data.return_code,1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM sales_receipts WHERE order_id=$1',[zaloOrder.id])).rows[0].n,1);

 const bankOrderResponse=await api('/api/orders','POST',orderBody('bank_transfer'));assert.equal(bankOrderResponse.status,201,JSON.stringify(bankOrderResponse.data));
 const bankOrder=bankOrderResponse.data.order;assert.equal(bankOrderResponse.data.bankTransfer.transferContent,'GAERU '+bankOrder.orderNumber);
 const manual=await api('/api/gaeru_ceo/owner/payments/reconcile','POST',{provider:'bank_transfer',orderNumber:'Chuyen khoan GAERU '+bankOrder.orderNumber,amountVnd:bankOrder.totalVnd,providerTransactionId:'FT-FIXTURE-001',password:ownerPassword});
 assert.equal(manual.status,200,JSON.stringify(manual.data));assert.deepEqual(await state(bankOrder),{status:'processing',payment_status:'paid'});
 assert.equal(providerCreates.filter(c=>c.provider==='momo').length,2);assert.equal(providerCreates.filter(c=>c.provider==='zalopay').length,1);
});

test('admin payment workspace renders all six channels and dispatches connection tests',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const records={
  payment_cod:{version:1,data:{enabled:true,maxAmountVnd:50000000,instructions:'COD'}},
  payment_bank_transfer:{version:2,data:{bankName:'VCB',accountNumber:'0123456789',accountHolder:'GAERU',branch:'HN',transferSyntax:'GAERU {MA_DON}',enabled:true}},
  vnpay:{version:3,data:{tmnCode:'GAERU123',environment:'sandbox',enabled:true,secretConfigured:true}},
  payment_9pay:{version:1,data:{merchantKey:'M9PAY',environment:'sandbox',enabled:false,secretConfigured:true}},
  payment_momo:{version:1,data:{partnerCode:'MOMOGAERU',accessKey:'MOMOACC',environment:'sandbox',enabled:true,secretConfigured:true}},
  payment_zalopay:{version:1,data:{appId:'2554',environment:'sandbox',enabled:true,secretConfigured:true}}
 };
 const root={innerHTML:''},listeners={},calls=[];
 const admin={
  user:{role:'owner',source:'bootstrap'},
  showGlobal(){},
  request:async(path,options={})=>{
   calls.push({path,options});
   if(path==='/api/gaeru_ceo/owner/configuration')return {records,services:{},callbacks:{vnpayReturn:'https://gaeru.com/api/payments/vnpay/return',vnpayIpn:'https://gaeru.com/api/payments/vnpay/ipn',ninepayReturn:'https://gaeru.com/api/payments/9pay/return',ninepayIpn:'https://gaeru.com/api/payments/9pay/ipn',momoReturn:'https://gaeru.com/api/payments/momo/return',momoIpn:'https://gaeru.com/api/payments/momo/ipn',zalopayReturn:'https://gaeru.com/api/payments/zalopay/return',zalopayIpn:'https://gaeru.com/api/payments/zalopay/ipn',bankTransferWebhook:'https://gaeru.com/api/payments/bank_transfer/webhook'}};
   if(path==='/api/gaeru_ceo/owner/payments')return {channels:[
    {id:'cod',configId:'payment_cod',verified:true,enabled:true,configured:true,version:1},
    {id:'bank_transfer',configId:'payment_bank_transfer',verified:true,enabled:true,configured:true,version:2},
    {id:'vnpay',configId:'vnpay',verified:false,enabled:true,configured:true,version:3},
    {id:'9pay',configId:'payment_9pay',verified:false,enabled:false,configured:true,version:1},
    {id:'momo',configId:'payment_momo',verified:true,enabled:true,configured:true,version:1},
    {id:'zalopay',configId:'payment_zalopay',verified:true,enabled:true,configured:true,version:1}
   ]};
   return {verified:true,message:'Đã xác minh kết nối MoMo.'};
  }
 };
 const context={window:{GAERUAdmin:admin},document:{addEventListener:(t,fn)=>(listeners[t]||=[]).push(fn),querySelector:s=>s==='#payment-configuration'?root:null,getElementById:()=>null}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../admin/configuration.js'),'utf8'),context);
 await context.window.GAERUConfiguration.mountPayments();
 for(const id of ['cod','bank_transfer','vnpay','9pay','momo','zalopay']){
  assert.match(root.innerHTML,new RegExp(`data-payment-test="${id}"`));
  assert.match(root.innerHTML,new RegExp(`data-payment-enable="${id}"`));
 }
 assert.match(root.innerHTML,/data-payment-reconcile-form/);
 const status={textContent:''},form={dataset:{version:'1'},elements:{password:{value:'owner-pass',focus(){}},factorCode:{value:''}}},details={id:'config-panel-payment_momo',querySelector:s=>s==='form'?form:status},button={dataset:{paymentTest:'momo'},disabled:false,closest:()=>details};
 for(const fn of listeners.click)await fn({target:{closest:s=>s.includes('data-payment-test')?button:null}});
 assert.ok(calls.some(c=>c.path==='/api/gaeru_ceo/owner/payments/momo/test'&&c.options.method==='POST'));
});
