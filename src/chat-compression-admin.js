'use strict';
const {Router}=require('express');
const {z}=require('zod');
const {requirePermission}=require('./staff-access');
const {requireCsrf}=require('./security');
const {withTransaction}=require('./db');
const {appendAudit}=require('./audit');
function createChatCompressionAdmin(pool){
 const router=Router();
 router.get('/shopping-chat/compression-jobs',requirePermission('customers.read'),async(req,res,next)=>{try{
  const state=z.enum(['all','pending','processing','failed','compressed','optimal']).parse(req.query.state||'all');
  const page=z.coerce.number().int().min(1).max(10000).parse(req.query.page||1);
  const jobs=(await pool.query(`SELECT id,name,mime,byte_size AS "size",compression_status AS state,
    compression_attempts AS attempts,compression_lease_until AS "leaseUntil",compression_last_error AS "errorCode",
    compression_next_attempt_at AS "nextAttemptAt",created_at AS "createdAt"
    FROM shopping_chat_files WHERE deleted_at IS NULL AND ($1='all' OR compression_status=$1)
    ORDER BY created_at DESC,id LIMIT 25 OFFSET $2`,[state,(page-1)*25])).rows;
  const counts=(await pool.query(`SELECT compression_status AS state,count(*)::int AS count FROM shopping_chat_files WHERE deleted_at IS NULL GROUP BY compression_status`)).rows;
  res.set('Cache-Control','no-store').json({jobs,counts,page,pageSize:25});
 }catch(e){next(e);}});
 router.post('/shopping-chat/compression-jobs/:id/retry',requirePermission('customers.write'),requireCsrf,async(req,res,next)=>{try{
  const id=z.string().uuid().parse(req.params.id);
  await withTransaction(pool,async c=>{
   const row=(await c.query(`UPDATE shopping_chat_files SET compression_status='pending',compression_attempts=0,
    compression_lease=NULL,compression_lease_until=NULL,compression_last_error=NULL,compression_next_attempt_at=now()
    WHERE id=$1 AND deleted_at IS NULL AND (compression_status='failed' OR
      (compression_status='processing' AND (compression_lease_until IS NULL OR compression_lease_until<now()))) RETURNING id`,[id])).rows[0];
   if(!row)throw Object.assign(Error('Tác vụ còn hoạt động, đã hoàn tất hoặc không tồn tại. Tải lại danh sách.'),{status:409});
   await appendAudit(c,{actor:req.admin,action:'shopping.chat.compression.retry',entityType:'shopping_chat_file',entityId:id,metadata:{}});
  });res.json({message:'Đã đưa tệp trở lại hàng đợi tối ưu.'});
 }catch(e){next(e);}});
 return router;
}
module.exports={createChatCompressionAdmin};
