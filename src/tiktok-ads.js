'use strict';
const {Router}=require('express'),{z}=require('zod'),{rateLimit}=require('express-rate-limit');
const {withTransaction}=require('./db'),{requireCsrf}=require('./security'),{appendAudit}=require('./audit');
const {readRecord,writeRecord}=require('./admin-configuration');
const CONFIG='tiktok_ads',BASE='https://business-api.tiktok.com/open_api/v1.3';
const fail=(message,status=502,code='TIKTOK_ADS_UNAVAILABLE')=>Object.assign(Error(message),{status,code});
const dateSchema=z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).refine(s=>Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s);
const settingsSchema=z.object({advertiserId:z.string().trim().regex(/^\d{6,30}$/),enabled:z.boolean(),accessToken:z.string().regex(/^[!-~]{10,2000}$/).optional()}).strict();
function dates(from,to){if(!dateSchema.safeParse(from).success||!dateSchema.safeParse(to).success||from>to||(Date.parse(to)-Date.parse(from))/86400000>30)throw fail('Chọn khoảng ngày hợp lệ, tối đa 31 ngày.',400,'TIKTOK_ADS_INPUT');return [from,to];}
function dayList(from,to){const out=[];for(let n=Date.parse(from);n<=Date.parse(to);n+=86400000)out.push(new Date(n).toISOString().slice(0,10));return out;}
function micros(value){if(typeof value!=='string'||!/^\d{1,13}(?:\.\d{1,6})?$/.test(value))throw fail('Số liệu chi phí TikTok không hợp lệ.');const [a,b='']=value.split('.');const n=BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));if(n>9007199254740991n)throw fail('Chi phí vượt giới hạn xử lý an toàn.');return n;}
function decimal(value){const n=BigInt(value);return `${n/1000000n}.${String(n%1000000n).padStart(6,'0')}`;}
async function json(response){
 if(!response?.ok||response.redirected)throw fail('TikTok Ads chưa trả phản hồi thành công. Kiểm tra quyền truy cập và thử lại.');
 let bytes=0,chunks=[];if(response.body?.getReader){const reader=response.body.getReader();try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>1048576){await reader.cancel();throw fail('Phản hồi TikTok Ads vượt giới hạn.');}chunks.push(Buffer.from(r.value));}}finally{reader.releaseLock();}}
 else{const text=await response.text();if(Buffer.byteLength(text)>1048576)throw fail('Phản hồi TikTok Ads vượt giới hạn.');chunks=[Buffer.from(text)];}
 let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{throw fail('Phản hồi TikTok Ads chưa đúng định dạng.');}
 if(body?.code!==0||!body.data||typeof body.data!=='object')throw fail('TikTok Ads chưa cấp dữ liệu cho yêu cầu này. Kiểm tra tài khoản và quyền báo cáo.');return body.data;
}
async function get(endpoint,params,token,fetcher=fetch){
 if(!/^[!-~]{10,2000}$/.test(String(token||'')))throw fail('Chưa lưu Access Token TikTok Ads hợp lệ.',400,'TIKTOK_ADS_INPUT');
 const url=new URL(BASE+endpoint);for(const [key,value]of Object.entries(params))url.searchParams.set(key,typeof value==='object'?JSON.stringify(value):String(value));
 try{return await json(await fetcher(url.toString(),{method:'GET',headers:{'Access-Token':token,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(15000)}));}
 catch(e){if(e.code==='TIKTOK_ADS_UNAVAILABLE'||e.code==='TIKTOK_ADS_INPUT')throw e;throw fail('Chưa kết nối được TikTok Ads. Không thay đổi số liệu đã lưu.');}
}
async function account(settings,{fetcher=fetch}={}){
 const data=await get('/advertiser/info/',{advertiser_ids:[settings.advertiserId],fields:['advertiser_id','name','currency','timezone','status']},settings.accessToken,fetcher);
 const row=data.list?.find(r=>String(r.advertiser_id)===settings.advertiserId);
 if(!row||!/^[A-Z]{3}$/.test(row.currency)||typeof row.timezone!=='string'||row.timezone.length>100)throw fail('Không xác minh được tài khoản, tiền tệ hoặc múi giờ quảng cáo.');
 try{new Intl.DateTimeFormat('en-CA',{timeZone:row.timezone}).format();}catch{throw fail('Múi giờ tài khoản TikTok chưa được hỗ trợ.');}
 return {advertiserId:settings.advertiserId,name:String(row.name||'TikTok Ads').slice(0,200),currency:row.currency,timezone:row.timezone};
}
async function fetchSpend(settings,from,to,{fetcher=fetch}={}){
 dates(from,to);const info=await account(settings,{fetcher}),rows=new Map();let page=1,totalPages=1;
 do{
  const data=await get('/report/integrated/get/',{advertiser_id:settings.advertiserId,report_type:'BASIC',service_type:'AUCTION',data_level:'AUCTION_ADVERTISER',dimensions:['advertiser_id','stat_time_day'],metrics:['spend'],start_date:from,end_date:to,page,page_size:1000},settings.accessToken,fetcher);
  if(!Array.isArray(data.list)||data.list.length>1000)throw fail('Danh sách chi phí TikTok chưa hợp lệ.');
  const pages=Number(data.page_info?.total_page);if(!data.page_info||!Number.isInteger(pages)||pages<0||pages>20||(data.page_info.page!==undefined&&Number(data.page_info.page)!==page)||(pages===0&&data.list.length)||(page>1&&Math.max(1,pages)!==totalPages))throw fail('Phân trang báo cáo TikTok chưa hợp lệ; thu hẹp khoảng ngày và thử lại.');totalPages=Math.max(1,pages);
  for(const row of data.list){const day=String(row.dimensions?.stat_time_day||'').slice(0,10);if(!dateSchema.safeParse(day).success||day<from||day>to||String(row.dimensions?.advertiser_id)!==settings.advertiserId||rows.has(day))throw fail('Báo cáo chứa dòng trùng hoặc sai tài khoản/ngày.');rows.set(day,micros(row.metrics?.spend));}
  page++;
 }while(page<=totalPages);
 return {account:info,from,to,days:dayList(from,to).map(date=>({date,spendMicros:String(rows.get(date)||0n)})),coverage:'BASIC Auction; không gồm GMV Max',reportType:'BASIC'};
}
function publicConfig(record){return {version:record.version,advertiserId:record.data.advertiserId||'',enabled:record.data.enabled===true,secretConfigured:Boolean(record.data.accessToken)};}
async function info(pool,config){const record=await readRecord(pool,config,CONFIG);const row=record.data.advertiserId?(await pool.query('SELECT * FROM tiktok_ads_connections WHERE advertiser_id=$1 AND config_version=$2',[record.data.advertiserId,record.version])).rows[0]:null;return {configuration:publicConfig(record),connection:row?{connected:true,name:row.account_name,currency:row.currency,timezone:row.timezone,verifiedAt:row.verified_at,lastSyncedAt:row.last_synced_at,lastFrom:row.last_from,lastTo:row.last_to}:{connected:false},coverage:'BASIC Auction; không gồm GMV Max'};}
async function attest(client,record,verified){await client.query(`INSERT INTO tiktok_ads_connections(advertiser_id,config_version,account_name,currency,timezone,verified_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(advertiser_id) DO UPDATE SET config_version=$2,account_name=$3,currency=$4,timezone=$5,verified_at=now()`,[verified.advertiserId,record.version,verified.name,verified.currency,verified.timezone]);}
async function synchronize(pool,config,version,from,to,{fetcher=fetch,actor=null}={}){
 const record=await readRecord(pool,config,CONFIG);if(record.version!==version)throw fail('Cấu hình vừa thay đổi. Tải lại trước khi đồng bộ.',409,'TIKTOK_ADS_CONFLICT');
 if(!record.data.advertiserId||!record.data.accessToken)throw fail('Lưu tài khoản và Access Token trước khi đồng bộ.',400,'TIKTOK_ADS_INPUT');
 const requestId=(await pool.query("SELECT nextval('tiktok_ads_sync_request_seq')::text AS id")).rows[0].id;
 const result=await fetchSpend(record.data,from,to,{fetcher});
 await withTransaction(pool,async c=>{
  await c.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:tiktok-ads-sync'))");
  await c.query('SELECT setting_key FROM store_settings WHERE setting_key=$1 FOR SHARE',['private_admin:'+CONFIG]);
  const current=await readRecord(c,config,CONFIG);if(current.version!==version)throw fail('Cấu hình thay đổi trong lúc lấy báo cáo. Dữ liệu chưa được lưu.',409,'TIKTOK_ADS_CONFLICT');
  if((await c.query('SELECT 1 FROM tiktok_ads_connections WHERE advertiser_id=$1 AND last_sync_request_id>$2::bigint',[record.data.advertiserId,requestId])).rows.length)throw fail('Một lần đồng bộ mới hơn đã hoàn tất. Kết quả cũ không ghi đè dữ liệu; tải lại hoặc thử lại.',409,'TIKTOK_ADS_CONFLICT');
  await attest(c,record,result.account);
  for(const row of result.days)await c.query(`INSERT INTO advertising_daily_spend(provider,advertiser_id,stat_date,currency,timezone,spend_micros,report_type) VALUES('tiktok_ads',$1,$2,$3,$4,$5,'BASIC') ON CONFLICT(provider,advertiser_id,stat_date) DO UPDATE SET currency=$3,timezone=$4,spend_micros=$5,synced_at=now()`,[result.account.advertiserId,row.date,result.account.currency,result.account.timezone,row.spendMicros]);
  await c.query('UPDATE tiktok_ads_connections SET last_synced_at=now(),last_from=$2,last_to=$3,last_sync_request_id=$4 WHERE advertiser_id=$1',[record.data.advertiserId,from,to,requestId]);
  await appendAudit(c,{actor:actor||{username:'tiktok-ads-sync',source:'system'},action:'ads.tiktok.sync',entityType:'configuration',entityId:CONFIG,metadata:{advertiserId:record.data.advertiserId,from,to,days:result.days.length,currency:result.account.currency,timezone:result.account.timezone,reportType:'BASIC'}});
 });return {...result,totalSpend:decimal(result.days.reduce((sum,r)=>sum+BigInt(r.spendMicros),0n)),message:'Đã cập nhật chi phí TikTok Ads theo ngày; dữ liệu đồng bộ lại thay thế số cũ, không cộng trùng.'};
}
function createTikTokAdsAdmin(pool,config){
 const router=Router();router.use('/owner/tiktok-ads',(req,res,next)=>req.admin?.role==='owner'&&req.admin?.source==='bootstrap'?next():res.status(403).json({error:'Chỉ chủ doanh nghiệp được kết nối TikTok Ads.'}));
 router.get('/owner/tiktok-ads',async(_req,res,next)=>{try{res.json(await info(pool,config));}catch(e){next(e);}});
 router.put('/owner/tiktok-ads/configuration',requireCsrf,rateLimit({windowMs:900000,limit:20,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{try{const version=z.number().int().min(0).parse(req.body.version),data=settingsSchema.parse(req.body.data);await config.accountSecurity.authorize(req,async(_a,c)=>{const previous=await readRecord(c,config,CONFIG);const nextData={...previous.data,...data};if(!nextData.accessToken)throw fail('Nhập Access Token cho lần kết nối đầu tiên.',400,'TIKTOK_ADS_INPUT');await writeRecord(c,config,CONFIG,nextData,version,req.admin);});res.json({...await info(pool,config),message:'Đã lưu cấu hình mã hóa. Kiểm tra kết nối để xác minh tài khoản; chưa tự coi là đã kết nối.'});}catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:'Thông tin TikTok Ads chưa hợp lệ.'});next(e);}});
 for(const action of ['test','sync'])router.post('/owner/tiktok-ads/'+action,requireCsrf,rateLimit({windowMs:900000,limit:12,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{try{const version=z.number().int().min(1).parse(req.body.version);const record=await config.accountSecurity.authorize(req,async(_a,c)=>{const r=await readRecord(c,config,CONFIG);if(r.version!==version)throw fail('Cấu hình vừa thay đổi. Tải lại trước khi kiểm tra.',409,'TIKTOK_ADS_CONFLICT');return r;});if(action==='sync'){res.json(await synchronize(pool,config,version,req.body.from,req.body.to,{fetcher:config.tiktokAdsFetcher||fetch,actor:req.admin}));return;}const verified=await account(record.data,{fetcher:config.tiktokAdsFetcher||fetch});await withTransaction(pool,async c=>{await c.query('SELECT setting_key FROM store_settings WHERE setting_key=$1 FOR SHARE',['private_admin:'+CONFIG]);const current=await readRecord(c,config,CONFIG);if(current.version!==version)throw fail('Cấu hình vừa thay đổi.',409,'TIKTOK_ADS_CONFLICT');await attest(c,record,verified);await appendAudit(c,{actor:req.admin,action:'ads.tiktok.verify',entityType:'configuration',entityId:CONFIG,metadata:{advertiserId:verified.advertiserId}});});res.json({...await info(pool,config),message:'Đã xác minh quyền đọc tài khoản TikTok Ads. Không thay đổi chiến dịch hay ngân sách.'});}catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:'Lưu cấu hình trước khi kiểm tra.'});next(e);}});
 return router;
}
function startTikTokAdsWorker(pool,config){let stopped=false,busy=false;async function tick(){if(stopped||busy)return;busy=true;try{const r=await readRecord(pool,config,CONFIG);if(!r.data.enabled||!r.data.accessToken)return;const current=await info(pool,config);if(current.connection.lastSyncedAt&&Date.now()-new Date(current.connection.lastSyncedAt).getTime()<6*3600000)return;const tz=current.connection.timezone;if(!tz)return;const to=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),from=new Date(Date.parse(to)-2*86400000).toISOString().slice(0,10);await synchronize(pool,config,r.version,from,to,{fetcher:config.tiktokAdsFetcher||fetch});}catch(e){console.warn('TikTok Ads sync unavailable',{code:/^[A-Z_]+$/.test(e.code||'')?e.code:'UNAVAILABLE'});}finally{busy=false;}}const timer=setInterval(tick,6*3600000);timer.unref?.();void tick();return()=>{stopped=true;clearInterval(timer);};}
module.exports={createTikTokAdsAdmin,startTikTokAdsWorker,fetchSpend,account,synchronize,info,micros,decimal,dates};
