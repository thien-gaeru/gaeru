const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { makeJwt } = (function() {
  function makeJwt(payload, header = { alg: 'RS256', typ: 'JWT' }) {
    const encHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encHeader}.${encPayload}.fake_mock_signature`;
  }
  return { makeJwt };
})();

const baseConfig = {
  NODE_ENV: 'test',
  PORT: 0,
  SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
  ADMIN_USERNAME: 'manager',
  ADMIN_PASSWORD_HASH: bcrypt.hashSync('test-password', 4),
  GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
  GOOGLE_LOGIN_ENABLED: true
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

// TC001: New customer login via POST /auth/google (GIS Redirect mode)
test('TC001: POST /auth/google creates new customer and redirects to account on valid credential with GIS CSRF', async (context) => {
  let createdCustomer = false;
  let createdIdentity = false;
  const pool = {
    query: async (sql, values) => {
      if (sql.includes('auth_identities ai')) return { rows: [] };
      if (sql.includes('customers WHERE google_id = $1')) return { rows: [] };
      if (sql.includes('customers WHERE lower(email) = $1') || sql.includes('lower(email) = $1')) return { rows: [] };
      if (sql.includes('INSERT INTO customers')) {
        createdCustomer = true;
        return {
          rows: [{
            id: '11111111-1111-4111-8111-111111111111',
            fullName: values[0],
            email: values[1],
            phone: '',
            emailVerified: true
          }]
        };
      }
      if (sql.includes('INSERT INTO auth_identities')) {
        createdIdentity = true;
        return { rowCount: 1 };
      }
      return { rows: [] };
    }
  };

  const baseUrl = await startApp(context, { pool });
  const csrfToken = 'test-gis-csrf-token-12345';
  const googleJwt = makeJwt({
    iss: 'accounts.google.com',
    aud: 'test-google-client-id.apps.googleusercontent.com',
    sub: 'google-sub-tc001',
    email: 'newuser.tc001@gmail.com',
    email_verified: true,
    name: 'New User TC001',
    exp: Math.floor(Date.now() / 1000) + 3600
  });

  const res = await fetch(`${baseUrl}/auth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `g_csrf_token=${csrfToken}`
    },
    body: new URLSearchParams({
      credential: googleJwt,
      g_csrf_token: csrfToken
    }).toString(),
    redirect: 'manual'
  });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/account');
  assert.equal(createdCustomer, true);
  assert.equal(createdIdentity, true);
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie?.includes('gaeru.sid'));

  // Test /api/me session check
  const meRes = await fetch(`${baseUrl}/api/me`, {
    headers: { Cookie: cookie.split(';')[0] }
  });
  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.email, 'newuser.tc001@gmail.com');
});

// TC002: Returning customer login via existing auth_identities
test('TC002: POST /auth/google logs in returning customer via auth_identities without duplicate account', async (context) => {
  const existingId = '22222222-2222-4222-8222-222222222222';
  let insertAttempted = false;
  const pool = {
    query: async (sql, values) => {
      if (sql.includes('auth_identities ai')) {
        return {
          rows: [{
            id: existingId,
            fullName: 'Returning Customer',
            email: 'returning@gmail.com',
            phone: '0829191080',
            emailVerified: true,
            active: true,
            deletedAt: null
          }]
        };
      }
      if (sql.includes('INSERT INTO customers') || sql.includes('INSERT INTO auth_identities')) {
        insertAttempted = true;
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const baseUrl = await startApp(context, { pool });
  const csrfToken = 'test-gis-csrf-returning';
  const googleJwt = makeJwt({
    iss: 'accounts.google.com',
    aud: 'test-google-client-id.apps.googleusercontent.com',
    sub: 'google-sub-returning-002',
    email: 'returning@gmail.com',
    email_verified: true,
    name: 'Returning Customer',
    exp: Math.floor(Date.now() / 1000) + 3600
  });

  const res = await fetch(`${baseUrl}/auth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `g_csrf_token=${csrfToken}`
    },
    body: new URLSearchParams({
      credential: googleJwt,
      g_csrf_token: csrfToken
    }).toString(),
    redirect: 'manual'
  });

  assert.equal(res.status, 302);
  assert.equal(insertAttempted, false);
});

// TC006: Feature Flag ngắt khẩn cấp GOOGLE_LOGIN_ENABLED=false
test('TC006: Emergency Kill Switch GOOGLE_LOGIN_ENABLED=false rejects POST /auth/google with 404', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const disabledConfig = { ...baseConfig, GOOGLE_LOGIN_ENABLED: false };
  const baseUrl = await startApp(context, { pool, config: disabledConfig });

  const res = await fetch(`${baseUrl}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: 'dummy' }).toString()
  });

  assert.equal(res.status, 404);
});

