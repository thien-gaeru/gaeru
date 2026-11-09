(()=>{const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),storage='gaeru.saved.products.v1';
function saved(){try{const v=JSON.parse(localStorage.getItem(storage)||'[]');return Array.isArray(v)?v.filter(x=>x&&typeof x.slug==='string'&&/^[a-z0-9-]+$/.test(x.slug)).slice(0,100):[];}catch{return [];}}
window.GAERUSavedProducts={has:slug=>saved().some(x=>x.slug===slug)};
function update(){document.querySelectorAll('[data-save-product]').forEach(b=>{const active=window.GAERUSavedProducts.has(b.dataset.saveProduct);b.setAttribute('aria-pressed',String(active));const text=active?'Đã lưu · Bỏ lưu':'Lưu để xem lại sau';if(b.textContent!==text)b.textContent=text;});document.querySelectorAll('[data-saved-count]').forEach(a=>{const text='Đã lưu ('+saved().length+')';if(a.textContent!==text)a.textContent=text;});}

let activeCsrfToken = null;
let csrfFetchPromise = null;

function prefetchCsrfToken() {
  if (activeCsrfToken) return Promise.resolve(activeCsrfToken);
  if (csrfFetchPromise) return csrfFetchPromise;
  csrfFetchPromise = (async () => {
    for (let i = 0; i < 5; i++) {
      try {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimeout(() => controller?.abort(), 6000);
        const res = await fetch('/api/csrf', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller?.signal
        }).finally(() => clearTimeout(timer));
        if (res.ok) {
          const json = await res.json();
          if (json?.csrfToken) {
            activeCsrfToken = json.csrfToken;
            return activeCsrfToken;
          }
        }
      } catch (_) {}
      if (i < 4) await new Promise(r => setTimeout(r, 200 * (i + 1)));
    }
    return activeCsrfToken;
  })().finally(() => { csrfFetchPromise = null; });
  return csrfFetchPromise;
}

async function fetchCsrfWithRetry(attempts = 5) {
  if (activeCsrfToken) return activeCsrfToken;
  const prefetched = await prefetchCsrfToken();
  if (prefetched) return prefetched;
  for (let i = 0; i < attempts; i++) {
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => controller?.abort(), 6000);
      const res = await fetch('/api/csrf', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller?.signal
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const json = await res.json();
        if (json?.csrfToken) {
          activeCsrfToken = json.csrfToken;
          return activeCsrfToken;
        }
      }
    } catch (_) {}
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 300 * (i + 1)));
  }
  if (activeCsrfToken) return activeCsrfToken;
  throw Error('Chưa khởi tạo được phiên bảo mật.');
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const isWrite = options.method && options.method !== 'GET';
  if (isWrite) {
    const token = await fetchCsrfWithRetry();
    headers.set('X-CSRF-Token', token);
    if (!(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  }
  let r, d;
  try {
    r = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
    if (isWrite && r.status === 403) {
      activeCsrfToken = null;
      const freshToken = await fetchCsrfWithRetry();
      headers.set('X-CSRF-Token', freshToken);
      r = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
    }
    d = await r.json();
  } catch (netErr) {
    if (netErr.status) throw netErr;
    throw Object.assign(Error('Kết nối mạng gián đoạn. Vui lòng thử lại.'), { status: 0 });
  }
  if (!r.ok) throw Object.assign(Error(d?.error || 'Chưa kết nối được. Vui lòng thử lại.'), { status: r.status });
  return d;
}

let chat=null,chatOpenVersion=0,chatAssetsPromise=null,checkoutFlowPromise=null;
function loadStylesheetOnce(href){if(document.querySelector(`link[href^="${href.split('?')[0]}"]`))return;const l=document.createElement('link');l.rel='stylesheet';l.href=href;document.head.append(l);}
function loadScriptOnce(src,check){
  if(check&&check())return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const baseSrc=src.split('?')[0];
    let s=document.querySelector(`script[src^="${baseSrc}"]`);
    if(!s){
      s=document.createElement('script');
      s.src=src;
      s.async=false;
      document.head.append(s);
    }
    if(check&&check())return resolve();
    let checks=0;
    const timer=setInterval(()=>{
      checks++;
      if(check&&check()){
        clearInterval(timer);
        resolve();
      }else if(checks>80){
        clearInterval(timer);
        if(check&&!check()){
          reject(Error('Hệ thống tư vấn đang kết nối. Vui lòng bấm thử lại hoặc gọi 082 919 1080.'));
        }else{
          resolve();
        }
      }
    },50);
    s.addEventListener('load',()=>{if(check&&check()){clearInterval(timer);resolve();}},{once:true});
    s.addEventListener('error',()=>{clearInterval(timer);reject(Error('Chưa tải được thành phần trang.'));},{once:true});
  });
}
async function ensureChatAssets(){
  loadStylesheetOnce('/shopping-chat.css?v=20261109-v6');
  if(!window.GAERUCareLive){
    await loadScriptOnce('/care-live.js?v=20261024-chat',()=>Boolean(window.GAERUCareLive)).catch(()=>{});
  }
  if(typeof window.GAERUChatClient?.mount==='function')return true;
  await (chatAssetsPromise||=loadScriptOnce('/shopping-chat-client.js?v=20261109-v6',()=>typeof window.GAERUChatClient?.mount==='function').catch(e=>{chatAssetsPromise=null;throw e;}));
  for(let i=0;i<40;i++){
    if(typeof window.GAERUChatClient?.mount==='function')return true;
    await new Promise(r=>setTimeout(r,50));
  }
  if(typeof window.GAERUChatClient?.mount!=='function')throw Error('Hệ thống tư vấn đang kết nối. Vui lòng bấm thử lại hoặc gọi 082 919 1080.');
  return true;
}
function ensureCheckoutFlow(){if(window.GAERUCheckout)return Promise.resolve();return checkoutFlowPromise||=loadScriptOnce('/checkout-flow.js?v=20261026-ward-picker',()=>Boolean(window.GAERUCheckout)).catch(()=>{checkoutFlowPromise=null;});}

