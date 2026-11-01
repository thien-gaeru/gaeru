'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const requiredEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost/gaeru_test',
  SESSION_SECRET: 'proxy-trust-test-session-secret-32-characters',
  ADMIN_USERNAME: 'proxy-owner',
  ADMIN_PASSWORD_HASH: bcrypt.hashSync('proxy-test-password', 4)
};

test('Proxy trust defaults to zero hops and accepts an explicit bounded hop count', () => {
  const defaultConfig = loadConfig(requiredEnv);
  assert.equal(defaultConfig.TRUST_PROXY_HOPS, 0);

  const configured = loadConfig({ ...requiredEnv, TRUST_PROXY_HOPS: '2' });
  assert.equal(configured.TRUST_PROXY_HOPS, 2);

  assert.throws(
    () => loadConfig({ ...requiredEnv, TRUST_PROXY_HOPS: '11' }),
    /Invalid environment configuration/
  );
});

test('Express uses the validated proxy hop configuration', () => {
  const pool = { query: async () => ({ rows: [] }) };
  const app = createApp({
    config: loadConfig(requiredEnv),
    pool,
    sessionStore: new session.MemoryStore()
  });
  assert.equal(app.get('trust proxy'), 0);

  const trustedApp = createApp({
    config: loadConfig({ ...requiredEnv, TRUST_PROXY_HOPS: '1' }),
    pool,
    sessionStore: new session.MemoryStore()
  });
  assert.equal(trustedApp.get('trust proxy'), 1);
});
