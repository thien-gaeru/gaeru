'use strict';

const express = require('express');

function createBarcodeApi(pool, { notifyOrderUpdate } = {}) {
  const router = express.Router();

  router.get('/barcode/lookup', async (req, res, next) => {
    try {
      const code = String(req.query.code || '').trim();
      if (!code) return res.status(400).json({ error: 'Cần cung cấp mã đơn hàng hoặc mã vận đơn.' });

      // Look up by id, order_code, or metadata tracking code
      let order = (await pool.query(
        `SELECT id, order_code AS "orderCode", customer_name AS "customerName", customer_phone AS "customerPhone",
                shipping_address AS "shippingAddress", payment_method AS "paymentMethod", payment_status AS "paymentStatus",
                status, total_vnd AS "totalVnd", shipping_fee_vnd AS "shippingFeeVnd", items, notes, created_at AS "createdAt"
         FROM orders
         WHERE id::text = $1 OR order_code = $1
         LIMIT 1`,
        [code]
      )).rows[0];

      if (!order && code.startsWith('GAERU-')) {
        order = (await pool.query(
          `SELECT id, order_code AS "orderCode", customer_name AS "customerName", customer_phone AS "customerPhone",
                  shipping_address AS "shippingAddress", payment_method AS "paymentMethod", payment_status AS "paymentStatus",
                  status, total_vnd AS "totalVnd", shipping_fee_vnd AS "shippingFeeVnd", items, notes, created_at AS "createdAt"
           FROM orders
           WHERE order_code = $1 LIMIT 1`,
          [code]
        )).rows[0];
      }

      if (!order) {
        return res.status(404).json({ error: `Không tìm thấy đơn hàng tương ứng với mã: ${code}` });
      }

      const items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);
      res.json({ ok: true, order: { ...order, items } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/barcode/confirm-pack', express.json(), async (req, res, next) => {
    try {
      const { orderId, trackingCode } = req.body || {};
      if (!orderId) return res.status(400).json({ error: 'orderId là bắt buộc.' });

      const current = (await pool.query(
        `SELECT id, order_code AS "orderCode", status, customer_name AS "customerName" FROM orders WHERE id = $1`,
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
