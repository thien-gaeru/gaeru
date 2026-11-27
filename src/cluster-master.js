'use strict';

/**
 * GAERU Enterprise High-Availability Cluster Orchestrator
 *
 * Tiêu chuẩn mô hình kiến trúc High-Availability cao cấp nhất:
 * 1. Multi-Core Clustered Concurrency: Phân phối tải đồng thời trên các nhân CPU.
 * 2. True Zero-Downtime Rolling Reload: Tái nạp luân phiên từng worker, cổng 3000 không bao giờ đóng (0ms downtime).
 * 3. Self-Healing Auto-Respawn: Tự động hồi sinh worker tức thì (< 200ms) khi có sự cố.
 * 4. IPC Fan-Out & Stock Sync: Đồng bộ tồn kho và Cache Tags siêu tốc 0.01ms giữa các worker.
 * 5. Graceful Connection Draining: Cho phép các kết nối HTTP và SSE đang dở dang hoàn tất trước khi ngắt kết nối.
 */

const cluster = require('node:cluster');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { defaultFanoutHub } = require('./lib/cluster-fanout');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const RELOAD_FILE = path.join(LOGS_DIR, 'reload.signal');
const STOP_FILE = path.join(LOGS_DIR, 'stop.signal');
const CLUSTER_PID_FILE = path.join(LOGS_DIR, 'cluster.pid');
const RELOAD_STATUS_FILE = path.join(LOGS_DIR, 'cluster-reload-status.json');

function resolveReleaseSha() {
  try {
    if (typeof fs.readFileSync !== 'function') return process.env.GAERU_RELEASE_SHA || 'unknown';
    const gitDir = path.join(ROOT_DIR, '.git');
    const headRaw = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(headRaw)) return headRaw.toLowerCase();
    if (headRaw.startsWith('ref:')) {
      const refPath = headRaw.slice(4).trim();
      const looseRef = path.join(gitDir, refPath);
      if (typeof fs.existsSync === 'function' && fs.existsSync(looseRef)) {
        const refSha = fs.readFileSync(looseRef, 'utf8').trim();
        if (/^[0-9a-f]{40}$/i.test(refSha)) return refSha.toLowerCase();
      }
      const packedPath = path.join(gitDir, 'packed-refs');
      if (typeof fs.existsSync === 'function' && fs.existsSync(packedPath)) {
        const lines = fs.readFileSync(packedPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
          if (!line || line.startsWith('#') || line.startsWith('^')) continue;
          const [sha, name] = line.trim().split(/\s+/);
          if (name === refPath && /^[0-9a-f]{40}$/i.test(sha || '')) return sha.toLowerCase();
        }
      }
    }
  } catch (_) {}
  return process.env.GAERU_RELEASE_SHA || 'unknown';
}

const SERVER_PORT = parseInt(process.env.PORT || '3000', 10);
const CLUSTER_BOOT_ID = (process.env.GAERU_CLUSTER_BOOT_ID && String(process.env.GAERU_CLUSTER_BOOT_ID).trim()) || Date.now().toString(36);
// Hỗ trợ CLUSTER_WORKERS hoặc WORKERS từ app.env để khai thác hết các nhân khi tối ưu web trên Mi 6
const DEFAULT_WORKER_COUNT = Math.min(4, Math.max(2, (os.cpus()?.length || 4) >= 4 ? 2 : 1));
const NUM_WORKERS = Math.max(1, Math.min(8, parseInt(process.env.CLUSTER_WORKERS || process.env.WORKERS || String(DEFAULT_WORKER_COUNT), 10) || DEFAULT_WORKER_COUNT));

if (!cluster.isPrimary) {
  require('./server.js');
  return;
}

// Master configuration
cluster.setupPrimary({
  exec: path.join(__dirname, 'server.js'),
  args: process.argv.slice(2),
  silent: false
});

const activeWorkers = new Map(); // workerIndex -> worker
let isRollingReloading = false;
let isShuttingDown = false;
const workerCrashHistory = new Map(); // workerIndex -> [timestamps]
const reloadingSlots = new Set();
const respawnTimers = new Map();
let reloadSeq = 0;

