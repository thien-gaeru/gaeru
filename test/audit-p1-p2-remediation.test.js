'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const { createTestDb } = require('./helpers/pglite-db');
const { withTransaction } = require('../src/db');
const { createApp } = require('../src/app');
const { InventoryService } = require('../src/domain/inventory/inventory-service');
const { PricingEngine } = require('../src/domain/pricing/pricing-engine');
const { CatalogService } = require('../src/domain/catalog/catalog-service');
const { enqueueJob, createJobQueue } = require('../src/job-queue');
const { WorkerManager } = require('../src/workers');
const { buildInvoicePayload } = require('../src/misa-einvoice');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHttpSessionClient(baseUrl) {
  let cookie = '';
  let csrf = '';
  const api = {
    async request(url, method = 'GET', body) {
      const response = await fetch(baseUrl + url, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (data && typeof data === 'object' && data.csrfToken) {
        csrf = data.csrfToken;
      }
      return { status: response.status, data };
    },
    async ensureCsrf() {
      return api.request('/api/csrf', 'GET');
    }
  };
  return api;
}

// ============================================================================
// P1-1: InventoryService.applyMovement — Concurrent Idempotency, 409 Payload
// Conflict & Production Fail-Closed Warehouse Schema
// ============================================================================

test('P1-1: InventoryService.applyMovement đồng thời (Promise.all + mock race), chặn 409 khi lệch payload và fail-closed khi lỗi lược đồ kho', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const prod = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('p1-inv-prod', 'GAERU P1 Mic', 'audio', true) RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-P1-CONC', 'Standard', 500000, 5, true) RETURNING id`,
    [prod.id]
  )).rows[0];
  const mainWh = (await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN'`)).rows[0];
  await pool.query(
    `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 5)`,
    [mainWh.id, variant.id]
  );

  // 1a. Hai lời gọi đồng thời Promise.all trên PostgreSQL với cùng eventId (+2 từ tồn 5 -> phải dừng ở 7, KHÔNG thành 9!)
  const [resA, resB] = await Promise.all([
    withTransaction(pool, (client) =>
      InventoryService.applyMovement(client, {
        source: 'purchase_receipt',
        eventId: 'CONC-PO-001',
        variantId: variant.id,
        delta: 2,
        actor: { username: 'warehouse_staff' },
        metadata: { channel: 'erp', poCode: 'PO-2026-01' }
      })
    ),
    withTransaction(pool, (client) =>
      InventoryService.applyMovement(client, {
        source: 'purchase_receipt',
        eventId: 'CONC-PO-001',
        variantId: variant.id,
        delta: 2,
        actor: { username: 'warehouse_staff' },
        metadata: { channel: 'erp', poCode: 'PO-2026-01', retryCount: 1 }
      })
    )
  ]);

  assert.equal([resA.duplicate, resB.duplicate].filter(Boolean).length, 1, 'Đúng 1 lời gọi là bản gốc và 1 lời gọi là duplicate');
  assert.equal(resA.stockQuantity, 7);
  assert.equal(resB.stockQuantity, 7);

  const dbVarStock = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity;
  const dbWhStock = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [mainWh.id, variant.id])).rows[0].quantity;
  const dbMovements = (await pool.query(`SELECT id, delta, payload_hash FROM inventory_movements WHERE variant_id = $1`, [variant.id])).rows;
  assert.equal(dbVarStock, 7, 'product_variants.stock_quantity phải bằng 7');
  assert.equal(dbWhStock, 7, 'warehouse_stock.quantity phải bằng 7');
  assert.equal(dbMovements.length, 1, 'Sổ inventory_movements chỉ có đúng 1 dòng');
  assert.ok(dbMovements[0].payload_hash && dbMovements[0].payload_hash.length === 64, 'Phải lưu payload_hash SHA-256');

  // 1b. Cùng eventId nhưng payload/metadata hoặc delta khác -> BẮT BUỘC từ chối 409 Conflict!
  await assert.rejects(
    async () => {
      await withTransaction(pool, (client) =>
        InventoryService.applyMovement(client, {
          source: 'purchase_receipt',
          eventId: 'CONC-PO-001',
          variantId: variant.id,
          delta: 2,
          metadata: { channel: 'erp', poCode: 'PO-TAMPERED-99' }
        })
      );
    },
    (err) => err.status === 409 && err.code === 'INVENTORY_EVENT_CONFLICT'
  );

  // 1c. Mô phỏng race đan xen (interleaved mock): cả 2 lời gọi cùng đi qua bước pre-check trống và đụng nhau tại ON CONFLICT(event_key) DO NOTHING
  const simState = {
    variantStock: 5,
    warehouseStock: 5,
    movements: new Map()
  };
  const raceClient = {
    async query(sql, params = []) {
      const norm = sql.replace(/\s+/g, ' ').trim();
      await Promise.resolve(); // Ép nhường microtask để 2 lời gọi đan xen thực sự
      if (norm.startsWith('SELECT v.id, v.sku')) {
        return { rows: [{ id: variant.id, sku: 'SKU-P1-CONC', variantName: 'Standard', productName: 'GAERU P1 Mic', stockQuantity: simState.variantStock }] };
      }
      if (norm.startsWith('SELECT id, warehouse_id AS "warehouseId", variant_id AS "variantId", delta')) {
        // Cố tình trả rỗng ở pre-check để cả 2 lời gọi cùng đua tới INSERT ... ON CONFLICT DO NOTHING
        if (norm.includes('quantity_after')) return { rows: [] };
        const existing = simState.movements.get(params[0]);
        return { rows: existing ? [existing] : [] };
      }
      if (norm.startsWith('SELECT s.warehouse_id AS "warehouseId", s.quantity')) {
        return { rows: [{ warehouseId: mainWh.id, quantity: simState.warehouseStock, code: 'MAIN', active: true }] };
      }
      if (norm.startsWith('INSERT INTO warehouse_stock')) return { rows: [], rowCount: 0 };
      if (norm.startsWith('SELECT quantity FROM warehouse_stock')) {
        return { rows: [{ quantity: simState.warehouseStock }] };
      }
      if (norm.startsWith('INSERT INTO inventory_movements')) {
        const key = params[0];
        if (simState.movements.has(key)) {
          return { rows: [], rowCount: 0 };
        }
        const created = {
          id: `mov-${simState.movements.size + 1}`,
          warehouseId: params[1],
          variantId: params[2],
          movementType: params[6],
          delta: params[7],
          referenceType: params[10],
          referenceId: params[11],
          payloadHash: params[15]
        };
        simState.movements.set(key, created);
        return { rows: [{ id: created.id }], rowCount: 1 };
      }
      if (norm.startsWith('UPDATE warehouse_stock SET quantity')) {
        simState.warehouseStock = params[2];
        return { rows: [], rowCount: 1 };
      }
      if (norm.startsWith('SELECT COALESCE(SUM(quantity), 0)::int AS total FROM warehouse_stock')) {
        return { rows: [{ total: simState.warehouseStock }] };
      }
      if (norm.startsWith('UPDATE product_variants SET stock_quantity')) {
        simState.variantStock = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (norm.startsWith('INSERT INTO audit_events')) {
        return { rows: [{ id: 'aud-1' }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in race simulator: ${norm}`);
    }
  };

  const [sim1, sim2] = await Promise.all([
    InventoryService.applyMovement(raceClient, { source: 'inventory', eventId: 'RACE-EVT-9', variantId: variant.id, delta: 2 }),
    InventoryService.applyMovement(raceClient, { source: 'inventory', eventId: 'RACE-EVT-9', variantId: variant.id, delta: 2 })
  ]);
  assert.equal(simState.warehouseStock, 7, 'Race trực tiếp tại ON CONFLICT chỉ được cập nhật kho đúng 1 lần (5 -> 7)');
  assert.equal(simState.variantStock, 7);
  assert.equal(simState.movements.size, 1);
  assert.equal([sim1.duplicate, sim2.duplicate].filter(Boolean).length, 1);

  // 1d. Production Fail-Closed khi lược đồ kho bị lỗi / chưa migration (không được nuốt lỗi và không tự sửa riêng product_variants)
  let variantUpdatedWithoutLedger = false;
  const brokenSchemaClient = {
    async query(sql) {
      const norm = sql.replace(/\s+/g, ' ').trim();
      if (norm.startsWith('SELECT v.id, v.sku')) {
        return { rows: [{ id: variant.id, sku: 'SKU-P1-CONC', variantName: 'Standard', productName: 'GAERU P1 Mic', stockQuantity: 5 }] };
      }
      if (norm.startsWith('UPDATE product_variants')) {
        variantUpdatedWithoutLedger = true;
        return { rows: [], rowCount: 1 };
      }
      throw Object.assign(new Error('relation "inventory_movements" does not exist'), { code: '42P01' });
    }
  };

  await assert.rejects(
    async () => {
      await InventoryService.applyMovement(brokenSchemaClient, {
        source: 'inventory',
        eventId: 'BROKEN-SCHEMA-1',
        variantId: variant.id,
        delta: 2
      });
    },
    (err) => err.code === '42P01'
  );
  assert.equal(variantUpdatedWithoutLedger, false, 'Production fail-closed tuyệt đối không sửa product_variants khi bảng kho lỗi');
});

// ============================================================================
// P1-2: PostgreSQL-Level Job Queue Idempotency under Concurrency
// ============================================================================

test('P1-2: enqueueJob đồng thời chống trùng ở cấp PostgreSQL (partial unique index), từ chối 409 khi lệch payload và cho phép phục hồi sau failed', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  // 1. Hai lời gọi đồng thời enqueueJob cùng (name, idempotencyKey)
  const [j1, j2] = await Promise.all([
    enqueueJob(pool, {
      name: 'email.order',
      idempotencyKey: 'same-event',
      payload: { orderId: 'ord-conc-001', recipient: 'buyer@example.com' }
    }),
    enqueueJob(pool, {
      name: 'email.order',
      idempotencyKey: 'same-event',
      payload: { orderId: 'ord-conc-001', recipient: 'buyer@example.com' }
    })
  ]);

  assert.equal(j1.id, j2.id, 'Hai lời gọi đồng thời phải trả về cùng một job id duy nhất');
  assert.equal([j1.duplicate, j2.duplicate].filter(Boolean).length, 1, 'Một lời gọi tạo mới và một lời gọi nhận duplicate');

  const countInDb = (await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM system_jobs WHERE name = 'email.order' AND idempotency_key = 'same-event'`
  )).rows[0].cnt;
  assert.equal(countInDb, 1, 'PostgreSQL unique index đảm bảo chỉ tồn tại đúng 1 job');

  // 2. Mô phỏng mock lập lịch đan xen: xác minh enqueueJob dùng INSERT ... ON CONFLICT nguyên tử thay vì SELECT-then-INSERT
  const mockJobs = new Map();
  let selectBeforeInsertCount = 0;
  const mockPool = {
    async query(sql, params = []) {
      const norm = sql.replace(/\s+/g, ' ').trim();
      await Promise.resolve();
      if (norm.startsWith('INSERT INTO system_jobs')) {
        const [, name, payloadJson, idemKey, payloadHash] = params;
        const composite = `${name}::${idemKey}`;
        if (idemKey && mockJobs.has(composite)) {
          return { rows: [], rowCount: 0 };
        }
        const row = {
          id: randomUUID(),
          queue: params[0],
          name,
          payload: JSON.parse(payloadJson),
          idempotency_key: idemKey,
          payload_hash: payloadHash,
          status: 'pending',
          run_at: new Date().toISOString(),
          created_at: new Date().toISOString()
        };
        if (idemKey) mockJobs.set(composite, row);
        return { rows: [row], rowCount: 1 };
      }
      if (norm.startsWith('SELECT id, queue, name, status')) {
        const [name, idemKey] = params;
        const existing = mockJobs.get(`${name}::${idemKey}`);
        return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
      }
      selectBeforeInsertCount++;
      return { rows: [] };
    }
  };

  const [m1, m2] = await Promise.all([
    enqueueJob(mockPool, { name: 'email.order', idempotencyKey: 'same-event-mock', payload: { orderNumber: 'GR-1' } }),
    enqueueJob(mockPool, { name: 'email.order', idempotencyKey: 'same-event-mock', payload: { orderNumber: 'GR-1' } })
  ]);
  assert.equal(mockJobs.size, 1, 'Mock scheduler đồng thời chỉ tạo đúng 1 job');
  assert.equal(m1.id, m2.id);
  assert.equal(selectBeforeInsertCount, 0);

  // 3. Cùng (name, idempotencyKey) nhưng payload khác -> Phải từ chối 409 Conflict!
  await assert.rejects(
    async () => {
      await enqueueJob(pool, {
        name: 'email.order',
        idempotencyKey: 'same-event',
        payload: { orderId: 'ord-DIFFERENT-999', recipient: 'other@example.com' }
      });
    },
    (err) => err.status === 409 && err.code === 'JOB_IDEMPOTENCY_CONFLICT'
  );

  // 4. Vòng đời khóa: khi job chuyển sang failed vĩnh viễn, cho phép re-enqueue lại khóa đó để phục hồi vận hành
  await pool.query(`UPDATE system_jobs SET status = 'failed' WHERE id = $1`, [j1.id]);
  const recovered = await enqueueJob(pool, {
    name: 'email.order',
    idempotencyKey: 'same-event',
    payload: { orderId: 'ord-conc-001', recipient: 'buyer@example.com' }
  });
  assert.equal(recovered.duplicate, false);
  assert.notEqual(recovered.id, j1.id);
});

// ============================================================================
// P2-6a: Long-Running Job Lease Heartbeat & Zombie Worker Token Fencing
// ============================================================================

test('P2-6a: Job chạy dài hơn leaseDurationMs được gia hạn lease tự động (không bị cướp) và worker chết giữa chừng bị chặn ghi đè bởi lease_token', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  // Kịch bản A: Job chạy 260ms (> 2 lần leaseDurationMs = 100ms), Worker 1 còn sống -> heartbeat gia hạn lease -> Worker 2 KHÔNG thể nhận trộm!
  let longJobExecutions = 0;
  let stolenByWorker2 = false;

  const controlledWorker1 = createJobQueue({ pool, intervalMs: 60000, leaseDurationMs: 100, heartbeatIntervalMs: 30 });
  const controlledWorker2 = createJobQueue({ pool, intervalMs: 60000, leaseDurationMs: 100, heartbeatIntervalMs: 30 });
  t.after(() => {
    controlledWorker1.stop();
    controlledWorker2.stop();
  });

  controlledWorker1.registerWorker('media.long_transcode', async (_payload, _job, leaseCtx) => {
    longJobExecutions++;
    await sleep(150);
    leaseCtx.assertLeaseActive();
    await sleep(110);
    leaseCtx.assertLeaseActive();
  });
  controlledWorker2.registerWorker('media.long_transcode', async () => {
    stolenByWorker2 = true;
    longJobExecutions++;
  });

  const longJob = await enqueueJob(pool, {
    name: 'media.long_transcode',
    idempotencyKey: 'long-job-1',
    payload: { videoId: 'vid-1' }
  });

  controlledWorker1.start();
  controlledWorker2.start();
  const w1Promise = controlledWorker1.processOne();

  // Chờ 160ms (> 100ms lease gốc) rồi cho Worker 2 thử claim
  await sleep(160);
  const w2Attempt = await controlledWorker2.processOne();
  assert.equal(w2Attempt, null, 'Worker 2 không được phép nhận lại job khi Worker 1 vẫn đang gia hạn lease');

  const w1Outcome = await w1Promise;
  assert.equal(w1Outcome.status, 'completed');
  assert.equal(w1Outcome.fenced, false);
  assert.equal(stolenByWorker2, false);
  assert.equal(longJobExecutions, 1, 'Job chạy dài chỉ thực thi đúng 1 lần duy nhất');

  const completedRow = (await pool.query(`SELECT status, lease_token FROM system_jobs WHERE id = $1`, [longJob.id])).rows[0];
  assert.equal(completedRow.status, 'completed');
  assert.equal(completedRow.lease_token, null);

  // Kịch bản B: Worker 1 bị treo / chết giữa chừng (heartbeat dừng) -> Sau khi hết lease, Worker 2 nhận lại bằng lease_token mới và hoàn tất -> Zombie Worker 1 tỉnh dậy bị chặn bởi WHERE lease_token!
  let releaseZombieWorker1;
  const zombieGate = new Promise((resolve) => { releaseZombieWorker1 = resolve; });
  let worker1Entered = null;
  const worker1EnteredPromise = new Promise((resolve) => { worker1Entered = resolve; });
  let sideEffectLog = [];

  controlledWorker1.registerWorker('order.side_effect_task', async (payload, _job, leaseCtx) => {
    // Mô phỏng tiến trình bị treo cứng / mất kết nối làm ngưng heartbeat
    leaseCtx.stopHeartbeat();
    worker1Entered(leaseCtx.leaseToken);
    await zombieGate;
    // Khi tỉnh dậy muộn, kiểm tra outbox / lease hoặc cố tình ném lỗi để xem DB có bị ghi đè không
    throw new Error('Zombie worker 1 late failure must NOT overwrite completed job!');
  });

  controlledWorker2.registerWorker('order.side_effect_task', async (payload, _job, leaseCtx) => {
    leaseCtx.assertLeaseActive();
    sideEffectLog.push({ worker: 2, orderId: payload.orderId, token: leaseCtx.leaseToken });
  });

  const crashJob = await enqueueJob(pool, {
    name: 'order.side_effect_task',
    idempotencyKey: 'crash-job-1',
    payload: { orderId: 'ord-zombie-test' },
    maxAttempts: 3
  });

  const zombieRunPromise = controlledWorker1.processOne();
  const token1 = await worker1EnteredPromise;
  assert.ok(token1, 'Worker 1 đã nhận lease_token đầu tiên');

  // Chờ quá hạn lease 100ms (vì heartbeat của Worker 1 đã dừng)
  await sleep(150);

  // Worker 2 nhảy vào thu hồi job bị bỏ rơi và hoàn thành
  const w2Recovery = await controlledWorker2.processOne();
  assert.ok(w2Recovery, 'Worker 2 phải nhận lại được job sau khi lease của Worker 1 hết hạn');
  assert.equal(w2Recovery.status, 'completed');
  assert.equal(w2Recovery.fenced, false);
  assert.notEqual(w2Recovery.leaseToken, token1, 'Worker 2 phải được cấp lease_token mới');
  assert.equal(sideEffectLog.length, 1);

  // Cho Zombie Worker 1 tỉnh dậy và cố ghi trạng thái lỗi/retry vào DB bằng token cũ
  releaseZombieWorker1();
  const zombieResult = await zombieRunPromise;
  assert.equal(zombieResult.fenced, true, 'Cập nhật trạng thái của Zombie Worker 1 phải bị chặn (fenced = true)');
  assert.equal(zombieResult.status, 'fenced');

  const finalCrashRow = (await pool.query(`SELECT status, attempts, last_error FROM system_jobs WHERE id = $1`, [crashJob.id])).rows[0];
  assert.equal(finalCrashRow.status, 'completed', 'Trạng thái completed của Worker 2 phải được bảo toàn tuyệt đối');
  assert.equal(finalCrashRow.attempts, 2);
});

// ============================================================================
// P2-6b: WorkerManager Fail-Closed Leader Election, Demotion & Retry
// ============================================================================

test('P2-6b: WorkerManager fail-closed khi lỗi kết nối advisory lock, tự hạ quyền khi đứt heartbeat và tự bầu chọn lại khi DB phục hồi', async (t) => {
  let connectAttempts = 0;
  let dbHealthy = false;
  let lockAvailable = true;
  let startedWorkersCount = 0;
  let stoppedWorkersCount = 0;

  const mockMultiInstancePool = {
    options: { max: 10 },
    totalCount: 1,
    async query() {
      return { rows: [] };
    },
    async connect() {
      connectAttempts++;
      if (!dbHealthy) {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      }
      return {
        async query(sql) {
          if (!dbHealthy) {
            throw Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' });
          }
          if (sql.includes('pg_try_advisory_lock')) {
            return { rows: [{ acquired: lockAvailable }] };
          }
          return { rows: [{ '?column?': 1 }] };
        },
        release() {}
      };
    }
  };

  const manager = new WorkerManager({
    leaseHeartbeatMs: 40,
    leaderRetryMs: 40
  });
  t.after(() => manager.stopAll());

  const makeTrackedStarter = () => () => {
    startedWorkersCount++;
    return () => {
      stoppedWorkersCount++;
    };
  };

  const mockRequire = () => ({
    startChatFileRetentionWorker: makeTrackedStarter(),
    startTikTokAdsWorker: makeTrackedStarter(),
    startAIChatWorker: makeTrackedStarter(),
    startChatCompressionWorker: makeTrackedStarter(),
    startChatEmailWorker: makeTrackedStarter(),
    startOrderEmailWorker: makeTrackedStarter(),
    startWarrantyEmailWorker: makeTrackedStarter(),
    startEmailWorker: makeTrackedStarter(),
    startRetentionWorker: makeTrackedStarter(),
    startPaymentReconciliationWorker: makeTrackedStarter()
  });

  // 1. Khi khởi động mà kết nối DB lỗi -> BẮT BUỘC Fail-Closed (isLeader = false, 0 worker chạy!)
  const initialStart = await manager.startAll(mockMultiInstancePool, {}, {
    requireFn: mockRequire,
    startJobQueue: false
  });
  assert.equal(initialStart, false);
  assert.equal(manager.isLeader, false, 'Lỗi kết nối advisory lock phải fail-closed (isLeader = false)');
  assert.equal(startedWorkersCount, 0, 'Không được khởi chạy worker nền khi chưa có leader lock');

  // 2. DB phục hồi kết nối -> Vòng lặp retry tự động bầu chọn thành Leader và khởi chạy 10 worker!
  dbHealthy = true;
  await sleep(110);
  assert.equal(manager.isLeader, true, 'WorkerManager phải tự động giành quyền Leader khi DB phục hồi');
  assert.equal(startedWorkersCount, 10, 'Đủ 10 worker định kỳ được bật sau khi trở thành Leader');

  // 3. Mất kết nối DB giữa chừng và một instance khác giành mất khóa (lockAvailable = false) -> Phải tự hạ quyền (demote) và dừng các worker!
  dbHealthy = false;
  lockAvailable = false;
  await sleep(100);
  assert.equal(manager.isLeader, false, 'Đứt heartbeat phải hạ quyền Leader ngay lập tức');
  assert.equal(stoppedWorkersCount, 10, 'Toàn bộ worker đang chạy phải được dừng khi mất quyền Leader');

  // 4. DB sống lại nhưng instance khác đang giữ khóa (lockAvailable = false) -> Tiếp tục đứng ở chế độ Follower
  dbHealthy = true;
  await sleep(90);
  assert.equal(manager.isLeader, false);
  assert.equal(startedWorkersCount, 10);

  // 5. Instance kia nhả khóa (lockAvailable = true) -> Tự động lên làm Leader lần nữa!
  lockAvailable = true;
  await sleep(100);
  assert.equal(manager.isLeader, true);
  assert.equal(startedWorkersCount, 20);

  await manager.stopAll();
});

// ============================================================================
// P2-3 & P2-4: Combo 1:3 Exact Price Allocations, MISA Invoice Math &
// Unified PricingEngine.quoteOrder (Quote vs Commit Parity)
// ============================================================================

test('P2-3 & P2-4: Combo 1 chính + 3 phụ kiện lưu phân bổ bậc giá nguyên chính xác (order_item_allocations), khớp hóa đơn MISA và đồng nhất tuyệt đối giữa Quote & Commit', async (t) => {
  const { pool, close } = await createTestDb();
  const config = {
    NODE_ENV: 'test',
    SESSION_SECRET: randomBytes(48).toString('hex'),
    ADMIN_USERNAME: 'ceo_p2',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync('Password-P2-2026!', 4),
    STORE_ORDERS_ENABLED: true
  };
  const app = createApp({ config, pool, sessionStore: new session.MemoryStore() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 1. Tạo dữ liệu chính xác như ví dụ kiểm toán P2:
  //    1 sản phẩm chính (500đ) + 3 phụ kiện giá 100đ, giảm 50% cho 1 phụ kiện -> Dòng phụ kiện đúng = 250đ (50đ + 2×100đ)
  //    Đơn giá bình quân hiển thị = Math.round(250/3) = 83đ (83 * 3 = 249đ !== 250đ)
  const mainProd = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('combo-main-p2', 'GAERU Main Mic', 'audio', true) RETURNING id`
  )).rows[0];
  const accProd = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('combo-acc-p2', 'GAERU Windscreen', 'accessory', true) RETURNING id`
  )).rows[0];

  const mainVar = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-MAIN-500', 'Bản Tiêu Chuẩn', 500, 20, true) RETURNING id`,
    [mainProd.id]
  )).rows[0];
  const accVar = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-ACC-100', 'Bông Lọc', 100, 20, true) RETURNING id`,
    [accProd.id]
  )).rows[0];

  const mainWh = (await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN'`)).rows[0];
  await pool.query(
    `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 20), ($1, $3, 20)`,
    [mainWh.id, mainVar.id, accVar.id]
  );

  await pool.query(
    `INSERT INTO product_bundles (main_product_slug, bundle_product_slug, bundle_title, discount_percent, active)
     VALUES ('combo-main-p2', 'combo-acc-p2', 'Combo Phụ Kiện Giảm 50%', 50, true)`
  );

  await pool.query(
    `INSERT INTO store_settings (setting_key, setting_value)
     VALUES ('shipping_rates', $1::jsonb)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
    [JSON.stringify({ 'Hà Nội': 100 })]
  );

  // Tạo tài khoản khách hàng + voucher giảm 10% (750đ * 10% = 75đ)
  const password = 'Buyer-Password-2026!';
  const customerRow = (await pool.query(
    `INSERT INTO customers (full_name, email, phone, password_hash, active, email_verified_at)
     VALUES ('Nguyễn Kiểm Toán', 'audit-p2@example.com', '0912345678', $1, true, now())
     RETURNING id`,
    [bcrypt.hashSync(password, 4)]
  )).rows[0];

  const voucherRow = (await pool.query(
    `INSERT INTO marketing_vouchers (code, title, kind, amount, max_discount_vnd, min_spend_vnd, starts_at, ends_at, total_limit, per_customer_limit, public_claim, active)
     VALUES ('P2SYNC10', 'Giảm 10%', 'percent', 10, 50000, 100, now() - interval '1 hour', now() + interval '1 day', 50, 5, true, true)
     RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO customer_vouchers (customer_id, voucher_id, source) VALUES ($1, $2, 'saved')`,
    [customerRow.id, voucherRow.id]
  );

  const buyer = createHttpSessionClient(baseUrl);
  await buyer.ensureCsrf();
  const loginRes = await buyer.request('/api/customer-auth/login', 'POST', {
    identifier: 'audit-p2@example.com',
    password
  });
  assert.equal(loginRes.status, 200);
  await buyer.ensureCsrf();

  const cartPayload = [
    { variantId: mainVar.id, quantity: 1 },
    { variantId: accVar.id, quantity: 3 }
  ];

  // 2. Gọi API Báo giá Voucher (mode: 'quote') kèm tỉnh/thành 'Hà Nội'
  const quoteApiRes = await buyer.request('/api/customer/marketing/quote', 'POST', {
    code: 'P2SYNC10',
    city: 'Hà Nội',
    items: cartPayload
  });
  assert.equal(quoteApiRes.status, 200, JSON.stringify(quoteApiRes.data));
  // Tạm tính: 500 + 250 = 750đ | Voucher 10%: 75đ | Ship Hà Nội: 100đ | Tổng = 775đ
  assert.equal(quoteApiRes.data.code, 'P2SYNC10');
  assert.equal(quoteApiRes.data.subtotalVnd, 750);
  assert.equal(quoteApiRes.data.discountVnd, 75);
  assert.equal(quoteApiRes.data.shippingFeeVnd, 100);
  assert.equal(quoteApiRes.data.totalVnd, 775);
  assert.ok(quoteApiRes.data.quoteHash && quoteApiRes.data.quoteHash.length === 64);

  // 3. Nếu gửi expectedQuoteHash cũ/sai lên Checkout -> BẮT BUỘC từ chối 409!
  const staleCheckout = await buyer.request('/api/orders', 'POST', {
    customer: {
      name: 'Nguyễn Kiểm Toán',
      email: 'audit-p2@example.com',
      phone: '0912345678',
      address: 'Số 10 Hoàn Kiếm',
      city: 'Hà Nội'
    },
    paymentMethod: 'cod',
    voucherCode: 'P2SYNC10',
    expectedQuoteHash: '0'.repeat(64),
    items: cartPayload
  });
  assert.equal(staleCheckout.status, 409);

  // 4. Đặt hàng Checkout (mode: 'commit') với đúng expectedQuoteHash từ bước Quote
  const checkoutRes = await buyer.request('/api/orders', 'POST', {
    customer: {
      name: 'Nguyễn Kiểm Toán',
      email: 'audit-p2@example.com',
      phone: '0912345678',
      address: 'Số 10 Hoàn Kiếm',
      city: 'Hà Nội'
    },
    paymentMethod: 'cod',
    voucherCode: 'P2SYNC10',
    expectedQuoteHash: quoteApiRes.data.quoteHash,
    items: cartPayload
  });
  assert.equal(checkoutRes.status, 201, JSON.stringify(checkoutRes.data));

  const createdOrder = checkoutRes.data.order;
  assert.equal(createdOrder.quoteHash, quoteApiRes.data.quoteHash, 'QuoteHash giữa mode quote và commit phải khớp tuyệt đối 100%');
  assert.equal(createdOrder.subtotalVnd, quoteApiRes.data.subtotalVnd);
  assert.equal(createdOrder.shippingFeeVnd, quoteApiRes.data.shippingFeeVnd);
  assert.equal(createdOrder.discountVnd, quoteApiRes.data.discountVnd);
  assert.equal(createdOrder.totalVnd, quoteApiRes.data.totalVnd);

  // 5. Kiểm tra dữ liệu lưu trong PostgreSQL: orders.pricing_snapshot, order_items và bảng con order_item_allocations
  const dbOrder = (await pool.query(
    `SELECT subtotal_vnd, shipping_fee_vnd, discount_vnd, total_vnd, quote_hash, pricing_snapshot
     FROM orders WHERE id = $1`,
    [createdOrder.id]
  )).rows[0];
  assert.equal(dbOrder.quote_hash, quoteApiRes.data.quoteHash);
  assert.equal(dbOrder.pricing_snapshot.mode, 'commit');
  assert.equal(dbOrder.pricing_snapshot.subtotalVnd, 750);

  const dbItems = (await pool.query(
    `SELECT id, sku, quantity, unit_price_vnd, effective_unit_price_vnd, line_total_vnd, promotion_snapshot
     FROM order_items WHERE order_id = $1 ORDER BY sku`,
    [createdOrder.id]
  )).rows;
  assert.equal(dbItems.length, 2);

  const accLine = dbItems.find((r) => r.sku === 'SKU-ACC-100');
  assert.equal(accLine.quantity, 3);
  assert.equal(accLine.effective_unit_price_vnd, 83, 'Đơn giá hiển thị bình quân là 83đ');
  assert.equal(accLine.line_total_vnd, 250, 'Tổng tiền dòng hàng chính xác là 250đ');
  assert.deepEqual(accLine.promotion_snapshot.remainderBreakdown, {
    quotientUnitPriceVnd: 83,
    remainderVnd: 1,
    effectiveDisplayUnitPriceVnd: 83,
    exactUnitPrice: false
  });

  const accAllocations = (await pool.query(
    `SELECT tier_kind, quantity, unit_price_vnd, line_total_vnd, discount_percent
     FROM order_item_allocations WHERE order_item_id = $1 ORDER BY unit_price_vnd ASC`,
    [accLine.id]
  )).rows;
  assert.deepEqual(accAllocations, [
    { tier_kind: 'bundle_discounted', quantity: 1, unit_price_vnd: 50, line_total_vnd: 50, discount_percent: 50 },
    { tier_kind: 'regular', quantity: 2, unit_price_vnd: 100, line_total_vnd: 200, discount_percent: 0 }
  ]);
  assert.equal(
    accAllocations.reduce((sum, a) => sum + a.line_total_vnd, 0),
    accLine.line_total_vnd,
    'Tổng các bậc giá con phải khớp tuyệt đối 250đ không lệch 1đ'
  );

  // 6. Kiểm tra đối soát hóa đơn thuế MISA eShop: mọi dòng trên hóa đơn đều phải thỏa Quantity * UnitPrice === Amount!
  const allItemsWithAllocs = await Promise.all(
    dbItems.map(async (item) => {
      const allocs = (await pool.query(
        `SELECT tier_kind, quantity, unit_price_vnd, line_total_vnd, discount_percent
         FROM order_item_allocations WHERE order_item_id = $1 ORDER BY id`,
        [item.id]
      )).rows;
      return {
        ...item,
        product_name: item.sku === 'SKU-ACC-100' ? 'GAERU Windscreen' : 'GAERU Main Mic',
        variant_name: 'Standard',
        allocations: allocs
      };
    })
  );

  const misaPayload = buildInvoicePayload(
    { ...dbOrder, id: createdOrder.id, order_number: createdOrder.orderNumber, payment_method: 'cod' },
    allItemsWithAllocs,
    { taxCode: '0109998888' }
  );

  for (const invLine of misaPayload.Items) {
    assert.equal(
      invLine.Quantity * invLine.UnitPrice,
      invLine.Amount,
      `Dòng hóa đơn "${invLine.ItemName}" phải thỏa mãn tuyệt đối Quantity (${invLine.Quantity}) * UnitPrice (${invLine.UnitPrice}) === Amount (${invLine.Amount})`
    );
  }
  const productLinesSum = misaPayload.Items
    .filter((i) => i.ItemCode !== 'SHIPPING')
    .reduce((s, i) => s + i.Amount, 0);
  assert.equal(productLinesSum, 750, 'Tổng tiền hàng trên hóa đơn MISA khớp tuyệt đối 750đ');
});

// ============================================================================
// P2-5: Single Inventory Mutation Path in CatalogService + RBAC & Concurrency
// ============================================================================

test('P2-5: CatalogService.updateVariant ủy quyền sửa tồn duy nhất qua InventoryService, bảo toàn phân quyền catalog.write/inventory.approve và optimistic concurrency', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const ownerActor = {
    id: null,
    username: 'ceo_owner',
    role: 'owner',
    permissions: ['catalog.read', 'catalog.write', 'inventory.read', 'inventory.write', 'inventory.approve']
  };
  const catalogOnlyActor = {
    id: randomUUID(),
    username: 'catalog_staff',
    role: 'custom',
    permissions: ['catalog.read', 'catalog.write'] // KHÔNG có inventory.approve!
  };
  const viewerActor = {
    id: randomUUID(),
    username: 'viewer_staff',
    role: 'viewer',
    permissions: ['catalog.read'] // KHÔNG có catalog.write!
  };

  // 1. Tạo sản phẩm + biến thể qua CatalogService
  const product = await withTransaction(pool, (client) =>
    CatalogService.createProduct(client, {
      data: {
        slug: 'p2-5-studio-mic',
        name: 'GAERU P2-5 Mic',
        category: 'audio',
        descriptor: 'Mic chuyên nghiệp',
        description: 'Mô tả',
        imageUrl: '/assets/products/k9.webp',
        imageAlt: 'GAERU P2-5',
        sortOrder: 0
      },
      actor: ownerActor
    })
  );

  const variant = await withTransaction(pool, (client) =>
    CatalogService.createVariant(client, {
      productId: product.id,
      data: {
        sku: 'SKU-P25-01',
        name: 'Type-C',
        options: {},
        priceVnd: 450000,
        stockQuantity: 10,
        active: true
      },
      actor: ownerActor
    })
  );

  // Kiểm tra tồn đầu kỳ đã mở sổ kho chuẩn
  const initMovements = (await pool.query(`SELECT movement_type, delta FROM inventory_movements WHERE variant_id = $1`, [variant.id])).rows;
  assert.equal(initMovements.length, 1);
  assert.equal(initMovements[0].movement_type, 'opening');
  assert.equal(initMovements[0].delta, 10);

  // 2. Gọi trực tiếp CatalogService.updateVariant để đổi stockQuantity (10 -> 16) -> BẮT BUỘC đi qua InventoryService.setVariantStock và ghi sổ kho!
  const updatedVar = await withTransaction(pool, (client) =>
    CatalogService.updateVariant(client, {
      variantId: variant.id,
      sku: 'SKU-P25-01',
      name: 'Type-C Pro',
      priceVnd: 480000,
      stockQuantity: 16,
      active: true,
      actor: ownerActor
    })
  );
  assert.equal(updatedVar.stockQuantity, 16);
  assert.equal(updatedVar.priceVnd, 480000);

  const whSum = (await pool.query(`SELECT SUM(quantity)::int AS total FROM warehouse_stock WHERE variant_id = $1`, [variant.id])).rows[0].total;
  const varStock = (await pool.query(`SELECT stock_quantity, edit_version FROM product_variants WHERE id = $1`, [variant.id])).rows[0];
  const allMovements = (await pool.query(`SELECT movement_type, delta FROM inventory_movements WHERE variant_id = $1 ORDER BY created_at ASC`, [variant.id])).rows;
  assert.equal(whSum, 16, 'warehouse_stock phải khớp tuyệt đối 16');
  assert.equal(varStock.stock_quantity, 16, 'product_variants.stock_quantity phải khớp tuyệt đối 16');
  assert.equal(allMovements.length, 2, 'Phải sinh thêm dòng biến động adjustment +6 trong inventory_movements');
  assert.equal(allMovements[1].movement_type, 'adjustment');
  assert.equal(allMovements[1].delta, 6);

  // 3. Nhân viên chỉ có catalog.write (không có inventory.approve):
  //    - Đổi giá (giữ nguyên stockQuantity = 16) -> Thành công!
  const priceOnlyUpdate = await withTransaction(pool, (client) =>
    CatalogService.updateVariant(client, {
      variantId: variant.id,
      priceVnd: 499000,
      stockQuantity: 16,
      actor: catalogOnlyActor
    })
  );
  assert.equal(priceOnlyUpdate.priceVnd, 499000);

  //    - Cố tình đổi stockQuantity (16 -> 20) -> Bị chặn 403 Forbidden!
  await assert.rejects(
    async () => {
      await withTransaction(pool, (client) =>
        CatalogService.updateVariant(client, {
          variantId: variant.id,
          priceVnd: 499000,
          stockQuantity: 20,
          actor: catalogOnlyActor
        })
      );
    },
    (err) => err.status === 403
  );

  // 4. Nhân viên chỉ có catalog.read (viewer) -> Bị chặn 403 ngay cả khi chỉ sửa giá!
  await assert.rejects(
    async () => {
      await withTransaction(pool, (client) =>
        CatalogService.updateVariant(client, {
          variantId: variant.id,
          priceVnd: 400000,
          actor: viewerActor
        })
      );
    },
    (err) => err.status === 403
  );

  // 5. Kiểm tra Optimistic Concurrency (expectedVersion sai -> 409 Conflict)
  await assert.rejects(
    async () => {
      await withTransaction(pool, (client) =>
        CatalogService.updateVariant(client, {
          variantId: variant.id,
          priceVnd: 470000,
          expectedVersion: 999,
          actor: ownerActor
        })
      );
    },
    (err) => err.status === 409
  );
});
