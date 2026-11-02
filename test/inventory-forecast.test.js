'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const {
  ForecastCache,
  globalForecastCache,
  round,
  calculateInventoryForecast,
  getVariantForecastDetail,
  upsertReorderSettings,
  createPurchaseOrderFromForecast
} = require('../src/inventory-forecast');

const baseConfig = {
  NODE_ENV: 'test',
  PORT: 0,
  SESSION_SECRET: 'test-secret-at-least-32-chars-long-long',
  ADMIN_USERNAME: 'warehouse_lead',
  ADMIN_PASSWORD_HASH: bcrypt.hashSync('test-password', 4)
};

async function startApp(context, { pool, config = baseConfig } = {}) {
  const adaptedPool = Object.create(pool);
  adaptedPool.query = (sql, ...args) => {
    if (sql.includes('account_security')) return Promise.resolve({ rows: [], rowCount: 0 });
    return pool.query(sql, ...args);
  };
  if (pool.connect) {
    adaptedPool.connect = pool.connect.bind(pool);
  } else {
    adaptedPool.connect = async () => ({
      query: (sql, ...args) => adaptedPool.query(sql, ...args),
      release: () => {}
    });
  }

  const sessionStore = new session.MemoryStore();
  const app = createApp({
    config,
    pool: adaptedPool,
    sessionStore
  });

  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function loginAdmin(baseUrl) {
  const csrf = await fetch(`${baseUrl}/api/csrf`);
  const csrfBody = await csrf.json();
  const csrfCookie = csrf.headers.get('set-cookie').split(';')[0];

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfBody.csrfToken,
      Cookie: csrfCookie
    },
    body: JSON.stringify({ username: baseConfig.ADMIN_USERNAME, password: 'test-password' })
  });
  const loginBody = await login.json();
  const adminCookie = login.headers.get('set-cookie').split(';')[0];
  return { adminCookie, csrfToken: loginBody.csrfToken };
}

// 1. UNIT TEST: ForecastCache
test('ForecastCache: stores, retrieves, respects TTL, and invalidates keys', async () => {
  const cache = new ForecastCache(50); // 50ms TTL

  cache.set('wh1:30:all', { test: 123 });
  assert.deepEqual(cache.get('wh1:30:all'), { test: 123 });

  cache.set('wh2:30:all', { test: 456 });
  assert.equal(cache.size(), 2);

  // Invalidate by prefix
  cache.invalidate('wh1');
  assert.equal(cache.get('wh1:30:all'), null);
  assert.deepEqual(cache.get('wh2:30:all'), { test: 456 });

  // Expiration test
  await new Promise(r => setTimeout(r, 60));
  assert.equal(cache.get('wh2:30:all'), null);
});

// 2. UNIT TEST: Math rounding helper
test('round: correctly rounds floating values', () => {
  assert.equal(round(1.2345, 2), 1.23);
  assert.equal(round(1.2355, 2), 1.24);
  assert.equal(round(0.001, 2), 0);
  assert.equal(round(null), 0);
});

