'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const settle = () => new Promise(ok => setImmediate(ok));

test('authenticated admin assets load once, stay inert on login and retry a failed tab', async () => {
  const {document} = parseHTML(source('admin/index.html'));
  const html = source('admin/index.html');
  const specs = [...document.querySelectorAll('template[data-admin-assets]')];
  assert.ok(specs.length > 30);
  assert.ok(specs.some(t => t.dataset.adminAssets === 'pages' && t.content.firstElementChild.src.includes('pages.js')));
  assert.match(html, /<script src="\/account-security\.js/);
  const script = source('admin/admin.js');
  const context = vm.createContext({document,Promise,Error});
  vm.runInContext(script.slice(script.indexOf('const adminAssetRequests'), script.indexOf('async function showAdmin')),context);
  const template = specs.find(t=>t.dataset.adminAssets==='pages');
  const first = context.loadAdminAssets('pages');
  template.nextElementSibling.onerror();
  await assert.rejects(first);
  const retry=context.loadAdminAssets('pages'), duplicate=context.loadAdminAssets('pages');
  const loaded = template.nextElementSibling;
  assert.equal(loaded.tagName,'SCRIPT');
  loaded.onload();
  await Promise.all([retry,duplicate]);
  assert.equal(loaded,template.nextElementSibling);
  assert.doesNotMatch(source('admin/admin.js').split('async function showAdmin(session)')[0].split('async function initialize()')[1].split('const adminAssetRequests')[0],/loadAdminAssets\('session'\)/);
});

function noticeSetup() {
  const {window, document} = parseHTML('<body><div id="admin-app"></div><section id="notifications-view"></section></body>');
  const root=document.querySelector('section');
  const baseNotice={key:'order:1',version:'1',title:'Một đơn',target:'orders',detail:'Cần xử lý',read:false};
  const state={data:[baseNotice],count:26,failServer:false,failDevice:false,preference:{desktop:true,sound:false},calls:[]};
  let fixtureSub;
  function subscribeFixture(){
    fixtureSub={endpoint:'https://example.invalid/fixture',async unsubscribe(){if(state.failDevice)return false;fixtureSub=null;return true;}};
  }
  subscribeFixture();
  const registration={pushManager:{async getSubscription(){return fixtureSub;}}};
  const worker={async getRegistrations(){return [];},async register(){return registration;},ready:Promise.resolve()};
  const nav={serviceWorker:worker};
  const prefs={getItem:()=>JSON.stringify(state.preference),setItem:(_k,v)=>{state.preference=JSON.parse(v);}};
  let allowed=false;
  const admin={user:{username:'fixture'},can:perm=>allowed && perm==='dashboard.read',showGlobal(){},async request(url,opts={}){
    state.calls.push([url,opts]);
    if(url.includes('push-unsubscribe')){if(state.failServer)throw Error('Mất kết nối máy chủ');return {ok:true};}
    const p=Number(new URL(url,'https://example.invalid').searchParams.get('page'))||1;
    return {items:p===1?state.data:[{...baseNotice,key:'order:26'}],page:p,pages:2,total:state.count,unread:2};
  }};
  const Notification={permission:'granted'};
  const browser={GAERUAdmin:admin,GAERUCareLive:{poll:()=>({stop(){},refresh(){}})},PushManager:class{},Notification,addEventListener(){}};
  const ctx=vm.createContext({window:browser,document,navigator:nav,Notification,localStorage:prefs,AbortSignal,URL,console,setTimeout,clearTimeout});
  vm.runInContext(source('admin/notifications.js'),ctx);
  allowed=true;
  return {root,state,document,window,browser,load:browser.GAERUNotifications.load};
}

test('notification polling retains controls and row nodes and page navigation shows counts', async()=>{
  const {root,state,load,document,window}=noticeSetup();await load();
  const pref=root.querySelector('[data-notice-sound]'),first=root.querySelector('[data-notice-open]'),mark=root.querySelector('[data-notice-read]');
  for(let i=0;i<2;i++)await load();
  assert.equal(root.querySelector('[data-notice-sound]'),pref);
  assert.equal(root.querySelector('[data-notice-open]'),first);
  assert.equal(root.querySelector('[data-notice-read]'),mark);
  let active=first;Object.defineProperty(document,'activeElement',{get:()=>active?.isConnected?active:null});
  const proto=Object.getPrototypeOf(first);
  const oldFocus=proto.focus;proto.focus=function(){active=this;};
  try{
    state.data=[{...state.data[0],read:true,version:'2'}];await load();assert.equal(active,root.querySelector('[data-notice-open]'));
    root.querySelector('[data-notice-page="1"]').dispatchEvent(new window.Event('click',{bubbles:true}));await settle();
    assert.match(root.querySelector('[data-notice-page-info]').textContent,/2\/2.*26.*2 chưa đọc/);
    assert.equal(root.querySelector('[data-notice-key]').dataset.noticeKey,'order:26');
    assert.ok(state.calls.some(([u])=>u.includes('page=2&pageSize=25')));
  }finally{proto.focus=oldFocus;}
});

test('failed push disable retains retry; confirmation requires server and device success',async()=>{
  const {root,state,window,load}=noticeSetup();await load();
  const click=async()=>{root.querySelector('[data-notice-desktop]').dispatchEvent(new window.Event('click',{bubbles:true}));await settle();};
  state.failServer=true;await click();assert.equal(state.preference.desktop,true);assert.match(root.querySelector('[role=status]').textContent,/Mất kết nối/);
  state.failServer=false;state.failDevice=true;await click();assert.equal(state.preference.desktop,true);assert.match(root.querySelector('[role=status]').textContent,/chưa xác nhận/);
  state.failDevice=false;await click();assert.equal(state.preference.desktop,false);assert.match(root.querySelector('[role=status]').textContent,/Đã tắt/);
});

test('admin worker preserves storefront and unrelated same-origin caches',async()=>{
  const handlers={},removed=[];
  vm.runInNewContext(source('admin/notification-worker.js'),{self:{addEventListener:(k,f)=>handlers[k]=f,clients:{claim:async()=>{}}},caches:{keys:async()=>['gaeru-admin-v0','gaeru-admin-v1','gaeru-store-v3','gaeru-admin-other-v2'],delete:async k=>removed.push(k)}});
  let task;handlers.activate({waitUntil:p=>{task=p;}});await task;assert.deepEqual(removed,['gaeru-admin-v0']);
});

test('policy reading defers the full catalog and the mini cart uses the real commerce script on first open',()=>{
  for(const file of ['pricing','complaints','delivery-returns','legal','payment','privacy','terms']){
    const {document}=parseHTML(source(file+'.html'));assert.ok(document.body.dataset.policyCommerce.startsWith('/commerce.js?'));
    assert.ok(!document.querySelector('script[src*="commerce.js"],script[src*="checkout-flow.js"],script[src*="product-art.js"]'));
  }
  const {window,document}=parseHTML('<html><head></head><body data-policy-commerce="/commerce.js"><div data-mini-cart></div></body></html>');
  let requests=0;const js=source('store-shell.js');const logic=js.slice(js.indexOf('const policyCommerceUrl'),js.indexOf('function populateCustomerNewsletterEmail'));
  vm.runInNewContext(logic,{window,document,refreshMenuProducts:()=>requests++});
  assert.equal(requests,0);assert.equal(document.querySelectorAll('script').length,0);
  document.dispatchEvent(new window.Event('gaeru:cart-panel-open'));
  document.dispatchEvent(new window.Event('gaeru:cart-panel-open'));
  assert.equal(document.querySelectorAll('script').length,1);
  assert.equal(document.querySelector('script').src,'/commerce.js');
  document.querySelector('script').onerror();
  assert.equal(document.querySelector('[data-mini-cart] a').href,'/gio-hang');
  document.dispatchEvent(new window.Event('gaeru:cart-panel-open'));assert.equal(document.querySelectorAll('script').length,1);
});
