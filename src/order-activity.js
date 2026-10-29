'use strict';
const { Router } = require('express');

const ACTIVITY_LABELS = {
  created: 'Đơn hàng được tạo thành công',
  paid: 'Đã nhận thanh toán',
  status_changed: 'Cập nhật trạng thái đơn hàng',
  printed_packing_slip: 'Đã in phiếu giao hàng',
  scanned_barcode: 'Đã quét mã vạch xuất kho',
  tracking_assigned: 'Gán mã vận đơn bưu cục',
  note_added: 'Ghi chú nội bộ nhân viên',
  refunded: 'Hoàn tiền đơn hàng',
  rma_opened: 'Khởi tạo phiếu bảo hành RMA'
};

async function logOrderActivity(pool, {
  orderId,
  orderNumber = null,
  actorType = 'system',
  actorName = 'Hệ thống GAERU',
  action,
  details = {}
}) {
  try {
    const validActorTypes = ['customer', 'staff', 'system', 'gateway'];
    const type = validActorTypes.includes(actorType) ? actorType : 'system';

    const res = await pool.query(
      `INSERT INTO order_activities (order_id, order_number, actor_type, actor_name, action, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [orderId, orderNumber, type, actorName, action, JSON.stringify(details || {})]
    );
    return res.rows[0];
  } catch (err) {
    console.error('Lỗi ghi nhật ký đơn hàng:', err.message);
    return null;
  }
}

async function getOrderActivities(pool, orderId) {
  const { rows } = await pool.query(
    `SELECT * FROM order_activities
     WHERE order_id::text = $1 OR order_number = $1
     ORDER BY created_at ASC`,
    [String(orderId)]
  );

  return rows.map(r => ({
    ...r,
    actionLabel: ACTIVITY_LABELS[r.action] || r.action,
    formattedTime: new Date(r.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
  }));
}

function createOrderActivityAdminRouter(pool) {
  const router = Router();

  router.get('/orders/:id/activities', async (req, res, next) => {
    try {
      const activities = await getOrderActivities(pool, req.params.id);
      res.json({ activities });
    } catch (err) {
      next(err);
    }
  });

  router.post('/orders/:id/notes', async (req, res, next) => {
    try {
      const note = req.body?.note;
      if (!note || !String(note).trim()) {
        return res.status(400).json({ error: 'Nội dung ghi chú không được để trống.' });
      }

      const staffName = req.admin?.username || 'Nhân viên';
      const activity = await logOrderActivity(pool, {
        orderId: req.params.id,
        actorType: 'staff',
        actorName: staffName,
        action: 'note_added',
        details: { note: String(note).trim() }
      });

      res.json({ success: true, activity });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  ACTIVITY_LABELS,
  logOrderActivity,
  getOrderActivities,
  createOrderActivityAdminRouter
};
