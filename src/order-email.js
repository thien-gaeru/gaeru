const { withTransaction } = require('./db');
const { randomBytes, createHash } = require('node:crypto');
const { EmailOutboxDispatcher } = require('./domain/email/email-outbox-dispatcher');

const escape = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[c]));

async function processOrderEmail(pool, config, mailer, { structured = false } = {}) {
  return EmailOutboxDispatcher.dispatchNext(pool, config, mailer, {
    tableName: 'order_email_outbox',
    domain: 'order',
    allowRetry: true,
    maxAttempts: 3,
    structured,
    claimJob: async (client, row) => {
      const order = (await client.query(
        'SELECT o.*, (SELECT s.carrier_name FROM order_shipping_selection s WHERE s.order_id=o.id LIMIT 1) AS "shippingCarrierName" FROM orders o WHERE o.id=$1',
        [row.order_id]
      )).rows[0];

      if (!order) {
        await client.query("UPDATE order_email_outbox SET status='skipped',finished_at=now() WHERE id=$1", [row.id]);
        return { skipped: true, id: row.id, reason: 'order_not_found' };
      }

      let token = null;
      if (row.kind === 'welcome') {
        const customer = (await client.query(
          'SELECT id,email,active,deleted_at,checkout_pending FROM customers WHERE id=$1 FOR UPDATE',
          [row.customer_id]
        )).rows[0];

        if (!customer || !customer.active || customer.deleted_at || !customer.checkout_pending || order.customer_id !== customer.id) {
          await client.query("UPDATE order_email_outbox SET status='skipped',finished_at=now() WHERE id=$1", [row.id]);
          return { skipped: true, id: row.id, reason: 'customer_invalid' };
        }

        token = randomBytes(32).toString('hex');
        await client.query('UPDATE customer_account_setup_tokens SET used_at=now() WHERE customer_id=$1 AND used_at IS NULL', [customer.id]);
        await client.query(
          "INSERT INTO customer_account_setup_tokens(customer_id,token_hash,expires_at) VALUES($1,$2,now()+interval '24 hours')",
          [customer.id, createHash('sha256').update(token).digest('hex')]
        );
        order.email = customer.email;
      }

      const items = (await client.query(
        'SELECT product_name,variant_name,quantity,unit_price_vnd FROM order_items WHERE order_id=$1 ORDER BY id',
        [order.id]
      )).rows;

      return { order, items, token };
    },
    buildMessage: async (job, cfg) => {
      const base = new URL(require('./primary-domain').normalizePublicBase(cfg.PUBLIC_BASE_URL || cfg.smtp?.publicBaseUrl || 'https://gaeru.com')).origin;
      const o = job.order;
      const setup = base + '/tai-khoan?token=' + job.token + '&setup=1#password-reset';
      const status = { pending: 'Chờ xác nhận', confirmed: 'Đã xác nhận', processing: 'Đang chuẩn bị', shipped: 'Đang giao', completed: 'Hoàn tất', cancelled: 'Đã hủy' };
      const amount = v => new Intl.NumberFormat('vi-VN').format(v) + ' ₫';
      const text = job.kind === 'welcome'
        ? 'GAERU đã tạo tài khoản theo email bạn cung cấp khi đặt đơn ' + o.order_number + '.\n\nĐặt mật khẩu và xác minh email bằng liên kết dùng một lần, có hiệu lực 24 giờ:\n' + setup + '\n\nNếu bạn không thực hiện đặt hàng, không mở liên kết và liên hệ business@gaeru.com. Không có mật khẩu nào được gửi trong email này.'
        : 'GAERU đã tiếp nhận đơn ' + o.order_number + '.\n\n' + job.items.map(i => i.product_name + ' · ' + i.variant_name + ' × ' + i.quantity + ' · ' + amount(i.unit_price_vnd * i.quantity)).join('\n') + '\n\nTạm tính: ' + amount(o.subtotal_vnd) + '\nGiảm giá: ' + amount(o.discount_vnd || 0) + '\nGiao hàng: ' + amount(o.shipping_fee_vnd) + (o.shippingCarrierName ? ' (' + o.shippingCarrierName + ')' : '') + '\nTổng cộng: ' + amount(o.total_vnd) + '\nThanh toán: ' + (o.payment_method === 'cod' ? 'COD — thanh toán khi nhận hàng.' : 'VNPAY — trạng thái hiện tại: ' + o.payment_status) + '.\nTrạng thái: ' + (status[o.status] || 'Đang xử lý') + '. Email này không phải xác nhận đã thanh toán.\n\nGiao tới: ' + o.customer_name + ' · ' + o.address + ', ' + o.city + '\nTài khoản: ' + base + '/tai-khoan\nHỗ trợ: business@gaeru.com · 082 919 1080';

      return {
        to: o.email,
        subject: job.kind === 'welcome' ? 'GAERU · Đặt mật khẩu tài khoản mới' : 'GAERU · Đã tiếp nhận đơn ' + o.order_number,
        text,
        html: '<html lang="vi"><meta charset="utf-8"><body><h1>' + escape(job.kind === 'welcome' ? 'Chào mừng đến GAERU' : 'Thông tin đơn hàng') + '</h1><div style="white-space:pre-wrap">' + escape(text) + '</div>' + (job.kind === 'welcome' ? '<p><a href="' + escape(setup) + '">Đặt mật khẩu tài khoản</a></p>' : '') + '</body></html>',
        messageId: '<order-' + job.id + '@gaeru.com>'
      };
    }
  });
}

function startOrderEmailWorker(pool, config, mailer) {
  let timer = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      while (await processOrderEmail(pool, config, mailer)) {}
    } catch (e) {
      console.error('Order email worker loop error:', e);
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, 10000);
  void tick();

  return () => {
    if (timer) clearInterval(timer);
  };
}

module.exports = {
  processOrderEmail,
  processOrderEmailOutbox: (pool, config, mailer, opts = {}) => processOrderEmail(pool, config, mailer, { structured: true, ...opts }),
  startOrderEmailWorker
};
