'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { types } = require('pg');

const sourcePath = path.join(__dirname, '../scripts/realtime-cluster-sync.js');
const secrets = ['customer-private@example.invalid', 'SESSION_TOKEN_PRIVATE_123', 'private-row-value', 'private-db-password'];
const errorWithRow = code => Object.assign(new Error(secrets.join(' ') + ' postgres://user:private-db-password@localhost/db'), {
  code, detail: secrets[0], query: 'INSERT INTO records VALUES (private-row-value)',
  stack: 'Database error: ' + secrets.join(' ')
});
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

async function fixture({ writeError, listenerError, mainError } = {}) {
  const pools = [], logs = [], writes = [], handlers = new Map(), exits = [];
  const row = { id: 37, email: secrets[0], session: secrets[1], label: secrets[2] };
  const event = { id: '37', table_name: 'records', op: 'UPDATE', pk_vals: { ...row }, payload_hash: 'a'.repeat(64) };
  class Pool extends EventEmitter {
    constructor() { super(); this.name = pools.length ? 'Mi6' : 'PC'; this.queue = []; pools.push(this); }
    async query(sql, args = []) {
      if (sql.includes('information_schema.table_constraints')) return { rows: [{ table_name: 'records', pks: ['id'] }] };
      if (sql.includes('information_schema.columns')) return { rows: Object.keys(row).map(column_name => ({ table_name: 'records', column_name, udt_name: column_name === 'id' ? 'int4' : 'text' })) };
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: '0', fingerprint: 'equal' }] };
      if (sql.includes('FROM public._gaeru_sync_queue') || sql.startsWith('SELECT * FROM _gaeru_sync_queue')) return { rows: this.queue.slice() };
      if (sql.startsWith('SELECT * FROM "records"')) return { rows: [{ ...row }] };
      if (sql.startsWith('DELETE FROM _gaeru_sync_queue')) { this.queue = this.queue.filter(e => e.id !== args[0]); return { rows: [] }; }
      throw Error('Unexpected source query');
    }
    async connect() {
      const name = this.name;
      return {
        async query(sql, args = []) {
          if (/^(?:INSERT INTO|DELETE FROM)/.test(sql.trim())) {
            if (writeError) throw writeError;
            writes.push({ sql, args });
          }
          return { rows: [] };
        }, release() {}
      };
    }
  }
  class Client extends EventEmitter {
    async connect() { throw listenerError || errorWithRow('ECONNREFUSED'); }
    async end() { this.emit('end'); }
  }
  const module = { exports: {} };
  const requireMock = id => {
    if (id === 'pg') return { Pool, Client, types };
    if (id === 'dotenv') return { config() {} };
    if (id === './cluster-sync-receipts') return {
      getNodeIdentity: async pool => pool.name === 'PC' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
      claimEvent: async () => true,
      QUEUE_SELECT: 'SELECT * FROM public._gaeru_sync_queue ORDER BY id ASC LIMIT 50'
    };
    if (id === './cluster-media-sync') return { createMediaSynchronizer() {
      if (mainError) throw mainError;
      return { scan: async () => {}, close() {} };
    } };
    if (id === 'fs') return {
      appendFileSync(_file, text) { logs.push(text); }, existsSync() { return true; }, mkdirSync() {}
    };
    return require(id);
  };
  requireMock.main = mainError ? module : {};
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    require: requireMock, module, __dirname: path.dirname(sourcePath),
    process: {
      env: { PC_DB_URL: 'pc-fixture', MI6_DB_URL: 'mi6-fixture' },
      on(name, handler) { handlers.set(name, handler); }, exit(code) { exits.push(code); },
      stdout: { write(text) { logs.push(text); } }, stderr: { write(text) { logs.push(text); } }
    },
    setTimeout() { return {}; }, clearTimeout() {}
  }, { filename: sourcePath });
  if (mainError) await settle();
  else await module.exports.loadMetadata();
  return { ...module.exports, pools, logs, writes, handlers, exits, event };
}

function assertNoSensitiveOutput(logs) {
  const output = logs.join('');
  for (const secret of secrets) assert.equal(output.includes(secret), false, 'Sensitive row or error content reached a log sink');
  assert.doesNotMatch(output, /Database error:|INSERT INTO records VALUES|postgres:\/\//);
}

test('successful insert, update and delete log event metadata without the full captured row', async () => {
  for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
    const f = await fixture();
    f.event.op = op;
    f.pools[0].queue.push(f.event);
    await f.replicateEvent(f.pools[0], f.pools[1], f.event, 'PC', 'Mi6');
    assert.equal(f.pools[0].queue.length, 0);
    assert.equal(f.writes.length, 1);
    assert.match(f.logs.join(''), new RegExp(`event=37 table=records op=${op}`));
    assertNoSensitiveOutput(f.logs);
  }
});

test('failed writes retain their event and log only a recognized error code', async () => {
  for (const [code, safeCode] of [['23505', '23505'], [secrets[1], 'UNAVAILABLE']]) {
    const f = await fixture({ writeError: errorWithRow(code) });
    f.pools[0].queue.push(f.event);
    assert.equal(await f.drainQueue(f.pools[0], f.pools[1], 'PC', 'Mi6'), 0);
    assert.equal(f.pools[0].queue.length, 1);
    assert.match(f.logs.join(''), /event=37 table=records op=UPDATE/);
    assert.match(f.logs.join(''), new RegExp(`code=${safeCode}`));
    assertNoSensitiveOutput(f.logs);
  }
});

test('listener, idle pool and process error handlers never emit database messages or stacks', async () => {
  const f = await fixture({ listenerError: errorWithRow('ECONNRESET') });
  const listener = f.startListener('fixture', 'PC', () => {});
  await settle();
  f.pools[0].emit('error', errorWithRow('23505'));
  f.handlers.get('uncaughtException')(errorWithRow('EPIPE'));
  f.handlers.get('unhandledRejection')(secrets[2]);
  listener.close();
  const output = f.logs.join('');
  for (const code of ['ECONNRESET', '23505', 'EPIPE', 'UNAVAILABLE']) assert.ok(output.includes('code=' + code));
  assertNoSensitiveOutput(f.logs);
});

test('fatal startup failure emits a safe code and exits without leaking the thrown message', async () => {
  const f = await fixture({ mainError: errorWithRow('EACCES') });
  assert.deepEqual(f.exits, [1]);
  assert.match(f.logs.join(''), /\[FATAL\].*code=EACCES/);
  assertNoSensitiveOutput(f.logs);
});
