'use strict';

const { withTransaction } = require('../../db');
const { appendAudit } = require('../../audit');
const { logOrderActivity } = require('../../order-activity');
const { PaymentAttemptStateMachine } = require('../payments/order-idempotency-policy');

/**
 * Dịch vụ tự động hủy và hoàn trả tồn kho cho các đơn hàng quá hạn thanh toán
 * (Chuyển khoản hoặc Cổng trực tuyến chưa hoàn tất sau thời gian chờ tối đa).
 */
class OrderExpirationService {
  /**
   * Quét và hủy các đơn hàng quá hạn chưa thanh toán, tự động giải phóng tồn kho và voucher
   * @param {Object} pool Connection pool
   * @param {Object} options
   * @param {number} [options.olderThanHours=24] Số giờ tối đa chờ thanh toán (mặc định 24h)
   * @param {number} [options.batchSize=50] Số lượng đơn quét mỗi đợt
   * @param {Object} [options.inventory=null] Service tồn kho
   * @param {Object} [options.actor] Tác nhân thực hiện
   * @returns {Promise<Array<Object>>} Danh sách đơn đã hủy
   */
  static async cancelExpiredUnpaidOrders(pool, {
    olderThanHours = 24,
    batchSize = 50,
    inventory = null,
    actor = { username: 'system', source: 'order_expiration_worker' }
  } = {}) {
    if (!pool || typeof pool.query !== 'function') return [];

    const candidates = (await pool.query(
      `SELECT id, order_number AS "orderNumber", payment_method AS "paymentMethod", status, payment_status AS "paymentStatus"
       FROM orders
       WHERE status IN ('pending', 'confirmed')
         AND payment_status = 'pending'
         AND payment_method IN ('bank_transfer', 'vnpay', '9pay', 'momo', 'zalopay')
         AND created_at < now() - ($1::text || ' hours')::interval
       ORDER BY created_at ASC
       LIMIT $2`,
      [String(Math.max(1, Number(olderThanHours) || 24)), Math.min(200, Math.max(1, Number(batchSize) || 50))]
    )).rows;

    const cancelledOrders = [];
    const inv = inventory || require('../../inventory');

    for (const cand of candidates) {
      try {
        const cancelled = await withTransaction(pool, async (client) => {
          const order = (await client.query(
            `SELECT id, order_number, payment_method, status, payment_status, voucher_code, total_vnd
             FROM orders
             WHERE id = $1
             FOR UPDATE`,
            [cand.id]
          )).rows[0];

          if (!order) return null;
          // Nếu đơn đã được thanh toán hoặc đã hủy, bỏ qua
          if (order.status === 'cancelled' || order.status === 'completed' || order.payment_status === 'paid') {
            return null;
          }

          // 1. Hoàn trả tồn kho kho hàng
          if (inv && typeof inv.releaseOrderStock === 'function') {
            await inv.releaseOrderStock(client, { orderId: order.id, actor });
          } else {
            await client.query(
              `UPDATE product_variants v SET stock_quantity = v.stock_quantity + i.quantity, updated_at = now()
               FROM order_items i WHERE i.order_id = $1 AND i.variant_id = v.id`,
              [order.id]
            );
          }

          // 2. Nhả mã giảm giá nếu có
          if (order.voucher_code) {
            await client.query(
              'UPDATE voucher_redemptions SET released = true WHERE order_id = $1 AND released = false',
              [order.id]
            );
          }

          // 3. Cập nhật các phiên thanh toán chưa hoàn tất sang cancelled
          const attempts = (await client.query(
            `SELECT id, status FROM payment_attempts WHERE order_id = $1 FOR UPDATE`,
            [order.id]
          )).rows;
          for (const att of attempts) {
            if (att.status !== 'paid' && att.status !== 'cancelled') {
              try {
                PaymentAttemptStateMachine.assertValidTransition(att.status, 'cancelled');
                await client.query(
                  `UPDATE payment_attempts SET status = 'cancelled', updated_at = now() WHERE id = $1`,
                  [att.id]
                );
              } catch {}
            }
          }

          // 4. Chuyển trạng thái đơn hàng sang cancelled
          await client.query(
            "UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1",
            [order.id]
          );

          // 5. Ghi nhật ký tiến trình đơn hàng (timeline)
          if (typeof logOrderActivity === 'function') {
            await logOrderActivity(client, {
              orderId: order.id,
              orderNumber: order.order_number,
              actorType: 'system',
              actorName: 'Tự động hủy đơn quá hạn',
              action: 'status_changed',
              details: {
                from: order.status,
                to: 'cancelled',
                reason: `Đơn hàng ${order.payment_method.toUpperCase()} quá hạn thanh toán (${olderThanHours} giờ), hệ thống tự động hủy và hoàn trả tồn kho.`
              }
            });
          }

          // 6. Ghi nhật ký kiểm toán (audit log)
          await appendAudit(client, {
            actor,
            action: 'order.cancel_expired_unpaid',
            entityType: 'order',
            entityId: order.id,
            before: { status: order.status, paymentStatus: order.payment_status },
            after: { status: 'cancelled', paymentStatus: order.payment_status },
            metadata: {
              paymentMethod: order.payment_method,
              olderThanHours,
              totalVnd: order.total_vnd
            }
          });

          return { orderId: order.id, orderNumber: order.order_number, paymentMethod: order.payment_method };
        });

        if (cancelled) cancelledOrders.push(cancelled);
      } catch (err) {
        console.error(`Lỗi khi tự động hủy đơn quá hạn ${cand.orderNumber}:`, err.message);
      }
    }

    return cancelledOrders;
  }
}

/**
 * Worker định kỳ quét và hủy đơn quá hạn
 */
function startOrderExpirationWorker(pool, config = {}, {
  intervalMs = 5 * 60 * 1000, // 5 phút quét một lần
  olderThanHours = 24,
  onError = (err) => console.error('Order expiration worker error:', err.message)
} = {}) {
  let running = false;
  let stopped = false;

  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      await OrderExpirationService.cancelExpiredUnpaidOrders(pool, { olderThanHours });
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = {
  OrderExpirationService,
  startOrderExpirationWorker
};
