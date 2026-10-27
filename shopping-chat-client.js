(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.GAERUChatClient = { mount(root, {base,request,id=null,productSlug=null,admin=false}) {
    let stopped=false, busy=false, sending=false, thread=null, key=null, files=[], supportReadAt=Date.now(), aiCapabilities=null, capabilitiesReadAt=0, bgChain=Promise.resolve();
    const quickReplies = admin
      ? [
          'Xin chào! GAERU đã nhận thông tin và đang kiểm tra giúp bạn.',
          'Bạn vui lòng gửi thêm hình ảnh hoặc video tình trạng thiết bị nhé.',
          'Đơn hàng của bạn đang được chuẩn bị bàn giao cho đơn vị vận chuyển.',
          'Cảm ơn bạn đã liên hệ GAERU! Bạn cần hỗ trợ thêm thông tin gì không?'
        ]
      : [
          'Tư vấn chọn phiên bản phù hợp',
          'Kiểm tra tồn kho & ưu đãi',
          'Hướng dẫn kết nối thiết bị',
          'Chính sách bảo hành Care+'
        ];
    root.innerHTML = `<p class="chat-state" data-chat-state>Xin chào! GAERU sẵn sàng hỗ trợ bạn.</p>
      <button type="button" data-chat-earlier hidden>Xem tin nhắn trước</button>
      <div class="shopping-messages" data-chat-messages aria-live="polite"></div><div class="chat-support-state" data-chat-support role="status" hidden></div>
      <form data-chat-compose>
      <div class="chat-quick-bar" data-chat-quick-bar>
        <div class="chat-quick-header">
          <button type="button" class="chat-quick-toggle" data-chat-quick-toggle data-no-action-feedback aria-expanded="true">⚡ Chọn hiển thị phản hồi nhanh</button>
          <label class="chat-instant-toggle"><input type="checkbox" data-chat-instant-mode checked> <span>Gửi nhanh ngay</span></label>
        </div>
        <div class="chat-quick-list" data-chat-quick-list>${quickReplies.map((q,i)=>`<button type="button" class="chat-quick-chip" data-quick-reply="${i}" data-no-action-feedback>${escape(q)}</button>`).join('')}</div>
      </div>
      <div data-chat-selected class="chat-selected"></div>
      <div class="chat-composer"><button type="button" class="chat-plus" aria-label="Thêm đính kèm" aria-expanded="false" aria-controls="${admin?'admin':'customer'}-chat-actions" data-chat-plus data-no-action-feedback>+</button>
      <label class="visually-hidden" for="${admin?'admin':'customer'}-chat-body">Tin nhắn</label><textarea id="${admin?'admin':'customer'}-chat-body" name="body" maxlength="3000" rows="2" placeholder="Bạn cần tư vấn điều gì?"></textarea>
      <button class="chat-send" type="submit" data-no-action-feedback aria-label="Gửi tin nhắn">↑</button></div>
      <div class="chat-actions" id="${admin?'admin':'customer'}-chat-actions" hidden>
      <button type="button" data-pick="file">▤ <span>Tệp<small>Không giới hạn dung lượng · Tự động nén ngầm</small></span></button>
      <button type="button" data-pick="media">▧ <span>Ảnh / Video<small>Không giới hạn dung lượng · Tải ngầm sau khi gửi</small></span></button>
      ${admin?(window.GAERUAdmin?.can('marketing.read')?'<button type="button" data-offer="vouchers">▱ <span>Gửi voucher<small>Chọn ưu đãi đang có hiệu lực</small></span></button><button type="button" data-offer="campaigns">▤ <span>Chiến dịch<small>Chọn thông báo khuyến mại</small></span></button>':''):'<button type="button" data-reference="orders">▤ <span>Lịch sử đơn hàng<small>Chọn đơn của bạn</small></span></button><button type="button" data-reference="vouchers">▱ <span>Voucher<small>Ưu đãi trong ví của bạn</small></span></button>'}
      <button type="button" data-pick="camera">◎ <span>Máy ảnh<small>Chụp ảnh trên thiết bị hỗ trợ</small></span></button>
      <button type="button" data-pick="video">▷ <span>Máy quay<small>Quay video trên thiết bị hỗ trợ</small></span></button>${admin?'':'<button type="button" data-chat-human>☏ <span>Gặp nhân viên<small>Yêu cầu hỗ trợ trực tiếp</small></span></button>'}</div>
      <div data-chat-reference class="chat-reference" hidden></div>
      <input hidden type="file" multiple data-file="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.txt,.csv">
      <input hidden type="file" multiple data-file="media" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo">
      <input hidden type="file" data-file="camera" accept="image/jpeg,image/png,image/webp" capture="environment">
      <input hidden type="file" data-file="video" accept="video/mp4,video/quicktime,video/webm" capture="environment">
      <p role="status" data-chat-feedback></p></form>
      ${admin?'':'<div class="chat-ai"><p data-ai-note>Đang kiểm tra trạng thái Chat AI…</p></div>'}`;
    const messages=root.querySelector('[data-chat-messages]'), feedback=root.querySelector('[data-chat-feedback]'), form=root.querySelector('form'), send=form.querySelector('[type=submit]'), plus=root.querySelector('[data-chat-plus]'), actions=root.querySelector('.chat-actions');
    const nearBottom=()=>messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;
    function scrollToLatest(smooth=false){messages.scrollTo({top:messages.scrollHeight,behavior:smooth&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'instant'});}
    let composing=false;
    form.elements.body.addEventListener('compositionstart',()=>composing=true);
    form.elements.body.addEventListener('compositionend',()=>composing=false);
    form.elements.body.addEventListener('keydown',event=>{
      if(event.key!=='Enter'||event.shiftKey||event.ctrlKey||event.altKey||event.metaKey||event.isComposing||composing||event.keyCode===229)return;
      event.preventDefault();if(!sending&&!send.disabled&&(form.elements.body.value.trim()||files.length))form.requestSubmit(send);
    });
    function media(url,mime,name){
      if(['image/jpeg','image/png','image/webp','image/gif','image/heic'].includes(mime)||String(mime||'').startsWith('image/'))return `<img class="chat-inline-media" src="${escape(url)}" alt="${escape(name)}" loading="lazy">`;
      if(['video/mp4','video/quicktime','video/webm'].includes(mime)||String(mime||'').startsWith('video/'))return `<video class="chat-inline-media" controls playsinline preload="metadata" src="${escape(url)}">Thiết bị chưa phát được video này.</video>`;
      return '';
    }
    function formatSize(bytes){
      const n=Number(bytes)||0;
      if(n>=1073741824)return (n/1073741824).toFixed(2)+' GB';
      if(n>=1048576)return (n/1048576).toFixed(1)+' MB';
      return Math.max(1,Math.ceil(n/1024))+' KB';
    }
    function attachment(file){
      const url=base+'/'+id+'/files/'+encodeURIComponent(file.id);
      const saved=file.originalSize&&file.compressedSize&&file.compressedSize<file.originalSize?` · Đã nén tự động (${formatSize(file.compressedSize)})`:'';
      return media(url,file.mime,file.name)+`<a class="chat-file-link" href="${escape(url)}?download=1" target="_blank" rel="noopener">↓ ${escape(file.name)} · ${formatSize(file.size)}${escape(saved)}</a>`;
    }
    function release(file){if(file?.url)URL.revokeObjectURL(file.url);}
    function renderFiles(){
      root.querySelector('[data-chat-selected]').innerHTML=files.map((f,i)=>`<figure class="chat-preview">${f.url?media(f.url,f.file.type,f.file.name):''}<figcaption>${escape(f.file.name)}<small>${formatSize(f.file.size)} · Sẵn sàng gửi nhanh & tải ngầm</small><small data-media-error hidden>Thiết bị chưa xem được định dạng này. Bạn vẫn có thể gửi tệp.</small></figcaption><button type="button" data-remove="${i}" aria-label="Bỏ tệp ${escape(f.file.name)}">×</button></figure>`).join('');
      root.querySelectorAll('.chat-preview img,.chat-preview video').forEach(el=>el.addEventListener('error',()=>{el.hidden=true;el.closest('figure').querySelector('[data-media-error]').hidden=false;},{once:true}));
    }
    async function compressFileInBackground(rawFile){
      if(!rawFile||typeof rawFile.size!=='number')return rawFile;
      if(['image/jpeg','image/png'].includes(rawFile.type)&&rawFile.size>307200&&typeof createImageBitmap==='function'&&typeof document!=='undefined'){
        try{
          const bmp=await createImageBitmap(rawFile);
          const maxDim=2048;
          const scale=Math.min(1,maxDim/Math.max(bmp.width||1,bmp.height||1));
          const w=Math.max(1,Math.round(bmp.width*scale)),h=Math.max(1,Math.round(bmp.height*scale));
          const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
          const ctx=canvas.getContext('2d');ctx.drawImage(bmp,0,0,w,h);bmp.close?.();
          const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.86));
          if(blob&&blob.size>0&&blob.size<rawFile.size){
            const nextName=rawFile.name.replace(/\.[^.]+$/,'')+'.webp';
            return new File([blob],nextName,{type:'image/webp'});
          }
        }catch{}
      }
      return rawFile;
    }
    function renderAINote(){
      if(admin)return;const note=root.querySelector('[data-ai-note]'),names={openai:'OpenAI / GPT',gemini:'Google Gemini',claude:'Anthropic Claude'};let text;
      if(thread?.status==='closed')text='Hội thoại đã đóng. Mở một hội thoại mới khi bạn cần hỗ trợ.';
      else if(thread?.handlingMode==='human')text='Hội thoại được nhân viên GAERU hỗ trợ. AI đã tạm dừng trong hội thoại này.';
      else if(!aiCapabilities)text='Chưa xác minh được trạng thái Chat AI. Bạn vẫn có thể yêu cầu nhân viên hỗ trợ.';
      else if(!aiCapabilities.aiConfigured)text='Chat AI chưa bật hoặc chưa đủ cấu hình. Chọn Gặp nhân viên để được hỗ trợ.';
      else text=(names[aiCapabilities.provider]||'Chat AI')+(thread?.handoffOffered?' đang tạm dừng trả lời. Bạn có thể kết nối nhân viên.':' đang được bật để hỗ trợ tự động.')+' Hỗ trợ gửi nhanh, tải tệp/ảnh/video không giới hạn dung lượng và tự động nén ngầm.';
      if(note.textContent!==text)note.textContent=text;if(!thread){const state=root.querySelector('[data-chat-state]');state.textContent=aiCapabilities?.aiConfigured?'Xin chào! '+(names[aiCapabilities.provider]||'AI của GAERU')+' sẽ tiếp nhận câu hỏi của bạn.':'Xin chào! Bạn có thể gửi yêu cầu cho nhân viên GAERU.';}
    }
    async function loadCapabilities(){capabilitiesReadAt=Date.now();try{aiCapabilities=await request('/api/shopping-chat/capabilities');}catch{aiCapabilities=null;}if(!stopped)renderAINote();}
    function syncSupport(){
      renderAINote();
      const closed=thread?.status==='closed',human=root.querySelector('[data-chat-human]');if(human)human.hidden=closed||thread?.handlingMode==='human';
      const state=root.querySelector('[data-chat-support]');state.hidden=admin||closed||(!thread?.handoffOffered&&thread?.handlingMode!=='human')||thread?.staffReplied===true;
      if(!state.hidden){const seconds=(thread.handoffWaitSeconds||0)+(Date.now()-supportReadAt)/1000;const html=thread.handoffOffered?'AI chưa thể tiếp tục trả lời. Kết nối nhân viên GAERU để được hỗ trợ.<button type="button" class="chat-handoff-button" data-inline-handoff data-no-action-feedback>Gặp nhân viên</button>':seconds>=300?'Chưa có nhân viên phản hồi sau 5 phút. Gọi <a href="tel:0829191080">082.919.1080</a> để được hỗ trợ nhanh chóng.':'Đang chờ kết nối nhân viên hỗ trợ GAERU…';if(state.dataset.renderKey!==html){state.innerHTML=html;state.dataset.renderKey=html;}}
    }

    function setClosed(){const closed=thread?.status==='closed';send.disabled=closed;form.elements.body.disabled=closed;plus.disabled=closed;actions.querySelectorAll('button').forEach(b=>b.disabled=closed);root.querySelectorAll('[data-quick-reply]').forEach(b=>b.disabled=closed);syncSupport();}
    async function refresh(before){
      if(stopped||busy||!id)return;busy=true;
      try{
        const confirmedNodes=[...messages.querySelectorAll('[data-message-id]')];
        const first=!confirmedNodes.length,last=confirmedNodes.at(-1)?.dataset.messageId;
        const d=await request(base+'/'+id+'/messages'+(before?'?before='+before:!first&&last?'?after='+last:''));if(stopped)return;thread=d.thread;supportReadAt=Date.now();if(!admin&&Date.now()-capabilitiesReadAt>60000)void loadCapabilities();
        const near=nearBottom(),oldHeight=messages.scrollHeight,oldTop=messages.scrollTop,known=new Set(confirmedNodes.map(e=>e.dataset.messageId));
        for(const m of d.messages){if(m.requestKey){const opt=messages.querySelector(`[data-optimistic-key="${CSS?.escape?CSS.escape(m.requestKey):m.requestKey}"]`);if(opt)opt.remove();}}
        const html=d.messages.filter(m=>!known.has(String(m.id))).map(m=>`<article class="shopping-message ${m.sender==='customer'?'from-customer':'from-admin'}" data-message-id="${escape(m.id)}" data-sender="${escape(m.sender)}"><strong>${m.sender==='ai'?'GAERU AI':m.sender==='admin'?'GAERU':admin?'Khách':'Bạn'}</strong><p>${escape(m.body)}</p>${m.attachment?attachment(m.attachment):''}<time>${escape(new Date(m.created_at).toLocaleString('vi-VN'))}</time></article>`).join('');
        if(before)messages.insertAdjacentHTML('afterbegin',html);
        else{
          const firstOptimistic=messages.querySelector('[data-optimistic-key]');
          if(firstOptimistic)firstOptimistic.insertAdjacentHTML('beforebegin',html);
          else messages.insertAdjacentHTML('beforeend',html);
        }
        if(before)messages.scrollTop=oldTop+messages.scrollHeight-oldHeight;else if(html&&(near||first))scrollToLatest(!first);
        if(first||before)root.querySelector('[data-chat-earlier]').hidden=!d.hasMore;
        root.querySelector('[data-chat-state]').textContent=(thread.status==='closed'?'Đã đóng · ':thread.handlingMode==='human'?(thread.staffReplied?'Nhân viên đang hỗ trợ · ':'Chờ nhân viên · '):thread.handoffOffered?'AI tạm dừng · ':'AI đang hỗ trợ · ')+thread.product_name;setClosed();
        if(d.hasMore&&!before&&!first)setTimeout(()=>refresh(),0);
      }finally{busy=false;}
    }

    const quickToggle=root.querySelector('[data-chat-quick-toggle]'),quickList=root.querySelector('[data-chat-quick-list]'),instantCheck=root.querySelector('[data-chat-instant-mode]');
    if(quickToggle&&quickList){
      quickToggle.onclick=()=>{quickList.hidden=!quickList.hidden;quickToggle.setAttribute('aria-expanded',String(!quickList.hidden));};
      quickList.onclick=e=>{
        const chip=e.target.closest('[data-quick-reply]');if(!chip||thread?.status==='closed')return;
        const text=quickReplies[Number(chip.dataset.quickReply)];if(!text)return;
        if(instantCheck?.checked){dispatchInstantSend(text,[]);}
        else{form.elements.body.value=(form.elements.body.value?form.elements.body.value+'\n'+text:text).slice(0,3000);form.elements.body.focus();}
      };
    }

    form.elements.body.addEventListener('focus',()=>{actions.hidden=true;plus.setAttribute('aria-expanded','false');root.querySelector('[data-chat-reference]').hidden=true;});
    plus.onclick=()=>{actions.hidden=!actions.hidden;plus.setAttribute('aria-expanded',String(!actions.hidden));};
    root.querySelector('[data-chat-earlier]').onclick=()=>refresh(messages.querySelector('[data-message-id]')?.dataset.messageId).catch(e=>feedback.textContent=e.message);
    root.querySelectorAll('[data-pick]').forEach(button=>button.onclick=()=>root.querySelector('[data-file="'+button.dataset.pick+'"]').click());
    root.querySelectorAll('[data-file]').forEach(input=>input.onchange=()=>{
      const picked=[...(input.files||[])];input.value='';if(!picked.length)return;
      for(const file of picked){
        files.push({file,key:crypto.randomUUID(),url:/^(image|video)\//.test(file.type)?URL.createObjectURL(file):null});
      }
      renderFiles();
      feedback.textContent=`Đã chọn ${files.length} tệp. Nhấn gửi để hiển thị ngay và tải ngầm tự động.`;
      actions.hidden=true;plus.setAttribute('aria-expanded','false');
    });
    root.querySelector('[data-chat-selected]').onclick=e=>{const b=e.target.closest('[data-remove]');if(b){release(files.splice(Number(b.dataset.remove),1)[0]);renderFiles();}};
    root.querySelectorAll('[data-reference]').forEach(button=>button.onclick=async()=>{
      const target=root.querySelector('[data-chat-reference]');target.hidden=false;target.textContent='Đang tải…';
      try{
        const orders=button.dataset.reference==='orders',d=await request(orders?'/api/customer/orders':'/api/customer/marketing'),rows=orders?d.orders:d.wallet;
        target.innerHTML='<p>Chọn để phản hồi nhanh:</p>'+(rows.length?rows.map((r,i)=>`<button type="button" data-reference-item="${i}">${escape(orders?'Đơn '+r.orderNumber:r.code+' · '+r.title)}</button>`).join(''):'<p>Chưa có dữ liệu.</p>')+'<button type="button" data-reference-close>Đóng</button>';
        target.querySelector('[data-reference-close]').onclick=()=>target.hidden=true;
        target.querySelectorAll('[data-reference-item]').forEach(b=>b.onclick=()=>{
          const r=rows[Number(b.dataset.referenceItem)],text=orders?'Tôi cần hỗ trợ đơn hàng '+r.orderNumber+'.':'Tôi cần tư vấn voucher '+r.code+'.';
          target.hidden=true;actions.hidden=true;plus.setAttribute('aria-expanded','false');
          if(instantCheck?.checked)dispatchInstantSend(text,[]);
          else{form.elements.body.value=(form.elements.body.value+'\n'+text).trim().slice(0,3000);form.elements.body.focus();}
        });
      }catch(e){target.innerHTML='<p>'+escape(e.message)+'</p><a href="account.html">Đăng nhập tài khoản</a>';}
    });
    root.querySelectorAll('[data-offer]').forEach(button=>button.onclick=async()=>{
      const target=root.querySelector('[data-chat-reference]');let page=1;
      async function loadOffers(){
        target.hidden=false;target.textContent='Đang tải…';
        try{
          const d=await request(base+'/'+id+'/offers?kind='+button.dataset.offer+'&page='+page);
          target.innerHTML='<p>Chọn để gửi nhanh hoặc soạn tin:</p>'+(d.items.length?d.items.map((r,i)=>`<button type="button" data-offer-item="${i}">${escape(r.title)}</button>`).join(''):'<p>Không có chương trình còn hiệu lực phù hợp với khách này.</p>')+`<div class="chat-offer-pages"><button type="button" data-offer-prev ${page===1?'disabled':''}>Trước</button><span>Trang ${page}</span><button type="button" data-offer-next ${d.hasMore?'':'disabled'}>Tiếp</button><button type="button" data-offer-close>Đóng</button></div>`;
          target.querySelector('[data-offer-close]').onclick=()=>target.hidden=true;
          target.querySelector('[data-offer-prev]').onclick=()=>{page--;loadOffers();};target.querySelector('[data-offer-next]').onclick=()=>{page++;loadOffers();};
          target.querySelectorAll('[data-offer-item]').forEach(b=>b.onclick=()=>{
            const text=d.items[Number(b.dataset.offerItem)].text;
            target.hidden=true;actions.hidden=true;plus.setAttribute('aria-expanded','false');
            if(instantCheck?.checked)dispatchInstantSend(text,[]);
            else{form.elements.body.value=text;form.elements.body.focus();feedback.textContent='Đã soạn ưu đãi. Kiểm tra nội dung rồi nhấn gửi.';}
          });
        }catch(e){target.textContent=e.message;}
      }await loadOffers();
    });

    async function uploadFileInBackground(threadId,item,statusNode){
      if(statusNode)statusNode.textContent='Đang nén tệp ngầm tự động…';
      const prepared=await compressFileInBackground(item.file);
      const chunkBytes=aiCapabilities?.chunkSizeBytes||4194304;
      if(prepared.size>chunkBytes){
        const totalChunks=Math.ceil(prepared.size/chunkBytes);
        for(let i=0;i<totalChunks;i++){
          const slice=prepared.slice(i*chunkBytes,Math.min(prepared.size,(i+1)*chunkBytes));
          const data=new FormData();
          data.append('file',slice,prepared.name);
          data.append('requestKey',item.key);
          data.append('fileName',prepared.name);
          data.append('chunkIndex',String(i));
          data.append('totalChunks',String(totalChunks));
          data.append('totalBytes',String(prepared.size));
          const pct=Math.round(((i+1)/totalChunks)*100);
          if(statusNode)statusNode.textContent=`Đang tải ngầm & nén tự động… ${pct}%`;
          await request(base+'/'+threadId+'/files/chunk',{method:'POST',body:data});
        }
      }else{
        if(statusNode)statusNode.textContent='Đang tải lên hệ thống ngầm…';
        const data=new FormData();
        data.append('file',prepared,prepared.name);
        data.append('requestKey',item.key);
        await request(base+'/'+threadId+'/files',{method:'POST',body:data});
        void request(base+'/'+threadId+'/files/compress',{method:'POST',body:'{}'}).catch(()=>{});
      }
    }

    function insertOptimisticBubble(reqKey,label,bodyText,previewHtml,statusText){
      const senderClass=admin?'from-admin':'from-customer';
      const senderLabel=admin?'GAERU':'Bạn';
      messages.insertAdjacentHTML('beforeend',`<article class="shopping-message ${senderClass} is-optimistic" data-optimistic-key="${escape(reqKey)}" data-sender="${admin?'admin':'customer'}"><strong>${senderLabel}</strong><p>${escape(bodyText)}</p>${previewHtml||''}<small class="chat-bg-status" data-bg-status>${escape(statusText)}</small><time>${escape(label)}</time></article>`);
      scrollToLatest(true);
      return messages.querySelector(`[data-optimistic-key="${CSS?.escape?CSS.escape(reqKey):reqKey}"]`);
    }

    function dispatchInstantSend(rawText,queuedFiles){
      if(thread?.status==='closed')return;
      const textBody=String(rawText||'').trim()||(queuedFiles.length?'Tôi gửi tệp để được tư vấn.':'');
      if(!textBody&&!queuedFiles.length){feedback.textContent='Nhập tin nhắn hoặc chọn tệp.';return;}
      const msgKey=crypto.randomUUID();
      const nowLabel=new Date().toLocaleString('vi-VN');
      const textNode=insertOptimisticBubble(msgKey,nowLabel,textBody,'',queuedFiles.length?'Đã gửi nhanh · Đang chuẩn bị tải tệp ngầm…':'Đang gửi nhanh…');
      const fileNodes=queuedFiles.map(item=>{
        const preview=item.url?media(item.url,item.file.type,item.file.name):'';
        return {item,node:insertOptimisticBubble(item.key,nowLabel,'Tệp đính kèm: '+item.file.name,preview,`Đang chờ tải ngầm (${formatSize(item.file.size)})…`)};
      });
      feedback.textContent=queuedFiles.length?'Đã gửi nhanh! Tệp đang được nén và tải lên hệ thống ngầm.':'Đã gửi nhanh.';

      bgChain=bgChain.then(async()=>{
        try{
          if(!id){
            const d=await request(base,{method:'POST',body:JSON.stringify({productSlug,body:textBody,requestKey:msgKey})});
            id=d.thread.id;
          }else{
            await request(base+'/'+id+'/messages',{method:'POST',body:JSON.stringify({body:textBody,requestKey:msgKey})});
          }
          const msgStatus=textNode?.querySelector('[data-bg-status]');
          if(msgStatus)msgStatus.textContent='Đã gửi';
          for(const {item,node} of fileNodes){
            const statusNode=node?.querySelector('[data-bg-status]');
            try{
              await uploadFileInBackground(id,item,statusNode);
              if(statusNode)statusNode.textContent='Đã tải lên & nén hoàn tất';
            }finally{
              release(item);
            }
          }
          await refresh();
          feedback.textContent=queuedFiles.length?'Đã tải lên và nén tệp ngầm hoàn tất.':'Đã gửi.';
        }catch(error){
          const msgStatus=textNode?.querySelector('[data-bg-status]');
          if(msgStatus)msgStatus.textContent='Chưa gửi được: '+error.message;
          feedback.textContent=error.message;
        }
      });
    }

    form.onsubmit=async e=>{
      e.preventDefault();
      if(thread?.status==='closed')return;
      const bodyText=form.elements.body.value.trim();
      const queued=files.splice(0,files.length);
      if(!bodyText&&!queued.length){feedback.textContent='Nhập tin nhắn hoặc chọn tệp.';return;}
      form.reset();
      renderFiles();
      dispatchInstantSend(bodyText,queued);
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
