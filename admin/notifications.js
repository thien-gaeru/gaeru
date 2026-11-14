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
    const list=mailAccounts.length?mailAccounts:[
      {username:'noreply',email:'noreply@gaeru.com',displayName:'GAERU',isSender:true},
      {username:'business',email:'business@gaeru.com',displayName:'GAERU',isPrimary:true}
    ];
    const rows=list.map(acc=>{
      const badge=acc.isSender||acc.username==='noreply'
        ?'<span class="notice-level" style="background:#1e3a8a;color:#dbeafe">Mail gửi thông báo người dùng (SMTP_FROM)</span>'
        :(acc.isPrimary
          ?'<span class="notice-level" style="background:#065f46;color:#d1fae5">Mail nhận thông báo quản trị (ADMIN_DOMAIN_EMAIL)</span>'
          :'<span class="notice-level">Địa chỉ alias iCloud+</span>');
      return `<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border:1px solid rgba(148,163,184,.25);border-radius:8px;margin-top:8px">
        <div>
          <strong>${esc(acc.email)}</strong> ${badge}
          <div style="font-size:12px;opacity:.8;margin-top:3px">Tên gửi: <b>${esc(acc.displayName||'GAERU')}</b> · Vận hành qua <b>iCloud+ Mail</b> (<code>mx01/mx02.mail.icloud.com</code>)</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="button" data-mail-open="${esc(acc.email)}">Mở iCloud Mail ↗</button>
          ${canWrite?`<button type="button" data-mail-passwd="${esc(acc.username)}">Cập nhật App Password SMTP</button>`:''}
          ${canWrite&&!acc.isPrimary&&!acc.isSender&&acc.username!=='noreply'?`<button type="button" data-mail-del="${esc(acc.username)}">Xóa alias</button>`:''}
        </div>
      </div>`;
    }).join('');
    const createForm=canWrite?`<form data-mail-create-form style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px;padding-top:10px;border-top:1px dashed rgba(148,163,184,.25)">
      <input type="text" name="username" placeholder="alias (vd: cskh)" required pattern="[a-zA-Z0-9._-]+" style="min-width:150px">
      <span>@gaeru.com</span>
      <input type="password" name="password" placeholder="App Password Apple (tuỳ chọn)" minlength="6" style="min-width:190px">
      <input type="text" name="displayName" placeholder="Tên gửi (mặc định: GAERU)" value="GAERU" style="min-width:150px">
      <button type="submit">+ Lưu địa chỉ / alias</button>
    </form>`:'';
    return `<section class="notice-preferences" style="margin-top:12px">
      <div>
        <strong>Hệ thống Email Tên miền @gaeru.com · Kết nối iCloud+ Mail</strong>
        <p>Mail gửi thông báo cho người dùng: <b>noreply@gaeru.com</b> · Mail nhận thông báo cho quản trị &amp; phản hồi: <b>business@gaeru.com</b> (vận hành qua <b>iCloud+ Custom Email Domain</b>: <code>mx01.mail.icloud.com</code>, <code>mx02.mail.icloud.com</code>, DKIM <code>sig1._domainkey.gaeru.com</code>, SPF <code>include:icloud.com</code>).</p>
      </div>
      <div data-mail-accounts-list>${rows}</div>
      ${createForm}
      <p data-mail-accounts-status role="status"></p>
    </section>`;
  }

  function render(){
    root.innerHTML=controls()+mailAccountsSection()+'<div class="notice-toolbar"><p>Cảnh báo công việc & hộp thư hiện tại. Chỉ hiển thị nội dung bạn có quyền xem.</p><button type="button" data-notice-all>Đánh dấu tất cả đã đọc</button></div><div class="notice-list">'+(items.map((n,i)=>`<article class="notice-card ${n.read?'is-read':''}"><span class="notice-level">${n.level==='warning'?'Cần chú ý':(n.target==='webmail'?'iCloud Mail':'Thông báo')}</span><h3>${esc(n.title)}</h3><p>${esc(n.detail)}</p><div><button type="button" data-notice-open="${i}">${n.target==='webmail'?'Mở iCloud Mail ↗':'Mở mục xử lý'}</button>${!n.read?`<button type="button" data-notice-read="${i}">Đánh dấu đã đọc</button>`:''}</div></article>`).join('')||'<div class="notice-empty">Chưa có công việc cần chú ý.</div>')+'</div>';
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
      const rawPassword=String(fd.get('password')||'').trim();
      const displayName=String(fd.get('displayName')||'GAERU').trim()||'GAERU';
      const adminPassword=window.prompt('Nhập mật khẩu Quản trị viên tối cao (Owner) để xác thực thao tác mail iCloud @gaeru.com:');
      if(!adminPassword)return;
      const payload={action:'add',username,displayName,adminPassword};
      if(rawPassword)payload.password=rawPassword;
      const res=await admin.request('/api/gaeru_ceo/notifications/mail-accounts',{
        method:'POST',
        body:JSON.stringify(payload)
      });
      form.reset();
      await loadMailAccounts();
      if(st)st.textContent=res.message||(`Đã lưu địa chỉ ${username}@gaeru.com cho iCloud+ Mail.`);
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
        window.open('https://www.icloud.com/mail','_blank','noopener');
        return;
      }
      if(passBtn){
        const username=passBtn.dataset.mailPasswd;
        const password=window.prompt(`Nhập App-Specific Password Apple ID (dùng cho smtp.mail.me.com) cho ${username}@gaeru.com:`);
        if(!password)return;
        const adminPassword=window.prompt('Nhập mật khẩu Quản trị viên tối cao (Owner) để xác thực thao tác mail iCloud @gaeru.com:');
        if(!adminPassword)return;
        const res=await admin.request('/api/gaeru_ceo/notifications/mail-accounts',{
          method:'POST',
          body:JSON.stringify({action:'passwd',username,password,adminPassword})
        });
        await loadMailAccounts();
        if(st)st.textContent=res.message||(`Đã cập nhật cấu hình SMTP iCloud Mail cho ${username}@gaeru.com.`);
        return;
      }
      if(delBtn){
        const username=delBtn.dataset.mailDel;
        if(!window.confirm(`Xóa alias ${username}@gaeru.com khỏi danh sách quản trị?`))return;
        const adminPassword=window.prompt('Nhập mật khẩu Quản trị viên tối cao (Owner) để xác thực thao tác mail iCloud @gaeru.com:');
        if(!adminPassword)return;
        const res=await admin.request('/api/gaeru_ceo/notifications/mail-accounts',{
          method:'POST',
          body:JSON.stringify({action:'del',username,adminPassword})
        });
        await loadMailAccounts();
        if(st)st.textContent=res.message||(`Đã xóa alias ${username}@gaeru.com.`);
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
          if(n.target==='webmail')window.open('https://www.icloud.com/mail','_blank','noopener');
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
