'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { requirePermission } = require('./staff-access');
const { withTransaction } = require('./db');
const { appendAudit } = require('./audit');
const { getCarrierTrackingUrl } = require('./tracking-api');

const fail = (message, status = 409) => Object.assign(new Error(message), { status });

function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.byteLength === bufB.byteLength && crypto.timingSafeEqual(bufA, bufB);
}

const RETURN_WAREHOUSE_ADDRESS = Object.freeze({
  facility: 'Trung tâm Tiếp nhận Bảo hành & Đổi trả GAERU',
  address: 'Thôn 2, Xã Rạng Đông, Tỉnh Ninh Bình',
  contactName: 'Bộ phận Hậu Mãi & RMA - GAERU',
  contactPhone: '082 919 1080',
  instructions: 'Quý khách vui lòng dán hoặc ghi rõ Mã RMA trên vỏ kiện hàng gửi về kho, bảo đảm có đầy đủ hộp và phụ kiện đi kèm theo chính sách đổi trả.'
});

/**
 * Generate a human-readable unique RMA Number.
 * Format: RMA-YYMMDD-XXXX (e.g. RMA-261102-9AF1)
 */
function generateRmaNumber() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `RMA-${yy}${mm}${dd}-${rand}`;
}

/**
 * Generate a cryptographically secure capability token for guest/customer RMA access.
 */
function generateRmaToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Update Inbound Logistics for an RMA ticket.
 * Customer or guest provides the courier name and waybill tracking number when shipping parcel back to warehouse.
 */
