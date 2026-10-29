'use strict';
const { Router } = require('express');
const { z } = require('zod');
const { crypto } = require('node:crypto');

const BNPL_PROVIDERS = {
  fundiin: { name: 'Fundiin - Mua trước trả sau 0%', minAmount: 300000, maxAmount: 30000000, defaultInstallments: 3 },
  kredivo: { name: 'Kredivo - Mua trước trả sau', minAmount: 500000, maxAmount: 25000000, defaultInstallments: 3 }
};

function calculateInstallments(amountVnd, installmentsCount = 3) {
  const amount = Number(amountVnd) || 0;
  const count = [3, 4, 6, 12].includes(Number(installmentsCount)) ? Number(installmentsCount) : 3;

  if (amount < 300000) {
    return {
      eligible: false,
      message: 'Đơn hàng tối thiểu 300.000đ để áp dụng hình thức Mua trước trả sau.',
      amountVnd: amount,
      installments: []
    };
  }

  const perInstallment = Math.ceil(amount / count);
  const now = new Date();
  const schedule = [];

  for (let i = 0; i < count; i++) {
    const dueDate = new Date(now);
    dueDate.setDate(dueDate.getDate() + i * 30);
    schedule.push({
      period: i + 1,
      amountVnd: i === count - 1 ? amount - perInstallment * (count - 1) : perInstallment,
      dueDate: dueDate.toISOString().slice(0, 10),
      isToday: i === 0
    });
  }

  return {
    eligible: true,
    amountVnd: amount,
    installmentsCount: count,
    installmentAmountVnd: perInstallment,
    monthlyVnd: perInstallment,
    schedule,
    providers: [
      { id: 'fundiin', name: 'Fundiin (0% lãi suất)', badge: 'Khuyên dùng' },
      { id: 'kredivo', name: 'Kredivo (3-6 tháng)', badge: 'Linh hoạt' }
    ]
  };
}

async function createBnplTransaction(pool, { orderId = null, orderNumber, provider = 'fundiin', amountVnd, installmentsCount = 3, customerPhone = '' }) {
  const count = [3, 4, 6, 12].includes(Number(installmentsCount)) ? Number(installmentsCount) : 3;
  const amount = Number(amountVnd) || 0;
  const perInstallment = Math.ceil(amount / count);
  const txId = `BNPL-${provider.toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;

  const res = await pool.query(
    `INSERT INTO bnpl_transactions (order_id, order_number, provider, transaction_id, amount_vnd, installments_count, installment_amount_vnd, status, customer_phone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
     RETURNING *`,
    [orderId, orderNumber, provider, txId, amount, count, perInstallment, customerPhone]
  );

  return {
    transaction: res.rows[0],
    redirectUrl: `/payment-result.html?provider=${provider}&order=${encodeURIComponent(orderNumber)}&tx=${txId}&bnpl=1`
  };
}

async function handleBnplCallback(pool, { transactionId, status, gatewayResponse = {} }) {
  const normStatus = ['approved', 'settled', 'rejected', 'cancelled'].includes(status) ? status : 'approved';
  const updated = await pool.query(
    `UPDATE bnpl_transactions
     SET status = $1, gateway_response = $2, updated_at = now()
     WHERE transaction_id = $3
     RETURNING *`,
    [normStatus, JSON.stringify(gatewayResponse), transactionId]
  );

  if (!updated.rows.length) {
    return { success: false, error: 'Không tìm thấy giao dịch BNPL.' };
  }

  const tx = updated.rows[0];
  if (['approved', 'settled'].includes(normStatus) && tx.order_number) {
    await pool.query(
      `UPDATE orders SET payment_status = 'paid', updated_at = now() WHERE order_number = $1`,
      [tx.order_number]
    );
  }

  return { success: true, transaction: tx };
}

function createBnplPublicRouter(pool) {
  const router = Router();

  router.get('/payments/bnpl/calculate', (req, res) => {
    const amount = Number(req.query.amount) || 0;
    const count = Number(req.query.installments) || 3;
    const result = calculateInstallments(amount, count);
    res.json(result);
  });

  router.post('/payments/bnpl/create', async (req, res, next) => {
    try {
      const { orderNumber, amountVnd, provider, installmentsCount, customerPhone } = req.body || {};
      if (!orderNumber || !amountVnd) {
        return res.status(400).json({ error: 'Thiếu thông tin mã đơn hàng hoặc số tiền.' });
      }
      const result = await createBnplTransaction(pool, {
        orderNumber,
        amountVnd,
        provider: provider || 'fundiin',
        installmentsCount: installmentsCount || 3,
        customerPhone: customerPhone || ''
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/payments/bnpl/ipn', async (req, res, next) => {
    try {
      const { transactionId, status } = req.body || {};
      if (!transactionId) return res.status(400).json({ error: 'Thiếu transactionId' });
      const result = await handleBnplCallback(pool, {
        transactionId,
        status: status || 'approved',
        gatewayResponse: req.body
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function createBnplAdminRouter(pool) {
  const router = Router();
  router.get('/bnpl/transactions', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM bnpl_transactions ORDER BY created_at DESC LIMIT 100`
      );
      res.json({ transactions: rows });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

module.exports = {
  calculateInstallments,
  createBnplTransaction,
  handleBnplCallback,
  createBnplPublicRouter,
  createBnplAdminRouter,
  BNPL_PROVIDERS
};
