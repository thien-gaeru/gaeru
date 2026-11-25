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
  let val = row.setting_value;
  if (typeof val === 'string') {
    try {
      val = JSON.parse(val);
    } catch (_) {
      throw fail('Chính sách GAERU Xu chưa hợp lệ; vui lòng kiểm tra cấu hình.', 503);
    }
  }
  const parsed = policySchema.safeParse(val);
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
async function expireLockedLoyaltyIfDue(client, row, actor = { username: 'loyalty-expiry', source: 'system' }) {
  if (!row || !(Number(row.pointsBalance) > 0) || !row.expiresAt) return row;
  const expMs = new Date(row.expiresAt).getTime();
  if (!Number.isFinite(expMs) || expMs > Date.now()) return row;
  const expiredPoints = Number(row.pointsBalance);
  const eventKey = `expire:${row.customerId}:${Math.floor(expMs / 1000)}`;
  const existing = await client.query('SELECT id FROM customer_loyalty_ledger WHERE event_key = $1', [eventKey]);
  await client.query(
    `UPDATE customer_loyalty
        SET points_balance = 0, expires_at = NULL, updated_at = now()
      WHERE customer_id = $1`,
    [row.customerId]
  );
  if (!existing.rows.length) {
    await client.query(
      `INSERT INTO customer_loyalty_ledger (customer_id, order_id, type, points, balance_after, reason, event_key)
       VALUES ($1, NULL, 'expire', $2, 0, $3, $4)`,
      [row.customerId, -expiredPoints, 'Thu hồi tự động GAERU Xu hết hạn sau 12 tháng không phát sinh giao dịch tích Xu mới', eventKey]
    );
    if (actor) {
      await appendAudit(client, {
        actor,
        action: 'loyalty.expire',
        entityType: 'customer',
        entityId: row.customerId,
        metadata: { expiredPoints, expiredAt: new Date(expMs).toISOString() }
      });
    }
  }
  return { ...row, pointsBalance: 0, expiresAt: null };
}

async function expireDueLoyaltyPoints(pool) {
  return withTransaction(pool, async client => {
    const lock = (await client.query("SELECT pg_try_advisory_xact_lock(hashtext('gaeru:loyalty-expiry')) AS acquired")).rows[0];
    if (!lock?.acquired) return 0;
    const due = (await client.query(
      `SELECT customer_id AS "customerId", points_balance AS "pointsBalance",
              lifetime_earned AS "lifetimeEarned", lifetime_spent AS "lifetimeSpent",
              COALESCE(clawback_debt_points, 0)::int AS "clawbackDebtPoints",
              tier, expires_at AS "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM customer_loyalty
        WHERE points_balance > 0 AND expires_at IS NOT NULL AND expires_at <= now()
        ORDER BY expires_at ASC
        LIMIT 100
        FOR UPDATE SKIP LOCKED`
    )).rows;
    let expiredCount = 0;
    for (const row of due) {
      const after = await expireLockedLoyaltyIfDue(client, row);
      if (after.pointsBalance === 0 && row.pointsBalance > 0) expiredCount++;
    }
    return expiredCount;
  });
}

