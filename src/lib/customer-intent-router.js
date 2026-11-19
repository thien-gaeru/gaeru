'use strict';

/**
 * Hybrid Lexical + Semantic Customer Intent Router powered by `gaeru-gpu-ai v2`
 * (paraphrase-multilingual-MiniLM-L12-118M-v2).
 *
 * Pre-indexes 22 curated Vietnamese e-commerce & support intent prototypes into
 * PostgreSQL `ai_embedding_vectors` under namespace `customer_intents` and hydrates
 * them into RAM on every cluster worker (< 2ms, ~35 KB RAM).
 *
 * - Fast-path (`classifyCustomerIntentFast`): < 0.2ms deterministic classification for
 *   short colloquial turns ("mua", "nút mua đâu", "trả lời", "giúp gì", "công dụng", "chức năng").
 * - Semantic rescue (`classifyCustomerIntentSemantic`): ~45ms vector cosine matching on
 *   paraphrased/unconventional Vietnamese queries when deterministic rules did not hit.
 */

const { embedText, isGpuAiEnabled } = require('./gpu-ai-client');
const { ensureEmbeddings, rankByCosine } = require('./embedding-store');
const {
  normalizeSearchSpace,
  expandQueryVi,
  hasAnyBoundaryTerm,
  tokenizeMeaningful
} = require('./ai-nlu');

const CUSTOMER_INTENT_PROTOTYPES = Object.freeze([
  {
    key: 'buy_cta',
    text: 'Tôi muốn đặt mua sản phẩm ngay bây giờ chốt đơn thanh toán nút mua hàng ở đâu gửi cho mình link đặt mua'
  },
  {
    key: 'product_features',
    text: 'Công dụng chức năng tính năng tác dụng điểm nổi bật ưu điểm có gì hay sản phẩm này dùng để làm gì có tốt có bền không'
  },
  {
    key: 'product_price_stock',
    text: 'Giá bán bao nhiêu tiền mấy tiền có đắt không hiện tại còn hàng sẵn kho hay tạm hết hàng rồi'
  },
  {
    key: 'product_guide_setup',
    text: 'Hướng dẫn cách sử dụng cách bật cách kết nối thiết lập lần đầu thao tác nút bấm đèn báo nhấp nháy'
  },
  {
    key: 'product_battery',
    text: 'Pin dùng được bao nhiêu tiếng thời lượng pin lâu không hộp sạc sạc đầy mất bao lâu dung lượng pin mAh'
  },
  {
    key: 'product_noise_audio',
    text: 'Chất lượng thu âm lọc ồn giảm tạp âm chống ồn tiếng gió ngoài trời âm thanh thu có trong rõ không'
  },
  {
    key: 'product_range',
    text: 'Khoảng cách thu âm bắt sóng xa bao nhiêu mét đứng xa điện thoại bao nhiêu mét vẫn thu tiếng tốt'
  },
  {
    key: 'product_accessories',
    text: 'Trong hộp bộ sản phẩm gồm những phụ kiện gì đi kèm có tặng bông lọc gió cáp sạc hộp đựng không'
  },
  {
    key: 'product_waterproof',
    text: 'Sản phẩm có chống nước kháng nước đi dưới trời mưa rơi xuống nước mồ hôi ẩm ướt có hỏng không'
  },
  {
    key: 'device_compatibility',
    text: 'Điện thoại iPhone Samsung OPPO Xiaomi vivo Realme iPad MacBook Laptop PC máy ảnh có cắm tương thích dùng được không'
  },
  {
    key: 'android_otg_camera',
    text: 'Bật kết nối OTG gỡ lỗi USB nhà phát triển trên Android OPPO Samsung cam thường máy ảnh mặc định không nhận mic ngoài tải app nào'
  },
  {
    key: 'audio_troubleshoot',
    text: 'Micro cắm vào không nhận không lên đèn mất tiếng bị rè bị vang tiếng echo chỉ lên 1 mic không nghe loa ngoài khi xem lại video'
  },
  {
    key: 'compare_products',
    text: 'So sánh các mẫu micro khác nhau điểm nào giữa K9 M3 G1 ULTRA P01 P185 nên chọn mẫu nào phù hợp hơn'
  },
  {
    key: 'capability_help',
    text: 'Bạn giúp được gì trợ lý AI hỗ trợ những gì bạn làm được những việc gì tư vấn giúp mình cách dùng khung chat'
  },
  {
    key: 'meta_nudge',
    text: 'Trả lời giúp mình đi sao không trả lời đúng câu hỏi nói rõ hơn giải thích lại cụ thể hơn đi bạn'
  },
  {
    key: 'shipping_cod',
    text: 'Phí giao hàng vận chuyển freeship mấy ngày nhận được kiểm tra đồng kiểm mở hộp xem hàng trước khi trả tiền COD'
  },
  {
    key: 'return_warranty',
    text: 'Chính sách bảo hành bao nhiêu tháng 1 đổi 1 đổi trả hoàn tiền mua nhầm chân cắm bị lỗi kỹ thuật xử lý như thế nào'
  },
  {
    key: 'vat_invoice',
    text: 'Bên shop có xuất hóa đơn đỏ VAT điện tử chứng từ thuế giá trị gia tăng cho công ty doanh nghiệp kê khai không'
  },
  {
    key: 'voucher_combo_xu',
    text: 'Mã giảm giá voucher khuyến mãi gói combo mua kèm tích điểm GAERU Xu mua số lượng nhiều mua sỉ chiết khấu'
  },
  {
    key: 'contact_store',
    text: 'Số điện thoại hotline email giờ làm việc địa chỉ trụ sở cửa hàng GAERU ở đâu có đến mua trực tiếp tại shop không'
  },
  {
    key: 'order_lookup',
    text: 'Kiểm tra tra cứu trạng thái đơn hàng của tôi giao tới đâu rồi mã vận đơn bưu cục shipper gọi giao chưa'
  },
  {
    key: 'human_handoff',
    text: 'Cho tôi gặp nhân viên tư vấn người thật hỗ trợ trực tiếp không muốn nhắn tin với trợ lý tự động'
  }
]);

