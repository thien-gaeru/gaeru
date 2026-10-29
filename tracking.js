(function() {
  'use strict';

  const form = document.getElementById('tracking-form');
  const input = document.getElementById('tracking-query');
  const resultContainer = document.getElementById('tracking-result');
  const trackBtn = document.getElementById('btn-track');

  if (!form || !input || !resultContainer) return;

  // Auto-search if query param ?q= or ?code= present in URL
  const params = new URLSearchParams(window.location.search);
  const initialQuery = params.get('q') || params.get('code') || params.get('phone');
  if (initialQuery) {
    input.value = initialQuery;
    void doLookup(initialQuery);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void doLookup(input.value);
  });

  async function doLookup(query) {
    const trimmed = String(query || '').trim();
    if (!trimmed) return;

    trackBtn.disabled = true;
    trackBtn.textContent = 'Đang tra cứu…';
    resultContainer.style.display = 'block';
    resultContainer.innerHTML = '<div class="tracking-loading"><p>Đang tìm kiếm thông tin đơn hàng từ hệ thống GAERU & Shopee Express…</p></div>';

    try {
      const res = await fetch('/api/tracking/lookup?query=' + encodeURIComponent(trimmed));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Không tìm thấy đơn hàng.');
      renderOrders(data.orders);
    } catch (err) {
      resultContainer.innerHTML = `
        <div class="tracking-card error-card">
          <h3>Không tìm thấy kết quả</h3>
          <p>${escapeHtml(err.message)}</p>
          <small>Vui lòng kiểm tra lại số điện thoại hoặc mã đơn hàng đã nhập.</small>
        </div>
      `;
    } finally {
      trackBtn.disabled = false;
      trackBtn.textContent = 'Tra cứu ngay';
    }
  }

  function renderOrders(orders) {
    if (!orders || !orders.length) return;

    resultContainer.innerHTML = orders.map(order => {
      const timelineHtml = (order.timeline || []).map((step, idx) => `
        <div class="timeline-step ${step.completed ? 'completed' : ''} ${step.current ? 'current' : ''}">
          <div class="step-dot">${step.completed ? '✓' : (idx + 1)}</div>
          <div class="step-content">
            <strong>${escapeHtml(step.label)}</strong>
            <small>${escapeHtml(step.desc)}</small>
          </div>
        </div>
      `).join('');

      const itemsHtml = (order.items || []).map(i => `
        <li class="order-item-row">
          <span>${escapeHtml(i.name)} (${escapeHtml(i.variantName || 'Chuẩn')})</span>
          <strong>x${i.quantity || 1}</strong>
        </li>
      `).join('');

      const spxBanner = order.spxTrackingCode ? `
        <div class="spx-tracking-badge">
          <span>Mã vận đơn Shopee Express: <strong>${escapeHtml(order.spxTrackingCode)}</strong></span>
          <a href="${escapeHtml(order.spxTrackingUrl)}" target="_blank" rel="noopener" class="spx-link">Xem định vị bưu tá ↗</a>
        </div>
      ` : `
        <div class="spx-tracking-badge pending">
          <span>Đơn hàng đang chuẩn bị giao cho đơn vị vận chuyển Shopee Express (SPX).</span>
        </div>
      `;

      return `
        <div class="tracking-card">
          <div class="tracking-card-header">
            <div>
              <span class="tracking-order-badge">Mã đơn: ${escapeHtml(order.orderCode)}</span>
              <p class="tracking-date">Ngày đặt: ${new Date(order.createdAt).toLocaleString('vi-VN')}</p>
            </div>
            <div class="order-total-badge">
              <strong>${new Intl.NumberFormat('vi-VN').format(order.totalVnd)} ₫</strong>
              <small>${escapeHtml(order.paymentMethod === 'cod' ? 'Thanh toán COD' : 'Đã thanh toán')}</small>
            </div>
          </div>

          ${spxBanner}

          <div class="tracking-timeline-flow">
            ${timelineHtml}
          </div>

          <div class="tracking-card-footer">
            <div class="order-info-column">
              <h4>Địa chỉ nhận hàng:</h4>
              <p>${escapeHtml(order.customerName)} (${escapeHtml(order.customerPhoneMasked)})</p>
              <p class="addr-text">${escapeHtml(order.shippingAddress)}</p>
            </div>
            <div class="order-items-column">
              <h4>Chi tiết sản phẩm:</h4>
              <ul>${itemsHtml}</ul>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
