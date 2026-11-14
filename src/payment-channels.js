'use strict';
const {Router}=require('express');
const {randomUUID,createHmac,createHash,timingSafeEqual}=require('node:crypto');
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

function safeTokenEqual(left,right){
 const a=Buffer.from(String(left||'').trim(),'utf8');
 const b=Buffer.from(String(right||'').trim(),'utf8');
 return a.length>0&&a.length===b.length&&timingSafeEqual(a,b);
}

function defaultChannelData(id){
 if(id==='cod')return {enabled:true,maxAmountVnd:50000000,instructions:'Thanh toán tiền mặt trực tiếp cho bưu tá khi nhận hàng.'};
 if(id==='bank_transfer')return {bankName:'',accountNumber:'',accountHolder:'',branch:'',transferSyntax:'GAERU {MA_DON}',webhookSecret:'',enabled:false};
 if(id==='vnpay')return {tmnCode:'',environment:'sandbox',enabled:false};
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

const VIETQR_BANKS = {
 vcb: { bin: '970436', code: 'VCB', shortName: 'Vietcombank' },
 vietcombank: { bin: '970436', code: 'VCB', shortName: 'Vietcombank' },
 mb: { bin: '970422', code: 'MB', shortName: 'MBBank' },
 mbbank: { bin: '970422', code: 'MB', shortName: 'MBBank' },
 tcb: { bin: '970407', code: 'TCB', shortName: 'Techcombank' },
 techcombank: { bin: '970407', code: 'TCB', shortName: 'Techcombank' },
 ctg: { bin: '970415', code: 'ICB', shortName: 'VietinBank' },
 icb: { bin: '970415', code: 'ICB', shortName: 'VietinBank' },
 vietinbank: { bin: '970415', code: 'ICB', shortName: 'VietinBank' },
 bidv: { bin: '970418', code: 'BIDV', shortName: 'BIDV' },
 acb: { bin: '970416', code: 'ACB', shortName: 'ACB' },
 vpb: { bin: '970432', code: 'VPB', shortName: 'VPBank' },
 vpbank: { bin: '970432', code: 'VPB', shortName: 'VPBank' },
 tpb: { bin: '970423', code: 'TPB', shortName: 'TPBank' },
 tpbank: { bin: '970423', code: 'TPB', shortName: 'TPBank' },
 vba: { bin: '970405', code: 'VBA', shortName: 'Agribank' },
 agribank: { bin: '970405', code: 'VBA', shortName: 'Agribank' },
 vib: { bin: '970441', code: 'VIB', shortName: 'VIB' },
 stb: { bin: '970403', code: 'STB', shortName: 'Sacombank' },
 sacombank: { bin: '970403', code: 'STB', shortName: 'Sacombank' },
 hdb: { bin: '970437', code: 'HDB', shortName: 'HDBank' },
 hdbank: { bin: '970437', code: 'HDB', shortName: 'HDBank' },
 msb: { bin: '970426', code: 'MSB', shortName: 'MSB' },
 ocb: { bin: '970448', code: 'OCB', shortName: 'OCB' },
 shb: { bin: '970443', code: 'SHB', shortName: 'SHB' },
 seab: { bin: '970440', code: 'SEAB', shortName: 'SeABank' },
 seabank: { bin: '970440', code: 'SEAB', shortName: 'SeABank' },
 lpb: { bin: '970449', code: 'LPB', shortName: 'LPBank' },
 lpbank: { bin: '970449', code: 'LPB', shortName: 'LPBank' }
};

function resolveVietQrBank(input) {
 const raw = String(input || '').trim().toLowerCase().replace(/[\s_.-]/g, '');
 if (!raw) return null;
 if (VIETQR_BANKS[raw]) return VIETQR_BANKS[raw];
 for (const [k, v] of Object.entries(VIETQR_BANKS)) {
  if (raw.includes(k) || k.includes(raw) || raw === v.bin) return v;
 }
 if (/^\d{6}$/.test(raw)) return { bin: raw, code: raw, shortName: input };
 return { bin: input, code: input, shortName: input };
}

function formatBankTransferInstructions(settings,{orderNumber,amountVnd}={}){
 const syntax=String(settings?.transferSyntax||'GAERU {MA_DON}').trim();
 const transferContent=orderNumber?syntax.replace(/\{MA_DON\}/g,orderNumber):syntax;
 const bankName=String(settings?.bankName||'').trim();
 const accountNumber=String(settings?.accountNumber||'').trim();
 const accountHolder=String(settings?.accountHolder||'').trim();
 const branch=String(settings?.branch||'').trim();
 const bankInfo=resolveVietQrBank(settings?.bankId||bankName);
 const qrBankId=bankInfo?.bin||bankInfo?.code||bankName;
 const template=String(settings?.qrTemplate||'compact2').trim();
 
 let qrUrl=null;
 if(qrBankId&&accountNumber){
  const params=new URLSearchParams();
  if(amountVnd!==undefined)params.set('amount',String(amountVnd));
  if(transferContent)params.set('addInfo',transferContent);
  if(accountHolder)params.set('accountName',accountHolder);
  qrUrl=`https://img.vietqr.io/image/${encodeURIComponent(qrBankId)}-${encodeURIComponent(accountNumber)}-${template}.png?${params.toString()}`;
 }

 return {
  bankName,
  bankId:bankInfo?.code||settings?.bankId||null,
  bankBin:bankInfo?.bin||null,
  accountNumber,
  accountHolder,
  branch,
  transferSyntax:syntax,
  transferContent,
  qrUrl,
  autoReconcile:Boolean(settings?.webhookSecret&&String(settings.webhookSecret).trim().length>=8),
  ...(amountVnd!==undefined?{amountVnd:Number(amountVnd)}:{})
 };
}

function signMomoMessage(secretKey,raw){return createHmac('sha256',secretKey).update(raw,'utf8').digest('hex');}

function extractOrderNumber(input){
 const text=String(input||'').trim();
 if(!text)return '';
 const withDashes=text.match(/GR-\d{8}-[A-Z0-9]{4,20}/i);
 if(withDashes)return withDashes[0].toUpperCase();
 if(/^\d{6}_GR-/i.test(text))return text.slice(7).toUpperCase();
 const noDashes=text.match(/GR(\d{8})([A-Z0-9]{4,20})/i);
 if(noDashes){
  return `GR-${noDashes[1]}-${noDashes[2]}`.toUpperCase();
 }
 const spaceSeparated=text.match(/GR\s*(\d{8})\s*([A-Z0-9]{4,20})/i);
 if(spaceSeparated){
  return `GR-${spaceSeparated[1]}-${spaceSeparated[2]}`.toUpperCase();
 }
 return text;
}

function verifyGatewayPayload(provider,payload,settings,options={}){
 if(!settings)return {valid:false,reason:'Provider not configured'};
 if(!payload||typeof payload!=='object'||Array.isArray(payload))return {valid:false,reason:'Invalid callback payload'};
 const scalar=value=>(typeof value==='string'||typeof value==='number')&&!(typeof value==='number'&&!Number.isSafeInteger(value));
 const unsigned=value=>scalar(value)&&/^(?:0|[1-9]\d{0,19})$/.test(String(value));
 const amount=value=>unsigned(value)&&Number.isSafeInteger(Number(value))&&Number(value)>0&&Number(value)<=2000000000;
 const positiveId=value=>unsigned(value)&&String(value)!=='0';
 const orderPattern=/^GR-\d{8}-[A-Z0-9]{4,20}$/;
 if(provider==='momo'){
  const textFields=['partnerCode','orderId','orderInfo','orderType','payType','message','extraData'];
  if(typeof payload.requestId!=='string'||payload.requestId.length<1||payload.requestId.length>100
   ||textFields.some(field=>typeof payload[field]!=='string'||payload[field].length>4000)
   ||!orderPattern.test(payload.orderId)
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
   const configuredSecret=String(settings?.webhookSecret||settings?.secureToken||settings?.apiKey||process.env.BANK_WEBHOOK_SECRET||'').trim();
   if(!configuredSecret){
    return {valid:false,reason:'Automatic bank reconciliation is disabled until a verified provider adapter is configured. Use owner-authorized reconciliation.'};
   }
   const headers=options.headers||{};
   const header=name=>typeof headers[name]==='string'?headers[name]:'';
   const rawTimestamp=(
    header('x-webhook-timestamp')||
    header('x-timestamp')||
    header('x-payos-timestamp')||
    header('x-casso-timestamp')||
    header('x-vietqr-timestamp')
   ).trim();
   if(rawTimestamp){
    let tsMs=Number(rawTimestamp);
    if(Number.isFinite(tsMs)){
     if(tsMs<1e12)tsMs*=1000;
    }else{
     tsMs=Date.parse(rawTimestamp);
    }
    const skewMs=Date.now()-tsMs;
    if(!Number.isFinite(tsMs)||skewMs>5*60*1000||skewMs<-60*1000){
     return {valid:false,reason:'Expired or invalid bank webhook timestamp'};
    }
   }
   const incomingToken=(
    header('x-payos-token')||
    header('x-vietqr-token')||
    header('secure-token')||
    header('x-api-key')||
    header('x-casso-token')||
    header('x-webhook-secret')||
    header('x-seapay-token')||
    header('authorization').replace(/^(?:Bearer|Apikey)\s+/i,'')||
    ''
   ).trim();
   const incomingSignature=header('x-signature').trim();
   const hasRawBody=Buffer.isBuffer(options.rawBody)||(typeof options.rawBody==='string'&&options.rawBody.length>0);
   const rawPayload=hasRawBody?options.rawBody:(typeof payload==='object'?JSON.stringify(payload):String(payload));
   const computeHmac=()=>createHmac('sha256',configuredSecret).update(rawPayload,hasRawBody?undefined:'utf8').digest('hex');
   let tokenValid=false;
   if(incomingToken&&incomingSignature){
    tokenValid=safeTokenEqual(incomingToken,configuredSecret)&&safeHexEqual(incomingSignature,computeHmac());
   }else if(incomingToken){
    tokenValid=safeTokenEqual(incomingToken,configuredSecret);
   }else if(incomingSignature){
    tokenValid=safeHexEqual(incomingSignature,computeHmac());
   }
   if(!tokenValid){
    return {valid:false,reason:'Invalid or missing bank transfer webhook credentials'};
   }
   let transactions=[];
   if(Array.isArray(payload.data))transactions=payload.data;
   else if(payload.data&&typeof payload.data==='object')transactions=[payload.data];
   else if(Array.isArray(payload.transactions))transactions=payload.transactions;
   else if(typeof payload==='object'&&payload!==null)transactions=[payload];
   if(!transactions.length){
    return {valid:false,reason:'No bank transaction found in webhook payload'};
   }
   const matchedTransactions=[];
   for(const txn of transactions){
    if(!txn||typeof txn!=='object')continue;
    if(txn.transferType==='out'||txn.transfer_type==='out')continue;
    let orderNumber='';
    const searchTexts=[
     txn.description,txn.content,txn.transferContent,txn.transfer_content,
     txn.orderNumber,txn.order_number,txn.orderId,txn.order_id,txn.notes,txn.comment,txn.code
    ].filter(Boolean).map(String);
    for(const text of searchTexts){
     const extracted=extractOrderNumber(text);
     if(orderPattern.test(extracted)){
      orderNumber=extracted;
      break;
     }
    }
    if(!orderNumber)continue;
    const rawAmount=txn.amount??txn.amountVnd??txn.transferAmount??txn.transfer_amount;
    const numAmount=Number(rawAmount);
    if(!Number.isSafeInteger(numAmount)||numAmount<=0||numAmount>2000000000){
     if(transactions.length===1){
      return {valid:false,reason:'Invalid transaction amount'};
     }
     continue;
    }
    const deterministicSeed=JSON.stringify([
     orderNumber,
     numAmount,
     txn.when||txn.transactionDate||txn.transactionDateTime||txn.createdAt||'',
     txn.description||txn.content||txn.transferContent||txn.transfer_content||'',
     txn.accountNumber||txn.account_number||''
    ]);
    const fallbackTxnId='BANK_'+createHash('sha256').update(deterministicSeed).digest('hex').slice(0,24);
    const txnId=txn.tid||txn.id||txn.reference||txn.reference_number||txn.referenceNumber||txn.transactionId||txn.ref||fallbackTxnId;
    matchedTransactions.push({
     orderNumber,
     amountVnd:numAmount,
     successful:true,
     providerTransactionId:String(txnId),
     responseCode:'00'
    });
   }
   if(!matchedTransactions.length){
    return {valid:false,reason:'No matching GAERU order number found in transaction content'};
   }
   const primary=matchedTransactions[0];
   return {
    valid:true,
    orderNumber:primary.orderNumber,
    amountVnd:primary.amountVnd,
    successful:true,
    providerTransactionId:primary.providerTransactionId,
    responseCode:'00',
    matchedTransactions
   };
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
     o.total_vnd AS "totalVnd", o.payment_status AS "paymentStatus",
     o.return_completed_at AS "returnCompletedAt"
    FROM payment_attempts p JOIN orders o ON o.id = p.order_id
    WHERE (p.transaction_ref = $1 OR replace(p.transaction_ref, '-', '') = replace($1, '-', '')) AND p.provider = $2
    FOR UPDATE OF p, o`,
   [orderNumber,provider]
  );
  let attempt=attemptQuery.rows[0];
  if(!attempt&&actor?.role!=='owner'&&provider!=='bank_transfer')return {code:'01',matched:false,message:'Order not found'};
  if(!attempt){
   const orderQuery=await client.query(
    `SELECT id AS "orderId", order_number AS "orderNumber", status AS "orderStatus",
      payment_method AS "paymentMethod", subtotal_vnd AS "subtotalVnd",
      shipping_fee_vnd AS "shippingFeeVnd", discount_vnd AS "discountVnd",
      total_vnd AS "totalVnd", payment_status AS "paymentStatus",
      return_completed_at AS "returnCompletedAt"
     FROM orders WHERE (order_number = $1 OR replace(order_number, '-', '') = replace($1, '-', '')) FOR UPDATE`,
    [orderNumber]
   );
   const order=orderQuery.rows[0];
   if(!order||order.paymentMethod!==provider)return {code:'01',matched:false,message:'Order not found'};
   if(actor?.role==='owner'&&(order.orderStatus==='cancelled'||order.returnCompletedAt)){
    return {code:'09',matched:false,message:'Không thể đối soát thủ công cho đơn hàng đã hủy hoặc đã hoàn trả.'};
   }
   const insertedAttempt=await client.query(
    `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '15 minutes')
     ON CONFLICT (transaction_ref) DO UPDATE SET updated_at = now()
     RETURNING id, amount_vnd AS "amountVnd", status AS "attemptStatus"`,
    [order.orderId,provider,orderNumber,order.totalVnd]
   );
   attempt={...order,...insertedAttempt.rows[0]};
  }
  if(actor?.role==='owner'&&(attempt.orderStatus==='cancelled'||attempt.returnCompletedAt)){
   return {code:'09',matched:false,message:'Không thể đối soát thủ công cho đơn hàng đã hủy hoặc đã hoàn trả.'};
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
   if(attempt.orderStatus==='cancelled'){
    await client.query(
     "INSERT INTO order_reviews (order_id, reason) VALUES ($1, 'late_payment_on_cancelled_order') ON CONFLICT (order_id) DO UPDATE SET reason = 'late_payment_on_cancelled_order', resolved_at = NULL, updated_at = now()",
     [attempt.orderId]
    );
   }else if(!nextOrderStatus||['pending','confirmed'].includes(nextOrderStatus)){
    nextOrderStatus='processing';
   }
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
    autoApprovedToProcessing:Boolean(successful&&['pending','confirmed'].includes(attempt.orderStatus))
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

async function assertPaymentConfigurationChange(client,id,before,after){
 if(!['vnpay','momo','zalopay'].includes(id))return;
 await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[id==='vnpay'?'gaeru:vnpay-config':'gaeru:payment-config:'+id]);
 const fields={vnpay:['tmnCode','hashSecret','environment'],momo:['partnerCode','accessKey','secretKey','environment'],zalopay:['appId','key1','key2','environment']}[id];
 if(fields.every(k=>before[k]===after[k]))return;
 const count=(await client.query("SELECT count(*)::int AS count FROM payment_attempts p JOIN orders o ON o.id=p.order_id WHERE p.provider=$1 AND p.status='pending' AND o.status<>'cancelled' AND o.payment_status<>'paid' AND o.return_completed_at IS NULL",[id])).rows[0]?.count||0;
 if(count)throw fail('Có giao dịch đang chờ. Đối soát hoặc hủy đơn trước khi đổi tài khoản, khóa hoặc môi trường thanh toán.',409);
}
function authenticatedProof(method,scope){
 return method==='signed_callback'?scope==='callback_signature':['authenticated_api','provider_order_create'].includes(method)&&scope==='api_credentials';
}
function availability(id,record,vnpayConfig,config={}){
 const supported=true;
 const configured=isChannelConfigured(id,record,vnpayConfig);
 const sandboxOnProduction=config.NODE_ENV==='production'&&(record.data.environment==='sandbox'||(id==='vnpay'&&String(vnpayConfig?.paymentUrl||'').includes('sandbox.')));
 const canEnable=supported&&configured&&!sandboxOnProduction;
 const enabled=supported&&isChannelEnabled(id,record,vnpayConfig);
 return {supported,canEnable,enabled,checkoutReady:enabled&&canEnable,unsupportedReason:sandboxOnProduction?'Dùng cấu hình chính thức trên website đang hoạt động.':!configured?'Lưu đủ thông tin cấu hình trước khi bật.':null};
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
  else if(isChannelConfigured(id,record,null))callbackConfigs[id]=record.data;
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
  const autoReconcile=Boolean(settings.webhookSecret&&String(settings.webhookSecret).trim().length>=8);
  return {...base,configured:true,reachable:null,method:'configuration_validation',webhookConfigured:autoReconcile,message:'Thông tin chuyển khoản đúng định dạng.'+(autoReconcile?' Đã cấu hình Webhook đối soát tự động.':'')+' Chưa xác minh quyền sở hữu tài khoản; chủ doanh nghiệp đối soát giao dịch trước khi ghi nhận đã thu tiền.'};
 }
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
 const channelEnum=z.enum(['cod','bank_transfer','vnpay','momo','zalopay']);
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
     await assertPaymentConfigurationChange(c,id,current.data,{...current.data,enabled:payload.enabled});
     if(payload.enabled&&id!=='cod'&&current.version===0)throw fail('Lưu thông tin kết nối kênh thanh toán trước khi bật.');
    if(['vnpay','momo','zalopay'].includes(id)&&payload.enabled&&config.NODE_ENV==='production'&&current.data.environment==='sandbox'){
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
    provider:z.enum(['bank_transfer','vnpay','momo','zalopay']),
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
    if(!outcome.matched)throw fail(outcome.code==='09'?outcome.message:outcome.code==='04'?'Số tiền giao dịch không khớp với tổng tiền đơn hàng.':'Không tìm thấy đơn hàng chờ thanh toán tương ứng.',409);
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
 availability,
 recordGatewayEvidence,
 assertPaymentConfigurationChange,
 extractOrderNumber,
 verifyGatewayPayload,
 reconcilePrepaidOrder,
 verifyPaymentChannel,
 verifyAndRecordPayment,
 listPaymentChannels,
 createPaymentAdmin
};
