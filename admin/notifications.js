(()=>{
  const admin=window.GAERUAdmin,root=document.querySelector('#notifications-view');
  let items=[],loading=false,mailAccounts=[],mailLoading=false;
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

  function askPasswordModal(titleText, labelText){
    return new Promise(resolve=>{
      const overlay=document.createElement('div');
      overlay.setAttribute('role','dialog');
      overlay.setAttribute('aria-modal','true');
      overlay.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;';
      const card=document.createElement('form');
      card.style.cssText='background:#fff;border-radius:12px;padding:20px;max-width:420px;width:100%;box-shadow:0 20px 45px rgba(0,0,0,.22);display:flex;flex-direction:column;gap:12px;';
      const h=document.createElement('strong');
      h.textContent=titleText||'Xác thực thao tác';
      h.style.fontSize='15px';
      const p=document.createElement('label');
      p.textContent=labelText||'Nhập mật khẩu:';
      p.style.fontSize='13px';
      const input=document.createElement('input');
      input.type='password';
      input.autocomplete='current-password';
      input.required=true;
      input.style.cssText='width:100%;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;';
      p.appendChild(input);
      const actions=document.createElement('div');
      actions.style.cssText='display:flex;justify-content:flex-end;gap:8px;margin-top:4px;';
      const cancelBtn=document.createElement('button');
      cancelBtn.type='button';
      cancelBtn.textContent='Hủy';
      cancelBtn.className='secondary-button';
      const okBtn=document.createElement('button');
      okBtn.type='submit';
      okBtn.textContent='Xác nhận';
      okBtn.className='button';
      actions.append(cancelBtn,okBtn);
      card.append(h,p,actions);
      overlay.appendChild(card);
      const close=val=>{overlay.remove();resolve(val||null);};
      cancelBtn.addEventListener('click',()=>close(null));
      overlay.addEventListener('click',ev=>{if(ev.target===overlay)close(null);});
      card.addEventListener('submit',ev=>{ev.preventDefault();close(input.value.trim());});
      document.body.appendChild(overlay);
      input.focus();
    });
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
      const adminPassword=await askPasswordModal('Xác thực chủ doanh nghiệp (Owner)', 'Mật khẩu Quản trị viên tối cao để thêm hộp thư @gaeru.com:');
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
        const password=await askPasswordModal('Cập nhật App-Specific Password Apple ID', `App-Specific Password (smtp.mail.me.com) cho ${username}@gaeru.com:`);
        if(!password)return;
        const adminPassword=await askPasswordModal('Xác thực chủ doanh nghiệp (Owner)', `Mật khẩu Quản trị viên tối cao để cập nhật ${username}@gaeru.com:`);
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
        const adminPassword=await askPasswordModal('Xác thực chủ doanh nghiệp (Owner)', `Mật khẩu Quản trị viên tối cao để xóa ${username}@gaeru.com:`);
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
        const synced=await syncWebPushSubscription(true,{throwOnError:true});
        if(!synced)throw Error('Trình duyệt không hỗ trợ hoặc chưa kích hoạt được Service Worker Web Push.');
        const res=await admin.request('/api/gaeru_ceo/notifications/push-test',{method:'POST',body:'{}'});
        render();
        const st=root.querySelector('[data-notice-preference-status]');
        if(st)st.textContent=res.message||(res.ok?'Đã gửi thông báo đẩy thử nghiệm.':'Không gửi được thông báo đẩy.');
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
      render();
      if(nextStatus){
        const st=root.querySelector('[data-notice-preference-status]');
        if(st)st.textContent=nextStatus;
      }
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
            syncWebPushSubscription(true).then(()=>{render();}).catch(()=>{});
          }else{
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
