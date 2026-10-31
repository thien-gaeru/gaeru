const {Router}=require('express');
const {rateLimit}=require('express-rate-limit');
const {z}=require('zod');
const {requirePermission}=require('./staff-access');
const {withTransaction}=require('./db');
const {appendAudit}=require('./audit');
const dns=require('node:dns').promises;
const mxResolver=new dns.Resolver({timeout:3000,tries:1});
const domainResolver={resolveMx:domain=>mxResolver.resolveMx(domain),lookup:domain=>dns.lookup(domain)};
const reasons={
  recipient_rejected:'Email người mua bị máy chủ từ chối',
  domain_missing:'Tên miền email không tồn tại',
  delivery_failed:'Gửi email không thành công; cần kiểm tra cấu hình hoặc liên hệ người mua',
  delivery_unknown:'Chưa xác định kết quả gửi email',
  delivery_delayed:'Email chưa gửi sau 15 phút',
  gateway_reconciliation_needed:'Cần đối soát trạng thái giao dịch cổng thanh toán trước khi hủy/xử lý (SLA 24h)'
};
async function inspectDomain(email,resolver=domainResolver){
 const domain=email.split('@').at(-1);
 try{const mx=await resolver.resolveMx(domain);if(mx.some(r=>r.exchange&&r.exchange!=='.'))return 'valid';if(mx.length)return 'missing';}
 catch(e){if(e.code==='ENOTFOUND')return 'missing';if(e.code!=='ENODATA')return 'unknown';}
 try{await resolver.lookup(domain);return 'valid';}catch(e){return e.code==='ENOTFOUND'?'missing':'unknown';}
}
async function screenNextEmail(pool,{resolver=dns}={}){
 const row=(await pool.query("SELECT j.id,o.email FROM order_email_outbox j JOIN orders o ON o.id=j.order_id WHERE j.kind='receipt' AND j.status='pending' AND j.next_attempt_at<=now() ORDER BY j.created_at,j.id LIMIT 1")).rows[0];
 if(row&&await inspectDomain(row.email,resolver)==='missing')await pool.query("UPDATE order_email_outbox SET status='failed',finished_at=now(),result='Tên miền email không tồn tại' WHERE id=$1 AND status='pending'",[row.id]);
}
async function classify(pool){
 await pool.query(`INSERT INTO order_reviews(order_id,reason)
 SELECT j.order_id,CASE WHEN j.result='Tên miền email không tồn tại' THEN 'domain_missing' WHEN j.result='SMTP từ chối' THEN 'recipient_rejected' WHEN j.status='unknown' THEN 'delivery_unknown' WHEN j.status='pending' THEN 'delivery_delayed' ELSE 'delivery_failed' END
 FROM order_email_outbox j WHERE j.kind='receipt' AND (j.status IN ('failed','unknown') OR (j.status='pending' AND j.created_at<now()-interval '15 minutes'))
 ON CONFLICT(order_id) DO NOTHING`);
}
async function guardContact(client,customer){
 const phone=customer.phone.replace(/\D/g,'');
 // A stable lock serializes simultaneous submissions for the same contact.
 for(const key of ['email:'+customer.email.toLowerCase(),'phone:'+phone].sort())await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['order-limit:'+key]);
 const {rows}=await client.query("SELECT count(*)::int AS n FROM orders WHERE status<>'cancelled' AND created_at>now()-interval '15 minutes' AND (lower(email)=$1 OR regexp_replace(phone,'[^0-9]','','g')=$2)",[customer.email.toLowerCase(),phone]);
 if(rows[0].n>3)throw Object.assign(Error('Thông tin liên hệ này đã đặt nhiều đơn liên tiếp. Vui lòng chờ 15 phút hoặc gọi GAERU để xác nhận.'),{status:429});
}
function reviewRouter(pool,config){
 const r=Router(),limit=rateLimit({windowMs:60000,limit:60,standardHeaders:'draft-8',legacyHeaders:false});
 r.get('/orders/review',limit,requirePermission('orders.read'),async(req,res,next)=>{try{const result=await pool.query(`SELECT o.id,o.order_number AS "orderNumber",o.customer_name AS "customerName",o.email,o.phone,o.address,o.city,o.status,o.payment_status AS "paymentStatus",o.total_vnd AS "totalVnd",r.reason,r.created_at AS "flaggedAt",(SELECT jsonb_agg(jsonb_build_object('productName',i.product_name,'variantName',i.variant_name,'quantity',i.quantity)) FROM order_items i WHERE i.order_id=o.id) AS items FROM order_reviews r JOIN orders o ON o.id=r.order_id WHERE r.resolved_at IS NULL ORDER BY r.created_at DESC LIMIT 100`);const total=(await pool.query('SELECT count(*)::int AS n FROM order_reviews WHERE resolved_at IS NULL')).rows[0].n;const owner=(await pool.query("SELECT email,contacts_verified_at FROM account_security WHERE account_key='owner'")).rows[0];res.set('Cache-Control','no-store').json({orders:result.rows.map(o=>({...o,reasonText:reasons[o.reason]||o.reason})),total,notifications:{recipient:owner?.contacts_verified_at?owner.email:null,smtpConfigured:Boolean(config.smtp),counts:(await pool.query('SELECT status,count(*)::int AS total FROM order_admin_email_outbox GROUP BY status')).rows}});}catch(e){next(e);}});
 r.post('/orders/:id/review',limit,requirePermission('orders.write'),async(req,res,next)=>{const p=z.object({resolution:z.string().trim().min(5).max(1000)}).strict().safeParse(req.body);if(!z.string().uuid().safeParse(req.params.id).success||!p.success)return res.status(400).json({error:'Nhập kết quả gọi xác nhận (ít nhất 5 ký tự).'});try{const changed=await withTransaction(pool,async c=>{const row=(await c.query('UPDATE order_reviews SET resolved_at=now(),resolution=$2,updated_at=now() WHERE order_id=$1 AND resolved_at IS NULL RETURNING order_id',[req.params.id,p.data.resolution])).rows[0];if(row)await appendAudit(c,{actor:req.admin,action:'order.review.resolve',entityType:'order',entityId:row.order_id,metadata:{resolution:p.data.resolution}});return row;});if(!changed)return res.status(404).json({error:'Đơn không còn trong khu vực chờ xác minh.'});res.json({message:'Đã lưu kết quả gọi và đưa đơn trở lại danh sách xử lý. Trạng thái thanh toán không thay đổi.'});}catch(e){next(e);}});
 return r;
}
async function notifyAdmin(pool,config,mailer){
 if(!mailer||!config.smtp?.from)return false;
 await pool.query("UPDATE order_admin_email_outbox SET status='unknown',finished_at=now(),result='Tiến trình gián đoạn; kiểm tra trước khi gửi lại' WHERE status='sending' AND attempted_at<now()-interval '2 minutes'");
 const job=await withTransaction(pool,async c=>{const owner=(await c.query("SELECT email FROM account_security WHERE account_key='owner' AND contacts_verified_at IS NOT NULL")).rows[0];if(!z.string().email().safeParse(owner?.email).success)return null;const row=(await c.query("SELECT j.id,j.attempts,o.order_number,o.customer_name,o.phone,o.email,o.total_vnd,o.payment_method FROM order_admin_email_outbox j JOIN orders o ON o.id=j.order_id WHERE j.status='pending' AND j.next_attempt_at<=now() ORDER BY o.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1")).rows[0];if(!row)return null;await c.query("UPDATE order_admin_email_outbox SET status='sending',recipient=$2,attempts=attempts+1,attempted_at=now() WHERE id=$1",[row.id,owner.email]);return {...row,recipient:owner.email};});
 if(!job)return false;
 const base=require('./primary-domain').normalizePublicBase(config.PUBLIC_BASE_URL||config.smtp.publicBaseUrl);
 try{const result=await mailer.sendMail({from:config.smtp.from,to:job.recipient,subject:'GAERU · Đơn mới '+job.order_number,text:'Có đơn hàng mới '+job.order_number+'\nNgười mua: '+job.customer_name+'\nĐiện thoại: '+job.phone+'\nEmail: '+job.email+'\nTổng: '+new Intl.NumberFormat('vi-VN').format(job.total_vnd)+' ₫\nPhương thức: '+job.payment_method+'\nKiểm tra đơn và mục Đơn hàng rác / chờ xác minh trước khi giao:\n'+base+'/gaeru_ceo#orders',messageId:'<admin-order-'+job.id+'@gaeru.com>'});const accepted=result?.accepted?.some(x=>String(x.address||x).toLowerCase()===job.recipient.toLowerCase());await pool.query("UPDATE order_admin_email_outbox SET status=$2,finished_at=now(),result=$3 WHERE id=$1 AND status='sending'",[job.id,accepted?'sent':result?.rejected?.length?'failed':'unknown',accepted?'SMTP đã tiếp nhận':'Kiểm tra gửi email quản trị']);}
 catch(e){const safeRetry=(Number(e.responseCode)>=400&&Number(e.responseCode)<500)||(!e.responseCode&&['CONN','EHLO','STARTTLS','AUTH','MAIL FROM','RCPT TO'].includes(e.command));const retry=safeRetry&&job.attempts<2;await pool.query("UPDATE order_admin_email_outbox SET status=$2,next_attempt_at=now()+interval '5 minutes',finished_at=CASE WHEN $2='pending' THEN NULL ELSE now() END,result=$3 WHERE id=$1 AND status='sending'",[job.id,retry?'pending':Number(e.responseCode)>=400?'failed':'unknown',retry?'Chờ thử lại kết nối SMTP':'Kiểm tra kết quả trước khi gửi lại']);}
 return true;
}

