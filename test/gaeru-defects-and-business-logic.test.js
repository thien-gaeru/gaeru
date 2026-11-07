'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { createApp } = require('../src/app');
const { seal } = require('../src/totp');
const { stockMap, flushAllCache, reserveStock } = require('../cache');
const {
  signTestGoogleIdToken: signRawGoogleIdToken,
  createTestGoogleOAuthClient
} = require('./helpers/google-id-token');

const TEST_GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
function signTestGoogleIdToken(claims = {}) {
  return signRawGoogleIdToken({
    iss: 'https://accounts.google.com',
    aud: TEST_GOOGLE_CLIENT_ID,
    sub: 'google-sub-' + crypto.randomUUID(),
    email_verified: true,
    ...claims
  });
}
const { handleCarrierWebhook, createWaybill } = require('../src/shipping-management');
const { recordFullOrderPayment, receiptTotal } = require('../src/finance-api');
const { createPurchaseOrderFromForecast, calculateInventoryForecast } = require('../src/inventory-forecast');
const { ingestMarketplaceOrder, handleMarketplaceWebhook } = require('../src/omnichannel-sync');
const { deleteOrderPermanently } = require('../src/order-deletion');
const { withTransaction } = require('../src/db');

const SESSION_SECRET = 'gaeru-acceptance-secret-key-at-least-32-chars!!';
const ADMIN_USERNAME = 'gaeru_owner_test';
const ADMIN_PASSWORD = 'OwnerStrongPassword!2026';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 4);

async function createPglitePool(t) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function acquireLock() {
    const prev = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await prev;
    return release;
  }
  async function rawQuery(sql, values) {
    const res = !values && sql.includes(';')
      ? (await db.exec(sql)).at(-1)
      : await db.query(sql, values);
    return {
      ...res,
      rows: res?.rows || [],
      rowCount: res?.affectedRows ?? res?.rows?.length ?? 0
    };
  }
  const pool = {
    async query(sql, values) {
      const release = await acquireLock();
      try {
        return await rawQuery(sql, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await acquireLock();
      let released = false;
      return {
        query: rawQuery,
        release() {
          if (!released) {
            released = true;
            release();
          }
        }
      };
    }
  };
  t.after(async () => {
    await db.close();
  });
  await migrateDatabase(pool);
  return pool;
}

async function startTestServer(t, pool, configOverrides = {}) {
  const config = {
    NODE_ENV: 'test',
    PORT: 0,
    PUBLIC_BASE_URL: 'https://gaeru.com',
    SESSION_SECRET,
    AUTH_PEPPER: 'gaeru-pepper-acceptance-1234567890',
    ADMIN_USERNAME,
    ADMIN_PASSWORD_HASH,
    STORE_ORDERS_ENABLED: true,
    GOOGLE_CLIENT_ID: TEST_GOOGLE_CLIENT_ID,
    oauthClient: createTestGoogleOAuthClient(),
    ...configOverrides
  };
  const sessionStore = new session.MemoryStore();
  const app = createApp({ config, pool, sessionStore });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, config };
}

