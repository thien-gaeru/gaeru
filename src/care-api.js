const { Router } = require('express');
const { z } = require('zod');
const multer = require('multer');
const { requireCsrf } = require('./security');
const { requirePermission } = require('./staff-access');
const { withTransaction } = require('./db');
const { appendAudit } = require('./audit');
const { storeUpload, readMedia } = require('./lib/stored-media');

const fields = 'c.id,c.order_id AS "orderId",COALESCE(o.order_number,c.external_order_number) AS "orderNumber",c.channel,c.subject,c.description,c.status,c.response,c.version,c.created_at AS "createdAt",c.updated_at AS "updatedAt"';

const createSchema = z.object({
  orderId: z.string().uuid().optional(),
  channel: z.enum(['website', 'shopee', 'tiktok', 'lazada']).default('website'),
  externalOrderNumber: z.string().trim().min(3).max(100).optional(),
  requestKey: z.string().uuid(),
  subject: z.string().trim().min(5).max(160),
  description: z.string().trim().min(15).max(3000)
}).strict().superRefine((a, c) => {
  if (a.channel === 'website' ? (!a.orderId || a.externalOrderNumber !== undefined) : (!a.externalOrderNumber || a.orderId !== undefined)) {
    c.addIssue({ code: 'custom', message: 'Chọn đơn website hoặc nhập mã đơn của sàn tương ứng.' });
  }
});

function fileType(file) {
  const b = file?.buffer;
  if (!b?.length) return null;
  const ext = String(file.originalname || '').split('.').pop().toLowerCase();
  if (['jpg', 'jpeg'].includes(ext) && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (ext === 'png' && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (ext === 'webp' && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (ext === 'gif' && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif';
  if (ext === 'pdf' && b.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (['mp4', 'mov', 'm4v'].includes(ext) && b.toString('ascii', 4, 8) === 'ftyp') return ext === 'mov' ? 'video/quicktime' : 'video/mp4';
  if (['heic', 'heif'].includes(ext) && b.toString('ascii', 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(b.toString('ascii', 8, 12))) return 'image/heic';
  if (['webm', 'mkv'].includes(ext) && b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'video/webm';
  if (ext === 'avi' && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 11) === 'AVI') return 'video/mp4';
  if (['docx', 'xlsx', 'pptx', 'zip'].includes(ext) && b.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) return 'application/octet-stream';
  if (['doc', 'xls', 'ppt'].includes(ext) && b.subarray(0, 8).equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]))) return 'application/octet-stream';
  if (['txt', 'csv'].includes(ext) && !b.includes(0) && !b.toString('utf8').includes('\uFFFD')) return 'text/plain';
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 8, fieldSize: 2048 }
}).single('file');

const parseUpload = (req, res, next) => upload(req, res, error => {
  if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Tệp vượt quá kích thước 10MB cho phép.' : 'Không thể đọc tệp tải lên. Vui lòng thử lại.' });
  next();
});

async function serveCareFile(res, req, file) {
  const inline = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm'].includes(file.mime) && req.query.download !== '1';
  const content = await readMedia(file.content);
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': file.mime,
    'Content-Disposition': (inline ? 'inline' : 'attachment') + "; filename=download; filename*=UTF-8''" + encodeURIComponent(file.name),
    'Content-Security-Policy': "sandbox; default-src 'none'"
  };
  if (inline && file.mime.startsWith('video/')) {
    headers['Accept-Ranges'] = 'bytes';
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start, end;
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, content.length - Number(match[2]));
        end = match[1] ? (match[2] ? Number(match[2]) : content.length - 1) : content.length - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= content.length) {
        return res.set({ ...headers, 'Content-Range': 'bytes */' + content.length }).status(416).end();
      }
      end = Math.min(end, content.length - 1);
      return res.set({ ...headers, 'Content-Range': `bytes ${start}-${end}/${content.length}`, 'Content-Length': String(end - start + 1) }).status(206).send(content.subarray(start, end + 1));
    }
  }
  res.set(headers).send(content);
}

