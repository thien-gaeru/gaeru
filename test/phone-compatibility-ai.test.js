'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateGaeruAiResponse } = require('../src/gaeru-ai-customer');
const { expandQueryVi, resolveMentionedProducts } = require('../src/lib/ai-nlu');
const { getExternalWebKnowledge } = require('../src/chat-external-knowledge');

const CATALOG = [
  {
    slug: 'gaeru-k9',
    name: 'GAERU K9',
    category: 'audio',
    variants: [
      { id: 'k9-1l', name: 'Chân Lightning · Bộ 1 Micro', sku: 'K9-1M-L', priceVnd: 289000, stockQuantity: 100, active: true },
      { id: 'k9-2l', name: 'Chân Lightning · Bộ 2 Micro', sku: 'K9-2M-L', priceVnd: 409000, stockQuantity: 100, active: true },
      { id: 'k9-1c', name: 'Chân Type C', sku: 'K9-1M-C', priceVnd: 289000, stockQuantity: 100, active: true },
      { id: 'k9-2c', name: 'Chân Type C · Bộ 2 Micro', sku: 'K9-2M-C', priceVnd: 409000, stockQuantity: 100, active: true },
      { id: 'k9-1c-l', name: 'Chân Type C + Chuyển Lightning · Bộ 1 Micro', sku: 'K9-1M-CL', priceVnd: 339000, stockQuantity: 100, active: true },
      { id: 'k9-2c-l', name: 'Chân Type C + Chuyển Lightning · Bộ 2 Micro', sku: 'K9-2M-CL', priceVnd: 459000, stockQuantity: 100, active: true },
      { id: 'k9-1c-m', name: 'Chân Type C + Chuyển Micro USB · Bộ 1 Micro', sku: 'K9-1M-CM', priceVnd: 339000, stockQuantity: 100, active: true },
      { id: 'k9-1c-u', name: 'Chân Type C + Chuyển USB · Bộ 1 Micro', sku: 'K9-1M-CU', priceVnd: 339000, stockQuantity: 100, active: true },
      { id: 'k9-2c-u', name: 'Chân Type C + Chuyển USB · Bộ 2 Micro', sku: 'K9-2M-CU', priceVnd: 459000, stockQuantity: 100, active: true }
    ]
  },
  {
    slug: 'gaeru-m3',
    name: 'GAERU M3',
    category: 'audio',
    variants: [
      { id: 'm3-c', name: 'Type C', sku: 'M3-C', priceVnd: 1200000, stockQuantity: 50, active: true },
      { id: 'm3-m', name: 'Type C + chuyển Micro usb', sku: 'M3-M', priceVnd: 1200000, stockQuantity: 50, active: true },
      { id: 'm3-u', name: 'Type C + chuyển USB', sku: 'M3-U', priceVnd: 1200000, stockQuantity: 50, active: true },
      { id: 'm3-l', name: 'Type C + đầu chuyển Lightning', sku: 'M3-L', priceVnd: 1200000, stockQuantity: 50, active: true }
    ]
  },
  { slug: 'gaeru-g1-ultra', name: 'GAERU G1 ULTRA', category: 'audio', variants: [{ id: 'g1-u', name: 'GAERU G1 ULTRA', sku: 'G1-U', priceVnd: 2100000, stockQuantity: 0, active: true }] },
  { slug: 'gaeru-p01', name: 'GAERU P01', category: 'video', variants: [{ id: 'p01-desk', name: 'Gimbal P01 để bàn', priceVnd: 550000, stockQuantity: 10, active: true }, { id: 'p01-2m1', name: 'Gimbal GAERU P01 + Chân 2m1', priceVnd: 650000, stockQuantity: 10, active: true }] },
  { slug: 'gaeru-p185', name: 'GAERU P185', category: 'video', variants: [{ id: 'p185-std', name: 'Phiên bản tiêu chuẩn', priceVnd: 450000, stockQuantity: 10, active: true }] }
];

