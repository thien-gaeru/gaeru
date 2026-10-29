'use strict';
const { Router } = require('express');

const RFM_SEGMENTS = {
  champions: {
    name: 'Khách hàng VIP (Champions)',
    badge: '👑 VIP',
    description: 'Mua nhiều, mua gần đây và chi tiêu lớn nhất.',
    recommendedAction: 'Tặng voucher VIP độc quyền 15%, ưu tiên bảo hành 1 đổi 1 tận nơi, hỗ trợ kỹ thuật 24/7.'
  },
  loyal: {
    name: 'Khách hàng Thân thiết (Loyal)',
    badge: '🌟 Thân thiết',
    description: 'Mua hàng thường xuyên và phản hồi tích cực.',
    recommendedAction: 'Mời tham gia mạng lưới Tiếp thị liên kết (Affiliate CTV 8%), giới thiệu bạn bè nhận thưởng.'
  },
  promising: {
    name: 'Khách hàng Mới Tiềm năng (Promising)',
    badge: '🚀 Tiềm năng',
    description: 'Vừa mua đơn hàng đầu tiên gần đây.',
    recommendedAction: 'Gợi ý combo phụ kiện tương thích (chân đế, cáp chuyển, bông lọc) kèm Deal sốc 20%.'
  },
  at_risk: {
    name: 'Có Nguy cơ Rời bỏ (At-Risk)',
    badge: '⚠️ Nguy cơ',
    description: 'Từng mua nhiều lần nhưng hơn 90 ngày chưa quay lại.',
    recommendedAction: 'Gửi Zalo ZNS hoặc Email Marketing kích hoạt lại với mã ưu đãi tri ân giảm 10%.'
  },
  lost: {
    name: 'Khách hàng Ngủ đông (Lost)',
    badge: '💤 Ngủ đông',
    description: 'Đã hơn 180 ngày không có tương tác mua hàng mới.',
    recommendedAction: 'Khảo sát lý do chưa hài lòng hoặc gửi thông báo sản phẩm công nghệ mới ra mắt.'
  }
};

function scoreRecency(days) {
  if (days === null || days === undefined) return 1;
  if (days <= 30) return 5;
  if (days <= 60) return 4;
  if (days <= 90) return 3;
  if (days <= 180) return 2;
  return 1;
}

function scoreFrequency(count) {
  if (!count) return 1;
  if (count >= 5) return 5;
  if (count >= 3) return 4;
  if (count >= 2) return 3;
  return 2;
}

function scoreMonetary(spendVnd) {
  const spend = Number(spendVnd) || 0;
  if (spend >= 5000000) return 5;
  if (spend >= 3000000) return 4;
  if (spend >= 1500000) return 3;
  if (spend >= 500000) return 2;
  return 1;
}

function determineSegment(r, f, m) {
  if (r >= 4 && f >= 3 && m >= 4) return 'champions';
  if (r >= 3 && f >= 2) return 'loyal';
  if (r >= 4 && f === 1) return 'promising';
  if (r <= 2 && f >= 2) return 'at_risk';
  return 'lost';
}

async function getRfmCustomerSegmentation(pool) {
  const { rows } = await pool.query(
    `SELECT
       phone,
       MAX(customer_name) AS "customerName",
       MAX(email) AS "email",
       COUNT(*)::int AS "orderCount",
       COALESCE(SUM(total_vnd), SUM(subtotal_vnd), 0)::bigint AS "totalSpendVnd",
       MAX(created_at) AS "lastOrderDate",
       COALESCE(EXTRACT(DAY FROM (now() - MAX(created_at)))::int, 0) AS "recencyDays"
     FROM orders
     WHERE status NOT IN ('cancelled')
     GROUP BY phone
     ORDER BY "totalSpendVnd" DESC`
  );

  const segmentCounts = {
    champions: 0,
    loyal: 0,
    promising: 0,
    at_risk: 0,
    lost: 0
  };

  const segmentRevenue = {
    champions: 0n,
    loyal: 0n,
    promising: 0n,
    at_risk: 0n,
    lost: 0n
  };

  const customers = rows.map(r => {
    const rScore = scoreRecency(r.recencyDays);
    const fScore = scoreFrequency(r.orderCount);
    const mScore = scoreMonetary(r.totalSpendVnd);
    const segmentKey = determineSegment(rScore, fScore, mScore);
    const meta = RFM_SEGMENTS[segmentKey];

    segmentCounts[segmentKey]++;
    segmentRevenue[segmentKey] += BigInt(r.totalSpendVnd);

    return {
      phone: r.phone,
      customerName: r.customerName || 'Khách hàng',
      email: r.email || '',
      orderCount: r.orderCount,
      totalSpendVnd: Number(r.totalSpendVnd),
      lastOrderDate: r.lastOrderDate,
      recencyDays: r.recencyDays,
      scores: { r: rScore, f: fScore, m: mScore },
      segment: segmentKey,
      segmentName: meta.name,
      badge: meta.badge,
      recommendedAction: meta.recommendedAction
    };
  });

  const totalCustomers = customers.length;
  const totalRevenue = Object.values(segmentRevenue).reduce((acc, v) => acc + v, 0n);

  const summary = Object.entries(RFM_SEGMENTS).map(([key, meta]) => ({
    key,
    name: meta.name,
    badge: meta.badge,
    description: meta.description,
    customerCount: segmentCounts[key],
    percentage: totalCustomers > 0 ? parseFloat(((segmentCounts[key] / totalCustomers) * 100).toFixed(1)) : 0,
    totalRevenueVnd: Number(segmentRevenue[key]),
    recommendedAction: meta.recommendedAction
  }));

  return {
    totalCustomers,
    totalRevenueVnd: Number(totalRevenue),
    summary,
    customers: customers.slice(0, 100)
  };
}

function createRfmAdminRouter(pool) {
  const router = Router();

  router.get('/customers/rfm', async (_req, res, next) => {
    try {
      const data = await getRfmCustomerSegmentation(pool);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  RFM_SEGMENTS,
  scoreRecency,
  scoreFrequency,
  scoreMonetary,
  determineSegment,
  getRfmCustomerSegmentation,
  createRfmAdminRouter
};