function writeReloadStatus(extra = {}) {
  try {
    if (typeof fs.writeFileSync !== 'function') return;
    if (typeof fs.mkdirSync === 'function') {
      try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch (_) {}
    }
    const workers = [];
    for (let i = 0; i < NUM_WORKERS; i++) {
      const w = activeWorkers.get(i);
      workers.push({
        slot: i,
        pid: w?.process?.pid || null,
        alive: Boolean(w && !w.isDead()),
        ready: Boolean(w?.isWorkerReady),
        releaseSha: w?.releaseSha || null
      });
    }
    const payload = {
      masterPid: process.pid,
      numWorkers: NUM_WORKERS,
      reloadSeq,
      updatedAt: new Date().toISOString(),
      ...extra,
      workers
    };
    const tmpPath = `${RELOAD_STATUS_FILE}.tmp.${process.pid}`;
    if (typeof fs.renameSync === 'function') {
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, RELOAD_STATUS_FILE);
    } else {
      fs.writeFileSync(RELOAD_STATUS_FILE, JSON.stringify(payload, null, 2), 'utf8');
    }
  } catch (_) {}
}

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [CLUSTER-${level}] ${msg}`);
}

function tuneWorkerPriority(childPid) {
  if (!childPid) return;
  try {
    os.setPriority(childPid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
  } catch (_) {}
}

function scheduleRespawn(workerIndex) {
  if (isShuttingDown || activeWorkers.has(workerIndex) || reloadingSlots.has(workerIndex) || respawnTimers.has(workerIndex)) return;
  const history = workerCrashHistory.get(workerIndex) || [];
  const delay = history.filter(t => Date.now() - t < 30000).length >= 5 ? 5000 : 200;
  log(`Tự động hồi sinh Worker #${workerIndex} trong ${delay}ms...`, 'WARN');
  respawnTimers.set(workerIndex, setTimeout(() => {
    respawnTimers.delete(workerIndex);
    if (!isShuttingDown && !activeWorkers.has(workerIndex) && !reloadingSlots.has(workerIndex)) spawnWorker(workerIndex);
  }, delay));
}

function attachWorkerSupervision(worker, workerIndex) {
  worker.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;

    // Handle cluster fanout & stock coordination
    try {
      defaultFanoutHub.handleWorkerMessage(worker, msg);
    } catch (_) {}

    if (msg.type === 'WORKER_READY') {
      worker.isWorkerReady = true;
      log(`Worker #${workerIndex} (PID ${worker.process?.pid}) đã sẵn sàng nhận kết nối.`);
      if (!isRollingReloading) {
        writeReloadStatus({ status: 'running', releaseSha: resolveReleaseSha() });
      }
    }
  });

  worker.on('exit', (code, signal) => {
    log(`Worker #${workerIndex} (PID ${worker.process?.pid}) đã dừng (code: ${code}, signal: ${signal || 'none'}).`);
    // An old worker retired by a reload no longer owns the slot. Only a crash
    // of the active worker should create a replacement (including during reload).
    if (activeWorkers.get(workerIndex) !== worker) return;
    activeWorkers.delete(workerIndex);
    if (isShuttingDown) return;

    // Self-healing: Check crash history for dampening
    const now = Date.now();
    const history = (workerCrashHistory.get(workerIndex) || []).filter(t => now - t < 30000);
    history.push(now);
    workerCrashHistory.set(workerIndex, history);

    scheduleRespawn(workerIndex);
  });
}

function spawnWorker(workerIndex) {
  if (isShuttingDown) return null;
  if (activeWorkers.has(workerIndex)) return activeWorkers.get(workerIndex);
  if (respawnTimers.has(workerIndex)) {
    clearTimeout(respawnTimers.get(workerIndex));
    respawnTimers.delete(workerIndex);
  }

  const releaseSha = resolveReleaseSha();
  const env = {
    ...process.env,
    CLUSTER_WORKER: '1',
    CLUSTER_ENABLED: 'true',
    WORKER_INDEX: String(workerIndex),
    GAERU_CLUSTER_BOOT_ID: CLUSTER_BOOT_ID,
    GAERU_RELEASE_SHA: releaseSha,
    PORT: String(SERVER_PORT)
  };

  const worker = cluster.fork(env);
  worker.workerIndex = workerIndex;
  worker.releaseSha = releaseSha;
  worker.isWorkerReady = false;
  activeWorkers.set(workerIndex, worker);

  const pid = worker.process?.pid;
  if (pid) tuneWorkerPriority(pid);

  // F06: Gắn giám sát IPC và tự phục hồi
  attachWorkerSupervision(worker, workerIndex);

  return worker;
}

// Start initial worker fleet
log(`Khởi tạo GAERU High-Availability Cluster với ${NUM_WORKERS} workers trên cổng ${SERVER_PORT}...`);
for (let i = 0; i < NUM_WORKERS; i++) {
  spawnWorker(i);
}

try {
  fs.writeFileSync(CLUSTER_PID_FILE, String(process.pid), 'utf8');
} catch (_) {}

