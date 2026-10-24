const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const choices=require('../variant-choices');
test('visual product selection updates the exact cart variant, price, stock and picture together',()=>{
 const source=fs.readFileSync(require('node:path').join(__dirname,'../commerce.js'),'utf8').split('function renderProduct() {')[1].split('function renderCart() {')[0];
 const variants=[{id:'one',name:'Type-C',sku:'TYPEC',active:true,stockQuantity:3,priceVnd:100000,options:{Cổng:'Type-C'},imageUrl:'/one.png'},{id:'two',name:'Lightning',sku:'LIGHTNING',active:true,stockQuantity:0,priceVnd:120000,options:{Cổng:'Lightning'},imageUrl:'/two.png'}];
 const nodes=new Map();const node=s=>{if(!nodes.has(s))nodes.set(s,{value:'one',textContent:'',dataset:{},listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},dispatchEvent(event){this.listeners[event.type]?.();}});return nodes.get(s);};
 const root=node('#product-detail');root.querySelector=node;root.querySelectorAll=()=>[];const document={title:'',querySelector:node};
 vm.runInNewContext('function renderProduct(){'+source+'\nrenderProduct();',{document,products:[{slug:'fixture',name:'Fixture',descriptor:'Test',description:'Description',imageUrl:'/cover.png',imageAlt:'Cover',variants,gallery:['/cover.png']}],location:{search:'?id=fixture'},URLSearchParams,escapeHtml:v=>String(v??''),formatPrice:v=>String(v),window:{GAERUVariantChoices:choices},Event:class{constructor(type){this.type=type;}}});
 assert.match(root.innerHTML,/data-option-value="Lightning"/);
 root.listeners.click({target:{closest:s=>s==='[data-option-group]'?{dataset:{optionGroup:'Cổng',optionValue:'Lightning'}}:null}});
 assert.equal(node('[data-add-to-cart]').dataset.addToCart,'two');assert.equal(node('[data-add-to-cart]').disabled,true);assert.equal(node('[data-selected-price]').textContent,'120000');assert.equal(node('[data-product-main-image]').src,'/two.png');assert.equal(node('[data-stock-note]').textContent,'Hết hàng');
 root.listeners.click({target:{closest:s=>s==='[data-option-group]'?{dataset:{optionGroup:'Cổng',optionValue:'Type-C'}}:null}});
 assert.equal(node('[data-add-to-cart]').dataset.addToCart,'one');assert.equal(node('[data-add-to-cart]').disabled,false);assert.equal(node('[data-product-main-image]').src,'/one.png');assert.equal(node('[data-stock-note]').textContent,'Còn hàng');
});
