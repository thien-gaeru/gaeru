'use strict';

/**
 * GAERU Watchdog Supervisor (Enterprise High-Availability Daemon)
 *
 * Nhiệm vụ cốt lõi:
 * 1. Khởi chạy và duy trì tiến trình Node.js server (src/server.js) luôn hoạt động 24/7/365.
 * 2. Tự động phục hồi tức thì (< 300ms) nếu tiến trình con gặp sự cố, crash, hoặc bị tắt ngoài ý muốn.
 * 3. Giám sát HTTP Health Check định kỳ mỗi 5s (http://127.0.0.1:3000/healthz). Nếu server treo
 *    hoặc không phản hồi liên tiếp 3 lần, tự động recycle tiến trình để khôi phục dịch vụ.
 * 4. Ngăn chặn triệt để lỗi Cloudflare 502 Bad Gateway / Connection Refused.
 * 5. Hỗ trợ lệnh CLI: status, restart/reload, stop.
 * 6. Tự động xoay vòng log (log rotation) để bảo vệ dung lượng ổ cứng.
 */

const { spawn, execFileSync } = require('node:child_process');
const winPath = require('node:path');

function runWinTool(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { shell: false, ...opts });
}

function sleepSyncMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(ms) || 0));
}
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const PID_FILE = path.join(LOGS_DIR, 'supervisor.pid');
const SERVER_PID_FILE = path.join(LOGS_DIR, 'server.pid');
const SUPERVISOR_LOG = path.join(LOGS_DIR, 'supervisor.log');
const SERVER_LOG = path.join(LOGS_DIR, 'server.log');
const RELOAD_FILE = path.join(LOGS_DIR, 'reload.signal');
const STOP_FILE = path.join(LOGS_DIR, 'stop.signal');
const CLOUDFLARED_EXE = process.env.CLOUDFLARED_EXE || winPath.join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe');
const CLOUDFLARED_CONFIG = path.join(os.homedir(), '.cloudflared', 'config.yml');
const CLOUDFLARED_PID_FILE = path.join(LOGS_DIR, 'cloudflared.pid');
const CLOUDFLARED_LOG = path.join(LOGS_DIR, 'cloudflared.log');
const SYNC_SCRIPT = path.join(ROOT_DIR, 'scripts', 'realtime-cluster-sync.js');
const SYNC_PID_FILE = path.join(LOGS_DIR, 'cluster-sync.pid');
const SYNC_LOG = path.join(LOGS_DIR, 'cluster-sync.log');

const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 6000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const SERVER_PORT = parseInt(process.env.PORT || '3000', 10);

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// Bỏ qua lỗi EPIPE / EBADF trên stdout/stderr khi chạy ngầm không có console
if (process.stdout && typeof process.stdout.on === 'function') {
  process.stdout.on('error', () => {});
}
if (process.stderr && typeof process.stderr.on === 'function') {
  process.stderr.on('error', () => {});
}

function preventSystemSleep() {
  if (process.platform !== 'win32') return;
  try {
    for (const setting of ['standby-timeout-ac', 'hibernate-timeout-ac', 'disk-timeout-ac']) {
      runWinTool('powercfg', ['/change', setting, '0'], { stdio: 'ignore', timeout: 2000 });
    }
  } catch (_) {}
}

