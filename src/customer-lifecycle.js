const { createHash } = require('node:crypto');
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

  try {
    await mailer.sendMail({
      from: require('./smtp-delivery').resolveFrom({ smtp: smtpConfig }),
      replyTo: require('./smtp-delivery').resolveReplyTo({ smtp: smtpConfig }),
      to,
      subject: 'Thông báo đăng ký tài khoản GAERU thành công',
      text: `Xin chào ${fullName},\n\nChúc mừng bạn đã tạo tài khoản GAERU thành công với địa chỉ email: ${to}.\n\nBạn có thể đăng nhập và theo dõi đơn hàng, ưu đãi tại: ${accountUrl}\n\nTrân trọng,\nĐội ngũ GAERU`,
      html: require('./smtp-delivery').renderGaeruEmailHtml({ config: { smtp: smtpConfig }, heading: 'Chào mừng bạn gia nhập GAERU', badge: 'THÀNH VIÊN MỚI', badgeTone: 'green', preheader: `Tài khoản GAERU (${to}) đã sẵn sàng để đặt hàng và kích hoạt bảo hành CARE+.`, leadText: `Xin chào ${fullName}, chúc mừng bạn đã đăng ký tài khoản thành viên GAERU thành công. Từ nay bạn có thể theo dõi đơn hàng, quản lý bảo hành điện tử và nhận ưu đãi riêng trong một nơi duy nhất.`, htmlBodyText: '', summaryRows: [{ label: 'Chủ tài khoản', value: fullName }, { label: 'Email đăng nhập', value: to }, { label: 'Tiện ích tài khoản', value: 'Đơn hàng · Bảo hành CARE+ · Ưu đãi thành viên' }], actionUrl: accountUrl, actionLabel: 'Mở tài khoản GAERU' }),
      messageId: require('./smtp-delivery').buildMessageId('welcome', { smtp: smtpConfig })
    });
    return true;
  } catch (err) {
    return false;
  }
}

