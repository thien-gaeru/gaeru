(()=>{
  const admin=window.GAERUAdmin,root=document.querySelector('#notifications-view');
  let items=[],loading=false;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let baseline=false;
  const seen=new Set();
  let audio=null;

  const preference=()=>{
    try{
      const raw=localStorage.getItem('gaeru:notice-preferences:'+admin.user?.username);
      if(!raw)return {desktop:true,sound:true};
      const p=JSON.parse(raw);
      return {
        desktop:p.desktop!==false,
        sound:p.sound!==false
      };
    }catch{
      return {desktop:true,sound:true};
    }
  };

  function storePreference(value){
    localStorage.setItem('gaeru:notice-preferences:'+admin.user?.username,JSON.stringify(value));
  }

  function beep(){
    try{
      audio??=new(window.AudioContext||window.webkitAudioContext)();
      audio.resume();
      const oscillator=audio.createOscillator(),gain=audio.createGain();
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.frequency.setValueAtTime(740,audio.currentTime);
      gain.gain.setValueAtTime(.06,audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.3);
      oscillator.start();
      oscillator.stop(audio.currentTime+.3);
    }catch{}
  }

  async function notify(incoming){
    const fresh=incoming.filter(n=>!n.read&&!seen.has(n.key+':'+n.version));
    for(const n of incoming)seen.add(n.key+':'+n.version);
    if(!baseline){baseline=true;return;}
    if(!fresh.length)return;
    const p=preference();
    if(p.sound)beep();
    if(!p.desktop||!('Notification'in window)||Notification.permission!=='granted')return;
    try{
      const registration=await navigator.serviceWorker.register('/gaeru_ceo/notification-worker.js');
      await registration.showNotification('GAERU · Có công việc mới',{body:fresh.length+' thông báo mới. Mở quản trị để xem nội dung.',tag:'gaeru-admin-work',data:{target:fresh[0].target}});
    }catch{
      try{
        new Notification('GAERU · Có công việc mới',{body:'Mở trang quản trị để xem nội dung.',tag:'gaeru-admin-work'});
      }catch{}
    }
  }

  function controls(){
    const p=preference();
    return '<section class="notice-preferences"><div><strong>Thông báo trên thiết bị này</strong><p>Nhận thông báo và âm thanh khi trang quản trị đang mở, kể cả ở tab nền. Đóng trang sẽ dừng cập nhật.</p></div><div><button type="button" data-notice-desktop aria-pressed="'+Boolean(p.desktop)+'">Thông báo trình duyệt: '+(p.desktop?'Bật':'Tắt')+'</button><button type="button" data-notice-sound aria-pressed="'+Boolean(p.sound)+'">Âm thanh: '+(p.sound?'Bật':'Tắt')+'</button><button type="button" data-notice-test>Thử âm thanh</button></div><p data-notice-preference-status role="status"></p></section>';
  }

  function render(){
    root.innerHTML=controls()+'<div class="notice-toolbar"><p>Cảnh báo công việc hiện tại. Chỉ hiển thị nội dung bạn có quyền xem.</p><button type="button" data-notice-all>Đánh dấu tất cả đã đọc</button></div><div class="notice-list">'+(items.map((n,i)=>`<article class="notice-card ${n.read?'is-read':''}"><span class="notice-level">${n.level==='warning'?'Cần chú ý':'Thông báo'}</span><h3>${esc(n.title)}</h3><p>${esc(n.detail)}</p><div><button type="button" data-notice-open="${i}">Mở mục xử lý</button>${!n.read?`<button type="button" data-notice-read="${i}">Đánh dấu đã đọc</button>`:''}</div></article>`).join('')||'<div class="notice-empty">Chưa có công việc cần chú ý.</div>')+'</div>';
  }

  async function load(){
    if(loading||!admin.can('dashboard.read'))return;
    loading=true;
    try{
      const data=await admin.request('/api/gaeru_ceo/notifications',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      await notify(data.items);
      items=data.items;
      for(const badge of document.querySelectorAll('[data-notice-count]')){
        badge.textContent=String(data.unread);
        badge.hidden=data.unread===0;
      }
      if(!root.hidden)render();
    }finally{
      loading=false;
    }
  }

  root.addEventListener('click',async e=>{
    const desktop=e.target.closest('[data-notice-desktop]'),sound=e.target.closest('[data-notice-sound]'),test=e.target.closest('[data-notice-test]');
    if(!desktop&&!sound&&!test)return;
    try{
      const p=preference();
      if(test){beep();return;}
      if(sound){
        p.sound=!p.sound;
        if(p.sound)beep();
      }
      if(desktop){
        if(p.desktop){
          p.desktop=false;
        }else{
          if(!('Notification'in window))throw Error('Trình duyệt chưa hỗ trợ thông báo.');
          const permission=await Notification.requestPermission();
          if(permission!=='granted')throw Error('Chưa được cấp quyền. Bật thông báo trong cài đặt trình duyệt để tiếp tục.');
          p.desktop=true;
        }
      }
      storePreference(p);
      render();
    }catch(error){
      root.querySelector('[data-notice-preference-status]').textContent=error.message;
    }
  });

  root.addEventListener('click',async e=>{
    const open=e.target.closest('[data-notice-open]'),read=e.target.closest('[data-notice-read]'),all=e.target.closest('[data-notice-all]');
    try{
      if(all||read||open){
        const n=items[Number((read||open)?.dataset[read?'noticeRead':'noticeOpen'])];
        await admin.request('/api/gaeru_ceo/notifications/read',{method:'POST',body:JSON.stringify(all?{all:true}:{key:n.key,version:n.version})});
        await load();
        if(open)await admin.activateView(n.target);
      }
    }catch(error){
      admin.showGlobal(error.message,true);
    }
  });

  window.GAERUNotifications={load};
  let poll;
  function start(){
    poll?.stop();
    poll=window.GAERUCareLive.poll({
      delay:15000,
      background:()=>Boolean(preference().desktop||preference().sound),
      active:()=>!document.querySelector('#admin-app').hidden&&admin.can('dashboard.read'),
      run:load,
      status:()=>{}
    });
    if(admin.can('dashboard.read'))load().catch(error=>admin.showGlobal(error.message,true));
  }

  if(typeof window!=='undefined'){
    const tryInitNotificationPermission=()=>{
      if('Notification' in window && Notification.permission==='default' && preference().desktop){
        Notification.requestPermission().then(perm=>{
          if(perm==='granted')render();
        }).catch(()=>{});
      }
    };
    window.addEventListener('click',tryInitNotificationPermission,{once:true});
  }

  document.addEventListener('gaeru:admin-ready',start);
  start();
  window.addEventListener('pagehide',e=>{if(!e.persisted)poll.stop();});
  window.addEventListener('pageshow',()=>poll.refresh());
})();
