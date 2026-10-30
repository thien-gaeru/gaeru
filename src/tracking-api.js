'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');

// Rate limit: tối đa 10 tra cứu / phút / IP — chống brute-force mã đơn
const trackingLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Bạn tra cứu quá nhiều lần. Vui lòng thử lại sau 1 phút.' }
});

const STATUS_STEPS = [
  { key: 'placed', label: 'Đã đặt hàng', desc: 'Đơn hàng đã được ghi nhận trên hệ thống.' },
  { key: 'confirmed', label: 'Đã xác nhận', desc: 'Đội ngũ GAERU đã xác nhận đơn hàng.' },
  { key: 'processing', label: 'Đang đóng gói', desc: 'Kho hàng đang đóng gói và dán tem vận chuyển.' },
  { key: 'shipped', label: 'Đang vận chuyển', desc: 'Đơn vị vận chuyển (GHN, GHTK, Viettel Post, SPX...) đang phát hàng.' },
  { key: 'completed', label: 'Giao thành công', desc: 'Đơn hàng đã được giao tận tay khách hàng.' }
];

// Chuẩn hóa số điện thoại Việt Nam (0..., +84..., 84...)
function normalizeVietnamPhone(raw) {
  if (!raw) return '';
  let digits = String(raw).trim().replace(/[^\d+]/g, '');
  if (digits.startsWith('+84')) {
    digits = '0' + digits.slice(3);
  } else if (digits.startsWith('84') && digits.length >= 11) {
    digits = '0' + digits.slice(2);
  } else if (digits.startsWith('+')) {
    digits = digits.slice(1);
  }
  return digits;
}

function calculateTimeline(status) {
  let activeIndex = 0;
  if (status === 'confirmed') activeIndex = 1;
  else if (status === 'processing') activeIndex = 2;
  else if (status === 'shipped') activeIndex = 3;
  else if (status === 'completed') activeIndex = 4;
  else if (status === 'cancelled') activeIndex = -1;

  return STATUS_STEPS.map((step, idx) => ({
    ...step,
    completed: activeIndex >= idx,
    current: activeIndex === idx
  }));
}

