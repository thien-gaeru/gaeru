'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{constants}=require('node:fs'),{createHash,randomUUID}=require('node:crypto');
const disk=require('./lib/file-library-storage'),filesystem=require('./lib/filesystem-media');
const {createObjectCache}=require('./lib/object-cache');
const types={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.ico':'image/x-icon'};
const valid=relative=>typeof relative==='string'&&/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(relative)&&!relative.split('/').some(p=>p==='.'||p==='..')&&Object.hasOwn(types,path.posix.extname(relative).toLowerCase());
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let last={state:'not-configured',files:0};
async function syncAssets(pool,{source=path.join(__dirname,'..','assets')}={}){
 if(!filesystem.configured())return last={state:'not-configured',files:0};
 const dir=await disk.directory('site-assets','',true);let count=0,total=0;
 async function scan(current,prefix=''){
  for(const entry of await fs.readdir(current,{withFileTypes:true})){
   if(entry.isSymbolicLink())throw Error('SITE_ASSET_SYMLINK');
   const relative=prefix+entry.name,location=path.join(current,entry.name);
   if(entry.isDirectory()){await scan(location,relative+'/');continue;}
   if(!entry.isFile()||!valid(relative))continue;
   if(++count>10000)throw Error('SITE_ASSET_LIMIT');
   const stat=await fs.lstat(location);if(!stat.isFile()||stat.size<1||stat.size>25*1024*1024)throw Error('SITE_ASSET_SIZE');
   const handle=await fs.open(location,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let bytes;try{bytes=await handle.readFile();}finally{await handle.close();}
   const sha256=hash(bytes),name=sha256+path.extname(relative).toLowerCase(),key='site-assets/'+name,target=path.join(dir,name);
   let exists=false;try{const actual=await disk.read(key);if(actual.length!==bytes.length||hash(actual)!==sha256)throw Error('SITE_ASSET_INTEGRITY');exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
   if(!exists){const temporary=path.join(dir,'.'+randomUUID()+'.copying'),file=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}try{await fs.link(temporary,target);}catch(e){if(e.code!=='EEXIST')throw e;}finally{await fs.unlink(temporary);}const actual=await disk.read(key);if(actual.length!==bytes.length||hash(actual)!==sha256)throw Error('SITE_ASSET_INTEGRITY');}
   await pool.query(`INSERT INTO site_asset_snapshots(path,storage_key,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(path) DO UPDATE SET storage_key=EXCLUDED.storage_key,mime_type=EXCLUDED.mime_type,byte_size=EXCLUDED.byte_size,sha256=EXCLUDED.sha256,updated_at=now()
    WHERE site_asset_snapshots.sha256<>EXCLUDED.sha256`,[relative,key,types[path.extname(relative).toLowerCase()],bytes.length,sha256]);total+=bytes.length;
  }
 }
 try{await scan(source);return last={state:'verified',files:count,bytes:total};}catch(e){last={state:'failed',files:count};throw e;}
}
function serveAssets(pool){const cache=createObjectCache();return async(req,res,next)=>{
 if(!['GET','HEAD'].includes(req.method)||!filesystem.configured())return next();
 let relative;try{relative=decodeURIComponent(req.path).replace(/^\//,'');}catch{return res.sendStatus(400);}
 if(!valid(relative))return next();
 try{const row=(await pool.query('SELECT * FROM site_asset_snapshots WHERE path=$1',[relative])).rows[0];if(!row)return res.set('Cache-Control','no-store').sendStatus(404);
  const bytes=await cache.get(row.storage_key,async()=>{const value=await disk.read(row.storage_key);if(value.length!==Number(row.byte_size)||hash(value)!==row.sha256)throw Error('SITE_ASSET_INTEGRITY');return value;});
  res.type(row.mime_type).set({'Cache-Control':/-[0-9a-f]{12}\./.test(relative)?'public, max-age=31536000, immutable':'public, max-age=3600, must-revalidate','ETag':'"'+row.sha256+'"','X-GAERU-Asset-Backend':'media-root','X-Content-Type-Options':'nosniff'});if(req.fresh)return res.status(304).end();return res.send(bytes);
 }catch(e){if(e.code==='ENOENT')return res.set('Cache-Control','no-store').status(503).send('Ảnh lưu trữ tạm thời chưa sẵn sàng.');next(e);}
};}
module.exports={syncAssets,serveAssets,valid,status:()=>last};
