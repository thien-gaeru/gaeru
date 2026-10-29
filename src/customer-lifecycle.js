const { withTransaction } = require('./db');
const { appendAudit } = require('./audit');

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  'tempmail.com',
  '10minutemail.com',
  'guerrillamail.com',
  'guerrillamailblock.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamail.biz',
  'trashmail.com',
  'trashmail.net',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'throwawaymail.com',
  'sharklasers.com',
  'getairmail.com',
  'dispostable.com',
  'fakeinbox.com',
  'temp-mail.org',
  'bupmail.com',
  'dropmail.me',
  'mohmal.com',
  'nada.ltd',
  'getnada.com',
  'emailondeck.com',
  'crazymailing.com',
  'tmailor.com',
  'tmail.com',
  'tmpmail.org',
  'generator.email',
  'inboxkitten.com',
  'mytemp.email',
  'spambox.us',
  'burnermail.io',
  'fakemailgenerator.com',
  'emailfake.com',
  'cool.fr.nf',
  'jetable.fr.nf',
  'courriel.fr.nf',
  'moncourrier.fr.nf',
  'monemail.fr.nf',
  'monmail.fr.nf',
  'disposablemail.com',
  'armyspy.com',
  'cuvox.de',
  'dayrep.com',
  'fleckens.hu',
  'gustr.com',
  'jourrapide.com',
  'rhyta.com',
  'superrito.com',
  'teleworm.us',
  'einrot.com',
  'trashmail.org',
  'crazymail.com',
  'fakemail.net',
  'maildrop.cc',
  'tempail.com',
  'disposable.com',
  'trashymail.com'
]);

function isDisposableEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const parts = email.trim().toLowerCase().split('@');
  if (parts.length !== 2) return true;
  const domain = parts[1];
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return true;
  if (/^(temp|trash|fake|dispos|guerrilla|throwaway|burner|spam)/i.test(domain)) return true;
  return false;
}

function isPermanentSendMailError(error) {
  if (!error) return false;
  const code = Number(error.responseCode);
  if ([550, 551, 552, 553, 554].includes(code)) return true;
  const msg = String(error.message || '').toLowerCase();
  const markers = [
    'address rejected',
    'user unknown',
    'mailbox unavailable',
    'recipient address rejected',
    'invalid recipient',
    'no mailbox',
    'domain not found',
    'no mx record',
    'enotfound',
    'recipient rejected'
  ];
  return markers.some(m => msg.includes(m));
}

function normalizeVietnamPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const clean = phone.replace(/[\s().\-+]/g, '');
  if (clean.startsWith('84') && clean.length === 11) {
    return '0' + clean.slice(2);
  }
  return clean;
}

function isValidVietnamMobile(phone) {
  const normalized = normalizeVietnamPhone(phone);
  if (!/^0(3[2-9]|5[25689]|7[06-9]|8[1-9]|9[0-9])\d{7}$/.test(normalized)) {
    return false;
  }
  if (/^(\d)\1{9}$/.test(normalized)) return false;
  if (normalized === '0123456789' || normalized === '9876543210') return false;
  return true;
}

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

function checkCustomerPhoneStatus(customer, now = new Date()) {
  const phone = typeof customer.phone === 'string' ? customer.phone.trim() : '';
  // Các tài khoản chưa nhập số điện thoại chỉ xử lý cảnh báo khi đã nhập số điện thoại và nhập sai
  if (!phone) {
    return {
      isValid: true,
      hasPhone: false,
      isWarning: false,
      isExpired: false,
      remainingMs: 0,
      remainingHours: 0,
      warningExpiresAt: null,
      warningMessage: ''
    };
  }

  const valid = isValidVietnamMobile(phone);
  if (valid) {
    return {
      isValid: true,
      hasPhone: true,
      isWarning: false,
      isExpired: false,
      remainingMs: 0,
      remainingHours: 0,
      warningExpiresAt: null,
      warningMessage: ''
    };
  }

  const invalidAtTime = customer.phone_invalid_at || customer.phoneInvalidAt
    ? new Date(customer.phone_invalid_at || customer.phoneInvalidAt).getTime()
    : (customer.created_at || customer.createdAt ? new Date(customer.created_at || customer.createdAt).getTime() : now.getTime());
  const expiresAtMs = invalidAtTime + TWELVE_HOURS_MS;
  const remainingMs = expiresAtMs - now.getTime();

  if (remainingMs <= 0) {
    return {
      isValid: false,
      hasPhone: true,
      isWarning: false,
      isExpired: true,
      remainingMs: 0,
      remainingHours: 0,
      warningExpiresAt: new Date(expiresAtMs).toISOString(),
      warningMessage: 'Số điện thoại không hợp lệ đã quá thời hạn 12 giờ.'
    };
  }

  const remainingHours = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));
  const expiresAtIso = new Date(expiresAtMs).toISOString();

  return {
    isValid: false,
    hasPhone: true,
    isWarning: true,
    isExpired: false,
    remainingMs,
    remainingHours,
    warningExpiresAt: expiresAtIso,
    warningMessage: `Số điện thoại không đúng định dạng di động Việt Nam. Vui lòng cập nhật trong vòng ${remainingHours} giờ.`
  };
}

