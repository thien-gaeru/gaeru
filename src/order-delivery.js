'use strict';

/**
 * Stage 4 of the GAERU order workflow.
 * A verified delivery completes fulfillment, NOT payment or carrier COD settlement.
 * Callers must hold the order row lock and run this inside a transaction.
 */
async function completeDeliveredOrder(client, order, { actor } = {}) {
  if (!client || !order?.id) throw new TypeError('Missing locked order and transaction client.');
  const status = order.orderStatus ?? order.status;
  const paymentStatus = order.orderPaymentStatus ?? order.payment_status;
  const returned = order.orderReturnCompletedAt ?? order.return_completed_at ?? order.returnedAt;
  if (status === 'cancelled' || returned) {
    return { orderStatus: status, changed: false, blocked: true };
  }
  if (!['pending', 'confirmed', 'processing', 'shipped', 'completed'].includes(status)) {
    throw Object.assign(new Error('Trạng thái đơn hàng không cho phép xác nhận đã giao.'), { status: 409 });
  }
  if (status === 'completed') {
    // Legacy completed records can be missing the delivery clock.
    await client.query('UPDATE orders SET delivered_at = COALESCE(delivered_at, now()) WHERE id = $1', [order.id]);
    return { orderStatus: 'completed', changed: false, paymentStatus };
  }

  await client.query(
    'UPDATE orders SET status = $2, delivered_at = COALESCE(delivered_at, now()), updated_at = now() WHERE id = $1',
    [order.id, 'completed']
  );

  // Loyalty is earned only when payment is actually paid; COD delivery alone is insufficient.
  // The finance/COD settlement path awards the points later, idempotently.
  const customerId = order.orderCustomerId ?? order.customer_id;
  const totalVnd = Number(order.orderTotalVnd ?? order.total_vnd ?? 0);
  if (paymentStatus === 'paid' && customerId && totalVnd > 0) {
    const { earnPoints } = require('./loyalty-api');
    await earnPoints(client, {
      customerId,
      orderId: order.id,
      orderTotalVnd: totalVnd,
      actor: actor || { username: 'delivery_system', source: 'fulfillment' }
    });
  }

  // Intentionally DO NOT set payment_status, COD settlement, payment attempts or sales receipts.
  return { orderStatus: 'completed', changed: true, paymentStatus };
}

module.exports = { completeDeliveredOrder };
