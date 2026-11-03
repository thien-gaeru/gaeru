'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{parseHTML}=require('linkedom');
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};

async function fixture(overrides={},permissions=['orders.write','payments.write'],hooks={}){
 const {document,window}=parseHTML('<html><body><input id="order-filter" value="completed"><div id="order-workspace"></div><section id="after-sales-panel" hidden><button data-after-sales-refresh></button><div id="after-sales-list"></div></section></body></html>');
 Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){return new Proxy({},{get:(_,name)=>this.querySelector('[name="'+String(name)+'"]')});}});
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){const options=[...this.querySelectorAll('option')];return (options.find(option=>option.hasAttribute('selected'))||options[0])?.getAttribute('value')||'';},set(value){for(const option of this.querySelectorAll('option'))option.toggleAttribute('selected',option.getAttribute('value')===String(value));}});
 const record={id:'isolated-rma',order_number:'VIRTUAL-ORDER',kind:'return',return_type:'refund',status:'received',version:3,payment_status:'paid',refundable_amount_vnd:'150000',customer_name:'Virtual Customer',phone:'0912345678',reason:'Fixture return reason',inbound_status:'delivered_to_warehouse',...overrides};
 const allowed=new Set(permissions),writes=[],messages=[];
 window.GAERUAdmin={can:permission=>allowed.has(permission),showGlobal:(message,error)=>messages.push({message,error}),request:async(url,options={})=>{
  if(options.method){writes.push({url,body:JSON.parse(options.body)});if(hooks.write)return hooks.write(url,options);return {settlementScope:'manual_refund_recorded'};}
  if(url.endsWith('/exchange-options'))return hooks.exchangeOptions;
  return {cases:[record]};
 }};
 vm.runInNewContext(fs.readFileSync(require.resolve('../admin/after-sales.js'),'utf8'),{window,document,encodeURIComponent,Intl});
 await window.GAERUAfterSales.open();
 return {document,window,writes,messages,allowed,record,async submit(form){form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await flush();},async exchange(){document.querySelector('[data-load-exchange]').click();await flush();}};
}

test('paid return closure requires deliberate evidence and submits one exact manual refund record',async()=>{
 const ui=await fixture(),form=ui.document.querySelector('[data-case]');
 assert.equal(form.querySelector('button').textContent,'Ghi nhận hoàn tiền đã chuyển');
 assert.match(form.textContent,/hệ thống không chuyển tiền/);assert.equal(form.elements.refundAmountVnd.value,'150000');
 form.elements.resolution.value='Đã kiểm tra hàng và chứng từ hoàn tiền';
 await ui.submit(form);assert.equal(ui.writes.length,0);assert.match(form.querySelector('[role=status]').textContent,/xác nhận đã hoàn đủ tiền/);
 form.elements.refundReference.value='  BANK-VIRTUAL-123  ';form.elements.refundConfirmedSent.checked=true;
 form.dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));await flush();
 assert.deepEqual(ui.writes,[{url:'/api/gaeru_ceo/orders/after-sales/isolated-rma',body:{version:3,status:'resolved',resolution:'Đã kiểm tra hàng và chứng từ hoàn tiền',manualRefund:{amountVnd:150000,method:'bank_transfer',reference:'BANK-VIRTUAL-123',confirmedSent:true}}}]);
 assert.match(ui.messages.at(-1).message,/Đã ghi nhận chứng từ hoàn tiền đã chuyển/);
});

test('unpaid returns close without fabricating a refund and malformed amounts cannot be closed',async()=>{
 const ui=await fixture({payment_status:'pending',refundable_amount_vnd:'0'}),form=ui.document.querySelector('[data-case]');
 assert.equal(form.querySelector('[data-manual-refund]'),null);form.elements.resolution.value='Đã nhận hàng, chưa phát sinh thanh toán';await ui.submit(form);
 assert.equal(ui.writes.length,1);assert.equal(Object.hasOwn(ui.writes[0].body,'manualRefund'),false);
 for(const amount of [null,undefined,'-1','not-a-number','2000000001']){
  const invalid=await fixture({refundable_amount_vnd:amount});assert.equal(invalid.document.querySelector('[data-case]'),null);assert.match(invalid.document.getElementById('after-sales-list').textContent,/Đối soát thanh toán/);
 }
});

