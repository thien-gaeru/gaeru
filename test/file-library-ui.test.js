const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
test('library UI escapes names, protects linked files, filters scopes and previews media privately',async()=>{
 const {window,document}=parseHTML('<html><body><section id="file-library-view"></section></body></html>');
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||this.querySelector('option')?.value||'';},set(value){for(const option of this.querySelectorAll('option')){if(option.value===value)option.setAttribute('selected','');else option.removeAttribute('selected');}}});
 window.HTMLElement.prototype.showModal=function(){this.setAttribute('open','');};
 window.HTMLElement.prototype.close=function(){this.dispatchEvent(new window.Event('close'));};
 const requests=[];const data={root:'/private/media',scopes:{products:'Sản phẩm',documents:'Tài liệu'},folders:[],summary:{files:2,bytes:1600,trash:0},total:2,page:1,pages:1,files:[{key:'products/11111111-1111-4111-8111-111111111111.webp',name:'<img src=x onerror=alert(1)>.webp',scope:'products',size:800,mime:'image/webp',references:['Ảnh sản phẩm · fixture'],managed:false},{key:'documents/22222222-2222-4222-8222-222222222222.mp4',name:'Video.mp4',scope:'documents',size:800,mime:'video/mp4',references:[],managed:true}]};
 window.GAERUAdmin={request:async url=>{requests.push(url);return data;},showGlobal(){}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../admin/file-library.js'),'utf8'),{window,document,URLSearchParams,FormData,Intl});
 await window.GAERUFileLibrary.load();
 assert.equal(document.querySelectorAll('.fl-card').length,2,document.querySelector('.fl-feedback').textContent);assert.equal(document.querySelectorAll('[onerror]').length,0);assert.match(document.querySelector('.fl-card h3').textContent,/<img src=x/);
 assert.ok(document.querySelector('.fl-card [data-action=trash]').disabled);assert.equal(document.querySelectorAll('.fl-card')[1].querySelector('[data-action=trash]').disabled,false);
 assert.match(document.querySelector('.fl-thumbnail img').src,/^\/api\/gaeru_ceo\/file-library\/file\?key=/);assert.match(document.querySelector('.fl-thumbnail img').src,/thumbnail=1/);
 document.querySelectorAll('[data-action=preview]')[1].click();assert.equal(document.querySelector('dialog video').getAttribute('preload'),'metadata');assert.match(document.querySelector('dialog video').getAttribute('src'),/preview=1/);
 document.querySelector('[data-fl-scope=documents]').click();await new Promise(r=>setImmediate(r));assert.match(requests.at(-1),/scope=documents/);
 document.querySelector('[data-fl-trash]').click();await new Promise(r=>setImmediate(r));assert.match(requests.at(-1),/trash=1/);
 const html=fs.readFileSync(require.resolve('../admin/index.html'),'utf8');assert.match(html,/data-view="file-library"[^>]*data-owner-only/);assert.match(html,/file-library-view/);
});

test('owner-only library entry does not hide the shared content menu from staff',()=>{
 const {document}=parseHTML('<html><body><div class="nav-group"><button data-view="file-library" data-permission="settings.read" data-owner-only></button><button data-view="products" data-permission="catalog.read"></button></div></body></html>');
 const source=fs.readFileSync(require.resolve('../admin/admin.js'),'utf8'),fn=source.slice(source.indexOf('function applyPermissions()'),source.indexOf('async function request('));
 vm.runInNewContext(fn+'applyPermissions();',{document,state:{session:{role:'admin',source:'staff'}},can:()=>true});
 assert.equal(document.querySelector('[data-view=file-library]').hidden,true);
 assert.equal(document.querySelector('[data-view=products]').hidden,false);
 assert.equal(document.querySelector('.nav-group').hidden,false);
});
