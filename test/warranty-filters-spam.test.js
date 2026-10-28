const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { createWarrantyAdminApi } = require('../src/warranty-api');
const { detectWarrantySpam, SPAM_SQL_PREDICATE } = require('../src/warranty-spam');

test('warranty spam detection heuristics accurately identify valid vs junk/spam requests', () => {
  // 1. Legitimate external warranty request
  const valid = detectWarrantySpam({
    automatic: false,
    status: 'pending',
    contactPhone: '0988123456',
    contactName: 'Trần Văn Cường',
    external_order_number: 'SPX-982173491',
    serial: 'GAERU-PRO-01',
    contactEmail: 'cuong.tran@gmail.com',
    claimedPurchaseDate: '2026-03-15'
  });
  assert.equal(valid.isSpam, false);
  assert.equal(valid.spamReasons.length, 0);

  // 2. Already approved warranty is never spam
  const active = detectWarrantySpam({
    automatic: false,
    status: 'active',
    contactPhone: '0123456789',
    contactName: 'test spam'
  });
  assert.equal(active.isSpam, false);

  // 3. Fake / sequential phone number
  const spamPhone = detectWarrantySpam({
    automatic: false,
    status: 'pending',
    contactPhone: '0123456789',
    contactName: 'Nguyễn Văn A'
  });
  assert.equal(spamPhone.isSpam, true);
  assert.ok(spamPhone.spamReasons.some(r => r.includes('dãy số thứ tự') || r.includes('chuẩn 10 số')));

  // 4. Repeated digits phone number
  const spamRepeatPhone = detectWarrantySpam({
    automatic: false,
    status: 'pending',
    contactPhone: '0999999999',
    contactName: 'Nguyễn Văn B'
  });
  assert.equal(spamRepeatPhone.isSpam, true);
  assert.ok(spamRepeatPhone.spamReasons.some(r => r.includes('toàn số lặp') || r.includes('chuẩn 10 số')));

  // 5. Test/spam dummy name
  const spamName = detectWarrantySpam({
    automatic: false,
    status: 'pending',
    contactPhone: '0912345678',
    contactName: 'test asdf spam'
  });
  assert.equal(spamName.isSpam, true);
  assert.ok(spamName.spamReasons.some(r => r.includes('từ khóa thử nghiệm')));

  // 6. Disposable email domain
  const spamEmail = detectWarrantySpam({
    automatic: false,
    status: 'pending',
    contactPhone: '0912345678',
    contactName: 'Lê Hoàng',
    contactEmail: 'fake_buyer@tempmail.com'
  });
  assert.equal(spamEmail.isSpam, true);
  assert.ok(spamEmail.spamReasons.some(r => r.includes('hòm thư tạm thời')));

  // 7. Previously rejected for spam
  const rejectedSpam = detectWarrantySpam({
    automatic: false,
    status: 'rejected',
    contactPhone: '0912345678',
    contactName: 'Lê Hoàng',
    reason: 'Hồ sơ rác / thông tin không có thật.'
  });
  assert.equal(rejectedSpam.isSpam, true);
  assert.ok(rejectedSpam.spamReasons.some(r => r.includes('thông tin rác')));
});

test('warranty admin UI renders filter tabs, tab badges and spam alerts', async () => {
  const listeners = {};
  const root = {
    innerHTML: '',
    addEventListener: (k, fn) => { listeners[k] = fn; },
    contains: () => true,
    querySelector: () => ({ innerHTML: '' })
  };

  const records = [
    {
      id: 'active-1',
      orderKey: 'order-approved',
      orderNumber: 'ORDER-OK-1',
      channel: 'shopee',
      productName: 'GAERU K9 Pro',
      claimedPurchaseDate: '2026-02-01',
      purchaseDate: '2026-02-01',
      expiresOn: '2027-02-01',
      status: 'active',
      isSpam: false,
      version: 1
    },
    {
      id: 'pending-1',
      orderKey: 'order-pending',
      orderNumber: 'ORDER-PENDING-1',
      channel: 'tiktok',
      productName: 'GAERU M3',
      claimedPurchaseDate: '2026-03-01',
      status: 'pending',
      isSpam: false,
      version: 1
    },
    {
      id: 'spam-1',
      orderKey: 'order-spam',
      orderNumber: 'TEST-123',
      channel: 'lazada',
      productName: 'GAERU Earbuds',
      claimedPurchaseDate: '2026-01-01',
      status: 'pending',
      isSpam: true,
      spamReasons: ['Số điện thoại là dãy số thứ tự hoặc số giả định', 'Họ tên chứa từ khóa thử nghiệm / spam'],
      version: 1
    }
  ];

  let requestedUrl = '';
  const window = {
    GAERUAdmin: {
      can: () => true,
      request: async (url) => {
        requestedUrl = url;
        return {
          activations: records,
          today: '2026-10-28',
          pagination: { hasNext: false },
          counts: { total: 3, active: 1, pending: 1, spam: 1 }
        };
      },
      showGlobal: () => {}
    }
  };

  vm.runInNewContext(fs.readFileSync(require.resolve('../admin/warranty.js'), 'utf8'), {
    window,
    document: { querySelector: () => root }
  });

  await window.GAERUWarranty.load();

  // Verify filter tabs exist in HTML
  assert.ok(root.innerHTML.includes('class="warranty-filter-tabs"'));
  assert.ok(root.innerHTML.includes('data-warranty-filter="all"'));
  assert.ok(root.innerHTML.includes('data-warranty-filter="active"'));
  assert.ok(root.innerHTML.includes('data-warranty-filter="pending"'));
  assert.ok(root.innerHTML.includes('data-warranty-filter="spam"'));

  // Verify tab counts match
  assert.ok(root.innerHTML.includes('Tất cả <span class="warranty-tab-count">3</span>'));
  assert.ok(root.innerHTML.includes('Đã duyệt <span class="warranty-tab-count is-active">1</span>'));
  assert.ok(root.innerHTML.includes('Chưa duyệt <span class="warranty-tab-count is-pending">1</span>'));
  assert.ok(root.innerHTML.includes('⚠️ Yêu cầu rác <span class="warranty-tab-count is-spam">1</span>'));

  // Verify spam warning alert and tag are present
  assert.ok(root.innerHTML.includes('warranty-spam-alert'));
  assert.ok(root.innerHTML.includes('Số điện thoại là dãy số thứ tự hoặc số giả định'));
  assert.ok(root.innerHTML.includes('warranty-spam-tag'));

  // Verify clicking filter tab triggers load with filter param
  const fakeTab = {
    dataset: { warrantyFilter: 'spam' },
    closest: (selector) => selector === '[data-warranty-filter]' ? fakeTab : null
  };
  await listeners.click({ target: fakeTab });
  assert.ok(requestedUrl.includes('filter=spam'));
});