test('NLU shorthand expansion supports 2025-2026 iPhone, Samsung, Xiaomi and Micro-USB queries', () => {
  assert.ok(expandQueryVi('ip17pm dùng K9 nào?').includes('iphone 17 pro max'));
  assert.ok(expandQueryVi('ip16e dùng chân gì').includes('iphone 16e'));
  assert.ok(expandQueryVi('ip air cắm M3 đc ko').includes('iphone air'));
  assert.ok(expandQueryVi('ip18 pro').includes('iphone 18'));
  assert.ok(expandQueryVi('ss s26 ultra').includes('samsung s26'));
  assert.ok(expandQueryVi('xm 17 ultra').includes('xiaomi 17'));
  assert.ok(expandQueryVi('microusb dùng bản nào').includes('micro-usb'));

  // iPad Air M3 must NOT trigger false product comparison with GAERU M3 when asking about GAERU K9
  const ipadK9 = resolveMentionedProducts('iPad Air M3 cắm GAERU K9 được không?', CATALOG);
  assert.equal(ipadK9.items.length, 1);
  assert.equal(ipadK9.items[0].key, 'gaeru-k9');
});

test('GAERU AI accurately identifies latest Apple (iPhone 15-18, Air, 16e, 14 & older, iPad) ports & GAERU variants', async () => {
  const ip17 = await generateGaeruAiResponse({ question: 'ip17 pro max dùng mic GAERU M3 bản nào?', catalog: CATALOG });
  assert.equal(ip17.handoff, false);
  assert.ok(ip17.answer.includes('iPhone 17 Pro Max'));
  assert.ok(ip17.answer.includes('USB Type-C'));
  assert.ok(ip17.answer.includes('1.200.000 ₫'));

  const ipAir = await generateGaeruAiResponse({ question: 'iPhone Air và iPhone 16e dùng chân cắm gì?', catalog: CATALOG });
  assert.ok(ipAir.answer.includes('USB Type-C'));

  const ip13 = await generateGaeruAiResponse({ question: 'Mình dùng iPhone 13 Pro Max muốn mua K9 chọn chân nào?', catalog: CATALOG });
  assert.ok(ip13.answer.includes('Lightning'));
  assert.ok(ip13.answer.includes('Chân Lightning'));

  const dualIphone = await generateGaeruAiResponse({ question: 'Nhà mình có cả iPhone 14 Pro và iPhone 17 Pro dùng chung mic K9 chọn bản nào?', catalog: CATALOG });
  assert.ok(dualIphone.answer.includes('Type C + Chuyển Lightning'));
});

test('GAERU AI covers all latest Android brands (Samsung S25/S26/Fold7, OPPO Reno15/Find X9, Xiaomi 15/17/Note15/POCO, vivo X300, HONOR, Huawei, Pixel, Realme, Tecno, Infinix, Nothing, ROG, RedMagic, Xperia)', async () => {
  const queries = [
    ['Samsung S26 Ultra với Z Fold 7 dùng chân cắm gì?', ['Samsung Galaxy', 'Type-C']],
    ['OPPO Reno 15 Pro dùng mic nào và cài thế nào?', ['OPPO', 'Type-C', 'OTG']],
    ['OPPO Reno 15 có cần mua bản Lightning không?', ['OPPO', 'Type-C']],
    ['vivo X300 và iQOO 13 dùng mic GAERU có nhận không?', ['vivo', 'Type-C', 'OTG']],
    ['Xiaomi 17 Ultra và Redmi Note 15 dùng chân gì?', ['Xiaomi', 'Type-C']],
    ['HONOR Magic 8 Pro dùng mic M3 được không?', ['HONOR', 'Type-C', 'GAERU M3']],
    ['Google Pixel 10 Pro cắm K9 được không?', ['Google Pixel', 'Type-C', 'Pixel Camera']],
    ['Huawei Pura 80 và Mate 70 dùng mic gì?', ['Huawei', 'Type-C']],
    ['Realme GT 7 Pro dùng chân cắm gì?', ['Realme', 'Type-C', 'OTG']],
    ['Tecno Camon 40 với Infinix Note 50 cắm mic nào?', ['Tecno', 'Infinix', 'Type-C', 'OTG']],
    ['ASUS ROG Phone 9 và RedMagic 10 Pro dùng mic GAERU được không?', ['ASUS', 'RedMagic', 'Type-C']],
    ['Sony Xperia 1 VI cắm đầu thu mic K9 vào đâu?', ['Sony Xperia', 'USB Type-C', '3.5mm']]
  ];

  for (const [question, expectedTokens] of queries) {
    const res = await generateGaeruAiResponse({ question, catalog: CATALOG });
    assert.equal(res.handoff, false, `Unexpected handoff for: ${question}`);
    for (const token of expectedTokens) {
      assert.ok(res.answer.includes(token), `Missing "${token}" in answer for "${question}":\n${res.answer}`);
    }
  }

  // Ensure OPPO Reno 15 asking about Lightning doesn't dump iPhone instructions
  const oppoNoIphone = await generateGaeruAiResponse({ question: 'OPPO Reno 15 có cần mua bản Lightning không?', catalog: CATALOG });
  assert.ok(!oppoNoIphone.answer.includes('iPhone 15'));
});

