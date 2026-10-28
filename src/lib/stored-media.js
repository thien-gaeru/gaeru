'use strict';
const {createHash}=require('node:crypto');
const storage=require('./neon-storage');
const local=require('./filesystem-media');
const {decompressBuffer}=require('../shopping-chat-compression');
const FILE_PREFIX=Buffer.from('GAERU_FS_V1:');
const imageCache=require('./object-cache').createObjectCache();
const PREFIX=Buffer.from('GAERU_S3_V2:');
const LEGACY=Buffer.from('GAERU_S3_V1:');
const sha=b=>createHash('sha256').update(b).digest('hex');
function metadata(content){
 const b=Buffer.from(content);const prefix=b.subarray(0,FILE_PREFIX.length).equals(FILE_PREFIX)?FILE_PREFIX:PREFIX;if(!b.subarray(0,prefix.length).equals(prefix))return null;
 let m;try{m=JSON.parse(b.subarray(prefix.length).toString('utf8'));}catch{throw Error('Invalid media metadata');}
 storage.checkKey(m?.key);const maxBytes=String(m?.key||'').startsWith('chat/')?Number.MAX_SAFE_INTEGER:25*1024*1024;if(!Number.isSafeInteger(m.size)||m.size<1||m.size>maxBytes||!/^[0-9a-f]{64}$/.test(m.sha256))throw Error('Invalid media metadata');return m;
}
function pointer(key,buffer){storage.checkKey(key);return Buffer.concat([PREFIX,Buffer.from(JSON.stringify({key,size:buffer.length,sha256:sha(buffer)}))]);}
function enabled(){if(process.env.NODE_ENV==='production'){if(process.env.NEON_STORAGE_UPLOADS_ENABLED==='false')throw Object.assign(Error('Kho tệp chưa được bật. Chưa lưu tệp.'),{status:503,code:'MEDIA_STORAGE_UNAVAILABLE'});return true;}return process.env.NEON_STORAGE_UPLOADS_ENABLED==='true';}
async function storeMedia(scope,buffer,mime){if(!local.configured()&&!enabled())return Buffer.from(buffer);try{const {key}=await (local.configured()?local:storage).uploadAsset(scope,buffer,mime);return local.configured()?Buffer.concat([FILE_PREFIX,Buffer.from(JSON.stringify({key,size:buffer.length,sha256:sha(buffer)}))]):pointer(key,buffer);}catch{throw Object.assign(Error('Chưa lưu được tệp vào kho lưu trữ. Vui lòng thử lại.'),{status:503,code:'MEDIA_STORAGE_UNAVAILABLE'});}}
async function readMedia(content){const b=Buffer.from(content),m=metadata(b);const legacy=b.subarray(0,LEGACY.length).equals(LEGACY);if(!m&&!legacy)return decompressBuffer(b);const key=m?m.key:b.subarray(LEGACY.length).toString('utf8');storage.checkKey(key);const load=async()=>{const data=await (b.subarray(0,FILE_PREFIX.length).equals(FILE_PREFIX)?local.readAsset(key):storage.downloadProductImage(key));if(m&&(data.length!==m.size||sha(data)!==m.sha256))throw Error('Storage media integrity mismatch');return decompressBuffer(data);};const cacheable=process.env.MEDIA_CACHE_ENABLED!=='false'&&/^(products|news|banners)\//.test(key)&&(process.env.NODE_ENV==='production'||process.env.MEDIA_CACHE_ENABLED==='true');return cacheable?imageCache.get(sha(b),load):load();}
async function storeUpload(scope,buffer,mime){const maxUploadBytes=scope==='chat'?require('../audit-fixes/upload-state').MAX_FILE_BYTES:({products:8,banners:5,news:5,videos:25})[scope]*1024*1024;if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>maxUploadBytes)throw Object.assign(Error('Upload is too large.'),{status:413});let mimeType=mime;if(mime.startsWith('image/')&&mime!=='image/gif'){try{const optimized=await require('./image-optimizer').optimizeImage(buffer,mime,{maxUploadBytes});buffer=optimized.buffer;mimeType=optimized.mimeType;}catch(e){if(scope!=='chat')throw e;}}return {content:await storeMedia(scope,buffer,mimeType),mimeType,byteSize:buffer.length};}
module.exports={storeMedia,storeUpload,readMedia,metadata,pointer,PREFIX};
