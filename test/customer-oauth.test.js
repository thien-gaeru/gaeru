const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { verifyGoogleToken, parseJwt } = require('../src/customer-oauth');
const {
  signTestGoogleIdToken,
  signAttackerSelfSignedJwt,
  createTestGoogleOAuthClient
} = require('./helpers/google-id-token');

const testOAuthClient = createTestGoogleOAuthClient();
const makeJwt = (payload, header) => signTestGoogleIdToken(payload, { header });

const baseConfig = {
  NODE_ENV: 'test',
  PORT: 0,
  SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
  ADMIN_USERNAME: 'manager',
  ADMIN_PASSWORD_HASH: bcrypt.hashSync('test-password', 4),
  GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
};

async function startApp(context, { pool, config = baseConfig, oauthClient = testOAuthClient } = {}) {
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
    oauthClient,
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
    googleClientId: 'test-google-client-id.apps.googleusercontent.com',
    oauthClient: testOAuthClient
  });
  assert.equal(validResult.sub, 'google-sub-1001');
  assert.equal(validResult.email, 'user@gmail.com');
  assert.equal(validResult.name, 'Google User');
  assert.equal(validResult.picture, 'https://lh3.googleusercontent.com/avatar');

  // Demo token rejected in all environments (GAERU-001)
  await assert.rejects(
    () => verifyGoogleToken('mock-google-demo-token', {
      googleClientId: validPayload.aud,
      oauthClient: testOAuthClient
    }),
    (err) => err.status === 401
  );

  // Self-signed JWT rejected in all environments (GAERU-002)
  await assert.rejects(
    () => verifyGoogleToken(signAttackerSelfSignedJwt(validPayload), {
      googleClientId: validPayload.aud,
      oauthClient: testOAuthClient
    }),
    (err) => err.status === 401
  );

  // Missing Client ID rejected safely (GAERU-002)
  await assert.rejects(
    () => verifyGoogleToken(makeJwt(validPayload), {
      googleClientId: '',
      oauthClient: testOAuthClient
    }),
    (err) => err.status === 503
  );

  // Expired
  const expiredPayload = { ...validPayload, exp: Math.floor(Date.now() / 1000) - 400 };
  await assert.rejects(
    () => verifyGoogleToken(makeJwt(expiredPayload), {
      googleClientId: validPayload.aud,
      oauthClient: testOAuthClient
    }),
    /Mã xác thực Google đã hết hạn/
  );

  // Invalid issuer
  const invalidIss = { ...validPayload, iss: 'https://attacker.com' };
  await assert.rejects(
    () => verifyGoogleToken(makeJwt(invalidIss), {
      googleClientId: validPayload.aud,
      oauthClient: testOAuthClient
    }),
    /Nguồn cấp chứng thực Google không hợp lệ/
  );

  // Audience mismatch
  await assert.rejects(
    () => verifyGoogleToken(makeJwt(validPayload), {
      googleClientId: 'different-client-id',
      oauthClient: testOAuthClient
    }),
    /Mã ứng dụng Google Client ID không khớp/
  );

  // Unverified email
  const unverifiedEmail = { ...validPayload, email_verified: false };
  await assert.rejects(
    () => verifyGoogleToken(makeJwt(unverifiedEmail), {
      googleClientId: validPayload.aud,
      oauthClient: testOAuthClient
    }),
    /Email Google chưa được xác minh/
  );
});

test('GET /api/customer-auth/oauth/config returns client configuration and disables when Client ID missing', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });

  const res = await fetch(`${baseUrl}/api/customer-auth/oauth/config`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.google.enabled, true);
  assert.equal(data.google.configured, true);
  assert.equal(data.google.clientId, 'test-google-client-id.apps.googleusercontent.com');

  const noClientUrl = await startApp(context, {
    pool,
    config: { ...baseConfig, GOOGLE_CLIENT_ID: '' }
  });
  const resDisabled = await fetch(`${noClientUrl}/api/customer-auth/oauth/config`);
  assert.equal(resDisabled.status, 200);
  const disabledData = await resDisabled.json();
  assert.equal(disabledData.google.enabled, false);
  assert.equal(disabledData.google.configured, false);
  assert.equal(disabledData.google.clientId, '');
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

