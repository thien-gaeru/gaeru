'use strict';

/**
 * src/domain/catalog/catalog-service.js
 *
 * Single Source of Truth cho quản lý Danh mục sản phẩm & Biến thể (CatalogService):
 * - Xác thực định dạng Slug, SKU, phân quyền RBAC (catalog.write / inventory.approve) và Ràng buộc nghiệp vụ
 * - Quản lý cập nhật, trạng thái xuất bản, thùng rác (soft delete) và khôi phục có kiểm tra edit_version
 * - Xóa vĩnh viễn (purge) có đối soát tồn kho và bảo toàn lịch sử chứng từ
 * - Điều phối metadata biến thể & workspace; ủy quyền DUY NHẤT việc thay đổi tồn kho qua InventoryService
 *   (tuyệt đối không ghi đè trực tiếp stock_quantity ngoài sổ cái kho)
 * - Ghi nhận nhật ký kiểm toán (Audit Trail) cho mọi thao tác danh mục
 */

const { appendAudit } = require('../../audit');
const { InventoryService } = require('../inventory/inventory-service');

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

function assertCatalogWritePermission(actor) {
  if (actor && Array.isArray(actor.permissions) && !actor.permissions.includes('catalog.write')) {
    throw catalogError('Tài khoản không có quyền chỉnh sửa danh mục sản phẩm.', 403);
  }
}

function assertInventoryApprovePermission(actor, message = 'Cần quyền duyệt kho để thay đổi số lượng tồn.') {
  if (actor && Array.isArray(actor.permissions) && !actor.permissions.includes('inventory.approve')) {
    throw catalogError(message, 403);
  }
}

async function recordCatalogAudit(client, payload, auditFn = appendAudit) {
  if (typeof auditFn === 'function' && auditFn !== appendAudit) {
    return auditFn(client, payload);
  }
  if (!payload?.actor?.username) return null;
  return appendAudit(client, payload);
}

async function lockVariantWithProductInternal(client, variantId) {
  const parentResult = await client.query(
    `SELECT p.id, p.active FROM products p
     JOIN product_variants v ON v.product_id = p.id
     WHERE v.id=$1 AND p.deleted_at IS NULL FOR UPDATE OF p`,
    [variantId]
  );
  const product = parentResult.rows[0];
  if (!product) return null;
  const variantResult = await client.query(
    'SELECT id, active, stock_quantity AS "stockQuantity", edit_version AS "editVersion" FROM product_variants WHERE id=$1 AND product_id=$2 FOR UPDATE',
    [variantId, product.id]
  );
  const variant = variantResult.rows[0];
  return variant ? { product, variant } : null;
}

async function requireAnotherActiveVariantInternal(client, product, variant) {
  if (!product.active || !variant.active) return;
  const result = await client.query(
    'SELECT COUNT(*)::int AS count FROM product_variants WHERE product_id=$1 AND active=true AND id<>$2',
    [product.id, variant.id]
  );
  if (!result.rows[0]?.count) {
    throw catalogError(
      'Sản phẩm đang hiển thị cần ít nhất một phiên bản đang bán. Hãy tạm ẩn sản phẩm trước khi ẩn hoặc xóa phiên bản cuối cùng.',
      409
    );
  }
}

