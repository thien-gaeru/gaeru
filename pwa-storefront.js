// GAERU Storefront PWA — Progressive Web App for Mobile Devices (Android & iOS)
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GAERUStorefrontPWA = factory();
})(typeof window === 'object' ? window : globalThis, function() {
  let deferredPrompt = null;

  const isStandalone = typeof window !== 'undefined' && (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator?.standalone === true ||
    document.referrer.includes('android-app://')
  );

  const isIOS = typeof navigator !== 'undefined' && (
    /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );

  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
  const isMobile = isIOS || isAndroid || (typeof window !== 'undefined' && window.innerWidth <= 768);

  function getPlatformInfo() {
    return {
      isStandalone,
      isIOS,
      isAndroid,
      isMobile,
      canPromptDirectly: Boolean(deferredPrompt)
    };
  }

  // 1. Đăng ký Service Worker
  function registerServiceWorker() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .catch((err) => {
          // SW registration failed silently
        });
    });
  }

  // 2. Đồng bộ giỏ hàng với Bottom Nav Badge
  function syncBottomNavCartBadge() {
    const mainCartBadge = document.querySelector('.cart-count');
    const bottomCartBadge = document.querySelector('[data-app-cart-count]');
    if (!bottomCartBadge) return;

    const count = parseInt(mainCartBadge?.textContent || '0', 10);
    if (count > 0 && !mainCartBadge?.hasAttribute('hidden')) {
      bottomCartBadge.textContent = count > 99 ? '99+' : count;
      bottomCartBadge.removeAttribute('hidden');
    } else {
      bottomCartBadge.setAttribute('hidden', '');
    }
  }

  // 3. Render Bottom Navigation Bar cho điện thoại
  function renderBottomNavBar() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('mobile-app-bottom-nav')) return;

    const pathname = window.location.pathname.toLowerCase();
    const isHome = pathname === '/' || pathname.endsWith('index.html');
    const isShop = pathname.includes('shop') || pathname.includes('product');
    const isCart = pathname.includes('cart') || pathname.includes('checkout');
    const isCare = pathname.includes('care') || pathname.includes('support');
    const isAccount = pathname.includes('account');

    const nav = document.createElement('nav');
    nav.id = 'mobile-app-bottom-nav';
    nav.className = 'mobile-app-bottom-nav';
    nav.setAttribute('aria-label', 'Điều hướng ứng dụng GAERU');
    nav.innerHTML = `
      <a href="/" class="app-nav-item ${isHome ? 'is-active' : ''}" data-nav-target="home">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
        <span>Trang chủ</span>
      </a>
      <a href="/shop.html" class="app-nav-item ${isShop && !isCart ? 'is-active' : ''}" data-nav-target="shop">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
        <span>Cửa hàng</span>
      </a>
      <a href="/cart.html" class="app-nav-item ${isCart ? 'is-active' : ''}" data-nav-target="cart">
        <div class="nav-icon-wrap">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
          <span class="app-nav-cart-badge" data-app-cart-count hidden>0</span>
        </div>
        <span>Giỏ hàng</span>
      </a>
      <a href="/care.html" class="app-nav-item ${isCare ? 'is-active' : ''}" data-nav-target="care">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span>Tư vấn AI</span>
      </a>
      <a href="/account.html" class="app-nav-item ${isAccount ? 'is-active' : ''}" data-nav-target="account">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span>Tài khoản</span>
      </a>
    `;

    document.body.appendChild(nav);
    syncBottomNavCartBadge();

    // Theo dõi thay đổi số lượng giỏ hàng
    const cartEl = document.querySelector('.cart-count');
    if (cartEl && window.MutationObserver) {
      new MutationObserver(() => syncBottomNavCartBadge()).observe(cartEl, {
        childList: true,
        characterData: true,
        attributes: true
      });
    }
  }

  // 4. Render Smart Install Banner trên Mobile
  function renderSmartBanner() {
    if (typeof document === 'undefined' || isStandalone) return;
    if (document.getElementById('pwa-smart-banner')) return;
    if (sessionStorage.getItem('gaeru-pwa-banner-dismissed')) return;

    const banner = document.createElement('aside');
    banner.id = 'pwa-smart-banner';
    banner.className = 'pwa-smart-banner';
    banner.setAttribute('aria-label', 'Cài đặt ứng dụng GAERU Store');
    banner.innerHTML = `
      <img src="/assets/brand/gaeru-app-192.png" alt="GAERU App" class="pwa-banner-icon">
      <div class="pwa-banner-text">
        <h3 class="pwa-banner-title">Cài đặt App GAERU Store</h3>
        <p class="pwa-banner-desc">Mua sắm mượt mà, nhận thông báo &amp; ưu đãi</p>
      </div>
      <button type="button" class="pwa-banner-install-btn" data-storefront-pwa-install>Cài đặt</button>
      <button type="button" class="pwa-banner-close-btn" aria-label="Đóng thông báo">✕</button>
    `;

    banner.querySelector('.pwa-banner-close-btn').onclick = () => {
      banner.remove();
      sessionStorage.setItem('gaeru-pwa-banner-dismissed', 'true');
    };

    document.body.prepend(banner);
  }

  // 5. Mở Modal Cài đặt App (Tương thích Android, iOS & Desktop)
  function openAppInstallModal() {
    if (typeof document === 'undefined') return;

    const existing = document.getElementById('pwa-storefront-dialog');
    if (existing) existing.remove();

    const dialog = document.createElement('dialog');
    dialog.id = 'pwa-storefront-dialog';
    dialog.className = 'pwa-storefront-dialog';
    dialog.setAttribute('aria-labelledby', 'pwa-storefront-title');

    const origin = window.location.origin;
    const storeUrl = origin + '/';
    const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(storeUrl);

    let contentHtml = '';

    if (isStandalone) {
      contentHtml = `
        <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:14px;color:#065f46;margin:14px 0;font-size:14px;display:flex;align-items:center;gap:10px">
          <span style="font-size:24px">✅</span>
          <div><strong>Ứng dụng GAERU đã được cài đặt!</strong><br>Bạn đang trải nghiệm mua sắm ở chế độ ứng dụng độc lập trên thiết bị này.</div>
        </div>
      `;
    } else if (deferredPrompt) {
      contentHtml = `
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:14px;padding:18px;margin:14px 0;text-align:center">
          <p style="margin:0 0 14px;font-size:14px;color:#1e40af;line-height:1.5">
            <strong>Thiết bị hỗ trợ cài đặt 1 chạm!</strong><br>
            Nhấn nút bên dưới để thêm GAERU Store vào màn hình chính điện thoại của bạn.
          </p>
          <button type="button" class="primary-button" data-trigger-prompt style="background:#0066cc;color:#fff;border:none;padding:12px 28px;font-size:14px;border-radius:999px;font-weight:600;display:inline-flex;align-items:center;gap:8px;cursor:pointer">
            📲 Cài đặt App ngay
          </button>
        </div>
      `;
    } else if (isIOS) {
      contentHtml = `
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:16px;margin:14px 0;font-size:13px;line-height:1.6">
          <strong style="display:block;color:#0f172a;font-size:14px;margin-bottom:8px">🍎 Hướng dẫn cài đặt trên iPhone / iPad (iOS):</strong>
          <ol style="margin:0;padding-left:20px;color:#334155">
            <li>Mở website GAERU trong trình duyệt <strong>Safari</strong>.</li>
            <li>Bấm biểu tượng <strong>Chia sẻ (Share)</strong> <span style="font-size:16px">⎋</span> ở thanh công cụ đáy màn hình.</li>
            <li>Cuộn xuống và chọn <strong>"Thêm vào Màn hình chính" (Add to Home Screen)</strong>.</li>
            <li>Bấm <strong>"Thêm" (Add)</strong> ở góc trên bên phải màn hình.</li>
          </ol>
          <p style="margin:8px 0 0;font-size:12px;color:#64748b">Biểu tượng GAERU Store sẽ xuất hiện trên màn hình chính như ứng dụng từ App Store!</p>
        </div>
      `;
    } else {
      contentHtml = `
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:16px;margin:14px 0;font-size:13px;line-height:1.6">
          <strong style="display:block;color:#0f172a;font-size:14px;margin-bottom:8px">🤖 Hướng dẫn cài đặt trên Android (Chrome, Cốc Cốc, Samsung Internet):</strong>
          <ol style="margin:0;padding-left:20px;color:#334155">
            <li>Nhấn vào menu trình duyệt (biểu tượng <strong>⋮</strong> góc trên bên phải).</li>
            <li>Chọn <strong>"Cài đặt ứng dụng"</strong> hoặc <strong>"Thêm vào Màn hình chính"</strong>.</li>
            <li>Xác nhận cài đặt để tạo biểu tượng app độc lập trên điện thoại.</li>
          </ol>
        </div>
      `;
    }

    dialog.innerHTML = `
      <header>
        <div class="pwa-dialog-title-wrap">
          <img src="/assets/brand/gaeru-app-192.png" alt="GAERU Store" class="pwa-dialog-icon">
          <div>
            <h2 id="pwa-storefront-title">Cài đặt App GAERU Store</h2>
            <p class="pwa-dialog-sub">Ứng dụng mua sắm cho điện thoại Android &amp; iOS</p>
          </div>
        </div>
        <button type="button" class="pwa-banner-close-btn" data-close-dialog aria-label="Đóng">✕</button>
      </header>

      <div>
        ${contentHtml}

        <div style="border-top:1px solid #f1f5f9;padding-top:14px;margin-top:14px">
          <div style="font-size:13px;font-weight:600;color:#0f172a;margin-bottom:8px">📱 Hoặc quét mã QR bằng Camera điện thoại để cài đặt ngay:</div>
          <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:8px;display:inline-block">
              <img src="${qrUrl}" alt="Mã QR mở GAERU Store" width="130" height="130" style="display:block;border-radius:6px">
            </div>
            <div style="flex:1;min-width:180px;font-size:12px;color:#475569;line-height:1.6">
              <div style="font-weight:600;color:#0f172a">Lợi ích khi cài App GAERU:</div>
              <ul style="margin:4px 0 0;padding-left:16px">
                <li>Khởi chạy tức thì, toàn màn hình không viền</li>
                <li>Theo dõi tiến độ đơn hàng và bảo hành tự động</li>
                <li>Nhận thông báo voucher &amp; ưu đãi giảm giá độc quyền</li>
                <li>Tư vấn kỹ thuật và bảo hành nhanh chóng qua Care+</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      <div style="margin-top:18px;display:flex;justify-content:flex-end">
        <button type="button" class="pwa-banner-install-btn" data-close-dialog style="background:#f1f5f9;color:#334155;border:1px solid #cbd5e1">Đóng</button>
      </div>
    `;

    dialog.querySelectorAll('[data-close-dialog]').forEach(btn => {
      btn.onclick = () => {
        if (typeof dialog.close === 'function') dialog.close();
        dialog.remove();
      };
    });

    const triggerPromptBtn = dialog.querySelector('[data-trigger-prompt]');
    if (triggerPromptBtn) {
      triggerPromptBtn.onclick = async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          deferredPrompt = null;
          if (typeof dialog.close === 'function') dialog.close();
          dialog.remove();
        }
      };
    }

    document.body.appendChild(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  // 6. Khởi tạo toàn bộ mô-đun
  function init() {
    registerServiceWorker();
    renderBottomNavBar();
    renderSmartBanner();

    // Bắt sự kiện beforeinstallprompt (Android / Chrome)
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      renderSmartBanner();
    });

    // Khi app đã cài đặt thành công
    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      const banner = document.getElementById('pwa-smart-banner');
      if (banner) banner.remove();
    });

    // Bắt sự kiện click vào các nút cài đặt app
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-storefront-pwa-install]');
      if (trigger) {
        event.preventDefault();
        if (deferredPrompt) {
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then(({ outcome }) => {
            if (outcome === 'accepted') deferredPrompt = null;
          });
        } else {
          openAppInstallModal();
        }
      }
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  return {
    getPlatformInfo,
    openAppInstallModal,
    renderBottomNavBar,
    syncBottomNavCartBadge
  };
});
