(()=>{'use strict';let loaded=false,loading=false,epoch=0;const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function loadLearnedSection(box, a) {
  let container = box.querySelector('[data-learned-knowledge-container]');
  if (!container) {
    container = document.createElement('div');
    container.setAttribute('data-learned-knowledge-container', '');
    container.style.cssText = 'margin-top: 24px; padding-top: 20px; border-top: 2px dashed #e2e8f0;';
    box.querySelector('div').appendChild(container);
  }

  container.innerHTML = '<p class="help-text">Đang tải tri thức tự học…</p>';
  try {
    const res = await a.request('/api/gaeru_ceo/ai-knowledge/learned');
    const stats = res?.stats?.counts || {};
    const items = res?.items || [];

    const statsMarkup = `
      <div style="margin-bottom: 18px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div>
            <h4 style="margin: 0 0 4px 0; font-size: 1.1rem; color: #0f172a;">🧠 Tri thức Tự học từ Cuộc trò chuyện (Autonomous Learning)</h4>
            <p style="margin: 0; font-size: 0.85rem; color: #64748b;">
              GAERU AI tự động đúc kết kinh nghiệm từ giải đáp của nhân viên và phản hồi khách hàng để ngày càng thông minh hơn.
            </p>
          </div>
          <div>
            <button type="button" class="secondary-button" data-learned-scan style="cursor: pointer; padding: 6px 14px; font-weight: 600;">
              ⚡ Quét & Học hỏi từ Lịch sử Chat ngay
            </button>
          </div>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-top: 14px;">
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; text-align: center;">
            <div style="font-size: 1.25rem; font-weight: 700; color: #0284c7;">${stats.total || 0}</div>
            <div style="font-size: 0.75rem; color: #64748b;">Tổng tri thức đã học</div>
          </div>
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; text-align: center;">
            <div style="font-size: 1.25rem; font-weight: 700; color: #16a34a;">${stats.active_count || 0}</div>
            <div style="font-size: 0.75rem; color: #64748b;">Đang kích hoạt phục vụ</div>
          </div>
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; text-align: center;">
            <div style="font-size: 1.25rem; font-weight: 700; color: #8b5cf6;">${stats.total_interactions || 0}</div>
            <div style="font-size: 0.75rem; color: #64748b;">Lượt tương tác học hỏi</div>
          </div>
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; text-align: center;">
            <div style="font-size: 1.25rem; font-weight: 700; color: #ea580c;">${Math.round((stats.avg_confidence || 0.85) * 100)}%</div>
            <div style="font-size: 0.75rem; color: #64748b;">Độ tin cậy trung bình</div>
          </div>
        </div>
      </div>
    `;

    const listMarkup = items.length === 0 ? `
      <div style="background: #f1f5f9; padding: 14px; border-radius: 8px; text-align: center; color: #64748b; font-size: 0.9rem;">
        Chưa có tri thức nào được đúc kết. Bấm <strong>"Quét & Học hỏi từ Lịch sử Chat ngay"</strong> hoặc bắt đầu nhắn tin với khách hàng để AI tự học.
      </div>
    ` : `
      <div style="overflow-x: auto; max-height: 420px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem; text-align: left;">
          <thead style="background: #f8fafc; border-bottom: 1px solid #e2e8f0; position: sticky; top: 0;">
            <tr>
              <th style="padding: 8px 12px;">Chủ đề & Dữ kiện đúc kết</th>
              <th style="padding: 8px 12px; width: 140px;">Từ khóa nhận diện</th>
              <th style="padding: 8px 12px; width: 110px; text-align: center;">Độ tin cậy / Tần suất</th>
              <th style="padding: 8px 12px; width: 90px; text-align: center;">Trạng thái</th>
              <th style="padding: 8px 12px; width: 100px; text-align: right;">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(it => `
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 8px 12px;">
                  <strong style="color: #0f172a; display: block; margin-bottom: 2px;">${esc(it.topic)}</strong>
                  <div style="color: #334155; font-size: 0.8rem; line-height: 1.4;">${esc(it.learned_facts || it.sample_answer)}</div>
                  <small style="color: #94a3b8; font-size: 0.7rem;">Nguồn: ${it.source_type === 'staff_guidance' ? 'Nhân viên giải đáp' : 'Hội thoại khách hàng'}</small>
                </td>
                <td style="padding: 8px 12px;">
                  ${(it.triggers || []).map(t => `<span style="display: inline-block; background: #e0f2fe; color: #0369a1; padding: 1px 6px; border-radius: 4px; font-size: 0.72rem; margin: 1px;">${esc(t)}</span>`).join('')}
                </td>
                <td style="padding: 8px 12px; text-align: center;">
                  <strong style="color: #16a34a;">${Math.round((it.confidence_score || 0.85) * 100)}%</strong><br>
                  <small style="color: #64748b;">${it.occurrence_count || 1} lần</small>
                </td>
                <td style="padding: 8px 12px; text-align: center;">
                  <span style="display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.72rem; font-weight: 600; background: ${it.status === 'active' ? '#dcfce7; color: #15803d;' : '#fef9c3; color: #854d0e;'}">
                    ${it.status === 'active' ? 'Đang dùng' : 'Chờ duyệt'}
                  </span>
                </td>
                <td style="padding: 8px 12px; text-align: right; white-space: nowrap;">
                  ${it.status !== 'active' ? `<button type="button" class="secondary-button" data-learned-approve="${it.id}" style="font-size: 0.75rem; padding: 2px 6px; cursor: pointer;">Duyệt</button>` : ''}
                  <button type="button" class="secondary-button" data-learned-delete="${it.id}" style="font-size: 0.75rem; padding: 2px 6px; cursor: pointer; color: #dc2626;">Xóa</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    container.innerHTML = statsMarkup + listMarkup;

    // Gắn sự kiện Scan
    const scanBtn = container.querySelector('[data-learned-scan]');
    if (scanBtn) {
      scanBtn.onclick = async () => {
        scanBtn.disabled = true;
        scanBtn.textContent = 'Đang quét và đúc kết…';
        try {
          const scanRes = await a.request('/api/gaeru_ceo/ai-knowledge/learned/scan', { method: 'POST' });
          alert(`Đã đúc kết thành công! Xử lý: ${scanRes.processed || 0} tin nhắn, ghi nhận: ${scanRes.learned || 0} bài học mới.`);
          loadLearnedSection(box, a);
        } catch (err) {
          alert('Lỗi quét: ' + err.message);
        } finally {
          scanBtn.disabled = false;
          scanBtn.textContent = '⚡ Quét & Học hỏi từ Lịch sử Chat ngay';
        }
      };
    }

    // Gắn sự kiện Approve
    container.querySelectorAll('[data-learned-approve]').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.learnedApprove;
        try {
          await a.request(`/api/gaeru_ceo/ai-knowledge/learned/${id}/status`, {
            method: 'POST',
            body: JSON.stringify({ status: 'active' })
          });
          loadLearnedSection(box, a);
        } catch (err) {
          alert('Lỗi duyệt: ' + err.message);
        }
      };
    });

    // Gắn sự kiện Delete
    container.querySelectorAll('[data-learned-delete]').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.learnedDelete;
        if (!confirm('Bạn có chắc chắn muốn xóa mục tri thức tự học này?')) return;
        try {
          await a.request(`/api/gaeru_ceo/ai-knowledge/learned/${id}`, { method: 'DELETE' });
          loadLearnedSection(box, a);
        } catch (err) {
          alert('Lỗi xóa: ' + err.message);
        }
      };
    });

  } catch (err) {
    container.innerHTML = `<p style="color: #dc2626; font-size: 0.85rem;">Không tải được mục tri thức tự học: ${esc(err.message)}</p>`;
  }
}

