const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { verifyGoogleToken, verifyAppleToken, parseJwt } = require('../src/customer-oauth');

function makeJwt(payload, header = { alg: 'RS256', typ: 'JWT' }) {
  const encHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encHeader}.${encPayload}.fake_mock_signature`;
}

const baseConfig = {
  NODE_ENV: 'test',
  PORT: 0,
  SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
  ADMIN_USERNAME: 'manager',
  ADMIN_PASSWORD_HASH: bcrypt.hashSync('test-password', 4),
  GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
  APPLE_CLIENT_ID: 'com.gaeru.web.signin'
};

async function startApp(context, { pool, config = baseConfig } = {}) {
  const adaptedPool = Object.create(pool);
  adaptedPool.query = (sql, ...args) =>
    sql.includes('account_security')
      ? Promise.resolve({ rows: [], rowCount: 0 })
      : pool.query(sql, ...args);
  if (pool.connect) {
    adaptedPool.connect = pool.connect.bind(pool);
  } else {
    adaptedPool.connect = async () => ({
      query: (sql, ...args) => adaptedPool.query(sql, ...args),
      release: () => {}
    });
  }

  const app = createApp({
    config,
    pool: adaptedPool,
    sessionStore: new session.MemoryStore()
  });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function getCsrf(baseUrl) {
  const response = await fetch(`${baseUrl}/api/csrf`);
  const body = await response.json();
  return { token: body.csrfToken, cookie: response.headers.get('set-cookie').split(';')[0] };
}

test('parseJwt parses valid JWT and rejects malformed tokens', () => {
  const payload = { sub: '12345', email: 'test@example.com' };
  const token = makeJwt(payload);
  const parsed = parseJwt(token);
  assert.equal(parsed.payload.sub, '12345');
  assert.equal(parsed.payload.email, 'test@example.com');

  assert.throws(() => parseJwt('invalid-string'), /không đúng định dạng JWT/);
  assert.throws(() => parseJwt('a.invalidBase64==.c'), /Không thể phân tích dữ liệu xác thực OAuth/);
});

test('verifyGoogleToken validates valid token and catches violations', async () => {
  const validPayload = {
    iss: 'accounts.google.com',
    aud: 'test-google-client-id.apps.googleusercontent.com',
    sub: 'google-sub-1001',
    email: 'user@gmail.com',
    email_verified: true,
    name: 'Google User',
    picture: 'https://lh3.googleusercontent.com/avatar',
    exp: Math.floor(Date.now() / 1000) + 3600
  };

  const validResult = await verifyGoogleToken(makeJwt(validPayload), {
    googleClientId: 'test-google-client-id.apps.googleusercontent.com'
  });
  assert.equal(validResult.sub, 'google-sub-1001');
  assert.equal(validResult.email, 'user@gmail.com');
  assert.equal(validResult.name, 'Google User');
  assert.equal(validResult.picture, 'https://lh3.googleusercontent.com/avatar');

  // Expired
  const expiredPayload = { ...validPayload, exp: Math.floor(Date.now() / 1000) - 400 };
  await assert.rejects(
    () => verifyGoogleToken(makeJwt(expiredPayload), { googleClientId: validPayload.aud }),
    /Mã xác thực Google đã hết hạn/
  );

  // Invalid issuer
  const invalidIss = { ...validPayload, iss: 'https://attacker.com' };
  await assert.rejects(
    () => verifyGoogleToken(makeJwt(invalidIss)),
    /Nguồn cấp chứng thực Google không hợp lệ/
  );

  // Audience mismatch
  await assert.rejects(
    () => verifyGoogleToken(makeJwt(validPayload), { googleClientId: 'different-client-id' }),
    /Mã ứng dụng Google Client ID không khớp/
  );

  // Unverified email
  const unverifiedEmail = { ...validPayload, email_verified: false };
  await assert.rejects(
    () => verifyGoogleToken(makeJwt(unverifiedEmail)),
    /Email Google chưa được xác minh/
  );
});

test('verifyAppleToken validates valid token and catches violations', async () => {
  const validPayload = {
    iss: 'https://appleid.apple.com',
    aud: 'com.gaeru.web.signin',
    sub: 'apple-sub-2002',
    email: 'appleuser@privaterelay.appleid.com',
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600
  };

  const validResult = await verifyAppleToken(makeJwt(validPayload), {
    appleClientId: 'com.gaeru.web.signin'
  });
  assert.equal(validResult.sub, 'apple-sub-2002');
  assert.equal(validResult.email, 'appleuser@privaterelay.appleid.com');

  // Expired
  const expiredPayload = { ...validPayload, exp: Math.floor(Date.now() / 1000) - 500 };
  await assert.rejects(
    () => verifyAppleToken(makeJwt(expiredPayload)),
    /Mã xác thực Apple đã hết hạn/
  );

  // Invalid issuer
  const badIss = { ...validPayload, iss: 'https://evil.com' };
  await assert.rejects(
    () => verifyAppleToken(makeJwt(badIss)),
    /Nguồn cấp chứng thực Apple không hợp lệ/
  );
});

test('GET /api/customer-auth/oauth/config returns client configuration', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });

  const res = await fetch(`${baseUrl}/api/customer-auth/oauth/config`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.google.enabled, true);
  assert.equal(data.google.clientId, 'test-google-client-id.apps.googleusercontent.com');
  assert.equal(data.apple.enabled, false);
});

test('POST /api/customer-auth/oauth/google creates a new customer and returns session', async (context) => {
  let inserted = false;
  const pool = {
    query: async (sql, values) => {
      if (sql.includes('customers WHERE google_id = $1')) {
        return { rows: [] };
      }
      if (sql.includes('customers WHERE lower(email) = $1')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO customers')) {
        inserted = true;
        assert.equal(values[0], 'Nguyen Van A');
        assert.equal(values[1], 'nguyenvana@gmail.com');
        assert.equal(values[2], 'google-user-999');
        assert.equal(values[3], 'https://lh3.googleusercontent.com/photo.jpg');
        return {
          rows: [{
            id: '22222222-2222-4222-8222-222222222222',
            fullName: values[0],
            email: values[1],
            phone: '',
            emailVerified: true
          }]
        };
      }
      return { rows: [] };
    }
  };

  const baseUrl = await startApp(context, { pool });
  const csrf = await getCsrf(baseUrl);

  const googleJwt = makeJwt({
    iss: 'accounts.google.com',
    aud: 'test-google-client-id.apps.googleusercontent.com',
    sub: 'google-user-999',
    email: 'nguyenvana@gmail.com',
    email_verified: true,
    name: 'Nguyen Van A',
    picture: 'https://lh3.googleusercontent.com/photo.jpg',
    exp: Math.floor(Date.now() / 1000) + 3600
  });

  const res = await fetch(`${baseUrl}/api/customer-auth/oauth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf.token,
      Cookie: csrf.cookie
    },
    body: JSON.stringify({ credential: googleJwt })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(inserted, true);
  assert.equal(data.customer.fullName, 'Nguyen Van A');
  assert.equal(data.customer.email, 'nguyenvana@gmail.com');
  assert.equal(data.customer.emailVerified, true);
  assert.ok(data.csrfToken);
});

