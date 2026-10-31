'use strict';

/**
 * Live Verification Script for P3-01 Remediated Email Domain Inspection
 * Evaluates RFC 5321 / 5322 compliance, DNS query suppression for malformed emails,
 * outbox screening integration, throughput, and memory stability.
 */

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { PGlite } = require('@electric-sql/pglite');
const { extractValidEmailDomain, inspectDomain, screenNextEmail } = require('../src/order-review');

async function runLiveVerification() {
  console.log('='.repeat(70));
  console.log('🔬 GAERU STORE - P3-01 EMAIL DOMAIN INSPECTION LIVE VERIFICATION');
  console.log('='.repeat(70));

  const initialMemory = process.memoryUsage().heapUsed;

  // 1. Dataset for malformed emails (MUST have 0 DNS calls and return 'missing')
  const malformedTestCases = [
    { input: 'example.com', desc: 'No local part / no @' },
    { input: 'user@@example.com', desc: 'Double @ symbol' },
    { input: 'user@extra@domain.com', desc: 'Multiple @ symbols' },
    { input: 'user@.com', desc: 'Domain starts with dot' },
    { input: 'user@com.', desc: 'Domain ends with dot' },
    { input: '@example.com', desc: 'Empty local-part' },
    { input: 'user@', desc: 'Empty domain' },
    { input: 'user@example..com', desc: 'Consecutive dots in domain' },
    { input: 'user@-example.com', desc: 'Domain label starts with hyphen' },
    { input: 'user@example-.com', desc: 'Domain label ends with hyphen' },
    { input: 'user@nodot', desc: 'Domain without dot / single label' },
    { input: 'user@com', desc: 'Single TLD as domain' },
    { input: 'invalid-no-at-sign', desc: 'Plain string without @' },
    { input: '', desc: 'Empty string' },
    { input: '   ', desc: 'Whitespace string' },
    { input: null, desc: 'Null value' },
    { input: undefined, desc: 'Undefined value' },
    { input: 'user@' + 'a'.repeat(250) + '.com', desc: 'Email length > 254 chars' },
    { input: 'a'.repeat(65) + '@example.com', desc: 'Local-part > 64 chars' }
  ];

  let dnsCallsForMalformed = 0;
  const spyResolver = {
    resolveMx: async () => {
      dnsCallsForMalformed++;
      return [{ exchange: 'mx.attacker.mock' }];
    },
    lookup: async () => {
      dnsCallsForMalformed++;
      return { address: '127.0.0.1' };
    }
  };

  console.log('\n[Phase 1] Screening Malformed Emails (Checking Pre-DNS Filter)');
  console.log('-'.repeat(70));

  const t0 = performance.now();
  for (const tc of malformedTestCases) {
    const extractedDomain = extractValidEmailDomain(tc.input);
    const inspectionResult = await inspectDomain(tc.input, spyResolver);

    assert.equal(extractedDomain, null, `extractValidEmailDomain failed on ${tc.input}`);
    assert.equal(inspectionResult, 'missing', `inspectDomain failed on ${tc.input}`);
    console.log(`  ✓ Rejected: ${String(tc.input).padEnd(35)} | Reason: ${tc.desc}`);
  }
  const t1 = performance.now();

  assert.equal(dnsCallsForMalformed, 0, 'CRITICAL SECURITY BREACH: DNS resolver was called for malformed email!');
  console.log(`\n  ✅ All ${malformedTestCases.length} malformed inputs rejected.`);
  console.log(`  ✅ Total DNS Resolver Calls for malformed emails: ${dnsCallsForMalformed} (strictly 0).`);
  console.log(`  ⚡ Latency: ${(t1 - t0).toFixed(3)} ms total (${((t1 - t0) / malformedTestCases.length).toFixed(4)} ms/email).`);

  // 2. Dataset for valid emails (MUST call DNS resolver and classify accurately)
  console.log('\n[Phase 2] Resolving Valid Email Domains (Checking DNS Hand-off)');
  console.log('-'.repeat(70));

  let validDnsCalls = 0;
  const mockDnsResolver = {
    resolveMx: async (domain) => {
      validDnsCalls++;
      if (domain === 'gaeru.store') return [{ exchange: 'mail.gaeru.store' }];
      if (domain === 'example.test') return [{ exchange: 'mx.example.test' }];
      if (domain === 'nullmx.test') return [{ exchange: '.' }];
      if (domain === 'nonexistent.test') {
        const err = new Error('ENOTFOUND');
        err.code = 'ENOTFOUND';
        throw err;
      }
      if (domain === 'timeout.test') {
        const err = new Error('ETIMEOUT');
        err.code = 'ETIMEOUT';
        throw err;
      }
      return [{ exchange: `mx.${domain}` }];
    },
    lookup: async (domain) => {
      validDnsCalls++;
      return { address: '93.184.216.34' };
    }
  };

  const validTestCases = [
    { email: 'buyer@gaeru.store', expected: 'valid' },
    { email: 'buyer+tag@example.test', expected: 'valid' },
    { email: 'contact@nullmx.test', expected: 'missing' },
    { email: 'test@nonexistent.test', expected: 'missing' },
    { email: 'worker@timeout.test', expected: 'unknown' }
  ];

  for (const tc of validTestCases) {
    const res = await inspectDomain(tc.email, mockDnsResolver);
    assert.equal(res, tc.expected, `inspectDomain(${tc.email}) produced ${res}, expected ${tc.expected}`);
    console.log(`  ✓ Resolved: ${tc.email.padEnd(30)} => ${res.padEnd(8)} (Expected: ${tc.expected})`);
  }

  assert.equal(validDnsCalls, validTestCases.length, `Expected ${validTestCases.length} DNS calls, got ${validDnsCalls}`);
  console.log(`  ✅ Legitimate emails properly handed off to DNS resolver (${validDnsCalls} queries).`);

  // 3. Database Outbox Integration Test
  console.log('\n[Phase 3] Database Outbox Integration (screenNextEmail)');
  console.log('-'.repeat(70));

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

  const orderId = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
  await pool.query("INSERT INTO orders(id, email) VALUES($1, 'user@@invalid.domain')", [orderId]);
  await pool.query("INSERT INTO order_email_outbox(order_id, kind, status) VALUES($1, 'receipt', 'pending')", [orderId]);

  let dbResolverCalled = false;
  await screenNextEmail(pool, {
    resolver: {
      resolveMx: async () => { dbResolverCalled = true; return [{ exchange: 'mx.test' }]; },
      lookup: async () => { dbResolverCalled = true; return { address: '1.2.3.4' }; }
    }
  });

  assert.equal(dbResolverCalled, false, 'Resolver should not be called when screening outbox item with malformed email');
  const outboxRow = (await pool.query("SELECT status, result, finished_at FROM order_email_outbox WHERE order_id = $1", [orderId])).rows[0];
  assert.equal(outboxRow.status, 'failed');
  assert.equal(outboxRow.result, 'Tên miền email không tồn tại');
  assert.ok(outboxRow.finished_at);
  console.log(`  ✓ Outbox item successfully marked 'failed' with reason '${outboxRow.result}'.`);
  console.log(`  ✓ Zero DNS lookups executed during outbox background sweep.`);

  // 4. Benchmark Throughput
  console.log('\n[Phase 4] High-Volume Screening Benchmark');
  console.log('-'.repeat(70));

  const ITERATIONS = 10000;
  const benchmarkEmail = 'buyer.smith+promotions123@sub-marketing.gaeru.store';
  const tb0 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    extractValidEmailDomain(benchmarkEmail);
  }
  const tb1 = performance.now();
  const totalMs = tb1 - tb0;
  const opsPerSec = Math.round((ITERATIONS / totalMs) * 1000);

  console.log(`  ✓ Executed ${ITERATIONS.toLocaleString()} email format evaluations in ${totalMs.toFixed(2)} ms.`);
  console.log(`  ⚡ Throughput: ${opsPerSec.toLocaleString()} ops/sec (~${(totalMs / ITERATIONS * 1000).toFixed(2)} µs/op).`);

  const finalMemory = process.memoryUsage().heapUsed;
  const memDiffMb = ((finalMemory - initialMemory) / (1024 * 1024)).toFixed(2);
  console.log(`  💾 Memory Delta: ${memDiffMb} MB`);

  console.log('\n' + '='.repeat(70));
  console.log('🎉 ALL P3-01 VERIFICATIONS PASSED SUCCESSFULLY!');
  console.log('='.repeat(70));
}

runLiveVerification().catch(err => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
