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
    nudgeEmailMarketingWorker();
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
    const { prepareOutboundMail, buildMessageId } = require('./smtp-delivery');
    await currentMailer.sendMail(prepareOutboundMail(
      config,
      {
        to: d.to,
        subject: testSubject,
        text: d.body + '\n\nGAERU · Thư thử nghiệm marketing (Liên kết ngừng nhận mẫu: ' + dummyUnsubUrl + ')',
        messageId: buildMessageId('mkt-test', config)
      },
      {
        heading: d.subject,
        badge: 'EMAIL THỬ NGHIỆM',
        badgeTone: 'amber',
        preheader: '[Xem trước] ' + d.subject,
        bodyHtml: '<div class="gaeru-text" style="font-size:15px;line-height:1.68;color:#333336;white-space:pre-wrap;">' + h(d.body) + '</div>',
        footerNote: 'Đây là email thử nghiệm xem trước chiến dịch từ trang quản trị GAERU.',
        unsubscribeUrl: dummyUnsubUrl,
        unsubscribeLabel: 'Ngừng nhận email khuyến mại (Mẫu xem trước)'
      }
    ));
    await appendAudit(pool, { actor: req.admin, action: 'marketing.email.test_send', entityType: 'marketing', metadata: { to: d.to, subject: testSubject } });
    res.json({ message: 'Đã gửi email thử nghiệm thành công tới ' + d.to });
  }));

  publicApi.use(require('express').urlencoded({ extended: false, limit: '32kb' }));
  publicApi.use(rateLimit({ ...require('./security-hardening').sharedStore(pool, config || {}, 'marketing-email-public'), windowMs: 900000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }));

  // Double Opt-In Subscribe
  publicApi.post('/subscribe', wrap(async (req, res) => {
    const { email, consent, source } = subscribeSchema.parse(req.body);
    const token = randomBytes(32).toString('hex');
    const tokenHash = hash(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const ipHash = hash(req.ip || req.socket?.remoteAddress || '');
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 255);

    const existing = (await pool.query('SELECT status FROM marketing_email_subscriptions WHERE email = $1', [email])).rows[0];
    const suppressed = (await pool.query('SELECT 1 FROM marketing_email_suppressions WHERE lower(trim(email)) = $1 LIMIT 1', [email])).rows.length > 0;
    if (existing && existing.status === 'subscribed' && !suppressed) {
      return res.json({ status: 'subscribed', message: 'Địa chỉ email này đã hoàn tất đăng ký nhận tin từ trước.' });
    }

    await withTransaction(pool, async c => {
      await c.query(`
        INSERT INTO marketing_email_subscriptions (
          email, status, consent_source, consent_version, consent_at,
          confirmation_token_hash, confirmation_expires_at, updated_at
        ) VALUES ($1, 'pending', $2, 'v2026.11', now(), $3, $4, now())
        ON CONFLICT (email) DO UPDATE SET
          status = CASE WHEN marketing_email_subscriptions.status = 'subscribed' AND NOT $5::boolean THEN 'subscribed' ELSE 'pending' END,
          consent_source = EXCLUDED.consent_source,
          consent_version = EXCLUDED.consent_version,
          consent_at = now(),
          confirmation_token_hash = EXCLUDED.confirmation_token_hash,
          confirmation_expires_at = EXCLUDED.confirmation_expires_at,
          updated_at = now()
      `, [email, source, tokenHash, expiresAt, suppressed]);

      await c.query(`
        INSERT INTO marketing_email_consent_events (email, event_type, source, ip_hash, user_agent)
        VALUES ($1, 'opt_in_requested', $2, $3, $4)
      `, [email, source, ipHash, userAgent]);
    });

    const currentMailer = mailer || makeMailer(config);
    if (currentMailer && config.smtp && (config.PUBLIC_BASE_URL || config.smtp?.publicBaseUrl)) {
      const confirmUrl = new URL('/api/marketing-email/confirm/' + token, normalizePublicBase(config.PUBLIC_BASE_URL || config.smtp.publicBaseUrl)).toString();
      try {
        const { prepareOutboundMail, buildMessageId } = require('./smtp-delivery');
        await currentMailer.sendMail(prepareOutboundMail(
          config,
          {
            to: email,
            subject: 'GAERU · Xác nhận đăng ký nhận tin',
            text: `Chào bạn,\n\nCảm ơn bạn đã quan tâm đến GAERU. Vui lòng bấm vào liên kết dưới đây để xác nhận đăng ký nhận thông tin về sản phẩm microphone, phụ kiện và ưu đãi:\n${confirmUrl}\n\nLiên kết có hiệu lực trong 24 giờ. Nếu bạn không yêu cầu đăng ký này, vui lòng bỏ qua email này.\n\nTrân trọng,\nĐội ngũ GAERU`,
            messageId: buildMessageId('mkt-optin', config)
          },
          {
            centeredLogo: true,
            heading: 'Xác nhận đăng ký nhận tin từ GAERU',
            badge: 'BẢN TIN GAERU',
            badgeTone: 'blue',
            preheader: 'Chỉ một bước để hoàn tất đăng ký nhận tin sản phẩm mới & ưu đãi GAERU.',
            leadText: 'Cảm ơn bạn đã quan tâm đến GAERU. Vui lòng bấm nút bên dưới để xác nhận đăng ký nhận thông tin về microphone, phụ kiện thu âm và các ưu đãi chọn lọc.',
            htmlBodyText: '',
            summaryRows: [
              { label: 'Email đăng ký', value: email },
              { label: 'Hiệu lực xác nhận', value: '24 giờ' }
            ],
            warningNote: 'Nếu bạn không yêu cầu đăng ký này, hãy bỏ qua email — GAERU sẽ không gửi thêm bản tin nào tới hộp thư của bạn.',
            actionUrl: confirmUrl,
            actionLabel: 'Xác nhận đăng ký nhận tin',
            showActionFallback: true
          }
        ));
      } catch (err) {
        console.error('Không gửi được email xác nhận Double Opt-In:', err.message);
      }
    }

    res.json({ status: 'pending', message: 'Vui lòng kiểm tra hộp thư để xác nhận đăng ký nhận tin.' });
  }));

  function renderPublicMarketingCard({ title, heading, message, iconType = 'info', actionHtml = '' }) {
    const iconMarkup = iconType === 'success'
      ? '<div class="mkt-icon is-success" aria-hidden="true">✓</div>'
      : (iconType === 'error'
        ? '<div class="mkt-icon is-error" aria-hidden="true">!</div>'
        : '<div class="mkt-icon is-info" aria-hidden="true">i</div>');
    return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#fbfbfd">
  <link rel="icon" type="image/webp" href="/assets/brand/gaeru-logo.webp">
  <link rel="apple-touch-icon" href="/assets/brand/gaeru-app-192.png">
  <title>${h(title)}</title>
  <style>
    body { margin: 0; padding: 40px 16px; min-height: 100vh; box-sizing: border-box; display: flex; align-items: center; justify-content: center; background: #f5f5f7; color: #1d1d1f; color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
    main.mkt-card { width: 100%; max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e5ea; border-radius: 24px; padding: 44px 36px; text-align: center; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.05); box-sizing: border-box; }
    .mkt-brand { font-size: 26px; font-weight: 700; letter-spacing: -0.03em; color: #1d1d1f; margin-bottom: 18px; }
    .mkt-icon { width: 52px; height: 52px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; font-size: 22px; font-weight: 700; }
    .mkt-icon.is-success { background: #e8f5e9; color: #2e7d32; }
    .mkt-icon.is-error { background: #fee2e2; color: #dc2626; }
    .mkt-icon.is-info { background: rgba(0, 113, 227, 0.1); color: #0060c7; }
    h1 { font-size: 22px; line-height: 1.28; font-weight: 600; color: #1d1d1f; margin: 0 0 12px; }
    p { font-size: 15px; line-height: 1.62; color: #515154; margin: 0 0 28px; }
    .mkt-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 11px 30px; background: #0071e3; color: #ffffff; border: none; border-radius: 980px; text-decoration: none; font-weight: 600; font-size: 15px; cursor: pointer; box-shadow: 0 2px 8px rgba(0, 113, 227, 0.22); box-sizing: border-box; }
    .mkt-btn.is-dark { background: #1d1d1f; box-shadow: none; }
    @media (max-width: 520px) {
      body { padding: 20px 12px; }
      main.mkt-card { padding: 30px 20px; border-radius: 20px; }
      h1 { font-size: 20px; }
      .mkt-btn { width: 100%; padding: 12px 20px; }
    }
  </style>
</head>
<body>
  <main class="mkt-card">
    <div class="mkt-brand">GAERU</div>
    ${iconMarkup}
    <h1>${h(heading)}</h1>
    <p>${h(message)}</p>
    ${actionHtml}
  </main>
</body>
</html>`;
  }

  // Confirm Double Opt-In Link
  publicApi.get('/confirm/:token', wrap(async (req, res) => {
    const rawToken = String(req.params.token || '').trim();
    if (!/^[a-f0-9]{64}$/.test(rawToken)) {
      return res.status(400).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
        renderPublicMarketingCard({
          title: 'Xác nhận đăng ký — GAERU',
          heading: 'Liên kết không hợp lệ hoặc đã hết hạn',
          message: 'Liên kết xác nhận chỉ sử dụng một lần và có hiệu lực trong 24 giờ. Vui lòng đăng ký lại trên website GAERU.',
          iconType: 'error',
          actionHtml: '<div><a class="mkt-btn" href="/">Về trang chủ GAERU</a></div>'
        })
      );
    }
    const token = rawToken;
    const tokenHash = hash(token);
    const ipHash = hash(req.ip || req.socket?.remoteAddress || '');
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 255);

    const row = (await pool.query(
      `SELECT email FROM marketing_email_subscriptions
       WHERE confirmation_token_hash = $1 AND confirmation_expires_at > now()`,
      [tokenHash]
    )).rows[0];

    if (!row) {
      return res.status(400).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
        renderPublicMarketingCard({
          title: 'Xác nhận đăng ký — GAERU',
          heading: 'Liên kết không hợp lệ hoặc đã hết hạn',
          message: 'Liên kết xác nhận chỉ sử dụng một lần và có hiệu lực trong 24 giờ. Vui lòng đăng ký lại trên website GAERU.',
          iconType: 'error',
          actionHtml: '<div><a class="mkt-btn" href="/">Về trang chủ GAERU</a></div>'
        })
      );
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

    res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
      renderPublicMarketingCard({
        title: 'Đăng ký thành công — GAERU',
        heading: 'Đăng ký nhận tin thành công!',
        message: 'Cảm ơn bạn đã xác nhận. Bạn sẽ luôn là người đầu tiên nhận được thông tin về sản phẩm và ưu đãi đặc quyền từ GAERU.',
        iconType: 'success',
        actionHtml: '<div><a class="mkt-btn" href="/">Khám phá sản phẩm GAERU</a></div>'
      })
    );
  }));

  // Unsubscribe page
  publicApi.get('/unsubscribe/:token', wrap(async (req, res) => {
    const rawToken = String(req.params.token || '').trim();
    if (rawToken === 'test-preview') {
      return res.status(200).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
        renderPublicMarketingCard({
          title: 'Xem trước ngừng nhận tin — GAERU',
          heading: 'Liên kết xem trước từ email thử nghiệm',
          message: 'Đây là mẫu trang ngừng nhận email khuyến mại dành cho quản trị viên xem trước. Trong email chiến dịch gửi thật, khách hàng sẽ xác nhận hủy đăng ký nhận tin ngay tại đây.',
          iconType: 'info',
          actionHtml: '<div><a class="mkt-btn" href="/">Về trang chủ GAERU</a></div>'
        })
      );
    }
    if (!/^[a-f0-9]{64}$/.test(rawToken)) {
      return res.status(400).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
        renderPublicMarketingCard({
          title: 'Liên kết không hợp lệ — GAERU',
          heading: 'Liên kết ngừng nhận tin không hợp lệ',
          message: 'Đường dẫn bạn truy cập không đúng định dạng hoặc đã thay đổi. Nếu cần hỗ trợ hủy nhận bản tin, vui lòng liên hệ business@gaeru.com.',
          iconType: 'error',
          actionHtml: '<div><a class="mkt-btn" href="/">Về trang chủ GAERU</a></div>'
        })
      );
    }
    const token = rawToken;
    if (!(await pool.query('SELECT id FROM marketing_email_recipients WHERE unsubscribe_hash=$1', [hash(token)])).rows.length) {
      return res.status(404).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
        renderPublicMarketingCard({
          title: 'Không tìm thấy liên kết — GAERU',
          heading: 'Liên kết ngừng nhận tin không tồn tại',
          message: 'Liên kết này không còn hiệu lực hoặc không khớp với chiến dịch đã gửi. Bạn vẫn có thể liên hệ business@gaeru.com nếu cần hỗ trợ.',
          iconType: 'error',
          actionHtml: '<div><a class="mkt-btn" href="/">Về trang chủ GAERU</a></div>'
        })
      );
    }
    res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
      renderPublicMarketingCard({
        title: 'Ngừng nhận email — GAERU',
        heading: 'Ngừng nhận email khuyến mại',
        message: 'Sau khi xác nhận, bạn sẽ không nhận email quảng cáo từ GAERU. Bạn vẫn nhận được các thư xác minh tài khoản, thông báo bảo mật và thông tin đơn hàng cần thiết khi mua sắm.',
        iconType: 'info',
        actionHtml: '<form method="post"><button type="submit" class="mkt-btn is-dark">Xác nhận ngừng nhận email</button></form>'
      })
    );
  }));

  // RFC 8058 One-Click Unsubscribe POST
  publicApi.post('/unsubscribe/:token', wrap(async (req, res) => {
    const listUnsubHeader = req.get('list-unsubscribe');
    const isRfc8058 = Boolean(
      (listUnsubHeader && listUnsubHeader.trim().toLowerCase() === 'one-click') ||
      req.body?.['List-Unsubscribe'] === 'One-Click' ||
      req.body?.['list-unsubscribe'] === 'One-Click'
    );
    const rawToken = String(req.params.token || '').trim();
    if (rawToken === 'test-preview') {
      if (isRfc8058 || !req.accepts('html')) {
        return res.status(200).type('text/plain').send('Unsubscribed');
      }
      return res.status(200).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
        renderPublicMarketingCard({
          title: 'Xem trước ngừng nhận tin — GAERU',
          heading: 'Đã kiểm tra mẫu ngừng nhận tin',
          message: 'Đây là liên kết mẫu từ email thử nghiệm nên không thay đổi danh sách nhận tin thực tế.',
          iconType: 'info',
          actionHtml: '<div><a class="mkt-btn" href="/">Về trang chủ GAERU</a></div>'
        })
      );
    }
    if (!/^[a-f0-9]{64}$/.test(rawToken)) {
      if (isRfc8058 || req.accepts(['html', 'json']) !== 'html') {
        return res.status(400).json({ error: 'Liên kết ngừng nhận tin không hợp lệ.' });
      }
      return res.status(400).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
        renderPublicMarketingCard({
          title: 'Liên kết không hợp lệ — GAERU',
          heading: 'Liên kết ngừng nhận tin không hợp lệ',
          message: 'Đường dẫn không đúng định dạng hoặc đã hết hiệu lực. Vui lòng liên hệ business@gaeru.com nếu cần hỗ trợ.',
          iconType: 'error',
          actionHtml: '<div><a class="mkt-btn" href="/">Về trang chủ GAERU</a></div>'
        })
      );
    }
    const token = rawToken;
    const tokenHash = hash(token);
    const ipHash = hash(req.ip || req.socket?.remoteAddress || '');
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 255);

    const rec = (await pool.query('SELECT email FROM marketing_email_recipients WHERE unsubscribe_hash = $1', [tokenHash])).rows[0];
    if (!rec) {
      if (isRfc8058 || req.accepts(['html', 'json']) !== 'html') {
        return res.status(404).send('Liên kết không hợp lệ.');
      }
      return res.status(404).set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
        renderPublicMarketingCard({
          title: 'Không tìm thấy liên kết — GAERU',
          heading: 'Liên kết ngừng nhận tin không tồn tại',
          message: 'Liên kết này không còn hiệu lực hoặc không khớp với chiến dịch đã gửi.',
          iconType: 'error',
          actionHtml: '<div><a class="mkt-btn" href="/">Về trang chủ GAERU</a></div>'
        })
      );
    }

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

    if (isRfc8058 || !req.accepts('html')) {
      return res.status(200).type('text/plain').send('Unsubscribed');
    }

    res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(
      renderPublicMarketingCard({
        title: 'Đã ngừng nhận email — GAERU',
        heading: 'Đã ngừng nhận email khuyến mại',
        message: 'Yêu cầu đã áp dụng cho các chiến dịch tiếp theo và thư chưa gửi. Bạn vẫn nhận được các thông báo đơn hàng và dịch vụ cần thiết khi mua sắm.',
        iconType: 'success',
        actionHtml: '<div><a class="mkt-btn" href="/">Về trang chủ GAERU</a></div>'
      })
    );
  }));

  return { admin, publicApi };
}

const { registerWorkerNudge, triggerWorkerNudge } = require('./lib/worker-nudge');
const EMAIL_MARKETING_DEFAULT_INTERVAL_MS = () => (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) ? 3000 : 30000;

function nudgeEmailMarketingWorker() {
  triggerWorkerNudge('email_marketing');
}

async function processEmailQueue(pool, config, mailer) {
  if (!mailer || !config.smtp || !(config.PUBLIC_BASE_URL || config.smtp.publicBaseUrl)) return false;

  // Fast single-query idle guard: avoids 4 table scans/updates every tick when no campaigns are active
  const activeCheck = (await pool.query(
    "SELECT (EXISTS(SELECT 1 FROM marketing_email_campaigns WHERE status IN ('scheduled','sending')) OR EXISTS(SELECT 1 FROM marketing_email_recipients WHERE status='sending')) AS has_work"
  )).rows[0];
  if (!activeCheck?.has_work) return false;

  await pool.query("UPDATE marketing_email_recipients SET status='unknown',result='Tiến trình gián đoạn; không tự gửi lại',finished_at=now() WHERE status='sending' AND attempted_at<now()-interval '2 minutes'");

  // Check 24h daily limit to protect SMTP reputation
  const dailyLimit = Number(config.smtp?.dailyLimit || process.env.SMTP_DAILY_LIMIT) || 500;
  const sentTodayRes = await pool.query("SELECT count(*)::int AS count FROM marketing_email_recipients WHERE status = 'sent' AND finished_at >= now() - interval '24 hours'");
  const sentToday = sentTodayRes.rows[0]?.count || 0;
  if (sentToday >= dailyLimit) {
    console.warn(`[Marketing Email] Chạm hạn mức 24h (${sentToday}/${dailyLimit}). Hàng đợi tạm dừng.`);
    return false;
  }

  let processed = false;
  for (let pass = 0; pass < 50; pass++) {
    const claimed = await withTransaction(pool, async c => {
      await c.query("UPDATE marketing_email_campaigns c SET status='completed',updated_at=now() WHERE status IN ('scheduled','sending') AND NOT EXISTS(SELECT 1 FROM marketing_email_recipients r WHERE r.campaign_id=c.id AND r.status IN ('pending','sending'))");
      const campaign = (await c.query("SELECT * FROM marketing_email_campaigns WHERE status IN ('scheduled','sending') AND scheduled_at<=now() AND (next_send_at IS NULL OR next_send_at<=now()) ORDER BY scheduled_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
      if (!campaign) return null;
      const row = (await c.query("SELECT * FROM marketing_email_recipients WHERE campaign_id=$1 AND status='pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1", [campaign.id])).rows[0];
      if (!row) return null;
      const suppressed = (await c.query("SELECT 1 FROM marketing_email_suppressions WHERE lower(trim(email))=$1 UNION ALL SELECT 1 FROM customers WHERE lower(trim(email))=$1 AND (active=false OR deleted_at IS NOT NULL) LIMIT 1", [row.email])).rows.length;
      if (suppressed) {
        await c.query("UPDATE marketing_email_recipients SET status='skipped',result='Không còn nhận marketing',finished_at=now() WHERE id=$1", [row.id]);
        return { skipped: true };
      }
      const token = randomBytes(32).toString('hex');
      await c.query("UPDATE marketing_email_recipients SET status='sending',attempted_at=now(),unsubscribe_hash=$2 WHERE id=$1", [row.id, hash(token)]);
      await c.query("UPDATE marketing_email_campaigns SET status='sending',next_send_at=now()+($2::text||' seconds')::interval,updated_at=now() WHERE id=$1", [campaign.id, 60 / campaign.rate_per_minute]);
      return { row, campaign, token };
    });

    if (!claimed) return processed;
    if (claimed.skipped) continue;
    const { row, campaign, token } = claimed;
    const url = new URL('/api/marketing-email/unsubscribe/' + token, normalizePublicBase(config.PUBLIC_BASE_URL || config.smtp.publicBaseUrl)).toString();

    try {
      const stillAllowed = (await pool.query("SELECT c.status,(EXISTS(SELECT 1 FROM marketing_email_suppressions WHERE lower(trim(email))=$2) OR EXISTS(SELECT 1 FROM customers WHERE lower(trim(email))=$2 AND (active=false OR deleted_at IS NOT NULL))) AS suppressed FROM marketing_email_campaigns c WHERE c.id=$1", [campaign.id, row.email])).rows[0];
      if (!stillAllowed || stillAllowed.status === 'cancelled' || stillAllowed.suppressed) {
        await pool.query("UPDATE marketing_email_recipients SET status='skipped',finished_at=now(),result='Đã dừng trước khi gửi' WHERE id=$1", [row.id]);
        continue;
      }

      const { prepareOutboundMail, buildMessageId } = require('./smtp-delivery');
      const sent = await mailer.sendMail(prepareOutboundMail(
        config,
        {
          to: row.email,
          subject: campaign.subject,
          text: campaign.body + '\n\nGAERU · Ngừng nhận email khuyến mại: ' + url,
          messageId: buildMessageId('mkt-campaign', config),
        headers: {
          'List-Unsubscribe': '<' + url + '>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      },
      {
        heading: campaign.subject,
        badge: 'BẢN TIN GAERU',
        badgeTone: 'blue',
        preheader: String(campaign.body || '').replace(/\s+/g, ' ').trim().slice(0, 140),
        bodyHtml: '<div class="gaeru-text" style="font-size:15px;line-height:1.68;color:#333336;white-space:pre-wrap;">' + h(campaign.body) + '</div>',
        footerNote: 'Bạn nhận được email này do đã đăng ký nhận tin sản phẩm & ưu đãi từ GAERU.',
        unsubscribeUrl: url,
        unsubscribeLabel: 'Ngừng nhận email khuyến mại'
      }
    ));

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
    processed = true;
  }
  return processed;
}

function startEmailWorker(pool, config, { mailer = makeMailer(config), intervalMs = EMAIL_MARKETING_DEFAULT_INTERVAL_MS() } = {}) {
  let running = false;
  let stopped = false;
  let activeFollowupTimer = null;
  async function run() {
    if (running || stopped) return;
    running = true;
    let processedAny = false;
    try {
      for (let i = 0; i < 10 && !stopped; i++) {
        const handled = await processEmailQueue(pool, config, mailer);
        if (!handled) break;
        processedAny = true;
      }
    } catch {
      console.error('Marketing email queue temporarily unavailable');
    } finally {
      running = false;
      // When a campaign is actively dispatching, keep cadence responsive (3s) even if idle poll is 30s
      if (processedAny && !stopped && intervalMs > 3000) {
        if (activeFollowupTimer) clearTimeout(activeFollowupTimer);
        activeFollowupTimer = setTimeout(() => {
          activeFollowupTimer = null;
          void run();
        }, 3000);
        activeFollowupTimer.unref?.();
      }
    }
  }
  const unregister = registerWorkerNudge('email_marketing', run);
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
  return () => {
    stopped = true;
    unregister();
    if (activeFollowupTimer) {
      clearTimeout(activeFollowupTimer);
      activeFollowupTimer = null;
    }
    clearInterval(timer);
  };
}

module.exports = {
  createEmailMarketing,
  startEmailWorker,
  nudgeEmailMarketingWorker,
  processEmailQueue,
  audience,
  campaignSchema,
  subscribeSchema
};
