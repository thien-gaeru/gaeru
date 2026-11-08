'use strict';

const express = require('express');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { CARRIER_NAMES } = require('./shipping-adapters');

const ORDER_STATUS_DESCRIPTIONS = Object.freeze({
  pending: 'Chờ xác nhận',
  confirmed: 'Đã xác nhận',
  processing: 'Đang đóng gói & chuẩn bị hàng',
  shipped: 'Đang vận chuyển',
  completed: 'Giao hàng thành công',
  cancelled: 'Đã hủy đơn'
});

const PAYMENT_METHOD_TITLES = Object.freeze({
  cod: 'Thanh toán khi nhận hàng (COD)',
  bank_transfer: 'Chuyển khoản ngân hàng (VietQR)',
  momo: 'Ví điện tử MoMo',
  zalopay: 'Ví điện tử ZaloPay',
  vnpay: 'VNPAY QR / Thẻ nội địa & Quốc tế',
  '9pay': 'Cổng thanh toán 9Pay'
});

/**
 * Mask customer real name while keeping initial and structure.
 * e.g., "Nguyễn Văn An" -> "N*****n V*n A*"
 * e.g., "John Doe" -> "J**n D*e"
 */
function maskName(name) {
  if (!name || typeof name !== 'string') return '';
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.map(w => {
    if (w.length <= 1) return '*';
    if (w.length === 2) return w[0] + '*';
    return w[0] + '*'.repeat(Math.max(1, w.length - 2)) + w[w.length - 1];
  }).join(' ');
}

/**
 * Mask phone number preserving first 3 digits and last 3 digits.
 * e.g., "0912345678" -> "091****678"
 */
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const digits = phone.replace(/[^0-9+]/g, '');
  if (digits.length <= 6) return digits.replace(/.(?=.{2})/g, '*');
  const start = digits.slice(0, 3);
  const end = digits.slice(-3);
  const middleLen = Math.max(3, digits.length - 6);
  return `${start}${'*'.repeat(middleLen)}${end}`;
}

/**
 * Mask email preserving first character and last character before domain.
 * e.g., "customer@gmail.com" -> "c******r@gmail.com"
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '';
  const [local, domain] = email.trim().toLowerCase().split('@');
  if (!domain) return '';
  if (local.length <= 2) {
    return `${local[0] || '*'}*@${domain}`;
  }
  const maskedLocal = local[0] + '*'.repeat(Math.max(2, local.length - 2)) + local[local.length - 1];
  return `${maskedLocal}@${domain}`;
}

/**
 * Mask street/house number in delivery address, keeping ward/district/city recognizable.
 * e.g., "Số 123 Đường Lê Lợi, Phường Bến Nghé, Quận 1" -> "*** Đường Lê Lợi, Phường Bến Nghé, Quận 1"
 */
function maskAddress(address, city) {
  if (!address || typeof address !== 'string') return city || '';
  const parts = address.trim().split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return parts[0].replace(/\d+/g, '***');
  }
  const first = parts[0].replace(/\d+/g, '***').replace(/^(?:Số|Nhà|Tòa|Căn|Phòng|Tầng)?\s*\*{0,3}\s*/i, '').trim();
  parts[0] = '*** ' + (first || '***');
  return parts.join(', ');
}

/**
 * Normalize Vietnamese phone numbers: removes non-digits and translates 84 -> 0.
 */
function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  let digits = phone.replace(/[^0-9]/g, '');
  if (digits.startsWith('84') && digits.length >= 10) {
    digits = '0' + digits.slice(2);
  }
  return digits;
}

/**
 * Verify whether challenge matches the order's phone or email.
 */
function verifyOrderChallenge(order, challenge) {
  if (!order || !challenge) return false;
  const trimmed = String(challenge).trim();
  if (!trimmed) return false;

  // 1. Phone challenge comparison
  const normInputPhone = normalizePhone(trimmed);
  const normOrderPhone = normalizePhone(order.phone);
  if (normInputPhone && normOrderPhone) {
    if (normInputPhone === normOrderPhone) return true;
    if (normInputPhone.length >= 9 && normOrderPhone.length >= 9 && normInputPhone.slice(-9) === normOrderPhone.slice(-9)) {
      return true;
    }
  }

  // 2. Email challenge comparison
  const cleanInputEmail = trimmed.toLowerCase();
  const cleanOrderEmail = String(order.email || '').trim().toLowerCase();
  if (cleanInputEmail && cleanOrderEmail && cleanInputEmail === cleanOrderEmail) {
    return true;
  }

  return false;
}

