const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(send) {
  let click, tick, now = 1000;
  const classes = () => ({ toggle() {}, remove() {} });
  const button = { textContent:'Gửi email xác minh', disabled:false, setAttribute(){}, removeAttribute(){}, addEventListener(_,fn){click=fn;} };
  const feedback = {textContent:'',classList:classes()};
  const source = fs.readFileSync(path.join(__dirname,'../account.js'),'utf8').split('let verificationSending = false;')[1].split('\ninitializeCustomerAccount();')[0];
  const context={document:{querySelector:selector=>selector.includes('feedback')?feedback:button},currentCustomer:{id:'customer'},Date:{now:()=>now},setAccountFeedback(){},accountRequest:send,showCustomerProfile(){},setInterval(fn){tick=fn;return 1;},clearInterval(){}};
  vm.runInNewContext('let verificationSending = false;'+source,context);
  return {button,feedback,click:()=>click({currentTarget:button}),advance(ms){now+=ms;tick?.();}};
}

test('verification button shows sending immediately, prevents repeat calls and allows resend after 90 seconds',async()=>{
  let resolve, calls=0;
  const ui=setup(()=>{calls++;return new Promise(r=>resolve=r);});
  const sending=ui.click();
  assert.equal(ui.button.textContent,'Đang gửi…');assert.equal(ui.button.disabled,true);
  await ui.click();assert.equal(calls,1);
  resolve({message:'Đã gửi liên kết xác minh.'});await sending;
  assert.equal(ui.button.textContent,'Đã gửi xác minh');assert.match(ui.feedback.textContent,/90 giây/);
  ui.advance(89_000);assert.equal(ui.button.disabled,true);assert.match(ui.feedback.textContent,/1 giây/);
  await ui.click();assert.equal(calls,1);
  ui.advance(1000);assert.equal(ui.button.disabled,false);assert.equal(ui.button.textContent,'Gửi lại xác minh');
  const resent=ui.click();assert.equal(calls,2);resolve({message:'Đã gửi lại.'});await resent;
  assert.match(ui.feedback.textContent,/90 giây/);
});

test('failed SMTP request remains retryable and never displays sent confirmation',async()=>{
  const ui=setup(async()=>{throw Error('Dịch vụ email từ chối xác thực.');});
  await ui.click();assert.equal(ui.button.disabled,false);assert.equal(ui.button.textContent,'Gửi email xác minh');
  assert.match(ui.feedback.textContent,/từ chối xác thực/);assert.doesNotMatch(ui.feedback.textContent,/90 giây/);
});
