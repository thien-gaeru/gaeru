(() => {
  const section = document.querySelector('#warranty-activation');
  if (!section) return;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const channels = {website:'Website GAERU',shopee:'Shopee',tiktok:'TikTok Shop',lazada:'Lazada'};
  // 34 province-level units under Resolution 202/2025/QH15.
  const provinces = ['Hà Nội','Hải Phòng','Huế','Đà Nẵng','Hồ Chí Minh','Cần Thơ','An Giang','Bắc Ninh','Cà Mau','Cao Bằng','Đắk Lắk','Điện Biên','Đồng Nai','Đồng Tháp','Gia Lai','Hà Tĩnh','Hưng Yên','Khánh Hòa','Lai Châu','Lâm Đồng','Lạng Sơn','Lào Cai','Nghệ An','Ninh Bình','Phú Thọ','Quảng Ngãi','Quảng Ninh','Quảng Trị','Sơn La','Tây Ninh','Thái Nguyên','Thanh Hóa','Tuyên Quang','Vĩnh Long'].sort((a,b)=>a.localeCompare(b,'vi'));
  const cityKey=value=>String(value||'').trim().normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/đ/g,'d').replace(/^(?:tinh|thanh pho|tp)\.?\s*/,'').trim();
  section.innerHTML = `
    <details class="care-surface warranty-surface care-disclosure" data-w-disclosure>
      <summary><div><p class="eyebrow">GAERU CARE+</p><h2>Kích hoạt bảo hành</h2></div><span aria-hidden="true">+</span></summary><div class="care-disclosure-body">
      <p class="warranty-intro-note">Đơn website tự động kích hoạt khi hoàn tất và thanh toán đủ. Với đơn chưa có hồ sơ, điền thông tin bên dưới. Bảo hành 12 tháng tính từ ngày mua được xác nhận.</p>
      <p data-w-session role="status">Đang kiểm tra tài khoản…</p>
      <form id="warranty-form">
        <label>Nơi mua hàng<select name="source" required>
          <option value="account" disabled>Đơn trong tài khoản GAERU</option>
          <option value="website" selected>Đơn website chưa có trong tài khoản</option>
          <option value="shopee">Shopee</option><option value="tiktok">TikTok Shop</option><option value="lazada">Lazada</option>
        </select></label>
        <fieldset data-w-account hidden disabled>
          <legend>Đơn hàng trong tài khoản</legend>
          <label>Đơn hàng<select name="orderId" required><option value="">Chọn đơn của bạn</option></select></label>
          <button type="button" class="care-plain" data-w-orders hidden>Tải thêm đơn hàng</button>
          <label>Sản phẩm đã mua<select name="orderItemId" required disabled><option value="">Chọn đơn hàng trước</option></select></label>
        </fieldset>
        <fieldset data-w-external>
          <legend>Thông tin mua hàng</legend>
          <label><span data-w-order-label>Mã đơn hàng website</span><input name="externalOrderNumber" minlength="3" maxlength="100" autocomplete="off" required></label>
          <label>Ngày mua trên chứng từ<input name="purchaseDate" type="date" min="2000-01-01" max="${new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}" required></label>
          <label>Sản phẩm / phiên bản đã mua<input name="productName" minlength="2" maxlength="200" placeholder="Ví dụ: GAERU K9 · Bộ 1 Mic · Type-C" required></label>
          <p class="care-field-note">Nhập mã đơn theo lịch sử mua hàng của kênh đã chọn. Hồ sơ cần được GAERU đối chiếu; chưa kết nối xác minh tự động với sàn.</p>
        </fieldset>
        <fieldset class="warranty-contact">
          <legend>Thông tin người đăng ký</legend>
          <p class="care-field-note">Thông tin được tự điền khi có địa chỉ đã lưu hoặc khi chọn đơn website. Bạn có thể sửa trước khi gửi.</p>
          <div class="warranty-contact-row">
            <label>Họ và tên<input name="fullName" minlength="2" maxlength="120" autocomplete="name" required></label>
            <label>Số điện thoại<input name="phone" type="tel" minlength="8" maxlength="25" autocomplete="tel" required></label>
          </div>
          <label>Email nhận thông báo<input name="email" type="email" maxlength="254" autocomplete="email" required></label>
          <div class="warranty-contact-row">
            <label>Địa chỉ liên hệ<input name="address" minlength="5" maxlength="250" autocomplete="street-address" placeholder="Số nhà, đường, phường/xã" required></label>
            <label>Tỉnh / thành phố<select name="city" autocomplete="address-level1" aria-describedby="warranty-city-note" required><option value="">Chọn tỉnh / thành phố</option>${provinces.map(name=>`<option value="${escape(name)}">${escape(name)}</option>`).join('')}</select></label>
          </div>
          <p class="care-field-note" id="warranty-city-note" data-w-city-note hidden></p>
        </fieldset>
        <p class="care-field-note">Mỗi lần đăng ký tương ứng một sản phẩm. Thông tin được xử lý theo <a href="privacy.html">chính sách quyền riêng tư</a>.</p>
        <button class="button button-blue" type="submit" disabled>Đăng ký kích hoạt</button><button class="care-plain" type="button" data-w-cancel-edit hidden>Hủy chỉnh sửa</button>
        <p role="status" aria-live="polite" data-w-status></p>
      </form>
    </div></details>
    <div class="care-surface warranty-history" data-w-history hidden>
      <h3>Hồ sơ bảo hành của bạn</h3><p class="care-field-note">Nếu chưa đăng nhập, hãy dùng cùng trình duyệt để xem và chỉnh sửa hồ sơ đã gửi.</p><div data-w-list></div>
      <div class="care-pagination"><button class="care-plain" type="button" data-w-page="-1" disabled>Trước</button><span data-w-page-label>Trang 1</span><button class="care-plain" type="button" data-w-page="1" disabled>Tiếp</button><button class="care-plain" type="button" data-w-page="0">Tải lại</button></div>
    </div>`;
  const disclosure=section.querySelector('[data-w-disclosure]');
  if(section.dataset?.standalone==='true')disclosure.open=true;
  function openActivation(){disclosure.open=true;}
  function openFromHash(){if(location.hash==='#warranty-activation')openActivation();}
  window.addEventListener('hashchange',openFromHash);
  document.addEventListener('click',event=>{if(event.target.closest('a[href="#warranty-activation"]'))openActivation();});
  openFromHash();
  const form=section.querySelector('form'),feedback=section.querySelector('[data-w-status]');
  let page=1,orderPage=1,sequence=0,key=null,serialized=null,customer=null,editing=null,rows=[];
  let guestTokens={};try{const saved=JSON.parse(localStorage.getItem('gaeru-warranty-tokens')||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))guestTokens=Object.fromEntries(Object.entries(saved).filter(([id,token])=>/^[a-f0-9-]{36}$/.test(id)&&typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)));}catch{}
  function storeToken(id,token){guestTokens[id]=token;try{localStorage.setItem('gaeru-warranty-tokens',JSON.stringify(guestTokens));}catch{}}

  async function api(url,method='GET',body) {
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    try {
      const headers={};const requestId=url.match(/^\/api\/warranty-requests\/([a-f0-9-]+)$/)?.[1];if(requestId&&guestTokens[requestId])headers['X-Warranty-Token']=guestTokens[requestId];
      if(method!=='GET'){
        const response=await fetch('/api/csrf',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
        if(!response.ok)throw Error('Không thể khởi tạo phiên. Hãy tải lại trang.');
        headers['X-CSRF-Token']=(await response.json()).csrfToken;headers['Content-Type']='application/json';
      }
      const response=await fetch(url,{method,headers,credentials:'same-origin',cache:'no-store',signal:controller.signal,...(body?{body:JSON.stringify(body)}:{})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw Error(data.error||'Không thể tải hồ sơ bảo hành.');
      return data;
    } catch(error) {
      if(error.name==='AbortError')throw Error('Máy chủ phản hồi quá lâu. Hãy thử lại để kiểm tra kết quả đăng ký.');
      throw error;
    } finally {clearTimeout(timeout);}
  }
  function fillContact(data,overwrite=true) {
    for(const [name,value] of Object.entries({fullName:data.fullName||data.customerName,email:data.email,phone:data.phone,address:data.address,city:data.city}))
      if(value&&form.elements[name]&&(overwrite||!form.elements[name].value)){
        if(name==='city'){
          const canonical=provinces.find(province=>cityKey(province)===cityKey(value));
          form.elements.city.value=canonical||'';
          const note=section.querySelector('[data-w-city-note]');
          note.hidden=Boolean(canonical);
          note.textContent=canonical?'':'Tỉnh/thành phố đã lưu: '+value+'. Vui lòng chọn đơn vị hành chính hiện hành.';
        }else form.elements[name].value=value;
      }
  }
  form.elements.city.addEventListener('change',()=>{section.querySelector('[data-w-city-note]').hidden=true;});
  function changeSource() {
    const account=form.elements.source.value==='account';
    for(const [selector,enabled] of [['[data-w-account]',account],['[data-w-external]',!account]]){
      const fieldset=section.querySelector(selector);fieldset.hidden=!enabled;fieldset.disabled=!enabled;
    }
    section.querySelector('[data-w-order-label]').textContent='Mã đơn hàng '+(channels[form.elements.source.value]||'website');
    form.querySelector('[type=submit]').disabled=account;feedback.textContent=account?'Đơn website tự động kích hoạt khi hoàn tất và thanh toán. Xem hồ sơ bảo hành bên dưới; không cần gửi đăng ký.':'';key=null;serialized=null;
  }
  async function orders() {
    const data=await api('/api/customer/orders?page='+orderPage);
    for(const order of data.orders) {
      if(order.status==='cancelled')continue;
      const option=document.createElement('option');option.value=order.id;option.textContent=order.orderNumber;form.elements.orderId.append(option);
    }
    section.querySelector('[data-w-orders]').hidden=data.orders.length<20;
    if(orderPage===1&&form.elements.orderId.options.length===1)feedback.textContent='Chưa có đơn trong tài khoản. Bạn có thể chọn kênh mua khác và nhập mã đơn để đối chiếu.';
  }
  const labels={pending:'Chờ xác nhận',active:'Đã kích hoạt',rejected:'Chưa được duyệt',revoked:'Đã thu hồi'};
  async function list() {
    let data=await api((customer?'/api/customer/warranties':'/api/warranty-requests')+'?page='+page);
    if(Object.keys(guestTokens).length){const recovered=await Promise.allSettled(Object.keys(guestTokens).reverse().slice((page-1)*20,page*20).map(id=>api('/api/warranty-requests/'+id)));const merged=new Map(data.activations.map(w=>[w.id,w]));for(const r of recovered)if(r.status==='fulfilled')merged.set(r.value.activation.id,r.value.activation);data.activations=[...merged.values()].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));}
    rows=data.activations;
    section.querySelector('[data-w-list]').innerHTML=data.activations.map(w=>`<article class="care-case"><span class="care-status">${w.status==='active'&&w.expiresOn<=data.today?'Đã hết hạn':escape(w.automatic&&w.status==='pending'?'Chờ đơn hoàn tất và thanh toán':labels[w.status])}</span><h4>${escape(w.productName)}${w.variantName?' · '+escape(w.variantName):''}</h4><p>${escape(channels[w.channel]||'Website GAERU')} · Đơn: ${escape(w.orderNumber)}${w.serial?'<br>Serial: '+escape(w.serial):''}<br>Mã hồ sơ: ${escape(w.id)}</p>${w.purchaseDate?`<p>Ngày mua đã xác nhận: ${escape(w.purchaseDate)}<br>Ngày kết thúc thời hạn: ${escape(w.expiresOn)} (giờ Việt Nam)</p>`:'<p>Thời hạn sẽ hiển thị sau khi GAERU đối chiếu ngày mua.</p>'}${w.reason?`<p>${escape(w.reason)}</p>`:''}${!w.automatic&&['pending','rejected'].includes(w.status)?`<div class="warranty-request-actions"><button type="button" class="care-plain" data-w-edit="${escape(w.id)}">Sửa và gửi lại</button><button type="button" class="care-plain" data-w-delete="${escape(w.id)}">Xóa yêu cầu</button></div><div data-w-delete-confirm="${escape(w.id)}"></div>`:''}</article>`).join('')||'<p>Chưa có hồ sơ ở trang này.</p>';
    section.querySelector('[data-w-page-label]').textContent='Trang '+page;
    section.querySelector('[data-w-page="-1"]').disabled=page===1;
    section.querySelector('[data-w-page="1"]').disabled=data.activations.length<20;
  }
  form.elements.source.addEventListener('change',()=>{if(!editing)changeSource();});
  form.elements.orderId.addEventListener('change',async()=>{
    const current=++sequence,select=form.elements.orderItemId;
    select.innerHTML='<option value="">Đang tải sản phẩm…</option>';select.disabled=true;
    if(!form.elements.orderId.value){select.innerHTML='<option value="">Chọn đơn hàng trước</option>';return;}
    try {
      const {order}=await api('/api/customer/orders/'+form.elements.orderId.value);
      if(current!==sequence)return;
      select.innerHTML='<option value="">Chọn sản phẩm đã mua</option>'+order.items.map(i=>`<option value="${i.id}">${escape(i.productName)} · ${escape(i.variantName)} · Số lượng ${i.quantity}</option>`).join('');
      select.disabled=false;fillContact(order);
    } catch(error){if(current===sequence)feedback.textContent=error.message;}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(form.elements.source.value==='account'){feedback.textContent='Đơn website được kích hoạt tự động; không cần gửi lại.';return;}const button=form.querySelector('[type=submit]');button.disabled=true;button.textContent='Đang gửi đăng ký…';
    feedback.textContent='Đang lưu đăng ký, vui lòng chờ…';
    try {
      const contact=Object.fromEntries(['fullName','phone','address','city','email'].filter(name=>form.elements[name]).map(name=>[name,form.elements[name].value]));
      const account=form.elements.source.value==='account';
      if(account&&(form.elements.orderItemId.disabled||!form.elements.orderItemId.value))throw Error('Chọn sản phẩm trong đơn hàng trước khi đăng ký.');
      const body=account?{orderItemId:form.elements.orderItemId.value,contact}:{channel:form.elements.source.value,externalOrderNumber:form.elements.externalOrderNumber.value,productName:form.elements.productName.value,serial:form.elements.serial?.value||editing?.serial||'',...(form.elements.purchaseDate?.value?{purchaseDate:form.elements.purchaseDate.value}:{}),contact};
      if(JSON.stringify(body)!==serialized){serialized=JSON.stringify(body);key=crypto.randomUUID();}
      const data=await api(editing?'/api/warranty-requests/'+editing.id:(account?'/api/customer/warranties':'/api/warranty-requests'),editing?'PATCH':'POST',editing?{...body,serial:form.elements.serial?.value||editing?.serial||'',version:editing.version}:{...body,requestKey:key});
      if(data.managementToken)storeToken(data.activation.id,data.managementToken);
      feedback.textContent='Đã tiếp nhận đăng ký. Mã hồ sơ: '+data.activation.id+'. GAERU sẽ đối chiếu đơn và ngày mua trước khi xác nhận kích hoạt.';
      if(!customer)feedback.textContent+=' Vui lòng lưu mã hồ sơ để liên hệ GAERU theo dõi kết quả.';
      editing=null;form.elements.source.disabled=false;section.querySelector('[data-w-cancel-edit]').hidden=true;key=null;serialized=null;page=1;
      try{await list();}catch{feedback.textContent+=' Chưa tải lại được danh sách; bạn có thể bấm Tải lại.';}
    } catch(error){feedback.textContent=error.message;}finally{button.disabled=false;button.textContent=editing?'Gửi lại hồ sơ':'Đăng ký kích hoạt';}
  });
  section.addEventListener('click',async event=>{
    const edit=event.target.closest('[data-w-edit]'),remove=event.target.closest('[data-w-delete]'),confirm=event.target.closest('[data-w-delete-yes]');
    if(event.target.closest('[data-w-cancel-edit]')){editing=null;form.elements.source.disabled=false;section.querySelector('[data-w-cancel-edit]').hidden=true;form.querySelector('[type=submit]').textContent='Đăng ký kích hoạt';feedback.textContent='Đã hủy chỉnh sửa.';return;}
    if(edit){const row=rows.find(w=>w.id===edit.dataset.wEdit);if(!row)return;form.elements.source.value=row.channel;changeSource();editing=row;form.elements.source.disabled=true;form.elements.externalOrderNumber.value=row.orderNumber;form.elements.productName.value=row.productName;if(form.elements.serial)form.elements.serial.value=row.serial||'';form.elements.purchaseDate.value=row.claimedPurchaseDate||'';for(const name of ['fullName','phone','address','city','email'])if(form.elements[name])form.elements[name].value='';fillContact({fullName:row.contactName,phone:row.contactPhone,address:row.contactAddress,city:row.contactCity,email:row.contactEmail||customer?.email});form.querySelector('[type=submit]').textContent='Gửi lại hồ sơ';section.querySelector('[data-w-cancel-edit]').hidden=false;feedback.textContent='Cập nhật thông tin rồi gửi lại để GAERU đối chiếu.';openActivation();form.scrollIntoView({block:'start',behavior:'smooth'});}
    if(remove){section.querySelector('[data-w-delete-confirm="'+remove.dataset.wDelete+'"]').innerHTML='<p>Yêu cầu chưa kích hoạt sẽ được xóa khỏi danh sách. Bạn có thể tạo đăng ký mới.</p><button class="care-plain" type="button" data-w-delete-yes="'+escape(remove.dataset.wDelete)+'">Xác nhận xóa yêu cầu</button>';}
    if(confirm){const row=rows.find(w=>w.id===confirm.dataset.wDeleteYes);if(!row)return;confirm.disabled=true;try{await api('/api/warranty-requests/'+row.id,'DELETE',{version:row.version,confirmation:'DELETE_WARRANTY_REQUEST'});delete guestTokens[row.id];try{localStorage.setItem('gaeru-warranty-tokens',JSON.stringify(guestTokens));}catch{}if(editing?.id===row.id){editing=null;form.elements.source.disabled=false;section.querySelector('[data-w-cancel-edit]').hidden=true;}await list();feedback.textContent='Đã xóa yêu cầu.';}catch(error){feedback.textContent=error.message;confirm.disabled=false;}}
  });
  section.addEventListener('click',async event=>{
    const button=event.target.closest('[data-w-page],[data-w-orders]');if(!button)return;
    button.disabled=true;const previous=page;
    try {
      if(button.hasAttribute('data-w-orders')){orderPage++;try{await orders();}catch(error){orderPage--;throw error;}}
      else{page+=Number(button.dataset.wPage);await list();}
    } catch(error){page=previous;feedback.textContent=error.message;button.disabled=false;}
    finally{if(button.hasAttribute('data-w-orders')||button.dataset.wPage==='0')button.disabled=false;}
  });
  (async()=>{
    try {
      const session=await api('/api/customer-auth/me');
      if(session.authenticated) {
        customer=session.customer;fillContact(customer);
        form.elements.source.querySelector('[value=account]').disabled=false;
        form.elements.source.value='account';changeSource();
        section.querySelector('[data-w-session]').textContent='Đăng ký cho '+customer.fullName+'. Vui lòng kiểm tra thông tin trước khi gửi.';
        section.querySelector('[data-w-history]').hidden=false;
        const results=await Promise.allSettled([orders(),list(),api('/api/customer/addresses').then(({addresses})=>{
          const address=addresses.find(a=>a.isDefault)||addresses[0];if(address)fillContact(address,false);
        })]);
        if(results.some(r=>r.status==='rejected'))feedback.textContent='Một số dữ liệu chưa tải được. Bạn vẫn có thể chọn kênh mua khác và điền đầy đủ thông tin.';
      } else {section.querySelector('[data-w-history]').hidden=false;try{await list();}catch{}section.querySelector('[data-w-session]').innerHTML='Bạn có thể đăng ký không cần tài khoản. <a href="account.html">Đăng nhập</a> để chọn đơn website và lưu hồ sơ vào tài khoản.';}
    } catch {section.querySelector('[data-w-session]').textContent='Chưa tải được tài khoản. Bạn có thể nhập thông tin và mã đơn để đăng ký, hoặc tải lại trang.';}
    finally {form.querySelector('[type=submit]').disabled=false;changeSource();}

  })();
})();
