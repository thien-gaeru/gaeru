'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { generateGaeruAiResponse, answerCustomerChat } = require('../src/gaeru-ai-customer');
const {
  EXCLUDED_HTML,
  extractPageKnowledge,
  loadWebPagesIndex,
  clearWebKnowledgeCache,
  getRelevantWebKnowledge
} = require('../src/chat-web-knowledge');
const { scanAndHarvestPastChats } = require('../src/ai-self-learning');
const { matchCustomerSemanticFaq, CUSTOMER_SEMANTIC_FAQS } = require('../src/lib/customer-semantic-faq');
const { resetGpuAiState } = require('../src/lib/gpu-ai-client');

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

test('P0-1: HTML web knowledge excludes account/interactive pages, strips CTA chrome, retains full policy, and deduplicates globally', async () => {
  clearWebKnowledgeCache();
  assert.ok(EXCLUDED_HTML.has('account.html'));
  assert.ok(EXCLUDED_HTML.has('shop.html'));
  assert.ok(EXCLUDED_HTML.has('guides.html'));
  assert.ok(EXCLUDED_HTML.has('tracking.html'));

  const pages = loadWebPagesIndex();
  assert.ok(pages.length > 0);
  assert.ok(!pages.some(p => p.file === 'account.html'), 'account.html must never be indexed');
  for (const p of pages) {
    assert.ok(!p.content.includes('Xem hướng dẫn sản phẩm khác ↗'), `${p.file} leaked CTA button`);
    assert.ok(!p.content.includes('Chọn phiên bản Hướng dẫn sử dụng ↗'), `${p.file} leaked CTA link`);
    assert.ok(!p.content.includes('Cập nhật gần nhất:'), `${p.file} leaked date boilerplate`);
  }

  // delivery-returns.html must retain full content (>3500 chars, including Section 5 & warranty)
  const deliv = pages.find(p => p.file === 'delivery-returns.html');
  assert.ok(deliv && deliv.content.length > 3500, 'delivery-returns.html must not be truncated at 3500 chars');
  assert.ok(deliv.content.includes('Chính sách hoàn tiền'));

  // Global cross-page dedup guarantees no duplicate snippet lines
  const wk = await getRelevantWebKnowledge(null, { question: 'hướng dẫn sử dụng', transport: null });
  const normLines = (wk.relevantSnippets || []).map(s => s.line.toLowerCase().trim());
  assert.equal(new Set(normLines).size, normLines.length, 'relevantSnippets must be globally deduplicated');
});

