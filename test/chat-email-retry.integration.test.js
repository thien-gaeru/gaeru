'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { processChatEmail } = require('../src/shopping-chat-email');
const { failureStatus } = require('../src/smtp-delivery');

test('SMTP failure classification retries only known non-delivery and separates exhausted/permanent failures from ambiguous DATA', () => {
  for (const error of [{ command: 'CONN' }, { command: 'STARTTLS' }, { command: 'DATA', responseCode: 451 }]) {
    assert.equal(failureStatus(error, 1), 'pending');
    assert.equal(failureStatus(error, 3), 'failed');
  }
  assert.equal(failureStatus({ command: 'AUTH', responseCode: 535 }, 1), 'failed');
  assert.equal(failureStatus({ command: 'RCPT TO', responseCode: 550 }, 1), 'failed');
  assert.equal(failureStatus({ command: 'DATA' }, 1), 'unknown');
  assert.equal(failureStatus({}, 1), 'unknown');
});

test('chat email outbox retries transient pre-delivery failures at a bounded cadence and suppresses obsolete handoffs', async t => {
  const db = await PGlite.create();
  const pool = { async query(sql, values) { return !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : db.query(sql, values); }, async connect() { return { query: pool.query, release() {} }; } };
  t.after(() => db.close());
  await migrateDatabase(pool);
  await pool.query("INSERT INTO account_security(account_key,email) VALUES('owner','owner@example.invalid')");
  await pool.query("INSERT INTO shopping_chat_email_preferences(account_key,enabled) VALUES('owner',true) ON CONFLICT(account_key) DO UPDATE SET enabled=true");
  const thread = (await pool.query("INSERT INTO shopping_chat_threads(owner_key,product_name,request_key) VALUES('fixture','Fixture',$1) RETURNING id", [randomUUID()])).rows[0];
  async function job(kind = 'session') { return (await pool.query("INSERT INTO shopping_chat_email_outbox(thread_id,account_key,bucket,kind) VALUES($1,'owner',$2,$3) RETURNING id", [thread.id, Math.floor(Math.random() * 1000000000), kind])).rows[0].id; }
  const config = { smtp: { from: 'sender@example.invalid' } };
  let calls = 0;
  const offline = { async sendMail() { calls++; throw Object.assign(Error('fixture offline'), { command: 'CONN' }); } };
  const id = await job();
  await processChatEmail(pool, config, offline);
  assert.deepEqual((await pool.query('SELECT status,attempts,finished_at FROM shopping_chat_email_outbox WHERE id=$1', [id])).rows[0], { status: 'pending', attempts: 1, finished_at: null });
  await processChatEmail(pool, config, offline);
  assert.equal(calls, 1, 'backoff prevents immediate retry');
  for (let i = 0; i < 2; i++) {
    await pool.query("UPDATE shopping_chat_email_outbox SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [id]);
    await processChatEmail(pool, config, offline);
  }
  assert.equal((await pool.query('SELECT status FROM shopping_chat_email_outbox WHERE id=$1', [id])).rows[0].status, 'failed');
  assert.equal(calls, 3);
  const uncertain = await job();
  const ambiguous = { async sendMail() { calls++; throw Object.assign(Error('fixture timeout after DATA'), { command: 'DATA' }); } };
  await processChatEmail(pool, config, ambiguous);
  await processChatEmail(pool, config, ambiguous);
  assert.equal((await pool.query('SELECT status FROM shopping_chat_email_outbox WHERE id=$1', [uncertain])).rows[0].status, 'unknown');
  assert.equal(calls, 4, 'ambiguous delivery is never automatically repeated');
  const handoff = await job('handoff');
  await pool.query("UPDATE shopping_chat_threads SET handling_mode='human',awaiting_admin=false WHERE id=$1", [thread.id]);
  await processChatEmail(pool, config, ambiguous);
  assert.equal((await pool.query('SELECT status FROM shopping_chat_email_outbox WHERE id=$1', [handoff])).rows[0].status, 'skipped');
  assert.equal(calls, 4, 'resolved handoffs must not notify staff as still waiting');
});