async function enqueueCareEmailNotification(client, careId, messageId, responseText, config) {
  try {
    const reqRow = (await client.query(`
      SELECT c.id AS customer_id, c.email, c.full_name, r.subject, r.channel,
             COALESCE(o.order_number, r.external_order_number) AS order_number
      FROM care_requests r
      JOIN customers c ON c.id=r.customer_id
      LEFT JOIN orders o ON o.id=r.order_id
      WHERE r.id=$1
    `, [careId])).rows[0];
    if (!reqRow || !reqRow.email) return;

    const pref = (await client.query('SELECT notify_on_response FROM care_email_preferences WHERE customer_id=$1', [reqRow.customer_id])).rows[0];
    if (pref && pref.notify_on_response === false) return;

    const base = (config?.PUBLIC_BASE_URL || config?.smtp?.publicBaseUrl || 'https://gaeru.com').replace(/\/+$/, '');
    const careUrl = base + '/care#care-request';
    const subject = `[GAERU CARE+] Phản hồi mới cho yêu cầu: ${reqRow.subject}`;
    const bodyText = `Xin chào ${reqRow.full_name},\n\nĐội ngũ GAERU CARE+ vừa gửi phản hồi cho yêu cầu hỗ trợ của bạn (Đơn hàng: ${reqRow.order_number || 'N/A'}, Mã yêu cầu: ${careId}):\n"${reqRow.subject}"\n\nNội dung phản hồi:\n${responseText}\n\nĐể xem toàn bộ lịch sử trao đổi hoặc gửi trả lời, bạn vui lòng truy cập trang CARE+:\n${careUrl}\n\nTrân trọng,\nĐội ngũ GAERU CARE+`;

    await client.query(`
      INSERT INTO care_email_outbox(care_id, message_id, customer_id, recipient_email, subject, body_text)
      VALUES($1, $2, $3, $4, $5, $6)
      ON CONFLICT (care_id, message_id) DO NOTHING
    `, [careId, messageId, reqRow.customer_id, reqRow.email, subject, bodyText]);
  } catch (err) {
    console.error('Failed to enqueue care email notification:', err.message);
  }
}

async function readMessages(pool, req, res) {
  const cursor = req.query.after ?? req.query.before, after = req.query.after !== undefined;
  if (req.query.after !== undefined && req.query.before !== undefined) return res.status(400).json({ error: 'Chỉ chọn một vị trí tin nhắn.' });
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^[1-9][0-9]{0,18}$/.test(cursor) || BigInt(cursor) > 9223372036854775807n)) return res.status(400).json({ error: 'Vị trí tin nhắn không hợp lệ.' });
  const thread = (await pool.query('SELECT version,status,response FROM care_requests WHERE id=$1', [req.params.id])).rows[0];
  if (!thread) return res.sendStatus(404);
  const rows = (await pool.query(
    `SELECT m.id::text, m.sender, m.body, m.created_at AS "createdAt",
            f.id AS "fileId", f.name AS "fileName", f.mime AS "fileMime", f.byte_size AS "fileSize"
     FROM care_messages m
     LEFT JOIN care_message_files f ON f.message_id = m.id
     WHERE m.care_id = $1 AND ($2::bigint IS NULL OR m.id ${after ? '>' : '<'} $2::bigint)
     ORDER BY m.id ${after ? 'ASC' : 'DESC'}
     LIMIT 51`,
    [req.params.id, cursor ?? null]
  )).rows;
  const rawMessages = rows.slice(0, 50);
  const messages = (after ? rawMessages : rawMessages.reverse()).map(m => ({
    id: m.id,
    sender: m.sender,
    body: m.body,
    createdAt: m.createdAt,
    file: m.fileId ? {
      id: m.fileId,
      name: m.fileName,
      mime: m.fileMime,
      size: Number(m.fileSize)
    } : null
  }));
  res.set('Cache-Control', 'no-store').json({
    messages,
    hasMore: rows.length > 50,
    thread: {
      version: thread.version,
      status: thread.status,
      canReply: thread.status !== 'closed' && Boolean(thread.response)
    }
  });
}

