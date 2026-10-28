const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(require.resolve('../src/server'), 'utf8');

function fixture({ migrationError, pendingMigration = false } = {}) {
  const events = new EventEmitter();
  const calls = { poolClosed: 0, storeClosed: 0, listening: 0, workersStopped: 0, errors: [] };
  let resolveMigration;
  const migration = pendingMigration ? new Promise(resolve => { resolveMigration = resolve; }) : Promise.resolve();
  const pool = { on() {}, async end() { calls.poolClosed++; } };
  class Store { async close() { calls.storeClosed++; } }
  const server = new EventEmitter();
  server.close = callback => { callback(); };
  const modules = {
    dotenv: { config() {} },
    'express-session': {},
    'connect-pg-simple': () => Store,
    './config': { loadConfig: () => ({ PORT: 3000 }) },
    './db': { createPool: () => pool, inspectDatabaseTls: async () => ({}) },
    './app': { createApp: () => ({ listen(port, host, ready) { calls.listening++; queueMicrotask(ready); return server; } }) },
    './migrate': { migrateDatabase: async () => { await migration; if (migrationError) throw migrationError; } },
    './lib/filesystem-media': { probe: async () => ({}) },
    './persistent-assets': { syncAssets: async () => ({}) }
  };
  const workerNames = {
    './media-filesystem-migration':'startMigration', './shopping-chat-ai-first':'startAIChatWorker',
    './shopping-chat-compression':'startChatCompressionWorker', './shopping-chat-email':'startChatEmailWorker',
    './order-email':'startOrderEmailWorker', './warranty-email':'startWarrantyEmailWorker',
    './email-marketing':'startEmailWorker', './account-retention':'startRetentionWorker'
  };
  for (const [module, method] of Object.entries(workerNames)) modules[module] = { [method]: () => () => calls.workersStopped++ };
  const fakeProcess = { env: {}, on: events.on.bind(events), exitCode: 0 };
  vm.runInNewContext(source, {
    require(name) { assert.ok(modules[name], `Unexpected import ${name}`); return modules[name]; },
    console: { log() {}, error(...args) { calls.errors.push(args); } }, process: fakeProcess
  }, { filename: 'server.js' });
  return { calls, events, server, fakeProcess, resolveMigration };
}
const settle = async () => { for (let i=0;i<5;i++) await new Promise(resolve => setImmediate(resolve)); };

test('startup failure closes database/session resources and redacts error details', async () => {
  const error = Object.assign(new Error('postgres://user:private-password@example.test/db'), { code: 'ECONNREFUSED' });
  const f = fixture({ migrationError: error });
  await settle();
  assert.equal(f.fakeProcess.exitCode, 1);
  assert.equal(f.calls.poolClosed, 1);
  assert.equal(f.calls.storeClosed, 1);
  assert.equal(f.calls.listening, 0);
  assert.doesNotMatch(JSON.stringify(f.calls.errors), /private-password/);
});

test('shutdown before startup completes never opens a listener and releases resources once', async () => {
  const f = fixture({ pendingMigration: true });
  assert.doesNotThrow(() => f.events.emit('SIGTERM'));
  f.resolveMigration();
  await settle();
  f.events.emit('SIGINT');
  await settle();
  assert.equal(f.calls.listening, 0);
  assert.equal(f.calls.poolClosed, 1);
  assert.equal(f.calls.storeClosed, 1);
});

test('listener errors stop workers and close resources without exposing the raw error', async () => {
  const f = fixture();
  await settle();
  assert.equal(f.calls.listening, 1);
  assert.doesNotThrow(() => f.server.emit('error', Object.assign(new Error('sensitive listener context'), { code: 'EADDRINUSE' })));
  await settle();
  assert.equal(f.fakeProcess.exitCode, 1);
  assert.equal(f.calls.workersStopped, 8);
  assert.equal(f.calls.poolClosed, 1);
  assert.equal(f.calls.storeClosed, 1);
  assert.doesNotMatch(JSON.stringify(f.calls.errors), /sensitive listener context/);
});
