const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');

test('Product visibility toggle API hides and reveals products with variant validation and audit logging', { timeout: 60000 }, async (t) => {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise(r => (release = r));
    await previous;
    return release;
  }
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try {
        return await query(sql, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    }
  };

  await migrateDatabase(pool);

  const password = 'Product-visibility-password-2026';
  const app = createApp({
    pool,
    sessionStore: new session.MemoryStore(),
    config: {
      NODE_ENV: 'test',
      SESSION_SECRET: 'product-visibility-test-session-secret-32-chars!',
      ADMIN_USERNAME: 'visibility-admin',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync(password, 4)
    }
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => {
    await new Promise(r => server.close(r));
    await db.close();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '', csrf = '';

  async function api(path, method = 'GET', body, withCsrf = true) {
    const r = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        ...(withCsrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {})
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
    });
    if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
    const data = r.headers.get('content-type')?.includes('application/json') ? await r.json() : null;
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: r.status, data };
  }

  // 1. Login
  await api('/api/csrf');
  const loginRes = await api('/api/auth/login', 'POST', { username: 'visibility-admin', password });
  assert.equal(loginRes.status, 200);

  // 2. Create product with initial active=false
  const createRes = await api('/api/gaeru_ceo/products', 'POST', {
    name: 'Micro GAERU K9 Pro Test',
    slug: 'gaeru-k9-pro-test',
    category: 'audio',
    descriptor: 'Micro thu âm chất lượng cao',
    description: 'Chi tiết sản phẩm test',
    imageUrl: '/assets/products/k9.webp',
    imageAlt: 'Micro GAERU K9 Pro Test',
    sortOrder: 0
  });
  assert.equal(createRes.status, 201);
  const productId = createRes.data.id;

  // 3. Try to make product active BEFORE adding any variant -> Should fail with 409
  const activateNoVariant = await api(`/api/gaeru_ceo/products/${productId}/visibility`, 'POST', { active: true });
  assert.equal(activateNoVariant.status, 409);
  assert.match(activateNoVariant.data.error, /ít nhất một phiên bản/);

  // 4. Add an active variant
  const variantRes = await api(`/api/gaeru_ceo/products/${productId}/variants`, 'POST', {
    sku: 'K9-PRO-TEST-01',
    name: 'Bản Type-C',
    options: { 'Cổng kết nối': 'Type-C' },
    priceVnd: 450000,
    stockQuantity: 15,
    active: true
  });
  assert.equal(variantRes.status, 201);
  const variantId = variantRes.data.id;

  // 5. Activate product (Hiện sản phẩm)
  const activateRes = await api(`/api/gaeru_ceo/products/${productId}/visibility`, 'POST', { active: true });
  assert.equal(activateRes.status, 200);
  assert.equal(activateRes.data.active, true);
  assert.match(activateRes.data.message, /Đã hiển thị/);

  // Check public storefront: product MUST be visible
  const storefront1 = await api('/api/products');
  assert.equal(storefront1.status, 200);
  assert.ok(storefront1.data.products.some(p => p.id === productId), 'Sản phẩm phải xuất hiện trên gian hàng công khai');

  // 6. Test CSRF protection
  const noCsrfRes = await api(`/api/gaeru_ceo/products/${productId}/visibility`, 'POST', { active: false }, false);
  assert.equal(noCsrfRes.status, 403);

  // 7. Hide product (Ẩn sản phẩm)
  const hideRes = await api(`/api/gaeru_ceo/products/${productId}/visibility`, 'POST', { active: false });
  assert.equal(hideRes.status, 200);
  assert.equal(hideRes.data.active, false);
  assert.match(hideRes.data.message, /Đã ẩn sản phẩm/);

  // Check public storefront: product MUST NOT be visible anymore
  const storefront2 = await api('/api/products');
  assert.equal(storefront2.status, 200);
  assert.ok(!storefront2.data.products.some(p => p.id === productId), 'Sản phẩm đã ẩn không được hiển thị trên gian hàng');

  // 8. Test PATCH method as well
  const patchRes = await api(`/api/gaeru_ceo/products/${productId}/visibility`, 'PATCH', { active: true });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.data.active, true);

  // 9. When product is hidden, deactivate its only variant
  // First make sure product is hidden
  await api(`/api/gaeru_ceo/products/${productId}/visibility`, 'POST', { active: false });

  // Now we can deactivate the variant because product is hidden
  const deactRes = await api(`/api/gaeru_ceo/variants/${variantId}`, 'PUT', {
    sku: 'K9-PRO-TEST-01',
    name: 'Bản Type-C',
    options: { 'Cổng kết nối': 'Type-C' },
    priceVnd: 450000,
    stockQuantity: 15,
    active: false
  });
  assert.equal(deactRes.status, 200);

  // Now try to reveal the product without any active variant -> Must fail with 409
  const failReveal = await api(`/api/gaeru_ceo/products/${productId}/visibility`, 'POST', { active: true });
  assert.equal(failReveal.status, 409);
  assert.match(failReveal.data.error, /ít nhất một phiên bản/);

  // 10. Verify audit events recorded hide and publish actions
  const auditRows = (await pool.query("SELECT action, entity_type, entity_id FROM audit_events WHERE entity_id = $1 ORDER BY id ASC", [productId])).rows;
  assert.ok(auditRows.some(a => a.action === 'catalog.product.publish'), 'Phải có audit log catalog.product.publish');
  assert.ok(auditRows.some(a => a.action === 'catalog.product.hide'), 'Phải có audit log catalog.product.hide');
});

test('Admin UI renders "Ẩn sản phẩm" and "Hiện sản phẩm" buttons in product row actions', () => {
  const adminJsContent = fs.readFileSync(path.join(__dirname, '../admin/admin.js'), 'utf8');

  // Verify button markup is in renderProducts
  assert.match(adminJsContent, /data-toggle-visibility/);
  assert.match(adminJsContent, /Ẩn sản phẩm/);
  assert.match(adminJsContent, /Hiện sản phẩm/);

  // Verify event handling is registered on product-list
  assert.match(adminJsContent, /toggleVisibility/);
  assert.match(adminJsContent, /\/api\/gaeru_ceo\/products\/'\+encodeURIComponent\(product\.id\)\+'\/visibility/);

  // Verify product-editor.js has clear guidance for draft / hide
  const editorJsContent = fs.readFileSync(path.join(__dirname, '../admin/product-editor.js'), 'utf8');
  assert.match(editorJsContent, /Ẩn sản phẩm \(về bản nháp\)/);
});
