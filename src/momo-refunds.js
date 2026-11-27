'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const { withTransaction } = require('./db');
const { appendAudit } = require('./audit');
const momoProtocol = require('./momo-protocol');
const { refundGatewayPayment, queryGatewayRefund } = require('./payment-provider-clients');

const fail = (message, status = 409, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const sameMerchant = (a, b) => ['partnerCode', 'accessKey', 'secretKey', 'environment'].every(key => a?.[key] === b?.[key]);

function generateRefundOrderId(orderNumber) {
  const stem = String(orderNumber || 'ORDER').replace(/^GR-/, '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 24) || 'ORDER';
  const suffix = randomBytes(4).toString('hex').toUpperCase();
  const candidate = `RF-${stem}-${suffix}`;
  return candidate === orderNumber ? `RF-${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}` : candidate;
}

function formatRefundRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    paymentAttemptId: row.payment_attempt_id,
    orderNumber: row.order_number,
    refundOrderId: row.refund_order_id,
    requestId: row.request_id,
    originalTransId: String(row.original_trans_id),
    refundTransId: row.refund_trans_id || null,
    amountVnd: Number(row.amount_vnd),
    description: row.description || '',
    status: row.status,
    resultCode: row.result_code ?? null,
    providerMessage: row.provider_message || '',
    environment: row.environment,
    createdBy: row.created_by,
    lastCheckedAt: row.last_checked_at || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function refundStatusMessage(refund) {
  if (refund.status === 'succeeded') {
    return `Hoàn tiền MoMo thành công ${new Intl.NumberFormat('vi-VN').format(refund.amountVnd)} ₫ cho đơn ${refund.orderNumber} (mã GD hoàn: ${refund.refundTransId || refund.refundOrderId}).`;
  }
  if (refund.status === 'pending') {
    return `MoMo đang xử lý lệnh hoàn tiền ${refund.refundOrderId} (mã ${refund.resultCode}). Hệ thống sẽ tiếp tục tự động tra cứu kết quả.`;
  }
  if (refund.status === 'failed') {
    return momoProtocol.refundFailureMessage(refund.resultCode);
  }
  return `Chưa nhận được kết quả dứt khoát từ MoMo cho lệnh hoàn tiền ${refund.refundOrderId}. Dùng "Tra cứu trạng thái" trước khi tạo lệnh hoàn mới để tránh hoàn trùng.`;
}

async function resolveMomoSettings(poolOrClient, config) {
  const { readChannelRecord } = require('./payment-channels');
  const record = await readChannelRecord(poolOrClient, config, 'momo');
  if (!record.version || !record.data?.partnerCode || !record.data?.accessKey || !record.data?.secretKey) {
    throw fail('Chưa cấu hình đầy đủ thông tin merchant MoMo.', 409);
  }
  if (config?.NODE_ENV === 'production' && record.data.environment !== 'production') {
    throw fail('Không thể gửi lệnh hoàn tiền Sandbox từ hệ thống đang chạy Production.', 400);
  }
  return record;
}

const UNSETTLED_MOMO_REFUND_STATUSES = Object.freeze(['pending_provider', 'pending', 'ambiguous']);

async function getOrderRefundLedger(client, order, { lock = false, receivedVnd = null } = {}) {
  const existingRefunds = (await client.query(
    `SELECT id, status, amount_vnd FROM momo_refunds WHERE order_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [order.id]
  )).rows;
  const succeededMomoVnd = existingRefunds
    .filter(r => r.status === 'succeeded')
    .reduce((sum, r) => sum + Number(r.amount_vnd || 0), 0);
  const unsettledMomoVnd = existingRefunds
    .filter(r => UNSETTLED_MOMO_REFUND_STATUSES.includes(r.status))
    .reduce((sum, r) => sum + Number(r.amount_vnd || 0), 0);
  const blockingMomo = existingRefunds.find(r => r.status === 'pending_provider' || r.status === 'ambiguous') || null;
  const reservedMomoVnd = existingRefunds
    .filter(r => ['succeeded', 'pending'].includes(r.status))
    .reduce((sum, r) => sum + Number(r.amount_vnd || 0), 0);
  const manualRmaRow = (await client.query(
    `SELECT COALESCE(SUM(COALESCE(refund_amount_vnd, 0) + COALESCE(loyalty_clawback_vnd, 0)), 0)::bigint AS settled_rma_vnd
     FROM order_after_sales
     WHERE order_id = $1 AND kind = 'return' AND status = 'resolved'`,
    [order.id]
  )).rows[0];
  const manualSettledVnd = Number(manualRmaRow?.settled_rma_vnd || 0);
  const collectedVnd = receivedVnd !== null
    ? Number(receivedVnd)
    : Number((await client.query('SELECT COALESCE(SUM(amount_vnd),0) AS received FROM sales_receipts WHERE order_id=$1', [order.id])).rows[0]?.received || 0);
  const baseCollectedVnd = order.payment_status === 'paid' ? Number(order.total_vnd) : collectedVnd;
  const grossRefundableVnd = Math.max(0, baseCollectedVnd - succeededMomoVnd - manualSettledVnd);
  return {
    existingRefunds,
    succeededMomoVnd,
    unsettledMomoVnd,
    blockingMomo,
    reservedMomoVnd,
    manualSettledVnd,
    collectedVnd,
    baseCollectedVnd,
    grossRefundableVnd
  };
}

/**
 * 3-Phase Non-Blocking MoMo Refund:
 * Phase 1: Validate order/attempt/remaining amount, reserve row with status='pending_provider' & commit.
 * Phase 2: Call POST /v2/gateway/api/refund outside any DB transaction/connection.
 * Phase 3: Persist final or pending/ambiguous state & write audit log.
 */
async function initiateMomoRefund(pool, config, {
  orderNumber,
  amountVnd,
  description = '',
  requestKey = null,
  transGroup = undefined,
  actor,
  fetcher,
  audit = appendAudit
}) {
  const cleanOrderNumber = String(orderNumber || '').trim().toUpperCase();
  const cleanAmount = Number(amountVnd);
  const cleanDescription = String(description || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 255);
  if (!cleanOrderNumber || !Number.isSafeInteger(cleanAmount) || cleanAmount < momoProtocol.MIN_AMOUNT || cleanAmount > momoProtocol.MAX_AMOUNT) {
    throw fail('Số tiền hoàn MoMo phải từ 1.000 ₫ đến 50.000.000 ₫ và có mã đơn hợp lệ.', 400);
  }

  // Phase 1: Reserve refund row atomically & release DB lock before external HTTP call
  const phase1 = await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:payment-config:momo'))");
    if (requestKey) {
      const existing = (await client.query('SELECT * FROM momo_refunds WHERE request_key = $1', [requestKey])).rows[0];
      if (existing) {
        if (existing.order_number !== cleanOrderNumber || Number(existing.amount_vnd) !== cleanAmount) {
          throw fail('Mã chống trùng (requestKey) đã được dùng cho yêu cầu hoàn tiền khác.', 409);
        }
        return { replayed: true, refund: formatRefundRow(existing) };
      }
    }

    const record = await resolveMomoSettings(client, config);
    const order = (await client.query(
      `SELECT id, order_number, customer_id, payment_method, payment_status, total_vnd, status, return_completed_at
       FROM orders
       WHERE order_number = $1 OR replace(order_number, '-', '') = replace($1, '-', '')
       FOR UPDATE`,
      [cleanOrderNumber]
    )).rows[0];
    if (!order) throw fail('Không tìm thấy đơn hàng tương ứng.', 404);
    if (order.payment_method !== 'momo') {
      throw fail('Đơn hàng này không thanh toán qua MoMo.', 409);
    }
    if (order.payment_status !== 'paid') {
      throw fail('Chỉ có thể hoàn tiền cho đơn hàng MoMo đã xác nhận thanh toán thành công.', 409);
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['gaeru:momo-refund:' + order.id]);

    const attempt = (await client.query(
      `SELECT id, amount_vnd, provider_transaction_id, status
       FROM payment_attempts
       WHERE order_id = $1 AND provider = 'momo' AND status = 'paid'
       ORDER BY updated_at DESC, created_at DESC LIMIT 1
       FOR UPDATE`,
      [order.id]
    )).rows[0];
    if (!attempt) {
      throw fail('Không tìm thấy giao dịch MoMo đã thanh toán cho đơn hàng này.', 409);
    }
    const rawTid = String(attempt.provider_transaction_id || '').trim();
    if (!/^[1-9]\d{0,18}$/.test(rawTid) || !Number.isSafeInteger(Number(rawTid))) {
      throw fail('Đơn hàng chưa có mã giao dịch số (transId) từ MoMo; chỉ hoàn tiền qua API cho đơn đã đối soát qua MoMo hoặc thực hiện trực tiếp trên M4B Portal.', 409);
    }

    // Check if the original payment used Local ATM Card (napas -> 10,000 VND minimum refund per MoMo p. 218)
    const payAudit = (await client.query(
      `SELECT metadata->'providerMeta'->>'payType' AS pay_type
       FROM audit_events
       WHERE entity_type = 'order' AND entity_id = $1 AND action IN ('payment.momo.callback', 'payment.momo.query')
       ORDER BY created_at DESC LIMIT 1`,
      [order.id]
    )).rows[0];
    if (payAudit?.pay_type === 'napas' && cleanAmount < momoProtocol.ATM_MIN_AMOUNT) {
      throw fail('Theo quy định MoMo, giao dịch thanh toán bằng thẻ ATM nội địa yêu cầu hoàn tối thiểu 10.000 ₫.', 400);
    }

    const ledger = await getOrderRefundLedger(client, order, { lock: true, receivedVnd: attempt.amount_vnd });
    if (ledger.blockingMomo) {
      throw fail('Đơn hàng đang có lệnh hoàn tiền MoMo chưa rõ kết quả. Hãy bấm "Tra cứu trạng thái" trước khi gửi lệnh hoàn mới.', 409);
    }
    let pendingClawbackVnd = 0;
    if (order.customer_id && !order.return_completed_at) {
      const { previewEarnClawback } = require('./loyalty-api');
      const preview = await previewEarnClawback(client, { customerId: order.customer_id, orderId: order.id, lock: true });
      pendingClawbackVnd = Math.max(0, Number(preview?.shortfallPoints || 0));
    }
    const remainingVnd = Number(attempt.amount_vnd) - ledger.reservedMomoVnd - ledger.manualSettledVnd - pendingClawbackVnd;
    if (remainingVnd < momoProtocol.MIN_AMOUNT || cleanAmount > remainingVnd) {
      throw fail(`Số tiền hoàn vượt quá số dư còn có thể hoàn (${new Intl.NumberFormat('vi-VN').format(Math.max(0, remainingVnd))} ₫).`, 409);
    }

    const refundOrderId = generateRefundOrderId(order.order_number);
    const requestId = randomUUID();
    const inserted = (await client.query(
      `INSERT INTO momo_refunds (
         order_id, payment_attempt_id, order_number, refund_order_id, request_id,
         original_trans_id, amount_vnd, description, status, environment, request_key, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_provider',$9,$10,$11)
       RETURNING *`,
      [
        order.id, attempt.id, order.order_number, refundOrderId, requestId,
        rawTid, cleanAmount, cleanDescription || `Hoan tien don hang ${order.order_number}`,
        record.data.environment, requestKey || null, actor?.username || 'owner'
      ]
    )).rows[0];

    return {
      replayed: false,
      settings: record.data,
      orderId: order.id,
      orderNumber: order.order_number,
      refund: formatRefundRow(inserted)
    };
  });

  if (phase1.replayed) {
    return { replayed: true, refund: phase1.refund, message: refundStatusMessage(phase1.refund) };
  }

  // Phase 2: External MoMo Refund HTTP call (NO DB connection held)
  let providerOutcome = null;
  let transportError = null;
  try {
    providerOutcome = await refundGatewayPayment('momo', phase1.settings, {
      originalOrderId: phase1.orderNumber,
      refundOrderId: phase1.refund.refundOrderId,
      requestId: phase1.refund.requestId,
      originalTransId: Number(phase1.refund.originalTransId),
      amountVnd: phase1.refund.amountVnd,
      description: phase1.refund.description,
      transGroup,
      fetcher: fetcher || config?.paymentFetcher
    });
  } catch (err) {
    transportError = err;
  }

  // Phase 3: Persist authoritative outcome without clobbering concurrent query/reconciliation finalization
  const finalRefund = await withTransaction(pool, async (client) => {
    const nextStatus = providerOutcome ? providerOutcome.state : 'ambiguous';
    const nextResultCode = providerOutcome ? String(providerOutcome.resultCode) : (transportError?.code || 'PAYMENT_NETWORK_ERROR');
    const nextMessage = providerOutcome ? providerOutcome.message : 'Chưa nhận được phản hồi dứt khoát từ MoMo.';
    const nextRefundTransId = providerOutcome?.refundTransId || null;
    const completedAt = nextStatus === 'succeeded' ? new Date().toISOString() : null;

    const isTerminalPhase2 = nextStatus === 'succeeded' || nextStatus === 'failed';
    const updated = (await client.query(
      `UPDATE momo_refunds
       SET status = $2,
           refund_trans_id = COALESCE($3, refund_trans_id),
           result_code = $4,
           provider_message = $5,
           refund_trans_snapshot = COALESCE($6::jsonb, refund_trans_snapshot),
           last_checked_at = now(),
           completed_at = COALESCE(completed_at, $7::timestamptz),
           updated_at = now()
       WHERE id = $1 AND status = ANY($8::text[])
       RETURNING *`,
      [
        phase1.refund.id, nextStatus, nextRefundTransId, nextResultCode, nextMessage,
        providerOutcome?.transGroup ? JSON.stringify(providerOutcome.transGroup) : null,
        completedAt,
        isTerminalPhase2 ? ['pending_provider', 'ambiguous'] : ['pending_provider']
      ]
    )).rows[0];
    if (!updated) {
      const authoritative = (await client.query('SELECT * FROM momo_refunds WHERE id = $1', [phase1.refund.id])).rows[0];
      if (!authoritative) {
        throw fail('Bản ghi hoàn tiền MoMo không còn tồn tại để ghi nhận kết quả.', 409);
      }
      return formatRefundRow(authoritative);
    }

    await audit(client, {
      actor: actor || { username: 'owner', source: 'admin' },
      action: 'payment.momo.refund',
      entityType: 'order',
      entityId: phase1.orderId,
      metadata: {
        refundId: phase1.refund.id,
        refundOrderId: phase1.refund.refundOrderId,
        originalTransId: phase1.refund.originalTransId,
        refundTransId: nextRefundTransId,
        amountVnd: phase1.refund.amountVnd,
        status: nextStatus,
        resultCode: nextResultCode
      }
    });

    return formatRefundRow(updated);
  });

  try { require('./cache').invalidateTags(['orders', `order:${phase1.orderId}`, 'finance']); } catch (_) {}
  try {
    require('./realtime-sse').publishAdminEvent('order:update', {
      orderId: phase1.orderId,
      orderNumber: phase1.orderNumber,
      provider: 'momo',
      refundStatus: finalRefund.status,
      refundAmountVnd: finalRefund.amountVnd
    });
  } catch (_) {}

  return { replayed: false, refund: finalRefund, message: refundStatusMessage(finalRefund) };
}

async function queryMomoRefundStatus(pool, config, refundId, { actor = null, fetcher, audit = appendAudit } = {}) {
  const existing = (await pool.query('SELECT * FROM momo_refunds WHERE id = $1', [refundId])).rows[0];
  if (!existing) throw fail('Không tìm thấy lệnh hoàn tiền MoMo.', 404);
  if (existing.status === 'succeeded') {
    const formatted = formatRefundRow(existing);
    return { updated: false, refund: formatted, message: refundStatusMessage(formatted) };
  }

  const record = await resolveMomoSettings(pool, config);
  if (record.data.environment !== existing.environment) {
    throw fail('Môi trường cấu hình MoMo hiện tại khác với môi trường của lệnh hoàn tiền này.', 409);
  }

  const queried = await queryGatewayRefund('momo', record.data, {
    refundOrderId: existing.refund_order_id,
    amountVnd: Number(existing.amount_vnd),
    fetcher: fetcher || config?.paymentFetcher
  });

  const updatedRefund = await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:payment-config:momo'))");
    const current = await resolveMomoSettings(client, config);
    if (!sameMerchant(current.data, record.data)) {
      throw fail('Cấu hình merchant MoMo vừa thay đổi trong lúc tra cứu hoàn tiền.', 409, { code: 'PAYMENT_CONFIGURATION_CHANGED' });
    }
    const locked = (await client.query('SELECT * FROM momo_refunds WHERE id = $1 FOR UPDATE', [refundId])).rows[0];
    if (!locked) throw fail('Không tìm thấy lệnh hoàn tiền MoMo.', 404);
    if (locked.status === 'succeeded') return formatRefundRow(locked);

    // If found in refundTrans, apply its authoritative status; if not found with non-final code (e.g. 42), keep ambiguous/pending.
    let nextStatus = locked.status;
    if (queried.found) {
      nextStatus = queried.state;
    } else if (queried.state === 'failed') {
      nextStatus = 'failed';
    } else if (locked.status === 'pending_provider') {
      nextStatus = 'ambiguous';
    }
    const completedAt = nextStatus === 'succeeded' ? new Date().toISOString() : null;
    const row = (await client.query(
      `UPDATE momo_refunds
       SET status = $2,
           refund_trans_id = COALESCE($3, refund_trans_id),
           result_code = $4,
           provider_message = $5,
           refund_trans_snapshot = COALESCE($6::jsonb, refund_trans_snapshot),
           last_checked_at = now(),
           completed_at = COALESCE(completed_at, $7::timestamptz),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        refundId, nextStatus, queried.refundTransId || null,
        String(queried.resultCode), queried.message || locked.provider_message || '',
        queried.refundTrans?.length ? JSON.stringify(queried.refundTrans) : null,
        completedAt
      ]
    )).rows[0];

    await audit(client, {
      actor: actor || { username: 'momo', source: 'payment_gateway' },
      action: 'payment.momo.refund.query',
      entityType: 'order',
      entityId: locked.order_id,
      metadata: {
        refundId: locked.id,
        refundOrderId: locked.refund_order_id,
        found: queried.found,
        previousStatus: locked.status,
        status: nextStatus,
        resultCode: String(queried.resultCode),
        refundTransId: queried.refundTransId || null
      }
    });

    return formatRefundRow(row);
  });

  if (updatedRefund.status === 'succeeded') {
    try { require('./cache').invalidateTags(['orders', `order:${updatedRefund.orderId}`, 'finance']); } catch (_) {}
  }

  return { updated: true, found: queried.found, refund: updatedRefund, message: refundStatusMessage(updatedRefund) };
}

