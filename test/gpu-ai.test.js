'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  segmentForegroundMask,
  embedTexts,
  cosineSimilarity,
  resetGpuAiState,
  checkGpuHealth,
  isCircuitOpen,
  DEFAULT_EMBED_BATCH_SIZE,
  DEFAULT_EMBED_TIMEOUT_MS,
  DEFAULT_RMBG_TIMEOUT_MS,
  MAX_EMBED_TEXT_CHARS
} = require('../src/lib/gpu-ai-client');
const { removeWhiteBackground } = require('../src/lib/product-background');
const { matchLearnedKnowledge, invalidateCache } = require('../src/ai-self-learning');
const { getRelevantWebKnowledge, clearWebKnowledgeCache } = require('../src/chat-web-knowledge');
const { generateGaeruAiResponse } = require('../src/gaeru-ai-customer');

function makeMask320Rect(x0 = 80, y0 = 60, x1 = 240, y1 = 260) {
  const buf = Buffer.alloc(320 * 320, 0);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      buf[y * 320 + x] = 255;
    }
  }
  return buf;
}

test('gpu-ai-client caches embeddings and trips circuit cleanly on failure', async () => {
  resetGpuAiState();
  let calls = 0;
  const mockTransport = async (url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: body.input.map((t, idx) => ({
            index: idx,
            embedding: t.includes('pin') ? [1, 0, 0, 0] : [0, 1, 0, 0]
          }))
        };
      }
    };
  };

  const v1 = await embedTexts(['thoi luong pin M3', 'chinh sach ship'], { transport: mockTransport });
  assert.equal(calls, 1);
  assert.equal(v1.length, 2);
  assert.ok(Math.abs(cosineSimilarity(v1[0], v1[1])) < 1e-6);

  const v2 = await embedTexts(['thoi luong pin M3'], { transport: mockTransport });
  assert.equal(calls, 1, 'cached embedding should not re-call transport');
  assert.ok(cosineSimilarity(v1[0], v2[0]) > 0.999);

  const errMask = await segmentForegroundMask(Buffer.alloc(320 * 320 * 3, 10), {
    transport: async () => { throw new Error('connect ECONNREFUSED'); }
  });
  assert.equal(errMask, null);
});

test('product-background uses AI segmentation on non-white textured image and falls back cleanly', async () => {
  const w = 120, h = 120;
  const raw = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inObj = x >= 30 && x < 90 && y >= 25 && y < 95;
      raw[i + 0] = inObj ? 25 : 40 + (x % 80);
      raw[i + 1] = inObj ? 30 : 90 + (y % 70);
      raw[i + 2] = inObj ? 35 : 150;
      raw[i + 3] = 255;
    }
  }
  const photoBuf = await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

  const out = await removeWhiteBackground(photoBuf, {
    autoCenterSquare: false,
    gpuTransport: async () => {
      const mask = makeMask320Rect(80, 66, 240, 253);
      return {
        ok: true,
        status: 200,
        headers: new Map([['x-foreground-ratio', '0.29']]),
        async arrayBuffer() { return mask.buffer.slice(mask.byteOffset, mask.byteOffset + mask.byteLength); }
      };
    }
  });
  assert.ok(Buffer.isBuffer(out));
  assert.ok(Buffer.isBuffer(out.thumbBuffer));

  const decoded = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.data[3], 0, 'corner pixel must become transparent');
  const centerIdx = (Math.floor(decoded.info.height / 2) * decoded.info.width + Math.floor(decoded.info.width / 2)) * 4;
  assert.ok(decoded.data[centerIdx + 3] > 230, 'center subject must stay opaque');

  // Uniform non-white image must stay null and never accept AI cut
  const solid = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#224466' } }).png().toBuffer();
  assert.equal(await removeWhiteBackground(solid, {
    gpuTransport: async () => { throw new Error('should not be called for uniform solid'); }
  }), null);

  // Safe fallback to null when GPU errors
  const fallbackOut = await removeWhiteBackground(photoBuf, {
    gpuTransport: async () => { throw new Error('GPU busy'); }
  });
  assert.equal(fallbackOut, null);
});

