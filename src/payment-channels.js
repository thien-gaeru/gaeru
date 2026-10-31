'use strict';
const {Router}=require('express');
const {randomUUID,createHmac,timingSafeEqual}=require('node:crypto');
const {rateLimit}=require('express-rate-limit');
const {z}=require('zod');
const {withTransaction}=require('./db');
const {requireCsrf}=require('./security');
const {readRecord,writeRecord,getVnpay}=require('./admin-configuration');
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
 const fallback=id==='vnpay'&&!record.version&&config.vnpay?{
  tmnCode:config.vnpay.tmnCode,hashSecret:config.vnpay.hashSecret,
  environment:String(config.vnpay.paymentUrl).includes('sandbox.')?'sandbox':'production',enabled:true
 }:{};
 return {version:record.version,data:{...defaultChannelData(id),...fallback,...record.data}};
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

function signMomoMessage(secretKey,raw){return createHmac('sha256',secretKey).update(raw,'utf8').digest('hex');}

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
 if(!payload||typeof payload!=='object'||Array.isArray(payload))return {valid:false,reason:'Invalid callback payload'};
 const scalar=value=>(typeof value==='string'||typeof value==='number')&&!(typeof value==='number'&&!Number.isSafeInteger(value));
 const unsigned=value=>scalar(value)&&/^(?:0|[1-9]\d{0,19})$/.test(String(value));
 const amount=value=>unsigned(value)&&Number.isSafeInteger(Number(value))&&Number(value)>0&&Number(value)<=2000000000;
 const positiveId=value=>unsigned(value)&&String(value)!=='0';
 const orderPattern=/^GR-\d{8}-[A-Z0-9]{4,20}$/;
 if(provider==='9pay'){
  return {valid:false,reason:'Automatic 9Pay callbacks are unavailable until a verified merchant contract is configured. Use owner-authorized reconciliation.'};
 }
 if(provider==='momo'){
  const textFields=['partnerCode','orderId','orderInfo','orderType','payType','requestId','message','extraData'];
  if(textFields.some(field=>typeof payload[field]!=='string'||payload[field].length>4000)
   ||!orderPattern.test(payload.orderId)||!payload.requestId||payload.requestId.length>100
   ||!payload.orderType||!amount(payload.amount)||!unsigned(payload.resultCode)
   ||!unsigned(payload.transId)||!positiveId(payload.responseTime)
   ||(String(payload.resultCode)==='0'&&!positiveId(payload.transId))
   ||typeof payload.signature!=='string'||!/^[a-f0-9]{64}$/i.test(payload.signature)
   ||typeof settings.accessKey!=='string'||!settings.accessKey||typeof settings.secretKey!=='string'||!settings.secretKey
   ||payload.partnerCode!==settings.partnerCode){
   return {valid:false,reason:'Invalid MoMo parameters'};
  }
  const fullRaw=`accessKey=${settings.accessKey}&amount=${payload.amount}&extraData=${payload.extraData}&message=${payload.message}&orderId=${payload.orderId}&orderInfo=${payload.orderInfo}&orderType=${payload.orderType}&partnerCode=${payload.partnerCode}&payType=${payload.payType}&requestId=${payload.requestId}&responseTime=${payload.responseTime}&resultCode=${payload.resultCode}&transId=${payload.transId}`;
  const expectedFull=signMomoMessage(settings.secretKey,fullRaw);
  if(!safeHexEqual(payload.signature,expectedFull))return {valid:false,reason:'Invalid MoMo signature'};
  return {
   valid:true,
   orderNumber:payload.orderId,
   providerOrderId:payload.orderId,
   requestId:payload.requestId,
   amountVnd:Number(payload.amount),
   successful:String(payload.resultCode)==='0',
   providerTransactionId:String(payload.transId),
   responseCode:String(payload.resultCode)
  };
 }
 if(provider==='zalopay'){
  if(typeof settings.key2!=='string'||!settings.key2||payload.type!==1||typeof payload.data!=='string'||payload.data.length>65536
   ||typeof payload.mac!=='string'||!/^[a-f0-9]{64}$/i.test(payload.mac))return {valid:false,reason:'Invalid ZaloPay callback envelope'};
  const expectedMac=createHmac('sha256',settings.key2).update(payload.data,'utf8').digest('hex');
  if(!safeHexEqual(payload.mac,expectedMac))return {valid:false,reason:'Invalid ZaloPay callback mac'};
  let parsedData;
  try{parsedData=JSON.parse(payload.data);}catch{return {valid:false,reason:'Malformed ZaloPay data'};}
  if(!parsedData||typeof parsedData!=='object'||Array.isArray(parsedData)||!positiveId(parsedData.app_id)
   ||String(parsedData.app_id)!==String(settings.appId))return {valid:false,reason:'Mismatched ZaloPay app_id'};
  const matched=typeof parsedData.app_trans_id==='string'&&parsedData.app_trans_id.match(/^\d{6}_(GR-\d{8}-[A-Z0-9]{4,20})$/);
  if(!matched||!amount(parsedData.amount)||!positiveId(parsedData.zp_trans_id))return {valid:false,reason:'Invalid ZaloPay transaction parameters'};
  return {
   valid:true,
   orderNumber:matched[1],
   providerOrderId:parsedData.app_trans_id,
   amountVnd:Number(parsedData.amount),
   successful:true,
   providerTransactionId:String(parsedData.zp_trans_id),
   responseCode:'1'
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
  if(!attempt&&actor?.role!=='owner')return {code:'01',matched:false,message:'Order not found'};
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
  if(attempt.attemptStatus==='cancelled'&&!successful){
   return {
    code:'00',
    matched:true,
    alreadyCancelled:true,
    successful:false,
    message:'Order already cancelled and unpaid',
    orderId:attempt.orderId,
    orderNumber:attempt.orderNumber||orderNumber,
    orderStatus:attempt.orderStatus,
    paymentStatus:attempt.paymentStatus
   };
  }
  const { PaymentAttemptStateMachine } = require('./domain/payments/order-idempotency-policy');
  PaymentAttemptStateMachine.assertValidTransition(attempt.attemptStatus, successful ? 'paid' : 'failed');
  await client.query(
   `UPDATE payment_attempts
    SET status=$2, provider_transaction_id=COALESCE($3, provider_transaction_id), response_code=$4,
        last_error_code=CASE WHEN $5 THEN NULL ELSE last_error_code END, updated_at=now()
    WHERE id=$1`,
   [attempt.id,successful?'paid':'failed',providerTransactionId||null,responseCode||null,Boolean(successful)]
  );
  let nextOrderStatus=attempt.orderStatus||'pending';
  const isLateSettlement=Boolean(successful&&(attempt.orderStatus==='cancelled'||attempt.attemptStatus==='cancelled'));
  if(successful){
   const ledger=finance||require('./finance-api');
   if(ledger?.recordFullOrderPayment){
    await ledger.recordFullOrderPayment(client,{
     order:{id:attempt.orderId,order_number:attempt.orderNumber||orderNumber,payment_method:provider,total_vnd:attempt.totalVnd},
     actor:actor||{username:provider,source:'payment_gateway'}
    });
   }
   await client.query(
    "UPDATE orders SET payment_status='paid', status=CASE WHEN status IN ('pending','confirmed') THEN 'processing' ELSE status END, updated_at=now() WHERE id=$1",
    [attempt.orderId]
   );
   if(!nextOrderStatus||['pending','confirmed'].includes(nextOrderStatus))nextOrderStatus='processing';
   if(isLateSettlement){
    try{
     const { logOrderActivity } = require('./order-activity');
     if (typeof logOrderActivity === 'function') {
      await logOrderActivity(client, {
       orderId: attempt.orderId,
       orderNumber: attempt.orderNumber || orderNumber,
       actorType: 'gateway',
       actorName: provider.toUpperCase(),
       action: 'note_added',
       details: {
        type: 'late_settlement_on_cancelled_order',
        message: `CẢNH BÁO: Cổng ${provider.toUpperCase()} báo thanh toán thành công ${attempt.amountVnd || attempt.totalVnd}đ sau khi đơn hàng đã bị hủy. Cần liên hệ khách để hoàn tiền.`,
        requiresRefund: true,
        amountVnd: attempt.amountVnd || attempt.totalVnd,
        providerTransactionId: providerTransactionId || null
       }
      });
     }
    }catch(e){console.error('Lỗi ghi order_activity cho thanh toán sau hủy:', e.message);}
    try{
     await client.query(
      `INSERT INTO system_alerts (severity, source, message, metadata)
       VALUES ('critical', 'payment_gateway', $1, $2)`,
      [
       `Tiền về sau khi đơn ${attempt.orderNumber || orderNumber} đã bị hủy (${attempt.amountVnd || attempt.totalVnd}đ qua ${provider.toUpperCase()}). Cần hoàn tiền khẩn cấp!`,
       JSON.stringify({
        orderId: attempt.orderId,
        orderNumber: attempt.orderNumber || orderNumber,
        provider,
        providerTransactionId,
        amountVnd: attempt.amountVnd || attempt.totalVnd,
        requiresRefund: true
       })
      ]
     );
    }catch(e){}
   }
  }
  await audit(client,{
   actor:actor||{username:provider,source:'payment_gateway'},
   action:`payment.${provider}.callback`,
   entityType:'order',
   entityId:attempt.orderId,
   before:{attemptStatus:attempt.attemptStatus,orderStatus:attempt.orderStatus,paymentStatus:attempt.paymentStatus},
   after:{attemptStatus:successful?'paid':'failed',orderStatus:nextOrderStatus,paymentStatus:successful?'paid':attempt.paymentStatus},
   metadata:{
    successful,
    amountVnd:attempt.amountVnd,
    responseCode:responseCode||null,
    previousAttemptStatus:attempt.attemptStatus||null,
    lateSettlementOnCancelledOrder:isLateSettlement,
    requiresRefund:isLateSettlement,
    autoApprovedToProcessing:Boolean(successful&&['pending','confirmed'].includes(attempt.orderStatus))
   }
  });
  return {
   code:'00',
   matched:true,
   successful,
   message:isLateSettlement?'Payment confirmed on cancelled order (refund required)':'Confirm Success',
   action:isLateSettlement?'late_settlement_refund_needed':'confirmed',
   requiresRefund:isLateSettlement,
   orderId:attempt.orderId,
   orderNumber:attempt.orderNumber||orderNumber,
   paymentStatus:successful?'paid':'pending',
   orderStatus:nextOrderStatus
  };
 };
 return typeof poolOrClient.connect==='function'?withTransaction(poolOrClient,run):run(poolOrClient);
}

