'use strict';

const express = require('express');

const TIERS = [
  { id: 'diamond', name: 'Kim Cương', minPoints: 10000, multiplier: 1.15, perk: 'Miễn phí vận chuyển & Tích 115% điểm' },
  { id: 'gold', name: 'Vàng', minPoints: 5000, multiplier: 1.10, perk: 'Chăm sóc ưu tiên & Tích 110% điểm' },
  { id: 'silver', name: 'Bạc', minPoints: 1000, multiplier: 1.05, perk: 'Ưu đãi sinh nhật & Tích 105% điểm' },
  { id: 'standard', name: 'Thành viên', minPoints: 0, multiplier: 1.0, perk: 'Tích 1% điểm mỗi đơn hàng' }
];

function calculateTier(lifetimePoints) {
  const points = Math.max(0, Number(lifetimePoints) || 0);
  for (const tier of TIERS) {
    if (points >= tier.minPoints) return tier.id;
  }
  return 'standard';
}

async function getLoyaltyProfile(pool, customerId) {
  if (!customerId) return null;
  const result = await pool.query(
    `SELECT points, lifetime_points AS "lifetimePoints", tier, updated_at AS "updatedAt"
     FROM customer_loyalty
     WHERE customer_id = $1`,
    [customerId]
  );

  let profile = result.rows[0];
  if (!profile) {
    const inserted = await pool.query(
      `INSERT INTO customer_loyalty (customer_id, points, lifetime_points, tier)
       VALUES ($1, 0, 0, 'standard')
       ON CONFLICT (customer_id) DO NOTHING
       RETURNING points, lifetime_points AS "lifetimePoints", tier, updated_at AS "updatedAt"`,
      [customerId]
    );
    profile = inserted.rows[0] || { points: 0, lifetimePoints: 0, tier: 'standard' };
  }

  const tierInfo = TIERS.find(t => t.id === profile.tier) || TIERS[3];
  const history = await pool.query(
    `SELECT id, order_id AS "orderId", points_change AS "pointsChange", balance_after AS "balanceAfter", reason, created_at AS "createdAt"
     FROM loyalty_transactions
     WHERE customer_id = $1
     ORDER BY created_at DESC
     LIMIT 15`,
    [customerId]
  );

  return {
    ...profile,
    tierName: tierInfo.name,
    tierPerk: tierInfo.perk,
    discountRateVnd: 1, // 1 point = 1 VND discount
    maxRedeemableVnd: Number(profile.points),
    history: history.rows
  };
}

