'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { types } = require('pg');

const sourcePath = path.join(__dirname, '../scripts/realtime-cluster-sync.js');
const source = fs.readFileSync(sourcePath, 'utf8');

async function fixture() {
  const pools = [], clients = [], calls = [], logs = [], timers = new Set();
  let now = 100000;
  class Pool extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.name = pools.length ? 'Mi6' : 'PC';
      this.queue = []; this.rows = new Map(); this.failWrites = false; this.failAck = 0; this.connectCount = 0;
      this.receipts = new Map();
      pools.push(this);
    }
    async query(sql, params = []) {
      calls.push({ name: this.name, sql, params });
      if (sql.includes('information_schema.table_constraints')) return { rows: [{ table_name: 'records', pks: ['id'] }] };
      if (sql.includes('information_schema.columns')) return { rows: [
        ['id', 'int4'], ['created_at', 'timestamp'], ['updated_at', 'timestamptz'], ['label', 'text']
      ].map(([column_name, udt_name]) => ({ table_name: 'records', column_name, udt_name })) };
      if (sql.includes('FROM public._gaeru_sync_queue ORDER BY')) return { rows: this.queue.slice(0, 50) };
      if (sql.startsWith('DELETE FROM _gaeru_sync_queue')) {
        if (this.failAck-- > 0) throw new Error('source acknowledgment connection lost');
        this.queue = this.queue.filter(event => event.id !== params[0]); return { rows: [] };
      }
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: String(this.rows.size), fingerprint: JSON.stringify([...this.rows.entries()].sort()) }] };
      if (sql.startsWith('SELECT * FROM "records"')) {
        const row = this.rows.get(params[0]);
        if (!row) return { rows: [] };
        const parser = this.options.types || types;
        return { rows: [{ ...row,
          created_at: parser.getTypeParser(1114, 'text')(row.created_at),
          updated_at: parser.getTypeParser(1184, 'text')(row.updated_at)
        }] };
      }
      throw new Error('Unexpected source SQL in fixture');
    }
    async connect() {
      this.connectCount++;
      const pool = this; let transaction, receiptTransaction;
      return {
        async query(sql, values = []) {
          calls.push({ name: pool.name, sql, params: values });
          if (sql === 'BEGIN') { transaction = new Map(pool.rows); receiptTransaction = new Map(pool.receipts); }
          else if (sql === 'COMMIT') { pool.rows = transaction; pool.receipts = receiptTransaction; }
          else if (sql === 'ROLLBACK') { transaction = null; receiptTransaction = null; }
          else if (sql.startsWith('INSERT INTO gaeru_sync.applied_events')) {
            const key = values.slice(0, 2).join(':');
            if (receiptTransaction.has(key)) return { rows: [] };
            receiptTransaction.set(key, values[2]); return { rows: [{ payload_hash: values[2] }] };
          } else if (sql.startsWith('SELECT payload_hash FROM gaeru_sync.applied_events')) {
            const hash = receiptTransaction.get(values.join(':'));
            return { rows: hash ? [{ payload_hash: hash }] : [] };
          }
          else if (sql.trim().startsWith('INSERT INTO')) {
            if (pool.failWrites) throw new Error('target unavailable');
            const names = sql.match(/INSERT INTO "records" \(([^)]+)\)/)[1].split(',').map(value => value.trim().replaceAll('"', ''));
            const row = Object.fromEntries(names.map((name, index) => [name, values[index]]));
            transaction.set(row.id, row);
          } else if (sql.startsWith('DELETE FROM "records"')) {
            if (pool.failWrites) throw new Error('target unavailable');
            transaction.delete(values[0]);
          } else if (!sql.startsWith('SET LOCAL')) throw new Error('Unexpected target SQL in fixture');
          return { rows: [] };
        },
        release() { calls.push({ name: pool.name, sql: 'RELEASE' }); }
      };
    }
  }
  class Client extends EventEmitter {
    constructor() { super(); clients.push(this); }
    async connect() { throw new Error('fixture listener unavailable'); }
    async end() { this.emit('end'); }
  }
  const module = { exports: {} };
  const customRequire = id => {
    if (id === './cluster-media-sync') return require('../scripts/cluster-media-sync');
    if (id === './cluster-sync-receipts') return {
      ...require('../scripts/cluster-sync-receipts'),
      getNodeIdentity: async pool => pool.name === 'PC' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222'
    };
    if (id === 'pg') return { Pool, Client, types };
    if (id === 'dotenv') return { config() {} };
    if (id === 'fs') return { appendFileSync() {} };
    if (id === 'child_process') return { spawn() { throw new Error('No processes allowed'); }, exec() { throw new Error('No commands allowed'); } };
    return require(id);
  };
  customRequire.main = {};
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(source, {
    require: customRequire, module, __dirname: path.dirname(sourcePath), Date: Clock,
    process: { env: { PC_DB_URL: 'pc-fixture', MI6_DB_URL: 'mi6-fixture' }, on() {}, stdout: { write: value => logs.push(value) }, stderr: { write: value => logs.push(value) } },
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); }
  });
  await module.exports.loadMetadata();
  calls.length = 0;
  const add = (pool, id, op = 'UPDATE', table_name = 'records') => {
    pool.queue.push({ id, op, table_name, pk_vals: { id }, payload_hash: String(id).padStart(64, '0') });
    pool.rows.set(id, { id, created_at: '2026-11-10 12:34:56.123456', updated_at: '2026-11-10 12:34:56.987654+00', label: `record-${id}` });
  };
  return { ...module.exports, pools, clients, calls, logs, timers, add, advance: ms => { now += ms; } };
}

