const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),{randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite'),{migrateDatabase}=require('../src/migrate'),inventory=require('../src/inventory'),{withTransaction}=require('../src/db'),{appendAudit}=require('../src/audit');
async function fixture(t){
 const db=await PGlite.create();let queue=Promise.resolve();async function lock(){const before=queue;let release;queue=new Promise(r=>release=r);await before;return release;}
 async function query(sql,args){const r=!args&&sql.includes(';')?(await db.exec(sql)).at(-1):await db.query(sql,args);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};}
 const pool={async query(sql,args){const release=await lock();try{return await query(sql,args);}finally{release();}},async connect(){const release=await lock();return {query,release};}};
 await migrateDatabase(pool);
 const actor={username:'order-fixture',role:'owner',source:'bootstrap',permissions:['orders.read','orders.write','payments.write']};
 const product=(await pool.query("INSERT INTO products(slug,name,category,active) VALUES($1,'Fixture Product','audio',true) RETURNING id",['restore-'+randomUUID()])).rows[0];
 const variant=(await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,$2,'Fixture',100000,10,true) RETURNING id",[product.id,'RESTORE-'+randomUUID()])).rows[0];
 await withTransaction(pool,c=>inventory.initializeVariantStock(c,{variantId:variant.id,quantity:10,actor}));
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.session={csrfToken:'fixture-csrf',admin:{username:actor.username}};req.admin={...actor,permissions:req.headers['x-readonly']?['orders.read']:actor.permissions};next();});
 app.use('/api/gaeru_ceo',require('../src/order-after-sales').afterSalesRouter(pool));app.use('/api',require('../src/store-api').createStoreApi(pool,{inventory,audit:appendAudit}));
 app.use((e,_req,res,_next)=>res.status(e.status||500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));await db.close();});const base='http://127.0.0.1:'+server.address().port;
 async function api(path,method='GET',body,headers={}){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':'fixture-csrf',...headers},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
 async function order({method='cod',status='pending',paymentStatus='pending',legacy=false}={}){
  const row=(await pool.query("INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,subtotal_vnd,shipping_fee_vnd,total_vnd,status,payment_status) VALUES($1,'Fixture Buyer','restore@example.invalid','0900000000','Fixture Street','Hà Nội',$2,200000,0,200000,$3,$4) RETURNING *",['GR-FIXTURE-'+randomUUID(),method,status,paymentStatus])).rows[0];
  await pool.query('INSERT INTO order_items(order_id,variant_id,product_name,variant_name,sku,unit_price_vnd,quantity,line_total_vnd) VALUES($1,$2,$3,$4,$5,100000,2,200000)',[row.id,variant.id,'Fixture Product','Fixture','RESTORE']);
  if(legacy){const current=(await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[variant.id])).rows[0].stock_quantity;await withTransaction(pool,c=>inventory.setVariantStock(c,{variantId:variant.id,quantity:current-2,actor,reason:'Fixture historical available stock before warehouse allocations'}));}
  else await withTransaction(pool,c=>inventory.reserveStock(c,{variantId:variant.id,quantity:2,orderId:row.id,actor}));return row;
 }
 const state=async id=>(await pool.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];
 const stock=async()=>(await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[variant.id])).rows[0].stock_quantity;
 const cancel=async id=>api('/api/gaeru_ceo/orders/'+id,'PATCH',{status:'cancelled'});
 const body=row=>({version:row.management_version,requestKey:randomUUID(),reason:'Khách xác nhận tiếp tục nhận hàng',confirmedUnpaid:true});
 const restore=(id,data,headers)=>api('/api/gaeru_ceo/orders/'+id+'/restore','POST',data,headers);
 return {pool,actor,variant,order,api,state,stock,cancel,body,restore};
}