/**
 * Ultra-fast (< 0.2ms) deterministic classifier for short natural Vietnamese turns
 * that commonly slip past keyword rules (capability help, meta-nudges, standalone buy/feature follow-ups).
 */
function classifyCustomerIntentFast(rawQuestion, spaceInput = '', state = null) {
  const raw = String(rawQuestion || '').trim();
  const space = spaceInput || normalizeSearchSpace(expandQueryVi(raw));
  if (!raw && !space) return null;

  const hasExplicitProductInQuestion = state?.mentioned?.source === 'question';
  const hasActiveProd = Boolean(state?.activeProduct);

  // 1. Punctuation-only or pure meta-nudge ("?", "??", "trả lời", "trả lời đi", "sao không trả lời", "nói rõ hơn")
  if (/^[?!.…\s]+$/.test(raw)) {
    return { intent: 'meta_nudge', confidence: 0.99, source: 'fast' };
  }
  if (
    /^(?:tra loi|tra loi di|tra loi minh|tra loi toi|tra loi em|tra loi giup|tra loi nhanh|sao khong tra loi|khong tra loi a|khong tra loi sao|noi ro hon|noi ro di|giai thich ro hon|giai thich lai|chi tiet hon di|khong hieu|chua hieu|sao the|sao vay|the la sao|la sao|y minh khong phai vay|khong phai y nay)$/.test(space) ||
    hasAnyBoundaryTerm(space, ['sao khong tra loi', 'tra loi di', 'tra loi giup minh', 'tra loi dung cau hoi', 'y minh khong phai vay', 'noi ro hon di'])
  ) {
    return { intent: 'meta_nudge', confidence: 0.96, source: 'fast' };
  }

  // 2. Capability / assistant help ("giúp gì", "bạn giúp được gì", "bạn làm được gì", "hỗ trợ gì")
  // Do NOT hijack product-specific questions like "m3 làm được gì" when a product is explicitly named in the question!
  if (!hasExplicitProductInQuestion) {
    if (
      /^(?:giup gi|giup duoc gi|giup dc gi|ban giup gi|ban giup duoc gi|shop giup gi|shop giup duoc gi|ho tro gi|ho tro duoc gi|ban ho tro gi|ban ho tro duoc gi|ban lam duoc gi|ai lam duoc gi|co the giup gi|co the ho tro gi|tu van giup|tu van giup minh|ban la ai|gaeru ai la gi|help)$/.test(space) ||
      hasAnyBoundaryTerm(space, [
        'ban giup duoc gi', 'ban giup gi', 'ban lam duoc gi', 'ban ho tro duoc gi', 'ban ho tro gi',
        'shop ho tro gi', 'co the giup gi', 'co the giup duoc gi', 'tro ly lam duoc gi', 'ai nay lam gi'
      ]) ||
      (!hasActiveProd && /^(?:lam duoc gi|lam gi)$/.test(space))
    ) {
      return { intent: 'capability_help', confidence: 0.96, source: 'fast' };
    }
  }

  // 3. Product feature / benefit follow-up ("công dụng", "chức năng", "tính năng", "tác dụng", "ưu điểm", "có gì hay", "có bền không")
  if (
    hasAnyBoundaryTerm(space, [
      'cong dung', 'chuc nang', 'tinh nang', 'tac dung', 'uu diem', 'diem noi bat', 'noi bat',
      'loi ich', 'co gi hay', 'co gi dac biet', 'co gi noi bat', 'xai ngon khong', 'dung tot khong',
      'co tot khong', 'co ben khong', 'chat luong sao', 'chat luong the nao'
    ]) ||
    ((hasExplicitProductInQuestion || hasActiveProd) && hasAnyBoundaryTerm(space, ['lam duoc gi', 'dung de lam gi', 'de lam gi']))
  ) {
    return { intent: 'product_features', confidence: 0.95, source: 'fast' };
  }

  // 4. Buy CTA / "where is the buy button?" / standalone "mua"
  const isRainHomonym = /(?:^|[^\p{L}])m(?:ưa|ùa)(?=$|[^\p{L}])/iu.test(raw) && !/(?:^|[^\p{L}])mua(?=$|[^\p{L}])/iu.test(raw);
  const isNegatedBuy = /(?:^|[^a-z0-9])(?:chua|khong|dung|thoi|huy|bo|ngung)\s+(?:\w+\s+){0,2}(?:chot|mua|dat|lay|len don|dat hang)(?=$|[^a-z0-9])/i.test(space) ||
    hasAnyBoundaryTerm(space, ['chua can mua', 'tham khao truoc', 'suy nghi them', 'hoi truoc', 'chi hoi']);
  if (!isRainHomonym && !isNegatedBuy) {
    if (
      hasAnyBoundaryTerm(space, [
        'nut mua', 'nut mua dau', 'nut dat', 'nut dat dau', 'nut dat hang', 'bam mua dau', 'an mua dau',
        'bam vao dau de mua', 'an vao dau de mua', 'mua o dau', 'dat o dau', 'mua cho nao', 'dat cho nao',
        'link mua', 'link dat', 'gui link mua', 'cho xin link', 'cho minh link', 'cho link'
      ]) ||
      /^(?:mua|dat|chot|lay|mua di|dat di|mua luon|dat luon|mua ngay|dat ngay|mua nhe|mua nha|mua shop|mua ad|ok mua|oke mua|ok dat|oke dat|mua hang|dat hang|mua sao|dat sao|cach mua|cach dat hang)$/.test(space)
    ) {
      return { intent: 'buy_cta', confidence: 0.96, source: 'fast' };
    }
  }

  return null;
}

