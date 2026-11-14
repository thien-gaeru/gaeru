'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { requirePermission } = require('./staff-access');
const { requireCsrf } = require('./security');
const { withTransaction } = require('./db');
const { appendAudit } = require('./audit');
const inventory = require('./inventory');

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const intakeSchema = z.object({
  trackingNumber: z.string().trim().min(1, 'Vui lòng cung cấp mã vận đơn.'),
  packageCondition: z.enum(['intact', 'damaged', 'lost_or_tampered'], {
    errorMap: () => ({ message: 'Tình trạng kiện hàng phải là: intact (nguyên seal), damaged (hư hỏng), hoặc lost_or_tampered (mất hàng/tráo ruột).' })
  }),
  warehouseId: z.string().uuid('Mã kho không hợp lệ.').optional(),
  inspectionNotes: z.string().trim().max(1000).optional().default(''),
  evidenceUrls: z.array(z.string().url('Đường dẫn hình ảnh bằng chứng không hợp lệ.')).optional().default([]),
  carrierFault: z.boolean().optional().default(false)
}).strict();

function createCodReturnIntake(pool) {
  const router = Router();

  // 1. GET /pending: Danh sách bưu phẩm chuyển hoàn COD chờ kiểm nhận tại kho
  router.get('/cod-returns/pending', requirePermission('orders.read'), async (req, res, next) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const offset = (page - 1) * limit;

      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM carrier_shipments s
         JOIN orders o ON o.id = s.order_id
         LEFT JOIN cod_return_intakes cri ON cri.shipment_id = s.id
         WHERE s.status = 'returned'
           AND cri.id IS NULL
           AND o.status != 'cancelled'
           AND o.payment_method = 'cod'`
      );
      const total = countResult.rows[0]?.total || 0;

      const rowsResult = await pool.query(
        `SELECT s.id AS "shipmentId", s.carrier_id AS "carrierId", s.tracking_number AS "trackingNumber",
                s.status AS "shipmentStatus", s.carrier_status_raw AS "carrierStatusRaw",
                s.carrier_status_desc AS "carrierStatusDesc", s.cod_amount_vnd AS "codAmountVnd",
                s.updated_at AS "returnedAt",
                o.id AS "orderId", o.order_number AS "orderNumber", o.customer_name AS "customerName",
                o.phone, o.city, o.total_vnd AS "orderTotalVnd", o.status AS "orderStatus",
                o.payment_method AS "paymentMethod",
                COALESCE(
                  json_agg(
                    json_build_object(
                      'productName', oi.product_name,
                      'variantName', oi.variant_name,
                      'sku', oi.sku,
                      'quantity', oi.quantity,
                      'unitPriceVnd', oi.unit_price_vnd
                    )
                  ) FILTER (WHERE oi.id IS NOT NULL), '[]'::json
                ) AS items
         FROM carrier_shipments s
         JOIN orders o ON o.id = s.order_id
         LEFT JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN cod_return_intakes cri ON cri.shipment_id = s.id
         WHERE s.status = 'returned'
           AND cri.id IS NULL
           AND o.status != 'cancelled'
           AND o.payment_method = 'cod'
         GROUP BY s.id, o.id
         ORDER BY s.updated_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      res.json({
        total,
        page,
        limit,
        pendingReturns: rowsResult.rows
      });
    } catch (e) {
      next(e);
    }
  });

  // 2. GET /lookup: Quét barcode / tra cứu nhanh kiện hàng hoàn theo mã vận đơn hoặc mã đơn
  router.get('/cod-returns/lookup', requirePermission('orders.read'), async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) throw fail('Vui lòng nhập hoặc quét mã vận đơn / mã đơn hàng.', 400);

      const result = await pool.query(
        `SELECT s.id AS "shipmentId", s.carrier_id AS "carrierId", s.tracking_number AS "trackingNumber",
                s.status AS "shipmentStatus", s.carrier_status_raw AS "carrierStatusRaw",
                s.carrier_status_desc AS "carrierStatusDesc", s.cod_amount_vnd AS "codAmountVnd",
                s.created_at AS "shippedAt", s.updated_at AS "lastSyncedAt",
                o.id AS "orderId", o.order_number AS "orderNumber", o.customer_name AS "customerName",
                o.phone, o.address, o.city, o.total_vnd AS "orderTotalVnd", o.status AS "orderStatus",
                o.payment_method AS "paymentMethod", o.payment_status AS "paymentStatus",
                cri.id AS "intakeId", cri.package_condition AS "packageCondition",
                cri.restocked, cri.created_at AS "intakeAt", cri.inspector,
                w.id AS "allocatedWarehouseId", w.name AS "allocatedWarehouseName",
                COALESCE(
                  json_agg(
                    json_build_object(
                      'variantId', oi.variant_id,
                      'productName', oi.product_name,
                      'variantName', oi.variant_name,
                      'sku', oi.sku,
                      'quantity', oi.quantity,
                      'unitPriceVnd', oi.unit_price_vnd
                    )
                  ) FILTER (WHERE oi.id IS NOT NULL), '[]'::json
                ) AS items
         FROM carrier_shipments s
         JOIN orders o ON o.id = s.order_id
         LEFT JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN cod_return_intakes cri ON cri.shipment_id = s.id
         LEFT JOIN order_stock_allocations osa ON osa.order_id = o.id AND osa.released_at IS NULL
         LEFT JOIN warehouses w ON w.id = osa.warehouse_id
         WHERE upper(s.tracking_number) = upper($1) OR upper(o.order_number) = upper($1)
         GROUP BY s.id, o.id, cri.id, w.id
         LIMIT 1`,
        [q]
      );

      if (!result.rows.length) {
        throw fail('Không tìm thấy thông tin vận đơn hoặc đơn hàng phù hợp với: ' + q, 404);
      }

      const row = result.rows[0];
      res.json({
        shipment: row,
        intakeStatus: row.intakeId ? 'completed' : 'pending'
      });
    } catch (e) {
      next(e);
    }
  });

  // 3. POST /intake: Kiểm nhận kiện hàng hoàn COD tại kho vật lý
  router.post('/cod-returns/intake', requirePermission('inventory.write'), requireCsrf, async (req, res, next) => {
    try {
      const data = intakeSchema.parse(req.body);

      const intakeResult = await withTransaction(pool, async client => {
        // Khóa carrier_shipments và orders FOR UPDATE
        const shipmentLookup = await client.query(
          `SELECT s.*, o.id AS "orderId", o.order_number AS "orderNumber",
                  o.customer_id AS "customerId", o.customer_name AS "customerName",
                  o.phone, o.email, o.status AS "orderStatus",
                  o.payment_method AS "paymentMethod", o.payment_status AS "paymentStatus",
                  o.total_vnd AS "totalVnd"
           FROM carrier_shipments s
           JOIN orders o ON o.id = s.order_id
           WHERE upper(s.tracking_number) = upper($1)
           FOR UPDATE OF s, o`,
          [data.trackingNumber]
        );

        if (!shipmentLookup.rows.length) {
          throw fail('Không tìm thấy vận đơn: ' + data.trackingNumber, 404);
        }

        const shipment = shipmentLookup.rows[0];

        // Ngăn chặn kiểm nhận trùng lặp
        const existingIntake = await client.query(
          'SELECT id, package_condition, created_at FROM cod_return_intakes WHERE shipment_id = $1',
          [shipment.id]
        );
        if (existingIntake.rows.length) {
          throw fail('Vận đơn này đã được kiểm nhận hoàn kho trước đó.', 409);
        }

        // 1. Chỉ áp dụng cho đơn hàng COD
        if (shipment.paymentMethod !== 'cod') {
          throw fail(`Đơn hàng (${shipment.orderNumber}) sử dụng phương thức thanh toán ${(shipment.paymentMethod || '').toUpperCase()}, không phải đơn COD. Chỉ đơn COD mới được xử lý hoàn qua luồng này.`, 400);
        }

        // 2. Không cho phép kiểm nhận hoàn đơn COD đã thu tiền/đối soát
        if (shipment.paymentStatus === 'paid') {
          throw fail(`Đơn hàng COD (${shipment.orderNumber}) đã được ghi nhận thanh toán/đối soát. Vui lòng đối soát kế toán trước khi xử lý hủy đơn hoặc hoàn tiền.`, 409);
        }

        // 3. Đơn hàng đã ở trạng thái hủy trước đó
        if (shipment.orderStatus === 'cancelled') {
          throw fail(`Đơn hàng (${shipment.orderNumber}) đã ở trạng thái hủy trước đó.`, 409);
        }

        // 4. Đơn hàng đã giao thành công không được kiểm nhận hoàn COD tự động
        if (shipment.orderStatus === 'completed') {
          throw fail('Đơn hàng đã hoàn tất giao hàng thành công; không thể kiểm nhận chuyển hoàn tự động.', 409);
        }

        // 5. Xác minh trạng thái giao vận: Chỉ bưu phẩm đã hoàn tất chuyển trả về người gửi (status = 'returned', ví dụ Viettel 504)
        // mới được mở kiểm nhận nhập lại tồn kho khả dụng (không nhập kho khi mới 505 return_requested hoặc 502 returning).
        if (shipment.status !== 'returned') {
          throw fail(`Vận đơn ${shipment.tracking_number} đang ở trạng thái "${shipment.status}" (chưa hoàn tất chuyển hoàn về kho người gửi). Chỉ bưu phẩm đã xác nhận hoàn trả người gửi (returned) mới được kiểm nhận hoàn kho.`, 400);
        }

        // Lấy danh sách sản phẩm
        const itemsResult = await client.query(
          `SELECT id, variant_id AS "variantId", product_name AS "productName",
                  variant_name AS "variantName", sku, quantity, unit_price_vnd AS "unitPriceVnd"
           FROM order_items WHERE order_id = $1`,
          [shipment.orderId]
        );
        const items = itemsResult.rows;

        // GAERU F-08: Kiểm tra đơn hàng có phân bổ nhiều kho không để tránh ghi lệch kho vật lý
        const allocWarehouseIds = (await client.query(
          `SELECT DISTINCT warehouse_id FROM order_stock_allocations WHERE order_id = $1 AND released_at IS NULL`,
          [shipment.orderId]
        )).rows.map(r => r.warehouse_id);

        if (allocWarehouseIds.length > 1) {
          throw fail(`Đơn hàng (${shipment.orderNumber}) được phân bổ từ nhiều kho khác nhau (${allocWarehouseIds.length} kho). Kiểm nhận hoàn kho một chạm chỉ hỗ trợ đơn xuất từ một kho duy nhất để bảo đảm đối soát tồn kho chính xác. Vui lòng xử lý qua quy trình RMA từng kho.`, 400);
        }

        // Xác định kho tiếp nhận
        let targetWarehouseId = data.warehouseId;
        let targetWarehouseName = '';

        if (!targetWarehouseId) {
          if (allocWarehouseIds.length === 1) {
            targetWarehouseId = allocWarehouseIds[0];
            const wRow = (await client.query('SELECT name FROM warehouses WHERE id = $1', [targetWarehouseId])).rows[0];
            targetWarehouseName = wRow?.name || '';
          } else {
            const mainW = (await client.query("SELECT id, name FROM warehouses WHERE code = 'MAIN' OR active = true ORDER BY created_at ASC LIMIT 1")).rows[0];
            if (mainW) {
              targetWarehouseId = mainW.id;
              targetWarehouseName = mainW.name;
            }
          }
        } else {
          const wRow = (await client.query('SELECT name FROM warehouses WHERE id = $1', [targetWarehouseId])).rows[0];
          targetWarehouseName = wRow?.name || '';

          if (allocWarehouseIds.length && !allocWarehouseIds.includes(targetWarehouseId)) {
            throw fail(`Kho tiếp nhận (${targetWarehouseName || targetWarehouseId}) khác kho xuất hàng ban đầu. Vui lòng chọn đúng kho xuất ban đầu để hoàn tồn chính xác.`, 400);
          }
        }

        let restocked = false;
        let claimedDamage = false;
        let conditionDesc = '';

        if (data.packageCondition === 'intact') {
          // Hàng nguyên seal/nguyên vẹn -> Nhả lại tồn kho khả dụng để bán tiếp
          await inventory.releaseOrderStock(client, { orderId: shipment.orderId, actor: req.admin });
          restocked = true;
          conditionDesc = 'Nguyên vẹn / Đủ điều kiện tái nhập kho';
        } else {
          // Hàng bị hư hỏng hoặc mất cắp/tráo ruột -> Giải phóng giữ chỗ, KHÔNG cộng vào tồn khả dụng
          await client.query(
            'UPDATE order_stock_allocations SET released_at = now() WHERE order_id = $1 AND released_at IS NULL',
            [shipment.orderId]
          );
          restocked = false;
          claimedDamage = true;
          conditionDesc = data.packageCondition === 'damaged'
            ? 'Hư hỏng bao bì/thiết bị do vận chuyển (Đã cách ly, không nhập bán)'
            : 'Mất hàng / Bị tráo ruột trong quá trình vận chuyển (Lập biên bản khiếu nại)';
        }

        // Cập nhật trạng thái đơn hàng sang cancelled với lý do minh bạch
        const cancelReason = `Kiểm nhận hàng hoàn COD [${conditionDesc}]` + (data.inspectionNotes ? ` - Ghi chú: ${data.inspectionNotes}` : '');
        await client.query(
          `UPDATE orders
           SET status = 'cancelled',
               cancellation_reason = $2,
               updated_at = now()
           WHERE id = $1`,
          [shipment.orderId, cancelReason]
        );

        await client.query(
          `UPDATE payment_attempts
           SET status = 'failed',
               updated_at = now()
           WHERE order_id = $1 AND status = 'pending'`,
          [shipment.orderId]
        );

        await client.query(
          `UPDATE voucher_redemptions
           SET released = true
           WHERE order_id = $1 AND released = false`,
          [shipment.orderId]
        );

        // Cập nhật hành trình vận đơn
        const history = Array.isArray(shipment.tracking_history) ? shipment.tracking_history : [];
        history.push({
          timestamp: new Date().toISOString(),
          status: 'returned',
          rawStatus: 'intake_' + data.packageCondition,
          description: `Kho GAERU đã kiểm nhận kiện hàng hoàn: ${conditionDesc} (Thực hiện: ${req.admin?.username || 'admin'})`
        });

        await client.query(
          `UPDATE carrier_shipments
           SET status = 'returned',
               carrier_status_raw = COALESCE(carrier_status_raw, 'returned'),
               carrier_status_desc = $2,
               tracking_history = $3,
               updated_at = now()
           WHERE id = $1`,
          [shipment.id, `Đã kiểm nhận hoàn: ${conditionDesc}`, JSON.stringify(history)]
        );

        // Hoàn điểm loyalty nếu khách có dùng điểm trong đơn này
        if (shipment.customerId) {
          try {
            const { refundPoints } = require('./loyalty-api');
            await refundPoints(client, {
              customerId: shipment.customerId,
              orderId: shipment.orderId,
              reason: 'Hoàn điểm do đơn COD chuyển hoàn',
              actor: req.admin
            });
          } catch (loyaltyErr) {
            console.error(`[COD-INTAKE] Lỗi khi hoàn điểm loyalty cho đơn ${shipment.orderNumber}:`, loyaltyErr);
            throw fail('Lỗi khi hoàn điểm tích lũy của khách hàng: ' + loyaltyErr.message, 500);
          }
        }

        // Lưu bản ghi kiểm nhận cod_return_intakes
        const insertIntake = await client.query(
          `INSERT INTO cod_return_intakes(
             order_id, shipment_id, carrier_id, tracking_number, order_number,
             package_condition, warehouse_id, warehouse_name, restocked,
             claimed_damage, carrier_fault, inspection_notes, evidence_urls,
             inspector, items_snapshot
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING id, created_at AS "createdAt"`,
          [
            shipment.orderId,
            shipment.id,
            shipment.carrier_id,
            shipment.tracking_number,
            shipment.orderNumber,
            data.packageCondition,
            targetWarehouseId,
            targetWarehouseName,
            restocked,
            claimedDamage,
            data.carrierFault,
            data.inspectionNotes,
            JSON.stringify(data.evidenceUrls),
            req.admin?.username || 'admin',
            JSON.stringify(items)
          ]
        );

        const intakeRecord = insertIntake.rows[0];

        // Ghi nhật ký kiểm toán bất biến
        await appendAudit(client, {
          actor: req.admin,
          action: 'cod_return.intake',
          entityType: 'order',
          entityId: shipment.orderId,
          metadata: {
            intakeId: intakeRecord.id,
            trackingNumber: shipment.tracking_number,
            carrierId: shipment.carrier_id,
            packageCondition: data.packageCondition,
            restocked,
            warehouseId: targetWarehouseId,
            carrierFault: data.carrierFault,
            inspectionNotes: data.inspectionNotes
          }
        });

        return {
          intakeId: intakeRecord.id,
          orderId: shipment.orderId,
          orderNumber: shipment.orderNumber,
          trackingNumber: shipment.tracking_number,
          packageCondition: data.packageCondition,
          restocked,
          claimedDamage,
          message: restocked
            ? 'Đã kiểm nhận hàng hoàn nguyên vẹn. Tồn kho đã được hoàn lại khả dụng.'
            : 'Đã kiểm nhận hàng hoàn bất thường/hư hỏng. Đã cách ly sản phẩm và lập hồ sơ khiếu nại.'
        };
      });

      res.json(intakeResult);
    } catch (e) {
      if (e instanceof z.ZodError) {
        const msg = e.issues?.[0]?.message || e.errors?.[0]?.message || 'Dữ liệu kiểm nhận không hợp lệ.';
        return res.status(400).json({ error: msg });
      }
      next(e);
    }
  });

  // 4. GET /history: Lịch sử các kiện hàng đã kiểm nhận
  router.get('/cod-returns/history', requirePermission('orders.read'), async (req, res, next) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const offset = (page - 1) * limit;
      const condition = req.query.condition ? String(req.query.condition).trim() : null;

      let whereClause = '1=1';
      const params = [];
      if (condition && ['intact', 'damaged', 'lost_or_tampered'].includes(condition)) {
        params.push(condition);
        whereClause += ` AND cri.package_condition = $${params.length}`;
      }

      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM cod_return_intakes cri WHERE ${whereClause}`,
        params
      );
      const total = countResult.rows[0]?.total || 0;

      params.push(limit, offset);
      const rowsResult = await pool.query(
        `SELECT cri.id, cri.order_id AS "orderId", cri.shipment_id AS "shipmentId",
                cri.carrier_id AS "carrierId", cri.tracking_number AS "trackingNumber",
                cri.order_number AS "orderNumber", cri.package_condition AS "packageCondition",
                cri.warehouse_name AS "warehouseName", cri.restocked, cri.claimed_damage AS "claimedDamage",
                cri.carrier_fault AS "carrierFault", cri.inspection_notes AS "inspectionNotes",
                cri.evidence_urls AS "evidenceUrls", cri.inspector, cri.items_snapshot AS "itemsSnapshot",
                cri.created_at AS "createdAt"
         FROM cod_return_intakes cri
         WHERE ${whereClause}
         ORDER BY cri.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      res.json({
        total,
        page,
        limit,
        history: rowsResult.rows
      });
    } catch (e) {
      next(e);
    }
  });

  // 5. GET /claims: Danh sách các đơn hư hại/thất lạc do hãng vận chuyển cần theo dõi bồi thường
  router.get('/cod-returns/claims', requirePermission('orders.read'), async (req, res, next) => {
    try {
      const rowsResult = await pool.query(
        `SELECT cri.id, cri.order_id AS "orderId", cri.shipment_id AS "shipmentId",
                cri.carrier_id AS "carrierId", cri.tracking_number AS "trackingNumber",
                cri.order_number AS "orderNumber", cri.package_condition AS "packageCondition",
                cri.carrier_fault AS "carrierFault", cri.inspection_notes AS "inspectionNotes",
                cri.evidence_urls AS "evidenceUrls", cri.inspector, cri.items_snapshot AS "itemsSnapshot",
                cri.created_at AS "createdAt",
                o.total_vnd AS "claimAmountVnd", o.customer_name AS "customerName", o.phone
         FROM cod_return_intakes cri
         JOIN orders o ON o.id = cri.order_id
         WHERE cri.claimed_damage = true OR cri.carrier_fault = true OR cri.package_condition IN ('damaged', 'lost_or_tampered')
         ORDER BY cri.created_at DESC
         LIMIT 100`
      );

      res.json({
        totalClaims: rowsResult.rows.length,
        claims: rowsResult.rows
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createCodReturnIntake };
