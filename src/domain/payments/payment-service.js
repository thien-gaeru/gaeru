'use strict';

/**
 * PaymentService — Tầng dịch vụ miền hợp nhất điều phối Thanh toán, Đối soát, Outbox & Trạng thái Unknown.
 * Phối hợp chặt chẽ cùng PaymentPolicy để bảo đảm:
 *  - Không bao giờ xóa đơn hàng hoặc chứng từ tài chính khi lỗi mạng / timeout cổng thanh toán.
 *  - Ghi nhận trạng thái payment_initiation_unknown / awaiting_reconciliation kèm outbox payment.reconcile có khóa idempotency.
 *  - Bảo vệ chứng từ thu tiền append-only (sales_receipts) và vết kiểm toán (audit_logs).
 */

const { withTransaction } = require('../../db');
const { appendAudit } = require('../../audit');
const {
  isOnlineGateway,
  canManuallyCollect,
  transitionPaymentStatus,
  UNKNOWN_ATTEMPT_STATES
} = require('./payment-policy');
const { PaymentAttemptStateMachine } = require('./order-idempotency-policy');

function paymentError(message, status = 409, code = 'PAYMENT_ERROR') {
  return Object.assign(new Error(message), { status, code });
}

class PaymentService {
  /**
   * Đưa tác vụ đối soát cổng thanh toán vào hàng đợi Outbox (system_jobs) một cách an toàn qua SAVEPOINT
   */
  static async enqueueReconciliationOutbox(client, { orderId, orderNumber, provider, providerRequestId, delayMs = 15000 }) {
    const idemKey = `payment-reconcile:${orderId}:${providerRequestId || provider}`;
    let hasSavepoint = false;
    try {
      await client.query('SAVEPOINT sp_payment_reconcile_outbox');
      hasSavepoint = true;
    } catch {
      // client is not in an active transaction block (e.g. called directly on pool)
      hasSavepoint = false;
    }
    try {
      const { enqueueJob } = require('../../job-queue');
      const job = await enqueueJob(client, {
        name: 'payment.reconcile',
        idempotencyKey: idemKey,
        payload: { orderId, orderNumber, provider },
        runAt: new Date(Date.now() + Math.max(0, Number(delayMs) || 0))
      });
      if (hasSavepoint) {
        await client.query('RELEASE SAVEPOINT sp_payment_reconcile_outbox');
      }
      return job;
    } catch (error) {
      if (hasSavepoint) {
        await client.query('ROLLBACK TO SAVEPOINT sp_payment_reconcile_outbox').catch(() => {});
      }
      console.error(`[PaymentService] CẢNH BÁO: Không thể ghi outbox job payment.reconcile cho đơn ${orderNumber || orderId}:`, error?.message || error);
      return null;
    }
  }

  /**
   * Quét và đối soát định kỳ các payment attempts ở trạng thái unknown/awaiting quá hạn
   */
  static async scanOverdueUnknownAttempts(pool, config = {}, { limit = 20 } = {}) {
    try {
      const { reconcileUnknownGatewayAttempts } = require('../../payment-channels');
      if (typeof reconcileUnknownGatewayAttempts === 'function') {
        return await reconcileUnknownGatewayAttempts(pool, config, { limit });
      }
    } catch (err) {
      console.error('[PaymentService] Quét đối soát quá hạn thất bại:', err?.message || err);
    }
    return [];
  }