async function getOrCreateLoyalty(client, customerId) {
  const sel = await client.query(
    `SELECT customer_id AS "customerId", points_balance AS "pointsBalance",
            lifetime_earned AS "lifetimeEarned", lifetime_spent AS "lifetimeSpent",
            COALESCE(clawback_debt_points, 0)::int AS "clawbackDebtPoints",
            tier, expires_at AS "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM customer_loyalty WHERE customer_id = $1 FOR UPDATE`,
    [customerId]
  );
  if (sel.rows.length) return expireLockedLoyaltyIfDue(client, sel.rows[0]);

  const ins = await client.query(
    `INSERT INTO customer_loyalty (customer_id, points_balance, lifetime_earned, lifetime_spent, clawback_debt_points, tier)
     VALUES ($1, 0, 0, 0, 0, 'bronze')
     ON CONFLICT (customer_id) DO UPDATE SET customer_id = EXCLUDED.customer_id
     RETURNING customer_id AS "customerId", points_balance AS "pointsBalance",
               lifetime_earned AS "lifetimeEarned", lifetime_spent AS "lifetimeSpent",
               COALESCE(clawback_debt_points, 0)::int AS "clawbackDebtPoints",
               tier, expires_at AS "expiresAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
    [customerId]
  );
  return expireLockedLoyaltyIfDue(client, ins.rows[0]);
}

async function settleClawbackDebtInTx(client, { customerId, orderId = null, balance, clawbackDebt, eventKey, reason }) {
  const debtPaid = Math.min(Math.max(0, Number(clawbackDebt) || 0), Math.max(0, Number(balance) || 0));
  if (debtPaid <= 0) {
    return { debtPaid: 0, balanceAfter: balance, clawbackDebtAfter: clawbackDebt };
  }
  const existing = await client.query('SELECT id FROM customer_loyalty_ledger WHERE event_key = $1', [eventKey]);
  if (existing.rows.length) {
    return { debtPaid: 0, balanceAfter: balance, clawbackDebtAfter: clawbackDebt };
  }
  const balanceAfter = balance - debtPaid;
  const clawbackDebtAfter = clawbackDebt - debtPaid;
  await client.query(
    `UPDATE customer_loyalty
     SET points_balance = $2, clawback_debt_points = $3, updated_at = now()
     WHERE customer_id = $1`,
    [customerId, balanceAfter, clawbackDebtAfter]
  );
  await client.query(
    `INSERT INTO customer_loyalty_ledger (customer_id, order_id, type, points, balance_after, reason, event_key)
     VALUES ($1, $2, 'refund', $3, $4, $5, $6)`,
    [customerId, orderId, -debtPaid, balanceAfter, reason || 'Cấn trừ công nợ Xu đã tiêu từ đơn hoàn trước', eventKey]
  );
  return { debtPaid, balanceAfter, clawbackDebtAfter };
}

async function previewEarnClawback(client, { customerId, orderId, lock = false }) {
  if (!customerId || !orderId) {
    return { earnToRevoke: 0, recoverableFromBalance: 0, shortfallPoints: 0, currentBalance: 0, pendingRedeemRefund: 0, alreadyRevoked: false };
  }
  const revokeCheck = await client.query(
    'SELECT 1 FROM customer_loyalty_ledger WHERE event_key = $1 LIMIT 1',
    [`refund-earn:${orderId}`]
  );
  if (revokeCheck.rows.length) {
    return { earnToRevoke: 0, recoverableFromBalance: 0, shortfallPoints: 0, currentBalance: 0, pendingRedeemRefund: 0, alreadyRevoked: true };
  }
  const orderAgg = (await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'earn' THEN ABS(points::bigint) ELSE 0 END), 0)::bigint AS "earnedOnOrder",
       COALESCE(SUM(CASE WHEN type = 'redeem' THEN ABS(points::bigint) ELSE 0 END), 0)::bigint AS "totalRedeemed",
       COALESCE(SUM(CASE WHEN type = 'refund' AND event_key LIKE 'refund-redeem:%' THEN points::bigint ELSE 0 END), 0)::bigint AS "totalRefunded"
     FROM customer_loyalty_ledger
     WHERE order_id = $1`,
    [orderId]
  )).rows[0];

  const earnToRevoke = Math.max(0, Number(orderAgg?.earnedOnOrder || 0));
  const pendingRedeemRefund = Math.max(0, Number(orderAgg?.totalRedeemed || 0) - Number(orderAgg?.totalRefunded || 0));
  if (earnToRevoke <= 0) {
    return { earnToRevoke: 0, recoverableFromBalance: 0, shortfallPoints: 0, currentBalance: 0, pendingRedeemRefund, alreadyRevoked: false };
  }

  let currentBalance = 0;
  if (lock) {
    const loyalty = await getOrCreateLoyalty(client, customerId);
    currentBalance = Math.max(0, Number(loyalty.pointsBalance || 0));
  } else {
    const row = (await client.query('SELECT points_balance AS "pointsBalance" FROM customer_loyalty WHERE customer_id = $1', [customerId])).rows[0];
    currentBalance = Math.max(0, Number(row?.pointsBalance || 0));
  }

  const effectiveBalance = currentBalance + pendingRedeemRefund;
  const recoverableFromBalance = Math.min(effectiveBalance, earnToRevoke);
  const shortfallPoints = Math.max(0, earnToRevoke - recoverableFromBalance);
  return { earnToRevoke, recoverableFromBalance, shortfallPoints, currentBalance, pendingRedeemRefund, alreadyRevoked: false };
}

