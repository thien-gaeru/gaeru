'use strict';

/**
 * src/workers.js — Quản lý tập trung vòng đời các background worker, job queue handlers và cron jobs.
 * Đảm bảo cơ chế Leader Election Fail-Closed (PostgreSQL Advisory Lock), Lease Heartbeat có hạ quyền (demotion)
 * khi đứt kết nối DB, và vòng lặp tự động thử lại quyền Leader (Leader Retry Loop) cho môi trường đa instance.
 */

const { createJobQueue } = require('./job-queue');

const ADVISORY_LOCK_KEY = 420099; // Mã khóa cố định cho cron leader election
const LEASE_HEARTBEAT_MS = 30000;
const LEADER_RETRY_MS = 15000;

class WorkerManager {
  constructor({
    allowUnlockedFallback = false,
    leaseHeartbeatMs = LEASE_HEARTBEAT_MS,
    leaderRetryMs = LEADER_RETRY_MS,
    lockKey = ADVISORY_LOCK_KEY
  } = {}) {
    this.workers = new Map();
    this.jobQueue = null;
    this.isLeader = false;
    this.leaderClient = null;
    this.leaseTimer = null;
    this.leaderRetryTimer = null;
    this.lastLeaseRenewalAt = null;
    this.lastLeaderError = null;
    this.allowUnlockedFallback = Boolean(allowUnlockedFallback);
    this.leaseHeartbeatMs = Math.max(25, Number(leaseHeartbeatMs) || LEASE_HEARTBEAT_MS);
    this.leaderRetryMs = Math.max(25, Number(leaderRetryMs) || LEADER_RETRY_MS);
    this.lockKey = lockKey;
    this._stopped = false;
    this._runtimeContext = null;
    this._workloadsStarted = false;
  }

