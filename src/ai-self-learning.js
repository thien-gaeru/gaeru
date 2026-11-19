'use strict';

/**
 * GAERU AI Autonomous Continuous Self-Learning Engine
 * 
 * Hệ thống tự học hỏi và tích lũy tri thức độc lập nội bộ từ các cuộc hội thoại:
 * 1. Thu thập & chiết xuất Q&A từ tương tác khách hàng & nhân viên tư vấn.
 * 2. Bảo mật Zero-Trust: Khử sạch 100% PII (SĐT, Email, Tên riêng, Mã đơn, Địa chỉ, Thẻ ngân hàng).
 * 3. Chuẩn hóa & Gán nhãn tri thức: Tự động trích xuất bộ từ khóa kích hoạt (triggers), chủ đề (topic), dữ kiện chuẩn hóa (facts).
 * 4. Tự động chấm điểm độ tin cậy (Confidence Scoring) & Tần suất xuất hiện (Occurrence Counter).
 * 5. Truy hồi & Ứng dụng tức thì (Real-time Grounding): Cung cấp kiến thức đã học vào câu trả lời của GAERU AI.
 * 6. Quản trị minh bạch: Cho phép kiểm tra, phê duyệt, tinh chỉnh và quản lý qua Admin Dashboard.
 */

const { randomUUID } = require('node:crypto');
const {
  normalizeVi,
  hasBoundaryTerm,
  hasAnyBoundaryTerm,
  tokenizeMeaningful,
  tokenOverlapScore
} = require('./lib/ai-nlu');
const { embedText, embedTexts, cosineSimilarity, isGpuAiEnabled } = require('./lib/gpu-ai-client');
const { ensureEmbeddings, rankByCosine } = require('./lib/embedding-store');

// In-memory cache cho tri thức tự học (TTL 60s, tự động làm mới khi có tri thức mới)
let learnedKnowledgeCache = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60000;

function clearLocalCache() {
  learnedKnowledgeCache = null;
  cacheExpiresAt = 0;
}

function invalidateCache() {
  clearLocalCache();
  if (typeof process.send === 'function') {
    try {
      process.send({ type: 'AI_KNOWLEDGE_INVALIDATE', timestamp: Date.now() });
    } catch (_) {}
  }
}

const IPC_LISTENER_KEY = Symbol.for('gaeru.aiSelfLearning.ipcRegistered');
if (typeof process.on === 'function' && !process[IPC_LISTENER_KEY]) {
  process[IPC_LISTENER_KEY] = true;
  process.on('message', (msg) => {
    if (msg && msg.type === 'AI_KNOWLEDGE_INVALIDATE') {
      clearLocalCache();
    }
  });
}

/**
 * Khử sạch 100% PII (Personal Identifiable Information) để bảo vệ quyền riêng tư Zero-Trust
 */
function sanitizePii(text) {
  if (!text || typeof text !== 'string') return '';

  return text
    // Số điện thoại Việt Nam (09x, 08x, 07x, 03x, 05x, +84x..., kể cả tách dấu chấm / gạch / khoảng trắng)
    .replace(/(?:\+84|84|0)[\s.-]*(?:3[2-9]|5[2689]|7[06-9]|8[1-9]|9[0-9])(?:[\s.-]*\d){7}\b/g, '[SĐT_ĐÃ_ẨN]')
    .replace(/\b0(?:[\s.-]*\d){9}\b/g, '[SĐT_ĐÃ_ẨN]')
    // Email
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_ĐÃ_ẨN]')
    // Mã đơn hàng GR-... / GAE-... / TEST-... (xử lý trước chuỗi số dài để không cắt nhầm phần ngày)
    .replace(/\b(?:gr|gae|test)-[a-zA-Z0-9-]+\b/gi, '[MÃ_ĐƠN_HÀNG]')
    // Số tài khoản ngân hàng / thẻ (dãy 8 - 19 số liên tiếp)
    .replace(/\b\d{8,19}\b/g, '[SỐ_TÀI_KHOẢN_ĐÃ_ẨN]')
    // Mã vận đơn
    .replace(/\b(?:VTP|SPX|VNPOST|GHTK|GHN)[A-Z0-9]{8,18}\b/gi, '[MÃ_VẬN_ĐƠN]')
    // Họ tên khách hàng qua nhãn
    .replace(/(?:khách hàng|người nhận|chủ đơn)\s*:\s*[^\n,]+/gi, '[KHÁCH_HÀNG_ĐÃ_ẨN]')
    // Địa chỉ giao hàng
    .replace(/(?:địa chỉ(?:\s*giao hàng)?|địa chỉ nhận hàng)\s*:\s*[^\n]+/gi, '[ĐỊA_CHỈ_ĐÃ_ẨN]')
    // Chuẩn hóa khoảng trắng
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Chuẩn hóa chuỗi tìm kiếm tiếng Việt không dấu
 */
