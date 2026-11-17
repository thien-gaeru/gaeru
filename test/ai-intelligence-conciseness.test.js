'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const {
  expandQueryVi,
  hasBoundaryTerm,
  isTermNegated,
  extractOrderCodes,
  resolveMentionedProducts,
  matchProductVariants
} = require('../src/lib/ai-nlu');
const { generateGaeruAiResponse, lookupOrderInfo } = require('../src/gaeru-ai-customer');
const { sanitizePii, matchLearnedKnowledge, invalidateCache } = require('../src/ai-self-learning');
const { getExternalWebKnowledge } = require('../src/chat-external-knowledge');
const { createInternalAiRouter } = require('../src/internal-ai');

const REALISTIC_CATALOG = [
  {
    slug: 'gaeru-k9',
    name: 'GAERU K9',
    category: 'audio',
    descriptor: 'Mic cài áo nhỏ gọn. Cho những câu chuyện đầu tiên.',
    variants: [
      { id: 'k9-1c', name: '1 Micro · Type-C', sku: 'K9-1M-C', priceVnd: 289000, stockQuantity: 18, active: true },
      { id: 'k9-2c', name: '2 Micro · Type-C', sku: 'K9-2M-C', priceVnd: 389000, originalPriceVnd: 450000, stockQuantity: 7, active: true },
      { id: 'k9-2l', name: '2 Micro · Lightning', sku: 'K9-2M-L', priceVnd: 399000, stockQuantity: 0, active: true }
    ]
  },
  {
    slug: 'gaeru-m3',
    name: 'GAERU M3',
    category: 'audio',
    descriptor: 'Micro thu âm cài áo không dây kèm hộp sạc cao cấp.',
    variants: [
      { id: 'm3-std', name: '2 Micro + Hộp sạc Type-C', sku: 'M3-2M-BOX', priceVnd: 1200000, stockQuantity: 12, active: true }
    ]
  },
  {
    slug: 'gaeru-p01',
    name: 'GAERU P01',
    category: 'video',
    descriptor: 'Gimbal tự động theo người. Thêm linh hoạt cho khung hình.',
    variants: [
      { id: 'p01-desk', name: 'Bản để bàn', sku: 'P01-DESK', priceVnd: 550000, stockQuantity: 9, active: true },
      { id: 'p01-2m1', name: 'Bản kèm chân 2m1', sku: 'P01-2M1', priceVnd: 690000, stockQuantity: 4, active: true }
    ]
  },
  {
    slug: 'gaeru-g1-ultra',
    name: 'GAERU G1 ULTRA',
    category: 'audio',
    descriptor: 'Mic không dây đa thiết bị. Mở rộng không gian sáng tạo.',
    variants: [
      { id: 'g1-pro', name: 'Bộ 2 Micro đa thiết bị', sku: 'G1-ULTRA', priceVnd: 2100000, stockQuantity: 5, active: true }
    ]
  },
  {
    slug: 'gaeru-p185',
    name: 'GAERU P185',
    category: 'video',
    descriptor: 'Gậy chụp hình selfie 4 chân kéo dài 1m8.',
    variants: [
      { id: 'p185-std', name: 'Màu Đen · Kèm Remote', sku: 'P185-BLK', priceVnd: 450000, stockQuantity: 11, active: true }
    ]
  }
];

test('Shared Vietnamese NLU prevents substring false positives and handles shorthand/negation', () => {
  assert.equal(hasBoundaryTerm('giao hang toan quoc', 'gia'), false);
  assert.equal(hasBoundaryTerm('chon 1 trong 2', 'on'), false);
  assert.equal(hasBoundaryTerm('tao cho toi ma nay', 'cho'), true);
  assert.equal(hasBoundaryTerm('1m3 chieu cao', 'm3'), false);
  assert.equal(hasBoundaryTerm('mic m3 type-c', 'type c'), true);

  assert.equal(isTermNegated('toi khong can gap nhan vien', 'nhan vien'), true);
  assert.equal(isTermNegated('don hang chua huy dau', 'huy'), true);

  const expanded = expandQueryVi('ip15 cam typec bn tien vay ad, bh may thang?');
  assert.ok(expanded.includes('iphone 15'));
  assert.ok(expanded.includes('type-c'));
  assert.ok(expanded.includes('bao nhieu'));
  assert.ok(expanded.includes('bao hanh'));

  const orders = extractOrderCodes('Kiểm tra đơn GR-20261117-A1B2C3 và đơn cũ GAE-20261109-001');
  assert.deepEqual(orders, ['GR-20261117-A1B2C3', 'GAE-20261109-001']);

  const pickedVars = matchProductVariants('K9 bản 2 mic type c còn hàng ko?', REALISTIC_CATALOG[0].variants);
  assert.equal(pickedVars.length, 1);
  assert.equal(pickedVars[0].sku, 'K9-2M-C');

  const multiTurn = resolveMentionedProducts('thế giá sao bạn?', REALISTIC_CATALOG, {
    history: [{ sender: 'customer', body: 'Pin GAERU M3 dùng mấy tiếng?' }]
  });
  assert.equal(multiTurn.source, 'history');
  assert.equal(multiTurn.items[0].key, 'gaeru-m3');

  const switched = resolveMentionedProducts('còn K9 pin mấy tiếng?', REALISTIC_CATALOG, {
    history: [{ sender: 'customer', body: 'Pin GAERU M3 dùng mấy tiếng?' }]
  });
  assert.equal(switched.source, 'question');
  assert.equal(switched.items[0].key, 'gaeru-k9');
});