test('cancelled COD restoration is permission/CSRF/version guarded, idempotent and supports repeated stock cycles',async t=>{
 const f=await fixture(t),order=await f.order();assert.equal(await f.stock(),8);assert.equal((await f.cancel(order.id)).status,200);assert.equal(await f.stock(),10);
 const cancelled=await f.state(order.id),body=f.body(cancelled);
 assert.equal((await f.restore(order.id,body,{'X-Readonly':'1'})).status,403);
 assert.equal((await f.restore(order.id,body,{'X-CSRF-Token':'wrong'})).status,403);
 assert.equal((await f.restore(order.id,{...body,version:body.version-1})).status,409);
 assert.equal((await f.restore(order.id,{...body,confirmedUnpaid:false})).status,400);
 let response=await f.restore(order.id,body);assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.order.status,'pending');assert.equal(response.data.order.paymentStatus,'pending');assert.equal(await f.stock(),8);
 response=await f.restore(order.id,body);assert.equal(response.status,200);assert.equal(response.data.order.alreadyRestored,true);assert.equal(await f.stock(),8);
 assert.equal((await f.restore(order.id,{...body,reason:'Nội dung khác nhưng dùng lại mã cũ'})).status,409);
 assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='order.restore'",[order.id])).rows[0].n,1);
 assert.equal((await f.cancel(order.id)).status,200);assert.equal(await f.stock(),10);
 response=await f.restore(order.id,f.body(await f.state(order.id)));assert.equal(response.status,200);assert.equal(await f.stock(),8);
 assert.equal((await f.cancel(order.id)).status,200);assert.equal(await f.stock(),10);
 assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM inventory_movements WHERE reference_id=$1 AND movement_type='sale_release'",[order.id])).rows[0].n,3);
});

test('restoration rejects recorded funds, gateway sessions, inactive variants and insufficient inventory without partial changes',async t=>{
 const f=await fixture(t),order=await f.order();await f.cancel(order.id);
 await f.pool.query("INSERT INTO sales_receipts(order_id,amount_vnd,method,request_key,request_hash,created_by) VALUES($1,100,'cash',$2,'fixture','fixture')",[order.id,randomUUID()]);
 assert.equal((await f.restore(order.id,f.body(await f.state(order.id)))).status,409);assert.equal(await f.stock(),10);
 const gateway=await f.order({method:'momo'});await f.cancel(gateway.id);assert.equal((await f.restore(gateway.id,f.body(await f.state(gateway.id)))).status,409);assert.equal(await f.stock(),10);
 const inactive=await f.order();await f.cancel(inactive.id);await f.pool.query('UPDATE product_variants SET active=false WHERE id=$1',[f.variant.id]);
 assert.equal((await f.restore(inactive.id,f.body(await f.state(inactive.id)))).status,409);assert.equal(await f.stock(),10);
 await f.pool.query('UPDATE product_variants SET active=true WHERE id=$1',[f.variant.id]);await withTransaction(f.pool,c=>inventory.setVariantStock(c,{variantId:f.variant.id,quantity:1,actor:f.actor}));
 assert.equal((await f.restore(inactive.id,f.body(await f.state(inactive.id)))).status,409);assert.equal(await f.stock(),1);assert.equal((await f.state(inactive.id)).status,'cancelled');
});

test('historical orders without warehouse allocations can restore and cancel without a second legacy stock release',async t=>{
 const f=await fixture(t),order=await f.order({legacy:true});assert.equal(await f.stock(),8);
 assert.equal((await f.cancel(order.id)).status,200);assert.equal(await f.stock(),10);
 assert.equal((await f.restore(order.id,f.body(await f.state(order.id)))).status,200);assert.equal(await f.stock(),8);
 assert.equal((await f.cancel(order.id)).status,200);assert.equal(await f.stock(),10);
 assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM inventory_movements WHERE reference_id=$1 AND movement_type='legacy_sale_release'",[order.id])).rows[0].n,1);
 assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM inventory_movements WHERE reference_id=$1 AND movement_type='sale_release'",[order.id])).rows[0].n,1);
});

