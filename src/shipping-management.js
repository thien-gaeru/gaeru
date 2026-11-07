const { Router } = require('express');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { LRUCache } = require('lru-cache');
const { withTransaction } = require('./db');
const { requireCsrf } = require('./security');
const { requirePermission } = require('./staff-access');
const { readRecord } = require('./admin-configuration');
const { appendAudit } = require('./audit');
const crypto = require('node:crypto');
const { getAdapter, normalizeCarrierStatus, resolveViettelProvinceId, computeCarrierShipmentPricing, CARRIER_NAMES } = require('./shipping-adapters');
const { availableCarriers } = require('./shipping-choice');

const quoteCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 5 }); // 5 minutes TTL

function invalidateShippingQuoteCache() {
  quoteCache.clear();
}

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const CARRIER_TERMINAL_STATES = new Set(['delivered', 'returned', 'cancelled']);
const CARRIER_STAGE_RANK = Object.freeze({
  created: 1,
  picking: 2,
  delivering: 3,
  return_requested: 4,
  returning: 5,
  delivered: 10,
  returned: 10,
  cancelled: 10
});

function parseProviderEventTime(raw) {
  if (!raw) return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  const str = String(raw).trim();
  if (!str) return null;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(str);
  if (dmy) {
    const iso = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}T${(dmy[4] || '00').padStart(2, '0')}:${(dmy[5] || '00').padStart(2, '0')}:${(dmy[6] || '00').padStart(2, '0')}+07:00`;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function canAdvanceCarrierStatus(currentStatus, nextStatus, currentEventTime = null, nextEventTime = null) {
  if (!nextStatus || nextStatus === 'pending') return { allowed: false, reason: 'unsupported_status' };
  if (CARRIER_TERMINAL_STATES.has(currentStatus)) {
    return { allowed: false, reason: `terminal_${currentStatus}` };
  }
  if (currentStatus === 'cancel_reconciliation_required' && !CARRIER_TERMINAL_STATES.has(nextStatus)) {
    return { allowed: false, reason: 'reconciliation_locked' };
  }
  const curTime = parseProviderEventTime(currentEventTime);
  const nxtTime = parseProviderEventTime(nextEventTime);
  if (curTime && nxtTime && nxtTime.getTime() < curTime.getTime()) {
    return { allowed: false, reason: 'stale_event_timestamp' };
  }
  if (currentStatus === 'cancel_requested') {
    if (CARRIER_TERMINAL_STATES.has(nextStatus)) return { allowed: true };
    return { allowed: false, reason: 'cancel_in_flight' };
  }
  const curRank = CARRIER_STAGE_RANK[currentStatus] || 0;
  const nxtRank = CARRIER_STAGE_RANK[nextStatus] || 0;
  if (nxtRank < curRank) {
    return { allowed: false, reason: 'backward_transition' };
  }
  return { allowed: true };
}

const WEBHOOK_SECRET_KEY_RE = /^(?:token|secret|webhook_?secret|api_?key|authorization|auth|password|pass|passwd|signature|sig|mac|digest|access_?token|refresh_?token|client_?secret|private_?key)$/i;
const WEBHOOK_PHONE_KEY_RE = /(?:phone|tel|mobile|sdt|so_dien_thoai)$/i;
const WEBHOOK_EMAIL_KEY_RE = /email/i;
const WEBHOOK_PII_ADDR_NAME_KEY_RE = /(?:address|dia_chi|receiver_address|sender_address|fullname|full_name|customer_name|receiver_fullname|sender_fullname|receiver_name|sender_name)$/i;

function maskPhoneValue(val) {
  const s = String(val ?? '').trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return '[REDACTED_PHONE]';
  return digits.slice(0, 3) + '*****' + digits.slice(-2);
}

function maskEmailValue(val) {
  const s = String(val ?? '').trim();
  const at = s.indexOf('@');
  if (at <= 0) return '[REDACTED_EMAIL]';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  return (local[0] || '*') + '***@' + domain;
}

function maskFreeTextPii(str) {
  return String(str)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (m) => maskEmailValue(m))
    .replace(/(?:\+?84|0)\d{8,10}\b/g, (m) => maskPhoneValue(m));
}

function sanitizeWebhookPayload(payload, depth = 0) {
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (payload === null || payload === undefined) return payload;
  if (Array.isArray(payload)) {
    return payload.slice(0, 100).map((item) => sanitizeWebhookPayload(item, depth + 1));
  }
  if (typeof payload === 'string') {
    return maskFreeTextPii(payload);
  }
  if (typeof payload !== 'object') return payload;
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== null && typeof value === 'object') {
      out[key] = sanitizeWebhookPayload(value, depth + 1);
    } else if (WEBHOOK_SECRET_KEY_RE.test(key)) {
      out[key] = '[REDACTED_SECRET]';
    } else if (value !== null && value !== undefined && WEBHOOK_PHONE_KEY_RE.test(key)) {
      out[key] = maskPhoneValue(value);
    } else if (value !== null && value !== undefined && typeof value !== 'object' && WEBHOOK_EMAIL_KEY_RE.test(key)) {
      out[key] = maskEmailValue(value);
    } else if (value !== null && value !== undefined && typeof value !== 'object' && WEBHOOK_PII_ADDR_NAME_KEY_RE.test(key)) {
      const text = String(value).trim();
      out[key] = text.length <= 3 ? '[MASKED_PII]' : text.slice(0, 2) + '***' + text.slice(-2);
    } else {
      out[key] = sanitizeWebhookPayload(value, depth + 1);
    }
  }
  return out;
}

async function purgeExpiredCarrierWebhookEvents(pool, { retentionDays = 180, actor = { username: 'retention_worker', source: 'system' } } = {}) {
  const days = Math.floor(Number(retentionDays));
  if (!Number.isFinite(days) || days < 90) {
    throw fail('Thời hạn lưu giữ sự kiện webhook tối thiểu là 90 ngày theo chính sách kiểm toán.', 400);
  }
  return withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('gaeru.allow_webhook_retention_purge', 'on', true)");
    const deleted = await client.query(
      "DELETE FROM carrier_webhook_events WHERE received_at < now() - ($1::int * interval '1 day') RETURNING id",
      [days]
    );
    if (deleted.rowCount > 0) {
      await appendAudit(client, {
        actor,
        action: 'shipping.webhook.retention_purge',
        entityType: 'carrier_webhook_events',
        entityId: 'retention:' + days + 'd',
        metadata: { retentionDays: days, purgedCount: deleted.rowCount }
      });
    }
    return { purgedCount: deleted.rowCount, retentionDays: days };
  });
}

function signGuestTrackingToken(config, orderNumber, expiresAtMs = Date.now() + 7 * 24 * 60 * 60 * 1000) {
  const secret = String(config?.SESSION_SECRET || '');
  if (!secret || !orderNumber) throw fail('Thiếu cấu hình khóa ký token tra cứu.', 500);
  const exp = Math.floor(Number(expiresAtMs));
  const payload = `${String(orderNumber).trim()}.${exp}`;
  const sig = crypto.createHmac('sha256', secret).update('guest-tracking:' + payload).digest('base64url');
  return `${exp}.${sig}`;
}

function verifyGuestTrackingToken(config, orderNumber, token) {
  const secret = String(config?.SESSION_SECRET || '');
  if (!secret || !orderNumber || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(expStr);
  if (!Number.isSafeInteger(exp) || exp < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret).update(`guest-tracking:${String(orderNumber).trim()}.${exp}`).digest('base64url');
  const bufA = Buffer.from(sig, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  return bufA.byteLength === bufB.byteLength && crypto.timingSafeEqual(bufA, bufB);
}

async function getOrderForFulfillment(client, orderId) {
  const result = await client.query(
    `SELECT o.id, o.order_number AS "orderNumber", o.customer_id AS "customerId",
            o.customer_name AS "customerName", o.return_completed_at AS "returnCompletedAt",
            o.phone, o.email, o.address, o.city, o.note, o.status,
            o.payment_method AS "paymentMethod", o.payment_status AS "paymentStatus",
            o.subtotal_vnd AS "subtotalVnd", o.discount_vnd AS "discountVnd", o.shipping_fee_vnd AS "shippingFeeVnd",
            o.total_vnd AS "totalVnd",
            s.carrier_id AS "selectedCarrierId", s.carrier_name AS "selectedCarrierName"
     FROM orders o
     LEFT JOIN order_shipping_selection s ON s.order_id = o.id
     WHERE o.id = $1 FOR UPDATE OF o`,
    [orderId]
  );
  if (!result.rows.length) throw fail('Không tìm thấy đơn hàng.', 404);
  const order = result.rows[0];

  const itemsResult = await client.query(
    `SELECT product_name AS "productName", variant_name AS "variantName",
            sku, quantity, unit_price_vnd AS "priceVnd"
     FROM order_items WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  order.items = itemsResult.rows;
  return order;
}

