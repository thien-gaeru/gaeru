'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const requiredEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture:fixture@localhost/fixture',
  SESSION_SECRET: 'trust-proxy-fixture-secret-with-32-chars',
  ADMIN_USERNAME: 'owner',
  ADMIN_PASSWORD_HASH: bcrypt.hashSync('Trust-proxy-test-password', 4)
};

test('TRUST_PROXY_HOPS is validated and applied to Express explicitly', () => {
  const config = loadConfig({ ...requiredEnvironment, TRUST_PROXY_HOPS: '2' });
  assert.equal(config.TRUST_PROXY_HOPS, 2);
  assert.throws(
    () => loadConfig({ ...requiredEnvironment, TRUST_PROXY_HOPS: '1.5' }),
    /TRUST_PROXY_HOPS/
  );
  assert.throws(
    () => loadConfig({ ...requiredEnvironment, TRUST_PROXY_HOPS: '11' }),
    /TRUST_PROXY_HOPS/
  );

  const app = createApp({
    config,
    pool: { query: async () => ({ rows: [] }) },
    sessionStore: new session.MemoryStore()
  });
  assert.equal(app.get('trust proxy'), 2);
  assert.throws(
    () => createApp({
      config: { ...config, TRUST_PROXY_HOPS: '2' },
      pool: { query: async () => ({ rows: [] }) },
      sessionStore: new session.MemoryStore()
    }),
    /TRUST_PROXY_HOPS must be an integer/
  );
});
