const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { createApp } = require("../src/app");
const { loadConfig } = require("../src/config");
const GAERUAnalytics = require("../google-analytics");

const baseConfig = {
  DATABASE_URL: "postgres://localhost/gaeru",
  SESSION_SECRET: "a-session-secret-with-at-least-32-chars",
  ADMIN_USERNAME: "manager",
  ADMIN_PASSWORD_HASH: bcrypt.hashSync("test-password", 4)
};

test("Google Analytics: config schema validates and loads measurement ID", () => {
  // 1. Default when omitted
  const conf1 = loadConfig(baseConfig);
  assert.equal(conf1.GA_MEASUREMENT_ID, undefined);

  // 2. Explicit GA_MEASUREMENT_ID
  const conf2 = loadConfig({
    ...baseConfig,
    GA_MEASUREMENT_ID: "G-ABC1234XYZ"
  });
  assert.equal(conf2.GA_MEASUREMENT_ID, "G-ABC1234XYZ");

  // 3. Fallback GOOGLE_ANALYTICS_ID alias
  const conf3 = loadConfig({
    ...baseConfig,
    GOOGLE_ANALYTICS_ID: "G-9876543210"
  });
  assert.equal(conf3.GA_MEASUREMENT_ID, "G-9876543210");

  // 4. Empty string is normalized to undefined
  const conf4 = loadConfig({
    ...baseConfig,
    GA_MEASUREMENT_ID: ""
  });
  assert.equal(conf4.GA_MEASUREMENT_ID, undefined);

  // 5. Invalid format is rejected
  assert.throws(() => loadConfig({
    ...baseConfig,
    GA_MEASUREMENT_ID: "UA-12345-1" // Legacy Universal Analytics not allowed
  }), /Invalid environment configuration/);

  assert.throws(() => loadConfig({
    ...baseConfig,
    GA_MEASUREMENT_ID: "invalid-id"
  }), /Invalid environment configuration/);
});

