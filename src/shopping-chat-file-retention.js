'use strict';
const {withTransaction}=require('./db');
const {appendAudit}=require('./audit');
const disk=require('./lib/file-library-storage');
const TABLES=['catalog_images','news_images','marketing_banner_images','catalog_videos','shopping_chat_files'];
const RETENTION_DAYS=30;
const fail=(message,status=400)=>Object.assign(Error(message),{status});
function storageKey(content){
 if(!content)return null;
 const value=Buffer.from(content),prefix=value.subarray(0,12).toString('utf8');let key;
 if(prefix==='GAERU_FS_V1:'||prefix==='GAERU_S3_V2:')key=JSON.parse(value.subarray(12).toString('utf8')).key;
 else if(prefix==='GAERU_S3_V1:')key=value.subarray(12).toString('utf8');else return null;
 disk.checkKey(key);return key;
}
async function liveReferences(client,key){
 if((await client.query('SELECT storage_key FROM media_library_files WHERE storage_key=$1',[key])).rows.length)return true;
 if((await client.query('SELECT storage_key FROM site_asset_snapshots WHERE storage_key=$1',[key])).rows.length)return true;
 for(const table of TABLES){
  const rows=(await client.query('SELECT content FROM '+table+' WHERE content IS NOT NULL AND octet_length(content)<=2048')).rows;
  for(const row of rows)if(storageKey(row.content)===key)return true;
 }
 return false;
}
async function queueCleanup(client,content){
 let key;try{key=storageKey(content);}catch{return;}if(!key||!key.startsWith('chat/'))return;
 await client.query('INSERT INTO shopping_chat_file_cleanup(storage_key) VALUES($1) ON CONFLICT(storage_key) DO UPDATE SET next_attempt_at=now()',[key]);
}
async function removeAttachment(client,row,reason,actor){
 if(row.deleted_at)return false;
 await queueCleanup(client,row.content);
 await client.query('UPDATE shopping_chat_files SET content=NULL,deleted_at=now(),deletion_reason=$2 WHERE id=$1 AND deleted_at IS NULL',[row.id,reason]);
 await client.query('UPDATE shopping_chat_threads SET version=version+1,updated_at=now() WHERE id=$1',[row.thread_id]);
 await appendAudit(client,{actor,action:'shopping.chat.file.delete',entityType:'shopping_chat_file',entityId:row.id,metadata:{threadId:row.thread_id,reason}});
 return true;
}
async function cleanupDeletedChatFiles(pool,{limit=50}={}){
 if(!require('./lib/filesystem-media').configured())return {removed:0,preserved:0,pending:true};
 let removed=0,preserved=0;
 for(let index=0;index<Math.min(100,limit);index++){
  const didWork=await withTransaction(pool,async client=>{
   await client.query("SELECT pg_advisory_xact_lock(hashtext('shopping-chat-storage'))");
   const job=(await client.query('SELECT storage_key FROM shopping_chat_file_cleanup WHERE next_attempt_at<=now() ORDER BY created_at,storage_key LIMIT 1 FOR UPDATE SKIP LOCKED')).rows[0];
   if(!job)return false;
   try{
    const key=disk.checkKey(job.storage_key);if(!key.startsWith('chat/'))throw Error('CHAT_SCOPE_REQUIRED');
    if(await liveReferences(client,key)){preserved++;await client.query('DELETE FROM shopping_chat_file_cleanup WHERE storage_key=$1',[key]);return true;}
    // The logical deletion already committed. A failed unlink remains in this
    // durable queue; ENOENT retries complete safely after a process interruption.
    try{await disk.remove(key);}catch(error){if(error.code!=='ENOENT')throw error;}
    await client.query('DELETE FROM media_filesystem_objects WHERE target_key=$1',[key]);
    await client.query('DELETE FROM shopping_chat_file_cleanup WHERE storage_key=$1',[key]);removed++;return true;
   }catch(error){
    const code=/^[A-Z0-9_]{1,50}$/.test(String(error.code||''))?error.code:'FILE_DELETE_FAILED';
    await client.query("UPDATE shopping_chat_file_cleanup SET attempts=attempts+1,last_error=$2,next_attempt_at=now()+interval '1 hour' WHERE storage_key=$1",[job.storage_key,code]);return true;
   }
  });
  if(!didWork)break;
 }
 return {removed,preserved};
}
async function cleanupUnreferencedChatMedia(pool,content){
 await withTransaction(pool,async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtext('shopping-chat-storage'))");await queueCleanup(client,content);});
 return cleanupDeletedChatFiles(pool);
}
async function deleteChatFile(pool,{id,threadId=null,actor,confirm=false}){
 if(confirm!==true)throw fail('Xác nhận xóa tệp hội thoại. Tệp đã xóa không thể khôi phục.');
 const changed=await withTransaction(pool,async client=>{
  await client.query("SELECT pg_advisory_xact_lock(hashtext('shopping-chat-storage'))");
  const row=(await client.query('SELECT * FROM shopping_chat_files WHERE id=$1'+(threadId?' AND thread_id=$2':'')+' FOR UPDATE',threadId?[id,threadId]:[id])).rows[0];
  if(!row)throw fail('Không tìm thấy tệp hội thoại.',404);
  return removeAttachment(client,row,'admin',actor);
 });
 const cleanup=await cleanupDeletedChatFiles(pool);return {changed,...cleanup};
}
async function deleteChatFilesByKey(pool,{key,actor,confirm=false}){
 disk.checkKey(key);if(!key.startsWith('chat/'))throw fail('Chỉ xóa tệp hội thoại tại đây.',403);
 if(confirm!==true)throw fail('Xác nhận xóa tệp hội thoại. Tệp đã xóa không thể khôi phục.');
 let changed=0;
 await withTransaction(pool,async client=>{
  await client.query("SELECT pg_advisory_xact_lock(hashtext('shopping-chat-storage'))");
  const rows=(await client.query('SELECT * FROM shopping_chat_files WHERE deleted_at IS NULL AND content IS NOT NULL AND octet_length(content)<=2048 FOR UPDATE')).rows;
  for(const row of rows)if(storageKey(row.content)===key)changed+=Number(await removeAttachment(client,row,'admin',actor));
  // Orphaned copies of conversation uploads can also be removed by an admin.
  if(!changed)await appendAudit(client,{actor,action:'shopping.chat.file.delete',entityType:'media_file',entityId:key,metadata:{orphan:true}});
  await client.query('INSERT INTO shopping_chat_file_cleanup(storage_key) VALUES($1) ON CONFLICT(storage_key) DO UPDATE SET next_attempt_at=now()',[key]);
 });
 return {changed,...await cleanupDeletedChatFiles(pool)};
}
async function processChatFileRetention(pool,{limit=100,orphans=true}={}){
 let expired=0;
 await withTransaction(pool,async client=>{
  await client.query("SELECT pg_advisory_xact_lock(hashtext('shopping-chat-storage'))");
  const rows=(await client.query("SELECT * FROM shopping_chat_files WHERE deleted_at IS NULL AND created_at<=now()-interval '30 days' ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED",[Math.min(1000,Math.max(1,limit))])).rows;
  for(const row of rows)expired+=Number(await removeAttachment(client,row,'retention',{username:'chat-retention',source:'system'}));
 });
 if(orphans&&require('./lib/filesystem-media').configured()){
  try{
   const cutoff=Date.now()-RETENTION_DAYS*86400000;
   const files=(await disk.list()).filter(file=>file.scope==='chat'&&new Date(file.modifiedAt).getTime()<=cutoff).slice(0,limit);
   for(const file of files)await pool.query('INSERT INTO shopping_chat_file_cleanup(storage_key) VALUES($1) ON CONFLICT DO NOTHING',[file.key]);
  }catch{console.warn('Chat orphan inventory unavailable; attachment cleanup continues.');}
 }
 return {expired,...await cleanupDeletedChatFiles(pool,{limit})};
}
function startChatFileRetentionWorker(pool){
 let stopped=false,running=false;
 async function tick(){if(stopped||running)return;running=true;try{await processChatFileRetention(pool);}catch(error){console.error('Chat file retention unavailable:',/^[A-Z0-9_]{1,50}$/.test(String(error.code||''))?error.code:'RETENTION_FAILED');}finally{running=false;}}
 const timer=setInterval(tick,60*60*1000);timer.unref?.();void tick();
 return ()=>{stopped=true;clearInterval(timer);};
}
module.exports={RETENTION_DAYS,storageKey,liveReferences,cleanupDeletedChatFiles,cleanupUnreferencedChatMedia,deleteChatFile,deleteChatFilesByKey,processChatFileRetention,startChatFileRetentionWorker};
