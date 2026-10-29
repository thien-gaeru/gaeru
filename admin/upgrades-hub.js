'use strict';

(() => {
  const ALL_UPGRADES = [
    // Phase 1 (10 upgrades)
    { id: 'sse', phase: 1, name: 'Server-Sent Events (SSE) Realtime', desc: 'Thay thế Polling 3s, cập nhật đơn hàng & chat trực tiếp hai chiều.', endpoint: '/api/realtime/stream', status: 'live' },
    { id: 'queue', phase: 1, name: 'Hàng Đợi Tác Vụ Nền Bền Bỉ (Durable Queue)', desc: 'Xử lý gửi email, đồng bộ sàn, phân tích dữ liệu bất đồng bộ không nghẽn server.', endpoint: 'system_jobs', status: 'live' },
    { id: 'cache', phase: 1, name: 'Bộ Nhớ Đệm Phân Tán (In-Memory LRU Cache)', desc: 'Tăng tốc tải danh mục sản phẩm, cấu hình cửa hàng lên gấp 5 lần.', endpoint: 'cache-manager', status: 'live' },
    { id: 'abandoned-cart', phase: 1, name: 'Thu Hồi Giỏ Hàng Bỏ Quên', desc: 'Tự động nhắc nhở khách để quên hàng qua email sau 1h & 24h kèm voucher.', endpoint: '/api/gaeru_ceo/abandoned-carts', status: 'live' },
    { id: 'loyalty', phase: 1, name: 'Khách Hàng Thân Thiết (Loyalty VIP 4 Hạng)', desc: 'Đồng, Bạc, Vàng, Kim Cương — Tích điểm và tự động chiết khấu theo hạng.', endpoint: '/api/gaeru_ceo/loyalty/tiers', status: 'live' },
    { id: 'ai-rag', phase: 1, name: 'Cơ Sở Tri Thức Ngữ Nghĩa AI (Semantic RAG)', desc: 'Trợ lý AI trả lời thông số kỹ thuật chuẩn xác theo cẩm nang sản phẩm.', endpoint: '/api/gaeru_ceo/chat-knowledge', status: 'live' },
    { id: 'barcode', phase: 1, name: 'Quét Mã Vạch Đóng Hàng PWA (Barcode Scanner)', desc: 'Camera quét mã vạch kiểm tra chính xác sản phẩm trước khi giao bưu tá.', endpoint: '/api/gaeru_ceo/barcode/scan', status: 'live' },
    { id: 'omnichannel', phase: 1, name: 'Đồng Bộ Tồn Kho Đa Kênh (Shopee & TikTok)', desc: 'Tự động trừ kho khi phát sinh đơn trên sàn TMĐT, chống bán vượt tồn.', endpoint: '/api/omnichannel/webhook', status: 'live' },
    { id: 'alerts', phase: 1, name: 'Cảnh Báo Lỗi Hệ Thống Tức Thì (Telegram / Webhook)', desc: 'Báo cáo ngay sự cố thanh toán, đứt kết nối DB cho ban quản trị.', endpoint: '/api/gaeru_ceo/system-alerts', status: 'live' },
    { id: 'backup', phase: 1, name: 'Sao Lưu CSDL Tự Động Mã Hóa AES-256', desc: 'Bảo vệ an toàn dữ liệu khách hàng và lịch sử đơn hàng nhiều tầng.', endpoint: 'scripts/backup-database', status: 'live' },

    // Phase 2 (10 upgrades)
    { id: 'reviews', phase: 2, name: 'Đánh Giá Sản Phẩm 5 Sao (Verified Buyer)', desc: 'Đánh giá có ảnh/video kèm Schema.org JSON-LD AggregateRating tăng SEO Google.', endpoint: '/api/products/reviews', status: 'live' },
    { id: 'tracking', phase: 2, name: 'Cổng Tra Cứu Đơn Hàng Công Khai', desc: 'Khách tự tra cứu tiến độ giao nhận bưu tá Shopee Express mà không cần đăng nhập.', endpoint: '/api/tracking/lookup', status: 'live' },
    { id: 'bundles', phase: 2, name: 'Mua Kèm Deal Sốc & Combo Phụ Kiện', desc: 'Gợi ý mua kèm kẹp điện thoại, chân tripod, bông lọc gió giảm 20%.', endpoint: '/api/product-bundles', status: 'live' },
    { id: 'flash-sale', phase: 2, name: 'Flash Sale & Đếm Ngược Giờ Vàng (FOMO)', desc: 'Banner đếm ngược giảm giá có hạn giờ kích thích quyết định mua nhanh.', endpoint: '/api/flash-sales/active', status: 'live' },
    { id: 'affiliate', phase: 2, name: 'Tiếp Thị Liên Kết KOC (Affiliate CTV 30 Ngày)', desc: 'Theo dõi cookie 30 ngày, tự động tính hoa hồng 8% cho nhà sáng tạo nội dung.', endpoint: '/api/affiliate/stats', status: 'live' },
    { id: 'zalo-zns', phase: 2, name: 'Thông Báo Trạng Thái Đơn Qua Zalo (ZNS)', desc: 'Gửi tin nhắn Zalo tích vàng tự động khi đơn hàng đã bàn giao vận chuyển.', endpoint: '/api/gaeru_ceo/zalo-zns', status: 'live' },
    { id: 'cod-recon', phase: 2, name: 'Đối Soát Tiền Hàng COD Đa Vận Chuyển', desc: 'Tự động đối chiếu chéo số tiền bưu tá thu hộ (GHN, GHTK, Viettel Post, SPX, J&T) và ngân hàng chuyển khoản.', endpoint: '/api/gaeru_ceo/cod-reconciliation', status: 'live' },
    { id: 'search', phase: 2, name: 'Tìm Kiếm Tức Thì Autocomplete Header', desc: 'Gõ từ khóa hiển thị ngay ảnh đại diện và giá bán sau 150ms.', endpoint: '/api/search/autocomplete', status: 'live' },
    { id: 'offline-pwa', phase: 2, name: 'Duyệt Hàng Ngoại Tuyến PWA IndexedDB', desc: 'Xem danh mục và giỏ hàng mượt mà ngay cả khi mất sóng mạng 4G.', endpoint: '/offline-catalog.js', status: 'live' },
    { id: 'web-push', phase: 2, name: 'Thông Báo Đẩy Trình Duyệt (Web Push API)', desc: 'Gửi tin thông báo flash sale và đơn hàng trực tiếp lên màn hình điện thoại.', endpoint: '/api/push/broadcast', status: 'live' },

    // Phase 3 (10 upgrades)
    { id: 'bnpl', phase: 3, name: 'Trả Góp 0% Mua Trước Trả Sau (BNPL)', desc: 'Fundiin & Kredivo chia nhỏ làm 3-4 kỳ thanh toán cho đơn mic/gimbal giá trị cao.', endpoint: '/api/payments/bnpl/calculate', status: 'live' },
    { id: 'quiz', phase: 3, name: 'AI Setup Finder (Tư Vấn Thiết Bị 30s)', desc: 'Trắc nghiệm 3 bước gợi ý combo hoàn chỉnh tiết kiệm 15% chỉ bằng 1-click.', endpoint: '/api/quiz/recommend', status: 'live' },
    { id: 'specs-compare', phase: 3, name: 'So Sánh Thông Số Kỹ Thuật Đối Đầu', desc: 'Bảng so sánh tải trọng, pin, trọng lượng, khử ồn giữa 2-3 sản phẩm cùng loại.', endpoint: '/api/products/compare', status: 'live' },
    { id: 'rma', phase: 3, name: 'Quy Trình Bảo Hành & Đổi Trả RMA Trực Tuyến', desc: 'Tiếp nhận video lỗi, cấp mã phiếu RMA-YYMM-xxxx và cập nhật tiến độ đổi mới 1-1.', endpoint: '/api/rma/lookup', status: 'live' },
    { id: 'capi', phase: 3, name: 'Server-Side Conversion API (Meta & TikTok)', desc: 'Bắn trực tiếp sự kiện Purchase từ Node.js Backend chống thất thoát dữ liệu do AdBlock.', endpoint: '/api/gaeru_ceo/capi/logs', status: 'live' },
    { id: 'rop-forecast', phase: 3, name: 'Dự Báo Tồn Kho & Điểm Nhập Hàng (Smart ROP)', desc: 'Tính tốc độ bán hàng ngày và ROP an toàn, tự sinh phiếu đề xuất nhập kho.', endpoint: '/api/gaeru_ceo/inventory/forecast', status: 'live' },
    { id: 'rfm', phase: 3, name: 'Phân Khúc Khách Hàng RFM Analytics', desc: 'Phân loại 5 nhóm: Champions (VIP), Loyal, Promising, At-Risk, Lost kèm gợi ý chăm sóc.', endpoint: '/api/gaeru_ceo/customers/rfm', status: 'live' },
    { id: 'social-proof', phase: 3, name: 'Bằng Chứng Xã Hội Tức Thì (Recent Sales Toast)', desc: 'Pop-up thông báo khách vừa mua đơn thực tế góc màn hình kích thích chốt đơn.', endpoint: '/api/social-proof/recent-sales', status: 'live' },
    { id: 'avif', phase: 3, name: 'Tối Ưu Phân Phát Ảnh Đa Tầng AVIF', desc: 'Tự động nhận diện header Accept để phục vụ ảnh AVIF nhẹ hơn WebP 25-30%.', endpoint: '/lib/avif-optimizer', status: 'live' },
    { id: 'order-timeline', phase: 3, name: 'Nhật Ký Lịch Sử Đơn Hàng & Vết Kiểm Toán', desc: 'Timeline chi tiết ghi nhận từng thao tác của CSKH, Kho, Cổng thanh toán.', endpoint: '/api/gaeru_ceo/orders/:id/activities', status: 'live' }
  ];

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatMoney(amount) {
    return Number(amount || 0).toLocaleString('vi-VN') + 'đ';
  }

  let cachedCsrfToken = '';

  async function getCsrfToken() {
    if (window.GAERUAdmin && window.GAERUAdmin.csrfToken) {
      return window.GAERUAdmin.csrfToken;
    }
    if (cachedCsrfToken) return cachedCsrfToken;
    try {
      const res = await fetch('/api/csrf', { credentials: 'same-origin', cache: 'no-store' });
      const data = await res.json();
      if (data && data.csrfToken) {
        cachedCsrfToken = data.csrfToken;
        if (window.GAERUAdmin && typeof window.GAERUAdmin.setCsrf === 'function') {
          window.GAERUAdmin.setCsrf(data.csrfToken);
        }
        return data.csrfToken;
      }
    } catch (e) {
      console.warn('Không thể nạp CSRF token:', e);
    }
    return '';
  }

  async function requestApi(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const opts = { ...options, method, credentials: 'same-origin' };
    const headers = new Headers(opts.headers || {});

    if (method !== 'GET') {
      const csrf = await getCsrfToken();
      if (csrf) headers.set('X-CSRF-Token', csrf);
    }

    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
      opts.body = JSON.stringify(opts.body);
    }
    opts.headers = headers;

    const res = await fetch(url, opts);
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}: Không thể hoàn tất yêu cầu.`);
    }
    return data;
  }

  function renderMatrix(filter = 'all') {
    const grid = document.getElementById('upgrades-matrix-container');
    if (!grid) return;

    let items = ALL_UPGRADES;
    if (filter === 'phase1') items = ALL_UPGRADES.filter(u => u.phase === 1);
    if (filter === 'phase2') items = ALL_UPGRADES.filter(u => u.phase === 2);
    if (filter === 'phase3') items = ALL_UPGRADES.filter(u => u.phase === 3);

    grid.innerHTML = items.map(u => `
      <div class="upgrade-card">
        <div class="upgrade-card-top">
          <span class="upgrade-phase-tag upgrade-phase-${u.phase}">Phase ${u.phase}</span>
          <span class="upgrade-status-live">
            <span class="upgrade-dot-pulse"></span> Đang chạy
          </span>
        </div>
        <h3>${escapeHtml(u.name)}</h3>
        <p>${escapeHtml(u.desc)}</p>
        <div class="upgrade-card-footer">
          <code>${escapeHtml(u.endpoint)}</code>
          <span style="color:#0071e3;font-weight:600;">#${u.id}</span>
        </div>
      </div>
    `).join('');
  }

  // =========================================================================
  // TAB 1: RMA TICKETS & CÀI ĐẶT RMA
  // =========================================================================
  async function loadRmaTickets() {
    const tbody = document.getElementById('upgrades-rma-tbody');
    const settingsBox = document.getElementById('rma-settings-container');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:#86868b;">Đang tải danh sách phiếu bảo hành RMA...</td></tr>';

    try {
      const [data, settingsRes] = await Promise.all([
        requestApi('/api/gaeru_ceo/rma/tickets').catch(e => ({ tickets: [], error: e.message })),
        requestApi('/api/gaeru_ceo/rma/config').catch(() => ({ config: null }))
      ]);

      if (data.error) throw new Error(data.error);
      const tickets = data.tickets || [];

      if (!tickets.length) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:#86868b;">Chưa có phiếu RMA nào cần xử lý.</td></tr>';
      } else {
        const statusBadges = {
          pending: 'up-badge-warning',
          received: 'up-badge-info',
          inspecting: 'up-badge-info',
          replacement_approved: 'up-badge-success',
          approved_replacement: 'up-badge-success',
          approved_repair: 'up-badge-success',
          rejected: 'up-badge-critical',
          shipped: 'up-badge-info',
          completed: 'up-badge-neutral'
        };

        if (tbody) {
          tbody.innerHTML = tickets.map(t => `
            <tr>
              <td><strong style="color:#0071e3;">${escapeHtml(t.ticket_code)}</strong></td>
              <td>
                <strong>${escapeHtml(t.customer_name)}</strong>
                <small>${escapeHtml(t.customer_phone)}</small>
              </td>
              <td>
                <strong>${escapeHtml(t.product_name)}</strong>
                <small style="color:#e05252;">${escapeHtml(t.issue_type || 'Lỗi kỹ thuật')}: ${escapeHtml(t.fault_description || t.issue_description || 'Không mô tả')}</small>
              </td>
              <td>
                <span class="up-badge ${statusBadges[t.status] || 'up-badge-neutral'}">
                  ${escapeHtml(t.statusLabel || t.status)}
                </span>
              </td>
              <td>${t.replacement_tracking_code || t.tracking_code_outbound ? `<code>${escapeHtml(t.replacement_tracking_code || t.tracking_code_outbound)}</code>` : '<span style="color:#86868b;">—</span>'}</td>
              <td style="text-align:right;">
                <button class="up-btn-sm" onclick="window.GAERUUpgradesHub.openRmaModal('${t.id}', '${escapeHtml(t.ticket_code)}', '${t.status}')">
                  ⚙️ Cập nhật
                </button>
              </td>
            </tr>
          `).join('');
        }
      }

      // Render Cài Đặt RMA
      if (settingsBox) {
        const cfg = settingsRes.config || {
          returnDays: 30,
          warehouseAddress: 'Kho GAERU Logistics, 123 Đường Số 7, P. An Phú, TP. Thủ Đức, TP. Hồ Chí Minh',
          supportHotline: '0901234567',
          policyText: 'Cam kết 1 đổi 1 nguyên seal trong 30 ngày cho mọi lỗi kỹ thuật phát sinh.'
        };

        settingsBox.innerHTML = `
          <div class="feature-config-card">
            <div class="feature-config-header">
              <h3>⚙️ Cài Đặt Quy Trình Đổi Mới 1-1 (RMA Policy)</h3>
              <span class="up-badge up-badge-success">Đang kích hoạt</span>
            </div>
            <form id="form-rma-config" onsubmit="window.GAERUUpgradesHub.saveRmaConfig(event)">
              <div class="feature-config-grid">
                <div class="feature-config-field">
                  <label>Thời hạn đổi mới 1-1:</label>
                  <input type="number" name="returnDays" class="feature-config-input" value="${cfg.returnDays}" min="7" max="90" required>
                  <p class="feature-config-note">Số ngày kể từ khi đơn hàng giao thành công.</p>
                </div>
                <div class="feature-config-field">
                  <label>Hotline tiếp nhận kỹ thuật:</label>
                  <input type="text" name="supportHotline" class="feature-config-input" value="${escapeHtml(cfg.supportHotline)}" required>
                  <p class="feature-config-note">Số điện thoại liên hệ trên phiếu và cẩm nang hỗ trợ.</p>
                </div>
                <div class="feature-config-field" style="grid-column:1 / -1;">
                  <label>Địa chỉ kho tiếp nhận thiết bị lỗi:</label>
                  <input type="text" name="warehouseAddress" class="feature-config-input" value="${escapeHtml(cfg.warehouseAddress)}" required>
                  <p class="feature-config-note">Địa chỉ bưu cục chuyển phát (GHN / GHTK / Viettel Post / SPX) gửi trả máy về kho thẩm định.</p>
                </div>
              </div>
              <div class="feature-config-actions">
                <span id="rma-config-status" class="feature-config-feedback"></span>
                <button type="submit" class="primary-button">Lưu Cài Đặt RMA</button>
              </div>
            </form>
          </div>
        `;
      }
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#d92d20;padding:20px;">Lỗi tải RMA: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  async function saveRmaConfig(e) {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type="submit"]');
    const statusEl = document.getElementById('rma-config-status');
    const origBtnText = btn ? btn.innerHTML : 'Lưu Cài Đặt RMA';
    const formData = new FormData(form);

    if (btn) { btn.disabled = true; btn.innerHTML = 'Đang kiểm tra...'; }
    if (statusEl) {
      statusEl.className = 'feature-config-feedback';
      statusEl.innerHTML = '<span style="color:#0071e3;">[Thao tác 1/3]</span> Đang kiểm tra tham số bảo hành...';
    }

    const returnDays = Number(formData.get('returnDays'));
    if (isNaN(returnDays) || returnDays < 7 || returnDays > 90) {
      if (statusEl) { statusEl.className = 'feature-config-feedback is-error'; statusEl.innerHTML = '✕ Thời hạn đổi mới phải từ 7 đến 90 ngày.'; }
      if (btn) { btn.disabled = false; btn.innerHTML = origBtnText; }
      return;
    }

    const body = {
      returnDays,
      supportHotline: String(formData.get('supportHotline') || '').trim(),
      warehouseAddress: String(formData.get('warehouseAddress') || '').trim()
    };

    if (btn) btn.innerHTML = '⏳ Đang lưu máy chủ...';
    if (statusEl) {
      statusEl.innerHTML = '<span style="color:#0071e3;">[Thao tác 2/3]</span> Đang ghi dữ liệu vào cơ sở dữ liệu...';
    }

    try {
      await requestApi('/api/gaeru_ceo/rma/config', { method: 'POST', body });
      const nowStr = new Date().toLocaleTimeString('vi-VN');
      if (statusEl) {
        statusEl.className = 'feature-config-feedback is-success';
        statusEl.innerHTML = `✓ <strong>[Thao tác 3/3 Hoàn tất]</strong> Đã lưu và kích hoạt lúc ${nowStr}!`;
      }
      if (btn) { btn.innerHTML = '✓ Đã Lưu'; btn.style.backgroundColor = '#107c41'; }
      setTimeout(() => {
        if (btn) { btn.disabled = false; btn.innerHTML = origBtnText; btn.style.backgroundColor = ''; }
      }, 2500);
    } catch (err) {
      if (statusEl) {
        statusEl.className = 'feature-config-feedback is-error';
        statusEl.innerHTML = '✕ <strong>Lỗi:</strong> ' + escapeHtml(err.message);
      }
      if (btn) { btn.disabled = false; btn.innerHTML = origBtnText; }
    }
  }

  // =========================================================================
  // TAB 2: BNPL TRANSACTIONS & CÀI ĐẶT BNPL
  // =========================================================================
  async function loadBnplTransactions() {
    const tbody = document.getElementById('upgrades-bnpl-tbody');
    const settingsBox = document.getElementById('bnpl-settings-container');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:#86868b;">Đang tải giao dịch BNPL...</td></tr>';

    try {
      const [data, settingsRes] = await Promise.all([
        requestApi('/api/gaeru_ceo/bnpl/transactions').catch(e => ({ transactions: [], error: e.message })),
        requestApi('/api/gaeru_ceo/bnpl/config').catch(() => ({ config: null }))
      ]);

      if (data.error) throw new Error(data.error);
      const list = data.transactions || [];

      if (!list.length) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:#86868b;">Chưa có giao dịch trả góp BNPL nào phát sinh.</td></tr>';
      } else {
        if (tbody) {
          tbody.innerHTML = list.map(tx => `
            <tr>
              <td><strong>${escapeHtml(tx.transaction_id || tx.id)}</strong></td>
              <td><code>${escapeHtml(tx.order_number || tx.order_id)}</code></td>
              <td><span class="up-badge up-badge-info">${escapeHtml((tx.provider || 'BNPL').toUpperCase())}</span></td>
              <td><strong>${formatMoney(tx.amount_vnd)}</strong></td>
              <td>${tx.installments_count || 3} kỳ (${formatMoney(tx.installment_amount_vnd || (tx.amount_vnd / 3))}/kỳ)</td>
              <td><span class="up-badge ${tx.status === 'approved' ? 'up-badge-success' : 'up-badge-warning'}">${escapeHtml(tx.status)}</span></td>
            </tr>
          `).join('');
        }
      }

      // Render Cài Đặt BNPL
      if (settingsBox) {
        const cfg = settingsRes.config || {
          fundiinEnabled: true,
          kredivoEnabled: true,
          minAmountVnd: 300000,
          maxAmountVnd: 30000000,
          supportedTenures: [3, 6, 12]
        };

        settingsBox.innerHTML = `
          <div class="feature-config-card">
            <div class="feature-config-header">
              <h3>⚙️ Cài Đặt Cổng Mua Trước Trả Sau 0% (BNPL Settings)</h3>
              <span class="up-badge up-badge-success">0% Lãi Suất</span>
            </div>
            <form id="form-bnpl-config" onsubmit="window.GAERUUpgradesHub.saveBnplConfig(event)">
              <div class="feature-config-grid">
                <div class="feature-config-field">
                  <label>Cổng Fundiin (3 - 4 kỳ):</label>
                  <select name="fundiinEnabled" class="feature-config-select">
                    <option value="true" ${cfg.fundiinEnabled ? 'selected' : ''}>Bật (Hoạt động)</option>
                    <option value="false" ${!cfg.fundiinEnabled ? 'selected' : ''}>Tạm tắt</option>
                  </select>
                  <p class="feature-config-note">Duyệt hồ sơ nhanh qua CCCD trong 30 giây.</p>
                </div>
                <div class="feature-config-field">
                  <label>Cổng Kredivo (3 - 6 - 12 tháng):</label>
                  <select name="kredivoEnabled" class="feature-config-select">
                    <option value="true" ${cfg.kredivoEnabled ? 'selected' : ''}>Bật (Hoạt động)</option>
                    <option value="false" ${!cfg.kredivoEnabled ? 'selected' : ''}>Tạm tắt</option>
                  </select>
                  <p class="feature-config-note">Hỗ trợ trả góp linh hoạt cho đơn giá trị cao.</p>
                </div>
                <div class="feature-config-field">
                  <label>Số tiền đơn hàng tối thiểu (VNĐ):</label>
                  <input type="number" name="minAmountVnd" class="feature-config-input" value="${cfg.minAmountVnd || 300000}" step="100000" required>
                  <p class="feature-config-note">Tối thiểu để kích hoạt phương thức trả góp.</p>
                </div>
                <div class="feature-config-field">
                  <label>Hạn mức tối đa (VNĐ):</label>
                  <input type="number" name="maxAmountVnd" class="feature-config-input" value="${cfg.maxAmountVnd || 30000000}" step="1000000" required>
                  <p class="feature-config-note">Giới hạn mua hàng trả lời trực tiếp từ cổng.</p>
                </div>
              </div>
              <div class="feature-config-actions">
                <span id="bnpl-config-status" class="feature-config-feedback"></span>
                <button type="submit" class="primary-button">Lưu Cài Đặt BNPL</button>
              </div>
            </form>
          </div>
        `;
      }
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#d92d20;padding:20px;">Lỗi tải BNPL: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  async function saveBnplConfig(e) {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type="submit"]');
    const statusEl = document.getElementById('bnpl-config-status');
    const origBtnText = btn ? btn.innerHTML : 'Lưu Cài Đặt BNPL';
    const formData = new FormData(form);

    if (btn) { btn.disabled = true; btn.innerHTML = 'Đang kiểm tra...'; }
    if (statusEl) {
      statusEl.className = 'feature-config-feedback';
      statusEl.innerHTML = '<span style="color:#0071e3;">[Thao tác 1/3]</span> Đang kiểm tra hạn mức trả góp...';
    }

    const minAmountVnd = Number(formData.get('minAmountVnd')) || 300000;
    const maxAmountVnd = Number(formData.get('maxAmountVnd')) || 30000000;
    if (minAmountVnd >= maxAmountVnd) {
      if (statusEl) { statusEl.className = 'feature-config-feedback is-error'; statusEl.innerHTML = '✕ Hạn mức tối thiểu phải nhỏ hơn hạn mức tối đa.'; }
      if (btn) { btn.disabled = false; btn.innerHTML = origBtnText; }
      return;
    }

    const body = {
      fundiinEnabled: formData.get('fundiinEnabled') === 'true',
      kredivoEnabled: formData.get('kredivoEnabled') === 'true',
      minAmountVnd,
      maxAmountVnd
    };

    if (btn) btn.innerHTML = '⏳ Đang lưu máy chủ...';
    if (statusEl) {
      statusEl.innerHTML = '<span style="color:#0071e3;">[Thao tác 2/3]</span> Đang lưu cổng Fundiin & Kredivo vào hệ thống...';
    }

    try {
      await requestApi('/api/gaeru_ceo/bnpl/config', { method: 'POST', body });
      const nowStr = new Date().toLocaleTimeString('vi-VN');
      if (statusEl) {
        statusEl.className = 'feature-config-feedback is-success';
        statusEl.innerHTML = `✓ <strong>[Thao tác 3/3 Hoàn tất]</strong> Đã lưu và kích hoạt lúc ${nowStr}!`;
      }
      if (btn) { btn.innerHTML = '✓ Đã Lưu'; btn.style.backgroundColor = '#107c41'; }
      setTimeout(() => {
        if (btn) { btn.disabled = false; btn.innerHTML = origBtnText; btn.style.backgroundColor = ''; }
      }, 2500);
    } catch (err) {
      if (statusEl) {
        statusEl.className = 'feature-config-feedback is-error';
        statusEl.innerHTML = '✕ <strong>Lỗi:</strong> ' + escapeHtml(err.message);
      }
      if (btn) { btn.disabled = false; btn.innerHTML = origBtnText; }
    }
  }

  // =========================================================================
  // TAB 3: CAPI LOGS & CÀI ĐẶT CAPI
  // =========================================================================
  async function loadCapiLogs() {
    const tbody = document.getElementById('upgrades-capi-tbody');
    const settingsBox = document.getElementById('capi-settings-container');
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:#86868b;">Đang tải nhật ký CAPI...</td></tr>';

    try {
      const [data, settingsRes] = await Promise.all([
        requestApi('/api/gaeru_ceo/capi/logs').catch(e => ({ logs: [], error: e.message })),
        requestApi('/api/gaeru_ceo/capi/config').catch(() => ({ config: null }))
      ]);

      if (data.error) throw new Error(data.error);
      const logs = data.logs || [];

      if (!logs.length) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:#86868b;">Chưa có sự kiện CAPI nào được ghi nhận. Bấm "Bắn Test Event" để thử nghiệm.</td></tr>';
      } else {
        if (tbody) {
          tbody.innerHTML = logs.map(l => `
            <tr>
              <td><small>${new Date(l.created_at).toLocaleString('vi-VN')}</small></td>
              <td><strong>${escapeHtml(l.event_name)}</strong></td>
              <td><span class="up-badge ${l.platform === 'meta' ? 'up-badge-info' : 'up-badge-neutral'}">${escapeHtml((l.platform || 'CAPI').toUpperCase())}</span></td>
              <td><span class="up-badge ${l.status === 'sent' ? 'up-badge-success' : (l.status === 'simulated' ? 'up-badge-info' : 'up-badge-warning')}">${escapeHtml(l.status)}</span></td>
              <td><code>${escapeHtml(JSON.stringify(l.payload_summary || {}))}</code></td>
            </tr>
          `).join('');
        }
      }

      // Render Cài Đặt CAPI
      if (settingsBox) {
        const cfg = settingsRes.config || {
          metaPixelId: '',
          metaTokenConfigured: false,
          tikTokPixelId: '',
          tikTokTokenConfigured: false,
          testEventCode: 'TEST_EVENT',
          mode: 'simulation'
        };

        settingsBox.innerHTML = `
          <div class="feature-config-card">
            <div class="feature-config-header">
              <h3>⚙️ Cài Đặt Server-Side Conversion API (Meta & TikTok)</h3>
              <span class="up-badge ${cfg.mode === 'live' ? 'up-badge-success' : 'up-badge-info'}">Chế độ: ${cfg.mode.toUpperCase()}</span>
            </div>
            <form id="form-capi-config" onsubmit="window.GAERUUpgradesHub.saveCapiConfig(event)">
              <div class="feature-config-grid">
                <div class="feature-config-field">
                  <label>Meta Pixel ID (Facebook):</label>
                  <input type="text" name="metaPixelId" class="feature-config-input" value="${escapeHtml(cfg.metaPixelId)}" placeholder="Ví dụ: 123456789012345">
                  <p class="feature-config-note">Mã định danh Pixel trên Meta Business Suite.</p>
                </div>
                <div class="feature-config-field">
                  <label>TikTok Pixel ID:</label>
                  <input type="text" name="tikTokPixelId" class="feature-config-input" value="${escapeHtml(cfg.tikTokPixelId)}" placeholder="Ví dụ: C1234567890ABCDEF">
                  <p class="feature-config-note">Mã định danh Pixel trên TikTok Ads Manager.</p>
                </div>
                <div class="feature-config-field">
                  <label>Mã Thử Nghiệm Test Event Code:</label>
                  <input type="text" name="testEventCode" class="feature-config-input" value="${escapeHtml(cfg.testEventCode)}" placeholder="Ví dụ: TEST12345">
                  <p class="feature-config-note">Dùng để kiểm tra sự kiện trong tab Trình quản lý sự kiện.</p>
                </div>
                <div class="feature-config-field">
                  <label>Chế độ vận hành CAPI:</label>
                  <select name="mode" class="feature-config-select">
                    <option value="simulation" ${cfg.mode === 'simulation' ? 'selected' : ''}>Mô phỏng (Simulation Sandbox)</option>
                    <option value="live" ${cfg.mode === 'live' ? 'selected' : ''}>Trực tiếp (Live Production)</option>
                  </select>
                  <p class="feature-config-note">Tự động băm SHA-256 email và số điện thoại trước khi truyền.</p>
                </div>
              </div>
              <div class="feature-config-actions">
                <span id="capi-config-status" class="feature-config-feedback"></span>
                <button type="submit" class="primary-button">Lưu Cài Đặt CAPI</button>
              </div>
            </form>
          </div>
        `;
      }
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#d92d20;padding:20px;">Lỗi tải CAPI: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  async function saveCapiConfig(e) {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type="submit"]');
    const statusEl = document.getElementById('capi-config-status');
    const origBtnText = btn ? btn.innerHTML : 'Lưu Cài Đặt CAPI';
    const formData = new FormData(form);

    if (btn) { btn.disabled = true; btn.innerHTML = 'Đang kiểm tra...'; }
    if (statusEl) {
      statusEl.className = 'feature-config-feedback';
      statusEl.innerHTML = '<span style="color:#0071e3;">[Thao tác 1/3]</span> Đang kiểm tra mã định danh Pixel...';
    }

    const body = {
      metaPixelId: String(formData.get('metaPixelId') || '').trim(),
      tikTokPixelId: String(formData.get('tikTokPixelId') || '').trim(),
      testEventCode: String(formData.get('testEventCode') || '').trim(),
      mode: formData.get('mode') || 'simulation'
    };

    if (btn) btn.innerHTML = '⏳ Đang lưu máy chủ...';
    if (statusEl) {
      statusEl.innerHTML = '<span style="color:#0071e3;">[Thao tác 2/3]</span> Đang cập nhật khóa Pixel vào máy chủ bảo mật...';
    }

    try {
      await requestApi('/api/gaeru_ceo/capi/config', { method: 'POST', body });
      const nowStr = new Date().toLocaleTimeString('vi-VN');
      if (statusEl) {
        statusEl.className = 'feature-config-feedback is-success';
        statusEl.innerHTML = `✓ <strong>[Thao tác 3/3 Hoàn tất]</strong> Đã lưu và kích hoạt lúc ${nowStr}!`;
      }
      if (btn) { btn.innerHTML = '✓ Đã Lưu'; btn.style.backgroundColor = '#107c41'; }
      setTimeout(() => {
        if (btn) { btn.disabled = false; btn.innerHTML = origBtnText; btn.style.backgroundColor = ''; }
      }, 2500);
    } catch (err) {
      if (statusEl) {
        statusEl.className = 'feature-config-feedback is-error';
        statusEl.innerHTML = '✕ <strong>Lỗi:</strong> ' + escapeHtml(err.message);
      }
      if (btn) { btn.disabled = false; btn.innerHTML = origBtnText; }
    }
  }

  // =========================================================================
  // TAB 4: ROP FORECAST
  // =========================================================================
  async function loadInventoryForecast() {
    const tbody = document.getElementById('upgrades-rop-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:#86868b;">Đang tính toán dự báo tồn kho & ROP...</td></tr>';

    try {
      const data = await requestApi('/api/gaeru_ceo/inventory/forecast');
      const list = data.forecastList || [];

      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:#86868b;">Chưa có dữ liệu biến thể sản phẩm.</td></tr>';
        return;
      }

      tbody.innerHTML = list.map(item => {
        let urgencyBadge = 'up-badge-success';
        if (item.urgency === 'out_of_stock' || item.urgency === 'critical') urgencyBadge = 'up-badge-critical';
        else if (item.urgency === 'reorder_needed') urgencyBadge = 'up-badge-warning';

        return `
          <tr>
            <td>
              <strong>${escapeHtml(item.productName)}</strong>
              <small>${escapeHtml(item.variantName)} (${escapeHtml(item.sku)})</small>
            </td>
            <td><strong>${item.currentStock}</strong></td>
            <td>${item.dailyVelocity} /ngày</td>
            <td><strong>${item.reorderPoint}</strong></td>
            <td>${item.daysRemaining !== 'N/A' ? item.daysRemaining + ' ngày' : '—'}</td>
            <td><span class="up-badge ${urgencyBadge}">${escapeHtml(item.statusText)}</span></td>
            <td><strong style="color:#0071e3;">${item.suggestedReorderQty > 0 ? '+' + item.suggestedReorderQty : '—'}</strong></td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#d92d20;padding:20px;">Lỗi tải dự báo tồn kho: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  // =========================================================================
  // TAB 5: RFM ANALYTICS
  // =========================================================================
  async function loadRfmSegmentation() {
    const grid = document.getElementById('upgrades-rfm-cards');
    const tbody = document.getElementById('upgrades-rfm-tbody');
    if (!grid) return;

    try {
      const data = await requestApi('/api/gaeru_ceo/customers/rfm');
      const summary = data.summary || [];
      const customers = data.customers || [];

      grid.innerHTML = summary.map(s => `
        <div class="rfm-card-item">
          <div style="font-size:16px;">${s.badge}</div>
          <strong>${s.customerCount} <small style="font-size:13px;color:#86868b;">(${s.percentage}%)</small></strong>
          <span>${escapeHtml(s.name)}</span>
          <small>${formatMoney(s.totalRevenueVnd)}</small>
        </div>
      `).join('');

      if (tbody) {
        tbody.innerHTML = customers.slice(0, 15).map(c => `
          <tr>
            <td><strong>${escapeHtml(c.customerName)}</strong><small>${escapeHtml(c.phone)}</small></td>
            <td><span class="up-badge up-badge-info">${escapeHtml(c.badge)}</span></td>
            <td>${c.orderCount} đơn</td>
            <td><strong>${formatMoney(c.totalSpendVnd)}</strong></td>
            <td>${c.recencyDays} ngày trước</td>
            <td style="font-size:12px;color:#6e6e73;">${escapeHtml(c.recommendedAction)}</td>
          </tr>
        `).join('');
      }
    } catch (err) {
      grid.innerHTML = `<p style="color:#d92d20;">Lỗi tải RFM: ${escapeHtml(err.message)}</p>`;
    }
  }

  // =========================================================================
  // TAB 6: TRUNG TÂM CÀI ĐẶT TẤT CẢ TÍNH NĂNG (FEATURE SETTINGS HUB)
  // =========================================================================
  async function loadAllSettings() {
    const container = document.getElementById('all-upgrades-settings-container');
    if (!container) return;
    container.innerHTML = '<p style="text-align:center;padding:24px;color:#86868b;">Đang tải thông số cài đặt...</p>';

    try {
      const { settings } = await requestApi('/api/gaeru_ceo/upgrades/settings');
      const shipCfg = settings.shipping || {
        defaultCarrier: 'flexible',
        autoSelectCheapest: true,
        enabledCarriers: ['ghn', 'ghtk', 'viettel', 'spx', 'jt']
      };

      container.innerHTML = `
        <!-- 1. RMA Settings -->
        <div class="feature-config-card" id="card-cfg-rma">
          <div class="feature-config-header">
            <h3>🛡️ Cài Đặt Bảo Hành 1 Đổi 1 & Gửi Phiếu RMA</h3>
            <span class="up-badge up-badge-success">Chính hãng 1-1</span>
          </div>
          <div class="feature-config-grid">
            <div class="feature-config-field">
              <label>Thời hạn đổi mới 1-1 (ngày):</label>
              <input type="number" id="cfg-rma-days" class="feature-config-input" value="${settings.rma?.returnDays || 30}" min="7" max="90">
              <p class="feature-config-note">Số ngày áp dụng đổi mới 1-1 cho lỗi kỹ thuật từ lúc nhận.</p>
            </div>
            <div class="feature-config-field">
              <label>Hotline Kỹ thuật hỗ trợ:</label>
              <input type="text" id="cfg-rma-phone" class="feature-config-input" value="${escapeHtml(settings.rma?.supportHotline || '0829191080')}">
              <p class="feature-config-note">Số tiếp nhận và tư vấn kỹ thuật trực tiếp.</p>
            </div>
            <div class="feature-config-field" style="grid-column:1 / -1;">
              <label>Địa chỉ kho nhận bưu phẩm hoàn:</label>
              <input type="text" id="cfg-rma-addr" class="feature-config-input" value="${escapeHtml(settings.rma?.warehouseAddress || '')}">
              <p class="feature-config-note">Địa chỉ bưu tá (GHN, GHTK, Viettel, SPX) chuyển máy về thẩm định.</p>
            </div>
          </div>
          <div class="feature-config-actions">
            <span id="status-setting-rma" class="feature-config-feedback"></span>
            <button type="button" class="primary-button" id="btn-save-rma" onclick="window.GAERUUpgradesHub.saveSettingModule('rma')">Lưu Cài Đặt RMA</button>
          </div>
        </div>

        <!-- 2. BNPL Settings -->
        <div class="feature-config-card" id="card-cfg-bnpl">
          <div class="feature-config-header">
            <h3>💳 Cài Đặt Mua Trước Trả Sau BNPL (Fundiin & Kredivo)</h3>
            <span class="up-badge up-badge-info">0% Lãi Suất</span>
          </div>
          <div class="feature-config-grid">
            <div class="feature-config-field">
              <label>Cổng Fundiin (3 - 4 kỳ):</label>
              <select id="cfg-bnpl-fundiin" class="feature-config-select">
                <option value="true" ${settings.bnpl?.fundiinEnabled ? 'selected' : ''}>Kích hoạt (Bật)</option>
                <option value="false" ${!settings.bnpl?.fundiinEnabled ? 'selected' : ''}>Tạm tắt</option>
              </select>
            </div>
            <div class="feature-config-field">
              <label>Cổng Kredivo (3 - 6 - 12 tháng):</label>
              <select id="cfg-bnpl-kredivo" class="feature-config-select">
                <option value="true" ${settings.bnpl?.kredivoEnabled ? 'selected' : ''}>Kích hoạt (Bật)</option>
                <option value="false" ${!settings.bnpl?.kredivoEnabled ? 'selected' : ''}>Tạm tắt</option>
              </select>
            </div>
            <div class="feature-config-field">
              <label>Đơn hàng tối thiểu (VNĐ):</label>
              <input type="number" id="cfg-bnpl-min" class="feature-config-input" value="${settings.bnpl?.minAmountVnd || 300000}" step="50000">
            </div>
            <div class="feature-config-field">
              <label>Đơn hàng tối đa (VNĐ):</label>
              <input type="number" id="cfg-bnpl-max" class="feature-config-input" value="${settings.bnpl?.maxAmountVnd || 30000000}" step="1000000">
            </div>
          </div>
          <div class="feature-config-actions">
            <span id="status-setting-bnpl" class="feature-config-feedback"></span>
            <button type="button" class="primary-button" id="btn-save-bnpl" onclick="window.GAERUUpgradesHub.saveSettingModule('bnpl')">Lưu Cài Đặt BNPL</button>
          </div>
        </div>

        <!-- 3. Server CAPI Settings -->
        <div class="feature-config-card" id="card-cfg-capi">
          <div class="feature-config-header">
            <h3>🎯 Cài Đặt Server-Side Conversion API (Meta & TikTok)</h3>
            <span class="up-badge up-badge-success">Chống AdBlock</span>
          </div>
          <div class="feature-config-grid">
            <div class="feature-config-field">
              <label>Meta Pixel ID (Facebook):</label>
              <input type="text" id="cfg-capi-meta" class="feature-config-input" value="${escapeHtml(settings.capi?.metaPixelId || '')}" placeholder="123456789012345">
            </div>
            <div class="feature-config-field">
              <label>TikTok Pixel ID:</label>
              <input type="text" id="cfg-capi-tiktok" class="feature-config-input" value="${escapeHtml(settings.capi?.tikTokPixelId || '')}" placeholder="C1234567890ABCDEF">
            </div>
            <div class="feature-config-field">
              <label>Test Event Code:</label>
              <input type="text" id="cfg-capi-test" class="feature-config-input" value="${escapeHtml(settings.capi?.testEventCode || '')}" placeholder="TEST12345">
            </div>
            <div class="feature-config-field">
              <label>Chế độ vận hành CAPI:</label>
              <select id="cfg-capi-mode" class="feature-config-select">
                <option value="simulation" ${settings.capi?.mode === 'simulation' ? 'selected' : ''}>Mô phỏng (Simulation Sandbox)</option>
                <option value="live" ${settings.capi?.mode === 'live' ? 'selected' : ''}>Trực tiếp (Live Production)</option>
              </select>
            </div>
          </div>
          <div class="feature-config-actions">
            <span id="status-setting-capi" class="feature-config-feedback"></span>
            <button type="button" class="primary-button" id="btn-save-capi" onclick="window.GAERUUpgradesHub.saveSettingModule('capi')">Lưu Cài Đặt CAPI</button>
          </div>
        </div>

        <!-- 4. Loyalty VIP Settings -->
        <div class="feature-config-card" id="card-cfg-loyalty">
          <div class="feature-config-header">
            <h3>✦ Cài Đặt Điểm Thưởng Khách Hàng Thân Thiết (Loyalty VIP)</h3>
            <span class="up-badge up-badge-warning">4 Hạng Thẻ VIP</span>
          </div>
          <div class="feature-config-grid">
            <div class="feature-config-field">
              <label>Tỷ lệ tích điểm đơn hàng (%):</label>
              <input type="number" id="cfg-loyalty-rate" class="feature-config-input" value="${settings.loyalty?.earnRatePercent || 1.0}" step="0.1" min="0" max="20">
            </div>
            <div class="feature-config-field">
              <label>Ngưỡng thăng Hạng Bạc (Điểm):</label>
              <input type="number" id="cfg-loyalty-silver" class="feature-config-input" value="${settings.loyalty?.silverPointsThreshold || 1000}">
            </div>
            <div class="feature-config-field">
              <label>Ngưỡng thăng Hạng Vàng (Điểm):</label>
              <input type="number" id="cfg-loyalty-gold" class="feature-config-input" value="${settings.loyalty?.goldPointsThreshold || 5000}">
            </div>
            <div class="feature-config-field">
              <label>Ngưỡng Hạng Kim Cương (Điểm):</label>
              <input type="number" id="cfg-loyalty-diamond" class="feature-config-input" value="${settings.loyalty?.diamondPointsThreshold || 10000}">
            </div>
          </div>
          <div class="feature-config-actions">
            <span id="status-setting-loyalty" class="feature-config-feedback"></span>
            <button type="button" class="primary-button" id="btn-save-loyalty" onclick="window.GAERUUpgradesHub.saveSettingModule('loyalty')">Lưu Cài Đặt Loyalty</button>
          </div>
        </div>

        <!-- 5. Affiliate CTV KOC Settings -->
        <div class="feature-config-card" id="card-cfg-affiliate">
          <div class="feature-config-header">
            <h3>🤝 Cài Đặt Tiếp Thị Liên Kết KOC (Affiliate CTV)</h3>
            <span class="up-badge up-badge-info">Hoa Hồng Đối Tác</span>
          </div>
          <div class="feature-config-grid">
            <div class="feature-config-field">
              <label>Tỷ lệ hoa hồng mặc định (%):</label>
              <input type="number" id="cfg-aff-comm" class="feature-config-input" value="${settings.affiliate?.commissionPercent || 8}" min="1" max="50">
            </div>
            <div class="feature-config-field">
              <label>Thời gian lưu Cookie (ngày):</label>
              <input type="number" id="cfg-aff-cookie" class="feature-config-input" value="${settings.affiliate?.cookieDays || 30}" min="1" max="90">
            </div>
            <div class="feature-config-field">
              <label>Mức rút tiền tối thiểu (VNĐ):</label>
              <input type="number" id="cfg-aff-payout" class="feature-config-input" value="${settings.affiliate?.minPayoutVnd || 200000}" step="50000">
            </div>
            <div class="feature-config-field">
              <label>Ngày chi trả hàng tháng:</label>
              <input type="number" id="cfg-aff-day" class="feature-config-input" value="${settings.affiliate?.payoutDayOfMonth || 15}" min="1" max="28">
            </div>
          </div>
          <div class="feature-config-actions">
            <span id="status-setting-affiliate" class="feature-config-feedback"></span>
            <button type="button" class="primary-button" id="btn-save-affiliate" onclick="window.GAERUUpgradesHub.saveSettingModule('affiliate')">Lưu Cài Đặt Tiếp Thị</button>
          </div>
        </div>

        <!-- 6. Web Push Settings -->
        <div class="feature-config-card" id="card-cfg-webPush">
          <div class="feature-config-header">
            <h3>🔔 Cài Đặt Thông Báo Đẩy Web Push Trình Duyệt</h3>
            <span class="up-badge up-badge-success">Thời gian thực</span>
          </div>
          <div class="feature-config-grid">
            <div class="feature-config-field">
              <label>Thông báo khi có đơn hàng mới:</label>
              <select id="cfg-push-order" class="feature-config-select">
                <option value="true" ${settings.webPush?.autoNotifyNewOrder ? 'selected' : ''}>Bật (Tự động)</option>
                <option value="false" ${!settings.webPush?.autoNotifyNewOrder ? 'selected' : ''}>Tắt</option>
              </select>
            </div>
            <div class="feature-config-field">
              <label>Thông báo khi xuất kho bưu tá:</label>
              <select id="cfg-push-ship" class="feature-config-select">
                <option value="true" ${settings.webPush?.autoNotifyShipping ? 'selected' : ''}>Bật (Tự động)</option>
                <option value="false" ${!settings.webPush?.autoNotifyShipping ? 'selected' : ''}>Tắt</option>
              </select>
            </div>
            <div class="feature-config-field">
              <label>Thông báo chiến dịch Flash Sale:</label>
              <select id="cfg-push-sale" class="feature-config-select">
                <option value="true" ${settings.webPush?.autoNotifyFlashSale ? 'selected' : ''}>Bật (Tự động)</option>
                <option value="false" ${!settings.webPush?.autoNotifyFlashSale ? 'selected' : ''}>Tắt</option>
              </select>
            </div>
          </div>
          <div class="feature-config-actions">
            <span id="status-setting-webPush" class="feature-config-feedback"></span>
            <button type="button" class="primary-button" id="btn-save-webPush" onclick="window.GAERUUpgradesHub.saveSettingModule('webPush')">Lưu Cài Đặt Web Push</button>
          </div>
        </div>

        <!-- 7. Multi-Carrier Shipping Settings -->
        <div class="feature-config-card" id="card-cfg-shipping">
          <div class="feature-config-header">
            <h3>🚚 Cài Đặt Vận Chuyển Đa Kênh (GHN, GHTK, Viettel, SPX, J&T)</h3>
            <span class="up-badge up-badge-info">Đa Đối Tác</span>
          </div>
          <div class="feature-config-grid">
            <div class="feature-config-field">
              <label>Chính sách phân bổ đơn vị giao hàng:</label>
              <select id="cfg-ship-default" class="feature-config-select">
                <option value="flexible" ${shipCfg.defaultCarrier === 'flexible' ? 'selected' : ''}>Linh hoạt đa kênh (Theo khách chọn & tối ưu tuyến)</option>
                <option value="ghn" ${shipCfg.defaultCarrier === 'ghn' ? 'selected' : ''}>Ưu tiên Giao Hàng Nhanh (GHN)</option>
                <option value="ghtk" ${shipCfg.defaultCarrier === 'ghtk' ? 'selected' : ''}>Ưu tiên Giao Hàng Tiết Kiệm (GHTK)</option>
                <option value="viettel" ${shipCfg.defaultCarrier === 'viettel' ? 'selected' : ''}>Ưu tiên Viettel Post</option>
                <option value="spx" ${shipCfg.defaultCarrier === 'spx' ? 'selected' : ''}>Ưu tiên Shopee Express (SPX)</option>
                <option value="jt" ${shipCfg.defaultCarrier === 'jt' ? 'selected' : ''}>Ưu tiên J&T Express</option>
              </select>
              <p class="feature-config-note">Không cố định đơn vị độc quyền, cho phép tối ưu cước phí và thời gian giao.</p>
            </div>
            <div class="feature-config-field">
              <label>Tự động đề xuất đơn vị cước phí rẻ nhất:</label>
              <select id="cfg-ship-cheapest" class="feature-config-select">
                <option value="true" ${shipCfg.autoSelectCheapest ? 'selected' : ''}>Bật (Tự động chọn tuyến rẻ & nhanh)</option>
                <option value="false" ${!shipCfg.autoSelectCheapest ? 'selected' : ''}>Tắt</option>
              </select>
            </div>
            <div class="feature-config-field" style="grid-column:1 / -1;">
              <label>Các hãng vận chuyển kích hoạt phục vụ:</label>
              <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:6px;">
                <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;"><input type="checkbox" id="cfg-carrier-ghn" ${shipCfg.enabledCarriers?.includes('ghn') ? 'checked' : ''}> Giao Hàng Nhanh (GHN)</label>
                <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;"><input type="checkbox" id="cfg-carrier-ghtk" ${shipCfg.enabledCarriers?.includes('ghtk') ? 'checked' : ''}> Giao Hàng Tiết Kiệm (GHTK)</label>
                <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;"><input type="checkbox" id="cfg-carrier-viettel" ${shipCfg.enabledCarriers?.includes('viettel') ? 'checked' : ''}> Viettel Post</label>
                <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;"><input type="checkbox" id="cfg-carrier-spx" ${shipCfg.enabledCarriers?.includes('spx') ? 'checked' : ''}> Shopee Express (SPX)</label>
                <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;"><input type="checkbox" id="cfg-carrier-jt" ${shipCfg.enabledCarriers?.includes('jt') ? 'checked' : ''}> J&T Express</label>
              </div>
            </div>
          </div>
          <div class="feature-config-actions">
            <span id="status-setting-shipping" class="feature-config-feedback"></span>
            <button type="button" class="primary-button" id="btn-save-shipping" onclick="window.GAERUUpgradesHub.saveSettingModule('shipping')">Lưu Cài Đặt Vận Chuyển</button>
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<p style="color:#d92d20;padding:20px;">Lỗi tải cài đặt: ${escapeHtml(err.message)}</p>`;
    }
  }

  async function saveSettingModule(moduleName) {
    const btn = document.getElementById(`btn-save-${moduleName}`) || document.querySelector(`button[onclick*="'${moduleName}'"]`);
    const statusEl = document.getElementById(`status-setting-${moduleName}`) || btn?.parentElement?.querySelector('.feature-config-feedback');
    const originalBtnText = btn ? btn.innerHTML : 'Lưu Cài Đặt';

    // Thao tác 1/3: Thu thập và kiểm tra dữ liệu đầu vào (Client Validation)
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = 'Đang kiểm tra...';
    }
    if (statusEl) {
      statusEl.className = 'feature-config-feedback';
      statusEl.innerHTML = '<span style="color:#0071e3;">[Thao tác 1/3]</span> Đang kiểm tra tính hợp lệ dữ liệu...';
    }

    let settings = {};
    try {
      if (moduleName === 'rma') {
        const days = Number(document.getElementById('cfg-rma-days')?.value);
        if (isNaN(days) || days < 7 || days > 90) throw new Error('Thời hạn đổi mới phải từ 7 đến 90 ngày.');
        const hotline = String(document.getElementById('cfg-rma-phone')?.value || '').trim();
        if (!hotline) throw new Error('Hotline kỹ thuật không được để trống.');
        const addr = String(document.getElementById('cfg-rma-addr')?.value || '').trim();
        if (!addr) throw new Error('Địa chỉ kho nhận không được để trống.');
        settings = { returnDays: days, supportHotline: hotline, warehouseAddress: addr };
      } else if (moduleName === 'bnpl') {
        const minVal = Number(document.getElementById('cfg-bnpl-min')?.value) || 300000;
        const maxVal = Number(document.getElementById('cfg-bnpl-max')?.value) || 30000000;
        if (minVal >= maxVal) throw new Error('Hạn mức tối thiểu phải nhỏ hơn hạn mức tối đa.');
        settings = {
          fundiinEnabled: document.getElementById('cfg-bnpl-fundiin')?.value === 'true',
          kredivoEnabled: document.getElementById('cfg-bnpl-kredivo')?.value === 'true',
          minAmountVnd: minVal,
          maxAmountVnd: maxVal
        };
      } else if (moduleName === 'capi') {
        settings = {
          metaPixelId: String(document.getElementById('cfg-capi-meta')?.value || '').trim(),
          tikTokPixelId: String(document.getElementById('cfg-capi-tiktok')?.value || '').trim(),
          testEventCode: String(document.getElementById('cfg-capi-test')?.value || '').trim(),
          mode: document.getElementById('cfg-capi-mode')?.value || 'simulation'
        };
      } else if (moduleName === 'loyalty') {
        const rate = Number(document.getElementById('cfg-loyalty-rate')?.value);
        if (isNaN(rate) || rate < 0 || rate > 20) throw new Error('Tỷ lệ tích điểm phải từ 0% đến 20%.');
        settings = {
          earnRatePercent: rate,
          silverPointsThreshold: Number(document.getElementById('cfg-loyalty-silver')?.value) || 1000,
          goldPointsThreshold: Number(document.getElementById('cfg-loyalty-gold')?.value) || 5000,
          diamondPointsThreshold: Number(document.getElementById('cfg-loyalty-diamond')?.value) || 10000
        };
      } else if (moduleName === 'affiliate') {
        const comm = Number(document.getElementById('cfg-aff-comm')?.value);
        if (isNaN(comm) || comm < 1 || comm > 50) throw new Error('Hoa hồng tiếp thị phải từ 1% đến 50%.');
        settings = {
          commissionPercent: comm,
          cookieDays: Number(document.getElementById('cfg-aff-cookie')?.value) || 30,
          minPayoutVnd: Number(document.getElementById('cfg-aff-payout')?.value) || 200000,
          payoutDayOfMonth: Number(document.getElementById('cfg-aff-day')?.value) || 15
        };
      } else if (moduleName === 'webPush') {
        settings = {
          autoNotifyNewOrder: document.getElementById('cfg-push-order')?.value === 'true',
          autoNotifyShipping: document.getElementById('cfg-push-ship')?.value === 'true',
          autoNotifyFlashSale: document.getElementById('cfg-push-sale')?.value === 'true'
        };
      } else if (moduleName === 'shipping') {
        const defaultCarrier = document.getElementById('cfg-ship-default')?.value || 'flexible';
        const autoCheapest = document.getElementById('cfg-ship-cheapest')?.value === 'true';
        const enabledCarriers = [];
        ['ghn', 'ghtk', 'viettel', 'spx', 'jt'].forEach(c => {
          const chk = document.getElementById(`cfg-carrier-${c}`);
          if (!chk || chk.checked) enabledCarriers.push(c);
        });
        settings = {
          defaultCarrier,
          autoSelectCheapest: autoCheapest,
          enabledCarriers
        };
      }

      // Thao tác 2/3: Truyền tải dữ liệu lên máy chủ và lưu trữ DB
      if (btn) btn.innerHTML = '⏳ Đang lưu máy chủ...';
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:#0071e3;">[Thao tác 2/3]</span> Đang mã hóa và ghi dữ liệu vào máy chủ...';
      }

      await requestApi('/api/gaeru_ceo/upgrades/settings', {
        method: 'POST',
        body: { module: moduleName, settings }
      });

      // Thao tác 3/3: Xác nhận thành công và hiển thị thời gian lưu
      const nowStr = new Date().toLocaleTimeString('vi-VN');
      if (statusEl) {
        statusEl.className = 'feature-config-feedback is-success';
        statusEl.innerHTML = `✓ <strong>[Thao tác 3/3 Hoàn tất]</strong> Đã lưu & kích hoạt lúc ${nowStr}!`;
      }
      if (btn) {
        btn.innerHTML = '✓ Đã Lưu';
        btn.style.backgroundColor = '#107c41';
        btn.style.borderColor = '#107c41';
      }

      setTimeout(() => {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = originalBtnText;
          btn.style.backgroundColor = '';
          btn.style.borderColor = '';
        }
      }, 2500);

    } catch (err) {
      if (statusEl) {
        statusEl.className = 'feature-config-feedback is-error';
        statusEl.innerHTML = `✕ <strong>Lỗi:</strong> ${escapeHtml(err.message)}`;
      }
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalBtnText;
      }
    }
  }

  // TAB SWITCHING & HELPERS
  // =========================================================================
  function switchUpgradeTab(tabId) {
    document.querySelectorAll('.upgrades-tab-btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.tab === tabId);
    });

    document.querySelectorAll('.upgrades-tab-panel').forEach(panel => {
      panel.hidden = panel.id !== `tab-panel-${tabId}`;
    });

    if (tabId === 'matrix') renderMatrix('all');
    if (tabId === 'rma') loadRmaTickets();
    if (tabId === 'bnpl') loadBnplTransactions();
    if (tabId === 'rop') loadInventoryForecast();
    if (tabId === 'rfm') loadRfmSegmentation();
    if (tabId === 'capi') loadCapiLogs();
    if (tabId === 'settings') loadAllSettings();
  }

  function openRmaModal(ticketId, code, currentStatus) {
    const newStatus = prompt(`Cập nhật trạng thái phiếu ${code}:\n(pending, received, inspecting, replacement_approved, approved_repair, shipping_back, completed, rejected)`, currentStatus);
    if (!newStatus || newStatus === currentStatus) return;

    let outboundTracking = null;
    if (newStatus === 'shipping_back' || newStatus === 'completed' || newStatus === 'shipped') {
      outboundTracking = prompt('Nhập mã vận đơn bưu cục gửi lại khách (GHN / GHTK / Viettel Post / SPX / J&T):', '');
    }

    const technicianNotes = prompt('Ghi chú của kỹ thuật viên:', 'Đã kiểm định thiết bị và cập nhật trạng thái.');

    requestApi(`/api/gaeru_ceo/rma/tickets/${ticketId}/status`, {
      method: 'PATCH',
      body: {
        status: newStatus,
        outboundTracking,
        technicianNotes,
        resolutionType: newStatus.includes('replacement') ? 'replace_1_1' : (newStatus.includes('repair') ? 'repair' : null)
      }
    }).then(() => {
      alert(`Đã cập nhật phiếu ${code} thành công!`);
      loadRmaTickets();
    }).catch(err => {
      alert(`Lỗi: ${err.message}`);
    });
  }

  async function triggerTestCapi() {
    try {
      await requestApi('/api/gaeru_ceo/capi/test-event', {
        method: 'POST',
        body: { eventName: 'Purchase', amountVnd: 1850000, orderNumber: 'TEST-' + Date.now().toString(36).toUpperCase() }
      });
      alert('Đã gửi sự kiện CAPI thử nghiệm thành công!\nKiểm tra lại danh sách nhật ký bên dưới.');
      loadCapiLogs();
    } catch (err) {
      alert('Lỗi: ' + err.message);
    }
  }

  function init() {
    renderMatrix('all');

    // Bind tab clicks
    document.querySelectorAll('.upgrades-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchUpgradeTab(btn.dataset.tab));
    });

    // Expose helpers globally
    window.GAERUUpgradesHub = {
      switchUpgradeTab,
      openRmaModal,
      triggerTestCapi,
      renderMatrix,
      loadRmaTickets,
      saveRmaConfig,
      loadBnplTransactions,
      saveBnplConfig,
      loadInventoryForecast,
      loadRfmSegmentation,
      loadCapiLogs,
      saveCapiConfig,
      loadAllSettings,
      saveSettingModule
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
