'use strict';

/**
 * OrderOwnership & Idempotency Policy + PaymentAttemptStateMachine
 * 
 * Đơn vị thẩm quyền duy nhất (Single Source of Truth) cho:
 * 1. Phạm vi khóa chống trùng theo định danh người mua (Customer-Scoped Idempotency).
 * 2. Xác minh quyền sở hữu đơn hàng (Order Ownership Verification).
 * 3. Kiểm tra tính nhất quán giỏ hàng / số tiền / phương thức khi nhận cùng khóa idempotency.
 * 4. Máy trạng thái phiên thanh toán (PaymentAttemptStateMachine) với nguyên tắc bất biến trạng thái paid.
 */

const { createHash, createHmac, timingSafeEqual } = require('node:crypto');

const ATTEMPT_STATES = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  UNKNOWN: 'payment_initiation_unknown',
  AWAITING_RECONCILIATION: 'awaiting_reconciliation',
  EXPIRY_AWAITING_VERIFICATION: 'expiry_awaiting_verification'
});

const TERMINAL_ATTEMPT_STATES = Object.freeze([
  ATTEMPT_STATES.PAID,
  ATTEMPT_STATES.CANCELLED
]);

/**
 * Chuẩn hóa số điện thoại Việt Nam về định dạng chữ số thuần túy
 */
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('0084') && digits.length >= 12) {
    return '0' + digits.slice(4);
  }
  if (digits.startsWith('84') && digits.length >= 11) {
    return '0' + digits.slice(2);
  }
  return digits;
}

/**
 * Chuẩn hóa email
 */
function normalizeEmail(raw) {
  return String(raw || '').toLowerCase().trim();
}

/**
 * Tính toán phạm vi khách hàng (customerScope) bằng mã băm SHA-256 từ email và số điện thoại
 * @param {string} email
 * @param {string} phone
 * @returns {string} 16 ký tự hex đầu tiên
 */
function computeCustomerScope(email, phone) {
  const normEmail = normalizeEmail(email);
  const normPhone = normalizePhone(phone);
  if (!normEmail && !normPhone) return 'anon';
  return createHash('sha256').update(`${normEmail}:${normPhone}`).digest('hex').slice(0, 16);
}

/**
 * Xây dựng mã client_reference được gắn phạm vi người mua
 * @param {string} rawKey Khóa idempotency nguyên bản do client gửi
 * @param {Object} customer { email, phone }
 * @returns {string|null}
 */
function buildScopedClientReference(rawKey, customer = {}) {
  if (!rawKey || typeof rawKey !== 'string') return null;
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  const scope = computeCustomerScope(customer.email, customer.phone);
  return `idem:${scope}:${trimmed}`;
}

/**
 * Tách và đọc thông tin từ scoped client reference
 * @param {string} scopedRef
 * @returns {{ isScoped: boolean, scope: string|null, rawKey: string }}
 */
function parseScopedClientReference(scopedRef) {
  if (!scopedRef || typeof scopedRef !== 'string') {
    return { isScoped: false, scope: null, rawKey: '' };
  }
  const match = /^idem:([a-f0-9]{16}|anon):(.+)$/.exec(scopedRef);
  if (match) {
    return { isScoped: true, scope: match[1], rawKey: match[2] };
  }
  return { isScoped: false, scope: null, rawKey: scopedRef };
}

const DEFAULT_ORDER_TOKEN_SECRET = 'gaeru-order-token-default-secret-key-32b';

/**
 * Tạo token truy cập đơn hàng có chữ ký số HMAC-SHA256 và thời hạn sử dụng
 * @param {Object} payload { orderId, orderNumber, customerId }
 * @param {string} [secret]
 * @param {Object} [options]
 * @returns {string} Token dạng base64url(payload).hmac_signature
 */
function generateOrderAccessToken(payload = {}, secret = null, options = {}) {
  const sec = secret || process.env.SESSION_SECRET || DEFAULT_ORDER_TOKEN_SECRET;
  const expiresInSeconds = options.expiresInSeconds || (72 * 3600); // 72 giờ
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const body = {
    orderId: payload.orderId || null,
    orderNumber: payload.orderNumber || null,
    customerId: payload.customerId || null,
    exp
  };
  const bodyStr = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = createHmac('sha256', sec).update(bodyStr, 'utf8').digest('hex');
  return `${bodyStr}.${sig}`;
}

