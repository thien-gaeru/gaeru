'use strict';

/**
 * src/workers.js — Quản lý tập trung vòng đời các background worker, job queue handlers và cron jobs
 * Hỗ trợ DB Advisory Lock + Lease Heartbeat để tránh chạy trùng lặp khi triển khai đa instance.
 */

const { createJobQueue } = require('./job-queue');

const ADVISORY_LOCK_KEY = 420099; // Mã khóa cố định cho cron leader election
const LEASE_HEARTBEAT_MS = 30000;

class WorkerManager {
  constructor() {
    this.workers = new Map();
    this.jobQueue = null;
    this.isLeader = true;
    this.leaderClient = null;
    this.leaseTimer = null;
    this.lastLeaseRenewalAt = null;
  }

  /**
   * Cố gắng lấy khóa DB advisory và duy trì lease heartbeat
   */
  async tryAcquireLeaderLock(pool) {
    if (!pool || (typeof pool.connect !== 'function' && typeof pool.query !== 'function')) {
      this.isLeader = true;
      this.lastLeaseRenewalAt = Date.now();
      return true;
    }
    const isMultiClientPool = Boolean(pool.options || typeof pool.totalCount === 'number');
    if (!isMultiClientPool && typeof pool.query === 'function') {
      try {
        const res = await pool.query('SELECT pg_try_advisory_lock($1) AS acquired', [ADVISORY_LOCK_KEY]);
        this.isLeader = Boolean(res?.rows?.[0]?.acquired ?? true);
        this.lastLeaseRenewalAt = Date.now();
        return this.isLeader;
      } catch {
        this.isLeader = true;
        this.lastLeaseRenewalAt = Date.now();
        return true;
      }
    }
    try {
      const client = await pool.connect();
      if (!client || typeof client.query !== 'function') {
        client?.release?.();
        this.isLeader = true;
        this.lastLeaseRenewalAt = Date.now();
        return true;
      }
      const res = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [ADVISORY_LOCK_KEY]);
      if (res?.rows?.[0]?.acquired) {
        this.isLeader = true;
        this.leaderClient = client;
        this.lastLeaseRenewalAt = Date.now();
        this.startLeaseHeartbeat(pool);
        return true;
      }
      client.release?.();
      this.isLeader = false;
      return false;
    } catch {
      // Môi trường không hỗ trợ advisory lock (ví dụ test adapter), mặc định cho phép chạy
      this.isLeader = true;
      this.lastLeaseRenewalAt = Date.now();
      return true;
    }
  }

  /**
   * Duy trì lease định kỳ trên kết nối đang giữ khóa
   */
  startLeaseHeartbeat(pool) {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = setInterval(async () => {
      if (!this.leaderClient) return;
      try {
        await this.leaderClient.query('SELECT 1');
        this.lastLeaseRenewalAt = Date.now();
      } catch {
        // Nếu kết nối giữ khóa bị đứt, giải phóng và thử lấy lại khóa ở chu kỳ tiếp theo
        try { this.leaderClient.release?.(); } catch {}
        this.leaderClient = null;
        await this.tryAcquireLeaderLock(pool).catch(() => {});
      }
    }, LEASE_HEARTBEAT_MS);
    if (this.leaseTimer.unref) this.leaseTimer.unref();
  }

  /**
   * Đăng ký đầy đủ các handlers chuẩn cho hệ thống Job Queue (system_jobs)
   */
  registerDefaultHandlers(pool, config, { requireFn = require } = {}) {
    if (!this.jobQueue) return;

    this.jobQueue.registerWorker('omnichannel.sync', async (payload) => {
      const { processOmnichannelEvent } = requireFn('./omnichannel-sync');
      return await processOmnichannelEvent(pool, payload || {});
    });

    this.jobQueue.registerWorker('account.retention', async () => {
      const retention = requireFn('./account-retention');
      if (typeof retention.lockExpiredJunkAccounts === 'function') {
        return await retention.lockExpiredJunkAccounts(pool);
      }
      return { ok: true };
    });

    this.jobQueue.registerWorker('media.audit', async (payload) => {
      const mediaAudit = requireFn('./media-storage-audit');
      if (typeof mediaAudit.auditMediaStorage === 'function') {
        return await mediaAudit.auditMediaStorage(pool, payload || { probeStatus: { verified: true } });
      }
      return { ok: true };
    });

    this.jobQueue.registerWorker('email.order', async (payload) => {
      const orderEmail = requireFn('./order-email');
      if (typeof orderEmail.processOrderEmailOutbox === 'function') {
        return await orderEmail.processOrderEmailOutbox(pool, config, payload);
      }
      return { ok: true };
    });

    this.jobQueue.registerWorker('email.warranty', async (payload) => {
      const warrantyEmail = requireFn('./warranty-email');
      if (typeof warrantyEmail.processWarrantyEmailOutbox === 'function') {
        return await warrantyEmail.processWarrantyEmailOutbox(pool, config, payload);
      }
      return { ok: true };
    });

    this.jobQueue.registerWorker('email.marketing', async (payload) => {
      const emailMarketing = requireFn('./email-marketing');
      if (typeof emailMarketing.processMarketingEmails === 'function') {
        return await emailMarketing.processMarketingEmails(pool, config, payload);
      }
      return { ok: true };
    });

    this.jobQueue.registerWorker('payment.reconcile', async (payload) => {
      const paymentChannels = requireFn('./payment-channels');
      if (typeof paymentChannels?.reconcileGatewayOrder === 'function' && (payload?.orderId || payload?.orderNumber)) {
        return await paymentChannels.reconcileGatewayOrder(pool, {
          orderId: payload.orderId || null,
          orderNumber: payload.orderNumber || null,
          provider: payload.provider || null,
          config,
          actor: { username: 'job-queue', source: 'system' }
        });
      }
      if (typeof paymentChannels?.reconcileUnknownGatewayAttempts === 'function') {
        return await paymentChannels.reconcileUnknownGatewayAttempts(pool, config);
      }
      return { ok: true };
    });

    this.jobQueue.registerWorker('health.check', async (payload) => {
      return { ok: true, checkedAt: new Date().toISOString(), payload: payload || {} };
    });
  }

  /**
   * Khởi chạy JobQueue + đăng ký handlers + khởi chạy toàn bộ 9 worker định kỳ
   */
  async startAll(pool, config, { requireFn = require, startJobQueue = true } = {}) {
    await this.tryAcquireLeaderLock(pool);

    if (!this.isLeader) {
      console.log('WorkerManager: Running as follower node, background crons suppressed.');
      return;
    }

    if (startJobQueue && pool && typeof pool.query === 'function') {
      try {
        this.jobQueue = createJobQueue({ pool, intervalMs: 2500, concurrency: 2 });
        this.registerDefaultHandlers(pool, config, { requireFn });
        this.jobQueue.start();
      } catch {
        // job-queue fallback
      }
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

    safeStart('chatFileRetention', () => requireFn('./shopping-chat-file-retention').startChatFileRetentionWorker(pool));
    safeStart('tikTokAds', () => requireFn('./tiktok-ads').startTikTokAdsWorker(pool, config));
    safeStart('aiChat', () => requireFn('./shopping-chat-ai-first').startAIChatWorker(pool, config));
    safeStart('chatCompression', () => requireFn('./shopping-chat-compression').startChatCompressionWorker(pool));
    safeStart('chatEmail', () => requireFn('./shopping-chat-email').startChatEmailWorker(pool, config));
    safeStart('orderEmail', () => requireFn('./order-email').startOrderEmailWorker(pool, config));
    safeStart('warrantyEmail', () => requireFn('./warranty-email').startWarrantyEmailWorker(pool, config));
    safeStart('emailMarketing', () => requireFn('./email-marketing').startEmailWorker(pool, config));
    safeStart('accountRetention', () => requireFn('./account-retention').startRetentionWorker(pool));
    safeStart('paymentReconciliation', () => {
      const mod = requireFn('./payment-channels');
      return typeof mod?.startPaymentReconciliationWorker === 'function'
        ? mod.startPaymentReconciliationWorker(pool, config)
        : undefined;
    });
  }

  /**
   * Dừng toàn bộ worker và giải phóng khóa/lease khi tắt server
   */
  async stopAll() {
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }

    if (this.jobQueue) {
      try { this.jobQueue.stop(); } catch {}
      this.jobQueue = null;
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
        this.leaderClient.release?.();
      } catch {}
      this.leaderClient = null;
    }
  }
}

const workerManager = new WorkerManager();

module.exports = {
  WorkerManager,
  workerManager,
  ADVISORY_LOCK_KEY,
  startAllWorkers: (pool, config, options) => workerManager.startAll(pool, config, options),
  stopAllWorkers: () => workerManager.stopAll()
};
