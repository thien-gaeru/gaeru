const { Router } = require('express');
const { z } = require('zod');
const { randomBytes, createHash } = require('node:crypto');
const { withTransaction } = require('./db');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');
const { appendAudit } = require('./audit');
const { rateLimit } = require('express-rate-limit');
const { parseStrictPositiveInt } = require('./lib/input-validation');

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
  recoveryConsent: z.boolean().default(false),
  consentVersion: z.literal(2).optional()
}).strict();

function makeMailer(config) {
  if (!config?.smtp) return null;
  return require('nodemailer').createTransport(require('./smtp-security').smtpOptions(config.smtp));
}

/**
 * Capture or update an abandoned cart from checkout or cart interactions
 */
async function captureAbandonedCart(pool, { email, customerName = null, phone = null, items = [], recoveryConsent = false, customerId = null, allowedCartIds = null, enforceCustomerOwnership = false }) {
  const normEmail = String(email || '').trim().toLowerCase();
  if (!normEmail || !items.length || recoveryConsent !== true) return null;

  // Check if customer has opted out of marketing/recovery emails
  const suppressed = (await pool.query(
    'SELECT 1 FROM marketing_email_suppressions WHERE lower(trim(email)) = $1',
    [normEmail]
  )).rows.length > 0;

  if (suppressed) return null;

  // Calculate cart subtotal from database (excluding soft-deleted products & applying active promotions)
  const variantIds = items.map(i => i.variantId);
  const rawVariants = (await pool.query(
    `SELECT v.id, v.sku, v.name AS variant_name, v.price_vnd, v.stock_quantity,
            p.name AS product_name, p.slug AS product_slug, p.image_url AS product_image
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     WHERE v.id = ANY($1::uuid[]) AND v.active = true AND p.active = true AND p.deleted_at IS NULL`,
    [variantIds]
  )).rows;

  if (!rawVariants.length) return null;

  const variants = await require('./product-promotions').applyPromotions(pool, rawVariants);

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
  const nextReminderAt = new Date(Date.now() + 60 * 60 * 1000);

  return await withTransaction(pool, async client => {
    // Check if an existing abandoned cart exists for this email
    const existing = (await client.query(
      `SELECT id, status, customer_id FROM abandoned_carts
       WHERE lower(trim(email)) = $1 AND status IN ('abandoned', 'recovering')
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [normEmail]
    )).rows[0];

    if (existing) {
      if (existing.customer_id && existing.customer_id !== customerId) {
        throw fail('Email này hiện không thể đồng bộ giỏ hàng cho phiên hiện tại. Vui lòng đăng nhập tài khoản để tiếp tục.', 403);
      }
      if (!customerId && Array.isArray(allowedCartIds) && !allowedCartIds.includes(existing.id)) {
        throw fail('Email này hiện không thể đồng bộ giỏ hàng cho phiên hiện tại. Vui lòng đăng nhập tài khoản để tiếp tục.', 403);
      }
    } else if (enforceCustomerOwnership && !customerId) {
      const registeredCustomer = (await client.query(
        'SELECT id FROM customers WHERE lower(trim(email)) = $1 AND deleted_at IS NULL LIMIT 1',
        [normEmail]
      )).rows[0];
      if (registeredCustomer) {
        throw fail('Email này hiện không thể đồng bộ giỏ hàng cho phiên hiện tại. Vui lòng đăng nhập tài khoản để tiếp tục.', 403);
      }
    }

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
             consent_confirmed_at = now(),
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
           (customer_id, email, customer_name, phone, items, subtotal_vnd, recovery_token, recovery_token_hash, recovery_consent, next_reminder_at, consent_confirmed_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, now())
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
       WHERE (recovery_token = $1 OR recovery_token_hash = $2)
         AND recovery_consent AND status IN ('abandoned', 'recovering')
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
    if (!cart.email) return true;

    const retiredToken = 'retired:' + randomBytes(24).toString('hex');
    const retiredHash = hash(retiredToken);
    await client.query(
      `UPDATE abandoned_carts
       SET status = CASE WHEN status='recovered' THEN status ELSE 'opted_out' END,
           recovery_consent = false, consent_confirmed_at = NULL, next_reminder_at = NULL,
           recovery_token = $2, recovery_token_hash = $3,
           email = '', phone = NULL, customer_name = NULL, customer_id = NULL, items = '[]'::jsonb,
           subtotal_vnd = CASE WHEN status='recovered' THEN subtotal_vnd ELSE 0 END,
           version = version + 1, updated_at = now()
       WHERE id = $1`,
      [cart.id, retiredToken, retiredHash]
    );
    await client.query("UPDATE abandoned_cart_reminders SET email = '' WHERE cart_id = $1", [cart.id]);

    // Suppress future marketing/recovery emails to this address and keep newsletter subscription aligned
    await client.query(
      `INSERT INTO marketing_email_suppressions (email) VALUES ($1) ON CONFLICT DO NOTHING`,
      [cart.email.toLowerCase()]
    );
    await client.query(
      `UPDATE marketing_email_subscriptions
       SET status = 'unsubscribed', unsubscribed_at = now(), updated_at = now()
       WHERE lower(trim(email)) = $1 AND status = 'subscribed'`,
      [cart.email.toLowerCase()]
    );

    return true;
  });
}

/**
 * List abandoned carts for admin panel with recovery metrics
 */
async function listAbandonedCarts(pool, { page = 1, pageSize = 25, status = null } = {}) {
  const p = parseStrictPositiveInt(page, { defaultValue: 1, min: 1, max: 10000, message: 'Số trang giỏ hàng không hợp lệ.' });
  const offset = (p - 1) * pageSize;

  const whereClause = status ? 'WHERE ac.status = $3' : '';
  const params = status ? [pageSize, offset, status] : [pageSize, offset];

  const rows = (await pool.query(
    `SELECT ac.id, ac.customer_id, ac.email, ac.customer_name, ac.phone,
            ac.items, ac.subtotal_vnd, (ac.recovery_consent AND ac.consent_confirmed_at IS NOT NULL) AS recovery_consent, ac.status,
            ac.reminder_count, ac.max_reminders, ac.last_reminded_at,
            ac.next_reminder_at, ac.recovered_at, ac.order_id, ac.version,
            ac.created_at, ac.updated_at, o.order_number
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
  if (cart.status === 'recovered' || cart.status === 'expired') {
    return { success: false, reason: 'Giỏ hàng đã hoàn tất đơn hoặc đã hết hạn nhắc nhở.' };
  }
  if (!cart.recovery_consent || cart.status === 'opted_out') {
    return { success: false, reason: 'Khách hàng chưa đồng ý hoặc đã hủy nhận email nhắc giỏ hàng.' };
  }

  const normEmail = cart.email.toLowerCase();

  // Safeguard 1: Suppression check
  const suppressed = (await pool.query(
    'SELECT 1 FROM marketing_email_suppressions WHERE lower(trim(email)) = $1',
    [normEmail]
  )).rows.length > 0;

  if (suppressed) {
    await pool.query(`UPDATE abandoned_carts SET status = 'opted_out', next_reminder_at = NULL WHERE id = $1 AND status IN ('abandoned', 'recovering')`, [cart.id]);
    return { success: false, reason: 'Khách hàng đã hủy nhận email.' };
  }

  // Safeguard 2: Check if customer already ordered (by email or customer_id)
  const ordered = (await pool.query(
    `SELECT id, order_number FROM orders
     WHERE (lower(trim(email)) = $1 OR ($3::uuid IS NOT NULL AND customer_id = $3))
       AND status <> 'cancelled'
       AND created_at >= $2
     LIMIT 1`,
    [normEmail, cart.created_at, cart.customer_id || null]
  )).rows[0];

  if (ordered) {
    await pool.query(
      `UPDATE abandoned_carts SET status = 'recovered', order_id = $1, recovered_at = now(), next_reminder_at = NULL WHERE id = $2 AND status IN ('abandoned', 'recovering')`,
      [ordered.id, cart.id]
    );
    return { success: false, reason: 'Khách hàng đã hoàn tất đơn hàng.' };
  }

  const stage = stageOverride || (cart.reminder_count + 1);
  const publicBase = require('./primary-domain').normalizePublicBase(config.PUBLIC_BASE_URL || config.smtp?.publicBaseUrl || 'https://gaeru.com');
  const recoveryUrl = `${publicBase}/thanh-toan?recovery_token=${encodeURIComponent(cart.recovery_token)}`;
  const optOutUrl = `${publicBase}/api/abandoned-cart/opt-out/${encodeURIComponent(cart.recovery_token)}`;

  const greetingPlain = cart.customer_name ? `Chào ${cart.customer_name},` : 'Chào bạn,';

  let subject;
  let headline;
  let badgeText;
  let leadCopy;
  if (stage === 1) {
    subject = 'GAERU · Bạn còn sản phẩm trong giỏ hàng';
    headline = 'Giỏ hàng của bạn đang chờ hoàn tất';
    badgeText = 'GIỎ HÀNG CỦA BẠN';
    leadCopy = `${greetingPlain} Bạn vừa chọn sẵn sản phẩm tại GAERU. Chỉ một bước nữa để hoàn tất đơn hàng và được giữ ưu tiên tồn kho.`;
  } else if (stage === 2) {
    subject = 'GAERU · Đừng quên: Giỏ hàng của bạn vẫn đang được giữ';
    headline = 'Sản phẩm của bạn vẫn đang được giữ trong giỏ';
    badgeText = 'NHẮC LỊCH ĐƠN HÀNG';
    leadCopy = `${greetingPlain} Các sản phẩm bạn quan tâm vẫn đang sẵn sàng tại GAERU. Bấm tiếp tục để hoàn tất thanh toán nhanh chóng.`;
  } else {
    subject = 'GAERU · Cơ hội cuối cùng: Sản phẩm trong giỏ hàng sắp hết hạn giữ chỗ';
    headline = 'Cơ hội cuối cùng để hoàn tất đơn hàng của bạn';
    badgeText = 'SẮP HẾT HẠN GIỮ CHỖ';
    leadCopy = `${greetingPlain} Thời gian giữ chỗ cho giỏ hàng của bạn sắp kết thúc. Hoàn tất ngay hôm nay để đảm bảo đủ mẫu và phiên bản bạn đã chọn.`;
  }

  const items = Array.isArray(cart.items) ? cart.items : JSON.parse(cart.items || '[]');
  const itemsText = items.map(i => `- ${i.productName} (${i.variantName}) × ${i.quantity}: ${formatPrice(i.priceVnd * i.quantity)}`).join('\n');
  const lineItems = items.map(i => ({
    title: i.productName,
    meta: `${i.variantName || 'Phiên bản tiêu chuẩn'} · Số lượng: ${i.quantity}`,
    price: formatPrice(i.priceVnd * i.quantity)
  }));

  const text = `${greetingPlain}\n\n${headline}.\n\nSản phẩm trong giỏ của bạn:\n${itemsText}\n\nTạm tính: ${formatPrice(cart.subtotal_vnd)}\n\nKhôi phục và hoàn tất đơn hàng tại liên kết bên dưới:\n${recoveryUrl}\n\nNếu bạn không muốn tiếp tục nhận email nhắc giỏ hàng, hãy bấm từ chối tại:\n${optOutUrl}\n\nGAERU Team\nHotline: 082 919 1080 · Email: business@gaeru.com`;

  const { prepareOutboundMail } = require('./smtp-delivery');
  const preparedMail = prepareOutboundMail(
    config,
    {
      to: normEmail,
      subject,
      text,
      messageId: require('./smtp-delivery').buildMessageId('cart-recovery', config),
      headers: {
        'List-Unsubscribe': `<${optOutUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      }
    },
    {
      heading: headline,
      preheader: `${headline} — Tạm tính ${formatPrice(cart.subtotal_vnd)}.`,
      badge: badgeText,
      badgeTone: stage >= 3 ? 'amber' : 'blue',
      leadText: leadCopy,
      htmlBodyText: '',
      lineItems,
      summaryRows: [
        { label: 'Số lượng mặt hàng', value: `${items.length} sản phẩm` },
        { label: 'Tạm tính đơn hàng', value: formatPrice(cart.subtotal_vnd), emphasis: true, accent: true }
      ],
      actionUrl: recoveryUrl,
      actionLabel: 'Khôi phục giỏ hàng ngay',
      showActionFallback: true,
      footerNote: 'Email này được gửi tự động do có giỏ hàng chưa hoàn tất tại GAERU.',
      unsubscribeUrl: optOutUrl,
      unsubscribeLabel: 'Ngừng nhận nhắc nhở giỏ hàng'
    }
  );

  try {
    // A checkbox withdrawal or completed order may arrive after the worker claimed this job.
    const eligible = await pool.query(
      `SELECT 1 FROM abandoned_carts
       WHERE id = $1 AND version = $2 AND recovery_consent AND consent_confirmed_at IS NOT NULL
         AND status IN ('abandoned','recovering')`,
      [cart.id, cart.version]
    );
    if (!eligible.rows.length) return { success: false, reason: 'Giỏ hàng đã thay đổi hoặc đã ngừng nhắc.' };
    const result = await mailer.sendMail(preparedMail);

    const accepted = Array.isArray(result?.accepted)
      ? result.accepted.some(e => String(e.address || e).toLowerCase() === normEmail)
      : Boolean(result?.messageId);
    if (!accepted) throw new Error('Dịch vụ email chưa chấp nhận địa chỉ nhận. Chưa ghi nhận gửi nhắc thành công.');

    const didRecord = await withTransaction(pool, async c => {
      // Calculate next reminder cadence
      let nextReminderAt = null;
      let newStatus = cart.status;
      const newReminderCount = cart.reminder_count + 1;

      const maxReminders = Math.max(1, Number(cart.max_reminders) || 3);
      if (newReminderCount === 1 && newReminderCount < maxReminders) {
        nextReminderAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
      } else if (newReminderCount === 2 && newReminderCount < maxReminders) {
        nextReminderAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours
      } else {
        newStatus = 'expired';
      }

      const recorded = await c.query(
        `UPDATE abandoned_carts
         SET reminder_count = $2,
             last_reminded_at = now(),
             next_reminder_at = $3,
             status = $4,
             version = version + 1,
             updated_at = now()
         WHERE id = $1 AND version = $5 AND recovery_consent AND status IN ('abandoned', 'recovering')
         RETURNING id`,
        [cart.id, newReminderCount, nextReminderAt, newStatus, cart.version]
      );
      if (!recorded.rows.length) return false;
      await c.query(
        `INSERT INTO abandoned_cart_reminders (cart_id, stage, email, subject, status, sent_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [cart.id, stage, normEmail, subject, accepted ? 'sent' : 'failed']
      );
      return true;
    });

    if (!didRecord) {
      return { success: false, reason: 'Giỏ hàng đã thay đổi hoặc đã được xử lý đồng thời.' };
    }
    return { success: true, messageId: result?.messageId };
  } catch (err) {
    const { isPermanentSendMailError } = require('./customer-lifecycle');
    const priorFailRow = (await pool.query(
      "SELECT COUNT(*)::int AS fails FROM abandoned_cart_reminders WHERE cart_id = $1 AND status = 'failed'",
      [cart.id]
    )).rows[0];
    const totalFails = Number(priorFailRow?.fails || 0) + 1;
    const isHardBounce = isPermanentSendMailError(err);
    const shouldStop = isHardBounce || totalFails >= 5;
    const backoffMinutes = Math.min(24 * 60, 30 * (2 ** Math.min(4, Math.max(0, totalFails - 1))));
    await pool.query(
      `WITH pending AS (
         UPDATE abandoned_carts
         SET status = CASE WHEN $7::boolean THEN 'expired' ELSE status END,
             next_reminder_at = CASE WHEN $7::boolean THEN NULL ELSE now() + ($8::text || ' minutes')::interval END,
             version = CASE WHEN $7::boolean THEN version + 1 ELSE version END,
             updated_at = now()
         WHERE id = $1 AND version = $6 AND recovery_consent AND status IN ('abandoned','recovering')
         RETURNING id
       )
       INSERT INTO abandoned_cart_reminders (cart_id, stage, email, subject, status, error_message)
       SELECT id, $2, $3, $4, 'failed', $5 FROM pending`,
      [cart.id, stage, normEmail, subject, err.message, cart.version, shouldStop, String(backoffMinutes)]
    );
    return { success: false, error: err.message, permanentFailure: shouldStop };
  }
}

/**
 * Worker process for abandoned cart cadence
 */
const activeManualReminds = new Set();

async function processAbandonedCartReminders(pool, config, mailer) {
  if (!mailer || !config?.smtp?.from) return false;

  const candidate = await withTransaction(pool, async (client) => {
    const row = (await client.query(
      `SELECT * FROM abandoned_carts
       WHERE status IN ('abandoned', 'recovering')
         AND recovery_consent = true
         AND consent_confirmed_at IS NOT NULL
         AND next_reminder_at IS NOT NULL
         AND next_reminder_at <= now()
         AND reminder_count < max_reminders
       ORDER BY next_reminder_at ASC, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    )).rows[0];
    if (!row || activeManualReminds.has(row.id)) return null;
    const claimed = (await client.query(
      `UPDATE abandoned_carts
       SET next_reminder_at = now() + interval '15 minutes',
           version = version + 1,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [row.id]
    )).rows[0];
    return claimed || null;
  });

  if (!candidate) return false;
  if (activeManualReminds.has(candidate.id)) return false;

  activeManualReminds.add(candidate.id);
  try {
    await sendRecoveryEmail(pool, config, candidate, mailer);
  } finally {
    activeManualReminds.delete(candidate.id);
  }
  return true;
}

function startAbandonedCartWorker(pool, config, { mailer = makeMailer(config), intervalMs = 30000 } = {}) {
  let running = false;
  let stopped = false;

  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      for (let i = 0; i < 8 && !stopped; i++) {
        const handled = await processAbandonedCartReminders(pool, config, mailer);
        if (!handled) break;
      }
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
      if (activeManualReminds.has(id)) {
        throw fail('Email nhắc giỏ hàng đang được gửi. Vui lòng chờ hoàn tất.', 409);
      }
      activeManualReminds.add(id);
      try {
        const mailTransport = mailer || makeMailer(config);
        const cart = await withTransaction(pool, async (client) => {
          const existing = (await client.query(
            'SELECT * FROM abandoned_carts WHERE id = $1 FOR UPDATE',
            [id]
          )).rows[0];
          if (!existing) throw fail('Giỏ hàng không tồn tại.', 404);
          if (!['abandoned', 'recovering'].includes(existing.status)) {
            throw fail('Giỏ hàng này đã hoàn tất hoặc ngừng nhắc lịch.', 409);
          }
          if (!existing.recovery_consent || !existing.consent_confirmed_at) {
            throw fail('Khách hàng chưa đồng ý nhận email nhắc giỏ hàng.', 409);
          }
          const suppressed = (await client.query(
            'SELECT 1 FROM marketing_email_suppressions WHERE lower(trim(email)) = $1 LIMIT 1',
            [String(existing.email || '').trim().toLowerCase()]
          )).rows.length > 0;
          if (suppressed) {
            throw fail('Email này đã từ chối nhận thư tiếp thị.', 409);
          }
          if (!mailTransport) throw fail('Chưa cấu hình dịch vụ gửi email SMTP.', 503);
          const claimed = (await client.query(
            `UPDATE abandoned_carts
             SET next_reminder_at = now() + interval '15 minutes',
                 version = version + 1,
                 updated_at = now()
             WHERE id = $1
               AND status IN ('abandoned', 'recovering')
               AND recovery_consent = true
               AND consent_confirmed_at IS NOT NULL
             RETURNING *`,
            [id]
          )).rows[0];
          if (!claimed) throw fail('Giỏ hàng này đã hoàn tất hoặc ngừng nhắc lịch.', 409);
          return claimed;
        });

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
      } finally {
        activeManualReminds.delete(id);
      }
    } catch (e) {
      next(e);
    }
  });

  // Admin: Cancel reminders for cart
  admin.post('/marketing/abandoned-carts/:id/cancel', requirePermission('marketing.write'), requireCsrf, async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const updated = await pool.query(
        `UPDATE abandoned_carts
         SET status = 'expired', next_reminder_at = NULL, version = version + 1, updated_at = now()
         WHERE id = $1 AND status IN ('abandoned', 'recovering')
         RETURNING id`,
        [id]
      );
      if (!updated.rows.length) {
        throw fail('Giỏ hàng này đã hoàn tất khôi phục hoặc đã dừng nhắc nhở.', 409);
      }
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
  // Session ownership is issued after a successful capture. A caller cannot withdraw another shopper's cart by email.
  async function withdrawSessionCarts(req, email = null, requestedIds = null) {
    const owned = req.session?.abandonedCartIds || [];
    const ids = requestedIds ? requestedIds.filter(id => owned.includes(id)) : owned;
    if (!ids.length) return;
    await withTransaction(pool, async client => {
      const changed = await client.query(
        `UPDATE abandoned_carts SET status = CASE WHEN status='recovered' THEN status ELSE 'opted_out' END, recovery_consent = false,
           consent_confirmed_at = NULL, next_reminder_at = NULL, version = version + 1,
           email = '', phone = NULL, customer_name = NULL, customer_id = NULL,
           items = '[]'::jsonb, subtotal_vnd = CASE WHEN status='recovered' THEN subtotal_vnd ELSE 0 END, updated_at = now()
         WHERE id = ANY($1::uuid[]) AND (customer_id IS NULL OR customer_id = $2::uuid)
           AND ($3::text IS NULL OR lower(trim(email)) = $3) AND status IN ('abandoned','recovering','recovered')
         RETURNING id`, [ids, req.session?.customer?.id || null, email]
      );
      if (changed.rows.length) {
        await client.query("UPDATE abandoned_cart_reminders SET email = '' WHERE cart_id = ANY($1::uuid[])", [changed.rows.map(row => row.id)]);
      }
    });
  }
  publicApi.post('/withdraw', requireCsrf, async (req, res, next) => {
    try {
      const payload = z.object({ cartIds: z.array(z.string().uuid()).max(20).optional() }).strict().safeParse(req.body || {});
      if (!payload.success) return res.status(400).json({ error: 'Danh sách giỏ hàng chưa hợp lệ.' });
      await withdrawSessionCarts(req, null, payload.data.cartIds);
      res.sendStatus(204);
    } catch (error) { next(error); }
  });
  publicApi.post('/capture', (req, res, next) => (req.session?.customer || req.session?.admin) ? require('./security').requireCsrf(req, res, next) : next(), rateLimit({ ...require('./security-hardening').sharedStore(pool, config || {}, 'abandoned-capture'), windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res, next) => {
    try {
      const parsed = captureSchema.parse(req.body);
      if (!parsed.recoveryConsent) {
        await withdrawSessionCarts(req, parsed.email);
        return res.sendStatus(204);
      }
      // Older pages pre-selected this checkbox. They do not establish explicit consent.
      if (parsed.consentVersion !== 2) return res.sendStatus(204);
      const customerId = req.session?.customer?.id || null;
      const allowedCartIds = !customerId
        ? (Array.isArray(req.session?.abandonedCartIds) ? req.session.abandonedCartIds : [])
        : null;

      const result = await captureAbandonedCart(pool, {
        email: parsed.email,
        customerName: parsed.customerName,
        phone: parsed.phone,
        items: parsed.items,
        recoveryConsent: parsed.recoveryConsent,
        customerId,
        allowedCartIds,
        enforceCustomerOwnership: true
      });

      if (!result) return res.sendStatus(204);
      if (req.session) {
        const owned = Array.isArray(req.session.abandonedCartIds) ? req.session.abandonedCartIds : [];
        if (!owned.includes(result.cart.id)) {
          req.session.abandonedCartIds = [...owned, result.cart.id].slice(-20);
        }
      }
      res.status(201).json({ success: true, cartId: result.cart.id });
    } catch (e) {
      if (e instanceof z.ZodError) {
        return res.status(400).json({ error: 'Thông tin liên hệ hoặc giỏ hàng chưa hợp lệ.' });
      }
      if (e?.status) {
        return res.status(e.status).json({ error: e.message });
      }
      next(e);
    }
  });

  // Public: Recover cart via recovery token
  publicApi.get('/recover/:token', rateLimit({ ...require('./security-hardening').sharedStore(pool, config || {}, 'abandoned-recover'), windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res, next) => {
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

  function renderOptOutCardHtml(opts) {
    const iconType = opts.iconType || "info";
    const iconMarkup = iconType === "success"
      ? '<div class="ac-icon is-success" aria-hidden="true">✓</div>'
      : (iconType === "error"
        ? '<div class="ac-icon is-error" aria-hidden="true">!</div>'
        : '<div class="ac-icon is-info" aria-hidden="true">i</div>');
    return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#fbfbfd">
  <link rel="icon" type="image/webp" href="/assets/brand/gaeru-logo.webp">
  <link rel="apple-touch-icon" href="/assets/brand/gaeru-app-192.png">
  <title>${escapeHtml(opts.title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f5f5f7; color: #1d1d1f; color-scheme: light; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 36px 16px; box-sizing: border-box; -webkit-font-smoothing: antialiased; }
    main.card { background: #ffffff; border: 1px solid #e5e5ea; padding: 40px 34px; border-radius: 24px; max-width: 500px; width: 100%; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.05); text-align: center; box-sizing: border-box; }
    .ac-brand { font-size: 26px; font-weight: 700; letter-spacing: -0.03em; color: #1d1d1f; margin-bottom: 18px; }
    .ac-icon { width: 50px; height: 50px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; font-size: 21px; font-weight: 700; }
    .ac-icon.is-success { background: #e8f5e9; color: #2e7d32; }
    .ac-icon.is-error { background: #fee2e2; color: #dc2626; }
    .ac-icon.is-info { background: rgba(0, 113, 227, 0.1); color: #0060c7; }
    h1 { font-size: 21px; line-height: 1.3; font-weight: 600; color: #1d1d1f; margin: 0 0 12px; }
    p { font-size: 15px; color: #515154; margin: 0 0 26px; line-height: 1.6; }
    .ac-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; background: #0071e3; color: #ffffff; border: 0; padding: 11px 28px; border-radius: 980px; font-size: 15px; font-weight: 600; text-decoration: none; cursor: pointer; box-shadow: 0 2px 8px rgba(0, 113, 227, 0.22); box-sizing: border-box; }
    .ac-btn.is-dark { background: #1d1d1f; box-shadow: none; }
    @media (max-width: 520px) {
      body { padding: 20px 12px; }
      main.card { padding: 28px 20px; border-radius: 20px; }
      h1 { font-size: 19px; }
      .ac-btn { width: 100%; padding: 12px 20px; }
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="ac-brand">GAERU</div>
    ${iconMarkup}
    <h1>${escapeHtml(opts.heading)}</h1>
    <p>${escapeHtml(opts.message)}</p>
    ${opts.actionHtml || ""}
  </main>
</body>
</html>`;
  }

  // Public: Opt out of recovery reminders
  publicApi.get('/opt-out/:token', async (req, res) => {
    const rawToken = typeof req.params.token === 'string' ? req.params.token.trim() : '';
    if (rawToken === 'test-preview') {
      return res.status(200).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
        renderOptOutCardHtml({
          title: 'Xem trước ngừng nhắc giỏ hàng · GAERU',
          heading: 'Liên kết xem trước (Email thử nghiệm)',
          message: 'Đây là mẫu trang ngừng nhận nhắc nhở giỏ hàng dành cho quản trị viên xem trước. Trong email nhắc giỏ hàng thực tế, khách hàng có thể xác nhận hủy nhận nhắc nhở ngay tại đây.',
          iconType: 'info',
          actionHtml: '<div><a class="ac-btn" href="/">Về trang chủ GAERU</a></div>'
        })
      );
    }
    const parsedToken = z.string().trim().min(20).max(128).safeParse(rawToken);
    if (!parsedToken.success || /\s/.test(parsedToken.data)) {
      return res.status(400).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
        renderOptOutCardHtml({
          title: 'Liên kết không hợp lệ · GAERU',
          heading: 'Liên kết hủy nhận nhắc nhở không hợp lệ',
          message: 'Đường dẫn hủy nhận nhắc nhở không đúng định dạng hoặc đã hết hiệu lực. Vui lòng liên hệ business@gaeru.com nếu bạn cần hỗ trợ.',
          iconType: 'error',
          actionHtml: '<div><a class="ac-btn" href="/">Về trang chủ GAERU</a></div>'
        })
      );
    }
    const token = parsedToken.data;
    res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
      renderOptOutCardHtml({
        title: 'Ngừng nhận nhắc nhở giỏ hàng · GAERU',
        heading: 'Ngừng nhận nhắc nhở giỏ hàng',
        message: 'Xác nhận nếu bạn không muốn GAERU tiếp tục gửi email nhắc về các sản phẩm bạn đã chọn trong giỏ hàng.',
        iconType: 'info',
        actionHtml: `<form method="post" action="/api/abandoned-cart/opt-out/${escapeHtml(token)}"><button type="submit" class="ac-btn is-dark">Xác nhận ngừng nhận</button></form>`
      })
    );
  });

  publicApi.post('/opt-out/:token', async (req, res) => {
    const listUnsubHeader = req.get('list-unsubscribe');
    const isRfc8058 = Boolean(
      (listUnsubHeader && listUnsubHeader.trim().toLowerCase() === 'one-click') ||
      req.body?.['List-Unsubscribe'] === 'One-Click' ||
      req.body?.['list-unsubscribe'] === 'One-Click'
    );
    const token = typeof req.params.token === 'string' ? req.params.token.trim() : '';
    if (token === 'test-preview') {
      if (isRfc8058 || !req.accepts('html')) return res.status(200).type('text/plain').send('Unsubscribed');
      return res.status(200).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
        renderOptOutCardHtml({
          title: 'Xem trước ngừng nhắc giỏ hàng · GAERU',
          heading: 'Đã kiểm tra mẫu ngừng nhắc giỏ hàng',
          message: 'Đây là liên kết mẫu xem trước nên không thay đổi dữ liệu giỏ hàng thực tế.',
          iconType: 'info',
          actionHtml: '<div><a class="ac-btn" href="/">Về trang chủ GAERU</a></div>'
        })
      );
    }
    if (token.length < 20 || token.length > 128 || /\s/.test(token)) {
      if (isRfc8058 || req.accepts(['html', 'json']) !== 'html') {
        return res.status(400).json({ ok: false, error: 'Token không hợp lệ.' });
      }
      return res.status(400).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
        renderOptOutCardHtml({
          title: 'Liên kết không hợp lệ · GAERU',
          heading: 'Liên kết hủy nhận nhắc nhở không hợp lệ',
          message: 'Đường dẫn không đúng định dạng hoặc đã hết hiệu lực. Vui lòng liên hệ business@gaeru.com nếu cần hỗ trợ.',
          iconType: 'error',
          actionHtml: '<div><a class="ac-btn" href="/">Về trang chủ GAERU</a></div>'
        })
      );
    }
    await optOutAbandonedCart(pool, token);
    if (isRfc8058 || !req.accepts('html')) {
      return res.status(200).type('text/plain').send('Unsubscribed');
    }
    res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
      renderOptOutCardHtml({
        title: 'Đã ngừng nhận nhắc nhở · GAERU',
        heading: 'Đã cập nhật tùy chọn của bạn',
        message: 'GAERU sẽ không gửi email nhắc nhở về giỏ hàng này nữa. Bạn vẫn có thể mua sắm bình thường tại cửa hàng.',
        iconType: 'success',
        actionHtml: '<div><a class="ac-btn" href="/">Về trang chủ GAERU</a></div>'
      })
    );
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