// TC009-TC013: Token Validation Rejections
test('TC009: Expired Google Token is rejected with 401', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });
  const csrfToken = 'test-csrf';

  const expiredJwt = makeJwt({
    iss: 'accounts.google.com',
    aud: 'test-google-client-id.apps.googleusercontent.com',
    sub: 'google-sub-expired',
    email: 'expired@gmail.com',
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) - 500
  });

  const res = await fetch(`${baseUrl}/auth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `g_csrf_token=${csrfToken}`
    },
    body: new URLSearchParams({
      credential: expiredJwt,
      g_csrf_token: csrfToken
    }).toString()
  });

  assert.equal(res.status, 401);
});

test('TC010: Audience mismatch is rejected with 400', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });
  const csrfToken = 'test-csrf';

  const badAudJwt = makeJwt({
    iss: 'accounts.google.com',
    aud: 'attacker-client-id.apps.googleusercontent.com',
    sub: 'google-sub-aud-mismatch',
    email: 'hacker@gmail.com',
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600
  });

  const res = await fetch(`${baseUrl}/auth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `g_csrf_token=${csrfToken}`
    },
    body: new URLSearchParams({
      credential: badAudJwt,
      g_csrf_token: csrfToken
    }).toString()
  });

  assert.equal(res.status, 400);
});

test('TC013: Unverified email is rejected with 400', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });
  const csrfToken = 'test-csrf';

  const unverifiedJwt = makeJwt({
    iss: 'accounts.google.com',
    aud: 'test-google-client-id.apps.googleusercontent.com',
    sub: 'google-sub-unverified',
    email: 'unverified@gmail.com',
    email_verified: false,
    exp: Math.floor(Date.now() / 1000) + 3600
  });

  const res = await fetch(`${baseUrl}/auth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `g_csrf_token=${csrfToken}`
    },
    body: new URLSearchParams({
      credential: unverifiedJwt,
      g_csrf_token: csrfToken
    }).toString()
  });

  assert.equal(res.status, 400);
});

// TC017-TC020: Double-submit CSRF Token for GIS
test('TC017: Missing g_csrf_token in form body returns 403', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });

  const res = await fetch(`${baseUrl}/auth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: 'g_csrf_token=cookie-val-only'
    },
    body: new URLSearchParams({ credential: 'any-token' }).toString()
  });

  assert.equal(res.status, 403);
});

test('TC018: Missing g_csrf_token in Cookie returns 403', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });

  const res = await fetch(`${baseUrl}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      credential: 'any-token',
      g_csrf_token: 'body-val-only'
    }).toString()
  });

  assert.equal(res.status, 403);
});

test('TC019: Mismatched g_csrf_token (cookie vs body) returns 403', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });

  const res = await fetch(`${baseUrl}/auth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: 'g_csrf_token=token-from-victim'
    },
    body: new URLSearchParams({
      credential: 'any-token',
      g_csrf_token: 'token-from-attacker'
    }).toString()
  });

  assert.equal(res.status, 403);
});

// TC021 & TC023: Logout same-origin and custom header
test('TC021 & TC023: POST /auth/logout enforces same-origin and returns 204', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });

  // Cross-site attack simulation
  const crossSiteRes = await fetch(`${baseUrl}/auth/logout`, {
    method: 'POST',
    headers: { Origin: 'https://evil-attacker.com' }
  });
  assert.equal(crossSiteRes.status, 403);

  // Legitimate same-origin logout
  const okRes = await fetch(`${baseUrl}/auth/logout`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      'X-GAERU-Action': 'logout'
    }
  });
  assert.equal(okRes.status, 204);
});

