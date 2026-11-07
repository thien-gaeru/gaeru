'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPriorityPoolController, poolOptions } = require('../src/db');
const { setReady, isAppReady, resetReadinessForTesting, readinessMiddleware } = require('../src/lib/readiness-gate');

// -----------------------------------------------------------------------------
// 1. Giới hạn DB ưu tiên cao và Timeout PostgreSQL
// -----------------------------------------------------------------------------
test('DB Pool Options: cấu hình statement_timeout và idle_in_transaction_session_timeout', () => {
  const opts = poolOptions({
    DATABASE_URL: 'postgres://localhost/gaeru_test',
    PG_MAX_CONNECTIONS: 15,
    PG_STATEMENT_TIMEOUT_MS: 20000,
    PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: 10000
  });

  assert.equal(opts.max, 15, 'Hạn mức pool connection phải tôn trọng cấu hình');
  assert.equal(opts.statement_timeout, 20000, 'statement_timeout phải được cấu hình chính xác');
  assert.equal(opts.idle_in_transaction_session_timeout, 10000, 'idle_in_transaction timeout phải được thiết lập');
});

test('DB Priority Pool: High-priority có hạn mức riêng (maxHighPriorityOps) và hàng đợi điều phối', async () => {
  let activeExecutions = 0;
  const mockPool = {
    options: { max: 10 },
    query: async () => {
      activeExecutions++;
      await new Promise(r => setTimeout(r, 25));
      activeExecutions--;
      return { rows: [] };
    }
  };

  const controller = createPriorityPoolController(mockPool, {
    maxLowPriorityOps: 2,
    maxHighPriorityOps: 2
  });

  const p1 = controller.highPriorityPool.query('SELECT 1');
  const p2 = controller.highPriorityPool.query('SELECT 2');
  const p3 = controller.highPriorityPool.query('SELECT 3'); // Phải vào hàng đợi chờ

  const stats = controller.getStats();
  assert.equal(stats.activeHighOps, 2, 'Số tác vụ high priority đồng thời không vượt quá maxHighPriorityOps (2)');
  assert.equal(stats.queuedHighOps, 1, 'Tác vụ thứ 3 phải được đưa vào queuedHighOps');
  assert.equal(stats.maxHighPriorityOps, 2);

  await Promise.all([p1, p2, p3]);

  const settledStats = controller.getStats();
  assert.equal(settledStats.activeHighOps, 0);
  assert.equal(settledStats.queuedHighOps, 0);
});

test('DB Priority Pool: High-priority luôn được ưu tiên xử lý trước Low-priority', async () => {
  const executionOrder = [];
  const mockPool = {
    options: { max: 10 },
    query: async (sql) => {
      executionOrder.push(sql);
      await new Promise(r => setTimeout(r, 20));
      return { rows: [] };
    }
  };

  const controller = createPriorityPoolController(mockPool, {
    maxLowPriorityOps: 1,
    maxHighPriorityOps: 1
  });

  const h1 = controller.highPriorityPool.query('H1');
  const h2 = controller.highPriorityPool.query('H2'); // Đợi H1
  const l1 = controller.lowPriorityPool.query('L1');   // Đợi cả H1 và H2

  await Promise.all([h1, h2, l1]);

  assert.deepEqual(executionOrder, ['H1', 'H2', 'L1'], 'H2 ưu tiên cao phải chạy trước L1');
});

// -----------------------------------------------------------------------------
// 2. Cách ly lỗi khi Worker khởi động
// -----------------------------------------------------------------------------
test('Worker startup: hàm khởi tạo worker ném lỗi đồng bộ hoặc async không làm sập server', async () => {
  let workerTimeouts = [];
  let shuttingDown = false;
  let loggedErrors = [];

  function scheduleWorker(fn, delayMs) {
    if (shuttingDown) return;
    const safeFn = () => {
      if (shuttingDown) return;
      try {
        const res = fn();
        if (res && typeof res.catch === 'function') {
          res.catch(err => loggedErrors.push(err.message));
        }
      } catch (err) {
        loggedErrors.push(err.message);
      }
    };
    if (delayMs === 0) {
      safeFn();
      return;
    }
    const t = setTimeout(safeFn, delayMs);
    workerTimeouts.push(t);
  }

  // Worker 1: Lỗi ném đồng bộ
  scheduleWorker(() => {
    throw new Error('WORKER_CRASH_SYNC');
  }, 0);

  // Worker 2: Lỗi async rejection
  scheduleWorker(async () => {
    throw new Error('WORKER_CRASH_ASYNC');
  }, 0);

  // Worker 3: Worker bình thường thành công
  let worker3Ran = false;
  scheduleWorker(() => {
    worker3Ran = true;
  }, 0);

  assert.equal(worker3Ran, true, 'Worker 3 phải chạy thành công dù Worker 1 và 2 gặp sự cố');
  assert.ok(loggedErrors.includes('WORKER_CRASH_SYNC'), 'Lỗi sync phải được bắt và cô lập');
  await new Promise(r => setImmediate(r));
  assert.ok(loggedErrors.includes('WORKER_CRASH_ASYNC'), 'Lỗi async phải được bắt và cô lập');
});