// ─── P1 FIX: Bảo vệ dữ liệu cá nhân khi tra cứu đơn hàng ────────────────────
// - Bắt buộc cung cấp Mã đơn hàng để tra cứu; không cho phép tra cứu chỉ bằng SĐT một mình
// - Nếu chỉ có mã đơn mà chưa có SĐT: chỉ trả về lộ trình vận chuyển, ẨN toàn bộ sản phẩm và thông tin cá nhân
// - Khi cung cấp cả Mã đơn và SĐT khớp nhau: trả về đầy đủ đơn hàng đã che thông tin nhạy cảm
async function lookupOrderTracking(pool, queryOrOptions, phoneInput) {
  let code = null;
  let phone = null;

  if (typeof queryOrOptions === 'object' && queryOrOptions !== null) {
    code = String(queryOrOptions.code || queryOrOptions.orderCode || queryOrOptions.orderNumber || queryOrOptions.query || '').trim();
    phone = String(queryOrOptions.phone || queryOrOptions.customerPhone || '').trim();
  } else {
    const raw = String(queryOrOptions || '').trim();
    phone = String(phoneInput || '').trim();

    // Cho phép nhập cú pháp "MÃ_ĐƠN SĐT" trong một ô tìm kiếm
    const parts = raw.split(/\s+/);
    if (parts.length >= 2) {
      code = parts[0];
      phone = phone || parts[1];
    } else {
      const isDigitsOnly = /^[+0-9\s-]{9,15}$/.test(raw);
      if (isDigitsOnly && !phone) {
        phone = raw;
      } else {
        code = raw;
      }
    }
  }

  // 1. Chặn tra cứu nếu chỉ có SĐT mà không có mã đơn (bảo vệ quyền riêng tư người mua)
  if (phone && !code) {
    throw Object.assign(
      new Error('Vì lý do bảo mật thông tin đơn hàng, vui lòng cung cấp Mã đơn hàng cùng Số điện thoại để tra cứu.'),
      { status: 400 }
    );
  }

  if (!code) {
    throw Object.assign(new Error('Vui lòng nhập mã đơn hàng để tra cứu.'), { status: 400 });
  }

  // 2. Chuẩn hóa SĐT nếu có
  const normPhone = phone ? normalizeVietnamPhone(phone) : '';

  // 3. Tìm theo order_number hoặc id (UUID)
  const result = await pool.query(
    `SELECT o.id, o.order_number AS "orderCode", o.customer_name AS "customerName", o.phone AS "customerPhone",
            o.address AS "shippingAddress", o.payment_method AS "paymentMethod", o.payment_status AS "paymentStatus",
            o.status, o.total_vnd AS "totalVnd", o.shipping_fee_vnd AS "shippingFeeVnd", o.note AS "notes",
            o.created_at AS "createdAt", o.updated_at AS "updatedAt",
            s.carrier_id AS "carrierId", s.carrier_name AS "carrierName",
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('name', i.product_name, 'variantName', i.variant_name, 'quantity', i.quantity))
              FROM order_items i WHERE i.order_id = o.id
            ), '[]'::jsonb) AS items
     FROM orders o
     LEFT JOIN order_shipping_selection s ON s.order_id = o.id
     WHERE o.order_number = $1 OR o.id::text = $1
     ORDER BY o.created_at DESC
     LIMIT 1`,
    [code]
  );

  if (!result.rows.length) {
    return { found: false, orders: [] };
  }

  const o = result.rows[0];

  // 4. Kiểm tra xác thực quyền sở hữu qua SĐT
  let isPhoneVerified = false;
  if (phone) {
    const oPhoneClean = String(o.customerPhone || '').replace(/[^\d]/g, '');
    const inputPhoneClean = String(phone).replace(/[^\d]/g, '');
    const normOPhone = normalizeVietnamPhone(o.customerPhone);

    if (
      o.customerPhone === phone ||
      normOPhone === normPhone ||
      (oPhoneClean.length >= 9 && inputPhoneClean.endsWith(oPhoneClean.slice(-9))) ||
      (inputPhoneClean.length >= 9 && oPhoneClean.endsWith(inputPhoneClean.slice(-9)))
    ) {
      isPhoneVerified = true;
    } else {
      throw Object.assign(
        new Error('Số điện thoại không khớp với thông tin đơn hàng đã đặt. Vui lòng kiểm tra lại.'),
        { status: 403 }
      );
    }
  }

  const CARRIER_NAMES = {
    ghn: 'Giao Hàng Nhanh (GHN)',
    ghtk: 'Giao Hàng Tiết Kiệm (GHTK)',
    viettel: 'Viettel Post',
    spx: 'Shopee Express (SPX)',
    jt: 'J&T Express'
  };

  const rawItems = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
  const phoneMasked = o.customerPhone ? o.customerPhone.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2') : '';
  const notes = String(o.notes || '');

  let resolvedCarrierId = o.carrierId || null;
  let trackingCode = null;

  const spxMatch = notes.match(/SPX[A-Z0-9]+/i);
  const ghnMatch = notes.match(/GHN[A-Z0-9]+/i);
  const ghtkMatch = notes.match(/GHTK[A-Z0-9]+/i);
  const vtMatch = notes.match(/(?:VTP|VT)[0-9A-Z]{7,15}/i);
  const jtMatch = notes.match(/JT[0-9A-Z]{7,15}/i);

  if (spxMatch) { trackingCode = spxMatch[0]; resolvedCarrierId = resolvedCarrierId || 'spx'; }
  else if (ghnMatch) { trackingCode = ghnMatch[0]; resolvedCarrierId = resolvedCarrierId || 'ghn'; }
  else if (ghtkMatch) { trackingCode = ghtkMatch[0]; resolvedCarrierId = resolvedCarrierId || 'ghtk'; }
  else if (vtMatch) { trackingCode = vtMatch[0]; resolvedCarrierId = resolvedCarrierId || 'viettel'; }
  else if (jtMatch) { trackingCode = jtMatch[0]; resolvedCarrierId = resolvedCarrierId || 'jt'; }
  else {
    const genericMatch = notes.match(/(?:mã vận đơn|tracking|vận đơn)[\s:]*([A-Z0-9_-]+)/i);
    if (genericMatch) trackingCode = genericMatch[1];
  }

  const carrierTitle = o.carrierName || (resolvedCarrierId && CARRIER_NAMES[resolvedCarrierId]) || 'Đơn vị vận chuyển đối tác';

  let trackingUrl = null;
  if (trackingCode) {
    if (resolvedCarrierId === 'ghn' || trackingCode.startsWith('GHN')) trackingUrl = `https://donhang.ghn.vn/?order_code=${encodeURIComponent(trackingCode)}`;
    else if (resolvedCarrierId === 'ghtk' || trackingCode.startsWith('GHTK')) trackingUrl = `https://giaohangtietkiem.vn/tra-cuu-don-hang?tracking=${encodeURIComponent(trackingCode)}`;
    else if (resolvedCarrierId === 'viettel' || trackingCode.startsWith('VT')) trackingUrl = `https://viettelpost.com.vn/tra-cuu-hanh-trinh-don/?order_number=${encodeURIComponent(trackingCode)}`;
    else if (resolvedCarrierId === 'jt' || trackingCode.startsWith('JT')) trackingUrl = `https://jtexpress.vn/vi/tracking?billcode=${encodeURIComponent(trackingCode)}`;
    else trackingUrl = `https://spx.vn/track?${encodeURIComponent(trackingCode)}`;
  } else {
    if (resolvedCarrierId === 'ghn') trackingUrl = 'https://donhang.ghn.vn';
    else if (resolvedCarrierId === 'ghtk') trackingUrl = 'https://giaohangtietkiem.vn';
    else if (resolvedCarrierId === 'viettel') trackingUrl = 'https://viettelpost.com.vn';
    else if (resolvedCarrierId === 'jt') trackingUrl = 'https://jtexpress.vn';
    else trackingUrl = 'https://spx.vn';
  }

  const orderData = {
    id: o.id,
    orderCode: o.orderCode,
    isPhoneVerified,
    customerName: isPhoneVerified ? maskName(o.customerName) : 'Khách hàng GAERU',
    customerPhoneMasked: isPhoneVerified ? phoneMasked : '',
    shippingAddress: isPhoneVerified ? maskAddress(o.shippingAddress) : '',
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    status: o.status,
    totalVnd: o.totalVnd,
    shippingFeeVnd: o.shippingFeeVnd,
    items: isPhoneVerified ? rawItems : [],
    requiresPhoneVerification: !isPhoneVerified,
    message: isPhoneVerified ? null : 'Nhập kèm số điện thoại đặt hàng để xem chi tiết sản phẩm và địa chỉ nhận hàng.',
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    timeline: calculateTimeline(o.status),
    carrier: carrierTitle,
    carrierId: resolvedCarrierId,
    carrierName: carrierTitle,
    trackingCode,
    trackingUrl,
    spxTrackingCode: trackingCode,
    spxTrackingUrl: trackingUrl
  };

  return { found: true, orders: [orderData] };
}

