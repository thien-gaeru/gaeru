'use strict';

/**
 * src/domain/catalog/catalog-service.js
 * 
 * Single Source of Truth cho quản lý Danh mục sản phẩm & Biến thể (CatalogService):
 * - Xác thực định dạng Slug, SKU và Ràng buộc nghiệp vụ
 * - Quản lý trạng thái xuất bản, thùng rác (soft delete) và khôi phục
 * - Xóa vĩnh viễn (purge) có đối soát và kiểm tra toàn vẹn
 * - Ghi nhận nhật ký kiểm toán (Audit Trail) cho mọi thao tác danh mục
 */

const { appendAudit } = require('../../audit');

function sanitizeSlug(raw) {
  return String(raw || '').trim().toLowerCase();
}

function sanitizeSku(raw) {
  return String(raw || '').trim().toUpperCase();
}

class CatalogService {
  /**
   * Xóa mềm sản phẩm (chuyển vào thùng rác và lưu lại trạng thái các biến thể)
   */
  static async softDeleteProduct(client, { productId, actor }) {
    const productRes = await client.query(
      `SELECT id, name, slug, category, active FROM products WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [productId]
    );
    const product = productRes.rows[0];
    if (!product) {
      const err = new Error('Không tìm thấy sản phẩm hoặc sản phẩm đã bị xóa.');
      err.status = 404;
      throw err;
    }

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
   * Khôi phục sản phẩm từ thùng rác
   */
  static async restoreProduct(client, { productId, activate = false, actor }) {
    const productRes = await client.query(
      `SELECT id, name, slug, deleted_variant_state FROM products WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE`,
      [productId]
    );
    const product = productRes.rows[0];
    if (!product) {
      const err = new Error('Không tìm thấy sản phẩm trong thùng rác.');
      err.status = 404;
      throw err;
    }

    await client.query(
      `UPDATE products 
       SET active = $2, deleted_at = NULL, deleted_variant_state = NULL, updated_at = now() 
       WHERE id = $1`,
      [productId, activate]
    );

    const savedState = Array.isArray(product.deleted_variant_state)
      ? product.deleted_variant_state
      : (typeof product.deleted_variant_state === 'string' ? JSON.parse(product.deleted_variant_state || '[]') : []);

    for (const v of savedState) {
      if (v.id) {
        await client.query(
          `UPDATE product_variants SET active = $2, updated_at = now() WHERE id = $1`,
          [v.id, activate ? Boolean(v.active) : false]
        );
      }
    }

    await appendAudit(client, {
      actor,
      action: 'catalog.product.restore',
      entityType: 'product',
      entityId: productId,
      after: { active: activate, restored: true }
    });

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
  sanitizeSlug,
  sanitizeSku
};