async function earnPoints(client, { customerId, orderId, orderTotalVnd, pointsRatio, reason, actor }) {
  if (!customerId) return null;

  const eventKey = orderId ? `earn:${orderId}` : `earn:manual:${require('node:crypto').randomUUID()}`;
  const existing = await client.query(
    `SELECT id, points, balance_after AS "balanceAfter"
     FROM customer_loyalty_ledger WHERE event_key = $1`,
    [eventKey]
  );
  if (existing.rows.length) {
    const cur = (await client.query('SELECT points_balance AS "pointsBalance", COALESCE(clawback_debt_points, 0)::int AS "clawbackDebtPoints" FROM customer_loyalty WHERE customer_id = $1', [customerId])).rows[0];
    return {
      success: true,
      existing: true,
      earnedPoints: existing.rows[0].points,
      balanceAfter: cur ? cur.pointsBalance : existing.rows[0].balanceAfter,
      clawbackDebtAfter: cur ? cur.clawbackDebtPoints : 0
    };
  }

  const loyalty = await getOrCreateLoyalty(client, customerId);
  const policy = await readPolicy(client);
  const earningTier = calculateTier(loyalty.lifetimeEarned, policy);
  const matchedTier = policy.tiers.find(tier => tier.id === earningTier) || policy.tiers[0];
  const earnBasisPoints = matchedTier ? matchedTier.earnBasisPoints : 100;
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
     SET points_balance = $2, lifetime_earned = $3, tier = $4,
         expires_at = CASE WHEN $2 > 0 THEN now() + interval '12 months' ELSE NULL END,
         updated_at = now()
     WHERE customer_id = $1`,
    [customerId, newBalance, newLifetimeEarned, newTier]
  );

  const entry = await client.query(
    `INSERT INTO customer_loyalty_ledger (customer_id, order_id, type, points, balance_after, reason, event_key)
     VALUES ($1, $2, 'earn', $3, $4, $5, $6)
     RETURNING *`,
    [customerId, orderId || null, points, newBalance, reason || `Tích Xu từ đơn hàng #${orderId || ''} · ${TIER_NAMES[earningTier]} ${ratio * 100}% · Chính sách v${policy.version}`, eventKey]
  );

  let settlement = { debtPaid: 0, balanceAfter: newBalance, clawbackDebtAfter: loyalty.clawbackDebtPoints || 0 };
  if (settlement.clawbackDebtAfter > 0 && newBalance > 0) {
    settlement = await settleClawbackDebtInTx(client, {
      customerId,
      orderId: orderId || null,
      balance: newBalance,
      clawbackDebt: settlement.clawbackDebtAfter,
      eventKey: `debt-settle:earn:${orderId || entry.rows[0].id}`,
      reason: `Cấn trừ công nợ Xu đã tiêu từ đơn hoàn trước · Đơn #${orderId || ''}`
    });
  }

  if (actor) {
    await appendAudit(client, {
      actor,
      action: 'loyalty.earn',
      entityType: 'customer',
      entityId: customerId,
      metadata: {
        points,
        orderId,
        newBalance: settlement.balanceAfter,
        debtSettled: settlement.debtPaid,
        clawbackDebtAfter: settlement.clawbackDebtAfter,
        tier: newTier,
        earningTier,
        earnBasisPoints: ratio * 10000,
        policyVersion: policy.version
      }
    });
  }

  return {
    success: true,
    existing: false,
    earnedPoints: points,
    debtSettled: settlement.debtPaid,
    balanceAfter: settlement.balanceAfter,
    clawbackDebtAfter: settlement.clawbackDebtAfter,
    tier: newTier,
    ledgerId: entry.rows[0].id
  };
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
     SET points_balance = $2, lifetime_spent = $3,
         expires_at = CASE WHEN $2 > 0 THEN COALESCE(expires_at, now() + interval '12 months') ELSE NULL END,
         updated_at = now()
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

