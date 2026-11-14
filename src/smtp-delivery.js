'use strict';

const { z } = require('zod');
const { withTransaction } = require('./db');

const emailSchema = z.string().trim().email().max(254);

const PRE_DELIVERY_COMMANDS = new Set([
  'CONN',
  'EHLO',
  'HELO',
  'STARTTLS',
  'AUTH',
  'MAIL FROM',
  'RCPT TO'
]);

const PRE_DELIVERY_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EDNS',
  'ETIMEDOUT',
  'ECONNRESET',
  'ESOCKET'
]);

/**
 * Phân loại trạng thái lỗi SMTP để vừa tự động thử lại khi lỗi tạm thời trước DATA,
 * vừa tuyệt đối không gửi trùng khi kết quả sau DATA không xác định.
 */
function failureStatus(error, attempts, maxAttempts = 3) {
  const code = Number(error?.responseCode);
  const rejected = Number.isInteger(code) && code >= 400 && code < 600;
  const beforeData =
    !error?.responseCode &&
    error?.command !== 'DATA' &&
    (PRE_DELIVERY_COMMANDS.has(error?.command) || PRE_DELIVERY_NETWORK_CODES.has(error?.code));
  const retryable = (rejected && code < 500) || beforeData;
  if (retryable && attempts < maxAttempts) return 'pending';
  return rejected || beforeData ? 'failed' : 'unknown';
}

/**
 * Thời gian chờ (giây) tăng dần giữa các lần thử lại: 1p -> 5p -> 15p -> 30p.
 */
function retryDelaySeconds(attempts) {
  const table = [60, 300, 900, 1800];
  const idx = Math.max(0, Math.min(table.length - 1, (Number(attempts) || 1) - 1));
  return table[idx];
}

/**
 * Địa chỉ Reply-To mặc định cho mọi email gửi ra để phản hồi của khách đi thẳng về mail tên miền.
 */
function resolveReplyTo(config) {
  const candidate = config?.smtp?.replyTo || config?.SMTP_REPLY_TO || 'business@gaeru.com';
  const parsed = emailSchema.safeParse(candidate);
  return parsed.success ? parsed.data.toLowerCase() : 'business@gaeru.com';
}

/**
 * Tên và địa chỉ người gửi chuẩn GAERU để Gmail và ứng dụng email luôn hiển thị tên "GAERU".
 */
function resolveFrom(config) {
  const candidate =
    config?.smtp?.from ||
    config?.SMTP_FROM ||
    (typeof config?.from === 'string' ? config.from : undefined) ||
    'business@gaeru.com';
  const str = String(candidate).trim();
  const match = str.match(/<([^>]+)>/);
  const emailCandidate = match ? match[1].trim() : str;
  const parsed = emailSchema.safeParse(emailCandidate);
  const addr = parsed.success ? parsed.data.toLowerCase() : 'business@gaeru.com';
  return `GAERU <${addr}>`;
}

/**
 * Tập hợp danh sách email quản trị hợp lệ (không trùng lặp):
 * 1) Email owner đã xác minh trong account_security
 * 2) ADMIN_DOMAIN_EMAIL từ cấu hình môi trường (nếu được khai báo)
 */
async function adminNotificationRecipients(pool, config) {
  const list = [];
  const seen = new Set();
  const add = (value) => {
    const parsed = emailSchema.safeParse(value);
    if (!parsed.success) return;
    const addr = parsed.data.toLowerCase();
    if (!seen.has(addr)) {
      seen.add(addr);
      list.push(addr);
    }
  };

  if (pool && typeof pool.query === 'function') {
    try {
      const owner = (
        await pool.query(
          "SELECT email FROM account_security WHERE account_key='owner' AND contacts_verified_at IS NOT NULL"
        )
      ).rows[0];
      if (owner?.email) add(owner.email);
    } catch (_) {}
  }

  add(config?.adminDomainEmail || config?.smtp?.adminDomainEmail || config?.ADMIN_DOMAIN_EMAIL);
  return list;
}

/**
 * Gửi thông báo quản trị tới toàn bộ hộp thư nhận (ưu tiên mail chính ở `to` và đồng gửi `cc` nếu có thêm mail tên miền).
 */
async function sendAdminNotification(mailer, pool, config, { subject, text, html, messageId }) {
  const recipients = await adminNotificationRecipients(pool, config);
  if (!recipients.length) {
    return { sent: false, reason: 'no_recipients', recipients: [] };
  }

  const mail = {
    from: resolveFrom(config),
    to: recipients[0],
    ...(recipients.length > 1 ? { cc: recipients.slice(1) } : {}),
    replyTo: resolveReplyTo(config),
    subject,
    text,
    ...(html ? { html } : {}),
    ...(messageId ? { messageId } : {})
  };

  const result = await mailer.sendMail(mail);
  const acceptedSet = new Set(
    (Array.isArray(result?.accepted) ? result.accepted : []).map((x) =>
      String(x?.address || x || '').trim().toLowerCase()
    )
  );
  const accepted = recipients.some((addr) => acceptedSet.has(addr));
  return {
    sent: true,
    accepted,
    rejected: Boolean(result?.rejected?.length),
    recipients
  };
}

