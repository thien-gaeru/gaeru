'use strict';

(function () {
  function formatMoney(amount) {
    if (amount == null) return '0₫';
    return Number(amount).toLocaleString('vi-VN') + '₫';
  }

  function formatDate(isoString) {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString('vi-VN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return isoString;
    }
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getStatusPill(status, statusDesc) {
    let pillClass = 'pill-info';
    switch (status) {
      case 'completed':
        pillClass = 'pill-success';
        break;
      case 'shipped':
        pillClass = 'pill-info';
        break;
      case 'confirmed':
      case 'processing':
        pillClass = 'pill-warning';
        break;
      case 'cancelled':
        pillClass = 'pill-danger';
        break;
      default:
        pillClass = 'pill-neutral';
    }
    return `<span class="pill ${pillClass}">${escapeHtml(statusDesc || status)}</span>`;
  }

  function getPaymentPill(paymentStatus, paymentStatusDesc) {
    const isPaid = paymentStatus === 'paid';
    const pillClass = isPaid ? 'pill-success' : 'pill-warning';
    return `<span class="pill ${pillClass}">${escapeHtml(paymentStatusDesc || (isPaid ? 'Đã thanh toán' : 'Chờ thanh toán'))}</span>`;
  }

  function renderTimeline(timeline) {
    if (!Array.isArray(timeline) || !timeline.length) return '';

    const stepsHtml = timeline.map((item, idx) => {
      const statusClass = `step-${item.status}`;
      let icon = idx + 1;
      if (item.status === 'completed') icon = '✓';
      if (item.status === 'cancelled') icon = '✕';

      return `
        <div class="step-item ${statusClass}">
          <div class="step-icon-wrap">${icon}</div>
          <div class="step-content">
            <div class="step-title">${escapeHtml(item.title)}</div>
            <div class="step-desc">${escapeHtml(item.description)}</div>
            ${item.timestamp ? `<div class="step-time">${formatDate(item.timestamp)}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    return `
      <section class="timeline-section" aria-label="Tiến trình đơn hàng">
        <div class="timeline-title">Lộ trình xử lý đơn hàng</div>
        <div class="stepper-flow">${stepsHtml}</div>
      </section>
    `;
  }

  function renderShipment(shipment) {
    if (!shipment) return '';

    const historyHtml = Array.isArray(shipment.history) && shipment.history.length > 0
      ? `
        <ul class="tracking-history">
          ${shipment.history.slice(0, 5).map(h => `
            <li>
              <span class="hist-time">${formatDate(h.time || h.datetime || h.created_at)}</span>
              <span class="hist-desc">${escapeHtml(h.description || h.status || h.desc)} ${h.location ? `(${escapeHtml(h.location)})` : ''}</span>
            </li>
          `).join('')}
        </ul>
      `
      : '';

    return `
      <section class="shipment-card" aria-label="Thông tin bưu chính & vận đơn">
        <div class="shipment-card-header">
          <div class="carrier-info">
            <span class="carrier-name">${escapeHtml(shipment.carrierName || 'Vận chuyển tiêu chuẩn')}</span>
            ${shipment.trackingNumber ? `
              <span class="waybill-code">
                <span>${escapeHtml(shipment.trackingNumber)}</span>
                <button type="button" class="copy-btn" data-copy="${escapeHtml(shipment.trackingNumber)}">Sao chép</button>
              </span>
            ` : ''}
          </div>
          ${shipment.trackingUrl ? `
            <a href="${escapeHtml(shipment.trackingUrl)}" target="_blank" rel="noopener noreferrer" class="carrier-link">
              Tra cứu trên website hãng ↗
            </a>
          ` : ''}
        </div>
        ${shipment.statusDescription ? `<div><strong>Trạng thái vận chuyển:</strong> ${escapeHtml(shipment.statusDescription)}</div>` : ''}
        ${historyHtml}
      </section>
    `;
  }

  function renderItems(items) {
    if (!Array.isArray(items) || !items.length) return '';

    return `
      <section class="items-section">
        <h3>Sản phẩm trong kiện hàng (${items.reduce((s, it) => s + (it.quantity || 1), 0)} món)</h3>
        <div class="items-list">
          ${items.map(it => {
            const img = it.imageUrl || '/assets/brand/gaeru-logo.webp';
            return `
              <div class="item-row">
                <div class="item-product">
                  <img src="${escapeHtml(img)}" alt="${escapeHtml(it.productName)}" class="item-img" loading="lazy" width="52" height="52">
                  <div>
                    <div class="item-title">${escapeHtml(it.productName)}</div>
                    <div class="item-variant">${escapeHtml(it.variantName || '')} · <code>${escapeHtml(it.sku || '')}</code></div>
                  </div>
                </div>
                <div class="item-price">
                  <div>${formatMoney(it.lineTotalVnd)}</div>
                  <div class="item-qty">${formatMoney(it.unitPriceVnd)} × ${it.quantity}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </section>
    `;
  }

  function renderSummary(order) {
    const cust = order.customer || {};
    const sum = order.summary || {};

    return `
      <section class="summary-grid">
        <div class="summary-col">
          <h4>Địa chỉ nhận hàng (Bảo mật PII)</h4>
          <div class="address-box">
            <strong>${escapeHtml(cust.name || 'Khách hàng')}</strong>
            <div>Số điện thoại: <code>${escapeHtml(cust.phone || '***')}</code></div>
            <div>Email: <code>${escapeHtml(cust.email || '***')}</code></div>
            <div>Địa chỉ: ${escapeHtml(cust.address || '')}${cust.city ? `, ${escapeHtml(cust.city)}` : ''}</div>
          </div>
        </div>
        <div class="summary-col">
          <h4>Chi tiết thanh toán</h4>
          <div class="price-lines">
            <div class="price-line">
              <span>Tạm tính tiền hàng:</span>
              <strong>${formatMoney(sum.subtotalVnd)}</strong>
            </div>
            ${sum.discountVnd > 0 ? `
              <div class="price-line" style="color:#2e7d32;">
                <span>Giảm giá khuyến mại${sum.voucherCode ? ` (${escapeHtml(sum.voucherCode)})` : ''}:</span>
                <strong>-${formatMoney(sum.discountVnd)}</strong>
              </div>
            ` : ''}
            <div class="price-line">
              <span>Phí vận chuyển:</span>
              <strong>${sum.shippingFeeVnd > 0 ? formatMoney(sum.shippingFeeVnd) : 'Miễn phí'}</strong>
            </div>
            <div class="price-line total">
              <span>Tổng thanh toán:</span>
              <strong class="total-amount">${formatMoney(sum.totalVnd)}</strong>
            </div>
            <div style="margin-top:8px;font-size:12px;color:#86868b;">
              Hình thức: <strong>${escapeHtml(order.paymentMethodTitle || order.paymentMethod)}</strong>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function renderOrderResult(order) {
    return `
      <div class="tracking-result-box">
        <header class="result-header">
          <div>
            <h2>
              Đơn hàng <span class="order-code-badge">${escapeHtml(order.orderNumber)}</span>
            </h2>
            <div class="result-meta">Đặt lúc: ${formatDate(order.createdAt)}</div>
          </div>
          <div class="badges-group">
            ${getStatusPill(order.status, order.statusDescription)}
            ${getPaymentPill(order.paymentStatus, order.paymentStatusTitle)}
          </div>
        </header>

        ${renderTimeline(order.timeline)}
        ${renderShipment(order.shipment)}
        ${renderItems(order.items)}
        ${renderSummary(order)}

        <footer class="result-actions">
          <button type="button" class="another-btn" id="btn-search-another">← Tra cứu đơn khác</button>
          <div class="support-hint">
            Cần thay đổi thông tin nhận hàng? <button type="button" class="chat-product-button" style="background:none;border:none;color:#0071e3;font-weight:600;cursor:pointer;padding:0;" data-product-chat="">Chat với CSKH ↗</button> hoặc gọi <a href="tel:0829191080">082 919 1080</a>
          </div>
        </footer>
      </div>
    `;
  }

  async function performLookup(orderNumber, challenge) {
    const errorBox = document.getElementById('tracking-error');
    const resultBox = document.getElementById('tracking-result');
    const submitBtn = document.getElementById('tracking-submit');

    if (errorBox) {
      errorBox.hidden = true;
      errorBox.textContent = '';
    }
    if (resultBox) {
      resultBox.innerHTML = '';
    }

    if (!orderNumber || !challenge) {
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = 'Vui lòng nhập đầy đủ mã đơn hàng và số điện thoại/email đặt hàng.';
      }
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Đang tra cứu dữ liệu…';
    }

    try {
      const res = await fetch('/api/tracking/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber, challenge })
      });

      const data = await res.json();
      if (!res.ok || !data.ok && !data.order) {
        throw new Error(data.error || 'Không tìm thấy đơn hàng phù hợp.');
      }

      if (resultBox) {
        resultBox.innerHTML = renderOrderResult(data.order);
        resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });

        // Bind copy button
        resultBox.querySelectorAll('[data-copy]').forEach(btn => {
          btn.addEventListener('click', () => {
            const text = btn.dataset.copy;
            if (navigator.clipboard) {
              navigator.clipboard.writeText(text).then(() => {
                const orig = btn.textContent;
                btn.textContent = 'Đã chép!';
                setTimeout(() => { btn.textContent = orig; }, 2000);
              });
            }
          });
        });

        // Bind another search button
        const searchAnother = document.getElementById('btn-search-another');
        if (searchAnother) {
          searchAnother.addEventListener('click', () => {
            resultBox.innerHTML = '';
            const inputOrder = document.getElementById('orderNumber');
            if (inputOrder) {
              inputOrder.focus();
              inputOrder.select();
            }
            window.scrollTo({ top: 0, behavior: 'smooth' });
          });
        }
      }
    } catch (err) {
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = err.message || 'Lỗi tra cứu đơn hàng. Vui lòng thử lại.';
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Tra cứu đơn hàng';
      }
    }
  }

  function init() {
    const form = document.getElementById('tracking-form');
    const orderInput = document.getElementById('orderNumber');
    const challengeInput = document.getElementById('challenge');

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        const orderNumber = orderInput?.value?.trim() || '';
        const challenge = challengeInput?.value?.trim() || '';
        performLookup(orderNumber, challenge);
      });
    }

    // Auto-fill and auto-search from URL query params
    const params = new URLSearchParams(window.location.search);
    const orderFromUrl = params.get('order') || params.get('orderNumber') || params.get('code') || '';
    const challengeFromUrl = params.get('phone') || params.get('email') || params.get('challenge') || '';

    if (orderFromUrl && orderInput) {
      orderInput.value = orderFromUrl;
    }
    if (challengeFromUrl && challengeInput) {
      challengeInput.value = challengeFromUrl;
    }

    if (orderFromUrl && challengeFromUrl) {
      performLookup(orderFromUrl, challengeFromUrl);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
