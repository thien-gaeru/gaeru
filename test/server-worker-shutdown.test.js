const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');

// A real IPC child is necessary here: a VM-only fixture does not reproduce the
// channel keeping a retired cluster worker alive after its listener closes.
if (process.env.GAERU_SHUTDOWN_TEST_CHILD) {
  const http = require('node:http');
  const Module = require('node:module');
  const originalLoad = Module._load;
  const realTimeout = setTimeout;
  const blockedPool = process.env.GAERU_SHUTDOWN_TEST_CHILD === 'blocked-pool';
  if (blockedPool) {
    global.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 15000 ? 150 : ms, ...args);
  }
  class Store {
    async close() { process.send({ phase: 'session_closed' }); }
  }
  const pool = {
    on() {},
    async end() {
      process.send({ phase: 'pool_closing' });
      if (blockedPool) return new Promise(() => {});
      await new Promise(resolve => realTimeout(resolve, 40));
      process.send({ phase: 'pool_closed' });
    }
  };
  const modules = {
    dotenv: { config() {} },
    'express-session': {},
    'connect-pg-simple': () => Store,
    './config': { loadConfig: () => ({ PORT: 0 }) },
    './db': { createPool: () => pool, inspectDatabaseTls: async () => ({}) },
    './app': { createApp: () => ({
      listen(_port, _host, ready) {
        return http.createServer((req, res) => res.end('ok')).listen(0, '127.0.0.1', ready);
      }
    }) },
    './migrate': { migrateDatabase: async () => {} },
    './lib/readiness-gate': { setReady() {}, setStartupError() {} },
    './lib/filesystem-media': { probe: async () => ({ verified: true }) },
    './lib/cache-warmup': { warmUpCache: async () => {} },
    './persistent-assets': { syncAssets: async () => ({}) },
    './media-storage-audit': { runLocalMediaAudit: async () => ({ localization: {}, audit: { state: 'verified' } }) },
    './realtime-sse': { closeAllSseStreams() {} },
    './shipping-adapters': { syncViettelProvinceCatalog: async () => {} }
  };
  const workers = {
    './shopping-chat-file-retention': 'startChatFileRetentionWorker', './tiktok-ads': 'startTikTokAdsWorker',
    './shopping-chat-ai-first': 'startAIChatWorker', './shopping-chat-compression': 'startChatCompressionWorker',
    './shopping-chat-email': 'startChatEmailWorker', './order-email': 'startOrderEmailWorker',
    './warranty-email': 'startWarrantyEmailWorker', './care-api': 'startCareEmailWorker',
    './email-marketing': 'startEmailWorker', './abandoned-cart': 'startAbandonedCartWorker',
    './account-retention': 'startRetentionWorker'
  };
  for (const [name, method] of Object.entries(workers)) modules[name] = { [method]: () => () => {} };
  Module._load = function(name, parent, isMain) {
    return modules[name] || originalLoad.call(this, name, parent, isMain);
  };
  process.on('message', msg => {
    if (msg === 'shutdown') process.emit('SIGTERM');
  });
  require('../src/server');
} else {
  async function run(t, mode) {
    const child = fork(__filename, [], {
      env: { ...process.env, NODE_ENV: 'test', PORT: '0', GAERU_SHUTDOWN_TEST_CHILD: mode },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    const phases = [];
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.resume();
    child.on('message', msg => {
      if (msg.phase) phases.push(msg.phase);
      if (msg.type === 'WORKER_READY') child.send('shutdown');
    });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 3000);
    t.after(() => { clearTimeout(deadline); if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); });
    const [code, signal] = await once(child, 'exit');
    clearTimeout(deadline);
    return { code, signal, phases, errors };
  }
  test('retired worker releases IPC and exits after session and database cleanup', async t => {
    const r = await run(t, 'normal');
    assert.equal(r.signal, null, r.errors);
    assert.equal(r.code, 0, r.errors);
    assert.deepEqual(r.phases, ['session_closed', 'pool_closing', 'pool_closed']);
  });
  test('worker with stuck database cleanup exits unsuccessfully at its shutdown deadline', async t => {
    const r = await run(t, 'blocked-pool');
    assert.equal(r.signal, null, r.errors);
    assert.equal(r.code, 1, r.errors);
    assert.deepEqual(r.phases, ['session_closed', 'pool_closing']);
    assert.match(r.errors, /shutdown deadline exceeded/);
  });
}
