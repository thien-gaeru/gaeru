const { z } = require('zod');
const { EmailOutboxDispatcher } = require('./domain/email/email-outbox-dispatcher');

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
    const rows = (await client.query(
      `SELECT i.product_name AS name,i.variant_name AS variant,count(*)::int AS quantity,min(w.purchase_date)::text AS start,min(w.expires_on)::text AS finish
       FROM warranty_activations w
       JOIN order_items i ON i.id=w.order_item_id
       WHERE i.order_id=$1 AND w.status='active' AND w.withdrawn_at IS NULL
       GROUP BY i.product_name,i.variant_name
       ORDER BY i.product_name,i.variant_name`,
      [job.order_id]
    )).rows;
    if (!rows.length) return null;
    return {
      email: order.email,
      order: order.order_number,
      lines: rows.map(r => `${r.name}${r.variant ? ' · ' + r.variant : ''} × ${r.quantity}\nNgày mua đã xác nhận: ${r.start}\nHạn bảo hành: ${r.finish}`)
    };
  }
  const row = (await client.query(
    `SELECT COALESCE(NULLIF(w.contact_email,''),c.email) AS email,w.external_order_number AS number,w.external_product_name AS name,w.purchase_date::text AS start,w.expires_on::text AS finish
     FROM warranty_activations w
     LEFT JOIN customers c ON c.id=w.customer_id
     WHERE w.id=$1 AND w.status='active' AND w.withdrawn_at IS NULL AND (c.id IS NULL OR c.active=true)`,
    [job.warranty_id]
  )).rows[0];
  return row ? { email: row.email, order: row.number, lines: [row.name + '\nNgày mua đã xác nhận: ' + row.start + '\nHạn bảo hành: ' + row.finish] } : null;
}

async function processWarrantyEmail(pool, config, mailer, { structured = false } = {}) {
  return EmailOutboxDispatcher.dispatchNext(pool, config, mailer, {
    tableName: 'warranty_email_outbox',
    domain: 'warranty',
    allowRetry: true,
    maxAttempts: 3,
    structured,
    claimJob: async (client, row) => {
      const message = await confirmation(client, row);
      if (!message || !z.string().email().max(254).safeParse(message.email).success) {
        await client.query("UPDATE warranty_email_outbox SET status='skipped',finished_at=now(),result=$2 WHERE id=$1", [
          row.id,
          message ? 'Chưa có email hợp lệ' : 'Hồ sơ không còn hiệu lực'
        ]);
        return { skipped: true, id: row.id, reason: message ? 'invalid_email' : 'record_invalid' };
      }
      return { message };
    },
    buildMessage: async (job, cfg) => {
      const { message } = job;
      const base = new URL(require('./primary-domain').normalizePublicBase(cfg.PUBLIC_BASE_URL || cfg.smtp?.publicBaseUrl || 'https://gaeru.com')).origin;
      const text = 'Bảo hành sản phẩm GAERU đã được kích hoạt thành công.\n\nĐơn hàng: ' + message.order + '\n\n' + message.lines.join('\n\n') + '\n\nThời hạn tính theo ngày mua đã xác nhận (giờ Việt Nam). Xem hồ sơ tại ' + base + '/care#warranty-activation';

      return {
        to: message.email,
        subject: 'GAERU · Kích hoạt bảo hành thành công',
        text,
        html: '<html lang="vi"><meta charset="utf-8"><body><h1>Kích hoạt bảo hành thành công</h1><div style="white-space:pre-wrap">' + escape(text) + '</div></body></html>',
        messageId: '<warranty-' + job.id + '@gaeru.com>'
      };
    }
  });
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
