'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const flush = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };

async function portal({ login, initialMe = { authenticated: false } }) {
  const { document, window: dom } = parseHTML(fs.readFileSync(require.resolve('../admin/server-admin.html'), 'utf8'));
  const calls = [], redirects = [];
  let verified = false, challengeCalls = 0, finishChallenge;
  const window = { location: { assign(url) { redirects.push(url); } }, GAERUSecurity: {
    async loginChallenge() { challengeCalls++; await new Promise(r => { finishChallenge = r; }); verified = true; return { csrfToken: 'verified-token' }; }
  } };
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const data = url === '/server_admin/api/csrf' ? { csrfToken: 'fixture-token' }
      : url === '/server_admin/api/login' ? login
      : url === '/server_admin/api/me' ? (verified ? { authenticated: true, user: { username: 'owner', role: 'owner' } } : initialMe)
      : { ok: false };
    return { ok: !data.code, status: data.code ? 403 : 200, json: async () => data };
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../admin/server-admin.js'), 'utf8'), {
    document, window, fetch, console, Date, Intl,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, confirm: () => true
  });
  await flush();
  return { document, calls, redirects, get challengeCalls() { return challengeCalls; },
    async submit() { document.getElementById('login-username').value = 'owner'; document.getElementById('login-password').value = 'fixture'; document.getElementById('server-login-form').dispatchEvent(new dom.Event('submit', { cancelable: true })); await flush(); },
    async confirmMfa() { finishChallenge(); await flush(); }
  };
}

test('server console waits for shared MFA completion before requesting telemetry', async () => {
  const ui = await portal({ login: { mfaRequired: true, csrfToken: 'pending-token', message: 'Enter code' } });
  await ui.submit();
  assert.equal(ui.challengeCalls, 1);
  assert.equal(ui.calls.filter(c => c.url === '/server_admin/api/stats').length, 0);
  await ui.confirmMfa();
  assert.equal(ui.document.getElementById('login-modal').style.display, 'none');
  assert.equal(ui.calls.filter(c => c.url === '/server_admin/api/stats').length, 1);
});

test('server console sends newly authenticated users to required MFA setup', async () => {
  const ui = await portal({ login: { ok: false, mfaEnrollmentRequired: true, csrfToken: 'setup-token' } });
  await ui.submit();
  assert.deepEqual(ui.redirects, ['/gaeru_ceo#security']);
  assert.equal(ui.calls.filter(c => c.url === '/server_admin/api/stats').length, 0);
});

test('server console does not expose telemetry for an existing unenrolled admin session', async () => {
  const ui = await portal({ initialMe: { code: 'MFA_SETUP_REQUIRED' } });
  assert.deepEqual(ui.redirects, ['/gaeru_ceo#security']);
  assert.equal(ui.calls.filter(c => c.url === '/server_admin/api/stats').length, 0);
});
