(()=>{
  'use strict';

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const formatMoney = v => new Intl.NumberFormat('vi-VN').format(Number(v) || 0) + ' ₫';

  function init() {
    const ordersView = document.getElementById('orders-view');
    if (!ordersView) return;

    let panel = document.getElementById('cod-return-panel');
    let toggleBtn = document.getElementById('cod-return-toggle');

    if (!panel) {
      const afterSalesBtn = document.getElementById('after-sales-toggle');
      toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'secondary-button';
      toggleBtn.id = 'cod-return-toggle';
      toggleBtn.setAttribute('aria-expanded', 'false');
      toggleBtn.setAttribute('aria-controls', 'cod-return-panel');
      toggleBtn.style.marginLeft = '8px';
      toggleBtn.innerHTML = '📦 Kiểm nhận hàng hoàn COD <span id="cod-return-badge" style="background:#e53e3e;color:#fff;border-radius:10px;padding:2px 7px;font-size:0.75em;display:none;">0</span>';

      if (afterSalesBtn && afterSalesBtn.parentNode) {
        afterSalesBtn.after(toggleBtn);
      }

      panel = document.createElement('section');
      panel.id = 'cod-return-panel';
      panel.hidden = true;
      panel.style.margin = '16px 0';
      panel.style.padding = '18px';
      panel.style.background = '#fff';
      panel.style.border = '1px solid #cbd5e0';
      panel.style.borderRadius = '12px';
      panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
          <div>
            <h2 style="margin:0 0 4px 0;font-size:1.3em;">Kiểm nhận hàng chuyển hoàn COD</h2>
            <p style="margin:0;color:#4a5568;font-size:0.9em;">Quét mã vận đơn kiểm tra niêm phong kiện hàng. Chỉ nhập lại kho bán khi hàng còn nguyên seal 100%.</p>
          </div>
          <div style="display:flex;gap:8px;">
            <button type="button" class="secondary-button" id="cod-return-refresh">Tải lại danh sách</button>
            <button type="button" class="plain-button" id="cod-return-close" style="font-weight:bold;">✕ Đóng</button>
          </div>
        </div>

        <!-- Khung quét Barcode / Tìm nhanh kiện hàng -->
        <div style="background:#f7fafc;padding:14px;border-radius:8px;border:1px dashed #cbd5e0;margin-bottom:16px;">
          <form id="cod-return-lookup-form" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <label style="font-weight:600;min-width:140px;">Quét mã bưu kiện:</label>
            <input type="text" id="cod-return-scan-input" placeholder="Quét barcode vận đơn hoặc nhập mã đơn..." style="flex:1;min-width:220px;padding:8px 12px;border:1px solid #cbd5e0;border-radius:6px;font-family:monospace;" autocomplete="off" required>
            <button type="submit" class="primary-button" id="btn-cod-return-search">Tìm kiện hàng</button>
          </form>
          <div id="cod-return-scan-result" style="margin-top:12px;" hidden></div>
        </div>

        <!-- Bộ lọc tab -->
        <div style="display:flex;gap:8px;margin-bottom:12px;">
          <button type="button" class="secondary-button" id="btn-tab-cod-pending" style="font-weight:600;background:#edf2f7;">Chờ kiểm nhận (<span id="count-cod-pending">0</span>)</button>
          <button type="button" class="plain-button" id="btn-tab-cod-history">Lịch sử đã kiểm</button>
          <button type="button" class="plain-button" id="btn-tab-cod-claims" style="color:#c53030;">Hồ sơ bồi thường hãng vận chuyển</button>
        </div>

        <div id="cod-return-list-container">
          <div id="cod-return-list-status" role="status" style="padding:10px 0;color:#718096;font-size:0.9em;">Đang tải danh sách hàng hoàn...</div>
          <div id="cod-return-items" style="display:grid;gap:12px;"></div>
        </div>
      `;

      if (afterSalesBtn && afterSalesBtn.parentNode) {
        afterSalesBtn.parentNode.insertBefore(panel, document.getElementById('order-workspace'));
      }

      // Gắn sự kiện toggle
      toggleBtn.addEventListener('click', () => {
        const isHidden = panel.hidden;
        panel.hidden = !isHidden;
        toggleBtn.setAttribute('aria-expanded', String(!isHidden));
        if (!panel.hidden) {
          loadPending();
        }
      });

      panel.querySelector('#cod-return-close').addEventListener('click', () => {
        panel.hidden = true;
        toggleBtn.setAttribute('aria-expanded', 'false');
      });

      panel.querySelector('#cod-return-refresh').addEventListener('click', () => {
        loadPending();
      });

      // Xử lý quét Barcode
      const lookupForm = panel.querySelector('#cod-return-lookup-form');
      const scanInput = panel.querySelector('#cod-return-scan-input');
      const scanResult = panel.querySelector('#cod-return-scan-result');

      lookupForm.addEventListener('submit', async e => {
        e.preventDefault();
        const q = scanInput.value.trim();
        if (!q) return;

        scanResult.hidden = false;
        scanResult.innerHTML = '<p style="color:#718096;">Đang tra cứu vận đơn: ' + esc(q) + '...</p>';

        try {
          const res = await window.GAERUAdmin.request('/api/gaeru_ceo/cod-returns/lookup?q=' + encodeURIComponent(q));
          renderLookupResult(scanResult, res.shipment, res.intakeStatus);
        } catch (err) {
          scanResult.innerHTML = `<div style="padding:10px;background:#fff5f5;border:1px solid #feb2b2;border-radius:6px;color:#c53030;">⚠️ ${esc(err.message || 'Không tìm thấy kiện hàng.')}</div>`;
        }
      });

      // Xử lý chuyển tab
      panel.querySelector('#btn-tab-cod-pending').addEventListener('click', () => {
        setTabActive('pending');
        loadPending();
      });

      panel.querySelector('#btn-tab-cod-history').addEventListener('click', () => {
        setTabActive('history');
        loadHistory();
      });

      panel.querySelector('#btn-tab-cod-claims').addEventListener('click', () => {
        setTabActive('claims');
        loadClaims();
      });
    }

    // Tự động kiểm tra số lượng chờ kiểm nhận khi vào trang
    checkPendingCount();
  }

  function setTabActive(tab) {
    const pBtn = document.getElementById('btn-tab-cod-pending');
    const hBtn = document.getElementById('btn-tab-cod-history');
    const cBtn = document.getElementById('btn-tab-cod-claims');

    [pBtn, hBtn, cBtn].forEach(b => {
      b.className = 'plain-button';
      b.style.fontWeight = 'normal';
      b.style.background = 'transparent';
    });

    if (tab === 'pending') {
      pBtn.className = 'secondary-button';
      pBtn.style.fontWeight = '600';
      pBtn.style.background = '#edf2f7';
    } else if (tab === 'history') {
      hBtn.className = 'secondary-button';
      hBtn.style.fontWeight = '600';
      hBtn.style.background = '#edf2f7';
    } else if (tab === 'claims') {
      cBtn.className = 'secondary-button';
      cBtn.style.fontWeight = '600';
      cBtn.style.background = '#fed7d7';
    }
  }

  async function checkPendingCount() {
    try {
      const data = await window.GAERUAdmin.request('/api/gaeru_ceo/cod-returns/pending?limit=1');
      const badge = document.getElementById('cod-return-badge');
      const countEl = document.getElementById('count-cod-pending');
      const total = data.total || 0;

      if (countEl) countEl.textContent = total;
      if (badge) {
        if (total > 0) {
          badge.textContent = total;
          badge.style.display = 'inline-block';
        } else {
          badge.style.display = 'none';
        }
      }
    } catch (_) {}
  }

  async function loadPending() {
    const listEl = document.getElementById('cod-return-items');
    const statusEl = document.getElementById('cod-return-list-status');
    if (!listEl) return;

    statusEl.textContent = 'Đang tải danh sách kiện hàng chuyển hoàn chờ kiểm nhận...';
    listEl.innerHTML = '';

    try {
      const data = await window.GAERUAdmin.request('/api/gaeru_ceo/cod-returns/pending');
      checkPendingCount();

      if (!data.pendingReturns || data.pendingReturns.length === 0) {
        statusEl.textContent = 'Không có bưu phẩm chuyển hoàn nào đang chờ kiểm nhận.';
        return;
      }

      statusEl.textContent = `Tìm thấy ${data.total} bưu phẩm chuyển hoàn chờ kiểm nhận:`;
      listEl.innerHTML = data.pendingReturns.map(item => `
        <article class="order-card" style="border:1px solid #e2e8f0;padding:14px;border-radius:8px;background:#fafafa;">
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;">
            <div>
              <strong style="font-size:1.1em;color:#2d3748;">Đơn: ${esc(item.orderNumber)}</strong>
              <span style="margin-left:8px;padding:2px 8px;border-radius:4px;background:#fed7d7;color:#9b2c2c;font-size:0.85em;font-weight:600;">Chuyển hoàn</span>
            </div>
            <div style="font-family:monospace;font-weight:600;">
              Hãng: <span style="text-transform:uppercase;">${esc(item.carrierId)}</span> · Mã vận đơn: <mark style="padding:2px 6px;border-radius:4px;">${esc(item.trackingNumber)}</mark>
            </div>
          </div>

          <p style="margin:6px 0;color:#4a5568;font-size:0.9em;">
            Khách: <strong>${esc(item.customerName)}</strong> · ĐT: ${esc(item.phone)} · Khu vực: ${esc(item.city)}
            · Tiền thu hộ COD: <strong>${formatMoney(item.codAmountVnd || item.orderTotalVnd)}</strong>
          </p>

          <div style="background:#fff;padding:8px 12px;border-radius:6px;border:1px solid #edf2f7;margin:8px 0;">
            <p style="margin:0 0 4px 0;font-size:0.85em;color:#718096;font-weight:600;">Sản phẩm trong kiện hàng:</p>
            <ul style="margin:0;padding-left:18px;font-size:0.9em;">
              ${(item.items || []).map(p => `<li>${esc(p.productName)} (${esc(p.variantName)}) × ${p.quantity}</li>`).join('')}
            </ul>
          </div>

          <!-- Form kiểm nhận trực tiếp -->
          <form data-cod-intake-form="${esc(item.trackingNumber)}" style="margin-top:10px;padding:12px;background:#fff;border-radius:6px;border:1px solid #cbd5e0;display:grid;gap:10px;">
            <input type="hidden" name="trackingNumber" value="${esc(item.trackingNumber)}">
            <label style="font-weight:600;font-size:0.9em;">
              Tình trạng bưu kiện thực tế khi nhận từ bưu tá:
              <select name="packageCondition" required style="width:100%;margin-top:4px;padding:6px;border-radius:4px;border:1px solid #cbd5e0;">
                <option value="intact">🟢 Nguyên vẹn / Nguyên seal 100% (Cho phép hoàn tồn kho để bán lại)</option>
                <option value="damaged">🟠 Hư hỏng vỏ hộp / Vỡ thiết bị do vận chuyển (Cách ly, không nhập bán)</option>
                <option value="lost_or_tampered">🔴 Mất hàng / Kiện hàng bị rách hoặc tráo ruột (Lập biên bản đền bù 100%)</option>
              </select>
            </label>

            <label style="font-size:0.9em;">
              Ghi chú kiểm định thực tế:
              <input type="text" name="inspectionNotes" maxlength="500" placeholder="Tình trạng tem niêm phong, ngoại quan kiện hàng..." style="width:100%;margin-top:4px;padding:6px;border-radius:4px;border:1px solid #cbd5e0;">
            </label>

            <label style="display:flex;align-items:center;gap:8px;font-size:0.85em;color:#4a5568;">
              <input type="checkbox" name="carrierFault">
              Đánh dấu lỗi do Hãng vận chuyển làm hư hại / thất lạc (chuyển sang danh mục đòi bồi thường)
            </label>

            <div style="display:flex;gap:8px;align-items:center;margin-top:4px;">
              <button type="submit" class="primary-button" style="background:#2b6cb0;">Xác nhận kiểm nhận bưu kiện</button>
              <span class="intake-form-status" style="font-size:0.85em;"></span>
            </div>
          </form>
        </article>
      `).join('');

      // Gắn sự kiện submit cho từng form kiểm nhận
      listEl.querySelectorAll('form[data-cod-intake-form]').forEach(form => {
        form.addEventListener('submit', async e => {
          e.preventDefault();
          const statusSpan = form.querySelector('.intake-form-status');
          const submitBtn = form.querySelector('button[type="submit"]');

          const formData = new FormData(form);
          const payload = {
            trackingNumber: formData.get('trackingNumber'),
            packageCondition: formData.get('packageCondition'),
            inspectionNotes: formData.get('inspectionNotes') || '',
            carrierFault: formData.get('carrierFault') === 'on'
          };

          submitBtn.disabled = true;
          statusSpan.textContent = 'Đang xử lý kiểm nhận...';
          statusSpan.style.color = '#718096';

          try {
            const res = await window.GAERUAdmin.request('/api/gaeru_ceo/cod-returns/intake', {
              method: 'POST',
              body: JSON.stringify(payload)
            });

            statusSpan.textContent = '✅ ' + (res.message || 'Kiểm nhận thành công!');
            statusSpan.style.color = '#2f855a';

            setTimeout(() => {
              loadPending();
            }, 1200);
          } catch (err) {
            submitBtn.disabled = false;
            statusSpan.textContent = '❌ Lỗi: ' + (err.message || 'Không thể kiểm nhận.');
            statusSpan.style.color = '#c53030';
          }
        });
      });

    } catch (err) {
      statusEl.textContent = 'Lỗi tải danh sách: ' + err.message;
    }
  }

  function renderLookupResult(container, shipment, intakeStatus) {
    const isCompleted = intakeStatus === 'completed';

    container.innerHTML = `
      <div style="background:#fff;padding:12px;border-radius:6px;border:1px solid #cbd5e0;">
        <div style="display:flex;justify-content:space-between;flex-wrap:wrap;">
          <strong>Đơn: ${esc(shipment.orderNumber)}</strong>
          <span>Vận đơn: <code>${esc(shipment.trackingNumber)}</code> (${esc(shipment.carrierId).toUpperCase()})</span>
        </div>
        <p style="margin:4px 0;font-size:0.9em;color:#4a5568;">
          Khách: ${esc(shipment.customerName)} (${esc(shipment.phone)}) · Thu hộ: ${formatMoney(shipment.codAmountVnd || shipment.orderTotalVnd)}
        </p>

        ${isCompleted ? `
          <div style="margin-top:8px;padding:8px;background:#f0fff4;border:1px solid #c6f6d5;border-radius:4px;color:#22543d;font-size:0.9em;">
            ✅ <strong>Bưu kiện này đã được kiểm nhận hoàn kho:</strong> Tình trạng <code>${esc(shipment.packageCondition)}</code> (${shipment.restocked ? 'Đã hoàn tồn kho' : 'Không nhập bán'}). Người kiểm: <strong>${esc(shipment.inspector)}</strong> lúc ${new Date(shipment.intakeAt).toLocaleString('vi-VN')}.
          </div>
        ` : `
          <div style="margin-top:8px;padding:8px;background:#fffaf0;border:1px solid #feebc8;border-radius:4px;color:#744210;font-size:0.9em;">
            ⏳ Bưu phẩm đang chờ kiểm nhận thực tế.
          </div>
        `}
      </div>
    `;
  }

  async function loadHistory() {
    const listEl = document.getElementById('cod-return-items');
    const statusEl = document.getElementById('cod-return-list-status');
    if (!listEl) return;

    statusEl.textContent = 'Đang tải lịch sử các bưu phẩm đã kiểm nhận...';
    listEl.innerHTML = '';

    try {
      const data = await window.GAERUAdmin.request('/api/gaeru_ceo/cod-returns/history');
      if (!data.history || data.history.length === 0) {
        statusEl.textContent = 'Chưa có dữ liệu kiểm nhận hàng hoàn.';
        return;
      }

      statusEl.textContent = `Tổng cộng ${data.total} kiện hàng đã kiểm nhận:`;
      listEl.innerHTML = data.history.map(item => `
        <article class="order-card" style="border:1px solid #e2e8f0;padding:12px;border-radius:8px;background:#fff;">
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;">
            <strong>Đơn: ${esc(item.orderNumber)}</strong>
            <span>Vận đơn: <code>${esc(item.trackingNumber)}</code> (${esc(item.carrierId).toUpperCase()})</span>
          </div>
          <p style="margin:4px 0;font-size:0.9em;">
            Tình trạng: <strong>${item.packageCondition === 'intact' ? '🟢 Nguyên seal 100%' : (item.packageCondition === 'damaged' ? '🟠 Hư hỏng do vận chuyển' : '🔴 Mất hàng / Tráo ruột')}</strong>
            · Tồn kho: <span style="font-weight:600;color:${item.restocked ? '#2f855a' : '#c53030'};">${item.restocked ? 'Đã hoàn kho' : 'Không nhập bán'}</span>
            · Người kiểm: <strong>${esc(item.inspector)}</strong> (${new Date(item.createdAt).toLocaleString('vi-VN')})
          </p>
          ${item.inspectionNotes ? `<p style="margin:4px 0;font-size:0.85em;color:#718096;">Ghi chú: ${esc(item.inspectionNotes)}</p>` : ''}
        </article>
      `).join('');
    } catch (err) {
      statusEl.textContent = 'Lỗi tải lịch sử: ' + err.message;
    }
  }

  async function loadClaims() {
    const listEl = document.getElementById('cod-return-items');
    const statusEl = document.getElementById('cod-return-list-status');
    if (!listEl) return;

    statusEl.textContent = 'Đang tải danh sách hồ sơ bồi thường hãng vận chuyển...';
    listEl.innerHTML = '';

    try {
      const data = await window.GAERUAdmin.request('/api/gaeru_ceo/cod-returns/claims');
      if (!data.claims || data.claims.length === 0) {
        statusEl.textContent = 'Hiện tại không có kiện hàng nào bị hư hỏng hoặc thất lạc cần khiếu nại.';
        return;
      }

      statusEl.textContent = `Có ${data.totalClaims} kiện hàng chuyển hoàn bị lỗi/hư hỏng cần hãng bồi thường:`;
      listEl.innerHTML = data.claims.map(item => `
        <article class="order-card" style="border:1px solid #feb2b2;padding:14px;border-radius:8px;background:#fff5f5;">
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;">
            <strong style="color:#9b2c2c;">Hồ sơ: ${esc(item.orderNumber)}</strong>
            <span style="font-weight:600;">Hãng: <code>${esc(item.carrierId).toUpperCase()}</code> · Mã vận đơn: <mark>${esc(item.trackingNumber)}</mark></span>
          </div>
          <p style="margin:4px 0;font-size:0.9em;color:#4a5568;">
            Khách: ${esc(item.customerName)} (${esc(item.phone)}) · Giá trị yêu cầu bồi thường: <strong style="color:#c53030;">${formatMoney(item.claimAmountVnd)}</strong>
          </p>
          <p style="margin:4px 0;font-size:0.9em;">
            Mức độ: <strong>${item.packageCondition === 'damaged' ? 'Hư hỏng bao bì & thiết bị' : 'Mất hàng / Tráo hàng'}</strong>
            · Người lập biên bản: <strong>${esc(item.inspector)}</strong> lúc ${new Date(item.createdAt).toLocaleString('vi-VN')}
          </p>
          ${item.inspectionNotes ? `<p style="margin:4px 0;font-size:0.85em;color:#742a2a;background:#fff;padding:6px;border-radius:4px;border:1px dashed #feb2b2;">Chi tiết hư hại: ${esc(item.inspectionNotes)}</p>` : ''}
        </article>
      `).join('');
    } catch (err) {
      statusEl.textContent = 'Lỗi tải danh mục bồi thường: ' + err.message;
    }
  }

  // Tự khởi tạo khi DOM sẵn sàng
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
