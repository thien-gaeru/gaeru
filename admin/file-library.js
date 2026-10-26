(() => {
  'use strict';
  const api = window.GAERUAdmin;
  const root = document.querySelector('#file-library-view');
  const state = { scope: '', folder: '*', trash: false, q: '', page: 1, data: null, request: 0 };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const size = n => n < 1024 ? n + ' B' : new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(n / (n >= 1048576 ? 1048576 : 1024)) + (n >= 1048576 ? ' MB' : ' KB');
  const fileUrl = (file, preview = false) => '/api/gaeru_ceo/file-library/file?key=' + encodeURIComponent(file.key) + (preview ? '&preview=1' : '');
  const previewable = f => /^(image\/(jpeg|png|webp)|video\/(mp4|webm|quicktime))$/.test(f.mime);
  function shell() {
    if (root.querySelector('.file-library')) return;
    root.innerHTML = `<div class="file-library">
      <div class="fl-heading"><div><h2>Thư viện tệp</h2><p data-fl-summary></p></div><div class="fl-actions"><button type="button" class="secondary-button" data-fl-new>Thư mục mới</button><button type="button" class="primary-button" data-fl-upload>Tải tệp lên</button></div></div>
      <details class="fl-location"><summary>Vị trí lưu trữ thực tế</summary><p data-fl-root></p><p>Đây là kho mà ứng dụng đang đọc và ghi. Ảnh trong thư viện mới tải lên chưa tự xuất bản ra website.</p></details>
      <div class="fl-workspace"><nav class="fl-scopes" aria-label="Thư mục lưu trữ"></nav><div class="fl-main">
      <form class="fl-search"><label>Tìm tệp<input name="q" type="search" placeholder="Nhập tên tệp…" maxlength="160"></label><label>Thư mục con<select name="folder" aria-label="Thư mục con"></select></label><button type="submit" class="secondary-button">Tìm kiếm</button><button type="button" class="secondary-button" data-fl-refresh>Tải lại</button></form>
      <p class="fl-feedback" role="status" aria-live="polite"></p><div class="fl-grid"></div><nav class="fl-pagination" aria-label="Trang tệp"></nav></div></div></div>`;
    root.querySelector('.fl-search').addEventListener('submit', e => { e.preventDefault(); state.q = e.currentTarget.elements.q.value.trim(); state.folder = e.currentTarget.elements.folder.value; state.page = 1; refresh(); });
    root.querySelector('[name=folder]').addEventListener('change', e => { state.folder = e.target.value; state.page = 1; refresh(); });
    root.addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-fl-scope')) { state.scope = b.dataset.flScope; state.folder = '*'; state.trash = false; state.page = 1; refresh(); }
      if (b.hasAttribute('data-fl-trash')) { state.trash = true; state.scope = ''; state.folder = '*'; state.page = 1; refresh(); }
      if (b.hasAttribute('data-fl-refresh')) refresh();
      if (b.hasAttribute('data-fl-new')) folderDialog();
      if (b.hasAttribute('data-fl-upload')) uploadDialog();
      if (b.hasAttribute('data-fl-page')) { state.page = Number(b.dataset.flPage); refresh(); }
      if (b.hasAttribute('data-fl-file')) {
        const file = state.data.files[Number(b.dataset.flFile)]; if (!file) return;
        if (b.dataset.action === 'preview') preview(file); else actionDialog(file, b.dataset.action);
      }
    });
  }
  async function refresh() {
    const request = ++state.request;
    const feedback = root.querySelector('.fl-feedback'); feedback.textContent = 'Đang đọc kho tệp…'; root.setAttribute('aria-busy', 'true');
    const params = new URLSearchParams({ scope: state.scope, trash: state.trash ? '1' : '0', q: state.q, page: state.page });
    if (state.folder !== '*') params.set('folder', state.folder);
    try {
      const data = await api.request('/api/gaeru_ceo/file-library?' + params);
      if (request !== state.request) return;
      state.data = data;
      for(const button of root.querySelectorAll('[data-fl-new],[data-fl-upload]'))button.disabled=state.scope==='site-assets';
      if (state.page > data.pages) { state.page = data.pages; return refresh(); }
      root.querySelector('[data-fl-summary]').textContent = `${data.summary.files} tệp · ${size(data.summary.bytes)} · ${data.summary.trash} tệp trong thùng rác`;
      root.querySelector('[data-fl-root]').textContent = data.root;
      root.querySelector('.fl-scopes').innerHTML = `<button type="button" data-fl-scope="" aria-pressed="${!state.scope && !state.trash}">Tất cả tệp</button>` + Object.entries(data.scopes).map(([key, name]) => `<button type="button" data-fl-scope="${key}" aria-pressed="${state.scope === key && !state.trash}">▱ ${esc(name)}</button>`).join('') + `<button type="button" data-fl-trash aria-pressed="${state.trash}">Thùng rác (${data.summary.trash})</button>`;
      const select = root.querySelector('[name=folder]');
      select.innerHTML = '<option value="*">Tất cả thư mục con</option><option value="">Thư mục gốc</option>' + data.folders.filter(f => !state.scope || f.scope === state.scope).map(f => `<option value="${f.id}">${esc(f.name)}${state.scope ? '' : ' · ' + esc(data.scopes[f.scope])}</option>`).join('');
      select.value = state.folder;
      feedback.textContent = `${state.trash ? 'Thùng rác' : data.scopes[state.scope] || 'Tất cả tệp'} · ${data.total} tệp`;
      root.querySelector('.fl-grid').innerHTML = data.files.length ? data.files.map((f, i) => {
        const image = /^image\/(jpeg|png|webp)$/.test(f.mime);
        const locked = f.references.length > 0 || !f.managed;
        const label = f.references.length ? f.references.join('\n') : f.managed ? 'Tệp riêng trong thư viện' : 'Tệp hệ thống được bảo vệ';
        const folder = data.folders.find(n => n.id === f.folder)?.name;
        return `<article class="fl-card"><button class="fl-thumbnail" type="button" data-fl-file="${i}" data-action="preview" aria-label="Xem ${esc(f.name)}">${image ? `<img src="${fileUrl(f, true)}&thumbnail=1" alt="" loading="lazy" decoding="async">` : `<span aria-hidden="true">${f.mime.startsWith('video/') ? '▷' : '▤'}</span><span>${esc(f.mime.split('/').at(-1).toUpperCase())}</span>`}</button>
          <h3 title="${esc(f.name)}">${esc(f.name)}</h3><p>${size(f.size)} · ${esc(data.scopes[f.scope])}${folder ? ' / ' + esc(folder) : ''}</p>
          <details class="fl-usage"><summary>${f.references.length ? 'Đã liên kết hệ thống' : f.managed ? 'Chưa liên kết' : 'Tệp hệ thống'}</summary><p>${esc(label)}</p><p class="fl-key">${esc(f.key)}</p></details>
          <div class="fl-card-actions"><a class="secondary-button" href="${fileUrl(f)}" download>Tải xuống</a>${f.deletedAt ? `<button type="button" class="secondary-button" data-fl-file="${i}" data-action="restore">Khôi phục</button><button type="button" class="secondary-button fl-danger" data-fl-file="${i}" data-action="delete">Xóa vĩnh viễn</button>` : `<button type="button" class="secondary-button" data-fl-file="${i}" data-action="rename" ${locked ? 'disabled' : ''}>Đổi tên</button><button type="button" class="secondary-button" data-fl-file="${i}" data-action="move" ${locked ? 'disabled' : ''}>Di chuyển</button><button type="button" class="secondary-button" data-fl-file="${i}" data-action="trash" ${locked ? 'disabled' : ''}>Thùng rác</button>`}</div></article>`;
      }).join('') : '<p class="fl-empty">Chưa có tệp phù hợp. Bạn có thể tải tệp lên hoặc chọn thư mục khác.</p>';
      root.querySelector('.fl-pagination').innerHTML = `<button type="button" class="secondary-button" data-fl-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>Trước</button><span>Trang ${data.page} / ${data.pages}</span><button type="button" class="secondary-button" data-fl-page="${data.page + 1}" ${data.page >= data.pages ? 'disabled' : ''}>Sau</button>`;
    } catch (error) { if (request === state.request) { feedback.textContent = error.message; root.querySelector('.fl-grid').replaceChildren(); } }
    finally { if (request === state.request) root.removeAttribute('aria-busy'); }
  }
  function modal(title, content, submitLabel) {
    const dialog = document.createElement('dialog'); dialog.className = 'fl-dialog';
    dialog.innerHTML = `<form><header><h2>${esc(title)}</h2><button type="button" class="secondary-button" data-close aria-label="Đóng">×</button></header><div class="fl-dialog-content">${content}</div><p role="alert"></p><footer><button type="button" class="secondary-button" data-close>Đóng</button>${submitLabel ? `<button type="submit" class="primary-button">${esc(submitLabel)}</button>` : ''}</footer></form>`;
    document.body.append(dialog);
    dialog.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('close', () => { dialog.querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); }); dialog.remove(); }, { once: true });
    dialog.showModal(); return dialog;
  }
  function preview(file) {
    let content = '';
    if (/^image\/(jpeg|png|webp)$/.test(file.mime)) content = `<img class="fl-preview" src="${fileUrl(file, true)}" alt="${esc(file.name)}">`;
    else if (previewable(file)) content = `<video class="fl-preview" controls preload="metadata" src="${fileUrl(file, true)}"></video>`;
    else content = '<p>Định dạng này chưa có bản xem trước. Tải xuống để mở bằng ứng dụng phù hợp.</p>';
    modal(file.name, content + `<p>${size(file.size)} · ${esc(file.mime)}</p><a class="secondary-button" href="${fileUrl(file)}" download>Tải xuống</a>`, '');
  }
  function scopeOptions(selected) { return Object.entries(state.data.scopes).filter(([value])=>value!=='site-assets').map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join(''); }
  function folderOptions(scope, selected = '') { return '<option value="">Thư mục gốc</option>' + state.data.folders.filter(f => f.scope === scope).map(f => `<option value="${f.id}" ${f.id === selected ? 'selected' : ''}>${esc(f.name)}</option>`).join(''); }
  async function submit(dialog, operation) {
    const form = dialog.querySelector('form'), button = form.querySelector('[type=submit]'), feedback = form.querySelector('[role=alert]');
    button.disabled = true; feedback.textContent = 'Đang xử lý…';
    try { const result = await operation(form, feedback); dialog.close(); await refresh(); api.showGlobal(result?.message || 'Đã cập nhật thư viện.'); }
    catch (e) { feedback.textContent = e.message; await refresh(); } finally { button.disabled = false; }
  }
  function folderDialog() {
    if (!state.data) return;
    const dialog = modal('Tạo thư mục', `<label>Vị trí<select name="scope">${scopeOptions(state.scope || 'documents')}</select></label><label>Tên thư mục<input name="name" required maxlength="100" placeholder="Ví dụ: Hướng dẫn sử dụng"></label>`, 'Tạo thư mục');
    dialog.querySelector('form').addEventListener('submit', e => { e.preventDefault(); submit(dialog, async form => {
      const result = await api.request('/api/gaeru_ceo/file-library/folders', { method: 'POST', body: JSON.stringify({scope: form.elements.scope.value, name: form.elements.name.value}) });
      state.scope = result.scope; state.folder = result.id; state.trash = false; state.page = 1; return result;
    }); });
  }
  function uploadDialog() {
    if (!state.data) return; const scope = state.scope || 'documents';
    const dialog = modal('Tải tệp lên', `<label>Vị trí<select name="scope">${scopeOptions(scope)}</select></label><label>Thư mục con<select name="folder">${folderOptions(scope, state.folder === '*' ? '' : state.folder)}</select></label><label>Chọn tệp<input name="files" type="file" multiple required accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,application/pdf,.txt,.csv"></label><p>Tối đa 10 tệp mỗi lần. Ảnh tối đa 8 MB, tài liệu 10 MB, MP4 25 MB. Ảnh được xử lý WebP theo cấu hình chất lượng cao của website.</p><p>Tệp mới được giữ riêng trong quản trị; không tự xuất bản.</p>`, 'Tải lên');
    const form = dialog.querySelector('form'); let pending = null, uploaded = 0;
    form.elements.files.addEventListener('change', () => { pending = null; uploaded = 0; });
    form.elements.scope.addEventListener('change', () => { form.elements.folder.innerHTML = folderOptions(form.elements.scope.value); });
    form.addEventListener('submit', e => { e.preventDefault(); if (form.elements.files.files.length > 10) { form.querySelector('[role=alert]').textContent = 'Chọn tối đa 10 tệp mỗi lần.'; return; }
      submit(dialog, async (f, feedback) => { pending ||= [...f.elements.files.files]; while (pending.length) { const file = pending[0];
        feedback.textContent = `Đã tải ${uploaded} tệp. Đang tải: ${file.name}`;
        const data = new FormData(); data.set('scope', f.elements.scope.value); data.set('folder', f.elements.folder.value); data.set('file', file);
        await api.request('/api/gaeru_ceo/file-library/upload', {method:'POST', body:data}); uploaded++; pending.shift();
      } state.scope = f.elements.scope.value; state.folder = f.elements.folder.value; state.trash = false; state.page = 1; return {message:`Đã tải ${uploaded} tệp lên.`}; });
    });
  }
  function actionDialog(file, action) {
    const titles = {rename:'Đổi tên tệp',move:'Di chuyển tệp',trash:'Chuyển vào thùng rác',restore:'Khôi phục tệp',delete:'Xóa vĩnh viễn'};
    let content = `<p>${esc(file.name)}</p>`;
    if (action === 'rename') content += `<label>Tên hiển thị<input name="name" required maxlength="150" value="${esc(file.name.replace(/\.[^.]*$/, ''))}"></label><p>Giữ nguyên định dạng tệp.</p>`;
    if (action === 'move') content += `<label>Thư mục đích<select name="folder">${folderOptions(file.scope, file.folder)}</select></label>`;
    if (action === 'trash') content += '<p>Tệp được ẩn khỏi danh sách chính và có thể khôi phục trong thùng rác.</p>';
    if (action === 'delete') content += '<p>Tệp này sẽ bị xóa khỏi kho và không thể khôi phục bằng thư viện.</p><label class="fl-confirm"><input type="checkbox" name="confirm" required> Tôi xác nhận xóa vĩnh viễn tệp này.</label>';
    const dialog = modal(titles[action], content, titles[action]);
    dialog.querySelector('form').addEventListener('submit', e => { e.preventDefault(); submit(dialog, f => api.request('/api/gaeru_ceo/file-library/change', {method:'POST', body:JSON.stringify({key:file.key,action,name:f.elements.name?.value,folder:f.elements.folder?.value,confirm:f.elements.confirm?.checked === true})})); });
  }
  window.GAERUFileLibrary = {async load() { shell(); await refresh(); }};
})();