async function createWaybill(pool, config, { orderId, carrierId, autoShip = false, actor, fetcher = fetch }) {
  const prepared = await withTransaction(pool, async client => {
    const order = await getOrderForFulfillment(client, orderId);

    if (order.status === 'cancelled') {
      throw fail('Không thể tạo vận đơn cho đơn hàng đã hủy.', 409);
    }
    if (order.returnCompletedAt) {
      throw fail('Đơn hàng đã hoàn trả xong; không thể tạo vận đơn mới.', 409);
    }
    if (order.status === 'completed') {
      throw fail('Đơn hàng đã hoàn tất giao hàng.', 409);
    }
    if (order.paymentMethod !== 'cod' && order.paymentStatus !== 'paid') {
      throw fail('Đơn trả trước phải hoàn tất thanh toán trước khi tạo vận đơn.', 409);
    }
    const openReview = await client.query(
      'SELECT 1 FROM order_reviews WHERE order_id = $1 AND resolved_at IS NULL LIMIT 1',
      [orderId]
    );
    if (openReview.rows.length > 0) {
      throw fail('Đơn hàng đang chờ xác minh; vui lòng hoàn tất đối chiếu trước khi tạo vận đơn.', 409);
    }

    // Idempotency check: Does an active shipment already exist?
    const existingShipment = await client.query(
      `SELECT * FROM carrier_shipments
       WHERE order_id = $1 AND status != 'cancelled'
       FOR UPDATE`,
      [orderId]
    );

    if (existingShipment.rows.length > 0) {
      const existing = existingShipment.rows[0];
      return {
        success: true,
        existing: true,
        message: 'Đơn hàng đã có mã vận đơn hoạt động.',
        shipment: {
          id: existing.id,
          orderId: existing.order_id,
          carrierId: existing.carrier_id,
          carrierName: CARRIER_NAMES[existing.carrier_id] || existing.carrier_id,
          trackingNumber: existing.tracking_number,
          carrierOrderId: existing.carrier_order_id,
          status: existing.status,
          shippingFeeVnd: existing.shipping_fee_vnd,
          codAmountVnd: existing.cod_amount_vnd,
          labelUrl: existing.label_url,
          createdAt: existing.created_at
        }
      };
    }

    const unresolved = (await client.query("SELECT id,status FROM carrier_shipment_attempts WHERE order_id=$1 AND status IN ('sending','unknown') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[orderId])).rows[0];
    if (unresolved) {
      throw fail('Yêu cầu tạo vận đơn '+unresolved.id+' đang xử lý hoặc chưa rõ kết quả. Đối chiếu trên hệ thống hãng trước khi cho phép tạo lại.',409);
    }

    const available = await availableCarriers(client,{lock:true});
    const targetCarrierId = carrierId || order.selectedCarrierId || available[0]?.id;
    if (!targetCarrierId || !available.some(c=>c.id===targetCarrierId)) throw fail('Hãng vận chuyển chưa được xác minh, đã tắt hoặc cấu hình vừa thay đổi.',409);
    const carrierRecord = await readRecord(client, config, 'shipping_' + targetCarrierId);
    if (!carrierRecord.data.secret) throw fail('Chưa cấu hình tài khoản API của hãng vận chuyển.',409);
    getAdapter(targetCarrierId);
    const attempt = (await client.query('INSERT INTO carrier_shipment_attempts(order_id,carrier_id,config_version) VALUES($1,$2,$3) RETURNING id',[order.id,targetCarrierId,carrierRecord.version])).rows[0];
    await appendAudit(client,{actor,action:'shipping.waybill.request',entityType:'order',entityId:order.id,metadata:{attemptId:attempt.id,carrierId:targetCarrierId,configVersion:carrierRecord.version}});
    return {order,targetCarrierId,settings:carrierRecord.data,attemptId:attempt.id};
  });
  if (prepared.existing) return prepared;
  const {order,targetCarrierId,settings,attemptId}=prepared;
  const pricing = computeCarrierShipmentPricing(order, settings);
  const codAmount = pricing.carrierCodCollectionVnd;
  const codSettlementStatus = codAmount > 0 ? 'unsettled' : 'not_applicable';
  let providerAcknowledged = false;
  try {
    const waybillResult = await getAdapter(targetCarrierId).createWaybill(settings, {
      ...order,
      codAmountVnd: codAmount,
      weightGrams: pricing.weightGrams,
      feePayer: pricing.feePayer
    }, {fetcher});
    providerAcknowledged = true;
    // Keep the provider reference even if the order transaction fails later.
    await pool.query("UPDATE carrier_shipment_attempts SET provider_result=$2,updated_at=now() WHERE id=$1 AND status='sending'",[attemptId,JSON.stringify(waybillResult)]);
    return await withTransaction(pool,async client=>{
      const currentOrder=await getOrderForFulfillment(client,orderId);
      if (JSON.stringify(currentOrder)!==JSON.stringify(order)) throw fail('Đơn hàng vừa thay đổi trong khi hãng xử lý. Cần đối soát vận đơn.',409);
      const attempt=(await client.query("SELECT id FROM carrier_shipment_attempts WHERE id=$1 AND status='sending' FOR UPDATE",[attemptId])).rows[0];
      if(!attempt) throw fail('Yêu cầu vận đơn không còn ở trạng thái chờ xác nhận.',409);
    const inserted = await client.query(
      `INSERT INTO carrier_shipments (
         order_id, carrier_id, tracking_number, carrier_order_id, label_url,
         status, shipping_fee_vnd, cod_amount_vnd, cod_settlement_status, tracking_history, metadata
       ) VALUES ($1, $2, $3, $4, $5, 'created', $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        order.id,
        targetCarrierId,
        waybillResult.trackingNumber,
        waybillResult.carrierOrderId,
        waybillResult.labelUrl,
        waybillResult.shippingFeeVnd,
        codAmount,
        codSettlementStatus,
        JSON.stringify([{
          timestamp: new Date().toISOString(),
          status: 'created',
          rawStatus: 'order_created',
          description: `Đã tạo vận đơn trên hệ thống ${CARRIER_NAMES[targetCarrierId] || targetCarrierId}`
        }]),
        JSON.stringify({ rawResponse: waybillResult.rawResponse || {} })
      ]
    );

    const shipment = inserted.rows[0];
    await client.query("UPDATE carrier_shipment_attempts SET status='succeeded',result='Hãng đã trả mã vận đơn; đã ghi vào đơn hàng',updated_at=now() WHERE id=$1 AND status='sending'",[attemptId]);

    // Transition order status
    const newStatus = autoShip ? 'shipped' : order.status === 'pending' || order.status === 'confirmed' ? 'processing' : order.status;
    if (newStatus !== order.status) {
      await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [order.id, newStatus]);
    }

    await appendAudit(client, {
      actor,
      action: 'shipping.waybill.create',
      entityType: 'order',
      entityId: order.id,
      metadata: {
        carrierId: targetCarrierId,
        trackingNumber: shipment.tracking_number,
        shippingFeeVnd: shipment.shipping_fee_vnd,
        codAmountVnd: shipment.cod_amount_vnd,
        orderStatus: newStatus
      }
    });

    return {
      success: true,
      existing: false,
      message: `Đã tạo vận đơn ${CARRIER_NAMES[targetCarrierId]} thành công: ${shipment.tracking_number}`,
      shipment: {
        id: shipment.id,
        orderId: shipment.order_id,
        carrierId: shipment.carrier_id,
        carrierName: CARRIER_NAMES[shipment.carrier_id] || shipment.carrier_id,
        trackingNumber: shipment.tracking_number,
        carrierOrderId: shipment.carrier_order_id,
        status: shipment.status,
        shippingFeeVnd: shipment.shipping_fee_vnd,
        codAmountVnd: shipment.cod_amount_vnd,
        labelUrl: shipment.label_url,
        createdAt: shipment.created_at
      }
    };
    });
  } catch (error) {
    if (!providerAcknowledged && (error.isCarrierRejected || error.status === 400 || error.status === 409)) {
      await pool.query("UPDATE carrier_shipment_attempts SET status='failed',result=$2,updated_at=now() WHERE id=$1 AND status='sending'",[attemptId, error.message || 'Hãng vận chuyển từ chối tạo đơn']).catch(()=>{});
      throw error;
    }
    const unknownResult = providerAcknowledged
      ? 'Hãng đã cấp mã vận đơn nhưng lỗi lưu cục bộ; cần đối soát khôi phục vận đơn đã có'
      : 'Chưa xác định kết quả; đối soát tại hãng trước khi tạo lại';
    await pool.query("UPDATE carrier_shipment_attempts SET status='unknown',result=$2,updated_at=now() WHERE id=$1 AND status='sending'",[attemptId, unknownResult]).catch(()=>{});
    throw fail('Chưa xác định kết quả tạo vận đơn. Yêu cầu '+attemptId+' đã khóa gửi lại; đối chiếu mã đơn '+order.orderNumber+' trên hệ thống hãng trước khi xử lý tiếp.',502);
  }
}

async function cancelWaybill(pool, config, { orderId, reason = 'Chủ shop hủy vận đơn', actor, fetcher = fetch }) {
  // Phase 1: Claim cancel_requested and fence status_version inside a short transaction
  const claimed = await withTransaction(pool, async client => {
    const locked = await client.query(
      `SELECT * FROM carrier_shipments
       WHERE order_id = $1 AND status != 'cancelled'
       ORDER BY created_at DESC LIMIT 1
       FOR UPDATE`,
      [orderId]
    );
    if (!locked.rows.length) {
      throw fail('Không tìm thấy vận đơn đang hoạt động để hủy.', 404);
    }
    const s = locked.rows[0];
    if (s.status === 'delivered') {
      throw fail('Vận đơn đã được hãng ghi nhận giao hàng thành công; không thể hủy vận đơn.', 409);
    }
    if (s.status === 'returned') {
      throw fail('Vận đơn đã hoàn trả về kho; không thể hủy vận đơn.', 409);
    }
    if (s.status === 'cancel_requested') {
      throw fail('Yêu cầu hủy vận đơn đang được xử lý. Vui lòng chờ phản hồi từ hãng.', 409);
    }
    if (s.status === 'cancel_reconciliation_required') {
      throw fail('Vận đơn đang có xung đột trạng thái hủy/giao hàng; cần đối soát thủ công trên hệ thống hãng.', 409);
    }
    const carrierRecord = await readRecord(client, config, 'shipping_' + s.carrier_id);
    const updated = (await client.query(
      `UPDATE carrier_shipments
       SET status = 'cancel_requested',
           status_version = status_version + 1,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('preCancelStatus', status),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [s.id]
    )).rows[0];
    return {
      shipmentId: updated.id,
      carrierId: updated.carrier_id,
      trackingNumber: updated.tracking_number,
      carrierOrderId: updated.carrier_order_id,
      previousStatus: s.status,
      claimedVersion: Number(updated.status_version),
      settings: carrierRecord.data
    };
  });

  const adapter = getAdapter(claimed.carrierId);
  try {
    await adapter.cancelWaybill(claimed.settings, {
      trackingNumber: claimed.trackingNumber,
      carrierOrderId: claimed.carrierOrderId,
      reason
    }, { fetcher });
  } catch (err) {
    const isDefinitive = Boolean(
      err &&
      !err.ambiguousCancelState &&
      !err.ambiguous &&
      (err.definitiveRejection || err.isCarrierRejected || err.status === 400 || err.status === 404)
    );
    if (isDefinitive) {
      // Roll back cancel_requested only when the carrier definitively rejected cancellation
      await withTransaction(pool, async client => {
        await client.query(
          `UPDATE carrier_shipments
           SET status = $3, status_version = status_version + 1, updated_at = now()
           WHERE id = $1 AND status = 'cancel_requested' AND status_version = $2`,
          [claimed.shipmentId, claimed.claimedVersion, claimed.previousStatus]
        );
      }).catch(() => {});
      throw err;
    }

    // P1-02: Network timeout / HTTP 5xx / ambiguous response -> lock into cancel_reconciliation_required (never revert for blind retry)
    await withTransaction(pool, async client => {
      const updatedAmb = await client.query(
        `UPDATE carrier_shipments
         SET status = 'cancel_reconciliation_required',
             status_version = status_version + 1,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'cancelAmbiguousAt', now(),
               'cancelAmbiguousError', $3::text
             ),
             updated_at = now()
         WHERE id = $1 AND status = 'cancel_requested' AND status_version = $2
         RETURNING id`,
        [claimed.shipmentId, claimed.claimedVersion, String(err?.message || 'ambiguous_cancel_timeout').slice(0, 300)]
      );
      if (updatedAmb.rowCount > 0) {
        await appendAudit(client, {
          actor: actor || { username: 'system', source: 'shipping_cancel' },
          action: 'shipping.waybill.cancel_ambiguous_timeout',
          entityType: 'order',
          entityId: orderId,
          metadata: {
            carrierId: claimed.carrierId,
            trackingNumber: claimed.trackingNumber,
            previousStatus: claimed.previousStatus,
            claimedVersion: claimed.claimedVersion,
            errorMessage: String(err?.message || 'ambiguous_cancel_timeout').slice(0, 300)
          }
        });
      }
    }).catch(() => {});
    throw Object.assign(
      fail('Kết quả hủy vận đơn tại hãng chưa xác định (timeout/mạng). Đã khóa vận đơn sang chế độ chờ đối soát thủ công (cancel_reconciliation_required) để tránh lệch trạng thái.', err?.status === 409 ? 409 : 502),
      { ambiguousCancelState: true }
    );
  }

  // Phase 3: Finalize cancellation only if version & status are still valid.
  // P1-01: Return { conflict: true } inside withTransaction so conflict status & audit_logs COMMIT before HTTP 409 is thrown!
  const outcome = await withTransaction(pool, async client => {
    const locked = await client.query(
      `SELECT * FROM carrier_shipments WHERE id = $1 FOR UPDATE`,
      [claimed.shipmentId]
    );
    if (!locked.rows.length) {
      throw fail('Không tìm thấy vận đơn đang hoạt động để hủy.', 404);
    }
    const shipment = locked.rows[0];
    if (shipment.status === 'cancelled') {
      return {
        success: true,
        cancelled: true,
        message: `Đã hủy vận đơn ${shipment.tracking_number} (${CARRIER_NAMES[shipment.carrier_id] || shipment.carrier_id}) thành công.`
      };
    }
    if (shipment.status === 'delivered' || shipment.status === 'returned') {
      await client.query(
        `UPDATE carrier_shipments
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('providerCancelAckAfterTerminal', true, 'providerCancelAckAt', now()),
             updated_at = now()
         WHERE id = $1`,
        [shipment.id]
      );
      await appendAudit(client, {
        actor: actor || { username: 'system', source: 'shipping_cancel' },
        action: 'shipping.waybill.cancel_conflict',
        entityType: 'order',
        entityId: orderId,
        metadata: {
          carrierId: shipment.carrier_id,
          trackingNumber: shipment.tracking_number,
          concurrentStatus: shipment.status,
          claimedVersion: claimed.claimedVersion,
          currentVersion: shipment.status_version
        }
      });
      return {
        conflict: true,
        status: 409,
        message: `Hãng vận chuyển đã cập nhật trạng thái "${shipment.status}" trong lúc yêu cầu hủy đang xử lý. Hệ thống giữ nguyên trạng thái "${shipment.status}" để bảo vệ đối soát tiền và hàng hóa.`
      };
    }
    if (shipment.status !== 'cancel_requested' || Number(shipment.status_version) !== claimed.claimedVersion) {
      await client.query(
        `UPDATE carrier_shipments
         SET status = 'cancel_reconciliation_required', status_version = status_version + 1, updated_at = now()
         WHERE id = $1`,
        [shipment.id]
      );
      await appendAudit(client, {
        actor: actor || { username: 'system', source: 'shipping_cancel' },
        action: 'shipping.waybill.cancel_reconciliation_required',
        entityType: 'order',
        entityId: orderId,
        metadata: {
          carrierId: shipment.carrier_id,
          trackingNumber: shipment.tracking_number,
          claimedVersion: claimed.claimedVersion,
          currentVersion: shipment.status_version,
          currentStatus: shipment.status
        }
      });
      return {
        conflict: true,
        status: 409,
        message: 'Trạng thái vận đơn đã thay đổi đồng thời khi gọi hủy hãng. Đã chuyển sang chế độ chờ đối soát thủ công (cancel_reconciliation_required).'
      };
    }

    const history = Array.isArray(shipment.tracking_history) ? [...shipment.tracking_history] : [];
    history.push({
      timestamp: new Date().toISOString(),
      status: 'cancelled',
      rawStatus: 'cancelled_by_shop',
      description: `Đã hủy vận đơn trên hệ thống hãng: ${reason}`
    });

    await client.query(
      `UPDATE carrier_shipments
       SET status = 'cancelled', status_version = status_version + 1, tracking_history = $2, updated_at = now()
       WHERE id = $1`,
      [shipment.id, JSON.stringify(history)]
    );

    await appendAudit(client, {
      actor,
      action: 'shipping.waybill.cancel',
      entityType: 'order',
      entityId: orderId,
      metadata: {
        carrierId: shipment.carrier_id,
        trackingNumber: shipment.tracking_number,
        reason
      }
    });

    return {
      success: true,
      cancelled: true,
      message: `Đã hủy vận đơn ${shipment.tracking_number} (${CARRIER_NAMES[shipment.carrier_id] || shipment.carrier_id}) thành công.`
    };
  });

  if (outcome && outcome.conflict) {
    throw fail(outcome.message, outcome.status || 409);
  }
  return outcome;
}

async function reconcileWaybillAttempt(client, { attemptId, reason, actor }) {
  const lookup=(await client.query('SELECT order_id FROM carrier_shipment_attempts WHERE id=$1',[attemptId])).rows[0];
  if(!lookup) throw fail('Không tìm thấy yêu cầu vận đơn.',404);
  await client.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[lookup.order_id]);
  const attempt=(await client.query("SELECT *,created_at<now()-interval '5 minutes' AS stale FROM carrier_shipment_attempts WHERE id=$1 FOR UPDATE",[attemptId])).rows[0];
  if(!['unknown','sending'].includes(attempt.status)||attempt.status==='sending'&&!attempt.stale) throw fail('Yêu cầu đang xử lý hoặc đã được đối soát. Chưa thể mở khóa.',409);
  if(attempt.provider_result?.trackingNumber) throw fail('Hãng đã trả mã vận đơn '+attempt.provider_result.trackingNumber+'. Không được mở khóa tạo lại; cần khôi phục vận đơn đã có.',409);
  if((await client.query("SELECT 1 FROM carrier_shipments WHERE order_id=$1 AND status!='cancelled'",[attempt.order_id])).rows.length) throw fail('Đơn đã có vận đơn hoạt động.',409);
  await client.query("UPDATE carrier_shipment_attempts SET status='reconciled',result=$2,updated_at=now() WHERE id=$1",[attemptId,reason]);
  await appendAudit(client,{actor,action:'shipping.waybill.reconcile_not_created',entityType:'order',entityId:attempt.order_id,metadata:{attemptId,reason,carrierId:attempt.carrier_id,manualConfirmation:true}});
  return {message:'Đã ghi nhận đối chiếu thủ công: hãng chưa có vận đơn. Thao tác này không gửi lại; bạn có thể chủ động tạo yêu cầu mới.'};
}

async function applyCarrierDeliveryTransition(client, shipment, newNormalizedStatus, actor) {
  let updatedOrderStatus = shipment.orderStatus;
  const isTerminalBlocked = shipment.orderStatus === 'cancelled' || Boolean(shipment.orderReturnCompletedAt);
  if (isTerminalBlocked) return updatedOrderStatus;

  const canAdvanceFulfillment = shipment.orderPaymentMethod === 'cod' || shipment.orderPaymentStatus === 'paid';
  if (!canAdvanceFulfillment) return updatedOrderStatus;

  if (newNormalizedStatus === 'delivering' && ['pending', 'confirmed', 'processing'].includes(shipment.orderStatus)) {
    updatedOrderStatus = 'shipped';
    await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [shipment.order_id, 'shipped']);
    return updatedOrderStatus;
  }

  if (newNormalizedStatus === 'delivered') {
    // P0-01: delivered chứng minh giao hàng thành công, KHÔNG chứng minh tiền COD đã chuyển về tài khoản GAERU.
    if (shipment.orderPaymentMethod === 'cod' && shipment.orderPaymentStatus !== 'paid') {
      if (['pending', 'confirmed', 'processing'].includes(shipment.orderStatus)) {
        updatedOrderStatus = 'shipped';
        await client.query(
          'UPDATE orders SET status = $2, delivered_at = COALESCE(delivered_at, now()), updated_at = now() WHERE id = $1',
          [shipment.order_id, 'shipped']
        );
      } else {
        await client.query(
          'UPDATE orders SET delivered_at = COALESCE(delivered_at, now()), updated_at = now() WHERE id = $1',
          [shipment.order_id]
        );
      }
      return updatedOrderStatus;
    }

    // Đơn trả trước đã paid (hoặc COD đã đối soát paid trước đó): chuyển thẳng sang completed và cộng Xu
    if (shipment.orderPaymentStatus === 'paid' && shipment.orderStatus !== 'completed') {
      updatedOrderStatus = 'completed';
      await client.query(
        'UPDATE orders SET status = $2, delivered_at = COALESCE(delivered_at, now()), updated_at = now() WHERE id = $1',
        [shipment.order_id, 'completed']
      );
      if (shipment.orderCustomerId && Number(shipment.orderTotalVnd) > 0) {
        const { earnPoints } = require('./loyalty-api');
        await earnPoints(client, {
          customerId: shipment.orderCustomerId,
          orderId: shipment.order_id,
          orderTotalVnd: Number(shipment.orderTotalVnd),
          actor: actor || { username: 'carrier_sync', source: 'shipping_worker' }
        });
      }
    }
  }

  return updatedOrderStatus;
}