test('payment permission and current write permission gate financial actions',async()=>{
 const ui=await fixture({},['orders.write']);assert.equal(ui.document.querySelector('[data-case]'),null);assert.match(ui.document.getElementById('after-sales-list').textContent,/Cần quyền ghi nhận thanh toán/);
 for(const permission of ['orders.write','payments.write']){
  const changed=await fixture(),form=changed.document.querySelector('[data-case]');form.elements.resolution.value='Valid fixture evidence';form.elements.refundReference.value='BANK-VIRTUAL-123';form.elements.refundConfirmedSent.checked=true;changed.allowed.delete(permission);await changed.submit(form);assert.equal(changed.writes.length,0);
 }
 const readonly=await fixture({},[]);assert.equal(readonly.document.querySelector('[data-case]'),null);assert.equal(readonly.document.querySelector('[data-rma-logistics]'),null);assert.equal(readonly.document.querySelector('[data-after-sales-create]').hidden,true);
});

test('exchange stock boundary and closed cases do not offer unsupported logistics or settlement actions',async()=>{
 const exchange=await fixture({return_type:'exchange'});
 assert.equal(exchange.document.querySelector('[data-case]'),null);assert.match(exchange.document.getElementById('after-sales-list').textContent,/bằng chứng từ kho/);
 const logistics=exchange.document.querySelector('[data-rma-logistics]');
 assert.ok(logistics);for(const name of ['outboundStatus','outboundTrackingNumber','outboundCarrier'])assert.equal(logistics.elements[name],null);
 logistics.elements.inspectionNotes.value='Checked fixture';assert.equal(logistics.elements.restockEligible,null);await exchange.submit(logistics);
 assert.equal(exchange.writes.length,1);assert.deepEqual(Object.keys(exchange.writes[0].body).sort(),['inboundStatus','inspectionNotes','version']);assert.equal(exchange.writes[0].body.version,3);
 for(const status of ['resolved','rejected']){
  const closed=await fixture({status});assert.equal(closed.document.querySelector('[data-case]'),null);assert.equal(closed.document.querySelector('[data-rma-logistics]'),null);
 }
});

function options(overrides={}){
 return {caseId:'isolated-rma',version:3,eligible:true,scope:'full_order_same_product_no_price_difference',warehouses:[{id:'warehouse-main',code:'MAIN',name:'Kho chính'},{id:'warehouse-empty',code:'EMPTY',name:'Kho không đủ hàng'}],items:[1,2].map(number=>({orderItemId:'original-line-'+number,productName:'Fixture Mic '+number,variantName:'Type C',sku:'OLD-'+number,quantity:number,unitPriceVnd:100000,variantId:'original-'+number,candidates:[{variantId:'replacement-'+number,sku:'NEW-'+number,name:'Lightning',priceVnd:100000,stock:[{warehouseId:'warehouse-main',quantity:10},{warehouseId:'warehouse-empty',quantity:0}]}]})),issue:null,...overrides};
}
const exchangePermissions=['orders.write','inventory.read','inventory.approve'];