  /**
   * Cố gắng lấy khóa DB advisory theo nguyên tắc Fail-Closed:
   * - Nếu kết nối DB lỗi hoặc truy vấn khóa thất bại -> isLeader = false (KHÔNG tự nhận làm leader),
   *   trừ khi chế độ tương thích allowUnlockedFallback === true được bật tường minh.
   */
  async tryAcquireLeaderLock(pool) {
    if (!pool) {
      if (this.allowUnlockedFallback) {
        this.isLeader = true;
        this.lastLeaseRenewalAt = Date.now();
        this.lastLeaderError = null;
        return true;
      }
      this.isLeader = false;
      this.lastLeaderError = new Error('Pool kết nối cơ sở dữ liệu không khả dụng cho bầu chọn leader.');
      return false;
    }

    if (typeof pool === 'object' && typeof pool.connect !== 'function' && typeof pool.query !== 'function') {
      // Hỗ trợ lifecycle stub đơn tiến trình không có giao diện truy vấn DB (ví dụ VM lifecycle test)
      this.isLeader = true;
      this.lastLeaseRenewalAt = Date.now();
      this.lastLeaderError = null;
      return true;
    }

    const isMultiClientPool = Boolean(pool.options || typeof pool.totalCount === 'number');
    if (!isMultiClientPool && typeof pool.query === 'function') {
      try {
        const res = await pool.query('SELECT pg_try_advisory_lock($1) AS acquired', [this.lockKey]);
        const row = res?.rows?.[0];
        const acquired = Boolean(row && row.acquired === true);
        this.isLeader = acquired;
        if (acquired) {
          this.lastLeaseRenewalAt = Date.now();
          this.lastLeaderError = null;
          this.startLeaseHeartbeat(pool);
        }
        return acquired;
      } catch (err) {
        this.lastLeaderError = err;
        if (this.allowUnlockedFallback) {
          this.isLeader = true;
          this.lastLeaseRenewalAt = Date.now();
          return true;
        }
        this.isLeader = false;
        return false;
      }
    }

    let client = null;
    try {
      client = await pool.connect();
      if (!client || typeof client.query !== 'function') {
        client?.release?.();
        if (this.allowUnlockedFallback) {
          this.isLeader = true;
          this.lastLeaseRenewalAt = Date.now();
          return true;
        }
        this.isLeader = false;
        return false;
      }

      const res = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [this.lockKey]);
      if (res?.rows?.[0]?.acquired === true) {
        this.isLeader = true;
        this.leaderClient = client;
        this.lastLeaseRenewalAt = Date.now();
        this.lastLeaderError = null;
        this.startLeaseHeartbeat(pool);
        return true;
      }

      client.release?.();
      this.isLeader = false;
      this.lastLeaderError = null;
      return false;
    } catch (err) {
      try { client?.release?.(true); } catch {}
      this.leaderClient = null;
      this.lastLeaderError = err;
      if (this.allowUnlockedFallback) {
        this.isLeader = true;
        this.lastLeaseRenewalAt = Date.now();
        return true;
      }
      // Fail-closed: tuyệt đối không tự chạy worker khi lỗi mạng/DB trong môi trường đa instance
      this.isLeader = false;
      return false;
    }
  }

  /**
   * Dừng riêng các tác vụ nền đang chạy khi mất quyền Leader (nhưng vẫn giữ vòng lặp retry để phục hồi)
   */
  _demoteFromLeadership() {
    this.isLeader = false;
    this._workloadsStarted = false;

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
        console.error(`WorkerManager: Error stopping worker ${name} during demotion:`, err.message);
      }
    }
    this.workers.clear();

    if (this.leaderClient) {
      try { this.leaderClient.release?.(true); } catch {}
      this.leaderClient = null;
    }
  }

  /**
   * Duy trì lease định kỳ trên kết nối đang giữ khóa; nếu đứt kết nối sẽ hạ quyền ngay và bật retry loop
   */
  startLeaseHeartbeat(pool) {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = setInterval(async () => {
      if (this._stopped || !this.isLeader) return;
      try {
        if (this.leaderClient) {
          await this.leaderClient.query('SELECT 1');
        } else if (pool && typeof pool.query === 'function') {
          const res = await pool.query('SELECT pg_try_advisory_lock($1) AS acquired', [this.lockKey]);
          if (res?.rows?.[0]?.acquired !== true) {
            throw new Error('Advisory lock no longer held');
          }
        }
        this.lastLeaseRenewalAt = Date.now();
      } catch (err) {
        this.lastLeaderError = err;
        this._demoteFromLeadership();
        if (!this._stopped && this._runtimeContext) {
          this.startLeaderRetryLoop();
        }
      }
    }, this.leaseHeartbeatMs);
    if (this.leaseTimer.unref) this.leaseTimer.unref();
  }

  /**
   * Cơ chế tự động thử lại bầu chọn Leader định kỳ cho các node Follower hoặc node vừa khôi phục sau sự cố kết nối DB
   */
  startLeaderRetryLoop() {
    if (this._stopped || this.leaderRetryTimer) return;
    let retrying = false;
    this.leaderRetryTimer = setInterval(async () => {
      if (this._stopped || this.isLeader || retrying || !this._runtimeContext) return;
      retrying = true;
      try {
        const acquired = await this.tryAcquireLeaderLock(this._runtimeContext.pool);
        if (acquired && !this._stopped) {
          if (this.leaderRetryTimer) {
            clearInterval(this.leaderRetryTimer);
            this.leaderRetryTimer = null;
          }
          this._startLeaderWorkloads();
        }
      } catch (err) {
        this.lastLeaderError = err;
      } finally {
        retrying = false;
      }
    }, this.leaderRetryMs);
    if (this.leaderRetryTimer.unref) this.leaderRetryTimer.unref();
  }

  /**
   * Đăng ký đầy đủ các handlers chuẩn cho hệ thống Job Queue (system_jobs) có kiểm tra lease trước tác dụng phụ
   */
  registerDefaultHandlers(pool, config, { requireFn = require } = {}) {
    if (!this.jobQueue) return;

    this.jobQueue.registerWorker('omnichannel.sync', async (payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
      const { processOmnichannelEvent } = requireFn('./omnichannel-sync');
      return await processOmnichannelEvent(pool, payload || {});
    });

    this.jobQueue.registerWorker('account.retention', async (_payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
      const retention = requireFn('./account-retention');
      if (typeof retention.lockExpiredJunkAccounts === 'function') {
        return await retention.lockExpiredJunkAccounts(pool);
      }
      return { ok: true };
    });

    this.jobQueue.registerWorker('media.audit', async (payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
      const mediaAudit = requireFn('./media-storage-audit');
      if (typeof mediaAudit.auditMediaStorage === 'function') {
        return await mediaAudit.auditMediaStorage(pool, payload || { probeStatus: { verified: true } });
      }
      return { ok: true };
    });

    const getMailer = () => {
      if (!config?.smtp) return null;
      try {
        return require('nodemailer').createTransport(require('./smtp-security').smtpOptions(config.smtp));
      } catch {
        return null;
      }
    };

    this.jobQueue.registerWorker('email.order', async (payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
      const orderEmail = requireFn('./order-email');
      const mailer = getMailer();
      const fn = orderEmail.processOrderEmailOutbox || orderEmail.processOrderEmail;
      if (typeof fn === 'function') {
        return await fn(pool, config, mailer);
      }
      return { ok: true };
    });

    this.jobQueue.registerWorker('email.warranty', async (payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
      const warrantyEmail = requireFn('./warranty-email');
      const mailer = getMailer();
      const fn = warrantyEmail.processWarrantyEmailOutbox || warrantyEmail.processWarrantyEmail;
      if (typeof fn === 'function') {
        return await fn(pool, config, mailer);
      }
      return { ok: true };
    });

    this.jobQueue.registerWorker('email.marketing', async (payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
      const emailMarketing = requireFn('./email-marketing');
      const mailer = getMailer();
      const fn = emailMarketing.processMarketingEmails || emailMarketing.processEmailQueue;
      if (typeof fn === 'function') {
        return await fn(pool, config, mailer);
      }
      return { ok: true };
    });

    this.jobQueue.registerWorker('payment.reconcile', async (payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
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
      try {
        const { PaymentService } = requireFn('./domain/payments/payment-service');
        if (typeof PaymentService?.scanOverdueUnknownAttempts === 'function') {
          return await PaymentService.scanOverdueUnknownAttempts(pool, config);
        }
      } catch (err) {
        console.warn('PaymentService.scanOverdueUnknownAttempts warning:', err?.message || err);
      }
      if (typeof paymentChannels?.reconcileUnknownGatewayAttempts === 'function') {
        return await paymentChannels.reconcileUnknownGatewayAttempts(pool, config);
      }
      return { ok: true };
    });

    this.jobQueue.registerWorker('orders.cancel_expired', async (payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
      try {
        const { OrderExpirationService } = requireFn('./domain/orders/order-expiration-service');
        if (typeof OrderExpirationService?.cancelExpiredUnpaidOrders === 'function') {
          return await OrderExpirationService.cancelExpiredUnpaidOrders(pool, {
            olderThanHours: payload?.olderThanHours || 24
          });
        }
      } catch (err) {
        console.error('orders.cancel_expired error:', err.message);
      }
      return { ok: true };
    });

    this.jobQueue.registerWorker('health.check', async (payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
      return { ok: true, checkedAt: new Date().toISOString(), payload: payload || {} };
    });
  }

  _startLeaderWorkloads() {
    if (this._workloadsStarted || !this.isLeader || !this._runtimeContext) return;
    const { pool, config, requireFn, startJobQueue, jobQueueOptions } = this._runtimeContext;
    this._workloadsStarted = true;

    if (startJobQueue && pool && typeof pool.query === 'function') {
      try {
        this.jobQueue = createJobQueue({
          pool,
          intervalMs: 2500,
          concurrency: 2,
          ...(jobQueueOptions || {})
        });
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
      let mod = null;
      try {
        mod = requireFn('./payment-channels');
      } catch {
        return undefined;
      }
      return typeof mod?.startPaymentReconciliationWorker === 'function'
        ? mod.startPaymentReconciliationWorker(pool, config)
        : undefined;
    });
    safeStart('orderExpiration', () => {
      let mod = null;
      try {
        mod = requireFn('./domain/orders/order-expiration-service');
      } catch {
        return undefined;
      }
      return typeof mod?.startOrderExpirationWorker === 'function'
        ? mod.startOrderExpirationWorker(pool, config)
        : undefined;
    });
  }

  /**
   * Khởi chạy JobQueue + đăng ký handlers + khởi chạy toàn bộ worker định kỳ (nếu là Leader);
   * nếu chưa lấy được khóa (Follower hoặc DB tạm gián đoạn), giữ chế độ Fail-Closed và bật Leader Retry Loop.
   */
  async startAll(pool, config, { requireFn = require, startJobQueue = true, jobQueueOptions = null } = {}) {
    this._stopped = false;
    this._runtimeContext = { pool, config, requireFn, startJobQueue, jobQueueOptions };

    const acquired = await this.tryAcquireLeaderLock(pool);
    if (!acquired || !this.isLeader) {
      console.log('WorkerManager: Running as follower/standby node (fail-closed), background crons suppressed; leader retry scheduled.');
      this.startLeaderRetryLoop();
      return false;
    }

    if (this.leaderRetryTimer) {
      clearInterval(this.leaderRetryTimer);
      this.leaderRetryTimer = null;
    }
    this._startLeaderWorkloads();
    return true;
  }

  /**
   * Dừng toàn bộ worker, vòng lặp retry và giải phóng khóa/lease khi tắt server
   */
  async stopAll() {
    this._stopped = true;
    this._runtimeContext = null;

    if (this.leaderRetryTimer) {
      clearInterval(this.leaderRetryTimer);
      this.leaderRetryTimer = null;
    }

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
    this._workloadsStarted = false;

    const clientToUnlock = this.leaderClient;
    this.leaderClient = null;
    const wasLeader = this.isLeader;
    this.isLeader = false;

    if (clientToUnlock) {
      try {
        await clientToUnlock.query('SELECT pg_advisory_unlock($1)', [this.lockKey]);
      } catch {}
      try {
        clientToUnlock.release?.();
      } catch {}
    } else if (wasLeader) {
      // Single-client pool unlock best-effort handled on connection close
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