function createCareCustomerApi(pool, config = {}) {
  const router = Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use(async (req, res, next) => {
    try {
      const id = req.session?.customer?.id;
      if (!id) return res.status(401).json({ error: 'Vui lòng đăng nhập để gửi yêu cầu.' });
      if (!(await pool.query('SELECT id FROM customers WHERE id=$1 AND active=true', [id])).rows.length)
        return res.status(401).json({ error: 'Tài khoản không còn hoạt động.' });
      req.customerId = id;
      next();
    } catch (e) { next(e); }
  });

  router.get('/notification-preferences', async (req, res, next) => {
    try {
      const pref = (await pool.query('SELECT notify_on_response FROM care_email_preferences WHERE customer_id=$1', [req.customerId])).rows[0];
      res.json({ notifyOnResponse: pref ? pref.notify_on_response : true });
    } catch (e) { next(e); }
  });

  router.put('/notification-preferences', requireCsrf, async (req, res, next) => {
    try {
      const parsed = z.object({ notifyOnResponse: z.boolean() }).strict().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Dữ liệu tùy chọn không hợp lệ.' });
      await pool.query(
        'INSERT INTO care_email_preferences(customer_id, notify_on_response, updated_at) VALUES($1, $2, now()) ON CONFLICT (customer_id) DO UPDATE SET notify_on_response=$2, updated_at=now()',
        [req.customerId, parsed.data.notifyOnResponse]
      );
      res.json({ message: 'Đã lưu tùy chọn thông báo email.', notifyOnResponse: parsed.data.notifyOnResponse });
    } catch (e) { next(e); }
  });

  router.get('/:id/messages', async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) return res.sendStatus(404);
      const owned = (await pool.query('SELECT id FROM care_requests WHERE id=$1 AND customer_id=$2', [req.params.id, req.customerId])).rows[0];
      if (!owned) return res.status(404).json({ error: 'Không tìm thấy yêu cầu.' });
      await readMessages(pool, req, res);
    } catch (e) { next(e); }
  });

  router.post('/:id/messages', requireCsrf, async (req, res, next) => {
    const parsed = z.object({ body: z.string().trim().min(1).max(3000), version: z.number().int().positive() }).strict().safeParse(req.body);
    if (!parsed.success || !z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'Nhập nội dung trả lời, tối đa 3000 ký tự.' });
    try {
      const result = await withTransaction(pool, async client => {
        const row = (await client.query('SELECT * FROM care_requests WHERE id=$1 AND customer_id=$2 FOR UPDATE', [req.params.id, req.customerId])).rows[0];
        if (!row) return { status: 404, error: 'Không tìm thấy yêu cầu.' };
        if (row.status === 'closed') return { status: 409, error: 'Yêu cầu đã đóng. Vui lòng tạo yêu cầu mới.' };
        if (row.version !== parsed.data.version) return { status: 409, error: 'Hội thoại vừa thay đổi. Hãy tải lại trước khi gửi.' };
        if (!row.response) return { status: 409, error: 'Vui lòng chờ phản hồi đầu tiên từ GAERU.' };
        const count = Number((await client.query("SELECT count(*) total FROM care_messages WHERE care_id=$1 AND sender='customer' AND created_at>now()-interval '1 hour'", [row.id])).rows[0].total);
        if (count >= 30) return { status: 429, error: 'Bạn đã gửi nhiều tin nhắn. Vui lòng thử lại sau.' };
        await client.query("INSERT INTO care_messages(care_id,sender,body) VALUES($1,'customer',$2)", [row.id, parsed.data.body]);
        await client.query("UPDATE care_requests SET status='reviewing',version=version+1,updated_at=now() WHERE id=$1", [row.id]);
        await appendAudit(client, { actor: { username: req.customerId, source: 'customer' }, action: 'care.reply', entityType: 'care', entityId: row.id });
        return { status: 201 };
      });
      res.status(result.status).json(result.error ? { error: result.error } : { message: 'Đã gửi trả lời.' });
    } catch (e) { next(e); }
  });

  router.post('/:id/files', requireCsrf, parseUpload, async (req, res, next) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'Mã yêu cầu không hợp lệ.' });
    if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: 'Vui lòng chọn tệp tải lên.' });
    const mime = fileType(req.file);
    if (!mime) return res.status(400).json({ error: 'Chỉ nhận tệp ảnh (JPG, PNG, WebP, GIF, HEIC), video (MP4, MOV, WebM), PDF hoặc tài liệu văn bản.' });
    try {
      const result = await withTransaction(pool, async client => {
        const row = (await client.query('SELECT * FROM care_requests WHERE id=$1 AND customer_id=$2 FOR UPDATE', [req.params.id, req.customerId])).rows[0];
        if (!row) return { status: 404, error: 'Không tìm thấy yêu cầu.' };
        if (row.status === 'closed') return { status: 409, error: 'Yêu cầu đã đóng. Vui lòng tạo yêu cầu mới.' };
        const count = Number((await client.query("SELECT count(*) total FROM care_messages WHERE care_id=$1 AND sender='customer' AND created_at>now()-interval '1 hour'", [row.id])).rows[0].total);
        if (count >= 30) return { status: 429, error: 'Bạn đã gửi nhiều tệp. Vui lòng thử lại sau.' };
        let safeName = String(req.file.originalname || 'attachment').replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180);
        const uploaded = await storeUpload('care', req.file.buffer, mime);
        if (uploaded.mimeType === 'image/webp' && req.file.originalname?.match(/\.[^.]+$/)) {
          safeName = safeName.replace(/\.[^.]+$/, '') + '.webp';
        }
        const bodyText = typeof req.body?.body === 'string' && req.body.body.trim().length > 0 ? req.body.body.trim().slice(0, 3000) : ('Tệp đính kèm: ' + safeName);
        const msg = (await client.query("INSERT INTO care_messages(care_id,sender,body) VALUES($1,'customer',$2) RETURNING id", [row.id, bodyText])).rows[0];
        const fileRow = (await client.query(
          "INSERT INTO care_message_files(care_id,message_id,name,mime,content,byte_size) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,mime,byte_size",
          [row.id, msg.id, safeName, uploaded.mimeType, uploaded.content, uploaded.byteSize]
        )).rows[0];
        await client.query("UPDATE care_requests SET status='reviewing',version=version+1,updated_at=now() WHERE id=$1", [row.id]);
        await appendAudit(client, {
          actor: { username: req.customerId, source: 'customer' },
          action: 'care.file',
          entityType: 'care',
          entityId: row.id,
          metadata: { fileName: safeName, size: uploaded.byteSize }
        });
        return { status: 201, file: { id: fileRow.id, name: fileRow.name, mime: fileRow.mime, size: fileRow.byte_size, messageId: msg.id } };
      });
      res.status(result.status).json(result.error ? { error: result.error } : { message: 'Đã gửi tệp đính kèm.', file: result.file });
    } catch (e) { next(e); }
  });

  router.get('/:id/files/:fileId', async (req, res, next) => {
    if (!z.string().uuid().safeParse(req.params.id).success || !z.string().uuid().safeParse(req.params.fileId).success)
      return res.status(404).json({ error: 'Không tìm thấy tệp.' });
    try {
      const fileRow = (await pool.query(
        `SELECT f.name, f.mime, f.content, f.byte_size
         FROM care_message_files f
         JOIN care_requests c ON c.id=f.care_id
         WHERE f.id=$1 AND f.care_id=$2 AND c.customer_id=$3`,
        [req.params.fileId, req.params.id, req.customerId]
      )).rows[0];
      if (!fileRow) return res.status(404).json({ error: 'Không tìm thấy tệp.' });
      await serveCareFile(res, req, fileRow);
    } catch (e) { next(e); }
  });

  router.get('/', async (req, res, next) => {
    try {
      const page = Number(req.query.page || 1);
      if (!Number.isInteger(page) || page < 1 || page > 10000) return res.status(400).json({ error: 'Trang không hợp lệ.' });
      res.json({
        requests: (await pool.query(
          `SELECT ${fields} FROM care_requests c LEFT JOIN orders o ON o.id=c.order_id WHERE c.customer_id=$1 ORDER BY c.created_at DESC,c.id LIMIT 20 OFFSET $2`,
          [req.customerId, (page - 1) * 20]
        )).rows,
        page
      });
    } catch (e) { next(e); }
  });

  router.post('/', requireCsrf, async (req, res, next) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Chọn đơn hàng, nhập tiêu đề và mô tả ít nhất 15 ký tự.' });
    try {
      const result = await withTransaction(pool, async client => {
        const a = parsed.data;
        await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [req.customerId]);
        const existing = (await client.query('SELECT * FROM care_requests WHERE customer_id=$1 AND request_key=$2', [req.customerId, a.requestKey])).rows[0];
        if (existing) {
          if ((existing.order_id || null) !== (a.orderId || null) || existing.channel !== a.channel || (existing.external_order_number || null) !== (a.externalOrderNumber || null) || existing.subject !== a.subject || existing.description !== a.description)
            return { status: 409, error: 'Mã yêu cầu đã được dùng cho nội dung khác.' };
          return { status: 200, request: existing };
        }
        const owned = a.channel === 'website' ? (await client.query('SELECT id FROM orders WHERE id=$1 AND customer_id=$2', [a.orderId, req.customerId])).rows[0] : true;
        if (!owned) return { status: 404, error: 'Không tìm thấy đơn hàng trong tài khoản.' };
        const count = Number((await client.query("SELECT count(*) AS total FROM care_requests WHERE customer_id=$1 AND created_at>now()-interval '1 day'", [req.customerId])).rows[0].total);
        if (count >= 10) return { status: 429, error: 'Bạn đã gửi nhiều yêu cầu trong ngày. Vui lòng liên hệ GAERU.' };
        const created = (await client.query('INSERT INTO care_requests(customer_id,order_id,request_key,subject,description,channel,external_order_number) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,status', [req.customerId, a.orderId || null, a.requestKey, a.subject, a.description, a.channel, a.externalOrderNumber || null])).rows[0];
        await appendAudit(client, { actor: { username: req.customerId, source: 'customer' }, action: 'care.create', entityType: 'care', entityId: created.id, metadata: { orderId: a.orderId || null, channel: a.channel } });
        return { status: 201, request: created };
      });
      res.status(result.status).json(result.error ? { error: result.error } : { request: { id: result.request.id, status: result.request.status } });
    } catch (e) { next(e); }
  });

  return router;
}