  /**
   * Khởi tạo phiên thanh toán cổng trực tuyến BÊN NGOÀI transaction giữ khóa đơn/kho,
   * xử lý an toàn timeout / IPN đến sớm / lỗi lưu phản hồi theo cơ chế trạng thái unknown + outbox đối soát.
   */
  static async initiateOrderGatewayPayment(pool, {
    order,
    gatewayCall,
    publicBaseUrl,
    paymentFetcher,
    inventory = null,
    audit = appendAudit
  }) {
    const { provider, channelConfig, version, providerRequestId, gatewayNow } = gatewayCall;
    let gateway = null;

    try {
      gateway = await require('../../payment-provider-clients').createGatewayPayment(provider, channelConfig, {
        amountVnd: order.totalVnd,
        txnRef: order.orderNumber,
        requestId: providerRequestId,
        now: gatewayNow,
        baseUrl: publicBaseUrl,
        fetcher: paymentFetcher
      });
    } catch (gwError) {
      const recovery = await withTransaction(pool, async (client) => {
        const lockedOrder = (await client.query(
          `SELECT id, order_number AS "orderNumber", status AS "orderStatus",
                  payment_status AS "paymentStatus", voucher_code AS "voucherCode",
                  EXISTS (SELECT 1 FROM sales_receipts sr WHERE sr.order_id = orders.id) AS "hasReceipt"
           FROM orders
           WHERE id = $1
           FOR UPDATE`,
          [order.id]
        )).rows[0];

        const lockedAttempt = (await client.query(
          `SELECT id AS "attemptId", status AS "attemptStatus", provider_request_id AS "providerRequestId"
           FROM payment_attempts
           WHERE order_id = $1 AND provider = $2
           FOR UPDATE`,
          [order.id, provider]
        )).rows[0];

        const locked = lockedOrder ? { ...lockedOrder, ...(lockedAttempt || {}) } : null;

        if (locked && (locked.paymentStatus === 'paid' || locked.attemptStatus === 'paid' || locked.hasReceipt)) {
          await audit(client, {
            actor: { username: provider, source: 'payment_gateway' },
            action: 'payment.initiation.settled_during_timeout',
            entityType: 'order',
            entityId: order.id,
            before: { attemptStatus: locked.attemptStatus, orderStatus: locked.orderStatus, paymentStatus: locked.paymentStatus },
            after: { attemptStatus: 'paid', orderStatus: locked.orderStatus, paymentStatus: 'paid' },
            metadata: {
              provider,
              orderNumber: order.orderNumber,
              providerRequestId: locked.providerRequestId || providerRequestId,
              errorCode: gwError.code || 'PAYMENT_TIMEOUT'
            }
          });
          return { settledByIpn: true, orderStatus: locked.orderStatus };
        }

        if (gwError.ambiguous === false) {
          if (locked?.attemptId) {
            if (locked.attemptStatus) {
              PaymentAttemptStateMachine.assertValidTransition(locked.attemptStatus, 'failed');
            }
            await client.query(
              `UPDATE payment_attempts
               SET status = 'failed', response_code = $2, last_error_code = $3, updated_at = now()
               WHERE id = $1`,
              [
                locked.attemptId,
                gwError.gatewayResultCode !== undefined ? String(gwError.gatewayResultCode) : null,
                gwError.code || 'PAYMENT_PROVIDER_REJECTED'
              ]
            );
          }
          if (locked && locked.orderStatus !== 'cancelled' && locked.orderStatus !== 'completed') {
            if (locked.voucherCode) {
              await client.query(
                'UPDATE voucher_redemptions SET released = true WHERE order_id = $1 AND released = false',
                [order.id]
              );
            }
            if (inventory) {
              await inventory.releaseOrderStock(client, {
                orderId: order.id,
                actor: { username: 'system', source: 'gateway_rejection' }
              });
            } else {
              await client.query(
                `UPDATE product_variants v SET stock_quantity = v.stock_quantity + i.quantity, updated_at = now()
                 FROM order_items i WHERE i.order_id = $1 AND i.variant_id = v.id`,
                [order.id]
              );
            }
            await client.query("UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1", [order.id]);
            await client.query(
              "UPDATE order_email_outbox SET status = 'skipped', finished_at = now(), result = 'Đơn hủy do cổng thanh toán từ chối' WHERE order_id = $1 AND status = 'pending'",
              [order.id]
            );
          }
          await audit(client, {
            actor: { username: 'system', source: 'gateway_rejection' },
            action: 'payment.initiation.rejected',
            entityType: 'order',
            entityId: order.id,
            before: { attemptStatus: locked?.attemptStatus || 'pending', orderStatus: locked?.orderStatus || 'pending', paymentStatus: locked?.paymentStatus || 'pending' },
            after: { attemptStatus: 'failed', orderStatus: 'cancelled', paymentStatus: locked?.paymentStatus || 'pending' },
            metadata: {
              provider,
              orderNumber: order.orderNumber,
              providerRequestId: locked?.providerRequestId || providerRequestId,
              errorCode: gwError.code || 'PAYMENT_PROVIDER_REJECTED',
              gatewayResultCode: gwError.gatewayResultCode ?? null
            }
          });
          return { settledByIpn: false, reconciliationStatus: 'cancelled_unpaid' };
        }

        // Trạng thái không xác định (timeout / lỗi mạng / HTTP 5xx): giữ nguyên đơn + attempt, ghi payment_initiation_unknown & đẩy vào outbox đối soát
        if (locked?.attemptId) {
          if (locked.attemptStatus) {
            PaymentAttemptStateMachine.assertValidTransition(locked.attemptStatus, 'payment_initiation_unknown');
          }
          await client.query(
            `UPDATE payment_attempts
             SET status = 'payment_initiation_unknown', last_error_code = $2, updated_at = now()
             WHERE id = $1`,
            [locked.attemptId, gwError.code || 'PAYMENT_INITIATION_UNKNOWN']
          );
        }
        await audit(client, {
          actor: { username: 'system', source: 'payment_gateway' },
          action: 'payment.initiation.unknown',
          entityType: 'order',
          entityId: order.id,
          before: { attemptStatus: locked?.attemptStatus || 'pending', orderStatus: locked?.orderStatus || 'pending', paymentStatus: locked?.paymentStatus || 'pending' },
          after: { attemptStatus: 'payment_initiation_unknown', orderStatus: locked?.orderStatus || 'pending', paymentStatus: locked?.paymentStatus || 'pending' },
          metadata: {
            provider,
            orderNumber: order.orderNumber,
            providerRequestId: locked?.providerRequestId || providerRequestId,
            errorCode: gwError.code || 'PAYMENT_INITIATION_UNKNOWN'
          }
        });
        await PaymentService.enqueueReconciliationOutbox(client, {
          orderId: order.id,
          orderNumber: order.orderNumber,
          provider,
          providerRequestId: locked?.providerRequestId || providerRequestId
        });
        return { settledByIpn: false, reconciliationStatus: 'payment_initiation_unknown' };
      });

      if (recovery.settledByIpn) {
        return {
          ok: true,
          httpStatus: 201,
          settledByIpn: true,
          orderStatus: recovery.orderStatus,
          paymentUrl: null,
          body: {
            order: { ...order, status: recovery.orderStatus, paymentStatus: 'paid' },
            paymentUrl: null,
            paymentSettled: true,
            reconciliationStatus: 'paid',
            message: 'Giao dịch đã được xác nhận thanh toán thành công từ cổng thanh toán.'
          }
        };
      }

      return {
        ok: false,
        httpStatus: gwError.status || 502,
        body: {
          error: gwError.message,
          code: gwError.code || 'PAYMENT_GATEWAY_ERROR',
          ambiguous: gwError.ambiguous !== false,
          orderId: order.id,
          orderNumber: order.orderNumber,
          providerRequestId,
          reconciliationStatus: recovery.reconciliationStatus
        }
      };
    }

    // Lưu URL thanh toán & mã tham chiếu cổng vào DB; nếu lưu thất bại, chuyển sang awaiting_reconciliation + outbox
    try {
      const postSave = await withTransaction(pool, async (client) => {
        const lockedOrder = (await client.query(
          `SELECT status AS "orderStatus", payment_status AS "paymentStatus"
           FROM orders WHERE id = $1 FOR UPDATE`,
          [order.id]
        )).rows[0];
        const lockedAttempt = (await client.query(
          `SELECT id AS "attemptId", status AS "attemptStatus"
           FROM payment_attempts WHERE order_id = $1 AND provider = $2 FOR UPDATE`,
          [order.id, provider]
        )).rows[0];
        const locked = lockedOrder ? { ...lockedOrder, ...(lockedAttempt || {}) } : null;

        if (lockedAttempt?.attemptStatus && UNKNOWN_ATTEMPT_STATES.includes(lockedAttempt.attemptStatus)) {
          PaymentAttemptStateMachine.assertValidTransition(lockedAttempt.attemptStatus, 'pending');
        }

        await client.query(
          `UPDATE payment_attempts
           SET provider_request_id = COALESCE(provider_request_id, $3),
               provider_transaction_id = COALESCE(provider_transaction_id, $4),
               payment_url = $5,
               status = CASE
                 WHEN status = ANY($6::text[]) THEN 'pending'
                 ELSE status
               END,
               last_error_code = NULL,
               updated_at = now()
           WHERE order_id = $1 AND provider = $2`,
          [order.id, provider, gateway.requestId, gateway.providerTransactionId, gateway.paymentUrl, UNKNOWN_ATTEMPT_STATES]
        );
        if (version) {
          await require('../../payment-channels').recordGatewayEvidence(client, provider, version, {
            method: 'provider_order_create',
            scope: 'api_credentials',
            enabled: true
          });
        }
        return locked;
      });

      const updatedOrder = (postSave?.paymentStatus === 'paid' || postSave?.attemptStatus === 'paid')
        ? { ...order, status: postSave.orderStatus, paymentStatus: 'paid' }
        : order;

      return {
        ok: true,
        httpStatus: 201,
        settledByIpn: updatedOrder.paymentStatus === 'paid',
        order: updatedOrder,
        paymentUrl: gateway.paymentUrl
      };
    } catch (persistError) {
      let settled = false;
      let currentOrderStatus = order.status;
      try {
        await withTransaction(pool, async (client) => {
          const lockedOrder = (await client.query(
            `SELECT status AS "orderStatus", payment_status AS "paymentStatus",
                    EXISTS (SELECT 1 FROM sales_receipts sr WHERE sr.order_id = orders.id) AS "hasReceipt"
             FROM orders WHERE id = $1 FOR UPDATE`,
            [order.id]
          )).rows[0];
          const lockedAttempt = (await client.query(
            `SELECT id AS "attemptId", status AS "attemptStatus"
             FROM payment_attempts WHERE order_id = $1 AND provider = $2 FOR UPDATE`,
            [order.id, provider]
          )).rows[0];
          const locked = lockedOrder ? { ...lockedOrder, ...(lockedAttempt || {}) } : null;

          if (locked && (locked.paymentStatus === 'paid' || locked.attemptStatus === 'paid' || locked.hasReceipt)) {
            settled = true;
            currentOrderStatus = locked.orderStatus;
            return;
          }
          if (locked?.attemptId) {
            if (locked.attemptStatus) {
              PaymentAttemptStateMachine.assertValidTransition(locked.attemptStatus, 'awaiting_reconciliation');
            }
            await client.query(
              `UPDATE payment_attempts
               SET status = 'awaiting_reconciliation',
                   last_error_code = 'PAYMENT_RESPONSE_PERSIST_FAILED',
                   updated_at = now()
               WHERE id = $1`,
              [locked.attemptId]
            );
          }
          await audit(client, {
            actor: { username: 'system', source: 'payment_gateway' },
            action: 'payment.initiation.awaiting_reconciliation',
            entityType: 'order',
            entityId: order.id,
            before: { attemptStatus: locked?.attemptStatus || 'pending', orderStatus: locked?.orderStatus || 'pending', paymentStatus: locked?.paymentStatus || 'pending' },
            after: { attemptStatus: 'awaiting_reconciliation', orderStatus: locked?.orderStatus || 'pending', paymentStatus: locked?.paymentStatus || 'pending' },
            metadata: {
              provider,
              orderNumber: order.orderNumber,
              providerRequestId: gateway.requestId || providerRequestId,
              errorCode: 'PAYMENT_RESPONSE_PERSIST_FAILED',
              reason: persistError?.message || 'DB persist failed'
            }
          });
          await PaymentService.enqueueReconciliationOutbox(client, {
            orderId: order.id,
            orderNumber: order.orderNumber,
            provider,
            providerRequestId: gateway.requestId || providerRequestId
          });
        });
      } catch {
        // Order & payment_attempts with provider_request_id remain safely committed
      }

      if (settled) {
        return {
          ok: true,
          httpStatus: 201,
          settledByIpn: true,
          paymentUrl: gateway.paymentUrl,
          body: {
            order: { ...order, status: currentOrderStatus, paymentStatus: 'paid' },
            paymentUrl: gateway.paymentUrl,
            paymentSettled: true,
            reconciliationStatus: 'paid',
            message: 'Giao dịch đã được xác nhận thanh toán thành công.'
          }
        };
      }

      return {
        ok: false,
        httpStatus: 502,
        body: {
          error: 'Đã khởi tạo giao dịch tại cổng thanh toán nhưng chưa lưu được phản hồi cục bộ. Đơn hàng được giữ nguyên để đối soát tự động.',
          code: 'PAYMENT_RESPONSE_PERSIST_FAILED',
          ambiguous: true,
          orderId: order.id,
          orderNumber: order.orderNumber,
          providerRequestId: gateway.requestId || providerRequestId,
          paymentUrl: gateway.paymentUrl,
          reconciliationStatus: 'awaiting_reconciliation'
        }
      };
    }
  }

