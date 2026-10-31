const { rateLimit } = require('express-rate-limit');
const { createHash } = require('node:crypto');
const {Router}=require('express'),{z}=require('zod'),multer=require('multer');
const {requireCsrf}=require('./security'),{requirePermission}=require('./staff-access'),{withTransaction}=require('./db');
const {CatalogService}=require('./domain/catalog/catalog-service');
const {InventoryService}=require('./domain/inventory/inventory-service');
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

function createProductWorkspace(pool){const admin=Router(),publicApi=Router(),publicMedia=Router();
 // Explicitly approved homepage artwork; other unreferenced catalog objects stay private.
 publicApi.get('/site-media/g1-home',(_req,res)=>res.redirect(301,'/assets/products/g1-ultra-874bf1d3db77.webp'));

async function serveCatalogImage(req,res,next){if(!uuid.safeParse(req.params.id).success)return res.sendStatus(404);try{const url='/api/catalog-images/'+req.params.id;const row=(await pool.query(`SELECT content,mime_type FROM catalog_images WHERE id=$1 AND EXISTS(SELECT 1 FROM products p LEFT JOIN product_presentations m ON m.product_id=p.id WHERE p.active=true AND (p.image_url=$2 OR m.gallery @> $3::jsonb OR m.description_media @> $4::jsonb OR EXISTS(SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.active=true AND v.image_url=$2)))`,[req.params.id,url,JSON.stringify([url]),JSON.stringify([{type:"image",url}])])).rows[0];if(!row)return res.sendStatus(404);await sendPublicCatalogImage(req,res,row);}catch(e){next(e);}}
 publicApi.get('/catalog-images/:id',catalogImagePublicLimiter,serveCatalogImage);
 publicMedia.get('/products/:filename',catalogImagePublicLimiter,async(req,res,next)=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:webp|png|jpg)$/.test(req.params.filename))return res.sendStatus(404);try{const key='products/'+req.params.filename;const row=(await pool.query("SELECT id FROM catalog_images WHERE CASE WHEN substring(content from 1 for 12)=convert_to('GAERU_FS_V1:','UTF8') THEN convert_from(substring(content from 13),'UTF8')::jsonb->>'key' ELSE NULL END=$1 LIMIT 1",[key])).rows[0];if(!row)return res.sendStatus(404);req.params.id=row.id;return serveCatalogImage(req,res,next);}catch(e){next(e);}});
 admin.use('/product-workspace',requirePermission('catalog.read'));
 admin.get('/product-workspace/:id',async(req,res,next)=>{if(!uuid.safeParse(req.params.id).success)return res.sendStatus(404);try{const data=await read(pool,req.params.id,req.query.trash==='1');if(!data)return res.status(404).json({error:'Không tìm thấy sản phẩm.'});res.set('Cache-Control','no-store').json(data);}catch(e){next(e);}});
 admin.get('/catalog-images/:id',catalogImageAdminLimiter,requirePermission('catalog.read'),async(req,res,next)=>{if(!uuid.safeParse(req.params.id).success)return res.sendStatus(404);try{const row=(await pool.query('SELECT content,mime_type FROM catalog_images WHERE id=$1',[req.params.id])).rows[0];if(!row)return res.sendStatus(404);res.type(row.mime_type).set('Cache-Control','no-store').send(await readStoredImage(row.content));}catch(e){next(e);}});
 const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1,fields:0}}).single('image');
