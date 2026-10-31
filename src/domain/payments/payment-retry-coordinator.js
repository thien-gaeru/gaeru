'use strict';

/**
 * PaymentRetryCoordinator — Điều phối thử lại thanh toán với CAS (Compare-And-Swap),
 * khóa hàng nguyên tử (Row-Level Locking) và mã request cổng bất biến.
 * 
 * Bảo vệ:
 * 1. Chống race condition giữa concurrent IPN/Webhook thành công và retry.
 * 2. Chống ghi đè trạng thái của phiên đã paid.
 * 3. Chống double initiation khi hai request retry đến đồng thời.
 * 4. Tuân thủ thống nhất OrderOwnership và PaymentAttemptStateMachine.
 */

const { withTransaction } = require('../../db');
const { appendAudit } = require('../../audit');
const {
  assertOrderOwnership,
  assertOrderPayloadMatch,
  PaymentAttemptStateMachine
} = require('./order-idempotency-policy');

function retryError(message, status = 400, code = 'PAYMENT_RETRY_ERROR') {
  return Object.assign(new Error(message), { status, code });
}

function extractOrderNumber(input) {
  if (!input) return null;
  const match = String(input).toUpperCase().match(/GR-\d{8}-[A-F0-9]{4,16}/);
  return match ? match[0] : String(input).trim();
}

