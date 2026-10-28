const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(require.resolve('../src/server'), 'utf8');

function fixture({ migrationError, pendingMigration = false, mediaCheck = { verified: true }, pendingMediaAudit = false, mediaAuditError } = {}) {
  const events = new EventEmitter();
  const calls = { poolClosed: 0, storeClosed: 0, listening: 0, listenerClosed: 0, workersStopped: 0, copiedAssets: 0, localizedMedia: 0, auditChecks: [], auditStartedAfterListen: [], logs: [], errors: [] };
  let resolveMigration, resolveMediaAudit;
  const migration = pendingMigration ? new Promise(resolve => { resolveMigration = resolve; }) : Promise.resolve();
  const mediaAudit = pendingMediaAudit ? new Promise(resolve => { resolveMediaAudit = resolve; }) : Promise.resolve();
  const pool = { on() {}, async end() { calls.poolClosed++; } };
  class Store { async close() { calls.storeClosed++; } }
  const server = new EventEmitter();
  server.close = callback => { calls.listenerClosed++; callback(); };
  const modules = {
    dotenv: { config() {} },
    'express-session': {},
    'connect-pg-simple': () => Store,
    './config': { loadConfig: () => ({ PORT: 3000 }) },
    './db': { createPool: () => pool, inspectDatabaseTls: async () => ({}) },
    './app': { createApp: () => ({ listen(port, host, ready) { calls.listening++; queueMicrotask(ready); return server; } }) },
    './migrate': { migrateDatabase: async () => { await migration; if (migrationError) throw migrationError; } },
    './lib/filesystem-media': { probe: async () => mediaCheck },
    './persistent-assets': { syncAssets: async () => { calls.copiedAssets++; return {}; } },
    './media-storage-audit': {
      runLocalMediaAudit: async () => {
        calls.localizedMedia++;calls.auditStartedAfterListen.push(calls.listening===1);
        await mediaAudit;if(mediaAuditError)throw mediaAuditError;
        return {localization:{},audit:{state:'verified'}};
      },
      auditMediaStorage: async (pool, options) => { calls.auditChecks.push(options); return { state: options.probeStatus.verified ? 'verified' : 'unavailable' }; }
    }
  };
  const workerNames = {
    './shopping-chat-file-retention':'startChatFileRetentionWorker', './tiktok-ads':'startTikTokAdsWorker', './shopping-chat-ai-first':'startAIChatWorker',
    './shopping-chat-compression':'startChatCompressionWorker', './shopping-chat-email':'startChatEmailWorker',
    './order-email':'startOrderEmailWorker', './warranty-email':'startWarrantyEmailWorker',
    './email-marketing':'startEmailWorker', './account-retention':'startRetentionWorker'
  };
  for (const [module, method] of Object.entries(workerNames)) modules[module] = { [method]: () => () => calls.workersStopped++ };
  const fakeProcess = { env: {}, on: events.on.bind(events), exitCode: 0 };
  vm.runInNewContext(source, {
    require(name) { assert.ok(modules[name], `Unexpected import ${name}`); return modules[name]; },
    console: { log(...args) { calls.logs.push(args); }, error(...args) { calls.errors.push(args); } }, process: fakeProcess
  }, { filename: 'server.js' });
  return { calls, events, server, fakeProcess, resolveMigration, resolveMediaAudit };
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
  assert.equal(f.calls.copiedAssets, 1);
  assert.equal(f.calls.localizedMedia, 1);
  assert.doesNotThrow(() => f.server.emit('error', Object.assign(new Error('sensitive listener context'), { code: 'EADDRINUSE' })));
  await settle();
  assert.equal(f.fakeProcess.exitCode, 1);
  assert.equal(f.calls.workersStopped, 9);
  assert.equal(f.calls.poolClosed, 1);
  assert.equal(f.calls.storeClosed, 1);
  assert.doesNotMatch(JSON.stringify(f.calls.errors), /sensitive listener context/);
});

test('an unavailable media volume leaves the listener available without copying or rewriting media', async () => {
  const mediaCheck = { configured: true, verified: false, errorCode: 'EACCES' };
  const f = fixture({ mediaCheck });
  await settle();
  assert.equal(f.calls.listening, 1);
  assert.equal(f.fakeProcess.exitCode, 0);
  assert.equal(f.calls.copiedAssets, 0);
  assert.equal(f.calls.localizedMedia, 0);
  assert.equal(f.calls.auditChecks.length, 1);
  assert.equal(f.calls.auditChecks[0].probeStatus, mediaCheck);
  assert.match(JSON.stringify(f.calls.logs), /unavailable/);
  assert.deepEqual(f.calls.errors, []);
  f.events.emit('SIGTERM');
  await settle();
  assert.equal(f.calls.workersStopped, 9);
  assert.equal(f.calls.poolClosed, 1);
  assert.equal(f.calls.storeClosed, 1);
});

test('a blocked background media audit does not block listening and shutdown waits before closing its database', async () => {
  const f = fixture({ pendingMediaAudit: true });
  await settle();
  assert.equal(f.calls.listening, 1);
  assert.equal(f.calls.localizedMedia, 1);
  assert.deepEqual(f.calls.auditStartedAfterListen, [true]);
  assert.equal(f.calls.auditChecks.length, 0);
  assert.equal(f.fakeProcess.exitCode, 0);
  f.events.emit('SIGTERM');
  await settle();
  assert.equal(f.calls.listenerClosed, 1);
  assert.equal(f.calls.workersStopped, 9);
  assert.equal(f.calls.storeClosed, 0);
  assert.equal(f.calls.poolClosed, 0);
  f.events.emit('SIGINT');
  f.resolveMediaAudit();
  await settle();
  assert.equal(f.calls.storeClosed, 1);
  assert.equal(f.calls.poolClosed, 1);
  assert.equal(f.calls.listenerClosed, 1);
});

test('a background audit rejection is caught and redacted without taking down the listener', async () => {
  const error=Object.assign(new Error('postgres://user:private-password@example.test/db'),{code:'ECONNRESET'});
  const f = fixture({ mediaAuditError:error });
  await settle();
  assert.equal(f.calls.listening, 1);
  assert.equal(f.fakeProcess.exitCode, 0);
  assert.equal(f.calls.poolClosed, 0);
  assert.equal(f.calls.errors.length, 1);
  assert.match(JSON.stringify(f.calls.errors), /Local media audit failed/);
  assert.match(JSON.stringify(f.calls.errors), /ECONNRESET/);
  assert.doesNotMatch(JSON.stringify(f.calls.errors), /private-password|example\.test/);
  f.events.emit('SIGTERM');
  await settle();
  assert.equal(f.calls.storeClosed, 1);
  assert.equal(f.calls.poolClosed, 1);
});
