'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateGaeruAiResponse } = require('../src/gaeru-ai-customer');
const { extractDialogueState } = require('../src/lib/dialogue-state');
const {
  CUSTOMER_INTENT_PROTOTYPES,
  classifyCustomerIntentFast,
  classifyCustomerIntentSemantic
} = require('../src/lib/customer-intent-router');
const { resetGpuAiState } = require('../src/lib/gpu-ai-client');
const { resetEmbeddingStore } = require('../src/lib/embedding-store');

const FULL_CATALOG = [
  {
    id: 'prod-m3',
    slug: 'gaeru-m3',
    name: 'GAERU M3',
    category: 'audio',
    descriptor: 'mic không dây cài áo có hộp sạc cao cấp',
    variants: [
      { id: 'm3-01', name: 'Type C', sku: 'M3-01', priceVnd: 1200000, stockQuantity: 499, active: true },
      { id: 'm3-g4', name: 'Type C + đầu chuyển Lightning', sku: 'M3-G4', priceVnd: 1200000, stockQuantity: 492, active: true },
      { id: 'm3-g6', name: 'Type C + chuyển USB', sku: 'M3-G6', priceVnd: 1200000, stockQuantity: 499, active: true },
      { id: 'm3-g5', name: 'Type C + chuyển Micro usb', sku: 'M3-G5', priceVnd: 1200000, stockQuantity: 501, active: true }
    ]
  },
  {
    id: 'prod-k9',
    slug: 'gaeru-k9',
    name: 'GAERU K9',
    category: 'audio',
    descriptor: 'Mic không dây cài áo hỗ trợ giảm ồn tạp âm',
    variants: [
      { id: 'k9-ip1', name: 'Chân Lightning · Bộ 1 Micro', sku: 'K9IP1M', priceVnd: 289000, stockQuantity: 1000, active: true },
      { id: 'k9-ip2', name: 'Chân Lightning · Bộ 2 Micro', sku: 'K9IP2M', priceVnd: 409000, stockQuantity: 1000, active: true },
      { id: 'k9-tc1', name: 'Chân Type C · Bộ 1 Micro', sku: 'K9TC1M', priceVnd: 289000, stockQuantity: 1000, active: true },
      { id: 'k9-tc2', name: 'Chân Type C · Bộ 2 Micro', sku: 'K9TC2M', priceVnd: 409000, stockQuantity: 1000, active: true }
    ]
  },
  {
    id: 'prod-p01',
    slug: 'gaeru-p01',
    name: 'GAERU P01',
    category: 'video',
    descriptor: 'Gimbal AI tự động quay theo người',
    variants: [
      { id: 'p01-desk', name: 'Gimbal P01 để bàn', sku: 'P01', priceVnd: 550000, stockQuantity: 500, active: true },
      { id: 'p01-2m1', name: 'Gimbal GAERU P01 + Chân 2m1', sku: 'P01TP', priceVnd: 650000, stockQuantity: 500, active: true }
    ]
  },
  {
    id: 'prod-p185',
    slug: 'gaeru-p185',
    name: 'GAERU P185',
    category: 'video',
    descriptor: 'Gậy chụp hình selfie nhỏ gọn cầm tay',
    variants: [
      { id: 'p185-std', name: 'Phiên bản tiêu chuẩn', sku: 'P185', priceVnd: 450000, stockQuantity: 500, active: true }
    ]
  },
  {
    id: 'prod-g1',
    slug: 'gaeru-g1-ultra',
    name: 'GAERU G1 ULTRA',
    category: 'audio',
    descriptor: 'Mic không dây chuyên nghiệp kết nối đa thiết bị',
    variants: [
      { id: 'g1-1', name: 'GAERU G1 ULTRA', sku: 'G1', priceVnd: 2100000, stockQuantity: 0, active: true }
    ]
  }
];

