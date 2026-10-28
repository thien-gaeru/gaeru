(()=>{
 const choices=window.GAERUVariantChoices,form=document.querySelector('#workspace-form'),status=document.querySelector('#workspace-status');
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const slugify=v=>v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
 const money=v=>new Intl.NumberFormat('vi-VN').format(v)+' ₫';
 const editingTrash=/(?:[?&])trash=1(?:&|$)/.test(location.search||'');
 let model={product:{name:'',slug:'',category:'audio',descriptor:'',cardTitle:'',cardSummary:'',description:'',imageUrl:'',imageAlt:'',active:false,sortOrder:0},gallery:[],groups:[],variants:[],descriptionMedia:[]},user=null,busy=false,dirty=false;const disabledStates=new WeakMap();const imageUploads=[];let uploadWorker=null;
 const can=p=>user?.permissions?.includes(p),imageUrl=u=>{const path=u.startsWith('/api/catalog-images/')?u.replace('/api/catalog-images/','/api/gaeru_ceo/catalog-images/'):u.startsWith('/api/catalog-videos/')?u.replace('/api/catalog-videos/','/api/gaeru_ceo/catalog-videos/'):u;return window.GAERUAdminUI?.imageUrl(path)??path;};
 
 async function request(path,method='GET',body){
   const headers={};
   if(method!=='GET'){
     const r=await fetch('/api/csrf',{credentials:'same-origin',cache:'no-store'});
     headers['X-CSRF-Token']=(await r.json()).csrfToken;
     if(!(body instanceof FormData))headers['Content-Type']='application/json';
   }
   const r=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers,...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});
   const data=await r.json();
   if(!r.ok){
     const err=Error(data.error||'Không thể lưu thay đổi.');
     err.status=r.status;
     err.data=data;
     throw err;
   }
   return data;
 }

 function lock(value){
   busy=value;
   for(const element of form.querySelectorAll('input,select,textarea,button')){
     if(value){
       disabledStates.set(element,element.disabled);
       element.disabled=true;
     }else{
       element.disabled=disabledStates.has(element)?disabledStates.get(element):!can('catalog.write')||(element.matches('[data-field=stockQuantity]')&&!can('inventory.approve'));
       disabledStates.delete(element);
     }
   }
   document.querySelectorAll('[data-save]').forEach(b=>b.disabled=value||!can('catalog.write'));
   const gf=document.querySelector('#gallery-files');if(gf)gf.disabled=value||!can('catalog.write');
   const bs=document.querySelector('#bulk-stock');if(bs)bs.disabled=value||!can('inventory.approve');
 }

 function feedback(message,isError=false){
   if(status){
     status.textContent=message;
     status.classList.toggle('is-error',isError);
   }
 }

 function clearValidationErrors(){
   document.querySelectorAll('.is-invalid').forEach(el=>el.classList.remove('is-invalid'));
   document.querySelectorAll('.field-error-msg').forEach(el=>el.remove());
   document.querySelectorAll('.workspace-card.has-error').forEach(el=>el.classList.remove('has-error'));
 }

 function showFieldError(element,message){
   if(!element)return;
   element.classList.add('is-invalid');
   const card=element.closest('.workspace-card');
   if(card)card.classList.add('has-error');
   const parent=element.closest('.workspace-fields label')||element.closest('.option-value-cell')||element.parentElement;
   if(parent&&!parent.querySelector('.field-error-msg')){
     const errDiv=document.createElement('div');
     errDiv.className='field-error-msg';
     errDiv.textContent=message;
     parent.appendChild(errDiv);
   }
 }

 function applyIssues(issues){
   clearValidationErrors();
   for(const issue of issues){
     const p=(issue.path||[]).join('.');
     let target=null;
     if(p==='product.name')target=form.elements.name;
     else if(p==='product.slug')target=form.elements.slug;
     else if(p==='gallery'||p.startsWith('gallery'))target=document.querySelector('#gallery');
     else if(p==='product.descriptor')target=form.elements.descriptor;
     else if(p==='product.cardTitle')target=form.elements.cardTitle;
     else if(p==='product.cardSummary')target=form.elements.cardSummary;
     else if(p==='product.description')target=document.querySelector('#description-media');
     else if(p.includes('sku')){
       const match=p.match(/variants\.(\d+)\.sku/);
       if(match)target=document.querySelector('[data-variant-index="'+match[1]+'"] [data-field="sku"]');
       else target=document.querySelector('#simple-sku');
     }else if(p.includes('priceVnd')){
       const match=p.match(/variants\.(\d+)\.priceVnd/);
       if(match)target=document.querySelector('[data-variant-index="'+match[1]+'"] [data-field="priceVnd"]');
       else target=document.querySelector('#simple-price');
     }else if(p.includes('stockQuantity')){
       const match=p.match(/variants\.(\d+)\.stockQuantity/);
       if(match)target=document.querySelector('[data-variant-index="'+match[1]+'"] [data-field="stockQuantity"]');
       else target=document.querySelector('#simple-stock');
     }
     if(target)showFieldError(target,issue.message||'Dữ liệu chưa hợp lệ.');
   }
   const first=document.querySelector('.is-invalid');
   if(first){
     try{first.scrollIntoView({behavior:'smooth',block:'center'});}catch(e){}
     try{first.focus();}catch(e){}
   }
 }

 form.addEventListener('input',e=>{
   if(e.target.classList.contains('is-invalid')){
     e.target.classList.remove('is-invalid');
     const p=e.target.closest('.workspace-fields label')||e.target.parentElement;
     p?.querySelectorAll('.field-error-msg').forEach(m=>m.remove());
   }
 });
 form.addEventListener('change',e=>{
   if(e.target.classList.contains('is-invalid')){
     e.target.classList.remove('is-invalid');
     const p=e.target.closest('.workspace-fields label')||e.target.parentElement;
     p?.querySelectorAll('.field-error-msg').forEach(m=>m.remove());
   }
 });

 function product(){
   return {
     ...model.product,
     name:form.elements.name.value.trim(),
     slug:form.elements.slug.value.trim(),
     category:form.elements.category.value,
     descriptor:form.elements.descriptor.value,
     cardTitle:form.elements.cardTitle.value.trim(),
     cardSummary:form.elements.cardSummary.value.trim(),
     description:form.elements.description.value,
     imageUrl:model.gallery[0]||'',
     imageAlt:form.elements.imageAlt.value,
     sortOrder:Number(form.elements.sortOrder.value)
   };
 }

 function readRows(){
   for(const row of document.querySelectorAll('[data-variant-index]')){
     const v=model.variants[Number(row.dataset.variantIndex)];
     if(!v)continue;
     for(const key of ['sku','name','imageUrl']){
       const field=row.querySelector('[data-field="'+key+'"]');
       if(field)v[key]=field.value;
     }
     for(const key of ['priceVnd','stockQuantity']){
       const field=row.querySelector('[data-field="'+key+'"]');
       if(field){
         const value=field.value;
         v[key]=value===''?null:Number(value);
       }
     }
     const act=row.querySelector('[data-field=active]');
     if(act)v.active=act.checked;
   }
 }

 function groupsFromForm(){
   const groups=[...document.querySelectorAll('[data-group-index]')].map(row=>({
     name:row.querySelector('[data-group-name]').value.trim(),
     values:[...row.querySelectorAll('[data-group-value]')].map(input=>input.value.trim()).filter(Boolean)
   }));
   if(new Set(groups.map(g=>g.name.toLowerCase())).size!==groups.length)throw Error('Tên nhóm phân loại không được trùng.');
   for(const g of groups){
     if(g.values.length>20||g.values.some(v=>v.length>80))throw Error('Mỗi nhóm tối đa 20 lựa chọn, mỗi lựa chọn tối đa 80 ký tự.');
     if(new Set(g.values.map(v=>v.toLowerCase())).size!==g.values.length)throw Error('Lựa chọn trong một nhóm không được trùng.');
     if(model.variants.some(v=>v.id&&v.options[g.name]&&!g.values.includes(v.options[g.name])))throw Error('Không bỏ lựa chọn đã có trong biến thể được lưu. Hãy tạm ẩn biến thể nếu ngừng bán.');
   }
   return groups;
 }

 function preview(){
   const p=product(),active=model.variants.filter(v=>v.active&&v.priceVnd!==null),prices=active.map(v=>v.priceVnd);
   const prev=document.querySelector('#product-preview');
   if(!prev)return;
   prev.innerHTML=`${model.gallery[0]?`<img src="${esc(imageUrl(model.gallery[0]))}" alt="${esc(p.imageAlt||p.name)}">`:'<div class="preview-placeholder">Thêm ảnh sản phẩm</div>'}<h3>${esc(p.cardTitle||p.name||'Tên sản phẩm')}</h3><p>${esc(p.cardSummary||p.descriptor||'Thông điệp giới thiệu ngắn')}</p><strong>${prices.length?money(Math.min(...prices))+(Math.min(...prices)!==Math.max(...prices)?' – '+money(Math.max(...prices)):''):'Chưa có giá bán'}</strong><div class="preview-options">${model.groups.map(g=>`<p>${esc(g.name)}</p><div>${g.values.map(v=>`<span>${esc(v)}</span>`).join('')}</div>`).join('')}</div><small>${model.variants.length} biến thể · ${model.inTrash?'Đã xóa':model.product.active?'Đang hiển thị':'Bản nháp'}</small>`;
 }

 function gallery(){
   const gHost=document.querySelector('#gallery');
   if(!gHost)return;
   gHost.innerHTML=model.gallery.map((url,i)=>'<article class="gallery-item"><img src="'+esc(imageUrl(url))+'" alt="Ảnh sản phẩm '+(i+1)+'"><span>'+(i===0?'Ảnh chính':'Ảnh '+(i+1))+'</span><div>'+(i?'<button type="button" data-main-image="'+i+'">Đặt ảnh chính</button>':'')+'<button type="button" data-remove-image="'+i+'" aria-label="Bỏ ảnh '+(i+1)+'">×</button></div></article>').join('')+imageUploads.map(item=>'<article class="gallery-item upload-pending" aria-busy="'+(item.error?'false':'true')+'"><img src="'+esc(item.preview)+'" alt="'+esc(item.file.name)+'"><span>'+(item.error?'Tải chưa thành công':'Đang tải ảnh…')+'</span><div>'+(item.error?'<button type="button" data-retry-upload="'+item.id+'">Thử lại</button><button type="button" data-discard-upload="'+item.id+'">Bỏ</button>':'<small>Có thể tiếp tục nhập sản phẩm</small>')+'</div></article>').join('')+(!model.gallery.length&&!imageUploads.length?'<button type="button" class="gallery-slot is-main" data-upload-slot aria-label="Tải ảnh chính"><span aria-hidden="true">＋</span>Ảnh chính</button>':'')+(model.gallery.length+imageUploads.length<9?'<button type="button" class="gallery-slot" data-upload-slot aria-label="Thêm ảnh sản phẩm"><span aria-hidden="true">＋</span>Thêm ảnh · '+(model.gallery.length+imageUploads.length)+'/9</button>':'');
   preview();
 }

 function syncSimpleInputs(){
   const v=model.variants[0]||{};
   const sPrice=document.querySelector('#simple-price');
   const sStock=document.querySelector('#simple-stock');
   const sSku=document.querySelector('#simple-sku');
   if(sPrice&&v.priceVnd!==undefined&&v.priceVnd!==null)sPrice.value=v.priceVnd;
   if(sStock&&v.stockQuantity!==undefined&&v.stockQuantity!==null)sStock.value=v.stockQuantity;
   if(sSku){
     if(v.sku)sSku.value=v.sku;
     else if(!sSku.value){
       sSku.value=(slugify(form.elements.slug?.value||form.elements.name?.value||'GAERU').toUpperCase()+'-01').slice(0,50);
       v.sku=sSku.value;
     }
   }
 }

 function setOptionMode(mode){
   const btnSimple=document.querySelector('#btn-mode-simple');
   const btnVariants=document.querySelector('#btn-mode-variants');
   const simpleCard=document.querySelector('#simple-product-card');
   const variantsCard=document.querySelector('#variants-product-card');
   const varTableSection=document.querySelector('#variants');
   if(btnSimple)btnSimple.classList.toggle('is-active',mode==='simple');
   if(btnVariants)btnVariants.classList.toggle('is-active',mode==='variants');
   if(simpleCard)simpleCard.hidden=mode!=='simple';
   if(variantsCard)variantsCard.hidden=mode!=='variants';
   if(varTableSection){
     const heading=varTableSection.querySelector('h2');
     if(heading)heading.textContent=mode==='simple'?'Bảng chi tiết phiên bản':'Giá bán & tồn kho từng biến thể';
   }
 }

 function groupEditor(){
   const gHost=document.querySelector('#option-groups');
   if(!gHost)return;
   gHost.innerHTML=model.groups.map((g,i)=>{
     const existing=model.variants.some(v=>v.id&&Object.hasOwn(v.options,g.name));
     const values=g.values.length?g.values:[''];
     return '<section class="option-group" data-group-index="'+i+'"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><label style="flex:1;margin:0;"><strong>Tên nhóm '+(i+1)+'</strong><input data-group-name value="'+esc(g.name)+'" maxlength="50" '+(existing?'readonly':'')+' placeholder="Ví dụ: Cổng kết nối"></label><button type="button" class="plain-button" data-remove-group="'+i+'" '+(existing?'disabled':'')+' style="margin-left:14px;color:#dc2626;">Bỏ nhóm</button></div><div class="option-value-grid">'+values.map((value,n)=>{
       const used=model.variants.some(v=>v.id&&v.options[g.name]===value);
       return '<div class="option-value-cell"><input data-group-value aria-label="Lựa chọn '+(n+1)+' của nhóm '+(i+1)+'" value="'+esc(value)+'" maxlength="80" placeholder="Nhập lựa chọn" '+(used?'readonly':'')+'><button type="button" data-remove-choice="'+i+':'+n+'" '+(used?'disabled':'')+' aria-label="Bỏ lựa chọn '+(n+1)+'">×</button></div>';
     }).join('')+'<button type="button" class="add-choice" data-add-choice="'+i+'" '+(values.length>=20?'disabled':'')+'>＋ Thêm lựa chọn</button></div></section>';
   }).join('');

   const addGroupBtn=document.querySelector('#add-group');
   if(addGroupBtn)addGroupBtn.disabled=model.groups.length>=3||!can('catalog.write');
 }

 function rows(){
   const countEl=document.querySelector('#variant-count');
   if(countEl)countEl.textContent=model.variants.length+' biến thể · '+model.variants.filter(v=>v.active).length+(model.inTrash?' được chọn để kích hoạt lại':' đang bán');
   const rHost=document.querySelector('#variant-rows');
   if(!rHost)return;
   rHost.innerHTML=model.variants.map((v,i)=>`<tr data-variant-index="${i}"><td>${Object.entries(v.options).map(([key,value])=>`<span class="option-tag"><small>${esc(key)}</small>${esc(value)}</span>`).join('')||'<span class="option-tag">Tiêu chuẩn</span>'}</td><td><input data-field="sku" aria-label="SKU biến thể ${i+1}" value="${esc(v.sku)}" maxlength="80" required placeholder="SKU"><input data-field="name" aria-label="Tên biến thể ${i+1}" value="${esc(v.name)}" maxlength="160" required placeholder="Tên biến thể"></td><td><input type="number" data-field="priceVnd" aria-label="Giá biến thể ${i+1}" value="${v.priceVnd??''}" min="0" max="20000000" step="1" required placeholder="Giá (₫)"></td><td><input type="number" data-field="stockQuantity" aria-label="Tồn kho biến thể ${i+1}" value="${v.stockQuantity??0}" min="0" max="1000000" step="1" required ${can('inventory.approve')?'':'disabled'}></td><td><select data-field="imageUrl" aria-label="Ảnh biến thể ${i+1}"><option value="">Dùng ảnh chính</option>${[...new Set([...model.gallery,...(v.imageUrl?[v.imageUrl]:[])])].map((url,n)=>`<option value="${esc(url)}" ${url===v.imageUrl?'selected':''}>${model.gallery.includes(url)?'Ảnh '+(n+1):'Ảnh riêng'}</option>`).join('')}</select><button type="button" data-variant-upload="${i}">Tải ảnh riêng</button><input type="file" data-variant-file="${i}" accept="image/png,image/jpeg,image/webp" hidden>${v.imageUrl?`<img class="variant-thumb" src="${esc(imageUrl(v.imageUrl))}" alt="${esc(v.name)}">`:''}</td><td><input type="checkbox" data-field="active" aria-label="Bán biến thể ${i+1}" ${v.active?'checked':''}></td><td>${v.id?'<small>Đã lưu</small>':`<button type="button" class="plain-button" data-remove-variant="${i}">Bỏ</button>`}</td></tr>`).join('')||'<tr><td colspan="7">Sản phẩm chưa có biến thể. Thêm lựa chọn hoặc nhập giá ở phía trên.</td></tr>';
   preview();
 }

 function render(){
   for(const key of ['name','slug','category','descriptor','cardTitle','cardSummary','description','imageAlt','sortOrder']){
     if(form.elements[key])form.elements[key].value=model.product[key]??'';
   }
   const titleEl=document.querySelector('#editor-title');
   if(titleEl)titleEl.textContent=model.inTrash?'Chỉnh sửa sản phẩm đã xóa':model.id?'Chỉnh sửa sản phẩm':'Thêm sản phẩm';
   document.title=(titleEl?.textContent||'Sản phẩm')+' — GAERU';
   const pubBtn=document.querySelector('[data-save=publish]');if(pubBtn){pubBtn.hidden=Boolean(model.inTrash);pubBtn.textContent=model.product.active?'Lưu & tiếp tục hiển thị':'Xuất bản sản phẩm';}
   const dftBtn=document.querySelector('[data-save=draft]');if(dftBtn)dftBtn.textContent=model.inTrash?'Lưu trong khu vực đã xóa':'Lưu bản nháp';
   const prefixEl=document.querySelector('#sku-prefix');if(prefixEl)prefixEl.value=model.product.slug.toUpperCase();
   const bsEl=document.querySelector('#bulk-stock');if(bsEl)bsEl.disabled=!can('inventory.approve');

   // Ensure at least 1 default variant exists if model has none
   if(!model.variants.length){
     model.variants=[{
       sku:(slugify(model.product.slug||model.product.name||'GAERU').toUpperCase()+'-01').slice(0,50),
       name:'Phiên bản tiêu chuẩn',
       options:{},
       priceVnd:null,
       stockQuantity:10,
       active:true,
       imageUrl:''
     }];
   }

   const hasGroups=model.groups.length>0||model.variants.length>1;
   setOptionMode(hasGroups?'variants':'simple');
   syncSimpleInputs();

   gallery();
   mediaEditor();
   groupEditor();
   rows();
   if(!can('catalog.write'))form.querySelectorAll('input,textarea,select,button').forEach(e=>e.disabled=true);
   lock(false);
 }

 function upload(files){
   if(busy||!can('catalog.write'))return Promise.resolve();
   const gf=document.querySelector('#gallery-files');if(gf)gf.value='';
   if(model.gallery.length+imageUploads.length+files.length>9){
     feedback('Tối đa 9 ảnh cho mỗi sản phẩm.',true);
     return Promise.resolve();
   }
   if(files.some(file=>file.size>8*1024*1024||!(/\.(png|jpe?g|webp)$/i.test(file.name)))){
     feedback('Chọn ảnh PNG, JPG hoặc WebP, tối đa 8 MB/ảnh.',true);
     return Promise.resolve();
   }
   for(const file of files)imageUploads.push({id:++upload.sequence,file,preview:URL.createObjectURL(file),error:false});
   dirty=true;
   gallery();
   return runUploads();
 }
 upload.sequence=0;

 function runUploads(){
   if(uploadWorker)return uploadWorker;
   uploadWorker=(async()=>{
     let item;
     while((item=imageUploads.find(v=>!v.error))){
       feedback('Đang tải ảnh… Bạn có thể tiếp tục nhập hoặc thêm ảnh.');
       try{
         const data=new FormData();
         data.append('image',item.file);
         const result=await request('/api/gaeru_ceo/catalog-images','POST',data);
         readRows();
         model.gallery.push(result.imageUrl);
         imageUploads.splice(imageUploads.indexOf(item),1);
         URL.revokeObjectURL(item.preview);
         rows();
       }catch(error){
         item.error=true;
         item.message=error.message;
       }
       gallery();
     }
     feedback(imageUploads.length?'Có ảnh chưa tải được. Bấm Thử lại hoặc Bỏ trước khi lưu.':'Đã tải ảnh. Lưu sản phẩm để áp dụng bộ ảnh.',Boolean(imageUploads.length));
   })().finally(()=>{uploadWorker=null;});
   return uploadWorker;
 }

 function readMedia(){
   const host=document.querySelector('#description-media');if(!host||!host.dataset.ready)return;
   const paragraphs=[],media=[];
   for(const row of host.children){
     const text=row.querySelector('[data-description-text]');
     if(text){
       paragraphs.push(...text.value.split(/\n\s*\n/).map(v=>v.trim()).filter(Boolean));
       continue;
     }
     const item=model.descriptionMedia[Number(row.dataset.descriptionIndex)];
     if(!item)continue;
     const altInput=row.querySelector('[data-media-alt]');
     const captionInput=row.querySelector('[data-media-caption]');
     media.push({
       ...item,
       alt:altInput?altInput.value:item.alt,
       caption:captionInput?captionInput.value:item.caption,
       afterParagraph:paragraphs.length
     });
   }
   form.elements.description.value=paragraphs.join('\n\n');
   model.descriptionMedia=media;
   countDescription();
   [...host.querySelectorAll('[data-description-index]')].forEach((row,i)=>row.dataset.descriptionIndex=i);
 }

 function fitText(field){
   if(!field?.style)return;
   field.style.height='auto';
   field.style.height=Math.max(120,field.scrollHeight||120)+'px';
 }

 function handle(){
   return '<button type="button" class="description-drag-handle" data-block-handle aria-label="Di chuyển mục này. Giữ và kéo để đổi vị trí">⋮⋮ <span>Kéo thả vị trí</span></button>';
 }

 function countDescription(){
   const n=form.elements.description?.value.length||0;
   const counter=document.querySelector('[data-description-count]');
   if(counter){
     counter.textContent=n+' / 3000 ký tự · '+(model.descriptionMedia||[]).length+' / 12 ảnh hoặc video';
     counter.classList.toggle('is-over-limit',n>3000);
   }
 }

 function blockTools(text=false){
   return '<div class="description-block-actions">'+(text?'<button type="button" data-block-action="bold">Đậm</button>':'')+'<button type="button" data-block-action="up" aria-label="Đưa nội dung lên">↑</button><button type="button" data-block-action="down" aria-label="Đưa nội dung xuống">↓</button><button type="button" data-block-action="text">+ Chữ sau</button><button type="button" data-block-action="image">+ Ảnh sau</button><button type="button" data-block-action="video">+ Video sau</button><button type="button" data-block-action="remove" class="plain-button" aria-label="Xóa mục">🗑️ Xóa</button></div>';
 }

 function textBlock(value=''){
   return `<article class="description-text-card" data-description-block draggable="true">${handle()}<label>Đoạn mô tả<textarea data-description-text lang="vi" dir="auto" spellcheck="true" rows="4" maxlength="3000" placeholder="Nhập nội dung mô tả…">${esc(value)}</textarea></label>${blockTools(true)}</article>`;
 }

 function attachBlockDrag(host){
   if(!host)return;
   let dragging=null;
   host.querySelectorAll('[data-description-block]').forEach(block=>{
     block.setAttribute('draggable','true');
     block.ondragstart=e=>{
       if(e.target.closest('input,textarea,select,button:not([data-block-handle])')){
         if(!e.target.closest('[data-block-handle]')){
           e.preventDefault();
           return;
         }
       }
       dragging=block;
       block.classList.add('is-dragging');
       e.dataTransfer.effectAllowed='move';
       e.dataTransfer.setData('text/plain','block');
     };
     block.ondragend=()=>{
       block.classList.remove('is-dragging');
       host.querySelectorAll('.drop-target-before, .drop-target-after').forEach(el=>el.classList.remove('drop-target-before','drop-target-after'));
       dragging=null;
     };
     block.ondragover=e=>{
       if(!dragging||dragging===block)return;
       e.preventDefault();
       e.dataTransfer.dropEffect='move';
       const rect=block.getBoundingClientRect();
       const isTop=e.clientY<rect.top+rect.height/2;
       block.classList.toggle('drop-target-before',isTop);
       block.classList.toggle('drop-target-after',!isTop);
     };
     block.ondragleave=()=>{
       block.classList.remove('drop-target-before','drop-target-after');
     };
     block.ondrop=e=>{
       if(!dragging||dragging===block)return;
       e.preventDefault();
       const rect=block.getBoundingClientRect();
       const isTop=e.clientY<rect.top+rect.height/2;
       if(isTop)block.before(dragging);
       else block.after(dragging);
       block.classList.remove('drop-target-before','drop-target-after');
       readMedia();
       dirty=true;
       preview();
     };
   });
 }

 function mediaEditor(){
   model.descriptionMedia||=[];
   const parts=form.elements.description.value.split(/\n\s*\n/).map(v=>v.trim()).filter(Boolean);
   const host=document.querySelector('#description-media');
   if(!host)return;
   const at=n=>model.descriptionMedia.map((m,i)=>({m,i})).filter(({m})=>(m.afterParagraph==null?parts.length:Math.min(parts.length,m.afterParagraph))===n).map(({m,i})=>`<article class="description-media-card" data-description-block data-description-index="${i}" draggable="true">${handle()}${m.type==='image'?`<img src="${esc(imageUrl(m.url))}" alt="${esc(m.alt)}">`:`<video controls preload="metadata" src="${esc(imageUrl(m.url))}" aria-label="${esc(m.alt)}"></video>`}<label>Mô tả ảnh/video<input data-media-alt required minlength="3" maxlength="250" value="${esc(m.alt)}"></label><label>Chú thích hiển thị<input data-media-caption maxlength="300" value="${esc(m.caption||'')}"></label>${blockTools()}</article>`).join('');
   const oldTop=host.scrollTop||0;
   host.innerHTML=at(0)+parts.map((part,i)=>textBlock(part)+at(i+1)).join('')+(!parts.length&&!model.descriptionMedia.length?textBlock():'');
   host.dataset.ready='true';
   host.querySelectorAll('[data-description-text]').forEach(fitText);
   host.scrollTop=oldTop;
   attachBlockDrag(host);
   countDescription();
 }

 let insertionAfter=null;
 function descriptionPosition(){
   if(!insertionAfter)return null;
   let count=0;
   const host=document.querySelector('#description-media');
   if(!host)return null;
   for(const row of host.children){
     const t=row.querySelector('[data-description-text]');
     if(t)count+=t.value.split(/\n\s*\n/).filter(v=>v.trim()).length;
     if(row===insertionAfter)break;
   }
   return count;
 }

 function uploadDescription(files,type){
   if(busy||imageUploads.length||!can('catalog.write'))return;
   model.descriptionMedia||=[];
   if(model.descriptionMedia.length+files.length>12)return feedback('Tối đa 12 ảnh/video mô tả.',true);
   readRows();readMedia();
   const position=descriptionPosition();
   const host=document.querySelector('#description-media');
   let insertAt=insertionAfter?[...host.children].slice(0,[...host.children].indexOf(insertionAfter)+1).filter(row=>row.hasAttribute('data-description-index')).length:model.descriptionMedia.length;
   lock(true);
   feedback('Đang tải tệp vào chi tiết sản phẩm…');
   return (async()=>{
     try{
       for(const file of files){
         if(file.size>(type==='image'?8:25)*1024*1024)throw Error(type==='image'?'Ảnh tối đa 8 MB.':'Video tối đa 25 MB.');
         const data=new FormData();
         data.append(type,file);
         const result=await request('/api/gaeru_ceo/'+(type==='image'?'catalog-images':'catalog-videos'),'POST',data);
         model.descriptionMedia.splice(insertAt++,0,{
           type,
           url:result.imageUrl||result.url,
           alt:('Mô tả '+file.name.replace(/\.[^.]+$/,'')).slice(0,250),
           caption:'',
           afterParagraph:position
         });
         dirty=true;
       }
       mediaEditor();
       feedback('Đã tải nội dung minh họa. Kéo thả để đổi vị trí nếu cần.');
     }catch(error){
       mediaEditor();
       feedback(error.message,true);
     }finally{
       lock(false);
     }
   })();
 }

 // Drag and drop files from desktop into description shell
 const descShell=document.querySelector('.description-editor-shell');
 if(descShell){
   ['dragenter','dragover'].forEach(evt=>{
     descShell.addEventListener(evt,e=>{
       if(e.dataTransfer.types.includes('Files')){
         e.preventDefault();
         e.stopPropagation();
         descShell.classList.add('file-drag-active');
       }
     });
   });
   ['dragleave','drop'].forEach(evt=>{
     descShell.addEventListener(evt,e=>{
       if(!descShell.contains(e.relatedTarget)||evt==='drop'){
         descShell.classList.remove('file-drag-active');
       }
     });
   });
   descShell.addEventListener('drop',async e=>{
     if(e.dataTransfer.files&&e.dataTransfer.files.length){
       e.preventDefault();
       e.stopPropagation();
       descShell.classList.remove('file-drag-active');
       const files=[...e.dataTransfer.files];
       const imgs=files.filter(f=>/\.(png|jpe?g|webp)$/i.test(f.name));
       const vids=files.filter(f=>/\.(mp4)$/i.test(f.name));
       if(imgs.length)await uploadDescription(imgs,'image');
       if(vids.length)await uploadDescription(vids,'video');
     }
   });
 }

 // Drag and drop files into main gallery
 const gBox=document.querySelector('#gallery');
 if(gBox){
   ['dragenter','dragover'].forEach(evt=>{
     gBox.addEventListener(evt,e=>{
       if(e.dataTransfer.types.includes('Files')){
         e.preventDefault();
         gBox.style.borderColor='#0284c7';
       }
     });
   });
   ['dragleave','drop'].forEach(evt=>{
     gBox.addEventListener(evt,e=>{
       gBox.style.borderColor='';
     });
   });
   gBox.addEventListener('drop',async e=>{
     if(e.dataTransfer.files&&e.dataTransfer.files.length){
       e.preventDefault();
       const imgs=[...e.dataTransfer.files].filter(f=>/\.(png|jpe?g|webp)$/i.test(f.name));
       if(imgs.length)await upload(imgs);
     }
   });
 }

 // Setup Simple mode vs Variants mode switcher
 const btnSimple=document.querySelector('#btn-mode-simple');
 const btnVariants=document.querySelector('#btn-mode-variants');
 if(btnSimple&&btnVariants){
   btnSimple.onclick=()=>{
     if(model.groups.length>0&&model.variants.some(v=>v.id)){
       if(!confirm('Sản phẩm đã có biến thể được lưu. Chuyển sang sản phẩm tiêu chuẩn sẽ đưa về 1 biến thể. Bạn có chắc không?'))return;
     }
     model.groups=[];
     const firstV=model.variants[0]||{};
     model.variants=[{
       ...firstV,
       sku:firstV.sku||(slugify(form.elements.slug?.value||form.elements.name?.value||'GAERU').toUpperCase()+'-01').slice(0,50),
       name:'Phiên bản tiêu chuẩn',
       options:{},
       priceVnd:firstV.priceVnd??null,
       stockQuantity:firstV.stockQuantity??10,
       active:true,
       imageUrl:firstV.imageUrl||''
     }];
     setOptionMode('simple');
     syncSimpleInputs();
     groupEditor();
     rows();
     dirty=true;
     preview();
   };

   btnVariants.onclick=()=>{
     setOptionMode('variants');
     if(!model.groups.length){
       model.groups=[{name:'Màu sắc',values:['Đen','Trắng']}];
       groupEditor();
       document.querySelector('#generate-variants')?.click();
     }
     dirty=true;
     preview();
   };
 }

 const sPriceInp=document.querySelector('#simple-price');
 const sStockInp=document.querySelector('#simple-stock');
 const sSkuInp=document.querySelector('#simple-sku');
 if(sPriceInp)sPriceInp.oninput=()=>{
   if(!model.variants.length)model.variants.push({sku:'',name:'Phiên bản tiêu chuẩn',options:{},priceVnd:null,stockQuantity:0,active:true,imageUrl:''});
   model.variants[0].priceVnd=sPriceInp.value===''?null:Number(sPriceInp.value);
   dirty=true;preview();
 };
 if(sStockInp)sStockInp.oninput=()=>{
   if(!model.variants.length)model.variants.push({sku:'',name:'Phiên bản tiêu chuẩn',options:{},priceVnd:null,stockQuantity:0,active:true,imageUrl:''});
   model.variants[0].stockQuantity=sStockInp.value===''?0:Number(sStockInp.value);
   dirty=true;preview();
 };
 if(sSkuInp)sSkuInp.oninput=()=>{
   if(!model.variants.length)model.variants.push({sku:'',name:'Phiên bản tiêu chuẩn',options:{},priceVnd:null,stockQuantity:0,active:true,imageUrl:''});
   model.variants[0].sku=sSkuInp.value.trim();
   dirty=true;preview();
 };

 form.addEventListener('click',e=>{
   const b=e.target.closest('[data-block-action]');
   if(!b?.dataset.blockAction||busy||!can('catalog.write'))return;
   const row=b.closest('[data-description-block]'),host=row.parentElement,action=b.dataset.blockAction;
   if(action==='bold'){
     const field=row.querySelector('[data-description-text]');
     if(!field)return;
     const a=field.selectionStart,b=field.selectionEnd;
     field.setRangeText('**'+(field.value.slice(a,b)||'chữ nhấn mạnh')+'**',a,b,'select');
     field.focus();fitText(field);readMedia();dirty=true;return;
   }
   if(action==='image'){readMedia();insertionAfter=row;document.querySelector('#description-images')?.click();return;}
   if(action==='video'){readMedia();insertionAfter=row;document.querySelector('#description-video')?.click();return;}
   if(action==='text'){
     row.insertAdjacentHTML('afterend',textBlock());
     attachBlockDrag(host);
     row.nextElementSibling.querySelector('textarea')?.focus();
   }
   if(action==='up'&&row.previousElementSibling)host.insertBefore(row,row.previousElementSibling);
   if(action==='down'&&row.nextElementSibling)host.insertBefore(row.nextElementSibling,row);
   if(action==='remove')row.remove();
   readMedia();dirty=true;preview();
 });

 const addDescText=document.querySelector('#add-description-text');
 if(addDescText)addDescText.onclick=()=>{
   if(busy||!can('catalog.write'))return;
   const host=document.querySelector('#description-media');
   if(!host)return;
   host.insertAdjacentHTML('beforeend',textBlock());
   attachBlockDrag(host);
   const field=host.lastElementChild?.querySelector('textarea');
   if(field){
     field.focus({preventScroll:true});
     field.scrollIntoView({block:'nearest',behavior:'smooth'});
   }
   dirty=true;
 };

 const addDescImgs=document.querySelector('#add-description-images');
 if(addDescImgs)addDescImgs.onclick=()=>{insertionAfter=null;document.querySelector('#description-images')?.click();};
 const addDescVid=document.querySelector('#add-description-video');
 if(addDescVid)addDescVid.onclick=()=>{insertionAfter=null;document.querySelector('#description-video')?.click();};

 for(const [id,type]of [['description-images','image'],['description-video','video']]){
    const el=document.getElementById(id);
    if(el)el.addEventListener('change',async e=>{await uploadDescription([...e.target.files],type);e.target.value='';});
  }

 window.GAERUDescriptionEditor?.mount(document.querySelector('#description-media'),{
   canEdit:()=>!busy&&can('catalog.write'),
   changed:()=>{readMedia();dirty=true;},
   announce:text=>{
     const a=document.querySelector('[data-description-announcement]');
     if(a)a.textContent=text;
   }
 });

 form.addEventListener('click',e=>{
   const b=e.target.closest('[data-variant-upload]');
   if(b?.dataset.variantUpload!==undefined&&!busy&&can('catalog.write')){
     b.parentElement.querySelector('[data-variant-file]')?.click();
   }
 });

 form.addEventListener('change',async e=>{
   if(e.target.matches('[data-variant-file]')&&e.target.files.length){
     const file=e.target.files[0];e.target.value='';
     if(file.size>8*1024*1024||!(/\.(png|jpe?g|webp)$/i.test(file.name))){
       feedback('Chọn ảnh PNG, JPG hoặc WebP tối đa 8 MB.',true);return;
     }
     readRows();
     const row=e.target.closest('[data-variant-index]'),i=Number(row.dataset.variantIndex);
     feedback('Đang tải ảnh riêng cho biến thể…');
     lock(true);
     try{
       const data=new FormData();data.append('image',file);
       const result=await request('/api/gaeru_ceo/catalog-images','POST',data);
       model.variants[i].imageUrl=result.imageUrl;
       rows();
       feedback('Đã thêm ảnh riêng cho biến thể.');
     }catch(err){
       feedback(err.message,true);
     }finally{
       lock(false);
     }
   }
 });

 const gfInput=document.querySelector('#gallery-files');
  if(gfInput)gfInput.addEventListener('change',e=>upload([...e.target.files]));

 form.addEventListener('click',e=>{
    const b=e.target.closest('button');
    if(!b||busy||!can('catalog.write'))return;
    if(b.dataset.retryUpload!==undefined){
      const item=imageUploads.find(v=>v.id===Number(b.dataset.retryUpload));
      if(item){item.error=false;gallery();runUploads();}
      return;
    }
    if(b.dataset.discardUpload!==undefined){
      const i=imageUploads.findIndex(v=>v.id===Number(b.dataset.discardUpload));
      if(i>=0){URL.revokeObjectURL(imageUploads[i].preview);imageUploads.splice(i,1);gallery();}
      return;
    }
    if(b.hasAttribute('data-upload-slot')){
      document.querySelector('#gallery-files')?.click();
      return;
    }
    if(b.dataset.addChoice!==undefined||b.dataset.removeChoice!==undefined){
      try{
        const rows=[...document.querySelectorAll('[data-group-index]')];
        model.groups=rows.map(row=>({name:row.querySelector('[data-group-name]').value.trim(),values:[...row.querySelectorAll('[data-group-value]')].map(input=>input.value)}));
        if(b.dataset.addChoice!==undefined){
          const group=model.groups[Number(b.dataset.addChoice)];
          if(group.values.length>=20)return;
          group.values.push('');
        }else{
          const [i,n]=b.dataset.removeChoice.split(':').map(Number);
          const g=model.groups[i];
          if(model.variants.some(v=>v.id&&v.options[g.name]===g.values[n]))throw Error('Không bỏ lựa chọn đã có trong biến thể lưu.');
          g.values.splice(n,1);
        }
        groupEditor();dirty=true;
      }catch(error){feedback(error.message,true);}
      return;
    }
    try{
      readRows();
      if(b.dataset.mainImage!==undefined){const [url]=model.gallery.splice(Number(b.dataset.mainImage),1);model.gallery.unshift(url);gallery();rows();}
      if(b.dataset.removeImage!==undefined){model.gallery.splice(Number(b.dataset.removeImage),1);gallery();rows();}
      if(b.dataset.removeGroup!==undefined){model.groups=groupsFromForm();model.groups.splice(Number(b.dataset.removeGroup),1);groupEditor();}
      if(b.dataset.removeVariant!==undefined){model.variants.splice(Number(b.dataset.removeVariant),1);rows();}
      dirty=true;
    }catch(err){feedback(err.message,true);}
  });

  form.addEventListener('keydown',e=>{
    if(e.target.matches('[data-group-value]')&&e.key==='Enter'){
      e.preventDefault();
      const groupSec=e.target.closest('[data-group-index]');
      if(groupSec){
        const addBtn=groupSec.querySelector('[data-add-choice]');
        if(addBtn&&!addBtn.disabled){
          addBtn.click();
          const inputs=groupSec.querySelectorAll('[data-group-value]');
          const lastInput=inputs[inputs.length-1];
          if(lastInput)lastInput.focus();
        }
      }
    }
  });

  const applyBulkBtn=document.querySelector('#apply-variant-bulk');
 if(applyBulkBtn)applyBulkBtn.onclick=()=>{
   readRows();
   const priceVal=document.querySelector('#bulk-price')?.value;
   const stockVal=document.querySelector('#bulk-stock')?.value;
   if(priceVal===''&&stockVal==='')return feedback('Nhập giá hoặc tồn kho cần áp dụng chung.',true);
   for(const v of model.variants){
     if(priceVal!=='')v.priceVnd=Number(priceVal);
     if(stockVal!==''&&can('inventory.approve'))v.stockQuantity=Number(stockVal);
   }
   rows();dirty=true;feedback('Đã áp dụng thông số chung cho tất cả biến thể.');
 };

 form.addEventListener('input',()=>{preview();});
 if(form.elements.name){
   form.elements.name.addEventListener('input',()=>{
     if(!model.id&&!form.elements.slug.dataset.manual){
       form.elements.slug.value=slugify(form.elements.name.value);
     }
     const sSku=document.querySelector('#simple-sku');
     if(sSku&&(!model.variants[0]?.sku||!sSku.dataset.manual)){
       sSku.value=(slugify(form.elements.name.value||'GAERU').toUpperCase()+'-01').slice(0,50);
       if(model.variants[0])model.variants[0].sku=sSku.value;
     }
   });
 }
 if(form.elements.slug){
   form.elements.slug.addEventListener('input',()=>{
     form.elements.slug.dataset.manual='true';
     const sSku=document.querySelector('#simple-sku');
     if(sSku&&!sSku.dataset.manual){
       sSku.value=(slugify(form.elements.slug.value||'GAERU').toUpperCase()+'-01').slice(0,50);
       if(model.variants[0])model.variants[0].sku=sSku.value;
     }
   });
 }
 if(sSkuInp){
   sSkuInp.addEventListener('input',()=>{sSkuInp.dataset.manual='true';});
 }

 form.addEventListener('change',e=>{
   if(e.target.matches('[data-media-position]')){readMedia();dirty=true;}
   if(e.target.matches('[data-group-value],[data-group-name]')){
     try{model.groups=groupsFromForm();preview();}catch(err){feedback(err.message,true);}
   }
   if(e.target===form.elements.description){readMedia();mediaEditor();}
   if(e.target.matches('[data-field]')){readRows();dirty=true;preview();}
 });

 form.addEventListener('click',e=>{
   const b=e.target.closest('button');
   if(!b||busy||!can('catalog.write'))return;
   if(b.dataset.preset){
     const presetMap={
       color:{name:'Màu sắc',values:['Đen','Trắng']},
       connector:{name:'Cổng kết nối',values:['Type-C','Lightning']},
       mic:{name:'Bộ micro',values:['1 Micro','2 Micro']}
     };
     const p=presetMap[b.dataset.preset];
     if(p){
       if(model.groups.length>=3){
         feedback('Tối đa 3 nhóm phân loại cho mỗi sản phẩm.',true);return;
       }
       if(model.groups.some(g=>g.name.toLowerCase()===p.name.toLowerCase())){
         feedback('Nhóm "'+p.name+'" đã có trong danh sách.',true);return;
       }
       model.groups.push(JSON.parse(JSON.stringify(p)));
       setOptionMode('variants');
       groupEditor();dirty=true;preview();
       feedback('Đã thêm nhóm '+p.name+'. Bấm "⚡ Tạo các tổ hợp biến thể" để cập nhật bảng giá.');
     }
   }
 });

 const addGroupBtn=document.querySelector('#add-group');
 if(addGroupBtn)addGroupBtn.onclick=()=>{
   try{
     model.groups=groupsFromForm();
     if(model.groups.length>=3)throw Error('Tối đa 3 nhóm phân loại.');
     model.groups.push({name:'',values:[]});
     setOptionMode('variants');
     groupEditor();dirty=true;
   }catch(e){feedback(e.message,true);}
 };

 const genVariantsBtn=document.querySelector('#generate-variants');
 if(genVariantsBtn)genVariantsBtn.onclick=()=>{
   try{
     readRows();
     model.groups=groupsFromForm();
     if(!model.groups.length)throw Error('Thêm ít nhất một nhóm phân loại trước.');
     for(const g of model.groups){
       if(!g.values.length)throw Error('Nhóm "'+g.name+'" cần ít nhất một lựa chọn.');
     }
     const combos=choices.combinations(model.groups);
     const priceVal=document.querySelector('#default-price')?.value;
     const existing=model.variants.map(v=>({...v,options:Object.fromEntries(model.groups.map(g=>[g.name,v.options[g.name]||g.values[0]]))}));
     const used=new Set(existing.map(v=>v.sku));
     let number=1;
     const prefix=slugify(document.querySelector('#sku-prefix')?.value||form.elements.slug?.value||'GAERU').toUpperCase().slice(0,50);
     const generated=combos.map(options=>{
       const found=existing.find(v=>choices.signature(v.options)===choices.signature(options));
       if(found)return found;
       let sku;
       do{sku=prefix+'-'+String(number++).padStart(2,'0');}while(used.has(sku));
       used.add(sku);
       return {
         sku,
         name:Object.values(options).join(' · ').slice(0,160),
         options,
         priceVnd:priceVal===''||priceVal===undefined?null:Number(priceVal),
         stockQuantity:0,
         active:true,
         imageUrl:''
       };
     });
     for(const v of existing.filter(v=>v.id)){
       if(!generated.some(n=>n.id===v.id))generated.push(v);
     }
     model.variants=generated;
     rows();groupEditor();dirty=true;
     feedback('Đã tạo '+generated.length+' biến thể. Kiểm tra giá, SKU và tồn kho bên dưới.');
     document.querySelector('#variants')?.scrollIntoView({behavior:'smooth',block:'nearest'});
   }catch(e){
     feedback(e.message,true);
     showFieldError(document.querySelector('#options'),e.message);
   }
 };

 const addSingleBtn=document.querySelector('#add-single');
 if(addSingleBtn)addSingleBtn.onclick=()=>{
   readRows();
   const nextIdx=model.variants.length+1;
   model.variants.push({
     sku:(slugify(form.elements.slug?.value||form.elements.name?.value||'GAERU').toUpperCase()+'-'+String(nextIdx).padStart(2,'0')).slice(0,50),
     name:'Phiên bản '+nextIdx,
     options:{},
     priceVnd:null,
     stockQuantity:0,
     active:true,
     imageUrl:''
   });
   rows();dirty=true;
 };

 document.querySelectorAll('[data-save]').forEach(button=>button.onclick=async()=>{
   if(busy||!can('catalog.write'))return;
   try{
     if(imageUploads.length)throw Error('Chờ ảnh tải xong; thử lại hoặc bỏ ảnh bị lỗi trước khi lưu.');
     readMedia();
     readRows();

     // Validate all fields and show red borders if invalid
     const isPublish=button.dataset.save==='publish';
     clearValidationErrors();

     const nameVal=form.elements.name?.value.trim()||'';
     if(nameVal.length<2){
       showFieldError(form.elements.name,'Tên sản phẩm phải từ 2 đến 160 ký tự.');
       throw Error('Tên sản phẩm phải từ 2 đến 160 ký tự.');
     }

     const slugVal=form.elements.slug?.value.trim()||'';
     if(!slugVal||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slugVal)){
       showFieldError(form.elements.slug,'Đường dẫn chỉ dùng chữ thường không dấu, số và dấu gạch nối (ví dụ: micro-k9).');
       throw Error('Đường dẫn sản phẩm chưa đúng định dạng.');
     }

     if(!model.gallery.length){
       showFieldError(document.querySelector('#gallery'),'Vui lòng tải lên ít nhất một ảnh sản phẩm.');
       throw Error('Hãy thêm ít nhất một ảnh sản phẩm.');
     }

     if(form.elements.description?.value.length>3000){
       showFieldError(document.querySelector('#description-media'),'Mô tả chi tiết tối đa 3000 ký tự.');
       throw Error('Mô tả tối đa 3000 ký tự.');
     }

     if(model.groups.length){
       model.groups=groupsFromForm();
     }

     const isSimpleMode=!model.groups.length;
     if(isSimpleMode){
       if(!model.variants.length){
         model.variants=[{sku:'',name:'Phiên bản tiêu chuẩn',options:{},priceVnd:null,stockQuantity:10,active:true,imageUrl:''}];
       }
       const sP=document.querySelector('#simple-price');
       const sS=document.querySelector('#simple-stock');
       const sK=document.querySelector('#simple-sku');
       if(sP&&sP.value!=='')model.variants[0].priceVnd=Number(sP.value);
       if(sS&&sS.value!=='')model.variants[0].stockQuantity=Number(sS.value);
       if(sK&&sK.value.trim()!=='')model.variants[0].sku=sK.value.trim();
       if(!model.variants[0].sku){
         model.variants[0].sku=(slugify(slugVal||nameVal).toUpperCase()+'-01').slice(0,50);
         if(sK)sK.value=model.variants[0].sku;
       }
       if(model.variants[0].priceVnd===null||isNaN(model.variants[0].priceVnd)||model.variants[0].priceVnd<0){
         if(sP)showFieldError(sP,'Vui lòng nhập giá bán cho sản phẩm (từ 0₫ đến 20.000.000₫).');
         throw Error('Vui lòng nhập giá bán cho sản phẩm.');
       }
       if(!/^[a-zA-Z0-9._-]+$/.test(model.variants[0].sku)){
         if(sK)showFieldError(sK,'Mã SKU chỉ gồm chữ, số và dấu gạch nối/chấm.');
         throw Error('Mã SKU không hợp lệ.');
       }
     }else{
       if(!model.variants.length){
         showFieldError(document.querySelector('#generate-variants')||document.querySelector('#options'),'Vui lòng bấm "⚡ Tạo các tổ hợp biến thể" để hoàn tất thiết lập.');
         throw Error('Chưa có biến thể nào được tạo.');
       }
       for(let i=0;i<model.variants.length;i++){
         const v=model.variants[i];
         const row=document.querySelector('[data-variant-index="'+i+'"]');
         if(v.priceVnd===null||isNaN(v.priceVnd)||v.priceVnd<0){
           if(row)showFieldError(row.querySelector('[data-field="priceVnd"]'),'Nhập giá bán (từ 0₫ đến 20.000.000₫).');
           throw Error('Nhập giá cho tất cả biến thể trước khi lưu.');
         }
         if(!v.sku||!/^[a-zA-Z0-9._-]+$/.test(v.sku)){
           if(row)showFieldError(row.querySelector('[data-field="sku"]'),'Nhập SKU hợp lệ (chữ, số, gạch nối).');
           throw Error('SKU của biến thể chưa đúng định dạng.');
         }
       }
     }

     const p=product();
     p.active=!model.inTrash&&isPublish;

     if(p.active&&!model.variants.some(v=>v.active)){
       showFieldError(document.querySelector('#variants'),'Cần ít nhất một biến thể đang bán trước khi xuất bản.');
       throw Error('Cần ít nhất một biến thể đang bán trước khi xuất bản.');
     }

     lock(true);
     feedback('Đang lưu sản phẩm và biến thể…');
     const payload={
       ...(model.inTrash?{inTrash:true}:{}),
       ...(model.id?{id:model.id,updatedAt:model.updatedAt,version:model.version}:{}),
       product:p,
       gallery:model.gallery,
       descriptionMedia:model.descriptionMedia||[],
       groups:model.groups,
       variants:model.variants
     };

     model=await request('/api/gaeru_ceo/product-workspace','POST',payload);
     dirty=false;
     clearValidationErrors();
     history.replaceState(null,'','/gaeru_ceo/products/'+model.id+'/edit'+(model.inTrash?'?trash=1':''));
     render();
     feedback(model.inTrash?'Đã lưu thay đổi trong khu vực đã xóa.':p.active?'Đã lưu và xuất bản sản phẩm thành công lên cửa hàng!':'Đã lưu bản nháp thành công. Sản phẩm chưa hiển thị trên cửa hàng.');
   }catch(e){
     if(e.data?.issues){
       applyIssues(e.data.issues);
     }else if(e.data?.field){
       if(e.data.field==='product.slug')showFieldError(form.elements.slug,e.message);
       else if(e.data.field==='sku')showFieldError(document.querySelector('#simple-sku')||document.querySelector('[data-field="sku"]'),e.message);
     }else{
       const firstInvalid=document.querySelector('.is-invalid');
       if(firstInvalid){
         try{firstInvalid.scrollIntoView({behavior:'smooth',block:'center'});}catch(_){}
         try{firstInvalid.focus();}catch(_){}
       }
     }
     feedback(e.message,true);
   }finally{
     lock(false);
   }
 });

 window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});

 (async()=>{
   try{
     user=await request('/api/auth/me');
     if(!user.authenticated){
       status.innerHTML='Vui lòng <a href="/gaeru_ceo">đăng nhập quản trị</a> trước khi tạo hoặc sửa sản phẩm.';
       return;
     }
     if(!can('catalog.read'))throw Error('Bạn không có quyền xem sản phẩm.');
     const match=location.pathname.match(/\/products\/([^/]+)\/edit$/);
     if(match){
       model=await request('/api/gaeru_ceo/product-workspace/'+encodeURIComponent(match[1])+(editingTrash?'?trash=1':''));
     }
     if(model.inTrash){
       const back=document.querySelector('a[href="/gaeru_ceo#products"]');
       if(back)back.href='/gaeru_ceo?productScope=trash#products';
     }
     if(model.product.slug==='gaeru-m3'&&!model.descriptionMedia?.length&&window.renderM3?.isLegacyDescription(model.product.description)){
       const defaults=window.renderM3.content();
       model.product.description=defaults.description;
       model.descriptionMedia=defaults.descriptionMedia;
     }
     if(!model.groups.length&&model.variants.some(v=>Object.keys(v.options).length)){
       model.groups=choices.groups(model.variants);
     }
     const ws=document.querySelector('#workspace');
     if(ws)ws.hidden=false;
     render();
     feedback(model.inTrash?'Sản phẩm vẫn ở khu vực đã xóa. Lưu thay đổi tại đây; khôi phục hoặc kích hoạt lại trong danh sách sản phẩm đã xóa.':can('catalog.write')?'Nhập thông tin sản phẩm; lưu nháp hoặc xuất bản khi đã kiểm tra xong.':'Bạn đang xem sản phẩm với quyền chỉ đọc.');
   }catch(e){
     feedback(e.message,true);
   }
 })();
})();
