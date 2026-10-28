const {storeUpload,readMedia}=require('./lib/stored-media');
const {processChatCompression}=require('./shopping-chat-compression');
const multer = require('multer');
const uploadRules = require('./audit-fixes/upload-state');
const { receiveChunk } = require('./audit-fixes/upload-session');
const { z } = require('zod');
const { requireCsrf } = require('./security');
const { requirePermission } = require('./staff-access');
const { withTransaction } = require('./db');
const fail = (message, status = 400) => Object.assign(Error(message), { status });

function fileType(file) {
  const b = file?.buffer;
  if (!b?.length) return null;
  const ext = String(file.originalname || '').split('.').pop().toLowerCase();
  if (['jpg','jpeg'].includes(ext) && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (ext === 'png' && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (ext === 'webp' && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  if (ext === 'gif' && ['GIF87a','GIF89a'].includes(b.toString('ascii',0,6))) return 'image/gif';
  if (ext === 'pdf' && b.toString('ascii',0,5) === '%PDF-') return 'application/pdf';
  if (['mp4','mov','m4v'].includes(ext) && b.toString('ascii',4,8) === 'ftyp') return ext === 'mov' ? 'video/quicktime' : 'video/mp4';
  if (['heic','heif'].includes(ext) && b.toString('ascii',4,8) === 'ftyp' && ['heic','heix','hevc','hevx','mif1','msf1'].includes(b.toString('ascii',8,12))) return 'image/heic';
  if (['webm','mkv'].includes(ext) && b.subarray(0,4).equals(Buffer.from([26,69,223,163]))) return 'video/webm';
  if (ext === 'avi' && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,11) === 'AVI') return 'video/mp4';
  if (['docx','xlsx','pptx','zip'].includes(ext) && b.subarray(0,4).equals(Buffer.from([80,75,3,4]))) return 'application/octet-stream';
  if (['doc','xls','ppt'].includes(ext) && b.subarray(0,8).equals(Buffer.from([208,207,17,224,161,177,26,225]))) return 'application/octet-stream';
  if (['txt','csv'].includes(ext) && !b.includes(0) && !b.toString('utf8').includes('\uFFFD')) return 'text/plain';
  return null;
}

async function answerAI({config,product,question,decision=false,transport=fetch}) {
  const settings=config.chatAI||{provider:'openai',apiKey:config.OPENAI_API_KEY,model:config.OPENAI_CHAT_MODEL||'gpt-4.1-mini',enabled:Boolean(config.OPENAI_API_KEY)};
  return require('./chat-ai-provider').generate({settings,product,question,decision,transport});
}

async function persistChatFile({pool,chatThread,isAdmin,adminActor,requestKey,originalName,buffer,mime,client=null}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > uploadRules.MAX_FILE_BYTES) throw fail("File exceeds upload limit (" + Math.round(uploadRules.MAX_FILE_BYTES / 1048576) + " MiB).", 413);
  let safeName = String(originalName || 'attachment').replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180);
  const originalSize = buffer.length;
  let fileRecord = null;
  const persist = async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('shopping-chat-storage'))");
    const row = (await c.query('SELECT status FROM shopping_chat_threads WHERE id=$1 FOR UPDATE', [chatThread.id])).rows[0];
    const existing = (await c.query('SELECT id FROM shopping_chat_messages WHERE thread_id=$1 AND request_key=$2', [chatThread.id, requestKey])).rows[0];
    if (existing) {
      fileRecord = (await c.query('SELECT id, name, mime, byte_size, original_byte_size, compressed_byte_size, compression_status FROM shopping_chat_files WHERE message_id=$1', [existing.id])).rows[0];
      return;
    }
    if (row.status === 'closed') throw fail('Hội thoại đã đóng.', 409);
    const quota = (await c.query("SELECT COALESCE(SUM(COALESCE(original_byte_size,byte_size)),0)::bigint AS bytes FROM shopping_chat_files WHERE thread_id=$1", [chatThread.id])).rows[0];
    if (Number(quota.bytes) + originalSize > uploadRules.MAX_THREAD_BYTES) throw fail("Chat file quota exceeded.", 413);
    const uploaded = await storeUpload('chat', buffer, mime);
    const finalMime = uploaded.mimeType;
    if (finalMime === 'image/webp') safeName = safeName.replace(/\.[^.]+$/, '') + '.webp';
    const initialStatus = uploaded.byteSize < originalSize ? 'compressed' : 'pending';
    if (!isAdmin) {
      await require('./shopping-chat-ai-first').offerHandoff(c, chatThread.id, 'attachment', 'Nhân viên GAERU có thể xem tệp và hỗ trợ bạn. Chọn Gặp nhân viên để kết nối.');
    }
    const message = (await c.query(
      'INSERT INTO shopping_chat_messages(thread_id,sender,body,request_key) VALUES($1,$2,$3,$4) RETURNING id',
      [chatThread.id, isAdmin ? 'admin' : 'customer', 'Tệp đính kèm: ' + safeName, requestKey]
    )).rows[0];
    fileRecord = (await c.query(
      `INSERT INTO shopping_chat_files(message_id,thread_id,name,mime,content,byte_size,original_byte_size,compressed_byte_size,compression_status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, name, mime, byte_size, original_byte_size, compressed_byte_size, compression_status`,
      [message.id, chatThread.id, safeName, finalMime, uploaded.content, uploaded.byteSize, originalSize, uploaded.byteSize, initialStatus]
    )).rows[0];
    await c.query(
      'UPDATE shopping_chat_threads SET version=version+1,awaiting_admin=$2,updated_at=now() WHERE id=$1',
      [chatThread.id, !isAdmin && chatThread.handling_mode === 'human']
    );
    if (isAdmin) {
      await require('./audit').appendAudit(c, {
        actor: adminActor,
        action: 'shopping.chat.file',
        entityType: 'shopping_chat',
        entityId: chatThread.id,
        metadata: { size: originalSize, storedSize: uploaded.byteSize }
      });
    }
  };
  if (client) await persist(client);
  else await withTransaction(pool, persist);
  return fileRecord;
}

