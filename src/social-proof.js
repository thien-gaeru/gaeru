'use strict';
const { Router } = require('express');

function maskCustomerName(fullName) {
  if (!fullName) return 'Khách hàng';
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const firstName = parts[parts.length - 2] || parts[0];
  const lastInitial = (parts[parts.length - 1] || '').charAt(0).toUpperCase();
  return `${firstName} ${lastInitial}.`;
}

function formatRelativeTime(date) {
  if (!date) return 'Vừa xong';
  const diffMs = Date.now() - new Date(date).getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes <= 1) return 'Vừa xong';
  if (diffMinutes < 60) return `${diffMinutes} phút trước`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} giờ trước`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} ngày trước`;
}

const FALLBACK_SALES = [
  { customerName: 'Hoàng M.', location: 'Hà Nội', productName: 'Micro Thu Âm Không Dây K9', relativeTime: '5 phút trước' },
  { customerName: 'Minh T.', location: 'TP. Hồ Chí Minh', productName: 'Gimbal Chống Rung GAERU G1 Ultra', relativeTime: '12 phút trước' },
  { customerName: 'Thu H.', location: 'Đà Nẵng', productName: 'Gậy Chụp Hình Gimbal P01 AI', relativeTime: '25 phút trước' },
  { customerName: 'Văn D.', location: 'Cần Thơ', productName: 'Chân Tripod Để Bàn GAERU M3', relativeTime: '40 phút trước' }
];

async function getRecentSocialProof(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT o.customer_name AS "customerName",
              COALESCE(NULLIF(o.city, ''), 'Việt Nam') AS "location",
              o.created_at AS "createdAt",
              COALESCE(
                (SELECT oi.product_name FROM order_items oi WHERE oi.order_id = o.id LIMIT 1),
                'Thiết bị Creator GAERU'
              ) AS "productName"
       FROM orders o
       WHERE o.status NOT IN ('cancelled')
       ORDER BY o.created_at DESC
       LIMIT 10`
    );

    if (!rows.length) {
      return FALLBACK_SALES;
    }

    return rows.map(r => ({
      customerName: maskCustomerName(r.customerName),
      location: r.location,
      productName: r.productName,
      relativeTime: formatRelativeTime(r.createdAt)
    }));
  } catch (err) {
    return FALLBACK_SALES;
  }
}

function createSocialProofRouter(pool) {
  const router = Router();

  router.get('/social-proof/recent-sales', async (_req, res) => {
    const items = await getRecentSocialProof(pool);
    res.json({ items });
  });

  return router;
}

module.exports = {
  maskCustomerName,
  formatRelativeTime,
  getRecentSocialProof,
  createSocialProofRouter
};