function extractCookies(res, jar = {}) {
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const raw of setCookies) {
    const pair = raw.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) {
      jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function getCsrfSession(baseUrl, existingJar = {}) {
  const res = await fetch(`${baseUrl}/api/csrf`, {
    headers: Object.keys(existingJar).length ? { Cookie: cookieHeader(existingJar) } : {}
  });
  extractCookies(res, existingJar);
  const body = await res.json();
  return { jar: existingJar, csrfToken: body.csrfToken };
}

async function seedPaymentConfig(pool, channelId, data) {
  const cipher = seal(JSON.stringify({ enabled: true, ...data }), SESSION_SECRET);
  const configId = channelId === 'vnpay' ? 'vnpay' : ('payment_' + channelId);
  await pool.query(
    'INSERT INTO store_settings (setting_key, setting_value) ' +
    'VALUES ($1, $2::jsonb) ' +
    'ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = now()',
    ['private_admin:' + configId, JSON.stringify({ version: 1, cipher })]
  );
  await pool.query(
    'INSERT INTO payment_channel_connections (channel_id, config_version, verified_at, enabled) ' +
    'VALUES ($1, 1, now(), true) ' +
    'ON CONFLICT (channel_id) DO UPDATE SET config_version = 1, verified_at = now(), enabled = true',
    [channelId]
  );
}

// =============================================================================
// GAERU-001, GAERU-002, GAERU-003, GAERU-008: Auth, OAuth RSA/CSRF & Logout Origin
// =============================================================================
test('GAERU-001 & GAERU-002 & GAERU-003 & GAERU-008: Google OAuth strict RSA/CSRF verification and Logout strict Origin validation', async (t) => {
  const pool = await createPglitePool(t);

  // Attacker generates an unauthorized RSA keypair to forge a self-signed JWT
  const attackerKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  function forgeAttackerJwt(claims) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'attacker-key' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: TEST_GOOGLE_CLIENT_ID,
      sub: 'attacker-sub-999',
      email: 'ceo-victim@gaeru.com',
      email_verified: true,
      name: 'Forged Victim',
      iat: Math.floor(Date.now() / 1000) - 10,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims
    })).toString('base64url');
    const sig = crypto.createSign('RSA-SHA256').update(`${header}.${payload}`).sign(attackerKeys.privateKey, 'base64url');
    return `${header}.${payload}.${sig}`;
  }

  for (const envMode of ['test', 'production']) {
    const { baseUrl } = await startTestServer(t, pool, {
      NODE_ENV: envMode,
      TRUST_PROXY: 1
    });
    const xfProto = envMode === 'production' ? { 'X-Forwarded-Proto': 'https' } : {};
    const jar = {};
    const csrfRes = await fetch(`${baseUrl}/api/csrf`, { headers: xfProto });
    extractCookies(csrfRes, jar);
    const { csrfToken } = await csrfRes.json();

    // GAERU-001: mock-google-demo-token MUST return 401 in EVERY environment
    const demoRes = await fetch(`${baseUrl}/api/customer-auth/oauth/google`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        Cookie: cookieHeader(jar),
        ...xfProto
      },
      body: JSON.stringify({ credential: 'mock-google-demo-token' })
    });
    assert.equal(demoRes.status, 401, `mock-google-demo-token must fail 401 in NODE_ENV=${envMode}`);

    // GAERU-002: Attacker self-signed RSA JWT MUST return 401 in EVERY environment
    const forgedRes = await fetch(`${baseUrl}/api/customer-auth/oauth/google`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        Cookie: cookieHeader(jar),
        ...xfProto
      },
      body: JSON.stringify({ credential: forgeAttackerJwt({}) })
    });
    assert.equal(forgedRes.status, 401, `Forged RSA JWT must fail 401 in NODE_ENV=${envMode}`);
  }

  const countAfterAttacks = (await pool.query('SELECT COUNT(*)::int AS cnt FROM customers')).rows[0].cnt;
  assert.equal(countAfterAttacks, 0, 'Zero customer accounts may be created by demo or forged tokens');

  // GAERU-002 (missing GOOGLE_CLIENT_ID): safely disables OAuth endpoints (503)
  {
    const { baseUrl } = await startTestServer(t, pool, { GOOGLE_CLIENT_ID: '' });
    const cfgRes = await fetch(`${baseUrl}/api/customer-auth/oauth/config`);
    const cfgBody = await cfgRes.json();
    assert.equal(cfgBody.google.configured, false);
    assert.equal(cfgBody.google.enabled, false);

    const { jar, csrfToken } = await getCsrfSession(baseUrl);
    const postDisabled = await fetch(`${baseUrl}/api/customer-auth/oauth/google`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        Cookie: cookieHeader(jar)
      },
      body: JSON.stringify({ credential: signTestGoogleIdToken({ email: 'valid@gaeru.com' }) })
    });
    assert.equal(postDisabled.status, 503);
  }

  // GAERU-001 (positive fixture) & GAERU-003 (unconditional g_csrf_token double-submit)
  {
    const { baseUrl } = await startTestServer(t, pool);
    const validToken = signTestGoogleIdToken({
      sub: 'google-real-user-01',
      email: 'realbuyer@gaeru.com',
      name: 'Real Buyer'
    });

    // Missing both cookie & body g_csrf_token -> 403
    const cbNoBoth = await fetch(`${baseUrl}/api/customer-auth/oauth/google-callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: validToken }).toString(),
      redirect: 'manual'
    });
    assert.equal(cbNoBoth.status, 403);

    // Missing cookie -> 403
    const cbNoCookie = await fetch(`${baseUrl}/api/customer-auth/oauth/google-callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: validToken, g_csrf_token: 'tok123' }).toString(),
      redirect: 'manual'
    });
    assert.equal(cbNoCookie.status, 403);

    // Missing body -> 403
    const cbNoBody = await fetch(`${baseUrl}/api/customer-auth/oauth/google-callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'g_csrf_token=tok123'
      },
      body: new URLSearchParams({ credential: validToken }).toString(),
      redirect: 'manual'
    });
    assert.equal(cbNoBody.status, 403);

    // Mismatched cookie vs body -> 403
    const cbMismatch = await fetch(`${baseUrl}/api/customer-auth/oauth/google-callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'g_csrf_token=tok_cookie'
      },
      body: new URLSearchParams({ credential: validToken, g_csrf_token: 'tok_body' }).toString(),
      redirect: 'manual'
    });
    assert.equal(cbMismatch.status, 403);

    // Matching g_csrf_token + valid RSA token -> 303 redirect & authenticated session
    const cbValid = await fetch(`${baseUrl}/api/customer-auth/oauth/google-callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: 'g_csrf_token=matching_gis_csrf_999'
      },
      body: new URLSearchParams({
        credential: validToken,
        g_csrf_token: 'matching_gis_csrf_999'
      }).toString(),
      redirect: 'manual'
    });
    assert.equal(cbValid.status, 302);
    assert.equal(cbValid.headers.get('location'), '/account.html#customer-account');
  }

  // GAERU-008: Strict Origin URL parsing on POST /api/auth/logout
  {
    const { baseUrl } = await startTestServer(t, pool, { PUBLIC_BASE_URL: 'https://gaeru.com' });
    const { jar, csrfToken } = await getCsrfSession(baseUrl);
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        Cookie: cookieHeader(jar)
      },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
    });
    assert.equal(loginRes.status, 200);
    extractCookies(loginRes, jar);

    // Prefix-spoofed subdomain attacker origin MUST be blocked with 403
    const spoofLogout = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        Origin: 'https://gaeru.com.attacker.example',
        Cookie: cookieHeader(jar)
      }
    });
    assert.equal(spoofLogout.status, 403);

    // Referer prefix spoof MUST also be blocked with 403
    const spoofReferer = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        Referer: 'https://gaeru.com.attacker.example/csrf.html',
        Cookie: cookieHeader(jar)
      }
    });
    assert.equal(spoofReferer.status, 403);

    // Admin session must STILL be active
    const meStill = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookieHeader(jar) } });
    const meStillBody = await meStill.json();
    assert.equal(meStillBody.authenticated, true);

    // Legitimate PUBLIC_BASE_URL origin succeeds (204) and destroys session
    const okLogout = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        Origin: 'https://gaeru.com',
        Cookie: cookieHeader(jar)
      }
    });
    assert.equal(okLogout.status, 204);

    const meAfter = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookieHeader(jar) } });
    const meAfterBody = await meAfter.json();
    assert.equal(meAfterBody.authenticated, false);
  }
});

// =============================================================================
// GAERU-004, GAERU-005, GAERU-007: Legacy Checkout Retired, Strict Integer Qty & Cold-Start Stock
// =============================================================================
test('GAERU-004 & GAERU-005 & GAERU-007: Retired /api/checkout (410), integer-only quantities, and DB-backed cold-start stock lookup', async (t) => {
  const pool = await createPglitePool(t);
  const { baseUrl } = await startTestServer(t, pool);

  const mainWh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0];
  const prod = (await pool.query(
    "INSERT INTO products (name, slug, category, active) VALUES ('Tai nghe GAERU Ace', 'tai-nghe-gaeru-ace', 'audio', true) RETURNING id"
  )).rows[0];
  const varFive = (await pool.query(
    "INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'ACE-BLK-5', 'Đen', 400000, 5, true) RETURNING id",
    [prod.id]
  )).rows[0];
  const varZero = (await pool.query(
    "INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'ACE-WHT-0', 'Trắng', 400000, 0, true) RETURNING id",
    [prod.id]
  )).rows[0];
  await pool.query(
    'INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 5), ($1, $3, 0)',
    [mainWh.id, varFive.id, varZero.id]
  );

  // GAERU-007: Simulate cold start / cache flush -> stockMap is completely empty
  flushAllCache();
  assert.equal(stockMap.size, 0);

  // 1) Active SKU with 5 units in DB must return { stock: 5, inStock: true } (NOT 0!)
  const stockRes5 = await fetch(`${baseUrl}/api/stock/ACE-BLK-5`);
  assert.equal(stockRes5.status, 200);
  const stockBody5 = await stockRes5.json();
  // found omitted on 200
  assert.equal(stockBody5.stock, 5);
  assert.equal(stockBody5.inStock, true);
  assert.equal(stockMap.get('ACE-BLK-5'), 5);

  // 2) Active SKU with 0 units in DB must distinguish 0 stock from cache miss
  const stockRes0 = await fetch(`${baseUrl}/api/stock/ACE-WHT-0`);
  const stockBody0 = await stockRes0.json();
  // found omitted on 200
  assert.equal(stockBody0.stock, 0);
  assert.equal(stockBody0.inStock, false);
  assert.equal(stockMap.has('ACE-WHT-0'), true);
  assert.equal(stockMap.get('ACE-WHT-0'), 0);

  // 3) Unknown SKU returns found: false and does NOT pollute stockMap
  const stockResUnknown = await fetch(`${baseUrl}/api/stock/NO-SUCH-SKU-999`);
  const stockBodyUnknown = await stockResUnknown.json();
  assert.equal(stockBodyUnknown.found, false);
  assert.equal(stockBodyUnknown.inStock, false);
  assert.equal(stockMap.has('NO-SUCH-SKU-999'), false);

  // GAERU-004: Anonymous POST /api/checkout without CSRF/login returns 410 Gone and touches ZERO stock
  const legacyRes = await fetch(`${baseUrl}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'ACE-BLK-5', qty: 3 })
  });
  assert.equal(legacyRes.status, 410);
  assert.equal(stockMap.get('ACE-BLK-5'), 5);
  const dbAfterLegacy = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [varFive.id])).rows[0];
  assert.equal(dbAfterLegacy.stock_quantity, 5);

  // GAERU-005: Fractional qty = 1.9 rejected with 400 on /api/checkout, /api/orders, and cache.decrementStock
  assert.equal(reserveStock('ACE-BLK-5', 1.9).ok, false);
  assert.equal(stockMap.get('ACE-BLK-5'), 5);

  const fracCheckout = await fetch(`${baseUrl}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'ACE-BLK-5', qty: 1.9 })
  });
  assert.equal(fracCheckout.status, 400);

  let updateQueryExecuted = false;
  const origQuery = pool.query.bind(pool);
  pool.query = async (sql, values) => {
    if (/^\s*UPDATE\s+/i.test(String(sql))) updateQueryExecuted = true;
    return origQuery(sql, values);
  };
  try {
    const { jar, csrfToken } = await getCsrfSession(baseUrl);
    const fracOrder = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        Cookie: cookieHeader(jar)
      },
      body: JSON.stringify({
        customerName: 'Nguyễn Văn Lẻ',
        email: 'frac@gaeru.com',
        phone: '0912345678',
        address: '123 Nguyễn Trãi, Quận 1',
        city: 'Hồ Chí Minh',
        paymentMethod: 'cod',
        items: [{ variantId: varFive.id, quantity: 1.9 }]
      })
    });
    assert.equal(fracOrder.status, 400);
    assert.equal(updateQueryExecuted, false, 'Fractional quantity must be rejected before any SQL UPDATE');
  } finally {
    pool.query = origQuery;
  }
});

// =============================================================================
// GAERU-006: Sequential Discounts (Combo + Voucher + Loyalty Cap) & Gateway Min Amount
// =============================================================================
test('GAERU-006: Sequential discount cap (Combo -> Voucher -> GAERU Xu) prevents point over-burn and rejects <1 VND online payments atomically', async (t) => {
  const pool = await createPglitePool(t);

  let lastMomoPayload = null;
  const { baseUrl } = await startTestServer(t, pool, {
    paymentFetcher: async (_url, opts) => {
      lastMomoPayload = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          partnerCode: lastMomoPayload.partnerCode,
          orderId: lastMomoPayload.orderId,
          requestId: lastMomoPayload.requestId,
          amount: lastMomoPayload.amount,
          resultCode: 0,
          message: 'Thành công',
          payUrl: 'https://test-payment.momo.vn/pay/' + lastMomoPayload.orderId
        })
      };
    }
  });

  await seedPaymentConfig(pool, 'momo', {
    environment: 'sandbox',
    partnerCode: 'MOMO_GAERU_TEST',
    accessKey: 'access_test_123',
    secretKey: 'secret_test_1234567890'
  });
  await pool.query(
    "INSERT INTO store_settings (setting_key, setting_value) VALUES ('shipping_rates', $1::jsonb) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value",
    [JSON.stringify({ 'Hà Nội': 30000, 'Toàn quốc': 30000 })]
  );
  await pool.query(
    "INSERT INTO store_settings (setting_key, setting_value) VALUES ('shipping_rates', $1::jsonb) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value",
    [JSON.stringify({ 'Hà Nội': 30000, 'Toàn quốc': 30000 })]
  );

  // Seed shipping fee config: Hà Nội = 30,000đ (free over 5,000,000đ); Đà Nẵng = 0đ (when free threshold = 0 in test 6C/6D)
  await pool.query(
    `INSERT INTO store_settings (setting_key, setting_value)
     VALUES ('shipping_rates', $1::jsonb)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
    [JSON.stringify({ 'Hà Nội': 30000, 'Toàn quốc': 30000 })]
  );

  // Seed products & variants
  const mainWh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0];
  const prod = (await pool.query(
    "INSERT INTO products (name, slug, category, active) VALUES ('Loa GAERU Studio', 'loa-gaeru-studio', 'audio', true) RETURNING id"
  )).rows[0];
  const var100k = (await pool.query(
    "INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'STUDIO-100K', 'Bản Đơn', 100000, 30, true) RETURNING id",
    [prod.id]
  )).rows[0];
  const varAux100k = (await pool.query(
    "INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'STUDIO-AUX-100K', 'Phụ kiện Dây', 100000, 30, true) RETURNING id",
    [prod.id]
  )).rows[0];
  await pool.query(
    'INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 30), ($1, $3, 30)',
    [mainWh.id, var100k.id, varAux100k.id]
  );

  // Create active combo bundle: var100k (primary) + varAux100k (secondary) => fixed 40,000đ discount
  const bundle = (await pool.query(
    `INSERT INTO product_bundles (title, discount_type, discount_value, starts_at, ends_at, active)
     VALUES ('Combo Loa + Dây', 'fixed', 40000, now() - interval '1 day', now() + interval '7 days', true)
     RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO product_bundle_items (bundle_id, variant_id, is_primary, min_quantity)
     VALUES ($1, $2, true, 1), ($1, $3, false, 1)`,
    [bundle.id, var100k.id, varAux100k.id]
  );

  // Login a customer via valid RSA Google token and grant 200,000 GAERU Xu + vouchers
  const { jar, csrfToken: initCsrf } = await getCsrfSession(baseUrl);
  const loginRes = await fetch(`${baseUrl}/api/customer-auth/oauth/google`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': initCsrf,
      Cookie: cookieHeader(jar)
    },
    body: JSON.stringify({
      credential: signTestGoogleIdToken({
        sub: 'gaeru-006-buyer',
        email: 'loyalty006@gaeru.com',
        name: 'Khách Loyalty 006'
      })
    })
  });
  assert.equal(loginRes.status, 200);
  extractCookies(loginRes, jar);
  const loginBody = await loginRes.json();
  const csrfToken = loginBody.csrfToken;
  const customerId = loginBody.customer.id;

  await pool.query(
    `INSERT INTO customer_loyalty (customer_id, points_balance, lifetime_earned, tier)
     VALUES ($1, 200000, 200000, 'silver')
     ON CONFLICT (customer_id) DO UPDATE SET points_balance = 200000, lifetime_earned = 200000`,
    [customerId]
  );

  const v80 = (await pool.query(
    `INSERT INTO marketing_vouchers (code, title, kind, amount, min_spend_vnd, total_limit, per_customer_limit, starts_at, ends_at, active, public_claim)
     VALUES ('VOUCHER80K', 'Giảm 80K', 'fixed', 80000, 50000, 20, 10, now() - interval '1 day', now() + interval '7 days', true, true)
     RETURNING id`
  )).rows[0];
  const v100 = (await pool.query(
    `INSERT INTO marketing_vouchers (code, title, kind, amount, min_spend_vnd, total_limit, per_customer_limit, starts_at, ends_at, active, public_claim)
     VALUES ('VOUCHER100K', 'Giảm 100K', 'fixed', 100000, 50000, 20, 10, now() - interval '1 day', now() + interval '7 days', true, true)
     RETURNING id`
  )).rows[0];
  await pool.query(
    "INSERT INTO customer_vouchers (customer_id, voucher_id, source) VALUES ($1, $2, 'saved'), ($1, $3, 'saved')",
    [customerId, v80.id, v100.id]
  );

  // --- Combination 6A: subtotal 100k + voucher 80k + Xu requested 50k + ship 30k on MoMo ---
  // Remaining product subtotal after voucher = 20k => MUST burn ONLY 20k Xu (not 50k!), finalTotal = 30k >= 1
  const res6A = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Cookie: cookieHeader(jar)
    },
    body: JSON.stringify({
      customer: {
        name: 'Khách Loyalty 006',
        email: 'loyalty006@gaeru.com',
        phone: '0912345678',
        address: '12 Tràng Tiền, Hoàn Kiếm',
        city: 'Hà Nội'
      },
      paymentMethod: 'momo',
      voucherCode: 'VOUCHER80K',
      loyaltyPointsToRedeem: 50000,
      items: [{ variantId: var100k.id, quantity: 1 }]
    })
  });
  const body6A = await res6A.json();
  assert.equal(res6A.status, 201, JSON.stringify(body6A));
  assert.equal(body6A.order.totalVnd, 30000);
  assert.equal(body6A.order.discountVnd, 100000);
  assert.equal(body6A.order.loyaltyDiscountVnd, 20000, 'Must cap burned Xu to remaining 20,000 VND, never over-burning 50,000 Xu');
  assert.equal(Number(lastMomoPayload.amount), 30000);
  const balAfter6A = (await pool.query('SELECT points_balance FROM customer_loyalty WHERE customer_id = $1', [customerId])).rows[0].points_balance;
  assert.equal(balAfter6A, 180000); // 200,000 - 20,000 = 180,000

  // --- Combination 6B: subtotal 200k + combo 40k + voucher 100k + Xu requested 100k + ship 30k on MoMo ---
  // Remaining product subtotal after combo (40k) + voucher (100k) = 60k => MUST burn ONLY 60k Xu, finalTotal = 30k
  const res6B = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Cookie: cookieHeader(jar)
    },
    body: JSON.stringify({
      customer: {
        name: 'Khách Loyalty 006',
        email: 'loyalty006@gaeru.com',
        phone: '0912345678',
        address: '12 Tràng Tiền, Hoàn Kiếm',
        city: 'Hà Nội'
      },
      paymentMethod: 'momo',
      voucherCode: 'VOUCHER100K',
      loyaltyPointsToRedeem: 100000,
      items: [
        { variantId: var100k.id, quantity: 1 },
        { variantId: varAux100k.id, quantity: 1 }
      ]
    })
  });
  const body6B = await res6B.json();
  assert.equal(res6B.status, 201, JSON.stringify(body6B));
  assert.equal(body6B.order.discountVnd, 200000);
  assert.equal(body6B.order.loyaltyDiscountVnd, 60000);
  assert.equal(body6B.order.totalVnd, 30000);
  assert.equal(Number(lastMomoPayload.amount), 30000);
  const balAfter6B = (await pool.query('SELECT points_balance FROM customer_loyalty WHERE customer_id = $1', [customerId])).rows[0].points_balance;
  assert.equal(balAfter6B, 120000); // 180,000 - 60,000 = 120,000

  // Enable free shipping (ship = 0đ) to test finalTotal = 0 VND combinations (6C & 6D)
  await pool.query(
    `UPDATE store_settings SET setting_value = $1::jsonb WHERE setting_key = 'shipping_rates'`,
    [JSON.stringify({ 'Hà Nội': 0, 'Toàn quốc': 0 })]
  );

  // --- Combination 6C: subtotal 100k + voucher 80k + Xu 50k + ship 0đ on MoMo (finalTotal = 0 < 1) ---
  // MUST fail 400 BEFORE creating order, ledger, voucher_redemptions, payment_attempts, or deducting stock!
  const ordersBefore6C = (await pool.query('SELECT COUNT(*)::int AS cnt FROM orders')).rows[0].cnt;
  const stockBefore6C = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [var100k.id])).rows[0].stock_quantity;
  const redemptionsBefore6C = (await pool.query('SELECT COUNT(*)::int AS cnt FROM voucher_redemptions')).rows[0].cnt;

  const res6C = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Cookie: cookieHeader(jar)
    },
    body: JSON.stringify({
      customer: {
        name: 'Khách Loyalty 006',
        email: 'loyalty006@gaeru.com',
        phone: '0912345678',
        address: '12 Tràng Tiền, Hoàn Kiếm',
        city: 'Hà Nội'
      },
      paymentMethod: 'momo',
      voucherCode: 'VOUCHER80K',
      loyaltyPointsToRedeem: 50000,
      items: [{ variantId: var100k.id, quantity: 1 }]
    })
  });
  assert.equal(res6C.status, 400);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS cnt FROM orders')).rows[0].cnt, ordersBefore6C);
  assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [var100k.id])).rows[0].stock_quantity, stockBefore6C);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS cnt FROM voucher_redemptions')).rows[0].cnt, redemptionsBefore6C);
  assert.equal((await pool.query('SELECT points_balance FROM customer_loyalty WHERE customer_id = $1', [customerId])).rows[0].points_balance, 120000);

  // --- Combination 6D: same 0 VND finalTotal with COD succeeds and burns ONLY 20k Xu ---
  const res6D = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Cookie: cookieHeader(jar)
    },
    body: JSON.stringify({
      customer: {
        name: 'Khách Loyalty 006',
        email: 'loyalty006@gaeru.com',
        phone: '0912345678',
        address: '12 Tràng Tiền, Hoàn Kiếm',
        city: 'Hà Nội'
      },
      paymentMethod: 'cod',
      voucherCode: 'VOUCHER80K',
      loyaltyPointsToRedeem: 50000,
      items: [{ variantId: var100k.id, quantity: 1 }]
    })
  });
  const body6D = await res6D.json();
  assert.equal(res6D.status, 201, JSON.stringify(body6D));
  assert.equal(body6D.order.totalVnd, 0);
  assert.equal(body6D.order.loyaltyDiscountVnd, 20000);
  assert.equal((await pool.query('SELECT points_balance FROM customer_loyalty WHERE customer_id = $1', [customerId])).rows[0].points_balance, 100000);
});

