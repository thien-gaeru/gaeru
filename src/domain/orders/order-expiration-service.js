'use strict';

/**
 * Trích xuất và giải quyết dịch vụ quản lý kho (Fail-Closed: cần hàm releaseOrderStock)
 * @param {Object} [injectedInventory]
 * @returns {Object|null}
 */
function resolveInventoryService(injectedInventory = null) {
  if (injectedInventory && typeof injectedInventory.releaseOrderStock === 'function') {
    return injectedInventory;
  }
  try {
    const { InventoryService } = require('../inventory/inventory-service');
    if (InventoryService && typeof InventoryService.releaseOrderStock === 'function') {
      return InventoryService;
    }
  } catch {}
  try {
    const legacyInv = require('../../inventory');
    if (legacyInv && typeof legacyInv.releaseOrderStock === 'function') {
      return legacyInv;
    }
  } catch {}
  return null;
}

const { withTransaction } = require('../../db');
const { appendAudit } = require('../../audit');
const { logOrderActivity } = require('../../order-activity');
const { PaymentAttemptStateMachine } = require('../payments/order-idempotency-policy');
const { ReconciliationOutcome } = require('../payments/reconciliation-outcome');

/**
 * Chính sách thời gian hết hạn (TTL) mặc định phân bổ theo đặc thù từng kênh thanh toán
 */
const DEFAULT_CHANNEL_TTL_HOURS = Object.freeze({
  bank_transfer: 24, // Chuyển khoản ngân hàng thủ công: 24 giờ chờ duyệt sao kê
  momo: 1,           // Ví MoMo: 1 giờ (phiên chuẩn 15 phút, dự phòng độ trễ mạng)
  zalopay: 1,        // Ví ZaloPay: 1 giờ
  vnpay: 1,          // Cổng VNPAY: 1 giờ
  '9pay': 1          // Cổng 9Pay: 1 giờ
});

/**
 * Dịch vụ tự động hủy và hoàn trả tồn kho cho các đơn hàng quá hạn thanh toán
 * (Chuyển khoản hoặc Cổng trực tuyến chưa hoàn tất sau thời gian chờ tối đa).
 */
class OrderExpirationService {
  static get DEFAULT_CHANNEL_TTL_HOURS() {
    return DEFAULT_CHANNEL_TTL_HOURS;
  }

