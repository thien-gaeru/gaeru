'use strict';

const { randomUUID, createHash } = require('node:crypto');

const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000; // 5 phút

function canonicalizeJobPayload(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalizeJobPayload);
  if (typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      if (key === '_idempotencyKey' || key === 'idempotencyKey' || value[key] === undefined) continue;
      sorted[key] = canonicalizeJobPayload(value[key]);
    }
    return sorted;
  }
  return value;
}

function computeJobPayloadHash(name, payload = {}) {
  const normalizedPayload = typeof payload === 'string'
    ? (() => { try { return JSON.parse(payload); } catch { return payload; } })()
    : (payload || {});
  const canonical = {
    name: String(name || ''),
    payload: canonicalizeJobPayload(normalizedPayload)
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function enqueueJob(pool, {
  queue = 'default',
  name,
  payload = {},
  idempotencyKey = null,
  runAt = null,
  maxAttempts = 5
}) {
  if (!name || typeof name !== 'string') {
    throw new Error('Tên công việc (name) là bắt buộc.');
  }

  const rawKey = idempotencyKey ?? payload?._idempotencyKey ?? payload?.idempotencyKey ?? null;
  const effectiveKey = rawKey !== null && rawKey !== undefined && String(rawKey).trim() !== ''
    ? String(rawKey).trim()
    : null;

  const basePayload = payload && typeof payload === 'object' ? payload : {};
  const enrichedPayload = effectiveKey
    ? { ...basePayload, _idempotencyKey: effectiveKey }
    : basePayload;
  const payloadHash = computeJobPayloadHash(name, basePayload);
  const serializedPayload = JSON.stringify(enrichedPayload);

  if (effectiveKey) {
    const inserted = await pool.query(
      `INSERT INTO system_jobs (
         queue, name, payload, idempotency_key, payload_hash, status, run_at, max_attempts
       )
       VALUES ($1, $2, $3, $4, $5, 'pending', COALESCE($6::timestamptz, now()), $7)
       ON CONFLICT (name, idempotency_key)
         WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'processing', 'completed')
       DO NOTHING
       RETURNING id, queue, name, status, idempotency_key, payload_hash, run_at, created_at`,
      [queue, name, serializedPayload, effectiveKey, payloadHash, runAt, maxAttempts]
    );

    if (inserted.rows && inserted.rows[0]) {
      return { ...inserted.rows[0], duplicate: false };
    }

    const existingRes = await pool.query(
      `SELECT id, queue, name, status, idempotency_key, payload_hash, payload, run_at, created_at
       FROM system_jobs
       WHERE name = $1
         AND idempotency_key = $2
         AND status IN ('pending', 'processing', 'completed')
       ORDER BY created_at DESC
       LIMIT 1`,
      [name, effectiveKey]
    );

    const existing = existingRes.rows?.[0];
    if (existing) {
      const existingHash = existing.payload_hash || computeJobPayloadHash(name, existing.payload);
      if (existingHash !== payloadHash) {
        throw Object.assign(
          new Error(`Khóa idempotency "${effectiveKey}" của công việc "${name}" đã tồn tại với nội dung payload khác.`),
          { status: 409, code: 'JOB_IDEMPOTENCY_CONFLICT' }
        );
      }
      const { payload: _omittedPayload, ...rest } = existing;
      return { ...rest, duplicate: true };
    }

    // Trường hợp hiếm: job giữ khóa vừa chuyển sang 'failed' đúng giữa lúc ON CONFLICT và SELECT -> thử chèn lại 1 lần
    const retryInsert = await pool.query(
      `INSERT INTO system_jobs (
         queue, name, payload, idempotency_key, payload_hash, status, run_at, max_attempts
       )
       VALUES ($1, $2, $3, $4, $5, 'pending', COALESCE($6::timestamptz, now()), $7)
       ON CONFLICT (name, idempotency_key)
         WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'processing', 'completed')
       DO NOTHING
       RETURNING id, queue, name, status, idempotency_key, payload_hash, run_at, created_at`,
      [queue, name, serializedPayload, effectiveKey, payloadHash, runAt, maxAttempts]
    );
    if (retryInsert.rows && retryInsert.rows[0]) {
      return { ...retryInsert.rows[0], duplicate: false };
    }
  }

  const result = await pool.query(
    `INSERT INTO system_jobs (queue, name, payload, idempotency_key, payload_hash, status, run_at, max_attempts)
     VALUES ($1, $2, $3, NULL, $4, 'pending', COALESCE($5::timestamptz, now()), $6)
     RETURNING id, queue, name, status, idempotency_key, payload_hash, run_at, created_at`,
    [queue, name, serializedPayload, payloadHash, runAt, maxAttempts]
  );
  return { ...result.rows[0], duplicate: false };
}

function createJobQueue({
  pool,
  intervalMs = 2500,
  concurrency = 1,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  heartbeatIntervalMs = null
} = {}) {
  const workers = new Map();
  let timer = null;
  let running = false;
  let processingCount = 0;

  const effectiveLeaseMs = Math.max(50, Number(leaseDurationMs) || DEFAULT_LEASE_DURATION_MS);
  const effectiveHeartbeatMs = Math.max(
    20,
    Number(heartbeatIntervalMs) || Math.floor(effectiveLeaseMs / 3)
  );

  function registerWorker(name, handler) {
    if (typeof handler !== 'function') throw new Error('Worker handler phải là một hàm.');
    workers.set(name, handler);
  }

  function hasWorker(name) {
    return workers.has(name);
  }

  function getRegisteredWorkers() {
    return [...workers.keys()];
  }

  async function claimNextJob() {
    const leaseToken = randomUUID();
    const leaseMsStr = String(effectiveLeaseMs);
    try {
      const result = await pool.query(
        `UPDATE system_jobs
         SET status = 'processing',
             attempts = attempts + 1,
             lease_token = $1,
             lease_expires_at = now() + ($2 || ' milliseconds')::interval,
             updated_at = now()
         WHERE id = (
           SELECT id FROM system_jobs
           WHERE (status = 'pending' AND run_at <= now())
              OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
              OR (status = 'processing' AND updated_at < now() - interval '5 minutes' AND lease_expires_at IS NULL)
           ORDER BY run_at ASC, created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [leaseToken, leaseMsStr]
      );
      const row = result.rows?.[0] || null;
      if (!row) return null;
      return { ...row, lease_token: row.lease_token || leaseToken };
    } catch {
      // Fallback cho môi trường test adapter không hỗ trợ SKIP LOCKED
      try {
        const candidate = await pool.query(
          `SELECT id FROM system_jobs
           WHERE (status = 'pending' AND run_at <= now())
              OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
              OR (status = 'processing' AND updated_at < now() - interval '5 minutes' AND lease_expires_at IS NULL)
           ORDER BY run_at ASC, created_at ASC
           LIMIT 1`
        );
        const row = candidate.rows?.[0];
        if (!row) return null;
        const updated = await pool.query(
          `UPDATE system_jobs
           SET status = 'processing',
               attempts = attempts + 1,
               lease_token = $2,
               lease_expires_at = now() + ($3 || ' milliseconds')::interval,
               updated_at = now()
           WHERE id = $1
             AND (
               status = 'pending'
               OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now())
               OR (status = 'processing' AND updated_at < now() - interval '5 minutes' AND lease_expires_at IS NULL)
             )
           RETURNING *`,
          [row.id, leaseToken, leaseMsStr]
        );
        const claimedRow = updated.rows?.[0] || null;
        if (!claimedRow) return null;
        return { ...claimedRow, lease_token: claimedRow.lease_token || leaseToken };
      } catch {
        return null;
      }
    }
  }

  async function renewJobLease(jobId, leaseToken) {
    const res = await pool.query(
      `UPDATE system_jobs
       SET lease_expires_at = now() + ($3 || ' milliseconds')::interval,
           updated_at = now()
       WHERE id = $1
         AND status = 'processing'
         AND lease_token = $2
       RETURNING id, lease_expires_at`,
      [jobId, leaseToken, String(effectiveLeaseMs)]
    );
    if (typeof res?.rowCount === 'number' && res.rowCount === 0) {
      return false;
    }
    return true;
  }

  async function processOne() {
    if (!running || processingCount >= concurrency) return null;
    const job = await claimNextJob();
    if (!job) return null;

    processingCount++;
    const activeLeaseToken = job.lease_token;
    let leaseLost = false;
    let heartbeatStopped = false;
    let inFlightRenewal = null;

    const triggerRenewal = async () => {
      if (heartbeatStopped || leaseLost) return false;
      try {
        const ok = await renewJobLease(job.id, activeLeaseToken);
        if (!ok) {
          leaseLost = true;
          stopHeartbeat();
        }
        return ok;
      } catch {
        return false;
      }
    };

    let heartbeatTimer = setInterval(() => {
      if (heartbeatStopped || leaseLost || inFlightRenewal) return;
      inFlightRenewal = triggerRenewal().finally(() => {
        inFlightRenewal = null;
      });
    }, effectiveHeartbeatMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    function stopHeartbeat() {
      heartbeatStopped = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    const leaseContext = {
      leaseToken: activeLeaseToken,
      leaseDurationMs: effectiveLeaseMs,
      renewLease: triggerRenewal,
      stopHeartbeat,
      isLeaseLost: () => leaseLost,
      assertLeaseActive: () => {
        if (leaseLost) {
          throw Object.assign(
            new Error(`Lease của công việc "${job.id}" đã hết hạn hoặc bị thu hồi bởi worker khác.`),
            { code: 'JOB_LEASE_LOST' }
          );
        }
      }
    };

    const handler = workers.get(job.name);
    try {
      if (!handler) {
        throw new Error(`Không có worker nào được đăng ký cho tác vụ "${job.name}".`);
      }
      const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : (job.payload || {});
      await handler(payload, job, leaseContext);

      stopHeartbeat();
      if (inFlightRenewal) await inFlightRenewal.catch(() => {});

      const completedRes = await pool.query(
        `UPDATE system_jobs
         SET status = 'completed',
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [job.id, activeLeaseToken]
      );
      const fenced = typeof completedRes?.rowCount === 'number' && completedRes.rowCount === 0;
      return { id: job.id, status: fenced ? 'fenced' : 'completed', fenced, leaseToken: activeLeaseToken };
    } catch (error) {
      stopHeartbeat();
      if (inFlightRenewal) await inFlightRenewal.catch(() => {});

      const errorMsg = String(error?.message || error).slice(0, 1000);
      if (job.attempts >= job.max_attempts) {
        const failRes = await pool.query(
          `UPDATE system_jobs
           SET status = 'failed',
               last_error = $3,
               lease_token = NULL,
               lease_expires_at = NULL,
               updated_at = now()
           WHERE id = $1 AND lease_token = $2`,
          [job.id, activeLeaseToken, errorMsg]
        );
        const fenced = typeof failRes?.rowCount === 'number' && failRes.rowCount === 0;
        return { id: job.id, status: fenced ? 'fenced' : 'failed', fenced, leaseToken: activeLeaseToken };
      }

      const backoffSeconds = Math.min(3600, Math.max(5, 5 * Math.pow(2, job.attempts)));
      const retryRes = await pool.query(
        `UPDATE system_jobs
         SET status = 'pending',
             run_at = now() + ($3 || ' seconds')::interval,
             last_error = $4,
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [job.id, activeLeaseToken, String(backoffSeconds), errorMsg]
      );
      const fenced = typeof retryRes?.rowCount === 'number' && retryRes.rowCount === 0;
      return { id: job.id, status: fenced ? 'fenced' : 'pending', fenced, leaseToken: activeLeaseToken };
    } finally {
      stopHeartbeat();
      processingCount--;
    }
  }

  async function tick() {
    if (!running) return;
    try {
      await processOne();
    } catch {
      // Suppress unhandled loop error
    }
    if (running) {
      timer = setTimeout(tick, intervalMs);
      if (timer.unref) timer.unref();
    }
  }

  function start() {
    if (running) return;
    running = true;
    timer = setTimeout(tick, 100);
    if (timer.unref) timer.unref();
  }

  function stop() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function getStats() {
    const res = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM system_jobs GROUP BY status`
    );
    const stats = { pending: 0, processing: 0, completed: 0, failed: 0 };
    for (const row of res.rows) {
      if (row.status in stats) stats[row.status] = row.count;
    }
    return stats;
  }

  return {
    registerWorker,
    hasWorker,
    getRegisteredWorkers,
    enqueue: (jobData) => enqueueJob(pool, jobData),
    claimNextJob,
    renewJobLease,
    processOne,
    start,
    stop,
    getStats
  };
}

module.exports = { enqueueJob, createJobQueue, computeJobPayloadHash };