async function assertPaymentConfigurationChange(client,id,before,after){
 if(!['vnpay','9pay','momo','zalopay'].includes(id))return;
 await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[id==='vnpay'?'gaeru:vnpay-config':'gaeru:payment-config:'+id]);
 const fields={vnpay:['tmnCode','hashSecret','environment'],'9pay':['merchantKey','secretKey','checksumKey','environment'],momo:['partnerCode','accessKey','secretKey','environment'],zalopay:['appId','key1','key2','environment']}[id];
 if(fields.every(k=>before[k]===after[k]))return;
 const count=(await client.query("SELECT count(*)::int AS count FROM payment_attempts WHERE provider=$1 AND status IN ('pending','payment_initiation_unknown','awaiting_reconciliation')",[id])).rows[0]?.count||0;
 if(count)throw fail('Có giao dịch đang chờ. Đối soát hoặc hủy đơn trước khi đổi tài khoản, khóa hoặc môi trường thanh toán.',409);
}
function authenticatedProof(method,scope){
 return method==='signed_callback'?scope==='callback_signature':['authenticated_api','provider_order_create'].includes(method)&&scope==='api_credentials';
}
function availability(id,record,vnpayConfig,config={}){
 const supported=id!=='9pay';
 const configured=isChannelConfigured(id,record,vnpayConfig);
 const sandboxOnProduction=config.NODE_ENV==='production'&&(record.data.environment==='sandbox'||(id==='vnpay'&&String(vnpayConfig?.paymentUrl||'').includes('sandbox.')));
 const canEnable=supported&&configured&&!sandboxOnProduction;
 const enabled=supported&&isChannelEnabled(id,record,vnpayConfig);
 return {supported,canEnable,enabled,checkoutReady:enabled&&canEnable,unsupportedReason:!supported?'9Pay chưa có bộ kết nối được đối chiếu với tài liệu merchant.':sandboxOnProduction?'Dùng cấu hình chính thức trên website đang hoạt động.':!configured?'Lưu đủ thông tin cấu hình trước khi bật.':null};
}
async function recordGatewayEvidence(client,id,version,{method='signed_callback',scope='callback_signature',enabled=false}={}){
 if(!authenticatedProof(method,scope))throw fail('Bằng chứng xác thực không hợp lệ.',400);
 await client.query(`INSERT INTO payment_channel_connections(channel_id,config_version,verified_at,enabled,last_method,last_checked_at,reachable,verification_scope)
 VALUES($1,$2,now(),$3,$4,now(),true,$5)
 ON CONFLICT(channel_id) DO UPDATE SET verified_at=now(),last_method=$4,last_checked_at=now(),reachable=true,verification_scope=$5,verification_nonce=NULL,updated_at=now()
 WHERE payment_channel_connections.config_version=$2`,[id,version,enabled,method,scope]);
}
async function getCheckoutPaymentChannels(pool,config={},fallbackVnpay=null){
 const storedVnpay=await readChannelRecord(pool,config,'vnpay');
 const vnpayConfig=storedVnpay.version?await getVnpay(pool,config):(await getVnpay(pool,config))||fallbackVnpay||null;
 const callbackVnpay=await getVnpay(pool,config,{forCallback:true});
 const methods=[],configs={},callbackConfigs={},versions={};let bankTransfer=null,cod=null;
 for(const id of channelIds){
  const record=await readChannelRecord(pool,config,id);versions[id]=record.version;
  if(id==='vnpay'){const callback=storedVnpay.version?callbackVnpay:callbackVnpay||fallbackVnpay;if(callback)callbackConfigs.vnpay=callback;}
  else if(id!=='9pay'&&isChannelConfigured(id,record,null))callbackConfigs[id]=record.data;
  if(!availability(id,record,vnpayConfig,config).checkoutReady)continue;
  methods.push(id);configs[id]=id==='vnpay'?vnpayConfig:record.data;
  if(id==='bank_transfer')bankTransfer=formatBankTransferInstructions(record.data);
  if(id==='cod')cod={maxAmountVnd:Number(record.data.maxAmountVnd||50000000),instructions:String(record.data.instructions||'')};
 }
 return {methods,bankTransfer,cod,configs,callbackConfigs,versions};
}

