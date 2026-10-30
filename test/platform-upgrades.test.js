const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');
const { createRealtimeHub } = require('../src/realtime-sse');
const { createJobQueue, enqueueJob } = require('../src/job-queue');
const { createCacheManager } = require('../src/lib/cache-manager');
const { recordCartContact, markCartRecovered, getCartByToken, processAbandonedCartReminders } = require('../src/abandoned-cart');
const { calculateTier, getLoyaltyProfile, addLoyaltyPoints, redeemLoyaltyPoints, TIERS } = require('../src/loyalty-api');
const { seedInitialKnowledge, searchKnowledge } = require('../src/chat-semantic-knowledge');
const { processOmnichannelEvent } = require('../src/omnichannel-sync');
const { alertSystem } = require('../src/system-alerts');
const { connectSSE } = require('../care-live');
const { createTestDb: setupTestDb } = require('./helpers/pglite-db');

test('Realtime Hub handles SSE streams and targeted broadcasts', async () => {
  const hub = createRealtimeHub();
  const writes = [];
  const fakeRes = {
    setHeader() {},
    flushHeaders() {},
    write(chunk) { writes.push(chunk); }
  };
  const fakeReq = {
    query: { threadId: 'thread-123' },
    session: { customer: { id: 'cust-1' } },
    on() {}
  };

  hub.handleConnection(fakeReq, fakeRes);
  assert.equal(hub.getClientCount(), 1);
  assert.match(writes[0], /: connected/);

  // Broadcast to matching thread
  const delivered = hub.notifyChatMessage({ body: 'Xin chào' }, 'thread-123');
  assert.equal(delivered, 1);
  assert.match(writes[writes.length - 1], /event: chat_message/);

  // Broadcast to non-matching thread
  const deliveredOther = hub.notifyChatMessage({ body: 'Tin khác' }, 'thread-999');
  assert.equal(deliveredOther, 0);

  // care-live connectSSE helper handles missing EventSource gracefully
  const noEs = connectSSE({ environment: {} });
  assert.equal(noEs, null);
});

test('Durable Job Queue enqueues, processes, retries, and records dead-letter failure', async () => {
  const { db, pool } = await setupTestDb();
  try {
    const queue = createJobQueue({ pool, intervalMs: 50 });
    let executedPayload = null;

    queue.registerWorker('send_test_email', async (payload) => {
      executedPayload = payload;
    });

    // Enqueue
    const job = await queue.enqueue({
      name: 'send_test_email',
      payload: { to: 'test@example.com', subject: 'Chào mừng' }
    });
    assert.equal(job.name, 'send_test_email');

    // Process one
    queue.start();
    await queue.processOne();
    queue.stop();

    assert.deepEqual(executedPayload, { to: 'test@example.com', subject: 'Chào mừng' });

    const stats = await queue.getStats();
    assert.equal(stats.completed, 1);

    // Test failing worker with max_attempts
    let failAttempts = 0;
    queue.registerWorker('failing_job', async () => {
      failAttempts++;
      throw new Error('Cố tình lỗi để kiểm tra retry');
    });

    const failingJob = await queue.enqueue({
      name: 'failing_job',
      maxAttempts: 2
    });

    queue.start();
    // Attempt 1 -> retry backoff
    await queue.processOne();
    // Attempt 2 -> fail permanently
    await pool.query(`UPDATE system_jobs SET run_at = now() - interval '1 second' WHERE id = $1`, [failingJob.id]);
    await queue.processOne();
    queue.stop();

    assert.equal(failAttempts, 2);
    const finalStats = await queue.getStats();
    assert.equal(finalStats.failed, 1);
  } finally {
    await db.close();
  }
});

test('Cache Manager supports TTL, LRU eviction, pattern deletion, and cache-aside wrap', async () => {
  const cache = createCacheManager({ maxEntries: 3, defaultTtlSeconds: 60 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), 1);

  // Exceed max entries -> evict oldest (b)
  cache.set('d', 4);
  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('d'), 4);

  // Pattern delete
  cache.set('catalog:k9', { name: 'K9' });
  cache.set('catalog:p01', { name: 'P01' });
  cache.set('user:1', { name: 'Alice' });
  const deleted = cache.delPattern('catalog:*');
  assert.equal(deleted, 2);
  assert.equal(cache.get('catalog:k9'), null);
  assert.equal(cache.get('user:1').name, 'Alice');

  // Cache-aside wrap
  let computeCalls = 0;
  const val1 = await cache.wrap('stats', 60, async () => { computeCalls++; return 42; });
  const val2 = await cache.wrap('stats', 60, async () => { computeCalls++; return 42; });
  assert.equal(val1, 42);
  assert.equal(val2, 42);
  assert.equal(computeCalls, 1);
});

