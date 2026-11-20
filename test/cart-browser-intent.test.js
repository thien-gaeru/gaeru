const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { createCustomerCartRouter } = require('../src/customer-cart');
const { createStoreApi } = require('../src/store-api');

function deviceStorage() {
  const values=new Map();
  return {
    get length(){return values.size;},
    key:n=>[...values.keys()][n],
    getItem:k=>values.get(k)??null,
    setItem:(k,v)=>values.set(k,String(v)),
    removeItem:k=>values.delete(k)
  };
}
const commerce=fs.readFileSync(path.join(__dirname,'../commerce.js'),'utf8');
function cartTab(localStorage,session,fetcher,locks) {
  const window={GAERUCustomerSession:session};
  const ctx=vm.createContext({localStorage,sessionStorage:deviceStorage(),window,fetch:fetcher,navigator:{locks},
    document:{dispatchEvent(){},querySelector(){return null;}},crypto:webcrypto,TextEncoder,URLSearchParams,
    clearTimeout,setTimeout:()=>0,FormData,Headers,CustomEvent,console:{error(){},warn(){}}});
  vm.runInContext(commerce.slice(0,commerce.indexOf('function cartRows(')),ctx);
  return ctx;
}

test('browser cart scopes, two tabs, replay after a lost response and checkout recovery',async t=>{
  const db=await PGlite.create();
  const pool={
    async query(sql,values){
      const result=!values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql,values);
      return {...result,rows:result?.rows||[],rowCount:result?.affectedRows??result?.rows?.length??0};
    },
    async connect(){return {query:pool.query,release(){}};}
  };
  t.after(()=>db.close());await migrateDatabase(pool);
  const insert=async(sql,params)=> (await pool.query(sql,params)).rows[0].id;
  const a=await insert("INSERT INTO customers(email,full_name,active) VALUES ('first@example.invalid','Alice',true) RETURNING id");
  const b=await insert("INSERT INTO customers(email,full_name,active) VALUES ('other@example.invalid','Bob',true) RETURNING id");
  const p=await insert("INSERT INTO products(name,slug,category,active) VALUES ('Fixture','cart-fixture','audio',true) RETURNING id");
  const variant=await insert("INSERT INTO product_variants(product_id,name,sku,price_vnd,stock_quantity,active) VALUES ($1,'Fixture','CR-FIX',100000,20,true) RETURNING id",[p]);
  await pool.query("INSERT INTO store_settings(setting_key,setting_value) VALUES('shipping_rates',$1) ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1",[JSON.stringify({'Toàn quốc':20000})]);
  let customer=null;
  const app=express();app.use(express.json());
  app.use((req,res,next)=>{req.sessionID='fixture-session';req.session={csrfToken:'fixture',customer:customer?{id:customer}:null};next();});
  app.get('/api/csrf',(req,res)=>res.json({csrfToken:'fixture'}));
  app.use('/api/customer/cart',createCustomerCartRouter(pool));
  app.use('/api',createStoreApi(pool,{ordersEnabled:true}));
  app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);}));
  const base='http://127.0.0.1:'+server.address().port;
  const storage=deviceStorage(), session={customer:null};
  const switchTo=id=>{customer=id;session.customer=id?{id}:null;};
  let tail=Promise.resolve();
  const locks={request(_name,fn){const outcome=tail.then(fn);tail=outcome.catch(()=>{});return outcome;}};
  let loseResponse=false;
  const api=async(url,opts)=>{
    const res=await fetch(base+url,opts);
    if(url==='/api/customer/cart/sync' && loseResponse){loseResponse=false;await res.text();throw Error('Fixture interrupted after the server committed');}
    return res;
  };
  const one=cartTab(storage,session,api,locks),two=cartTab(storage,session,api,locks);
  const flush=async tab=>{await tab.mergeCartWithServer();await tail;};
  const quantity=tab=>tab.readCart().find(i=>i.variantId===variant)?.quantity||0;
  const count=async()=>Number((await pool.query("SELECT quantity FROM customer_cart_items WHERE customer_id=$1 AND variant_id=$2",[customer,variant])).rows[0]?.quantity||0);
  storage.setItem('gaeru-store-cart-v2',JSON.stringify([{variantId:variant,quantity:2}]));
  await pool.query("INSERT INTO customer_cart_items(customer_id,variant_id,quantity) VALUES($1,$2,2)",[a,variant]);
  switchTo(a);await flush(one);await flush(two);
  assert.equal(await count(),2);assert.equal(quantity(one),2);
  switchTo(null);assert.equal(quantity(two),0);
  assert.equal(two.writeCart([{variantId:variant,quantity:3}]),true);
  switchTo(a);loseResponse=true;await flush(one);await flush(two);
  assert.equal(await count(),5);assert.equal(quantity(two),5);
  const first=one.readCart(),second=two.readCart();first[0].quantity++;second[0].quantity++;
  one.writeCart(first);two.writeCart(second);await flush(one);await flush(two);
  assert.equal(await count(),7);assert.equal(quantity(two),7);
  switchTo(b);await flush(two);assert.equal(quantity(two),0);assert.equal(await count(),0);
  switchTo(a);await flush(one);assert.equal(quantity(one),7);

  const body={cartSource:'cart',paymentMethod:'cod',customer:{name:'Alice Fixture',email:'first@example.invalid',phone:'0900000000',address:'123 Test Street',city:'Hà Nội'},items:[{variantId:variant,quantity:2}]};
  const intent=await one.checkoutIntent(body);
  const other=await two.checkoutIntent(body);assert.equal(intent.key,other.key);
  const options={method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'fixture','X-Idempotency-Key':intent.key},body:JSON.stringify(body)};
  const guarded={...options,headers:{...options.headers,'X-Checkout-Customer':a}};
  switchTo(b);
  const switched=await api('/api/orders',guarded);
  assert.equal(switched.status,409);
  const anonymousDraft=await api('/api/orders',{...options,headers:{...options.headers,'X-Checkout-Customer':'guest'}});
  assert.equal(anonymousDraft.status,409);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n,0);
  switchTo(a);
  const firstResponse=await api('/api/orders',guarded);const result=await firstResponse.json();
  assert.equal(firstResponse.status,201,JSON.stringify(result));
  const reload=cartTab(storage,session,api,locks);
  assert.equal((await reload.checkoutIntent(body)).key,intent.key);
  const replay=await api('/api/orders',options);assert.equal((await replay.json()).order.orderNumber,result.order.orderNumber);
  const status=async()=> (await api('/api/orders/checkout-attempt',{headers:{'X-Idempotency-Key':intent.key}})).json();
  assert.equal((await status()).orderNumber,result.order.orderNumber);
  assert.equal(await count(),5);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n,1);
  switchTo(b);assert.equal((await status()).status,'unknown');
  switchTo(a);intent.complete();assert.notEqual((await one.checkoutIntent(body)).key,intent.key);
});
test('checkout clears Xu on logout and ignores an old balance after the account changes',async()=>{
  const requests=[];
  const ui={
    session:{customer:{id:'first'}},view:{isConnected:true},section:{hidden:true},available:{textContent:'0'},
    checkbox:{checked:false},updates:0,
    request:()=>new Promise(resolve=>requests.push(resolve))
  };
  const source=commerce.slice(commerce.indexOf('  let loyaltyRequestVersion='),commerce.indexOf('  loadCheckoutLoyalty();',commerce.indexOf('  let loyaltyRequestVersion=')));
  const ctx=vm.createContext({ui,Intl});
  vm.runInContext(`const form=ui.view,loyaltySection=ui.section,loyaltyAvailable=ui.available,loyaltyCheckbox=ui.checkbox;
    const window={GAERUCustomerSession:ui.session},apiRequest=ui.request,updateShippingTotal=()=>ui.updates++;
    let loyaltyPoints=0,loyaltyLoadedForId=null;
    ${source};globalThis.refresh=loadCheckoutLoyalty;`,ctx);
  ctx.refresh();ui.session.customer={id:'second'};ctx.refresh();
  requests[1]({loyalty:{pointsBalance:0}});requests[0]({loyalty:{pointsBalance:500000}});
  await new Promise(r=>setImmediate(r));assert.equal(ui.section.hidden,true);assert.equal(ui.available.textContent,'0');
  ui.session.customer={id:'third'};ctx.refresh();requests[2]({loyalty:{pointsBalance:7500}});
  await new Promise(r=>setImmediate(r));assert.equal(ui.section.hidden,false);ui.checkbox.checked=true;
  ui.session.customer=null;ctx.refresh();assert.equal(ui.section.hidden,true);assert.equal(ui.checkbox.checked,false);
  assert.equal(ui.available.textContent,'0');assert.equal(vm.runInContext('loyaltyPoints',ctx),0);
});
test('a late checkout reply never redirects or clears another customer after an account switch',async()=>{
  const {parseHTML}=require('linkedom');
  const {document,window:domWindow}=parseHTML('<html><head></head><body><main><section id="checkout-content"></section></main></body></html>');
  const root=document.querySelector('section'),html=Object.getOwnPropertyDescriptor(domWindow.Element.prototype,'innerHTML');
  Object.defineProperty(root,'innerHTML',{get(){return html.get.call(this);},set(value){
    html.set.call(this,value); const f=this.querySelector('form');if(!f)return;
    f.elements=Object.fromEntries([...f.querySelectorAll('[name]')].map(x=>[x.name,x]));
    for(const sel of f.querySelectorAll('select'))Object.defineProperty(sel,'value',{value:sel.querySelector('option')?.value||'',writable:true});
  }});
  const shared=deviceStorage(),local=deviceStorage(),redirects=[],sent=[];
  const session={customer:{id:'first'},async refresh(){}};
  const window={GAERUCustomerSession:session,addEventListener(){},GAERUCheckout:{...require('../checkout-flow'),hydrateContact(){}}};
  let acceptOrder,submitted;
  const started=new Promise(resolve=>{submitted=resolve;});
  const json=(body,status=200)=>({ok:status<400,status,json:async()=>body});
  const ctx=vm.createContext({document,window,localStorage:shared,sessionStorage:local,
    location:{search:'?variant=fixture',assign:url=>redirects.push(url)},crypto:webcrypto,TextEncoder,Headers,FormData,URLSearchParams,
    CustomEvent:domWindow.CustomEvent,setTimeout,clearTimeout,setInterval:()=>0,console,
    fetch:async(url,opts)=>{
      if(url==='/api/csrf')return json({csrfToken:'csrf-'+session.customer.id});
      if(url==='/api/settings/public')return json({ordersEnabled:true,paymentMethods:['cod'],shippingRates:{'Toàn quốc':0}});
      if(url==='/api/orders'){sent.push(opts);submitted();return new Promise(r=>{acceptOrder=r;});}
      if(url==='/api/customer/cart/sync')return json({customerId:session.customer.id,revision:0,items:[]});
      return json({});
    }});
  vm.runInContext(commerce.replace(/bindGlobalControls\(\);\s*initializeStore\(\);\s*$/,''),ctx);
  vm.runInContext("products=[{name:'QA',active:true,variants:[{id:'fixture',name:'QA',active:true,stockQuantity:3,priceVnd:100000}]}]",ctx);
  await ctx.renderCheckout();
  const form=root.querySelector('form');
  Object.assign(form.elements.city,{value:'Hà Nội'});form.elements.name.value='Alice';form.elements.phone.value='0900000000';form.elements.email.value='first@example.invalid';form.elements.address.value='Address QA';form.elements.paymentMethod.value='cod';
  form.dispatchEvent(new domWindow.Event('submit',{cancelable:true}));await started;
  assert.equal(sent[0].headers.get('X-Checkout-Customer'),'first');
  assert.equal(sent[0].headers.get('X-CSRF-Token'),'csrf-first');
  session.customer={id:'second'};document.dispatchEvent(new domWindow.Event('gaeru:customer-updated'));
  acceptOrder(json({paymentUrl:'https://pay.vnpay.vn/qa',order:{orderNumber:'QA-FIRST-CUSTOMER'}}));
  await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(redirects,[]);assert.doesNotMatch(root.textContent,/QA-FIRST-CUSTOMER/);
  assert.equal(root.querySelector('input[name=name]')?.value,'');
  assert.ok(local.getItem('gaeru-pending-checkout:first'));assert.equal(local.getItem('gaeru-pending-checkout:second'),null);
});