  /**
   * Quét và hủy các đơn hàng quá hạn chưa thanh toán, tự động giải phóng tồn kho và voucher
   * @param {Object} pool Connection pool
   * @param {Object} options
   * @param {number} [options.olderThanHours=24] Số giờ tối đa chờ thanh toán mặc định
   * @param {Object} [options.channelTtlHours] Số giờ chờ cấu hình riêng theo từng kênh
   * @param {number} [options.batchSize=50] Số lượng đơn quét mỗi đợt
   * @param {Object} [options.inventory=null] Service tồn kho
   * @param {Object} [options.config={}] Cấu hình ứng dụng
   * @param {Function} [options.fetcher=null] Custom fetcher cho cổng thanh toán
   * @param {Object} [options.actor] Tác nhân thực hiện
   * @returns {Promise<Array<Object>>} Danh sách đơn đã hủy
   */
  static async cancelExpiredUnpaidOrders(pool, {
    olderThanHours = 24,
    channelTtlHours = null,
    batchSize = 50,
    inventory = null,
    config = {},
    fetcher = null,
    actor = { username: 'system', source: 'order_expiration_worker' },
    onCandidate = null
  } = {}) {
    if (!pool || typeof pool.query !== 'function') return [];

    const ttlByChannel = {
      bank_transfer: Number(config?.ORDER_EXPIRY_BANK_TRANSFER_HOURS ?? channelTtlHours?.bank_transfer ?? olderThanHours ?? DEFAULT_CHANNEL_TTL_HOURS.bank_transfer),
      momo: Number(config?.ORDER_EXPIRY_MOMO_HOURS ?? channelTtlHours?.momo ?? (olderThanHours !== 24 ? olderThanHours : DEFAULT_CHANNEL_TTL_HOURS.momo)),
      zalopay: Number(config?.ORDER_EXPIRY_ZALOPAY_HOURS ?? channelTtlHours?.zalopay ?? (olderThanHours !== 24 ? olderThanHours : DEFAULT_CHANNEL_TTL_HOURS.zalopay)),
      vnpay: Number(config?.ORDER_EXPIRY_VNPAY_HOURS ?? channelTtlHours?.vnpay ?? (olderThanHours !== 24 ? olderThanHours : DEFAULT_CHANNEL_TTL_HOURS.vnpay)),
      '9pay': Number(config?.ORDER_EXPIRY_9PAY_HOURS ?? channelTtlHours?.['9pay'] ?? (olderThanHours !== 24 ? olderThanHours : DEFAULT_CHANNEL_TTL_HOURS['9pay']))
    };

    const candidates = (await pool.query(
      `SELECT o.id, o.order_number AS "orderNumber", o.payment_method AS "paymentMethod",
              o.status, o.payment_status AS "paymentStatus"
       FROM orders o
       WHERE o.status IN ('pending', 'confirmed')
         AND o.payment_status = 'pending'
         AND o.payment_method IN ('bank_transfer', 'vnpay', '9pay', 'momo', 'zalopay')
         AND (
           (o.payment_method = 'bank_transfer' AND o.created_at < now() - ($1::text || ' hours')::interval)
           OR (o.payment_method = 'momo' AND o.created_at < now() - ($2::text || ' hours')::interval)
           OR (o.payment_method = 'zalopay' AND o.created_at < now() - ($3::text || ' hours')::interval)
           OR (o.payment_method = 'vnpay' AND o.created_at < now() - ($4::text || ' hours')::interval)
           OR (o.payment_method = '9pay' AND o.created_at < now() - ($5::text || ' hours')::interval)
         )
         -- Chặn ngay từ đầu: Không chọn đơn nếu còn phiên thanh toán đang trong hạn hiệu lực
         AND NOT EXISTS (
           SELECT 1 FROM payment_attempts pa
           WHERE pa.order_id = o.id
             AND pa.expires_at IS NOT NULL
             AND pa.expires_at > now()
         )
         -- P1-03: Tránh nghẽn hàng đợi: Không chọn lại đơn đã chuyển sang diện chờ đối soát thủ công có SLA
         AND NOT EXISTS (
           SELECT 1 FROM payment_attempts pa
           WHERE pa.order_id = o.id
             AND pa.status = 'expiry_awaiting_verification'
         )
         AND NOT EXISTS (
           SELECT 1 FROM order_reviews r
           WHERE r.order_id = o.id
             AND r.resolved_at IS NULL
             AND r.reason = 'gateway_reconciliation_needed'
         )
       ORDER BY o.created_at ASC
       LIMIT $6`,
      [
        String(Math.max(0.01, ttlByChannel.bank_transfer)),
        String(Math.max(0.01, ttlByChannel.momo)),
        String(Math.max(0.01, ttlByChannel.zalopay)),
        String(Math.max(0.01, ttlByChannel.vnpay)),
        String(Math.max(0.01, ttlByChannel['9pay'])),
        Math.min(200, Math.max(1, Number(batchSize) || 50))
      ]
    )).rows;

    const cancelledOrders = [];
    const errors = [];
    let inv = resolveInventoryService(inventory);

    for (const cand of candidates) {
      try {
        let reconciliationOutcome = null;

        // Đối với cổng trực tuyến, thử đối soát trước khi hủy để xác nhận chưa thu tiền
        if (['momo', 'zalopay', 'vnpay', '9pay'].includes(cand.paymentMethod)) {
          try {
            const { readChannelRecord, isChannelConfigured, reconcileGatewayOrder, getVnpay } = require('../../payment-channels');
            if (typeof reconcileGatewayOrder === 'function') {
              let isConfigured = false;
              if (cand.paymentMethod === 'vnpay') {
                const vnpayConfig = typeof getVnpay === 'function' ? await getVnpay(pool, config).catch(() => null) : config?.vnpay || null;
                isConfigured = Boolean(vnpayConfig?.hashSecret && vnpayConfig?.tmnCode);
              } else if (typeof readChannelRecord === 'function') {
                const chRecord = await readChannelRecord(pool, config, cand.paymentMethod).catch(() => null);
                isConfigured = Boolean(chRecord && isChannelConfigured(cand.paymentMethod, chRecord));
              }

              if (isConfigured) {
                reconciliationOutcome = await reconcileGatewayOrder(pool, {
                  orderId: cand.id,
                  config,
                  fetcher,
                  cancelOnUnpaid: false
                }).catch((err) => ({ action: 'awaiting_reconciliation', error: err, verified: false }));
              } else {
                // Fail-Closed: Không lấy được cấu hình cổng hoặc cổng chưa sẵn sàng đối soát -> KHÔNG THỂ XÁC MINH CHƯA THU TIỀN
                reconciliationOutcome = {
                  action: 'awaiting_reconciliation',
                  reason: 'gateway_channel_unconfigured',
                  verified: false,
                  message: `Không thể đối soát đơn ${cand.orderNumber} qua cổng ${cand.paymentMethod.toUpperCase()} do chưa có cấu hình kết nối cổng.`
                };
              }
            } else {
              reconciliationOutcome = {
                action: 'awaiting_reconciliation',
                reason: 'gateway_channel_unconfigured',
                verified: false,
                message: `Module đối soát cổng ${cand.paymentMethod.toUpperCase()} không khả dụng.`
              };
            }
          } catch (err) {
            reconciliationOutcome = { action: 'awaiting_reconciliation', error: err, verified: false };
          }
        }

        // Nếu đã xác nhận thanh toán thành công qua cổng, không hủy đơn!
        if (ReconciliationOutcome.isPaid(reconciliationOutcome)) {
          continue;
        }

        if (typeof onCandidate === 'function') {
          await onCandidate(cand);
        }

        const cancelled = await withTransaction(pool, async (client) => {
          const order = (await client.query(
            `SELECT id, order_number, payment_method, status, payment_status, voucher_code, total_vnd, created_at
             FROM orders
             WHERE id = $1
             FOR UPDATE SKIP LOCKED`,
            [cand.id]
          )).rows[0];

          if (!order) return null;

          // TÁI KIỂM TRA TOÀN BỘ PREDICATE NGUYÊN TỬ SAU KHI KHÓA FOR UPDATE SKIP LOCKED:
          // 1. Trạng thái đơn PHẢI là 'pending' hoặc 'confirmed' (chống race condition đơn đã đổi sang processing/shipped/completed/cancelled)
          if (!['pending', 'confirmed'].includes(order.status)) {
            return null;
          }

          // 2. Trạng thái thanh toán PHẢI là 'pending' (chưa trả tiền)
          if (order.payment_status !== 'pending') {
            return null;
          }

          // 3. Tái kiểm tra thời gian quá hạn TTL theo kênh (đơn hàng phải thực sự vẫn quá hạn)
          const channelTtlHoursVal = ttlByChannel[order.payment_method] || 24;
          const orderAgeMs = Date.now() - new Date(order.created_at).getTime();
          if (orderAgeMs < channelTtlHoursVal * 3600 * 1000) {
            return null;
          }

          // 0. Khóa và kiểm tra toàn bộ các phiên thanh toán của đơn
          const attempts = (await client.query(
            `SELECT id, status, expires_at AS "expiresAt" FROM payment_attempts WHERE order_id = $1 FOR UPDATE`,
            [order.id]
          )).rows;

          // Nếu có bất kỳ phiên nào đã paid, không được hủy đơn!
          if (attempts.some(a => a.status === 'paid')) {
            await client.query("UPDATE orders SET payment_status = 'paid', updated_at = now() WHERE id = $1", [order.id]);
            return null;
          }

          // Kiểm tra chứng từ thu tiền thực tế (sales_receipts / sao kê đã ghi nhận tiền) - bảo vệ quy trình xác minh sao kê riêng
          const hasReceipt = (await client.query('SELECT 1 FROM sales_receipts WHERE order_id = $1', [order.id])).rows.length > 0;
          if (hasReceipt) {
            await client.query("UPDATE orders SET payment_status = 'paid', updated_at = now() WHERE id = $1", [order.id]);
            return null;
          }

          // Chặn tự hủy nếu đang có phiên còn hạn hiệu lực (khách đang trong phiên checkout / QR chưa hết hạn)
          const hasActiveAttempt = attempts.some(a => {
            const exp = a.expiresAt ? new Date(a.expiresAt) : null;
            return exp ? exp > new Date() : false;
          });
          if (hasActiveAttempt) {
            return null;
          }

          const isOnlineGateway = ['momo', 'zalopay', 'vnpay', '9pay'].includes(order.payment_method);

          // Cổng đã xác minh dứt khoát 100% chưa thanh toán (ReconciliationOutcome.DEFINITIVELY_UNPAID)
          const isDefinitivelyUnpaid = ReconciliationOutcome.isDefinitivelyUnpaid(reconciliationOutcome);

          // P2-01: Truyền toàn bộ đối tượng reconciliationOutcome thay vì chỉ action để giữ tín hiệu verified:false
          const isAmbiguousReconciliation = Boolean(reconciliationOutcome && ReconciliationOutcome.isAmbiguous(reconciliationOutcome));

          // Phiên thanh toán trước đó đang ở trạng thái chưa phân định
          const hasAmbiguousAttempt = attempts.some(a =>
            ['payment_initiation_unknown', 'awaiting_reconciliation', 'expiry_awaiting_verification'].includes(a.status)
          );

          // P2-01: Nguyên tắc Fail-Closed tuyệt đối:
          // Đối với cổng trực tuyến (momo, zalopay, vnpay, 9pay):
          // CHỈ cho phép hủy đơn khi kết quả đối soát ĐÃ được xác thực và thuộc nhóm DEFINITIVELY_UNPAID (isDefinitivelyUnpaid === true).
          // Mọi trường hợp khác (action lạ, verified: false, timeout, lỗi cấu hình, hoặc thiếu kết quả đối soát)
          // ĐỀU BẮT BUỘC giữ lại (shouldHoldForVerification = true) để bảo vệ quyền lợi khách hàng và tồn kho.
          // Đối với đơn không qua cổng online (bank_transfer): giữ lại nếu đang có nghi vấn hoặc attempt chưa phân định.
          const shouldHoldForVerification = isOnlineGateway
            ? !isDefinitivelyUnpaid
            : (isAmbiguousReconciliation || hasAmbiguousAttempt);

          if (shouldHoldForVerification) {
            const isUnconfigured = reconciliationOutcome?.reason === 'gateway_channel_unconfigured';
            const errorCode = isUnconfigured ? 'GATEWAY_CHANNEL_UNCONFIGURED' : 'EXPIRY_AWAITING_VERIFICATION';

            for (const att of attempts) {
              if (!['paid', 'cancelled'].includes(att.status)) {
                try {
                  await PaymentAttemptStateMachine.transitionAttempt(client, {
                    attemptId: att.id,
                    fromStatus: att.status,
                    toStatus: 'expiry_awaiting_verification',
                    lastErrorCode: errorCode
                  });
                } catch {}
              }
            }

            // P1-03: Đưa đơn vào danh sách chờ đối soát thủ công (order_reviews) và cảnh báo hệ thống có SLA 24h
            try {
              await client.query(
                `INSERT INTO order_reviews (order_id, reason)
                 VALUES ($1, 'gateway_reconciliation_needed')
                 ON CONFLICT (order_id) DO NOTHING`,
                [order.id]
              );
            } catch {}

            try {
              const { alertSystem } = require('../../system-alerts');
              await alertSystem(client, {
                severity: 'warning',
                source: 'order_expiration',
                message: `[SLA ĐỐI SOÁT] Đơn ${order.order_number} qua cổng ${order.payment_method?.toUpperCase()} quá hạn nhưng chưa thể xác minh tự động. Đã đưa vào danh sách đối soát thủ công với SLA 24h.`,
                metadata: {
                  orderId: order.id,
                  orderNumber: order.order_number,
                  paymentMethod: order.payment_method,
                  reason: reconciliationOutcome?.reason || 'unverified_gateway_status',
                  slaHours: 24
                },
                config
              }, fetcher);
            } catch {}

            if (typeof logOrderActivity === 'function') {
              const reasonText = isUnconfigured
                ? `Đơn hàng ${order.payment_method.toUpperCase()} quá hạn nhưng máy chủ không lấy được cấu hình cổng để đối soát. Tạm dừng hủy đơn, chuyển sang chờ đối soát xác thực để bảo vệ hàng tồn kho và quyền lợi khách hàng.`
                : `Đơn hàng ${order.payment_method.toUpperCase()} quá hạn nhưng phiên thanh toán chưa được phân định chắc chắn tại cổng. Chuyển sang chờ đối soát xác thực, tạm giữ kho và voucher.`;

              await logOrderActivity(client, {
                orderId: order.id,
                orderNumber: order.order_number,
                actorType: 'system',
                actorName: 'Tự động kiểm tra hết hạn',
                action: 'expiry_awaiting_verification',
                details: {
                  from: order.status,
                  reason: reasonText,
                  reconciliationAction: reconciliationOutcome?.action || null,
                  reconciliationReason: reconciliationOutcome?.reason || null
                }
              });
            }

            await appendAudit(client, {
              actor,
              action: 'order.expiry_awaiting_verification',
              entityType: 'order',
              entityId: order.id,
              metadata: {
                paymentMethod: order.payment_method,
                reason: reconciliationOutcome?.reason || reconciliationOutcome?.action || 'unverified_gateway_state',
                olderThanHours,
                totalVnd: order.total_vnd
              }
            });

            return null;
          }

          // QUYẾT ĐỊNH CUỐI CÙNG (Final Definitive Decision) - Xác nhận 100% chưa thanh toán:
          // 1. Hoàn trả tồn kho kho hàng (Fail-Closed: Bắt buộc thông qua InventoryService, TUYỆT ĐỐI không fallback cộng kho trực tiếp)
          if (!inv || typeof inv.releaseOrderStock !== 'function') {
            inv = resolveInventoryService(inventory);
          }
          if (!inv || typeof inv.releaseOrderStock !== 'function') {
            throw new Error(`INVENTORY_SERVICE_REQUIRED: Thiếu dịch vụ quản lý kho (InventoryService.releaseOrderStock) để hoàn trả tồn kho cho đơn ${order.order_number}. Quá trình hủy đơn bị đình chỉ (fail-closed) để ngăn ngừa sai lệch số dư kho hàng.`);
          }
          await inv.releaseOrderStock(client, { orderId: order.id, actor });

          // 2. Nhả mã giảm giá nếu có
          if (order.voucher_code) {
            await client.query(
              'UPDATE voucher_redemptions SET released = true WHERE order_id = $1 AND released = false',
              [order.id]
            );
          }

          // 3. Cập nhật các phiên thanh toán chưa hoàn tất sang cancelled
          for (const att of attempts) {
            if (att.status !== 'paid' && att.status !== 'cancelled') {
              try {
                await PaymentAttemptStateMachine.transitionAttempt(client, {
                  attemptId: att.id,
                  fromStatus: att.status,
                  toStatus: 'cancelled'
                });
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
                reason: `Đơn hàng ${order.payment_method.toUpperCase()} quá hạn thanh toán và đã xác nhận chưa thu tiền, hệ thống tự động hủy và hoàn trả tồn kho.`
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
        try {
          const { alertSystem } = require('../../system-alerts');
          await alertSystem(pool, {
            severity: 'warning',
            source: 'order_expiration_cancellation_failed',
            message: `[LỖI HỦY ĐƠN TỰ ĐỘNG] Không thể hủy đơn quá hạn ${cand.orderNumber}: ${err.message}`,
            metadata: {
              orderId: cand.id,
              orderNumber: cand.orderNumber,
              error: err.message,
              code: err.code || null
            },
            config
          }, fetcher);
        } catch {}
        errors.push({
          orderId: cand.id,
          orderNumber: cand.orderNumber,
          error: err.message,
          code: err.code || null
        });
      }
    }

    cancelledOrders.success = errors.length === 0;
    cancelledOrders.cancelledCount = cancelledOrders.length;
    cancelledOrders.failedCount = errors.length;
    cancelledOrders.errors = errors;
    cancelledOrders.cancelled = cancelledOrders;

    return cancelledOrders;
  }
}

/**
 * Worker định kỳ quét và hủy đơn quá hạn
 */
function startOrderExpirationWorker(pool, config = {}, {
  intervalMs = 5 * 60 * 1000, // 5 phút quét một lần
  olderThanHours = 24,
  channelTtlHours = null,
  onError = (err) => console.error('Order expiration worker error:', err.message)
} = {}) {
  let running = false;
  let stopped = false;

  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      const result = await OrderExpirationService.cancelExpiredUnpaidOrders(pool, { olderThanHours, channelTtlHours, config });
      if (result?.failedCount > 0 && typeof onError === 'function') {
        onError(new Error(`Order expiration worker: ${result.failedCount} đơn hủy thất bại: ${result.errors?.[0]?.error || 'Lỗi không xác định'}`));
      }
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
  resolveInventoryService,
  DEFAULT_CHANNEL_TTL_HOURS,
  OrderExpirationService,
  startOrderExpirationWorker
};
