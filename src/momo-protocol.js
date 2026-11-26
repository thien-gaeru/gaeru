'use strict';

// MoMo 2026 guide, pp. 24, 191–197, 217–222, and 226–229.
// GAERU uses autoCapture=true exclusively; code 9000 is successful for 1-step payments.
const MIN_AMOUNT = 1000;
const MAX_AMOUNT = 50000000;
const ATM_MIN_AMOUNT = 10000;
const REQUEST_TYPES = Object.freeze(['captureWallet', 'payWithMethod']);
const DEFAULT_REQUEST_TYPE = 'captureWallet';
const pendingCodes = new Set([1000, 7000, 7002]);
const FINAL_FAILURE_CODES = Object.freeze([98, 99, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1017, 1026, 2019, 4001, 4002, 4100]);
const REFUND_FAILURE_CODES = Object.freeze([1080, 1081, 1088]);
const failedCodes = new Set(FINAL_FAILURE_CODES);
const refundFailedCodes = new Set([...REFUND_FAILURE_CODES, ...FINAL_FAILURE_CODES]);

const REFUND_ERROR_MESSAGES = Object.freeze({
  1080: 'Hoàn tiền MoMo thất bại trong quá trình xử lý. Kiểm tra lại orderId/transId gốc và thử lại sau khoảng 1 giờ (mã 1080).',
  1081: 'Yêu cầu hoàn tiền bị MoMo từ chối: giao dịch gốc có thể đã được hoàn hoặc số tiền vượt quá mức có thể hoàn (mã 1081).',
  1088: 'Giao dịch gốc không đủ điều kiện hoàn tiền theo quy định của MoMo (mã 1088).'
});

function normalizeRequestType(value) {
  return value === 'payWithMethod' ? 'payWithMethod' : DEFAULT_REQUEST_TYPE;
}

function paymentState(code) {
  if (code === 0 || code === 9000) return 'paid';
  if (failedCodes.has(code)) return 'failed';
  // API/configuration errors and unfamiliar codes never prove a payment failed.
  return 'pending';
}

function isTransactionResult(code) {
  return code === 0 || code === 9000 || pendingCodes.has(code) || failedCodes.has(code);
}

function refundState(code) {
  if (code === 0) return 'succeeded';
  if (code === 7000 || code === 7002) return 'pending';
  if (refundFailedCodes.has(code)) return 'failed';
  // Non-final API/system codes (10..47) or unknown codes remain ambiguous until queried.
  return 'ambiguous';
}

function refundFailureMessage(code) {
  const num = Number(code);
  if (Object.hasOwn(REFUND_ERROR_MESSAGES, num)) return REFUND_ERROR_MESSAGES[num];
  return `Yêu cầu hoàn tiền MoMo không thành công (mã ${code}).`;
}

module.exports = {
  MIN_AMOUNT,
  MAX_AMOUNT,
  ATM_MIN_AMOUNT,
  REQUEST_TYPES,
  DEFAULT_REQUEST_TYPE,
  FINAL_FAILURE_CODES,
  REFUND_FAILURE_CODES,
  normalizeRequestType,
  paymentState,
  isTransactionResult,
  refundState,
  refundFailureMessage
};