function attachShoppingChat({publicApi,admin,pool,config,owns,wrap,limit}) {
  const uploadGate = uploadRules.createUploadGate(2);
  const uploadWrap = handler => uploadRules.withUploadWork(wrap(handler));
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: uploadRules.MAX_FILE_BYTES, files: 1, fields: 8, fieldSize: 2048 }
  }).single('file');
  const parseUpload = (req,res,next)=>upload(req,res,error=>error?res.status(400).json({error:'Không thể đọc tệp tải lên. Vui lòng thử lại.'}):next());
  const authorize = isAdmin => wrap(async(req,res,next)=>{
    const id=z.string().uuid().parse(req.params.id);
    const row=isAdmin?(await pool.query('SELECT * FROM shopping_chat_threads WHERE id=$1',[id])).rows[0]:(await owns(req,id)).rows[0];
    if(!row)throw fail('Không tìm thấy hội thoại.',404);
    req.chatThread=row;
    next();
  });

  const save = isAdmin => uploadWrap(async(req,res)=>{
    const key=z.string().uuid().parse(req.body.requestKey);
    const mime=fileType(req.file);
    if(!mime)throw fail('Chỉ nhận JPG, PNG, WebP, GIF, HEIC, MP4, MOV, WebM, MKV, AVI, PDF, Word, Excel, PowerPoint, ZIP, TXT hoặc CSV hợp lệ.');
    const fileRecord = await persistChatFile({
      pool,
      chatThread: req.chatThread,
      isAdmin,
      adminActor: req.admin,
      requestKey: key,
      originalName: req.file.originalname,
      buffer: req.file.buffer,
      mime
    });
    res.status(201).json({
      message: 'Đã gửi tệp.',
      file: fileRecord ? {
        id: fileRecord.id,
        name: fileRecord.name,
        mime: fileRecord.mime,
        size: Number(fileRecord.byte_size),
        originalSize: Number(fileRecord.original_byte_size),
        compressedSize: Number(fileRecord.compressed_byte_size),
        compressionStatus: fileRecord.compression_status
      } : null
    });
  });

  const chunkSchema = z.object({
    requestKey: z.string().uuid(),
    fileName: z.string().trim().min(1).max(180),
    chunkIndex: z.coerce.number().int().min(0).max(uploadRules.MAX_CHUNKS-1),
    totalChunks: z.coerce.number().int().min(1).max(uploadRules.MAX_CHUNKS),
    totalBytes: z.coerce.number().int().min(1).max(uploadRules.MAX_FILE_BYTES)
  });

  const saveChunk = isAdmin => uploadWrap(async(req,res)=>{
    const meta = chunkSchema.parse(req.body);
    const result = await withTransaction(pool, client => receiveChunk(client, {
      thread: req.chatThread, isAdmin, meta, buffer: req.file?.buffer, detectType: fileType,
      persist: (transaction, buffer, mime) => persistChatFile({
        pool, client: transaction, chatThread: req.chatThread, isAdmin,
        adminActor: req.admin, requestKey: meta.requestKey,
        originalName: meta.fileName, buffer, mime
      })
    }));
    const file = result.file;
    res.status(result.status === 'completed' ? 201 : 202).json({
      ...result,
      ...(file ? {file: {id:file.id,name:file.name,mime:file.mime,size:Number(file.byte_size)}} : {})
    });
  });

  const compressRoute = uploadWrap(async(_req,res)=>{
    const processed = await processChatCompression(pool);
    res.json({ processed });
  });

  const download = wrap(async(req,res)=>{
    const id=z.string().uuid().parse(req.params.fileId);
    const file=(await pool.query("SELECT name,mime,content,deleted_at,(created_at<=now()-interval '30 days') AS expired FROM shopping_chat_files WHERE id=$1 AND thread_id=$2",[id,req.chatThread.id])).rows[0];
    if(!file)throw fail('Không tìm thấy tệp.',404);
    if(file.deleted_at||file.expired)throw fail('Tệp đã bị xóa hoặc đã hết hạn lưu trữ 30 ngày.',410);
    const inline=['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/quicktime','video/webm'].includes(file.mime)&&req.query.download!=='1';
    const content=await readMedia(file.content),headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Type':file.mime,'Content-Disposition':(inline?'inline':'attachment')+"; filename=download; filename*=UTF-8''"+encodeURIComponent(file.name),'Content-Security-Policy':"sandbox; default-src 'none'"};
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

  publicApi.post('/threads/:id/files',requireCsrf,limit,authorize(false),uploadGate,parseUpload,save(false));
  publicApi.post('/threads/:id/files/chunk',requireCsrf,limit,authorize(false),uploadGate,parseUpload,saveChunk(false));
  publicApi.post('/threads/:id/files/compress',requireCsrf,limit,authorize(false),uploadGate,compressRoute);
  publicApi.get('/threads/:id/files/:fileId',authorize(false),download);

  admin.post('/shopping-chat/:id/files',requirePermission('customers.write'),requireCsrf,limit,authorize(true),uploadGate,parseUpload,save(true));
  admin.post('/shopping-chat/:id/files/chunk',requirePermission('customers.write'),requireCsrf,limit,authorize(true),uploadGate,parseUpload,saveChunk(true));
  admin.post('/shopping-chat/:id/files/compress',requirePermission('customers.write'),requireCsrf,limit,authorize(true),uploadGate,compressRoute);
  admin.get('/shopping-chat/:id/files/:fileId',authorize(true),download);
  admin.delete('/shopping-chat/:id/files/:fileId',requirePermission('chat.files.delete'),requireCsrf,authorize(true),wrap(async(req,res)=>{
    const fileId=z.string().uuid().parse(req.params.fileId);
    const result=await require('./shopping-chat-file-retention').deleteChatFile(pool,{id:fileId,threadId:req.chatThread.id,actor:req.admin,confirm:req.body?.confirm});
    res.json({...result,message:result.preserved?'Đã xóa khỏi hội thoại; bản dùng chung khác được giữ lại.':'Đã xóa tệp khỏi hội thoại.'});
  }));

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
  publicApi.post('/threads/:id/resume-ai',requireCsrf,limit,authorize(false),wrap(async(req,res)=>{
    const resumed=await withTransaction(pool,c=>require('./shopping-chat-ai-first').resumeAI(c,req.chatThread.id,'staff_timeout'));
    if(resumed)require('./shopping-chat-ai-first').kickAIChatWorker();
    res.json({resumed,handlingMode:'ai',message:'Đã kích hoạt lại hỗ trợ bằng AI.'});
  }));
  publicApi.post('/threads/:id/close',requireCsrf,limit,authorize(false),wrap(async(req,res)=>{
    await withTransaction(pool,async c=>{
      await c.query("UPDATE shopping_chat_threads SET status='closed',awaiting_admin=false,version=version+1,updated_at=now() WHERE id=$1",[req.chatThread.id]);
      await c.query("UPDATE shopping_chat_ai_jobs SET status='skipped' WHERE thread_id=$1 AND status='pending'",[req.chatThread.id]);
    });
    res.json({message:'Đã kết thúc phiên chat.',status:'closed'});
  }));
  publicApi.get('/capabilities',wrap(async(_req,res)=>{const settings=await require('./chat-ai-provider').getChatAIConfig(pool,config);res.json({aiConfigured:Boolean(settings.enabled&&settings.apiKey),provider:settings.enabled?settings.provider:null,maxFileBytes:uploadRules.MAX_FILE_BYTES,unlimitedFileSize:true,chunkSizeBytes:4194304,backgroundCompression:true});}));
  publicApi.post('/threads/:id/ai',requireCsrf,limit,authorize(false),(_req,res)=>res.status(409).json({error:'AI đang trả lời tự động. Bạn có thể chọn Gặp nhân viên để chuyển hỗ trợ.'}));
}
module.exports={attachShoppingChat,fileType,answerAI};
