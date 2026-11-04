'use strict';
const {createHash}=require('node:crypto');
const local=require('./filesystem-media');
const {checkKey}=require('./media-keys');
async function preserveOriginal(pool,{scope,buffer,mime,derivativeKey}){
 if(!pool||!local.configured())return null; // Test/development inline media has no persistent file key.
 checkKey(derivativeKey);
 if(!Buffer.isBuffer(buffer)||!buffer.length||!['image/jpeg','image/png','image/webp','image/heic'].includes(mime))return null;
 const source=await local.uploadAsset(scope,buffer,mime);
 try{
  await pool.query(`INSERT INTO media_upload_originals(derivative_key,original_key,original_mime,original_size,original_sha256)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(derivative_key) DO NOTHING`,[derivativeKey,source.key,mime,buffer.length,createHash('sha256').update(buffer).digest('hex')]);
 }catch(error){
  // Neither a failed database operation nor an optional optimization deletes source bytes.
  throw Object.assign(Error('Chưa ghi nhận được bản gốc của ảnh. Tệp chưa được xuất bản, vui lòng thử lại.'),{status:503,code:'IMAGE_ORIGINAL_METADATA_FAILED'});
 }
 return source.key;
}
module.exports={preserveOriginal};
