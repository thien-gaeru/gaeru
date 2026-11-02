const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');

test('authenticated customer reply reopens closed chat thread; guest reply remains 409', { timeout: 60000 }, async t => {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    let release;
    const previous = queue;
    queue = new Promise(r => release = r);
    await previous;
    return release;
  }
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try { return await query(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    }
  };
  await migrateDatabase(pool);

  const app = createApp({
    pool,
    sessionStore: new session.MemoryStore(),
    config: {
      NODE_ENV: 'test',
      SESSION_SECRET: 'reopen-chat-fixture-secret-32-chars!',
      ADMIN_USERNAME: 'owner',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync('fixture-password', 4)
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => {
    await new Promise(r => server.close(r));
    await db.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  function client() {
    let cookie = '', csrf = '';
    return {
      async call(path, method = 'GET', body, token = true) {
        const r = await fetch(base + path, {
          method,
          headers: {
            Cookie: cookie,
            'X-CSRF-Token': token ? csrf : '',
            ...(body ? { 'Content-Type': 'application/json' } : {})
          },
          body: body ? JSON.stringify(body) : undefined
        });
        if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
        const data = r.headers.get('content-type')?.includes('application/json') ? await r.json() : null;
        if (data?.csrfToken) csrf = data.csrfToken;
        return { status: r.status, data };
      },
      async loginAdmin() {
        await this.call('/api/csrf');
        return this.call('/api/auth/login', 'POST', { username: 'owner', password: 'fixture-password' });
      },
      async loginCustomer(email, password) {
        await this.call('/api/csrf');
        return this.call('/api/customer-auth/login', 'POST', { identifier: email, password });
      }
    };
  }

  // Create a customer account
  const customerPassword = 'Customer-Password-2026';
  const customerHash = await bcrypt.hash(customerPassword, 4);
  const customerUser = (await pool.query(
    'INSERT INTO customers(full_name, email, phone, password_hash) VALUES($1,$2,$3,$4) RETURNING id',
    ['Chat Customer', 'chat-cust@example.test', '0912345678', customerHash]
  )).rows[0];

  const adminClient = client();
  await adminClient.loginAdmin();

  const customerClient = client();
  await customerClient.loginCustomer('chat-cust@example.test', customerPassword);

  // Authenticated customer creates a chat thread
  const threadRes = await customerClient.call('/api/shopping-chat/threads', 'POST', {
    productSlug: null,
    body: 'Hello from customer',
    requestKey: randomUUID()
  });
  assert.equal(threadRes.status, 201);
  const threadId = threadRes.data.thread.id;

  // Verify chat filter: open list contains it, closed list does not
  const openChats = await adminClient.call('/api/gaeru_ceo/shopping-chat?status=open');
  assert.equal(openChats.status, 200);
  assert.ok(openChats.data.threads.some(t => t.id === threadId));
  assert.equal(openChats.data.openCount, 1);
  assert.equal(openChats.data.closedCount, 0);

  const closedChats = await adminClient.call('/api/gaeru_ceo/shopping-chat?status=closed');
  assert.equal(closedChats.status, 200);
  assert.ok(!closedChats.data.threads.some(t => t.id === threadId));

  // Admin closes the thread
  const closeRes = await adminClient.call('/api/gaeru_ceo/shopping-chat/' + threadId + '/status', 'PUT', {
    status: 'closed',
    version: threadRes.data.thread.version
  });
  assert.equal(closeRes.status, 200);

  // Verify chat filter after closing
  const openChatsAfterClose = await adminClient.call('/api/gaeru_ceo/shopping-chat?status=open');
  assert.ok(!openChatsAfterClose.data.threads.some(t => t.id === threadId));
  const closedChatsAfterClose = await adminClient.call('/api/gaeru_ceo/shopping-chat?status=closed');
  assert.ok(closedChatsAfterClose.data.threads.some(t => t.id === threadId));
  assert.equal(closedChatsAfterClose.data.openCount, 0);
  assert.equal(closedChatsAfterClose.data.closedCount, 1);

  // Authenticated customer replies to closed thread -> automatically reopens!
  const replyRes = await customerClient.call('/api/shopping-chat/threads/' + threadId + '/messages', 'POST', {
    body: 'I am back with another question!',
    requestKey: randomUUID()
  });
  assert.equal(replyRes.status, 200);

  // Check thread status on server is now 'open'
  const readThread = await customerClient.call('/api/shopping-chat/threads/' + threadId + '/messages');
  assert.equal(readThread.data.thread.status, 'open');

  // And admin open list now contains it again
  const openChatsReopened = await adminClient.call('/api/gaeru_ceo/shopping-chat?status=open');
  assert.ok(openChatsReopened.data.threads.some(t => t.id === threadId));
});
