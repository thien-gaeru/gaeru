'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ui=require('../admin/admin-ui');
const {publicImageUrl}=require('../src/lib/public-image-urls');
const choices=require('../variant-choices');
const catalog='/api/catalog-images/11111111-1111-4111-8111-111111111111';
const catalogPreview='/api/gaeru_ceo/catalog-images/11111111-1111-4111-8111-111111111111?v=webp-20261025';

test('admin image display mapping matches reviewed public static paths without changing unknown URLs',()=>{
 const files=['assets/brand/gaeru-logo.png',...['g1-ultra','k9','m3','p01','m3-home-cutout'].map(name=>'assets/products/'+name+'.png'),...[1,2,3,4,6,7,8,9,10,11,12].map(number=>'assets/products/m3-description/'+number+'.png')];
 for(const file of files)for(const url of [file,'/'+file,'/'+file+'?size=1#preview'])assert.equal(ui.imageUrl(url),publicImageUrl(url));
 assert.equal(ui.imageUrl(catalog),catalogPreview);
 assert.equal(ui.imageUrl(catalogPreview),catalogPreview);
 assert.equal(ui.imageUrl(catalog+'?preview=1&v=old#image'),catalogPreview.replace('?v=','?preview=1&v=')+'#image');
 for(const url of ['/assets/products/uploaded-photo.png','/assets/products/m3-description/5.png','/assets/products/m3-description/../secret.png','https://other.invalid/assets/products/k9.png','blob:fixture','data:image/png;base64,fixture','/api/catalog-videos/fixture'])assert.equal(ui.imageUrl(url),url);
 assert.equal(ui.imageUrl(null),null);
 for(const [file,next] of [['../admin/index.html','/gaeru_ceo/assets/admin.js'],['../admin/product-editor.html','/gaeru_ceo/assets/product-editor.js']]){
  const html=fs.readFileSync(require.resolve(file),'utf8');assert.ok(html.indexOf('/gaeru_ceo/assets/admin-ui.js?v=20261025-webp')<html.indexOf(next),'Shared display mapping must load before image renderers');
 }
});

test('admin product list renders WebP display URLs without mutating canonical product DTOs',()=>{
 const source=fs.readFileSync(require.resolve('../admin/admin.js'),'utf8');
 const render=source.slice(source.indexOf('function productStock('),source.indexOf('function setProductForm('));
 const products=['/assets/products/k9.png',catalog].map((imageUrl,index)=>({id:String(index),name:'Fixture '+index,category:'audio',active:true,imageUrl,variants:[{active:true,stockQuantity:9,priceVnd:100,name:'Standard'}]}));
 const original=JSON.stringify(products),nodes=new Map();
 const node=key=>{if(!nodes.has(key))nodes.set(key,{value:'',innerHTML:'',textContent:''});return nodes.get(key);};
 const context={can:()=>true,document:{querySelector:node},window:{GAERUAdminUI:ui},state:{products,currentProduct:null},escapeHtml:value=>String(value),categoryLabels:{audio:'Audio'},formatPrice:value=>String(value)};
 vm.createContext(context);vm.runInContext(render,context);context.renderProducts();
 assert.match(node('#product-list').innerHTML,/<img src="\/assets\/products\/k9\.webp"/);
 assert.ok(node('#product-list').innerHTML.includes('src="'+catalogPreview+'"'));
 assert.equal(JSON.stringify(products),original);
});

for(const inTrash of [false,true])test('product editor preserves canonical references and deletion state '+(inTrash?'in trash':'in catalog'),async()=>{
 const nodes=new Map();function node(key){if(!nodes.has(key))nodes.set(key,{value:'',textContent:'',innerHTML:'',children:[],dataset:{},disabled:false,listeners:{},classList:{toggle(){}},addEventListener(k,v){(this.listeners[k]||=[]).push(v);},querySelector:node,querySelectorAll:()=>[],click(){}});return nodes.get(key);}
 const form=node('#workspace-form');form.elements=Object.fromEntries(['name','slug','category','descriptor','cardTitle','cardSummary','description','imageAlt','sortOrder'].map(key=>[key,node(key)]));form.reportValidity=()=>true;
 const draft=node('[data-save=draft]'),publish=node('[data-save=publish]');draft.dataset.save='draft';publish.dataset.save='publish';
 const productId='22222222-2222-4222-8222-222222222222';
 const fixture={...(inTrash?{inTrash:true}:{}),id:productId,updatedAt:'2026-10-25T00:00:00.000Z',version:1,product:{name:'Fixture product',slug:'fixture-product',category:'audio',descriptor:'',cardTitle:'',cardSummary:'',description:'',imageUrl:'/assets/products/k9.png',imageAlt:'Fixture product',active:false,sortOrder:0},gallery:['/assets/products/k9.png',catalog],groups:[],descriptionMedia:[],variants:[{id:'33333333-3333-4333-8333-333333333333',updatedAt:'2026-10-25T00:00:00.000Z',version:1,sku:'FIXTURE',name:'Standard',options:{},priceVnd:100,stockQuantity:9,active:true,imageUrl:catalog}]};
 let posted;
 const context={document:{querySelector:node,getElementById:id=>node('#'+id),querySelectorAll:selector=>selector==='[data-save]'?[draft,publish]:[]},window:{GAERUVariantChoices:choices,GAERUAdminUI:ui,addEventListener(){}},location:{pathname:'/gaeru_ceo/products/'+productId+'/edit',search:inTrash?'?trash=1':''},history:{replaceState(){}},FormData:class{},WeakMap,URL:{createObjectURL(){},revokeObjectURL(){}},fetch:async(path,options={})=>({ok:true,json:async()=>{if(path==='/api/auth/me')return {authenticated:true,permissions:['catalog.read','catalog.write','inventory.approve']};if(path==='/api/csrf')return {csrfToken:'fixture'};if(path==='/api/gaeru_ceo/product-workspace'&&options.method==='POST'){posted=JSON.parse(options.body);return structuredClone(fixture);}if(path==='/api/gaeru_ceo/product-workspace/'+productId+(inTrash?'?trash=1':''))return structuredClone(fixture);throw Error('Unexpected request in editor fixture');}})};
 vm.runInNewContext(fs.readFileSync(require.resolve('../admin/product-editor.js'),'utf8'),context);await new Promise(resolve=>setImmediate(resolve));
 assert.match(node('#product-preview').innerHTML,/<img src="\/assets\/products\/k9\.webp"/);
 assert.match(node('#gallery').innerHTML,/<img src="\/assets\/products\/k9\.webp"/);assert.ok(node('#gallery').innerHTML.includes('src="'+catalogPreview+'"'));
 assert.ok(node('#variant-rows').innerHTML.includes('<option value="/assets/products/k9.png"'));assert.ok(node('#variant-rows').innerHTML.includes('<option value="'+catalog+'"'));assert.ok(node('#variant-rows').innerHTML.includes('src="'+catalogPreview+'"'));
 await draft.onclick();
 assert.ok(posted,'Editor should save the fixture');assert.equal(posted.inTrash,inTrash?true:undefined);assert.equal(posted.product.active,false);assert.equal(Boolean(publish.hidden),inTrash);assert.equal(posted.product.imageUrl,fixture.product.imageUrl);assert.deepEqual(posted.gallery,fixture.gallery);assert.equal(posted.variants[0].imageUrl,catalog);assert.ok(!JSON.stringify(posted).includes('webp-20261025'));assert.ok(!JSON.stringify(posted).includes('/api/gaeru_ceo/catalog-images/'));
});
