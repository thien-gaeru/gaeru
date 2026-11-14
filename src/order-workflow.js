'use strict';
const {withTransaction} = require('./db');
const transitions = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["completed"],
  completed: [],
  cancelled: []
};

// Shared rules for the order workspace, bulk updates and AI action cards.
function createOrderWorkflow({
  inventory = require('./inventory'),
  finance = require('./finance-api'),
  audit = require('./audit').appendAudit,
  checkoutAccounts = true,
  config = null
} = {}) {
  async function applyOrderUpdate(client,id,update,actor,{validateOnly=false,expectedStatuses=null}={}){
        const currentResult = await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id]);
        const current = currentResult.rows[0];
        if (!current) return null;
        if (expectedStatuses && !expectedStatuses.includes(current.status)) {
          throw Object.assign(new Error('Trạng thái đơn hàng đã thay đổi. Vui lòng kiểm tra lại trước khi xử lý.'), {status:409});
        }
        if(current.return_completed_at)throw Object.assign(Error('Đơn đã hoàn trả xong; không thể xử lý lại.'),{status:409});
        if ((update.status === 'completed' || current.status === 'completed') && current.payment_method === 'cod') {
          if (update.confirmReceived || update.paymentStatus === 'paid') {
            if (actor && actor.role !== "owner" && Array.isArray(actor.permissions) && !actor.permissions.includes("payments.write")) {
              const error = new Error("Tài khoản cần có quyền quản lý thanh toán (payments.write) để xác nhận thu tiền COD.");
              error.status = 403;
              throw error;
            }
            update.confirmReceived = true;
            update.paymentStatus = 'paid';
          }
        }
        if (actor && actor.role !== "owner" && Array.isArray(actor.permissions)) {
          const fulfillmentChange = (update.status !== undefined && update.status !== current.status) || (update.shippingFeeVnd !== undefined && update.shippingFeeVnd !== current.shipping_fee_vnd);
          const paymentChange = update.paymentStatus !== undefined && update.paymentStatus !== current.payment_status;
          if ((fulfillmentChange && !actor.permissions.includes("orders.write")) || (paymentChange && !actor.permissions.includes("payments.write"))) {
            const error = new Error("Tài khoản không có quyền cập nhật nghiệp vụ này."); error.status = 403; throw error;
          }
        }
        if(checkoutAccounts && update.status && ['confirmed','processing','shipped','completed'].includes(update.status) && (await client.query('SELECT order_id FROM order_reviews WHERE order_id=$1 AND resolved_at IS NULL',[current.id])).rows.length)throw Object.assign(Error('Cần gọi xác nhận và xử lý đơn trong mục Đơn hàng rác / chờ xác minh trước.'),{status:409});
        const receivedAmount = finance ? await finance.receiptTotal(client, current.id) : 0;
        if (receivedAmount > 0 && ((update.status === "cancelled" && current.status !== "cancelled") || (update.shippingFeeVnd !== undefined && update.shippingFeeVnd !== current.shipping_fee_vnd))) {
          const error = new Error("Đơn đã ghi nhận thu tiền; cần đối soát/hoàn tiền trước khi hủy hoặc đổi tổng tiền."); error.status = 409; throw error;
        }
        const prepaidAutoProcess = current.payment_method !== "cod" && (current.payment_status === "paid" || update.paymentStatus === "paid");
        const adminDirectProcessing = current.status === "pending" && update.status === "processing";
        if (update.status && update.status !== current.status && !transitions[current.status].includes(update.status) && !(prepaidAutoProcess && current.status === "pending" && update.status === "processing") && !adminDirectProcessing) {
          const error = new Error(`Không thể chuyển đơn từ ${current.status} sang ${update.status}.`);
          error.status = 409;
          throw error;
        }
        const paymentStatusChanged = update.paymentStatus !== undefined && update.paymentStatus !== current.payment_status;
        if (current.payment_status === "paid" && paymentStatusChanged) {
          const error = new Error("Không thể chuyển đơn đã thanh toán về chưa thanh toán. Cần đối soát hoặc xử lý hoàn tiền riêng.");
          error.status = 409;
          throw error;
        }
        if (paymentStatusChanged && ["vnpay", "momo", "zalopay"].includes(current.payment_method)) {
          const error = new Error("Trạng thái thanh toán trực tuyến được cập nhật từ cổng thanh toán, không thể sửa thủ công.");
          error.status = 409;
          throw error;
        }
        if (update.status === "cancelled" && current.status !== "cancelled" && current.payment_status === "paid") {
          const error = new Error("Đơn đã thanh toán cần được xử lý hoàn tiền trước khi hủy.");
          error.status = 409;
          throw error;
        }
        const autoApproveToProcessing = paymentStatusChanged && update.paymentStatus === "paid" && current.payment_method !== "cod" && ["pending", "confirmed"].includes(current.status) && (!update.status || ["pending", "confirmed", "processing"].includes(update.status));
        let targetStatus = autoApproveToProcessing ? "processing" : (update.status ?? current.status);
        const targetPaymentStatus = update.paymentStatus ?? current.payment_status;
        const shippingFee = update.shippingFeeVnd ?? current.shipping_fee_vnd;
        const shippingFeeChanged = update.shippingFeeVnd !== undefined && update.shippingFeeVnd !== current.shipping_fee_vnd;
        if (shippingFeeChanged && current.payment_status === "paid") {
          const error = new Error("Không thể thay đổi phí giao hàng sau khi đơn đã thanh toán.");
          error.status = 409;
          throw error;
        }
        if (shippingFeeChanged && ["vnpay", "momo", "zalopay"].includes(current.payment_method)) {
          const paymentAttempt = await client.query(
            "SELECT EXISTS (SELECT 1 FROM payment_attempts WHERE order_id = $1) AS active",
            [current.id]
          );
          if (paymentAttempt.rows[0]?.active) {
            const error = new Error("Không thể thay đổi phí sau khi đã tạo phiên thanh toán VNPAY.");
            error.status = 409;
            throw error;
          }
        }
        if (update.status === "cancelled" && current.status !== "cancelled" && ["vnpay", "momo", "zalopay"].includes(current.payment_method)) {
          const activeAttempt = await client.query(
            `SELECT EXISTS (
               SELECT 1 FROM payment_attempts
               WHERE order_id = $1 AND status = 'pending' AND expires_at > now()
             ) AS active`,
            [current.id]
          );
          if (activeAttempt.rows[0]?.active) {
            const error = new Error("Chờ hết hạn phiên thanh toán VNPAY trước khi hủy đơn.");
            error.status = 409;
            throw error;
          }
        }
        if (update.shippingFeeVnd !== undefined && update.shippingFeeVnd !== current.shipping_fee_vnd && current.status !== "pending") {
          const error = new Error("Phí giao hàng chỉ được thay đổi khi đơn còn chờ xác nhận.");
          error.status = 409;
          throw error;
        }
        if (["confirmed", "processing"].includes(update.status) && update.shippingFeeVnd === undefined && current.shipping_fee_vnd === null) {
          const error = new Error("Nhập phí giao hàng để chốt tổng tiền trước khi xác nhận đơn.");
          error.status = 409;
          throw error;
        }
        if (targetStatus === "completed" && targetPaymentStatus !== "paid") {
          const error = new Error("Chỉ hoàn tất đơn sau khi xác nhận đã thu đủ tiền.");
          error.status = 409;
          throw error;
        }
        if (current.payment_method !== "cod" && ["processing", "shipped"].includes(targetStatus) && targetPaymentStatus !== "paid") {
          const error = new Error("Đơn thanh toán trả trước cần xác nhận đã thanh toán trước khi chuẩn bị gửi hoặc giao hàng.");
          error.status = 409;
          throw error;
        }
        if (paymentStatusChanged && update.paymentStatus === "paid" && targetStatus === "cancelled") {
          const error = new Error("Không thể ghi nhận thanh toán cho đơn đã hủy.");
          error.status = 409;
          throw error;
        }
        if (update.paymentStatus === "paid" && shippingFee === null) {
          const error = new Error("Chốt phí giao hàng trước khi ghi nhận thanh toán.");
          error.status = 409;
          throw error;
        }
        if (update.paymentStatus === "paid" && current.payment_method === "cod" && targetStatus !== "completed") {
          const activeCarrierShipmentPeek = (await client.query(
            "SELECT id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status FROM carrier_shipments WHERE order_id = $1 AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1",
            [current.id]
          )).rows[0] || null;
          const hasDeliveredShipment = (activeCarrierShipmentPeek && activeCarrierShipmentPeek.status === 'delivered') || Boolean(current.delivered_at);
          const isOwner = Boolean(actor?.role === 'owner' || actor?.source === 'bootstrap' || actor?.isOwner === true);
          if (hasDeliveredShipment && (current.status === 'shipped' || targetStatus === 'shipped')) {
            targetStatus = "completed";
            update.status = "completed";
            update.confirmReceived = true;
          } else if (isOwner) {
            targetStatus = "completed";
            update.status = "completed";
            update.confirmReceived = true;
          } else {
            const error = new Error("Đơn COD chỉ được ghi nhận đã thanh toán sau khi giao hàng.");
            error.status = 409;
            throw error;
          }
        }
        const total = shippingFee === null ? null : Math.max(0, current.subtotal_vnd + shippingFee - (current.discount_vnd||0));
        if (total !== null && total > 2_000_000_000) {
          const error = new Error("Tổng đơn hàng vượt giới hạn cho phép.");
          error.status = 400;
          throw error;
        }
        // Validate the order under its row lock before a carrier call. Finalization
        // repeats every check and rejects any active or newly-created shipment.
        let hasActiveWaybill = false;
        if (update.status === 'cancelled' && current.status !== 'cancelled') {
          const unresolved = await client.query(
            "SELECT id FROM carrier_shipment_attempts WHERE order_id=$1 AND status IN ('sending','unknown') LIMIT 1",
            [current.id]
          );
          if (unresolved.rows.length) {
            throw Object.assign(new Error('Yêu cầu tạo vận đơn đang xử lý hoặc chưa rõ kết quả. Cần đối soát với hãng trước khi hủy đơn hàng.'), {status:409});
          }
          hasActiveWaybill = (await client.query(
            "SELECT id FROM carrier_shipments WHERE order_id = $1 AND status <> 'cancelled' LIMIT 1",
            [current.id]
          )).rows.length > 0;
          if (hasActiveWaybill && !(validateOnly && update.cancelActiveWaybill === true)) {
            throw Object.assign(new Error('Đơn hàng đã có vận đơn đang hoạt động. Cần hủy vận đơn tại hãng trước khi hủy đơn hàng.'), {status:409});
          }
        }
        if (validateOnly) return {id:current.id, status:current.status, hasActiveWaybill};
        if (targetStatus && ["confirmed", "processing", "shipped"].includes(targetStatus) && current.status === "pending") {
          const hasAllocations = (await client.query("SELECT 1 FROM order_stock_allocations WHERE order_id = $1 AND released_at IS NULL LIMIT 1", [current.id])).rows.length > 0;
          if (!hasAllocations && inventory) {
            let targetWarehouseId = update.warehouseId;
            if (!targetWarehouseId) {
              const defWh = await client.query("SELECT id FROM warehouses WHERE active = true ORDER BY CASE WHEN code = 'MAIN' THEN 0 ELSE 1 END, created_at ASC LIMIT 1");
              if (defWh.rows.length) targetWarehouseId = defWh.rows[0].id;
            }
            const items = (await client.query("SELECT variant_id, SUM(quantity)::int AS quantity FROM order_items WHERE order_id = $1 AND variant_id IS NOT NULL GROUP BY variant_id ORDER BY variant_id", [current.id])).rows;
            for (const item of items) {
              await inventory.reserveStock(client, {
                variantId: item.variant_id,
                quantity: item.quantity,
                orderId: current.id,
                actor: actor || { username: "admin", source: "admin" },
                warehouseId: targetWarehouseId
              });
            }
          }
        }
        if (update.status === "cancelled" && current.status !== "cancelled") {
          await client.query("UPDATE payment_attempts SET status = 'failed', updated_at = now() WHERE order_id = $1 AND status = 'pending'", [current.id]);
          if(current.voucher_code)await client.query('UPDATE voucher_redemptions SET released=true WHERE order_id=$1 AND released=false',[current.id]);
          if (inventory) await inventory.releaseOrderStock(client, { orderId: current.id, actor: actor });
          else await client.query(
            `UPDATE product_variants v SET stock_quantity = v.stock_quantity + i.quantity, updated_at=now()
             FROM order_items i WHERE i.order_id=$1 AND i.variant_id=v.id`,
            [current.id]
          );
          if (current.customer_id) {
            const { refundPoints } = require('./loyalty-api');
            await refundPoints(client, { customerId: current.customer_id, orderId: current.id, actor });
          }
        }
        const safeActor = (actor && actor.username) ? actor : { username: "admin", role: "owner", source: "admin", fullName: "Quản trị viên" };
        const activeCarrierShipment = (await client.query(
          "SELECT id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status FROM carrier_shipments WHERE order_id = $1 AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
          [current.id]
        )).rows[0] || null;

        if (targetStatus === "completed" && activeCarrierShipment && activeCarrierShipment.status !== "delivered") {
          const error = new Error(`Vận đơn hãng chưa ở trạng thái Đã giao hàng (hiện tại: ${activeCarrierShipment.status}). Vui lòng đồng bộ hành trình hoặc đối chiếu cổng hãng Đã giao trước khi hoàn tất đơn hàng.`);
          error.status = 409;
          throw error;
        }

        if (update.paymentStatus === "paid" && current.payment_status !== "paid") {
          const carrierCodShipment = (current.payment_method === "cod" && activeCarrierShipment && Number(activeCarrierShipment.cod_amount_vnd) > 0)
            ? activeCarrierShipment
            : null;
          const explicitRef = String(update.reconciliationRef || '').trim();
          const defaultCodRef = 'COD-' + (current.order_number || current.id.slice(0, 8));
          const effectiveRef = (explicitRef && explicitRef.length >= 4) ? explicitRef : defaultCodRef;
          const ledger = finance || require('./finance-api');
          if (carrierCodShipment) {
            await client.query(
              `UPDATE carrier_shipments
               SET cod_settlement_status = 'settled',
                   cod_settled_at = COALESCE(cod_settled_at, now()),
                   cod_settlement_ref = COALESCE(cod_settlement_ref, $2),
                   cod_attestation_level = CASE WHEN cod_attestation_level = 'statement_verified' THEN 'statement_verified' ELSE 'manually_attested' END,
                   cod_attested_by = COALESCE(cod_attested_by, $3),
                   updated_at = now()
               WHERE id = $1`,
              [carrierCodShipment.id, effectiveRef, safeActor.username || 'admin']
            );
            if (ledger?.recordFullOrderPayment) {
              await ledger.recordFullOrderPayment(client, {
                order: { ...current, total_vnd: total },
                actor: safeActor,
                options: {
                  reference: effectiveRef,
                  method: 'bank_transfer',
                  note: update.paymentNote || (explicitRef ? `Thu đủ tiền COD (${explicitRef})` : 'Xác nhận thu đủ tiền COD')
                }
              });
            }
          } else {
            await client.query("UPDATE payment_attempts SET status = 'paid', updated_at = now() WHERE order_id = $1 AND status = 'pending'", [current.id]);
            if (ledger?.recordFullOrderPayment) {
              await ledger.recordFullOrderPayment(client, {
                order: { ...current, total_vnd: total },
                actor: safeActor,
                options: {
                  reference: effectiveRef,
                  note: update.paymentNote || 'Xác nhận thu tiền COD trực tiếp'
                }
              });
            }
          }
        } else if (targetStatus === "completed" && activeCarrierShipment && Number(activeCarrierShipment.cod_amount_vnd) > 0 && activeCarrierShipment.cod_settlement_status !== "settled") {
          const explicitRef = String(update.reconciliationRef || '').trim();
          const defaultCodRef = 'COD-' + (current.order_number || current.id.slice(0, 8));
          const effectiveRef = (explicitRef && explicitRef.length >= 4) ? explicitRef : defaultCodRef;
          await client.query(
            `UPDATE carrier_shipments
             SET cod_settlement_status = 'settled',
                 cod_settled_at = COALESCE(cod_settled_at, now()),
                 cod_settlement_ref = COALESCE(cod_settlement_ref, $2),
                 cod_attestation_level = 'manually_attested',
                 cod_attested_by = COALESCE(cod_attested_by, $3),
                 updated_at = now()
             WHERE id = $1`,
            [activeCarrierShipment.id, effectiveRef, safeActor.username || 'admin']
          );
        }
        const updated = await client.query(
          `UPDATE orders SET status=COALESCE($2, status), payment_status=COALESCE($3, payment_status),
            shipping_fee_vnd=$4, total_vnd=$5, delivered_at=CASE WHEN $2 = 'completed' THEN COALESCE(delivered_at, now()) ELSE delivered_at END, updated_at=now()
           WHERE id=$1 RETURNING id, status, payment_status AS "paymentStatus",
             shipping_fee_vnd AS "shippingFeeVnd", total_vnd AS "totalVnd"`,
          [current.id, (autoApproveToProcessing ? "processing" : (update.status ?? targetStatus)) || null, update.paymentStatus || null, shippingFee, total]
        );
        await audit(client, { actor: safeActor, action: "order.update", entityType: "order", entityId: current.id, before: { status: current.status, paymentStatus: current.payment_status, shippingFeeVnd: current.shipping_fee_vnd }, after: updated.rows[0] });
        if ((targetStatus === 'completed' || updated.rows[0].status === 'completed') && (targetPaymentStatus === 'paid' || updated.rows[0].paymentStatus === 'paid')) {
          if (current.customer_id && updated.rows[0].totalVnd > 0) {
            const { earnPoints } = require('./loyalty-api');
            await earnPoints(client, {
              customerId: current.customer_id,
              orderId: current.id,
              orderTotalVnd: updated.rows[0].totalVnd,
              actor: safeActor
            });
          }
        }
        return updated.rows[0];
  }

  async function updateOrder(pool, id, update, actor, options = {}) {
    // Work on our own copy because COD settlement validation may normalize fields.
    const data = {...update};
    if (data.status === 'cancelled' && data.cancelActiveWaybill === true) {
      const checked = await withTransaction(pool, client =>
        applyOrderUpdate(client, id, {...data}, actor, {...options, validateOnly:true}));
      if (!checked) return null;
      if (checked.hasActiveWaybill) {
        // Provider I/O must never keep an order transaction or stock lock open.
        // The provider workflow preserves rejection/unknown/concurrent states.
        await require('./shipping-management').cancelWaybill(pool, config, {
          orderId:id, actor, reason:'Hủy vận đơn theo yêu cầu hủy đơn hàng'
        });
      }
    }
    return withTransaction(pool, client => applyOrderUpdate(client, id, data, actor, options));
  }

  return {applyOrderUpdate, updateOrder};
}
module.exports = {createOrderWorkflow, transitions};