test("Google Analytics: Content Security Policy includes Google Analytics and Tag Manager domains", async (context) => {
  const app = createApp({
    config: {
      ...baseConfig,
      NODE_ENV: "test",
      PORT: 0
    },
    pool: { query: async () => ({ rows: [] }) },
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);

  const csp = res.headers.get("content-security-policy");
  assert.ok(csp, "CSP header must be present");

  // Script-src checks
  const scriptMatch = csp.match(/script-src\s+([^;]+)/);
  assert.ok(scriptMatch, "script-src directive must exist");
  assert.ok(scriptMatch[1].includes("https://www.googletagmanager.com"), "script-src must include www.googletagmanager.com");
  assert.ok(scriptMatch[1].includes("https://*.googletagmanager.com"), "script-src must include *.googletagmanager.com");
  assert.ok(!scriptMatch[1].includes("'unsafe-inline'"), "script-src must not allow unsafe-inline");

  // Connect-src checks
  const connectMatch = csp.match(/connect-src\s+([^;]+)/);
  assert.ok(connectMatch, "connect-src directive must exist");
  assert.ok(connectMatch[1].includes("https://*.google-analytics.com"), "connect-src must include *.google-analytics.com");
  assert.ok(connectMatch[1].includes("https://google-analytics.com"), "connect-src must include apex google-analytics.com");
  assert.ok(connectMatch[1].includes("https://*.analytics.google.com"), "connect-src must include *.analytics.google.com");
  assert.ok(connectMatch[1].includes("https://*.googletagmanager.com"), "connect-src must include *.googletagmanager.com");

  // Img-src checks
  const imgMatch = csp.match(/img-src\s+([^;]+)/);
  assert.ok(imgMatch, "img-src directive must exist");
  assert.ok(imgMatch[1].includes("https://*.google-analytics.com"), "img-src must include *.google-analytics.com");
  assert.ok(imgMatch[1].includes("https://*.googletagmanager.com"), "img-src must include *.googletagmanager.com");
});

test("Google Analytics: /api/settings/public returns gaMeasurementId", async (context) => {
  // Test with environment fallback
  const app = createApp({
    config: {
      ...baseConfig,
      NODE_ENV: "test",
      PORT: 0,
      GA_MEASUREMENT_ID: "G-ENVTEST123"
    },
    pool: {
      query: async (sql, values) => {
        return { rows: [] };
      }
    },
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${baseUrl}/api/settings/public`);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.gaMeasurementId, "G-ENVTEST123");
});

test("Google Analytics: /api/settings/public prefers database store_settings over environment", async (context) => {
  const app = createApp({
    config: {
      ...baseConfig,
      NODE_ENV: "test",
      PORT: 0,
      GA_MEASUREMENT_ID: "G-ENVTEST123"
    },
    pool: {
      query: async (sql, values) => {
        if (typeof sql === "string" && sql.includes("store_settings")) {
          if (Array.isArray(values?.[0]) && values[0].includes("ga_measurement_id")) {
            return {
              rows: [
                { setting_key: "ga_measurement_id", setting_value: "G-DBOVERRIDE456" }
              ]
            };
          }
          return { rows: [] };
        }
        return { rows: [] };
      }
    },
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${baseUrl}/api/settings/public`);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.gaMeasurementId, "G-DBOVERRIDE456");
});

test("Google Analytics: CEO admin endpoints manage measurement ID", async (context) => {
  let storedSettings = new Map();
  const queries = [];

  const pool = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      if (typeof sql === "string" && sql.includes("SELECT") && sql.includes("store_settings")) {
        if (typeof sql === "string" && sql.includes("setting_key = ANY")) {
          const keys = values?.[0] || [];
          const rows = [];
          for (const k of keys) {
            if (storedSettings.has(k)) {
              rows.push({ setting_key: k, setting_value: storedSettings.get(k) });
            }
          }
          return { rows };
        }
        return { rows: [] };
      }
      if (typeof sql === "string" && sql.includes("INSERT INTO store_settings")) {
        storedSettings.set(values[0], JSON.parse(values[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    connect: async () => ({
      query: async (sql, values) => pool.query(sql, values),
      release: () => {}
    })
  };

  const app = createApp({
    config: {
      ...baseConfig,
      NODE_ENV: "test",
      PORT: 0,
      GA_MEASUREMENT_ID: "G-DEFAULT123"
    },
    pool,
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 1. Unauthenticated request to /api/gaeru_ceo/google-analytics is rejected (401)
  const unauthRes = await fetch(`${baseUrl}/api/gaeru_ceo/google-analytics`);
  assert.equal(unauthRes.status, 401);

  // 2. Fetch CSRF token for login
  const csrfRes = await fetch(`${baseUrl}/api/csrf`);
  const csrfCookies = csrfRes.headers.getSetCookie ? csrfRes.headers.getSetCookie() : [csrfRes.headers.get("set-cookie")];
  const { csrfToken } = await csrfRes.json();
  const initCookie = csrfCookies.map(c => c.split(";")[0]).join("; ");

  // 3. Authenticate admin
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      Cookie: initCookie
    },
    body: JSON.stringify({ username: "manager", password: "test-password" })
  });
  assert.equal(loginRes.status, 200);

  const loginCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get("set-cookie")];
  const authedCookie = loginCookies.map(c => c.split(";")[0]).join("; ");
  const loginBody = await loginRes.json();
  const authedCsrfToken = loginBody.csrfToken;

  // 4. GET /api/gaeru_ceo/google-analytics returns env default initially
  const getRes = await fetch(`${baseUrl}/api/gaeru_ceo/google-analytics`, {
    headers: { Cookie: authedCookie }
  });
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  assert.equal(getData.gaMeasurementId, "G-DEFAULT123");
  assert.equal(getData.configured, true);
  assert.equal(getData.source, "environment");

  // 5. PUT invalid ID is rejected
  const invalidPut = await fetch(`${baseUrl}/api/gaeru_ceo/google-analytics`, {
    method: "PUT",
    headers: {
      Cookie: authedCookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": authedCsrfToken
    },
    body: JSON.stringify({ gaMeasurementId: "invalid_format" })
  });
  assert.equal(invalidPut.status, 400);

  // 6. PUT valid ID updates store_settings
  const validPut = await fetch(`${baseUrl}/api/gaeru_ceo/google-analytics`, {
    method: "PUT",
    headers: {
      Cookie: authedCookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": authedCsrfToken
    },
    body: JSON.stringify({ gaMeasurementId: "G-NEWMEASUREMENT99" })
  });
  assert.equal(validPut.status, 200);
  const putData = await validPut.json();
  assert.equal(putData.gaMeasurementId, "G-NEWMEASUREMENT99");
  assert.equal(putData.configured, true);

  // 7. Verify subsequent GET reflects the database update
  const getAfterRes = await fetch(`${baseUrl}/api/gaeru_ceo/google-analytics`, {
    headers: { Cookie: authedCookie }
  });
  assert.equal(getAfterRes.status, 200);
  const getAfterData = await getAfterRes.json();
  assert.equal(getAfterData.gaMeasurementId, "G-NEWMEASUREMENT99");
  assert.equal(getAfterData.source, "database");

  // 8. Verify /api/settings/public now returns the newly saved ID
  const publicRes = await fetch(`${baseUrl}/api/settings/public`);
  assert.equal(publicRes.status, 200);
  const publicData = await publicRes.json();
  assert.equal(publicData.gaMeasurementId, "G-NEWMEASUREMENT99");
});

test("Google Analytics: client helper formats events and deduplicates purchases", () => {
  const events = [];
  globalThis.dataLayer = [];
  globalThis.gtag = function(...args) {
    events.push(args);
  };

  // Test event tracking
  GAERUAnalytics.trackEvent("custom_event", { test_key: "value" });
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "event");
  assert.equal(events[0][1], "custom_event");
  assert.deepEqual(events[0][2], { test_key: "value" });

  // Test view_item
  GAERUAnalytics.trackViewItem(
    { name: "GAERU K9", category: "Micro không dây", priceVnd: 690000, slug: "gaeru-k9" },
    { id: "k9-lightning", sku: "K9-LT", name: "Lightning", priceVnd: 690000 }
  );
  assert.equal(events[1][1], "view_item");
  assert.equal(events[1][2].currency, "VND");
  assert.equal(events[1][2].value, 690000);
  assert.equal(events[1][2].items[0].item_id, "k9-lightning");

  // Test add_to_cart
  GAERUAnalytics.trackAddToCart({
    variantId: "k9-typec",
    name: "GAERU K9 - Type-C",
    category: "Micro không dây",
    priceVnd: 690000,
    quantity: 2
  });
  assert.equal(events[2][1], "add_to_cart");
  assert.equal(events[2][2].value, 1380000);
  assert.equal(events[2][2].items[0].quantity, 2);

  // Test begin_checkout
  GAERUAnalytics.trackBeginCheckout([
    { variantId: "k9-typec", name: "GAERU K9", priceVnd: 690000, quantity: 2 }
  ], 1380000);
  assert.equal(events[3][1], "begin_checkout");
  assert.equal(events[3][2].value, 1380000);

  // Test purchase and deduplication
  const fakeSessionStorage = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => fakeSessionStorage.get(k) || null,
    setItem: (k, v) => fakeSessionStorage.set(k, v)
  };

  const order = {
    orderNumber: "GAERU-TEST-9999",
    totalVnd: 1410000,
    shippingFeeVnd: 30000,
    items: [
      { variantId: "k9-typec", name: "GAERU K9", priceVnd: 690000, quantity: 2 }
    ]
  };

  // First track call -> fires purchase event
  GAERUAnalytics.trackPurchase(order);
  assert.equal(events[4][1], "purchase");
  assert.equal(events[4][2].transaction_id, "GAERU-TEST-9999");
  assert.equal(events[4][2].value, 1380000);
  assert.equal(events[4][2].shipping, 30000);

  // Second track call with same order -> deduplicated, does NOT fire
  const countBefore = events.length;
  GAERUAnalytics.trackPurchase(order);
  assert.equal(events.length, countBefore, "Duplicate purchase event must be blocked by deduplication");
});

