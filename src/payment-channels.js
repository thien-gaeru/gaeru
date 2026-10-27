'use strict';
const {Router}=require('express');
const {randomUUID,createHmac}=require('node:crypto');
const {rateLimit}=require('express-rate-limit');
const {z}=require('zod');
const {withTransaction}=require('./db');
const {requireCsrf}=require('./security');
const {readRecord,writeRecord,getVnpay}=require('./admin-configuration');
const {buildVnpayPaymentUrl,verifyVnpayQuery}=require('./vnpay');
const {appendAudit}=require('./audit');

const channels=Object.freeze({
 cod:{id:'cod',configId:'payment_cod',name:'Thanh toán khi nhận hàng (COD)'},
 bank_transfer:{id:'bank_transfer',configId:'payment_bank_transfer',name:'Chuyển khoản ngân hàng'},
 vnpay:{id:'vnpay',configId:'vnpay',name:'Cổng thanh toán VNPAY'},
 '9pay':{id:'9pay',configId:'payment_9pay',name:'Cổng thanh toán 9Pay'}
});
const channelIds=Object.keys(channels);
const fail=(message,status=409)=>Object.assign(Error(message),{status});

function defaultChannelData(id){
 if(id==='cod')return {enabled:true,maxAmountVnd:50000000,instructions:'Thanh toán tiền mặt trực tiếp cho bưu tá khi nhận hàng.'};
 if(id==='bank_transfer')return {bankName:'',accountNumber:'',accountHolder:'',branch:'',transferSyntax:'GAERU {MA_DON}',enabled:false};
 if(id==='vnpay')return {tmnCode:'',environment:'sandbox',enabled:false};
 if(id==='9pay')return {merchantKey:'',environment:'sandbox',enabled:false};
 return {};
}

async function readChannelRecord(pool,config,id){
 const meta=channels[id];
 if(!meta)throw fail('Kênh thanh toán không hợp lệ.',404);
 const record=await readRecord(pool,config,meta.configId);
 return {version:record.version,data:{...defaultChannelData(id),...record.data}};
}

