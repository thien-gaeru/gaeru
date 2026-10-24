const {Router}=require('express');
const {z}=require('zod');
const {rateLimit}=require('express-rate-limit');
const {createHash}=require('node:crypto');
const {requireCsrf}=require('./security');
const {withTransaction}=require('./db');
const {appendAudit}=require('./audit');
const contactSchema=z.object({
 fullName:z.string().trim().min(2).max(120),
 phone:z.string().trim().regex(/^\+?[0-9().\-\s]{8,25}$/).refine(value=>/^\+?\d{8,15}$/.test(value.replace(/[().\-\s]/g,''))),
 address:z.string().trim().min(5).max(250),
 city:z.string().trim().min(2).max(120)
}).strict();
const requestSchema=z.object({
 channel:z.enum(['website','shopee','tiktok','lazada']),
 externalOrderNumber:z.string().trim().min(3).max(100),
 productName:z.string().trim().min(2).max(200),
 serial:z.string().trim().max(80).regex(/^[A-Za-z0-9 ._/-]*$/).default(''),
 contact:contactSchema,requestKey:z.string().uuid()
}).strict();
function createWarrantyPublicApi(pool){
 const router=Router();
 router.post('/',requireCsrf,rateLimit({windowMs:15*60*1000,limit:15,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Bạn đã gửi nhiều đăng ký. Vui lòng thử lại sau hoặc liên hệ GAERU.'}}),async(req,res,next)=>{
  const parsed=requestSchema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:'Chọn kênh mua, nhập mã đơn, sản phẩm, họ tên, số điện thoại và địa chỉ hợp lệ.'});
  try{
   const a=parsed.data,customerId=req.session?.customer?.id||null;
   const guestHash=customerId?null:createHash('sha256').update(req.sessionID).digest('hex');
   const hash=createHash('sha256').update(JSON.stringify({...a,requestKey:undefined})).digest('hex');
   const result=await withTransaction(pool,async client=>{
    if(customerId&&!(await client.query('SELECT id FROM customers WHERE id=$1 AND active=true',[customerId])).rows.length)return {status:401,error:'Phiên tài khoản không còn hợp lệ. Hãy đăng nhập lại.'};
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['warranty:'+a.requestKey]);
    const previous=(await client.query('SELECT id,status,request_hash,guest_owner_hash FROM warranty_activations WHERE request_key=$1 AND customer_id IS NOT DISTINCT FROM $2::uuid',[a.requestKey,customerId])).rows[0];
    if(previous){
     if(previous.request_hash!==hash||previous.guest_owner_hash!==guestHash)return {status:409,error:'Mã yêu cầu đã được sử dụng. Vui lòng tải lại biểu mẫu.'};
     return {status:200,activation:{id:previous.id,status:previous.status}};
    }
    const orderKey=a.externalOrderNumber.replace(/\s/g,'').toUpperCase();
    if((await client.query("SELECT id FROM orders WHERE upper(regexp_replace(order_number,'[[:space:]]','','g'))=$1 LIMIT 1",[orderKey])).rows.length)return {status:409,error:'Mã đơn đã có trong hệ thống website. Bảo hành được kích hoạt tự động sau khi hoàn tất và thanh toán; không gửi đăng ký lại.',code:'WARRANTY_AUTOMATIC'};
    const claim=(await client.query('INSERT INTO warranty_order_claims(channel,order_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING order_key',[a.channel,orderKey])).rows[0];
    if(!claim)return {status:409,error:'Mã đơn này đã được gửi đăng ký hoặc đã kích hoạt bảo hành. Không thể gửi lại; vui lòng liên hệ GAERU nếu cần điều chỉnh.'};
    const activation=(await client.query(`INSERT INTO warranty_activations
     (customer_id,channel,external_order_number,external_product_name,serial,request_key,request_hash,guest_owner_hash,contact_name,contact_phone,contact_address,contact_city)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,status`,
     [customerId,a.channel,a.externalOrderNumber,a.productName,a.serial.toUpperCase()||null,a.requestKey,hash,guestHash,a.contact.fullName,a.contact.phone,a.contact.address,a.contact.city])).rows[0];
    await appendAudit(client,{actor:{username:customerId||'guest',source:customerId?'customer':'guest'},action:'warranty.request',entityType:'warranty',entityId:activation.id,metadata:{channel:a.channel}});
    return {status:201,activation};
   });
   res.status(result.status).json(result.error?{error:result.error}:{activation:result.activation});
  }catch(error){if(error.code==='23505')return res.status(409).json({error:'Đăng ký hoặc serial đã tồn tại. Liên hệ GAERU để đối chiếu.'});next(error);}
 });
 return router;
}
module.exports={createWarrantyPublicApi,contactSchema};