test('External knowledge & self-learning use strict boundary matching and PII-safe GR orders', async () => {
  const dirty = 'Khách đặt đơn GR-20261117-9F8E7D6C5B sđt 0912345678 cần hỗ trợ';
  const cleaned = sanitizePii(dirty);
  assert.ok(!cleaned.includes('GR-20261117-9F8E7D6C5B'));
  assert.ok(!cleaned.includes('20261117'));
  assert.ok(cleaned.includes('[MÃ_ĐƠN_HÀNG]'));
  assert.ok(cleaned.includes('[SĐT_ĐÃ_ẨN]'));

  // "Chọn đơn này" contains "on" as substring — must NOT trigger noise-reduction facts
  const eco = await getExternalWebKnowledge({
    question: 'Tôi muốn chọn đơn hàng này và hỏi giá',
    webSearchEnabled: false
  });
  assert.equal(eco.ecosystemFacts.length, 0);

  // Learned knowledge for OBS on M3 must NOT hijack a pure M3 battery/price query
  invalidateCache();
  const mockPool = {
    query: async (sql) => {
      if (sql.includes("status = 'active'")) {
        return {
          rows: [{
            id: 'k-obs',
            topic: 'Hướng dẫn cài GAERU M3 trên OBS Studio',
            triggers: ['m3', 'obs', 'obs studio', 'laptop'],
            learned_facts: 'Chọn Mic/Auxiliary Audio là GAERU M3 Audio trong OBS.',
            sample_question: 'Cài M3 vào OBS như thế nào?',
            sample_answer: 'Chọn GAERU M3 Audio trong OBS.',
            confidence_score: 0.95,
            occurrence_count: 4,
            status: 'active'
          }]
        };
      }
      return { rows: [] };
    }
  };

  const unrelatedM3 = await matchLearnedKnowledge(mockPool, 'Giá GAERU M3 bao nhiêu tiền?', { minScore: 0.65 });
  assert.equal(unrelatedM3, null);

  const batteryM3 = await generateGaeruAiResponse({
    pool: mockPool,
    question: 'GAERU M3 pin dùng mấy tiếng?',
    catalog: REALISTIC_CATALOG
  });
  assert.ok(batteryM3.answer.includes('3,5 giờ'));
  assert.ok(batteryM3.answer.includes('24 giờ'));
  assert.equal(batteryM3.learnedKnowledge, undefined);
});

