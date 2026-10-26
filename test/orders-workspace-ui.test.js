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
 const context={document,window,state,can:()=>false,orderTransitions:{},labels:{pending:'Chờ xác nhận',cod:'COD'},formatPrice:n=>String(n),escapeHtml:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),showGlobal(){},loadOrders:async()=>{},request:async()=>({csrfToken:'fixture'}),fetch:async()=>({ok:true,text:async()=>'<html>print</html>'})};
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
 assert.equal(body.hidden,true);button.dispatchEvent(new window.Event('click',{bubbles:true}));assert.equal(body.hidden,false);assert.equal(button.getAttribute('aria-expanded'),'true');assert.equal(state.openOrders.has(order.id),true);
 button.dispatchEvent(new window.Event('click',{bubbles:true}));assert.equal(body.hidden,true);assert.equal(state.openOrders.has(order.id),false);
 const all=document.getElementById('select-order-page');all.checked=true;all.dispatchEvent(new window.Event('change',{bubbles:true}));assert.deepEqual([...state.selectedOrders],[order.id]);assert.equal(document.querySelector('[data-print-orders]').disabled,false);assert.equal(document.getElementById('selected-order-count').textContent,'Đã chọn 1 đơn');
 const row=document.querySelector('[data-select-order]');row.checked=false;row.dispatchEvent(new window.Event('change',{bubbles:true}));assert.equal(state.selectedOrders.size,0);assert.equal(document.querySelector('[data-print-orders]').disabled,true);
 const tabs=[...document.querySelectorAll('#order-tabs button')];assert.equal(tabs.at(-2).dataset.orderTab,'cancelled');assert.equal(tabs.at(-1).id,'after-sales-toggle');assert.equal(document.querySelector('#after-sales-panel').hidden,true);
});
test('bulk print opens window before network and sends only current selected order ids',async()=>{
 const {context,document,window,state,order}=fixture();let opened=false,called=false,written='';
 const printWindow={closed:false,opener:'parent',document:{body:{},open(){},write(html){written=html;},close(){}},close(){this.closed=true;}};
 window.open=()=>{opened=true;return printWindow;};context.request=async()=>{assert.equal(opened,true);return {csrfToken:'test-token'};};
 context.fetch=async(url,options)=>{called=true;assert.equal(url,'/api/gaeru_ceo/orders/print');assert.equal(options.headers['X-CSRF-Token'],'test-token');assert.deepEqual(JSON.parse(options.body),{ids:[order.id],format:'invoice'});return {ok:true,text:async()=>'<html>fixture print</html>'};};
 state.selectedOrders.add(order.id);state.selectedOrders.add('stale-id');context.updateOrderSelection();document.querySelector('[data-print-orders="invoice"]').dispatchEvent(new window.Event('click',{bubbles:true}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(called,true);assert.equal(printWindow.opener,null);assert.equal(written,'<html>fixture print</html>');
});