test('exchange issue submits every original line and exact quantities with a stable retry key',async()=>{
 let attempts=0;const ui=await fixture({return_type:'exchange',inspection_notes:'Đã nhận đủ hàng'},exchangePermissions,{exchangeOptions:options(),write:async()=>{if(++attempts===1)throw Error('Fixture network lost');return {issue:{id:'posted-document'},version:4};}});
 await ui.exchange();const form=ui.document.querySelector('[data-exchange-issue]');assert.ok(form);assert.equal(form.querySelectorAll('[data-exchange-item]').length,2);
 assert.match(form.textContent,/Tồn tại kho đã chọn: 10/);form.elements.reason.value='Đổi đủ hàng theo yêu cầu đã đối chiếu';form.elements.confirmedReceivedAll.checked=true;
 await ui.submit(form);assert.equal(ui.writes.length,1);assert.match(ui.document.querySelector('[data-exchange-status]').textContent,/network lost/);
 await ui.submit(form);assert.equal(ui.writes.length,2);assert.equal(ui.writes[0].body.requestKey,ui.writes[1].body.requestKey);
 const {requestKey,...body}=ui.writes[0].body;assert.match(requestKey,/^[0-9a-f-]{36}$/);
 assert.deepEqual(body,{version:3,reason:'Đổi đủ hàng theo yêu cầu đã đối chiếu',warehouseId:'warehouse-main',confirmedReceivedAll:true,items:[{orderItemId:'original-line-1',replacementVariantId:'replacement-1',quantity:1},{orderItemId:'original-line-2',replacementVariantId:'replacement-2',quantity:2}]});
});

test('exchange cannot issue without approval, physical receipt confirmation or enough stock',async()=>{
 const sales=await fixture({return_type:'exchange'},['orders.write','inventory.read'],{exchangeOptions:options()});await sales.exchange();assert.equal(sales.document.querySelector('[data-exchange-issue]'),null);assert.match(sales.document.querySelector('[data-exchange-content]').textContent,/Cần quyền duyệt kho/);
 const ui=await fixture({return_type:'exchange'},exchangePermissions,{exchangeOptions:options()});await ui.exchange();const form=ui.document.querySelector('[data-exchange-issue]');form.elements.reason.value='Đổi hàng đã kiểm tra đủ';
 await ui.submit(form);assert.equal(ui.writes.length,0);
 form.elements.confirmedReceivedAll.checked=true;form.elements.warehouseId.value='warehouse-empty';form.elements.warehouseId.dispatchEvent(new ui.window.Event('change',{bubbles:true}));assert.match(form.textContent,/Tồn tại kho đã chọn: 0/);await ui.submit(form);assert.equal(ui.writes.length,0);assert.equal(ui.document.querySelector('[data-exchange-status]').classList.contains('is-error'),true);assert.equal(ui.messages.length,0,'stock validation stays local instead of also creating a top-level alert');
 form.elements.warehouseId.value='warehouse-main';form.elements.warehouseId.dispatchEvent(new ui.window.Event('change',{bubbles:true}));assert.equal(ui.document.querySelector('[data-exchange-status]').textContent,'');assert.equal(ui.document.querySelector('[data-exchange-status]').classList.contains('is-error'),false);
 form.elements.warehouseId.value='warehouse-main';ui.allowed.delete('inventory.approve');await ui.submit(form);assert.equal(ui.writes.length,0);
 const ineligible=await fixture({return_type:'exchange'},exchangePermissions,{exchangeOptions:options({eligible:false,reason:'Chưa nhận đủ hàng về kho'})});await ineligible.exchange();assert.equal(ineligible.document.querySelector('[data-exchange-issue]'),null);assert.match(ineligible.document.querySelector('[data-exchange-content]').textContent,/Chưa nhận đủ hàng/);
});

