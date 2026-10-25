const { rateLimit } = require('express-rate-limit');
const { createHash } = require('node:crypto');
const {Router}=require('express'),{z}=require('zod'),multer=require('multer');
const {requireCsrf}=require('./security'),{requirePermission}=require('./staff-access'),{withTransaction}=require('./db'),{appendAudit}=require('./audit');
const inventory=require('./inventory');
const { readStoredImage } = require('./lib/stored-images');
// Only images attached to published products reach this function.
// Storage objects use immutable keys; a format migration changes the pointer and MIME.
async function sendPublicCatalogImage(req, res, row) {
  const version = createHash('sha256').update(row.content).update('\0').update(row.mime_type).digest('hex');
  const etag = '"gaeru-catalog-image-' + req.params.id + '-' + version + '"';
  res.type(row.mime_type);
  res.set('Cache-Control', 'private, max-age=60, must-revalidate');
  res.set('ETag', etag);
  res.set('X-Content-Type-Options', 'nosniff');
  // Check after the database verifies the product is still published.
  // Avoid downloading the object again when the browser already has it.
  if (req.fresh) return res.status(304).end();
  return res.send(await readStoredImage(row.content));
}

const uuid=z.string().uuid(),image=z.string().regex(/^(?:\/assets\/products\/(?:[a-zA-Z0-9._-]+|m3-description\/(?:1|2|3|4|6|7|8|9|10|11|12)\.(?:png|webp))|\/api\/catalog-images\/[0-9a-f-]{36})$/).refine(v=>v.startsWith('/assets/')||uuid.safeParse(v.split('/').at(-1)).success);
const group=z.object({name:z.string().trim().min(1).max(50),values:z.array(z.string().trim().min(1).max(80)).min(1).max(20)}).strict();
const media=z.object({type:z.enum(["image","video"]),url:z.string(),alt:z.string().trim().min(3).max(250),caption:z.string().max(300).default(""),afterParagraph:z.number().int().min(0).max(100).nullable().default(null)}).strict().refine(m=>m.type==="image"?image.safeParse(m.url).success:/^\/api\/catalog-videos\/[0-9a-f-]{36}$/.test(m.url)&&uuid.safeParse(m.url.split("/").at(-1)).success);
const schema=z.object({inTrash:z.literal(true).optional(),descriptionMedia:z.array(media).max(12).default([]),id:uuid.optional(),updatedAt:z.string().optional(),version:z.number().int().positive().optional(),product:z.object({name:z.string().trim().min(2).max(160),slug:z.string().min(2).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),category:z.enum(['audio','video','accessory']),descriptor:z.string().trim().max(160),cardTitle:z.string().trim().max(100).default(''),cardSummary:z.string().trim().max(240).default(''),description:z.string().trim().max(3000),imageUrl:image,imageAlt:z.string().max(250),active:z.boolean(),sortOrder:z.number().int().min(-1000).max(10000)}).strict(),gallery:z.array(image).min(1).max(9),groups:z.array(group).max(3),variants:z.array(z.object({id:uuid.optional(),updatedAt:z.string().optional(),version:z.number().int().positive().optional(),sku:z.string().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),name:z.string().min(1).max(160),options:z.record(z.string().min(1).max(50),z.string().min(1).max(80)),priceVnd:z.number().int().min(0).max(20000000),stockQuantity:z.number().int().min(0).max(1000000),active:z.boolean(),imageUrl:z.union([image,z.literal('')])}).strict()).max(100)}).strict();
const fail=(message,status=409)=>Object.assign(Error(message),{status});
const signature=o=>JSON.stringify(Object.entries(o).sort(([a],[b])=>a.localeCompare(b)));
async function read(client,id,inTrash=false){const product=(await client.query('SELECT deleted_at,deleted_variant_state,id,name,slug,category,descriptor,description,card_title AS "cardTitle",card_summary AS "cardSummary",image_url AS "imageUrl",image_alt AS "imageAlt",active,sort_order AS "sortOrder",updated_at AS "updatedAt",edit_version AS version FROM products WHERE id=$1 AND (deleted_at IS NOT NULL)=$2',[id,inTrash])).rows[0];if(!product)return null;product.updatedAt=new Date(product.updatedAt).toISOString();const variants=(await client.query('SELECT id,sku,name,options,price_vnd AS "priceVnd",stock_quantity AS "stockQuantity",active,image_url AS "imageUrl",updated_at AS "updatedAt",edit_version AS version FROM product_variants WHERE product_id=$1 ORDER BY name,id',[id])).rows.map(v=>({...v,updatedAt:new Date(v.updatedAt).toISOString()}));if(inTrash){const states=new Map(product.deleted_variant_state.map(v=>[v.id,v.active]));for(const v of variants)if(states.has(v.id))v.active=states.get(v.id)===true;}const meta=(await client.query('SELECT gallery,option_groups AS groups,description_media AS "descriptionMedia" FROM product_presentations WHERE product_id=$1',[id])).rows[0];const {deleted_at,deleted_variant_state,id:productId,updatedAt:productDate,version,...fields}=product;return {...(inTrash?{inTrash:true}:{}),id,updatedAt:product.updatedAt,version,product:fields,variants,gallery:meta?.gallery?.length?meta.gallery:[product.imageUrl],groups:meta?.groups||[],descriptionMedia:meta?.descriptionMedia||[]};}
const catalogImagePublicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1800,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const catalogImageAdminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const catalogImageUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

