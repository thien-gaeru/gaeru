const {z}=require('zod');
const {requirePermission,ROLE_PERMISSIONS}=require('./staff-access');
const {requireCsrf}=require('./security');
const {withTransaction}=require('./db');
async function recipients(pool){
  const owner=(await pool.query("SELECT email FROM account_security WHERE account_key='owner'")).rows[0];
  const rows=(await pool.query("SELECT s.id,s.username,s.full_name,s.role,s.active,a.email FROM staff_accounts s LEFT JOIN account_security a ON a.account_key='staff:'||s.id::text ORDER BY s.full_name,s.id")).rows;
  const prefs=new Map((await pool.query('SELECT account_key,enabled FROM shopping_chat_email_preferences')).rows.map(r=>[r.account_key,r.enabled]));
  return [{key:'owner',name:'Chủ doanh nghiệp',email:owner?.email||'',allowed:true},...rows.map(r=>({key:'staff:'+r.id,name:r.full_name+' · '+r.username,email:r.email||'',allowed:r.active&&Boolean(ROLE_PERMISSIONS[r.role]?.includes('customers.read'))}))].map(r=>({...r,eligible:r.allowed&&z.string().email().safeParse(r.email).success,enabled:!!prefs.get(r.key)}));
}
function mountEmailPreferences(admin,pool,config){
  admin.get('/shopping-chat/email/preferences',requirePermission('staff.write'),async(req,res,next)=>{try{res.set('Cache-Control','no-store').json({recipients:await recipients(pool),smtpConfigured:Boolean(config.smtp),counts:(await pool.query('SELECT status,count(*)::int AS total FROM shopping_chat_email_outbox GROUP BY status')).rows});}catch(e){next(e);}});
  admin.put('/shopping-chat/email/preferences',requirePermission('staff.write'),requireCsrf,async(req,res,next)=>{try{
    const parsed=z.object({accounts:z.array(z.string().regex(/^(owner|staff:[0-9a-f-]{36})$/)).max(200)}).strict().safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:'Danh sách người nhận không hợp lệ.'});
    await withTransaction(pool,async c=>{
      await c.query("SELECT pg_advisory_xact_lock(hashtext('shopping-chat-email-preferences'))");
      const available=await recipients(c),selected=new Set(parsed.data.accounts);
      if([...selected].some(key=>!available.some(r=>r.key===key&&r.eligible)))throw Object.assign(Error('Chỉ chọn tài khoản đang hoạt động, có quyền xem chat và email đã xác thực.'),{status:400});
      await c.query('UPDATE shopping_chat_email_preferences SET enabled=false,updated_at=now()');
      for(const key of selected)await c.query('INSERT INTO shopping_chat_email_preferences(account_key,enabled) VALUES($1,true) ON CONFLICT(account_key) DO UPDATE SET enabled=true,updated_at=now()',[key]);
      await require('./audit').appendAudit(c,{actor:req.admin,action:'shopping.chat.email.preferences',entityType:'shopping_chat',entityId:null,metadata:{recipientCount:selected.size}});
    });res.json({message:'Đã lưu người nhận thông báo email.'});
  }catch(e){if(e.status)return res.status(e.status).json({error:e.message});next(e);}});
}
async function processChatEmail(pool,config,mailer){
  if(!mailer||!config.smtp?.from)return false;
  await pool.query("UPDATE shopping_chat_email_outbox SET status='unknown',finished_at=now(),result='Tiến trình gián đoạn; kiểm tra trước khi gửi lại' WHERE status='sending' AND attempted_at<now()-interval '2 minutes'");
  const job=await withTransaction(pool,async c=>{
    const row=(await c.query("SELECT * FROM shopping_chat_email_outbox WHERE status='pending' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];if(!row)return null;
    const person=(await recipients(c)).find(r=>r.key===row.account_key&&r.enabled&&r.eligible);
    const thread=(await c.query('SELECT product_name,status,awaiting_admin FROM shopping_chat_threads WHERE id=$1',[row.thread_id])).rows[0];
    if(!person||!thread||thread.status==='closed'){await c.query("UPDATE shopping_chat_email_outbox SET status='skipped',finished_at=now(),result='Không còn đủ điều kiện hoặc đã được phản hồi' WHERE id=$1",[row.id]);return null;}
    await c.query("UPDATE shopping_chat_email_outbox SET status='sending',attempted_at=now() WHERE id=$1",[row.id]);return {...row,to:person.email,topic:thread.product_name};
  });if(!job)return false;
  try{
    const link=(config.PUBLIC_BASE_URL||config.smtp.publicBaseUrl||'https://gaeru.org')+'/gaeru_ceo#shopping-chat';
    const result=await mailer.sendMail({from:config.smtp.from,to:job.to,subject:job.kind==='handoff'?'GAERU · Chat cần nhân viên hỗ trợ':'GAERU · Phiên chat mới do AI tiếp nhận',text:(job.kind==='handoff'?'Hội thoại đã chuyển cho nhân viên: ':'Có phiên chat mới. AI tiếp nhận trước; nhân viên chỉ cần xử lý khi được chuyển: ')+job.topic+'\n\nĐăng nhập quản trị để đọc và trả lời: '+link+'\n\nEmail không chứa nội dung tin nhắn hoặc tệp đính kèm. Tối đa một email cho mỗi loại thông báo trong mỗi khung 5 phút. Quản trị có thể đổi người nhận tại Chat trực tuyến → Thông báo qua email.',messageId:'<shopping-chat-'+job.id+'@gaeru.org>'});
    const accepted=result?.accepted?.some(v=>String(v.address||v).toLowerCase()===job.to.toLowerCase());
    await pool.query("UPDATE shopping_chat_email_outbox SET status=$2,finished_at=now(),result=$3 WHERE id=$1 AND status='sending'",[job.id,accepted?'sent':result?.rejected?.length?'failed':'unknown',accepted?'SMTP đã tiếp nhận':'Chưa xác định tiếp nhận hoặc SMTP từ chối']);
  }catch{await pool.query("UPDATE shopping_chat_email_outbox SET status='unknown',finished_at=now(),result='Không xác định kết quả SMTP; không tự gửi trùng' WHERE id=$1 AND status='sending'",[job.id]);}
  return true;
}
function startChatEmailWorker(pool,config){
  const mailer=config.smtp?require('nodemailer').createTransport(require('./smtp-security').smtpOptions(config.smtp)):null;
  let running=false,stopped=false;
  async function run(){if(running||stopped)return;running=true;try{for(let i=0;i<10&&!stopped;i++){if(!await processChatEmail(pool,config,mailer))break;}}catch{console.error('Chat email queue temporarily unavailable');}finally{running=false;}}
  const timer=setInterval(run,15000);timer.unref?.();void run();return()=>{stopped=true;clearInterval(timer);};
}
module.exports={recipients,mountEmailPreferences,processChatEmail,startChatEmailWorker};