test('Customer AI answers accurately & concisely without rambling', async () => {
  // 1. Pointed battery question -> short direct answer, no sales brochure wall
  const k9Battery = await generateGaeruAiResponse({
    question: 'K9 pin dùng mấy tiếng?',
    catalog: REALISTIC_CATALOG
  });
  assert.equal(k9Battery.handoff, false);
  assert.ok(k9Battery.answer.includes('2,5 giờ'));
  assert.ok(k9Battery.answer.length < 220, `Too verbose (${k9Battery.answer.length}): ${k9Battery.answer}`);
  assert.ok(!k9Battery.answer.includes('GAERU Xu'));

  // 2. Variant-specific stock & price query
  const k9Var = await generateGaeruAiResponse({
    question: 'K9 bản 2 mic Type-C giá bao nhiêu và còn hàng không?',
    catalog: REALISTIC_CATALOG
  });
  assert.ok(k9Var.answer.includes('389.000 ₫'));
  assert.ok(k9Var.answer.includes('Còn hàng'));
  assert.ok(!k9Var.answer.includes('K9-2M-L') && !k9Var.answer.includes('399.000 ₫'));

  // 3. Real P01 identity = Gimbal AI (not falsely described as wireless mic)
  const p01Real = await generateGaeruAiResponse({
    question: 'GAERU P01 là gì và giá bao nhiêu?',
    catalog: REALISTIC_CATALOG
  });
  assert.ok(p01Real.answer.includes('Gimbal AI'));
  assert.ok(p01Real.answer.includes('550.000 ₫'));
  assert.ok(!p01Real.answer.includes('Khử ồn chủ động'));

  // 4. Focused comparison of ONLY K9 and M3 (no unwanted P01 pitch)
  const cmp = await generateGaeruAiResponse({
    question: 'So sánh K9 và M3 khác nhau điểm nào?',
    catalog: REALISTIC_CATALOG
  });
  assert.ok(cmp.answer.includes('GAERU K9'));
  assert.ok(cmp.answer.includes('GAERU M3'));
  assert.ok(!cmp.answer.includes('GAERU P01'));

  // 5. Compound multi-intent question answers both questions cleanly
  const multi = await generateGaeruAiResponse({
    question: 'M3 khoảng cách truyền bao xa và có freeship không?',
    catalog: REALISTIC_CATALOG
  });
  assert.ok(multi.answer.includes('20 mét'));
  assert.ok(multi.answer.includes('Freeship'));
  assert.ok(multi.answer.includes('500.000 ₫'));

  // 6. Real production GR-... order lookup
  const mockPoolGr = {
    async query(sql) {
      if (sql.includes('FROM orders')) {
        return {
          rows: [{
            id: 'ord-gr-1',
            order_number: 'GR-20261117-ABC123',
            customer_id: 'cust-1',
            customer_name: 'Trần Minh B',
            phone: '0909123456',
            address: '12 Lê Lợi',
            city: 'TP.HCM',
            status: 'shipped',
            payment_method: 'vietqr',
            payment_status: 'paid',
            total_vnd: 1200000,
            created_at: new Date()
          }]
        };
      }
      if (sql.includes('FROM carrier_shipments')) {
        return {
          rows: [{ carrier_id: 'viettel', carrier_name: 'Viettel Post', tracking_number: 'VTP555444', status: 'Đang giao' }]
        };
      }
      return { rows: [] };
    }
  };
  const grRes = await lookupOrderInfo(mockPoolGr, 'Kiểm tra đơn GR-20261117-ABC123 giúp mình', { customer_id: 'cust-1' });
  assert.equal(grRes.found, true);
  assert.equal(grRes.isOwner, true);
  assert.equal(grRes.order.order_number, 'GR-20261117-ABC123');

  // 7. Unknown question does NOT dump 4-product spam catalog
  const unknown = await generateGaeruAiResponse({
    question: 'Hôm nay trời có mưa không bạn?',
    catalog: REALISTIC_CATALOG
  });
  assert.equal(unknown.isFallback, true);
  assert.ok(unknown.answer.length < 300);
  assert.ok(!unknown.answer.includes('450.000 ₫') && !unknown.answer.includes('1.200.000 ₫'));

  // 8. Negated human request still answers question directly
  const noHuman = await generateGaeruAiResponse({
    question: 'Không cần gặp nhân viên, cho hỏi P185 kéo dài bao nhiêu cm?',
    catalog: REALISTIC_CATALOG
  });
  assert.equal(noHuman.handoff, false);
  assert.ok(noHuman.answer.includes('180 cm'));

  // 9. Admin approved knowledge source in product.webKnowledge answers niche store policies directly
  const { answerCustomerChat } = require('../src/gaeru-ai-customer');
  const approvedAns = await answerCustomerChat({
    pool: { async query() { return { rows: [] }; } },
    config: {},
    question: 'Mình lỡ chọn nhầm muốn đổi đầu thu sang Type-C được không?',
    product: {
      products: REALISTIC_CATALOG,
      webKnowledge: {
        externalKnowledge: {
          approvedSources: [{
            title: 'Đổi đầu thu trong 7 ngày',
            facts: ['GAERU hỗ trợ đổi đầu thu sang Type-C hoặc Lightning trong 7 ngày nếu sản phẩm còn nguyên tem.']
          }]
        }
      }
    }
  });
  assert.equal(approvedAns.handoff, false);
  assert.ok(approvedAns.answer.includes('7 ngày'));
});

