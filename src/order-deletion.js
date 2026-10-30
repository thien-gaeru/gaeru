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

  // 2. If order holds active inventory (not cancelled and not completed), release stock
  if (order.status !== 'cancelled' && order.status !== 'completed') {
    const { InventoryService } = require('./domain/inventory/inventory-service');
    await InventoryService.restoreOrderStock(client, { orderId: order.id, actor, reason: 'order_deletion' });
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

  // F. Shipping selections
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
