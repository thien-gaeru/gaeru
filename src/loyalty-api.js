const { Router } = require('express');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { withTransaction } = require('./db');
const { requireCsrf } = require('./security');
const { requirePermission } = require('./staff-access');
const { appendAudit } = require('./audit');

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const TIER_NAMES = Object.freeze({ bronze: 'Thành viên Đồng', silver: 'Thành viên Bạc', gold: 'Thành viên Vàng', platinum: 'Thành viên Bạch Kim' });
const DEFAULT_POLICY = Object.freeze({ version: 0, tiers: Object.freeze([
  { id: 'bronze', minPoints: 0, earnBasisPoints: 100 },
  { id: 'silver', minPoints: 100000, earnBasisPoints: 120 },
  { id: 'gold', minPoints: 500000, earnBasisPoints: 150 },
  { id: 'platinum', minPoints: 2000000, earnBasisPoints: 200 }
]) });
const policySchema = z.object({ version: z.number().int().min(0), tiers: z.array(z.object({
  id: z.enum(['bronze', 'silver', 'gold', 'platinum']),
  minPoints: z.number().int().min(0).max(2000000000),
  earnBasisPoints: z.number().int().min(0).max(10000)
}).strict()).length(4) }).strict().refine(value => value.tiers.every((tier, i, tiers) =>
  tier.id === ['bronze', 'silver', 'gold', 'platinum'][i] && (i === 0 ? tier.minPoints === 0 : tier.minPoints > tiers[i - 1].minPoints)
), 'Ngưỡng hạng phải tăng dần, hạng Đồng bắt đầu từ 0.');
async function readPolicy(client) {
  const row = (await client.query("SELECT setting_value FROM store_settings WHERE setting_key='loyalty_policy'")).rows[0];
  if (!row) return DEFAULT_POLICY;
  const parsed = policySchema.safeParse(row.setting_value);
  if (!parsed.success) throw fail('Chính sách GAERU Xu chưa hợp lệ; vui lòng kiểm tra cấu hình.', 503);
  return parsed.data;
}
function tierBenefits(policy) {
  return Object.fromEntries(policy.tiers.map(tier => [tier.id, { name: TIER_NAMES[tier.id], minPoints: tier.minPoints, earnBasisPoints: tier.earnBasisPoints, earnRate: `${tier.earnBasisPoints / 100}%` }]));
}
function calculateTier(lifetimeEarned, policy = DEFAULT_POLICY) {
  const points = Number(lifetimeEarned) || 0;
  return [...policy.tiers].reverse().find(tier => points >= tier.minPoints)?.id || 'bronze';
}

// -----------------------------------------------------------------------------
// CORE CONCURRENCY-SAFE LOYALTY LEDGER
// -----------------------------------------------------------------------------
async function getOrCreateLoyalty(client, customerId) {
  const sel = await client.query(
    `SELECT customer_id AS "customerId", points_balance AS "pointsBalance",
            lifetime_earned AS "lifetimeEarned", lifetime_spent AS "lifetimeSpent",
            tier, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM customer_loyalty WHERE customer_id = $1 FOR UPDATE`,
    [customerId]
  );
  if (sel.rows.length) return sel.rows[0];

  const ins = await client.query(
    `INSERT INTO customer_loyalty (customer_id, points_balance, lifetime_earned, lifetime_spent, tier)
     VALUES ($1, 0, 0, 0, 'bronze')
     ON CONFLICT (customer_id) DO UPDATE SET customer_id = EXCLUDED.customer_id
     RETURNING customer_id AS "customerId", points_balance AS "pointsBalance",
               lifetime_earned AS "lifetimeEarned", lifetime_spent AS "lifetimeSpent",
               tier, created_at AS "createdAt", updated_at AS "updatedAt"`,
    [customerId]
  );
  return ins.rows[0];
}

