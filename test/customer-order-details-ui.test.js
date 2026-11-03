'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');

async function fixture({fetchOverride,loyalty=false}={}){
 const {window,document}=parseHTML(`<html><body><div data-account-profile><div class="account-overview-card"><h3 data-customer-name>Fixture Buyer</h3><span data-customer-email>buyer@example.invalid</span><span data-customer-phone>0912345678</span><div id="account-addresses"><div data-address-list></div><details open><form data-address-form><input name="label" type="hidden" value="Nhà"><input name="fullName"><input name="phone"><input name="address"><input name="city"><input type="checkbox" name="isDefault"><button type="button" data-picker-back>Tỉnh / thành phố</button><button data-address-submit>Lưu địa chỉ</button></form></details><p data-address-status></p></div></div></div></body></html>`);
 Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){return Object.fromEntries([...this.querySelectorAll('[name]')].map(e=>[e.name,e]));}});
 if(loyalty)document.querySelector('[data-account-profile]').insertAdjacentHTML('afterbegin','<div data-account-loyalty-card hidden><span data-loyalty-points></span><p data-loyalty-benefits></p></div>');
 const calls=[],order={id:'order-1',orderNumber:'VIRTUAL-ORDER-1',status:'completed',paymentStatus:'paid',paymentMethod:'cod',customerName:'Fixture Buyer',phone:'0912345678',address:'123 Fixture',city:'Hà Nội',createdAt:new Date().toISOString(),totalVnd:120000,subtotalVnd:100000,shippingFeeVnd:20000,items:[{productName:'Fixture Mic',variantName:'Type C',quantity:1,lineTotalVnd:100000}]};
 const address={id:'address-1',label:'Nhà',fullName:'Fixture Buyer',phone:'0912345678',address:'123 Fixture',city:'Hà Nội',isDefault:true};
 const fetch=async(url,options={})=>{calls.push({url,options});let result;if(url==='/api/csrf')result={csrfToken:'fixture'};else if(url==='/api/customer/addresses')result={addresses:[address]};else if(url==='/api/customer/profile')result={customer:{fullName:JSON.parse(options.body).fullName}};else if(url.startsWith('/api/customer/warranties'))result={activations:[],today:'2026-11-03'};else if(url==='/api/customer/orders?page=1')result={orders:[order]};else if(url==='/api/customer/orders/order-1')result={order};else if(url==='/api/customer/orders/order-1/after-sales')result={cases:[{rmaNumber:'RMA-VIRTUAL-01',status:'requested',returnType:'exchange',reason:'Virtual return'}]};else if(url==='/api/rma/RMA-VIRTUAL-01')result={rma:{inbound:{status:'pending_shipment',warehouseAddress:{facility:'Fixture warehouse',address:'Virtual address',contactPhone:'0900000000'}},outbound:{}}};else if(url.endsWith('/inbound'))result={message:'Đã lưu vận đơn',rma:{inboundStatus:'in_transit',inboundTrackingNumber:'VIRTUAL-123'}};else result={};const response={ok:true,status:200,json:async()=>result};return fetchOverride?fetchOverride(url,options,response):response;};
 window.GAERUAddress={setAddress(){},setValue:(node,value)=>{node.value=value;},getAddress:form=>form.elements.address.value};
 const observers=[];
 const context={window,document,fetch,console,Intl,CustomEvent:window.CustomEvent,MutationObserver:class{constructor(fn){observers.push(fn);}observe(){}},FormData:class{constructor(form){this.values=[...form.querySelectorAll('[name]')].map(e=>[e.name,e.value]);}[Symbol.iterator](){return this.values[Symbol.iterator]();}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../customer-experience.js'),'utf8'),context);await flush();
 return {window,document,context,calls,order,address,refresh:()=>observers[0](),rebuild:async()=>{document.querySelector('[data-address-book]').remove();observers[0]();await flush();}};
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

test('late address response from a removed workspace cannot replace the current customer addresses',async()=>{
 let release,reads=0;
 const ui=await fixture({fetchOverride:(url,_options,response)=>url==='/api/customer/addresses'&&++reads===1?new Promise(resolve=>release=resolve):response});
 await ui.rebuild();assert.match(ui.document.querySelector('[data-address-list]').textContent,/Fixture Buyer/);
 release({ok:true,status:200,json:async()=>({addresses:[{...ui.address,fullName:'PREVIOUS CUSTOMER PRIVATE ADDRESS'}]})});await flush();
 assert.doesNotMatch(ui.document.querySelector('[data-address-list]').textContent,/PREVIOUS CUSTOMER/);
});

test('loyalty reads are limited to one per workspace even while unavailable',async()=>{
 let release;
 const ui=await fixture({loyalty:true,fetchOverride:(url,_options,response)=>url==='/api/customer/loyalty'?new Promise(resolve=>release=resolve):response});
 for(let n=0;n<5;n++)ui.refresh();await flush();
 assert.equal(ui.calls.filter(call=>call.url==='/api/customer/loyalty').length,1);
 release({ok:false,status:503,json:async()=>({error:'Fixture unavailable'})});await flush();
 for(let n=0;n<5;n++)ui.refresh();await flush();
 assert.equal(ui.calls.filter(call=>call.url==='/api/customer/loyalty').length,1);
});

test('a rebuilt workspace clears a previous edited address before it becomes usable again',async()=>{
 const ui=await fixture(),form=ui.document.querySelector('[data-address-form]');
 form.reset=()=>{for(const input of form.querySelectorAll('input')){input.value='';input.checked=false;}};
 ui.document.querySelector('[data-edit-address]').click();assert.equal(form.elements.fullName.value,'Fixture Buyer');
 await ui.rebuild();assert.equal(form.elements.fullName.value,'');assert.equal(form.elements.address.value,'');
});

test('an address action waiting for CSRF cannot submit after its customer workspace is replaced',async()=>{
 let release;
 const ui=await fixture({fetchOverride:(url,_options,response)=>url==='/api/csrf'?new Promise(resolve=>release=resolve):response});
 const form=ui.document.querySelector('[data-address-form]');form.reset=()=>{};
 form.elements.fullName.value='Previous customer';form.elements.phone.value='0912345678';form.elements.address.value='Previous private address';form.elements.city.value='Hà Nội';
 form.dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));await flush();await ui.rebuild();
 release({ok:true,status:200,json:async()=>({csrfToken:'new-session'})});await flush();
 assert.equal(ui.calls.filter(call=>call.url==='/api/customer/addresses'&&call.options.method==='POST').length,0);
});