// 3. UNIT TEST: calculateInventoryForecast calculation logic
test('calculateInventoryForecast: computes velocity, ROP, DOS, and alerts accurately', async () => {
  const whId = '11111111-1111-4111-8111-111111111111';
  const varId = '22222222-2222-4222-8222-222222222222';

  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM warehouses WHERE')) {
        return {
          rows: [{ id: whId, code: 'MAIN', name: 'Kho Hà Nội', active: true }]
        };
      }
      if (sql.includes('FROM product_variants v')) {
        return {
          rows: [{
            variantId: varId,
            sku: 'GAERU-G1-BLK',
            variantName: 'G1 Ultra Đen',
            priceVnd: 1200000,
            costPriceVnd: 700000,
            imageUrl: '/img/g1.webp',
            productId: '33333333-3333-4333-8333-333333333333',
            productName: 'Robot Hút Bụi GAERU G1 Ultra',
            category: 'robot',
            warehouseId: whId,
            warehouseCode: 'MAIN',
            warehouseName: 'Kho Hà Nội',
            currentStock: 10 // current stock = 10
          }]
        };
      }
      if (sql.includes('osa_sales AS')) {
        // 60 units sold in 30 days => velocity = 2.00 units/day
        return {
          rows: [{ warehouseId: whId, variantId: varId, soldUnits: 60 }]
        };
      }
      if (sql.includes('purchase_order_items poi')) {
        // 5 units incoming on PO
        return {
          rows: [{ warehouseId: whId, variantId: varId, incomingUnits: 5 }]
        };
      }
      if (sql.includes('FROM inventory_reorder_settings')) {
        return {
          rows: [{
            warehouseId: whId,
            variantId: varId,
            leadTimeDays: 7,
            safetyStockDays: 7,
            manualSafetyStock: null,
            manualReorderPoint: null,
            minOrderQuantity: 10,
            targetStockDays: 30
          }]
        };
      }
      return { rows: [] };
    }
  };

  const result = await calculateInventoryForecast(pool, {
    warehouseId: whId,
    days: 30,
    useCache: false
  });

  assert.equal(result.items.length, 1);
  const item = result.items[0];

  // Daily velocity = 60 / 30 = 2.00
  assert.equal(item.salesVelocity, 2);
  assert.equal(item.soldUnits, 60);

  // Lead time demand = 2.0 * 7 = 14
  // Safety stock = 2.0 * 7 = 14
  assert.equal(item.safetyStock, 14);
  // Reorder point = 14 + 14 = 28
  assert.equal(item.reorderPoint, 28);

  // currentStock = 10, availableStock = 10 + 5 = 15
  assert.equal(item.currentStock, 10);
  assert.equal(item.availableStock, 15);

  // Days of supply = 10 / 2 = 5 days
  assert.equal(item.daysOfSupply, 5);

  // Status: since currentStock (10) <= Math.ceil(ROP * 0.4 = 11.2), it is 'critical'
  assert.equal(item.status, 'critical');

  // Suggested reorder quantity: target stock = (2 * 30) + 14 = 74. Needed = 74 - 15 = 59
  assert.equal(item.suggestedOrderQuantity, 59);
  assert.equal(item.estimatedCostVnd, 59 * 700000);
});

// 4. UNIT TEST: Manual ROP override takes precedence
test('calculateInventoryForecast: manualReorderPoint overrides calculated ROP', async () => {
  const whId = '11111111-1111-4111-8111-111111111111';
  const varId = '22222222-2222-4222-8222-222222222222';

  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM warehouses WHERE')) {
        return { rows: [{ id: whId, code: 'MAIN', name: 'Kho Hà Nội', active: true }] };
      }
      if (sql.includes('FROM product_variants v')) {
        return {
          rows: [{
            variantId: varId,
            sku: 'GAERU-G1',
            variantName: 'G1',
            priceVnd: 1000000,
            costPriceVnd: 500000,
            imageUrl: '',
            productId: 'prod-1',
            productName: 'G1',
            category: 'robot',
            warehouseId: whId,
            warehouseCode: 'MAIN',
            warehouseName: 'Kho Hà Nội',
            currentStock: 50
          }]
        };
      }
      if (sql.includes('osa_sales AS')) {
        return { rows: [{ warehouseId: whId, variantId: varId, soldUnits: 30 }] }; // 1.0/day
      }
      if (sql.includes('purchase_order_items poi')) {
        return { rows: [] };
      }
      if (sql.includes('FROM inventory_reorder_settings')) {
        return {
          rows: [{
            warehouseId: whId,
            variantId: varId,
            leadTimeDays: 7,
            safetyStockDays: 7,
            manualSafetyStock: 20, // manual safety stock
            manualReorderPoint: 45, // manual ROP override
            minOrderQuantity: 5,
            targetStockDays: 30
          }]
        };
      }
      return { rows: [] };
    }
  };

  const result = await calculateInventoryForecast(pool, { warehouseId: whId, days: 30, useCache: false });
  const item = result.items[0];

  assert.equal(item.safetyStock, 20);
  assert.equal(item.reorderPoint, 45); // Overridden manual value
  assert.equal(item.status, 'optimal'); // currentStock = 50 > 45 (optimal)
});