// Realistic noisy webKnowledge reproducing the exact HTML snippets & news articles that leaked on 19/11/2026
const NOISY_WEB_KNOWLEDGE = {
  relevantSnippets: [
    { line: 'Đăng nhập tài khoản đã đặt mua. Chuẩn bị mã đơn, sản phẩm và thông tin liên hệ.', score: 0.49 },
    { line: 'Được yêu cầu hỗ trợ kỹ thuật, bảo hành và khiếu nại theo chính sách đã công bố.', score: 0.48 },
    { line: 'Đối chiếu micro, đầu thu, hộp sạc, cáp và đầu chuyển theo đúng phiên bản đã đặt.', score: 0.49 }
  ],
  latestNews: [
    {
      url: '/tin-tuc/chuan-bi-phien-tiktok-live-gioi-thieu-thiet-bi-gaeru',
      title: 'Chuẩn bị phiên TikTok LIVE giới thiệu thiết bị GAERU',
      summary: 'Danh sách việc cần làm trước buổi phát: sản phẩm, kịch bản, âm thanh và thông tin để trả lời người xem.'
    }
  ]
};

async function runConversation(turns, { thread = null, webKnowledge = NOISY_WEB_KNOWLEDGE } = {}) {
  const history = [];
  const results = [];
  for (const userText of turns) {
    const res = await generateGaeruAiResponse({
      pool: null,
      thread,
      question: userText,
      catalog: FULL_CATALOG,
      history: [...history],
      webKnowledge
    });
    results.push({ question: userText, res });
    history.push({ sender: 'customer', body: userText });
    history.push({ sender: 'ai', body: res.answer });
  }
  return results;
}

test('Production Replay #1-#3 (15:15): giới thiệu k9 -> mua -> trả lời -> giúp gi', async () => {
  const turns = await runConversation(['giới thiệu k9', 'mua', 'trả lời', 'giúp gi']);

  // Turn 1: "giới thiệu k9" -> K9 intro + proactive Buy Now CTA
  const t1 = turns[0].res;
  assert.ok(t1.answer.includes('GAERU K9'));
  assert.ok(t1.answer.includes('/san-pham/gaeru-k9'), `Turn 1 should include K9 Buy CTA:\n${t1.answer}`);

  // Turn 2: "mua" -> keeps K9 context, gives K9 Buy Now CTA, NEVER leaks after-sales HTML
  const t2 = turns[1].res;
  assert.equal(Boolean(t2.isFallback), false);
  assert.ok(t2.answer.includes('GAERU K9'), `Turn 2 should retain GAERU K9:\n${t2.answer}`);
  assert.ok(t2.answer.includes('/san-pham/gaeru-k9'), `Turn 2 should show K9 Buy CTA:\n${t2.answer}`);
  assert.ok(!t2.answer.includes('Đăng nhập tài khoản đã đặt mua'), 'Must NEVER leak after-sales snippet');

  // Turn 3: "trả lời" -> meta-nudge acknowledging K9, NEVER leaks TikTok LIVE article
  const t3 = turns[2].res;
  assert.equal(t3.intent, 'meta_nudge');
  assert.ok(t3.answer.includes('GAERU K9'), `Turn 3 should keep K9 context:\n${t3.answer}`);
  assert.ok(!t3.answer.includes('TikTok LIVE'), 'Must NEVER leak unrelated TikTok LIVE article');

  // Turn 4: "giúp gi" -> capability_help explaining what GAERU AI can do
  const t4 = turns[3].res;
  assert.equal(t4.intent, 'capability_help');
  assert.equal(Boolean(t4.isFallback), false);
  assert.ok(t4.answer.includes('GAERU AI'));
  assert.ok(t4.answer.includes('Tư vấn') && t4.answer.includes('Tra cứu đơn'));
  assert.ok(t4.answer.includes('GAERU K9'), 'Should contextually reference current active product K9');
});

