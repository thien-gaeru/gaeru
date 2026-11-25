(() => {
  const admin = window.GAERUAdmin, root = document.querySelector('#warranty-view');
  let rows = [], page = 1, q = '', filter = 'all';
  const opened = new Set();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const labels = { pending: 'Chờ đối chiếu', active: 'Đã kích hoạt', rejected: 'Không duyệt', revoked: 'Đã thu hồi' };
  const channels = { website: 'Website GAERU', shopee: 'Shopee', tiktok: 'TikTok Shop', lazada: 'Lazada' };
  const reasons = {
    active: [
      'Đã đối chiếu mã đơn, chứng từ và ngày mua hợp lệ.',
      'Đã xác nhận sản phẩm và người mua theo dữ liệu đối soát.'
    ],
    rejected: [
      'Yêu cầu rác / thông tin người mua không có thật.',
      'Số điện thoại hoặc thông tin liên hệ không hợp lệ.',
      'Chưa cung cấp đủ chứng từ mua hàng.',
      'Mã đơn hoặc thông tin sản phẩm không khớp.',
      'Ngày mua không khớp chứng từ đã cung cấp.',
      'Sản phẩm không thuộc phạm vi bảo hành GAERU.'
    ],
    revoked: [
      'Đơn hàng đã hoàn trả hoặc hủy theo đối soát.',
      'Hồ sơ kích hoạt có thông tin sai cần thu hồi.'
    ]
  };
  const presets = status => (reasons[status] || []).map(v => '<option value="' + escape(v) + '">' + escape(v) + '</option>').join('');

  function card(w, today) {
    const editable = admin.can('warranty.approve') && (w.status === 'active' || (w.status === 'pending' && !w.automatic));
    const action = w.status === 'active' ? 'revoked' : 'active';
    const isSpam = Boolean(w.isSpam);
    const spamMsg = Array.isArray(w.spamReasons) && w.spamReasons.length ? w.spamReasons.join(' · ') : 'Thông tin đăng ký có dấu hiệu rác / không hợp lệ';

    return '<article class="warranty-product">' +
      '<header>' +
        '<h3>' + escape(w.productName) + (w.variantName ? ' · ' + escape(w.variantName) : '') + '</h3>' +
        '<span class="warranty-state">' + escape(w.automatic && w.status === 'pending' ? 'Chờ đơn hoàn tất và thanh toán' : labels[w.status]) + (w.status === 'active' && w.expiresOn <= today ? ' · Hết hạn' : '') + '</span>' +
      '</header>' +
      (isSpam ? '<div class="warranty-spam-alert"><strong>⚠️ Nghi vấn yêu cầu rác:</strong> ' + escape(spamMsg) + '</div>' : '') +
      '<dl class="warranty-facts">' +
        '<div><dt>Serial</dt><dd>' + escape(w.serial || 'Chưa khai báo') + '</dd></div>' +
        '<div><dt>Ngày mua khách cung cấp</dt><dd>' + escape(w.claimedPurchaseDate || 'Chưa cung cấp') + '</dd></div>' +
        '<div><dt>Ngày mua đã xác nhận</dt><dd>' + escape(w.purchaseDate || 'Chưa xác nhận') + '</dd></div>' +
        '<div><dt>Hạn bảo hành</dt><dd>' + escape(w.expiresOn || 'Chưa kích hoạt') + '</dd></div>' +
      '</dl>' +
      (w.emailStatus ? '<p class="warranty-note">Email kích hoạt: ' + escape(({ pending: 'Chờ gửi', sending: 'Đang gửi', sent: 'SMTP đã tiếp nhận', failed: 'Chưa gửi được', unknown: 'Chưa xác định kết quả', skipped: 'Chưa gửi · kiểm tra email hoặc hiệu lực hồ sơ' })[w.emailStatus] || w.emailStatus) + '</p>' : '') +
      (w.reason ? '<p class="warranty-note">' + escape(w.reason) + '</p>' : '') +
      '<small>Mã hồ sơ: ' + escape(w.id) + '</small>' +
      (editable && action === 'active' ?
        '<div class="warranty-quick-bar">' +
          (!isSpam ? '<button type="button" class="primary-button warranty-quick-btn" data-w-quick-approve="' + escape(w.id) + '" data-w-date="' + escape(w.claimedPurchaseDate || w.purchaseDate || today) + '">✓ Duyệt nhanh 1 chạm</button>' : '') +
          (isSpam ? '<button type="button" class="secondary-button warranty-quick-btn is-danger" data-w-quick-reject="' + escape(w.id) + '">✕ Không duyệt (Rác)</button>' : '') +
        '</div>' : '') +
      (!w.automatic && ['pending', 'rejected'].includes(w.status) && admin.can('warranty.approve') ?
        '<div class="warranty-request-actions"><button class="' + (isSpam ? 'secondary-button is-danger' : 'secondary-button') + '" type="button" data-w-admin-delete="' + escape(w.id) + '">' + (isSpam ? '🗑️ Xóa yêu cầu rác' : 'Xóa yêu cầu chưa xác nhận') + '</button></div><div data-w-admin-confirm="' + escape(w.id) + '"></div>' : '') +
      (editable ?
        '<details class="warranty-manual-disclosure"><summary>Đối chiếu thủ công &amp; ghi lý do</summary>' +
        '<form data-w-id="' + escape(w.id) + '" class="warranty-review">' +
          '<div class="warranty-review-grid">' +
            '<label>Thao tác<select name="status">' +
              (action === 'active' ? '<option value="active">Xác nhận kích hoạt</option><option value="rejected"' + (isSpam ? ' selected' : '') + '>Không duyệt</option>' : '<option value="revoked">Thu hồi kích hoạt</option>') +
            '</select></label>' +
            (action === 'active' ? '<label data-purchase-field' + (isSpam ? ' hidden' : '') + '>Ngày mua đã đối chiếu<input type="date" name="purchaseDate" min="2000-01-01" max="' + escape(today) + '" value="' + escape(w.claimedPurchaseDate || w.purchaseDate || '') + '"' + (isSpam ? ' disabled' : ' required') + '></label>' : '') +
          '</div>' +
          '<label>Lý do có sẵn<select name="reasonPreset"><option value="">Chọn lý do hoặc nhập nội dung riêng</option>' + presets(isSpam ? 'rejected' : action) + '</select></label>' +
          '<label>Lý do / kết quả đối chiếu<textarea name="reason" minlength="5" maxlength="1000" rows="2" required>' + (isSpam ? escape(spamMsg) : '') + '</textarea></label>' +
          '<label class="warranty-consent"><input type="checkbox" required> Tôi đã đối chiếu và xác nhận thông tin</label>' +
          '<div class="warranty-review-actions"><button class="primary-button">Lưu xác nhận</button><p role="status" aria-live="polite"></p></div>' +
        '</form></details>' : '') +
    '</article>';
  }

  async function load() {
    if (!admin.can('orders.read')) return;
    const url = '/api/gaeru_ceo/warranties?page=' + page + '&q=' + encodeURIComponent(q) + (filter !== 'all' ? '&filter=' + encodeURIComponent(filter) : '');
    const data = await admin.request(url);
    rows = data.activations || [];
    const counts = data.counts || {
      total: rows.length,
      active: rows.filter(r => r.status === 'active').length,
      pending: rows.filter(r => r.status === 'pending').length,
      spam: rows.filter(r => r.isSpam).length
    };
    const navBadge = document.querySelector('[data-warranty-nav-badge]');
    if (navBadge) {
      const pendingNum = Number(counts.pending || 0);
      navBadge.textContent = pendingNum > 99 ? '99+' : String(pendingNum);
      navBadge.hidden = pendingNum <= 0;
    }
    const overviewBadge = document.querySelector('#pending-warranty-count');
    if (overviewBadge && !q && filter === 'all') {
      overviewBadge.textContent = String(Number(counts.pending || 0));
    }

    const groups = new Map();
    for (const w of rows) {
      const key = w.orderKey || w.channel + ':' + w.orderNumber;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(w);
    }

    const emptyMessages = {
      spam: 'Không phát hiện yêu cầu rác nào. Hệ thống sạch.',
      pending: 'Không có yêu cầu bảo hành nào đang chờ duyệt.',
      active: 'Chưa có hồ sơ bảo hành nào được kích hoạt.'
    };
    const emptyText = emptyMessages[filter] || 'Chưa có hồ sơ phù hợp.';

    const deletableSpam = rows.filter(r => r.isSpam && !r.automatic && ['pending', 'rejected'].includes(r.status));
    const spamBulkBar = (filter === 'spam' && deletableSpam.length > 0 && admin.can('warranty.approve'))
      ? '<div class="warranty-bulk-spam-bar"><span>Phát hiện <strong>' + deletableSpam.length + '</strong> yêu cầu rác trên trang này có thể xóa sạch.</span><button type="button" class="secondary-button is-danger" data-w-bulk-delete-spam>🗑️ Dọn sạch ' + deletableSpam.length + ' yêu cầu rác</button></div>'
      : '';

    root.innerHTML =
      '<form data-warranty-search class="warranty-search">' +
        '<label>Tìm kiếm hồ sơ<input name="q" maxlength="100" value="' + escape(q) + '" placeholder="Mã đơn, sản phẩm, khách hàng, số điện thoại, serial…"></label>' +
        '<button class="primary-button">Tìm kiếm</button>' +
        '<button class="secondary-button" type="button" data-warranty-clear>Xóa tìm kiếm</button>' +
      '</form>' +
      '<div class="warranty-filter-tabs" role="tablist">' +
        '<button type="button" role="tab" aria-selected="' + (filter === 'all') + '" class="warranty-tab ' + (filter === 'all' ? 'active' : '') + '" data-warranty-filter="all">Tất cả <span class="warranty-tab-count">' + counts.total + '</span></button>' +
        '<button type="button" role="tab" aria-selected="' + (filter === 'active') + '" class="warranty-tab ' + (filter === 'active' ? 'active' : '') + '" data-warranty-filter="active">Đã duyệt <span class="warranty-tab-count is-active">' + counts.active + '</span></button>' +
        '<button type="button" role="tab" aria-selected="' + (filter === 'pending') + '" class="warranty-tab ' + (filter === 'pending' ? 'active' : '') + '" data-warranty-filter="pending">Chưa duyệt <span class="warranty-tab-count is-pending">' + counts.pending + '</span></button>' +
        '<button type="button" role="tab" aria-selected="' + (filter === 'spam') + '" class="warranty-tab is-spam ' + (filter === 'spam' ? 'active' : '') + '" data-warranty-filter="spam">⚠️ Yêu cầu rác <span class="warranty-tab-count is-spam">' + counts.spam + '</span></button>' +
      '</div>' +
      spamBulkBar +
      '<p class="warranty-intro">Đơn website tự kích hoạt khi hoàn tất và thanh toán đủ. Chỉ đối chiếu thủ công các đơn ngoài hệ thống; thời hạn 12 tháng tính từ ngày mua đã xác nhận.</p>' +
      '<div class="warranty-orders">' +
        ([...groups].map(([key, items]) => {
          const w = items[0];
          const pending = items.filter(i => i.status === 'pending' && !i.automatic).length;
          const hasSpam = items.some(i => i.isSpam);
          return '<details class="warranty-order" data-order-key="' + escape(key) + '" ' + (opened.has(key) ? 'open' : '') + '>' +
            '<summary>' +
              '<span><strong>Đơn ' + escape(w.orderNumber || 'Chưa có mã') + (hasSpam ? '<span class="warranty-spam-tag">⚠️ Nghi vấn rác</span>' : '') + '</strong>' +
              '<small>' + escape(channels[w.channel] || w.channel) + ' · ' + escape(w.customerName || w.contactName || 'Khách vãng lai') + '</small></span>' +
              '<span class="warranty-order-count">' + items.length + ' sản phẩm' + (pending ? ' · ' + pending + ' chờ đối chiếu' : '') + '</span>' +
            '</summary>' +
            '<div class="warranty-order-body">' +
              '<p class="warranty-contact">Liên hệ: ' + escape(w.contactPhone || 'Chưa có') + (w.contactEmail ? ' · ' + escape(w.contactEmail) : '') + '<br>Địa chỉ: ' + escape([w.contactAddress, w.contactCity].filter(Boolean).join(' · ') || 'Chưa bổ sung') + '</p>' +
              items.map(w => card(w, data.today)).join('') +
            '</div>' +
          '</details>';
        }).join('') || '<div class="warranty-empty">' + emptyText + '</div>') +
      '</div>' +
      '<div class="warranty-pagination">' +
        '<button class="secondary-button" data-page="-1" ' + (page === 1 ? 'disabled' : '') + '>Trước</button>' +
        '<span>Trang ' + page + '</span>' +
        '<button class="secondary-button" data-page="1" ' + (data.pagination?.hasNext ? '' : 'disabled') + '>Tiếp</button>' +
      '</div>';
  }

  root.addEventListener('toggle', e => {
    if (!e.target.matches('.warranty-order') || !root.contains(e.target)) return;
    e.target.open ? opened.add(e.target.dataset.orderKey) : opened.delete(e.target.dataset.orderKey);
  }, true);

  root.addEventListener('change', e => {
    const form = e.target.closest('[data-w-id]');
    if (!form) return;
    if (e.target.name === 'reasonPreset' && e.target.value) form.elements.reason.value = e.target.value;
    if (e.target.name === 'status') {
      if (form.elements.reasonPreset.value && form.elements.reason.value === form.elements.reasonPreset.value) form.elements.reason.value = '';
      form.elements.reasonPreset.innerHTML = '<option value="">Chọn lý do hoặc nhập nội dung riêng</option>' + presets(e.target.value);
      const input = form.elements.purchaseDate, field = form.querySelector('[data-purchase-field]');
      if (input) {
        input.disabled = e.target.value !== 'active';
        input.required = e.target.value === 'active';
        if (field) field.hidden = input.disabled;
      }
    }
  });

  root.addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    if (form.matches('[data-warranty-search]')) {
      q = form.elements.q.value.trim();
      page = 1;
      opened.clear();
      try { await load(); } catch (error) { admin.showGlobal(error.message, true); }
      return;
    }
    const w = rows.find(w => w.id === form.dataset.wId);
    if (!w || form.dataset.saving) return;
    if (!form.reportValidity()) return;
    const button = form.querySelector('button');
    form.dataset.saving = 'true';
    if (admin.setButtonBusy) admin.setButtonBusy(button, true, 'Đang cập nhật…'); else button.disabled = true;
    try {
      const status = form.elements.status.value;
      const body = { status, reason: form.elements.reason.value, version: w.version, ...(status === 'active' ? { purchaseDate: form.elements.purchaseDate.value } : {}) };
      await admin.request('/api/gaeru_ceo/warranties/' + w.id, { method: 'PATCH', body: JSON.stringify(body) });
      await load();
      admin.showGlobal('Đã cập nhật hồ sơ bảo hành.');
    } catch (error) {
      form.querySelector('[role=status]').textContent = error.message;
      admin.showGlobal(error.message, true);
      if (admin.setButtonBusy) admin.setButtonBusy(button, false); else button.disabled = false;
    } finally {
      delete form.dataset.saving;
    }
  });

  root.addEventListener('click', async e => {
    const tab = e.target.closest('[data-warranty-filter]');
    if (tab) {
      const nextFilter = tab.dataset.warrantyFilter;
      if (nextFilter !== filter) {
        filter = nextFilter;
        page = 1;
        opened.clear();
        try { await load(); } catch (error) { admin.showGlobal(error.message, true); }
      }
      return;
    }

    const quickApprove = e.target.closest('[data-w-quick-approve]');
    if (quickApprove) {
      if (quickApprove.dataset.busy === 'true') return;
      const w = rows.find(item => item.id === quickApprove.dataset.wQuickApprove);
      if (!w) return;
      quickApprove.dataset.busy = 'true';
      const purchaseDate = quickApprove.dataset.wDate || w.claimedPurchaseDate || w.purchaseDate || new Date().toISOString().slice(0, 10);
      const ok = window.GAERUNotify?.confirm
        ? await window.GAERUNotify.confirm('Kích hoạt bảo hành 12 tháng cho ' + (w.productName || 'sản phẩm') + ' (ngày mua: ' + purchaseDate + ')?', { title: 'Duyệt nhanh bảo hành', confirmText: 'Xác nhận kích hoạt' })
        : true;
      if (!ok) { delete quickApprove.dataset.busy; return; }
      if (admin.setButtonBusy) admin.setButtonBusy(quickApprove, true, 'Đang duyệt…'); else quickApprove.disabled = true;
      try {
        await admin.request('/api/gaeru_ceo/warranties/' + w.id, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'active', purchaseDate, reason: 'Đã đối chiếu mã đơn, chứng từ và ngày mua hợp lệ.', version: w.version })
        });
        await load();
        admin.showGlobal('Đã duyệt nhanh và kích hoạt bảo hành thành công.');
      } catch (error) {
        admin.showGlobal(error.message, true);
        if (admin.setButtonBusy) admin.setButtonBusy(quickApprove, false); else quickApprove.disabled = false;
      } finally {
        delete quickApprove.dataset.busy;
      }
      return;
    }

    const quickReject = e.target.closest('[data-w-quick-reject]');
    if (quickReject) {
      if (quickReject.dataset.busy === 'true') return;
      const w = rows.find(item => item.id === quickReject.dataset.wQuickReject);
      if (!w) return;
      quickReject.dataset.busy = 'true';
      const reasonText = Array.isArray(w.spamReasons) && w.spamReasons.length ? w.spamReasons.join(' · ') : 'Yêu cầu rác / thông tin người mua không có thật.';
      if (admin.setButtonBusy) admin.setButtonBusy(quickReject, true, 'Đang từ chối…'); else quickReject.disabled = true;
      try {
        await admin.request('/api/gaeru_ceo/warranties/' + w.id, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'rejected', reason: reasonText, version: w.version })
        });
        await load();
        admin.showGlobal('Đã từ chối yêu cầu bảo hành nghi vấn rác.');
      } catch (error) {
        admin.showGlobal(error.message, true);
        if (admin.setButtonBusy) admin.setButtonBusy(quickReject, false); else quickReject.disabled = false;
      } finally {
        delete quickReject.dataset.busy;
      }
      return;
    }

    const bulkSpam = e.target.closest('[data-w-bulk-delete-spam]');
    if (bulkSpam) {
      if (bulkSpam.dataset.busy === 'true') return;
      const targets = rows.filter(r => r.isSpam && !r.automatic && ['pending', 'rejected'].includes(r.status));
      if (!targets.length) return;
      bulkSpam.dataset.busy = 'true';
      try {
        const ok = window.GAERUNotify?.confirm
          ? await window.GAERUNotify.confirm('Xóa sạch ' + targets.length + ' yêu cầu rác trên trang này? Lịch sử thao tác vẫn được lưu trong nhật ký hệ thống.', { title: 'Dọn sạch yêu cầu rác', confirmText: 'Xóa ' + targets.length + ' yêu cầu', danger: true })
          : false;
        if (!ok) return;
        if (admin.setButtonBusy) admin.setButtonBusy(bulkSpam, true, 'Đang dọn sạch…'); else { bulkSpam.disabled = true; bulkSpam.textContent = 'Đang dọn sạch…'; }
        let deletedCount = 0;
        for (const w of targets) {
          try {
            await admin.request('/api/gaeru_ceo/warranties/' + w.id, {
              method: 'DELETE',
              body: JSON.stringify({ version: w.version, confirmation: 'DELETE_WARRANTY_REQUEST' })
            });
            deletedCount++;
          } catch (_) {}
        }
        await load();
        admin.showGlobal('Đã dọn sạch ' + deletedCount + ' / ' + targets.length + ' yêu cầu rác.');
      } catch (error) {
        admin.showGlobal(error.message, true);
      } finally {
        delete bulkSpam.dataset.busy;
        if (bulkSpam.isConnected) {
          if (admin.setButtonBusy) admin.setButtonBusy(bulkSpam, false); else bulkSpam.disabled = false;
        }
      }
      return;
    }

    const remove = e.target.closest('[data-w-admin-delete]'), confirm = e.target.closest('[data-w-admin-delete-yes]');
    if (remove) {
      root.querySelector('[data-w-admin-confirm="' + remove.dataset.wAdminDelete + '"]').innerHTML =
        '<p>Chỉ xóa hồ sơ chưa được kích hoạt; lịch sử thao tác vẫn được lưu.</p><button class="secondary-button" type="button" data-w-admin-delete-yes="' + escape(remove.dataset.wAdminDelete) + '">Xác nhận xóa yêu cầu</button>';
      return;
    }
    if (confirm) {
      if (confirm.dataset.busy === 'true') return;
      const w = rows.find(w => w.id === confirm.dataset.wAdminDeleteYes);
      if (!w) return;
      if (admin.setButtonBusy) admin.setButtonBusy(confirm, true, 'Đang xóa…'); else confirm.disabled = true;
      try {
        const r = await admin.request('/api/gaeru_ceo/warranties/' + w.id, { method: 'DELETE', body: JSON.stringify({ version: w.version, confirmation: 'DELETE_WARRANTY_REQUEST' }) });
        await load();
        admin.showGlobal(r.message);
      } catch (error) {
        admin.showGlobal(error.message, true);
        if (admin.setButtonBusy) admin.setButtonBusy(confirm, false); else confirm.disabled = false;
      }
      return;
    }

    const b = e.target.closest('[data-page],[data-warranty-clear]');
    if (!b) return;
    b.disabled = true;
    const previous = page;
    try {
      if (b.hasAttribute('data-warranty-clear')) {
        q = '';
        page = 1;
      } else {
        page += Number(b.dataset.page);
      }
      opened.clear();
      await load();
    } catch (error) {
      page = previous;
      admin.showGlobal(error.message, true);
      b.disabled = false;
    }
  });

  window.GAERUWarranty = { load };
})();