async function refundPoints(client, { customerId, orderId, reason = 'Hoàn trả do đơn hủy hoặc trả hàng', actor, cashRecoveredEarnVnd = 0 }) {
  if (!customerId || !orderId) return { success: false, reason: 'Thiếu thông tin' };

  let refundedRedeem = 0;
  let revokedEarn = 0;
  let unrecoveredEarn = 0;
  let cashRecoveredEarn = 0;
  let debtAdded = 0;

  // 1. Check net unrefunded redeemed points for this order -> Refund them
  const redeemAgg = (await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'redeem' THEN ABS(points::bigint) ELSE 0 END), 0)::bigint AS "totalRedeemed",
       COALESCE(SUM(CASE WHEN type = 'refund' AND event_key LIKE 'refund-redeem:%' THEN points::bigint ELSE 0 END), 0)::bigint AS "totalRefunded",
       COUNT(*) FILTER (WHERE type = 'refund' AND event_key LIKE 'refund-redeem:%')::int AS "refundCount"
     FROM customer_loyalty_ledger
     WHERE order_id = $1`,
    [orderId]
  )).rows[0];

  const earnEntry = await client.query(
    `SELECT points FROM customer_loyalty_ledger
     WHERE order_id = $1 AND type = 'earn'`,
    [orderId]
  );

  const pointsToRefund = Math.max(0, Number(redeemAgg?.totalRedeemed || 0) - Number(redeemAgg?.totalRefunded || 0));
  const pointsToRevoke = earnEntry.rows.reduce((sum, r) => sum + Math.abs(r.points || 0), 0);

  let loyalty = (pointsToRefund > 0 || pointsToRevoke > 0)
    ? await getOrCreateLoyalty(client, customerId)
    : null;

  if (pointsToRefund > 0) {
    const refundCount = redeemAgg?.refundCount || 0;
    const refundEventKey = refundCount === 0 ? `refund-redeem:${orderId}` : `refund-redeem:${orderId}:${refundCount + 1}`;
    const checkRefund = await client.query('SELECT id FROM customer_loyalty_ledger WHERE event_key = $1', [refundEventKey]);
    if (!checkRefund.rows.length) {
      const newBalance = loyalty.pointsBalance + pointsToRefund;
      if (newBalance > 2147483647) throw fail('Số dư Xu vượt giới hạn cho phép.', 409);
      const newSpent = Math.max(0, loyalty.lifetimeSpent - pointsToRefund);

      await client.query(
        `UPDATE customer_loyalty
         SET points_balance = $2, lifetime_spent = $3,
             expires_at = CASE WHEN $2 > 0 THEN COALESCE(expires_at, now() + interval '12 months') ELSE NULL END,
             updated_at = now()
         WHERE customer_id = $1`,
        [customerId, newBalance, newSpent]
      );

      await client.query(
        `INSERT INTO customer_loyalty_ledger (customer_id, order_id, type, points, balance_after, reason, event_key)
         VALUES ($1, $2, 'refund', $3, $4, $5, $6)`,
        [customerId, orderId, pointsToRefund, newBalance, `Hoàn lại Xu đã dùng cho đơn #${orderId}: ${reason}`, refundEventKey]
      );
      loyalty.pointsBalance = newBalance;
      loyalty.lifetimeSpent = newSpent;
      refundedRedeem = pointsToRefund;
    }
  }

  // 2. Check if order had earned points -> Revoke from balance, apply cash refund clawback, and record any remaining deficit as clawback_debt_points
  if (earnEntry.rows.length) {
    const revokeEventKey = `refund-earn:${orderId}`;
    const checkRevoke = await client.query('SELECT id FROM customer_loyalty_ledger WHERE event_key = $1', [revokeEventKey]);
    if (!checkRevoke.rows.length && pointsToRevoke > 0) {
      const actualRevoked = Math.min(loyalty.pointsBalance, pointsToRevoke);
      unrecoveredEarn = Math.max(0, pointsToRevoke - actualRevoked);
      cashRecoveredEarn = Math.min(unrecoveredEarn, Math.max(0, Math.floor(Number(cashRecoveredEarnVnd) || 0)));
      debtAdded = Math.max(0, unrecoveredEarn - cashRecoveredEarn);

      const newBalance = loyalty.pointsBalance - actualRevoked;
      const newDebt = (loyalty.clawbackDebtPoints || 0) + debtAdded;
      const newEarned = Math.max(0, loyalty.lifetimeEarned - pointsToRevoke);
      const newTier = calculateTier(newEarned, await readPolicy(client));

      await client.query(
        `UPDATE customer_loyalty
         SET points_balance = $2, clawback_debt_points = $3, lifetime_earned = $4, tier = $5, updated_at = now()
         WHERE customer_id = $1`,
        [customerId, newBalance, newDebt, newEarned, newTier]
      );

      const detailNote = (cashRecoveredEarn > 0 || debtAdded > 0)
        ? ` (trừ số dư: ${actualRevoked} Xu${cashRecoveredEarn > 0 ? `, khấu trừ tiền hoàn: ${cashRecoveredEarn} ₫` : ''}${debtAdded > 0 ? `, ghi nợ Xu: ${debtAdded} Xu` : ''})`
        : '';

      // Even a zero-balance reversal needs a durable replay marker.
      await client.query(
        `INSERT INTO customer_loyalty_ledger (customer_id, order_id, type, points, balance_after, reason, event_key)
         VALUES ($1, $2, 'refund', $3, $4, $5, $6)`,
        [customerId, orderId, -actualRevoked, newBalance, `Thu hồi Xu đã tích từ đơn #${orderId}: ${reason}${detailNote}`, revokeEventKey]
      );
      loyalty.pointsBalance = newBalance;
      loyalty.clawbackDebtPoints = newDebt;
      loyalty.lifetimeEarned = newEarned;
      revokedEarn = actualRevoked;
    }
  }

  // 3. If restoring redeemed points pushed balance > 0 on an account with prior unrecovered debt, settle it atomically
  if (loyalty && refundedRedeem > 0 && loyalty.clawbackDebtPoints > 0 && loyalty.pointsBalance > 0) {
    const refundCount = redeemAgg?.refundCount || 0;
    const settleKey = refundCount === 0 ? `debt-settle:refund:${orderId}` : `debt-settle:refund:${orderId}:${refundCount + 1}`;
    const settlement = await settleClawbackDebtInTx(client, {
      customerId,
      orderId,
      balance: loyalty.pointsBalance,
      clawbackDebt: loyalty.clawbackDebtPoints,
      eventKey: settleKey,
      reason: `Cấn trừ công nợ Xu đã tiêu từ đơn hoàn trước khi hoàn Xu đơn #${orderId}`
    });
    loyalty.pointsBalance = settlement.balanceAfter;
    loyalty.clawbackDebtPoints = settlement.clawbackDebtAfter;
  }

  if (actor && (refundedRedeem > 0 || revokedEarn > 0 || unrecoveredEarn > 0)) {
    await appendAudit(client, {
      actor,
      action: 'loyalty.refund',
      entityType: 'customer',
      entityId: customerId,
      metadata: {
        orderId,
        refundedRedeem,
        revokedEarn,
        cashRecoveredEarn,
        debtAdded,
        clawbackDebtAfter: loyalty?.clawbackDebtPoints ?? 0,
        unrecoveredEarn,
        reason
      }
    });
  }

  return {
    success: true,
    refundedRedeem,
    revokedEarn,
    cashRecoveredEarn,
    debtAdded,
    unrecoveredEarn
  };
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
      return { success: true, existing: true, points: old.points, balanceAfter: loyalty.pointsBalance, clawbackDebtAfter: loyalty.clawbackDebtPoints || 0, ledgerId: old.id };
    }
    const newBalance = loyalty.pointsBalance + points;
    if (newBalance < 0) throw fail('Số dư Xu sau điều chỉnh không thể âm.', 409);
    if (newBalance > 2147483647) throw fail('Số dư Xu vượt giới hạn cho phép.', 409);

    const newEarned = points > 0 ? loyalty.lifetimeEarned + points : loyalty.lifetimeEarned;
    if (newEarned > 2147483647) throw fail('Tổng Xu đã tích vượt giới hạn cho phép.', 409);
    const newTier = calculateTier(newEarned, await readPolicy(client));

    await client.query(
      `UPDATE customer_loyalty
       SET points_balance = $2, lifetime_earned = $3, tier = $4,
           expires_at = CASE
             WHEN $2 <= 0 THEN NULL
             WHEN $5 > 0 THEN now() + interval '12 months'
             ELSE COALESCE(expires_at, now() + interval '12 months')
           END,
           updated_at = now()
       WHERE customer_id = $1`,
      [customerId, newBalance, newEarned, newTier, points]
    );

    const entry = await client.query(
      `INSERT INTO customer_loyalty_ledger (customer_id, type, points, balance_after, reason, event_key)
       VALUES ($1, 'adjustment', $2, $3, $4, $5)
       RETURNING *`,
      [customerId, points, newBalance, reason, eventKey]
    );

    let settlement = { debtPaid: 0, balanceAfter: newBalance, clawbackDebtAfter: loyalty.clawbackDebtPoints || 0 };
    if (points > 0 && settlement.clawbackDebtAfter > 0 && newBalance > 0) {
      settlement = await settleClawbackDebtInTx(client, {
        customerId,
        orderId: null,
        balance: newBalance,
        clawbackDebt: settlement.clawbackDebtAfter,
        eventKey: `debt-settle:adjust:${eventKey}`,
        reason: `Cấn trừ công nợ Xu đã tiêu từ đơn hoàn trước khi điều chỉnh`
      });
    }

    await appendAudit(client, {
      actor,
      action: 'loyalty.adjust',
      entityType: 'customer',
      entityId: customerId,
      metadata: {
        points,
        reason,
        newBalance: settlement.balanceAfter,
        debtSettled: settlement.debtPaid,
        clawbackDebtAfter: settlement.clawbackDebtAfter,
        tier: newTier
      }
    });

    return {
      success: true,
      points,
      balanceAfter: settlement.balanceAfter,
      debtSettled: settlement.debtPaid,
      clawbackDebtAfter: settlement.clawbackDebtAfter,
      tier: newTier,
      ledgerId: entry.rows[0].id
    };
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

      let loyaltyRow = (await pool.query(
        `SELECT customer_id AS "customerId", points_balance AS "pointsBalance", lifetime_earned AS "lifetimeEarned",
                lifetime_spent AS "lifetimeSpent", COALESCE(clawback_debt_points, 0)::int AS "clawbackDebtPoints",
                tier, expires_at AS "expiresAt", updated_at AS "updatedAt"
         FROM customer_loyalty WHERE customer_id = $1`,
        [customerId]
      )).rows[0];
      if (loyaltyRow && loyaltyRow.pointsBalance > 0 && loyaltyRow.expiresAt && new Date(loyaltyRow.expiresAt).getTime() <= Date.now()) {
        loyaltyRow = await withTransaction(pool, client => getOrCreateLoyalty(client, customerId));
      }
      const loyalty = loyaltyRow || {
        pointsBalance: 0,
        lifetimeEarned: 0,
        lifetimeSpent: 0,
        clawbackDebtPoints: 0,
        expiresAt: null,
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
    requireCsrf,
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
          `SELECT points_balance, expires_at FROM customer_loyalty WHERE customer_id = $1`,
          [customerId]
        );
        let currentBalance = loyaltyRes.rows[0]?.points_balance || 0;
        if (currentBalance > 0 && loyaltyRes.rows[0]?.expires_at && new Date(loyaltyRes.rows[0].expires_at).getTime() <= Date.now()) {
          const refreshed = await withTransaction(pool, client => getOrCreateLoyalty(client, customerId));
          currentBalance = refreshed.pointsBalance || 0;
        }
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
  adminRouter.get('/customers/loyalty-members', requirePermission('customers.read'), async (req,res,next)=>{
    try{
      const page=z.coerce.number().int().min(1).max(1000000).default(1).parse(req.query.page);
      const q=z.string().max(100).default('').parse(req.query.q).trim();
      const policy=await readPolicy(pool);
      const where="c.deleted_at IS NULL AND ($1::text='' OR c.full_name ILIKE '%'||$1||'%' OR c.email ILIKE '%'||$1||'%' OR c.phone ILIKE '%'||$1||'%')";
      const rows=(await pool.query(`SELECT c.id,c.full_name AS "fullName",c.email,c.phone,c.active,COALESCE(l.points_balance,0)::int AS "pointsBalance",COALESCE(l.lifetime_earned,0)::int AS "lifetimeEarned",COALESCE(l.lifetime_spent,0)::int AS "lifetimeSpent",COALESCE(l.clawback_debt_points,0)::int AS "clawbackDebtPoints" FROM customers c LEFT JOIN customer_loyalty l ON l.customer_id=c.id WHERE ${where} ORDER BY COALESCE(l.points_balance,0) DESC,c.id LIMIT 25 OFFSET $2`,[q,(page-1)*25])).rows;
      const summary=(await pool.query(`SELECT count(*)::int AS total,COALESCE(sum(l.points_balance),0)::text AS balance,COALESCE(sum(l.lifetime_earned),0)::text AS earned,COALESCE(sum(l.lifetime_spent),0)::text AS spent,COALESCE(sum(l.clawback_debt_points),0)::text AS debt FROM customers c LEFT JOIN customer_loyalty l ON l.customer_id=c.id WHERE ${where}`,[q])).rows[0];
      res.json({members:rows.map(row=>({...row,tier:calculateTier(row.lifetimeEarned,policy)})),summary,tierBenefits:tierBenefits(policy),pagination:{page,pageCount:Math.max(1,Math.ceil(summary.total/25)),total:summary.total,pageSize:25}});
    }catch(error){next(error);}
  });

  adminRouter.get('/customers/:id/loyalty',
    requirePermission('customers.read'),
    async (req, res, next) => {
      try {
        const customerId = z.string().uuid().parse(req.params.id);
        const page = z.coerce.number().int().min(1).max(1000000).default(1).parse(req.query.ledgerPage);
        const loyaltyRes = await pool.query(
          `SELECT points_balance AS "pointsBalance", lifetime_earned AS "lifetimeEarned",
                  lifetime_spent AS "lifetimeSpent", COALESCE(clawback_debt_points, 0)::int AS "clawbackDebtPoints",
                  tier, expires_at AS "expiresAt", updated_at AS "updatedAt"
           FROM customer_loyalty WHERE customer_id = $1`,
          [customerId]
        );
        const loyalty = loyaltyRes.rows[0] || {
          pointsBalance: 0,
          lifetimeEarned: 0,
          lifetimeSpent: 0,
          clawbackDebtPoints: 0,
          expiresAt: null,
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

  return { customer: customerRouter, admin: adminRouter, earnPoints, redeemPoints, refundPoints, previewEarnClawback, adjustPoints };
}

module.exports = {
  createLoyaltyApi,
  getOrCreateLoyalty,
  expireDueLoyaltyPoints,
  earnPoints,
  redeemPoints,
  refundPoints,
  previewEarnClawback,
  adjustPoints,
  calculateTier, DEFAULT_POLICY, readPolicy, tierBenefits, policySchema
};
