(()=>{
  const admin=window.GAERUAdmin,root=document.querySelector('#shopping-chat-view'),h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let page=1,selected=null,client=null,loading=false,chatFilter='open';

  const FOLDER_NAMES={
    open:'Tất cả',
    assigned:'Đã chỉ định',
    unassigned:'Chưa chỉ định',
    urgent:'Cấp bách',
    overdue:'Quá hạn',
    due_soon:'Sắp hết hạn',
    unanswered:'Chưa trả lời',
    unread:'Chưa đọc',
    starred:'Đã gắn sao',
    closed:'Đã đóng'
  };

  async function load(){
    if(loading||!admin.can('customers.read'))return;
    loading=true;
    try{
      if(!root.querySelector('[data-admin-chat-list]')){
        root.innerHTML=(admin.can('staff.write')?'<details class="chat-email-settings" data-chat-email-settings><summary>Thông báo qua email</summary><div data-chat-email-content></div></details>':'')+
          '<div class="admin-shopping-chat'+(selected?' has-selected-thread':'')+'">'+
            '<nav class="chat-folder-nav" role="navigation" aria-label="Danh mục hộp thư">'+
              '<div class="chat-folder-header">'+
                '<span class="chat-folder-title" title="Hộp thư đến">Hộp thư đ...</span>'+
                '<button type="button" class="chat-folder-toggle" data-chat-folder-toggle title="Thu gọn / Mở rộng" aria-label="Thu gọn hoặc mở rộng danh mục">'+
                  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+
                    '<line x1="3" y1="6" x2="15" y2="6"></line><line x1="3" y1="12" x2="15" y2="12"></line><line x1="3" y1="18" x2="15" y2="18"></line><polyline points="18 9 15 12 18 15"></polyline>'+
                  '</svg>'+
                '</button>'+
              '</div>'+
              '<div class="chat-folder-group">'+
                '<button type="button" class="chat-folder-item" data-chat-filter="unassigned" aria-pressed="false">'+
                  '<span class="chat-folder-icon">🕒</span>'+
                  '<span class="chat-folder-label">Chưa chỉ định</span>'+
                '</button>'+
              '</div>'+
              '<hr class="chat-folder-divider">'+
              '<div class="chat-folder-group">'+
                '<button type="button" class="chat-folder-item is-card" data-chat-filter="assigned" aria-pressed="false">'+
                  '<span class="chat-folder-icon chat-icon-teal">👥</span>'+
                  '<span class="chat-folder-label">Đã chỉ định</span>'+
                  '<span class="chat-folder-badge" data-chat-count="assigned">0</span>'+
                '</button>'+
                '<button type="button" class="chat-folder-item is-sub is-card is-active" data-chat-filter="open" aria-pressed="true">'+
                  '<span class="chat-folder-label">Tất cả</span>'+
                  '<span class="chat-folder-badge" data-chat-count="open">0</span>'+
                '</button>'+
                '<button type="button" class="chat-folder-item is-sub" data-chat-filter="urgent" aria-pressed="false">'+
                  '<span class="chat-folder-label">Cấp bách</span>'+
                  '<span class="chat-folder-badge" data-chat-count="urgent">0</span>'+
                '</button>'+
                '<button type="button" class="chat-folder-item is-sub" data-chat-filter="overdue" aria-pressed="false">'+
                  '<span class="chat-folder-label">Quá hạn</span>'+
                  '<span class="chat-folder-badge" data-chat-count="overdue">0</span>'+
                '</button>'+
                '<button type="button" class="chat-folder-item is-sub" data-chat-filter="due_soon" aria-pressed="false">'+
                  '<span class="chat-folder-label">Sắp hết hạn</span>'+
                  '<span class="chat-folder-badge" data-chat-count="due_soon">0</span>'+
                '</button>'+
                '<button type="button" class="chat-folder-item is-sub" data-chat-filter="unanswered" aria-pressed="false">'+
                  '<span class="chat-folder-label">Chưa trả lời</span>'+
                  '<span class="chat-folder-badge" data-chat-count="unanswered">0</span>'+
                '</button>'+
                '<button type="button" class="chat-folder-item is-sub" data-chat-filter="unread" aria-pressed="false">'+
                  '<span class="chat-folder-label">Chưa đọc</span>'+
                  '<span class="chat-folder-badge" data-chat-count="unread">0</span>'+
                '</button>'+
                '<button type="button" class="chat-folder-item is-sub" data-chat-filter="starred" aria-pressed="false">'+
                  '<span class="chat-folder-label">Đã gắn sao</span>'+
                '</button>'+
              '</div>'+
              '<hr class="chat-folder-divider">'+
              '<div class="chat-folder-group">'+
                '<button type="button" class="chat-folder-item" data-chat-filter="closed" aria-pressed="false">'+
                  '<span class="chat-folder-icon">✔️</span>'+
                  '<span class="chat-folder-label">Đã đóng</span>'+
                  '<span class="chat-folder-badge" data-chat-count="closed" style="display:none">0</span>'+
                '</button>'+
              '</div>'+
            '</nav>'+
            '<aside class="chat-threads-aside">'+
              '<div class="admin-chat-aside-header" style="display:flex;align-items:center;justify-content:space-between">'+
                '<div style="display:flex;align-items:center;gap:8px">'+
                  '<button type="button" class="chat-mobile-folder-btn" data-chat-folder-drawer-toggle title="Danh mục" aria-label="Mở danh mục hộp thư">'+
                    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>'+
                  '</button>'+
                  '<h2 data-chat-active-folder-title>Tất cả</h2>'+
                '</div>'+
                '<span class="chat-live-badge" data-admin-chat-live title="Kết nối thời gian thực 0ms"><span class="chat-live-dot"></span><span data-admin-chat-live-text>Trực tuyến</span></span>'+
              '</div>'+
              '<div data-admin-chat-list></div>'+
              '<div class="pagination"><button data-chat-page="-1">Trước</button><span data-chat-page-label></span><button data-chat-page="1">Tiếp</button></div>'+
            '</aside>'+
            '<section class="chat-conversation-section">'+
              '<div class="admin-chat-mobile-header">'+
                '<button type="button" class="admin-chat-back-btn" data-chat-back>← Hộp thư</button>'+
                '<span class="admin-chat-mobile-thread-title" data-chat-mobile-title>Hội thoại</span>'+
              '</div>'+
              '<div data-admin-chat-controls></div>'+
              '<div data-admin-chat-thread>'+
                '<div class="admin-chat-empty-selection"><div class="admin-chat-empty-icon">💬</div><h3>Hộp thư hỗ trợ trực tuyến</h3><p>Chọn một hội thoại trong danh sách để đọc và phản hồi.</p></div>'+
              '</div>'+
            '</section>'+
          '</div><p role="status" data-admin-chat-status></p>';
      }
      const chatWrap=root.querySelector('.admin-shopping-chat');
      if(chatWrap)chatWrap.classList.toggle('has-selected-thread',!!selected);
      root.querySelectorAll('[data-chat-filter]').forEach(btn=>{
        const active=btn.dataset.chatFilter===chatFilter;
        btn.classList.toggle('is-active',active);
        btn.setAttribute('aria-pressed',String(active));
      });
      const titleEl=root.querySelector('[data-chat-active-folder-title]');
      if(titleEl)titleEl.textContent=FOLDER_NAMES[chatFilter]||'Tất cả';

      const d=await admin.request('/api/gaeru_ceo/shopping-chat?page='+page+'&status='+chatFilter);
      const counts={
        open:d.openCount||0,
        closed:d.closedCount||0,
        unassigned:d.unassignedCount||0,
        assigned:d.assignedCount||0,
        urgent:d.urgentCount||0,
        overdue:d.overdueCount||0,
        due_soon:d.dueSoonCount||0,
        unanswered:0,
        unread:0
      };
      for(const [k,v] of Object.entries(counts)){
        const el=root.querySelector('[data-chat-count="'+k+'"]');
        if(el){
          el.textContent=v;
        }
      }

      root.querySelector('[data-admin-chat-list]').innerHTML=d.threads.map(t=>'<button type="button" data-chat-thread="'+h(t.id)+'" aria-pressed="'+(t.id===selected)+'"><strong>'+h(t.product_name)+'</strong><small>'+(t.status==='closed'?'Đã đóng':t.awaiting_admin?'Cần nhân viên':t.handling_mode==='ai'?'AI đang hỗ trợ':'Nhân viên hỗ trợ')+'</small><time title="'+h(new Date(t.updated_at).toLocaleString('vi-VN'))+'">'+h(new Date(t.updated_at).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'}))+'</time></button>').join('')||'<p style="padding:16px 0;font-size:12px;color:var(--muted)">Không có hội thoại trong mục này.</p>';
      root.querySelector('[data-chat-page-label]').textContent='Trang '+page;
      root.querySelector('[data-chat-page="-1"]').disabled=page===1;
      root.querySelector('[data-chat-page="1"]').disabled=d.threads.length<30;
    }catch(e){
      admin.showGlobal(e.message,true);
    }finally{
      loading=false;
    }
  }

  root.addEventListener('click',async e=>{
    const backBtn=e.target.closest('[data-chat-back]'),
          filterBtn=e.target.closest('[data-chat-filter]'),
          thread=e.target.closest('[data-chat-thread]'),
          pager=e.target.closest('[data-chat-page]'),
          status=e.target.closest('[data-chat-status]'),
          folderToggle=e.target.closest('[data-chat-folder-toggle]'),
          mobileFolderToggle=e.target.closest('[data-chat-folder-drawer-toggle]');
    try{
      if(folderToggle){
        const nav=root.querySelector('.chat-folder-nav');
        if(nav)nav.classList.toggle('is-collapsed');
        return;
      }
      if(mobileFolderToggle){
        const nav=root.querySelector('.chat-folder-nav');
        if(nav)nav.classList.toggle('is-mobile-open');
        return;
      }
      if(backBtn){
        selected=null;
        client?.stop();
        client=null;
        const chatWrap=root.querySelector('.admin-shopping-chat');
        if(chatWrap)chatWrap.classList.remove('has-selected-thread');
        const threadView=root.querySelector('[data-admin-chat-thread]');
        if(threadView)threadView.innerHTML='<div class="admin-chat-empty-selection"><div class="admin-chat-empty-icon">💬</div><h3>Hộp thư hỗ trợ trực tuyến</h3><p>Chọn một hội thoại trong danh sách để đọc và phản hồi.</p></div>';
        const controls=root.querySelector('[data-admin-chat-controls]');
        if(controls)controls.innerHTML='';
        await load();
        return;
      }
      if(filterBtn){
        chatFilter=filterBtn.dataset.chatFilter;
        page=1;
        const nav=root.querySelector('.chat-folder-nav');
        if(nav)nav.classList.remove('is-mobile-open');
        await load();
        return;
      }
      if(pager){
        page+=Number(pager.dataset.chatPage);
        await load();
        return;
      }
      if(thread){
        selected=thread.dataset.chatThread;
        const chatWrap=root.querySelector('.admin-shopping-chat');
        if(chatWrap)chatWrap.classList.add('has-selected-thread');
        const mobileTitle=root.querySelector('[data-chat-mobile-title]');
        if(mobileTitle)mobileTitle.textContent=thread.querySelector('strong')?.textContent||'Hội thoại';
        client?.stop();
        client=window.GAERUChatClient.mount(root.querySelector('[data-admin-chat-thread]'),{base:'/api/gaeru_ceo/shopping-chat',request:admin.request,id:selected,admin:true});
        const controls=root.querySelector('[data-admin-chat-controls]');
        controls.innerHTML=admin.can('customers.write')?'<button data-chat-status="closed">Đóng hội thoại</button><button data-chat-status="open">Mở lại hội thoại</button>':'<p>Bạn chỉ có quyền xem hội thoại.</p>';
        if(!admin.can('customers.write'))root.querySelector('[data-chat-compose]').hidden=true;
        await load();
        return;
      }
      if(status){
        await client.refresh();
        if(!client.thread)throw Error('Hãy tải hội thoại trước.');
        await admin.request('/api/gaeru_ceo/shopping-chat/'+selected+'/status',{method:'PUT',body:JSON.stringify({status:status.dataset.chatStatus,version:client.thread.version})});
        await client.refresh();
        await load();
      }
    }catch(error){
      root.querySelector('[data-admin-chat-status]').textContent=error.message;
    }
  });

  async function loadEmailSettings(){
    const target=root.querySelector('[data-chat-email-content]');
    if(!target)return;
    target.textContent='Đang tải…';
    try{
      const d=await admin.request('/api/gaeru_ceo/shopping-chat/email/preferences');
      target.innerHTML='<p>Chọn người nhận thông báo phiên mới và yêu cầu chuyển nhân viên. Chỉ dùng email đã xác thực của tài khoản có quyền xem chat. Tối đa một email/loại thông báo trong mỗi khung 5 phút.</p>'+(!d.smtpConfigured?'<p>Máy chủ chưa cấu hình SMTP; thư sẽ chờ trong hàng đợi.</p>':'')+'<form data-chat-email-form>'+d.recipients.map(r=>'<label><input type="checkbox" name="account" value="'+h(r.key)+'" '+(r.enabled?'checked ':'')+(!r.eligible?'disabled':'')+'><span>'+h(r.name)+'<small>'+h(r.email||'Chưa có email xác thực')+(!r.allowed?' · Không có quyền xem chat hoặc tài khoản đã khóa':'')+'</small></span></label>').join('')+'<button class="primary-button" type="submit" data-no-action-feedback>Lưu người nhận email</button><p role="status"></p></form><p>Hàng đợi: '+d.counts.map(c=>h(({pending:'Đang chờ',sending:'Đang gửi',sent:'SMTP đã nhận',skipped:'Đã bỏ qua',failed:'Gửi thất bại',unknown:'Cần kiểm tra kết quả'})[c.status])+': '+c.total).join(' · ')+'</p>';
    }catch(e){
      target.textContent=e.message;
    }
  }

  root.addEventListener('toggle',e=>{if(e.target.matches('[data-chat-email-settings]')&&e.target.open)loadEmailSettings();},true);
  root.addEventListener('submit',async e=>{
    if(!e.target.matches('[data-chat-email-form]'))return;
    e.preventDefault();
    const form=e.target;
    try{
      const accounts=[...form.querySelectorAll('input:checked:not(:disabled)')].map(i=>i.value);
      const d=await admin.request('/api/gaeru_ceo/shopping-chat/email/preferences',{method:'PUT',body:JSON.stringify({accounts})});
      form.querySelector('[role=status]').textContent=d.message;
    }catch(error){
      form.querySelector('[role=status]').textContent=error.message;
    }
  });

  const bubble=document.createElement('button');
  bubble.type='button';
  bubble.setAttribute('data-no-action-feedback','');
  bubble.className='admin-chat-bubble';
  bubble.setAttribute('aria-label','Mở chat trực tuyến');
  bubble.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4Z"/></svg><span data-chat-bubble-badge hidden>•</span>';
  bubble.hidden=true;
  document.body.append(bubble);
  bubble.onclick=()=>{admin.activateView('shopping-chat');root.scrollIntoView({block:'start'});};

  function syncBubble(){bubble.hidden=!admin.can('customers.read')||!document.querySelector('#login-panel')?.hidden||!root.hidden;}
  new MutationObserver(syncBubble).observe(document.querySelector('#admin-app'),{attributes:true,subtree:true,attributeFilter:['hidden']});
  window.GAERUCareLive.poll({delay:15000,active:()=>admin.can('customers.read')&&root.hidden&&matchMedia('(max-width:800px)').matches,run:async()=>{syncBubble();if(bubble.hidden)return;const d=await admin.request('/api/gaeru_ceo/shopping-chat?page=1');const unread=d.threads.some(t=>t.awaiting_admin);bubble.querySelector('[data-chat-bubble-badge]').hidden=!unread;bubble.setAttribute('aria-label',unread?'Mở chat trực tuyến, có tin cần phản hồi':'Mở chat trực tuyến');},status:()=>{}});syncBubble();
  window.GAERUShoppingChat={load};
  const updateAdminLiveStatus=(text)=>{const isRealtime=String(text||'').includes('SSE')||String(text||'').includes('Thời gian thực');const badge=root.querySelector('[data-admin-chat-live]');const label=root.querySelector('[data-admin-chat-live-text]');if(badge){badge.classList.toggle('is-fallback',!isRealtime);badge.title=isRealtime?'Thời gian thực (SSE 0ms)':(text||'Tự cập nhật');}if(label){label.textContent=isRealtime?'Trực tuyến':(String(text||'').includes('Mất')?'Mất mạng':'Đang kết nối');}};
  window.GAERUCareLive.poll({streamUrl:'/api/gaeru_ceo/realtime-sse',delay:5000,active:()=>!root.hidden&&admin.can('customers.read'),run:load,status:updateAdminLiveStatus});
})();
