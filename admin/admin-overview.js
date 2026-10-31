// admin/admin-overview.js — Trang tổng quan: thống kê nhanh, lưu lượng truy cập & sức khỏe hệ thống

const sharedFormat = typeof window !== 'undefined' ? (window.GAERUAdminShared || window.GAERUFormat) : null;
const escapeHtml = (sharedFormat && typeof sharedFormat.escapeHtml === 'function')
  ? sharedFormat.escapeHtml
  : ((typeof window !== 'undefined' && typeof window.escapeHtml === 'function')
      ? window.escapeHtml
      : function fallbackEscapeHtml(value) {
          return String(value ?? '').replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
          });
        });

async function loadSummary() {
  if (!can("dashboard.read")) return;
  const summary = await request("/api/gaeru_ceo/summary");
  document.querySelector("#active-product-count").textContent = summary.products.active;
  document.querySelector("#product-count").textContent = summary.products.total;
  document.querySelector("#pending-order-count").textContent = summary.orders.needsAction;
  document.querySelector("#order-count").textContent = summary.orders.total;
  state.paymentPending = summary.orders.paymentPending;
  document.querySelector("#unpaid-order-count").textContent = summary.orders.paymentPending;
  const unpaidOrdersBadge = document.querySelector("#unpaid-orders-count");
  if (unpaidOrdersBadge) unpaidOrdersBadge.textContent = summary.orders.paymentPending;
  const unpaidTabSpan = document.querySelector('[data-order-tab="payment_pending"] span');
  if (unpaidTabSpan) unpaidTabSpan.textContent = summary.orders.paymentPending;
  document.querySelector("#low-stock-count").textContent = summary.products.lowStock;
  document.querySelector("#orders-gate-notice").hidden = summary.ordersEnabled;
  document.querySelector("#shipping-rates-notice").hidden = summary.shippingRatesConfigured;
  if (summary.traffic) renderTrafficMetrics(summary.traffic);
}

function renderTrafficMetrics(traffic) {
  if (!traffic) return;
  const fmt = (n) => Number(n || 0).toLocaleString("vi-VN");
  const el = (id) => document.querySelector(id);
  if (el("#traffic-today-visits")) el("#traffic-today-visits").textContent = fmt(traffic.todayPageviews);
  if (el("#traffic-total-visits")) el("#traffic-total-visits").textContent = fmt(traffic.totalPageviews);
  if (el("#metric-today-pageviews")) el("#metric-today-pageviews").textContent = fmt(traffic.todayPageviews);
  if (el("#metric-today-visitors")) el("#metric-today-visitors").textContent = fmt(traffic.todayVisitors);
  if (el("#metric-total-pageviews")) el("#metric-total-pageviews").textContent = fmt(traffic.totalPageviews);
  if (el("#metric-active-count")) el("#metric-active-count").textContent = fmt(traffic.activeNow);
}

async function loadTrafficSummary() {
  if (!can("dashboard.read")) return;
  try {
    const traffic = await request("/api/gaeru_ceo/traffic-summary");
    renderTrafficMetrics(traffic);
  } catch {}
}

