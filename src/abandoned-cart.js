'use strict';

const crypto = require('node:crypto');
const express = require('express');

async function recordCartContact(pool, { email, phone, customerName, items = [], subtotalVnd = 0 }) {
  const normEmail = String(email || '').trim().toLowerCase() || null;
  const normPhone = String(phone || '').trim() || null;
  if (!normEmail && !normPhone) {
    throw Object.assign(new Error('Cần cung cấp ít nhất email hoặc số điện thoại để ghi nhận giỏ hàng.'), { status: 400 });
  }

  const token = crypto.randomBytes(24).toString('hex');
  const itemsJson = JSON.stringify(Array.isArray(items) ? items : []);
  const subtotal = Math.max(0, Number.parseInt(subtotalVnd, 10) || 0);

  // Check if an abandoned cart already exists for this email/phone within 24h
  const existing = await pool.query(
    `SELECT id, recovery_token FROM abandoned_carts
     WHERE status IN ('abandoned', 'reminded_1')
       AND ((email IS NOT NULL AND email = $1) OR (phone IS NOT NULL AND phone = $2))
     ORDER BY created_at DESC LIMIT 1`,
    [normEmail, normPhone]
  );

  if (existing.rows.length) {
    const row = existing.rows[0];
    await pool.query(
      `UPDATE abandoned_carts
       SET items = $1, subtotal_vnd = $2, customer_name = COALESCE($3, customer_name), updated_at = now()
       WHERE id = $4`,
      [itemsJson, subtotal, customerName || null, row.id]
    );
    return { id: row.id, recoveryToken: row.recovery_token };
  }

  const result = await pool.query(
    `INSERT INTO abandoned_carts (email, phone, customer_name, items, subtotal_vnd, recovery_token, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'abandoned')
     RETURNING id, recovery_token`,
    [normEmail, normPhone, customerName || null, itemsJson, subtotal, token]
  );
  return { id: result.rows[0].id, recoveryToken: result.rows[0].recovery_token };
}

async function markCartRecovered(pool, { recoveryToken, email, phone }) {
  if (recoveryToken) {
    await pool.query(
      `UPDATE abandoned_carts SET status = 'recovered', recovered_at = now(), updated_at = now()
       WHERE recovery_token = $1`,
      [recoveryToken]
    );
    return;
  }
  const normEmail = String(email || '').trim().toLowerCase();
  const normPhone = String(phone || '').trim();
  if (normEmail || normPhone) {
    await pool.query(
      `UPDATE abandoned_carts SET status = 'recovered', recovered_at = now(), updated_at = now()
       WHERE status IN ('abandoned', 'reminded_1', 'reminded_2')
         AND ((email IS NOT NULL AND email = $1) OR (phone IS NOT NULL AND phone = $2))`,
      [normEmail || null, normPhone || null]
    );
  }
}

async function getCartByToken(pool, recoveryToken) {
  if (!recoveryToken || typeof recoveryToken !== 'string') return null;
  const result = await pool.query(
    `SELECT id, email, phone, customer_name AS "customerName", items, subtotal_vnd AS "subtotalVnd", status, created_at AS "createdAt"
     FROM abandoned_carts
     WHERE recovery_token = $1`,
    [recoveryToken]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    ...row,
    items: typeof row.items === 'string' ? JSON.parse(row.items) : row.items
  };
}

