'use strict';

/**
 * Phân loại kết quả đối soát giao dịch (ReconciliationOutcome)
 * Enum chuẩn cho toàn hệ thống: payment-channels, order-expiration-service, payment-retry-coordinator
 */
const RECONCILIATION_ACTIONS = Object.freeze({
  // Nhóm 1: Đã thanh toán thành công (PAID)
  ALREADY_PAID: 'already_paid',
  SETTLED_PAID: 'settled_paid',

  // Nhóm 2: Chắc chắn 100% chưa thanh toán (DEFINITIVELY_UNPAID)
  VERIFIED_UNPAID: 'verified_unpaid',
  CANCELLED_UNPAID: 'cancelled_unpaid',
  RETRY_ALLOWED: 'retry_allowed',

  // Nhóm 3: Chưa xác định / Cần chờ đối soát (AMBIGUOUS / AWAITING_VERIFICATION)
  AWAITING_RECONCILIATION: 'awaiting_reconciliation',
  STILL_PENDING: 'still_pending',
  AMOUNT_MISMATCH: 'amount_mismatch',
  GATEWAY_CHANNEL_UNCONFIGURED: 'gateway_channel_unconfigured',
  QUERY_FAILED: 'query_failed'
});

const RECONCILIATION_GROUPS = Object.freeze({
  PAID: Object.freeze([
    RECONCILIATION_ACTIONS.ALREADY_PAID,
    RECONCILIATION_ACTIONS.SETTLED_PAID
  ]),
  DEFINITIVELY_UNPAID: Object.freeze([
    RECONCILIATION_ACTIONS.VERIFIED_UNPAID,
    RECONCILIATION_ACTIONS.CANCELLED_UNPAID,
    RECONCILIATION_ACTIONS.RETRY_ALLOWED
  ]),
  AMBIGUOUS: Object.freeze([
    RECONCILIATION_ACTIONS.AWAITING_RECONCILIATION,
    RECONCILIATION_ACTIONS.STILL_PENDING,
    RECONCILIATION_ACTIONS.AMOUNT_MISMATCH,
    RECONCILIATION_ACTIONS.GATEWAY_CHANNEL_UNCONFIGURED,
    RECONCILIATION_ACTIONS.QUERY_FAILED
  ])
});

class ReconciliationOutcome {
  static get ACTIONS() {
    return RECONCILIATION_ACTIONS;
  }

  static get GROUPS() {
    return RECONCILIATION_GROUPS;
  }

  /**
   * Kiểm tra giao dịch đã thanh toán thành công
   */
  static isPaid(actionOrOutcome) {
    if (!actionOrOutcome) return false;
    if (typeof actionOrOutcome === 'object') {
      if (actionOrOutcome.paymentStatus === 'paid') return true;
      return RECONCILIATION_GROUPS.PAID.includes(actionOrOutcome.action);
    }
    return RECONCILIATION_GROUPS.PAID.includes(actionOrOutcome);
  }

  /**
   * Kiểm tra kết quả đối soát chắc chắn 100% chưa thanh toán
   */
  static isDefinitivelyUnpaid(outcome) {
    if (!outcome || typeof outcome !== 'object') return false;
    return Boolean(
      outcome.verified === true &&
      RECONCILIATION_GROUPS.DEFINITIVELY_UNPAID.includes(outcome.action)
    );
  }

  /**
   * Kiểm tra kết quả còn mơ hồ, chưa phân định hoặc lỗi kết nối cổng
   */
  static isAmbiguous(actionOrOutcome) {
    if (!actionOrOutcome) return true;
    const action = typeof actionOrOutcome === 'object' ? actionOrOutcome.action : actionOrOutcome;
    if (!action) return true;
    return RECONCILIATION_GROUPS.AMBIGUOUS.includes(action);
  }
}

module.exports = {
  RECONCILIATION_ACTIONS,
  RECONCILIATION_GROUPS,
  ReconciliationOutcome
};
