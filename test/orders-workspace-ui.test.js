const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {parseHTML}=require('linkedom');
const source=fs.readFileSync(require.resolve('../admin/admin.js'),'utf8');
const markup=fs.readFileSync(require.resolve('../admin/index.html'),'utf8');
function fixture(){
 const {document,window}=parseHTML(markup);
 const id='0d504609-20f7-46b2-bf22-62dd3dd68aee';
 const order={id,orderNumber:'GR-FIXTURE',customerName:'<img src=x onerror=alert(1)>',phone:'0900000000',email:'fixture@example.invalid',address:'Fixture',city:'Hà Nội',createdAt:'2026-10-26T00:00:00Z',status:'pending',paymentStatus:'pending',paymentMethod:'cod',totalVnd:100000,subtotalVnd:100000,shippingFeeVnd:0,items:[{productName:'Micro',variantName:'Type C',quantity:1,lineTotalVnd:100000}]};
 const state={orders:[order],selectedOrders:new Set(),openOrders:new Set(),orderPagination:{page:1,pageCount:1,total:1},orderPage:1};
 const context={document,window,state,can:()=>false,orderTransitions:{},labels:{pending:'Chờ xác nhận',cod:'COD'},formatPrice:n=>String(n),escapeHtml:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),showGlobal(){},updateOrder:async()=>{},loadOrders:async()=>{},request:async()=>({csrfToken:'fixture'}),fetch:async()=>({ok:true,text:async()=>'<html>print</html>'})};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('function isLiveVnpayAttempt'),source.indexOf('async function updateOrder')),context);
 vm.runInContext(source.slice(source.indexOf('function renderOrderOverview'),source.indexOf("document.querySelector('#export-order-page')")),context);
 const processStart=source.indexOf('document.querySelector("#order-list").addEventListener("click"');
 const processEnd=source.indexOf('\ndocument.querySelector("#order-list").addEventListener("change"',processStart);
 vm.runInContext(source.slice(processStart,processEnd),context);
 context.renderOrderOverview({pending:1});context.renderOrders();
 return {context,document,window,state,order};
}
test('order workspace uses one explicit process button and safely selects only visible rows',()=>{
 const {document,window,state,order}=fixture();
 assert.equal(document.querySelectorAll('#order-list summary').length,0);
 assert.equal(document.querySelectorAll('[data-process-order]').length,1);
 assert.equal(document.querySelectorAll('#order-list img').length,0);
 const body=document.getElementById('order-body-'+order.id),button=document.querySelector('[data-process-order]');
 assert.equal(body.hidden,true);button.dispatchEvent(new window.Event('click',{bubbles:true}));const popup=document.getElementById('order-processing-dialog');assert.ok(popup);assert.equal(popup.hasAttribute('open'),true);assert.equal(body.hidden,true);assert.match(popup.textContent,/GR-FIXTURE/);assert.equal(popup.querySelectorAll('img').length,0);assert.equal(document.querySelectorAll('[data-after-sales-order]').length,0);popup.querySelector('[data-close-order]').click();assert.equal(document.getElementById('order-processing-dialog'),null);
 const all=document.getElementById('select-order-page');all.checked=true;all.dispatchEvent(new window.Event('change',{bubbles:true}));assert.deepEqual([...state.selectedOrders],[order.id]);assert.equal(document.querySelector('[data-print-orders]').disabled,false);assert.equal(document.getElementById('selected-order-count').textContent,'Đã chọn 1 đơn');
 const row=document.querySelector('[data-select-order]');row.checked=false;row.dispatchEvent(new window.Event('change',{bubbles:true}));assert.equal(state.selectedOrders.size,0);assert.equal(document.querySelector('[data-print-orders]').disabled,true);
 const tabs=[...document.querySelectorAll('#order-tabs button')];assert.equal(tabs.length,6);assert.deepEqual(tabs.map(b=>b.dataset.orderTab),['','pending','ready_to_ship','shipped','completed','cancelled_or_returned']);assert.deepEqual(tabs.map(b=>b.firstChild.textContent.trim()),['Tất cả','Chờ xác nhận','chờ gửi hàng','Đã giao hàng','Hoàn Tất','Hủy & Hoàn trả']);assert.equal(tabs[3].title,'Đơn đã bàn giao cho hãng vận chuyển');assert.equal(document.getElementById('after-sales-toggle').closest('#order-tabs'),null);assert.equal(document.querySelector('#after-sales-panel').hidden,true);
});
test('bulk print opens window before network and sends only current selected order ids',async()=>{
 const {context,document,window,state,order}=fixture();let opened=false,called=false,written='';
 const printWindow={closed:false,opener:'parent',document:{body:{},open(){},write(html){written=html;},close(){}},close(){this.closed=true;}};
 window.open=()=>{opened=true;return printWindow;};context.request=async()=>{assert.equal(opened,true);return {csrfToken:'test-token'};};
 context.fetch=async(url,options)=>{called=true;assert.equal(url,'/api/gaeru_ceo/orders/print');assert.equal(options.headers['X-CSRF-Token'],'test-token');assert.deepEqual(JSON.parse(options.body),{ids:[order.id],format:'invoice'});return {ok:true,text:async()=>'<html>fixture print</html>'};};
 state.selectedOrders.add(order.id);state.selectedOrders.add('stale-id');context.updateOrderSelection();document.querySelector('[data-print-orders="invoice"]').dispatchEvent(new window.Event('click',{bubbles:true}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(called,true);assert.equal(printWindow.opener,null);assert.equal(written,'<html>fixture print</html>');
});

test('processing offers only valid next states and omits the current state button',()=>{const f=fixture();f.context.can=()=>true;f.context.orderTransitions={pending:['confirmed','cancelled']};f.context.labels.confirmed='Đã xác nhận';f.context.labels.cancelled='Đã hủy';f.context.renderOrders();f.context.openOrderProcessing(f.order.id,null);const popup=f.document.querySelector('#order-processing-dialog');const values=[...popup.querySelectorAll('[data-status-choice]')].map(b=>b.dataset.statusChoice);assert.deepEqual(values,['confirmed','cancelled']);assert.equal(popup.querySelector('[data-status-choice="pending"]'),null);});

test('completed returns show a terminal label and cannot reopen processing, return creation or bulk mutation',()=>{
 const f=fixture();f.context.can=()=>true;Object.assign(f.order,{status:'completed',returnStatus:'returned',returnedAt:'2026-10-28T00:00:00Z'});f.context.renderOrders();
 assert.match(f.document.querySelector('#order-list').textContent,/Đã hoàn trả/);assert.equal(f.document.querySelector('[data-process-order]'),null);assert.equal(f.document.querySelector('[data-return-order]'),null);assert.equal(f.document.querySelector('[data-restore-order]'),null);
 f.context.openOrderProcessing(f.order.id,null);assert.equal(f.document.querySelector('#order-processing-dialog'),null);
 f.state.selectedOrders.add(f.order.id);f.context.updateOrderSelection();assert.equal(f.document.querySelector('[data-bulk-process]').disabled,true);assert.equal(f.document.querySelector('[data-print-orders]').disabled,false,'history remains printable');
});

test('cancelled restoration collects a fresh reason and unpaid acknowledgement before a versioned idempotent request',async()=>{
 const f=fixture();f.context.can=()=>true;f.context.crypto={randomUUID:()=> 'd7111111-1111-4111-8111-111111111111'};f.context.loadSummary=async()=>{};
 Object.defineProperty(f.window.HTMLElement.prototype,'elements',{configurable:true,get(){return new Proxy({},{get:(_,name)=>this.querySelector('[name="'+String(name)+'"]')})}});
 f.window.HTMLElement.prototype.showModal=function(){this.setAttribute('open','')};f.window.HTMLElement.prototype.close=function(){this.removeAttribute('open')};
 Object.assign(f.order,{status:'cancelled',version:7,paymentMethod:'cod'});f.context.renderOrders();const button=f.document.querySelector('[data-restore-order]');assert.ok(button);assert.equal(button.disabled,false);
 const calls=[];let fail=true;f.context.request=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});if(fail)throw Error('Fixture network failure');return {message:'Đã khôi phục'};};
 button.dispatchEvent(new f.window.Event('click',{bubbles:true}));const dialog=f.document.querySelector('#order-restoration-dialog'),form=dialog.querySelector('form');assert.ok(dialog);assert.equal(calls.length,0);
 form.elements.reason.value='Khách xác nhận tiếp tục đơn cũ';form.elements.confirmedUnpaid.checked=true;form.dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));
 assert.equal(calls.length,1);assert.match(form.querySelector('[role=alert]').textContent,/Fixture network failure/);assert.equal(f.order.status,'cancelled','client never changes order state optimistically');
 fail=false;form.dispatchEvent(new f.window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));
 assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1],'an explicit retry retains the same request key');
 assert.deepEqual(calls[1].body,{version:7,requestKey:'d7111111-1111-4111-8111-111111111111',reason:'Khách xác nhận tiếp tục đơn cũ',confirmedUnpaid:true});
 assert.equal(calls[1].url,'/api/gaeru_ceo/orders/'+f.order.id+'/restore');assert.equal(f.document.querySelector('#order-restoration-dialog'),null);assert.equal(f.document.querySelector('#order-filter').value,'pending');
});

test('the combined tabs count returned orders once and risky gateway restoration stays unavailable',()=>{
 const f=fixture();f.context.renderOrderOverview({pending:1,confirmed:2,processing:3,shipped:4,completed:1,cancelled:2,returned:1,cancelled_or_returned:4});
 const tabs=f.document.querySelectorAll('#order-tabs button');assert.equal(tabs[0].querySelector('span').textContent,'14');assert.equal(tabs[2].querySelector('span').textContent,'5');assert.equal(tabs[5].querySelector('span').textContent,'4');
 f.context.can=()=>true;Object.assign(f.order,{status:'cancelled',paymentMethod:'momo'});f.context.renderOrders();assert.equal(f.document.querySelector('[data-restore-order]').disabled,true);f.context.openOrderRestoration(f.order.id);assert.equal(f.document.querySelector('#order-restoration-dialog'),null);
});
