const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{parseHTML}=require('linkedom');

test('customer list sends verification filter and displays both counts without treating a lock as verification',async()=>{
 const {document}=parseHTML('<html><body><input id="customer-search" value=""><select id="customer-verification"><option value="all">All</option><option value="verified" selected>Verified</option><option value="unverified">Unverified</option></select><div id="loyalty-policy-host"></div><div id="customer-list"></div><nav id="customer-pagination"><span id="customer-page-label"></span><button id="previous-customers"></button><button id="next-customers"></button></nav></body></html>');
 const all=fs.readFileSync(require.resolve('../admin/admin.js'),'utf8'),start=all.indexOf('async function loadCustomers('),end=all.indexOf('async function showCustomerDetail(',start),calls=[];
 const policy={version:0,tiers:[{id:'bronze',minPoints:0,earnBasisPoints:100},{id:'silver',minPoints:100000,earnBasisPoints:120},{id:'gold',minPoints:500000,earnBasisPoints:150},{id:'platinum',minPoints:2000000,earnBasisPoints:200}]};
 const context={document,URLSearchParams,Date,state:{customerPage:1},can:()=>true,showGlobal:message=>assert.fail(message),escapeHtml:s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),request:async url=>{calls.push(url);if(url.endsWith('/loyalty-policy'))return{policy,tierBenefits:Object.fromEntries(policy.tiers.map(t=>[t.id,{name:t.id}]))};return{customers:[{id:'fixture',fullName:'Verified Fixture',email:'v@example.test',phone:'0900000000',active:false,emailVerified:true,createdAt:'2026-10-01',orderCount:0}],verificationCounts:{all:3,verified:1,unverified:2},pagination:{page:1,pageCount:1,total:1}};}};
 const policyStart=all.indexOf('async function loadLoyaltyPolicy('),policyEnd=all.indexOf('async function toggleCustomer(',policyStart);
 vm.runInNewContext(all.slice(start,end)+'\n'+all.slice(policyStart,policyEnd)+'\nthis.loadCustomers=loadCustomers;this.loadLoyaltyPolicy=loadLoyaltyPolicy;',context);await context.loadCustomers();
 assert.equal(new URL('https://example.test'+calls.find(url=>url.includes('/customers?'))).searchParams.get('verification'),'verified');
 assert.equal(document.querySelectorAll('[data-tier-min]').length,0);await context.loadLoyaltyPolicy();assert.equal(document.querySelectorAll('[data-tier-min]').length,4);assert.equal(document.querySelector('[data-tier-rate="gold"]').value,'1.5');
 await context.loadCustomers();assert.equal(calls.filter(url=>url.endsWith('/loyalty-policy')).length,1);
 const labels=[...document.querySelectorAll('option')].map(o=>o.textContent);assert.deepEqual(labels,['Tất cả tài khoản (3)','Đã xác minh (1)','Chưa xác minh (2)']);
 assert.match(document.querySelector('#customer-list').textContent,/Đã khóa/);assert.match(document.querySelector('#customer-list').textContent,/Đã xác minh/);
});

async function fixture(){
 const {document}=parseHTML('<html><body><section id="tiktok-ads-configuration" hidden></section></body></html>'),listeners={},calls=[];
 document.addEventListener=(type,fn)=>(listeners[type]||=[]).push(fn);
 const response={configuration:{version:1,advertiserId:'1234567890123',enabled:false,secretConfigured:true},connection:{connected:true,name:'<script>unsafe</script>',currency:'VND',timezone:'Asia/Jakarta',lastSyncedAt:null}};
 const window={GAERUAdmin:{user:{role:'owner',source:'bootstrap'},showGlobal(){},async request(path,opts={}){calls.push({path,opts});return opts.method?{...response,message:'Fixture completed'}:response;}}};
 const context={document,window,Intl,Date,JSON};vm.runInNewContext(fs.readFileSync(require.resolve('../admin/tiktok-ads.js'),'utf8'),context);await window.GAERUTikTokAds.mount();
 function form(){const f=document.querySelector('form');const elements=Object.fromEntries([...f.querySelectorAll('input')].map(i=>[i.name,i]));Object.defineProperty(f,'elements',{value:elements});elements.enabled.checked=false;return f;}
 return{document,window,listeners,calls,form};
}
test('TikTok settings escape provider account names and never fill a retained access token or password',async()=>{
 const f=await fixture();assert.equal(f.document.querySelectorAll('script').length,0);assert.match(f.document.querySelector('#tiktok-ads-configuration').textContent,/Asia\/Jakarta/);const form=f.form();assert.equal(form.elements.accessToken.value,'');assert.equal(form.elements.password.value,'');assert.match(f.document.querySelector('#tiktok-ads-configuration').textContent,/GMV Max/);
});

test('TikTok tests require saved configuration and fresh credentials, then clear consumed credential fields',async()=>{
 const f=await fixture(),form=f.form(),button=form.querySelector('[data-tiktok-ads-action="test"]');form.elements.password.value='fixture-current-password';form.elements.advertiserId.value='9999999999999';
 for(const fn of f.listeners.click)await fn({target:button});assert.equal(f.calls.filter(c=>c.opts.method).length,0);assert.match(form.querySelector('[role=status]').textContent,/Lưu các thay đổi/);
 form.elements.advertiserId.value='1234567890123';for(const fn of f.listeners.click)await fn({target:button});const request=f.calls.find(c=>c.opts.method);assert.equal(request.path,'/api/gaeru_ceo/owner/tiktok-ads/test');const body=JSON.parse(request.opts.body);assert.equal(body.password,'fixture-current-password');assert.equal(body.version,1);assert.equal(form.elements.password.value,'');assert.equal(form.elements.accessToken.value,'');
 const fresh=f.form();assert.equal(fresh.elements.password.value,'');assert.equal(fresh.elements.accessToken.value,'');
});

test('business reports show saved Ads dates and missing ranges instead of implying a complete selected period',()=>{
 const all=fs.readFileSync(require.resolve('../admin/enterprise.js'),'utf8'),start=all.indexOf('function advertisingCoverage('),end=all.indexOf('async function loadReports(',start);
 const context={number:v=>String(v),h:v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))};vm.runInNewContext(all.slice(start,end)+'\nthis.render=advertisingCoverage;',context);
 const {document}=parseHTML(`<html><body>${context.render({days:2,expectedDays:5,firstDate:'2026-10-01',lastDate:'2026-10-03',complete:false,missingDateRanges:[{from:'2026-10-02',to:'2026-10-02'},{from:'2026-10-04',to:'2026-10-05'}]})}</body></html>`);
 assert.match(document.body.textContent,/2 \/ 5 ngày đã có dữ liệu/);assert.match(document.body.textContent,/Ngày đã lưu: 2026-10-01 – 2026-10-03/);assert.match(document.body.textContent,/Thiếu dữ liệu: 2026-10-02, 2026-10-04 – 2026-10-05/);assert.doesNotMatch(document.body.textContent,/Đủ ngày/);
 assert.match(context.render({days:1,expectedDays:1,firstDate:'2026-10-03',lastDate:'2026-10-03',complete:true,missingDateRanges:[]}),/Đủ ngày trong kỳ đã chọn/);
 assert.match(all,/h\(a.currency\),h\(a.timezone\),h\(a.scope\),advertisingCoverage\(a\)/);
});
