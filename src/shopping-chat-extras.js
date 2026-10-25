const multer = require('multer');
const { z } = require('zod');
const { randomUUID } = require('node:crypto');
const { requireCsrf } = require('./security');
const { requirePermission } = require('./staff-access');
const { withTransaction } = require('./db');
const fail = (message, status = 400) => Object.assign(Error(message), { status });
function fileType(file) {
  const b = file?.buffer;
  if (!b?.length) return null;
  const ext = file.originalname.split('.').pop().toLowerCase();
  if (['jpg','jpeg'].includes(ext) && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (ext === 'png' && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (ext === 'webp' && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  if (ext === 'pdf' && b.toString('ascii',0,5) === '%PDF-') return 'application/pdf';
  if (['mp4','mov'].includes(ext) && b.toString('ascii',4,8) === 'ftyp') return ext === 'mov' ? 'video/quicktime' : 'video/mp4';
  if (['heic','heif'].includes(ext) && b.toString('ascii',4,8) === 'ftyp' && ['heic','heix','hevc','hevx','mif1','msf1'].includes(b.toString('ascii',8,12))) return 'image/heic';
  if (ext === 'webm' && b.subarray(0,4).equals(Buffer.from([26,69,223,163]))) return 'video/webm';
  if (['docx','xlsx'].includes(ext) && b.subarray(0,4).equals(Buffer.from([80,75,3,4]))) return 'application/octet-stream';
  if (['doc','xls'].includes(ext) && b.subarray(0,8).equals(Buffer.from([208,207,17,224,161,177,26,225]))) return 'application/octet-stream';
  if (['txt','csv'].includes(ext) && !b.includes(0) && !b.toString('utf8').includes('\uFFFD')) return 'text/plain';
  return null;
}
async function answerAI({config,product,question,decision=false,transport=fetch}) {
  const settings=config.chatAI||{provider:'openai',apiKey:config.OPENAI_API_KEY,model:config.OPENAI_CHAT_MODEL||'gpt-4.1-mini',enabled:Boolean(config.OPENAI_API_KEY)};
  return require('./chat-ai-provider').generate({settings,product,question,decision,transport});
}
function attachShoppingChat({publicApi,admin,pool,config,owns,wrap,limit}) {
  const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:10485760,files:1,fields:1,fieldSize:100}}).single('file');
  const parseUpload = (req,res,next)=>upload(req,res,error=>error?res.status(400).json({error:'Mỗi lần gửi một tệp tối đa 10 MB.'}):next());
  const authorize = isAdmin => wrap(async(req,res,next)=>{ const id=z.string().uuid().parse(req.params.id); const row=isAdmin?(await pool.query('SELECT * FROM shopping_chat_threads WHERE id=$1',[id])).rows[0]:(await owns(req,id)).rows[0]; if(!row)throw fail('Không tìm thấy hội thoại.',404);req.chatThread=row;next(); });
  const save = isAdmin => wrap(async(req,res)=>{
    const key=z.string().uuid().parse(req.body.requestKey),mime=fileType(req.file);
    if(!mime)throw fail('Chỉ nhận JPG, PNG, WebP, HEIC, MP4, MOV, WebM, PDF, Word, Excel, TXT hoặc CSV hợp lệ.');
    const name=req.file.originalname.replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,180);
    await withTransaction(pool,async c=>{
      await c.query("SELECT pg_advisory_xact_lock(hashtext('shopping-chat-storage'))");
      const row=(await c.query('SELECT status FROM shopping_chat_threads WHERE id=$1 FOR UPDATE',[req.chatThread.id])).rows[0];
      if((await c.query('SELECT id FROM shopping_chat_messages WHERE thread_id=$1 AND request_key=$2',[req.chatThread.id,key])).rows.length)return;
      if(row.status==='closed')throw fail('Hội thoại đã đóng.',409);
      const usage=(await c.query('SELECT COALESCE(sum(octet_length(content)),0)::bigint AS total,COALESCE(sum(octet_length(content)) FILTER(WHERE thread_id IN(SELECT id FROM shopping_chat_threads WHERE owner_key=$1 OR (customer_id IS NOT NULL AND customer_id=$2))),0)::bigint AS thread FROM shopping_chat_files',[req.chatThread.owner_key,req.chatThread.customer_id])).rows[0];
      if(Number(usage.total)+req.file.size>1073741824 || Number(usage.thread)+req.file.size>52428800)throw fail('Đã đạt giới hạn lưu tệp. Liên hệ nhân viên để được hỗ trợ.',413);
      if(!isAdmin)await require('./shopping-chat-ai-first').offerHandoff(c,req.chatThread.id,'attachment','Nhân viên GAERU có thể xem tệp và hỗ trợ bạn. Chọn Gặp nhân viên để kết nối.');
      const message=(await c.query('INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,$2,$3,$4) RETURNING id',[req.chatThread.id,isAdmin?'admin':'customer','Tệp đính kèm: '+name,key])).rows[0];
      await c.query('INSERT INTO shopping_chat_files(message_id,thread_id,name,mime,content) VALUES($1,$2,$3,$4,$5)',[message.id,req.chatThread.id,name,mime,req.file.buffer]);
      await c.query('UPDATE shopping_chat_threads SET version=version+1,awaiting_admin=$2,updated_at=now() WHERE id=$1',[req.chatThread.id,!isAdmin&&req.chatThread.handling_mode==='human']);
      if(isAdmin)await require('./audit').appendAudit(c,{actor:req.admin,action:'shopping.chat.file',entityType:'shopping_chat',entityId:req.chatThread.id,metadata:{size:req.file.size}});
    });res.status(201).json({message:'Đã gửi tệp.'});
  });
  const download = wrap(async(req,res)=>{
    const id=z.string().uuid().parse(req.params.fileId);
    const file=(await pool.query('SELECT name,mime,content FROM shopping_chat_files WHERE id=$1 AND thread_id=$2',[id,req.chatThread.id])).rows[0];
    if(!file)throw fail('Không tìm thấy tệp.',404);
    const inline=['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm'].includes(file.mime)&&req.query.download!=='1';
    const content=Buffer.from(file.content),headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Type':file.mime,'Content-Disposition':(inline?'inline':'attachment')+"; filename=download; filename*=UTF-8''"+encodeURIComponent(file.name),'Content-Security-Policy':"sandbox; default-src 'none'"};
    if(inline&&file.mime.startsWith('video/')){
      headers['Accept-Ranges']='bytes';const range=req.headers.range;
      if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);let start,end;
        if(match&&(match[1]||match[2])){start=match[1]?Number(match[1]):Math.max(0,content.length-Number(match[2]));end=match[1]?(match[2]?Number(match[2]):content.length-1):content.length-1;}
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=content.length)return res.set({...headers,'Content-Range':'bytes */'+content.length}).status(416).end();
        end=Math.min(end,content.length-1);return res.set({...headers,'Content-Range':`bytes ${start}-${end}/${content.length}`,'Content-Length':String(end-start+1)}).status(206).send(content.subarray(start,end+1));
      }
    }
    res.set(headers).send(content);
  });
  publicApi.post('/threads/:id/files',requireCsrf,limit,authorize(false),parseUpload,save(false));
  publicApi.get('/threads/:id/files/:fileId',authorize(false),download);
  admin.post('/shopping-chat/:id/files',requirePermission('customers.write'),requireCsrf,limit,authorize(true),parseUpload,save(true));
  admin.get('/shopping-chat/:id/files/:fileId',authorize(true),download);
  admin.get('/shopping-chat/:id/offers',requirePermission('marketing.read'),authorize(true),wrap(async(req,res)=>{
    const kind=z.enum(['vouchers','campaigns']).parse(req.query.kind),page=z.coerce.number().int().min(1).max(10000).parse(req.query.page||1);
    const money=n=>new Intl.NumberFormat('vi-VN').format(n)+' ₫';
    const date=d=>new Date(d).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'});
    let items;
    if(kind==='vouchers'){
      const rows=(await pool.query(`SELECT v.* FROM marketing_vouchers v WHERE v.active=true AND now() BETWEEN v.starts_at AND v.ends_at AND (v.public_claim=true OR EXISTS(SELECT 1 FROM customer_vouchers w WHERE w.voucher_id=v.id AND w.customer_id=$1)) AND (SELECT count(*) FROM voucher_redemptions r WHERE r.voucher_id=v.id AND r.released=false)<v.total_limit AND (SELECT count(*) FROM voucher_redemptions r WHERE r.voucher_id=v.id AND r.customer_id=$1 AND r.released=false)<v.per_customer_limit ORDER BY v.created_at DESC,v.id LIMIT 25 OFFSET $2`,[req.chatThread.customer_id,(page-1)*25])).rows;
      items=rows.map(v=>({id:v.id,title:v.code+' · '+v.title,text:'Voucher '+v.code+' — '+v.title+'\nGiảm '+(v.kind==='percent'?v.amount+'%':money(v.amount))+(v.max_discount_vnd?' (tối đa '+money(v.max_discount_vnd)+')':'')+'\nĐơn sản phẩm từ '+money(v.min_spend_vnd)+' · Mỗi khách tối đa '+v.per_customer_limit+' lượt.\nHiệu lực đến '+date(v.ends_at)+' (giờ Việt Nam).\nĐăng nhập để lưu/kiểm tra điều kiện tại Tài khoản → Ví voucher & ưu đãi. Không giảm phí giao hàng; áp dụng theo điều kiện và lượt còn lại khi thanh toán.'}));
    }else{
      const rows=(await pool.query('SELECT id,title,body,ends_at FROM marketing_campaigns WHERE active=true AND now() BETWEEN starts_at AND ends_at ORDER BY created_at DESC,id LIMIT 25 OFFSET $1',[(page-1)*25])).rows;
      items=rows.map(c=>({id:c.id,title:c.title,text:'Chương trình: '+c.title+'\n'+c.body.slice(0,2400)+'\nHiệu lực đến '+date(c.ends_at)+' (giờ Việt Nam).\nXem chương trình trong Tài khoản → Ví voucher & ưu đãi.'}));
    }
    res.set('Cache-Control','no-store').json({items,page,hasMore:items.length===25});
  }));
  publicApi.post('/threads/:id/handoff',requireCsrf,limit,authorize(false),wrap(async(req,res)=>{await withTransaction(pool,c=>require('./shopping-chat-ai-first').handoff(c,req.chatThread.id,'customer_request'));res.json({message:'Đã chuyển hội thoại cho nhân viên.'});}));
  publicApi.get('/capabilities',wrap(async(_req,res)=>{const settings=await require('./chat-ai-provider').getChatAIConfig(pool,config);res.json({aiConfigured:Boolean(settings.enabled&&settings.apiKey),provider:settings.enabled?settings.provider:null,maxFileBytes:10485760});}));
  publicApi.post('/threads/:id/ai',requireCsrf,limit,authorize(false),(_req,res)=>res.status(409).json({error:'AI đang trả lời tự động. Bạn có thể chọn Gặp nhân viên để chuyển hỗ trợ.'}));
}
module.exports={attachShoppingChat,fileType,answerAI};