test('account header counts a staged guest item and loads the cart on first open',()=>{
  const {parseHTML}=require('linkedom'),{document,window:domWindow}=parseHTML('<html><head></head><body><header id="shell"><button class="bag-link"><span class="cart-count"></span></button><div data-mini-cart></div></header></body></html>');
  const storage=deviceStorage(),window={GAERUCustomerSession:{customer:{id:'alice'}},addEventListener(){}};
  storage.setItem('gaeru-store-cart-v3:alice:guest:op:1:x',JSON.stringify({id:'x',order:'1',kind:'change',items:[{variantId:'k9',quantity:1}]}));
  const shell=fs.readFileSync(path.join(__dirname,'../store-shell.js'),'utf8');
  const ctx=vm.createContext({window,document,localStorage:storage,headerRoot:document.querySelector('header'),refreshMenuProducts(){}});
  vm.runInContext(shell.slice(shell.indexOf('  const syncFallbackCartBadge'),shell.indexOf('\n}',shell.indexOf('  const syncFallbackCartBadge'))),ctx);
  assert.equal(document.querySelector('.cart-count').textContent,'1');
  vm.runInContext(shell.slice(shell.indexOf('const policyCommerceUrl'),shell.indexOf('if(policyCommerceUrl){',shell.indexOf('const policyCommerceUrl'))),ctx);
  for(let i=0;i<2;i++)document.dispatchEvent(new domWindow.Event('gaeru:cart-panel-open'));
  assert.equal(document.querySelectorAll('script[src="/commerce.js"]').length,1);
});
