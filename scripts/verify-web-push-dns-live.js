'use strict';

/**
 * Live Verification Script for P1-01:
 * Web Push DNS Fail-Open Defect Remediation & DNS Rebinding SSRF Protection
 */

const { PGlite } = require('@electric-sql/pglite');
const webpush = require('web-push');
const {
  verifyPushEndpointDns,
  validatePushSubscriptionData,
  savePushSubscription,
  broadcastPushNotification,
  isKnownPushProvider,
  isPrivateOrLoopbackHost
} = require('../src/web-push');

async function runVerification() {
  console.log('='.repeat(70));
  console.log('  GAERU STORE — P1-01 WEB PUSH DNS FAIL-OPEN & SSRF REMEDIATION VERIFICATION');
  console.log('='.repeat(70));

  const db = new PGlite();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS web_push_subscriptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      endpoint text UNIQUE NOT NULL,
      p256dh text NOT NULL,
      auth text NOT NULL,
      customer_id uuid,
      user_agent text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const testVapid = webpush.generateVAPIDKeys();
  const sampleP256dh = Buffer.alloc(65, 4).toString('base64');
  const sampleAuth = Buffer.alloc(16, 9).toString('base64');
  const testEndpoint = 'https://fcm.googleapis.com/fcm/send/live-metric-test-endpoint';

  const metrics = {
    testScenarios: [],
    dnsLookupCalls: 0,
    dbSubscriptionsCount: 0
  };

  // --- Scenario 1: ETIMEOUT ---
  const t0_timeout = performance.now();
  let timeoutRejected = false;
  let timeoutErrorMsg = '';
  try {
    await savePushSubscription(db, {
      endpoint: testEndpoint,
      p256dh: sampleP256dh,
      auth: sampleAuth
    }, {
      dnsLookup: async (h) => {
        metrics.dnsLookupCalls++;
        const e = new Error(`getaddrinfo ETIMEOUT ${h}`);
        e.code = 'ETIMEOUT';
        throw e;
      }
    });
  } catch (err) {
    timeoutRejected = (err.status === 400);
    timeoutErrorMsg = err.message;
  }
  const dur_timeout = performance.now() - t0_timeout;
  const count1 = Number((await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions')).rows[0].cnt);
  metrics.testScenarios.push({
    name: '1. DNS ETIMEOUT resolution failure (Fail-Closed)',
    status: timeoutRejected && count1 === 0 ? 'PASSED' : 'FAILED',
    rejection: timeoutRejected,
    error: timeoutErrorMsg,
    dbSaved: count1 > 0,
    latencyMs: Number(dur_timeout.toFixed(3))
  });

  // --- Scenario 2: SERVFAIL ---
  const t0_servfail = performance.now();
  let servfailRejected = false;
  let servfailErrorMsg = '';
  try {
    await savePushSubscription(db, {
      endpoint: testEndpoint,
      p256dh: sampleP256dh,
      auth: sampleAuth
    }, {
      dnsLookup: async (h) => {
        metrics.dnsLookupCalls++;
        const e = new Error(`queryA SERVFAIL ${h}`);
        e.code = 'SERVFAIL';
        throw e;
      }
    });
  } catch (err) {
    servfailRejected = (err.status === 400);
    servfailErrorMsg = err.message;
  }
  const dur_servfail = performance.now() - t0_servfail;
  const count2 = Number((await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions')).rows[0].cnt);
  metrics.testScenarios.push({
    name: '2. DNS SERVFAIL response (Fail-Closed)',
    status: servfailRejected && count2 === 0 ? 'PASSED' : 'FAILED',
    rejection: servfailRejected,
    error: servfailErrorMsg,
    dbSaved: count2 > 0,
    latencyMs: Number(dur_servfail.toFixed(3))
  });

  // --- Scenario 3: ENODATA ---
  const t0_nodata = performance.now();
  let nodataRejected = false;
  let nodataErrorMsg = '';
  try {
    await savePushSubscription(db, {
      endpoint: testEndpoint,
      p256dh: sampleP256dh,
      auth: sampleAuth
    }, {
      dnsLookup: async (h) => {
        metrics.dnsLookupCalls++;
        const e = new Error(`queryA ENODATA ${h}`);
        e.code = 'ENODATA';
        throw e;
      }
    });
  } catch (err) {
    nodataRejected = (err.status === 400);
    nodataErrorMsg = err.message;
  }
  const dur_nodata = performance.now() - t0_nodata;
  const count3 = Number((await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions')).rows[0].cnt);
  metrics.testScenarios.push({
    name: '3. DNS ENODATA response (Fail-Closed)',
    status: nodataRejected && count3 === 0 ? 'PASSED' : 'FAILED',
    rejection: nodataRejected,
    error: nodataErrorMsg,
    dbSaved: count3 > 0,
    latencyMs: Number(dur_nodata.toFixed(3))
  });

  // --- Scenario 4: Empty DNS results [] ---
  const t0_empty = performance.now();
  let emptyRejected = false;
  let emptyErrorMsg = '';
  try {
    await savePushSubscription(db, {
      endpoint: testEndpoint,
      p256dh: sampleP256dh,
      auth: sampleAuth
    }, {
      dnsLookup: async () => {
        metrics.dnsLookupCalls++;
        return [];
      }
    });
  } catch (err) {
    emptyRejected = (err.status === 400);
    emptyErrorMsg = err.message;
  }
  const dur_empty = performance.now() - t0_empty;
  const count4 = Number((await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions')).rows[0].cnt);
  metrics.testScenarios.push({
    name: '4. Empty DNS record set [] (Fail-Closed)',
    status: emptyRejected && count4 === 0 ? 'PASSED' : 'FAILED',
    rejection: emptyRejected,
    error: emptyErrorMsg,
    dbSaved: count4 > 0,
    latencyMs: Number(dur_empty.toFixed(3))
  });

  // --- Scenario 5: Private / Loopback IPs ---
  const t0_priv = performance.now();
  const testPrivates = ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1'];
  let allPrivatesRejected = true;
  for (const privIp of testPrivates) {
    try {
      await savePushSubscription(db, {
        endpoint: testEndpoint,
        p256dh: sampleP256dh,
        auth: sampleAuth
      }, {
        dnsLookup: async () => {
          metrics.dnsLookupCalls++;
          return [{ address: privIp, family: privIp.includes(':') ? 6 : 4 }];
        }
      });
      allPrivatesRejected = false;
    } catch (err) {
      if (err.status !== 400 || !err.message.includes('mạng riêng không được phép')) {
        allPrivatesRejected = false;
      }
    }
  }
  const dur_priv = performance.now() - t0_priv;
  const count5 = Number((await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions')).rows[0].cnt);
  metrics.testScenarios.push({
    name: '5. Private / Loopback / Metadata IP resolutions (SSRF Shield)',
    status: allPrivatesRejected && count5 === 0 ? 'PASSED' : 'FAILED',
    testedIps: testPrivates,
    allRejected: allPrivatesRejected,
    dbSaved: count5 > 0,
    latencyMs: Number(dur_priv.toFixed(3))
  });

  // --- Scenario 6: Untrusted Gateway Domain ---
  const t0_untrusted = performance.now();
  let untrustedRejected = false;
  let untrustedMsg = '';
  try {
    await savePushSubscription(db, {
      endpoint: 'https://attacker-controlled-server.com/push',
      p256dh: sampleP256dh,
      auth: sampleAuth
    });
  } catch (err) {
    untrustedRejected = (err.status === 400);
    untrustedMsg = err.message;
  }
  const dur_untrusted = performance.now() - t0_untrusted;
  metrics.testScenarios.push({
    name: '6. Untrusted push gateway domain (Strict Allowlist)',
    status: untrustedRejected ? 'PASSED' : 'FAILED',
    rejection: untrustedRejected,
    error: untrustedMsg,
    latencyMs: Number(dur_untrusted.toFixed(3))
  });

  // --- Scenario 7: DNS Rebinding Protection (Public at Save -> Private at Send) ---
  const t0_rebind = performance.now();
  const validDns = async () => {
    metrics.dnsLookupCalls++;
    return [{ address: '216.239.38.57', family: 4 }];
  };
  const savedSub = await savePushSubscription(db, {
    endpoint: testEndpoint,
    p256dh: sampleP256dh,
    auth: sampleAuth
  }, { dnsLookup: validDns });

  process.env.VAPID_PUBLIC_KEY = testVapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = testVapid.privateKey;

  let outboundTlsCalls = 0;
  const spyClient = {
    async sendNotification() {
      outboundTlsCalls++;
      return { statusCode: 201 };
    }
  };

  const rebindDns = async () => {
    metrics.dnsLookupCalls++;
    return [{ address: '127.0.0.1', family: 4 }];
  };

  const rebindBroadcastResult = await broadcastPushNotification(db, {
    title: 'Test Khuyến mãi',
    body: 'Nội dung test'
  }, {
    dnsLookup: rebindDns,
    webpushClient: spyClient
  });

  const dur_rebind = performance.now() - t0_rebind;
  const rebindBlocked = (
    rebindBroadcastResult.ok === false &&
    rebindBroadcastResult.sentCount === 0 &&
    rebindBroadcastResult.failedCount === 1 &&
    outboundTlsCalls === 0 &&
    rebindBroadcastResult.results.failed[0]?.error?.includes('mạng riêng không được phép')
  );

  metrics.testScenarios.push({
    name: '7. TOCTOU DNS Rebinding SSRF Protection (Connect-Time Check)',
    status: rebindBlocked ? 'PASSED' : 'FAILED',
    rebindBlocked,
    outboundTlsCalls,
    failedCount: rebindBroadcastResult.failedCount,
    sentCount: rebindBroadcastResult.sentCount,
    errorCaught: rebindBroadcastResult.results.failed[0]?.error,
    latencyMs: Number(dur_rebind.toFixed(3))
  });

  // --- Scenario 8: Genuine Valid Gateway End-to-End ---
  const t0_valid = performance.now();
  let genuineTlsCalls = 0;
  const genuineClient = {
    async sendNotification() {
      genuineTlsCalls++;
      return { statusCode: 201 };
    }
  };

  const genuineBroadcastResult = await broadcastPushNotification(db, {
    title: 'Test Thành công',
    body: 'Nội dung thông báo thành công'
  }, {
    dnsLookup: validDns,
    webpushClient: genuineClient
  });

  const dur_valid = performance.now() - t0_valid;
  const genuinePassed = (
    genuineBroadcastResult.ok === true &&
    genuineBroadcastResult.sentCount === 1 &&
    genuineBroadcastResult.failedCount === 0 &&
    genuineTlsCalls === 1
  );

  metrics.testScenarios.push({
    name: '8. Genuine Trusted Push Gateway Delivery (Normal Operation)',
    status: genuinePassed ? 'PASSED' : 'FAILED',
    genuinePassed,
    sentCount: genuineBroadcastResult.sentCount,
    failedCount: genuineBroadcastResult.failedCount,
    tlsCalls: genuineTlsCalls,
    latencyMs: Number(dur_valid.toFixed(3))
  });

  // Summary
  const countFinal = (await db.query('SELECT count(*) AS cnt FROM web_push_subscriptions')).rows[0].cnt;
  metrics.dbSubscriptionsCount = parseInt(countFinal, 10);
  const mem = process.memoryUsage();

  console.log('\n--- KẾT QUẢ XÁC MINH CÁC KỊCH BẢN KIỂM THỬ ---');
  for (const s of metrics.testScenarios) {
    console.log(`[${s.status}] ${s.name} (${s.latencyMs}ms)`);
  }

  console.log('\n--- CHỈ SỐ HOẠT ĐỘNG THỰC TẾ (EMPIRICAL METRICS) ---');
  console.log(`- Tổng số lượt truy vấn DNS kiểm soát (dns_lookup_calls): ${metrics.dnsLookupCalls}`);
  console.log(`- Số subscription hợp lệ cuối cùng trong DB: ${metrics.dbSubscriptionsCount} (Chỉ lưu endpoint đã xác minh)`);
  console.log(`- Cuộc gọi TLS outbound đến IP nội bộ khi DNS rebinding: ${outboundTlsCalls} (0 cuộc gọi = SSRF hoàn toàn bị triệt tiêu)`);
  console.log(`- Heap Memory Usage: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);

  await db.close();
  return metrics;
}

if (require.main === module) {
  runVerification().catch(console.error);
}

module.exports = { runVerification };
