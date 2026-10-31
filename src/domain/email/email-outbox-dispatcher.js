'use strict';

const { withTransaction } = require('../../db');

/**
 * EmailOutboxDispatcher — Abstraction thống nhất quản lý hàng đợi email outbox:
 * - Thu hồi và phân định các job 'sending' bị gián đoạn/treo (> 2 phút).
 * - Khóa hàng an toàn đồng thời bằng FOR UPDATE SKIP LOCKED.
 * - Quản lý gửi qua Nodemailer và phân loại kết quả chuẩn hóa (sent, retry, unsendable, unknown, no_work).
 * - Chống gửi lặp (anti-duplicate) và quản lý backoff thử lại.
 * - Giữ nguyên vẹn template và nghiệp vụ riêng của từng domain (Đơn hàng, Bảo hành, Marketing).
 */
class EmailOutboxDispatcher {
  /**
   * Xử lý một email trong outbox
   * @param {Object} pool Database connection pool
   * @param {Object} config Cấu hình ứng dụng
   * @param {Object} mailer Nodemailer transporter
   * @param {Object} params Cấu hình dispatcher cho domain
   * @param {string} params.tableName Tên bảng outbox trong PostgreSQL
   * @param {string} params.domain Tên domain định danh ('order' | 'warranty' | 'marketing')
   * @param {Function} params.claimJob Hook khóa và nạp dữ liệu nghiệp vụ: async (client, row) => hydratedJob
   * @param {Function} params.buildMessage Hook tạo nội dung thư: async (job, config) => { to, subject, text, html, headers, messageId }
   * @param {boolean} [params.allowRetry=true] Cho phép thử lại khi gặp lỗi tạm thời
   * @param {number} [params.maxAttempts=3] Số lần thử tối đa
   * @param {boolean} [params.structured=false] Trả về kết quả có cấu trúc hay boolean
   * @returns {Promise<Object|boolean>}
   */
  static async dispatchNext(pool, config, mailer, {
    tableName,
    domain,
    claimJob,
    buildMessage,
    allowRetry = true,
    maxAttempts = 3,
    structured = false
  }) {
    if (!pool || typeof pool.query !== 'function') {
      return structured ? { status: 'no_work', reason: 'db_pool_unavailable' } : false;
    }

    // 1. Kiểm tra cấu hình Mailer & SMTP
    if (!mailer || !config?.smtp?.from) {
      if (structured) {
        const pending = await pool.query(`SELECT 1 FROM ${tableName} WHERE status = 'pending' LIMIT 1`).catch(() => ({ rows: [] }));
        if (pending?.rows?.length > 0) {
          return { status: 'unsendable', domain, reason: 'smtp_not_configured' };
        }
        return { status: 'no_work', domain };
      }
      return false;
    }

    // 2. Thu hồi các job bị treo trong trạng thái 'sending' quá 2 phút
    await pool.query(
      `UPDATE ${tableName}
       SET status = 'unknown', finished_at = now(), result = 'Tiến trình gián đoạn; kiểm tra trước khi gửi lại'
       WHERE status = 'sending' AND attempted_at < now() - interval '2 minutes'`
    ).catch(() => {});

    // 3. Khóa và nạp dữ liệu job theo transaction nguyên tử
    const job = await withTransaction(pool, async (client) => {
      const row = (await client.query(
        `SELECT * FROM ${tableName}
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED LIMIT 1`
      )).rows[0];

      if (!row) return null;

      // Ủy quyền cho hook domain nạp dữ liệu liên quan và kiểm tra điều kiện nghiệp vụ
      const hydrated = await claimJob(client, row);
      if (!hydrated) {
        await client.query(`UPDATE ${tableName} SET status = 'skipped', finished_at = now() WHERE id = $1`, [row.id]);
        return { skipped: true, id: row.id, reason: 'record_not_found' };
      }

      if (hydrated.skipped) {
        return hydrated;
      }

      const nextAttempts = (row.attempts || 0) + 1;
      await client.query(
        `UPDATE ${tableName}
         SET status = 'sending', attempts = $2, attempted_at = now()
         WHERE id = $1`,
        [row.id, nextAttempts]
      );

      return { ...row, ...hydrated, attempts: nextAttempts };
    });

    if (!job) return structured ? { status: 'no_work', domain } : false;
    if (job.skipped) return structured ? { status: 'unsendable', domain, outboxId: job.id, reason: job.reason } : true;

    // 4. Dựng nội dung email qua template domain
    let message = null;
    try {
      message = await buildMessage(job, config);
    } catch (err) {
      await pool.query(
        `UPDATE ${tableName}
         SET status = 'failed', finished_at = now(), result = $2
         WHERE id = $1 AND status = 'sending'`,
        [job.id, 'Lỗi dựng nội dung thư: ' + (err.message || 'Template error')]
      );
      return structured ? { status: 'unsendable', domain, outboxId: job.id, reason: 'template_render_error', error: err.message } : true;
    }

    if (!message || !message.to) {
      await pool.query(
        `UPDATE ${tableName}
         SET status = 'skipped', finished_at = now(), result = 'Thiếu địa chỉ email người nhận hợp lệ'
         WHERE id = $1 AND status = 'sending'`,
        [job.id]
      );
      return structured ? { status: 'unsendable', domain, outboxId: job.id, reason: 'missing_recipient' } : true;
    }

    // 5. Gửi thư qua Nodemailer với quản lý kết quả chặt chẽ
    let outcomeStatus = 'sent';
    let outcomeError = null;

    try {
      const sendPayload = {
        from: config.smtp.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.headers || {},
        messageId: message.messageId || `<${domain}-${job.id}@gaeru.com>`
      };

      const result = await mailer.sendMail(sendPayload);
      const recipientEmail = String(message.to).toLowerCase();
      const accepted = result?.accepted?.some(x => String(x.address || x).toLowerCase() === recipientEmail);

      const finalStatus = accepted ? 'sent' : (result?.rejected?.length ? 'failed' : 'unknown');
      await pool.query(
        `UPDATE ${tableName}
         SET status = $2, finished_at = now(), result = $3
         WHERE id = $1 AND status = 'sending'`,
        [
          job.id,
          finalStatus,
          accepted ? 'SMTP đã tiếp nhận' : (result?.rejected?.length ? 'SMTP từ chối' : 'Chưa xác định kết quả SMTP')
        ]
      );

      outcomeStatus = accepted ? 'sent' : (result?.rejected?.length ? 'unsendable' : 'unknown');
    } catch (e) {
      outcomeError = e.message;
      const respCode = Number(e.responseCode);
      const isTransientNetwork = !e.responseCode && ['CONN', 'EHLO', 'STARTTLS', 'AUTH', 'MAIL FROM', 'RCPT TO'].includes(e.command);
      const is4xx = respCode >= 400 && respCode < 500;
      const safeRetry = allowRetry && (is4xx || isTransientNetwork);
      const canRetry = safeRetry && job.attempts < maxAttempts;

      const finalStatus = canRetry ? 'pending' : (respCode >= 400 ? 'failed' : 'unknown');
      await pool.query(
        `UPDATE ${tableName}
         SET status = $2,
             next_attempt_at = now() + interval '5 minutes',
             finished_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END,
             result = $3
         WHERE id = $1 AND status = 'sending'`,
        [
          job.id,
          finalStatus,
          canRetry ? 'Chờ thử lại kết nối SMTP' : 'Kiểm tra kết quả trước khi gửi lại'
        ]
      );

      outcomeStatus = canRetry ? 'retry' : (respCode >= 400 ? 'unsendable' : 'unknown');
    }

    if (structured) {
      return {
        status: outcomeStatus,
        domain,
        outboxId: job.id,
        attempts: job.attempts,
        ...(job.order_id ? { orderId: job.order_id } : {}),
        ...(job.warranty_id ? { warrantyId: job.warranty_id } : {}),
        ...(outcomeError ? { error: outcomeError } : {})
      };
    }

    return outcomeStatus === 'sent';
  }
}

module.exports = { EmailOutboxDispatcher };
