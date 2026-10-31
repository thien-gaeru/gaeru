const {Router}=require('express');
const {z}=require('zod');
const {randomBytes,createHash}=require('node:crypto');
const {withTransaction}=require('./db');
const {requirePermission}=require('./staff-access');
const {requireCsrf}=require('./security');
const {appendAudit}=require('./audit');
const {rateLimit}=require('express-rate-limit');
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const emailSchema=z.string().trim().email().max(254);
const campaignSchema=z.object({title:z.string().trim().min(3).max(160),subject:z.string().trim().min(3).max(160).regex(/^[^\r\n]+$/),body:z.string().trim().min(10).max(12000),sources:z.array(z.enum(['customers','orders','suppliers','rfm_champions','rfm_at_risk','rfm_lost'])).min(1).max(6),scheduledAt:z.string().datetime({offset:true}),ratePerMinute:z.number().int().min(1).max(12)}).strict();
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hash=t=>createHash('sha256').update(t).digest('hex');
function makeMailer(config){if(!config?.smtp)return null;const s=config.smtp;return require('nodemailer').createTransport(require('./smtp-security').smtpOptions(s));}
async function audience(client,sources){const parts=[];if(sources.includes('customers'))parts.push("SELECT email FROM customers WHERE active=true AND deleted_at IS NULL");if(sources.includes('orders'))parts.push("SELECT o.email FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.customer_id IS NULL OR (c.active=true AND c.deleted_at IS NULL)");if(sources.includes('suppliers'))parts.push('SELECT email FROM suppliers WHERE active=true');if(sources.includes('rfm_at_risk'))parts.push("SELECT c.email FROM customers c JOIN orders o ON o.customer_id=c.id WHERE c.active=true AND c.deleted_at IS NULL GROUP BY c.id, c.email HAVING MAX(o.created_at) < now() - interval '90 days' AND count(o.id) >= 1");if(sources.includes('rfm_lost'))parts.push("SELECT c.email FROM customers c JOIN orders o ON o.customer_id=c.id WHERE c.active=true AND c.deleted_at IS NULL GROUP BY c.id, c.email HAVING MAX(o.created_at) < now() - interval '180 days'");if(sources.includes('rfm_champions'))parts.push("SELECT c.email FROM customers c JOIN orders o ON o.customer_id=c.id WHERE c.active=true AND c.deleted_at IS NULL GROUP BY c.id, c.email HAVING count(o.id) >= 3 OR SUM(o.total_vnd) >= 5000000");if(!parts.length)return [];const rows=(await client.query(`SELECT DISTINCT lower(trim(email)) AS email FROM (${parts.join(' UNION ALL ')}) contacts WHERE email<>'' AND NOT EXISTS(SELECT 1 FROM marketing_email_suppressions s WHERE s.email=lower(trim(contacts.email))) AND NOT EXISTS(SELECT 1 FROM customers c WHERE lower(trim(c.email))=lower(trim(contacts.email)) AND (c.active=false OR c.deleted_at IS NOT NULL)) ORDER BY email LIMIT 50001`)).rows;if(rows.length>50000)throw fail('Danh sách vượt 50.000 địa chỉ. Chia theo nguồn email để lên lịch.');return rows.map(r=>r.email).filter(e=>emailSchema.safeParse(e).success);}
const wrap=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){if(e instanceof z.ZodError)return res.status(400).json({error:'Kiểm tra tiêu đề, nội dung, nguồn email và thời gian gửi.'});next(e);}};
async function listing(pool){return (await pool.query(`SELECT c.*,count(r.id)::int AS total,count(r.id) FILTER(WHERE r.status='sent')::int AS sent,count(r.id) FILTER(WHERE r.status='pending')::int AS pending,count(r.id) FILTER(WHERE r.status='failed')::int AS failed,count(r.id) FILTER(WHERE r.status='unknown')::int AS unknown,count(r.id) FILTER(WHERE r.status='skipped')::int AS skipped FROM marketing_email_campaigns c LEFT JOIN marketing_email_recipients r ON r.campaign_id=c.id GROUP BY c.id ORDER BY c.created_at DESC,c.id LIMIT 25`)).rows;}
function createEmailMarketing(pool,config){const admin=Router(),publicApi=Router();admin.use('/marketing/emails',requirePermission('marketing.read'));
 admin.get('/marketing/emails',wrap(async(req,res)=>res.json({campaigns:await listing(pool),configured:Boolean(config.smtp&&(config.PUBLIC_BASE_URL||config.smtp?.publicBaseUrl)),audienceCount:(await audience(pool,['customers','orders','suppliers'])).length})));
 admin.post('/marketing/emails/audience',requirePermission('marketing.write'),requireCsrf,wrap(async(req,res)=>{const sources=campaignSchema.shape.sources.parse(req.body.sources);res.json({count:(await audience(pool,sources)).length});}));
 admin.post('/marketing/emails',requirePermission('marketing.write'),requireCsrf,wrap(async(req,res)=>{const d=campaignSchema.parse(req.body.data);const item=await withTransaction(pool,async c=>{const r=(await c.query('INSERT INTO marketing_email_campaigns(title,subject,body,sources,scheduled_at,rate_per_minute) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[d.title,d.subject,d.body,JSON.stringify(d.sources),d.scheduledAt,d.ratePerMinute])).rows[0];await appendAudit(c,{actor:req.admin,action:'marketing.email.draft',entityType:'marketing',entityId:r.id,metadata:{sources:d.sources}});return r;});res.status(201).json({item});}));
 admin.put('/marketing/emails/:id',requirePermission('marketing.write'),requireCsrf,wrap(async(req,res)=>{const id=z.string().uuid().parse(req.params.id),d=campaignSchema.parse(req.body.data),version=z.number().int().positive().parse(req.body.version);const item=await withTransaction(pool,async c=>{const r=(await c.query("UPDATE marketing_email_campaigns SET title=$3,subject=$4,body=$5,sources=$6,scheduled_at=$7,rate_per_minute=$8,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND status='draft' RETURNING *",[id,version,d.title,d.subject,d.body,JSON.stringify(d.sources),d.scheduledAt,d.ratePerMinute])).rows[0];if(!r)throw fail('Chỉ sửa bản nháp còn đúng phiên bản. Tải lại dữ liệu.',409);await appendAudit(c,{actor:req.admin,action:'marketing.email.edit',entityType:'marketing',entityId:id});return r;});res.json({item});}));
 admin.post('/marketing/emails/:id/schedule',requirePermission('marketing.write'),requireCsrf,wrap(async(req,res)=>{const id=z.string().uuid().parse(req.params.id),version=z.number().int().positive().parse(req.body.version);if(req.body.confirmation!=='SCHEDULE_EMAILS')throw fail('Xác nhận nội dung và danh sách trước khi lên lịch.');if(!config.smtp||!(config.PUBLIC_BASE_URL||config.smtp.publicBaseUrl))throw fail('Chưa cấu hình SMTP và địa chỉ website để gửi thư.',503);const count=await withTransaction(pool,async c=>{const item=(await c.query("SELECT * FROM marketing_email_campaigns WHERE id=$1 AND version=$2 AND status='draft' FOR UPDATE",[id,version])).rows[0];if(!item)throw fail('Chiến dịch đã thay đổi hoặc đã lên lịch.',409);if(new Date(item.scheduled_at).getTime()<Date.now()+30000)throw fail('Chọn thời gian gửi sau hiện tại ít nhất 30 giây.');const emails=await audience(c,item.sources);if(!emails.length)throw fail('Chưa có địa chỉ email đủ điều kiện.');if(req.body.expectedCount!==emails.length)throw fail('Danh sách người nhận đã thay đổi. Tải lại số lượng rồi xác nhận.',409);await c.query('INSERT INTO marketing_email_recipients(campaign_id,email) SELECT $1,unnest($2::text[])',[id,emails]);await c.query("UPDATE marketing_email_campaigns SET status='scheduled',version=version+1,updated_at=now() WHERE id=$1",[id]);await appendAudit(c,{actor:req.admin,action:'marketing.email.schedule',entityType:'marketing',entityId:id,metadata:{count:emails.length,scheduledAt:item.scheduled_at}});return emails.length;});res.json({message:'Đã lên lịch gửi cho '+count+' địa chỉ duy nhất.',count});}));
 admin.post('/marketing/emails/:id/cancel',requirePermission('marketing.write'),requireCsrf,wrap(async(req,res)=>{const id=z.string().uuid().parse(req.params.id),version=z.number().int().positive().parse(req.body.version);await withTransaction(pool,async c=>{const r=await c.query("UPDATE marketing_email_campaigns SET status='cancelled',version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND status IN ('draft','scheduled','sending') RETURNING id",[id,version]);if(!r.rows.length)throw fail('Chiến dịch đã thay đổi hoặc đã kết thúc.',409);await c.query("UPDATE marketing_email_recipients SET status='skipped',result='Chiến dịch đã hủy',finished_at=now() WHERE campaign_id=$1 AND status='pending'",[id]);await appendAudit(c,{actor:req.admin,action:'marketing.email.cancel',entityType:'marketing',entityId:id});});res.json({message:'Đã dừng hàng đợi. Thư đang chuyển giao có thể vẫn được gửi.'});}));
 publicApi.use(rateLimit({windowMs:900000,limit:60,standardHeaders:'draft-8',legacyHeaders:false}));
 publicApi.get('/unsubscribe/:token',wrap(async(req,res)=>{const token=z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.token);if(!(await pool.query('SELECT id FROM marketing_email_recipients WHERE unsubscribe_hash=$1',[hash(token)])).rows.length)return res.status(404).send('Liên kết không hợp lệ.');res.set('Cache-Control','no-store').type('html').send('<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ngừng nhận email GAERU</title><main><h1>Ngừng nhận email khuyến mại</h1><p>Bạn vẫn nhận được thư xác minh và thông tin đơn hàng.</p><form method="post"><button type="submit">Xác nhận ngừng nhận</button></form></main></html>');}));
 publicApi.post('/unsubscribe/:token',wrap(async(req,res)=>{const token=z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.token);const r=await pool.query('INSERT INTO marketing_email_suppressions(email) SELECT email FROM marketing_email_recipients WHERE unsubscribe_hash=$1 ON CONFLICT DO NOTHING RETURNING email',[hash(token)]);const found=r.rows.length||(await pool.query('SELECT id FROM marketing_email_recipients WHERE unsubscribe_hash=$1',[hash(token)])).rows.length;if(!found)return res.status(404).send('Liên kết không hợp lệ.');res.set('Cache-Control','no-store').type('html').send('<!doctype html><html lang="vi"><meta charset="utf-8"><title>GAERU</title><h1>Đã ngừng nhận email khuyến mại</h1><p>Yêu cầu đã áp dụng cho các chiến dịch tiếp theo và thư chưa gửi.</p></html>');}));
 return {admin,publicApi};}

async function processEmailQueue(pool,config,mailer,{structured=false}={}){
  if(!mailer||!config?.smtp||!(config.PUBLIC_BASE_URL||config.smtp?.publicBaseUrl)){
    if(structured){
      const pending=await pool.query("SELECT 1 FROM marketing_email_recipients WHERE status='pending' LIMIT 1").catch(()=>({rows:[]}));
      if(pending?.rows?.length>0)return {status:'unsendable',reason:'smtp_or_base_url_not_configured'};
      return {status:'no_work'};
    }
    return false;
  }
  await pool.query("UPDATE marketing_email_recipients SET status='unknown',result='Tiến trình gián đoạn; không tự gửi lại',finished_at=now() WHERE status='sending' AND attempted_at<now()-interval '2 minutes'");
  const claimed=await withTransaction(pool,async c=>{
    await c.query("UPDATE marketing_email_campaigns c SET status='completed',updated_at=now() WHERE status IN ('scheduled','sending') AND NOT EXISTS(SELECT 1 FROM marketing_email_recipients r WHERE r.campaign_id=c.id AND r.status IN ('pending','sending'))");
    const campaign=(await c.query("SELECT * FROM marketing_email_campaigns WHERE status IN ('scheduled','sending') AND scheduled_at<=now() AND (next_send_at IS NULL OR next_send_at<=now()) ORDER BY scheduled_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
    if(!campaign)return null;
    const row=(await c.query("SELECT * FROM marketing_email_recipients WHERE campaign_id=$1 AND status='pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1",[campaign.id])).rows[0];
    if(!row)return null;
    const suppressed=(await c.query("SELECT 1 FROM marketing_email_suppressions WHERE email=$1 UNION ALL SELECT 1 FROM customers WHERE lower(trim(email))=$1 AND (active=false OR deleted_at IS NOT NULL) LIMIT 1",[row.email])).rows.length;
    if(suppressed){
      await c.query("UPDATE marketing_email_recipients SET status='skipped',result='Không còn nhận marketing',finished_at=now() WHERE id=$1",[row.id]);
      return {skipped:true,id:row.id,reason:'suppressed'};
    }
    const token=randomBytes(32).toString('hex');
    await c.query("UPDATE marketing_email_recipients SET status='sending',attempted_at=now(),unsubscribe_hash=$2 WHERE id=$1",[row.id,hash(token)]);
    await c.query("UPDATE marketing_email_campaigns SET status='sending',next_send_at=now()+($2::text||' seconds')::interval,updated_at=now() WHERE id=$1",[campaign.id,60/campaign.rate_per_minute]);
    return {row,campaign,token};
  });
  if(!claimed)return structured?{status:'no_work'}:false;
  if(claimed.skipped)return structured?{status:'unsendable',recipientId:claimed.id,reason:claimed.reason}:false;
  const {row,campaign,token}=claimed;
  const url=new URL('/api/marketing-email/unsubscribe/'+token,require('./primary-domain').normalizePublicBase(config.PUBLIC_BASE_URL||config.smtp.publicBaseUrl)).toString();
  // The claim commits before SMTP. Unknown delivery outcomes are never retried automatically.
  let outcomeStatus='sent',outcomeError=null;
  try{
    const stillAllowed=(await pool.query("SELECT c.status,EXISTS(SELECT 1 FROM marketing_email_suppressions WHERE email=$2) AS suppressed FROM marketing_email_campaigns c WHERE c.id=$1",[campaign.id,row.email])).rows[0];
    if(!stillAllowed||stillAllowed.status==='cancelled'||stillAllowed.suppressed){
      await pool.query("UPDATE marketing_email_recipients SET status='skipped',finished_at=now(),result='Đã dừng trước khi gửi' WHERE id=$1",[row.id]);
      return structured?{status:'unsendable',recipientId:row.id,reason:'cancelled_or_suppressed'}:false;
    }
    const sent=await mailer.sendMail({
      from:config.smtp.from,
      to:row.email,
      subject:campaign.subject,
      text:campaign.body+'\n\nGAERU · Ngừng nhận email khuyến mại: '+url,
      html:'<!doctype html><html lang="vi"><meta charset="utf-8"><body><main><h1>'+h(campaign.subject)+'</h1><div style="white-space:pre-wrap">'+h(campaign.body)+'</div><hr><p>GAERU · <a href="'+h(url)+'">Ngừng nhận email khuyến mại</a></p></main></body></html>',
      headers:{'List-Unsubscribe':'<'+url+'>'}
    });
    const accepted=sent?.accepted?.some(e=>String(e.address||e).toLowerCase()===row.email);
    const finalStatus=accepted?'sent':sent?.rejected?.length?'failed':'unknown';
    await pool.query("UPDATE marketing_email_recipients SET status=$2,finished_at=now(),result=$3 WHERE id=$1 AND status='sending'",[
      row.id,
      finalStatus,
      accepted?'SMTP đã tiếp nhận, chưa xác nhận vào hộp thư':sent?.rejected?.length?'SMTP từ chối người nhận':'Chưa xác định kết quả SMTP'
    ]);
    outcomeStatus=accepted?'sent':sent?.rejected?.length?'unsendable':'unknown';
  }catch(e){
    const finalStatus=Number(e.responseCode)>=400?'failed':'unknown';
    await pool.query("UPDATE marketing_email_recipients SET status=$2,finished_at=now(),result=$3 WHERE id=$1 AND status='sending'",[
      row.id,
      finalStatus,
      Number(e.responseCode)>=400?'SMTP từ chối thư':'Chưa xác định kết quả; không tự gửi lại'
    ]);
    outcomeStatus=Number(e.responseCode)>=400?'unsendable':'unknown';
    outcomeError=e.message;
  }
  if(structured){
    return {
      status:outcomeStatus,
      recipientId:row.id,
      campaignId:campaign.id,
      error:outcomeError
    };
  }
  return true;
}

function startEmailWorker(pool,config,{mailer=makeMailer(config),intervalMs=5000}={}){
  let running=false,stopped=false;
  async function run(){
    if(running||stopped)return;
    running=true;
    try{
      await processEmailQueue(pool,config,mailer);
    }catch{
      console.error('Marketing email queue temporarily unavailable');
    }finally{
      running=false;
    }
  }
  const timer=setInterval(run,intervalMs);
  timer.unref?.();
  void run();
  return ()=>{
    stopped=true;
    clearInterval(timer);
  };
}

module.exports={
  createEmailMarketing,
  startEmailWorker,
  processEmailQueue,
  processMarketingEmails:(pool,config,mailer,opts={})=>processEmailQueue(pool,config,mailer,{structured:true,...opts}),
  audience,
  campaignSchema
};