test('target failure preserves queue order and notifications cannot bypass exponential backoff', async () => {
  const f = await fixture(); const [pc, mi6] = f.pools;
  f.add(pc, 1); f.add(pc, 2); mi6.failWrites = true;
  assert.equal(await f.drainQueue(pc, mi6, 'PC', 'Mi6'), 0);
  assert.deepEqual(pc.queue.map(event => event.id), [1, 2]);
  assert.equal(mi6.rows.size, 0);
  assert.equal(f.calls.filter(call => call.sql === 'ROLLBACK').length, 1);
  const callCount = f.calls.length;
  for (let i = 0; i < 100; i++) await f.drainQueue(pc, mi6, 'PC', 'Mi6');
  assert.equal(f.calls.length, callCount);
  f.advance(1000); await f.drainQueue(pc, mi6, 'PC', 'Mi6');
  assert.equal(mi6.connectCount, 2);
  mi6.failWrites = false; f.advance(1999); await f.drainQueue(pc, mi6, 'PC', 'Mi6');
  assert.equal(mi6.connectCount, 2);
  f.advance(1); assert.equal(await f.drainQueue(pc, mi6, 'PC', 'Mi6'), 2);
  assert.equal(pc.queue.length, 0); assert.equal(mi6.rows.size, 2);
});

test('unknown metadata and malformed events remain queued without touching the destination', async () => {
  for (const change of [{ table_name: 'new_table' }, { op: 'TRUNCATE' }, { pk_vals: {} }]) {
    const f = await fixture(); const [pc, mi6] = f.pools; f.add(pc, 1); Object.assign(pc.queue[0], change);
    assert.equal(await f.drainQueue(pc, mi6, 'PC', 'Mi6'), 0);
    assert.equal(pc.queue.length, 1); assert.equal(mi6.connectCount, 0);
    assert.equal(f.calls.some(call => call.sql.startsWith('DELETE')), false);
  }
});

test('a committed destination write with lost acknowledgment is retried without overwriting a later target edit', async () => {
  const f = await fixture(); const [pc, mi6] = f.pools; f.add(pc, 1); pc.failAck = 1;
  assert.equal(await f.drainQueue(pc, mi6, 'PC', 'Mi6'), 0);
  assert.equal(pc.queue.length, 1); assert.equal(mi6.rows.size, 1);
  const commitIndex = f.calls.findIndex(call => call.sql === 'COMMIT');
  const ackIndex = f.calls.findIndex(call => call.sql.startsWith('DELETE FROM _gaeru_sync_queue'));
  assert.ok(commitIndex >= 0 && commitIndex < ackIndex);
  assert.equal(f.calls.some(call => call.sql === 'ROLLBACK'), false);
  mi6.rows.set(1, { ...mi6.rows.get(1), label: 'newer-target-edit' });
  const sourceReadsBeforeRetry = f.calls.filter(call => call.sql.startsWith('SELECT * FROM "records"')).length;
  f.advance(1000); assert.equal(await f.drainQueue(pc, mi6, 'PC', 'Mi6'), 1);
  assert.equal(pc.queue.length, 0); assert.equal(mi6.rows.size, 1);
  assert.equal(mi6.rows.get(1).label, 'newer-target-edit');
  assert.equal(f.calls.filter(call => call.sql.startsWith('SELECT * FROM "records"')).length, sourceReadsBeforeRetry);
});