test('Abandoned Cart Records Contact, Recovers by Token, and Sends Automated Reminders', async () => {
  const { db, pool } = await setupTestDb();
  try {
    const recorded = await recordCartContact(pool, {
      email: 'buyer@example.com',
      phone: '0901234567',
      customerName: 'Nguyễn Văn A',
      items: [{ name: 'GAERU K9', quantity: 2, price: 500000 }],
      subtotalVnd: 1000000
    });

    assert.ok(recorded.recoveryToken);
    const loaded = await getCartByToken(pool, recorded.recoveryToken);
    assert.equal(loaded.email, 'buyer@example.com');
    assert.equal(loaded.items.length, 1);
    assert.equal(loaded.subtotalVnd, 1000000);

    // Process reminders for carts idle > 60m
    await pool.query(`UPDATE abandoned_carts SET created_at = now() - interval '65 minutes' WHERE id = $1`, [recorded.id]);

    const sentEmails = [];
    const fakeMailer = {
      async sendMail(m) { sentEmails.push(m); }
    };
    const remindedCount = await processAbandonedCartReminders(pool, fakeMailer, { PUBLIC_BASE_URL: 'https://gaeru.com' });
    assert.equal(remindedCount, 1);
    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].text, /GAERUCARE5/);

    // Mark recovered
    await markCartRecovered(pool, { recoveryToken: recorded.recoveryToken });
    const recovered = await getCartByToken(pool, recorded.recoveryToken);
    assert.equal(recovered.status, 'recovered');
  } finally {
    await db.close();
  }
});

test('Loyalty Points calculate tiers, accumulate points, and redeem discounts', async () => {
  const { db, pool } = await setupTestDb();
  try {
    // Create customer
    const custRes = await pool.query(
      `INSERT INTO customers (full_name, email, phone, password_hash)
       VALUES ('Khách VIP', 'vip@example.com', '0912345678', 'hash')
       RETURNING id`
    );
    const customerId = custRes.rows[0].id;

    // Standard initial tier
    const initial = await getLoyaltyProfile(pool, customerId);
    assert.equal(initial.tier, 'standard');
    assert.equal(initial.points, 0);

    // Add points for 10,000,000 VND order (100,000 points) -> reaches Diamond tier
    const earned = await addLoyaltyPoints(pool, {
      customerId,
      amountVnd: 10000000,
      reason: 'Đơn hàng đầu tiên'
    });
    assert.equal(earned.tier, 'diamond');
    assert.ok(earned.balance >= 100000);

    // Redeem 20,000 points
    const redeemed = await redeemLoyaltyPoints(pool, {
      customerId,
      pointsToRedeem: 20000
    });
    assert.equal(redeemed.discountVnd, 20000);

    const afterRedeem = await getLoyaltyProfile(pool, customerId);
    assert.equal(afterRedeem.points, earned.balance - 20000);
    assert.equal(afterRedeem.history.length, 2);
  } finally {
    await db.close();
  }
});

test('AI Semantic Knowledge Base seeds default guides and performs ranked search', async () => {
  const { db, pool } = await setupTestDb();
  try {
    await seedInitialKnowledge(pool);

    // Search for K9 microphone connection
    const k9Results = await searchKnowledge(pool, 'mic k9 cắm iphone có lọc ồn không');
    assert.ok(k9Results.length > 0);
    assert.equal(k9Results[0].productSlug, 'k9');
    assert.match(k9Results[0].content, /2\.4GHz/);

    // Search for Gimbal P01
    const p01Results = await searchKnowledge(pool, 'gimbal p01 bám mặt xoay 360');
    assert.ok(p01Results.length > 0);
    assert.equal(p01Results[0].productSlug, 'p01');
  } finally {
    await db.close();
  }
});

