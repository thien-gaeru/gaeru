'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const choices=require('../variant-choices');

function editor(){
 const nodes=new Map(),fields={};
 const classes={contains:()=>false,add(){},remove(){},toggle(){}};
 function node(key){
  const field=String(key).match(/\[data-field=["']?([^\]"']+)/)?.[1];
  if(field)return fields[field]||(fields[field]=make({dataset:{field}}));
  if(!nodes.has(key))nodes.set(key,make());return nodes.get(key);
 }
 function make(extra={}){return {value:'',textContent:'',innerHTML:'',dataset:{},children:[],disabled:false,listeners:{},classList:classes,
  addEventListener(k,fn){(this.listeners[k]||=[]).push(fn)},querySelector:node,querySelectorAll:()=>[],matches(selector){return selector==='[data-field]'&&Boolean(this.dataset.field)},closest:()=>null,focus(){},scrollIntoView(){},appendChild(){},...extra};}
 const form=node('#workspace-form');form.elements=Object.fromEntries(['name','slug','category','descriptor','cardTitle','cardSummary','description','imageAlt','sortOrder'].map(k=>[k,node(k)]));
 const row=make({dataset:{variantIndex:'0'}}),rows=node('#variant-rows');
 let html='';Object.defineProperty(rows,'innerHTML',{get:()=>html,set(value){html=value;for(const m of value.matchAll(/<(input|select)[^>]*data-field="([^"]+)"[^>]*>/g)){const value=m[0].match(/value="([^"]*)"/);node('[data-field='+m[2]+']').value=value?.[1]||'';if(m[2]==='active')fields.active.checked=m[0].includes('checked');}}});
 const draft=node('draft'),publish=node('publish');draft.dataset.save='draft';publish.dataset.save='publish';
 let releaseUpload,uploaded,submitted;
 const gate=new Promise(r=>releaseUpload=r),started=new Promise(r=>uploaded=r);
 const context={document:{querySelector:node,getElementById:id=>node('#'+id),querySelectorAll:selector=>selector==='[data-save]'?[draft,publish]:selector==='[data-variant-index]'?[row]:[],createElement:()=>make(),body:make()},window:{GAERUVariantChoices:choices,addEventListener(){}},location:{pathname:'/gaeru_ceo/products/new',search:'',assign(){}},history:{},sessionStorage:{setItem(){}},WeakMap,FormData:class{append(){}},setTimeout(){},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},fetch:async(path,options={})=>{
  if(path==='/api/auth/me')return {ok:true,json:async()=>({authenticated:true,permissions:['catalog.read','catalog.write','inventory.approve']})};
  if(path==='/api/csrf')return {ok:true,json:async()=>({csrfToken:'test'})};
  if(path.endsWith('/catalog-images')){uploaded();await gate;return {ok:true,json:async()=>({imageUrl:'/api/catalog-images/test'})};}
  if(path.endsWith('/product-workspace')){submitted=JSON.parse(options.body);return {ok:true,json:async()=>({id:'test-product',product:submitted.product,gallery:submitted.gallery,groups:submitted.groups,variants:submitted.variants})};}
  throw Error('Unexpected request '+path);
 }};
 vm.runInNewContext(fs.readFileSync(require.resolve('../admin/product-editor.js'),'utf8'),context);
 const ready=new Promise(r=>setImmediate(r));
 const input=(selector,value)=>{const n=node(selector);n.value=value;n.oninput?.();return n;};
 const emit=async(type,target)=>{for(const fn of form.listeners[type]||[])await fn({target});};
 return {node,ready,input,emit,started,releaseUpload,publish,submitted:()=>submitted};
}

test('editing a simple variant while its image uploads retains preview, table and saved price, stock and SKU',async()=>{
 const e=editor();await e.ready;
 const upload=e.node('#gallery-files').listeners.change[0]({target:{files:[{name:'image.png',size:20}]}});await e.started;
 e.node('name').value='Sản phẩm kiểm thử';e.node('slug').value='san-pham-kiem-thu';
 e.input('#simple-price','321000');e.input('#simple-stock','0');e.input('#simple-sku','CHECK-321');
 e.releaseUpload();await upload;
 assert.match(e.node('#product-preview').innerHTML,/321\.000/);
 assert.equal(e.node('[data-field=priceVnd]').value,'321000');
 assert.equal(e.node('[data-field=stockQuantity]').value,'0');
 assert.equal(e.node('[data-field=sku]').value,'CHECK-321');
 await e.publish.onclick();
 assert.equal(e.submitted().variants[0].priceVnd,321000);
 assert.equal(e.submitted().variants[0].stockQuantity,0);
 assert.equal(e.submitted().variants[0].sku,'CHECK-321');
});

test('detailed table edits update the simple variant controls, including an explicitly cleared value',async()=>{
 const e=editor();await e.ready;
 e.input('#simple-price','321000');e.input('#simple-stock','9');e.input('#simple-sku','OLD');
 for(const [field,selector,value]of [['priceVnd','#simple-price','456000'],['stockQuantity','#simple-stock','0'],['sku','#simple-sku','UPDATED']]){
  const target=e.node('[data-field='+field+']');target.value=value;await e.emit('change',target);assert.equal(e.node(selector).value,value);
 }
 const price=e.node('[data-field=priceVnd]');price.value='';await e.emit('change',price);assert.equal(e.node('#simple-price').value,'');
});