/**
 * Generate official tracking URL for third-party courier.
 */
function getCarrierTrackingUrl(carrierId, trackingNumber) {
  if (!trackingNumber) return null;
  const encoded = encodeURIComponent(String(trackingNumber).trim());
  switch (carrierId) {
    case 'viettel':
      return `https://viettelpost.vn/tra-cuu-hanh-trinh-don/?orderNumber=${encoded}`;
    case 'jt':
      return `https://jtexpress.vn/vi/tracking?type=track&billcode=${encoded}`;
    case 'spx':
      return `https://spx.vn/track?${encoded}`;
    default:
      return null;
  }
}

/**
 * Build progressive order status timeline for customer UI.
 */
function buildOrderTimeline(order, shipment) {
  if (order.status === 'cancelled') {
    return [
      { step: 'received', title: 'Đã tiếp nhận đơn', description: 'Hệ thống GAERU đã tiếp nhận đơn hàng.', timestamp: order.created_at, status: 'completed' },
      { step: 'cancelled', title: 'Đơn hàng đã hủy', description: order.cancellation_reason ? `Lý do: ${order.cancellation_reason}` : 'Đơn hàng đã được xác nhận hủy.', timestamp: order.updated_at, status: 'cancelled' }
    ];
  }

  const confirmed = ['confirmed', 'processing', 'shipped', 'completed'].includes(order.status);
  const shipping = ['shipped', 'completed'].includes(order.status) ||
    Boolean(shipment && ['picking', 'delivering', 'in_transit', 'out_for_delivery', 'delivered'].includes(shipment.status));
  const delivered = Boolean(order.delivered_at || shipment?.status === 'delivered' || order.status === 'completed');
  const complete = order.status === 'completed';
  const carrierName = shipment?.carrierName || 'đối tác vận chuyển';
  const deliveredAt = shipment?.deliveredAt || order.delivered_at || shipment?.lastSyncedAt || null;

  return [
    {
      step: 'confirmed',
      title: '1. Xác nhận đơn hàng',
      description: confirmed ? 'GAERU đã xác nhận đơn và chuẩn bị giao hàng.' : 'GAERU đã tiếp nhận đơn, đang chờ xác nhận.',
      timestamp: confirmed ? order.updated_at : null,
      status: confirmed ? 'completed' : 'in_progress'
    },
    {
      step: 'shipping',
      title: '2. Giao hàng',
      description: shipping
        ? `Đơn đã bàn giao cho ${carrierName}${shipment?.trackingNumber ? ` (mã vận đơn: ${shipment.trackingNumber})` : ''}.`
        : 'Kiện hàng đang chờ bàn giao vận chuyển.',
      timestamp: shipment?.createdAt || null,
      status: shipping ? 'completed' : (confirmed ? 'in_progress' : 'pending')
    },
    {
      step: 'delivered',
      title: '3. Xác nhận đã giao',
      description: delivered ? 'Đã có xác nhận giao thành công.' : 'Chờ xác nhận người nhận đã nhận hàng.',
      timestamp: delivered ? deliveredAt : null,
      status: delivered ? 'completed' : (shipping ? 'in_progress' : 'pending')
    },
    {
      step: 'completed',
      title: '4. Tự động hoàn thành',
      description: complete
        ? (order.payment_method === 'cod' && order.payment_status !== 'paid'
          ? 'Đơn đã hoàn tất giao hàng. Tiền thu hộ COD đang được đối soát riêng.'
          : 'Đơn đã tự động hoàn thành sau khi giao thành công.')
        : 'Hệ thống tự hoàn thành khi xác nhận giao thành công.',
      timestamp: complete ? (order.delivered_at || order.updated_at) : null,
      status: complete ? 'completed' : 'pending'
    }
  ];
}

/**
 * Core query function with authentication challenge and PII masking.
 */
