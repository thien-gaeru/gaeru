const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('support form toggles account and marketplace fields and opens only on request navigation',async()=>{
 const nodes=new Map(),events={},calls=[],location={hash:''};
 const node=key=>{if(!nodes.has(key))nodes.set(key,{value:'',hidden:false,disabled:false,options:[{value:''}],listeners:{},textContent:'',innerHTML:'',addEventListener(name,fn){this.listeners[name]=fn;},querySelector:node,append(option){this.options.push(option);}});return nodes.get(key);};
 const form=node('#care-form');form.elements=Object.fromEntries(['channel','orderId','externalOrderNumber','subject','description'].map(key=>[key,node(key)]));
 form.elements.channel.value='website';form.elements.orderId.value='order-one';
 const fetch=async(url,options={})=>{calls.push({url,options});return {ok:true,json:async()=>url==='/api/csrf'?{csrfToken:'test'}:url==='/api/customer-auth/me'?{authenticated:true,customer:{fullName:'Customer'}}:url.includes('/orders?')?{orders:[]}:options.method==='POST'?{request:{id:'saved-request'}}:{requests:[]}};};
 class FormData {constructor(){const f=form.elements;this.values=[['channel',f.channel.value],['subject',f.subject.value],['description',f.description.value],f.channel.value==='website'?['orderId',f.orderId.value]:['externalOrderNumber',f.externalOrderNumber.value]];}[Symbol.iterator](){return this.values[Symbol.iterator]();}}
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../care.js'),'utf8'),{document:{querySelector:node,getElementById:node,createElement:()=>({}),addEventListener:(event,fn)=>events[event]=fn},window:{addEventListener:(event,fn)=>events[event]=fn},location,fetch,FormData,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'}});
 await new Promise(resolve=>setImmediate(resolve));assert.notEqual(node('#care-new-request').open,true);
 events.click({target:{closest:()=>({})}});assert.equal(node('#care-new-request').open,true);
 node('#care-new-request').open=false;location.hash='#care-request';events.hashchange();assert.equal(node('#care-new-request').open,true);
 form.elements.channel.value='shopee';form.elements.channel.listeners.change();
 assert.equal(node('[data-care-account]').disabled,true);assert.equal(node('[data-care-external]').disabled,false);
 form.elements.externalOrderNumber.value='SHOPEE-123';form.elements.subject.value='Kiểm tra micro';form.elements.description.value='Micro không kết nối với điện thoại.';
 await form.listeners.submit({preventDefault(){}});
 const body=JSON.parse(calls.find(c=>c.options.method==='POST').options.body);assert.equal(body.channel,'shopee');assert.equal(body.externalOrderNumber,'SHOPEE-123');assert.equal(body.orderId,undefined);
 assert.match(node('#care-feedback').textContent,/saved-request/);
});