async function loadSystemHealth() {
  if (!can("dashboard.read")) return;
  const section = document.querySelector("#overview-health-section");
  if (!section) return;
  try {
    const health = await request("/api/gaeru_ceo/system-health");
    const overallBadge = document.querySelector("#health-overall-status");
    if (overallBadge) {
      if (health.status === "healthy") {
        overallBadge.className = "health-overall-badge tag-healthy";
        overallBadge.innerHTML = '<span class="status-indicator"></span> Đang hoạt động tối ưu &amp; An toàn';
      } else {
        overallBadge.className = "health-overall-badge tag-warning";
        overallBadge.innerHTML = '<span class="status-indicator"></span> Cảnh báo: ' + escapeHtml(health.status || "Chậm");
      }
    }
    const dbStatus = document.querySelector("#health-db-status");
    if (dbStatus) {
      dbStatus.textContent = health.database?.status === "connected" ? "Bình thường" : "Gián đoạn";
      dbStatus.className = health.database?.status === "connected" ? "health-pill tag-healthy" : "health-pill tag-warning";
    }
    const dbDesc = document.querySelector("#health-db-desc");
    if (dbDesc && health.database) {
      dbDesc.textContent = health.database.pool || "PostgreSQL Pooler đang phản hồi ổn định";
    }
    const dbLatency = document.querySelector("#health-db-latency");
    if (dbLatency && health.database) {
      dbLatency.textContent = health.database.latencyMs + " ms";
    }

    const ddosStatus = document.querySelector("#health-ddos-status");
    if (ddosStatus && health.security?.antiDdos) {
      ddosStatus.textContent = health.security.antiDdos.status === "active" ? "Đang bảo vệ" : "Tạm dừng";
    }
    const ddosDesc = document.querySelector("#health-ddos-desc");
    if (ddosDesc && health.security?.antiDdos) {
      ddosDesc.textContent = health.security.antiDdos.strategy || "Adaptive Rate Limiting điều tiết lưu lượng API";
    }
    const ddosLimit = document.querySelector("#health-ddos-limit");
    if (ddosLimit && health.security?.antiDdos) {
      ddosLimit.textContent = health.security.antiDdos.limit || "600 req/phút/IP";
    }

    const botStatus = document.querySelector("#health-bot-status");
    if (botStatus && health.security?.antiBot) {
      botStatus.textContent = "Đang bật";
    }
    const botDesc = document.querySelector("#health-bot-desc");
    if (botDesc) {
      botDesc.textContent = "Honeypot thông minh + Bộ lọc hành vi bot rác";
    }
    const botMode = document.querySelector("#health-bot-mode");
    if (botMode && health.security?.antiBot) {
      botMode.textContent = health.security.antiBot.mode || "Smart Form & Heuristics Guard";
    }

    const wafStatus = document.querySelector("#health-waf-status");
    if (wafStatus) {
      wafStatus.textContent = "Đang bảo vệ";
    }
    const wafDesc = document.querySelector("#health-waf-desc");
    if (wafDesc) {
      wafDesc.textContent = "Chống SQLi, XSS, Path Traversal & Scanners";
    }
    const threatsCount = document.querySelector("#health-threats-count");
    if (threatsCount && health.security?.antiHack) {
      threatsCount.textContent = health.security.antiHack.threatsBlocked ?? 0;
    }

    const memInfo = document.querySelector("#health-memory-info");
    if (memInfo && health.server?.memoryUsage) {
      memInfo.textContent = `${health.server.memoryUsage.heapUsedMb} MB / ${health.server.memoryUsage.heapTotalMb} MB`;
    }
    const uptimeInfo = document.querySelector("#health-uptime-info");
    if (uptimeInfo && typeof health.uptimeSeconds === "number") {
      const hours = Math.floor(health.uptimeSeconds / 3600);
      const minutes = Math.floor((health.uptimeSeconds % 3600) / 60);
      uptimeInfo.textContent = hours > 0 ? `${hours} giờ ${minutes} phút` : `${minutes} phút ${health.uptimeSeconds % 60}s`;
    }

    const lastCheck = document.querySelector("#health-last-check");
    if (lastCheck) {
      lastCheck.textContent = new Date().toLocaleTimeString("vi-VN");
    }
  } catch (err) {
    console.error("loadSystemHealth error:", err);
    const overallBadge = document.querySelector("#health-overall-status");
    if (overallBadge) {
      overallBadge.className = "health-overall-badge tag-warning";
      overallBadge.innerHTML = '<span class="status-indicator"></span> Cảnh báo kết nối máy chủ';
    }
  }
}

document.querySelector("#btn-refresh-traffic")?.addEventListener("click", async () => {
  const btn = document.querySelector("#btn-refresh-traffic");
  if (btn) btn.disabled = true;
  try {
    await loadTrafficSummary();
    showGlobal("Đã làm mới dữ liệu bộ đếm truy cập tự động.");
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.querySelector("#btn-refresh-health")?.addEventListener("click", async () => {
  const btn = document.querySelector("#btn-refresh-health");
  if (btn) btn.disabled = true;
  try {
    await loadSystemHealth();
    showGlobal("Đã làm mới dữ liệu sức khỏe hệ thống và an ninh bảo vệ web.");
  } finally {
    if (btn) btn.disabled = false;
  }
});
