const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../src/config");
const bcrypt = require("bcryptjs");

test("loads valid deployment configuration and applies defaults", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://localhost/gaeru",
    SESSION_SECRET: "a-session-secret-with-at-least-32-chars",
    ADMIN_USERNAME: "manager",
    ADMIN_PASSWORD_HASH: bcrypt.hashSync("test-password", 4)
  });
  assert.equal(config.PORT, 3000);
  assert.equal(config.NODE_ENV, "development");
  assert.equal(config.PGSSL, "disable");
  assert.equal(config.STORE_ORDERS_ENABLED, false);
  assert.equal(config.vnpay, null);
  assert.equal(config.smtp, null);
});

test("only enables order submission when explicitly configured", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://localhost/gaeru",
    SESSION_SECRET: "a-session-secret-with-at-least-32-chars",
    ADMIN_USERNAME: "manager",
    ADMIN_PASSWORD_HASH: bcrypt.hashSync("test-password", 4),
    STORE_ORDERS_ENABLED: "true"
  });
  assert.equal(config.STORE_ORDERS_ENABLED, true);
});

test("rejects short session secrets and missing admin credentials", () => {
  assert.throws(() => loadConfig({
    DATABASE_URL: "postgres://localhost/gaeru",
    SESSION_SECRET: "short",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH: ""
  }), /Invalid environment configuration/);
});

test("requires complete HTTPS configuration for VNPAY", () => {
  const base = {
    DATABASE_URL: "postgres://localhost/gaeru",
    SESSION_SECRET: "a-session-secret-with-at-least-32-chars",
    ADMIN_USERNAME: "manager",
    ADMIN_PASSWORD_HASH: bcrypt.hashSync("test-password", 4)
  };
  const config = loadConfig({
    ...base,
    PUBLIC_BASE_URL: "https://store.example",
    VNPAY_TMN_CODE: "ABC12345",
    VNPAY_HASH_SECRET: "sandbox-secret",
    VNPAY_PAYMENT_URL: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html"
  });

  test("loads complete SMTP settings without requiring VNPAY", () => {
    const base = {
      DATABASE_URL: "postgres://localhost/gaeru",
      SESSION_SECRET: "a-session-secret-with-at-least-32-chars",
      ADMIN_USERNAME: "manager",
      ADMIN_PASSWORD_HASH: bcrypt.hashSync("test-password", 4)
    };
    const config = loadConfig({
      ...base,
      PUBLIC_BASE_URL: "https://store.example",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_SECURE: "false",
      SMTP_USER: "mailer",
      SMTP_PASSWORD: "mail-secret",
      SMTP_FROM: "support@example.com"
    });
    assert.equal(config.vnpay, null);
    assert.equal(config.smtp.secure, false);
    assert.equal(config.smtp.publicBaseUrl, "https://store.example");
    assert.throws(() => loadConfig({
      ...base,
      SMTP_HOST: "smtp.example.com"
    }), /SMTP_HOST.*PUBLIC_BASE_URL/);
  });
  assert.equal(config.vnpay.returnUrl, "https://store.example/api/payments/vnpay/return");
  assert.equal(config.vnpay.paymentUrl, "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html");
  assert.throws(() => loadConfig({
    ...base,
    PUBLIC_BASE_URL: "https://store.example",
    VNPAY_TMN_CODE: "ABC12345",
    VNPAY_HASH_SECRET: "sandbox-secret"
  }), /cấu hình cùng nhau/);
  assert.throws(() => loadConfig({ ...base, VNPAY_TMN_CODE: "ABC12345" }), /cấu hình cùng nhau/);
  assert.throws(() => loadConfig({
    ...base,
    PUBLIC_BASE_URL: "http://localhost",
    VNPAY_TMN_CODE: "ABC12345",
    VNPAY_HASH_SECRET: "sandbox-secret",
    VNPAY_PAYMENT_URL: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html"
  }), /HTTPS/);
});

test('Turnstile requires both keys and an HTTPS public origin',()=>{const base={DATABASE_URL:'postgres://localhost/gaeru',SESSION_SECRET:'a-session-secret-with-at-least-32-chars',ADMIN_USERNAME:'manager',ADMIN_PASSWORD_HASH:bcrypt.hashSync('test-password',4)};assert.throws(()=>loadConfig({...base,TURNSTILE_SITE_KEY:'site'}),/TURNSTILE/);assert.throws(()=>loadConfig({...base,TURNSTILE_SITE_KEY:'site',TURNSTILE_SECRET_KEY:'secret'}),/PUBLIC_BASE_URL/);const config=loadConfig({...base,TURNSTILE_SITE_KEY:'site',TURNSTILE_SECRET_KEY:'secret',PUBLIC_BASE_URL:'https://gaeru.com'});assert.equal(config.TURNSTILE_SITE_KEY,'site');});
