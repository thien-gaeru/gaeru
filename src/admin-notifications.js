const crypto=require('node:crypto');
const {Router}=require('express');
const {z}=require('zod');
const {requirePermission,ROLE_PERMISSIONS}=require('./staff-access');const {requireCsrf}=require('./security');
const {sendWebPushNotification}=require('./web-push');
const {assertSafePushEndpoint}=require('./audit-fixes/push-url-guard');
const accountKey=a=>a.source==='bootstrap'?'owner':'staff:'+a.id;

function decodeBase64Url(value){
  const normalized=String(value||'').trim().replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
  return Buffer.from(normalized,'base64url');
}

function isValidP256PublicKey(value){
  try{
    const buf=decodeBase64Url(value);
    if(buf.length!==65||buf[0]!==0x04)return false;
    const probe=crypto.createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(buf);
    return true;
  }catch(_){
    return false;
  }
}

function isValidAuthSecret(value){
  try{
    const buf=decodeBase64Url(value);
    return buf.length>=16&&buf.length<=32;
  }catch(_){
    return false;
  }
}

function resolveVapidConfig(config={}){
  const publicKey=String(config?.VAPID_PUBLIC_KEY||process.env.VAPID_PUBLIC_KEY||'').trim();
  const privateKey=String(config?.VAPID_PRIVATE_KEY||process.env.VAPID_PRIVATE_KEY||'').trim();
  const subject=String(config?.VAPID_SUBJECT||process.env.VAPID_SUBJECT||'mailto:business@gaeru.com').trim()||'mailto:business@gaeru.com';
  if(!publicKey||!privateKey)return null;
  return {publicKey,privateKey,subject};
}

function isSubscriberAuthorized(row,requiredPermissions){
  if(!row?.account_key)return false;
  if(row.account_key==='owner')return true;
  if(!String(row.account_key).startsWith('staff:'))return false;
  if(row.active!==true||!row.role)return false;
  if(!Array.isArray(requiredPermissions)||!requiredPermissions.length)return true;
  const perms=ROLE_PERMISSIONS[row.role]||[];
  return requiredPermissions.some(p=>perms.includes(p));
}

async function deliverPushToRows(pool,subs,payload,vapid,fetcher=globalThis.fetch){
  if(!Array.isArray(subs)||!subs.length)return {sent:0,failed:0,gone:0};
  const results=await Promise.allSettled(subs.map(async s=>{
    const host=(()=>{try{return new URL(s.endpoint).origin;}catch{return 'unknown';}})();
    try{
      if(fetcher===globalThis.fetch){
        await assertSafePushEndpoint(s.endpoint);
      }
      const r=await sendWebPushNotification(
        {endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},
        payload,
        vapid,
        fetcher
      );
      if(r.gone){
        await pool.query('DELETE FROM admin_push_subscriptions WHERE endpoint=$1',[s.endpoint]).catch(()=>{});
        return 'gone';
      }
      if(r.ok)return 'sent';
      console.warn('[web-push] push rejected:',JSON.stringify({host,status:r.status}));
      return 'failed';
    }catch(err){
      console.warn('[web-push] delivery error:',JSON.stringify({host,error:err?.message||String(err)}));
      return 'failed';
    }
  }));
  let sent=0,failed=0,gone=0;
  for(const item of results){
    const val=item.status==='fulfilled'?item.value:'failed';
    if(val==='sent')sent+=1;
    else if(val==='gone')gone+=1;
    else failed+=1;
  }
  return {sent,failed,gone};
}

/**
 * Gửi thông báo Web Push tới tất cả thiết bị quản trị đã đăng ký và có quyền tương ứng.
 */
async function dispatchAdminWebPush(pool,config,{requiredPermissions=['dashboard.read'],title,body,target='notifications',tag,url}={}){
  const vapid=resolveVapidConfig(config);
  if(!vapid||!pool||typeof pool.query!=='function')return {sent:0,failed:0,gone:0,skipped:true};
  let rows=[];
  try{
    rows=(await pool.query(
      `SELECT sub.endpoint,sub.p256dh,sub.auth,sub.account_key,s.role,s.active
       FROM admin_push_subscriptions sub
       LEFT JOIN staff_accounts s ON sub.account_key=('staff:'||s.id::text)`
    )).rows||[];
  }catch(err){
    if(err?.code==='42P01')return {sent:0,failed:0,gone:0,skipped:true};
    throw err;
  }
  const authorized=rows.filter(r=>isSubscriberAuthorized(r,requiredPermissions));
  if(!authorized.length)return {sent:0,failed:0,gone:0};
  const fetcher=typeof config?.webPushFetcher==='function'?config.webPushFetcher:globalThis.fetch;
  return deliverPushToRows(pool,authorized,{title,body,target,...(tag?{tag}:{}),...(url?{url}:{})},vapid,fetcher);
}

/**
 * Kích hoạt gửi Web Push chạy nền không chặn luồng giao dịch HTTP/DB chính.
 */
function notifyAdminPushBackground(pool,config,opts){
  if(!pool||typeof pool.query!=='function')return;
  const run=()=>dispatchAdminWebPush(pool,config,opts).catch(err=>{
    console.warn('[web-push] background dispatch error:',err?.message||String(err));
  });
  if(typeof setImmediate==='function')setImmediate(run);
  else Promise.resolve().then(run);
}

