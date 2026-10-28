(() => {
 const admin=window.GAERUAdmin;if(!admin)return;let state;
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 async function mount(){
  const root=document.querySelector('#tiktok-ads-configuration');if(!root)return;
  root.hidden=!(admin.user?.role==='owner'&&admin.user?.source==='bootstrap');if(root.hidden)return;
  state=await admin.request('/api/gaeru_ceo/owner/tiktok-ads');const s=state.configuration,c=state.connection;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:c.timezone||'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  root.innerHTML=`<details class="configuration-panel"><summary><span>TikTok Ads · Chi phí quảng cáo</span><small>${c.connected?'Đã xác minh quyền đọc':'Chưa kết nối'}</small></summary><p>Chỉ đọc chi phí; không tạo quảng cáo, thay ngân sách hoặc trừ tiền. Báo cáo BASIC Auction chưa gồm GMV Max. Múi giờ và tiền tệ lấy từ tài khoản quảng cáo.</p>${c.connected?`<p>${esc(c.name)} · ${esc(c.currency)} · ${esc(c.timezone)}</p><p>Lần đồng bộ gần nhất: ${c.lastSyncedAt?esc(new Date(c.lastSyncedAt).toLocaleString('vi-VN')):'Chưa đồng bộ'}</p>`:''}<form data-tiktok-ads-form><div class="form-grid"><label>Advertiser ID<input name="advertiserId" value="${esc(s.advertiserId)}" inputmode="numeric" pattern="[0-9]{6,30}" required maxlength="30"></label><label>Access Token<input name="accessToken" type="password" autocomplete="new-password" maxlength="2000" placeholder="${s.secretConfigured?'Đã lưu · để trống để giữ nguyên':'Nhập khóa có quyền đọc báo cáo'}"></label></div><label><input type="checkbox" name="enabled" ${s.enabled?'checked':''}> Tự cập nhật chi phí mỗi 6 giờ sau khi xác minh kết nối</label><div class="form-grid"><label>Từ ngày<input name="from" type="date" value="${today.slice(0,7)}-01" required></label><label>Đến ngày<input name="to" type="date" value="${today}" required></label></div><p>Tối đa 31 ngày mỗi lần. Kết quả dùng múi giờ tài khoản, có thể khác giờ Việt Nam.</p><div class="configuration-reauth"><label>Mật khẩu hiện tại<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label><label>Mã MFA / mã dự phòng<input name="factorCode" autocomplete="one-time-code" maxlength="32"></label><button type="button" data-tiktok-ads-email>Gửi mã qua email</button></div><div class="configuration-actions"><button class="primary-button" type="submit">Lưu kết nối</button><button class="secondary-button" type="button" data-tiktok-ads-action="test" ${s.version?'':'disabled'}>Kiểm tra quyền đọc</button><button class="secondary-button" type="button" data-tiktok-ads-action="sync" ${s.version?'':'disabled'}>Lấy chi phí</button></div><p role="status" aria-live="polite"></p></form></details>`;
 }
 async function act(form,action){
  const status=form.querySelector('[role=status]');if(!form.elements.password.value){status.textContent='Nhập mật khẩu hiện tại để xác nhận.';form.elements.password.focus();return;}
  if(action!=='save'&&(form.elements.advertiserId.value.trim()!==state.configuration.advertiserId||form.elements.accessToken.value||form.elements.enabled.checked!==state.configuration.enabled)){status.textContent='Lưu các thay đổi kết nối trước khi kiểm tra hoặc lấy chi phí.';return;}
  const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
  const auth={password:form.elements.password.value,factorCode:form.elements.factorCode.value,factorChallengeId:form.dataset.challenge};
  try{
   let result;if(action==='save'){
    const data={advertiserId:form.elements.advertiserId.value.trim(),enabled:form.elements.enabled.checked};if(form.elements.accessToken.value)data.accessToken=form.elements.accessToken.value;
    result=await admin.request('/api/gaeru_ceo/owner/tiktok-ads/configuration',{method:'PUT',body:JSON.stringify({version:state.configuration.version,data,...auth})});state=result;
   }else result=await admin.request('/api/gaeru_ceo/owner/tiktok-ads/'+action,{method:'POST',body:JSON.stringify({version:state.configuration.version,from:form.elements.from.value,to:form.elements.to.value,...auth})});
   await mount();admin.showGlobal(result.message||'Đã cập nhật TikTok Ads.');
  }catch(e){status.textContent=e.message;admin.showGlobal(e.message,true);}
  finally{form.elements.password.value='';form.elements.factorCode.value='';form.elements.accessToken.value='';delete form.dataset.challenge;buttons.forEach(b=>b.disabled=false);}
 }
 document.addEventListener('submit',e=>{const form=e.target.closest('[data-tiktok-ads-form]');if(!form)return;e.preventDefault();void act(form,'save');});
 document.addEventListener('click',async e=>{
  const action=e.target.closest('[data-tiktok-ads-action]');if(action){await act(action.closest('form'),action.dataset.tiktokAdsAction);return;}
  const email=e.target.closest('[data-tiktok-ads-email]');if(!email)return;const form=email.closest('form'),status=form.querySelector('[role=status]');email.disabled=true;
  try{const result=await window.GAERUSecurity.api('/authorize',{password:form.elements.password.value});form.dataset.challenge=result.challengeId;status.textContent=result.message;}catch(error){status.textContent=error.message;}finally{email.disabled=false;}
 });
 window.GAERUTikTokAds={mount};
})();
