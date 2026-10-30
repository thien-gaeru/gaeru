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

  // Expose globally
  window.doTrackingLookup = doLookup;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void doLookup(input.value);
  });

  if (trackBtn) {
    trackBtn.addEventListener('click', (e) => {
      if (input && input.value) {
        e.preventDefault();
        void doLookup(input.value);
      }
    });
  }

  async function doLookup(query) {
    const trimmed = String(query || '').trim();
    if (!trimmed) return;

    trackBtn.disabled = true;
    trackBtn.textContent = 'Đang tra cứu…';
    resultContainer.style.display = 'block';
    resultContainer.innerHTML = '<div class="tracking-loading"><p>Đang tìm kiếm thông tin đơn hàng từ hệ thống GAERU & các đối tác vận chuyển…</p></div>';

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

      const carrierTitle = order.carrierName || order.carrier || 'Đơn vị vận chuyển đối tác';
      const trackingCode = order.trackingCode || order.spxTrackingCode;
      const trackingUrl = order.trackingUrl || order.spxTrackingUrl;

      const spxBanner = trackingCode ? `
        <div class="spx-tracking-badge carrier-tracking-badge">
          <span>Đơn vị giao: <strong>${escapeHtml(carrierTitle)}</strong> · Mã vận đơn: <strong>${escapeHtml(trackingCode)}</strong></span>
          ${trackingUrl ? `<a href="${escapeHtml(trackingUrl)}" target="_blank" rel="noopener" class="spx-link carrier-link">Xem định vị bưu tá (${escapeHtml(carrierTitle)}) ↗</a>` : ''}
        </div>
      ` : `
        <div class="spx-tracking-badge pending carrier-tracking-badge">
          <span>Đơn hàng đang chuẩn bị giao cho đơn vị vận chuyển (${escapeHtml(carrierTitle)}: GHN / GHTK / Viettel Post / SPX).</span>
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
              <small>${escapeHtml(formatPaymentBadge(order.paymentMethod, order.paymentStatus))}</small>
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

  function formatPaymentBadge(method, status) {
    const s = String(status || '').toLowerCase();
    const m = String(method || '').toLowerCase();
    if (s === 'paid') return 'Đã thanh toán';
    if (s === 'failed') return 'Thanh toán thất bại';
    if (s === 'cancelled') return 'Thanh toán đã hủy';
    if (s === 'refunded') return 'Đã hoàn tiền';
    if (m === 'cod') return 'Thanh toán COD';
    if (m === 'bank_transfer') return 'Chờ chuyển khoản';
    return 'Chờ thanh toán';
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
