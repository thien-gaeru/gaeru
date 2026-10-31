'use strict';

const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { requireCsrf } = require('../security');
const { AdminAction } = require('../admin-action');
const { withTransaction } = require('../db');
const { isOnlineGateway } = require('../domain/payments/payment-policy');
const { PaymentService } = require('../domain/payments/payment-service');
const { transitions, orderUpdateSchema, settingsSchema, requireUuidParam } = require('./store-schemas');
const { getSettings } = require('./carrier-and-catalog-loader');

function attachAdminOrderAndSettingsRoutes(router, pool, {
  inventory,
  finance,
  audit,
  shippingChoices,
  checkoutAccounts,
  config,
  paymentFetcher,
  misaFetcher
}) {
  async function applyOrderUpdate(client, id, update, actor) {
    const currentResult = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
    const current = currentResult.rows[0];
    if (!current) return null;
    if (current.return_completed_at) {
      throw Object.assign(Error('Đơn đã hoàn trả xong; không thể xử lý lại.'), { status: 409 });
    }
    if (actor) {
      const fulfillmentChange =
        (update.status !== undefined && update.status !== current.status) ||
        (update.shippingFeeVnd !== undefined && update.shippingFeeVnd !== current.shipping_fee_vnd);
      const paymentChange = update.paymentStatus !== undefined && update.paymentStatus !== current.payment_status;
      if ((fulfillmentChange && !actor.permissions.includes('orders.write')) ||
          (paymentChange && !actor.permissions.includes('payments.write'))) {
        throw Object.assign(new Error('Tài khoản không có quyền cập nhật nghiệp vụ này.'), { status: 403 });
      }
    }
    if (
      checkoutAccounts &&
      update.status &&
      ['confirmed', 'processing', 'shipped', 'completed'].includes(update.status) &&
      (await client.query('SELECT order_id FROM order_reviews WHERE order_id=$1 AND resolved_at IS NULL', [current.id])).rows.length
    ) {
      throw Object.assign(Error('Cần gọi xác nhận và xử lý đơn trong mục Đơn hàng rác / chờ xác minh trước.'), { status: 409 });
    }

    const receivedAmount = finance ? await finance.receiptTotal(client, current.id) : 0;
    if (
      receivedAmount > 0 &&
      ((update.status === 'cancelled' && current.status !== 'cancelled') ||
        (update.shippingFeeVnd !== undefined && update.shippingFeeVnd !== current.shipping_fee_vnd))
    ) {
      throw Object.assign(new Error('Đơn đã ghi nhận thu tiền; cần đối soát/hoàn tiền trước khi hủy hoặc đổi tổng tiền.'), { status: 409 });
    }

    const prepaidAutoProcess = current.payment_method !== 'cod' && (current.payment_status === 'paid' || update.paymentStatus === 'paid');
    if (
      update.status &&
      update.status !== current.status &&
      !transitions[current.status].includes(update.status) &&
      !(prepaidAutoProcess && current.status === 'pending' && update.status === 'processing')
    ) {
      throw Object.assign(new Error(`Không thể chuyển đơn từ ${current.status} sang ${update.status}.`), { status: 409 });
    }

    const paymentStatusChanged = update.paymentStatus !== undefined && update.paymentStatus !== current.payment_status;
    if (current.payment_status === 'paid' && paymentStatusChanged) {
      throw Object.assign(new Error('Không thể chuyển đơn đã thanh toán về chưa thanh toán. Cần đối soát hoặc xử lý hoàn tiền riêng.'), { status: 409 });
    }
    if (paymentStatusChanged && isOnlineGateway(current.payment_method)) {
      throw Object.assign(new Error('Trạng thái thanh toán trực tuyến được cập nhật từ cổng thanh toán, không thể sửa thủ công.'), { status: 409 });
    }
    if (update.status === 'cancelled' && current.status !== 'cancelled' && current.payment_status === 'paid') {
      throw Object.assign(new Error('Đơn đã thanh toán cần được xử lý hoàn tiền trước khi hủy.'), { status: 409 });
    }

    const autoApproveToProcessing =
      paymentStatusChanged &&
      update.paymentStatus === 'paid' &&
      current.payment_method !== 'cod' &&
      ['pending', 'confirmed'].includes(current.status) &&
      (!update.status || ['pending', 'confirmed', 'processing'].includes(update.status));

    const targetStatus = autoApproveToProcessing ? 'processing' : (update.status ?? current.status);
    const targetPaymentStatus = update.paymentStatus ?? current.payment_status;
    const shippingFee = update.shippingFeeVnd ?? current.shipping_fee_vnd;
    const shippingFeeChanged = update.shippingFeeVnd !== undefined && update.shippingFeeVnd !== current.shipping_fee_vnd;

    if (shippingFeeChanged && current.payment_status === 'paid') {
      throw Object.assign(new Error('Không thể thay đổi phí giao hàng sau khi đơn đã thanh toán.'), { status: 409 });
    }
    if (shippingFeeChanged && isOnlineGateway(current.payment_method)) {
      const paymentAttempt = await client.query(
        'SELECT EXISTS (SELECT 1 FROM payment_attempts WHERE order_id = $1) AS active',
        [current.id]
      );
      if (paymentAttempt.rows[0]?.active) {
        throw Object.assign(new Error('Không thể thay đổi phí sau khi đã tạo phiên thanh toán VNPAY.'), { status: 409 });
      }
    }
    if (update.status === 'cancelled' && current.status !== 'cancelled' && isOnlineGateway(current.payment_method)) {
      const activeAttempt = await client.query(
        `SELECT
           EXISTS (
             SELECT 1 FROM payment_attempts
             WHERE order_id = $1 AND status IN ('payment_initiation_unknown', 'awaiting_reconciliation')
           ) AS unresolved,
           EXISTS (
             SELECT 1 FROM payment_attempts
             WHERE order_id = $1 AND status = 'pending' AND expires_at > now()
           ) AS active`,
        [current.id]
      );
      if (activeAttempt.rows[0]?.unresolved) {
        throw Object.assign(new Error('Đơn đang chờ đối soát trạng thái giao dịch với cổng thanh toán; cần xác minh chưa thu tiền trước khi hủy đơn.'), { status: 409 });
      }
      if (activeAttempt.rows[0]?.active) {
        throw Object.assign(new Error('Chờ hết hạn phiên thanh toán VNPAY trước khi hủy đơn.'), { status: 409 });
      }
    }
    if (shippingFeeChanged && current.status !== 'pending') {
      throw Object.assign(new Error('Phí giao hàng chỉ được thay đổi khi đơn còn chờ xác nhận.'), { status: 409 });
    }
    if (update.status === 'confirmed' && update.shippingFeeVnd === undefined && current.shipping_fee_vnd === null) {
      throw Object.assign(new Error('Nhập phí giao hàng để chốt tổng tiền trước khi xác nhận đơn.'), { status: 409 });
    }
    if (targetStatus === 'completed' && targetPaymentStatus !== 'paid') {
      throw Object.assign(new Error('Chỉ hoàn tất đơn sau khi xác nhận đã thu đủ tiền.'), { status: 409 });
    }
    if (paymentStatusChanged && update.paymentStatus === 'paid' && targetStatus === 'cancelled') {
      throw Object.assign(new Error('Không thể ghi nhận thanh toán cho đơn đã hủy.'), { status: 409 });
    }
    if (update.paymentStatus === 'paid' && shippingFee === null) {
      throw Object.assign(new Error('Chốt phí giao hàng trước khi ghi nhận thanh toán.'), { status: 409 });
    }
    if (update.paymentStatus === 'paid' && current.payment_method === 'cod' && targetStatus !== 'completed') {
      throw Object.assign(new Error('Đơn COD chỉ được ghi nhận đã thanh toán sau khi giao hàng.'), { status: 409 });
    }

    if (update.status === 'cancelled' && current.status !== 'cancelled') {
      if (current.voucher_code) {
        await client.query('UPDATE voucher_redemptions SET released=true WHERE order_id=$1 AND released=false', [current.id]);
      }
      if (inventory) {
        await inventory.releaseOrderStock(client, { orderId: current.id, actor });
      } else {
        await client.query(
          `UPDATE product_variants v SET stock_quantity = v.stock_quantity + i.quantity, updated_at=now()
           FROM order_items i WHERE i.order_id=$1 AND i.variant_id=v.id`,
          [current.id]
        );
      }
    }

    const total = shippingFee === null ? null : current.subtotal_vnd + shippingFee - (current.discount_vnd || 0);
    if (total !== null && total > 2_000_000_000) {
      throw Object.assign(new Error('Tổng đơn hàng vượt giới hạn cho phép.'), { status: 400 });
    }
    if (finance && update.paymentStatus === 'paid' && current.payment_status !== 'paid') {
      await finance.recordFullOrderPayment(client, { order: { ...current, total_vnd: total }, actor });
    }

    const updated = await client.query(
      `UPDATE orders SET status=COALESCE($2, status), payment_status=COALESCE($3, payment_status),
        shipping_fee_vnd=$4, total_vnd=$5, updated_at=now()
       WHERE id=$1 RETURNING id, status, payment_status AS "paymentStatus",
         shipping_fee_vnd AS "shippingFeeVnd", total_vnd AS "totalVnd"`,
      [current.id, (autoApproveToProcessing ? 'processing' : update.status) || null, update.paymentStatus || null, shippingFee, total]
    );
    await audit(client, {
      actor,
      action: 'order.update',
      entityType: 'order',
      entityId: current.id,
      before: { status: current.status, paymentStatus: current.payment_status, shippingFeeVnd: current.shipping_fee_vnd },
      after: updated.rows[0]
    });
    return updated.rows[0];
  }

  router.get('/gaeru_ceo/orders', async (req, res) => {
    const status = String(req.query.status || '');
    if (status && !Object.hasOwn(transitions, status) && !['ready_to_ship', 'cancelled_or_returned', 'payment_pending'].includes(status)) {
      return res.status(400).json({ error: 'Bộ lọc trạng thái đơn hàng không hợp lệ.' });
    }
    const paymentStatus = String(req.query.paymentStatus || '');
    const paymentMethod = String(req.query.paymentMethod || '');
    if ((paymentStatus && !['pending', 'paid'].includes(paymentStatus)) ||
        (paymentMethod && !['cod', 'bank_transfer', '9pay', 'vnpay', 'momo', 'zalopay'].includes(paymentMethod))) {
      return res.status(400).json({ error: 'Bộ lọc thanh toán đơn hàng không hợp lệ.' });
    }
    const search = String(req.query.q || '').trim();
    const requestedPage = Number(req.query.page || 1);
    if (search.length > 120 || !Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 100000) {
      return res.status(400).json({ error: 'Bộ lọc hoặc trang đơn hàng không hợp lệ.' });
    }
    const pageSize = Number(req.query.pageSize || 25);
    const sort = String(req.query.sort || 'newest');
    const sortSql = {
      newest: 'o.created_at DESC, o.id DESC',
      oldest: 'o.created_at ASC, o.id ASC',
      highest: 'o.total_vnd DESC NULLS LAST, o.id DESC',
      lowest: 'o.total_vnd ASC NULLS LAST, o.id ASC'
    };
    if (![20, 25, 50, 100].includes(pageSize) || !Object.hasOwn(sortSql, sort)) {
      return res.status(400).json({ error: 'Bộ lọc sắp xếp hoặc số đơn mỗi trang không hợp lệ.' });
    }

    const exportXlsx = req.query.format === 'xlsx';
    const exportAll = exportXlsx && req.query.scope === 'all';
    const filterValues = [status, search, paymentStatus, paymentMethod];
    const excludeReviews = checkoutAccounts && status !== 'payment_pending' && !search;
    const where = `${excludeReviews ? 'NOT EXISTS (SELECT 1 FROM order_reviews r WHERE r.order_id=o.id AND r.resolved_at IS NULL) AND ' : ''}($1::text = '' OR o.status = $1
      OR ($1='ready_to_ship' AND o.status IN ('confirmed','processing') AND o.return_completed_at IS NULL)
      OR ($1='payment_pending' AND o.payment_status = 'pending' AND o.status <> 'cancelled' AND o.return_completed_at IS NULL)
      OR ($1='cancelled_or_returned' AND (o.status='cancelled' OR EXISTS(SELECT 1 FROM order_after_sales a WHERE a.order_id=o.id AND a.kind='return'))))
      AND ($2::text = '' OR o.order_number ILIKE '%' || $2 || '%'
        OR o.customer_name ILIKE '%' || $2 || '%'
        OR o.email ILIKE '%' || $2 || '%' OR o.phone ILIKE '%' || $2 || '%')
      AND ($3::text = '' OR (o.payment_status = $3 AND ($3 <> 'pending' OR (o.status <> 'cancelled' AND o.return_completed_at IS NULL) OR $1 IN ('cancelled','cancelled_or_returned'))))
      AND ($4::text = '' OR o.payment_method = $4)
      AND ($1 NOT IN ('completed','shipped') OR o.return_completed_at IS NULL)`;

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM orders o WHERE ${where}`, filterValues);
    const total = countResult.rows[0]?.total || 0;
    if (exportAll && total > 5000) {
      return res.status(400).json({ error: 'Có hơn 5.000 đơn. Thu hẹp bộ lọc hoặc xuất từng trang.' });
    }
    const pageCount = Math.ceil(total / pageSize);
    const page = Math.min(requestedPage, Math.max(1, pageCount));

    const result = await pool.query(
      `SELECT o.id, o.order_number AS "orderNumber", o.customer_name AS "customerName",
              o.email, o.phone, o.address, o.city, o.note, o.payment_method AS "paymentMethod",
              o.payment_status AS "paymentStatus", o.status, o.discount_vnd AS "discountVnd",
              o.voucher_code AS "voucherCode", o.subtotal_vnd AS "subtotalVnd",
              o.shipping_fee_vnd AS "shippingFeeVnd", o.total_vnd AS "totalVnd",
              o.created_at AS "createdAt", o.management_version AS version, o.return_completed_at AS "returnedAt",
              (SELECT s.carrier_name FROM order_shipping_selection s WHERE s.order_id=o.id LIMIT 1) AS "shippingCarrierName",
              (SELECT s.carrier_id FROM order_shipping_selection s WHERE s.order_id=o.id LIMIT 1) AS "shippingCarrierId",
              CASE
                WHEN o.return_completed_at IS NOT NULL THEN 'returned'
                WHEN EXISTS(SELECT 1 FROM order_after_sales a WHERE a.order_id=o.id AND a.kind='return' AND a.status NOT IN ('resolved','rejected')) THEN 'open'
                ELSE NULL
              END AS "returnStatus",
              p.provider AS "paymentProvider", p.status AS "paymentAttemptStatus", p.expires_at AS "paymentAttemptExpiresAt",
              ${checkoutAccounts ? '(SELECT r.reason FROM order_reviews r WHERE r.order_id=o.id AND r.resolved_at IS NULL ORDER BY r.created_at DESC LIMIT 1) AS "reviewReason",' : 'NULL AS "reviewReason",'}
              COALESCE(jsonb_agg(jsonb_build_object(
                'productName', i.product_name, 'variantName', i.variant_name,
                'sku', i.sku, 'unitPriceVnd', i.unit_price_vnd,
                'quantity', i.quantity, 'lineTotalVnd', i.line_total_vnd
              )) FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb) AS items
       FROM orders o
       LEFT JOIN order_items i ON i.order_id = o.id
       LEFT JOIN LATERAL (
         SELECT provider, status, expires_at FROM payment_attempts WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1
       ) p ON true
       WHERE ${where}
       GROUP BY o.id, p.provider, p.status, p.expires_at
       ORDER BY ${sortSql[sort]} LIMIT $5 OFFSET $6`,
      [...filterValues, exportAll ? 5000 : pageSize, exportAll ? 0 : (page - 1) * pageSize]
    );

    if (shippingChoices && result.rows.length) {
      const selected = (await pool.query(
        'SELECT order_id,carrier_name FROM order_shipping_selection WHERE order_id=ANY($1::uuid[])',
        [result.rows.map((o) => o.id)]
      )).rows;
      for (const order of result.rows) {
        order.shippingCarrierName = selected.find((r) => r.order_id === order.id)?.carrier_name || null;
      }
    }
    if (finance && result.rows.length) {
      const receipts = await pool.query(
        'SELECT order_id, SUM(amount_vnd) AS received FROM sales_receipts WHERE order_id=ANY($1::uuid[]) GROUP BY order_id',
        [result.rows.map((order) => order.id)]
      );
      const receivedByOrder = new Map(receipts.rows.map((row) => [row.order_id, Number(row.received)]));
      for (const order of result.rows) {
        order.receivedVnd = order.paymentStatus === 'paid' ? order.totalVnd : (receivedByOrder.get(order.id) || 0);
        order.outstandingVnd = order.totalVnd === null ? null : Math.max(0, order.totalVnd - order.receivedVnd);
      }
    }
    if (config && result.rows.length) {
      try {
        const einvoices = await pool.query(
          'SELECT order_id, invoice_number AS "invoiceNumber", invoice_series AS "invoiceSeries", template_code AS "templateCode", view_url AS "viewUrl", issued_at AS "issuedAt" FROM misa_einvoices WHERE order_id=ANY($1::uuid[])',
          [result.rows.map((order) => order.id)]
        );
        const invoiceMap = new Map(einvoices.rows.map((r) => [r.order_id, r]));
        for (const order of result.rows) {
          order.einvoice = invoiceMap.get(order.id) || null;
        }
      } catch {}
    }

    if (exportXlsx) {
      const buffer = await require('../order-export').orderWorkbook(result.rows);
      return res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="gaeru-orders.xlsx"',
        'Cache-Control': 'no-store'
      }).send(Buffer.from(buffer));
    }

    let overview;
    if (req.query.overview === '1') {
      const counts = await pool.query(
        `SELECT CASE WHEN o.return_completed_at IS NOT NULL THEN 'returned' ELSE o.status END AS status, COUNT(*)::int AS total FROM orders o WHERE ${checkoutAccounts ? 'NOT EXISTS (SELECT 1 FROM order_reviews r WHERE r.order_id=o.id AND r.resolved_at IS NULL)' : 'true'} GROUP BY CASE WHEN o.return_completed_at IS NOT NULL THEN 'returned' ELSE o.status END`
      );
      overview = Object.fromEntries(counts.rows.map((row) => [row.status, row.total]));
      const cancelledAndReturns = await pool.query(
        `SELECT count(*)::int AS total FROM orders o WHERE ${checkoutAccounts ? 'NOT EXISTS (SELECT 1 FROM order_reviews r WHERE r.order_id=o.id AND r.resolved_at IS NULL) AND ' : ''}(o.status='cancelled' OR EXISTS(SELECT 1 FROM order_after_sales a WHERE a.order_id=o.id AND a.kind='return'))`
      );
      overview.cancelled_or_returned = cancelledAndReturns.rows[0]?.total || 0;
    }

    res.json({
      ...(overview ? { overview } : {}),
      orders: result.rows,
      pagination: { page, pageSize, total, pageCount }
    });
  });

  router.post(
    '/gaeru_ceo/orders/bulk',
    AdminAction('orders.write'),
    rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const parsed = z.object({
          action: z.enum(['confirm', 'prepare', 'ship', 'complete', 'cancel']),
          confirmReceived: z.boolean().default(false),
          orders: z.array(z.object({
            id: z.string().uuid(),
            expectedStatus: z.enum(['pending', 'confirmed', 'processing', 'shipped', 'completed', 'cancelled']),
            expectedPaymentStatus: z.enum(['pending', 'paid']),
            expectedTotalVnd: z.number().int().min(0).max(2000000000).nullable()
          }).strict()).min(1).max(100).refine((rows) => new Set(rows.map((o) => o.id)).size === rows.length)
        }).strict().safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'Chọn từ 1 đến 100 đơn khác nhau và bước xử lý hợp lệ.' });
        const data = parsed.data;
        const target = { confirm: 'confirmed', prepare: 'processing', ship: 'shipped', complete: 'completed', cancel: 'cancelled' }[data.action];

        const result = await withTransaction(pool, async (client) => {
          const changed = [];
          for (const expected of [...data.orders].sort((a, b) => a.id.localeCompare(b.id))) {
            const current = (await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [expected.id])).rows[0];
            if (!current) throw Object.assign(Error('Có đơn không còn tồn tại. Tải lại danh sách.'), { status: 409 });
            if (
              current.status !== expected.expectedStatus ||
              current.payment_status !== expected.expectedPaymentStatus ||
              current.total_vnd !== expected.expectedTotalVnd
            ) {
              throw Object.assign(Error('Đơn ' + current.order_number + ' đã thay đổi. Tải lại trước khi xử lý hàng loạt.'), { status: 409 });
            }
            if (!transitions[current.status].includes(target)) {
              throw Object.assign(Error('Đơn ' + current.order_number + ' không ở bước phù hợp. Các đơn cần cùng đủ điều kiện cho thao tác đã chọn.'), { status: 409 });
            }
            const update = { status: target };
            if (target === 'completed' && current.payment_status !== 'paid') {
              if (!data.confirmReceived) {
                throw Object.assign(Error('Xác nhận đã thu đủ tiền trước khi hoàn tất các đơn chưa thanh toán.'), { status: 409 });
              }
              update.paymentStatus = 'paid';
            }
            changed.push(await applyOrderUpdate(client, expected.id, update, req.admin));
          }
          return changed;
        });

        if (target === 'completed') {
          try {
            const { autoIssueForOrder } = require('../misa-einvoice');
            for (const order of result) {
              if (order.status === 'completed' && order.paymentStatus === 'paid') {
                await autoIssueForOrder(pool, config, order.id, { fetcher: misaFetcher });
              }
            }
          } catch (misaErr) {
            console.error('MISA auto-issue error in bulk:', misaErr.message);
          }
        }
        res.json({ orders: result, targetStatus: target, message: 'Đã cập nhật ' + result.length + ' đơn hàng.' });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    '/gaeru_ceo/orders/:id/restore',
    AdminAction('orders.write'),
    requireUuidParam('id'),
    rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const { restoreOrder, restorationSchema } = require('../order-restoration');
        const data = restorationSchema.parse(req.body);
        const order = await withTransaction(pool, (client) =>
          restoreOrder(client, {
            id: req.params.id,
            data,
            actor: req.admin,
            inventory: inventory || require('../inventory'),
            audit
          })
        );
        res.json({
          order,
          message: order.alreadyRestored
            ? 'Yêu cầu đã được xử lý trước đó.'
            : 'Đã khôi phục đơn về Chờ xác nhận và giữ lại tồn kho. Chưa ghi nhận thanh toán hoặc gửi hàng.'
        });
      } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Nhập lý do, phiên bản và xác nhận đã đối chiếu chưa nhận tiền trước khi khôi phục.' });
        if (error.code === '23505') return res.status(409).json({ error: 'Mã yêu cầu khôi phục đã được dùng. Tải lại để kiểm tra trạng thái.' });
        if (error.status) return res.status(error.status).json({ error: error.message });
        next(error);
      }
    }
  );

  router.post(
    '/gaeru_ceo/orders/:id/reconcile-payment',
    AdminAction('orders.write'),
    requireUuidParam('id'),
    rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res, next) => {
      try {
        const outcome = await PaymentService.reconcileOrder(pool, {
          orderId: req.params.id,
          config: config || {},
          fetcher: paymentFetcher,
          inventory: inventory || require('../inventory'),
          finance,
          audit,
          actor: req.admin
        });
        res.json(outcome);
      } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message });
        next(error);
      }
    }
  );

  const handleOrderPermanentDelete = async (req, res, next) => {
    try {
      const { deleteOrderPermanently } = require('../order-deletion');
      const deleted = await withTransaction(pool, (client) =>
        deleteOrderPermanently(client, req.params.id, {
          actor: req.admin,
          inventory: inventory || require('../inventory')
        })
      );
      if (!deleted) return res.status(404).json({ error: 'Không tìm thấy đơn hàng.' });
      res.json({
        id: req.params.id,
        orderNumber: deleted.order_number,
        message: 'Đã xóa vĩnh viễn đơn hàng ' + (deleted.order_number || req.params.id) + ' khỏi hệ thống và loại khỏi dữ liệu doanh số.'
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  };

  router.post(
    '/gaeru_ceo/orders/:id/permanent-delete',
    AdminAction('orders.write'),
    requireUuidParam('id'),
    rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }),
    handleOrderPermanentDelete
  );
  router.delete(
    '/gaeru_ceo/orders/:id',
    AdminAction('orders.write'),
    requireUuidParam('id'),
    rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }),
    handleOrderPermanentDelete
  );

  router.patch('/gaeru_ceo/orders/:id', requireUuidParam('id'), requireCsrf, async (req, res, next) => {
    try {
      const parsed = orderUpdateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Cập nhật đơn hàng chưa hợp lệ.', details: parsed.error.issues });
      const update = parsed.data;
      const result = await withTransaction(pool, async (client) => applyOrderUpdate(client, req.params.id, update, req.admin));
      if (!result) return res.status(404).json({ error: 'Không tìm thấy đơn hàng.' });
      if (result.status === 'completed' && result.paymentStatus === 'paid') {
        try {
          const { autoIssueForOrder } = require('../misa-einvoice');
          await autoIssueForOrder(pool, config, req.params.id, { fetcher: misaFetcher });
        } catch (misaErr) {
          console.error('MISA auto-issue error for order ' + req.params.id + ':', misaErr.message);
        }
      }
      res.json({ order: result });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  router.get('/gaeru_ceo/settings', async (req, res) => {
    res.json({
      ...(await getSettings(pool, ['shipping_note', 'shipping_rates'])),
      paymentMethods: req.paymentChannels?.methods || ['cod', ...(req.vnpayConfig ? ['vnpay'] : [])]
    });
  });

  router.put('/gaeru_ceo/settings', requireCsrf, async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Cài đặt chưa hợp lệ.', details: parsed.error.issues });
    const settings = {
      shipping_note: parsed.data.shippingNote,
      shipping_rates: parsed.data.shippingRates
    };
    await withTransaction(pool, async (client) => {
      for (const [key, value] of Object.entries(settings)) {
        await client.query(
          `INSERT INTO store_settings (setting_key, setting_value, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = now()`,
          [key, JSON.stringify(value)]
        );
      }
      await audit(client, { actor: req.admin, action: 'settings.update', entityType: 'store_settings', after: settings });
    });
    res.json({
      settings: {
        shippingNote: settings.shipping_note,
        shippingRates: settings.shipping_rates
      }
    });
  });
}

module.exports = { attachAdminOrderAndSettingsRoutes };