function createProductWorkspace(pool){const admin=Router(),publicApi=Router();
 publicApi.get('/catalog-images/:id',catalogImagePublicLimiter,async(req,res,next)=>{if(!uuid.safeParse(req.params.id).success)return res.sendStatus(404);try{const url='/api/catalog-images/'+req.params.id;const row=(await pool.query(`SELECT content,mime_type FROM catalog_images WHERE id=$1 AND EXISTS(SELECT 1 FROM products p LEFT JOIN product_presentations m ON m.product_id=p.id WHERE p.active=true AND (p.image_url=$2 OR m.gallery @> $3::jsonb OR m.description_media @> $4::jsonb OR EXISTS(SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.active=true AND v.image_url=$2)))`,[req.params.id,url,JSON.stringify([url]),JSON.stringify([{type:"image",url}])])).rows[0];if(!row)return res.sendStatus(404);await sendPublicCatalogImage(req,res,row);}catch(e){next(e);}});
 admin.use('/product-workspace',requirePermission('catalog.read'));
 admin.get('/product-workspace/:id',async(req,res,next)=>{if(!uuid.safeParse(req.params.id).success)return res.sendStatus(404);try{const data=await read(pool,req.params.id,req.query.trash==='1');if(!data)return res.status(404).json({error:'Không tìm thấy sản phẩm.'});res.set('Cache-Control','no-store').json(data);}catch(e){next(e);}});
 admin.get('/catalog-images/:id',catalogImageAdminLimiter,requirePermission('catalog.read'),async(req,res,next)=>{if(!uuid.safeParse(req.params.id).success)return res.sendStatus(404);try{const row=(await pool.query('SELECT content,mime_type FROM catalog_images WHERE id=$1',[req.params.id])).rows[0];if(!row)return res.sendStatus(404);res.type(row.mime_type).set('Cache-Control','no-store').send(await readStoredImage(row.content));}catch(e){next(e);}});
 const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1,fields:0}}).single('image');
