const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');

function page(fetch) {
  const nodes=new Map();
  function node(selector){if(!nodes.has(selector))nodes.set(selector,{hidden:true,textContent:'',dataset:{},classList:{toggle(){},remove(){}},setAttribute(){},removeAttribute(){},remove(){},listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},querySelector:node});return nodes.get(selector);}
  const login=node('login');login.dataset.accountPanel='login';
  node('[data-account-loading]').hidden=false;
  const context={document:{querySelector:node,querySelectorAll:()=>[login],addEventListener(){}},fetch,AbortController,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},URLSearchParams,window:{location:{search:'',hash:'',pathname:'/account.html'},GAERUCustomerSession:{set(){}}},history:{replaceState(){}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../account.js'),'utf8'),context);
  return {node,login};
}
const settled=()=>new Promise(resolve=>setImmediate(resolve));

test('existing session loads profile without ever exposing the login form',async()=>{
  let resolve;const ui=page(()=>new Promise(r=>resolve=r));
  assert.equal(ui.login.hidden,true);assert.equal(ui.node('[data-account-loading]').hidden,false);
  resolve({ok:true,json:async()=>({authenticated:true,customer:{id:'one',fullName:'Customer',email:'one@example.test',phone:'0900000000',emailVerified:true}})});
  await settled();assert.equal(ui.login.hidden,true);assert.equal(ui.node('[data-account-profile]').hidden,false);assert.equal(ui.node('[data-account-loading]').hidden,true);
});
test('anonymous session displays login only after the server confirms it',async()=>{
  let resolve;const ui=page(()=>new Promise(r=>resolve=r));assert.equal(ui.login.hidden,true);
  resolve({ok:true,json:async()=>({authenticated:false,customer:null})});await settled();
  assert.equal(ui.login.hidden,false);assert.equal(ui.node('[data-account-profile]').hidden,true);assert.equal(ui.node('[data-account-loading]').hidden,true);
});
test('session failure retains a retry state instead of falsely showing login',async()=>{
  let fail=true;const ui=page(async()=>{if(fail)throw Error('offline');return {ok:true,json:async()=>({authenticated:false})};});await settled();
  assert.equal(ui.login.hidden,true);assert.equal(ui.node('[data-account-retry]').hidden,false);assert.match(ui.node('[data-account-loading-message]').textContent,/kiểm tra kết nối/);
  fail=false;ui.node('[data-account-retry]').listeners.click();await settled();assert.equal(ui.login.hidden,false);
});
