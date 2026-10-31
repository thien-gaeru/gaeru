const { withTransaction } = require('./db');
const { z } = require('zod');

const escape = value => String(value).replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

function makeMailer(config) {
  if (!config?.smtp) return null;
  const s = config.smtp;
  return require('nodemailer').createTransport(require('./smtp-security').smtpOptions(s));
}

async function confirmation(client, job) {
  if (job.order_id) {
    const order = (await client.query("SELECT order_number,email,status,payment_status FROM orders WHERE id=$1", [job.order_id])).rows[0];
    if (!order || order.status !== 'completed' || order.payment_status !== 'paid') return null;
    const rows = (await client.query(`SELECT i.product_name AS name,i.variant_name AS variant,count(*)::int AS quantity,min(w.purchase_date)::text AS start,min(w.expires_on)::text AS finish FROM warranty_activations w JOIN order_items i ON i.id=w.order_item_id WHERE i.order_id=$1 AND w.status='active' AND w.withdrawn_at IS NULL GROUP BY i.product_name,i.variant_name ORDER BY i.product_name,i.variant_name`, [job.order_id])).rows;
    if (!rows.length) return null;
    return {
      email: order.email,
      order: order.order_number,
      lines: rows.map(r => `${r.name}${r.variant ? ' · ' + r.variant : ''} × ${r.quantity}\nNgày mua đã xác nhận: ${r.start}\nHạn bảo hành: ${r.finish}`)
    };
  }
  const row = (await client.query(`SELECT COALESCE(NULLIF(w.contact_email,''),c.email) AS email,w.external_order_number AS number,w.external_product_name AS name,w.purchase_date::text AS start,w.expires_on::text AS finish FROM warranty_activations w LEFT JOIN customers c ON c.id=w.customer_id WHERE w.id=$1 AND w.status='active' AND w.withdrawn_at IS NULL AND (c.id IS NULL OR c.active=true)`, [job.warranty_id])).rows[0];
  return row ? { email: row.email, order: row.number, lines: [row.name + '\nNgày mua đã xác nhận: ' + row.start + '\nHạn bảo hành: ' + row.finish] } : null;
}

async function processWarrantyEmail(pool, config, mailer, { structured = false } = {}) {
  if (!mailer || !config?.smtp?.from) {
    if (structured) {
      const pending = await pool.query("SELECT 1 FROM warranty_email_outbox WHERE status = 'pending' LIMIT 1").catch(() => ({ rows: [] }));
      if (pending?.rows?.length > 0) {
        return { status: 'unsendable', reason: 'smtp_not_configured' };
      }
      return { status: 'no_work' };
    }
    return false;
  }

  await pool.query("UPDATE warranty_email_outbox SET status='unknown',finished_at=now(),result='Tiến trình gián đoạn; cần kiểm tra trước khi gửi lại' WHERE status='sending' AND attempted_at<now()-interval '2 minutes'");

  const job = await withTransaction(pool, async c => {
    const row = (await c.query("SELECT * FROM warranty_email_outbox WHERE status='pending' AND next_attempt_at<=now() ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
    if (!row) return null;
    const message = await confirmation(c, row);
    if (!message || !z.string().email().max(254).safeParse(message.email).success) {
      await c.query("UPDATE warranty_email_outbox SET status='skipped',finished_at=now(),result=$2 WHERE id=$1", [row.id, message ? 'Chưa có email hợp lệ' : 'Hồ sơ không còn hiệu lực']);
      return { skipped: true, id: row.id, reason: message ? 'invalid_email' : 'record_invalid' };
    }
    await c.query("UPDATE warranty_email_outbox SET status='sending',attempts=attempts+1,attempted_at=now() WHERE id=$1", [row.id]);
    return { ...row, message, attempts: row.attempts + 1 };
  });

  if (!job) return structured ? { status: 'no_work' } : false;
  if (job.skipped) return structured ? { status: 'unsendable', outboxId: job.id, reason: job.reason } : true;

  let outcomeStatus = 'sent';
  let outcomeError = null;

  try {
    const { message } = job;
    const base = new URL(require('./primary-domain').normalizePublicBase(config.PUBLIC_BASE_URL || config.smtp?.publicBaseUrl || 'https://gaeru.com')).origin;
    const text = 'Bảo hành sản phẩm GAERU đã được kích hoạt thành công.\n\nĐơn hàng: ' + message.order + '\n\n' + message.lines.join('\n\n') + '\n\nThời hạn tính theo ngày mua đã xác nhận (giờ Việt Nam). Xem hồ sơ tại ' + base + '/care#warranty-activation';
    const result = await mailer.sendMail({
      from: config.smtp.from,
      to: message.email,
      subject: 'GAERU · Kích hoạt bảo hành thành công',
      text,
      html: '<html lang="vi"><meta charset="utf-8"><body><h1>Kích hoạt bảo hành thành công</h1><div style="white-space:pre-wrap">' + escape(text) + '</div></body></html>',
      messageId: '<warranty-' + job.id + '@gaeru.com>'
    });
    const accepted = result?.accepted?.some(v => String(v.address || v).toLowerCase() === message.email.toLowerCase());
    const finalStatus = accepted ? 'sent' : result?.rejected?.length ? 'failed' : 'unknown';
    await pool.query("UPDATE warranty_email_outbox SET status=$2,finished_at=now(),result=$3 WHERE id=$1 AND status='sending'", [
      job.id,
      finalStatus,
      accepted ? 'SMTP đã tiếp nhận' : result?.rejected?.length ? 'SMTP từ chối người nhận' : 'Chưa xác định kết quả SMTP'
    ]);
    outcomeStatus = accepted ? 'sent' : result?.rejected?.length ? 'unsendable' : 'unknown';
  } catch (error) {
    const safeRetry = (Number(error.responseCode) >= 400 && Number(error.responseCode) < 500) || ['CONN', 'EHLO', 'STARTTLS', 'AUTH', 'MAIL FROM', 'RCPT TO'].includes(error.command);
    const retry = safeRetry && job.attempts < 3;
    const finalStatus = retry ? 'pending' : Number(error.responseCode) >= 400 ? 'failed' : 'unknown';
    await pool.query("UPDATE warranty_email_outbox SET status=$2,next_attempt_at=now()+interval '5 minutes',finished_at=CASE WHEN $2='pending' THEN NULL ELSE now() END,result=$3 WHERE id=$1 AND status='sending'", [
      job.id,
      finalStatus,
      retry ? 'Chờ thử lại kết nối gửi thư' : 'Chưa gửi được hoặc chưa xác định kết quả; không tự gửi trùng'
    ]);
    outcomeStatus = retry ? 'retry' : Number(error.responseCode) >= 400 ? 'unsendable' : 'unknown';
    outcomeError = error.message;
  }

  if (structured) {
    return {
      status: outcomeStatus,
      outboxId: job.id,
      attempts: job.attempts,
      error: outcomeError
    };
  }
  return true;
}

function startWarrantyEmailWorker(pool, config, { mailer = makeMailer(config), intervalMs = 15000 } = {}) {
  let stopped = false, running = false;
  async function run() {
    if (stopped || running) return;
    running = true;
    try {
      await processWarrantyEmail(pool, config, mailer);
    } catch {
      console.error('Warranty email queue temporarily unavailable');
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
  processWarrantyEmail,
  processWarrantyEmailOutbox: (pool, config, mailer, opts = {}) => processWarrantyEmail(pool, config, mailer, { structured: true, ...opts }),
  startWarrantyEmailWorker
};
