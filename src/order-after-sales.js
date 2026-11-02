'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { requirePermission } = require('./staff-access');
const { withTransaction } = require('./db');
const { appendAudit } = require('./audit');

const fail = (message, status = 409) => Object.assign(new Error(message), { status });

const RETURN_POLICY_DAYS = 7;

const AFTER_SALES_LABELS = Object.freeze({
  requested: 'Mới yêu cầu',
  approved: 'Đã duyệt (Gửi hàng về kho)',
  received: 'Đã nhận hàng hoàn',
  resolved: 'Đã hoàn tất',
  rejected: 'Từ chối'
});

const REASON_CATEGORIES = Object.freeze({
  faulty: 'Sản phẩm lỗi kỹ thuật từ nhà sản xuất',
  wrong_item: 'Giao sai sản phẩm / sai phân loại / thiếu phụ kiện',
  damaged: 'Hàng bị bể vỡ, móp méo do vận chuyển',
  change_mind: 'Đổi ý không còn nhu cầu (còn nguyên seal)',
  other: 'Lý do khác'
});

const RETURN_TYPES = Object.freeze({
  exchange: 'Đổi mới 1:1',
  refund: 'Trả hàng & hoàn tiền'
});

const transitions = Object.freeze({
  requested: ['approved', 'rejected'],
  approved: ['received', 'resolved', 'rejected'],
  received: ['resolved'],
  resolved: [],
  rejected: []
});

/**
 * Determine delivery/completion timestamp of an order.
 */
function getOrderDeliveredAt(order, shipment = null) {
  if (shipment?.status === 'delivered' && shipment?.last_synced_at) {
    return new Date(shipment.last_synced_at);
  }
  return new Date(order.updated_at || order.created_at);
}

/**
 * Check whether an order is eligible for Return / Exchange under GAERU Policy.
 */
function checkReturnEligibility(order, activeCase = null, completedCase = null, shipment = null) {
  if (!order) {
    return {
      eligible: false,
      reason: 'Không tìm thấy đơn hàng.',
      code: 'ORDER_NOT_FOUND'
    };
  }

  if (order.status === 'cancelled') {
    return {
      eligible: false,
      reason: 'Đơn hàng đã hủy, không thể yêu cầu đổi/trả hàng.',
      code: 'ORDER_CANCELLED'
    };
  }

  if (!['shipped', 'completed'].includes(order.status)) {
    return {
      eligible: false,
      reason: 'Chỉ có thể yêu cầu đổi/trả khi đơn hàng đang giao hoặc đã hoàn tất nhận hàng.',
      code: 'ORDER_NOT_DELIVERED'
    };
  }

  if (order.return_completed_at || completedCase) {
    return {
      eligible: false,
      reason: 'Đơn hàng đã hoàn tất thủ tục đổi/trả trước đó.',
      code: 'ALREADY_RETURNED'
    };
  }

  if (activeCase) {
    return {
      eligible: false,
      reason: `Đơn hàng đang có yêu cầu đổi/trả đang xử lý (${AFTER_SALES_LABELS[activeCase.status] || activeCase.status}).`,
      code: 'ACTIVE_CASE_EXISTS',
      activeCase: {
        id: activeCase.id,
        status: activeCase.status,
        statusLabel: AFTER_SALES_LABELS[activeCase.status] || activeCase.status,
        returnType: activeCase.return_type || 'exchange',
        reason: activeCase.reason,
        resolution: activeCase.resolution || '',
        createdAt: activeCase.created_at
      }
    };
  }

  // 7-day policy window verification
  const deliveredAt = getOrderDeliveredAt(order, shipment);
  const diffMs = Date.now() - deliveredAt.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays > RETURN_POLICY_DAYS) {
    return {
      eligible: false,
      daysRemaining: 0,
      policyWindowDays: RETURN_POLICY_DAYS,
      reason: 'Đơn hàng đã vượt quá thời hạn đổi trả 7 ngày theo chính sách. Nếu sản phẩm gặp sự cố kỹ thuật trong quá trình sử dụng, quý khách vui lòng đăng ký bảo hành chính hãng tại GAERU Care+ (thời hạn 12 tháng).',
      code: 'RETURN_WINDOW_EXPIRED',
      careUrl: '/dang-ky-bao-hanh'
    };
  }

  const daysRemaining = Math.max(1, Math.ceil(RETURN_POLICY_DAYS - diffDays));

  return {
    eligible: true,
    daysRemaining,
    policyWindowDays: RETURN_POLICY_DAYS,
    reason: 'Đơn hàng đủ điều kiện tạo yêu cầu đổi mới 1:1 hoặc trả hàng hoàn tiền.'
  };
}

