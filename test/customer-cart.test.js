const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { createCustomerCartRouter } = require('../src/customer-cart');

test('Customer Cart & Multi-device Sync Integration Suite', async t => {
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

  // 1. Seed Customer and Products
  const custA = (await pool.query(
    "INSERT INTO customers(email, full_name, active) VALUES('cust-cart@gaeru.com', 'Khách Hàng Giỏ', true) RETURNING id"
  )).rows[0];

  const product = (await pool.query(
    "INSERT INTO products(name, slug, category, active) VALUES('Micro Thu Âm GAERU K9', 'gaeru-k9', 'audio', true) RETURNING id"
  )).rows[0];

  const variant1 = (await pool.query(
    "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, 'K9-TYPEC', 'Bản Type-C', 399000, 20, true) RETURNING id",
    [product.id]
  )).rows[0];

  const variant2 = (await pool.query(
    "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, 'K9-LIGHTNING', 'Bản Lightning', 449000, 15, true) RETURNING id",
    [product.id]
  )).rows[0];

  const inactiveVariant = (await pool.query(
    "INSERT INTO product_variants(product_id, sku, name, price_vnd, stock_quantity, active) VALUES($1, 'K9-DISCONTINUED', 'Bản ngừng bán', 300000, 0, false) RETURNING id",
    [product.id]
  )).rows[0];

  // 2. Setup Express test app
  const app = express();
  app.use(express.json());

  let activeSessionCustomer = custA.id;
  let csrfTokenValue = 'valid-csrf-token';

  app.use((req, res, next) => {
    req.session = {
      customer: activeSessionCustomer ? { id: activeSessionCustomer } : null,
      csrfToken: csrfTokenValue
    };
    next();
  });

  // Mock CSRF validation matching requireCsrf
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const token = req.headers['x-csrf-token'];
      if (token !== csrfTokenValue) {
        return res.status(403).json({ error: 'CSRF token không hợp lệ.' });
      }
    }
    next();
  });

  app.use('/api/customer/cart', createCustomerCartRouter(pool));

  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => {
    server.closeAllConnections?.();
    server.close(r);
  }));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/customer/cart`;

  const headers = {
    'Content-Type': 'application/json',
    'x-csrf-token': csrfTokenValue
  };

  // 3. Test: Unauthenticated access is blocked (401)
  activeSessionCustomer = null;
  const unauthRes = await fetch(baseUrl);
  assert.equal(unauthRes.status, 401, 'Unauthenticated user must be rejected with 401');
  activeSessionCustomer = custA.id;

  // 4. Test: Initial empty cart
  const emptyRes = await fetch(baseUrl);
  assert.equal(emptyRes.status, 200);
  const emptyData = await emptyRes.json();
  assert.deepEqual(emptyData.items, [], 'Initial cart must be empty');

  // 5. Test: PUT / - Full sync overwrites cart and ignores inactive variants
  const putRes = await fetch(baseUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      items: [
        { variantId: variant1.id, quantity: 2 },
        { variantId: inactiveVariant.id, quantity: 1 } // Inactive variant must be filtered out
      ]
    })
  });
  assert.equal(putRes.status, 200);
  const putData = await putRes.json();
  assert.equal(putData.items.length, 1);
  assert.equal(putData.items[0].variantId, variant1.id);
  assert.equal(putData.items[0].quantity, 2);

  // 6. Test: GET / - Returns active item details
  const getRes = await fetch(baseUrl);
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  assert.equal(getData.items.length, 1);
  assert.equal(getData.items[0].variantId, variant1.id);
  assert.equal(getData.items[0].quantity, 2);
  assert.equal(getData.items[0].productName, 'Micro Thu Âm GAERU K9');
  assert.equal(getData.items[0].variantName, 'Bản Type-C');

  // 7. Test: POST /merge - Smart merge strategy
  // Scenario: Device B was used as guest and added:
  // - Variant 1 with quantity 3 (already on server with qty 2 => combined to 5)
  // - Variant 2 with quantity 1 (new to server => inserted)
  const mergeRes = await fetch(`${baseUrl}/merge`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      localItems: [
        { variantId: variant1.id, quantity: 3 },
        { variantId: variant2.id, quantity: 1 }
      ]
    })
  });
  assert.equal(mergeRes.status, 200);
  const mergeData = await mergeRes.json();
  assert.equal(mergeData.items.length, 2);

  const item1 = mergeData.items.find(i => i.variantId === variant1.id);
  const item2 = mergeData.items.find(i => i.variantId === variant2.id);
  assert.ok(item1);
  assert.ok(item2);
  assert.equal(item1.quantity, 5, 'Quantities for existing items must combine (2 + 3 = 5)');
  assert.equal(item2.quantity, 1, 'New items from local cart must be added to server');

  // 8. Test: Quantity clamping at ceiling 99
  const clampRes = await fetch(`${baseUrl}/merge`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      localItems: [
        { variantId: variant1.id, quantity: 98 }
      ]
    })
  });
  assert.equal(clampRes.status, 200);
  const clampData = await clampRes.json();
  const clampedItem = clampData.items.find(i => i.variantId === variant1.id);
  assert.equal(clampedItem.quantity, 99, 'Combined quantity must be clamped to max 99');

  // 9. Test: POST /item - Add or increment single item
  const addItemRes = await fetch(`${baseUrl}/item`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ variantId: variant2.id, quantity: 2 })
  });
  assert.equal(addItemRes.status, 200);

  const verifyAddRes = await fetch(baseUrl);
  const verifyAddData = await verifyAddRes.json();
  const updatedItem2 = verifyAddData.items.find(i => i.variantId === variant2.id);
  assert.equal(updatedItem2.quantity, 3, 'Variant 2 quantity must increment from 1 to 3');

  // 10. Test: DELETE /item/:variantId - Remove single item
  const delItemRes = await fetch(`${baseUrl}/item/${variant1.id}`, {
    method: 'DELETE',
    headers
  });
  assert.equal(delItemRes.status, 200);

  const afterDelRes = await fetch(baseUrl);
  const afterDelData = await afterDelRes.json();
  assert.equal(afterDelData.items.length, 1);
  assert.equal(afterDelData.items[0].variantId, variant2.id);

  // 11. Test: DELETE / - Clear entire cart
  const clearRes = await fetch(baseUrl, {
    method: 'DELETE',
    headers
  });
  assert.equal(clearRes.status, 200);

  const finalCheckRes = await fetch(baseUrl);
  const finalCheckData = await finalCheckRes.json();
  assert.deepEqual(finalCheckData.items, [], 'Cart must be completely empty after clear');
});
