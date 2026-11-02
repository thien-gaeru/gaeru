const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {migrateDatabase}=require('../src/migrate');
const {writeRecord}=require('../src/admin-configuration');
const payment=require('../src/payment-channels');
const config={SESSION_SECRET:'payment-verification-state-fixture-secret',PUBLIC_BASE_URL:'https://example.test',NODE_ENV:'test'};
const actor={username:'fixture-owner',role:'owner',source:'bootstrap'};
async function fixture(t){
 const db=await PGlite.create();t.after(()=>db.close());let queue=Promise.resolve();
 async function lock(){let release;const old=queue;queue=new Promise(r=>release=r);await old;return release;}
 async function query(sql,args){const r=!args&&sql.includes(';')?(await db.exec(sql)).at(-1):await db.query(sql,args);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};}
 const pool={async query(sql,args){const release=await lock();try{return await query(sql,args);}finally{release();}},async connect(){const release=await lock();return {query,release};}};
 await migrateDatabase(pool);return pool;
}
const momo={partnerCode:'FIXTUREPARTNER',accessKey:'FIXTUREACCESS',secretKey:'fixture-secret-key',environment:'sandbox',enabled:true};

test('upgrading revokes legacy handshake verification while preserving saved credentials and enable choices',async t=>{
 const pool=await fixture(t);
 await writeRecord(pool,config,'payment_momo',momo,0,actor);
 await pool.query("INSERT INTO payment_channel_connections(channel_id,config_version,verified_at,enabled,last_method) VALUES('momo',1,now(),true,'gateway_handshake')");
 assert.equal((await payment.listPaymentChannels(pool,config)).channels.find(x=>x.id==='momo').verified,false,'reader rejects old evidence even before migration');
 await pool.query("DELETE FROM schema_migrations WHERE name='payment-provider-verification.sql'");
 await migrateDatabase(pool);
 const row=(await pool.query("SELECT * FROM payment_channel_connections WHERE channel_id='momo'")).rows[0];
 assert.equal(row.verified_at,null);assert.equal(row.enabled,true);assert.equal(row.last_method,'legacy_unverified');
 assert.equal((await payment.readChannelRecord(pool,config,'momo')).data.secretKey,momo.secretKey);
 await migrateDatabase(pool);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name='payment-provider-verification.sql'")).rows[0].n,1);
});

test('authenticated evidence is version-bound and API authentication never claims callback verification',async t=>{
 const pool=await fixture(t);await writeRecord(pool,config,'payment_momo',momo,0,actor);
 await payment.recordGatewayEvidence(pool,'momo',1,{method:'provider_order_create',scope:'api_credentials',enabled:true});
 let row=(await payment.listPaymentChannels(pool,config)).channels.find(x=>x.id==='momo');
 assert.equal(row.verified,true);assert.equal(row.verificationScope,'api_credentials');assert.equal(row.callbackVerified,false);
 await pool.query("UPDATE payment_channel_connections SET verification_scope=NULL WHERE channel_id='momo'");
 assert.equal((await payment.listPaymentChannels(pool,config)).channels.find(x=>x.id==='momo').verified,false,'method without matching evidence scope cannot verify credentials');
 await payment.recordGatewayEvidence(pool,'momo',1,{method:'provider_order_create',scope:'api_credentials',enabled:true});
 await assert.rejects(payment.recordGatewayEvidence(pool,'momo',1,{method:'gateway_handshake'}),e=>e.status===400);
 await writeRecord(pool,config,'payment_momo',{...momo,secretKey:'changed-fixture-secret'},1,actor);
 row=(await payment.listPaymentChannels(pool,config)).channels.find(x=>x.id==='momo');
 assert.equal(row.verified,false);assert.equal(row.verifiedAt,null);assert.equal(row.verificationScope,null);
});

test('HTTP404 and a successful public homepage never authenticate VNPAY or set verified_at',async t=>{
 const pool=await fixture(t);
 await writeRecord(pool,config,'vnpay',{tmnCode:'TEST1234',hashSecret:'fixture-vnpay-secret',environment:'sandbox',enabled:true},0,actor);
 for(const status of [404,200]){
  const result=await payment.verifyAndRecordPayment(pool,config,'vnpay',1,{fetcher:async()=>new Response('public page',{status}),actor});
  assert.equal(result.verified,false);assert.equal(result.reachable,status===200);
  const stored=(await pool.query("SELECT verified_at,last_method FROM payment_channel_connections WHERE channel_id='vnpay'")).rows[0];
  assert.equal(stored.verified_at,null);assert.equal(stored.last_method,'gateway_reachability');
 }
});

test('an environment-backed VNPAY disable persists callback credentials and never resurrects checkout fallback',async t=>{
 const pool=await fixture(t),vnpay={tmnCode:'TEST1234',hashSecret:'environment-fixture-secret',paymentUrl:'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',returnUrl:'https://example.test/api/payments/vnpay/return'};
 const local={...config,vnpay};const before=await payment.readChannelRecord(pool,local,'vnpay');
 assert.equal(before.data.hashSecret,vnpay.hashSecret);
 await writeRecord(pool,local,'vnpay',{...before.data,enabled:false},0,actor);
 const after=await payment.getCheckoutPaymentChannels(pool,local,vnpay);
 assert.ok(!after.methods.includes('vnpay'));assert.equal(after.configs.vnpay,undefined);
 assert.equal(after.callbackConfigs.vnpay.hashSecret,vnpay.hashSecret);
 assert.equal(after.versions.vnpay,1);
});
