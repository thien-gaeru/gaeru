const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function page(authenticated,savedCity='Hồ Chí Minh'){
 const nodes=new Map(),requests=[];
 const node=key=>{if(!nodes.has(key))nodes.set(key,{hidden:false,disabled:false,value:'',textContent:'',innerHTML:'',options:[],listeners:{},addEventListener(event,fn){this.listeners[event]=fn;},append(option){this.options.push(option);},querySelector:node,scrollIntoView(){}});return nodes.get(key);};
 const form=node('form');form.elements=Object.fromEntries(['source','orderId','orderItemId','externalOrderNumber','productName','fullName','phone','address','city'].map(name=>[name,node(name)]));
 form.elements.source.value='website';form.elements.orderId.options.push({value:''});
 const fetch=async(url,options={})=>{
  requests.push({url,options});
  const data=url==='/api/csrf'?{csrfToken:'test'}:url==='/api/customer-auth/me'?{authenticated,customer:{id:'one',fullName:'Customer Name',phone:'0900000000'}}:url.startsWith('/api/customer/orders?')?{orders:[{id:'order-one',orderNumber:'GAERU-ONE',status:'completed'}]}:url==='/api/customer/addresses'?{addresses:[{isDefault:true,fullName:'Recipient',phone:'0911111111',address:'123 Default Street',city:savedCity}]}:url.startsWith('/api/customer/warranties?')?{activations:[],today:'2026-10-23'}:url==='/api/customer/orders/order-one'?{order:{customerName:'Order Recipient',phone:'0922222222',address:'456 Order Street',city:'Hà Nội',items:[]}}:{activation:{id:'reference-one',status:'pending'}};
  return {ok:true,json:async()=>data};
 };
 const context={document:{querySelector:node,createElement:()=>({})},fetch,AbortController,setTimeout,clearTimeout,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'},location:{hash:''}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../warranty.js'),'utf8'),context);
 return {node,form,requests};
}
const settled=()=>new Promise(resolve=>setImmediate(resolve));
test('guest can select a marketplace and submit contact details without logging in',async()=>{
 const ui=page(false);await settled();
 ui.form.elements.source.value='shopee';ui.form.elements.source.listeners.change();
 assert.equal(ui.node('[data-w-account]').disabled,true);assert.equal(ui.node('[data-w-external]').disabled,false);
 for(const [key,value]of Object.entries({externalOrderNumber:'SHOP-123',productName:'GAERU K9',fullName:'Guest Name',phone:'0900000000',address:'123 Guest Street',city:'Hà Nội'}))ui.form.elements[key].value=value;
 await ui.form.listeners.submit({preventDefault(){}});
 const request=ui.requests.find(r=>r.url==='/api/warranty-requests');assert.ok(request);
 const body=JSON.parse(request.options.body);assert.equal(body.channel,'shopee');assert.equal(body.contact.fullName,'Guest Name');assert.equal(body.externalOrderNumber,'SHOP-123');
 assert.match(ui.node('[data-w-status]').textContent,/lưu mã hồ sơ/);
});
test('authenticated form pre-fills saved address and selecting an order uses its delivery details',async()=>{
 const ui=page(true);await settled();assert.equal(ui.form.elements.source.value,'account');assert.equal(ui.form.elements.fullName.value,'Customer Name');assert.equal(ui.form.elements.address.value,'123 Default Street');
 ui.form.elements.orderId.value='order-one';await ui.form.elements.orderId.listeners.change();
 assert.equal(ui.form.elements.fullName.value,'Order Recipient');assert.equal(ui.form.elements.address.value,'456 Order Street');assert.equal(ui.form.elements.city.value,'Hà Nội');
});
test('activation shortcut targets a dedicated static form anchor',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../care.html'),'utf8');assert.match(html,/href="#warranty-activation">Kích hoạt bảo hành/);assert.match(html,/id="warranty-activation" aria-label="Kích hoạt bảo hành"/);
});
test('province selector contains 34 units and normalizes saved city prefixes without choosing a wrong province',async()=>{
 const ui=page(true,' Thành phố Hải Phòng ');await settled();
 assert.equal(ui.form.elements.city.value,'Hải Phòng');
 const cityMarkup=ui.node('#warranty-activation').innerHTML.match(/<select name="city"[^>]*>([\s\S]*?)<\/select>/)[1];
 assert.equal([...cityMarkup.matchAll(/<option value="[^"]+">/g)].length,34);
 const old=page(true,'Tỉnh Hà Tây');await settled();assert.equal(old.form.elements.city.value,'');assert.equal(old.node('[data-w-city-note]').hidden,false);
 assert.match(old.node('[data-w-city-note]').textContent,/Vui lòng chọn/);
});
