const { appendAudit } = require('./audit');

/**
 * Permanently deletes an order and all of its associated records across all tables,
 * releasing inventory allocations if the order was not already cancelled or completed,
 * removing voucher redemptions, care requests, reviews, warranties, and sales receipts
 * so that it is completely excluded from sales reports, revenue figures, and order history.
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

  // 1. Lock and fetch order
  const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!orderRes.rows.length) return null;
  const order = orderRes.rows[0];
  const unresolvedShipment = await client.query(`SELECT a.id FROM carrier_shipment_attempts a WHERE a.order_id=$1 AND (
    a.status IN ('sending','unknown') OR (a.status='succeeded' AND NOT EXISTS (
      SELECT 1 FROM carrier_shipments s WHERE s.order_id=a.order_id AND s.carrier_id=a.carrier_id AND (
        s.tracking_number=NULLIF(a.provider_result->>'trackingNumber','') OR s.carrier_order_id=NULLIF(a.provider_result->>'carrierOrderId','')
      )
    ))) LIMIT 1`, [order.id]);
  if (unresolvedShipment.rows.length) throw Object.assign(new Error('Yêu cầu tạo vận đơn đang xử lý hoặc chưa đối soát đầy đủ với mã hãng. Giữ đơn và bằng chứng vận chuyển để đối soát trước khi xóa.'), { status: 409 });
  const activeShipment = await client.query("SELECT id FROM carrier_shipments WHERE order_id=$1 AND status IN ('created','picking','delivering') LIMIT 1", [order.id]);
  if (activeShipment.rows.length) throw Object.assign(new Error('Đơn còn vận đơn đang hoạt động. Hủy vận đơn trên hệ thống hãng hoặc hoàn tất giao hàng trước khi xóa lịch sử đơn.'), { status: 409 });
  const openExchange = await client.query(`SELECT e.id FROM rma_exchange_issues e JOIN order_after_sales a ON a.id=e.case_id
    WHERE a.order_id=$1 AND e.status='posted' AND a.status NOT IN ('resolved','rejected') LIMIT 1`, [order.id]);
  if (openExchange.rows.length) throw Object.assign(new Error('Đơn đang có chứng từ xuất hàng đổi chưa hoàn tất. Hủy chứng từ trước khi bàn giao hoặc hoàn tất giao đổi và đóng hồ sơ trước khi xóa đơn.'), { status: 409 });

  // 2. If order holds active inventory (not cancelled and not completed), release stock
  if (order.status !== 'cancelled' && order.status !== 'completed') {
    const inv = inventory || require('./inventory');
    await inv.releaseOrderStock(client, { orderId: order.id, actor });
  }

  // 3. Delete dependent records in strict dependency order:
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

  // E2. Refund/reconcile loyalty points before deleting order if customer exists and order was not cancelled
  if (order.customer_id && order.status !== 'cancelled') {
    const { refundPoints } = require('./loyalty-api');
    await refundPoints(client, {
      customerId: order.customer_id,
      orderId: order.id,
      reason: 'Xóa vĩnh viễn đơn hàng #' + order.order_number,
      actor
    });
  }

  // F. Carrier shipments, barcode pack verifications & shipping selections
  await client.query('DELETE FROM carrier_shipments WHERE order_id = $1', [order.id]);
  await client.query('DELETE FROM order_pack_verifications WHERE order_id = $1', [order.id]);
  await client.query('DELETE FROM order_shipping_selection WHERE order_id = $1', [order.id]);

  // G. Sales receipts (removes completely from sales reports, revenue figures)
  await client.query('INSERT INTO order_deletion_sessions(order_id) VALUES ($1) ON CONFLICT DO NOTHING', [order.id]);
  await client.query('DELETE FROM sales_receipts WHERE order_id = $1', [order.id]);

  // H. Voucher redemptions
  await client.query('DELETE FROM voucher_redemptions WHERE order_id = $1', [order.id]);

  // I. MISA e-invoices
  await client.query('DELETE FROM misa_einvoices WHERE order_id = $1', [order.id]);

  // J. Order reviews
  await client.query('DELETE FROM order_reviews WHERE order_id = $1', [order.id]);

  // K. Email outboxes
  await client.query('DELETE FROM order_email_outbox WHERE order_id = $1', [order.id]);
  await client.query('DELETE FROM order_admin_email_outbox WHERE order_id = $1', [order.id]);

  // L. Payment attempts
  await client.query('DELETE FROM payment_attempts WHERE order_id = $1', [order.id]);

  // M. Order items
  await client.query('DELETE FROM order_items WHERE order_id = $1', [order.id]);

  // N. Finally delete the order itself
  await client.query('DELETE FROM orders WHERE id = $1', [order.id]);
  await client.query('DELETE FROM order_deletion_sessions WHERE order_id = $1', [order.id]);

  // 4. Audit trail
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
 * Permanently deletes all orders associated with a customer (by customer_id or guest email),
 * ensuring they and their revenue records are removed from sales reports and order history.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} customerId
 * @param {string} [customerEmail]
 * @param {object} [options]
 * @returns {Promise<number>} Count of deleted orders
 */
async function deleteCustomerOrdersPermanently(client, customerId, customerEmail, { actor, inventory } = {}) {
  let orderIds = [];
  if (customerEmail && typeof customerEmail === 'string' && customerEmail.trim()) {
    const rows = (await client.query(
      `SELECT id FROM orders WHERE customer_id = $1 OR (customer_id IS NULL AND lower(email) = lower($2)) FOR UPDATE`,
      [customerId, customerEmail.trim()]
    )).rows;
    orderIds = rows.map(r => r.id);
  } else {
    const rows = (await client.query(
      `SELECT id FROM orders WHERE customer_id = $1 FOR UPDATE`,
      [customerId]
    )).rows;
    orderIds = rows.map(r => r.id);
  }

  let count = 0;
  for (const id of orderIds) {
    const deleted = await deleteOrderPermanently(client, id, { actor, inventory });
    if (deleted) count++;
  }
  return count;
}

module.exports = {
  deleteOrderPermanently,
  deleteCustomerOrdersPermanently
};