test('posted exchange documents gate outbound stages, closure and pre-shipment correction',async()=>{
 const issue={id:'document-posted',status:'posted',warehouseId:'warehouse-main',warehouseName:'Kho chính',items:[{sku:'NEW-1',variantName:'Lightning',quantity:1}]};
 const ui=await fixture({return_type:'exchange',outbound_status:'preparing',exchange_issue:issue},exchangePermissions,{exchangeOptions:options({eligible:false,reason:'Đã xuất hàng',issue})});
 assert.equal(ui.document.querySelector('[data-case]'),null);const logistics=ui.document.querySelector('[data-rma-logistics]');assert.ok(logistics.elements.outboundTrackingNumber);assert.equal(logistics.elements.outboundStatus.querySelector('option[value=delivered]'),null);
 await ui.exchange();assert.match(ui.document.querySelector('[data-exchange-content]').textContent,/Đã xuất hàng đổi/);const voidForm=ui.document.querySelector('[data-exchange-void]');voidForm.elements.reason.value='Điều chỉnh nhầm phiên bản trước khi giao';voidForm.elements.confirmedVoid.checked=true;await ui.submit(voidForm);
 assert.equal(ui.writes[0].url,'/api/gaeru_ceo/orders/after-sales/isolated-rma/exchange-issue/void');assert.equal(ui.writes[0].body.issueId,'document-posted');assert.equal(ui.writes[0].body.version,3);
 const delivered=await fixture({return_type:'exchange',outbound_status:'delivered',exchange_issue:issue},exchangePermissions,{exchangeOptions:options({eligible:false,issue})});await delivered.exchange();assert.equal(delivered.document.querySelector('[data-exchange-void]'),null);assert.equal(delivered.document.querySelector('[name=outboundTrackingNumber]').hasAttribute('readonly'),true);assert.equal(delivered.document.querySelector('[name=inboundStatus]').children.length,1);const close=delivered.document.querySelector('[data-case]');assert.ok(close);close.elements.resolution.value='Khách đã nhận đủ hàng đổi';await delivered.submit(close);assert.equal(Object.hasOwn(delivered.writes[0].body,'manualRefund'),false);
});

test('replacement stock validation totals repeated variants across every order line',async()=>{
 const data=options();for(const item of data.items)item.candidates=[{variantId:'shared-replacement',sku:'SHARED',name:'Type C',priceVnd:100000,stock:[{warehouseId:'warehouse-main',quantity:2}]}];
 const ui=await fixture({return_type:'exchange'},exchangePermissions,{exchangeOptions:data});await ui.exchange();const form=ui.document.querySelector('[data-exchange-issue]');form.elements.reason.value='Đổi đủ toàn bộ dòng hàng';form.elements.confirmedReceivedAll.checked=true;await ui.submit(form);assert.equal(ui.writes.length,0);assert.match(ui.document.querySelector('[data-exchange-status]').textContent,/Tổng số lượng phiên bản đổi vượt tồn kho/);
});

test('outbound delivery requires real waybill fields and carries the latest case version',async()=>{
 const ui=await fixture({return_type:'exchange',outbound_status:'preparing',exchange_issue:{id:'issued',status:'posted'}},exchangePermissions),form=ui.document.querySelector('[data-rma-logistics]');form.elements.outboundStatus.value='in_transit';form.elements.outboundCarrier.value='Virtual Carrier';form.elements.outboundTrackingNumber.value='1';await ui.submit(form);assert.equal(ui.writes.length,0);
 form.elements.outboundTrackingNumber.value='VIRTUAL-TRACKING';await ui.submit(form);assert.equal(ui.writes.length,1);assert.equal(ui.writes[0].body.version,3);assert.equal(ui.writes[0].body.outboundStatus,'in_transit');assert.equal(ui.writes[0].body.outboundTrackingNumber,'VIRTUAL-TRACKING');
});

test('restocking requires inventory approval in both the logistics editor and return closure',async()=>{
 for(const type of ['refund','exchange']){
  const limited=await fixture({return_type:type,restock_eligible:true,outbound_status:'delivered',exchange_issue:{id:'posted',status:'posted'}},['orders.write','payments.write','inventory.read']);
  assert.equal(limited.document.querySelector('[data-case]'),null);assert.equal(limited.document.querySelector('[name=restockEligible]'),null);assert.match(limited.document.getElementById('after-sales-list').textContent,/Cần quyền duyệt kho để nhập hàng trả/);
 }
 const approver=await fixture({return_type:'refund'},exchangePermissions),form=approver.document.querySelector('[data-rma-logistics]');assert.ok(form.elements.restockEligible);form.elements.restockEligible.checked=true;form.elements.inspectionNotes.value='Đã kiểm tra hàng có thể bán';await approver.submit(form);assert.equal(approver.writes[0].body.restockEligible,true);
});
