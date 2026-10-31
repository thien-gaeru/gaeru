(function(root,factory){
  if(typeof module==='object'&&module.exports){module.exports=factory;return;}
  const key='gaeru-customer-session-change';let channel=null;
  try{if(typeof BroadcastChannel!=='undefined')channel=new BroadcastChannel(key);}catch{}
  const session=factory({fetch:root.fetch.bind(root),notify:()=>document.dispatchEvent(new CustomEvent('gaeru:customer-updated')),broadcast:()=>{if(channel)channel.postMessage('changed');else try{localStorage.setItem(key,Date.now()+':'+Math.random());}catch{}}});
  root.GAERUCustomerSession=session;
  if(channel)channel.onmessage=()=>session.refresh();
  root.addEventListener('storage',event=>{if(event.key===key)session.refresh();});
  root.addEventListener('focus',()=>session.refresh());
  root.addEventListener('pageshow',()=>session.refresh());
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')session.refresh();});
  document.addEventListener('gaeru:cart-panel-open',()=>session.refresh());
  if(root.location.protocol!=='file:')session.refresh();
})(typeof window==='undefined'?null:window,function createCustomerSession({fetch,notify=()=>{},broadcast=()=>{}}){
  let customer=null,revision=0,requestId=0;
  function set(value,{announce=true}={}){revision++;const next=value?{id:value.id,fullName:String(value.fullName||''),email:String(value.email||''),phone:String(value.phone||''),emailVerified:Boolean(value.emailVerified)}:null;const changed=JSON.stringify(next)!==JSON.stringify(customer);customer=next;if(changed)notify();if(announce)broadcast();}
  async function refresh(){const start=revision,id=++requestId;try{const response=await fetch('/api/customer-auth/me',{credentials:'same-origin',cache:'no-store'});if(response.status===401||response.status===403){if(start===revision&&id===requestId)set(null,{announce:false});return;}if(!response.ok)return;const data=await response.json();if(start!==revision||id!==requestId)return;set(data.authenticated?data.customer:null,{announce:false});}catch{}}
  return Object.freeze({get customer(){return customer?{...customer}:null;},set,refresh});
});
