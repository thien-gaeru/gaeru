(()=>{
  const root = document.querySelector('#order-review');
  if (!root) return;
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let busy = false;

  function updateBadge(total) {
    const summary = root.querySelector('summary');
    if (!summary) return;
    let badge = summary.querySelector('.review-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'review-badge';
      badge.style.cssText = 'margin-left:8px;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:700;';
      summary.appendChild(badge);
    }
    const count = Number(total || 0);
    if (count > 0) {
      badge.textContent = count + ' đơn cần gọi';
      badge.style.background = '#fef3f2';
      badge.style.color = '#b42318';
      badge.style.border = '1px solid #fecdca';
      root.style.borderColor = '#fecdca';
      root.style.background = '#fff8ed';
    } else {
      badge.textContent = '0';
      badge.style.background = '#f2f4f7';
      badge.style.color = '#475467';
      badge.style.border = '1px solid #eaecf0';
    }
  }

  async function load() {
    if (busy || !window.GAERUAdmin?.can('orders.read')) return;
    busy = true;
    const status = root.querySelector('[data-review-status]');
    try {
      const data = await window.GAERUAdmin.request('/api/gaeru_ceo/orders/review');
      updateBadge(data.total);
      status.textContent = data.total + ' đơn chờ xác minh. Email báo đơn mới: ' + (data.notifications.recipient || 'Chưa có email chủ doanh nghiệp đã xác thực') + (data.notifications.smtpConfigured ? ' · SMTP đã cấu hình' : ' · Chưa cấu hình SMTP') + '. ' + data.notifications.counts.map(x => ({ pending: 'Đang chờ', sent: 'SMTP tiếp nhận', failed: 'Gửi lỗi', unknown: 'Chưa rõ kết quả', sending: 'Đang gửi' }[x.status]) + ': ' + x.total).join(' · ');
      root.querySelector('[data-review-orders]').innerHTML = data.orders.map(o => `<article class="order-card"><h3>${escape(o.orderNumber)} · ${escape(o.customerName)}</h3><p>${escape(o.reasonText)}</p><p><a href="tel:${escape(o.phone.replace(/[^+0-9]/g, ''))}">Gọi ${escape(o.phone)}</a> · ${escape(o.email)}</p><p>${escape(o.address)}, ${escape(o.city)} · Thanh toán: ${escape(o.paymentStatus)}</p><ul>${(o.items || []).map(i => `<li>${escape(i.productName)} · ${escape(i.variantName)} × ${i.quantity}</li>`).join('')}</ul>${window.GAERUAdmin.can('orders.write') ? `<form data-review-id="${o.id}"><label>Kết quả gọi xác nhận<textarea name="resolution" required minlength="5" maxlength="1000" placeholder="Đã gọi xác nhận / không liên lạc được và hướng xử lý"></textarea></label><button class="secondary-button" type="submit">Lưu kết quả và đưa về danh sách xử lý</button></form>` : ''}</article>`).join('') || (data.total ? 'Có nhiều đơn; tải lại để xem thêm.' : 'Không có đơn chờ xác minh.');
    } catch (e) {
      status.textContent = e.message;
    } finally {
      busy = false;
    }
  }

  async function checkBadgeOnly() {
    if (!window.GAERUAdmin?.can('orders.read')) return;
    try {
      const data = await window.GAERUAdmin.request('/api/gaeru_ceo/orders/review');
      updateBadge(data.total);
    } catch {}
  }

  root.addEventListener('toggle', () => { if (root.open) load(); });
  root.querySelector('[data-review-refresh]').addEventListener('click', load);
  root.addEventListener('submit', async e => {
    const form = e.target.closest('[data-review-id]');
    if (!form) return;
    e.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await window.GAERUAdmin.request('/api/gaeru_ceo/orders/' + form.dataset.reviewId + '/review', { method: 'POST', body: JSON.stringify({ resolution: form.querySelector('textarea').value }) });
      await load();
      document.querySelector('#refresh-orders')?.click();
    } catch (error) {
      root.querySelector('[data-review-status]').textContent = error.message;
      button.disabled = false;
    }
  });

  document.addEventListener('gaeru:orders-loaded', checkBadgeOnly);
  setTimeout(checkBadgeOnly, 1200);
})();
