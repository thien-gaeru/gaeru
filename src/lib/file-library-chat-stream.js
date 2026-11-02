'use strict';
const {createHash}=require('node:crypto');
const {createGunzip}=require('node:zlib');
const {Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const disk=require('./file-library-storage');
const {metadata}=require('./stored-media');
const PREFIX=Buffer.from('GAERU_ZLIB_V1:');
// Chat's accepted size is independent of the library upload limit. Stream it
// instead of loading another complete copy into the server heap.
async function serveChatFile(pool,req,res,key,cleanName){
 const chat=(await pool.query(`SELECT name,mime,content,original_name,original_mime,original_content FROM shopping_chat_files
   WHERE deleted_at IS NULL AND (CASE WHEN substring(content from 1 for 12)=convert_to('GAERU_FS_V1:','UTF8') THEN convert_from(substring(content from 13),'UTF8')::jsonb->>'key' END=$1
     OR CASE WHEN substring(original_content from 1 for 12)=convert_to('GAERU_FS_V1:','UTF8') THEN convert_from(substring(original_content from 13),'UTF8')::jsonb->>'key' END=$1) LIMIT 1`,[key])).rows[0];
 const original=chat&&metadata(chat.original_content)?.key===key;
 const pointer=chat?metadata(original?chat.original_content:chat.content):null;
 const registered=!chat?(await pool.query('SELECT name,mime_type,byte_size,sha256 FROM media_library_files WHERE storage_key=$1',[key])).rows[0]:null;
 const limit=require('../audit-fixes/upload-state').MAX_FILE_BYTES;
 const {handle,stat}=await disk.openRead(key,limit);
 try{
  const expected=pointer?{size:pointer.size,sha:pointer.sha256}:registered?{size:Number(registered.byte_size),sha:registered.sha256}:null;
  if(expected){const hash=createHash('sha256');for await(const chunk of handle.createReadStream({start:0,autoClose:false}))hash.update(chunk);if(stat.size!==expected.size||hash.digest('hex')!==expected.sha)throw disk.fail('Tệp không khớp bản đã lưu. Dừng tải để kiểm tra.',409);}
  const peek=Buffer.alloc(2048),{bytesRead}=await handle.read(peek,0,peek.length,0);
  let offset=0,decoded=null;
  if(peek.subarray(0,PREFIX.length).equals(PREFIX)){
   const newline=peek.indexOf(10,PREFIX.length);if(newline<0||newline>=bytesRead)throw disk.fail('Tệp nén không hợp lệ.',409);
   try{decoded=JSON.parse(peek.subarray(PREFIX.length,newline).toString('utf8'));}catch{throw disk.fail('Tệp nén không hợp lệ.',409);}
   if(decoded.alg!=='gzip'||!Number.isSafeInteger(decoded.rawSize)||decoded.rawSize<1||decoded.rawSize>limit||!/^[a-f0-9]{64}$/.test(decoded.sha256))throw disk.fail('Tệp nén không hợp lệ.',409);
   offset=newline+1;
  }
  const name=cleanName(original?chat.original_name||chat.name:chat?.name||registered?.name||key.split('/').at(-1));
  const fallback={jpg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',txt:'text/plain',csv:'text/csv',pdf:'application/pdf'};
  const mime=(original?chat.original_mime||chat.mime:chat?.mime||registered?.mime_type)||fallback[key.split('.').at(-1)]||'application/octet-stream';
  const inline=req.query.preview==='1'&&/^(image\/(jpeg|png|webp)|video\/(mp4|webm|quicktime))$/.test(mime);
  res.type(mime).set({'Content-Disposition':(inline?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(name),'Content-Security-Policy':"default-src 'none'; sandbox"});
  if(!decoded){
   let start=0,end=stat.size-1;res.set('Accept-Ranges','bytes');
   if(inline&&req.get('range')){const match=/^bytes=(\d*)-(\d*)$/.exec(req.get('range'));if(!match||!match[1]&&!match[2])return res.status(416).set('Content-Range','bytes */'+stat.size).end();start=match[1]?Number(match[1]):Math.max(0,stat.size-Number(match[2]));end=match[1]&&match[2]?Number(match[2]):stat.size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=stat.size)return res.status(416).set('Content-Range','bytes */'+stat.size).end();end=Math.min(end,stat.size-1);res.status(206).set('Content-Range',`bytes ${start}-${end}/${stat.size}`);}
   res.set('Content-Length',String(end-start+1));await pipeline(handle.createReadStream({start,end,autoClose:false}),res);
  }else{
   let count=0;const hash=createHash('sha256');
   const verify=new Transform({transform(chunk,_encoding,done){count+=chunk.length;if(count>decoded.rawSize)return done(disk.fail('Tệp nén vượt giới hạn.',409));hash.update(chunk);done(null,chunk);},flush(done){done(count===decoded.rawSize&&hash.digest('hex')===decoded.sha256?null:disk.fail('Tệp nén không khớp bản gốc.',409));}});
   res.set('Content-Length',String(decoded.rawSize));await pipeline(handle.createReadStream({start:offset,autoClose:false}),createGunzip(),verify,res);
  }
 }finally{await handle.close();}
}
module.exports={serveChatFile};
