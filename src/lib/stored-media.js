'use strict';
const {createHash}=require('node:crypto');
const {checkKey}=require('./media-keys');
const local=require('./filesystem-media');
const {decompressBufferAsync}=require('../shopping-chat-compression');
const PREFIX=Buffer.from('GAERU_FS_V1:');
// Read-only compatibility for old database references. Their bytes must already
// exist in MEDIA_ROOT; these formats never initiate a remote storage request.
const OLD_V2=Buffer.from('GAERU_S3_V2:'),OLD_V1=Buffer.from('GAERU_S3_V1:');
const imageCache=require('./object-cache').createObjectCache({maxBytes:process.arch==='arm64'?24*1024*1024:128*1024*1024});
const sha=b=>createHash('sha256').update(b).digest('hex');
function metadata(content){
 if(content==null)return null;
 const b=Buffer.from(content),prefix=b.subarray(0,PREFIX.length).equals(PREFIX)?PREFIX:OLD_V2;
 if(!b.subarray(0,prefix.length).equals(prefix))return null;
 let m;try{m=JSON.parse(b.subarray(prefix.length).toString('utf8'));}catch{throw Error('Invalid media metadata');}
 checkKey(m?.key);const maxBytes=m.key.startsWith('chat/')||m.key.startsWith('care/')?Number.MAX_SAFE_INTEGER:25*1024*1024;
 if(!Number.isSafeInteger(m.size)||m.size<1||m.size>maxBytes||!/^[0-9a-f]{64}$/.test(m.sha256))throw Error('Invalid media metadata');
 return m;
}
function pointerFromStats(key,size,sha256){checkKey(key);return Buffer.concat([PREFIX,Buffer.from(JSON.stringify({key,size,sha256}))]);}
function pointer(key,buffer){return pointerFromStats(key,buffer.length,sha(buffer));}
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
 if(!m&&!legacy)return await decompressBufferAsync(b);
 const key=m?m.key:b.subarray(OLD_V1.length).toString('utf8');checkKey(key);
 const load=async()=>{
  let data;try{data=await local.readAsset(key);}catch(error){if(error.code==='ENOENT'||!local.configured())throw Object.assign(Error('Bản sao tệp cục bộ chưa sẵn sàng.'),{status:503,code:'MEDIA_LOCAL_COPY_MISSING'});throw error;}
  if(m&&(data.length!==m.size||sha(data)!==m.sha256))throw Error('Storage media integrity mismatch');
  return await decompressBufferAsync(data);
 };
 const cacheable=process.env.MEDIA_CACHE_ENABLED!=='false'&&/^(products|news|banners)\//.test(key)&&(process.env.NODE_ENV==='production'||process.env.MEDIA_CACHE_ENABLED==='true');
 return cacheable?imageCache.get(sha(b),load):load();
}
async function readMediaRange(content,rangeHeader){
 const b=Buffer.from(content),m=metadata(b),legacy=b.subarray(0,OLD_V1.length).equals(OLD_V1);
 if((m||legacy)&&local.configured()){
  const key=m?m.key:b.subarray(OLD_V1.length).toString('utf8');checkKey(key);
  let slice;try{slice=await local.readAssetRange(key,rangeHeader);}catch(error){if(error.code==='ENOENT'||!local.configured())throw Object.assign(Error('Bản sao tệp cục bộ chưa sẵn sàng.'),{status:503,code:'MEDIA_LOCAL_COPY_MISSING'});throw error;}
  if(!slice.compressed){
   if(m&&slice.totalSize!==m.size)throw Error('Storage media integrity mismatch');
   return slice;
  }
 }
 const full=await readMedia(content),match=/^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader||''));let start,end;
 if(match&&(match[1]||match[2])){start=match[1]?Number(match[1]):Math.max(0,full.length-Number(match[2]));end=match[1]?(match[2]?Number(match[2]):full.length-1):full.length-1;}
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=full.length)return {totalSize:full.length,invalidRange:true};
 end=Math.min(end,full.length-1);
 return {totalSize:full.length,start,end,buffer:full.subarray(start,end+1)};
}
async function openMediaStream(content,rangeHeader=null){
 const b=Buffer.from(content),m=metadata(b),legacy=b.subarray(0,OLD_V1.length).equals(OLD_V1);
 if((m||legacy)&&local.configured()){
  const key=m?m.key:b.subarray(OLD_V1.length).toString('utf8');checkKey(key);
  let s;try{s=await local.openAssetStream(key,rangeHeader);}catch(error){if(error.code==='ENOENT'||!local.configured())throw Object.assign(Error('Bản sao tệp cục bộ chưa sẵn sàng.'),{status:503,code:'MEDIA_LOCAL_COPY_MISSING'});throw error;}
  if(!s.compressed&&m&&s.totalSize!==m.size){s.stream?.destroy?.();throw Error('Storage media integrity mismatch');}
  return s;
 }
 return null;
}
async function storeStagedMedia(scope,stageId,mime,expectedSize){
 const maxUploadBytes=require('../audit-fixes/upload-state').MAX_FILE_BYTES;
 if(!['chat','care'].includes(scope)||!Number.isSafeInteger(expectedSize)||expectedSize<1||expectedSize>maxUploadBytes)throw Object.assign(Error('Upload is too large.'),{status:413});
 if(!local.configured())throw Object.assign(Error('Chưa cấu hình nơi lưu tệp cục bộ.'),{status:503,code:'MEDIA_STORAGE_UNAVAILABLE'});
 let finalized;
 try{finalized=await local.finalizeStageAsset(scope,stageId,mime,expectedSize);}
 catch(e){if(e?.message==='MEDIA_STAGE_SIZE_MISMATCH')throw e;throw Object.assign(Error('Chưa lưu được tệp vào kho lưu trữ. Vui lòng thử lại.'),{status:503,code:'MEDIA_STORAGE_UNAVAILABLE'});}
 return {content:pointerFromStats(finalized.key,finalized.size,finalized.sha256),mimeType:mime,byteSize:finalized.size,key:finalized.key,rollback:finalized.rollback,finish:finalized.finish};
}
async function removeUploadedMedia(content){
 if(!content||!local.configured())return false;
 try{const meta=metadata(content);if(!meta?.key)return false;await require('./file-library-storage').remove(meta.key);return true;}catch{return false;}
}
async function storeUpload(scope,buffer,mime,pool=null,{removeBackground=scope==='products',optimizedResult=null,...backgroundOptions}={}){
 const originalBuffer=buffer;
 const maxUploadBytes=scope==='chat'||scope==='care'?require('../audit-fixes/upload-state').MAX_FILE_BYTES:(({products:8,banners:5,news:5,videos:25})[scope]??10)*1024*1024;
 if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>maxUploadBytes)throw Object.assign(Error('Upload is too large.'),{status:413});
 let mimeType=mime,backgroundRemoved=false;
 if(optimizedResult&&Buffer.isBuffer(optimizedResult.buffer)){
   buffer=optimizedResult.buffer;
   mimeType=optimizedResult.mimeType||mime;
   backgroundRemoved=Boolean(optimizedResult.backgroundRemoved);
 }else if(scope!=='chat'&&scope!=='care'&&mime.startsWith('image/')&&mime!=='image/gif'){
   try{const optimized=await require('./image-optimizer').optimizeImage(buffer,mime,{maxUploadBytes,removeBackground,...backgroundOptions});buffer=optimized.buffer;mimeType=optimized.mimeType;backgroundRemoved=Boolean(optimized.backgroundRemoved);}catch(e){if(scope!=='chat'&&scope!=='care')throw e;}
 }
 const content=await storeMedia(scope,buffer,mimeType),meta=metadata(content);
 if(meta&&mime.startsWith('image/')&&scope!=='chat'&&scope!=='care'){
  try{await require('./image-originals').preserveOriginal(pool,{scope,buffer:originalBuffer,mime,derivativeKey:meta.key});}
  catch(err){await removeUploadedMedia(content).catch(()=>{});throw err;}
 }
 if(mimeType&&mimeType.startsWith('image/')&&(scope==='products'||scope==='news'||scope==='banners')){
  try{require('./image-renditions').enqueueImageWarm({content,mime_type:mimeType},buffer);}catch(_){}
 }
 return {content,mimeType,byteSize:buffer.length,backgroundRemoved,thumbBuffer:buffer.thumbBuffer};
}
async function migrateLegacyBlobsToDisk(pool){
 if(!pool||typeof pool.query!=='function')return {migrated:0,purgedOrphanNewsImages:0};
 let migrated=0,purgedOrphanNewsImages=0;
 try{
  const orphanDel=await pool.query("DELETE FROM news_images n WHERE n.created_at < now() - interval '24 hours' AND NOT EXISTS (SELECT 1 FROM news_posts p WHERE p.cover_id=n.id) RETURNING content");
  purgedOrphanNewsImages=Number(orphanDel.rowCount||0);
  for(const orphan of orphanDel.rows||[]){
   await removeUploadedMedia(orphan.content).catch(()=>{});
  }
 }catch(_){}
 if(!local.configured())return {migrated,purgedOrphanNewsImages};
 const targets=[
  {table:'news_images',scope:'news'},
  {table:'catalog_images',scope:'products'}
 ];
 for(const {table,scope} of targets){
  try{
   const rows=(await pool.query(`SELECT id,content,mime_type FROM ${table} WHERE octet_length(content)>256 AND position(convert_to('GAERU_','UTF8') in content)<>1 LIMIT 50`)).rows;
   for(const row of rows){
    const rawBuf=await decompressBufferAsync(Buffer.from(row.content));
    const ptr=await storeMedia(scope,rawBuf,row.mime_type||'image/webp');
    await pool.query(`UPDATE ${table} SET content=$2 WHERE id=$1`,[row.id,ptr]);
    migrated++;
   }
  }catch(_){}
 }
 return {migrated,purgedOrphanNewsImages};
}
module.exports={storeMedia,storeUpload,storeStagedMedia,removeUploadedMedia,readMedia,readMediaRange,openMediaStream,metadata,pointer,PREFIX,migrateLegacyBlobsToDisk};
