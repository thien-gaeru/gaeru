'use strict';
const {createHash}=require('node:crypto');
const channels=Object.freeze(['shopee','tiktok','lazada']);
const fail=(m,status=409)=>Object.assign(new Error(m),{status});
function fingerprint(channel,data){return createHash('sha256').update(JSON.stringify([channel,data.partnerId||data.appKey||'',data.shopId||data.sellerId||'',data.shopCipher||'',data.secret||'',data.accessToken||'',data.tokenExpiresAt||null])).digest('hex');}
function credentials(channel,data={}){
 if(!channels.includes(channel))throw fail('Sàn chưa được hỗ trợ.',400);
 if(!data.secret||!data.accessToken)throw fail('Lưu khóa ứng dụng và Access Token đã được sàn cấp quyền trước khi đồng bộ.');
 if(data.tokenExpiresAt&&(!Number.isFinite(Date.parse(data.tokenExpiresAt))||Date.parse(data.tokenExpiresAt)<=Date.now()))throw fail('Access Token đã hết hạn. Cập nhật token mới trong cấu hình và kiểm tra lại.');
 const shop=channel==='lazada'?data.sellerId:data.shopId;
 if(!shop||(channel==='shopee'&&!data.partnerId)||(channel!=='shopee'&&!data.appKey)||(channel==='tiktok'&&!data.shopCipher))throw fail('Thiếu mã ứng dụng, gian hàng hoặc Shop Cipher. Kiểm tra cấu hình sàn.');
 return {...data,shopId:String(shop),shopCipher:data.shopCipher||''};
}
function connection(channel,record={}){
 const data=record.data||{};let ready=true,reason='';try{credentials(channel,data);}catch(e){ready=false;reason=e.message;}
 const verified=ready&&data.verificationFingerprint===fingerprint(channel,data)&&Boolean(data.connectionVerifiedAt);
 return {channel,configured:Boolean(record.version),tokenConfigured:Boolean(data.accessToken),shopId:data.shopId||data.sellerId||'',shopCipher:data.shopCipher||'',tokenExpiresAt:data.tokenExpiresAt||null,verified,verifiedAt:verified?data.connectionVerifiedAt:null,message:verified?'Đã xác minh quyền đọc đơn hàng.':reason||'Chưa xác minh quyền đọc với cấu hình hiện tại.'};
}
function transportCredentials(channel,data){const c=credentials(channel,data);return channel==='shopee'?{partnerId:c.partnerId,partnerKey:c.secret,accessToken:c.accessToken,shopId:c.shopId}:channel==='tiktok'?{appKey:c.appKey,appSecret:c.secret,accessToken:c.accessToken,shopCipher:c.shopCipher}:{appKey:c.appKey,appSecret:c.secret,accessToken:c.accessToken};}
module.exports={channels,fingerprint,credentials,connection,transportCredentials};