/**
 * Ghi nhận thông báo quản trị (CARE+ / Bảo hành ngoài) vào hàng đợi outbox bền vững trong cùng transaction.
 */
async function enqueueAdminDomainNotification(client, { eventType, entityId, dedupeKey, subject, bodyText }) {
  try {
    await client.query('SAVEPOINT gaeru_admin_notify_sp');
    await client.query(
      `INSERT INTO admin_domain_email_outbox(event_type, entity_id, dedupe_key, subject, body_text)
       VALUES($1, $2, $3, $4, $5)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [eventType, entityId, dedupeKey, String(subject).slice(0, 240), String(bodyText)]
    );
    await client.query('RELEASE SAVEPOINT gaeru_admin_notify_sp');
    setTimeout(() => { try { require('./care-api').nudgeCareEmailWorker?.(); } catch (_) {} }, 100).unref?.();
  } catch (_) {
    await client.query('ROLLBACK TO SAVEPOINT gaeru_admin_notify_sp').catch(() => {});
  }
}

/**
 * Xử lý hàng đợi thông báo CARE+ và Bảo hành ngoài gửi tới email tên miền / owner.
 */
async function processAdminDomainEmailOutbox(pool, config, mailer) {
  if (!pool || !mailer || !config?.smtp?.from) return false;
  try {
    await pool.query(
      "UPDATE admin_domain_email_outbox SET status='unknown',finished_at=now(),result='Tiến trình gián đoạn; kiểm tra trước khi gửi lại' WHERE status='sending' AND attempted_at<now()-interval '2 minutes'"
    );
  } catch (err) {
    if (err?.code === '42P01') return false;
    throw err;
  }

  const targets = await adminNotificationRecipients(pool, config);
  if (!targets.length) return false;

  const job = await withTransaction(pool, async (c) => {
    const row = (
      await c.query(
        "SELECT * FROM admin_domain_email_outbox WHERE status='pending' AND next_attempt_at<=now() ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1"
      )
    ).rows[0];
    if (!row) return null;
    if (row.attempts >= 5) {
      await c.query(
        "UPDATE admin_domain_email_outbox SET status='failed',finished_at=now(),result='Vượt quá 5 lần thử gửi' WHERE id=$1",
        [row.id]
      );
      return null;
    }
    await c.query(
      "UPDATE admin_domain_email_outbox SET status='sending',recipient=$2,attempts=attempts+1,attempted_at=now() WHERE id=$1",
      [row.id, targets.join(', ')]
    );
    return { ...row, attempts: row.attempts + 1 };
  });

  if (!job) return false;

  const base = require('./primary-domain').normalizePublicBase(
    config.PUBLIC_BASE_URL || config.smtp.publicBaseUrl || 'https://gaeru.com'
  );
  const adminAnchor = job.event_type === 'warranty_external_new' ? '/gaeru_ceo#warranty' : '/gaeru_ceo#care';
  const fullText = `${job.body_text}\n\nXem và xử lý tại trang quản trị:\n${base}${adminAnchor}`;

  try {
    const delivery = await sendAdminNotification(mailer, pool, config, {
      subject: job.subject,
      text: fullText,
      messageId: `<admin-domain-${job.id}@gaeru.com>`
    });
    await pool.query(
      "UPDATE admin_domain_email_outbox SET status=$2,finished_at=now(),result=$3 WHERE id=$1 AND status='sending'",
      [
        job.id,
        delivery.accepted ? 'sent' : delivery.rejected ? 'failed' : 'unknown',
        delivery.accepted ? 'SMTP đã tiếp nhận' : delivery.rejected ? 'SMTP từ chối người nhận' : 'Chưa xác định kết quả SMTP'
      ]
    );
  } catch (error) {
    const state = failureStatus(error, job.attempts, 5);
    const retry = state === 'pending';
    const delaySec = retryDelaySeconds(job.attempts);
    await pool.query(
      "UPDATE admin_domain_email_outbox SET status=$2,next_attempt_at=now()+($4::text||' seconds')::interval,finished_at=CASE WHEN $2='pending' THEN NULL ELSE now() END,result=$3 WHERE id=$1 AND status='sending'",
      [
        job.id,
        state,
        retry
          ? 'Chờ thử lại kết nối gửi thư'
          : state === 'failed'
            ? (error.message || 'Lỗi gửi email')
            : 'Chưa xác định kết quả SMTP; không tự gửi trùng',
        delaySec
      ]
    );
  }
  return true;
}

module.exports = {
  failureStatus,
  retryDelaySeconds,
  resolveReplyTo,
  resolveFrom,
  adminNotificationRecipients,
  sendAdminNotification,
  enqueueAdminDomainNotification,
  processAdminDomainEmailOutbox
};
