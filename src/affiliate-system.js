'use strict';

const express = require('express');

async function registerPartner(pool, { partnerCode, name, email = null, phone = null, commissionPercent = 8.0, bankName = null, bankAccount = null }) {
  const code = String(partnerCode || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const partnerName = String(name || '').trim();
  const rate = Math.max(0, Math.min(50, Number(commissionPercent) || 8.0));

  if (!code || !partnerName) {
    throw Object.assign(new Error('Mã đối tác (partnerCode) và Tên đối tác (name) là bắt buộc.'), { status: 400 });
  }

  const result = await pool.query(
    `INSERT INTO affiliate_partners (partner_code, name, email, phone, commission_percent, bank_name, bank_account, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
     RETURNING id, partner_code AS "partnerCode", name, email, phone, commission_percent AS "commissionPercent",
               bank_name AS "bankName", bank_account AS "bankAccount", status,
               total_earnings_vnd AS "totalEarningsVnd", total_orders AS "totalOrders", created_at AS "createdAt"`,
    [code, partnerName, email, phone, rate, bankName, bankAccount]
  );
  return result.rows[0];
}

async function attributeOrderCommission(pool, { orderId, orderCode, totalVnd, partnerCode }) {
  const code = String(partnerCode || '').trim().toUpperCase();
  const total = Math.max(0, Number(totalVnd) || 0);
  if (!code || total <= 0) return null;

  const partnerRes = await pool.query(
    `SELECT id, partner_code AS "partnerCode", commission_percent AS "commissionPercent", status
     FROM affiliate_partners
     WHERE partner_code = $1 AND status = 'active'`,
    [code]
  );
  if (!partnerRes.rows.length) return null;
  const partner = partnerRes.rows[0];

  const rate = Number(partner.commissionPercent) || 8.0;
  const commissionVnd = Math.round(total * (rate / 100));

  const commRes = await pool.query(
    `INSERT INTO affiliate_commissions (partner_code, order_id, order_code, order_total_vnd, commission_vnd, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING id, partner_code AS "partnerCode", order_id AS "orderId", order_code AS "orderCode",
               order_total_vnd AS "orderTotalVnd", commission_vnd AS "commissionVnd", status, created_at AS "createdAt"`,
    [code, orderId || null, orderCode, total, commissionVnd]
  );

  await pool.query(
    `UPDATE affiliate_partners
     SET total_earnings_vnd = total_earnings_vnd + $1,
         total_orders = total_orders + 1,
         updated_at = now()
     WHERE partner_code = $2`,
    [commissionVnd, code]
  );

  return commRes.rows[0];
}

function createAffiliatePublicRouter(pool) {
  const router = express.Router();

  router.get('/affiliate/track', (req, res) => {
    const code = String(req.query.ref || '').trim().toUpperCase();
    if (code) {
      res.cookie('gaeru_affiliate_ref', code, {
        maxAge: 30 * 24 * 3600 * 1000, // 30 days
        httpOnly: true,
        sameSite: 'lax'
      });
    }
    // ─── P2 FIX: Chặn open redirect ──────────────────────────────────────────
    // Chỉ chấp nhận relative path bắt đầu bằng một dấu / và không có //
    // để tránh redirect sang domain khác qua //evil.com, backslash, scheme...
    const rawRedirect = String(req.query.redirect || '/');
    let safeRedirect = '/';
    // Chuẩn hóa: loại encode bậc cao, kiểm tra không có scheme/host
    try {
      const decoded = decodeURIComponent(rawRedirect).replace(/\\/g, '/');
      // Hợp lệ: bắt đầu bằng / và KHÔNG phải // (chặn //evil.com)
      if (/^\/(?!\/)/.test(decoded) && !/^\/[A-Za-z]+:/.test(decoded)) {
        safeRedirect = decoded;
      }
    } catch { /* giữ '/' */ }
    res.redirect(safeRedirect);
  });

  return router;
}

function createAffiliateAdminRouter(pool) {
  const router = express.Router();
  const { requirePermission } = require('./staff-access');
  const { requireCsrf } = require('./security');

  const { requireAdminAction } = require('./admin-action');
  const guardPermission = (permission) => requireAdminAction(permission);

  router.get('/affiliates', async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT id, partner_code AS "partnerCode", name, email, phone, commission_percent AS "commissionPercent",
               bank_name AS "bankName", bank_account AS "bankAccount", status,
               total_earnings_vnd AS "totalEarningsVnd", total_orders AS "totalOrders", created_at AS "createdAt"
        FROM affiliate_partners
        ORDER BY total_earnings_vnd DESC
      `);
      res.json({ partners: result.rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/affiliates', guardPermission('marketing.write'), express.json(), async (req, res, next) => {
    try {
      const partner = await registerPartner(pool, req.body || {});
      res.status(201).json({ ok: true, partner });
    } catch (err) {
      next(err);
    }
  });

  router.get('/affiliates/commissions', async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT id, partner_code AS "partnerCode", order_id AS "orderId", order_code AS "orderCode",
               order_total_vnd AS "orderTotalVnd", commission_vnd AS "commissionVnd", status, created_at AS "createdAt"
        FROM affiliate_commissions
        ORDER BY created_at DESC
        LIMIT 100
      `);
      res.json({ commissions: result.rows });
    } catch (err) {
      next(err);
    }
  });

  router.put('/affiliates/commissions/:id/status', guardPermission('finance.write'), express.json(), async (req, res, next) => {
    try {
      const { status } = req.body || {};
      if (!['pending', 'approved', 'paid', 'cancelled'].includes(status)) {
        return res.status(400).json({ error: 'Trạng thái hoa hồng không hợp lệ.' });
      }
      await pool.query(
        `UPDATE affiliate_commissions SET status = $1, updated_at = now() WHERE id = $2`,
        [status, req.params.id]
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  registerPartner,
  attributeOrderCommission,
  createAffiliatePublicRouter,
  createAffiliateAdminRouter
};