  /**
   * Ghi nhận phiếu thu thủ công (COD / Chuyển khoản) tuân thủ nghiêm ngặt PaymentPolicy, append-only sales_receipts & audit_logs
   */
  static async collectManualReceipt(client, { order, data, requestHash, actor, receiptTotalFn, auditFn = appendAudit }) {
    if (!order) throw paymentError('Không tìm thấy đơn hàng.', 404, 'ORDER_NOT_FOUND');
    if (isOnlineGateway(order.payment_method)) {
      throw paymentError('Thanh toán trực tuyến được đối soát qua cổng thanh toán.', 409, 'ONLINE_GATEWAY_RECONCILE_ONLY');
    }
    if (order.status === 'cancelled' || order.payment_status === 'paid' || order.total_vnd === null) {
      throw paymentError('Đơn đã kết thúc, đã thu đủ tiền hoặc chưa chốt tổng.', 409, 'ORDER_NOT_COLLECTIBLE');
    }
    if (!canManuallyCollect(order)) {
      throw paymentError('Chỉ ghi nhận tiền COD sau khi giao hàng.', 409, 'COD_NOT_SHIPPED');
    }

    const received = await receiptTotalFn(client, order.id);
    if (data.amountVnd > Number(order.total_vnd) - received) {
      throw paymentError('Số tiền thu vượt số tiền còn phải thu.', 409, 'RECEIPT_EXCEEDS_OUTSTANDING');
    }

    const inserted = await client.query(
      `INSERT INTO sales_receipts (order_id, amount_vnd, method, reference, note, request_key, request_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [order.id, data.amountVnd, data.method, data.reference, data.note, data.requestKey, requestHash, actor?.username || 'system']
    );

    if (received + data.amountVnd === Number(order.total_vnd)) {
      await transitionPaymentStatus(client, { orderId: order.id, targetStatus: 'paid', autoOrderComplete: true });
    }

    await auditFn(client, {
      actor,
      action: 'finance.receipt.post',
      entityType: 'sales_receipt',
      entityId: inserted.rows[0].id,
      metadata: { orderId: order.id, amountVnd: data.amountVnd, method: data.method }
    });

    return { id: inserted.rows[0].id, replayed: false };
  }

  /**
   * Trích xuất bằng chứng định danh (identity proof) từ HTTP Request
   * @param {Object} req Express request
   * @returns {Object} Canonical identity proof
   */
  static extractIdentityProofFromRequest(req) {
    if (!req) return {};
    const token = req.headers?.['x-order-token'] ||
                  (req.headers?.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null) ||
                  req.body?.orderAccessToken ||
                  req.body?.token ||
                  req.query?.token;

    return {
      orderAccessToken: token || null,
      sessionCustomerId: req.session?.customer?.id || null,
      sessionCustomerEmail: req.session?.customer?.email || null,
      sessionCustomerPhone: req.session?.customer?.phone || null,
      sessionCreatedOrders: Array.isArray(req.session?.createdOrders) ? req.session.createdOrders : [],
      actor: req.actor || (req.session?.customer?.id ? { id: req.session.customer.id, username: req.session.customer.email, role: 'customer' } : null)
    };
  }

  /**
   * Tra cứu trạng thái đơn hàng & thanh toán (Fail-Closed, tự động thu gọn phạm vi công khai)
   * Router chỉ chuyển identity proof; dịch vụ miền kiểm tra quyền sở hữu và bảo vệ dữ liệu nhạy cảm.
   * @param {Object} pool Connection pool
   * @param {string} orderIdentifier Mã đơn hàng (orderNumber)
   * @param {Object} identityProof Bằng chứng định danh
   * @param {Object} [options]
   * @returns {Promise<Object|null>}
   */
  static async getOrderPaymentStatus(pool, orderIdentifier, identityProof = {}, options = {}) {
    const cleanOrderNumber = require('../../payment-channels').extractOrderNumber(orderIdentifier);
    if (!cleanOrderNumber) {
      throw Object.assign(new Error('Thiếu mã đơn hàng hợp lệ.'), { status: 400, code: 'INVALID_ORDER_NUMBER' });
    }

    const row = (await pool.query(
      `SELECT o.id, o.order_number AS "orderNumber", o.status, o.payment_method AS "paymentMethod",
              o.payment_status AS "paymentStatus", o.total_vnd AS "totalVnd", o.updated_at AS "updatedAt",
              o.email, o.phone, o.customer_id AS "customerId",
              (SELECT p.status FROM payment_attempts p WHERE p.order_id = o.id ORDER BY p.created_at DESC LIMIT 1) AS "paymentAttemptStatus"
       FROM orders o WHERE o.order_number = $1`,
      [cleanOrderNumber]
    )).rows[0];

    if (!row) return null;

    const { checkOrderOwnership } = require('./order-idempotency-policy');
    const secret = options.secret || process.env.SESSION_SECRET;
    const isOwner = checkOrderOwnership(row, identityProof, {
      secret,
      actor: identityProof.actor || options.actor
    });

    if (isOwner) {
      return {
        order: {
          orderNumber: row.orderNumber,
          status: row.status,
          paymentMethod: row.paymentMethod,
          paymentStatus: row.paymentStatus,
          totalVnd: row.totalVnd,
          updatedAt: row.updatedAt,
          paymentAttemptStatus: row.paymentAttemptStatus
        },
        verified: true
      };
    }

    // Phạm vi công khai: Ẩn tuyệt đối tổng tiền, địa chỉ, phương thức thanh toán
    return {
      order: {
        orderNumber: row.orderNumber,
        status: row.status,
        paymentStatus: row.paymentStatus,
        paymentAttemptStatus: row.paymentAttemptStatus
      },
      verified: false
    };
  }

  /**
   * Đối soát trạng thái đơn hàng trực tiếp với cổng thanh toán dưới khóa giao dịch
   */
  static async reconcileOrder(pool, options) {
    const { reconcileGatewayOrder } = require('../../payment-channels');
    return await reconcileGatewayOrder(pool, options);
  }
}

module.exports = {
  PaymentService,
  paymentError
};
