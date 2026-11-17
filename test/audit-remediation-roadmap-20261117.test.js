'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');

async function createTestDb(t) {
  const db = await PGlite.create();
  let lockQueue = Promise.resolve();
  async function acquireLock() {
    const prev = lockQueue;
    let release;
    lockQueue = new Promise((resolve) => { release = resolve; });
    await prev;
    return release;
  }
  async function execQuery(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) {
      const release = await acquireLock();
      try { return await execQuery(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await acquireLock();
      return { query: execQuery, release };
    }
  };
  await migrateDatabase(pool);
  t.after(() => db.close());
  return pool;
}

test('Wave 1: Carrier attempt failed status constraint, HMAC webhook replay & retryable status normalization', async (t) => {
  const pool = await createTestDb(t);
  const { schemas } = require('../src/admin-configuration');
  assert.equal(schemas.shipping_viettel.safeParse({
    accountId: 'acc', partnerCode: 'p', pickupName: 'GAERU', pickupPhone: '0900000000',
    pickupAddress: 'HN', webhookAuthMode: 'hmac'
  }).success, true);

  const { normalizeCarrierStatus } = require('../src/shipping-adapters');
  assert.ok(!['cancelled', 'returned'].includes(normalizeCarrierStatus('viettel', 'delivery_failed_retry')));
  assert.ok(!['cancelled', 'returned'].includes(normalizeCarrierStatus('viettel', 'cancel_rejected')));
  assert.ok(!['cancelled', 'returned'].includes(normalizeCarrierStatus('viettel', 'returning_soon')));
  assert.equal(normalizeCarrierStatus('viettel', 'cancelled'), 'cancelled');
  assert.equal(normalizeCarrierStatus('viettel', 'returned'), 'returned');

  const orderId = (await pool.query(
    "INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,subtotal_vnd,total_vnd) VALUES('GR-REM-1','Khach','k@gaeru.com','0900000001','123 Le Loi','HN','cod',100000,100000) RETURNING id"
  )).rows[0].id;
  await pool.query(
    "INSERT INTO carrier_shipment_attempts(order_id,carrier_id,config_version,status) VALUES($1,'viettel',1,'failed')",
    [orderId]
  );

  const { seal } = require('../src/totp');
  const cfg = { SESSION_SECRET: '0123456789abcdef0123456789abcdef' };
  const secret = 'webhook-secret-value-at-least-32-chars!!';
  await pool.query("INSERT INTO store_settings(setting_key,setting_value) VALUES($1,$2)", [
    'private_admin:shipping_viettel',
    JSON.stringify({
      version: 1,
      cipher: seal(JSON.stringify({
        accountId: 'a', partnerCode: 'b', pickupName: 'n', pickupPhone: '0900000000',
        pickupAddress: 'addr', webhookSecret: secret, webhookAuthMode: 'hmac'
      }), cfg.SESSION_SECRET)
    })
  ]);
  await pool.query(
    "INSERT INTO carrier_shipments(order_id,carrier_id,tracking_number,carrier_order_id,status,carrier_status_raw) VALUES($1,'viettel','VTP123','CO123','delivering','delivering')",
    [orderId]
  );

  const { handleCarrierWebhook } = require('../src/shipping-management');
  await assert.rejects(
    () => handleCarrierWebhook(pool, cfg, 'viettel', { order_number: 'VTP123', status: 'delivered' }, { headers: { 'x-webhook-secret': secret } }),
    (err) => err?.status === 401
  );

  const payload = { order_number: 'VTP123', status: 'delivering' };
  const rawBody = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const replay = await handleCarrierWebhook(pool, cfg, 'viettel', payload, {
    rawBody,
    headers: { 'x-webhook-signature': sig, 'x-webhook-timestamp': ts }
  });
  assert.equal(replay.success, true);
  assert.equal(replay.processed, false);
  const webhookEv = (await pool.query("SELECT applied FROM carrier_webhook_events WHERE tracking_number='VTP123' LIMIT 1")).rows[0];
  assert.equal(webhookEv.applied, false);
  const shipHist = (await pool.query("SELECT tracking_history FROM carrier_shipments WHERE tracking_number='VTP123'")).rows[0];
  assert.equal((shipHist.tracking_history || []).length, 0);
});

test('Wave 1: Barcode UUID guard, empty warehouse_stock conflict & partial unique barcode index', async (t) => {
  const pool = await createTestDb(t);
  const p = (await pool.query("INSERT INTO products(slug,name,category,active) VALUES('bar-p','Bar P','audio',true) RETURNING id")).rows[0];
  const v1 = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,barcode,active) VALUES($1,'SKU-B1','B1',100000,5,'893850000001',true) RETURNING id", [p.id])).rows[0];
  await assert.rejects(
    () => pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,barcode,active) VALUES($1,'SKU-B2','B2',100000,0,'893850000001',true)", [p.id]),
    (err) => err?.code === '23505'
  );

  const wh = (await pool.query("INSERT INTO warehouses(code,name,active) VALUES('MAIN-TEST','Kho test',true) ON CONFLICT DO NOTHING RETURNING id")).rows[0]
    || (await pool.query("SELECT id FROM warehouses LIMIT 1")).rows[0];
  const { receiveByBarcode } = require('../src/barcode-api');
  await assert.rejects(
    () => receiveByBarcode(pool, { warehouseId: 'not-a-uuid', code: '893850000001', quantity: 1 }),
    (err) => err?.status === 400
  );
  await assert.rejects(
    () => receiveByBarcode(pool, { warehouseId: wh.id, variantId: v1.id, code: '893850000001', quantity: 2 }),
    (err) => err?.status === 409
  );
});

