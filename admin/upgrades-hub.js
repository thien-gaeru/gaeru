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
    { id: 'cod-recon', phase: 2, name: 'Đối Soát Tiền Hàng COD Shopee Express', desc: 'Tự động đối chiếu chéo số tiền bưu tá thu hộ và ngân hàng chuyển khoản.', endpoint: '/api/gaeru_ceo/cod-reconciliation', status: 'live' },
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

  async function requestApi(url, options = {}) {
    if (window.GAERUAdmin && window.GAERUAdmin.request) {
      return await window.GAERUAdmin.request(url, options);
    }
    const res = await fetch(url, options);
    return await res.json();
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

  async function loadRmaTickets() {
    const tbody = document.getElementById('upgrades-rma-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:#86868b;">Đang tải danh sách phiếu bảo hành RMA...</td></tr>';

    try {
      const data = await requestApi('/api/gaeru_ceo/rma/tickets');
      const tickets = data.tickets || [];

      if (!tickets.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:#86868b;">Chưa có phiếu RMA nào cần xử lý.</td></tr>';
        return;
      }

      const statusBadges = {
        pending: 'up-badge-warning',
        received: 'up-badge-info',
        inspecting: 'up-badge-info',
        approved_replacement: 'up-badge-success',
        approved_repair: 'up-badge-success',
        rejected: 'up-badge-critical',
        shipping_back: 'up-badge-info',
        completed: 'up-badge-neutral'
      };

      tbody.innerHTML = tickets.map(t => `
        <tr>
          <td><strong style="color:#0071e3;">${escapeHtml(t.ticket_code)}</strong></td>
          <td>
            <strong>${escapeHtml(t.customer_name)}</strong>
            <small>${escapeHtml(t.customer_phone)}</small>
          </td>
          <td>
            <strong>${escapeHtml(t.product_name)}</strong>
            <small style="color:#e05252;">${escapeHtml(t.issue_type)}: ${escapeHtml(t.issue_description)}</small>
          </td>
          <td>
            <span class="up-badge ${statusBadges[t.status] || 'up-badge-neutral'}">
              ${escapeHtml(t.statusLabel || t.status)}
            </span>
          </td>
          <td>${t.tracking_code_outbound ? `<code>${escapeHtml(t.tracking_code_outbound)}</code>` : '<span style="color:#86868b;">—</span>'}</td>
          <td style="text-align:right;">
            <button class="up-btn-sm" onclick="window.GAERUUpgradesHub.openRmaModal('${t.id}', '${escapeHtml(t.ticket_code)}', '${t.status}')">
              ⚙️ Xử lý
            </button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#d92d20;padding:20px;">Lỗi tải RMA: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  async function loadBnplTransactions() {
    const tbody = document.getElementById('upgrades-bnpl-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:#86868b;">Đang tải giao dịch BNPL...</td></tr>';

    try {
      const data = await requestApi('/api/gaeru_ceo/bnpl/transactions');
      const list = data.transactions || [];

      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:#86868b;">Chưa có giao dịch trả góp BNPL nào phát sinh.</td></tr>';
        return;
      }

      tbody.innerHTML = list.map(tx => `
        <tr>
          <td><strong>${escapeHtml(tx.transaction_id)}</strong></td>
          <td><code>${escapeHtml(tx.order_number)}</code></td>
          <td><span class="up-badge up-badge-info">${escapeHtml(tx.provider.toUpperCase())}</span></td>
          <td><strong>${formatMoney(tx.amount_vnd)}</strong></td>
          <td>${tx.installments_count} kỳ (${formatMoney(tx.installment_amount_vnd)}/kỳ)</td>
          <td><span class="up-badge ${tx.status === 'approved' ? 'up-badge-success' : 'up-badge-warning'}">${escapeHtml(tx.status)}</span></td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#d92d20;padding:20px;">Lỗi tải BNPL: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

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

  async function loadCapiLogs() {
    const tbody = document.getElementById('upgrades-capi-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:#86868b;">Đang tải nhật ký CAPI...</td></tr>';

    try {
      const data = await requestApi('/api/gaeru_ceo/capi/logs');
      const logs = data.logs || [];

      if (!logs.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:#86868b;">Chưa có sự kiện CAPI nào được ghi nhận.</td></tr>';
        return;
      }

      tbody.innerHTML = logs.map(l => `
        <tr>
          <td><small>${new Date(l.created_at).toLocaleString('vi-VN')}</small></td>
          <td><strong>${escapeHtml(l.event_name)}</strong></td>
          <td><span class="up-badge ${l.platform === 'meta' ? 'up-badge-info' : 'up-badge-neutral'}">${escapeHtml(l.platform.toUpperCase())}</span></td>
          <td><span class="up-badge ${l.status === 'sent' ? 'up-badge-success' : 'up-badge-neutral'}">${escapeHtml(l.status)}</span></td>
          <td><code>${escapeHtml(JSON.stringify(l.payload_summary || {}))}</code></td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#d92d20;padding:20px;">Lỗi tải CAPI: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

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
  }

  function openRmaModal(ticketId, code, currentStatus) {
    const newStatus = prompt(`Cập nhật trạng thái phiếu ${code}:\n(pending, received, inspecting, approved_replacement, approved_repair, shipping_back, completed, rejected)`, currentStatus);
    if (!newStatus || newStatus === currentStatus) return;

    let outboundTracking = null;
    if (newStatus === 'shipping_back' || newStatus === 'completed') {
      outboundTracking = prompt('Nhập mã vận đơn bưu cục gửi lại khách (ví dụ SPXVN...):', '');
    }

    const technicianNotes = prompt('Ghi chú của kỹ thuật viên:', 'Đã kiểm định thiết bị và cập nhật trạng thái.');

    requestApi(`/api/gaeru_ceo/rma/tickets/${ticketId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: newStatus,
        outboundTracking,
        technicianNotes,
        resolutionType: newStatus.includes('replacement') ? 'replace_1_1' : (newStatus.includes('repair') ? 'repair' : null)
      })
    }).then(() => {
      alert(`Đã cập nhật phiếu ${code} thành công!`);
      loadRmaTickets();
    }).catch(err => {
      alert(`Lỗi: ${err.message}`);
    });
  }

  async function triggerTestCapi() {
    try {
      const res = await requestApi('/api/gaeru_ceo/capi/test-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventName: 'Purchase', amountVnd: 1850000, orderNumber: 'TEST-' + Date.now().toString(36).toUpperCase() })
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
      loadBnplTransactions,
      loadInventoryForecast,
      loadRfmSegmentation,
      loadCapiLogs
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