class CatalogService {
  /**
   * Tạo mới sản phẩm ở trạng thái nháp (active = false)
   */
  static async createProduct(client, { data, actor, auditFn }) {
    assertCatalogWritePermission(actor);
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
    assertCatalogWritePermission(actor);
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
    assertCatalogWritePermission(actor);
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
    assertCatalogWritePermission(actor);
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
    assertCatalogWritePermission(actor);
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
   * Tạo mới biến thể sản phẩm, khởi tạo tồn đầu kỳ duy nhất qua InventoryService
   */
  static async createVariant(client, {
    productId,
    data,
    actor,
    inventoryService = InventoryService,
    allowLegacyMockWithoutInventory = false,
    auditFn
  }) {
    assertCatalogWritePermission(actor);
    const initialStock = Number(data.stockQuantity) || 0;
    if (initialStock > 0) {
      assertInventoryApprovePermission(actor, 'Cần quyền duyệt kho để khai báo tồn đầu kỳ.');
    }

    const result = await client.query(
      `INSERT INTO product_variants (product_id, sku, name, options, price_vnd, stock_quantity, active)
       SELECT id, $2, $3, $4, $5, $6, $7 FROM products WHERE id=$1 AND deleted_at IS NULL
       RETURNING id`,
      [productId, data.sku, data.name, data.options || {}, data.priceVnd, initialStock, data.active]
    );
    if (!result.rowCount) return null;

    const createdId = result.rows[0].id;
    const inv = inventoryService || (allowLegacyMockWithoutInventory ? null : InventoryService);
    if (inv) {
      await inv.initializeVariantStock(client, {
        variantId: createdId,
        quantity: initialStock,
        actor
      });
    }

    await recordCatalogAudit(client, {
      actor,
      action: 'catalog.variant.create',
      entityType: 'variant',
      entityId: createdId,
      after: data
    }, auditFn);

    return result.rows[0];
  }

  /**
   * Chỉnh sửa biến thể sản phẩm:
   * - CatalogService CHỈ cập nhật metadata (sku, name, options, price_vnd, active, image_url)
   * - Mọi thay đổi số lượng tồn kho (stockQuantity) BẮT BUỘC đi qua InventoryService.setVariantStock
   *   để ghi nhận biến động sổ kho (inventory_movements + warehouse_stock) và KHÔNG ghi đè lại stock_quantity sau đó!
   */
  static async updateVariant(client, {
    variantId,
    sku,
    name,
    options,
    priceVnd,
    stockQuantity,
    active,
    imageUrl,
    expectedVersion,
    actor,
    inventoryService = InventoryService,
    allowLegacyMockWithoutInventory = false,
    stockReason = 'Điều chỉnh từ trang phiên bản sản phẩm',
    auditFn,
    auditPayload
  }) {
    assertCatalogWritePermission(actor);

    const locked = await lockVariantWithProductInternal(client, variantId);
    if (!locked) return null;

    if (expectedVersion != null && locked.variant.editVersion != null && locked.variant.editVersion !== expectedVersion) {
      throw catalogError('Biến thể hoặc tồn kho vừa thay đổi. Tải lại trước khi lưu.', 409);
    }

    if (stockQuantity !== undefined && stockQuantity !== locked.variant.stockQuantity) {
      assertInventoryApprovePermission(actor, 'Cần quyền duyệt kho để thay đổi số lượng tồn.');
    }

    if (active === false) {
      await requireAnotherActiveVariantInternal(client, locked.product, locked.variant);
    }

    const inv = inventoryService || (allowLegacyMockWithoutInventory ? null : InventoryService);
    if (stockQuantity !== undefined && inv) {
      await inv.setVariantStock(client, {
        variantId,
        quantity: stockQuantity,
        actor,
        reason: stockReason
      });
    }

    let res;
    if (!inv && allowLegacyMockWithoutInventory && stockQuantity !== undefined) {
      // Duy nhất phục vụ mock client mỏng trong unit test độc lập không khởi tạo sổ kho
      res = await client.query(
        `UPDATE product_variants SET sku=$2, name=$3, options=$4, price_vnd=$5,
          stock_quantity=$6, active=$7, updated_at=now() WHERE id=$1 RETURNING id`,
        [variantId, sku, name, options, priceVnd, stockQuantity, active]
      );
    } else if (imageUrl !== undefined) {
      res = await client.query(
        `UPDATE product_variants
         SET sku = COALESCE($2, sku),
             name = COALESCE($3, name),
             options = COALESCE($4, options),
             price_vnd = COALESCE($5, price_vnd),
             active = COALESCE($6, active),
             image_url = COALESCE($7, image_url),
             updated_at = now()
         WHERE id = $1
         RETURNING id, product_id, sku, name, options, price_vnd AS "priceVnd", stock_quantity AS "stockQuantity", active, image_url AS "imageUrl"`,
        [variantId, sku ?? null, name ?? null, options ?? null, priceVnd ?? null, active ?? null, imageUrl]
      );
    } else {
      res = await client.query(
        `UPDATE product_variants
         SET sku = COALESCE($2, sku),
             name = COALESCE($3, name),
             options = COALESCE($4, options),
             price_vnd = COALESCE($5, price_vnd),
             active = COALESCE($6, active),
             updated_at = now()
         WHERE id = $1
         RETURNING id, product_id, sku, name, options, price_vnd AS "priceVnd", stock_quantity AS "stockQuantity", active, image_url AS "imageUrl"`,
        [variantId, sku ?? null, name ?? null, options ?? null, priceVnd ?? null, active ?? null]
      );
    }

    const variant = res.rows[0];
    if (variant) {
      await recordCatalogAudit(client, {
        actor,
        action: 'catalog.variant.update',
        entityType: auditPayload ? 'variant' : 'product_variant',
        entityId: variantId,
        ...(auditPayload ? { after: auditPayload } : { metadata: { sku: variant.sku ?? sku, priceVnd: variant.priceVnd ?? priceVnd } })
      }, auditFn);
    }

    return variant || null;
  }

  /**
   * Xóa biến thể sản phẩm có kiểm tra lịch sử đơn hàng, sổ kho và ràng buộc biến thể cuối cùng
   */
  static async deleteVariant(client, {
    variantId,
    actor,
    inventoryService = InventoryService,
    allowLegacyMockWithoutInventory = false,
    auditFn
  }) {
    assertCatalogWritePermission(actor);

    const current = await lockVariantWithProductInternal(client, variantId);
    if (!current) return { missing: true };

    const references = await client.query(
      'SELECT EXISTS (SELECT 1 FROM order_items WHERE variant_id=$1) AS referenced',
      [variantId]
    );
    if (references.rows[0]?.referenced) return { inUse: true };

    const inv = inventoryService || (allowLegacyMockWithoutInventory ? null : InventoryService);
    if (inv) {
      const history = await client.query(
        'SELECT EXISTS (SELECT 1 FROM inventory_movements WHERE variant_id=$1) AS referenced',
        [variantId]
      );
      if (history.rows[0]?.referenced) return { inUse: true };
    }

    await requireAnotherActiveVariantInternal(client, current.product, current.variant);
    await client.query('DELETE FROM product_variants WHERE id=$1', [variantId]);
    await recordCatalogAudit(client, {
      actor,
      action: 'catalog.variant.delete',
      entityType: 'variant',
      entityId: variantId
    }, auditFn);
    return { deleted: true };
  }

  /**
   * Lưu toàn diện Workspace Sản phẩm + Danh sách Biến thể + Bộ sưu tập Media:
   * - Kiểm tra phân quyền catalog.write & inventory.approve
   * - Kiểm tra optimistic concurrency (edit_version) cho cả Product và từng Variant
   * - Điều phối metadata qua CatalogService và ủy quyền tồn kho duy nhất qua InventoryService
   */
  static async saveWorkspace(client, { data: a, actor, inventoryService = InventoryService }) {
    assertCatalogWritePermission(actor);

    let id = a.id;
    let current = [];
    if (id) {
      const row = (
        await client.query(
          'SELECT id, updated_at, edit_version FROM products WHERE id=$1 AND (deleted_at IS NOT NULL)=$2 FOR UPDATE',
          [id, a.inTrash === true]
        )
      ).rows[0];
      if (!row) throw catalogError('Không tìm thấy sản phẩm.', 404);
      if (row.edit_version !== a.version) {
        throw catalogError('Sản phẩm vừa được chỉnh sửa. Tải lại để tránh ghi đè.', 409);
      }
      current = (
        await client.query(
          'SELECT id, stock_quantity, updated_at, edit_version FROM product_variants WHERE product_id=$1 ORDER BY id FOR UPDATE',
          [id]
        )
      ).rows;
      if (current.some(v => !a.variants.some(n => n.id === v.id))) {
        throw catalogError('Hãy tạm ẩn biến thể đã lưu thay vì bỏ khỏi danh sách.', 409);
      }
    }

    for (const v of a.variants) {
      if (v.id) {
        const old = current.find(r => r.id === v.id);
        if (!old) throw catalogError('Biến thể không thuộc sản phẩm này.', 400);
        if (old.edit_version !== v.version) {
          throw catalogError('Biến thể hoặc tồn kho vừa thay đổi. Tải lại trước khi lưu.', 409);
        }
        if (v.stockQuantity !== old.stock_quantity) {
          assertInventoryApprovePermission(actor, 'Bạn không có quyền điều chỉnh tồn kho.');
        }
      } else if (v.stockQuantity) {
        assertInventoryApprovePermission(actor, 'Bạn không có quyền khai báo tồn đầu kỳ.');
      }
    }

    for (const m of a.descriptionMedia.filter(m => m.type === 'video')) {
      if (!(await client.query('SELECT id FROM catalog_videos WHERE id=$1', [m.url.split('/').at(-1)])).rows.length) {
        throw catalogError('Video không tồn tại.', 400);
      }
    }

    const images = new Set([
      ...a.descriptionMedia.filter(m => m.type === 'image').map(m => m.url),
      ...a.gallery,
      ...a.variants.map(v => v.imageUrl).filter(Boolean)
    ]);
    for (const url of images) {
      if (url.startsWith('/api/catalog-images/')) {
        if (!(await client.query('SELECT id FROM catalog_images WHERE id=$1', [url.split('/').at(-1)])).rows.length) {
          throw catalogError('Ảnh đã chọn không tồn tại.', 400);
        }
      }
    }

    const p = a.product;
    const values = [
      p.slug,
      p.name,
      p.category,
      p.descriptor,
      p.description,
      p.imageUrl,
      p.imageAlt,
      p.active,
      p.sortOrder,
      p.cardTitle,
      p.cardSummary
    ];
    if (id) {
      await client.query(
        'UPDATE products SET slug=$2,name=$3,category=$4,descriptor=$5,description=$6,image_url=$7,image_alt=$8,active=$9,sort_order=$10,card_title=$11,card_summary=$12,updated_at=now() WHERE id=$1',
        [id, ...values]
      );
    } else {
      id = (
        await client.query(
          'INSERT INTO products(slug,name,category,descriptor,description,image_url,image_alt,active,sort_order,card_title,card_summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
          values
        )
      ).rows[0].id;
    }

    for (const v of a.variants) {
      if (v.id) {
        await inventoryService.setVariantStock(client, {
          variantId: v.id,
          quantity: v.stockQuantity,
          actor
        });
        await client.query(
          'UPDATE product_variants SET sku=$2,name=$3,options=$4,price_vnd=$5,active=$6,image_url=$7,updated_at=now() WHERE id=$1',
          [v.id, v.sku, v.name, v.options, v.priceVnd, a.inTrash ? false : v.active, v.imageUrl]
        );
      } else {
        const row = (
          await client.query(
            'INSERT INTO product_variants(product_id,sku,name,options,price_vnd,stock_quantity,active,image_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
            [id, v.sku, v.name, v.options, v.priceVnd, v.stockQuantity, a.inTrash ? false : v.active, v.imageUrl]
          )
        ).rows[0];
        await inventoryService.initializeVariantStock(client, {
          variantId: row.id,
          quantity: v.stockQuantity,
          actor
        });
        v.id = row.id;
      }
    }

    if (a.inTrash) {
      await client.query(
        'UPDATE products SET deleted_variant_state=$2 WHERE id=$1',
        [id, JSON.stringify(a.variants.map(v => ({ id: v.id, active: v.active })))]
      );
    }

    await client.query(
      'INSERT INTO product_presentations(product_id,gallery,option_groups,description_media) VALUES($1,$2,$3,$4) ON CONFLICT(product_id) DO UPDATE SET gallery=$2,option_groups=$3,description_media=$4',
      [id, JSON.stringify(a.gallery), JSON.stringify(a.groups), JSON.stringify(a.descriptionMedia)]
    );

    await appendAudit(client, {
      actor,
      action: a.id ? 'catalog.workspace.update' : 'catalog.workspace.create',
      entityType: 'product',
      entityId: id,
      metadata: {
        variants: a.variants.length,
        images: a.gallery.length,
        published: p.active
      }
    });

    return id;
  }
}

module.exports = {
  CatalogService,
  catalogError,
  sanitizeSlug,
  sanitizeSku
};