async function earnPoints(client, { customerId, orderId, orderTotalVnd, pointsRatio, reason, actor }) {
  if (!customerId) return null;

  const eventKey = `earn:${orderId}`;
  const existing = await client.query(
    `SELECT id, points, balance_after AS "balanceAfter"
     FROM customer_loyalty_ledger WHERE event_key = $1`,
    [eventKey]
  );
  if (existing.rows.length) {
    return { success: true, existing: true, earnedPoints: existing.rows[0].points, balanceAfter: existing.rows[0].balanceAfter };
  }

  const loyalty = await getOrCreateLoyalty(client, customerId);
  const policy = await readPolicy(client);
  const earningTier = calculateTier(loyalty.lifetimeEarned, policy);
  const earnBasisPoints = policy.tiers.find(tier => tier.id === earningTier).earnBasisPoints;
  const ratio = pointsRatio === undefined ? earnBasisPoints / 10000 : pointsRatio;
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1 || !Number.isSafeInteger(Number(orderTotalVnd)) || Number(orderTotalVnd) < 0) throw fail('Dữ liệu tích Xu không hợp lệ.');
  const points = Math.floor(Number(orderTotalVnd) * ratio);
  if (points <= 0) return { success: true, earnedPoints: 0 };
  const newBalance = loyalty.pointsBalance + points;
  const newLifetimeEarned = loyalty.lifetimeEarned + points;
  if (newBalance > 2147483647 || newLifetimeEarned > 2147483647) throw fail('Số dư Xu vượt giới hạn cho phép.', 409);
  const newTier = calculateTier(newLifetimeEarned, policy);

  await client.query(
    `UPDATE customer_loyalty
     SET points_balance = $2, lifetime_earned = $3, tier = $4, updated_at = now()
     WHERE customer_id = $1`,
    [customerId, newBalance, newLifetimeEarned, newTier]
  );

  const entry = await client.query(
    `INSERT INTO customer_loyalty_ledger (customer_id, order_id, type, points, balance_after, reason, event_key)
     VALUES ($1, $2, 'earn', $3, $4, $5, $6)
     RETURNING *`,
    [customerId, orderId || null, points, newBalance, reason || `Tích Xu từ đơn hàng #${orderId || ''} · ${TIER_NAMES[earningTier]} ${ratio * 100}% · Chính sách v${policy.version}`, eventKey]
  );

  if (actor) {
    await appendAudit(client, {
      actor,
      action: 'loyalty.earn',
      entityType: 'customer',
      entityId: customerId,
      metadata: { points, orderId, newBalance, tier: newTier, earningTier, earnBasisPoints: ratio * 10000, policyVersion: policy.version }
    });
  }

  return { success: true, existing: false, earnedPoints: points, balanceAfter: newBalance, tier: newTier, ledgerId: entry.rows[0].id };
}

async function redeemPoints(client, { customerId, orderId, pointsToRedeem, maxRedeemRatio = 0.5, orderTotalVnd, maxPayableVnd, cycleKey = null, reason, actor }) {
  if (!customerId) throw fail('Khách hàng cần đăng nhập để sử dụng GAERU Xu.', 401);
  let redeemAmount = Number(pointsToRedeem) || 0;
  if (!Number.isSafeInteger(redeemAmount) || redeemAmount < 0) {
    throw fail('Số lượng GAERU Xu sử dụng không hợp lệ.', 400);
  }
  if (redeemAmount === 0) return { success: true, redeemedPoints: 0, discountVnd: 0 };

  const eventKey = cycleKey ? `redeem:${orderId}:${cycleKey}` : `redeem:${orderId}`;
  const existing = await client.query(
    `SELECT id, points, balance_after AS "balanceAfter"
     FROM customer_loyalty_ledger WHERE event_key = $1`,
    [eventKey]
  );
  if (existing.rows.length) {
    const pts = Math.abs(existing.rows[0].points);
    return { success: true, existing: true, redeemedPoints: pts, discountVnd: pts, balanceAfter: existing.rows[0].balanceAfter };
  }

  if (orderTotalVnd !== undefined && orderTotalVnd !== null) {
    const maxAllowedByRatio = Math.max(0, Math.floor(Number(orderTotalVnd) * maxRedeemRatio));
    if (redeemAmount > maxAllowedByRatio) {
      throw fail(`Số Xu sử dụng vượt quá giới hạn cho phép (${new Intl.NumberFormat('vi-VN').format(maxAllowedByRatio)} Xu cho đơn này).`, 409);
    }
  }

  if (maxPayableVnd !== undefined && maxPayableVnd !== null) {
    const payableCap = Math.max(0, Math.floor(Number(maxPayableVnd)));
    redeemAmount = Math.min(redeemAmount, payableCap);
    if (redeemAmount <= 0) {
      return { success: true, existing: false, redeemedPoints: 0, discountVnd: 0 };
    }
  }

  const loyalty = await getOrCreateLoyalty(client, customerId);
  if (loyalty.pointsBalance < redeemAmount) {
    throw fail(`Số dư GAERU Xu không đủ (Hiện có: ${loyalty.pointsBalance} Xu, yêu cầu: ${redeemAmount} Xu).`, 409);
  }

  const newBalance = loyalty.pointsBalance - redeemAmount;
  const newLifetimeSpent = loyalty.lifetimeSpent + redeemAmount;

  await client.query(
    `UPDATE customer_loyalty
     SET points_balance = $2, lifetime_spent = $3, updated_at = now()
     WHERE customer_id = $1`,
    [customerId, newBalance, newLifetimeSpent]
  );

  const entry = await client.query(
    `INSERT INTO customer_loyalty_ledger (customer_id, order_id, type, points, balance_after, reason, event_key)
     VALUES ($1, $2, 'redeem', $3, $4, $5, $6)
     RETURNING *`,
    [customerId, orderId || null, -redeemAmount, newBalance, reason || `Tiêu Xu cho đơn hàng #${orderId || ''}`, eventKey]
  );

  if (actor) {
    await appendAudit(client, {
      actor,
      action: 'loyalty.redeem',
      entityType: 'customer',
      entityId: customerId,
      metadata: { redeemedPoints: redeemAmount, orderId, newBalance }
    });
  }

  return { success: true, existing: false, redeemedPoints: redeemAmount, discountVnd: redeemAmount, balanceAfter: newBalance, ledgerId: entry.rows[0].id };
}

