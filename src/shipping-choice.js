const {Router}=require('express');
const {randomUUID}=require('node:crypto');
const supported=new Set(['ghn','ghtk']);
const {rateLimit}=require('express-rate-limit');
const {z}=require('zod');
const {withTransaction}=require('./db');
const {requireCsrf}=require('./security');
const {readRecord}=require('./admin-configuration');
const {appendAudit}=require('./audit');
const names=Object.freeze({ghn:'GHN',ghtk:'GHTK',viettel:'Viettel Post',jt:'J&T Express'});
const fail=(message,status=409)=>Object.assign(Error(message),{status});
async function availableCarriers(pool,{lock=false}={}) {
 const result=await pool.query(`SELECT c.carrier_id AS id,c.config_version AS version FROM shipping_carrier_connections c JOIN store_settings s ON s.setting_key='private_admin:shipping_'||c.carrier_id WHERE c.enabled=true AND c.verified_at IS NOT NULL AND c.config_version=(s.setting_value->>'version')::integer ${lock?'FOR SHARE OF c,s':''}`);
 return result.rows.filter(r=>Object.hasOwn(names,r.id)&&supported.has(r.id)).map(r=>({id:r.id,name:names[r.id],version:r.version}));
}
async function validateSelection(pool,carrierId){
 const options=await availableCarriers(pool,{lock:true});
 if(!options.length){if(carrierId)throw fail('Hãng vận chuyển vừa ngừng khả dụng. Tải lại trang để chọn phương án giao hàng.');return null;}
 const selected=options.find(o=>o.id===carrierId);if(!selected)throw fail('Chọn một đơn vị vận chuyển đang được kết nối.');return selected;
}
async function verifyCarrier(id,settings,{fetcher=fetch}={}){
 if(!settings.secret)throw fail('Lưu API token trước khi kiểm tra.');
 let url,headers={Accept:'application/json'};
 if(id==='ghn'){if(!/^\d+$/.test(settings.accountId))throw fail('Nhập Shop ID GHN bằng chữ số.');url='https://online-gateway.ghn.vn/shiip/public-api/v2/shop/all?offset=0&limit=200';headers.Token=settings.secret;}
 else if(id==='ghtk'){url='https://services.giaohangtietkiem.vn/services/shipment/list_pick_add';headers.Token=settings.secret;if(settings.partnerCode)headers['X-Client-Source']=settings.partnerCode;}
 else throw fail('Cần hoàn tất tích hợp tài liệu API theo tài khoản đối tác của hãng này trước khi xác minh. Chưa bật lựa chọn cho người mua.',501);
 let data;try{const response=await fetcher(url,{headers,signal:AbortSignal.timeout(12000),redirect:'error'});if(!response.ok)throw fail('Hãng vận chuyển từ chối kết nối. Kiểm tra token và quyền tài khoản.',502);const text=await response.text();if(text.length>1000000)throw fail('Phản hồi hãng vận chuyển vượt giới hạn.',502);data=JSON.parse(text);}catch(e){if(e.status)throw e;throw fail('Chưa xác minh được hãng vận chuyển. Kiểm tra kết nối và thử lại.',502);}
 if(id==='ghn'&&(data.code!==200||!Array.isArray(data.data?.shops)||!data.data.shops.some(s=>String(s._id)===settings.accountId&&s.status===1)))throw fail('Chưa tìm thấy Shop ID GHN đang hoạt động trong tài khoản. Kiểm tra quyền của token.',502);
 if(id==='ghtk'&&(data.success!==true||!Array.isArray(data.data)||!data.data.length))throw fail('Tài khoản GHTK chưa trả về kho lấy hàng khả dụng.',502);
 return {id,name:names[id],checkedAt:new Date().toISOString()};
}
function createShippingAdmin(pool,config,{fetcher}={}){
 const router=Router();router.use('/owner/shipping',(req,res,next)=>req.admin?.role==='owner'&&req.admin?.source==='bootstrap'?next():res.status(403).json({error:'Chỉ chủ doanh nghiệp được thiết lập vận chuyển.'}));
 router.get('/owner/shipping',async(req,res,next)=>{try{const rows=(await pool.query('SELECT carrier_id,config_version,verified_at,enabled FROM shipping_carrier_connections')).rows;const carriers=[];for(const [id,name]of Object.entries(names)){const record=await readRecord(pool,config,'shipping_'+id);const row=rows.find(r=>r.carrier_id===id);const verified=!!row?.verified_at&&row.config_version===record.version;carriers.push({id,name,verified,enabled:verified&&row.enabled,version:record.version,verifiedAt:verified?row.verified_at:null,supported:supported.has(id)});}res.json({carriers,feeNote:'Phí giao hàng áp dụng theo bảng phí tỉnh/thành phố của website.'});}catch(e){next(e);}});
 router.post('/owner/shipping/:id/test',requireCsrf,rateLimit({windowMs:900000,limit:12,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{try{const id=z.enum(['ghn','ghtk','viettel','jt']).parse(req.params.id);const version=z.number().int().positive().parse(req.body.version);const record=await config.accountSecurity.authorize(req,async(_a,client)=>{const record=await readRecord(client,config,'shipping_'+id);if(record.version!==version)throw fail('Cấu hình vừa thay đổi. Tải lại trước khi kiểm tra.');return record;});const nonce=randomUUID();await pool.query('INSERT INTO shipping_carrier_connections(carrier_id,config_version,verification_nonce) VALUES($1,$2,$3) ON CONFLICT(carrier_id) DO UPDATE SET config_version=$2,verification_nonce=$3,enabled=false,verified_at=NULL,updated_at=now()',[id,version,nonce]);const result=await verifyCarrier(id,record.data,{fetcher});await withTransaction(pool,async c=>{await c.query('SELECT setting_key FROM store_settings WHERE setting_key=$1 FOR SHARE',['private_admin:shipping_'+id]);const current=await readRecord(c,config,'shipping_'+id);if(current.version!==version)throw fail('Cấu hình vừa thay đổi. Kiểm tra lại kết nối.');const changed=await c.query('UPDATE shipping_carrier_connections SET verified_at=now(),enabled=false,updated_at=now() WHERE carrier_id=$1 AND config_version=$2 AND verification_nonce=$3 RETURNING carrier_id',[id,version,nonce]);if(!changed.rows.length)throw fail('Có lần kiểm tra mới hơn. Tải lại trạng thái kết nối.');await appendAudit(c,{actor:req.admin,action:'shipping.connection.verify',entityType:'configuration',entityId:id,metadata:{version}});});res.json({...result,message:'Đã xác minh tài khoản. Bạn có thể bật cho người mua lựa chọn.'});}catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:'Lưu cấu hình trước khi kiểm tra.'});next(e);}});
 router.patch('/owner/shipping/:id/availability',requireCsrf,rateLimit({windowMs:900000,limit:20,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{try{const id=z.enum(['ghn','ghtk','viettel','jt']).parse(req.params.id);const data=z.object({enabled:z.boolean(),version:z.number().int().positive()}).parse(req.body);await config.accountSecurity.authorize(req,async(_a,c)=>{await c.query('SELECT setting_key FROM store_settings WHERE setting_key=$1 FOR SHARE',['private_admin:shipping_'+id]);const record=await readRecord(c,config,'shipping_'+id);if(record.version!==data.version)throw fail('Cấu hình đã thay đổi. Tải lại trang.');if(data.enabled&&!supported.has(id))throw fail('Hãng này chưa hoàn tất tích hợp API.',501);if(data.enabled&&(!record.data.pickupName||!record.data.pickupPhone||!record.data.pickupAddress))throw fail('Nhập đầy đủ tên, điện thoại và địa chỉ kho lấy hàng.');const changed=await c.query('UPDATE shipping_carrier_connections SET enabled=$2,updated_at=now() WHERE carrier_id=$1 AND config_version=$3 AND verified_at IS NOT NULL RETURNING carrier_id',[id,data.enabled,data.version]);if(!changed.rows.length)throw fail('Xác minh kết nối trước khi bật hãng vận chuyển.');await appendAudit(c,{actor:req.admin,action:'shipping.checkout.toggle',entityType:'configuration',entityId:id,metadata:{enabled:data.enabled}});});res.json({message:data.enabled?'Đã bật hãng vận chuyển cho người mua lựa chọn.':'Đã tắt lựa chọn hãng vận chuyển.'});}catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:'Thông tin bật/tắt chưa hợp lệ.'});next(e);}});
 return router;
}
module.exports={names,availableCarriers,validateSelection,verifyCarrier,createShippingAdmin};