test('both directions preserve all six timestamp fractional digits and acknowledge only after commit', async () => {
  const f = await fixture(); const [pc, mi6] = f.pools;
  for (const [from, to, id] of [[pc, mi6, 1], [mi6, pc, 2]]) {
    f.add(from, id); f.calls.length = 0;
    assert.equal(await f.drainQueue(from, to, from.name, to.name), 1);
    assert.equal(to.rows.get(id).created_at, '2026-11-10 12:34:56.123456');
    assert.equal(to.rows.get(id).updated_at, '2026-11-10 12:34:56.987654+00');
    assert.ok(f.calls.findIndex(call => call.sql === 'COMMIT') < f.calls.findIndex(call => call.sql.startsWith('DELETE FROM _gaeru_sync_queue')));
  }
  assert.equal(pc.options.types.getTypeParser(23, 'text')('42'), 42);
});

test('count mismatch auditing neither drains queued events nor recreates missing records', async () => {
  const f = await fixture(); const [pc, mi6] = f.pools; f.add(pc, 1);
  await f.reconcileDrift();
  assert.equal(pc.queue.length, 1); assert.equal(mi6.rows.size, 0);
  assert.equal(pc.connectCount + mi6.connectCount, 0);
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every(call => call.sql.startsWith('SELECT count(*)')));
  assert.ok(f.logs.some(line => line.includes('[WARN]')));
});

test('equal row counts with different values are reported without choosing a winner', async () => {
  const f = await fixture(); const [pc, mi6] = f.pools;
  f.add(pc, 1); f.add(mi6, 1);
  mi6.rows.get(1).label = 'independent-change';
  f.calls.length = 0;
  const audit = await f.reconcileDrift();
  assert.equal(audit.comparedTables, 1);
  assert.equal(audit.differences.length, 1);
  assert.equal(audit.differences[0].pc.count, audit.differences[0].mi6.count);
  assert.equal(mi6.rows.get(1).label, 'independent-change');
  assert.equal(pc.rows.get(1).label, 'record-1');
  assert.ok(f.calls.every(call => call.sql.startsWith('SELECT count(*)')));
});

test('a busy queue yields after a bounded batch and retains the remainder for the next turn', async () => {
  const f = await fixture(); const [pc, mi6] = f.pools;
  for (let id = 1; id <= 251; id++) f.add(pc, id);
  assert.equal(await f.drainQueue(pc, mi6, 'PC', 'Mi6'), 250);
  assert.equal(pc.queue.length, 1); assert.equal(mi6.rows.size, 250);
  assert.equal(await f.drainQueue(pc, mi6, 'PC', 'Mi6'), 1);
  assert.equal(mi6.rows.size, 251);
});

test('a failed direction does not hold up the other direction', async () => {
  const f = await fixture(); const [pc, mi6] = f.pools; f.add(pc, 1); f.add(mi6, 2);
  mi6.failWrites = true;
  assert.equal(await f.drainQueue(pc, mi6, 'PC', 'Mi6'), 0);
  assert.equal(await f.drainQueue(mi6, pc, 'Mi6', 'PC'), 1);
  assert.equal(pc.queue.length, 1); assert.equal(mi6.queue.length, 0); assert.equal(pc.rows.has(2), true);
});

test('listener reconnection has one bounded retry timer and close cancels retries', async () => {
  const f = await fixture();
  const listener = f.startListener('fixture', 'PC', () => {});
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  await settle();
  const delays = [];
  for (let i = 0; i < 9; i++) {
    assert.equal(f.timers.size, 1);
    const timer = [...f.timers][0]; delays.push(timer.ms); f.timers.delete(timer); timer.fn(); await settle();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  listener.close(); await settle(); assert.equal(f.timers.size, 0);
});
