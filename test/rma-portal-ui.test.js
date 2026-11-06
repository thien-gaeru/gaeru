'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
test('RMA portal authenticates in headers, escapes content and submits an inbound waybill without leaking token to URL',async()=>{
 const {window,document}=parseHTML('<html><body><main></main></body></html>');
 Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){return Object.fromEntries([...this.querySelectorAll('[name]')].map(e=>[e.name,e]));}});
 window.location={search:''};const calls=[];let submitted;
 const fetch=async(url,options={})=>{calls.push({url,options});if(options.method==='POST'){submitted=JSON.parse(options.body);return {ok:true,json:async()=>({message:'Đã lưu vận đơn'})};}return {ok:true,json:async()=>({rma:{rmaNumber:'RMA-261103-AB12',status:'approved',reason:'<img src=x onerror=alert(1)>',inbound:{carrier:'',trackingNumber:'',warehouseAddress:{facility:'GAERU',address:'Kho thử nghiệm',contactPhone:'0900000000'}},outbound:{}}})};};
 vm.runInNewContext(fs.readFileSync(require.resolve('../tracking.js'),'utf8'),{window,document,URLSearchParams,fetch,console});
 const form=document.querySelector('[data-rma-lookup]');assert.ok(form);form.elements.rma.value='RMA-261103-AB12';form.elements.token.value='capability-secret';
 await form.onsubmit({preventDefault(){},currentTarget:form});
 assert.equal(calls[0].url,'/api/rma/RMA-261103-AB12');assert.equal(calls[0].options.headers['X-RMA-Token'],'capability-secret');assert.equal(form.elements.token.value,'');assert.equal(document.querySelectorAll('[onerror]').length,0);
 const inbound=document.querySelector('[data-rma-details] form');inbound.elements.carrier.value='viettel';inbound.elements.tracking.value='VT123456';await inbound.onsubmit({preventDefault(){}});
 assert.equal(calls[1].url,'/api/rma/RMA-261103-AB12/inbound');assert.equal(calls[1].options.headers['X-RMA-Token'],'capability-secret');assert.deepEqual(submitted,{inboundCarrier:'viettel',inboundTrackingNumber:'VT123456'});assert.ok(document.querySelector('[data-rma-details]').textContent.includes('Đã lưu vận đơn'));
});
