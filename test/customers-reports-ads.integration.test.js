const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),{randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite'),{migrateDatabase}=require('../src/migrate'),ads=require('../src/tiktok-ads'),{writeRecord}=require('../src/admin-configuration'),{channelReport,upsertConnectedSales}=require('../src/channel-reports');
const config={SESSION_SECRET:'ads-integration-fixture-with-at-least-32-characters'};
const owner={username:'fixture-owner',source:'bootstrap',role:'owner',permissions:['reports.read','customers.read','settings.write']};
async function database(t){const db=await PGlite.create();t.after(()=>db.close());let queue=Promise.resolve();async function lock(){let release;const p=queue;queue=new Promise(r=>release=r);await p;return release;}async function query(sql,args){const r=!args&&sql.includes(';')?(await db.exec(sql)).at(-1):await db.query(sql,args);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};}const pool={async query(sql,args){const release=await lock();try{return await query(sql,args);}finally{release();}},async connect(){const release=await lock();return {query,release};}};await migrateDatabase(pool);return pool;}
const advertiserId='1234567890123',accessToken='fixture-read-only-access-token';
const accountRow={advertiser_id:advertiserId,name:'Fixture Ads',currency:'VND',timezone:'Asia/Jakarta',status:'STATUS_ENABLE'};
const response=(data,status=200)=>new Response(JSON.stringify({code:0,data}),{status,headers:{'content-type':'application/json'}});
const dataRow=(date,spend)=>({dimensions:{advertiser_id:advertiserId,stat_time_day:date+' 00:00:00'},metrics:{spend}});
function provider(rows=[],overrides={}){return async(url,options)=>{const u=new URL(url);assert.equal(u.origin,'https://business-api.tiktok.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.headers['Access-Token'],accessToken);assert.ok(!u.toString().includes(accessToken));assert.ok(options.signal);if(u.pathname.endsWith('/advertiser/info/'))return response({list:[{...accountRow,...overrides.account}]});assert.equal(u.pathname,'/open_api/v1.3/report/integrated/get/');assert.deepEqual(JSON.parse(u.searchParams.get('dimensions')),['advertiser_id','stat_time_day']);assert.deepEqual(JSON.parse(u.searchParams.get('metrics')),['spend']);return response({list:rows,page_info:{page:1,total_page:1}});};}
async function server(t,app){const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));t.after(()=>new Promise(r=>s.close(r)));return 'http://127.0.0.1:'+s.address().port;}

test('customer verification filters and counts use email verification timestamps independently from account locks',async t=>{
 const pool=await database(t);await pool.query("INSERT INTO customers(full_name,email,phone,password_hash,active,email_verified_at) VALUES('Verified One','v@example.test','0900000000','fixture',true,now()),('Unverified Two','u@example.test','0900000001','fixture',false,NULL),('Unverified Three','u2@example.test','0900000002','fixture',true,NULL)");
 const app=express();app.use((req,_res,next)=>{req.session={admin:owner};req.admin=owner;next();});app.use('/api',require('../src/store-api').createStoreApi(pool));const base=await server(t,app);
 let r=await fetch(base+'/api/gaeru_ceo/customers?verification=all'),data=await r.json();assert.equal(r.status,200);assert.equal(data.customers.length,3);assert.deepEqual(data.verificationCounts,{all:3,verified:1,unverified:2});
 data=await(await fetch(base+'/api/gaeru_ceo/customers?verification=verified')).json();assert.equal(data.customers.length,1);assert.equal(data.customers[0].email,'v@example.test');
 data=await(await fetch(base+'/api/gaeru_ceo/customers?verification=unverified')).json();assert.equal(data.customers.length,2);assert.ok(data.customers.some(c=>!c.active));assert.ok(data.customers.every(c=>!c.emailVerified));
 data=await(await fetch(base+'/api/gaeru_ceo/customers?verification=unverified&q=Two')).json();assert.equal(data.pagination.total,1);assert.deepEqual(data.verificationCounts,{all:1,verified:0,unverified:1});
 assert.equal((await fetch(base+'/api/gaeru_ceo/customers?verification=unknown')).status,400);
});

test('TikTok Ads client reads precise daily spend with authenticated fixed-host requests and account timezone',async()=>{
 const result=await ads.fetchSpend({advertiserId,accessToken},'2026-10-01','2026-10-02',{fetcher:provider([dataRow('2026-10-01','123.456789')])});
 assert.equal(result.account.timezone,'Asia/Jakarta');assert.equal(result.account.currency,'VND');assert.deepEqual(result.days,[{date:'2026-10-01',spendMicros:'123456789'},{date:'2026-10-02',spendMicros:'0'}]);assert.match(result.coverage,/không gồm GMV Max/);assert.equal(ads.decimal('123456789'),'123.456789');
 for(const value of ['NaN','-1','1e4','1.1234567'])assert.throws(()=>ads.micros(value));
 assert.throws(()=>ads.dates('2026-02-31','2026-03-01'));assert.throws(()=>ads.dates('2026-01-01','2026-03-01'));
});

test('provider errors, duplicates and cross-account rows fail closed and never expose token values',async()=>{
 const settings={advertiserId,accessToken};
 await assert.rejects(ads.fetchSpend(settings,'2026-10-01','2026-10-02',{fetcher:async()=>new Response(accessToken,{status:401})}),e=>!e.message.includes(accessToken)&&e.status===502);
 for(const rows of [[dataRow('2026-10-01','1'),dataRow('2026-10-01','2')],[{...dataRow('2026-10-01','1'),dimensions:{advertiser_id:'9999999',stat_time_day:'2026-10-01'}}],[dataRow('2026-10-03','1')]])await assert.rejects(ads.fetchSpend(settings,'2026-10-01','2026-10-02',{fetcher:provider(rows)}));
 await assert.rejects(ads.account(settings,{fetcher:provider([],{account:{timezone:'not-a-timezone'}})}));
});

test('a complete empty BASIC provider report confirms zero only for the requested account-local days',async()=>{
 const fetcher=async(url,options)=>url.includes('/advertiser/info/')?provider([])(url,options):response({list:[],page_info:{page:1,total_page:0,total_number:0}});
 const result=await ads.fetchSpend({advertiserId,accessToken},'2026-10-01','2026-10-02',{fetcher});
 assert.deepEqual(result.days,[{date:'2026-10-01',spendMicros:'0'},{date:'2026-10-02',spendMicros:'0'}]);assert.equal(result.account.timezone,'Asia/Jakarta');assert.match(result.coverage,/không gồm GMV Max/);
});

test('sync replaces daily costs without duplicates and stores currency and source timezone',async t=>{
 const pool=await database(t);await writeRecord(pool,config,'tiktok_ads',{advertiserId,accessToken,enabled:true},0,owner);
 await ads.synchronize(pool,config,1,'2026-10-01','2026-10-02',{fetcher:provider([dataRow('2026-10-01','123.456789')]),actor:owner});
 const result=await ads.synchronize(pool,config,1,'2026-10-01','2026-10-02',{fetcher:provider([dataRow('2026-10-01','200')]),actor:owner});assert.equal(result.totalSpend,'200.000000');
 const rows=(await pool.query('SELECT * FROM advertising_daily_spend ORDER BY stat_date')).rows;assert.equal(rows.length,2);assert.equal(String(rows[0].spend_micros),'200000000');assert.equal(rows[0].timezone,'Asia/Jakarta');assert.equal(rows[0].currency,'VND');
 const state=await ads.info(pool,config);assert.equal(state.connection.connected,true);assert.equal(state.configuration.secretConfigured,true);assert.ok(!JSON.stringify(state).includes(accessToken));
 assert.ok(!JSON.stringify((await pool.query('SELECT * FROM store_settings UNION ALL SELECT * FROM store_settings WHERE false')).rows).includes(accessToken));assert.ok(!JSON.stringify((await pool.query('SELECT * FROM audit_events')).rows).includes(accessToken));
});

test('config changes during provider retrieval reject stale sync and partial provider failure writes no costs',async t=>{
 const pool=await database(t);await writeRecord(pool,config,'tiktok_ads',{advertiserId,accessToken,enabled:true},0,owner);let changed=false;
 const fetcher=async(url,options)=>{if(url.includes('/report/')){changed=true;await writeRecord(pool,config,'tiktok_ads',{advertiserId,accessToken:'second-fixture-read-only-token',enabled:true},1,owner);}return provider([dataRow('2026-10-01','25')])(url,options);};
 await assert.rejects(ads.synchronize(pool,config,1,'2026-10-01','2026-10-01',{fetcher}),e=>e.status===409);assert.equal(changed,true);assert.equal((await pool.query('SELECT count(*)::int n FROM advertising_daily_spend')).rows[0].n,0);
});

test('an older slow Ads request cannot overwrite a later successful snapshot for the same account',async t=>{
 const pool=await database(t);await writeRecord(pool,config,'tiktok_ads',{advertiserId,accessToken,enabled:true},0,owner);
 let releaseOld,started;const oldStarted=new Promise(resolve=>started=resolve),oldBlocked=new Promise(resolve=>releaseOld=resolve);
 const oldFetcher=async(url,options)=>{if(url.includes('/report/')){started();await oldBlocked;}return provider([dataRow('2026-10-01','10')])(url,options);};
 const old=ads.synchronize(pool,config,1,'2026-10-01','2026-10-01',{fetcher:oldFetcher,actor:owner});await oldStarted;
 await ads.synchronize(pool,config,1,'2026-10-01','2026-10-01',{fetcher:provider([dataRow('2026-10-01','20')]),actor:owner});
 releaseOld();await assert.rejects(old,e=>e.status===409&&e.code==='TIKTOK_ADS_CONFLICT');
 const row=(await pool.query('SELECT spend_micros FROM advertising_daily_spend')).rows[0];assert.equal(String(row.spend_micros),'20000000');
 assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='ads.tiktok.sync'")).rows[0].n,1);
});

test('snapshot safety upgrades an already-applied base migration while preserving stored connections and spend',async t=>{
 const pool=await database(t);await writeRecord(pool,config,'tiktok_ads',{advertiserId,accessToken,enabled:true},0,owner);
 await pool.query("INSERT INTO tiktok_ads_connections(advertiser_id,config_version,account_name,currency,timezone) VALUES($1,1,'Existing Ads','VND','Asia/Jakarta')",[advertiserId]);
 await pool.query("INSERT INTO advertising_daily_spend(provider,advertiser_id,stat_date,currency,timezone,spend_micros,report_type) VALUES('tiktok_ads',$1,'2026-10-01','VND','Asia/Jakarta',7000000,'BASIC')",[advertiserId]);
 // Reconstruct the prior deployed schema without rerunning its applied base feature migration.
 await pool.query('ALTER TABLE tiktok_ads_connections DROP COLUMN last_sync_request_id');await pool.query('DROP SEQUENCE tiktok_ads_sync_request_seq');await pool.query('DROP INDEX business_marketplace_order_identity');await pool.query("DELETE FROM schema_migrations WHERE name='channel-report-snapshot-safety.sql'");
 assert.equal((await pool.query("SELECT count(*)::int n FROM schema_migrations WHERE name='channel-reports-ads.sql'")).rows[0].n,1);
 await migrateDatabase(pool);assert.equal(String((await pool.query('SELECT last_sync_request_id FROM tiktok_ads_connections')).rows[0].last_sync_request_id),'0');assert.equal(String((await pool.query('SELECT spend_micros FROM advertising_daily_spend')).rows[0].spend_micros),'7000000');
 await ads.synchronize(pool,config,1,'2026-10-01','2026-10-01',{fetcher:provider([dataRow('2026-10-01','9')])});await migrateDatabase(pool);
 assert.equal(String((await pool.query('SELECT last_sync_request_id FROM tiktok_ads_connections')).rows[0].last_sync_request_id),'1');assert.equal(String((await pool.query('SELECT spend_micros FROM advertising_daily_spend')).rows[0].spend_micros),'9000000');assert.equal((await pool.query("SELECT count(*)::int n FROM pg_indexes WHERE indexname='business_marketplace_order_identity'")).rows[0].n,1);
 const audit=(await pool.query("SELECT actor_username,actor_source FROM audit_events WHERE action='ads.tiktok.sync'")).rows[0];assert.equal(audit.actor_username,'tiktok-ads-sync');assert.equal(audit.actor_source,'system');
});

test('a failure on a later provider page never commits a partial advertising cost report',async t=>{
 const pool=await database(t);await writeRecord(pool,config,'tiktok_ads',{advertiserId,accessToken,enabled:true},0,owner);let reportCalls=0;
 const fetcher=async(url,options)=>{if(url.includes('/advertiser/info/'))return provider([])(url,options);reportCalls++;const page=Number(new URL(url).searchParams.get('page'));return page===1?response({list:[dataRow('2026-10-01','10')],page_info:{page:1,total_page:2}}):new Response('fixture unavailable',{status:503});};
 await assert.rejects(ads.synchronize(pool,config,1,'2026-10-01','2026-10-02',{fetcher}));assert.equal(reportCalls,2);assert.equal((await pool.query('SELECT count(*)::int AS n FROM advertising_daily_spend')).rows[0].n,0);assert.equal((await ads.info(pool,config)).connection.connected,false);
});

test('TikTok configuration requires owner role CSRF fresh authentication and keeps token encrypted',async t=>{
 const pool=await database(t);let authCalls=0;const local={...config,tiktokAdsFetcher:provider([]),accountSecurity:{async authorize(req,action){authCalls++;if(req.body.password!=='fixture-password')throw Object.assign(Error('Rejected fixture auth'),{status:403});const c=await pool.connect();try{await c.query('BEGIN');const result=await action(null,c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}}};
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.session={csrfToken:'fixture'};req.admin=req.headers['x-role']==='manager'?{...owner,role:'manager'}:owner;next();});app.use('/api',ads.createTikTokAdsAdmin(pool,local));app.use((e,_req,res,_next)=>res.status(e.status||500).json({error:e.message}));const base=await server(t,app);
 const call=(route,method='GET',body,headers={})=>fetch(base+'/api/owner/tiktok-ads'+route,{method,headers:{'content-type':'application/json','x-csrf-token':'fixture',...headers},body:body?JSON.stringify(body):undefined});const body={version:0,password:'fixture-password',data:{advertiserId,accessToken,enabled:true}};
 assert.equal((await call('', 'GET',undefined,{'x-role':'manager'})).status,403);
 assert.equal((await call('/configuration','PUT',body,{'x-csrf-token':''})).status,403);
 assert.equal((await call('/configuration','PUT',{...body,password:'wrong'})).status,403);
 let r=await call('/configuration','PUT',body),data=await r.json();assert.equal(r.status,200);assert.equal(data.configuration.version,1);assert.equal(data.connection.connected,false);assert.ok(!JSON.stringify(data).includes(accessToken));
 r=await call('/test','POST',{version:1,password:'fixture-password'});data=await r.json();assert.equal(r.status,200);assert.equal(data.connection.connected,true);assert.equal(data.connection.timezone,'Asia/Jakarta');assert.ok(authCalls>=3);
});

test('multichannel reports aggregate web and actual adapter records without duplicating manual reconciliation',async t=>{
 const pool=await database(t);await pool.query("INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,discount_vnd,shipping_fee_vnd,total_vnd,created_at) VALUES('WEB-1','Fixture','w@example.test','0900000000','Fixture Address','Fixture City','cod','paid','completed',1200,200,300,1300,'2026-10-01T04:00:00Z'),('WEB-2','Fixture','w2@example.test','0900000001','Fixture Address','Fixture City','cod','paid','completed',800,0,0,800,'2026-10-01T05:00:00Z')");await pool.query("UPDATE orders SET return_completed_at='2026-10-02' WHERE order_number='WEB-2'");
 const manual={period:'2026-10',channel:'shopee',shopId:'fixture-shop',externalOrderId:'SAME-ORDER',orderDate:'2026-10-01',status:'completed',reconciled:true,netRevenueVnd:150,refundVnd:50};
 await pool.query("INSERT INTO business_documents(kind,period,reference,payload,calculation,status,request_key,request_hash,created_by) VALUES('marketplace','2026-10','fixture-manual',$1,'{}','approved',$2,'fixture','fixture')",[JSON.stringify(manual),randomUUID()]);
 const auth={provider:'shopee',shopId:'fixture-shop',authorizationReference:'verified-fixture-adapter',verified:true},sale={externalOrderId:'SAME-ORDER',orderDate:'2026-10-01',status:'completed',currency:'VND',grossVnd:200,refundVnd:50,sourceUpdatedAt:'2026-10-02T00:00:00Z'};
 await assert.rejects(upsertConnectedSales(pool,{...auth,verified:false},[sale]));await upsertConnectedSales(pool,auth,[sale]);await upsertConnectedSales(pool,auth,[sale]);
 await upsertConnectedSales(pool,auth,[{...sale,grossVnd:400,sourceUpdatedAt:'2026-10-01T00:00:00Z'}]);
 const report=await channelReport(pool,'2026-10-01','2026-10-02');assert.equal(report.channels[0].salesVnd,1000);assert.equal(report.channels[0].returnedOrders,1);const shop=report.channels.find(c=>c.id==='shopee');assert.equal(shop.salesVnd,150);assert.equal(shop.orders,1);assert.equal(shop.manualOrders,0);assert.equal(shop.apiOrders,1);assert.equal(report.totals.salesVnd,1150);assert.equal(report.channels.find(c=>c.id==='tiktok').source,'not_connected');assert.deepEqual(report.advertising,[]);
 const legacy={...manual,externalOrderId:'LEGACY-ONLY',netRevenueVnd:'25'};delete legacy.shopId;
 for(const [reference,payload]of [['legacy-first',legacy],['legacy-duplicate',legacy],['legacy-malformed',{...legacy,externalOrderId:'BAD-DATE',orderDate:'2026-99-99'}],['legacy-foreign',{...legacy,externalOrderId:'USD-ROW',currency:'USD'}]])await pool.query("INSERT INTO business_documents(kind,period,reference,payload,calculation,status,request_key,request_hash,created_by) VALUES('marketplace','2026-10',$1,$2,'{}','approved',$3,'fixture','fixture')",[reference,JSON.stringify(payload),randomUUID()]);
 const legacyReport=await channelReport(pool,'2026-10-01','2026-10-02');assert.equal(legacyReport.totals.salesVnd,1175);assert.equal(legacyReport.channels.find(c=>c.id==='shopee').manualOrders,1);assert.deepEqual(legacyReport.quality,{excludedManualRows:2,duplicateManualRows:1});assert.match(legacyReport.definition,/2 bản đối soát cũ/);
});

test('manual order snapshots choose the latest approval before filtering dates so month totals reconcile',async t=>{
 const pool=await database(t),base={channel:'shopee',shopId:'fixture-shop',externalOrderId:'CROSS-MONTH',status:'completed',reconciled:true,refundVnd:0,source:'manual_reconciliation'};
 for(const [period,orderDate,netRevenueVnd,approvedAt]of [['2026-09','2026-09-30',100,'2026-10-01T00:00:00Z'],['2026-10','2026-10-01',200,'2026-10-02T00:00:00Z']])await pool.query("INSERT INTO business_documents(kind,period,reference,payload,calculation,status,request_key,request_hash,created_by,approved_at) VALUES('marketplace',$1,$2,$3,'{}','approved',$4,'fixture','fixture',$5)",[period,'legacy-import-'+period,JSON.stringify({...base,period,orderDate,netRevenueVnd}),randomUUID(),approvedAt]);
 const sep=await channelReport(pool,'2026-09-01','2026-09-30'),oct=await channelReport(pool,'2026-10-01','2026-10-31'),combined=await channelReport(pool,'2026-09-01','2026-10-31');
 assert.equal(sep.totals.salesVnd,0);assert.equal(oct.totals.salesVnd,200);assert.equal(combined.totals.salesVnd,200);assert.equal(sep.totals.salesVnd+oct.totals.salesVnd,combined.totals.salesVnd);assert.equal(oct.quality.duplicateManualRows,1);
 await upsertConnectedSales(pool,{provider:'shopee',shopId:base.shopId,verified:true,authorizationReference:'fixture-live-adapter'},[{externalOrderId:base.externalOrderId,orderDate:'2026-09-30',status:'completed',currency:'VND',grossVnd:250,refundVnd:0,sourceUpdatedAt:'2026-10-03T00:00:00Z'}]);
 assert.equal((await channelReport(pool,'2026-10-01','2026-10-31')).totals.salesVnd,0);assert.equal((await channelReport(pool,'2026-09-01','2026-10-31')).totals.salesVnd,250);
});

test('advertising totals expose exact saved and missing account-local dates without mixing currency or timezone',async t=>{
 const pool=await database(t);await pool.query("INSERT INTO advertising_daily_spend(provider,advertiser_id,stat_date,currency,timezone,spend_micros,report_type) VALUES('tiktok_ads','1234567','2026-10-01','VND','Asia/Jakarta',10000000,'BASIC'),('tiktok_ads','1234567','2026-10-03','VND','Asia/Jakarta',0,'BASIC'),('tiktok_ads','7654321','2026-10-02','USD','America/Los_Angeles',1500000,'BASIC')");
 const report=await channelReport(pool,'2026-10-01','2026-10-05'),vnd=report.advertising.find(r=>r.currency==='VND'),usd=report.advertising.find(r=>r.currency==='USD');
 assert.equal(vnd.spend,'10.000000');assert.equal(vnd.days,2);assert.equal(vnd.expectedDays,5);assert.equal(vnd.firstDate,'2026-10-01');assert.equal(vnd.lastDate,'2026-10-03');assert.deepEqual(vnd.missingDates,['2026-10-02','2026-10-04','2026-10-05']);assert.deepEqual(vnd.missingDateRanges,[{from:'2026-10-02',to:'2026-10-02'},{from:'2026-10-04',to:'2026-10-05'}]);assert.equal(vnd.complete,false);assert.equal(usd.spend,'1.500000');assert.equal(usd.periodTimezone,'America/Los_Angeles');
 const zero=await channelReport(pool,'2026-10-03','2026-10-03');assert.equal(zero.advertising[0].spend,'0.000000');assert.equal(zero.advertising[0].complete,true);assert.deepEqual(zero.advertising[0].missingDates,[]);
});