function tuneProcessPriorities(childPid) {
  try {
    os.setPriority(process.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
  } catch (_) {}
  if (childPid) {
    try {
      os.setPriority(childPid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
    } catch (_) {}
  }
  if (process.platform === 'win32') {
    try {
      runWinTool('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Process -Name cloudflared -ErrorAction SilentlyContinue | ForEach-Object { if ($_.PriorityClass -ne [System.Diagnostics.ProcessPriorityClass]::AboveNormal) { $_.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::AboveNormal } }',
      ], { stdio: 'ignore', timeout: 3000 });
    } catch (_) {}
  }
}

function rotateLogIfNeeded(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.size > MAX_LOG_SIZE_BYTES) {
        const backupPath = `${filePath}.1`;
        try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch (_) {}
        fs.renameSync(filePath, backupPath);
      }
    }
  } catch (_) {}
}

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}\n`;
  try {
    if (process.stdout && typeof process.stdout.write === 'function') {
      process.stdout.write(line);
    }
  } catch (_) {}
  try {
    rotateLogIfNeeded(SUPERVISOR_LOG);
    fs.appendFileSync(SUPERVISOR_LOG, line, 'utf8');
  } catch (_) {}
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function killProcessTree(pid) {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      const numericPid = Number(pid);
      if (Number.isInteger(numericPid) && numericPid > 0) {
        runWinTool('taskkill', ['/F', '/PID', String(numericPid), '/T'], { stdio: 'ignore' });
      }
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (_) {}
}

let cloudflaredProcess = null;
let syncProcess = null;

function getSyncPid() {
  if (syncProcess && syncProcess.pid && isPidAlive(syncProcess.pid)) {
    return syncProcess.pid;
  }
  if (fs.existsSync(SYNC_PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(SYNC_PID_FILE, 'utf8').trim(), 10);
      if (isPidAlive(pid)) return pid;
    } catch (_) {}
  }
  return null;
}

function getCloudflaredPid() {
  if (cloudflaredProcess && cloudflaredProcess.pid && isPidAlive(cloudflaredProcess.pid)) {
    return cloudflaredProcess.pid;
  }
  if (fs.existsSync(CLOUDFLARED_PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(CLOUDFLARED_PID_FILE, 'utf8').trim(), 10);
      if (isPidAlive(pid)) return pid;
    } catch (_) {}
  }
  if (process.platform === 'win32') {
    try {
      const output = runWinTool('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process -Name cloudflared -ErrorAction SilentlyContinue).Id',
      ], { encoding: 'utf8', timeout: 3000 });
      const pids = output.trim().split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
      if (pids.length > 0) return pids[0];
    } catch (_) {}
  }
  return null;
}

function isCloudflaredRunning() {
  return Boolean(getCloudflaredPid());
}

// ============================================================================
// CLI COMMAND HANDLING
// ============================================================================

const cliArg = (process.argv[2] || '').toLowerCase();

if (cliArg === 'status') {
  checkStatus();
  return;
}

if (cliArg === 'stop') {
  stopSupervisor();
  process.exit(0);
}

if (cliArg === 'restart' || cliArg === 'reload') {
  restartServer();
  process.exit(0);
}

function checkStatus() {
  console.log('=== GAERU WATCHDOG & SERVER STATUS ===');
  let supAlive = false;
  let supPid = null;
  if (fs.existsSync(PID_FILE)) {
    supPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    supAlive = isPidAlive(supPid);
  }
  console.log(`Supervisor: ${supAlive ? `RUNNING (PID: ${supPid})` : 'STOPPED'}`);

  let srvAlive = false;
  let srvPid = null;
  if (fs.existsSync(SERVER_PID_FILE)) {
    srvPid = parseInt(fs.readFileSync(SERVER_PID_FILE, 'utf8').trim(), 10);
    srvAlive = isPidAlive(srvPid);
  }
  console.log(`Server Child: ${srvAlive ? `RUNNING (PID: ${srvPid})` : 'NOT FOUND / STOPPED'}`);

  const cfPid = getCloudflaredPid();
  console.log(`Cloudflare Tunnel: ${cfPid ? `RUNNING (PID: ${cfPid}, Connected to Cloudflare Edge)` : 'STOPPED'}`);

  const syncPid = getSyncPid();
  console.log(`Two-way Cluster Sync: ${syncPid ? `RUNNING (PID: ${syncPid}, PC <-> Mi 6 parallel servers)` : 'STOPPED'}`);

  // Test local HTTP health
  const req = http.get(`http://127.0.0.1:${SERVER_PORT}/healthz`, { timeout: 2000 }, (res) => {
    console.log(`HTTP Health (/healthz): ${res.statusCode} ${res.statusMessage} (Port ${SERVER_PORT} OK)`);
    process.exit(0);
  });
  req.on('error', (err) => {
    console.log(`HTTP Health (/healthz): ERROR (${err.message}) - Port ${SERVER_PORT} not responding!`);
    process.exit(1);
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('HTTP Health (/healthz): TIMEOUT - Server is hanging!');
    process.exit(1);
  });
}