test('ai-self-learning semantic matching rescues paraphrases and enforces intent conflict guard', async () => {
  resetGpuAiState();
  invalidateCache();

  const mockPool = {
    async query() {
      return {
        rows: [
          {
            id: 101,
            topic: 'Thời lượng pin micro GAERU M3',
            triggers: ['pin m3', 'sac day', 'dung luong pin'],
            sample_question: 'Pin GAERU M3 sử dụng liên tục được bao lâu?',
            learned_facts: 'Pin micro GAERU M3 sử dụng liên tục 6 đến 8 giờ sau mỗi lần sạc đầy.',
            confidence_score: 0.92,
            occurrence_count: 5
          },
          {
            id: 102,
            topic: 'Hướng dẫn cài GAERU M3 trên OBS Studio',
            triggers: ['m3', 'obs', 'obs studio', 'laptop'],
            sample_question: 'Làm sao thu âm trên OBS?',
            learned_facts: 'Chọn Audio Input Capture trong OBS Studio rồi trỏ vào micro GAERU.',
            confidence_score: 0.90,
            occurrence_count: 4
          }
        ]
      };
    }
  };

  const simTransport = async (_url, init) => {
    const body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: body.input.map((txt, idx) => ({
            index: idx,
            embedding: /pin|tieng|sac|bao lau|6 den 8/i.test(txt.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd'))
              ? [0.95, 0.05, 0]
              : [0.05, 0.95, 0]
          }))
        };
      }
    };
  };

  // Paraphrase misses exact triggers ['pin m3', 'sac day', 'dung luong pin'], rescued semantically
  const matched = await matchLearnedKnowledge(mockPool, 'pin sài được mấy tiếng vậy shop', {
    minScore: 0.65,
    gpuTransport: simTransport
  });
  assert.ok(matched);
  assert.equal(matched.entry.id, 101);
  assert.equal(matched.semantic, true);

  // Price question must NEVER hijack into OBS or Battery even if mock cosine were high
  const blockedPrice = await matchLearnedKnowledge(mockPool, 'Giá GAERU M3 bao nhiêu tiền?', {
    minScore: 0.65,
    gpuTransport: async (_u, init) => ({
      ok: true,
      status: 200,
      async json() {
        const inp = JSON.parse(init.body).input;
        return { data: inp.map((_, idx) => ({ index: idx, embedding: [1, 0, 0] })) };
      }
    })
  });
  assert.equal(blockedPrice, null);

  // Graceful fallback on GPU error
  const down = await matchLearnedKnowledge(mockPool, 'câu hỏi hoàn toàn không khớp từ khóa', {
    minScore: 0.65,
    gpuTransport: async () => { throw new Error('ECONNREFUSED'); }
  });
  assert.equal(down, null);
});

test('chat-web-knowledge keeps CPU behavior cleanly if GPU unavailable', async () => {
  clearWebKnowledgeCache();
  const mockPool = { async query() { return { rows: [] }; } };
  const wk = await getRelevantWebKnowledge(mockPool, {
    question: 'muốn gửi hoàn trả đơn hàng do lỗi thì làm sao',
    gpuTransport: async () => { throw new Error('offline'); }
  });
  assert.ok(Array.isArray(wk.webPages));
  assert.ok(wk.webPages.length > 0);
});

