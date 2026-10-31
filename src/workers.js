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
    this._cachedMailer = null;
    this._cachedSmtpOptionsKey = null;
  }

  /**
   * Khởi tạo hoặc lấy transporter SMTP được tái sử dụng (memoized), có kiểm tra tính hợp lệ cấu hình
   */
  getOrCreateMailer(config, { requireFn = require } = {}) {
    if (!config?.smtp) return null;
    try {
      const smtpSecurity = requireFn('./smtp-security');
      const opts = smtpSecurity.smtpOptions(config.smtp);
      const key = JSON.stringify(opts);
      if (this._cachedMailer && this._cachedSmtpOptionsKey === key) {
        return this._cachedMailer;
      }
      const nodemailer = requireFn('nodemailer');
      this._cachedMailer = nodemailer.createTransport(opts);
      this._cachedSmtpOptionsKey = key;
      return this._cachedMailer;
    } catch (err) {
      throw Object.assign(
        new Error(`Lỗi cấu hình hoặc khởi tạo SMTP transport: ${err?.message || err}`),
        { code: 'SMTP_CONFIG_INVALID', cause: err }
      );
    }
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

    if (this._cachedMailer && typeof this._cachedMailer.close === 'function') {
      try { this._cachedMailer.close(); } catch {}
      this._cachedMailer = null;
      this._cachedSmtpOptionsKey = null;
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
          void this._startLeaderWorkloads();
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

    const getOrCreateMailer = () => this.getOrCreateMailer(config, { requireFn });

    const normalizeEmailWorkerResult = (res) => {
      if (typeof res === 'object' && res !== null && res.status) {
        return res;
      }
      if (res === true) {
        return { status: 'sent' };
      }
      return { status: 'no_work' };
    };

    this.jobQueue.registerWorker('email.order', async (payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
      const orderEmail = requireFn('./order-email');
      const mailer = getOrCreateMailer();

      // P2-02: Tách biệt hoàn toàn: email.order chỉ tập trung gửi email đơn hàng cho khách qua outbox
      // Mọi bước sàng lọc, phân loại và cảnh báo quản trị được giao cho handler order.review chuyên trách
      const fn = orderEmail.processOrderEmailOutbox || orderEmail.processOrderEmail;
      let res = null;
      if (typeof fn === 'function') {
        res = await fn(pool, config, mailer, { structured: true });
      }

      return normalizeEmailWorkerResult(res);
    });

    this.jobQueue.registerWorker('order.review', async (payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
      let orderReview = null;
      try {
        orderReview = requireFn('./order-review');
      } catch {}
      const mailer = getOrCreateMailer();

      // P2-02 & P2-03: Dùng OrderReviewService tập trung cho toàn bộ quy trình kiểm duyệt
      if (orderReview?.OrderReviewService?.processReviewCycle) {
        const cycleResult = await orderReview.OrderReviewService.processReviewCycle(pool, config, mailer, payload);
        return { ok: true, ...cycleResult };
      }

      // Fallback thủ công nếu thiếu OrderReviewService
      const errors = [];
      let screened = false;
      if (typeof orderReview?.screenNextEmail === 'function') {
        try {
          await orderReview.screenNextEmail(pool, { resolver: payload?.resolver });
          screened = true;
        } catch (e) {
          console.warn('order.review screenNextEmail error:', e?.message || e);
          errors.push({ step: 'screenNextEmail', error: e });
        }
      }
      let classified = false;
      if (typeof orderReview?.classify === 'function') {
        try {
          await orderReview.classify(pool);
          classified = true;
        } catch (e) {
          console.warn('order.review classify error:', e?.message || e);
          errors.push({ step: 'classify', error: e });
        }
      }
      let notified = false;
      if (typeof orderReview?.notifyAdmin === 'function') {
        try {
          notified = await orderReview.notifyAdmin(pool, config, mailer);
        } catch (e) {
          console.warn('order.review notifyAdmin error:', e?.message || e);
          errors.push({ step: 'notifyAdmin', error: e });
        }
      }

      if (errors.length > 0) {
        const msg = errors.map(e => `${e.step}: ${e.error?.message || e.error}`).join('; ');
        const err = new Error(`Order review execution encountered partial failure: ${msg}`);
        err.code = 'ORDER_REVIEW_PARTIAL_FAILURE';
        err.errors = errors;
        throw err;
      }

      return { ok: true, screened, classified, notified, slaBreaches: 0 };
    });

    this.jobQueue.registerWorker('email.warranty', async (payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
      const warrantyEmail = requireFn('./warranty-email');
      const mailer = getOrCreateMailer();
      const fn = warrantyEmail.processWarrantyEmailOutbox || warrantyEmail.processWarrantyEmail;
      if (typeof fn === 'function') {
        const res = await fn(pool, config, mailer, { structured: true });
        return normalizeEmailWorkerResult(res);
      }
      return { status: 'no_work' };
    });

    this.jobQueue.registerWorker('email.marketing', async (payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
      const emailMarketing = requireFn('./email-marketing');
      const mailer = getOrCreateMailer();
      const fn = emailMarketing.processMarketingEmails || emailMarketing.processEmailQueue;
      if (typeof fn === 'function') {
        const res = await fn(pool, config, mailer, { structured: true });
        return normalizeEmailWorkerResult(res);
      }
      return { status: 'no_work' };
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
      const { OrderExpirationService } = requireFn('./domain/orders/order-expiration-service');
      if (typeof OrderExpirationService?.cancelExpiredUnpaidOrders === 'function') {
        const result = await OrderExpirationService.cancelExpiredUnpaidOrders(pool, {
          olderThanHours: payload?.olderThanHours || 24,
          channelTtlHours: payload?.channelTtlHours || null,
          config
        });
        if (result?.failedCount > 0 && (!result?.cancelledCount || result?.cancelledCount === 0)) {
          const firstErr = result?.errors?.[0];
          throw Object.assign(
            new Error(`orders.cancel_expired thất bại cho toàn bộ ${result.failedCount} đơn quá hạn: ${firstErr?.error || 'Lỗi không xác định'}`),
            { code: 'CANCEL_EXPIRED_ALL_FAILED', errors: result.errors }
          );
        }
        return {
          status: result?.failedCount > 0
            ? 'partial_failure'
            : (result?.cancelledCount > 0 || (Array.isArray(result) && result.length > 0) ? 'processed' : 'no_work'),
          cancelledCount: result?.cancelledCount ?? (Array.isArray(result) ? result.length : 0),
          failedCount: result?.failedCount || 0,
          errors: result?.errors || [],
          cancelled: result?.cancelled || (Array.isArray(result) ? result : [])
        };
      }
      return { status: 'no_work', cancelledCount: 0 };
    });

    this.jobQueue.registerWorker('health.check', async (payload, _job, leaseContext) => {
      leaseContext?.assertLeaseActive?.();
      return { ok: true, checkedAt: new Date().toISOString(), payload: payload || {} };
    });
  }

  async _startLeaderWorkloads() {
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

        // P2-04: Luồng chủ đạo Leader + JobQueue/Cron cho chức năng quét đơn hết hạn:
        // Đảm bảo chỉ một job đang quét, có quan sát (system_jobs) và cơ chế retry có kiểm soát.
        const cronIntervalMs = Math.max(
          10000,
          Number(config?.ORDER_EXPIRY_CRON_INTERVAL_MS || config?.ORDER_EXPIRY_INTERVAL_MS || jobQueueOptions?.orderExpiryIntervalMs || 5 * 60 * 1000)
        );

        const isImmediate = Boolean(jobQueueOptions?.immediateOrderExpiry || config?.ORDER_EXPIRY_IMMEDIATE);
        await this.enqueueOrderExpirationJob(pool, config, { immediate: isImmediate, runAt: isImmediate ? null : new Date(Date.now() + cronIntervalMs) });

        const cronTimer = setInterval(() => {
          if (this.isLeader && !this._stopped) {
            void this.enqueueOrderExpirationJob(pool, config, { immediate: false });
          }
        }, cronIntervalMs);
        if (cronTimer.unref) cronTimer.unref();

        this.workers.set('orderExpirationScheduler', () => {
          clearInterval(cronTimer);
        });

        // PR A: Đưa order.review vào lịch trình định kỳ của JobQueue
        const reviewIntervalMs = Math.max(
          10000,
          Number(config?.ORDER_REVIEW_CRON_INTERVAL_MS || config?.ORDER_REVIEW_INTERVAL_MS || jobQueueOptions?.orderReviewIntervalMs || 60 * 1000)
        );
        const isImmediateReview = Boolean(jobQueueOptions?.immediateOrderReview || config?.ORDER_REVIEW_IMMEDIATE);
        await this.enqueueOrderReviewJob(pool, config, {
          immediate: isImmediateReview,
          runAt: isImmediateReview ? null : new Date(Date.now() + reviewIntervalMs)
        });

        const reviewCronTimer = setInterval(() => {
          if (this.isLeader && !this._stopped) {
            void this.enqueueOrderReviewJob(pool, config, { immediate: false });
          }
        }, reviewIntervalMs);
        if (reviewCronTimer.unref) reviewCronTimer.unref();

        this.workers.set('orderReviewScheduler', () => {
          clearInterval(reviewCronTimer);
        });

        // P2-02: Đưa email.order vào lịch trình JobQueue định kỳ của leader
        const emailIntervalMs = Math.max(
          5000,
          Number(config?.ORDER_EMAIL_CRON_INTERVAL_MS || config?.ORDER_EMAIL_INTERVAL_MS || jobQueueOptions?.orderEmailIntervalMs || 10 * 1000)
        );
        const emailTimer = setInterval(() => {
          if (this.isLeader && !this._stopped) {
            void this.enqueueOrderEmailJob(pool, config, { immediate: false });
          }
        }, emailIntervalMs);
        if (emailTimer.unref) emailTimer.unref();

        this.workers.set('orderEmailScheduler', () => {
          clearInterval(emailTimer);
        });
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
    // P2-02: Worker định kỳ chỉ làm fallback khi JobQueue không được bật
    if (!this.jobQueue) {
      safeStart('orderEmail', () => {
        let mailer = null;
        try {
          mailer = this.getOrCreateMailer(config, { requireFn });
        } catch {}
        return requireFn('./order-email').startOrderEmailWorker(pool, config, { mailer });
      });
    }
    safeStart('warrantyEmail', () => {
      let mailer = null;
      try {
        mailer = this.getOrCreateMailer(config, { requireFn });
      } catch {}
      return requireFn('./warranty-email').startWarrantyEmailWorker(pool, config, { mailer });
    });
    safeStart('emailMarketing', () => {
      let mailer = null;
      try {
        mailer = this.getOrCreateMailer(config, { requireFn });
      } catch {}
      return requireFn('./email-marketing').startEmailWorker(pool, config, { mailer });
    });
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

    // P2-04: Loại bỏ việc chạy song song startOrderExpirationWorker khi JobQueue đã được kích hoạt.
    // Chỉ fallback sang startOrderExpirationWorker nếu JobQueue không được bật.
    if (!this.jobQueue) {
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
  }

  /**
   * P2-04: Enqueue tác vụ định kỳ orders.cancel_expired vào JobQueue
   * Đảm bảo chỉ một job đang quét (pending hoặc processing), có quan sát và retry.
   */
  async enqueueOrderExpirationJob(pool = null, config = null, {
    immediate = false,
    olderThanHours = null,
    runAt = null
  } = {}) {
    const targetPool = pool || this._runtimeContext?.pool;
    const targetConfig = config || this._runtimeContext?.config || {};
    if (!targetPool || typeof targetPool.query !== 'function') return null;

    try {
      // 1. Đảm bảo chỉ một job đang quét: Kiểm tra xem đã có job nào đang pending hoặc processing chưa
      const activeCheck = await targetPool.query(
        `SELECT id, status, run_at FROM system_jobs
         WHERE name = 'orders.cancel_expired'
           AND status IN ('pending', 'processing')
         ORDER BY run_at ASC, id ASC
         LIMIT 1`
      ).catch(() => ({ rows: [] }));

      if (activeCheck?.rows?.length > 0) {
        const activeJob = activeCheck.rows[0];
        if (immediate && activeJob.status === 'pending' && new Date(activeJob.run_at) > new Date()) {
          await targetPool.query(
            `UPDATE system_jobs SET run_at = now(), updated_at = now() WHERE id = $1`,
            [activeJob.id]
          ).catch(() => {});
          return { queued: false, updated: true, activeJobId: activeJob.id, status: 'pending' };
        }
        return {
          queued: false,
          reason: 'already_active',
          activeJobId: activeJob.id,
          status: activeJob.status
        };
      }

      // 2. Tính toán thời điểm thực thi run_at
      const cronIntervalMs = Math.max(
        10000,
        Number(targetConfig?.ORDER_EXPIRY_CRON_INTERVAL_MS || targetConfig?.ORDER_EXPIRY_INTERVAL_MS || 5 * 60 * 1000)
      );
      const targetRunAt = immediate
        ? null
        : (runAt || new Date(Date.now() + cronIntervalMs));

      const slot = Math.floor((targetRunAt ? new Date(targetRunAt).getTime() : Date.now()) / 60000);
      const idempotencyKey = `orders.cancel_expired:${slot}`;

      // 3. Đẩy vào JobQueue với độ bền bỉ, quan sát được và kiểm soát retry
      const { enqueueJob } = require('./job-queue');
      const job = await enqueueJob(targetPool, {
        queue: 'maintenance',
        name: 'orders.cancel_expired',
        payload: {
          olderThanHours: Number(olderThanHours ?? targetConfig?.ORDER_EXPIRY_DEFAULT_HOURS ?? 24),
          scheduledAt: new Date().toISOString()
        },
        idempotencyKey,
        runAt: targetRunAt,
        maxAttempts: 3
      });

      return { queued: true, job };
    } catch (err) {
      console.error('WorkerManager: Lỗi khi enqueue định kỳ orders.cancel_expired:', err?.message || err);
      return null;
    }
  }

  /**
   * PR A: Enqueue tác vụ định kỳ order.review vào JobQueue
   * Sàng lọc domain email, phân loại đơn có email bất thường và gửi thông báo cho quản trị viên.
   */

  async enqueueOrderEmailJob(pool = null, config = null, {
    immediate = false,
    runAt = null
  } = {}) {
    const targetPool = pool || this._runtimeContext?.pool;
    if (!targetPool || typeof targetPool.query !== 'function') return null;

    const { enqueueJob } = require('./job-queue');
    const nowMs = Date.now();
    const effectiveRunAt = immediate ? new Date(nowMs) : (runAt || new Date(nowMs + 10000));
    const idempotencyBucket = Math.floor(effectiveRunAt.getTime() / 10000);
    const idempotencyKey = `email.order:${idempotencyBucket}`;

    return enqueueJob(targetPool, {
      queue: 'default',
      name: 'email.order',
      payload: {},
      idempotencyKey,
      runAt: effectiveRunAt,
      maxAttempts: 3
    }).catch(err => {
      console.warn('enqueueOrderEmailJob warning:', err?.message || err);
      return null;
    });
  }

  async enqueueOrderReviewJob(pool = null, config = null, {
    immediate = false,
    runAt = null
  } = {}) {
    const targetPool = pool || this._runtimeContext?.pool;
    const targetConfig = config || this._runtimeContext?.config || {};
    if (!targetPool || typeof targetPool.query !== 'function') return null;

    try {
      const activeCheck = await targetPool.query(
        `SELECT id, status, run_at FROM system_jobs
         WHERE name = 'order.review'
           AND status IN ('pending', 'processing')
         ORDER BY run_at ASC, id ASC
         LIMIT 1`
      ).catch(() => ({ rows: [] }));

      if (activeCheck?.rows?.length > 0) {
        const activeJob = activeCheck.rows[0];
        if (immediate && activeJob.status === 'pending' && new Date(activeJob.run_at) > new Date()) {
          await targetPool.query(
            `UPDATE system_jobs SET run_at = now(), updated_at = now() WHERE id = $1`,
            [activeJob.id]
          ).catch(() => {});
          return { queued: false, updated: true, activeJobId: activeJob.id, status: 'pending' };
        }
        return {
          queued: false,
          reason: 'already_active',
          activeJobId: activeJob.id,
          status: activeJob.status
        };
      }

      const reviewIntervalMs = Math.max(
        10000,
        Number(targetConfig?.ORDER_REVIEW_CRON_INTERVAL_MS || targetConfig?.ORDER_REVIEW_INTERVAL_MS || 60 * 1000)
      );
      const targetRunAt = immediate
        ? null
        : (runAt || new Date(Date.now() + reviewIntervalMs));

      const slot = Math.floor((targetRunAt ? new Date(targetRunAt).getTime() : Date.now()) / 60000);
      const idempotencyKey = `order.review:${slot}`;

      const { enqueueJob } = require('./job-queue');
      const job = await enqueueJob(targetPool, {
        queue: 'maintenance',
        name: 'order.review',
        payload: {
          scheduledAt: new Date().toISOString()
        },
        idempotencyKey,
        runAt: targetRunAt,
        maxAttempts: 3
      });

      return { queued: true, job };
    } catch (err) {
      console.error('WorkerManager: Lỗi khi enqueue định kỳ order.review:', err?.message || err);
      return null;
    }
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
    await this._startLeaderWorkloads();
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

    if (this._cachedMailer && typeof this._cachedMailer.close === 'function') {
      try { this._cachedMailer.close(); } catch {}
      this._cachedMailer = null;
      this._cachedSmtpOptionsKey = null;
    }

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
