'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),express=require('express');
const {PGlite}=require('@electric-sql/pglite'),{migrateDatabase}=require('../src/migrate');
const {schemas,publicRecord,readRecord}=require('../src/admin-configuration'),{seal}=require('../src/totp');
const account=require('../src/marketplace-account'),{createOmnichannelSync,syncMarketplaceOrders,syncStockToChannel}=require('../src/omnichannel-sync');
const {tiktokSignature,shopeeConnector,lazadaConnector}=require('../src/marketplace-connectors');
const config={SESSION_SECRET:'marketplace-test-configuration-0123456789'},actor={username:'audit-owner',role:'owner',source:'bootstrap',permissions:['marketplace.read','marketplace.write']};
const creds={partnerId:'123',shopId:'456',secret:'private-partner-key',accessToken:'private-access-token',refreshToken:'private-refresh-token'};
async function setup(t){const db=new PGlite();const pool={async query(sql,values){const r=!values&&sql.includes(';')?(await db.exec(sql)).at(-1):await db.query(sql,values);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};},async connect(){return{query:(...args)=>pool.query(...args),release(){}};}};t.after(()=>db.close());await migrateDatabase(pool);await pool.query(fs.readFileSync(path.join(__dirname,'../db/marketplace-sync-completion.sql'),'utf8'));return pool;}
async function save(pool,data=creds,channel='shopee'){await pool.query(`INSERT INTO store_settings(setting_key,setting_value) VALUES($1,$2) ON CONFLICT(setting_key) DO UPDATE SET setting_value=$2`,['private_admin:'+channel,JSON.stringify({version:1,cipher:seal(JSON.stringify(data),process.env.AUTH_ENCRYPTION_KEY||config.SESSION_SECRET)})]);}
test('marketplace token settings preserve secrets without returning access/refresh credentials',()=>{
 const parsed=schemas.shopee.parse({...creds,tokenExpiresAt:'2099-01-01T00:00:00Z'});assert.equal(parsed.accessToken,creds.accessToken);
 const pub=publicRecord('shopee',{version:1,data:{...parsed,verificationFingerprint:'private-hash'}});
 assert.equal(pub.data.tokenConfigured,true);assert.equal(pub.data.refreshTokenConfigured,true);for(const secret of [creds.accessToken,creds.refreshToken,creds.secret,'private-hash'])assert.ok(!JSON.stringify(pub).includes(secret));
 assert.throws(()=>account.credentials('shopee',{...creds,accessToken:''}),/Access Token/);assert.throws(()=>account.credentials('shopee',{...creds,tokenExpiresAt:'2000-01-01T00:00:00Z'}),/hết hạn/);
 const verified={...creds,connectionVerifiedAt:new Date().toISOString(),verificationFingerprint:account.fingerprint('shopee',creds)};assert.equal(account.connection('shopee',{version:1,data:verified}).verified,true);assert.equal(account.connection('shopee',{version:1,data:{...verified,secret:'changed'}}).verified,false);
});
test('missing or expired credentials fail closed before any network request',async t=>{const pool=await setup(t);let calls=0;const fetcher=async()=>{calls++;throw Error('should not call')};await save(pool,{...creds,accessToken:''});await assert.rejects(syncMarketplaceOrders(pool,config,'shopee',{actor,fetcher}),/Access Token/);await save(pool,{...creds,tokenExpiresAt:'2000-01-01T00:00:00Z'});await assert.rejects(syncStockToChannel(pool,config,'shopee',{actor,fetcher}),/hết hạn/);assert.equal(calls,0);});
test('stock sync requires verification, explicit correct-shop item/model mappings and reports provider rejections',async t=>{
 const pool=await setup(t);const p=(await pool.query(`INSERT INTO products(slug,name,category,active) VALUES('market-fixture','Fixture','audio',true) RETURNING id`)).rows[0];const variants=[];
 for(let i=0;i<3;i++)variants.push((await pool.query(`INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,$2,'Variant',100,10,true) RETURNING id`,[p.id,'fixture-'+i])).rows[0]);
 await save(pool);await assert.rejects(syncStockToChannel(pool,config,'shopee',{actor,fetcher:()=>assert.fail('no network before verification')}),/Kiểm tra kết nối/);
 const data={...creds,connectionVerifiedAt:new Date().toISOString(),verificationFingerprint:account.fingerprint('shopee',creds)};await save(pool,data);
 for(let i=0;i<2;i++)await pool.query(`INSERT INTO marketplace_sku_mappings(channel,shop_id,external_sku,variant_id,external_product_id,external_variant_id) VALUES('shopee','456',$1,$2,$3,'0')`,['sku-'+i,variants[i].id,'10'+i]);
 await pool.query(`INSERT INTO marketplace_sku_mappings(channel,shop_id,external_sku,variant_id,external_product_id) VALUES('shopee','other-shop','sku-other',$1,'999')`,[variants[2].id]);
 const requests=[];const result=await syncStockToChannel(pool,config,'shopee',{actor,fetcher:async(url,options)=>{const body=JSON.parse(options.body);requests.push({url,body});return {ok:true,json:async()=>body.item_id===100?{}:{error:'rejected'}};}});
 assert.deepEqual([result.success,result.updatedCount,result.failedCount,result.skippedCount],[false,1,1,1]);assert.equal(requests.length,2);assert.ok(requests.every(r=>new URL(r.url).searchParams.get('shop_id')==='456'));assert.ok(requests.every(r=>r.body.item_id!==999));
 const events=(await pool.query(`SELECT payload FROM marketplace_sync_events WHERE event_type='sync_stock'`)).rows;assert.equal(events.length,1);assert.ok(!JSON.stringify(events).includes(creds.accessToken));
});
test('verification only marks matching saved credentials after provider read, and mappings CRUD audit preserve business orders',async t=>{
 const pool=await setup(t);await save(pool);const p=(await pool.query(`INSERT INTO products(slug,name,category) VALUES('mapping-fixture','Fixture','audio') RETURNING id`)).rows[0];const v=(await pool.query(`INSERT INTO product_variants(product_id,sku,name,price_vnd) VALUES($1,'map-sku','Fixture',100) RETURNING id`,[p.id])).rows[0];
 const cfg={...config,accountSecurity:{authorize:async(req,fn)=>{if(req.body.password!=='test-password')throw Object.assign(Error('fresh password required'),{status:403});return fn({},pool);}}};
 let network=0;const app=express();app.use(express.json());app.use((q,_r,n)=>{q.session={csrfToken:'fixture-csrf'};q.admin=q.get('x-fixture-role')==='viewer'?{...actor,permissions:['marketplace.read']}:actor;n();});app.use('/api/gaeru_ceo',createOmnichannelSync(pool,cfg,{fetcher:async()=>{network++;return{ok:true,json:async()=>({response:{order_list:[]}})};}}).admin);app.use((e,_q,r,_n)=>r.status(e.status||400).json({error:e.message}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const call=async(url,method='GET',body,headers={})=>{const r=await fetch(base+'/api/gaeru_ceo'+url,{method,headers:{'Content-Type':'application/json','x-csrf-token':'fixture-csrf',...headers},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json()};};
 assert.equal((await call('/marketplace/shopee/verify','POST',{password:'wrong'})).status,403);assert.equal(network,0);
 const check=await call('/marketplace/shopee/verify','POST',{password:'test-password'});assert.equal(check.status,200);assert.equal(check.body.connection.verified,true);assert.equal(network,1);assert.ok(!JSON.stringify(check.body).includes(creds.accessToken));assert.equal((await readRecord(pool,cfg,'shopee')).version,2);
 const input={channel:'shopee',shopId:'456',externalSku:'external',variantId:v.id,externalProductId:'100',externalVariantId:'0'};
 assert.equal((await call('/marketplace/mappings','POST',input,{'x-fixture-role':'viewer'})).status,403);
 assert.equal((await call('/marketplace/mappings','POST',{...input,externalProductId:'not-a-number'})).status,400);
 const map=await call('/marketplace/mappings','POST',input);assert.equal(map.status,200);assert.equal(map.body.mapping.external_product_id,'100');assert.equal((await call('/marketplace/mappings/'+map.body.mapping.id,'DELETE')).status,200);assert.equal((await pool.query('SELECT count(*)::int AS count FROM audit_events')).rows[0].count,3);
});
test('TikTok signature binds sorted query, shop cipher and exact JSON body; token is excluded',()=>{
 const secret='fixture-secret',params={timestamp:123,shop_cipher:'cipher',app_key:'key',access_token:'token',sign:'old'},body='{"a":1}';const expected=crypto.createHmac('sha256',secret).update(secret+'/path'+'app_keykeyshop_cipherciphertimestamp123'+body+secret).digest('hex');assert.equal(tiktokSignature(secret,'/path',params,body),expected);assert.notEqual(tiktokSignature(secret,'/path',{...params,shop_cipher:'changed'},body),expected);assert.notEqual(tiktokSignature(secret,'/path',params,'{"a":2}'),expected);
});
test('Shopee list summaries retrieve order details before exposing products',async()=>{
 const calls=[];const rows=await shopeeConnector.fetchOrders({partnerId:'1',partnerKey:'secret',shopId:'2',accessToken:'token'},{fetcher:async url=>{calls.push(url);return{ok:true,json:async()=>url.includes('get_order_detail')?{response:{order_list:[{order_sn:'ORDER-1',item_list:[{model_sku:'SKU',item_name:'Fixture',model_quantity_purchased:1,model_discounted_price:123}],total_amount:123}]}}:{response:{order_list:[{order_sn:'ORDER-1'}]}}};}});assert.equal(calls.length,2);assert.equal(rows[0].items[0].externalSku,'SKU');
});
test('Lazada stock request encodes XML metacharacters without adding extra SKU elements',async()=>{
 await lazadaConnector.updateStock({appKey:'a',appSecret:'b',accessToken:'c',sku:'A<&"',quantity:7},{fetcher:async(_u,o)=>{const xml=new URLSearchParams(o.body).get('payload');assert.ok(xml.includes('A&lt;&amp;&quot;'));assert.equal((xml.match(/<Sku>/g)||[]).length,1);return{ok:true,json:async()=>({code:'0'})};}});
});
test('Shopee pagination follows provider cursor and rejects a repeating cursor instead of dropping orders',async()=>{
 let calls=0;const data={order_sn:'one',item_list:[{model_sku:'a',model_quantity_purchased:1}]};
 const creds={partnerId:'1',partnerKey:'key',shopId:'2',accessToken:'token'};
 const rows=await shopeeConnector.fetchOrders(creds,{fetcher:async url=>{calls++;const cursor=new URL(url).searchParams.get('cursor');return{ok:true,json:async()=>({response:{order_list:[{...data,order_sn:cursor?'two':'one'}],more:!cursor,next_cursor:'next'}})};}});
 assert.equal(calls,2);assert.deepEqual(rows.map(o=>o.externalOrderId),['one','two']);
 await assert.rejects(shopeeConnector.fetchOrders(creds,{fetcher:async()=>({ok:true,json:async()=>({response:{order_list:[data],more:true,next_cursor:'same'}})})}),/Chưa nhận hết/);
});
