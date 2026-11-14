'use strict';

let currentCsrfToken = null;
let refreshTimer = null;
let allLogs = [];
let serverAuthenticated = false;
let lastActivityAt = 0;

// Fetch CSRF Token
async function ensureCsrf() {
  try {
    const res = await fetch('/server_admin/api/csrf');
    const data = await res.json();
    currentCsrfToken = data.csrfToken;
  } catch (_) {}
}

// Check Current Authentication State
async function checkAuth() {
  try {
    const res = await fetch('/server_admin/api/me');
    const data = await res.json();
    if (data.code === 'MFA_SETUP_REQUIRED') {
      serverAuthenticated = false;
      stopTelemetry();
      window.location.assign('/gaeru_ceo#security');
      return;
    }
    serverAuthenticated = res.ok && data.authenticated === true;
    if (serverAuthenticated) {
      document.getElementById('login-modal').style.display = 'none';
      document.getElementById('top-device-badge').textContent = `${data.user.username} (${data.user.role}) · Xiaomi Mi 6`;
      startTelemetry();
      fetchDbSummary();
    } else {
      document.getElementById('login-modal').style.display = 'flex';
      stopTelemetry();
    }
  } catch (e) {
    serverAuthenticated = false;
    stopTelemetry();
    document.getElementById('login-modal').style.display = 'flex';
  }
}

// Telemetry polling is passive; only actual interaction refreshes the idle clock.
async function recordActivity() {
  if (!serverAuthenticated || Date.now() - lastActivityAt < 60000) return;
  lastActivityAt = Date.now();
  try {
    await ensureCsrf();
    const response = await fetch('/api/auth/activity', { method: 'POST', headers: { 'X-CSRF-Token': currentCsrfToken || '' } });
    if (response.status === 401) await checkAuth();
  } catch (_) {}
}
document.addEventListener('pointerdown', recordActivity, { passive: true });
document.addEventListener('keydown', recordActivity);

// Login Form Submit
document.getElementById('server-login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = document.getElementById('login-error-box');
  const submitBtn = document.getElementById('btn-login-submit');
  errBox.style.display = 'none';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Đang xác thực...';

  try {
    await ensureCsrf();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    const res = await fetch('/server_admin/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': currentCsrfToken || ''
      },
      body: JSON.stringify({ username, password })
    });
    let data = await res.json();
    if (data.csrfToken) currentCsrfToken = data.csrfToken;
    if (data.mfaEnrollmentRequired) {
      window.location.assign('/gaeru_ceo#security');
      return;
    }
    if (data.mfaRequired) {
      data = await window.GAERUSecurity.loginChallenge(data);
      if (data.csrfToken) currentCsrfToken = data.csrfToken;
      await checkAuth();
    } else if (res.ok && data.ok) {
      await checkAuth();
    } else {
      errBox.textContent = data.error || 'Đăng nhập không thành công.';
      errBox.style.display = 'block';
    }
  } catch (err) {
    errBox.textContent = 'Lỗi kết nối máy chủ: ' + err.message;
    errBox.style.display = 'block';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Xác thực & Vào Bảng Điều Khiển';
  }
});

// Logout
document.getElementById('btn-logout')?.addEventListener('click', async () => {
  if (!confirm('Đăng xuất khỏi Bảng điều khiển Máy chủ?')) return;
  try {
    await ensureCsrf();
    await fetch('/server_admin/api/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': currentCsrfToken || '' }
    });
  } catch (_) {}
  checkAuth();
});

// Tab Navigation
document.querySelectorAll('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.style.display = 'none');
    tab.classList.add('active');
    const targetId = tab.dataset.tab;
    const targetPane = document.getElementById(targetId);
    if (targetPane) targetPane.style.display = 'block';

    if (targetId === 'tab-logs') fetchLogs();
    if (targetId === 'tab-database') fetchDbSummary();
  });
});

