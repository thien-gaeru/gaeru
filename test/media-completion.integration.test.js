'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {randomUUID,createHash}=require('node:crypto'),sharp=require('sharp'),express=require('express');
const {createLocalPool}=require('../src/local-server'),{migrateDatabase}=require('../src/migrate');
const {storeMedia,storeUpload,readMedia,metadata}=require('../src/lib/stored-media');
const {processOneChatCompression}=require('../src/shopping-chat-compression');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gaeru-media-completion-')),previous=process.env.MEDIA_ROOT;process.env.MEDIA_ROOT=root;
 const pool=await createLocalPool();await migrateDatabase(pool);await pool.query(await fs.readFile(path.join(__dirname,'../db/media-upload-originals.sql'),'utf8'));
 t.after(async()=>{await pool.end();previous===undefined?delete process.env.MEDIA_ROOT:process.env.MEDIA_ROOT=previous;if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Unsafe test cleanup');await fs.rm(root,{recursive:true,force:true});});
 const thread=(await pool.query("INSERT INTO shopping_chat_threads(owner_key,product_name,request_key) VALUES($1,'Fixture',$2) RETURNING id",[createHash('sha256').update('fixture').digest('hex'),randomUUID()])).rows[0].id;
 async function file(bytes=Buffer.from('source data '.repeat(1000)),mime='text/plain'){
  const content=await storeMedia('chat',bytes,mime),message=(await pool.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'customer','Fixture',$2) RETURNING id",[thread,randomUUID()])).rows[0].id;
  const row=(await pool.query(`INSERT INTO shopping_chat_files(message_id,thread_id,name,mime,content,byte_size,original_byte_size,compression_status) VALUES($1,$2,'original.txt',$3,$4,$5,$5,'pending') RETURNING *`,[message,thread,mime,content,bytes.length])).rows[0];return {...row,bytes};
 }return {pool,root,file};
}
test('compression reclaims expired leases, preserves source, and never reruns a completed job',async t=>{
 const f=await fixture(t),row=await f.file();
 await f.pool.query("UPDATE shopping_chat_files SET compression_status='processing',compression_attempts=1,compression_lease=$2,compression_lease_until=now()-interval '1 minute' WHERE id=$1",[row.id,randomUUID()]);
 assert.equal(await processOneChatCompression(f.pool,row.id),true);
 const changed=(await f.pool.query('SELECT * FROM shopping_chat_files WHERE id=$1',[row.id])).rows[0];
 assert.equal(changed.compression_status,'compressed');assert.equal(changed.compression_attempts,2);assert.equal(changed.compression_lease,null);
 assert.deepEqual(await readMedia(changed.content),row.bytes);assert.deepEqual(await readMedia(changed.original_content),row.bytes);
 assert.deepEqual(await fs.readFile(path.join(f.root,metadata(row.content).key)),row.bytes);
 assert.equal(await processOneChatCompression(f.pool,row.id),false);
});
test('compression retries failures with backoff and stops after the configured attempt bound',async t=>{
 const f=await fixture(t),row=await f.file(),deps={readMedia:async()=>{throw Object.assign(Error('private provider context'),{code:'READ_FAILED'});}};
 for(let attempt=1;attempt<=3;attempt++){
  await f.pool.query("UPDATE shopping_chat_files SET compression_next_attempt_at=now()-interval '1 minute' WHERE id=$1",[row.id]);
  assert.equal(await processOneChatCompression(f.pool,row.id,deps),true);
  const r=(await f.pool.query('SELECT * FROM shopping_chat_files WHERE id=$1',[row.id])).rows[0];assert.equal(r.compression_attempts,attempt);assert.equal(r.compression_status,attempt===3?'failed':'pending');assert.equal(r.compression_last_error,'READ_FAILED');assert.deepEqual(await readMedia(r.original_content),row.bytes);
 }
 assert.equal(await processOneChatCompression(f.pool,row.id,deps),false);
});
test('private PNG upload retains exact source then a worker publishes WebP without deleting the source',async t=>{
 const f=await fixture(t),png=await sharp({create:{width:32,height:24,channels:4,background:{r:40,g:160,b:80,alpha:.5}}}).png().toBuffer();
 const uploaded=await storeUpload('chat',png,'image/png');assert.equal(uploaded.mimeType,'image/png');assert.deepEqual(await readMedia(uploaded.content),png);
 const row=await f.file(png,'image/png');await processOneChatCompression(f.pool,row.id);
 const saved=(await f.pool.query('SELECT * FROM shopping_chat_files WHERE id=$1',[row.id])).rows[0];assert.equal(saved.mime,'image/webp');assert.equal((await sharp(await readMedia(saved.content)).metadata()).format,'webp');assert.deepEqual(await readMedia(saved.original_content),png);
});
test('compression lease ownership stops stale workers from overwriting a replacement',async t=>{
 const f=await fixture(t),row=await f.file();let replacement;
 await processOneChatCompression(f.pool,row.id,{readMedia:async content=>{replacement=randomUUID();await f.pool.query("UPDATE shopping_chat_files SET compression_lease=$2 WHERE id=$1",[row.id,replacement]);return readMedia(content);}});
 const r=(await f.pool.query('SELECT * FROM shopping_chat_files WHERE id=$1',[row.id])).rows[0];assert.equal(r.compression_lease,replacement);assert.deepEqual(Buffer.from(r.content),Buffer.from(row.content));
});
test('source image bytes are preserved separately from the bounded WebP rendition and protected in library',async t=>{
 const f=await fixture(t),original=await sharp({create:{width:2100,height:1200,channels:4,background:{r:120,g:60,b:20,alpha:.6}}}).png().withMetadata().toBuffer();
 const uploaded=await storeUpload('products',original,'image/png',f.pool),m=metadata(uploaded.content),row=(await f.pool.query('SELECT * FROM media_upload_originals WHERE derivative_key=$1',[m.key])).rows[0];
 assert.ok(row);assert.equal(row.original_mime,'image/png');assert.equal(Number(row.original_size),original.length);assert.equal(row.original_sha256,createHash('sha256').update(original).digest('hex'));
 assert.deepEqual(await fs.readFile(path.join(f.root,row.original_key)),original);
 assert.equal((await sharp(await readMedia(uploaded.content)).metadata()).width,1600);
 const app=express();app.use((q,_r,n)=>{q.admin={role:'owner',source:'bootstrap',permissions:[]};n();});app.use(require('../src/file-library').createFileLibrary(f.pool));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const result=await (await fetch('http://127.0.0.1:'+server.address().port+'/file-library?originals=1')).json();assert.ok(result.files.find(x=>x.key===row.original_key).references.includes('Bản gốc ảnh đã lưu'));
});
test('retention removes both an optimized chat file and its retained source bytes',async t=>{
 const f=await fixture(t),row=await f.file();await processOneChatCompression(f.pool,row.id);
 const r=(await f.pool.query('SELECT * FROM shopping_chat_files WHERE id=$1',[row.id])).rows[0];
 await require('../src/shopping-chat-file-retention').deleteChatFile(f.pool,{id:row.id,actor:{username:'fixture',source:'system'},confirm:true});
 for(const content of [r.content,r.original_content])await assert.rejects(fs.stat(path.join(f.root,metadata(content).key)),e=>e.code==='ENOENT');
});
test('job administration protects retries with permission, CSRF, lease state and audit records',async t=>{
 const f=await fixture(t),row=await f.file();let permission='read';
 const app=express();app.use(express.json());app.use((q,_r,n)=>{q.session={csrfToken:'fixture-token'};q.admin={username:'fixture',role:'admin',source:'staff',permissions:permission==='write'?['customers.read','customers.write']:['customers.read']};n();});app.use(require('../src/chat-compression-admin').createChatCompressionAdmin(f.pool));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const url='http://127.0.0.1:'+server.address().port+'/shopping-chat/compression-jobs';
 assert.equal((await fetch(url)).status,200);assert.equal((await fetch(url+'/'+row.id+'/retry',{method:'POST'})).status,403);permission='write';assert.equal((await fetch(url+'/'+row.id+'/retry',{method:'POST'})).status,403);
 const send=()=>fetch(url+'/'+row.id+'/retry',{method:'POST',headers:{'X-CSRF-Token':'fixture-token'}});
 await f.pool.query("UPDATE shopping_chat_files SET compression_status='processing',compression_lease_until=now()+interval '5 minutes' WHERE id=$1",[row.id]);assert.equal((await send()).status,409);
 await f.pool.query("UPDATE shopping_chat_files SET compression_status='failed',compression_attempts=3 WHERE id=$1",[row.id]);assert.equal((await send()).status,200);
 const retried=(await f.pool.query('SELECT compression_status,compression_attempts FROM shopping_chat_files WHERE id=$1',[row.id])).rows[0];assert.equal(retried.compression_status,'pending');assert.equal(retried.compression_attempts,0);assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='shopping.chat.compression.retry'")).rows[0].n,1);
});