test('warranty server API filters by active, pending, spam and returns accurate counts', async (t) => {
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) {
      const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
      return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
    },
    async connect() { return { query: pool.query, release() {} }; }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);

  // Seed sample activations:
  // 1. Approved warranty
  await pool.query(`INSERT INTO warranty_activations(channel, external_order_number, external_product_name, request_key, contact_name, contact_phone, status, automatic, purchase_date, expires_on)
    VALUES('shopee', 'SHP-APPROVED-1', 'GAERU K9', gen_random_uuid(), 'Nguyễn Thị Hoa', '0912345678', 'active', false, '2026-01-01', '2027-01-01')`);

  // 2. Legitimate pending warranty
  await pool.query(`INSERT INTO warranty_activations(channel, external_order_number, external_product_name, request_key, contact_name, contact_phone, status, automatic)
    VALUES('tiktok', 'TT-PENDING-2', 'GAERU M3', gen_random_uuid(), 'Trần Văn Mạnh', '0988654321', 'pending', false)`);

  // 3. Spam pending warranty (sequential phone, test name, dummy order)
  await pool.query(`INSERT INTO warranty_activations(channel, external_order_number, external_product_name, request_key, contact_name, contact_phone, status, automatic)
    VALUES('lazada', 'test', 'GAERU Speaker', gen_random_uuid(), 'test spam', '0123456789', 'pending', false)`);

  const router = createWarrantyAdminApi(pool);
  const routeLayer = router.stack.find(l => l.route && l.route.path === '/warranties');
  assert.ok(routeLayer, 'Route /warranties not found');
  const handlers = routeLayer.route.stack.map(s => s.handle);

  // Helper to invoke route handler through its middleware chain
  function callApi(query) {
    return new Promise((resolve, reject) => {
      const req = {
        query,
        admin: { id: 'admin-1', username: 'ceo', permissions: ['orders.read'] }
      };
      let statusCode = 200;
      const res = {
        status(c) { statusCode = c; return this; },
        json(d) { resolve({ status: statusCode, data: d }); return this; }
      };

      let idx = 0;
      const next = (err) => {
        if (err) return reject(err);
        if (idx < handlers.length) {
          const fn = handlers[idx++];
          try {
            const p = fn(req, res, next);
            if (p && typeof p.catch === 'function') p.catch(reject);
          } catch (e) {
            reject(e);
          }
        }
      };
      next();
    });
  }

  // 1. Query all
  const allRes = await callApi({ filter: 'all' });
  assert.equal(allRes.status, 200);
  assert.equal(allRes.data.counts.total, 3);
  assert.equal(allRes.data.counts.active, 1);
  assert.equal(allRes.data.counts.pending, 2);
  assert.equal(allRes.data.counts.spam, 1);
  assert.equal(allRes.data.activations.length, 3);

  // 2. Query active only
  const activeRes = await callApi({ filter: 'active' });
  assert.equal(activeRes.status, 200);
  assert.equal(activeRes.data.activations.length, 1);
  assert.equal(activeRes.data.activations[0].status, 'active');

  // 3. Query pending only
  const pendingRes = await callApi({ filter: 'pending' });
  assert.equal(pendingRes.status, 200);
  assert.equal(pendingRes.data.activations.length, 2);
  assert.ok(pendingRes.data.activations.every(w => w.status === 'pending'));

  // 4. Query spam only
  const spamRes = await callApi({ filter: 'spam' });
  assert.equal(spamRes.status, 200);
  assert.equal(spamRes.data.activations.length, 1);
  assert.equal(spamRes.data.activations[0].isSpam, true);
  assert.ok(spamRes.data.activations[0].spamReasons.length > 0);
});
