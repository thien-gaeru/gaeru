const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {createOrderPrint,renderOrderPrint,due,labelFits}=require('../src/order-print');
const one='62f26d55-a348-4fd0-a5d8-c2ea3e6d9bd0',two='bf722c58-8797-47f6-bb4e-4222bf3fb4a4';
const order={id:one,orderNumber:'GR-FIXTURE',customerName:'Fixture Buyer',phone:'0900000000',address:'Fixture Address',city:'Hà Nội',email:'fixture@example.invalid',status:'processing',paymentMethod:'cod',paymentStatus:'pending',createdAt:'2026-10-26T00:00:00Z',subtotalVnd:100000,discountVnd:0,shippingFeeVnd:20000,totalVnd:120000,receivedVnd:20000,carrierName:'GHN',items:[{productName:'GAERU M3',variantName:'Type C',sku:'M3-C',quantity:1,lineTotalVnd:100000}]};
test('print rendering escapes buyer and item content and preserves separate invoice/label page sizes',()=>{
 const fixture={...order,customerName:'<img src=x onerror=alert(1)>',address:'<script>alert(1)</script>',items:[{...order.items[0],productName:'<b>unsafe</b>'}]};
 const html=renderOrderPrint([fixture,{...order,id:two}], 'invoice');
 assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes('<script>alert'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('&lt;b&gt;unsafe&lt;/b&gt;'));
 assert.match(html,/@page\{size:A4/);assert.equal((html.match(/class="sheet invoice"/g)||[]).length,2);assert.match(html,/break-after:page/);assert.match(html,/data-print-orders/);assert.match(html,/\/gaeru_ceo\/assets\/order-print.js/);
 const label=renderOrderPrint([order], 'label');assert.match(label,/size:100mm 150mm/);assert.match(label,/Tem giao hàng GAERU/);assert.match(label,/Không thay thế nhãn/);assert.match(label,/100\.000 ₫/);assert.match(label,/Khách chọn: GHN/);assert.doesNotMatch(label,/barcode|tracking_number/);assert.equal(labelFits(order),true);assert.equal(labelFits({...order,address:'Địa chỉ rất dài '.repeat(80)}),false);const crowded=renderOrderPrint([{...order,items:Array(20).fill({...order.items[0],productName:'Tên rất dài '.repeat(40)})}],'label');assert.match(crowded,/Và 18 dòng hàng khác/);assert.equal((crowded.match(/<li>/g)||[]).length,2);
});
test('COD excludes paid orders, online payments and money already collected',()=>{
 assert.equal(due(order),100000);assert.equal(due({...order,paymentStatus:'paid'}),0);assert.equal(due({...order,paymentMethod:'bank_transfer'}),0);assert.equal(due({...order,receivedVnd:150000}),0);
});
test('print endpoint enforces permissions, CSRF, selection limit, complete eligibility and known label totals',async t=>{
 let rows=[order],calls=0;const pool={async query(sql,values){calls++;assert.match(sql,/NOT EXISTS\(SELECT 1 FROM order_reviews/);assert.match(sql,/order_shipping_selection/);assert.deepEqual(values,[[one]]);return {rows};}};
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.session={csrfToken:'fixture'};if(req.headers['x-role'])req.admin={permissions:req.headers['x-role']==='read'?['orders.read']:[]};next();});app.use(createOrderPrint(pool));app.use((e,req,res,next)=>res.status(500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const post=(body={ids:[one],format:'invoice'},role='read',csrf='fixture')=>fetch(base+'/orders/print',{method:'POST',headers:{'Content-Type':'application/json',...(role?{'X-Role':role}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body:JSON.stringify(body)});
 assert.equal((await post(undefined,null)).status,401);assert.equal((await post(undefined,'none')).status,403);assert.equal((await post(undefined,'read',null)).status,403);
 for(const body of [{ids:[],format:'invoice'},{ids:[one,one],format:'invoice'},{ids:Array(101).fill(one),format:'label'},{ids:['not-uuid'],format:'invoice'},{ids:[one],format:'official-carrier'}])assert.equal((await post(body)).status,400);
 assert.equal(calls,0);let response=await post();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-type'),/text\/html/);assert.match(await response.text(),/GR-FIXTURE/);
 rows=[];assert.equal((await post()).status,409);rows=[{...order,status:'cancelled'}];assert.equal((await post({ids:[one],format:'label'})).status,409);rows=[{...order,totalVnd:null}];assert.equal((await post({ids:[one],format:'label'})).status,409);rows=[{...order,address:'Long address '.repeat(100)}];assert.equal((await post({ids:[one],format:'label'})).status,409);
});
