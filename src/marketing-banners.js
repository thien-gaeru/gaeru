const {storeMedia,readMedia}=require('./lib/stored-media');
const multer=require('multer');
const {z}=require('zod');
const {rateLimit}=require('express-rate-limit');
const {requirePermission}=require('./staff-access'),{requireCsrf}=require('./security');
const {withTransaction}=require('./db'),{appendAudit}=require('./audit');
const {readStoredImage}=require('./lib/stored-images');
const uuid=z.string().uuid();
function validBanner(f){const b=f?.buffer;return !!b&&(f.mimetype==='image/png'&&b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||f.mimetype==='image/jpeg'&&b.length>=4&&b[0]===255&&b[1]===216&&b[2]===255||f.mimetype==='image/webp'&&b.length>=20&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP');}
function mountBanners(admin,customer,pool){
 const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:0}}).single('image');
 admin.post('/marketing/banners',requirePermission('marketing.write'),requireCsrf,rateLimit({windowMs:900000,limit:30,standardHeaders:'draft-8',legacyHeaders:false}), (req,res,next)=>upload(req,res,e=>e?res.status(400).json({error:'Chọn ảnh PNG, JPG hoặc WebP tối đa 5 MB.'}):next()),async(req,res,next)=>{if(!validBanner(req.file))return res.status(400).json({error:'Tệp banner không phải ảnh PNG, JPG hoặc WebP hợp lệ.'});try{const row=await withTransaction(pool,async c=>{const image=(await c.query('INSERT INTO marketing_banner_images(content,mime_type) VALUES($1,$2) RETURNING id',[await storeMedia('banners',req.file.buffer,req.file.mimetype),req.file.mimetype])).rows[0];await appendAudit(c,{actor:req.admin,action:'marketing.banner.upload',entityType:'marketing_banner',entityId:image.id,metadata:{size:req.file.size}});return image;});res.status(201).json({id:row.id});}catch(e){next(e);}});
 const send=buyer=>async(req,res,next)=>{if(!uuid.safeParse(req.params.id).success)return res.sendStatus(404);try{if(buyer){const id=req.session?.customer?.id;if(!id||!(await pool.query('SELECT id FROM customers WHERE id=$1 AND active=true',[id])).rows.length)return res.sendStatus(401);}const row=(await pool.query('SELECT content,mime_type FROM marketing_banner_images WHERE id=$1'+(buyer?' AND EXISTS(SELECT 1 FROM marketing_campaigns WHERE banner_id=$1 AND active=true AND now() BETWEEN starts_at AND ends_at)':''),[req.params.id])).rows[0];if(!row)return res.sendStatus(404);res.type(row.mime_type).set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).send(await readStoredImage(row.content));}catch(e){next(e);}};
 admin.get('/marketing/banners/:id',send(false));customer.get('/banners/:id',send(true));
}
module.exports={mountBanners,validBanner};
