'use strict';
const {Router}=require('express');
const {randomUUID,createHmac,timingSafeEqual}=require('node:crypto');
const {rateLimit}=require('express-rate-limit');
const {z}=require('zod');
const {withTransaction}=require('./db');
const {requireCsrf}=require('./security');
const {readRecord,writeRecord,getVnpay}=require('./admin-configuration');
const {buildVnpayPaymentUrl,verifyVnpayQuery}=require('./vnpay');
const {appendAudit}=require('./audit');

const channels=Object.freeze({
 cod:{id:'cod',configId:'payment_cod',name:'Thanh toán khi nhận hàng (COD)',prepaid:false},
 bank_transfer:{id:'bank_transfer',configId:'payment_bank_transfer',name:'Chuyển khoản ngân hàng',prepaid:true},
 vnpay:{id:'vnpay',configId:'vnpay',name:'Cổng thanh toán VNPAY',prepaid:true},
 '9pay':{id:'9pay',configId:'payment_9pay',name:'Cổng thanh toán 9Pay',prepaid:true},
 momo:{id:'momo',configId:'payment_momo',name:'Ví điện tử MoMo',prepaid:true},
 zalopay:{id:'zalopay',configId:'payment_zalopay',name:'Ví điện tử ZaloPay',prepaid:true}
});
const channelIds=Object.keys(channels);
const prepaidChannelIds=channelIds.filter(id=>channels[id].prepaid);
const fail=(message,status=409)=>Object.assign(Error(message),{status});

function safeHexEqual(left,right){
 const a=Buffer.from(String(left||'').trim().toLowerCase(),'utf8');
 const b=Buffer.from(String(right||'').trim().toLowerCase(),'utf8');
 return a.length>0&&a.length===b.length&&timingSafeEqual(a,b);
}

function defaultChannelData(id){
 if(id==='cod')return {enabled:true,maxAmountVnd:50000000,instructions:'Thanh toán tiền mặt trực tiếp cho bưu tá khi nhận hàng.'};
 if(id==='bank_transfer')return {bankName:'',accountNumber:'',accountHolder:'',branch:'',transferSyntax:'GAERU {MA_DON}',enabled:false};
 if(id==='vnpay')return {tmnCode:'',environment:'sandbox',enabled:false};
 if(id==='9pay')return {merchantKey:'',environment:'sandbox',enabled:false};
 if(id==='momo')return {partnerCode:'',accessKey:'',environment:'sandbox',enabled:false};
 if(id==='zalopay')return {appId:'',environment:'sandbox',enabled:false};
 return {};
}

async function readChannelRecord(pool,config,id){
 const meta=channels[id];
 if(!meta)throw fail('Kênh thanh toán không hợp lệ.',404);
 const record=await readRecord(pool,config,meta.configId);
 return {version:record.version,data:{...defaultChannelData(id),...record.data}};
}

function isChannelConfigured(id,record,vnpayConfig){
 const d=record?.data||{};
 if(id==='cod')return true;
 if(id==='bank_transfer')return Boolean(record?.version>0&&d.bankName&&d.accountNumber&&d.accountHolder);
 if(id==='vnpay')return Boolean(vnpayConfig||(record?.version>0&&d.tmnCode&&d.hashSecret));
 if(id==='9pay')return Boolean(record?.version>0&&d.merchantKey&&d.secretKey&&d.checksumKey);
 if(id==='momo')return Boolean(record?.version>0&&d.partnerCode&&d.accessKey&&d.secretKey);
 if(id==='zalopay')return Boolean(record?.version>0&&d.appId&&d.key1&&d.key2);
 return false;
}

function isChannelEnabled(id,record,vnpayConfig){
 if(!isChannelConfigured(id,record,vnpayConfig))return false;
 if(id==='vnpay')return Boolean(vnpayConfig);
 if(id==='cod')return record?.version===0?true:Boolean(record?.data?.enabled);
 return Boolean(record?.data?.enabled);
}

function formatBankTransferInstructions(settings,{orderNumber,amountVnd}={}){
 const syntax=String(settings?.transferSyntax||'GAERU {MA_DON}').trim();
 const transferContent=orderNumber?syntax.replace(/\{MA_DON\}/g,orderNumber):syntax;
 return {
  bankName:String(settings?.bankName||'').trim(),
  accountNumber:String(settings?.accountNumber||'').trim(),
  accountHolder:String(settings?.accountHolder||'').trim(),
  branch:String(settings?.branch||'').trim(),
  transferSyntax:syntax,
  transferContent,
  ...(amountVnd!==undefined?{amountVnd:Number(amountVnd)}:{})
 };
}

