'use strict';

/**
 * Payment Policy - Single Source of Truth cho các quy tắc xử lý thanh toán GAERU
 */

const ONLINE_GATEWAYS = Object.freeze(['vnpay', '9pay', 'momo', 'zalopay']);
const MANUAL_METHODS = Object.freeze(['cod', 'bank_transfer']);
const ALL_METHODS = Object.freeze([...MANUAL_METHODS, ...ONLINE_GATEWAYS]);
const UNKNOWN_ATTEMPT_STATES = Object.freeze(['payment_initiation_unknown', 'awaiting_reconciliation']);

function isUnknownAttemptState(status) {
  return UNKNOWN_ATTEMPT_STATES.includes(String(status || '').toLowerCase());
}

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

/**
 * Chuyển trạng thái thanh toán đơn hàng có kiểm tra tính hợp lệ và tự động hoàn thành đơn COD
 * @param {Object} client Database client/pool
 * @param {Object} options
 * @param {string} options.orderId ID đơn hàng
 * @param {string} options.targetStatus Trạng thái thanh toán đích ('paid', 'pending', etc.)
 * @param {boolean} [options.autoOrderComplete=false] Tự động chuyển đơn sang completed nếu COD và shipped
 * @returns {Promise<{ order: Object, changed: boolean }>}
 */
async function transitionPaymentStatus(client, { orderId, targetStatus, autoOrderComplete = false, allowRevert = false }) {
  if (!orderId || !targetStatus) throw new Error("orderId và targetStatus là bắt buộc.");
  const orderRes = await client.query(
    "SELECT id, payment_method AS \"paymentMethod\", payment_status AS \"paymentStatus\", status FROM orders WHERE id = $1 FOR UPDATE",
    [orderId]
  );
  const order = orderRes.rows[0];
  if (!order) throw Object.assign(new Error("Không tìm thấy đơn hàng."), { status: 404 });

  if (order.paymentStatus === targetStatus) {
    return { order, changed: false };
  }

  if (order.paymentStatus === 'paid' && targetStatus === 'pending' && !allowRevert) {
    throw Object.assign(
      new Error("Không thể hạ trạng thái thanh toán từ đã thu tiền (paid) về chưa thanh toán (pending)."),
      { status: 409 }
    );
  }

  const shouldComplete = autoOrderComplete && order.paymentMethod === 'cod' && order.status === 'shipped';
  const updated = (await client.query(
    `UPDATE orders
     SET payment_status = $2,
         status = CASE WHEN $3 = true THEN 'completed' ELSE status END,
         updated_at = now()
     WHERE id = $1
     RETURNING id, status, payment_status AS "paymentStatus"`,
    [orderId, targetStatus, shouldComplete]
  )).rows[0];

  return { order: updated, changed: true };
}

module.exports = {
  ONLINE_GATEWAYS,
  MANUAL_METHODS,
  ALL_METHODS,
  UNKNOWN_ATTEMPT_STATES,
  isUnknownAttemptState,
  isOnlineGateway,
  isManualPayment,
  canManuallyUpdatePayment,
  canManuallyCollect,
  transitionPaymentStatus,
  ...require('./order-idempotency-policy')
};