test('restoration revalidates released voucher rights and rolls them back when stock cannot be reserved',async t=>{
 const f=await fixture(t),order=await f.order();
 const customer=(await f.pool.query("INSERT INTO customers(full_name,email,phone,password_hash) VALUES('Fixture Customer','voucher-restore@example.invalid','0900000001','fixture-hash') RETURNING id")).rows[0];
 const voucher=(await f.pool.query("INSERT INTO marketing_vouchers(code,title,kind,amount,starts_at,ends_at,total_limit,active) VALUES('RESTORETEST','Fixture Voucher','fixed',10000,now()-interval '1 day',now()+interval '1 day',1,true) RETURNING id")).rows[0];
 await f.pool.query("INSERT INTO customer_vouchers(customer_id,voucher_id,source) VALUES($1,$2,'granted')",[customer.id,voucher.id]);
 await f.pool.query("UPDATE orders SET customer_id=$2,voucher_code='RESTORETEST',discount_vnd=10000,total_vnd=190000 WHERE id=$1",[order.id,customer.id]);
 await f.pool.query('INSERT INTO voucher_redemptions(order_id,voucher_id,customer_id,discount_vnd) VALUES($1,$2,$3,10000)',[order.id,voucher.id,customer.id]);
 await f.cancel(order.id);await withTransaction(f.pool,c=>inventory.setVariantStock(c,{variantId:f.variant.id,quantity:1,actor:f.actor}));
 assert.equal((await f.restore(order.id,f.body(await f.state(order.id)))).status,409);
 assert.equal((await f.pool.query('SELECT released FROM voucher_redemptions WHERE order_id=$1',[order.id])).rows[0].released,true);
 await withTransaction(f.pool,c=>inventory.setVariantStock(c,{variantId:f.variant.id,quantity:10,actor:f.actor}));
 await f.pool.query("UPDATE marketing_vouchers SET ends_at=now()-interval '1 minute' WHERE id=$1",[voucher.id]);
 assert.equal((await f.restore(order.id,f.body(await f.state(order.id)))).status,409);assert.equal(await f.stock(),10);
 await f.pool.query("UPDATE marketing_vouchers SET ends_at=now()+interval '1 day' WHERE id=$1",[voucher.id]);
 const response=await f.restore(order.id,f.body(await f.state(order.id)));assert.equal(response.status,200,JSON.stringify(response.data));
 assert.equal((await f.pool.query('SELECT released FROM voucher_redemptions WHERE order_id=$1',[order.id])).rows[0].released,false);assert.equal(await f.stock(),8);
});

test('resolved physical returns are terminal and the six-tab filters preserve actual statuses',async t=>{
 const f=await fixture(t),order=await f.order({status:'completed',paymentStatus:'paid'}),path='/api/gaeru_ceo/orders/'+order.id+'/after-sales';
 const created=await f.api(path,'POST',{kind:'return',reason:'Khách yêu cầu hoàn trả sản phẩm'});assert.equal(created.status,201);
 const caseId=created.data.id;for(const [version,status]of [[1,'approved'],[2,'received'],[3,'resolved']])assert.equal((await f.api('/api/gaeru_ceo/orders/after-sales/'+caseId,'PATCH',{version,status,resolution:'Đã kiểm tra hồ sơ và chứng từ liên quan'})).status,200);
 const closed=await f.state(order.id);assert.ok(closed.return_completed_at);assert.equal(closed.status,'completed');assert.equal(closed.payment_status,'paid');assert.equal(await f.stock(),8);
 assert.equal((await f.api(path,'POST',{kind:'return',reason:'Thử tạo lại hồ sơ hoàn trả cũ'})).status,409);
 assert.equal((await f.api('/api/gaeru_ceo/orders/'+order.id,'PATCH',{status:'completed'})).status,409);
 const returned=await f.api('/api/gaeru_ceo/orders?status=cancelled_or_returned&overview=1');assert.equal(returned.status,200);assert.equal(returned.data.orders[0].returnStatus,'returned');assert.ok(returned.data.orders[0].version>1);assert.equal(returned.data.overview.cancelled_or_returned,1);
 assert.equal(returned.data.overview.returned,1);assert.equal((await f.api('/api/gaeru_ceo/orders?status=completed')).data.orders.length,0,'closed returns are not presented as successfully completed sales');
 const prepared=await f.order({status:'confirmed'});const ready=await f.api('/api/gaeru_ceo/orders?status=ready_to_ship');assert.equal(ready.status,200);assert.deepEqual(ready.data.orders.map(o=>o.id),[prepared.id]);
 assert.equal((await f.api('/api/gaeru_ceo/orders?status=shipped')).data.orders.length,0,'handed-to-carrier filter does not relabel completed orders');
});
