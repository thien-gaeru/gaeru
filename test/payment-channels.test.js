const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes,createHmac}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite'),bcrypt=require('bcryptjs'),session=require('express-session');
const {createApp}=require('../src/app'),{migrateDatabase}=require('../src/migrate'),payments=require('../src/payment-channels');

test('verifyPaymentChannel validates and probes all six payment channels (COD, Bank Transfer, VNPAY, 9Pay, MoMo, ZaloPay)',async()=>{
 const seen=[];
 const fetcher=async url=>{seen.push(url);return {ok:true,status:200};};
 const cod=await payments.verifyPaymentChannel('cod',{maxAmountVnd:50000000,instructions:'Thanh toán khi nhận hàng',enabled:true});
 assert.equal(cod.id,'cod');
 assert.equal(cod.verified,true);

 const bank=await payments.verifyPaymentChannel('bank_transfer',{bankName:'Vietcombank',accountNumber:'0123456789',accountHolder:'CONG TY GAERU',branch:'Hà Nội',transferSyntax:'GAERU {MA_DON}',enabled:true});
 assert.equal(bank.id,'bank_transfer');
 assert.equal(bank.verified,true);
 assert.match(bank.message,/Vietcombank.*0123456789/);

 const vnpay=await payments.verifyPaymentChannel('vnpay',{tmnCode:'TEST1234',hashSecret:'vnpay-secret-key-123456',environment:'sandbox',enabled:true},{config:{PUBLIC_BASE_URL:'https://gaeru.com'},fetcher});
 assert.equal(vnpay.id,'vnpay');
 assert.equal(vnpay.verified,true);
 assert.match(seen[0],/sandbox\.vnpayment\.vn/);

 const ninepay=await payments.verifyPaymentChannel('9pay',{merchantKey:'MERCHANT01',secretKey:'9pay-secret-key-123456',checksumKey:'9pay-checksum-key-123456',environment:'sandbox',enabled:true},{config:{PUBLIC_BASE_URL:'https://gaeru.com'},fetcher});
 assert.equal(ninepay.id,'9pay');
 assert.equal(ninepay.verified,true);
 assert.match(seen[1],/sand-payment\.9pay\.vn/);

 const momo=await payments.verifyPaymentChannel('momo',{partnerCode:'MOMOGAERU',accessKey:'MOMOACCESS1',secretKey:'momo-secret-key-123456',environment:'sandbox',enabled:true},{config:{PUBLIC_BASE_URL:'https://gaeru.com'},fetcher});
 assert.equal(momo.id,'momo');
 assert.equal(momo.verified,true);
 assert.match(seen[2],/test-payment\.momo\.vn/);

 const zalopay=await payments.verifyPaymentChannel('zalopay',{appId:'2554',key1:'zalopay-key1-secret-123456',key2:'zalopay-key2-secret-123456',environment:'sandbox',enabled:true},{config:{PUBLIC_BASE_URL:'https://gaeru.com'},fetcher});
 assert.equal(zalopay.id,'zalopay');
 assert.equal(zalopay.verified,true);
 assert.match(seen[3],/sb-openapi\.zalopay\.vn/);

 await assert.rejects(()=>payments.verifyPaymentChannel('bank_transfer',{bankName:'VCB',accountNumber:'12',accountHolder:'GAERU',transferSyntax:'GAERU'}),e=>e.status===400);
 await assert.rejects(()=>payments.verifyPaymentChannel('vnpay',{tmnCode:'BAD',hashSecret:'short'}),e=>e.status===400);
 await assert.rejects(()=>payments.verifyPaymentChannel('9pay',{merchantKey:'M1',secretKey:'short',checksumKey:'short'}),e=>e.status===400);
 await assert.rejects(()=>payments.verifyPaymentChannel('momo',{partnerCode:'M',accessKey:'A',secretKey:'short'}),e=>e.status===400);
 await assert.rejects(()=>payments.verifyPaymentChannel('zalopay',{appId:'abc',key1:'short',key2:'short'}),e=>e.status===400);
});

