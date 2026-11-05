(()=>{'use strict';
  const root=document.querySelector('#marketing-view');if(!root)return;
  const box=document.createElement('details');box.className='configuration-panel';box.dataset.homeBanner='';

  box.innerHTML=`<summary>
  <span>🖼️ Banner Trang Chủ (Hero Banner)</span>
  <small data-home-banner-summary-status class="status-pill status-draft">Đang tắt</small>
</summary>
<div class="home-banner-panel-inner">
  <form data-home-banner-form class="home-banner-form">
    <div class="home-banner-intro-card">
      <div class="home-banner-intro-icon">📢</div>
      <div class="home-banner-intro-text">
        <strong>Vị trí hiển thị nổi bật trên Trang Chủ</strong>
        <p>Banner xuất hiện ngay dưới thông báo đầu trang. Hình ảnh giữ đúng tỷ lệ gốc và được tự động phục vụ chuẩn WebP tối ưu hóa retina. Hỗ trợ ảnh riêng biệt chuyên dụng cho màn hình điện thoại di động.</p>
      </div>
    </div>

    <div class="home-banner-switch-card">
      <div class="home-banner-switch-info">
        <label for="home-banner-enable-toggle" class="home-banner-switch-title">Hiển thị banner trên trang chủ</label>
        <span class="home-banner-switch-desc">Khi bật, banner hiển thị công khai ngay lập tức. Yêu cầu có ảnh máy tính và mô tả ảnh.</span>
      </div>
      <label class="home-banner-toggle-switch" title="Bật/Tắt hiển thị banner">
        <input id="home-banner-enable-toggle" name="enabled" type="checkbox">
        <span class="home-banner-slider"></span>
      </label>
    </div>

    <div class="home-banner-cards-grid">
      <!-- Desktop Image Card -->
      <div class="home-banner-upload-card" data-card="desktop">
        <div class="home-banner-card-header">
          <div class="home-banner-card-title-group">
            <span class="home-banner-device-icon">🖥️</span>
            <div>
              <strong class="home-banner-card-title">Ảnh Máy Tính</strong>
              <span class="home-banner-badge badge-required">Bắt buộc khi bật</span>
            </div>
          </div>
          <span class="home-banner-card-hint">Khuyên dùng: 1920 × 600px hoặc tỷ lệ 16:9 – 21:9</span>
        </div>

        <div class="home-banner-dropzone" data-dropzone="desktop" title="Kéo thả ảnh máy tính vào đây">
          <div class="home-banner-preview-wrap" data-preview-wrap="desktop" hidden>
            <img data-home-banner-preview="desktop" alt="Xem trước ảnh máy tính">
            <div class="home-banner-preview-overlay">
              <span class="home-banner-preview-pill">Ảnh máy tính</span>
            </div>
          </div>
          <div class="home-banner-placeholder" data-placeholder="desktop">
            <div class="home-banner-placeholder-icon">☁️</div>
            <p class="home-banner-placeholder-text">Kéo thả ảnh vào đây</p>
            <span class="home-banner-placeholder-types">PNG, JPG, WebP tối đa 10MB</span>
          </div>
        </div>

        <div class="home-banner-card-actions">
          <label class="home-banner-upload-btn secondary-button">
            <span>📁 Chọn ảnh máy tính</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" data-home-banner-upload="desktop" style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0,0,0,0)">
          </label>
        </div>
      </div>

      <!-- Mobile Image Card -->
      <div class="home-banner-upload-card" data-card="mobile">
        <div class="home-banner-card-header">
          <div class="home-banner-card-title-group">
            <span class="home-banner-device-icon">📱</span>
            <div>
              <strong class="home-banner-card-title">Ảnh Điện Thoại</strong>
              <span class="home-banner-badge badge-optional">Không bắt buộc</span>
            </div>
          </div>
          <span class="home-banner-card-hint">Khuyên dùng: tỷ lệ 1:1 hoặc 4:5 (ví dụ: 800 × 800px)</span>
        </div>

        <div class="home-banner-dropzone" data-dropzone="mobile" title="Kéo thả ảnh điện thoại vào đây">
          <div class="home-banner-preview-wrap" data-preview-wrap="mobile" hidden>
            <img data-home-banner-preview="mobile" alt="Xem trước ảnh điện thoại">
            <div class="home-banner-preview-overlay">
              <span class="home-banner-preview-pill">Ảnh điện thoại riêng</span>
            </div>
          </div>
          <div class="home-banner-placeholder" data-placeholder="mobile">
            <div class="home-banner-placeholder-icon">📱</div>
            <p class="home-banner-placeholder-text">Đang dùng chung ảnh máy tính</p>
            <span class="home-banner-placeholder-types">Tùy chọn tải ảnh riêng cho di động</span>
          </div>
        </div>

        <div class="home-banner-card-actions">
          <label class="home-banner-upload-btn secondary-button">
            <span>📁 Chọn ảnh điện thoại</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" data-home-banner-upload="mobile" style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0,0,0,0)">
          </label>
          <button type="button" class="home-banner-clear-mobile-btn secondary-button" data-home-banner-clear-mobile hidden>
            ✕ Dùng lại ảnh máy tính
          </button>
        </div>
      </div>
    </div>

    <!-- Metadata Fields -->
    <div class="home-banner-fields-grid">
      <div class="home-banner-field-group">
        <label class="home-banner-field-label" for="home-banner-alt">
          <span>Mô tả ảnh (Alt Text)</span>
          <span class="home-banner-badge badge-required">Bắt buộc khi bật</span>
        </label>
        <input id="home-banner-alt" name="alt" maxlength="240" placeholder="Nội dung chính của banner (phục vụ SEO & trợ năng)..." class="home-banner-text-input">
        <span class="home-banner-field-hint">Mô tả tóm tắt nội dung thông điệp truyền tải.</span>
      </div>

      <div class="home-banner-field-group">
        <label class="home-banner-field-label" for="home-banner-href">
          <span>Đường dẫn khi bấm vào ảnh</span>
          <span class="home-banner-badge badge-optional">Không bắt buộc</span>
        </label>
        <input id="home-banner-href" name="href" maxlength="2048" placeholder="/cua-hang hoặc https://gaeru.com/san-pham/..." class="home-banner-text-input">
        <span class="home-banner-field-hint">Chuyển hướng người dùng khi click banner (đường dẫn nội bộ hoặc link HTTPS).</span>
      </div>
    </div>

    <!-- Live Preview Simulator -->
    <div class="home-banner-preview-simulator">
      <div class="home-banner-simulator-header">
        <div class="home-banner-simulator-title">
          <span>👁️ Xem trước giao diện thực tế trên Trang chủ</span>
        </div>
        <div class="home-banner-simulator-tabs" role="tablist">
          <button type="button" class="home-banner-sim-tab is-active" data-sim-tab="desktop">🖥️ Máy tính</button>
          <button type="button" class="home-banner-sim-tab" data-sim-tab="mobile">📱 Điện thoại</button>
        </div>
      </div>
      <div class="home-banner-simulator-canvas" data-sim-canvas="desktop">
        <div class="home-banner-mock-announcement">
          <span>🎉 GAERU - Âm thanh chuyên nghiệp • Bảo hành 12 tháng chính hãng</span>
        </div>
        <div class="home-banner-mock-banner" data-sim-banner-container>
          <div class="home-banner-mock-empty" data-sim-empty>Chưa có ảnh banner</div>
          <img data-sim-img alt="Mô phỏng banner" hidden>
        </div>
        <div class="home-banner-mock-hero">
          <div class="home-banner-mock-hero-bar"></div>
          <div class="home-banner-mock-hero-sub"></div>
        </div>
      </div>
    </div>

    <!-- Actions & Status Bar -->
    <div class="home-banner-action-bar">
      <div class="home-banner-action-buttons">
        <button class="primary-button home-banner-submit-btn" type="submit">
          <span>Lưu banner trang chủ</span>
        </button>
        <button class="secondary-button home-banner-reload-btn" type="button" data-home-banner-reload>
          <span>Tải lại</span>
        </button>
      </div>
      <div class="home-banner-status-box" role="status" data-home-banner-status></div>
    </div>
  </form>
</div>`;

  root.append(box);
  new MutationObserver(()=>{if(!root.contains(box))root.append(box);}).observe(root,{childList:true});

  const form=box.querySelector('form');
  const statusEl=box.querySelector('[data-home-banner-status]');
  const summaryStatus=box.querySelector('[data-home-banner-summary-status]');
  const clearMobileBtn=box.querySelector('[data-home-banner-clear-mobile]');
  const simCanvas=box.querySelector('[data-sim-canvas]');
  const simImg=box.querySelector('[data-sim-img]');
  const simEmpty=box.querySelector('[data-sim-empty]');

  let value=null,busy=false,uploads=0;
  let activeSimTab='desktop';

  const admin=()=>window.GAERUAdmin;
  const field=(name)=>form.elements?.[name]||form.querySelector('[name="'+name+'"]');

  function setStatus(msg, type='info'){
    if(!statusEl)return;
    let badgeClass='home-banner-status-badge is-off';
    if(type==='live')badgeClass='home-banner-status-badge is-live';
    else if(type==='busy')badgeClass='home-banner-status-badge is-busy';
    else if(type==='error')badgeClass='home-banner-status-badge is-error';
    statusEl.innerHTML='<span class="'+badgeClass+'">'+msg+'</span>';

    if(summaryStatus){
      if(value?.enabled){
        summaryStatus.className='status-pill status-subscribed';
        summaryStatus.textContent='● Đang hiển thị';
      }else{
        summaryStatus.className='status-pill status-draft';
        summaryStatus.textContent='○ Đang tắt';
      }
    }
  }

  function updateSimulator(){
    if(!simImg||!simEmpty)return;
    let imgId=null;
    if(activeSimTab==='desktop'){
      imgId=value?.desktopImageId;
    }else{
      imgId=value?.mobileImageId||value?.desktopImageId;
    }
    if(imgId){
      simImg.src='/api/gaeru_ceo/marketing/banners/'+encodeURIComponent(imgId);
      simImg.hidden=false;
      simEmpty.hidden=true;
    }else{
      simImg.removeAttribute('src');
      simImg.hidden=true;
      simEmpty.hidden=false;
    }
  }

  function controls(){
    const disabled=busy||uploads>0||!admin()?.can('marketing.write');
    form.querySelectorAll('input,button').forEach(el=>{
      if(el.dataset.simTab!==undefined)return;
      el.disabled=disabled;
    });
    const reloadBtn=box.querySelector('[data-home-banner-reload]');
    if(reloadBtn)reloadBtn.disabled=busy||uploads>0;
  }

  function preview(kind,id){
    const img=box.querySelector('[data-home-banner-preview="'+kind+'"]');
    const wrap=box.querySelector('[data-preview-wrap="'+kind+'"]');
    const placeholder=box.querySelector('[data-placeholder="'+kind+'"]');

    if(img){
      img.hidden=!id;
      if(id)img.src='/api/gaeru_ceo/marketing/banners/'+encodeURIComponent(id);
      else img.removeAttribute('src');
    }
    if(wrap)wrap.hidden=!id;
    if(placeholder)placeholder.hidden=!!id;

    if(kind==='mobile'&&clearMobileBtn){
      clearMobileBtn.hidden=!id;
    }
    updateSimulator();
  }

  function draw(){
    const enabledInput=field('enabled');
    const altInput=field('alt');
    const hrefInput=field('href');

    if(enabledInput)enabledInput.checked=!!value.enabled;
    if(altInput)altInput.value=value.alt||'';
    if(hrefInput)hrefInput.value=value.href||'';

    preview('desktop',value.desktopImageId);
    preview('mobile',value.mobileImageId);
    controls();
    setStatus(value.enabled?'Banner đang hiển thị trên trang chủ.':'Banner đang tắt.',value.enabled?'live':'off');
  }

  async function load(){
    if(busy||uploads)return;
    busy=true;
    controls();
    setStatus('Đang tải cấu hình banner…','busy');
    try{
      value=await admin().request('/api/gaeru_ceo/marketing/home-banner');
      draw();
    }catch(e){
      setStatus(e.message||'Lỗi tải cấu hình banner.','error');
    }finally{
      busy=false;
      controls();
    }
  }

  box.addEventListener('toggle',()=>{if(box.open&&!value)load();});
  document.addEventListener('gaeru:admin-ready',()=>{
    value=null;
    box.hidden=!admin()?.can('marketing.read');
    if(box.open&&!box.hidden)load();
  });

  const reloadBtn=box.querySelector('[data-home-banner-reload]');
  if(reloadBtn)reloadBtn.onclick=load;

  if(clearMobileBtn){
    clearMobileBtn.onclick=()=>{
      if(value){
        value.mobileImageId=null;
        preview('mobile',null);
        setStatus('Đã gỡ ảnh di động. Bấm "Lưu banner trang chủ" để hoàn tất.','busy');
      }
    };
  }

  async function uploadFile(kind,file){
    if(!kind||!file||!value)return;
    uploads++;
    controls();
    setStatus('Đang tải ảnh '+kind+'…','busy');
    try{
      const data=new FormData();
      data.append('image',file);
      const result=await admin().request('/api/gaeru_ceo/marketing/banners',{method:'POST',body:data});
      value[kind+'ImageId']=result.id;
      preview(kind,result.id);
      setStatus('Đã tải ảnh '+kind+'. Bấm "Lưu banner trang chủ" để áp dụng.','busy');
    }catch(err){
      setStatus(err.message||'Lỗi tải ảnh.','error');
    }finally{
      uploads--;
      controls();
    }
  }

  box.addEventListener('change',async e=>{
    const kind=e.target.dataset.homeBannerUpload;
    if(!kind||!e.target.files||!e.target.files[0])return;
    await uploadFile(kind,e.target.files[0]);
    e.target.value='';
  });

  // Drag and drop support on dropzones
  ['desktop','mobile'].forEach(kind=>{
    const dropzone=box.querySelector('[data-dropzone="'+kind+'"]');
    if(!dropzone)return;
    dropzone.addEventListener('dragover',e=>{
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('is-dragover');
    });
    dropzone.addEventListener('dragleave',e=>{
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('is-dragover');
    });
    dropzone.addEventListener('drop',async e=>{
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('is-dragover');
      if(busy||uploads||!admin()?.can('marketing.write'))return;
      const files=e.dataTransfer?.files;
      if(files&&files[0]){
        await uploadFile(kind,files[0]);
      }
    });
  });

  // Simulator tabs switching
  box.querySelectorAll('[data-sim-tab]').forEach(tab=>{
    tab.addEventListener('click',()=>{
      const target=tab.dataset.simTab;
      activeSimTab=target;
      box.querySelectorAll('[data-sim-tab]').forEach(t=>t.classList.toggle('is-active',t===tab));
      if(simCanvas)simCanvas.dataset.simCanvas=target;
      updateSimulator();
    });
  });

  form.addEventListener('submit',async e=>{
    e.preventDefault();
    if(busy||uploads||!value)return;
    busy=true;
    controls();
    setStatus('Đang lưu banner…','busy');
    try{
      const enabledInput=field('enabled');
      const altInput=field('alt');
      const hrefInput=field('href');
      value=await admin().request('/api/gaeru_ceo/marketing/home-banner',{
        method:'PUT',
        body:JSON.stringify({
          version:value.version,
          enabled:enabledInput?enabledInput.checked:false,
          desktopImageId:value.desktopImageId,
          mobileImageId:value.mobileImageId,
          alt:altInput?altInput.value:'',
          href:hrefInput?hrefInput.value:''
        })
      });
      draw();
      setStatus(value.enabled?'Đã lưu thành công. Banner đang hiển thị trên trang chủ!':'Đã lưu. Banner đang ở trạng thái tắt.','live');
    }catch(err){
      setStatus(err.message||'Lỗi lưu banner.','error');
    }finally{
      busy=false;
      controls();
    }
  });
})();