// TC024: Anti-Account Takeover: Unlinked Google sub with existing email -> link-required
test('TC024: Anti-Account Takeover redirects to /account/link-required when email exists in customers table', async (context) => {
  const existingCustomer = {
    id: '33333333-3333-4333-8333-333333333333',
    fullName: 'Old Customer',
    email: 'oldcustomer@gmail.com',
    phone: '0829191080',
    emailVerified: false,
    active: true,
    deletedAt: null
  };

  const pool = {
    query: async (sql, values) => {
      if (sql.includes('auth_identities')) return { rows: [] };
      if (sql.includes('google_id = $1')) return { rows: [] };
      if (sql.includes('lower(email) = $1')) return { rows: [{ ...existingCustomer }] };
      return { rows: [] };
    }
  };

  const baseUrl = await startApp(context, { pool });
  const csrfToken = 'test-gis-csrf-tc024';
  const googleJwt = makeJwt({
    iss: 'accounts.google.com',
    aud: 'test-google-client-id.apps.googleusercontent.com',
    sub: 'google-sub-unlinked-takeover-attempt',
    email: 'oldcustomer@gmail.com',
    email_verified: true,
    name: 'Attacker or User with same email',
    exp: Math.floor(Date.now() / 1000) + 3600
  });

  const res = await fetch(`${baseUrl}/auth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `g_csrf_token=${csrfToken}`
    },
    body: new URLSearchParams({
      credential: googleJwt,
      g_csrf_token: csrfToken
    }).toString(),
    redirect: 'manual'
  });

  assert.equal(res.status, 303);
  const loc = res.headers.get('location');
  assert.ok(loc.includes('/account/link-required'));
  assert.ok(decodeURIComponent(loc).includes('oldcustomer@gmail.com'));
});

// GET /account/link-required endpoint
test('GET /account/link-required redirects to storefront account.html with linkRequired=1', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });

  const res = await fetch(`${baseUrl}/account/link-required?email=test%40gmail.com`, {
    redirect: 'manual'
  });
  assert.equal(res.status, 303);
  const loc = res.headers.get('location');
  assert.equal(loc, '/account.html?linkRequired=1&email=test%40gmail.com');
});

// TC030: POST /api/auth/link-google prevents hijacking another customer Google subject
test('TC030: POST /api/auth/link-google returns 409 when subject is occupied by another customer', async (context) => {
  const loggedInCustomerId = '44444444-4444-4444-8444-444444444444';
  const victimCustomerId = '99999999-9999-4999-8999-999999999999';

  const pool = {
    query: async (sql, values) => {
      if (sql.includes('SELECT customer_id FROM auth_identities')) {
        return { rows: [{ customer_id: victimCustomerId }] };
      }
      if (sql.includes('INSERT INTO customers')) {
        return {
          rows: [{
            id: loggedInCustomerId,
            fullName: 'Logged In User',
            email: 'user444@gmail.com',
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

  // Log in as customer
  const loginRes = await fetch(`${baseUrl}/api/customer-auth/oauth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf.token,
      Cookie: csrf.cookie
    },
    body: JSON.stringify({
      credential: makeJwt({
        iss: 'accounts.google.com',
        aud: 'test-google-client-id.apps.googleusercontent.com',
        sub: 'google-sub-logged-in-user',
        email: 'user444@gmail.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600
      })
    })
  });
  const userCookie = loginRes.headers.get('set-cookie').split(';')[0];
  const loginData = await loginRes.json();

  // Try linking a subject that belongs to victimCustomerId
  const linkRes = await fetch(`${baseUrl}/api/auth/link-google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': loginData.csrfToken,
      Cookie: userCookie
    },
    body: JSON.stringify({
      credential: makeJwt({
        iss: 'accounts.google.com',
        aud: 'test-google-client-id.apps.googleusercontent.com',
        sub: 'occupied-victim-sub',
        email: 'victim@gmail.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600
      })
    })
  });

  assert.equal(linkRes.status, 409);
  const linkData = await linkRes.json();
  assert.match(linkData.error, /đã được liên kết với một tài khoản GAERU khác/);
});

// TC032: POST /api/auth/unlink-google blocks lockout if no password
test('TC032: POST /api/auth/unlink-google prevents Google-only account lockout when customer has no password', async (context) => {
  const pool = {
    query: async (sql, values) => {
      if (sql.includes('SELECT password_hash')) {
        // Customer registered via Google, no password set
        return { rows: [{ password_hash: null, email: 'googleonly@gmail.com' }] };
      }
      if (sql.includes('INSERT INTO customers')) {
        return {
          rows: [{
            id: '55555555-5555-4555-8555-555555555555',
            fullName: 'Google Only User',
            email: 'googleonly@gmail.com',
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

  // Log in as customer
  const loginRes = await fetch(`${baseUrl}/api/customer-auth/oauth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf.token,
      Cookie: csrf.cookie
    },
    body: JSON.stringify({
      credential: makeJwt({
        iss: 'accounts.google.com',
        aud: 'test-google-client-id.apps.googleusercontent.com',
        sub: 'google-sub-google-only-user',
        email: 'googleonly@gmail.com',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600
      })
    })
  });
  const userCookie = loginRes.headers.get('set-cookie').split(';')[0];
  const loginData = await loginRes.json();

  // Try unlinking Google
  const unlinkRes = await fetch(`${baseUrl}/api/auth/unlink-google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': loginData.csrfToken,
      Cookie: userCookie
    }
  });

  assert.equal(unlinkRes.status, 409);
  const unlinkData = await unlinkRes.json();
  assert.match(unlinkData.error, /thiết lập mật khẩu tài khoản trước khi hủy liên kết/);
});
