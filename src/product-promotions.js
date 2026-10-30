const {z}=require('zod');
const {requirePermission}=require('./staff-access');
const {requireCsrf}=require('./security');
const {withTransaction}=require('./db');
const {appendAudit}=require('./audit');
const schema=z.object({title:z.string().trim().min(3).max(160),type:z.enum(['discount','flash']),kind:z.enum(['fixed','percent']),amount:z.number().int().min(1).max(20000000),startsAt:z.string().datetime({offset:true}),endsAt:z.string().datetime({offset:true}),active:z.boolean(),variantIds:z.array(z.string().uuid()).min(1).max(100)}).strict().refine(d=>new Date(d.endsAt)>new Date(d.startsAt)&&(d.kind!=='percent'||d.amount<=100)&&new Set(d.variantIds).size===d.variantIds.length);
const fail=(message,status=400)=>Object.assign(Error(message),{status});
function reducedPrice(base,p){return Math.max(0,base-(p.kind==='percent'?Math.floor(base*p.amount/100):p.amount));}
async function applyPromotions(client,variants){
  if(!variants.length)return variants;
  const rows=(await client.query(`SELECT p.*,pv.variant_id FROM product_promotions p JOIN product_promotion_variants pv ON pv.promotion_id=p.id WHERE pv.variant_id=ANY($1::uuid[]) AND p.active=true AND p.starts_at<=statement_timestamp() AND p.ends_at>statement_timestamp() ORDER BY p.id`,[variants.map(v=>v.id)])).rows;
  
  // Đồng bộ cơ chế chiến dịch flash_sales vào tính giá biến thể
  let flashRows = [];
  try {
    const fsRes = await client.query(`SELECT id, title, ends_at, discount_percent, product_slugs FROM flash_sales WHERE active=true AND starts_at<=statement_timestamp() AND ends_at>statement_timestamp()`);
    flashRows = fsRes.rows || [];
  } catch {}

  let slugByVariantId = new Map();
  const needSlugs = variants.filter(v => !v.productSlug).map(v => v.id);
  if (needSlugs.length && flashRows.length) {
    try {
      const psRes = await client.query(`SELECT v.id AS variant_id, p.slug FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ANY($1::uuid[])`, [needSlugs]);
      for (const r of psRes.rows) slugByVariantId.set(r.variant_id, r.slug);
    } catch {}
  }

  return variants.map(v=>{
    let best=v.priceVnd,promotion=null;
    for(const p of rows){
      if(p.variant_id!==v.id)continue;
      const price=reducedPrice(v.priceVnd,p);
      if(price<best){best=price;promotion={id:p.id,title:p.title,type:p.type,endsAt:p.ends_at};}
    }
    const vSlug = v.productSlug || slugByVariantId.get(v.id);
    for (const fs of flashRows) {
      const slugs = Array.isArray(fs.product_slugs) ? fs.product_slugs : (typeof fs.product_slugs === 'string' ? JSON.parse(fs.product_slugs || '[]') : []);
      if (!slugs.length || (vSlug && (slugs.includes(vSlug) || slugs.includes(vSlug.replace(/^gaeru-/, '')) || slugs.includes('gaeru-' + vSlug)))) {
        const fsPrice = Math.max(0, Math.floor(v.priceVnd * (100 - fs.discount_percent) / 100));
        if (fsPrice < best) {
          best = fsPrice;
          promotion = { id: fs.id, title: fs.title, type: 'flash', endsAt: fs.ends_at, discountPercent: fs.discount_percent };
        }
      }
    }
    return {...v,priceVnd:best,originalPriceVnd:v.priceVnd,promotion};
  });
}
async function listPromotions(pool,page){return (await pool.query(`SELECT p.*,COALESCE((SELECT jsonb_agg(variant_id ORDER BY variant_id) FROM product_promotion_variants WHERE promotion_id=p.id),'[]'::jsonb) AS variant_ids FROM product_promotions p ORDER BY created_at DESC,id LIMIT 25 OFFSET $1`,[(page-1)*25])).rows;}
function mountPromotions(router,pool){
 for(const method of ['post','put'])router[method]('/marketing/promotions'+(method==='put'?'/:id':''),requirePermission('marketing.write'),requireCsrf,async(req,res,next)=>{try{const d=schema.parse(req.body.data),id=method==='put'?z.string().uuid().parse(req.params.id):null;const item=await withTransaction(pool,async c=>{const found=(await c.query('SELECT id FROM product_variants WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[d.variantIds])).rows;if(found.length!==d.variantIds.length)throw fail('Một phiên bản sản phẩm không còn tồn tại.',409);let r;const values=[d.title,d.type,d.kind,d.amount,d.startsAt,d.endsAt,d.active];if(id){const version=z.number().int().positive().parse(req.body.version);r=await c.query('UPDATE product_promotions SET title=$3,type=$4,kind=$5,amount=$6,starts_at=$7,ends_at=$8,active=$9,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING *',[id,version,...values]);}else r=await c.query('INSERT INTO product_promotions(title,type,kind,amount,starts_at,ends_at,active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',values);if(!r.rows[0])throw fail('Chiến dịch đã thay đổi. Tải lại trước khi lưu.',409);const saved=r.rows[0];await c.query('DELETE FROM product_promotion_variants WHERE promotion_id=$1',[saved.id]);for(const variantId of d.variantIds)await c.query('INSERT INTO product_promotion_variants(promotion_id,variant_id) VALUES($1,$2)',[saved.id,variantId]);await appendAudit(c,{actor:req.admin,action:'marketing.product_promotion.save',entityType:'marketing',entityId:saved.id,after:d,metadata:{version:saved.version}});return saved;});res.status(id?200:201).json({item});}catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:'Kiểm tra tên, thời gian, mức giảm và sản phẩm đã chọn.'});next(e);}});
 router.get('/marketing/promotion-products',async(req,res,next)=>{try{res.json({variants:(await pool.query(`SELECT v.id,v.sku,v.name,v.price_vnd AS "priceVnd",v.active,p.name AS "productName",p.image_url AS "imageUrl" FROM product_variants v JOIN products p ON p.id=v.product_id ORDER BY p.name,v.name,v.id`)).rows});}catch(e){next(e);}});
}
module.exports={applyPromotions,listPromotions,mountPromotions,reducedPrice,schema};
