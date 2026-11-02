(()=>{
  const panel = document.getElementById('product-reviews-panel');
  if (!panel) return;

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const renderStars = r => '★'.repeat(Math.max(1, Math.min(5, Number(r) || 5))) + '☆'.repeat(Math.max(0, 5 - Math.max(1, Math.min(5, Number(r) || 5))));

  let currentStatus = 'all';
  let searchQuery = '';
  let currentPage = 1;
  let loadingVersion = 0;

  panel.innerHTML = `
    <div class="abandoned-metrics-grid review-metrics-grid" data-review-metrics>
      <div class="metric-card"><span>Tổng đánh giá</span><strong data-metric-total>0</strong></div>
      <div class="metric-card" style="border-color:#fef08a;background:#fefce8;"><span>Chờ duyệt</span><strong data-metric-pending style="color:#ca8a04;">0</strong></div>
      <div class="metric-card"><span>Đã duyệt</span><strong data-metric-approved style="color:#16a34a;">0</strong></div>
      <div class="metric-card"><span>Điểm trung bình</span><strong data-metric-rating style="color:#0284c7;">5.0 ★</strong></div>
    </div>
    <div class="toolbar" style="margin-bottom:16px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
      <div class="product-scope-tabs" role="group" aria-label="Lọc trạng thái đánh giá" data-review-status-tabs>
        <button type="button" data-review-status="all" aria-pressed="true">Tất cả</button>
        <button type="button" data-review-status="pending" aria-pressed="false">Chờ duyệt <span class="scope-badge" data-badge-pending hidden>0</span></button>
        <button type="button" data-review-status="approved" aria-pressed="false">Đã duyệt</button>
        <button type="button" data-review-status="rejected" aria-pressed="false">Từ chối</button>
      </div>
      <input type="search" id="review-search-input" placeholder="Tìm tên khách, email, nội dung, sản phẩm..." style="flex:1;min-width:240px;padding:8px 14px;border:1px solid #d2d2d7;border-radius:10px;">
      <button type="button" class="secondary-button" data-review-refresh>Làm mới</button>
    </div>
    <p class="list-status" data-review-list-status role="status"></p>
    <div class="orders-table-scroll" tabindex="0">
      <div class="order-table-head" style="grid-template-columns:140px 180px 180px 100px 1fr 180px;">
        <span>Thời gian</span>
        <span>Sản phẩm</span>
        <span>Khách hàng</span>
        <span>Đánh giá</span>
        <span>Nội dung nhận xét</span>
        <span>Thao tác</span>
      </div>
      <div class="order-list" data-review-list></div>
    </div>
  `;

  const metricsWrap = panel.querySelector('[data-review-metrics]');
  const listWrap = panel.querySelector('[data-review-list]');
  const statusNote = panel.querySelector('[data-review-list-status]');
  const searchInput = panel.querySelector('#review-search-input');
  const statusTabs = panel.querySelectorAll('[data-review-status]');

  async function loadReviews() {
    const v = ++loadingVersion;
    statusNote.textContent = 'Đang tải danh sách đánh giá…';
    try {
      const q = new URLSearchParams({
        status: currentStatus,
        search: searchQuery,
        page: String(currentPage),
        pageSize: '30'
      });
      const data = await window.GAERUAdmin.request(`/api/gaeru_ceo/product-reviews?${q.toString()}`);
      if (v !== loadingVersion) return;

      // Update metrics
      if (data.metrics) {
        metricsWrap.querySelector('[data-metric-total]').textContent = data.metrics.total;
        metricsWrap.querySelector('[data-metric-pending]').textContent = data.metrics.pending;
        metricsWrap.querySelector('[data-metric-approved]').textContent = data.metrics.approved;
        metricsWrap.querySelector('[data-metric-rating]').textContent = data.metrics.averageRating + ' ★';

        const pendingBadge = panel.querySelector('[data-badge-pending]');
        if (pendingBadge) {
          pendingBadge.hidden = data.metrics.pending === 0;
          pendingBadge.textContent = data.metrics.pending;
        }
        const topBadge = document.getElementById('review-pending-badge');
        if (topBadge) {
          topBadge.hidden = data.metrics.pending === 0;
          topBadge.textContent = data.metrics.pending;
        }
      }

      if (!data.reviews || !data.reviews.length) {
        listWrap.innerHTML = '<div style="padding:40px 20px;text-align:center;color:#6e6e73;">Không có đánh giá nào phù hợp với bộ lọc.</div>';
        statusNote.textContent = '';
        return;
      }

      statusNote.textContent = `Hiển thị ${data.reviews.length} đánh giá.`;

      listWrap.innerHTML = data.reviews.map(r => {
        const isPending = r.status === 'pending';
        const isApproved = r.status === 'approved';
        const isRejected = r.status === 'rejected';

        const statusTag = isPending
          ? '<span style="display:inline-block;padding:2px 8px;border-radius:12px;background:#fef08a;color:#854d0e;font-size:11px;font-weight:600;">Chờ duyệt</span>'
          : isApproved
            ? '<span style="display:inline-block;padding:2px 8px;border-radius:12px;background:#dcfce7;color:#166534;font-size:11px;font-weight:600;">Đã duyệt</span>'
            : '<span style="display:inline-block;padding:2px 8px;border-radius:12px;background:#fee2e2;color:#991b1b;font-size:11px;font-weight:600;">Từ chối</span>';

        const buyerBadge = r.is_verified_buyer
          ? '<span style="display:inline-block;padding:2px 8px;border-radius:12px;background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;font-size:11px;font-weight:600;margin-top:4px;">✓ Đã mua hàng</span>'
          : '<span style="display:inline-block;padding:2px 8px;border-radius:12px;background:#f3f4f6;color:#6b7280;font-size:11px;margin-top:4px;">Khách vãng lai</span>';

        const replyHtml = r.admin_reply
          ? `<div style="background:#f8fafc;border-left:3px solid #0071e3;padding:8px 12px;margin-top:8px;border-radius:0 8px 8px 0;font-size:12.5px;">
               <strong style="color:#0071e3;">GAERU Official:</strong> ${esc(r.admin_reply)}
             </div>`
          : '';

        return `
          <div class="order-row" style="grid-template-columns:140px 180px 180px 100px 1fr 180px;align-items:start;padding:14px;background:${isPending ? '#fffdf5' : '#fff'};border-bottom:1px solid #f0f0f2;">
            <div style="font-size:12.5px;color:#6e6e73;">
              <div>${new Date(r.created_at).toLocaleDateString('vi-VN')}</div>
              <small>${new Date(r.created_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</small>
              <div style="margin-top:6px;">${statusTag}</div>
            </div>
            <div style="font-size:13px;font-weight:500;">
              <div>${esc(r.product_name)}</div>
              ${r.order_number ? `<small style="color:#0071e3;">Đơn: ${esc(r.order_number)}</small>` : ''}
            </div>
            <div style="font-size:13px;">
              <strong>${esc(r.customer_name)}</strong>
              <div style="font-size:12px;color:#6e6e73;word-break:break-all;">${esc(r.customer_email)}</div>
              ${buyerBadge}
            </div>
            <div>
              <div style="color:#f59e0b;font-size:15px;letter-spacing:1px;">${renderStars(r.rating)}</div>
              <small style="color:#6e6e73;">${r.rating}/5 sao</small>
            </div>
            <div style="font-size:13.5px;line-height:1.5;">
              ${r.title ? `<strong style="display:block;margin-bottom:4px;color:#1d1d1f;">${esc(r.title)}</strong>` : ''}
              <div style="color:#374151;">${esc(r.comment)}</div>
              ${replyHtml}
              ${r.moderator_note ? `<small style="display:block;color:#dc2626;margin-top:4px;">Ghi chú từ chối: ${esc(r.moderator_note)}</small>` : ''}
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${isPending || isRejected ? `<button type="button" class="primary-button" style="padding:6px 12px;font-size:12px;" data-review-approve="${esc(r.id)}">Duyệt</button>` : ''}
              ${isPending || isApproved ? `<button type="button" class="secondary-button" style="padding:6px 12px;font-size:12px;" data-review-reject="${esc(r.id)}">Từ chối</button>` : ''}
              <button type="button" class="secondary-button" style="padding:6px 12px;font-size:12px;" data-review-reply="${esc(r.id)}">${r.admin_reply ? 'Sửa phản hồi' : 'Phản hồi'}</button>
              <button type="button" class="plain-button" style="padding:4px 8px;font-size:11.5px;color:#dc2626;" data-review-delete="${esc(r.id)}">Xóa</button>
            </div>
          </div>
        `;
      }).join('');
    } catch (e) {
      if (v === loadingVersion) {
        statusNote.textContent = 'Lỗi tải đánh giá: ' + e.message;
      }
    }
  }

  function open() {
    panel.hidden = false;
    document.querySelector('#product-search')?.closest('.toolbar')?.setAttribute('style', 'display:none !important;');
    document.querySelector('.product-filters')?.setAttribute('style', 'display:none !important;');
    document.querySelector('#product-list')?.setAttribute('style', 'display:none !important;');
    document.querySelector('[data-catalog-summary]')?.setAttribute('style', 'display:none !important;');
    document.querySelector('#product-pagination')?.setAttribute('style', 'display:none !important;');
    document.querySelector('#product-trash-note')?.setAttribute('style', 'display:none !important;');
    return loadReviews();
  }

  function close() {
    panel.hidden = true;
    document.querySelector('#product-search')?.closest('.toolbar')?.removeAttribute('style');
    document.querySelector('.product-filters')?.removeAttribute('style');
    document.querySelector('#product-list')?.removeAttribute('style');
    document.querySelector('[data-catalog-summary]')?.removeAttribute('style');
    document.querySelector('#product-pagination')?.removeAttribute('style');
  }

  // Events
  panel.querySelector('[data-review-refresh]').addEventListener('click', loadReviews);

  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = searchInput.value.trim();
      currentPage = 1;
      loadReviews();
    }, 400);
  });

  statusTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      statusTabs.forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      currentStatus = btn.dataset.reviewStatus;
      currentPage = 1;
      loadReviews();
    });
  });

  // Action delegated clicks
  listWrap.addEventListener('click', async e => {
    const approveBtn = e.target.closest('[data-review-approve]');
    if (approveBtn) {
      const id = approveBtn.dataset.reviewApprove;
      approveBtn.disabled = true;
      try {
        await window.GAERUAdmin.request(`/api/gaeru_ceo/product-reviews/${id}/approve`, { method: 'POST' });
        window.GAERUAdmin.showGlobal('Đã duyệt đánh giá thành công.');
        await loadReviews();
      } catch (err) {
        window.GAERUAdmin.showGlobal(err.message, true);
        approveBtn.disabled = false;
      }
      return;
    }

    const rejectBtn = e.target.closest('[data-review-reject]');
    if (rejectBtn) {
      const id = rejectBtn.dataset.reviewReject;
      const note = window.prompt('Nhập lý do từ chối đánh giá này (ví dụ: nội dung vi phạm, ngôn từ không phù hợp):');
      if (note === null) return;
      rejectBtn.disabled = true;
      try {
        await window.GAERUAdmin.request(`/api/gaeru_ceo/product-reviews/${id}/reject`, {
          method: 'POST',
          body: JSON.stringify({ moderatorNote: note })
        });
        window.GAERUAdmin.showGlobal('Đã từ chối đánh giá.');
        await loadReviews();
      } catch (err) {
        window.GAERUAdmin.showGlobal(err.message, true);
        rejectBtn.disabled = false;
      }
      return;
    }

    const replyBtn = e.target.closest('[data-review-reply]');
    if (replyBtn) {
      const id = replyBtn.dataset.reviewReply;
      const reply = window.prompt('Nhập nội dung phản hồi chính thức từ GAERU Official:');
      if (!reply || !reply.trim()) return;
      replyBtn.disabled = true;
      try {
        await window.GAERUAdmin.request(`/api/gaeru_ceo/product-reviews/${id}/reply`, {
          method: 'POST',
          body: JSON.stringify({ reply: reply.trim() })
        });
        window.GAERUAdmin.showGlobal('Đã đăng phản hồi từ GAERU Official.');
        await loadReviews();
      } catch (err) {
        window.GAERUAdmin.showGlobal(err.message, true);
        replyBtn.disabled = false;
      }
      return;
    }

    const deleteBtn = e.target.closest('[data-review-delete]');
    if (deleteBtn) {
      const id = deleteBtn.dataset.reviewDelete;
      if (!window.confirm('Xóa vĩnh viễn đánh giá này?')) return;
      deleteBtn.disabled = true;
      try {
        await window.GAERUAdmin.request(`/api/gaeru_ceo/product-reviews/${id}`, { method: 'DELETE' });
        window.GAERUAdmin.showGlobal('Đã xóa đánh giá.');
        await loadReviews();
      } catch (err) {
        window.GAERUAdmin.showGlobal(err.message, true);
        deleteBtn.disabled = false;
      }
    }
  });

  window.GAERUProductReviews = { open, close, load: loadReviews };
})();