const pushSubscribeSchema=z.object({
  endpoint:z.string().url().max(2048),
  expirationTime:z.number().finite().nullable().optional(),
  keys:z.object({
    p256dh:z.string().trim().min(20).max(256).refine(isValidP256PublicKey,'Khóa công khai p256dh Web Push không hợp lệ.'),
    auth:z.string().trim().min(16).max(128).refine(isValidAuthSecret,'Khóa auth Web Push không hợp lệ.')
  })
}).strict();

const { noticePage, readNotices } = require('./admin-notice-feed');
async function notices(pool, admin, config) {
  return (await noticePage(pool, admin, config, accountKey(admin))).items;
}

function createAdminNotifications(pool,config){
  const router=Router();
  router.use('/notifications',requirePermission('dashboard.read'));
  router.get('/notifications', async (req, res, next) => {
    const params = z.object({
      page: z.coerce.number().int().min(1).max(1000000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25)
    }).strict().safeParse(req.query);
    if (!params.success) return res.status(400).json({ error: 'Trang thông báo không hợp lệ.' });
    try {
      const result = await noticePage(pool, req.admin, config, accountKey(req.admin), params.data);
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) { next(error); }
  });
  router.post('/notifications/read', requireCsrf, async (req, res, next) => {
    const parsed = z.object({ key:z.string().max(100).optional(), version:z.string().max(150).optional(), all:z.boolean().optional() }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error:'Thông báo không hợp lệ.' });
    try {
      const ok = await readNotices(pool, req.admin, config, accountKey(req.admin), parsed.data);
      if (!ok) return res.status(409).json({ error:'Thông báo đã thay đổi hoặc bạn không có quyền xem. Hãy tải lại.' });
      res.json({ message:'Đã đánh dấu đã đọc.' });
    } catch (error) { next(error); }
  });

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
      const vapid=resolveVapidConfig(config);
      if(!vapid){
        return res.status(503).json({error:'Máy chủ chưa cấu hình khóa VAPID.'});
      }
      const subs=(await pool.query('SELECT endpoint,p256dh,auth FROM admin_push_subscriptions WHERE account_key=$1',[accountKey(req.admin)])).rows;
      if(!subs.length){
        return res.status(404).json({error:'Thiết bị này chưa đăng ký nhận thông báo đẩy. Hãy bật Thông báo trình duyệt trước.'});
      }
      const isMailTest=req.body?.channel==='mail';
      const payload=isMailTest
        ?{
            title:'✉️ GAERU Mail · Thông báo đẩy đã bật',
            body:'Thiết bị đã sẵn sàng nhận thông báo cho hộp thư tên miền @gaeru.com (iCloud+ Mail).',
            target:'webmail',
            url:'https://www.icloud.com/mail',
            tag:'icloud-mail-test-'+Date.now()
          }
        :{
            title:'🔔 GAERU CEO · Thông báo đẩy đã bật',
            body:'Thiết bị này đã sẵn sàng nhận thông báo đơn hàng, chat khách hàng và yêu cầu hỗ trợ mới.',
            target:'notifications',
            tag:'gaeru-admin-test-'+Date.now()
          };
      const fetcher=typeof config?.webPushFetcher==='function'?config.webPushFetcher:globalThis.fetch;
      const result=await deliverPushToRows(pool,subs,payload,vapid,fetcher);
      const message=result.sent>0
        ?`Đã gửi thông báo đẩy thử nghiệm tới ${result.sent} thiết bị.`
        :(result.gone>0
          ?'Đăng ký trên thiết bị đã hết hạn và được dọn sạch. Vui lòng bật lại Thông báo đẩy.'
          :'Không gửi được thông báo đẩy tới thiết bị nào. Vui lòng kiểm tra kết nối push gateway.');
      res.json({ok:result.sent>0,sent:result.sent,failed:result.failed,gone:result.gone,message});
    }catch(e){next(e);}
  });

  router.get('/notifications/icloud-mail',requirePermission('settings.read'),(_req,res)=>{
    const smtpHost=config.smtp?.host||config.SMTP_HOST||'smtp.mail.me.com';
    const smtpPort=Number(config.smtp?.port||config.SMTP_PORT||587);
    const senderEmail=config.smtp?.from||config.SMTP_FROM||'noreply@gaeru.com';
    const replyTo=config.smtp?.replyTo||config.SMTP_REPLY_TO||'business@gaeru.com';
    const adminEmail=config.smtp?.adminDomainEmail||config.ADMIN_DOMAIN_EMAIL||'business@gaeru.com';
    const passwordPlaceholder=String(config.SMTP_PASSWORD||'').trim()==='ICLOUD_APP_PASSWORD_REQUIRED';
    res.set('Cache-Control','no-store').json({
      provider:'iCloud+ Custom Email Domain',
      internalMailDisabled:true,
      domain:'gaeru.com',
      webmailUrl:'https://www.icloud.com/mail',
      manageUrl:'https://www.icloud.com/icloudplus/',
      mxServers:['mx01.mail.icloud.com','mx02.mail.icloud.com'],
      smtp:{
        host:smtpHost,
        port:smtpPort,
        configured:Boolean(config.smtp),
        passwordPlaceholder,
        senderEmail,
        replyTo,
        adminEmail
      }
    });
  });

  return router;
}
module.exports={createAdminNotifications,notices,dispatchAdminWebPush,notifyAdminPushBackground,deliverPushToRows,resolveVapidConfig,isSubscriberAuthorized,pushSubscribeSchema};
