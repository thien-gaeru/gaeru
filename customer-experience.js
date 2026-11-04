(() => {

  function showCenterPopup({ type = 'info', title = '', message = '' } = {}) {
    document.querySelectorAll('.gaeru-center-popup').forEach(p => {
      try { p.close?.(); } catch(e) {}
      p.remove();
    });
    document.querySelectorAll('.gaeru-action-notices, .gaeru-action-notice').forEach(n => n.remove());
    const isError = type === 'error' || /lỗi|không đúng|chưa hợp lệ|sai|thất bại/i.test(message);
    const isSuccess = type === 'success' || /thành công|đã cập nhật|đã lưu|đã đổi|đã gửi|đã bật|đã tắt/i.test(message);
    const actualType = isError ? 'error' : (isSuccess ? 'success' : 'info');
    const actualTitle = title || (isError ? 'Thông báo' : (isSuccess ? 'Thành công' : 'Thông báo'));
    const iconSvg = actualType === 'error'
      ? '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>'
      : actualType === 'success'
      ? '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
      : '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0071e3" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="8"></line></svg>';

    const dialog = document.createElement('dialog');
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


  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(path,method='GET',body,isCurrent=()=>true) {
    const checkSession=()=>{if(!isCurrent())throw Error('Phiên tài khoản đã thay đổi. Mở lại tài khoản để tiếp tục.');};
    checkSession();
    const headers={};
    if(method!=='GET'){const response=await fetch('/api/csrf',{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Error('Không thể khởi tạo phiên. Hãy thử lại.');const token=await response.json();checkSession();headers['X-CSRF-Token']=token.csrfToken;headers['Content-Type']='application/json';}
    const response=await fetch(path.startsWith('/api/')?path:'/api/customer'+path,{method,headers,credentials:'same-origin',...(body?{body:JSON.stringify(body)}:{})});
    checkSession();if(response.status===204)return null;const data=await response.json();checkSession();if(!response.ok)throw new Error(data.error||'Không thể lưu thay đổi.');return data;
  }
  async function showReturnRequest(orderId,isCurrent=()=>true) {
    const dialog=document.createElement('dialog');dialog.className='account-return-dialog';
    dialog.style.cssText='width:min(560px,calc(100% - 28px));max-height:90dvh;overflow:auto;border:1px solid #ddd;border-radius:22px;padding:24px';
    dialog.innerHTML='<form><h2>Yêu cầu đổi / trả hàng</h2><label>Hình thức<select name="returnType"><option value="exchange">Đổi sản phẩm</option><option value="refund">Trả hàng và hoàn tiền</option></select></label><label>Lý do<textarea name="reason" required minlength="5" maxlength="2000" rows="4"></textarea></label><fieldset data-return-bank hidden><legend>Tài khoản nhận hoàn tiền</legend><label>Ngân hàng<input name="bankName" maxlength="100"></label><label>Số tài khoản<input name="accountNumber" maxlength="50"></label><label>Chủ tài khoản<input name="accountHolder" maxlength="100"></label></fieldset><p role="status"></p><div style="display:flex;gap:12px;flex-wrap:wrap"><button class="button button-blue" type="submit">Gửi yêu cầu</button><button class="button button-outline" type="button" data-cancel>Quay lại</button></div></form>';
    dialog.querySelectorAll('label').forEach(e=>e.style.cssText='display:grid;gap:7px;margin:12px 0');dialog.querySelectorAll('input,select,textarea').forEach(e=>e.style.cssText='width:100%;box-sizing:border-box;min-height:44px;padding:10px;border:1px solid #c8ced8;border-radius:10px;font:inherit');
    const previous=document.activeElement;document.body.append(dialog);dialog.showModal();
    return new Promise(resolve=>{let done=false;const finish=value=>{if(done)return;done=true;dialog.close();dialog.remove();previous?.focus();resolve(value);};dialog.oncancel=e=>{e.preventDefault();finish(false);};dialog.querySelector('[data-cancel]').onclick=()=>finish(false);
      const form=dialog.querySelector('form');form.elements.returnType.onchange=()=>{dialog.querySelector('[data-return-bank]').hidden=form.elements.returnType.value!=='refund';};
      form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;try{await request('/orders/'+orderId+'/after-sales','POST',{returnType:form.elements.returnType.value,reason:form.elements.reason.value.trim(),bankInfo:{bankName:form.elements.bankName.value.trim(),accountNumber:form.elements.accountNumber.value.trim(),accountHolder:form.elements.accountHolder.value.trim()}},isCurrent);finish(true);}catch(error){form.querySelector('[role=status]').textContent=error.message;}finally{button.disabled=false;}};
    });
  }
  async function renderRmaCases(target,orderId,isCurrent=()=>true){
    const result=await request('/orders/'+orderId+'/after-sales','GET',undefined,isCurrent);if(!result.cases?.length)return;
    const caseLabels={requested:'Chờ duyệt đổi/trả',approved:'Đã duyệt gửi hàng',received:'Kho đã nhận hàng',resolved:'Đã hoàn tất đổi/trả',rejected:'Từ chối đổi/trả'},inboundLabels={pending_shipment:'Chờ gửi về kho',in_transit:'Đang gửi về kho',delivered_to_warehouse:'Kho đã nhận hàng'};
    const box=document.createElement('section');box.className='account-rma-cases';box.innerHTML='<h3>Đổi / trả và vận đơn gửi về</h3>';
    for(const item of result.cases){
      const card=document.createElement('article');card.style.cssText='padding:16px;border:1px solid #dce2e8;border-radius:16px;margin:12px 0;overflow-wrap:anywhere';
      card.innerHTML='<strong>'+escape(item.rmaNumber||'Yêu cầu hậu mãi')+'</strong><p>Trạng thái: '+escape(caseLabels[item.status]||'Đang xử lý')+' · '+escape(item.returnType==='exchange'?'Đổi sản phẩm':'Hoàn tiền')+'</p><p>'+escape(item.reason)+'</p>'+(item.resolution?'<p>Phản hồi: '+escape(item.resolution)+'</p>':'');
      if(item.rmaNumber){const full=await request('/api/rma/'+encodeURIComponent(item.rmaNumber),'GET',undefined,isCurrent);const rma=full.rma,warehouse=rma.inbound.warehouseAddress;
        card.insertAdjacentHTML('beforeend','<p>Gửi về: '+escape(warehouse.facility)+'<br>'+escape(warehouse.address)+'<br>'+escape(warehouse.contactPhone)+'</p><p data-rma-inbound-status>Chiều về kho: '+escape(inboundLabels[rma.inbound.status]||'Chưa có vận đơn')+(rma.inbound.trackingNumber?' · '+escape(rma.inbound.trackingNumber):'')+'</p>'+(rma.outbound.trackingNumber?'<p>Gửi lại cho bạn: '+escape(rma.outbound.carrier)+' · '+escape(rma.outbound.trackingNumber)+'</p>':''));
        if(!['resolved','rejected'].includes(item.status)){
          const form=document.createElement('form');form.innerHTML='<label>Đơn vị vận chuyển<input name="inboundCarrier" required minlength="2" maxlength="60"></label><label>Mã vận đơn gửi về<input name="inboundTrackingNumber" required minlength="4" maxlength="60"></label><button class="button button-blue" type="submit">Lưu vận đơn gửi về</button><p role="status"></p>';
          form.querySelectorAll('label').forEach(e=>e.style.cssText='display:grid;gap:7px;margin:12px 0');form.querySelectorAll('input').forEach(e=>e.style.cssText='width:100%;min-height:44px;box-sizing:border-box;border:1px solid #c8ced8;border-radius:10px;padding:10px;font:inherit');form.elements.inboundCarrier.value=item.inboundCarrier||'';form.elements.inboundTrackingNumber.value=item.inboundTrackingNumber||'';
          form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const saved=await request('/api/rma/'+encodeURIComponent(item.rmaNumber)+'/inbound','POST',{inboundCarrier:form.elements.inboundCarrier.value.trim(),inboundTrackingNumber:form.elements.inboundTrackingNumber.value.trim()},isCurrent);form.querySelector('[role=status]').textContent=saved.message;if(saved.rma)card.querySelector('[data-rma-inbound-status]').textContent='Chiều về kho: '+(inboundLabels[saved.rma.inboundStatus]||'Đang xử lý')+(saved.rma.inboundTrackingNumber?' · '+saved.rma.inboundTrackingNumber:'');}catch(error){form.querySelector('[role=status]').textContent=error.message;}finally{button.disabled=false;}};card.append(form);
        }
      }box.append(card);
    }target.append(box);
  }
  async function account() {
    const profile=document.querySelector('[data-account-profile]');if(!profile||profile.hidden)return;
    let section=profile.querySelector('[data-address-book]');if(section)return;
    const overviewCard=profile.querySelector('.account-overview-card');
    overviewCard?._gaeruAddressCleanup?.();
    const footer=overviewCard?.querySelector('.account-profile-footer');
    let addressBook=overviewCard?.querySelector('#account-addresses');
    if(overviewCard&&!addressBook){
      addressBook=document.createElement('div');
      addressBook.className='account-overview-addresses';
      addressBook.id='account-addresses';
      addressBook.innerHTML='<div class="account-section-heading"><div><p class="eyebrow">SỔ ĐỊA CHỈ</p><h3>Giao đến nơi bạn muốn.</h3></div></div><div data-address-list></div><details class="account-address-editor"><summary>Thêm địa chỉ giao hàng</summary><form class="account-form" data-address-form><label>Tên địa chỉ<input name="label" placeholder="Nhà riêng, văn phòng…" maxlength="60" required></label><label>Người nhận<input name="fullName" autocomplete="name" maxlength="120" required minlength="2"></label><label>Điện thoại<input name="phone" type="tel" autocomplete="tel" maxlength="20" placeholder="10 số di động (Ví dụ: 0912345678)" required></label><label>Địa chỉ chi tiết<input name="address" autocomplete="street-address" maxlength="250" minlength="5" required></label><label>Tỉnh / thành phố<input name="city" autocomplete="address-level1" maxlength="120" required minlength="2"></label><label class="account-consent"><input type="checkbox" name="isDefault"> Đặt làm địa chỉ mặc định</label><button class="button button-blue">Lưu địa chỉ</button></form></details><p role="status" data-address-status></p></div>';
      if(footer)footer.before(addressBook);else overviewCard.append(addressBook);
    }
    profile.querySelectorAll('#account-addresses, [data-address-list]').forEach(el => {
      if (!el.closest('.account-overview-card')) el.remove();
    });
    section=document.createElement('section');section.dataset.addressBook='';
    section.innerHTML='<section class="account-workspace-card account-tab-panel is-active" id="account-orders-section" data-account-tab-panel="orders"><div class="account-section-heading"><div><p class="eyebrow">LỊCH SỬ MUA HÀNG</p><h3>Đơn hàng của bạn</h3></div><a href="shop.html">Tiếp tục mua sắm ↗</a></div><p>Đơn đặt khi đăng nhập sẽ xuất hiện tại đây. Với đơn cũ, liên hệ GAERU và cung cấp mã đơn để được hỗ trợ.</p><div id="customer-orders" data-customer-orders></div><details class="account-history-more" data-order-history hidden><summary>Xem thêm đơn hàng</summary><div data-order-older></div><button type="button" data-orders-more hidden>Tải thêm đơn</button></details></section>';
    section.insertAdjacentHTML('beforeend','<section class="account-workspace-card account-tab-panel" id="account-warranties" data-account-tab-panel="warranties"><div class="account-section-heading"><div><p class="eyebrow">GAERU CARE+</p><h3>Sản phẩm đã đăng ký bảo hành</h3></div><a href="/dang-ky-bao-hanh">Đăng ký bảo hành ↗</a></div><div data-account-warranties></div><details class="account-history-more" data-warranty-history hidden><summary>Xem thêm bảo hành</summary><div data-warranty-older></div><button type="button" data-warranties-more hidden>Tải thêm hồ sơ</button></details><p role="status" data-warranty-status></p></section>');
    function compactHistory(type,reset){
      const list=section.querySelector(type==='order'?'[data-customer-orders]':'[data-account-warranties]');
      const more=section.querySelector('[data-'+type+'-history]'),older=section.querySelector('[data-'+type+'-older]');
      if(reset){older.replaceChildren();more.open=false;}
      const cards=[...list.children].filter(node=>node.tagName==='ARTICLE');
      // Subsequent pages are appended to the visible list; keep only the first two there.
      [...list.querySelectorAll(':scope > article')].slice(2).forEach(node=>older.append(node));
      more.hidden=!older.children.length&&section.querySelector(type==='order'?'[data-orders-more]':'[data-warranties-more]').hidden;
    }
    let warrantyPage=1;
    async function warranties(){const data=await workspaceRequest('/warranties?page='+warrantyPage);const states={pending:'Chờ đối chiếu',active:'Đã kích hoạt',rejected:'Không được xác nhận',revoked:'Đã thu hồi'};const date=v=>v?new Date(v+'T00:00:00').toLocaleDateString('vi-VN'):'Chưa xác nhận';section.querySelector('[data-account-warranties]').insertAdjacentHTML('beforeend',data.activations.map(w=>`<article class="account-warranty-compact"><strong title="${escape(w.productName)} ${escape(w.variantName)}">${escape(w.productName)} ${escape(w.variantName)}</strong><p title="${escape(w.orderNumber)}">${escape(states[w.status]||w.status)} · ${escape(w.orderNumber)}</p><p>Ngày mua: ${date(w.purchaseDate)} · Hạn: ${date(w.expiresOn)}</p></article>`).join('')||(warrantyPage===1?'<div class="account-empty-state"><strong>Chưa có sản phẩm đăng ký bảo hành.</strong><p>Đăng ký sản phẩm để GAERU đối chiếu thông tin mua hàng.</p></div>':''));section.querySelector('[data-warranties-more]').hidden=data.activations.length<20;compactHistory('warranty',warrantyPage===1);}
    section.querySelector('[data-warranties-more]').addEventListener('click',async e=>{const button=e.currentTarget;button.disabled=true;try{warrantyPage++;await warranties();}catch(error){warrantyPage--;section.querySelector('[data-warranty-status]').textContent=error.message;}finally{button.disabled=false;}});
    profile.append(section);let page=1, editingId=null, savedAddresses=[];
    section.className='customer-workspace';
    const isCurrent=()=>section.isConnected&&!profile.hidden;
    const workspaceRequest=(path,method='GET',body)=>request(path,method,body,isCurrent);
    warranties().catch(error=>{section.querySelector('[data-warranty-status]').textContent='Chưa tải được bảo hành: '+error.message;});
    const loyaltyCard = profile.querySelector('[data-account-loyalty-card]');
    if (loyaltyCard) {
      loyaltyCard.hidden = true;
      workspaceRequest('/loyalty').then(data => {
        if (isCurrent() && data?.loyalty) {
          loyaltyCard.hidden = false;
          const pts = loyaltyCard.querySelector('[data-loyalty-points]');
          const benefits=loyaltyCard.querySelector('[data-loyalty-benefits]');
          if(pts)pts.textContent=new Intl.NumberFormat('vi-VN').format(data.loyalty.pointsBalance);
          const tier=data.tierBenefits?.[data.loyalty.tier];
          if(benefits)benefits.textContent='1 Xu = 1 ₫. '+(tier?.earnRate?'Tích '+tier.earnRate+' cho đơn hoàn tất. ':'')+'Dùng tối đa 50% giá trị đơn khi thanh toán.';
        }
      }).catch(() => {});
    }
    
    const profileEditor=document.createElement('details');profileEditor.open=true;profileEditor.className='account-profile-editor';profileEditor.innerHTML='<summary hidden>Thông tin và bảo mật</summary><div class="account-security-accordion" data-security-accordion-group><details class="security-accordion-item security-section" data-accordion-item="profile" data-security-section="profile"><summary class="security-accordion-header"><span class="security-item-icon security-icon-profile" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></span><span class="security-item-titles"><strong>1. Thông tin cá nhân</strong><span>Họ tên, email, số điện thoại</span></span><span class="security-item-chevron" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></span></summary><div class="security-accordion-body security-section-body"><div class="security-modal-backdrop" data-close-modal></div><div class="security-modal-card"><div class="security-modal-header"><div class="security-modal-title-group"><span class="security-item-icon security-icon-profile" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></span><div><h3 class="security-modal-title">Thông tin cá nhân</h3><p class="security-modal-subtitle">Chỉnh sửa họ tên, email và số điện thoại liên hệ</p></div></div><button type="button" class="security-modal-close" data-close-modal aria-label="Đóng">✕</button></div><div class="security-modal-inner"><form class="account-form" data-profile-form><label>Họ và tên<input name="fullName" autocomplete="name" minlength="2" maxlength="120" required></label><label>Email<input name="email" type="email" autocomplete="email" maxlength="254" placeholder="Ví dụ: hotro@gaeru.com" required></label><label>Số điện thoại<input name="phone" type="tel" autocomplete="tel" maxlength="20" placeholder="10 số di động (Ví dụ: 0912345678)" required></label><label>Mật khẩu hiện tại<input name="currentPassword" type="password" autocomplete="current-password" maxlength="200"><span class="account-field-note">Cần nhập khi đổi email hoặc số điện thoại.</span></label><p class="account-field-note">Đổi số điện thoại: xác nhận qua email hiện tại. Đổi email: xác nhận tại cả hộp thư hiện tại và hộp thư mới. Thông tin cũ được giữ nguyên cho đến khi hoàn tất.</p><button class="button button-blue">Lưu thông tin</button><p role="status"></p></form></div></div></div></details></div>';
    const settingsPanel=document.createElement('section');settingsPanel.className='account-workspace-card account-tab-panel';settingsPanel.dataset.accountTabPanel='profile';settingsPanel.id='account-settings-card';settingsPanel.innerHTML='<div class="account-section-heading"><div><p class="eyebrow">CÀI ĐẶT BẢO MẬT</p><h3>Thông tin và bảo mật</h3><p>Chỉnh thông tin liên hệ, đổi mật khẩu và quản lý xác thực tài khoản.</p></div></div>';
    settingsPanel.append(profileEditor);
    section.append(settingsPanel);
    const settingsDialog=document.createElement('dialog');settingsDialog.className='account-settings-dialog';settingsDialog.dataset.accountSettingsDialog='';settingsDialog.setAttribute('aria-labelledby','account-settings-title');settingsDialog.innerHTML='<header><h2 id="account-settings-title">Thông tin và bảo mật</h2><button type="button" data-settings-close aria-label="Đóng cài đặt">×</button></header><nav aria-label="Mục cài đặt" hidden><button type="button" data-settings-jump="profile">Thông tin cá nhân</button><button type="button" data-settings-jump="password">Mật khẩu</button><button type="button" data-settings-jump="factor">Xác thực 2 bước</button></nav><div class="account-settings-content"></div>';
    section.append(settingsDialog);
    const openSettings=()=>{if(!settingsDialog.isConnected||profile.hidden)return;if(!settingsDialog.open){if(settingsDialog.showModal)settingsDialog.showModal();else settingsDialog.open=true;profileEditor.open=true;}};
    let pendingSettingsJump='';
    function jumpToSettings(name){
      const pForm=profileEditor.querySelector('[data-profile-form]');
      if(pForm) pForm.hidden=name!=='profile';
      const target=name==='profile'?(profileEditor.querySelector('[data-accordion-item="profile"]')||pForm):profileEditor.querySelector('[data-security-section="'+name+'"]');
      if(!target){pendingSettingsJump=name;return;}
      pendingSettingsJump='';
      const allSections=document.querySelectorAll('.security-section');
      allSections.forEach(s=>{
        if(s!==target && name!=='all'){
          s.hidden=true;
          if(s.tagName==='DETAILS')s.open=false;
        } else {
          s.hidden=false;
        }
      });
      if(target.tagName==='DETAILS')target.open=true;
      target.scrollIntoView({block:'start',behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
      (target.querySelector('input:not([type=hidden]),select')||target).focus?.({preventScroll:true});
    }
    settingsDialog.querySelector('[data-settings-close]').onclick=()=>settingsDialog.close();settingsDialog.addEventListener('close',()=>{pendingSettingsJump='';settingsDialog.querySelectorAll('input[type=password],input[autocomplete=one-time-code]').forEach(input=>input.value='');});
    document.addEventListener('click',event=>{const button=event.target.closest('[data-settings-jump]');if(button)jumpToSettings(button.dataset.settingsJump);});
    window.addEventListener('gaeru:security-rendered',()=>{if(pendingSettingsJump)jumpToSettings(pendingSettingsJump);});
    window.GAERUAccountSettings={open:openSettings,close:()=>settingsDialog.close()};

    const profileForm=profileEditor.querySelector('form');profileForm.elements.fullName.value=profile.querySelector('[data-customer-name]').textContent;profileForm.elements.phone.value=profile.querySelector('[data-customer-phone]').textContent;profileForm.elements.email.value=profile.querySelector('[data-customer-email]').textContent;
    profileForm.addEventListener('submit',async e=>{
      e.preventDefault();const button=profileForm.querySelector('button'),feedback=profileForm.querySelector('[role=status]');
      button.disabled=true;feedback.textContent='Đang xử lý…';feedback.style.color='';let pendingMessage='';
      try {
        const values=Object.fromEntries(new FormData(profileForm));
        const email=values.email.trim().toLowerCase(),phone=values.phone.trim();
        const changed=email!==profile.querySelector('[data-customer-email]').textContent||phone!==profile.querySelector('[data-customer-phone]').textContent;
        if(changed){
          if(!values.currentPassword)throw Error('Nhập mật khẩu hiện tại để yêu cầu đổi email hoặc số điện thoại.');
          const confirmation=await workspaceRequest('/api/customer-auth/contact-change/request','POST',{email,phone,password:values.currentPassword});
          pendingMessage=confirmation.message;
        }
        const payload={fullName:values.fullName};
        if(values.currentPassword&&values.currentPassword.trim())payload.currentPassword=values.currentPassword;
        const result=await workspaceRequest('/profile','PATCH',payload);
        if(!isCurrent())return;
        profile.querySelector('[data-customer-name]').textContent=result.customer.fullName;
        window.GAERUCustomerSession?.set(result.customer);
        const successMsg=pendingMessage||'Đã cập nhật thông tin thành công.';feedback.textContent=successMsg;feedback.style.color='#16a34a';window.GAERUPopup?.show({type:'success',title:'Thành công',message:successMsg}); const mItem=profileForm.closest('.security-accordion-item'); if(mItem)mItem.open=false;
        if(pendingMessage){
          profileForm.elements.email.value=profile.querySelector('[data-customer-email]').textContent;
          profileForm.elements.phone.value=profile.querySelector('[data-customer-phone]').textContent;
        }
      }catch(error){
        const errorMsg=(pendingMessage?pendingMessage+' ':'')+error.message;feedback.textContent=errorMsg;feedback.style.color='#dc2626';window.GAERUPopup?.show({type:'error',title:'Thông báo',message:errorMsg});
        if(error.message.includes('mật khẩu')||error.message.includes('Mật khẩu')){
          profileForm.elements.currentPassword?.setAttribute('aria-invalid','true');
          profileForm.elements.currentPassword?.focus();
        }
      }
      finally{profileForm.elements.currentPassword.value='';button.disabled=false;}
    });
    profileForm.elements.currentPassword?.addEventListener('input',()=>profileForm.elements.currentPassword.removeAttribute('aria-invalid'));
    const addressForm=profile.querySelector('[data-address-form]');const addressSubmit=addressForm.querySelector('button[type="submit"],button:not([type])');const cancelEdit=document.createElement('button');cancelEdit.type='button';cancelEdit.textContent='Hủy chỉnh sửa';cancelEdit.hidden=true;addressForm.append(cancelEdit);cancelEdit.addEventListener('click',()=>{editingId=null;addressForm.reset();addressSubmit.textContent='Lưu địa chỉ';cancelEdit.hidden=true;});
    let addressDialog=overviewCard.querySelector('[data-address-dialog]');
    if(!addressDialog){
      const old=addressForm.closest('details'),opener=document.createElement('button');opener.type='button';opener.className='text-link account-add-address-link';opener.dataset.addAddress='';opener.innerHTML='Thêm địa chỉ giao hàng <span aria-hidden="true">↗</span>';opener.setAttribute('aria-haspopup','dialog');
      addressDialog=document.createElement('dialog');addressDialog.dataset.addressDialog='';addressDialog.className='account-address-dialog';addressDialog.setAttribute('aria-labelledby','address-dialog-title');
      addressDialog.innerHTML='<header><h2 id="address-dialog-title">Địa chỉ giao hàng</h2><button type="button" data-address-close aria-label="Đóng">×</button></header><p role="status" data-address-dialog-status></p>';
      addressDialog.append(addressForm);old.before(opener,addressDialog);old.remove();
    }
    const openAddress=()=>{if(!addressDialog.open)addressDialog.showModal?.();addressForm.elements.fullName.focus();};
    const closeAddress=()=>addressDialog.close?.();
    const addAddress=()=>{cancelEdit.click();addressDialog.querySelector('[role=status]').textContent='';openAddress();};
    const opener=overviewCard.querySelector('[data-add-address]'),closer=addressDialog.querySelector('[data-address-close]');
    opener.addEventListener('click',addAddress);closer.addEventListener('click',closeAddress);
    const status=profile.querySelector('[data-address-status]');status.textContent='';
    profile.querySelector('[data-address-list]').replaceChildren();
    async function addresses(){const data=await workspaceRequest('/addresses');if(!isCurrent())return;savedAddresses=data.addresses;profile.querySelector('[data-address-list]').innerHTML=data.addresses.map(a=>`<article><strong>${escape(a.label)}${a.isDefault?' · Mặc định':''}</strong><p>${escape(a.fullName)} · ${escape(a.phone)}<br>${escape(a.address)}, ${escape(a.city)}</p><button type="button" data-edit-address="${a.id}">Sửa địa chỉ</button> ${a.isDefault?'':`<button type="button" data-default="${a.id}">Chọn mặc định</button>`} <button type="button" data-remove="${a.id}">Xóa địa chỉ</button></article>`).join('')||'<div class="account-empty-state"><strong>Chưa có địa chỉ giao hàng</strong><p>Thêm địa chỉ thường dùng để đặt hàng nhanh hơn.</p></div>';}
    const states={pending:'Chờ xác nhận',confirmed:'Đã xác nhận',processing:'Đang chuẩn bị',shipped:'Đang giao',completed:'Hoàn tất',cancelled:'Đã hủy'},afterSalesLabels={requested:'Chờ duyệt đổi/trả',approved:'Đã duyệt gửi hàng',received:'Kho đã nhận hàng',resolved:'Đã hoàn tất đổi/trả',rejected:'Từ chối đổi/trả'};
    async function orders(){const data=await workspaceRequest('/orders?page='+page);section.querySelector('[data-customer-orders]').insertAdjacentHTML('beforeend',data.orders.map(o=>`<article data-order-card="${escape(o.id)}"><strong>${escape(o.orderNumber)}</strong><p>${escape(states[o.status]||o.status)} · ${o.paymentStatus==='paid'?'Đã thanh toán':'Chờ thanh toán'} · ${o.totalVnd===null?'Chờ xác nhận tổng tiền':new Intl.NumberFormat('vi-VN').format(o.totalVnd)+' ₫'}${o.cancellationReason?`<br><small style="color:#ef4444;">Lý do hủy: ${escape(o.cancellationReason)}</small>`:''}${o.afterSales?`<br><span style="display:inline-block;margin-top:4px;font-size:11px;background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:4px;font-weight:600;">Yêu cầu đổi/trả: ${escape(afterSalesLabels[o.afterSales.status]||o.afterSales.status)}</span>`:""}</p><div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap;"><button type="button" data-order-detail="${o.id}">Xem chi tiết</button>${(o.status==='pending'&&o.paymentStatus!=='paid')?`<button type="button" data-cancel-order="${o.id}" class="button-cancel-order" style="color:#dc2626;border:1px solid #fca5a5;background:transparent;border-radius:6px;padding:4px 10px;cursor:pointer;">Hủy đơn</button>`:""}${(['shipped','completed'].includes(o.status)&&!o.afterSales)?`<button type="button" data-return-order="${o.id}" class="button-return-order" style="color:#0071e3;border:1px solid #93c5fd;background:transparent;border-radius:6px;padding:4px 10px;cursor:pointer;">Đổi / Trả hàng</button>`:""}</div><div data-detail-for="${o.id}" hidden></div></article>`).join('')|| (page===1?'<div class="account-empty-state"><strong>Hành trình mua sắm bắt đầu từ đây.</strong><p>Các đơn hàng mới sẽ được lưu trong tài khoản của bạn.</p><a href="shop.html">Khám phá cửa hàng ↗</a></div>':''));section.querySelector('[data-orders-more]').hidden=data.orders.length<20;compactHistory('order',page===1);}
    let addressSaving=false;const saveAddress=async e=>{e.preventDefault();if(addressSaving)return;addressSaving=true;const button=addressSubmit;button.disabled=true;try{const values=Object.fromEntries(new FormData(e.target));values.isDefault=e.target.elements.isDefault.checked;values.address=window.GAERUAddress?.getAddress(e.target)||values.address;await workspaceRequest(editingId?'/addresses/'+editingId:'/addresses',editingId?'PUT':'POST',values);cancelEdit.click();await addresses();closeAddress();status.textContent='Đã lưu địa chỉ.';}catch(error){if(isCurrent()){status.textContent=error.message;addressDialog.querySelector('[role=status]').textContent=error.message;}}finally{if(isCurrent())button.disabled=false;addressSaving=false;}};addressForm.addEventListener('submit',saveAddress);
    const addressAction=async e=>{
      const edit=e.target.closest('[data-edit-address]');if(edit){const a=savedAddresses.find(a=>a.id===edit.dataset.editAddress);if(!a)return;editingId=a.id;openAddress();for(const name of ['label','fullName','phone','address','city'])(name==='city'&&window.GAERUAddress?window.GAERUAddress.setValue(addressForm.elements[name],a[name]):addressForm.elements[name].value=a[name]);window.GAERUAddress?.setAddress(addressForm,{address:a.address,city:a.city});addressForm.elements.isDefault.checked=a.isDefault;addressSubmit.textContent='Cập nhật địa chỉ';cancelEdit.hidden=false;addressForm.elements.address.focus();return;}
      const button=e.target.closest('button[data-default],button[data-remove]');if(button){button.disabled=true;try{if(button.dataset.default)await workspaceRequest('/addresses/'+button.dataset.default+'/default','POST');else await workspaceRequest('/addresses/'+button.dataset.remove,'DELETE');await addresses();status.textContent='Đã cập nhật sổ địa chỉ.';}catch(error){if(isCurrent())status.textContent=error.message;button.disabled=false;}}
    };overviewCard?.addEventListener('click',addressAction);
    if(overviewCard)overviewCard._gaeruAddressCleanup=()=>{addressForm.removeEventListener('submit',saveAddress);overviewCard.removeEventListener('click',addressAction);cancelEdit.remove();opener.removeEventListener('click',addAddress);closer.removeEventListener('click',closeAddress);closeAddress();addressForm.reset?.();addressSubmit.disabled=false;addressSubmit.textContent='Lưu địa chỉ';};
    section.addEventListener('click',async e=>{
      const returnBtn=e.target.closest('[data-return-order]');if(returnBtn){const orderId=returnBtn.dataset.returnOrder;returnBtn.disabled=true;try{const elig=await workspaceRequest('/orders/'+orderId+'/after-sales/eligibility');if(!elig.eligible){if(window.alert)window.alert(elig.reason||'Đơn hàng không đủ điều kiện đổi/trả.');return;}const submitted=await showReturnRequest(orderId,isCurrent);if(!submitted)return;page=1;section.querySelector('[data-customer-orders]').innerHTML='';await orders();}catch(err){if(window.alert)window.alert(err.message||'Không thể gửi yêu cầu đổi/trả.');}finally{returnBtn.disabled=false;}return;}
      const cancelBtn=e.target.closest('[data-cancel-order]');if(cancelBtn){const orderId=cancelBtn.dataset.cancelOrder;const reason=window.prompt?window.prompt('Nhập lý do hủy đơn (hoặc bấm OK để tiếp tục):','Đổi ý không muốn mua nữa'):'Khách hủy';if(reason===null)return;cancelBtn.disabled=true;try{const res=await workspaceRequest('/orders/'+orderId+'/cancel','POST',{reason:reason||'Khách hủy đơn'});if(window.alert)window.alert(res?.message||'Đã hủy đơn hàng thành công.');page=1;section.querySelector('[data-customer-orders]').innerHTML='';await orders();}catch(err){if(window.alert)window.alert(err.message||'Không thể hủy đơn.');}finally{cancelBtn.disabled=false;}return;}
      const button=e.target.closest('[data-order-detail]');if(!button)return;const target=button.closest('[data-order-card]')?.querySelector('[data-detail-for]');if(!target||target.dataset.detailFor!==button.dataset.orderDetail){status.textContent='Chưa mở được chi tiết đơn. Vui lòng tải lại trang.';return;}if(!target.hidden){target.hidden=true;button.textContent='Xem chi tiết';button.setAttribute('aria-expanded','false');return;}button.disabled=true;try{const {order}=await workspaceRequest('/orders/'+button.dataset.orderDetail);const money=n=>n===null?'Chờ xác nhận':new Intl.NumberFormat('vi-VN').format(n)+' ₫';target.innerHTML=`<p>${escape(order.customerName)} · ${escape(order.phone)}<br>${escape(order.address)}, ${escape(order.city)}</p><p>Đặt ngày ${escape(new Date(order.createdAt).toLocaleDateString('vi-VN'))} · ${escape({cod:'Thanh toán khi nhận hàng',vnpay:'VNPAY',bank_transfer:'Chuyển khoản',}[order.paymentMethod]||order.paymentMethod)}</p><ul>${order.items.map(i=>`<li>${escape(i.productName)} · ${escape(i.variantName)} × ${i.quantity}<br>${money(i.lineTotalVnd)}</li>`).join('')}</ul><p>Tạm tính: ${money(order.subtotalVnd)}${order.discountVnd?`<br>Voucher ${escape(order.voucherCode)}: −${money(order.discountVnd)}`:""}<br>Phí giao hàng: ${money(order.shippingFeeVnd)}<br><strong>Tổng: ${money(order.totalVnd)}</strong></p>${(order.status==='pending'&&order.paymentStatus!=='paid')?`<p style="margin-top:12px;padding-top:12px;border-top:1px dashed #e5e7eb;"><button type="button" data-cancel-order="${order.id}" style="color:#dc2626;border:1px solid #fca5a5;background:transparent;border-radius:6px;padding:6px 14px;cursor:pointer;">Hủy đơn hàng này</button></p>`:""}`;target.hidden=false;button.textContent='Thu gọn';button.setAttribute('aria-expanded','true');await renderRmaCases(target,button.dataset.orderDetail,isCurrent);}catch(error){status.textContent=error.message;}finally{button.disabled=false;}
    });
    section.querySelector('[data-orders-more]').addEventListener('click',async e=>{const button=e.currentTarget;button.disabled=true;try{page++;await orders();}catch(error){page--;status.textContent=error.message;}finally{button.disabled=false;}});
    const results=await Promise.allSettled([addresses(),orders()]);if(!isCurrent())return;for(let i=0;i<results.length;i++)if(results[i].status==='rejected'){const message=document.createElement('p');message.setAttribute('role','status');message.textContent=(i===0?'Chưa tải được địa chỉ: ':'Chưa tải được đơn hàng: ')+results[i].reason.message;(i===0?profile.querySelector('[data-address-list]'):section.querySelector('[data-customer-orders]')).append(message);}
    window.dispatchEvent(new CustomEvent('gaeru:workspace-ready'));
  }
  async function checkout(){if(window.GAERUCheckout)return;const form=document.querySelector('#checkout-form');if(!form||form.dataset.addressReady)return;form.dataset.addressReady='true';try{const response=await fetch('/api/customer-auth/me');const session=await response.json();if(!session.authenticated)return;const {addresses}=await request('/addresses');if(!document.contains(form))return;const customer=session.customer;
    for(const [name,value] of Object.entries({name:customer.fullName,email:customer.email,phone:customer.phone}))if(!form.elements[name].value)form.elements[name].value=value||'';
    const label=document.createElement('label');label.textContent='Dùng địa chỉ đã lưu';const select=document.createElement('select');select.innerHTML='<option value="">Nhập địa chỉ khác</option>'+addresses.map(a=>`<option value="${a.id}">${escape(a.label)} · ${escape(a.address)}</option>`).join('');label.append(select);form.querySelectorAll('.form-section')[1].prepend(label);
    select.addEventListener('change',()=>{const a=addresses.find(a=>a.id===select.value);if(!a)return;form.elements.name.value=a.fullName;form.elements.phone.value=a.phone;form.elements.address.value=a.address;form.elements.city.value=[...form.elements.city.options].some(o=>o.value===a.city)?a.city:'';window.GAERUAddress?.setAddress(form,{address:a.address,city:a.city});form.elements.city.dispatchEvent(new Event('change',{bubbles:true}));});const initial=addresses.find(a=>a.isDefault);if(initial&&!form.elements.address.value){select.value=initial.id;select.dispatchEvent(new Event('change'));}
    const link=document.createElement('a');link.href='account.html';link.textContent='Thêm hoặc quản lý địa chỉ';label.append(link);
  }catch{ /* Checkout remains usable when account service is unavailable. */ }}
  const observer=new MutationObserver(()=>{account();checkout();});observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden']});account();checkout();
})();
