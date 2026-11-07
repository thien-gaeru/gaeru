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
const { getAdapter, normalizeCarrierStatus, computeCarrierShipmentPricing, CARRIER_NAMES } = require('./shipping-adapters');
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

function sanitizeWebhookPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const clone = JSON.parse(JSON.stringify(payload));
  for (const key of ['token', 'Token', 'secret', 'webhookSecret', 'authorization', 'password']) {
    if (key in clone) delete clone[key];
    if (clone.DATA && typeof clone.DATA === 'object' && key in clone.DATA) delete clone.DATA[key];
  }
  return clone;
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
    // Roll back cancel_requested only if no newer webhook/sync superseded claimedVersion
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

  // Phase 3: Finalize cancellation only if version & status are still valid (do not overwrite concurrent delivered/returned)
  return withTransaction(pool, async client => {
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
      await appendAudit(client, {
        actor,
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
      throw fail(`Hãng vận chuyển đã cập nhật trạng thái "${shipment.status}" trong lúc yêu cầu hủy đang xử lý. Hệ thống giữ nguyên trạng thái "${shipment.status}" để bảo vệ đối soát tiền và hàng hóa.`, 409);
    }
    if (shipment.status !== 'cancel_requested' || Number(shipment.status_version) !== claimed.claimedVersion) {
      await client.query(
        `UPDATE carrier_shipments
         SET status = 'cancel_reconciliation_required', status_version = status_version + 1, updated_at = now()
         WHERE id = $1`,
        [shipment.id]
      );
      await appendAudit(client, {
        actor,
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
      throw fail('Trạng thái vận đơn đã thay đổi đồng thời khi gọi hủy hãng. Đã chuyển sang chế độ chờ đối soát thủ công (cancel_reconciliation_required).', 409);
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

async function settleCarrierCod(pool, { orderId, providerTransactionRef, settledAmountVnd, method = 'bank_transfer', settledAt = null, note = '', actor, finance }) {
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
  if (actor && actor.role !== 'owner' && Array.isArray(actor.permissions) && !actor.permissions.includes('payments.write')) {
    throw fail('Tài khoản cần quyền quản lý thanh toán (payments.write) để xác nhận đối soát tiền COD.', 403);
  }

  return withTransaction(pool, async client => {
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
    if (shipment.orderPaymentMethod !== 'cod') {
      throw fail('Chỉ đối soát thu hộ cho đơn hàng thanh toán COD.', 409);
    }
    if (shipment.orderStatus === 'cancelled' || shipment.orderReturnCompletedAt) {
      throw fail('Đơn hàng đã hủy hoặc hoàn trả; không thể đối soát thu tiền COD.', 409);
    }
    if (shipment.status !== 'delivered' && !['shipped', 'completed'].includes(shipment.orderStatus)) {
      throw fail('Chỉ đối soát tiền COD sau khi hãng vận chuyển đã giao hàng.', 409);
    }

    const ledger = finance || require('./finance-api');
    const requestKey = `cod-settlement:${shipment.carrier_id}:${txRef}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sales_receipts:${requestKey}`]);
    const existingReceipt = (await client.query(
      'SELECT id, order_id, amount_vnd FROM sales_receipts WHERE request_key = $1',
      [requestKey]
    )).rows[0];
    if (existingReceipt) {
      if (existingReceipt.order_id === orderId && Number(existingReceipt.amount_vnd) === amount) {
        return {
          success: true,
          replayed: true,
          receiptId: existingReceipt.id,
          orderId,
          orderStatus: 'completed',
          paymentStatus: 'paid',
          codSettlementStatus: 'settled'
        };
      }
      throw fail('Mã giao dịch đối soát của hãng đã được sử dụng cho đơn hàng hoặc số tiền khác.', 409);
    }

    if (shipment.orderPaymentStatus === 'paid' || shipment.cod_settlement_status === 'settled') {
      throw fail('Đơn hàng COD này đã được đối soát thanh toán trước đó.', 409);
    }

    const received = ledger.receiptTotal ? await ledger.receiptTotal(client, orderId) : 0;
    const remaining = Number(shipment.orderTotalVnd) - received;
    if (amount !== remaining) {
      throw fail(`Số tiền đối soát (${amount} ₫) không khớp số tiền COD còn phải thu (${remaining} ₫).`, 409);
    }

    const settleNote = String(note || '').trim() || `Đối soát tiền thu hộ COD ${CARRIER_NAMES[shipment.carrier_id] || shipment.carrier_id} (${txRef})`;
    const settleActor = actor || { username: 'accountant', source: 'cod_settlement' };
    const receiptRow = await ledger.recordFullOrderPayment(client, {
      order: {
        id: orderId,
        order_number: shipment.orderNumber,
        payment_method: 'cod',
        total_vnd: Number(shipment.orderTotalVnd)
      },
      actor: settleActor,
      options: {
        requestKey,
        reference: txRef,
        method,
        note: settleNote
      }
    });

    await client.query(
      `UPDATE orders
       SET payment_status = 'paid', status = 'completed', delivered_at = COALESCE(delivered_at, now()), updated_at = now()
       WHERE id = $1`,
      [orderId]
    );
    await client.query("UPDATE payment_attempts SET status = 'paid', updated_at = now() WHERE order_id = $1 AND status = 'pending'", [orderId]);
    const parsedSettledAt = parseProviderEventTime(settledAt);
    await client.query(
      `UPDATE carrier_shipments
       SET cod_settlement_status = 'settled',
           cod_settled_at = COALESCE($2::timestamptz, now()),
           cod_settlement_ref = $3,
           updated_at = now()
       WHERE id = $1`,
      [shipment.id, parsedSettledAt ? parsedSettledAt.toISOString() : null, txRef]
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

    await appendAudit(client, {
      actor: settleActor,
      action: 'shipping.cod.settle',
      entityType: 'order',
      entityId: orderId,
      metadata: {
        carrierId: shipment.carrier_id,
        trackingNumber: shipment.tracking_number,
        providerTransactionRef: txRef,
        settledAmountVnd: amount,
        method,
        receiptId: receiptRow?.id || null
      }
    });

    return {
      success: true,
      replayed: false,
      receiptId: receiptRow?.id || null,
      orderId,
      orderStatus: 'completed',
      paymentStatus: 'paid',
      codSettlementStatus: 'settled'
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
        source: 'carrier_realtime'
      };

      quoteCache.set(canonicalQuoteKey, responseData);
      return responseData;
    } catch {
      const fallback = await getFallbackFee();
      fallback.warning = 'Hãng vận chuyển phản hồi chậm, áp dụng bảng phí niêm yết theo tỉnh/thành.';
      return fallback;
    }
  }

  return getFallbackFee();
}

function createShippingManagement(pool, config, { fetcher = fetch, finance } = {}) {
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
          fetcher
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
          fetcher
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
          method: z.enum(['cash', 'bank_transfer']).optional().default('bank_transfer'),
          settledAt: z.string().trim().max(64).optional(),
          note: z.string().trim().max(500).optional().default('')
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

  // Public Realtime Quote route
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
          totalVnd: z.number().int().min(0).max(2000000000).optional()
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'Địa chỉ hoặc thông số đơn hàng chưa hợp lệ.' });

        const quote = await quoteShippingFee(pool, config, {
          ...parsed.data,
          fetcher
        });
        res.json(quote);
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

  return { admin: adminRouter, publicApi: publicRouter, createWaybill, cancelWaybill, syncShipmentTracking, settleCarrierCod, quoteShippingFee, handleCarrierWebhook };
}

module.exports = {
  createShippingManagement,
  createWaybill,
  cancelWaybill,
  syncShipmentTracking,
  settleCarrierCod,
  handleCarrierWebhook,
  reconcileWaybillAttempt,
  quoteShippingFee,
  invalidateShippingQuoteCache,
  canAdvanceCarrierStatus,
  signGuestTrackingToken,
  verifyGuestTrackingToken
};