async function verifyPaymentChannel(id,settings,{config={},pool=null,fetcher=fetch}={}){
 const meta=channels[id];if(!meta)throw fail('Kênh thanh toán không hợp lệ.',404);
 const base={id,name:meta.name,verified:false,checkedAt:new Date().toISOString(),verificationScope:null,callbackVerified:false};
 if(id==='cod'){
  const max=Number(settings.maxAmountVnd??50000000);
  if(!Number.isSafeInteger(max)||max<100000||max>2000000000)throw fail('Hạn mức COD chưa hợp lệ.',400);
  let shippingConfigured=true;if(pool){const row=(await pool.query("SELECT setting_value FROM store_settings WHERE setting_key='shipping_rates'")).rows[0];shippingConfigured=Boolean(row?.setting_value&&Object.keys(row.setting_value).length);}
  return {...base,configured:true,reachable:null,method:'configuration_validation',message:'Cấu hình COD hợp lệ.'+(!shippingConfigured?' Thêm bảng phí giao hàng trước khi nhận đơn.':'')};
 }
 if(id==='bank_transfer'){
  if(!settings.bankName||settings.bankName.trim().length<2||!settings.accountHolder||settings.accountHolder.trim().length<2||!(/^[0-9A-Za-z]{6,30}$/).test(String(settings.accountNumber||''))||String(settings.transferSyntax||'GAERU {MA_DON}').trim().length<3)throw fail('Thông tin chuyển khoản chưa hợp lệ.',400);
  return {...base,configured:true,reachable:null,method:'configuration_validation',message:'Thông tin chuyển khoản đúng định dạng. Chưa xác minh quyền sở hữu tài khoản; chủ doanh nghiệp đối soát giao dịch trước khi ghi nhận đã thu tiền.'};
 }
 if(id==='9pay')return {...base,reachable:null,supported:false,method:'unsupported',message:'9Pay chưa có bộ kết nối được đối chiếu với tài liệu merchant; chưa cho phép nhận thanh toán.'};
 if(id==='momo'||id==='zalopay'){
  let attempt=null;if(pool)attempt=(await pool.query("SELECT transaction_ref,amount_vnd,provider_request_id FROM payment_attempts WHERE provider=$1 AND provider_request_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",[id])).rows[0]||null;
  const result=await require('./payment-provider-clients').verifyGatewayAccount(id,settings,{fetcher,...(attempt?{txnRef:attempt.transaction_ref,amountVnd:attempt.amount_vnd,requestId:attempt.provider_request_id}:{})});
  return {...base,...result,id,name:meta.name,method:result.verified?'authenticated_api':'gateway_reachability'};
 }
 if(id==='vnpay'){
  if(!(/^[a-zA-Z0-9]{8}$/).test(String(settings.tmnCode||''))||String(settings.hashSecret||'').length<8)throw fail('Lưu đủ mã website và khóa VNPAY trước khi kiểm tra.',400);
  const endpoint=settings.environment==='production'?'https://pay.vnpay.vn/vpcpay.html':'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html';
  try{const response=await fetcher(endpoint,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(12000)});await response.body?.cancel?.();const reachable=response.ok===true;
   return {...base,reachable,method:'gateway_reachability',message:reachable?'Liên lạc được máy chủ VNPAY. Chưa xác minh tài khoản hoặc khóa; cần phản hồi giao dịch có chữ ký hợp lệ.':'Máy chủ VNPAY chưa trả phản hồi thành công. Chưa xác minh tài khoản hoặc khóa.'};
  }catch{return {...base,reachable:false,method:'gateway_reachability',message:'Chưa liên lạc được VNPAY; tài khoản chưa được xác minh.'};}
 }
 throw fail('Kênh thanh toán chưa hỗ trợ kiểm tra.',501);
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
   'UPDATE payment_channel_connections SET verified_at=CASE WHEN $6 THEN now() ELSE NULL END,enabled=$4,last_method=$5,last_checked_at=now(),reachable=$7,verification_scope=$8,updated_at=now() WHERE channel_id=$1 AND config_version=$2 AND verification_nonce=$3 RETURNING channel_id',
   [id,version,nonce,Boolean(current.data.enabled),result.method,result.verified===true&&authenticatedProof(result.method,result.verificationScope),result.reachable??null,result.verificationScope||null]
  );
  if(!changed.rows.length)throw fail('Có lần kiểm tra mới hơn. Tải lại trạng thái kết nối.');
  await appendAudit(c,{actor,action:'payment.connection.verify',entityType:'configuration',entityId:meta.configId,metadata:{channelId:id,version,method:result.method,verified:result.verified===true&&authenticatedProof(result.method,result.verificationScope),reachable:result.reachable??null,verificationScope:result.verificationScope||null}});
 });
 return {...result,version};
}

