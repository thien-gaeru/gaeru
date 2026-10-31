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
    ['system', 'order_expiration_worker', 'reconciliation-worker'].includes(actor.source)
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
function assertOrderPayloadMatch(order, dbItems = [], { expectedPaymentMethod, expectedTotalVnd, expectedItems } = {}) {
  // 1. Phương thức thanh toán
  const currentMethod = order.paymentMethod || order.payment_method;
  if (expectedPaymentMethod && currentMethod && currentMethod !== expectedPaymentMethod) {
    throw Object.assign(
      new Error(`Phương thức thanh toán (${expectedPaymentMethod}) không khớp với đơn hàng trước đó (${currentMethod}).`),
      { status: 409, code: 'IDEMPOTENCY_PAYMENT_METHOD_MISMATCH' }
    );
  }

  // 2. Tổng số tiền thanh toán
  const currentTotal = order.totalVnd !== undefined ? order.totalVnd : order.total_vnd;
  if (expectedTotalVnd !== null && expectedTotalVnd !== undefined && currentTotal !== undefined) {
    if (Math.abs(Number(currentTotal) - Number(expectedTotalVnd)) > 0) {
      throw Object.assign(
        new Error('Khóa chống trùng đã được sử dụng cho một đơn hàng có tổng số tiền khác.'),
        { status: 409, code: 'IDEMPOTENCY_AMOUNT_MISMATCH' }
      );
    }
  }

  // 3. Danh sách sản phẩm: gộp theo variantId ở cả hai phía trước khi so khớp
  if (expectedItems && Array.isArray(expectedItems) && expectedItems.length > 0) {
    const itemsList = Array.isArray(dbItems) ? dbItems : [];

    const aggregateItems = (items) => {
      const map = new Map();
      for (const it of items) {
        if (!it) continue;
        const vid = String(it.variantId || it.variant_id || '');
        if (!vid) continue;
        const qty = Number(it.quantity) || 0;
        map.set(vid, (map.get(vid) || 0) + qty);
      }
      return map;
    };

    const expectedMap = aggregateItems(expectedItems);
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

  return true;
}

/**
 * Máy trạng thái phiên thanh toán (PaymentAttemptStateMachine)
 */
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
  assertOrderPayloadMatch,
  PaymentAttemptStateMachine
};