/**
 * Semantic Intent Classifier via `gaeru-gpu-ai v2` (paraphrase-multilingual-MiniLM-L12-118M-v2).
 * Invoked only on the smart-rescue path when deterministic handlers did not already answer.
 */
async function classifyCustomerIntentSemantic(pool, rawQuestion, { state = null, transport } = {}) {
  if (!isGpuAiEnabled() && typeof transport !== 'function') return null;
  const q = String(rawQuestion || '').trim();
  if (q.length < 6) return null;

  const space = normalizeSearchSpace(expandQueryVi(q));
  // Guard obvious off-topic chitchat / weather from being misclassified into e-commerce intents
  if (/(?:^|[^\p{L}])(?:thời tiết|trời có mưa|trời mưa|nắng mưa|bóng đá|xổ số|chứng khoán|giá vàng)(?=$|[^\p{L}])/iu.test(q)) {
    return null;
  }
  const tokens = tokenizeMeaningful(q);
  if (tokens.length < 2) return null;

  const embedItems = CUSTOMER_INTENT_PROTOTYPES.map(p => ({ key: p.key, text: p.text }));
  const embedOpts = typeof transport === 'function' ? { transport, skipDb: true } : {};

  const [qVec, vecMap] = await Promise.all([
    embedText(q, typeof transport === 'function' ? { transport } : {}),
    ensureEmbeddings(pool, 'customer_intents', embedItems, embedOpts)
  ]);

  if (!qVec || !vecMap || vecMap.size === 0) return null;

  const itemsWithVec = [];
  for (const proto of CUSTOMER_INTENT_PROTOTYPES) {
    const vec = vecMap.get(proto.key);
    if (vec) itemsWithVec.push({ key: proto.key, vec, item: proto });
  }
  if (!itemsWithVec.length) return null;

  const ranked = rankByCosine(qVec, itemsWithVec, { topK: 3, minCos: 0.54 });
  const best = ranked.best;
  if (!best) return null;

  // Calibrated strict acceptance gate to avoid false positives on unrelated chit-chat
  const accepted = best.cos >= 0.63 || (best.cos >= 0.56 && ranked.margin >= 0.055);
  if (!accepted) return null;

  // Do not semantically misroute negated human requests into handoff
  if (best.key === 'human_handoff' && /khong\s+(?:can|muon)\s+(?:gap\s+|noi chuyen voi\s+)?(?:nhan vien|nguoi that)/.test(space)) {
    return null;
  }

  return {
    intent: best.key,
    score: Number(best.cos.toFixed(4)),
    margin: Number(ranked.margin.toFixed(4)),
    source: 'semantic'
  };
}

module.exports = {
  CUSTOMER_INTENT_PROTOTYPES,
  classifyCustomerIntentFast,
  classifyCustomerIntentSemantic
};