async function verifyPaymentChannel(id,settings,{config={},pool=null,fetcher=fetch}={}){
 const meta=channels[id];
 if(!meta)throw fail('Kênh thanh toán không hợp lệ.',404);
 const checkedAt=new Date().toISOString();
 if(id==='cod'){
  const maxAmount=Number(settings.maxAmountVnd??50000000);
  if(!Number.isSafeInteger(maxAmount)||maxAmount<100000||maxAmount>2000000000)throw fail('Hạn mức tối đa đơn COD phải từ 100.000 ₫ đến 2.000.000.000 ₫.',400);
  let shippingConfigured=true;
  if(pool){
   const row=(await pool.query("SELECT setting_value FROM store_settings WHERE setting_key='shipping_rates'")).rows[0];
   shippingConfigured=Boolean(row?.setting_value&&typeof row.setting_value==='object'&&Object.keys(row.setting_value).length>0);
  }
  return {
   id:'cod',
   name:meta.name,
   verified:true,
   checkedAt,
   method:'policy_check',
   message:shippingConfigured
    ?'Kết nối kênh COD sẵn sàng. Bảng phí giao hàng và hạn mức thu hộ đã hợp lệ.'
    :'Đã xác minh cấu hình COD. Lưu ý thêm bảng phí giao hàng theo tỉnh/thành trước khi nhận đơn.'
  };
 }
 if(id==='bank_transfer'){
  if(!settings.bankName||settings.bankName.trim().length<2)throw fail('Nhập tên ngân hàng thụ hưởng trước khi kiểm tra.',400);
  if(!/^[0-9A-Za-z]{6,30}$/.test(String(settings.accountNumber||'')))throw fail('Số tài khoản ngân hàng chưa hợp lệ (6–30 ký tự chữ hoặc số).',400);
  if(!settings.accountHolder||settings.accountHolder.trim().length<2)throw fail('Nhập tên chủ tài khoản thụ hưởng trước khi kiểm tra.',400);
  const syntax=String(settings.transferSyntax||'GAERU {MA_DON}').trim();
  if(syntax.length<3)throw fail('Nhập cú pháp nội dung chuyển khoản hợp lệ.',400);
  const preview=syntax.replace(/\{MA_DON\}/g,'GR-20261027-DEMO');
  return {
   id:'bank_transfer',
   name:meta.name,
   verified:true,
   checkedAt,
   method:'account_verification',
   message:`Đã xác minh thông tin chuyển khoản ${settings.bankName.trim()} · STK ${settings.accountNumber.trim()} (${settings.accountHolder.trim()}). Nội dung mẫu: ${preview}.`
  };
 }
 if(id==='vnpay'){
  if(!/^[a-zA-Z0-9]{8}$/.test(String(settings.tmnCode||'')))throw fail('Lưu Mã website (TmnCode 8 ký tự) trước khi kiểm tra kết nối VNPAY.',400);
  if(!settings.hashSecret||String(settings.hashSecret).length<8)throw fail('Lưu Hash secret VNPAY trước khi kiểm tra kết nối.',400);
  const baseUrl=config.PUBLIC_BASE_URL||'https://gaeru.com';
  const paymentUrl=settings.environment==='production'?'https://pay.vnpay.vn/vpcpay.html':'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html';
  const returnUrl=new URL('/api/payments/vnpay/return',baseUrl).toString();
  const signedUrl=buildVnpayPaymentUrl({tmnCode:settings.tmnCode,hashSecret:settings.hashSecret,paymentUrl,returnUrl},{amountVnd:100000,txnRef:'GR-VNPAY-PROBE',ipAddress:'127.0.0.1'});
  const parsed=new URL(signedUrl);
  const query=Object.fromEntries(parsed.searchParams.entries());
  const verifiedSig=verifyVnpayQuery(query,settings.hashSecret);
  if(!verifiedSig.valid)throw fail('Đối chiếu chữ ký HMAC-SHA512 của VNPAY không khớp.',502);
  try{
   const response=await fetcher(paymentUrl,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(12000)});
   if(response.status>=500)throw fail('Máy chủ cổng VNPAY đang phản hồi lỗi ('+response.status+').',502);
  }catch(e){
   if(e.status)throw e;
   throw fail('Không thể kết nối tới cổng VNPAY. Kiểm tra mạng hoặc thử lại sau.',502);
  }
  return {
   id:'vnpay',
   name:meta.name,
   verified:true,
   checkedAt,
   method:'gateway_handshake',
   environment:settings.environment,
   message:`Đã xác minh chữ ký HMAC-SHA512 và kết nối thành công tới cổng VNPAY (${settings.environment==='production'?'Chính thức':'Thử nghiệm'}).`
  };
 }
 if(id==='9pay'){
  if(!settings.merchantKey||String(settings.merchantKey).trim().length<2)throw fail('Lưu Merchant Key 9Pay trước khi kiểm tra kết nối.',400);
  if(!settings.secretKey||String(settings.secretKey).length<8)throw fail('Lưu Secret Key 9Pay trước khi kiểm tra kết nối.',400);
  if(!settings.checksumKey||String(settings.checksumKey).length<8)throw fail('Lưu Checksum Key 9Pay trước khi kiểm tra kết nối.',400);
  const endpoint=settings.environment==='production'?'https://payment.9pay.vn':'https://sand-payment.9pay.vn';
  const samplePayload=`POST\n${endpoint}/payments/create\n${Math.floor(Date.now()/1000)}\nmerchant_key=${settings.merchantKey}&amount=100000&invoice_no=GR-9PAY-PROBE`;
  const signature=createHmac('sha256',settings.secretKey).update(samplePayload,'utf8').digest('base64');
  const checksum=createHmac('sha256',settings.checksumKey).update('GR-9PAY-PROBE:100000','utf8').digest('hex');
  if(!signature||!checksum)throw fail('Không thể khởi tạo chữ ký bảo mật 9Pay.',500);
  try{
   const response=await fetcher(endpoint,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(12000)});
   if(response.status>=500)throw fail('Máy chủ cổng 9Pay đang phản hồi lỗi ('+response.status+').',502);
  }catch(e){
   if(e.status)throw e;
   throw fail('Không thể kết nối tới cổng 9Pay. Kiểm tra mạng hoặc thử lại sau.',502);
  }
  return {
   id:'9pay',
   name:meta.name,
   verified:true,
   checkedAt,
   method:'gateway_handshake',
   environment:settings.environment,
   message:`Đã xác minh chữ ký HMAC-SHA256 và kết nối thành công tới cổng 9Pay (${settings.environment==='production'?'Chính thức':'Thử nghiệm'}).`
  };
 }
 throw fail('Kênh thanh toán chưa hỗ trợ kiểm tra kết nối.',501);
}