async function getOrderTrackingDetails(pool, { orderNumber, challenge }) {
  if (!orderNumber || !challenge) {
    return {
      found: false,
      error: 'Vui lòng cung cấp mã đơn hàng và thông tin xác thực (Số điện thoại hoặc Email).'
    };
  }

  const cleanOrderNumber = String(orderNumber).trim();
  const cleanChallenge = String(challenge).trim();

  // 1. Query order
  const orderResult = await pool.query(
    `SELECT id, order_number, customer_name, email, phone, address, city,
            payment_method, payment_status, status, subtotal_vnd,
            shipping_fee_vnd, discount_vnd, voucher_code, total_vnd,
            cancellation_reason, created_at, updated_at, delivered_at, return_completed_at
     FROM orders
     WHERE UPPER(TRIM(order_number)) = UPPER(TRIM($1))
     LIMIT 1`,
    [cleanOrderNumber]
  );

  const order = orderResult.rows[0];

  // Uniform security error: prevent order number probing or phone scraping
  if (!order || !verifyOrderChallenge(order, cleanChallenge)) {
    return {
      found: false,
      error: 'Không tìm thấy đơn hàng hoặc thông tin xác thực (Số điện thoại / Email) không khớp. Vui lòng kiểm tra lại.'
    };
  }

  // 2. Query items
  const itemsResult = await pool.query(
    `SELECT oi.id, oi.product_name, oi.variant_name, oi.sku, oi.quantity, oi.unit_price_vnd, oi.line_total_vnd,
            COALESCE(p.image_url, '') AS image_url,
            COALESCE(p.slug, '') AS slug
     FROM order_items oi
     LEFT JOIN product_variants pv ON pv.id = oi.variant_id
     LEFT JOIN products p ON p.id = pv.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.id ASC`,
    [order.id]
  );

  // 3. Query shipment
  const shipmentResult = await pool.query(
    `SELECT carrier_id, tracking_number, status, carrier_status_desc,
            tracking_history, label_url, created_at, last_synced_at, delivered_at
     FROM carrier_shipments
     WHERE order_id = $1 AND status != 'cancelled'
     ORDER BY created_at DESC
     LIMIT 1`,
    [order.id]
  );

  const shipmentRow = shipmentResult.rows[0];
  let shipment = null;

  const activeCase = (await pool.query(
    "SELECT * FROM order_after_sales WHERE order_id = $1 AND status NOT IN ('resolved', 'rejected') ORDER BY created_at DESC LIMIT 1",
    [order.id]
  )).rows[0];

  const completedCase = (await pool.query(
    "SELECT id FROM order_after_sales WHERE order_id = $1 AND kind = 'return' AND status = 'resolved' LIMIT 1",
    [order.id]
  )).rows[0];

  const { checkReturnEligibility, createCustomerReturnRequest } = require('./order-after-sales');
  const returnEligibility = checkReturnEligibility(order, activeCase, completedCase, shipmentRow);
  if (shipmentRow) {
    const carrierName = CARRIER_NAMES[shipmentRow.carrier_id] || shipmentRow.carrier_id;
    shipment = {
      carrierId: shipmentRow.carrier_id,
      carrierName,
      trackingNumber: shipmentRow.tracking_number,
      status: shipmentRow.status,
      statusDescription: shipmentRow.carrier_status_desc,
      trackingUrl: getCarrierTrackingUrl(shipmentRow.carrier_id, shipmentRow.tracking_number),
      history: Array.isArray(shipmentRow.tracking_history) ? shipmentRow.tracking_history : [],
      lastSyncedAt: shipmentRow.last_synced_at,
      deliveredAt: shipmentRow.delivered_at,
      createdAt: shipmentRow.created_at
    };
  }

  const timeline = buildOrderTimeline(order, shipment);

  return {
    found: true,
    order: {
      orderNumber: order.order_number,
      status: order.status,
      statusDescription: ORDER_STATUS_DESCRIPTIONS[order.status] || order.status,
      paymentMethod: order.payment_method,
      paymentMethodTitle: PAYMENT_METHOD_TITLES[order.payment_method] || order.payment_method,
      paymentStatus: order.payment_status,
      paymentStatusTitle: order.payment_status === 'paid' ? 'Đã thanh toán' : 'Chờ thanh toán',
      customer: {
        name: maskName(order.customer_name),
        phone: maskPhone(order.phone),
        email: maskEmail(order.email),
        address: maskAddress(order.address, order.city),
        city: order.city
      },
      summary: {
        subtotalVnd: order.subtotal_vnd,
        discountVnd: order.discount_vnd || 0,
        voucherCode: order.voucher_code || '',
        shippingFeeVnd: order.shipping_fee_vnd || 0,
        totalVnd: order.total_vnd
      },
      items: itemsResult.rows.map(item => ({
        id: item.id,
        productName: item.product_name,
        variantName: item.variant_name,
        sku: item.sku,
        quantity: item.quantity,
        unitPriceVnd: item.unit_price_vnd,
        lineTotalVnd: item.line_total_vnd,
        imageUrl: item.image_url,
        slug: item.slug
      })),
      shipment,
      timeline,
      cancellationReason: order.cancellation_reason || null,
      afterSales: activeCase ? {
        id: activeCase.id,
        status: activeCase.status,
        kind: activeCase.kind,
        returnType: activeCase.return_type || 'exchange',
        reason: activeCase.reason,
        resolution: activeCase.resolution || '',
        createdAt: activeCase.created_at
      } : null,
      returnEligibility,
      createdAt: order.created_at,
      updatedAt: order.updated_at
    }
  };
}