function normalizeText(text) {
  return normalizeVi(text);
}

function isLowValueLearnedAnswer(answerText) {
  const norm = normalizeText(answerText);
  if (!norm || norm.length < 10) return true;
  return /tro ly thong minh ho tro truc tuyen|co the giup ban ngay cac noi dung sau|ai hien chua the tra loi|ai chua the tiep tuc tra loi|minh chua ro dung y|toi chua ro dung y|\/thanh-toan\?variant=|xac nhan chot|trao doi ve dien thoai, nhu cau quay|khong tu thao thiet bi de xu ly loi|tai khoan cua ban:|so du hien tai:|phieu bao hanh cua tai khoan ban:|yeu cau gaeru care\+ gan day|hien .* dang tam het hang|con hang\)|tam het\)/.test(norm);
}

const GENERIC_SINGLE_TRIGGERS = new Set([
  'p01', 'k9', 'm3', 'p185', 'g1', 'g1 ultra', 'gaeru p01', 'gaeru k9', 'gaeru m3', 'gaeru p185',
  'micro', 'iphone', 'android', 'laptop', 'pc', 'may tinh', 'dien thoai', 'pin', 'camera'
]);

// Từ điển từ khóa công nghệ, thiết bị, cổng kết nối, ứng dụng và âm thanh
const TECH_VOCABULARY = [
  // Dòng máy iPhone / iOS (cập nhật 2025–2026)
  'iphone', 'iphone 11', 'iphone 12', 'iphone 13', 'iphone 14', 'iphone 15', 'iphone 16', 'iphone 16e',
  'iphone 17', 'iphone 17 air', 'iphone air', 'iphone 17e', 'iphone 18',
  'iphone 15 pro', 'iphone 15 pro max', 'iphone 16 pro', 'iphone 16 pro max', 'iphone 17 pro', 'iphone 17 pro max', 'iphone 18 pro', 'iphone 18 pro max',
  'iphone plus', 'iphone pro max', 'iphone se', 'ipad', 'ipad pro', 'ipad air', 'ipad mini', 'macbook', 'macbook pro', 'macbook air', 'ios',
  // Dòng máy Android & Hãng (cập nhật 2025–2026)
  'samsung', 'galaxy', 's24', 's25', 's26', 'z fold', 'z flip', 'a55', 'a56', 'a36',
  'oppo', 'find x8', 'find x9', 'find x10', 'find n5', 'reno 13', 'reno 14', 'reno 15', 'reno 16',
  'xiaomi', 'xiaomi 15', 'xiaomi 17', 'xiaomi 18', 'redmi', 'redmi note 13', 'redmi note 14', 'redmi note 15', 'poco', 'poco x7', 'poco f7',
  'vivo', 'vivo x200', 'vivo x300', 'vivo v40', 'vivo v50', 'iqoo', 'realme', 'realme 14', 'realme 15', 'realme 16',
  'honor', 'magic 7', 'magic 8', 'huawei', 'pura 70', 'pura 80', 'mate 70',
  'google pixel', 'pixel', 'pixel 9', 'pixel 10', 'pixel 11', 'oneplus', 'tecno', 'infinix', 'nothing phone', 'rog phone', 'redmagic', 'nubia', 'xperia', 'motorola', 'nokia', 'android',
  // Máy tính bảng, Laptop, PC, máy ảnh (cập nhật 2025–2026)
  'may tinh bang', 'tablet', 'galaxy tab', 'xiaomi pad', 'redmi pad', 'oppo pad', 'vivo pad', 'matepad', 'honor pad', 'lenovo tab', 'surface', 'surface pro', 'surface go',
  'macbook', 'macbook air', 'macbook pro', 'imac', 'mac mini', 'mac studio',
  'pc', 'laptop', 'windows', 'windows 10', 'windows 11', 'may tinh', 'may tinh ban', 'sony', 'canon', 'fujifilm', 'nikon', 'may anh', 'camera',
  // Cổng kết nối, OTG, Gỡ lỗi USB, iOS Mic & Mua hàng
  'type-c', 'type c', 'usb-c', 'lightning', 'chan lightning', 'micro-usb', 'micro usb', 'jack 3.5', '3.5mm', 'trs', 'trrs', 'otg', 'ket noi otg', 'bat otg', 'mo otg',
  'go loi usb', 'usb debugging', 'tuy chon nha phat trien', 'nha phat trien', 'dinh tuyen am thanh usb',
  'ios 18', 'ios 17', 'ios 16', 'mic ngoai', 'mic gan ngoai', 'dau vao am thanh', 'trung tam dieu khien',
  'usb-a', 'dau chuyen', 'cap chuyen', 'chuyen usb', 'hub', 'dock sac', 'hop sac', 'chot don', 'mua ngay',
  // Ứng dụng & Nền tảng
  'tiktok', 'capcut', 'capcut pc', 'facebook', 'facebook live', 'youtube', 'zoom', 'teams', 'google meet', 'obs', 'obs studio',
  'open camera', 'livestream', 'quay video', 'thu am', 'podcast', 'day hoc', 'hop online',
  // Tính năng âm thanh & Kỹ thuật
  'loc on', 'loc am', 'chong on', 'anc', 'khu on', 'dsp', 'am thanh', 'do tre', '2.4ghz', 'cu ly', 'khoang cach', 'pin', 'thoi luong pin',
  'khong nhan mic', 'den khong sang', 'mat tieng', 're am', 'tieng nho', 'thu 360', 'condenser',
  // Sản phẩm GAERU
  'p01', 'k9', 'm3', 'p185', 'g1', 'g1 ultra', 'gaeru p01', 'gaeru k9', 'gaeru m3', 'gaeru p185', 'micro', 'gay livestream', 'tripod'
];

