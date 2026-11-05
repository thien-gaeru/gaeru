const { Router } = require('express');
const { z } = require('zod');
const { randomBytes, createHash } = require('node:crypto');
const { withTransaction } = require('./db');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');
const { appendAudit } = require('./audit');
const { rateLimit } = require('express-rate-limit');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = t => createHash('sha256').update(String(t)).digest('hex');
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatPrice = v => new Intl.NumberFormat('vi-VN').format(v) + ' ₫';

const captureSchema = z.object({
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  customerName: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  items: z.array(z.object({
    variantId: z.string().uuid(),
    quantity: z.number().int().min(1).max(99)
  })).min(1).max(50),
  recoveryConsent: z.boolean().default(false)
}).strict();

function makeMailer(config) {
  if (!config?.smtp) return null;
  return require('nodemailer').createTransport(require('./smtp-security').smtpOptions(config.smtp));
}

/**
 * Capture or update an abandoned cart from checkout or cart interactions
 */
async function captureAbandonedCart(pool, { email, customerName = null, phone = null, items = [], recoveryConsent = false, customerId = null }) {
  const normEmail = String(email || '').trim().toLowerCase();
  if (!normEmail || !items.length) return null;

  // Check if customer has opted out of marketing/recovery emails
  const suppressed = (await pool.query(
    'SELECT 1 FROM marketing_email_suppressions WHERE lower(trim(email)) = $1',
    [normEmail]
  )).rows.length > 0;

  if (suppressed) {
    recoveryConsent = false;
  }

  // Calculate cart subtotal from database
  const variantIds = items.map(i => i.variantId);
  const variants = (await pool.query(
    `SELECT v.id, v.sku, v.name AS variant_name, v.price_vnd, v.stock_quantity,
            p.name AS product_name, p.slug AS product_slug, p.image_url AS product_image
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     WHERE v.id = ANY($1::uuid[]) AND v.active = true AND p.active = true`,
    [variantIds]
  )).rows;

  if (!variants.length) return null;

  const itemDetails = items.map(it => {
    const v = variants.find(r => r.id === it.variantId);
    if (!v) return null;
    return {
      variantId: it.variantId,
      quantity: it.quantity,
      priceVnd: Number(v.price_vnd),
      productName: v.product_name,
      variantName: v.variant_name,
      productSlug: v.product_slug,
      imageUrl: v.product_image
    };
  }).filter(Boolean);

  if (!itemDetails.length) return null;

  const subtotalVnd = itemDetails.reduce((sum, it) => sum + (it.priceVnd * it.quantity), 0);

  // Generate tokens
  const recoveryToken = randomBytes(32).toString('hex');
  const recoveryTokenHash = hash(recoveryToken);
  // Cadence: stage 1 reminder after 1 hour
  const nextReminderAt = recoveryConsent ? new Date(Date.now() + 60 * 60 * 1000) : null;

  return await withTransaction(pool, async client => {
    // Check if an existing abandoned cart exists for this email
    const existing = (await client.query(
      `SELECT id, status FROM abandoned_carts
       WHERE lower(trim(email)) = $1 AND status IN ('abandoned', 'recovering')
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [normEmail]
    )).rows[0];

    let cart;
    if (existing) {
      cart = (await client.query(
        `UPDATE abandoned_carts
         SET customer_id = COALESCE($2, customer_id),
             customer_name = COALESCE($3, customer_name),
             phone = COALESCE($4, phone),
             items = $5::jsonb,
             subtotal_vnd = $6,
             recovery_token = $7,
             recovery_token_hash = $8,
             recovery_consent = $9,
             status = 'abandoned',
             reminder_count = 0,
             next_reminder_at = $10,
             version = version + 1,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [existing.id, customerId, customerName, phone, JSON.stringify(itemDetails), subtotalVnd, recoveryToken, recoveryTokenHash, recoveryConsent, nextReminderAt]
      )).rows[0];
    } else {
      cart = (await client.query(
        `INSERT INTO abandoned_carts
           (customer_id, email, customer_name, phone, items, subtotal_vnd, recovery_token, recovery_token_hash, recovery_consent, next_reminder_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
         RETURNING *`,
        [customerId, normEmail, customerName, phone, JSON.stringify(itemDetails), subtotalVnd, recoveryToken, recoveryTokenHash, recoveryConsent, nextReminderAt]
      )).rows[0];
    }

    return { cart, recoveryToken };
  });
}