// Che tên: "Nguyễn Văn An" → "Văn A."
function maskName(fullName) {
  if (!fullName) return 'Khách hàng';
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length <= 1) return parts[0].charAt(0) + '***';
  const middle = parts[parts.length - 2] || parts[0];
  const lastInit = (parts[parts.length - 1] || '').charAt(0).toUpperCase();
  return `${middle} ${lastInit}.`;
}

// Che địa chỉ: "123 Đường Lý Thường Kiệt, Quận 10, TP.HCM" → "TP.HCM"
function maskAddress(address) {
  if (!address) return '';
  const parts = String(address).split(',').map(s => s.trim());
  // Chỉ giữ phần cuối (tỉnh/thành)
  return parts[parts.length - 1] || '';
}

function createTrackingRouter(pool) {
  const router = express.Router();

  router.get('/tracking/lookup', trackingLimiter, async (req, res, next) => {
    try {
      const queryParam = req.query.query;
      const codeParam = req.query.code || req.query.orderCode;
      const phoneParam = req.query.phone || req.query.customerPhone;

      const data = await lookupOrderTracking(pool, {
        code: codeParam || queryParam,
        phone: phoneParam
      });
      if (!data.found) {
        return res.status(404).json({ error: 'Không tìm thấy đơn hàng tương ứng với thông tin tra cứu.' });
      }
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  lookupOrderTracking,
  calculateTimeline,
  normalizeVietnamPhone,
  createTrackingRouter
};
