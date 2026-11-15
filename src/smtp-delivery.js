'use strict';

const { randomUUID } = require('node:crypto');
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
    'noreply@gaeru.com';
  const str = String(candidate).trim();
  const match = str.match(/<([^>]+)>/);
  const emailCandidate = match ? match[1].trim() : str;
  const parsed = emailSchema.safeParse(emailCandidate);
  const addr = parsed.success ? parsed.data.toLowerCase() : 'noreply@gaeru.com';
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

function escapeMailHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function resolveMailDomain(config) {
  const fromStr = resolveFrom(config);
  const match = fromStr.match(/@([^>\s]+)>?$/);
  const domain = match ? match[1].trim().toLowerCase() : '';
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : 'gaeru.com';
}

function buildMessageId(prefix, config) {
  const cleanPrefix = String(prefix || 'gaeru').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'gaeru';
  return `<${cleanPrefix}-${randomUUID()}@${resolveMailDomain(config)}>`;
}

function resolvePublicOrigin(config) {
  const candidate = config?.PUBLIC_BASE_URL || config?.smtp?.publicBaseUrl || 'https://gaeru.com';
  try {
    return new URL(require('./primary-domain').normalizePublicBase(candidate)).origin;
  } catch {
    return 'https://gaeru.com';
  }
}

function resolveEmailLogoUrl(config) {
  return `${resolvePublicOrigin(config)}/assets/brand/gaeru-email-logo.png`;
}

function safeMailHref(candidate) {
  if (!candidate) return '';
  try {
    const safeHref = new URL(String(candidate)).toString();
    return safeHref.startsWith('https://') || safeHref.startsWith('http://') ? safeHref : '';
  } catch {
    return '';
  }
}

function renderGaeruEmailLogoHtml(config, { centered = false, inline = false } = {}) {
  const origin = resolvePublicOrigin(config);
  const logoUrl = `${origin}/assets/brand/gaeru-email-logo.png`;
  const wrapStyle = inline
    ? 'margin:0;text-align:left;'
    : centered
      ? 'margin:0 auto 18px;text-align:center;'
      : 'margin:0 0 18px;text-align:left;';
  return `<div style="${wrapStyle}"><a href="${escapeMailHtml(origin + '/')}" style="display:inline-block;text-decoration:none;background:#ffffff;border-radius:10px;padding:3px 5px;" target="_blank" rel="noopener"><img src="${escapeMailHtml(logoUrl)}" alt="GAERU" width="130" height="44" style="display:block;width:130px;height:44px;border:0;outline:none;text-decoration:none;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:20px;font-weight:800;letter-spacing:0.06em;color:#1d1d1f;"></a></div>`;
}

function resolveBadgePalette(tone) {
  switch (tone) {
    case 'blue':
      return 'background:#eef5fd;border:1px solid #d2e4fa;color:#0066cc;';
    case 'green':
      return 'background:#eaf7ef;border:1px solid #ccebd7;color:#1b7339;';
    case 'amber':
      return 'background:#fef6e6;border:1px solid #f7dfad;color:#945600;';
    case 'red':
      return 'background:#fdeeee;border:1px solid #f7d0d0;color:#b42318;';
    default:
      return 'background:#f5f5f7;border:1px solid #e5e5ea;color:#1d1d1f;';
  }
}

