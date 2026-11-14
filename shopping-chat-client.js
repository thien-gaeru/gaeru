(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ICONS = {
    mediaFile: '<svg class="chat-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
    file: '<svg class="chat-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
    media: '<svg class="chat-action-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-4.5-4.5a1.5 1.5 0 0 0-2.1 0L6 19"/></svg>',
    orders: '<svg class="chat-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 11h8M8 15h6"/></svg>',
    voucher: '<svg class="chat-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 9a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3 3 3 0 0 0 0 6 3 3 0 0 1-3 3H5a3 3 0 0 1-3-3 3 3 0 0 0 0-6z"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="15" x2="15.01" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>',
    campaign: '<svg class="chat-action-icon" viewBox="0 0 24 24" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
    hotline: '<svg class="chat-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.58 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    human: '<svg class="chat-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
    endChat: '<svg class="chat-action-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    camera: '<svg class="chat-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    mic: '<svg class="chat-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
  };
  window.GAERUChatClient = { mount(root, {base,request,id=null,productSlug=null,admin=false}) {
    let stopped=false, busy=false, sending=false, resumingAi=false, thread=null, key=null, files=[], supportReadAt=Date.now(), aiCapabilities=null, capabilitiesReadAt=0, bgChain=Promise.resolve(), fastAiTimers=[], pendingUploads=new Map(), hdOriginalMode=false, activeUploadAbort=null, uploadCancelled=false, voiceState=null;
    const quickReplies = admin ? []      : [
          'Tư vấn chọn phiên bản phù hợp',
          'Kiểm tra tồn kho & ưu đãi',
          'Hướng dẫn kết nối thiết bị',
          'Chính sách bảo hành Care+'
        ];
    root.innerHTML = `<div class="chat-state-bar"><p class="chat-state" data-chat-state>Xin chào! GAERU sẵn sàng hỗ trợ bạn.</p><span class="chat-live-badge" data-chat-live-badge title="Thời gian thực (SSE 0ms)" aria-label="Trạng thái kết nối"><span class="chat-live-dot"></span><span data-chat-live-text hidden></span></span>${admin?'':'<div class="chat-session-actions"><a href="tel:0829191080" class="chat-hotline-session" data-chat-hotline data-no-action-feedback>☏ Gọi hotline</a><button type="button" class="chat-end-session" data-chat-end data-no-action-feedback hidden>Kết thúc phiên chat</button><button type="button" class="chat-new-session" data-chat-new data-no-action-feedback hidden>Bắt đầu chat mới</button></div>'}</div>
      <button type="button" data-chat-earlier hidden>Xem tin nhắn trước</button>
      <div class="shopping-messages" data-chat-messages aria-live="polite"></div><div class="chat-support-state" data-chat-support role="status" hidden></div>
      <form data-chat-compose>
      ${admin?'':`<div class="chat-quick-bar" data-chat-quick-bar>
        <div class="chat-quick-header">
          <button type="button" class="chat-quick-toggle" data-chat-quick-toggle data-no-action-feedback aria-expanded="false">⚡ Chọn hiển thị phản hồi nhanh</button>
        </div>
        <div class="chat-quick-list" data-chat-quick-list hidden>${quickReplies.map((q,i)=>`<button type="button" class="chat-quick-chip" data-quick-reply="${i}" data-no-action-feedback>${escape(q)}</button>`).join('')}</div>
      </div>`}
      <div data-chat-voice-bar class="chat-voice-recorder" hidden></div><div data-chat-upload-progress class="chat-upload-progress" hidden></div><div data-chat-selected class="chat-selected"></div>
      <div class="chat-composer"><button type="button" class="chat-plus" aria-label="Thêm đính kèm" aria-expanded="false" aria-controls="${admin?'admin':'customer'}-chat-actions" data-chat-plus data-no-action-feedback>+</button>
      <label class="visually-hidden" for="${admin?'admin':'customer'}-chat-body">Tin nhắn</label><textarea id="${admin?'admin':'customer'}-chat-body" name="body" maxlength="3000" rows="1" enterkeyhint="send" placeholder="Bạn cần tư vấn điều gì?"></textarea>
      <button class="chat-send" type="submit" tabindex="-1" data-no-action-feedback aria-label="Gửi tin nhắn">↑</button></div>
      <div class="chat-actions" id="${admin?'admin':'customer'}-chat-actions" hidden>
      <button type="button" data-pick="media" data-no-action-feedback>${ICONS.mediaFile}<span>Tệp, Ảnh / Video<small>Ảnh, video, âm thanh, tài liệu · Dán Ctrl+V hoặc kéo thả</small></span></button><button type="button" data-pick="camera" data-no-action-feedback>${ICONS.camera}<span>Chụp ảnh / Camera<small>Mở máy ảnh chụp trực tiếp</small></span></button><button type="button" data-chat-voice-btn data-no-action-feedback>${ICONS.mic}<span>Ghi âm giọng nói<small>Gửi tin nhắn thoại nhanh</small></span></button>
      ${admin?(
        (window.GAERUAdmin?.can('marketing.read')?`<button type="button" data-offer="vouchers" data-no-action-feedback>${ICONS.voucher}<span>Gửi voucher<small>Chọn ưu đãi đang có hiệu lực</small></span></button><button type="button" data-offer="campaigns" data-no-action-feedback>${ICONS.campaign}<span>Chiến dịch<small>Chọn thông báo khuyến mại</small></span></button>`:'')+
        (window.GAERUAdmin?.can('orders.read')?`<button type="button" data-offer="orders" data-no-action-feedback>${ICONS.orders}<span>Lịch sử đơn hàng<small>Tra cứu và gửi thông tin đơn</small></span></button>`:'')
      ):`<button type="button" data-reference="orders" data-no-action-feedback>${ICONS.orders}<span>Lịch sử đơn hàng<small>Chọn đơn của bạn</small></span></button><button type="button" data-reference="vouchers" data-no-action-feedback>${ICONS.voucher}<span>Voucher<small>Ưu đãi trong ví của bạn</small></span></button><button type="button" data-chat-human data-no-action-feedback>${ICONS.human}<span>Gặp nhân viên<small>Yêu cầu hỗ trợ trực tiếp</small></span></button><button type="button" data-chat-end data-no-action-feedback>${ICONS.endChat}<span>Kết thúc phiên chat<small>Đóng cuộc trò chuyện hiện tại</small></span></button>`}
      <div data-chat-reference class="chat-reference" hidden></div>
      </div>
      <input class="chat-file-input visually-hidden" type="file" multiple data-file="media" accept="image/*,video/*,audio/*,.jfif,.bmp,.tif,.tiff,.avif,.heic,.heif,.mp4,.mov,.m4v,.3gp,.webm,.mkv,.avi,.mp3,.m4a,.aac,.wav,.ogg,.opus,.weba,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.rar,.7z,.txt,.csv,.log,.md,.json,.xml,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv,application/json,application/xml"><input class="chat-file-input visually-hidden" type="file" data-file="camera" capture="environment" accept="image/*,video/*">
      <p role="status" data-chat-feedback></p></form>`;
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
    // Auto-resize textarea: 1 row default → max 3 rows
    (function(){
      const ta=form.elements.body;
      function resizeTA(){
        ta.style.height='auto';
        const maxH=Math.round(parseFloat(getComputedStyle(ta).lineHeight||'22')*3+16);
        ta.style.height=Math.min(ta.scrollHeight,maxH)+'px';
      }
      ta.addEventListener('input',resizeTA);
      ta.addEventListener('focus',resizeTA);
    })();
    function media(url,mime,name){
      if(['image/jpeg','image/png','image/webp','image/gif','image/heic','image/avif'].includes(mime)||String(mime||'').startsWith('image/'))return `<img class="chat-inline-media" data-chat-lightbox-src="${escape(url)}" src="${escape(url)}" alt="${escape(name)}" loading="lazy">`;
      if(['video/mp4','video/quicktime','video/webm'].includes(mime)||String(mime||'').startsWith('video/'))return `<video class="chat-inline-media" controls playsinline preload="metadata" src="${escape(url)}">Thiết bị chưa phát được video này.</video>`;
      if(['audio/mpeg','audio/mp4','audio/wav','audio/ogg','audio/webm'].includes(mime)||String(mime||'').startsWith('audio/')||/\.(mp3|m4a|aac|wav|ogg|opus|weba)$/i.test(name||''))return `<audio class="chat-inline-audio" controls preload="metadata" src="${escape(url)}">Thiết bị chưa phát được tệp âm thanh này.</audio>`;
      return '';
    }
    // Keep virtual keyboard open on mobile/desktop when tapping or clicking Send.
    send.addEventListener?.('pointerdown',event=>{event.preventDefault();});
    send.addEventListener?.('mousedown',event=>{event.preventDefault();});
    send.addEventListener?.('touchstart',event=>{
      if(event.touches&&event.touches.length>1)return;
      event.preventDefault();
      if(!sending&&!send.disabled&&(form.elements.body.value.trim()||files.length)){
        if(typeof form.requestSubmit==='function')form.requestSubmit(send);
        else send.click();
      }
    },{passive:false});
    function formatSize(bytes){
      const n=Number(bytes)||0;
      if(n>=1073741824)return (n/1073741824).toFixed(2)+' GB';
      if(n>=1048576)return (n/1048576).toFixed(1)+' MB';
      return Math.max(1,Math.ceil(n/1024))+' KB';
    }
    function attachment(file){
      if(file.deletedAt||file.expired)return '<p class="chat-attachment-deleted">'+escape(file.deletionReason==='retention'||file.expired?'Tệp đã hết hạn lưu trữ 30 ngày.':'Tệp đã được quản trị viên xóa.')+'</p>';
      const deleteButton=admin&&window.GAERUAdmin?.can('chat.files.delete')?`<button type="button" class="chat-file-delete" data-chat-delete-file="${escape(file.id)}" data-no-action-feedback>Xóa tệp</button>`:'';
      const url=base+'/'+id+'/files/'+encodeURIComponent(file.id);
      const saved=file.originalSize&&file.compressedSize&&file.compressedSize<file.originalSize?` · Đã nén tự động (${formatSize(file.compressedSize)})`:'';
      const pdfPreview=file.mime==='application/pdf'?`<a class="chat-file-link chat-pdf-preview-link" href="${escape(url)}?preview=1" target="_blank" rel="noopener">👁 Xem trực tiếp PDF</a>`:'';
      return media(url,file.mime,file.name)+pdfPreview+`<a class="chat-file-link" href="${escape(url)}?download=1" target="_blank" rel="noopener">↓ ${escape(file.name)} · ${formatSize(file.size)}${escape(saved)}</a><a class="chat-file-link" href="${escape(url)}?download=1&original=1" target="_blank" rel="noopener">Tải bản gốc được gửi</a>${deleteButton}`;
    }
    function release(file){if(file?.url)URL.revokeObjectURL(file.url);}
    function clearFastAiTimers(){
      while(fastAiTimers.length)clearTimeout(fastAiTimers.pop());
    }
    function syncAiTypingIndicator(active){
      if(admin)return;
      const existing=messages.querySelector('[data-ai-typing]');
      if(!active){
        if(existing)existing.remove();
        return;
      }
      if(!existing){
        messages.insertAdjacentHTML('beforeend','<article class="shopping-message from-admin is-ai-typing" data-ai-typing><strong>GAERU AI</strong><p>Đang phản hồi nhanh…</p></article>');
        if(nearBottom())scrollToLatest(true);
      }
    }
    function scheduleFastAIRefresh(){
      if(admin||stopped)return;
      clearFastAiTimers();
      if((aiCapabilities?.aiConfigured||aiCapabilities?.gaeruAi)&&thread?.handlingMode!=='human'&&!thread?.handoffOffered&&thread?.status!=='closed'){
        syncAiTypingIndicator(true);
      }
      for(const delayMs of [160,380,700,1150,1750,2500,3500]){
        fastAiTimers.push(setTimeout(()=>{
          if(!stopped&&id)void refresh();
        },delayMs));
      }
    }
    function renderFiles(){
      const hasMedia=files.some(f=>isImageFile(f.file)||isVideoFile(f.file));
      const toolbar=files.length&&hasMedia?`<div class="chat-selected-toolbar"><button type="button" class="chat-hd-toggle ${hdOriginalMode?'is-active':''}" data-chat-hd-toggle aria-pressed="${hdOriginalMode?'true':'false'}" data-no-action-feedback>${hdOriginalMode?'✦ Đang bật Gửi HD Gốc (giữ nguyên độ phân giải)':'⚡ Tối ưu ảnh thông minh · Bấm để gửi HD Gốc'}</button><span class="chat-selected-count">${files.length} tệp</span></div>`:'';
      root.querySelector('[data-chat-selected]').innerHTML=toolbar+files.map((f,i)=>`<figure class="chat-preview">${f.url?media(f.url,f.file.type,f.safeName||f.file.name):''}<figcaption>${escape(f.safeName||f.file.name||'tep')}<small>${formatSize(f.file.size)} · ${f.file.size>getMaxUploadBytes()?'Sẽ tự động nén trước khi gửi':(!hdOriginalMode&&isImageFile(f.file)&&f.file.size>SMART_IMAGE_OPTIMIZE_BYTES?'Tối ưu thông minh (2.5K WebP)':'Sẵn sàng gửi nhanh & tải ngầm')}</small><small data-media-error hidden>Thiết bị chưa xem được định dạng này. Bạn vẫn có thể gửi tệp.</small></figcaption><button type="button" data-remove="${i}" data-no-action-feedback aria-label="Bỏ tệp ${escape(f.safeName||f.file.name||'tep')}">×</button></figure>`).join('');
      root.querySelectorAll('.chat-preview img,.chat-preview video,.chat-preview audio').forEach(el=>el.addEventListener('error',()=>{el.hidden=true;el.closest('figure').querySelector('[data-media-error]').hidden=false;},{once:true}));
    }
    // Upload limit enforced by the server (src/audit-fixes/upload-state.js), synced via /capabilities.
    const MAX_UPLOAD_BYTES=500*1024*1024;
    const getMaxUploadBytes=()=>Number(aiCapabilities?.maxFileBytes)>0?Number(aiCapabilities.maxFileBytes):MAX_UPLOAD_BYTES;
    // Leave headroom for container overhead / encoder bitrate drift.
    const getCompressTargetBytes=()=>Math.floor(getMaxUploadBytes()*.9);
    const chooseChunkBytes=size=>{
      const maxChunk=Number(aiCapabilities?.maxChunkBytes)>0?Number(aiCapabilities.maxChunkBytes):5*1024*1024;
      const maxChunks=Number(aiCapabilities?.maxChunks)>0?Number(aiCapabilities.maxChunks):256;
      const base=size<=20*1024*1024?1048576:(size<=100*1024*1024?2*1048576:3*1048576);
      const minForCount=Math.ceil(size/Math.max(1,maxChunks-4));
      return Math.min(maxChunk,Math.max(base,minForCount));
    };
    const SMART_IMAGE_OPTIMIZE_BYTES=1572864;
    const isImageFile=f=>/^image\//i.test(f?.type||'')||/\.(jpe?g|jfif|png|webp|gif|avif|heic|heif|bmp|tiff?)$/i.test(f?.name||'');
    const isAudioFile=f=>/^audio\//i.test(f?.type||'')||/\.(mp3|m4a|aac|wav|ogg|opus|weba)$/i.test(f?.name||'');
    const isVideoFile=f=>/^video\//i.test(f?.type||'')||/\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(f?.name||'');
    function withTimeout(promise,ms,fallbackValue){
      let timer;
      return Promise.race([
        promise,
        new Promise(resolve=>{timer=setTimeout(()=>resolve(fallbackValue),ms);})
      ]).finally(()=>clearTimeout(timer));
    }
    async function encodeCanvas(canvas,quality){
      const toBlob=(type,q)=>new Promise(resolve=>{
        let settled=false;
        const timer=setTimeout(()=>{if(!settled){settled=true;resolve(null);}},3500);
        try{
          canvas.toBlob(b=>{if(!settled){settled=true;clearTimeout(timer);resolve(b||null);}},type,q);
        }catch{
          if(!settled){settled=true;clearTimeout(timer);resolve(null);}
        }
      });
      let blob=await toBlob('image/webp',quality);
      // Safari versions without WebP encoding silently return PNG; fall back to JPEG.
      if(!blob||blob.type!=='image/webp')blob=await toBlob('image/jpeg',quality);
      return blob;
    }
    async function compressImage(rawFile,force){
      if(typeof createImageBitmap!=='function'||typeof document==='undefined')return rawFile;
      const run=async()=>{
        let bmp=null;
        try{
          try{bmp=await createImageBitmap(rawFile,{imageOrientation:'from-image'});}
          catch{bmp=await createImageBitmap(rawFile);}
          const srcW=bmp.width||1,srcH=bmp.height||1;
          // Normal images: 2048px. Oversized images: step down until under the limit.
          const steps=force?[[2048,.86],[2048,.72],[1600,.7],[1280,.65],[1024,.6]]:[[2560,.88],[2048,.86]];
          let best=null;
          for(const [maxDim,quality] of steps){
            const scale=Math.min(1,maxDim/Math.max(srcW,srcH));
            const w=Math.max(1,Math.round(srcW*scale)),h=Math.max(1,Math.round(srcH*scale));
            const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
            const ctx=canvas.getContext('2d');
            if(!ctx){canvas.width=0;canvas.height=0;break;}
            ctx.drawImage(bmp,0,0,w,h);
            const blob=await encodeCanvas(canvas,quality);
            canvas.width=0;canvas.height=0;
            if(blob&&blob.size>0&&(!best||blob.size<best.size))best=blob;
            if(best&&best.size<=getCompressTargetBytes())break;
          }
          if(best&&best.size>0&&best.size<rawFile.size){
            const ext=best.type==='image/webp'?'.webp':'.jpg';
            return new File([best],(rawFile.name||'anh').replace(/\.[^.]+$/,'')+ext,{type:best.type});
          }
        }catch{}finally{
          try{bmp?.close?.();}catch{}
        }
        return rawFile;
      };
      return withTimeout(run(),force?15000:6500,rawFile);
    }
    function pickRecorderType(){
      if(typeof MediaRecorder==='undefined'||typeof MediaRecorder.isTypeSupported!=='function')return null;
      // MP4 first (Safari/iOS, recent Chrome), then WebM (Chrome/Android/Firefox). Both are accepted by the server.
      const types=['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4;codecs=avc1,mp4a','video/mp4','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];
      return types.find(type=>{try{return MediaRecorder.isTypeSupported(type);}catch{return false;}})||null;
    }
    // Re-encode a video in the browser (real-time playback -> canvas -> MediaRecorder)
    // with a bitrate computed so the result fits under COMPRESS_TARGET_BYTES.
    async function transcodeVideo(rawFile,targetBytes){
      const mimeType=pickRecorderType();
      if(!mimeType||typeof document==='undefined')return null;
      const url=URL.createObjectURL(rawFile);
      const video=document.createElement('video');
      video.playsInline=true;video.setAttribute('playsinline','');try{video.setAttribute('webkit-playsinline','');}catch{}video.preload='auto';video.muted=true;video.src=url;
      let audioCtx=null,raf=0,frameCb=0,recorder=null;
      const cleanup=()=>{
        try{cancelAnimationFrame(raf);}catch{}
        try{if(frameCb&&video.cancelVideoFrameCallback)video.cancelVideoFrameCallback(frameCb);}catch{}
        try{video.pause();}catch{}
        video.removeAttribute('src');try{video.load();}catch{}
        URL.revokeObjectURL(url);
        try{audioCtx?.close();}catch{}
      };
      try{
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('metadata timeout')),20000);
          video.onloadedmetadata=()=>{clearTimeout(timer);resolve();};
          video.onerror=()=>{clearTimeout(timer);reject(Error('decode error'));};
        });
        const duration=video.duration;
        if(!Number.isFinite(duration)||duration<=0)throw Error('unknown duration');
        const totalBps=Math.floor(targetBytes*8/duration);
        const audioBps=Math.max(32000,Math.min(128000,Math.floor(totalBps*.08)));
        const videoBps=Math.max(120000,totalBps-audioBps);
        // Pick an output resolution that suits the available bitrate.
        const maxEdge=videoBps>=4e6?1920:videoBps>=2e6?1280:videoBps>=9e5?960:videoBps>=45e4?720:540;
        const srcW=video.videoWidth||1280,srcH=video.videoHeight||720;
        const scale=Math.min(1,maxEdge/Math.max(srcW,srcH));
        const w=Math.max(2,Math.round(srcW*scale/2)*2),h=Math.max(2,Math.round(srcH*scale/2)*2);
        const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
        const ctx=canvas.getContext('2d');
        if(typeof canvas.captureStream!=='function')throw Error('captureStream unsupported');
        const stream=canvas.captureStream(30);
        // Keep the audio track: route the element through Web Audio into the recording only (not the speakers).
        try{
          const AC=window.AudioContext||window.webkitAudioContext;
          if(AC){
            audioCtx=new AC();
            const source=audioCtx.createMediaElementSource(video);
            const dest=audioCtx.createMediaStreamDestination();
            source.connect(dest);
            dest.stream.getAudioTracks().forEach(track=>stream.addTrack(track));
            video.muted=false;
            await audioCtx.resume?.().catch?.(()=>{});
          }
        }catch{video.muted=true;}
        const chunks=[];
        recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:videoBps,audioBitsPerSecond:audioBps});
        recorder.ondataavailable=ev=>{if(ev.data&&ev.data.size)chunks.push(ev.data);};
        const stoppedP=new Promise(resolve=>{recorder.onstop=resolve;});
        const draw=()=>{try{ctx.drawImage(video,0,0,w,h);}catch{}};
        const loopRaf=()=>{draw();if(!video.ended&&!video.paused)raf=requestAnimationFrame(loopRaf);};
        const loopFrame=()=>{draw();if(!video.ended)frameCb=video.requestVideoFrameCallback(loopFrame);};
        try{await video.play();}
        catch{video.muted=true;await video.play();}
        draw();
        recorder.start(1000);
        if(typeof video.requestVideoFrameCallback==='function')frameCb=video.requestVideoFrameCallback(loopFrame);
        else raf=requestAnimationFrame(loopRaf);
        await new Promise((resolve,reject)=>{
          // Allow slow devices some slack beyond the real-time duration.
          const guard=setTimeout(()=>reject(Error('transcode timeout')),Math.max(60000,duration*3000+30000));
          video.onended=()=>{clearTimeout(guard);resolve();};
          video.onerror=()=>{clearTimeout(guard);reject(Error('playback error'));};
          // Mobile browsers pause media when the page is hidden; resume when visible again.
          video.onpause=()=>{if(!video.ended)setTimeout(()=>{if(!video.ended)video.play().catch(()=>{});},300);};
        });
        draw();
        if(recorder.state!=='inactive')recorder.stop();
        await stoppedP;
        const outType=mimeType.split(';')[0];
        const blob=new Blob(chunks,{type:outType});
        if(!blob.size)return null;
        const ext=outType==='video/mp4'?'.mp4':'.webm';
        return new File([blob],rawFile.name.replace(/\.[^.]+$/,'')+'-nen'+ext,{type:outType});
      }catch{
        try{if(recorder&&recorder.state!=='inactive')recorder.stop();}catch{}
        return null;
      }finally{cleanup();}
    }
    async function compressVideo(rawFile){
      const limit=getMaxUploadBytes();
      let target=getCompressTargetBytes(),best=null;
      // Encoders overshoot sometimes; retry once with a lower bitrate if needed.
      for(let attempt=0;attempt<2;attempt++){
        const out=await transcodeVideo(rawFile,target);
        if(out&&(!best||out.size<best.size))best=out;
        if(best&&best.size<=limit)break;
        if(!out)break;
        target=Math.floor(target*Math.min(.8,limit/out.size*.85));
      }
      return best&&best.size<rawFile.size?best:rawFile;
    }
    async function compressFileInBackground(rawFile,item=null){
      if(!rawFile||typeof rawFile.size!=='number')return rawFile;
      const oversized=rawFile.size>getMaxUploadBytes();
      const type=String(rawFile.type||'');
      if(isImageFile(rawFile)&&type!=='image/gif'&&type!=='image/svg+xml'){
        if(oversized)return compressImage(rawFile,true); // In-limit originals go to the server unchanged; optimization runs afterwards.
        if(!hdOriginalMode&&!item?.hdOriginal&&rawFile.size>SMART_IMAGE_OPTIMIZE_BYTES)return compressImage(rawFile,false);
        return rawFile;
      }
      if(oversized&&isVideoFile(rawFile))return compressVideo(rawFile);
      return rawFile;
    }
    function renderAINote(){
      if(admin)return;
      if(!thread){
        const state=root.querySelector('[data-chat-state]');
        if(state)state.textContent='Xin chào! GAERU sẵn sàng hỗ trợ bạn.';
      }
    }
    async function loadCapabilities(){capabilitiesReadAt=Date.now();try{aiCapabilities=await request('/api/shopping-chat/capabilities');}catch{aiCapabilities=null;}if(!stopped)renderAINote();}
    async function resumeAiAfterTimeout(){
      if(admin||stopped||resumingAi||!id||thread?.status==='closed'||thread?.handlingMode!=='human'||thread?.staffReplied)return;
      resumingAi=true;
      try{
        await request(base+'/'+id+'/resume-ai',{method:'POST',body:JSON.stringify({})});
        await refresh();
      }catch{}finally{
        resumingAi=false;
      }
    }
    function syncSupport(){
      renderAINote();
      const closed=thread?.status==='closed',human=root.querySelector('[data-chat-human]');if(human)human.hidden=closed||thread?.handlingMode==='human';
      if(!admin){
        const endButtons=root.querySelectorAll('[data-chat-end]');
        endButtons.forEach(b=>{b.hidden=!id||closed;});
        const newButton=root.querySelector('[data-chat-new]');
        if(newButton)newButton.hidden=!closed;
      }
      const state=root.querySelector('[data-chat-support]');state.hidden=admin||closed||(!thread?.handoffOffered&&thread?.handlingMode!=='human')||thread?.staffReplied===true;
      if(!state.hidden){
        const seconds=(thread.handoffWaitSeconds||0)+(Date.now()-supportReadAt)/1000;
        if(thread.handlingMode==='human'&&!thread.staffReplied&&seconds>=300){
          void resumeAiAfterTimeout();
        }
        const html=thread.handoffOffered
          ?'AI chưa thể tiếp tục trả lời. Kết nối nhân viên GAERU để được hỗ trợ.<button type="button" class="chat-handoff-button" data-inline-handoff data-no-action-feedback>Gặp nhân viên</button>'
          :seconds>=300
            ?'Chưa có nhân viên phản hồi sau 5 phút. Đang tự động kích hoạt lại hỗ trợ bằng GAERU AI (hoặc gọi <a href="tel:0829191080">082.919.1080</a>).'
            :'Đang chờ kết nối nhân viên hỗ trợ GAERU… (Sau 5 phút chưa có phản hồi, AI sẽ tự động hỗ trợ lại)';
        if(state.dataset.renderKey!==html){state.innerHTML=html;state.dataset.renderKey=html;}
      }
    }

    function setClosed(){const closed=thread?.status==='closed';send.disabled=closed;form.elements.body.disabled=closed;plus.disabled=closed;actions.querySelectorAll('button:not([data-chat-hotline])').forEach(b=>b.disabled=closed);root.querySelectorAll('[data-quick-reply]').forEach(b=>b.disabled=closed);syncSupport();}
    async function refresh(before){
      if(stopped||busy||!id)return;busy=true;
      try{
        const confirmedNodes=[...messages.querySelectorAll('[data-message-id]')];
        const first=!confirmedNodes.length,last=confirmedNodes.at(-1)?.dataset.messageId;
        let d=await request(base+'/'+id+'/messages'+(before?'?before='+before:!first&&last?'?after='+last:''));if(stopped)return;
        if(!before&&!first&&thread&&d.thread.version!==thread.version&&!d.messages.length){d=await request(base+'/'+id+'/messages');messages.replaceChildren();confirmedNodes.length=0;}
        thread=d.thread;supportReadAt=Date.now();if(!admin&&Date.now()-capabilitiesReadAt>60000)void loadCapabilities();
        const near=nearBottom(),oldHeight=messages.scrollHeight,oldTop=messages.scrollTop,known=new Set(confirmedNodes.map(e=>e.dataset.messageId));
        for(const m of d.messages){if(m.requestKey){const opt=messages.querySelector(`[data-optimistic-key="${CSS?.escape?CSS.escape(m.requestKey):m.requestKey}"]`);if(opt)opt.remove();}}
        const newMessages=d.messages.filter(m=>!known.has(String(m.id)));
        const html=newMessages.map(m=>`<article class="shopping-message ${m.sender==='customer'?'from-customer':'from-admin'}" data-message-id="${escape(m.id)}" data-sender="${escape(m.sender)}"><strong>${m.sender==='ai'?'GAERU AI':m.sender==='admin'?'GAERU':admin?'Khách':'Bạn'}</strong><p>${escape(m.body)}</p>${m.attachment?attachment(m.attachment):''}<time>${escape(new Date(m.created_at).toLocaleString('vi-VN'))}</time></article>`).join('');
        if(before)messages.insertAdjacentHTML('afterbegin',html);
        else{
          const anchor=messages.querySelector('[data-optimistic-key],[data-ai-typing]');
          if(anchor)anchor.insertAdjacentHTML('beforebegin',html);
          else messages.insertAdjacentHTML('beforeend',html);
        }
        if(!admin){
          const gotAiOrStaffReply=newMessages.some(m=>m.sender==='ai'||m.sender==='admin');
          if(gotAiOrStaffReply||!thread?.aiPending||thread?.handlingMode==='human'||thread?.handoffOffered||thread?.status==='closed'){
            syncAiTypingIndicator(false);
            if(gotAiOrStaffReply||!thread?.aiPending)clearFastAiTimers();
          }else if(thread?.aiPending&&(aiCapabilities?.aiConfigured||aiCapabilities?.gaeruAi)){
            syncAiTypingIndicator(true);
          }
        }
        if(before)messages.scrollTop=oldTop+messages.scrollHeight-oldHeight;else if(html&&(near||first))scrollToLatest(!first);
        if(first||before)root.querySelector('[data-chat-earlier]').hidden=!d.hasMore;
        root.querySelector('[data-chat-state]').textContent=(thread.status==='closed'?'Đã đóng · ':thread.handlingMode==='human'?(thread.staffReplied?'Nhân viên đang hỗ trợ · ':'Chờ nhân viên · '):thread.handoffOffered?'AI tạm dừng · ':thread.aiPending?'GAERU AI đang trả lời… · ':'AI đang hỗ trợ · ')+thread.product_name;setClosed();
        if(d.hasMore&&!before&&!first)setTimeout(()=>refresh(),0);
      }finally{busy=false;}
    }

    root.addEventListener('click',async event=>{
      const button=event.target.closest('[data-chat-delete-file]');if(!button||!admin||!window.GAERUAdmin?.can('chat.files.delete'))return;
      const okDelFile=await (window.GAERUNotify?.confirm?window.GAERUNotify.confirm('Xóa tệp khỏi hội thoại? Tệp đã xóa không thể khôi phục.',{danger:true,confirmText:'Xóa tệp'}):window.confirm('Xóa tệp khỏi hội thoại? Tệp đã xóa không thể khôi phục.'));if(!okDelFile)return;
      button.disabled=true;
      try{const result=await request(base+'/'+id+'/files/'+encodeURIComponent(button.dataset.chatDeleteFile),{method:'DELETE',body:JSON.stringify({confirm:true})});feedback.textContent=result.message;messages.replaceChildren();await refresh();}
      catch(error){feedback.textContent=error.message;}finally{button.disabled=false;}
    });
    const quickToggle=root.querySelector('[data-chat-quick-toggle]'),quickList=root.querySelector('[data-chat-quick-list]');
    function collapseQuickReplies(){
      if(quickList&&quickToggle){
        quickList.hidden=true;
        quickToggle.setAttribute('aria-expanded','false');
      }
    }
    if(quickToggle&&quickList){
      collapseQuickReplies();
      quickToggle.onclick=()=>{quickList.hidden=!quickList.hidden;quickToggle.setAttribute('aria-expanded',String(!quickList.hidden));};
      quickList.onclick=e=>{
        const chip=e.target.closest('[data-quick-reply]');if(!chip||thread?.status==='closed')return;
        const text=quickReplies[Number(chip.dataset.quickReply)];if(!text)return;
        collapseQuickReplies();
        dispatchInstantSend(text,[]);
      };
    }

    form.elements.body.addEventListener('focus',()=>{collapseQuickReplies();actions.hidden=true;plus.setAttribute('aria-expanded','false');root.querySelector('[data-chat-reference]').hidden=true;});
    plus.onclick=()=>{collapseQuickReplies();actions.hidden=!actions.hidden;plus.setAttribute('aria-expanded',String(!actions.hidden));};
    root.querySelector('[data-chat-earlier]').onclick=()=>refresh(messages.querySelector('[data-message-id]')?.dataset.messageId).catch(e=>feedback.textContent=e.message);
    // Mobile pickers (iOS Photos, Android Google Photos) may return to the page
    // before or without firing `change`; track the open picker and re-check
    // its files when the page regains focus/visibility.
    let activePicker=null,pickerTimers=[];
    function clearPickerTimers(){while(pickerTimers.length)clearTimeout(pickerTimers.pop());}
    const takenPickerFiles=typeof WeakSet==='function'?new WeakSet():null;
    const BUFFER_EAGER_MAX_BYTES=32*1024*1024;
    function materializePickedFile(file){
      if(!file||!file.size||file.size>BUFFER_EAGER_MAX_BYTES)return null;
      const readAB=typeof file.arrayBuffer==='function'
        ?()=>file.arrayBuffer()
        :(typeof Response==='function'?()=>new Response(file).arrayBuffer():null);
      if(!readAB||typeof File!=='function')return null;
      return readAB().then(buf=>new File([buf],file.name||'tep',{type:file.type||'application/octet-stream',lastModified:file.lastModified||Date.now()})).catch(()=>null);
    }
    function takePickedFiles(input){
      if(!input)return;
      const raw=[...(input.files||[])];
      const picked=takenPickerFiles?raw.filter(f=>{if(takenPickerFiles.has(f))return false;takenPickerFiles.add(f);return true;}):raw;
      if(!picked.length)return;
      // Keep input.value intact until the next [data-pick] click so Android/MIUI/WebKit
      // content:// File handles stay readable until buffered or uploaded.
      if(activePicker===input){activePicker=null;clearPickerTimers();}
      addRawFiles(picked);
    }
    function addRawFiles(picked){
      if(!picked||!picked.length||thread?.status==='closed')return;
      for(const file of picked){
        if(!file.size&&file.size!==undefined){
          feedback.textContent=`Tệp "${file.name||'đã chọn'}" không có dữ liệu (0 KB). Vui lòng chọn tệp hợp lệ.`;
          try{feedback.scrollIntoView?.({block:'nearest'});}catch{}
          return;
        }
        if(!isImageFile(file)&&!isVideoFile(file)&&file.size>getMaxUploadBytes()){
          feedback.textContent=`Tệp "${file.name}" (${formatSize(file.size)}) vượt quá dung lượng tối đa ${formatSize(getMaxUploadBytes())}. Ảnh và video hỗ trợ dung lượng lớn sẽ được tự động xử lý nếu vượt mức này.`;
          try{feedback.scrollIntoView?.({block:'nearest'});}catch{}
          return;
        }
      }
      for(const file of picked){
        const safeName=String(file.name||'').trim()||'tep';
        const bufferedP=materializePickedFile(file);
        const item={
          file,
          safeName,
          bufferPromise:bufferedP,
          key:crypto.randomUUID(),
          url:/^(image|video|audio)\//i.test(file.type)||/\.(jpe?g|jfif|bmp|tiff?|png|webp|gif|avif|heic|heif|mp4|mov|m4v|3gp|webm|mkv|avi|mp3|m4a|aac|wav|ogg|opus|weba)$/i.test(safeName)?URL.createObjectURL(file):null,
          hdOriginal:hdOriginalMode,
          resumeFromChunk:0
        };
        if(bufferedP)void bufferedP.then(copy=>{if(copy&&item.file===file)item.file=copy;});
        files.push(item);
      }
      feedback.textContent='';
      actions.hidden=true;plus.setAttribute('aria-expanded','false');
      renderFiles();
      // Defer layout work to the next frame so iOS Safari repaints after the
      // native picker closes, then bring the preview + send button into view.
      requestAnimationFrame(()=>{
        renderFiles();
        const selected=root.querySelector('[data-chat-selected]');
        try{selected?.scrollIntoView?.({block:'nearest'});}catch(e){}
        try{send.scrollIntoView?.({block:'nearest'});}catch(e){}
      });
    }
    function recheckPicker(){
      if(!activePicker)return;
      const input=activePicker;
      clearPickerTimers();
      // Some Android/iOS builds populate input.files slightly after focus returns.
      for(const delay of [0,250,700,1500,3000])pickerTimers.push(setTimeout(()=>takePickedFiles(input),delay));
      pickerTimers.push(setTimeout(()=>{if(activePicker===input)activePicker=null;},3200));
    }
    const onPickerReturn=()=>{if(globalThis.document?.visibilityState!=='hidden')recheckPicker();};
    window.addEventListener?.('focus',onPickerReturn);
    document.addEventListener?.('visibilitychange',onPickerReturn);
    root.querySelectorAll('[data-pick]').forEach(button=>button.onclick=()=>{
      actions.hidden=true;plus.setAttribute('aria-expanded','false');
      const input=root.querySelector('[data-file="'+button.dataset.pick+'"]')||root.querySelector('[data-file]');
      if(!input)return;
      clearPickerTimers();
      activePicker=input;
      try{input.value='';}catch(e){}
      input.click();
    });
    root.querySelectorAll('[data-file]').forEach(input=>{
      input.addEventListener('change',()=>takePickedFiles(input));
      input.addEventListener('input',()=>takePickedFiles(input));
      // User dismissed the picker without choosing — close the actions panel.
      input.addEventListener('cancel',()=>{
        if(activePicker===input){activePicker=null;clearPickerTimers();}
        actions.hidden=true;plus.setAttribute('aria-expanded','false');
      });
    });
    root.querySelector('[data-chat-selected]').onclick=e=>{
      const hdBtn=e.target.closest('[data-chat-hd-toggle]');
      if(hdBtn){hdOriginalMode=!hdOriginalMode;files.forEach(f=>{f.hdOriginal=hdOriginalMode;});renderFiles();return;}
      const b=e.target.closest('[data-remove]');if(b){release(files.splice(Number(b.dataset.remove),1)[0]);renderFiles();}
    };
    root.querySelectorAll('[data-reference]').forEach(button=>button.onclick=async()=>{
      const target=root.querySelector('[data-chat-reference]');target.hidden=false;target.textContent='Đang tải…';
      try{
        const orders=button.dataset.reference==='orders',d=await request(orders?'/api/customer/orders':'/api/customer/marketing'),rows=orders?d.orders:d.wallet;
        target.innerHTML='<p>Chọn để phản hồi nhanh:</p>'+(rows.length?rows.map((r,i)=>`<button type="button" data-reference-item="${i}">${escape(orders?'Đơn '+r.orderNumber:r.code+' · '+r.title)}</button>`).join(''):'<p>Chưa có dữ liệu.</p>')+'<button type="button" data-reference-close>Đóng</button>';
        target.querySelector('[data-reference-close]').onclick=()=>target.hidden=true;
        target.querySelectorAll('[data-reference-item]').forEach(b=>b.onclick=()=>{
          const r=rows[Number(b.dataset.referenceItem)],text=orders?'Tôi cần hỗ trợ đơn hàng '+r.orderNumber+'.':'Tôi cần tư vấn voucher '+r.code+'.';
          target.hidden=true;actions.hidden=true;plus.setAttribute('aria-expanded','false');
          dispatchInstantSend(text,[]);
        });
      }catch(e){target.innerHTML='<p>'+escape(e.message)+'</p><a href="account.html">Đăng nhập tài khoản</a>';}
    });
    root.querySelectorAll('[data-offer]').forEach(button=>button.onclick=async()=>{
      const target=root.querySelector('[data-chat-reference]');let page=1;
      async function loadOffers(){
        target.hidden=false;target.textContent='Đang tải…';
        try{
          const d=await request(base+'/'+id+'/offers?kind='+button.dataset.offer+'&page='+page);
          const emptyNotice=button.dataset.offer==='orders'?'Chưa có đơn hàng nào phù hợp với khách này.':'Không có chương trình còn hiệu lực phù hợp với khách này.';
          target.innerHTML='<p>Chọn để gửi nhanh hoặc xem thông tin:</p>'+(d.items.length?d.items.map((r,i)=>`<button type="button" data-offer-item="${i}">${escape(r.title)}</button>`).join(''):'<p>'+emptyNotice+'</p>')+`<div class="chat-offer-pages"><button type="button" data-offer-prev ${page===1?'disabled':''}>Trước</button><span>Trang ${page}</span><button type="button" data-offer-next ${d.hasMore?'':'disabled'}>Tiếp</button><button type="button" data-offer-close>Đóng</button></div>`;
          target.querySelector('[data-offer-close]').onclick=()=>target.hidden=true;
          target.querySelector('[data-offer-prev]').onclick=()=>{page--;loadOffers();};target.querySelector('[data-offer-next]').onclick=()=>{page++;loadOffers();};
          target.querySelectorAll('[data-offer-item]').forEach(b=>b.onclick=()=>{
            const text=d.items[Number(b.dataset.offerItem)].text;
            target.hidden=true;actions.hidden=true;plus.setAttribute('aria-expanded','false');
            dispatchInstantSend(text,[]);
          });
        }catch(e){target.textContent=e.message;}
      }await loadOffers();
    });

    function safeUploadName(rawName){
      const s=String(rawName||'tep').trim()||'tep';
      if(s.length<=180)return s;
      const dot=s.lastIndexOf('.');
      if(dot>0&&s.length-dot<=16)return s.slice(0,180-(s.length-dot))+s.slice(dot);
      return s.slice(0,180);
    }
    function updateUploadProgressUI(state){
      const box=root.querySelector('[data-chat-upload-progress]');
      if(!box)return;
      if(!state){box.hidden=true;box.innerHTML='';return;}
      const wasHidden=box.hidden;
      const pct=Math.max(0,Math.min(100,Math.round(state.percent||0)));
      const speedText=state.bps>0?(state.bps>=1048576?(state.bps/1048576).toFixed(1)+' MB/s':Math.max(1,Math.round(state.bps/1024))+' KB/s'):'';
      box.hidden=false;
      box.innerHTML=`<div class="chat-upload-progress-row"><span class="chat-upload-progress-label">${escape(state.label||'Đang tải tệp lên…')}</span><span class="chat-upload-progress-meta">${pct}%${speedText?' · '+escape(speedText):''}</span><button type="button" class="chat-upload-cancel" data-cancel-upload data-no-action-feedback>Hủy</button></div><div class="chat-upload-progress-track"><div class="chat-upload-progress-fill" style="width:${pct}%"></div></div>`;
      if(wasHidden){try{box.scrollIntoView?.({block:'nearest'});}catch{}}
    }
    async function uploadFileInBackground(threadId,item,fileIndex=0,totalFiles=1){
      const abortCtrl=typeof AbortController==='function'?new AbortController():null;
      activeUploadAbort=abortCtrl;
      const labelPrefix=totalFiles>1?`Đang tải (${fileIndex+1}/${totalFiles}): `:'Đang tải: ';
      updateUploadProgressUI({label:labelPrefix+(item.file?.name||item.safeName||'tệp'),percent:4,bps:0});
      if(item.bufferPromise){
        const buffered=await item.bufferPromise.catch(()=>null);
        if(buffered)item.file=buffered;
        item.bufferPromise=null;
      }
      const prepared=item.prepared||(item.prepared=await compressFileInBackground(item.file,item));
      if(!prepared?.size)throw Error('Không đọc được dữ liệu tệp trên thiết bị (0 KB). Vui lòng chọn lại tệp.');
      const maxUploadBytes=getMaxUploadBytes();
      if(prepared.size>maxUploadBytes)throw Error(isVideoFile(item.file)?`Không thể tự nén video xuống dưới ${formatSize(maxUploadBytes)} (${formatSize(prepared.size)}). Vui lòng cắt ngắn video hoặc chọn video nhỏ hơn.`:`Dung lượng tệp (${formatSize(prepared.size)}) vượt quá mức ${formatSize(maxUploadBytes)}.`);
      const uploadName=safeUploadName(prepared.name||item.file?.name||item.safeName||'tep');

      async function toMemoryBlob(blobSlice){
        try{
          let ab=null;
          if(typeof blobSlice?.arrayBuffer==='function')ab=await blobSlice.arrayBuffer();
          else if(typeof Response==='function')ab=await new Response(blobSlice).arrayBuffer();
          if(ab){
            if(blobSlice.size>0&&!ab.byteLength)throw Error('EMPTY_SLICE');
            return new Blob([ab],{type:'application/octet-stream'});
          }
        }catch(e){
          if(e?.message==='EMPTY_SLICE')throw Error('Không đọc được dữ liệu phần tệp trên thiết bị. Vui lòng chọn lại tệp.');
        }
        return blobSlice;
      }

      async function doRequestWithRetry(url,makeOptions,maxAttempts=5){
        for(let attempt=1;attempt<=maxAttempts;attempt++){
          try{
            const opts=typeof makeOptions==='function'?await makeOptions():makeOptions;
            return await request(url,opts);
          }catch(err){
            if(abortCtrl?.signal?.aborted||err?.name==='AbortError')throw err;
            const status=Number(err?.status||0);
            const transient=!status||status===408||status===429||status>=502||/busy|capacity|timeout|network|failed to fetch|load failed/i.test(err?.message||'');
            if(transient&&attempt<maxAttempts){
              await new Promise(r=>setTimeout(r,Math.min(6000,attempt*1200)));
              continue;
            }
            if(status===404&&/expired|not started|stage/i.test(err?.message||'')){
              item.resumeFromChunk=0;
              item.key=crypto.randomUUID();
            }
            throw err;
          }
        }
      }

      // Adaptive chunk size (1 MiB -> 2 MiB -> 3 MiB) keeps large >120 MiB videos well under
      // server MAX_CHUNKS (256) and Cloudflare's 100 MB request cap while staying mobile-friendly.
      const chunkBytes=item.chunkBytes||(item.chunkBytes=chooseChunkBytes(prepared.size)),startedAt=Date.now();
      try{
      if(prepared.size>chunkBytes){
        const totalChunks=Math.ceil(prepared.size/chunkBytes);
        const startChunk=Number.isInteger(item.resumeFromChunk)&&item.resumeFromChunk>0&&item.resumeFromChunk<totalChunks?item.resumeFromChunk:0;
        let bytesTransferred=startChunk*chunkBytes;
        for(let i=startChunk;i<totalChunks;i++){
          if(abortCtrl?.signal?.aborted)throw Error('Đã hủy tải tệp lên.');
          const elapsed=Math.max(0.2,(Date.now()-startedAt)/1000);
          updateUploadProgressUI({label:`${labelPrefix}${uploadName} (phần ${i+1}/${totalChunks})`,percent:Math.round((bytesTransferred/prepared.size)*95)+2,bps:bytesTransferred>startChunk*chunkBytes?(bytesTransferred-startChunk*chunkBytes)/elapsed:0});
          const rawSlice=prepared.slice(i*chunkBytes,Math.min(prepared.size,(i+1)*chunkBytes));
          const memSlice=await toMemoryBlob(rawSlice);
          await doRequestWithRetry(base+'/'+threadId+'/files/chunk',()=>{
            const data=new FormData();
            data.append('file',memSlice,uploadName);
            data.append('requestKey',item.key);
            data.append('fileName',uploadName);
            data.append('chunkIndex',String(i));
            data.append('totalChunks',String(totalChunks));
            data.append('totalBytes',String(prepared.size));
            return {method:'POST',body:data,...(abortCtrl?{signal:abortCtrl.signal}:{})};
          });
          bytesTransferred+=rawSlice.size;
          item.resumeFromChunk=i+1;
          const elapsedAfter=Math.max(0.15,(Date.now()-startedAt)/1000);
          updateUploadProgressUI({label:`${labelPrefix}${uploadName}`,percent:Math.round((bytesTransferred/prepared.size)*98),bps:(bytesTransferred-startChunk*chunkBytes)/elapsedAfter});
        }
        item.resumeFromChunk=0;
      }else{
        if(abortCtrl?.signal?.aborted)throw Error('Đã hủy tải tệp lên.');
        updateUploadProgressUI({label:`${labelPrefix}${uploadName}`,percent:35,bps:0});
        const memFull=await toMemoryBlob(prepared);
        await doRequestWithRetry(base+'/'+threadId+'/files',()=>{
          const data=new FormData();
          data.append('file',memFull,uploadName);
          data.append('requestKey',item.key);
          return {method:'POST',body:data,...(abortCtrl?{signal:abortCtrl.signal}:{})};
        });
        const elapsed=Math.max(0.1,(Date.now()-startedAt)/1000);
        updateUploadProgressUI({label:`${labelPrefix}${uploadName}`,percent:100,bps:prepared.size/elapsed});
        void request(base+'/'+threadId+'/files/compress',{method:'POST',body:'{}'}).catch(()=>{});
      }
      }finally{
        if(activeUploadAbort===abortCtrl)activeUploadAbort=null;
        updateUploadProgressUI(null);
      }
    }

    function insertOptimisticBubble(reqKey,label,bodyText,previewHtml){
      const senderClass=admin?'from-admin':'from-customer';
      const senderLabel=admin?'GAERU':'';
      const typingNode=messages.querySelector('[data-ai-typing]');
      const headerHtml=admin?'<strong>'+escape(senderLabel)+'</strong>':'';
      const bodyHtml=bodyText?'<p>'+escape(bodyText)+'</p>':'';
      const html=`<article class="shopping-message ${senderClass} is-optimistic" data-optimistic-key="${escape(reqKey)}" data-sender="${admin?'admin':'customer'}">${headerHtml}${bodyHtml}${previewHtml||''}<time>${escape(label)}</time></article>`;
      if(typingNode)typingNode.insertAdjacentHTML('beforebegin',html);
      else messages.insertAdjacentHTML('beforeend',html);
      scrollToLatest(true);
      return messages.querySelector(`[data-optimistic-key="${CSS?.escape?CSS.escape(reqKey):reqKey}"]`);
    }

    function dispatchInstantSend(rawText,queuedFiles){
      if(thread?.status==='closed')return;
      const textBody=String(rawText||'').trim();
      if(!textBody&&!queuedFiles.length){feedback.textContent='Nhập tin nhắn hoặc chọn tệp.';return;}
      collapseQuickReplies();
      feedback.textContent='';
      const msgKey=crypto.randomUUID();
      const nowLabel=new Date().toLocaleString('vi-VN');

      // 1. Ưu tiên gửi và hiển thị tin nhắn văn bản trước
      const textNode=textBody?insertOptimisticBubble(msgKey,nowLabel,textBody,''):null;
      if(queuedFiles.length){
        feedback.textContent='Đang chuẩn bị và tải lên '+queuedFiles.length+' tệp...';
      }

      bgChain=bgChain.then(async()=>{
        try{
          const firstBody=textBody||'Tôi gửi tệp để được tư vấn.';
          if(!id){
            const d=await request(base,{method:'POST',body:JSON.stringify({productSlug,body:firstBody,requestKey:msgKey})});
            id=d.thread.id; poll?.setStreamUrl?.(base+'/'+id+'/realtime-sse');
          }else if(textBody){
            await request(base+'/'+id+'/messages',{method:'POST',body:JSON.stringify({body:textBody,requestKey:msgKey})});
          }
          if(!queuedFiles.length)scheduleFastAIRefresh();
        }catch(error){
          syncAiTypingIndicator(false);
          if(queuedFiles.length){
            if(!id){
              files.unshift(...queuedFiles);
              renderFiles();
            }else{
              for(const item of queuedFiles){
                const displayName=item.file?.name||item.safeName||'tệp';
                const errContent='<div class="chat-file-wrap" data-file-wrap><div class="chat-file-chip"><span class="chat-file-chip-icon">⚠️</span><div class="chat-file-chip-info"><strong>'+escape(displayName)+'</strong><div data-file-err><small class="chat-upload-err-text">Chưa tải lên do lỗi gửi tin nhắn.</small> <button type="button" class="chat-retry-upload" data-retry-file="'+escape(item.key)+'" data-no-action-feedback>Thử lại</button></div></div></div></div>';
                const errNode=insertOptimisticBubble(item.key,new Date().toLocaleString('vi-VN'),'',errContent);
                pendingUploads.set(item.key,{item,node:errNode});
              }
            }
          }
          if(textNode){
            textNode.insertAdjacentHTML('beforeend','<small class="chat-bg-status chat-bg-error">Chưa gửi được: '+escape(error.message)+' <button type="button" class="chat-retry-upload" data-retry-msg="true" data-retry-body="'+escape(textBody)+'" data-no-action-feedback>Thử lại</button></small>');
          }
          feedback.textContent=error.message+(queuedFiles.length?' (Các tệp đính kèm vẫn được giữ lại để thử lại.)':'');
          return;
        }

        // 2. Tải tệp lên; file, video, ảnh chỉ hiển thị sau khi hoàn thành tải lên
        uploadCancelled=false;
        let anySuccess=false;
        const uploadedItems=[];
        for(let idx=0;idx<queuedFiles.length;idx++){
          const item=queuedFiles[idx];
          const displayName=item.file?.name||item.safeName||'tệp';
          feedback.textContent='Đang tải tệp ('+(idx+1)+'/'+queuedFiles.length+'): '+displayName+'...';
          try{
            await uploadFileInBackground(id,item,idx,queuedFiles.length);
            uploadedItems.push(item);
            anySuccess=true;

            // Hiển thị tệp sau khi hoàn thành tải lên
            let preview='';
            if(item.url){
              preview=media(item.url,item.file.type,displayName);
            }
            if(!preview){
              preview='<div class="chat-file-chip"><span class="chat-file-chip-icon">'+ICONS.file+'</span><div class="chat-file-chip-info"><strong>'+escape(displayName)+'</strong><small>'+formatSize(item.file.size)+' · Đã tải lên</small></div></div>';
            }
            const fileContent='<div class="chat-file-wrap" data-file-wrap>'+preview+'</div>';
            insertOptimisticBubble(item.key,new Date().toLocaleString('vi-VN'),'',fileContent);
          }catch(fileErr){
            if(uploadCancelled||fileErr?.name==='AbortError'){
              const remaining=queuedFiles.slice(idx);
              if(remaining.length){
                files.unshift(...remaining);
                renderFiles();
              }
              feedback.textContent='Đã hủy tải tệp lên. Các tệp chưa tải vẫn còn trong hàng đợi.';
              break;
            }
            feedback.textContent='Chưa tải được tệp "'+(item.file?.name||item.safeName||'tệp')+'": '+fileErr.message;
            const errContent='<div class="chat-file-wrap" data-file-wrap><div class="chat-file-chip"><span class="chat-file-chip-icon">⚠️</span><div class="chat-file-chip-info"><strong>'+escape(item.file?.name||item.safeName||'tệp')+'</strong><div data-file-err><small class="chat-upload-err-text">Lỗi: '+escape(fileErr.message)+'</small> <button type="button" class="chat-retry-upload" data-retry-file="'+escape(item.key)+'" data-no-action-feedback>Thử lại</button></div></div></div></div>';
            const errNode=insertOptimisticBubble(item.key,new Date().toLocaleString('vi-VN'),'',errContent);
            pendingUploads.set(item.key,{item,node:errNode});
            try{errNode?.scrollIntoView?.({block:'nearest'});}catch{}
            try{feedback.scrollIntoView?.({block:'nearest'});}catch{}
          }
        }
        try{await refresh();}finally{for(const item of uploadedItems)release(item);}
        if(!admin&&thread?.aiPending)scheduleFastAIRefresh();
        if(anySuccess&&uploadedItems.length===queuedFiles.length)feedback.textContent='';
      });
    }

    form.onsubmit=async e=>{
      e.preventDefault();
      if(thread?.status==='closed')return;
      const wasFocused=typeof document!=='undefined'&&document.activeElement===form.elements.body;
      const bodyText=form.elements.body.value.trim();
      const queued=files.splice(0,files.length);
      if(!bodyText&&!queued.length){feedback.textContent='Nhập tin nhắn hoặc chọn tệp.';return;}
      form.elements.body.value='';form.elements.body.style.height='';
      if(wasFocused&&!form.elements.body.disabled)form.elements.body.focus?.({preventScroll:true});
      renderFiles();
      dispatchInstantSend(bodyText,queued);
    };

    async function requestHuman(){if(sending||thread?.status==='closed')return;sending=true;setClosed();try{if(!id){const d=await request(base,{method:'POST',body:JSON.stringify({productSlug,body:'Tôi muốn gặp nhân viên.',requestKey:crypto.randomUUID()})});id=d.thread.id;poll?.setStreamUrl?.(base+'/'+id+'/realtime-sse');}await request(base+'/'+id+'/handoff',{method:'POST',body:JSON.stringify({})});await refresh();feedback.textContent='';}catch(e){feedback.textContent=e.message;}finally{sending=false;setClosed();}}
    async function endChatSession(){
      if(admin||sending||thread?.status==='closed')return;
      actions.hidden=true;plus.setAttribute('aria-expanded','false');collapseQuickReplies();
      if(!id){
        const dialog=root.closest('dialog');
        if(dialog?.open)dialog.close();
        return;
      }
      sending=true;setClosed();
      try{
        clearFastAiTimers();
        syncAiTypingIndicator(false);
        await request(base+'/'+id+'/close',{method:'POST',body:JSON.stringify({})});
        await refresh();
        feedback.textContent='';
      }catch(e){
        feedback.textContent=e.message;
      }finally{
        sending=false;setClosed();
      }
    }
    function startNewChatSession(){
      if(admin)return;
      clearFastAiTimers();
      syncAiTypingIndicator(false);
      id=null;thread=null;poll?.setStreamUrl?.(null);
      messages.innerHTML='';
      root.querySelector('[data-chat-earlier]').hidden=true;
      actions.hidden=true;plus.setAttribute('aria-expanded','false');
      collapseQuickReplies();
      feedback.textContent='';
      setClosed();
      form.elements.body.focus?.({preventScroll:true});
    }
    async function retryFileUpload(fileKey){
      const entry=pendingUploads.get(fileKey);
      if(!entry||!id)return;
      const {item,node}=entry;
      const wrap=node?.querySelector('[data-file-wrap]');
      const errEl=node?.querySelector('[data-file-err]');
      if(errEl)errEl.hidden=true;
      let spinner=node?.querySelector('[data-file-spinner]');
      if(!spinner&&wrap){
        wrap.insertAdjacentHTML('beforeend','<div class="chat-file-spinner" data-file-spinner aria-label="Đang xử lý và tải tệp..."><svg class="chat-spinner-svg" viewBox="0 0 24 24"><circle class="chat-spinner-circle" cx="12" cy="12" r="9"/></svg></div>');
      }
      feedback.textContent='';
      try{
        await uploadFileInBackground(id,item);
        node?.querySelector('[data-file-spinner]')?.remove();
        pendingUploads.delete(item.key);
        release(item);
        await refresh();
        feedback.textContent='';
      }catch(err){
        node?.querySelector('[data-file-spinner]')?.remove();
        if(errEl){
          errEl.hidden=false;
          errEl.innerHTML=`<span class="chat-upload-err-text">Lỗi: ${escape(err.message)}</span> <button type="button" class="chat-retry-upload" data-retry-file="${escape(item.key)}" data-no-action-feedback>Thử lại</button>`;
        }
        feedback.textContent=`Chưa tải được tệp "${item.file?.name||item.safeName||'tệp'}": ${err.message}`;
        try{feedback.scrollIntoView?.({block:'nearest'});}catch{}
      }
    }
    function dialHotline(event){
      const hotlineEl=event.target.closest('button[data-chat-hotline]');
      if(!hotlineEl)return;
      actions.hidden=true;plus.setAttribute('aria-expanded','false');
      collapseQuickReplies();
      if(typeof window!=='undefined'&&window.location)window.location.href='tel:0829191080';
    }
    function pickAudioRecorderType(){
      if(typeof MediaRecorder==='undefined'||typeof MediaRecorder.isTypeSupported!=='function')return null;
      const types=[
        {mime:'audio/mp4',ext:'m4a'},
        {mime:'audio/webm;codecs=opus',ext:'weba'},
        {mime:'audio/webm',ext:'weba'},
        {mime:'audio/ogg;codecs=opus',ext:'ogg'},
        {mime:'audio/ogg',ext:'ogg'}
      ];
      return types.find(t=>{try{return MediaRecorder.isTypeSupported(t.mime);}catch{return false;}})||null;
    }
    function stopVoiceRecording(keepAudio=false){
      if(!voiceState)return;
      const st=voiceState;
      voiceState=null;
      clearInterval(st.timer);
      const voiceBar=root.querySelector('[data-chat-voice-bar]');
      if(voiceBar){voiceBar.hidden=true;voiceBar.innerHTML='';}
      try{
        st.keepAudio=keepAudio;
        if(st.recorder&&st.recorder.state!=='inactive')st.recorder.stop();
        else st.stream?.getTracks?.().forEach(t=>t.stop());
      }catch{
        try{st.stream?.getTracks?.().forEach(t=>t.stop());}catch{}
      }
    }
    async function startVoiceRecording(){
      if(thread?.status==='closed')return;
      actions.hidden=true;plus.setAttribute('aria-expanded','false');collapseQuickReplies();
      if(voiceState){stopVoiceRecording(true);return;}
      if(!navigator?.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){
        feedback.textContent='Thiết bị hoặc trình duyệt hiện tại chưa hỗ trợ ghi âm trực tiếp.';
        return;
      }
      const chosen=pickAudioRecorderType()||{mime:'',ext:'weba'};
      try{
        const stream=await navigator.mediaDevices.getUserMedia({audio:true});
        const chunks=[];
        const recorder=chosen.mime?new MediaRecorder(stream,{mimeType:chosen.mime}):new MediaRecorder(stream);
        const st={stream,recorder,chunks,startedAt:Date.now(),keepAudio:false,timer:0};
        voiceState=st;
        recorder.ondataavailable=ev=>{if(ev.data&&ev.data.size)chunks.push(ev.data);};
        recorder.onstop=()=>{
          try{stream.getTracks().forEach(t=>t.stop());}catch{}
          if(!st.keepAudio||!chunks.length)return;
          const outMime=(chosen.mime||recorder.mimeType||'audio/webm').split(';')[0];
          const ext=outMime.includes('mp4')?'m4a':outMime.includes('ogg')?'ogg':'weba';
          const stamp=new Date().toTimeString().slice(0,8).replace(/:/g,'');
          const blob=new Blob(chunks,{type:outMime});
          if(!blob.size)return;
          const file=new File([blob],`ghi-am-${stamp}.${ext}`,{type:outMime});
          addRawFiles([file]);
        };
        recorder.start(250);
        const voiceBar=root.querySelector('[data-chat-voice-bar]');
        const renderVoiceBar=()=>{
          if(!voiceBar||voiceState!==st)return;
          const sec=Math.max(0,Math.floor((Date.now()-st.startedAt)/1000));
          const mm=String(Math.floor(sec/60)).padStart(2,'0'),ss=String(sec%60).padStart(2,'0');
          voiceBar.hidden=false;
          voiceBar.innerHTML=`<span class="chat-voice-dot"></span><span class="chat-voice-time">Đang ghi âm ${mm}:${ss}</span><button type="button" class="chat-voice-cancel" data-voice-cancel data-no-action-feedback>Hủy</button><button type="button" class="chat-voice-done" data-voice-done data-no-action-feedback>Đính kèm ghi âm</button>`;
        };
        renderVoiceBar();
        st.timer=setInterval(renderVoiceBar,500);
        feedback.textContent='';
      }catch{
        feedback.textContent='Không thể truy cập micro. Vui lòng cấp quyền micro cho trình duyệt để ghi âm.';
      }
    }
    function openMediaLightbox(clickedImg){
      if(typeof document==='undefined'||!clickedImg)return;
      const allImgs=[...root.querySelectorAll('img[data-chat-lightbox-src]')];
      const index=Math.max(0,allImgs.indexOf(clickedImg));
      let dlg=document.querySelector('dialog.chat-media-lightbox');
      if(!dlg){
        dlg=document.createElement('dialog');
        dlg.className='chat-media-lightbox';
        document.body.appendChild(dlg);
        dlg.addEventListener('click',ev=>{
          const state=dlg._lightboxState;
          if(!state)return;
          if(ev.target===dlg||ev.target.closest('[data-lightbox-close]')){dlg.close();return;}
          if(ev.target.closest('[data-lightbox-zoom]')){
            state.zoomed=!state.zoomed;
            dlg.querySelector('.chat-lightbox-img')?.classList.toggle('is-zoomed',state.zoomed);
            const zoomBtn=dlg.querySelector('[data-lightbox-zoom]');
            if(zoomBtn)zoomBtn.textContent=state.zoomed?'Thu nhỏ 1x':'Phóng to 2x';
            return;
          }
          if(ev.target.closest('[data-lightbox-prev]')){
            state.index=(state.index-1+state.allImgs.length)%state.allImgs.length;state.zoomed=false;state.renderSlide();return;
          }
          if(ev.target.closest('[data-lightbox-next]')){
            state.index=(state.index+1)%state.allImgs.length;state.zoomed=false;state.renderSlide();return;
          }
        });
      }
      const state={allImgs,index,zoomed:false,clickedImg,renderSlide:null};
      state.renderSlide=function(){
        const current=state.allImgs[state.index]||state.clickedImg;
        const src=current.getAttribute('data-chat-lightbox-src')||current.src||'';
        const alt=current.getAttribute('alt')||'Hình ảnh đính kèm';
        const dlUrl=src.includes('?')?src+'&download=1':src+'?download=1';
        dlg.innerHTML=`<div class="chat-lightbox-bar"><span class="chat-lightbox-title">${escape(alt)}${state.allImgs.length>1?` (${state.index+1}/${state.allImgs.length})`:''}</span><div class="chat-lightbox-actions"><button type="button" data-lightbox-zoom>${state.zoomed?'Thu nhỏ 1x':'Phóng to 2x'}</button><a href="${escape(dlUrl)}" target="_blank" rel="noopener">↓ Tải xuống</a><button type="button" data-lightbox-close aria-label="Đóng">×</button></div></div><div class="chat-lightbox-stage">${state.allImgs.length>1?'<button type="button" class="chat-lightbox-nav is-prev" data-lightbox-prev aria-label="Ảnh trước">‹</button>':''}<img class="chat-lightbox-img" src="${escape(src)}" alt="${escape(alt)}">${state.allImgs.length>1?'<button type="button" class="chat-lightbox-nav is-next" data-lightbox-next aria-label="Ảnh tiếp">›</button>':''}</div>`;
      };
      dlg._lightboxState=state;
      state.renderSlide();
      if(typeof dlg.showModal==='function'){if(!dlg.open)dlg.showModal();}
      else dlg.setAttribute('open','');
    }
    form.addEventListener?.('paste',event=>{
      const cd=event.clipboardData;
      if(!cd||thread?.status==='closed')return;
      const pasted=[];
      if(cd.files&&cd.files.length){
        for(const f of cd.files)pasted.push(f);
      }else if(cd.items&&cd.items.length){
        for(const item of cd.items){
          if(item.kind==='file'){const f=item.getAsFile?.();if(f)pasted.push(f);}
        }
      }
      if(!pasted.length)return;
      event.preventDefault();
      const stamp=new Date().toTimeString().slice(0,8).replace(/:/g,'');
      const normalized=pasted.map((f,i)=>{
        if(!f.name||/^image(\.[a-z0-9]+)?$/i.test(f.name)){
          const ext=(f.type||'image/png').split('/')[1]?.replace(/[^a-z0-9]/gi,'')||'png';
          try{return new File([f],`anh-chup-man-hinh-${stamp}${i?'-'+(i+1):''}.${ext}`,{type:f.type||'image/png'});}catch{return f;}
        }
        return f;
      });
      addRawFiles(normalized);
    });
    let dragDepth=0;
    root.addEventListener?.('dragenter',event=>{
      if(!event.dataTransfer?.types?.includes?.('Files')||thread?.status==='closed')return;
      event.preventDefault();
      dragDepth++;
      root.classList.add('is-dragover');
    });
    root.addEventListener?.('dragover',event=>{
      if(!event.dataTransfer?.types?.includes?.('Files')||thread?.status==='closed')return;
      event.preventDefault();
      root.classList.add('is-dragover');
    });
    root.addEventListener?.('dragleave',()=>{
      dragDepth=Math.max(0,dragDepth-1);
      if(!dragDepth)root.classList.remove('is-dragover');
    });
    root.addEventListener?.('drop',event=>{
      dragDepth=0;
      root.classList.remove('is-dragover');
      if(!event.dataTransfer?.files?.length||thread?.status==='closed')return;
      event.preventDefault();
      addRawFiles([...event.dataTransfer.files]);
    });
    root.addEventListener('click',event=>{
      const lightImg=event.target.closest('img[data-chat-lightbox-src]');
      if(lightImg){
        event.preventDefault();
        openMediaLightbox(lightImg);
        return;
      }
      if(event.target.closest('[data-cancel-upload]')){
        event.preventDefault();
        uploadCancelled=true;
        try{activeUploadAbort?.abort?.();}catch{}
        updateUploadProgressUI(null);
        return;
      }
      if(event.target.closest('[data-chat-voice-btn]')){
        event.preventDefault();
        void startVoiceRecording();
        return;
      }
      if(event.target.closest('[data-voice-cancel]')){
        event.preventDefault();
        stopVoiceRecording(false);
        return;
      }
      if(event.target.closest('[data-voice-done]')){
        event.preventDefault();
        stopVoiceRecording(true);
        return;
      }
      const retryMsgBtn=event.target.closest('[data-retry-msg]');
      if(retryMsgBtn){
        event.preventDefault();
        const retryBody=retryMsgBtn.dataset.retryBody;
        const msgNode=retryMsgBtn.closest('.shopping-message');
        if(msgNode)msgNode.remove();
        if(retryBody){
          const pending=!id?files.splice(0,files.length):[];
          if(pending.length)renderFiles();
          dispatchInstantSend(retryBody,pending);
        }
        return;
      }
      const retryBtn=event.target.closest('[data-retry-file]');
      if(retryBtn){
        event.preventDefault();
        void retryFileUpload(retryBtn.dataset.retryFile);
        return;
      }
      if(event.target.closest('button[data-chat-hotline]'))dialHotline(event);
      else if(event.target.closest('[data-inline-handoff],[data-chat-human]'))void requestHuman();
      else if(event.target.closest('[data-chat-end]'))void endChatSession();
      else if(event.target.closest('[data-chat-new]'))startNewChatSession();
    });
    const supportTimer=setInterval(()=>{if(!stopped)syncSupport();},1000);
    if(!admin)void loadCapabilities();
    const updateLiveStatus=(text)=>{
      const statusStr=String(text||'');
      const isRealtime=statusStr.includes('SSE')||statusStr.includes('Thời gian thực');
      const isOffline=statusStr.includes('Mất')||(typeof navigator==='object'&&navigator.onLine===false);
      const isReconnecting=statusStr.includes('Đang tự kết nối')||statusStr.includes('Chưa cập nhật');
      const isOnline=isRealtime||statusStr.includes('Tự cập nhật')||(!isOffline&&!isReconnecting);
      const badges=[...root.querySelectorAll('[data-chat-live-badge]'),...(root.closest('dialog')?[...root.closest('dialog').querySelectorAll('[data-chat-live-badge]')]:[])];
      const labels=[...root.querySelectorAll('[data-chat-live-text]'),...(root.closest('dialog')?[...root.closest('dialog').querySelectorAll('[data-chat-live-text]')]:[])];
      badges.forEach(b=>{
        b.classList.toggle('is-fallback',!isOnline||isReconnecting);
        b.classList.toggle('is-offline',isOffline);
        b.title=isRealtime?'Thời gian thực (SSE 0ms)':(isOffline?'Mất kết nối mạng':(isReconnecting?'Đang kết nối lại...':'Sẵn sàng kết nối'));
      });
      labels.forEach(l=>{
        l.textContent=isOffline?'Mất mạng':(isReconnecting?'Đang kết nối':(isOnline?'Trực tuyến':'Đang kết nối'));
      });
    };
    const poll = (window.GAERUCareLive && typeof window.GAERUCareLive.poll === 'function')
      ? window.GAERUCareLive.poll({streamUrl:id?base+'/'+id+'/realtime-sse':null,delay:2000,active:()=>!stopped&&root.isConnected&&(!root.closest('dialog')||root.closest('dialog').open)&&!root.closest('.view-panel')?.hidden,run:()=>{if(!admin&&Date.now()-capabilitiesReadAt>60000)void loadCapabilities();return refresh();},status:updateLiveStatus})
      : { stop(){} };
    if(id)refresh().catch(e=>feedback.textContent=e.message);
    return {refresh,stop(){stopped=true;stopVoiceRecording(false);try{activeUploadAbort?.abort?.();}catch{}clearFastAiTimers();clearPickerTimers();activePicker=null;window.removeEventListener?.('focus',onPickerReturn);document.removeEventListener?.('visibilitychange',onPickerReturn);poll.stop();clearInterval(supportTimer);files.forEach(release);files=[];pendingUploads.clear();},get thread(){return thread;}};
  }};
})();
