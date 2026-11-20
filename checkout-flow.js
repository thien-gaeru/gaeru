(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GAERUCheckout=api;})(typeof window==='object'?window:globalThis,function(){
 const cityKey=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/đ/g,'d').replace(/^(tinh|thanh pho|tp\.?)\s+/,'').trim();
 function shippingFee(rates,city){if(!String(city||'').trim()||!rates||typeof rates!=='object')return undefined;const key=Object.keys(rates).find(k=>cityKey(k)===cityKey(city));if(key!==undefined){const fee=rates[key];return Number.isSafeInteger(fee)&&fee>=0?fee:undefined;}const nationwideKey=Object.keys(rates).find(k=>cityKey(k)==='toan quoc');const fee=nationwideKey!==undefined?rates[nationwideKey]:rates['Toàn quốc'];return Number.isSafeInteger(fee)&&fee>=0?fee:undefined;}
 function selection(products,search){const params=new URLSearchParams(search);if(!params.has('variant'))return {direct:false,items:[]};const id=params.get('variant');for(const product of products){const variant=product.variants.find(v=>v.id===id&&v.active&&v.stockQuantity>0);if(variant&&product.active!==false)return {direct:true,items:[{variantId:id,quantity:1}]};}return {direct:true,items:[]};}
 async function hydrateContact({root,form,request,updateTotal}){const fields=['name','email','phone','address','city'],dirty=new Set(),details=form.querySelector('[data-contact-details]'),summary=form.querySelector('[data-contact-summary]'),select=form.querySelector('[data-saved-address]'),label=form.querySelector('[data-saved-address-label]'),status=form.querySelector('[data-address-status]');let customer=null,addresses=[],accountChanged=false;
 const refresh=()=>{let addressText=form.elements.address.value;try{addressText=form.ownerDocument.defaultView.GAERUAddress?.getAddress(form,{validate:false})||addressText;}catch{}summary.textContent=[form.elements.name.value,form.elements.phone.value,addressText,form.elements.city.value].filter(Boolean).join(' · ');updateTotal();};
 form.addEventListener('input',e=>{if(fields.includes(e.target.name))dirty.add(e.target.name);refresh();});form.addEventListener('invalid',()=>{details.open=true;},true);
 function fill(data,overwrite){for(const [name,value]of Object.entries(data))if(value&&form.elements[name]&&(overwrite||!dirty.has(name)&&!form.elements[name].value)){const el=form.elements[name];const address=form.ownerDocument.defaultView.GAERUAddress;if(name==='city'&&address)address.setValue(el,value);else el.value=value;el.setCustomValidity?.('');el.removeAttribute?.('aria-invalid');el.classList?.remove?.('field-invalid');el.parentElement?.querySelector?.('.field-error-msg')?.remove?.();}}
 function apply(address,automatic=false){if(automatic&&dirty.size)return;fill({name:address.fullName,phone:address.phone,address:address.address,city:address.city,email:customer?.email},!automatic);if(automatic)fill({name:address.fullName,phone:address.phone,address:address.address,city:address.city},true);form.ownerDocument.defaultView.GAERUAddress?.setAddress(form,{address:address.address,city:address.city});refresh();details.open=!fields.every(name=>String(form.elements[name].value||'').trim())||shippingFee(root.shippingRates,form.elements.city.value)===undefined;}
 form.ownerDocument.addEventListener('gaeru:customer-updated',()=>{const session=form.ownerDocument.defaultView.GAERUCustomerSession;if(!customer||!session||session.customer?.id===customer.id)return;accountChanged=true;addresses=[];label.hidden=true;select.value='';for(const name of fields)if(!dirty.has(name))form.elements[name].value='';details.open=true;status.textContent='Tài khoản đã thay đổi. Tải lại trang để chọn địa chỉ của tài khoản hiện tại.';refresh();});
 select.addEventListener('change',()=>{const address=addresses.find(a=>a.id===select.value);if(address)apply(address);else{form.elements.address.value='';form.elements.city.value='';form.ownerDocument.defaultView.GAERUAddress?.setAddress(form,{address:'',city:''});details.open=true;refresh();}});
 try{const account=form.ownerDocument.defaultView.GAERUCustomerSession;let session;if(account){await account.refresh();session={authenticated:Boolean(account.customer),customer:account.customer};}else session=await request('/api/customer-auth/me');if(!session.authenticated)return;customer=session.customer;fill({name:customer.fullName,email:customer.email,phone:customer.phone},false);refresh();const result=await request('/api/customer/addresses');if(accountChanged||account&&account.customer?.id!==customer.id)return;addresses=result.addresses||[];if(!addresses.length)return;for(const address of addresses){const option=form.ownerDocument.createElement('option');option.value=address.id;option.textContent=(address.isDefault?'Mặc định · ':'')+address.label+' · '+address.address+', '+address.city;select.append(option);}label.hidden=false;const address=addresses.find(a=>a.isDefault)||addresses[0];if(!dirty.size){select.value=address.id;apply(address,true);}status.textContent='Chọn địa chỉ đã lưu hoặc nhập địa chỉ mới.';}catch{status.textContent='Bạn có thể nhập thông tin giao hàng trực tiếp bên dưới.';details.open=true;}
 }
 function bindRecoveryConsent(form, items, request) {
   const checkbox = form.elements.recoveryConsent;
   const status = form.querySelector('[data-recovery-status]');
   const retry = form.querySelector('[data-recovery-retry]');
   const ids = new Set();
   let timer, serial = Promise.resolve(), captureAttempted = false, uncertain = false;
   const enqueue = action => { serial = serial.then(action).catch(() => {
     status.textContent = checkbox.checked ? 'Chưa lưu được yêu cầu nhắc giỏ.' : 'Chưa xác nhận được việc ngừng nhắc giỏ.';
     retry.hidden = false;
   }); };

   function captureSoon() {
     clearTimeout(timer);
     if (!checkbox.checked) return;
     timer = setTimeout(() => enqueue(async () => {
       if (!checkbox.checked || !form.isConnected) return;
       const email = form.elements.email.value.trim();
       if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
       captureAttempted = true;
       let result;
       try {
         result = await request('/api/abandoned-cart/capture', {method:'POST', body:JSON.stringify({
           email, customerName:form.elements.name.value.trim(), phone:form.elements.phone.value.trim(), items,
           recoveryConsent:true, consentVersion:2
         })});
       } catch (error) { uncertain = true; throw error; }
       if (result?.cartId) ids.add(result.cartId);
       if (checkbox.checked) status.textContent = result?.cartId ? 'Đã lưu yêu cầu nhắc giỏ.' : 'Chưa bật nhắc giỏ cho địa chỉ này.';
     }), 600);
   }
   function change() {
     clearTimeout(timer);
     retry.hidden = true;
     status.textContent = '';
     if (checkbox.checked) return captureSoon();
     // Queue withdrawal behind any capture already in flight, even if its response was lost.
     enqueue(async () => {
       if (!captureAttempted) return;
       await request('/api/abandoned-cart/withdraw', {method:'POST', keepalive:true,
         body:JSON.stringify(uncertain ? {} : {cartIds:[...ids]})});
       ids.clear();
       captureAttempted = false;
       uncertain = false;
       if (!checkbox.checked) status.textContent = 'Đã ngừng nhắc và gỡ thông tin đã lưu cho giỏ này.';
     });
   }
   for (const name of ['email','phone','name']) form.elements[name].addEventListener('input',captureSoon);
   checkbox.addEventListener('change',change);
   retry.addEventListener('click',change);
 }
 function watchBankTransfer(node, orderNumber, token, request, onPaid) {
   const doc = node.ownerDocument, win = doc.defaultView;
   const params = new URLSearchParams({order:orderNumber});
   if (token) params.set('token',token);
   const deadline = Date.now() + 30 * 60 * 1000;
   let timer, controller, errors = 0, paused = false, finished = false;

   function finish(message) {
     finished = true;
     node.textContent = message;
     clearTimeout(timer);
     doc.removeEventListener('visibilitychange',resume);
     win.removeEventListener('pagehide',pause);
     win.removeEventListener('pageshow',resume);
   }
   function pause() {
     paused = true;
     clearTimeout(timer);
     controller?.abort();
   }
   function resume() {
     paused = false;
     clearTimeout(timer);
     if (!controller && !finished) void check();
   }
   async function check() {
     if (finished || paused || controller) return;
     const remaining = deadline - Date.now();
     if (remaining <= 0) return finish('Đã dừng tự động kiểm tra sau 30 phút. Bạn có thể tra cứu đơn để xem cập nhật mới nhất.');
     if (!node.isConnected) return finish('');
     if (doc.hidden) { timer = setTimeout(check,remaining); return; }
     const active = new AbortController();
     controller = active;
     const timeout = setTimeout(() => active.abort(),Math.min(8000,remaining));
     try {
       const data = await request('/api/payments/order-status?' + params, {signal:active.signal,cache:'no-store',gaeruBackground:true});
       if (paused || active.signal.aborted) return;
       const order = data?.order;
       if (!order || order.orderNumber !== orderNumber) throw Error('Unexpected order');
       if (order.paymentStatus === 'paid') {
         finish(order.status === 'cancelled' ? 'Đã ghi nhận thanh toán cho đơn đã hủy. Liên hệ GAERU để đối chiếu.' : 'GAERU đã ghi nhận thanh toán cho đơn hàng này.');
         onPaid(order);
         return;
       }
       if (order.status === 'cancelled' || ['failed','cancelled','expired'].includes(order.paymentStatus)) {
         return finish('Đơn hàng đã hủy hoặc giao dịch chưa hoàn tất. Liên hệ GAERU nếu đã chuyển tiền.');
       }
       errors = 0;
       node.textContent = 'Chưa ghi nhận thanh toán. Cập nhật lúc ' + new Date().toLocaleTimeString('vi-VN') + '.';
     } catch {
       if (!paused && !finished) {
         errors++;
         node.textContent = 'Chưa liên hệ được máy chủ để đối soát. Hệ thống sẽ kiểm tra lại.';
       }
     } finally {
       clearTimeout(timeout);
       controller = null;
       if (!finished && !paused) timer = setTimeout(check,Math.min(4000 * 2 ** Math.min(errors,3),Math.max(0,deadline-Date.now())));
     }
   }
   win.addEventListener('pagehide',pause);
   win.addEventListener('pageshow',resume);
   doc.addEventListener('visibilitychange',resume);
   void check();
 }
 return {cityKey,shippingFee,selection,hydrateContact,bindRecoveryConsent,watchBankTransfer};
});