function buildCodScopedKey(prefix, carrierId, txRef, orderId) {
  const safeCarrier = String(carrierId || '').replace(/[^A-Za-z0-9_-]/g, '');
  const safeTx = /^[A-Za-z0-9_.:-]{1,40}$/.test(txRef)
    ? txRef
    : crypto.createHash('sha256').update(txRef).digest('hex').slice(0, 28);
  return `${prefix}:${safeCarrier}:${safeTx}:${orderId}`;
}

async function settleSingleCarrierCodInTx(client, {
  orderId,
  expectedCarrierId = null,
  providerTransactionRef,
  settledAmountVnd,
  declaredPayoutVnd = null,
  method = 'bank_transfer',
  payoutPeriod = '',
  evidenceRef = '',
  settledAt = null,
  note = '',
  allowPreDeliveryOverride = false,
  overrideReason = '',
  skipOrderStatusUpdate = false,
  actor,
  finance
}) {
  const txRef = String(providerTransactionRef || '').trim();
  if (txRef.length < 4 || txRef.length > 120) {
    throw fail('Bắt buộc cung cấp mã giao dịch đối soát / sao kê chuyển tiền thực tế của hãng vận chuyển (tối thiểu 4 ký tự).', 400);
  }
  const amount = Number(settledAmountVnd);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw fail('Số tiền đối soát COD phải là số nguyên dương hợp lệ.', 400);
  }
  if (!['cash', 'bank_transfer'].includes(method)) {
    throw fail('Phương thức nhận tiền đối soát không hợp lệ.', 400);
  }
  if (declaredPayoutVnd !== null && declaredPayoutVnd !== undefined) {
    const dp = Number(declaredPayoutVnd);
    if (!Number.isSafeInteger(dp) || dp <= 0) {
      throw fail('Tổng tiền chứng từ chi trả (declaredPayoutVnd) phải là số nguyên dương.', 400);
    }
  }
  if (actor && actor.role !== 'owner' && Array.isArray(actor.permissions) && !actor.permissions.includes('payments.write')) {
    throw fail('Tài khoản cần quyền quản lý thanh toán (payments.write) để xác nhận đối soát tiền COD.', 403);
  }

  // P1-06: Pre-acquire advisory lock before row locks to ensure consistent locking hierarchy and prevent deadlocks
  const carrierPeek = expectedCarrierId || (await client.query("SELECT carrier_id FROM carrier_shipments WHERE order_id = $1 AND status != 'cancelled' LIMIT 1", [orderId])).rows[0]?.carrier_id || 'carrier';
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cod_batch:${carrierPeek}:${txRef}`]);

  const result = await client.query(
    `SELECT s.*, o.order_number AS "orderNumber", o.total_vnd AS "orderTotalVnd",
            o.customer_id AS "orderCustomerId", o.return_completed_at AS "orderReturnCompletedAt",
            o.payment_method AS "orderPaymentMethod", o.payment_status AS "orderPaymentStatus", o.status AS "orderStatus"
     FROM carrier_shipments s
     JOIN orders o ON o.id = s.order_id
     WHERE s.order_id = $1 AND s.status != 'cancelled'
     ORDER BY s.created_at DESC LIMIT 1
     FOR UPDATE OF s, o`,
    [orderId]
  );
  if (!result.rows.length) {
    throw fail('Không tìm thấy vận đơn hoạt động cho đơn hàng này.', 404);
  }
  const shipment = result.rows[0];
  if (expectedCarrierId && shipment.carrier_id !== expectedCarrierId) {
    throw fail(`Đơn hàng ${shipment.orderNumber} thuộc hãng ${shipment.carrier_id}, không khớp lô đối soát hãng ${expectedCarrierId}.`, 409);
  }
  if (shipment.orderPaymentMethod !== 'cod') {
    throw fail('Chỉ đối soát thu hộ cho đơn hàng thanh toán COD.', 409);
  }
  if (shipment.orderStatus === 'cancelled' || shipment.orderReturnCompletedAt) {
    throw fail('Đơn hàng đã hủy hoặc hoàn trả; không thể đối soát thu tiền COD.', 409);
  }

  const cleanEvidence = String(evidenceRef || '').trim();
  const cleanPayoutPeriod = String(payoutPeriod || '').trim();
  const cleanOverrideReason = String(overrideReason || '').trim();
  const isDelivered = shipment.status === 'delivered';

  // P1-04: Carrier COD MUST have shipment.status === 'delivered' unless owner explicitly approves pre-delivery override with evidence
  if (!isDelivered) {
    const validOwnerOverride = Boolean(
      allowPreDeliveryOverride === true &&
      actor?.role === 'owner' &&
      cleanOverrideReason.length >= 15 &&
      cleanEvidence.length >= 4
    );
    if (!validOwnerOverride) {
      throw fail(
        `Vận đơn hãng chưa ở trạng thái Đã giao hàng (hiện tại: ${shipment.status}). Vui lòng đồng bộ hành trình hoặc đối chiếu cổng hãng Đã giao trước khi đối soát tiền thu hộ COD.`,
        409
      );
    }
  }

  const settleActor = actor || { username: 'accountant', source: 'cod_settlement' };
  const allocKey = buildCodScopedKey('cod-alloc', shipment.carrier_id, txRef, orderId);
  const receiptKey = buildCodScopedKey('cod-settlement', shipment.carrier_id, txRef, orderId);

  // Check idempotency on cod_settlement_allocations first
  const existingAlloc = (await client.query(
    'SELECT * FROM cod_settlement_allocations WHERE order_id = $1',
    [orderId]
  )).rows[0];
  if (existingAlloc) {
    if (existingAlloc.request_key === allocKey && Number(existingAlloc.allocated_amount_vnd) === amount) {
      return {
        success: true,
        replayed: true,
        batchId: existingAlloc.batch_id,
        allocationId: existingAlloc.id,
        receiptId: existingAlloc.receipt_id,
        orderId,
        orderStatus: shipment.orderStatus,
        paymentStatus: 'paid',
        codSettlementStatus: 'settled',
        codAttestationLevel: shipment.cod_attestation_level || 'manually_attested'
      };
    }
    throw fail('Đơn hàng COD này đã được phân bổ đối soát thanh toán trước đó.', 409);
  }

  const parsedSettledAt = parseProviderEventTime(settledAt);
  const requestedDeclared = declaredPayoutVnd !== null && declaredPayoutVnd !== undefined ? Number(declaredPayoutVnd) : null;
  const candidateAttestation = (cleanEvidence.length >= 4 && requestedDeclared !== null)
    ? 'statement_verified'
    : 'manually_attested';

  // Load or create batch row
  let batch = (await client.query(
    'SELECT * FROM cod_settlement_batches WHERE carrier_id = $1 AND provider_transaction_ref = $2 FOR UPDATE',
    [shipment.carrier_id, txRef]
  )).rows[0];

  if (!batch) {
    batch = (await client.query(
      `INSERT INTO cod_settlement_batches (
         carrier_id, provider_transaction_ref, declared_payout_vnd, allocated_total_vnd,
         method, payout_period, evidence_ref, note, attestation_level, created_by, settled_at
       ) VALUES ($1, $2, $3, 0, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), $8, $9, COALESCE($10::timestamptz, now()))
       RETURNING *`,
      [
        shipment.carrier_id,
        txRef,
        requestedDeclared,
        method,
        cleanPayoutPeriod,
        cleanEvidence,
        String(note || '').trim(),
        candidateAttestation,
        settleActor.username || 'accountant',
        parsedSettledAt ? parsedSettledAt.toISOString() : null
      ]
    )).rows[0];
  } else if (requestedDeclared !== null) {
    if (batch.declared_payout_vnd !== null && Number(batch.declared_payout_vnd) !== requestedDeclared) {
      throw fail(
        `Tổng tiền chứng từ khai báo (${requestedDeclared} ₫) không khớp với tổng tiền đã khai báo của lô ${txRef} (${batch.declared_payout_vnd} ₫).`,
        409
      );
    }
    if (batch.declared_payout_vnd === null) {
      batch = (await client.query(
        'UPDATE cod_settlement_batches SET declared_payout_vnd = $2, updated_at = now() WHERE id = $1 RETURNING *',
        [batch.id, requestedDeclared]
      )).rows[0];
    }
  }

  const effectiveDeclared = batch.declared_payout_vnd !== null ? Number(batch.declared_payout_vnd) : null;
  if (effectiveDeclared !== null && Number(batch.allocated_total_vnd) + amount > effectiveDeclared) {
    throw fail(
      `Tổng tiền phân bổ (${Number(batch.allocated_total_vnd) + amount} ₫) vượt quá tổng tiền sao kê của lô ${txRef} (${effectiveDeclared} ₫).`,
      409
    );
  }

  const attestationLevel = ( (cleanEvidence.length >= 4 || Boolean(batch.evidence_ref)) && effectiveDeclared !== null )
    ? 'statement_verified'
    : 'manually_attested';

  const ledger = finance || require('./finance-api');
  const received = ledger.receiptTotal ? await ledger.receiptTotal(client, orderId) : 0;
  const isLegacyVerification = shipment.cod_settlement_status === 'verification_required';

  let receiptId = null;
  let wasLegacyVerified = false;

  if (isLegacyVerification && shipment.orderPaymentStatus === 'paid' && received >= Number(shipment.orderTotalVnd)) {
    // P0-01: Legacy COD order already paid & has receipt from old era; attest & link existing receipt without duplicating revenue!
    if (amount !== Number(shipment.orderTotalVnd)) {
      throw fail(`Số tiền xác minh lịch sử (${amount} ₫) không khớp tổng đơn COD (${shipment.orderTotalVnd} ₫).`, 409);
    }
    const existingOrderReceipt = (await client.query(
      'SELECT id FROM sales_receipts WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
      [orderId]
    )).rows[0];
    receiptId = existingOrderReceipt?.id || null;
    wasLegacyVerified = true;
  } else {
    if (shipment.cod_settlement_status === 'settled' || (!isLegacyVerification && shipment.orderPaymentStatus === 'paid')) {
      throw fail('Đơn hàng COD này đã được đối soát thanh toán trước đó.', 409);
    }
    const remaining = Number(shipment.orderTotalVnd) - received;
    if (amount !== remaining) {
      throw fail(`Số tiền đối soát (${amount} ₫) không khớp số tiền COD còn phải thu (${remaining} ₫).`, 409);
    }
    const settleNote = String(note || '').trim() || `Đối soát tiền thu hộ COD ${CARRIER_NAMES[shipment.carrier_id] || shipment.carrier_id} (${txRef})`;
    const receiptRow = await ledger.recordFullOrderPayment(client, {
      order: {
        id: orderId,
        order_number: shipment.orderNumber,
        payment_method: 'cod',
        total_vnd: Number(shipment.orderTotalVnd)
      },
      actor: settleActor,
      options: {
        requestKey: receiptKey,
        reference: txRef,
        method,
        note: settleNote
      }
    });
    receiptId = receiptRow?.id || null;
  }

  const insertedAlloc = (await client.query(
    `INSERT INTO cod_settlement_allocations (
       batch_id, order_id, shipment_id, allocated_amount_vnd, receipt_id,
       was_legacy_verified, request_key, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      batch.id,
      orderId,
      shipment.id,
      amount,
      receiptId,
      wasLegacyVerified,
      allocKey,
      settleActor.username || 'accountant'
    ]
  )).rows[0];

  await client.query(
    `UPDATE cod_settlement_batches
     SET allocated_total_vnd = allocated_total_vnd + $2,
         payout_period = COALESCE(NULLIF($3, ''), payout_period),
         evidence_ref = COALESCE(NULLIF($4, ''), evidence_ref),
         attestation_level = CASE WHEN $5 = 'statement_verified' THEN 'statement_verified' ELSE attestation_level END,
         updated_at = now()
     WHERE id = $1`,
    [batch.id, amount, cleanPayoutPeriod, cleanEvidence, attestationLevel]
  );

  let finalOrderStatus = shipment.orderStatus;
  if (!skipOrderStatusUpdate) {
    if (isDelivered) {
      finalOrderStatus = 'completed';
      await client.query(
        `UPDATE orders
         SET payment_status = 'paid', status = 'completed', delivered_at = COALESCE(delivered_at, now()), updated_at = now()
         WHERE id = $1`,
        [orderId]
      );
      if (shipment.orderCustomerId && Number(shipment.orderTotalVnd) > 0) {
        const { earnPoints } = require('./loyalty-api');
        await earnPoints(client, {
          customerId: shipment.orderCustomerId,
          orderId,
          orderTotalVnd: Number(shipment.orderTotalVnd),
          actor: settleActor
        });
      }
    } else {
      // Pre-delivery owner override: record payment ONLY, never force order status to completed before physical delivery!
      await client.query(
        `UPDATE orders SET payment_status = 'paid', updated_at = now() WHERE id = $1`,
        [orderId]
      );
    }
  }

  await client.query("UPDATE payment_attempts SET status = 'paid', updated_at = now() WHERE order_id = $1 AND status = 'pending'", [orderId]);
  await client.query(
    `UPDATE carrier_shipments
     SET cod_settlement_status = 'settled',
         cod_settled_at = COALESCE($2::timestamptz, now()),
         cod_settlement_ref = $3,
         cod_attestation_level = $4,
         cod_attested_by = $5,
         cod_evidence_ref = COALESCE(NULLIF($6, ''), cod_evidence_ref),
         cod_payout_period = COALESCE(NULLIF($7, ''), cod_payout_period),
         updated_at = now()
     WHERE id = $1`,
    [
      shipment.id,
      parsedSettledAt ? parsedSettledAt.toISOString() : null,
      txRef,
      attestationLevel,
      settleActor.username || 'accountant',
      cleanEvidence,
      cleanPayoutPeriod
    ]
  );

  await appendAudit(client, {
    actor: settleActor,
    action: wasLegacyVerified ? 'shipping.cod.verify_legacy' : 'shipping.cod.settle',
    entityType: 'order',
    entityId: orderId,
    metadata: {
      batchId: batch.id,
      allocationId: insertedAlloc.id,
      carrierId: shipment.carrier_id,
      trackingNumber: shipment.tracking_number,
      providerTransactionRef: txRef,
      settledAmountVnd: amount,
      declaredPayoutVnd: effectiveDeclared,
      payoutPeriod: cleanPayoutPeriod || null,
      evidenceRef: cleanEvidence || null,
      attestationLevel,
      wasLegacyVerified,
      preDeliveryOverride: !isDelivered ? { approvedBy: settleActor.username, reason: cleanOverrideReason } : null,
      method,
      receiptId
    }
  });

  return {
    success: true,
    replayed: false,
    batchId: batch.id,
    allocationId: insertedAlloc.id,
    receiptId,
    wasLegacyVerified,
    orderId,
    orderStatus: finalOrderStatus,
    paymentStatus: 'paid',
    codSettlementStatus: 'settled',
    codAttestationLevel: attestationLevel
  };
}

