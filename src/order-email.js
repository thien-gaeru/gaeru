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

const PAYMENT_METHOD_LABELS = Object.freeze({
  cod: 'COD',
  bank_transfer: 'Chuyển khoản ngân hàng',
  vnpay: 'VNPAY',
  '9pay': '9Pay',
  momo: 'Ví MoMo',
  zalopay: 'Ví ZaloPay'
});

function getPaymentMethodLabel(method) {
  if (!method) return 'Chưa xác định';
  return PAYMENT_METHOD_LABELS[method] || String(method).toUpperCase();
}


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
        : 'GAERU đã tiếp nhận đơn ' + o.order_number + '.\n\n' + job.items.map(i => i.product_name + ' · ' + i.variant_name + ' × ' + i.quantity + ' · ' + amount(i.unit_price_vnd * i.quantity)).join('\n') + '\n\nTạm tính: ' + amount(o.subtotal_vnd) + '\nGiảm giá: ' + amount(o.discount_vnd || 0) + '\nGiao hàng: ' + amount(o.shipping_fee_vnd) + (o.shippingCarrierName ? ' (' + o.shippingCarrierName + ')' : '') + '\nTổng cộng: ' + amount(o.total_vnd) + '\nThanh toán: ' + (o.payment_method === 'cod' ? 'COD — thanh toán khi nhận hàng.' : (getPaymentMethodLabel(o.payment_method) + ' — trạng thái hiện tại: ' + (o.payment_status || 'Chờ thanh toán'))) + '.\nTrạng thái: ' + (status[o.status] || 'Đang xử lý') + '. Email này không phải xác nhận đã thanh toán.\n\nGiao tới: ' + o.customer_name + ' · ' + o.address + ', ' + o.city + '\nTài khoản: ' + base + '/tai-khoan\nHỗ trợ: business@gaeru.com · 082 919 1080';

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

function makeMailer(config) {
  if (!config?.smtp) return null;
  const s = config.smtp;
  try {
    return require('nodemailer').createTransport(require('./smtp-security').smtpOptions(s));
  } catch {
    return null;
  }
}

function startOrderEmailWorker(pool, config, mailerOrOptions = {}) {
  let mailer = null;
  let intervalMs = 10000;
  let resolver = undefined;

  if (mailerOrOptions && typeof mailerOrOptions.sendMail === 'function') {
    mailer = mailerOrOptions;
  } else if (typeof mailerOrOptions === 'object' && mailerOrOptions !== null) {
    mailer = mailerOrOptions.mailer;
    if (mailerOrOptions.intervalMs) intervalMs = mailerOrOptions.intervalMs;
    if (mailerOrOptions.resolver) resolver = mailerOrOptions.resolver;
  }

  // Tái sử dụng transporter có kiểm tra cấu hình SMTP (fail-safe nếu caller không cấp mailer)
  if (!mailer) {
    mailer = makeMailer(config);
  }

  let timer = null;
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      // 1. P1-02: Sàng lọc tên miền email đáng ngờ trước khi gửi
      let orderReview = null;
      try {
        orderReview = require('./order-review');
      } catch {}

      if (typeof orderReview?.screenNextEmail === 'function') {
        try {
          await orderReview.screenNextEmail(pool, { resolver });
        } catch (e) {
          console.warn('Order email screening error:', e?.message || e);
        }
      }

      // 2. P1-01: Gửi email xác nhận đơn và email tạo mật khẩu khách hàng
      let sentCount = 0;
      while (!stopped && sentCount < 20) {
        const sent = await processOrderEmail(pool, config, mailer);
        if (!sent) break;
        sentCount++;
      }

      // 3. P1-02: Phân loại các đơn có email lỗi/chậm để đưa vào order_reviews
      if (typeof orderReview?.classify === 'function') {
        try {
          await orderReview.classify(pool);
        } catch (e) {
          console.warn('Order review classify error:', e?.message || e);
        }
      }

      // 4. P1-02: Gửi email cảnh báo đơn mới và đơn cần xem xét tới quản trị viên
      if (typeof orderReview?.notifyAdmin === 'function') {
        let adminSentCount = 0;
        while (!stopped && adminSentCount < 10) {
          const sent = await orderReview.notifyAdmin(pool, config, mailer);
          if (!sent) break;
          adminSentCount++;
        }
      }
    } catch (e) {
      console.error('Order email worker loop error:', e);
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  void tick();

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

module.exports = {
  PAYMENT_METHOD_LABELS,
  getPaymentMethodLabel,
  processOrderEmail,
  processOrderEmailOutbox: (pool, config, mailer, opts = {}) => processOrderEmail(pool, config, mailer, { structured: true, ...opts }),
  startOrderEmailWorker
};
