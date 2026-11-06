'use strict';

require('dotenv').config();
const cluster = require('node:cluster');
const workerSlots = new Map();
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('./config');
const { createPool } = require('./db');
const { migrateDatabase } = require('./migrate');
const { defaultFanoutHub } = require('./lib/cluster-fanout');

const config = loadConfig();
const pool = createPool(config);

const cpuCount = os.cpus().length;
const configuredWorkers = Number.parseInt(process.env.WORKERS, 10);
const numWorkers = Number.isSafeInteger(configuredWorkers) && configuredWorkers > 0
  ? configuredWorkers
  : Math.max(1, cpuCount);

let isShuttingDown = false;

async function startMaster() {
  console.log(`[Master ${process.pid}] GAERU Multi-Core Cluster khởi động trên máy chủ (${cpuCount} CPU cores)...`);
  console.log(`[Master ${process.pid}] Khởi tạo ${numWorkers} worker process(es)...`);

  // 1. Chạy Migration Database và đồng bộ Asset một lần duy nhất trước khi fork các Worker
  try {
    await migrateDatabase(pool);
    console.log(`[Master ${process.pid}] Database migration hoàn tất thành công.`);
  } catch (err) {
    console.error(`[Master ${process.pid}] Database migration thất bại:`, err.message);
    process.exit(1);
  }

  // 2. Thiết lập Worker script
  cluster.setupPrimary({
    exec: path.join(__dirname, 'server.js')
  });

  // 3. Khởi tạo Trạm điều phối IPC Fan-out lắng nghe mọi tin nhắn từ các Worker
  cluster.on('message', (worker, message) => {
    defaultFanoutHub.handleWorkerMessage(worker, message);
  });

  // 4. Fork từng worker với biến môi trường phân tách
  for (let i = 0; i < numWorkers; i++) {
    forkWorker(i);
  }

  // 5. Tự động hồi sinh Worker nếu xảy ra crash đột ngột trong khi vận hành
  cluster.on('exit', (worker, code, signal) => {
    if (isShuttingDown) return;
    defaultFanoutHub.metrics.workerCrashes++;
    console.warn(`[Master ${process.pid}] Worker ${worker.process.pid} (id: ${worker.id}) đã dừng với mã ${code} (${signal || 'normal'}). Đang tự động hồi sinh Worker thay thế...`);
    defaultFanoutHub.metrics.workerRespawns++;
    const slot = workerSlots.get(worker.id) ?? 0;
    workerSlots.delete(worker.id);
    forkWorker(slot);
  });

  // 6. Graceful shutdown khi nhận tín hiệu từ hệ điều hành / Docker / Kubernetes
  const shutdownMaster = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[Master ${process.pid}] Nhận tín hiệu dừng hệ thống. Đang đóng kết nối an toàn ${Object.keys(cluster.workers || {}).length} worker(s)...`);

    for (const id in cluster.workers) {
      const worker = cluster.workers[id];
      if (worker && worker.isConnected()) {
        worker.disconnect();
      }
    }

    const killTimeout = setTimeout(() => {
      for (const id in cluster.workers) {
        const worker = cluster.workers[id];
        if (worker && !worker.isDead()) worker.kill('SIGTERM');
      }
    }, 5000);

    const checkInterval = setInterval(async () => {
      const active = Object.values(cluster.workers || {}).filter(w => !w.isDead());
      if (active.length === 0) {
        clearInterval(checkInterval);
        clearTimeout(killTimeout);
        try {
          await pool.end();
        } catch (_) {}
        console.log(`[Master ${process.pid}] Tất cả Worker đã thoát an toàn. Master dừng hoàn tất.`);
        process.exit(0);
      }
    }, 100);
  };

  process.on('SIGINT', shutdownMaster);
  process.on('SIGTERM', shutdownMaster);
}

function forkWorker(index) {
  const worker = cluster.fork({
    CLUSTER_WORKER: 'true',
    WORKER_INDEX: String(index)
  });
  workerSlots.set(worker.id, index);
  console.log(`[Master ${process.pid}] Khởi chạy Worker ${worker.id} (PID: ${worker.process.pid}) [Slot #${index}]`);
  return worker;
}

if (cluster.isPrimary) {
  startMaster().catch((err) => {
    console.error(`[Master ${process.pid}] Lỗi khởi động Master:`, err);
    process.exit(1);
  });
}

module.exports = {
  startMaster,
  forkWorker,
  numWorkers,
  cpuCount
};
