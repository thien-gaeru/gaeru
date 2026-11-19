(()=>{
  const admin=window.GAERUAdmin,root=document.querySelector('#notifications-view');
  let items=[],loading=false,icloudMail=null,mailLoading=false;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let baseline=false;
  const seen=new Set();
  let audio=null;
  let pushSyncPromise=null;
  let pushSyncMode=null;

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

  function urlBase64ToUint8Array(base64String){
    const padding='='.repeat((4-base64String.length%4)%4);
    const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
    const rawData=window.atob(base64);
    const outputArray=new Uint8Array(rawData.length);
    for(let i=0;i<rawData.length;++i)outputArray[i]=rawData.charCodeAt(i);
    return outputArray;
  }

  function uint8Equal(a,b){
    if(!a||!b)return false;
    const ua=a instanceof Uint8Array?a:new Uint8Array(a);
    const ub=b instanceof Uint8Array?b:new Uint8Array(b);
    if(ua.length!==ub.length)return false;
    for(let i=0;i<ua.length;i++)if(ua[i]!==ub[i])return false;
    return true;
  }

  async function registerAdminWorker(){
    if(typeof navigator==='undefined'||!('serviceWorker'in navigator))return null;
    try{
      const regs=await navigator.serviceWorker.getRegistrations();
      for(const r of regs){
        try{
          if(new URL(r.scope).pathname==='/gaeru_ceo/')await r.unregister();
        }catch{}
      }
    }catch{}
    const registration=await navigator.serviceWorker.register('/gaeru_ceo/notification-worker.js',{scope:'/gaeru_ceo'});
    await navigator.serviceWorker.ready;
    return registration;
  }

  async function syncWebPushSubscription(enable=true,{throwOnError=false}={}){
    if(typeof navigator==='undefined'||!('serviceWorker'in navigator)||typeof window==='undefined'||!('PushManager'in window))return false;
    if(pushSyncPromise){
      if(pushSyncMode===Boolean(enable))return pushSyncPromise.catch(err=>{if(throwOnError)throw err;return false;});
      try{await pushSyncPromise;}catch{}
    }
    const mode=Boolean(enable);
    let wrapped=null;
    const task=(async()=>{
      const registration=await registerAdminWorker();
      if(!registration)return false;
      const existing=await registration.pushManager.getSubscription();
      if(!mode){
        if(existing){
          try{await admin.request('/api/gaeru_ceo/notifications/push-unsubscribe',{method:'POST',body:JSON.stringify({endpoint:existing.endpoint})});}catch{}
          try{await existing.unsubscribe();}catch{}
        }
        return false;
      }
      if(typeof Notification==='undefined'||Notification.permission!=='granted')return false;
      const keyRes=await admin.request('/api/gaeru_ceo/notifications/vapid-public-key',{cache:'no-store'});
      if(!keyRes?.publicKey)throw Error('Máy chủ chưa cấu hình khóa thông báo đẩy (VAPID).');
      const expectedKey=urlBase64ToUint8Array(keyRes.publicKey);
      let activeSub=existing;
      if(activeSub&&activeSub.options?.applicationServerKey&&!uint8Equal(activeSub.options.applicationServerKey,expectedKey)){
        try{await admin.request('/api/gaeru_ceo/notifications/push-unsubscribe',{method:'POST',body:JSON.stringify({endpoint:activeSub.endpoint})});}catch{}
        try{await activeSub.unsubscribe();}catch{}
        activeSub=null;
      }
      const sub=activeSub||await registration.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:expectedKey
      });
      await admin.request('/api/gaeru_ceo/notifications/push-subscribe',{
        method:'POST',
        body:JSON.stringify(sub.toJSON())
      });
      return true;
    })();
    pushSyncMode=mode;
    wrapped=task.finally(()=>{
      if(pushSyncPromise===wrapped){
        pushSyncPromise=null;
        pushSyncMode=null;
      }
    });
    pushSyncPromise=wrapped;
    try{
      return await wrapped;
    }catch(error){
      if(throwOnError)throw error;
      return false;
    }
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
    const first=fresh[0];
    const title=fresh.length===1?first.title:'GAERU · Có công việc mới';
    const body=fresh.length===1?first.detail:(fresh.length+' thông báo mới. Mở quản trị để xem nội dung.');
    try{
      const registration=await registerAdminWorker();
      if(!registration)throw Error('No SW');
      await registration.showNotification(title,{body,tag:'gaeru-admin-work',data:{target:first.target}});
    }catch{
      try{
        new Notification(title,{body,tag:'gaeru-admin-work'});
      }catch{}
    }
  }

  function desktopButtonState(p){
    const supported=typeof Notification!=='undefined';
    const perm=supported?Notification.permission:'default';
    if(supported&&perm==='denied')return {active:false,label:'Thông báo đẩy: Bị chặn'};
    if(!supported||perm!=='granted')return {active:false,label:'Thông báo đẩy: Chưa cấp quyền'};
    return {active:Boolean(p.desktop),label:'Thông báo đẩy: '+(p.desktop?'Bật':'Tắt')};
  }

  function controls(){
    const p=preference();
    const desk=desktopButtonState(p);
    return '<section class="notice-preferences"><div><strong>Thông báo đẩy & âm thanh trên thiết bị này</strong><p>Nhận thông báo đẩy (Web Push) ngay khi có đơn hàng, chat khách hàng hoặc yêu cầu mới, kể cả khi đóng trình duyệt.</p></div><div><button type="button" data-notice-desktop aria-pressed="'+desk.active+'">'+desk.label+'</button><button type="button" data-notice-sound aria-pressed="'+Boolean(p.sound)+'">Âm thanh: '+(p.sound?'Bật':'Tắt')+'</button><button type="button" data-notice-test>Thử âm thanh</button><button type="button" data-notice-push-test>Thử thông báo đẩy</button></div><p data-notice-preference-status role="status"></p></section>';
  }

  function icloudMailSection(){
    if(!admin.can('settings.read'))return '';
    const smtp=icloudMail?.smtp||{};
    const senderEmail=smtp.senderEmail||'noreply@gaeru.com';
    const adminEmail=smtp.adminEmail||'business@gaeru.com';
    const replyTo=smtp.replyTo||adminEmail;
    const smtpHost=smtp.host||'smtp.mail.me.com';
    const smtpPort=smtp.port||587;
    const smtpBadge=smtp.configured
      ?'<span class="notice-level" style="background:#065f46;color:#d1fae5">SMTP iCloud+ đã kích hoạt</span>'
      :(smtp.passwordPlaceholder
        ?'<span class="notice-level" style="background:#92400e;color:#fef3c7">Chưa nhập App-Specific Password iCloud+ (SMTP_PASSWORD)</span>'
        :'<span class="notice-level" style="background:#92400e;color:#fef3c7">Chưa cấu hình SMTP iCloud+</span>');
    return `<section class="notice-preferences" style="margin-top:12px">
      <div>
        <strong>Hệ thống Email Tên miền @gaeru.com · 100% iCloud+ Mail</strong> ${smtpBadge}
        <p>Hệ thống email nội bộ đã được tắt và gỡ bỏ hoàn toàn. Toàn bộ thư đến &amp; thư đi tên miền <code>@gaeru.com</code> vận hành qua <b>iCloud+ Custom Email Domain</b> (<code>mx01.mail.icloud.com</code>, <code>mx02.mail.icloud.com</code>, SMTP <code>${esc(smtpHost)}:${esc(smtpPort)}</code>).</p>
        <p style="font-size:13px;opacity:.9;margin-top:6px">Gửi thông báo người dùng (<code>SMTP_FROM</code>): <b>${esc(senderEmail)}</b> · Nhận thông báo quản trị &amp; phản hồi (<code>Reply-To</code>): <b>${esc(replyTo)}</b> (Quản trị: <b>${esc(adminEmail)}</b>)</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" data-mail-open="https://www.icloud.com/mail">Mở iCloud Mail ↗</button>
        <button type="button" data-mail-manage="https://www.icloud.com/icloudplus/">Quản lý alias &amp; tên miền trên iCloud+ ↗</button>
      </div>
    </section>`;
  }

  let lastPrefStatus='';
  function render(){
    const prevSt=root.querySelector('[data-notice-preference-status]')?.textContent?.trim();
    if(prevSt)lastPrefStatus=prevSt;
    root.innerHTML=controls()+icloudMailSection()+'<div class="notice-toolbar"><p>Cảnh báo công việc hiện tại. Chỉ hiển thị nội dung bạn có quyền xem.</p><button type="button" data-notice-all>Đánh dấu tất cả đã đọc</button></div><div class="notice-list">'+(items.map((n,i)=>`<article class="notice-card ${n.read?'is-read':''}"><span class="notice-level">${n.level==='warning'?'Cần chú ý':(n.target==='webmail'?'iCloud Mail':'Thông báo')}</span><h3>${esc(n.title)}</h3><p>${esc(n.detail)}</p><div><button type="button" data-notice-open="${i}">${n.target==='webmail'?'Mở iCloud Mail ↗':'Mở mục xử lý'}</button>${!n.read?`<button type="button" data-notice-read="${i}">Đánh dấu đã đọc</button>`:''}</div></article>`).join('')||'<div class="notice-empty">Chưa có công việc cần chú ý.</div>')+'</div>';
    if(lastPrefStatus){
      const st=root.querySelector('[data-notice-preference-status]');
      if(st)st.textContent=lastPrefStatus;
    }
  }

  async function loadIcloudMailStatus(){
    if(mailLoading||!admin.can('settings.read'))return;
    mailLoading=true;
    try{
      const res=await admin.request('/api/gaeru_ceo/notifications/icloud-mail',{cache:'no-store'});
      if(res&&res.provider){
        icloudMail=res;
        if(!root.hidden)render();
      }
    }catch{}finally{
      mailLoading=false;
    }
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
      if(!root.hidden){
        render();
        if(!icloudMail)loadIcloudMailStatus();
      }
    }finally{
      loading=false;
    }
  }

  root.addEventListener('click',e=>{
    const openBtn=e.target.closest('[data-mail-open],[data-mail-manage]');
    if(!openBtn)return;
    const url=openBtn.dataset.mailManage||openBtn.dataset.mailOpen||'https://www.icloud.com/mail';
    window.open(url,'_blank','noopener');
  });

  root.addEventListener('click',async e=>{
    const desktop=e.target.closest('[data-notice-desktop]'),sound=e.target.closest('[data-notice-sound]'),test=e.target.closest('[data-notice-test]'),pushTest=e.target.closest('[data-notice-push-test]');
    const clicked=desktop||sound||test||pushTest;
    if(!clicked||clicked.disabled)return;
    if(desktop||pushTest){
      if(admin.setButtonBusy)admin.setButtonBusy(clicked,true,'Đang xử lý…');else clicked.disabled=true;
    }
    try{
      const p=preference();
      if(test){beep();return;}
      if(pushTest){
        if(!('Notification'in window))throw Error('Trình duyệt chưa hỗ trợ thông báo.');
        if(Notification.permission!=='granted'){
          const perm=await Notification.requestPermission();
          if(perm!=='granted')throw Error('Cần cấp quyền thông báo trên trình duyệt trước.');
        }
        p.desktop=true;
        storePreference(p);
        const synced=await syncWebPushSubscription(true,{throwOnError:true});
        if(!synced)throw Error('Trình duyệt không hỗ trợ hoặc chưa kích hoạt được Service Worker Web Push.');
        const res=await admin.request('/api/gaeru_ceo/notifications/push-test',{method:'POST',body:'{}'});
        lastPrefStatus=res.message||(res.ok?'Đã gửi thông báo đẩy thử nghiệm.':'Không gửi được thông báo đẩy.');
        render();
        const st=root.querySelector('[data-notice-preference-status]');
        if(st)st.textContent=lastPrefStatus;
        return;
      }
      if(sound){
        p.sound=!p.sound;
        if(p.sound)beep();
      }
      let nextStatus='';
      if(desktop){
        const hasPerm='Notification'in window&&Notification.permission==='granted';
        if(p.desktop&&hasPerm){
          p.desktop=false;
          await syncWebPushSubscription(false);
          nextStatus='Đã tắt thông báo đẩy trên thiết bị này.';
        }else{
          if(!('Notification'in window))throw Error('Trình duyệt chưa hỗ trợ thông báo.');
          const permission=hasPerm?'granted':await Notification.requestPermission();
          if(permission!=='granted')throw Error('Chưa được cấp quyền. Bật thông báo trong cài đặt trình duyệt để tiếp tục.');
          p.desktop=true;
          const synced=await syncWebPushSubscription(true,{throwOnError:true});
          nextStatus=synced?'Đã bật và đăng ký thông báo đẩy trên thiết bị này.':'Đã cấp quyền nhưng chưa thể đăng ký push gateway.';
        }
      }
      storePreference(p);
      if(nextStatus)lastPrefStatus=nextStatus;
      render();
      if(nextStatus){
        const st=root.querySelector('[data-notice-preference-status]');
        if(st)st.textContent=nextStatus;
      }
    }catch(error){
      lastPrefStatus=error.message;
      const st=root.querySelector('[data-notice-preference-status]');
      if(st)st.textContent=error.message;
    }finally{
      if((desktop||pushTest)&&clicked.isConnected){
        if(admin.setButtonBusy)admin.setButtonBusy(clicked,false);else clicked.disabled=false;
      }
    }
  });

  root.addEventListener('click',async e=>{
    const open=e.target.closest('[data-notice-open]'),read=e.target.closest('[data-notice-read]'),all=e.target.closest('[data-notice-all]');
    const clicked=all||read||open;
    if(!clicked||clicked.disabled)return;
    if(admin.setButtonBusy)admin.setButtonBusy(clicked,true,'Đang xử lý…');else clicked.disabled=true;
    try{
      const n=all?null:items[Number((read||open)?.dataset[read?'noticeRead':'noticeOpen'])];
      if(!all&&!n)return;
      await admin.request('/api/gaeru_ceo/notifications/read',{method:'POST',body:JSON.stringify(all?{all:true}:{key:n.key,version:n.version})});
      await load();
      if(open&&n){
        if(n.target==='webmail')window.open('https://www.icloud.com/mail','_blank','noopener');
        else await admin.activateView(n.target);
      }
    }catch(error){
      admin.showGlobal(error.message,true);
    }finally{
      if(clicked.isConnected){
        if(admin.setButtonBusy)admin.setButtonBusy(clicked,false);else clicked.disabled=false;
      }
    }
  });

  window.GAERUNotifications={load};
  let poll,permHookBound=false;
  const tryInitNotificationPermission=()=>{
    if(!admin.can('dashboard.read'))return;
    if('Notification' in window && Notification.permission==='default' && preference().desktop){
      Notification.requestPermission().then(perm=>{
        if(perm==='granted'){
          syncWebPushSubscription(true).then(()=>{render();}).catch(()=>{});
        }else{
          render();
        }
      }).catch(()=>{});
    }
  };
  function start(){
    poll?.stop();
    poll=window.GAERUCareLive.poll({
      delay:15000,
      background:()=>Boolean(preference().desktop||preference().sound),
      active:()=>!document.querySelector('#admin-app').hidden&&admin.can('dashboard.read'),
      run:load,
      status:()=>{}
    });
    if(admin.can('dashboard.read')){
      if(typeof window!=='undefined'&&!permHookBound){
        permHookBound=true;
        window.addEventListener('click',tryInitNotificationPermission,{once:true});
      }
      load().catch(error=>admin.showGlobal(error.message,true));
      loadIcloudMailStatus().catch(()=>{});
      if(preference().desktop&&'Notification'in window&&Notification.permission==='granted'){
        syncWebPushSubscription(true).catch(()=>{});
      }
    }
  }

  document.addEventListener('gaeru:admin-ready',start);
  document.addEventListener('gaeru:admin-logout',()=>{poll?.stop();});
  start();
  window.addEventListener('pagehide',e=>{if(!e.persisted)poll?.stop();});
  window.addEventListener('pageshow',()=>poll?.refresh());
})();
