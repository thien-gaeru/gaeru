'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {createLocalPool}=require('../src/local-server'),{migrateDatabase}=require('../src/migrate');
const {createApp}=require('../src/app');
const {storeMedia,metadata}=require('../src/lib/stored-media');
const hash=b=>createHash('sha256').update(b).digest('hex');
test('file-library acceptance: large chat streaming and source deletion remain consistent', {timeout:60000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gaeru-media-acceptance-test-')),prior=process.env.MEDIA_ROOT;process.env.MEDIA_ROOT=root;
 const pool=await createLocalPool();await migrateDatabase(pool);
 const app=createApp({pool,config:{NODE_ENV:'test',SESSION_SECRET:randomBytes(32).toString('hex'),ADMIN_USERNAME:'acceptance-owner',ADMIN_PASSWORD_HASH:require('bcryptjs').hashSync('Local-test-password',4),PUBLIC_BASE_URL:'https://example.invalid'},sessionStore:new(require('express-session').MemoryStore)()});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end();prior===undefined?delete process.env.MEDIA_ROOT:process.env.MEDIA_ROOT=prior;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;let cookie='',csrf='';
 async function request(url,method='GET',body){const multipart=body instanceof FormData,r=await fetch(base+url,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,...(body&&!multipart?{'Content-Type':'application/json'}:{})},body:body?(multipart?body:JSON.stringify(body)):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return r;}
 csrf=(await(await request('/api/csrf')).json()).csrfToken;assert.equal((await request('/api/auth/login','POST',{username:'acceptance-owner',password:'Local-test-password'})).status,200);
 csrf=(await(await request('/api/csrf')).json()).csrfToken;
 await t.test('a 26 MiB chat file streams intact before and after background compression',async()=>{
  const thread=(await pool.query("INSERT INTO shopping_chat_threads(owner_key,product_name,request_key) VALUES($1,'Acceptance',$2) RETURNING id",[hash(Buffer.from('owner')),randomUUID()])).rows[0];
  const msg=(await pool.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'customer','Source',$2) RETURNING id",[thread.id,randomUUID()])).rows[0];
  const bytes=Buffer.alloc(26*1024*1024,65),content=await storeMedia('chat',bytes,'text/plain');
  const row=(await pool.query("INSERT INTO shopping_chat_files(message_id,thread_id,name,mime,content,byte_size,original_byte_size,compression_status) VALUES($1,$2,'Large.txt','text/plain',$3,$4,$4,'pending') RETURNING id",[msg.id,thread.id,content,bytes.length])).rows[0];
  let r=await request('/api/gaeru_ceo/file-library/file?key='+encodeURIComponent(metadata(content).key));assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),hash(bytes));
  assert.equal(await require('../src/shopping-chat-compression').processOneChatCompression(pool,row.id),true);
  const compressed=(await pool.query('SELECT content,compression_status FROM shopping_chat_files WHERE id=$1',[row.id])).rows[0];assert.equal(compressed.compression_status,'compressed');
  r=await request('/api/gaeru_ceo/file-library/file?key='+encodeURIComponent(metadata(compressed.content).key));assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/plain/);assert.equal(hash(Buffer.from(await r.arrayBuffer())),hash(bytes),'download is the logical file rather than internal gzip envelope');
 });
 async function image(){const bytes=await require('sharp')({create:{width:80,height:60,channels:3,background:'#349167'}}).png().toBuffer(),form=new FormData();form.set('file',new Blob([bytes],{type:'image/png'}),'Photo.png');form.set('scope','products');const r=await request('/api/gaeru_ceo/file-library/upload','POST',form);assert.equal(r.status,201);const key=(await r.json()).key,original=(await pool.query('SELECT * FROM media_upload_originals WHERE derivative_key=$1',[key])).rows[0];return {key,original,bytes};}
 const change=(key,action)=>request('/api/gaeru_ceo/file-library/change','POST',{key,action,confirm:true});
 await t.test('failed permanent deletion restores the rendition, source and database metadata',async()=>{
  const f=await image();assert.equal((await change(f.key,'trash')).status,200);await pool.query("ALTER TABLE audit_events ADD CONSTRAINT reject_acceptance_delete CHECK(action<>'media.library.delete')");
  assert.equal((await change(f.key,'delete')).status,500);await pool.query('ALTER TABLE audit_events DROP CONSTRAINT reject_acceptance_delete');
  assert.ok((await pool.query('SELECT * FROM media_upload_originals WHERE derivative_key=$1',[f.key])).rows[0]);assert.equal(hash(await fs.readFile(path.join(root,f.original.original_key))),hash(f.bytes));assert.ok((await fs.stat(path.join(root,f.key))).isFile());
  assert.equal((await change(f.key,'delete')).status,200);assert.equal((await pool.query('SELECT * FROM media_upload_originals WHERE derivative_key=$1',[f.key])).rows.length,0);
  for(const key of [f.key,f.original.original_key])await assert.rejects(fs.stat(path.join(root,key)),{code:'ENOENT'});
 });
 await t.test('deleting one rendition keeps a source still referenced by another rendition',async()=>{
  const f=await image(),other='products/'+randomUUID()+'.webp';await pool.query('INSERT INTO media_upload_originals(derivative_key,original_key,original_mime,original_size,original_sha256) VALUES($1,$2,$3,$4,$5)',[other,f.original.original_key,'image/png',f.bytes.length,hash(f.bytes)]);
  assert.equal((await change(f.key,'trash')).status,200);assert.equal((await change(f.key,'delete')).status,200);
  assert.ok((await fs.stat(path.join(root,f.original.original_key))).isFile());assert.equal((await pool.query('SELECT derivative_key FROM media_upload_originals WHERE original_key=$1',[f.original.original_key])).rows.length,1);
 });
});
