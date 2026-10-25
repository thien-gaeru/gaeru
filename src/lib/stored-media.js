'use strict';
const {createHash}=require('node:crypto');
const storage=require('./neon-storage');
const PREFIX=Buffer.from('GAERU_S3_V2:');
const LEGACY=Buffer.from('GAERU_S3_V1:');
const sha=b=>createHash('sha256').update(b).digest('hex');
function metadata(content){
 const b=Buffer.from(content);if(!b.subarray(0,PREFIX.length).equals(PREFIX))return null;
 let m;try{m=JSON.parse(b.subarray(PREFIX.length).toString('utf8'));}catch{throw Error('Invalid media metadata');}
 storage.checkKey(m?.key);if(!Number.isSafeInteger(m.size)||m.size<1||m.size>25*1024*1024||!/^[0-9a-f]{64}$/.test(m.sha256))throw Error('Invalid media metadata');return m;
}
function pointer(key,buffer){storage.checkKey(key);return Buffer.concat([PREFIX,Buffer.from(JSON.stringify({key,size:buffer.length,sha256:sha(buffer)}))]);}
function enabled(){if(process.env.NODE_ENV==='production'){if(process.env.NEON_STORAGE_UPLOADS_ENABLED==='false')throw Object.assign(Error('Kho tệp chưa được bật. Chưa lưu tệp.'),{status:503,code:'MEDIA_STORAGE_UNAVAILABLE'});return true;}return process.env.NEON_STORAGE_UPLOADS_ENABLED==='true';}
async function storeMedia(scope,buffer,mime){if(!enabled())return Buffer.from(buffer);try{const {key}=await storage.uploadAsset(scope,buffer,mime);return pointer(key,buffer);}catch{throw Object.assign(Error('Chưa lưu được tệp vào kho lưu trữ. Vui lòng thử lại.'),{status:503,code:'MEDIA_STORAGE_UNAVAILABLE'});}}
async function readMedia(content){const b=Buffer.from(content),m=metadata(b);if(m){const data=await storage.downloadProductImage(m.key);if(data.length!==m.size||sha(data)!==m.sha256)throw Error('Storage media integrity mismatch');return data;}if(b.subarray(0,LEGACY.length).equals(LEGACY))return storage.downloadProductImage(b.subarray(LEGACY.length).toString('utf8'));return b;}
module.exports={storeMedia,readMedia,metadata,pointer,PREFIX};
