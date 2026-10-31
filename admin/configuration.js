// admin/configuration.js
// Lõi cấu hình của chủ doanh nghiệp: dựng form, popup cấu hình, lưu cấu hình có xác thực lại.
// Nội dung theo miền được tách sang:
//   - configuration-channels.js : thanh toán, vận chuyển, đăng nhập Google
//   - configuration-ai-ops.js   : hồ sơ, vận hành, Chat AI, MISA, sàn TMĐT, bảo mật phiên
(()=>{
const admin=window.GAERUAdmin;
const esc=window.GAERUAdminShared.escapeHtml;
const Channels=window.GAERUConfigurationChannels;
const AiOps=window.GAERUConfigurationAiOps;

let data=null;
let configModalTrigger=null;
let configModalPreviousOverflow='';

const titles={...Channels.titles,...AiOps.titles};
const fields={...Channels.fields,...AiOps.fields};
const fieldPlaceholders={...Channels.fieldPlaceholders,...AiOps.fieldPlaceholders};
const configModalMeta={...Channels.configModalMeta,...AiOps.configModalMeta};
const paymentIds=Channels.paymentIds;

const DEFAULT_MODAL_ICON='<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><circle cx="12" cy="12" r="3"></circle></svg>';
const SECRET_PLACEHOLDER_SAVED='Đã lưu · để trống để giữ khóa';

function owner(){return Boolean(admin.user?.role==='owner'||admin.user?.role==='admin'||admin.user?.source==='bootstrap');}
async function read(){data=await admin.request('/api/gaeru_ceo/owner/configuration');return data;}

function formDefaults(id,v){
 if(id==='security')return {idleMinutes:30,absoluteHours:8,...v};
 if(id==='payment_cod')return {maxAmountVnd:50000000,instructions:'Thanh toán tiền mặt trực tiếp cho bưu tá khi nhận hàng.',enabled:true,...v};
 if(id==='payment_bank_transfer')return {transferSyntax:'GAERU {MA_DON}',enabled:false,...v};
 if(id==='misa')return {templateCode:'1/001',series:'C26TGA',environment:'sandbox',autoIssue:true,enabled:false,...v};
 return v;
}

function testButtonHtml(id){
 if(id==='chat_ai')return '<button type="button" class="secondary-button" data-chat-ai-test>Kiểm tra chat AI đã lưu</button>';
 if(id==='misa')return '<button type="button" class="secondary-button" data-misa-test>Kiểm tra kết nối MISA eShop</button>';
 if(id.startsWith('shipping_'))return '<button type="button" class="secondary-button" data-shipping-test="'+id.slice(9)+'">Kiểm tra kết nối đã lưu</button>';
 if(paymentIds.has(id)&&id!=='payments')return '<button type="button" class="secondary-button" data-payment-test="'+(id==='vnpay'?'vnpay':id.slice(8))+'">Kiểm tra kết nối đã lưu</button>';
 return '';
}

function fieldInputHtml(id,v,values,[name,label,type]){
 const isSecret=type==='password';
 const valueAttrs=isSecret
  ?'autocomplete="new-password" placeholder="'+(v.secretConfigured?SECRET_PLACEHOLDER_SAVED:'Nhập khóa bí mật')+'"'
  :'value="'+esc(values[name])+'"'+(fieldPlaceholders[id]?.[name]?' placeholder="'+esc(fieldPlaceholders[id][name])+'"':'');
 const rangeAttrs=id==='security'
  ?(name==='idleMinutes'?' min="5" max="60"':' min="1" max="8"')
  :id==='payment_cod'&&name==='maxAmountVnd'?' min="100000" max="2000000000"':'';
 return '<label>'+label+'<input name="'+name+'" type="'+(type||'text')+'" maxlength="'+(isSecret?2000:500)+'" '+valueAttrs+rangeAttrs+'></label>';
}

function extraControlsHtml(id,v,values){
 let html='';
 if(id==='operations'){
  html+='<label class="operation-switch"><input type="checkbox" name="ordersEnabled" '+(values.ordersEnabled?'checked':'')+'> Tiếp nhận đơn đặt hàng trực tuyến</label>';
 }
 if(Channels.gatewayConfigIds.includes(id)){
  html+='<label>Môi trường<select name="environment"><option value="sandbox">Thử nghiệm</option><option value="production" '+(v.environment==='production'?'selected':'')+'>Chính thức</option></select></label>'
   +'<label><input type="checkbox" name="enabled" '+(v.enabled?'checked':'')+'> Cho phép sử dụng '+titles[id]+'</label>';
 }
 if(Channels.offlinePaymentConfigIds.includes(id)){
  html+='<label><input type="checkbox" name="enabled" '+(values.enabled?'checked':'')+'> Cho phép sử dụng '+titles[id]+'</label>';
 }
 if(id==='misa'){
  html+='<label>Môi trường kết nối<select name="environment"><option value="sandbox" '+(values.environment!=='production'?'selected':'')+'>Thử nghiệm (Sandbox)</option><option value="production" '+(values.environment==='production'?'selected':'')+'>Chính thức (Production)</option></select></label>'
   +'<label class="operation-switch"><input type="checkbox" name="autoIssue" '+(values.autoIssue?'checked':'')+'> Tự động xuất hóa đơn khi đơn hoàn thành & đã thanh toán</label>'
   +'<label class="operation-switch"><input type="checkbox" name="enabled" '+(values.enabled?'checked':'')+'> Kích hoạt kết nối hóa đơn điện tử MISA eShop</label>';
 }
 return html;
}

function reauthHtml(id){
 if(id==='profile')return '<p class="help-text">Thông tin hồ sơ không thay đổi tên đăng nhập hoặc liên hệ khôi phục đã xác minh.</p>';
 return '<div class="configuration-reauth"><p>Xác nhận bằng mật khẩu và mã xác thực hiện tại của chủ doanh nghiệp.</p>'
  +'<div class="form-grid">'
  +'<label>Mật khẩu hiện tại<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label>'
  +'<label>Mã xác thực / mã dự phòng<input name="factorCode" autocomplete="one-time-code" maxlength="32"></label>'
  +'</div><button type="button" data-config-email>Gửi mã qua email</button></div>';
}

function form(id){
 const record=data?.records?.[id]||{version:0,data:{}},v=record.data||{};
 const values=formDefaults(id,v);
 const inputsHtml=(id==='chat_ai'?AiOps.chatAIFields(v):'')
  +fields[id].map(field=>fieldInputHtml(id,v,values,field)).join('')
  +extraControlsHtml(id,v,values);
 const saveLabel=esc(id==='chat_ai'?'Chat AI':titles[id].toLowerCase());
 const markup='<form class="configuration-form" data-config-form="'+id+'" data-version="'+record.version+'">'
  +'<div class="form-grid">'+inputsHtml+'</div>'
  +reauthHtml(id)
  +'<div class="configuration-actions">'+testButtonHtml(id)+'<button type="submit" class="primary-button">Lưu '+saveLabel+'</button><p role="status" aria-live="polite"></p></div>'
  +'</form>';
 if(id!=='payment_9pay')return markup;
 return markup.replace(/<input type="checkbox" name="enabled"[^>]*>/,'<input type="checkbox" name="enabled" disabled>')
  +'<p class="help-text">9Pay chưa hỗ trợ nhận thanh toán. Có thể lưu thông tin cấu hình để đối chiếu.</p>';
}

function openConfigModal(configId,actionButton){
 if(typeof document==='undefined'||typeof document.createElement!=='function')return;
 let backdrop=document.getElementById('config-popup-modal');
 if(!backdrop){
  backdrop=document.createElement('div');
  backdrop.id='config-popup-modal';
  backdrop.className='config-modal-backdrop';
  backdrop.hidden=true;
  document.body.appendChild(backdrop);
 }
 const meta=configModalMeta[configId]||{title:titles[configId]||'Cấu hình hệ thống',sub:'Thiết lập tham số và khóa bảo mật',icon:DEFAULT_MODAL_ICON};
 const webhookHtml=Channels.renderWebhookBox(configId,data?.callbacks||{});
 const formHtml=form(configId);
 if(backdrop.hidden){
  configModalTrigger=document.activeElement;
  configModalPreviousOverflow=document.body.style.overflow||'';
 }
 backdrop.innerHTML='<div class="config-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title-'+configId+'">'
  +'<header class="config-modal-header"><div class="config-modal-icon">'+meta.icon+'</div>'
  +'<div class="config-modal-header-text"><h3 class="config-modal-title" id="modal-title-'+configId+'">'+esc(meta.title)+'</h3><p class="config-modal-sub">'+esc(meta.sub)+'</p></div>'
  +'<button type="button" class="config-modal-close" data-close-config-modal aria-label="Đóng">×</button></header>'
  +'<div class="config-modal-body">'+webhookHtml+formHtml+'<div class="config-modal-status" data-modal-status></div></div>'
  +'</div>';
 if(actionButton?.matches('[data-shipping-enable],[data-payment-enable]')){
  const confirmButton=actionButton.cloneNode(true);
  confirmButton.textContent='Xác nhận '+actionButton.textContent.toLocaleLowerCase('vi-VN');
  backdrop.querySelector('.configuration-actions').prepend(confirmButton);
 }
 backdrop.hidden=false;
 if(typeof document.body!=='undefined'&&document.body.style){
  document.body.style.overflow='hidden';
 }
 const firstInput=backdrop.querySelector('input:not([type=hidden]):not([type=password]), select');
 if(firstInput&&typeof firstInput.focus==='function'){
  setTimeout(()=>{if(!backdrop.hidden&&firstInput.isConnected)try{firstInput.focus();}catch(e){}},50);
 }
}

function closeConfigModal(){
 const backdrop=document.getElementById('config-popup-modal');
 if(!backdrop||backdrop.hidden)return;
 backdrop.hidden=true;
 backdrop.innerHTML='';
 if(typeof document.body!=='undefined'&&document.body.style){
  document.body.style.overflow=configModalPreviousOverflow;
 }
 if(configModalTrigger?.isConnected&&typeof configModalTrigger.focus==='function')configModalTrigger.focus();
 configModalTrigger=null;
}

const ctx={admin,owner,read,form,titles,openConfigModal,closeConfigModal,getData:()=>data};
const channels=Channels.createChannelsController(ctx);
const aiOps=AiOps.createAiOpsController(ctx);

document.addEventListener('click',event=>{
 const toggle=event.target.closest('[data-open-config-popup],[data-toggle-drawer]');
 if(!toggle)return;
 const configId=toggle.dataset.openConfigPopup||toggle.dataset.toggleDrawer;
 if(!configId)return;
 openConfigModal(configId);
});

document.addEventListener('click',event=>{
 if(event.target.closest('[data-close-config-modal]')){
  closeConfigModal();
  return;
 }
 const backdrop=document.getElementById('config-popup-modal');
 if(backdrop&&!backdrop.hidden&&event.target===backdrop){
  closeConfigModal();
 }
});

document.addEventListener('keydown',event=>{
 const backdrop=document.getElementById('config-popup-modal');
 if(!backdrop||backdrop.hidden)return;
 if(event.key==='Escape'){
  event.preventDefault();
  closeConfigModal();
  return;
 }
 if(event.key==='Tab'){
  const controls=[...backdrop.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(el=>!el.closest('[hidden]'));
  const first=controls[0],last=controls.at(-1),active=document.activeElement;
  if(first&&(!backdrop.contains(active)||(event.shiftKey?active===first:active===last))){
   event.preventDefault();
   (event.shiftKey?last:first).focus();
  }
 }
});

function readFormValues(id,f){
 const values={};
 for(const [name,,type]of fields[id]){
  const el=f.elements[name];
  if(!el)continue;
  const value=el.value;
  if(type==='password'&&!value)continue;
  values[name]=type==='number'?Number(value):value;
 }
 AiOps.readAiOpsValues(id,f,values);
 Channels.readChannelToggles(id,f,values);
 Channels.normalizeChannelValues(id,values);
 return values;
}

// Sau khi lưu, làm mới đúng khu vực đang hiển thị cấu hình vừa thay đổi.
async function refreshAfterSave(id,result){
 if(id==='operations'){
  await window.GAERUOwner?.load();
 }else if(id.startsWith('shipping_')){
  await channels.mountShipping();
 }else if(paymentIds.has(id)){
  await channels.mountPayments();
  const panel=document.getElementById('config-panel-'+id);
  if(panel){
   const drawer=panel.querySelector('.payment-card-drawer')||panel;
   if('open' in drawer)drawer.open=true;
   const msg=panel.querySelector('[data-payment-result]')||panel.querySelector('[role=status]');
   if(msg)msg.textContent=result.message;
  }
 }else if(id!=='profile'){
  await aiOps.load();
  if(id==='chat_ai'){
   const panel=document.getElementById('config-panel-chat_ai');
   if(panel){
    panel.open=true;
    const panelStatus=panel.querySelector('[role=status]');
    if(panelStatus)panelStatus.textContent=result.message+' Nhập lại mật khẩu và mã xác thực mới để kiểm tra kết nối.';
   }
  }
 }else{
  await window.GAERUOwner?.load();
 }
 admin.showGlobal(result.message);
}

document.addEventListener('submit',async e=>{
 const f=e.target.closest('[data-config-form]');
 if(!f)return;
 e.preventDefault();
 const id=f.dataset.configForm;
 const status=f.querySelector('[role=status]');
 const modal=typeof f.closest==='function'?f.closest('.config-modal-dialog'):null;
 const modalStatus=modal?.querySelector('[data-modal-status]');
 const button=f.querySelector('[type=submit]');
 if(button)button.disabled=true;

 function showMsg(msg,isError){
  if(modalStatus){
   modalStatus.textContent=(isError?'❌ ':'✅ ')+msg;
   modalStatus.className='config-modal-status is-visible '+(isError?'is-error':'is-success');
  }
  if(status){
   status.textContent=msg;
   if(status.style)status.style.color=isError?'#dc2626':'#16a34a';
  }
 }

 try{
  const values=readFormValues(id,f);
  const record=data?.records?.[id]||{version:0,data:{}};
  const curVersion=Number(f.dataset.version||record.version||0);

  if(id!=='profile'&&!f.elements.password?.value){
   if(f.elements.password&&typeof f.elements.password.focus==='function')f.elements.password.focus();
   showMsg('Vui lòng nhập mật khẩu hiện tại của chủ doanh nghiệp để xác thực.',true);
   return;
  }

  const problem=Channels.validateChannelValues(id,values,curVersion);
  if(problem){
   const target=problem.focus&&f.elements[problem.focus];
   if(target&&typeof target.focus==='function')target.focus();
   showMsg(problem.message,true);
   return;
  }

  const result=await admin.request('/api/gaeru_ceo/owner/configuration/'+id,{
   method:'PUT',
   body:JSON.stringify({
    data:values,
    version:curVersion,
    password:f.elements.password?.value,
    factorCode:f.elements.factorCode?.value,
    factorChallengeId:f.dataset.challenge
   })
  });

  f.dataset.version=result.version;
  if(data?.records)data.records[id]=result;
  showMsg(result.message,false);

  for(const input of f.querySelectorAll('input[type=password],[name=factorCode]'))input.value='';
  delete f.dataset.challenge;

  await refreshAfterSave(id,result);
 }catch(error){
  showMsg(error.message,true);
  if(error.status===401||error.status===403){
   if(f.elements.password)f.elements.password.value='';
  }
 }finally{
  if(button)button.disabled=false;
 }
});

document.addEventListener('click',async event=>{
 const button=event.target.closest('[data-config-open]');
 if(!button)return;
 const target=button.dataset.configOpen;
 await admin.activateView(paymentIds.has(target)?'payments':'settings');
 const panelId=target==='payments'?'config-panel-vnpay':'config-panel-'+target;
 const panel=document.getElementById(panelId);
 if(panel){
  panel.open=true;
  panel.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
  panel.querySelector('input')?.focus({preventScroll:true});
 }
});

window.GAERUConfiguration={
 load:aiOps.load,
 mountProfile:aiOps.mountProfile,
 mountOperations:aiOps.mountOperations,
 mountShipping:channels.mountShipping,
 mountPayments:channels.mountPayments,
 mountOAuth:channels.mountOAuth,
 openConfigModal,
 closeConfigModal,
 // business.js mở popup cấu hình qua tên openPopup.
 openPopup:openConfigModal
};
})();