admin.post(['/catalog-images','/uploads/image'],
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
 admin.post('/product-workspace',requirePermission('catalog.write'),requireCsrf,async(req,res,next)=>{const parsed=schema.safeParse(req.body);if(!parsed.success){const issues=parsed.error.issues||[];const first=issues[0];let msg='Kiểm tra thông tin, ảnh, SKU, giá và số lượng biến thể.';if(first){const p=first.path.join('.');if(p==='product.name')msg='Tên sản phẩm cần từ 2 đến 160 ký tự.';else if(p==='product.slug')msg='Đường dẫn sản phẩm chỉ được dùng chữ thường không dấu, số và dấu gạch nối (ví dụ: gaeru-k9).';else if(p==='gallery'||p.startsWith('gallery'))msg='Vui lòng thêm ít nhất một ảnh sản phẩm (tối đa 9 ảnh).';else if(p.includes('sku'))msg='Mã SKU không được để trống và chỉ gồm chữ, số, dấu gạch nối (ví dụ: K9-01).';else if(p.includes('priceVnd'))msg='Giá bán biến thể phải là số nguyên từ 0₫ đến 20.000.000₫.';else if(p.includes('stockQuantity'))msg='Số lượng tồn kho phải là số nguyên từ 0 đến 1.000.000.';else if(p==='product.description')msg='Mô tả chi tiết sản phẩm không quá 3000 ký tự.';else if(p==='product.cardTitle')msg='Tiêu đề thẻ sản phẩm tối đa 100 ký tự.';else if(p==='product.cardSummary')msg='Thông điệp giới thiệu tối đa 240 ký tự.';else if(first.message&&!first.message.startsWith('Required')&&!first.message.startsWith('Expected')&&!first.message.startsWith('Invalid'))msg=first.message;}return res.status(400).json({error:msg,issues});}const a=parsed.data;if(a.inTrash&&(!a.id||a.product.active))return res.status(400).json({error:'Sản phẩm đã xóa chỉ được lưu trong khu vực đã xóa. Dùng Khôi phục hoặc Kích hoạt lại để đưa ra danh mục.'});
 try{const names=a.groups.map(g=>g.name.toLocaleLowerCase());if(new Set(names).size!==names.length)throw fail('Tên nhóm phân loại không được trùng.',400);for(const g of a.groups)if(new Set(g.values.map(v=>v.toLocaleLowerCase())).size!==g.values.length)throw fail('Lựa chọn trong một nhóm không được trùng.',400);
 const ids=a.variants.filter(v=>v.id).map(v=>v.id);if(new Set(ids).size!==ids.length)throw fail('Mỗi biến thể đã lưu chỉ được xuất hiện một lần.',400);
 if(new Set(a.variants.map(v=>v.sku)).size!==a.variants.length)throw fail('SKU của mỗi biến thể phải khác nhau.',400);
 if(a.groups.length){const seen=new Set();for(const v of a.variants){if(Object.keys(v.options).length!==a.groups.length||a.groups.some(g=>!g.values.includes(v.options[g.name])))throw fail('Mỗi biến thể cần lựa chọn hợp lệ trong từng nhóm.',400);const key=signature(v.options);if(seen.has(key))throw fail('Một tổ hợp lựa chọn chỉ có một biến thể.',400);seen.add(key);}}
 if(a.product.active&&!a.variants.some(v=>v.active))throw fail('Cần ít nhất một biến thể đang bán trước khi xuất bản.',400);
 if(!a.gallery.includes(a.product.imageUrl))throw fail('Ảnh chính cần nằm trong bộ ảnh sản phẩm.',400);
 const id=await withTransaction(pool,async client=>CatalogService.saveWorkspace(client,{data:a,actor:req.admin,inventoryService:InventoryService}));
 res.status(a.id?200:201).json(await read(pool,id,a.inTrash===true));
 }catch(e){if(e.status)return res.status(e.status).json({error:e.message});if(e.code==='23505'){const isSlug=String(e.constraint||'').includes('slug')||String(e.detail||'').includes('slug');const isSku=String(e.constraint||'').includes('sku')||String(e.detail||'').includes('sku');if(isSlug)return res.status(409).json({error:'Đường dẫn sản phẩm (slug) đã tồn tại. Vui lòng đổi đường dẫn khác.',field:'product.slug'});if(isSku)return res.status(409).json({error:'Mã SKU đã tồn tại trên hệ thống. Vui lòng đổi mã SKU.',field:'sku'});return res.status(409).json({error:'SKU hoặc đường dẫn sản phẩm đã tồn tại. Kiểm tra lại trước khi lưu.'});}next(e);}});
 return {admin,publicApi,publicMedia};
}
module.exports={createProductWorkspace,schema};