test('GAERU AI identifies legacy Micro-USB phones, Phone Directory summary, and P01/P185 clamp compatibility', async () => {
  const legacyJ7 = await generateGaeruAiResponse({ question: 'Samsung J7 Prime dùng chân cắm gì, mua K9 bản nào?', catalog: CATALOG });
  assert.ok(legacyJ7.answer.includes('Micro-USB'));
  assert.ok(legacyJ7.answer.includes('Chuyển Micro USB'));

  const legacyRedmi = await generateGaeruAiResponse({ question: 'Redmi 9A cũ có cắm được mic GAERU M3 không?', catalog: CATALOG });
  assert.ok(legacyRedmi.answer.includes('Micro-USB'));
  assert.ok(legacyRedmi.answer.includes('chuyển Micro usb'));

  const dir = await generateGaeruAiResponse({ question: 'Cho hỏi các hãng điện thoại mới nhất dùng chân cắm gì?', catalog: CATALOG });
  assert.ok(dir.answer.includes('iPhone 15 / 16 / 16e / 17 / 17 Air / 18'));
  assert.ok(dir.answer.includes('Samsung S24–S26'));
  assert.ok(dir.answer.includes('Lightning'));
  assert.ok(dir.answer.includes('Micro-USB'));

  const p01Fold = await generateGaeruAiResponse({ question: 'Samsung Z Fold 7 dùng GAERU P01 được không?', catalog: CATALOG });
  assert.ok(p01Fold.answer.includes('GAERU P01'));
  assert.ok(p01Fold.answer.includes('100%'));

  // External Knowledge includes the updated device facts too
  const ext = await getExternalWebKnowledge({ question: 'HONOR Magic 8 Pro dùng chân gì?', webSearchEnabled: false });
  assert.ok(ext.ecosystemFacts.some(f => f.includes('HONOR') && f.includes('Type-C')));
});

test('GAERU AI accurately recommends connector ports across Tablets, Laptops and Desktop PCs', async () => {
  // Chip M3 in Apple laptops/iMacs must NOT false-trigger GAERU M3
  const mbK9 = resolveMentionedProducts('MacBook Air M3 và iMac M3 dùng GAERU K9 bản nào?', CATALOG);
  assert.equal(mbK9.items.length, 1);
  assert.equal(mbK9.items[0].key, 'gaeru-k9');

  const queries = [
    ['Samsung Galaxy Tab S10 Ultra dùng chân gì cho mic?', ['Galaxy Tab', 'USB Type-C']],
    ['OPPO Pad Air và vivo Pad 3 Pro cắm mic GAERU có cần bật gì không?', ['OPPO Pad', 'vivo Pad', 'OTG', 'USB Type-C']],
    ['Xiaomi Pad 7 và Huawei MatePad 11.5 cắm mic K9 bản nào?', ['Xiaomi Pad', 'MatePad', 'Type-C']],
    ['Microsoft Surface Pro 6 cũ dùng chân nào, còn Surface Pro 9 dùng chân gì?', ['USB-A', 'USB Type-C']],
    ['MacBook Air M3 và MacBook Air 2015 dùng mic GAERU M3 bản nào?', ['Type-C', 'chuyển USB']],
    ['Laptop Dell XPS và PC máy tính để bàn Windows cắm K9 chọn chân gì?', ['USB-A', 'Chuyển USB']],
    ['Mac mini M4 và iMac M4 dùng chân cắm gì cho micro?', ['USB-C', 'Type-C']]
  ];

  for (const [question, expected] of queries) {
    const res = await generateGaeruAiResponse({ question, catalog: CATALOG });
    assert.equal(res.handoff, false, `Unexpected handoff for: ${question}`);
    for (const token of expected) {
      assert.ok(res.answer.includes(token), `Missing "${token}" in answer for "${question}":\n${res.answer}`);
    }
  }
});