async function autoLockAccount(pool, customerId, reason, actor = { username: 'system', source: 'auto_lock' }) {
  const locked = await withTransaction(pool, async (client) => {
    const res = await client.query(
      `UPDATE customers
       SET active = false, lock_reason = $2, locked_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING id, full_name, email, phone, active, lock_reason`,
      [customerId, reason]
    );
    if (!res.rows.length) return null;
    await client.query(
      `INSERT INTO account_security (account_key, version, updated_at)
       VALUES ($1, 2, now())
       ON CONFLICT (account_key) DO UPDATE
       SET version = account_security.version + 1, updated_at = now()
       RETURNING version`,
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
  if (locked) {
    try { require('./cache').invalidateTags(['account-security'], { immediate: true }); } catch (_) {}
  }
  return locked;
}

async function softDeleteCustomer(pool, customerId, actor, reason = 'Quản trị viên xóa tạm thời') {
  const deleted = await withTransaction(pool, async (client) => {
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
      `INSERT INTO account_security (account_key, version, updated_at)
       VALUES ($1, 2, now())
       ON CONFLICT (account_key) DO UPDATE
       SET version = account_security.version + 1, updated_at = now()
       RETURNING version`,
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
  if (deleted) {
    try { require('./cache').invalidateTags(['account-security'], { immediate: true }); } catch (_) {}
  }
  return deleted;
}

async function restoreCustomerFromTrash(pool, customerId, actor, reason = 'Quản trị viên khôi phục tài khoản') {
  const restored = await withTransaction(pool, async (client) => {
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
      `INSERT INTO account_security (account_key, version, updated_at)
       VALUES ($1, 2, now())
       ON CONFLICT (account_key) DO UPDATE
       SET version = account_security.version + 1, updated_at = now()
       RETURNING version`,
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
  if (restored) {
    try { require('./cache').invalidateTags(['account-security'], { immediate: true }); } catch (_) {}
  }
  return restored;
}

function buildBlockingOrderExistsSql(customerRef = '$1', orderAlias = 'o') {
  return `EXISTS (
    SELECT 1 FROM orders ${orderAlias}
    WHERE ${orderAlias}.customer_id = ${customerRef} AND (
      ${orderAlias}.status = 'shipped'
      OR (${orderAlias}.status IN ('pending', 'confirmed', 'processing') AND (
        ${orderAlias}.payment_status = 'paid'
        OR EXISTS (SELECT 1 FROM sales_receipts sr WHERE sr.order_id = ${orderAlias}.id)
      ))
      OR EXISTS (
        SELECT 1 FROM payment_attempts pa
        WHERE pa.order_id = ${orderAlias}.id
          AND pa.provider IN ('vnpay', 'momo', 'zalopay')
          AND pa.status = 'pending'
          AND (
            pa.expires_at > now()
            OR (pa.provider = 'momo' AND pa.response_code IN ('1000', '7000', '7002') AND COALESCE(pa.expires_at, pa.created_at) > now() - interval '72 hours')
          )
      )
      OR EXISTS (
        SELECT 1 FROM carrier_shipment_attempts a
        WHERE a.order_id = ${orderAlias}.id AND a.status IN ('sending', 'unknown')
      )
      OR EXISTS (
        SELECT 1 FROM carrier_shipments s
        WHERE s.order_id = ${orderAlias}.id AND (
          s.status IN ('created','picking','delivering','return_requested','returning','cancel_requested','cancel_reconciliation_required')
          OR (s.status = 'delivered' AND s.cod_amount_vnd > 0 AND s.cod_settlement_status <> 'settled')
        )
      )
      OR EXISTS (
        SELECT 1 FROM momo_refunds mr
        WHERE mr.order_id = ${orderAlias}.id
          AND mr.status IN ('pending_provider', 'pending', 'ambiguous')
      )
      OR EXISTS (
        SELECT 1 FROM order_after_sales oas
        WHERE oas.order_id = ${orderAlias}.id
          AND oas.status NOT IN ('resolved', 'rejected')
      )
    )
  )`;
}

async function hasBlockingCustomerActivity(client, customerId, { savepointPrefix = 'sp_cust_del_guard' } = {}) {
  // Lock all existing orders of this customer in deterministic ID order BEFORE evaluating the guard
  // to eliminate READ COMMITTED TOCTOU races with concurrent payment IPN callbacks.
  await client.query('SELECT id FROM orders WHERE customer_id = $1 ORDER BY id FOR UPDATE', [customerId]);

  const inFlight = await client.query(
    `SELECT 1 FROM customers c WHERE c.id = $1 AND ${buildBlockingOrderExistsSql('c.id', 'o')} LIMIT 1`,
    [customerId]
  );
  if (inFlight.rows.length) {
    return {
      blocked: true,
      reason: 'in_flight_order',
      message: 'Khách hàng còn đơn hàng đã thanh toán chưa hoàn tất giao, vận đơn/đối soát COD, lệnh hoàn tiền MoMo đang chờ hoặc hồ sơ đổi trả (RMA) đang mở. Vui lòng hoàn tất xử lý trước khi xóa tài khoản.'
    };
  }

  const sp = `${savepointPrefix}_intent`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const openIntent = await client.query(
      "SELECT id FROM checkout_payment_intents WHERE customer_id = $1 AND status = 'pending_provider' LIMIT 1",
      [customerId]
    );
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    if (openIntent.rows.length) {
      return {
        blocked: true,
        reason: 'pending_checkout_intent',
        message: 'Khách hàng đang có phiên thanh toán trực tuyến đang chờ xử lý. Vui lòng chờ phiên hoàn tất trước khi xóa tài khoản.'
      };
    }
  } catch (intentErr) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
    if (intentErr?.code !== '42P01' && intentErr?.code !== '42703') throw intentErr;
  }

  return { blocked: false, reason: null, message: null };
}

async function permanentDeleteCustomer(pool, customerId, actor, reason = 'Quản trị viên xóa vĩnh viễn') {
  return withTransaction(pool, async (client) => {
    const customer = (await client.query('SELECT id, email FROM customers WHERE id = $1 FOR UPDATE', [customerId])).rows[0];
    if (!customer) return null;

    const guard = await hasBlockingCustomerActivity(client, customerId, { savepointPrefix: 'sp_del_cust' });
    if (guard.blocked) {
      throw Object.assign(new Error(guard.message), { status: 409 });
    }

    // Giải phóng tồn kho giữ chỗ cho các đơn nháp chưa thanh toán trước khi ẩn danh PII
    const inv = require('./inventory');
    const openUnpaidOrders = (await client.query(
      `SELECT id, voucher_code FROM orders
       WHERE customer_id = $1 AND status IN ('pending', 'confirmed', 'processing') AND payment_status <> 'paid'
       FOR UPDATE`,
      [customerId]
    )).rows;
    for (const draft of openUnpaidOrders) {
      await inv.releaseOrderStock(client, { orderId: draft.id, actor });
      await client.query("UPDATE payment_attempts SET status = 'failed', updated_at = now() WHERE order_id = $1 AND status = 'pending'", [draft.id]);
      if (draft.voucher_code) {
        await client.query('UPDATE voucher_redemptions SET released = true WHERE order_id = $1 AND released = false', [draft.id]);
      }
      await client.query(
        "UPDATE orders SET status = 'cancelled', cancellation_reason = 'Hủy đơn chưa thanh toán khi xóa tài khoản khách hàng', updated_at = now() WHERE id = $1",
        [draft.id]
      );
    }

    await require('./order-deletion').purgeCareRequestsByEntity(client, 'customer_id', customerId);
    /* care_requests removed via purgeCareRequestsByEntity */
    await client.query(
      `DELETE FROM warranty_email_outbox WHERE warranty_id IN (
         SELECT id FROM warranty_activations WHERE customer_id = $1 OR order_item_id IN (
           SELECT i.id FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.customer_id = $1
         )
       )`,
      [customerId]
    );
    const deletedWarranties = (await client.query(
      `DELETE FROM warranty_activations WHERE customer_id = $1 OR order_item_id IN (
         SELECT i.id FROM order_items i JOIN orders o ON o.id = i.order_id
         WHERE o.customer_id = $1
       ) RETURNING channel, external_order_number`,
      [customerId]
    )).rows;
    for (const dw of deletedWarranties) {
      if (!dw.external_order_number || !dw.channel) continue;
      const claimKey = String(dw.external_order_number).replace(/\s/g, '').toUpperCase();
      await client.query(
        `DELETE FROM warranty_order_claims
         WHERE channel = $1 AND order_key = $2
           AND NOT EXISTS (
             SELECT 1 FROM warranty_activations
             WHERE channel = $1
               AND upper(regexp_replace(COALESCE(external_order_number, ''), '[[:space:]]', '', 'g')) = $2
               AND withdrawn_at IS NULL
               AND status IN ('pending', 'active', 'revoked')
           )`,
        [dw.channel, claimKey]
      );
    }
    await client.query('SAVEPOINT sp_del_cust_abandoned_and_outbox');
    try {
      await client.query('DELETE FROM abandoned_carts WHERE customer_id = $1', [customerId]);
      await client.query(
        `UPDATE order_email_outbox
         SET status = 'skipped', finished_at = now(), result = 'Tài khoản khách hàng đã bị xóa vĩnh viễn'
         WHERE status = 'pending'
           AND (customer_id = $1 OR order_id IN (SELECT id FROM orders WHERE customer_id = $1))`,
        [customerId]
      );
      await client.query('RELEASE SAVEPOINT sp_del_cust_abandoned_and_outbox');
    } catch (cleanErr) {
      await client.query('ROLLBACK TO SAVEPOINT sp_del_cust_abandoned_and_outbox').catch(() => {});
      if (cleanErr?.code !== '42P01') throw cleanErr;
    }
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
    const { anonymizeCustomerOrders } = require('./order-deletion');
    await anonymizeCustomerOrders(client, customerId, { actor });
    const deleteRes = await client.query('DELETE FROM customers WHERE id = $1 RETURNING id', [customerId]);
    if (!deleteRes.rowCount) return null;

    const emailFingerprint = customer.email
      ? 'sha256:' + createHash('sha256').update(String(customer.email).trim().toLowerCase()).digest('hex')
      : null;
    await appendAudit(client, {
      actor,
      action: 'customer.account.permanently_deleted',
      entityType: 'customer',
      entityId: customerId,
      metadata: { reason, emailFingerprint, piiRedacted: true }
    });
    return { id: customerId, deleted: true };
  });
}

module.exports = {
  DISPOSABLE_EMAIL_DOMAINS,
  isDisposableEmail,
  isPermanentSendMailError,
  normalizeVietnamPhone,
  buildBlockingOrderExistsSql,
  hasBlockingCustomerActivity,
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
