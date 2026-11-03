'use strict';
const {createHash}=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path'),{constants}=require('node:fs');
const disk=require('./lib/filesystem-media'),media=require('./lib/stored-media');
const {checkKey}=require('./lib/media-keys'),{withTransaction}=require('./db');
const TABLES=Object.freeze(['catalog_images','news_images','marketing_banner_images','catalog_videos','shopping_chat_files','care_message_files']);
const oldWhere="(substring(content from 1 for 12)=convert_to('GAERU_S3_V2:','UTF8') OR substring(content from 1 for 12)=convert_to('GAERU_S3_V1:','UTF8'))";
const sha=b=>createHash('sha256').update(b).digest('hex');
let last={state:'pending',message:'Chưa kiểm tra tệp cục bộ.'};
function auditStatus(){return last;}
// The recovery audit must include retained originals, unpublished media and library
// trash. Read bounded chunks: chat/CARE attachments may exceed the image limits.
async function verifyFile(target,key,size,expectedHash,{library=false}={}){
 (library?require('./lib/file-library-storage').checkKey:checkKey)(key);
 if(!Number.isSafeInteger(size)||size<1||!/^[a-f0-9]{64}$/.test(expectedHash||''))throw Error('MEDIA_INTEGRITY_METADATA');
 if(target!==disk){const bytes=await target.readAsset(key);if(bytes.length!==size||sha(bytes)!==expectedHash)throw Error('MEDIA_INTEGRITY_MISMATCH');return;}
 let directory=await disk.rootPath();const parts=key.split('/');
 for(const part of parts.slice(0,-1)){directory=path.join(directory,part);const st=await fs.lstat(directory);if(!st.isDirectory()||st.isSymbolicLink()||await fs.realpath(directory)!==directory)throw Error('MEDIA_DIRECTORY_INVALID');}
 const file=path.join(directory,parts.at(-1)),before=await fs.lstat(file);if(!before.isFile()||before.isSymbolicLink())throw Error('MEDIA_FILE_INVALID');
 const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{const st=await handle.stat();if(!st.isFile()||st.size!==size)throw Error('MEDIA_INTEGRITY_MISMATCH');const digest=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))digest.update(chunk);if(digest.digest('hex')!==expectedHash)throw Error('MEDIA_INTEGRITY_MISMATCH');}finally{await handle.close();}
}
async function localizeCopiedMedia(pool,{target=disk,publishStatus=true}={}){
 const publish=result=>{if(publishStatus)last=result;return result;};
 const result={state:'verified',converted:0,failedChecks:0,message:'Các tham chiếu tệp đã dùng thư mục cục bộ.'};
 if(!target.configured())return publish({...result,state:'not-configured',message:'Chưa cấu hình thư mục tệp cục bộ.'});
 for(const table of TABLES){
  let cursor='00000000-0000-0000-0000-000000000000';
  for(;;){
   const rows=(await pool.query('SELECT id,content FROM '+table+' WHERE id>$1 AND '+oldWhere+' ORDER BY id LIMIT 20',[cursor])).rows;
   if(!rows.length)break;
   for(const row of rows){cursor=row.id;const original=Buffer.from(row.content);
    try{
     const m=media.metadata(original),key=m?m.key:original.subarray(12).toString('utf8');checkKey(key);
     const manifest=(await pool.query('SELECT target_key,byte_size,sha256 FROM media_filesystem_objects WHERE source_key=$1',[key])).rows[0];
     const destination=manifest?.target_key||key;checkKey(destination);
     const bytes=await target.readAsset(destination),expected=m||(manifest?{size:Number(manifest.byte_size),sha256:manifest.sha256}:null);
     if(!expected||bytes.length!==expected.size||sha(bytes)!==expected.sha256)throw Error('MEDIA_LOCAL_INTEGRITY');
     if(manifest&&(Number(manifest.byte_size)!==bytes.length||manifest.sha256!==sha(bytes)))throw Error('MEDIA_LOCAL_INTEGRITY');
     const replacement=media.pointer(destination,bytes);
     const converted=await withTransaction(pool,async client=>{
      const current=(await client.query('SELECT content FROM '+table+' WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      if(!current?.content||!Buffer.from(current.content).equals(original))return false;
      await client.query('INSERT INTO media_filesystem_reference_backups(table_name,row_id,previous_content,replacement_content) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[table,row.id,original,replacement]);
      await client.query('UPDATE '+table+' SET content=$2 WHERE id=$1',[row.id,replacement]);return true;
     });
     if(converted)result.converted++;
    }catch{result.failedChecks++;}
   }
  }
 }
 if(result.failedChecks){result.state='needs_review';result.message='Một số tệp cũ chưa xác minh được bản sao cục bộ; giữ nguyên tham chiếu để đối chiếu.';}
 return publish(result);
}
async function auditMediaStorage(pool,{target=disk,probeStatus}={}){
 const result={state:'verified',manifestFiles:0,filesystemReferences:0,protectedReferences:0,legacyReferences:0,inlineRecords:0,failedChecks:0,checkedAt:new Date().toISOString(),tables:{},protectedTables:{}};
 if(!target.configured())return last={...result,state:'not-configured',message:'Chưa cấu hình thư mục tệp cục bộ.'};
 if(probeStatus?.verified===false)return last={...result,state:'unavailable',failedChecks:1,inventory:null,message:'Kho tệp cục bộ chưa sẵn sàng; chưa thay đổi hoặc kiểm tra tham chiếu tệp.'};
 let cursor='';for(;;){const rows=(await pool.query('SELECT source_key,target_key,byte_size,sha256 FROM media_filesystem_objects WHERE source_key>$1 ORDER BY source_key LIMIT 100',[cursor])).rows;if(!rows.length)break;
  for(const row of rows){cursor=row.source_key;try{await verifyFile(target,row.target_key,Number(row.byte_size),row.sha256);result.manifestFiles++;}catch{result.failedChecks++;}}
 }
 for(const table of TABLES){const counts={filesystem:0,legacy:0,inline:0,failed:0};let id='00000000-0000-0000-0000-000000000000';
  for(;;){const rows=(await pool.query("SELECT id,CASE WHEN octet_length(content)<=2048 THEN content ELSE decode('','hex') END AS content FROM "+table+' WHERE id>$1 AND content IS NOT NULL ORDER BY id LIMIT 20',[id])).rows;if(!rows.length)break;
   for(const row of rows){id=row.id;const b=Buffer.from(row.content),prefix=b.subarray(0,12).toString();
    if(prefix==='GAERU_FS_V1:'){counts.filesystem++;try{const m=media.metadata(b);await verifyFile(target,m.key,m.size,m.sha256);}catch{counts.failed++;}}
    else if(prefix.startsWith('GAERU_S3_V'))counts.legacy++;else counts.inline++;
   }
  }
  result.tables[table]=counts;result.filesystemReferences+=counts.filesystem;result.legacyReferences+=counts.legacy;result.inlineRecords+=counts.inline;result.failedChecks+=counts.failed;
 }
 const protectedQueries=[
  ['media_upload_originals','id',"SELECT id,original_key AS storage_key,original_size AS byte_size,original_sha256 AS sha256 FROM media_upload_originals WHERE id>$1 ORDER BY id LIMIT 20",false],
  ['media_library_files','storage_key','SELECT storage_key,byte_size,sha256 FROM media_library_files WHERE storage_key>$1 ORDER BY storage_key LIMIT 20',true],
  ['site_asset_snapshots','path','SELECT path,storage_key,byte_size,sha256 FROM site_asset_snapshots WHERE path>$1 ORDER BY path LIMIT 20',true]
 ];
 for(const [table,column,query,library] of protectedQueries){const counts={references:0,failed:0};let cursor=column==='id'?'00000000-0000-0000-0000-000000000000':'';
  for(;;){const rows=(await pool.query(query,[cursor])).rows;if(!rows.length)break;for(const row of rows){cursor=row[column];counts.references++;try{await verifyFile(target,row.storage_key,Number(row.byte_size),row.sha256,{library});}catch{counts.failed++;}}}
  result.protectedTables[table]=counts;result.protectedReferences+=counts.references;result.failedChecks+=counts.failed;
 }
 const originalCounts={references:0,legacy:0,inline:0,failed:0};let originalId='00000000-0000-0000-0000-000000000000';
 for(;;){const rows=(await pool.query("SELECT id,CASE WHEN octet_length(original_content)<=2048 THEN original_content ELSE decode('','hex') END AS content FROM shopping_chat_files WHERE id>$1 AND original_content IS NOT NULL AND deleted_at IS NULL ORDER BY id LIMIT 20",[originalId])).rows;if(!rows.length)break;
  for(const row of rows){originalId=row.id;const b=Buffer.from(row.content),prefix=b.subarray(0,12).toString();if(prefix==='GAERU_FS_V1:'){originalCounts.references++;try{const m=media.metadata(b);await verifyFile(target,m.key,m.size,m.sha256);}catch{originalCounts.failed++;}}else if(prefix.startsWith('GAERU_S3_V'))originalCounts.legacy++;else originalCounts.inline++;}
 }
 result.protectedTables.shopping_chat_originals=originalCounts;result.protectedReferences+=originalCounts.references;result.legacyReferences+=originalCounts.legacy;result.inlineRecords+=originalCounts.inline;result.failedChecks+=originalCounts.failed;
 try{result.inventory=await target.inventory();}catch{result.inventory=null;result.failedChecks++;}
 if(result.failedChecks||result.legacyReferences)result.state='needs_review';
 result.message=result.state==='verified'?'Đã kiểm tra các tham chiếu tệp cục bộ.':'Một số tệp cục bộ cần đối chiếu; không đọc từ dịch vụ lưu trữ bên ngoài.';
 return last=result;
}
async function runLocalMediaAudit(pool,{target=disk}={}){
 last={state:'pending',message:'Đang đối chiếu các tham chiếu tệp cục bộ.'};
 try{
  const localization=await localizeCopiedMedia(pool,{target,publishStatus:false});
  const audit=await auditMediaStorage(pool,{target});
  return {localization,audit};
 }catch(error){
  last={state:'needs_review',failedChecks:1,checkedAt:new Date().toISOString(),message:'Chưa hoàn tất đối chiếu kho tệp cục bộ. Cần kiểm tra lại.'};
  throw error;
 }
}
module.exports={TABLES,localizeCopiedMedia,auditMediaStorage,runLocalMediaAudit,auditStatus};