async function refundPoints(client, { customerId, orderId, reason = 'Hoàn trả do đơn hủy hoặc trả hàng', actor }) {
  if (!customerId || !orderId) return { success: false, reason: 'Thiếu thông tin' };

  let refundedRedeem = 0;
  let revokedEarn = 0;
  let unrecoveredEarn = 0;

  // 1. Check net unrefunded redeemed points for this order -> Refund them
  const redeemAgg = (await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'redeem' THEN ABS(points) ELSE 0 END), 0)::int AS "totalRedeemed",
       COALESCE(SUM(CASE WHEN type = 'refund' AND event_key LIKE 'refund-redeem:%' THEN points ELSE 0 END), 0)::int AS "totalRefunded",
       COUNT(*) FILTER (WHERE type = 'refund' AND event_key LIKE 'refund-redeem:%')::int AS "refundCount"
     FROM customer_loyalty_ledger
     WHERE order_id = $1`,
    [orderId]
  )).rows[0];

  const pointsToRefund = Math.max(0, (redeemAgg?.totalRedeemed || 0) - (redeemAgg?.totalRefunded || 0));
  if (pointsToRefund > 0) {
    const refundCount = redeemAgg?.refundCount || 0;
    const refundEventKey = refundCount === 0 ? `refund-redeem:${orderId}` : `refund-redeem:${orderId}:${refundCount + 1}`;
    const checkRefund = await client.query('SELECT id FROM customer_loyalty_ledger WHERE event_key = $1', [refundEventKey]);
    if (!checkRefund.rows.length) {
      const loyalty = await getOrCreateLoyalty(client, customerId);
      const newBalance = loyalty.pointsBalance + pointsToRefund;
      const newSpent = Math.max(0, loyalty.lifetimeSpent - pointsToRefund);

      await client.query(
        `UPDATE customer_loyalty
         SET points_balance = $2, lifetime_spent = $3, updated_at = now()
         WHERE customer_id = $1`,
        [customerId, newBalance, newSpent]
      );

      await client.query(
        `INSERT INTO customer_loyalty_ledger (customer_id, order_id, type, points, balance_after, reason, event_key)
         VALUES ($1, $2, 'refund', $3, $4, $5, $6)`,
        [customerId, orderId, pointsToRefund, newBalance, `Hoàn lại Xu đã dùng cho đơn #${orderId}: ${reason}`, refundEventKey]
      );
      refundedRedeem = pointsToRefund;
    }
  }

  // 2. Check if order had earned points -> Revoke up to available balance (preserving ledger invariant)
  const earnEntry = await client.query(
    `SELECT points FROM customer_loyalty_ledger
     WHERE order_id = $1 AND type = 'earn'`,
    [orderId]
  );
  if (earnEntry.rows.length) {
    const pointsToRevoke = Math.abs(earnEntry.rows[0].points);
    const revokeEventKey = `refund-earn:${orderId}`;
    const checkRevoke = await client.query('SELECT id FROM customer_loyalty_ledger WHERE event_key = $1', [revokeEventKey]);
    if (!checkRevoke.rows.length && pointsToRevoke > 0) {
      const loyalty = await getOrCreateLoyalty(client, customerId);
      const actualRevoked = Math.min(loyalty.pointsBalance, pointsToRevoke);
      unrecoveredEarn = Math.max(0, pointsToRevoke - actualRevoked);
      const newBalance = loyalty.pointsBalance - actualRevoked;
      const newEarned = Math.max(0, loyalty.lifetimeEarned - pointsToRevoke);
      const newTier = calculateTier(newEarned, await readPolicy(client));

      await client.query(
        `UPDATE customer_loyalty
         SET points_balance = $2, lifetime_earned = $3, tier = $4, updated_at = now()
         WHERE customer_id = $1`,
        [customerId, newBalance, newEarned, newTier]
      );

      // Even a zero-balance reversal needs a durable replay marker.
      await client.query(
        `INSERT INTO customer_loyalty_ledger (customer_id, order_id, type, points, balance_after, reason, event_key)
         VALUES ($1, $2, 'refund', $3, $4, $5, $6)`,
        [customerId, orderId, -actualRevoked, newBalance, `Thu hồi Xu đã tích do hủy đơn #${orderId}: ${reason}`, revokeEventKey]
      );
      revokedEarn = actualRevoked;
    }
  }

  if (actor && (refundedRedeem > 0 || revokedEarn > 0 || unrecoveredEarn > 0)) {
    await appendAudit(client, {
      actor,
      action: 'loyalty.refund',
      entityType: 'customer',
      entityId: customerId,
      metadata: { orderId, refundedRedeem, revokedEarn, unrecoveredEarn, reason }
    });
  }

  return { success: true, refundedRedeem, revokedEarn, unrecoveredEarn };
}

