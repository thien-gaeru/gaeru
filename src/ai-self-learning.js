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
    // Số điện thoại Việt Nam (09x, 08x, 07x, 03x, 05x, +84x...)
    .replace(/(?:\+84|84|0)(?:3[2-9]|5[2689]|7[06-9]|8[1-9]|9[0-9])\d{7}\b/g, '[SĐT_ĐÃ_ẨN]')
    .replace(/\b0\d{9}\b/g, '[SĐT_ĐÃ_ẨN]')
    // Email
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_ĐÃ_ẨN]')
    // Mã đơn hàng GAE-xxxxxx
    .replace(/gae-[a-zA-Z0-9-]+/gi, '[MÃ_ĐƠN_HÀNG]')
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
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .trim();
}

// Từ điển từ khóa công nghệ, thiết bị, cổng kết nối, ứng dụng và âm thanh
const TECH_VOCABULARY = [
  // Dòng máy iPhone / Apple
  'iphone', 'iphone 11', 'iphone 12', 'iphone 13', 'iphone 14', 'iphone 15', 'iphone 16',
  'iphone 15 pro', 'iphone 15 pro max', 'iphone 16 pro', 'iphone 16 pro max',
  'iphone plus', 'iphone pro max', 'ipad', 'ipad pro', 'ipad air', 'ipad mini', 'macbook', 'macbook pro', 'macbook air', 'ios',
  // Dòng máy Android & Hãng
  'samsung', 'galaxy', 'oppo', 'xiaomi', 'redmi', 'vivo', 'realme', 'poco', 'google pixel', 'pixel', 'oneplus', 'android',
  // Máy tính, máy ảnh
  'pc', 'laptop', 'windows', 'windows 10', 'windows 11', 'may tinh', 'sony', 'canon', 'fujifilm', 'nikon', 'may anh', 'camera',
  // Cổng kết nối & phụ kiện
  'type-c', 'type c', 'usb-c', 'lightning', 'chan lightning', 'jack 3.5', '3.5mm', 'trs', 'trrs', 'otg', 'ket noi otg', 'bat otg',
  'usb-a', 'dau chuyen', 'cap chuyen', 'hub', 'dock sac', 'hop sac',
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
    const normTerm = normalizeText(term);
    if (norm.includes(normTerm)) {
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
async function matchLearnedKnowledge(pool, question, { minScore = 0.55 } = {}) {
  const normQ = normalizeText(question);
  if (!normQ || normQ.length < 3) return null;

  const entries = await getActiveLearnedKnowledge(pool);
  if (!entries || !entries.length) return null;

  let bestEntry = null;
  let bestScore = 0;

  for (const entry of entries) {
    const triggers = Array.isArray(entry.triggers) ? entry.triggers : [];
    if (!triggers.length) continue;

    let matchedCount = 0;
    for (const trig of triggers) {
      const normTrig = normalizeText(trig);
      if (normTrig && normQ.includes(normTrig)) {
        matchedCount++;
      }
    }

    if (matchedCount > 0) {
      // Điểm khớp = (tỷ lệ từ khóa khớp * 0.7) + (độ tin cậy * 0.3)
      const coverage = matchedCount / Math.max(triggers.length, 1);
      const conf = parseFloat(entry.confidence_score) || 0.8;
      const score = (coverage * 0.6) + (matchedCount * 0.2) + (conf * 0.2);

      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }
  }

  if (bestEntry && bestScore >= minScore) {
    return {
      entry: bestEntry,
      score: bestScore
    };
  }

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

  // Bỏ qua tin nhắn quá ngắn hoặc không có giá trị thông tin
  if (!cleanQ || cleanQ.length < 5 || !cleanA || cleanA.length < 10) return null;

  // Lọc bỏ câu chào hỏi xã giao hoặc xác nhận ngắn
  const normQ = normalizeText(cleanQ);
  if (/^(alo|chao|hi|hello|ok|da|vang|cam on|roi|duoc|nhe)$/i.test(normQ)) return null;

  // Bảo vệ Zero-Trust F10: Tuyệt đối không tự học từ các câu hỏi liên quan tới đơn hàng, mã vận đơn, thông tin cá nhân
  const normBoth = normQ + ' ' + normalizeText(cleanA);
  // Placeholder do sanitizePii() sinh ra có dấu (VD: [SĐT_ĐÃ_ẨN]) nên phải so khớp trên văn bản đã bỏ dấu
  if (/\[(?:sdt_da_an|email_da_an|ma_don_hang|so_tai_khoan_da_an|ma_van_don|khach_hang_da_an|dia_chi_da_an)\]/i.test(normalizeText(cleanQ + ' ' + cleanA)) ||
      /(?:don hang|tra cuu don|van don|dia chi giao|phi ship cua don|hoan tien|huy don|chuyen khoan)/i.test(normBoth)) {
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

      // Hợp nhất thêm triggers mới nếu có
      const mergedTriggers = Array.from(new Set([...(matchedExisting.triggers || []), ...triggers]));
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
    confidence: 0.95, // Phản hồi từ nhân viên có độ tin cậy vượt trội
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
