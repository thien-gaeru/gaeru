(function(scope){
 function connectSSE({url='/api/realtime/stream',onMessage=()=>{},onError=()=>{},environment=scope}={}){
  if(typeof environment.EventSource!=='function')return null;
  try{
   const source=new environment.EventSource(url);
   source.addEventListener('chat_message',e=>{try{onMessage(JSON.parse(e.data));}catch(err){onError(err);}});
   source.addEventListener('order_update',e=>{try{onMessage(JSON.parse(e.data));}catch(err){onError(err);}});
   source.onerror=onError;
   return source;
  }catch{return null;}
 }
 function poll({run,active=()=>true,status=()=>{},delay=3000,background=()=>false,environment=scope,sseUrl}){
  let timer=null,busy=false,stopped=false,failures=0,eventSource=null;
  const doc=environment.document,online=()=>environment.navigator?.onLine!==false;
  function schedule(ms){environment.clearTimeout(timer);if(!stopped)timer=environment.setTimeout(tick,ms);}
  async function tick(){
   if(stopped||busy)return;
   if((doc.hidden&&!background())||!active()){schedule(delay);return;}
   if(!online()){status('Mất kết nối mạng. Sẽ tự kết nối lại.');schedule(delay);return;}
   busy=true;
   try{
    await run();
    failures=0;
    status(eventSource?'Thời gian thực (SSE) · Trực tiếp':'Tự cập nhật · mỗi 3 giây');
   }catch(error){
    failures++;
    status(error.status===401||error.status===403?'Phiên hoặc quyền truy cập đã thay đổi. Vui lòng đăng nhập lại.':'Chưa cập nhật được. Đang tự kết nối lại…');
    if(error.status===401||error.status===403)stopped=true;
   }finally{
    busy=false;
    if(!stopped)schedule(Math.min(30000,delay*2**Math.min(failures,4)));
   }
  }
  function wake(){if(!busy&&!stopped)schedule(0);}
  if(sseUrl&&typeof environment.EventSource==='function'){
   eventSource=connectSSE({
    url:sseUrl,
    environment,
    onMessage:()=>{wake();},
    onError:()=>{status('Mất kết nối thời gian thực. Đang kết nối lại…');}
   });
  }
  doc.addEventListener('visibilitychange',wake);
  environment.addEventListener('online',wake);
  environment.addEventListener('offline',wake);
  schedule(delay);
  return{
   refresh:wake,
   stop(){
    stopped=true;
    environment.clearTimeout(timer);
    if(eventSource?.close)try{eventSource.close();}catch{}
    doc.removeEventListener('visibilitychange',wake);
    environment.removeEventListener('online',wake);
    environment.removeEventListener('offline',wake);
   }
  };
 }
 function merge(target,messages,render,{reset=false,before=false}={}){
  const nearBottom=target.scrollHeight-target.scrollTop-target.clientHeight<60,oldHeight=target.scrollHeight,oldTop=target.scrollTop;
  if(reset)target.innerHTML='';
  const ids=new Set([...target.querySelectorAll('[data-message-id]')].map(n=>n.dataset.messageId));
  const fresh=messages.filter(m=>!ids.has(String(m.id)));
  const html=fresh.map(render).join('');
  if(html){if(!target.querySelector('[data-message-id]'))target.innerHTML='';target.insertAdjacentHTML(before?'afterbegin':'beforeend',html);}
  if(before)target.scrollTop=oldTop+target.scrollHeight-oldHeight;else if(reset||nearBottom)target.scrollTop=target.scrollHeight;
  const last=target.querySelectorAll('[data-message-id]');
  target.dataset.lastMessage=last.length?last[last.length-1].dataset.messageId:'';
  return fresh.length;
 }
 const api={poll,merge,connectSSE};
 if(typeof module==='object'&&module.exports)module.exports=api;
 else scope.GAERUCareLive=api;
})(typeof window==='object'?window:globalThis);
