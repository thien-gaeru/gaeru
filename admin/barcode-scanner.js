(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GAERUBarcodeScanner = api;
})(typeof window === 'object' ? window : globalThis, function() {
  'use strict';

  function init({ container, onOrderFound, request }) {
    if (!container) return;

    container.innerHTML = `
      <div class="barcode-scanner-widget">
        <div class="scanner-header">
          <h3>📦 Quét mã vạch đóng hàng siêu tốc</h3>
          <p class="scanner-desc">Dùng camera điện thoại hoặc súng quét mã vạch để kiểm hàng và xuất kho.</p>
        </div>
        <div class="scanner-controls">
          <button type="button" class="action-button" data-action="start-cam">📷 Bật Camera quét</button>
          <button type="button" class="secondary-button" data-action="stop-cam" style="display:none">⏹ Tắt Camera</button>
          <div class="manual-input-row">
            <input type="text" data-field="barcode-code" placeholder="Hoặc nhập mã đơn / mã vận đơn (GHN, GHTK, Viettel, SPX)…" autocomplete="off" />
            <button type="button" class="secondary-button" data-action="lookup-manual">Tìm đơn</button>
          </div>
        </div>
        <div class="video-preview-wrapper" style="display:none;">
          <video autoplay playsinline muted></video>
          <div class="scanner-laser"></div>
        </div>
        <div class="scan-result" data-section="order-details" style="display:none;"></div>
      </div>
    `;

    const startBtn = container.querySelector('[data-action="start-cam"]');
    const stopBtn = container.querySelector('[data-action="stop-cam"]');
    const manualInput = container.querySelector('[data-field="barcode-code"]');
    const lookupBtn = container.querySelector('[data-action="lookup-manual"]');
    const previewWrapper = container.querySelector('.video-preview-wrapper');
    const video = container.querySelector('video');
    const resultBox = container.querySelector('[data-section="order-details"]');

    let stream = null;
    let animId = null;
    let detector = null;
    const desiredFormats = ['qr_code', 'code_128', 'ean_13', 'ean_8'];
    async function ensureDetector() {
      if (detector) return detector;
      try {
        if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
          let formats = desiredFormats;
          if (typeof window.BarcodeDetector.getSupportedFormats === 'function') {
            const supported = await window.BarcodeDetector.getSupportedFormats();
            if (Array.isArray(supported) && supported.length > 0) {
              const filtered = desiredFormats.filter(f => supported.includes(f));
              if (!filtered.length) return null;
              formats = filtered;
            }
          }
          detector = new window.BarcodeDetector({ formats });
        }
      } catch (_) {
        detector = null;
      }
      return detector;
    }
    try {
      if ('BarcodeDetector' in window) {
        detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13', 'ean_8'] });
      }
    } catch (_) {
      detector = null;
    }

    async function lookup(code) {
      const trimmed = String(code || '').trim();
      if (!trimmed) return;
      resultBox.style.display = 'block';
      resultBox.innerHTML = '<p class="loading-text">Đang tra cứu đơn hàng…</p>';

      try {
        const res = await request('/api/gaeru_ceo/barcode/lookup?code=' + encodeURIComponent(trimmed));
        if (!res || !res.order) throw new Error(res?.error || 'Không tìm thấy đơn hàng.');
        renderOrder(res.order);
      } catch (err) {
        resultBox.innerHTML = `<div class="scanner-alert error">${escapeHtml(err.message)}</div>`;
      }
    }

    function renderOrder(order) {
      const items = (order.items || []).map(i => `
        <li class="pack-item">
          <span class="item-name">${escapeHtml(i.name)} (${escapeHtml(i.variantName || 'Chuẩn')})</span>
          <span class="item-qty">x${i.quantity || 1}</span>
        </li>
      `).join('');

      resultBox.innerHTML = `
        <div class="packed-order-card">
          <div class="order-summary-row">
            <strong>Mã đơn: ${escapeHtml(order.orderCode)}</strong>
            <span class="status-badge ${escapeHtml(order.status)}">${escapeHtml(order.status)}</span>
          </div>
          <p>Khách hàng: <strong>${escapeHtml(order.customerName)}</strong> · ${escapeHtml(order.customerPhone)}</p>
          <p class="ship-addr">Địa chỉ: ${escapeHtml(order.shippingAddress)}</p>
          <div class="pack-checklist">
            <h4>Danh sách cần lấy (${(order.items || []).length} món):</h4>
            <ul>${items}</ul>
          </div>
          <div class="pack-actions">
            <button type="button" class="primary-button" data-action="confirm-pack" data-order-id="${escapeHtml(order.id)}">
              ✓ Xác nhận đã đóng gói & Chuyển Đang giao
            </button>
          </div>
        </div>
      `;

      resultBox.querySelector('[data-action="confirm-pack"]')?.addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = 'Đang xử lý…';
        try {
          const packRes = await request('/api/gaeru_ceo/barcode/confirm-pack', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: order.id })
          });
          resultBox.innerHTML = `<div class="scanner-alert success">${escapeHtml(packRes.message)}</div>`;
          if (typeof onOrderFound === 'function') onOrderFound(order);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Thử lại';
          alert('Lỗi: ' + err.message);
        }
      });
    }

    async function startCamera() {
      await ensureDetector();
      if (!('BarcodeDetector' in window) || !detector) {
        alert('Trình duyệt hiện tại chưa hỗ trợ BarcodeDetector để quét camera trực tiếp. Vui lòng sử dụng máy quét mã vạch (súng bắn mã vạch), nhập mã đơn thủ công vào ô tìm kiếm, hoặc dùng Google Chrome.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        });
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        await video.play();
        previewWrapper.style.display = 'block';
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        scanFrame();
      } catch (err) {
        alert('Không thể mở camera: ' + err.message);
      }
    }

    function stopCamera() {
      if (animId) cancelAnimationFrame(animId);
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      }
      previewWrapper.style.display = 'none';
      startBtn.style.display = 'inline-block';
      stopBtn.style.display = 'none';
    }

    function scanFrame() {
      if (!stream || video.readyState !== video.HAVE_ENOUGH_DATA) {
        animId = requestAnimationFrame(scanFrame);
        return;
      }
      // If BarcodeDetector is available natively in Chrome/Safari:
      if (detector) {
        detector.detect(video).then(barcodes => {
          if (barcodes && barcodes.length > 0) {
            const rawVal = barcodes[0].rawValue;
            stopCamera();
            lookup(rawVal);
          } else {
            animId = requestAnimationFrame(scanFrame);
          }
        }).catch(() => {
          animId = requestAnimationFrame(scanFrame);
        });
      } else {
        stopCamera();
      }
    }

    startBtn?.addEventListener('click', startCamera);
    stopBtn?.addEventListener('click', stopCamera);
    lookupBtn?.addEventListener('click', () => lookup(manualInput.value));
    manualInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        lookup(manualInput.value);
      }
    });

    return {
      lookup,
      startCamera,
      stopCamera
    };
  }

  const sharedFormat = (root && root.GAERUAdminShared) || (typeof require === 'function' ? require('./format') : null);
  const escapeHtml = sharedFormat ? sharedFormat.escapeHtml : ((root && root.escapeHtml) || ((v) => String(v ?? '')));

  return { init };
});
