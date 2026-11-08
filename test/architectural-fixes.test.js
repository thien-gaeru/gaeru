const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { signGuestTrackingToken } = require('../src/shipping-management');
const GAERUAnalytics = require('../google-analytics');

const baseConfig = {
  DATABASE_URL: 'postgres://localhost/gaeru',
  SESSION_SECRET: 'test-session-secret-for-architectural-fixes-32chars',
  ADMIN_USERNAME: 'manager',
  ADMIN_PASSWORD_HASH: bcrypt.hashSync('test-password', 4)
};

test('Fix 1 & 4: GA4 trackPurchase normalizes item revenue, shipping and tax without double counting shipping in value', () => {
  const events = [];
  globalThis.dataLayer = [];
  globalThis.gtag = function(...args) {
    events.push(args);
  };

  const fakeSessionStorage = new Map();
  const fakeLocalStorage = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => fakeSessionStorage.get(k) || null,
    setItem: (k, v) => fakeSessionStorage.set(k, v)
  };
  globalThis.localStorage = {
    getItem: (k) => fakeLocalStorage.get(k) || null,
    setItem: (k, v) => fakeLocalStorage.set(k, v)
  };

  const order = {
    orderNumber: 'GAERU-NORM-001',
    totalVnd: 720000,
    shippingFeeVnd: 30000,
    subtotalVnd: 690000,
    taxVnd: 0,
    items: [
      { variantId: 'k9-typec', name: 'Micro GAERU K9', priceVnd: 690000, quantity: 1 }
    ]
  };

  GAERUAnalytics.trackPurchase(order);

  const purchaseEvent = events.find(e => e[0] === 'event' && e[1] === 'purchase');
  assert.ok(purchaseEvent, 'purchase event must be emitted');
  const params = purchaseEvent[2];
  assert.equal(params.transaction_id, 'GAERU-NORM-001');
  assert.equal(params.value, 690000, 'value must be pure item revenue (subtotal), NOT including shipping');
  assert.equal(params.shipping, 30000, 'shipping must be separate');
  assert.equal(params.tax, 0);
  assert.equal(params.items.length, 1);
});

test('Fix 3: GET /api/payments/order-status requires valid signed token or session ownership', async (context) => {
  const app = createApp({
    config: {
      ...baseConfig,
      NODE_ENV: 'test',
      PORT: 0
    },
    pool: {
      query: async (sql, values) => {
        if (typeof sql === 'string' && sql.includes('FROM orders WHERE order_number = $1')) {
          return {
            rows: [{
              id: 888,
              orderNumber: 'GAERU-SEC-001',
              customerId: 'cust-uuid-1',
              status: 'confirmed',
              paymentMethod: 'bank_transfer',
              paymentStatus: 'paid',
              totalVnd: 500000,
              shippingFeeVnd: 30000,
              subtotalVnd: 470000,
              updatedAt: new Date().toISOString()
            }]
          };
        }
        if (typeof sql === 'string' && sql.includes('FROM order_items WHERE order_id = $1')) {
          return {
            rows: [{
              sku: 'K9-BOX',
              name: 'Micro GAERU K9',
              variantName: 'Hộp sạc',
              quantity: 1,
              priceVnd: 470000,
              totalVnd: 470000
            }]
          };
        }
        return { rows: [] };
      }
    },
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 1. Unauthenticated and unsigned -> 401
  const unauthRes = await fetch(`${baseUrl}/api/payments/order-status?order=GAERU-SEC-001`);
  assert.equal(unauthRes.status, 401);
  const unauthJson = await unauthRes.json();
  assert.match(unauthJson.error, /mã xác thực/i);

  // 2. Tampered / invalid token -> 401
  const invalidTokenRes = await fetch(`${baseUrl}/api/payments/order-status?order=GAERU-SEC-001&token=invalid.signature`);
  assert.equal(invalidTokenRes.status, 401);

  // 3. Valid signed token -> 200 with full details
  const validToken = signGuestTrackingToken(baseConfig, 'GAERU-SEC-001');
  const validRes = await fetch(`${baseUrl}/api/payments/order-status?order=GAERU-SEC-001&token=${encodeURIComponent(validToken)}`);
  assert.equal(validRes.status, 200);
  const validJson = await validRes.json();
  assert.ok(validJson.order);
  assert.equal(validJson.order.orderNumber, 'GAERU-SEC-001');
  assert.equal(validJson.order.items.length, 1);
  assert.equal(validJson.order.totalVnd, 500000);
});

test('Fix 5: Google OAuth pending link does NOT leak email in URL and can be fetched via /api/customer-auth/oauth/pending-link', async (context) => {
  const app = createApp({
    config: {
      ...baseConfig,
      NODE_ENV: 'test',
      PORT: 0
    },
    pool: { query: async () => ({ rows: [] }) },
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 1. Initial pending-link without session returns pending: false
  const emptyRes = await fetch(`${baseUrl}/api/customer-auth/oauth/pending-link`);
  assert.equal(emptyRes.status, 200);
  const emptyJson = await emptyRes.json();
  assert.equal(emptyJson.pending, false);

  // 2. GET /account/link-required redirects to /account.html?linkRequired=1 WITHOUT email query
  const linkReqRes = await fetch(`${baseUrl}/account/link-required?email=secret.user%40gmail.com`, {
    redirect: 'manual'
  });
  assert.equal(linkReqRes.status, 303);
  const loc = linkReqRes.headers.get('location');
  assert.equal(loc, '/account.html?linkRequired=1');
  assert.ok(!loc.includes('secret.user'), 'Email must NOT be present in redirect location');

  // Verify cookie was set and session stores the pending link
  const cookieHeaders = linkReqRes.headers.getSetCookie ? linkReqRes.headers.getSetCookie() : [linkReqRes.headers.get('set-cookie')];
  const cookie = (cookieHeaders.filter(Boolean)[0] || '').split(';')[0];
  assert.ok(cookie, 'Session cookie must be established');

  const pendingRes = await fetch(`${baseUrl}/api/customer-auth/oauth/pending-link`, {
    headers: { Cookie: cookie }
  });
  assert.equal(pendingRes.status, 200);
  const pendingJson = await pendingRes.json();
  assert.equal(pendingJson.pending, true);
  assert.equal(pendingJson.email, 'secret.user@gmail.com');
  assert.equal(pendingJson.provider, 'google');
});
