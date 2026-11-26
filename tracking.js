'use strict';

(function () {
  function formatMoney(amount) {
    if (amount == null) return '0 ₫';
    return Number(amount).toLocaleString('vi-VN') + ' ₫';
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
          ${(() => {
            const rawUrl = String(shipment.trackingUrl || '').trim();
            let isSafeCarrierUrl = false;
            if (rawUrl) {
              const hostPattern = /^https:\/\/(?:[a-z0-9-]+\.)?(?:viettelpost\.vn|viettelpost\.com\.vn|jtexpress\.vn|spx\.vn)(?:[/?#:]|$)/i;
              if (typeof URL === 'function') {
                try {
                  const u = new URL(rawUrl);
                  const h = u.hostname.toLowerCase();
                  isSafeCarrierUrl = u.protocol === 'https:' && ['viettelpost.vn', 'viettelpost.com.vn', 'jtexpress.vn', 'spx.vn'].some(d => h === d || h.endsWith('.' + d));
                } catch (_) {}
              } else {
                isSafeCarrierUrl = hostPattern.test(rawUrl);
              }
            }
            return isSafeCarrierUrl ? `
            <a href="${escapeHtml(rawUrl)}" target="_blank" rel="noopener noreferrer" class="carrier-link">
              Tra cứu trên website hãng ↗
            </a>
          ` : '';
          })()}
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
          <h4>Thông tin nhận hàng (đã ẩn bớt để bảo mật)</h4>
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
            ${(sum.discountVnd - (sum.loyaltyDiscountVnd || 0)) > 0 ? `
              <div class="price-line" style="color:#2e7d32;">
                <span>Giảm giá khuyến mại${sum.voucherCode ? ` (${escapeHtml(sum.voucherCode)})` : ''}:</span>
                <strong>-${formatMoney(sum.discountVnd - (sum.loyaltyDiscountVnd || 0))}</strong>
              </div>
            ` : ''}
            ${sum.loyaltyDiscountVnd > 0 ? `
              <div class="price-line" style="color:#0060c7;">
                <span>Khấu trừ GAERU Xu${sum.loyaltyPointsRedeemed ? ` (${Number(sum.loyaltyPointsRedeemed).toLocaleString('vi-VN')} Xu)` : ''}:</span>
                <strong>-${formatMoney(sum.loyaltyDiscountVnd)}</strong>
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

        ${order.afterSales ? `<section class="rma-warehouse-box" style="margin:14px 0;"><strong>Yêu cầu hỗ trợ / Đổi trả đang mở:</strong> <span class="pill pill-info">${escapeHtml(order.afterSales.status)}</span><div style="margin-top:4px;font-size:13px;color:#515154;">Lý do: ${escapeHtml(order.afterSales.reason || '')}${order.afterSales.resolution ? ' · Xử lý: ' + escapeHtml(order.afterSales.resolution) : ''}</div></section>` : ''}
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

      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      const data = isJson ? await res.json().catch(() => ({})) : {};
      if (!res.ok || (!data.ok && !data.order)) {
        throw new Error(data.error || 'Không tìm thấy đơn hàng hoặc máy chủ đang bận. Vui lòng thử lại.');
      }

      if (resultBox) {
        resultBox.innerHTML = renderOrderResult(data.order);
        resultBox.querySelectorAll('img.item-img').forEach(img => {
          img.addEventListener('error', () => {
            if (!img.src.endsWith('/assets/brand/gaeru-logo.webp')) {
              img.src = '/assets/brand/gaeru-logo.webp';
            }
          }, { once: true });
        });
        resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });

        // Bind copy button
        resultBox.querySelectorAll('[data-copy]').forEach(btn => {
          btn.addEventListener('click', () => {
            const text = btn.dataset.copy;
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(text).then(() => {
                const orig = btn.textContent;
                btn.textContent = 'Đã chép!';
                setTimeout(() => { btn.textContent = orig; }, 2000);
              }).catch(() => {});
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

  function bindPasteButtons(scope) {
    if (!scope || !scope.querySelectorAll) return;
    Array.prototype.slice.call(scope.querySelectorAll('[data-tracking-paste]')).forEach(function (btn) {
      if (btn.dataset.boundPaste) return;
      btn.dataset.boundPaste = '1';
      btn.addEventListener('click', function () {
        const targetName = btn.getAttribute('data-tracking-paste');
        const input = document.getElementById(targetName) || scope.querySelector('[name="' + targetName + '"]');
        if (!input) return;
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
          navigator.clipboard.readText().then(function (clip) {
            const val = String(clip || '').trim();
            if (val) {
              input.value = val.slice(0, 128);
              const old = btn.textContent;
              btn.textContent = '✓ Đã dán';
              setTimeout(function () { btn.textContent = old; }, 1600);
            } else {
              input.focus();
            }
          }).catch(function () { input.focus(); });
        } else {
          input.focus();
        }
      });
    });
  }

  function initRma(){
    const root=document.querySelector('main');if(!root||root.querySelector('[data-rma-portal]'))return;
    const box=document.createElement('section');box.id='rma-section';box.className='rma-portal-card';box.dataset.rmaPortal='';
    box.innerHTML='<h2>Đổi trả &amp; Bảo hành gửi kho (RMA)</h2><p>Nhập mã hồ sơ RMA và khóa bảo mật do GAERU cung cấp, hoặc quản lý trực tiếp tại <a href="/tai-khoan" style="color:#0060c7;font-weight:600;">Tài khoản → Đơn hàng</a>.</p><form data-rma-lookup><div class="rma-form-grid"><label>Mã hồ sơ RMA<div class="tracking-input-wrap"><input name="rma" required maxlength="50" autocomplete="off" placeholder="VD: RMA-261125-AB12"><button type="button" class="tracking-inline-btn" data-tracking-paste="rma">Dán</button></div></label><label>Khóa bảo mật RMA<div class="tracking-input-wrap"><input name="token" type="password" required maxlength="128" autocomplete="off" placeholder="Nhập khóa bảo mật trong email/SMS"><button type="button" class="tracking-inline-btn" data-rma-toggle-token>Hiện</button></div></label></div><button class="button button-blue" type="submit">Xem hồ sơ đổi trả</button></form><p data-rma-status role="status" style="font-size:13.5px;margin:12px 0 0;color:#515154;"></p><div data-rma-details></div>';
    root.append(box);
    bindPasteButtons(box);
    const toggleTokenBtn=box.querySelector('[data-rma-toggle-token]');
    if(toggleTokenBtn){toggleTokenBtn.addEventListener('click',function(){const tk=box.querySelector('input[name="token"]');if(!tk)return;const show=tk.type==='password';tk.type=show?'text':'password';toggleTokenBtn.textContent=show?'Ẩn':'Hiện';});}
    const status=box.querySelector('[data-rma-status]'),details=box.querySelector('[data-rma-details]');
    box.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,button=f.querySelector('button[type="submit"]')||f.querySelector('button'),number=f.elements.rma.value.trim().toUpperCase(),token=f.elements.token.value.trim();button.disabled=true;status.textContent='Đang kiểm tra hồ sơ…';details.replaceChildren();
      try{const res=await fetch('/api/rma/'+encodeURIComponent(number),{credentials:'same-origin',headers:{'X-RMA-Token':token}}),data=await res.json();if(!res.ok)throw Error(data.error||'Chưa xem được hồ sơ.');f.elements.token.value='';const r=data.rma,w=r.inbound.warehouseAddress;
        const rmaStatusLabels={requested:'Chờ duyệt đổi/trả',approved:'Đã duyệt gửi hàng',received:'Kho đã nhận hàng',resolved:'Đã hoàn tất đổi/trả',rejected:'Từ chối đổi/trả'};
        const inboundStatusLabels={pending_shipment:'Chờ gửi về kho',in_transit:'Đang gửi về kho',delivered_to_warehouse:'Kho đã nhận hàng'};
        const whCopyText=[w.facility,w.address,w.contactPhone].filter(Boolean).join(' - ');
        details.innerHTML='<div class="rma-warehouse-box"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;"><strong>Hồ sơ '+escapeHtml(r.rmaNumber)+'</strong><span class="pill pill-info">'+escapeHtml(rmaStatusLabels[r.status]||r.status)+'</span></div><p style="margin:8px 0;">Lý do: '+escapeHtml(r.reason)+'</p><div style="border-top:1px solid #e2e8f0;padding-top:8px;margin-top:8px;"><strong>Địa chỉ gửi hàng về kho:</strong><br>'+escapeHtml(w.facility)+' · '+escapeHtml(w.contactPhone)+'<br>'+escapeHtml(w.address)+' <button type="button" class="copy-btn" data-rma-copy="'+escapeHtml(whCopyText)+'" style="margin-left:6px;">Sao chép địa chỉ</button></div><p data-rma-inbound-line style="margin:8px 0 0;"><strong>Chiều gửi về kho:</strong> '+escapeHtml(r.inbound.carrier||'Chưa cập nhật')+(r.inbound.trackingNumber?' · '+escapeHtml(r.inbound.trackingNumber):'')+'</p>'+(r.outbound.trackingNumber?'<p style="margin:6px 0 0;"><strong>Kiện gửi lại cho bạn:</strong> '+escapeHtml(r.outbound.carrier)+' · '+escapeHtml(r.outbound.trackingNumber)+'</p>':'')+'</div>';
        const copyWhBtn=details.querySelector('[data-rma-copy]');
        if(copyWhBtn){copyWhBtn.addEventListener('click',function(){if(typeof navigator!=='undefined'&&navigator.clipboard?.writeText){navigator.clipboard.writeText(copyWhBtn.getAttribute('data-rma-copy')||'').then(function(){copyWhBtn.textContent='✓ Đã chép';setTimeout(function(){copyWhBtn.textContent='Sao chép địa chỉ';},1600);}).catch(function(){});}});}
        if(!['resolved','rejected'].includes(r.status)){
          const inbound=document.createElement('form');
          const presetCarriers=['Viettel Post','SPX Express','GHN','J&T Express','GHTK'];
          inbound.innerHTML='<div style="margin-top:12px;"><span style="display:block;font-size:13px;font-weight:600;margin-bottom:6px;">Chọn nhanh đơn vị vận chuyển</span><div class="rma-carrier-pills">'+presetCarriers.map(function(c){return '<button type="button" class="rma-carrier-pill" data-carrier-pick="'+escapeHtml(c)+'">'+escapeHtml(c)+'</button>';}).join('')+'</div><div class="rma-form-grid"><label>Hãng vận chuyển<input name="carrier" required minlength="2" maxlength="60" placeholder="VD: Viettel Post"></label><label>Mã vận đơn gửi về kho<div class="tracking-input-wrap"><input name="tracking" required minlength="4" maxlength="60" placeholder="Nhập hoặc dán mã vận đơn"><button type="button" class="tracking-inline-btn" data-tracking-paste="tracking">Dán</button></div></label></div><button type="submit" class="button button-blue">Cập nhật vận đơn gửi về</button><p role="status" style="font-size:13px;margin:8px 0 0;"></p></div>';
          inbound.elements.carrier.value=r.inbound.carrier||'';inbound.elements.tracking.value=r.inbound.trackingNumber||'';
          bindPasteButtons(inbound);
          Array.prototype.slice.call(inbound.querySelectorAll('[data-carrier-pick]')).forEach(function(pill){pill.addEventListener('click',function(){inbound.elements.carrier.value=pill.getAttribute('data-carrier-pick')||'';Array.prototype.slice.call(inbound.querySelectorAll('[data-carrier-pick]')).forEach(function(p){p.classList.toggle('is-active',p===pill);});});});
          inbound.onsubmit=async event=>{event.preventDefault();const send=inbound.querySelector('button[type="submit"]')||inbound.querySelector('button');if(send.disabled)return;send.disabled=true;try{const response=await fetch('/api/rma/'+encodeURIComponent(number)+'/inbound',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-RMA-Token':token},body:JSON.stringify({inboundCarrier:inbound.elements.carrier.value.trim(),inboundTrackingNumber:inbound.elements.tracking.value.trim()})}),saved=await response.json();if(!response.ok)throw Error(saved.error||'Chưa lưu được vận đơn.');inbound.querySelector('[role=status]').textContent=saved.message;const line=details.querySelector('[data-rma-inbound-line]');if(line)line.textContent='Chiều về kho: '+(inboundStatusLabels[saved.rma?.inboundStatus]||inbound.elements.carrier.value.trim())+' · '+(saved.rma?.inboundTrackingNumber||inbound.elements.tracking.value.trim());}catch(error){inbound.querySelector('[role=status]').textContent=error.message;}finally{send.disabled=false;}};details.append(inbound);
        }status.textContent='Đã xác minh hồ sơ. Không chia sẻ khóa RMA cho người khác.';
      }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
    };
  }
  function init() {
    initRma();
    const form = document.getElementById('tracking-form');
    const orderInput = document.getElementById('orderNumber');
    const challengeInput = document.getElementById('challenge');
    const params = new URLSearchParams(window.location.search);
    const orderFromUrl = params.get('order') || params.get('orderNumber') || params.get('code') || '';
    const challengeFromUrl = params.get('phone') || params.get('email') || params.get('challenge') || '';
    if ((params.has('phone') || params.has('email') || params.has('challenge') || params.has('code')) && typeof history !== 'undefined' && typeof history.replaceState === 'function') {
      const cleanParams = new URLSearchParams(window.location.search);
      cleanParams.delete('phone');
      cleanParams.delete('email');
      cleanParams.delete('challenge');
      cleanParams.delete('code');
      if (orderFromUrl && !cleanParams.has('order') && !cleanParams.has('orderNumber')) cleanParams.set('order', orderFromUrl);
      history.replaceState(null, '', window.location.pathname + (cleanParams.size ? '?' + cleanParams : '') + window.location.hash);
    }

    if (orderFromUrl && orderInput) {
      orderInput.value = orderFromUrl;
    }
    if (challengeFromUrl && challengeInput) {
      challengeInput.value = challengeFromUrl;
    }

    let autoLookedUp = false;
    function applyCustomerSessionToTracking() {
      const sess = window.GAERUCustomerSession;
      if (!sess) return;
      const raw = typeof sess.get === 'function' ? sess.get() : sess.customer;
      Promise.resolve(raw).then(function (resolved) {
        const cust = resolved && (resolved.customer || (resolved.id || resolved.email || resolved.phone ? resolved : null));
        if (!cust) return;
        if (challengeInput && !challengeInput.value && (cust.phone || cust.email)) {
          challengeInput.value = cust.phone || cust.email;
        }
        const banner = document.querySelector('[data-tracking-session]');
        if (banner) {
          banner.hidden = false;
          banner.innerHTML = '<span>✓ Đã tự điền thông tin xác thực của <strong>' + escapeHtml(cust.fullName || cust.email || 'bạn') + '</strong></span><a href="/tai-khoan">Xem tất cả đơn trong Tài khoản →</a>';
        }
        if (!autoLookedUp && orderInput?.value?.trim() && challengeInput?.value?.trim()) {
          autoLookedUp = true;
          performLookup(orderInput.value.trim(), challengeInput.value.trim());
        }
      }).catch(function () {});
    }

    if (form) {
      bindPasteButtons(form);
      applyCustomerSessionToTracking();
      document.addEventListener('gaeru:customer-updated', applyCustomerSessionToTracking);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        const orderNumber = orderInput?.value?.trim() || '';
        const challenge = challengeInput?.value?.trim() || '';
        performLookup(orderNumber, challenge);
      });
    }

    if (orderFromUrl && challengeFromUrl && !autoLookedUp) {
      autoLookedUp = true;
      performLookup(orderFromUrl, challengeFromUrl);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
