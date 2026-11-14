'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { loadConfig } = require('../src/config');
const {
  failureStatus,
  retryDelaySeconds,
  resolveReplyTo,
  resolveFrom,
  adminNotificationRecipients,
  processAdminDomainEmailOutbox
} = require('../src/smtp-delivery');
const { createCareCustomerApi } = require('../src/care-api');
const { createWarrantyPublicApi } = require('../src/warranty-public-api');
const { notifyAdmin } = require('../src/order-review');
const { processOrderEmail } = require('../src/order-email');
const { processWarrantyEmail } = require('../src/warranty-email');
const { operationalHealth } = require('../src/operational-health');

function makePool(db) {
  let queue = Promise.resolve();
  async function lock() {
    const prev = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await prev;
    return release;
  }
  async function rawQuery(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  return {
    async query(sql, values) {
      const release = await lock();
      try { return await rawQuery(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      return { query: rawQuery, release };
    }
  };
}

test('config loads optional SMTP_REPLY_TO and ADMIN_DOMAIN_EMAIL safely', () => {
  const cfg = loadConfig({
    DATABASE_URL: 'postgres://localhost/gaeru',
    SESSION_SECRET: 'a-session-secret-with-at-least-32-chars',
    ADMIN_USERNAME: 'owner',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync('test-password', 4),
    PUBLIC_BASE_URL: 'https://gaeru.com',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '465',
    SMTP_SECURE: 'true',
    SMTP_USER: 'mailer@example.com',
    SMTP_PASSWORD: 'secret',
    SMTP_FROM: 'noreply@gaeru.com',
    SMTP_REPLY_TO: 'support@gaeru.com',
    ADMIN_DOMAIN_EMAIL: 'business@gaeru.com'
  });
  assert.equal(cfg.SMTP_REPLY_TO, 'support@gaeru.com');
  assert.equal(cfg.ADMIN_DOMAIN_EMAIL, 'business@gaeru.com');
  assert.equal(cfg.smtp.replyTo, 'support@gaeru.com');
  assert.equal(cfg.smtp.adminDomainEmail, 'business@gaeru.com');
  assert.equal(resolveReplyTo(cfg), 'support@gaeru.com');
  assert.equal(resolveFrom(cfg), 'GAERU <noreply@gaeru.com>');
  assert.equal(resolveFrom({ smtp: { from: 'business@gaeru.com' } }), 'GAERU <business@gaeru.com>');
  assert.equal(resolveFrom({ smtp: { from: 'GAERU Support <custom@gaeru.com>' } }), 'GAERU <custom@gaeru.com>');

  const cfgDefault = loadConfig({
    DATABASE_URL: 'postgres://localhost/gaeru',
    SESSION_SECRET: 'a-session-secret-with-at-least-32-chars',
    ADMIN_USERNAME: 'owner',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync('test-password', 4),
    PUBLIC_BASE_URL: 'https://gaeru.com',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_USER: 'mailer',
    SMTP_PASSWORD: 'secret',
    SMTP_FROM: 'noreply@gaeru.com'
  });
  assert.equal(cfgDefault.smtp.replyTo, 'business@gaeru.com');
  assert.equal(cfgDefault.smtp.adminDomainEmail, undefined);
});

test('smtp-delivery classifies transient network codes safely without duplicating DATA timeouts', () => {
  for (const code of ['ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ECONNRESET', 'ESOCKET']) {
    assert.equal(failureStatus({ code }, 1), 'pending', `${code} without DATA should retry`);
    assert.equal(failureStatus({ code, command: 'DATA' }, 1), 'unknown', `${code} during DATA stays unknown`);
  }
  assert.equal(failureStatus({}, 1), 'unknown');
  assert.equal(retryDelaySeconds(1), 60);
  assert.equal(retryDelaySeconds(2), 300);
  assert.equal(retryDelaySeconds(3), 900);
  assert.equal(retryDelaySeconds(4), 1800);
  assert.equal(retryDelaySeconds(10), 1800);
});

test('domain email pipeline enqueues CARE+ & external warranty alerts, delivers to ADMIN_DOMAIN_EMAIL, attaches replyTo, and retries network errors', { timeout: 60000 }, async (t) => {
  const db = await PGlite.create();
  const pool = makePool(db);
  t.after(() => db.close());
  await migrateDatabase(pool);

  const customer = (await pool.query(
    "INSERT INTO customers(full_name,email,phone,password_hash,email_verified_at) VALUES('Nguyễn Văn Test','buyer@example.test','0912345678',$1,now()) RETURNING id",
    [bcrypt.hashSync('Password123', 4)]
  )).rows[0];

  const order = (await pool.query(
    "INSERT INTO orders(order_number,customer_id,customer_name,email,phone,address,city,payment_method,status,payment_status,subtotal_vnd,shipping_fee_vnd,total_vnd) VALUES('GAE-DOMAIN-001',$1,'Nguyễn Văn Test','buyer@example.test','0912345678','123 Đường Test','Hà Nội','cod','completed','paid',500000,0,500000) RETURNING id",
    [customer.id]
  )).rows[0];
  await pool.query("INSERT INTO order_email_outbox(order_id,kind) VALUES($1,'receipt')", [order.id]);

  // Verify owner in DB is personal gmail, and ADMIN_DOMAIN_EMAIL ensures business@gaeru.com receives copy too
  await pool.query(
    "INSERT INTO account_security(account_key,email,contacts_verified_at) VALUES('owner','owner-personal@gmail.com',now())"
  );

  const config = {
    PUBLIC_BASE_URL: 'https://gaeru.com',
    ADMIN_DOMAIN_EMAIL: 'business@gaeru.com',
    smtp: {
      from: 'noreply@gaeru.com',
      replyTo: 'business@gaeru.com',
      adminDomainEmail: 'business@gaeru.com',
      publicBaseUrl: 'https://gaeru.com'
    }
  };

  const recips = await adminNotificationRecipients(pool, config);
  assert.deepEqual(recips, ['owner-personal@gmail.com', 'business@gaeru.com']);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { csrfToken: 'test-csrf', customer: { id: customer.id } };
    req.sessionID = 'test-session-id';
    next();
  });
  app.use('/api/customer/care', createCareCustomerApi(pool, config));
  app.use('/api/warranty-requests', createWarrantyPublicApi(pool, config));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;

  // 1. Customer creates CARE+ request -> must enqueue care_new admin domain notification
  const careRes = await fetch(base + '/api/customer/care', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' },
    body: JSON.stringify({
      orderId: order.id,
      channel: 'website',
      requestKey: randomUUID(),
      subject: 'Cần hỗ trợ kiểm tra micro P01',
      description: 'Micro P01 của mình cần tư vấn thêm về dây kết nối.'
    })
  });
  assert.equal(careRes.status, 201);
  const careId = (await careRes.json()).request.id;

  // Simulate admin replied once so customer can post a reply message
  await pool.query("UPDATE care_requests SET response='GAERU đã tiếp nhận hỗ trợ.', version=version+1 WHERE id=$1", [careId]);
  const replyRes = await fetch(base + `/api/customer/care/${careId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' },
    body: JSON.stringify({ body: 'Cảm ơn shop, mình đã gửi thêm ảnh rồi nhé.', version: 2 })
  });
  assert.equal(replyRes.status, 201);

  // 2. Customer registers external Shopee warranty -> must enqueue warranty_external_new
  const warRes = await fetch(base + '/api/warranty-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' },
    body: JSON.stringify({
      channel: 'shopee',
      externalOrderNumber: 'SP-20261112-888',
      purchaseDate: '2026-11-10',
      productName: 'GAERU K9',
      serial: 'K9TEST1234',
      contact: {
        fullName: 'Trần Bảo Hành',
        phone: '0988777666',
        address: '456 Phố Bảo Hành',
        email: 'war@example.test',
        city: 'TP. Hồ Chí Minh'
      },
      requestKey: randomUUID()
    })
  });
  assert.equal(warRes.status, 201);

  const queued = (await pool.query('SELECT event_type, status FROM admin_domain_email_outbox ORDER BY created_at')).rows;
  assert.deepEqual(
    queued.map((r) => r.event_type),
    ['care_new', 'care_customer_reply', 'warranty_external_new']
  );

  // 3. Test transient ETIMEDOUT retry + successful delivery with replyTo + domain CC
  let flakedOnce = false;
  const delivered = [];
  const mailer = {
    async sendMail(msg) {
      if (!flakedOnce) {
        flakedOnce = true;
        throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      }
      delivered.push(msg);
      const all = [msg.to, ...(Array.isArray(msg.cc) ? msg.cc : msg.cc ? [msg.cc] : [])];
      return { accepted: all, rejected: [] };
    }
  };

  // First call hits ETIMEDOUT -> job returns to pending with backoff
  assert.equal(await processAdminDomainEmailOutbox(pool, config, mailer), true);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM admin_domain_email_outbox WHERE status='pending' AND attempts=1")).rows[0].n,
    1
  );

  // Fast-forward next_attempt_at and drain all 3 domain notifications
  await pool.query("UPDATE admin_domain_email_outbox SET next_attempt_at=now()-interval '1 second' WHERE status='pending'");
  for (let i = 0; i < 5; i++) {
    if (!await processAdminDomainEmailOutbox(pool, config, mailer)) break;
  }

  assert.equal(delivered.length, 3);
  for (const m of delivered) {
    assert.equal(m.from, 'GAERU <noreply@gaeru.com>');
    assert.equal(m.replyTo, 'business@gaeru.com');
    assert.equal(m.to, 'owner-personal@gmail.com');
    assert.deepEqual(m.cc, ['business@gaeru.com']);
  }

  // 4. Test notifyAdmin & processOrderEmail also include replyTo and domain recipient
  await notifyAdmin(pool, config, mailer);
  await processOrderEmail(pool, config, mailer);
  assert.equal(delivered.length, 5);
  const adminOrderMail = delivered[3];
  assert.equal(adminOrderMail.from, 'GAERU <noreply@gaeru.com>');
  assert.equal(adminOrderMail.to, 'owner-personal@gmail.com');
  assert.deepEqual(adminOrderMail.cc, ['business@gaeru.com']);
  assert.equal(adminOrderMail.replyTo, 'business@gaeru.com');

  const customerOrderMail = delivered[4];
  assert.equal(customerOrderMail.from, 'GAERU <noreply@gaeru.com>');
  assert.equal(customerOrderMail.to, 'buyer@example.test');
  assert.equal(customerOrderMail.replyTo, 'business@gaeru.com');

  // 5. Verify processWarrantyEmail sets replyTo
  const warId = (await warRes.json()).activation.id;
  await pool.query("UPDATE warranty_activations SET status='active', purchase_date='2026-11-10', expires_on='2027-11-10' WHERE id=$1", [warId]);
  await processWarrantyEmail(pool, config, mailer);
  assert.equal(delivered.length, 6);
  assert.equal(delivered[5].from, 'GAERU <noreply@gaeru.com>');
  assert.equal(delivered[5].to, 'war@example.test');
  assert.equal(delivered[5].replyTo, 'business@gaeru.com');

  // 6. Verify operationalHealth monitors admin_domain_email_outbox
  const health = await operationalHealth(pool, config);
  assert.equal(health.queues.admin_domain_email_outbox.counts.sent, 3);
  assert.equal(health.failedOrUnknown, 0);
});
