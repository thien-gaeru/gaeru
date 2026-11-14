'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');
const { totp } = require('../src/totp');
const { withTransaction } = require('../src/db');
const { writeRecord } = require('../src/admin-configuration');

async function fixture(t, hardened = false) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() { const previous = queue; let release; queue = new Promise(r => { release = r; }); await previous; return release; }
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) { const release = await lock(); try { return await query(sql, values); } finally { release(); } },
    async connect() { const release = await lock(); return { query, release }; }
  };
  await migrateDatabase(pool);
  const password = 'Server-console-fixture-2026';
  const config = { NODE_ENV: 'test', SECURITY_HARDENING: hardened, SESSION_SECRET: 'server-console-integration-secret-32-characters', ADMIN_USERNAME: 'fixture-owner', ADMIN_PASSWORD_HASH: bcrypt.hashSync(password, 4) };
  const store = new session.MemoryStore();
  const app = createApp({ pool, config, sessionStore: store, customerMailer: { async sendMail() { throw Error('No real mail in tests'); } } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await db.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  function client() {
    let cookie = '', csrf = '';
    return {
      async call(path, method = 'GET', body, withCsrf = true) {
        const r = await fetch(base + path, { method, headers: { Cookie: cookie, ...(withCsrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
        const data = r.status === 204 ? {} : await r.json();
        if (data.csrfToken) csrf = data.csrfToken;
        return { status: r.status, data };
      },
      async login(username = config.ADMIN_USERNAME, value = password, endpoint = '/server_admin/api/login') {
        await this.call('/server_admin/api/csrf');
        return this.call(endpoint, 'POST', { username, password: value });
      },
      async mutateSession(change) {
        const id = decodeURIComponent(cookie.split('=').slice(1).join('')).slice(2).split('.')[0];
        const current = await new Promise((resolve, reject) => store.get(id, (e, s) => e ? reject(e) : resolve(s)));
        change(current);
        await new Promise((resolve, reject) => store.set(id, current, e => e ? reject(e) : resolve()));
      },
      async session() { let result; await this.mutateSession(s => { result = { ...s }; }); return result; }
    };
  }
  return { pool, config, password, client };
}

test('server console enforces MFA enrollment and accepts completed shared MFA login', { timeout: 60000 }, async t => {
  const f = await fixture(t, true);
  const owner = f.client();
  const enrolledLogin = await owner.login();
  assert.equal(enrolledLogin.status, 200);
  assert.equal(enrolledLogin.data.ok, false);
  assert.equal(enrolledLogin.data.mfaEnrollmentRequired, true);
  assert.equal((await owner.call('/server_admin/api/db-summary')).status, 403);
  assert.equal((await owner.call('/server_admin/api/db-backup')).status, 403);
  assert.equal((await owner.call('/server_admin/api/action', 'POST', { action: 'not-an-action' })).status, 403);
  assert.equal((await owner.call('/server_admin/api/me')).data.code, 'MFA_SETUP_REQUIRED');
  const setup = await owner.call('/api/account-security/setup', 'POST', { password: f.password, method: 'app' });
  assert.equal(setup.status, 200);
  const enabled = await owner.call('/api/account-security/confirm', 'POST', { method: 'app', setupId: setup.data.setupId, code: totp(setup.data.secret, Math.floor(Date.now() / 30000)) });
  assert.equal(enabled.status, 200);
  assert.equal((await owner.call('/server_admin/api/db-summary')).status, 200);
  const second = f.client();
  const challenge = await second.login();
  assert.equal(challenge.data.mfaRequired, true);
  assert.equal((await second.call('/server_admin/api/db-summary')).status, 401);
  const completed = await second.call('/api/account-security/login/complete', 'POST', { code: enabled.data.recoveryCodes[0] });
  assert.equal(completed.status, 200);
  assert.equal((await second.call('/server_admin/api/db-summary')).status, 200);
  await second.mutateSession(s => { delete s.adminMfaVerified; });
  assert.equal((await second.call('/server_admin/api/db-summary')).status, 401);
});

test('server console revokes old credentials and legacy sessions, enforces CSRF and saved idle limits', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const owner = f.client(), old = f.client();
  assert.equal((await owner.login()).data.ok, true);
  assert.equal((await old.login()).data.ok, true);
  const stamped = await old.session();
  assert.equal(stamped.admin.source, 'bootstrap');
  assert.equal(stamped.serverAdmin, undefined);
  assert.equal((await old.call('/server_admin/api/action', 'POST', { action: 'not-an-action' }, false)).status, 403);
  assert.equal((await old.call('/server_admin/api/logout', 'POST', {}, false)).status, 403);
  assert.equal((await old.call('/server_admin/api/action', 'POST', { action: 'not-an-action' })).status, 400);
  const newPassword = 'Changed-server-password-2026';
  assert.equal((await owner.call('/api/account-security/password', 'POST', { password: f.password, newPassword })).status, 200);
  assert.equal((await old.call('/server_admin/api/db-summary')).status, 401);
  assert.equal((await old.login(f.config.ADMIN_USERNAME, f.password)).status, 401);
  assert.equal((await old.login(f.config.ADMIN_USERNAME, newPassword)).data.ok, true);
  await old.mutateSession(s => { delete s.admin; s.serverAdmin = { username: f.config.ADMIN_USERNAME, role: 'owner' }; });
  assert.equal((await old.call('/server_admin/api/db-summary')).status, 401);
  await owner.call('/server_admin/api/csrf');
  await withTransaction(f.pool, c => writeRecord(c, f.config, 'security', { idleMinutes: 60, absoluteHours: 8 }, 0, { username: f.config.ADMIN_USERNAME, source: 'bootstrap', role: 'owner' }));
  const fortyMinutesAgo = Date.now() - 40 * 60000;
  await owner.mutateSession(s => { s.adminAuthenticatedAt = fortyMinutesAgo; s.adminLastSeenAt = fortyMinutesAgo; });
  assert.equal((await owner.call('/server_admin/api/db-summary')).status, 200);
  assert.equal((await owner.session()).adminLastSeenAt, fortyMinutesAgo, 'automatic reads must not extend idle time');
  await owner.mutateSession(s => { s.adminLastSeenAt = Date.now() - 61 * 60000; });
  assert.equal((await owner.call('/server_admin/api/db-summary')).status, 401);
});

test('server console resolves real staff username and verified aliases, restricts roles and rechecks revocation', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const admin = (await f.pool.query("INSERT INTO staff_accounts(username,full_name,password_hash,role) VALUES('fixture-admin','Fixture admin',$1,'admin') RETURNING id", [f.config.ADMIN_PASSWORD_HASH])).rows[0];
  await f.pool.query("INSERT INTO staff_accounts(username,full_name,password_hash,role) VALUES('fixture-sales','Fixture sales',$1,'sales')", [f.config.ADMIN_PASSWORD_HASH]);
  await f.pool.query("INSERT INTO account_security(account_key,email,phone,contacts_verified_at) VALUES($1,'admin@example.invalid','0900000000',now())", ['staff:' + admin.id]);
  const staff = f.client();
  assert.equal((await staff.login('fixture-admin')).data.ok, true);
  assert.equal((await staff.call('/server_admin/api/db-summary')).status, 200);
  const alias = f.client();
  assert.equal((await alias.login('admin@example.invalid')).data.ok, true);
  assert.equal((await alias.call('/server_admin/api/db-summary')).status, 200);
  const sales = f.client();
  assert.equal((await sales.login('fixture-sales')).status, 403);
  assert.equal((await sales.login('fixture-sales', f.password, '/api/auth/login')).status, 200);
  assert.equal((await sales.call('/server_admin/api/db-summary')).status, 403);
  await f.pool.query('UPDATE staff_accounts SET auth_version=auth_version+1 WHERE id=$1', [admin.id]);
  assert.equal((await staff.call('/server_admin/api/db-summary')).status, 401);
  await alias.login('fixture-admin');
  await f.pool.query("UPDATE account_security SET version=version+1 WHERE account_key=$1", ['staff:' + admin.id]);
  assert.equal((await alias.call('/server_admin/api/db-summary')).status, 401);
  await alias.login('fixture-admin');
  await f.pool.query("UPDATE staff_accounts SET role='sales' WHERE id=$1", [admin.id]);
  assert.equal((await alias.call('/server_admin/api/db-summary')).status, 403);
  await f.pool.query('UPDATE staff_accounts SET active=false WHERE id=$1', [admin.id]);
  assert.equal((await alias.call('/server_admin/api/db-summary')).status, 401);
});


test('server console path casing cannot bypass saved session limits or staff security revocation', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const admin = (await f.pool.query("INSERT INTO staff_accounts(username,full_name,password_hash,role) VALUES('casing-admin','Casing admin',$1,'admin') RETURNING id", [f.config.ADMIN_PASSWORD_HASH])).rows[0];
  await f.pool.query('INSERT INTO account_security(account_key,version) VALUES($1,1)', ['staff:' + admin.id]);
  await withTransaction(f.pool, c => writeRecord(c, f.config, 'security', { idleMinutes: 60, absoluteHours: 8 }, 0, { username: f.config.ADMIN_USERNAME, source: 'bootstrap', role: 'owner' }));
  for (const path of ['/server_admin/api/db-summary', '/SERVER_ADMIN/API/DB-SUMMARY', '/SeRvEr_AdMiN/ApI/Db-SuMmArY']) {
    const staff = f.client();
    assert.equal((await staff.login('casing-admin')).data.ok, true);
    const fortyMinutesAgo = Date.now() - 40 * 60000;
    await staff.mutateSession(s => { s.adminAuthenticatedAt = fortyMinutesAgo; s.adminLastSeenAt = fortyMinutesAgo; });
    assert.equal((await staff.call(path)).status, 200, path + ' must honor the saved 60-minute limit');
    assert.equal((await staff.session()).adminLastSeenAt, fortyMinutesAgo, path + ' polling must stay passive');
    await staff.mutateSession(s => { s.adminLastSeenAt = Date.now() - 61 * 60000; });
    assert.equal((await staff.call(path)).status, 401, path + ' must reject an idle session');
    assert.equal((await staff.login('casing-admin')).data.ok, true);
    await staff.mutateSession(s => { s.adminAuthenticatedAt = Date.now() - 9 * 3600000; });
    assert.equal((await staff.call(path)).status, 401, path + ' must reject an absolutely expired session');
    assert.equal((await staff.login('casing-admin')).data.ok, true);
    await f.pool.query('UPDATE account_security SET version=version+1 WHERE account_key=$1', ['staff:' + admin.id]);
    assert.equal((await staff.call(path)).status, 401, path + ' must reject a revoked security version');
  }
});
