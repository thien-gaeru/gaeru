const { Router } = require('express');
const { z } = require('zod');
const { randomBytes, createHash } = require('node:crypto');
const { withTransaction } = require('./db');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');
const { appendAudit } = require('./audit');
const { rateLimit } = require('express-rate-limit');
const { normalizePublicBase } = require('./primary-domain');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const emailSchema = z.string().trim().email().max(254).transform(v => v.toLowerCase());

const campaignSchema = z.object({
  title: z.string().trim().min(3).max(160),
  subject: z.string().trim().min(3).max(160).regex(/^[^\r\n]+$/),
  body: z.string().trim().min(10).max(12000),
  sources: z.array(z.enum(['subscribers', 'customers', 'orders', 'suppliers'])).min(1).max(4),
  scheduledAt: z.string().datetime({ offset: true }),
  ratePerMinute: z.number().int().min(1).max(12)
}).strict();

const subscribeSchema = z.object({
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  consent: z.literal(true, { errorMap: () => ({ message: 'Vui lòng xác nhận đồng ý nhận tin.' }) }),
  source: z.string().trim().max(60).optional().default('web_footer')
}).strict();

const testSendSchema = z.object({
  to: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  subject: z.string().trim().min(3).max(160).regex(/^[^\r\n]+$/),
  body: z.string().trim().min(10).max(12000)
}).strict();

const h = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = t => createHash('sha256').update(String(t)).digest('hex');

function makeMailer(config) {
  if (!config || !config.smtp) return null;
  const s = config.smtp;
  return require('nodemailer').createTransport(require('./smtp-security').smtpOptions(s));
}

/**
 * Lọc danh sách người nhận email marketing:
 * Chỉ gửi cho khách hàng đã chủ động đăng ký và xác nhận (Double Opt-In):
 * status = 'subscribed' AND confirmed_at IS NOT NULL
 * Loại trừ tài khoản bị khóa/xóa, và danh sách suppressions.
 */
async function audience(client, sources = ['subscribers']) {
  const parts = [];
  if (sources.includes('subscribers')) {
    parts.push("SELECT lower(trim(s.email)) AS email FROM marketing_email_subscriptions s WHERE s.status = 'subscribed' AND s.confirmed_at IS NOT NULL");
  }
  if (sources.includes('customers')) {
    parts.push("SELECT lower(trim(s.email)) AS email FROM marketing_email_subscriptions s JOIN customers c ON lower(trim(c.email)) = lower(trim(s.email)) WHERE s.status = 'subscribed' AND s.confirmed_at IS NOT NULL AND c.active = true AND c.deleted_at IS NULL");
  }
  if (sources.includes('orders')) {
    parts.push("SELECT lower(trim(s.email)) AS email FROM marketing_email_subscriptions s JOIN orders o ON lower(trim(o.email)) = lower(trim(s.email)) WHERE s.status = 'subscribed' AND s.confirmed_at IS NOT NULL");
  }
  if (sources.includes('suppliers')) {
    parts.push("SELECT lower(trim(s.email)) AS email FROM marketing_email_subscriptions s JOIN suppliers sup ON lower(trim(sup.email)) = lower(trim(s.email)) WHERE s.status = 'subscribed' AND s.confirmed_at IS NOT NULL AND sup.active = true");
  }
  if (!parts.length) return [];

  const query = `
    SELECT DISTINCT email FROM (${parts.join(' UNION ALL ')}) contacts
    WHERE email <> ''
      AND NOT EXISTS (SELECT 1 FROM marketing_email_suppressions sup WHERE lower(trim(sup.email)) = contacts.email)
      AND NOT EXISTS (SELECT 1 FROM customers c WHERE lower(trim(c.email)) = contacts.email AND (c.active = false OR c.deleted_at IS NOT NULL))
    ORDER BY email LIMIT 50001
  `;
  const rows = (await client.query(query)).rows;
  if (rows.length > 50000) throw fail('Danh sách vượt 50.000 địa chỉ. Chia theo nguồn email để lên lịch.');
  return rows.map(r => r.email).filter(e => emailSchema.safeParse(e).success);
}

const wrap = fn => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof z.ZodError) {
      const firstIssue = e.issues?.[0]?.message;
      return res.status(400).json({ error: firstIssue || 'Kiểm tra tiêu đề, nội dung, nguồn email và thời gian gửi.' });
    }
    next(e);
  }
};

