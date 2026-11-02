const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
function mountedMarkup(admin){
 const body={value:'',addEventListener(){}},form={elements:{body},querySelector:()=>({})},messages={};
 const root={innerHTML:'',querySelector:s=>s==='form'?form:s==='[data-chat-messages]'?messages:{}};
 const window={GAERUAdmin:{can:()=>true},matchMedia:()=>({matches:false})};
 const source=fs.readFileSync(require.resolve('../shopping-chat-client.js'),'utf8');
 vm.runInNewContext(source.slice(0,source.indexOf('    function media('))+'return {};}};})();',{window});
 window.GAERUChatClient.mount(root,{base:'/test',request:async()=>({}),admin});return parseHTML(root.innerHTML).document;
}
test('admin composer removes the quick-reply controls while customer composer keeps its own suggestions',()=>{
 const admin=mountedMarkup(true),customer=mountedMarkup(false);
 assert.equal(admin.querySelector('[data-chat-quick-bar]'),null);assert.equal(admin.querySelector('[data-chat-instant-mode]'),null);assert.ok(admin.querySelector('[data-chat-compose] textarea'));
 assert.ok(customer.querySelector('[data-chat-quick-bar]'));assert.equal(customer.querySelectorAll('[data-quick-reply]').length,4);
});

test('file library offers confirmed chat deletion even when the attachment is a protected system file',async()=>{
 const {window,document}=parseHTML('<html><body><section id="file-library-view"></section></body></html>');
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||'';},set(){}});
 window.HTMLElement.prototype.showModal=function(){this.setAttribute('open','');};window.HTMLElement.prototype.close=function(){this.dispatchEvent(new window.Event('close'));};
 const key='chat/11111111-1111-4111-8111-111111111111.txt',calls=[];
 const data={root:'/fixture',retentionDays:30,scopes:{chat:'Tệp hội thoại'},folders:[],summary:{files:1,bytes:10,trash:0},total:1,page:1,pages:1,files:[{key,name:'fixture.txt',scope:'chat',size:10,mime:'text/plain',references:['Tệp hội thoại · fixture'],managed:false,canDeleteChat:true}]};
 window.GAERUAdmin={request:async(url,options)=>{calls.push({url,options});return options?{message:'Đã xóa.'}:data;},showGlobal(){}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../admin/file-library.js'),'utf8'),{window,document,URLSearchParams,FormData,Intl});await window.GAERUFileLibrary.load();
 assert.equal(document.querySelector('[data-action=trash]').disabled,true);assert.equal(document.querySelector('[data-action="chat-delete"]').disabled,false);
 document.querySelector('[data-action="chat-delete"]').click();const form=document.querySelector('dialog form');
 assert.match(form.textContent,/Không thể khôi phục/);Object.defineProperty(form,'elements',{value:{confirm:{checked:true}}});form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));
 const call=calls.find(c=>c.url.endsWith('/chat-file'));assert.ok(call);assert.deepEqual(JSON.parse(call.options.body),{key,action:'chat-delete',confirm:true});
});
