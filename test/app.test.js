const test = require("node:test");
const assert = require("node:assert/strict");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { createApp } = require("../src/app");

const config = {
  NODE_ENV: "test",
  PORT: 0,
  SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
  ADMIN_USERNAME: "manager",
  ADMIN_PASSWORD_HASH: bcrypt.hashSync("test-password", 4)
};

test("app serves storefront, initializes CSRF, and protects private files and admin routes", async (context) => {
  const app = createApp({
    config,
    pool: { query: async () => ({ rows: [] }) },
    sessionStore: new session.MemoryStore()
  });
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const homepage = await fetch(baseUrl);
  assert.equal(homepage.status, 200);
  assert.match(homepage.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(homepage.headers.get("x-powered-by"), null);
  const accountPage = await fetch(`${baseUrl}/account.html`);
  assert.equal(accountPage.status, 200);
  assert.equal(accountPage.headers.get('cache-control'), 'no-store');
  const accountScript = await fetch(`${baseUrl}/account.js?v=20261023-mfa`);
  assert.equal(accountScript.headers.get('cache-control'), 'no-store');
  const accountMarkup = await accountPage.text();
  assert.match(accountMarkup, /account\.js\?v=20261023-mfa/);
  assert.match(accountMarkup, /data-account-panel="login"[^>]*hidden/);
  assert.match(accountMarkup, /data-account-loading-message>Đang tải tài khoản/);
  assert.match(accountMarkup, /Tài khoản khách hàng/);
  assert.match(accountMarkup, /href="#register" data-account-show-register/);
  assert.doesNotMatch(accountMarkup, /data-account-tab="register"/);
  assert.match(accountMarkup, /href="#login" data-account-show-login/);
  const storeShell = await fetch(`${baseUrl}/store-shell.js`);
  assert.match(await storeShell.text(), /account\.html#register/);
  assert.equal((await fetch(`${baseUrl}/account.js`)).status, 200);

  const csrf = await fetch(`${baseUrl}/api/csrf`);
  assert.equal(csrf.status, 200);
  const csrfBody = await csrf.json();
  assert.equal(csrfBody.csrfToken.length, 64);
  const csrfCookie = csrf.headers.get("set-cookie").split(";")[0];

  const malformedJson = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{"
  });
  assert.equal(malformedJson.status, 400);
  assert.deepEqual(await malformedJson.json(), { error: "Yêu cầu không hợp lệ." });

  const me = await fetch(`${baseUrl}/api/auth/me`);
  const anonymousIdentity = await me.json();
  assert.equal(anonymousIdentity.authenticated, false);
  assert.equal(anonymousIdentity.username, null);
  assert.deepEqual(anonymousIdentity.permissions, []);
  assert.equal((await fetch(`${baseUrl}/api/gaeru_ceo/summary`)).status, 401);
  for (const route of ["/gaeru_ceo", "/gaeru_ceo/"]) {
    const page = await fetch(baseUrl + route);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('id="login-form"'));
  }
  for (const route of ['/admin','/admin/','/admin/index.html','/admin/admin.js','/admin/product-editor.html','/admin/product-editor.js','/ADMIN','/%61dmin/index.html','/admin%2fadmin.css','/%2fadmin/index.html','/api/admin/summary','/api/%61dmin/products']) {
    for(const method of ['GET','HEAD','POST']){
      const retired=await fetch(baseUrl+route,{method,redirect:'manual'});
      assert.equal(retired.status,404,method+' '+route);
      assert.equal(retired.headers.get('location'),null);
      assert.equal(retired.headers.get('cache-control'),'no-store');
    }
  }
  for(const route of ['/gaeru_ceo','/gaeru_ceo/products/new']){
    const page=await fetch(baseUrl+route);assert.equal(page.status,200);const html=await page.text();
    assert.ok(!html.includes('"/admin/'));
    const resources=[...html.matchAll(/(?:src|href)="(\/gaeru_ceo\/assets\/[^"?]+)(?:[^" ]*)"/g)].map(m=>m[1]);
    assert.ok(resources.length>=3);
    for(const resource of resources){const asset=await fetch(baseUrl+resource);assert.equal(asset.status,200,resource);assert.equal(asset.headers.get('cache-control'),'no-store');}
  }
  for(const route of ['/gaeru_ceo/assets/index.html','/gaeru_ceo/assets/product-editor.html','/gaeru_ceo/assets/package.json'])assert.equal((await fetch(baseUrl+route)).status,404);
  assert.equal((await fetch(`${baseUrl}/src/app.js`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/db/schema.sql`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/package.json`)).status, 404);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfBody.csrfToken,
      Cookie: csrfCookie
    },
    body: JSON.stringify({ username: "manager", password: "test-password" })
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.username, "manager");
  assert.notEqual(loginBody.csrfToken, csrfBody.csrfToken);
  const adminCookie = login.headers.get("set-cookie").split(";")[0];
  const authenticatedSession = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: adminCookie } });
  const identity = await authenticatedSession.json();
  assert.equal(identity.authenticated, true);
  assert.equal(identity.username, "manager");
  assert.equal(identity.role, "owner");
  assert.ok(identity.permissions.includes("staff.write"));

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { "X-CSRF-Token": loginBody.csrfToken, Cookie: adminCookie },
    body: "{}"
  });
  assert.equal(logout.status, 204);
});