/**
 * Retrieve abandoned cart by recovery token (used by storefront when customer clicks recovery link)
 */
async function recoverCartByToken(pool, recoveryToken) {
  if (!recoveryToken || typeof recoveryToken !== 'string') return null;
  const tokenHash = hash(recoveryToken.trim());

  return await withTransaction(pool, async client => {
    const cart = (await client.query(
      `SELECT * FROM abandoned_carts
       WHERE (recovery_token = $1 OR recovery_token_hash = $2) AND status <> 'opted_out'
       FOR UPDATE`,
      [recoveryToken.trim(), tokenHash]
    )).rows[0];

    if (!cart) return null;

    if (cart.status === 'abandoned') {
      await client.query(
        `UPDATE abandoned_carts SET status = 'recovering', updated_at = now() WHERE id = $1`,
        [cart.id]
      );
      cart.status = 'recovering';
    }

    return cart;
  });
}

/**
 * Mark abandoned cart as recovered when customer completes checkout
 */
async function markCartRecovered(client, { orderId, email, customerId = null }) {
  if (!email && !customerId) return;
  const normEmail = String(email || '').trim().toLowerCase();

  await client.query(
    `UPDATE abandoned_carts
     SET status = 'recovered',
         recovered_at = now(),
         order_id = $1,
         next_reminder_at = NULL,
         updated_at = now()
     WHERE (lower(trim(email)) = $2 OR (customer_id = $3 AND customer_id IS NOT NULL))
       AND status IN ('abandoned', 'recovering')`,
    [orderId, normEmail, customerId]
  );
}

/**
 * Customer opts out of recovery reminders
 */
async function optOutAbandonedCart(pool, recoveryToken) {
  if (!recoveryToken) return false;
  const tokenHash = hash(recoveryToken.trim());

  return await withTransaction(pool, async client => {
    const cart = (await client.query(
      `SELECT id, email FROM abandoned_carts
       WHERE recovery_token = $1 OR recovery_token_hash = $2 FOR UPDATE`,
      [recoveryToken.trim(), tokenHash]
    )).rows[0];

    if (!cart) return false;

    await client.query(
      `UPDATE abandoned_carts
       SET status = 'opted_out', recovery_consent = false, next_reminder_at = NULL, updated_at = now()
       WHERE id = $1`,
      [cart.id]
    );

    // Suppress future marketing/recovery emails to this address
    await client.query(
      `INSERT INTO marketing_email_suppressions (email) VALUES ($1) ON CONFLICT DO NOTHING`,
      [cart.email.toLowerCase()]
    );

    return true;
  });
}

/**
 * List abandoned carts for admin panel with recovery metrics
 */
async function listAbandonedCarts(pool, { page = 1, pageSize = 25, status = null } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const offset = (p - 1) * pageSize;

  const whereClause = status ? 'WHERE status = $3' : '';
  const params = status ? [pageSize, offset, status] : [pageSize, offset];

  const rows = (await pool.query(
    `SELECT ac.*, o.order_number
     FROM abandoned_carts ac
     LEFT JOIN orders o ON o.id = ac.order_id
     ${whereClause}
     ORDER BY ac.created_at DESC, ac.id
     LIMIT $1 OFFSET $2`,
    params
  )).rows;

  const summary = (await pool.query(
    `SELECT
       count(*)::int AS total_count,
       count(*) FILTER (WHERE status = 'abandoned')::int AS abandoned_count,
       count(*) FILTER (WHERE status = 'recovering')::int AS recovering_count,
       count(*) FILTER (WHERE status = 'recovered')::int AS recovered_count,
       count(*) FILTER (WHERE status = 'expired')::int AS expired_count,
       count(*) FILTER (WHERE status = 'opted_out')::int AS opted_out_count,
       COALESCE(sum(subtotal_vnd) FILTER (WHERE status = 'recovered'), 0)::bigint AS recovered_revenue_vnd,
       COALESCE(sum(subtotal_vnd), 0)::bigint AS total_potential_revenue_vnd
     FROM abandoned_carts`
  )).rows[0];

  const total = Number(summary.total_count || 0);
  const recovered = Number(summary.recovered_count || 0);
  const recoveryRate = total > 0 ? Math.round((recovered / total) * 100) : 0;

  return {
    carts: rows,
    summary: {
      ...summary,
      recoveryRate
    },
    page: p,
    pageSize,
    total
  };
}