async function openChat(slug){
  window.openChat=openChat;
  // Prefetch CSRF token immediately upon opening chat modal
  void prefetchCsrfToken();
  let dialog=document.querySelector('#shopping-chat-dialog');
  if(!dialog){
    dialog=document.createElement('dialog');dialog.id='shopping-chat-dialog';dialog.className='shopping-chat-dialog';
    dialog.innerHTML='<header><div class="chat-header-main"><div class="chat-header-title-row"><h2>Trợ giúp GAERU</h2><span class="chat-live-badge" data-chat-live-badge title="Thời gian thực (SSE 0ms)" aria-label="Trạng thái kết nối"><span class="chat-live-dot"></span><span data-chat-live-text hidden></span></span><a href="tel:0829191080" class="chat-hotline-session chat-hotline-header" data-chat-hotline data-no-action-feedback>☏ Gọi hotline</a></div></div><button type="button" data-chat-close aria-label="Đóng chat">×</button></header><div data-chat-content></div>';
    document.body.append(dialog);dialog.querySelector('[data-chat-close]').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{chatOpenVersion++;chat?.stop();chat=null;document.body.style.overflow=dialog.dataset.previousOverflow||'';});
  }
  const version=++chatOpenVersion;dialog.dataset.previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.showModal();
  const content=dialog.querySelector('[data-chat-content]');content.innerHTML='<p role="status">Đang mở hỗ trợ…</p>';
  const fit=()=>{if(!dialog.open)return;const viewport=window.visualViewport;dialog.style.setProperty('--chat-viewport-height',(viewport?.height||window.innerHeight)+'px');dialog.style.setProperty('--chat-viewport-top',(viewport?.offsetTop||0)+'px');const editing=dialog.contains(document.activeElement)&&document.activeElement.matches('textarea,input');dialog.classList.toggle('chat-keyboard-open',editing&&((viewport?.height||innerHeight)<window.innerHeight*.8||(viewport?.height||innerHeight)<500));};
  if(!dialog.dataset.viewportBound){dialog.dataset.viewportBound='true';window.visualViewport?.addEventListener('resize',fit);window.visualViewport?.addEventListener('scroll',fit);window.addEventListener('resize',fit);dialog.addEventListener('focusin',fit);dialog.addEventListener('focusout',()=>requestAnimationFrame(fit));}fit();
  try{
    const [,d]=await Promise.all([ensureChatAssets(),request('/api/shopping-chat/threads').catch(()=>({threads:[]}))]);
    if(!dialog.open||version!==chatOpenVersion)return;
    if(!window.GAERUChatClient||typeof window.GAERUChatClient.mount!=='function')throw Error('Hệ thống tư vấn đang kết nối. Vui lòng bấm thử lại hoặc gọi hotline 082 919 1080.');
    const threads=Array.isArray(d?.threads)?d.threads:[];
    const existing=threads.find(t=>t.product_slug===slug&&t.status==='open');
    chat?.stop?.();
    chat=window.GAERUChatClient?.mount ? window.GAERUChatClient.mount(content,{base:'/api/shopping-chat/threads',request,id:existing?.id||null,productSlug:slug}) : null;
    fit();
  }
  catch(e){
    if(dialog.open&&version===chatOpenVersion){
      content.innerHTML='<div style="padding:28px 16px;text-align:center;"><p role="status" style="font-size:15px;color:#6e6e73;margin-bottom:18px;">'+h(e.message||'Chưa thể kết nối tư vấn lúc này.')+'</p><button type="button" class="button button-blue" onclick="openChat('+(slug?`'${h(slug)}'`:'null')+')" style="display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:8px 22px;border-radius:999px;background:#0071e3;color:#fff;border:0;font-weight:600;font-size:14px;cursor:pointer;">Thử lại</button></div>';
    }
  }
}

