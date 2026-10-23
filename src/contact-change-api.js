const {Router}=require('express');
const {z}=require('zod');
const bcrypt=require('bcryptjs');
const {randomBytes,createHash}=require('node:crypto');
const {rateLimit}=require('express-rate-limit');
const nodemailer=require('nodemailer');
const {requireCsrf}=require('./security');
const {withTransaction}=require('./db');
const {appendAudit}=require('./audit');
const hash=value=>createHash('sha256').update(value).digest('hex');
const schema=z.object({email:z.string().trim().email().max(254).transform(v=>v.toLowerCase()),phone:z.string().trim().regex(/^\+?[0-9().\-\s]{8,25}$/).transform(v=>v.replace(/[().\-\s]/g,'')).refine(v=>/^\+?\d{8,15}$/.test(v)),password:z.string().min(1).max(200)}).strict();
const fail=(status,message)=>Object.assign(Error(message),{status});
function createContactChangeApi(pool,{smtpConfig=null,mailer}={}){
 if(mailer===undefined&&smtpConfig)mailer=nodemailer.createTransport({host:smtpConfig.host,port:smtpConfig.port,secure:smtpConfig.secure,auth:{user:smtpConfig.user,pass:smtpConfig.password},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000});
 const router=Router();
 router.use(async(req,res,next)=>{try{const id=req.session?.customer?.id;if(!id)return res.status(401).json({error:'Đăng nhập tài khoản để xác nhận thay đổi thông tin.'});const found=(await pool.query('SELECT id FROM customers WHERE id=$1 AND active=true',[id])).rows[0];if(!found)return res.status(401).json({error:'Tài khoản không còn hoạt động.'});req.customerId=id;next();}catch(e){next(e);}});
 router.post('/request',requireCsrf,rateLimit({windowMs:60*60*1000,limit:5,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Bạn đã gửi nhiều yêu cầu đổi thông tin. Vui lòng thử lại sau.'}}),async(req,res,next)=>{
  const parsed=schema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Kiểm tra email, số điện thoại và mật khẩu hiện tại.'});
  if(!mailer||!smtpConfig?.publicBaseUrl)return res.status(503).json({error:'Chưa cấu hình dịch vụ email để xác nhận thay đổi.'});
  const a=parsed.data;let requestId;
  try{
   const owner=(await pool.query('SELECT id,email,phone,password_hash FROM customers WHERE id=$1 AND active=true',[req.customerId])).rows[0];
   if(!owner||!await bcrypt.compare(a.password,owner.password_hash))throw fail(403,'Mật khẩu hiện tại không đúng.');
   if(owner.email===a.email&&owner.phone===a.phone)return res.json({unchanged:true,message:'Email và số điện thoại không thay đổi.'});
   const oldToken=randomBytes(32).toString('base64url'),newToken=owner.email===a.email?null:randomBytes(32).toString('base64url');
   requestId=await withTransaction(pool,async client=>{
    const current=(await client.query('SELECT email,phone,password_hash FROM customers WHERE id=$1 AND active=true FOR UPDATE',[req.customerId])).rows[0];
    if(!current||current.email!==owner.email||current.phone!==owner.phone||current.password_hash!==owner.password_hash)throw fail(409,'Thông tin vừa thay đổi. Hãy tải lại trang.');
    if((await client.query('SELECT id FROM customers WHERE email=$1 AND id<>$2',[a.email,req.customerId])).rows.length)throw fail(409,'Email này không thể sử dụng cho tài khoản.');
    await client.query('UPDATE customer_contact_changes SET cancelled_at=now() WHERE customer_id=$1 AND applied_at IS NULL AND cancelled_at IS NULL',[req.customerId]);
    return(await client.query(`INSERT INTO customer_contact_changes(customer_id,old_email,new_email,old_phone,new_phone,credential_fingerprint,old_token_hash,new_token_hash,new_confirmed,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '30 minutes') RETURNING id`,[req.customerId,owner.email,a.email,owner.phone,a.phone,hash(owner.password_hash),hash(oldToken),newToken?hash(newToken):null,!newToken])).rows[0].id;
   });
   const send=async(to,token,step)=>{
    const link=new URL('/account.html',smtpConfig.publicBaseUrl);link.searchParams.set('contactVerify',token);
    await mailer.sendMail({from:`GAERU Support <${smtpConfig.from}>`,to,subject:'Xác nhận thay đổi thông tin tài khoản GAERU',text:`${step}\nYêu cầu đổi thông tin tài khoản GAERU sang email ${a.email}, số điện thoại ${a.phone}. Hãy đăng nhập đúng tài khoản và mở liên kết sau để xác nhận. Liên kết dùng một lần, hiệu lực 30 phút:\n${link}\n\nNếu không phải bạn yêu cầu, không mở liên kết và liên hệ GAERU.`});
   };
   await send(owner.email,oldToken,'Xác nhận từ email hiện tại.');
   if(newToken)await send(a.email,newToken,'Xác minh hộp thư email mới.');
   res.json({pending:true,message:newToken?'Đã gửi liên kết đến email hiện tại và email mới. Xác nhận cả hai trong 30 phút để áp dụng thay đổi.':'Đã gửi liên kết đến email hiện tại. Số điện thoại chỉ được đổi sau khi bạn xác nhận trong 30 phút.'});
  }catch(error){
   if(requestId)await pool.query('UPDATE customer_contact_changes SET cancelled_at=now() WHERE id=$1 AND applied_at IS NULL',[requestId]);
   if(error.status)return res.status(error.status).json({error:error.message});
   if(error.code==='EAUTH'||error.responseCode===535)return res.status(503).json({error:'Dịch vụ email từ chối xác thực. Chưa thay đổi email hoặc số điện thoại.'});
   if(requestId)return res.status(503).json({error:'Chưa gửi đủ email xác nhận. Thông tin cũ được giữ nguyên; vui lòng thử lại sau.'});
   next(error);
  }
 });
 router.post('/complete',requireCsrf,async(req,res,next)=>{
  const parsed=z.object({token:z.string().min(32).max(128)}).strict().safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Liên kết xác nhận không hợp lệ.'});
  try{
   const tokenHash=hash(parsed.data.token);
   const result=await withTransaction(pool,async client=>{
    const current=(await client.query('SELECT id,full_name AS "fullName",email,phone,password_hash,email_verified_at FROM customers WHERE id=$1 AND active=true FOR UPDATE',[req.customerId])).rows[0];
    if(!current)throw fail(401,'Tài khoản không còn hoạt động.');
    const row=(await client.query('SELECT * FROM customer_contact_changes WHERE customer_id=$1 AND (old_token_hash=$2 OR new_token_hash=$2) AND applied_at IS NULL AND cancelled_at IS NULL AND expires_at>now() FOR UPDATE',[req.customerId,tokenHash])).rows[0];
    if(!row||row.old_email!==current.email||row.old_phone!==current.phone||row.credential_fingerprint!==hash(current.password_hash))throw fail(400,'Liên kết đã dùng, hết hạn hoặc không thuộc tài khoản này.');
    const old=tokenHash===row.old_token_hash;
    if(old?row.old_confirmed:row.new_confirmed)throw fail(400,'Liên kết này đã được xác nhận.');
    const oldConfirmed=row.old_confirmed||old,newConfirmed=row.new_confirmed||!old;
    await client.query('UPDATE customer_contact_changes SET old_confirmed=$2,new_confirmed=$3 WHERE id=$1',[row.id,oldConfirmed,newConfirmed]);
    if(!oldConfirmed||!newConfirmed)return {pending:true,message:'Đã ghi nhận xác nhận. Hãy mở liên kết trong hộp thư còn lại để hoàn tất thay đổi.'};
    const customer=(await client.query('UPDATE customers SET email=$2,phone=$3,email_verified_at=now(),updated_at=now() WHERE id=$1 RETURNING id,full_name AS "fullName",email,phone,true AS "emailVerified"',[req.customerId,row.new_email,row.new_phone])).rows[0];
    await client.query('UPDATE customer_contact_changes SET applied_at=now() WHERE id=$1',[row.id]);
    await client.query('DELETE FROM customer_password_reset_tokens WHERE customer_id=$1',[req.customerId]);
    await client.query('DELETE FROM customer_email_verification_tokens WHERE customer_id=$1',[req.customerId]);
    await appendAudit(client,{actor:{username:req.customerId,source:'customer'},action:'customer.contact.confirmed',entityType:'customer',entityId:req.customerId,metadata:{emailChanged:row.old_email!==row.new_email,phoneChanged:row.old_phone!==row.new_phone}});
    return {customer,message:'Đã xác nhận và cập nhật thông tin tài khoản.'};
   });
   if(result.customer)req.session.customer=result.customer;
   res.json(result);
  }catch(error){if(error.status)return res.status(error.status).json({error:error.message});if(error.code==='23505')return res.status(409).json({error:'Email không còn khả dụng. Vui lòng tạo yêu cầu thay đổi mới.'});next(error);}
 });
 return router;
}
module.exports={createContactChangeApi};
