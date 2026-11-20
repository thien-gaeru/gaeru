const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let now = 0, next = 0;
  const timers = new Map();
  class Clock extends Date { static now() { return now; } }
  const context = {module:{exports:{}}, Date:Clock, URLSearchParams, AbortController,
    setTimeout(fn,delay) { timers.set(++next,{fn,at:now+delay}); return next; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(readFileSync(require.resolve('../checkout-flow.js'),'utf8'),context);
  const doc = Object.assign(new EventTarget(),{defaultView:new EventTarget(),hidden:false});
  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const timer = [...timers.entries()].filter(([,t]) => t.at <= end).sort((a,b)=>a[1].at-b[1].at)[0];
      if (!timer) break;
      now = timer[1].at; timers.delete(timer[0]); timer[1].fn(); await settle();
    }
    now = end;
    await settle();
  }
  return {flow:context.module.exports,doc,advance,timers};
}

test('checkout sends no contacts before opt-in and queues withdrawal behind an in-flight save', async () => {
  const {flow,advance} = fixture();
  const input = value => Object.assign(new EventTarget(),{value});
  const elements = {email:input('buyer@example.test'), name:input('QA'), phone:input('0900000000'), recoveryConsent:input('')};
  const status = {}, retry = new EventTarget(), captureId='10000000-0000-4000-8000-000000000001';
  const calls = [];
  let accept;
  const form = {elements,isConnected:true,querySelector:selector=>selector.includes('retry')?retry:status};
  flow.bindRecoveryConsent(form,[],(path,options)=>{
    calls.push([path,JSON.parse(options.body)]);
    if (path.endsWith('/capture')) return new Promise(resolve=>{accept=resolve;});
  });
  elements.email.dispatchEvent(new Event('input'));
  await advance(1000);
  assert.equal(calls.length,0);
  elements.recoveryConsent.checked=true;
  elements.recoveryConsent.dispatchEvent(new Event('change'));
  await advance(600);
  elements.recoveryConsent.checked=false;
  elements.recoveryConsent.dispatchEvent(new Event('change'));
  assert.equal(calls.length,1);
  accept({cartId:captureId});
  await settle();
  assert.equal(calls[0][1].consentVersion,2);
  assert.deepEqual(calls[1],['/api/abandoned-cart/withdraw',{cartIds:[captureId]}]);
  assert.match(status.textContent,/ngừng nhắc/);
});

test('bank transfer checks run one at a time, report a timeout and stop after a matching paid order', async()=>{
  const {flow,doc,advance,timers} = fixture();
  const node={ownerDocument:doc,isConnected:true}, pending=[], paid=[];
  flow.watchBankTransfer(node,'QA-0001','fixture',(_url,opts)=>new Promise((resolve,reject)=>{
    pending.push(resolve);opts.signal.addEventListener('abort',()=>reject(Error('timed out')));
  }),order=>paid.push(order.orderNumber));
  doc.dispatchEvent(new Event('visibilitychange'));
  await advance(7999);
  assert.equal(pending.length,1);
  await advance(1);
  assert.match(node.textContent,/Chưa liên hệ/);
  await advance(8000);
  pending[1]({order:{orderNumber:'QA-0001',paymentStatus:'paid',status:'pending'}});
  await settle();
  assert.deepEqual(paid,['QA-0001']);
  assert.match(node.textContent,/đã ghi nhận thanh toán/);
  assert.equal(timers.size,0);
});

test('hidden time counts towards the 30 minute transfer deadline without sending another request',async()=>{
  const {flow,doc,advance,timers}=fixture(),node={ownerDocument:doc,isConnected:true};
  doc.hidden=true;
  flow.watchBankTransfer(node,'QA-0002','',()=>assert.fail('unexpected request'),()=>assert.fail('unexpected settlement'));
  await advance(30*60*1000);
  assert.match(node.textContent,/30 phút/);
  assert.equal(timers.size,0);
});