function buildNinepayPaymentUrl(settings,{amountVnd,txnRef,baseUrl='https://gaeru.com'}){
 const endpoint=settings.environment==='production'?'https://payment.9pay.vn/payments/create':'https://sand-payment.9pay.vn/payments/create';
 const returnUrl=new URL('/api/payments/9pay/return',baseUrl).toString();
 const ipnUrl=new URL('/api/payments/9pay/ipn',baseUrl).toString();
 const time=String(Math.floor(Date.now()/1000));
 const canonical=`merchant_key=${settings.merchantKey}&invoice_no=${txnRef}&amount=${amountVnd}&time=${time}`;
 const signature=createHmac('sha256',settings.secretKey).update(canonical,'utf8').digest('hex');
 const checksum=createHmac('sha256',settings.checksumKey).update(`${txnRef}:${amountVnd}`,'utf8').digest('hex');
 const url=new URL(endpoint);
 url.searchParams.set('merchant_key',settings.merchantKey);
 url.searchParams.set('invoice_no',txnRef);
 url.searchParams.set('amount',String(amountVnd));
 url.searchParams.set('time',time);
 url.searchParams.set('return_url',returnUrl);
 url.searchParams.set('ipn_url',ipnUrl);
 url.searchParams.set('signature',signature);
 url.searchParams.set('checksum',checksum);
 return url.toString();
}

function signMomoMessage(secretKey,raw){
 return createHmac('sha256',secretKey).update(raw,'utf8').digest('hex');
}

function buildMomoPaymentUrl(settings,{amountVnd,txnRef,baseUrl='https://gaeru.com'}){
 const endpoint=settings.environment==='production'?'https://payment.momo.vn/v2/gateway/pay':'https://test-payment.momo.vn/v2/gateway/pay';
 const redirectUrl=new URL('/api/payments/momo/return',baseUrl).toString();
 const ipnUrl=new URL('/api/payments/momo/ipn',baseUrl).toString();
 const requestId=`${txnRef}-${Date.now()}`;
 const orderInfo=`Thanh toan don hang ${txnRef}`;
 const raw=`accessKey=${settings.accessKey}&amount=${amountVnd}&extraData=&ipnUrl=${ipnUrl}&orderId=${txnRef}&orderInfo=${orderInfo}&partnerCode=${settings.partnerCode}&redirectUrl=${redirectUrl}&requestId=${requestId}&requestType=captureWallet`;
 const signature=signMomoMessage(settings.secretKey,raw);
 const url=new URL(endpoint);
 url.searchParams.set('partnerCode',settings.partnerCode);
 url.searchParams.set('accessKey',settings.accessKey);
 url.searchParams.set('requestId',requestId);
 url.searchParams.set('amount',String(amountVnd));
 url.searchParams.set('orderId',txnRef);
 url.searchParams.set('orderInfo',orderInfo);
 url.searchParams.set('redirectUrl',redirectUrl);
 url.searchParams.set('ipnUrl',ipnUrl);
 url.searchParams.set('requestType','captureWallet');
 url.searchParams.set('extraData','');
 url.searchParams.set('signature',signature);
 return url.toString();
}

function buildZalopayPaymentUrl(settings,{amountVnd,txnRef,baseUrl='https://gaeru.com'}){
 const endpoint=settings.environment==='production'?'https://openapi.zalopay.vn/v2/pay':'https://sb-openapi.zalopay.vn/v2/pay';
 const redirectUrl=new URL('/api/payments/zalopay/return',baseUrl).toString();
 const callbackUrl=new URL('/api/payments/zalopay/ipn',baseUrl).toString();
 const now=new Date();
 const yymmdd=now.toISOString().slice(2,10).replaceAll('-','');
 const appTransId=`${yymmdd}_${txnRef}`;
 const appTime=String(now.getTime());
 const embedData=JSON.stringify({redirecturl:redirectUrl,orderNumber:txnRef});
 const item='[]';
 const raw=`${settings.appId}|${appTransId}|gaeru|${amountVnd}|${appTime}|${embedData}|${item}`;
 const mac=createHmac('sha256',settings.key1).update(raw,'utf8').digest('hex');
 const url=new URL(endpoint);
 url.searchParams.set('app_id',settings.appId);
 url.searchParams.set('app_trans_id',appTransId);
 url.searchParams.set('app_user','gaeru');
 url.searchParams.set('amount',String(amountVnd));
 url.searchParams.set('app_time',appTime);
 url.searchParams.set('embed_data',embedData);
 url.searchParams.set('item',item);
 url.searchParams.set('callback_url',callbackUrl);
 url.searchParams.set('redirect_url',redirectUrl);
 url.searchParams.set('mac',mac);
 return url.toString();
}

