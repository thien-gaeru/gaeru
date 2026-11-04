'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { createLocalPool } = require('../src/local-server');
const { migrateDatabase } = require('../src/migrate');
const { createOperationsQueues } = require('../src/operations-queues');
const { createChatCompressionAdmin } = require('../src/chat-compression-admin');

async function fixture(t, poolOverride) {
  const pool = poolOverride || await createLocalPool();
  if (!poolOverride) { await migrateDatabase(pool); t.after(() => pool.end()); }
  let principal = { username: 'fixture-owner', role: 'owner', source: 'bootstrap', permissions: ['customers.read', 'customers.write'] };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.admin = principal; req.session = { csrfToken: 'fixture-csrf' }; next(); });
  app.use(createOperationsQueues(pool, { smtp: { from: 'fixture@example.test' } }));
  app.use(createChatCompressionAdmin(pool));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.status ? error.message : 'Internal error' }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = path => fetch(base + '/owner/operations/queues' + path);
  return { pool, base, get, principal(value) { principal = value; } };
}

test('operations queues use actual migrated schemas, classify states and paginate without changing jobs', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const initial = await f.get(''); assert.equal(initial.status, 200); assert.equal(initial.headers.get('cache-control'), 'no-store');
  const empty = await initial.json(); assert.equal(empty.queues.length, 8); assert.equal(empty.workerHeartbeat, 'not_measured');
  assert.ok(empty.queues.every(queue => queue.availability === 'measured' && queue.total === 0));
  await f.pool.query(`INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,subtotal_vnd)
    SELECT 'OPS-'||n,'PRIVATE-CUSTOMER','private@example.test','0912345678','PRIVATE-ADDRESS','Hà Nội','cod',10000 FROM generate_series(1,26) n`);
  await f.pool.query(`INSERT INTO order_email_outbox(order_id,kind,status,attempts,attempted_at,finished_at,result)
    SELECT id,'receipt',CASE order_number WHEN 'OPS-1' THEN 'unknown' WHEN 'OPS-2' THEN 'failed' WHEN 'OPS-3' THEN 'sending' WHEN 'OPS-5' THEN 'sent' ELSE 'pending' END,
    CASE WHEN order_number='OPS-4' THEN 2 WHEN order_number IN ('OPS-1','OPS-2','OPS-3','OPS-5') THEN 1 ELSE 0 END,
    CASE WHEN order_number IN ('OPS-1','OPS-2','OPS-3','OPS-5') THEN now()-interval '3 minutes' END,
    CASE WHEN order_number='OPS-5' THEN now() END,'PRIVATE-SMTP-RESULT secret-token' FROM orders`);
  const snapshot = (await f.pool.query('SELECT id,status,attempts FROM order_email_outbox ORDER BY id')).rows;
  const summary = await (await f.get('')).json(), queue = summary.queues.find(item => item.id === 'order-email');
  assert.deepEqual(queue.counts, { pending: 21, retry: 1, processing: 1, unknown: 1, dead: 1, completed: 1, skipped: 0 });
  assert.equal(queue.staleCount, 1); assert.equal(queue.health, 'attention'); assert.ok(queue.oldestPendingAt); assert.ok(queue.lastAttemptedAt); assert.ok(queue.lastFinishedAt);
  const first = await (await f.get('/order-email/jobs')).json(), second = await (await f.get('/order-email/jobs?page=2')).json();
  assert.equal(first.total, 26); assert.equal(first.jobs.length, 20); assert.equal(second.jobs.length, 6);
  assert.equal(new Set([...first.jobs, ...second.jobs].map(job => job.id)).size, 26);
  const retry = await (await f.get('/order-email/jobs?state=retry')).json();
  assert.equal(retry.total, 1); assert.equal(retry.jobs[0].attempts, 2); assert.equal(retry.jobs[0].retryAllowed, false);
  const unknown = await (await f.get('/order-email/jobs?state=unknown')).json(); assert.equal(unknown.total, 1); assert.equal(unknown.jobs[0].retryAllowed, false);
  const serialized = JSON.stringify({ summary, first, second });
  for (const privateValue of ['PRIVATE-CUSTOMER', 'PRIVATE-ADDRESS', 'private@example.test', 'secret-token', '0912345678']) assert.ok(!serialized.includes(privateValue));
  assert.deepEqual((await f.pool.query('SELECT id,status,attempts FROM order_email_outbox ORDER BY id')).rows, snapshot);
  for (const path of ['/order-email/jobs?page=0', '/order-email/jobs?page=10001', '/order-email/jobs?state=invalid', '/order-email/jobs?table=orders', '/unknown/jobs']) {
    assert.equal((await f.get(path)).status, path === '/unknown/jobs' ? 404 : 400);
  }
  assert.equal((await fetch(f.base + '/owner/operations/queues/order-email/jobs', { method: 'POST' })).status, 404);
  f.principal(null); assert.equal((await f.get('')).status, 401);
  f.principal({ role: 'admin', source: 'staff', permissions: ['dashboard.read'] }); assert.equal((await f.get('')).status, 403);
  f.principal({ role: 'owner', source: 'staff', permissions: [] }); assert.equal((await f.get('/order-email/jobs')).status, 403);
});

