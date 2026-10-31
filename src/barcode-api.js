'use strict';

const express = require('express');

function createBarcodeApi(pool, { notifyOrderUpdate } = {}) {
  const { AdminAction } = require('./admin-action');
  const router = express.Router();

  router.get('/barcode/lookup', AdminAction('orders.read'), async (req, res, next) => {
    try {
      const code = String(req.query.code || '').trim();
      if (!code) return res.status(400).json({ error: 'Cần cung cấp mã đơn hàng hoặc mã vận đơn.' });

      // Look up by UUID or order_number (e.g. GR-20261101-... or GAERU-...)
      const orderRes = await pool.query(
        `SELECT o.id,
                o.order_number AS "orderCode",
                o.order_number AS "orderNumber",
                o.customer_name AS "customerName",
                o.phone AS "customerPhone",
                o.phone,
                o.address || CASE WHEN o.city IS NOT NULL AND o.city <> '' THEN ', ' || o.city ELSE '' END AS "shippingAddress",
                o.address,
                o.payment_method AS "paymentMethod",
                o.payment_status AS "paymentStatus",
                o.status,
                o.total_vnd AS "totalVnd",
                o.shipping_fee_vnd AS "shippingFeeVnd",
                o.note AS notes,
                o.created_at AS "createdAt",
                COALESCE(
                  jsonb_agg(
                    jsonb_build_object(
                      'name', i.product_name,
                      'productName', i.product_name,
                      'variantName', i.variant_name,
                      'sku', i.sku,
                      'quantity', i.quantity,
                      'unitPriceVnd', i.unit_price_vnd,
                      'lineTotalVnd', i.line_total_vnd
                    )
                  ) FILTER (WHERE i.id IS NOT NULL),
                  '[]'::jsonb
                ) AS items
         FROM orders o
         LEFT JOIN order_items i ON i.order_id = o.id
         WHERE o.id::text = $1 OR o.order_number = $1
         GROUP BY o.id
         LIMIT 1`,
        [code]
      );

      const order = orderRes.rows[0];

      if (!order) {
        return res.status(404).json({ error: `Không tìm thấy đơn hàng tương ứng với mã: ${code}` });
      }

      res.json({ ok: true, order });
    } catch (err) {
      next(err);
    }
  });

  router.post('/barcode/confirm-pack', AdminAction('orders.write'), express.json(), async (req, res, next) => {
    try {
      const { orderId } = req.body || {};
      if (!orderId) return res.status(400).json({ error: 'orderId là bắt buộc.' });

      const current = (await pool.query(
        `SELECT id, order_number AS "orderCode", order_number AS "orderNumber", status, customer_name AS "customerName"
         FROM orders WHERE id = $1`,
        [orderId]
      )).rows[0];

      if (!current) return res.status(404).json({ error: 'Đơn hàng không tồn tại.' });

      if (current.status === 'completed' || current.status === 'cancelled') {
        return res.status(400).json({ error: `Đơn hàng đang ở trạng thái "${current.status}", không thể xác nhận đóng gói.` });
      }

      await pool.query(
        `UPDATE orders
         SET status = 'shipped', updated_at = now()
         WHERE id = $1`,
        [orderId]
      );

      if (typeof notifyOrderUpdate === 'function') {
        notifyOrderUpdate({ id: orderId, status: 'shipped', orderCode: current.orderCode });
      }

      res.json({
        ok: true,
        message: `Đã xác nhận đóng gói đơn hàng ${current.orderCode} và chuyển sang trạng thái Đang giao.`,
        orderId,
        status: 'shipped'
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createBarcodeApi };
