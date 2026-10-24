(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.GAERUChatClient = { mount(root, {base,request,id=null,productSlug=null,admin=false}) {
    let stopped=false, busy=false, sending=false, thread=null, key=null, files=[];
    root.innerHTML = `<p class="chat-state" data-chat-state>Xin chào! AI của GAERU sẽ tiếp nhận câu hỏi của bạn trước.</p>
      <button type="button" data-chat-earlier hidden>Xem tin nhắn trước</button>
      <div class="shopping-messages" data-chat-messages aria-live="polite"></div>
      <form data-chat-compose><div data-chat-selected class="chat-selected"></div>
      <div class="chat-composer"><button type="button" class="chat-plus" aria-label="Thêm đính kèm" aria-expanded="false" aria-controls="${admin?'admin':'customer'}-chat-actions" data-chat-plus data-no-action-feedback>+</button>
      <label class="visually-hidden" for="${admin?'admin':'customer'}-chat-body">Tin nhắn</label><textarea id="${admin?'admin':'customer'}-chat-body" name="body" maxlength="3000" rows="2" placeholder="Bạn cần tư vấn điều gì?"></textarea>
      <button class="chat-send" type="submit" data-no-action-feedback aria-label="Gửi tin nhắn">↑</button></div>
      <div class="chat-actions" id="${admin?'admin':'customer'}-chat-actions" hidden>
      <button type="button" data-pick="file">▤ <span>Tệp<small>PDF, Word, Excel, TXT, CSV</small></span></button>
      <button type="button" data-pick="media">▧ <span>Ảnh / Video<small>Chọn từ thiết bị</small></span></button>
      ${admin?(window.GAERUAdmin?.can('marketing.read')?'<button type="button" data-offer="vouchers">▱ <span>Gửi voucher<small>Chọn ưu đãi đang có hiệu lực</small></span></button><button type="button" data-offer="campaigns">▤ <span>Chiến dịch<small>Chọn thông báo khuyến mại</small></span></button>':''):'<button type="button" data-reference="orders">▤ <span>Lịch sử đơn hàng<small>Chọn đơn của bạn</small></span></button><button type="button" data-reference="vouchers">▱ <span>Voucher<small>Ưu đãi trong ví của bạn</small></span></button>'}
      <button type="button" data-pick="camera">◎ <span>Máy ảnh<small>Chụp ảnh trên thiết bị hỗ trợ</small></span></button>
      <button type="button" data-pick="video">▷ <span>Máy quay<small>Quay video trên thiết bị hỗ trợ</small></span></button></div>
      <div data-chat-reference class="chat-reference" hidden></div>
      <input hidden type="file" data-file="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv">
      <input hidden type="file" data-file="media" accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime,video/webm">
      <input hidden type="file" data-file="camera" accept="image/jpeg,image/png,image/webp" capture="environment">
      <input hidden type="file" data-file="video" accept="video/mp4,video/quicktime,video/webm" capture="environment">
      <p role="status" data-chat-feedback></p></form>
      ${admin?'':'<div class="chat-ai"><button type="button" data-chat-ai data-no-action-feedback>Gặp nhân viên</button><p data-ai-note>AI tiếp nhận và trả lời tự động qua OpenAI, dựa trên câu hỏi, tin nhắn gần đây và dữ liệu sản phẩm. Không gửi tệp cho AI. Bạn có thể yêu cầu nhân viên bất cứ lúc nào. Không gửi mật khẩu hoặc OTP.</p></div>'}`;
    const messages=root.querySelector('[data-chat-messages]'), feedback=root.querySelector('[data-chat-feedback]'), form=root.querySelector('form'), send=form.querySelector('[type=submit]'), plus=root.querySelector('[data-chat-plus]'), actions=root.querySelector('.chat-actions');
    function renderFiles(){root.querySelector('[data-chat-selected]').innerHTML=files.map((f,i)=>`<span>${escape(f.file.name)} <button type="button" data-remove="${i}" aria-label="Bỏ tệp ${escape(f.file.name)}">×</button></span>`).join('');}
    function setClosed(){const closed=thread?.status==='closed';send.disabled=closed||sending;form.elements.body.disabled=closed||sending;plus.disabled=closed||sending;actions.querySelectorAll('button').forEach(b=>b.disabled=closed||sending);const human=root.querySelector('[data-chat-ai]');if(human){human.disabled=closed||sending||thread?.handlingMode==='human';human.textContent=thread?.handlingMode==='human'?'Đã chuyển nhân viên':'Gặp nhân viên';}}
    async function refresh(before){
      if(stopped||busy||!id)return;busy=true;
      try{
        const first=!messages.children.length,last=messages.lastElementChild?.dataset.messageId;
        const d=await request(base+'/'+id+'/messages'+(before?'?before='+before:!first&&last?'?after='+last:''));if(stopped)return;thread=d.thread;
        const near=messages.scrollHeight-messages.scrollTop-messages.clientHeight<60,oldHeight=messages.scrollHeight,oldTop=messages.scrollTop,known=new Set([...messages.children].map(e=>e.dataset.messageId));
        const html=d.messages.filter(m=>!known.has(String(m.id))).map(m=>`<article class="shopping-message ${m.sender==='customer'?'from-customer':'from-admin'}" data-message-id="${escape(m.id)}"><strong>${m.sender==='ai'?'GAERU AI':m.sender==='admin'?'GAERU':admin?'Khách':'Bạn'}</strong><p>${escape(m.body)}</p>${m.attachment?`<a class="chat-file-link" href="${base}/${id}/files/${encodeURIComponent(m.attachment.id)}" target="_blank" rel="noopener">↓ ${escape(m.attachment.name)} · ${Math.ceil(m.attachment.size/1024)} KB</a>`:''}<time>${escape(new Date(m.created_at).toLocaleString('vi-VN'))}</time></article>`).join('');
        if(before)messages.insertAdjacentHTML('afterbegin',html);else messages.insertAdjacentHTML('beforeend',html);
        if(before)messages.scrollTop=oldTop+messages.scrollHeight-oldHeight;else if(near||first)messages.scrollTop=messages.scrollHeight;
        if(first||before)root.querySelector('[data-chat-earlier]').hidden=!d.hasMore;
        root.querySelector('[data-chat-state]').textContent=(thread.status==='closed'?'Đã đóng · ':thread.handlingMode==='human'?'Chờ nhân viên · ':'AI đang hỗ trợ · ')+thread.product_name;setClosed();
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
      files.push({file,key:crypto.randomUUID()});renderFiles();feedback.textContent='Tệp sẵn sàng. Nhấn gửi để chia sẻ với nhân viên.';actions.hidden=true;plus.setAttribute('aria-expanded','false');
    });
    root.querySelector('[data-chat-selected]').onclick=e=>{const b=e.target.closest('[data-remove]');if(b&&!sending){files.splice(Number(b.dataset.remove),1);renderFiles();}};
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
        while(files.length){const item=files[0],data=new FormData();data.append('file',item.file);data.append('requestKey',item.key);await request(base+'/'+id+'/files',{method:'POST',body:data});files.shift();renderFiles();}
        key=null;form.reset();feedback.textContent='Đã gửi.';await refresh();
      }catch(error){feedback.textContent=error.message;}finally{sending=false;setClosed();}
    };
    const ai=root.querySelector('[data-chat-ai]');
    if(ai){
      ai.onclick=async()=>{if(sending)return;sending=true;setClosed();ai.disabled=true;try{if(!id){const d=await request(base,{method:'POST',body:JSON.stringify({productSlug,body:'Tôi muốn gặp nhân viên.',requestKey:crypto.randomUUID()})});id=d.thread.id;}await request(base+'/'+id+'/handoff',{method:'POST',body:JSON.stringify({})});await refresh();feedback.textContent='Đã chuyển cho nhân viên. Bạn có thể để lại thông tin để được hỗ trợ.';}catch(e){feedback.textContent=e.message;}finally{sending=false;setClosed();}};
    }
    const poll=window.GAERUCareLive.poll({delay:4000,active:()=>!stopped&&root.isConnected&&(!root.closest('dialog')||root.closest('dialog').open)&&!root.closest('.view-panel')?.hidden,run:()=>refresh(),status:()=>{}});
    if(id)refresh().catch(e=>feedback.textContent=e.message);
    return {refresh,stop(){stopped=true;poll.stop();},get thread(){return thread;}};
  }};
})();
