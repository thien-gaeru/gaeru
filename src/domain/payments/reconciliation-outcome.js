'use strict';

/**
 * Phân loại kết quả đối soát giao dịch (ReconciliationOutcome)
 * Tái xuất từ Single Source of Truth: src/domain/payments/payment-enums.js
 */
const {
  RECONCILIATION_ACTIONS,
  RECONCILIATION_GROUPS,
  ReconciliationOutcome
} = require('./payment-enums');

module.exports = {
  RECONCILIATION_ACTIONS,
  RECONCILIATION_GROUPS,
  ReconciliationOutcome
};
