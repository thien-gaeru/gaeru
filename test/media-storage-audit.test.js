'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto'),{PGlite}=require('@electric-sql/pglite');
const {migrateDatabase}=require('../src/migrate'),media=require('../src/lib/stored-media'),disk=require('../src/lib/filesystem-media'),{localizeCopiedMedia,auditMediaStorage,runLocalMediaAudit,auditStatus}=require('../src/media-storage-audit');
async function setup(t){const db=await PGlite.create(),root=await fs.mkdtemp(path.join(os.tmpdir(),'gaeru-local-reference-')),before=process.env.MEDIA_ROOT;process.env.MEDIA_ROOT=root;t.after(async()=>{await db.close();before===undefined?delete process.env.MEDIA_ROOT:process.env.MEDIA_ROOT=before;await fs.rm(root,{recursive:true,force:true});});let queue=Promise.resolve();async function lock(){let release;const old=queue;queue=new Promise(r=>release=r);await old;return release;}async function query(sql,args){const r=!args&&sql.includes(';')?(await db.exec(sql)).at(-1):await db.query(sql,args);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};}const pool={async query(sql,args){const release=await lock();try{return await query(sql,args);}finally{release();}},async connect(){const release=await lock();return {query,release};}};await migrateDatabase(pool);await disk.probe();return {pool,root};}
const hash=b=>createHash('sha256').update(b).digest('hex');
const oldPointer=(key,bytes)=>Buffer.from('GAERU_S3_V2:'+JSON.stringify({key,size:bytes.length,sha256:hash(bytes)}));
test('old pointers are changed only after existing local bytes match their original hashes, without any network',async t=>{
 const {pool}=await setup(t),key='products/'+randomUUID()+'.webp',bytes=Buffer.from('copied original image'),id=randomUUID(),legacy=randomUUID();await disk.copyAsset(key,bytes);
 await pool.query('INSERT INTO media_filesystem_objects(source_key,target_key,byte_size,sha256) VALUES($1,$1,$2,$3)',[key,bytes.length,hash(bytes)]);
 await pool.query("INSERT INTO catalog_images(id,content,mime_type) VALUES($1,$2,'image/webp')",[id,oldPointer(key,bytes)]);
 await pool.query("INSERT INTO news_images(id,content,mime_type) VALUES($1,$2,'image/webp')",[legacy,Buffer.from('GAERU_S3_V1:'+key)]);
 const network=t.mock.method(global,'fetch',async()=>{throw Error('network forbidden');});
 const result=await localizeCopiedMedia(pool);assert.equal(result.state,'verified');assert.equal(result.converted,2);assert.equal(network.mock.callCount(),0);
 const row=(await pool.query('SELECT content FROM catalog_images WHERE id=$1',[id])).rows[0];assert.match(Buffer.from(row.content).toString(),/^GAERU_FS_V1:/);assert.deepEqual(await media.readMedia(row.content),bytes);
 assert.equal((await pool.query('SELECT count(*)::int n FROM media_filesystem_reference_backups')).rows[0].n,2);
 assert.equal((await localizeCopiedMedia(pool)).converted,0);const audit=await auditMediaStorage(pool);assert.equal(audit.failedChecks,0);assert.equal(audit.filesystemReferences,2);assert.equal(audit.legacyReferences,0);
});
test('missing, corrupted or unverified local copies retain original pointers and can be repaired later',async t=>{
 const {pool,root}=await setup(t),key='products/'+randomUUID()+'.webp',bytes=Buffer.from('unchanged original'),id=randomUUID(),pointer=oldPointer(key,bytes);
 await pool.query("INSERT INTO catalog_images(id,content,mime_type) VALUES($1,$2,'image/webp')",[id,pointer]);
 assert.equal((await localizeCopiedMedia(pool)).state,'needs_review');assert.deepEqual(Buffer.from((await pool.query('SELECT content FROM catalog_images WHERE id=$1',[id])).rows[0].content),pointer);
 await disk.copyAsset(key,Buffer.from('corrupt'));assert.equal((await localizeCopiedMedia(pool)).converted,0);
 await fs.writeFile(path.join(root,key),bytes);assert.equal((await localizeCopiedMedia(pool)).converted,1);
 const other='news/'+randomUUID()+'.webp';await disk.copyAsset(other,bytes);await pool.query("INSERT INTO news_images(content,mime_type) VALUES($1,'image/webp')",[Buffer.from('GAERU_S3_V1:'+other)]);assert.equal((await localizeCopiedMedia(pool)).state,'needs_review','V1 without original manifest evidence is not declared verified');
});
test('compressed envelopes survive local reference conversion without changing logical chat file metadata',async t=>{
 const {pool}=await setup(t),raw=Buffer.from('Chat original text '.repeat(1000)),wrapped=(await require('../src/shopping-chat-compression').compressBuffer(raw,'text/plain')).buffer,key='chat/'+randomUUID()+'.txt';await disk.copyAsset(key,wrapped);
 const thread=(await pool.query("INSERT INTO shopping_chat_threads(owner_key,product_name,request_key) VALUES($1,'Fixture',gen_random_uuid()) RETURNING id",['guest:'+hash(Buffer.from('guest'))])).rows[0];
 const msg=(await pool.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'customer','Attachment',gen_random_uuid()) RETURNING id",[thread.id])).rows[0];
 const file=(await pool.query("INSERT INTO shopping_chat_files(thread_id,message_id,name,mime,content,byte_size,compression_status) VALUES($1,$2,'original.txt','text/plain',$3,$4,'compressed') RETURNING id",[thread.id,msg.id,oldPointer(key,wrapped),raw.length])).rows[0];
 assert.equal((await localizeCopiedMedia(pool)).converted,1);const after=(await pool.query('SELECT * FROM shopping_chat_files WHERE id=$1',[file.id])).rows[0];assert.equal(Number(after.byte_size),raw.length);assert.equal(after.name,'original.txt');assert.equal(after.compression_status,'compressed');assert.deepEqual(await media.readMedia(after.content),raw);assert.equal(media.metadata(after.content).size,wrapped.length);
});
test('filesystem audit detects a missing active file while safely skipping deleted chat tombstones',async t=>{
 const {pool,root}=await setup(t),bytes=Buffer.from('active'),ref=await media.storeMedia('products',bytes,'image/webp');await pool.query("INSERT INTO catalog_images(content,mime_type) VALUES($1,'image/webp')",[ref]);await fs.unlink(path.join(root,media.metadata(ref).key));const result=await auditMediaStorage(pool);assert.equal(result.state,'needs_review');assert.equal(result.failedChecks,1);
});