async function processAbandonedCartReminders(pool, mailer, config) {
  if (!mailer || typeof mailer.sendMail !== 'function') return 0;
  const baseUrl = config?.PUBLIC_BASE_URL || 'https://gaeru.com';

  const candidates = await pool.query(
    `SELECT id, email, phone, customer_name AS "customerName", items, subtotal_vnd AS "subtotalVnd", recovery_token, reminder_count
     FROM abandoned_carts
     WHERE status IN ('abandoned', 'reminded_1')
       AND email IS NOT NULL
       AND reminder_count < 2
       AND created_at <= now() - interval '60 minutes'
       AND (reminder_sent_at IS NULL OR reminder_sent_at <= now() - interval '24 hours')
     ORDER BY created_at ASC
     LIMIT 20`
  );

  let sent = 0;
  for (const cart of candidates.rows) {
    const recoverUrl = `${baseUrl}/checkout.html?recover=${encodeURIComponent(cart.recovery_token)}`;
    const items = typeof cart.items === 'string' ? JSON.parse(cart.items) : (cart.items || []);
    const itemsSummary = items.map(i => `${i.name || 'Sản phẩm GAERU'} x${i.quantity || 1}`).join(', ') || 'Sản phẩm bạn đã chọn';

    try {
      await mailer.sendMail({
        to: cart.email,
        from: config?.smtp?.from || 'GAERU <care@gaeru.com>',
        subject: 'GAERU đã giữ giỏ hàng cho bạn · Nhận thêm ưu đãi 5%',
        text: `Chào ${cart.customerName || 'bạn'},\n\nBạn đã chọn: ${itemsSummary}.\nĐơn hàng vẫn đang được lưu trữ an toàn tại GAERU. Hoàn tất đơn hàng ngay tại: ${recoverUrl}\nSử dụng mã GAERUCARE5 để được giảm 5%.\n\nTrân trọng,\nĐội ngũ GAERU`,
        html: `<p>Chào <strong>${escapeHtml(cart.customerName || 'bạn')}</strong>,</p>
               <p>Bạn đã để lại các sản phẩm sau trong giỏ hàng:</p>
               <p><strong>${escapeHtml(itemsSummary)}</strong></p>
               <p>Đơn hàng vẫn đang được giữ trong kho. Bạn có thể nhấn vào liên kết dưới đây để tiếp tục:</p>
               <p><a href="${recoverUrl}" style="display:inline-block;padding:10px 20px;background:#0055ff;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Xem lại giỏ hàng & Đặt ngay</a></p>
               <p>Nhập mã <code>GAERUCARE5</code> ở bước thanh toán để nhận ngay chiết khấu 5%.</p>`
      });

      const nextStatus = cart.reminder_count === 0 ? 'reminded_1' : 'reminded_2';
      await pool.query(
        `UPDATE abandoned_carts
         SET reminder_count = reminder_count + 1, reminder_sent_at = now(), status = $1, updated_at = now()
         WHERE id = $2`,
        [nextStatus, cart.id]
      );
      sent++;
    } catch {
      // Ignore individual email delivery failure
    }
  }
  return sent;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function createAbandonedCartRouter(pool, config, mailer) {
  const router = express.Router();

  router.post('/record-contact', express.json(), async (req, res, next) => {
    try {
      const { email, phone, customerName, items, subtotalVnd } = req.body || {};
      const result = await recordCartContact(pool, { email, phone, customerName, items, subtotalVnd });
      res.json({ ok: true, recoveryToken: result.recoveryToken });
    } catch (err) {
      next(err);
    }
  });

  router.get('/recover/:token', async (req, res, next) => {
    try {
      const cart = await getCartByToken(pool, req.params.token);
      if (!cart) return res.status(404).json({ error: 'Không tìm thấy giỏ hàng hoặc liên kết đã hết hạn.' });
      res.json({ ok: true, cart });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function createAbandonedCartAdmin(pool) {
  const router = express.Router();
  router.get('/abandoned-carts', async (req, res, next) => {
    try {
      const statsRes = await pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'recovered')::int AS recovered,
          COUNT(*) FILTER (WHERE status IN ('reminded_1', 'reminded_2'))::int AS reminded,
          COALESCE(SUM(subtotal_vnd) FILTER (WHERE status = 'recovered'), 0)::bigint AS "recoveredRevenueVnd",
          COALESCE(SUM(subtotal_vnd) FILTER (WHERE status <> 'recovered'), 0)::bigint AS "abandonedRevenueVnd"
        FROM abandoned_carts
      `);
      const recentRes = await pool.query(`
        SELECT id, email, phone, customer_name AS "customerName", subtotal_vnd AS "subtotalVnd", status, reminder_count AS "reminderCount", created_at AS "createdAt", recovered_at AS "recoveredAt"
        FROM abandoned_carts
        ORDER BY created_at DESC
        LIMIT 20
      `);
      res.json({ stats: statsRes.rows[0], recent: recentRes.rows });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

module.exports = {
  recordCartContact,
  markCartRecovered,
  getCartByToken,
  processAbandonedCartReminders,
  createAbandonedCartRouter,
  createAbandonedCartAdmin
};
