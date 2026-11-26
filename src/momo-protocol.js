'use strict';

// MoMo 2026 guide, pp. 24 and 226–229. GAERU uses captureWallet with
// autoCapture=true exclusively; code 9000 is successful for this one-step flow.
const MIN_AMOUNT = 1000;
const MAX_AMOUNT = 50000000;
const pendingCodes = new Set([1000, 7000, 7002]);
const FINAL_FAILURE_CODES = Object.freeze([98, 99, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1017, 1026, 2019, 4001, 4002, 4100]);
const failedCodes = new Set(FINAL_FAILURE_CODES);

function paymentState(code) {
  if (code === 0 || code === 9000) return 'paid';
  if (failedCodes.has(code)) return 'failed';
  // API/configuration errors and unfamiliar codes never prove a payment failed.
  return 'pending';
}

function isTransactionResult(code) {
  return code === 0 || code === 9000 || pendingCodes.has(code) || failedCodes.has(code);
}

module.exports = { MIN_AMOUNT, MAX_AMOUNT, FINAL_FAILURE_CODES, paymentState, isTransactionResult };