/**
 * Trích xuất các trigger nhận diện từ câu hỏi / đoạn chat
 */
function extractTriggers(text) {
  const norm = normalizeText(text);
  const found = new Set();

  for (const term of TECH_VOCABULARY) {
    if (hasBoundaryTerm(norm, term)) {
      found.add(term.toLowerCase());
    }
  }

  // Tách thêm từ ghép 2-3 âm tiết nếu có chứa từ khóa nghiệp vụ
  const words = norm.split(/[\s,.;:!?()-]+/).filter(w => w.length >= 2);
  for (let i = 0; i < words.length - 1; i++) {
    const bi = `${words[i]} ${words[i + 1]}`;
    if (['ket noi', 'tuong thich', 'khong nhan', 'chua nhan', 'huong dan', 'cai dat', 'quay video', 'thu am'].includes(bi)) {
      found.add(bi);
    }
  }

  return Array.from(found);
}

/**
 * Tạo chủ đề tóm tắt cho bài học mới
 */
function synthesizeTopic(triggers, sampleQuestion) {
  const cleanQ = sanitizePii(sampleQuestion);
  if (triggers.length > 0) {
    const topTerms = triggers.slice(0, 3).map(t => t.toUpperCase()).join(' · ');
    return `Hỏi đáp & Hướng dẫn: [${topTerms}]`;
  }
  return cleanQ.slice(0, 80) || 'Hỏi đáp kỹ thuật GAERU';
}

/**
 * Đọc toàn bộ tri thức tự học đang hoạt động (kèm caching)
 */
async function getActiveLearnedKnowledge(pool) {
  if (!pool || typeof pool.query !== 'function') return [];

  const now = Date.now();
  if (learnedKnowledgeCache && cacheExpiresAt > now) {
    return learnedKnowledgeCache;
  }

  try {
    const res = await pool.query(`
      SELECT id, topic, triggers, learned_facts, sample_question, sample_answer, confidence_score, occurrence_count, updated_at
      FROM ai_learned_knowledge
      WHERE status = 'active'
      ORDER BY confidence_score DESC, occurrence_count DESC
    `);
    learnedKnowledgeCache = res.rows || [];
    cacheExpiresAt = now + CACHE_TTL_MS;
    return learnedKnowledgeCache;
  } catch (err) {
    return [];
  }
}

/**
 * Tìm tri thức tự học phù hợp nhất với câu hỏi của người dùng
 */

