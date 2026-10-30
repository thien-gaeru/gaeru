'use strict';

(function () {
  let toastQueue = [];
  let toastIndex = 0;
  let toastEl = null;

  function createToastContainer() {
    if (toastEl) return toastEl;
    toastEl = document.createElement('div');
    toastEl.id = 'gaeru-social-proof-toast';
    toastEl.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 24px;
      z-index: 9998;
      background: rgba(22, 27, 34, 0.95);
      border: 1px solid #30363d;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(8px);
      border-radius: 10px;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: 340px;
      transform: translateY(20px);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      pointer-events: auto;
      cursor: pointer;
    `;

    document.body.appendChild(toastEl);
    return toastEl;
  }

  function showToast(item) {
    if (!item) return;
    const el = createToastContainer();

    const isSimulated = Boolean(item.isSimulated);
    const icon = isSimulated ? '💡' : '⚡';
    const headerTitle = isSimulated
      ? 'Gợi ý sản phẩm nổi bật'
      : `${escapeHtml(item.customerName)} (${escapeHtml(item.location)})`;
    const actionText = isSimulated
      ? `Đang được quan tâm: <strong style="color:#58a6ff;">${escapeHtml(item.productName)}</strong>`
      : `Vừa mua: <strong style="color:#58a6ff;">${escapeHtml(item.productName)}</strong>`;
    const footerMeta = isSimulated
      ? 'Đề xuất mua sắm • Minh họa'
      : `${escapeHtml(item.relativeTime)} • Đã xác thực`;

    el.innerHTML = `
      <div style="font-size:24px;line-height:1;">${icon}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;color:#f0f6fc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${headerTitle}
        </div>
        <div style="font-size:12px;color:#8b949e;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${actionText}
        </div>
        <div style="font-size:11px;color:#6e7681;margin-top:2px;">
          ${footerMeta}
        </div>
      </div>
      <button type="button" class="toast-close-btn" style="background:none;border:none;color:#6e7681;cursor:pointer;font-size:16px;padding:0 4px;" aria-label="Đóng">&times;</button>
    `;

    // Slide in
    el.style.transform = 'translateY(0)';
    el.style.opacity = '1';

    // Event listeners compliant with strict CSP (no inline onclick)
    const closeBtn = el.querySelector('.toast-close-btn');
    if (closeBtn) {
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        el.style.opacity = '0';
      };
    }

    // Click redirect to catalog or product
    el.onclick = () => {
      window.location.href = '/shop.html';
    };

    // Auto hide after 4.5s
    setTimeout(() => {
      if (el) {
        el.style.transform = 'translateY(20px)';
        el.style.opacity = '0';
      }
    }, 4500);
  }

  function scheduleNext() {
    if (!toastQueue.length) return;
    const item = toastQueue[toastIndex % toastQueue.length];
    toastIndex++;
    showToast(item);

    const delay = Math.floor(18000 + Math.random() * 8000); // 18-26 seconds
    setTimeout(scheduleNext, delay);
  }

  async function init() {
    try {
      const res = await fetch('/api/social-proof/recent-sales');
      if (!res.ok) return;
      const data = await res.json();
      if (data.items && data.items.length) {
        toastQueue = data.items;
        // Start first toast after 4s
        setTimeout(scheduleNext, 4000);
      }
    } catch (e) {
      // Non-intrusive fallback
    }
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