// Realtime Telemetry Fetcher
async function fetchStats() {
  try {
    const res = await fetch('/server_admin/api/stats');
    if (res.status === 401 || res.status === 403) {
      checkAuth();
      return;
    }
    const data = await res.json();
    if (!data.ok) return;

    // 1. CPU
    const cpuPctEl = document.getElementById('cpu-percent');
    if (cpuPctEl) cpuPctEl.textContent = data.cpu.percent + '%';
    const cpuProgEl = document.getElementById('cpu-progress');
    if (cpuProgEl) cpuProgEl.style.width = data.cpu.percent + '%';
    const cpuLoadEl = document.getElementById('cpu-loadavg');
    if (cpuLoadEl) cpuLoadEl.textContent = data.system.loadAvg.join(', ');
    const upHours = Math.floor(data.system.uptimeSec / 3600);
    const upMins = Math.floor((data.system.uptimeSec % 3600) / 60);
    const uptimeEl = document.getElementById('sys-uptime');
    if (uptimeEl) uptimeEl.textContent = `${upHours}h ${upMins}m`;

    // Cores rendering
    const coresBox = document.getElementById('cores-container');
    if (coresBox && coresBox.children.length === 0) {
      coresBox.innerHTML = Array.from({ length: 8 }, (_, i) => `
        <div class="core-item">
          <div class="core-label">Core ${i} ${i >= 4 ? 'Gold' : 'Silver'}</div>
          <div class="core-bar"><div class="core-fill" id="core-fill-${i}" style="width: 20%;"></div></div>
          <div class="core-freq">${i >= 4 ? '2.45 GHz' : '1.90 GHz'}</div>
        </div>
      `).join('');
    }
    for (let i = 0; i < 8; i++) {
      const fill = document.getElementById(`core-fill-${i}`);
      if (fill) fill.style.width = Math.min(100, Math.max(5, (data.cpu.percent + (i * 3)) % 100)) + '%';
    }

    // 2. RAM
    document.getElementById('ram-used').textContent = data.memory.usedMb + ' MB';
    document.getElementById('ram-total').textContent = '/ ' + data.memory.totalMb + ' MB';
    document.getElementById('ram-progress').style.width = data.memory.percent + '%';
    document.getElementById('ram-free').textContent = data.memory.freeMb + ' MB';
    document.getElementById('ram-cached').textContent = data.memory.cachedMb + ' MB';
    document.getElementById('ram-percent').textContent = data.memory.percent + '%';
    document.getElementById('zram-usage').textContent = `${data.memory.zram.usedMb} / ${data.memory.zram.totalMb} MB`;

    // 3. Storage
    document.getElementById('disk-used').textContent = data.storage.usedGb + ' GB';
    document.getElementById('disk-total').textContent = '/ ' + data.storage.totalGb + ' GB';
    document.getElementById('disk-free').textContent = data.storage.freeGb + ' GB';
    document.getElementById('disk-percent').textContent = data.storage.percent + '%';
    document.getElementById('disk-progress').style.width = data.storage.percent + '%';

    // 4. Battery & Thermals
    document.getElementById('batt-temp').textContent = data.battery.temperature + '°C';
    document.getElementById('batt-level').textContent = `Pin: ${data.battery.level}%`;
    document.getElementById('batt-progress').style.width = data.battery.level + '%';
    document.getElementById('batt-status').textContent = data.battery.status;
    document.getElementById('batt-voltage').textContent = (data.battery.voltage / 1000).toFixed(2) + ' V';
    if (data.thermals && data.thermals.length > 0) {
      document.getElementById('soc-temp').textContent = data.thermals[0].temp + '°C';
    }
    if (data.brightness) {
      const briSlider = document.getElementById('screen-brightness-slider');
      const briLabel = document.getElementById('screen-brightness-label');
      const maxBri = data.brightness.max || 4095;
      const valBri = Math.max(0, Math.min(maxBri, Number(data.brightness.value) || 0));
      const pctBri = Math.round((valBri / maxBri) * 100);
      if (briLabel) {
        briLabel.textContent = valBri === 0 ? '0% (Đã tắt đèn nền)' : `${pctBri}% (${valBri}/${maxBri})`;
      }
      if (briSlider && document.activeElement !== briSlider) {
        briSlider.max = String(maxBri);
        briSlider.value = String(valBri);
      }
    }

    // 5. System specs & Services Pills & Node info
    const specDeviceEl = document.getElementById('spec-device');
    if (specDeviceEl && data.system?.device) specDeviceEl.textContent = data.system.device;
    const specSocEl = document.getElementById('spec-soc');
    if (specSocEl && data.system?.soc) specSocEl.textContent = data.system.soc;
    const specOsEl = document.getElementById('spec-os');
    if (specOsEl && data.system?.os) specOsEl.textContent = data.system.os;
    const specIpEl = document.getElementById('spec-ip');
    if (specIpEl && data.system?.localIp) specIpEl.textContent = data.system.localIp;

    const setSvcBadge = (id, svc, onlineLabel = 'RUNNING') => {
      const el = document.getElementById(id);
      if (!el || !svc) return;
      const isUp = svc.status === 'online';
      el.textContent = isUp ? onlineLabel : 'STOPPED';
      el.className = `card-badge ${isUp ? 'badge-emerald' : 'badge-danger'}`;
    };
    setSvcBadge('svc-nginx-status', data.services?.nginx, 'RUNNING');
    setSvcBadge('svc-node-status', data.services?.node, 'RUNNING');
    setSvcBadge('svc-pg-status', data.services?.postgres, 'RUNNING');
    setSvcBadge('svc-redis-status', data.services?.redis, 'ACTIVE');
    setSvcBadge('svc-cf-status', data.services?.cloudflared, 'CONNECTED');
    setSvcBadge('svc-ssh-status', data.services?.sshd, 'LISTENING');

    document.getElementById('node-pid').textContent = data.services.node.pid;
    document.getElementById('pg-summary-text').textContent = `CSDL: ${data.services.postgres.dbSize} · ${data.services.postgres.totalTables} bảng · ${data.services.postgres.activeConnections} kết nối`;

  } catch (e) {
    console.error('Stats poll error:', e);
  }
}

