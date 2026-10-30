'use strict';

async function enqueueJob(pool, { queue = 'default', name, payload = {}, runAt = new Date(), maxAttempts = 5 }) {
  if (!name || typeof name !== 'string') {
    throw new Error('Tên công việc (name) là bắt buộc.');
  }
  const result = await pool.query(
    `INSERT INTO system_jobs (queue, name, payload, status, run_at, max_attempts)
     VALUES ($1, $2, $3, 'pending', $4, $5)
     RETURNING id, queue, name, status, run_at, created_at`,
    [queue, name, JSON.stringify(payload), runAt, maxAttempts]
  );
  return result.rows[0];
}

function createJobQueue({ pool, intervalMs = 2500, concurrency = 1 } = {}) {
  const workers = new Map();
  let timer = null;
  let running = false;
  let processingCount = 0;

  function registerWorker(name, handler) {
    if (typeof handler !== 'function') throw new Error('Worker handler phải là một hàm.');
    workers.set(name, handler);
  }

  async function claimNextJob() {
    try {
      const result = await pool.query(
        `UPDATE system_jobs
         SET status = 'processing', attempts = attempts + 1, updated_at = now()
         WHERE id = (
           SELECT id FROM system_jobs
           WHERE (status = 'pending' AND run_at <= now())
              OR (status = 'processing' AND updated_at < now() - interval '5 minutes')
           ORDER BY run_at ASC, created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`
      );
      return result.rows[0] || null;
    } catch {
      // Fallback for drivers or testing engines without SKIP LOCKED
      try {
        const candidate = await pool.query(
          `SELECT id FROM system_jobs
           WHERE (status = 'pending' AND run_at <= now())
              OR (status = 'processing' AND updated_at < now() - interval '5 minutes')
           ORDER BY run_at ASC, created_at ASC
           LIMIT 1`
        );
        const row = candidate.rows[0];
        if (!row) return null;
        const updated = await pool.query(
          `UPDATE system_jobs
           SET status = 'processing', attempts = attempts + 1, updated_at = now()
           WHERE id = $1 AND (status = 'pending' OR (status = 'processing' AND updated_at < now() - interval '5 minutes'))
           RETURNING *`,
          [row.id]
        );
        return updated.rows[0] || null;
      } catch {
        return null;
      }
    }
  }

  async function processOne() {
    if (!running || processingCount >= concurrency) return;
    const job = await claimNextJob();
    if (!job) return;

    processingCount++;
    const handler = workers.get(job.name);
    try {
      if (!handler) {
        throw new Error(`Không có worker nào được đăng ký cho tác vụ "${job.name}".`);
      }
      const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : (job.payload || {});
      await handler(payload, job);
      await pool.query(
        `UPDATE system_jobs SET status = 'completed', updated_at = now() WHERE id = $1`,
        [job.id]
      );
    } catch (error) {
      const errorMsg = String(error?.message || error).slice(0, 1000);
      if (job.attempts >= job.max_attempts) {
        await pool.query(
          `UPDATE system_jobs SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
          [job.id, errorMsg]
        );
      } else {
        const backoffSeconds = Math.min(3600, Math.max(5, 5 * Math.pow(2, job.attempts)));
        await pool.query(
          `UPDATE system_jobs
           SET status = 'pending',
               run_at = now() + ($2 || ' seconds')::interval,
               last_error = $3,
               updated_at = now()
           WHERE id = $1`,
          [job.id, String(backoffSeconds), errorMsg]
        );
      }
    } finally {
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
    enqueue: (jobData) => enqueueJob(pool, jobData),
    processOne,
    start,
    stop,
    getStats
  };
}

module.exports = { enqueueJob, createJobQueue };
