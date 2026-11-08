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

const { spawn, execSync } = require('node:child_process');
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
if (process.stderr && typeof process.stderr.on === 'error') {
  process.stderr.on('error', () => {});
}

function preventSystemSleep() {
  if (process.platform !== 'win32') return;
  try {
    execSync('powercfg /change standby-timeout-ac 0', { stdio: 'ignore', timeout: 2000 });
    execSync('powercfg /change hibernate-timeout-ac 0', { stdio: 'ignore', timeout: 2000 });
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
      execSync('powershell -NoProfile -NonInteractive -Command "Get-Process -Name cloudflared -ErrorAction SilentlyContinue | ForEach-Object { if ($_.PriorityClass -ne [System.Diagnostics.ProcessPriorityClass]::AboveNormal) { $_.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::AboveNormal } }"', { stdio: 'ignore', timeout: 3000 });
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
      execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (_) {}
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
          execSync('powershell -Command "Start-Sleep -Milliseconds 500"', { stdio: 'ignore' });
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
    execSync(`wscript.exe "${vbsPath}"`, { stdio: 'ignore' });
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
let crashTimestamps = [];
let healthTimer = null;
let signalTimer = null;

function spawnServer() {
  if (isShuttingDown) return;

  const serverScript = path.join(ROOT_DIR, 'src', 'server.js');
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
  if (isShuttingDown || !childProcess || !childProcess.pid) return;

  try {
    const req = http.get(`http://127.0.0.1:${SERVER_PORT}/healthz`, { timeout: HEALTH_CHECK_TIMEOUT_MS }, (res) => {
      res.resume();
      if (res.statusCode === 200) {
        if (consecutiveFailures > 0) {
          log(`Server đã khôi phục trạng thái hoạt động bình thường (200 OK) sau ${consecutiveFailures} lần cảnh báo.`);
        }
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        log(`Health check trả về HTTP ${res.statusCode} (Lần ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`, 'WARN');
        evaluateHealthFailures();
      }
    });

    req.on('error', (err) => {
      consecutiveFailures++;
      log(`Health check kết nối thất bại: ${err.message} (Lần ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`, 'WARN');
      evaluateHealthFailures();
    });

    req.on('timeout', () => {
      try { req.destroy(); } catch (_) {}
      consecutiveFailures++;
      log(`Health check timeout quá ${HEALTH_CHECK_TIMEOUT_MS}ms (Lần ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`, 'WARN');
      evaluateHealthFailures();
    });
  } catch (err) {
    consecutiveFailures++;
    log(`Lỗi gọi health check: ${err.message}`, 'WARN');
    evaluateHealthFailures();
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

function checkSignals() {
  if (isShuttingDown) return;

  // 1. Kiểm tra yêu cầu reload
  if (fs.existsSync(RELOAD_FILE)) {
    try { fs.unlinkSync(RELOAD_FILE); } catch (_) {}
    log('Nhận tín hiệu RELOAD. Đang tái sinh server con...');
    recycleServer();
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

  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (_) {}
  try { if (fs.existsSync(SERVER_PID_FILE)) fs.unlinkSync(SERVER_PID_FILE); } catch (_) {}

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
healthTimer = setInterval(checkHttpHealth, HEALTH_CHECK_INTERVAL_MS);
signalTimer = setInterval(checkSignals, 1000);
// Duy trì ưu tiên tài nguyên và chống nghẽn bộ nhớ định kỳ mỗi 30s
setInterval(() => {
  if (childProcess && childProcess.pid) {
    tuneProcessPriorities(childProcess.pid);
  }
}, 30000);
// Giữ event loop luôn hoạt động 24/7 (không unref) để tiến trình supervisor không bao giờ tự thoát
setInterval(() => {}, 60000);
