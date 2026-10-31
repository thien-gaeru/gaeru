const { appendAudit } = require('./audit');

/**
 * Permanently deletes an UNPAID order that has no financial documents or unresolved
 * payment gateway attempts, releasing held inventory allocations if not already cancelled.
 *
 * Financial safety invariants:
 * - Never deletes an order with payment_status = 'paid' or status = 'paid' in payment_attempts.
 * - Never deletes an order with sales_receipts or misa_einvoices (financial documents are immutable).
 * - Never deletes an order with payment_attempts in 'payment_initiation_unknown' or 'awaiting_reconciliation'.
 *
 * @param {import('pg').PoolClient} client - An active PostgreSQL transaction client
 * @param {string} orderId - The UUID of the order to delete
 * @param {object} [options]
 * @param {object} [options.actor] - The actor performing the deletion (staff/owner/system)
 * @param {object} [options.inventory] - Inventory module reference
 * @returns {Promise<object|null>} The deleted order record if found, or null
 */
async function deleteOrderPermanently(client, orderId, { actor = { username: 'system', source: 'order_deletion' }, inventory } = {}) {
  if (!orderId) return null;

  // 1. Lock and fetch order + payment attempts
  const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!orderRes.rows.length) return null;
  const order = orderRes.rows[0];

  const attemptsRes = await client.query(
    'SELECT id, status, provider FROM payment_attempts WHERE order_id = $1 FOR UPDATE',
    [order.id]
  );
  const attempts = attemptsRes.rows;

  // 2. Block deletion if gateway payment state is ambiguous / awaiting reconciliation
  if (attempts.some((a) => a.status === 'payment_initiation_unknown' || a.status === 'awaiting_reconciliation')) {
    const err = new Error('Không thể xóa đơn hàng đang chờ đối soát trạng thái giao dịch với cổng thanh toán.');
    err.status = 409;
    err.code = 'ORDER_AWAITING_RECONCILIATION';
    throw err;
  }

  // 3. Block deletion if paid or if any financial voucher / e-invoice exists
  const financialDocsRes = await client.query(
    `SELECT
       EXISTS (SELECT 1 FROM sales_receipts WHERE order_id = $1) AS "hasReceipt",
       EXISTS (SELECT 1 FROM misa_einvoices WHERE order_id = $1) AS "hasInvoice"`,
    [order.id]
  );
  const { hasReceipt, hasInvoice } = financialDocsRes.rows[0] || {};
  if (
    order.payment_status === 'paid' ||
    attempts.some((a) => a.status === 'paid') ||
    hasReceipt ||
    hasInvoice
  ) {
    const err = new Error(
      'Không thể xóa vĩnh viễn đơn hàng đã thanh toán hoặc đã phát sinh chứng từ tài chính. Cần đối soát hoặc hoàn tiền theo quy trình kế toán.'
    );
    err.status = 409;
    err.code = 'PAID_ORDER_DELETION_FORBIDDEN';
    throw err;
  }

  // 4. If order holds active inventory (not cancelled and not completed), release stock
  if (order.status !== 'cancelled' && order.status !== 'completed') {
    const inv = inventory || require('./inventory');
    if (inv && typeof inv.releaseOrderStock === 'function') {
      await inv.releaseOrderStock(client, { orderId: order.id, actor });
    } else {
      const { InventoryService } = require('./domain/inventory/inventory-service');
      await InventoryService.restoreOrderStock(client, { orderId: order.id, actor, reason: 'order_deletion' });
    }
  }

  // 5. Delete non-financial dependent records in strict dependency order:
  // A. Customer care messages & requests
  await client.query(
    'DELETE FROM care_messages WHERE care_id IN (SELECT id FROM care_requests WHERE order_id = $1)',
    [order.id]
  );
  await client.query('DELETE FROM care_requests WHERE order_id = $1', [order.id]);

  // B. Warranty email outbox & activations
  await client.query(
    `DELETE FROM warranty_email_outbox
     WHERE order_id = $1 OR warranty_id IN (
       SELECT id FROM warranty_activations WHERE order_item_id IN (
         SELECT id FROM order_items WHERE order_id = $1
       )
     )`,
    [order.id]
  );
  await client.query(
    `DELETE FROM warranty_activations WHERE order_item_id IN (
       SELECT id FROM order_items WHERE order_id = $1
     )`,
    [order.id]
  );

  // C. Order after-sales requests (returns, cancellations)
  await client.query('DELETE FROM order_after_sales WHERE order_id = $1', [order.id]);

  // D. Order stock allocations
  await client.query('DELETE FROM order_stock_allocations WHERE order_id = $1', [order.id]);

  // E. Order restoration requests
  await client.query('DELETE FROM order_restoration_requests WHERE order_id = $1', [order.id]);

  // F. Shipping selections
  await client.query('DELETE FROM order_shipping_selection WHERE order_id = $1', [order.id]);

  // G. Voucher redemptions
  await client.query('DELETE FROM voucher_redemptions WHERE order_id = $1', [order.id]);

  // H. Order reviews
  await client.query('DELETE FROM order_reviews WHERE order_id = $1', [order.id]);

  // I. Email outboxes
  await client.query('DELETE FROM order_email_outbox WHERE order_id = $1', [order.id]);
  await client.query('DELETE FROM order_admin_email_outbox WHERE order_id = $1', [order.id]);

  // J. Unpaid/terminal payment attempts
  await client.query('DELETE FROM payment_attempts WHERE order_id = $1', [order.id]);

  // K. Order items
  await client.query('DELETE FROM order_items WHERE order_id = $1', [order.id]);

  // L. Finally delete the unpaid order itself
  await client.query('DELETE FROM orders WHERE id = $1', [order.id]);

  // 6. Audit trail
  await appendAudit(client, {
    actor,
    action: 'order.permanently_deleted',
    entityType: 'order',
    entityId: order.id,
    metadata: {
      orderNumber: order.order_number,
      customerName: order.customer_name,
      totalVnd: order.total_vnd,
      status: order.status,
      paymentStatus: order.payment_status
    }
  });

  return order;
}

