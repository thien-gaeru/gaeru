'use strict';

function switchRmaTab(tab) {
  const lookupPanel = document.getElementById('rma-lookup-panel');
  const submitPanel = document.getElementById('rma-submit-panel');
  const lookupBtn = document.getElementById('tab-lookup-btn');
  const submitBtn = document.getElementById('tab-submit-btn');

  if (tab === 'lookup') {
    lookupPanel.style.display = 'block';
    submitPanel.style.display = 'none';
    lookupBtn.classList.add('active');
    submitBtn.classList.remove('active');
  } else {
    lookupPanel.style.display = 'none';
    submitPanel.style.display = 'block';
    lookupBtn.classList.remove('active');
    submitBtn.classList.add('active');
  }
}

async function handleRmaLookup(e) {
  if (e && e.preventDefault) e.preventDefault();
  const input = document.getElementById('rma-search-input').value.trim();
  const resultsDiv = document.getElementById('rma-lookup-results');
  if (!input) return;

  resultsDiv.innerHTML = '<p style="color:#6e6e73;text-align:center;padding:16px;">Đang tra cứu dữ liệu từ hệ thống GAERU...</p>';

  try {
    const res = await fetch('/api/rma/lookup/' + encodeURIComponent(input));
    const data = await res.json();

    if (!res.ok || !data.tickets || !data.tickets.length) {
      resultsDiv.innerHTML = '<div style="padding:16px 20px;background:#fff5f5;border:1px solid #fed7d7;border-radius:12px;color:#c53030;font-size:14px;line-height:1.5;">Không tìm thấy thông tin phiếu bảo hành khớp với: <strong>' + escapeHtml(input) + '</strong>.<br>Vui lòng kiểm tra lại Số điện thoại mua hàng hoặc Mã phiếu RMA (ví dụ: RMA-2610-xxxx).</div>';
      return;
    }

    let html = '';
    data.tickets.forEach(ticket => {
      html += `
        <div class="rma-ticket-box">
          <div class="rma-ticket-header">
            <div>
              <span class="rma-ticket-code">${escapeHtml(ticket.ticket_code)}</span>
              <div style="font-size:14px;color:#6e6e73;margin-top:4px;">Sản phẩm: <strong style="color:#1d1d1f;">${escapeHtml(ticket.product_name)}</strong></div>
            </div>
            <span class="rma-status-pill">${escapeHtml(ticket.statusLabel || ticket.status)}</span>
          </div>

          <div style="font-size:13.5px;color:#6e6e73;margin-bottom:14px;line-height:1.6;">
            <span>Khách hàng: <strong style="color:#1d1d1f;">${escapeHtml(ticket.customer_name)}</strong></span> ·
            <span>Ngày tạo: ${new Date(ticket.created_at).toLocaleDateString('vi-VN')}</span>
            ${ticket.tracking_code_outbound ? ` · <span>Mã vận đơn xuất kho: <strong style="color:#0071e3;">${escapeHtml(ticket.tracking_code_outbound)}</strong></span>` : ''}
          </div>

          <div style="font-size:13.5px;background:#ffffff;border:1px solid #e5e5ea;padding:12px 16px;border-radius:10px;margin-bottom:14px;color:#1d1d1f;line-height:1.6;">
            <strong>Triệu chứng lỗi:</strong> ${escapeHtml(ticket.issue_description)}
            ${ticket.technician_notes ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #e5e5ea;color:#0071e3;"><strong>Đánh giá kỹ thuật viên GAERU:</strong> ${escapeHtml(ticket.technician_notes)}</div>` : ''}
          </div>

          <h4 style="margin:14px 0 8px 0;font-size:14px;color:#1d1d1f;font-weight:700;">Lịch sử xử lý tiến độ:</h4>
          <ul class="rma-timeline">
            ${(ticket.events || []).map(ev => `
              <li class="rma-timeline-item">
                <div class="rma-timeline-date">${new Date(ev.created_at).toLocaleString('vi-VN')} — <em>${escapeHtml(ev.created_by)}</em></div>
                <div class="rma-timeline-desc">${escapeHtml(ev.description)}</div>
              </li>
            `).join('')}
          </ul>
        </div>
      `;
    });

    resultsDiv.innerHTML = html;
  } catch (err) {
    resultsDiv.innerHTML = '<p style="color:#d70015;text-align:center;padding:16px;">Lỗi kết nối tra cứu. Vui lòng kiểm tra đường truyền và thử lại.</p>';
  }
}

async function handleRmaSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const btn = document.getElementById('rma-submit-btn-action');
  btn.disabled = true;
  btn.textContent = 'Đang tiếp nhận yêu cầu...';

  const payload = {
    customerName: document.getElementById('rma-customer-name').value.trim(),
    customerPhone: document.getElementById('rma-customer-phone').value.trim(),
    orderNumber: document.getElementById('rma-order-number').value.trim(),
    serialNumber: document.getElementById('rma-serial-number').value.trim(),
    productName: document.getElementById('rma-product-name').value,
    issueType: document.getElementById('rma-issue-type').value,
    issueDescription: document.getElementById('rma-issue-description').value.trim()
  };

  try {
    const res = await fetch('/api/rma/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (!res.ok) {
      alert('Lỗi tiếp nhận: ' + (data.error || 'Chưa gửi được yêu cầu. Vui lòng kiểm tra lại thông tin.'));
      btn.disabled = false;
      btn.textContent = 'Xác Nhận Gửi Yêu Cầu Bảo Hành';
      return;
    }

    alert('Gửi yêu cầu bảo hành 1-1 thành công!\nMã phiếu RMA của bạn là: ' + data.ticket.ticket_code + '\nĐội ngũ kỹ thuật viên GAERU sẽ liên hệ thẩm định trong vòng 24 giờ.');
    document.getElementById('rma-submit-form').reset();
    btn.disabled = false;
    btn.textContent = 'Xác Nhận Gửi Yêu Cầu Bảo Hành';

    // Switch to lookup tab and search immediately
    switchRmaTab('lookup');
    document.getElementById('rma-search-input').value = data.ticket.ticket_code;
    handleRmaLookup();
  } catch (err) {
    alert('Lỗi mạng khi gửi yêu cầu. Vui lòng thử lại sau.');
    btn.disabled = false;
    btn.textContent = 'Xác Nhận Gửi Yêu Cầu Bảo Hành';
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
