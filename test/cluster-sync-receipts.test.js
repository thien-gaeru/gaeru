'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { getNodeIdentity, claimEvent, QUEUE_SELECT } = require('../scripts/cluster-sync-receipts');

async function fixture(t) {
  const db = await PGlite.create();
  t.after(() => db.close());
  const query = async (sql, args) => {
    const result = !args && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, args);
    return { ...result, rows: result?.rows || [] };
  };
  const pool = { query, async connect() { return { query, release() {} }; } };
  const id = await getNodeIdentity(pool);
  const client = await pool.connect();
  await query('CREATE TABLE records (id integer PRIMARY KEY, value text)');
  return { db, pool, id, client, query };
}

test('committed event with lost source ACK never overwrites a later target edit', async t => {
  const f = await fixture(t);
  const event = { id: '9007199254740993', payload_hash: 'a'.repeat(64) };
  await f.query('BEGIN');
  assert.equal(await claimEvent(f.client, f.id, event), true);
  await f.query("INSERT INTO records VALUES (1, 'source-version')");
  await f.query('COMMIT');
  // Source ACK was lost. Another request changes the target before retry.
  await f.query("UPDATE records SET value = 'new-target-version' WHERE id = 1");
  await f.query('BEGIN');
  if (await claimEvent(f.client, f.id, event)) {
    await f.query("UPDATE records SET value = 'source-version' WHERE id = 1");
  }
  await f.query('COMMIT');
  assert.equal((await f.query('SELECT value FROM records')).rows[0].value, 'new-target-version');
  assert.equal((await f.query('SELECT count(*)::int AS n FROM gaeru_sync.applied_events')).rows[0].n, 1);
  // Reconnect/new pool wrapper loads the same durable node identity.
  assert.equal(await getNodeIdentity({ connect: f.pool.connect }), f.id);
});

test('receipt rolls back with a failed write and reuse with another payload is rejected', async t => {
  const f = await fixture(t);
  const event = { id: '42', payload_hash: 'b'.repeat(64) };
  await f.query('BEGIN');
  assert.equal(await claimEvent(f.client, f.id, event), true);
  await f.query('ROLLBACK');
  await f.query('BEGIN');
  assert.equal(await claimEvent(f.client, f.id, event), true);
  await f.query('COMMIT');
  await f.query('BEGIN');
  await assert.rejects(claimEvent(f.client, f.id, { ...event, payload_hash: 'c'.repeat(64) }), { code: 'SYNC_RECEIPT_MISMATCH' });
  await f.query('ROLLBACK');
  assert.equal((await f.query('SELECT payload_hash FROM gaeru_sync.applied_events')).rows[0].payload_hash, event.payload_hash);
  const publicTables = (await f.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map(r => r.tablename);
  assert.deepEqual(publicTables, ['records']);
});

test('queue fingerprint preserves numeric precision and is stable across session timezones', async t => {
  const f = await fixture(t);
  await f.query(`CREATE TABLE public._gaeru_sync_queue (
    id bigint PRIMARY KEY, table_name text, op text, pk_vals jsonb, created_at timestamptz
  )`);
  await f.query(`INSERT INTO public._gaeru_sync_queue VALUES
    (1, 'records', 'UPDATE', '{"id":9007199254740993,"value":1234567890.123456789}', '2026-11-10T01:02:03.123456Z')`);
  const first = (await f.query(QUEUE_SELECT)).rows[0].payload_hash;
  await f.query("SET timezone = 'Asia/Ho_Chi_Minh'");
  assert.equal((await f.query(QUEUE_SELECT)).rows[0].payload_hash, first);
  await f.query(`UPDATE public._gaeru_sync_queue SET pk_vals = '{"id":9007199254740992,"value":1234567890.123456789}'`);
  assert.notEqual((await f.query(QUEUE_SELECT)).rows[0].payload_hash, first);
});