test('Omnichannel Inventory Sync updates product stock and logs events', async () => {
  const { db, pool } = await setupTestDb();
  try {
    // Create product and variant
    const prod = (await pool.query(
      `INSERT INTO products (slug, name, category, active) VALUES ('k9', 'GAERU K9', 'audio', true) RETURNING id`
    )).rows[0];
    await pool.query(
      `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
       VALUES ($1, 'GAERU-K9-TYPEC', 'Type-C', 350000, 100, true)`,
      [prod.id]
    );

    // Shopee order event -> minus 2 items
    const syncRes = await processOmnichannelEvent(pool, {
      channel: 'shopee',
      eventType: 'order_created',
      externalSku: 'GAERU-K9-TYPEC',
      quantityDelta: -2,
      payload: { shopeeOrderId: 'SP123456' }
    });

    assert.equal(syncRes.ok, true);
    assert.equal(syncRes.variant.stockQuantity, 98);

    // Check events table
    const events = (await pool.query(`SELECT * FROM omnichannel_events`)).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].channel, 'shopee');
  } finally {
    await db.close();
  }
});

test('System Alerts logs messages and suppresses duplicate alerts within 10 minutes', async () => {
  const { db, pool } = await setupTestDb();
  try {
    const fetchedCalls = [];
    const fakeFetcher = async (url, opts) => {
      fetchedCalls.push({ url, opts });
      return { ok: true, json: async () => ({}) };
    };

    const first = await alertSystem(pool, {
      severity: 'critical',
      source: 'vnpay_gateway',
      message: 'Cổng thanh toán phản hồi mã lỗi 99',
      config: { ALERT_WEBHOOK_URL: 'https://example.com/alerts' }
    }, fakeFetcher);

    assert.equal(first.alerted, true);
    assert.equal(first.isDuplicate, false);
    assert.equal(fetchedCalls.length, 1);

    // Second call with same message is deduplicated
    const second = await alertSystem(pool, {
      severity: 'critical',
      source: 'vnpay_gateway',
      message: 'Cổng thanh toán phản hồi mã lỗi 99',
      config: { ALERT_WEBHOOK_URL: 'https://example.com/alerts' }
    }, fakeFetcher);

    assert.equal(second.isDuplicate, true);
    assert.equal(fetchedCalls.length, 1); // No new fetch
  } finally {
    await db.close();
  }
});

test('HTTP routes for upgraded platform features mount and respond correctly', async () => {
  const { db, pool } = await setupTestDb();
  try {
    const app = createApp({
      pool,
      sessionStore: new session.MemoryStore(),
      config: {
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'https://gaeru.example',
        SESSION_SECRET: 'test-session-secret-32-chars-long-12345',
        OMNICHANNEL_WEBHOOK_SECRET: 'test-webhook-secret-at-least-32-chars-long',
        ADMIN_USERNAME: 'owner',
        ADMIN_PASSWORD_HASH: bcrypt.hashSync('Owner-test-123', 4)
      }
    });

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = 'http://127.0.0.1:' + server.address().port;

    try {
      // 1. Cart record-contact
      const cartRes = await fetch(`${base}/api/cart/record-contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'cart-test@example.com',
          phone: '0988776655',
          items: [{ name: 'K9', quantity: 1 }],
          subtotalVnd: 500000
        })
      });
      assert.equal(cartRes.status, 200);
      const cartData = await cartRes.json();
      assert.ok(cartData.recoveryToken);

      // 2. Cart recover
      const recoverRes = await fetch(`${base}/api/cart/recover/${cartData.recoveryToken}`);
      assert.equal(recoverRes.status, 200);
      const recoverData = await recoverRes.json();
      assert.equal(recoverData.cart.email, 'cart-test@example.com');

      // 3. Omnichannel webhook with HMAC signature
      const webhookPayload = JSON.stringify({
        eventType: 'inventory_sync',
        sku: 'UNKNOWN-SKU',
        quantityDelta: 0
      });
      const webhookSecret = 'test-webhook-secret-at-least-32-chars-long';
      const webhookTs = Math.floor(Date.now() / 1000);
      const webhookSig = require('crypto').createHmac('sha256', webhookSecret).update(`${webhookTs}.${webhookPayload}`).digest('hex');

      const webhookRes = await fetch(`${base}/api/webhooks/omnichannel/tiktok_shop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-timestamp': String(webhookTs),
          'x-webhook-signature': webhookSig
        },
        body: webhookPayload
      });
      assert.equal(webhookRes.status, 200);

      // 4. Barcode scanner asset
      const assetRes = await fetch(`${base}/gaeru_ceo/assets/barcode-scanner.js`);
      assert.equal(assetRes.status, 200);
      const assetCode = await assetRes.text();
      assert.match(assetCode, /GAERUBarcodeScanner/);
    } finally {
      await new Promise(r => server.close(r));
    }
  } finally {
    await db.close();
  }
});
