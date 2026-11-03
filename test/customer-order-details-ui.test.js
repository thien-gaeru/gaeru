'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');

async function fixture(){
 const {window,document}=parseHTML(`<html><body><div data-account-profile><div class="account-overview-card"><h3 data-customer-name>Fixture Buyer</h3><span data-customer-email>buyer@example.invalid</span><span data-customer-phone>0912345678</span><div id="account-addresses"><div data-address-list></div><details open><form data-address-form><input name="label" type="hidden" value="Nhà"><input name="fullName"><input name="phone"><input name="address"><input name="city"><input type="checkbox" name="isDefault"><button type="button" data-picker-back>Tỉnh / thành phố</button><button data-address-submit>Lưu địa chỉ</button></form></details><p data-address-status></p></div></div></div></body></html>`);
 Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){return Object.fromEntries([...this.querySelectorAll('[name]')].map(e=>[e.name,e]));}});
 const calls=[],order={id:'order-1',orderNumber:'VIRTUAL-ORDER-1',status:'completed',paymentStatus:'paid',paymentMethod:'cod',customerName:'Fixture Buyer',phone:'0912345678',address:'123 Fixture',city:'Hà Nội',createdAt:new Date().toISOString(),totalVnd:120000,subtotalVnd:100000,shippingFeeVnd:20000,items:[{productName:'Fixture Mic',variantName:'Type C',quantity:1,lineTotalVnd:100000}]};
 const address={id:'address-1',label:'Nhà',fullName:'Fixture Buyer',phone:'0912345678',address:'123 Fixture',city:'Hà Nội',isDefault:true};
 const fetch=async(url,options={})=>{calls.push({url,options});let result;if(url==='/api/csrf')result={csrfToken:'fixture'};else if(url==='/api/customer/addresses')result={addresses:[address]};else if(url==='/api/customer/profile')result={customer:{fullName:JSON.parse(options.body).fullName}};else if(url.startsWith('/api/customer/warranties'))result={activations:[],today:'2026-11-03'};else if(url==='/api/customer/orders?page=1')result={orders:[order]};else if(url==='/api/customer/orders/order-1')result={order};else if(url==='/api/customer/orders/order-1/after-sales')result={cases:[{rmaNumber:'RMA-VIRTUAL-01',status:'requested',returnType:'exchange',reason:'Virtual return'}]};else if(url==='/api/rma/RMA-VIRTUAL-01')result={rma:{inbound:{status:'pending_shipment',warehouseAddress:{facility:'Fixture warehouse',address:'Virtual address',contactPhone:'0900000000'}},outbound:{}}};else if(url.endsWith('/inbound'))result={message:'Đã lưu vận đơn',rma:{inboundStatus:'in_transit',inboundTrackingNumber:'VIRTUAL-123'}};else result={};return {ok:true,status:200,json:async()=>result};};
 window.GAERUAddress={setAddress(){},setValue:(node,value)=>{node.value=value;},getAddress:form=>form.elements.address.value};
 const observers=[];
 const context={window,document,fetch,console,Intl,CustomEvent:window.CustomEvent,MutationObserver:class{constructor(fn){observers.push(fn);}observe(){}},FormData:class{constructor(form){this.values=[...form.querySelectorAll('[name]')].map(e=>[e.name,e.value]);}[Symbol.iterator](){return this.values[Symbol.iterator]();}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../customer-experience.js'),'utf8'),context);await flush();
 return {window,document,calls,order,address,rebuild:async()=>{document.querySelector('[data-address-book]').remove();observers[0]();await flush();}};
}
async function flush(){await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));}