async function listMomoRefunds(pool, { orderNumber = '' } = {}) {
  const cleanOrder = String(orderNumber || '').trim().toUpperCase();
  const rows = cleanOrder
    ? (await pool.query(
      `SELECT * FROM momo_refunds
       WHERE order_number = $1 OR replace(order_number, '-', '') = replace($1, '-', '')
       ORDER BY created_at DESC LIMIT 50`,
      [cleanOrder]
    )).rows
    : (await pool.query('SELECT * FROM momo_refunds ORDER BY created_at DESC LIMIT 50')).rows;

  const refunds = rows.map(formatRefundRow);
  const summary = {
    totalSucceededVnd: refunds.filter(r => r.status === 'succeeded').reduce((s, r) => s + r.amountVnd, 0),
    totalPendingVnd: refunds.filter(r => ['pending', 'pending_provider', 'ambiguous'].includes(r.status)).reduce((s, r) => s + r.amountVnd, 0)
  };
  return { refunds, summary };
}

async function reconcileNextMomoRefund(pool, config, options = {}) {
  // Atomically claim due pending/ambiguous refunds AND crashed pending_provider rows older than 2 minutes.
  const row = (await pool.query(
    `UPDATE momo_refunds SET last_checked_at = now(), updated_at = now()
     WHERE id = (
       SELECT id FROM momo_refunds
       WHERE created_at > now() - interval '72 hours'
         AND (
           (status IN ('pending', 'ambiguous') AND (last_checked_at IS NULL OR last_checked_at <= now() - interval '2 minutes'))
           OR (status = 'pending_provider' AND created_at <= now() - interval '2 minutes' AND (last_checked_at IS NULL OR last_checked_at <= now() - interval '2 minutes'))
         )
       ORDER BY COALESCE(last_checked_at, created_at) ASC
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     RETURNING id`
  )).rows[0];
  if (!row) return { checked: false };
  try {
    const res = await queryMomoRefundStatus(pool, config, row.id, { fetcher: options.fetcher || config?.paymentFetcher, audit: options.audit });
    return { checked: true, refund: res.refund };
  } catch (error) {
    return { checked: true, error: error.code || 'REFUND_QUERY_ERROR' };
  }
}

module.exports = {
  UNSETTLED_MOMO_REFUND_STATUSES,
  getOrderRefundLedger,
  initiateMomoRefund,
  queryMomoRefundStatus,
  listMomoRefunds,
  reconcileNextMomoRefund,
  generateRefundOrderId
};
