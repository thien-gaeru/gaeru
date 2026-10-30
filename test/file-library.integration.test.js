const { createTestDb } = require('./helpers/pglite-db');
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { createApp } = require("../src/app");

// Runs real PostgreSQL statements in one embedded connection. Multi-connection
// locking and production integrations still require a separate staging run.

test('owner file library manages real files, protects references and preserves private access', {timeout:60000}, async t => {
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),sharp=require('sharp');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gaeru-library-')),prior=process.env.MEDIA_ROOT;process.env.MEDIA_ROOT=root;
 const { pool, close: closeDb } = await createTestDb();
  const app=createApp({config:{NODE_ENV:'test',SESSION_SECRET:randomBytes(48).toString('hex'),ADMIN_USERNAME:'library-owner',ADMIN_PASSWORD_HASH:bcrypt.hashSync('Owner-library-password',4),PUBLIC_BASE_URL:'https://example.invalid',STORE_ORDERS_ENABLED:false},pool,sessionStore:new session.MemoryStore()});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await closeDb();if(prior===undefined)delete process.env.MEDIA_ROOT;else process.env.MEDIA_ROOT=prior;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;let cookie='',csrf='';
 async function request(url,method='GET',body,token=true){const multipart=body instanceof FormData,r=await fetch(base+url,{method,headers:{Cookie:cookie,...(token?{'X-CSRF-Token':csrf}:{}),...(body&&!multipart?{'Content-Type':'application/json'}:{})},body:body?(multipart?body:JSON.stringify(body)):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const isJson=r.headers.get('content-type')?.includes('application/json'),data=isJson?await r.json():Buffer.from(await r.arrayBuffer());if(data.csrfToken)csrf=data.csrfToken;return {status:r.status,data,headers:r.headers};}
 const endpoint='/api/gaeru_ceo/file-library';
 const change=(key,action,extra={})=>request(endpoint+'/change','POST',{key,action,...extra});
 async function upload(bytes,mime,name,scope='documents',folder=''){const form=new FormData();form.set('scope',scope);form.set('folder',folder);form.set('file',new Blob([bytes],{type:mime}),name);return request(endpoint+'/upload','POST',form);}
 assert.equal((await request(endpoint)).status,401);
 await request('/api/csrf');assert.equal((await request('/api/auth/login','POST',{username:'library-owner',password:'Owner-library-password'})).status,200);
 assert.equal((await request(endpoint+'/folders','POST',{scope:'documents',name:'Blocked'},false)).status,403);
 assert.equal((await request(endpoint+'/file?key='+encodeURIComponent('../.env'))).status,400);
 const folder=await request(endpoint+'/folders','POST',{scope:'documents',name:'Hướng dẫn'});assert.equal(folder.status,201);
 assert.equal((await request(endpoint+'/folders','POST',{scope:'documents',name:'Hướng dẫn'})).status,409);
 assert.equal((await upload(Buffer.from('console.log(1)'),'application/javascript','test.js')).status,400);
 assert.equal((await upload(Buffer.from('not an image'),'image/png','spoof.png')).status,400);
 const source=await sharp({create:{width:600,height:450,channels:4,background:'#2967df'}}).png().toBuffer();
 const image=await upload(source,'image/png','Photo.png');assert.equal(image.status,201);
 let key=image.data.key;
 let list=await request(endpoint);assert.equal(list.status,200);assert.equal(list.data.root,await fs.realpath(root));assert.equal(list.data.files.length,1);assert.equal(list.data.files[0].name,'Photo.webp');assert.equal(list.data.files[0].managed,true);
 const preview=await request(endpoint+'/file?preview=1&key='+encodeURIComponent(key));assert.equal(preview.status,200);assert.match(preview.headers.get('cache-control'),/no-store/);assert.equal((await sharp(preview.data).metadata()).width,600);
 const thumb=await request(endpoint+'/file?preview=1&thumbnail=1&key='+encodeURIComponent(key));assert.equal(thumb.status,200);assert.equal((await sharp(thumb.data).metadata()).width,400);assert.deepEqual(await fs.readFile(path.join(root,key)),preview.data,'thumbnails do not alter original files');
 assert.equal((await request('/media/'+key)).status,404,'library uploads are not published by public media routes');
 assert.equal((await change(key,'rename',{name:'Ảnh mới'})).status,200);
 assert.equal((await change(key,'move',{folder:folder.data.id})).status,200);
 const moved='documents/'+folder.data.id+'/'+key.split('/').at(-1);await assert.rejects(()=>fs.stat(path.join(root,key)),e=>e.code==='ENOENT');key=moved;
 assert.equal((await change(key,'trash')).status,200);assert.equal((await request(endpoint)).data.files.length,0);assert.equal((await request(endpoint+'?trash=1')).data.files.length,1);
 assert.equal((await change(key,'delete')).status,400);
 assert.equal((await change(key,'restore')).status,200);assert.deepEqual(await fs.readFile(path.join(root,key)),preview.data);
 await change(key,'trash');
 await pool.query("ALTER TABLE audit_events ADD CONSTRAINT fail_library_delete CHECK(action<>'media.library.delete')");
 assert.equal((await change(key,'delete',{confirm:true})).status,500);
 assert.deepEqual(await fs.readFile(path.join(root,key)),preview.data,'failed database transaction restores staged file');
 await pool.query('ALTER TABLE audit_events DROP CONSTRAINT fail_library_delete');
 assert.equal((await change(key,'delete',{confirm:true})).status,200);await assert.rejects(()=>fs.stat(path.join(root,key)),e=>e.code==='ENOENT');
 const product=await upload(source,'image/png','Used.png','products');assert.equal(product.status,201);
 const bytes=await fs.readFile(path.join(root,product.data.key));const content=Buffer.concat([Buffer.from('GAERU_FS_V1:'),Buffer.from(JSON.stringify({key:product.data.key,size:bytes.length,sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex')}))]);
 await pool.query('INSERT INTO catalog_images(id,content,mime_type) VALUES($1,$2,$3)',[randomUUID(),content,'image/webp']);
 const used=(await request(endpoint)).data.files.find(f=>f.key===product.data.key);assert.ok(used.references.some(r=>r.startsWith('Ảnh sản phẩm')));
 for(const action of ['trash','move','rename'])assert.equal((await change(product.data.key,action,{name:'Bad',folder:''})).status,409);
 const pdf=await upload(Buffer.from('%PDF-1.7\nfixture'),'application/pdf','Guide.pdf','documents');assert.equal(pdf.status,201);
 const downloaded=await request(endpoint+'/file?preview=1&key='+encodeURIComponent(pdf.data.key));assert.equal(downloaded.headers.get('content-disposition').startsWith('attachment'),true);
 const video=await upload(Buffer.from([0,0,0,24,...Buffer.from('ftypisom'),0,0,0,0]),'video/mp4','Video.mp4','videos');assert.equal(video.status,201);
 const ranged=await fetch(base+endpoint+'/file?preview=1&key='+encodeURIComponent(video.data.key),{headers:{Cookie:cookie,Range:'bytes=4-7'}});assert.equal(ranged.status,206);assert.equal(await ranged.text(),'ftyp');
 await request('/api/gaeru_ceo/staff','POST',{username:'library-admin',fullName:'Staff Test',password:'Staff-library-password',role:'admin'});await request('/api/auth/logout','POST',{});await request('/api/csrf');await request('/api/auth/login','POST',{username:'library-admin',password:'Staff-library-password'});
 assert.equal((await request(endpoint)).status,403);assert.equal((await request(endpoint+'/file?key='+encodeURIComponent(pdf.data.key))).status,403);
 assert.ok((await pool.query("SELECT id FROM audit_events WHERE action='media.library.upload'")).rows.length>=3);
});

test('library rejects symlink directories and unsafe path forms', async t=>{
 const disk=require('../src/lib/file-library-storage'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
 for(const key of ['../secret','documents/../../secret','documents/a.js','products/.env','products/%2e%2e/secret','products/11111111-1111-4111-8111-111111111111.svg'])assert.throws(()=>disk.checkKey(key));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gaeru-library-safe-')),outside=await fs.mkdtemp(path.join(os.tmpdir(),'gaeru-outside-')),prior=process.env.MEDIA_ROOT;process.env.MEDIA_ROOT=root;
 t.after(async()=>{if(prior===undefined)delete process.env.MEDIA_ROOT;else process.env.MEDIA_ROOT=prior;for(const p of [root,outside]){assert.ok(path.resolve(p).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(p,{recursive:true,force:true});}});
 try{await fs.symlink(outside,path.join(root,'documents'),process.platform==='win32'?'junction':'dir');}catch(e){if(e.code==='EPERM'){t.diagnostic('OS denied symlink fixture');return;}throw e;}
 await assert.rejects(()=>disk.directory('documents','',true),/liên kết/);assert.deepEqual(await fs.readdir(outside),[]);
});