test('unavailable queues never become zero counts and provider/database errors remain private', async t => {
  const f = await fixture(t, { async query() { throw Error('PRIVATE-CONNECTION postgresql://secret@example.test'); } });
  const summary = await (await f.get('')).json();
  assert.ok(summary.queues.every(queue => queue.availability === 'unavailable' && queue.counts === null && queue.total === null));
  const response = await f.get('/order-email/jobs'); assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text(); assert.ok(body.includes('Chưa đọc được')); assert.ok(!body.includes('PRIVATE-CONNECTION')); assert.ok(!body.includes('postgresql'));
});

test('compression retry rejects expired attachments and active leases while preserving audit and eligible recovery', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const thread = (await f.pool.query("INSERT INTO shopping_chat_threads(owner_key,product_name,request_key) VALUES('fixture','Fixture',$1) RETURNING id", [randomUUID()])).rows[0].id;
  async function file(age, status = 'failed', lease = null) {
    const message = (await f.pool.query("INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,'customer','Fixture',$2) RETURNING id", [thread, randomUUID()])).rows[0].id;
    return (await f.pool.query(`INSERT INTO shopping_chat_files(message_id,thread_id,name,mime,content,byte_size,compression_status,
      compression_attempts,compression_lease_until,created_at) VALUES($1,$2,'fixture.txt','text/plain',$3,7,$4,3,$5,now()-($6::text||' days')::interval) RETURNING id`, [message, thread, Buffer.from('fixture'), status, lease, age])).rows[0].id;
  }
  const old = await file(31), eligible = await file(1), active = await file(1, 'processing', new Date(Date.now() + 3600000));
  const data = await (await f.get('/chat-compression/jobs')).json();
  assert.equal(data.jobs.find(job => job.id === old).retryAllowed, false);
  assert.equal(data.jobs.find(job => job.id === eligible).retryAllowed, true);
  assert.equal(data.jobs.find(job => job.id === active).retryAllowed, false);
  const retry = id => fetch(f.base + '/shopping-chat/compression-jobs/' + id + '/retry', { method: 'POST', headers: { 'X-CSRF-Token': 'fixture-csrf' } });
  const expired = await retry(old); assert.equal(expired.status, 409); assert.ok((await expired.text()).includes('30 ngày'));
  assert.equal((await retry(active)).status, 409); assert.equal((await retry(eligible)).status, 200);
  assert.equal((await f.pool.query('SELECT compression_status FROM shopping_chat_files WHERE id=$1', [old])).rows[0].compression_status, 'failed');
  assert.equal((await f.pool.query('SELECT compression_attempts FROM shopping_chat_files WHERE id=$1', [eligible])).rows[0].compression_attempts, 0);
  assert.equal((await f.pool.query("SELECT count(*)::int AS count FROM audit_events WHERE action='shopping.chat.compression.retry'")).rows[0].count, 1);
});