function stopSupervisor() {
  console.log('[Supervisor CLI] Yêu cầu dừng toàn bộ Supervisor và GAERU Server...');
  if (fs.existsSync(PID_FILE)) {
    const supPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isPidAlive(supPid)) {
      try {
        fs.writeFileSync(STOP_FILE, String(Date.now()), 'utf8');
        console.log(`Đã gửi tín hiệu dừng tới Supervisor (PID ${supPid}). Đang đợi thoát an toàn...`);
        let count = 0;
        while (isPidAlive(supPid) && count < 10) {
          sleepSyncMs(500);
          count++;
        }
        if (isPidAlive(supPid)) {
          console.log(`Cưỡng chế dừng Supervisor PID ${supPid}...`);
          killProcessTree(supPid);
        }
      } catch (_) {}
    }
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
  }
  if (fs.existsSync(SERVER_PID_FILE)) {
    const srvPid = parseInt(fs.readFileSync(SERVER_PID_FILE, 'utf8').trim(), 10);
    if (isPidAlive(srvPid)) {
      killProcessTree(srvPid);
    }
    try { fs.unlinkSync(SERVER_PID_FILE); } catch (_) {}
  }
  console.log('[Supervisor CLI] Đã dừng toàn bộ dịch vụ thành công.');
}

function restartServer() {
  console.log('[Supervisor CLI] Yêu cầu khởi động lại GAERU Server...');
  if (fs.existsSync(PID_FILE)) {
    const supPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isPidAlive(supPid)) {
      fs.writeFileSync(RELOAD_FILE, String(Date.now()), 'utf8');
      console.log(`Đã gửi tín hiệu RELOAD tới Supervisor (PID ${supPid}). Server con sẽ được hồi sinh ngay tức khắc.`);
      return;
    }
  }
  console.log('Supervisor chưa chạy. Tiến hành khởi động Supervisor mới...');
  const vbsPath = path.join(ROOT_DIR, 'scripts', 'start-server-bg.vbs');
  if (fs.existsSync(vbsPath)) {
    runWinTool('wscript.exe', [vbsPath], { stdio: 'ignore' });
    console.log('Đã kích hoạt Supervisor ngầm thành công.');
  }
}

// ============================================================================
// SUPERVISOR DAEMON CORE
// ============================================================================

// Kiểm tra single-instance
if (fs.existsSync(PID_FILE)) {
  const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (isPidAlive(existingPid) && existingPid !== process.pid) {
    log(`Supervisor đã chạy ngầm với PID ${existingPid}. Hủy tiến trình trùng lặp.`, 'WARN');
    process.exit(0);
  }
}

fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
try { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); } catch (_) {}
try { if (fs.existsSync(RELOAD_FILE)) fs.unlinkSync(RELOAD_FILE); } catch (_) {}

log(`GAERU Watchdog Supervisor khởi động với PID ${process.pid}`);

let childProcess = null;
let isShuttingDown = false;
let consecutiveFailures = 0;
let healthCheckInFlight = false;
let crashTimestamps = [];
let healthTimer = null;
let signalTimer = null;

function spawnServer() {
  if (isShuttingDown) return;

  const serverScript = path.join(ROOT_DIR, 'src', 'cluster-master.js');
  const nodeArgs = [
    '--max-old-space-size=4096',
    '--no-warnings',
    serverScript
  ];

  log(`Khởi chạy tiến trình GAERU Server: node ${nodeArgs.join(' ')}`);

  rotateLogIfNeeded(SERVER_LOG);
  const outStream = fs.openSync(SERVER_LOG, 'a');
  const errStream = fs.openSync(SERVER_LOG, 'a');

  childProcess = spawn(process.execPath, nodeArgs, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || String(Math.max(8, (require('node:os').cpus?.().length || 4) * 2)),
      SUPERVISED_BY_WATCHDOG: '1',
      PORT: String(SERVER_PORT)
    },
    stdio: ['ignore', outStream, errStream],
    detached: false
  });

  const childPid = childProcess.pid;
  fs.writeFileSync(SERVER_PID_FILE, String(childPid), 'utf8');
  tuneProcessPriorities(childPid);
  log(`GAERU Server đã khởi chạy thành công (PID: ${childPid}, Priority: AboveNormal)`);

  childProcess.on('error', (err) => {
    log(`Lỗi khởi tạo child process: ${err.message}`, 'ERROR');
  });

  childProcess.on('exit', (code, signal) => {
    try { fs.closeSync(outStream); } catch (_) {}
    try { fs.closeSync(errStream); } catch (_) {}
    try { if (fs.existsSync(SERVER_PID_FILE)) fs.unlinkSync(SERVER_PID_FILE); } catch (_) {}

    if (isShuttingDown) {
      log(`Server (PID ${childPid}) đã dừng an toàn theo yêu cầu.`);
      return;
    }

    const now = Date.now();
    crashTimestamps.push(now);
    crashTimestamps = crashTimestamps.filter(t => now - t < 30000); // 30s window

    let restartDelay = 300;
    if (crashTimestamps.length >= 6) {
      restartDelay = 5000;
      log(`Cảnh báo: Server dừng liên tiếp ${crashTimestamps.length} lần trong 30s. Áp dụng backoff delay ${restartDelay}ms để bảo vệ CPU.`, 'WARN');
    } else {
      log(`Server (PID ${childPid}) đã dừng đột ngột với mã ${code} (${signal || 'none'}). TỰ ĐỘNG HỒI SINH TRONG ${restartDelay}ms...`, 'WARN');
    }

    setTimeout(() => {
      if (!isShuttingDown) {
        spawnServer();
      }
    }, restartDelay);
  });
}

