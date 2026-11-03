const { Router } = require('express');
const { z } = require('zod');
const { rateLimit } = require('express-rate-limit');
const { LRUCache } = require('lru-cache');
const { withTransaction } = require('./db');
const { requireCsrf } = require('./security');
const { requirePermission } = require('./staff-access');
const { readRecord } = require('./admin-configuration');
const { appendAudit } = require('./audit');
const { getAdapter, normalizeCarrierStatus, CARRIER_NAMES } = require('./shipping-adapters');
const { availableCarriers } = require('./shipping-choice');

const quoteCache = new LRUCache({ max: 500, ttl: 1000 * 60 * 5 }); // 5 minutes TTL

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function getOrderForFulfillment(client, orderId) {
  const result = await client.query(
    `SELECT o.id, o.order_number AS "orderNumber", o.customer_id AS "customerId",
            o.customer_name AS "customerName", o.return_completed_at AS "returnCompletedAt",
            o.phone, o.email, o.address, o.city, o.note, o.status,
            o.payment_method AS "paymentMethod", o.payment_status AS "paymentStatus",
            o.subtotal_vnd AS "subtotalVnd", o.shipping_fee_vnd AS "shippingFeeVnd",
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
    if (unresolved) throw fail('Yêu cầu tạo vận đơn '+unresolved.id+' đang xử lý hoặc chưa rõ kết quả. Đối chiếu trên hệ thống hãng trước khi cho phép tạo lại.',409);

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
  const codAmount = (order.paymentMethod === 'cod' && order.paymentStatus !== 'paid') ? Number(order.totalVnd || 0) : 0;
  try {
    const waybillResult = await getAdapter(targetCarrierId).createWaybill(settings, {
      ...order, codAmountVnd:codAmount, weightGrams:500
    }, {fetcher});
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
         status, shipping_fee_vnd, cod_amount_vnd, tracking_history, metadata
       ) VALUES ($1, $2, $3, $4, $5, 'created', $6, $7, $8, $9)
       RETURNING *`,
      [
        order.id,
        targetCarrierId,
        waybillResult.trackingNumber,
        waybillResult.carrierOrderId,
        waybillResult.labelUrl,
        waybillResult.shippingFeeVnd,
        codAmount,
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
    await pool.query("UPDATE carrier_shipment_attempts SET status='unknown',result='Chưa xác định kết quả; đối soát tại hãng trước khi tạo lại',updated_at=now() WHERE id=$1 AND status='sending'",[attemptId]).catch(()=>{});
    throw fail('Chưa xác định kết quả tạo vận đơn. Yêu cầu '+attemptId+' đã khóa gửi lại; đối chiếu mã đơn '+order.orderNumber+' trên hệ thống hãng trước khi xử lý tiếp.',502);
  }
}

async function cancelWaybill(pool, config, { orderId, reason = 'Chủ shop hủy vận đơn', actor, fetcher = fetch }) {
  return withTransaction(pool, async client => {
    const shipmentResult = await client.query(
      `SELECT * FROM carrier_shipments
       WHERE order_id = $1 AND status != 'cancelled'
       FOR UPDATE`,
      [orderId]
    );

    if (!shipmentResult.rows.length) {
      throw fail('Không tìm thấy vận đơn đang hoạt động để hủy.', 404);
    }

    const shipment = shipmentResult.rows[0];
    const carrierRecord = await readRecord(client, config, 'shipping_' + shipment.carrier_id);
    const adapter = getAdapter(shipment.carrier_id);

    await adapter.cancelWaybill(carrierRecord.data, {
      trackingNumber: shipment.tracking_number,
      carrierOrderId: shipment.carrier_order_id,
      reason
    }, { fetcher });

    const history = Array.isArray(shipment.tracking_history) ? shipment.tracking_history : [];
    history.push({
      timestamp: new Date().toISOString(),
      status: 'cancelled',
      rawStatus: 'cancelled_by_shop',
      description: `Đã hủy vận đơn trên hệ thống hãng: ${reason}`
    });

    await client.query(
      `UPDATE carrier_shipments
       SET status = 'cancelled', tracking_history = $2, updated_at = now()
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

async function syncShipmentTracking(pool, config, { orderId, trackingNumber, actor, fetcher = fetch, finance }) {
  return withTransaction(pool, async client => {
    let query, params;
    if (orderId) {
      query = `SELECT s.*, o.order_number AS "orderNumber", o.total_vnd AS "orderTotalVnd",
                      o.customer_id AS "orderCustomerId", o.return_completed_at AS "orderReturnCompletedAt",
                      o.payment_method AS "orderPaymentMethod", o.payment_status AS "orderPaymentStatus", o.status AS "orderStatus"
               FROM carrier_shipments s
               JOIN orders o ON o.id = s.order_id
               WHERE s.order_id = $1 AND s.status != 'cancelled'
               FOR UPDATE OF s, o`;
      params = [orderId];
    } else {
      query = `SELECT s.*, o.order_number AS "orderNumber", o.total_vnd AS "orderTotalVnd",
                      o.customer_id AS "orderCustomerId", o.return_completed_at AS "orderReturnCompletedAt",
                      o.payment_method AS "orderPaymentMethod", o.payment_status AS "orderPaymentStatus", o.status AS "orderStatus"
               FROM carrier_shipments s
               JOIN orders o ON o.id = s.order_id
               WHERE s.tracking_number = $1
               FOR UPDATE OF s, o`;
      params = [trackingNumber];
    }

    const result = await client.query(query, params);
    if (!result.rows.length) throw fail('Không tìm thấy vận đơn để đồng bộ.', 404);
    const shipment = result.rows[0];

    const carrierRecord = await readRecord(client, config, 'shipping_' + shipment.carrier_id);
    const adapter = getAdapter(shipment.carrier_id);

    const trackingData = await adapter.queryTracking(carrierRecord.data, {
      trackingNumber: shipment.tracking_number,
      carrierOrderId: shipment.carrier_order_id
    }, { fetcher });

    const newNormalizedStatus = trackingData.status;
    if (newNormalizedStatus === 'pending') return { success: false, processed: false, trackingNumber: shipment.tracking_number, orderStatus: shipment.orderStatus, message: 'Hãng chưa trả trạng thái hành trình được hỗ trợ. Giữ nguyên dữ liệu hiện tại.' };
    const history = Array.isArray(trackingData.history) && trackingData.history.length > 0
      ? trackingData.history
      : Array.isArray(shipment.tracking_history) ? shipment.tracking_history : [];

    await client.query(
      `UPDATE carrier_shipments
       SET status = $2, carrier_status_raw = $3, carrier_status_desc = $4,
           tracking_history = $5, last_synced_at = now(), updated_at = now()
       WHERE id = $1`,
      [
        shipment.id,
        newNormalizedStatus,
        trackingData.carrierStatusRaw,
        trackingData.statusDescription,
        JSON.stringify(history)
      ]
    );

    // Sync status to orders safely (never resurrect cancelled/returned or unpaid non-COD orders)
    let updatedOrderStatus = shipment.orderStatus;
    const isTerminalBlocked = shipment.orderStatus === 'cancelled' || Boolean(shipment.orderReturnCompletedAt);
    const canAutoComplete = !isTerminalBlocked && (shipment.orderPaymentMethod === 'cod' || shipment.orderPaymentStatus === 'paid');
    if (!isTerminalBlocked && newNormalizedStatus === 'delivering' && ['pending', 'confirmed', 'processing'].includes(shipment.orderStatus) && (shipment.orderPaymentMethod === 'cod' || shipment.orderPaymentStatus === 'paid')) {
      updatedOrderStatus = 'shipped';
      await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [shipment.order_id, 'shipped']);
    } else if (canAutoComplete && newNormalizedStatus === 'delivered' && shipment.orderStatus !== 'completed') {
      updatedOrderStatus = 'completed';
      await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [shipment.order_id, 'completed']);

      const settleActor = actor || { username: 'carrier_sync', source: 'shipping_worker' };
      // Auto settle COD if delivered
      if (shipment.orderPaymentMethod === 'cod' && shipment.orderPaymentStatus !== 'paid') {
        await client.query('UPDATE orders SET payment_status = $2, updated_at = now() WHERE id = $1', [shipment.order_id, 'paid']);
        if (finance?.recordFullOrderPayment) {
          if (finance.recordFullOrderPayment.length >= 3) {
            await finance.recordFullOrderPayment(client, shipment.order_id, settleActor);
          } else {
            await finance.recordFullOrderPayment(client, {
              order: {
                id: shipment.order_id,
                order_number: shipment.orderNumber,
                payment_method: 'cod',
                total_vnd: Number(shipment.orderTotalVnd) || 0
              },
              actor: settleActor
            });
          }
        }
      }
      if (shipment.orderCustomerId && Number(shipment.orderTotalVnd) > 0) {
        {
          const { earnPoints } = require('./loyalty-api');
          await earnPoints(client, {
            customerId: shipment.orderCustomerId,
            orderId: shipment.order_id,
            orderTotalVnd: Number(shipment.orderTotalVnd),
            actor: settleActor
          });
        }
      }
    }

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
      trackingNumber: shipment.tracking_number,
      status: newNormalizedStatus,
      statusDescription: trackingData.statusDescription,
      history,
      orderStatus: updatedOrderStatus
    };
  });
}

async function handleCarrierWebhook(pool, config, carrierId, payload, { headers = {}, finance, actor = { username: 'carrier_webhook', source: 'webhook' } } = {}) {
  // Never accept public delivery/payment changes without a configured credential.
  // Configuration/decryption errors must also stop processing, not bypass auth.
  {
    const carrierRecord = await readRecord(pool, config, 'shipping_' + carrierId);
    const expectedSecret = String(carrierRecord?.data?.webhookSecret || '').trim();
    if (!expectedSecret) throw fail('Webhook vận chuyển chưa được cấu hình xác thực.', 503);
    {
      const crypto = require('node:crypto');
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
  }

  // Normalize carrier payload
  let trackingNumber = null;
  let rawStatus = null;
  let carrierOrderId = null;

  if (carrierId === 'ghn') {
    trackingNumber = payload.OrderCode || payload.order_code;
    rawStatus = payload.Status || payload.status;
  } else if (carrierId === 'ghtk') {
    trackingNumber = payload.label_id || payload.label;
    rawStatus = payload.status_id || payload.status;
  } else if (carrierId === 'viettel') {
    trackingNumber = payload.ORDER_NUMBER || payload.order_number;
    rawStatus = payload.ORDER_STATUS || payload.status;
  } else if (carrierId === 'jt') {
    trackingNumber = payload.billcode || payload.mailno;
    carrierOrderId = payload.txlogisticid;
    rawStatus = payload.scantype || payload.status;
  } else if (carrierId === 'spx') {
    trackingNumber = payload.tracking_number;
    rawStatus = payload.status;
  }

  if (!trackingNumber && !carrierOrderId) {
    return { success: false, reason: 'Webhook không chứa mã vận đơn hợp lệ.' };
  }

  const normalizedStatus = normalizeCarrierStatus(carrierId, rawStatus);
  if (normalizedStatus === 'pending') return { success: false, processed: false, reason: 'Trạng thái hành trình chưa được hỗ trợ; chưa cập nhật đơn hoặc thanh toán.' };

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
    if(shipment.status==='cancelled') return {success:true,processed:false,reason:'Vận đơn đã hủy; bỏ qua cập nhật trễ của hãng.'};
    const history = Array.isArray(shipment.tracking_history) ? shipment.tracking_history : [];
    history.push({
      timestamp: new Date().toISOString(),
      status: normalizedStatus,
      rawStatus: String(rawStatus),
      description: payload.desc || payload.description || `Cập nhật từ Webhook ${CARRIER_NAMES[carrierId] || carrierId}`
    });

    await client.query(
      `UPDATE carrier_shipments
       SET status = $2, carrier_status_raw = $3, carrier_status_desc = $4,
           tracking_history = $5, last_synced_at = now(), updated_at = now()
       WHERE id = $1`,
      [shipment.id, normalizedStatus, String(rawStatus), payload.desc || '', JSON.stringify(history)]
    );

    const isTerminalBlocked = shipment.orderStatus === 'cancelled' || Boolean(shipment.orderReturnCompletedAt);
    const canAutoComplete = !isTerminalBlocked && (shipment.orderPaymentMethod === 'cod' || shipment.orderPaymentStatus === 'paid');
    if (!isTerminalBlocked && normalizedStatus === 'delivering' && ['pending', 'confirmed', 'processing'].includes(shipment.orderStatus) && (shipment.orderPaymentMethod === 'cod' || shipment.orderPaymentStatus === 'paid')) {
      await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [shipment.order_id, 'shipped']);
    } else if (canAutoComplete && normalizedStatus === 'delivered' && shipment.orderStatus !== 'completed') {
      await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [shipment.order_id, 'completed']);
      if (shipment.orderPaymentMethod === 'cod' && shipment.orderPaymentStatus !== 'paid') {
        await client.query('UPDATE orders SET payment_status = $2, updated_at = now() WHERE id = $1', [shipment.order_id, 'paid']);
        if (finance?.recordFullOrderPayment) {
          if (finance.recordFullOrderPayment.length >= 3) {
            await finance.recordFullOrderPayment(client, shipment.order_id, actor);
          } else {
            await finance.recordFullOrderPayment(client, {
              order: {
                id: shipment.order_id,
                order_number: shipment.orderNumber,
                payment_method: 'cod',
                total_vnd: Number(shipment.orderTotalVnd) || 0
              },
              actor
            });
          }
        }
      }
      if (shipment.orderCustomerId && Number(shipment.orderTotalVnd) > 0) {
        {
          const { earnPoints } = require('./loyalty-api');
          await earnPoints(client, {
            customerId: shipment.orderCustomerId,
            orderId: shipment.order_id,
            orderTotalVnd: Number(shipment.orderTotalVnd),
            actor
          });
        }
      }
    }

    await appendAudit(client, {
      actor,
      action: 'shipping.webhook.receive',
      entityType: 'order',
      entityId: shipment.order_id,
      metadata: { carrierId, trackingNumber: shipment.tracking_number, rawStatus, normalizedStatus }
    });

    return { success: true, processed: true, normalizedStatus };
  });
}

async function quoteShippingFee(pool, config, { carrierId, city, district, address, weightGrams = 500, totalVnd = 0, fetcher = fetch }) {
  const normCity = String(city || '').trim();
  const cacheKey = `quote:${carrierId || 'any'}:${normCity}:${district || ''}:${Math.ceil(weightGrams / 500)}`;

  if (quoteCache.has(cacheKey)) {
    return quoteCache.get(cacheKey);
  }

  // Fallback fee provider using database rate table
  async function getFallbackFee() {
    const rateResult = await pool.query("SELECT setting_value FROM store_settings WHERE setting_key = 'shipping_rates'");
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
      if (!record.data || !record.data.secretConfigured && !record.data.secret) {
        return await getFallbackFee();
      }
      const adapter = getAdapter(carrierId);
      const quote = await adapter.quoteShippingFee(record.data, {
        city: normCity,
        district,
        address,
        weightGrams,
        totalVnd
      }, { fetcher });

      const responseData = {
        feeVnd: quote.feeVnd,
        carrierId: quote.carrierId,
        carrierName: quote.carrierName,
        estimatedDays: quote.estimatedDays || 2,
        carrierService: quote.carrierService,
        source: 'carrier_realtime'
      };

      quoteCache.set(cacheKey, responseData);
      return responseData;
    } catch {
      // Graceful fallback to static rate table on carrier API failure or timeout
      const fallback = await getFallbackFee();
      fallback.warning = 'Hãng vận chuyển phản hồi chậm, áp dụng bảng phí niêm yết theo tỉnh/thành.';
      return fallback;
    }
  }

  // If no carrier specified, get fallback fee
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
        const { carrierId, autoShip } = z.object({
          carrierId: z.enum(['ghn', 'ghtk', 'viettel', 'jt', 'spx']).optional(),
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
    requirePermission('orders.read'),
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
        const carrierId = z.enum(['ghn', 'ghtk', 'viettel', 'jt', 'spx']).parse(req.params.carrier);
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
          carrierId: z.enum(['ghn', 'ghtk', 'viettel', 'jt', 'spx']).optional(),
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

  // Public Tracking by Order Number
  publicRouter.get('/shipping/tracking/:orderNumber',
    rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const orderNumber = String(req.params.orderNumber).trim();
        const result = await pool.query(
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

  return { admin: adminRouter, publicApi: publicRouter, createWaybill, cancelWaybill, syncShipmentTracking, quoteShippingFee, handleCarrierWebhook };
}

module.exports = {
  createShippingManagement,
  createWaybill,
  cancelWaybill,
  syncShipmentTracking,
  handleCarrierWebhook,
  reconcileWaybillAttempt,
  quoteShippingFee
};
