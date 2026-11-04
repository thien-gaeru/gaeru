const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');
const {
  signTestGoogleIdToken,
  createTestGoogleOAuthClient
} = require('./helpers/google-id-token');

test('Google OAuth customer can set password initially without old password, and login with email/password', { timeout: 60000 }, async (t) => {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise((r) => (release = r));
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
      try {
        return await query(sql, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    }
  };

  await migrateDatabase(pool);

  const testOAuthClient = createTestGoogleOAuthClient();
  const config = {
    NODE_ENV: 'test',
    SESSION_SECRET: 'google-oauth-password-security-test-secret-at-least-32-chars',
    ADMIN_USERNAME: 'owner',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync('OwnerPassword123!', 4),
    GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com'
  };

  const app = createApp({
    pool,
    sessionStore: new session.MemoryStore(),
    config,
    oauthClient: testOAuthClient
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await db.close();
  });

  const base = `http://127.0.0.1:${server.address().port}`;

  function createClient() {
    let cookie = '';
    let csrf = '';
    const client = {
      async request(path, method = 'GET', body) {
        const headers = {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {})
        };
        const r = await fetch(base + path, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined
        });
        if (r.headers.get('set-cookie')) {
          cookie = r.headers.get('set-cookie').split(';')[0];
        }
        const text = await r.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
        if (data && typeof data === 'object' && data.csrfToken) {
          csrf = data.csrfToken;
        }
        return { status: r.status, data };
      },
      async getCsrf() {
        const res = await client.request('/api/csrf');
        assert.equal(res.status, 200);
        return res.data;
      }
    };
    return client;
  }

  // 1. Khách hàng đăng nhập lần đầu qua Google OAuth (chưa có password_hash)
  const googleClient = createClient();
  await googleClient.getCsrf();

  const googleJwt = signTestGoogleIdToken({
    iss: 'accounts.google.com',
    aud: 'test-google-client-id.apps.googleusercontent.com',
    sub: 'google-sub-set-pwd-123',
    email: 'googleuser@example.com',
    email_verified: true,
    name: 'Google User Test',
    picture: 'https://lh3.googleusercontent.com/avatar.jpg'
  });

  const oauthRes = await googleClient.request('/api/customer-auth/oauth/google', 'POST', {
    credential: googleJwt
  });
  assert.equal(oauthRes.status, 200, 'OAuth login must succeed');
  assert.equal(oauthRes.data.customer.email, 'googleuser@example.com');
  const customerId = oauthRes.data.customer.id;

  // Kiểm tra database: password_hash phải là NULL
  const dbCust = (await pool.query('SELECT id, email, password_hash, google_id FROM customers WHERE id = $1', [customerId])).rows[0];
  assert.equal(dbCust.password_hash, null, 'Customer initially must have NULL password_hash');
  assert.equal(dbCust.google_id, 'google-sub-set-pwd-123');

  // 2. Kiểm tra API GET /api/account-security/settings trả về hasPassword: false
  const settingsRes = await googleClient.request('/api/account-security/settings', 'GET');
  assert.equal(settingsRes.status, 200);
  assert.equal(settingsRes.data.hasPassword, false, 'hasPassword must be false for Google OAuth user without password');

  // 3. Khách hàng tạo mật khẩu lần đầu: POST /api/account-security/password KHÔNG CẦN password cũ
  const setPwdRes = await googleClient.request('/api/account-security/password', 'POST', {
    newPassword: 'MyNewPassword123!'
  });
  assert.equal(setPwdRes.status, 200, 'Initial set password without current password must succeed');
  assert.match(setPwdRes.data.message, /Đã tạo mật khẩu thành công/, 'Must return password created success message');

  // Kiểm tra database: password_hash bây giờ đã được hash và lưu
  const updatedCust = (await pool.query('SELECT password_hash FROM customers WHERE id = $1', [customerId])).rows[0];
  assert.ok(updatedCust.password_hash, 'Customer must now have password_hash');
  assert.ok(bcrypt.compareSync('MyNewPassword123!', updatedCust.password_hash), 'Stored hash must match new password');

  // 4. Kiểm tra API GET /api/account-security/settings trả về hasPassword: true
  const settingsRes2 = await googleClient.request('/api/account-security/settings', 'GET');
  assert.equal(settingsRes2.status, 200);
  assert.equal(settingsRes2.data.hasPassword, true, 'hasPassword must now be true');

  // 5. Thử đổi mật khẩu lần 2 mà KHÔNG truyền password cũ -> Phải bị từ chối với CURRENT_PASSWORD_INVALID
  const failRes = await googleClient.request('/api/account-security/password', 'POST', {
    newPassword: 'AnotherPassword456!'
  });
  assert.equal(failRes.status, 403, 'Subsequent password change without current password must be rejected');
  assert.equal(failRes.data.code, 'CURRENT_PASSWORD_INVALID');

  // 6. Thử đổi mật khẩu lần 2 với password cũ SAI -> Bị từ chối
  const wrongPwdRes = await googleClient.request('/api/account-security/password', 'POST', {
    password: 'WrongPassword!',
    newPassword: 'AnotherPassword456!'
  });
  assert.equal(wrongPwdRes.status, 403);
  assert.equal(wrongPwdRes.data.code, 'CURRENT_PASSWORD_INVALID');

  // 7. Đổi mật khẩu lần 2 với password cũ ĐÚNG -> Thành công
  const changeRes = await googleClient.request('/api/account-security/password', 'POST', {
    password: 'MyNewPassword123!',
    newPassword: 'AnotherPassword456!'
  });
  assert.equal(changeRes.status, 200, 'Password change with correct current password must succeed');
  assert.match(changeRes.data.message, /Đã đổi mật khẩu/, 'Must return password changed message');

  // 8. Đăng nhập trực tiếp bằng email & mật khẩu mới từ một thiết bị/trình duyệt khác (guest client)
  const emailPasswordClient = createClient();
  await emailPasswordClient.getCsrf();

  const loginRes = await emailPasswordClient.request('/api/customer-auth/login', 'POST', {
    email: 'googleuser@example.com',
    password: 'AnotherPassword456!'
  });
  assert.equal(loginRes.status, 200, 'Customer should now be able to log in directly via email & password');
  assert.equal(loginRes.data.customer.email, 'googleuser@example.com');
  assert.equal(loginRes.data.customer.fullName, 'Google User Test');
});