function checkHttpHealth() {
  if (isShuttingDown || !childProcess || !childProcess.pid || healthCheckInFlight) return;
  healthCheckInFlight = true;
  const probedPid = childProcess.pid;
  let settled = false;
  let deadline;
  let req;
  const finish = (failure) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    healthCheckInFlight = false;
    // A response from a replaced process must not affect its replacement's health.
    if (isShuttingDown || childProcess?.pid !== probedPid) return;
    if (!failure) {
      if (consecutiveFailures > 0) {
        log(`Server đã khôi phục trạng thái hoạt động bình thường (200 OK) sau ${consecutiveFailures} lần cảnh báo.`);
      }
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures++;
    log(`${failure} (Lần ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`, 'WARN');
    evaluateHealthFailures();
  };
  const onTimeout = () => {
    // Settle first: destroying a timed-out request also emits an error.
    finish(`Health check timeout quá ${HEALTH_CHECK_TIMEOUT_MS}ms`);
    try { req?.destroy(); } catch (_) {}
  };

  try {
    req = http.get(`http://127.0.0.1:${SERVER_PORT}/healthz`, { timeout: HEALTH_CHECK_TIMEOUT_MS }, (res) => {
      res.resume();
      finish(res.statusCode === 200 ? null : `Health check trả về HTTP ${res.statusCode}`);
    });
    req.on('error', (err) => finish(`Health check kết nối thất bại: ${err.message}`));
    req.on('timeout', onTimeout);
    // Bound the entire probe, including connection setup, not only socket inactivity.
    deadline = setTimeout(onTimeout, HEALTH_CHECK_TIMEOUT_MS);
    if (settled) clearTimeout(deadline);
  } catch (err) {
    finish(`Lỗi gọi health check: ${err.message}`);
  }
}

function evaluateHealthFailures() {
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !isShuttingDown) {
    log(`BÁO ĐỘNG ĐỎ: Server không phản hồi liên tiếp ${consecutiveFailures} lần! Tiến hành cưỡng chế tái sinh PID ${childProcess?.pid}...`, 'ERROR');
    recycleServer();
  }
}

function recycleServer() {
  consecutiveFailures = 0;
  if (childProcess && childProcess.pid) {
    const oldPid = childProcess.pid;
    log(`Đang dừng tiến trình treo PID ${oldPid}...`);
    killProcessTree(oldPid);
    // on('exit') sẽ tự động kích hoạt spawnServer()
  } else {
    spawnServer();
  }
}

