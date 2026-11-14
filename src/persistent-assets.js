'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{constants}=require('node:fs'),{createHash,randomUUID}=require('node:crypto');
const sharp=require('sharp');
const disk=require('./lib/file-library-storage'),filesystem=require('./lib/filesystem-media');
const {createObjectCache}=require('./lib/object-cache');
const {qualifiesForSelectiveAvif,encodeAvif,SAVINGS_RATIO}=require('./lib/selective-avif');
const types={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.ico':'image/x-icon','.mp4':'video/mp4'};
const valid=relative=>typeof relative==='string'&&/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(relative)&&!relative.split('/').some(p=>p==='.'||p==='..')&&Object.hasOwn(types,path.posix.extname(relative).toLowerCase());
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const widths=[480,800,1200];
const snapshotCaches=new WeakMap();
const assetCaches=new WeakMap();
let last={state:'not-configured',files:0};
const MAX_SNAPSHOT_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_SINGLE_SNAPSHOT_BYTES = 4 * 1024 * 1024;
function estimateSnapshotRowBytes(row){
 if(!row||typeof row!=='object')return 256;
 let b=256;
 if(Buffer.isBuffer(row.content))b+=row.content.length;
 else if(typeof row.content==='string')b+=Buffer.byteLength(row.content,'utf8');
 if(typeof row.sha256==='string')b+=row.sha256.length;
 if(typeof row.mime_type==='string')b+=row.mime_type.length;
 return b;
}
function clearAssetSnapshotCache(pool){
 if(pool&&typeof pool==='object'){
  const state=snapshotCaches.get(pool);
  if(state){state.rows.clear();state.pending.clear();state.bytes=0;}
 }
}
async function getCachedSnapshotRow(pool,relative,loader){
 if(!pool||process.env.MEDIA_CACHE_ENABLED==='false')return loader();
 let state=snapshotCaches.get(pool);
 if(!state){state={rows:new Map(),pending:new Map(),bytes:0};snapshotCaches.set(pool,state);}
 const now=Date.now(),hit=state.rows.get(relative);
 if(hit&&hit.until>now){state.rows.delete(relative);state.rows.set(relative,hit);return hit.row;}
 if(hit){state.bytes=Math.max(0,state.bytes-(hit.bytes||0));state.rows.delete(relative);}
 if(state.pending.has(relative))return state.pending.get(relative);
 const task=Promise.resolve().then(loader).then(row=>{
  if(row){
   const rowBytes=estimateSnapshotRowBytes(row);
   if(rowBytes<=MAX_SINGLE_SNAPSHOT_BYTES){
    if(state.rows.has(relative)){const prev=state.rows.get(relative);state.bytes=Math.max(0,state.bytes-(prev?.bytes||0));state.rows.delete(relative);}
    while((state.rows.size>=512||state.bytes+rowBytes>MAX_SNAPSHOT_CACHE_BYTES)&&state.rows.size>0){
     const oldestKey=state.rows.keys().next().value;
     const oldest=state.rows.get(oldestKey);
     state.bytes=Math.max(0,state.bytes-(oldest?.bytes||0));
     state.rows.delete(oldestKey);
    }
    state.rows.set(relative,{row,until:Date.now()+600000,bytes:rowBytes});
    state.bytes+=rowBytes;
   }
  }
  return row;
 }).finally(()=>state.pending.delete(relative));
 state.pending.set(relative,task);
 return task;
}
let responsiveMap = null;
function getResponsiveMap() {
  if (!responsiveMap) {
    try { responsiveMap = require('../responsive-images.json'); } catch (_) { responsiveMap = {}; }
  }
  return responsiveMap;
}

// GAERU IMG-03 / A08: In-memory byte-capped LRU cache for pre-generated AVIF (16 MiB max) to prevent unbounded RSS growth
class ByteCappedLruCache {
  constructor(maxBytes = 16 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.currentBytes = 0;
    this.map = new Map();
  }
  get(key) {
    const item = this.map.get(key);
    if (!item) return null;
    this.map.delete(key);
    this.map.set(key, item);
    return item.value;
  }
  has(key) {
    return this.map.has(key);
  }
  set(key, value) {
    const bytes = (value?.buffer?.length || 0) + 128;
    if (bytes > this.maxBytes) return;
    if (this.map.has(key)) {
      this.currentBytes -= this.map.get(key).bytes;
      this.map.delete(key);
    }
    while (this.currentBytes + bytes > this.maxBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      const oldest = this.map.get(oldestKey);
      this.currentBytes -= oldest.bytes;
      this.map.delete(oldestKey);
    }
    this.map.set(key, { value, bytes });
    this.currentBytes += bytes;
  }
  clear() {
    this.map.clear();
    this.currentBytes = 0;
  }
}
const preAvifCache = new ByteCappedLruCache(16 * 1024 * 1024);
const preWebpCache = new ByteCappedLruCache(12 * 1024 * 1024);

async function getPreGeneratedWebp(relative, width = null) {
  if (!width) return null;
  const cacheKey = relative + ':w=' + width;
  if (preWebpCache.has(cacheKey)) {
    return preWebpCache.get(cacheKey);
  }
  let buffer = null;
  const map = getResponsiveMap();
  const variants = map['/assets/' + relative];
  const match = variants?.find(v => v.width === width || v.url.includes('-display-' + width + '-'));
  if (match?.url) {
    try {
      const diskFile = path.join(__dirname, '..', match.url.replace(/^\//, ''));
      buffer = await fs.readFile(diskFile);
    } catch (_) {}
  }
  if (!buffer && relative && relative.endsWith('.webp')) {
    try {
      const directWebp = path.join(__dirname, '..', 'assets', relative.replace(/\.webp$/, '-w' + width + '.webp'));
      buffer = await fs.readFile(directWebp);
    } catch (_) {}
  }
  if (buffer) {
    const entry = {
      buffer,
      etag: '"' + hash(buffer) + '-w' + width + '"'
    };
    preWebpCache.set(cacheKey, entry);
    return entry;
  }
  return null;
}

async function getPreGeneratedAvif(relative, width = null) {
  const cacheKey = relative + (width ? ':w=' + width : '');
  if (preAvifCache.has(cacheKey)) {
    return preAvifCache.get(cacheKey);
  }
  let buffer = null;
  if (width) {
    const map = getResponsiveMap();
    const variants = map['/assets/' + relative];
    const match = variants?.find(v => v.width === width || v.url.includes('-display-' + width + '-'));
    if (match?.avifUrl) {
      try {
        const diskFile = path.join(__dirname, '..', match.avifUrl.replace(/^\//, ''));
        buffer = await fs.readFile(diskFile);
      } catch (_) {}
    }
    if (!buffer && relative && relative.endsWith('.webp')) {
      try {
        const directSizedAvif = path.join(__dirname, '..', 'assets', relative.replace(/\.webp$/, '-w' + width + '.avif'));
        buffer = await fs.readFile(directSizedAvif);
      } catch (_) {}
    }
    if (!buffer) return null;
  } else if (relative && relative.endsWith('.webp')) {
    try {
      const directAvif = path.join(__dirname, '..', 'assets', relative.replace(/\.webp$/, '.avif'));
      buffer = await fs.readFile(directAvif);
    } catch (_) {}
  }
  if (buffer) {
    const entry = {
      buffer,
      etag: '"' + hash(buffer) + (width ? '-w' + width : '') + '-avif"'
    };
    preAvifCache.set(cacheKey, entry);
    return entry;
  }
  return null;
}

async function warmStaticAssets(pool){
 if(!pool||!pool.__gaeruCacheHooked||process.env.MEDIA_CACHE_ENABLED==='false')return;
 const cache=assetCaches.get(pool);
 if(!cache)return;
 const m3Paths=[12,1,2,3,4,6,7,8,10,11,9].map(n=>'products/m3-description/'+n+'.webp');
 const k9Paths=[1,2,3,4,5,6,7,8].map(n=>'products/k9-description/'+n+'.webp');
 const hotSnapshots=[
  'brand/gaeru-logo.webp',
  'products/k9.webp',
  'products/k9-display-480-f7433a67675b.webp',
  'products/k9-display-800-19cce68491be.webp',
  'products/m3-home-cutout.webp',
  'products/m3-home-cutout-display-480-95e9e4d1416c.webp',
  'products/m3-home-cutout-display-800-2d66fc21b488.webp',
  'products/p01.webp',
  'products/p01-display-480-3006d4ac291d.webp',
  'products/p01-display-800-b1693527696c.webp',
  'products/g1-ultra-874bf1d3db77.webp',
  'products/g1-ultra-874bf1d3db77-display-480-19288308445b.webp',
  'products/g1-ultra-874bf1d3db77-display-800-a5a917ef6f29.webp',
  'products/p185-cutout-1cc9dfde9fa3.webp',
  'products/p185-cutout-display-480-0992b5f5e3ed.webp',
  'products/p185-cutout-display-800-5b0e6749a14c.webp'
 ];
 // GAERU F-05: Startup warmup only prefetches existing bytes into RAM cache; no runtime Sharp/AVIF re-encoding at boot.
 if(filesystem.configured()){
  for(const rel of hotSnapshots){
   try{
    const row=await getCachedSnapshotRow(pool,rel,async()=>(await pool.query('SELECT * FROM site_asset_snapshots WHERE path=$1',[rel])).rows[0]);
    if(row){
     await cache.get(row.storage_key,async()=>disk.read(row.storage_key));
    }
    await getPreGeneratedAvif(rel,null);
   }catch{}
  }
 }
 for(const rel of ['products/k9.webp','products/m3-home-cutout.webp','products/p01.webp','products/g1-ultra-874bf1d3db77.webp','products/p185-cutout-1cc9dfde9fa3.webp']){
  try{
   await getPreGeneratedAvif(rel,480);
   await getPreGeneratedAvif(rel,800);
  }catch{}
 }
 for(const rel of [...m3Paths,...k9Paths]){
  try{
   if(filesystem.configured()){
    const row=await getCachedSnapshotRow(pool,rel,async()=>(await pool.query('SELECT * FROM site_asset_snapshots WHERE path=$1',[rel])).rows[0]);
    if(!row)continue;
    await cache.get(row.storage_key,async()=>disk.read(row.storage_key));
   }else{
    const raw=await fs.readFile(path.join(__dirname,'..','assets',rel));
    await cache.get('local:'+rel,()=>raw);
   }
   await getPreGeneratedAvif(rel,null);
   await getPreGeneratedAvif(rel,480);
   await getPreGeneratedAvif(rel,800);
  }catch{}
 }
}
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
 try{await scan(source);clearAssetSnapshotCache(pool);return last={state:'verified',files:count,bytes:total};}catch(e){clearAssetSnapshotCache(pool);last={state:'failed',files:count};throw e;}
}
function serveAssets(pool){const cache=createObjectCache({maxBytes:96*1024*1024,maxEntryBytes:12*1024*1024,ttl:3600000,maxPending:64});if(pool&&typeof pool==='object')assetCaches.set(pool,cache);return async(req,res,next)=>{
 if(!['GET','HEAD'].includes(req.method))return next();
 let relative;try{relative=decodeURIComponent(req.path).replace(/^\//,'');}catch{return res.sendStatus(400);}
 if(!valid(relative))return next();
 const requestedWidth=req.query?.w;
 const width=requestedWidth===undefined?null:widths.find(v=>String(v)===requestedWidth);
 if(requestedWidth!==undefined&&!width)return res.status(400).json({error:'Kích thước ảnh không được hỗ trợ.'});
 const mime=types[path.posix.extname(relative).toLowerCase()],isImage=Boolean(mime?.startsWith('image/'));
 const cacheControl=/-[0-9a-f]{12}\.[a-z0-9]+$/i.test(relative)&&process.env.MEDIA_CACHE_ENABLED!=='false'?'public, max-age=31536000, immutable':(process.env.MEDIA_CACHE_ENABLED!=='false'?'public, max-age=300, stale-while-revalidate=86400, must-revalidate':'public, max-age=0, must-revalidate'); if(isImage)res.vary('Accept');
  if (isImage && qualifiesForSelectiveAvif(req)) {
    const preAvifEntry = await getPreGeneratedAvif(relative, width);
    if (preAvifEntry) {
      res.type('image/avif').set({
        'Cache-Control': cacheControl,
        'ETag': preAvifEntry.etag,
        'X-GAERU-Asset-Backend': filesystem.configured() ? 'media-root' : 'local-fallback',
        'X-GAERU-AVIF-Source': 'avif-ultra-pregen',
        'X-Content-Type-Options': 'nosniff'
      });
      if (req.fresh) return res.status(304).end();
      return res.send(preAvifEntry.buffer);
    }
  }
  if(!filesystem.configured()){
   if(!isImage)return next();
   if(!width&&!qualifiesForSelectiveAvif(req))return next();
   try{
    if(width){
     const preWebp = await getPreGeneratedWebp(relative, width);
     if(preWebp){
      res.type('image/webp').set({'Cache-Control':cacheControl,'ETag':preWebp.etag,'X-Content-Type-Options':'nosniff'});
      if(req.fresh)return res.status(304).end();
      return res.send(preWebp.buffer);
     }
     const cachedWebp=cache.peek('local:'+relative+':w='+width);
     if(cachedWebp){
      const etag='"'+hash(cachedWebp)+'"';
      res.type('image/webp').set({'Cache-Control':cacheControl,'ETag':etag,'X-Content-Type-Options':'nosniff'});
      if(req.fresh)return res.status(304).end();
      return res.send(cachedWebp);
     }
     const localFile=path.join(__dirname,'..','assets',relative);
     const raw=await fs.readFile(localFile);
     const etag='"'+hash(raw)+'"';
     res.type(mime||'application/octet-stream').set({'Cache-Control':cacheControl,'ETag':etag,'X-Content-Type-Options':'nosniff'});
     if(req.fresh)return res.status(304).end();
     return res.send(raw);
    }
    return next();
   }catch{return next();}
  }
  const serveLocalFallback=async()=>{
    const localFile=path.join(__dirname,'..','assets',relative);
    const raw=await fs.readFile(localFile);
    if(width&&isImage){
      const preWebp = await getPreGeneratedWebp(relative, width);
      if(preWebp){
        res.type('image/webp').set({'Cache-Control':cacheControl,'ETag':preWebp.etag,'X-GAERU-Asset-Backend':'local-fallback','X-Content-Type-Options':'nosniff'});
        if(req.fresh)return res.status(304).end();
        return res.send(preWebp.buffer);
      }
      res.type(mime||'application/octet-stream').set({'Cache-Control':cacheControl,'ETag':'"'+hash(raw)+'"','X-GAERU-Asset-Backend':'local-fallback','X-Content-Type-Options':'nosniff'});
      if(req.fresh)return res.status(304).end();
      return res.send(raw);
    }
    res.type(mime||'application/octet-stream').set({'Cache-Control':cacheControl,'ETag':'"'+hash(raw)+'"','X-GAERU-Asset-Backend':'local-fallback','X-Content-Type-Options':'nosniff'});
    if(req.fresh)return res.status(304).end();
    return res.send(raw);
  };
  try{
    const row=await getCachedSnapshotRow(pool,relative,async()=>(await pool.query('SELECT * FROM site_asset_snapshots WHERE path=$1',[relative])).rows[0]);
    if(!row){
      try{return await serveLocalFallback();}catch(_){return res.set('Cache-Control','no-store').sendStatus(404);}
    }
    // GAERU F-15: Fast 304 response before disk read if client already holds matching snapshot ETag
    if(!width && req.headers['if-none-match'] === '"' + row.sha256 + '"'){
      res.type(row.mime_type).set({'Cache-Control':cacheControl,'ETag':'"'+row.sha256+'"','X-GAERU-Asset-Backend':'media-root','X-Content-Type-Options':'nosniff'});
      return res.status(304).end();
    }
    const bytes=await cache.get(row.storage_key,async()=>{
      try{
        const value=await disk.read(row.storage_key);
        if(value.length!==Number(row.byte_size)||hash(value)!==row.sha256)throw Error('SITE_ASSET_INTEGRITY');
        return value;
      }catch(err){
        if(err.code==='ENOENT'){
          const fallbackBytes = await fs.readFile(path.join(__dirname,'..','assets',relative));
          if(fallbackBytes.length!==Number(row.byte_size)||hash(fallbackBytes)!==row.sha256){
            throw Error('SITE_ASSET_FALLBACK_INTEGRITY');
          }
          return fallbackBytes;
        }
        throw err;
      }
    });
  if(width&&row.mime_type.startsWith('image/')){
   const preWebp=await getPreGeneratedWebp(relative,width);
   if(preWebp){
    res.type('image/webp').set({'Cache-Control':cacheControl,'ETag':preWebp.etag,'X-GAERU-Asset-Backend':'media-root','X-Content-Type-Options':'nosniff'});
    if(req.fresh)return res.status(304).end();
    return res.send(preWebp.buffer);
   }
   const resized=cache.peek(row.storage_key+':w='+width);
   if(resized){
    if(qualifiesForSelectiveAvif(req,resized.length)){
     const avifResized=cache.peek(row.storage_key+':w='+width+':avif');
     if(avifResized&&avifResized.length<=resized.length*SAVINGS_RATIO){
      const avifEtag='"'+row.sha256+'-w'+width+'-avif"';
      res.type('image/avif').set({'Cache-Control':cacheControl,'ETag':avifEtag,'X-GAERU-Asset-Backend':'media-root','X-Content-Type-Options':'nosniff'});
      if(req.fresh)return res.status(304).end();
      return res.send(avifResized);
     }
    }
    const etag='"'+row.sha256+'-w'+width+'"';
    res.type('image/webp').set({'Cache-Control':cacheControl,'ETag':etag,'X-GAERU-Asset-Backend':'media-root','X-Content-Type-Options':'nosniff'});
    if(req.fresh)return res.status(304).end();
    return res.send(resized);
   }
  }
  if(!width&&row.mime_type.startsWith('image/')&&qualifiesForSelectiveAvif(req,bytes.length)){
   const avifBytes=cache.peek(row.storage_key+':avif');
   if(avifBytes&&avifBytes.length<=bytes.length*SAVINGS_RATIO){
    const etag='"'+row.sha256+'-avif"';
    res.type('image/avif').set({'Cache-Control':cacheControl,'ETag':etag,'X-GAERU-Asset-Backend':'media-root','X-Content-Type-Options':'nosniff'});
    if(req.fresh)return res.status(304).end();
    return res.send(avifBytes);
   }
  }
  res.type(row.mime_type).set({'Cache-Control':cacheControl,'ETag':'"'+row.sha256+'"','X-GAERU-Asset-Backend':'media-root','X-Content-Type-Options':'nosniff'});if(req.fresh)return res.status(304).end();
  if(row.mime_type==='video/mp4'){
   res.set('Accept-Ranges','bytes');
   const range=req.headers.range,tag='"'+row.sha256+'"';
   if(req.method==='GET'&&range&&(!req.headers['if-range']||req.headers['if-range']===tag)){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    let start,end;
    if(match&&(match[1]||match[2])){
     if(!match[1]){const suffix=Number(match[2]);if(Number.isSafeInteger(suffix)&&suffix>0){start=Math.max(0,bytes.length-suffix);end=bytes.length-1;}}
     else{start=Number(match[1]);end=match[2]?Number(match[2]):bytes.length-1;if(!Number.isSafeInteger(end))start=undefined;end=Math.min(end,bytes.length-1);}
    }
    if(!Number.isSafeInteger(start)||start<0||start>=bytes.length||!Number.isSafeInteger(end)||end<start)return res.status(416).set('Content-Range','bytes */'+bytes.length).end();
    return res.status(206).set('Content-Range',`bytes ${start}-${end}/${bytes.length}`).send(bytes.subarray(start,end+1));
   }
   if(req.method==='HEAD')return res.set('Content-Length',String(bytes.length)).end();
  }
  return res.send(bytes);
 }catch(e){
   if(e.code==='ENOENT'||e.code==='ECONNREFUSED'){
     try{return await serveLocalFallback();}catch(_){return res.set('Cache-Control','no-store').status(503).send('Ảnh lưu trữ tạm thời chưa sẵn sàng.');}
   }
   next(e);
 }
};}
module.exports={syncAssets,serveAssets,valid,clearAssetSnapshotCache,warmStaticAssets,status:()=>last};
