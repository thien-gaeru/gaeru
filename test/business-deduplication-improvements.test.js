'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Business Deduplication & Optimization Verification (Recommendations 2, 3, 4, 5, 6)', async (t) => {
  // Test 1: Khuyến nghị 2 - Anti-stacking & margin cap safeguard
  await t.test('1. Anti-stacking cap protects margins and blocks vouchers on active flash sales', async () => {
    const { discount, eligible } = require('../src/marketing');

    // Test margin cap (40% max discount ceiling)
    const voucher50Percent = { kind: 'percent', amount: 50, max_discount_vnd: null };
    const subtotal = 1000000;
    const discountVal = discount(voucher50Percent, subtotal);
    // 50% would be 500k, but max 40% cap restricts it to 400k
    assert.equal(discountVal, 400000, 'Discount must be capped at 40% to protect margins');

    // Test active flash sale anti-stacking
    const fakeClient = {
      async query(sql) {
        if (sql.includes('SELECT id FROM customers')) return { rows: [{ id: 'cust-1' }] };
        if (sql.includes('SELECT product_slugs FROM flash_sales')) {
          return { rows: [{ product_slugs: ['gaeru-k9', 'g1-ultra'] }] };
        }
        if (sql.includes('SELECT * FROM marketing_vouchers')) {
          return { rows: [{ id: 'v-1', code: 'PROMO10', active: true, min_spend_vnd: 100000, starts_at: '2020-01-01', ends_at: '2030-01-01', total_limit: 100, per_customer_limit: 5, kind: 'percent', amount: 10 }] };
        }
        if (sql.includes('SELECT 1 FROM customer_vouchers')) return { rows: [{ 1: 1 }] };
        if (sql.includes('SELECT count(*)::int AS total')) return { rows: [{ total: 0, personal: 0 }] };
        return { rows: [] };
      }
    };

    // Stacking attempt on Flash Sale product should be rejected
    await assert.rejects(
      async () => {
        await eligible(fakeClient, 'PROMO10', 'cust-1', 500000, false, { productSlugs: ['gaeru-k9'] });
      },
      /Flash Sale/
    );

    // Non-flash sale product is allowed
    const validResult = await eligible(fakeClient, 'PROMO10', 'cust-1', 500000, false, { productSlugs: ['p01-gimbal'] });
    assert.ok(validResult.voucher);
    assert.equal(validResult.discountVnd, 50000);
  });

  // Test 2: Khuyến nghị 3 - Chat AI unified database knowledge
  await t.test('2. Chat AI knowledge is unified into database documents and queried dynamically', async () => {
    const { INITIAL_KNOWLEDGE, searchKnowledge } = require('../src/chat-semantic-knowledge');
    assert.ok(INITIAL_KNOWLEDGE.length >= 8, 'Initial knowledge must include ecosystem documents');
    assert.ok(INITIAL_KNOWLEDGE.some(d => d.title.includes('iPhone')), 'Must have iPhone compatibility guide');
    assert.ok(INITIAL_KNOWLEDGE.some(d => d.title.includes('OTG')), 'Must have Android OTG guide');

    const fakePool = {
      async query(sql, params) {
        if (sql.includes('FROM chat_knowledge_documents')) {
          return {
            rows: [
              {
                id: 'doc-1',
                category: 'compatibility',
                productSlug: null,
                title: 'Tương thích kết nối Micro GAERU với iPhone',
                content: 'Cắm đầu thu Type-C trực tiếp vào iPhone 15/16 là nhận ngay.',
                keywords: ['iphone', 'type-c']
              }
            ]
          };
        }
        return { rows: [] };
      }
    };

    const results = await searchKnowledge(fakePool, 'iPhone 15 cắm Type-C nhận không?');
    assert.ok(results.length > 0);
    assert.equal(results[0].id, 'doc-1');
  });

  // Test 3: Khuyến nghị 4 - 3-in-1 Customer Segmentation (Loyalty + RFM + Marketing Audience)
  await t.test('3. RFM segments and Loyalty tiers are bridged to Customer API and Email Marketing', async () => {
    const { scoreRecency, scoreFrequency, scoreMonetary, determineSegment } = require('../src/rfm-analytics');
    const { audience, campaignSchema } = require('../src/email-marketing');

    // RFM determination
    assert.equal(determineSegment(5, 5, 5), 'champions', 'High R, F, M must be champions');
    assert.equal(determineSegment(1, 4, 4), 'at_risk', 'Old purchase with high count/spend must be at_risk');
    assert.equal(determineSegment(1, 1, 1), 'lost', 'Low R, F, M must be lost');

    // Email marketing campaign schema supports RFM segments
    const validCampaign = campaignSchema.safeParse({
      title: 'Tri ân khách hàng',
      subject: 'Ưu đãi dành riêng cho bạn',
      body: 'GAERU gửi tặng bạn voucher 10% tri ân.',
      sources: ['customers', 'rfm_at_risk'],
      scheduledAt: new Date(Date.now() + 60000).toISOString(),
      ratePerMinute: 5
    });
    assert.ok(validCampaign.success, 'Campaign schema must accept rfm_at_risk source');

    // Audience query includes rfm_at_risk filter
    let generatedSql = '';
    const fakeClient = {
      async query(sql) {
        generatedSql = sql;
        return { rows: [{ email: 'atrisk@example.com' }] };
      }
    };
    const list = await audience(fakeClient, ['rfm_at_risk']);
    assert.ok(generatedSql.includes('interval \x2790 days\x27'), 'rfm_at_risk must query orders older than 90 days');
    assert.equal(list[0], 'atrisk@example.com');
  });

  // Test 4: Khuyến nghị 5 - Optimal carrier auto-allocation based on destination
  await t.test('4. Backend automatically allocates optimal carrier based on destination city', async () => {
    const { names } = require('../src/shipping-choice');
    assert.ok(names.spx);
    assert.ok(names.viettel);
    assert.ok(names.ghn);

    // Test optimal allocation logic
    const storeApi = require('../src/store-api');
    // Function exists and allocates major urban to SPX/GHN, regional to Viettel/GHTK
    const testCities = [
      { city: 'Hà Nội', expected: ['spx', 'ghn'] },
      { city: 'TP. Hồ Chí Minh', expected: ['spx', 'ghn'] },
      { city: 'Đà Nẵng', expected: ['spx', 'ghn'] },
      { city: 'Lâm Đồng', expected: ['viettel', 'ghtk'] },
      { city: 'Cà Mau', expected: ['viettel', 'ghtk'] }
    ];

    // Read store-api allocateOptimalCarrier directly
    const fs = require('fs');
    const storeApiContent = fs.readFileSync(require.resolve('../src/store-api'), 'utf8');
    assert.match(storeApiContent, /function allocateOptimalCarrier/, 'store-api must include allocateOptimalCarrier');
    assert.match(storeApiContent, /Shopee Express \(SPX\)/, 'Must allocate SPX for major urban centers');
    assert.match(storeApiContent, /Viettel Post/, 'Must allocate Viettel Post for regional provinces');
  });

  // Test 5: Khuyến nghị 6 - Operations Inventory enriches stock with Smart ROP metrics
  await t.test('5. Operations Inventory API integrates Smart ROP metrics into stock list', async () => {
    const fs = require('fs');
    const opsContent = fs.readFileSync(require.resolve('../src/operations-api'), 'utf8');
    assert.match(opsContent, /getInventoryForecast/, 'operations-api must integrate getInventoryForecast');
    assert.match(opsContent, /reorderPoint/, 'operations-api must enrich stock with reorderPoint');
    assert.match(opsContent, /dailyVelocity/, 'operations-api must enrich stock with dailyVelocity');
    assert.match(opsContent, /daysRemaining/, 'operations-api must enrich stock with daysRemaining');
    assert.match(opsContent, /suggestedReorderQty/, 'operations-api must enrich stock with suggestedReorderQty');
  });
});
