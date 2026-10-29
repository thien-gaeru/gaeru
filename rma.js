'use strict';

function switchRmaTab(tab) {
  const lookupPanel = document.getElementById('rma-lookup-panel');
  const submitPanel = document.getElementById('rma-submit-panel');
  const lookupBtn = document.getElementById('tab-lookup-btn');
  const submitBtn = document.getElementById('tab-submit-btn');

  if (tab === 'lookup') {
    if (lookupPanel) lookupPanel.style.display = 'block';
    if (submitPanel) submitPanel.style.display = 'none';
    if (lookupBtn) lookupBtn.classList.add('active');
    if (submitBtn) submitBtn.classList.remove('active');
  } else {
    if (lookupPanel) lookupPanel.style.display = 'none';
    if (submitPanel) submitPanel.style.display = 'block';
    if (lookupBtn) lookupBtn.classList.remove('active');
    if (submitBtn) submitBtn.classList.add('active');
  }
}

async function handleRmaLookup(e) {
  if (e && e.preventDefault) e.preventDefault();
  const inputEl = document.getElementById('rma-search-input');
  const input = inputEl ? inputEl.value.trim() : '';
  const resultsDiv = document.getElementById('rma-lookup-results');
  if (!input) {
    if (inputEl) inputEl.focus();
    return;
  }

  if (resultsDiv) {
    resultsDiv.innerHTML = '<p style="color:#6e6e73;text-align:center;padding:16px;">Đang tra cứu dữ liệu từ hệ thống GAERU...</p>';
  }

  try {
    const res = await fetch('/api/rma/lookup/' + encodeURIComponent(input));
    const data = await res.json();

    if (!res.ok || !data.tickets || !data.tickets.length) {
      if (resultsDiv) {
        resultsDiv.innerHTML = '<div style="padding:16px 20px;background:#fff5f5;border:1px solid #fed7d7;border-radius:12px;color:#c53030;font-size:14px;line-height:1.5;">Không tìm thấy thông tin phiếu bảo hành khớp với: <strong>' + escapeHtml(input) + '</strong>.<br>Vui lòng kiểm tra lại Số điện thoại mua hàng hoặc Mã phiếu RMA (ví dụ: RMA-2610-xxxx).</div>';
      }
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

    if (resultsDiv) resultsDiv.innerHTML = html;
  } catch (err) {
    if (resultsDiv) resultsDiv.innerHTML = '<p style="color:#d70015;text-align:center;padding:16px;">Lỗi kết nối tra cứu. Vui lòng kiểm tra đường truyền và thử lại.</p>';
  }
}

async function handleRmaSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  const btn = document.getElementById('rma-submit-btn-action');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Đang tiếp nhận yêu cầu...';
  }

  const customerName = document.getElementById('rma-customer-name')?.value?.trim() || '';
  const customerPhone = document.getElementById('rma-customer-phone')?.value?.trim() || '';
  const orderNumber = document.getElementById('rma-order-number')?.value?.trim() || '';
  const serialNumber = document.getElementById('rma-serial-number')?.value?.trim() || '';
  const productName = document.getElementById('rma-product-name')?.value || '';
  const issueType = document.getElementById('rma-issue-type')?.value || '';
  const issueDescription = document.getElementById('rma-issue-description')?.value?.trim() || '';

  if (!customerName || !customerPhone || !productName || !issueType || !issueDescription) {
    alert('Vui lòng điền đầy đủ các trường có dấu hoa thị (*).');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Xác Nhận Gửi Yêu Cầu Bảo Hành';
    }
    return;
  }

  const payload = {
    customerName,
    customerPhone,
    orderNumber,
    serialNumber,
    productName,
    issueType,
    issueDescription
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
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Xác Nhận Gửi Yêu Cầu Bảo Hành';
      }
      return;
    }

    alert('Gửi yêu cầu bảo hành 1-1 thành công!\nMã phiếu RMA của bạn là: ' + data.ticket.ticket_code + '\nĐội ngũ kỹ thuật viên GAERU sẽ liên hệ thẩm định trong vòng 24 giờ.');
    document.getElementById('rma-submit-form')?.reset();
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Xác Nhận Gửi Yêu Cầu Bảo Hành';
    }

    // Chuyển sang tab tra cứu và tìm ngay lập tức
    switchRmaTab('lookup');
    const searchInput = document.getElementById('rma-search-input');
    if (searchInput) searchInput.value = data.ticket.ticket_code;
    handleRmaLookup();
  } catch (err) {
    alert('Lỗi mạng khi gửi yêu cầu. Vui lòng thử lại sau.');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Xác Nhận Gửi Yêu Cầu Bảo Hành';
    }
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Gán toàn cục ngay lập tức để tương thích mọi phương thức gọi
window.switchRmaTab = switchRmaTab;
window.handleRmaLookup = handleRmaLookup;
window.handleRmaSubmit = handleRmaSubmit;
window.GAERURma = { switchRmaTab, handleRmaLookup, handleRmaSubmit };

// Khởi tạo sự kiện trực tiếp & ủy quyền toàn cục
function initRmaPage() {
  const tabLookupBtn = document.getElementById('tab-lookup-btn');
  const tabSubmitBtn = document.getElementById('tab-submit-btn');
  const lookupForm = document.getElementById('rma-lookup-form');
  const submitForm = document.getElementById('rma-submit-form');
  const lookupSubmitBtn = document.getElementById('rma-lookup-submit');
  const submitBtnAction = document.getElementById('rma-submit-btn-action');

  if (tabLookupBtn) tabLookupBtn.addEventListener('click', () => switchRmaTab('lookup'));
  if (tabSubmitBtn) tabSubmitBtn.addEventListener('click', () => switchRmaTab('submit'));
  if (lookupForm) lookupForm.addEventListener('submit', handleRmaLookup);
  if (submitForm) submitForm.addEventListener('submit', handleRmaSubmit);

  if (lookupSubmitBtn) {
    lookupSubmitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      handleRmaLookup(e);
    });
  }

  // Tự động kiểm tra URL query param
  const urlParams = new URLSearchParams(window.location.search);
  const orderParam = urlParams.get('order');
  const codeParam = urlParams.get('code') || urlParams.get('ticket');
  const phoneParam = urlParams.get('phone');

  if (codeParam || phoneParam) {
    switchRmaTab('lookup');
    const searchInput = document.getElementById('rma-search-input');
    if (searchInput) {
      searchInput.value = codeParam || phoneParam;
      handleRmaLookup();
    }
  } else if (orderParam) {
    switchRmaTab('submit');
    const orderInput = document.getElementById('rma-order-number');
    if (orderInput) orderInput.value = orderParam;
  }
}

// Bắt sự kiện click ủy quyền toàn tài liệu
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.rma-tab');
  if (tab) {
    e.preventDefault();
    if (tab.id === 'tab-lookup-btn' || tab.textContent.includes('Tra Cứu')) {
      switchRmaTab('lookup');
    } else {
      switchRmaTab('submit');
    }
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initRmaPage);
} else {
  initRmaPage();
}
