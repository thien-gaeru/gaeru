const { z } = require('zod');

const cancelOrderSchema = z.object({
  reason: z.string().trim().max(500).optional()
}).strict();

/**
 * Validates whether an order can be cancelled by the customer.
 * Condition:
 * 1. Must belong to the customer.
 * 2. Status must be pending or confirmed (unfulfilled).
 * 3. Payment status must NOT be paid.
 */
function validateCancellationEligibility(order) {
  if (!order) {
    const error = new Error('Không tìm thấy đơn hàng hoặc đơn không thuộc tài khoản của bạn.');
    error.status = 404;
    throw error;
  }

  if (order.status === 'cancelled') {
    const error = new Error('Đơn hàng đã được hủy trước đó.');
    error.status = 409;
    throw error;
  }

  if (['processing', 'shipped', 'completed'].includes(order.status)) {
    const error = new Error('Đơn hàng đang chuẩn bị hoặc đã bàn giao vận chuyển, không thể tự hủy. Vui lòng liên hệ CSKH GAERU để được hỗ trợ.');
    error.status = 409;
    throw error;
  }

  if (order.status !== 'pending' && order.status !== 'confirmed') {
    const error = new Error('Chỉ có thể tự hủy đơn hàng khi đơn chưa được xử lý.');
    error.status = 409;
    throw error;
  }

  if (order.payment_status === 'paid') {
    const error = new Error('Đơn hàng đã thanh toán thành công không thể tự hủy trực tiếp. Vui lòng liên hệ CSKH để xử lý hoàn tiền.');
    error.status = 409;
    throw error;
  }

  return true;
}

/**
 * Executes customer order cancellation in an atomic transaction:
 * - Locks order row FOR UPDATE.
 * - Inactivates pending payment attempts.
 * - Releases voucher redemption quota.
 * - Restores product variant stock.
 * - Refunds loyalty GAERU Xu (if points were redeemed).
 * - Transitions order status to 'cancelled' and records reason.
 * - Records structured audit log.
 */
async function cancelCustomerOrder(client, { orderId, customerId, actor, reason, inventory = null, audit = null }) {
  if (!orderId || !customerId) {
    const error = new Error('Thiếu mã đơn hàng hoặc thông tin khách hàng.');
    error.status = 400;
    throw error;
  }

  const cancelReason = (reason && String(reason).trim()) || 'Khách hàng tự hủy đơn';

  // 1. Lock order for update
  const order = (await client.query(
    'SELECT * FROM orders WHERE id = $1 AND customer_id = $2 FOR UPDATE',
    [orderId, customerId]
  )).rows[0];

  validateCancellationEligibility(order);

  if (order.return_completed_at) {
    const err = new Error('Đơn hàng đã hoàn trả xong; không thể hủy lại.');
    err.status = 409;
    throw err;
  }

  const activeShipments = await client.query(
    "SELECT 1 FROM carrier_shipments WHERE order_id = $1 AND status <> 'cancelled' LIMIT 1",
    [order.id]
  );
  if (activeShipments.rows.length > 0) {
    const err = new Error('Đơn hàng đã được tạo vận đơn vận chuyển; vui lòng liên hệ CSKH để hỗ trợ.');
    err.status = 409;
    throw err;
  }

  const receiptCheck = await client.query(
    'SELECT COALESCE(SUM(amount_vnd), 0)::bigint AS received FROM sales_receipts WHERE order_id = $1',
    [order.id]
  );
  if (Number(receiptCheck.rows[0]?.received || 0) > 0) {
    const err = new Error('Đơn hàng đã ghi nhận phiếu thu; vui lòng liên hệ CSKH để hỗ trợ hoàn tiền.');
    err.status = 409;
    throw err;
  }

  // 2. Invalidate any active pending online payment attempts
  await client.query(
    "UPDATE payment_attempts SET status = 'failed', expires_at = LEAST(expires_at, now()), updated_at = now() WHERE order_id = $1 AND status = 'pending'",
    [order.id]
  );

  // 3. Atomic release voucher redemption
  if (order.voucher_code) {
    await client.query(
      'UPDATE voucher_redemptions SET released = true WHERE order_id = $1 AND released = false',
      [order.id]
    );
  }

  // Use the shared inventory ledger for allocations and legacy orders alike.
  // It groups repeated SKU lines, locks balances and records an idempotent move.
  const inv = inventory || require('./inventory');
  await inv.releaseOrderStock(client, {
    orderId: order.id,
    actor: actor || { id: customerId, username: 'customer', source: 'customer' }
  });
  const stockRestored = true;

  // A failed loyalty refund must roll back the entire cancellation.
  const { refundPoints } = require('./loyalty-api');
  await refundPoints(client, {
    customerId,
    orderId: order.id,
    reason: 'Khách hàng tự hủy: ' + cancelReason,
    actor: actor || { id: customerId, username: 'customer', source: 'customer' }
  });

  // 6. Update order status and note
  const noteAppend = order.note ? `${order.note} [Khách hủy: ${cancelReason}]` : `[Khách hủy: ${cancelReason}]`;
  const updatedOrder = (await client.query(
    `UPDATE orders
     SET status = 'cancelled',
         note = $3,
         cancellation_reason = $4,
         updated_at = now()
     WHERE id = $1 AND customer_id = $2
     RETURNING id, order_number AS "orderNumber", status, payment_status AS "paymentStatus",
               cancellation_reason AS "cancellationReason", total_vnd AS "totalVnd",
               updated_at AS "updatedAt"`,
    [order.id, customerId, noteAppend, cancelReason]
  )).rows[0];

  // Audit persistence is part of the same transaction as cancellation.
  const auditFn = audit || require('./audit').appendAudit;
  await auditFn(client, {
    actor: {
      id: customerId,
      username: actor?.username || 'customer',
      fullName: actor?.fullName || 'Khách hàng',
      role: 'customer',
      source: 'customer'
    },
    action: 'order.customer_cancel',
    entityType: 'order',
    entityId: order.id,
    before: { status: order.status, paymentStatus: order.payment_status },
    after: { status: 'cancelled', paymentStatus: order.payment_status },
    metadata: { reason: cancelReason, voucherCode: order.voucher_code || null, restoredStock: stockRestored }
  });

  return {
    success: true,
    message: 'Đã hủy đơn hàng thành công. Tồn kho và voucher đã được hoàn lại.',
    order: updatedOrder
  };
}

module.exports = {
  cancelOrderSchema,
  validateCancellationEligibility,
  cancelCustomerOrder
};