// =============================================================================
// GAERU-009 & GAERU-010: Order Idempotency & Non-Blocking External Gateway Checkout
// =============================================================================
test('GAERU-009 & GAERU-010: Concurrent X-Idempotency-Key deduplication and zero DB row locks held during external MoMo gateway calls', async (t) => {
  const pool = await createPglitePool(t);

  let releaseSlowMomo = null;
  let momoEnteredResolve = null;
  const momoEntered = new Promise((resolve) => { momoEnteredResolve = resolve; });
  let shouldFailMomo = false;
  let momoCallCount = 0;

  const { baseUrl } = await startTestServer(t, pool, {
    paymentFetcher: async (_url, opts) => {
      momoCallCount += 1;
      const reqPayload = JSON.parse(opts.body);
      momoEnteredResolve?.();
      if (releaseSlowMomo) {
        await releaseSlowMomo;
      }
      if (shouldFailMomo) {
        return {
          ok: false,
          status: 503,
          text: async () => JSON.stringify({ resultCode: 99, message: 'MoMo sandbox timeout' })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          partnerCode: reqPayload.partnerCode,
          orderId: reqPayload.orderId,
          requestId: reqPayload.requestId,
          amount: reqPayload.amount,
          resultCode: 0,
          message: 'Success',
          payUrl: 'https://test-payment.momo.vn/pay/' + reqPayload.orderId
        })
      };
    }
  });

  await seedPaymentConfig(pool, 'momo', {
    environment: 'sandbox',
    partnerCode: 'MOMO_GAERU_TEST',
    accessKey: 'access_test_123',
    secretKey: 'secret_test_1234567890'
  });
  await pool.query(
    "INSERT INTO store_settings (setting_key, setting_value) VALUES ('shipping_rates', $1::jsonb) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value",
    [JSON.stringify({ 'Hà Nội': 30000, 'Toàn quốc': 30000 })]
  );

  const mainWh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0];
  const prod = (await pool.query(
    "INSERT INTO products (name, slug, category, active) VALUES ('Bàn phím GAERU K8', 'ban-phim-gaeru-k8', 'accessory', true) RETURNING id"
  )).rows[0];
  const variant = (await pool.query(
    "INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'K8-PRO', 'K8 Pro', 500000, 10, true) RETURNING id",
    [prod.id]
  )).rows[0];
  await pool.query(
    'INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 10)',
    [mainWh.id, variant.id]
  );

  // --- GAERU-009: Two concurrent POST /api/orders with same X-Idempotency-Key ---
  const { jar, csrfToken } = await getCsrfSession(baseUrl);
  const idemKey = 'idem-key-' + crypto.randomUUID();
  const payload = {
    customer: {
      name: 'Trần Văn Song Song',
      email: 'idem@gaeru.com',
      phone: '0987654321',
      address: '88 Láng Hạ, Đống Đa',
      city: 'Hà Nội'
    },
    paymentMethod: 'momo',
    items: [{ variantId: variant.id, quantity: 2 }]
  };

  const [r1, r2] = await Promise.all([
    fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        'X-Idempotency-Key': idemKey,
        Cookie: cookieHeader(jar)
      },
      body: JSON.stringify(payload)
    }),
    fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        'X-Idempotency-Key': idemKey,
        Cookie: cookieHeader(jar)
      },
      body: JSON.stringify(payload)
    })
  ]);

  const b1 = await r1.json();
  const b2 = await r2.json();
  assert.ok([200, 201].includes(r1.status), JSON.stringify(b1));
  assert.ok([200, 201].includes(r2.status), JSON.stringify(b2));
  assert.equal(b1.order?.orderNumber || b1.orderNumber, b2.order?.orderNumber || b2.orderNumber, 'Duplicate submit must return the exact same orderNumber');
  assert.equal(momoCallCount, 1, 'External payment gateway must only be called once for duplicate submit');

  const ordCount = (await pool.query("SELECT COUNT(*)::int AS cnt FROM orders WHERE email = 'idem@gaeru.com'")).rows[0].cnt;
  const attCount = (await pool.query('SELECT COUNT(*)::int AS cnt FROM payment_attempts WHERE order_id = $1', [b1.order?.id || b1.id])).rows[0].cnt;
  const stockAfterIdem = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0].stock_quantity;
  assert.equal(ordCount, 1, 'Must create strictly 1 order row');
  assert.equal(attCount, 1, 'Must create strictly 1 payment_attempts row');
  assert.equal(stockAfterIdem, 8, 'Stock must only be deducted once (10 - 2 = 8)');

  // Reusing same X-Idempotency-Key with different cart payload MUST fail 409
  const conflictRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      'X-Idempotency-Key': idemKey,
      Cookie: cookieHeader(jar)
    },
    body: JSON.stringify({ ...payload, items: [{ variantId: variant.id, quantity: 3 }] })
  });
  assert.equal(conflictRes.status, 409);

  // --- GAERU-010: Slow external MoMo call holds ZERO database locks on product_variants / pool ---
  let unblockMomo;
  releaseSlowMomo = new Promise((resolve) => { unblockMomo = resolve; });

  const { jar: jarA, csrfToken: csrfA } = await getCsrfSession(baseUrl);
  const slowMomoPromise = fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfA,
      Cookie: cookieHeader(jarA)
    },
    body: JSON.stringify({
      customer: {
        name: 'Khách MoMo Chậm',
        email: 'slowmomo@gaeru.com',
        phone: '0911223344',
        address: '100 Cầu Giấy',
        city: 'Hà Nội'
      },
      paymentMethod: 'momo',
      items: [{ variantId: variant.id, quantity: 1 }]
    })
  });

  // Wait until the server is actively inside the external MoMo HTTP call
  await momoEntered;

  // WHILE MoMo HTTP call is still hanging, a concurrent COD order on the EXACT SAME variant
  // MUST succeed immediately without blocking on FOR UPDATE or pool exhaustion!
  const { jar: jarB, csrfToken: csrfB } = await getCsrfSession(baseUrl);
  const fastCodRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfB,
      Cookie: cookieHeader(jarB)
    },
    body: JSON.stringify({
      customer: {
        name: 'Khách COD Nhanh',
        email: 'fastcod@gaeru.com',
        phone: '0922334455',
        address: '200 Kim Mã',
        city: 'Hà Nội'
      },
      paymentMethod: 'cod',
      items: [{ variantId: variant.id, quantity: 1 }]
    })
  });
  const fastCodBody = await fastCodRes.json();
  assert.equal(fastCodRes.status, 201, 'Concurrent COD order must finish while MoMo external HTTP call is still in-flight');
  assert.ok(fastCodBody.order?.orderNumber || fastCodBody.orderNumber);

  // Now let the slow MoMo HTTP call finish
  unblockMomo();
  const slowMomoRes = await slowMomoPromise;
  const slowMomoBody = await slowMomoRes.json();
  assert.equal(slowMomoRes.status, 201, JSON.stringify(slowMomoBody));
  assert.ok(slowMomoBody.paymentUrl.includes('momo.vn'));

  // Stock should now be 8 - 1 (MoMo) - 1 (COD) = 6
  const stockAfterBoth = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0].stock_quantity;
  assert.equal(stockAfterBoth, 6);

  // Furthermore, if external MoMo gateway rejects/fails, stock hold MUST be immediately restored to 6!
  releaseSlowMomo = null;
  shouldFailMomo = true;
  const failMomoRes = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfA,
      Cookie: cookieHeader(jarA)
    },
    body: JSON.stringify({
      customer: {
        name: 'Khách MoMo Lỗi',
        email: 'failmomo@gaeru.com',
        phone: '0933445566',
        address: '300 Giải Phóng',
        city: 'Hà Nội'
      },
      paymentMethod: 'momo',
      items: [{ variantId: variant.id, quantity: 2 }]
    })
  });
  assert.ok([502, 503].includes(failMomoRes.status));
  const stockAfterFailedGateway = (await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0].stock_quantity;
  assert.equal(stockAfterFailedGateway, 6, 'Failed external gateway call must immediately release held stock');
});