async function updateRmaInboundTracking(pool, {
  rmaNumber,
  token = null,
  inboundCarrier,
  inboundTrackingNumber,
  actor = null,
  audit = appendAudit
}) {
  return await withTransaction(pool, async (client) => {
    const row = (await client.query(
      `SELECT a.*, o.order_number, o.customer_id, o.email, o.phone
       FROM order_after_sales a
       JOIN orders o ON o.id = a.order_id
       WHERE a.rma_number = $1
       FOR UPDATE`,
      [rmaNumber]
    )).rows[0];

    if (!row) throw fail('Không tìm thấy phiếu RMA.', 404);

    // Verify capability token or order ownership (fail closed)
    const tokenOk = safeTokenEqual(token, row.rma_token);
    const ownerOk = Boolean(actor?.id && row.customer_id && actor.id === row.customer_id);
    if (!tokenOk && !ownerOk) {
      throw fail('Mã xác thực RMA (Token) không hợp lệ hoặc bạn không có quyền cập nhật phiếu này.', 403);
    }
    if (['resolved', 'rejected'].includes(row.status)) {
      throw fail('Phiếu RMA đã đóng, không thể cập nhật vận đơn.', 409);
    }

    const cleanCarrier = String(inboundCarrier || '').trim();
    const cleanTracking = String(inboundTrackingNumber || '').trim().toUpperCase();

    if (!cleanCarrier || !cleanTracking) {
      throw fail('Vui lòng cung cấp đơn vị vận chuyển và mã vận đơn gửi về kho.', 400);
    }

    const updated = (await client.query(
      `UPDATE order_after_sales
       SET inbound_carrier = $2,
           inbound_tracking_number = $3,
           inbound_status = 'in_transit',
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [row.id, cleanCarrier, cleanTracking]
    )).rows[0];

    if (audit) {
      await audit(client, {
        actor: actor || { username: row.email || 'customer', source: 'rma_token' },
        action: 'rma.inbound.update',
        entityType: 'order_after_sales',
        entityId: row.id,
        metadata: {
          rmaNumber: row.rma_number,
          inboundCarrier: cleanCarrier,
          inboundTrackingNumber: cleanTracking
        }
      });
    }

    return updated;
  });
}

/**
 * Admin updates Outbound Logistics & Technical Inspection for an RMA ticket.
 */
async function updateRmaLogisticsByAdmin(pool, {
  caseId,
  inboundStatus = null,
  outboundCarrier = null,
  outboundTrackingNumber = null,
  outboundStatus = null,
  inspectionNotes = null,
  restockEligible = null,
  actor,
  audit = appendAudit
}) {
  return await withTransaction(pool, async (client) => {
    const row = (await client.query(
      `SELECT a.*, o.order_number
       FROM order_after_sales a
       JOIN orders o ON o.id = a.order_id
       WHERE a.id = $1
       FOR UPDATE`,
      [caseId]
    )).rows[0];

    if (!row) throw fail('Không tìm thấy phiếu RMA.', 404);

    const updates = [];
    const values = [caseId];
    let idx = 2;

    if (inboundStatus) {
      updates.push(`inbound_status = $${idx++}`);
      values.push(inboundStatus);
    }
    if (outboundCarrier !== null) {
      updates.push(`outbound_carrier = $${idx++}`);
      values.push(outboundCarrier);
    }
    if (outboundTrackingNumber !== null) {
      updates.push(`outbound_tracking_number = $${idx++}`);
      values.push(outboundTrackingNumber);
    }
    if (outboundStatus) {
      updates.push(`outbound_status = $${idx++}`);
      values.push(outboundStatus);
    }
    if (inspectionNotes !== null) {
      updates.push(`inspection_notes = $${idx++}`);
      values.push(inspectionNotes);
    }
    if (restockEligible !== null) {
      updates.push(`restock_eligible = $${idx++}`);
      values.push(Boolean(restockEligible));
    }

    if (!updates.length) return row;

    updates.push('updated_at = now()');

    const updated = (await client.query(
      `UPDATE order_after_sales
       SET ${updates.join(', ')}
       WHERE id = $1
       RETURNING *`,
      values
    )).rows[0];

    if (audit) {
      await audit(client, {
        actor,
        action: 'rma.logistics.admin_update',
        entityType: 'order_after_sales',
        entityId: caseId,
        metadata: {
          rmaNumber: row.rma_number,
          inboundStatus,
          outboundCarrier,
          outboundTrackingNumber,
          outboundStatus,
          inspectionNotes
        }
      });
    }

    return updated;
  });
}

/**
 * Express router for RMA endpoints (Public tracking + Token authorization).
 */
function createRmaApi(pool, _config = {}) {
  const router = express.Router();

  const rmaLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Bạn đã thực hiện quá nhiều yêu cầu. Vui lòng thử lại sau 1 phút.' }
  });

  // 1. GET /api/rma/:rmaNumber (Lookup RMA status by RMA number & token/challenge)
  router.get('/rma/:rmaNumber', rmaLimiter, async (req, res, next) => {
    try {
      const rmaNumber = String(req.params.rmaNumber).trim().toUpperCase();
      const token = String(req.query.token || req.headers['x-rma-token'] || '').trim();
      const phone = String(req.query.phone || '').trim();

      const result = await pool.query(
        `SELECT a.*, o.order_number, o.customer_id, o.customer_name, o.phone, o.email, o.city
         FROM order_after_sales a
         JOIN orders o ON o.id = a.order_id
         WHERE a.rma_number = $1`,
        [rmaNumber]
      );

      const item = result.rows[0];
      if (!item) {
        return res.status(404).json({ error: 'Không tìm thấy phiếu RMA.' });
      }

      // Check access permission: valid capability token, matching phone, order owner, or admin
      const { normalizePhone } = require('./tracking-api');
      const tokenMatches = safeTokenEqual(token, item.rma_token);
      const inputPhone = normalizePhone(phone), orderPhone = normalizePhone(item.phone);
      const phoneMatches = Boolean(inputPhone.length >= 9 && orderPhone.length >= 9 && inputPhone.slice(-9) === orderPhone.slice(-9));
      const ownerMatches = Boolean(req.session?.customer?.id && item.customer_id && req.session.customer.id === item.customer_id);

      if (!tokenMatches && !phoneMatches && !ownerMatches && !req.admin) {
        return res.status(403).json({ error: 'Vui lòng cung cấp mã bảo mật RMA (Token) hoặc số điện thoại để tra cứu.' });
      }

      const { maskName, maskPhone } = require('./tracking-api');

      res.json({
        ok: true,
        rma: {
          rmaNumber: item.rma_number,
          orderNumber: item.order_number,
          kind: item.kind,
          status: item.status,
          returnType: item.return_type || 'exchange',
          reasonCategory: item.reason_category || 'faulty',
          reason: item.reason,
          resolution: item.resolution || '',
          requestedBy: item.requested_by,
          inbound: {
            carrier: item.inbound_carrier,
            trackingNumber: item.inbound_tracking_number,
            status: item.inbound_status,
            trackingUrl: getCarrierTrackingUrl(item.inbound_carrier?.toLowerCase(), item.inbound_tracking_number),
            warehouseAddress: RETURN_WAREHOUSE_ADDRESS
          },
          outbound: {
            carrier: item.outbound_carrier,
            trackingNumber: item.outbound_tracking_number,
            status: item.outbound_status,
            trackingUrl: getCarrierTrackingUrl(item.outbound_carrier?.toLowerCase(), item.outbound_tracking_number)
          },
          customer: {
            name: maskName(item.customer_name),
            phone: maskPhone(item.phone),
            city: item.city
          },
          createdAt: item.created_at,
          updatedAt: item.updated_at
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // 2. POST /api/rma/:rmaNumber/inbound (Customer submits inbound waybill tracking code)
  router.post('/rma/:rmaNumber/inbound', rmaLimiter, async (req, res, next) => {
    try {
      const rmaNumber = String(req.params.rmaNumber).trim().toUpperCase();
      const token = String(req.body.token || req.headers['x-rma-token'] || req.query.token || '').trim();

      const schema = z.object({
        inboundCarrier: z.string().trim().min(2, 'Vui lòng chọn hoặc nhập tên đơn vị vận chuyển.').max(60),
        inboundTrackingNumber: z.string().trim().min(4, 'Mã vận đơn phải từ 4 ký tự trở lên.').max(60)
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Thông tin vận đơn chưa hợp lệ.' });
      }

      const updated = await updateRmaInboundTracking(pool, {
        rmaNumber,
        token,
        inboundCarrier: parsed.data.inboundCarrier,
        inboundTrackingNumber: parsed.data.inboundTrackingNumber,
        actor: req.session?.customer ? { id: req.session.customer.id, username: req.session.customer.email, source: 'customer' } : null
      });

      res.json({
        ok: true,
        message: 'Đã cập nhật mã vận đơn gửi hàng về kho thành công. Kho GAERU sẽ theo dõi và tiếp nhận kiện hàng.',
        rma: {
          rmaNumber: updated.rma_number,
          inboundCarrier: updated.inbound_carrier,
          inboundTrackingNumber: updated.inbound_tracking_number,
          inboundStatus: updated.inbound_status
        }
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  // 3. PATCH /api/gaeru_ceo/orders/after-sales/:id/logistics (Admin logistics management)
  const adminRouter = express.Router();
  adminRouter.patch('/orders/after-sales/:id/logistics', requirePermission('orders.write'), async (req, res, next) => {
    try {
      const caseId = z.string().uuid().parse(req.params.id);
      const schema = z.object({
        inboundStatus: z.enum(['pending_shipment', 'in_transit', 'delivered_to_warehouse']).optional(),
        outboundCarrier: z.string().trim().max(60).nullable().optional(),
        outboundTrackingNumber: z.string().trim().max(60).nullable().optional(),
        outboundStatus: z.enum(['none', 'preparing', 'in_transit', 'delivered']).optional(),
        inspectionNotes: z.string().trim().max(2000).nullable().optional(),
        restockEligible: z.boolean().optional()
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Dữ liệu điều phối vận chuyển chưa hợp lệ.' });
      }

      const updated = await updateRmaLogisticsByAdmin(pool, {
        caseId,
        ...parsed.data,
        actor: req.admin
      });

      res.json({
        ok: true,
        case: updated,
        message: 'Đã cập nhật thông tin điều phối vận chuyển RMA thành công.'
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  return { publicApi: router, admin: adminRouter };
}

module.exports = {
  createRmaApi,
  generateRmaNumber,
  generateRmaToken,
  updateRmaInboundTracking,
  updateRmaLogisticsByAdmin,
  RETURN_WAREHOUSE_ADDRESS
};
