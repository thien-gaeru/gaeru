const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {parseHTML}=require('linkedom');
const orderNumber='GR-20261028-TESTORDER1';
const response=order=>({ok:true,json:async()=>({order:{orderNumber,paymentMethod:'zalopay',paymentStatus:'paid',status:'processing',...order}})});
async function settle(){for(let i=0;i<10;i++)await Promise.resolve();}
async function fixture({query=`result=pending&provider=zalopay&order=${orderNumber}`,fetcher=()=>response()}={}){
  const {document,window:domWindow}=parseHTML('<html><body><section id="payment-result"></section></body></html>');
  let now=0,nextTimer=0;const timers=new Map(),listeners={},calls=[];
  const clock={
    async advance(ms){const until=now+ms;for(let steps=0;steps<1000;steps++){
      const next=[...timers.entries()].filter(([,timer])=>timer.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next){now=until;await settle();return;}
      now=next[1].at;timers.delete(next[0]);next[1].fn();await settle();
    }throw Error('Unbounded timer loop');},
    size:()=>timers.size
  };
  const window={addEventListener:(type,handler)=>(listeners[type]||=[]).push(handler)};
  vm.runInNewContext(fs.readFileSync(require.resolve('../payment-result.js'),'utf8'),{
    document,window,location:{search:'?'+query},URLSearchParams,AbortController,
    Date:{now:()=>now},setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async(url,options)=>{calls.push({url,options});return fetcher(calls.length,options);}
  });
  await settle();
  return {document,calls,clock,text:()=>document.querySelector('#payment-result').textContent,
    retry:async()=>{document.querySelector('[data-payment-status-retry]').dispatchEvent(new domWindow.Event('click'));await settle();},
    event:async(type,data={})=>{for(const listener of listeners[type]||[])listener(data);await settle();}
  };
}

test('pending browser return waits for authoritative callback state and polls until payment is recorded',async()=>{
  const f=await fixture({fetcher:n=>response({paymentStatus:n===1?'unpaid':'paid'})});
  assert.equal(f.calls.length,1);
  assert.doesNotMatch(f.text(),/Không thể xác minh|Đã thanh toán thành công/);
  assert.equal(f.calls[0].options.credentials,'same-origin');
  assert.equal(f.calls[0].options.cache,'no-store');
  await f.clock.advance(2500);
  assert.equal(f.calls.length,2);
  assert.match(f.text(),/Đã thanh toán thành công qua ZaloPay/);
  assert.match(f.text(),/đang chờ gửi hàng/i);
  assert.equal(f.clock.size(),0);
});

test('paid page copy follows actual order lifecycle and never approves a cancelled paid order',async()=>{
  for(const [status,expected]of [['pending',/chờ xử lý/i],['processing',/chờ gửi hàng/i],['shipped',/đang được giao/i],['completed',/đã hoàn tất/i],['cancelled',/đã hủy/i]]){
    const f=await fixture({query:`result=processing&provider=vnpay&order=${orderNumber}`,fetcher:()=>response({paymentMethod:'momo',status})});
    assert.match(f.text(),expected,status);
    if(status==='cancelled'){
      assert.match(f.text(),/đối chiếu|hoàn tiền/i);
      assert.doesNotMatch(f.text(),/được duyệt|chờ gửi hàng/i);
    }else assert.match(f.text(),/qua MoMo/);
    assert.equal(f.clock.size(),0);
  }
});

test('browser query cannot claim payment and mismatched server order is never displayed as paid',async()=>{
  const forged=await fixture({query:`result=paid&provider=momo&order=${orderNumber}`});
  assert.equal(forged.calls.length,0);
  assert.doesNotMatch(forged.text(),/Đã thanh toán thành công/);
  const wrong=await fixture({fetcher:()=>response({orderNumber:'GR-20261028-DIFFERENT'})});
  await wrong.clock.advance(30000);
  assert.doesNotMatch(wrong.text(),/Đã thanh toán thành công|DIFFERENT/);
  assert.ok(wrong.calls.length<=6);
});

test('network failures stop automatically within 30 seconds and explicit retry starts a fresh bounded check',async()=>{
  let fail=true;
  const f=await fixture({fetcher:()=>{if(fail)throw Error('offline');return response();}});
  await f.clock.advance(30000);
  assert.ok(f.calls.length>1&&f.calls.length<=6);
  const count=f.calls.length;
  assert.match(f.text(),/chưa.*xác nhận|chưa.*kiểm tra/i);
  assert.equal(f.clock.size(),0);
  assert.equal(f.document.querySelector('[data-payment-status-retry]').hidden,false);
  await f.clock.advance(60000);
  assert.equal(f.calls.length,count);
  fail=false;await f.retry();
  assert.equal(f.calls.length,count+1);
  assert.match(f.text(),/Đã thanh toán thành công/);
  assert.equal(f.clock.size(),0);
});

test('pagehide aborts pending work, clears timers and prevents late payment responses from changing the page',async()=>{
  let resolve;
  const f=await fixture({fetcher:()=>new Promise(done=>{resolve=done;})});
  assert.equal(f.calls.length,1);
  const before=f.text();
  await f.event('pagehide');
  assert.equal(f.calls[0].options.signal.aborted,true);
  assert.equal(f.clock.size(),0);
  resolve(response());await settle();
  assert.equal(f.text(),before);
  await f.clock.advance(60000);
  assert.equal(f.calls.length,1);
});

test('a stalled request is aborted and the overall check cannot outlive its 30 second budget',async()=>{
  const f=await fixture({fetcher:(_n,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))))});
  await f.clock.advance(30000);
  assert.ok(f.calls.length>1&&f.calls.length<=6);
  assert.equal(f.calls.at(-1).options.signal.aborted,true);
  assert.equal(f.clock.size(),0);
  assert.match(f.text(),/Chưa có xác nhận/);
  const count=f.calls.length;
  await f.clock.advance(60000);
  assert.equal(f.calls.length,count);
});

test('a response from before page restoration cannot cancel a newer request timeout',async()=>{
  let oldResolve;
  const f=await fixture({fetcher:(n,options)=>n===1?new Promise(resolve=>{oldResolve=resolve;}):new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted'))))});
  await f.event('pagehide');
  await f.event('pageshow',{persisted:true});
  assert.equal(f.calls.length,2);
  oldResolve(response());await settle();
  await f.clock.advance(4500);
  assert.equal(f.calls[1].options.signal.aborted,true);
  assert.doesNotMatch(f.text(),/Đã thanh toán thành công/);
  await f.event('pagehide');
  assert.equal(f.clock.size(),0);
});
