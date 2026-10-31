'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { createJobQueue, enqueueJob, computeJobPayloadHash } = require('../src/job-queue');

test('Job Queue Live Benchmark & Real-World Efficacy Verification', async (t) => {
  const db = new PGlite();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS system_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      queue text NOT NULL DEFAULT 'default',
      name text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      run_at timestamptz NOT NULL DEFAULT now(),
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 5,
      last_error text,
      idempotency_key text,
      payload_hash text,
      lease_token uuid,
      lease_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS system_jobs_queue_status_run_idx ON system_jobs (queue, status, run_at);
    CREATE UNIQUE INDEX IF NOT EXISTS system_jobs_name_idempotency_uidx
      ON system_jobs (name, idempotency_key)
      WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'processing', 'completed');
    CREATE INDEX IF NOT EXISTS idx_system_jobs_lease_expiry
      ON system_jobs (status, lease_expires_at)
      WHERE status = 'processing';
  `);

  await t.test('1. Enqueue & Idempotency: Deduplicates exact jobs, detects payload tampering with 409 conflict', async () => {
    let successCount = 0;
    let duplicateCount = 0;

    // Nạp 20 jobs duy nhất
    for (let i = 1; i <= 20; i++) {
      const res = await enqueueJob(db, {
        queue: 'notifications',
        name: 'send_order_email',
        payload: { orderId: `ord-${i}`, totalVnd: 250000 },
        idempotencyKey: `idemp-key-${i}`
      });
      assert.equal(res.duplicate, false);
      successCount++;
    }

    // Nạp lại 10 jobs với cùng key và payload -> phải nhận diện duplicate: true
    for (let i = 1; i <= 10; i++) {
      const res = await enqueueJob(db, {
        queue: 'notifications',
        name: 'send_order_email',
        payload: { orderId: `ord-${i}`, totalVnd: 250000 },
        idempotencyKey: `idemp-key-${i}`
      });
      assert.equal(res.duplicate, true);
      duplicateCount++;
    }

    assert.equal(successCount, 20);
    assert.equal(duplicateCount, 10);

    // Kiểm tra số bản ghi thực tế trong CSDL đúng bằng 20 (chống trùng lặp tuyệt đối)
    const countCheck = await db.query('SELECT count(*)::int AS count FROM system_jobs');
    assert.equal(countCheck.rows[0].count, 20);

    // Cùng key nhưng payload khác -> phải bị từ chối với mã lỗi JOB_IDEMPOTENCY_CONFLICT
    await assert.rejects(
      async () => {
        await enqueueJob(db, {
          queue: 'notifications',
          name: 'send_order_email',
          payload: { orderId: 'ord-1-tampered', totalVnd: 99999999 },
          idempotencyKey: 'idemp-key-1'
        });
      },
      (err) => err.code === 'JOB_IDEMPOTENCY_CONFLICT' && err.status === 409
    );
  });

  await t.test('2. Parallel Execution & Worker State Lifecycle: Transitions pending -> processing -> completed', async () => {
    const queue = createJobQueue({
      pool: db,
      intervalMs: 50,
      concurrency: 5,
      leaseDurationMs: 5000
    });

    let executedJobs = 0;
    queue.registerWorker('send_order_email', async (payload, job, leaseCtx) => {
      leaseCtx.assertLeaseActive();
      executedJobs++;
    });

    queue.start();
    while (true) {
      const res = await queue.processOne();
      if (!res) break;
    }
    queue.stop();

    assert.equal(executedJobs, 20);
    const stats = await queue.getStats();
    assert.equal(stats.completed, 20);
    assert.equal(stats.pending, 0);
    assert.equal(stats.processing, 0);
  });

  await t.test('3. Distributed Lock & Heartbeat Lease: Prevents job stealing during prolonged execution', async () => {
    const heavyJob = await enqueueJob(db, {
      queue: 'sync',
      name: 'long_task',
      payload: { chunk: 1 }
    });

    const shortLeaseQueue = createJobQueue({
      pool: db,
      intervalMs: 50,
      leaseDurationMs: 120,    // Lease ngắn 120ms
      heartbeatIntervalMs: 30  // Heartbeat 30ms tự động gia hạn
    });

    let heartbeatsRecorded = 0;
    shortLeaseQueue.registerWorker('long_task', async (payload, job, leaseCtx) => {
      const start = Date.now();
      while (Date.now() - start < 180) { // Chạy 180ms (> 120ms lease ban đầu)
        await new Promise((r) => setTimeout(r, 20));
        leaseCtx.assertLeaseActive();
        heartbeatsRecorded++;
      }
    });

    shortLeaseQueue.start();
    const result = await shortLeaseQueue.processOne();
    shortLeaseQueue.stop();

    assert.equal(result.status, 'completed');
    assert.equal(result.fenced, false);
    assert.ok(heartbeatsRecorded >= 3, 'Heartbeat phải duy trì lease thành công qua nhiều chu kỳ');
  });

  await t.test('4. Exponential Backoff & Dead-Letter Queue (DLQ): Retries with backoff and marks failed when max_attempts reached', async () => {
    const failJob = await enqueueJob(db, {
      queue: 'payment',
      name: 'failing_bank_sync',
      payload: { attempt: 1 },
      maxAttempts: 3
    });

    const errQueue = createJobQueue({ pool: db, intervalMs: 50 });
    let calls = 0;
    errQueue.registerWorker('failing_bank_sync', async () => {
      calls++;
      throw new Error(`VietQR API Timeout (Lần ${calls})`);
    });

    errQueue.start();
    // Lần 1: Lỗi -> status = pending, attempts = 1, run_at bị đẩy lùi
    const o1 = await errQueue.processOne();
    assert.equal(o1.status, 'pending');
    const row1 = (await db.query('SELECT attempts, status, last_error, run_at > now() as "backedOff" FROM system_jobs WHERE id = $1', [failJob.id])).rows[0];
    assert.equal(row1.attempts, 1);
    assert.equal(row1.status, 'pending');
    assert.equal(row1.backedOff, true);

    // Lần 2: Giả lập thời gian backoff đã trôi qua
    await db.query('UPDATE system_jobs SET run_at = now() WHERE id = $1', [failJob.id]);
    const o2 = await errQueue.processOne();
    assert.equal(o2.status, 'pending');
    const row2 = (await db.query('SELECT attempts, status FROM system_jobs WHERE id = $1', [failJob.id])).rows[0];
    assert.equal(row2.attempts, 2);

    // Lần 3: Đạt max_attempts (3) -> status = failed (DLQ)
    await db.query('UPDATE system_jobs SET run_at = now() WHERE id = $1', [failJob.id]);
    const o3 = await errQueue.processOne();
    assert.equal(o3.status, 'failed');
    const row3 = (await db.query('SELECT attempts, status, last_error FROM system_jobs WHERE id = $1', [failJob.id])).rows[0];
    assert.equal(row3.attempts, 3);
    assert.equal(row3.status, 'failed');
    assert.match(row3.last_error, /VietQR API Timeout/);

    errQueue.stop();
  });

  await db.close();
});
