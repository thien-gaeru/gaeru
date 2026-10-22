const test = require("node:test");
const assert = require("node:assert/strict");
const { getCsrfToken, requireCsrf, requireAdmin } = require("../src/security");

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test("creates a per-session CSRF token and accepts only the matching request token", () => {
  const req = { session: {} };
  const token = getCsrfToken(req);
  assert.equal(token.length, 64);
  assert.equal(getCsrfToken(req), token);

  const response = makeResponse();
  let nextCalled = false;
  requireCsrf({ session: req.session, get: () => token }, response, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("rejects missing or invalid CSRF tokens and unauthenticated admin access", () => {
  const response = makeResponse();
  requireCsrf({ session: { csrfToken: "expected-token" }, get: () => "wrong-token" }, response, () => {});
  assert.equal(response.statusCode, 403);

  const adminResponse = makeResponse();
  requireAdmin({ session: {} }, adminResponse, () => {});
  assert.equal(adminResponse.statusCode, 401);
});