/**
 * Core atomic function to create a customer return request within a transaction.
 */
async function createCustomerReturnRequest(client, {
  orderId,
  customerId = null,
  requestedBy = 'customer',
  returnType = 'exchange',
  reasonCategory = 'faulty',
  reason,
  bankInfo = {},
  evidenceUrls = [],
  actor = null,
  audit = appendAudit
}) {
  const order = (await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
  if (!order) throw fail('Không tìm thấy đơn hàng.', 404);

  if (customerId && order.customer_id !== customerId) {
    // 404 instead of 403: do not reveal that another customer's order exists
    throw fail('Không tìm thấy đơn hàng.', 404);
  }

  const activeCase = (await client.query(
    "SELECT * FROM order_after_sales WHERE order_id = $1 AND status NOT IN ('resolved', 'rejected')",
    [orderId]
  )).rows[0];

  const completedCase = (await client.query(
    "SELECT id FROM order_after_sales WHERE order_id = $1 AND kind = 'return' AND status = 'resolved'",
    [orderId]
  )).rows[0];

  const shipment = (await client.query(
    "SELECT * FROM carrier_shipments WHERE order_id = $1 AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1",
    [orderId]
  )).rows[0];

  const eligibility = checkReturnEligibility(order, activeCase, completedCase, shipment);
  if (!eligibility.eligible) {
    throw fail(eligibility.reason, 400);
  }

  const cleanReason = String(reason || '').trim();
  if (cleanReason.length < 5 || cleanReason.length > 2000) {
    throw fail('Lý do đổi trả phải có độ dài từ 5 đến 2000 ký tự.', 400);
  }

  const { generateRmaNumber, generateRmaToken } = require('./rma-tickets');
  const rmaNumber = generateRmaNumber();
  const rmaToken = generateRmaToken();

  const row = (await client.query(
    `INSERT INTO order_after_sales (
      order_id, kind, status, reason, requested_by, return_type, reason_category, bank_info, evidence_urls, rma_number, rma_token
    ) VALUES ($1, 'return', 'requested', $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *`,
    [
      orderId,
      cleanReason,
      requestedBy,
      returnType,
      reasonCategory,
      JSON.stringify(bankInfo || {}),
      JSON.stringify(evidenceUrls || []),
      rmaNumber,
      rmaToken
    ]
  )).rows[0];

  if (audit) {
    await audit(client, {
      actor: actor || { id: customerId, username: order.email || 'customer', source: requestedBy },
      action: 'order.after_sales.create',
      entityType: 'order',
      entityId: orderId,
      metadata: {
        caseId: row.id,
        kind: 'return',
        requestedBy,
        returnType,
        reasonCategory
      }
    });
  }

  return row;
}

/**
 * Admin After-Sales Router (Mounted under /api/gaeru_ceo).
 */
function afterSalesRouter(pool) {
  const router = Router();
  router.use(
    ['/orders/after-sales', '/orders/:id/after-sales'],
    rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false })
  );

  router.get('/orders/after-sales', requirePermission('orders.read'), async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      if (!['', 'requested', 'approved', 'received', 'resolved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Thư mục yêu cầu chưa hợp lệ.' });
      }

      const result = await pool.query(
        `SELECT a.*, o.order_number, o.customer_name, o.phone, o.email, o.status AS order_status, o.payment_status
         FROM order_after_sales a
         JOIN orders o ON o.id = a.order_id
         WHERE ($1::text = '' OR a.status = $1)
         ORDER BY CASE WHEN a.status IN ('resolved', 'rejected') THEN 1 ELSE 0 END, a.created_at DESC
         LIMIT 100`,
        [status]
      );
      res.json({ cases: result.rows });
    } catch (e) {
      next(e);
    }
  });

  router.post('/orders/:id/after-sales', requirePermission('orders.write'), async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const data = z.object({
        kind: z.enum(['cancellation', 'return']),
        reason: z.string().trim().min(5).max(2000)
      }).strict().parse(req.body);

      const row = await withTransaction(pool, async (c) => {
        const order = (await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!order) throw fail('Không tìm thấy đơn.', 404);

        if (data.kind === 'cancellation' && ['shipped', 'completed', 'cancelled'].includes(order.status)) {
          throw fail('Đơn đã giao cho vận chuyển cần xử lý trả hàng; đơn đã hủy không tạo lại yêu cầu.');
        }
        if (data.kind === 'return' && !['shipped', 'completed'].includes(order.status)) {
          throw fail('Chỉ tạo trả hàng khi đơn đang giao hoặc đã hoàn tất.');
        }
        if (data.kind === 'return' && (order.return_completed_at || (await c.query("SELECT id FROM order_after_sales WHERE order_id = $1 AND kind = 'return' AND status = 'resolved'", [id])).rows.length)) {
          throw fail('Đơn đã hoàn trả xong; không tạo lại hồ sơ xử lý.');
        }
        if ((await c.query("SELECT id FROM order_after_sales WHERE order_id = $1 AND status NOT IN ('resolved', 'rejected')", [id])).rows.length) {
          throw fail('Đơn đang có yêu cầu xử lý.');
        }

        const { generateRmaNumber, generateRmaToken } = require('./rma-tickets');
        const rmaNumber = data.kind === 'return' ? generateRmaNumber() : null;
        const rmaToken = data.kind === 'return' ? generateRmaToken() : null;
        const row = (await c.query(
          'INSERT INTO order_after_sales(order_id, kind, reason, rma_number, rma_token) VALUES($1, $2, $3, $4, $5) RETURNING *',
          [id, data.kind, data.reason, rmaNumber, rmaToken]
        )).rows[0];

        await appendAudit(c, {
          actor: req.admin,
          action: 'order.after_sales.create',
          entityType: 'order',
          entityId: id,
          metadata: { caseId: row.id, kind: data.kind }
        });
        return row;
      });

      res.status(201).json(row);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return res.status(400).json({ error: 'Kiểm tra loại yêu cầu và lý do (ít nhất 5 ký tự).' });
      }
      next(e);
    }
  });

  router.patch('/orders/after-sales/:id', requirePermission('orders.write'), async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const data = z.object({
        version: z.number().int().positive(),
        status: z.enum(['approved', 'received', 'resolved', 'rejected']),
        resolution: z.string().trim().min(5).max(2000)
      }).strict().parse(req.body);

      const result = await withTransaction(pool, async (c) => {
        const row = (await c.query('SELECT * FROM order_after_sales WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!row) throw fail('Không tìm thấy yêu cầu.', 404);
        if (row.version !== data.version) throw fail('Yêu cầu đã thay đổi. Tải lại trước khi lưu.');
        if (!transitions[row.status].includes(data.status)) throw fail('Không thể chuyển trạng thái này.');
        if (row.kind === 'cancellation' && data.status === 'received') throw fail('Yêu cầu hủy không có bước nhận hàng hoàn.');

        const order = (await c.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [row.order_id])).rows[0];
        if (data.status === 'resolved' && row.kind === 'cancellation' && order.status !== 'cancelled') {
          throw fail('Hoàn tất thao tác hủy đơn trong chi tiết đơn trước khi đóng yêu cầu.');
        }
        if (data.status === 'resolved' && row.kind === 'return' && row.status !== 'received') {
          throw fail('Xác nhận đã nhận hàng trả trước khi đóng yêu cầu.');
        }
        if (data.status === 'resolved' && row.kind === 'return') {
          await c.query('UPDATE orders SET return_completed_at = COALESCE(return_completed_at, now()), updated_at = now() WHERE id = $1', [row.order_id]);
        }

        const changed = (await c.query(
          'UPDATE order_after_sales SET status = $2, resolution = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *',
          [id, data.status, data.resolution]
        )).rows[0];

        await appendAudit(c, {
          actor: req.admin,
          action: 'order.after_sales.update',
          entityType: 'order',
          entityId: row.order_id,
          metadata: { caseId: id, status: data.status, resolution: data.resolution }
        });
        return changed;
      });

      res.json(result);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return res.status(400).json({ error: 'Kiểm tra trạng thái và ghi chú xử lý.' });
      }
      next(e);
    }
  });

  return router;
}

module.exports = {
  afterSalesRouter,
  checkReturnEligibility,
  createCustomerReturnRequest,
  getOrderDeliveredAt,
  RETURN_POLICY_DAYS,
  AFTER_SALES_LABELS,
  REASON_CATEGORIES,
  RETURN_TYPES
};