test('customer order details resolve the enclosing card, show RMA and save inbound tracking',async()=>{
 const ui=await fixture(),button=ui.document.querySelector('[data-order-detail]'),target=ui.document.querySelector('[data-detail-for]');
 assert.equal(button.parentElement.querySelector('[data-detail-for]'),null,'nested action toolbar must not be mistaken for the card');
 button.click();await flush();assert.equal(target.hidden,false);assert.equal(button.getAttribute('aria-expanded'),'true');assert.match(target.textContent,/Fixture Mic/);assert.match(target.textContent,/RMA-VIRTUAL-01/);assert.match(target.textContent,/Fixture warehouse/);
 const form=target.querySelector('.account-rma-cases form');form.elements.inboundCarrier.value='Virtual carrier';form.elements.inboundTrackingNumber.value='VIRTUAL-123';await form.onsubmit({preventDefault(){}});
 const save=ui.calls.find(c=>c.url.endsWith('/inbound'));assert.deepEqual(JSON.parse(save.options.body),{inboundCarrier:'Virtual carrier',inboundTrackingNumber:'VIRTUAL-123'});assert.equal(save.options.headers['X-CSRF-Token'],'fixture');assert.match(target.textContent,/Đã lưu vận đơn/);assert.match(target.querySelector('[data-rma-inbound-status]').textContent,/Đang gửi về kho.*VIRTUAL-123/);
 button.click();assert.equal(target.hidden,true);assert.equal(button.getAttribute('aria-expanded'),'false');
});

test('missing customer detail panel fails gracefully and does not request another order',async()=>{
 const ui=await fixture();ui.document.querySelector('[data-detail-for]').remove();const before=ui.calls.length;ui.document.querySelector('[data-order-detail]').click();await flush();assert.equal(ui.calls.length,before);assert.match(ui.document.querySelector('[data-address-status]').textContent,/Chưa mở được chi tiết đơn/);
});

test('address editing keeps the submit action independent of administrative picker controls',async()=>{
 const ui=await fixture(),form=ui.document.querySelector('[data-address-form]'),picker=form.querySelector('[data-picker-back]'),submit=form.querySelector('[data-address-submit]');
 form.reset=()=>{};ui.document.querySelector('[data-edit-address]').click();assert.equal(submit.textContent,'Cập nhật địa chỉ');assert.equal(picker.textContent,'Tỉnh / thành phố');form.querySelector('button:last-child').click();assert.equal(submit.textContent,'Lưu địa chỉ');assert.equal(picker.textContent,'Tỉnh / thành phố');
 form.elements.fullName.value='Fixture Buyer';form.elements.phone.value='0912345678';form.elements.address.value='123 Fixture';form.elements.city.value='Hà Nội';form.dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));await flush();assert.equal(submit.disabled,false);assert.equal(picker.textContent,'Tỉnh / thành phố');assert.ok(ui.calls.some(c=>c.url==='/api/customer/addresses'&&c.options.method==='POST'));
});

test('customer workspace rebuild does not multiply address submit or cancel handlers',async()=>{
 const ui=await fixture(),form=ui.document.querySelector('[data-address-form]');form.reset=()=>{};await ui.rebuild();await ui.rebuild();
 assert.equal([...form.querySelectorAll('button')].filter(b=>b.textContent==='Hủy chỉnh sửa').length,1);
 form.elements.fullName.value='Fixture Buyer';form.elements.phone.value='0912345678';form.elements.address.value='123 Fixture';form.elements.city.value='Hà Nội';
 form.dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));await flush();assert.equal(ui.calls.filter(c=>c.url==='/api/customer/addresses'&&c.options.method==='POST').length,1);
});

test('profile form is replaced during workspace rebuild and submits only once',async()=>{
 const ui=await fixture(),old=ui.document.querySelector('[data-profile-form]');await ui.rebuild();await ui.rebuild();const form=ui.document.querySelector('[data-profile-form]');assert.notEqual(form,old);assert.equal(old.isConnected,false);assert.equal(ui.document.querySelectorAll('[data-profile-form]').length,1);form.elements.fullName.value='Updated Fixture Buyer';form.dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));await flush();assert.equal(ui.calls.filter(c=>c.url==='/api/customer/profile'&&c.options.method==='PATCH').length,1);assert.equal(ui.document.querySelector('[data-customer-name]').textContent,'Updated Fixture Buyer');
});
