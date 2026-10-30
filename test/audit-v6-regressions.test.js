'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const ROOT_DIR = path.resolve(__dirname, '..');

test('Audit v6 Item 1: Node version configuration is synchronized to 24.22.2 and engines >=24 <25', () => {
  const nodeVersion = fs.readFileSync(path.join(ROOT_DIR, '.node-version'), 'utf8').trim();
  const nvmrc = fs.readFileSync(path.join(ROOT_DIR, '.nvmrc'), 'utf8').trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));

  assert.equal(nodeVersion, '24.22.2', '.node-version must specify 24.22.2');
  assert.equal(nvmrc, '24.22.2', '.nvmrc must specify 24.22.2');
  assert.match(pkg.engines?.node || '', />=\s*24/, 'package.json engine must require Node >= 24');
});

test('Audit v6 Item 2: finance-api & payment-policy block manual receipts for momo, zalopay, vnpay and 9pay', () => {
  const { isOnlineGateway, ONLINE_GATEWAYS } = require('../src/domain/payments/payment-policy');
  assert.ok(isOnlineGateway('vnpay'), 'vnpay is online gateway');
  assert.ok(isOnlineGateway('9pay'), '9pay is online gateway');
  assert.ok(isOnlineGateway('momo'), 'momo is online gateway');
  assert.ok(isOnlineGateway('zalopay'), 'zalopay is online gateway');

  for (const gw of ['vnpay', '9pay', 'momo', 'zalopay']) {
    assert.ok(ONLINE_GATEWAYS.includes(gw), `ONLINE_GATEWAYS includes ${gw}`);
  }

  const financeSource = fs.readFileSync(path.join(ROOT_DIR, 'src', 'finance-api.js'), 'utf8');
  assert.ok(
    financeSource.includes('isOnlineGateway') || financeSource.includes('momo') && financeSource.includes('zalopay'),
    'finance-api must check isOnlineGateway or momo/zalopay to block manual receipts'
  );
});

