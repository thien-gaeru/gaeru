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
  e.preventDefault();
  const input = document.getElementById('rma-search-input').value.trim();
  const resultsDiv = document.getElementById('rma-lookup-results');
  if (!input) return;

  resultsDiv.innerHTML = '<p style="color:#8b949e;">Đang tra cứu dữ liệu từ hệ thống...</p>';

  try {
    const res = await fetch('/api/rma/lookup/' + encodeURIComponent(input));
    const data = await res.json();

    if (!res.ok || !data.tickets || !data.tickets.length) {
      resultsDiv.innerHTML = '<div style="padding:16px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.3);border-radius:8px;color:#f85149;">Không tìm thấy thông tin phiếu bảo hành khớp với: <strong>' + escapeHtml(input) + '</strong>. Vui lòng kiểm tra lại SĐT hoặc Mã phiếu.</div>';
      return;
    }

    let html = '';
    data.tickets.forEach(ticket => {
      html += `
        <div class="rma-ticket-box">
          <div class="rma-ticket-header">
            <div>
              <span class="rma-ticket-code">${escapeHtml(ticket.ticket_code)}</span>
              <div style="font-size:14px;color:#8b949e;margin-top:4px;">Sản phẩm: <strong style="color:#e6edf3;">${escapeHtml(ticket.product_name)}</strong></div>
            </div>
            <span class="rma-status-pill">${escapeHtml(ticket.statusLabel || ticket.status)}</span>
          </div>

          <div style="font-size:13px;color:#8b949e;margin-bottom:12px;">
            <span>Khách hàng: <strong>${escapeHtml(ticket.customer_name)}</strong></span> |
            <span>Ngày tạo: ${new Date(ticket.created_at).toLocaleDateString('vi-VN')}</span>
            ${ticket.tracking_code_outbound ? ` | <span>Mã vận đơn gửi lại: <strong style="color:#58a6ff;">${escapeHtml(ticket.tracking_code_outbound)}</strong></span>` : ''}
          </div>

          <div style="font-size:13px;background:#161b22;padding:10px 14px;border-radius:6px;margin-bottom:12px;">
            <strong>Mô tả lỗi:</strong> ${escapeHtml(ticket.issue_description)}
            ${ticket.technician_notes ? `<div style="margin-top:6px;color:#58a6ff;"><strong>Ghi chú kỹ thuật:</strong> ${escapeHtml(ticket.technician_notes)}</div>` : ''}
          </div>

          <h4 style="margin:12px 0 8px 0;font-size:14px;">Lịch sử xử lý:</h4>
          <ul class="rma-timeline">
            ${(ticket.events || []).map(ev => `
              <li class="rma-timeline-item">
                <div class="rma-timeline-date">${new Date(ev.created_at).toLocaleString('vi-VN')} - <em>${escapeHtml(ev.created_by)}</em></div>
                <div class="rma-timeline-desc">${escapeHtml(ev.description)}</div>
              </li>
            `).join('')}
          </ul>
        </div>
      `;
    });

    resultsDiv.innerHTML = html;
  } catch (err) {
    resultsDiv.innerHTML = '<p style="color:#f85149;">Lỗi kết nối tra cứu. Vui lòng thử lại sau.</p>';
  }
}

async function handleRmaSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('rma-submit-btn-action');
  btn.disabled = true;
  btn.textContent = 'Đang xử lý...';

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
      alert('Lỗi: ' + (data.error || 'Chưa gửi được yêu cầu.'));
      btn.disabled = false;
      btn.textContent = 'Xác Nhận Gửi Yêu Cầu Bảo Hành';
      return;
    }

    alert('Gửi yêu cầu bảo hành thành công!\nMã phiếu RMA của bạn là: ' + data.ticket.ticket_code + '\nNhân viên kỹ thuật GAERU sẽ liên hệ với bạn trong vòng 24 giờ.');
    document.getElementById('rma-submit-form').reset();
    btn.disabled = false;
    btn.textContent = 'Xác Nhận Gửi Yêu Cầu Bảo Hành';

    // Switch to lookup tab and search immediately
    switchRmaTab('lookup');
    document.getElementById('rma-search-input').value = data.ticket.ticket_code;
    handleRmaLookup(new Event('submit'));
  } catch (err) {
    alert('Lỗi mạng khi gửi yêu cầu. Vui lòng thử lại.');
    btn.disabled = false;
    btn.textContent = 'Xác Nhận Gửi Yêu Cầu Bảo Hành';
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