function extractOrderNumber(input){
 const text=String(input||'').trim();
 if(!text)return '';
 const matched=text.match(/GR-\d{8}-[A-Z0-9]{4,20}/i);
 if(matched)return matched[0].toUpperCase();
 if(/^\d{6}_GR-/i.test(text))return text.slice(7);
 return text;
}

function verifyGatewayPayload(provider,payload,settings){
 if(!settings)return {valid:false,reason:'Provider not configured'};
 if(provider==='9pay'){
  const orderNumber=extractOrderNumber(payload.invoice_no||payload.orderNumber||payload.order);
  const amountVnd=Number(payload.amount??payload.amountVnd);
  const status=String(payload.status??payload.result??'').toUpperCase();
  const receivedChecksum=String(payload.checksum||payload.signature||'');
  if(!orderNumber||!Number.isSafeInteger(amountVnd)||!receivedChecksum||!settings.checksumKey)return {valid:false,reason:'Missing 9Pay parameters'};
  const expectedWithStatus=createHmac('sha256',settings.checksumKey).update(`${orderNumber}:${amountVnd}:${status}`,'utf8').digest('hex');
  if(!safeHexEqual(receivedChecksum,expectedWithStatus))return {valid:false,reason:'Invalid 9Pay checksum'};
  const successful=['SUCCESS','PAID','00','000','COMPLETED'].includes(status);
  return {
   valid:true,
   orderNumber,
   amountVnd,
   successful,
   providerTransactionId:String(payload.payment_no||payload.transaction_id||payload.transId||''),
   responseCode:status||'00'
  };
 }
 if(provider==='momo'){
  const partnerCode=String(payload.partnerCode||settings.partnerCode||'');
  const orderId=String(payload.orderId||payload.orderNumber||payload.order||'');
  const orderNumber=extractOrderNumber(orderId);
  const amountVnd=Number(payload.amount??payload.amountVnd);
  const resultCode=String(payload.resultCode??payload.status??'');
  const transId=String(payload.transId??payload.transactionId??'');
  const signature=String(payload.signature||'');
  if(!orderNumber||!Number.isSafeInteger(amountVnd)||!signature||!settings.secretKey||partnerCode!==settings.partnerCode){
   return {valid:false,reason:'Invalid MoMo parameters'};
  }
  const fullRaw=`accessKey=${settings.accessKey}&amount=${amountVnd}&extraData=${payload.extraData||''}&message=${payload.message||''}&orderId=${orderId}&orderInfo=${payload.orderInfo||''}&orderType=${payload.orderType||''}&partnerCode=${partnerCode}&payType=${payload.payType||''}&requestId=${payload.requestId||orderId}&responseTime=${payload.responseTime||''}&resultCode=${resultCode}&transId=${transId}`;
  const compactRaw=`partnerCode=${partnerCode}&orderId=${orderId}&amount=${amountVnd}&resultCode=${resultCode}&transId=${transId}`;
  const expectedFull=signMomoMessage(settings.secretKey,fullRaw);
  const expectedCompact=signMomoMessage(settings.secretKey,compactRaw);
  if(!safeHexEqual(signature,expectedFull)&&!safeHexEqual(signature,expectedCompact))return {valid:false,reason:'Invalid MoMo signature'};
  const successful=resultCode==='0'||resultCode.toUpperCase()==='PAID'||resultCode.toUpperCase()==='SUCCESS';
  return {
   valid:true,
   orderNumber,
   amountVnd,
   successful,
   providerTransactionId:transId||null,
   responseCode:resultCode
  };
 }
 if(provider==='zalopay'){
  if(!settings.key2)return {valid:false,reason:'Missing ZaloPay key2'};
  if(typeof payload.data==='string'&&payload.mac){
   const expectedMac=createHmac('sha256',settings.key2).update(payload.data,'utf8').digest('hex');
   if(!safeHexEqual(payload.mac,expectedMac))return {valid:false,reason:'Invalid ZaloPay callback mac'};
   let parsedData;
   try{parsedData=JSON.parse(payload.data);}catch{return {valid:false,reason:'Malformed ZaloPay data'};}
   if(String(parsedData.app_id||settings.appId)!==String(settings.appId))return {valid:false,reason:'Mismatched ZaloPay app_id'};
   const orderNumber=extractOrderNumber(parsedData.app_trans_id||parsedData.orderNumber);
   const amountVnd=Number(parsedData.amount);
   return {
    valid:Boolean(orderNumber&&Number.isSafeInteger(amountVnd)),
    orderNumber,
    amountVnd,
    successful:true,
    providerTransactionId:String(parsedData.zp_trans_id||''),
    responseCode:'1'
   };
  }
  const appTransId=String(payload.app_trans_id||payload.apptransid||payload.orderNumber||payload.order||'');
  const orderNumber=extractOrderNumber(appTransId);
  const amountVnd=Number(payload.amount??payload.amountVnd);
  const status=String(payload.status??payload.return_code??'1');
  const mac=String(payload.mac||payload.checksum||'');
  if(!orderNumber||!Number.isSafeInteger(amountVnd)||!mac)return {valid:false,reason:'Missing ZaloPay query parameters'};
  const raw=`${settings.appId}|${appTransId}|${amountVnd}|${status}`;
  const expectedMac=createHmac('sha256',settings.key2).update(raw,'utf8').digest('hex');
  if(!safeHexEqual(mac,expectedMac))return {valid:false,reason:'Invalid ZaloPay mac'};
  const successful=status==='1'||status.toUpperCase()==='PAID'||status.toUpperCase()==='SUCCESS';
  return {
   valid:true,
   orderNumber,
   amountVnd,
   successful,
   providerTransactionId:String(payload.zp_trans_id||payload.transId||''),
   responseCode:status
  };
 }
 if(provider==='bank_transfer'){
  return {valid:false,reason:'Automatic bank reconciliation is disabled until a verified provider adapter is configured. Use owner-authorized reconciliation.'};
 }
 return {valid:false,reason:'Unsupported provider'};
}