test('Production Replay #4 (15:16): m3 -> công dụng -> chức năng', async () => {
  const turns = await runConversation(['m3', 'công dụng', 'chức năng']);

  // Turn 1: "m3" -> GAERU M3 overview + Buy CTA
  const t1 = turns[0].res;
  assert.ok(t1.answer.includes('GAERU M3'));
  assert.ok(t1.answer.includes('/san-pham/gaeru-m3'));

  // Turn 2: "công dụng" -> M3 practical usage & benefits + CTA (NOT terms HTML!)
  const t2 = turns[1].res;
  assert.equal(Boolean(t2.isFallback), false);
  assert.ok(t2.answer.includes('Công dụng') && t2.answer.includes('GAERU M3'), `Turn 2 answer:\n${t2.answer}`);
  assert.ok(t2.answer.includes('/san-pham/gaeru-m3'));
  assert.ok(!t2.answer.includes('Được yêu cầu hỗ trợ kỹ thuật'), 'Must NEVER leak terms snippet');

  // Turn 3: "chức năng" -> M3 technical features + CTA (NOT fallback, NOT anti-repeat warning!)
  const t3 = turns[2].res;
  assert.equal(Boolean(t3.isFallback), false);
  assert.ok(t3.answer.includes('Chức năng') && t3.answer.includes('GAERU M3'), `Turn 3 answer:\n${t3.answer}`);
  assert.ok(t3.answer.includes('24-bit') || t3.answer.includes('24 giờ'));
  assert.ok(t3.answer.includes('/san-pham/gaeru-m3'));
  assert.notEqual(t3.answer, t2.answer, 'Usage and features turns should be complementary, not duplicate');
  assert.ok(!t3.answer.includes('tránh lặp lại'), 'Should NOT hit anti-repeat warning');
});

test('Production Replay #5 (15:17): tôi muốn mua ngay -> mic m3 -> nút mua đâu -> mình dùng iphone 15', async () => {
  const turns = await runConversation([
    'tôi muốn mua ngay',
    'mic m3',
    'nút mua đâu',
    'mình dùng iphone 15'
  ]);

  // Turn 1: lists in-stock products with Buy Now links that render as real .chat-buy-card widgets in shopping-chat-client.js
  const t1 = turns[0].res;
  assert.ok(t1.answer.includes('sẵn hàng để bạn đặt mua ngay'));
  assert.ok(t1.answer.includes('- 👉 [Chọn phân loại & Mua ngay GAERU M3](/san-pham/gaeru-m3)'));
  const fs = require('node:fs');
  const vm = require('node:vm');
  const clientSrc = fs.readFileSync(require.resolve('../shopping-chat-client.js'), 'utf8');
  const helpers = vm.runInNewContext(clientSrc.slice(0, clientSrc.indexOf('  const ICONS =')) + '\nreturn { formatMessageBody };})();', {});
  const renderedT1 = helpers.formatMessageBody(t1.answer, 'ai', false);
  assert.ok(renderedT1.includes('class="chat-buy-card is-browse"'), 'Multi-product purchase list must render styled .chat-buy-card buttons');

  // Turn 2: "mic m3" carries over pending buy intent -> asks device & shows M3 Buy Now CTA!
  const t2 = turns[1].res;
  assert.equal(Boolean(t2.isFallback), false);
  assert.ok(t2.answer.includes('GAERU M3'));
  assert.ok(t2.answer.includes('Để đặt mua đúng phiên bản'), `Turn 2 should carry over buy intent:\n${t2.answer}`);
  assert.ok(t2.answer.includes('/san-pham/gaeru-m3'));

  // Turn 3: "nút mua đâu" -> preserves M3 Buy Now button, NEVER leaks inspection snippet or anti-repeat warning
  const t3 = turns[2].res;
  assert.equal(Boolean(t3.isFallback), false);
  assert.ok(t3.answer.includes('GAERU M3'));
  assert.ok(t3.answer.includes('/san-pham/gaeru-m3'), `Turn 3 must display Buy CTA:\n${t3.answer}`);
  assert.ok(!t3.answer.includes('Đối chiếu micro'), 'Must NEVER leak inspection HTML snippet');
  assert.ok(!t3.answer.includes('tránh lặp lại'), 'Anti-repeat must NEVER hide explicit Buy CTA');

  // Turn 4: "mình dùng iphone 15" -> resolves exact M3 Type-C 1-click checkout CTA!
  const t4 = turns[3].res;
  assert.equal(Boolean(t4.isFallback), false);
  assert.ok(t4.answer.includes('GAERU M3'));
  assert.ok(t4.answer.includes('/thanh-toan?variant=m3-01'), `Turn 4 should emit direct M3 Type-C checkout CTA:\n${t4.answer}`);
  assert.ok(!t4.answer.includes('m3-g4') && !t4.answer.includes('m3-g6'));
});

