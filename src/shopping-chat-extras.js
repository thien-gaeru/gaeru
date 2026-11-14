const {pipeline}=require('node:stream/promises');
const mediaFilesystem=require('./lib/filesystem-media');
const {storeUpload,storeStagedMedia,readMedia,readMediaRange,openMediaStream}=require('./lib/stored-media');
const {processChatCompression,triggerManualChatCompression}=require('./shopping-chat-compression');
const multer = require('multer');
const uploadRules = require('./audit-fixes/upload-state');
const { receiveChunk } = require('./audit-fixes/upload-session');
const { z } = require('zod');
const { requireCsrf } = require('./security');
const { requirePermission } = require('./staff-access');
const { withTransaction } = require('./db');
const fail = (message, status = 400) => Object.assign(Error(message), { status });

function hasPdfMagic(b) {
  const probe = b.subarray(0, Math.min(b.length, 64)).toString('latin1').replace(/^(?:\xEF\xBB\xBF|[\s\0])+/, '');
  return probe.startsWith('%PDF-');
}
function hasMp3Magic(b) {
  if (b.subarray(0, 2).toString('ascii') === 'MZ') return false;
  if (b.length >= 3 && b.toString('ascii', 0, 3) === 'ID3') return true;
  const maxScan = Math.min(b.length - 3, 4096);
  for (let i = 0; i <= maxScan; i++) {
    if (b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0 && (b[i + 1] & 0x18) !== 0x08 && (b[i + 1] & 0x06) !== 0x00 && (b[i + 2] & 0xf0) !== 0xf0) {
      return true;
    }
  }
  return false;
}
function isSafePlainText(b) {
  if (!b?.length) return false;
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return true; // UTF-16 BOM
  if (b.includes(0)) return false;
  if (b.subarray(0, 2).toString('ascii') === 'MZ' || b.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return false;
  const sample = b.subarray(0, Math.min(b.length, 4096));
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
  }
  return true;
}
function detectSafeImageMagic(b) {
  if (!b?.length) return null;
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif';
  if (b[0] === 66 && b[1] === 77) return 'image/bmp';
  if (b.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || b.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))) return 'image/tiff';
  if (b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'heif', 'mif1', 'mif2', 'msf1', 'heim', 'heis', 'hevm', 'hevs', 'miaf', 'avci', 'avcs'].includes(brand)) return 'image/heic';
  }
  return null;
}
function fileType(file) {
  const b = file?.buffer;
  if (!b?.length) return null;
  const name = String(file.originalname || '').trim();
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1;
  const ext = hasExt ? name.slice(dot + 1).toLowerCase() : '';
  if (!hasExt) {
    const imgMime = detectSafeImageMagic(b);
    if (imgMime) return imgMime;
    if (hasPdfMagic(b)) return 'application/pdf';
    if (b.toString('ascii', 4, 8) === 'ftyp') {
      const brand = b.toString('ascii', 8, 12);
      if (['avif', 'avis', 'mif1'].includes(brand)) return 'image/avif';
      if (['heic', 'heix', 'hevc', 'hevx', 'heif', 'mif2', 'msf1', 'heim', 'heis', 'hevm', 'hevs', 'miaf', 'avci', 'avcs'].includes(brand)) return 'image/heic';
      if (brand === 'qt  ') return 'video/quicktime';
      if (brand === 'M4A ') return 'audio/mp4';
      return 'video/mp4';
    }
    if (b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'video/webm';
    if (b.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
    return null;
  }
  if (['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif'].includes(ext)) {
    const imgMime = detectSafeImageMagic(b);
    if (imgMime) {
      if (ext === 'avif' && b.toString('ascii', 4, 8) === 'ftyp' && b.toString('ascii', 8, 12) === 'mif1') return 'image/avif';
      return imgMime;
    }
  }
  if (ext === 'pdf' && hasPdfMagic(b)) return 'application/pdf';
  if (['mp4', 'mov', 'm4v', '3gp', 'webm', 'mkv'].includes(ext)) {
    const atom = b.length >= 8 ? b.toString('ascii', 4, 8) : '';
    const boxSize = b.length >= 4 ? b.readUInt32BE(0) : 0;
    if (atom === 'ftyp' || (['mov', 'mp4', 'm4v'].includes(ext) && boxSize >= 8 && ['wide', 'free', 'moov', 'mdat', 'skip'].includes(atom))) {
      return ext === 'mov' ? 'video/quicktime' : 'video/mp4';
    }
    if (b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'video/webm';
  }
  if (ext === 'weba' && b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'audio/webm';
  if (ext === 'avi' && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 11) === 'AVI') return 'video/mp4';
  if (ext === 'mp3' && hasMp3Magic(b)) return 'audio/mpeg';
  if (['m4a', 'aac'].includes(ext) && (b.toString('ascii', 4, 8) === 'ftyp' || hasMp3Magic(b) || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xf0) === 0xf0))) return 'audio/mp4';
  if (ext === 'wav' && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (['ogg', 'opus', 'oga'].includes(ext) && b.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (['docx', 'xlsx', 'pptx', 'zip'].includes(ext) && (b.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) || b.subarray(0, 4).equals(Buffer.from([80, 75, 5, 6])) || b.subarray(0, 4).equals(Buffer.from([80, 75, 7, 8])))) return 'application/octet-stream';
  if (['doc', 'xls', 'ppt'].includes(ext) && b.subarray(0, 8).equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]))) return 'application/octet-stream';
  if (ext === 'rar' && b.subarray(0, 6).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]))) return 'application/octet-stream';
  if (ext === '7z' && b.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return 'application/octet-stream';
  if (['txt', 'csv', 'log', 'md'].includes(ext) && isSafePlainText(b)) return 'text/plain';
  if (ext === 'json' && !b.includes(0) && !b.toString('utf8').includes('\uFFFD') && /^[\s\uFEFF]*[{[]/.test(b.toString('utf8', 0, Math.min(b.length, 512)))) return 'application/json';
  if (ext === 'xml' && !b.includes(0) && !b.toString('utf8').includes('\uFFFD') && /^[\s\uFEFF]*</.test(b.toString('utf8', 0, Math.min(b.length, 512)))) return 'application/xml';
  return null;
}

async function answerAI({config,product,question,decision=false,transport=fetch}) {
  const settings=config.chatAI||{provider:'openai',apiKey:config.OPENAI_API_KEY,model:config.OPENAI_CHAT_MODEL||'gpt-4.1-mini',enabled:Boolean(config.OPENAI_API_KEY)};
  return require('./chat-ai-provider').generate({settings,product,question,decision,transport});
}

async function persistChatFile({pool,chatThread,isAdmin,adminActor,requestKey,originalName,buffer=null,mime,client=null,staged=null,rollbackTasks=null,commitTasks=null}) {
  const originalSize = staged ? staged.totalBytes : (Buffer.isBuffer(buffer) ? buffer.length : 0);
  if (!Number.isSafeInteger(originalSize) || originalSize < 1 || originalSize > uploadRules.MAX_FILE_BYTES) {
    throw fail("File exceeds upload limit (" + Math.round(uploadRules.MAX_FILE_BYTES / 1048576) + " MiB).", 413);
  }
  let safeName = String(originalName || 'attachment').replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180);
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
    const uploaded = staged
      ? await storeStagedMedia('chat', staged.stageId, staged.mime || mime, originalSize)
      : await storeUpload('chat', buffer, mime);
    if (staged) {
      if (Array.isArray(rollbackTasks) && typeof uploaded.rollback === 'function') rollbackTasks.push(uploaded.rollback);
      if (Array.isArray(commitTasks) && typeof uploaded.finish === 'function') commitTasks.push(uploaded.finish);
    }
    const finalMime = uploaded.mimeType;
    if (finalMime === 'image/webp') safeName = safeName.replace(/\.[^.]+$/, '') + '.webp';
    const skipBgCompress = /^(video|audio)\//i.test(finalMime) || (originalSize > 25 * 1024 * 1024 && !['image/jpeg', 'image/png', 'image/heic', 'image/avif'].includes(finalMime));
    const initialStatus = uploaded.byteSize < originalSize ? 'compressed' : (skipBgCompress ? 'optimal' : 'pending');
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
  else await withTransaction(pool, persist); try{require('./realtime-sse').publishChatEvent(chatThread.id,'chat:message',{threadId:chatThread.id,sender:isAdmin?'admin':'customer',body:'Tệp đính kèm: '+safeName,fileId:fileRecord?.id});}catch(_){}
  return fileRecord;
}

function logUploadReject(stage, req, detail = {}) {
  try {
    console.warn('[shopping-chat-upload-reject]', JSON.stringify({
      stage,
      method: req?.method || '',
      path: req?.originalUrl || req?.url || '',
      threadId: req?.params?.id || null,
      isAdmin: Boolean(req?.admin || req?.session?.admin),
      ua: String(req?.get?.('user-agent') || '').slice(0, 80),
      ...detail
    }));
  } catch (_) {}
}

function attachShoppingChat({publicApi,admin,pool,config,owns,wrap,limit,chunkLimit}) {
  const uploadLimit = chunkLimit || limit;
  const uploadGate = uploadRules.createUploadGate(4);
  const uploadWrap = handler => uploadRules.withUploadWork(wrap(handler));
  const chatCsrf = (req, res, next) => requireCsrf(req, {
    status(code) {
      if (code === 403) logUploadReject('csrf', req, {
        hasSessionCsrf: Boolean(req.session?.csrfToken),
        hasHeaderCsrf: Boolean(req.get?.('x-csrf-token')),
        hasCookie: Boolean(req.headers?.cookie),
        hasOwner: Boolean(req.session?.shoppingChatOwner)
      });
      res.status(code);
      return this;
    },
    json: body => res.json(body)
  }, next);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.min(uploadRules.MAX_FILE_BYTES, 25 * 1024 * 1024), files: 1, fields: 12, fieldSize: 8192 }
  }).single('file');
  const parseUpload = (req,res,next)=>upload(req,res,error=>{
    if(error){
      logUploadReject('multer', req, { code: error.code || null, field: error.field || null, message: error.message || null });
      if(error.code === 'LIMIT_FILE_SIZE'){
        return res.status(413).json({error:'Tệp gửi một lần vượt quá 25 MiB. Vui lòng gửi theo từng phần (/files/chunk).'});
      }
      return res.status(400).json({error:'Không thể đọc tệp tải lên. Vui lòng thử lại.'});
    }
    next();
  });
  const authorize = isAdmin => wrap(async(req,res,next)=>{
    const id=z.string().uuid().parse(req.params.id);
    const row=isAdmin?(await pool.query('SELECT * FROM shopping_chat_threads WHERE id=$1',[id])).rows[0]:(await owns(req,id)).rows[0];
    if(!row){
      logUploadReject('authorize_not_found', req, { isAdmin, hasOwner: Boolean(req.session?.shoppingChatOwner), hasCustomer: Boolean(req.session?.customer?.id) });
      throw fail('Không tìm thấy hội thoại.',404);
    }
    req.chatThread=row;
    next();
  });

  const save = isAdmin => uploadWrap(async(req,res)=>{
    let key;
    try{ key=z.string().uuid().parse(req.body.requestKey); }
    catch(e){
      logUploadReject('save_schema', req, { requestKey: String(req.body?.requestKey||'').slice(0, 40) });
      throw e;
    }
    const mime=fileType(req.file);
    if(!mime){
      logUploadReject('unsupported_mime', req, {
        fileName: String(req.file?.originalname || '').slice(0, 120),
        mimetype: String(req.file?.mimetype || ''),
        size: req.file?.buffer?.length || 0,
        magicHex: req.file?.buffer ? req.file.buffer.subarray(0, 16).toString('hex') : ''
      });
      throw fail('Chỉ nhận JPG, PNG, WebP, GIF, AVIF, HEIC, MP4, MOV, WebM, MKV, AVI, MP3, M4A, WAV, OGG, PDF, Word, Excel, PowerPoint, ZIP, RAR, 7Z, TXT, CSV, JSON hoặc XML hợp lệ.');
    }
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
    let meta;
    try{
      meta = chunkSchema.parse(req.body);
    }catch(err){
      logUploadReject('chunk_schema', req, {
        fileName: String(req.body?.fileName || '').slice(0, 120),
        chunkIndex: req.body?.chunkIndex,
        totalChunks: req.body?.totalChunks,
        totalBytes: req.body?.totalBytes
      });
      throw err;
    }
    let result;
    const rollbackTasks = [];
    const commitTasks = [];
    try{
      result = await withTransaction(pool, client => receiveChunk(client, {
        thread: req.chatThread, isAdmin, meta, buffer: req.file?.buffer, detectType: fileType,
        stageToDisk: mediaFilesystem.configured(),
        rollbackTasks,
        commitTasks,
        persist: (transaction, buffer, mime) => persistChatFile({
          pool, client: transaction, chatThread: req.chatThread, isAdmin,
          adminActor: req.admin, requestKey: meta.requestKey,
          originalName: meta.fileName, buffer, mime
        }),
        persistStaged: (transaction, staged) => persistChatFile({
          pool, client: transaction, chatThread: req.chatThread, isAdmin,
          adminActor: req.admin, requestKey: meta.requestKey,
          originalName: meta.fileName, mime: staged.mime, staged, rollbackTasks, commitTasks
        })
      }));
    }catch(err){
      for (const fn of rollbackTasks) await fn().catch(() => {});
      logUploadReject('chunk_reject', req, {
        status: err?.status || 500,
        reason: err?.message || 'unknown',
        fileName: meta.fileName,
        chunkIndex: meta.chunkIndex,
        totalChunks: meta.totalChunks,
        totalBytes: meta.totalBytes,
        mimetype: String(req.file?.mimetype || ''),
        chunkSize: req.file?.buffer?.length || 0,
        magicHex: meta.chunkIndex === 0 && req.file?.buffer ? req.file.buffer.subarray(0, 16).toString('hex') : ''
      });
      throw err;
    }
    for (const fn of commitTasks) await fn().catch(() => {});
    const file = result.file;
    res.status(result.status === 'completed' ? 201 : 202).json({
      ...result,
      ...(file ? {file: {id:file.id,name:file.name,mime:file.mime,size:Number(file.byte_size)}} : {})
    });
  });

  const compressRoute = wrap(async(req,res)=>{
    const result = await triggerManualChatCompression(pool, {
      threadId: req.chatThread?.id || null,
      limit: 2
    });
    res.json(result);
  });

  const download = wrap(async(req,res)=>{
    const id=z.string().uuid().parse(req.params.fileId);
    const file=(await pool.query("SELECT name,mime,content,original_content,original_mime,original_name,deleted_at,(created_at<=now()-interval '30 days') AS expired FROM shopping_chat_files WHERE id=$1 AND thread_id=$2",[id,req.chatThread.id])).rows[0];
    if(!file)throw fail('Không tìm thấy tệp.',404);
    if(file.deleted_at||file.expired)throw fail('Tệp đã bị xóa hoặc đã hết hạn lưu trữ 30 ngày.',410);
    if(req.query.original==='1'&&file.original_content){file.content=file.original_content;file.mime=file.original_mime||file.mime;file.name=file.original_name||file.name;}
    const inline=(['image/jpeg','image/png','image/webp','image/gif','image/avif','video/mp4','video/quicktime','video/webm','audio/mpeg','audio/mp4','audio/wav','audio/ogg','audio/webm'].includes(file.mime)||(file.mime==='application/pdf'&&req.query.preview==='1'))&&req.query.download!=='1';
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Type':file.mime,'Content-Disposition':(inline?'inline':'attachment')+"; filename=download; filename*=UTF-8''"+encodeURIComponent(file.name),'Content-Security-Policy':"sandbox; default-src 'none'"};
    const isMediaStream = inline&&(file.mime.startsWith('video/')||file.mime.startsWith('audio/'));
    if(isMediaStream) headers['Accept-Ranges']='bytes';
    const range = isMediaStream ? req.headers.range : null;
    const streamInfo = await openMediaStream(file.content, range || null);
    if(streamInfo){
      if(streamInfo.invalidRange){
        return res.set({...headers,'Content-Range':'bytes */'+streamInfo.totalSize}).status(416).end();
      }
      if(!streamInfo.compressed && streamInfo.stream){
        if(streamInfo.totalSize > 10 * 1024 * 1024){ req.setTimeout?.(0); res.setTimeout?.(0); }
        if(range){
          res.set({...headers,'Content-Range':`bytes ${streamInfo.start}-${streamInfo.end}/${streamInfo.totalSize}`,'Content-Length':String(streamInfo.end-streamInfo.start+1)}).status(206);
        }else{
          res.set({...headers,'Content-Length':String(streamInfo.totalSize)}).status(200);
        }
        try{ await pipeline(streamInfo.stream, res); }
        catch(err){ if(err?.code!=='ERR_STREAM_PREMATURE_CLOSE'&&err?.code!=='ECONNRESET') throw err; }
        return;
      }
    }
    if(isMediaStream&&range){
      const slice=await readMediaRange(file.content,range);
      if(slice.invalidRange)return res.set({...headers,'Content-Range':'bytes */'+slice.totalSize}).status(416).end();
      return res.set({...headers,'Content-Range':`bytes ${slice.start}-${slice.end}/${slice.totalSize}`,'Content-Length':String(slice.buffer.length)}).status(206).send(slice.buffer);
    }
    const content=await readMedia(file.content);
    res.set(headers).send(content);
  });

  publicApi.post('/threads/:id/files',chatCsrf,limit,authorize(false),uploadGate,parseUpload,save(false));
  publicApi.post('/threads/:id/files/chunk',chatCsrf,uploadLimit,authorize(false),uploadGate,parseUpload,saveChunk(false));
  publicApi.post('/threads/:id/files/compress',chatCsrf,limit,authorize(false),compressRoute);
  publicApi.get('/threads/:id/files/:fileId',authorize(false),download);

  admin.post('/shopping-chat/:id/files',requirePermission('customers.write'),chatCsrf,limit,authorize(true),uploadGate,parseUpload,save(true));
  admin.post('/shopping-chat/:id/files/chunk',requirePermission('customers.write'),chatCsrf,uploadLimit,authorize(true),uploadGate,parseUpload,saveChunk(true));
  admin.post('/shopping-chat/:id/files/compress',requirePermission('customers.write'),chatCsrf,limit,authorize(true),compressRoute);
  admin.get('/shopping-chat/:id/files/:fileId',authorize(true),download);
  admin.delete('/shopping-chat/:id/files/:fileId',requirePermission('chat.files.delete'),requireCsrf,authorize(true),wrap(async(req,res)=>{
    const fileId=z.string().uuid().parse(req.params.fileId);
    const result=await require('./shopping-chat-file-retention').deleteChatFile(pool,{id:fileId,threadId:req.chatThread.id,actor:req.admin,confirm:req.body?.confirm});
    res.json({...result,message:result.preserved?'Đã xóa khỏi hội thoại; bản dùng chung khác được giữ lại.':'Đã xóa tệp khỏi hội thoại.'});
  }));

  admin.get('/shopping-chat/:id/offers',(req,res,next)=>{
    if(!req.admin?.permissions.some(p=>['marketing.read','orders.read'].includes(p))){
      return res.status(403).json({error:'Tài khoản không có quyền truy cập chức năng này.'});
    }
    next();
  },authorize(true),wrap(async(req,res)=>{
    const kind=z.enum(['vouchers','campaigns','orders']).parse(req.query.kind),page=z.coerce.number().int().min(1).max(10000).parse(req.query.page||1);
    if(['vouchers','campaigns'].includes(kind)&&!req.admin?.permissions.includes('marketing.read')){
      return res.status(403).json({error:'Tài khoản không có quyền xem thông tin khuyến mại.'});
    }
    if(kind==='orders'&&!req.admin?.permissions.includes('orders.read')){
      return res.status(403).json({error:'Tài khoản không có quyền xem đơn hàng.'});
    }
    const money=n=>new Intl.NumberFormat('vi-VN').format(n)+' ₫';
    const date=d=>new Date(d).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'});
    let items;
    if(kind==='vouchers'){
      const rows=(await pool.query(`SELECT v.* FROM marketing_vouchers v WHERE v.active=true AND now() BETWEEN v.starts_at AND v.ends_at AND (v.public_claim=true OR EXISTS(SELECT 1 FROM customer_vouchers w WHERE w.voucher_id=v.id AND w.customer_id=$1)) AND (SELECT count(*) FROM voucher_redemptions r WHERE r.voucher_id=v.id AND r.released=false)<v.total_limit AND (SELECT count(*) FROM voucher_redemptions r WHERE r.voucher_id=v.id AND r.customer_id=$1 AND r.released=false)<v.per_customer_limit ORDER BY v.created_at DESC,v.id LIMIT 25 OFFSET $2`,[req.chatThread.customer_id,(page-1)*25])).rows;
      items=rows.map(v=>({id:v.id,title:v.code+' · '+v.title,text:'Voucher '+v.code+' — '+v.title+'\nGiảm '+(v.kind==='percent'?v.amount+'%':money(v.amount))+(v.max_discount_vnd?' (tối đa '+money(v.max_discount_vnd)+')':'')+'\nĐơn sản phẩm từ '+money(v.min_spend_vnd)+' · Mỗi khách tối đa '+v.per_customer_limit+' lượt.\nHiệu lực đến '+date(v.ends_at)+' (giờ Việt Nam).\nĐăng nhập để lưu/kiểm tra điều kiện tại Tài khoản → Ví voucher & ưu đãi. Không giảm phí giao hàng; áp dụng theo điều kiện và lượt còn lại khi thanh toán.'}));
    }else if(kind==='campaigns'){
      const rows=(await pool.query('SELECT id,title,body,ends_at FROM marketing_campaigns WHERE active=true AND now() BETWEEN starts_at AND ends_at ORDER BY created_at DESC,id LIMIT 25 OFFSET $1',[(page-1)*25])).rows;
      items=rows.map(c=>({id:c.id,title:c.title,text:'Chương trình: '+c.title+'\n'+c.body.slice(0,2400)+'\nHiệu lực đến '+date(c.ends_at)+' (giờ Việt Nam).\nXem chương trình trong Tài khoản → Ví voucher & ưu đãi.'}));
    }else{
      const customerId=req.chatThread.customer_id;
      const isBootstrapOwner=Boolean(req.admin?.source==='bootstrap'&&(req.admin?.isOwner||req.admin?.role==='owner'));
      const orderSelect=`SELECT o.id, o.order_number, o.customer_name, o.phone, o.email, o.address, o.city,
               o.status, o.payment_method, o.payment_status, o.total_vnd, o.created_at,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('name', i.product_name, 'variant', i.variant_name, 'quantity', i.quantity, 'lineTotalVnd', i.line_total_vnd))
                 FROM order_items i WHERE i.order_id = o.id), '[]'::jsonb) AS items
             FROM orders o`;
      const rows=customerId
        ?(await pool.query(
            `${orderSelect}
             WHERE o.customer_id = $1
             ORDER BY o.created_at DESC, o.id DESC LIMIT 25 OFFSET $2`,
            [customerId, (page - 1) * 25]
          )).rows
        :isBootstrapOwner
          ?(await pool.query(
              `${orderSelect}
               ORDER BY o.created_at DESC, o.id DESC LIMIT 25 OFFSET $1`,
              [(page - 1) * 25]
            )).rows
          :[];

      const statusLabels={pending:'Chờ xác nhận',confirmed:'Đã xác nhận',processing:'Đang chuẩn bị',shipped:'Đang giao hàng',completed:'Hoàn tất',cancelled:'Đã hủy'};
      const paymentLabels={pending:'Chưa thanh toán',paid:'Đã thanh toán'};
      items=rows.map(o=>{
        const st=statusLabels[o.status]||o.status;
        const pay=paymentLabels[o.payment_status]||o.payment_status;
        const total=o.total_vnd!=null?money(o.total_vnd):'Chưa chốt';
        const title=`Đơn ${o.order_number} · ${total} (${st} · ${date(o.created_at)})`;
        const itemsList=(Array.isArray(o.items)&&o.items.length)
          ?o.items.map(it=>`+ ${it.name}${it.variant?' · '+it.variant:''} × ${it.quantity} (${money(it.lineTotalVnd)})`).join('\n')
          :'';
        const text=`Thông tin đơn hàng ${o.order_number}:\n`+
          `- Trạng thái: ${st} (Thanh toán: ${pay})\n`+
          `- Người nhận: ${o.customer_name||'Khách hàng'} · ${o.phone||''}\n`+
          (o.address?`- Địa chỉ: ${o.address}${o.city?', '+o.city:''}\n`:'')+
          `- Tổng thanh toán: ${total}\n`+
          (itemsList?`- Mặt hàng:\n${itemsList}\n`:'')+
          `Nhân viên GAERU luôn sẵn sàng hỗ trợ nếu bạn cần điều chỉnh hoặc theo dõi đơn.`;
        return {id:o.id,title,text};
      });
    }
    res.set('Cache-Control','no-store').json({items,page,hasMore:items.length===25});
  }));
  publicApi.post('/threads/:id/handoff',requireCsrf,limit,authorize(false),wrap(async(req,res)=>{await withTransaction(pool,c=>require('./shopping-chat-ai-first').handoff(c,req.chatThread.id,'customer_request'));try{require('./realtime-sse').publishChatEvent(req.chatThread.id,'chat:update',{threadId:req.chatThread.id,mode:'human'});}catch(_){}res.json({message:'Đã chuyển hội thoại cho nhân viên.'});}));
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
    try{require('./realtime-sse').publishChatEvent(req.chatThread.id,'chat:update',{threadId:req.chatThread.id,status:'closed'});}catch(_){} res.json({message:'Đã kết thúc phiên chat.',status:'closed'});
  }));
  publicApi.get('/capabilities',wrap(async(_req,res)=>{const settings=await require('./chat-ai-provider').getChatAIConfig(pool,config);res.json({aiConfigured:Boolean(settings.enabled&&settings.apiKey),gaeruAi:true,gaeruAiVersion:'2.0',provider:settings.enabled?settings.provider:'gaeru-ai',maxFileBytes:uploadRules.MAX_FILE_BYTES,maxChunkBytes:uploadRules.MAX_CHUNK_BYTES,maxChunks:uploadRules.MAX_CHUNKS,unlimitedFileSize:true,chunkSizeBytes:2097152,backgroundCompression:true});}));
  publicApi.post('/threads/:id/ai',requireCsrf,limit,authorize(false),(_req,res)=>res.status(409).json({error:'AI đang trả lời tự động. Bạn có thể chọn Gặp nhân viên để chuyển hỗ trợ.'}));
}
module.exports={attachShoppingChat,fileType,answerAI};
