'use strict';
const { randomUUID } = require('node:crypto');
const { withTransaction } = require('./db');
const { readChannelRecord, reconcilePrepaidOrder } = require('./payment-channels');
const { queryGatewayPayment } = require('./payment-provider-clients');
const { invalidateTags } = require('./cache');
const { FINAL_FAILURE_CODES } = require('./momo-protocol');

const sameMerchant = (a, b) => ['partnerCode', 'accessKey', 'secretKey', 'environment'].every(key => a[key] === b[key]);
const retrySchedule = `CASE WHEN created_at > now() - interval '1 hour' THEN interval '30 seconds'
 WHEN created_at > now() - interval '1 day' THEN interval '5 minutes' ELSE interval '1 hour' END`;

const ABANDONED_UNRESOLVED_GRACE_MS = 2 * 60 * 60 * 1000;

async function reconcileNextMomoPayment(pool, config, options = {}) {
  const token = randomUUID();
  const attempt = (await pool.query(
    `UPDATE payment_attempts SET status_check_token=$1, status_check_lease_until=now()+interval '60 seconds'
     WHERE id=(SELECT p.id FROM payment_attempts p JOIN orders o ON o.id=p.order_id
       WHERE p.provider='momo' AND p.status<>'paid' AND o.payment_status<>'paid' AND o.return_completed_at IS NULL
         AND COALESCE(p.expires_at, p.created_at) > now() - interval '72 hours'
         AND COALESCE(p.status_check_error, '') <> 'PAYMENT_SESSION_EXPIRED'
         AND (p.status='pending' OR p.response_code IS NULL OR NOT (p.response_code=ANY($2::text[])))
         AND p.provider_request_id IS NOT NULL
         AND p.next_status_check_at IS NOT NULL AND p.next_status_check_at<=now()
         AND (p.status_check_lease_until IS NULL OR p.status_check_lease_until<now())
       ORDER BY p.next_status_check_at, p.id FOR UPDATE OF p SKIP LOCKED LIMIT 1)
     RETURNING id, transaction_ref, provider_request_id, amount_vnd`, [token, FINAL_FAILURE_CODES.map(String)]
  )).rows[0];
  if (!attempt) return { checked: false };

  try {
    const record = await readChannelRecord(pool, config, 'momo');
    if (!record.version || !record.data.secretKey || (config.NODE_ENV === 'production' && record.data.environment !== 'production')) {
      throw Object.assign(new Error('MoMo configuration unavailable'), { code: 'PAYMENT_CONFIGURATION_INVALID' });
    }
    // Disabled checkout still reconciles existing payments. No DB connection is
    // retained while awaiting the provider; the lease recovers after a crash.
    const result = await queryGatewayPayment('momo', record.data, {
      txnRef: attempt.transaction_ref, requestId: attempt.provider_request_id,
      amountVnd: attempt.amount_vnd, fetcher: options.fetcher || config.paymentFetcher
    });
    // A portal refund can precede a delayed query. It needs reconciliation,
    // not a new full-value receipt or automatic fulfillment.
    if (result.hasRefund) throw Object.assign(new Error('MoMo refund needs reconciliation'), { code: 'PAYMENT_QUERY_REFUNDED' });
    const outcome = await withTransaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:payment-config:momo'))");
      const current = await readChannelRecord(client, config, 'momo');
      if (!sameMerchant(current.data, record.data)) throw Object.assign(new Error('MoMo configuration changed'), { code: 'PAYMENT_CONFIGURATION_CHANGED' });
      const claim = (await client.query('SELECT status, response_code, expires_at FROM payment_attempts WHERE id=$1 AND status_check_token=$2 FOR UPDATE', [attempt.id, token])).rows[0];
      if (!claim) return null;
      let settled = null;
      if (result.found && claim.status !== 'paid') {
        settled = await reconcilePrepaidOrder(client, {
          provider: 'momo', orderNumber: attempt.transaction_ref, amountVnd: result.amountVnd,
          successful: result.successful, pending: result.state === 'pending',
          providerTransactionId: result.providerTransactionId, responseCode: String(result.resultCode),
          providerMeta: result.providerMeta || null,
          finance: options.finance || require('./finance-api'), audit: options.audit,
          evidence: 'query'
        });
        if (!settled.matched) throw Object.assign(new Error('MoMo transaction mismatch'), { code: 'PAYMENT_RESPONSE_MISMATCH' });
      }
      const isTerminalFound = result.found && (result.successful || FINAL_FAILURE_CODES.includes(Number(result.resultCode)));
      const expiresMs = claim.expires_at ? new Date(claim.expires_at).getTime() : NaN;
      const isAbandonedUnfound = !result.found && claim.status !== 'paid' && !claim.response_code
        && Number.isFinite(expiresMs) && expiresMs <= Date.now() - ABANDONED_UNRESOLVED_GRACE_MS;
      if (isAbandonedUnfound) {
        await client.query(
          `UPDATE payment_attempts
           SET status=CASE WHEN status='pending' THEN 'failed' ELSE status END,
               status_check_token=NULL, status_check_lease_until=NULL,
               last_status_check_at=now(), status_check_error='PAYMENT_SESSION_EXPIRED',
               next_status_check_at=NULL, updated_at=now()
           WHERE id=$1 AND status_check_token=$2`,
          [attempt.id, token]
        );
      } else if (isTerminalFound || claim.status === 'paid') {
        await client.query(
          `UPDATE payment_attempts SET status_check_token=NULL,status_check_lease_until=NULL,
           last_status_check_at=now(),status_check_error=NULL,next_status_check_at=NULL
           WHERE id=$1 AND status_check_token=$2`,
          [attempt.id, token]
        );
      } else {
        await client.query(
          `UPDATE payment_attempts SET status_check_token=NULL,status_check_lease_until=NULL,
           last_status_check_at=now(),status_check_error=$3,next_status_check_at=now()+${retrySchedule}
           WHERE id=$1 AND status_check_token=$2`,
          [attempt.id, token, result.found ? null : 'PAYMENT_QUERY_UNRESOLVED']
        );
      }
      return settled;
    });
    if (outcome?.successful) {
      invalidateTags(['orders', `order:${outcome.orderId}`]);
      require('./realtime-sse').publishAdminEvent('order:update', {
        orderId: outcome.orderId, orderNumber: outcome.orderNumber, paymentStatus: outcome.paymentStatus,
        status: outcome.orderStatus, provider: 'momo'
      });
      if (!outcome.alreadyConfirmed) {
        try { require('./order-email').nudgeOrderEmailWorker(); } catch (_) {}
        try {
          require('./admin-notifications').notifyAdminPushBackground(pool, config, {
            requiredPermissions: ['orders.read'],
            title: 'Đã nhận thanh toán · ' + outcome.orderNumber,
            body: 'Đơn ' + outcome.orderNumber + ' đã đối soát thanh toán thành công qua MoMo.',
            target: 'orders',
            tag: 'order-paid-' + outcome.orderNumber,
            url: '/admin/#orders'
          });
        } catch (_) {}
      }
    }
    return { checked: true, found: result.found, state: result.state, outcome };
  } catch (error) {
    const code = /^PAYMENT_[A-Z_]{1,50}$/.test(error.code || '') ? error.code : 'PAYMENT_QUERY_ERROR';
    await pool.query(
      `UPDATE payment_attempts SET status_check_token=NULL,status_check_lease_until=NULL,
       last_status_check_at=now(),status_check_error=$3,next_status_check_at=now()+interval '5 minutes'
       WHERE id=$1 AND status_check_token=$2`, [attempt.id, token, code]
    );
    return { checked: true, error: code };
  }
}

function startMomoReconciliationWorker(pool, config) {
  let stopped = false;
  let timer;
  let running;
  const tick = async () => {
    try {
      // Bounded work; each row is claimed separately so another host can help.
      for (let i = 0; i < 20 && !stopped; i++) {
        if (!(await reconcileNextMomoPayment(pool, config)).checked) break;
      }
      const { reconcileNextMomoRefund } = require('./momo-refunds');
      for (let i = 0; i < 10 && !stopped; i++) {
        if (!(await reconcileNextMomoRefund(pool, config)).checked) break;
      }
    } catch {
      console.error('MoMo status reconciliation will retry after a database error.');
    } finally {
      if (!stopped) { timer = setTimeout(run, 30000); timer.unref?.(); }
    }
  };
  const run = () => { running = tick(); };
  run();
  return async () => { stopped = true; clearTimeout(timer); await running; };
}

module.exports = { reconcileNextMomoPayment, startMomoReconciliationWorker };