test('Multi-turn slot memory: device + 2-mic preference carried across 4 turns to exact 1-click K9 checkout', async () => {
  const turns = await runConversation([
    'mình dùng iPhone 16 Pro Max quay phỏng vấn 2 người',
    'giới thiệu k9',
    'pin dùng mấy tiếng?',
    'mua'
  ]);

  // Turn 3: concise battery-only reply
  assert.ok(turns[2].res.answer.includes('2,5 giờ'));
  assert.ok(turns[2].res.answer.length < 220, 'Battery follow-up must stay concise');

  // Turn 4: "mua" automatically picks K9 · Chân Type C · Bộ 2 Micro (k9-tc2)!
  const t4 = turns[3].res;
  assert.ok(t4.answer.includes('GAERU K9'), `Expected K9:\n${t4.answer}`);
  assert.ok(t4.answer.includes('Chân Type C · Bộ 2 Micro'), `Expected Type-C 2-Mic variant:\n${t4.answer}`);
  assert.ok(t4.answer.includes('/thanh-toan?variant=k9-tc2'), `Expected exact k9-tc2 CTA:\n${t4.answer}`);
});

test('Device override mid-conversation: newer phone supersedes older phone port', async () => {
  const turns = await runConversation([
    'mình dùng iPhone 13',
    'à đổi ý mình mua cho Samsung S25 Ultra nhé',
    'chốt mua m3'
  ]);

  const t3 = turns[2].res;
  assert.ok(t3.answer.includes('/thanh-toan?variant=m3-01'), `Latest device (Type-C) must override earlier Lightning:\n${t3.answer}`);
  assert.ok(!t3.answer.includes('/thanh-toan?variant=m3-g4'));
});

test('Product switch + stand memory: K9 -> P01 -> công dụng -> chân 2m1 -> mua', async () => {
  const turns = await runConversation([
    'giới thiệu k9',
    'còn p01 thì sao',
    'công dụng',
    'mình thích bản kèm chân 2m1',
    'mua'
  ]);

  // Turn 3: P01 usage (NOT K9!)
  assert.ok(turns[2].res.answer.includes('GAERU P01'));
  assert.ok(!turns[2].res.answer.includes('GAERU K9'));

  // Turn 5: exact P01 + Chân 2m1 checkout CTA
  assert.ok(turns[4].res.answer.includes('/thanh-toan?variant=p01-2m1'), `Expected P01 2m1 CTA:\n${turns[4].res.answer}`);
});

test('Global non-product interruption (VAT, hotline) stays clean, then resumes active product cleanly', async () => {
  const turns = await runConversation([
    'giới thiệu m3',
    'bên shop có xuất hóa đơn đỏ VAT không',
    'hotline shop là gì',
    'mua'
  ]);

  // Turn 2: Pure VAT answer, no M3 brochure
  assert.match(turns[1].res.answer, /không hỗ trợ xuất hóa đơn VAT/i);
  assert.ok(!turns[1].res.answer.includes('500 mAh'));

  // Turn 3: Pure contact answer
  assert.ok(turns[2].res.answer.includes('082 919 1080'));
  assert.ok(!turns[2].res.answer.includes('500 mAh'));

  // Turn 4: "mua" recovers M3 across the 2 global turns!
  assert.ok(turns[3].res.answer.includes('GAERU M3'));
  assert.ok(turns[3].res.answer.includes('/san-pham/gaeru-m3'));
});

