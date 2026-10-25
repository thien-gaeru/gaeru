const test=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const bcrypt=require('bcryptjs');
const session=require('express-session');
const {createApp}=require('../src/app');
const {migrateDatabase}=require('../src/migrate');
test('product workspace saves variant combinations atomically, protects history and stale stock, and keeps draft images private',{timeout:60000},async t=>{
 const db=await PGlite.create();let queue=Promise.resolve();async function lock(){const previous=queue;let release;queue=new Promise(r=>release=r);await previous;return release;}
 async function query(sql,values){const r=!values&&sql.includes(';')?(await db.exec(sql)).at(-1):await db.query(sql,values);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};}
 const pool={async query(sql,values){const release=await lock();try{return await query(sql,values);}finally{release();}},async connect(){const release=await lock();return {query,release};}};await migrateDatabase(pool);
 const password='Product-owner-2026';const app=createApp({pool,sessionStore:new session.MemoryStore(),config:{NODE_ENV:'test',SESSION_SECRET:'workspace-fixture-session-secret-32',ADMIN_USERNAME:'workspace-owner',ADMIN_PASSWORD_HASH:bcrypt.hashSync(password,4)}});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));await db.close();});const base=`http://127.0.0.1:${server.address().port}`;let cookie='',csrf='';
 async function api(path,method='GET',body,withCsrf=true){const r=await fetch(base+path,{method,headers:{Cookie:cookie,...(withCsrf?{'X-CSRF-Token':csrf}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const data=r.headers.get('content-type')?.includes('application/json')?await r.json():null;if(data?.csrfToken)csrf=data.csrfToken;return {status:r.status,data};}
 assert.equal((await api('/api/gaeru_ceo/product-workspace')).status,401);await api('/api/csrf');assert.equal((await api('/api/auth/login','POST',{username:'workspace-owner',password})).status,200);
 const image=await require('sharp')({
  create: {
    width: 16,
    height: 16,
    channels: 3,
    background: {
      r: 80,
      g: 140,
      b: 200
    }
  }
}).png().toBuffer(),upload=new FormData();upload.append('image',new Blob([image],{type:'image/png'}),'fixture.png');const uploaded=await api('/api/gaeru_ceo/catalog-images','POST',upload);assert.equal(uploaded.status,201);const url=uploaded.data.imageUrl;
 const video=Buffer.alloc(32);video.writeUInt32BE(32,0);video.write('ftypisom',4,'ascii');const videoForm=new FormData();videoForm.append('video',new Blob([video],{type:'video/mp4'}),'fixture.mp4');const uploadedVideo=await api('/api/gaeru_ceo/catalog-videos','POST',videoForm);assert.equal(uploadedVideo.status,201);const videoUrl=uploadedVideo.data.url;assert.equal((await api(videoUrl)).status,404);
 const privateVideo=await fetch(base+videoUrl.replace('/api/','/api/gaeru_ceo/'),{headers:{Cookie:cookie,Range:'bytes=0-3'}});assert.equal(privateVideo.status,206);assert.equal((await privateVideo.arrayBuffer()).byteLength,4);
 const invalidRange=await fetch(base+videoUrl.replace('/api/','/api/gaeru_ceo/'),{headers:{Cookie:cookie,Range:'bytes=999-1000'}});assert.equal(invalidRange.status,416);
 const initial={descriptionMedia:[{type:'image',url,alt:'Description image',caption:'Fixture caption'},{type:'video',url:videoUrl,alt:'Fixture video',caption:''}],product:{name:'Fixture Micro',slug:'fixture-micro',category:'audio',descriptor:'Micro fixture',cardTitle:'Sound for your story',cardSummary:'A compact microphone for everyday creativity.',description:'Test product description',imageUrl:url,imageAlt:'Fixture cover',active:false,sortOrder:0},gallery:[url],groups:[{name:'Cổng kết nối',values:['Type-C','Lightning']}],variants:['Type-C','Lightning'].map((value,i)=>({sku:'FIXTURE-'+i,name:value,options:{'Cổng kết nối':value},priceVnd:100000+i*20000,stockQuantity:5,active:true,imageUrl:url}))};
 assert.equal((await api('/api/gaeru_ceo/product-workspace','POST',initial,false)).status,403);
 let saved=await api('/api/gaeru_ceo/product-workspace','POST',initial);assert.equal(saved.status,201,JSON.stringify(saved.data));let model=saved.data;assert.equal(model.product.cardTitle,initial.product.cardTitle);assert.equal(model.product.cardSummary,initial.product.cardSummary);
 assert.equal((await api(url)).status,404);assert.equal((await api('/api/products')).data.products.length,0);assert.equal(model.variants.length,2);
 assert.equal((await pool.query('SELECT SUM(quantity)::int n FROM warehouse_stock')).rows[0].n,10);
 model.product.active=true;const published=await api('/api/gaeru_ceo/product-workspace','POST',model);assert.equal(published.status,200,JSON.stringify(published.data));const stale=JSON.parse(JSON.stringify(model));model=published.data;const cardProduct=(await api('/api/products')).data.products.find(p=>p.id===model.id);assert.equal(cardProduct.cardSummary,initial.product.cardSummary);assert.equal(cardProduct.description,'Test product description');const tooLong=JSON.parse(JSON.stringify(model));tooLong.product.cardSummary='x'.repeat(241);assert.equal((await api('/api/gaeru_ceo/product-workspace','POST',tooLong)).status,400);
 assert.equal((await api(url)).status,200);const publicProduct=(await api('/api/products')).data.products[0],displayUrl=url+'?v=webp-20261025';assert.equal(publicProduct.gallery[0],displayUrl);assert.equal(publicProduct.descriptionMedia.length,2);assert.equal(publicProduct.descriptionMedia[0].url,displayUrl);assert.equal((await api(videoUrl)).status,200);const ranged=await fetch(base+videoUrl,{headers:{Range:'bytes=-4'}});assert.equal(ranged.status,206);assert.equal((await ranged.arrayBuffer()).byteLength,4);assert.equal(publicProduct.variants[0].imageUrl,displayUrl);assert.equal(publicProduct.optionGroups[0].name,'Cổng kết nối');
 assert.equal((await api('/api/products/fixture-micro')).data.product.imageUrl,displayUrl);assert.equal((await api(displayUrl)).status,200);assert.equal(model.product.imageUrl,url);assert.equal(model.gallery[0],url);const adminProduct=(await api('/api/gaeru_ceo/products')).data.products.find(p=>p.id===model.id);assert.equal(adminProduct.imageUrl,url);assert.equal(adminProduct.gallery[0],url);assert.equal(adminProduct.descriptionMedia[0].url,url);
 assert.equal((await api('/api/gaeru_ceo/product-workspace','POST',stale)).status,409);
 const oldName=model.product.name;const duplicate=JSON.parse(JSON.stringify(model));duplicate.product.name='Should roll back';duplicate.variants[1].sku=duplicate.variants[0].sku;assert.equal((await api('/api/gaeru_ceo/product-workspace','POST',duplicate)).status,400);assert.equal((await api('/api/gaeru_ceo/product-workspace/'+model.id)).data.product.name,oldName);
 const other={...initial,product:{...initial.product,slug:'other-fixture'},variants:[{...initial.variants[0],sku:'OTHER-SKU',stockQuantity:0}]};const second=await api('/api/gaeru_ceo/product-workspace','POST',other);assert.equal(second.status,201);const conflict=JSON.parse(JSON.stringify(model));conflict.groups[0].values.push('3.5mm');conflict.variants.push({...initial.variants[0],sku:'OTHER-SKU',name:'3.5mm',options:{'Cổng kết nối':'3.5mm'}});conflict.product.name='Must roll back after variant conflict';assert.equal((await api('/api/gaeru_ceo/product-workspace','POST',conflict)).status,409);assert.equal((await api('/api/gaeru_ceo/product-workspace/'+model.id)).data.variants.length,2);
 const missing=JSON.parse(JSON.stringify(model));missing.variants.pop();assert.equal((await api('/api/gaeru_ceo/product-workspace','POST',missing)).status,409);
 // An independent stock update changes the version even if timestamps share a millisecond.
 await pool.query('UPDATE product_variants SET updated_at=now() WHERE id=$1',[model.variants[0].id]);assert.equal((await api('/api/gaeru_ceo/product-workspace','POST',model)).status,409);
 model=(await api('/api/gaeru_ceo/product-workspace/'+model.id)).data;model.variants[0].stockQuantity=8;const updated=await api('/api/gaeru_ceo/product-workspace','POST',model);assert.equal(updated.status,200,JSON.stringify(updated.data));assert.equal((await pool.query('SELECT SUM(quantity)::int n FROM warehouse_stock')).rows[0].n,13);
 const notices=(await api('/api/gaeru_ceo/notifications')).data;assert.ok(notices.items.some(n=>n.key==='config:smtp'));const notice=notices.items.find(n=>n.key==='config:smtp');assert.equal((await api('/api/gaeru_ceo/notifications/read','POST',{key:notice.key,version:notice.version},false)).status,403);assert.equal((await api('/api/gaeru_ceo/notifications/read','POST',{key:notice.key,version:notice.version})).status,200);assert.equal((await api('/api/gaeru_ceo/notifications')).data.items.find(n=>n.key===notice.key).read,true);
 const stockNotice=notices.items.find(n=>n.key.startsWith('stock:'));assert.ok(stockNotice);await api('/api/gaeru_ceo/notifications/read','POST',{key:stockNotice.key,version:stockNotice.version});await pool.query('UPDATE product_variants SET stock_quantity=0 WHERE id=$1',[stockNotice.key.split(':')[1]]);const changedStock=(await api('/api/gaeru_ceo/notifications')).data.items.find(n=>n.key===stockNotice.key);assert.equal(changedStock.read,false);assert.equal(changedStock.version,'0');
 await pool.query('INSERT INTO staff_accounts(username,full_name,password_hash,role) VALUES($1,$2,$3,$4)',['fixture-viewer','Fixture Viewer',bcrypt.hashSync(password,4),'viewer']);await api('/api/auth/logout','POST');await api('/api/csrf');assert.equal((await api('/api/auth/login','POST',{username:'fixture-viewer',password})).status,200);assert.equal((await api('/api/gaeru_ceo/product-workspace/'+model.id)).status,200);assert.equal((await api('/api/gaeru_ceo/product-workspace','POST',updated.data)).status,403);const viewerNotices=(await api('/api/gaeru_ceo/notifications')).data;assert.ok(!viewerNotices.items.some(n=>n.key.startsWith('config:')));assert.equal((await api('/api/gaeru_ceo/notifications/read','POST',{key:'config:smtp',version:'missing'})).status,409);
 // Removing a listing preserves stock, immutable audit and linked order history.
 const deletePath='/api/gaeru_ceo/products/'+model.id;
 const current=(await api('/api/gaeru_ceo/products')).data.products.find(p=>p.id===model.id);
 const deletion={version:current.version,confirmation:'DELETE_PRODUCT'};
 assert.equal((await api(deletePath,'DELETE',deletion)).status,403);
 await api('/api/auth/logout','POST');await api('/api/csrf');await api('/api/auth/login','POST',{username:'workspace-owner',password});
 assert.equal((await api(deletePath,'DELETE',deletion,false)).status,403);
 assert.equal((await api(deletePath,'DELETE',{version:current.version})).status,400);
 assert.equal((await api(deletePath,'DELETE',{...deletion,version:current.version+1})).status,409);
 const order=(await pool.query("INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,subtotal_vnd) VALUES('DELETE-FIXTURE','Fixture','fixture@example.test','000','Fixture','Fixture','cod',100000) RETURNING id")).rows[0];
 await pool.query("INSERT INTO order_items(order_id,variant_id,product_name,variant_name,sku,unit_price_vnd,quantity,line_total_vnd) VALUES($1,$2,'Fixture Micro','Type-C','FIXTURE-0',100000,1,100000)",[order.id,model.variants[0].id]);
 const stockBefore=(await pool.query('SELECT variant_id,quantity FROM warehouse_stock ORDER BY variant_id')).rows;
 const variantsBefore=(await pool.query('SELECT id,stock_quantity FROM product_variants WHERE product_id=$1 ORDER BY id',[model.id])).rows;
 assert.equal((await api(deletePath,'DELETE',deletion)).status,204);
 assert.equal((await api(deletePath,'DELETE',deletion)).status,404);
 assert.ok(!(await api('/api/products')).data.products.some(p=>p.id===model.id));
 assert.ok(!(await api('/api/gaeru_ceo/products')).data.products.some(p=>p.id===model.id));
 assert.equal((await api('/api/products/fixture-micro')).status,404);
 assert.equal((await api('/api/gaeru_ceo/product-workspace/'+model.id)).status,404);
 assert.equal((await api('/api/gaeru_ceo/product-workspace','POST',updated.data)).status,404);
 assert.deepEqual((await pool.query('SELECT variant_id,quantity FROM warehouse_stock ORDER BY variant_id')).rows,stockBefore);
 assert.deepEqual((await pool.query('SELECT id,stock_quantity FROM product_variants WHERE product_id=$1 ORDER BY id',[model.id])).rows,variantsBefore);
 assert.equal((await pool.query('SELECT variant_id FROM order_items WHERE order_id=$1',[order.id])).rows[0].variant_id,model.variants[0].id);
 assert.equal((await pool.query('SELECT active,deleted_at IS NOT NULL deleted FROM products WHERE id=$1',[model.id])).rows[0].deleted,true);
 assert.equal((await pool.query('SELECT COUNT(*)::int n FROM product_variants WHERE product_id=$1 AND active',[model.id])).rows[0].n,0);
 assert.equal((await pool.query("SELECT COUNT(*)::int n FROM audit_events WHERE action='catalog.product.delete' AND entity_id=$1",[model.id])).rows[0].n,1);

});