admin.post('/catalog-images',
  catalogImageUploadLimiter,
  requirePermission('catalog.write'),
  requireCsrf,
  (req, res, next) => upload(req, res, e => e
    ? res.status(400).json({
        error: 'Chọn ảnh PNG, JPG hoặc WebP tối đa 8 MB.'
      })
    : next()),
  async (req, res, next) => {
    const f = req.file;
    const b = f?.buffer;

    const valid = Boolean(b && (
      (f.mimetype === 'image/png' &&
        b.subarray(0, 8).equals(
          Buffer.from([137,80,78,71,13,10,26,10])
        )) ||
      (f.mimetype === 'image/jpeg' &&
        b[0] === 255 && b[1] === 216 && b[2] === 255) ||
      (f.mimetype === 'image/webp' &&
        b.toString('ascii', 0, 4) === 'RIFF' &&
        b.toString('ascii', 8, 12) === 'WEBP')
    ));

    if (!valid) {
      return res.status(400).json({
        error: 'Tệp ảnh không hợp lệ.'
      });
    }


    try {
      const optimized=await require('./lib/stored-media').storeUpload('products',b,f.mimetype);
      const content=optimized.content;

      const row = (await pool.query(
        'INSERT INTO catalog_images(content,mime_type) VALUES($1,$2) RETURNING id',
        [content, optimized.mimeType]
      )).rows[0];

      return res.status(201).json({
        imageUrl: '/api/catalog-images/' + row.id
      });
    } catch (e) {
      if (e.status === 400) return res.status(400).json({error: e.message});
      return next(e);
    }
  });
 admin.post('/product-workspace',requirePermission('catalog.write'),requireCsrf,async(req,res,next)=>{const parsed=schema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Kiểm tra thông tin, ảnh, SKU, giá và số lượng biến thể.'});const a=parsed.data;if(a.inTrash&&(!a.id||a.product.active))return res.status(400).json({error:'Sản phẩm đã xóa chỉ được lưu trong khu vực đã xóa. Dùng Khôi phục hoặc Kích hoạt lại để đưa ra danh mục.'});
 try{const names=a.groups.map(g=>g.name.toLocaleLowerCase());if(new Set(names).size!==names.length)throw fail('Tên nhóm phân loại không được trùng.',400);for(const g of a.groups)if(new Set(g.values.map(v=>v.toLocaleLowerCase())).size!==g.values.length)throw fail('Lựa chọn trong một nhóm không được trùng.',400);
 const ids=a.variants.filter(v=>v.id).map(v=>v.id);if(new Set(ids).size!==ids.length)throw fail('Mỗi biến thể đã lưu chỉ được xuất hiện một lần.',400);
 if(new Set(a.variants.map(v=>v.sku)).size!==a.variants.length)throw fail('SKU của mỗi biến thể phải khác nhau.',400);
 if(a.groups.length){const seen=new Set();for(const v of a.variants){if(Object.keys(v.options).length!==a.groups.length||a.groups.some(g=>!g.values.includes(v.options[g.name])))throw fail('Mỗi biến thể cần lựa chọn hợp lệ trong từng nhóm.',400);const key=signature(v.options);if(seen.has(key))throw fail('Một tổ hợp lựa chọn chỉ có một biến thể.',400);seen.add(key);}}
 if(a.product.active&&!a.variants.some(v=>v.active))throw fail('Cần ít nhất một biến thể đang bán trước khi xuất bản.',400);
 if(!a.gallery.includes(a.product.imageUrl))throw fail('Ảnh chính cần nằm trong bộ ảnh sản phẩm.',400);
 const id=await withTransaction(pool,async client=>{let id=a.id;let current=[];if(id){const row=(await client.query('SELECT id,updated_at,edit_version FROM products WHERE id=$1 AND (deleted_at IS NOT NULL)=$2 FOR UPDATE',[id,a.inTrash===true])).rows[0];if(!row)throw fail('Không tìm thấy sản phẩm.',404);if(row.edit_version!==a.version)throw fail('Sản phẩm vừa được chỉnh sửa. Tải lại để tránh ghi đè.');current=(await client.query('SELECT id,stock_quantity,updated_at,edit_version FROM product_variants WHERE product_id=$1 ORDER BY id FOR UPDATE',[id])).rows;if(current.some(v=>!a.variants.some(n=>n.id===v.id)))throw fail('Hãy tạm ẩn biến thể đã lưu thay vì bỏ khỏi danh sách.');}
 for(const v of a.variants){if(v.id){const old=current.find(r=>r.id===v.id);if(!old)throw fail('Biến thể không thuộc sản phẩm này.',400);if(old.edit_version!==v.version)throw fail('Biến thể hoặc tồn kho vừa thay đổi. Tải lại trước khi lưu.');if(v.stockQuantity!==old.stock_quantity&&!req.admin.permissions.includes('inventory.approve'))throw fail('Bạn không có quyền điều chỉnh tồn kho.',403);}else if(v.stockQuantity&&!req.admin.permissions.includes('inventory.approve'))throw fail('Bạn không có quyền khai báo tồn đầu kỳ.',403);}
 for(const m of a.descriptionMedia.filter(m=>m.type==="video"))if(!(await client.query("SELECT id FROM catalog_videos WHERE id=$1",[m.url.split("/").at(-1)])).rows.length)throw fail("Video không tồn tại.",400);
 const images=new Set([...a.descriptionMedia.filter(m=>m.type==="image").map(m=>m.url),...a.gallery,...a.variants.map(v=>v.imageUrl).filter(Boolean)]);for(const url of images)if(url.startsWith('/api/catalog-images/')){if(!(await client.query('SELECT id FROM catalog_images WHERE id=$1',[url.split('/').at(-1)])).rows.length)throw fail('Ảnh đã chọn không tồn tại.',400);}
 const p=a.product,values=[p.slug,p.name,p.category,p.descriptor,p.description,p.imageUrl,p.imageAlt,p.active,p.sortOrder,p.cardTitle,p.cardSummary];if(id)await client.query('UPDATE products SET slug=$2,name=$3,category=$4,descriptor=$5,description=$6,image_url=$7,image_alt=$8,active=$9,sort_order=$10,card_title=$11,card_summary=$12,updated_at=now() WHERE id=$1',[id,...values]);else id=(await client.query('INSERT INTO products(slug,name,category,descriptor,description,image_url,image_alt,active,sort_order,card_title,card_summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',values)).rows[0].id;
 for(const v of a.variants){if(v.id){await inventory.setVariantStock(client,{variantId:v.id,quantity:v.stockQuantity,actor:req.admin});await client.query('UPDATE product_variants SET sku=$2,name=$3,options=$4,price_vnd=$5,active=$6,image_url=$7,updated_at=now() WHERE id=$1',[v.id,v.sku,v.name,v.options,v.priceVnd,a.inTrash?false:v.active,v.imageUrl]);}else{const row=(await client.query('INSERT INTO product_variants(product_id,sku,name,options,price_vnd,stock_quantity,active,image_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[id,v.sku,v.name,v.options,v.priceVnd,v.stockQuantity,a.inTrash?false:v.active,v.imageUrl])).rows[0];await inventory.initializeVariantStock(client,{variantId:row.id,quantity:v.stockQuantity,actor:req.admin});v.id=row.id;}}
 if(a.inTrash)await client.query('UPDATE products SET deleted_variant_state=$2 WHERE id=$1',[id,JSON.stringify(a.variants.map(v=>({id:v.id,active:v.active})))]);await client.query('INSERT INTO product_presentations(product_id,gallery,option_groups,description_media) VALUES($1,$2,$3,$4) ON CONFLICT(product_id) DO UPDATE SET gallery=$2,option_groups=$3,description_media=$4',[id,JSON.stringify(a.gallery),JSON.stringify(a.groups),JSON.stringify(a.descriptionMedia)]);await appendAudit(client,{actor:req.admin,action:a.id?'catalog.workspace.update':'catalog.workspace.create',entityType:'product',entityId:id,metadata:{variants:a.variants.length,images:a.gallery.length,published:p.active}});return id;});res.status(a.id?200:201).json(await read(pool,id,a.inTrash===true));
 }catch(e){if(e.status)return res.status(e.status).json({error:e.message});if(e.code==='23505')return res.status(409).json({error:'SKU hoặc đường dẫn sản phẩm đã tồn tại. Kiểm tra lại trước khi lưu.'});next(e);}});
 return {admin,publicApi};
}
module.exports={createProductWorkspace,schema};
