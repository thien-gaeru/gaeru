const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const configIds = { cod:'payment_cod',bank_transfer:'payment_bank_transfer',vnpay:'vnpay','9pay':'payment_9pay',momo:'payment_momo',zalopay:'payment_zalopay' };
async function fixture({ result={verified:false,reachable:true,method:'gateway_reachability',message:'Liên lạc được máy chủ; chưa xác minh tài khoản.'},error }={}) {
  const {document}=parseHTML('<html><body><section id="payment-configuration"></section><section id="shipping-configuration"></section></body></html>');
  const listeners={},requests=[];
  document.addEventListener=(type,handler)=>(listeners[type]||=[]).push(handler);
  const records=Object.fromEntries(Object.values(configIds).map(id=>[id,{version:1,data:{enabled:true,secretConfigured:true}}]));
  records.payment_bank_transfer.data={enabled:true,bankName:'Fixture Bank',accountNumber:'0123456789',accountHolder:'Fixture Owner'};
  const channels=[
    {id:'cod',configured:true,enabled:true,verified:false,method:'configuration_validation',canEnable:true,supported:true,checkoutReady:true},
    {id:'bank_transfer',configured:true,enabled:true,verified:true,method:'account_verification',canEnable:true,supported:true,checkoutReady:true},
    {id:'vnpay',configured:true,enabled:true,verified:true,method:'gateway_handshake',reachable:true,canEnable:true,supported:true,checkoutReady:true},
    {id:'9pay',configured:true,enabled:false,verified:true,method:'gateway_handshake',canEnable:false,supported:false,checkoutReady:false,unsupportedReason:'Chưa hỗ trợ nhận thanh toán 9Pay.'},
    {id:'momo',configured:true,enabled:true,verified:true,method:'provider_order_create',verificationScope:'api_credentials',callbackVerified:false,canEnable:true,supported:true,checkoutReady:true},
    {id:'zalopay',configured:true,enabled:true,verified:true,method:'signed_callback',verificationScope:'callback_signature',callbackVerified:true,canEnable:true,supported:true,checkoutReady:true}
  ];
  const admin={user:{role:'owner',source:'bootstrap'},showGlobal(){},async request(path,options={}) {
    if(!options.method){
      if(path.endsWith('/configuration'))return {records,callbacks:{},services:{}};
      if(path.endsWith('/shipping'))return {carriers:[{id:'ghn',configured:false,verified:false,enabled:false,supported:true}]};
      return {channels};
    }
    requests.push({path,body:JSON.parse(options.body)});
    if(error)throw error;
    return result;
  }};
  const context={window:{GAERUAdmin:admin},document,setTimeout:fn=>fn()};
  vm.runInNewContext(fs.readFileSync(require.resolve('../admin/configuration.js'),'utf8'),context);
  await context.window.GAERUConfiguration.mountPayments();
  const modal=document.createElement('div');
  modal.className='config-modal-dialog';
  modal.innerHTML='<form data-version="1"><input name="password" value="fresh-password"><input name="factorCode" value="123456"><button type="button" data-payment-test="vnpay">Kiểm tra</button></form><p class="config-modal-status" data-modal-status></p>';
  document.body.append(modal);
  const form=modal.querySelector('form');
  const elements=Object.fromEntries([...form.querySelectorAll('input')].map(input=>[input.name,input]));
  Object.defineProperty(form,'elements',{value:elements});
  return {document,requests,channels,elements,status:modal.querySelector('[data-modal-status]'),mountShipping:()=>context.window.GAERUConfiguration.mountShipping(),async probe(){
    for(const handler of listeners.click)await handler({target:modal.querySelector('button')});
  }};
}

test('payment cards distinguish configuration, reachability, authenticated proof and unsupported channels',async()=>{
  const f=await fixture();
  const card=id=>f.document.getElementById('config-panel-'+configIds[id]);
  assert.match(card('cod').textContent,/Đã kiểm tra cấu hình/);
  assert.doesNotMatch(card('bank_transfer').textContent,/Đã xác minh tài khoản/);
  assert.match(card('bank_transfer').textContent,/đối chiếu thủ công/i);
  assert.match(card('vnpay').textContent,/Liên lạc được.*Chưa xác minh/);
  assert.doesNotMatch(card('vnpay').textContent,/Đã xác minh tài khoản/);
  assert.equal(card('9pay').querySelector('[data-payment-enable]').disabled,true);
  assert.equal(card('9pay').querySelector('input[name=enabled]').disabled,true);
  assert.equal(card('9pay').querySelector('input[name=enabled]').hasAttribute('checked'),false);
  assert.match(card('9pay').textContent,/Chưa hỗ trợ nhận thanh toán 9Pay/);
  assert.match(card('momo').textContent,/Đã xác thực API.*Chưa kiểm tra phản hồi/);
  assert.match(card('zalopay').textContent,/Đã xác thực phản hồi thanh toán/);
  assert.match(f.document.querySelector('.payment-hub-stats').textContent,/Đã có bằng chứng xác thực:\s*2/);
  assert.doesNotMatch(f.document.querySelector('#config-panel-payment-reconcile').textContent,/Webhook.*Chuyển khoản ngân hàng/);
});

test('reachability and configuration checks never show authenticated-success feedback',async()=>{
  for(const result of [
    {verified:false,reachable:true,method:'gateway_reachability',message:'Liên lạc được máy chủ; chưa xác minh tài khoản.'},
    {verified:false,configured:true,method:'configuration_validation',message:'Thông tin chuyển khoản đúng định dạng; cần đối chiếu tài khoản.'}
  ]){
    const f=await fixture({result});await f.probe();
    assert.equal(f.requests.length,1);
    assert.doesNotMatch(f.status.textContent,/^[✓✅]/);
    assert.equal(f.status.classList.contains('is-success'),false);
    assert.equal(f.status.classList.contains('is-notice'),true);
    assert.equal(f.elements.password.value,'');
    assert.equal(f.elements.factorCode.value,'');
  }
});

test('only authenticated provider proof gets success feedback and failures remain errors',async()=>{
  const f=await fixture({result:{verified:true,reachable:true,method:'authenticated_api',verificationScope:'api_credentials',callbackVerified:false,message:'Đã xác thực API; chưa kiểm tra phản hồi thanh toán.'}});
  await f.probe();
  assert.equal(f.status.classList.contains('is-success'),true);
  assert.match(f.status.textContent,/^✓/);
  const failed=await fixture({error:Object.assign(Error('Máy chủ trả HTTP 404.'),{status:502})});
  await failed.probe();
  assert.equal(failed.status.classList.contains('is-error'),true);
  assert.doesNotMatch(failed.status.textContent,/^[✓✅]/);
});

test('old handshake success flags cannot display authenticated-success feedback',async()=>{
  const f=await fixture({result:{verified:true,reachable:true,method:'gateway_handshake',message:'Chỉ kiểm tra địa chỉ máy chủ.'}});
  await f.probe();
  assert.equal(f.status.classList.contains('is-success'),false);
  assert.doesNotMatch(f.status.textContent,/^[✓✅]/);
});

test('shipping workspace still renders independently of payment readiness',async()=>{
  const f=await fixture();
  await f.mountShipping();
  assert.ok(f.document.querySelector('#config-panel-shipping_ghn [data-shipping-enable]'));
});
