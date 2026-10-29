(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GAERUPwaInstall = factory();
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

  function getPlatformInfo() {
    return {
      isStandalone,
      isIOS,
      isAndroid,
      canPromptDirectly: Boolean(deferredPrompt)
    };
  }

  function registerServiceWorker() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/gaeru_ceo/notification-worker.js', { scope: '/gaeru_ceo/' })
        .catch(() => {});
    });
  }

  function openAppInstallModal() {
    const existing = document.getElementById('pwa-install-dialog');
    if (existing) existing.remove();

    const dialog = document.createElement('dialog');
    dialog.id = 'pwa-install-dialog';
    dialog.className = 'enterprise-confirm-dialog pwa-install-dialog';
    dialog.setAttribute('aria-labelledby', 'pwa-dialog-title');

    const origin = window.location.origin;
    const adminUrl = origin + '/gaeru_ceo';
    const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(adminUrl);

    let platformHtml = '';
    if (isStandalone) {
      platformHtml = '<div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:14px;color:#065f46;margin:14px 0;font-size:14px;display:flex;align-items:center;gap:10px">' +
        '<span style="font-size:22px">✅</span><div><strong>Ứng dụng đã được cài đặt!</strong><br>Bạn đang sử dụng GAERU CEO ở chế độ ứng dụng độc lập trên thiết bị này.</div>' +
      '</div>';
    } else if (deferredPrompt) {
      platformHtml = '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:16px;margin:14px 0;text-align:center">' +
        '<p style="margin:0 0 12px;font-size:14px;color:#1e40af"><strong>Thiết bị hỗ trợ cài đặt trực tiếp 1 chạm!</strong><br>Bấm nút bên dưới để thêm GAERU CEO vào màn hình chính điện thoại hoặc máy tính.</p>' +
        '<button type="button" class="primary-button" data-pwa-trigger-install style="background:#0055b8;color:#fff;padding:10px 24px;font-size:14px;border-radius:999px;font-weight:600;display:inline-flex;align-items:center;gap:8px">' +
          '📲 Cài đặt ngay lên thiết bị' +
        '</button>' +
      '</div>';
    } else if (isIOS) {
      platformHtml = '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:14px 0;font-size:13px;line-height:1.6">' +
        '<strong style="display:block;color:#0f172a;font-size:14px;margin-bottom:8px">🍎 Hướng dẫn cài đặt trên iPhone / iPad (iOS):</strong>' +
        '<ol style="margin:0;padding-left:20px;color:#334155">' +
          '<li>Mở trang quản trị này trong trình duyệt <strong>Safari</strong>.</li>' +
          '<li>Bấm nút <strong>Chia sẻ (Share)</strong> <span style="font-size:16px">⎋</span> ở thanh công cụ dưới đáy màn hình.</li>' +
          '<li>Cuộn xuống danh sách và chọn <strong>"Thêm vào Màn hình chính" (Add to Home Screen)</strong>.</li>' +
          '<li>Bấm <strong>"Thêm" (Add)</strong> ở góc trên bên phải. Biểu tượng GAERU CEO sẽ xuất hiện trên màn hình điện thoại như app tải từ App Store!</li>' +
        '</ol>' +
      '</div>';
    } else {
      platformHtml = '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:14px 0;font-size:13px;line-height:1.6">' +
        '<strong style="display:block;color:#0f172a;font-size:14px;margin-bottom:8px">🤖 Hướng dẫn cài đặt trên Android / Máy tính (Chrome, Edge):</strong>' +
        '<ol style="margin:0;padding-left:20px;color:#334155">' +
          '<li>Mở menu trình duyệt (biểu tượng <strong>⋮</strong> ở góc trên bên phải).</li>' +
          '<li>Chọn <strong>"Cài đặt ứng dụng"</strong> hoặc <strong>"Thêm vào Màn hình chính"</strong>.</li>' +
          '<li>Xác nhận để tạo ứng dụng độc lập trên điện thoại.</li>' +
        '</ol>' +
      '</div>';
    }

    dialog.innerHTML = '<header style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e2e8f0;padding-bottom:12px">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<img src="/assets/brand/gaeru-app-192.png" alt="GAERU CEO" style="width:38px;height:38px;border-radius:9px;background:#fff;border:1px solid #e2e8f0;padding:2px">' +
          '<div><h2 id="pwa-dialog-title" style="margin:0;font-size:17px;color:#0f172a">Cài đặt App Quản Trị GAERU CEO</h2><p style="margin:2px 0 0;font-size:12px;color:#64748b">Dành cho điện thoại Android &amp; iPhone / iPad (iOS)</p></div>' +
        '</div>' +
        '<button type="button" class="secondary-button" data-close-pwa style="min-height:32px;padding:4px 10px;font-size:16px" aria-label="Đóng">✕</button>' +
      '</header>' +
      '<div style="max-height:calc(85vh - 120px);overflow-y:auto;padding-right:4px">' +
        platformHtml +
        '<div style="border-top:1px solid #e2e8f0;padding-top:14px;margin-top:14px">' +
          '<div style="font-size:13px;font-weight:600;color:#0f172a;margin-bottom:8px">📱 Quét mã QR bằng Camera điện thoại để mở &amp; cài đặt:</div>' +
          '<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">' +
            '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:8px;display:inline-block">' +
              '<img src="' + qrUrl + '" alt="QR Code mở GAERU CEO" width="140" height="140" style="display:block;border-radius:6px">' +
            '</div>' +
            '<div style="flex:1;min-width:200px;font-size:12px;color:#475569;line-height:1.6">' +
              '<div><strong>Đường dẫn quản trị:</strong><br><code style="font-size:11px;background:#f1f5f9;padding:3px 6px;border-radius:4px;word-break:break-all;display:inline-block;margin-top:4px">' + adminUrl + '</code></div>' +
              '<div style="margin-top:8px"><strong>Tính năng khi cài app:</strong></div>' +
              '<ul style="margin:4px 0 0;padding-left:16px">' +
                '<li>Khởi chạy toàn màn hình, mượt mà như app gốc</li>' +
                '<li>Nhận thông báo đơn hàng &amp; tin nhắn chat mới</li>' +
                '<li>Lối tắt truy cập nhanh: Đơn hàng, Chat, Doanh thu</li>' +
              '</ul>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:18px;display:flex;justify-content:flex-end">' +
        '<button type="button" class="secondary-button" data-close-pwa style="min-height:38px;padding:8px 20px">Đóng</button>' +
      '</div>';

    dialog.querySelectorAll('[data-close-pwa]').forEach(btn => {
      btn.onclick = () => {
        if (typeof dialog.close === 'function') dialog.close();
        dialog.remove();
      };
    });

    const triggerBtn = dialog.querySelector('[data-pwa-trigger-install]');
    if (triggerBtn) {
      triggerBtn.onclick = async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          deferredPrompt = null;
          updateInstallButtons();
          if (typeof dialog.close === 'function') dialog.close();
          dialog.remove();
        }
      };
    }

    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function updateInstallButtons() {
    const buttons = document.querySelectorAll('[data-pwa-install-action]');
    buttons.forEach(btn => {
      if (isStandalone) {
        btn.innerHTML = '<span aria-hidden="true">📱</span> <span>App đã cài</span>';
        btn.title = 'Đang chạy ở chế độ App độc lập';
      } else {
        btn.innerHTML = '<span aria-hidden="true">📲</span> <span>Cài đặt App</span>';
        btn.title = 'Cài đặt app GAERU CEO cho Android & iOS';
      }
    });
  }

  function init() {
    registerServiceWorker();

    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferredPrompt = e;
      updateInstallButtons();
      const banner = document.getElementById('pwa-install-banner');
      if (banner && !isStandalone) banner.hidden = false;
    });

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      updateInstallButtons();
      const banner = document.getElementById('pwa-install-banner');
      if (banner) banner.hidden = true;
    });

    document.addEventListener('click', event => {
      const trigger = event.target.closest('[data-pwa-install-action]');
      if (trigger) {
        event.preventDefault();
        openAppInstallModal();
      }
    });

    updateInstallButtons();
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
    updateInstallButtons
  };
});
