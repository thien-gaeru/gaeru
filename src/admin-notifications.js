const {Router}=require('express');
const {z}=require('zod');
const {requirePermission}=require('./staff-access');const {requireCsrf}=require('./security');
const {sendWebPushNotification}=require('./web-push');
const {assertSafePushEndpoint}=require('./audit-fixes/push-url-guard');
const accountKey=a=>a.source==='bootstrap'?'owner':'staff:'+a.id;

const pushSubscribeSchema=z.object({
  endpoint:z.string().url().max(2048),
  keys:z.object({
    p256dh:z.string().trim().min(20).max(256),
    auth:z.string().trim().min(16).max(128)
  })
}).strict();

async function notices(pool,admin,config){
  const list=[],can=p=>admin.permissions.includes(p);
  const add=(kind,r,title,detail,target,level='info')=>list.push({key:kind+':'+r.id,version:String(r.version??r.updated_at??r.created_at??1),title,detail,target,level,createdAt:r.created_at||null});
  if(can('dashboard.read')&&(admin?.role==='owner'||admin?.source==='bootstrap'||admin?.isOwner||can('settings.read'))){
    try{
      const mails=(await pool.query("SELECT id,mail_uid,recipient,sender,subject,received_at AS created_at,received_at AS version FROM inbound_mail_notifications ORDER BY received_at DESC LIMIT 20")).rows;
      for(const m of mails){
        const fromText=m.sender?m.sender+' · ':'';
        add('mail',m,'✉️ Thư mới ('+m.recipient+')',fromText+(m.subject||'(Không tiêu đề)'),'webmail','info');
      }
    }catch(_){}
  }
  if(can('orders.read')||can('invoice.approve')){try{const failedInvoices=(await pool.query("SELECT q.id,o.order_number,q.last_error,q.attempts,q.updated_at FROM misa_einvoice_retry_queue q JOIN orders o ON o.id=q.order_id WHERE q.status='failed' ORDER BY q.updated_at DESC LIMIT 25")).rows;for(const r of failedInvoices)add('misa-invoice-failed',r,'Lỗi phát hành hóa đơn MISA','Đơn '+r.order_number+' thất bại sau '+r.attempts+' lần thử ('+(r.last_error||'Lỗi kết nối MISA')+').','business','error');}catch(_){}}
  if(can('orders.read')){for(const r of (await pool.query("SELECT id,order_number,created_at FROM orders WHERE status='pending' ORDER BY created_at DESC LIMIT 25")).rows)add('order',r,'Đơn hàng chờ xác nhận',r.order_number,'orders');for(const r of (await pool.query("SELECT id,subject,version,created_at FROM care_requests c WHERE status='submitted' OR (status='reviewing' AND (SELECT sender FROM care_messages WHERE care_id=c.id ORDER BY id DESC LIMIT 1)='customer') ORDER BY updated_at DESC LIMIT 25")).rows)add('care',r,'Hỗ trợ cần phản hồi',r.subject,'care','warning');for(const r of (await pool.query("SELECT id,version,created_at FROM warranty_activations WHERE status='pending' AND automatic=false AND withdrawn_at IS NULL ORDER BY created_at DESC LIMIT 25")).rows)add('warranty',r,'Đăng ký bảo hành chờ đối chiếu','Mở hồ sơ để kiểm tra chứng từ mua hàng.','warranty');}
  if(can('customers.read'))for(const r of(await pool.query("SELECT id,product_name,version,created_at FROM shopping_chat_threads WHERE awaiting_admin=true AND status='open' ORDER BY updated_at DESC LIMIT 25")).rows)add('shopping-chat',r,'Chat mua sắm cần phản hồi',r.product_name,'shopping-chat','warning');
  if(can('inventory.read'))for(const r of (await pool.query("SELECT v.id,v.sku,v.name,v.stock_quantity AS version FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.active=true AND p.active=true AND v.stock_quantity<=5 ORDER BY v.stock_quantity,v.id LIMIT 25")).rows)add('stock',r,r.version===0?'Sản phẩm hết hàng':'Sắp hết hàng',r.sku+' · Còn '+r.version,'inventory','warning');
  if(can('settings.write')){if(!config.TURNSTILE_SITE_KEY||!config.TURNSTILE_SECRET_KEY)add('config',{id:'turnstile',version:'missing'},'Chưa bật CAPTCHA','Cần cấu hình Site key và Secret key Cloudflare Turnstile trên máy chủ.','settings','warning');if(!config.smtp)add('config',{id:'smtp',version:'missing'},'Chưa cấu hình email','Email xác minh và khôi phục tài khoản chưa gửi được.','settings','warning');}
  const reads=(await pool.query('SELECT notice_key,seen_version FROM admin_notice_reads WHERE account_key=$1',[accountKey(admin)])).rows;const seen=new Map(reads.map(r=>[r.notice_key,r.seen_version]));return list.map(n=>({...n,read:seen.get(n.key)===n.version}));
}

