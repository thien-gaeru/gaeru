(function() {
  'use strict';

  const form = document.getElementById('tracking-form');
  const input = document.getElementById('tracking-query');
  const phoneInput = document.getElementById('tracking-phone');
  const resultContainer = document.getElementById('tracking-result');
  const trackBtn = document.getElementById('btn-track');

  if (!form || !input || !resultContainer) return;

  // Auto-search if query param ?q= or ?code= present in URL
  const params = new URLSearchParams(window.location.search);
  const initialCode = params.get('q') || params.get('code');
  const initialPhone = params.get('phone');
  if (initialCode) {
    input.value = initialCode;
    if (initialPhone && phoneInput) phoneInput.value = initialPhone;
    void doLookup(initialCode, initialPhone);
  }

  // Expose globally
  window.doTrackingLookup = doLookup;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void doLookup(input.value, phoneInput ? phoneInput.value : '');
  });

  if (trackBtn) {
    trackBtn.addEventListener('click', (e) => {
      if (input && input.value) {
        e.preventDefault();
        void doLookup(input.value, phoneInput ? phoneInput.value : '');
      }
    });
  }

  let isLookingUp = false;

  async function doLookup(codeQuery, phoneQuery) {
    if (isLookingUp) return;
    isLookingUp = true;
    const code = String(codeQuery || input?.value || '').trim();
    const phone = String(phoneQuery || phoneInput?.value || '').trim();
    if (!code && !phone) return;

    trackBtn.disabled = true;
    trackBtn.textContent = 'Đang tra cứu…';
    resultContainer.style.display = 'block';
    resultContainer.innerHTML = '<div class="tracking-loading"><p>Đang tìm kiếm thông tin đơn hàng từ hệ thống GAERU & các đối tác vận chuyển…</p></div>';

    try {
      let url = '/api/tracking/lookup?code=' + encodeURIComponent(code);
      if (phone) url += '&phone=' + encodeURIComponent(phone);

      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Không tìm thấy đơn hàng.');
      renderOrders(data.orders);
    } catch (err) {
      resultContainer.innerHTML = `
        <div class="tracking-card error-card">
          <h3>Không tìm thấy kết quả</h3>
          <p>${escapeHtml(err.message)}</p>
          <small>Vui lòng kiểm tra lại mã đơn hàng hoặc số điện thoại đã nhập.</small>
        </div>
      `;
    } finally {
      isLookingUp = false;
      trackBtn.disabled = false;
      trackBtn.textContent = 'Tra cứu ngay';
    }
  }

  function renderOrders(orders) {
    if (!orders || !orders.length) {
      resultContainer.innerHTML = `
        <div class="tracking-card error-card">
          <h3>Không tìm thấy đơn hàng</h3>
          <p>Không có dữ liệu vận chuyển khớp với thông tin đã nhập.</p>
          <small>Vui lòng kiểm tra lại mã đơn hoặc số điện thoại.</small>
        </div>
      `;
      return;
    }

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
          ${(trackingUrl && /^https?:\/\//i.test(trackingUrl)) ? `<a href="${escapeHtml(trackingUrl)}" target="_blank" rel="noopener" class="spx-link carrier-link">Xem định vị bưu tá (${escapeHtml(carrierTitle)}) ↗</a>` : ''}
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

          ${order.requiresPhoneVerification ? `
            <div class="tracking-verification-notice" style="background:rgba(217,119,6,0.1);border:1px solid rgba(217,119,6,0.3);border-radius:8px;padding:12px 16px;margin-top:16px;">
              <p style="margin:0;font-size:13px;color:#f59e0b;">🔒 <strong>Bảo vệ dữ liệu khách hàng:</strong> Nhập số điện thoại đặt hàng vào ô tra cứu để xem chi tiết danh sách sản phẩm và địa chỉ nhận hàng.</p>
            </div>
          ` : `
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
          `}
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
