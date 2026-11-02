(()=>{
 const panel=document.getElementById('after-sales-panel'),list=document.getElementById('after-sales-list');
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const labels={requested:'Mới yêu cầu',approved:'Đã duyệt',received:'Đã nhận hàng trả',resolved:'Đã đóng',rejected:'Từ chối'};
 const transitions={requested:['approved','rejected'],approved:['received','resolved','rejected'],received:['resolved'],resolved:[],rejected:[]};
 const toolbar=document.createElement('div');toolbar.className='after-sales-toolbar';toolbar.innerHTML='<label>Thư mục yêu cầu<select data-case-status><option value="">Tất cả</option>'+Object.entries(labels).map(([id,title])=>'<option value="'+id+'">'+title+'</option>').join('')+'</select></label><details data-after-sales-create hidden><summary>Tạo yêu cầu hủy / trả hàng</summary><form data-case-create><label>Tìm mã đơn, tên hoặc điện thoại<input type="search" name="search" maxlength="120"></label><button type="button" class="secondary-button" data-find-case-order>Tìm đơn</button><label>Đơn hàng<select name="orderId" required><option value="">Tìm và chọn đơn</option></select></label><p data-case-kind></p><label>Lý do<textarea name="reason" required minlength="5" maxlength="2000"></textarea></label><button type="submit" class="primary-button">Tạo yêu cầu</button><p role="status" data-case-create-status></p></form></details>';panel.insertBefore(toolbar,list);
 const filter=toolbar.querySelector('[data-case-status]'),create=toolbar.querySelector('[data-case-create]');let searchResults=[],revision=0,loading=0;
 async function load(){
  const version=++loading;
  toolbar.querySelector('[data-after-sales-create]').hidden=!window.GAERUAdmin.can('orders.write');
  try{
   const data=await window.GAERUAdmin.request('/api/gaeru_ceo/orders/after-sales?status='+encodeURIComponent(filter.value));
   if(version!==loading)return;
   list.innerHTML=data.cases.map(c=>`<article class="order-card">
    <h3>${esc(c.order_number)} · ${c.kind==='return'?(c.return_type==='exchange'?'Đổi mới 1:1':(c.return_type==='refund'?'Trả hàng hoàn tiền':'Trả hàng')):'Hủy đơn'}</h3>
    <p>${esc(c.customer_name)} · ${esc(c.phone)} · <small>Nguồn: <strong>${esc(c.requested_by==='customer'?'Khách hàng':(c.requested_by==='guest'?'Khách vãng lai':'Admin'))}</strong></small></p>
    ${c.rma_number?`<p><strong>Mã RMA:</strong> <mark style="padding:2px 6px;border-radius:4px;font-family:monospace;font-weight:bold;">${esc(c.rma_number)}</mark></p>`:''}
    <p><strong>Lý do:</strong> ${esc(c.reason)}</p>
    ${c.bank_info?.details||c.bank_info?.accountNumber?`<p><strong>Hoàn tiền:</strong> ${esc(c.bank_info.details||`${c.bank_info.bankName||""} - ${c.bank_info.accountNumber||""} (${c.bank_info.accountHolder||""})`)}</p>`:''}
    ${c.kind==='return'?`<div class="rma-logistics-info" style="font-size:0.9em;margin:6px 0;padding:6px 10px;background:#f8f9fa;border-radius:6px;border:1px solid #e9ecef;">
      <p style="margin:2px 0;"><strong>Chiều về kho (Inbound):</strong> ${esc(c.inbound_carrier||'Chưa có')} · Mã: ${c.inbound_tracking_number?`<code>${esc(c.inbound_tracking_number)}</code>`:'Chưa gửi'} (${c.inbound_status==='delivered_to_warehouse'?'Đã đến kho':(c.inbound_status==='in_transit'?'Đang vận chuyển':'Chờ gửi')})</p>
      ${c.return_type==='exchange'?`<p style="margin:2px 0;"><strong>Chiều đổi trả gửi khách (Outbound):</strong> ${esc(c.outbound_carrier||'Chưa tạo')} · Mã: ${c.outbound_tracking_number?`<code>${esc(c.outbound_tracking_number)}</code>`:'Chưa có'} (${c.outbound_status==='delivered'?'Khách đã nhận':(c.outbound_status==='in_transit'?'Đang giao':(c.outbound_status==='preparing'?'Đang đóng gói':'Chưa giao'))})</p>`:''}
      ${c.inspection_notes?`<p style="margin:2px 0;"><strong>Kiểm định:</strong> ${esc(c.inspection_notes)} ${c.restock_eligible?'(Đủ chuẩn tái nhập kho)':''}</p>`:''}
    </div>`:''}
    <p><strong>${c.kind==='return'&&c.status==='resolved'?'Đã hoàn trả':labels[c.status]}</strong> · ${esc(c.resolution)}</p>
    ${window.GAERUAdmin.can('orders.write')&&transitions[c.status].length?`<form data-case="${esc(c.id)}" data-version="${c.version}"><label>Bước xử lý<select name="status">${transitions[c.status].filter(x=>!(c.kind==='cancellation'&&x==='received')&&!(c.kind==='return'&&c.status==='approved'&&x==='resolved')).map(x=>`<option value="${x}">${labels[x]}</option>`).join('')}</select></label><label>Ghi chú / chứng từ đối soát<textarea name="resolution" required minlength="5" maxlength="2000"></textarea></label><button type="submit" class="secondary-button">Xác nhận chuyển bước</button></form>`:''}
    ${window.GAERUAdmin.can('orders.write')&&c.kind==='return'?`<details style="margin-top:8px;font-size:0.9em;"><summary style="cursor:pointer;font-weight:600;color:#2b6cb0;">Điều phối Vận chuyển RMA & Thẩm định</summary><form data-rma-logistics="${esc(c.id)}" style="margin-top:6px;padding:8px;border:1px dashed #cbd5e0;border-radius:6px;display:grid;gap:6px;"><div style="display:flex;gap:8px;align-items:center;"><label style="flex:1;">Trạng thái hàng về kho:<select name="inboundStatus"><option value="pending_shipment" ${c.inbound_status==='pending_shipment'?'selected':''}>Chờ gửi</option><option value="in_transit" ${c.inbound_status==='in_transit'?'selected':''}>Đang gửi về kho</option><option value="delivered_to_warehouse" ${c.inbound_status==='delivered_to_warehouse'?'selected':''}>Đã đến kho</option></select></label><label style="display:flex;align-items:center;gap:4px;margin-top:14px;"><input type="checkbox" name="restockEligible" ${c.restock_eligible?'checked':''}> Tái nhập kho</label></div><div style="display:flex;gap:8px;"><label style="flex:1;">ĐVVC gửi lại khách:<input type="text" name="outboundCarrier" value="${esc(c.outbound_carrier||'')}" placeholder="GHN, Viettel Post..."></label><label style="flex:1;">Mã vận đơn đổi mới:<input type="text" name="outboundTrackingNumber" value="${esc(c.outbound_tracking_number||'')}" placeholder="VD: GHRMA12345"></label><label style="flex:1;">Trạng thái gửi lại:<select name="outboundStatus"><option value="none" ${(!c.outbound_status||c.outbound_status==='none')?'selected':''}>Không áp dụng</option><option value="preparing" ${c.outbound_status==='preparing'?'selected':''}>Đang chuẩn bị</option><option value="in_transit" ${c.outbound_status==='in_transit'?'selected':''}>Đang giao</option><option value="delivered" ${c.outbound_status==='delivered'?'selected':''}>Đã giao</option></select></label></div><label>Ghi chú thẩm định kỹ thuật:<input type="text" name="inspectionNotes" value="${esc(c.inspection_notes||'')}" placeholder="Tình trạng seal, phụ kiện, số serial..."></label><button type="submit" class="secondary-button" style="justify-self:start;">Cập nhật vận chuyển RMA</button></form></details>`:''}
   </article>`).join('')||'<p>Không có yêu cầu trong thư mục này.</p>';
  }catch(e){if(version===loading)list.textContent=e.message;}
 }
 function open(){panel.hidden=false;document.getElementById('order-workspace').hidden=true;document.querySelectorAll('[data-order-tab]').forEach(b=>b.setAttribute('aria-pressed','false'));document.getElementById('after-sales-toggle')?.setAttribute('aria-expanded','true');return load();}
 function close(){panel.hidden=true;document.getElementById('order-workspace').hidden=false;document.querySelectorAll('[data-order-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.orderTab===document.getElementById('order-filter').value)));document.getElementById('after-sales-toggle')?.setAttribute('aria-expanded','false');}
 async function createReturn(order){
  if(!window.GAERUAdmin.can('orders.write')||!order||!['shipped','completed'].includes(order.status)||order.returnStatus==='returned'||order.returnedAt)return false;
  revision++;searchResults=[order];filter.value='';
  create.elements.search.value=order.orderNumber;create.elements.orderId.innerHTML='<option selected value="'+esc(order.id)+'">'+esc(order.orderNumber)+' · '+esc(order.customerName)+'</option>';
  create.elements.reason.value='';create.querySelector('[data-case-kind]').textContent='Loại yêu cầu: Trả hàng · Giữ nguyên lịch sử đơn đã hoàn tất.';
  create.querySelector('[data-case-create-status]').textContent='Nhập lý do để ghi nhận yêu cầu hoàn trả. Chưa thay đổi đơn, tiền hoặc tồn kho.';
  toolbar.querySelector('[data-after-sales-create]').hidden=false;toolbar.querySelector('[data-after-sales-create]').open=true;
  await open();create.elements.reason.focus();toolbar.scrollIntoView({block:'start',behavior:'smooth'});return true;
 }
 window.GAERUAfterSales={open,close,load,createReturn};
 document.addEventListener('click',e=>{if(e.target.closest('#after-sales-toggle')){if(panel.hidden)open();else close();}});panel.querySelector('[data-after-sales-refresh]').addEventListener('click',load);filter.addEventListener('change',load);
 create.querySelector('[data-find-case-order]').addEventListener('click',async()=>{const version=++revision,status=create.querySelector('[data-case-create-status]');create.elements.orderId.innerHTML='<option value="">Đang tìm…</option>';searchResults=[];try{const query=create.elements.search.value.trim();if(!query)throw Error('Nhập mã đơn, tên hoặc điện thoại để tìm.');const result=await window.GAERUAdmin.request('/api/gaeru_ceo/orders?q='+encodeURIComponent(query)+'&pageSize=100');if(version!==revision)return;searchResults=result.orders.filter(o=>o.status!=='cancelled'&&o.returnStatus!=='returned'&&!o.returnedAt);create.elements.orderId.innerHTML='<option value="">Chọn đơn cần xử lý</option>'+searchResults.map(o=>'<option value="'+esc(o.id)+'">'+esc(o.orderNumber)+' · '+esc(o.customerName)+'</option>').join('');status.textContent=searchResults.length?'Tìm thấy '+searchResults.length+' đơn. Chọn đơn để tạo yêu cầu.':'Không có đơn phù hợp.';}catch(error){if(version===revision){create.elements.orderId.innerHTML='<option value="">Tìm và chọn đơn</option>';status.textContent=error.message;}}});
 create.elements.orderId.addEventListener('change',()=>{const order=searchResults.find(o=>o.id===create.elements.orderId.value);create.querySelector('[data-case-kind]').textContent=order?(['shipped','completed'].includes(order.status)?'Loại yêu cầu: Trả hàng':'Loại yêu cầu: Hủy đơn'):'';});
 create.addEventListener('submit',async event=>{event.preventDefault();if(create.dataset.saving)return;const order=searchResults.find(o=>o.id===create.elements.orderId.value),status=create.querySelector('[data-case-create-status]');if(!order){status.textContent='Chọn một đơn hàng.';return;}const button=create.querySelector('[type=submit]');button.disabled=true;create.dataset.saving='true';try{await window.GAERUAdmin.request('/api/gaeru_ceo/orders/'+order.id+'/after-sales',{method:'POST',body:JSON.stringify({kind:['shipped','completed'].includes(order.status)?'return':'cancellation',reason:create.elements.reason.value})});filter.value='requested';create.elements.reason.value='';status.textContent='Đã chuyển yêu cầu vào thư mục Mới yêu cầu.';await load();}catch(error){status.textContent=error.message;}finally{button.disabled=false;delete create.dataset.saving;}});
 panel.addEventListener('submit',async e=>{
  const rmaForm=e.target.closest('[data-rma-logistics]');
  if(rmaForm){
   e.preventDefault();
   const b=rmaForm.querySelector('button');if(b.disabled)return;b.disabled=true;
   try{
    await window.GAERUAdmin.request('/api/gaeru_ceo/orders/after-sales/'+rmaForm.dataset.rmaLogistics+'/logistics',{
     method:'PATCH',
     body:JSON.stringify({
      inboundStatus:rmaForm.elements.inboundStatus?.value,
      outboundCarrier:rmaForm.elements.outboundCarrier?.value||null,
      outboundTrackingNumber:rmaForm.elements.outboundTrackingNumber?.value||null,
      outboundStatus:rmaForm.elements.outboundStatus?.value,
      inspectionNotes:rmaForm.elements.inspectionNotes?.value||null,
      restockEligible:rmaForm.elements.restockEligible?.checked
     })
    });
    await load();
    window.GAERUAdmin.showGlobal('Đã cập nhật thông tin vận chuyển RMA.');
   }catch(error){
    window.GAERUAdmin.showGlobal(error.message,true);
    b.disabled=false;
   }
   return;
  }
  const f=e.target.closest('[data-case]');if(!f)return;
  e.preventDefault();const b=f.querySelector('button');if(b.disabled)return;b.disabled=true;
  try{
   const target=f.elements.status.value;
   await window.GAERUAdmin.request('/api/gaeru_ceo/orders/after-sales/'+f.dataset.case,{method:'PATCH',body:JSON.stringify({version:Number(f.dataset.version),status:target,resolution:f.elements.resolution.value})});
   filter.value=target;
   await load();
   document.dispatchEvent(new window.CustomEvent('gaeru:after-sales-updated'));
   window.GAERUAdmin.showGlobal('Đã chuyển yêu cầu sang '+labels[target]+'.');
  }catch(error){
   window.GAERUAdmin.showGlobal(error.message,true);
   b.disabled=false;
  }
 });
})();