function spawnCloudflared() {
  if (isShuttingDown) return;
  if (!fs.existsSync(CLOUDFLARED_EXE) || !fs.existsSync(CLOUDFLARED_CONFIG)) {
    log('Không tìm thấy cloudflared.exe hoặc config.yml. Bỏ qua khởi chạy Cloudflare Tunnel.', 'WARN');
    return;
  }
  const existingPid = getCloudflaredPid();
  if (existingPid) {
    tuneProcessPriorities(existingPid);
    return;
  }

  log(`Khởi chạy tiến trình Cloudflare Tunnel (cloudflared)...`);
  rotateLogIfNeeded(CLOUDFLARED_LOG);
  const outStream = fs.openSync(CLOUDFLARED_LOG, 'a');
  const errStream = fs.openSync(CLOUDFLARED_LOG, 'a');

  try {
    cloudflaredProcess = spawn(CLOUDFLARED_EXE, ['--config', CLOUDFLARED_CONFIG, 'tunnel', 'run'], {
      cwd: ROOT_DIR,
      stdio: ['ignore', outStream, errStream],
      detached: false
    });

    const cfPid = cloudflaredProcess.pid;
    fs.writeFileSync(CLOUDFLARED_PID_FILE, String(cfPid), 'utf8');
    tuneProcessPriorities(cfPid);
    log(`Cloudflare Tunnel đã khởi chạy thành công (PID: ${cfPid})`);

    cloudflaredProcess.on('error', (err) => {
      log(`Lỗi khởi tạo cloudflared process: ${err.message}`, 'ERROR');
    });

    cloudflaredProcess.on('exit', (code, signal) => {
      try { fs.closeSync(outStream); } catch (_) {}
      try { fs.closeSync(errStream); } catch (_) {}
      try { if (fs.existsSync(CLOUDFLARED_PID_FILE)) fs.unlinkSync(CLOUDFLARED_PID_FILE); } catch (_) {}
      cloudflaredProcess = null;

      if (isShuttingDown) {
        log(`Cloudflare Tunnel (PID ${cfPid}) đã dừng an toàn theo yêu cầu.`);
        return;
      }

      log(`Cloudflare Tunnel (PID ${cfPid}) đã dừng đột ngột (code: ${code}, signal: ${signal}). TỰ ĐỘNG KHỞI ĐỘNG LẠI TRONG 2s...`, 'WARN');
      setTimeout(() => {
        if (!isShuttingDown) spawnCloudflared();
      }, 2000);
    });
  } catch (err) {
    log(`Không thể khởi chạy cloudflared: ${err.message}`, 'ERROR');
  }
}

function checkCloudflaredHealth() {
  if (isShuttingDown) return;
  if (!isCloudflaredRunning()) {
    log('Phát hiện Cloudflare Tunnel chưa chạy hoặc bị ngắt kết nối. Đang tự động kích hoạt lại...', 'WARN');
    spawnCloudflared();
  }
}

function spawnClusterSync() {
  if (isShuttingDown) return;
  if (getSyncPid()) return;

  log(`Khởi chạy tiến trình Two-way Cluster Synchronizer (PC <-> Mi 6 phục vụ song song)...`);
  rotateLogIfNeeded(SYNC_LOG);
  const outStream = fs.openSync(SYNC_LOG, 'a');
  const errStream = fs.openSync(SYNC_LOG, 'a');

  try {
    syncProcess = spawn(process.execPath, [SYNC_SCRIPT], {
      cwd: ROOT_DIR,
      stdio: ['ignore', outStream, errStream],
      detached: false
    });

    const syncPid = syncProcess.pid;
    fs.writeFileSync(SYNC_PID_FILE, String(syncPid), 'utf8');
    tuneProcessPriorities(syncPid);
    log(`Two-way Cluster Synchronizer đã khởi chạy thành công (PID: ${syncPid})`);

    syncProcess.on('error', (err) => {
      log(`Lỗi khởi tạo Cluster Synchronizer: ${err.message}`, 'ERROR');
    });

    syncProcess.on('exit', (code, signal) => {
      try { fs.closeSync(outStream); } catch (_) {}
      try { fs.closeSync(errStream); } catch (_) {}
      try { if (fs.existsSync(SYNC_PID_FILE)) fs.unlinkSync(SYNC_PID_FILE); } catch (_) {}
      syncProcess = null;

      if (isShuttingDown) {
        log(`Cluster Synchronizer (PID ${syncPid}) đã dừng an toàn theo yêu cầu.`);
        return;
      }

      log(`Cluster Synchronizer (PID ${syncPid}) đã dừng đột ngột (code: ${code}, signal: ${signal}). TỰ ĐỘNG KHỞI ĐỘNG LẠI TRONG 3s...`, 'WARN');
      setTimeout(() => {
        if (!isShuttingDown) spawnClusterSync();
      }, 3000);
    });
  } catch (err) {
    log(`Không thể khởi chạy Cluster Synchronizer: ${err.message}`, 'ERROR');
  }
}

