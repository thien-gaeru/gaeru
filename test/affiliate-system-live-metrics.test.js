'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDb } = require('./helpers/pglite-db');
const {
  registerPartner,
  attributeOrderCommission,
  createAffiliatePublicRouter,
  createAffiliateAdminRouter
} = require('../src/affiliate-system');

test('Affiliate System: Partner registration, 30-day cookie tracking, anti-open-redirect, order attribution, and finance commission lifecycle', async (t) => {
  const { pool } = await createTestDb({ migrate: false });

  // 0. Tạo bảng
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_number text UNIQUE NOT NULL,
      customer_name text NOT NULL,
      total_vnd bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS affiliate_partners (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_code text UNIQUE NOT NULL,
      name text NOT NULL,
      email text,
      phone text,
      commission_percent numeric(5,2) NOT NULL DEFAULT 8.00 CHECK (commission_percent >= 0 AND commission_percent <= 50),
      bank_name text,
      bank_account text,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'terminated')),
      total_earnings_vnd bigint NOT NULL DEFAULT 0,
      total_orders integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS affiliate_commissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      partner_code text NOT NULL,
      order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
      order_code text NOT NULL,
      order_total_vnd bigint NOT NULL,
      commission_vnd bigint NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'cancelled')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  t.after(async () => {
    await pool.end().catch(() => {});
  });

  await t.test('1. registerPartner validates required fields and sets commission percent', async () => {
    const partner = await registerPartner(pool, {
      partnerCode: 'koc_reviewer_ha',
      name: 'Hà KOC Studio',
      commissionPercent: 12.5,
      bankName: 'Vietcombank',
      bankAccount: '10123456789'
    });

    assert.equal(partner.partnerCode, 'KOC_REVIEWER_HA');
    assert.equal(partner.name, 'Hà KOC Studio');
    assert.equal(Number(partner.commissionPercent), 12.5);
    assert.equal(partner.status, 'active');

    // Thiếu tên hoặc mã phải báo lỗi 400
    await assert.rejects(
      async () => registerPartner(pool, { partnerCode: '' }),
      /Mã đối tác/
    );
  });

  await t.test('2. Public Router sets 30-day cookie and blocks open-redirect phishing', async () => {
    const app = express();
    app.use('/api', createAffiliatePublicRouter(pool));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      // Hợp lệ: chuyển hướng relative path
      const okRes = await fetch(`${base}/api/affiliate/track?ref=KOC_REVIEWER_HA&redirect=/products/speaker-m3`, {
        redirect: 'manual'
      });
      assert.equal(okRes.status, 302);
      assert.equal(okRes.headers.get('location'), '/products/speaker-m3');
      const cookie = okRes.headers.get('set-cookie');
      assert.match(cookie, /gaeru_affiliate_ref=KOC_REVIEWER_HA/);
      assert.match(cookie, /Max-Age=2592000/);

      // Độc hại: redirect ra ngoài domain
      const evilRes = await fetch(`${base}/api/affiliate/track?ref=KOC_REVIEWER_HA&redirect=https://phishing.com`, {
        redirect: 'manual'
      });
      assert.equal(evilRes.status, 302);
      assert.equal(evilRes.headers.get('location'), '/');
    } finally {
      server.close();
    }
  });

  await t.test('3. attributeOrderCommission calculates percentage and updates partner stats', async () => {
    const ord = (await pool.query(`INSERT INTO orders (order_number, customer_name, total_vnd) VALUES ('ORD-TEST-01', 'Khách Demo', 2000000) RETURNING id`)).rows[0];

    const comm = await attributeOrderCommission(pool, {
      orderId: ord.id,
      orderCode: 'ORD-TEST-01',
      totalVnd: 2000000,
      partnerCode: 'KOC_REVIEWER_HA'
    });

    // 12.5% của 2.000.000₫ = 250.000₫
    assert.equal(Number(comm.commissionVnd), 250000);
    assert.equal(comm.status, 'pending');

    const partner = (await pool.query(`SELECT * FROM affiliate_partners WHERE partner_code = 'KOC_REVIEWER_HA'`)).rows[0];
    assert.equal(Number(partner.total_earnings_vnd), 250000);
    assert.equal(partner.total_orders, 1);
  });

  await t.test('4. Admin Router provides leaderboard and updates commission payment status', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.admin = { id: 'admin_test', username: 'finance_admin', permissions: ['marketing.read', 'marketing.write', 'finance.read', 'finance.write'] };
      next();
    });
    app.use('/api/gaeru_ceo', createAffiliateAdminRouter(pool));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      // Xem danh sách đối tác
      const listRes = await fetch(`${base}/api/gaeru_ceo/affiliates`);
      assert.equal(listRes.status, 200);
      const listData = await listRes.json();
      assert.equal(listData.partners.length, 1);
      assert.equal(listData.partners[0].partnerCode, 'KOC_REVIEWER_HA');

      // Xem danh sách hoa hồng
      const commsRes = await fetch(`${base}/api/gaeru_ceo/affiliates/commissions`);
      assert.equal(commsRes.status, 200);
      const commsData = await commsRes.json();
      assert.equal(commsData.commissions.length, 1);
      const commId = commsData.commissions[0].id;

      // Duyệt và chi trả: pending -> paid
      const updateRes = await fetch(`${base}/api/gaeru_ceo/affiliates/commissions/${commId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'paid' })
      });
      assert.equal(updateRes.status, 200);

      const check = (await pool.query(`SELECT status FROM affiliate_commissions WHERE id = $1`, [commId])).rows[0];
      assert.equal(check.status, 'paid');
    } finally {
      server.close();
    }
  });
});
