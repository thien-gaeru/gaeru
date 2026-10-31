'use strict';

const { z } = require('zod');
const { requireCsrf } = require('../security');
const { AdminAction } = require('../admin-action');
const { withTransaction } = require('../db');
const { CatalogService } = require('../domain/catalog/catalog-service');
const { checkCustomerPhoneStatus, checkCustomerRegEmailStatus } = require('../customer-lifecycle');
const { productSchema, variantSchema, requireUuidParam, createImageUploadParser } = require('./store-schemas');
const { loadProducts, getSettings } = require('./carrier-and-catalog-loader');

function attachAdminCatalogAndCustomerRoutes(router, pool, { inventory, audit }) {
  const parseImageUpload = createImageUploadParser();
  const { getTrafficSummary } = require('../traffic-tracker');

  router.post('/gaeru_ceo/uploads', AdminAction('catalog.write'), parseImageUpload, async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Chọn một tệp ảnh để tải lên.' });
      const signatures = [
        { type: 'image/png', valid: req.file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
        { type: 'image/jpeg', valid: req.file.buffer[0] === 0xff && req.file.buffer[1] === 0xd8 && req.file.buffer[2] === 0xff },
        { type: 'image/webp', valid: req.file.buffer.toString('ascii', 0, 4) === 'RIFF' && req.file.buffer.toString('ascii', 8, 12) === 'WEBP' }
      ];
      const image = signatures.find((entry) => entry.type === req.file.mimetype && entry.valid);
      if (!image) return res.status(400).json({ error: 'Nội dung tệp không khớp định dạng ảnh được phép.' });
      const uploaded = await require('../lib/stored-media').storeUpload('products', req.file.buffer, req.file.mimetype);
      const saved = await withTransaction(pool, async (client) => {
        const row = (await client.query(
          'INSERT INTO catalog_images(content, mime_type) VALUES($1, $2) RETURNING id',
          [uploaded.content, uploaded.mimeType]
        )).rows[0];
        await audit(client, {
          actor: req.admin,
          action: 'catalog.image.upload',
          entityType: 'product_image',
          entityId: row.id,
          metadata: { size: uploaded.byteSize, type: uploaded.mimeType }
        });
        return row;
      });
      res.status(201).json({ imageUrl: '/api/catalog-images/' + saved.id });
    } catch (error) {
      next(error);
    }
  });

  router.get('/gaeru_ceo/customers', async (req, res, next) => {
    try {
      await require('../account-retention').lockExpiredJunkAccounts(pool).catch(() => {});
      const query = String(req.query.q || '').trim().slice(0, 100);
      const requestedPage = Number.parseInt(req.query.page || '1', 10);
      if (!Number.isInteger(requestedPage) || requestedPage < 1) {
        return res.status(400).json({ error: 'Trang khách hàng không hợp lệ.' });
      }
      const verification = String(req.query.verification || 'all');
      if (!['all', 'verified', 'unverified'].includes(verification)) {
        return res.status(400).json({ error: 'Bộ lọc xác minh chưa hợp lệ.' });
      }
      const status = String(req.query.status || 'all').trim().toLowerCase();
      const validStatuses = ['all', 'active', 'warning', 'locked', 'spam', 'trash'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Bộ lọc trạng thái tài khoản chưa hợp lệ.' });
      }
      const pageSize = 25;
      const values = [query];
      const where = `($1::text = '' OR c.full_name ILIKE '%' || $1 || '%' OR c.email ILIKE '%' || $1 || '%' OR c.phone ILIKE '%' || $1 || '%')`;
      const counts = (await pool.query(
        `SELECT COUNT(*) FILTER(WHERE c.email_verified_at IS NOT NULL)::int AS verified,
                COUNT(*) FILTER(WHERE c.email_verified_at IS NULL)::int AS unverified
         FROM customers c WHERE ${where}`,
        values
      )).rows[0] || { verified: 0, unverified: 0 };

      const statusCounts = (await pool.query(
        `SELECT
           COUNT(*)::int AS all,
           COUNT(*) FILTER(WHERE c.active = true AND c.deleted_at IS NULL AND (c.phone_invalid_at IS NULL OR c.phone_invalid_at > now() - interval '12 hours') AND (c.reg_email_failed_at IS NULL OR c.reg_email_failed_at > now() - interval '12 hours'))::int AS active,
           COUNT(*) FILTER(WHERE c.active = true AND c.deleted_at IS NULL AND ((c.phone_invalid_at IS NOT NULL AND c.phone_invalid_at > now() - interval '12 hours') OR (c.reg_email_failed_at IS NOT NULL AND c.reg_email_failed_at > now() - interval '12 hours')))::int AS warning,
           COUNT(*) FILTER(WHERE c.active = false AND c.deleted_at IS NULL)::int AS locked,
           COUNT(*) FILTER(WHERE (c.lock_reason = 'spam_email' OR c.lock_reason = 'invalid_phone_timeout' OR c.lock_reason = 'reg_email_failed_timeout') AND c.deleted_at IS NULL)::int AS spam,
           COUNT(*) FILTER(WHERE c.deleted_at IS NOT NULL)::int AS trash
         FROM customers c WHERE ${where}`,
        values
      )).rows[0] || { all: 0, active: 0, warning: 0, locked: 0, spam: 0, trash: 0 };

      let statusWhere = '';
      if (status === 'trash') statusWhere = ' AND c.deleted_at IS NOT NULL';
      else if (status === 'active') statusWhere = " AND c.active = true AND c.deleted_at IS NULL AND (c.phone_invalid_at IS NULL OR c.phone_invalid_at > now() - interval '12 hours') AND (c.reg_email_failed_at IS NULL OR c.reg_email_failed_at > now() - interval '12 hours')";
      else if (status === 'warning') statusWhere = " AND c.active = true AND c.deleted_at IS NULL AND ((c.phone_invalid_at IS NOT NULL AND c.phone_invalid_at > now() - interval '12 hours') OR (c.reg_email_failed_at IS NOT NULL AND c.reg_email_failed_at > now() - interval '12 hours'))";
      else if (status === 'locked') statusWhere = ' AND c.active = false AND c.deleted_at IS NULL';
      else if (status === 'spam') statusWhere = " AND (c.lock_reason = 'spam_email' OR c.lock_reason = 'invalid_phone_timeout' OR c.lock_reason = 'reg_email_failed_timeout') AND c.deleted_at IS NULL";

      const verifiedWhere = verification === 'verified'
        ? ' AND c.email_verified_at IS NOT NULL'
        : verification === 'unverified'
          ? ' AND c.email_verified_at IS NULL'
          : '';
      const filterTotalRes = await pool.query(`SELECT COUNT(*)::int AS total FROM customers c WHERE ${where}${statusWhere}${verifiedWhere}`, values);
      const total = filterTotalRes.rows[0]?.total || 0;
      const pageCount = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, pageCount);

      const result = await pool.query(
        `SELECT c.id, c.full_name AS "fullName", c.email, c.phone, c.active, c.deleted_at AS "deletedAt",
                c.deletion_recoverable AS "deletionRecoverable", (c.deleted_at > now() - interval '1 year') AS "canRestore",
                c.email_verified_at IS NOT NULL AS "emailVerified", c.created_at AS "createdAt",
                c.phone_invalid_at AS "phoneInvalidAt", c.lock_reason AS "lockReason", c.locked_at AS "lockedAt",
                c.reg_email_failed_at AS "regEmailFailedAt", c.google_id AS "googleId",
                COUNT(o.id)::int AS "orderCount", MAX(o.created_at) AS "lastOrderAt"
         FROM customers c
         LEFT JOIN orders o ON o.customer_id = c.id OR (o.customer_id IS NULL AND lower(o.email) = lower(c.email))
         WHERE ${where}${statusWhere}${verifiedWhere}
         GROUP BY c.id ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
        [query, pageSize, (page - 1) * pageSize]
      );

      const customers = result.rows.map((row) => {
        const phoneCheck = checkCustomerPhoneStatus({ phone: row.phone, phone_invalid_at: row.phoneInvalidAt, created_at: row.createdAt });
        const regEmailCheck = checkCustomerRegEmailStatus({ reg_email_failed_at: row.regEmailFailedAt, google_id: row.googleId, email_verified: row.emailVerified });
        return {
          ...row,
          phoneWarning: phoneCheck.isWarning,
          phoneWarningHours: phoneCheck.remainingHours,
          phoneWarningExpiresAt: phoneCheck.warningExpiresAt,
          regEmailWarning: regEmailCheck.isWarning,
          regEmailWarningHours: regEmailCheck.remainingHours,
          regEmailWarningExpiresAt: regEmailCheck.warningExpiresAt
        };
      });

      res.json({
        customers,
        verification,
        verificationCounts: {
          all: Number(counts.verified) + Number(counts.unverified),
          verified: Number(counts.verified),
          unverified: Number(counts.unverified)
        },
        status,
        statusCounts,
        filterCounts: statusCounts,
        pagination: { page, pageSize, total, pageCount }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/gaeru_ceo/customers/:id', requireUuidParam('id'), async (req, res, next) => {
    try {
      const customerResult = await pool.query(
        `SELECT id, full_name AS "fullName", email, phone, active,
                email_verified_at IS NOT NULL AS "emailVerified", created_at AS "createdAt"
         FROM customers WHERE id = $1`,
        [req.params.id]
      );
      const customer = customerResult.rows[0];
      if (!customer) return res.status(404).json({ error: 'Không tìm thấy khách hàng.' });
      const orders = await pool.query(
        `SELECT id, order_number AS "orderNumber", status, payment_method AS "paymentMethod",
                payment_status AS "paymentStatus", total_vnd AS "totalVnd", created_at AS "createdAt"
         FROM orders
         WHERE customer_id = $2 OR (customer_id IS NULL AND lower(email) = lower($1))
         ORDER BY created_at DESC LIMIT 50`,
        [customer.email, customer.id]
      );
      res.json({ customer, orders: orders.rows });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/gaeru_ceo/customers/:id', requireUuidParam('id'), AdminAction('customers.write'), async (req, res, next) => {
    try {
      const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Trạng thái khách hàng chưa hợp lệ.' });
      const customer = await withTransaction(pool, async (client) => {
        const result = await client.query(
          `UPDATE customers SET active = $2, updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL
           RETURNING id, full_name AS "fullName", email, phone, active, email_verified_at IS NOT NULL AS "emailVerified"`,
          [req.params.id, parsed.data.active]
        );
        if (!result.rowCount) return null;
        await audit(client, {
          actor: req.admin,
          action: 'customer.access.update',
          entityType: 'customer',
          entityId: req.params.id,
          metadata: { active: parsed.data.active }
        });
        return result.rows[0];
      });
      if (!customer) return res.status(404).json({ error: 'Không tìm thấy khách hàng.' });
      res.json({ customer });
    } catch (error) {
      next(error);
    }
  });

  router.get('/gaeru_ceo/summary', async (req, res) => {
    const [products, orders, settings, traffic] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE active)::int AS active,
                (SELECT COUNT(*)::int FROM product_variants v JOIN products p ON p.id = v.product_id
                 WHERE v.active = true AND p.active = true AND v.stock_quantity <= 5) AS "lowStock"
         FROM products WHERE deleted_at IS NULL`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled'))::int AS "needsAction",
                COUNT(*) FILTER (WHERE payment_status = 'pending' AND status <> 'cancelled' AND return_completed_at IS NULL)::int AS "paymentPending"
         FROM orders`
      ),
      getSettings(pool, ['shipping_rates']),
      getTrafficSummary(pool)
    ]);
    const shippingRatesConfigured = Object.keys(settings.shipping_rates || {}).length > 0;
    res.json({
      products: products.rows[0],
      orders: orders.rows[0],
      ordersEnabled: req.ordersEnabled,
      shippingRatesConfigured,
      traffic
    });
  });

  router.get('/gaeru_ceo/traffic-summary', async (_req, res) => {
    res.json(await getTrafficSummary(pool));
  });

  router.get('/gaeru_ceo/products', async (req, res) => {
    res.json({
      products: await loadProducts(pool, {
        includeDrafts: true,
        deleted: req.query.scope === 'trash',
        search: String(req.query.q || '')
      })
    });
  });

  router.post('/gaeru_ceo/products', requireCsrf, async (req, res, next) => {
    try {
      const parsed = productSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Thông tin sản phẩm chưa hợp lệ.', details: parsed.error.issues });
      const product = await withTransaction(pool, async (client) =>
        CatalogService.createProduct(client, { data: parsed.data, actor: req.admin })
      );
      res.status(201).json({ id: product.id });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === '23505') return res.status(409).json({ error: 'Slug sản phẩm đã được sử dụng.' });
      next(error);
    }
  });

  router.delete('/gaeru_ceo/products/:id', requireUuidParam('id'), AdminAction('catalog.write'), async (req, res, next) => {
    const parsed = z.object({ version: z.number().int().positive(), confirmation: z.literal('DELETE_PRODUCT') }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Xác nhận sản phẩm cần xóa và tải lại dữ liệu mới nhất.' });
    try {
      await withTransaction(pool, async (client) => {
        await CatalogService.softDeleteProduct(client, {
          productId: req.params.id,
          expectedVersion: parsed.data.version,
          actor: req.admin
        });
      });
      res.status(204).end();
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });

  require('../product-trash').attachProductTrash(router, pool);

  const handleProductVisibility = async (req, res, next) => {
    try {
      const parsed = z.object({ active: z.boolean().optional(), version: z.number().int().positive().optional() }).strict().safeParse(req.body || {});
      if (!parsed.success) return res.status(400).json({ error: 'Trạng thái hiển thị sản phẩm không hợp lệ.' });
      const product = await withTransaction(pool, async (client) =>
        CatalogService.setProductVisibility(client, {
          productId: req.params.id,
          active: parsed.data.active,
          expectedVersion: parsed.data.version,
          actor: req.admin,
          auditFn: audit
        })
      );
      if (!product) return res.status(404).json({ error: 'Không tìm thấy sản phẩm.' });
      res.json({
        message: product.active ? 'Đã hiển thị sản phẩm trên cửa hàng.' : 'Đã ẩn sản phẩm khỏi cửa hàng.',
        id: product.id,
        active: product.active
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  };

  router.post('/gaeru_ceo/products/:id/visibility', requireUuidParam('id'), AdminAction('catalog.write'), handleProductVisibility);
  router.patch('/gaeru_ceo/products/:id/visibility', requireUuidParam('id'), AdminAction('catalog.write'), handleProductVisibility);

  router.put('/gaeru_ceo/products/:id', requireUuidParam('id'), requireCsrf, async (req, res, next) => {
    try {
      const parsed = productSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Thông tin sản phẩm chưa hợp lệ.', details: parsed.error.issues });
      const expectedVersion = Number.isInteger(req.body?.version) && req.body.version > 0 ? req.body.version : undefined;
      const product = await withTransaction(pool, async (client) =>
        CatalogService.updateProduct(client, {
          productId: req.params.id,
          data: parsed.data,
          expectedVersion,
          actor: req.admin,
          auditFn: audit
        })
      );
      if (!product) return res.status(404).json({ error: 'Không tìm thấy sản phẩm.' });
      res.json({ id: product.id });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === '23505') return res.status(409).json({ error: 'Slug sản phẩm đã được sử dụng.' });
      next(error);
    }
  });

  router.post('/gaeru_ceo/products/:id/variants', requireUuidParam('id'), requireCsrf, async (req, res, next) => {
    try {
      const parsed = variantSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Thông tin phiên bản chưa hợp lệ.', details: parsed.error.issues });
      const v = parsed.data;
      const variant = await withTransaction(pool, async (client) =>
        CatalogService.createVariant(client, {
          productId: req.params.id,
          data: v,
          actor: req.admin,
          inventoryService: inventory,
          allowLegacyMockWithoutInventory: !inventory,
          auditFn: audit
        })
      );
      if (!variant) return res.status(404).json({ error: 'Không tìm thấy sản phẩm.' });
      res.status(201).json({ id: variant.id });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === '23505') return res.status(409).json({ error: 'SKU đã được sử dụng.' });
      next(error);
    }
  });

  router.put('/gaeru_ceo/variants/:id', requireUuidParam('id'), requireCsrf, async (req, res, next) => {
    try {
      const parsed = variantSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Thông tin phiên bản chưa hợp lệ.', details: parsed.error.issues });
      const v = parsed.data;
      const expectedVersion = Number.isInteger(req.body?.version) && req.body.version > 0 ? req.body.version : undefined;
      const variant = await withTransaction(pool, async (client) =>
        CatalogService.updateVariant(client, {
          variantId: req.params.id,
          sku: v.sku,
          name: v.name,
          options: v.options,
          priceVnd: v.priceVnd,
          stockQuantity: v.stockQuantity,
          active: v.active,
          expectedVersion,
          actor: req.admin,
          inventoryService: inventory,
          allowLegacyMockWithoutInventory: !inventory,
          stockReason: 'Điều chỉnh từ trang phiên bản sản phẩm',
          auditFn: audit,
          auditPayload: v
        })
      );
      if (!variant) return res.status(404).json({ error: 'Không tìm thấy phiên bản.' });
      res.json({ id: variant.id });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === '23505') return res.status(409).json({ error: 'SKU đã được sử dụng.' });
      next(error);
    }
  });

  router.delete('/gaeru_ceo/variants/:id', requireUuidParam('id'), requireCsrf, async (req, res, next) => {
    try {
      const result = await withTransaction(pool, async (client) =>
        CatalogService.deleteVariant(client, {
          variantId: req.params.id,
          actor: req.admin,
          inventoryService: inventory,
          allowLegacyMockWithoutInventory: !inventory,
          auditFn: audit
        })
      );
      if (result.missing) return res.status(404).json({ error: 'Không tìm thấy phiên bản.' });
      if (result.inUse) {
        return res.status(409).json({ error: 'Phiên bản đã có trong lịch sử đơn hàng hoặc kho. Hãy sửa và tạm ẩn thay vì xóa.' });
      }
      res.status(204).end();
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      if (error.code === '23503') return res.status(409).json({ error: 'Phiên bản đã có trong chứng từ. Hãy tạm ẩn thay vì xóa.' });
      next(error);
    }
  });
}

module.exports = { attachAdminCatalogAndCustomerRoutes };