// =============================================================================
// BL-01..BL-07: Cross-Module Business Logic Regression Suite
// =============================================================================
test('BL-01..BL-07: Admin policy routing, real COD finance+loyalty settlement, forecast PO SQL, VietQR batch webhook, exchange vs return, and permanent order deletion', async (t) => {
  const pool = await createPglitePool(t);
  const { baseUrl, config } = await startTestServer(t, pool);

  // Login bootstrap admin
  const { jar, csrfToken: preCsrf } = await getCsrfSession(baseUrl);
  const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': preCsrf,
      Cookie: cookieHeader(jar)
    },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
  });
  assert.equal(adminLogin.status, 200);
  extractCookies(adminLogin, jar);
  const { csrfToken: adminCsrf } = await adminLogin.json();

  // Retired product-review routes must be unavailable even to an authenticated owner.
  // Valid CSRF/session credentials ensure a 404 is route removal, not an auth failure.
  for (const [method, retiredPath] of [
    ['GET', '/api/products/micro-gaeru-k9/reviews'],
    ['POST', '/api/products/micro-gaeru-k9/reviews'],
    ['POST', '/api/reviews/00000000-0000-0000-0000-000000000001/helpful'],
    ['GET', '/api/gaeru_ceo/product-reviews'],
    ['POST', '/api/gaeru_ceo/product-reviews/00000000-0000-0000-0000-000000000001/approve'],
    ['POST', '/api/gaeru_ceo/product-reviews/00000000-0000-0000-0000-000000000001/reject'],
    ['POST', '/api/gaeru_ceo/product-reviews/00000000-0000-0000-0000-000000000001/reply'],
    ['DELETE', '/api/gaeru_ceo/product-reviews/00000000-0000-0000-0000-000000000001'],
    ['GET', '/gaeru_ceo/assets/product-reviews.js']
  ]) {
    const r = await fetch(`${baseUrl}${retiredPath}`, {
      method,
      headers: { Cookie: cookieHeader(jar), 'X-CSRF-Token': adminCsrf }
    });
    assert.equal(r.status, 404, `${method} ${retiredPath} must be removed`);
  }
  const reviewTables = await pool.query(`SELECT to_regclass('product_reviews') AS reviews,
    to_regclass('product_review_helpful_votes') AS votes,
    to_regclass('archived_product_reviews') AS archive`);
  assert.deepEqual(reviewTables.rows[0], { reviews: null, votes: null, archive: null });

  // 1. BL-01: Previously blocked admin routes now pass adminPolicy and return 200
  for (const adminPath of [
    '/api/gaeru_ceo/barcode/history',
    '/api/gaeru_ceo/marketplace/orders',
    '/api/gaeru_ceo/forecast?days=30',
    '/api/gaeru_ceo/marketing/abandoned-carts',
    '/api/gaeru_ceo/cod-returns/pending'
  ]) {
    const r = await fetch(`${baseUrl}${adminPath}`, {
      headers: { Cookie: cookieHeader(jar) }
    });
    assert.equal(r.status, 200, `Admin route ${adminPath} must return 200 instead of 404 from adminPolicy`);
  }

  // 2. BL-03: Real PostgreSQL createPurchaseOrderFromForecast (merges duplicate variantId & uses valid columns) + getIncomingStockMap
  const mainWh = (await pool.query("SELECT id FROM warehouses WHERE code = 'MAIN'")).rows[0];
  const supplier = (await pool.query(
    "INSERT INTO suppliers (code, name, active) VALUES ('SUP-GAERU', 'Nhà máy GAERU', true) RETURNING id"
  )).rows[0];
  const prod = (await pool.query(
    "INSERT INTO products (name, slug, category, active) VALUES ('Micro GAERU M9', 'micro-gaeru-m9', 'audio', true) RETURNING id"
  )).rows[0];
  const variant = (await pool.query(
    "INSERT INTO product_variants (product_id, sku, name, price_vnd, cost_price_vnd, stock_quantity, active) VALUES ($1, 'M9-PRO', 'M9 Pro', 600000, 300000, 10, true) RETURNING id",
    [prod.id]
  )).rows[0];
  await pool.query(
    'INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 10)',
    [mainWh.id, variant.id]
  );

  const poRes = await createPurchaseOrderFromForecast(pool, {
    supplierId: supplier.id,
    warehouseId: mainWh.id,
    items: [
      { variantId: variant.id, quantity: 4, unitCostVnd: 300000 },
      { variantId: variant.id, quantity: 6, unitCostVnd: 300000 }
    ],
    actor: { username: ADMIN_USERNAME }
  });
  assert.equal(poRes.itemsCount, 1);
  assert.equal(poRes.totalVnd, 3000000);

  const forecastRes = await calculateInventoryForecast(pool, { warehouseId: mainWh.id, days: 30, useCache: false });
  const forecastItem = forecastRes.items.find((i) => i.variantId === variant.id);
  assert.ok(forecastItem);
  assert.equal(forecastItem.incomingStock, 10, 'getIncomingStockMap must read poi.quantity - poi.received_quantity from real DB');

  // 3. BL-02: Unpaid prepaid order blocked from createWaybill (409); COD delivered webhook works with real finance.recordFullOrderPayment & awards Xu
  const cust = (await pool.query(
    "INSERT INTO customers (email, full_name, phone, active) VALUES ('codbuyer@gaeru.com', 'Khách COD', '0911000111', true) RETURNING id"
  )).rows[0];
  const unpaidPrepaid = (await pool.query(
    `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
     VALUES ('GR-PREPAID-UNPAID', $1, 'Khách COD', 'codbuyer@gaeru.com', '0911000111', '12 Lê Lợi', 'Hà Nội', 'bank_transfer', 'pending', 'confirmed', 600000, 600000)
     RETURNING id`,
    [cust.id]
  )).rows[0];
  await assert.rejects(
    () => createWaybill(pool, config, { orderId: unpaidPrepaid.id, carrierId: 'jt', actor: { username: ADMIN_USERNAME } }),
    (err) => err.status === 409
  );

  const codOrder = (await pool.query(
    `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
     VALUES ('GR-COD-REAL-FIN', $1, 'Khách COD', 'codbuyer@gaeru.com', '0911000111', '12 Lê Lợi', 'Hà Nội', 'cod', 'pending', 'processing', 500000, 500000)
     RETURNING id`,
    [cust.id]
  )).rows[0];
  await pool.query(
    `INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, carrier_order_id, status, cod_amount_vnd)
     VALUES ($1, 'viettel', 'VT-REAL-FIN-01', 'GR-COD-REAL-FIN', 'delivering', 500000)`,
    [codOrder.id]
  );

  const carrierWebhookSecret = 'fixture-viettel-webhook-authentication-secret';
  await pool.query("INSERT INTO store_settings(setting_key,setting_value) VALUES('private_admin:shipping_viettel',$1) ON CONFLICT(setting_key) DO UPDATE SET setting_value=$1", [JSON.stringify({version:1,cipher:seal(JSON.stringify({secret:'fixture-viettel-token',webhookSecret:carrierWebhookSecret}),process.env.AUTH_ENCRYPTION_KEY||config.SESSION_SECRET)})]);
  const whRes = await handleCarrierWebhook(pool, config, 'viettel', {
    ORDER_NUMBER: 'VT-REAL-FIN-01',
    ORDER_STATUS: 'delivered',
    desc: 'Giao thành công & thu hộ COD'
  }, { finance: { receiptTotal, recordFullOrderPayment }, headers:{'x-webhook-secret':carrierWebhookSecret} });
  assert.equal(whRes.success, true);
  assert.equal(await receiptTotal(pool, codOrder.id), 0, 'Delivered COD webhook must not create receipt before settlement');

  const { settleCarrierCod } = require('../src/shipping-management');
  await settleCarrierCod(pool, {
    orderId: codOrder.id,
    providerTransactionRef: 'VTP-STATEMENT-20261107-01',
    settledAmountVnd: 500000,
    actor: { username: ADMIN_USERNAME, role: 'owner', source: 'bootstrap' },
    finance: { receiptTotal, recordFullOrderPayment }
  });

  const settledCod = (await pool.query('SELECT status, payment_status FROM orders WHERE id = $1', [codOrder.id])).rows[0];
  assert.equal(settledCod.status, 'completed');
  assert.equal(settledCod.payment_status, 'paid');
  const receiptSum = await receiptTotal(pool, codOrder.id);
  assert.equal(receiptSum, 500000, 'Real finance.recordFullOrderPayment must record 500,000 VND sales_receipt');
  const earnedLoyalty = (await pool.query('SELECT points_balance FROM customer_loyalty WHERE customer_id = $1', [cust.id])).rows[0];
  assert.equal(earnedLoyalty.points_balance, 5000, 'COD settlement must award 1% GAERU Xu');

  // 4. BL-04: VietQR bank transfer webhook batch with 2 transactions settles BOTH orders
  await seedPaymentConfig(pool, 'bank_transfer', {
    bankBin: '970436',
    bankName: 'Vietcombank',
    accountNumber: '0123456789',
    accountHolder: 'CONG TY GAERU',
    webhookSecret: 'vietqr-webhook-secret-2026'
  });

  const bt1 = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
     VALUES ('GR-20261102-BT001', 'Khách QR 1', 'qr1@gaeru.com', '0900111222', '1 Phố Huế', 'Hà Nội', 'bank_transfer', 'pending', 'pending', 250000, 250000)
     RETURNING id`
  )).rows[0];
  const bt2 = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, total_vnd)
     VALUES ('GR-20261102-BT002', 'Khách QR 2', 'qr2@gaeru.com', '0900111333', '2 Phố Huế', 'Hà Nội', 'bank_transfer', 'pending', 'pending', 380000, 380000)
     RETURNING id`
  )).rows[0];

  const batchWebhook = await fetch(`${baseUrl}/api/payments/bank_transfer/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Apikey vietqr-webhook-secret-2026'
    },
    body: JSON.stringify({
      error: 0,
      data: [
        { id: 901, tid: 'TID-BT-001', description: 'Thanh toan GR-20261102-BT001', amount: 250000, when: '2026-11-02 22:00:00' },
        { id: 902, tid: 'TID-BT-002', description: 'Chuyen khoan GR-20261102-BT002', amount: 380000, when: '2026-11-02 22:00:05' }
      ]
    })
  });
  const batchBody = await batchWebhook.json();
  assert.equal(batchWebhook.status, 200);
  assert.equal(batchBody.matchedCount, 2, 'Batch bank webhook must reconcile BOTH transactions');
  assert.equal((await pool.query('SELECT payment_status, status FROM orders WHERE id = $1', [bt1.id])).rows[0].payment_status, 'paid');
  assert.equal((await pool.query('SELECT payment_status, status FROM orders WHERE id = $1', [bt2.id])).rows[0].payment_status, 'paid');

  // 5. BL-06: Exchange closure requires a linked inventory issue workflow.
  const exchCase = (await pool.query(
    `INSERT INTO order_after_sales (order_id, kind, return_type, status, reason, requested_by)
     VALUES ($1, 'return', 'exchange', 'received', 'Đổi màu sản phẩm 1:1', 'customer')
     RETURNING id, version`,
    [codOrder.id]
  )).rows[0];
  const resolveExch = await fetch(`${baseUrl}/api/gaeru_ceo/orders/after-sales/${exchCase.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': adminCsrf,
      Cookie: cookieHeader(jar)
    },
    body: JSON.stringify({
      version: exchCase.version,
      status: 'resolved',
      resolution: 'Đã gửi sản phẩm đổi mới 1:1 cho khách hàng'
    })
  });
  assert.equal(resolveExch.status, 409);
  assert.equal((await pool.query('SELECT status FROM order_after_sales WHERE id=$1', [exchCase.id])).rows[0].status, 'received');
  const afterExchOrder = (await pool.query('SELECT return_completed_at FROM orders WHERE id = $1', [codOrder.id])).rows[0];
  assert.equal(afterExchOrder.return_completed_at, null, '1:1 exchange must NOT mark order as return_completed_at');

  // 6. BL-05: Omnichannel stock deduction keeps warehouse_stock & product_variants synchronized + rejects unsigned webhook; permanent order deletion cleans carrier_shipments without FK 23503
  await withTransaction(pool, async (client) => {
    await ingestMarketplaceOrder(client, {
      channel: 'shopee',
      shopId: 'SHOP_SYNC',
      order: {
        externalOrderId: 'SPX-WH-SYNC-1',
        rawStatus: 'PROCESSING',
        items: [{ externalSku: 'M9-PRO', quantity: 3 }]
      },
      autoDeductStock: true
    });
  });
  assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0].stock_quantity, 7);
  assert.equal((await pool.query('SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2', [mainWh.id, variant.id])).rows[0].quantity, 7);

  for (let i=0;i<2;i++) await assert.rejects(() => handleMarketplaceWebhook(pool, config, 'shopee', {
    shop_id: 'SHOP_SYNC', event_id: 'EVT-SHOPEE-100',
    data: { order_sn: 'SPX-WH-SYNC-1', status: 'SHIPPED', items: [{ externalSku: 'M9-PRO', quantity: 3 }] }
  }), err => err.status===501);
  assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[variant.id])).rows[0].stock_quantity,7,'Unsigned callbacks cannot deduct again');

  // P0-02: Permanent deletion of settled codOrder with sales_receipts MUST be blocked (409) to preserve ledger
  await assert.rejects(
    () => withTransaction(pool, (client) => deleteOrderPermanently(client, codOrder.id, { actor: { username: ADMIN_USERNAME } })),
    (err) => err.status === 409
  );
  assert.equal(await receiptTotal(pool, codOrder.id), 500000, 'Immutable sales_receipt must remain intact');

  // Unpaid order with cancelled carrier_shipments and pack verifications deletes cleanly without FK 23503
  await pool.query(
    `INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status)
     VALUES ($1, 'jt', 'JT-CANCELLED-01', 'cancelled', 0, 'not_applicable')`,
    [unpaidPrepaid.id]
  );
  await pool.query(
    `INSERT INTO order_pack_verifications (order_id, status, total_items, scanned_items)
     VALUES ($1, 'dispatched', 1, 1)`,
    [unpaidPrepaid.id]
  );
  await withTransaction(pool, async (client) => {
    const deleted = await deleteOrderPermanently(client, unpaidPrepaid.id, { actor: { username: ADMIN_USERNAME } });
    assert.ok(deleted);
  });
  assert.equal((await pool.query('SELECT COUNT(*)::int AS cnt FROM orders WHERE id = $1', [unpaidPrepaid.id])).rows[0].cnt, 0);
});
