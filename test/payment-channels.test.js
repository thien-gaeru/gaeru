const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite'),bcrypt=require('bcryptjs'),session=require('express-session');
const {createApp}=require('../src/app'),{migrateDatabase}=require('../src/migrate'),payments=require('../src/payment-channels');

test('verifyPaymentChannel validates and probes each payment channel (COD, Bank Transfer, VNPAY, 9Pay)',async()=>{
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

 await assert.rejects(()=>payments.verifyPaymentChannel('bank_transfer',{bankName:'VCB',accountNumber:'12',accountHolder:'GAERU',transferSyntax:'GAERU'}),e=>e.status===400);
 await assert.rejects(()=>payments.verifyPaymentChannel('vnpay',{tmnCode:'BAD',hashSecret:'short'}),e=>e.status===400);
 await assert.rejects(()=>payments.verifyPaymentChannel('9pay',{merchantKey:'M1',secretKey:'short',checksumKey:'short'}),e=>e.status===400);
});

test('owner payment management consolidates configuration, connection testing and availability toggles',async t=>{
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
 async function api(path,method='GET',body){
  const r=await fetch(base+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
  const data=await r.json();
  if(data?.csrfToken)csrf=data.csrfToken;
  return {status:r.status,data};
 }
 await api('/api/csrf');
 assert.equal((await api('/api/auth/login','POST',{username:'payment-owner',password:'Owner-payment-pass'})).status,200);

 let list=await api('/api/gaeru_ceo/owner/payments');
 assert.equal(list.status,200);
 assert.deepEqual(list.data.channels.map(c=>c.id),['cod','bank_transfer','vnpay','9pay']);

 // Test COD default connection
 const codTest=await api('/api/gaeru_ceo/owner/payments/cod/test','POST',{version:0,password:'Owner-payment-pass'});
 assert.equal(codTest.status,200);
 assert.equal(codTest.data.verified,true);

 // Configure and test Bank Transfer
 const saveBank=await api('/api/gaeru_ceo/owner/configuration/payment_bank_transfer','PUT',{
  version:0,
  password:'Owner-payment-pass',
  data:{bankName:'Techcombank',accountNumber:'190388889999',accountHolder:'CONG TY TNHH GAERU',branch:'Hà Nội',transferSyntax:'GAERU {MA_DON}',enabled:false}
 });
 assert.equal(saveBank.status,200);
 const testBank=await api('/api/gaeru_ceo/owner/payments/bank_transfer/test','POST',{version:1,password:'Owner-payment-pass'});
 assert.equal(testBank.status,200);
 assert.equal(testBank.data.verified,true);
 const toggleBank=await api('/api/gaeru_ceo/owner/payments/bank_transfer/availability','PATCH',{version:1,enabled:true,password:'Owner-payment-pass'});
 assert.equal(toggleBank.status,200);
 assert.equal(toggleBank.data.enabled,true);

 // Configure and test VNPAY
 const saveVnpay=await api('/api/gaeru_ceo/owner/configuration/vnpay','PUT',{
  version:0,
  password:'Owner-payment-pass',
  data:{tmnCode:'GAERU123',hashSecret:'vnpay-test-secret-key',environment:'sandbox',enabled:true}
 });
 assert.equal(saveVnpay.status,200);
 const testVnpay=await api('/api/gaeru_ceo/owner/payments/vnpay/test','POST',{version:1,password:'Owner-payment-pass'});
 assert.equal(testVnpay.status,200);
 assert.equal(testVnpay.data.verified,true);

 // Configure and test 9Pay
 const saveNinepay=await api('/api/gaeru_ceo/owner/configuration/payment_9pay','PUT',{
  version:0,
  password:'Owner-payment-pass',
  data:{merchantKey:'GAERU_9PAY',secretKey:'ninepay-secret-key',checksumKey:'ninepay-checksum-key',environment:'sandbox',enabled:true}
 });
 assert.equal(saveNinepay.status,200);
 assert.equal(saveNinepay.data.data.secretConfigured,true);
 assert.ok(!JSON.stringify(saveNinepay.data).includes('ninepay-secret-key'));
 const testNinepay=await api('/api/gaeru_ceo/owner/payments/9pay/test','POST',{version:1,password:'Owner-payment-pass'});
 assert.equal(testNinepay.status,200);
 assert.equal(testNinepay.data.verified,true);

 list=await api('/api/gaeru_ceo/owner/payments');
 assert.ok(list.data.channels.every(c=>c.verified===true));
});

test('admin payment workspace renders all four channels and dispatches connection tests',async()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const records={
  payment_cod:{version:1,data:{enabled:true,maxAmountVnd:50000000,instructions:'COD'}},
  payment_bank_transfer:{version:2,data:{bankName:'VCB',accountNumber:'0123456789',accountHolder:'GAERU',branch:'HN',transferSyntax:'GAERU {MA_DON}',enabled:true}},
  vnpay:{version:3,data:{tmnCode:'GAERU123',environment:'sandbox',enabled:true,secretConfigured:true}},
  payment_9pay:{version:1,data:{merchantKey:'M9PAY',environment:'sandbox',enabled:false,secretConfigured:true}}
 };
 const root={innerHTML:''},listeners={},calls=[];
 const admin={
  user:{role:'owner',source:'bootstrap'},
  showGlobal(){},
  request:async(path,options={})=>{
   calls.push({path,options});
   if(path==='/api/gaeru_ceo/owner/configuration')return {records,services:{},callbacks:{vnpayReturn:'https://gaeru.com/api/payments/vnpay/return',vnpayIpn:'https://gaeru.com/api/payments/vnpay/ipn',ninepayReturn:'https://gaeru.com/api/payments/9pay/return',ninepayIpn:'https://gaeru.com/api/payments/9pay/ipn'}};
   if(path==='/api/gaeru_ceo/owner/payments')return {channels:[
    {id:'cod',configId:'payment_cod',verified:true,enabled:true,configured:true,version:1},
    {id:'bank_transfer',configId:'payment_bank_transfer',verified:true,enabled:true,configured:true,version:2},
    {id:'vnpay',configId:'vnpay',verified:false,enabled:true,configured:true,version:3},
    {id:'9pay',configId:'payment_9pay',verified:false,enabled:false,configured:true,version:1}
   ]};
   return {verified:true,message:'Đã xác minh kết nối VNPAY.'};
  }
 };
 const context={window:{GAERUAdmin:admin},document:{addEventListener:(t,fn)=>(listeners[t]||=[]).push(fn),querySelector:s=>s==='#payment-configuration'?root:null,getElementById:()=>null}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../admin/configuration.js'),'utf8'),context);
 await context.window.GAERUConfiguration.mountPayments();
 for(const id of ['cod','bank_transfer','vnpay','9pay']){
  assert.match(root.innerHTML,new RegExp(`data-payment-test="${id}"`));
  assert.match(root.innerHTML,new RegExp(`data-payment-enable="${id}"`));
 }
 const status={textContent:''},form={dataset:{version:'3'},elements:{password:{value:'owner-pass',focus(){}},factorCode:{value:''}}},details={id:'config-panel-vnpay',querySelector:s=>s==='form'?form:status},button={dataset:{paymentTest:'vnpay'},disabled:false,closest:()=>details};
 for(const fn of listeners.click)await fn({target:{closest:s=>s.includes('data-payment-test')?button:null}});
 assert.ok(calls.some(c=>c.path==='/api/gaeru_ceo/owner/payments/vnpay/test'&&c.options.method==='POST'));
});
