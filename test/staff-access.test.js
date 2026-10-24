const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { createAdminAuthRouter } = require("../src/admin-auth");
const { createStaffApi } = require("../src/staff-api");
const { appendAudit, sanitizeAuditValue } = require("../src/audit");
const {
  PERMISSIONS, ROLE_PERMISSIONS, publicRoles, bootstrapCredentialVersion, bootstrapPrincipal,
  principalFromStaff, resolveAdminSession, createAdminAccess, requirePermission
} = require("../src/staff-access");
const { getCsrfToken } = require("../src/security");

const staffId = "45b6616f-95be-4549-b3ef-b7b486149152";
const departmentId = "15489d4c-fbad-4f1b-92e9-b9bc772a15cc";
const auditId = "716276df-1c90-43d6-9c7c-07f67cf27bb9";
const config = { ADMIN_USERNAME: "bootstrap", ADMIN_PASSWORD_HASH: bcrypt.hashSync("bootstrap-password", 4) };

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

async function listen(context, app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function testErrorHandler(error, _req, res, _next) {
  res.status(error.status || 500).json({ error: error.message });
}

async function staffApi(context, pool, actor = bootstrapPrincipal(config)) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.admin = actor;
    req.session = { csrfToken: "valid-csrf-token" };
    next();
  });
  app.use("/api/gaeru_ceo", createStaffApi(pool, config));
  app.use(testErrorHandler);
  const origin = await listen(context, app);
  return (path, { method = "GET", body } = {}) => fetch(`${origin}/api/gaeru_ceo${path}`, {
    method, headers: { "Content-Type": "application/json", "X-CSRF-Token": "valid-csrf-token" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

test("role catalogue exposes assignable employee roles without granting privileged writes to operational staff", () => {
  assert.equal(new Set(PERMISSIONS).size, PERMISSIONS.length);
  assert.deepEqual(ROLE_PERMISSIONS.owner, PERMISSIONS);
  assert.equal(publicRoles().find((role) => role.id === "owner").assignable, false);
  assert.equal(ROLE_PERMISSIONS.warehouse.includes("inventory.write"), true);
  assert.equal(ROLE_PERMISSIONS.warehouse.includes("payments.write"), false);
  assert.equal(ROLE_PERMISSIONS.accountant.includes("payments.write"), true);
  assert.equal(ROLE_PERMISSIONS.manager.includes("purchases.approve"), true);
  assert.equal(ROLE_PERMISSIONS.manager.includes("staff.write"), false);
  assert.equal(ROLE_PERMISSIONS.viewer.some((name) => name.endsWith(".write") || name.endsWith(".approve")), false);
});

test("bootstrap sessions require current credentials and do not depend on database employee rows", async () => {
  const pool = { query() { throw new Error("bootstrap should not query staff"); } };
  const req = { session: { admin: { source: "bootstrap", username: config.ADMIN_USERNAME, credentialVersion: bootstrapCredentialVersion(config), role: "viewer" } } };
  assert.deepEqual(await resolveAdminSession(req, pool, config), bootstrapPrincipal(config));
  const changedConfig = { ...config, ADMIN_PASSWORD_HASH: bcrypt.hashSync("replacement-password", 4) };
  assert.equal(await resolveAdminSession(req, pool, changedConfig), null);
  assert.equal(req.session.admin, undefined);
});

test("employee access uses current database role and revokes blocked or outdated sessions", async (context) => {
  for (const change of ["role", "password", "active"]) {
    await context.test(change, async () => {
      const employee = { id: staffId, username: "employee", fullName: "Nhân viên", role: "viewer", active: true, authVersion: 1 };
      const pool = { query: async () => ({ rows: [{ ...employee }] }) };
      const req = { session: { admin: { source: "staff", id: staffId, authVersion: 1, role: "owner", permissions: PERMISSIONS } } };
      const principal = await resolveAdminSession(req, pool, config);
      assert.equal(principal.role, "viewer");
      assert.equal(principal.permissions.includes("staff.write"), false);
      if (change === "role") employee.role = "sales";
      if (change === "active") employee.active = false;
      employee.authVersion += 1;
      assert.equal(await resolveAdminSession(req, pool, config), null);
      assert.equal(req.session.admin, undefined);
    });
  }
});

test("admin middleware fails closed and permission checks reject a session-cached role", async () => {
  const req = { session: { admin: { source: "staff", id: staffId, authVersion: 1 } } };
  const res = response();
  let called = false;
  await createAdminAccess({ query: async () => ({ rows: [] }) }, config)(req, res, () => { called = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
  const employeeReq = { admin: principalFromStaff({ id: staffId, username: "staff", fullName: "Staff", role: "warehouse", active: true }) };
  const forbidden = response();
  requirePermission("staff.write")(employeeReq, forbidden, () => { called = true; });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(called, false);
  let failure;
  await createAdminAccess({ query: async () => { throw new Error("database offline"); } }, config)(
    { session: { admin: { source: "staff", id: staffId, authVersion: 1 } } }, response(), (error) => { failure = error; }
  );
  assert.match(failure.message, /database offline/);
  assert.throws(() => requirePermission("invented.permission"), /Unknown admin permission/);
});

test("employee login rotates the session and fresh access rejects the cookie after a role change", async (context) => {
  const employee = {
    id: staffId, username: "warehouse01", fullName: "Nhân viên kho", role: "warehouse", active: true,
    passwordHash: bcrypt.hashSync("employee-password", 4), authVersion: 1
  };
  const audits = [];
  const pool = { async query(sql, values) {
    if (sql.includes("FROM staff_accounts")) return { rows: [employee] };
    if (sql.startsWith("INSERT INTO audit_events")) { audits.push(values); return { rows: [{ id: auditId }] }; }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "staff-auth-test-secret-32-characters-long", resave: false, saveUninitialized: false, store: new session.MemoryStore() }));
  app.get("/csrf", (req, res) => res.json({ csrfToken: getCsrfToken(req) }));
  app.use("/auth", createAdminAuthRouter(config, pool));
  app.get("/protected", createAdminAccess(pool, config), requirePermission("inventory.write"), (req, res) => res.json({ role: req.admin.role }));
  app.use(testErrorHandler);
  const origin = await listen(context, app);
  const csrf = await fetch(`${origin}/csrf`);
  const csrfBody = await csrf.json();
  const cookie = csrf.headers.get("set-cookie").split(";")[0];
  const login = await fetch(`${origin}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrfBody.csrfToken },
    body: JSON.stringify({ username: employee.username, password: "employee-password" })
  });
  assert.equal(login.status, 200);
  const identity = await login.json();
  assert.equal(identity.role, "warehouse");
  assert.equal(identity.fullName, employee.fullName);
  assert.equal(identity.permissions.includes("staff.write"), false);
  assert.equal(identity.source, "staff");
  assert.notEqual(identity.csrfToken, csrfBody.csrfToken);
  const adminCookie = login.headers.get("set-cookie").split(";")[0];
  assert.notEqual(adminCookie, cookie);
  assert.equal((await fetch(`${origin}/protected`, { headers: { Cookie: adminCookie } })).status, 200);
  const current = await fetch(`${origin}/auth/me`, { headers: { Cookie: adminCookie } });
  assert.equal((await current.json()).role, "warehouse");
  assert.equal(audits.length, 1);
  assert.equal(audits[0][5], "auth.login");
  assert.equal(JSON.stringify(identity).includes("password"), false);
  employee.role = "viewer";
  employee.authVersion += 1;
  assert.equal((await fetch(`${origin}/protected`, { headers: { Cookie: adminCookie } })).status, 401);
  const revoked = await fetch(`${origin}/auth/me`, { headers: { Cookie: adminCookie } });
  assert.deepEqual(await revoked.json(), { authenticated: false, username: null, fullName: null, role: null, permissions: [], source: null });
});

test("bootstrap login remains available, rotated credentials revoke its old session, and blocked employees cannot login", async (context) => {
  const employee = { id: staffId, username: "inactive", fullName: "Đã khóa", role: "admin", active: false, passwordHash: bcrypt.hashSync("employee-password", 4), authVersion: 2 };
  const pool = { async query(sql) {
    if (sql.includes("FROM staff_accounts")) return { rows: [employee] };
    return { rows: [{ id: auditId }] };
  } };
  const mutableConfig = { ...config };
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "bootstrap-test-secret-with-32-characters", resave: false, saveUninitialized: false }));
  app.get("/csrf", (req, res) => res.json({ csrfToken: getCsrfToken(req) }));
  app.use("/auth", createAdminAuthRouter(mutableConfig, pool));
  app.use(testErrorHandler);
  const origin = await listen(context, app);
  async function login(username, password) {
    const csrf = await fetch(`${origin}/csrf`);
    const csrfBody = await csrf.json();
    return fetch(`${origin}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: csrf.headers.get("set-cookie").split(";")[0], "X-CSRF-Token": csrfBody.csrfToken },
      body: JSON.stringify({ username, password })
    });
  }
  assert.equal((await login("inactive", "employee-password")).status, 401);
  const owner = await login(config.ADMIN_USERNAME, "bootstrap-password");
  assert.equal(owner.status, 200);
  assert.equal((await owner.json()).role, "owner");
  const cookie = owner.headers.get("set-cookie").split(";")[0];
  mutableConfig.ADMIN_PASSWORD_HASH = bcrypt.hashSync("new-bootstrap-password", 4);
  const revoked = await fetch(`${origin}/auth/me`, { headers: { Cookie: cookie } });
  assert.equal((await revoked.json()).authenticated, false);
  assert.equal((await login(config.ADMIN_USERNAME, "new-bootstrap-password")).status, 200);
});

test("audit sanitizer removes nested credentials while keeping a bounded change snapshot", async () => {
  const value = sanitizeAuditValue({
    name: "Đơn hàng", password: "plain-secret", nested: { api_key: "key-secret", total: 150000 },
    entries: [{ authorization: "Bearer secret", quantity: 2 }], before: { passwordHash: "hashed-secret", active: true }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(value)), { name: "Đơn hàng", nested: { total: 150000 }, entries: [{ quantity: 2 }], before: { active: true } });
  let saved;
  const client = { query: async (sql, values) => { saved = { sql, values }; return { rows: [{ id: auditId }] }; } };
  await appendAudit(client, { actor: bootstrapPrincipal(config), action: "staff.update", entityType: "staff", entityId: staffId, before: { active: true }, after: { active: false }, details: { reason: "Khóa tài khoản", sessionToken: "secret" } });
  assert.equal(saved.values[0], null);
  assert.equal(saved.values[5], "staff.update");
  assert.equal(JSON.stringify(saved.values).includes("secret"), false);
  assert.equal(saved.values[10].reason, "Khóa tài khoản");
  await assert.rejects(appendAudit(client, { action: "staff.update", entityType: "staff" }), /Audit actor/);
});

test("staff API enforces permissions and reserves the bootstrap identity", async (context) => {
  const pool = { query() { throw new Error("must reject before SQL"); }, connect() { throw new Error("must reject before transaction"); } };
  const warehouse = principalFromStaff({ id: staffId, username: "warehouse", role: "warehouse", active: true });
  const operationalRequest = await staffApi(context, pool, warehouse);
  assert.equal((await operationalRequest("/staff")).status, 403);
  assert.equal((await operationalRequest("/staff", { method: "POST", body: {} })).status, 403);
  assert.equal((await operationalRequest("/audit-logs")).status, 403);
  const ownerRequest = await staffApi(context, pool);
  const reserved = await ownerRequest("/staff", { method: "POST", body: { username: "BOOTSTRAP", fullName: "Chủ giả", password: "employee-password", role: "admin" } });
  assert.equal(reserved.status, 409);
  const ownerRole = await ownerRequest("/staff", { method: "POST", body: { username: "another-owner", fullName: "Nhân viên", password: "employee-password", role: "owner" } });
  assert.equal(ownerRole.status, 400);
});

test("employee updates require the current version and revoke sessions for role, password, or active changes", async (context) => {
  for (const change of [{ role: "viewer" }, { active: false }, { password: "replacement-password" }, { fullName: "Tên đã cập nhật" }]) {
    await context.test(JSON.stringify(Object.keys(change)), async (subcontext) => {
      const statements = [];
      const current = { id: staffId, username: "employee", fullName: "Nhân viên", role: "sales", active: true, departmentId: null, departmentName: null, version: 1 };
      let mutation;
      const client = { async query(sql, values) {
        statements.push(sql);
        if (sql.includes("FROM staff_accounts WHERE id=$1 FOR UPDATE")) return { rows: [{ ...current }] };
        if (sql.startsWith("SELECT s.id")) return { rows: [{ ...current }] };
        if (sql.startsWith("UPDATE staff_accounts")) { mutation = values; return { rows: [] }; }
        if (sql.startsWith("INSERT INTO audit_events")) return { rows: [{ id: auditId }] };
        return { rows: [] };
      }, release() {} };
      const request = await staffApi(subcontext, { connect: async () => client });
      const result = await request(`/staff/${staffId}`, { method: "PATCH", body: { ...change, version: 1 } });
      assert.equal(result.status, 200);
      assert.equal(mutation[6], Object.hasOwn(change, "fullName") ? 0 : 1);
      if (change.password) { assert.notEqual(mutation[5], change.password); assert.equal(await bcrypt.compare(change.password, mutation[5]), true); }
      assert.equal(statements.at(-1), "COMMIT");
      assert.equal(statements.filter((sql) => sql.startsWith("INSERT INTO audit_events")).length, 1);
      assert.equal(JSON.stringify(await result.json()).includes("password"), false);
    });
  }
});

test("stale employee edits and audit failures roll back without committing a mutation", async (context) => {
  for (const scenario of ["stale", "audit-failure"]) {
    await context.test(scenario, async (subcontext) => {
      const statements = [];
      const current = { id: staffId, username: "employee", fullName: "Nhân viên", role: "sales", active: true, departmentId: null, version: 2 };
      const client = { async query(sql) {
        statements.push(sql);
        if (sql.includes("FROM staff_accounts WHERE id=$1 FOR UPDATE") || sql.startsWith("SELECT s.id")) return { rows: [current] };
        if (sql.startsWith("INSERT INTO audit_events")) throw new Error("audit write failed");
        return { rows: [] };
      }, release() {} };
      const request = await staffApi(subcontext, { connect: async () => client });
      const result = await request(`/staff/${staffId}`, { method: "PATCH", body: { role: "viewer", version: scenario === "stale" ? 1 : 2 } });
      assert.equal(result.status, scenario === "stale" ? 409 : 500);
      assert.equal(statements.at(-1), "ROLLBACK");
      assert.equal(statements.includes("COMMIT"), false);
      assert.equal(statements.some((sql) => sql.startsWith("UPDATE staff_accounts")), scenario !== "stale");
    });
  }
});

test("staff list returns safe fields and audit pagination validates filters", async (context) => {
  const calls = [];
  const safeEmployee = { id: staffId, username: "employee", fullName: "Nhân viên", role: "viewer", active: true, departmentId, departmentName: "Kinh doanh", version: 3 };
  const pool = { async query(sql, values) {
    calls.push({ sql, values });
    if (sql.startsWith("SELECT COUNT(*)")) return { rows: [{ total: 26 }] };
    if (sql.includes("FROM staff_accounts")) return { rows: [safeEmployee] };
    if (sql.includes("FROM audit_events")) return { rows: [{ id: auditId, action: "staff.update" }] };
    return { rows: [] };
  } };
  const request = await staffApi(context, pool);
  const listed = await request("/staff?page=2&role=viewer&active=true&q=employee");
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.deepEqual(body.pagination, { page: 2, pageSize: 25, total: 26, pageCount: 2 });
  assert.deepEqual(body.staff, [safeEmployee]);
  assert.equal(body.bootstrap.managedByEnvironment, true);
  assert.equal(calls[1].sql.includes("password_hash"), false);
  assert.deepEqual(calls[1].values, ["employee", "viewer", "true", 25, 25]);
  const audit = await request(`/audit-logs?page=2&actorId=${staffId}&from=2026-10-01&to=2026-10-23`);
  assert.equal(audit.status, 200);
  assert.equal((await audit.json()).events[0].action, "staff.update");
  assert.equal(calls[2].values[4], "2026-09-30T17:00:00.000Z");
  assert.equal(calls[2].values[5], "2026-10-23T17:00:00.000Z");
  assert.match(calls[2].sql, /created_at < \$6/);
  assert.equal((await request("/audit-logs?actorId=bad")).status, 400);
  assert.equal((await request("/audit-logs?from=2026-02-30")).status, 400);
  assert.equal((await request("/audit-logs?from=2026-10-23&to=2026-10-01")).status, 400);
  assert.equal((await request("/staff?page=1.5")).status, 400);
});

test("department writes normalize codes, audit atomically, and reject stale versions", async (context) => {
  const current = { id: departmentId, code: "SALES", name: "Kinh doanh", active: true, version: 1 };
  const statements = [];
  let inserted;
  const client = { async query(sql, values) {
    statements.push(sql);
    if (sql.startsWith("INSERT INTO departments")) { inserted = values; return { rows: [current] }; }
    if (sql.includes("FROM departments WHERE id=$1 FOR UPDATE")) return { rows: [current] };
    if (sql.startsWith("INSERT INTO audit_events")) return { rows: [{ id: auditId }] };
    return { rows: [] };
  }, release() {} };
  const request = await staffApi(context, { connect: async () => client });
  const created = await request("/departments", { method: "POST", body: { code: "sales", name: "Kinh doanh" } });
  assert.equal(created.status, 201);
  assert.equal(inserted[0], "SALES");
  assert.equal(statements.at(-1), "COMMIT");
  const stale = await request(`/departments/${departmentId}`, { method: "PATCH", body: { name: "Tên mới", version: 2 } });
  assert.equal(stale.status, 409);
  assert.equal(statements.at(-1), "ROLLBACK");
});
