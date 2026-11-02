const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const {
  createCareCustomerApi,
  createCareAdminApi,
  processCareEmailOutbox,
  fileType
} = require('../src/care-api');

test('CARE+ file attachments, access control, and email notification outbox with idempotency', async t => {
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) {
      return !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : db.query(sql, values);
    },
    async connect() {
      return { query: pool.query, release() {} };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);

  // Seed customer A and customer B
  const customerA = (await pool.query(
    "INSERT INTO customers(email, full_name, active) VALUES('cust-a@gaeru.com', 'Khách Hàng A', true) RETURNING id"
  )).rows[0];
  const customerB = (await pool.query(
    "INSERT INTO customers(email, full_name, active) VALUES('cust-b@gaeru.com', 'Khách Hàng B', true) RETURNING id"
  )).rows[0];

  // Seed orders
  const orderA = (await pool.query(
    "INSERT INTO orders(order_number, customer_id, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status) VALUES('GR-ORDER-001', $1, 'Khách Hàng A', 'cust-a@gaeru.com', '0901111111', 'Quận 1', 'TP. Hồ Chí Minh', 'cod', 500000, 500000, 'completed', 'paid') RETURNING id",
    [customerA.id]
  )).rows[0];

  // Seed care request for Customer A
  const careRequestA = (await pool.query(
    "INSERT INTO care_requests(customer_id, order_id, request_key, subject, description, channel, response) VALUES($1, $2, gen_random_uuid(), 'Micro GAERU K9 mất kết nối', 'Micro không nhận tín hiệu sau khi sạc qua đêm.', 'website', 'Chào bạn, GAERU đã nhận thông tin.') RETURNING id, version",
    [customerA.id, orderA.id]
  )).rows[0];

  // Initial staff message
  await pool.query(
    "INSERT INTO care_messages(care_id, sender, body) VALUES($1, 'staff', 'Chào bạn, GAERU đã nhận thông tin.')",
    [careRequestA.id]
  );

  const config = {
    smtp: {
      from: 'care@gaeru.com',
      publicBaseUrl: 'https://gaeru.com'
    }
  };

  // Build Express app
  const app = express();
  app.use(express.json());

  // Mock sessions and auth
  let activeCustomer = customerA.id;
  let adminRole = ['orders.read', 'orders.write'];
  let csrfTokenValue = 'valid-test-csrf-token';

  app.use((req, _res, next) => {
    req.session = {
      customer: { id: activeCustomer },
      admin: { username: 'gaeru_admin' },
      csrfToken: csrfTokenValue
    };
    req.admin = {
      username: 'gaeru_admin',
      permissions: adminRole
    };
    next();
  });

  app.use('/api/customer/care', createCareCustomerApi(pool, config));
  app.use('/api/gaeru_ceo', createCareAdminApi(pool, config));

  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const defaultHeaders = {
    'X-CSRF-Token': csrfTokenValue
  };

  // Helper for multipart/form-data upload using standard FormData & Blob
  async function uploadFile(path, fileName, buffer, mimeType, additionalFields = {}) {
    const formData = new FormData();
    const blob = new Blob([buffer], { type: mimeType });
    formData.append('file', blob, fileName);
    for (const [k, v] of Object.entries(additionalFields)) {
      formData.append(k, v);
    }
    return fetch(baseUrl + path, {
      method: 'POST',
      headers: {
        'X-CSRF-Token': csrfTokenValue
      },
      body: formData
    });
  }

  // 1. Test fileType detection
  const fakePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
  const fakeJpg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
  const fakePdf = Buffer.from('%PDF-1.4\n%...\n');
  assert.equal(fileType({ buffer: fakePng, originalname: 'image.png' }), 'image/png');
  assert.equal(fileType({ buffer: fakeJpg, originalname: 'photo.jpg' }), 'image/jpeg');
  assert.equal(fileType({ buffer: fakePdf, originalname: 'invoice.pdf' }), 'application/pdf');
  assert.equal(fileType({ buffer: Buffer.from('bad data'), originalname: 'bad.exe' }), null);

  // 2. Customer uploads PNG image attachment
  const custUploadRes = await uploadFile(
    `/api/customer/care/${careRequestA.id}/files`,
    'broken-mic.png',
    fakePng,
    'image/png',
    { body: 'Gửi ảnh đèn tín hiệu không sáng' }
  );
  assert.equal(custUploadRes.status, 201);
  const custUploadData = await custUploadRes.json();
  assert.ok(custUploadData.file?.id);
  assert.equal(custUploadData.file.name, 'broken-mic.png');
  const custFileId = custUploadData.file.id;

  // Verify stored in DB
  const fileRows = (await pool.query('SELECT * FROM care_message_files WHERE id=$1', [custFileId])).rows;
  assert.equal(fileRows.length, 1);
  assert.equal(fileRows[0].care_id, careRequestA.id);

  // 3. Customer A downloads their file
  const downloadA = await fetch(`${baseUrl}/api/customer/care/${careRequestA.id}/files/${custFileId}`);
  assert.equal(downloadA.status, 200);
  assert.equal(downloadA.headers.get('content-type'), 'image/png');
  assert.equal(downloadA.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(downloadA.headers.get('x-content-type-options'), 'nosniff');

  // 4. Access Control: Customer B CANNOT download Customer A's file
  activeCustomer = customerB.id;
  const downloadB = await fetch(`${baseUrl}/api/customer/care/${careRequestA.id}/files/${custFileId}`);
  assert.equal(downloadB.status, 404);

  // Switch back to Customer A
  activeCustomer = customerA.id;

  // 5. Customer uploads video file (MP4)
  const fakeMp4 = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypmp42'),
    Buffer.alloc(64, 1)
  ]);
  const videoUploadRes = await uploadFile(
    `/api/customer/care/${careRequestA.id}/files`,
    'mic-noise.mp4',
    fakeMp4,
    'video/mp4'
  );
  assert.equal(videoUploadRes.status, 201);
  const videoFileId = (await videoUploadRes.json()).file.id;

  // Test video range request
  const rangeRes = await fetch(`${baseUrl}/api/customer/care/${careRequestA.id}/files/${videoFileId}`, {
    headers: { Range: 'bytes=0-15' }
  });
  assert.equal(rangeRes.status, 206);
  assert.equal(rangeRes.headers.get('accept-ranges'), 'bytes');
  assert.match(rangeRes.headers.get('content-range'), /^bytes 0-15\//);

  // 6. Messages list returns files with thread
  const msgListRes = await fetch(`${baseUrl}/api/customer/care/${careRequestA.id}/messages`);
  assert.equal(msgListRes.status, 200);
  const msgListData = await msgListRes.json();
  const fileMsgs = msgListData.messages.filter(m => m.file !== null);
  assert.equal(fileMsgs.length, 2);
  assert.equal(fileMsgs[0].file.id, custFileId);
  assert.equal(fileMsgs[0].file.name, 'broken-mic.png');

  // 7. Staff uploads attachment to ticket
  const staffPdf = Buffer.from('%PDF-1.4\n%GAERU return guide\n');
  const staffUploadRes = await uploadFile(
    `/api/gaeru_ceo/care-requests/${careRequestA.id}/files`,
    'return-instructions.pdf',
    staffPdf,
    'application/pdf',
    { body: 'GAERU gửi bạn phiếu hướng dẫn gửi bảo hành.' }
  );
  assert.equal(staffUploadRes.status, 201);
  const staffFileId = (await staffUploadRes.json()).file.id;

  // Staff downloads file
  const staffDownload = await fetch(`${baseUrl}/api/gaeru_ceo/care-requests/${careRequestA.id}/files/${staffFileId}`);
  assert.equal(staffDownload.status, 200);
  assert.equal(staffDownload.headers.get('content-type'), 'application/pdf');

  // 8. Verify Staff response enqueued email into care_email_outbox
  const outboxAfterFile = (await pool.query(
    'SELECT * FROM care_email_outbox WHERE care_id=$1',
    [careRequestA.id]
  )).rows;
  assert.ok(outboxAfterFile.length >= 1);
  assert.equal(outboxAfterFile[0].recipient_email, 'cust-a@gaeru.com');
  assert.equal(outboxAfterFile[0].status, 'pending');
  assert.match(outboxAfterFile[0].subject, /GAERU CARE\+/);

  // 9. Staff updates status and text response via PATCH
  const currentReq = (await pool.query('SELECT version FROM care_requests WHERE id=$1', [careRequestA.id])).rows[0];
  const patchRes = await fetch(`${baseUrl}/api/gaeru_ceo/care-requests/${careRequestA.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...defaultHeaders
    },
    body: JSON.stringify({
      status: 'waiting_customer',
      response: 'Kỹ thuật viên GAERU đã xem video và xác nhận cần tiếp nhận kiểm tra chân sạc.',
      version: currentReq.version
    })
  });
  assert.equal(patchRes.status, 200);

  // Check outbox has the new notification
  const outboxAfterPatch = (await pool.query(
    'SELECT * FROM care_email_outbox WHERE care_id=$1 ORDER BY created_at DESC',
    [careRequestA.id]
  )).rows;
  assert.equal(outboxAfterPatch.length, 2);
  assert.match(outboxAfterPatch[0].body_text, /tiếp nhận kiểm tra chân sạc/);

  // 10. Idempotency test: duplicate email for same message is rejected by constraint
  await assert.rejects(async () => {
    await pool.query(
      'INSERT INTO care_email_outbox(care_id, message_id, customer_id, recipient_email, subject, body_text) VALUES($1, $2, $3, $4, $5, $6)',
      [outboxAfterPatch[0].care_id, outboxAfterPatch[0].message_id, customerA.id, 'cust-a@gaeru.com', 'Subject', 'Body']
    );
  }, /unique/i);

  // 11. Customer email preferences:
  // Default is true
  const prefGet = await fetch(`${baseUrl}/api/customer/care/notification-preferences`);
  assert.equal(prefGet.status, 200);
  assert.equal((await prefGet.json()).notifyOnResponse, true);

  // Turn off email notifications
  const prefPut = await fetch(`${baseUrl}/api/customer/care/notification-preferences`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...defaultHeaders
    },
    body: JSON.stringify({ notifyOnResponse: false })
  });
  assert.equal(prefPut.status, 200);
  assert.equal((await prefPut.json()).notifyOnResponse, false);

  // Staff sends another reply when preference is false -> Should NOT enqueue another email
  const reqV3 = (await pool.query('SELECT version FROM care_requests WHERE id=$1', [careRequestA.id])).rows[0];
  const patchNoEmail = await fetch(`${baseUrl}/api/gaeru_ceo/care-requests/${careRequestA.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...defaultHeaders
    },
    body: JSON.stringify({
      status: 'reviewing',
      response: 'Tin nhắn gửi khi khách đã tắt thông báo email.',
      version: reqV3.version
    })
  });
  assert.equal(patchNoEmail.status, 200);

  const outboxUnchanged = (await pool.query(
    'SELECT count(*)::int AS count FROM care_email_outbox WHERE care_id=$1',
    [careRequestA.id]
  )).rows[0].count;
  assert.equal(outboxUnchanged, 2, 'No email should be queued when customer opted out');

  // Customer re-enables notifications
  await fetch(`${baseUrl}/api/customer/care/notification-preferences`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...defaultHeaders
    },
    body: JSON.stringify({ notifyOnResponse: true })
  });

  // 12. Test outbox worker processCareEmailOutbox
  const sentEmails = [];
  const mockMailer = {
    async sendMail(opts) {
      sentEmails.push(opts);
      return { accepted: [opts.to] };
    }
  };

  const processed = await processCareEmailOutbox(pool, config, mockMailer);
  assert.equal(processed, true);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, 'cust-a@gaeru.com');
  assert.match(sentEmails[0].subject, /GAERU CARE\+/);

  const sentJob = (await pool.query('SELECT status, result FROM care_email_outbox WHERE status=$1', ['sent'])).rows;
  assert.equal(sentJob.length, 1);
  assert.equal(sentJob[0].status, 'sent');
  assert.match(sentJob[0].result, /tiếp nhận/);
});