test('order and warranty histories preserve the two newest cards and append older pages without duplication',async()=>{
 const makeOrders=(count,start=0)=>Array.from({length:count},(_,i)=>({id:'order-'+(start+i),orderNumber:'VIRTUAL-'+(start+i),status:'completed',paymentStatus:'paid',totalVnd:100000}));
 const makeWarranties=(count,start=0)=>Array.from({length:count},(_,i)=>({productName:'Fixture '+(start+i),variantName:'Type C',status:'active',orderNumber:'VIRTUAL-'+(start+i),purchaseDate:'2026-10-01',expiresOn:'2027-10-01'}));
 const ui=await fixture({fetchOverride:(url,_options,response)=>{
   if(url.startsWith('/api/customer/orders?page='))return {ok:true,status:200,json:async()=>({orders:url.endsWith('=1')?makeOrders(20):makeOrders(3,20)})};
   if(url.startsWith('/api/customer/warranties?page='))return {ok:true,status:200,json:async()=>({activations:url.endsWith('=1')?makeWarranties(20):makeWarranties(3,20)})};
   return response;
 }});
 for(const [type,list,more]of [['order','[data-customer-orders]','[data-orders-more]'],['warranty','[data-account-warranties]','[data-warranties-more]']]){
   const history=ui.document.querySelector('[data-'+type+'-history]'),older=ui.document.querySelector('[data-'+type+'-older]');
   assert.equal(ui.document.querySelector(list).children.length,2);assert.equal(older.children.length,18);assert.equal(history.hidden,false);
   history.open=true;ui.document.querySelector(more).click();await flush();
   assert.equal(ui.document.querySelector(list).children.length,2);assert.equal(older.children.length,21);assert.equal(history.open,true);assert.equal(ui.document.querySelector(more).hidden,true);
 }
});

test('settings shortcuts wait for security loading, then open and focus the requested section',async()=>{
 let release;
 const ui=await fixture({fetchOverride:(url,_options,response)=>url==='/api/account-security/settings'?new Promise(resolve=>release=resolve):response});
 ui.window.HTMLElement.prototype.showModal=function(){this.open=true;};
 ui.window.HTMLElement.prototype.close=function(){this.open=false;this.dispatchEvent(new ui.window.Event('close'));};
 const movements=[];ui.window.HTMLElement.prototype.scrollIntoView=function(options){movements.push({node:this,options});};
 let focused;ui.window.HTMLElement.prototype.focus=function(){focused=this;};
 ui.window.matchMedia=()=>({matches:true});
 vm.runInNewContext(fs.readFileSync(require.resolve('../account-security.js'),'utf8'),ui.context);
 ui.window.GAERUAccountSettings.open();const editor=ui.document.querySelector('[data-profile-form]').closest('details');editor.dispatchEvent(new ui.window.Event('toggle'));
 movements.length=0;ui.document.querySelector('[data-settings-jump=password]').click();
 assert.equal(ui.document.querySelector('[data-profile-form]').hidden,true);
 assert.equal(movements.length,0,'the shortcut must survive a still-pending settings request');
 release({ok:true,status:200,json:async()=>({method:'off',recoveryCodesRemaining:0})});await flush();
 const password=ui.document.querySelector('[data-security-section=password]');
 assert.equal(password.open,true);assert.equal(password.hidden,false);assert.equal(focused.name,'newPassword');assert.equal(movements.at(-1).options.behavior,'auto');
 password.dispatchEvent(new ui.window.Event('toggle'));assert.equal(password.querySelector('.security-identity').hidden,false);
 ui.document.querySelector('[data-settings-jump=factor]').click();
 const factor=ui.document.querySelector('[data-security-section=factor]');factor.dispatchEvent(new ui.window.Event('toggle'));
 assert.equal(factor.open,true);assert.equal(password.hidden,true);assert.equal(password.open,false);assert.equal(focused.name,'method');assert.ok(factor.querySelector('.security-identity'));
 ui.document.querySelector('[data-settings-close]').click();
 assert.equal(ui.document.querySelector('[data-account-settings-dialog]').open,false);
});
