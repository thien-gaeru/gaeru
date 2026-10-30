'use strict';

/**
 * src/domain/catalog/catalog-service.js
 *
 * Single Source of Truth cho quản lý Danh mục sản phẩm & Biến thể (CatalogService):
 * - Xác thực định dạng Slug, SKU và Ràng buộc nghiệp vụ
 * - Quản lý cập nhật, trạng thái xuất bản, thùng rác (soft delete) và khôi phục có kiểm tra edit_version
 * - Xóa vĩnh viễn (purge) có đối soát tồn kho và bảo toàn lịch sử chứng từ
 * - Ghi nhận nhật ký kiểm toán (Audit Trail) cho mọi thao tác danh mục
 */

const { appendAudit } = require('../../audit');

function catalogError(message, status = 409) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sanitizeSlug(raw) {
  return String(raw || '').trim().toLowerCase();
}

function sanitizeSku(raw) {
  return String(raw || '').trim().toUpperCase();
}

async function recordCatalogAudit(client, payload, auditFn = appendAudit) {
  if (typeof auditFn === 'function' && auditFn !== appendAudit) {
    return auditFn(client, payload);
  }
  if (!payload?.actor?.username) return null;
  return appendAudit(client, payload);
}

class CatalogService {
  /**
   * Tạo mới sản phẩm ở trạng thái nháp (active = false)
   */
  static async createProduct(client, { data, actor, auditFn }) {
    const slug = sanitizeSlug(data.slug);
    const result = await client.query(
      `INSERT INTO products (slug, name, category, descriptor, description, image_url, image_alt, active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)
       RETURNING id, slug, name, category, active, sort_order, edit_version AS version`,
      [slug, data.name, data.category, data.descriptor, data.description, data.imageUrl, data.imageAlt, data.sortOrder || 0]
    );
    const created = result.rows[0];
    await recordCatalogAudit(client, {
      actor,
      action: 'catalog.product.create',
      entityType: 'product',
      entityId: created.id,
      after: { ...data, slug, active: false }
    }, auditFn);
    return created;
  }

  /**
   * Cập nhật thông tin sản phẩm có kiểm tra phiên bản (optimistic concurrency) và ràng buộc biến thể
   */
  static async updateProduct(client, { productId, data, expectedVersion, actor, auditFn }) {
    const lockSql = expectedVersion != null
      ? 'SELECT id, slug, name, category, active, edit_version FROM products WHERE id = $1 AND deleted_at IS NULL FOR UPDATE'
      : 'SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL FOR UPDATE';
    const currentRes = await client.query(lockSql, [productId]);
    const current = currentRes.rows[0];
    if (!current) return null;

    if (expectedVersion != null && current.edit_version !== expectedVersion) {
      throw catalogError('Sản phẩm vừa được chỉnh sửa. Tải lại để tránh ghi đè.', 409);
    }

    if (data.active) {
      const variants = await client.query(
        'SELECT COUNT(*)::int AS count FROM product_variants WHERE product_id = $1 AND active = true',
        [productId]
      );
      if (!variants.rows[0]?.count) {
        throw catalogError('Thêm ít nhất một phiên bản đang bán trước khi xuất bản sản phẩm.', 409);
      }
    }

    const slug = data.slug !== undefined ? sanitizeSlug(data.slug) : current.slug;
    const result = await client.query(
      `UPDATE products SET slug = $2, name = $3, category = $4, descriptor = $5, description = $6,
           image_url = $7, image_alt = $8, active = $9, sort_order = $10, updated_at = now()
       WHERE id = $1
       RETURNING id, slug, name, category, active, sort_order, edit_version AS version`,
      [productId, slug, data.name, data.category, data.descriptor, data.description, data.imageUrl, data.imageAlt, data.active, data.sortOrder]
    );

    await recordCatalogAudit(client, {
      actor,
      action: 'catalog.product.update',
      entityType: 'product',
      entityId: productId,
      before: current.slug ? { slug: current.slug, name: current.name, active: current.active, version: current.edit_version } : null,
      after: { ...data, slug }
    }, auditFn);

    return result.rows[0];
  }