function checkCustomerRegEmailStatus(customer, now = new Date()) {
  // Không bao gồm các tài khoản đăng nhập thông qua google
  if (customer.google_id || customer.googleId) {
    return {
      isWarning: false,
      isExpired: false,
      remainingMs: 0,
      remainingHours: 0,
      warningExpiresAt: null,
      warningMessage: ''
    };
  }

  const failedAt = customer.reg_email_failed_at || customer.regEmailFailedAt;
  if (!failedAt) {
    return {
      isWarning: false,
      isExpired: false,
      remainingMs: 0,
      remainingHours: 0,
      warningExpiresAt: null,
      warningMessage: ''
    };
  }

  const failedAtMs = new Date(failedAt).getTime();
  const expiresAtMs = failedAtMs + TWELVE_HOURS_MS;
  const remainingMs = expiresAtMs - now.getTime();

  if (remainingMs <= 0) {
    return {
      isWarning: false,
      isExpired: true,
      remainingMs: 0,
      remainingHours: 0,
      warningExpiresAt: new Date(expiresAtMs).toISOString(),
      warningMessage: 'Không thể gửi email thông báo đăng ký đến tài khoản này đã quá thời hạn 12 giờ.'
    };
  }

  const remainingHours = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));
  return {
    isWarning: true,
    isExpired: false,
    remainingMs,
    remainingHours,
    warningExpiresAt: new Date(expiresAtMs).toISOString(),
    warningMessage: `Không thể gửi email thông báo đăng ký. Vui lòng kiểm tra hoặc cập nhật lại email trong vòng ${remainingHours} giờ.`
  };
}

async function sendRegistrationNotificationEmail({ mailer, smtpConfig, to, fullName }) {
  if (!mailer || !smtpConfig?.from || !smtpConfig?.publicBaseUrl) {
    return false;
  }
  if (isDisposableEmail(to)) {
    return false;
  }
  const accountUrl = new URL('/tai-khoan', smtpConfig.publicBaseUrl).toString();
  const safeName = String(fullName || 'Khách hàng').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  try {
    await mailer.sendMail({
      from: `GAERU Support <${smtpConfig.from}>`,
      to,
      subject: 'Thông báo đăng ký tài khoản GAERU thành công',
      text: `Xin chào ${fullName},\n\nChúc mừng bạn đã tạo tài khoản GAERU thành công với địa chỉ email: ${to}.\n\nBạn có thể đăng nhập và theo dõi đơn hàng, ưu đãi tại: ${accountUrl}\n\nTrân trọng,\nĐội ngũ GAERU`,
      html: `<p>Xin chào <strong>${safeName}</strong>,</p><p>Chúc mừng bạn đã tạo tài khoản GAERU thành công với địa chỉ email: <strong>${to}</strong>.</p><p>Bạn có thể theo dõi đơn hàng và ưu đãi tại <a href="${accountUrl}">Tài khoản GAERU</a>.</p><p>Trân trọng,<br>Đội ngũ GAERU</p>`
    });
    return true;
  } catch (err) {
    return false;
  }
}

async function autoLockAccount(pool, customerId, reason, actor = { username: 'system', source: 'auto_lock' }) {
  return withTransaction(pool, async (client) => {
    const res = await client.query(
      `UPDATE customers
       SET active = false, lock_reason = $2, locked_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING id, full_name, email, phone, active, lock_reason`,
      [customerId, reason]
    );
    if (!res.rows.length) return null;
    await client.query(
      `UPDATE account_security SET version = version + 1, updated_at = now() WHERE account_key = $1`,
      ['customer:' + customerId]
    );
    await client.query(
      `UPDATE security_challenges SET used_at = now() WHERE account_key = $1 AND used_at IS NULL`,
      ['customer:' + customerId]
    );
    await appendAudit(client, {
      actor,
      action: 'customer.account.auto_locked',
      entityType: 'customer',
      entityId: customerId,
      metadata: { reason }
    });
    return res.rows[0];
  });
}