test('GAERU AI provides detailed per-brand OTG and USB Debugging guides', async () => {
  const otgAll = await generateGaeruAiResponse({ question: 'Hướng dẫn mở OTG cho từng loại máy khi kết nối mic GAERU', catalog: CATALOG });
  assert.ok(otgAll.answer.includes('OPPO'));
  assert.ok(otgAll.answer.includes('Realme'));
  assert.ok(otgAll.answer.includes('vivo'));
  assert.ok(otgAll.answer.includes('Tecno'));
  assert.ok(otgAll.answer.includes('10 phút'));
  assert.ok(otgAll.answer.includes('5 phút'));

  const otgVivo = await generateGaeruAiResponse({ question: 'vivo X300 cắm mic không sáng đèn thì bật OTG ở đâu?', catalog: CATALOG });
  assert.ok(otgVivo.answer.includes('Bluetooth'));
  assert.ok(otgVivo.answer.includes('OTG'));

  const usbAll = await generateGaeruAiResponse({ question: 'Hướng dẫn mở gỡ lỗi USB cho từng loại máy Android để kết nối mic', catalog: CATALOG });
  assert.ok(usbAll.answer.includes('HyperOS'));
  assert.ok(usbAll.answer.includes('Samsung'));
  assert.ok(usbAll.answer.includes('OPPO'));
  assert.ok(usbAll.answer.includes('vivo'));
  assert.ok(usbAll.answer.includes('Tắt định tuyến âm thanh USB'));
  assert.ok(usbAll.answer.includes('iPhone / iPad'));

  const usbXiaomi = await generateGaeruAiResponse({ question: 'Xiaomi Redmi Note 14 bật gỡ lỗi usb chỗ nào?', catalog: CATALOG });
  assert.ok(usbXiaomi.answer.includes('Phiên bản MIUI / Phiên bản HyperOS'));
  assert.ok(usbXiaomi.answer.includes('Gỡ lỗi USB'));
});

test('GAERU AI distinguishes iOS 18+ manual external mic selection from iOS under 18 automatic plug-and-play', async () => {
  const iosCompare = await generateGaeruAiResponse({
    question: 'Cách chọn mic gắn ngoài trên iOS 18 mới và máy iOS dưới 18 có cần chọn không?',
    catalog: CATALOG
  });
  assert.ok(iosCompare.answer.includes('iOS 18'));
  assert.ok(iosCompare.answer.includes('Trung tâm điều khiển'));
  assert.ok(iosCompare.answer.includes('Đầu vào'));
  assert.ok(iosCompare.answer.includes('iOS dưới 18'));
  assert.ok(iosCompare.answer.includes('KHÔNG cần'));

  const iosUnder18 = await generateGaeruAiResponse({
    question: 'iPhone 13 chạy iOS 16 có cần thao tác chọn mic ngoài như iOS 18 không?',
    catalog: CATALOG
  });
  assert.ok(iosUnder18.answer.includes('iOS dưới 18'));
  assert.ok(iosUnder18.answer.includes('KHÔNG cần'));

  // Must NOT misclassify "khác gì" on thread-bound M3 page as product comparison
  const iosThreadBound = await generateGaeruAiResponse({
    thread: { id: 't-ios', product_id: 'prod-m3', product_name: 'GAERU M3' },
    question: 'Hướng dẫn chọn mic gắn ngoài trên iOS 18 mới và máy iOS dưới 18 khác gì?',
    catalog: CATALOG.map((p, idx) => idx === 1 ? { ...p, id: 'prod-m3' } : p)
  });
  assert.ok(!iosThreadBound.answer.includes('So sánh nhanh'), `Misclassified iOS comparison as product comparison:\n${iosThreadBound.answer}`);
  assert.ok(iosThreadBound.answer.includes('Trung tâm điều khiển'));
  assert.ok(iosThreadBound.answer.includes('iOS dưới 18'));
});