class PaymentRetryCoordinator {
  /**
   * Điều phối thử lại thanh toán cho một đơn hàng
   */
  static async coordinateRetry(pool, {
    orderNumber = null,
    clientReference = null,
    expectedCustomer = null,
    expectedPaymentMethod = null,
    expectedItems = null,
    expectedTotalVnd = null,
    config = {},
    settings = null,
    baseUrl = 'https://gaeru.com',
    fetcher = null,
    inventory = null,
    finance = null,
    audit = appendAudit,
    actor = null
  } = {}) {
    const cleanOrderNumber = orderNumber ? extractOrderNumber(orderNumber) : null;
    const cleanRef = clientReference ? String(clientReference).trim() : null;
    if (!cleanOrderNumber && !cleanRef) {
      throw retryError('Thiếu mã đơn hàng hoặc mã tham chiếu thanh toán.', 400, 'MISSING_RETRY_IDENTIFIER');
    }

    // 1. Tra cứu đơn hàng và attempt mới nhất
    const lookup = (await pool.query(
      `SELECT o.id, o.order_number AS "orderNumber", o.subtotal_vnd AS "subtotalVnd",
              o.shipping_fee_vnd AS "shippingFeeVnd", o.discount_vnd AS "discountVnd", o.voucher_code AS "voucherCode",
              o.total_vnd AS "totalVnd", o.status, o.payment_method AS "paymentMethod",
              o.payment_status AS "paymentStatus", o.created_at AS "createdAt",
              o.email AS "customerEmail", o.phone AS "customerPhone",
              p.id AS "attemptId", p.provider, p.status AS "attemptStatus",
              p.provider_request_id AS "providerRequestId", p.payment_url AS "paymentUrl", p.expires_at AS "expiresAt",
              EXISTS (SELECT 1 FROM sales_receipts sr WHERE sr.order_id = o.id) AS "hasReceipt"
       FROM orders o
       LEFT JOIN payment_attempts p ON p.order_id = o.id
       WHERE ($1::text IS NOT NULL AND o.order_number = $1)
          OR ($2::text IS NOT NULL AND o.client_reference = $2)
       ORDER BY p.created_at DESC NULLS LAST
       LIMIT 1`,
      [cleanOrderNumber, cleanRef]
    )).rows[0];

    if (!lookup) return null;

    // 2. Kiểm tra quyền sở hữu bằng OrderOwnership Policy thống nhất
    assertOrderOwnership(lookup, expectedCustomer);

    // 3. Tra cứu sản phẩm của đơn để đối chiếu payload
    const items = (await pool.query(
      `SELECT variant_id AS "variantId", product_name AS "productName", variant_name AS "variantName", sku, unit_price_vnd AS "priceVnd", quantity
       FROM order_items WHERE order_id = $1`,
      [lookup.id]
    )).rows;

    // 4. Đối soát giỏ hàng / số tiền / phương thức bằng Idempotency Policy thống nhất
    assertOrderPayloadMatch(lookup, items, {
      expectedPaymentMethod,
      expectedTotalVnd,
      expectedItems
    });

    const formatOrder = (overrides = {}) => ({
      id: lookup.id,
      orderNumber: lookup.orderNumber,
      subtotalVnd: lookup.subtotalVnd,
      shippingFeeVnd: lookup.shippingFeeVnd,
      ...(lookup.discountVnd ? { discountVnd: lookup.discountVnd } : {}),
      ...(lookup.voucherCode ? { voucherCode: lookup.voucherCode } : {}),
      totalVnd: lookup.totalVnd,
      status: lookup.status,
      paymentMethod: lookup.paymentMethod,
      paymentStatus: lookup.paymentStatus,
      createdAt: lookup.createdAt,
      items,
      ...overrides
    });

    // 5. Nếu đã thanh toán thành công hoặc có biên lai, trả về ngay lập tức (idempotent 200)
    if (lookup.paymentStatus === 'paid' || lookup.attemptStatus === 'paid' || lookup.hasReceipt) {
      return {
        status: 200,
        order: formatOrder({ paymentStatus: 'paid' }),
        paymentUrl: null,
        alreadyPaid: true,
        paymentStatus: 'paid',
        reconciliationStatus: 'paid',
        message: 'Đơn hàng đã được xác nhận thanh toán thành công.'
      };
    }

    if (lookup.status === 'cancelled') {
      throw Object.assign(
        retryError('Đơn hàng đã bị hủy sau khi xác minh chưa thanh toán. Vui lòng tạo đơn hàng mới.', 409, 'ORDER_ALREADY_CANCELLED'),
        { orderNumber: lookup.orderNumber }
      );
    }

    // 6. Phương thức thủ công (COD, Chuyển khoản) không tạo phiên ví điện tử mới
    if (!['momo', 'zalopay'].includes(lookup.paymentMethod)) {
      return {
        status: 200,
        order: formatOrder(),
        paymentUrl: lookup.paymentUrl || null,
        reusedSession: true,
        reconciliationStatus: lookup.attemptStatus || 'pending',
        message: 'Đơn hàng đã được tiếp nhận trước đó.'
      };
    }

    // 7. Sử dụng lại phiên còn hiệu lực nếu còn mới
    if (lookup.attemptStatus === 'pending' && lookup.paymentUrl && lookup.expiresAt && new Date(lookup.expiresAt).getTime() > Date.now()) {
      return {
        status: 200,
        order: formatOrder(),
        paymentUrl: lookup.paymentUrl,
        reusedSession: true,
        providerRequestId: lookup.providerRequestId,
        reconciliationStatus: 'pending',
        message: 'Sử dụng lại phiên thanh toán hiện có của đơn hàng.'
      };
    }

    // 8. Đối soát trạng thái tại cổng trước khi thử lại
    const { reconcileGatewayOrder } = require('../../payment-channels');
    const rec = await reconcileGatewayOrder(pool, {
      orderId: lookup.id,
      provider: lookup.paymentMethod,
      settings,
      config,
      fetcher,
      inventory,
      finance,
      audit,
      actor: actor || { username: 'customer', source: 'payment_retry' },
      cancelOnUnpaid: false
    });

    if (rec.action === 'already_paid' || rec.action === 'settled_paid') {
      return {
        status: 200,
        order: formatOrder({ status: rec.orderStatus, paymentStatus: 'paid' }),
        paymentUrl: null,
        alreadyPaid: true,
        paymentStatus: 'paid',
        reconciliationStatus: 'paid',
        message: 'Đơn hàng đã được đối soát thanh toán thành công.'
      };
    }

    if (rec.action === 'still_pending') {
      throw Object.assign(
        retryError('Giao dịch đang chờ xử lý tại cổng thanh toán. Vui lòng hoàn tất trên ứng dụng ví hoặc chờ đối soát.', 409, 'PAYMENT_PENDING_AT_GATEWAY'),
        { orderId: lookup.id, orderNumber: lookup.orderNumber, providerRequestId: lookup.providerRequestId, reconciliationStatus: 'awaiting_reconciliation' }
      );
    }

    if (rec.action === 'amount_mismatch') {
      throw Object.assign(
        retryError('Số tiền giao dịch tại cổng thanh toán không khớp tổng tiền đơn hàng; đang chờ đối soát.', 409, 'PAYMENT_AMOUNT_MISMATCH'),
        { orderId: lookup.id, orderNumber: lookup.orderNumber, reconciliationStatus: 'awaiting_reconciliation' }
      );
    }

    if (rec.action === 'awaiting_reconciliation') {
      throw Object.assign(
        retryError('Chưa kiểm tra được trạng thái giao dịch tại cổng thanh toán. Đơn hàng được giữ nguyên để đối soát an toàn.', 502, rec.errorCode || 'PAYMENT_QUERY_FAILED'),
        { ambiguous: true, orderId: lookup.id, orderNumber: lookup.orderNumber, providerRequestId: lookup.providerRequestId, reconciliationStatus: 'awaiting_reconciliation' }
      );
    }

    // 9. Sinh gateway request ID bất biến có chứa timestamp chuẩn xác
    const channelSettings = settings || (await require('../../payment-channels').readChannelRecord(pool, config, lookup.paymentMethod)).data;
    const { buildGatewayRequestId, createGatewayPayment } = require('../../payment-provider-clients');
    const nowMs = Date.now();
    const nextRequestId = buildGatewayRequestId(lookup.paymentMethod, lookup.orderNumber, nowMs);

    // 10. BƯỚC KHÓA HÀNG NGUYÊN TỬ & CAS (Claim Decision)
    const claimDecision = await withTransaction(pool, async (client) => {
      const locked = (await client.query(
        `SELECT p.id, p.status, p.payment_url AS "paymentUrl", p.provider_request_id AS "providerRequestId",
                p.updated_at AS "updatedAt", p.expires_at AS "expiresAt",
                o.status AS "orderStatus", o.payment_status AS "paymentStatus",
                EXISTS (SELECT 1 FROM sales_receipts sr WHERE sr.order_id = o.id) AS "hasReceipt"
         FROM payment_attempts p
         JOIN orders o ON o.id = p.order_id
         WHERE p.id = $1
         FOR UPDATE OF p, o`,
        [lookup.attemptId]
      )).rows[0];

      if (!locked) return { shouldInitiate: false, notFound: true };

      // Chống race condition với IPN đến sớm
      if (locked.paymentStatus === 'paid' || locked.status === 'paid' || locked.hasReceipt) {
        return { shouldInitiate: false, alreadyPaid: true, orderStatus: locked.orderStatus };
      }

      if (locked.orderStatus === 'cancelled') {
        throw Object.assign(retryError('Đơn hàng đã bị hủy.', 409, 'ORDER_ALREADY_CANCELLED'));
      }

      // Nếu phiên gần đây (< 3 phút) đang hoạt động, dùng lại URL cũ
      const isRecentActive = locked.status === 'pending' && locked.paymentUrl && locked.expiresAt &&
        new Date(locked.expiresAt) > new Date() && locked.updatedAt &&
        (Date.now() - new Date(locked.updatedAt).getTime() < 180000);

      if (isRecentActive) {
        return {
          shouldInitiate: false,
          reusePaymentUrl: locked.paymentUrl,
          providerRequestId: locked.providerRequestId,
          orderStatus: locked.orderStatus
        };
      }

      // CAS: Chuyển attempt sang pending và claim request ID mới
      PaymentAttemptStateMachine.assertValidTransition(locked.status, 'pending');

      await client.query(
        `UPDATE payment_attempts
         SET provider_request_id = $2,
             status = 'pending',
             expires_at = now() + interval '15 minutes',
             reconciliation_attempts = reconciliation_attempts + 1,
             updated_at = now()
         WHERE id = $1 AND status != 'paid'`,
        [lookup.attemptId, nextRequestId]
      );

      await audit(client, {
        actor: actor || { username: 'customer', source: 'payment_retry' },
        action: 'payment.retry.initiated',
        entityType: 'order',
        entityId: lookup.id,
        metadata: { provider: lookup.paymentMethod, orderNumber: lookup.orderNumber, providerRequestId: nextRequestId }
      });

      return { shouldInitiate: true, nextRequestId, orderStatus: locked.orderStatus };
    });

    if (claimDecision.alreadyPaid) {
      return {
        status: 200,
        order: formatOrder({ status: claimDecision.orderStatus, paymentStatus: 'paid' }),
        paymentUrl: null,
        alreadyPaid: true,
        paymentStatus: 'paid',
        reconciliationStatus: 'paid',
        message: 'Đơn hàng đã được xác nhận thanh toán thành công.'
      };
    }

    if (claimDecision.reusePaymentUrl) {
      return {
        status: 200,
        order: formatOrder({ status: claimDecision.orderStatus }),
        paymentUrl: claimDecision.reusePaymentUrl,
        providerRequestId: claimDecision.providerRequestId,
        reconciliationStatus: 'pending',
        retried: true,
        message: 'Sử dụng lại phiên thanh toán hiện có của đơn hàng.'
      };
    }

    if (!claimDecision.shouldInitiate) {
      return null;
    }

    // 11. GỌI CỔNG THANH TOÁN BÊN NGOÀI TRANSACTION KHÓA DB
    try {
      const gw = await createGatewayPayment(lookup.paymentMethod, channelSettings, {
        amountVnd: lookup.totalVnd,
        txnRef: lookup.orderNumber,
        requestId: nextRequestId,
        now: nowMs,
        baseUrl,
        fetcher: fetcher || config?.paymentFetcher || fetch
      });

      // 12. LƯU KẾT QUẢ VÀ BẢO ĐẢM KHÔNG GHI ĐÈ TRẠNG THÁI PAID (NẾU IPN VỪA CẬP NHẬT TRONG LÚC GỌI CỔNG)
      const persisted = await withTransaction(pool, async (client) => {
        const locked = (await client.query(
          `SELECT p.id, p.status, o.status AS "orderStatus", o.payment_status AS "paymentStatus"
           FROM payment_attempts p
           JOIN orders o ON o.id = p.order_id
           WHERE p.id = $1
           FOR UPDATE OF p, o`,
          [lookup.attemptId]
        )).rows[0];

        const alreadyPaid = locked?.paymentStatus === 'paid' || locked?.status === 'paid';

        await client.query(
          `UPDATE payment_attempts
           SET provider_request_id = COALESCE(provider_request_id, $2),
               provider_transaction_id = COALESCE(provider_transaction_id, $3),
               payment_url = $4,
               status = CASE WHEN status = 'paid' THEN 'paid' ELSE 'pending' END,
               last_error_code = NULL,
               updated_at = now()
           WHERE id = $1`,
          [lookup.attemptId, gw.requestId, gw.providerTransactionId, gw.paymentUrl]
        );

        await audit(client, {
          actor: actor || { username: 'customer', source: 'payment_retry' },
          action: 'payment.retry.succeeded',
          entityType: 'order',
          entityId: lookup.id,
          metadata: { provider: lookup.paymentMethod, orderNumber: lookup.orderNumber, providerRequestId: gw.requestId }
        });

        return { alreadyPaid, orderStatus: locked?.orderStatus || lookup.status };
      });

      if (persisted.alreadyPaid) {
        return {
          status: 200,
          order: formatOrder({ status: persisted.orderStatus, paymentStatus: 'paid' }),
          paymentUrl: null,
          alreadyPaid: true,
          paymentStatus: 'paid',
          reconciliationStatus: 'paid'
        };
      }

      return {
        status: 200,
        order: formatOrder({ status: persisted.orderStatus }),
        paymentUrl: gw.paymentUrl,
        retried: true,
        providerRequestId: gw.requestId,
        reconciliationStatus: 'pending',
        message: 'Đã khởi tạo lại phiên thanh toán an toàn cho đơn hàng.'
      };
    } catch (retryErr) {
      // 13. XỬ LÝ LỖI GỌI CỔNG: KIỂM TRA NGUYÊN TỬ XEM IPN CÓ ĐẾN THÀNH CÔNG KHÔNG
      const handled = await withTransaction(pool, async (client) => {
        const locked = (await client.query(
          `SELECT p.id, p.status AS "attemptStatus", o.status AS "orderStatus", o.payment_status AS "paymentStatus",
                  EXISTS (SELECT 1 FROM sales_receipts sr WHERE sr.order_id = o.id) AS "hasReceipt"
           FROM payment_attempts p
           JOIN orders o ON o.id = p.order_id
           WHERE p.id = $1
           FOR UPDATE OF p, o`,
          [lookup.attemptId]
        )).rows[0];

        if (locked && (locked.paymentStatus === 'paid' || locked.attemptStatus === 'paid' || locked.hasReceipt)) {
          return { settled: true, orderStatus: locked.orderStatus };
        }

        await client.query(
          `UPDATE payment_attempts
           SET status = 'payment_initiation_unknown', last_error_code = $2, updated_at = now()
           WHERE id = $1 AND status != 'paid'`,
          [lookup.attemptId, retryErr?.code || 'PAYMENT_RETRY_UNKNOWN']
        );

        await audit(client, {
          actor: actor || { username: 'customer', source: 'payment_retry' },
          action: 'payment.retry.unknown',
          entityType: 'order',
          entityId: lookup.id,
          before: { attemptStatus: locked?.attemptStatus },
          after: { attemptStatus: 'payment_initiation_unknown' },
          metadata: { provider: lookup.paymentMethod, orderNumber: lookup.orderNumber, providerRequestId: nextRequestId, errorCode: retryErr?.code || 'PAYMENT_RETRY_UNKNOWN' }
        });

        return { settled: false };
      });

      if (handled.settled) {
        return {
          status: 200,
          order: formatOrder({ status: handled.orderStatus, paymentStatus: 'paid' }),
          paymentUrl: null,
          alreadyPaid: true,
          paymentStatus: 'paid',
          reconciliationStatus: 'paid'
        };
      }

      throw Object.assign(retryErr, {
        orderId: lookup.id,
        orderNumber: lookup.orderNumber,
        providerRequestId: nextRequestId,
        reconciliationStatus: 'payment_initiation_unknown'
      });
    }
  }
}

module.exports = {
  PaymentRetryCoordinator
};