/**
 * Sends a recovery email for a single abandoned cart
 */
async function sendRecoveryEmail(pool, config, cart, mailer, stageOverride = null) {
  if (!mailer || !config?.smtp?.from) return { success: false, reason: 'Chưa cấu hình SMTP.' };
  if (cart.recovery_consent === false || cart.status === 'opted_out') {
    return { success: false, reason: 'Khách hàng chưa đồng ý hoặc đã hủy nhận email nhắc giỏ hàng.' };
  }

  const normEmail = cart.email.toLowerCase();

  // Safeguard 1: Suppression check
  const suppressed = (await pool.query(
    'SELECT 1 FROM marketing_email_suppressions WHERE lower(trim(email)) = $1',
    [normEmail]
  )).rows.length > 0;

  if (suppressed) {
    await pool.query(`UPDATE abandoned_carts SET status = 'opted_out', next_reminder_at = NULL WHERE id = $1`, [cart.id]);
    return { success: false, reason: 'Khách hàng đã hủy nhận email.' };
  }

  // Safeguard 2: Check if customer already ordered
  const ordered = (await pool.query(
    `SELECT id, order_number FROM orders
     WHERE lower(trim(email)) = $1 AND created_at >= $2
     LIMIT 1`,
    [normEmail, cart.created_at]
  )).rows[0];

  if (ordered) {
    await pool.query(
      `UPDATE abandoned_carts SET status = 'recovered', order_id = $1, recovered_at = now(), next_reminder_at = NULL WHERE id = $2`,
      [ordered.id, cart.id]
    );
    return { success: false, reason: 'Khách hàng đã hoàn tất đơn hàng.' };
  }

  const stage = stageOverride || (cart.reminder_count + 1);
  const publicBase = require('./primary-domain').normalizePublicBase(config.PUBLIC_BASE_URL || config.smtp?.publicBaseUrl || 'https://gaeru.com');
  const recoveryUrl = `${publicBase}/thanh-toan?recovery_token=${encodeURIComponent(cart.recovery_token)}`;
  const optOutUrl = `${publicBase}/api/abandoned-cart/opt-out/${encodeURIComponent(cart.recovery_token)}`;

  let subject;
  let headline;
  if (stage === 1) {
    subject = 'GAERU · Bạn còn sản phẩm trong giỏ hàng';
    headline = 'Giỏ hàng của bạn đang chờ hoàn tất';
  } else if (stage === 2) {
    subject = 'GAERU · Đừng quên: Giỏ hàng của bạn vẫn đang được giữ';
    headline = 'Sản phẩm của bạn vẫn đang được giữ trong giỏ';
  } else {
    subject = 'GAERU · Cơ hội cuối cùng: Sản phẩm trong giỏ hàng sắp hết hạn giữ chỗ';
    headline = 'Cơ hội cuối cùng để hoàn tất đơn hàng của bạn';
  }

  const items = Array.isArray(cart.items) ? cart.items : JSON.parse(cart.items || '[]');
  const itemsText = items.map(i => `- ${i.productName} (${i.variantName}) × ${i.quantity}: ${formatPrice(i.priceVnd * i.quantity)}`).join('\n');
  const itemsHtml = items.map(i => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #f0f0f2;">
      <div style="flex:1;">
        <strong style="color:#1d1d1f;font-size:14px;">${escapeHtml(i.productName)}</strong><br>
        <small style="color:#6e6e73;">${escapeHtml(i.variantName)} · Số lượng: ${i.quantity}</small>
      </div>
      <strong style="color:#0071e3;font-size:14px;">${formatPrice(i.priceVnd * i.quantity)}</strong>
    </div>
  `).join('');

  const customerGreeting = cart.customer_name ? `Chào ${escapeHtml(cart.customer_name)},` : 'Chào bạn,';

  const text = `${customerGreeting}\n\n${headline}.\n\nSản phẩm trong giỏ của bạn:\n${itemsText}\n\nTạm tính: ${formatPrice(cart.subtotal_vnd)}\n\nKhôi phục và hoàn tất đơn hàng tại liên kết bên dưới:\n${recoveryUrl}\n\nNếu bạn không muốn tiếp tục nhận email nhắc giỏ hàng, hãy bấm từ chối tại:\n${optOutUrl}\n\nGAERU Team\nHotline: 082 919 1080 · Email: business@gaeru.com`;

  const html = `<!doctype html>
<html lang="vi">
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1d1d1f;line-height:1.6;margin:0;padding:24px;background:#f5f5f7;">
  <div style="max-width:540px;margin:0 auto;background:#ffffff;border-radius:18px;padding:32px;box-shadow:0 4px 20px rgba(0,0,0,0.04);">
    <div style="margin-bottom:20px;">
      <span style="font-size:12px;font-weight:600;letter-spacing:0.08em;color:#087f8c;text-transform:uppercase;">GAERU STORE</span>
      <h1 style="font-size:22px;line-height:1.3;margin:8px 0 12px;color:#1d1d1f;">${escapeHtml(headline)}</h1>
      <p style="font-size:15px;color:#515154;margin:0;">${customerGreeting} Bạn đã chọn những sản phẩm tuyệt vời tại GAERU nhưng chưa hoàn tất thanh toán.</p>
    </div>
    <div style="margin:24px 0;background:#fafafc;border:1px solid #e5e5ea;border-radius:12px;padding:16px;">
      ${itemsHtml}
      <div style="display:flex;justify-content:space-between;padding-top:12px;font-size:15px;">
        <span>Tạm tính giỏ hàng:</span>
        <strong style="color:#1d1d1f;font-size:17px;">${formatPrice(cart.subtotal_vnd)}</strong>
      </div>
    </div>
    <div style="text-align:center;margin:28px 0;">
      <a href="${escapeHtml(recoveryUrl)}" style="display:inline-block;background:#0071e3;color:#ffffff;font-size:15px;font-weight:600;padding:12px 28px;border-radius:24px;text-decoration:none;">Khôi phục giỏ hàng ngay →</a>
    </div>
    <p style="font-size:12px;color:#86868b;margin-top:28px;padding-top:16px;border-top:1px solid #e5e5ea;">
      Email này được gửi tự động do có giỏ hàng chưa hoàn tất thanh toán tại GAERU.<br>
      Để ngừng nhận thông báo này: <a href="${escapeHtml(optOutUrl)}" style="color:#6e6e73;text-decoration:underline;">Ngừng nhận nhắc nhở giỏ hàng</a>.
    </p>
  </div>
</body>
</html>`;

  try {
    const result = await mailer.sendMail({
      from: config.smtp.from,
      to: normEmail,
      subject,
      text,
      html,
      headers: {
        'List-Unsubscribe': `<${optOutUrl}>`
      }
    });

    const accepted = Array.isArray(result?.accepted)
      ? result.accepted.some(e => String(e.address || e).toLowerCase() === normEmail)
      : Boolean(result?.messageId);
    if (!accepted) throw new Error('Dịch vụ email chưa chấp nhận địa chỉ nhận. Chưa ghi nhận gửi nhắc thành công.');

    await withTransaction(pool, async c => {
      // Calculate next reminder cadence
      let nextReminderAt = null;
      let newStatus = cart.status;
      const newReminderCount = cart.reminder_count + 1;

      if (newReminderCount === 1) {
        nextReminderAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
      } else if (newReminderCount === 2) {
        nextReminderAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours
      } else {
        newStatus = 'expired';
      }

      await c.query(
        `UPDATE abandoned_carts
         SET reminder_count = $2,
             last_reminded_at = now(),
             next_reminder_at = $3,
             status = $4,
             updated_at = now()
         WHERE id = $1`,
        [cart.id, newReminderCount, nextReminderAt, newStatus]
      );

      await c.query(
        `INSERT INTO abandoned_cart_reminders (cart_id, stage, email, subject, status, sent_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [cart.id, stage, normEmail, subject, accepted ? 'sent' : 'failed']
      );
    });

    return { success: true, messageId: result?.messageId };
  } catch (err) {
    await pool.query(
      `UPDATE abandoned_carts SET next_reminder_at = now() + interval '30 minutes', updated_at = now() WHERE id = $1`,
      [cart.id]
    ).catch(() => {});
    await pool.query(
      `INSERT INTO abandoned_cart_reminders (cart_id, stage, email, subject, status, error_message)
       VALUES ($1, $2, $3, $4, 'failed', $5)`,
      [cart.id, stage, normEmail, subject, err.message]
    );
    return { success: false, error: err.message };
  }
}

