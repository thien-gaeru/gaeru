(()=>{

  function showCenterPopup({ type = 'info', title = '', message = '' } = {}) {
    document.querySelectorAll?.('.gaeru-center-popup')?.forEach(p => {
      try { p.close?.(); } catch(e) {}
      p.remove();
    });
    document.querySelectorAll?.('.gaeru-action-notices, .gaeru-action-notice')?.forEach(n => n.remove());
    const isError = type === 'error' || /lỗi|không đúng|chưa hợp lệ|sai|thất bại/i.test(message);
    const isSuccess = type === 'success' || /thành công|đã cập nhật|đã lưu|đã đổi|đã gửi|đã bật|đã tắt/i.test(message);
    const actualType = isError ? 'error' : (isSuccess ? 'success' : 'info');
    const actualTitle = title || (isError ? 'Thông báo' : (isSuccess ? 'Thành công' : 'Thông báo'));
    const iconSvg = actualType === 'error'
      ? '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>'
      : actualType === 'success'
      ? '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
      : '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0071e3" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="8"></line></svg>';

    if (typeof document.createElement !== 'function') return; const dialog = document.createElement('dialog');
    dialog.className = 'gaeru-center-popup';
    dialog.setAttribute('aria-modal', 'true');
    const escSafe = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    dialog.innerHTML = `
      <div class="center-popup-backdrop"></div>
      <div class="center-popup-card" role="dialog" aria-modal="true" aria-labelledby="center-popup-title">
        <div class="center-popup-icon center-popup-icon--${actualType}">${iconSvg}</div>
        <h3 id="center-popup-title" class="center-popup-title">${escSafe(actualTitle)}</h3>
        <p class="center-popup-message">${escSafe(message)}</p>
        <button type="button" class="button button-blue center-popup-btn">Đã hiểu</button>
      </div>
    `;
    let isClosing = false;
    const close = () => {
      if (isClosing) return;
      isClosing = true;
      dialog.classList.add('is-closing');
      setTimeout(() => {
        try { dialog.close?.(); } catch(e) {}
        dialog.remove();
      }, 180);
    };
    dialog.addEventListener('click', e => {
      if (e.target === dialog || e.target.classList.contains('center-popup-backdrop')) close();
    });
    dialog.addEventListener('cancel', e => {
      e.preventDefault();
      close();
    });
    const btn = dialog.querySelector('.center-popup-btn');
    btn.onclick = close;
    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') {
      try { dialog.showModal(); } catch(e) { dialog.setAttribute('open', ''); }
    } else {
      dialog.setAttribute('open', '');
    }
    btn.focus();
  }
  window.GAERUPopup = { show: showCenterPopup };
  window.showCenterPopup = showCenterPopup;


 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 async function api(path,body){const headers={};if(body!==undefined){const r=await fetch('/api/csrf',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw Error('Không thể khởi tạo phiên bảo mật.');const token=(await r.json()).csrfToken;headers['X-CSRF-Token']=token;headers['Content-Type']='application/json';window.GAERUAdmin?.setCsrf?.(token);}const response=await fetch('/api/account-security'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error||'Không thể thực hiện thao tác.'),{code:result.code});if(result.csrfToken)window.GAERUAdmin?.setCsrf?.(result.csrfToken);if(result.customer)window.GAERUCustomerSession?.set(result.customer);return result;}
 async function loginChallenge(result){return new Promise((resolve,reject)=>{const dialog=document.createElement('dialog');dialog.className='security-dialog';dialog.innerHTML=`<form class="security-form" data-no-action-feedback><h2>Xác thực hai yếu tố</h2><p>${esc(result.message)}</p><label>Mã xác thực hoặc mã dự phòng<input name="code" autocomplete="one-time-code" maxlength="32" required autofocus></label><button type="submit" class="button button-blue primary-button">Xác nhận đăng nhập</button><button type="button" data-cancel>Hủy</button><p role="status"></p><p>Mã email có hiệu lực 5 phút. Nếu hết hạn, hãy đăng nhập lại để nhận mã mới.</p></form>`;document.body.append(dialog);dialog.addEventListener('close',()=>{dialog.remove();reject(Error('Đã hủy bước xác thực.'));},{once:true});dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button'),status=e.target.querySelector('[role=status]');button.disabled=true;status.textContent='Đang xác thực…';try{const complete=await api('/login/complete',{code:e.target.elements.code.value.trim()});resolve(complete);dialog.close();}catch(error){status.textContent=error.message;button.disabled=false;}};dialog.showModal();});}
 async function render(root){const data=await api('/settings');if(!root.isConnected)return;let challengeId='',setup=null,contactChallenge='';root.classList.add("security-settings");const isCustomer=Boolean(root.closest("[data-account-profile]"));root.classList.toggle("security-admin",!isCustomer);
  const mfaDot=data.method==="off"?"is-off":"is-on",mfaLabel=data.method==="off"?"Chưa bật":"Đã bật";
  const customerMarkup=`<form class="security-form"><p class="security-feedback" role="status" aria-live="polite"></p><section class="security-identity" hidden><h4>Xác nhận thao tác</h4><p>Mật khẩu hiện tại dùng để xác nhận các thay đổi bảo mật của bạn.</p><div class="security-field-grid"><label><span>Mật khẩu hiện tại</span><input name="password" type="password" autocomplete="current-password" required maxlength="200"><small class="security-password-note">Cần nhập mật khẩu hiện tại trước khi thực hiện cài đặt bên dưới.</small></label>${data.method==="off"?"":`<label><span>Mã xác thực hiện tại hoặc mã dự phòng</span><input name="factorCode" autocomplete="one-time-code" maxlength="32"></label>`}</div>${data.method==="email"?`<button type="button" data-action="send">Gửi mã xác nhận thao tác</button>`:""}</section><details class="security-accordion-item security-section" data-accordion-item="password" data-security-section="password"><summary class="security-accordion-header"><span class="security-item-icon security-icon-password" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg></span><span class="security-item-titles"><strong>Mật khẩu đăng nhập</strong><span>Đổi mật khẩu bảo vệ tài khoản</span></span><span class="security-item-chevron" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></span></summary><div class="security-accordion-body security-section-body"><div class="security-modal-backdrop" data-close-modal></div><div class="security-modal-card"><div class="security-modal-header"><div class="security-modal-title-group"><span class="security-item-icon security-icon-password" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg></span><div><h3 class="security-modal-title">Đổi mật khẩu đăng nhập</h3><p class="security-modal-subtitle">Tạo mật khẩu mới an toàn cho tài khoản</p></div></div><button type="button" class="security-modal-close" data-close-modal aria-label="Đóng">✕</button></div><div class="security-modal-inner"><div class="security-field-grid"><label>Mật khẩu mới<input name="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="72"></label><label>Nhập lại mật khẩu mới<input name="confirmPassword" type="password" autocomplete="new-password" maxlength="72"></label></div><button type="button" class="button button-blue" data-action="password" data-no-action-feedback>Đổi mật khẩu</button></div></div></div></details><details class="security-accordion-item security-section" data-accordion-item="factor" data-security-section="factor"><summary class="security-accordion-header"><span class="security-item-icon security-icon-2fa" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg></span><span class="security-item-titles"><strong>Xác thực 2 bước (2FA) <span class="security-status-dot ${mfaDot}">●</span></strong><span>App Authenticator / Mã email</span></span><span class="security-badge-pill ${mfaDot}">${mfaLabel}</span><span class="security-item-chevron" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></span></summary><div class="security-accordion-body security-section-body"><div class="security-modal-backdrop" data-close-modal></div><div class="security-modal-card"><div class="security-modal-header"><div class="security-modal-title-group"><span class="security-item-icon security-icon-2fa" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg></span><div><h3 class="security-modal-title">Xác thực 2 bước (2FA)</h3><p class="security-modal-subtitle">Bảo vệ tài khoản bằng lớp bảo mật thứ hai khi đăng nhập</p></div></div><button type="button" class="security-modal-close" data-close-modal aria-label="Đóng">✕</button></div><div class="security-modal-inner"><div data-factor-initial><label>Phương thức muốn sử dụng<select name="method"><option value="email">Mã qua email</option><option value="app">Ứng dụng xác thực</option></select></label><div class="security-actions"><button type="button" class="button button-blue" data-action="setup" data-no-action-feedback>Thiết lập phương thức</button>${data.method!=="off"&&!data.mfaRequired?`<button type="button" class="security-danger" data-action="disable">Tắt xác thực hai yếu tố</button>`:""}</div></div><div data-setup hidden></div></div></div></div></details><details class="security-accordion-item security-section" data-accordion-item="support" data-security-section="support"><summary class="security-accordion-header"><span class="security-item-icon security-icon-support" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg></span><span class="security-item-titles"><strong>Hỗ trợ & Khôi phục</strong><span>Hotline, Email tiếp nhận</span></span><span class="security-item-chevron" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></span></summary><div class="security-accordion-body security-section-body"><div class="security-modal-backdrop" data-close-modal></div><div class="security-modal-card"><div class="security-modal-header"><div class="security-modal-title-group"><span class="security-item-icon security-icon-support" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg></span><div><h3 class="security-modal-title">Hỗ trợ & Khôi phục</h3><p class="security-modal-subtitle">Liên hệ hỗ trợ kỹ thuật hoặc bảo mật tài khoản</p></div></div><button type="button" class="security-modal-close" data-close-modal aria-label="Đóng">✕</button></div><div class="security-modal-inner"><div class="security-support-cards"><p>Để xóa hoặc khôi phục tài khoản, vui lòng liên hệ GAERU. Quản trị sẽ đối chiếu thông tin và gửi email để bạn xác nhận xóa an toàn.</p><div class="security-support-actions"><a href="tel:0829191080" class="button button-outline" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;">📞 Hotline: 082 919 1080</a> <a href="mailto:business@gaeru.com" class="button button-outline" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;">✉️ Email: business@gaeru.com</a></div></div></div></div></div></details></form><div data-backup></div>`;
  const adminMarkup=`${data.isOwner&&!data.mfaEnrollmentRequired?'<section class="editor-card" data-owner-profile></section>':''}<header class="security-heading"><div><p>Quản lý mật khẩu và cách xác thực khi đăng nhập.</p></div><span class="security-badge ${data.method==="off"?"":"is-enabled"}">${({off:"Xác thực hai yếu tố đang tắt",email:"Xác thực qua email",app:"Xác thực qua ứng dụng"})[data.method]}</span></header><dl class="security-facts"><div><dt>Email xác minh</dt><dd>${esc(data.email||"Chưa xác minh")}</dd></div><div><dt>Số điện thoại</dt><dd>${esc(data.phone||"Chưa gắn")}</dd></div><div><dt>Mã dự phòng còn lại</dt><dd>${data.recoveryCodesRemaining}</dd></div></dl><form class="security-form"><p class="security-feedback" role="status" aria-live="polite"></p><section class="security-identity"><h4>Xác nhận thao tác</h4><p>Mật khẩu hiện tại dùng để xác nhận các thay đổi của bạn.</p><div class="security-field-grid"><label><span>Mật khẩu hiện tại</span><input name="password" type="password" autocomplete="current-password" required maxlength="200"><small class="security-password-note">Cần nhập mật khẩu hiện tại trước khi nhập thông tin hoặc thực hiện các cài đặt bên dưới.</small></label>${data.method==="off"?"":`<label><span>Mã xác thực hiện tại hoặc mã dự phòng</span><input name="factorCode" autocomplete="one-time-code" maxlength="32"></label>`}</div>${data.method==="email"?`<button type="button" data-action="send">Gửi mã xác nhận thao tác</button>`:""}</section><details class="security-section"><summary>Đổi mật khẩu<span>Tạo mật khẩu mới cho tài khoản</span></summary><div class="security-section-body"><div class="security-field-grid"><label>Mật khẩu mới<input name="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="72"></label><label>Nhập lại mật khẩu mới<input name="confirmPassword" type="password" autocomplete="new-password" maxlength="72"></label></div><button type="button" data-action="password">Đổi mật khẩu</button></div></details>${data.isOwner||!isCustomer?`<details class="security-section"><summary>Thông tin khôi phục<span>Email và số điện thoại liên kết</span></summary><div class="security-section-body"><div class="security-field-grid"><label>Email<input type="email" name="email" value="${esc(data.email)}" maxlength="254"></label><label>Số điện thoại<input type="tel" name="phone" value="${esc(data.phone)}" maxlength="25"></label></div><button type="button" data-action="contacts">Gửi mã xác minh email</button><div data-contact-confirm hidden><label>Mã nhận trong email mới<input name="contactCode" autocomplete="one-time-code" maxlength="6"></label><button type="button" data-action="contact-confirm">Xác minh và lưu liên hệ</button></div><p>Số điện thoại được xác nhận qua email; hệ thống chưa dùng SMS.</p></div></details>`:""}<details class="security-section"><summary>Xác thực hai yếu tố (2FA)<span>Chọn email hoặc ứng dụng xác thực</span></summary><div class="security-section-body"><label>Phương thức muốn sử dụng<select name="method"><option value="email">Mã qua email</option><option value="app">Ứng dụng xác thực</option></select></label><div class="security-actions"><button type="button" data-action="setup">Thiết lập phương thức</button>${data.method!=="off"&&!data.mfaRequired?`<button type="button" class="security-danger" data-action="disable">Tắt xác thực hai yếu tố</button>`:""}</div><div data-setup hidden></div></div></details>${!isCustomer?'<details class="security-section"><summary>Đăng nhập Google (OAuth)<span>Thiết lập Google Client ID xác thực khách hàng</span></summary><div class="security-section-body"><p>Khách hàng có thể đăng nhập hoặc tạo tài khoản GAERU tức thì bằng tài khoản Google an toàn.</p><div class="security-actions"><button type="button" class="secondary-button" data-action="oauth-goto">Mở cấu hình Đăng nhập Google ↗</button></div></div></details>':''}</form><div data-backup></div>`;
  root.innerHTML=isCustomer?customerMarkup:adminMarkup;
  for(const [name,selector] of [['password','[name=newPassword]'],['factor','[name=method]'],['support','[data-accordion-item=support]']]){const section=root.querySelector(selector)?.closest?.('.security-section');if(section)section.dataset.securitySection=name;}
  if(isCustomer){
    const identity=root.querySelector('.security-identity');if(identity)identity.hidden=true;
    const dialog=root.closest('.account-settings-dialog, [data-account-profile]')||root;
    const allItems=()=>dialog.querySelectorAll('.security-accordion-item');
    const updateHeaders=()=>{allItems().forEach(item=>{const h=item.querySelector('.security-accordion-header');if(h)h.classList.toggle('is-active',item.open);});};
    allItems().forEach(section=>{
      if(section._accBound)return;section._accBound=true;
      section.addEventListener('toggle',()=>{
        if(section.open){
          allItems().forEach(other=>{if(other!==section&&other.open)other.open=false;});
          const body=section.querySelector('.security-section-body');
          const initial=section.querySelector('[data-factor-initial]');
          const target=section.querySelector('[data-setup]');
          if(initial)initial.hidden=false;
          if(target){target.hidden=true;target.innerHTML='';}
          const sub=section.querySelector('.security-modal-subtitle');
          if(sub&&section.dataset.accordionItem==='factor')sub.textContent='Bảo vệ tài khoản bằng lớp bảo mật thứ hai khi đăng nhập';
          if(body?.querySelector('[data-action]')&&identity){const tc=initial||body.querySelector('.security-modal-inner')||body;tc.prepend(identity);identity.hidden=false;}
          else if(identity)identity.hidden=true;
        }
        updateHeaders();
      });
    });
    updateHeaders();
  } else {
    const identity=root.querySelector('.security-identity');if(identity)identity.hidden=true;
    root.querySelectorAll?.('.security-section')?.forEach(section=>section.addEventListener('toggle',()=>{if(section.open){root.querySelectorAll('.security-section').forEach(other=>{if(other!==section)other.open=false;});const body=section.querySelector('.security-section-body');if(body?.querySelector('[data-action]')){const tc=body.querySelector('.security-modal-inner')||body;tc.prepend(identity);identity.hidden=false;}else identity.hidden=true;}}));
  }
 if(data.isOwner&&!data.mfaEnrollmentRequired&&window.GAERUConfiguration)await window.GAERUConfiguration.mountProfile(root.querySelector('[data-owner-profile]'));const form=root.querySelector('form.security-form'),feedback=form.querySelector('[role=status]');form.addEventListener('submit',e=>e.preventDefault());root.querySelector('select').value=data.method==='app'||(!data.email&&data.mfaRequired)?'app':'email';
 root.addEventListener('click',async e=>{const button=e.target.closest('[data-action]');if(!button||!root.contains(button)||!form.isConnected)return;const action=button.dataset.action;if(action==='oauth-goto'){window.location.hash='#oauth';return;}
 if(action==='setup-back'){
   const factorSection=button.closest('[data-accordion-item=factor], [data-security-section=factor]')||root;
   const initial=factorSection.querySelector('[data-factor-initial]');
   if(initial)initial.hidden=false;
   const identity=root.querySelector('.security-identity');
   if(identity)identity.hidden=false;
   const target=factorSection.querySelector('[data-setup]');
   if(target){target.hidden=true;target.innerHTML='';}
   const sub=factorSection.querySelector('.security-modal-subtitle');
   if(sub)sub.textContent='Bảo vệ tài khoản bằng lớp bảo mật thứ hai khi đăng nhập';
   return;
 }button.disabled=true;feedback.textContent='Đang xử lý…';try{const payload={password:form.elements.password.value,factorCode:form.elements.factorCode?.value.trim(),factorChallengeId:challengeId};if(!payload.password&&action!=='confirm'&&action!=='contact-confirm')throw Object.assign(Error('Nhập mật khẩu hiện tại.'),{code:'CURRENT_PASSWORD_INVALID'});let result;

 if(action==='send'){result=await api('/authorize',payload);challengeId=result.challengeId;}
 if(action==='password'){if(form.elements.newPassword.value!==form.elements.confirmPassword.value)throw Error('Mật khẩu nhập lại chưa khớp.');result=await api('/password',{...payload,newPassword:form.elements.newPassword.value});}
 if(action==='contacts'){result=await api('/contacts/request',{...payload,email:form.elements.email.value,phone:form.elements.phone.value});contactChallenge=result.challengeId;root.querySelector('[data-contact-confirm]').hidden=false;}
 if(action==='contact-confirm')result=await api('/contacts/confirm',{challengeId:contactChallenge,code:form.elements.contactCode.value.trim()});
 if(action==='disable')result=await api('/disable',payload);
 if(action==='setup'){
  result=await api('/setup',{...payload,method:form.elements.method.value});
  setup=result;
  const factorSection=button.closest('[data-accordion-item=factor], [data-security-section=factor]')||root;
  const initial=factorSection.querySelector('[data-factor-initial]');
  if(initial)initial.hidden=true;
  const identity=root.querySelector('.security-identity');
  if(identity)identity.hidden=true;
  const sub=factorSection.querySelector('.security-modal-subtitle');
  if(sub)sub.textContent=setup.secret?'Quét mã QR và nhập mã xác thực để kích hoạt':'Nhập mã xác thực đã gửi qua email';
  const target=factorSection.querySelector('[data-setup]');
  if(target){
    target.hidden=false;
    target.innerHTML=setup.secret ? `
      <div class="security-qr-step-view">
        <p class="security-step2-instruction">Mở ứng dụng <strong>Google Authenticator</strong> hoặc tương thích, quét mã QR bên dưới:</p>
        <div class="security-qr-container">
          ${setup.qrDataUrl ? `<img src="${esc(setup.qrDataUrl)}" alt="Mã QR Authenticator" class="security-qr-code-img" width="180" height="180">` : ''}
        </div>
        <details class="security-manual-key-accordion">
          <summary>Không quét được mã? Nhập khóa thủ công</summary>
          <div class="security-manual-key-box">
            <input readonly value="${esc(setup.secret)}" autocomplete="off" spellcheck="false" class="security-manual-secret" aria-label="Khóa thiết lập thủ công">
            <small>Chọn "Khóa theo thời gian" (TOTP) trong ứng dụng xác thực.</small>
          </div>
        </details>
        <div class="security-otp-form-group">
          <label for="setupCodeInput" class="security-otp-label">Nhập mã xác nhận 6 số từ ứng dụng</label>
          <input id="setupCodeInput" name="setupCode" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" placeholder="000 000" class="security-otp-field" autofocus required>
          <p class="security-otp-help">Mã 6 chữ số thay đổi mỗi 30 giây trong ứng dụng.</p>
        </div>
        <div class="security-actions">
          <button type="button" class="button button-blue security-confirm-button" data-action="confirm" data-no-action-feedback>Xác nhận và bật 2FA</button>
          <button type="button" class="button button-secondary security-back-button" data-action="setup-back">← Quay lại đổi phương thức</button>
        </div>
      </div>
    ` : `
      <div class="security-qr-step-view">
        <p class="security-step2-instruction">${esc(result.message || 'Mã xác thực gồm 6 chữ số đã được gửi đến email của bạn. Vui lòng kiểm tra hộp thư.')}</p>
        <div class="security-otp-form-group">
          <label for="setupCodeInput" class="security-otp-label">Nhập mã xác nhận 6 số từ email</label>
          <input id="setupCodeInput" name="setupCode" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" placeholder="000 000" class="security-otp-field" autofocus required>
        </div>
        <div class="security-actions">
          <button type="button" class="button button-blue security-confirm-button" data-action="confirm" data-no-action-feedback>Xác nhận và bật 2FA</button>
          <button type="button" class="button button-secondary security-back-button" data-action="setup-back">← Quay lại đổi phương thức</button>
        </div>
      </div>
    `;
    const codeInp = target.querySelector('input[name=setupCode]');
    if (codeInp) {
      setTimeout(() => codeInp.focus(), 60);
      codeInp.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          target.querySelector('[data-action=confirm]')?.click();
        }
      });
    }
  }
}
 if(action==='confirm'){if(!setup)throw Error('Hãy thiết lập phương thức trước.');result=await api('/confirm',{method:setup.method,setupId:setup.setupId,challengeId:setup.challengeId,code:form.elements.setupCode.value.trim()});}
 if(result){if(action==='confirm'&&window.GAERUAdmin?.user?.mfaEnrollmentRequired)await window.GAERUAdmin.refreshSession();feedback.textContent=result.message||'Đã lưu.'; if(action!=='setup')showCenterPopup({type:'success',title:'Thành công',message:result.message||'Đã lưu thành công.'});if(['confirm','disable','password','contact-confirm'].includes(action)){const pItem=button.closest('.security-accordion-item');if(pItem)pItem.open=false;await render(root);root.querySelector('[role=status]').textContent=result.message;if(result.recoveryCodes){const box=root.querySelector('[data-backup]');box.innerHTML='<h4>Mã dự phòng — chỉ hiển thị lần này</h4><p>Lưu các mã ở nơi an toàn. Mỗi mã dùng một lần khi đăng nhập hoặc xác nhận thao tác bảo mật.</p><textarea readonly rows="8" aria-label="Mã dự phòng"></textarea>';box.querySelector('textarea').value=result.recoveryCodes.join('\n');}}}
 }catch(error){feedback.textContent=error.message;showCenterPopup({type:'error',title:'Thông báo',message:error.message});if(error.code==='CURRENT_PASSWORD_INVALID'){const input=form.elements.password;input.setAttribute('aria-invalid','true');input.focus({preventScroll:true});root.querySelector('.security-identity').scrollIntoView({behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});input.addEventListener('input',()=>input.removeAttribute('aria-invalid'),{once:true});}}finally{if(button.isConnected)button.disabled=false;}});
 root.dispatchEvent?.(new CustomEvent('gaeru:security-rendered',{bubbles:true}));
 }
  const mountCustomerSecurity=()=>{
    const profile=document.querySelector('[data-account-profile]');if(!profile||profile.hidden)return;
    const editor=profile.querySelector('.account-profile-editor')||profile.querySelector('[data-profile-form]')?.closest('details');if(!editor)return;
    const innerDetails=profile.querySelector('[data-profile-form]')?.closest('details');
    const group=editor.querySelector('[data-security-accordion-group]')||editor;
    if(editor.querySelector('[data-security-panel]'))return;
    const section=document.createElement('section');section.dataset.securityPanel='';section.id='account-security-section';section.innerHTML='<div class="security-settings"></div>';group.append(section);
    const load=()=>{if((editor.open||innerDetails?.open)&&!section.dataset.loaded){section.dataset.loaded='true';render(section.querySelector('div')).catch(error=>{section.querySelector('div').textContent=error.message;delete section.dataset.loaded;});}};
    editor.addEventListener('toggle',load);
    if(innerDetails&&innerDetails!==editor)innerDetails.addEventListener('toggle',load);
    load();window.dispatchEvent(new CustomEvent('gaeru:security-ready'));
  };const observer=new MutationObserver(mountCustomerSecurity);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden']});mountCustomerSecurity();
 window.GAERUSecurity={render,loginChallenge,api};
 const recovery=document.querySelector('[data-admin-recovery]');if(recovery){const query=new URLSearchParams(location.search),id=query.get('securityReset'),token=query.get('token');let factorChallengeId='';recovery.innerHTML=`<details ${id?'open':''}><summary>Quên tài khoản hoặc mật khẩu?</summary><form class="security-form">${id?'<label>Mật khẩu mới<input name="newPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="72"></label><label>Mã hai yếu tố hoặc mã dự phòng (nếu đã bật)<input name="factorCode" autocomplete="one-time-code" maxlength="32"></label><button type="button" data-recovery-code>Gửi mã hai yếu tố qua email</button>':'<label>Email đã xác minh<input name="email" type="email" required></label><label>Số điện thoại đã gắn<input name="phone" type="tel" required></label>'}<button type="submit">${id?'Đặt lại mật khẩu':'Gửi thông tin khôi phục'}</button><p role="status"></p></form></details>`;const form=recovery.querySelector('form'),status=form.querySelector('[role=status]');form.querySelector('[data-recovery-code]')?.addEventListener('click',async e=>{e.target.disabled=true;try{const r=await api('/recover/code',{id,token});factorChallengeId=r.challengeId;status.textContent=r.message;}catch(err){status.textContent=err.message;}finally{e.target.disabled=false;}});form.addEventListener('submit',async e=>{e.preventDefault();const b=form.querySelector('[type=submit]');b.disabled=true;try{const result=await api(id?'/recover/complete':'/recover/request',id?{id,token,newPassword:form.elements.newPassword.value,factorCode:form.elements.factorCode.value.trim(),factorChallengeId}:{email:form.elements.email.value,phone:form.elements.phone.value});status.textContent=result.message;if(id){history.replaceState(null,'',location.pathname);form.reset();}}catch(err){status.textContent=err.message;}finally{b.disabled=false;}});}
})();

document.addEventListener?.('click',e=>{
  const c=e?.target?.closest?.('[data-close-modal]');
  if(c){
    e.preventDefault?.();
    e.stopPropagation?.();
    const item=c.closest?.('.security-accordion-item');
    if(item)item.open=false;
  }
});
document.addEventListener?.('keydown',e=>{
  if(e.key==='Escape'){
    const item=document.querySelector?.('.security-accordion-item[open]');
    if(item)item.open=false;
  }
});