test('gpu-ai-client uses Adreno-safe batching, 320-char cap, and answers outdoor wind queries without fallback', async () => {
  assert.equal(DEFAULT_EMBED_BATCH_SIZE, 3);
  assert.equal(DEFAULT_EMBED_TIMEOUT_MS, 12000);
  assert.equal(DEFAULT_RMBG_TIMEOUT_MS, 10000);
  assert.equal(MAX_EMBED_TEXT_CHARS, 320);

  resetGpuAiState();
  const batchSizes = [];
  const longTexts = Array.from({ length: 7 }, (_, i) => `${i}: ` + 'thu am ngoai troi '.repeat(30));
  const vecs = await embedTexts(longTexts, {
    transport: async (_url, init) => {
      const payload = JSON.parse(init.body);
      batchSizes.push(payload.input.length);
      for (const s of payload.input) assert.ok(s.length <= 320);
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: payload.input.map((_, idx) => ({ index: idx, embedding: [1, idx, 0, 0] })) };
        }
      };
    }
  });
  assert.deepEqual(batchSizes, [3, 3, 1]);
  assert.equal(vecs.length, 7);

  // Single timeout on fetch must not immediately lock GPU circuit, whereas 2 consecutive timeouts trip circuit
  resetGpuAiState();
  const prevEnv = process.env.GAERU_GPU_AI_ENABLED;
  const origFetch = globalThis.fetch;
  process.env.GAERU_GPU_AI_ENABLED = '1';
  globalThis.fetch = async () => {
    const err = new Error('timeout');
    err.name = 'AbortError';
    throw err;
  };
  try {
    assert.equal(await embedTexts(['cau thu 1']), null);
    assert.equal(isCircuitOpen(), false, 'single transient timeout keeps GPU circuit closed');
    assert.equal(await embedTexts(['cau thu 2']), null);
    assert.equal(isCircuitOpen(), true, 'consecutive failures trip GPU circuit');
  } finally {
    globalThis.fetch = origFetch;
    if (prevEnv === undefined) delete process.env.GAERU_GPU_AI_ENABLED;
    else process.env.GAERU_GPU_AI_ENABLED = prevEnv;
    resetGpuAiState();
  }

  // Outdoor windy clarity query resolves to deadcat / wind protection advice instead of fallback
  const windRes = await generateGaeruAiResponse({
    question: 'làm sao để tiếng thu vào rõ hơn khi quay ngoài đường nhiều gió',
    catalog: []
  });
  assert.equal(Boolean(windRes.isFallback), false);
  assert.match(windRes.answer, /lọc gió|Deadcat|10–15 cm|15–20 cm/i);
});

if (process.env.GAERU_GPU_AI_TEST === '1') {
  test('LIVE Adreno 540 GPU daemon removes background & computes Vietnamese semantic embeddings', async () => {
    resetGpuAiState();
    const health = await checkGpuHealth({ timeoutMs: 2500 });
    assert.ok(health && health.ok === true, 'gaeru-gpu-ai /health must report ok:true');
    assert.equal(health.ready.rmbg, true);
    assert.equal(health.ready.embed, true);

    // Live RMBG on non-white studio banner photo in GAERU media/
    const sampleImg = await sharp('media/products/4e536aa8-f614-422d-bb46-c3e09f0d6e7e.jpg').toBuffer();
    const cutout = await removeWhiteBackground(sampleImg, { autoCenterSquare: true, canvasSize: 800 });
    assert.ok(Buffer.isBuffer(cutout), 'live GPU cutout should succeed on non-white product photo');
    assert.ok(Buffer.isBuffer(cutout.thumbBuffer));
    const info = await sharp(cutout).metadata();
    assert.equal(info.hasAlpha, true);

    // Live Vietnamese semantic similarity
    const texts = [
      'đơn hàng bao nhiêu tiền thì được miễn phí vận chuyển',
      'Miễn phí giao hàng toàn quốc (freeship) cho đơn hàng từ 300.000đ trở lên',
      'Hướng dẫn kết nối micro trên OBS Studio cho laptop',
      'Cáp chuyển đổi OTG Type-C dành cho Android'
    ];
    const vecs = await embedTexts(texts);
    assert.ok(Array.isArray(vecs) && vecs.length === 4);
    const sShip = cosineSimilarity(vecs[0], vecs[1]);
    const sObs = cosineSimilarity(vecs[0], vecs[2]);
    const sOtg = cosineSimilarity(vecs[0], vecs[3]);
    assert.ok(sShip > 0.60 && sShip > sObs && sShip > sOtg,
      `Expected Ship (${sShip.toFixed(3)}) > OBS (${sObs.toFixed(3)}) and OTG (${sOtg.toFixed(3)})`);
  });
}