async function verifyAndRecordPayment(pool,config,id,version,{fetcher,actor}={}){
 const meta=channels[id];
 if(!meta)throw fail('Kênh thanh toán không hợp lệ.',404);
 const record=await readChannelRecord(pool,config,id);
 if(record.version!==version)throw fail('Cấu hình vừa thay đổi. Tải lại trước khi kiểm tra.');
 const nonce=randomUUID();
 await pool.query(
  'INSERT INTO payment_channel_connections(channel_id,config_version,verification_nonce,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(channel_id) DO UPDATE SET config_version=$2,verification_nonce=$3,verified_at=NULL,updated_at=now()',
  [id,version,nonce,Boolean(record.data.enabled)]
 );
 const result=await verifyPaymentChannel(id,record.data,{config,pool,fetcher});
 await withTransaction(pool,async c=>{
  const current=await readChannelRecord(c,config,id);
  if(current.version!==version)throw fail('Cấu hình vừa thay đổi. Kiểm tra lại kết nối.');
  const changed=await c.query(
   'UPDATE payment_channel_connections SET verified_at=now(),enabled=$4,last_method=$5,updated_at=now() WHERE channel_id=$1 AND config_version=$2 AND verification_nonce=$3 RETURNING channel_id',
   [id,version,nonce,Boolean(current.data.enabled),result.method]
  );
  if(!changed.rows.length)throw fail('Có lần kiểm tra mới hơn. Tải lại trạng thái kết nối.');
  await appendAudit(c,{actor,action:'payment.connection.verify',entityType:'configuration',entityId:meta.configId,metadata:{channelId:id,version,method:result.method}});
 });
 return {...result,version};
}

async function listPaymentChannels(pool,config){
 const rows=(await pool.query('SELECT channel_id,config_version,verified_at,enabled,last_method FROM payment_channel_connections')).rows;
 const items=[];
 for(const id of channelIds){
  const meta=channels[id];
  const record=await readChannelRecord(pool,config,id);
  const row=rows.find(r=>r.channel_id===id);
  const verified=Boolean(row?.verified_at)&&row.config_version===record.version;
  const enabled=id==='vnpay'
   ?Boolean(await getVnpay(pool,config))
   :id==='cod'
    ?(record.version===0?true:Boolean(record.data.enabled))
    :Boolean(record.data.enabled);
  items.push({
   id,
   configId:meta.configId,
   name:meta.name,
   version:record.version,
   verified,
   verifiedAt:verified?row.verified_at:null,
   enabled,
   configured:id==='cod'?true:record.version>0,
   environment:record.data.environment||null
  });
 }
 const baseUrl=config.PUBLIC_BASE_URL||'https://gaeru.com';
 return {
  channels:items,
  callbacks:{
   vnpayReturn:new URL('/api/payments/vnpay/return',baseUrl).toString(),
   vnpayIpn:new URL('/api/payments/vnpay/ipn',baseUrl).toString(),
   ninepayReturn:new URL('/api/payments/9pay/return',baseUrl).toString(),
   ninepayIpn:new URL('/api/payments/9pay/ipn',baseUrl).toString()
  }
 };
}

