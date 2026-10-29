'use strict';

const express = require('express');

const STATUS_STEPS = [
  { key: 'placed', label: 'Đã đặt hàng', desc: 'Đơn hàng đã được ghi nhận trên hệ thống.' },
  { key: 'confirmed', label: 'Đã xác nhận', desc: 'Đội ngũ GAERU đã xác nhận đơn hàng.' },
  { key: 'processing', label: 'Đang đóng gói', desc: 'Kho hàng đang đóng gói và dán tem vận chuyển.' },
  { key: 'shipped', label: 'Đang vận chuyển', desc: 'Bưu tá Shopee Express (SPX) đang giao hàng.' },
  { key: 'completed', label: 'Giao thành công', desc: 'Đơn hàng đã được giao tận tay khách hàng.' }
];

function calculateTimeline(status) {
  let activeIndex = 0;
  if (status === 'confirmed') activeIndex = 1;
  else if (status === 'processing') activeIndex = 2;
  else if (status === 'shipped') activeIndex = 3;
  else if (status === 'completed') activeIndex = 4;
  else if (status === 'cancelled') activeIndex = -1;

  return STATUS_STEPS.map((step, idx) => ({
    ...step,
    completed: activeIndex >= idx,
    current: activeIndex === idx
  }));
}

async function lookupOrderTracking(pool, queryText) {
  const q = String(queryText || '').trim();
  if (!q || q.length < 3) {
    throw Object.assign(new Error('Vui lòng nhập số điện thoại hoặc mã đơn hàng.'), { status: 400 });
  }

  // Look up by order_number, id, or phone
  const result = await pool.query(
    `SELECT o.id, o.order_number AS "orderCode", o.customer_name AS "customerName", o.phone AS "customerPhone",
            o.address AS "shippingAddress", o.payment_method AS "paymentMethod", o.payment_status AS "paymentStatus",
            o.status, o.total_vnd AS "totalVnd", o.shipping_fee_vnd AS "shippingFeeVnd", o.note AS "notes",
            o.created_at AS "createdAt", o.updated_at AS "updatedAt",
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('name', i.product_name, 'variantName', i.variant_name, 'quantity', i.quantity))
              FROM order_items i WHERE i.order_id = o.id
            ), '[]'::jsonb) AS items
     FROM orders o
     WHERE o.order_number = $1 OR o.id::text = $1 OR o.phone = $1
     ORDER BY o.created_at DESC
     LIMIT 5`,
    [q]
  );

  if (!result.rows.length) {
    return { found: false, orders: [] };
  }

  const orders = result.rows.map(o => {
    const items = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
    const phoneMasked = o.customerPhone ? o.customerPhone.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2') : '';
    // SPX tracking link helper
    const spxTrackingCode = o.notes && /SPX[A-Z0-9]+/i.test(o.notes) ? o.notes.match(/SPX[A-Z0-9]+/i)[0] : null;

    return {
      id: o.id,
      orderCode: o.orderCode,
      customerName: o.customerName,
      customerPhoneMasked: phoneMasked,
      shippingAddress: o.shippingAddress,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      status: o.status,
      totalVnd: o.totalVnd,
      shippingFeeVnd: o.shippingFeeVnd,
      items,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      timeline: calculateTimeline(o.status),
      carrier: 'Shopee Express (SPX)',
      spxTrackingCode,
      spxTrackingUrl: spxTrackingCode ? `https://spx.vn/track?${spxTrackingCode}` : 'https://spx.vn'
    };
  });

  return { found: true, orders };
}

function createTrackingRouter(pool) {
  const router = express.Router();

  router.get('/tracking/lookup', async (req, res, next) => {
    try {
      const data = await lookupOrderTracking(pool, req.query.query || req.query.code || req.query.phone);
      if (!data.found) {
        return res.status(404).json({ error: 'Không tìm thấy đơn hàng tương ứng với thông tin tra cứu.' });
      }
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  lookupOrderTracking,
  calculateTimeline,
  createTrackingRouter
};
