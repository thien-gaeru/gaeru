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
            <button type="button" class="gaeru-vip-history-btn" data-action="loyalty-history" data-open-loyalty-history>
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
          <button type="button" class="gaeru-action-pill" data-action="open-affiliate" data-service-tile="affiliate" title="Lấy mã giới thiệu bạn bè nhận hoa hồng 8%">
            <span class="gaeru-action-pill-icon">🤝</span>
            <span class="gaeru-action-pill-text">Mã giới thiệu CTV (8%)</span>
          </button>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // MODALS & DIALOGS (LOYALTY HISTORY, AFFILIATE CTV, WEB PUSH)
  // =========================================================================
  function ensureDialog(id) {
    let dialog = document.getElementById(id);
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = id;
      dialog.className = 'gaeru-dialog';
      document.body.appendChild(dialog);
    }
    if (typeof dialog.showModal !== 'function') {
      dialog.showModal = function() {
        this.setAttribute('open', '');
        this.style.display = 'block';
      };
      dialog.close = function() {
        this.removeAttribute('open');
        this.style.display = 'none';
      };
    }
    return dialog;
  }

  // 1. Modal Lịch Sử Điểm Tích Lũy
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
                const isPos = (h.pointsChange || 0) > 0;
                const changeVal = Number(h.pointsChange || 0);
                const balVal = Number(h.balanceAfter || 0);
                const createdDate = h.createdAt ? new Date(h.createdAt).toLocaleDateString('vi-VN') : '—';
                return `
                  <tr>
                    <td style="white-space:nowrap;font-size:12px;">${createdDate}</td>
                    <td>${escapeHtml(h.reason || 'Tích điểm đơn hàng')}</td>
                    <td class="${isPos ? 'points-positive' : 'points-negative'}">${isPos ? '+' : ''}${changeVal.toLocaleString('vi-VN')}</td>
                    <td>${balVal.toLocaleString('vi-VN')}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `}
      </div>
    `;

    dialog.showModal();
  }

  // 3. Modal Tiếp Thị Liên Kết KOC (Affiliate CTV)
  function openAffiliateModal(customer) {
    const cust = customer || currentCustomerData || window.GAERUCustomerSession?.customer || { id: 'VIP' };
    const dialog = ensureDialog('gaeru-affiliate-modal');
    const refCode = cust.phone || (cust.id ? cust.id.slice(0, 8) : 'VIP');
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
          <button type="button" class="affiliate-copy-btn" data-action="copy-affiliate" data-copy-affiliate>Sao chép</button>
        </div>
        <p id="affiliate-copy-feedback" style="font-size:12.5px;color:#176b3d;margin:4px 0 0;" hidden>✓ Đã sao chép liên kết vào clipboard!</p>
      </div>
    `;

    const copyBtn = dialog.querySelector('[data-copy-affiliate]');
    const feedback = dialog.querySelector('#affiliate-copy-feedback');
    if (copyBtn && !copyBtn.dataset.listenerBound) {
      copyBtn.dataset.listenerBound = 'true';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(affiliateUrl);
          feedback.hidden = false;
          copyBtn.textContent = 'Đã chép!';
          window.GAERUNotify?.('Đã sao chép liên kết giới thiệu CTV vào bộ nhớ tạm!');
          setTimeout(() => {
            copyBtn.textContent = 'Sao chép';
            feedback.hidden = true;
          }, 3000);
        } catch {
          (window.GAERUNotify || alert)('Hãy copy liên kết: ' + affiliateUrl);
        }
      });
    }

    dialog.showModal();
  }

  // 3. Đăng ký Service Worker và PushManager thật cho Web Push
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function registerRealPushSubscription() {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return;
    }

    try {
      const keyRes = await fetch('/api/push/public-key', { cache: 'no-store' });
      if (!keyRes.ok) return;
      const keyData = await keyRes.json();
      if (!keyData.enabled || !keyData.publicKey) {
        // VAPID keys chưa cấu hình hoặc tính năng Web Push đang tắt
        return;
      }

      // Đăng ký Service Worker thật trên scope /
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;

      // Kiểm tra hoặc tạo subscription thật qua PushManager
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const applicationServerKey = urlBase64ToUint8Array(keyData.publicKey);
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey
        });
      }

      const subJson = subscription.toJSON();
      if (!subJson.endpoint || !subJson.keys?.p256dh || !subJson.keys?.auth) {
        return;
      }

      // Lấy CSRF token và gửi subscription thật lên backend
      const csrfRes = await fetch('/api/csrf', { credentials: 'same-origin', cache: 'no-store' });
      const csrf = csrfRes.ok ? await csrfRes.json() : null;

      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf?.csrfToken ? { 'X-CSRF-Token': csrf.csrfToken } : {})
        },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: {
            p256dh: subJson.keys.p256dh,
            auth: subJson.keys.auth
          }
        })
      });
    } catch (err) {
      console.warn('[GAERU WebPush] Không thể đăng ký subscription:', err.message);
    }
  }

  function autoPromptWebPush() {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return;
    }

    // Nếu đã được cấp quyền từ trước, tự động đồng bộ subscription thật với máy chủ
    if (Notification.permission === 'granted') {
      registerRealPushSubscription().catch(() => {});
      return;
    }

    // Nếu chưa cấp quyền (default), kích hoạt hỏi quyền khi người dùng tương tác
    if (Notification.permission === 'default') {
      try {
        Notification.requestPermission().then((permission) => {
          if (permission === 'granted') {
            registerRealPushSubscription().catch(() => {});
          }
        }).catch(() => {});
      } catch (err) {}
    }
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

    // Tải dữ liệu khách hàng
    const loyalty = await fetchCustomerLoyalty();

    // Render các chức năng thiết thực gắn liền với tài khoản
    hub.innerHTML = `
      ${renderVipCard(customer, loyalty)}
      ${renderAccountQuickActions(customer)}
    `;

    // Tự động hỏi quyền thông báo đẩy nếu trình duyệt hỗ trợ
    autoPromptWebPush();

    // Nâng cấp lịch sử đơn hàng
    enhanceCustomerOrders();
  }

  // Khai báo global API sẵn sàng ngay lập tức
  window.GAERUCustomerUpgrades = {
    openAffiliateModal: (cust) => openAffiliateModal(cust || currentCustomerData || window.GAERUCustomerSession?.customer || { id: 'VIP' }),
    openLoyaltyHistoryModal,
    autoPromptWebPush,
    initCustomerUpgrades
  };

  // Ủy quyền sự kiện click toàn tài liệu (Global Event Delegation)
  document.addEventListener('click', (e) => {
    // 1. Mở modal lịch sử điểm
    const loyaltyBtn = e.target.closest('[data-open-loyalty-history]') || e.target.closest('[data-action="loyalty-history"]');
    if (loyaltyBtn) {
      e.preventDefault();
      openLoyaltyHistoryModal();
      return;
    }

    // 2. Mở modal Tiếp thị liên kết KOC (Affiliate CTV)
    const affBtn = e.target.closest('[data-service-tile="affiliate"]') || e.target.closest('[data-action="open-affiliate"]');
    if (affBtn) {
      e.preventDefault();
      openAffiliateModal();
      return;
    }

    // 3. Nút đóng modal
    const closeBtn = e.target.closest('[data-dialog-close]') || e.target.closest('[data-action="dialog-close"]');
    if (closeBtn) {
      e.preventDefault();
      const dlg = closeBtn.closest('dialog');
      if (dlg && typeof dlg.close === 'function') dlg.close();
      return;
    }
  });

  // Tự động gọi kích hoạt thông báo khi tải trang
  autoPromptWebPush();

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
