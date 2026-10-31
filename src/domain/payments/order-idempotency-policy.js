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

const { createHash } = require('node:crypto');

const ATTEMPT_STATES = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  UNKNOWN: 'payment_initiation_unknown',
  AWAITING_RECONCILIATION: 'awaiting_reconciliation'
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

/**
 * Xác minh quyền sở hữu đơn hàng dựa trên thông tin người mua
 * @param {Object} order { customerEmail, customerPhone, email, phone }
 * @param {Object} expectedCustomer { email, phone }
 * @throws {Error} 403 FORBIDDEN_ORDER_ACCESS nếu không khớp
 */
function assertOrderOwnership(order, expectedCustomer) {
  if (!expectedCustomer || (!expectedCustomer.email && !expectedCustomer.phone)) {
    return true; // Không có yêu cầu đối chiếu danh tính
  }

  const orderEmail = normalizeEmail(order.customerEmail || order.email);
  const orderPhone = normalizePhone(order.customerPhone || order.phone);
  const expectedEmail = normalizeEmail(expectedCustomer.email);
  const expectedPhone = normalizePhone(expectedCustomer.phone);

  // Khi người mua cung cấp cả email và số điện thoại, bắt buộc CẢ HAI phải khớp với đơn hàng
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

  // Khi chỉ cung cấp một trong hai thông tin, thông tin đó bắt buộc phải khớp
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

  return true;
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
          ATTEMPT_STATES.CANCELLED
        ].includes(from);

      case ATTEMPT_STATES.PENDING:
        // Chuyển lại pending khi retry phiên thất bại hoặc đối soát cho phép (không thể từ cancelled)
        return [
          ATTEMPT_STATES.FAILED,
          ATTEMPT_STATES.UNKNOWN,
          ATTEMPT_STATES.AWAITING_RECONCILIATION
        ].includes(from);

      case ATTEMPT_STATES.UNKNOWN:
        // Chỉ từ pending chuyển sang unknown khi timeout cổng
        return from === ATTEMPT_STATES.PENDING;

      case ATTEMPT_STATES.AWAITING_RECONCILIATION:
        return [
          ATTEMPT_STATES.PENDING,
          ATTEMPT_STATES.UNKNOWN
        ].includes(from);

      case ATTEMPT_STATES.FAILED:
        return [
          ATTEMPT_STATES.PENDING,
          ATTEMPT_STATES.UNKNOWN,
          ATTEMPT_STATES.AWAITING_RECONCILIATION
        ].includes(from);

      case ATTEMPT_STATES.CANCELLED:
        return [
          ATTEMPT_STATES.PENDING,
          ATTEMPT_STATES.FAILED,
          ATTEMPT_STATES.UNKNOWN,
          ATTEMPT_STATES.AWAITING_RECONCILIATION
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
  normalizePhone,
  normalizeEmail,
  computeCustomerScope,
  buildScopedClientReference,
  parseScopedClientReference,
  assertOrderOwnership,
  assertOrderPayloadMatch,
  PaymentAttemptStateMachine
};