test('Self-learning filter rejects poisoned greeting/fallback catch-all entries from hijacking device & OTG queries', async () => {
  const { invalidateCache } = require('../src/ai-self-learning');
  invalidateCache();
  const poisonedPool = {
    query: async (sql) => {
      if (sql.includes("status = 'active'")) {
        return {
          rows: [{
            id: 'poison-1',
            status: 'active',
            source_type: 'customer_chat',
            topic: 'Hỏi đáp & Hướng dẫn: [IPHONE · ANDROID · PC]',
            triggers: ['iphone', 'android', 'pc', 'laptop', 'macbook', 'samsung', 'galaxy', 'oppo', 'vivo', 'xiaomi', 'otg', 'm3', 'gaeru m3', 'k9'],
            learned_facts: 'Xin chào bạn! Mình là **GAERU AI** - Trợ lý thông minh hỗ trợ trực tuyến 24/7 của GAERU. GAERU AI có thể giúp bạn ngay các nội dung sau: 1. Tư vấn micro & thiết bị...',
            sample_question: 'Iphone 15',
            sample_answer: 'Xin chào bạn! Mình là **GAERU AI** - Trợ lý thông minh hỗ trợ trực tuyến 24/7...',
            confidence_score: 1.0,
            occurrence_count: 68
          }]
        };
      }
      return { rows: [] };
    }
  };

  const q1 = await generateGaeruAiResponse({
    pool: poisonedPool,
    thread: { id: 't-1', product_id: 'prod-m3', product_name: 'GAERU M3' },
    question: 'MacBook Air M3, Galaxy Tab S10 và PC để bàn Windows dùng chân cắm gì cho GAERU M3?',
    catalog: CATALOG.map((p, idx) => idx === 1 ? { ...p, id: 'prod-m3' } : p)
  });
  assert.ok(!q1.answer.includes('Trợ lý thông minh'));
  assert.ok(q1.answer.includes('MacBook'));
  assert.ok(q1.answer.includes('Galaxy Tab'));
  assert.ok(q1.answer.includes('Type C + chuyển USB'));

  const q2 = await generateGaeruAiResponse({
    pool: poisonedPool,
    question: 'Hướng dẫn mở OTG và gỡ lỗi USB cho từng loại máy OPPO, vivo, Xiaomi, Samsung?',
    catalog: CATALOG
  });
  assert.ok(!q2.answer.includes('Trợ lý thông minh'));
  assert.ok(q2.answer.includes('Kết nối OTG'));
  assert.ok(q2.answer.includes('Gỡ lỗi USB'));
});

