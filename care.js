(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const queryAll = (root, sel) => (root && typeof root.querySelectorAll === 'function') ? Array.prototype.slice.call(root.querySelectorAll(sel)) : [];
  const labels = { submitted: 'Đã tiếp nhận', reviewing: 'Đang kiểm tra', waiting_customer: 'Cần thêm thông tin', resolved: 'Đã xử lý', closed: 'Đã đóng' };
  const channelLabels = { website: 'Website GAERU', shopee: 'Shopee', tiktok: 'TikTok Shop', lazada: 'Lazada' };
  const channelPlaceholders = {
    shopee: 'Nhập hoặc dán mã đơn Shopee',
    tiktok: 'Nhập hoặc dán mã đơn TikTok',
    lazada: 'Nhập hoặc dán mã đơn Lazada',
    website: 'Nhập hoặc dán mã đơn GAERU'
  };

  const form = document.querySelector('#care-form');
  const status = document.querySelector('#care-session');
  const feedback = document.querySelector('#care-feedback');
  if (!form) return;

  let page = 1, orderPage = 1, pendingKey = null, pendingBody = null, sending = false, livePoll = null;
  let selectedFiles = [];

  const newRequestKey = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  const formatBytes = bytes => {
    const n = Number(bytes || 0);
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  };

  async function api(url, options = {}) {
    const headers = {};
    if (options.method) {
      const r = await fetch('/api/csrf', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw Error('Không thể khởi tạo phiên. Hãy tải lại trang.');
      headers['X-CSRF-Token'] = (await r.json()).csrfToken;
      headers['Content-Type'] = 'application/json';
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 15000) : null;
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(15000)
      : controller?.signal;
    let response;
    try {
      response = await fetch(url, { ...options, headers, credentials: 'same-origin', cache: 'no-store', ...(signal ? { signal } : {}) });
    } finally {
      if (timer) clearTimeout(timer);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(Error(data.error || 'Không thể tải thông tin. Vui lòng thử lại.'), { status: response.status });
    return data;
  }

  function openRequest() { document.querySelector('#care-new-request').open = true; }
  function openFromHash() { if (location.hash === '#care-request') openRequest(); }
  window.addEventListener('hashchange', openFromHash);
  document.addEventListener('click', event => {
    const direct = event.target?.closest?.('a[href="#care-request"]');
    const link = direct || event.target?.closest?.('a[href$="#care-request"]');
    if (direct || (link && (!link.getAttribute || link.getAttribute('href')?.startsWith('#') || (link.href && new URL(link.href, location.href).pathname === location.pathname)))) openRequest();
  });
  openFromHash();

  function syncChannelPills() {
    const val = form.elements.channel.value || 'website';
    queryAll(form, '[data-care-pill]').forEach(btn => {
      const isAct = btn.dataset?.carePill === val;
      btn.classList?.toggle?.('is-active', isAct);
      btn.setAttribute?.('aria-pressed', String(isAct));
    });
  }

  function sourceChanged() {
    const val = form.elements.channel.value;
    const account = val === 'website';
    for (const [selector, enabled] of [['[data-care-account]', account], ['[data-care-external]', !account]]) {
      const group = form.querySelector(selector);
      group.hidden = !enabled;
      group.disabled = !enabled;
    }
    if (!account) {
      const orderLabel = form.querySelector('[data-care-order-label]');
      if (orderLabel && orderLabel !== form) orderLabel.textContent = '2. Mã đơn hàng ' + (channelLabels[val] || 'trên sàn');
      if (form.elements.externalOrderNumber) {
        form.elements.externalOrderNumber.placeholder = channelPlaceholders[val] || channelPlaceholders.shopee;
      }
    }
    syncChannelPills();
  }
  form.elements.channel.addEventListener('change', sourceChanged);
  sourceChanged();

  const initialFileInput = form.querySelector('[data-care-files]');
  const uploadBox = form.querySelector('[data-care-upload-box]');
  const chipsContainer = form.querySelector('[data-care-file-chips]');

  function renderSelectedFiles() {
    if (!chipsContainer || chipsContainer === form) return;
    chipsContainer.hidden = selectedFiles.length === 0;
    chipsContainer.innerHTML = selectedFiles.map((file, idx) =>
      `<span class="care-upload-chip">` +
        `<span class="care-chip-name">${escape(file.name)}</span>` +
        `<small class="care-chip-size">${formatBytes(file.size)}</small>` +
        `<button type="button" class="care-chip-remove" data-care-remove-file="${idx}" aria-label="Bỏ tệp ${escape(file.name)}">×</button>` +
      `</span>`
    ).join('');
  }

  function addInitialFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const incoming = Array.prototype.slice.call(fileList);
    for (let i = 0; i < incoming.length; i++) {
      const f = incoming[i];
      if (!f) continue;
      if (f.size > 10 * 1024 * 1024) {
        feedback.textContent = 'Tệp "' + f.name + '" vượt quá 10MB. Vui lòng chọn tệp nhỏ hơn.';
        continue;
      }
      if (selectedFiles.length >= 5) {
        feedback.textContent = 'Đính kèm tối đa 5 tệp cho mỗi lần gửi.';
        break;
      }
      const dup = selectedFiles.some(existing => existing.name === f.name && existing.size === f.size);
      if (!dup) selectedFiles.push(f);
    }
    if (initialFileInput) {
      try { initialFileInput.value = ''; } catch {}
    }
    renderSelectedFiles();
  }

  if (initialFileInput && initialFileInput !== form) {
    initialFileInput.addEventListener('change', () => addInitialFiles(initialFileInput.files));
  }
  if (uploadBox && uploadBox !== form) {
    uploadBox.addEventListener('dragover', event => {
      event.preventDefault?.();
      uploadBox.classList?.add?.('is-dragover');
    });
    uploadBox.addEventListener('dragleave', () => {
      uploadBox.classList?.remove?.('is-dragover');
    });
    uploadBox.addEventListener('drop', event => {
      event.preventDefault?.();
      uploadBox.classList?.remove?.('is-dragover');
      addInitialFiles(event.dataTransfer?.files);
    });
  }

  form.addEventListener('click', async event => {
    const pillBtn = event.target?.closest?.('[data-care-pill]');
    if (pillBtn) {
      form.elements.channel.value = pillBtn.dataset.carePill;
      sourceChanged();
      return;
    }
    const pasteBtn = event.target?.closest?.('[data-care-paste]');
    if (pasteBtn) {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        try {
          const clip = (await navigator.clipboard.readText()).trim();
          if (clip && form.elements.externalOrderNumber) {
            form.elements.externalOrderNumber.value = clip.slice(0, 100);
            const oldLabel = pasteBtn.textContent;
            pasteBtn.textContent = '✓ Đã dán';
            setTimeout(() => { pasteBtn.textContent = oldLabel; }, 1600);
            return;
          }
        } catch {}
      }
      form.elements.externalOrderNumber?.focus?.();
      feedback.textContent = 'Nhấn giữ vào ô mã đơn hàng rồi chọn Dán.';
      return;
    }
    const removeChip = event.target?.closest?.('[data-care-remove-file]');
    if (removeChip) {
      const idx = Number(removeChip.dataset.careRemoveFile);
      if (idx >= 0 && idx < selectedFiles.length) {
        selectedFiles.splice(idx, 1);
        renderSelectedFiles();
      }
    }
  });

  async function uploadInitialAttachment(careId, file, csrfToken) {
    const buildFd = () => {
      const fd = new FormData();
      if (typeof fd.append === 'function') fd.append('file', file);
      return fd;
    };
    let res = await fetch('/api/customer/care/' + encodeURIComponent(careId) + '/files', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
      body: buildFd(),
      credentials: 'same-origin'
    });
    let data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      const fallbackRes = await fetch('/api/customer/care/' + encodeURIComponent(careId) + '/attachments', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
        body: buildFd(),
        credentials: 'same-origin'
      });
      if (fallbackRes.status !== 404) {
        res = fallbackRes;
        data = await res.json().catch(() => ({}));
      }
    }
    if (!res.ok) throw Error(data.error || 'Không thể tải tệp đính kèm lên.');
    return data;
  }

  async function orders() {
    const data = await api('/api/customer/orders?page=' + orderPage);
    for (const order of data.orders) {
      const option = document.createElement('option');
      option.value = order.id;
      option.textContent = order.orderNumber;
      form.elements.orderId.append(option);
    }
    document.querySelector('#care-more-orders').hidden = data.orders.length < 20;
    if (form.elements.orderId.options.length === 1) {
      feedback.textContent = 'Chưa có đơn hàng trong tài khoản. Bạn có thể chọn Shopee, TikTok hoặc Lazada bên trên để nhập mã đơn.';
    }
  }

  function replyFormHtml() {
    return '<form data-care-reply class="care-reply-form">' +
      '<label>Trả lời GAERU<textarea name="body" required maxlength="3000" rows="3" placeholder="Nhập nội dung phản hồi của bạn…"></textarea></label>' +
      '<div class="care-reply-actions">' +
        '<label class="care-attach-btn">' +
          '<input type="file" name="file" accept="image/*,video/*,application/pdf" class="w-sr-only" data-care-reply-file>' +
          '<span data-care-reply-file-label>📎 Đính kèm ảnh / video</span>' +
        '</label>' +
        '<button class="button button-blue" type="submit">Gửi trả lời</button>' +
      '</div>' +
    '</form>';
  }

  function caseHtml(r) {
    return `<article class="care-case" data-case="${escape(r.id)}" data-version="${r.version}">` +
      `<span class="care-status">${escape(labels[r.status] || r.status)}</span>` +
      `<h4>${escape(r.subject)}</h4>` +
      `<small>Đơn ${escape(r.orderNumber)} · ${escape(new Date(r.createdAt).toLocaleDateString('vi-VN'))}<br>Mã yêu cầu: ${escape(r.id)}</small>` +
      `<p>${escape(r.description)}</p>` +
      `<details data-conversation>` +
        `<summary>Xem hội thoại với GAERU</summary>` +
        `<button type="button" data-thread-more hidden>Xem tin nhắn trước</button>` +
        `<div class="care-messages" data-messages aria-live="polite"></div>` +
        `${r.response && r.status !== 'closed' ? replyFormHtml() : `<p data-thread-note>${r.status === 'closed' ? 'Yêu cầu đã đóng. Bạn có thể tạo yêu cầu mới.' : 'GAERU sẽ phản hồi tại đây. Bạn có thể trả lời sau khi nhận phản hồi.'}</p>`}` +
        `<p role="status" data-thread-status></p>` +
      `</details>` +
    `</article>`;
  }

  async function requests(live = false) {
    const current = page;
    const data = await api('/api/customer/care?page=' + current);
    if (current !== page || sending) return;
    const list = document.querySelector('#care-requests');
    if (!live) {
      list.innerHTML = data.requests.map(caseHtml).join('') || '<p>Chưa có yêu cầu ở trang này.</p>';
    } else {
      for (const r of data.requests) {
        let article = list.querySelector('[data-case="' + r.id + '"]');
        if (!article) {
          if (!list.querySelector('[data-case]')) list.innerHTML = '';
          list.insertAdjacentHTML('afterbegin', caseHtml(r));
          continue;
        }
        article.querySelector('.care-status').textContent = labels[r.status] || r.status;
        const details = article.querySelector('[data-conversation]');
        if (details.open && (Number(article.dataset.version) !== r.version || article.dataset.moreNew === 'true')) {
          await thread(article, null, true);
        } else if (!details.open) {
          updateReply(article, { canReply: Boolean(r.response) && r.status !== 'closed', status: r.status });
        }
      }
    }
    document.querySelector('#care-prev').disabled = page === 1;
    document.querySelector('#care-next').disabled = data.requests.length < 20;
    document.querySelector('#care-page').textContent = 'Trang ' + page;
  }

  function updateReply(article, state) {
    const note = article.querySelector('[data-thread-note]');
    if (state.canReply && note) note.remove();
    let reply = article.querySelector('[data-care-reply]');
    if (state.canReply && !reply) {
      article.querySelector('[data-thread-status]').insertAdjacentHTML('beforebegin', replyFormHtml());
      reply = article.querySelector('[data-care-reply]');
    }
    if (reply) {
      reply.elements.body.disabled = !state.canReply;
      reply.querySelector('button[type="submit"], button').disabled = !state.canReply;
      if (reply.elements.file) reply.elements.file.disabled = !state.canReply;
    }
    if (state.status === 'closed') article.querySelector('[data-thread-status]').textContent = 'Yêu cầu đã đóng. Bạn có thể tạo yêu cầu mới.';
  }

  async function thread(article, before, live = false) {
    const target = article.querySelector('[data-messages]'), last = target.dataset.lastMessage;
    const after = live && last;
    const data = await api('/api/customer/care/' + article.dataset.case + '/messages' + (before ? '?before=' + encodeURIComponent(before) : after ? '?after=' + encodeURIComponent(last) : ''));
    if (!article.isConnected || sending) return;
    window.GAERUCareLive.merge(target, data.messages, m => {
      let fileHtml = '';
      if (m.file) {
        const isImg = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(m.file.mime);
        const isVideo = ['video/mp4', 'video/quicktime', 'video/webm'].includes(m.file.mime);
        const fileUrl = '/api/customer/care/' + article.dataset.case + '/files/' + m.file.id;
        if (isImg) fileHtml = '<div class="care-file-preview"><a href="' + fileUrl + '" target="_blank" rel="noopener noreferrer"><img src="' + fileUrl + '" alt="' + escape(m.file.name) + '" class="care-msg-img"></a><small>' + escape(m.file.name) + '</small></div>';
        else if (isVideo) fileHtml = '<div class="care-file-preview"><video controls src="' + fileUrl + '" class="care-msg-video"></video><small>' + escape(m.file.name) + '</small></div>';
        else fileHtml = '<div class="care-file-preview"><a href="' + fileUrl + '?download=1" class="care-file-link" download="' + escape(m.file.name) + '">📎 ' + escape(m.file.name) + ' (' + Math.round((m.file.size || 0) / 1024) + ' KB)</a></div>';
      }
      return `<div data-message-id="${escape(m.id)}" class="care-message care-message-${m.sender}"><strong>${m.sender === 'staff' ? 'GAERU' : 'Bạn'}</strong><p>${escape(m.body)}</p>${fileHtml}<small>${escape(new Date(m.createdAt).toLocaleString('vi-VN'))}</small></div>`;
    }, { before: Boolean(before), reset: !before && !after });
    if (!before) {
      article.dataset.version = data.thread.version;
      article.dataset.moreNew = String(Boolean(after && data.hasMore));
      article.querySelector('.care-status').textContent = labels[data.thread.status];
      updateReply(article, data.thread);
    }
    if (!after) {
      const more = article.querySelector('[data-thread-more]');
      more.hidden = !data.hasMore;
      more.dataset.before = data.messages[0]?.id || '';
    }
  }

  const requestsRoot = document.querySelector('#care-requests');
  requestsRoot.addEventListener('toggle', async e => {
    const details = e.target;
    if (!details.matches('[data-conversation]') || !details.open) return;
    try {
      await thread(details.closest('[data-case]'), null, Boolean(details.querySelector('[data-messages]').dataset.lastMessage));
      details.dataset.loaded = 'true';
    } catch (error) {
      details.querySelector('[data-thread-status]').textContent = error.message;
    }
  }, true);

  requestsRoot.addEventListener('change', e => {
    const fileInput = e.target?.closest?.('[data-care-reply-file]');
    if (!fileInput) return;
    const lbl = fileInput.parentElement?.querySelector?.('[data-care-reply-file-label]');
    if (!lbl) return;
    const picked = fileInput.files?.[0];
    lbl.textContent = picked ? ('📎 ' + picked.name) : '📎 Đính kèm ảnh / video';
  });

  requestsRoot.addEventListener('click', async e => {
    const button = e.target.closest('[data-thread-more]');
    if (!button) return;
    button.disabled = true;
    try {
      await thread(button.closest('[data-case]'), button.dataset.before);
    } catch (error) {
      button.closest('[data-case]').querySelector('[data-thread-status]').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  requestsRoot.addEventListener('submit', async e => {
    if (!e.target.matches('[data-care-reply]')) return;
    e.preventDefault();
    const reply = e.target, article = reply.closest('[data-case]'), button = reply.querySelector('button[type="submit"], button'), threadStatus = article.querySelector('[data-thread-status]');
    button.disabled = true;
    sending = true;
    try {
      const file = reply.elements.file?.files?.[0];
      if (file) {
        const csrfRes = await fetch('/api/csrf', { credentials: 'same-origin', cache: 'no-store' });
        if (!csrfRes.ok) throw Error('Không thể khởi tạo phiên. Hãy tải lại trang.');
        const csrfToken = (await csrfRes.json()).csrfToken || '';
        const fd = new FormData();
        fd.append('file', file);
        if (reply.elements.body.value.trim()) fd.append('body', reply.elements.body.value.trim());
        const res = await fetch('/api/customer/care/' + article.dataset.case + '/files', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken }, body: fd, credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Error(data.error || 'Không thể tải tệp lên.');
      } else {
        await api('/api/customer/care/' + article.dataset.case + '/messages', { method: 'POST', body: JSON.stringify({ body: reply.elements.body.value, version: Number(article.dataset.version) }) });
      }
      article.dataset.version = Number(article.dataset.version) + 1;
      article.querySelector('.care-status').textContent = labels.reviewing;
      reply.reset();
      const lbl = reply.querySelector?.('[data-care-reply-file-label]');
      if (lbl) lbl.textContent = '📎 Đính kèm ảnh / video';
      sending = false;
      await thread(article, null, true);
      threadStatus.textContent = 'Đã gửi trả lời.';
    } catch (error) {
      threadStatus.textContent = error.message;
    } finally {
      sending = false;
      button.disabled = reply.elements.body.disabled;
      livePoll?.refresh();
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    feedback.textContent = 'Đang gửi yêu cầu…';
    try {
      const entries = [];
      for (const pair of new FormData(form)) {
        if (Array.isArray(pair) && typeof pair[1] === 'string') entries.push(pair);
      }
      const body = Object.fromEntries(entries);
      const serialized = JSON.stringify(body);
      if (serialized !== pendingBody) {
        pendingKey = newRequestKey();
        pendingBody = serialized;
      }
      const result = await api('/api/customer/care', { method: 'POST', body: JSON.stringify({ ...body, requestKey: pendingKey }) });
      let attachmentNote = '';
      if (selectedFiles.length > 0 && result?.request?.id) {
        feedback.textContent = 'Đã tạo yêu cầu, đang tải ' + selectedFiles.length + ' tệp đính kèm…';
        try {
          const csrfRes = await fetch('/api/csrf', { credentials: 'same-origin', cache: 'no-store' });
          if (!csrfRes.ok) throw Error('Không thể khởi tạo phiên tải tệp.');
          const csrfToken = (await csrfRes.json()).csrfToken || '';
          let uploadedCount = 0;
          const failedReasons = [];
          for (let i = 0; i < selectedFiles.length; i++) {
            const file = selectedFiles[i];
            try {
              await uploadInitialAttachment(result.request.id, file, csrfToken);
              uploadedCount++;
            } catch (err) {
              failedReasons.push(file.name + ': ' + (err?.message || 'lỗi tải tệp'));
            }
          }
          if (uploadedCount > 0) attachmentNote += ' Đã đính kèm ' + uploadedCount + ' tệp.';
          if (failedReasons.length > 0) attachmentNote += ' Chưa tải được: ' + failedReasons.join('; ') + ' (bạn có thể gửi bổ sung trong hội thoại yêu cầu vừa tạo).';
        } catch (uploadErr) {
          attachmentNote += ' (' + (uploadErr?.message || 'Chưa tải được tệp đính kèm') + ')';
        }
        selectedFiles = [];
        renderSelectedFiles();
      }
      feedback.textContent = '✓ Đã lưu yêu cầu ' + result.request.id + '.' + attachmentNote + ' GAERU sẽ kiểm tra và phản hồi sớm nhất.';
      form.elements.subject.value = '';
      form.elements.description.value = '';
      if (form.elements.externalOrderNumber) form.elements.externalOrderNumber.value = '';
      pendingKey = null;
      pendingBody = null;
      page = 1;
      try { await requests(); } catch { feedback.textContent += ' Chưa tải lại được danh sách. Bạn có thể bấm Tải lại.'; }
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector('#care-more-orders').addEventListener('click', async e => {
    e.target.disabled = true;
    try { orderPage++; await orders(); } catch (error) { orderPage--; feedback.textContent = error.message; } finally { e.target.disabled = false; }
  });

  for (const [id, delta] of [['care-prev', -1], ['care-next', 1], ['care-refresh', 0]]) {
    document.getElementById(id).addEventListener('click', async e => {
      e.target.disabled = true;
      const previous = page;
      let failed=false;
      try {
        page = Math.max(1, page + delta);
        await requests();
      } catch (error) {
        failed=true;
        page = previous;
        feedback.textContent = error.message;
      } finally {
        if (id === 'care-refresh' || sending || failed) e.target.disabled = false;
      }
    });
  }

  (async () => {
    try {
      const session = await api('/api/customer-auth/me');
      if (!session.authenticated) {
        status.classList?.remove?.('is-authed');
        status.classList?.add?.('is-guest');
        status.innerHTML = '<span>Đăng nhập tài khoản để gửi yêu cầu và theo dõi phản hồi ·</span><a class="w-login-cta" href="/tai-khoan">Đăng nhập</a><span>ngay tại đây</span>';
        return;
      }
      status.classList?.remove?.('is-guest');
      status.classList?.add?.('is-authed');
      status.textContent = '✓ Xin chào ' + session.customer.fullName + ' · Bạn có thể gửi yêu cầu hoặc xem phản hồi bên dưới';
      document.querySelector('#care-workspace').hidden = false;
      const indicator = document.createElement('p');
      indicator.className = 'care-sync-error';
      indicator.hidden = true;
      indicator.setAttribute('role', 'status');
      indicator.textContent = '';
      document.querySelector('#care-requests').before(indicator);
      const emailPref = document.querySelector('#care-notify-email');
      if (emailPref) {
        try {
          const prefData = await api('/api/customer/care/notification-preferences');
          emailPref.checked = prefData.notifyOnResponse;
        } catch (_) {}
        emailPref.addEventListener('change', async () => {
          const nextVal = emailPref.checked;
          emailPref.disabled = true;
          try {
            await api('/api/customer/care/notification-preferences', { method: 'PUT', body: JSON.stringify({ notifyOnResponse: nextVal }) });
            window.GAERUNotify?.success?.(nextVal ? 'Đã bật thông báo email khi GAERU phản hồi.' : 'Đã tắt thông báo email.');
          } catch (err) {
            emailPref.checked = !nextVal;
            const msg = err?.message || 'Chưa lưu được tùy chọn nhận email. Vui lòng thử lại.';
            feedback.textContent = msg;
            window.GAERUNotify?.error?.(msg);
          } finally {
            emailPref.disabled = false;
          }
        });
      }
      livePoll = window.GAERUCareLive.poll({
        run: () => requests(true),
        active: () => !sending && !document.querySelector('#care-workspace').hidden,
        status: text => {
          const healthy = /^(Tự cập nhật|Thời gian thực)/.test(text);
          indicator.hidden = healthy;
          if (!healthy && indicator.textContent !== text) indicator.textContent = text;
        }
      });
      window.addEventListener('pagehide', e => { if (!e.persisted) livePoll.stop(); });
      window.addEventListener('pageshow', () => livePoll.refresh());
      await Promise.allSettled([
        orders().catch(error => feedback.textContent = error.message),
        requests().catch(() => { indicator.hidden = false; indicator.textContent = 'Chưa cập nhật được. Đang tự kết nối lại…'; })
      ]);
    } catch {
      status.textContent = 'Chưa tải được tài khoản. Bạn có thể tải lại trang hoặc liên hệ trực tiếp với GAERU.';
    }
  })();
})();
