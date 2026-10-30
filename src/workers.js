'use strict';

/**
 * src/workers.js — Quản lý tập trung vòng đời các background worker và cron jobs
 * Hỗ trợ DB Advisory Lock để tránh chạy trùng lặp khi triển khai đa instance.
 */

const { createJobQueue } = require('./job-queue');

const ADVISORY_LOCK_KEY = 420099; // Mã khóa cố định cho cron leader election

class WorkerManager {
  constructor() {
    this.workers = new Map();
    this.jobQueue = null;
    this.isLeader = true;
    this.leaderClient = null;
  }

  /**
   * Cố gắng lấy khóa DB advisory để xác định xem tiến trình này có phải là leader không
   */
  async tryAcquireLeaderLock(pool) {
    try {
      const client = await pool.connect();
      const res = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [ADVISORY_LOCK_KEY]);
      if (res.rows[0]?.acquired) {
        this.isLeader = true;
        this.leaderClient = client;
        return true;
      }
      client.release();
      this.isLeader = false;
      return false;
    } catch {
      // Môi trường không hỗ trợ advisory lock (ví dụ SQLite hoặc test adapter), mặc định cho phép chạy
      this.isLeader = true;
      return true;
    }
  }

  /**
   * Khởi chạy toàn bộ 9 worker định kỳ
   */
  async startAll(pool, config) {
    await this.tryAcquireLeaderLock(pool);

    if (!this.isLeader) {
      console.log('WorkerManager: Running as follower node, background crons suppressed.');
      return;
    }

    try {
      this.jobQueue = createJobQueue({ pool, intervalMs: 2500, concurrency: 2 });
      this.jobQueue.start();
    } catch (e) {
      // job-queue fallback
    }

    const safeStart = (name, starter) => {
      try {
        const stopper = starter();
        if (typeof stopper === 'function') {
          this.workers.set(name, stopper);
        }
      } catch (err) {
        console.error(`WorkerManager: Failed to start worker ${name}:`, err.message);
      }
    };

    safeStart('chatFileRetention', () => require('./shopping-chat-file-retention').startChatFileRetentionWorker(pool));
    safeStart('tikTokAds', () => require('./tiktok-ads').startTikTokAdsWorker(pool, config));
    safeStart('aiChat', () => require('./shopping-chat-ai-first').startAIChatWorker(pool, config));
    safeStart('chatCompression', () => require('./shopping-chat-compression').startChatCompressionWorker(pool));
    safeStart('chatEmail', () => require('./shopping-chat-email').startChatEmailWorker(pool, config));
    safeStart('orderEmail', () => require('./order-email').startOrderEmailWorker(pool, config));
    safeStart('warrantyEmail', () => require('./warranty-email').startWarrantyEmailWorker(pool, config));
    safeStart('emailMarketing', () => require('./email-marketing').startEmailWorker(pool, config));
    safeStart('accountRetention', () => require('./account-retention').startRetentionWorker(pool));
  }

  /**
   * Dừng toàn bộ worker khi tắt server
   */
  async stopAll() {
    if (this.jobQueue) {
      try { this.jobQueue.stop(); } catch {}
    }

    for (const [name, stopper] of this.workers.entries()) {
      try {
        stopper();
      } catch (err) {
        console.error(`WorkerManager: Error stopping worker ${name}:`, err.message);
      }
    }
    this.workers.clear();

    if (this.leaderClient) {
      try {
        await this.leaderClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
        this.leaderClient.release();
      } catch {}
      this.leaderClient = null;
    }
  }
}

const workerManager = new WorkerManager();

module.exports = {
  WorkerManager,
  workerManager,
  startAllWorkers: (pool, config) => workerManager.startAll(pool, config),
  stopAllWorkers: () => workerManager.stopAll()
};
