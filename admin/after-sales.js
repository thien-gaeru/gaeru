(()=>{
 const panel=document.getElementById('after-sales-panel'),list=document.getElementById('after-sales-list');
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const labels={requested:'Mới yêu cầu',approved:'Đã duyệt',received:'Đã nhận hàng trả',resolved:'Đã đóng',rejected:'Từ chối'};
 const transitions={requested:['approved','rejected'],approved:['received','resolved','rejected'],received:['resolved'],resolved:[],rejected:[]};
 const refundable=c=>{
  if(c.refundable_amount_vnd===null||c.refundable_amount_vnd===undefined)return null;
  const amount=Number(c.refundable_amount_vnd);return Number.isSafeInteger(amount)&&amount>=0&&amount<=2000000000?amount:null;
 };
 function availableTransitions(c){return (transitions[c.status]||[]).filter(status=>{
  if(c.kind==='cancellation')return status!=='received';
  if(status!=='resolved')return true;
  if(c.status!=='received'||(c.restock_eligible&&!window.GAERUAdmin.can('inventory.approve')))return false;
  if(c.return_type==='exchange')return c.exchange_issue?.status==='posted'&&c.outbound_status==='delivered';
  const amount=refundable(c);return amount!==null&&(amount===0||window.GAERUAdmin.can('payments.write'));
 });}
 function caseActions(c){
  if(!window.GAERUAdmin.can('orders.write')||['resolved','rejected'].includes(c.status))return '';
  const amount=refundable(c),requiresRefund=c.kind==='return'&&c.return_type!=='exchange'&&c.status==='received'&&amount>0;
  const note=c.kind==='return'&&c.status==='received'&&c.restock_eligible&&!window.GAERUAdmin.can('inventory.approve')?'<p>Cần quyền duyệt kho để nhập hàng trả về tồn có thể bán và đóng hồ sơ.</p>':c.kind==='return'&&c.return_type==='exchange'&&c.outbound_status!=='delivered'?'<p>Xuất đủ hàng đổi bằng chứng từ kho trước khi gửi. Chỉ đóng hồ sơ sau khi đã xác nhận khách nhận đủ hàng.</p>':c.kind==='return'&&c.return_type!=='exchange'&&c.status==='received'&&amount===null?'<p>Chưa xác định số tiền cần hoàn. Đối soát thanh toán trước khi đóng hồ sơ.</p>':requiresRefund&&!window.GAERUAdmin.can('payments.write')?'<p>Cần quyền ghi nhận thanh toán để đối soát chứng từ hoàn tiền và đóng hồ sơ.</p>':'';
  const next=availableTransitions(c);if(!next.length)return note;
  const evidence=requiresRefund?`<fieldset data-manual-refund style="min-width:0;display:grid;gap:12px;padding:16px;border:1px solid #dce2ea;border-radius:12px;"><legend>Chứng từ hoàn tiền đã thực hiện</legend><p>Xác nhận bạn đã hoàn tiền cho khách bằng kênh bên ngoài. Thao tác này chỉ ghi nhận chứng từ đã chuyển; hệ thống không chuyển tiền.</p><label>Số tiền đã hoàn (₫)<input name="refundAmountVnd" type="number" min="1" max="2000000000" step="1" value="${amount}" readonly required></label><label>Phương thức đã hoàn<select name="refundMethod"><option value="bank_transfer">Chuyển khoản ngân hàng</option><option value="cash">Tiền mặt</option></select></label><label>Mã giao dịch / chứng từ đã hoàn<input name="refundReference" required minlength="5" maxlength="160" autocomplete="off"></label><label style="display:flex;align-items:flex-start;gap:8px;"><input name="refundConfirmedSent" type="checkbox" required style="flex:none;margin-top:4px;"><span>Tôi xác nhận đã hoàn đủ tiền cho khách và đối chiếu chứng từ.</span></label></fieldset>`:'';
  return note+`<form data-case="${esc(c.id)}" data-version="${c.version}"><label>Bước xử lý<select name="status">${next.map(status=>`<option value="${status}">${labels[status]}</option>`).join('')}</select></label><label>Ghi chú / chứng từ đối soát<textarea name="resolution" required minlength="5" maxlength="2000"></textarea></label>${evidence}<button type="submit" class="secondary-button">${requiresRefund?'Ghi nhận hoàn tiền đã chuyển':'Xác nhận chuyển bước'}</button><p role="status" aria-live="polite"></p></form>`;
 }
 function logisticsEditor(c){
  if(!window.GAERUAdmin.can('orders.write')||c.kind!=='return'||['resolved','rejected'].includes(c.status))return '';
  const posted=c.return_type==='exchange'&&c.exchange_issue?.status==='posted';
  const restock=window.GAERUAdmin.can('inventory.approve')?`<label><input type="checkbox" name="restockEligible" ${c.restock_eligible?'checked':''}> Hàng đủ điều kiện tái nhập kho khi đóng hồ sơ</label>`:'<p>Thẩm định tái nhập kho: '+(c.restock_eligible?'đã đánh dấu đủ điều kiện.':'chưa được duyệt.')+' Cần quyền duyệt kho để thay đổi.</p>';
  const inbound=(posted?[['delivered_to_warehouse','Đã đến kho']]:[['pending_shipment','Chờ gửi'],['in_transit','Đang gửi về kho'],['delivered_to_warehouse','Đã đến kho']]).map(([status,label])=>`<option value="${status}" ${c.inbound_status===status?'selected':''}>${label}</option>`).join('');
  const outbound=posted?`<fieldset style="min-width:0;display:grid;gap:12px;"><legend>Gửi hàng đổi theo chứng từ đã xuất</legend><label>Đơn vị vận chuyển<input name="outboundCarrier" maxlength="60" ${['in_transit','delivered'].includes(c.outbound_status)?'readonly':''} value="${esc(c.outbound_carrier||'')}"></label><label>Mã vận đơn gửi khách<input name="outboundTrackingNumber" maxlength="60" ${['in_transit','delivered'].includes(c.outbound_status)?'readonly':''} value="${esc(c.outbound_tracking_number||'')}"></label><label>Trạng thái gửi khách<select name="outboundStatus">${[['preparing','Đang chuẩn bị'],['in_transit','Đã bàn giao vận chuyển'],['delivered','Khách đã nhận đủ hàng']].filter(([status])=>({preparing:['preparing','in_transit'],in_transit:['in_transit','delivered'],delivered:['delivered']}[c.outbound_status]||['preparing']).includes(status)).map(([status,label])=>`<option value="${status}" ${c.outbound_status===status?'selected':''}>${label}</option>`).join('')}</select></label><p>Ghi nhận vận đơn đã tạo và trạng thái đã đối chiếu thực tế. Thao tác này không đặt vận chuyển hoặc gọi hãng giao hàng.</p></fieldset>`:'';
  return `<details style="margin-top:8px;font-size:0.9em;"><summary>Tiếp nhận, thẩm định và vận chuyển</summary><form data-rma-logistics="${esc(c.id)}" data-version="${c.version}" style="margin-top:6px;padding:12px;border:1px dashed #cbd5e0;border-radius:6px;display:grid;gap:12px;"><label>Trạng thái hàng về kho<select name="inboundStatus">${inbound}</select></label>${restock}<label>Ghi chú thẩm định kỹ thuật<input name="inspectionNotes" maxlength="2000" value="${esc(c.inspection_notes||'')}" placeholder="Tình trạng seal, phụ kiện, số serial…"></label>${outbound}<button type="submit" class="secondary-button">Cập nhật tiếp nhận và vận chuyển</button><p role="status" aria-live="polite"></p></form></details>`;
 }
 function exchangeTools(c){
  if(c.kind!=='return'||c.return_type!=='exchange')return '';
  if(!window.GAERUAdmin.can('inventory.read'))return '<p>Cần quyền xem kho để kiểm tra chứng từ hàng đổi.</p>';
  return `<section data-exchange-tools="${esc(c.id)}" style="display:grid;gap:12px;margin:16px 0;"><h4>Chứng từ xuất hàng đổi</h4><p>Đổi toàn bộ sản phẩm trong đơn, giữ nguyên giá bán. Chọn phiên bản cùng sản phẩm, không bù hoặc trả chênh lệch.</p><button type="button" class="secondary-button" data-load-exchange="${esc(c.id)}">${c.exchange_issue?.status==='posted'?'Xem chứng từ hàng đổi':'Kiểm tra kho và lập chứng từ'}</button><div data-exchange-content></div><p role="status" aria-live="polite" data-exchange-status></p></section>`;
 }
 function renderExchangeOptions(container,data,record){
  const canIssue=window.GAERUAdmin.can('orders.write')&&window.GAERUAdmin.can('inventory.approve');
  let html='';
  if(data.issue){const issue=data.issue;html+=`<article style="padding:12px;border:1px solid #dce2ea;border-radius:12px;"><h4>${issue.status==='posted'?'Đã xuất hàng đổi':'Chứng từ hàng đổi đã hủy'}</h4><p>Kho: ${esc(issue.warehouseName||issue.warehouseId)} · Mã chứng từ: ${esc(issue.id)}</p><ul>${(issue.items||[]).map(item=>`<li>${esc(item.sku)} · ${esc(item.variantName)} × ${item.quantity}</li>`).join('')}</ul></article>`;
   if(issue.status==='posted'&&canIssue&&!['resolved','rejected'].includes(record.status)&&!['in_transit','delivered'].includes(record.outbound_status))html+=`<details><summary>Hủy chứng từ xuất để điều chỉnh</summary><form data-exchange-void="${esc(record.id)}" data-version="${data.version}" data-issue-id="${esc(issue.id)}"><p>Chỉ dùng trước khi bàn giao vận chuyển. Hàng sẽ được trả lại đúng kho đã xuất.</p><label>Lý do hủy<textarea name="reason" required minlength="5" maxlength="1000"></textarea></label><label><input name="confirmedVoid" type="checkbox" required> Tôi xác nhận hàng chưa giao vận chuyển và cần hủy chứng từ này.</label><button type="submit" class="secondary-button">Hủy chứng từ xuất hàng đổi</button></form></details>`;
  }
  if(!data.eligible)html+='<p>'+esc(data.reason||'Hồ sơ chưa đủ điều kiện xuất hàng đổi.')+'</p>';
  else if(!canIssue)html+='<p>Cần quyền duyệt kho và xử lý đơn hàng để xác nhận xuất hàng đổi.</p>';
  else html+=`<form data-exchange-issue="${esc(record.id)}" data-version="${data.version}" style="display:grid;gap:14px;"><label>Kho xuất hàng đổi<select name="warehouseId" required>${data.warehouses.map(warehouse=>`<option value="${esc(warehouse.id)}">${esc(warehouse.code)} · ${esc(warehouse.name)}</option>`).join('')}</select></label>${data.items.map(item=>`<fieldset style="min-width:0;display:grid;gap:8px;"><legend>${esc(item.productName)} × ${item.quantity}</legend><p>Đã mua: ${esc(item.variantName)} · ${esc(item.sku)} · ${new Intl.NumberFormat('vi-VN').format(item.unitPriceVnd)} ₫ / sản phẩm.</p><label>Phiên bản đổi<select data-exchange-item="${esc(item.orderItemId)}" required>${item.candidates.map(candidate=>`<option value="${esc(candidate.variantId)}">${esc(candidate.name)} · ${esc(candidate.sku)}</option>`).join('')}</select></label><p data-exchange-stock-for="${esc(item.orderItemId)}" aria-live="polite"></p></fieldset>`).join('')}<label>Lý do xuất hàng đổi<textarea name="reason" required minlength="5" maxlength="1000"></textarea></label><label style="display:flex;align-items:flex-start;gap:8px;"><input name="confirmedReceivedAll" type="checkbox" required style="flex:none;margin-top:4px;"><span>Tôi đã nhận đủ hàng trả và xác nhận xuất đủ hàng đổi theo đơn.</span></label><button type="submit" class="primary-button">Xác nhận xuất kho hàng đổi</button></form>`;
  container.innerHTML=html;
  const form=container.querySelector('[data-exchange-issue]');if(form)updateExchangeStock(form,data);
 }
 function updateExchangeStock(form,data){
  for(const item of data.items){const select=form.querySelector('[data-exchange-item="'+item.orderItemId+'"]'),candidate=item.candidates.find(candidate=>candidate.variantId===select.value),quantity=candidate?.stock.find(stock=>stock.warehouseId===form.elements.warehouseId.value)?.quantity||0;
   form.querySelector('[data-exchange-stock-for="'+item.orderItemId+'"]').textContent='Tồn tại kho đã chọn: '+quantity+' · Cần xuất: '+item.quantity+'.';
  }
 }
 const toolbar=document.createElement('div');toolbar.className='after-sales-toolbar';toolbar.innerHTML='<label>Thư mục yêu cầu<select data-case-status><option value="">Tất cả</option>'+Object.entries(labels).map(([id,title])=>'<option value="'+id+'">'+title+'</option>').join('')+'</select></label><details data-after-sales-create hidden><summary>Tạo yêu cầu hủy / trả hàng</summary><form data-case-create><label>Tìm mã đơn, tên hoặc điện thoại<input type="search" name="search" maxlength="120"></label><button type="button" class="secondary-button" data-find-case-order>Tìm đơn</button><label>Đơn hàng<select name="orderId" required><option value="">Tìm và chọn đơn</option></select></label><p data-case-kind></p><label>Lý do<textarea name="reason" required minlength="5" maxlength="2000"></textarea></label><button type="submit" class="primary-button">Tạo yêu cầu</button><p role="status" data-case-create-status></p></form></details>';panel.insertBefore(toolbar,list);
 const filter=toolbar.querySelector('[data-case-status]'),create=toolbar.querySelector('[data-case-create]');let searchResults=[],revision=0,loading=0,casesById=new Map(),exchangeOptionsById=new Map();
 async function load(){
  const version=++loading;
  toolbar.querySelector('[data-after-sales-create]').hidden=!window.GAERUAdmin.can('orders.write');
  try{
   const data=await window.GAERUAdmin.request('/api/gaeru_ceo/orders/after-sales?status='+encodeURIComponent(filter.value));
   if(version!==loading)return;
   casesById=new Map(data.cases.map(c=>[c.id,c]));
   exchangeOptionsById=new Map();
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
    <p><strong>${esc(labels[c.status]||c.status)}</strong> · ${esc(c.resolution)}</p>
    ${c.refund_amount_vnd>0?'<p>Đã ghi nhận chứng từ hoàn tiền: '+new Intl.NumberFormat('vi-VN').format(Number(c.refund_amount_vnd))+' ₫.</p>':''}
    ${caseActions(c)}
    ${exchangeTools(c)}
    ${logisticsEditor(c)}
   </article>`).join('')||'<p>Không có yêu cầu trong thư mục này.</p>';
  }catch(e){if(version===loading)list.textContent=e.message;}
 }
 function open(){panel.hidden=false;document.getElementById('order-workspace').hidden=true;const cr=document.getElementById('cod-return-panel');if(cr)cr.hidden=true;document.getElementById('cod-return-toggle')?.setAttribute('aria-expanded','false');document.querySelectorAll('[data-order-tab]').forEach(b=>b.setAttribute('aria-pressed','false'));document.getElementById('after-sales-toggle')?.setAttribute('aria-expanded','true');return load();}
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
 create.addEventListener('submit',async event=>{event.preventDefault();if(create.dataset.saving)return;if(!window.GAERUAdmin.can('orders.write')){window.GAERUAdmin.showGlobal('Bạn không có quyền xử lý đơn hàng.',true);return;}const order=searchResults.find(o=>o.id===create.elements.orderId.value),status=create.querySelector('[data-case-create-status]');if(!order){status.textContent='Chọn một đơn hàng.';return;}const button=create.querySelector('[type=submit]');button.disabled=true;create.dataset.saving='true';try{await window.GAERUAdmin.request('/api/gaeru_ceo/orders/'+order.id+'/after-sales',{method:'POST',body:JSON.stringify({kind:['shipped','completed'].includes(order.status)?'return':'cancellation',reason:create.elements.reason.value})});filter.value='requested';create.elements.reason.value='';status.textContent='Đã chuyển yêu cầu vào thư mục Mới yêu cầu.';await load();}catch(error){status.textContent=error.message;}finally{button.disabled=false;delete create.dataset.saving;}});
 panel.addEventListener('click',async event=>{
  const button=event.target.closest('[data-load-exchange]');if(!button||button.disabled)return;
  const id=button.dataset.loadExchange,section=button.closest('[data-exchange-tools]'),status=section.querySelector('[data-exchange-status]');button.disabled=true;status.classList.remove('is-error');status.textContent='Đang kiểm tra kho và chứng từ…';
  try{
   if(!window.GAERUAdmin.can('inventory.read'))throw Error('Cần quyền xem kho để kiểm tra hàng đổi.');
   const data=await window.GAERUAdmin.request('/api/gaeru_ceo/orders/after-sales/'+id+'/exchange-options');
   if(!section.isConnected)return;const record=casesById.get(id);if(!record)return;
   exchangeOptionsById.set(id,data);renderExchangeOptions(section.querySelector('[data-exchange-content]'),data,record);status.textContent='';
  }catch(error){if(section.isConnected){status.classList.add('is-error');status.textContent=error.message;}}
  finally{if(button.isConnected)button.disabled=false;}
 });
 panel.addEventListener('change',event=>{const form=event.target.closest('[data-exchange-issue]');if(form){const data=exchangeOptionsById.get(form.dataset.exchangeIssue);if(data)updateExchangeStock(form,data);const feedback=form.closest('[data-exchange-tools]').querySelector('[data-exchange-status]');if(feedback.classList.contains('is-error')){feedback.classList.remove('is-error');feedback.textContent='';}}});
 panel.addEventListener('submit',async e=>{
  const exchangeForm=e.target.closest('[data-exchange-issue],[data-exchange-void]');
  if(exchangeForm){
   e.preventDefault();const button=exchangeForm.querySelector('button');if(button.disabled)return;button.disabled=true;
   const id=exchangeForm.dataset.exchangeIssue||exchangeForm.dataset.exchangeVoid,section=exchangeForm.closest('[data-exchange-tools]'),feedback=section.querySelector('[data-exchange-status]');
   feedback.classList.remove('is-error');
   try{
    if(!window.GAERUAdmin.can('orders.write')||!window.GAERUAdmin.can('inventory.approve'))throw Error('Cần quyền duyệt kho và xử lý đơn hàng để xác nhận chứng từ hàng đổi.');
    const data=exchangeOptionsById.get(id),record=casesById.get(id);if(!data||!record)throw Error('Tải lại hồ sơ để kiểm tra chứng từ mới nhất.');
    const reason=exchangeForm.elements.reason.value.trim();if(reason.length<5||reason.length>1000)throw Error('Nhập lý do từ 5 đến 1000 ký tự.');
    const body={version:Number(exchangeForm.dataset.version),requestKey:exchangeForm.dataset.requestKey||(exchangeForm.dataset.requestKey=window.crypto.randomUUID()),reason};
    let endpoint='/exchange-issue';
    if(exchangeForm.dataset.exchangeVoid){
     if(!data.issue||data.issue.status!=='posted'||data.issue.id!==exchangeForm.dataset.issueId||['in_transit','delivered'].includes(record.outbound_status)||['resolved','rejected'].includes(record.status))throw Error('Chứng từ không còn đủ điều kiện hủy trước khi giao vận chuyển.');
     if(!exchangeForm.elements.confirmedVoid.checked)throw Error('Xác nhận hàng chưa giao vận chuyển trước khi hủy chứng từ.');
     body.issueId=data.issue.id;endpoint+='/void';
    }else{
     if(!data.eligible||data.issue?.status==='posted')throw Error(data.reason||'Hồ sơ chưa đủ điều kiện xuất hàng đổi.');
     body.warehouseId=exchangeForm.elements.warehouseId.value;if(!data.warehouses.some(warehouse=>warehouse.id===body.warehouseId))throw Error('Chọn kho xuất hợp lệ.');
     body.confirmedReceivedAll=exchangeForm.elements.confirmedReceivedAll.checked===true;if(!body.confirmedReceivedAll)throw Error('Xác nhận đã nhận đủ hàng trả và xuất đủ hàng đổi.');
     body.items=data.items.map(item=>{const replacementVariantId=exchangeForm.querySelector('[data-exchange-item="'+item.orderItemId+'"]').value,candidate=item.candidates.find(candidate=>candidate.variantId===replacementVariantId),stock=candidate?.stock.find(stock=>stock.warehouseId===body.warehouseId)?.quantity||0;if(!candidate||stock<item.quantity)throw Error('Kho đã chọn không đủ số lượng phiên bản đổi. Kiểm tra lại tồn kho.');return {orderItemId:item.orderItemId,replacementVariantId,quantity:item.quantity};});
     if(!body.items.length)throw Error('Không có sản phẩm đủ điều kiện xuất hàng đổi.');
     const totals=new Map();for(const item of body.items)totals.set(item.replacementVariantId,(totals.get(item.replacementVariantId)||0)+item.quantity);
     for(const [variantId,quantity] of totals){const candidate=data.items.flatMap(item=>item.candidates).find(candidate=>candidate.variantId===variantId),stock=candidate.stock.find(stock=>stock.warehouseId===body.warehouseId)?.quantity||0;if(quantity>stock)throw Error('Tổng số lượng phiên bản đổi vượt tồn kho đã chọn. Kiểm tra lại toàn bộ dòng hàng.');}
    }
    feedback.textContent='Đang ghi nhận chứng từ kho…';await window.GAERUAdmin.request('/api/gaeru_ceo/orders/after-sales/'+id+endpoint,{method:'POST',body:JSON.stringify(body)});
    await load();document.dispatchEvent(new window.CustomEvent('gaeru:after-sales-updated'));window.GAERUAdmin.showGlobal(exchangeForm.dataset.exchangeVoid?'Đã hủy chứng từ và trả hàng về đúng kho.':'Đã xuất đủ hàng đổi và ghi nhận chứng từ kho.');
   }catch(error){if(feedback.isConnected){feedback.classList.add('is-error');feedback.textContent=error.message;}}
   finally{if(button.isConnected)button.disabled=false;}
   return;
  }
  const rmaForm=e.target.closest('[data-rma-logistics]');
  if(rmaForm){
   e.preventDefault();
   if(!window.GAERUAdmin.can('orders.write')){window.GAERUAdmin.showGlobal('Bạn không có quyền xử lý đơn hàng.',true);return;}
   const b=rmaForm.querySelector('button');if(b.disabled)return;b.disabled=true;
   try{
    if(rmaForm.elements.outboundStatus&&['in_transit','delivered'].includes(rmaForm.elements.outboundStatus.value)&&(!rmaForm.elements.outboundCarrier.value.trim()||rmaForm.elements.outboundTrackingNumber.value.trim().length<4))throw Error('Nhập đơn vị vận chuyển và mã vận đơn ít nhất 4 ký tự trước khi ghi nhận giao hàng.');
    await window.GAERUAdmin.request('/api/gaeru_ceo/orders/after-sales/'+rmaForm.dataset.rmaLogistics+'/logistics',{
     method:'PATCH',
     body:JSON.stringify({
      version:Number(rmaForm.dataset.version),
      inboundStatus:rmaForm.elements.inboundStatus?.value,
      ...(rmaForm.elements.outboundStatus?{outboundCarrier:rmaForm.elements.outboundCarrier.value.trim()||null,outboundTrackingNumber:rmaForm.elements.outboundTrackingNumber.value.trim()||null,outboundStatus:rmaForm.elements.outboundStatus.value}:{}),
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
  e.preventDefault();if(!window.GAERUAdmin.can('orders.write')){window.GAERUAdmin.showGlobal('Bạn không có quyền xử lý đơn hàng.',true);return;}const b=f.querySelector('button');if(b.disabled)return;b.disabled=true;
  try{
   const target=f.elements.status.value;
   const record=casesById.get(f.dataset.case);
   if(!record||!availableTransitions(record).includes(target))throw Error('Bước xử lý chưa được phép. Kiểm tra quyền và tải lại hồ sơ.');
   const body={version:Number(f.dataset.version),status:target,resolution:f.elements.resolution.value};
   if(target==='resolved'&&record.kind==='return'&&record.return_type!=='exchange'&&refundable(record)>0){
    if(!window.GAERUAdmin.can('payments.write'))throw Error('Cần quyền ghi nhận thanh toán để đối soát chứng từ hoàn tiền.');
    const amountVnd=Number(f.elements.refundAmountVnd?.value),method=f.elements.refundMethod?.value,reference=f.elements.refundReference?.value.trim()||'',confirmedSent=f.elements.refundConfirmedSent?.checked===true;
    if(!Number.isSafeInteger(amountVnd)||amountVnd!==refundable(record))throw Error('Số tiền hoàn phải khớp số tiền cần hoàn của đơn hàng.');
    if(!['cash','bank_transfer'].includes(method)||reference.length<5||reference.length>160||!confirmedSent)throw Error('Đối chiếu mã chứng từ và xác nhận đã hoàn đủ tiền cho khách trước khi ghi nhận.');
    body.manualRefund={amountVnd,method,reference,confirmedSent};
   }
   const result=await window.GAERUAdmin.request('/api/gaeru_ceo/orders/after-sales/'+f.dataset.case,{method:'PATCH',body:JSON.stringify(body)});
   filter.value=target;
   await load();
   document.dispatchEvent(new window.CustomEvent('gaeru:after-sales-updated'));
   window.GAERUAdmin.showGlobal(result?.settlementScope==='manual_refund_recorded'?'Đã ghi nhận chứng từ hoàn tiền đã chuyển và đóng hồ sơ.':'Đã chuyển yêu cầu sang '+labels[target]+'.');
  }catch(error){
   f.querySelector('[role=status]').textContent=error.message;
   window.GAERUAdmin.showGlobal(error.message,true);
   b.disabled=false;
  }
 });
})();
