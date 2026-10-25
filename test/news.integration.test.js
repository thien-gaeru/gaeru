const test=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const bcrypt=require('bcryptjs');
const session=require('express-session');
const {createApp}=require('../src/app');
const {migrateDatabase}=require('../src/migrate');

test('news publishing protects drafts, enforces permissions and CSRF, stores image bytes and prevents stale edits',{timeout:60000},async t=>{
 const db=await PGlite.create();let queue=Promise.resolve();
 async function lock(){const previous=queue;let release;queue=new Promise(r=>release=r);await previous;return release;}
 async function query(sql,values){const r=!values&&sql.includes(';')?(await db.exec(sql)).at(-1):await db.query(sql,values);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};}
 const pool={async query(sql,values){const release=await lock();try{return await query(sql,values);}finally{release();}},async connect(){const release=await lock();return {query,release};}};
 await migrateDatabase(pool);const password='News-owner-2026';
 const app=createApp({pool,sessionStore:new session.MemoryStore(),config:{NODE_ENV:'test',SESSION_SECRET:'test-news-session-secret-long-enough',ADMIN_USERNAME:'news-owner',ADMIN_PASSWORD_HASH:bcrypt.hashSync(password,4)}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));await db.close();});const base=`http://127.0.0.1:${server.address().port}`;
 let cookie='',csrf='';async function api(path,method='GET',body,withCsrf=true){const r=await fetch(base+path,{method,headers:{Cookie:cookie,...(withCsrf?{'X-CSRF-Token':csrf}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const data=r.headers.get('content-type')?.includes('application/json')?await r.json():await r.arrayBuffer();if(data.csrfToken)csrf=data.csrfToken;return {status:r.status,data};}
 assert.equal((await api('/api/gaeru_ceo/news')).status,401);
 await api('/api/csrf');assert.equal((await api('/api/auth/login','POST',{username:'news-owner',password})).status,200);
 const image=await require('sharp')({create:{width:16,height:16,channels:4,background:{r:20,g:100,b:200,alpha:.8}}}).png().toBuffer();
 function form(bytes=image,type='image/png'){const f=new FormData();f.append('image',new Blob([bytes],{type}),'cover.png');return f;}
 assert.equal((await api('/api/gaeru_ceo/news-images','POST',form(),false)).status,403);
 assert.equal((await api('/api/gaeru_ceo/news-images','POST',form(Buffer.from('fake'),'image/png'))).status,400);
 const uploaded=await api('/api/gaeru_ceo/news-images','POST',form());assert.equal(uploaded.status,201);const coverId=uploaded.data.id;
 const payload={title:'Tin tức kiểm thử GAERU',slug:'tin-tuc-kiem-thu',excerpt:'Mô tả ngắn cho bài viết kiểm thử.',body:'Nội dung kiểm thử bài viết với nhiều thông tin.\n\n<script>alert(1)</script>',coverId,imageAlt:'Ảnh kiểm thử GAERU',status:'draft'};
 assert.equal((await api('/api/gaeru_ceo/news','POST',payload,false)).status,403);
 let saved=await api('/api/gaeru_ceo/news','POST',payload);assert.equal(saved.status,201);let post=saved.data.post;
 assert.equal((await api('/api/news')).data.posts.length,0);
 assert.equal((await api('/api/news/'+payload.slug)).status,404);
 assert.equal((await api('/api/news-images/'+coverId)).status,404);
 assert.equal((await api('/api/gaeru_ceo/news-images/'+coverId)).status,200);
 assert.equal((await api('/api/gaeru_ceo/news','POST',payload)).status,409);
 const published={...payload,status:'published',version:post.version};saved=await api('/api/gaeru_ceo/news/'+post.id,'PUT',published);assert.equal(saved.status,200);post=saved.data.post;
 assert.equal((await api('/api/news')).data.posts[0].slug,payload.slug);
 assert.equal((await api('/api/news/'+payload.slug)).data.post.body,payload.body);
 const publicImage=await api('/api/news-images/'+coverId);assert.equal(publicImage.status,200);assert.deepEqual(Buffer.from(publicImage.data),(await require('../src/lib/image-optimizer').optimizeImage(image,'image/png')).buffer);
 const cached=await fetch(base+'/api/news-images/'+coverId);const etag=cached.headers.get('etag');await cached.arrayBuffer();assert.ok(etag);const conditional=()=>new Promise((resolve,reject)=>require('node:http').get(base+'/api/news-images/'+coverId,{headers:{'If-None-Match':etag}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));}).on('error',reject));assert.equal(await conditional(),304);
 assert.equal((await api('/api/gaeru_ceo/news/'+post.id,'PUT',published)).status,409);
 assert.equal((await api('/api/news?page=-1')).status,400);
 assert.equal((await api('/api/gaeru_ceo/news/'+post.id,'PUT',{...payload,version:post.version})).status,200);
 assert.equal((await api('/api/news')).data.posts.length,0);assert.equal((await api('/api/news-images/'+coverId)).status,404);assert.equal((await fetch(base+'/api/news-images/'+coverId,{headers:{'If-None-Match':etag}})).status,404);
 assert.equal(Number((await pool.query("SELECT count(*) n FROM audit_events WHERE action LIKE 'news.%'")).rows[0].n),4);
 // A read-only staff role cannot upload or publish content.
 await pool.query('INSERT INTO staff_accounts(username,full_name,password_hash,role) VALUES($1,$2,$3,$4)',['news-viewer','News Viewer',bcrypt.hashSync(password,4),'viewer']);
 await api('/api/auth/logout','POST');await api('/api/csrf');assert.equal((await api('/api/auth/login','POST',{username:'news-viewer',password})).status,200);
 assert.equal((await api('/api/gaeru_ceo/news')).status,200);assert.equal((await api('/api/gaeru_ceo/news','POST',payload)).status,403);assert.equal((await api('/api/gaeru_ceo/news-images','POST',form())).status,403);
});

