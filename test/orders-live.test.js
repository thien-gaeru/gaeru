const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../admin/admin-orders.js'),'utf8');
function fixture(){
 const nodes=new Map();for(const id of ['order-list','orders-view','order-filter','order-search','order-payment-filter','order-method-filter','order-sort','order-page-size','order-live-status','order-list-status'])nodes.set('#'+id,{value:'',hidden:false,textContent:'',attrs:{},getAttribute(k){return this.attrs[k]},setAttribute(k,v){this.attrs[k]=v}});
 nodes.get('#order-sort').value='newest';nodes.get('#order-page-size').value='25';
 let resolve,draws=0;const result={orders:[{id:'new'}],pagination:{page:2,total:1,pageCount:2},overview:{pending:1}};
 const state={orderPage:2,orderRequest:0,selectedOrders:new Set(),orders:[]};
 const document={hidden:false,activeElement:null,querySelector:s=>nodes.get(s)||null,querySelectorAll:()=>[]};
 const ctx={state,document,can:()=>true,URLSearchParams,Date,JSON,updateOrderSelection(){},renderOrders(){draws++},renderOrderOverview(){},request:()=>new Promise(r=>resolve=r)};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function orderEditing()'),source.indexOf("document.addEventListener('DOMContentLoaded'")),ctx);
 return {ctx,state,nodes,result,get draws(){return draws},resolve(){resolve(result)}};
}
test('background new orders preserve page and render only changed results',async()=>{const f=fixture();let p=f.ctx.loadOrders(2,{background:true});f.resolve();await p;assert.equal(f.draws,1);assert.equal(f.state.orderPage,2);p=f.ctx.loadOrders(2,{background:true});f.resolve();await p;assert.equal(f.draws,1)});
test('selection started during fetch is never discarded; deferred update applies after deselection',async()=>{const f=fixture();let p=f.ctx.loadOrders(2,{background:true});f.state.selectedOrders.add('existing');f.resolve();await p;assert.equal(f.draws,0);assert.equal(f.state.selectedOrders.size,1);assert.match(f.nodes.get('#order-live-status').textContent,/Có cập nhật/);f.state.selectedOrders.clear();p=f.ctx.loadOrders(2,{background:true});f.resolve();await p;assert.equal(f.draws,1)});
test('background responses cannot overwrite a new filter or hidden view',async()=>{for(const hide of [false,true]){const f=fixture();const p=f.ctx.loadOrders(2,{background:true});if(hide)f.nodes.get('#orders-view').hidden=true;else f.nodes.get('#order-filter').value='completed';f.resolve();await p;assert.equal(f.draws,0)}});
test('open processing popup preserves unsaved edits',async()=>{const f=fixture(),query=f.ctx.document.querySelector;f.ctx.document.querySelector=s=>s==='dialog[open]'?{}:query(s);const p=f.ctx.loadOrders(2,{background:true});f.resolve();await p;assert.equal(f.draws,0)});
