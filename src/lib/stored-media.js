'use strict';
const {createHash}=require('node:crypto');
const {checkKey}=require('./media-keys');
const local=require('./filesystem-media');
const {decompressBuffer}=require('../shopping-chat-compression');
const PREFIX=Buffer.from('GAERU_FS_V1:');
// Read-only compatibility for old database references. Their bytes must already
// exist in MEDIA_ROOT; these formats never initiate a remote storage request.
const OLD_V2=Buffer.from('GAERU_S3_V2:'),OLD_V1=Buffer.from('GAERU_S3_V1:');
const imageCache=require('./object-cache').createObjectCache();
const sha=b=>createHash('sha256').update(b).digest('hex');
function metadata(content){
 if(content==null)return null;
 const b=Buffer.from(content),prefix=b.subarray(0,PREFIX.length).equals(PREFIX)?PREFIX:OLD_V2;
 if(!b.subarray(0,prefix.length).equals(prefix))return null;
 let m;try{m=JSON.parse(b.subarray(prefix.length).toString('utf8'));}catch{throw Error('Invalid media metadata');}
 checkKey(m?.key);const maxBytes=m.key.startsWith('chat/')?Number.MAX_SAFE_INTEGER:25*1024*1024;
 if(!Number.isSafeInteger(m.size)||m.size<1||m.size>maxBytes||!/^[0-9a-f]{64}$/.test(m.sha256))throw Error('Invalid media metadata');
 return m;
}
function pointer(key,buffer){checkKey(key);return Buffer.concat([PREFIX,Buffer.from(JSON.stringify({key,size:buffer.length,sha256:sha(buffer)}))]);}
async function storeMedia(scope,buffer,mime){
 if(!local.configured()){
  if(process.env.NODE_ENV!=='production')return Buffer.from(buffer);
  throw Object.assign(Error('Chưa cấu hình nơi lưu tệp cục bộ.'),{status:503,code:'MEDIA_STORAGE_UNAVAILABLE'});
 }
 try{const {key}=await local.uploadAsset(scope,buffer,mime);return pointer(key,buffer);}
 catch{throw Object.assign(Error('Chưa lưu được tệp vào kho lưu trữ. Vui lòng thử lại.'),{status:503,code:'MEDIA_STORAGE_UNAVAILABLE'});}
}
async function readMedia(content){
 const b=Buffer.from(content),m=metadata(b),legacy=b.subarray(0,OLD_V1.length).equals(OLD_V1);
 if(!m&&!legacy)return decompressBuffer(b);
 const key=m?m.key:b.subarray(OLD_V1.length).toString('utf8');checkKey(key);
 const load=async()=>{
  let data;try{data=await local.readAsset(key);}catch(error){if(error.code==='ENOENT'||!local.configured())throw Object.assign(Error('Bản sao tệp cục bộ chưa sẵn sàng.'),{status:503,code:'MEDIA_LOCAL_COPY_MISSING'});throw error;}
  if(m&&(data.length!==m.size||sha(data)!==m.sha256))throw Error('Storage media integrity mismatch');
  return decompressBuffer(data);
 };
 const cacheable=process.env.MEDIA_CACHE_ENABLED!=='false'&&/^(products|news|banners)\//.test(key)&&(process.env.NODE_ENV==='production'||process.env.MEDIA_CACHE_ENABLED==='true');
 return cacheable?imageCache.get(sha(b),load):load();
}
async function storeUpload(scope,buffer,mime){
 const maxUploadBytes=scope==='chat'?require('../audit-fixes/upload-state').MAX_FILE_BYTES:({products:8,banners:5,news:5,videos:25})[scope]*1024*1024;
 if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>maxUploadBytes)throw Object.assign(Error('Upload is too large.'),{status:413});
 let mimeType=mime;if(mime.startsWith('image/')&&mime!=='image/gif')try{const optimized=await require('./image-optimizer').optimizeImage(buffer,mime,{maxUploadBytes});buffer=optimized.buffer;mimeType=optimized.mimeType;}catch(e){if(scope!=='chat')throw e;}
 return {content:await storeMedia(scope,buffer,mimeType),mimeType,byteSize:buffer.length};
}
module.exports={storeMedia,storeUpload,readMedia,metadata,pointer,PREFIX};