test('GAERU AI resolves purchase-closing intent to Buy Now CTA (respecting real stock) and client renders XSS-safe action cards', async () => {
  // 1. Multi-turn closing retains prior iPhone 17 Pro Max -> Type-C SKU on M3
  const multiTurnClose = await generateGaeruAiResponse({
    question: 'Ok chốt cho mình lấy bộ này nhé',
    catalog: CATALOG,
    history: [
      { sender: 'customer', body: 'Mình dùng iPhone 17 Pro Max hỏi GAERU M3 dùng bản nào?' },
      { sender: 'ai', body: 'GAERU M3 bản Type C cắm trực tiếp iPhone 17 Pro Max.' }
    ]
  });
  assert.ok(multiTurnClose.answer.includes('GAERU M3'));
  assert.ok(multiTurnClose.answer.includes('(/thanh-toan?variant=m3-c)'), `Expected exact M3 Type-C checkout CTA:\n${multiTurnClose.answer}`);
  assert.ok(!multiTurnClose.answer.includes('m3-u') && !multiTurnClose.answer.includes('m3-l'));

  // 2. Direct closing on K9 2 mic for PC Windows -> Chân Type C + Chuyển USB · Bộ 2 Micro
  const pcClose = await generateGaeruAiResponse({
    question: 'Chốt mua GAERU K9 bản 2 mic cho PC máy tính để bàn Windows nhé',
    catalog: CATALOG
  });
  assert.ok(pcClose.answer.includes('Chân Type C + Chuyển USB · Bộ 2 Micro'));
  assert.ok(pcClose.answer.includes('(/thanh-toan?variant=k9-2c-u)'));

  // 3. Out-of-stock GAERU G1 ULTRA must NOT suggest Buy Now for 0-stock SKU
  const oosClose = await generateGaeruAiResponse({
    question: 'Chốt đơn GAERU G1 ULTRA cho mình luôn nhé',
    catalog: CATALOG
  });
  assert.ok(oosClose.answer.includes('tạm hết hàng'));
  assert.ok(!oosClose.answer.includes('/thanh-toan?variant=g1-u'));
  assert.ok(oosClose.answer.includes('/san-pham/gaeru-k9') || oosClose.answer.includes('/san-pham/gaeru-m3'));

  // 4. Negated closing ("chưa chốt") stays pure informational without buy button
  const negatedClose = await generateGaeruAiResponse({
    question: 'Chưa chốt đâu, hỏi K9 pin dùng mấy tiếng?',
    catalog: CATALOG
  });
  assert.ok(negatedClose.answer.includes('2,5 giờ'));
  assert.ok(!negatedClose.answer.includes('/thanh-toan?variant='));

  // 5. Thread-bound closing with Laptop Windows -> resolves USB-A variant CTA cleanly
  const { answerCustomerChat } = require('../src/gaeru-ai-customer');
  const threadClose = await answerCustomerChat({
    pool: null,
    config: {},
    thread: { id: 't-1', product_id: 'prod-m3', product_name: 'GAERU M3' },
    question: 'Ok chốt lấy luôn bản cắm Laptop ASUS cổng USB thường nha',
    product: { products: CATALOG.map((p, idx) => idx === 1 ? { ...p, id: 'prod-m3' } : p) }
  });
  assert.ok(threadClose.answer.includes('Type C + chuyển USB'));
  assert.ok(threadClose.answer.includes('(/thanh-toan?variant=m3-u)'));

  // 6. Client formatMessageBody renders .chat-buy-card + Mua ngay + Thêm vào giỏ while blocking javascript: XSS
  const fs = require('node:fs');
  const vm = require('node:vm');
  const clientSrc = fs.readFileSync(require.resolve('../shopping-chat-client.js'), 'utf8');
  const snippet = clientSrc.slice(0, clientSrc.indexOf('  const ICONS =')) +
    '\nreturn { formatMessageBody, escape };})();';
  const helpers = vm.runInNewContext(snippet, {});
  const renderedBuy = helpers.formatMessageBody(
    'Xác nhận chốt **GAERU M3** · **Type C**.\n- 👉 [Mua ngay GAERU M3 · Type C (1.200.000 ₫)](/thanh-toan?variant=m3-c)',
    'ai',
    false
  );
  assert.ok(renderedBuy.includes('<strong>GAERU M3</strong>'));
  assert.ok(renderedBuy.includes('class="chat-buy-card"'));
  assert.ok(renderedBuy.includes('href="/thanh-toan?variant=m3-c"'));
  assert.ok(renderedBuy.includes('data-chat-add-variant="m3-c"'));

  const xssAttempt = helpers.formatMessageBody(
    '<img src=x onerror=alert(1)> [Hack](javascript:alert(1))',
    'ai',
    false
  );
  assert.ok(!xssAttempt.includes('<img'));
  assert.ok(!xssAttempt.includes('href="javascript:'));
});