async function settleCarrierCod(pool, options) {
  return withTransaction(pool, async (client) => settleSingleCarrierCodInTx(client, options));
}

async function settleCarrierCodBatch(pool, {
  carrierId,
  providerTransactionRef,
  declaredPayoutVnd,
  method = 'bank_transfer',
  payoutPeriod = '',
  evidenceRef = '',
  settledAt = null,
  note = '',
  allocations = [],
  actor,
  finance
}) {
  if (!Array.isArray(allocations) || allocations.length === 0 || allocations.length > 100) {
    throw fail('Danh sách phân bổ lô đối soát COD phải từ 1 đến 100 đơn hàng.', 400);
  }
  const uniqueOrderIds = new Set(allocations.map((a) => a.orderId));
  if (uniqueOrderIds.size !== allocations.length) {
    throw fail('Danh sách phân bổ chứa mã đơn hàng bị trùng lặp trong cùng một yêu cầu.', 400);
  }
  const dp = Number(declaredPayoutVnd);
  if (!Number.isSafeInteger(dp) || dp <= 0) {
    throw fail('Bắt buộc nhập tổng số tiền nhận thực tế trên sao kê (declaredPayoutVnd > 0) khi đối soát theo lô.', 400);
  }
  const requestedSum = allocations.reduce((sum, item) => sum + (Number(item.amountVnd) || 0), 0);
  if (requestedSum > dp) {
    throw fail(`Tổng số tiền các đơn chọn đối soát (${requestedSum} ₫) vượt quá tổng tiền sao kê khai báo (${dp} ₫).`, 409);
  }

  return withTransaction(pool, async (client) => {
    const sorted = [...allocations].sort((a, b) => String(a.orderId).localeCompare(String(b.orderId)));
    const results = [];
    for (const item of sorted) {
      const res = await settleSingleCarrierCodInTx(client, {
        orderId: item.orderId,
        expectedCarrierId: carrierId || null,
        providerTransactionRef,
        settledAmountVnd: item.amountVnd,
        declaredPayoutVnd: dp,
        method,
        payoutPeriod,
        evidenceRef,
        settledAt,
        note,
        actor,
        finance
      });
      results.push(res);
    }
    const batchRow = (await client.query(
      'SELECT * FROM cod_settlement_batches WHERE id = $1',
      [results[0].batchId]
    )).rows[0];
    return {
      success: true,
      batch: {
        id: batchRow.id,
        carrierId: batchRow.carrier_id,
        providerTransactionRef: batchRow.provider_transaction_ref,
        declaredPayoutVnd: Number(batchRow.declared_payout_vnd),
        allocatedTotalVnd: Number(batchRow.allocated_total_vnd),
        unallocatedVnd: Math.max(0, Number(batchRow.declared_payout_vnd) - Number(batchRow.allocated_total_vnd)),
        payoutPeriod: batchRow.payout_period,
        evidenceRef: batchRow.evidence_ref,
        attestationLevel: batchRow.attestation_level
      },
      allocations: results
    };
  });
}

