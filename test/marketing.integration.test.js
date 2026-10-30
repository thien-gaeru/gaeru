const { createTestDb } = require('./helpers/pglite-db');
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { createApp } = require("../src/app");

// Runs real PostgreSQL statements in one embedded connection. Multi-connection
// locking and production integrations still require a separate staging run.

test('marketing integrates customer ownership, quota, discounts, cancellation, campaigns and permissions',{timeout:60000},async context=>{
const { pool, close: closeDb } = await createTestDb();
  const app=createApp({config:{NODE_ENV:'test',SESSION_SECRET:randomBytes(48).toString('hex'),ADMIN_USERNAME:'marketing-owner',ADMIN_PASSWORD_HASH:bcrypt.hashSync('Marketing-owner-password',4),STORE_ORDERS_ENABLED:true},pool,sessionStore:new session.MemoryStore()});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));context.after(async()=>{await new Promise(r=>server.close(r));await closeDb();});const base='http://127.0.0.1:'+server.address().port;
  function client() {
    let cookie = "", csrf = "";
    const api = {
      async request(url, method = "GET", body) {
        const response = await fetch(base + url, { method, headers: { Cookie: cookie, ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}), ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
        const updatedCookie = response.headers.get("set-cookie");
        if (updatedCookie) cookie = updatedCookie.split(";")[0];
        const data = response.status === 204 ? null : response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text();
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: response.status, data };
      },
      async ok(url, method = "GET", body, expected = 200) {
        const response = await api.request(url, method, body);
        assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(response.data)}`);
        return response.data;
      },
      async login(username, password) { await api.ok("/api/csrf"); return api.ok("/api/auth/login", "POST", { username, password }); }
    };
    return api;
  }

const owner=client(),first=client(),second=client(),guest=client();await owner.login('marketing-owner','Marketing-owner-password');
await context.test('banner uploads enforce permissions, file limits and scheduled buyer visibility',async()=>{
 const png=await require('sharp')({create:{width:16,height:16,channels:4,background:{r:20,g:100,b:200,alpha:.8}}}).png().toBuffer();
 const file=(bytes,type)=>{const form=new FormData();form.append('image',new Blob([bytes],{type}),'banner.png');return form;};
 assert.equal((await guest.request('/api/gaeru_ceo/marketing/banners','POST',file(png,'image/png'))).status,401);
 assert.equal((await owner.request('/api/gaeru_ceo/marketing/banners','POST',file(Buffer.from('<svg></svg>'),'image/png'))).status,400);
 assert.equal((await owner.request('/api/gaeru_ceo/marketing/banners','POST',file(Buffer.alloc(5*1024*1024+1),'image/png'))).status,400);
 const image=await owner.ok('/api/gaeru_ceo/marketing/banners','POST',file(png,'image/png'),201);
 await owner.ok('/api/gaeru_ceo/marketing/banners/'+image.id);
 assert.equal((await guest.request('/api/customer/marketing/banners/'+image.id)).status,401);
 const campaign={title:'Banner fixture',body:'Banner campaign fixture',voucherId:null,bannerId:image.id,startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),active:false};
 const saved=(await owner.ok('/api/gaeru_ceo/marketing/campaigns','POST',{data:campaign},201)).item;assert.equal(saved.banner_id,image.id);
 const changed=(await owner.ok('/api/gaeru_ceo/marketing/campaigns/'+saved.id,'PUT',{data:{...campaign,bannerId:null},version:1})).item;assert.equal(changed.banner_id,null);
 assert.equal((await owner.request('/api/gaeru_ceo/marketing/campaigns/'+saved.id,'PUT',{data:campaign,version:1})).status,409);
 assert.equal((await owner.request('/api/gaeru_ceo/marketing/campaigns','POST',{data:{...campaign,bannerId:'https://bad.test/image'}})).status,400);
});
const summary=await owner.ok('/api/gaeru_ceo/summary');assert.equal(summary.ordersEnabled,true);assert.equal(typeof summary.orders.total,'number');
const payload={slug:'marketing-test',name:'Marketing product',category:'audio',descriptor:'Fixture',description:'',imageUrl:'/assets/products/k9.png',imageAlt:'Fixture',active:false,sortOrder:0};const product=await owner.ok('/api/gaeru_ceo/products','POST',payload,201);const variant=await owner.ok('/api/gaeru_ceo/products/'+product.id+'/variants','POST',{sku:'MARKET-TEST',name:'Test',options:{},priceVnd:100000,stockQuantity:100,active:true},201);await owner.ok('/api/gaeru_ceo/products/'+product.id,'PUT',{...payload,active:true});await owner.ok('/api/gaeru_ceo/settings','PUT',{shippingNote:'Fixture',shippingRates:{'Hồ Chí Minh':10000}});
const password='Marketing-customer-password';const hash=bcrypt.hashSync(password,4);const ids=[];for(let i=1;i<=2;i++)ids.push((await pool.query('INSERT INTO customers(full_name,email,phone,password_hash) VALUES($1,$2,$3,$4) RETURNING id',['Buyer '+i,'marketing'+i+'@example.test','090000000'+i,hash])).rows[0].id);for(const [index,user]of [first,second].entries()){await user.ok('/api/csrf');await user.ok('/api/customer-auth/login','POST',{identifier:'marketing'+(index+1)+'@example.test',password});}
const voucher={code:'TEST25',title:'Test discount',kind:'percent',amount:25,maxDiscountVnd:30000,minSpendVnd:100000,startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),totalLimit:1,perCustomerLimit:1,publicClaim:true,active:true};
let v;await context.test('voucher validation and claim ownership',async()=>{assert.equal((await owner.request('/api/gaeru_ceo/marketing/vouchers','POST',{data:{...voucher,amount:101}})).status,400);v=(await owner.ok('/api/gaeru_ceo/marketing/vouchers','POST',{data:voucher},201)).item;await guest.ok('/api/csrf');assert.equal((await guest.request('/api/customer/marketing')).status,401);for(const c of [first,second])await c.ok('/api/customer/marketing/claim','POST',{code:'test25'});await first.ok('/api/customer/marketing/claim','POST',{code:'TEST25'});assert.equal((await first.ok('/api/customer/marketing')).wallet.length,1);assert.equal((await first.request('/api/gaeru_ceo/marketing')).status,401);});
const cart=[{variantId:variant.id,quantity:2}];const orderBody={customer:{name:'Buyer Test',email:'marketing1@example.test',phone:'0900000001',address:'Fixture address',city:'Hồ Chí Minh',note:''},paymentMethod:'cod',items:cart,voucherCode:'TEST25'};let placed;
await context.test('server calculates capped discount and rejects reused or exhausted vouchers',async()=>{const quote=await first.ok('/api/customer/marketing/quote','POST',{code:'TEST25',items:cart});assert.equal(quote.discountVnd,30000);placed=(await first.ok('/api/orders','POST',{...orderBody,discountVnd:999999,totalVnd:1},201)).order;assert.equal(placed.totalVnd,180000);assert.equal(placed.discountVnd,30000);assert.equal((await first.request('/api/orders','POST',orderBody)).status,409);assert.equal((await second.request('/api/orders','POST',orderBody)).status,409);const stored=(await pool.query('SELECT subtotal_vnd,discount_vnd,total_vnd FROM orders WHERE id=$1',[placed.id])).rows[0];assert.deepEqual(stored,{subtotal_vnd:200000,discount_vnd:30000,total_vnd:180000});});
let secondOrder;await context.test('cancel returns quota once and preserves monetary snapshot after voucher edits',async()=>{await owner.ok('/api/gaeru_ceo/orders/'+placed.id,'PATCH',{status:'cancelled'});await owner.ok('/api/gaeru_ceo/orders/'+placed.id,'PATCH',{status:'cancelled'});secondOrder=(await second.ok('/api/orders','POST',orderBody,201)).order;await owner.ok('/api/gaeru_ceo/marketing/vouchers/'+v.id,'PUT',{data:{...voucher,amount:50,active:false},version:1});assert.equal((await owner.request('/api/gaeru_ceo/marketing/vouchers/'+v.id,'PUT',{data:voucher,version:1})).status,409);await owner.ok('/api/gaeru_ceo/orders/'+secondOrder.id,'PATCH',{shippingFeeVnd:20000});const updated=(await second.ok('/api/customer/orders/'+secondOrder.id)).order;assert.equal(updated.discountVnd,30000);assert.equal(updated.totalVnd,190000);const receivables=(await owner.ok('/api/gaeru_ceo/finance/receivables')).receivables;assert.equal(receivables.find(r=>r.id===secondOrder.id).outstandingVnd,190000);assert.equal((await first.request('/api/customer/orders/'+secondOrder.id)).status,404);});
await context.test('private grants and campaign read state are isolated per account',async()=>{const banner=(await pool.query('SELECT id FROM marketing_banner_images LIMIT 1')).rows[0];assert.equal((await first.request('/api/customer/marketing/banners/'+banner.id)).status,404);const preview=(await owner.ok('/api/gaeru_ceo/marketing/campaigns','POST',{data:{title:'Visible banner',body:'Visible banner fixture',voucherId:null,bannerId:banner.id,startsAt:voucher.startsAt,endsAt:voucher.endsAt,active:true}},201)).item;await first.ok('/api/customer/marketing/banners/'+banner.id);assert.equal((await first.ok('/api/customer/marketing')).campaigns.find(c=>c.id===preview.id).banner_id,banner.id);await owner.ok('/api/gaeru_ceo/marketing/campaigns/'+preview.id,'PUT',{version:1,data:{title:'Visible banner',body:'Visible banner fixture',voucherId:null,bannerId:banner.id,startsAt:voucher.startsAt,endsAt:voucher.endsAt,active:false}});assert.equal((await first.request('/api/customer/marketing/banners/'+banner.id)).status,404);const privateVoucher=(await owner.ok('/api/gaeru_ceo/marketing/vouchers','POST',{data:{...voucher,code:'PRIVATE10',kind:'fixed',amount:10000,publicClaim:false,totalLimit:10}},201)).item;assert.equal((await first.request('/api/customer/marketing/claim','POST',{code:'PRIVATE10'})).status,409);await owner.ok('/api/gaeru_ceo/marketing/vouchers/'+privateVoucher.id+'/grants','POST',{email:'marketing1@example.test'});assert.ok((await first.ok('/api/customer/marketing')).wallet.some(x=>x.code==='PRIVATE10'));assert.ok(!(await second.ok('/api/customer/marketing')).wallet.some(x=>x.code==='PRIVATE10'));const c=(await owner.ok('/api/gaeru_ceo/marketing/campaigns','POST',{data:{title:'Test campaign',body:'Promotion for signed-in customers.',voucherId:null,startsAt:voucher.startsAt,endsAt:voucher.endsAt,active:true}},201)).item;await first.ok('/api/customer/marketing/campaigns/'+c.id+'/read','POST',{version:c.version});assert.equal((await first.ok('/api/customer/marketing')).campaigns[0].read,true);assert.notEqual((await second.ok('/api/customer/marketing')).campaigns[0].read,true);});
await context.test('marketing viewers cannot publish and future vouchers cannot be redeemed',async()=>{await owner.ok('/api/gaeru_ceo/staff','POST',{username:'marketing-viewer',fullName:'Marketing Viewer',password:'Viewer-password-2026',role:'viewer'},201);const viewer=client();await viewer.login('marketing-viewer','Viewer-password-2026');assert.equal((await viewer.request('/api/gaeru_ceo/marketing')).status,200);assert.equal((await viewer.request('/api/gaeru_ceo/marketing/banners','POST',{})).status,403);assert.equal((await viewer.request('/api/gaeru_ceo/marketing/vouchers','POST',{data:voucher})).status,403);const future=(await owner.ok('/api/gaeru_ceo/marketing/vouchers','POST',{data:{...voucher,code:'FUTURE10',startsAt:new Date(Date.now()+3600000).toISOString(),totalLimit:10}},201)).item;await owner.ok('/api/gaeru_ceo/marketing/vouchers/'+future.id+'/grants','POST',{email:'marketing1@example.test'});assert.equal((await first.request('/api/customer/marketing/quote','POST',{code:'FUTURE10',items:cart})).status,409);});


await context.test('scheduled product promotions choose best price and preserve checkout snapshots',async()=>{
 const promo={title:'Flash fixture',type:'flash',kind:'percent',amount:20,startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),active:true,variantIds:[variant.id]};
 assert.equal((await owner.request('/api/gaeru_ceo/marketing/promotions','POST',{data:{...promo,amount:101}})).status,400);
 assert.equal((await owner.request('/api/gaeru_ceo/marketing/promotions','POST',{data:{...promo,variantIds:[]}})).status,400);
 assert.equal((await owner.request('/api/gaeru_ceo/marketing/promotions','POST',{data:{...promo,variantIds:[randomUUID()]}})).status,409);
 const flash=(await owner.ok('/api/gaeru_ceo/marketing/promotions','POST',{data:promo},201)).item;
 await owner.ok('/api/gaeru_ceo/marketing/promotions','POST',{data:{...promo,title:'Smaller discount',type:'discount',kind:'fixed',amount:10000}},201);
 await owner.ok('/api/gaeru_ceo/marketing/promotions','POST',{data:{...promo,title:'Future discount',amount:90,startsAt:new Date(Date.now()+600000).toISOString()}},201);
 let catalog=await guest.ok('/api/products');let priced=catalog.products.find(p=>p.id===product.id).variants[0];assert.equal(priced.priceVnd,80000);assert.equal(priced.originalPriceVnd,100000);assert.equal(priced.promotion.id,flash.id);
 const adminProducts=await owner.ok('/api/gaeru_ceo/products');assert.equal(adminProducts.products.find(p=>p.id===product.id).variants[0].priceVnd,100000);
 const offer={...voucher,code:'SALE10',kind:'fixed',amount:10000,minSpendVnd:0,totalLimit:10};await owner.ok('/api/gaeru_ceo/marketing/vouchers','POST',{data:offer},201);await first.ok('/api/customer/marketing/claim','POST',{code:'SALE10'});
 const quote=await first.ok('/api/customer/marketing/quote','POST',{code:'SALE10',items:cart});assert.equal(quote.subtotalVnd,160000);assert.equal(quote.discountVnd,10000);
 assert.equal((await first.request('/api/orders','POST',{...orderBody,voucherCode:'SALE10',expectedSubtotalVnd:200000})).status,409);
 const order=(await first.ok('/api/orders','POST',{...orderBody,voucherCode:'SALE10',expectedSubtotalVnd:160000},201)).order;assert.equal(order.subtotalVnd,160000);assert.equal(order.totalVnd,160000);
 const line=(await pool.query('SELECT unit_price_vnd,original_price_vnd,promotion_snapshot FROM order_items WHERE order_id=$1',[order.id])).rows[0];assert.equal(line.unit_price_vnd,80000);assert.equal(line.original_price_vnd,100000);assert.equal(line.promotion_snapshot.id,flash.id);
 await owner.ok('/api/gaeru_ceo/marketing/promotions/'+flash.id,'PUT',{data:{...promo,active:false},version:1});assert.equal((await owner.request('/api/gaeru_ceo/marketing/promotions/'+flash.id,'PUT',{data:promo,version:1})).status,409);
 catalog=await guest.ok('/api/products');assert.equal(catalog.products.find(p=>p.id===product.id).variants[0].priceVnd,90000);
 await pool.query("UPDATE product_promotions SET ends_at=now()-interval '1 second',starts_at=now()-interval '1 day' WHERE active=true");
 catalog=await guest.ok('/api/products');priced=catalog.products.find(p=>p.id===product.id).variants[0];assert.equal(priced.priceVnd,100000);assert.equal(priced.promotion,null);
 assert.equal((await pool.query('SELECT unit_price_vnd FROM order_items WHERE order_id=$1',[order.id])).rows[0].unit_price_vnd,80000);
 const viewer=client();await viewer.login('marketing-viewer','Viewer-password-2026');assert.equal((await viewer.request('/api/gaeru_ceo/marketing/promotions','POST',{data:promo})).status,403);
 const listing=await owner.ok('/api/gaeru_ceo/marketing');assert.equal(listing.promotions.length,3);assert.ok((await owner.ok('/api/gaeru_ceo/marketing/promotion-products')).variants.some(v=>v.id===variant.id));
});
});
