'use strict';

const { z } = require('zod');
const { normalizeBrandText } = require('./primary-domain');

const listParams = z.object({
  q: z.string().trim().max(500).default(''),
  id: z.string().uuid().optional(),
  scope: z.enum(['catalog', 'active', 'trash']).default('catalog'),
  category: z.enum(['', 'audio', 'video', 'accessory']).default(''),
  publication: z.enum(['', 'active', 'draft']).default(''),
  stock: z.enum(['', 'low', 'out', 'missing']).default(''),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
});

async function adminProductList(pool, params) {
  const { q, id, scope, category, publication, stock, page, pageSize } = params;
  const values = [];
  const bind = value => { values.push(value); return '$' + values.length; };
  const where = [scope === 'trash' ? 'p.deleted_at IS NOT NULL' : 'p.deleted_at IS NULL'];
  if (id) where.push('p.id=' + bind(id));
  if (category) where.push('p.category=' + bind(category));
  if (publication) where.push('p.active=' + bind(publication === 'active'));
  if (q) {
    const needle = 'lower(' + bind(q) + ')';
    where.push(`(strpos(lower(concat_ws(' ',p.name,p.slug,p.description,p.category,p.descriptor)),${needle})>0
      OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=p.id
        AND strpos(lower(concat_ws(' ',v.name,v.sku)),${needle})>0))`);
  }
  if (stock) {
    const variants = 'SELECT 1 FROM product_variants v WHERE v.product_id=p.id' + (scope === 'trash' ? '' : ' AND v.active');
    if (stock === 'low') where.push('EXISTS (' + variants + ' AND v.stock_quantity<=5)');
    if (stock === 'missing') where.push('NOT EXISTS (' + variants + ')');
    if (stock === 'out') where.push('EXISTS (' + variants + ' GROUP BY v.product_id HAVING sum(v.stock_quantity)=0)');
  }
  const limit = bind(pageSize) + '::int';
  const requested = bind(page) + '::int';
  const { rows } = await pool.query(`
    WITH matched AS MATERIALIZED (
      SELECT p.id,p.sort_order,p.name FROM products p WHERE ${where.join(' AND ')}
    ), counts AS (
      SELECT count(*)::int AS total, greatest(1,ceil(count(*)::numeric/${limit})::int) AS pages FROM matched
    ), bounds AS (
      SELECT total,pages,least(${requested},pages) AS page FROM counts
    ), page_ids AS (
      SELECT id FROM matched ORDER BY sort_order,name,id LIMIT ${limit}
      OFFSET (SELECT (page-1)*${limit} FROM bounds)
    )
    SELECT bounds.*, coalesce((SELECT jsonb_agg(to_jsonb(item) ORDER BY item."sortOrder",item.name,item.id)
      FROM (SELECT p.id,p.slug,p.name,p.category,p.image_url AS "imageUrl",p.active,
        p.deleted_at AS "deletedAt",p.sort_order AS "sortOrder",p.edit_version AS version,
        coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'sku',v.sku,
          'stockQuantity',v.stock_quantity,'priceVnd',v.price_vnd,'active',v.active) ORDER BY v.name,v.id)
          FROM product_variants v WHERE v.product_id=p.id),'[]'::jsonb) AS variants
        FROM page_ids i JOIN products p ON p.id=i.id) item),'[]'::jsonb) AS products
    FROM bounds`, values);
  const result = rows[0];
  for (const item of result.products) item.name = normalizeBrandText(item.name);
  return { ...result, pageSize };
}

module.exports = { adminProductList, listParams };