async function listCodSettlements(pool, { carrierId = '', settlementStatus = '', q = '', limit = 100 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  const params = [];
  const conds = ['s.cod_amount_vnd > 0', "s.status <> 'cancelled'"];
  if (carrierId && ['viettel', 'jt', 'spx', 'ghn', 'ghtk'].includes(carrierId)) {
    params.push(carrierId);
    conds.push(`s.carrier_id = $${params.length}`);
  }
  if (settlementStatus && ['unsettled', 'verification_required', 'settled'].includes(settlementStatus)) {
    params.push(settlementStatus);
    conds.push(`s.cod_settlement_status = $${params.length}`);
  }
  const search = String(q || '').trim();
  if (search) {
    params.push(`%${search}%`);
    conds.push(`(o.order_number ILIKE $${params.length} OR s.tracking_number ILIKE $${params.length} OR COALESCE(s.cod_settlement_ref,'') ILIKE $${params.length})`);
  }
  params.push(safeLimit);

  const shipmentsRes = await pool.query(
    `SELECT s.id AS "shipmentId", s.order_id AS "orderId", o.order_number AS "orderNumber",
            o.customer_name AS "customerName", o.phone, o.status AS "orderStatus",
            o.payment_status AS "paymentStatus", o.total_vnd AS "orderTotalVnd",
            s.carrier_id AS "carrierId", s.tracking_number AS "trackingNumber",
            s.status AS "shipmentStatus", s.cod_amount_vnd AS "codAmountVnd",
            s.cod_settlement_status AS "codSettlementStatus",
            s.cod_settlement_ref AS "codSettlementRef",
            s.cod_attestation_level AS "codAttestationLevel",
            s.cod_attested_by AS "codAttestedBy",
            s.cod_evidence_ref AS "codEvidenceRef",
            s.cod_payout_period AS "codPayoutPeriod",
            s.cod_settled_at AS "codSettledAt",
            s.created_at AS "createdAt"
     FROM carrier_shipments s
     JOIN orders o ON o.id = s.order_id
     WHERE ${conds.join(' AND ')}
     ORDER BY CASE s.cod_settlement_status WHEN 'verification_required' THEN 0 WHEN 'unsettled' THEN 1 ELSE 2 END, s.created_at DESC
     LIMIT $${params.length}`,
    params
  );

  const summaryRes = await pool.query(
    `SELECT cod_settlement_status AS status,
            COUNT(*)::int AS count,
            COALESCE(SUM(cod_amount_vnd), 0)::bigint AS "amountVnd"
     FROM carrier_shipments
     WHERE cod_amount_vnd > 0 AND status <> 'cancelled'
     GROUP BY cod_settlement_status`
  );
  const summary = { unsettled: { count: 0, amountVnd: 0 }, verification_required: { count: 0, amountVnd: 0 }, settled: { count: 0, amountVnd: 0 } };
  for (const row of summaryRes.rows) {
    if (summary[row.status]) {
      summary[row.status] = { count: Number(row.count), amountVnd: Number(row.amountVnd) };
    }
  }

  const batchesRes = await pool.query(
    `SELECT id, carrier_id AS "carrierId", provider_transaction_ref AS "providerTransactionRef",
            declared_payout_vnd AS "declaredPayoutVnd", allocated_total_vnd AS "allocatedTotalVnd",
            method, payout_period AS "payoutPeriod", evidence_ref AS "evidenceRef",
            attestation_level AS "attestationLevel", created_by AS "createdBy",
            settled_at AS "settledAt", created_at AS "createdAt"
     FROM cod_settlement_batches
     ORDER BY created_at DESC LIMIT 30`
  );

  return {
    summary,
    shipments: shipmentsRes.rows.map((r) => ({
      ...r,
      orderTotalVnd: Number(r.orderTotalVnd || 0),
      codAmountVnd: Number(r.codAmountVnd || 0)
    })),
    batches: batchesRes.rows.map((b) => ({
      ...b,
      declaredPayoutVnd: b.declaredPayoutVnd !== null ? Number(b.declaredPayoutVnd) : null,
      allocatedTotalVnd: Number(b.allocatedTotalVnd || 0)
    }))
  };
}

async function confirmCarrierPortalStatus(pool, { orderId, targetStatus, evidenceNote, actor }) {
  if (!['delivered', 'cancelled'].includes(targetStatus)) {
    throw fail('Trạng thái đối chiếu cổng hãng chỉ hỗ trợ Đã giao hàng (delivered) hoặc Đã hủy (cancelled).', 400);
  }
  const cleanNote = String(evidenceNote || '').trim();
  if (cleanNote.length < 10 || cleanNote.length > 500) {
    throw fail('Vui lòng nhập ghi chú bằng chứng đối chiếu trên cổng hãng vận chuyển (tối thiểu 10 ký tự).', 400);
  }

  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `SELECT s.*, o.order_number AS "orderNumber", o.total_vnd AS "orderTotalVnd",
              o.customer_id AS "orderCustomerId", o.return_completed_at AS "orderReturnCompletedAt",
              o.payment_method AS "orderPaymentMethod", o.payment_status AS "orderPaymentStatus", o.status AS "orderStatus"
       FROM carrier_shipments s
       JOIN orders o ON o.id = s.order_id
       WHERE s.order_id = $1 AND s.status != 'cancelled'
       ORDER BY s.created_at DESC LIMIT 1
       FOR UPDATE OF s, o`,
      [orderId]
    );
    if (!result.rows.length) throw fail('Không tìm thấy vận đơn hoạt động cho đơn hàng này.', 404);
    const shipment = result.rows[0];

    if (shipment.status === targetStatus) {
      return { success: true, status: shipment.status, orderStatus: shipment.orderStatus, replayed: true };
    }
    if (CARRIER_TERMINAL_STATES.has(shipment.status)) {
      throw fail(`Vận đơn đã ở trạng thái kết thúc (${shipment.status}); không thể ghi đè sang ${targetStatus}.`, 409);
    }

    const history = Array.isArray(shipment.tracking_history) ? [...shipment.tracking_history] : [];
    history.push({
      timestamp: new Date().toISOString(),
      status: targetStatus,
      rawStatus: 'manual_portal_reconciliation',
      description: `Đối chiếu thủ công từ cổng hãng (${actor?.username || 'admin'}): ${cleanNote}`
    });

    await client.query(
      `UPDATE carrier_shipments
       SET status = $2,
           status_version = status_version + 1,
           carrier_status_raw = 'manual_portal_reconciliation',
           carrier_status_desc = $3,
           tracking_history = $4,
           last_synced_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [shipment.id, targetStatus, cleanNote, JSON.stringify(history)]
    );

    let updatedOrderStatus = shipment.orderStatus;
    if (targetStatus === 'delivered') {
      updatedOrderStatus = await applyCarrierDeliveryTransition(client, shipment, 'delivered', actor);
    }

    await appendAudit(client, {
      actor: actor || { username: 'admin', source: 'portal_reconciliation' },
      action: 'shipping.waybill.portal_reconcile',
      entityType: 'order',
      entityId: orderId,
      metadata: {
        carrierId: shipment.carrier_id,
        trackingNumber: shipment.tracking_number,
        previousStatus: shipment.status,
        targetStatus,
        evidenceNote: cleanNote,
        orderStatus: updatedOrderStatus
      }
    });

    return {
      success: true,
      status: targetStatus,
      orderStatus: updatedOrderStatus,
      message: targetStatus === 'delivered'
        ? `Đã xác nhận vận đơn ${shipment.tracking_number} ở trạng thái Đã giao hàng.`
        : `Đã xác nhận hủy vận đơn ${shipment.tracking_number} theo đối chiếu cổng hãng.`
    };
  });
}

async function syncShipmentTracking(pool, config, { orderId, trackingNumber, actor, fetcher = fetch }) {
  let preQuery, preParams;
  if (orderId) {
    preQuery = `SELECT s.*, o.order_number AS "orderNumber", o.status AS "orderStatus"
                FROM carrier_shipments s
                JOIN orders o ON o.id = s.order_id
                WHERE s.order_id = $1 AND s.status != 'cancelled'
                ORDER BY s.created_at DESC LIMIT 1`;
    preParams = [orderId];
  } else {
    preQuery = `SELECT s.*, o.order_number AS "orderNumber", o.status AS "orderStatus"
                FROM carrier_shipments s
                JOIN orders o ON o.id = s.order_id
                WHERE s.tracking_number = $1
                ORDER BY s.created_at DESC LIMIT 1`;
    preParams = [trackingNumber];
  }

  const preResult = await pool.query(preQuery, preParams);
  if (!preResult.rows.length) throw fail('Không tìm thấy vận đơn để đồng bộ.', 404);
  const preShipment = preResult.rows[0];

  const carrierRecord = await readRecord(pool, config, 'shipping_' + preShipment.carrier_id);
  const adapter = getAdapter(preShipment.carrier_id);

  const trackingData = await adapter.queryTracking(carrierRecord.data, {
    trackingNumber: preShipment.tracking_number,
    carrierOrderId: preShipment.carrier_order_id
  }, { fetcher });

  const newNormalizedStatus = trackingData.status;
  if (newNormalizedStatus === 'pending') {
    return { success: false, processed: false, trackingNumber: preShipment.tracking_number, orderStatus: preShipment.orderStatus, message: 'Hãng chưa trả trạng thái hành trình được hỗ trợ. Giữ nguyên dữ liệu hiện tại.' };
  }
  const latestHistoryEntry = Array.isArray(trackingData.history) && trackingData.history.length > 0
    ? trackingData.history[trackingData.history.length - 1]
    : null;
  const incomingEventTime = parseProviderEventTime(trackingData.eventTime || latestHistoryEntry?.timestamp || null);

  return withTransaction(pool, async client => {
    const result = await client.query(
      `SELECT s.*, o.order_number AS "orderNumber", o.total_vnd AS "orderTotalVnd",
              o.customer_id AS "orderCustomerId", o.return_completed_at AS "orderReturnCompletedAt",
              o.payment_method AS "orderPaymentMethod", o.payment_status AS "orderPaymentStatus", o.status AS "orderStatus"
       FROM carrier_shipments s
       JOIN orders o ON o.id = s.order_id
       WHERE s.id = $1
       FOR UPDATE OF s, o`,
      [preShipment.id]
    );
    if (!result.rows.length) throw fail('Không tìm thấy vận đơn để đồng bộ.', 404);
    const shipment = result.rows[0];
    const transitionCheck = canAdvanceCarrierStatus(shipment.status, newNormalizedStatus, shipment.provider_event_time, incomingEventTime);
    if (!transitionCheck.allowed) {
      return {
        success: true,
        processed: false,
        trackingNumber: shipment.tracking_number,
        status: shipment.status,
        orderStatus: shipment.orderStatus,
        reason: transitionCheck.reason,
        message: 'Bỏ qua dữ liệu đồng bộ cũ hoặc không hợp lệ so với trạng thái hiện tại.'
      };
    }

    const existingHistory = Array.isArray(shipment.tracking_history) ? shipment.tracking_history : [];
    const history = Array.isArray(trackingData.history) && trackingData.history.length >= existingHistory.length
      ? trackingData.history
      : [...existingHistory, {
          timestamp: (incomingEventTime || new Date()).toISOString(),
          status: newNormalizedStatus,
          rawStatus: String(trackingData.carrierStatusRaw || ''),
          description: trackingData.statusDescription || ''
        }];

    await client.query(
      `UPDATE carrier_shipments
       SET status = $2,
           status_version = status_version + 1,
           provider_event_time = COALESCE($6::timestamptz, provider_event_time),
           carrier_status_raw = $3,
           carrier_status_desc = $4,
           tracking_history = $5,
           last_synced_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [
        shipment.id,
        newNormalizedStatus,
        trackingData.carrierStatusRaw,
        trackingData.statusDescription,
        JSON.stringify(history),
        incomingEventTime ? incomingEventTime.toISOString() : null
      ]
    );

    const updatedOrderStatus = await applyCarrierDeliveryTransition(client, shipment, newNormalizedStatus, actor);

    await appendAudit(client, {
      actor,
      action: 'shipping.tracking.sync',
      entityType: 'order',
      entityId: shipment.order_id,
      metadata: {
        carrierId: shipment.carrier_id,
        trackingNumber: shipment.tracking_number,
        normalizedStatus: newNormalizedStatus,
        orderStatus: updatedOrderStatus
      }
    });

    return {
      success: true,
      processed: true,
      trackingNumber: shipment.tracking_number,
      status: newNormalizedStatus,
      statusDescription: trackingData.statusDescription,
      history,
      orderStatus: updatedOrderStatus
    };
  });
}