test('P0-2: Screenshot bugs fixed (guide on M3, meta-complaints, thanks false-positive, hotline, VAT, Android camera app)', async () => {
  const m3Thread = { id: 't-m3', product_id: 'prod-m3', product_name: 'GAERU M3' };

  // 1. Screenshot bug: "hướng dẫn" on /san-pham/gaeru-m3
  const guideM3 = await generateGaeruAiResponse({ thread: m3Thread, question: 'hướng dẫn', catalog: FULL_CATALOG });
  assert.ok(guideM3.answer.includes('GAERU M3'));
  assert.ok(guideM3.answer.includes('/huong-dan/gaeru-m3'));
  assert.ok(!guideM3.answer.includes('Xem hướng dẫn sản phẩm khác ↗'));
  assert.ok(guideM3.answer.includes('Open Camera') || guideM3.answer.includes('Camera cài sẵn'));

  // 2. Generic "hướng dẫn sử dụng" lists clean product guide links without UI chrome
  const guideGen = await generateGaeruAiResponse({ question: 'hướng dẫn sử dụng', catalog: FULL_CATALOG });
  assert.ok(guideGen.answer.includes('/huong-dan/gaeru-k9'));
  assert.ok(guideGen.answer.includes('/huong-dan/gaeru-p185'));
  assert.ok(!guideGen.answer.includes('↗'));

  // 3. Screenshot bug: "sao trả lời lặp lại" -> apologetic clarification, NOT cold fallback
  const repeatComplaint = await generateGaeruAiResponse({ thread: m3Thread, question: 'sao trả lời lặp lại', catalog: FULL_CATALOG });
  assert.equal(Boolean(repeatComplaint.isFallback), false);
  assert.match(repeatComplaint.answer, /Xin lỗi|trùng lặp/i);
  assert.ok(repeatComplaint.answer.includes('082 919 1080'));

  // 4. Critical bug fix: "trả lời sai rồi không đúng ý" must NEVER reply "Dạ không có gì ạ!"
  const wrongComplaint = await generateGaeruAiResponse({ question: 'trả lời sai rồi không đúng ý', catalog: FULL_CATALOG });
  assert.ok(!wrongComplaint.answer.includes('Dạ không có gì ạ'));
  assert.match(wrongComplaint.answer, /Xin lỗi|Gặp nhân viên/i);

  // 5. User directive #1: NO VAT e-invoice
  const vatRes = await generateGaeruAiResponse({ question: 'bên shop có xuất hóa đơn đỏ VAT cho công ty không', catalog: FULL_CATALOG });
  assert.equal(Boolean(vatRes.isFallback), false);
  assert.match(vatRes.answer, /không hỗ trợ xuất hóa đơn VAT/i);

  // 6. User directive #2 + official GAERU Android insert: K9 explains OTG, Samsung USB Debugging, and third-party camera apps (TikTok/CapCut/Ulike/WutaCam/B612/Open Camera)
  const k9Res = await generateGaeruAiResponse({ question: 'k9', catalog: FULL_CATALOG });
  assert.ok(!k9Res.answer.includes('Plug & Play, không cần app/Bluetooth'));
  assert.match(k9Res.answer, /OPPO|Realme|Redmi/i);
  assert.match(k9Res.answer, /Gỡ lỗi USB/i);
  assert.match(k9Res.answer, /Ulike|WutaCam|B612|Open Camera/i);

  // 6b. Official GAERU sheet: Samsung A/M series + non-OTG Android need Gỡ lỗi USB & third-party camera apps
  const samsungARes = await generateGaeruAiResponse({ question: 'Samsung A55 quay bằng cam thường không nhận mic ngoài', catalog: FULL_CATALOG });
  assert.match(samsungARes.answer, /Gỡ lỗi USB/i);
  assert.match(samsungARes.answer, /dòng A|dòng M/i);
  assert.match(samsungARes.answer, /Ulike|WutaCam|B612/i);

  const guideK9Res = await generateGaeruAiResponse({ question: 'cách dùng k9', catalog: FULL_CATALOG });
  assert.match(guideK9Res.answer, /Gỡ lỗi USB/i);
  assert.match(guideK9Res.answer, /Ulike|WutaCam|B612/i);
  assert.ok(guideK9Res.answer.includes('082 919 1080'));

  // 7. Hotline & store address never leak account.html password reset form
  const hotlineRes = await generateGaeruAiResponse({ question: 'số điện thoại hotline shop là gì', catalog: FULL_CATALOG });
  assert.ok(hotlineRes.answer.includes('082 919 1080'));
  assert.ok(hotlineRes.answer.includes('business@gaeru.com'));
  assert.ok(!hotlineRes.answer.includes('liên kết dùng một lần'));

  const storeRes = await generateGaeruAiResponse({ question: 'shop ở đâu có cửa hàng mua trực tiếp không', catalog: FULL_CATALOG });
  assert.ok(storeRes.answer.includes('Ninh Bình'));
  assert.ok(storeRes.answer.includes('gaeru.com'));
});

