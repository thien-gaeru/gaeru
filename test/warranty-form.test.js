const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function page(authenticated,savedCity='Hồ Chí Minh',initialHash='',activations=[],standalone=false){
 const nodes=new Map(),requests=[],events={},location={hash:initialHash};
 const node=key=>{if(!nodes.has(key))nodes.set(key,{hidden:false,disabled:false,value:'',textContent:'',innerHTML:'',options:[],listeners:{},addEventListener(event,fn){const old=this.listeners[event];this.listeners[event]=old?async e=>{await old(e);await fn(e);}:fn;},append(option){this.options.push(option);},querySelector:node,scrollIntoView(){}});return nodes.get(key);};
 node('#warranty-activation').dataset={standalone:String(standalone)};
 const form=node('form');form.elements=Object.fromEntries(['source','orderId','orderItemId','externalOrderNumber','productName','purchaseDate','fullName','email','phone','address','city'].map(name=>[name,node(name)]));
 form.elements.source.value='website';form.elements.orderId.options.push({value:''});
 const fetch=async(url,options={})=>{
  requests.push({url,options});
  const data=url==='/api/csrf'?{csrfToken:'test'}:url==='/api/customer-auth/me'?{authenticated,customer:{id:'one',fullName:'Customer Name',phone:'0900000000'}}:url.startsWith('/api/customer/orders?')?{orders:[{id:'order-one',orderNumber:'GAERU-ONE',status:'completed'}]}:url==='/api/customer/addresses'?{addresses:[{isDefault:true,fullName:'Recipient',phone:'0911111111',address:'123 Default Street',city:savedCity}]}:(url.startsWith('/api/customer/warranties?')||url.startsWith('/api/warranty-requests?'))?{activations,today:'2026-10-23'}:url==='/api/customer/orders/order-one'?{order:{customerName:'Order Recipient',phone:'0922222222',address:'456 Order Street',city:'Hà Nội',items:[]}}:{activation:{id:'reference-one',status:'pending'}};
  return {ok:true,json:async()=>data};
 };
 const context={document:{querySelector:node,createElement:()=>({}),addEventListener:(name,fn)=>events[name]=fn},window:{addEventListener:(name,fn)=>events[name]=fn},fetch,AbortController,setTimeout,clearTimeout,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'},location};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../warranty.js'),'utf8'),context);
 return {node,form,requests,events,location};
}
const settled=()=>new Promise(resolve=>setImmediate(resolve));
test('guest can select a marketplace and submit contact details without logging in',async()=>{
 const ui=page(false);await settled();
 ui.form.elements.source.value='shopee';ui.form.elements.source.listeners.change();
 assert.equal(ui.node('[data-w-account]').disabled,true);assert.equal(ui.node('[data-w-external]').disabled,false);
 for(const [key,value]of Object.entries({externalOrderNumber:'SHOP-123',productName:'GAERU K9',purchaseDate:'2026-01-01',fullName:'Guest Name',phone:'0900000000',address:'123 Guest Street',city:'Hà Nội'}))ui.form.elements[key].value=value;
 await ui.form.listeners.submit({preventDefault(){}});
 const request=ui.requests.find(r=>r.url==='/api/warranty-requests');assert.ok(request);
 const body=JSON.parse(request.options.body);assert.equal(body.channel,'shopee');assert.equal(body.purchaseDate,'2026-01-01');assert.equal(body.contact.fullName,'Guest Name');assert.equal(body.externalOrderNumber,'SHOP-123');
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
test('activation stays collapsed normally but opens on its link, initial fragment or hash navigation',async()=>{
 const ui=page(false);await settled();assert.notEqual(ui.node('[data-w-disclosure]').open,true);
 ui.events.click({target:{closest:selector=>selector==='a[href="#warranty-activation"]'?{}:null}});assert.equal(ui.node('[data-w-disclosure]').open,true);
 ui.node('[data-w-disclosure]').open=false;ui.location.hash='#warranty-activation';ui.events.hashchange();assert.equal(ui.node('[data-w-disclosure]').open,true);
 const linked=page(false,'Hà Nội','#warranty-activation');await settled();assert.equal(linked.node('[data-w-disclosure]').open,true);
});

test('rejected request opens populated correction form and submits the original version',async()=>{const row={id:'claim-one',status:'rejected',version:2,automatic:false,channel:'shopee',orderNumber:'ORDER-OLD',productName:'Product fixture',claimedPurchaseDate:'2026-01-01',contactName:'Buyer Name',contactPhone:'0900000000',contactAddress:'Fixture address',contactCity:'Hà Nội',contactEmail:'buyer@example.test',reason:'Sai mã đơn'};const ui=page(true,'Hồ Chí Minh','',[row]);await settled();assert.match(ui.node('[data-w-list]').innerHTML,/Sửa và gửi lại/);await ui.node('#warranty-activation').listeners.click({target:{closest:s=>s==='[data-w-edit]'?{dataset:{wEdit:row.id}}:null}});assert.equal(ui.form.elements.externalOrderNumber.value,row.orderNumber);assert.equal(ui.form.elements.source.disabled,true);assert.equal(ui.form.elements.email.value,row.contactEmail);ui.form.elements.externalOrderNumber.value='ORDER-FIXED';await ui.form.listeners.submit({preventDefault(){}});const request=ui.requests.find(r=>r.options.method==='PATCH');assert.ok(request);assert.equal(request.url,'/api/warranty-requests/'+row.id);const body=JSON.parse(request.options.body);assert.equal(body.version,2);assert.equal(body.externalOrderNumber,'ORDER-FIXED');assert.equal(body.requestKey,undefined);});

test('standalone warranty page opens activation without a fragment',async()=>{const p=page(false,'Hồ Chí Minh','',[],true);await settled();assert.equal(p.node('[data-w-disclosure]').open,true);assert.ok(p.requests.some(r=>r.url==='/api/customer-auth/me'));});