// P2-02 & P2-03: OrderReviewService hợp nhất toàn bộ sàng lọc, phân loại, thông báo admin và theo dõi SLA
class OrderReviewService {
  static get reasons() { return reasons; }
  static inspectDomain(email, resolver) { return inspectDomain(email, resolver); }
  static screenNextEmail(pool, options) { return screenNextEmail(pool, options); }
  static classify(pool) { return classify(pool); }
  static notifyAdmin(pool, config, mailer) { return notifyAdmin(pool, config, mailer); }
  static async checkSlaBreaches(pool, { slaHours = 24 } = {}) {
    const overdue = await pool.query(
      `SELECT r.order_id, o.order_number, o.payment_method, r.created_at
       FROM order_reviews r
       JOIN orders o ON o.id = r.order_id
       WHERE r.reason = 'gateway_reconciliation_needed'
         AND r.resolved_at IS NULL
         AND r.created_at < now() - ($1::text || ' hours')::interval`,
      [String(slaHours)]
    );
    return overdue.rows;
  }
  static async processReviewCycle(pool, config, mailer, options = {}) {
    const results = { screened: false, classified: false, notified: false, slaBreaches: 0, errors: [] };

    // 1. Sàng lọc tên miền email
    try {
      await screenNextEmail(pool, { resolver: options.resolver });
      results.screened = true;
    } catch (err) {
      results.errors.push({ step: 'screenNextEmail', error: err });
    }

    // 2. Phân loại đơn nghi vấn / chậm trễ
    try {
      await classify(pool);
      results.classified = true;
    } catch (err) {
      results.errors.push({ step: 'classify', error: err });
    }

    // 3. Gửi email cảnh báo tới quản trị viên
    try {
      results.notified = await notifyAdmin(pool, config, mailer);
    } catch (err) {
      results.errors.push({ step: 'notifyAdmin', error: err });
    }

    // 4. Giám sát vi phạm SLA đối soát cổng thanh toán (24h)
    try {
      const breaches = await OrderReviewService.checkSlaBreaches(pool, { slaHours: 24 });
      results.slaBreaches = breaches.length;
      if (breaches.length > 0) {
        const { alertSystem } = require('./system-alerts');
        for (const breach of breaches) {
          await alertSystem(pool, {
            severity: 'error',
            source: 'order_review_sla_monitor',
            message: `[SLA BREACH] Đơn ${breach.order_number} (${breach.payment_method?.toUpperCase()}) đã chờ đối soát thủ công quá 24h chưa được xử lý!`,
            metadata: {
              orderId: breach.order_id,
              orderNumber: breach.order_number,
              paymentMethod: breach.payment_method,
              createdAt: breach.created_at
            },
            config
          });
        }
      }
    } catch (err) {
      results.errors.push({ step: 'checkSlaBreaches', error: err });
    }

    // P2-03: Nếu có bất kỳ bước nào lỗi (DB, SMTP, DNS), không được nuốt lỗi mà phải ném lỗi để JobQueue retry
    if (results.errors.length > 0) {
      const msg = results.errors.map(e => `${e.step}: ${e.error?.message || e.error}`).join('; ');
      const err = new Error(`Order review execution encountered partial failure: ${msg}`);
      err.code = 'ORDER_REVIEW_PARTIAL_FAILURE';
      err.errors = results.errors;
      err.partialResults = results;
      throw err;
    }

    return results;
  }
}

module.exports={inspectDomain,screenNextEmail,classify,guardContact,reviewRouter,notifyAdmin,OrderReviewService,reasons};