async function adjustPoints(pool, { customerId, points, reason, actor, requestKey = require('node:crypto').randomUUID() }) {
  if (!Number.isSafeInteger(points) || !points || Math.abs(points) > 2000000000) throw fail('Số Xu điều chỉnh phải là số nguyên khác 0 trong giới hạn cho phép.', 400);
  if (!reason || reason.trim().length < 3) throw fail('Cần nhập lý do điều chỉnh cụ thể.', 400);

  return withTransaction(pool, async client => {
    const customer = (await client.query('SELECT id, active, deleted_at FROM customers WHERE id=$1 FOR UPDATE', [customerId])).rows[0];
    if (!customer || customer.deleted_at) throw fail('Không tìm thấy khách hàng đang quản lý.', 404);
    if (!customer.active) throw fail('Không điều chỉnh Xu cho tài khoản đang khóa.', 409);
    const loyalty = await getOrCreateLoyalty(client, customerId);
    const eventKey = `adjust:${customerId}:${requestKey}`;
    const old = (await client.query('SELECT id, points, reason, balance_after FROM customer_loyalty_ledger WHERE event_key=$1', [eventKey])).rows[0];
    if (old) {
      if (old.points !== points || old.reason !== reason) throw fail('Mã yêu cầu đã được dùng cho nội dung điều chỉnh khác.', 409);
      return { success: true, existing: true, points: old.points, balanceAfter: old.balance_after, ledgerId: old.id };
    }
    const newBalance = loyalty.pointsBalance + points;
    if (newBalance < 0) throw fail('Số dư Xu sau điều chỉnh không thể âm.', 409);
    if (newBalance > 2147483647) throw fail('Số dư Xu vượt giới hạn cho phép.', 409);

    const newEarned = points > 0 ? loyalty.lifetimeEarned + points : loyalty.lifetimeEarned;
    if (newEarned > 2147483647) throw fail('Tổng Xu đã tích vượt giới hạn cho phép.', 409);
    const newTier = calculateTier(newEarned, await readPolicy(client));

    await client.query(
      `UPDATE customer_loyalty
       SET points_balance = $2, lifetime_earned = $3, tier = $4, updated_at = now()
       WHERE customer_id = $1`,
      [customerId, newBalance, newEarned, newTier]
    );

    const entry = await client.query(
      `INSERT INTO customer_loyalty_ledger (customer_id, type, points, balance_after, reason, event_key)
       VALUES ($1, 'adjustment', $2, $3, $4, $5)
       RETURNING *`,
      [customerId, points, newBalance, reason, eventKey]
    );

    await appendAudit(client, {
      actor,
      action: 'loyalty.adjust',
      entityType: 'customer',
      entityId: customerId,
      metadata: { points, reason, newBalance, tier: newTier }
    });

    return { success: true, points, balanceAfter: newBalance, tier: newTier, ledgerId: entry.rows[0].id };
  });
}