  /**
   * Thay đổi trạng thái hiển thị (xuất bản / ẩn) sản phẩm có kiểm tra phiên bản và audit
   */
  static async setProductVisibility(client, { productId, active, expectedVersion, actor, auditFn }) {
    const currentRes = await client.query(
      `SELECT id, name, slug, active, edit_version FROM products WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [productId]
    );
    const current = currentRes.rows[0];
    if (!current) return null;

    if (expectedVersion != null && current.edit_version !== expectedVersion) {
      throw catalogError('Sản phẩm vừa thay đổi. Tải lại trước khi thực hiện.', 409);
    }

    const targetActive = active !== undefined ? active : !current.active;
    if (targetActive) {
      const variants = await client.query(
        `SELECT COUNT(*)::int AS count FROM product_variants WHERE product_id = $1 AND active = true`,
        [productId]
      );
      if (!variants.rows[0]?.count) {
        throw catalogError('Cần ít nhất một phiên bản đang bán trước khi hiển thị sản phẩm trên cửa hàng.', 409);
      }
    }

    const result = await client.query(
      `UPDATE products SET active = $2, updated_at = now() WHERE id = $1 RETURNING id, name, slug, active, edit_version AS version`,
      [productId, targetActive]
    );

    await recordCatalogAudit(client, {
      actor,
      action: targetActive ? 'catalog.product.publish' : 'catalog.product.hide',
      entityType: 'product',
      entityId: productId,
      before: { active: current.active },
      after: { active: targetActive }
    }, auditFn);

    return result.rows[0];
  }

  /**
   * Xóa mềm sản phẩm (chuyển vào thùng rác và lưu lại trạng thái các biến thể)
   */
  static async softDeleteProduct(client, { productId, expectedVersion, actor }) {
    const productRes = await client.query(
      `SELECT id, name, slug, category, active, edit_version FROM products WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [productId]
    );
    const product = productRes.rows[0];
    if (!product) {
      throw catalogError('Không tìm thấy sản phẩm hoặc sản phẩm đã bị xóa.', 404);
    }
    if (expectedVersion != null && product.edit_version !== expectedVersion) {
      throw catalogError('Sản phẩm vừa thay đổi. Tải lại trước khi xóa.', 409);
    }

    await client.query(
      `SELECT id FROM product_variants WHERE product_id = $1 ORDER BY id FOR UPDATE`,
      [productId]
    );

    await client.query(
      `UPDATE products
       SET active = false,
           deleted_at = now(),
           deleted_variant_state = (
             SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'active', active)), '[]'::jsonb)
             FROM product_variants WHERE product_id = $1
           ),
           updated_at = now()
       WHERE id = $1`,
      [productId]
    );

    await client.query(
      `UPDATE product_variants SET active = false, updated_at = now() WHERE product_id = $1`,
      [productId]
    );

    await appendAudit(client, {
      actor,
      action: 'catalog.product.delete',
      entityType: 'product',
      entityId: productId,
      before: product,
      after: { deleted: true },
      metadata: { historyPreserved: true }
    });

    return true;
  }

  /**
   * Khôi phục sản phẩm từ thùng rác (hỗ trợ kiểm tra edit_version và kích hoạt lại)
   */
  static async restoreProduct(client, { productId, expectedVersion, activate = false, actor }) {
    const productRes = await client.query(
      `SELECT id, name, slug, edit_version, deleted_variant_state FROM products WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE`,
      [productId]
    );
    const product = productRes.rows[0];
    if (!product) {
      throw catalogError('Không tìm thấy sản phẩm trong khu vực đã xóa.', 404);
    }
    if (expectedVersion != null && product.edit_version !== expectedVersion) {
      throw catalogError('Sản phẩm vừa thay đổi. Tải lại trước khi thực hiện.', 409);
    }

    const variantsRes = await client.query(
      `SELECT id, sku, active, stock_quantity FROM product_variants WHERE product_id = $1 ORDER BY id FOR UPDATE`,
      [productId]
    );
    const variants = variantsRes.rows;

    const savedState = Array.isArray(product.deleted_variant_state)
      ? product.deleted_variant_state
      : (typeof product.deleted_variant_state === 'string' ? JSON.parse(product.deleted_variant_state || '[]') : []);

    const states = new Map(savedState.map(v => [v.id, v.active === true]));
    const activeVariants = variants.filter(v => states.has(v.id) ? states.get(v.id) : v.active);

    if (activate && !activeVariants.length) {
      throw catalogError('Chỉnh sửa và chọn ít nhất một biến thể đang bán trước khi kích hoạt.', 400);
    }

    for (const v of variants) {
      const restoredActive = states.has(v.id) ? states.get(v.id) : v.active;
      await client.query(
        `UPDATE product_variants SET active = $2, updated_at = now() WHERE id = $1`,
        [v.id, restoredActive]
      );
    }

    await client.query(
      `UPDATE products
       SET deleted_at = NULL, deleted_variant_state = '[]'::jsonb, active = $2, updated_at = now()
       WHERE id = $1`,
      [product.id, activate]
    );

    await appendAudit(client, {
      actor,
      action: activate ? 'catalog.product.reactivate' : 'catalog.product.restore',
      entityType: 'product',
      entityId: product.id,
      before: { deleted: true },
      after: { deleted: false, active: activate }
    });

    return { id: product.id, active: activate, restored: true };
  }