// True Zero-Downtime Rolling Reload Implementation
async function executeRollingReload() {
  if (isRollingReloading || isShuttingDown) return { status: 'skipped' };
  isRollingReloading = true;
  reloadSeq += 1;
  const targetReleaseSha = resolveReleaseSha();
  const startedAt = new Date().toISOString();
  const upgradedSlots = [];
  const failedSlots = [];
  log(`Bắt đầu quy trình Zero-Downtime Rolling Reload (seq=${reloadSeq}, sha=${targetReleaseSha})...`, 'INFO');
  writeReloadStatus({
    status: 'reloading',
    releaseSha: targetReleaseSha,
    startedAt,
    finishedAt: null,
    upgradedSlots,
    failedSlots
  });

  try {
    try {
      require('dotenv').config({ path: path.join(ROOT_DIR, '.env'), override: true });
    } catch (_) {}

    for (let i = 0; i < NUM_WORKERS; i++) {
      if (isShuttingDown) break;
      reloadingSlots.add(i);
      try {
        const oldWorker = activeWorkers.get(i);
        log(`Đang nâng cấp Worker #${i}...`, 'INFO');

        // 1. Spawn replacement worker pinned to targetReleaseSha
        const newWorker = cluster.fork({
          ...process.env,
          CLUSTER_WORKER: '1',
          CLUSTER_ENABLED: 'true',
          WORKER_INDEX: String(i),
          GAERU_CLUSTER_BOOT_ID: CLUSTER_BOOT_ID,
          GAERU_RELEASE_SHA: targetReleaseSha,
          PORT: String(SERVER_PORT)
        });
        newWorker.workerIndex = i;
        newWorker.releaseSha = targetReleaseSha;
        newWorker.isWorkerReady = false;
        if (newWorker.process?.pid) tuneWorkerPriority(newWorker.process.pid);

        // 2. F05: Chờ worker mới phát tín hiệu WORKER_READY thật sự (readiness gate)
        // Nếu timeout hoặc exit sớm -> coi là thất bại (false), KHÔNG ngắt worker cũ
        const ready = await new Promise((resolve) => {
          let settled = false;
          const cleanup = () => {
            newWorker.removeListener('message', onMsg);
            newWorker.removeListener('exit', onExit);
            clearTimeout(timer);
          };
          const onMsg = (msg) => {
            if (msg?.type === 'WORKER_READY' && !settled) {
              settled = true;
              cleanup();
              resolve(true);
            }
          };
          const onExit = () => {
            if (!settled) {
              settled = true;
              cleanup();
              resolve(false);
            }
          };
          const timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              cleanup();
              resolve(false);
            }
          }, 30000);
          timer.unref?.();

          newWorker.on('message', onMsg);
          newWorker.on('exit', onExit);
        });

        if (!ready || newWorker.isDead() || isShuttingDown) {
          failedSlots.push(i);
          log(`Worker #${i} mới không thể hoàn tất WORKER_READY. Giữ lại Worker cũ để đảm bảo 100% không gián đoạn.`, 'ERROR');
          try {
            if (newWorker.process && !newWorker.isDead()) {
              newWorker.kill('SIGKILL');
            }
          } catch (_) {}
          writeReloadStatus({
            status: 'reloading',
            releaseSha: targetReleaseSha,
            startedAt,
            finishedAt: null,
            upgradedSlots,
            failedSlots
          });
          continue;
        }

        newWorker.isWorkerReady = true;
        // F06: Gắn đầy đủ giám sát tự phục hồi (self-healing, message fanout, exit respawn) cho worker mới
        attachWorkerSupervision(newWorker, i);

        // Update active map to point to new worker
        activeWorkers.set(i, newWorker);
        upgradedSlots.push(i);
        log(`Worker #${i} mới (PID ${newWorker.process?.pid}) đã trực tuyến và cùng chia sẻ cổng ${SERVER_PORT}.`, 'INFO');

        // 3. Gracefully disconnect old worker with drain window (SEC-08: handle disconnected/hung workers too)
        if (oldWorker && !oldWorker.isDead()) {
          log(`Tiến hành rút Worker cũ (PID ${oldWorker.process?.pid}) sau khi đã có Worker mới thay thế an toàn...`);
          if (oldWorker.isConnected()) {
            // Notify worker explicitly before disconnect(): Node cluster waits for server.close()
            // (blocked by HTTP keep-alive/SSE sockets) before emitting 'disconnect' inside the worker.
            try {
              oldWorker.send?.({ type: 'GRACEFUL_SHUTDOWN' });
            } catch (_) {}
            try {
              oldWorker.disconnect();
            } catch (_) {}
          } else {
            try {
              oldWorker.kill('SIGTERM');
            } catch (_) {}
          }

          // Safety timeout above worker's internal 15s shutdownTimer to allow clean DB/session drain
          const drainTimeout = setTimeout(() => {
            try {
              if (oldWorker.process && !oldWorker.isDead()) {
                oldWorker.kill('SIGKILL');
              }
            } catch (_) {}
          }, 17000);
          drainTimeout.unref?.();
          oldWorker.once('exit', () => clearTimeout(drainTimeout));
        }

        // Small pause between workers for load balancing stabilization
        await new Promise(r => setTimeout(r, 1000));
      } finally {
        reloadingSlots.delete(i);
        scheduleRespawn(i);
      }
    }

    const finalStatus = failedSlots.length === 0 && upgradedSlots.length === NUM_WORKERS
      ? 'succeeded'
      : (upgradedSlots.length > 0 ? 'partial' : 'failed');
    const finishedAt = new Date().toISOString();
    writeReloadStatus({
      status: finalStatus,
      releaseSha: targetReleaseSha,
      startedAt,
      finishedAt,
      upgradedSlots,
      failedSlots
    });
    if (finalStatus === 'succeeded') {
      log(`Zero-Downtime Rolling Reload hoàn thành mỹ mãn (${upgradedSlots.length}/${NUM_WORKERS} workers ở ${targetReleaseSha}).`, 'INFO');
    } else {
      log(`Zero-Downtime Rolling Reload chưa trọn vẹn (status=${finalStatus}, upgraded=${upgradedSlots.length}/${NUM_WORKERS}, failedSlots=[${failedSlots.join(',')}]).`, 'ERROR');
    }
    return { status: finalStatus, releaseSha: targetReleaseSha, upgradedSlots, failedSlots };
  } catch (err) {
    const finishedAt = new Date().toISOString();
    writeReloadStatus({
      status: 'failed',
      releaseSha: targetReleaseSha,
      startedAt,
      finishedAt,
      upgradedSlots,
      failedSlots,
      error: err.message
    });
    log(`Lỗi trong quá trình Rolling Reload: ${err.message}`, 'ERROR');
    return { status: 'failed', releaseSha: targetReleaseSha, upgradedSlots, failedSlots, error: err.message };
  } finally {
    isRollingReloading = false;
    // A failed candidate or an active worker lost between slots must not leave
    // the fleet permanently smaller after a rolling reload.
    for (let i = 0; i < NUM_WORKERS; i++) scheduleRespawn(i);
  }
}