function createAdminNotifications(pool,config){
  const router=Router();
  router.use('/notifications',requirePermission('dashboard.read'));
  router.get('/notifications',async(req,res,next)=>{try{const items=await notices(pool,req.admin,config);res.set('Cache-Control','no-store').json({items,unread:items.filter(i=>!i.read).length});}catch(e){next(e);}});
  router.post('/notifications/read',requireCsrf,async(req,res,next)=>{const parsed=z.object({key:z.string().max(100).optional(),version:z.string().max(150).optional(),all:z.boolean().optional()}).strict().safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Thông báo không hợp lệ.'});try{const visible=await notices(pool,req.admin,config);const targets=parsed.data.all?visible:visible.filter(n=>n.key===parsed.data.key&&n.version===parsed.data.version);if(!targets.length&&!parsed.data.all)return res.status(409).json({error:'Thông báo đã thay đổi hoặc bạn không có quyền xem. Hãy tải lại.'});for(const n of targets)await pool.query('INSERT INTO admin_notice_reads(account_key,notice_key,seen_version) VALUES($1,$2,$3) ON CONFLICT(account_key,notice_key) DO UPDATE SET seen_version=$3,seen_at=now()',[accountKey(req.admin),n.key,n.version]);res.json({message:'Đã đánh dấu đã đọc.'});}catch(e){next(e);}});

  router.get('/notifications/vapid-public-key',(_req,res)=>{
    const publicKey=config.VAPID_PUBLIC_KEY||process.env.VAPID_PUBLIC_KEY||null;
    res.set('Cache-Control','no-store').json({publicKey});
  });

  router.post('/notifications/push-subscribe',requireCsrf,async(req,res,next)=>{
    const parsed=pushSubscribeSchema.safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:'Dữ liệu đăng ký thông báo đẩy không hợp lệ.'});
    try{
      const {endpoint,keys}=parsed.data;
      try{await assertSafePushEndpoint(endpoint);}catch(err){return res.status(400).json({error:err.message||'Endpoint Web Push không hợp lệ.'});}
      const ua=String(req.get('user-agent')||'').slice(0,500);
      await pool.query(
        `INSERT INTO admin_push_subscriptions(account_key,endpoint,p256dh,auth,user_agent,updated_at)
         VALUES($1,$2,$3,$4,$5,now())
         ON CONFLICT(endpoint) DO UPDATE SET
           account_key=EXCLUDED.account_key,
           p256dh=EXCLUDED.p256dh,
           auth=EXCLUDED.auth,
           user_agent=EXCLUDED.user_agent,
           updated_at=now()`,
        [accountKey(req.admin),endpoint,keys.p256dh,keys.auth,ua]
      );
      res.json({ok:true,message:'Đã đăng ký nhận thông báo đẩy.'});
    }catch(e){next(e);}
  });

  router.post('/notifications/push-unsubscribe',requireCsrf,async(req,res,next)=>{
    const endpoint=typeof req.body?.endpoint==='string'?req.body.endpoint.trim():'';
    if(!endpoint)return res.status(400).json({error:'Thiếu endpoint.'});
    try{
      await pool.query('DELETE FROM admin_push_subscriptions WHERE endpoint=$1 AND account_key=$2',[endpoint,accountKey(req.admin)]);
      res.json({ok:true,message:'Đã hủy đăng ký thông báo đẩy.'});
    }catch(e){next(e);}
  });

  router.post('/notifications/push-test',requireCsrf,async(req,res,next)=>{
    try{
      const vapid={
        publicKey:config.VAPID_PUBLIC_KEY||process.env.VAPID_PUBLIC_KEY,
        privateKey:config.VAPID_PRIVATE_KEY||process.env.VAPID_PRIVATE_KEY,
        subject:config.VAPID_SUBJECT||process.env.VAPID_SUBJECT||'mailto:business@gaeru.com'
      };
      if(!vapid.publicKey||!vapid.privateKey){
        return res.status(503).json({error:'Máy chủ chưa cấu hình khóa VAPID.'});
      }
      const subs=(await pool.query('SELECT endpoint,p256dh,auth FROM admin_push_subscriptions WHERE account_key=$1',[accountKey(req.admin)])).rows;
      if(!subs.length){
        return res.status(404).json({error:'Thiết bị này chưa đăng ký nhận thông báo đẩy. Hãy bật Thông báo trình duyệt trước.'});
      }
      let sent=0;
      for(const s of subs){
        try{
          const r=await sendWebPushNotification(
            {endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},
            {
              title:'✉️ GAERU Mail · Thông báo đẩy đã bật',
              body:'Thiết bị đã sẵn sàng nhận thông báo cho hộp thư tên miền @gaeru.com (iCloud+ Mail).',
              target:'webmail',
              url:'https://www.icloud.com/mail',
              tag:'gaeru-mail-test-'+Date.now()
            },
            vapid
          );
          if(r.gone)await pool.query('DELETE FROM admin_push_subscriptions WHERE endpoint=$1',[s.endpoint]);
          else if(r.ok)sent+=1;
        }catch(_){}
      }
      res.json({ok:sent>0,sent,message:sent>0?'Đã gửi thông báo đẩy thử nghiệm tới '+sent+' thiết bị.':'Không gửi được tới thiết bị nào.'});
    }catch(e){next(e);}
  });

  const mailAccountActionSchema=z.object({
    action:z.enum(['add','passwd','del','icloud-smtp']),
    username:z.string().trim().min(1).max(64).optional(),
    password:z.string().min(4).max(160).optional(),
    displayName:z.string().trim().max(80).optional(),
    smtpHost:z.string().trim().max(120).optional(),
    smtpPort:z.coerce.number().int().min(1).max(65535).optional(),
    smtpUser:z.string().trim().max(160).optional(),
    smtpPassword:z.string().min(4).max(160).optional(),
    adminPassword:z.string().min(1).max(200).optional(),
    factorCode:z.string().max(64).optional(),
    factorChallengeId:z.string().max(128).optional()
  }).strict();

  const ownerOnly=(req,res,next)=>{
    if(req.admin?.role==='owner'||req.admin?.source==='bootstrap'||req.admin?.isOwner)return next();
    return res.status(403).json({error:'Chỉ chủ doanh nghiệp được quản lý hộp thư tên miền @gaeru.com.'});
  };

  async function callLocalMailAccountApi(method,body){
    const rawMailSecret=String(config.INTERNAL_MAIL_SECRET||process.env.INTERNAL_MAIL_SECRET||'').trim();
    const fallbackBase=String(config.SESSION_SECRET||process.env.SESSION_SECRET||'').trim();
    const secret=rawMailSecret||(fallbackBase?require('node:crypto').createHmac('sha256',fallbackBase).update('gaeru-internal-mail-v1').digest('hex'):'');
    if(!secret)throw Object.assign(new Error('Thiếu khóa bảo mật nội bộ cho dịch vụ mail.'),{status:503});
    const res=await fetch('http://127.0.0.1:8080/api/gaeru-mail/accounts',{
      method,
      headers:{
        'Content-Type':'application/json',
        'X-Gaeru-Internal-Mail':secret
      },
      ...(body?{body:JSON.stringify(body)}:{})
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok||data.error){
      const err=new Error(data.error||'Không thể thực hiện thao tác hộp thư.');
      err.status=res.status>=400?res.status:500;
      throw err;
    }
    return data;
  }

  router.get('/notifications/mail-accounts',requirePermission('settings.read'),async(_req,res,next)=>{
    try{
      const data=await callLocalMailAccountApi('GET');
      res.set('Cache-Control','no-store').json(data);
    }catch(e){
      if(e.status)return res.status(e.status).json({error:e.message});
      next(e);
    }
  });

  router.post('/notifications/mail-accounts',ownerOnly,requirePermission('settings.write'),requireCsrf,async(req,res,next)=>{
    const parsed=mailAccountActionSchema.safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:'Thông tin hộp thư không hợp lệ (mật khẩu tối thiểu 6 ký tự).'});
    try{
      const {verifyAdminStepUp}=require('./audit-fixes/admin-reauth');
      const stepUpReq=Object.create(req);
      stepUpReq.body={...req.body,password:parsed.data.adminPassword};
      await verifyAdminStepUp(stepUpReq,pool,config);
      const {adminPassword:_ap,factorCode:_fc,factorChallengeId:_fci,...mailPayload}=parsed.data;
      const data=await callLocalMailAccountApi('POST',mailPayload);
      res.json(data);
    }catch(e){
      if(e.status)return res.status(e.status).json({error:e.message});
      next(e);
    }
  });

  return router;
}
module.exports={createAdminNotifications,notices};