/**
 * Worker process for abandoned cart cadence
 */
async function processAbandonedCartReminders(pool, config, mailer) {
  if (!mailer || !config?.smtp?.from) return false;

  const candidate = await withTransaction(pool, async (client) => {
    const row = (await client.query(
      `SELECT * FROM abandoned_carts
       WHERE status = 'abandoned'
         AND recovery_consent = true
         AND next_reminder_at IS NOT NULL
         AND next_reminder_at <= now()
         AND reminder_count < max_reminders
       ORDER BY next_reminder_at ASC, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    )).rows[0];
    if (!row) return null;
    await client.query(
      `UPDATE abandoned_carts SET next_reminder_at = now() + interval '15 minutes', updated_at = now() WHERE id = $1`,
      [row.id]
    );
    return row;
  });

  if (!candidate) return false;

  await sendRecoveryEmail(pool, config, candidate, mailer);
  return true;
}

function startAbandonedCartWorker(pool, config, { mailer = makeMailer(config), intervalMs = 30000 } = {}) {
  let running = false;
  let stopped = false;

  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      await processAbandonedCartReminders(pool, config, mailer);
    } catch (e) {
      console.error('Abandoned cart reminder worker temporarily unavailable:', e.message);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Express router factory
 */
function createAbandonedCartApi(pool, config, { mailer = null } = {}) {
  const admin = Router();
  const publicApi = Router();

  admin.use('/marketing/abandoned-carts', requirePermission('marketing.read'));

  // Admin: Get listing with metrics
  admin.get('/marketing/abandoned-carts', async (req, res, next) => {
    try {
      const page = req.query.page;
      const status = req.query.status;
      const data = await listAbandonedCarts(pool, { page, status });
      res.json(data);
    } catch (e) {
      next(e);
    }
  });

  // Admin: Send manual reminder
  admin.post('/marketing/abandoned-carts/:id/remind', requirePermission('marketing.write'), requireCsrf, async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const cart = (await pool.query('SELECT * FROM abandoned_carts WHERE id = $1', [id])).rows[0];
      if (!cart) throw fail('Giỏ hàng không tồn tại.', 404);

      const mailTransport = mailer || makeMailer(config);
      if (!mailTransport) throw fail('Chưa cấu hình dịch vụ gửi email SMTP.', 503);

      const result = await sendRecoveryEmail(pool, config, cart, mailTransport);
      if (!result.success) throw fail(result.reason || result.error || 'Không thể gửi email nhắc nhở.', 400);

      await appendAudit(pool, {
        actor: req.admin,
        action: 'marketing.abandoned_cart.remind',
        entityType: 'marketing',
        entityId: id,
        metadata: { email: cart.email }
      });

      res.json({ success: true, message: 'Đã gửi email nhắc nhở giỏ hàng thành công.' });
    } catch (e) {
      next(e);
    }
  });

  // Admin: Cancel reminders for cart
  admin.post('/marketing/abandoned-carts/:id/cancel', requirePermission('marketing.write'), requireCsrf, async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      await pool.query(
        `UPDATE abandoned_carts SET status = 'expired', next_reminder_at = NULL, updated_at = now() WHERE id = $1`,
        [id]
      );
      await appendAudit(pool, {
        actor: req.admin,
        action: 'marketing.abandoned_cart.cancel',
        entityType: 'marketing',
        entityId: id
      });
      res.json({ success: true, message: 'Đã hủy lịch nhắc nhở cho giỏ hàng này.' });
    } catch (e) {
      next(e);
    }
  });

  // Public: Capture checkout contacts & consent
  publicApi.post('/capture', rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res, next) => {
    try {
      const parsed = captureSchema.parse(req.body);
      const customerId = req.session?.customer?.id || null;

      const result = await captureAbandonedCart(pool, {
        email: parsed.email,
        customerName: parsed.customerName,
        phone: parsed.phone,
        items: parsed.items,
        recoveryConsent: parsed.recoveryConsent,
        customerId
      });

      if (!result) return res.status(400).json({ error: 'Không thể ghi nhận giỏ hàng.' });
      res.status(201).json({ success: true, cartId: result.cart.id });
    } catch (e) {
      if (e instanceof z.ZodError) {
        return res.status(400).json({ error: 'Thông tin liên hệ hoặc giỏ hàng chưa hợp lệ.' });
      }
      next(e);
    }
  });

  // Public: Recover cart via recovery token
  publicApi.get('/recover/:token', rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res, next) => {
    try {
      const token = z.string().trim().min(20).max(128).parse(req.params.token);
      const cart = await recoverCartByToken(pool, token);
      if (!cart) {
        return res.status(404).json({ error: 'Liên kết khôi phục giỏ hàng không tồn tại hoặc đã hết hạn.' });
      }
      res.json({
        cart: {
          id: cart.id,
          email: cart.email,
          customerName: cart.customer_name,
          phone: cart.phone,
          items: cart.items,
          subtotalVnd: cart.subtotal_vnd,
          status: cart.status
        }
      });
    } catch (e) {
      if (e instanceof z.ZodError) {
        return res.status(400).json({ error: 'Mã khôi phục không hợp lệ.' });
      }
      next(e);
    }
  });

  // Public: Opt out of recovery reminders
  publicApi.get('/opt-out/:token', async (req, res) => {
    const token = req.params.token;
    res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Ngừng nhận nhắc nhở giỏ hàng · GAERU</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f7; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #fff; padding: 32px; border-radius: 18px; max-width: 480px; width: 100%; box-shadow: 0 4px 20px rgba(0,0,0,0.06); text-align: center; }
    h1 { font-size: 20px; color: #1d1d1f; margin: 0 0 12px; }
    p { font-size: 14px; color: #515154; margin: 0 0 24px; line-height: 1.5; }
    button { background: #0071e3; color: #fff; border: 0; padding: 12px 24px; border-radius: 20px; font-size: 14px; font-weight: 600; cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Ngừng nhận nhắc nhở giỏ hàng</h1>
    <p>Xác nhận nếu bạn không muốn GAERU tiếp tục gửi email nhắc về các sản phẩm bạn đã chọn trong giỏ hàng.</p>
    <form method="post" action="/api/abandoned-cart/opt-out/${escapeHtml(token)}">
      <button type="submit">Xác nhận ngừng nhận</button>
    </form>
  </div>
</body>
</html>`);
  });

  publicApi.post('/opt-out/:token', async (req, res) => {
    const token = req.params.token;
    await optOutAbandonedCart(pool, token);
    res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Đã ngừng nhận nhắc nhở · GAERU</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f7; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #fff; padding: 32px; border-radius: 18px; max-width: 480px; width: 100%; box-shadow: 0 4px 20px rgba(0,0,0,0.06); text-align: center; }
    h1 { font-size: 20px; color: #1d1d1f; margin: 0 0 12px; }
    p { font-size: 14px; color: #515154; margin: 0 0 24px; line-height: 1.5; }
    a { color: #0071e3; text-decoration: none; font-weight: 500; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Đã cập nhật tùy chọn của bạn</h1>
    <p>GAERU sẽ không gửi email nhắc nhở về giỏ hàng này nữa. Bạn vẫn có thể mua sắm bình thường tại cửa hàng.</p>
    <a href="/">← Quay lại trang chủ GAERU</a>
  </div>
</body>
</html>`);
  });

  return { admin, publicApi };
}

module.exports = {
  captureAbandonedCart,
  captureSchema,
  createAbandonedCartApi,
  listAbandonedCarts,
  makeMailer,
  markCartRecovered,
  optOutAbandonedCart,
  processAbandonedCartReminders,
  recoverCartByToken,
  sendRecoveryEmail,
  startAbandonedCartWorker
};