// Signal checking loop (watches reload.signal and stop.signal)
const signalInterval = setInterval(() => {
  if (isShuttingDown) return;

  if (fs.existsSync(RELOAD_FILE)) {
    try { fs.unlinkSync(RELOAD_FILE); } catch (_) {}
    void executeRollingReload();
  }

  if (fs.existsSync(STOP_FILE)) {
    try { fs.unlinkSync(STOP_FILE); } catch (_) {}
    void gracefulShutdown();
  }
}, 500);
signalInterval.unref?.();

process.on('SIGUSR2', () => void executeRollingReload());
process.on('SIGHUP', () => void executeRollingReload());
process.on('SIGTERM', () => void gracefulShutdown());
process.on('SIGINT', () => void gracefulShutdown());

async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (typeof signalInterval !== 'undefined' && signalInterval) clearInterval(signalInterval);
  for (const timer of respawnTimers.values()) clearTimeout(timer);
  respawnTimers.clear();
  log('Đang thực hiện dừng hệ thống Cluster an toàn...');

  try { if (fs.existsSync(CLUSTER_PID_FILE)) fs.unlinkSync(CLUSTER_PID_FILE); } catch (_) {}

  const allWorkers = new Set([
    ...Object.values(cluster.workers || {}).filter(Boolean),
    ...activeWorkers.values()
  ]);
  const exits = [];
  for (const worker of allWorkers) {
    try {
      if (!worker || worker.isDead()) continue;
      exits.push(new Promise((resolve) => {
        worker.once('exit', resolve);
        if (worker.isConnected()) {
          try { worker.send?.({ type: 'GRACEFUL_SHUTDOWN' }); } catch (_) {}
          try { worker.disconnect(); } catch (_) {}
        } else {
          try { worker.kill('SIGTERM'); } catch (_) {}
        }
      }));
    } catch (_) {}
  }

  let forceTimer;
  await Promise.race([
    Promise.allSettled(exits),
    new Promise((resolve) => {
      forceTimer = setTimeout(() => {
        const remainingWorkers = new Set([
          ...allWorkers,
          ...Object.values(cluster.workers || {}).filter(Boolean),
          ...activeWorkers.values()
        ]);
        for (const worker of remainingWorkers) {
          try {
            if (worker && !worker.isDead()) worker.process?.kill?.('SIGKILL');
          } catch (_) {}
        }
        resolve();
      }, 12000);
      forceTimer.unref?.();
    })
  ]);
  if (forceTimer) clearTimeout(forceTimer);
  process.exit(0);
}

module.exports = {
  executeRollingReload,
  spawnWorker,
  activeWorkers
};