test('Wave 1: DR backup scripts keep LF endings, trap EXIT cleanup and exclude globals dump', () => {
  const fullRestore = fs.readFileSync(path.join(__dirname, '../scripts/mi6-backup/gaeru-full-restore.sh'), 'utf8');
  assert.equal(fullRestore.includes('\r\n'), false);
  assert.match(fullRestore, /trap cleanup_temp_files EXIT/);

  const pcFailover = fs.readFileSync(path.join(__dirname, '../scripts/failover-restore-to-pc.ps1'), 'utf8');
  assert.match(pcFailover, /-globals-/);

  const pullScript = fs.readFileSync(path.join(__dirname, '../scripts/pull-mi6-backups.ps1'), 'utf8');
  assert.match(pullScript, /database-backup\.ps1/);
});

test('Wave 2: Bank resolution (Eximbank), returned invoice block, online cancel fence & loyalty overflow guard', async (t) => {
  const pool = await createTestDb(t);
  const { formatBankTransferInstructions } = require('../src/payment-channels');
  const eximBank = formatBankTransferInstructions({ bankId: 'Eximbank', accountNumber: '123456', accountHolder: 'GAERU' }, { orderNumber: 'GR-EX-1', amountVnd: 100000 });
  assert.match(eximBank.qrUrl, /\/970431-/);
  assert.doesNotMatch(eximBank.qrUrl, /\/970422-/);
  const mbBank = formatBankTransferInstructions({ bankId: 'MBBank', accountNumber: '123456', accountHolder: 'GAERU' }, { orderNumber: 'GR-MB-1', amountVnd: 100000 });
  assert.match(mbBank.qrUrl, /\/970422-/);

  const cust = (await pool.query("INSERT INTO customers(full_name,email,phone,active) VALUES('Refund Buyer','rf@gaeru.com','0901112233',true) RETURNING id")).rows[0];
  const ord = (await pool.query(
    "INSERT INTO orders(order_number,customer_id,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,total_vnd,return_completed_at) VALUES('GR-RET-INV',$1,'Refund Buyer','rf@gaeru.com','0901112233','Addr','HN','cod','paid','completed',200000,200000,now()) RETURNING id",
    [cust.id]
  )).rows[0];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { csrfToken: 'csrf-test-1' };
    req.admin = { username: 'owner', role: 'owner', permissions: ['invoice.write', 'marketplace.write', 'orders.read'] };
    next();
  });
  app.use('/api/gaeru_ceo', require('../src/business-api').createBusinessApi(pool, {}));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const invRes = await fetch(`http://127.0.0.1:${srv.address().port}/api/gaeru_ceo/business/invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'csrf-test-1' },
    body: JSON.stringify({
      requestKey: crypto.randomUUID(),
      period: '2026-11',
      orderId: ord.id,
      buyerName: 'Refund Buyer',
      buyerTaxCode: '0101234567',
      buyerAddress: '123 Le Loi, Ha Noi',
      buyerEmail: 'rf@gaeru.com'
    })
  });
  assert.equal(invRes.status, 409);

  const onlineOrd = (await pool.query(
    "INSERT INTO orders(order_number,customer_id,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,total_vnd) VALUES('GR-VNP-1',$1,'Refund Buyer','rf@gaeru.com','0901112233','Addr','HN','vnpay','pending','pending',100000,100000) RETURNING id",
    [cust.id]
  )).rows[0];
  await pool.query(
    "INSERT INTO payment_attempts(order_id,provider,transaction_ref,amount_vnd,status,expires_at) VALUES($1,'vnpay','TX-OPEN-1',100000,'pending',now()+interval '10 minutes')",
    [onlineOrd.id]
  );
  const { cancelCustomerOrder } = require('../src/customer-order-cancellation');
  await assert.rejects(
    () => pool.connect().then(async (c) => {
      try {
        await c.query('BEGIN');
        return await cancelCustomerOrder(c, { orderId: onlineOrd.id, customerId: cust.id, reason: 'Khách đổi ý muốn hủy' });
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    }),
    (err) => err?.status === 409
  );

  const { refundPoints } = require('../src/loyalty-api');
  await assert.rejects(
    () => pool.connect().then(async (c) => {
      try {
        await c.query('BEGIN');
        await c.query("INSERT INTO orders(id,order_number,customer_id,customer_name,email,phone,address,city,payment_method,subtotal_vnd,total_vnd) VALUES($1,'GR-BIG-XU',$2,'N','rf@gaeru.com','0901112233','A','HN','cod',100,100)", ['11111111-1111-4111-8111-111111111112', cust.id]);
        await c.query("INSERT INTO customer_loyalty(customer_id,points_balance) VALUES($1,100) ON CONFLICT(customer_id) DO UPDATE SET points_balance=100", [cust.id]);
        await c.query("INSERT INTO customer_loyalty_ledger(customer_id,order_id,type,points,balance_after,reason,event_key) VALUES($1,$2,'redeem',-2147483640,100,'Test big redeem','big-redeem-1')", [cust.id, '11111111-1111-4111-8111-111111111112']);
        await refundPoints(c, { customerId: cust.id, orderId: '11111111-1111-4111-8111-111111111112' });
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    }),
    /vượt giới hạn/i
  );
});

test('Wave 2: AI NLU xu false-positive fix, exhausted voucher exclusion, PII mask & staff pending review', async (t) => {
  const pool = await createTestDb(t);
  const { answerCustomerChat } = require('../src/gaeru-ai-customer');
  const xuRes = await answerCustomerChat({
    pool,
    config: {},
    question: 'Cách xử lý micro K9 bị rè tiếng nhẹ khi thu gần',
    history: []
  });
  assert.doesNotMatch(xuRes.answer, /GAERU Xu/i);

  const vFull = (await pool.query(
    "INSERT INTO marketing_vouchers(code,title,kind,amount,min_spend_vnd,starts_at,ends_at,total_limit,per_customer_limit,public_claim,active) VALUES('HETLUOT','Het luot','fixed',20000,100000,now()-interval '1 day',now()+interval '1 day',1,1,true,true) RETURNING id"
  )).rows[0];
  const o2 = (await pool.query("INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,subtotal_vnd,total_vnd) VALUES('GR-V-LIM','V','v@gaeru.com','0900000002','A','HN','cod',150000,130000) RETURNING id")).rows[0];
  const cu2 = (await pool.query("INSERT INTO customers(full_name,email,phone,active) VALUES('V User','v@gaeru.com','0900000002',true) RETURNING id")).rows[0];
  await pool.query("INSERT INTO voucher_redemptions(order_id,voucher_id,customer_id,discount_vnd,released) VALUES($1,$2,$3,20000,false)", [o2.id, vFull.id, cu2.id]);
  const { loadLiveSiteFacts } = require('../src/chat-web-knowledge');
  const facts = await loadLiveSiteFacts(pool);
  assert.equal((facts.activeVouchers || []).some((v) => v.code === 'HETLUOT'), false);

  const { sanitizePii, learnFromStaffResponse } = require('../src/ai-self-learning');
  const masked = sanitizePii('Liên hệ 0912.345.678 hoặc 082 919 1080 mã TEST-123');
  assert.doesNotMatch(masked, /0912|919 1080/);
  const th = (await pool.query("INSERT INTO shopping_chat_threads(owner_key,product_name,request_key) VALUES('own-1','K9',$1) RETURNING id", [crypto.randomUUID()])).rows[0];
  await learnFromStaffResponse(pool, {
    threadId: th.id,
    customerQuestion: 'Micro có bảo hành bao lâu ạ?',
    staffAnswer: 'Dạ GAERU bảo hành chính hãng 12 tháng đổi mới 1:1 trong 30 ngày đầu.',
    adminUser: { username: 'staff1' }
  });
  const learned = (await pool.query("SELECT status FROM ai_learned_knowledge ORDER BY created_at DESC LIMIT 1")).rows[0];
  assert.equal(learned.status, 'pending_review');
});

test('Wave 2 & 3: Omnichannel duplicate variant movement keys, care deletion cleanup, email skip continuation, bot & traffic & failover', async (t) => {
  const pool = await createTestDb(t);
  const p = (await pool.query("INSERT INTO products(slug,name,category,active) VALUES('omni-p','Omni P','audio',true) RETURNING id")).rows[0];
  const v = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'OMNI-DUP','Black',100000,10,true) RETURNING id", [p.id])).rows[0];
  const wh = (await pool.query("INSERT INTO warehouses(code,name,active) VALUES('WH-OMNI','Kho Omni',true) RETURNING id")).rows[0];
  await pool.query("INSERT INTO warehouse_stock(warehouse_id,variant_id,quantity) VALUES($1,$2,10)", [wh.id, v.id]);
  await pool.query("INSERT INTO marketplace_sku_mappings(channel,shop_id,external_sku,variant_id) VALUES('shopee','shop1','EXT-1',$1),('shopee','shop1','EXT-2',$1)", [v.id]);

  const { ingestMarketplaceOrder, createOmnichannelSync } = require('../src/omnichannel-sync');
  const orderRec = await (async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const res = await ingestMarketplaceOrder(c, {
        channel: 'shopee',
        shopId: 'shop1',
        order: { externalOrderId: 'ORD-DUP-1', rawStatus: 'PROCESSING', items: [{ externalSku: 'EXT-1', quantity: 1 }, { externalSku: 'EXT-2', quantity: 1 }] },
        autoDeductStock: true,
        actor: { username: 'tester' }
      });
      await c.query('COMMIT');
      return res;
    } finally { c.release(); }
  })();
  assert.equal(orderRec.stock_deducted, true);
  const mv = (await pool.query("SELECT count(*)::int AS cnt, COALESCE(SUM(delta),0)::int AS total FROM inventory_movements WHERE variant_id=$1 AND movement_type='sale_reservation'", [v.id])).rows[0];
  assert.equal(mv.cnt, 2);
  assert.equal(mv.total, -2);

  const undeducted = (await pool.query(
    "INSERT INTO marketplace_orders(channel,shop_id,external_order_id,order_date,status,items,stock_deducted,stock_reversed) VALUES('shopee','shop1','ORD-NO-DEDUCT',CURRENT_DATE,'pending','[]',false,false) RETURNING id"
  )).rows[0];
  const appOmni = express();
  appOmni.use(express.json());
  appOmni.use((req, _res, next) => {
    req.session = { csrfToken: 'csrf-omni-1' };
    req.admin = { username: 'owner', permissions: ['marketplace.write', 'marketplace.read'] };
    next();
  });
  appOmni.use('/api/gaeru_ceo', createOmnichannelSync(pool, {}).admin);
  const srvOmni = appOmni.listen(0, '127.0.0.1');
  await new Promise((r) => srvOmni.once('listening', r));
  t.after(() => new Promise((r) => srvOmni.close(r)));
  const revRes = await fetch(`http://127.0.0.1:${srvOmni.address().port}/api/gaeru_ceo/marketplace/orders/${undeducted.id}/reverse-stock`, {
    method: 'POST',
    headers: { 'x-csrf-token': 'csrf-omni-1' }
  });
  assert.equal(revRes.status, 409);

  // Email marketing queue continues after skipping suppressed recipient
  await pool.query("INSERT INTO marketing_email_suppressions(email) VALUES('skip-me@example.test')");
  const cmp = (await pool.query("INSERT INTO marketing_email_campaigns(title,subject,body,sources,status,scheduled_at,rate_per_minute) VALUES('Batch Test','Subj','Body','[]'::jsonb,'scheduled',now()-interval '1 minute',12) RETURNING id")).rows[0];
  await pool.query("INSERT INTO marketing_email_recipients(campaign_id,email,status) VALUES($1,'skip-me@example.test','pending'),($1,'deliver-me@example.test','pending')", [cmp.id]);
  const sentTo = [];
  const { processEmailQueue } = require('../src/email-marketing');
  const processed = await processEmailQueue(pool, { smtp: { publicBaseUrl: 'https://gaeru.com', from: 'noreply@gaeru.com' } }, {
    async sendMail(msg) { sentTo.push(msg.to); return { accepted: [msg.to] }; }
  });
  assert.equal(processed, true);
  assert.deepEqual(sentTo, ['deliver-me@example.test']);

  // Bot protection exempts /api/gaeru_ceo/* even after 400 strikes
  const appBot = express();
  appBot.use(require('../src/bot-protection').createBotProtection(pool, {
    TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret', PUBLIC_BASE_URL: 'https://gaeru.com', SESSION_SECRET: 'bot-sec-long-enough-1234'
  }));
  appBot.use(express.json());
  appBot.post('/api/gaeru_ceo/products', (_req, res) => res.status(400).json({ error: 'Invalid input' }));
  const srvBot = appBot.listen(0, '127.0.0.1');
  await new Promise((r) => srvBot.once('listening', r));
  t.after(() => new Promise((r) => srvBot.close(r)));
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`http://127.0.0.1:${srvBot.address().port}/api/gaeru_ceo/products`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 400);
  }

  // Traffic tracker ignores 404 responses
  const { createTrafficTracker, flushPendingVisits, getTrafficSummary, _testReset } = require('../src/traffic-tracker');
  _testReset();
  const appT = express();
  appT.use(createTrafficTracker(pool));
  appT.get('/missing-page', (_req, res) => res.status(404).send('Not found'));
  appT.get('/ok-page', (_req, res) => res.status(200).send('OK'));
  const srvT = appT.listen(0, '127.0.0.1');
  await new Promise((r) => srvT.once('listening', r));
  t.after(() => new Promise((r) => srvT.close(r)));
  await fetch(`http://127.0.0.1:${srvT.address().port}/missing-page`, { headers: { 'user-agent': 'Mozilla/5.0' } });
  await fetch(`http://127.0.0.1:${srvT.address().port}/ok-page`, { headers: { 'user-agent': 'Mozilla/5.0' } });
  await new Promise((r) => setTimeout(r, 30));
  await flushPendingVisits(pool);
  const tSummary = await getTrafficSummary(pool);
  assert.equal(tSummary.todayPageviews, 1);

  // FailoverSyncManager standby truth + role preservation
  const statePath = path.join(os.tmpdir(), `failover-test-${Date.now()}.json`);
  t.after(() => { try { fs.unlinkSync(statePath); } catch {} });
  fs.writeFileSync(statePath, JSON.stringify({ role: 'primary' }));
  const { FailoverSyncManager } = require('../src/failover-sync');
  const mgr = new FailoverSyncManager({ SERVER_ROLE: 'standby', FAILOVER_STATE_PATH: statePath }, pool);
  assert.equal(mgr.getStatus().role, 'standby');
  assert.equal(mgr.getStatus().readyForTraffic, false);

  // Admin HTML, Watchdog, CI
  const adminHtml = fs.readFileSync(path.join(__dirname, '../admin/index.html'), 'utf8');
  assert.match(adminHtml, /id="floating-copilot-btn"[^>]*hidden/);
  assert.match(adminHtml, /data-chat-nav-badge/);
  const releaseYml = fs.readFileSync(path.join(__dirname, '../.github/workflows/release-check.yml'), 'utf8');
  assert.match(releaseYml, /verify:assets/);
  const watchdog = fs.readFileSync(path.join(__dirname, '../scripts/watchdog-supervisor.js'), 'utf8');
  assert.ok(watchdog.indexOf('STOP_FILE') < watchdog.indexOf('if (fs.existsSync(RELOAD_FILE))'));
});
