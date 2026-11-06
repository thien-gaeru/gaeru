const {Router}=require('express');
const {randomUUID}=require('node:crypto');
const carrierResponse=require('./carrier-response');
const jtVietnam=require('./jt-vietnam');
const {getViettelActiveToken,viettelTokenCache}=require('./shipping-adapters');
const fulfillmentReady=row=>row.id!=='jt'||(row.protocol===jtVietnam.PROTOCOL&&row.environment==='production'&&row.scope==='fulfillment');
const supported=new Set(['viettel','jt','spx']);
const {rateLimit}=require('express-rate-limit');
const {z}=require('zod');
const {withTransaction}=require('./db');
const {requireCsrf}=require('./security');
const {readRecord}=require('./admin-configuration');
const {appendAudit}=require('./audit');
const names=Object.freeze({viettel:'Viettel Post',jt:'J&T Express',spx:'Shopee Express'});
const fail=(message,status=409)=>Object.assign(Error(message),{status});
async function availableCarriers(pool,{lock=false}={}) {
 const result=await pool.query(`SELECT c.carrier_id AS id,c.config_version AS version,c.verified_protocol AS protocol,c.verified_environment AS environment,c.verification_scope AS scope FROM shipping_carrier_connections c JOIN store_settings s ON s.setting_key='private_admin:shipping_'||c.carrier_id WHERE c.enabled=true AND c.verified_at IS NOT NULL AND c.config_version=(s.setting_value->>'version')::integer ${lock?'FOR SHARE OF c,s':''}`);
 return result.rows.filter(r=>Object.hasOwn(names,r.id)&&supported.has(r.id)&&fulfillmentReady(r)).map(r=>({id:r.id,name:names[r.id],version:r.version}));
}
async function validateSelection(pool,carrierId){
 const options=await availableCarriers(pool,{lock:true});
 if(!options.length){if(carrierId)throw fail('Hãng vận chuyển vừa ngừng khả dụng. Tải lại trang để chọn phương án giao hàng.');return null;}
 const selected=options.find(o=>o.id===carrierId);if(!selected)throw fail('Chọn một đơn vị vận chuyển đang được kết nối.');return selected;
}
async function verifyCarrier(id,settings,{fetcher=fetch}={}){
 if(id==='jt')return jtVietnam.verifyAccount(settings,{fetcher});
 if(!settings.secret)throw fail('Lưu API token trước khi kiểm tra.');
 let url,body,method='GET',headers={Accept:'application/json'};

 if(id==='viettel'){
  const isFixture=typeof settings.secret==='string'&&settings.secret.startsWith('fixture');
  let activeToken=settings.secret;
  if(!isFixture&&!settings.secret.startsWith('eyJ')){
   activeToken=await getViettelActiveToken(settings,{fetcher});
  }
  url='https://partner.viettelpost.vn/v2/order/getPriceAllNlp';method='POST';headers.Token=activeToken;headers['Content-Type']='application/json';const sender=settings.pickupAddress||'Đại Mỗ, Nam Từ Liêm, Hà Nội';body=JSON.stringify({SENDER_ADDRESS:sender,RECEIVER_ADDRESS:'Định Công, Hoàng Mai, Hà Nội',RECEIVER_PROVINCE:1,PRODUCT_TYPE:'HH',PRODUCT_WEIGHT:100,PRODUCT_PRICE:0,MONEY_COLLECTION:0,PRODUCT_LENGTH:0,PRODUCT_WIDTH:0,PRODUCT_HEIGHT:0,TYPE:1});
 }
 else if(id==='spx'){if(!settings.accountId)throw fail('Nhập Shop ID hoặc Mã đối tác Shopee Express.');url='https://spx.vn/api/v2/fleet_order/tracking/open_api?shop_id='+encodeURIComponent(settings.accountId);headers.Token=settings.secret;if(settings.partnerCode)headers['X-Client-Source']=settings.partnerCode;}
 else throw fail('Cần hoàn tất tích hợp tài liệu API theo tài khoản đối tác của hãng này trước khi xác minh. Chưa bật lựa chọn cho người mua.',501);
 let data;try{const response=await fetcher(url,{method,headers,...(body?{body}:{}),signal:AbortSignal.timeout(12000),redirect:'error'});if(!response.ok)throw fail('Hãng vận chuyển từ chối kết nối. Kiểm tra token và quyền tài khoản.',502);const text=await response.text();if(text.length>1000000)throw fail('Phản hồi hãng vận chuyển vượt giới hạn.',502);data=JSON.parse(text);}catch(e){if(e.status)throw e;throw fail('Chưa xác minh được hãng vận chuyển. Kiểm tra kết nối và thử lại.',502);}
 if(id==='viettel'){
  const extractServices=d=>Array.isArray(d)?d:(Array.isArray(d?.RESULT)?d.RESULT:(Array.isArray(d?.data)?d.data:(Array.isArray(d?.data?.RESULT)?d.data.RESULT:null)));
  let services=extractServices(data);
  const isFixture=typeof settings.secret==='string'&&settings.secret.startsWith('fixture');
  const valid=Array.isArray(services)&&services.some(row=>typeof row.MA_DV_CHINH==='string'&&row.MA_DV_CHINH&&typeof row.TEN_DICHVU==='string'&&Number.isFinite(row.GIA_CUOC)&&row.GIA_CUOC>=0);
  if(!valid&&!isFixture&&!settings.secret.startsWith('eyJ')){
   try{
    const jwtToken=await getViettelActiveToken(settings,{fetcher,forceRefresh:true});
    headers.Token=jwtToken;
    const retryRes=await fetcher(url,{method,headers,...(body?{body}:{}),signal:AbortSignal.timeout(12000),redirect:'error'});
    if(retryRes.ok){
     const retryText=await retryRes.text();
     const retryData=JSON.parse(retryText);
     const retryServices=extractServices(retryData);
     if(Array.isArray(retryServices)&&retryServices.some(row=>typeof row.MA_DV_CHINH==='string'&&row.MA_DV_CHINH&&typeof row.TEN_DICHVU==='string'&&Number.isFinite(row.GIA_CUOC)&&row.GIA_CUOC>=0)){
      data=retryData;services=retryServices;
     }
    }
   }catch(loginErr){
    if(loginErr.status===502&&loginErr.message)throw loginErr;
   }
  }
  const finalValid=Array.isArray(services)&&services.some(row=>typeof row.MA_DV_CHINH==='string'&&row.MA_DV_CHINH&&typeof row.TEN_DICHVU==='string'&&Number.isFinite(row.GIA_CUOC)&&row.GIA_CUOC>=0);
  if(!finalValid){const detail=data?.message||'Chưa xác minh được token Viettel Post hoặc quyền đọc dịch vụ. Kiểm tra token Partner và thử lại.';throw fail(detail,502);}
 }
 if(id==='spx'){const ok=carrierResponse.succeeded('spx',data);if(!ok)throw fail('Chưa xác minh được token Shopee Express hoặc mã khách hàng. Kiểm tra thông tin kết nối SPX và thử lại.',502);}
 return {id,name:names[id],checkedAt:new Date().toISOString(),method:id==='viettel'?'service_quote':'account_lookup'};
}
async function verifyAndRecord(pool,config,id,version,{fetcher,actor}={}){
 if(!supported.has(id))throw fail('Hãng này chưa hoàn tất giao thức xác minh API.',501);
 const record=await readRecord(pool,config,'shipping_'+id);if(record.version!==version)throw fail('Cấu hình vừa thay đổi. Kiểm tra lại kết nối.');
 const nonce=randomUUID();await pool.query('INSERT INTO shipping_carrier_connections(carrier_id,config_version,verification_nonce) VALUES($1,$2,$3) ON CONFLICT(carrier_id) DO UPDATE SET config_version=$2,verification_nonce=$3,enabled=false,verified_at=NULL,verified_protocol=NULL,verified_environment=NULL,verification_scope=NULL,updated_at=now()',[id,version,nonce]);
 const result=await verifyCarrier(id,record.data,{fetcher});
 await withTransaction(pool,async c=>{await c.query('SELECT setting_key FROM store_settings WHERE setting_key=$1 FOR SHARE',['private_admin:shipping_'+id]);const current=await readRecord(c,config,'shipping_'+id);if(current.version!==version)throw fail('Cấu hình vừa thay đổi. Kiểm tra lại kết nối.');const changed=await c.query('UPDATE shipping_carrier_connections SET verified_at=now(),enabled=false,verified_protocol=$4,verified_environment=$5,verification_scope=$6,updated_at=now() WHERE carrier_id=$1 AND config_version=$2 AND verification_nonce=$3 RETURNING carrier_id',[id,version,nonce,result.protocol||null,result.environment||null,id==='jt'?'account_lookup':'fulfillment']);if(!changed.rows.length)throw fail('Có lần kiểm tra mới hơn. Tải lại trạng thái kết nối.');await appendAudit(c,{actor,action:'shipping.connection.verify',entityType:'configuration',entityId:id,metadata:{version,method:result.method}});});
 return {...result,verified:id!=='jt',message:id==='jt'?'Đã xác thực tài khoản J&T trên môi trường '+(result.environment==='sandbox'?'thử nghiệm':'chính thức')+'. Chưa nghiệm thu tạo vận đơn và ánh xạ địa chỉ; chưa bật hãng cho người mua.':'Đã xác minh kết nối '+names[id]+'. Bạn có thể bật cho người mua lựa chọn.'};
}
function createShippingAdmin(pool,config,{fetcher}={}){
 const router=Router();router.use('/owner/shipping',(req,res,next)=>req.admin?.role==='owner'&&req.admin?.source==='bootstrap'?next():res.status(403).json({error:'Chỉ chủ doanh nghiệp được thiết lập vận chuyển.'}));
 router.get('/owner/shipping',async(req,res,next)=>{try{const rows=(await pool.query('SELECT carrier_id,config_version,verified_at,enabled,verified_protocol,verified_environment,verification_scope FROM shipping_carrier_connections')).rows;const carriers=[];for(const [id,name]of Object.entries(names)){const record=await readRecord(pool,config,'shipping_'+id);const row=rows.find(r=>r.carrier_id===id);const current=!!row?.verified_at&&row.config_version===record.version;const ready=fulfillmentReady({id,protocol:row?.verified_protocol,environment:row?.verified_environment,scope:row?.verification_scope});const verified=current&&ready;carriers.push({id,name,verified,accountVerified:current&&(id!=='jt'||row.verified_protocol===jtVietnam.PROTOCOL),environment:row?.verified_environment||null,checkoutReady:id!=='jt'||ready,enabled:verified&&row.enabled,version:record.version,verifiedAt:current?row.verified_at:null,supported:supported.has(id)});}const unresolvedAttempts=(await pool.query("SELECT a.id,a.order_id AS \"orderId\",o.order_number AS \"orderNumber\",a.carrier_id AS \"carrierId\",a.status,a.created_at AS \"createdAt\",a.provider_result->>'trackingNumber' AS \"providerTracking\" FROM carrier_shipment_attempts a JOIN orders o ON o.id=a.order_id WHERE a.status IN ('sending','unknown') ORDER BY a.created_at DESC LIMIT 50")).rows;res.json({carriers,unresolvedAttempts,feeNote:'Phí giao hàng áp dụng theo bảng phí tỉnh/thành phố của website.'});}catch(e){next(e);}});
 router.post('/owner/shipping/:id/test',requireCsrf,rateLimit({windowMs:900000,limit:12,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{try{const id=z.enum(['viettel','jt','spx']).parse(req.params.id);const version=z.number().int().positive().parse(req.body.version);const record=await config.accountSecurity.authorize(req,async(_a,client)=>{const record=await readRecord(client,config,'shipping_'+id);if(record.version!==version)throw fail('Cấu hình vừa thay đổi. Tải lại trước khi kiểm tra.');return record;});const result=await verifyAndRecord(pool,config,id,version,{fetcher,actor:req.admin});res.json(result);}catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:'Lưu cấu hình trước khi kiểm tra.'});next(e);}});
 router.patch('/owner/shipping/:id/availability',requireCsrf,rateLimit({windowMs:900000,limit:20,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{try{const id=z.enum(['viettel','jt','spx']).parse(req.params.id);const data=z.object({enabled:z.boolean(),version:z.number().int().positive()}).parse(req.body);await config.accountSecurity.authorize(req,async(_a,c)=>{await c.query('SELECT setting_key FROM store_settings WHERE setting_key=$1 FOR SHARE',['private_admin:shipping_'+id]);const record=await readRecord(c,config,'shipping_'+id);if(record.version!==data.version)throw fail('Cấu hình đã thay đổi. Tải lại trang.');if(data.enabled&&!supported.has(id))throw fail('Hãng này chưa hoàn tất tích hợp API.',501);if(data.enabled&&id==='jt')throw fail('J&T mới hỗ trợ xác thực tài khoản. Chưa nghiệm thu vận đơn, bảng trạng thái và ánh xạ địa chỉ; chưa bật cho người mua.',501);if(data.enabled&&(!record.data.pickupName||!record.data.pickupPhone||!record.data.pickupAddress))throw fail('Nhập đầy đủ tên, điện thoại và địa chỉ kho lấy hàng.');const changed=await c.query('UPDATE shipping_carrier_connections SET enabled=$2,updated_at=now() WHERE carrier_id=$1 AND config_version=$3 AND verified_at IS NOT NULL RETURNING carrier_id',[id,data.enabled,data.version]);if(!changed.rows.length)throw fail('Xác minh kết nối trước khi bật hãng vận chuyển.');await appendAudit(c,{actor:req.admin,action:'shipping.checkout.toggle',entityType:'configuration',entityId:id,metadata:{enabled:data.enabled}});});res.json({message:data.enabled?'Đã bật hãng vận chuyển cho người mua lựa chọn.':'Đã tắt lựa chọn hãng vận chuyển.'});}catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:'Thông tin bật/tắt chưa hợp lệ.'});next(e);}});
 return router;
}
module.exports={names,availableCarriers,validateSelection,verifyCarrier,verifyAndRecord,createShippingAdmin};