const LEARNED_PRODUCT_CODES = ['k9', 'm3', 'p01', 'p185', 'g1', 'g1 ultra'];
const LEARNED_INTENT_GUARDS = [
  ['gia', 'gia ban', 'bao nhieu tien', 'may tien', 'bang gia'],
  ['ton kho', 'con hang', 'het hang', 'san hang'],
  ['pin', 'dung luong pin', 'sac pin', 'may tieng', 'thoi luong'],
  ['van chuyen', 'giao hang', 'freeship', 'mien phi ship', 'phi ship'],
  ['bao hanh', 'doi moi', 'sua chua', 'kich hoat bao hanh']
];

function hasLearnedIntentConflict(normQ, entry) {
  const entryFull = normalizeText(
    `${entry.topic || ''} ${Array.isArray(entry.triggers) ? entry.triggers.join(' ') : ''} ${entry.sample_question || ''} ${entry.learned_facts || ''}`
  );
  const qProds = LEARNED_PRODUCT_CODES.filter(p => hasBoundaryTerm(normQ, p));
  const eProds = LEARNED_PRODUCT_CODES.filter(p => hasBoundaryTerm(entryFull, p));
  if (qProds.length > 0 && eProds.length > 0 && !qProds.some(p => eProds.includes(p))) {
    return true;
  }
  for (const terms of LEARNED_INTENT_GUARDS) {
    if (hasAnyBoundaryTerm(normQ, terms) && !hasAnyBoundaryTerm(entryFull, terms)) {
      return true;
    }
  }
  return false;
}

async function matchLearnedKnowledgeSemantic(pool, normQ, question, entries, minScore, gpuTransport) {
  const candidates = [];
  for (const entry of entries) {
    if (isLowValueLearnedAnswer(entry.learned_facts || entry.sample_answer)) continue;
    if (hasLearnedIntentConflict(normQ, entry)) continue;
    candidates.push(entry);
    if (candidates.length >= 24) break;
  }
  if (!candidates.length) return null;

  const isCustomTransport = typeof gpuTransport === 'function' && gpuTransport !== fetch;
  let qVec = null;
  const itemsWithVec = [];

  if (isCustomTransport) {
    // Preserve single-batch behavior for deterministic mock transports in unit tests
    const docs = candidates.map(e =>
      `${e.topic || ''}. ${e.sample_question || ''}. ${e.learned_facts || e.sample_answer || ''}`.trim().slice(0, 320)
    );
    const vecs = await embedTexts([question, ...docs], { transport: gpuTransport });
    if (!vecs || !vecs[0]) return null;
    qVec = vecs[0];
    for (let i = 0; i < candidates.length; i++) {
      if (vecs[i + 1]) itemsWithVec.push({ key: String(candidates[i].id || i), vec: vecs[i + 1], item: candidates[i] });
    }
  } else {
    // Production fast-path: pre-indexed document vectors from RAM/PostgreSQL + 1 single query embed (~60-110ms)
    const docItems = candidates.map((e, idx) => ({
      key: String(e.id || `entry_${idx}`),
      text: `${e.topic || ''}. ${e.sample_question || ''}. ${e.learned_facts || e.sample_answer || ''}`.trim().slice(0, 320)
    }));
    const [qRes, docMap] = await Promise.all([
      embedText(question),
      ensureEmbeddings(pool, 'learned', docItems)
    ]);
    if (!qRes) return null;
    qVec = qRes;
    for (let i = 0; i < candidates.length; i++) {
      const k = docItems[i].key;
      const vec = docMap.get(k);
      if (vec) itemsWithVec.push({ key: k, vec, item: candidates[i] });
    }
  }

  if (!qVec || !itemsWithVec.length) return null;

  // Calibrated for multilingual-MiniLM-L12-v2 clean UTF-8 Vietnamese:
  // Irrelevant pairs sit around -0.08..+0.20; true paraphrases score 0.34..0.60+ with clear margin (>= 0.08).
  const ranked = rankByCosine(qVec, itemsWithVec, { topK: 3, minCos: 0.36 });
  if (!ranked.best) return null;

  const { best, margin } = ranked;
  const hasClearSeparation = itemsWithVec.length === 1 || margin >= 0.08 || best.cos >= 0.62;
  if (!hasClearSeparation) return null;
  if (best.cos < 0.60 && margin < 0.08) return null;

  const threshold = Math.max(minScore, 0.66);
  const conf = Math.min(1, Math.max(0.1, parseFloat(best.item.confidence_score) || 0.8));
  const effectiveCos = best.cos >= 0.60
    ? best.cos
    : Math.min(0.95, best.cos + Math.min(0.24, margin * 0.65));
  const score = Math.min(1, Number((effectiveCos * 0.88 + conf * 0.12).toFixed(4)));
  if (score >= threshold) {
    return { entry: best.item, score, cosine: Number(best.cos.toFixed(4)), margin: Number(margin.toFixed(4)), semantic: true };
  }
  return null;
}