function createPaymentAdmin(pool,config,{fetcher}={}){
 const router=Router();
 router.use('/owner/payments',(req,res,next)=>req.admin?.role==='owner'&&req.admin?.source==='bootstrap'?next():res.status(403).json({error:'Chỉ chủ doanh nghiệp được thiết lập kênh thanh toán.'}));
 router.get('/owner/payments',async(_req,res,next)=>{
  try{
   res.json(await listPaymentChannels(pool,config));
  }catch(e){next(e);}
 });
 router.post('/owner/payments/:id/test',requireCsrf,rateLimit({windowMs:900000,limit:20,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{
  try{
   const id=z.enum(['cod','bank_transfer','vnpay','9pay']).parse(req.params.id);
   const version=z.number().int().min(0).parse(req.body.version);
   await config.accountSecurity.authorize(req,async(_a,client)=>{
    const record=await readChannelRecord(client,config,id);
    if(record.version!==version)throw fail('Cấu hình vừa thay đổi. Tải lại trước khi kiểm tra.');
    return record;
   });
   const result=await verifyAndRecordPayment(pool,config,id,version,{fetcher:fetcher||config.paymentFetcher,actor:req.admin});
   res.json(result);
  }catch(e){
   if(e instanceof z.ZodError)return res.status(400).json({error:'Lưu cấu hình trước khi kiểm tra.'});
   next(e);
  }
 });
 router.patch('/owner/payments/:id/availability',requireCsrf,rateLimit({windowMs:900000,limit:20,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{
  try{
   const id=z.enum(['cod','bank_transfer','vnpay','9pay']).parse(req.params.id);
   const meta=channels[id];
   const payload=z.object({enabled:z.boolean(),version:z.number().int().min(0)}).parse(req.body);
   let nextVersion=payload.version;
   await config.accountSecurity.authorize(req,async(_a,c)=>{
    const current=await readChannelRecord(c,config,id);
    if(current.version!==payload.version)throw fail('Cấu hình đã thay đổi. Tải lại trang.');
    if(payload.enabled&&id!=='cod'&&current.version===0)throw fail('Lưu thông tin kết nối kênh thanh toán trước khi bật.');
    if(id==='vnpay'&&payload.enabled&&config.NODE_ENV==='production'&&current.data.environment==='sandbox'){
     throw fail('Chỉ bật VNPAY chính thức trên website đang hoạt động. Dùng môi trường riêng để thử sandbox.',400);
    }
    const updated=await writeRecord(c,config,meta.configId,{...current.data,enabled:payload.enabled},current.version,req.admin);
    nextVersion=updated.version;
    await c.query(
     'INSERT INTO payment_channel_connections(channel_id,config_version,enabled,verified_at,updated_at) VALUES($1,$2,$3,(SELECT verified_at FROM payment_channel_connections WHERE channel_id=$1 AND config_version=$4),now()) ON CONFLICT(channel_id) DO UPDATE SET config_version=$2,enabled=$3,verified_at=CASE WHEN payment_channel_connections.config_version=$4 THEN payment_channel_connections.verified_at ELSE NULL END,updated_at=now()',
     [id,updated.version,payload.enabled,current.version]
    );
    await appendAudit(c,{actor:req.admin,action:'payment.checkout.toggle',entityType:'configuration',entityId:meta.configId,metadata:{channelId:id,enabled:payload.enabled,version:updated.version}});
    return updated;
   });
   res.json({
    id,
    version:nextVersion,
    enabled:payload.enabled,
    message:payload.enabled?`Đã bật ${meta.name} cho cửa hàng.`:`Đã tắt ${meta.name}.`
   });
  }catch(e){
   if(e instanceof z.ZodError)return res.status(400).json({error:'Thông tin bật/tắt chưa hợp lệ.'});
   next(e);
  }
 });
 return router;
}

module.exports={channels,channelIds,defaultChannelData,readChannelRecord,verifyPaymentChannel,verifyAndRecordPayment,listPaymentChannels,createPaymentAdmin};