async function handleCarrierWebhook(pool, config, carrierId, payload, { headers = {}, actor = { username: 'carrier_webhook', source: 'webhook' } } = {}) {
  if (carrierId === 'jt') throw fail('Webhook J&T Việt Nam chưa được nghiệm thu chữ ký và bảng trạng thái. Không tự cập nhật đơn hàng.', 501);
  // Never accept public delivery/payment changes without a configured credential.
  {
    const carrierRecord = await readRecord(pool, config, 'shipping_' + carrierId);
    const expectedSecret = String(carrierRecord?.data?.webhookSecret || '').trim();
    if (!expectedSecret) throw fail('Webhook vận chuyển chưa được cấu hình xác thực.', 503);
    const authHeader = String(headers['authorization'] || headers['Authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    const candidate = String(
      headers['x-webhook-secret'] ||
      headers['x-carrier-token'] ||
      headers['token'] ||
      authHeader ||
      ''
    ).trim();
    const bufA = Buffer.from(candidate, 'utf8');
    const bufB = Buffer.from(expectedSecret, 'utf8');
    if (!candidate || bufA.byteLength !== bufB.byteLength || !crypto.timingSafeEqual(bufA, bufB)) {
      throw fail('Xác thực chữ ký/bí mật Webhook vận chuyển không hợp lệ.', 401);
    }
  }

  let trackingNumber = null;
  let rawStatus = null;
  let carrierOrderId = null;
  let providerEventId = null;
  let rawEventTime = null;
  let webhookDesc = payload.desc || payload.description || '';

  if (carrierId === 'viettel') {
    const vtp = payload && typeof payload.DATA === 'object' && payload.DATA !== null ? payload.DATA : payload;
    trackingNumber = vtp.ORDER_NUMBER || vtp.order_number;
    rawStatus = vtp.ORDER_STATUS ?? vtp.status;
    webhookDesc = vtp.NOTE || vtp.STATUS_NAME || webhookDesc;
    providerEventId = vtp.EVENT_ID || vtp.event_id || payload.event_id || null;
    rawEventTime = vtp.ORDER_STATUSDATE || vtp.DATE || vtp.timestamp || payload.timestamp || null;
  } else if (carrierId === 'jt') {
    trackingNumber = payload.billcode || payload.mailno;
    carrierOrderId = payload.txlogisticid;
    rawStatus = payload.scantype || payload.status;
    providerEventId = payload.event_id || payload.id || null;
    rawEventTime = payload.scantime || payload.timestamp || null;
  } else if (carrierId === 'spx') {
    trackingNumber = payload.tracking_number;
    rawStatus = payload.status;
    providerEventId = payload.event_id || payload.id || null;
    rawEventTime = payload.timestamp || payload.event_time || null;
  }

  if (!trackingNumber && !carrierOrderId) {
    return { success: false, reason: 'Webhook không chứa mã vận đơn hợp lệ.' };
  }

  const normalizedStatus = normalizeCarrierStatus(carrierId, rawStatus);
  if (normalizedStatus === 'pending') return { success: false, processed: false, reason: 'Trạng thái hành trình chưa được hỗ trợ; chưa cập nhật đơn hoặc thanh toán.' };

  const incomingEventTime = parseProviderEventTime(rawEventTime);
  const sanitizedPayload = sanitizeWebhookPayload(payload);

  return withTransaction(pool, async client => {
    const result = await client.query(
      `SELECT s.*, o.order_number AS "orderNumber", o.total_vnd AS "orderTotalVnd",
              o.customer_id AS "orderCustomerId", o.return_completed_at AS "orderReturnCompletedAt",
              o.payment_method AS "orderPaymentMethod", o.payment_status AS "orderPaymentStatus", o.status AS "orderStatus"
       FROM carrier_shipments s
       JOIN orders o ON o.id = s.order_id
       WHERE s.carrier_id = $1 AND (s.tracking_number = $2 OR s.carrier_order_id = $3)
       FOR UPDATE OF s, o`,
      [carrierId, trackingNumber || '', carrierOrderId || '']
    );

    if (!result.rows.length) {
      return { success: true, processed: false, reason: 'Vận đơn chưa tồn tại trong hệ thống GAERU.' };
    }

    const shipment = result.rows[0];
    const fingerprintSource = providerEventId
      ? `${carrierId}\0id\0${String(providerEventId).trim()}`
      : `${carrierId}\0${shipment.tracking_number}\0${String(rawStatus)}\0${incomingEventTime ? incomingEventTime.toISOString() : ''}\0${String(webhookDesc || '').trim()}`;
    const eventFingerprint = crypto.createHash('sha256').update(fingerprintSource).digest('hex');

    const transitionCheck = canAdvanceCarrierStatus(shipment.status, normalizedStatus, shipment.provider_event_time, incomingEventTime);

    const eventInsert = await client.query(
      `INSERT INTO carrier_webhook_events (
         carrier_id, tracking_number, event_fingerprint, provider_event_id,
         provider_event_time, normalized_status, raw_status, raw_payload, applied
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (carrier_id, tracking_number, event_fingerprint) DO NOTHING
       RETURNING id`,
      [
        carrierId,
        shipment.tracking_number,
        eventFingerprint,
        providerEventId ? String(providerEventId) : null,
        incomingEventTime ? incomingEventTime.toISOString() : null,
        normalizedStatus,
        String(rawStatus),
        JSON.stringify(sanitizedPayload),
        Boolean(transitionCheck.allowed)
      ]
    );

    if (!eventInsert.rows.length) {
      return {
        success: true,
        processed: false,
        duplicate: true,
        normalizedStatus: shipment.status,
        reason: 'Sự kiện webhook trùng lặp đã được xử lý trước đó.'
      };
    }

    if (!transitionCheck.allowed) {
      return {
        success: true,
        processed: false,
        normalizedStatus: shipment.status,
        reason: `Bỏ qua sự kiện webhook cũ hoặc không hợp lệ (${transitionCheck.reason}).`
      };
    }

    const history = Array.isArray(shipment.tracking_history) ? [...shipment.tracking_history] : [];
    history.push({
      timestamp: (incomingEventTime || new Date()).toISOString(),
      status: normalizedStatus,
      rawStatus: String(rawStatus),
      description: webhookDesc || `Cập nhật từ Webhook ${CARRIER_NAMES[carrierId] || carrierId}`
    });

    await client.query(
      `UPDATE carrier_shipments
       SET status = $2,
           status_version = status_version + 1,
           provider_event_time = COALESCE($6::timestamptz, provider_event_time),
           carrier_status_raw = $3,
           carrier_status_desc = $4,
           tracking_history = $5,
           last_synced_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [
        shipment.id,
        normalizedStatus,
        String(rawStatus),
        webhookDesc || '',
        JSON.stringify(history),
        incomingEventTime ? incomingEventTime.toISOString() : null
      ]
    );

    const updatedOrderStatus = await applyCarrierDeliveryTransition(client, shipment, normalizedStatus, actor);

    await appendAudit(client, {
      actor,
      action: 'shipping.webhook.receive',
      entityType: 'order',
      entityId: shipment.order_id,
      metadata: {
        carrierId,
        trackingNumber: shipment.tracking_number,
        rawStatus: String(rawStatus),
        normalizedStatus,
        orderStatus: updatedOrderStatus,
        codSettlementStatus: shipment.cod_settlement_status
      }
    });

    return {
      success: true,
      processed: true,
      normalizedStatus,
      orderStatus: updatedOrderStatus,
      codSettlementStatus: shipment.cod_settlement_status
    };
  });
}

async function quoteShippingFee(pool, config, { carrierId, city, district, address, weightGrams = 500, totalVnd = 0, codAmountVnd = 0, serviceCode = '', fetcher = fetch }) {
  const normCity = String(city || '').trim();
  const normDistrict = String(district || '').trim();
  const normAddress = String(address || '').trim();
  const normWeight = Math.max(1, Math.round(Number(weightGrams) || 500));
  const normTotal = Math.max(0, Math.round(Number(totalVnd) || 0));
  const normCod = Math.max(0, Math.round(Number(codAmountVnd) || 0));

  async function getFallbackFee() {
    const rateResult = await pool.query("SELECT setting_value, updated_at FROM store_settings WHERE setting_key = 'shipping_rates'");
    const rates = rateResult.rows[0]?.setting_value || {};
    const fallbackFee = require('../checkout-flow').shippingFee(rates, normCity);
    return {
      feeVnd: fallbackFee !== undefined ? fallbackFee : 30000,
      carrierId: carrierId || 'standard',
      carrierName: carrierId && CARRIER_NAMES[carrierId] ? CARRIER_NAMES[carrierId] : 'Giao hàng tiêu chuẩn',
      estimatedDays: 3,
      source: 'fallback_rate_table'
    };
  }

  if (carrierId) {
    // P1-06: Validate official Viettel province mapping upfront; never silently default unmapped cities to Hà Nội!
    if (carrierId === 'viettel') {
      resolveViettelProvinceId(normCity, { strict: true });
    }
    try {
      const record = await readRecord(pool, config, 'shipping_' + carrierId);
      if (!record.data || (!record.data.secretConfigured && !record.data.secret)) {
        return await getFallbackFee();
      }
      const canonicalQuoteKey = 'quote:' + crypto.createHash('sha256').update(JSON.stringify({
        carrierId,
        configVersion: Number(record.version || 0),
        defaultService: String(serviceCode || record.data.defaultService || ''),
        pickupAddress: String(record.data.pickupAddress || ''),
        city: normCity.toLocaleLowerCase('vi'),
        district: normDistrict.toLocaleLowerCase('vi'),
        address: normAddress.toLocaleLowerCase('vi'),
        weightGrams: normWeight,
        totalVnd: normTotal,
        codAmountVnd: normCod
      })).digest('hex');

      if (quoteCache.has(canonicalQuoteKey)) {
        return quoteCache.get(canonicalQuoteKey);
      }

      const adapter = getAdapter(carrierId);
      const quote = await adapter.quoteShippingFee(record.data, {
        city: normCity,
        district: normDistrict,
        address: normAddress,
        weightGrams: normWeight,
        totalVnd: normTotal,
        codAmountVnd: normCod
      }, { fetcher });

      const responseData = {
        feeVnd: quote.feeVnd,
        carrierId: quote.carrierId,
        carrierName: quote.carrierName,
        estimatedDays: quote.estimatedDays || 2,
        carrierService: quote.carrierService,
        codAmountVnd: normCod,
        source: 'carrier_realtime'
      };

      quoteCache.set(canonicalQuoteKey, responseData);
      return responseData;
    } catch (err) {
      if (err && err.status === 400) throw err;
      const fallback = await getFallbackFee();
      fallback.warning = 'Hãng vận chuyển phản hồi chậm, áp dụng bảng phí niêm yết theo tỉnh/thành.';
      return fallback;
    }
  }

  return getFallbackFee();
}

function createShippingManagement(pool, config, { fetcher, finance } = {}) {
  const resolveFetcher = () => fetcher || globalThis.fetch;
  const adminRouter = Router();
  const publicRouter = Router();

  adminRouter.post('/shipping/attempts/:id/reconcile', requirePermission('orders.write'), requireCsrf,
    rateLimit({windowMs:900000,limit:10,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res,next)=>{
      try {
        if(req.admin?.role!=='owner'||req.admin?.source!=='bootstrap'||!config.accountSecurity) throw fail('Chỉ chủ doanh nghiệp được đối soát yêu cầu vận đơn.',403);
        const attemptId=z.string().uuid().parse(req.params.id);
        const {reason}=z.object({reason:z.string().trim().min(20).max(500),confirmedNoWaybill:z.literal(true)}).parse(req.body);
        const result=await config.accountSecurity.authorize(req,(_a,client)=>reconcileWaybillAttempt(client,{attemptId,reason,actor:req.admin}));
        res.json(result);
      } catch(error) { if(error instanceof z.ZodError)return res.status(400).json({error:'Xác nhận đã đối chiếu tại hãng và nhập bằng chứng ít nhất 20 ký tự.'});next(error); }
    });

  // Admin routes
  adminRouter.post('/shipping/orders/:id/create-waybill',
    requirePermission('orders.write'),
    requireCsrf,
    rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const orderId = z.string().uuid().parse(req.params.id);
        if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'forceRetry') && req.body.forceRetry) {
          throw fail('Tham số forceRetry đã bị vô hiệu hóa để bảo vệ đối soát vận đơn. Chỉ chủ doanh nghiệp được mở khóa qua quy trình đối soát có xác thực mật khẩu.', 403);
        }
        const { carrierId, autoShip } = z.object({
          carrierId: z.enum(['viettel', 'jt', 'spx']).optional(),
          autoShip: z.boolean().optional()
        }).parse(req.body || {});

        const result = await createWaybill(pool, config, {
          orderId,
          carrierId,
          autoShip,
          actor: req.admin,
          fetcher: resolveFetcher()
        });
        res.json(result);
      } catch (e) {
        next(e);
      }
    }
  );

  adminRouter.post('/shipping/orders/:id/cancel-waybill',
    requirePermission('orders.write'),
    requireCsrf,
    rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const orderId = z.string().uuid().parse(req.params.id);
        const { reason } = z.object({
          reason: z.string().trim().max(300).optional()
        }).parse(req.body || {});

        const result = await cancelWaybill(pool, config, {
          orderId,
          reason,
          actor: req.admin,
          fetcher: resolveFetcher()
        });
        res.json(result);
      } catch (e) {
        next(e);
      }
    }
  );

  adminRouter.post('/shipping/orders/:id/sync-tracking',
    requirePermission('orders.write'),
    requireCsrf,
    rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const orderId = z.string().uuid().parse(req.params.id);
        const result = await syncShipmentTracking(pool, config, {
          orderId,
          actor: req.admin,
          fetcher,
          finance
        });
        res.json(result);
      } catch (e) {
        next(e);
      }
    }
  );

  adminRouter.get('/shipping/cod-settlements',
    (req, res, next) => {
      const perms = req.admin?.permissions;
      if (req.admin?.role === 'owner' || (Array.isArray(perms) && (perms.includes('orders.read') || perms.includes('finance.read') || perms.includes('payments.write')))) {
        return next();
      }
      return res.status(403).json({ error: 'Tài khoản không có quyền xem danh sách đối soát COD.' });
    },
    async (req, res, next) => {
      try {
        const data = await listCodSettlements(pool, {
          carrierId: String(req.query.carrierId || '').trim(),
          settlementStatus: String(req.query.settlementStatus || '').trim(),
          q: String(req.query.q || '').trim(),
          limit: Number(req.query.limit || 100)
        });
        res.json(data);
      } catch (e) {
        next(e);
      }
    }
  );

  adminRouter.post('/shipping/cod-settlements/batch',
    requirePermission('payments.write'),
    requireCsrf,
    rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const body = z.object({
          carrierId: z.enum(['viettel', 'jt', 'spx', 'ghn', 'ghtk']).optional(),
          providerTransactionRef: z.string().trim().min(4).max(120),
          declaredPayoutVnd: z.number().int().positive().max(20_000_000_000),
          method: z.enum(['cash', 'bank_transfer']).optional().default('bank_transfer'),
          payoutPeriod: z.string().trim().max(80).optional().default(''),
          evidenceRef: z.string().trim().max(200).optional().default(''),
          settledAt: z.string().trim().max(64).optional(),
          note: z.string().trim().max(500).optional().default(''),
          allocations: z.array(z.object({
            orderId: z.string().uuid(),
            amountVnd: z.number().int().positive().max(2_000_000_000)
          }).strict()).min(1).max(100)
        }).strict().parse(req.body || {});

        const result = await settleCarrierCodBatch(pool, {
          ...body,
          actor: req.admin,
          finance
        });
        require('./cache').invalidateTags(['orders', ...body.allocations.map((a) => `order:${a.orderId}`)]);
        res.json(result);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return res.status(400).json({ error: 'Nhập đầy đủ mã giao dịch sao kê, tổng tiền chứng từ và danh sách đơn phân bổ hợp lệ.' });
        }
        next(e);
      }
    }
  );

  adminRouter.post('/shipping/orders/:id/confirm-carrier-status',
    requirePermission('orders.write'),
    requireCsrf,
    rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const orderId = z.string().uuid().parse(req.params.id);
        const body = z.object({
          targetStatus: z.enum(['delivered', 'cancelled']),
          evidenceNote: z.string().trim().min(10).max(500)
        }).strict().parse(req.body || {});
        const result = await confirmCarrierPortalStatus(pool, {
          orderId,
          targetStatus: body.targetStatus,
          evidenceNote: body.evidenceNote,
          actor: req.admin
        });
        require('./cache').invalidateTags(['orders', `order:${orderId}`]);
        res.json(result);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return res.status(400).json({ error: 'Chọn trạng thái đối chiếu và nhập ghi chú bằng chứng tối thiểu 10 ký tự.' });
        }
        next(e);
      }
    }
  );

  adminRouter.post('/shipping/orders/:id/settle-cod',
    requirePermission('payments.write'),
    requireCsrf,
    rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const orderId = z.string().uuid().parse(req.params.id);
        const body = z.object({
          providerTransactionRef: z.string().trim().min(4).max(120),
          settledAmountVnd: z.number().int().positive().max(2_000_000_000),
          declaredPayoutVnd: z.number().int().positive().max(20_000_000_000).optional(),
          method: z.enum(['cash', 'bank_transfer']).optional().default('bank_transfer'),
          payoutPeriod: z.string().trim().max(80).optional().default(''),
          evidenceRef: z.string().trim().max(200).optional().default(''),
          settledAt: z.string().trim().max(64).optional(),
          note: z.string().trim().max(500).optional().default(''),
          allowPreDeliveryOverride: z.boolean().optional().default(false),
          overrideReason: z.string().trim().max(500).optional().default('')
        }).strict().parse(req.body || {});
        const result = await settleCarrierCod(pool, {
          orderId,
          ...body,
          actor: req.admin,
          finance
        });
        require('./cache').invalidateTags(['orders', `order:${orderId}`]);
        res.json(result);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return res.status(400).json({ error: 'Nhập đầy đủ mã giao dịch đối soát hãng (tối thiểu 4 ký tự) và số tiền COD thực nhận.' });
        }
        next(e);
      }
    }
  );

  adminRouter.get('/shipping/orders/:id/shipment',
    requirePermission('orders.read'),
    async (req, res, next) => {
      try {
        const orderId = z.string().uuid().parse(req.params.id);
        const result = await pool.query(
          `SELECT * FROM carrier_shipments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [orderId]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Đơn hàng chưa có thông tin vận đơn.' });
        const row = result.rows[0];
        res.json({
          id: row.id,
          orderId: row.order_id,
          carrierId: row.carrier_id,
          carrierName: CARRIER_NAMES[row.carrier_id] || row.carrier_id,
          trackingNumber: row.tracking_number,
          carrierOrderId: row.carrier_order_id,
          labelUrl: row.label_url,
          status: row.status,
          carrierStatusRaw: row.carrier_status_raw,
          carrierStatusDesc: row.carrier_status_desc,
          shippingFeeVnd: row.shipping_fee_vnd,
          codAmountVnd: row.cod_amount_vnd,
          codSettlementStatus: row.cod_settlement_status,
          codSettledAt: row.cod_settled_at,
          codSettlementRef: row.cod_settlement_ref,
          trackingHistory: row.tracking_history,
          createdAt: row.created_at,
          lastSyncedAt: row.last_synced_at
        });
      } catch (e) {
        next(e);
      }
    }
  );

  // Public Webhook route
  publicRouter.post('/shipping/:carrier/webhook',
    rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const carrierId = z.enum(['viettel', 'jt', 'spx']).parse(req.params.carrier);
        const result = await handleCarrierWebhook(pool, config, carrierId, req.body || {}, {
          headers: req.headers,
          finance
        });
        res.json(result);
      } catch (e) {
        next(e);
      }
    }
  );

  // Public Realtime Quote route (advisory quote; final checkout fee & COD are always computed server-side)
  publicRouter.post('/shipping/quote',
    rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const schema = z.object({
          carrierId: z.enum(['viettel', 'jt', 'spx']).optional(),
          city: z.string().trim().min(1).max(120),
          district: z.string().trim().max(120).optional(),
          address: z.string().trim().max(500).optional(),
          weightGrams: z.number().int().min(1).max(50000).optional(),
          totalVnd: z.number().int().min(0).max(2000000000).optional(),
          paymentMethod: z.enum(['cod', 'bank_transfer', 'vnpay', 'momo', 'zalopay']).optional(),
          codAmountVnd: z.number().int().min(0).max(500_000_000).optional(),
          items: z.array(z.object({
            variantId: z.string().uuid(),
            quantity: z.number().int().min(1).max(999),
            weightGrams: z.number().int().min(1).max(50000).optional()
          })).max(50).optional()
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'Địa chỉ hoặc thông số đơn hàng chưa hợp lệ.' });

        const input = parsed.data;
        let effectiveTotalVnd = input.totalVnd ?? 0;
        let effectiveWeightGrams = input.weightGrams;
        let quoteBasis = 'advisory_parameters';

        // P1-05: When cart items are supplied, derive authoritative goods value & weight from DB + promotions (ignore spoofed client price/COD)
        if (Array.isArray(input.items) && input.items.length > 0) {
          const variantIds = [...new Set(input.items.map((i) => i.variantId))];
          const vRes = await pool.query(
            `SELECT v.id, v.sku, v.name AS variant_name, v.price_vnd AS "priceVnd", v.price_vnd, p.name AS product_name
             FROM product_variants v
             JOIN products p ON p.id = v.product_id
             WHERE v.id = ANY($1::uuid[]) AND v.active = true AND p.active = true AND p.deleted_at IS NULL`,
            [variantIds]
          );
          if (vRes.rows.length !== variantIds.length) {
            return res.status(400).json({ error: 'Một hoặc nhiều sản phẩm trong giỏ báo giá không còn khả dụng.' });
          }
          const { applyPromotions } = require('./product-promotions');
          const promoted = await applyPromotions(pool, vRes.rows);
          const byId = new Map(promoted.map((r) => [r.id, r]));
          let serverSubtotal = 0;
          const pricingItems = [];
          for (const reqItem of input.items) {
            const row = byId.get(reqItem.variantId);
            const unitPrice = Number(row.priceVnd ?? row.effective_price_vnd ?? row.price_vnd) || 0;
            serverSubtotal += unitPrice * reqItem.quantity;
            pricingItems.push({
              sku: row.sku,
              productName: row.product_name,
              variantName: row.variant_name,
              quantity: reqItem.quantity,
              weightGrams: reqItem.weightGrams
            });
          }
          const computed = computeCarrierShipmentPricing({
            subtotalVnd: serverSubtotal,
            totalVnd: serverSubtotal,
            paymentMethod: input.paymentMethod || 'cod',
            paymentStatus: 'pending',
            // P1-03: Authoritative quote server weight derived from server items
            weightGrams: null,
            items: pricingItems
          });
          effectiveTotalVnd = serverSubtotal;
          effectiveWeightGrams = computed.weightGrams;
          quoteBasis = 'server_cart_verified';
        }

        const isCodQuote = input.paymentMethod
          ? input.paymentMethod === 'cod'
          : (quoteBasis === 'server_cart_verified' ? true : (input.codAmountVnd ?? 0) > 0);
        const effectiveCodAmountVnd = isCodQuote
          ? (quoteBasis === 'server_cart_verified' ? effectiveTotalVnd : (input.codAmountVnd ?? effectiveTotalVnd))
          : 0;

        const quote = await quoteShippingFee(pool, config, {
          carrierId: input.carrierId,
          city: input.city,
          district: input.district,
          address: input.address,
          weightGrams: effectiveWeightGrams ?? 500,
          totalVnd: effectiveTotalVnd,
          codAmountVnd: effectiveCodAmountVnd,
          fetcher: resolveFetcher()
        });
        res.json({
          ...quote,
          advisoryOnly: true,
          quoteBasis
        });
      } catch (e) {
        next(e);
      }
    }
  );

  // Authenticated Customer or Signed Guest Token Tracking by Order Number
  publicRouter.get('/shipping/tracking/:orderNumber',
    rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const orderNumber = String(req.params.orderNumber).trim();
        const customerId = req.session?.customer?.id || null;
        const guestToken = String(req.query?.token || req.headers['x-tracking-token'] || '').trim();
        const hasValidGuestToken = guestToken ? verifyGuestTrackingToken(config, orderNumber, guestToken) : false;

        if (!customerId && !hasValidGuestToken) {
          return res.status(401).json({
            error: 'Vui lòng đăng nhập tài khoản khách hàng hoặc sử dụng mục Tra cứu đơn hàng kèm xác thực Email/SĐT.'
          });
        }

        const result = customerId && !hasValidGuestToken
          ? await pool.query(
              `SELECT s.carrier_id, s.tracking_number, s.status, s.carrier_status_desc,
                      s.tracking_history, s.last_synced_at, o.order_number, o.status AS order_status
               FROM carrier_shipments s
               JOIN orders o ON o.id = s.order_id
               WHERE o.order_number = $1 AND o.customer_id = $2 AND s.status != 'cancelled'
               ORDER BY s.created_at DESC LIMIT 1`,
              [orderNumber, customerId]
            )
          : await pool.query(
              `SELECT s.carrier_id, s.tracking_number, s.status, s.carrier_status_desc,
                      s.tracking_history, s.last_synced_at, o.order_number, o.status AS order_status
               FROM carrier_shipments s
               JOIN orders o ON o.id = s.order_id
               WHERE o.order_number = $1 AND s.status != 'cancelled'
               ORDER BY s.created_at DESC LIMIT 1`,
              [orderNumber]
            );
        if (!result.rows.length) {
          return res.status(404).json({ error: 'Chưa có thông tin vận đơn cho đơn hàng này.' });
        }
        const row = result.rows[0];
        res.json({
          orderNumber: row.order_number,
          carrierId: row.carrier_id,
          carrierName: CARRIER_NAMES[row.carrier_id] || row.carrier_id,
          trackingNumber: row.tracking_number,
          status: row.status,
          statusDescription: row.carrier_status_desc,
          history: row.tracking_history,
          lastSyncedAt: row.last_synced_at
        });
      } catch (e) {
        next(e);
      }
    }
  );

  return { admin: adminRouter, publicApi: publicRouter, createWaybill, cancelWaybill, syncShipmentTracking, settleCarrierCod, settleCarrierCodBatch, listCodSettlements, confirmCarrierPortalStatus, quoteShippingFee, handleCarrierWebhook };
}

module.exports = {
  createShippingManagement,
  createWaybill,
  cancelWaybill,
  syncShipmentTracking,
  settleSingleCarrierCodInTx,
  settleCarrierCod,
  settleCarrierCodBatch,
  listCodSettlements,
  confirmCarrierPortalStatus,
  handleCarrierWebhook,
  sanitizeWebhookPayload,
  purgeExpiredCarrierWebhookEvents,
  reconcileWaybillAttempt,
  quoteShippingFee,
  invalidateShippingQuoteCache,
  canAdvanceCarrierStatus,
  signGuestTrackingToken,
  verifyGuestTrackingToken
};
