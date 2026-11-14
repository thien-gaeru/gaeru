(()=>{
  const admin=window.GAERUAdmin,root=document.querySelector('#notifications-view');
  let items=[],loading=false,mailAccounts=[],mailLoading=false;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let baseline=false;
  const seen=new Set();
  let audio=null;
  let pushSyncing=false;

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

  async function syncWebPushSubscription(enable=true){
    if(pushSyncing||!('serviceWorker'in navigator)||!('PushManager'in window))return false;
    pushSyncing=true;
    try{
      const registration=await navigator.serviceWorker.register('/gaeru_ceo/notification-worker.js');
      await navigator.serviceWorker.ready;
      const existing=await registration.pushManager.getSubscription();
      if(!enable){
        if(existing){
          try{await admin.request('/api/gaeru_ceo/notifications/push-unsubscribe',{method:'POST',body:JSON.stringify({endpoint:existing.endpoint})});}catch{}
          try{await existing.unsubscribe();}catch{}
        }
        return false;
      }
      if(!('Notification'in window)||Notification.permission!=='granted')return false;
      const keyRes=await admin.request('/api/gaeru_ceo/notifications/vapid-public-key',{cache:'no-store'});
      if(!keyRes?.publicKey)return false;
      const sub=existing||await registration.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:urlBase64ToUint8Array(keyRes.publicKey)
      });
      await admin.request('/api/gaeru_ceo/notifications/push-subscribe',{
        method:'POST',
        body:JSON.stringify(sub.toJSON())
      });
      return true;
    }catch{
      return false;
    }finally{
      pushSyncing=false;
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
      const registration=await navigator.serviceWorker.register('/gaeru_ceo/notification-worker.js');
      await registration.showNotification(title,{body,tag:'gaeru-admin-work',data:{target:first.target}});
    }catch{
      try{
        new Notification(title,{body,tag:'gaeru-admin-work'});
      }catch{}
    }
  }

  function controls(){
    const p=preference();
    return '<section class="notice-preferences"><div><strong>Thông báo đẩy & âm thanh trên thiết bị này</strong><p>Nhận thông báo đẩy (Web Push) ngay khi có email mới tới @gaeru.com hoặc công việc mới, kể cả khi đóng trình duyệt.</p></div><div><button type="button" data-notice-desktop aria-pressed="'+Boolean(p.desktop)+'">Thông báo đẩy: '+(p.desktop?'Bật':'Tắt')+'</button><button type="button" data-notice-sound aria-pressed="'+Boolean(p.sound)+'">Âm thanh: '+(p.sound?'Bật':'Tắt')+'</button><button type="button" data-notice-test>Thử âm thanh</button><button type="button" data-notice-push-test>Thử thông báo đẩy Mail</button></div><p data-notice-preference-status role="status"></p></section>';
  }

  function mailAccountsSection(){
    if(!admin.can('settings.read'))return '';
    const isOwner=admin.user?.role==='owner'||admin.user?.source==='bootstrap'||admin.user?.isOwner;
    const canWrite=admin.can('settings.write')&&isOwner;
    const rows=mailAccounts.map(acc=>{
      const badge=acc.isPrimary
        ?'<span class="notice-level" style="background:#065f46;color:#d1fae5">Hộp thư Quản trị · Nhận toàn bộ *@gaeru.com</span>'
        :'<span class="notice-level">Hộp thư phụ</span>';
      return `<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border:1px solid rgba(148,163,184,.25);border-radius:8px;margin-top:8px">
        <div>
          <strong>${esc(acc.email)}</strong> ${badge}
          <div style="font-size:12px;opacity:.8;margin-top:3px">Tên người gửi: <b>${esc(acc.displayName||'GAERU')}</b> · Tổng: <b>${Number(acc.totalCount||0)}</b> thư (${Number(acc.unreadCount||0)} chưa đọc)</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="button" data-mail-open="${esc(acc.email)}">Mở Webmail</button>
          ${canWrite?`<button type="button" data-mail-passwd="${esc(acc.username)}">Đổi mật khẩu</button>`:''}
          ${canWrite&&!acc.isPrimary?`<button type="button" data-mail-del="${esc(acc.username)}">Xóa & gộp về business</button>`:''}
        </div>
      </div>`;
    }).join('');
    const createForm=canWrite?`<form data-mail-create-form style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px;padding-top:10px;border-top:1px dashed rgba(148,163,184,.25)">
      <input type="text" name="username" placeholder="tên-hộp-thư (vd: cskh)" required pattern="[a-zA-Z0-9._-]+" style="min-width:160px">
      <span>@gaeru.com</span>
      <input type="password" name="password" placeholder="Mật khẩu (tối thiểu 6 ký tự)" required minlength="6" style="min-width:180px">
      <input type="text" name="displayName" placeholder="Tên gửi (mặc định: GAERU)" value="GAERU" style="min-width:150px">
      <button type="submit">+ Tạo hộp thư mới</button>
    </form>`:'';
    return `<section class="notice-preferences" style="margin-top:12px">
      <div>
        <strong>Quản lý Hộp thư tên miền @gaeru.com</strong>
        <p>Mọi email gửi tới bất kỳ địa chỉ <code>...@gaeru.com</code> đều được nhận đầy đủ tại hộp thư quản trị duy nhất <b>business@gaeru.com</b> (Tên hiển thị: <b>GAERU</b>). Quản trị có thể tạo thêm hộp thư phụ tuỳ ý bên dưới.</p>
      </div>
      <div data-mail-accounts-list>${rows||(mailLoading?'<p>Đang tải danh sách hộp thư...</p>':'<p>Hộp thư chính: <b>business@gaeru.com</b></p>')}</div>
      ${createForm}
      <p data-mail-accounts-status role="status"></p>
    </section>`;
  }

  function render(){
    root.innerHTML=controls()+mailAccountsSection()+'<div class="notice-toolbar"><p>Cảnh báo công việc & hộp thư hiện tại. Chỉ hiển thị nội dung bạn có quyền xem.</p><button type="button" data-notice-all>Đánh dấu tất cả đã đọc</button></div><div class="notice-list">'+(items.map((n,i)=>`<article class="notice-card ${n.read?'is-read':''}"><span class="notice-level">${n.level==='warning'?'Cần chú ý':(n.target==='webmail'?'Hộp thư':'Thông báo')}</span><h3>${esc(n.title)}</h3><p>${esc(n.detail)}</p><div><button type="button" data-notice-open="${i}">${n.target==='webmail'?'Mở Webmail':'Mở mục xử lý'}</button>${!n.read?`<button type="button" data-notice-read="${i}">Đánh dấu đã đọc</button>`:''}</div></article>`).join('')||'<div class="notice-empty">Chưa có công việc cần chú ý.</div>')+'</div>';
  }

  async function loadMailAccounts(){
    if(mailLoading||!admin.can('settings.read'))return;
    mailLoading=true;
    try{
      const res=await admin.request('/api/gaeru_ceo/notifications/mail-accounts',{cache:'no-store'});
      if(Array.isArray(res?.accounts)){
        mailAccounts=res.accounts;
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
        if(!mailAccounts.length)loadMailAccounts();
      }
    }finally{
      loading=false;
    }
  }

  root.addEventListener('submit',async e=>{
    const form=e.target.closest('[data-mail-create-form]');
    if(!form)return;
    e.preventDefault();
    const st=root.querySelector('[data-mail-accounts-status]');
    try{
      const fd=new FormData(form);
      const username=String(fd.get('username')||'').trim().toLowerCase().split('@')[0];
      const password=String(fd.get('password')||'');
      const displayName=String(fd.get('displayName')||'GAERU').trim()||'GAERU';
      const adminPassword=window.prompt('Nhập mật khẩu Quản trị viên tối cao (Owner) để xác thực thao tác hộp thư @gaeru.com:');
      if(!adminPassword)return;
      const res=await admin.request('/api/gaeru_ceo/notifications/mail-accounts',{
        method:'POST',
        body:JSON.stringify({action:'add',username,password,displayName,adminPassword})
      });
      form.reset();
      await loadMailAccounts();
      if(st)st.textContent=res.message||(`Đã tạo hộp thư ${username}@gaeru.com.`);
    }catch(error){
      if(st)st.textContent=error.message;
    }
  });

  root.addEventListener('click',async e=>{
    const openBtn=e.target.closest('[data-mail-open]'),
          passBtn=e.target.closest('[data-mail-passwd]'),
          delBtn=e.target.closest('[data-mail-del]');
    if(!openBtn&&!passBtn&&!delBtn)return;
    const st=root.querySelector('[data-mail-accounts-status]');
    try{
      if(openBtn){
        window.open('https://mail.gaeru.com/?_task=mail&_mbox=INBOX','_blank','noopener');
        return;
      }
      if(passBtn){
        const username=passBtn.dataset.mailPasswd;
        const password=window.prompt(`Nhập mật khẩu mới cho hộp thư ${username}@gaeru.com (tối thiểu 6 ký tự):`);
        if(!password)return;
        const adminPassword=window.prompt('Nhập mật khẩu Quản trị viên tối cao (Owner) để xác thực thao tác hộp thư @gaeru.com:');
        if(!adminPassword)return;
        const res=await admin.request('/api/gaeru_ceo/notifications/mail-accounts',{
          method:'POST',
          body:JSON.stringify({action:'passwd',username,password,adminPassword})
        });
        await loadMailAccounts();
        if(st)st.textContent=res.message||(`Đã cập nhật mật khẩu cho ${username}@gaeru.com.`);
        return;
      }
      if(delBtn){
        const username=delBtn.dataset.mailDel;
        if(!window.confirm(`Xóa hộp thư ${username}@gaeru.com? Toàn bộ thư trong hộp thư này sẽ được chuyển tự động về hộp thư chính business@gaeru.com.`))return;
        const adminPassword=window.prompt('Nhập mật khẩu Quản trị viên tối cao (Owner) để xác thực thao tác hộp thư @gaeru.com:');
        if(!adminPassword)return;
        const res=await admin.request('/api/gaeru_ceo/notifications/mail-accounts',{
          method:'POST',
          body:JSON.stringify({action:'del',username,adminPassword})
        });
        await loadMailAccounts();
        if(st)st.textContent=res.message||(`Đã xóa ${username}@gaeru.com và gộp thư về business@gaeru.com.`);
      }
    }catch(error){
      if(st)st.textContent=error.message;
    }
  });

  root.addEventListener('click',async e=>{
    const desktop=e.target.closest('[data-notice-desktop]'),sound=e.target.closest('[data-notice-sound]'),test=e.target.closest('[data-notice-test]'),pushTest=e.target.closest('[data-notice-push-test]');
    if(!desktop&&!sound&&!test&&!pushTest)return;
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
        await syncWebPushSubscription(true);
        const res=await admin.request('/api/gaeru_ceo/notifications/push-test',{method:'POST',body:'{}'});
        const st=root.querySelector('[data-notice-preference-status]');
        if(st)st.textContent=res.message||'Đã gửi thông báo đẩy thử nghiệm.';
        return;
      }
      if(sound){
        p.sound=!p.sound;
        if(p.sound)beep();
      }
      if(desktop){
        if(p.desktop){
          p.desktop=false;
          await syncWebPushSubscription(false);
        }else{
          if(!('Notification'in window))throw Error('Trình duyệt chưa hỗ trợ thông báo.');
          const permission=await Notification.requestPermission();
          if(permission!=='granted')throw Error('Chưa được cấp quyền. Bật thông báo trong cài đặt trình duyệt để tiếp tục.');
          p.desktop=true;
          await syncWebPushSubscription(true);
        }
      }
      storePreference(p);
      render();
    }catch(error){
      const st=root.querySelector('[data-notice-preference-status]');
      if(st)st.textContent=error.message;
    }
  });

  root.addEventListener('click',async e=>{
    const open=e.target.closest('[data-notice-open]'),read=e.target.closest('[data-notice-read]'),all=e.target.closest('[data-notice-all]');
    try{
      if(all||read||open){
        const n=items[Number((read||open)?.dataset[read?'noticeRead':'noticeOpen'])];
        await admin.request('/api/gaeru_ceo/notifications/read',{method:'POST',body:JSON.stringify(all?{all:true}:{key:n.key,version:n.version})});
        await load();
        if(open){
          if(n.target==='webmail')window.open('https://mail.gaeru.com/?_task=mail&_mbox=INBOX','_blank','noopener');
          else await admin.activateView(n.target);
        }
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
    if(admin.can('dashboard.read')){
      load().catch(error=>admin.showGlobal(error.message,true));
      loadMailAccounts().catch(()=>{});
      if(preference().desktop&&'Notification'in window&&Notification.permission==='granted'){
        syncWebPushSubscription(true).catch(()=>{});
      }
    }
  }

  if(typeof window!=='undefined'){
    const tryInitNotificationPermission=()=>{
      if('Notification' in window && Notification.permission==='default' && preference().desktop){
        Notification.requestPermission().then(perm=>{
          if(perm==='granted'){
            syncWebPushSubscription(true).catch(()=>{});
            render();
          }
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
