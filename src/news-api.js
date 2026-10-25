const {storeMedia,readMedia}=require('./lib/stored-media');
const {Router}=require('express');
const multer=require('multer');
const {z}=require('zod');
const {requireCsrf}=require('./security');
const {requirePermission}=require('./staff-access');
const {withTransaction}=require('./db');
const {appendAudit}=require('./audit');
const uuid=z.string().uuid();
const slug=z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(2).max(120);
const postSchema=z.object({slug,title:z.string().trim().min(5).max(180),excerpt:z.string().trim().min(10).max(400),body:z.string().trim().min(30).max(20000),coverId:uuid,imageAlt:z.string().trim().min(3).max(250),status:z.enum(['draft','published']),version:z.number().int().positive().optional()}).strict();
const fields='id,slug,title,excerpt,cover_id AS "coverId",image_alt AS "imageAlt",status,version,published_at AS "publishedAt",updated_at AS "updatedAt"';
const imagePath=id=>'/api/news-images/'+id;
const output=row=>({...row,imageUrl:imagePath(row.coverId)});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:0}}).single('image');
function validImage(file){if(!file)return false;const b=file.buffer;return file.mimetype==='image/png'&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||file.mimetype==='image/jpeg'&&b[0]===255&&b[1]===216&&b[2]===255||file.mimetype==='image/webp'&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';}
function createNewsPublicApi(pool){const router=Router();
 router.get('/news',async(req,res,next)=>{try{const page=Number(req.query.page||1);if(!Number.isInteger(page)||page<1||page>10000)return res.status(400).json({error:'Trang không hợp lệ.'});const posts=(await pool.query(`SELECT ${fields} FROM news_posts WHERE status='published' ORDER BY published_at DESC,id LIMIT 12 OFFSET $1`,[(page-1)*12])).rows;res.set('Cache-Control','no-store').json({posts:posts.map(output),page,hasMore:posts.length===12});}catch(e){next(e);}});
 router.get('/news/:slug',async(req,res,next)=>{if(!slug.safeParse(req.params.slug).success)return res.status(404).json({error:'Không tìm thấy bài viết.'});try{const post=(await pool.query(`SELECT ${fields},body FROM news_posts WHERE slug=$1 AND status='published'`,[req.params.slug])).rows[0];if(!post)return res.status(404).json({error:'Không tìm thấy bài viết.'});res.set('Cache-Control','no-store').json({post:output(post)});}catch(e){next(e);}});
 router.get('/news-images/:id',async(req,res,next)=>{if(!uuid.safeParse(req.params.id).success)return res.sendStatus(404);try{const image=(await pool.query("SELECT content,mime_type FROM news_images WHERE id=$1 AND EXISTS(SELECT 1 FROM news_posts WHERE cover_id=$1 AND status='published')",[req.params.id])).rows[0];if(!image)return res.sendStatus(404);res.type(image.mime_type).set({'Cache-Control':'no-store','X-GAERU-Media-Storage':'2'}).send(await readMedia(image.content));}catch(e){next(e);}});
 return router;
}
function createNewsAdminApi(pool){const router=Router();
 router.get('/news',requirePermission('catalog.read'),async(req,res,next)=>{try{const page=Number(req.query.page||1);if(!Number.isInteger(page)||page<1||page>10000)return res.status(400).json({error:'Trang không hợp lệ.'});res.json({posts:(await pool.query(`SELECT ${fields},body FROM news_posts ORDER BY updated_at DESC,id LIMIT 25 OFFSET $1`,[(page-1)*25])).rows.map(output),page});}catch(e){next(e);}});
 router.get('/news-images/:id',requirePermission('catalog.read'),async(req,res,next)=>{if(!uuid.safeParse(req.params.id).success)return res.sendStatus(404);try{const image=(await pool.query('SELECT content,mime_type FROM news_images WHERE id=$1',[req.params.id])).rows[0];if(!image)return res.sendStatus(404);res.type(image.mime_type).set({'Cache-Control':'no-store','X-GAERU-Media-Storage':'2'}).send(await readMedia(image.content));}catch(e){next(e);}});
 router.post('/news-images',requirePermission('catalog.write'),requireCsrf,(req,res,next)=>upload(req,res,e=>{if(e)return res.status(400).json({error:'Chọn một ảnh PNG, JPG hoặc WebP tối đa 5 MB.'});next();}),async(req,res,next)=>{if(!validImage(req.file))return res.status(400).json({error:'Nội dung tệp không phải ảnh PNG, JPG hoặc WebP hợp lệ.'});try{const image=await withTransaction(pool,async client=>{const row=(await client.query('INSERT INTO news_images(content,mime_type) VALUES($1,$2) RETURNING id',[await storeMedia('news',req.file.buffer,req.file.mimetype),req.file.mimetype])).rows[0];await appendAudit(client,{actor:req.admin,action:'news.image.upload',entityType:'news_image',entityId:row.id,metadata:{size:req.file.size}});return row;});res.status(201).json({id:image.id,imageUrl:imagePath(image.id)});}catch(e){next(e);}});
 const save=async(req,res,next)=>{const parsed=postSchema.safeParse(req.body);if(!parsed.success||req.params.id&&(!uuid.safeParse(req.params.id).success||!parsed.data.version))return res.status(400).json({error:'Kiểm tra tiêu đề, đường dẫn, ảnh, mô tả và nội dung bài viết.'});const a=parsed.data;
 try{const result=await withTransaction(pool,async client=>{
  if(!(await client.query('SELECT id FROM news_images WHERE id=$1',[a.coverId])).rows.length)return {status:400,error:'Ảnh không tồn tại. Hãy tải ảnh lên.'};
  let row;if(req.params.id){row=(await client.query(`UPDATE news_posts SET slug=$2,title=$3,excerpt=$4,body=$5,cover_id=$6,image_alt=$7,status=$8,version=version+1,published_at=CASE WHEN $8='published' THEN COALESCE(published_at,now()) ELSE published_at END,updated_at=now() WHERE id=$1 AND version=$9 RETURNING ${fields},body`,[req.params.id,a.slug,a.title,a.excerpt,a.body,a.coverId,a.imageAlt,a.status,a.version])).rows[0];if(!row)return {status:409,error:'Bài viết đã thay đổi. Tải lại trước khi sửa.'};}
  else row=(await client.query(`INSERT INTO news_posts(slug,title,excerpt,body,cover_id,image_alt,status,published_at) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7='published' THEN now() ELSE NULL END) RETURNING ${fields},body`,[a.slug,a.title,a.excerpt,a.body,a.coverId,a.imageAlt,a.status])).rows[0];
  await appendAudit(client,{actor:req.admin,action:'news.'+(req.params.id?'update':'create'),entityType:'news_post',entityId:row.id,metadata:{status:row.status,version:row.version}});return {status:req.params.id?200:201,post:output(row)};
 });res.status(result.status).json(result.error?{error:result.error}:{post:result.post});}catch(e){if(e.code==='23505')return res.status(409).json({error:'Đường dẫn bài viết đã được sử dụng.'});next(e);}};
 router.post('/news',requirePermission('catalog.write'),requireCsrf,save);router.put('/news/:id',requirePermission('catalog.write'),requireCsrf,save);
 return router;
}
module.exports={createNewsPublicApi,createNewsAdminApi};