test("Google Analytics: all 32 storefront HTML files include google-analytics.js", () => {
  const dir = path.resolve(__dirname, "..");
  const htmlFiles = fs.readdirSync(dir).filter(f => f.endsWith(".html"));
  assert.equal(htmlFiles.length, 32, "Should have 32 storefront HTML files");

  for (const file of htmlFiles) {
    const content = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(
      content.includes('<script src="/google-analytics.js" defer></script>'),
      `${file} must include <script src="/google-analytics.js" defer></script>`
    );
  }
});


test("Google Analytics: URL sanitization strips tokens and sensitive query parameters", () => {
  const dirtyUrl1 = "https://gaeru.vn/account.html?token=super-secret-token&email=user%40example.com&ref=homepage";
  const cleanUrl1 = GAERUAnalytics.sanitizeUrl(dirtyUrl1);
  assert.ok(!cleanUrl1.includes("super-secret-token"), "Token must be stripped");
  assert.ok(!cleanUrl1.includes("user%40example.com"), "Email must be stripped");
  assert.ok(cleanUrl1.includes("token=%5BREDACTED%5D") || cleanUrl1.includes("token=[REDACTED]"), "Token replaced by [REDACTED]");
  assert.ok(cleanUrl1.includes("ref=homepage"), "Safe params preserved");

  const dirtyPath = "/tai-khoan?verify=123456&contactVerify=abcdef&action=view";
  const cleanPath = GAERUAnalytics.sanitizeUrl(dirtyPath);
  assert.ok(!cleanPath.includes("123456"));
  assert.ok(!cleanPath.includes("abcdef"));
  assert.ok(cleanPath.includes("action=view"));
});