/**
 * Express Router factory for public order tracking API.
 */
function createTrackingApi(pool, _config = {}) {
  const router = express.Router();

  const lookupLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Bạn đã tra cứu quá nhiều lần. Vui lòng thử lại sau 1 phút.' }
  });

  const lookupSchema = z.object({
    orderNumber: z.string().trim().min(3, 'Mã đơn hàng phải từ 3 ký tự trở lên.').max(64, 'Mã đơn hàng không được quá 64 ký tự.'),
    challenge: z.string().trim().min(3, 'Thông tin xác thực (Số điện thoại hoặc Email) không hợp lệ.').max(255)
  });

  async function handleLookup(req, res, next) {
    try {
      const data = req.method === 'POST' ? req.body : req.query;
      const parsed = lookupSchema.safeParse(data);
      if (!parsed.success) {
        return res.status(400).json({
          error: parsed.error.issues[0]?.message || 'Dữ liệu tra cứu chưa hợp lệ.'
        });
      }

      const result = await getOrderTrackingDetails(pool, parsed.data);
      if (!result.found) {
        return res.status(404).json({ error: result.error });
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  router.post('/tracking/lookup', lookupLimiter, handleLookup);
  router.get('/tracking/lookup', lookupLimiter, handleLookup);

  const returnSchema = z.object({
    orderNumber: z.string().trim().min(3).max(64),
    challenge: z.string().trim().min(3).max(255),
    returnType: z.enum(['exchange', 'refund']).default('exchange'),
    reasonCategory: z.enum(['faulty', 'wrong_item', 'damaged', 'change_mind', 'other']).default('faulty'),
    reason: z.string().trim().min(5).max(2000),
    bankInfo: z.object({
      bankName: z.string().trim().max(100).optional(),
      accountNumber: z.string().trim().max(50).optional(),
      accountHolder: z.string().trim().max(100).optional()
    }).optional().default({}),
    evidenceUrls: z.array(z.string().trim().max(500)).max(5).optional().default([])
  });

  router.post('/tracking/return-request', lookupLimiter, async (req, res, next) => {
    const parsed = returnSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Thông tin yêu cầu chưa hợp lệ.' });
    }
    try {
      const orderRes = await pool.query(
        'SELECT * FROM orders WHERE UPPER(TRIM(order_number)) = UPPER(TRIM($1)) LIMIT 1',
        [parsed.data.orderNumber]
      );
      const order = orderRes.rows[0];
      if (!order || !verifyOrderChallenge(order, parsed.data.challenge)) {
        return res.status(404).json({ error: 'Không tìm thấy đơn hàng hoặc thông tin xác thực không khớp.' });
      }

      const { createCustomerReturnRequest } = require('./order-after-sales');
      const { withTransaction } = require('./db');
      const result = await withTransaction(pool, async (client) => {
        return await createCustomerReturnRequest(client, {
          orderId: order.id,
          requestedBy: 'guest',
          returnType: parsed.data.returnType,
          reasonCategory: parsed.data.reasonCategory,
          reason: parsed.data.reason,
          bankInfo: parsed.data.bankInfo,
          evidenceUrls: parsed.data.evidenceUrls,
          actor: { username: order.email || 'guest', source: 'guest' }
        });
      });

      res.status(201).json({
        ok: true,
        case: result,
        message: 'Đã gửi yêu cầu đổi/trả hàng thành công. Bộ phận CSKH GAERU sẽ liên hệ hỗ trợ trong vòng 24 giờ.'
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  return router;
}

module.exports = {
  createTrackingApi,
  getOrderTrackingDetails,
  verifyOrderChallenge,
  maskName,
  maskPhone,
  maskEmail,
  maskAddress,
  normalizePhone,
  getCarrierTrackingUrl,
  buildOrderTimeline,
  ORDER_STATUS_DESCRIPTIONS,
  PAYMENT_METHOD_TITLES
};
