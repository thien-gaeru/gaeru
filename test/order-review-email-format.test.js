'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { extractValidEmailDomain, inspectDomain, screenNextEmail } = require('../src/order-review');

test('P3-01: extractValidEmailDomain correctly parses valid emails and rejects malformed formats', () => {
  // 1. Malformed emails that must return null
  const malformedInputs = [
    'example.com',
    'user@@example.com',
    'user@extra@domain.com',
    'user@.com',
    'user@com.',
    '@example.com',
    'user@',
    'user@example..com',
    'user@-example.com',
    'user@example-.com',
    'user@nodot',
    'user@com',
    'invalid-no-at-sign',
    '',
    '   ',
    null,
    undefined,
    12345,
    {},
    'user@' + 'a'.repeat(250) + '.com', // Exceeds max length
    'a'.repeat(65) + '@example.com' // Local part exceeds 64 chars
  ];

  for (const input of malformedInputs) {
    const domain = extractValidEmailDomain(input);
    assert.equal(domain, null, `Expected null for malformed email input: ${JSON.stringify(input)}`);
  }

  // 2. Valid emails that must return clean lowercase domain
  assert.equal(extractValidEmailDomain('buyer@gaeru.store'), 'gaeru.store');
  assert.equal(extractValidEmailDomain('BUYER@GAERU.STORE'), 'gaeru.store');
  assert.equal(extractValidEmailDomain('a@example.test'), 'example.test');
  assert.equal(extractValidEmailDomain('user.name+tag@sub.example.co.uk'), 'sub.example.co.uk');
  assert.equal(extractValidEmailDomain('customer_123@domain-with-dash.com'), 'domain-with-dash.com');
});

test('P3-01: inspectDomain classifies malformed emails as missing WITHOUT invoking DNS resolver', async () => {
  let resolverCalls = 0;
  const spyResolver = {
    resolveMx: async (domain) => {
      resolverCalls++;
      return [{ exchange: `mx.${domain}` }];
    },
    lookup: async (domain) => {
      resolverCalls++;
      return { address: '93.184.216.34' };
    }
  };

  const malformedEmails = [
    'example.com',
    'user@@example.com',
    'user@.com',
    'user@com.',
    '@example.com',
    'user@',
    'user@example..com',
    'user@-example.com',
    'user@example-.com',
    'user@nodot',
    'user@com',
    'invalid-no-at-sign',
    '',
    null,
    undefined
  ];

  for (const email of malformedEmails) {
    const result = await inspectDomain(email, spyResolver);
    assert.equal(result, 'missing', `Malformed email ${JSON.stringify(email)} must return 'missing'`);
  }

  // Critical assertion: 0 DNS queries must have occurred
  assert.equal(resolverCalls, 0, 'DNS resolver must NEVER be called for malformed emails');
});

test('P3-01: inspectDomain queries DNS resolver for well-formed emails', async () => {
  let mxCalls = 0;
  let lookupCalls = 0;

  const validResolver = {
    resolveMx: async (domain) => {
      mxCalls++;
      return [{ exchange: `mail.${domain}` }];
    },
    lookup: async (domain) => {
      lookupCalls++;
      return { address: '1.2.3.4' };
    }
  };

  const res1 = await inspectDomain('buyer@gaeru.store', validResolver);
  assert.equal(res1, 'valid');
  assert.equal(mxCalls, 1);
  assert.equal(lookupCalls, 0);

  // Null MX record (`.`) indicates domain does not accept email
  const nullMxResolver = {
    resolveMx: async () => [{ exchange: '.' }],
    lookup: async () => ({ address: '1.2.3.4' })
  };
  const res2 = await inspectDomain('user@nullmx.test', nullMxResolver);
  assert.equal(res2, 'missing');

  // ENOTFOUND on MX
  const notFoundResolver = {
    resolveMx: async () => {
      const err = new Error('getaddrinfo ENOTFOUND');
      err.code = 'ENOTFOUND';
      throw err;
    }
  };
  const res3 = await inspectDomain('user@nonexistent.test', notFoundResolver);
  assert.equal(res3, 'missing');

  // Fallback to A record when MX returns ENODATA
  const enodataResolver = {
    resolveMx: async () => {
      const err = new Error('queryMx ENODATA');
      err.code = 'ENODATA';
      throw err;
    },
    lookup: async () => ({ address: '1.2.3.4' })
  };
  const res4 = await inspectDomain('user@fallback.test', enodataResolver);
  assert.equal(res4, 'valid');

  // ETIMEOUT returns 'unknown'
  const timeoutResolver = {
    resolveMx: async () => {
      const err = new Error('queryMx ETIMEOUT');
      err.code = 'ETIMEOUT';
      throw err;
    }
  };
  const res5 = await inspectDomain('user@timeout.test', timeoutResolver);
  assert.equal(res5, 'unknown');
});

test('P3-01: screenNextEmail marks outbox failed for malformed email without calling DNS', async () => {
  const pool = new PGlite();
  await pool.exec(`
    CREATE TABLE orders (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE order_email_outbox (
      id SERIAL PRIMARY KEY,
      order_id UUID NOT NULL REFERENCES orders(id),
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      next_attempt_at TIMESTAMPTZ DEFAULT now(),
      finished_at TIMESTAMPTZ,
      result TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  const orderId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  await pool.query(
    "INSERT INTO orders(id, email) VALUES($1, 'user@@example.com')",
    [orderId]
  );
  await pool.query(
    "INSERT INTO order_email_outbox(order_id, kind, status) VALUES($1, 'receipt', 'pending')",
    [orderId]
  );

  let resolverCalled = false;
  const mockResolver = {
    resolveMx: async () => {
      resolverCalled = true;
      return [{ exchange: 'mx.example.com' }];
    },
    lookup: async () => {
      resolverCalled = true;
      return { address: '1.2.3.4' };
    }
  };

  await screenNextEmail(pool, { resolver: mockResolver });

  assert.equal(resolverCalled, false, 'Resolver should not have been called for user@@example.com');

  const { rows } = await pool.query("SELECT status, result, finished_at FROM order_email_outbox WHERE order_id = $1", [orderId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].result, 'Tên miền email không tồn tại');
  assert.ok(rows[0].finished_at !== null);
});