  /**
   * Xóa vĩnh viễn sản phẩm từ thùng rác (chỉ khi tồn kho = 0 và chưa phát sinh chứng từ lịch sử)
   */
  static async purgeProduct(client, { productId, expectedVersion, confirmation, actor }) {
    if (actor && !['owner', 'admin'].includes(actor.role)) {
      throw catalogError('Chỉ chủ doanh nghiệp hoặc quản trị viên được xóa vĩnh viễn.', 403);
    }

    const productRes = await client.query(
      `SELECT id, name, slug, edit_version, deleted_variant_state FROM products WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE`,
      [productId]
    );
    const product = productRes.rows[0];
    if (!product) {
      throw catalogError('Không tìm thấy sản phẩm trong khu vực đã xóa.', 404);
    }
    if (expectedVersion != null && product.edit_version !== expectedVersion) {
      throw catalogError('Sản phẩm vừa thay đổi. Tải lại trước khi thực hiện.', 409);
    }

    const variantsRes = await client.query(
      `SELECT id, sku, active, stock_quantity FROM product_variants WHERE product_id = $1 ORDER BY id FOR UPDATE`,
      [productId]
    );
    const variants = variantsRes.rows;

    if (confirmation !== undefined && confirmation !== product.slug) {
      throw catalogError('Nhập đúng đường dẫn sản phẩm để xác nhận xóa vĩnh viễn.', 400);
    }

    const ids = variants.map(v => v.id);
    if (
      variants.some(v => v.stock_quantity > 0) ||
      (ids.length > 0 && (await client.query('SELECT 1 FROM warehouse_stock WHERE variant_id = ANY($1::uuid[]) AND quantity > 0 LIMIT 1', [ids])).rows.length)
    ) {
      throw catalogError('Sản phẩm còn tồn kho. Kiểm kê và xử lý tồn trước khi xóa vĩnh viễn.', 409);
    }

    if (ids.length > 0) {
      for (const table of ['order_items', 'inventory_movements', 'order_stock_allocations', 'purchase_order_items', 'goods_receipt_items']) {
        if ((await client.query(`SELECT 1 FROM ${table} WHERE variant_id = ANY($1::uuid[]) LIMIT 1`, [ids])).rows.length) {
          throw catalogError('Sản phẩm đã có đơn hàng hoặc chứng từ kho. Giữ trong khu vực đã xóa để bảo toàn lịch sử.', 409);
        }
      }
    }

    await appendAudit(client, {
      actor,
      action: 'catalog.product.purge',
      entityType: 'product',
      entityId: product.id,
      before: { name: product.name, slug: product.slug, variants: variants.map(v => ({ id: v.id, sku: v.sku })) },
      after: { permanentlyDeleted: true }
    });

    await client.query('DELETE FROM products WHERE id = $1', [product.id]);
    return true;
  }

  /**
   * Chỉnh sửa biến thể sản phẩm
   */
  static async updateVariant(client, { variantId, sku, name, options, priceVnd, stockQuantity, active, imageUrl, actor }) {
    const res = await client.query(
      `UPDATE product_variants
       SET sku = COALESCE($2, sku),
           name = COALESCE($3, name),
           options = COALESCE($4, options),
           price_vnd = COALESCE($5, price_vnd),
           stock_quantity = COALESCE($6, stock_quantity),
           active = COALESCE($7, active),
           image_url = COALESCE($8, image_url),
           updated_at = now()
       WHERE id = $1
       RETURNING id, product_id, sku, name, options, price_vnd AS "priceVnd", stock_quantity AS "stockQuantity", active, image_url AS "imageUrl"`,
      [variantId, sku ? sanitizeSku(sku) : null, name, options, priceVnd, stockQuantity, active, imageUrl]
    );

    const variant = res.rows[0];
    if (variant && actor) {
      await appendAudit(client, {
        actor,
        action: 'catalog.variant.update',
        entityType: 'product_variant',
        entityId: variantId,
        metadata: { sku: variant.sku, priceVnd: variant.priceVnd }
      });
    }

    return variant || null;
  }
}

module.exports = {
  CatalogService,
  catalogError,
  sanitizeSlug,
  sanitizeSku
};