// -----------------------------------------------------------------------------
// ROUTER FACTORY
// -----------------------------------------------------------------------------
function createLoyaltyApi(pool) {
  const customerRouter = Router();
  const adminRouter = Router();

  // Customer Routes
  customerRouter.get('/loyalty', async (req, res, next) => {
    try {
      const customerId = req.session?.customer?.id;
      if (!customerId) return res.status(401).json({ error: 'Vui lòng đăng nhập để xem thông tin GAERU Xu.' });
      const activeCust = (await pool.query('SELECT id FROM customers WHERE id = $1 AND active = true AND deleted_at IS NULL', [customerId])).rows[0];
      if (!activeCust) return res.status(401).json({ error: 'Tài khoản không còn hoạt động.' });

      const loyaltyRes = await pool.query(
        `SELECT points_balance AS "pointsBalance", lifetime_earned AS "lifetimeEarned",
                lifetime_spent AS "lifetimeSpent", tier, updated_at AS "updatedAt"
         FROM customer_loyalty WHERE customer_id = $1`,
        [customerId]
      );
      const loyalty = loyaltyRes.rows[0] || {
        pointsBalance: 0,
        lifetimeEarned: 0,
        lifetimeSpent: 0,
        tier: 'bronze'
      };
      const policy = await readPolicy(pool);
      loyalty.tier = calculateTier(loyalty.lifetimeEarned, policy);

      const ledgerRes = await pool.query(
        `SELECT id, order_id AS "orderId", type, points, balance_after AS "balanceAfter",
                reason, created_at AS "createdAt"
         FROM customer_loyalty_ledger
         WHERE customer_id = $1
         ORDER BY created_at DESC LIMIT 50`,
        [customerId]
      );

      res.json({
        loyalty,
        ledger: ledgerRes.rows,
        tierBenefits: tierBenefits(policy), policyVersion: policy.version
      });
    } catch (e) {
      next(e);
    }
  });

  customerRouter.post('/loyalty/quote',
    rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const customerId = req.session?.customer?.id;
        if (!customerId) return res.status(401).json({ error: 'Vui lòng đăng nhập.' });
        const activeCust = (await pool.query('SELECT id FROM customers WHERE id = $1 AND active = true AND deleted_at IS NULL', [customerId])).rows[0];
        if (!activeCust) return res.status(401).json({ error: 'Tài khoản không còn hoạt động.' });

        const { subtotalVnd, existingDiscountVnd = 0, payableBeforeLoyaltyVnd, pointsRequested } = z.object({
          subtotalVnd: z.number().int().min(0),
          existingDiscountVnd: z.number().int().min(0).optional(),
          payableBeforeLoyaltyVnd: z.number().int().min(0).optional(),
          pointsRequested: z.number().int().min(0).optional()
        }).parse(req.body);

        const loyaltyRes = await pool.query(
          `SELECT points_balance FROM customer_loyalty WHERE customer_id = $1`,
          [customerId]
        );
        const currentBalance = loyaltyRes.rows[0]?.points_balance || 0;
        const remainingProductVnd = payableBeforeLoyaltyVnd !== undefined
          ? Math.min(subtotalVnd, payableBeforeLoyaltyVnd)
          : Math.max(0, subtotalVnd - existingDiscountVnd);
        const maxRedeemAllowed = Math.min(Math.floor(subtotalVnd * 0.5), remainingProductVnd);
        const maxApplicable = Math.min(currentBalance, maxRedeemAllowed);
        const appliedPoints = pointsRequested !== undefined ? Math.min(pointsRequested, maxApplicable) : maxApplicable;

        res.json({
          currentBalance,
          maxRedeemAllowed,
          appliedPoints,
          discountVnd: appliedPoints,
          finalSubtotalVnd: Math.max(0, remainingProductVnd - appliedPoints)
        });
      } catch (e) {
        next(e);
      }
    }
  );

  // Admin Routes
  adminRouter.get('/customers/loyalty-policy', requirePermission('customers.read'), async (_req, res, next) => {
    try { const policy = await readPolicy(pool); res.json({ policy, tierBenefits: tierBenefits(policy) }); } catch (e) { next(e); }
  });
  adminRouter.put('/customers/loyalty-policy', requirePermission('settings.write'), requireCsrf, async (req, res, next) => {
    try {
      const parsed = policySchema.parse(req.body);
      const saved = await withTransaction(pool, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:loyalty-policy'))");
        const previous = await readPolicy(client);
        if (parsed.version !== previous.version) throw fail('Chính sách đã thay đổi. Tải lại trước khi lưu.', 409);
        const policy = { ...parsed, version: previous.version + 1 };
        await client.query("INSERT INTO store_settings(setting_key,setting_value) VALUES('loyalty_policy',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value, updated_at=now()", [JSON.stringify(policy)]);
        await appendAudit(client, { actor: req.admin, action: 'loyalty.policy.update', entityType: 'setting', entityId: 'loyalty_policy', metadata: { previous, policy } });
        return policy;
      });
      res.json({ policy: saved, tierBenefits: tierBenefits(saved) });
    } catch (e) { next(e); }
  });
  adminRouter.get('/customers/:id/loyalty',
    requirePermission('customers.read'),
    async (req, res, next) => {
      try {
        const customerId = z.string().uuid().parse(req.params.id);
        const page = z.coerce.number().int().min(1).max(1000000).default(1).parse(req.query.ledgerPage);
        const loyaltyRes = await pool.query(
          `SELECT points_balance AS "pointsBalance", lifetime_earned AS "lifetimeEarned",
                  lifetime_spent AS "lifetimeSpent", tier, updated_at AS "updatedAt"
           FROM customer_loyalty WHERE customer_id = $1`,
          [customerId]
        );
        const loyalty = loyaltyRes.rows[0] || {
          pointsBalance: 0,
          lifetimeEarned: 0,
          lifetimeSpent: 0,
          tier: 'bronze'
        };
        const policy = await readPolicy(pool);
        loyalty.tier = calculateTier(loyalty.lifetimeEarned, policy);

        const ledgerRes = await pool.query(
          `SELECT id, order_id AS "orderId", type, points, balance_after AS "balanceAfter",
                  reason, created_at AS "createdAt"
           FROM customer_loyalty_ledger
           WHERE customer_id = $1
           ORDER BY created_at DESC, id DESC LIMIT 50 OFFSET $2`,
          [customerId, (page - 1) * 50]
        );
        const total = Number((await pool.query('SELECT count(*)::int AS total FROM customer_loyalty_ledger WHERE customer_id=$1', [customerId])).rows[0].total);
        res.json({ loyalty, ledger: ledgerRes.rows, tierBenefits: tierBenefits(policy), policyVersion: policy.version, pagination: { page, pageSize: 50, total, pageCount: Math.max(1, Math.ceil(total / 50)) } });
      } catch (e) {
        next(e);
      }
    }
  );

  adminRouter.post('/customers/:id/loyalty/adjust',
    requirePermission('customers.write'),
    requireCsrf,
    async (req, res, next) => {
      try {
        const customerId = z.string().uuid().parse(req.params.id);
        const { points, reason, requestKey } = z.object({
          points: z.number().int().min(-2000000000).max(2000000000).refine(n => n !== 0, 'Số điểm phải khác 0'),
          reason: z.string().trim().min(3).max(500), requestKey: z.string().uuid().optional()
        }).strict().parse(req.body);

        const result = await adjustPoints(pool, {
          customerId,
          points,
          reason,
          actor: req.admin, requestKey
        });
        res.json(result);
      } catch (e) {
        next(e);
      }
    }
  );

  return { customer: customerRouter, admin: adminRouter, earnPoints, redeemPoints, refundPoints, adjustPoints };
}

module.exports = {
  createLoyaltyApi,
  getOrCreateLoyalty,
  earnPoints,
  redeemPoints,
  refundPoints,
  adjustPoints,
  calculateTier, DEFAULT_POLICY, readPolicy, tierBenefits, policySchema
};