async function addLoyaltyPoints(pool, { customerId, orderId = null, amountVnd, reason = 'Tích điểm đơn hàng' }) {
  if (!customerId) return null;
  const spend = Math.max(0, Number(amountVnd) || 0);
  if (spend <= 0) return null;

  const current = await getLoyaltyProfile(pool, customerId);
  const tierInfo = TIERS.find(t => t.id === current.tier) || TIERS[3];
  const basePoints = Math.floor(spend * 0.01); // 1%
  const pointsToAdd = Math.max(1, Math.round(basePoints * tierInfo.multiplier));

  const newPoints = Number(current.points) + pointsToAdd;
  const newLifetime = Number(current.lifetimePoints) + pointsToAdd;
  const newTier = calculateTier(newLifetime);

  await pool.query(
    `UPDATE customer_loyalty
     SET points = $1, lifetime_points = $2, tier = $3, updated_at = now()
     WHERE customer_id = $4`,
    [newPoints, newLifetime, newTier, customerId]
  );

  await pool.query(
    `INSERT INTO loyalty_transactions (customer_id, order_id, points_change, balance_after, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [customerId, orderId, pointsToAdd, newPoints, reason]
  );

  return { pointsAdded: pointsToAdd, balance: newPoints, tier: newTier };
}

async function redeemLoyaltyPoints(pool, { customerId, pointsToRedeem, orderId = null }) {
  if (!customerId) throw Object.assign(new Error('Khách hàng không hợp lệ.'), { status: 400 });
  const points = Math.max(0, Number(pointsToRedeem) || 0);
  if (points <= 0) return { discountVnd: 0, balance: 0 };

  const current = await getLoyaltyProfile(pool, customerId);
  if (current.points < points) {
    throw Object.assign(new Error(`Số điểm hiện có (${current.points} điểm) không đủ để quy đổi ${points} điểm.`), { status: 400 });
  }

  const newPoints = Number(current.points) - points;
  await pool.query(
    `UPDATE customer_loyalty
     SET points = $1, updated_at = now()
     WHERE customer_id = $2`,
    [newPoints, customerId]
  );

  await pool.query(
    `INSERT INTO loyalty_transactions (customer_id, order_id, points_change, balance_after, reason)
     VALUES ($1, $2, $3, $4, 'Quy đổi điểm giảm giá đơn hàng')`,
    [customerId, orderId, -points, newPoints]
  );

  return {
    discountVnd: points, // 1 point = 1 VND
    redeemedPoints: points,
    balance: newPoints
  };
}

function createLoyaltyCustomerApi(pool) {
  const router = express.Router();

  router.get('/loyalty', async (req, res, next) => {
    try {
      const customerId = req.session?.customer?.id;
      if (!customerId) return res.status(401).json({ error: 'Vui lòng đăng nhập để xem thông tin điểm thưởng.' });
      const profile = await getLoyaltyProfile(pool, customerId);
      res.json(profile);
    } catch (err) {
      next(err);
    }
  });

  router.post('/loyalty/quote', express.json(), async (req, res, next) => {
    try {
      const customerId = req.session?.customer?.id;
      if (!customerId) return res.status(401).json({ error: 'Vui lòng đăng nhập để dùng điểm thưởng.' });
      const points = Math.max(0, Number(req.body?.points) || 0);
      const profile = await getLoyaltyProfile(pool, customerId);
      const usable = Math.min(profile.points, points);
      res.json({
        ok: true,
        requestedPoints: points,
        usablePoints: usable,
        discountVnd: usable
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function createLoyaltyAdminApi(pool) {
  const router = express.Router();

  router.get('/loyalty/members', async (req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT c.id, c.full_name AS "fullName", c.email, c.phone,
               COALESCE(l.points, 0) AS points,
               COALESCE(l.lifetime_points, 0) AS "lifetimePoints",
               COALESCE(l.tier, 'standard') AS tier,
               l.updated_at AS "updatedAt"
        FROM customers c
        LEFT JOIN customer_loyalty l ON l.customer_id = c.id
        ORDER BY l.lifetime_points DESC NULLS LAST
        LIMIT 50
      `);
      res.json({ members: result.rows, tiers: TIERS });
    } catch (err) {
      next(err);
    }
  });

  router.post('/loyalty/adjust', express.json(), async (req, res, next) => {
    try {
      const { customerId, pointsChange, reason } = req.body || {};
      const delta = Number(pointsChange);
      if (!customerId || !Number.isInteger(delta) || delta === 0) {
        return res.status(400).json({ error: 'Cần chỉ định customerId và pointsChange (số nguyên khác 0).' });
      }
      const current = await getLoyaltyProfile(pool, customerId);
      const newPoints = Math.max(0, Number(current.points) + delta);
      const newLifetime = Math.max(0, Number(current.lifetimePoints) + (delta > 0 ? delta : 0));
      const newTier = calculateTier(newLifetime);

      await pool.query(
        `UPDATE customer_loyalty SET points = $1, lifetime_points = $2, tier = $3, updated_at = now() WHERE customer_id = $4`,
        [newPoints, newLifetime, newTier, customerId]
      );
      await pool.query(
        `INSERT INTO loyalty_transactions (customer_id, points_change, balance_after, reason) VALUES ($1, $2, $3, $4)`,
        [customerId, delta, newPoints, reason || 'Điều chỉnh điểm bởi quản trị viên']
      );

      res.json({ ok: true, balance: newPoints, tier: newTier });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  calculateTier,
  getLoyaltyProfile,
  addLoyaltyPoints,
  redeemLoyaltyPoints,
  createLoyaltyCustomerApi,
  createLoyaltyAdminApi,
  TIERS
};