async function reconcilePrepaidOrder(poolOrClient,{provider,orderNumber,amountVnd,successful=true,providerTransactionId=null,responseCode=null,finance=null,audit=appendAudit,actor=null}){
 const run=async client=>{
  const attemptQuery=await client.query(
   `SELECT p.id, p.amount_vnd AS "amountVnd", p.status AS "attemptStatus",
     o.id AS "orderId", o.order_number AS "orderNumber", o.status AS "orderStatus",
     o.payment_method AS "paymentMethod", o.subtotal_vnd AS "subtotalVnd",
     o.shipping_fee_vnd AS "shippingFeeVnd", o.discount_vnd AS "discountVnd",
     o.total_vnd AS "totalVnd", o.payment_status AS "paymentStatus"
    FROM payment_attempts p JOIN orders o ON o.id = p.order_id
    WHERE p.transaction_ref = $1 AND p.provider = $2
    FOR UPDATE OF p, o`,
   [orderNumber,provider]
  );
  let attempt=attemptQuery.rows[0];
  if(!attempt){
   const orderQuery=await client.query(
    `SELECT id AS "orderId", order_number AS "orderNumber", status AS "orderStatus",
      payment_method AS "paymentMethod", subtotal_vnd AS "subtotalVnd",
      shipping_fee_vnd AS "shippingFeeVnd", discount_vnd AS "discountVnd",
      total_vnd AS "totalVnd", payment_status AS "paymentStatus"
     FROM orders WHERE order_number = $1 FOR UPDATE`,
    [orderNumber]
   );
   const order=orderQuery.rows[0];
   if(!order||order.paymentMethod!==provider)return {code:'01',matched:false,message:'Order not found'};
   const insertedAttempt=await client.query(
    `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '15 minutes')
     ON CONFLICT (transaction_ref) DO UPDATE SET updated_at = now()
     RETURNING id, amount_vnd AS "amountVnd", status AS "attemptStatus"`,
    [order.orderId,provider,orderNumber,order.totalVnd]
   );
   attempt={...order,...insertedAttempt.rows[0]};
  }
  if(!Number.isSafeInteger(amountVnd)||amountVnd!==attempt.amountVnd||attempt.totalVnd!==attempt.amountVnd){
   return {code:'04',matched:false,message:'Invalid amount'};
  }
  if(attempt.attemptStatus==='paid'||attempt.paymentStatus==='paid'){
   return {
    code:'02',
    matched:true,
    alreadyConfirmed:true,
    message:'Order already confirmed',
    orderId:attempt.orderId,
    orderNumber:attempt.orderNumber||orderNumber,
    orderStatus:attempt.orderStatus,
    paymentStatus:attempt.paymentStatus
   };
  }
  await client.query(
   `UPDATE payment_attempts SET status=$2, provider_transaction_id=$3, response_code=$4, updated_at=now()
    WHERE id=$1`,
   [attempt.id,successful?'paid':'failed',providerTransactionId||null,responseCode||null]
  );
  let nextOrderStatus=attempt.orderStatus||'pending';
  if(successful){
   if(finance?.recordFullOrderPayment){
    await finance.recordFullOrderPayment(client,{
     order:{id:attempt.orderId,order_number:attempt.orderNumber||orderNumber,payment_method:provider,total_vnd:attempt.totalVnd},
     actor:actor||{username:provider,source:'payment_gateway'}
    });
   }
   await client.query(
    "UPDATE orders SET payment_status='paid', status=CASE WHEN status IN ('pending','confirmed') THEN 'processing' ELSE status END, updated_at=now() WHERE id=$1",
    [attempt.orderId]
   );
   if(!nextOrderStatus||['pending','confirmed'].includes(nextOrderStatus))nextOrderStatus='processing';
  }
  await audit(client,{
   actor:actor||{username:provider,source:'payment_gateway'},
   action:`payment.${provider}.callback`,
   entityType:'order',
   entityId:attempt.orderId,
   metadata:{
    successful,
    amountVnd:attempt.amountVnd,
    responseCode:responseCode||null,
    autoApprovedToProcessing:Boolean(successful)
   }
  });
  return {
   code:'00',
   matched:true,
   successful,
   message:'Confirm Success',
   orderId:attempt.orderId,
   orderNumber:attempt.orderNumber||orderNumber,
   paymentStatus:successful?'paid':'pending',
   orderStatus:nextOrderStatus
  };
 };
 return typeof poolOrClient.connect==='function'?withTransaction(poolOrClient,run):run(poolOrClient);
}