// 5. UNIT TEST: Upsert reorder settings and cache invalidation
test('upsertReorderSettings: inserts/updates settings and clears warehouse cache', async () => {
  const whId = '11111111-1111-4111-8111-111111111111';
  const varId = '22222222-2222-4222-8222-222222222222';
  let executedQuery = false;

  const pool = {
    query: async (sql, values) => {
      if (sql.includes('INSERT INTO inventory_reorder_settings')) {
        executedQuery = true;
        assert.equal(values[0], whId);
        assert.equal(values[1], varId);
        assert.equal(values[2], 14); // leadTimeDays
        return {
          rows: [{
            id: 'setting-1',
            warehouseId: whId,
            variantId: varId,
            leadTimeDays: 14,
            safetyStockDays: 10,
            manualSafetyStock: null,
            manualReorderPoint: 50,
            minOrderQuantity: 20,
            targetStockDays: 45
          }]
        };
      }
      return { rows: [] };
    }
  };

  globalForecastCache.set(`forecast:${whId}:30:all:all`, { data: 'old' });

  const saved = await upsertReorderSettings(pool, {
    warehouseId: whId,
    variantId: varId,
    leadTimeDays: 14,
    safetyStockDays: 10,
    manualReorderPoint: 50,
    minOrderQuantity: 20,
    targetStockDays: 45
  });

  assert.equal(executedQuery, true);
  assert.equal(saved.leadTimeDays, 14);
  assert.equal(saved.manualReorderPoint, 50);

  // Verifying cache was invalidated for whId
  assert.equal(globalForecastCache.get(`forecast:${whId}:30:all:all`), null);
});

