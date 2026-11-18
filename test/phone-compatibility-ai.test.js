'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateGaeruAiResponse } = require('../src/gaeru-ai-customer');
const { expandQueryVi, resolveMentionedProducts } = require('../src/lib/ai-nlu');
const { getExternalWebKnowledge } = require('../src/chat-external-knowledge');

const CATALOG = [
  { slug: 'gaeru-k9', name: 'GAERU K9', category: 'audio', variants: [{ name: 'Chân Type C', priceVnd: 289000 }, { name: 'Chân Type C + Chuyển Lightning · Bộ 1 Micro', priceVnd: 339000 }] },
  { slug: 'gaeru-m3', name: 'GAERU M3', category: 'audio', variants: [{ name: 'Type C', priceVnd: 1200000 }, { name: 'Type C + đầu chuyển Lightning', priceVnd: 1200000 }] },
  { slug: 'gaeru-g1-ultra', name: 'GAERU G1 ULTRA', category: 'audio', variants: [{ name: 'GAERU G1 ULTRA', priceVnd: 2100000 }] },
  { slug: 'gaeru-p01', name: 'GAERU P01', category: 'video', variants: [{ name: 'Gimbal P01 để bàn', priceVnd: 550000 }] },
  { slug: 'gaeru-p185', name: 'GAERU P185', category: 'video', variants: [{ name: 'Phiên bản tiêu chuẩn', priceVnd: 450000 }] }
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