function startTelemetry() {
  fetchStats();
  if (!refreshTimer) {
    refreshTimer = setInterval(fetchStats, 3000);
  }
}

function stopTelemetry() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

document.getElementById('btn-refresh')?.addEventListener('click', fetchStats);

// Trigger Actions (Reload Nginx, Drop Caches, etc.)
window.triggerAction = async function(action) {
  const banner = document.getElementById('action-banner');
  const text = document.getElementById('action-banner-text');
  banner.className = 'alert-banner alert-success';
  text.textContent = 'Đang thực thi lệnh máy chủ...';
  banner.style.display = 'flex';

  try {
    await ensureCsrf();
    const res = await fetch('/server_admin/api/action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': currentCsrfToken || ''
      },
      body: JSON.stringify({ action })
    });
    const data = await res.json();
    if (data.ok) {
      text.textContent = data.message + (data.detail ? ` (${data.detail})` : '');
    } else {
      banner.className = 'alert-banner alert-danger';
      text.textContent = 'Lỗi thực thi: ' + (data.error || 'Không thể chạy lệnh');
    }
  } catch (err) {
    banner.className = 'alert-banner alert-danger';
    text.textContent = 'Lỗi kết nối: ' + err.message;
  }
  setTimeout(fetchStats, 1000);
};

// Fetch Database Tables Summary
async function fetchDbSummary() {
  try {
    const res = await fetch('/server_admin/api/db-summary');
    const data = await res.json();
    if (!data.ok || !data.tables) return;
    const tbody = document.getElementById('db-tables-body');
    if (tbody) {
      tbody.textContent = '';
      for (const t of (Array.isArray(data.tables) ? data.tables : [])) {
        const tr = document.createElement('tr');
        const tdName = document.createElement('td');
        const code = document.createElement('code');
        code.style.cssText = 'color:var(--cyan); font-weight:600;';
        code.textContent = String(t.table_name ?? '');
        tdName.appendChild(code);

        const tdRows = document.createElement('td');
        tdRows.style.fontFamily = 'var(--font-mono)';
        tdRows.textContent = `${Number(t.row_estimate || 0).toLocaleString('vi-VN')} bản ghi`;

        const tdSize = document.createElement('td');
        tdSize.style.cssText = 'font-family:var(--font-mono); font-weight:600;';
        tdSize.textContent = String(t.total_size ?? '');

        tr.appendChild(tdName);
        tr.appendChild(tdRows);
        tr.appendChild(tdSize);
        tbody.appendChild(tr);
      }
    }
  } catch (_) {}
}