async function listPaymentChannels(pool,config){
 const rows=(await pool.query('SELECT channel_id,config_version,verified_at,enabled,last_method,last_checked_at,reachable,verification_scope FROM payment_channel_connections')).rows;
 const vnpayConfig=await getVnpay(pool,config);
 const items=[];
 for(const id of channelIds){
  const meta=channels[id];
  const record=await readChannelRecord(pool,config,id);
  const row=rows.find(r=>r.channel_id===id);
  const current=row?.config_version===record.version;const verified=Boolean(row?.verified_at)&&current&&authenticatedProof(row.last_method,row.verification_scope);
  const state=availability(id,record,vnpayConfig,config);const enabled=state.enabled;
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
   environment:record.data.environment||null,
    ...state,method:current?row.last_method:null,checkedAt:current?row.last_checked_at:null,reachable:current?row.reachable:null,verificationScope:verified?row.verification_scope:null,callbackVerified:verified&&row.last_method==='signed_callback'
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

async function reconcileGatewayOrder(pool,{orderId=null,orderNumber=null,provider=null,settings=null,config={},fetcher=null,inventory=null,finance=null,audit=appendAudit,actor=null,cancelOnUnpaid=true}={}){
 const cleanOrderNumber=orderNumber?extractOrderNumber(orderNumber):null;
 if(!orderId&&!cleanOrderNumber)throw fail('Thiếu mã đơn hàng cần đối soát.',400);
 const initialQuery=await pool.query(
  `SELECT p.id AS "attemptId", p.provider, p.transaction_ref AS "transactionRef",
     p.provider_request_id AS "providerRequestId", p.amount_vnd AS "amountVnd",
     p.status AS "attemptStatus", p.expires_at AS "expiresAt",
     o.id AS "orderId", o.order_number AS "orderNumber", o.status AS "orderStatus",
     o.payment_method AS "paymentMethod", o.payment_status AS "paymentStatus",
     o.total_vnd AS "totalVnd", o.voucher_code AS "voucherCode",
     EXISTS (SELECT 1 FROM sales_receipts sr WHERE sr.order_id = o.id) AS "hasReceipt"
   FROM orders o
   LEFT JOIN payment_attempts p ON p.order_id = o.id AND ($3::text IS NULL OR p.provider = $3)
   WHERE ($1::uuid IS NOT NULL AND o.id = $1) OR ($2::text IS NOT NULL AND o.order_number = $2)
   ORDER BY p.created_at DESC NULLS LAST
   LIMIT 1`,
  [orderId,cleanOrderNumber,provider]
 );
 const initial=initialQuery.rows[0];
 if(!initial||!initial.attemptId)throw fail('Không tìm thấy phiên giao dịch cần đối soát.',404);
 if(initial.paymentStatus==='paid'||initial.attemptStatus==='paid'||initial.hasReceipt){
  return {matched:true,verified:true,action:'already_paid',orderId:initial.orderId,orderNumber:initial.orderNumber,orderStatus:initial.orderStatus,paymentStatus:'paid',attemptStatus:'paid'};
 }
 if(initial.orderStatus==='cancelled'&&['failed','cancelled'].includes(initial.attemptStatus)){
  return {matched:true,verified:true,action:'already_cancelled',orderId:initial.orderId,orderNumber:initial.orderNumber,orderStatus:'cancelled',paymentStatus:initial.paymentStatus,attemptStatus:initial.attemptStatus};
 }
 if(!['momo','zalopay'].includes(initial.provider)){
  throw fail('Kênh thanh toán này không hỗ trợ truy vấn tự động qua API ví.',400);
 }

 const channelSettings=settings||(await readChannelRecord(pool,config,initial.provider)).data;
 const {queryGatewayPayment}=require('./payment-provider-clients');
 let queryResult;
 try{
  queryResult=await queryGatewayPayment(initial.provider,channelSettings,{
   txnRef:initial.transactionRef,
   requestId:initial.providerRequestId||undefined,
   fetcher:fetcher||config?.paymentFetcher||fetch
  });
 }catch(queryErr){
  return withTransaction(pool,async client=>{
   const locked=(await client.query(
    `SELECT p.id AS "attemptId", p.status AS "attemptStatus", p.provider,
       o.id AS "orderId", o.order_number AS "orderNumber", o.status AS "orderStatus", o.payment_status AS "paymentStatus",
       EXISTS (SELECT 1 FROM sales_receipts sr WHERE sr.order_id = o.id) AS "hasReceipt"
     FROM payment_attempts p JOIN orders o ON o.id = p.order_id
     WHERE p.id = $1
     FOR UPDATE OF p, o`,
    [initial.attemptId]
   )).rows[0];
   if(!locked)throw fail('Không tìm thấy phiên giao dịch.',404);
   if(locked.paymentStatus==='paid'||locked.attemptStatus==='paid'||locked.hasReceipt){
    return {matched:true,verified:true,action:'already_paid',orderId:locked.orderId,orderNumber:locked.orderNumber,orderStatus:locked.orderStatus,paymentStatus:'paid',attemptStatus:'paid'};
   }
   const errCode=queryErr?.code||'PAYMENT_QUERY_FAILED';
   const { PaymentAttemptStateMachine: sm } = require('./domain/payments/order-idempotency-policy');
   sm.assertValidTransition(locked.attemptStatus, 'awaiting_reconciliation');
   await client.query(
    `UPDATE payment_attempts
     SET status='awaiting_reconciliation', last_error_code=$2, last_reconciled_at=now(),
         reconciliation_attempts=reconciliation_attempts+1, updated_at=now()
     WHERE id=$1`,
    [locked.attemptId,errCode]
   );
   await audit(client,{
    actor:actor||{username:'system',source:'gateway_reconciliation'},
    action:'payment.reconciliation.query_failed',
    entityType:'order',
    entityId:locked.orderId,
    before:{attemptStatus:locked.attemptStatus,orderStatus:locked.orderStatus,paymentStatus:locked.paymentStatus},
    after:{attemptStatus:'awaiting_reconciliation',orderStatus:locked.orderStatus,paymentStatus:locked.paymentStatus},
    metadata:{provider:locked.provider,orderNumber:locked.orderNumber,errorCode:errCode}
   });
   return {
    matched:true,
    verified:false,
    action:'awaiting_reconciliation',
    orderId:locked.orderId,
    orderNumber:locked.orderNumber,
    orderStatus:locked.orderStatus,
    paymentStatus:locked.paymentStatus,
    attemptStatus:'awaiting_reconciliation',
    errorCode:errCode
   };
  });
 }

 return withTransaction(pool,async client=>{
  const locked=(await client.query(
   `SELECT p.id AS "attemptId", p.provider, p.transaction_ref AS "transactionRef",
      p.provider_request_id AS "providerRequestId", p.amount_vnd AS "amountVnd", p.status AS "attemptStatus",
      o.id AS "orderId", o.order_number AS "orderNumber", o.status AS "orderStatus",
      o.payment_status AS "paymentStatus", o.total_vnd AS "totalVnd", o.voucher_code AS "voucherCode",
      EXISTS (SELECT 1 FROM sales_receipts sr WHERE sr.order_id = o.id) AS "hasReceipt"
    FROM payment_attempts p JOIN orders o ON o.id = p.order_id
    WHERE p.id = $1
    FOR UPDATE OF p, o`,
   [initial.attemptId]
  )).rows[0];
  if(!locked)throw fail('Không tìm thấy phiên giao dịch.',404);
  if(locked.paymentStatus==='paid'||locked.attemptStatus==='paid'||locked.hasReceipt){
   return {matched:true,verified:true,action:'already_paid',orderId:locked.orderId,orderNumber:locked.orderNumber,orderStatus:locked.orderStatus,paymentStatus:'paid',attemptStatus:'paid'};
  }

  if(queryResult.found&&queryResult.successful){
   if(queryResult.amountVnd!==locked.amountVnd||locked.totalVnd!==locked.amountVnd){
    const { PaymentAttemptStateMachine: sm } = require('./domain/payments/order-idempotency-policy');
    sm.assertValidTransition(locked.attemptStatus, 'awaiting_reconciliation');
    await client.query(
     `UPDATE payment_attempts
      SET status='awaiting_reconciliation', last_error_code='PAYMENT_AMOUNT_MISMATCH',
          response_code=$2, last_reconciled_at=now(), reconciliation_attempts=reconciliation_attempts+1, updated_at=now()
      WHERE id=$1`,
     [locked.attemptId,String(queryResult.resultCode??'')]
    );
    await audit(client,{
     actor:actor||{username:locked.provider,source:'gateway_reconciliation'},
     action:'payment.reconciliation.amount_mismatch',
     entityType:'order',
     entityId:locked.orderId,
     before:{attemptStatus:locked.attemptStatus,orderStatus:locked.orderStatus,paymentStatus:locked.paymentStatus},
     after:{attemptStatus:'awaiting_reconciliation',orderStatus:locked.orderStatus,paymentStatus:locked.paymentStatus},
     metadata:{provider:locked.provider,orderNumber:locked.orderNumber,expectedAmountVnd:locked.amountVnd,gatewayAmountVnd:queryResult.amountVnd}
    });
    return {matched:false,verified:true,code:'04',action:'amount_mismatch',orderId:locked.orderId,orderNumber:locked.orderNumber,orderStatus:locked.orderStatus,paymentStatus:locked.paymentStatus,attemptStatus:'awaiting_reconciliation'};
   }
   const settled=await reconcilePrepaidOrder(client,{
    provider:locked.provider,
    orderNumber:locked.orderNumber,
    amountVnd:queryResult.amountVnd,
    successful:true,
    providerTransactionId:queryResult.providerTransactionId,
    responseCode:String(queryResult.resultCode),
    finance:finance||require('./finance-api'),
    audit,
    actor:actor||{username:locked.provider,source:'gateway_reconciliation'}
   });
   await client.query(
    `UPDATE payment_attempts
     SET last_error_code=NULL, last_reconciled_at=now(), reconciliation_attempts=reconciliation_attempts+1
     WHERE id=$1`,
    [locked.attemptId]
   );
   await audit(client,{
    actor:actor||{username:locked.provider,source:'gateway_reconciliation'},
    action:'payment.reconciliation.settled_paid',
    entityType:'order',
    entityId:locked.orderId,
    before:{attemptStatus:locked.attemptStatus,orderStatus:locked.orderStatus,paymentStatus:locked.paymentStatus},
    after:{attemptStatus:'paid',orderStatus:settled.orderStatus,paymentStatus:'paid'},
    metadata:{provider:locked.provider,orderNumber:locked.orderNumber,providerRequestId:locked.providerRequestId,providerTransactionId:queryResult.providerTransactionId}
   });
   return {matched:true,verified:true,action:'settled_paid',orderId:locked.orderId,orderNumber:locked.orderNumber,orderStatus:settled.orderStatus,paymentStatus:'paid',attemptStatus:'paid'};
  }

  if(queryResult.found&&!queryResult.successful){
   const { PaymentAttemptStateMachine: sm } = require('./domain/payments/order-idempotency-policy');
   sm.assertValidTransition(locked.attemptStatus, 'awaiting_reconciliation');
   await client.query(
    `UPDATE payment_attempts
     SET status='awaiting_reconciliation', response_code=$2, last_reconciled_at=now(),
         reconciliation_attempts=reconciliation_attempts+1, updated_at=now()
     WHERE id=$1`,
    [locked.attemptId,String(queryResult.resultCode??'')]
   );
   await audit(client,{
    actor:actor||{username:locked.provider,source:'gateway_reconciliation'},
    action:'payment.reconciliation.still_pending',
    entityType:'order',
    entityId:locked.orderId,
    before:{attemptStatus:locked.attemptStatus,orderStatus:locked.orderStatus,paymentStatus:locked.paymentStatus},
    after:{attemptStatus:'awaiting_reconciliation',orderStatus:locked.orderStatus,paymentStatus:locked.paymentStatus},
    metadata:{provider:locked.provider,orderNumber:locked.orderNumber,gatewayResultCode:queryResult.resultCode}
   });
   return {matched:true,verified:true,action:'still_pending',orderId:locked.orderId,orderNumber:locked.orderNumber,orderStatus:locked.orderStatus,paymentStatus:locked.paymentStatus,attemptStatus:'awaiting_reconciliation',resultCode:queryResult.resultCode};
  }

  // queryResult.reachable === true && queryResult.found === false -> Verified 100% unpaid at gateway
  if(!cancelOnUnpaid){
   await client.query(
    `UPDATE payment_attempts
     SET response_code=$2, last_reconciled_at=now(), reconciliation_attempts=reconciliation_attempts+1, updated_at=now()
     WHERE id=$1`,
    [locked.attemptId,String(queryResult.resultCode??'')]
   );
   await audit(client,{
    actor:actor||{username:'system',source:'gateway_reconciliation'},
    action:'payment.reconciliation.verified_unpaid_for_retry',
    entityType:'order',
    entityId:locked.orderId,
    before:{attemptStatus:locked.attemptStatus,orderStatus:locked.orderStatus,paymentStatus:locked.paymentStatus},
    after:{attemptStatus:locked.attemptStatus,orderStatus:locked.orderStatus,paymentStatus:locked.paymentStatus},
    metadata:{provider:locked.provider,orderNumber:locked.orderNumber,providerRequestId:locked.providerRequestId,gatewayResultCode:queryResult.resultCode}
   });
   return {matched:true,verified:true,action:'verified_unpaid',orderId:locked.orderId,orderNumber:locked.orderNumber,orderStatus:locked.orderStatus,paymentStatus:locked.paymentStatus,attemptStatus:locked.attemptStatus,resultCode:queryResult.resultCode};
  }

  const { PaymentAttemptStateMachine: sm2 } = require('./domain/payments/order-idempotency-policy');
  sm2.assertValidTransition(locked.attemptStatus, 'failed');
  await client.query(
   `UPDATE payment_attempts
    SET status='failed', response_code=$2, last_error_code=NULL, last_reconciled_at=now(),
        reconciliation_attempts=reconciliation_attempts+1, updated_at=now()
    WHERE id=$1`,
   [locked.attemptId,String(queryResult.resultCode??'')]
  );
  let nextStatus=locked.orderStatus;
  if(locked.orderStatus!=='cancelled'&&locked.orderStatus!=='completed'){
   if(locked.voucherCode){
    await client.query('UPDATE voucher_redemptions SET released=true WHERE order_id=$1 AND released=false',[locked.orderId]);
   }
   const inv=inventory||require('./inventory');
   await inv.releaseOrderStock(client,{orderId:locked.orderId,actor:actor||{username:'system',source:'gateway_reconciliation'}});
   await client.query("UPDATE orders SET status='cancelled', updated_at=now() WHERE id=$1",[locked.orderId]);
   await client.query("UPDATE order_email_outbox SET status='skipped', finished_at=now(), result='Đơn hủy sau khi xác minh chưa thanh toán' WHERE order_id=$1 AND status='pending'",[locked.orderId]);
   nextStatus='cancelled';
  }
  await audit(client,{
   actor:actor||{username:'system',source:'gateway_reconciliation'},
   action:'payment.reconciliation.cancelled_unpaid',
   entityType:'order',
   entityId:locked.orderId,
   before:{attemptStatus:locked.attemptStatus,orderStatus:locked.orderStatus,paymentStatus:locked.paymentStatus},
   after:{attemptStatus:'failed',orderStatus:nextStatus,paymentStatus:locked.paymentStatus},
   metadata:{provider:locked.provider,orderNumber:locked.orderNumber,providerRequestId:locked.providerRequestId,gatewayResultCode:queryResult.resultCode}
  });
  return {matched:true,verified:true,action:'cancelled_unpaid',orderId:locked.orderId,orderNumber:locked.orderNumber,orderStatus:nextStatus,paymentStatus:locked.paymentStatus,attemptStatus:'failed',resultCode:queryResult.resultCode};
 });
}

const { PaymentRetryCoordinator } = require('./domain/payments/payment-retry-coordinator');

async function retryGatewayOrderPayment(pool, options = {}) {
  return await PaymentRetryCoordinator.coordinateRetry(pool, options);
}

async function reconcileUnknownGatewayAttempts(pool,config={},{limit=20,fetcher=null,inventory=null,finance=null,audit=appendAudit}={}){
 const candidates=(await pool.query(
  `SELECT order_id AS "orderId", provider
   FROM payment_attempts
   WHERE provider IN ('momo','zalopay')
     AND status IN ('payment_initiation_unknown','awaiting_reconciliation')
   ORDER BY updated_at ASC
   LIMIT $1`,
  [limit]
 )).rows;
 const results=[];
 for(const row of candidates){
  try{
   const res=await reconcileGatewayOrder(pool,{
    orderId:row.orderId,
    provider:row.provider,
    config,
    fetcher,
    inventory,
    finance,
    audit,
    actor:{username:'reconciliation-worker',source:'system'}
   });
   results.push(res);
  }catch(err){
   results.push({orderId:row.orderId,error:err.message});
  }
 }
 return results;
}

function startPaymentReconciliationWorker(pool,config={},{intervalMs=60*1000,onError=e=>console.error('Payment reconciliation worker error:',e.message)}={}){
 let running=false,stopped=false;
 async function run(){
  if(running||stopped)return;
  running=true;
  try{
   const { PaymentService } = require('./domain/payments/payment-service');
   if (typeof PaymentService?.scanOverdueUnknownAttempts === 'function') {
    await PaymentService.scanOverdueUnknownAttempts(pool, config);
   } else {
    await reconcileUnknownGatewayAttempts(pool,config);
   }
  }
  catch(e){onError(e);}
  finally{running=false;}
 }
 const timer=setInterval(run,intervalMs);
 timer.unref?.();
 return ()=>{stopped=true;clearInterval(timer);};
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
    if(payload.enabled&&id==='9pay')throw fail('9Pay chưa sẵn sàng nhận thanh toán.',409);
     await assertPaymentConfigurationChange(c,id,current.data,{...current.data,enabled:payload.enabled});
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
 router.post('/owner/payments/query-reconcile',requireCsrf,rateLimit({windowMs:900000,limit:30,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{
  try{
   const parsed=z.object({
    orderNumber:z.string().trim().min(5).max(80),
    provider:z.enum(['momo','zalopay']).optional(),
    cancelOnUnpaid:z.boolean().optional()
   }).parse({
    ...req.body,
    orderNumber:extractOrderNumber(req.body?.orderNumber)
   });
   if(config?.accountSecurity){
    await config.accountSecurity.authorize(req,async()=>true);
   }
   const outcome=await reconcileGatewayOrder(pool,{
    orderNumber:parsed.orderNumber,
    provider:parsed.provider||null,
    config,
    fetcher:fetcher||config?.paymentFetcher,
    finance,
    actor:req.admin,
    cancelOnUnpaid:parsed.cancelOnUnpaid!==false
   });
   res.json(outcome);
  }catch(e){
   if(e instanceof z.ZodError)return res.status(400).json({error:'Nhập đúng mã đơn hàng cần truy vấn đối soát cổng thanh toán.'});
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
 availability,
 recordGatewayEvidence,
 assertPaymentConfigurationChange,
 extractOrderNumber,
 verifyGatewayPayload,
 reconcilePrepaidOrder,
 reconcileGatewayOrder,
 retryGatewayOrderPayment,
 PaymentRetryCoordinator,
 reconcileUnknownGatewayAttempts,
 startPaymentReconciliationWorker,
 verifyPaymentChannel,
 verifyAndRecordPayment,
 listPaymentChannels,
 createPaymentAdmin
};