async function listing(pool) {
  return (await pool.query(`
    SELECT c.*,
      count(r.id)::int AS total,
      count(r.id) FILTER(WHERE r.status='sent')::int AS sent,
      count(r.id) FILTER(WHERE r.status='pending')::int AS pending,
      count(r.id) FILTER(WHERE r.status='failed')::int AS failed,
      count(r.id) FILTER(WHERE r.status='unknown')::int AS unknown,
      count(r.id) FILTER(WHERE r.status='skipped')::int AS skipped
    FROM marketing_email_campaigns c
    LEFT JOIN marketing_email_recipients r ON r.campaign_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC, c.id
    LIMIT 25
  `)).rows;
}

function createEmailMarketing(pool, config, { mailer = makeMailer(config) } = {}) {
  const admin = Router();
  const publicApi = Router();

  admin.use('/marketing/emails', requirePermission('marketing.read'));

  admin.get('/marketing/emails', wrap(async (req, res) => {
    const campaigns = await listing(pool);
    const configured = Boolean(config.smtp && (config.PUBLIC_BASE_URL || config.smtp?.publicBaseUrl));
    const audienceCount = (await audience(pool, ['subscribers'])).length;

    const subStatsRow = (await pool.query(`
      SELECT
        count(*) FILTER (WHERE status = 'subscribed' AND confirmed_at IS NOT NULL)::int AS subscribed,
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'unsubscribed')::int AS unsubscribed
      FROM marketing_email_subscriptions
    `)).rows[0] || { subscribed: 0, pending: 0, unsubscribed: 0 };

    const smtpStatsRow = (await pool.query(`
      SELECT
        count(*) FILTER (WHERE status = 'sent')::int AS total_sent,
        count(*) FILTER (WHERE status = 'failed')::int AS total_failed,
        count(*) FILTER (WHERE status = 'unknown')::int AS total_unknown,
        count(*) FILTER (WHERE status = 'sent' AND finished_at >= now() - interval '24 hours')::int AS sent_24h
      FROM marketing_email_recipients
    `)).rows[0] || { total_sent: 0, total_failed: 0, total_unknown: 0, sent_24h: 0 };

    const recentSubscribers = (await pool.query(`
      SELECT email, status, consent_source, consent_version, consent_at, confirmed_at, unsubscribed_at
      FROM marketing_email_subscriptions
      ORDER BY updated_at DESC
      LIMIT 20
    `)).rows;

    res.json({
      campaigns,
      configured,
      audienceCount,
      subscriberStats: subStatsRow,
      smtpStats: smtpStatsRow,
      subscribers: recentSubscribers
    });
  }));

  admin.post('/marketing/emails/audience', requirePermission('marketing.write'), requireCsrf, wrap(async (req, res) => {
    const sources = campaignSchema.shape.sources.parse(req.body.sources);
    res.json({ count: (await audience(pool, sources)).length });
  }));

  admin.post('/marketing/emails', requirePermission('marketing.write'), requireCsrf, wrap(async (req, res) => {
    const d = campaignSchema.parse(req.body.data);
    const item = await withTransaction(pool, async c => {
      const r = (await c.query(
        'INSERT INTO marketing_email_campaigns(title,subject,body,sources,scheduled_at,rate_per_minute) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [d.title, d.subject, d.body, JSON.stringify(d.sources), d.scheduledAt, d.ratePerMinute]
      )).rows[0];
      await appendAudit(c, { actor: req.admin, action: 'marketing.email.draft', entityType: 'marketing', entityId: r.id, metadata: { sources: d.sources } });
      return r;
    });
    res.status(201).json({ item });
  }));

  admin.put('/marketing/emails/:id', requirePermission('marketing.write'), requireCsrf, wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const d = campaignSchema.parse(req.body.data);
    const version = z.number().int().positive().parse(req.body.version);
    const item = await withTransaction(pool, async c => {
      const r = (await c.query(
        "UPDATE marketing_email_campaigns SET title=$3,subject=$4,body=$5,sources=$6,scheduled_at=$7,rate_per_minute=$8,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND status='draft' RETURNING *",
        [id, version, d.title, d.subject, d.body, JSON.stringify(d.sources), d.scheduledAt, d.ratePerMinute]
      )).rows[0];
      if (!r) throw fail('Chỉ sửa bản nháp còn đúng phiên bản. Tải lại dữ liệu.', 409);
      await appendAudit(c, { actor: req.admin, action: 'marketing.email.edit', entityType: 'marketing', entityId: id });
      return r;
    });
    res.json({ item });
  }));

  admin.post('/marketing/emails/:id/schedule', requirePermission('marketing.write'), requireCsrf, wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const version = z.number().int().positive().parse(req.body.version);
    if (req.body.confirmation !== 'SCHEDULE_EMAILS') throw fail('Xác nhận nội dung và danh sách trước khi lên lịch.');
    if (!config.smtp || !(config.PUBLIC_BASE_URL || config.smtp.publicBaseUrl)) {
      throw fail('Chưa cấu hình SMTP và địa chỉ website để gửi thư.', 503);
    }
    const count = await withTransaction(pool, async c => {
      const item = (await c.query("SELECT * FROM marketing_email_campaigns WHERE id=$1 AND version=$2 AND status='draft' FOR UPDATE", [id, version])).rows[0];
      if (!item) throw fail('Chiến dịch đã thay đổi hoặc đã lên lịch.', 409);
      if (new Date(item.scheduled_at).getTime() < Date.now() + 30000) throw fail('Chọn thời gian gửi sau hiện tại ít nhất 30 giây.');
      const emails = await audience(c, item.sources);
      if (!emails.length) throw fail('Chưa có địa chỉ email đủ điều kiện.');
      if (req.body.expectedCount !== emails.length) throw fail('Danh sách người nhận đã thay đổi. Tải lại số lượng rồi xác nhận.', 409);
      await c.query('INSERT INTO marketing_email_recipients(campaign_id,email) SELECT $1,unnest($2::text[])', [id, emails]);
      await c.query("UPDATE marketing_email_campaigns SET status='scheduled',version=version+1,updated_at=now() WHERE id=$1", [id]);
      await appendAudit(c, { actor: req.admin, action: 'marketing.email.schedule', entityType: 'marketing', entityId: id, metadata: { count: emails.length, scheduledAt: item.scheduled_at } });
      return emails.length;
    });
    res.json({ message: 'Đã lên lịch gửi cho ' + count + ' địa chỉ duy nhất.', count });
  }));

  admin.post('/marketing/emails/:id/cancel', requirePermission('marketing.write'), requireCsrf, wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const version = z.number().int().positive().parse(req.body.version);
    await withTransaction(pool, async c => {
      const r = await c.query("UPDATE marketing_email_campaigns SET status='cancelled',version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND status IN ('draft','scheduled','sending') RETURNING id", [id, version]);
      if (!r.rows.length) throw fail('Chiến dịch đã thay đổi hoặc đã kết thúc.', 409);
      await c.query("UPDATE marketing_email_recipients SET status='skipped',result='Chiến dịch đã hủy',finished_at=now() WHERE campaign_id=$1 AND status='pending'", [id]);
      await appendAudit(c, { actor: req.admin, action: 'marketing.email.cancel', entityType: 'marketing', entityId: id });
    });
    try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: 'emails', id, status: 'cancelled' }); } catch (_) {}
    res.json({ message: 'Đã dừng hàng đợi. Thư đang chuyển giao có thể vẫn được gửi.' });
  }));

  admin.delete('/marketing/emails/:id', requirePermission('marketing.write'), requireCsrf, wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await withTransaction(pool, async c => {
      const old = (await c.query('SELECT * FROM marketing_email_campaigns WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!old) throw fail('Chiến dịch email không tồn tại hoặc đã bị xóa.', 404);
      if (['scheduled', 'sending'].includes(old.status)) {
        throw fail('Vui lòng dừng chiến dịch email trước khi xóa.', 400);
      }
      await c.query('DELETE FROM marketing_email_recipients WHERE campaign_id=$1', [id]);
      await c.query('DELETE FROM marketing_email_campaigns WHERE id=$1', [id]);
      await appendAudit(c, { actor: req.admin, action: 'marketing.email.delete', entityType: 'marketing', entityId: id, before: old });
    });
    try { require('./realtime-sse').publishAdminEvent('marketing:update', { kind: 'emails', id, deleted: true }); } catch (_) {}
    res.json({ success: true, message: 'Đã xóa chiến dịch email thành công.' });
  }));

  admin.post('/marketing/emails/test-send', requirePermission('marketing.write'), requireCsrf, wrap(async (req, res) => {
    const d = testSendSchema.parse(req.body);
    if (!config.smtp || !(config.PUBLIC_BASE_URL || config.smtp?.publicBaseUrl)) {
      throw fail('Chưa cấu hình SMTP và địa chỉ website để gửi thư thử nghiệm.', 503);
    }
    const currentMailer = mailer || makeMailer(config);
    if (!currentMailer) throw fail('Dịch vụ SMTP không khả dụng.', 503);
    const testSubject = '[THỬ NGHIỆM] ' + d.subject;
    const dummyUnsubUrl = new URL('/api/marketing-email/unsubscribe/test-preview', normalizePublicBase(config.PUBLIC_BASE_URL || config.smtp.publicBaseUrl)).toString();
    await currentMailer.sendMail({
      from: config.smtp.from,
      to: d.to,
      subject: testSubject,
      text: d.body + '\n\nGAERU · Thư thử nghiệm marketing (Liên kết ngừng nhận mẫu: ' + dummyUnsubUrl + ')',
      html: '<!doctype html><html lang="vi"><meta charset="utf-8"><body><main style="max-width:600px;margin:20px auto;font-family:sans-serif;color:#1d1d1f;line-height:1.6;"><div style="background:#f5f5f7;padding:8px 16px;border-radius:8px;font-size:12px;color:#86868b;margin-bottom:16px;">[EMAIL THỬ NGHIỆM TỪ TRANG QUẢN TRỊ GAERU]</div><h1>' + h(d.subject) + '</h1><div style="white-space:pre-wrap">' + h(d.body) + '</div><hr style="border:none;border-top:1px solid #d2d2d7;margin:24px 0;"><p style="font-size:12px;color:#86868b;">GAERU · <a href="' + h(dummyUnsubUrl) + '">Ngừng nhận email khuyến mại (Mẫu xem trước)</a></p></main></body></html>'
    });
    await appendAudit(pool, { actor: req.admin, action: 'marketing.email.test_send', entityType: 'marketing', metadata: { to: d.to, subject: testSubject } });
    res.json({ message: 'Đã gửi email thử nghiệm thành công tới ' + d.to });
  }));

  publicApi.use(require('express').urlencoded({ extended: false, limit: '32kb' }));
  publicApi.use(rateLimit({ windowMs: 900000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }));

  // Double Opt-In Subscribe
  publicApi.post('/subscribe', wrap(async (req, res) => {
    const { email, consent, source } = subscribeSchema.parse(req.body);
    const token = randomBytes(32).toString('hex');
    const tokenHash = hash(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const ipHash = hash(req.ip || req.socket?.remoteAddress || '');
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 255);

    const existing = (await pool.query('SELECT status FROM marketing_email_subscriptions WHERE email = $1', [email])).rows[0];
    if (existing && existing.status === 'subscribed') {
      return res.json({ status: 'subscribed', message: 'Địa chỉ email này đã hoàn tất đăng ký nhận tin từ trước.' });
    }

    await withTransaction(pool, async c => {
      await c.query(`
        INSERT INTO marketing_email_subscriptions (
          email, status, consent_source, consent_version, consent_at,
          confirmation_token_hash, confirmation_expires_at, updated_at
        ) VALUES ($1, 'pending', $2, 'v2026.11', now(), $3, $4, now())
        ON CONFLICT (email) DO UPDATE SET
          status = CASE WHEN marketing_email_subscriptions.status = 'subscribed' THEN 'subscribed' ELSE 'pending' END,
          consent_source = EXCLUDED.consent_source,
          consent_version = EXCLUDED.consent_version,
          consent_at = now(),
          confirmation_token_hash = EXCLUDED.confirmation_token_hash,
          confirmation_expires_at = EXCLUDED.confirmation_expires_at,
          updated_at = now()
      `, [email, source, tokenHash, expiresAt]);

      await c.query(`
        INSERT INTO marketing_email_consent_events (email, event_type, source, ip_hash, user_agent)
        VALUES ($1, 'opt_in_requested', $2, $3, $4)
      `, [email, source, ipHash, userAgent]);
    });

    const currentMailer = mailer || makeMailer(config);
    if (currentMailer && config.smtp && (config.PUBLIC_BASE_URL || config.smtp?.publicBaseUrl)) {
      const confirmUrl = new URL('/api/marketing-email/confirm/' + token, normalizePublicBase(config.PUBLIC_BASE_URL || config.smtp.publicBaseUrl)).toString();
      try {
        await currentMailer.sendMail({
          from: config.smtp.from,
          to: email,
          subject: 'Xác nhận đăng ký nhận tin từ GAERU',
          text: `Chào bạn,\n\nCảm ơn bạn đã quan tâm đến GAERU. Vui lòng bấm vào liên kết dưới đây để xác nhận đăng ký nhận thông tin về sản phẩm microphone, phụ kiện và ưu đãi:\n${confirmUrl}\n\nLiên kết có hiệu lực trong 24 giờ. Nếu bạn không yêu cầu đăng ký này, vui lòng bỏ qua email này.\n\nTrân trọng,\nĐội ngũ GAERU`,
          html: `<!doctype html><html lang="vi"><meta charset="utf-8"><body style="margin:0;padding:32px 16px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;"><main style="max-width:560px;margin:20px auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:24px;padding:40px 36px;box-shadow:0 4px 20px rgba(0,0,0,0.03);text-align:center;"><div style="font-size:26px;font-weight:700;letter-spacing:-0.03em;color:#1d1d1f;margin-bottom:20px;">GAERU</div><h2 style="font-size:20px;font-weight:600;color:#1d1d1f;margin:0 0 12px;">Xác nhận đăng ký nhận tin</h2><p style="font-size:15px;line-height:1.6;color:#515156;margin:0 0 24px;">Cảm ơn bạn đã quan tâm đến GAERU. Vui lòng bấm vào nút bên dưới để xác nhận đăng ký nhận thông tin về sản phẩm microphone, phụ kiện và ưu đãi:</p><div style="margin:28px 0;"><a href="${h(confirmUrl)}" style="background:#0071e3;color:#ffffff;text-decoration:none;padding:13px 32px;border-radius:980px;font-weight:600;font-size:15px;display:inline-block;box-shadow:0 2px 8px rgba(0,113,227,0.25);">Xác nhận đăng ký nhận tin</a></div><p style="font-size:13px;color:#86868b;line-height:1.5;margin:0;">Liên kết có hiệu lực trong 24 giờ. Nếu nút trên không hoạt động, bạn có thể truy cập liên kết trực tiếp:<br><a href="${h(confirmUrl)}" style="color:#0071e3;word-break:break-all;">${h(confirmUrl)}</a></p><hr style="border:none;border-top:1px solid #f0f0f2;margin:28px 0 20px;"><p style="font-size:12px;color:#86868b;margin:0;">Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua thư này.<br>© 2026 GAERU · gaeru.com</p></main></body></html>`
        });
      } catch (err) {
        console.error('Không gửi được email xác nhận Double Opt-In:', err.message);
      }
    }

    res.json({ status: 'pending', message: 'Vui lòng kiểm tra hộp thư để xác nhận đăng ký nhận tin.' });
  }));

  // Confirm Double Opt-In Link
  publicApi.get('/confirm/:token', wrap(async (req, res) => {
    const token = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.token);
    const tokenHash = hash(token);
    const ipHash = hash(req.ip || req.socket?.remoteAddress || '');
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 255);

    const row = (await pool.query(
      `SELECT email FROM marketing_email_subscriptions
       WHERE confirmation_token_hash = $1 AND confirmation_expires_at > now()`,
      [tokenHash]
    )).rows[0];

    if (!row) {
      return res.status(400).set('Cache-Control', 'no-store').type('html').send(`
        <!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Xác nhận đăng ký - GAERU</title>
        <body style="margin:0;padding:40px 16px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;">
          <main style="max-width:520px;margin:40px auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:24px;padding:44px 36px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,0.04);">
            <div style="font-size:28px;font-weight:700;letter-spacing:-0.03em;color:#1d1d1f;margin-bottom:20px;">GAERU</div>
            <div style="width:52px;height:52px;border-radius:50%;background:#fee2e2;color:#dc2626;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:24px;font-weight:700;">!</div>
            <h1 style="font-size:22px;font-weight:600;color:#1d1d1f;margin:0 0 12px;">Liên kết không hợp lệ hoặc đã hết hạn</h1>
            <p style="font-size:15px;line-height:1.6;color:#515156;margin:0 0 28px;">Liên kết xác nhận chỉ sử dụng một lần và có hiệu lực trong 24 giờ. Vui lòng đăng ký lại trên website GAERU.</p>
            <div><a href="/" style="display:inline-block;padding:12px 32px;background:#0071e3;color:#fff;border-radius:980px;text-decoration:none;font-weight:600;font-size:15px;box-shadow:0 2px 8px rgba(0,113,227,0.25);">Về trang chủ GAERU</a></div>
          </main>
        </body></html>
      `);
    }

    await withTransaction(pool, async c => {
      await c.query(`
        UPDATE marketing_email_subscriptions
        SET status = 'subscribed', confirmed_at = now(), confirmation_token_hash = NULL,
            confirmation_expires_at = NULL, updated_at = now()
        WHERE email = $1
      `, [row.email]);

      await c.query('DELETE FROM marketing_email_suppressions WHERE lower(trim(email)) = $1', [row.email]);

      await c.query(`
        INSERT INTO marketing_email_consent_events (email, event_type, source, ip_hash, user_agent)
        VALUES ($1, 'confirmed', 'confirmation_link', $2, $3)
      `, [row.email, ipHash, userAgent]);
    });

    res.set('Cache-Control', 'no-store').type('html').send(`
      <!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Đăng ký thành công - GAERU</title>
      <body style="margin:0;padding:40px 16px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;">
        <main style="max-width:520px;margin:40px auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:24px;padding:44px 36px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,0.04);">
          <div style="font-size:28px;font-weight:700;letter-spacing:-0.03em;color:#1d1d1f;margin-bottom:20px;">GAERU</div>
          <div style="width:52px;height:52px;border-radius:50%;background:#e8f5e9;color:#2e7d32;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:24px;font-weight:700;">✓</div>
          <h1 style="font-size:22px;font-weight:600;color:#1d1d1f;margin:0 0 12px;">Đăng ký nhận tin thành công!</h1>
          <p style="font-size:15px;line-height:1.6;color:#515156;margin:0 0 28px;">Cảm ơn bạn đã xác nhận. Bạn sẽ luôn là người đầu tiên nhận được thông tin về sản phẩm và ưu đãi đặc quyền từ GAERU.</p>
          <div><a href="/" style="display:inline-block;padding:12px 32px;background:#0071e3;color:#ffffff;border-radius:980px;text-decoration:none;font-weight:600;font-size:15px;box-shadow:0 2px 8px rgba(0,113,227,0.25);">Khám phá sản phẩm GAERU</a></div>
        </main>
      </body></html>
    `);
  }));

  // Unsubscribe page
  publicApi.get('/unsubscribe/:token', wrap(async (req, res) => {
    const token = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.token);
    if (!(await pool.query('SELECT id FROM marketing_email_recipients WHERE unsubscribe_hash=$1', [hash(token)])).rows.length) {
      return res.status(404).send('Liên kết không hợp lệ.');
    }
    res.set('Cache-Control', 'no-store').type('html').send(`
      <!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Ngừng nhận email GAERU</title>
      <body style="margin:0;padding:40px 16px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;">
        <main style="max-width:520px;margin:40px auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:24px;padding:44px 36px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,0.04);">
          <div style="font-size:28px;font-weight:700;letter-spacing:-0.03em;color:#1d1d1f;margin-bottom:20px;">GAERU</div>
          <h1 style="font-size:22px;font-weight:600;color:#1d1d1f;margin:0 0 12px;">Ngừng nhận email khuyến mại</h1>
          <p style="font-size:15px;line-height:1.6;color:#515156;margin:0 0 28px;">Sau khi xác nhận, bạn sẽ không nhận email quảng cáo từ GAERU. Bạn vẫn nhận được các thư xác minh tài khoản, thông báo bảo mật và thông tin đơn hàng cần thiết khi mua sắm.</p>
          <form method="post"><button type="submit" style="padding:13px 32px;background:#1d1d1f;color:#ffffff;border:none;border-radius:980px;font-weight:600;font-size:15px;cursor:pointer;transition:background .2s ease;">Xác nhận ngừng nhận email</button></form>
        </main>
      </body></html>
    `);
  }));

  // RFC 8058 One-Click Unsubscribe POST
  publicApi.post('/unsubscribe/:token', wrap(async (req, res) => {
    const token = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.token);
    const tokenHash = hash(token);
    const ipHash = hash(req.ip || req.socket?.remoteAddress || '');
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 255);

    const rec = (await pool.query('SELECT email FROM marketing_email_recipients WHERE unsubscribe_hash = $1', [tokenHash])).rows[0];
    if (!rec) return res.status(404).send('Liên kết không hợp lệ.');

    const normEmail = rec.email.toLowerCase().trim();

    await withTransaction(pool, async c => {
      await c.query('INSERT INTO marketing_email_suppressions (email) VALUES ($1) ON CONFLICT DO NOTHING', [normEmail]);
      await c.query(`
        UPDATE marketing_email_subscriptions
        SET status = 'unsubscribed', unsubscribed_at = now(), updated_at = now()
        WHERE email = $1
      `, [normEmail]);
      await c.query(`
        INSERT INTO marketing_email_consent_events (email, event_type, source, ip_hash, user_agent)
        VALUES ($1, 'unsubscribed', 'one_click_unsubscribe', $2, $3)
      `, [normEmail, ipHash, userAgent]);
      await c.query(`
        UPDATE marketing_email_recipients
        SET status = 'skipped', result = 'Đã hủy nhận tin', finished_at = now()
        WHERE email = $1 AND status = 'pending'
      `, [normEmail]);
    });

    const listUnsubHeader = req.get('list-unsubscribe');
    const isRfc8058 = Boolean(
      (listUnsubHeader && listUnsubHeader.trim().toLowerCase() === 'one-click') ||
      req.body?.['List-Unsubscribe'] === 'One-Click' ||
      req.body?.['list-unsubscribe'] === 'One-Click'
    );
    if (isRfc8058 || !req.accepts('html')) {
      return res.status(200).type('text/plain').send('Unsubscribed');
    }

    res.set('Cache-Control', 'no-store').type('html').send(`
      <!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GAERU</title>
      <body style="margin:0;padding:40px 16px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;">
        <main style="max-width:520px;margin:40px auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:24px;padding:44px 36px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,0.04);">
          <div style="font-size:28px;font-weight:700;letter-spacing:-0.03em;color:#1d1d1f;margin-bottom:20px;">GAERU</div>
          <div style="width:52px;height:52px;border-radius:50%;background:#f5f5f7;color:#86868b;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:22px;">✓</div>
          <h1 style="font-size:22px;font-weight:600;color:#1d1d1f;margin:0 0 12px;">Đã ngừng nhận email khuyến mại</h1>
          <p style="font-size:15px;line-height:1.6;color:#515156;margin:0 0 28px;">Yêu cầu đã áp dụng cho các chiến dịch tiếp theo và thư chưa gửi. Bạn vẫn nhận được các thông báo đơn hàng và dịch vụ cần thiết khi mua sắm.</p>
          <div><a href="/" style="display:inline-block;padding:12px 32px;background:#0071e3;color:#ffffff;border-radius:980px;text-decoration:none;font-weight:600;font-size:15px;box-shadow:0 2px 8px rgba(0,113,227,0.25);">Về trang chủ GAERU</a></div>
        </main>
      </body></html>
    `);
  }));

  return { admin, publicApi };
}

