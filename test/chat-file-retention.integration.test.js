const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID,createHash}=require('node:crypto');
const express=require('express');
const {createLocalPool}=require('../src/local-server'),{migrateDatabase}=require('../src/migrate');
const retention=require('../src/shopping-chat-file-retention'),disk=require('../src/lib/file-library-storage');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gaeru-chat-retention-')),old=process.env.MEDIA_ROOT;process.env.MEDIA_ROOT=root;
 const pool=await createLocalPool();await migrateDatabase(pool);
 await pool.query(await fs.readFile(path.join(__dirname,'../db/shopping-chat-file-retention.sql'),'utf8'));
 t.after(async()=>{await pool.end();old===undefined?delete process.env.MEDIA_ROOT:process.env.MEDIA_ROOT=old;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
 const thread=(await pool.query("INSERT INTO shopping_chat_threads(owner_key,product_name,request_key) VALUES($1,'Fixture support',$2) RETURNING id",[createHash('sha256').update('fixture-owner').digest('hex'),randomUUID()])).rows[0].id;
 async function file(age='0 days',reuse=null){
  const bytes=Buffer.from('retention fixture '+randomUUID()),stored=reuse||await disk.upload('chat','',bytes,'text/plain','fixture.txt');
  const actual=await fs.readFile(path.join(root,stored.key));
  const content=Buffer.concat([Buffer.from('GAERU_FS_V1:'),Buffer.from(JSON.stringify({key:stored.key,size:actual.length,sha256:createHash('sha256').update(actual).digest('hex')}))]);
  const message=(await pool.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'customer','Keep this message',$2) RETURNING id",[thread,randomUUID()])).rows[0].id;
  const row=(await pool.query("INSERT INTO shopping_chat_files(thread_id,message_id,name,mime,content,byte_size,created_at) VALUES($1,$2,'fixture.txt','text/plain',$3,$4,now()-$5::interval) RETURNING *",[thread,message,content,actual.length,age])).rows[0];
  return {...row,key:stored.key,stored,actual};
 }
 return {pool,root,thread,file};
}

test('retention expires only 30-day attachments, reclaims bytes and preserves conversation history idempotently',async t=>{
 const f=await fixture(t),old=await f.file('31 days'),boundary=await f.file('30 days'),young=await f.file('29 days 23 hours');
 const result=await retention.processChatFileRetention(f.pool,{orphans:false});assert.equal(result.expired,2);assert.equal(result.removed,2);
 for(const file of [old,boundary]){const row=(await f.pool.query('SELECT content,deleted_at,deletion_reason FROM shopping_chat_files WHERE id=$1',[file.id])).rows[0];assert.equal(row.content,null);assert.ok(row.deleted_at);assert.equal(row.deletion_reason,'retention');await assert.rejects(fs.stat(path.join(f.root,file.key)),e=>e.code==='ENOENT');}
 assert.deepEqual(await fs.readFile(path.join(f.root,young.key)),young.actual);
 assert.equal((await f.pool.query('SELECT count(*)::int n FROM shopping_chat_messages')).rows[0].n,3);
 assert.equal((await f.pool.query("SELECT count(*)::int n FROM audit_events WHERE action='shopping.chat.file.delete'")).rows[0].n,2);
 assert.equal((await retention.processChatFileRetention(f.pool,{orphans:false})).expired,0);
});

test('expired attachments cannot delete files shared by a live message, catalog or private library',async t=>{
 const f=await fixture(t),old=await f.file('31 days'),live=await f.file('0 days',old.stored),catalog=await f.file('31 days'),library=await f.file('31 days');
 await f.pool.query("INSERT INTO catalog_images(content,mime_type) VALUES($1,'image/webp')",[catalog.content]);
 await f.pool.query("INSERT INTO media_library_files(storage_key,name,mime_type,byte_size,sha256) VALUES($1,'private.txt','text/plain',$2,$3)",[library.key,library.actual.length,createHash('sha256').update(library.actual).digest('hex')]);
 const result=await retention.processChatFileRetention(f.pool,{orphans:false});assert.equal(result.expired,3);assert.equal(result.preserved,3);
 for(const row of [old,catalog,library])assert.deepEqual(await fs.readFile(path.join(f.root,row.key)),row.actual);
 assert.equal((await f.pool.query('SELECT deleted_at FROM shopping_chat_files WHERE id=$1',[live.id])).rows[0].deleted_at,null);
 await retention.deleteChatFile(f.pool,{id:live.id,threadId:f.thread,actor:{username:'fixture',role:'admin',source:'staff'},confirm:true});
 await assert.rejects(fs.stat(path.join(f.root,old.key)),e=>e.code==='ENOENT');
});

test('GIF chat objects are visible to the library and their exact bytes are reclaimed at retention expiry',async t=>{
 const f=await fixture(t),bytes=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
 const stored=await require('../src/lib/filesystem-media').uploadAsset('chat',bytes,'image/gif');
 assert.doesNotThrow(()=>disk.checkKey(stored.key));
 const listed=(await disk.list()).find(item=>item.key===stored.key);assert.ok(listed);assert.equal(listed.mime,'image/gif');
 const content=require('../src/lib/stored-media').pointer(stored.key,bytes);
 const message=(await f.pool.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'customer','GIF attachment',$2) RETURNING id",[f.thread,randomUUID()])).rows[0];
 const row=(await f.pool.query("INSERT INTO shopping_chat_files(thread_id,message_id,name,mime,content,byte_size,created_at) VALUES($1,$2,'fixture.gif','image/gif',$3,$4,now()-interval '31 days') RETURNING id",[f.thread,message.id,content,bytes.length])).rows[0];
 assert.deepEqual(await fs.readFile(path.join(f.root,stored.key)),bytes);
 const result=await retention.processChatFileRetention(f.pool,{orphans:false});assert.equal(result.expired,1);assert.equal(result.removed,1);
 const tombstone=(await f.pool.query('SELECT content,deleted_at FROM shopping_chat_files WHERE id=$1',[row.id])).rows[0];assert.equal(tombstone.content,null);assert.ok(tombstone.deleted_at);
 await assert.rejects(fs.stat(path.join(f.root,stored.key)),e=>e.code==='ENOENT');
 assert.equal(await require('../src/shopping-chat-compression').processChatCompression(f.pool,row.id),false);
 assert.equal((await disk.list()).some(item=>item.key===stored.key),false);
});

test('deletion authorization, CSRF, thread binding, expiry downloads and tombstones are enforced by HTTP routes',async t=>{
 const f=await fixture(t),file=await f.file(),expired=await f.file('31 days');
 const chat=require('../src/shopping-chat').createShoppingChat(f.pool,{NODE_ENV:'test',SESSION_SECRET:'fixture-chat-retention-session-secret'}),app=express();app.use(express.json());
 app.use((req,res,next)=>{req.session={csrfToken:'fixture',shoppingChatOwner:'fixture-owner'};const role=req.headers['x-role'];req.admin=role?{username:'fixture-'+role,role,source:role==='owner'?'bootstrap':'staff',permissions:require('../src/staff-access').ROLE_PERMISSIONS[role]}:null;next();});
 app.use('/api/chat',chat.publicApi);app.use('/api/admin',chat.admin);app.use('/api/admin',require('../src/file-library').createFileLibrary(f.pool));app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 const remove=(role,token=true,thread=f.thread,confirm=true)=>fetch(base+'/api/admin/shopping-chat/'+thread+'/files/'+file.id,{method:'DELETE',headers:{'content-type':'application/json',...(role?{'x-role':role}:{}),...(token?{'x-csrf-token':'fixture'}:{})},body:JSON.stringify({confirm})});
 assert.equal((await remove()).status,401);assert.equal((await remove('viewer')).status,403);assert.equal((await remove('sales')).status,403);assert.equal((await remove('admin',false)).status,403);
 assert.equal((await remove('admin',true,randomUUID())).status,404);assert.equal((await remove('admin',true,f.thread,false)).status,400);
 assert.equal((await fetch(base+'/api/chat/threads/'+f.thread+'/files/'+expired.id)).status,410,'expiry enforced before scheduled cleanup');
 const library=await f.file();
 const libraryDelete=role=>fetch(base+'/api/admin/file-library/chat-file',{method:'POST',headers:{'content-type':'application/json','x-role':role,'x-csrf-token':'fixture'},body:JSON.stringify({key:library.key,confirm:true})});
 assert.equal((await libraryDelete('sales')).status,403);assert.equal((await libraryDelete('owner')).status,200);
 await assert.rejects(fs.stat(path.join(f.root,library.key)),e=>e.code==='ENOENT');
 assert.equal((await remove('admin')).status,200);assert.equal((await remove('admin')).status,200);
 assert.equal((await fetch(base+'/api/chat/threads/'+f.thread+'/files/'+file.id)).status,410);
 const historyResponse=await fetch(base+'/api/chat/threads/'+f.thread+'/messages'),history=await historyResponse.json();assert.equal(historyResponse.status,200,JSON.stringify(history));const attachment=history.messages.find(m=>m.attachment?.id===file.id).attachment;
 assert.ok(attachment.deletedAt);assert.equal(attachment.deletionReason,'admin');assert.equal(history.messages.length,3);
});

test('compression completing after deletion cannot resurrect an attachment or leave its replacement bytes behind',async t=>{
 const f=await fixture(t),file=await f.file(),media=require('../src/lib/stored-media');
 let ready,release;const started=new Promise(r=>ready=r),waiting=new Promise(r=>release=r);
 t.mock.method(media,'readMedia',async()=>{ready();await waiting;return Buffer.from('compressible fixture document\n'.repeat(1000));});
 const work=require('../src/shopping-chat-compression').processChatCompression(f.pool,file.id);
 await started;
 await retention.deleteChatFile(f.pool,{id:file.id,threadId:f.thread,actor:{username:'fixture',role:'admin',source:'staff'},confirm:true});
 release();await work;
 const row=(await f.pool.query('SELECT content,deleted_at FROM shopping_chat_files WHERE id=$1',[file.id])).rows[0];
 assert.equal(row.content,null);assert.ok(row.deleted_at);
 assert.equal((await disk.list()).filter(item=>item.scope==='chat').length,0);
});

test('retention queues failures for retry, rejects unsafe cleanup keys and removes old orphaned chat objects only',async t=>{
 const f=await fixture(t),file=await f.file('31 days'),original=disk.remove;
 t.mock.method(disk,'remove',async()=>{throw Object.assign(Error('fixture private context'),{code:'EACCES'});});
 await retention.processChatFileRetention(f.pool,{orphans:false});
 const job=(await f.pool.query('SELECT * FROM shopping_chat_file_cleanup WHERE storage_key=$1',[file.key])).rows[0];assert.equal(job.attempts,1);assert.equal(job.last_error,'EACCES');assert.deepEqual(await fs.readFile(path.join(f.root,file.key)),file.actual);
 disk.remove.mock.restore();assert.equal(disk.remove,original);
 await f.pool.query('UPDATE shopping_chat_file_cleanup SET next_attempt_at=now()');await retention.cleanupDeletedChatFiles(f.pool);await assert.rejects(fs.stat(path.join(f.root,file.key)),e=>e.code==='ENOENT');
 const orphan=await disk.upload('chat','',Buffer.from('orphan fixture'),'text/plain','old.txt'),document=await disk.upload('documents','',Buffer.from('private document'),'text/plain','keep.txt');
 const ago=new Date(Date.now()-31*86400000);for(const key of [orphan.key,document.key])await fs.utimes(path.join(f.root,key),ago,ago);
 await retention.processChatFileRetention(f.pool);await assert.rejects(fs.stat(path.join(f.root,orphan.key)),e=>e.code==='ENOENT');assert.equal(await fs.readFile(path.join(f.root,document.key),'utf8'),'private document');
 await f.pool.query("INSERT INTO shopping_chat_file_cleanup(storage_key) VALUES('../outside.env')");await retention.cleanupDeletedChatFiles(f.pool);
 assert.equal((await f.pool.query("SELECT attempts FROM shopping_chat_file_cleanup WHERE storage_key='../outside.env'")).rows[0].attempts,1);
});