test('POST /api/customer-auth/oauth/google prevents account takeover on existing email (link_required)', async (context) => {
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
    query: async (sql) => {
      if (sql.includes('auth_identities')) return { rows: [] };
      if (sql.includes('customers WHERE google_id = ')) return { rows: [] };
      if (sql.includes('lower(email) = ')) return { rows: [{ ...existingCustomer }] };
      if (sql.includes('UPDATE customers')) {
        linked = true;
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

  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(linked, false);
  assert.equal(data.linkRequired, true);
  assert.equal(data.email, 'existing@gmail.com');
});

test('POST /api/customer-auth/oauth/google automatically links verified customer with verified Google email', async (context) => {
  let linked = false;
  let identityInserted = false;
  const verifiedCustomer = {
    id: '44444444-4444-4444-8444-444444444444',
    fullName: 'Verified Customer',
    email: 'verified@gmail.com',
    phone: '0829191080',
    emailVerified: true,
    active: true,
    deletedAt: null
  };

  const pool = {
    query: async (sql) => {
      if (sql.includes('auth_identities') && sql.includes('INSERT INTO')) {
        identityInserted = true;
        return { rowCount: 1 };
      }
      if (sql.includes('auth_identities')) return { rows: [] };
      if (sql.includes('customers WHERE google_id = ')) return { rows: [] };
      if (sql.includes('lower(email) = ')) return { rows: [{ ...verifiedCustomer }] };
      if (sql.includes('UPDATE customers')) {
        linked = true;
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
    sub: 'google-user-verified',
    email: 'verified@gmail.com',
    email_verified: true,
    name: 'Verified Customer',
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
  assert.equal(identityInserted, true);
  assert.equal(linked, true);
  assert.equal(data.customer.fullName, 'Verified Customer');
  assert.equal(data.customer.email, 'verified@gmail.com');
  assert.equal(data.customer.emailVerified, true);
  assert.ok(data.csrfToken);
});

test('GET /api/customer-auth/oauth/pending-link returns pending OAuth state', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });
  const csrf = await getCsrf(baseUrl);

  const res = await fetch(`${baseUrl}/api/customer-auth/oauth/pending-link`, {
    headers: { Cookie: csrf.cookie }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.pending, false);
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

test('Helmet sets Cross-Origin-Opener-Policy: same-origin-allow-popups for OAuth popups', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
});

test('POST /account.html redirects to #customer-account when receiving valid Google credential and GIS CSRF', async (context) => {
  let created = false;
  const pool = {
    query: async (sql, values) => {
      if (sql.includes('customers WHERE google_id = $1') || sql.includes('customers WHERE lower(email) = $1')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO customers')) {
        created = true;
        return {
          rows: [{
            id: '77777777-7777-4777-8777-777777777777',
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

  const googleJwt = makeJwt({
    iss: 'accounts.google.com',
    aud: 'test-google-client-id.apps.googleusercontent.com',
    sub: 'google-redirect-user-1',
    email: 'redirectuser@gmail.com',
    email_verified: true,
    name: 'Redirect User',
    exp: Math.floor(Date.now() / 1000) + 3600
  });

  const gisCsrf = 'gis-csrf-redirect-token-01';
  const res = await fetch(`${baseUrl}/account.html`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `g_csrf_token=${gisCsrf}`
    },
    body: new URLSearchParams({ credential: googleJwt, g_csrf_token: gisCsrf }).toString(),
    redirect: 'manual'
  });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/account.html#customer-account');
  assert.equal(created, true);
  assert.ok(res.headers.get('set-cookie')?.includes('gaeru.sid'));
});

test('POST /account.html rejects missing GIS CSRF with 403 and redirects to ?oauthError=... on invalid token', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });

  const missingCsrfRes = await fetch(`${baseUrl}/account.html`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ credential: 'invalid-token' }).toString(),
    redirect: 'manual'
  });
  assert.equal(missingCsrfRes.status, 403);

  const gisCsrf = 'gis-csrf-redirect-token-02';
  const res = await fetch(`${baseUrl}/account.html`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `g_csrf_token=${gisCsrf}`
    },
    body: new URLSearchParams({ credential: 'invalid-token', g_csrf_token: gisCsrf }).toString(),
    redirect: 'manual'
  });

  assert.equal(res.status, 302);
  const loc = res.headers.get('location');
  assert.ok(loc.startsWith('/account.html?oauthError='));
});