test('Safety guards: OOS product never emits Buy CTA, negation blocks carryover, homonym mưa never triggers buy, context-aware fallback', async () => {
  // 1. Out-of-stock G1 ULTRA intro never emits checkout button
  const g1 = await generateGaeruAiResponse({ question: 'giới thiệu g1 ultra', catalog: FULL_CATALOG });
  assert.ok(g1.answer.includes('GAERU G1 ULTRA'));
  assert.ok(!g1.answer.includes('/thanh-toan?variant=g1-1'));
  assert.ok(g1.answer.includes('tạm hết hàng'));

  // 2. Negated carryover stays informational
  const negTurns = await runConversation([
    'tôi muốn mua ngay',
    'chưa mua đâu, hỏi m3 pin dùng mấy tiếng?'
  ]);
  assert.ok(negTurns[1].res.answer.includes('24 giờ'));
  assert.ok(!negTurns[1].res.answer.includes('/thanh-toan?variant='));
  assert.ok(!negTurns[1].res.answer.includes('Để đặt mua'));

  // 3. Homonym "mưa" after M3 -> context-aware fallback mentioning GAERU M3 (never buy CTA)
  const rainTurns = await runConversation(['m3', 'hôm nay trời có mưa không bạn?']);
  assert.equal(rainTurns[1].res.isFallback, true);
  assert.ok(rainTurns[1].res.answer.includes('GAERU M3'));
  assert.ok(!rainTurns[1].res.answer.includes('/thanh-toan?variant='));

  // 4. Quality follow-up & punctuation nudge
  const qualTurns = await runConversation(['p185', 'có bền không', '?']);
  assert.equal(Boolean(qualTurns[1].res.isFallback), false);
  assert.ok(qualTurns[1].res.answer.includes('GAERU P185') && qualTurns[1].res.answer.includes('12 tháng'));
  assert.equal(qualTurns[2].res.intent, 'meta_nudge');
  assert.ok(qualTurns[2].res.answer.includes('GAERU P185'));
});

test('Anti-Noise RAG Gate allows explicit article requests while blocking conversational noise', async () => {
  const articleRes = await generateGaeruAiResponse({
    question: 'có bài viết hướng dẫn chuẩn bị phiên TikTok LIVE không?',
    catalog: FULL_CATALOG,
    webKnowledge: NOISY_WEB_KNOWLEDGE
  });
  assert.ok(articleRes.answer.includes('Chuẩn bị phiên TikTok LIVE'));

  // Dialogue state sanity check
  const st = extractDialogueState({
    question: 'mic m3',
    history: [
      { sender: 'customer', body: 'tôi muốn mua ngay' },
      { sender: 'ai', body: '**Các thiết bị GAERU sẵn hàng để bạn đặt mua ngay:**\n- GAERU M3' }
    ],
    catalog: FULL_CATALOG
  });
  assert.equal(st.activeProduct?.key, 'gaeru-m3');
  assert.equal(st.pendingBuyIntent, true);
  assert.equal(st.shouldCarryoverBuyIntent, true);
  assert.equal(st.pendingAiSlot, 'product');
});

test('Semantic Intent Router (22 prototypes) rescues colloquial paraphrases via GPU embeddings and rejects off-topic noise', async () => {
  resetGpuAiState();
  resetEmbeddingStore();
  assert.equal(CUSTOMER_INTENT_PROTOTYPES.length, 22);
  assert.equal(new Set(CUSTOMER_INTENT_PROTOTYPES.map(p => p.key)).size, 22);

  // Fast classifier sanity checks
  assert.equal(classifyCustomerIntentFast('giúp gi', 'giup gi', null)?.intent, 'capability_help');
  assert.equal(classifyCustomerIntentFast('trả lời', 'tra loi', null)?.intent, 'meta_nudge');
  assert.equal(classifyCustomerIntentFast('nút mua đâu', 'nut mua dau', null)?.intent, 'buy_cta');
  assert.equal(classifyCustomerIntentFast('công dụng', 'cong dung', null)?.intent, 'product_features');

  const mockTransport = async (_url, init) => {
    const inp = JSON.parse(init.body).input;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: inp.map((txt, idx) => {
            const norm = txt.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
            if (/chung tu|khau tru thue|hoa don do|vat/.test(norm)) return { index: idx, embedding: [0.98, 0.08, 0, 0, 0] };
            if (/nhan vo cho mo|chot san pham|dat mua san pham|nut mua hang/.test(norm)) return { index: idx, embedding: [0.05, 0.98, 0.08, 0, 0] };
            if (/uu viet cho mo|cong dung chuc nang|diem noi bat/.test(norm)) return { index: idx, embedding: [0, 0.05, 0.98, 0.08, 0] };
            if (/thoi tiet|troi mua|bong da/.test(norm)) return { index: idx, embedding: [0, 0, 0, 0, 1] };
            return { index: idx, embedding: [0.02, 0.02, 0.02, 0.99, 0] };
          })
        };
      }
    };
  };

  const vatIntent = await classifyCustomerIntentSemantic(null, 'mình cần chứng từ khấu trừ thuế cho cơ quan', { transport: mockTransport });
  assert.ok(vatIntent);
  assert.equal(vatIntent.intent, 'vat_invoice');

  const buyIntentSem = await classifyCustomerIntentSemantic(null, 'nhấn vô chỗ mô để chốt sản phẩm ni rứa', { transport: mockTransport });
  assert.ok(buyIntentSem);
  assert.equal(buyIntentSem.intent, 'buy_cta');

  const featIntentSem = await classifyCustomerIntentSemantic(null, 'cái mic này ưu việt chỗ mô bạn ơi', { transport: mockTransport });
  assert.ok(featIntentSem);
  assert.equal(featIntentSem.intent, 'product_features');

  const weatherOff = await classifyCustomerIntentSemantic(null, 'thời tiết hôm nay trời mưa to không bạn', { transport: mockTransport });
  assert.equal(weatherOff, null);
});