test("Google Analytics: Enhanced Ecommerce supports trackRemoveFromCart, trackRefund, and Consent Mode v2", () => {
  const events = [];
  globalThis.dataLayer = [];
  globalThis.gtag = function(...args) {
    events.push(args);
  };

  // Test remove_from_cart
  GAERUAnalytics.trackRemoveFromCart({
    variantId: "k9-typec",
    name: "GAERU K9",
    category: "Micro",
    priceVnd: 690000,
    quantity: 1
  });
  const removeEvt = events.find(e => e[0] === "event" && e[1] === "remove_from_cart");
  assert.ok(removeEvt, "remove_from_cart event must be emitted");
  assert.equal(removeEvt[2].value, 690000);
  assert.equal(removeEvt[2].items[0].item_id, "k9-typec");

  // Test refund
  GAERUAnalytics.trackRefund({
    orderNumber: "GAERU-REFUND-101",
    totalVnd: 690000,
    items: [{ variantId: "k9-typec", name: "GAERU K9", priceVnd: 690000, quantity: 1 }]
  });
  const refundEvt = events.find(e => e[0] === "event" && e[1] === "refund");
  assert.ok(refundEvt, "refund event must be emitted");
  assert.equal(refundEvt[2].transaction_id, "GAERU-REFUND-101");
  assert.equal(refundEvt[2].value, 690000);

  // Test init sets consent mode default
  globalThis.document = {
    head: { appendChild: () => {} },
    querySelector: () => null,
    createElement: () => ({})
  };
  GAERUAnalytics.isInitialized = false;
  GAERUAnalytics.measurementId = null;
  GAERUAnalytics.init("G-CONSENT123");
  delete globalThis.document;
  const consentCall = events.find(e => e[0] === "consent" && e[1] === "default");
  assert.ok(consentCall, "Consent Mode v2 default must be called");
  assert.equal(consentCall[2].analytics_storage, "granted");
  assert.equal(consentCall[2].ad_storage, "denied");
  assert.equal(consentCall[2].ad_personalization, "denied");
});

test("Google Analytics: Order status endpoint returns items, shippingFeeVnd, and subtotalVnd", async (context) => {
  const app = createApp({
    config: {
      ...baseConfig,
      NODE_ENV: "test",
      PORT: 0
    },
    pool: {
      query: async (sql, values) => {
        if (typeof sql === "string" && sql.includes("FROM orders WHERE order_number = $1")) {
          return {
            rows: [{
              id: 999,
              orderNumber: "GAERU-20261108-999",
              status: "confirmed",
              paymentMethod: "momo",
              paymentStatus: "paid",
              totalVnd: 720000,
              shippingFeeVnd: 30000,
              subtotalVnd: 690000,
              updatedAt: new Date().toISOString()
            }]
          };
        }
        if (typeof sql === "string" && sql.includes("FROM order_items WHERE order_id = $1")) {
          return {
            rows: [{
              sku: "K9-TYPEC",
              name: "Micro GAERU K9",
              variantName: "Type-C",
              quantity: 1,
              priceVnd: 690000,
              totalVnd: 690000
            }]
          };
        }
        return { rows: [] };
      }
    },
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Unauthenticated / unsigned query is rejected with 401
  const unauthRes = await fetch(`${baseUrl}/api/payments/order-status?order=GAERU-20261108-999`);
  assert.equal(unauthRes.status, 401);

  // Signed guest tracking token succeeds with 200
  const { signGuestTrackingToken } = require("../src/shipping-management");
  const guestToken = signGuestTrackingToken(baseConfig, "GAERU-20261108-999");
  const res = await fetch(`${baseUrl}/api/payments/order-status?order=GAERU-20261108-999&token=${encodeURIComponent(guestToken)}`);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.ok(data.order);
  assert.equal(data.order.orderNumber, "GAERU-20261108-999");
  assert.equal(data.order.totalVnd, 720000);
  assert.equal(data.order.shippingFeeVnd, 30000);
  assert.equal(data.order.subtotalVnd, 690000);
  assert.equal(data.order.items.length, 1);
  assert.equal(data.order.items[0].sku, "K9-TYPEC");
  assert.equal(data.order.items[0].priceVnd, 690000);
});

test("Google Analytics: Clearing measurement ID in DB disables tracking and does NOT fallback to env", async (context) => {
  const app = createApp({
    config: {
      ...baseConfig,
      NODE_ENV: "test",
      PORT: 0,
      GA_MEASUREMENT_ID: "G-ENVFALLBACK88"
    },
    pool: {
      query: async (sql, values) => {
        if (typeof sql === "string" && sql.includes("store_settings")) {
          if (Array.isArray(values?.[0]) && values[0].includes("ga_measurement_id")) {
            return {
              rows: [
                { setting_key: "ga_measurement_id", setting_value: "" } // Explicitly disabled in DB
              ]
            };
          }
          return { rows: [] };
        }
        return { rows: [] };
      }
    },
    sessionStore: new session.MemoryStore()
  });

  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${baseUrl}/api/settings/public`);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.gaMeasurementId, "", "Empty string in DB must take precedence and disable tracking");
});