// Fetch Logs
window.fetchLogs = async function() {
  const source = document.getElementById('log-source')?.value || 'app';
  const view = document.getElementById('terminal-view');
  if (!view) return;
  try {
    const res = await fetch(`/server_admin/api/logs?source=${source}&lines=120`);
    const data = await res.json();
    if (data.ok && Array.isArray(data.lines)) {
      allLogs = data.lines;
      renderLogs();
    }
  } catch (e) {
    view.textContent = 'Lỗi khi tải log: ' + e.message;
  }
};

function renderLogs() {
  const filter = (document.getElementById('log-filter')?.value || '').toLowerCase();
  const view = document.getElementById('terminal-view');
  if (!view) return;
  const filtered = filter ? allLogs.filter(l => l.toLowerCase().includes(filter)) : allLogs;
  view.textContent = filtered.join('\n') || '[Không có bản ghi log nào]';
  if (document.getElementById('log-autoscroll')?.checked) {
    view.scrollTop = view.scrollHeight;
  }
}

document.getElementById('log-source')?.addEventListener('change', window.fetchLogs);
document.getElementById('log-filter')?.addEventListener('input', renderLogs);


// Action & Event Delegation (CSP-Compliant)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-server-action]');
  if (btn) {
    const action = btn.dataset.serverAction;
    const confirmMsg = btn.dataset.confirm;
    if (confirmMsg && !confirm(confirmMsg)) return;
    if (typeof window.triggerAction === 'function') {
      window.triggerAction(action);
    }
    return;
  }
  const reloadLogs = e.target.closest('[data-reload-logs]');
  if (reloadLogs) {
    if (typeof window.fetchLogs === 'function') window.fetchLogs();
    return;
  }
  const clearLogs = e.target.closest('[data-clear-logs]');
  if (clearLogs) {
    const terminal = document.getElementById('terminal-view');
    if (terminal) terminal.textContent = '';
    return;
  }
  const dismissAlert = e.target.closest('[data-dismiss-alert]');
  if (dismissAlert && dismissAlert.parentElement) {
    dismissAlert.parentElement.style.display = 'none';
    return;
  }
  const briBtn = e.target.closest('[data-brightness-val]');
  if (briBtn) {
    const val = Math.max(0, Math.min(4095, Number(briBtn.dataset.brightnessVal) || 0));
    setScreenBrightness(val);
    return;
  }
});

async function setScreenBrightness(value) {
  const slider = document.getElementById('screen-brightness-slider');
  const label = document.getElementById('screen-brightness-label');
  const max = Number(slider?.max) || 4095;
  const val = Math.max(0, Math.min(max, Math.round(Number(value) || 0)));
  const pct = Math.round((val / max) * 100);
  if (slider) slider.value = String(val);
  if (label) label.textContent = val === 0 ? '0% (Đã tắt đèn nền)' : `${pct}% (${val}/${max})`;
  try {
    await ensureCsrf();
    const res = await fetch('/server_admin/api/action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': currentCsrfToken || ''
      },
      body: JSON.stringify({ action: 'set-brightness', value: val })
    });
    const data = await res.json();
    if (data.ok) {
      showToast(data.message || `Đã đặt độ sáng: ${pct}%`);
    } else {
      showToast(data.error || 'Không thể chỉnh độ sáng màn hình.', true);
    }
  } catch (err) {
    showToast('Lỗi kết nối khi chỉnh độ sáng: ' + err.message, true);
  }
}

document.getElementById('screen-brightness-slider')?.addEventListener('input', (e) => {
  const slider = e.target;
  const label = document.getElementById('screen-brightness-label');
  const max = Number(slider.max) || 4095;
  const val = Math.max(0, Math.min(max, Math.round(Number(slider.value) || 0)));
  const pct = Math.round((val / max) * 100);
  if (label) label.textContent = val === 0 ? '0% (Đã tắt đèn nền)' : `${pct}% (${val}/${max})`;
});

document.getElementById('screen-brightness-slider')?.addEventListener('change', (e) => {
  setScreenBrightness(e.target.value);
});

// Initial Bootstrap
ensureCsrf();
checkAuth();