test('Audit P1-P3 fixes: P185 grouped under Ghi hình (video), dynamic live payment methods in GAERU AI, compact product intro card', async () => {
  // 1. P2-A: Dynamic payment methods reflect COD-only when only COD is enabled on storefront
  const codOnlyPay = await generateGaeruAiResponse({
    question: 'shop hỗ trợ những phương thức thanh toán nào?',
    catalog: FULL_CATALOG,
    webKnowledge: { enabledPaymentMethods: ['cod'] }
  });
  assert.match(codOnlyPay.answer, /Phương thức thanh toán đang mở tại gaeru\.com/i);
  assert.match(codOnlyPay.answer, /COD/i);
  assert.match(codOnlyPay.answer, /khi cửa hàng kích hoạt/i);

  // When VietQR + VNPAY are enabled alongside COD, GAERU AI announces all active channels
  const multiPay = await generateGaeruAiResponse({
    question: 'có hỗ trợ thanh toán chuyển khoản không?',
    catalog: FULL_CATALOG,
    webKnowledge: { enabledPaymentMethods: ['cod', 'bank_transfer', 'vnpay'] }
  });
  assert.match(multiPay.answer, /COD/i);
  assert.match(multiPay.answer, /Chuyển khoản VietQR/i);
  assert.match(multiPay.answer, /VNPAY/i);
  assert.ok(!multiPay.answer.includes('ZaloPay'));

  // 2. P3-B: Compact product intro card keeps Android OTG/USB-Debug/third-party apps + Buy CTA while staying concise
  const k9Compact = await generateGaeruAiResponse({ question: 'giới thiệu k9', catalog: FULL_CATALOG });
  assert.ok(k9Compact.answer.includes('GAERU K9'));
  assert.match(k9Compact.answer, /OPPO.*OTG/i);
  assert.match(k9Compact.answer, /Gỡ lỗi USB/i);
  assert.match(k9Compact.answer, /Ulike|WutaCam|B612|Open Camera/i);
  assert.ok(k9Compact.answer.includes('/san-pham/gaeru-k9'));
  assert.ok(k9Compact.answer.length < 1150, `Compact K9 intro should stay concise (${k9Compact.answer.length} chars)`);
  assert.ok(k9Compact.answer.split('\n').length <= 7, `Compact K9 intro should stay <= 7 lines (${k9Compact.answer.split('\n').length} lines)`);

  // 3. P1-B: Homepage filter logic includes accessory (GAERU P185) under video ("Ghi hình")
  const fs = require('node:fs');
  const scriptSrc = fs.readFileSync(require.resolve('../script.js'), 'utf8');
  assert.match(scriptSrc, /filter === "video" && kind === "accessory"/);
  const stylesSrc = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
  assert.match(stylesSrc, /\.search-result img\s*\{[^}]*background:\s*#f3f4f6/);
});

