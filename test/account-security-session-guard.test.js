'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountSecurity } = require('../src/account-security');

test('shared security-version guard rejects revoked identities for every API path casing', async () => {
  const pool = { async query(_sql, [key]) { return { rows: [{ account_key: key, version: 2 }] }; } };
  const security = createAccountSecurity(pool, { SESSION_SECRET: 'case-guard-fixture-32-characters' });
  for (const path of ['/api/account-security/settings', '/API/account-security/settings', '/ApI/Account-Security/Settings']) {
    for (const identity of [{ admin: { source: 'bootstrap' } }, { admin: { source: 'staff', id: 'fixture-staff' } }, { customer: { id: 'fixture-customer' } }]) {
      const current = { ...identity, securityVersion: 1 };
      let calls = 0;
      await security.sessionGuard({ path, session: current }, {}, error => { assert.ifError(error); calls++; });
      assert.equal(calls, 1);
      assert.equal(current.admin, undefined, path);
      assert.equal(current.customer, undefined, path);
    }
    const valid = { admin: { source: 'staff', id: 'fixture-staff' }, securityVersion: 2 };
    await security.sessionGuard({ path, session: valid }, {}, error => assert.ifError(error));
    assert.ok(valid.admin, path + ' must preserve a current session');
  }
});