test('P0-3: Hardware guides, policy alignment (7-day 1:1, COD inspection, regional shipping), internal K9 compare, P01 alias & quick chips', async () => {
  const m3Thread = { id: 't-m3', product_id: 'prod-m3', product_name: 'GAERU M3' };
  const k9Thread = { id: 't-k9', product_id: 'prod-k9', product_name: 'GAERU K9' };

  // COD open & test -> exterior inspection ONLY, no plug-in testing (NOT affiliate blog!)
  const codTest = await generateGaeruAiResponse({
    question: 'nhận hàng có được mở ra test thử không',
    catalog: FULL_CATALOG,
    webKnowledge: {
      latestNews: [{ url: '/tin-tuc/kich-ban-video-ngan-45-giay-chuyen-doi-cao-affiliate', title: 'Kịch bản video ngắn 45 giây đập tan nỗi sợ mua hàng: Thử nghiệm thật', summary: 'Affiliate' }]
    }
  });
  assert.match(codTest.answer, /ngoại quan/i);
  assert.match(codTest.answer, /Không được cắm thử/i);
  assert.ok(!codTest.answer.includes('affiliate'));

  // Return policy separated from warranty & aligned to 7 days
  const retRes = await generateGaeruAiResponse({ question: 'mua về không hợp có đổi trả được không', catalog: FULL_CATALOG });
  assert.ok(retRes.answer.includes('7 ngày'));
  assert.ok(!retRes.answer.includes('30 ngày'));

  // Warranty aligned to 12 months + 7-day 1:1
  const warRes = await generateGaeruAiResponse({ question: 'Chính sách bảo hành Care+', catalog: FULL_CATALOG });
  assert.ok(warRes.answer.includes('12 tháng'));
  assert.ok(warRes.answer.includes('1 đổi 1 trong 7 ngày'));
  assert.ok(!warRes.answer.includes('30 ngày'));

  // Regional shipping to Hanoi = 1-2 days + J&T Express included
  const hnShip = await generateGaeruAiResponse({ question: 'giao về Hà Nội mấy ngày nhận được', catalog: FULL_CATALOG });
  assert.ok(hnShip.answer.includes('1–2 ngày'));
  assert.ok(hnShip.answer.includes('J&T Express'));

  // K9 1 mic vs 2 mic compares K9 variants internally (NOT K9 vs M3 vs G1)
  const k9Cmp = await generateGaeruAiResponse({ question: 'K9 1 mic với 2 mic khác nhau gì', catalog: FULL_CATALOG });
  assert.ok(k9Cmp.answer.includes('Bộ 1 Micro'));
  assert.ok(k9Cmp.answer.includes('Bộ 2 Micro'));
  assert.ok(!k9Cmp.answer.includes('GAERU M3'));

  // P01 alias "chan quay tu dong xoay theo khuon mat" routes to P01 (NOT P185)
  const p01Alias = await generateGaeruAiResponse({ question: 'chan quay tu dong xoay theo khuon mat gia bao nhieu', catalog: FULL_CATALOG });
  assert.ok(p01Alias.answer.includes('GAERU P01'));
  assert.ok(!p01Alias.answer.includes('GAERU P185'));

  // LED blinking M3, noise mode button M3, P185 remote Bluetooth, K9 waterproof, bulk discount
  const ledM3 = await generateGaeruAiResponse({ question: 'đèn trên mic M3 nhấp nháy đỏ xanh là bị gì', catalog: FULL_CATALOG });
  assert.match(ledM3.answer, /ghép nối|pin yếu/i);

  const noiseBtnM3 = await generateGaeruAiResponse({ question: 'cách bật chế độ lọc ồn trên M3', catalog: FULL_CATALOG });
  assert.match(noiseBtnM3.answer, /Bấm nhanh|nút nguồn/i);

  const p185Remote = await generateGaeruAiResponse({ question: 'cách kết nối remote gậy P185', catalog: FULL_CATALOG });
  assert.match(p185Remote.answer, /Bluetooth/i);
  assert.ok(p185Remote.answer.includes('55 mAh'));

  const waterproof = await generateGaeruAiResponse({ question: 'mic K9 có chống nước đi mưa được không', catalog: FULL_CATALOG });
  assert.match(waterproof.answer, /không có chuẩn chống nước/i);

  const bulk = await generateGaeruAiResponse({ question: 'mua 3 bộ có giảm giá không shop', catalog: FULL_CATALOG });
  assert.match(bulk.answer, /mua sỉ|Gặp nhân viên|082 919 1080/i);

  // Quick-reply chip "Hướng dẫn kết nối thiết bị" on M3 & K9 product pages gives full connection guide
  const chipConnectM3 = await generateGaeruAiResponse({ thread: m3Thread, question: 'Hướng dẫn kết nối thiết bị', catalog: FULL_CATALOG });
  assert.ok(chipConnectM3.answer.includes('iOS 18+'));
  assert.ok(chipConnectM3.answer.includes('Kết nối OTG'));
  assert.ok(chipConnectM3.answer.includes('Open Camera'));

  const chipVersionK9 = await generateGaeruAiResponse({ thread: k9Thread, question: 'Tư vấn chọn phiên bản phù hợp', catalog: FULL_CATALOG });
  assert.ok(chipVersionK9.answer.includes('Bộ 1 Micro'));
  assert.ok(chipVersionK9.answer.includes('Chân Type C'));
});

