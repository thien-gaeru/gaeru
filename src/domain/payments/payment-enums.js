'use strict';

/**
 * src/domain/payments/payment-enums.js — Single Source of Truth cho các Enum và hằng số thanh toán & đơn hàng GAERU
 * Hợp nhất định nghĩa cho toàn hệ thống: payment-service, payment-channels, order-expiration-service,
 * payment-retry-coordinator, store-schemas, order-email và admin-configuration.
 */

// 1. Phương thức thanh toán (Payment Methods)
const PAYMENT_METHODS = Object.freeze({
  COD: 'cod',
  BANK_TRANSFER: 'bank_transfer',
  VNPAY: 'vnpay',
  NINEPAY: '9pay',
  MOMO: 'momo',
  ZALOPAY: 'zalopay'
});

const ONLINE_GATEWAYS = Object.freeze([
  PAYMENT_METHODS.VNPAY,
  PAYMENT_METHODS.NINEPAY,
  PAYMENT_METHODS.MOMO,
  PAYMENT_METHODS.ZALOPAY
]);

const MANUAL_METHODS = Object.freeze([
  PAYMENT_METHODS.COD,
  PAYMENT_METHODS.BANK_TRANSFER
]);

const ALL_PAYMENT_METHODS = Object.freeze([
  ...MANUAL_METHODS,
  ...ONLINE_GATEWAYS
]);

const PAYMENT_METHOD_LABELS = Object.freeze({
  [PAYMENT_METHODS.COD]: 'COD',
  [PAYMENT_METHODS.BANK_TRANSFER]: 'Chuyển khoản ngân hàng',
  [PAYMENT_METHODS.VNPAY]: 'VNPAY',
  [PAYMENT_METHODS.NINEPAY]: '9Pay',
  [PAYMENT_METHODS.MOMO]: 'Ví MoMo',
  [PAYMENT_METHODS.ZALOPAY]: 'Ví ZaloPay'
});

function getPaymentMethodLabel(method) {
  if (!method) return 'Chưa xác định';
  return PAYMENT_METHOD_LABELS[method] || String(method).toUpperCase();
}

function isOnlineGateway(method) {
  return ONLINE_GATEWAYS.includes(String(method || '').toLowerCase());
}

function isManualPayment(method) {
  return MANUAL_METHODS.includes(String(method || '').toLowerCase());
}

// 2. Trạng thái phiên thanh toán (Payment Attempt States)
const PAYMENT_ATTEMPT_STATES = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  UNKNOWN: 'payment_initiation_unknown',
  PAYMENT_INITIATION_UNKNOWN: 'payment_initiation_unknown',
  AWAITING_RECONCILIATION: 'awaiting_reconciliation',
  EXPIRY_AWAITING_VERIFICATION: 'expiry_awaiting_verification'
});

const TERMINAL_ATTEMPT_STATES = Object.freeze([
  PAYMENT_ATTEMPT_STATES.PAID,
  PAYMENT_ATTEMPT_STATES.CANCELLED
]);

const UNKNOWN_ATTEMPT_STATES = Object.freeze([
  PAYMENT_ATTEMPT_STATES.PAYMENT_INITIATION_UNKNOWN,
  PAYMENT_ATTEMPT_STATES.AWAITING_RECONCILIATION,
  PAYMENT_ATTEMPT_STATES.EXPIRY_AWAITING_VERIFICATION
]);

function isUnknownAttemptState(status) {
  return UNKNOWN_ATTEMPT_STATES.includes(String(status || '').toLowerCase());
}

