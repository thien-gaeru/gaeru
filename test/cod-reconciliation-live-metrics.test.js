'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDb } = require('./helpers/pglite-db');
const {
  processCodReconciliation,
  createCodReconciliationAdmin
} = require('../src/cod-reconciliation');

test('COD Financial Reconciliation: Multi-carrier matching, fee deduction, auto payment completion, discrepancy detection, and admin API', async (t) => {
  const { pool } = await createTestDb({ migrate: false });

  // 0. Tạo bảng
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_number text UNIQUE NOT NULL,
      customer_name text NOT NULL,
      payment_method text NOT NULL DEFAULT 'cod',
      payment_status text NOT NULL DEFAULT 'pending',
      status text NOT NULL DEFAULT 'shipped',
      total_vnd bigint NOT NULL,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS cod_reconciliations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_code text UNIQUE NOT NULL,
      carrier text NOT NULL DEFAULT 'spx',
      total_orders integer NOT NULL DEFAULT 0,
      total_collected_vnd bigint NOT NULL DEFAULT 0,
      total_fee_vnd bigint NOT NULL DEFAULT 0,
      net_transferred_vnd bigint NOT NULL DEFAULT 0,
      file_name text NOT NULL,
      status text NOT NULL DEFAULT 'reconciled' CHECK (status IN ('reconciled', 'discrepancy')),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS cod_reconciliation_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id uuid NOT NULL REFERENCES cod_reconciliations(id) ON DELETE CASCADE,
      tracking_code text NOT NULL,
      order_code text,
      order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
      system_cod_vnd bigint NOT NULL DEFAULT 0,
      carrier_collected_vnd bigint NOT NULL DEFAULT 0,
      fee_vnd bigint NOT NULL DEFAULT 0,
      discrepancy_vnd bigint NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'matched' CHECK (status IN ('matched', 'mismatch', 'not_found', 'overdue')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    INSERT INTO orders (order_number, customer_name, payment_method, payment_status, status, total_vnd, note) VALUES
    ('ORD-COD-101', 'Khách COD 1', 'cod', 'pending', 'shipped', 600000, 'SPX: SPX101010'),
    ('ORD-COD-102', 'Khách COD 2', 'cod', 'pending', 'shipped', 900000, 'GHN: GHN202020'),
    ('ORD-MOMO-103', 'Khách MoMo', 'momo', 'pending', 'shipped', 400000, 'MoMo Order');
  `);

  t.after(async () => {
    await pool.end().catch(() => {});
  });

  await t.test('1. processCodReconciliation matches order and automatically marks as paid & completed', async () => {
    const res = await processCodReconciliation(pool, {
      carrier: 'spx',
      fileName: 'spx_batch_01.csv',
      items: [
        { trackingCode: 'SPX101010', orderCode: 'ORD-COD-101', carrierCollectedVnd: 600000, feeVnd: 30000 }
      ]
    });

    assert.equal(res.ok, true);
    assert.equal(res.totalOrders, 1);
    assert.equal(res.totalCollectedVnd, 600000);
    assert.equal(res.totalFeeVnd, 30000);
    assert.equal(res.netTransferredVnd, 570000);
    assert.equal(res.status, 'reconciled');

    const order = (await pool.query(`SELECT status, payment_status FROM orders WHERE order_number = 'ORD-COD-101'`)).rows[0];
    assert.equal(order.payment_status, 'paid');
    assert.equal(order.status, 'completed');
  });

  await t.test('2. Discrepancy detection: flags mismatch and retains pending payment status', async () => {
    const res = await processCodReconciliation(pool, {
      carrier: 'ghn',
      fileName: 'ghn_batch_02.csv',
      items: [
        // Thu 850k thay vì 900k -> Lệch -50k
        { trackingCode: 'GHN202020', orderCode: 'ORD-COD-102', carrierCollectedVnd: 850000, feeVnd: 40000 }
      ]
    });

    assert.equal(res.ok, true);
    assert.equal(res.status, 'discrepancy');

    const order = (await pool.query(`SELECT payment_status FROM orders WHERE order_number = 'ORD-COD-102'`)).rows[0];
    assert.equal(order.payment_status, 'pending'); // Giữ nguyên pending, không tự động đổi sang paid

    const item = (await pool.query(`SELECT status, discrepancy_vnd FROM cod_reconciliation_items WHERE order_code = 'ORD-COD-102'`)).rows[0];
    assert.equal(item.status, 'mismatch');
    assert.equal(Number(item.discrepancy_vnd), -50000);
  });

  await t.test('3. Online gateway protection: never overrides online gateway payment status', async () => {
    const res = await processCodReconciliation(pool, {
      carrier: 'spx',
      fileName: 'spx_fake_momo.csv',
      items: [
        { trackingCode: 'FAKE_TRACK', orderCode: 'ORD-MOMO-103', carrierCollectedVnd: 400000, feeVnd: 20000 }
      ]
    });

    assert.equal(res.ok, true);

    const order = (await pool.query(`SELECT payment_status FROM orders WHERE order_number = 'ORD-MOMO-103'`)).rows[0];
    assert.equal(order.payment_status, 'pending'); // Không cho phép bảng kê COD ghi đè cổng MoMo
  });

  await t.test('4. Admin Router provides batch listing and detailed line item breakdown', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.admin = { id: 'admin_1', username: 'finance_lead', permissions: ['payments.write', 'finance.read'] };
      next();
    });
    app.use('/api/gaeru_ceo', createCodReconciliationAdmin(pool));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      const listRes = await fetch(`${base}/api/gaeru_ceo/cod/batches`);
      assert.equal(listRes.status, 200);
      const listData = await listRes.json();
      assert.ok(listData.batches.length >= 2);

      const batchId = listData.batches[0].id;
      const detailRes = await fetch(`${base}/api/gaeru_ceo/cod/batches/${batchId}`);
      assert.equal(detailRes.status, 200);
      const detailData = await detailRes.json();
      assert.ok(detailData.batch);
      assert.ok(Array.isArray(detailData.items));

      // Reject empty items
      const failRes = await fetch(`${base}/api/gaeru_ceo/cod/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [] })
      });
      assert.equal(failRes.status, 400);
    } finally {
      server.close();
    }
  });
});