test('P1: Multi-turn follow-up, missing brands (Google/LG/Readme), typo K9, anti-repeat guard & echo-chamber elimination', async () => {
  // Multi-turn follow-up: "iphone" -> "15" & "14 pro max"
  const histIphone = [
    { sender: 'customer', body: 'iphone' },
    { sender: 'ai', body: 'iPhone 15–18 dùng Type-C; iPhone 14 trở xuống dùng Lightning.' }
  ];
  const f15 = await generateGaeruAiResponse({ question: '15', history: histIphone, catalog: FULL_CATALOG });
  assert.equal(Boolean(f15.isFallback), false);
  assert.ok(f15.answer.includes('iPhone 15'));
  assert.ok(f15.answer.includes('Type-C'));

  const f14pm = await generateGaeruAiResponse({ question: '14 pro max', history: histIphone, catalog: FULL_CATALOG });
  assert.equal(Boolean(f14pm.isFallback), false);
  assert.ok(f14pm.answer.includes('iPhone 14 Pro Max'));
  assert.ok(f14pm.answer.includes('Lightning'));

  // Missing brands from live chat logs: "google", "lg", "readme"
  const gRes = await generateGaeruAiResponse({ question: 'google', catalog: FULL_CATALOG });
  assert.equal(Boolean(gRes.isFallback), false);
  assert.ok(gRes.answer.includes('Google Pixel'));

  const lgRes = await generateGaeruAiResponse({ question: 'lg', catalog: FULL_CATALOG });
  assert.equal(Boolean(lgRes.isFallback), false);
  assert.ok(lgRes.answer.includes('LG'));

  const readmeRes = await generateGaeruAiResponse({ question: 'điện thoại readme có cần tải app không', catalog: FULL_CATALOG });
  assert.ok(readmeRes.answer.includes('Xiaomi / Redmi'));
  assert.ok(readmeRes.answer.includes('Open Camera'));

  // Typo rescue: "mic ki gia bao nhieu" -> GAERU K9
  const typoK9 = await generateGaeruAiResponse({ question: 'mic ki gia bao nhieu', catalog: FULL_CATALOG });
  assert.ok(typoK9.answer.includes('GAERU K9'));
  assert.ok(typoK9.answer.includes('289.000 ₫'));

  // Short conversational reaction "vậy sao" doesn't cold-fallback
  const reactRes = await generateGaeruAiResponse({ question: 'vậy sao', catalog: FULL_CATALOG });
  assert.equal(Boolean(reactRes.isFallback), false);

  // Anti-repeat guard prevents identical back-to-back AI text on different follow-up questions
  const firstReply = await generateGaeruAiResponse({ question: 'bảo hành', catalog: FULL_CATALOG });
  const repeatHistory = [
    { sender: 'customer', body: 'bảo hành' },
    { sender: 'ai', body: firstReply.answer }
  ];
  const secondReply = await generateGaeruAiResponse({ question: 'sửa chữa', history: repeatHistory, catalog: FULL_CATALOG });
  assert.notEqual(secondReply.answer, firstReply.answer);
  assert.match(secondReply.answer, /tránh lặp lại/i);

  // Echo-chamber elimination: answerCustomerChat MUST NOT write AI's own replies to ai_learned_knowledge
  let learnedInsertCount = 0;
  const trackingPool = {
    async query(sql) {
      if (/INSERT INTO ai_learned_knowledge/i.test(sql)) learnedInsertCount++;
      return { rows: [] };
    }
  };
  await answerCustomerChat({
    pool: trackingPool,
    config: {},
    thread: { id: 't-echo' },
    question: 'GAERU M3 pin dùng mấy tiếng?',
    product: { products: FULL_CATALOG }
  });
  assert.equal(learnedInsertCount, 0, 'answerCustomerChat must not self-harvest AI replies into ai_learned_knowledge');

  // scanAndHarvestPastChats MUST skip sender='ai' and only harvest admin/staff
  let harvestedCount = 0;
  const harvestMockPool = {
    async query(sql) {
      if (/FROM shopping_chat_messages/i.test(sql)) {
        return {
          rows: [
            { id: 1, thread_id: 'th-1', sender: 'customer', body: 'Mic K9 có chống nước không shop?', created_at: new Date() },
            { id: 2, thread_id: 'th-1', sender: 'ai', body: 'Câu trả lời tự động của GAERU AI.', created_at: new Date() }
          ]
        };
      }
      if (/INSERT INTO ai_learned_knowledge/i.test(sql)) harvestedCount++;
      return { rows: [] };
    }
  };
  const scanRes = await scanAndHarvestPastChats(harvestMockPool, { limit: 20 });
  assert.equal(scanRes.processed, 0);
  assert.equal(harvestedCount, 0);
});

test('P2: Customer Semantic FAQ Rescue matches paraphrased queries via GPU embeddings and rejects off-topic noise', async () => {
  resetGpuAiState();
  assert.ok(CUSTOMER_SEMANTIC_FAQS.length >= 10);

  const mockTransport = async (_url, init) => {
    const inp = JSON.parse(init.body).input;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: inp.map((txt, idx) => {
            const norm = txt.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
            if (/vat|hoa don|doanh nghiep|chung tu thue/.test(norm)) return { index: idx, embedding: [0.98, 0.1, 0, 0] };
            if (/troi mua|thoi tiet/.test(norm)) return { index: idx, embedding: [0, 0, 0, 1] };
            return { index: idx, embedding: [0.05, 0.98, 0.1, 0] };
          })
        };
      }
    };
  };

  const rescued = await matchCustomerSemanticFaq(null, 'bên mình có cấp chứng từ thuế doanh nghiệp không', { transport: mockTransport });
  assert.ok(rescued);
  assert.equal(rescued.key, 'faq_vat_invoice');
  assert.match(rescued.answer, /không hỗ trợ xuất hóa đơn VAT/i);

  const offTopic = await matchCustomerSemanticFaq(null, 'hôm nay thời tiết ngoài trời mưa không', { transport: mockTransport });
  assert.equal(offTopic, null);
});
