(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.GAERUChatClient = { mount(root, {base,request,id=null,productSlug=null,admin=false}) {
    let stopped=false, busy=false, sending=false, thread=null, key=null, files=[], supportReadAt=Date.now(), aiCapabilities=null, capabilitiesReadAt=0;
    root.innerHTML = `<p class="chat-state" data-chat-state>Xin chào! GAERU sẵn sàng hỗ trợ bạn.</p>
      <button type="button" data-chat-earlier hidden>Xem tin nhắn trước</button>
      <div class="shopping-messages" data-chat-messages aria-live="polite"></div><div class="chat-support-state" data-chat-support role="status" hidden></div>
      <form data-chat-compose><div data-chat-selected class="chat-selected"></div>
      <div class="chat-composer"><button type="button" class="chat-plus" aria-label="Thêm đính kèm" aria-expanded="false" aria-controls="${admin?'admin':'customer'}-chat-actions" data-chat-plus data-no-action-feedback>+</button>
      <label class="visually-hidden" for="${admin?'admin':'customer'}-chat-body">Tin nhắn</label><textarea id="${admin?'admin':'customer'}-chat-body" name="body" maxlength="3000" rows="2" placeholder="Bạn cần tư vấn điều gì?"></textarea>
      <button class="chat-send" type="submit" data-no-action-feedback aria-label="Gửi tin nhắn">↑</button></div>
      <div class="chat-actions" id="${admin?'admin':'customer'}-chat-actions" hidden>
      <button type="button" data-pick="file">▤ <span>Tệp<small>PDF, Word, Excel, TXT, CSV</small></span></button>
      <button type="button" data-pick="media">▧ <span>Ảnh / Video<small>Chọn từ thiết bị</small></span></button>
      ${admin?(window.GAERUAdmin?.can('marketing.read')?'<button type="button" data-offer="vouchers">▱ <span>Gửi voucher<small>Chọn ưu đãi đang có hiệu lực</small></span></button><button type="button" data-offer="campaigns">▤ <span>Chiến dịch<small>Chọn thông báo khuyến mại</small></span></button>':''):'<button type="button" data-reference="orders">▤ <span>Lịch sử đơn hàng<small>Chọn đơn của bạn</small></span></button><button type="button" data-reference="vouchers">▱ <span>Voucher<small>Ưu đãi trong ví của bạn</small></span></button>'}
      <button type="button" data-pick="camera">◎ <span>Máy ảnh<small>Chụp ảnh trên thiết bị hỗ trợ</small></span></button>
      <button type="button" data-pick="video">▷ <span>Máy quay<small>Quay video trên thiết bị hỗ trợ</small></span></button>${admin?'':'<button type="button" data-chat-human>☏ <span>Gặp nhân viên<small>Yêu cầu hỗ trợ trực tiếp</small></span></button>'}</div>
      <div data-chat-reference class="chat-reference" hidden></div>
      <input hidden type="file" data-file="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv">
      <input hidden type="file" data-file="media" accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime,video/webm">
      <input hidden type="file" data-file="camera" accept="image/jpeg,image/png,image/webp" capture="environment">
      <input hidden type="file" data-file="video" accept="video/mp4,video/quicktime,video/webm" capture="environment">
      <p role="status" data-chat-feedback></p></form>
      ${admin?'':'<div class="chat-ai"><p data-ai-note>Đang kiểm tra trạng thái Chat AI…</p></div>'}`;
    const messages=root.querySelector('[data-chat-messages]'), feedback=root.querySelector('[data-chat-feedback]'), form=root.querySelector('form'), send=form.querySelector('[type=submit]'), plus=root.querySelector('[data-chat-plus]'), actions=root.querySelector('.chat-actions');
    function media(url,mime,name){
      if(['image/jpeg','image/png','image/webp','image/heic'].includes(mime))return `<img class="chat-inline-media" src="${escape(url)}" alt="${escape(name)}" loading="lazy">`;
      if(['video/mp4','video/quicktime','video/webm'].includes(mime))return `<video class="chat-inline-media" controls playsinline preload="metadata" src="${escape(url)}">Thiết bị chưa phát được video này.</video>`;
      return '';
    }
    function attachment(file){const url=base+'/'+id+'/files/'+encodeURIComponent(file.id);return media(url,file.mime,file.name)+`<a class="chat-file-link" href="${escape(url)}?download=1" target="_blank" rel="noopener">↓ ${escape(file.name)} · ${Math.ceil(file.size/1024)} KB</a>`;}
    function release(file){if(file?.url)URL.revokeObjectURL(file.url);}
    function renderFiles(){root.querySelector('[data-chat-selected]').innerHTML=files.map((f,i)=>`<figure class="chat-preview">${f.url?media(f.url,f.file.type,f.file.name):''}<figcaption>${escape(f.file.name)}<small>Chưa gửi</small><small data-media-error hidden>Thiết bị chưa xem được định dạng này. Bạn vẫn có thể gửi tệp.</small></figcaption><button type="button" data-remove="${i}" aria-label="Bỏ tệp ${escape(f.file.name)}" ${sending?'disabled':''}>×</button></figure>`).join('');root.querySelectorAll('.chat-preview img,.chat-preview video').forEach(el=>el.addEventListener('error',()=>{el.hidden=true;el.closest('figure').querySelector('[data-media-error]').hidden=false;},{once:true}));}
    function renderAINote(){
      if(admin)return;const note=root.querySelector('[data-ai-note]'),names={openai:'OpenAI / GPT',gemini:'Google Gemini',claude:'Anthropic Claude'};let text;
      if(thread?.status==='closed')text='Hội thoại đã đóng. Mở một hội thoại mới khi bạn cần hỗ trợ.';
      else if(thread?.handlingMode==='human')text='Hội thoại được nhân viên GAERU hỗ trợ. AI đã tạm dừng trong hội thoại này.';
      else if(!aiCapabilities)text='Chưa xác minh được trạng thái Chat AI. Bạn vẫn có thể yêu cầu nhân viên hỗ trợ.';
      else if(!aiCapabilities.aiConfigured)text='Chat AI chưa bật hoặc chưa đủ cấu hình. Chọn Gặp nhân viên để được hỗ trợ.';
      else text=(names[aiCapabilities.provider]||'Chat AI')+(thread?.handoffOffered?' đang tạm dừng trả lời. Bạn có thể kết nối nhân viên.':' đang được bật để hỗ trợ tự động.')+' Chỉ gửi câu hỏi, tin nhắn gần đây và dữ liệu sản phẩm cho AI; tệp dành cho nhân viên. Không gửi mật khẩu hoặc OTP.';
      if(note.textContent!==text)note.textContent=text;if(!thread){const state=root.querySelector('[data-chat-state]');state.textContent=aiCapabilities?.aiConfigured?'Xin chào! '+(names[aiCapabilities.provider]||'AI của GAERU')+' sẽ tiếp nhận câu hỏi của bạn.':'Xin chào! Bạn có thể gửi yêu cầu cho nhân viên GAERU.';}
    }
    async function loadCapabilities(){capabilitiesReadAt=Date.now();try{aiCapabilities=await request('/api/shopping-chat/capabilities');}catch{aiCapabilities=null;}if(!stopped)renderAINote();}
    function syncSupport(){
      renderAINote();
      const closed=thread?.status==='closed',human=root.querySelector('[data-chat-human]');if(human)human.hidden=closed||thread?.handlingMode==='human';
      const state=root.querySelector('[data-chat-support]');state.hidden=admin||closed||(!thread?.handoffOffered&&thread?.handlingMode!=='human')||thread?.staffReplied===true;
      if(!state.hidden){const seconds=(thread.handoffWaitSeconds||0)+(Date.now()-supportReadAt)/1000;const html=thread.handoffOffered?'AI chưa thể tiếp tục trả lời. Kết nối nhân viên GAERU để được hỗ trợ.<button type="button" class="chat-handoff-button" data-inline-handoff data-no-action-feedback '+(sending?'disabled':'')+'>Gặp nhân viên</button>':seconds>=300?'Chưa có nhân viên phản hồi sau 5 phút. Gọi <a href="tel:0829191080">082.919.1080</a> để được hỗ trợ nhanh chóng.':'Đang chờ kết nối nhân viên hỗ trợ GAERU…';if(state.dataset.renderKey!==html){state.innerHTML=html;state.dataset.renderKey=html;}}
    }

    function setClosed(){const closed=thread?.status==='closed';send.disabled=closed||sending;form.elements.body.disabled=closed||sending;plus.disabled=closed||sending;actions.querySelectorAll('button').forEach(b=>b.disabled=closed||sending);syncSupport();}
    async function refresh(before){
      if(stopped||busy||!id)return;busy=true;
      try{
        const first=!messages.children.length,last=messages.lastElementChild?.dataset.messageId;
        const d=await request(base+'/'+id+'/messages'+(before?'?before='+before:!first&&last?'?after='+last:''));if(stopped)return;thread=d.thread;supportReadAt=Date.now();if(!admin&&Date.now()-capabilitiesReadAt>60000)void loadCapabilities();
        const near=messages.scrollHeight-messages.scrollTop-messages.clientHeight<60,oldHeight=messages.scrollHeight,oldTop=messages.scrollTop,known=new Set([...messages.children].map(e=>e.dataset.messageId));
        const html=d.messages.filter(m=>!known.has(String(m.id))).map(m=>`<article class="shopping-message ${m.sender==='customer'?'from-customer':'from-admin'}" data-message-id="${escape(m.id)}" data-sender="${escape(m.sender)}"><strong>${m.sender==='ai'?'GAERU AI':m.sender==='admin'?'GAERU':admin?'Khách':'Bạn'}</strong><p>${escape(m.body)}</p>${m.attachment?attachment(m.attachment):''}<time>${escape(new Date(m.created_at).toLocaleString('vi-VN'))}</time></article>`).join('');
        if(before)messages.insertAdjacentHTML('afterbegin',html);else messages.insertAdjacentHTML('beforeend',html);
        if(before)messages.scrollTop=oldTop+messages.scrollHeight-oldHeight;else if(near||first)messages.scrollTop=messages.scrollHeight;
        if(first||before)root.querySelector('[data-chat-earlier]').hidden=!d.hasMore;
        root.querySelector('[data-chat-state]').textContent=(thread.status==='closed'?'Đã đóng · ':thread.handlingMode==='human'?(thread.staffReplied?'Nhân viên đang hỗ trợ · ':'Chờ nhân viên · '):thread.handoffOffered?'AI tạm dừng · ':'AI đang hỗ trợ · ')+thread.product_name;setClosed();
        if(d.hasMore&&!before&&!first)setTimeout(()=>refresh(),0);
      }finally{busy=false;}
    }
    form.elements.body.addEventListener('focus',()=>{actions.hidden=true;plus.setAttribute('aria-expanded','false');root.querySelector('[data-chat-reference]').hidden=true;});
    plus.onclick=()=>{actions.hidden=!actions.hidden;plus.setAttribute('aria-expanded',String(!actions.hidden));};
    root.querySelector('[data-chat-earlier]').onclick=()=>refresh(messages.firstElementChild?.dataset.messageId).catch(e=>feedback.textContent=e.message);
    root.querySelectorAll('[data-pick]').forEach(button=>button.onclick=()=>root.querySelector('[data-file="'+button.dataset.pick+'"]').click());
    root.querySelectorAll('[data-file]').forEach(input=>input.onchange=()=>{
      const file=input.files[0];input.value='';if(!file)return;
      if(file.size>10485760){feedback.textContent='Mỗi tệp tối đa 10 MB.';return;}
      if(files.length>=3){feedback.textContent='Chọn tối đa 3 tệp mỗi lần gửi.';return;}
      files.push({file,key:crypto.randomUUID(),url:/^(image|video)\//.test(file.type)?URL.createObjectURL(file):null});renderFiles();feedback.textContent='Tệp sẵn sàng. Nhấn gửi để chia sẻ với nhân viên.';actions.hidden=true;plus.setAttribute('aria-expanded','false');
    });
    root.querySelector('[data-chat-selected]').onclick=e=>{const b=e.target.closest('[data-remove]');if(b&&!sending){release(files.splice(Number(b.dataset.remove),1)[0]);renderFiles();}};
    root.querySelectorAll('[data-reference]').forEach(button=>button.onclick=async()=>{
      const target=root.querySelector('[data-chat-reference]');target.hidden=false;target.textContent='Đang tải…';
      try{
        const orders=button.dataset.reference==='orders',d=await request(orders?'/api/customer/orders':'/api/customer/marketing'),rows=orders?d.orders:d.wallet;
        target.innerHTML='<p>Chọn để đưa vào tin nhắn (chưa gửi):</p>'+(rows.length?rows.map((r,i)=>`<button type="button" data-reference-item="${i}">${escape(orders?'Đơn '+r.orderNumber:r.code+' · '+r.title)}</button>`).join(''):'<p>Chưa có dữ liệu.</p>')+'<button type="button" data-reference-close>Đóng</button>';
        target.querySelector('[data-reference-close]').onclick=()=>target.hidden=true;
        target.querySelectorAll('[data-reference-item]').forEach(b=>b.onclick=()=>{const r=rows[Number(b.dataset.referenceItem)],text=orders?'Tôi cần hỗ trợ đơn hàng '+r.orderNumber+'.':'Tôi cần tư vấn voucher '+r.code+'.';form.elements.body.value=(form.elements.body.value+'\n'+text).trim().slice(0,3000);target.hidden=true;actions.hidden=true;plus.setAttribute('aria-expanded','false');form.elements.body.focus();});
      }catch(e){target.innerHTML='<p>'+escape(e.message)+'</p><a href="account.html">Đăng nhập tài khoản</a>';}
    });
    root.querySelectorAll('[data-offer]').forEach(button=>button.onclick=async()=>{
      const target=root.querySelector('[data-chat-reference]');let page=1;
      async function loadOffers(){
        target.hidden=false;target.textContent='Đang tải…';
        try{
          const d=await request(base+'/'+id+'/offers?kind='+button.dataset.offer+'&page='+page);
          target.innerHTML='<p>Chọn để soạn tin, sau đó nhấn gửi:</p>'+(d.items.length?d.items.map((r,i)=>`<button type="button" data-offer-item="${i}">${escape(r.title)}</button>`).join(''):'<p>Không có chương trình còn hiệu lực phù hợp với khách này.</p>')+`<div class="chat-offer-pages"><button type="button" data-offer-prev ${page===1?'disabled':''}>Trước</button><span>Trang ${page}</span><button type="button" data-offer-next ${d.hasMore?'':'disabled'}>Tiếp</button><button type="button" data-offer-close>Đóng</button></div>`;
          target.querySelector('[data-offer-close]').onclick=()=>target.hidden=true;
          target.querySelector('[data-offer-prev]').onclick=()=>{page--;loadOffers();};target.querySelector('[data-offer-next]').onclick=()=>{page++;loadOffers();};
          target.querySelectorAll('[data-offer-item]').forEach(b=>b.onclick=()=>{form.elements.body.value=d.items[Number(b.dataset.offerItem)].text;target.hidden=true;actions.hidden=true;plus.setAttribute('aria-expanded','false');form.elements.body.focus();feedback.textContent='Đã soạn ưu đãi. Kiểm tra nội dung rồi nhấn gửi.';});
        }catch(e){target.textContent=e.message;}
      }await loadOffers();
    });
    form.onsubmit=async e=>{
      e.preventDefault();if(sending)return;feedback.textContent='';sending=true;setClosed();key ||= crypto.randomUUID();
      try{
        const body=form.elements.body.value.trim()||(files.length?'Tôi gửi tệp để được tư vấn.':'');if(!body)throw Error('Nhập tin nhắn hoặc chọn tệp.');
        if(!id){const d=await request(base,{method:'POST',body:JSON.stringify({productSlug,body,requestKey:key})});id=d.thread.id;}
        else await request(base+'/'+id+'/messages',{method:'POST',body:JSON.stringify({body,requestKey:key})});
        while(files.length){const item=files[0],data=new FormData();data.append('file',item.file);data.append('requestKey',item.key);await request(base+'/'+id+'/files',{method:'POST',body:data});release(files.shift());renderFiles();}
        key=null;form.reset();feedback.textContent='Đã gửi.';await refresh();
      }catch(error){feedback.textContent=error.message;}finally{sending=false;setClosed();}
    };
    async function requestHuman(){if(sending||thread?.status==='closed')return;sending=true;setClosed();try{if(!id){const d=await request(base,{method:'POST',body:JSON.stringify({productSlug,body:'Tôi muốn gặp nhân viên.',requestKey:crypto.randomUUID()})});id=d.thread.id;}await request(base+'/'+id+'/handoff',{method:'POST',body:JSON.stringify({})});await refresh();feedback.textContent='';}catch(e){feedback.textContent=e.message;}finally{sending=false;setClosed();}}
    root.addEventListener('click',event=>{if(event.target.closest('[data-inline-handoff],[data-chat-human]'))void requestHuman();});
    const supportTimer=setInterval(()=>{if(!stopped)syncSupport();},1000);
    if(!admin)void loadCapabilities();
    const poll=window.GAERUCareLive.poll({delay:4000,active:()=>!stopped&&root.isConnected&&(!root.closest('dialog')||root.closest('dialog').open)&&!root.closest('.view-panel')?.hidden,run:()=>{if(!admin&&Date.now()-capabilitiesReadAt>60000)void loadCapabilities();return refresh();},status:()=>{}});
    if(id)refresh().catch(e=>feedback.textContent=e.message);
    return {refresh,stop(){stopped=true;poll.stop();clearInterval(supportTimer);files.forEach(release);files=[];},get thread(){return thread;}};
  }};
})();
