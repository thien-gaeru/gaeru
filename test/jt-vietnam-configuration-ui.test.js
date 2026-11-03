'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
test('J&T admin distinguishes account proof from fulfillment and offers all credentials without revealing stored secrets',async()=>{
  const {document}=parseHTML('<html><body><section id="system-configuration"></section><section id="shipping-configuration"></section></body></html>');
  const records={chat_ai:{version:0,data:{enabled:false}},shipping_jt:{version:2,data:{accountId:'FIXTURE',partnerCode:'90000000000000001',environment:'sandbox',secretConfigured:true,customerPasswordConfigured:true,pickupProvince:'Hà Nội',pickupArea:'Phường Ba Đình'}}};
  const admin={user:{role:'owner',source:'bootstrap'},showGlobal(){},async request(path){return path.endsWith('/owner/shipping')?{carriers:[{id:'jt',name:'J&T Express',supported:true,accountVerified:true,verified:false,checkoutReady:false,enabled:false,environment:'sandbox'}]}:{records,services:{},callbacks:{}};}};
  const context={window:{GAERUAdmin:admin},document,setTimeout:fn=>fn()};
  vm.runInNewContext(fs.readFileSync(require.resolve('../admin/configuration.js'),'utf8'),context);
  await context.window.GAERUConfiguration.load();
  await context.window.GAERUConfiguration.mountShipping();
  const card=document.getElementById('config-panel-shipping_jt');assert.ok(card);assert.match(card.textContent,/Đã xác thực tài khoản thử nghiệm/);assert.ok(card.querySelector('[data-shipping-enable]').hasAttribute('disabled'));
  context.window.GAERUConfiguration.openConfigModal('shipping_jt');
  const form=document.querySelector('#config-popup-modal form');assert.ok(form);
  for(const name of ['accountId','partnerCode','secret','customerPassword','pickupProvince','pickupArea','environment','payType','serviceType'])assert.ok(form.querySelector('[name='+name+']'),name);
  const prepared=form.querySelector('[name=customerPassword]');assert.equal(prepared.type,'password');assert.equal(prepared.value,'');assert.match(prepared.getAttribute('placeholder'),/Đã lưu/);
  assert.match(form.textContent,/32 HEX viết hoa/);
});