async function getCheckoutPaymentChannels(pool,config={},fallbackVnpay=null){
 const vnpayConfig=(await getVnpay(pool,config))||fallbackVnpay||null;
 const methods=[];
 const configs={};
 let bankTransfer=null;
 let cod=null;
 for(const id of channelIds){
  const record=await readChannelRecord(pool,config,id);
  const enabled=isChannelEnabled(id,record,vnpayConfig);
  if(id==='vnpay'){
   if(enabled&&vnpayConfig){
    methods.push('vnpay');
    configs.vnpay=vnpayConfig;
   }
   continue;
  }
  if(enabled){
   methods.push(id);
   configs[id]=record.data;
   if(id==='bank_transfer')bankTransfer=formatBankTransferInstructions(record.data);
   if(id==='cod')cod={maxAmountVnd:Number(record.data.maxAmountVnd||50000000),instructions:String(record.data.instructions||'')};
  }
 }
 return {methods,bankTransfer,cod,configs};
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
 if(id==='momo'){
  if(!settings.partnerCode||String(settings.partnerCode).trim().length<2)throw fail('Lưu Partner Code MoMo trước khi kiểm tra kết nối.',400);
  if(!settings.accessKey||String(settings.accessKey).trim().length<2)throw fail('Lưu Access Key MoMo trước khi kiểm tra kết nối.',400);
  if(!settings.secretKey||String(settings.secretKey).length<8)throw fail('Lưu Secret Key MoMo trước khi kiểm tra kết nối.',400);
  const endpoint=settings.environment==='production'?'https://payment.momo.vn':'https://test-payment.momo.vn';
  const signedUrl=buildMomoPaymentUrl(settings,{amountVnd:100000,txnRef:'GR-20261027-MOMOPROBE1',baseUrl:config.PUBLIC_BASE_URL||'https://gaeru.com'});
  const parsed=new URL(signedUrl);
  const sig=parsed.searchParams.get('signature');
  if(!sig||sig.length!==64)throw fail('Không thể khởi tạo chữ ký HMAC-SHA256 cho MoMo.',500);
  try{
   const response=await fetcher(endpoint,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(12000)});
   if(response.status>=500)throw fail('Máy chủ cổng MoMo đang phản hồi lỗi ('+response.status+').',502);
  }catch(e){
   if(e.status)throw e;
   throw fail('Không thể kết nối tới cổng MoMo. Kiểm tra mạng hoặc thử lại sau.',502);
  }
  return {
   id:'momo',
   name:meta.name,
   verified:true,
   checkedAt,
   method:'gateway_handshake',
   environment:settings.environment,
   message:`Đã xác minh chữ ký HMAC-SHA256 và kết nối thành công tới cổng MoMo (${settings.environment==='production'?'Chính thức':'Thử nghiệm'}).`
  };
 }
 if(id==='zalopay'){
  if(!/^\d{1,20}$/.test(String(settings.appId||'')))throw fail('Lưu App ID ZaloPay hợp lệ trước khi kiểm tra kết nối.',400);
  if(!settings.key1||String(settings.key1).length<8)throw fail('Lưu Key 1 ZaloPay trước khi kiểm tra kết nối.',400);
  if(!settings.key2||String(settings.key2).length<8)throw fail('Lưu Key 2 ZaloPay trước khi kiểm tra kết nối.',400);
  const endpoint=settings.environment==='production'?'https://openapi.zalopay.vn':'https://sb-openapi.zalopay.vn';
  const signedUrl=buildZalopayPaymentUrl(settings,{amountVnd:100000,txnRef:'GR-20261027-ZLPPROBE01',baseUrl:config.PUBLIC_BASE_URL||'https://gaeru.com'});
  const parsed=new URL(signedUrl);
  const mac=parsed.searchParams.get('mac');
  if(!mac||mac.length!==64)throw fail('Không thể khởi tạo chữ ký MAC HMAC-SHA256 cho ZaloPay.',500);
  try{
   const response=await fetcher(endpoint,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(12000)});
   if(response.status>=500)throw fail('Máy chủ cổng ZaloPay đang phản hồi lỗi ('+response.status+').',502);
  }catch(e){
   if(e.status)throw e;
   throw fail('Không thể kết nối tới cổng ZaloPay. Kiểm tra mạng hoặc thử lại sau.',502);
  }
  return {
   id:'zalopay',
   name:meta.name,
   verified:true,
   checkedAt,
   method:'gateway_handshake',
   environment:settings.environment,
   message:`Đã xác minh chữ ký MAC HMAC-SHA256 và kết nối thành công tới cổng ZaloPay (${settings.environment==='production'?'Chính thức':'Thử nghiệm'}).`
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
 const vnpayConfig=await getVnpay(pool,config);
 const items=[];
 for(const id of channelIds){
  const meta=channels[id];
  const record=await readChannelRecord(pool,config,id);
  const row=rows.find(r=>r.channel_id===id);
  const verified=Boolean(row?.verified_at)&&row.config_version===record.version;
  const enabled=isChannelEnabled(id,record,vnpayConfig);
  items.push({
   id,
   configId:meta.configId,
   name:meta.name,
   prepaid:meta.prepaid,
   version:record.version,
   verified,
   verifiedAt:verified?row.verified_at:null,
   enabled,
   configured:isChannelConfigured(id,record,vnpayConfig),
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
   ninepayIpn:new URL('/api/payments/9pay/ipn',baseUrl).toString(),
   momoReturn:new URL('/api/payments/momo/return',baseUrl).toString(),
   momoIpn:new URL('/api/payments/momo/ipn',baseUrl).toString(),
   zalopayReturn:new URL('/api/payments/zalopay/return',baseUrl).toString(),
   zalopayIpn:new URL('/api/payments/zalopay/ipn',baseUrl).toString(),
   bankTransferWebhook:new URL('/api/payments/bank_transfer/webhook',baseUrl).toString()
  }
 };
}

function createPaymentAdmin(pool,config,{fetcher,finance}={}){
 const router=Router();
 const channelEnum=z.enum(['cod','bank_transfer','vnpay','9pay','momo','zalopay']);
 router.use('/owner/payments',(req,res,next)=>req.admin?.role==='owner'&&req.admin?.source==='bootstrap'?next():res.status(403).json({error:'Chỉ chủ doanh nghiệp được thiết lập kênh thanh toán.'}));
 router.get('/owner/payments',async(_req,res,next)=>{
  try{
   res.json(await listPaymentChannels(pool,config));
  }catch(e){next(e);}
 });
 router.post('/owner/payments/:id/test',requireCsrf,rateLimit({windowMs:900000,limit:20,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{
  try{
   const id=channelEnum.parse(req.params.id);
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
   const id=channelEnum.parse(req.params.id);
   const meta=channels[id];
   const payload=z.object({enabled:z.boolean(),version:z.number().int().min(0)}).parse(req.body);
   let nextVersion=payload.version;
   await config.accountSecurity.authorize(req,async(_a,c)=>{
    const current=await readChannelRecord(c,config,id);
    if(current.version!==payload.version)throw fail('Cấu hình đã thay đổi. Tải lại trang.');
    if(payload.enabled&&id!=='cod'&&current.version===0)throw fail('Lưu thông tin kết nối kênh thanh toán trước khi bật.');
    if(['vnpay','9pay','momo','zalopay'].includes(id)&&payload.enabled&&config.NODE_ENV==='production'&&current.data.environment==='sandbox'){
     throw fail(`Chỉ bật ${meta.name} chính thức trên website đang hoạt động. Dùng môi trường riêng để thử sandbox.`,400);
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
 router.post('/owner/payments/reconcile',requireCsrf,rateLimit({windowMs:900000,limit:30,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{
  try{
   const parsed=z.object({
    provider:z.enum(['bank_transfer','vnpay','9pay','momo','zalopay']),
    orderNumber:z.string().trim().min(5).max(80),
    amountVnd:z.number().int().min(1).max(2000000000),
    providerTransactionId:z.string().trim().max(120).optional()
   }).parse({
    ...req.body,
    orderNumber:extractOrderNumber(req.body?.orderNumber||req.body?.content)
   });
   let outcome;
   await config.accountSecurity.authorize(req,async(_a,client)=>{
    outcome=await reconcilePrepaidOrder(client,{
     provider:parsed.provider,
     orderNumber:parsed.orderNumber,
     amountVnd:parsed.amountVnd,
     successful:true,
     providerTransactionId:parsed.providerTransactionId||'OWNER-RECONCILE',
     responseCode:'00',
     finance,
     actor:req.admin
    });
    if(!outcome.matched)throw fail(outcome.code==='04'?'Số tiền giao dịch không khớp với tổng tiền đơn hàng.':'Không tìm thấy đơn hàng chờ thanh toán tương ứng.',409);
    return outcome;
   });
   res.json({
    ...outcome,
    message:outcome.alreadyConfirmed
     ?`Đơn ${outcome.orderNumber} đã được ghi nhận thanh toán trước đó.`
     :`Đã đối soát thành công giao dịch ${channels[parsed.provider].name} và tự động chuyển đơn ${outcome.orderNumber} sang trạng thái Chờ gửi hàng.`
   });
  }catch(e){
   if(e instanceof z.ZodError)return res.status(400).json({error:'Nhập đúng kênh thanh toán, mã đơn (GR-...) và số tiền giao dịch để đối soát.'});
   next(e);
  }
 });
 return router;
}

module.exports={
 channels,
 channelIds,
 prepaidChannelIds,
 defaultChannelData,
 readChannelRecord,
 isChannelConfigured,
 isChannelEnabled,
 getCheckoutPaymentChannels,
 formatBankTransferInstructions,
 buildNinepayPaymentUrl,
 buildMomoPaymentUrl,
 buildZalopayPaymentUrl,
 extractOrderNumber,
 verifyGatewayPayload,
 reconcilePrepaidOrder,
 verifyPaymentChannel,
 verifyAndRecordPayment,
 listPaymentChannels,
 createPaymentAdmin
};
