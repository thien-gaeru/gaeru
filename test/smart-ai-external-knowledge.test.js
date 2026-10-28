const test = require('node:test');
const assert = require('node:assert/strict');
const { getExternalWebKnowledge, searchLiveWeb, TECH_ECOSYSTEM_KNOWLEDGE } = require('../src/chat-external-knowledge');
const { getRelevantWebKnowledge } = require('../src/chat-web-knowledge');
const { generate } = require('../src/chat-ai-provider');

test('External knowledge provides curated tech ecosystem facts for devices and audio applications', async () => {
  // 1. iPhone 15 Type-C compatibility query
  const iphoneKnowledge = await getExternalWebKnowledge({
    question: 'iPhone 15 cắm mic thu âm Type C có nhận không?',
    selectedProduct: { name: 'GAERU K9', slug: 'gaeru-k9' }
  });
  assert.ok(iphoneKnowledge.ecosystemFacts.length > 0, 'Should return ecosystem facts for iPhone');
  assert.ok(iphoneKnowledge.ecosystemFacts.some(f => f.includes('iPhone 15') && f.includes('Type-C')));

  // 2. Android OTG query
  const androidKnowledge = await getExternalWebKnowledge({
    question: 'Điện thoại Oppo và Vivo không nhận mic, đèn không sáng thì làm sao?',
    selectedProduct: null
  });
  assert.ok(androidKnowledge.ecosystemFacts.some(f => f.includes('OTG')));

  // 3. Camera apps & TikTok / CapCut
  const appKnowledge = await getExternalWebKnowledge({
    question: 'Mic có dùng được khi quay CapCut và livestream TikTok không?'
  });
  assert.ok(appKnowledge.ecosystemFacts.some(f => f.includes('TikTok') || f.includes('CapCut')));

  // 4. Noise reduction & 2.4GHz
  const noiseKnowledge = await getExternalWebKnowledge({
    question: 'Mic này lọc tiếng ồn ngoài đường và bắt sóng xa bao nhiêu mét?'
  });
  assert.ok(noiseKnowledge.ecosystemFacts.some(f => f.includes('DSP') || f.includes('2.4GHz')));
});

test('Live search retrieves web snippets and caches repeat queries', async () => {
  let callCount = 0;
  const mockTransport = async (url) => {
    callCount++;
    assert.ok(url.includes('duckduckgo.com'));
    return {
      ok: true,
      text: async () => `
        <div class="result">
          <a class="result__snippet">Micro thu âm không dây Type C cắm vào điện thoại nhận ngay âm thanh rõ nét.</a>
        </div>
      `
    };
  };

  const query = 'cách dùng mic thu am không day cho iphone';
  const result1 = await getExternalWebKnowledge({
    question: query,
    transport: mockTransport
  });
  assert.equal(callCount, 1);
  assert.ok(result1.searchSnippets.length > 0);
  assert.ok(result1.searchSnippets[0].includes('Micro thu âm không dây'));

  // Second call with same question must hit cache
  const result2 = await getExternalWebKnowledge({
    question: query,
    transport: mockTransport
  });
  assert.equal(callCount, 1, 'Repeated question should hit in-memory cache without repeating network request');
  assert.deepEqual(result2.searchSnippets, result1.searchSnippets);
});

test('getRelevantWebKnowledge combines webPages and externalKnowledge seamlessly', async () => {
  const knowledge = await getRelevantWebKnowledge(null, {
    question: 'iPhone 15 dùng mic GAERU K9 như thế nào và chính sách bảo hành ra sao?',
    selectedProduct: { name: 'GAERU K9', slug: 'gaeru-k9' },
    transport: async () => ({
      ok: true,
      text: async () => '<a class="result__snippet">Thông tin bên ngoài web về cổng Type-C trên thiết bị mới.</a>'
    })
  });

  assert.ok(Array.isArray(knowledge.webPages));
  assert.ok(knowledge.externalKnowledge, 'Must include externalKnowledge');
  assert.ok(Array.isArray(knowledge.externalKnowledge.ecosystemFacts));
  assert.ok(Array.isArray(knowledge.externalKnowledge.searchSnippets));
});

test('AI provider instructions support natural, intelligent consultation without premature handoff', async () => {
  let capturedBody = null;
  const mockTransport = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        output: [{
          content: [{
            type: 'output_text',
            text: JSON.stringify({
              answer: 'Dạ chào bạn! iPhone 15 dùng cổng Type-C nên bạn chỉ cần cắm trực tiếp đầu thu mic GAERU K9 vào máy là có thể quay phim, thu âm trên TikTok, CapCut ngay mà không cần bất kỳ jack chuyển nào ạ.',
              handoff: false
            })
          }]
        }]
      })
    };
  };

  const settings = {
    enabled: true,
    provider: 'openai',
    apiKey: 'test-key',
    model: 'gpt-4.1-mini'
  };

  const product = {
    name: 'GAERU K9',
    description: 'Mic thu âm không dây cài áo',
    webKnowledge: {
      externalKnowledge: {
        ecosystemFacts: ['iPhone 15 cắm trực tiếp Type-C nhận ngay.']
      }
    }
  };

  const res = await generate({
    settings,
    product,
    question: 'iPhone 15 cắm mic này dùng được ngay không?',
    decision: true,
    transport: mockTransport
  });

  assert.equal(res.handoff, false, 'Should answer naturally instead of handing off');
  assert.ok(res.answer.includes('iPhone 15'));
  assert.ok(capturedBody.instructions.includes('chuyên viên tư vấn công nghệ'));
  assert.ok(capturedBody.instructions.includes('externalKnowledge'));
});