test('Audit v6 Item 3: express.json verify preserves raw JSON text on req.rawBody', async () => {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf?.toString('utf8');
    }
  }));
  app.post('/test-raw-body', (req, res) => {
    res.json({ rawBody: req.rawBody, parsed: req.body });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/test-raw-body`;

  try {
    const rawPayload = '{\n  "event": "inventory.update",\n  "sku": "K9-BLACK",\n  "delta": 5\n}';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawPayload
    });
    const data = await resp.json();
    assert.equal(data.rawBody, rawPayload, 'req.rawBody must preserve exact original whitespace and formatting');
    assert.equal(data.parsed.sku, 'K9-BLACK');
  } finally {
    server.close();
  }
});

test('Audit v6 Item 4: omnichannel HMAC verification validates exact signature against rawBody', async () => {
  const { _webhookAuthMiddleware } = require('../src/omnichannel-sync');
  const secret = 'test-secret-key-at-least-32-chars-long';
  const rawBody = '{\n  "sku": "G1-ULTRA",\n  "delta": 2\n}';
  const ts = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');

  const middleware = _webhookAuthMiddleware({ OMNICHANNEL_WEBHOOK_SECRET: secret });
  let nextCalled = false;
  let responseStatus = null;

  const req = {
    headers: {
      'x-webhook-timestamp': String(ts),
      'x-webhook-signature': signature
    },
    rawBody,
    body: JSON.parse(rawBody)
  };
  const res = {
    status(s) { responseStatus = s; return this; },
    json() { return this; }
  };

  middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'Middleware must call next() when HMAC matches rawBody');
  assert.equal(responseStatus, null, 'No 401 error returned');
});

test('Audit v6 Item 5: Flash Sale with empty or null product_slugs does NOT reduce price for every product', async () => {
  const { PricingEngine } = require('../src/domain/pricing/pricing-engine');

  const fakeClient = {
    query: async (sql) => {
      if (sql.includes('FROM product_promotions')) {
        return { rows: [] };
      }
      if (sql.includes('FROM flash_sales')) {
        return {
          rows: [
            {
              id: 'fs-empty-1',
              title: 'Empty Slugs Sale',
              ends_at: new Date(Date.now() + 86400000).toISOString(),
              discount_percent: 50,
              product_slugs: [] // EMPTY SLUGS
            },
            {
              id: 'fs-empty-2',
              title: 'Null Slugs Sale',
              ends_at: new Date(Date.now() + 86400000).toISOString(),
              discount_percent: 40,
              product_slugs: '[]' // EMPTY JSON SLUGS
            }
          ]
        };
      }
      return { rows: [] };
    }
  };

  const testVariants = [
    { id: 'v1', productName: 'Bàn phím cơ K9', productSlug: 'gaeru-k9', priceVnd: 500000, quantity: 1 },
    { id: 'v2', productName: 'Chuột không dây G1', productSlug: 'gaeru-g1-ultra', priceVnd: 350000, quantity: 1 }
  ];

  const prepared = await PricingEngine.applyPromotions(fakeClient, testVariants);
  assert.equal(prepared[0].priceVnd, 500000, 'Price must NOT be reduced by flash sale with empty slugs');
  assert.equal(prepared[1].priceVnd, 350000, 'Price must NOT be reduced by flash sale with empty slugs');
  assert.equal(prepared[0].promotion, null, 'No promotion applied');
  assert.equal(prepared[1].promotion, null, 'No promotion applied');
});

test('Audit v6 Item 6: admin/barcode-scanner.js safely handles BarcodeDetector errors and checks !detector before camera start', () => {
  const script = fs.readFileSync(path.join(ROOT_DIR, 'admin', 'barcode-scanner.js'), 'utf8');

  // Must wrap constructor in try/catch
  assert.match(script, /try\s*\{\s*if\s*\('BarcodeDetector'\s*in\s*window\)\s*\{\s*detector\s*=\s*new\s*window\.BarcodeDetector/, 'Must catch constructor errors');

  // startCamera must guard against missing or null detector
  assert.match(script, /if\s*\(!\('BarcodeDetector'\s*in\s*window\)\s*\|\|\s*!detector\)/, 'startCamera must check !detector');
});

test('Audit v6 Item 7: account.js validates safe returnUrl and invokes handleLoginRedirect upon successful login', () => {
  const script = fs.readFileSync(path.join(ROOT_DIR, 'account.js'), 'utf8');

  // getValidReturnUrl must reject open redirects, backslashes and protocol-relative URLs
  assert.ok(script.includes("!target.startsWith('//')"), 'Rejects protocol-relative //');
  assert.ok(script.includes("!target.startsWith('/\\')") || script.includes('!target.startsWith(\'/\\\\\')'), 'Rejects /\\ bypasses');
  assert.ok(script.includes("!target.includes('\\')") || script.includes('!target.includes(\'\\\\\')'), 'Rejects backslash bypasses');

  // Login handlers must invoke handleLoginRedirect
  assert.ok(script.includes('function handleLoginRedirect'), 'Must define handleLoginRedirect');
  assert.ok(script.includes('if (!handleLoginRedirect())'), 'Login and register flows must invoke handleLoginRedirect()');
});

test('Audit P2-04: app.js scopes req.rawBody only to webhook routes', () => {
  const appSource = fs.readFileSync(path.join(ROOT_DIR, 'src', 'app.js'), 'utf8');
  assert.ok(
    appSource.includes("url.includes('/webhooks/')") || appSource.includes("url.includes('/webhook')"),
    'app.js must scope req.rawBody capture only to webhook endpoints'
  );
});

test('Audit P2-05: job-queue recovers stranded processing jobs older than lease timeout', async () => {
  const { createJobQueue } = require('../src/job-queue');
  let queriedSql = '';
  const fakePool = {
    query: async (sql, params) => {
      queriedSql += sql + '\n';
      if (sql.includes('UPDATE system_jobs') && sql.includes("status = 'processing'")) {
        return {
          rows: [{
            id: 'stranded-job-1',
            queue: 'default',
            name: 'test_task',
            payload: '{}',
            status: 'processing',
            attempts: 1,
            max_attempts: 5
          }]
        };
      }
      return { rows: [] };
    }
  };

  const queue = createJobQueue({ pool: fakePool });
  let jobHandled = false;
  queue.registerWorker('test_task', async () => {
    jobHandled = true;
  });

  queue.start();
  await queue.processOne();
  queue.stop();

  assert.ok(
    queriedSql.includes("status = 'processing' AND updated_at < now() - interval '5 minutes'"),
    'claimNextJob query must select stranded processing jobs older than 5 minutes'
  );
  assert.equal(jobHandled, true, 'Stranded job must be recovered and processed');
});

test('Audit P1-04: marketing eligible() checks across all active flash sales deterministically', async () => {
  const { eligible } = require('../src/marketing');
  let queriedSql = '';
  const fakePool = {
    query: async (sql, params) => {
      queriedSql += sql + '\n';
      if (sql.includes('FROM flash_sales')) {
        return {
          rows: [
            { id: 'fs-1', product_slugs: ['gaeru-k9'] },
            { id: 'fs-2', product_slugs: ['gaeru-g1-ultra'] }
          ]
        };
      }
      return { rows: [] };
    }
  };

  await assert.rejects(
    () => eligible(fakePool, 'TEST10', 'cust-1', 350000, false, { productSlugs: ['g1-ultra'] }),
    /Flash Sale/
  );
  assert.ok(!queriedSql.includes('LIMIT 1'), 'Must not restrict flash sales query to LIMIT 1');
});

test('Audit P1-05: flash-sale.js createFlashSale is transactional and validates non-empty productSlugs', async () => {
  const { createFlashSale } = require('../src/flash-sale');
  const flashSaleSource = fs.readFileSync(path.join(ROOT_DIR, 'src', 'flash-sale.js'), 'utf8');
  assert.ok(flashSaleSource.includes('withTransaction'), 'createFlashSale must use withTransaction');

  await assert.rejects(
    () => createFlashSale({}, { title: 'Test', productSlugs: [] }),
    /Chiến dịch Flash Sale cần ít nhất một sản phẩm/
  );
});

test('Audit P1-06: PricingEngine applies bundle discount when main product and bundle items match', async () => {
  const { PricingEngine } = require('../src/domain/pricing/pricing-engine');
  const fakeClient = {
    query: async (sql, params) => {
      if (sql.includes('FROM product_promotions')) {
        return { rows: [] };
      }
      if (sql.includes('FROM flash_sales')) {
        return { rows: [] };
      }
      if (sql.includes('FROM product_bundles')) {
        return {
          rows: [{
            id: 'bundle-1',
            bundleTitle: 'Combo K9 + Keycap',
            mainProductSlug: 'gaeru-k9',
            bundleProductSlug: 'keycap-pbt',
            discountPercent: 20,
            active: true
          }]
        };
      }
      return { rows: [] };
    }
  };

  const lineItems = [
    { id: 'v1', productId: 'prod-k9', productName: 'Bàn phím cơ K9', productSlug: 'gaeru-k9', priceVnd: 500000, quantity: 1 },
    { id: 'v2', productId: 'prod-keycap', productName: 'Bộ Keycap PBT', productSlug: 'keycap-pbt', priceVnd: 200000, quantity: 1 }
  ];

  const evaluated = await PricingEngine.applyPromotions(fakeClient, lineItems);
  // The bundle product (keycap) receives a 20% discount (200000 * 0.8 = 160000)
  assert.equal(evaluated[0].priceVnd, 500000, 'Main product retains price');
  assert.equal(evaluated[1].priceVnd, 160000, 'Bundle product receives 20% discount');
  assert.equal(evaluated[1].promotion.type, 'bundle');
  assert.equal(evaluated[1].promotion.discountPercent, 20);
});