function createCareAdminApi(pool, config = {}) {
  const router = Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  router.get('/care-requests/:id/messages', requirePermission('orders.read'), async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) return res.sendStatus(404);
      if (!(await pool.query('SELECT id FROM care_requests WHERE id=$1', [req.params.id])).rows.length) return res.sendStatus(404);
      await readMessages(pool, req, res);
    } catch (e) { next(e); }
  });

  router.get('/care-requests', requirePermission('orders.read'), async (req, res, next) => {
    try {
      const page = Number(req.query.page || 1);
      if (!Number.isInteger(page) || page < 1 || page > 10000) return res.status(400).json({ error: 'Trang không hợp lệ.' });
      res.json({
        requests: (await pool.query(
          `SELECT ${fields},cu.full_name AS "customerName" FROM care_requests c LEFT JOIN orders o ON o.id=c.order_id JOIN customers cu ON cu.id=c.customer_id ORDER BY c.updated_at DESC,c.id LIMIT 25 OFFSET $1`,
          [(page - 1) * 25]
        )).rows,
        page
      });
    } catch (e) { next(e); }
  });

  router.patch('/care-requests/:id', requirePermission('orders.write'), requireCsrf, async (req, res, next) => {
    const parsed = z.object({
      status: z.enum(['reviewing', 'waiting_customer', 'resolved', 'closed']),
      response: z.string().trim().min(5).max(3000),
      version: z.number().int().positive()
    }).strict().safeParse(req.body);
    if (!parsed.success || !z.string().uuid().safeParse(req.params.id).success)
      return res.status(400).json({ error: 'Kiểm tra trạng thái và phản hồi.' });
    try {
      const result = await withTransaction(pool, async client => {
        const before = (await client.query('SELECT * FROM care_requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
        if (!before) return { status: 404, error: 'Không tìm thấy yêu cầu.' };
        if (before.version !== parsed.data.version) return { status: 409, error: 'Yêu cầu vừa được cập nhật. Hãy tải lại.' };
        if (before.status === 'closed') return { status: 409, error: 'Yêu cầu đã đóng.' };
        const a = parsed.data;
        const request = (await client.query(
          'UPDATE care_requests SET status=$2,response=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,status,response,version',
          [before.id, a.status, a.response]
        )).rows[0];
        const msg = (await client.query("INSERT INTO care_messages(care_id,sender,body) VALUES($1,'staff',$2) RETURNING id", [before.id, a.response])).rows[0];
        await enqueueCareEmailNotification(client, before.id, msg.id, a.response, config);
        await appendAudit(client, { actor: req.admin, action: 'care.update', entityType: 'care', entityId: before.id, before: { status: before.status }, after: request });
        return { status: 200, request };
      });
      res.status(result.status).json(result.error ? { error: result.error } : { request: result.request });
    } catch (e) { next(e); }
  });

  router.post('/care-requests/:id/files', requirePermission('orders.write'), requireCsrf, parseUpload, async (req, res, next) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'Mã yêu cầu không hợp lệ.' });
    if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: 'Vui lòng chọn tệp tải lên.' });
    const mime = fileType(req.file);
    if (!mime) return res.status(400).json({ error: 'Chỉ nhận tệp ảnh (JPG, PNG, WebP, GIF, HEIC), video (MP4, MOV, WebM), PDF hoặc tài liệu văn bản.' });
    try {
      const result = await withTransaction(pool, async client => {
        const before = (await client.query('SELECT * FROM care_requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
        if (!before) return { status: 404, error: 'Không tìm thấy yêu cầu.' };
        if (before.status === 'closed') return { status: 409, error: 'Yêu cầu đã đóng.' };
        let safeName = String(req.file.originalname || 'attachment').replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180);
        const uploaded = await storeUpload('care', req.file.buffer, mime);
        if (uploaded.mimeType === 'image/webp' && req.file.originalname?.match(/\.[^.]+$/)) {
          safeName = safeName.replace(/\.[^.]+$/, '') + '.webp';
        }
        const bodyText = typeof req.body?.body === 'string' && req.body.body.trim().length > 0 ? req.body.body.trim().slice(0, 3000) : ('Tệp đính kèm từ GAERU: ' + safeName);
        const msg = (await client.query("INSERT INTO care_messages(care_id,sender,body) VALUES($1,'staff',$2) RETURNING id", [before.id, bodyText])).rows[0];
        const fileRow = (await client.query(
          "INSERT INTO care_message_files(care_id,message_id,name,mime,content,byte_size) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,mime,byte_size",
          [before.id, msg.id, safeName, uploaded.mimeType, uploaded.content, uploaded.byteSize]
        )).rows[0];
        await client.query("UPDATE care_requests SET version=version+1,updated_at=now() WHERE id=$1", [before.id]);
        await enqueueCareEmailNotification(client, before.id, msg.id, bodyText, config);
        await appendAudit(client, { actor: req.admin, action: 'care.file', entityType: 'care', entityId: before.id, metadata: { fileName: safeName, size: uploaded.byteSize } });
        return { status: 201, file: { id: fileRow.id, name: fileRow.name, mime: fileRow.mime, size: fileRow.byte_size, messageId: msg.id } };
      });
      res.status(result.status).json(result.error ? { error: result.error } : { message: 'Đã gửi tệp đính kèm.', file: result.file });
    } catch (e) { next(e); }
  });

  router.get('/care-requests/:id/files/:fileId', requirePermission('orders.read'), async (req, res, next) => {
    if (!z.string().uuid().safeParse(req.params.id).success || !z.string().uuid().safeParse(req.params.fileId).success)
      return res.status(404).json({ error: 'Không tìm thấy tệp.' });
    try {
      const fileRow = (await pool.query(
        'SELECT f.name, f.mime, f.content, f.byte_size FROM care_message_files f WHERE f.id=$1 AND f.care_id=$2',
        [req.params.fileId, req.params.id]
      )).rows[0];
      if (!fileRow) return res.status(404).json({ error: 'Không tìm thấy tệp.' });
      await serveCareFile(res, req, fileRow);
    } catch (e) { next(e); }
  });

  return router;
}