test('a failed storage probe records unavailable without querying or touching storage',async t=>{
 await setup(t);let queries=0,reads=0,inventories=0;
 const result=await auditMediaStorage({query:async()=>{queries++;throw Error('must not query');}},{probeStatus:{verified:false},target:{configured:()=>true,readAsset:async()=>{reads++;},inventory:async()=>{inventories++;}}});
 assert.equal(result.state,'unavailable');assert.equal(result.failedChecks,1);assert.equal(result.inventory,null);
 assert.deepEqual(result.tables,{});assert.equal(queries,0);assert.equal(reads,0);assert.equal(inventories,0);assert.equal(auditStatus(),result);
});

test('a volume lost after its successful probe reports review instead of rejecting the audit, and uploads fail closed',async t=>{
 const {pool,root}=await setup(t),bytes=Buffer.from('existing image'),ref=await media.storeMedia('products',bytes,'image/webp');
 await pool.query("INSERT INTO catalog_images(content,mime_type) VALUES($1,'image/webp')",[ref]);
 process.env.MEDIA_ROOT=path.join(root,'volume-now-unavailable');
 const network=t.mock.method(global,'fetch',async()=>{throw Error('network forbidden');});
 const result=await auditMediaStorage(pool);
 assert.equal(result.state,'needs_review');assert.equal(result.filesystemReferences,1);assert.equal(result.tables.catalog_images.failed,1);assert.equal(result.failedChecks,2);assert.equal(result.inventory,null);assert.equal(auditStatus(),result);
 await fs.writeFile(process.env.MEDIA_ROOT,'not a storage directory');
 await assert.rejects(()=>media.storeMedia('chat',Buffer.from('new upload'),'text/plain'),e=>e.status===503&&e.code==='MEDIA_STORAGE_UNAVAILABLE');
 assert.equal(network.mock.callCount(),0);assert.doesNotMatch(JSON.stringify(result),/volume-now-unavailable/);
});

test('the background audit stays pending through conversion and verification, and records a safe failure status',async()=>{
 let releaseAudit,startedAudit;const blocked=new Promise(resolve=>releaseAudit=resolve),started=new Promise(resolve=>startedAudit=resolve),observed=[];
 const target={configured:()=>true,inventory:async()=>({files:0})};
 const pool={query:async sql=>{
  observed.push(auditStatus().state);
  if(sql.includes('FROM media_filesystem_objects')){startedAudit();await blocked;}
  return {rows:[]};
 }};
 const task=runLocalMediaAudit(pool,{target});
 assert.equal(auditStatus().state,'pending');
 await started;assert.equal(auditStatus().state,'pending');releaseAudit();
 const result=await task;
 assert.equal(result.localization.state,'verified');assert.equal(result.audit.state,'verified');assert.equal(auditStatus(),result.audit);assert.ok(observed.every(state=>state==='pending'));
 const error=Object.assign(Error('private database connection details'),{code:'ECONNRESET'});
 await assert.rejects(()=>runLocalMediaAudit({query:async()=>{throw error;}},{target}),e=>e===error);
 assert.equal(auditStatus().state,'needs_review');assert.equal(auditStatus().failedChecks,1);assert.doesNotMatch(JSON.stringify(auditStatus()),/private|ECONNRESET/);
});