/**
 * Handles customer orders when a customer account is permanently deleted (GDPR / retention):
 * - Unpaid orders with no financial documents and no unresolved gateway attempts are permanently deleted.
 * - Paid orders, orders with financial vouchers (sales_receipts / misa_einvoices), or orders awaiting
 *   gateway reconciliation are NEVER deleted; instead, customer_id is detached and PII is anonymized
 *   so financial ledgers and reconciliation records remain intact.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} customerId
 * @param {string} [customerEmail]
 * @param {object} [options]
 * @returns {Promise<number>} Count of deleted unpaid orders
 */
async function deleteCustomerOrdersPermanently(client, customerId, customerEmail, { actor = { username: 'system', source: 'account_deletion' }, inventory } = {}) {
  let rows = [];
  if (customerEmail && typeof customerEmail === 'string' && customerEmail.trim()) {
    rows = (await client.query(
      `SELECT id, order_number, payment_status FROM orders
       WHERE customer_id = $1 OR (customer_id IS NULL AND lower(email) = lower($2))
       ORDER BY id
       FOR UPDATE`,
      [customerId, customerEmail.trim()]
    )).rows;
  } else {
    rows = (await client.query(
      `SELECT id, order_number, payment_status FROM orders
       WHERE customer_id = $1
       ORDER BY id
       FOR UPDATE`,
      [customerId]
    )).rows;
  }

  let deletedCount = 0;
  for (const row of rows) {
    const check = (await client.query(
      `SELECT
         EXISTS (SELECT 1 FROM sales_receipts WHERE order_id = $1) AS "hasReceipt",
         EXISTS (SELECT 1 FROM misa_einvoices WHERE order_id = $1) AS "hasInvoice",
         EXISTS (
           SELECT 1 FROM payment_attempts
           WHERE order_id = $1 AND status IN ('paid', 'payment_initiation_unknown', 'awaiting_reconciliation')
         ) AS "hasProtectedAttempt"`,
      [row.id]
    )).rows[0];

    if (row.payment_status === 'paid' || check?.hasReceipt || check?.hasInvoice || check?.hasProtectedAttempt) {
      await client.query(
        'DELETE FROM care_messages WHERE care_id IN (SELECT id FROM care_requests WHERE order_id = $1)',
        [row.id]
      );
      await client.query('DELETE FROM care_requests WHERE order_id = $1', [row.id]);
      await client.query(
        `UPDATE orders
         SET customer_id = NULL,
             customer_name = '[Đã ẩn danh]',
             email = 'anonymized-' || id::text || '@deleted.invalid',
             phone = '0000000000',
             address = '[Đã xóa theo lưu trữ tài khoản]',
             note = '',
             updated_at = now()
         WHERE id = $1`,
        [row.id]
      );
      await appendAudit(client, {
        actor,
        action: 'order.customer_anonymized',
        entityType: 'order',
        entityId: row.id,
        metadata: {
          orderNumber: row.order_number,
          formerCustomerId: customerId,
          preservedForFinancialReconciliation: true
        }
      });
    } else {
      const deleted = await deleteOrderPermanently(client, row.id, { actor, inventory });
      if (deleted) deletedCount++;
    }
  }
  return deletedCount;
}

module.exports = {
  deleteOrderPermanently,
  deleteCustomerOrdersPermanently
};