async function softDeleteCustomer(pool, customerId, actor, reason = 'Quản trị viên xóa tạm thời') {
  return withTransaction(pool, async (client) => {
    const res = await client.query(
      `UPDATE customers
       SET active = false, deleted_at = now(), deletion_recoverable = true,
           lock_reason = COALESCE(lock_reason, 'admin_soft_delete'), updated_at = now()
       WHERE id = $1
       RETURNING id, full_name, email, deleted_at, active`,
      [customerId]
    );
    if (!res.rows.length) return null;
    await client.query(
      `UPDATE account_security SET version = version + 1, updated_at = now() WHERE account_key = $1`,
      ['customer:' + customerId]
    );
    await appendAudit(client, {
      actor,
      action: 'customer.account.soft_deleted',
      entityType: 'customer',
      entityId: customerId,
      metadata: { reason }
    });
    return res.rows[0];
  });
}

async function restoreCustomerFromTrash(pool, customerId, actor, reason = 'Quản trị viên khôi phục tài khoản') {
  return withTransaction(pool, async (client) => {
    const res = await client.query(
      `UPDATE customers
       SET active = true, deleted_at = NULL, lock_reason = NULL, locked_at = NULL, updated_at = now()
       WHERE id = $1
       RETURNING id, full_name, email, deleted_at, active`,
      [customerId]
    );
    if (!res.rows.length) return null;
    await client.query(
      `UPDATE account_deletion_requests SET used_at = now() WHERE customer_id = $1 AND used_at IS NULL`,
      [customerId]
    );
    await client.query(
      `UPDATE account_security SET version = version + 1, updated_at = now() WHERE account_key = $1`,
      ['customer:' + customerId]
    );
    await appendAudit(client, {
      actor,
      action: 'customer.account.restored',
      entityType: 'customer',
      entityId: customerId,
      metadata: { reason }
    });
    return res.rows[0];
  });
}

async function permanentDeleteCustomer(pool, customerId, actor, reason = 'Quản trị viên xóa vĩnh viễn') {
  return withTransaction(pool, async (client) => {
    const customer = (await client.query('SELECT id, email FROM customers WHERE id = $1 FOR UPDATE', [customerId])).rows[0];
    if (!customer) return null;

    await client.query('DELETE FROM care_messages WHERE care_id IN (SELECT id FROM care_requests WHERE customer_id = $1)', [customerId]);
    await client.query('DELETE FROM care_requests WHERE customer_id = $1', [customerId]);
    await client.query(
      `DELETE FROM warranty_activations WHERE customer_id = $1 OR order_item_id IN (
         SELECT i.id FROM order_items i JOIN orders o ON o.id = i.order_id
         WHERE o.customer_id = $1 OR (o.customer_id IS NULL AND lower(o.email) = lower($2))
       )`,
      [customerId, customer.email]
    );
    await client.query('DELETE FROM customer_contact_changes WHERE customer_id = $1', [customerId]);
    await client.query('DELETE FROM customer_addresses WHERE customer_id = $1', [customerId]);
    await client.query('DELETE FROM customer_vouchers WHERE customer_id = $1', [customerId]);
    await client.query('DELETE FROM customer_campaign_reads WHERE customer_id = $1', [customerId]);
    await client.query('DELETE FROM customer_account_setup_tokens WHERE customer_id = $1', [customerId]);
    await client.query('DELETE FROM customer_password_reset_tokens WHERE customer_id = $1', [customerId]);
    await client.query('DELETE FROM customer_email_verification_tokens WHERE customer_id = $1', [customerId]);
    await client.query('DELETE FROM account_deletion_requests WHERE customer_id = $1', [customerId]);
    await client.query('DELETE FROM security_challenges WHERE account_key = $1', ['customer:' + customerId]);
    await client.query('DELETE FROM account_security WHERE account_key = $1', ['customer:' + customerId]);
    await client.query(
      `UPDATE orders
       SET customer_id = NULL, customer_name = 'Khách hàng đã xóa', email = '', phone = '', address = '', city = '', note = ''
       WHERE customer_id = $1 OR (customer_id IS NULL AND lower(email) = lower($2))`,
      [customerId, customer.email]
    );
    const deleteRes = await client.query('DELETE FROM customers WHERE id = $1 RETURNING id', [customerId]);
    if (!deleteRes.rowCount) return null;

    await appendAudit(client, {
      actor,
      action: 'customer.account.permanently_deleted',
      entityType: 'customer',
      entityId: customerId,
      metadata: { reason, email: customer.email }
    });
    return { id: customerId, deleted: true };
  });
}

module.exports = {
  DISPOSABLE_EMAIL_DOMAINS,
  isDisposableEmail,
  isPermanentSendMailError,
  normalizeVietnamPhone,
  isValidVietnamMobile,
  checkCustomerPhoneStatus,
  checkCustomerRegEmailStatus,
  sendRegistrationNotificationEmail,
  autoLockAccount,
  softDeleteCustomer,
  restoreCustomerFromTrash,
  permanentDeleteCustomer,
  TWELVE_HOURS_MS
};