test('enabled payment methods auto-display at checkout, auto-match transactions, and auto-approve prepaid orders to processing (skipping confirmed)',async t=>{
 const db=await PGlite.create();
 let queue=Promise.resolve();
 async function lock(){const prev=queue;let release;queue=new Promise(r=>{release=r;});await prev;return release;}
 async function rawQuery(sql,values){const r=!values&&sql.includes(';')?(await db.exec(sql)).at(-1):await db.query(sql,values);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};}
 const pool={
  async query(sql,values){const release=await lock();try{return await rawQuery(sql,values);}finally{release();}},
  async connect(){const release=await lock();return {query:rawQuery,release};},
  end:()=>db.close()
 };
 await migrateDatabase(pool);
 await pool.query(`INSERT INTO store_settings(setting_key, setting_value) VALUES ('shipping_rates', '{"Hà Nội": 30000}'::jsonb) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`);
 const prod=(await pool.query(`INSERT INTO products(slug,name,category,image_url,active) VALUES('gaeru-k9-test','GAERU K9','audio','/assets/products/k9.webp',true) RETURNING id`)).rows[0];
 const variantRow=(await pool.query(`INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'K9-TEST-USBC','USB-C',200000,20,true) RETURNING id`,[prod.id])).rows[0];
 const mainWh=(await pool.query(`SELECT id FROM warehouses WHERE code='MAIN' LIMIT 1`)).rows[0];
 if(mainWh)await pool.query(`INSERT INTO warehouse_stock(warehouse_id,variant_id,quantity) VALUES($1,$2,20) ON CONFLICT(warehouse_id,variant_id) DO UPDATE SET quantity=20`,[mainWh.id,variantRow.id]);
 assert.ok(variantRow?.id);

 const secret=randomBytes(48).toString('hex');
 const app=createApp({
  config:{
   NODE_ENV:'test',
   SESSION_SECRET:secret,
   ADMIN_USERNAME:'payment-owner',
   ADMIN_PASSWORD_HASH:bcrypt.hashSync('Owner-payment-pass',4),
   PUBLIC_BASE_URL:'https://gaeru.com',
   STORE_ORDERS_ENABLED:true,
   paymentFetcher:async()=>({ok:true,status:200})
  },
  pool,
  sessionStore:new session.MemoryStore()
 });
 const server=app.listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await pool.end();});
 const base='http://127.0.0.1:'+server.address().port;
 let cookie='',csrf='';
 async function api(path,method='GET',body,extraHeaders={}){
  const r=await fetch(base+path,{method,redirect:'manual',headers:{Cookie:cookie,'X-CSRF-Token':csrf,...extraHeaders,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
  const text=await r.text();
  let data={};
  try{data=text?JSON.parse(text):{};}catch{data={raw:text};}
  if(data?.csrfToken)csrf=data.csrfToken;
  return {status:r.status,headers:r.headers,data};
 }
 await api('/api/csrf');
 assert.equal((await api('/api/auth/login','POST',{username:'payment-owner',password:'Owner-payment-pass'})).status,200);

 let list=await api('/api/gaeru_ceo/owner/payments');
 assert.equal(list.status,200);
 assert.deepEqual(list.data.channels.map(c=>c.id),['cod','bank_transfer','vnpay','9pay','momo','zalopay']);

 // Test COD default connection
 assert.equal((await api('/api/gaeru_ceo/owner/payments/cod/test','POST',{version:0,password:'Owner-payment-pass'})).status,200);

 // Configure, test, and enable Bank Transfer
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/payment_bank_transfer','PUT',{
  version:0,
  password:'Owner-payment-pass',
  data:{bankName:'Techcombank',accountNumber:'190388889999',accountHolder:'CONG TY TNHH GAERU',branch:'Hà Nội',transferSyntax:'GAERU {MA_DON}',enabled:true}
 })).status,200);
 assert.equal((await api('/api/gaeru_ceo/owner/payments/bank_transfer/test','POST',{version:1,password:'Owner-payment-pass'})).status,200);

 // Configure, test, and enable VNPAY
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/vnpay','PUT',{
  version:0,
  password:'Owner-payment-pass',
  data:{tmnCode:'GAERU123',hashSecret:'vnpay-test-secret-key',environment:'sandbox',enabled:true}
 })).status,200);
 assert.equal((await api('/api/gaeru_ceo/owner/payments/vnpay/test','POST',{version:1,password:'Owner-payment-pass'})).status,200);

 // Configure, test, and enable 9Pay
 assert.equal((await api('/api/gaeru_ceo/owner/configuration/payment_9pay','PUT',{
  version:0,
  password:'Owner-payment-pass',
  data:{merchantKey:'GAERU_9PAY',secretKey:'ninepay-secret-key',checksumKey:'ninepay-checksum-key',environment:'sandbox',enabled:true}
 })).status,200);
 assert.equal((await api('/api/gaeru_ceo/owner/payments/9pay/test','POST',{version:1,password:'Owner-payment-pass'})).status,200);

 // Configure, test, and enable MoMo
 const saveMomo=await api('/api/gaeru_ceo/owner/configuration/payment_momo','PUT',{
  version:0,
  password:'Owner-payment-pass',
  data:{partnerCode:'MOMOGAERU',accessKey:'MOMOACCESS1',secretKey:'momo-secret-key-123456',environment:'sandbox',enabled:true}
 });
 assert.equal(saveMomo.status,200);
 assert.equal(saveMomo.data.data.secretConfigured,true);
 assert.ok(!JSON.stringify(saveMomo.data).includes('momo-secret-key-123456'));
 assert.equal((await api('/api/gaeru_ceo/owner/payments/momo/test','POST',{version:1,password:'Owner-payment-pass'})).status,200);

 // Configure, test, and enable ZaloPay
 const saveZalopay=await api('/api/gaeru_ceo/owner/configuration/payment_zalopay','PUT',{
  version:0,
  password:'Owner-payment-pass',
  data:{appId:'2554',key1:'zalopay-key1-secret-123456',key2:'zalopay-key2-secret-123456',environment:'sandbox',enabled:true}
 });
 assert.equal(saveZalopay.status,200);
 assert.equal(saveZalopay.data.data.secretConfigured,true);
 assert.ok(!JSON.stringify(saveZalopay.data).includes('zalopay-key1-secret-123456'));
 assert.equal((await api('/api/gaeru_ceo/owner/payments/zalopay/test','POST',{version:1,password:'Owner-payment-pass'})).status,200);

 list=await api('/api/gaeru_ceo/owner/payments');
 assert.ok(list.data.channels.every(c=>c.verified===true&&c.enabled===true));

 // Verify public checkout settings automatically expose all 6 enabled payment methods + bankTransfer info
 const publicSettings=await api('/api/settings/public');
 assert.equal(publicSettings.status,200);
 assert.deepEqual(publicSettings.data.paymentMethods,['cod','bank_transfer','vnpay','9pay','momo','zalopay']);
 assert.equal(publicSettings.data.bankTransfer.bankName,'Techcombank');
 assert.equal(publicSettings.data.bankTransfer.accountNumber,'190388889999');

 const customer={name:'Nguyễn Văn An',email:'an.checkout@example.com',phone:'0829191080',address:'12 Nguyễn Trãi, Thanh Xuân',city:'Hà Nội',note:''};

 // 1) Place MoMo order -> verify signed MoMo paymentUrl -> send MoMo IPN -> verify order auto-transitions to 'processing' (Chờ gửi hàng) skipping 'confirmed'
 const momoOrderRes=await api('/api/orders','POST',{customer,paymentMethod:'momo',items:[{variantId:variantRow.id,quantity:1}]});
 assert.equal(momoOrderRes.status,201);
 assert.match(momoOrderRes.data.paymentUrl,/^https:\/\/test-payment\.momo\.vn\/v2\/gateway\/pay\?/);
 const momoOrder=momoOrderRes.data.order;
 assert.equal(momoOrder.status,'pending');

 const momoSig=createHmac('sha256','momo-secret-key-123456').update(`partnerCode=MOMOGAERU&orderId=${momoOrder.orderNumber}&amount=${momoOrder.totalVnd}&resultCode=0&transId=MOMO998877`,'utf8').digest('hex');
 const momoIpn=await api('/api/payments/momo/ipn','POST',{
  partnerCode:'MOMOGAERU',
  orderId:momoOrder.orderNumber,
  amount:momoOrder.totalVnd,
  resultCode:0,
  transId:'MOMO998877',
  signature:momoSig
 });
 assert.equal(momoIpn.status,200);
 assert.equal(momoIpn.data.resultCode,0);
 assert.equal(momoIpn.data.paymentStatus,'paid');
 assert.equal(momoIpn.data.orderStatus,'processing');

 const momoStatus=await api(`/api/payments/order-status?order=${encodeURIComponent(momoOrder.orderNumber)}`);
 assert.equal(momoStatus.status,200);
 assert.equal(momoStatus.data.order.paymentStatus,'paid');
 assert.equal(momoStatus.data.order.status,'processing');

 // 2) Place ZaloPay order -> verify signed ZaloPay paymentUrl -> send ZaloPay callback IPN -> verify order auto-transitions to 'processing'
 const zaloOrderRes=await api('/api/orders','POST',{customer,paymentMethod:'zalopay',items:[{variantId:variantRow.id,quantity:1}]});
 assert.equal(zaloOrderRes.status,201);
 assert.match(zaloOrderRes.data.paymentUrl,/^https:\/\/sb-openapi\.zalopay\.vn\/v2\/pay\?/);
 const zaloOrder=zaloOrderRes.data.order;
 const zaloDataJson=JSON.stringify({app_id:2554,app_trans_id:`261027_${zaloOrder.orderNumber}`,amount:zaloOrder.totalVnd,zp_trans_id:'ZLP112233'});
 const zaloMac=createHmac('sha256','zalopay-key2-secret-123456').update(zaloDataJson,'utf8').digest('hex');
 const zaloIpn=await api('/api/payments/zalopay/ipn','POST',{data:zaloDataJson,mac:zaloMac});
 assert.equal(zaloIpn.status,200);
 assert.equal(zaloIpn.data.return_code,1);
 assert.equal(zaloIpn.data.paymentStatus,'paid');
 assert.equal(zaloIpn.data.orderStatus,'processing');

 // 3) Place Bank Transfer order -> verify bankTransfer instructions -> match via owner reconcile endpoint -> verify order auto-transitions to 'processing'
 const bankOrderRes=await api('/api/orders','POST',{customer,paymentMethod:'bank_transfer',items:[{variantId:variantRow.id,quantity:1}]});
 assert.equal(bankOrderRes.status,201);
 const bankOrder=bankOrderRes.data.order;
 assert.equal(bankOrderRes.data.bankTransfer.transferContent,`GAERU ${bankOrder.orderNumber}`);

 const reconcileRes=await api('/api/gaeru_ceo/owner/payments/reconcile','POST',{
  provider:'bank_transfer',
  orderNumber:`Chuyen khoan GAERU ${bankOrder.orderNumber}`,
  amountVnd:bankOrder.totalVnd,
  providerTransactionId:'FT2630012345',
  password:'Owner-payment-pass'
 });
 assert.equal(reconcileRes.status,200);
 assert.equal(reconcileRes.data.paymentStatus,'paid');
 assert.equal(reconcileRes.data.orderStatus,'processing');
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