async function load(){
  const turn=epoch;
  const a=window.GAERUAdmin,root=document.querySelector('#settings-view');
  if(!a?.can('settings.read')||!root||loaded||loading)return;
  loading=true;
  try{
    const d=await a.request('/api/gaeru_ceo/ai-knowledge');
    if(turn!==epoch)return;
    const box=document.createElement('details');
    box.className='configuration-panel';
    box.id='ai-knowledge-editor';
    box.innerHTML='<summary>Tri thức và nguồn tham khảo Chat AI</summary><div><button type="button" class="secondary-button" data-reload>Tải lại cấu hình</button><p>Nội dung đã duyệt được dùng làm dữ liệu tham khảo, không thay đổi giá/tồn kho hoặc chính sách đang lưu. URL nguồn chỉ để đối chiếu, hệ thống không tự tải địa chỉ tùy ý.</p><form><label><input type="checkbox" name="webSearchEnabled" '+(d.webSearchEnabled?'checked':'')+'> Cho phép tìm thông tin kỹ thuật trên web (có thể gửi một phần câu hỏi tới dịch vụ tìm kiếm)</label><label><input type="checkbox" name="curatedEnabled" '+(d.curatedEnabled?'checked':'')+'> Sử dụng tri thức công nghệ có sẵn</label><div data-knowledge-entries></div><button type="button" class="secondary-button" data-add>Thêm nội dung đã duyệt</button><button type="submit" class="primary-button">Lưu tri thức</button><p role="status"></p></form></div>';
    root.append(box);
    box.querySelector('[data-reload]').onclick=()=>{loaded=false;box.remove();load()};
    const form=box.querySelector('form'),list=box.querySelector('[data-knowledge-entries]');

    const add=(e={title:'',triggers:[],facts:[],sourceUrl:'',enabled:true})=>{
      const row=document.createElement('fieldset');
      row.style.cssText='margin:16px 0;padding:16px;border:1px solid #d2d7df;border-radius:14px;min-width:0';
      row.innerHTML='<label>Chủ đề<input name="title" required maxlength="160" value="'+esc(e.title)+'"></label><label>Từ khóa (mỗi dòng một từ/cụm từ)<textarea name="triggers" required rows="2">'+esc(e.triggers.join('\n'))+'</textarea></label><label>Thông tin đã duyệt (mỗi dòng một ý)<textarea name="facts" required rows="4">'+esc(e.facts.join('\n'))+'</textarea></label><label>Nguồn HTTPS để đối chiếu<input name="sourceUrl" type="url" value="'+esc(e.sourceUrl)+'"></label><label><input name="enabled" type="checkbox" '+(e.enabled?'checked':'')+'> Đang sử dụng</label><button type="button" class="secondary-button" data-remove>Bỏ mục</button>';
      row.querySelector('[data-remove]').onclick=()=>row.remove();
      list.append(row);
    };

    (d.entries||[]).forEach(add);
    box.querySelector('[data-add]').onclick=()=>{if(list.children.length<80)add()};
    if(!a.can('settings.write'))form.querySelectorAll('input,textarea,button').forEach(e=>e.disabled=true);
    
    form.onsubmit=async e=>{
      e.preventDefault();
      const status=form.querySelector('[role=status]'),button=form.querySelector('[type=submit]');
      button.disabled=true;
      try{
        const entries=[...list.querySelectorAll('fieldset')].map(row=>{
          const q=n=>row.querySelector('[name="'+n+'"]');
          return{
            title:q('title').value,
            triggers:q('triggers').value.split('\n').map(s=>s.trim()).filter(Boolean),
            facts:q('facts').value.split('\n').map(s=>s.trim()).filter(Boolean),
            sourceUrl:q('sourceUrl').value,
            enabled:q('enabled').checked
          };
        });
        const saved=await a.request('/api/gaeru_ceo/ai-knowledge',{
          method:'PUT',
          body:JSON.stringify({
            version:d.version,
            webSearchEnabled:form.elements.webSearchEnabled.checked,
            curatedEnabled:form.elements.curatedEnabled.checked,
            entries
          })
        });
        d.version=saved.version;
        status.textContent='Đã lưu tri thức.';
      }catch(e){
        status.textContent=e.message;
      }finally{
        button.disabled=false;
      }
    };

    // Tải phần Tri thức Tự học từ Cuộc trò chuyện
    void loadLearnedSection(box, a);

    loaded=true;
  }catch(e){
    console.warn('Không tải được trình quản lý tri thức.');
  }finally{
    loading=false;
  }
}

document.addEventListener('gaeru:admin-ready',()=>{epoch++;loaded=false;loading=false;document.querySelector('#ai-knowledge-editor')?.remove();load()});
window.addEventListener('hashchange',()=>{if(location.hash==='#settings')load()});
if(window.GAERUAdmin?.user)load();
})();
