'use strict';

/**
 * Payment Policy - Single Source of Truth cho các quy tắc xử lý thanh toán GAERU
 */

const ONLINE_GATEWAYS = Object.freeze(['vnpay', '9pay', 'momo', 'zalopay']);
const MANUAL_METHODS = Object.freeze(['cod', 'bank_transfer']);
const ALL_METHODS = Object.freeze([...MANUAL_METHODS, ...ONLINE_GATEWAYS]);

/**
 * Kiểm tra xem phương thức có phải là cổng thanh toán trực tuyến tự động không
 * @param {string} method
 * @returns {boolean}
 */
function isOnlineGateway(method) {
  return ONLINE_GATEWAYS.includes(String(method || '').toLowerCase());
}

/**
 * Kiểm tra xem phương thức có phải là thanh toán thủ công (COD, Chuyển khoản) không
 * @param {string} method
 * @returns {boolean}
 */
function isManualPayment(method) {
  return MANUAL_METHODS.includes(String(method || '').toLowerCase());
}

/**
 * Kiểm tra xem đơn hàng có cho phép sửa trạng thái thanh toán thủ công không
 * @param {Object} order
 * @returns {boolean}
 */
function canManuallyUpdatePayment(order) {
  if (!order || !order.payment_method && !order.paymentMethod) return false;
  const method = order.payment_method || order.paymentMethod;
  return !isOnlineGateway(method);
}

/**
 * Kiểm tra xem đơn hàng có thể lập phiếu thu tài chính thủ công không
 * @param {Object} order
 * @returns {boolean}
 */
function canManuallyCollect(order) {
  if (!order) return false;
  const method = order.payment_method || order.paymentMethod;
  if (isOnlineGateway(method)) return false;
  const status = order.status;
  const paymentStatus = order.payment_status || order.paymentStatus;
  if (status === 'cancelled' || paymentStatus === 'paid') return false;
  if (method === 'cod' && !['shipped', 'completed'].includes(status)) return false;
  return true;
}

module.exports = {
  ONLINE_GATEWAYS,
  MANUAL_METHODS,
  ALL_METHODS,
  isOnlineGateway,
  isManualPayment,
  canManuallyUpdatePayment,
  canManuallyCollect
};