test('Internal Admin AI answers concisely, routes accurately, and avoids tool cross-contamination', async () => {
  let capturedOrderQuery = null;
  let checkedInventory = false;
  const messageHistory = [];
  const mockPool = {
    query: async (sql, params = []) => {
      const q = sql.toLowerCase();
      if (q.includes('count(*)::int as total_orders')) {
        return {
          rows: [{
            total_orders: 4,
            pending_orders: 1,
            confirmed_orders: 1,
            processing_orders: 0,
            shipped_orders: 1,
            completed_orders: 1,
            cancelled_orders: 0,
            paid_revenue: 2400000,
            gross_revenue: 3100000
          }]
        };
      }
      if (q.includes('from customers')) return { rows: [{ count: 2 }] };
      if (q.includes('from orders') && q.includes('order_number as "ordernumber"')) {
        capturedOrderQuery = { sql, params };
        return {
          rows: [{
            orderNumber: 'GR-20261117-XYZ9',
            customerName: 'Lê Thị C',
            phone: '0911222333',
            city: 'Đà Nẵng',
            status: 'completed',
            paymentStatus: 'paid',
            paymentMethod: 'cod',
            totalVnd: 1200000
          }]
        };
      }
      if (q.includes('from product_variants')) {
        checkedInventory = true;
        return { rows: [] };
      }
      if (q.includes('from internal_ai_threads')) {
        if (q.includes('where id = $1')) return { rows: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Test' }] };
        return { rows: [] };
      }
      if (q.includes('insert into internal_ai_messages')) {
        const row = {
          id: '22222222-2222-4222-8222-222222222222',
          role: params[1],
          content: params[2],
          toolResults: [],
          actionCard: null,
          createdAt: new Date().toISOString()
        };
        messageHistory.push({ role: row.role, content: row.content });
        return { rows: [row] };
      }
      if (q.includes('from internal_ai_messages')) return { rows: messageHistory.slice(-10) };
      if (q.includes('insert into internal_ai_action_logs')) {
        return {
          rows: [{
            id: '33333333-3333-4333-8333-333333333333',
            actionType: params[1],
            payload: JSON.parse(params[2]),
            status: 'pending',
            createdAt: new Date().toISOString()
          }]
        };
      }
      return { rows: [] };
    }
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.admin = { id: 'owner-1', username: 'owner', role: 'owner', isOwner: true, permissions: ['*'] };
    next();
  });
  app.use('/api/gaeru_ceo/internal-ai', createInternalAiRouter(mockPool, {}));

  const srv = http.createServer(app);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/gaeru_ceo/internal-ai/threads/11111111-1111-4111-8111-111111111111/chat`;

  try {
    // 1. Direct revenue question -> tight 1-2 line response, no CEO fluff
    const revRes = await (await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Doanh thu hôm nay bao nhiêu?' })
    })).json();
    assert.ok(revRes.answer.includes('2.400.000 ₫'));
    assert.ok(!revRes.answer.includes('Chào Chủ doanh nghiệp'), 'Must avoid verbose greeting filler');
    assert.ok(!revRes.answer.includes('Gợi ý điều hành'), 'Must avoid unsolicited suggestion block on single-metric query');
    assert.ok(revRes.answer.length < 220, `Revenue response too verbose: ${revRes.answer}`);

    // 2. Querying completed order by GR-... or saying "cho tôi" must NOT falsely filter status = 'pending'
    const ordRes = await (await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Kiểm tra giúp cho tôi đơn hàng GR-20261117-XYZ9' })
    })).json();
    assert.ok(ordRes.answer.includes('GR-20261117-XYZ9'));
    assert.ok(!capturedOrderQuery.params.includes('pending'), 'Preposition "cho" must not be misread as "chờ" (pending)');

    // 3. Creating a voucher with code containing K9 must NOT pollute response with inventory check
    checkedInventory = false;
    const voucherRes = await (await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Tạo mã giảm giá K9SALE giảm 30k' })
    })).json();
    assert.equal(voucherRes.actionCard.actionType, 'create_voucher');
    assert.equal(voucherRes.actionCard.payload.code, 'K9SALE');
    assert.equal(checkedInventory, false, 'Voucher creation must not trigger unrelated inventory lookup');

    // 4. Multi-turn follow-up inherits business_overview timeframe cleanly ("còn 7 ngày qua thì sao?")
    await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Doanh thu hôm nay thế nào?' })
    });
    const followUpRev = await (await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'còn 7 ngày qua thì sao?' })
    })).json();
    assert.ok(followUpRev.toolResults.some(t => t.tool === 'get_business_overview' && t.data.periodDays === 7));
    assert.ok(followUpRev.answer.includes('7 ngày qua'));
  } finally {
    await new Promise(r => srv.close(r));
  }
});