/**
 * Xác thực token truy cập đơn hàng
 * @param {string} token
 * @param {string} [secret]
 * @param {string} [expectedOrderIdentifier] orderNumber hoặc orderId
 * @returns {Object|null} Payload nếu hợp lệ, null nếu không hợp lệ hoặc hết hạn
 */
function verifyOrderAccessToken(token, secret = null, expectedOrderIdentifier = null) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [bodyStr, sig] = parts;
  const sec = secret || process.env.SESSION_SECRET || DEFAULT_ORDER_TOKEN_SECRET;

  const expectedSig = createHmac('sha256', sec).update(bodyStr, 'utf8').digest('hex');
  if (sig.length !== expectedSig.length) return null;
  const sigValid = timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expectedSig, 'utf8'));
  if (!sigValid) return null;

  try {
    const payload = JSON.parse(Buffer.from(bodyStr, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;

    const nowSec = Math.floor(Date.now() / 1000);
    if (!payload.exp || Number(payload.exp) < nowSec) {
      return null;
    }

    if (expectedOrderIdentifier) {
      const cleanExpected = String(expectedOrderIdentifier).trim().toUpperCase();
      const numMatch = payload.orderNumber && String(payload.orderNumber).trim().toUpperCase() === cleanExpected;
      const idMatch = payload.orderId && String(payload.orderId).trim().toLowerCase() === String(expectedOrderIdentifier).trim().toLowerCase();
      if (!numMatch && !idMatch) {
        return null;
      }
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Xác minh quyền sở hữu đơn hàng (Fail-Closed)
 * @param {Object} order { customerEmail, customerPhone, email, phone, customerId, customer_id, orderNumber, id }
 * @param {Object|string} proof { orderAccessToken, sessionCustomerId, sessionCustomerEmail, sessionCustomerPhone, sessionCreatedOrders, expectedCustomer }
 * @param {Object} [options] { secret, actor, requireStrongProof }
 * @throws {Error} 403 FORBIDDEN_ORDER_ACCESS nếu không xác minh được quyền sở hữu
 * @returns {boolean}
 */
function assertOrderOwnership(order, proof, options = {}) {
  const actor = options.actor || proof?.actor;
  if (actor && (
    ['admin', 'owner'].includes(actor.role) ||
    ['system', 'order_expiration_worker', 'reconciliation-worker', 'gateway_callback'].includes(actor.source) ||
    proof?.gatewaySignatureVerified === true
  )) {
    return true;
  }

  // 1. Kiểm tra mã truy cập đơn hàng (Order Access Token)
  const token = typeof proof === 'string'
    ? proof
    : (proof?.orderAccessToken || proof?.token || null);
  if (token) {
    const verified = verifyOrderAccessToken(token, options.secret, order.orderNumber || order.id);
    if (verified) return true;
    throw Object.assign(
      new Error('Mã truy cập đơn hàng (order access token) không hợp lệ hoặc đã hết hạn.'),
      { status: 403, code: 'FORBIDDEN_ORDER_ACCESS' }
    );
  }

  // 2. Kiểm tra tài khoản khách hàng đã đăng nhập (Customer Session)
  const sessionCustId = proof?.sessionCustomerId || proof?.customerId;
  const orderCustId = order.customerId || order.customer_id;
  if (sessionCustId && orderCustId && String(sessionCustId) === String(orderCustId)) {
    return true;
  }

  const sessionCustEmail = normalizeEmail(proof?.sessionCustomerEmail);
  const orderEmail = normalizeEmail(order.customerEmail || order.email);
  if (sessionCustEmail && orderEmail && sessionCustEmail === orderEmail) {
    return true;
  }

  // 3. Kiểm tra phiên trình duyệt đã tạo đơn hàng này (Session-bound created orders)
  const createdOrders = proof?.sessionCreatedOrders;
  if (Array.isArray(createdOrders) && order.orderNumber && createdOrders.includes(order.orderNumber)) {
    return true;
  }

  // 4. Đối soát thông tin người mua (expectedCustomer / email & phone)
  const expectedCustomer = proof?.expectedCustomer || (proof && (proof.email || proof.phone) ? proof : null);
  if (expectedCustomer) {
    const expectedEmail = normalizeEmail(expectedCustomer.email);
    const expectedPhone = normalizePhone(expectedCustomer.phone);
    const orderPhone = normalizePhone(order.customerPhone || order.phone);

    // Khi cung cấp cả email và phone, bắt buộc CẢ HAI phải khớp
    if (expectedEmail && expectedPhone) {
      const emailOk = orderEmail && expectedEmail === orderEmail;
      const phoneOk = orderPhone && expectedPhone === orderPhone;
      if (!emailOk || !phoneOk) {
        throw Object.assign(
          new Error('Đơn hàng không thuộc sở hữu của thông tin người mua hiện tại (email hoặc số điện thoại không khớp).'),
          { status: 403, code: 'FORBIDDEN_ORDER_ACCESS' }
        );
      }
      return true;
    }

    // Nếu trong chế độ yêu cầu bằng chứng mạnh (như retry-payment) mà chỉ gửi 1 trong 2 -> không đủ
    if (options.requireStrongProof) {
      throw Object.assign(
        new Error('Yêu cầu xác minh quyền sở hữu đơn hàng (đăng nhập tài khoản đặt đơn hoặc cung cấp mã truy cập đơn hàng hợp lệ).'),
        { status: 403, code: 'FORBIDDEN_ORDER_ACCESS' }
      );
    }

    if (expectedEmail) {
      if (!orderEmail || expectedEmail !== orderEmail) {
        throw Object.assign(
          new Error('Đơn hàng không thuộc sở hữu của thông tin người mua hiện tại (email không khớp).'),
          { status: 403, code: 'FORBIDDEN_ORDER_ACCESS' }
        );
      }
      return true;
    }

    if (expectedPhone) {
      if (!orderPhone || expectedPhone !== orderPhone) {
        throw Object.assign(
          new Error('Đơn hàng không thuộc sở hữu của thông tin người mua hiện tại (số điện thoại không khớp).'),
          { status: 403, code: 'FORBIDDEN_ORDER_ACCESS' }
        );
      }
      return true;
    }
  }

  // FAIL CLOSED: Không có bằng chứng sở hữu -> Chặn 403
  throw Object.assign(
    new Error('Yêu cầu xác minh quyền sở hữu đơn hàng (đăng nhập tài khoản đặt đơn hoặc cung cấp mã truy cập đơn hàng hợp lệ).'),
    { status: 403, code: 'FORBIDDEN_ORDER_ACCESS' }
  );
}

/**
 * Kiểm tra xem caller có quyền sở hữu đơn hàng không mà không ném lỗi
 */
function checkOrderOwnership(order, proof, options = {}) {
  try {
    return assertOrderOwnership(order, proof, options);
  } catch {
    return false;
  }
}

/**
 * Kiểm tra tính nhất quán của giỏ hàng / số tiền / phương thức thanh toán đối với đơn cũ có cùng khóa chống trùng
 * @param {Object} order Đơn hàng đã tìm thấy từ DB
 * @param {Array<Object>} dbItems Danh sách sản phẩm của đơn trong DB
 * @param {Object} expectations { expectedPaymentMethod, expectedTotalVnd, expectedItems }
 * @throws {Error} 409 nếu phát hiện xung đột dữ liệu
 */
/**
 * Chuẩn hóa toàn bộ payload đặt hàng / đơn hàng thành một cấu trúc đồng nhất
 * Dùng để tạo fingerprint bất biến (checkout_payload_hash) và đối soát idempotency
 * @param {Object} payload 
 * @returns {Object} Canonical normalized payload
 */
function normalizeCheckoutPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') {
    return {
      customer: { name: '', email: '', phone: '', address: '', city: '' },
      items: [],
      paymentMethod: '',
      shipping: { carrierId: null, feeVnd: null },
      voucherCode: null,
      quote: { quoteHash: null, pricingVersion: null, subtotalVnd: null, totalVnd: null }
    };
  }

  // 1. Thông tin người mua & địa chỉ
  const customer = payload.customer || {};
  const normName = String(customer.name || payload.customerName || payload.customer_name || '').trim();
  const normEmail = normalizeEmail(customer.email || payload.customerEmail || payload.email);
  const normPhone = normalizePhone(customer.phone || payload.customerPhone || payload.phone);
  const normAddress = String(customer.address || payload.address || '').trim().replace(/\s+/g, ' ');
  const normCity = String(customer.city || payload.city || '').trim().toLowerCase();

  // 2. Danh sách sản phẩm (gộp số lượng theo variantId, sắp xếp theo variantId)
  const itemsMap = new Map();
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  for (const it of rawItems) {
    if (!it) continue;
    const vid = String(it.variantId || it.variant_id || '').trim().toLowerCase();
    if (!vid) continue;
    const qty = Number(it.quantity) || 0;
    if (qty > 0) {
      itemsMap.set(vid, (itemsMap.get(vid) || 0) + qty);
    }
  }
  const sortedItems = [...itemsMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([variantId, quantity]) => ({ variantId, quantity }));

  // 3. Phương thức thanh toán
  const paymentMethod = String(payload.paymentMethod || payload.payment_method || '').trim().toLowerCase();

  // 4. Cấu hình vận chuyển & phí
  const carrierId = payload.shippingCarrierId || payload.shipping_carrier_id || payload.shippingCarrierName || payload.carrierId || null;
  const rawFee = payload.expectedShippingFeeVnd ?? payload.shippingFeeVnd ?? payload.shipping_fee_vnd ?? null;
  const shippingFeeVnd = rawFee !== null && rawFee !== undefined ? Number(rawFee) : null;

  // 5. Mã giảm giá (Voucher)
  const rawVoucher = payload.voucherCode || payload.voucher_code || null;
  const voucherCode = rawVoucher ? String(rawVoucher).trim().toUpperCase() : null;

  // 6. Báo giá & Quote version
  const quoteHash = payload.expectedQuoteHash || payload.quoteHash || payload.quote_hash || null;
  const pricingVersion = payload.pricingVersion || payload.pricing_version || null;
  const rawSubtotal = payload.expectedSubtotalVnd ?? payload.subtotalVnd ?? payload.subtotal_vnd ?? null;
  const subtotalVnd = rawSubtotal !== null && rawSubtotal !== undefined ? Number(rawSubtotal) : null;
  const rawTotal = payload.expectedTotalVnd ?? payload.totalVnd ?? payload.total_vnd ?? null;
  const totalVnd = rawTotal !== null && rawTotal !== undefined ? Number(rawTotal) : null;

  return {
    customer: {
      name: normName,
      email: normEmail,
      phone: normPhone,
      address: normAddress,
      city: normCity
    },
    items: sortedItems,
    paymentMethod,
    shipping: {
      carrierId: carrierId ? String(carrierId).trim().toLowerCase() : null,
      feeVnd: shippingFeeVnd
    },
    voucherCode: voucherCode || null,
    quote: {
      quoteHash: quoteHash ? String(quoteHash).trim() : null,
      pricingVersion: pricingVersion !== null ? Number(pricingVersion) : null,
      subtotalVnd,
      totalVnd
    }
  };
}

/**
 * Tính toán mã hash SHA-256 bất biến của checkout payload (checkout_payload_hash)
 * @param {Object} payload
 * @returns {string} 64 ký tự hex
 */
function computeCheckoutPayloadHash(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const canonical = normalizeCheckoutPayload(payload);
  const jsonStr = JSON.stringify(canonical);
  return createHash('sha256').update(jsonStr, 'utf8').digest('hex');
}

/**
 * Kiểm tra tính nhất quán toàn diện của đơn hàng khi tái sử dụng khóa idempotency
 * Đối chiếu: checkout_payload_hash, phương thức thanh toán, tổng tiền, giỏ hàng,
 * địa chỉ, phí vận chuyển, voucher, cấu hình vận chuyển, thông tin người mua và quote version.
 * @param {Object} order Đơn hàng đã tìm thấy từ DB
 * @param {Array<Object>} dbItems Danh sách sản phẩm của đơn trong DB
 * @param {Object} expectations { expectedPaymentMethod, expectedTotalVnd, expectedItems, expectedCustomer, expectedShippingCarrierId, expectedShippingFeeVnd, expectedVoucherCode, expectedQuoteHash, checkoutPayload, checkoutPayloadHash }
 * @throws {Error} 409 nếu phát hiện xung đột dữ liệu
 */
function assertOrderPayloadMatch(order, dbItems = [], expectations = {}) {
  const {
    expectedPaymentMethod,
    expectedTotalVnd,
    expectedItems,
    expectedCustomer,
    expectedShippingCarrierId,
    expectedShippingFeeVnd,
    expectedVoucherCode,
    expectedQuoteHash,
    checkoutPayload,
    checkoutPayloadHash
  } = expectations;

  // 1. Nếu có checkoutPayload hoặc checkoutPayloadHash, so khớp fingerprint bất biến (checkout_payload_hash)
  const incomingHash = checkoutPayloadHash || (checkoutPayload ? computeCheckoutPayloadHash(checkoutPayload) : null);
  const storedHash = order.checkoutPayloadHash || order.checkout_payload_hash || null;

  if (incomingHash && storedHash && incomingHash === storedHash) {
    return true; // Khớp 100% toàn bộ payload
  }

  // 2. Phương thức thanh toán
  const currentMethod = order.paymentMethod || order.payment_method;
  const expMethod = expectedPaymentMethod || (checkoutPayload ? checkoutPayload.paymentMethod : null);
  if (expMethod && currentMethod && currentMethod.toLowerCase() !== expMethod.toLowerCase()) {
    throw Object.assign(
      new Error(`Phương thức thanh toán (${expMethod}) không khớp với đơn hàng trước đó (${currentMethod}).`),
      { status: 409, code: 'IDEMPOTENCY_PAYMENT_METHOD_MISMATCH' }
    );
  }

  // 3. Tổng số tiền thanh toán
  const currentTotal = order.totalVnd !== undefined ? order.totalVnd : order.total_vnd;
  const expTotal = expectedTotalVnd ?? (checkoutPayload ? checkoutPayload.expectedTotalVnd : null);
  if (expTotal !== null && expTotal !== undefined && currentTotal !== undefined && currentTotal !== null) {
    if (Math.abs(Number(currentTotal) - Number(expTotal)) > 0) {
      throw Object.assign(
        new Error('Khóa chống trùng đã được sử dụng cho một đơn hàng có tổng số tiền khác.'),
        { status: 409, code: 'IDEMPOTENCY_AMOUNT_MISMATCH' }
      );
    }
  }

  // 4. Danh sách sản phẩm: gộp theo variantId ở cả hai phía trước khi so khớp
  const expItems = expectedItems || (checkoutPayload ? checkoutPayload.items : null);
  if (expItems && Array.isArray(expItems) && expItems.length > 0) {
    const itemsList = Array.isArray(dbItems) && dbItems.length > 0 ? dbItems : (order.items || []);

    const aggregateItems = (items) => {
      const map = new Map();
      for (const it of items) {
        if (!it) continue;
        const vid = String(it.variantId || it.variant_id || '').trim().toLowerCase();
        if (!vid) continue;
        const qty = Number(it.quantity) || 0;
        map.set(vid, (map.get(vid) || 0) + qty);
      }
      return map;
    };

    const expectedMap = aggregateItems(expItems);
    const dbMap = aggregateItems(itemsList);

    let itemsMismatch = expectedMap.size !== dbMap.size;
    if (!itemsMismatch) {
      for (const [vid, qty] of expectedMap.entries()) {
        if (dbMap.get(vid) !== qty) {
          itemsMismatch = true;
          break;
        }
      }
    }

    if (itemsMismatch) {
      throw Object.assign(
        new Error('Khóa chống trùng đã được sử dụng cho một đơn hàng có danh sách sản phẩm khác.'),
        { status: 409, code: 'IDEMPOTENCY_ITEMS_MISMATCH' }
      );
    }
  }

  // 5. Thông tin người nhận & Địa chỉ giao hàng
  const expCust = expectedCustomer || (checkoutPayload ? checkoutPayload.customer : null);
  if (expCust && typeof expCust === 'object') {
    // Địa chỉ (address)
    if (expCust.address !== undefined && expCust.address !== null) {
      const normExpAddr = String(expCust.address).trim().replace(/\s+/g, ' ');
      const normDbAddr = String(order.address || '').trim().replace(/\s+/g, ' ');
      if (normExpAddr && normDbAddr && normExpAddr !== normDbAddr) {
        throw Object.assign(
          new Error('Khóa chống trùng đã được sử dụng cho một đơn hàng có địa chỉ giao hàng khác.'),
          { status: 409, code: 'IDEMPOTENCY_ADDRESS_MISMATCH' }
        );
      }
    }

    // Tỉnh / Thành phố (city)
    if (expCust.city !== undefined && expCust.city !== null) {
      const normExpCity = String(expCust.city).trim().toLowerCase();
      const normDbCity = String(order.city || '').trim().toLowerCase();
      if (normExpCity && normDbCity && normExpCity !== normDbCity) {
        throw Object.assign(
          new Error('Khóa chống trùng đã được sử dụng cho một đơn hàng có tỉnh/thành phố giao hàng khác.'),
          { status: 409, code: 'IDEMPOTENCY_CITY_MISMATCH' }
        );
      }
    }

    // Tên người nhận (name)
    if (expCust.name !== undefined && expCust.name !== null) {
      const normExpName = String(expCust.name).trim();
      const normDbName = String(order.customerName || order.customer_name || '').trim();
      if (normExpName && normDbName && normExpName !== normDbName) {
        throw Object.assign(
          new Error('Khóa chống trùng đã được sử dụng cho một đơn hàng có tên người nhận khác.'),
          { status: 409, code: 'IDEMPOTENCY_CUSTOMER_MISMATCH' }
        );
      }
    }
  }

  // 6. Cấu hình vận chuyển & phí
  const expCarrier = expectedShippingCarrierId || (checkoutPayload ? checkoutPayload.shippingCarrierId : null);
  const dbCarrier = order.shippingCarrierId || order.carrier_id || null;
  if (expCarrier && dbCarrier && String(expCarrier).trim().toLowerCase() !== String(dbCarrier).trim().toLowerCase()) {
    throw Object.assign(
      new Error('Khóa chống trùng đã được sử dụng cho một đơn hàng có cấu hình đối tác vận chuyển khác.'),
      { status: 409, code: 'IDEMPOTENCY_SHIPPING_MISMATCH' }
    );
  }

  const expFee = expectedShippingFeeVnd ?? (checkoutPayload ? checkoutPayload.expectedShippingFeeVnd : null);
  const dbFee = order.shippingFeeVnd !== undefined ? order.shippingFeeVnd : order.shipping_fee_vnd;
  if (expFee !== null && expFee !== undefined && dbFee !== null && dbFee !== undefined) {
    if (Math.abs(Number(dbFee) - Number(expFee)) > 0) {
      throw Object.assign(
        new Error('Khóa chống trùng đã được sử dụng cho một đơn hàng có phí vận chuyển khác.'),
        { status: 409, code: 'IDEMPOTENCY_SHIPPING_FEE_MISMATCH' }
      );
    }
  }

  // 7. Mã giảm giá (Voucher)
  const expVoucher = expectedVoucherCode !== undefined ? expectedVoucherCode : (checkoutPayload ? checkoutPayload.voucherCode : undefined);
  if (expVoucher !== undefined) {
    const cleanExpVoucher = String(expVoucher || '').trim().toUpperCase();
    const cleanDbVoucher = String(order.voucherCode || order.voucher_code || '').trim().toUpperCase();
    if (cleanExpVoucher !== cleanDbVoucher) {
      throw Object.assign(
        new Error('Khóa chống trùng đã được sử dụng cho một đơn hàng có mã giảm giá (voucher) khác.'),
        { status: 409, code: 'IDEMPOTENCY_VOUCHER_MISMATCH' }
      );
    }
  }

  // 8. Báo giá & Quote version / Quote hash
  const expQuote = expectedQuoteHash !== undefined ? expectedQuoteHash : (checkoutPayload ? checkoutPayload.expectedQuoteHash : undefined);
  if (expQuote) {
    const cleanExpQuote = String(expQuote).trim();
    const cleanDbQuote = String(order.quoteHash || order.quote_hash || '').trim();
    if (cleanDbQuote && cleanExpQuote !== cleanDbQuote) {
      throw Object.assign(
        new Error('Khóa chống trùng đã được sử dụng cho một đơn hàng có phiên bản báo giá (quote version) khác.'),
        { status: 409, code: 'IDEMPOTENCY_QUOTE_MISMATCH' }
      );
    }
  }

  // 9. Nếu truyền checkoutPayload nhưng storedHash và incomingHash không khớp nhau
  if (incomingHash && storedHash && incomingHash !== storedHash) {
    throw Object.assign(
      new Error('Khóa chống trùng đã được sử dụng cho một đơn hàng có nội dung (payload) khác biệt.'),
      { status: 409, code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' }
    );
  }

  return true;
}

class PaymentAttemptStateMachine {
  static get STATES() {
    return ATTEMPT_STATES;
  }

  static isTerminal(status) {
    return TERMINAL_ATTEMPT_STATES.includes(String(status || '').toLowerCase());
  }

  /**
   * Kiểm tra chuyển trạng thái phiên thanh toán có hợp lệ không
   * @param {string} currentStatus
   * @param {string} targetStatus
   * @returns {boolean}
   */
  static isValidTransition(currentStatus, targetStatus) {
    const from = String(currentStatus || '').toLowerCase();
    const to = String(targetStatus || '').toLowerCase();

    if (from === to) return true;

    // Trạng thái PAID là bất biến tuyệt đối (immutable), không bao giờ được phép đổi sang trạng thái khác
    if (from === ATTEMPT_STATES.PAID) {
      return false;
    }

    switch (to) {
      case ATTEMPT_STATES.PAID:
        // Có thể hoàn tất từ bất kỳ trạng thái nào chưa paid, kể cả cancelled (late settlement từ cổng thanh toán)
        return [
          ATTEMPT_STATES.PENDING,
          ATTEMPT_STATES.FAILED,
          ATTEMPT_STATES.UNKNOWN,
          ATTEMPT_STATES.AWAITING_RECONCILIATION,
          ATTEMPT_STATES.EXPIRY_AWAITING_VERIFICATION,
          ATTEMPT_STATES.CANCELLED
        ].includes(from);

      case ATTEMPT_STATES.PENDING:
        // Chuyển lại pending khi retry phiên thất bại hoặc đối soát cho phép (không thể từ cancelled)
        return [
          ATTEMPT_STATES.FAILED,
          ATTEMPT_STATES.UNKNOWN,
          ATTEMPT_STATES.AWAITING_RECONCILIATION,
          ATTEMPT_STATES.EXPIRY_AWAITING_VERIFICATION
        ].includes(from);

      case ATTEMPT_STATES.UNKNOWN:
        // Chỉ từ pending chuyển sang unknown khi timeout cổng
        return from === ATTEMPT_STATES.PENDING;

      case ATTEMPT_STATES.AWAITING_RECONCILIATION:
        return [
          ATTEMPT_STATES.PENDING,
          ATTEMPT_STATES.UNKNOWN,
          ATTEMPT_STATES.EXPIRY_AWAITING_VERIFICATION
        ].includes(from);

      case ATTEMPT_STATES.EXPIRY_AWAITING_VERIFICATION:
        return [
          ATTEMPT_STATES.PENDING,
          ATTEMPT_STATES.UNKNOWN,
          ATTEMPT_STATES.AWAITING_RECONCILIATION
        ].includes(from);

      case ATTEMPT_STATES.FAILED:
        return [
          ATTEMPT_STATES.PENDING,
          ATTEMPT_STATES.UNKNOWN,
          ATTEMPT_STATES.AWAITING_RECONCILIATION,
          ATTEMPT_STATES.EXPIRY_AWAITING_VERIFICATION
        ].includes(from);

      case ATTEMPT_STATES.CANCELLED:
        return [
          ATTEMPT_STATES.PENDING,
          ATTEMPT_STATES.FAILED,
          ATTEMPT_STATES.UNKNOWN,
          ATTEMPT_STATES.AWAITING_RECONCILIATION,
          ATTEMPT_STATES.EXPIRY_AWAITING_VERIFICATION
        ].includes(from);

      default:
        return false;
    }
  }

  /**
   * Khẳng định chuyển trạng thái hợp lệ; ném lỗi 409 nếu vi phạm quy tắc
   */
  static assertValidTransition(currentStatus, targetStatus) {
    if (!this.isValidTransition(currentStatus, targetStatus)) {
      throw Object.assign(
        new Error(`Không thể chuyển trạng thái phiên thanh toán từ "${currentStatus}" sang "${targetStatus}".`),
        { status: 409, code: 'INVALID_PAYMENT_STATE_TRANSITION' }
      );
    }
    return true;
  }

  /**
   * Thực hiện chuyển trạng thái phiên thanh toán có rào chắn (Fenced State Transition)
   * Kiểm tra transition matrix trước khi ghi DB, chống ghi đè phiên đã paid (fail-closed)
   */
  static async transitionAttempt(client, {
    attemptId,
    fromStatus = null,
    toStatus,
    providerTransactionId = null,
    providerRequestId = null,
    responseCode = null,
    lastErrorCode = null,
    reconciliationAttempts = null,
    expiresAt = null,
    updatedAt = new Date()
  }) {
    if (!attemptId) {
      throw Object.assign(new Error('Thiếu ID phiên thanh toán để cập nhật trạng thái.'), { status: 400, code: 'MISSING_ATTEMPT_ID' });
    }

    if (fromStatus) {
      this.assertValidTransition(fromStatus, toStatus);
    }

    const sql = `
      UPDATE payment_attempts
      SET status = $2,
          provider_transaction_id = COALESCE($3, provider_transaction_id),
          provider_request_id = COALESCE($4, provider_request_id),
          response_code = COALESCE($5, response_code),
          last_error_code = $6,
          reconciliation_attempts = CASE WHEN $7::int IS NOT NULL THEN reconciliation_attempts + $7::int ELSE reconciliation_attempts END,
          expires_at = COALESCE($8, expires_at),
          updated_at = $9
      WHERE id = $1
        AND (status != 'paid' OR $2 = 'paid')
        ${fromStatus ? 'AND status = $10' : ''}
      RETURNING *
    `;

    const params = [
      attemptId,
      toStatus,
      providerTransactionId,
      providerRequestId,
      responseCode !== null && responseCode !== undefined ? String(responseCode) : null,
      lastErrorCode,
      reconciliationAttempts !== null ? Number(reconciliationAttempts) : null,
      expiresAt,
      updatedAt
    ];
    if (fromStatus) {
      params.push(fromStatus);
    }

    const res = await client.query(sql, params);
    if (!res.rows[0]) {
      const check = (await client.query('SELECT status FROM payment_attempts WHERE id = $1', [attemptId])).rows[0];
      if (check && check.status === 'paid' && toStatus !== 'paid') {
        throw Object.assign(
          new Error(`Phiên thanh toán đã hoàn tất (paid) bất biến; không thể chuyển sang "${toStatus}".`),
          { status: 409, code: 'PAYMENT_ATTEMPT_ALREADY_PAID' }
        );
      }
    }
    return res.rows[0] || null;
  }
}

module.exports = {
  ATTEMPT_STATES,
  TERMINAL_ATTEMPT_STATES,
  DEFAULT_ORDER_TOKEN_SECRET,
  normalizePhone,
  normalizeEmail,
  computeCustomerScope,
  buildScopedClientReference,
  parseScopedClientReference,
  generateOrderAccessToken,
  verifyOrderAccessToken,
  assertOrderOwnership,
  checkOrderOwnership,
  normalizeCheckoutPayload,
  computeCheckoutPayloadHash,
  assertOrderPayloadMatch,
  PaymentAttemptStateMachine
};