async function processEmailQueue(pool, config, mailer) {
  if (!mailer || !config.smtp || !(config.PUBLIC_BASE_URL || config.smtp.publicBaseUrl)) return false;

  await pool.query("UPDATE marketing_email_recipients SET status='unknown',result='Tiến trình gián đoạn; không tự gửi lại',finished_at=now() WHERE status='sending' AND attempted_at<now()-interval '2 minutes'");

  // Check 24h daily limit to protect SMTP reputation
  const dailyLimit = Number(config.smtp?.dailyLimit || process.env.SMTP_DAILY_LIMIT) || 500;
  const sentTodayRes = await pool.query("SELECT count(*)::int AS count FROM marketing_email_recipients WHERE status = 'sent' AND finished_at >= now() - interval '24 hours'");
  const sentToday = sentTodayRes.rows[0]?.count || 0;
  if (sentToday >= dailyLimit) {
    console.warn(`[Marketing Email] Chạm hạn mức 24h (${sentToday}/${dailyLimit}). Hàng đợi tạm dừng.`);
    return false;
  }

  const claimed = await withTransaction(pool, async c => {
    await c.query("UPDATE marketing_email_campaigns c SET status='completed',updated_at=now() WHERE status IN ('scheduled','sending') AND NOT EXISTS(SELECT 1 FROM marketing_email_recipients r WHERE r.campaign_id=c.id AND r.status IN ('pending','sending'))");
    const campaign = (await c.query("SELECT * FROM marketing_email_campaigns WHERE status IN ('scheduled','sending') AND scheduled_at<=now() AND (next_send_at IS NULL OR next_send_at<=now()) ORDER BY scheduled_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
    if (!campaign) return null;
    const row = (await c.query("SELECT * FROM marketing_email_recipients WHERE campaign_id=$1 AND status='pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1", [campaign.id])).rows[0];
    if (!row) return null;
    const suppressed = (await c.query("SELECT 1 FROM marketing_email_suppressions WHERE lower(trim(email))=$1 UNION ALL SELECT 1 FROM customers WHERE lower(trim(email))=$1 AND (active=false OR deleted_at IS NOT NULL) LIMIT 1", [row.email])).rows.length;
    if (suppressed) {
      await c.query("UPDATE marketing_email_recipients SET status='skipped',result='Không còn nhận marketing',finished_at=now() WHERE id=$1", [row.id]);
      return null;
    }
    const token = randomBytes(32).toString('hex');
    await c.query("UPDATE marketing_email_recipients SET status='sending',attempted_at=now(),unsubscribe_hash=$2 WHERE id=$1", [row.id, hash(token)]);
    await c.query("UPDATE marketing_email_campaigns SET status='sending',next_send_at=now()+($2::text||' seconds')::interval,updated_at=now() WHERE id=$1", [campaign.id, 60 / campaign.rate_per_minute]);
    return { row, campaign, token };
  });

  if (!claimed) return false;
  const { row, campaign, token } = claimed;
  const url = new URL('/api/marketing-email/unsubscribe/' + token, normalizePublicBase(config.PUBLIC_BASE_URL || config.smtp.publicBaseUrl)).toString();

  try {
    const stillAllowed = (await pool.query("SELECT c.status,EXISTS(SELECT 1 FROM marketing_email_suppressions WHERE lower(trim(email))=$2) AS suppressed FROM marketing_email_campaigns c WHERE c.id=$1", [campaign.id, row.email])).rows[0];
    if (!stillAllowed || stillAllowed.status === 'cancelled' || stillAllowed.suppressed) {
      await pool.query("UPDATE marketing_email_recipients SET status='skipped',finished_at=now(),result='Đã dừng trước khi gửi' WHERE id=$1", [row.id]);
      return false;
    }

    const sent = await mailer.sendMail({
      from: config.smtp.from,
      to: row.email,
      subject: campaign.subject,
      text: campaign.body + '\n\nGAERU · Ngừng nhận email khuyến mại: ' + url,
      html: '<!doctype html><html lang="vi"><meta charset="utf-8"><body><main><h1>' + h(campaign.subject) + '</h1><div style="white-space:pre-wrap">' + h(campaign.body) + '</div><hr><p>GAERU · <a href="' + h(url) + '">Ngừng nhận email khuyến mại</a></p></main></body></html>',
      headers: {
        'List-Unsubscribe': '<' + url + '>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      }
    });

    const accepted = sent?.accepted?.some(e => String(e.address || e).toLowerCase() === row.email);
    await pool.query("UPDATE marketing_email_recipients SET status=$2,finished_at=now(),result=$3 WHERE id=$1 AND status='sending'", [
      row.id,
      accepted ? 'sent' : sent?.rejected?.length ? 'failed' : 'unknown',
      accepted ? 'SMTP đã tiếp nhận, chưa xác nhận vào hộp thư' : sent?.rejected?.length ? 'SMTP từ chối người nhận' : 'Chưa xác định kết quả SMTP'
    ]);
  } catch (e) {
    const code = Number(e.responseCode) || 0;
    let status = 'unknown';
    let result = 'Chưa xác định kết quả; không tự gửi lại';
    if (code >= 500 && code < 600) {
      status = 'failed';
      result = `Lỗi SMTP vĩnh viễn (Mã ${code}): ` + (e.message || 'Hộp thư từ chối');
    } else if (code >= 400 && code < 500) {
      status = 'failed';
      result = `Lỗi SMTP tạm thời (Mã ${code}): ` + (e.message || 'Hạn mức hoặc máy chủ bận');
    } else if (code > 0) {
      status = 'failed';
      result = `Lỗi SMTP (Mã ${code}): ` + (e.message || '');
    }
    await pool.query("UPDATE marketing_email_recipients SET status=$2,finished_at=now(),result=$3 WHERE id=$1 AND status='sending'", [
      row.id,
      status,
      result
    ]);
  }
  return true;
}

function startEmailWorker(pool, config, { mailer = makeMailer(config), intervalMs = 3000 } = {}) {
  let running = false;
  let stopped = false;
  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      for (let i = 0; i < 10 && !stopped; i++) {
        const handled = await processEmailQueue(pool, config, mailer);
        if (!handled) break;
      }
    } catch {
      console.error('Marketing email queue temporarily unavailable');
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

module.exports = {
  createEmailMarketing,
  startEmailWorker,
  processEmailQueue,
  audience,
  campaignSchema,
  subscribeSchema
};
