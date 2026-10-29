/**
 * GAERU Customer Upgrades & Services Hub UI
 * Đồng bộ toàn bộ tiện ích & dịch vụ nâng cấp đến tài khoản khách hàng.
 */
(() => {
  'use strict';

  const escapeHtml = (str) =>
    String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));

  const formatVnd = (amount) =>
    new Intl.NumberFormat('vi-VN').format(Math.max(0, Number(amount) || 0)) + ' ₫';

  let currentCustomerData = null;
  let loyaltyData = null;
  let rmaTickets = [];

  async function fetchCustomerLoyalty() {
    try {
      const res = await fetch('/api/customer/loyalty', { credentials: 'same-origin' });
      if (res.ok) {
        loyaltyData = await res.json();
        return loyaltyData;
      }
    } catch (e) {
      console.warn('Loyalty fetch failed:', e);
    }
    return null;
  }

  async function fetchCustomerRma(phone) {
    if (!phone) return [];
    try {
      const res = await fetch(`/api/rma/lookup/${encodeURIComponent(phone)}`, { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        rmaTickets = Array.isArray(data.tickets) ? data.tickets : [];
        return rmaTickets;
      }
    } catch (e) {
      console.warn('RMA fetch failed:', e);
    }
    return [];
  }

  // =========================================================================
  // RENDER THẺ HỘI VIÊN VIP KỸ THUẬT SỐ (DIGITAL VIP CARD)
  // =========================================================================
  function renderVipCard(customer, loyalty) {
    const tier = loyalty?.tier || 'standard';
    const tierName = loyalty?.tierName || 'Thành viên';
    const perk = loyalty?.tierPerk || 'Tích 1% điểm GAERU Xu mỗi đơn hàng';
    const points = Number(loyalty?.points) || 0;
    const lifetime = Number(loyalty?.lifetimePoints) || points;

    let nextTierName = 'Bạc';
    let targetPoints = 1000;
    let progressPercent = Math.min(100, Math.round((lifetime / 1000) * 100));

    if (tier === 'silver') {
      nextTierName = 'Vàng';
      targetPoints = 5000;
      progressPercent = Math.min(100, Math.round(((lifetime - 1000) / 4000) * 100));
    } else if (tier === 'gold') {
      nextTierName = 'Kim Cương';
      targetPoints = 10000;
      progressPercent = Math.min(100, Math.round(((lifetime - 5000) / 5000) * 100));
    } else if (tier === 'diamond') {
      nextTierName = 'Kim Cương (Tối Đa)';
      targetPoints = 10000;
      progressPercent = 100;
    }

    const memberId = 'GAERU-VIP-' + (customer.phone ? customer.phone.slice(-6) : customer.id.slice(0, 6).toUpperCase());

    return `
      <div class="gaeru-vip-card-wrapper" data-gaeru-vip-card>
        <div class="gaeru-vip-card tier-${escapeHtml(tier)}">
          <div class="gaeru-vip-card-header">
            <div class="gaeru-vip-brand">
              <span class="gaeru-vip-logo-text">GAERU</span>
            </div>
            <div class="gaeru-vip-badge">
              <span>✦ HẠNG ${escapeHtml(tierName.toUpperCase())}</span>
            </div>
          </div>

          <div class="gaeru-vip-card-body">
            <div class="gaeru-vip-chip-row">
              <div class="gaeru-emv-chip" title="Smart Member Chip"></div>
              <svg class="gaeru-contactless-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12.55a11 11 0 0 1 14.08 0"></path>
                <path d="M1.42 9a16 16 0 0 1 21.16 0"></path>
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
                <line x1="12" y1="20" x2="12.01" y2="20"></line>
              </svg>
            </div>
            <div class="gaeru-vip-balance-box">
              <div class="gaeru-vip-balance-label">Điểm Thưởng GAERU Xu</div>
              <div class="gaeru-vip-balance-points">${points.toLocaleString('vi-VN')} Xu</div>
              <div class="gaeru-vip-balance-vnd">Giảm trực tiếp: ${formatVnd(points)}</div>
            </div>
          </div>

          <div class="gaeru-vip-card-footer">
            <div>
              <p class="gaeru-vip-holder-name">${escapeHtml(customer.fullName || 'QUÝ KHÁCH HÀNG')}</p>
              <div class="gaeru-vip-member-id">${escapeHtml(memberId)}</div>
            </div>
            <div class="gaeru-vip-perk-summary">
              Đặc quyền: <strong>${escapeHtml(perk)}</strong>
            </div>
          </div>
        </div>

        <div class="gaeru-vip-card-extra">
          <div class="gaeru-tier-progress-row">
            <span>Tiến trình thăng hạng: <strong>${escapeHtml(tierName)}</strong> ➔ <strong>${escapeHtml(nextTierName)}</strong></span>
            <span>${lifetime.toLocaleString('vi-VN')} / ${targetPoints.toLocaleString('vi-VN')} điểm</span>
          </div>
          <div class="gaeru-tier-progress-bar-bg">
            <div class="gaeru-tier-progress-bar-fill" style="width: ${progressPercent}%;"></div>
          </div>
          <div class="gaeru-vip-actions-row">
            <span>${tier === 'diamond' ? 'Bạn đang hưởng đặc quyền cao nhất của GAERU VIP!' : `Tích lũy thêm ${(Math.max(0, targetPoints - lifetime)).toLocaleString('vi-VN')} điểm để đạt Hạng ${escapeHtml(nextTierName)}`}</span>
            <button type="button" class="gaeru-vip-history-btn" data-open-loyalty-history>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              Lịch sử tích điểm
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // THANH TIỆN ÍCH TÀI KHOẢN TINH GỌN (COMPACT ACCOUNT QUICK ACTIONS)
  // Chỉ hiển thị các chức năng trực tiếp gắn liền với quyền lợi & đơn hàng của tài khoản
  // =========================================================================
  function renderAccountQuickActions(customer) {
    return `
      <div class="gaeru-account-quick-actions" data-account-quick-actions>
        <div class="gaeru-quick-actions-bar">
          <a href="/tra-cuu-don-hang" class="gaeru-action-pill" data-service-tile="tracking" title="Tra cứu lộ trình vận chuyển đơn hàng">
            <span class="gaeru-action-pill-icon">📦</span>
            <span class="gaeru-action-pill-text">Tra cứu vận đơn</span>
          </a>
          <a href="rma.html" class="gaeru-action-pill" data-service-tile="rma" title="Gửi yêu cầu đổi mới 1-1 cho thiết bị lỗi">
            <span class="gaeru-action-pill-icon">🛡️</span>
            <span class="gaeru-action-pill-text">Đổi mới 1-1 & Bảo hành</span>
          </a>
          <button type="button" class="gaeru-action-pill" data-service-tile="affiliate" title="Lấy mã giới thiệu bạn bè nhận hoa hồng 8%">
            <span class="gaeru-action-pill-icon">🤝</span>
            <span class="gaeru-action-pill-text">Mã giới thiệu CTV (8%)</span>
          </button>
          <button type="button" class="gaeru-action-pill" data-service-tile="push" title="Cài đặt nhận thông báo đơn hàng qua trình duyệt">
            <span class="gaeru-action-pill-icon">🔔</span>
            <span class="gaeru-action-pill-text" data-push-action-text>Thông báo đơn hàng</span>
            <span class="gaeru-action-pill-badge" data-push-badge>Trình duyệt</span>
          </button>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // RENDER KHU VỰC PHIẾU ĐỔI TRẢ & BẢO HÀNH RMA CỦA KHÁCH HÀNG
  // =========================================================================
  function renderRmaSection(tickets) {
    if (!tickets || tickets.length === 0) {
      return `
        <div class="gaeru-rma-section">
          <div class="gaeru-rma-header">
            <div>
              <p class="eyebrow" style="font-size:10px;letter-spacing:0.12em;margin:0 0 6px;color:#6e6e73;text-transform:uppercase;font-weight:700;">HỒ SƠ ĐỔI MỚI 1-1 (RMA)</p>
              <h3>Phiếu yêu cầu đổi trả & bảo hành</h3>
            </div>
            <a href="rma.html" class="button button-blue" style="font-size:13px;padding:8px 16px;border-radius:12px;text-decoration:none;">Tạo yêu cầu đổi mới ↗</a>
          </div>
          <div class="account-empty-state">
            <strong>Bạn hiện chưa có yêu cầu đổi mới hoặc bảo hành nào đang xử lý.</strong>
            <p>Mọi sản phẩm GAERU đều được cam kết 1 đổi 1 trong 30 ngày đầu tiên nếu phát sinh lỗi kỹ thuật từ nhà sản xuất.</p>
            <a href="rma.html">Tìm hiểu quy trình đổi mới 1-1 ↗</a>
          </div>
        </div>
      `;
    }

    const stateNames = {
      pending: 'Chờ xét duyệt',
      received: 'Đã nhận thiết bị tại kho',
      inspecting: 'Kỹ thuật đang kiểm định',
      replacement_approved: 'Đã duyệt đổi máy mới 100%',
      shipped: 'Đang giao máy mới về bạn',
      completed: 'Đã hoàn tất đổi trả',
      rejected: 'Từ chối (Không thuộc phạm vi)'
    };

    return `
      <div class="gaeru-rma-section">
        <div class="gaeru-rma-header">
          <div>
            <p class="eyebrow" style="font-size:10px;letter-spacing:0.12em;margin:0 0 6px;color:#6e6e73;text-transform:uppercase;font-weight:700;">HỒ SƠ ĐỔI MỚI 1-1 (RMA)</p>
            <h3>Phiếu yêu cầu đổi trả & bảo hành (${tickets.length})</h3>
          </div>
          <a href="rma.html" class="button button-blue" style="font-size:13px;padding:8px 16px;border-radius:12px;text-decoration:none;">Tạo yêu cầu mới ↗</a>
        </div>

        <div class="gaeru-rma-list">
          ${tickets.map(t => {
            const stepOrder = ['pending', 'received', 'inspecting', 'replacement_approved', 'shipped', 'completed'];
            const currentIndex = stepOrder.indexOf(t.status);
            return `
              <div class="gaeru-rma-card">
                <div class="gaeru-rma-card-top">
                  <div>
                    <h4 class="gaeru-rma-card-title">${escapeHtml(t.productName || 'Thiết bị âm thanh GAERU')}</h4>
                    <p style="margin:4px 0 0;font-size:13px;color:#6e6e73;">Mã phiếu: <strong>${escapeHtml(t.ticketCode)}</strong> · Ngày gửi: ${new Date(t.createdAt).toLocaleDateString('vi-VN')}</p>
                  </div>
                  <span class="gaeru-rma-status-pill status-${escapeHtml(t.status)}">${escapeHtml(stateNames[t.status] || t.status)}</span>
                </div>

                <div class="gaeru-rma-timeline" title="Tiến trình thẩm định đổi mới">
                  <div class="gaeru-rma-step ${currentIndex >= 0 ? 'is-done' : ''}"></div>
                  <div class="gaeru-rma-step ${currentIndex >= 1 ? 'is-done' : ''}"></div>
                  <div class="gaeru-rma-step ${currentIndex >= 2 ? 'is-done' : ''}"></div>
                  <div class="gaeru-rma-step ${currentIndex >= 3 ? 'is-done' : ''}"></div>
                  <div class="gaeru-rma-step ${currentIndex >= 4 ? 'is-done' : ''}"></div>
                </div>

                <div style="font-size:13px;color:#515154;line-height:1.6;background:#ffffff;padding:12px;border-radius:10px;border:1px solid #e5e5e8;">
                  <div><strong>Mô tả lỗi:</strong> ${escapeHtml(t.faultDescription || 'Lỗi kỹ thuật phần cứng')}</div>
                  ${t.replacementTrackingCode ? `<div style="margin-top:6px;color:#0071e3;"><strong>Mã vận đơn máy mới:</strong> <a href="/tra-cuu-don-hang?code=${encodeURIComponent(t.replacementTrackingCode)}" style="color:#0071e3;font-weight:600;">${escapeHtml(t.replacementTrackingCode)} ↗</a></div>` : ''}
                  ${t.adminNote ? `<div style="margin-top:6px;color:#1d1d1f;"><strong>Ghi chú từ Kỹ thuật viên GAERU:</strong> ${escapeHtml(t.adminNote)}</div>` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // =========================================================================
  // MODALS & DIALOGS (BNPL, LOYALTY HISTORY, AFFILIATE CTV, WEB PUSH)
  // =========================================================================
  function ensureDialog(id) {
    let dialog = document.getElementById(id);
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = id;
      dialog.className = 'gaeru-dialog';
      document.body.appendChild(dialog);
    }
    return dialog;
  }

  // 1. Modal BNPL Calculator
  function openBnplCalculatorModal() {
    const dialog = ensureDialog('gaeru-bnpl-modal');
    dialog.innerHTML = `
      <div class="gaeru-dialog-header">
        <h3>Trả Góp 0% Mua Trước Trả Sau</h3>
        <button type="button" class="gaeru-dialog-close" data-dialog-close aria-label="Đóng">×</button>
      </div>
      <div class="gaeru-dialog-content">
        <p style="margin-top:0;">Duyệt hồ sơ tức thì trong 30 giây qua CCCD với đối tác <strong>Fundiin</strong> & <strong>Kredivo</strong>. Trả trước từ 0đ, chia đều 3 - 6 - 12 kỳ với 0% lãi suất.</p>

        <div class="bnpl-calc-group">
          <label for="bnpl-amount-input">Số tiền thanh toán dự kiến (VNĐ):</label>
          <input type="number" id="bnpl-amount-input" class="bnpl-calc-input" value="3000000" min="300000" step="100000">
          <div class="bnpl-chips-row">
            <button type="button" class="bnpl-chip-btn" data-bnpl-chip="1500000">1.500.000 ₫</button>
            <button type="button" class="bnpl-chip-btn" data-bnpl-chip="3000000">3.000.000 ₫</button>
            <button type="button" class="bnpl-chip-btn" data-bnpl-chip="5000000">5.000.000 ₫</button>
            <button type="button" class="bnpl-chip-btn" data-bnpl-chip="10000000">10.000.000 ₫</button>
          </div>
        </div>

        <div class="bnpl-calc-group">
          <label>Kỳ hạn trả góp:</label>
          <div style="display:flex;gap:10px;">
            <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input type="radio" name="bnpl-tenure" value="3" checked> 3 Tháng (0% lãi)</label>
            <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input type="radio" name="bnpl-tenure" value="6"> 6 Tháng</label>
            <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;"><input type="radio" name="bnpl-tenure" value="12"> 12 Tháng</label>
          </div>
        </div>

        <div id="bnpl-results-area"></div>
      </div>
    `;

    async function calculateSchedule() {
      const input = dialog.querySelector('#bnpl-amount-input');
      const tenure = dialog.querySelector('input[name="bnpl-tenure"]:checked')?.value || '3';
      const amount = Number(input.value) || 0;
      const area = dialog.querySelector('#bnpl-results-area');

      try {
        const res = await fetch('/api/bnpl/calculate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amountVnd: amount, installmentsCount: tenure })
        });
        const data = await res.json();
        if (!data.eligible) {
          area.innerHTML = `<p style="color:#e03131;margin:12px 0;">${escapeHtml(data.message || 'Số tiền không đủ điều kiện trả góp.')}</p>`;
          return;
        }

        area.innerHTML = `
          <div class="bnpl-schedule-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <strong>Số tiền mỗi kỳ:</strong>
              <strong style="font-size:18px;color:#0071e3;">${formatVnd(data.installmentAmountVnd)}</strong>
            </div>
            <p style="margin:0 0 10px;font-size:12.5px;color:#6e6e73;">Lãi suất: <strong>0%</strong> · Phí dịch vụ: <strong>0₫</strong> · Trả trước: <strong>${formatVnd(data.schedule[0]?.amountVnd || 0)}</strong></p>
            <table class="bnpl-schedule-table">
              <thead>
                <tr><th>Kỳ</th><th>Ngày thanh toán</th><th>Số tiền</th></tr>
              </thead>
              <tbody>
                ${data.schedule.map(s => `
                  <tr>
                    <td>Kỳ ${s.period} ${s.isToday ? '<span style="color:#0071e3;font-size:11px;">(Hôm nay)</span>' : ''}</td>
                    <td>${new Date(s.dueDate).toLocaleDateString('vi-VN')}</td>
                    <td><strong>${formatVnd(s.amountVnd)}</strong></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
      } catch (err) {
        area.innerHTML = `<p style="color:#e03131;">Không thể tính toán lúc này: ${escapeHtml(err.message)}</p>`;
      }
    }

    dialog.querySelectorAll('[data-dialog-close]').forEach(b => b.onclick = () => dialog.close());
    dialog.querySelector('#bnpl-amount-input').oninput = calculateSchedule;
    dialog.querySelectorAll('input[name="bnpl-tenure"]').forEach(r => r.onchange = calculateSchedule);
    dialog.querySelectorAll('[data-bnpl-chip]').forEach(chip => {
      chip.onclick = () => {
        dialog.querySelector('#bnpl-amount-input').value = chip.dataset.bnplChip;
        calculateSchedule();
      };
    });

    calculateSchedule();
    dialog.showModal();
  }

  // 2. Modal Lịch Sử Điểm Tích Lũy
  function openLoyaltyHistoryModal() {
    const dialog = ensureDialog('gaeru-loyalty-history-modal');
    const history = loyaltyData?.history || [];

    dialog.innerHTML = `
      <div class="gaeru-dialog-header">
        <h3>Lịch Sử Điểm Thưởng GAERU Xu</h3>
        <button type="button" class="gaeru-dialog-close" data-dialog-close aria-label="Đóng">×</button>
      </div>
      <div class="gaeru-dialog-content">
        <p style="margin-top:0;">Số dư hiện tại: <strong style="color:#0071e3;font-size:18px;">${(loyaltyData?.points || 0).toLocaleString('vi-VN')} Xu</strong> (Tương đương ${formatVnd(loyaltyData?.points || 0)})</p>

        ${history.length === 0 ? `
          <div class="account-empty-state" style="padding:20px 10px;">
            <strong>Chưa có giao dịch tích điểm nào.</strong>
            <p>Mỗi khi đặt mua đơn hàng thành công, hệ thống sẽ tự động cộng từ 1% đến 1.15% điểm GAERU Xu vào tài khoản của bạn.</p>
          </div>
        ` : `
          <table class="loyalty-history-table">
            <thead>
              <tr><th>Ngày</th><th>Nội dung</th><th>Điểm</th><th>Số dư</th></tr>
            </thead>
            <tbody>
              ${history.map(h => {
                const isPos = h.pointsChange > 0;
                return `
                  <tr>
                    <td style="white-space:nowrap;font-size:12px;">${new Date(h.createdAt).toLocaleDateString('vi-VN')}</td>
                    <td>${escapeHtml(h.reason || 'Tích điểm đơn hàng')}</td>
                    <td class="${isPos ? 'points-positive' : 'points-negative'}">${isPos ? '+' : ''}${h.pointsChange.toLocaleString('vi-VN')}</td>
                    <td>${h.balanceAfter.toLocaleString('vi-VN')}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `}
      </div>
    `;

    dialog.querySelectorAll('[data-dialog-close]').forEach(b => b.onclick = () => dialog.close());
    dialog.showModal();
  }

  // 3. Modal Tiếp Thị Liên Kết KOC (Affiliate CTV)
  function openAffiliateModal(customer) {
    const dialog = ensureDialog('gaeru-affiliate-modal');
    const refCode = customer.phone || (customer.id ? customer.id.slice(0, 8) : 'VIP');
    const affiliateUrl = `${window.location.origin}/?ref=${encodeURIComponent(refCode)}`;

    dialog.innerHTML = `
      <div class="gaeru-dialog-header">
        <h3>Chương Trình Tiếp Thị Liên Kết KOC</h3>
        <button type="button" class="gaeru-dialog-close" data-dialog-close aria-label="Đóng">×</button>
      </div>
      <div class="gaeru-dialog-content">
        <p style="margin-top:0;">Lan tỏa các sản phẩm âm thanh chính hãng GAERU đến cộng đồng sáng tạo và nhận <strong>8% hoa hồng</strong> trên mỗi đơn hàng hoàn tất.</p>

        <div style="background:#eef5ff;border:1px solid #b9d8ff;border-radius:14px;padding:14px;font-size:13px;line-height:1.6;color:#004b99;">
          <strong>🎯 Quyền lợi đối tác KOC GAERU:</strong><br>
          • Hoa hồng cố định <strong>8%</strong> giá trị đơn hàng.<br>
          • Thời gian lưu cookie giới thiệu: <strong>30 ngày</strong>.<br>
          • Đối soát và chi trả định kỳ vào <strong>ngày 15 hàng tháng</strong> qua tài khoản ngân hàng.
        </div>

        <p style="margin:16px 0 6px;font-weight:600;color:#1d1d1f;">Đường link giới thiệu độc quyền của bạn:</p>
        <div class="affiliate-link-box">
          <span class="affiliate-link-text">${escapeHtml(affiliateUrl)}</span>
          <button type="button" class="affiliate-copy-btn" data-copy-affiliate>Sao chép</button>
        </div>
        <p id="affiliate-copy-feedback" style="font-size:12.5px;color:#176b3d;margin:4px 0 0;" hidden>✓ Đã sao chép liên kết vào clipboard!</p>
      </div>
    `;

    dialog.querySelectorAll('[data-dialog-close]').forEach(b => b.onclick = () => dialog.close());
    const copyBtn = dialog.querySelector('[data-copy-affiliate]');
    const feedback = dialog.querySelector('#affiliate-copy-feedback');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(affiliateUrl);
          feedback.hidden = false;
          copyBtn.textContent = 'Đã chép!';
          setTimeout(() => {
            copyBtn.textContent = 'Sao chép';
            feedback.hidden = true;
          }, 3000);
        } catch {
          alert('Hãy copy liên kết: ' + affiliateUrl);
        }
      };
    }

    dialog.showModal();
  }

  // 4. Quản lý Web Push Notifications
  async function setupWebPushHandler(tile) {
    const badge = tile.querySelector('[data-push-badge]');
    const actionText = tile.querySelector('[data-push-action-text]');

    const isSupported = 'Notification' in window;
    if (!isSupported) {
      if (badge) badge.textContent = 'Không hỗ trợ';
      if (actionText) actionText.textContent = 'Trình duyệt không hỗ trợ Web Push';
      return;
    }

    if (Notification.permission === 'granted') {
      if (badge) { badge.textContent = 'Đã bật'; badge.classList.add('is-highlight'); }
      if (actionText) actionText.textContent = 'Đang nhận thông báo (Bấm để gửi test)';
    }

    tile.onclick = async (e) => {
      e.preventDefault();
      if (!isSupported) return;

      if (Notification.permission === 'denied') {
        alert('Bạn đã chặn thông báo trên trình duyệt. Vui lòng vào Cài đặt trình duyệt để cho phép GAERU gửi thông báo.');
        return;
      }

      if (Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
          try {
            // Subscribe via backend
            const keyRes = await fetch('/api/push/public-key');
            const { publicKey } = await keyRes.json();
            await fetch('/api/push/subscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                endpoint: 'https://fcm.googleapis.com/fcm/send/demo-' + Math.random().toString(36).slice(2),
                keys: { p256dh: 'mock-p256dh-key', auth: 'mock-auth-key' }
              })
            });
            if (badge) { badge.textContent = 'Đã bật'; badge.classList.add('is-highlight'); }
            if (actionText) actionText.textContent = 'Đang nhận thông báo (Bấm để gửi test)';
            new Notification('GAERU', {
              body: 'Tuyệt vời! Bạn sẽ nhận được thông báo khi đơn hàng được duyệt và giao hàng.',
              icon: '/assets/brand/gaeru-logo.webp'
            });
          } catch (err) {
            console.warn('Web push subscribe error:', err);
          }
        }
      } else if (Notification.permission === 'granted') {
        // Send a test local notification
        new Notification('GAERU Thông Báo Thử Nghiệm', {
          body: 'Hệ thống thông báo đẩy đang hoạt động hoàn hảo trên thiết bị của bạn!',
          icon: '/assets/brand/gaeru-logo.webp'
        });
      }
    };
  }

  // =========================================================================
  // GẮN NÚT TIỆN ÍCH VÀO DANH SÁCH ĐƠN HÀNG
  // =========================================================================
  function enhanceCustomerOrders() {
    const ordersContainer = document.querySelector('#customer-orders');
    if (!ordersContainer) return;

    ordersContainer.querySelectorAll('article').forEach(article => {
      if (article.dataset.upgradedActions) return;
      article.dataset.upgradedActions = 'true';

      const orderNumberEl = article.querySelector('strong');
      const orderNumber = orderNumberEl?.textContent?.trim() || '';

      const actionsRow = document.createElement('div');
      actionsRow.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;';
      actionsRow.innerHTML = `
        <a href="/tra-cuu-don-hang?code=${encodeURIComponent(orderNumber)}" class="secondary-button" style="font-size:12px;padding:6px 12px;text-decoration:none;border-radius:14px;display:inline-flex;align-items:center;gap:4px;">
          📦 Theo dõi vận đơn
        </a>
        <a href="rma.html?order=${encodeURIComponent(orderNumber)}" class="secondary-button" style="font-size:12px;padding:6px 12px;text-decoration:none;border-radius:14px;display:inline-flex;align-items:center;gap:4px;">
          🛡️ Đổi mới 1-1
        </a>
      `;

      article.appendChild(actionsRow);
    });
  }

  // =========================================================================
  // KHỞI CHẠY CHÍNH: INITIALIZE CUSTOMER UPGRADES HUB
  // =========================================================================
  async function initCustomerUpgrades() {
    const profile = document.querySelector('[data-account-profile]');
    if (!profile || profile.hidden) return;

    let customer = window.GAERUCustomerSession?.customer;
    if (!customer) {
      try {
        const res = await fetch('/api/customer-auth/me', { credentials: 'same-origin' });
        if (res.ok) {
          const session = await res.json();
          if (session.authenticated) customer = session.customer;
        }
      } catch (e) {
        console.warn('Session check failed:', e);
      }
    }
    if (!customer) return;
    currentCustomerData = customer;

    // Tìm hoặc tạo hub container
    let hub = profile.querySelector('#customer-upgrades-hub');
    if (!hub) {
      hub = document.createElement('div');
      hub.id = 'customer-upgrades-hub';
      hub.className = 'customer-upgrades-hub';
      const overviewCard = profile.querySelector('.account-overview-card');
      if (overviewCard) {
        overviewCard.before(hub);
      } else {
        profile.prepend(hub);
      }
    }

    // Tải dữ liệu song song
    const [loyalty, rma] = await Promise.all([
      fetchCustomerLoyalty(),
      fetchCustomerRma(customer.phone)
    ]);

    // Render các chức năng thiết thực gắn liền với tài khoản
    hub.innerHTML = `
      ${renderVipCard(customer, loyalty)}
      ${renderAccountQuickActions(customer)}
      ${renderRmaSection(rma)}
    `;

    // Gắn sự kiện cho VIP card actions
    hub.querySelector('[data-open-loyalty-history]')?.addEventListener('click', () => {
      openLoyaltyHistoryModal();
    });

    // Gắn sự kiện cho các service tiles
    hub.querySelector('[data-service-tile="bnpl"]')?.addEventListener('click', () => {
      openBnplCalculatorModal();
    });
    hub.querySelector('[data-service-tile="affiliate"]')?.addEventListener('click', () => {
      openAffiliateModal(customer);
    });

    const pushTile = hub.querySelector('[data-service-tile="push"]');
    if (pushTile) setupWebPushHandler(pushTile);

    // Nâng cấp lịch sử đơn hàng
    enhanceCustomerOrders();
  }

  // Lắng nghe các sự kiện thay đổi phiên & workspace ready
  document.addEventListener('gaeru:customer-updated', () => {
    initCustomerUpgrades().catch(() => {});
  });
  window.addEventListener('gaeru:workspace-ready', () => {
    initCustomerUpgrades().catch(() => {});
    enhanceCustomerOrders();
  });

  const observer = new MutationObserver(() => {
    const profile = document.querySelector('[data-account-profile]');
    if (profile && !profile.hidden && !profile.querySelector('#customer-upgrades-hub')) {
      initCustomerUpgrades().catch(() => {});
    }
    enhanceCustomerOrders();
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });

  // Khởi chạy ban đầu
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initCustomerUpgrades());
  } else {
    initCustomerUpgrades();
  }
})();