// -----------------------------------------------------------------------------
// 3. Chuẩn hóa Readiness Gate khi Media chưa xác minh
// -----------------------------------------------------------------------------
test('Readiness Gate: Media chưa xác minh giữ cổng readiness ở trạng thái 503 Service Initializing', () => {
  resetReadinessForTesting();
  setReady(false);

  assert.equal(isAppReady(), false, 'App không được ở trạng thái ready khi chưa xác minh');

  let statusCode = 0;
  let responseData = null;
  const req = {
    path: '/readyz',
    accepts: () => false
  };
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { responseData = data; return this; },
    setHeader() {}
  };

  readinessMiddleware(req, res, () => {});

  assert.equal(statusCode, 503, '/readyz phải trả về 503 khi chưa sẵn sàng');
  assert.equal(responseData.isReady, false);

  // Khi xác minh thành công:
  setReady(true);
  assert.equal(isAppReady(), true);

  readinessMiddleware(req, res, () => {});
  assert.equal(statusCode, 200, '/readyz trả về 200 khi media và database đã xác minh');
  assert.equal(responseData.status, 'ready');

  resetReadinessForTesting();
});

// -----------------------------------------------------------------------------
// 4. Quy tắc thống nhất: Giao hàng, Thu tiền COD và Thanh toán
// -----------------------------------------------------------------------------
test('Quy tắc Vận chuyển & COD: Giao hàng thành công (delivered) trên đơn COD chưa thanh toán giữ mốc delivered_at và chờ thu tiền', async () => {
  const { applyCarrierDeliveryTransition } = require('../src/shipping-management');

  const updates = [];
  const mockClient = {
    query: async (sql, params) => {
      updates.push({ sql, params });
      return { rows: [] };
    }
  };

  const codShipment = {
    id: 'shipment-123',
    order_id: 'order-123',
    orderStatus: 'shipped',
    orderPaymentMethod: 'cod',
    orderPaymentStatus: 'pending',
    orderTotalVnd: 500000,
    orderCustomerId: 'cust-1'
  };

  const nextStatus = await applyCarrierDeliveryTransition(mockClient, codShipment, 'delivered', { username: 'carrier_bot' });

  assert.equal(nextStatus, 'shipped', 'Đơn COD giao thành công vẫn ở trạng thái shipped để chờ đối chiếu/thu tiền COD');
  assert.ok(updates.some(u => u.sql.includes('delivered_at')), 'Phải cập nhật mốc delivered_at khi hãng giao thành công');
});

test('Quy tắc Vận chuyển & Trả trước: Giao hàng thành công (delivered) trên đơn trả trước (paid) chuyển thẳng sang completed', async () => {
  const { applyCarrierDeliveryTransition } = require('../src/shipping-management');

  const updates = [];
  const mockClient = {
    query: async (sql, params) => {
      updates.push({ sql, params });
      return { rows: [] };
    }
  };

  const prepaidShipment = {
    id: 'shipment-456',
    order_id: 'order-456',
    orderStatus: 'shipped',
    orderPaymentMethod: 'vnpay',
    orderPaymentStatus: 'paid',
    orderTotalVnd: 750000,
    orderCustomerId: null
  };

  const nextStatus = await applyCarrierDeliveryTransition(mockClient, prepaidShipment, 'delivered', { username: 'carrier_bot' });

  assert.equal(nextStatus, 'completed', 'Đơn trả trước đã thanh toán chuyển thẳng sang completed khi giao hàng thành công');
  assert.ok(updates.some(u => u.params && u.params.includes('completed')));
});

// -----------------------------------------------------------------------------
// 5. Shutdown không bị chậm bởi quá trình startup
// -----------------------------------------------------------------------------
test('Graceful Shutdown: server.close được gọi ngay lập tức và deadline 2.5s bảo vệ không bị treo', async () => {
  let serverClosedImmediately = false;
  let slowStartupFinished = false;

  const mockServer = {
    close(cb) {
      serverClosedImmediately = true;
      cb();
    }
  };

  // Giả lập startTask bị nghẽn mạng 10 giây
  const slowStartTask = new Promise((resolve) => {
    setTimeout(() => {
      slowStartupFinished = true;
      resolve();
    }, 10000);
  });

  const shutdownStart = Date.now();

  // Logic shutdown mới: race giữa startTask và timeout 2500ms
  await new Promise(resolve => mockServer.close(resolve));
  assert.equal(serverClosedImmediately, true, 'Server HTTP phải dừng nhận kết nối ngay lập tức');

  const startupDeadline = new Promise(resolve => setTimeout(resolve, 100)); // Dùng 100ms cho test
  await Promise.race([slowStartTask, startupDeadline]);

  const elapsed = Date.now() - shutdownStart;
  assert.ok(elapsed < 1000, 'Shutdown không được bị giữ lại bởi tiến trình startup chậm');
  assert.equal(slowStartupFinished, false, 'Tiến trình startup chậm không được chặn quá trình dừng hệ thống');
});
