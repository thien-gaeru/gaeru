// admin/configuration-ai-ops.js
// Cấu hình vận hành & AI: hồ sơ chủ doanh nghiệp, tiếp nhận đơn, Chat AI, MISA eShop, sàn TMĐT, bảo mật phiên và lưu trữ tệp.
// Module chỉ khai báo metadata + controller; configuration.js khởi tạo controller với ngữ cảnh dùng chung.
(()=>{
const esc=window.GAERUAdminShared.escapeHtml;

const AI_PROVIDERS=[['openai','OpenAI / GPT'],['gemini','Google Gemini'],['claude','Anthropic Claude']];
const AI_MODEL_LABELS=[['openai','OpenAI / GPT'],['gemini','Gemini'],['claude','Claude']];
const SETTINGS_PANEL_IDS=['chat_ai','oauth','misa','shopee','tiktok','security'];

const titles={
 chat_ai:'Chat AI · GPT, Gemini, Claude',
 operations:'Vận hành cửa hàng',
 profile:'Hồ sơ chủ doanh nghiệp',
 security:'Bảo mật hệ thống',
 misa:'MISA eShop',
 shopee:'Shopee',
 tiktok:'TikTok Shop'
};

const fieldPlaceholders={
 misa:{appId:'App ID Open API do MISA cấp',storeId:'Store ID mã định danh cửa hàng MISA',taxCode:'Mã số thuế doanh nghiệp (VD: 0101243150)',templateCode:'Ký hiệu mẫu hóa đơn (VD: 1/001)',series:'Ký hiệu hóa đơn (VD: C26TGA)'}
};

const fields={
 chat_ai:[],
 operations:[],
 profile:[['fullName','Họ và tên'],['company','Tên doanh nghiệp'],['position','Chức danh'],['taxCode','Mã số thuế'],['address','Địa chỉ doanh nghiệp']],
 security:[['idleMinutes','Tự đăng xuất khi không hoạt động (phút)','number'],['absoluteHours','Thời hạn tối đa mỗi phiên (giờ)','number']],
 misa:[['appId','Mã ứng dụng / App ID Open API'],['storeId','Mã cửa hàng Store ID'],['secret','Khóa bảo mật Open API Secret','password'],['taxCode','Mã số thuế doanh nghiệp xuất HĐ'],['templateCode','Ký hiệu mẫu số hóa đơn (VD: 1/001)'],['series','Ký hiệu hóa đơn (VD: C26TGA)']],
 shopee:[['partnerId','Partner ID'],['shopId','Shop ID'],['secret','Partner key','password']],
 tiktok:[['appKey','App key'],['shopId','Mã cửa hàng'],['secret','App secret','password']]
};

const configModalMeta={
 chat_ai:{title:'Cấu hình & Khóa · Chat AI (GPT, Gemini, Claude)',sub:'Model AI, API Keys và kích hoạt trợ lý tư vấn bán hàng',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2 2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"></path><rect x="4" y="8" width="16" height="12" rx="2"></rect><path d="M9 13v2M15 13v2"></path></svg>'},
 operations:{title:'Cấu hình · Vận hành & Tiếp nhận đơn',sub:'Bật / tắt tiếp nhận đơn đặt hàng trực tuyến trên hệ thống GAERU',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>'},
 security:{title:'Cấu hình · Chính sách phiên & Bảo mật',sub:'Thời hạn phiên làm việc và bảo vệ tài khoản quản trị',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>'},
 misa:{title:'Cấu hình & Khóa · MISA eShop',sub:'Kết nối hóa đơn điện tử & phần mềm bán hàng MISA eShop (meInvoice)',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><path d="M4 4h16v16H4z"></path></svg>'},
 shopee:{title:'Cấu hình & Khóa · Sàn TMĐT Shopee',sub:'Partner ID, Shop ID và Partner Key liên kết Shopee Open Platform',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ee4d2d" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path><line x1="3" y1="6" x2="21" y2="6"></line><path d="M16 10a4 4 0 0 1-8 0"></path></svg>'},
 tiktok:{title:'Cấu hình & Khóa · Sàn TMĐT TikTok Shop',sub:'App Key, Shop ID và App Secret TikTok Shop Partner Center',icon:'<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2"><path d="M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5"></path></svg>'}
};

function chatAIFields(v){
 const providerOptions=AI_PROVIDERS.map(([id,label])=>'<option value="'+id+'" '+(v.provider===id?'selected':'')+'>'+label+'</option>').join('');
 const profileInputs=AI_MODEL_LABELS.map(([id,label])=>
  '<label>Model '+label+'<input name="'+id+'Model" value="'+esc(v.profiles?.[id]?.model)+'" maxlength="120" pattern="[a-zA-Z0-9._-]*" placeholder="ID model trong tài khoản nhà cung cấp"></label>'
  +'<label>API key '+label+'<input name="'+id+'Key" type="password" autocomplete="new-password" maxlength="2000" placeholder="'+(v.profiles?.[id]?.secretConfigured?'Đã lưu · để trống để giữ khóa':'Nhập khóa API riêng')+'"></label>'
 ).join('');
 return '<label>AI đang sử dụng<select name="provider">'+providerOptions+'</select></label>'
  +'<label><input type="checkbox" name="aiEnabled" '+(v.enabled?'checked':'')+'> Bật Chat AI</label>'
  +profileInputs;
}

// Bổ sung các giá trị không thuộc danh sách `fields` (checkbox, select, hồ sơ AI) trước khi lưu.
function readAiOpsValues(id,f,values){
 if(id==='chat_ai'){
  values.enabled=f.elements.aiEnabled?f.elements.aiEnabled.checked:false;
  values.provider=f.elements.provider?f.elements.provider.value:'openai';
  values.profiles=Object.fromEntries(['openai','gemini','claude'].map(provider=>[
   provider,
   {
    model:f.elements[provider+'Model']?f.elements[provider+'Model'].value.trim():'',
    ...(f.elements[provider+'Key']&&f.elements[provider+'Key'].value.trim()?{apiKey:f.elements[provider+'Key'].value.trim()}:{})
   }
  ]));
 }
 if(id==='operations'){
  values.ordersEnabled=f.elements.ordersEnabled?f.elements.ordersEnabled.checked:false;
 }
}

function probeFailure(error){
 const d=error.diagnostic;
 if(!d)return error.message;
 const names={openai:'OpenAI / GPT',gemini:'Google Gemini',claude:'Anthropic Claude'};
 return (names[d.provider]||'AI')+' · '+d.model+': '+error.message+'\nMã chẩn đoán: '+d.code+(d.upstreamStatus?' · HTTP '+d.upstreamStatus:'')+(d.requestId?' · Mã hỗ trợ: '+d.requestId:'');
}

function clearProbeCredentials(f){
 for(const input of f.querySelectorAll('input[type=password],[name=factorCode]'))input.value='';
 delete f.dataset.challenge;
}

function setModalStatus(modalStatus,prefix,message,stateClass){
 if(!modalStatus)return;
 modalStatus.textContent=prefix+message;
 modalStatus.className='config-modal-status is-visible'+(stateClass?' '+stateClass:'');
}

function settingsPanelSummary(id,data){
 const records=data.records;
 if(id==='chat_ai')return records.chat_ai.data.enabled?'Đã bật · kiểm tra model trước khi sử dụng':'Chưa bật';
 if(id==='oauth')return records.oauth?.data?.googleClientId||records.oauth?.data?.appleClientId?'Đã lưu Client ID · Sẵn sàng':'Chưa cấu hình';
 if(id==='misa')return records.misa?.data?.enabled?(records.misa?.data?.autoIssue?'Đã bật · Tự động xuất hóa đơn':'Đã bật · Xuất thủ công'):'Chưa kích hoạt';
 if(id==='security')return 'Chính sách phiên quản trị';
 return records[id]?.version?'Đã lưu ứng dụng · chưa cấp quyền đồng bộ':'Chưa cấu hình';
}

function settingsPanelHelp(id,services){
 if(id==='oauth')return '<p class="help-text">Nhập Google Client ID và Apple Service ID để kích hoạt đăng nhập một chạm. Hướng dẫn lấy mã: <br>• <strong>Google:</strong> Truy cập Google Cloud Console ➔ APIs & Services ➔ Credentials ➔ OAuth Client ID (Web Application) ➔ thêm redirect URI: <code>https://gaeru.com/account.html</code> (hoặc <code>http://localhost:3000/account.html</code>).<br>• <strong>Apple:</strong> Truy cập Apple Developer ➔ Certificates, Identifiers & Profiles ➔ Services IDs (VD: <code>com.gaeru.web.signin</code>).</p>';
 if(id==='chat_ai')return '<p class="help-text">Chọn AI, nhập ID model và khóa tương ứng rồi lưu. Có thể giữ khóa riêng cho cả ba nhà cung cấp. Kiểm tra chat AI gửi một câu thử, có thể tính phí API theo tài khoản của bạn. Chỉ câu hỏi, tin nhắn gần đây và dữ liệu sản phẩm được gửi cho AI; tệp đính kèm dành cho nhân viên.</p>';
 if(id==='security')return '<p class="help-text">Turnstile: '+(services.turnstileConfigured?'Đã cấu hình':'Chưa cấu hình')+' · Email: '+(services.smtpConfigured?'Đã cấu hình':'Chưa cấu hình')+'. Khóa CAPTCHA và khóa mã hóa được quản lý trên máy chủ.</p>';
 return '<p class="help-text">Lưu hồ sơ ứng dụng trước. Chưa thực hiện OAuth, gọi API hay đồng bộ đơn và tồn kho. Cần quyền và thông tin ứng dụng được nhà cung cấp phê duyệt.</p>';
}

// ctx = { admin, owner, read, getData, form, titles }
function createAiOpsController(ctx){
 const {admin,owner,read,form}=ctx;

 async function mountProfile(root){
  if(!owner()||!root?.isConnected)return;
  await read();
  if(!root.isConnected)return;
  root.innerHTML='<details class="configuration-panel owner-profile-panel"><summary><span>Hồ sơ chủ doanh nghiệp</span><small>Mở để xem hoặc chỉnh sửa</small></summary><div>'+form('profile')+'</div></details>';
 }

 async function mountOperations(root){
  if(!owner()||!root?.isConnected)return;
  await read();
  if(!root.isConnected)return;
  root.innerHTML='<h3>Điều khiển vận hành</h3><p class="help-text">Chọn trạng thái, sau đó xác nhận để lưu.</p>'+form('operations')
   +'<div class="configuration-service-links"><button type="button" data-config-open="payments">Quản lý kênh thanh toán</button><button type="button" data-config-open="security">Chính sách phiên</button><button type="button" data-owner-security>Tài khoản &amp; xác thực</button></div>';
  const f=root.querySelector('form'),panel=document.createElement('details');
  panel.className='owner-operation-confirm';
  panel.innerHTML='<summary>Xác nhận và lưu thay đổi</summary>';
  f.append(panel);
  panel.append(f.querySelector('.configuration-reauth'),f.querySelector('.configuration-actions'));
  f.addEventListener('invalid',()=>{panel.open=true;},true);
 }

 async function load(){
  if(!owner())return;
  const data=await read();
  const root=document.querySelector('#system-configuration');
  if(!root)return;
  const services=data.services;
  const headerHtml='<header class="section-heading"><div><p class="eyebrow">Cấu hình riêng của chủ doanh nghiệp</p><h2>Kết nối, AI và bảo mật</h2></div><button type="button" class="secondary-button" data-config-open="payments">Mở Quản lý thanh toán ↗</button></header>'
   +'<p class="help-text">Khóa bí mật được mã hóa khi lưu, không trả lại trình duyệt. Thay đổi quan trọng cần mật khẩu và xác thực hai yếu tố. Các kênh thanh toán (COD, Chuyển khoản, VNPAY, 9Pay) được quản lý tập trung tại mục Quản lý thanh toán.</p>';
  const storageHtml='<section class="configuration-panel"><h3>Lưu trữ ảnh và tài liệu</h3>'
   +'<button type="button" data-media-storage-probe>Kiểm tra lưu trữ ngay</button><p role="status" data-media-storage-probe-result></p>'
   +'<p>Nơi lưu tệp mới: '+(services.mediaStorage?.provider==='hostinger'?'Hostinger':'Thư mục cục bộ chưa cấu hình')+'</p>'
   +'<p role="status">'+esc(services.mediaStorage?.message||'Chưa kiểm tra')+'</p>'
   +'<p class="help-text">Ảnh và tài liệu được đọc từ thư mục lưu trữ cục bộ. Cơ sở dữ liệu giữ thông tin và tham chiếu tệp.</p>'
   +'<p role="status">Kiểm tra tệp cục bộ: '+esc(services.mediaAudit?.message||'Chưa kiểm tra')+'</p></section>';
  const panelsHtml=SETTINGS_PANEL_IDS.map(id=>'<details class="configuration-panel" id="config-panel-'+id+'">'
   +'<summary><span>'+ctx.titles[id]+'</span><small>'+settingsPanelSummary(id,data)+'</small></summary>'
   +'<div>'+settingsPanelHelp(id,services)
   +'<div style="margin-bottom:12px;"><button type="button" class="secondary-button" data-open-config-popup="'+id+'">⚙ Mở cửa sổ cấu hình trực quan</button></div>'
   +form(id)+'</div></details>').join('');
  root.innerHTML=headerHtml+storageHtml+panelsHtml;
 }

 function savedAISelection(f){
  const record=ctx.getData().records.chat_ai,v=record.data,provider=f.elements.provider.value,model=f.elements[provider+'Model'].value.trim();
  const unsaved=!record.version
   ||provider!==v.provider
   ||model!==(v.profiles?.[provider]?.model||'')
   ||f.elements.aiEnabled.checked!==Boolean(v.enabled)
   ||f.elements[provider+'Key'].value.trim();
  if(unsaved)throw Error('Có cấu hình AI chưa lưu. Bấm Lưu Chat AI trước, rồi nhập lại thông tin xác thực để kiểm tra.');
  return {provider,model};
 }

 document.addEventListener('click',async e=>{
  const button=e.target.closest('[data-config-email]');
  if(!button)return;
  const f=button.closest('form'),status=f.querySelector('[role=status]');
  try{
   if(!f.elements.password.value)throw Error('Nhập mật khẩu hiện tại trước.');
   const r=await window.GAERUSecurity.api('/authorize',{password:f.elements.password.value});
   f.dataset.challenge=r.challengeId;
   status.textContent=r.message;
  }catch(error){
   status.textContent=error.message;
  }
 });

 document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-chat-ai-test]');
  if(!button||button.disabled)return;
  const f=button.closest('form'),status=f.querySelector('[role=status]');
  const modal=typeof button.closest==='function'?button.closest('.config-modal-dialog'):null;
  const modalStatus=modal?.querySelector('[data-modal-status]');
  try{
   const selected=savedAISelection(f);
   if(!f.elements.password.value){
    f.elements.password.focus();
    throw Error('Nhập lại mật khẩu hiện tại trước khi kiểm tra. Nếu đã bật xác thực hai yếu tố, dùng mã mới chưa sử dụng.');
   }
   const pwd=f.elements.password.value;
   button.disabled=true;
   const testingMsg='Đang kiểm tra '+selected.provider+' · '+selected.model+' đã lưu…';
   if(status)status.textContent=testingMsg;
   setModalStatus(modalStatus,'⏳ ',testingMsg,'');
   const result=await admin.request('/api/gaeru_ceo/owner/configuration/chat_ai/test',{
    method:'POST',
    body:JSON.stringify({
     version:Number(f.dataset.version),
     expectedProvider:selected.provider,
     expectedModel:selected.model,
     password:pwd,
     factorCode:f.elements.factorCode.value,
     factorChallengeId:f.dataset.challenge
    })
   });
   const succMsg=result.message+' '+result.provider+' · '+result.model;
   if(status)status.textContent=succMsg;
   setModalStatus(modalStatus,'✅ ',succMsg,'is-success');
   clearProbeCredentials(f);
  }catch(error){
   const failMsg=probeFailure(error)+(error.stage==='provider'?' Nhập lại thông tin xác thực mới nếu cần kiểm tra lại.':'');
   if(status)status.textContent=failMsg;
   setModalStatus(modalStatus,'❌ ',failMsg,'is-error');
   if(error.stage==='provider')clearProbeCredentials(f);
  }finally{
   button.disabled=false;
  }
 });

 document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-misa-test]');
  if(!button)return;
  const f=button.closest('form'),status=f.querySelector('[role=status]');
  const modalStatus=f.closest('.config-modal-body')?.querySelector('[data-modal-status]');
  try{
   if(!f.elements.password?.value){
    throw Error('Nhập lại mật khẩu hiện tại trước khi kiểm tra. Nếu đã bật xác thực hai yếu tố, dùng mã mới chưa sử dụng.');
   }
   const pwd=f.elements.password.value;
   button.disabled=true;
   const testingMsg='Đang kiểm tra kết nối MISA eShop…';
   if(status)status.textContent=testingMsg;
   setModalStatus(modalStatus,'⏳ ',testingMsg,'');
   const result=await admin.request('/api/gaeru_ceo/owner/configuration/misa/test',{
    method:'POST',
    body:JSON.stringify({
     version:Number(f.dataset.version),
     password:pwd,
     factorCode:f.elements.factorCode.value,
     factorChallengeId:f.dataset.challenge
    })
   });
   const succMsg=(result.message||'Kết nối thành công.')+' ('+(result.environment==='production'?'Chính thức':'Thử nghiệm')+' · Cửa hàng: '+result.storeId+')';
   if(status)status.textContent=succMsg;
   setModalStatus(modalStatus,'✅ ',succMsg,'is-success');
   clearProbeCredentials(f);
  }catch(error){
   const failMsg=error.message||'Kiểm tra kết nối MISA eShop thất bại.';
   if(status)status.textContent=failMsg;
   setModalStatus(modalStatus,'❌ ',failMsg,'is-error');
   if(error.stage==='provider')clearProbeCredentials(f);
  }finally{
   button.disabled=false;
  }
 });

 document.addEventListener('change',event=>{
  const input=event.target;
  if(input.name!=='ordersEnabled')return;
  const f=input.closest('[data-config-form="operations"]');
  if(!f)return;
  const panel=f.querySelector('.owner-operation-confirm');
  if(panel){
   panel.open=true;
   panel.querySelector('summary').textContent=input.checked?'Xác nhận bật nhận đơn':'Xác nhận tạm dừng nhận đơn';
  }
 });

 document.addEventListener('click',async e=>{
  const button=e.target.closest('[data-media-storage-probe]');
  if(!button)return;
  const status=button.parentElement.querySelector('[data-media-storage-probe-result]');
  button.disabled=true;
  status.textContent='Đang thử ghi, đọc lại và xóa tệp kiểm tra…';
  try{
   const r=await admin.request('/api/gaeru_ceo/owner/media-storage/probe',{method:'POST',body:'{}'});
   status.textContent=[
    r.message,
    r.errorCode,
    r.operation,
    r.configuredPath?'MEDIA_ROOT: '+r.configuredPath:'',
    r.errorPath?'Đường dẫn lỗi: '+r.errorPath:'',
    r.inventory?'Thư mục thực: '+r.inventory.realPath+' · '+r.inventory.files+' tệp · '+r.inventory.bytes+' byte':'',
    ...(r.inventory?.directories||[]).map(d=>d.name+': '+d.files+' tệp')
   ].filter(Boolean).join(' · ');
  }catch(error){
   status.textContent=error.message;
  }finally{
   button.disabled=false;
  }
 });

 return {load,mountProfile,mountOperations};
}

window.GAERUConfigurationAiOps=Object.freeze({
 titles,
 fields,
 fieldPlaceholders,
 configModalMeta,
 chatAIFields,
 readAiOpsValues,
 probeFailure,
 createAiOpsController
});
})();