document.addEventListener('click',async e=>{const save=e.target.closest('[data-save-product]'),chatButton=e.target.closest('[data-product-chat]');if(save){const feedback=save.parentElement.querySelector('[role=status]');try{const rows=saved(),slug=save.dataset.saveProduct,exists=rows.some(x=>x.slug===slug);if(!exists&&rows.length>=100)throw Error('Đã lưu tối đa 100 sản phẩm. Bỏ bớt sản phẩm trước khi lưu thêm.');localStorage.setItem(storage,JSON.stringify(exists?rows.filter(x=>x.slug!==slug):[...rows,{slug,variantId:document.querySelector('#product-variant')?.value||null}]));update();const msg=exists?'Đã bỏ lưu sản phẩm.':'Đã lưu sản phẩm trên trình duyệt này.';feedback.textContent=msg;if(window.GAERUNotify?.toast)window.GAERUNotify.toast(msg,exists?'info':'success');}catch(error){feedback.textContent=error.message;}}if(chatButton)try{await openChat(chatButton.dataset.productChat||null);}catch(error){if(window.GAERUNotify?.error)window.GAERUNotify.error(error.message);else window.alert(error.message);}});
document.addEventListener('toggle',async e=>{const details=e.target;if(!details.matches('[data-delivery-details]')||!details.open||details.dataset.loaded)return;const target=details.querySelector('[data-delivery-content]');try{const [,d]=await Promise.all([ensureCheckoutFlow(),request('/api/settings/public')]),rates=d.shippingRates||{};target.innerHTML=(d.shippingNote?'<p>'+h(d.shippingNote)+'</p>':'')+'<p>Phí giao hàng theo tỉnh/thành được chọn khi thanh toán. Thời gian giao dự kiến được GAERU xác nhận khi xử lý đơn.</p>'+ (Object.keys(rates).length?'<label>Tỉnh/thành phố<select data-delivery-city><option value="">Chọn tỉnh/thành</option>'+Object.keys(rates).map(city=>'<option value="'+h(city)+'">'+h(city)+'</option>').join('')+'</select></label><p data-delivery-fee role="status"></p>':'<p>Liên hệ GAERU để xác nhận khu vực giao hàng.</p>');target.querySelector('select')?.addEventListener('change',event=>{const fee=window.GAERUCheckout?.shippingFee(rates,event.target.value)??rates[event.target.value]??rates["Toàn quốc"];target.querySelector('[data-delivery-fee]').textContent=fee===undefined?'':fee===0?'Miễn phí vận chuyển cho khu vực đã chọn.':'Phí giao hàng: '+new Intl.NumberFormat('vi-VN').format(fee)+' ₫';});details.dataset.loaded='true';}catch(error){target.textContent=error.message;}},true);
new MutationObserver(update).observe(document.body,{subtree:true,childList:true});window.addEventListener('storage',update);update();
window.openChat=openChat;
// Automatically prefetch CSRF token in background on page load
void prefetchCsrfToken();
})();
