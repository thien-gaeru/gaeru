'use strict';
const { Router } = require('express');

const RMA_STATUS_LABELS = {
  pending: 'Chờ tiếp nhận yêu cầu',
  received: 'Đã nhận máy tại TTBH',
  inspecting: 'Kỹ thuật viên đang kiểm định',
  approved_replacement: 'Đã duyệt: Đổi mới 1-1',
  approved_repair: 'Đã duyệt: Bảo hành linh kiện',
  rejected: 'Từ chối bảo hành (ngoài diện BH)',
  shipping_back: 'Đang gửi hoàn trả cho khách',
  completed: 'Bảo hành hoàn tất'
};

function generateRmaCode() {
  const d = new Date();
  const yearMonth = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `RMA-${yearMonth}-${rand}`;
}

async function submitRmaTicket(pool, {
  customerId = null,
  orderId = null,
  orderNumber = '',
  customerName,
  customerPhone,
  productName,
  serialNumber = '',
  issueType,
  issueDescription,
  mediaUrls = []
}) {
  if (!customerName || !customerPhone || !productName || !issueType || !issueDescription) {
    throw new Error('Vui lòng điền đầy đủ họ tên, SĐT, tên sản phẩm và mô tả lỗi.');
  }

  const validIssues = ['power_loss', 'mic_noise', 'gimbal_axis_jitter', 'connectivity', 'physical_defect', 'other'];
  const issue = validIssues.includes(issueType) ? issueType : 'other';
  const ticketCode = generateRmaCode();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query(
      `INSERT INTO rma_tickets (
         ticket_code, customer_id, order_id, order_number, customer_name, customer_phone,
         product_name, serial_number, issue_type, issue_description, media_urls, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
       RETURNING *`,
      [
        ticketCode,
        customerId,
        orderId,
        orderNumber,
        customerName.trim(),
        customerPhone.trim(),
        productName.trim(),
        serialNumber.trim(),
        issue,
        issueDescription.trim(),
        JSON.stringify(mediaUrls)
      ]
    );

    const ticket = res.rows[0];

    await client.query(
      `INSERT INTO rma_timeline_events (ticket_id, status, description, created_by)
       VALUES ($1, 'pending', 'Khách hàng gửi yêu cầu bảo hành trực tuyến thành công.', 'Khách hàng')`,
      [ticket.id]
    );

    await client.query('COMMIT');
    return ticket;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function lookupRmaTicket(pool, codeOrPhone) {
  const queryStr = String(codeOrPhone || '').trim();
  if (!queryStr) return null;

  const { rows } = await pool.query(
    `SELECT * FROM rma_tickets
     WHERE ticket_code = $1 OR customer_phone = $1
     ORDER BY created_at DESC LIMIT 5`,
    [queryStr]
  );

  if (!rows.length) return null;

  const ticketsWithEvents = await Promise.all(
    rows.map(async t => {
      const evts = await pool.query(
        `SELECT * FROM rma_timeline_events WHERE ticket_id = $1 ORDER BY created_at ASC`,
        [t.id]
      );
      return {
        ...t,
        statusLabel: RMA_STATUS_LABELS[t.status] || t.status,
        events: evts.rows
      };
    })
  );

  return ticketsWithEvents;
}

async function updateRmaStatus(pool, ticketId, {
  status,
  resolutionType = null,
  outboundTracking = null,
  technicianNotes = null,
  actorName = 'Kỹ thuật viên GAERU'
}) {
  const validStatus = Object.keys(RMA_STATUS_LABELS);
  if (!validStatus.includes(status)) {
    throw new Error(`Trạng thái không hợp lệ: ${status}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updateRes = await client.query(
      `UPDATE rma_tickets
       SET status = $1,
           resolution_type = COALESCE($2, resolution_type),
           tracking_code_outbound = COALESCE($3, tracking_code_outbound),
           technician_notes = COALESCE($4, technician_notes),
           updated_at = now()
       WHERE id = $5
       RETURNING *`,
      [status, resolutionType, outboundTracking, technicianNotes, ticketId]
    );

    if (!updateRes.rows.length) {
      throw new Error('Không tìm thấy phiếu RMA cần cập nhật.');
    }

    const ticket = updateRes.rows[0];
    const desc = technicianNotes || `Trạng thái phiếu bảo hành đã cập nhật thành: ${RMA_STATUS_LABELS[status]}`;

    await client.query(
      `INSERT INTO rma_timeline_events (ticket_id, status, description, created_by)
       VALUES ($1, $2, $3, $4)`,
      [ticket.id, status, desc, actorName]
    );

    await client.query('COMMIT');
    return ticket;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function createRmaPublicRouter(pool) {
  const router = Router();

  router.post('/rma/submit', async (req, res, next) => {
    try {
      const ticket = await submitRmaTicket(pool, req.body || {});
      res.json({
        success: true,
        message: 'Đã gửi yêu cầu bảo hành thành công! Mã phiếu của bạn là: ' + ticket.ticket_code,
        ticket
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/rma/lookup/:codeOrPhone', async (req, res, next) => {
    try {
      const results = await lookupRmaTicket(pool, req.params.codeOrPhone);
      if (!results || !results.length) {
        return res.status(404).json({ error: 'Không tìm thấy phiếu bảo hành khớp với thông tin cung cấp.' });
      }
      res.json({ tickets: results });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function createRmaAdminRouter(pool) {
  const router = Router();

  router.get('/rma/config', async (_req, res, next) => {
    try {
      const { getUpgradesSettings } = require('./upgrades-settings');
      const settings = await getUpgradesSettings(pool);
      res.json({ success: true, config: settings.rma });
    } catch (err) { next(err); }
  });

  router.post('/rma/config', async (req, res, next) => {
    try {
      const { saveUpgradesSettings, getUpgradesSettings } = require('./upgrades-settings');
      const current = await getUpgradesSettings(pool);
      current.rma = { ...current.rma, ...req.body };
      await saveUpgradesSettings(pool, current);
      res.json({ success: true, config: current.rma });
    } catch (err) { next(err); }
  });

  router.get('/rma/tickets', async (req, res, next) => {
    try {
      const status = req.query.status;
      let sql = 'SELECT * FROM rma_tickets';
      const params = [];
      if (status && RMA_STATUS_LABELS[status]) {
        sql += ' WHERE status = $1';
        params.push(status);
      }
      sql += ' ORDER BY created_at DESC LIMIT 100';

      const { rows } = await pool.query(sql, params);
      res.json({
        tickets: rows.map(r => ({ ...r, statusLabel: RMA_STATUS_LABELS[r.status] || r.status }))
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/rma/tickets/:id/status', async (req, res, next) => {
    try {
      const updated = await updateRmaStatus(pool, req.params.id, {
        status: req.body.status,
        resolutionType: req.body.resolutionType,
        outboundTracking: req.body.outboundTracking,
        technicianNotes: req.body.technicianNotes,
        actorName: req.admin?.username || 'Kỹ thuật viên'
      });
      res.json({ success: true, ticket: updated });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = {
  RMA_STATUS_LABELS,
  generateRmaCode,
  submitRmaTicket,
  lookupRmaTicket,
  updateRmaStatus,
  createRmaPublicRouter,
  createRmaAdminRouter
};