function renderEmailParagraphs(text) {
  return String(text || '')
    .split(/\r?\n\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p class="gaeru-text" style="margin:0 0 14px;font-size:15px;line-height:1.68;color:#333336;">${escapeMailHtml(p).replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}

function renderOtpCard(otpCode, otpNote) {
  if (!otpCode) return '';
  const safeCode = escapeMailHtml(String(otpCode).trim());
  const noteHtml = otpNote
    ? `<p class="gaeru-muted" style="margin:10px 0 0;font-size:12px;line-height:1.5;color:#6e6e73;">${escapeMailHtml(otpNote)}</p>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 22px;border-collapse:separate;"><tr><td class="gaeru-subpanel" align="center" style="background:#f5f5f7;border:1px solid #d2d2d7;border-radius:14px;padding:22px 18px;"><div class="gaeru-muted" style="font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:#6e6e73;margin:0 0 8px;">Mã xác thực một lần</div><div class="gaeru-heading" style="font-family:'SF Mono',SFMono-Regular,Menlo,Monaco,Consolas,'Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:8px;padding-left:8px;line-height:1.25;color:#1d1d1f;">${safeCode}</div>${noteHtml}</td></tr></table>`;
}

function renderLineItemsTable(lineItems) {
  if (!Array.isArray(lineItems) || !lineItems.length) return '';
  const rowsHtml = lineItems.map((item, idx) => {
    const borderCss = idx < lineItems.length - 1 ? 'border-bottom:1px solid #ececef;' : '';
    const title = escapeMailHtml(item?.title || '');
    const meta = item?.meta ? `<div class="gaeru-muted" style="font-size:12.5px;line-height:1.45;color:#6e6e73;margin-top:3px;">${escapeMailHtml(item.meta)}</div>` : '';
    const price = escapeMailHtml(item?.price || '');
    return `<tr><td class="gaeru-row-border" style="padding:13px 12px 13px 0;vertical-align:top;${borderCss}"><div class="gaeru-heading" style="font-size:14px;font-weight:600;line-height:1.45;color:#1d1d1f;">${title}</div>${meta}</td><td class="gaeru-row-border gaeru-heading" align="right" style="padding:13px 0 13px 12px;vertical-align:top;white-space:nowrap;font-size:14px;font-weight:600;line-height:1.45;color:#1d1d1f;font-variant-numeric:tabular-nums;${borderCss}">${price}</td></tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 14px;border-collapse:separate;"><tr><td class="gaeru-subpanel" style="background:#fafafc;border:1px solid #e5e5ea;border-radius:14px;padding:4px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rowsHtml}</table></td></tr></table>`;
}

function renderSummaryRowsTable(summaryRows) {
  if (!Array.isArray(summaryRows) || !summaryRows.length) return '';
  const cleanRows = summaryRows.filter((r) => r && r.label && r.value !== undefined && r.value !== null && String(r.value).trim() !== '');
  if (!cleanRows.length) return '';
  const rowsHtml = cleanRows.map((row, idx) => {
    const borderCss = idx < cleanRows.length - 1 ? 'border-bottom:1px solid #ececef;' : '';
    const isEmphasis = Boolean(row.emphasis);
    const valColor = row.accent ? '#0071e3' : '#1d1d1f';
    const valClass = row.accent ? 'gaeru-accent' : 'gaeru-heading';
    const valSize = isEmphasis ? '15.5px' : '13.5px';
    const valWeight = isEmphasis ? '700' : '600';
    return `<tr><td class="gaeru-row-border gaeru-muted" style="padding:10px 12px 10px 0;vertical-align:top;font-size:13px;line-height:1.45;color:#6e6e73;${borderCss}">${escapeMailHtml(row.label)}</td><td class="gaeru-row-border ${valClass}" align="right" style="padding:10px 0 10px 12px;vertical-align:top;font-size:${valSize};font-weight:${valWeight};line-height:1.45;color:${valColor};font-variant-numeric:tabular-nums;${borderCss}">${escapeMailHtml(row.value)}</td></tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 20px;border-collapse:separate;"><tr><td class="gaeru-subpanel" style="background:#f9f9fb;border:1px solid #e5e5ea;border-radius:14px;padding:6px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rowsHtml}</table></td></tr></table>`;
}

function renderHighlightBox(highlightTitle, highlightText) {
  if (!highlightText) return '';
  const titleHtml = highlightTitle
    ? `<div class="gaeru-accent" style="font-size:11px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:#0066cc;margin:0 0 6px;">${escapeMailHtml(highlightTitle)}</div>`
    : '';
  const bodyHtml = escapeMailHtml(String(highlightText).trim()).replace(/\r?\n/g, '<br>');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 20px;border-collapse:separate;"><tr><td class="gaeru-callout" style="background:#f5f8fd;border:1px solid #dce8f8;border-left:4px solid #0071e3;border-radius:10px;padding:15px 18px;">${titleHtml}<div class="gaeru-text" style="font-size:14px;line-height:1.65;color:#1d1d1f;">${bodyHtml}</div></td></tr></table>`;
}

function renderActionSection({ actionUrl, actionLabel, centered = false, showActionFallback = false }) {
  const safeHref = safeMailHref(actionUrl);
  if (!safeHref) return '';
  const align = centered ? 'center' : 'left';
  const btn = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ${centered ? 'align="center" ' : ''}style="margin:24px ${centered ? 'auto' : '0'} 8px;"><tr><td align="center" bgcolor="#0071e3" style="background:#0071e3;border-radius:980px;"><a href="${escapeMailHtml(safeHref)}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:980px;">${escapeMailHtml(actionLabel || 'Xem chi tiết')}</a></td></tr></table>`;
  const shouldShowFallback = showActionFallback || safeHref.includes('?') || safeHref.includes('recovery_token') || safeHref.includes('confirm');
  const fallback = shouldShowFallback
    ? `<p class="gaeru-muted" style="margin:10px 0 0;font-size:11.5px;line-height:1.55;color:#86868b;text-align:${align};word-break:break-all;">Nếu nút bấm không hoạt động, hãy sao chép liên kết sau vào trình duyệt:<br><a href="${escapeMailHtml(safeHref)}" class="gaeru-accent" style="color:#0071e3;text-decoration:underline;">${escapeMailHtml(safeHref)}</a></p>`
    : '';
  return `<div style="text-align:${align};">${btn}${fallback}</div>`;
}

function renderGaeruEmailHtml({
  heading,
  bodyText,
  htmlBodyText,
  bodyHtml,
  preheader,
  badge,
  badgeTone,
  leadText,
  otpCode,
  otpNote,
  lineItems,
  summaryRows,
  highlightTitle,
  highlightText,
  warningNote,
  actionUrl,
  actionLabel,
  showActionFallback,
  centeredLogo = false,
  footerNote,
  unsubscribeUrl,
  unsubscribeLabel,
  config
} = {}) {
  const origin = resolvePublicOrigin(config);
  const safeHeading = escapeMailHtml(heading || 'Thông báo từ GAERU');
  const rawPreview = preheader || leadText || String(htmlBodyText || bodyText || '').replace(/\s+/g, ' ').trim();
  const cleanPreview = String(rawPreview || heading || 'Thông báo chính thức từ GAERU').trim().slice(0, 140);
  const preheaderHtml = cleanPreview
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f5f5f7;opacity:0;">${escapeMailHtml(cleanPreview)}${'&nbsp;&zwnj;'.repeat(28)}</div>`
    : '';

  const badgeHtml = badge
    ? `<span style="display:inline-block;padding:5px 11px;border-radius:980px;font-size:10.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;line-height:1.2;${resolveBadgePalette(badgeTone)}">${escapeMailHtml(badge)}</span>`
    : '';

  const headerHtml = centeredLogo
    ? `<tr><td class="gaeru-card-header gaeru-mobile-pad" align="center" style="padding:28px 32px 20px;border-bottom:1px solid #f0f0f2;">${renderGaeruEmailLogoHtml(config, { centered: true, inline: false })}${badgeHtml ? `<div style="margin-top:2px;">${badgeHtml}</div>` : ''}</td></tr>`
    : `<tr><td class="gaeru-card-header gaeru-mobile-pad" style="padding:26px 32px 18px;border-bottom:1px solid #f0f0f2;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="left" valign="middle">${renderGaeruEmailLogoHtml(config, { inline: true })}</td>${badgeHtml ? `<td align="right" valign="middle" style="padding-left:12px;white-space:nowrap;">${badgeHtml}</td>` : ''}</tr></table></td></tr>`;

  const leadHtml = leadText
    ? `<p class="gaeru-lead" style="margin:0 0 18px;font-size:15px;line-height:1.62;color:#515154;">${escapeMailHtml(leadText)}</p>`
    : '';
  const bodyContentHtml = bodyHtml || renderEmailParagraphs(htmlBodyText !== undefined ? htmlBodyText : bodyText);
  const otpHtml = renderOtpCard(otpCode, otpNote);
  const itemsHtml = renderLineItemsTable(lineItems);
  const summaryHtml = renderSummaryRowsTable(summaryRows);
  const highlightHtml = renderHighlightBox(highlightTitle, highlightText);
  const ctaHtml = renderActionSection({
    actionUrl,
    actionLabel,
    centered: centeredLogo,
    showActionFallback: Boolean(showActionFallback)
  });

  const warningHtml = warningNote
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0;border-collapse:separate;"><tr><td class="gaeru-subpanel gaeru-muted" style="background:#fafafa;border:1px solid #e5e5ea;border-radius:12px;padding:12px 16px;font-size:12.5px;line-height:1.6;color:#515154;">${escapeMailHtml(warningNote)}</td></tr></table>`
    : '';

  const safeUnsubHref = safeMailHref(unsubscribeUrl);
  const customFooterHtml = footerNote
    ? `<p class="gaeru-muted" style="margin:0 0 10px;font-size:12px;line-height:1.55;color:#6e6e73;">${escapeMailHtml(footerNote)}</p>`
    : '';
  const unsubHtml = safeUnsubHref
    ? ` &middot; <a href="${escapeMailHtml(safeUnsubHref)}" class="gaeru-muted" style="color:#6e6e73;text-decoration:underline;">${escapeMailHtml(unsubscribeLabel || 'Ngừng nhận thông báo')}</a>`
    : '';

  const footerBlockHtml = `<tr><td class="gaeru-footer gaeru-mobile-pad" style="background:#fafafc;border-top:1px solid #ececef;padding:20px 32px;"><p class="gaeru-heading" style="margin:0 0 4px;font-size:12.5px;font-weight:600;line-height:1.5;color:#1d1d1f;">GAERU <span class="gaeru-muted" style="font-weight:400;color:#6e6e73;">&middot; Nhỏ gọn để bắt đầu. Tự do để sáng tạo.</span></p>${customFooterHtml}<p class="gaeru-muted" style="margin:0 0 6px;font-size:12px;line-height:1.55;color:#6e6e73;">Hotline: <a href="tel:0829191080" style="color:#6e6e73;text-decoration:none;">082 919 1080</a> &middot; Email: <a href="mailto:business@gaeru.com" style="color:#6e6e73;text-decoration:none;">business@gaeru.com</a><br>Thứ Hai–Thứ Sáu 10:00–17:00, cuối tuần và ngày lễ 10:00–16:00</p><p class="gaeru-muted" style="margin:0;font-size:11.5px;line-height:1.5;color:#86868b;"><a href="${escapeMailHtml(origin + '/')}" style="color:#6e6e73;text-decoration:underline;">gaeru.com</a> &middot; <a href="${escapeMailHtml(origin + '/care')}" style="color:#6e6e73;text-decoration:underline;">GAERU CARE+</a>${unsubHtml}</p></td></tr>`;

  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${safeHeading}</title><style>@media only screen and (max-width:600px){.gaeru-outer{padding:16px 8px 28px !important;}.gaeru-mobile-pad{padding-left:20px !important;padding-right:20px !important;}.gaeru-title{font-size:20px !important;}}@media (prefers-color-scheme:dark){body,.gaeru-bg{background-color:#0d0d10 !important;}.gaeru-card{background-color:#1c1c1e !important;border-color:#2c2c2e !important;}.gaeru-card-header,.gaeru-footer,.gaeru-row-border{border-color:#2c2c2e !important;}.gaeru-footer{background-color:#161618 !important;}.gaeru-subpanel{background-color:#252528 !important;border-color:#3a3a3c !important;}.gaeru-callout{background-color:#162233 !important;border-color:#243b59 !important;border-left-color:#2997ff !important;}.gaeru-heading{color:#f5f5f7 !important;}.gaeru-lead,.gaeru-text{color:#d1d1d6 !important;}.gaeru-muted{color:#a1a1a6 !important;}.gaeru-accent{color:#2997ff !important;}}</style></head><body class="gaeru-bg" style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;-webkit-font-smoothing:antialiased;">${preheaderHtml}<table role="presentation" class="gaeru-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f7;"><tr><td class="gaeru-outer" align="center" style="padding:32px 12px 36px;"><table role="presentation" class="gaeru-card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e5e5ea;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.035);"><tr><td style="height:3px;line-height:3px;font-size:1px;background:#1d1d1f;background-image:linear-gradient(90deg,#1d1d1f 0%,#0071e3 100%);">&nbsp;</td></tr>${headerHtml}<tr><td class="gaeru-mobile-pad" style="padding:28px 32px 30px;"><h1 class="gaeru-title gaeru-heading" style="margin:0 0 12px;font-size:22px;font-weight:700;letter-spacing:-0.02em;line-height:1.32;color:#1d1d1f;">${safeHeading}</h1>${leadHtml}${otpHtml}${bodyContentHtml || (!otpHtml && !itemsHtml && !summaryHtml && !highlightHtml ? '<p class="gaeru-text" style="margin:0 0 14px;font-size:15px;color:#333336;"></p>' : '')}${itemsHtml}${summaryHtml}${highlightHtml}${ctaHtml}${warningHtml}</td></tr>${footerBlockHtml}</table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;"><tr><td align="center" style="padding:14px 12px 0;font-size:11px;line-height:1.5;color:#86868b;">&copy; GAERU &middot; MST: 8836293843-002 &middot; Ninh Bình</td></tr></table></td></tr></table></body></html>`;
}

function prepareOutboundMail(config, mail, opts = {}) {
  const from = mail.from || resolveFrom(config);
  const replyTo = mail.replyTo || resolveReplyTo(config);
  const messageId = mail.messageId || buildMessageId(opts.messageIdPrefix || 'gaeru', config);
  const html = mail.html || renderGaeruEmailHtml({
    ...opts,
    heading: opts.heading || mail.subject,
    bodyText: mail.text,
    config
  });
  return {
    ...mail,
    from,
    replyTo,
    messageId,
    html
  };
}

/**
 * Gửi thông báo quản trị tới toàn bộ hộp thư nhận (ưu tiên mail chính ở `to` và đồng gửi `cc` nếu có thêm mail tên miền).
 */
async function sendAdminNotification(mailer, pool, config, {
  subject,
  text,
  html,
  htmlBodyText,
  messageId,
  actionUrl,
  actionLabel,
  badge,
  badgeTone,
  preheader,
  leadText,
  summaryRows,
  lineItems,
  highlightTitle,
  highlightText
}) {
  const recipients = await adminNotificationRecipients(pool, config);
  if (!recipients.length) {
    return { sent: false, reason: 'no_recipients', recipients: [] };
  }

  const mail = prepareOutboundMail(
    config,
    {
      to: recipients[0],
      ...(recipients.length > 1 ? { cc: recipients.slice(1) } : {}),
      subject,
      text,
      ...(html ? { html } : {}),
      ...(messageId ? { messageId } : {})
    },
    {
      messageIdPrefix: 'admin',
      heading: subject,
      badge: badge || 'VẬN HÀNH QUẢN TRỊ',
      badgeTone: badgeTone || 'neutral',
      preheader,
      leadText,
      htmlBodyText,
      summaryRows,
      lineItems,
      highlightTitle,
      highlightText,
      actionUrl,
      actionLabel
    }
  );

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
  const isExternalWarranty = job.event_type === 'warranty_external_new';
  const adminAnchor = isExternalWarranty ? '/gaeru_ceo#warranty' : '/gaeru_ceo#care';
  const fullText = `${job.body_text}\n\nXem và xử lý tại trang quản trị:\n${base}${adminAnchor}`;

  try {
    const delivery = await sendAdminNotification(mailer, pool, config, {
      subject: job.subject,
      text: fullText,
      htmlBodyText: job.body_text,
      badge: isExternalWarranty ? 'BẢO HÀNH NGOÀI HỆ THỐNG' : 'GAERU CARE+',
      badgeTone: isExternalWarranty ? 'amber' : 'blue',
      preheader: `${job.subject} — Xem và xử lý tại trang quản trị GAERU.`,
      actionUrl: `${base}${adminAnchor}`,
      actionLabel: 'Mở trang quản trị GAERU',
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
  resolveMailDomain,
  resolvePublicOrigin,
  resolveEmailLogoUrl,
  renderGaeruEmailLogoHtml,
  buildMessageId,
  renderGaeruEmailHtml,
  prepareOutboundMail,
  adminNotificationRecipients,
  sendAdminNotification,
  enqueueAdminDomainNotification,
  processAdminDomainEmailOutbox
};
