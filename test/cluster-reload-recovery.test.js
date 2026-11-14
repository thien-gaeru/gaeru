'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture(onFork) {
  const workers = [], timers = new Set();
  const cluster = { isPrimary: true, setupPrimary() {}, fork(env) {
    const worker = new EventEmitter();
    worker.process = { pid: workers.length + 1000 }; worker.env = env; worker.dead = false;
    worker.isConnected = () => !worker.dead; worker.isDead = () => worker.dead;
    worker.crash = () => { worker.dead = true; worker.emit('exit', 1, null); };
    worker.disconnect = () => { worker.dead = true; worker.emit('exit', 0, null); }; worker.kill = worker.disconnect;
    const index = workers.push(worker) - 1;
    queueMicrotask(() => { if (!onFork?.(index, worker, workers)) worker.emit('message', { type: 'WORKER_READY' }); });
    return worker;
  } };
  const fakeRequire = id => id === 'node:cluster' ? cluster : id === 'node:fs' ? { existsSync: () => false, writeFileSync() {} } : id === 'node:os' ? { cpus: () => [1, 2], setPriority() {}, constants: { priority: { PRIORITY_ABOVE_NORMAL: 0 } } } : id === 'node:path' ? path : id.includes('cluster-fanout') ? { defaultFanoutHub: { handleWorkerMessage() {} } } : id.includes('cluster-stock-coordinator') ? { clusterStockCoordinator: {} } : require(id);
  const module = { exports: {} };
  vm.runInNewContext('(function(){' + fs.readFileSync(require.resolve('../src/cluster-master'), 'utf8') + '\n})()', {
    require: fakeRequire, module, __dirname: path.dirname(require.resolve('../src/cluster-master')),
    console: { log() {} }, process: { env: { CLUSTER_WORKERS: '2' }, argv: [], pid: 999, on() {} },
    setInterval() { return { unref() {} }; },
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); }
  });
  return { workers, ...module.exports, timers, fire(ms) { for (const timer of [...timers]) if (timer.ms === ms) { timers.delete(timer); timer.fn(); } } };
}
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
async function finishReload(f, task) { for (let i = 0; i < 4; i++) { await settle(); f.fire(1000); } await task; }

test('active replacement crash during rolling reload restores its slot exactly once', async () => {
  const f = fixture();
  const task = f.executeRollingReload(); await settle();
  assert.equal(f.activeWorkers.get(0), f.workers[2]);
  f.workers[2].crash();
  await finishReload(f, task);
  f.fire(200); await settle();
  assert.equal(f.activeWorkers.size, 2);
  assert.equal(f.workers.length, 5);
  assert.equal(f.activeWorkers.get(0).isDead(), false);
  f.fire(200); assert.equal(f.workers.length, 5, 'no duplicate recovery timer');
});

test('retiring old workers never schedules a replacement or pollutes crash count', async () => {
  const f = fixture(); await finishReload(f, f.executeRollingReload());
  assert.equal(f.workers.length, 4); assert.equal(f.activeWorkers.size, 2);
  assert.equal([...f.timers].filter(t => t.ms === 200 || t.ms === 5000).length, 0);
  assert.equal(f.activeWorkers.get(0), f.workers[2]); assert.equal(f.activeWorkers.get(1), f.workers[3]);
});

test('old worker and its not-ready replacement both failing restores the missing slot', async () => {
  const f = fixture((i, w, all) => { if (i === 2) { all[0].crash(); w.crash(); return true; } });
  await finishReload(f, f.executeRollingReload());
  f.fire(200); await settle();
  assert.equal(f.activeWorkers.size, 2); assert.equal(f.activeWorkers.get(0).isDead(), false);
  assert.equal(f.workers.length, 5);
});

test('replacement that exits immediately after READY does not replace a healthy old worker', async () => {
  const f = fixture((i, w) => { if (i === 2) { w.emit('message', { type: 'WORKER_READY' }); w.crash(); return true; } });
  await finishReload(f, f.executeRollingReload());
  assert.equal(f.activeWorkers.get(0), f.workers[0]); assert.equal(f.workers[0].isDead(), false);
  assert.equal(f.activeWorkers.size, 2); f.fire(200); assert.equal(f.workers.length, 4);
});
