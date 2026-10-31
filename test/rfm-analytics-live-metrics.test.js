'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDb } = require('./helpers/pglite-db');
const {
  RFM_SEGMENTS,
  scoreRecency,
  scoreFrequency,
  scoreMonetary,
  determineSegment,
  getRfmCustomerSegmentation,
  createRfmAdminRouter
} = require('../src/rfm-analytics');

test('RFM Analytics: Mathematical scoring, Database segmentation, Cancellation filtering, and Admin marketing sync', async (t) => {
  const { db, pool } = await createTestDb({ migrate: true });

  t.after(async () => {
    await pool.end().catch(() => {});
  });

  await t.test('1. Mathematical scoring functions: Recency, Frequency, Monetary and Segment determination', () => {
    // Recency (R)
    assert.equal(scoreRecency(20), 5);
    assert.equal(scoreRecency(50), 4);
    assert.equal(scoreRecency(80), 3);
    assert.equal(scoreRecency(120), 2);
    assert.equal(scoreRecency(250), 1);
    assert.equal(scoreRecency(null), 1);
    assert.equal(scoreRecency(undefined), 1);

    // Frequency (F)
    assert.equal(scoreFrequency(10), 5);
    assert.equal(scoreFrequency(4), 4);
    assert.equal(scoreFrequency(2), 3);
    assert.equal(scoreFrequency(1), 2);
    assert.equal(scoreFrequency(0), 1);
    assert.equal(scoreFrequency(null), 1);

    // Monetary (M)
    assert.equal(scoreMonetary(6000000), 5);
    assert.equal(scoreMonetary(4000000), 4);
    assert.equal(scoreMonetary(2000000), 3);
    assert.equal(scoreMonetary(700000), 2);
    assert.equal(scoreMonetary(200000), 1);
    assert.equal(scoreMonetary(0), 1);

    // Segment determination
    assert.equal(determineSegment(5, 4, 5), 'champions');
    assert.equal(determineSegment(3, 3, 2), 'loyal');
    assert.equal(determineSegment(4, 1, 2), 'promising');
    assert.equal(determineSegment(2, 4, 3), 'at_risk');
    assert.equal(determineSegment(1, 1, 1), 'lost');
  });

  await t.test('2. getRfmCustomerSegmentation groups by phone, sums revenue, and excludes cancelled orders', async () => {
    // Insert VIP Customer (0901234567): 3 orders in last 10 days, total spend 6,000,000₫
    await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES 
         ('ORD-T1', 'VIP Customer', 'vip@test.com', '0901234567', 'HN', 'HN', 'cod', 'completed', 2000000, 2000000, now() - interval '8 days'),
         ('ORD-T2', 'VIP Customer', 'vip@test.com', '0901234567', 'HN', 'HN', 'cod', 'completed', 2000000, 2000000, now() - interval '5 days'),
         ('ORD-T3', 'VIP Customer', 'vip@test.com', '0901234567', 'HN', 'HN', 'cod', 'completed', 2000000, 2000000, now() - interval '2 days')`
    );

    // Insert At-Risk Customer (0909999999): 2 orders 120 days ago, total spend 1,800,000₫
    await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES 
         ('ORD-T4', 'Risk Customer', 'risk@test.com', '0909999999', 'HCM', 'HCM', 'cod', 'completed', 900000, 900000, now() - interval '130 days'),
         ('ORD-T5', 'Risk Customer', 'risk@test.com', '0909999999', 'HCM', 'HCM', 'cod', 'completed', 900000, 900000, now() - interval '120 days')`
    );

    // Insert Cancelled Order (0900000000): must be excluded
    await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
       VALUES ('ORD-CANCEL', 'Cancelled Customer', 'cancel@test.com', '0900000000', 'DN', 'DN', 'cod', 'cancelled', 10000000, 10000000, now() - interval '1 days')`
    );

    const rfm = await getRfmCustomerSegmentation(pool);

    assert.equal(rfm.totalCustomers, 2);
    assert.equal(rfm.totalRevenueVnd, 7800000); // 6.000.000 + 1.800.000

    const vip = rfm.customers.find(c => c.phone === '0901234567');
    assert.ok(vip);
    assert.equal(vip.segment, 'champions');
    assert.equal(vip.orderCount, 3);
    assert.equal(vip.totalSpendVnd, 6000000);
    assert.equal(vip.scores.r, 5);
    assert.equal(vip.scores.f, 4);
    assert.equal(vip.scores.m, 5);

    const risk = rfm.customers.find(c => c.phone === '0909999999');
    assert.ok(risk);
    assert.equal(risk.segment, 'at_risk');
    assert.equal(risk.orderCount, 2);
    assert.equal(risk.scores.r, 2);

    const cancelled = rfm.customers.find(c => c.phone === '0900000000');
    assert.equal(cancelled, undefined);
  });

  await t.test('3. Summary includes all 5 segments with accurate percentage and revenue aggregation', async () => {
    const rfm = await getRfmCustomerSegmentation(pool);
    assert.equal(rfm.summary.length, 5);

    const championsSummary = rfm.summary.find(s => s.key === 'champions');
    assert.equal(championsSummary.customerCount, 1);
    assert.equal(championsSummary.percentage, 50.0);
    assert.equal(championsSummary.totalRevenueVnd, 6000000);

    const atRiskSummary = rfm.summary.find(s => s.key === 'at_risk');
    assert.equal(atRiskSummary.customerCount, 1);
    assert.equal(atRiskSummary.percentage, 50.0);
    assert.equal(atRiskSummary.totalRevenueVnd, 1800000);
  });

  await t.test('4. Admin Router exposes GET /customers/rfm and GET /customers/rfm/sync-marketing', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.admin = { id: 'admin_1', permissions: ['customers.read', 'customers.write'] };
      next();
    });
    app.use(createRfmAdminRouter(pool));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const port = server.address().port;

    try {
      // 1. Test GET /customers/rfm
      const getRes = await fetch(`http://127.0.0.1:${port}/customers/rfm`);
      assert.equal(getRes.status, 200);
      const data = await getRes.json();
      assert.equal(data.totalCustomers, 2);
      assert.equal(data.summary.length, 5);

      // 2. Test GET /customers/rfm/sync-marketing
      const syncRes = await fetch(`http://127.0.0.1:${port}/customers/rfm/sync-marketing`);
      assert.equal(syncRes.status, 200);
      const syncJson = await syncRes.json();
      assert.equal(syncJson.success, true);
      assert.equal(syncJson.segments.atRisk.count, 1);
      assert.equal(syncJson.segments.champions.count, 1);
      assert.ok(syncJson.segments.atRisk.campaignSuggestion.includes('Ưu đãi tri ân'));
    } finally {
      server.close();
    }
  });
});