test('POST /api/customer-auth/oauth/google links existing email account', async (context) => {
  let linked = false;
  const existingCustomer = {
    id: '33333333-3333-4333-8333-333333333333',
    fullName: 'Existing Customer',
    email: 'existing@gmail.com',
    phone: '0829191080',
    emailVerified: false,
    active: true,
    deletedAt: null
  };

  const pool = {
    query: async (sql, values) => {
      if (sql.includes('customers WHERE google_id = $1')) {
        return { rows: [] };
      }
      if (sql.includes('customers WHERE lower(email) = $1')) {
        return { rows: [{ ...existingCustomer }] };
      }
      if (sql.includes('UPDATE customers')) {
        linked = true;
        assert.equal(values[0], 'google-user-existing');
        assert.equal(values[2], existingCustomer.id);
        return { rowCount: 1 };
      }
      return { rows: [] };
    }
  };

  const baseUrl = await startApp(context, { pool });
  const csrf = await getCsrf(baseUrl);

  const googleJwt = makeJwt({
    iss: 'accounts.google.com',
    aud: 'test-google-client-id.apps.googleusercontent.com',
    sub: 'google-user-existing',
    email: 'existing@gmail.com',
    email_verified: true,
    name: 'Existing Customer',
    exp: Math.floor(Date.now() / 1000) + 3600
  });

  const res = await fetch(`${baseUrl}/api/customer-auth/oauth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf.token,
      Cookie: csrf.cookie
    },
    body: JSON.stringify({ credential: googleJwt })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(linked, true);
  assert.equal(data.customer.email, 'existing@gmail.com');
  assert.equal(data.customer.emailVerified, true);
});

test('POST /api/customer-auth/oauth/google rejects blocked or deleted accounts', async (context) => {
  const pool = {
    query: async (sql) => {
      if (sql.includes('customers WHERE google_id = $1')) {
        return {
          rows: [{
            id: '55555555-5555-4555-8555-555555555555',
            fullName: 'Blocked User',
            email: 'blocked@gmail.com',
            phone: '',
            emailVerified: true,
            active: false,
            deletedAt: null
          }]
        };
      }
      return { rows: [] };
    }
  };

  const baseUrl = await startApp(context, { pool });
  const csrf = await getCsrf(baseUrl);

  const googleJwt = makeJwt({
    iss: 'accounts.google.com',
    aud: 'test-google-client-id.apps.googleusercontent.com',
    sub: 'google-blocked-user',
    email: 'blocked@gmail.com',
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600
  });

  const res = await fetch(`${baseUrl}/api/customer-auth/oauth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf.token,
      Cookie: csrf.cookie
    },
    body: JSON.stringify({ credential: googleJwt })
  });

  assert.equal(res.status, 403);
  const data = await res.json();
  assert.match(data.error, /Tài khoản đã bị khóa/);
});