// 3. Phân loại kết quả đối soát (Reconciliation Outcome Actions & Groups)
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

  static isPaid(actionOrOutcome) {
    if (!actionOrOutcome) return false;
    if (typeof actionOrOutcome === 'object') {
      if (actionOrOutcome.paymentStatus === 'paid') return true;
      return RECONCILIATION_GROUPS.PAID.includes(actionOrOutcome.action);
    }
    return RECONCILIATION_GROUPS.PAID.includes(actionOrOutcome);
  }

  static isDefinitivelyUnpaid(outcome) {
    if (!outcome || typeof outcome !== 'object') return false;
    return Boolean(
      outcome.verified === true &&
      RECONCILIATION_GROUPS.DEFINITIVELY_UNPAID.includes(outcome.action)
    );
  }

  static isAmbiguous(actionOrOutcome) {
    if (!actionOrOutcome) return true;
    if (typeof actionOrOutcome === 'object') {
      // 1. Bất kỳ kết quả nào chưa được cổng xác thực (verified === false) đều mơ hồ
      if (actionOrOutcome.verified === false) return true;
      // 2. Nếu đã dứt khoát xác thực là PAID hoặc DEFINITIVELY_UNPAID thì không mơ hồ
      if (this.isPaid(actionOrOutcome)) return false;
      if (this.isDefinitivelyUnpaid(actionOrOutcome)) return false;
      // 3. Mọi trường hợp còn lại (kể cả action lạ, chưa được phân loại) đều coi là mơ hồ (Fail-Closed)
      return true;
    }
    // Trường hợp truyền action dạng chuỗi:
    if (RECONCILIATION_GROUPS.PAID.includes(actionOrOutcome)) return false;
    if (RECONCILIATION_GROUPS.DEFINITIVELY_UNPAID.includes(actionOrOutcome)) return false;
    // Bất kỳ chuỗi action lạ nào (vd: 'unknown_new_action') đều coi là mơ hồ
    return true;
  }
}

// 4. Hành động xử lý tiền về muộn sau hủy (Late Settlement Actions)
const LATE_SETTLEMENT_ACTIONS = Object.freeze({
  ALREADY_SETTLED: 'already_settled',
  PROCESSED_REFUND_TASK: 'processed_refund_task',
  UNMATCHED_RECONCILIATION: 'unmatched_reconciliation'
});

// 5. Trạng thái đơn hàng & Thanh toán (Order Statuses & Payment Statuses)
const ORDER_STATUSES = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PROCESSING: 'processing',
  SHIPPED: 'shipped',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled'
});

const ORDER_PAYMENT_STATUSES = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  REFUNDED: 'refunded',
  FAILED: 'failed'
});

const ORDER_TRANSITIONS = Object.freeze({
  [ORDER_STATUSES.PENDING]: Object.freeze([ORDER_STATUSES.CONFIRMED, ORDER_STATUSES.CANCELLED]),
  [ORDER_STATUSES.CONFIRMED]: Object.freeze([ORDER_STATUSES.PROCESSING, ORDER_STATUSES.CANCELLED]),
  [ORDER_STATUSES.PROCESSING]: Object.freeze([ORDER_STATUSES.SHIPPED, ORDER_STATUSES.CANCELLED]),
  [ORDER_STATUSES.SHIPPED]: Object.freeze([ORDER_STATUSES.COMPLETED]),
  [ORDER_STATUSES.COMPLETED]: Object.freeze([]),
  [ORDER_STATUSES.CANCELLED]: Object.freeze([])
});

module.exports = {
  PAYMENT_METHODS,
  ONLINE_GATEWAYS,
  MANUAL_METHODS,
  ALL_PAYMENT_METHODS,
  ALL_METHODS: ALL_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  getPaymentMethodLabel,
  isOnlineGateway,
  isManualPayment,
  isUnknownAttemptState,
  PAYMENT_ATTEMPT_STATES,
  ATTEMPT_STATES: PAYMENT_ATTEMPT_STATES,
  TERMINAL_ATTEMPT_STATES,
  UNKNOWN_ATTEMPT_STATES,
  RECONCILIATION_ACTIONS,
  RECONCILIATION_GROUPS,
  ReconciliationOutcome,
  LATE_SETTLEMENT_ACTIONS,
  ORDER_STATUSES,
  ORDER_PAYMENT_STATUSES,
  ORDER_TRANSITIONS
};