// 6. UNIT TEST: createPurchaseOrderFromForecast
test('createPurchaseOrderFromForecast: atomically creates submitted PO from forecast recommendations', async () => {
  const supId = '44444444-4444-4444-8444-444444444444';
  const whId = '11111111-1111-4111-8111-111111111111';
  const varId = '22222222-2222-4222-8222-222222222222';

  let insertedPo = false;
  let insertedItem = false;

  const pool = {
    query: async (sql, values) => {
      if (sql.includes('FROM suppliers WHERE')) {
        return { rows: [{ id: supId, name: 'Công ty Công nghệ GAERU' }] };
      }
      if (sql.includes('FROM warehouses WHERE')) {
        return { rows: [{ id: whId, name: 'Kho chính' }] };
      }
      if (sql.includes('SELECT COUNT(*)::integer')) {
        return { rows: [{ total: 10 }] };
      }
      if (sql.includes('FROM product_variants v')) {
        return {
          rows: [{
            id: varId,
            sku: 'GAERU-G1',
            variantName: 'G1 Đen',
            costPriceVnd: 650000,
            priceVnd: 1200000,
            productName: 'Robot Hút Bụi GAERU G1'
          }]
        };
      }
      if (sql.includes('INSERT INTO purchase_orders')) {
        insertedPo = true;
        assert.equal(values[0], 'PO-' + new Date().getFullYear() + '-00011');
        assert.equal(values[1], supId);
        assert.equal(values[2], whId);
        assert.equal(values[6], 6500000); // 10 * 650,000 = 6,500,000
        return {
          rows: [{
            id: 'po-1',
            number: values[0],
            status: 'submitted',
            totalVnd: values[6],
            createdAt: new Date().toISOString()
          }]
        };
      }
      if (sql.includes('INSERT INTO purchase_order_items')) {
        insertedItem = true;
        assert.equal(values[1], varId);
        assert.equal(values[5], 10); // quantity
        assert.equal(values[6], 650000); // unit cost
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
    connect: async () => ({
      query: (sql, ...args) => pool.query(sql, ...args),
      release: () => {}
    })
  };

  const res = await createPurchaseOrderFromForecast(pool, {
    supplierId: supId,
    warehouseId: whId,
    items: [{ variantId: varId, quantity: 10, unitCostVnd: 650000 }],
    note: 'Đơn đặt hàng theo gợi ý ROP tự động',
    actor: { id: 'admin-1', username: 'kho_truong' }
  });

  assert.equal(insertedPo, true);
  assert.equal(insertedItem, true);
  assert.equal(res.itemsCount, 1);
  assert.equal(res.totalVnd, 6500000);
  assert.ok(res.purchaseOrder.number.startsWith('PO-'));
});

// 7. INTEGRATION TEST: HTTP GET /api/gaeru_ceo/inventory/forecast
test('HTTP GET /api/gaeru_ceo/inventory/forecast returns forecast data and metrics', async (context) => {
  const whId = '11111111-1111-4111-8111-111111111111';
  const varId = '22222222-2222-4222-8222-222222222222';

  const pool = {
    query: async (sql) => {
      if (sql.includes('FROM warehouses WHERE')) {
        return { rows: [{ id: whId, code: 'MAIN', name: 'Kho chính', active: true }] };
      }
      if (sql.includes('FROM product_variants v')) {
        return {
          rows: [{
            variantId: varId,
            sku: 'GAERU-TEST-1',
            variantName: 'Test Variant',
            priceVnd: 500000,
            costPriceVnd: 300000,
            imageUrl: '',
            productId: 'p-1',
            productName: 'Test Product',
            category: 'test',
            warehouseId: whId,
            warehouseCode: 'MAIN',
            warehouseName: 'Kho chính',
            currentStock: 0 // Out of stock
          }]
        };
      }
      if (sql.includes('osa_sales AS')) {
        return { rows: [{ warehouseId: whId, variantId: varId, soldUnits: 90 }] }; // 3/day
      }
      if (sql.includes('purchase_order_items poi')) {
        return { rows: [] };
      }
      if (sql.includes('FROM inventory_reorder_settings')) {
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const baseUrl = await startApp(context, { pool });
  const { adminCookie } = await loginAdmin(baseUrl);

  const res = await fetch(`${baseUrl}/api/gaeru_ceo/inventory/forecast?days=30&refresh=true`, {
    headers: { Cookie: adminCookie }
  });

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok(data.metrics);
  assert.equal(data.metrics.totalSkus, 1);
  assert.equal(data.metrics.outOfStockCount, 1);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].status, 'out_of_stock');
  assert.equal(data.items[0].salesVelocity, 3);
  assert.equal(data.items[0].reorderPoint, 42); // (3 * 7) + (3 * 7) = 42
});

// 8. INTEGRATION TEST: HTTP PUT /api/gaeru_ceo/inventory/forecast/settings
test('HTTP PUT /api/gaeru_ceo/inventory/forecast/settings updates parameters with validation', async (context) => {
  const whId = '11111111-1111-4111-8111-111111111111';
  const varId = '22222222-2222-4222-8222-222222222222';

  const pool = {
    query: async (sql, values) => {
      if (sql.includes('INSERT INTO inventory_reorder_settings')) {
        return {
          rows: [{
            id: 'set-1',
            warehouseId: values[0],
            variantId: values[1],
            leadTimeDays: values[2],
            safetyStockDays: values[3],
            manualSafetyStock: values[4],
            manualReorderPoint: values[5],
            minOrderQuantity: values[6],
            targetStockDays: values[7]
          }]
        };
      }
      return { rows: [] };
    }
  };

  const baseUrl = await startApp(context, { pool });
  const { adminCookie, csrfToken } = await loginAdmin(baseUrl);

  // 1. Invalid payload rejection
  const badRes = await fetch(`${baseUrl}/api/gaeru_ceo/inventory/forecast/settings`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Cookie: adminCookie
    },
    body: JSON.stringify({ warehouseId: 'invalid-uuid', variantId: 'not-a-uuid' })
  });
  assert.equal(badRes.status, 400);

  // 2. Valid update
  const okRes = await fetch(`${baseUrl}/api/gaeru_ceo/inventory/forecast/settings`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Cookie: adminCookie
    },
    body: JSON.stringify({
      warehouseId: whId,
      variantId: varId,
      leadTimeDays: 10,
      safetyStockDays: 14,
      manualReorderPoint: 60,
      minOrderQuantity: 15,
      targetStockDays: 45
    })
  });
  assert.equal(okRes.status, 200);
  const okData = await okRes.json();
  assert.equal(okData.success, true);
  assert.equal(okData.settings.leadTimeDays, 10);
  assert.equal(okData.settings.manualReorderPoint, 60);
});