function checkClusterSyncHealth() {
  if (isShuttingDown) return;
  if (!getSyncPid()) {
    log('Phát hiện Cluster Synchronizer chưa chạy. Đang tự động kích hoạt lại...', 'WARN');
    spawnClusterSync();
  }
}

function checkSignals() {
  if (isShuttingDown) return;

  // 1. Kiểm tra yêu cầu reload (Zero-Downtime Rolling Reload do Cluster Master xử lý)
  if (fs.existsSync(RELOAD_FILE)) {
    // Nếu tiến trình con đang sống bình thường, để Cluster Master tự đọc và xoay tua workers (Zero Downtime)
    if (childProcess && isPidAlive(childProcess.pid)) {
      log('Phát hiện tín hiệu RELOAD. Cluster Master đang thực hiện Zero-Downtime Rolling Reload luân phiên...', 'INFO');
    } else {
      try { fs.unlinkSync(RELOAD_FILE); } catch (_) {}
      log('Tiến trình con không hoạt động. Khởi tạo lại Cluster Master...', 'WARN');
      recycleServer();
    }
    return;
  }

  // 2. Kiểm tra yêu cầu dừng
  if (fs.existsSync(STOP_FILE)) {
    try { fs.unlinkSync(STOP_FILE); } catch (_) {}
    log('Nhận tín hiệu STOP từ CLI. Đang dừng hệ thống...');
    shutdownGracefully();
  }
}

function shutdownGracefully() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('Supervisor đang đóng kết nối và dọn dẹp tài nguyên...');

  if (healthTimer) clearInterval(healthTimer);
  if (signalTimer) clearInterval(signalTimer);

  if (childProcess && childProcess.pid) {
    log(`Dừng tiến trình con PID ${childProcess.pid}...`);
    killProcessTree(childProcess.pid);
  }

  if (cloudflaredProcess && cloudflaredProcess.pid) {
    log(`Dừng Cloudflare Tunnel PID ${cloudflaredProcess.pid}...`);
    killProcessTree(cloudflaredProcess.pid);
  }

  if (syncProcess && syncProcess.pid) {
    log(`Dừng Cluster Synchronizer PID ${syncProcess.pid}...`);
    killProcessTree(syncProcess.pid);
  }

  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (_) {}
  try { if (fs.existsSync(SERVER_PID_FILE)) fs.unlinkSync(SERVER_PID_FILE); } catch (_) {}
  try { if (fs.existsSync(CLOUDFLARED_PID_FILE)) fs.unlinkSync(CLOUDFLARED_PID_FILE); } catch (_) {}
  try { if (fs.existsSync(SYNC_PID_FILE)) fs.unlinkSync(SYNC_PID_FILE); } catch (_) {}

  log('Supervisor đã dừng hoàn tất.');
  process.exit(0);
}

process.on('SIGINT', shutdownGracefully);
process.on('SIGTERM', shutdownGracefully);
process.on('uncaughtException', (err) => {
  log(`Lỗi ngoại lệ chưa xử lý trong Supervisor: ${err.stack || err.message}`, 'ERROR');
});
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection trong Supervisor: ${reason}`, 'ERROR');
});

// Khởi chạy
preventSystemSleep();
spawnServer();
spawnCloudflared();
spawnClusterSync();
healthTimer = setInterval(checkHttpHealth, HEALTH_CHECK_INTERVAL_MS);
signalTimer = setInterval(checkSignals, 1000);
setInterval(checkCloudflaredHealth, 10000);
setInterval(checkClusterSyncHealth, 10000);
// Duy trì ưu tiên tài nguyên và chống nghẽn bộ nhớ định kỳ mỗi 30s
setInterval(() => {
  if (childProcess && childProcess.pid) {
    tuneProcessPriorities(childProcess.pid);
  }
}, 30000);
// Giữ event loop luôn hoạt động 24/7 (không unref) để tiến trình supervisor không bao giờ tự thoát
setInterval(() => {}, 60000);