async function processCareEmailOutbox(pool, config, mailer) {
  if (!mailer || !config.smtp?.from) return false;
  await pool.query("UPDATE care_email_outbox SET status='unknown',finished_at=now(),result='Tiến trình gián đoạn; kiểm tra trước khi gửi lại' WHERE status='sending' AND attempted_at<now()-interval '2 minutes'");

  const job = await withTransaction(pool, async c => {
    const row = (await c.query("SELECT * FROM care_email_outbox WHERE status='pending' AND next_attempt_at<=now() ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
    if (!row) return null;
    if (row.attempts >= 5) {
      await c.query("UPDATE care_email_outbox SET status='failed',finished_at=now(),result='Vượt quá 5 lần thử gửi' WHERE id=$1", [row.id]);
      return null;
    }
    const customer = (await c.query("SELECT active FROM customers WHERE id=$1", [row.customer_id])).rows[0];
    if (!customer || !customer.active) {
      await c.query("UPDATE care_email_outbox SET status='skipped',finished_at=now(),result='Tài khoản khách hàng không còn hoạt động' WHERE id=$1", [row.id]);
      return null;
    }
    await c.query("UPDATE care_email_outbox SET status='sending',attempts=attempts+1,attempted_at=now() WHERE id=$1", [row.id]);
    return { ...row, attempts: row.attempts + 1 };
  });

  if (!job) return false;

  try {
    const result = await mailer.sendMail({
      from: config.smtp.from,
      to: job.recipient_email,
      subject: job.subject,
      text: job.body_text,
      messageId: `<care-response-${job.id}@gaeru.com>`
    });
    const accepted = result?.accepted?.some(v => String(v.address || v).toLowerCase() === job.recipient_email.toLowerCase());
    await pool.query("UPDATE care_email_outbox SET status=$2,finished_at=now(),result=$3 WHERE id=$1 AND status='sending'", [
      job.id,
      accepted ? 'sent' : result?.rejected?.length ? 'failed' : 'unknown',
      accepted ? 'SMTP đã tiếp nhận' : result?.rejected?.length ? 'SMTP từ chối người nhận' : 'Chưa xác định kết quả SMTP'
    ]);
  } catch (error) {
    const safeRetry = (Number(error.responseCode) >= 400 && Number(error.responseCode) < 500) || ['CONN', 'EHLO', 'STARTTLS', 'AUTH', 'MAIL FROM', 'RCPT TO'].includes(error.command);
    const retry = safeRetry && job.attempts < 5;
    await pool.query("UPDATE care_email_outbox SET status=$2,next_attempt_at=now()+interval '5 minutes',finished_at=CASE WHEN $2='pending' THEN NULL ELSE now() END,result=$3 WHERE id=$1 AND status='sending'", [
      job.id,
      retry ? 'pending' : 'failed',
      retry ? 'Chờ thử lại kết nối gửi thư' : (error.message || 'Lỗi gửi email')
    ]);
  }
  return true;
}

function startCareEmailWorker(pool, config, { mailer = null, intervalMs = 15000 } = {}) {
  const activeMailer = mailer || (config.smtp ? require('nodemailer').createTransport(require('./smtp-security').smtpOptions(config.smtp)) : null);
  let stopped = false, running = false;
  async function run() {
    if (stopped || running) return;
    running = true;
    try {
      for (let i = 0; i < 10 && !stopped; i++) {
        if (!await processCareEmailOutbox(pool, config, activeMailer)) break;
      }
    } catch (e) {
      console.error('Care email queue temporarily unavailable:', e.message);
    } finally {
      running = false;
    }
  }
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
  return () => { stopped = true; clearInterval(timer); };
}

module.exports = {
  createCareCustomerApi,
  createCareAdminApi,
  processCareEmailOutbox,
  startCareEmailWorker,
  readMessages,
  fileType
};
