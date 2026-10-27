const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ui=require('../admin/admin-ui');
test('every admin navigation entry has a unique title and contextual description',()=>{
 const html=fs.readFileSync(require.resolve('../admin/index.html'),'utf8');
 const keys=[...html.matchAll(/data-view="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(new Set(keys).size,keys.length);
 assert.deepEqual([...keys].sort(),Object.keys(ui.views).sort());
 for(const key of keys){assert.ok(ui.title(key));assert.ok(ui.description(key).length>20);}
 assert.equal(ui.roleName('owner'),'Chủ doanh nghiệp');
 assert.equal(ui.title('warranty'),'Bảo hành sản phẩm');assert.equal(ui.imageUrl('https://www.gaeru.com/assets/products/k9.png'),'/assets/products/k9.webp');assert.equal(ui.imageUrl('https://gaeru.com/api/catalog-images/11111111-2222-3333-4444-555555555555'),'/api/gaeru_ceo/catalog-images/11111111-2222-3333-4444-555555555555?v=webp-20261025');
});

test('navigation validates access and maintains loading state and direct links',async()=>{
 const vm=require('node:vm');const source=fs.readFileSync(require.resolve('../admin/admin.js'),'utf8');
 const code=source.slice(source.indexOf('async function activateView('),source.indexOf('window.addEventListener("hashchange"'));
 const attrs={};const button={dataset:{view:'overview',permission:'dashboard.read'},hidden:false,classList:{toggle(){}},setAttribute(){}};
 const panel={id:'overview-view',setAttribute:(k,v)=>attrs[k]=v};const loading={textContent:''};const title={textContent:''};const description={textContent:''};
 const document={getElementById:id=>id==='admin-view-state'?loading:panel,querySelectorAll:s=>s==='[data-view]'?[button]:[panel],querySelector:s=>s==='#view-title'?title:s==='#view-description'?description:s==='.sidebar'?{classList:{remove(){}}}:{setAttribute(){}}};
 let loaded=0,hash='';const context={document,state:{viewRequest:0},can:()=>true,location:{hash:''},history:{pushState:(_a,_b,value)=>hash=value},showGlobal(){},loadSummary:async()=>{loaded++},window:{GAERUAdminUI:ui}};
 vm.createContext(context);vm.runInContext(code,context);
 await context.activateView('overview');assert.equal(loaded,1);assert.equal(hash,'#overview');assert.equal(attrs['aria-busy'],'false');assert.equal(loading.textContent,'');assert.equal(title.textContent,ui.title('overview'));
 button.hidden=true;await context.activateView('overview');await context.activateView('overview"]');assert.equal(loaded,1);
});