async function matchLearnedKnowledge(pool, question, { minScore = 0.55, gpuTransport } = {}) {
  const normQ = normalizeText(question);
  if (!normQ || normQ.length < 3) return null;

  const entries = await getActiveLearnedKnowledge(pool);
  if (!entries || !entries.length) return null;

  const qTokens = tokenizeMeaningful(question);
  let bestEntry = null;
  let bestScore = 0;

  for (const entry of entries) {
    if (isLowValueLearnedAnswer(entry.learned_facts || entry.sample_answer)) continue;
    const triggers = Array.isArray(entry.triggers) ? entry.triggers : [];
    if (!triggers.length) continue;

    const matchedTrigs = [];
    for (const trig of triggers) {
      if (hasBoundaryTerm(normQ, trig)) {
        matchedTrigs.push(normalizeText(trig));
      }
    }

    const matchedCount = matchedTrigs.length;
    if (matchedCount === 0) continue;

    const refText = `${entry.sample_question || ''} ${entry.topic || ''}`.trim();
    const refTokens = tokenizeMeaningful(refText);
    const questionSim = refTokens.length ? tokenOverlapScore(qTokens, refTokens) : 0;

    // Tránh bắt nhầm câu hỏi chung chung chỉ vì trùng 1 từ khóa sản phẩm/thiết bị phổ thông
    const hasSpecificTrig = matchedTrigs.some(t => !GENERIC_SINGLE_TRIGGERS.has(t));
    if (matchedCount === 1 && !hasSpecificTrig && questionSim < 0.35) {
      continue;
    }
    if (triggers.length > 8 && questionSim < 0.25) {
      continue;
    }

    const expectedDenom = Math.min(triggers.length, Math.max(4, Math.ceil(triggers.length * 0.6)));
    const coverageNorm = Math.min(1, matchedCount / expectedDenom);
    const matchStrength = 1 - Math.exp(-0.55 * matchedCount);
    const conf = Math.min(1, Math.max(0.1, parseFloat(entry.confidence_score) || 0.8));
    const rawScore = (coverageNorm * 0.35) + (matchStrength * 0.25) + (questionSim * 0.25) + (conf * 0.15);
    const score = Math.min(1, Number(rawScore.toFixed(4)));

    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  if (bestEntry && bestScore >= minScore) {
    return {
      entry: bestEntry,
      score: bestScore
    };
  }

  try {
    const semMatch = await matchLearnedKnowledgeSemantic(pool, normQ, question, entries, minScore, gpuTransport);
    if (semMatch) return semMatch;
  } catch (_) {}

  return null;
}

/**
 * Lưu trữ hoặc củng cố tri thức tự học vào cơ sở dữ liệu
 */
async function learnFromInteraction(pool, {
  sourceType = 'customer_chat',
  question,
  answer,
  confidence = 0.70,
  status: requestedStatus = null,
  metadata = {}
}) {
  if (!pool || typeof pool.query !== 'function') return null;

  const cleanQ = sanitizePii(question);
  const cleanA = sanitizePii(answer);

  // Bỏ qua tin nhắn quá ngắn, chào hỏi / menu mặc định hoặc câu báo lỗi fallback
  if (!cleanQ || cleanQ.length < 5 || isLowValueLearnedAnswer(cleanA)) return null;

  // Lọc bỏ câu chào hỏi xã giao hoặc xác nhận ngắn
  const normQ = normalizeText(cleanQ);
  if (/^(alo|chao|hi|hello|ok|da|vang|cam on|roi|duoc|nhe)$/i.test(normQ)) return null;

  // Bảo vệ Zero-Trust F10: Tuyệt đối không tự học từ các câu hỏi liên quan tới đơn hàng, mã vận đơn, thông tin cá nhân
  const normBoth = normQ + ' ' + normalizeText(cleanA);
  // Placeholder do sanitizePii() sinh ra có dấu (VD: [SĐT_ĐÃ_ẨN]) nên phải so khớp trên văn bản đã bỏ dấu
  if (/\[(?:sdt_da_an|email_da_an|ma_don_hang|so_tai_khoan_da_an|ma_van_don|khach_hang_da_an|dia_chi_da_an)\]/i.test(normalizeText(cleanQ + ' ' + cleanA)) ||
      /(?:don hang|tra cuu don|van don|dia chi giao|phi ship cua don|hoan tien|huy don|chuyen khoan)/i.test(normBoth) ||
      /\b(?:gr|gae)-[a-z0-9-]+/i.test(normBoth)) {
    return null;
  }

  const triggers = extractTriggers(cleanQ + ' ' + cleanA);
  // Cần ít nhất 1 từ khóa định danh cụ thể để tránh học tạp âm
  if (triggers.length === 0) return null;

  const topic = synthesizeTopic(triggers, cleanQ);

  const harvestedKey = metadata && typeof metadata === 'object'
    ? (metadata.harvestedKey || (metadata.harvestedAt && metadata.threadId ? `${metadata.threadId}:${cleanQ}:${cleanA}` : null))
    : null;

  try {
    // 1. Kiểm tra xem đã có tri thức tương tự chưa (siết tỷ lệ trùng trigger để tránh gộp nhầm chủ đề khác)
    const existingRes = await pool.query(`
      SELECT id, source_type, topic, triggers, learned_facts, sample_question, sample_answer, confidence_score, occurrence_count, status, metadata
      FROM ai_learned_knowledge
      WHERE triggers && $1::text[]
      ORDER BY occurrence_count DESC
      LIMIT 10
    `, [triggers]);

    let matchedExisting = null;
    for (const row of existingRes.rows) {
      const rowTrigs = new Set((row.triggers || []).map(normalizeText));
      const common = triggers.filter(t => rowTrigs.has(normalizeText(t)));
      const minRequiredCommon = triggers.length >= 3
        ? Math.max(2, Math.ceil(Math.min(triggers.length, rowTrigs.size) * 0.5))
        : Math.min(2, triggers.length);
      if (common.length >= minRequiredCommon) {
        matchedExisting = row;
        break;
      }
    }

    // Tier 3.3: Semantic deduplication across existing learned Q&As when phrasing differs
    if (!matchedExisting && isGpuAiEnabled()) {
      try {
        const recentRes = await pool.query(`
          SELECT id, source_type, topic, triggers, learned_facts, sample_question, sample_answer, confidence_score, occurrence_count, status, metadata
          FROM ai_learned_knowledge
          WHERE status IN ('active', 'pending_review')
          ORDER BY updated_at DESC
          LIMIT 25
        `);
        const poolRows = (recentRes?.rows || []).filter(r => !hasLearnedIntentConflict(normQ, r));
        if (poolRows.length) {
          const items = poolRows.map(r => ({
            key: String(r.id),
            text: `${r.topic || ''}. ${r.sample_question || ''}. ${r.learned_facts || r.sample_answer || ''}`.trim().slice(0, 320)
          }));
          const [qVec, vecMap] = await Promise.all([
            embedText(`${topic}. ${cleanQ}. ${cleanA}`.trim().slice(0, 320), { priority: 'background' }),
            ensureEmbeddings(pool, 'learned_dedup', items, { priority: 'background' })
          ]);
          if (qVec && vecMap.size) {
            let bestRow = null;
            let bestCos = 0;
            for (const r of poolRows) {
              const v = vecMap.get(String(r.id));
              if (!v) continue;
              const c = cosineSimilarity(qVec, v);
              if (c > bestCos) { bestCos = c; bestRow = r; }
            }
            if (bestRow && bestCos >= 0.78) {
              matchedExisting = bestRow;
            }
          }
        }
      } catch (_) {}
    }

    if (matchedExisting) {
      let existingMeta = {};
      if (matchedExisting.metadata && typeof matchedExisting.metadata === 'object' && !Array.isArray(matchedExisting.metadata)) {
        existingMeta = matchedExisting.metadata;
      } else if (typeof matchedExisting.metadata === 'string') {
        try {
          const parsedMeta = JSON.parse(matchedExisting.metadata);
          if (parsedMeta && typeof parsedMeta === 'object' && !Array.isArray(parsedMeta)) existingMeta = parsedMeta;
        } catch (_) {}
      }
      const existingKeys = Array.isArray(existingMeta.harvestedKeys) ? existingMeta.harvestedKeys : [];
      const existingConf = parseFloat(matchedExisting.confidence_score) || 0.70;
      const isDuplicateHarvest = Boolean(
        (harvestedKey && existingKeys.includes(harvestedKey)) ||
        (metadata?.harvestedAt && metadata?.threadId && existingMeta.threadId === metadata.threadId &&
          matchedExisting.sample_question === cleanQ && matchedExisting.sample_answer === cleanA)
      );
      if (isDuplicateHarvest) {
        return {
          action: 'duplicate',
          id: matchedExisting.id,
          topic: matchedExisting.topic,
          count: matchedExisting.occurrence_count || 1,
          confidence: existingConf
        };
      }

      // Củng cố tri thức đã có: Không để hội thoại khách hàng hay quét lặp lại tự ý ghi đè mẫu chuẩn hoặc bơm điểm quá ngưỡng
      const isBatchHarvest = requestedStatus === 'pending_review' || Boolean(metadata?.harvestedAt);
      const isTrustedSource = !isBatchHarvest && (sourceType === 'staff_guidance' || sourceType === 'manual');
      const newCount = (matchedExisting.occurrence_count || 1) + 1;
      const bump = isTrustedSource ? 0.03 : 0.01;
      const cap = isTrustedSource ? 1.00 : (isBatchHarvest ? Math.max(existingConf, 0.85) : Math.max(existingConf, 0.84));
      const newScore = Math.min(cap, Math.min(1.00, existingConf + bump));
      const canUpdateSample = isTrustedSource || ((matchedExisting.source_type === sourceType || !matchedExisting.source_type) && confidence >= existingConf);
      const nextSampleQ = canUpdateSample ? cleanQ : (matchedExisting.sample_question || cleanQ);
      const nextSampleA = canUpdateSample ? cleanA : (matchedExisting.sample_answer || cleanA);

      // Hợp nhất thêm triggers mới nhưng giới hạn kích thước để tránh phình thành catch-all
      const mergedTriggers = Array.from(new Set([...(matchedExisting.triggers || []), ...triggers])).slice(0, 16);
      const nextKeys = harvestedKey
        ? Array.from(new Set([...existingKeys, harvestedKey])).slice(-200)
        : existingKeys;
      const nextMeta = {
        ...existingMeta,
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
        ...(nextKeys.length ? { harvestedKeys: nextKeys } : {})
      };

      await pool.query(`
        UPDATE ai_learned_knowledge
        SET occurrence_count = $1,
            confidence_score = $2,
            triggers = $3,
            sample_question = $4,
            sample_answer = $5,
            metadata = $7::jsonb,
            updated_at = NOW()
        WHERE id = $6
      `, [newCount, newScore, mergedTriggers, nextSampleQ, nextSampleA, matchedExisting.id, JSON.stringify(nextMeta)]);

      invalidateCache();
      return {
        action: 'reinforced',
        id: matchedExisting.id,
        topic: matchedExisting.topic,
        count: newCount,
        confidence: newScore
      };
    } else {
      // Thêm tri thức tự học hoàn toàn mới (hội thoại khách hàng / AI tự động cần duyệt qua pending_review)
      const newId = randomUUID();
      const explicitStatus = ['active', 'pending_review', 'archived'].includes(requestedStatus) ? requestedStatus : null;
      const autoActiveThreshold = (sourceType === 'customer_chat' || sourceType === 'internal_copilot') ? 0.88 : 0.80;
      const status = explicitStatus || (confidence >= autoActiveThreshold ? 'active' : 'pending_review');
      const initialMeta = {
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
        ...(harvestedKey ? { harvestedKeys: [harvestedKey] } : {})
      };

      await pool.query(`
        INSERT INTO ai_learned_knowledge (
          id, source_type, topic, triggers, learned_facts, sample_question, sample_answer,
          confidence_score, occurrence_count, status, auto_learned, metadata, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, 1, $9, true, $10, NOW(), NOW()
        )
      `, [
        newId,
        sourceType,
        topic,
        triggers,
        cleanA,
        cleanQ,
        cleanA,
        confidence,
        status,
        JSON.stringify(initialMeta)
      ]);

      invalidateCache();
      return {
        action: 'created',
        id: newId,
        topic,
        status,
        confidence
      };
    }
  } catch (err) {
    console.error('[AI Self-Learning Error]', err.message);
    return null;
  }
}

/**
 * Tự động học từ phản hồi của Nhân viên tư vấn (Nhân viên giải đáp vấn đề mà AI chưa rõ)
 */
async function learnFromStaffResponse(pool, { threadId, customerQuestion, staffAnswer, adminUser = null }) {
  if (!pool || !customerQuestion || !staffAnswer) return null;

  return learnFromInteraction(pool, {
    sourceType: 'staff_guidance',
    question: customerQuestion,
    answer: staffAnswer,
    confidence: 0.95, // Phản hồi từ nhân viên có độ tin cậy vượt trội, chờ quản trị viên duyệt trước khi phục vụ đại trà
    status: 'pending_review',
    metadata: {
      threadId,
      learnedFrom: 'staff_resolution',
      staff: adminUser?.username || 'staff'
    }
  });
}

/**
 * Quét toàn bộ lịch sử hội thoại gần đây để đúc kết tri thức tự học bổ sung
 */
async function scanAndHarvestPastChats(pool, { limit = 100 } = {}) {
  if (!pool || typeof pool.query !== 'function') return { processed: 0, learned: 0 };

  try {
    // Tìm các luồng chat có sự tham gia của khách hàng và phản hồi của nhân viên hoặc câu trả lời hữu ích
    const messagesRes = await pool.query(`
      WITH recent_msgs AS (
        SELECT m.id, m.thread_id, m.sender, m.body, m.created_at
        FROM shopping_chat_messages m
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $1
      )
      SELECT id, thread_id, sender, body, created_at
      FROM recent_msgs
      ORDER BY thread_id ASC, created_at ASC, id ASC
    `, [Math.max(10, Math.min(500, limit))]);

    const threads = new Map();
    for (const msg of messagesRes.rows) {
      if (!threads.has(msg.thread_id)) threads.set(msg.thread_id, []);
      threads.get(msg.thread_id).push(msg);
    }

    let processedCount = 0;
    let learnedCount = 0;

    for (const [threadId, msgs] of threads.entries()) {
      for (let i = 0; i < msgs.length - 1; i++) {
        const curr = msgs[i];
        const next = msgs[i + 1];

        // Khách hỏi và Nhân viên/AI trả lời bài bản (luôn qua hàng đợi pending_review trước khi kích hoạt)
        if (curr.sender === 'customer' && (next.sender === 'admin' || next.sender === 'staff' || next.sender === 'ai')) {
          processedCount++;
          const harvestedKey = `${threadId}:${curr.id || i}:${next.id || (i + 1)}`;
          const result = await learnFromInteraction(pool, {
            sourceType: next.sender === 'ai' ? 'customer_chat' : 'staff_guidance',
            question: curr.body,
            answer: next.body,
            confidence: next.sender === 'ai' ? 0.65 : 0.85,
            status: 'pending_review',
            metadata: { threadId, questionMessageId: curr.id, answerMessageId: next.id, harvestedKey, harvestedAt: new Date().toISOString() }
          });

          if (result && result.action !== 'duplicate') learnedCount++;
        }
      }
    }

    return { processed: processedCount, learned: learnedCount };
  } catch (err) {
    return { processed: 0, learned: 0, error: err.message };
  }
}

/**
 * Thống kê tổng quan năng lực tự học của GAERU AI
 */
async function getLearnedKnowledgeStats(pool) {
  if (!pool || typeof pool.query !== 'function') return null;

  try {
    const counts = (await pool.query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(CASE WHEN status = 'active' THEN 1 END)::int AS active_count,
        COUNT(CASE WHEN status = 'pending_review' THEN 1 END)::int AS pending_count,
        COALESCE(SUM(occurrence_count), 0)::int AS total_interactions,
        COALESCE(ROUND(AVG(confidence_score), 2), 0) AS avg_confidence
      FROM ai_learned_knowledge
    `)).rows[0];

    const topEntries = (await pool.query(`
      SELECT id, topic, triggers, confidence_score, occurrence_count, status, updated_at
      FROM ai_learned_knowledge
      ORDER BY occurrence_count DESC, confidence_score DESC
      LIMIT 10
    `)).rows;

    return {
      counts,
      topEntries
    };
  } catch (err) {
    return {
      counts: { total: 0, active_count: 0, pending_count: 0, total_interactions: 0, avg_confidence: 0 },
      topEntries: []
    };
  }
}

module.exports = {
  sanitizePii,
  extractTriggers,
  synthesizeTopic,
  getActiveLearnedKnowledge,
  matchLearnedKnowledge,
  learnFromInteraction,
  learnFromStaffResponse,
  scanAndHarvestPastChats,
  getLearnedKnowledgeStats,
  invalidateCache
};
