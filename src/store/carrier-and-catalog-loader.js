'use strict';

function allocateOptimalCarrier(city, enabledCarriers = ['ghn', 'ghtk', 'viettel', 'spx', 'jt']) {
  const normCity = String(city || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  const isMajorUrban = /ha noi|ho chi minh|sai gon|da nang/.test(normCity);
  if (isMajorUrban) {
    if (enabledCarriers.includes('spx')) return { id: 'spx', name: 'Shopee Express (SPX)' };
    if (enabledCarriers.includes('ghn')) return { id: 'ghn', name: 'Giao Hàng Nhanh (GHN)' };
  } else {
    if (enabledCarriers.includes('viettel')) return { id: 'viettel', name: 'Viettel Post' };
    if (enabledCarriers.includes('ghtk')) return { id: 'ghtk', name: 'Giao Hàng Tiết Kiệm (GHTK)' };
  }
  const fallback = enabledCarriers.find((c) => ['ghn', 'ghtk', 'viettel', 'spx', 'jt'].includes(c)) || 'ghn';
  const nameMap = {
    ghn: 'Giao Hàng Nhanh (GHN)',
    ghtk: 'Giao Hàng Tiết Kiệm (GHTK)',
    viettel: 'Viettel Post',
    spx: 'Shopee Express (SPX)',
    jt: 'J&T Express'
  };
  return { id: fallback, name: nameMap[fallback] || 'Giao Hàng Nhanh (GHN)' };
}

async function loadProducts(pool, { includeDrafts = false, deleted = false, search = '' } = {}) {
  const visibility = includeDrafts
    ? (deleted ? 'WHERE p.deleted_at IS NOT NULL' : 'WHERE p.deleted_at IS NULL')
    : 'WHERE p.active = true AND p.deleted_at IS NULL';
  const query = `
    SELECT p.id, p.slug, p.name, p.category, p.descriptor, p.description, p.card_title AS "cardTitle", p.card_summary AS "cardSummary",
      p.image_url AS "imageUrl", p.image_alt AS "imageAlt", p.active, p.edit_version AS version, p.deleted_at AS "deletedAt",
      p.sort_order AS "sortOrder",
      COALESCE(m.description_media, '[]'::jsonb) AS "descriptionMedia",
      COALESCE(m.gallery, '[]'::jsonb) AS gallery,
      COALESCE(m.option_groups, '[]'::jsonb) AS "optionGroups",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', v.id, 'sku', v.sku, 'name', v.name, 'options', v.options,
          'priceVnd', v.price_vnd, 'stockQuantity', v.stock_quantity, 'active', v.active, 'imageUrl', v.image_url
        ) ORDER BY v.name)
        FROM product_variants v
        WHERE v.product_id = p.id ${includeDrafts ? '' : 'AND v.active = true'}
      ), '[]'::jsonb) AS variants
    FROM products p
    LEFT JOIN product_presentations m ON m.product_id = p.id
    ${visibility}
    ORDER BY p.sort_order, p.name`;
  const result = await pool.query(query);
  const { normalizeBrandText } = require('../primary-domain');
  for (const p of result.rows) {
    p.name = normalizeBrandText(p.name);
    p.descriptor = normalizeBrandText(p.descriptor);
    p.description = normalizeBrandText(p.description);
    p.cardTitle = normalizeBrandText(p.cardTitle);
    p.cardSummary = normalizeBrandText(p.cardSummary);
    p.imageAlt = normalizeBrandText(p.imageAlt);
  }
  if (!includeDrafts) {
    const priced = await require('../product-promotions').quoteCatalogPrices(pool, result.rows.flatMap((p) => p.variants));
    const byId = new Map(priced.map((v) => [v.id, v]));
    for (const p of result.rows) {
      p.variants = p.variants.map((v) => byId.get(v.id));
    }
  }
  const needle = search.trim().toLocaleLowerCase('vi');
  if (!needle) return result.rows;
  return result.rows.filter((product) =>
    `${product.name} ${product.slug} ${product.description} ${product.category} ${product.descriptor} ${product.variants.map((variant) => `${variant.name} ${variant.sku}`).join(' ')}`
      .toLocaleLowerCase('vi')
      .includes(needle)
  );
}

async function getSettings(pool, keys) {
  const result = await pool.query(
    'SELECT setting_key, setting_value FROM store_settings WHERE setting_key = ANY($1::text[])',
    [keys]
  );
  return Object.fromEntries(result.rows.map((row) => [row.setting_key, row.setting_value]));
}

module.exports = {
  allocateOptimalCarrier,
  loadProducts,
  getSettings
};
