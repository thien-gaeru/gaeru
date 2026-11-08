'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};

async function accountPage(hash='',search='',fetchOverride) {
  const {document,window:dom}=parseHTML(fs.readFileSync(require.resolve('../account.html'),'utf8'));
  const calls=[],listeners={},location={pathname:'/tai-khoan',search,hash};
  let opens=0;
  const window={location,innerWidth:1200,addEventListener:(name,fn)=>listeners[name]=fn,GAERUAccountSettings:{open(){opens++;}},GAERUCustomerSession:{set(){}}};
  const customer={id:'fixture',fullName:'Fixture Customer',email:'fixture@example.invalid',phone:'0912345678',emailVerified:true};
  const context={document,window,history:{replaceState(_state,_title,url){location.hash=new URL(url,'https://gaeru.com').hash;}},fetch:async(url,options={})=>{calls.push({url,options});const response={ok:true,status:200,json:async()=>url==='/api/customer-auth/me'?{authenticated:true,customer}:url==='/api/csrf'?{csrfToken:'fixture'}:{csrfToken:'fixture'}};return fetchOverride?fetchOverride(url,options,response):response;},AbortController,URLSearchParams,Intl,Event:dom.Event,CustomEvent:dom.CustomEvent,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../account.js'),'utf8'),context);
  await flush();
  return {document,calls,listeners,window,context,customer,get opens(){return opens;}};
}

test('one logout click submits one request even while another click is pending',async()=>{
  const ui=await accountPage(),button=ui.document.querySelector('[data-account-logout]');
  button.click();button.click();await flush();
  assert.equal(ui.calls.filter(call=>call.url==='/api/customer-auth/logout').length,1);
  assert.equal(ui.document.querySelector('[data-account-profile]').hidden,true);
});

test('default account and workspace readiness keep settings closed until the customer opens them',async()=>{
  const ui=await accountPage();assert.equal(ui.opens,0);
  ui.listeners['gaeru:workspace-ready']();ui.listeners['gaeru:security-ready']();assert.equal(ui.opens,0);
  const link=ui.document.createElement('a');link.dataset.accountTab='profile';ui.document.body.append(link);link.click();assert.equal(ui.opens,1);
});

test('OAuth redirect notices survive session initialization and percent signs do not break account loading',async()=>{
  const ui=await accountPage('','?oauthError='+encodeURIComponent('Google 100% chưa sẵn sàng'));
  assert.equal(ui.document.querySelector('[data-account-loading]').hidden,true);
  assert.equal(ui.document.querySelector('[data-account-feedback]').textContent,'Google 100% chưa sẵn sàng');
  const linked=await accountPage('','?linkRequired=1&email='+encodeURIComponent('fixture+100%@example.invalid'));
  assert.equal(linked.document.querySelector('[name=identifier]').value,'fixture+100%@example.invalid');
  assert.match(linked.document.querySelector('[data-account-feedback]').textContent,/đăng nhập bằng mật khẩu/);
});

test('Google login completes the second factor before publishing the customer profile',async()=>{
  const ui=await accountPage();let callback,challengeCalls=0,published;
  ui.window.google={accounts:{id:{initialize(options){callback=options.callback;},renderButton(){}}}};
  ui.window.GAERUSecurity={async loginChallenge(result){challengeCalls++;assert.equal(result.mfaRequired,true);return {csrfToken:'after-mfa',customer:ui.customer};}};
  ui.window.GAERUCustomerSession.set=customer=>published=customer;
  ui.context.fetch=async url=>({ok:true,status:200,json:async()=>url==='/api/customer-auth/oauth/config'?{google:{clientId:'fixture-client'}}:url==='/api/csrf'?{csrfToken:'before-mfa'}:{mfaRequired:true,message:'Fixture challenge'}});
  await vm.runInNewContext('initGoogleOAuth()',ui.context);
  assert.equal(typeof callback,'function');await callback({credential:'isolated-fixture'});
  assert.equal(challengeCalls,1);assert.equal(published.id,'fixture');
});

test('Google login popup 409 linkRequired switches to login form, fills email and prompts password entry',async()=>{
  const ui=await accountPage('#register');let callback;
  ui.window.google={accounts:{id:{initialize(options){callback=options.callback;},renderButton(){}}}};
  ui.context.fetch=async url=>{
    if(url==='/api/customer-auth/oauth/config')return {ok:true,status:200,json:async()=>({google:{clientId:'fixture-client'}})};
    if(url==='/api/csrf')return {ok:true,status:200,json:async()=>({csrfToken:'test-csrf'})};
    if(url==='/api/customer-auth/oauth/google')return {ok:false,status:409,json:async()=>({linkRequired:true,email:'google.user@example.com',error:'Email này đã tồn tại tài khoản GAERU. Vui lòng đăng nhập mật khẩu trước để liên kết Google an toàn.'})};
    return {ok:false,status:404,json:async()=>({})};
  };
  await vm.runInNewContext('initGoogleOAuth()',ui.context);
  assert.equal(typeof callback,'function');
  await callback({credential:'google-test-token'});
  assert.equal(ui.document.querySelector('[data-account-panel="login"]').hidden,false);
  assert.equal(ui.document.querySelector('[data-account-form="login"] [name="identifier"]').value,'google.user@example.com');
  assert.match(ui.document.querySelector('[data-account-feedback]').textContent,/đăng nhập bằng mật khẩu/);
});

test('security deep links open account settings after the workspace is mounted',async()=>{
  const ui=await accountPage('#security');assert.equal(ui.opens,1);
  ui.listeners['gaeru:workspace-ready']();assert.equal(ui.opens,2);
});

test('an old account session read cannot replace a newer login or logout notification',async()=>{
 for(const logout of [false,true]){
   let release;const ui=await accountPage('','',(url,_options,response)=>url==='/api/customer-auth/me'?new Promise(resolve=>release=resolve):response);
   ui.window.GAERUCustomerSession.customer={...ui.customer,fullName:'Newer session'};
   ui.document.dispatchEvent(new ui.context.CustomEvent('gaeru:customer-updated'));
   if(logout){ui.window.GAERUCustomerSession.customer=null;ui.document.dispatchEvent(new ui.context.CustomEvent('gaeru:customer-updated'));}
   release({ok:true,status:200,json:async()=>logout?{authenticated:true,customer:ui.customer}:{authenticated:false}});await flush();
   assert.equal(ui.document.querySelector('[data-account-profile]').hidden,logout);
   if(!logout)assert.equal(ui.document.querySelector('[data-customer-name]').textContent,'Newer session');
 }
});