// 9. INTEGRATION TEST: HTTP POST /api/gaeru_ceo/inventory/forecast/create-po
test('HTTP POST /api/gaeru_ceo/inventory/forecast/create-po creates purchase order', async (context) => {
  const supId = '44444444-4444-4444-8444-444444444444';
  const whId = '11111111-1111-4111-8111-111111111111';
  const varId = '22222222-2222-4222-8222-222222222222';

  const pool = {
    query: async (sql, values) => {
      if (sql.includes('FROM suppliers WHERE')) return { rows: [{ id: supId, name: 'Nhà cung cấp Gaeru' }] };
      if (sql.includes('FROM warehouses WHERE')) return { rows: [{ id: whId, name: 'Kho chính' }] };
      if (sql.includes('SELECT COUNT(*)::integer')) return { rows: [{ total: 5 }] };
      if (sql.includes('FROM product_variants v')) return { rows: [{ id: varId, sku: 'SKU-PO', variantName: 'Var', costPriceVnd: 200000, priceVnd: 400000, productName: 'P' }] };
      if (sql.includes('INSERT INTO purchase_orders')) {
        return { rows: [{ id: 'po-test-1', number: values[0], status: 'submitted', totalVnd: values[6] }] };
      }
      return { rows: [] };
    }
  };

  const baseUrl = await startApp(context, { pool });
  const { adminCookie, csrfToken } = await loginAdmin(baseUrl);

  const res = await fetch(`${baseUrl}/api/gaeru_ceo/inventory/forecast/create-po`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Cookie: adminCookie
    },
    body: JSON.stringify({
      supplierId: supId,
      warehouseId: whId,
      items: [{ variantId: varId, quantity: 25, unitCostVnd: 200000 }],
      note: 'PO tự động tạo từ ROP'
    })
  });

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.itemsCount, 1);
  assert.equal(data.totalVnd, 5000000);
  assert.ok(data.purchaseOrder.number);
});

// 10. INTEGRATION TEST: Clear cache endpoint
test('HTTP POST /api/gaeru_ceo/inventory/forecast/clear-cache resets forecast cache', async (context) => {
  const pool = { query: async () => ({ rows: [] }) };
  const baseUrl = await startApp(context, { pool });
  const { adminCookie, csrfToken } = await loginAdmin(baseUrl);

  globalForecastCache.set('test:key', { val: 1 });
  assert.equal(globalForecastCache.size() > 0, true);

  const res = await fetch(`${baseUrl}/api/gaeru_ceo/inventory/forecast/clear-cache`, {
    method: 'POST',
    headers: {
      'X-CSRF-Token': csrfToken,
      Cookie: adminCookie
    }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(globalForecastCache.size(), 0);
});
