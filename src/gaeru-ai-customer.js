'use strict';

/**
 * GAERU AI Customer Assistant (Lõi trí tuệ nhân tạo hỗ trợ bán hàng & CSKH GAERU)
 *
 * Kết hợp dữ liệu catalog sản phẩm thời gian thực, chính sách & bài viết trên web,
 * tri thức tự học tích lũy, tra cứu đơn hàng Zero-Trust và bộ NLU tiếng Việt chuẩn hóa.
 * Trọng tâm: Hiểu đúng ý định, trả lời chính xác dữ kiện thực tế, súc tích, không lan man.
 */

const { loadLiveSiteFacts, getRelevantWebKnowledge } = require('./chat-web-knowledge');
const { shippingFee } = require('../checkout-flow');
const { DEFAULT_POLICY: DEFAULT_LOYALTY_POLICY, tierBenefits } = require('./loyalty-api');
const { matchLearnedKnowledge } = require('./ai-self-learning');
const { embedText, cosineSimilarity, isGpuAiEnabled } = require('./lib/gpu-ai-client');
const { ensureEmbeddings } = require('./lib/embedding-store');
const { matchCustomerSemanticFaq } = require('./lib/customer-semantic-faq');
const { content: PRODUCT_GUIDE_CONTENT } = require('./product-guides');
const {
  normalizeVi,
  normalizeSearchSpace,
  expandQueryVi,
  hasBoundaryTerm,
  hasAnyBoundaryTerm,
  isTermNegated,
  tokenizeMeaningful,
  tokenOverlapScore,
  extractOrderCodes,
  extractPhoneNumbers,
  isExplicitDetailedRequest,
  resolveMentionedProducts,
  matchProductVariants,
  resolveContextualFollowUp
} = require('./lib/ai-nlu');
const {
  BRAND_PROFILES,
  TABLET_PROFILES,
  WINDOWS_LAPTOP_BRANDS,
  DESKTOP_PC_TRIGGERS,
  inferDevicePortsFromText,
  buildComprehensiveCompatibilityAnswer
} = require('./lib/phone-compatibility');

function formatVnd(num) {
  return new Intl.NumberFormat('vi-VN').format(Math.round(num || 0)) + ' ₫';
}

function normalize(text) {
  return normalizeVi(text);
}

/**
 * Kiến thức chuẩn xác về từng dòng sản phẩm GAERU (đồng bộ với catalog & hướng dẫn chính hãng).
 * Khi DB có `description`/`variants`, luôn ưu tiên số liệu trực tiếp từ DB.
 */
const PRODUCT_SPECS = Object.freeze({
  'gaeru-k9': {
    name: 'GAERU K9',
    kind: 'mic',
    role: 'Micro thu âm cài áo không dây nhỏ gọn (~7g), **không cần ghép Bluetooth hay cài app điều khiển riêng của micro**. *(Lưu ý: Một số máy Android như OPPO, Realme, Redmi/Xiaomi, vivo… app Camera cài sẵn mặc định chỉ dùng mic của máy nên cần bật OTG nếu máy yêu cầu và quay bằng ứng dụng tải từ kho ứng dụng như **Open Camera** chọn Micro ngoài, **TikTok** hoặc **CapCut**).*',
    audio: 'Thu đa hướng 360°, tần số 2.4GHz độ trễ < 15ms, chip DSP lọc ồn + bông lọc gió.',
    battery: 'Pin micro dùng liên tục khoảng **2,5 giờ**, sạc qua cổng Type-C (củ sạc **5V/1A**; sạc đầy tham khảo khoảng **1–1,5 giờ**).',
    range: 'Phạm vi thu ổn định lên đến **20 mét** (môi trường mở, tầm nhìn thẳng).',
    variantsGuide: 'Có phân loại bộ **1 Micro** / **2 Micro**, chân cắm **Lightning**, **Type-C**, hoặc **Type-C kèm đầu chuyển (Lightning / Micro-USB / USB-A)**.',
    compatibility: 'Tương thích trực tiếp **iPhone 15 / 16 / 17 / 18**, **iPad / Android / MacBook Type-C** (bản **Type-C**), **iPhone 14 trở xuống & iPad Lightning** (bản **Lightning**), máy Android cũ (bản **Type-C + chuyển Micro-USB**) và **Laptop/PC Windows** (bản **Type-C + chuyển USB-A**). *Lưu ý:* Một số máy Android (**OPPO, Realme, Redmi/Xiaomi, vivo…**) cần bật OTG (nếu máy yêu cầu) và quay bằng app tải từ kho ứng dụng (**Open Camera** chọn *Micro ngoài*, **TikTok**, **CapCut**) vì app Camera cài sẵn chỉ thu mic của điện thoại.',
    fit: 'quay TikTok/Vlog cơ bản, livestream bán hàng, dạy học online, phỏng vấn 2 người tiết kiệm chi phí',
    defaultPrice: 'Từ 289.000 ₫'
  },
  'gaeru-m3': {
    name: 'GAERU M3',
    kind: 'mic',
    role: 'Bộ micro thu âm cài áo không dây (2 mic + 1 đầu thu Type-C + hộp sạc hiển thị % pin), **không cần ghép Bluetooth**. *(Lưu ý: Trên một số máy Android như OPPO, Realme, Redmi/Xiaomi, vivo…, app Camera cài sẵn chỉ dùng mic điện thoại nên cần bật OTG nếu máy yêu cầu và quay qua app tải từ kho ứng dụng như **Open Camera** / **TikTok** / **CapCut**).*',
    audio: 'Thu đa hướng 360°, chất lượng **24-bit / 48kHz**, SNR 100 dB, Max SPL 120 dB, giảm ồn AI thông minh + tự động cân bằng âm lượng.',
    battery: 'Một bộ phát dùng tới **3,5 giờ** liên tục; tổng thời lượng tới **24 giờ** khi luân phiên 2 mic cùng hộp sạc **500 mAh** (sạc hộp bằng nguồn chuẩn **5V/1A – 5V/2A**, đầy tham khảo khoảng **1,5–2 giờ** tùy củ sạc; tránh sạc siêu nhanh công suất quá cao).',
    range: 'Khoảng cách truyền lên đến **20 mét** trong môi trường mở không vật cản.',
    variantsGuide: 'Bộ **2 Micro + hộp sạc**, đầu thu **Type-C** kèm tùy chọn **đầu chuyển Lightning**, **chuyển Micro-USB** hoặc **chuyển USB-A**.',
    compatibility: 'Tương thích trực tiếp thiết bị cổng **Type-C** (**iPhone 15–18, Android mới, iPad / Tablet Type-C, MacBook / Laptop USB-C**); có sẵn phân loại kèm **đầu chuyển Lightning** (iPhone 14 trở xuống), **Micro-USB** (máy cũ) và **chuyển USB (USB-A)** cho **PC / Laptop Windows**. *Lưu ý Android:* Một số máy (**OPPO, Realme, Redmi/Xiaomi, vivo…**) app Camera gốc chỉ dùng mic máy nên hãy bật OTG và quay bằng app tải từ kho ứng dụng (**Open Camera** chọn *Micro ngoài*, **TikTok**, **CapCut**).',
    fit: 'vlog, livestream nhiều giờ, phỏng vấn 2 người cần pin lâu và kiểm soát % pin',
    defaultPrice: '1.200.000 ₫'
  },
  'gaeru-g1-ultra': {
    name: 'GAERU G1 ULTRA',
    kind: 'mic',
    role: 'Bộ micro thu âm không dây đa thiết bị chuyên nghiệp (2 mic cài áo + đầu thu + hộp sạc).',
    audio: 'Thu âm 2 người song song, hỗ trợ giảm ồn, tai nghe **kiểm âm trực tiếp** trên đầu thu và đưa nhạc nền qua Bluetooth.',
    battery: 'Kèm hộp sạc tiện lợi, sạc qua cổng **Type-C**.',
    range: 'Kết nối không dây 2.4GHz ổn định; hỗ trợ nhiều thiết bị từ điện thoại, máy ảnh tới PC.',
    variantsGuide: 'Bộ 2 Micro đa thiết bị kèm dây/đầu chuyển theo phân loại thực tế.',
    compatibility: 'Kết nối **điện thoại** (Type-C / Lightning qua dây chuyển), **máy ảnh** (ngõ 3.5mm) và **máy tính/laptop** (USB).',
    fit: 'quay đa thiết bị (máy ảnh, điện thoại, PC), phỏng vấn 2 người, cần kiểm âm trực tiếp',
    defaultPrice: '2.100.000 ₫'
  },
  'gaeru-p01': {
    name: 'GAERU P01',
    kind: 'gimbal',
    role: '**Gimbal AI tự động quay theo người xoay 360°** (nhận diện khuôn mặt & dáng người, tự xoay theo khi di chuyển, không cần cài app).',
    audio: 'Thiết bị chuyên quay hình theo dõi khung hình (không phải micro thu âm).',
    battery: 'Thời lượng pin sử dụng khoảng **6–8 giờ** tùy chế độ xoay; sạc qua cổng nguồn tiêu chuẩn trên máy.',
    range: 'Cảm biến AI nhận diện chủ thể trực tiếp trong vùng quay, xoay 360° ngang/dọc linh hoạt.',
    variantsGuide: 'Phân loại bản để bàn gọn nhẹ hoặc bộ kèm chân đứng 2m1 (ren 1/4").',
    compatibility: 'Kẹp giữ thân máy trực tiếp nên tương thích mọi dòng iPhone (5 đến 18 series) và mọi hãng Android (Samsung, OPPO, Xiaomi, vivo, HONOR, Pixel…) không phân biệt chân cắm.',
    fit: 'tự quay một mình, livestream bán hàng di chuyển, dạy học/chia sẻ cần luôn giữ chủ thể ở giữa khung hình',
    defaultPrice: 'Từ 550.000 ₫'
  },
  'gaeru-p185': {
    name: 'GAERU P185',
    kind: 'tripod',
    role: 'Gậy chụp hình selfie kiêm **Tripod 4 chân hợp kim** chắc chắn, kèm remote Bluetooth tháo rời.',
    audio: 'Phụ kiện giá đỡ quay chụp (không tích hợp micro). Trọng lượng nhẹ **423g**, có ren 1/4".',
    battery: 'Remote Bluetooth tích hợp pin **55 mAh**, sạc lại qua cổng **Type-C**.',
    range: 'Kéo dài linh hoạt từ **29,5 cm đến 180 cm (1m8)**; remote bấm chụp/quay từ xa qua Bluetooth.',
    variantsGuide: 'Phiên bản chuẩn gậy 4 chân xoay 360° kèm remote Bluetooth.',
    compatibility: 'Ngàm kẹp xoay 360° tương thích mọi dòng iPhone và Android không phụ thuộc cổng cắm; kết nối chụp/quay từ xa bằng Bluetooth + hỗ trợ ren 1/4" cho thiết bị nhẹ.',
    fit: 'tự quay góc rộng/góc cao tới 1m8, chụp ảnh nhóm, livestream cần chân đứng 4 chấu vững',
    defaultPrice: '450.000 ₫'
  }
});

function isAskingOwnOrder(qSpace) {
  return !hasAnyBoundaryTerm(qSpace, ['bao hanh', 'doi tra']) && (
    hasAnyBoundaryTerm(qSpace, [
      'don cua minh', 'don cua toi', 'don hang cua minh', 'don hang cua toi',
      'don gan nhat', 'don vua dat', 'don moi dat', 'kiem tra don hang',
      'kiem tra don', 'trang thai don hang', 'trang thai don', 'tra cuu don', 'tinh trang don'
    ]) || (hasAnyBoundaryTerm(qSpace, ['don hang', 'kien hang', 'goi hang']) &&
      hasAnyBoundaryTerm(qSpace, ['cua minh', 'cua toi', 'gan nhat', 'vua dat', 'moi dat', 'toi dau', 'den dau']))
  );
}

/**
 * Tra cứu thông tin đơn hàng từ database nếu khách cung cấp mã đơn (GR-... / GAE-...) hoặc SĐT.
 */
async function lookupOrderInfo(pool, text, thread = null) {
  if (!pool || typeof pool.query !== 'function') return null;

  const orderCodes = extractOrderCodes(text);
  const phones = extractPhoneNumbers(text);
  const qSpace = normalizeSearchSpace(expandQueryVi(text));
  const asksOwnLatestOrder = !orderCodes.length && !phones.length && Boolean(thread?.customer_id) && isAskingOwnOrder(qSpace);

  if (!orderCodes.length && !phones.length && !asksOwnLatestOrder) return null;

  const orderCode = orderCodes[0] || null;
  const phone = phones[0] || null;

  try {
    let row = null;
    let queryType = null;
    if (orderCode) {
      queryType = 'order_number';
      row = (await pool.query(
        `SELECT id, order_number, customer_id, customer_name, phone, address, city, status, payment_method, payment_status, total_vnd, created_at
         FROM orders
         WHERE lower(order_number) = lower($1)
         LIMIT 1`,
        [orderCode]
      )).rows[0];
    } else if (phone) {
      queryType = 'phone';
      row = (await pool.query(
        `SELECT id, order_number, customer_id, customer_name, phone, address, city, status, payment_method, payment_status, total_vnd, created_at
         FROM orders
         WHERE phone = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [phone]
      )).rows[0];
    } else if (asksOwnLatestOrder && thread?.customer_id) {
      queryType = 'customer_latest';
      row = (await pool.query(
        `SELECT id, order_number, customer_id, customer_name, phone, address, city, status, payment_method, payment_status, total_vnd, created_at
         FROM orders
         WHERE customer_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [thread.customer_id]
      )).rows[0];
      if (!row) {
        return { searched: true, found: false, queryType, query: 'tài khoản của bạn' };
      }
    }

    if (!row) return { searched: true, found: false, query: orderCode || phone, queryType };

    const isOwner = Boolean(
      thread?.customer_id && row.customer_id && String(thread.customer_id) === String(row.customer_id)
    );

    let shipment = null;
    try {
      shipment = (await pool.query(
        `SELECT carrier_id,
                CASE carrier_id
                  WHEN 'viettel' THEN 'Viettel Post'
                  WHEN 'jt' THEN 'J&T Express'
                  WHEN 'spx' THEN 'SPX Express'
                  ELSE carrier_id
                END AS carrier_name,
                tracking_number, status, last_synced_at AS synced_at
         FROM carrier_shipments
         WHERE order_id = $1 AND status <> 'cancelled'
         ORDER BY created_at DESC
         LIMIT 1`,
        [row.id]
      )).rows[0] || null;
    } catch (_) {}

    return {
      searched: true,
      found: true,
      order: row,
      shipment,
      isOwner,
      hasThreadContext: thread !== null && thread !== undefined,
      hasCustomerIdCol: Object.prototype.hasOwnProperty.call(row, 'customer_id'),
      queryType,
      query: orderCode || phone || row.order_number
    };
  } catch (_) {
    return null;
  }
}

function getPriceSummaryFromProduct(prod, spec) {
  const variants = Array.isArray(prod?.variants) ? prod.variants.filter(v => v && Number.isFinite(Number(v.priceVnd))) : [];
  if (!variants.length) return spec?.defaultPrice || 'Liên hệ để xem giá';
  const prices = variants.map(v => Number(v.priceVnd));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? formatVnd(min) : `${formatVnd(min)} – ${formatVnd(max)}`;
}

function formatShortEndTime(isoValue) {
  if (!isoValue) return '';
  const dt = new Date(isoValue);
  if (!Number.isFinite(dt.getTime()) || dt.getTime() <= Date.now()) return '';
  try {
    return dt.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  } catch (_) {
    return '';
  }
}

function formatVariantSummaryLines(prod, question, inferredPorts = null) {
  const variants = Array.isArray(prod?.variants) ? prod.variants : [];
  if (!variants.length) return '';
  const filtered = matchProductVariants(question, variants, { ports: inferredPorts });
  const target = filtered.length ? filtered : variants.slice(0, 6);
  return target.map(v => {
    const inStock = v.stockQuantity === undefined ? (v.available !== false) : Number(v.stockQuantity) > 0;
    const stockBadge = inStock ? 'Còn hàng' : 'Tạm hết';
    const hasDiscount = Number(v.originalPriceVnd) > Number(v.priceVnd);
    const pricePart = hasDiscount
      ? `**${formatVnd(v.priceVnd)}** (giá gốc ${formatVnd(v.originalPriceVnd)})`
      : `**${formatVnd(v.priceVnd)}**`;
    const promo = v.activePromotion || v.promotion;
    const endDate = formatShortEndTime(promo?.endsAt || promo?.ends_at);
    const promoNote = promo?.title ? ` · Ưu đãi: ${promo.title}${endDate ? ` (đến ${endDate})` : ''}` : '';
    return `- ${v.name || 'Phiên bản chuẩn'}: ${pricePart} (${stockBadge})${promoNote}`;
  }).join('\n');
}

function detectPurchaseClosingIntent(rawQuestion, space) {
  const s = space || normalizeSearchSpace(expandQueryVi(rawQuestion));
  if (!s) return { isClosing: false, isDirectClose: false, isBuyQuery: false };

  const rawText = String(rawQuestion || '');
  // Tránh nhầm từ đồng âm "mưa" / "mùa" (sau bỏ dấu thành "mua") với hành vi mua hàng
  if (/(?:^|[^\p{L}])m(?:ưa|ùa)(?=$|[^\p{L}])/iu.test(rawText) && !/(?:^|[^\p{L}])mua(?=$|[^\p{L}])/iu.test(rawText)) {
    return { isClosing: false, isDirectClose: false, isBuyQuery: false };
  }

  const negated = /(?:^|[^a-z0-9])(?:chua|khong|dung|thoi|huy|bo|ngung)\s+(?:\w+\s+){0,2}(?:chot|mua|dat|lay|len don|dat hang)(?=$|[^a-z0-9])/i.test(s) ||
    hasAnyBoundaryTerm(s, ['chua can mua', 'tham khao truoc', 'suy nghi them', 'hoi truoc', 'chi hoi']);
  if (negated) return { isClosing: false, isDirectClose: false, isBuyQuery: false };

  const isDirectClose = hasAnyBoundaryTerm(s, [
    'chot', 'chot don', 'chot lay', 'chot mua', 'chot ban', 'chot bo', 'chot cai', 'chot con',
    'chot nha', 'chot nhe', 'chot luon', 'chot di', 'ok chot', 'oke chot',
    'mua ngay', 'dat ngay', 'dat mua', 'dat hang', 'len don', 'mua luon', 'lay luon',
    'bam mua', 'link mua', 'link dat', 'gui link mua', 'gui link', 'thanh toan ngay',
    'minh lay', 'em lay', 'anh lay', 'chi lay', 'toi lay', 'chac lay', 'ok lay', 'oke lay',
    'dat cho minh', 'dat cho em', 'dat cho anh', 'dat cho chi', 'lay cho minh', 'lay cho em'
  ]);
  const hasExplicitBuyVerb = hasAnyBoundaryTerm(s, [
    'muon mua', 'muon dat', 'can mua', 'chon mua', 'mua ban nao', 'mua loai nao',
    'mua mau nao', 'nen mua', 'chon ban nao', 'mua o dau', 'cach mua', 'bam mua dau', 'mua hang'
  ]) || /\bmua\s+(?:k9|m3|p01|p185|g1|gaeru|mic|micro|gimbal|gay|bo|ban|loai|chiec|cai)\b/.test(s);

  return {
    isClosing: isDirectClose || hasExplicitBuyVerb,
    isDirectClose,
    isBuyQuery: hasExplicitBuyVerb
  };
}

function collectSameProductVariantHints({ rawQuestion, prodKey, mentionedSource, history = [] }) {
  const chunks = [String(rawQuestion || '')];
  const currentExpanded = normalizeSearchSpace(expandQueryVi(rawQuestion));
  const hasCurrentMicOrStand = hasAnyBoundaryTerm(currentExpanded, ['1 mic', '2 mic', '1 micro', '2 micro', 'de ban', '2m1', '2.1m']);

  if (!hasCurrentMicOrStand && Array.isArray(history) && history.length) {
    const productTokens = prodKey ? [prodKey, prodKey.replace('gaeru-', '')] : [];
    for (const msg of [...history].slice(-4).reverse()) {
      if (!msg || (msg.sender && msg.sender !== 'customer')) continue;
      const body = String(msg.body || msg.content || '');
      const mSpace = normalizeSearchSpace(expandQueryVi(body));
      if (!mSpace) continue;
      // Chỉ kế thừa số mic / chân đứng từ lượt trước nếu lượt hiện tại không đổi sang sản phẩm khác
      if (mentionedSource === 'question' && productTokens.length && !hasAnyBoundaryTerm(mSpace, productTokens) && hasAnyBoundaryTerm(mSpace, ['k9', 'm3', 'p01', 'p185', 'g1'])) {
        continue;
      }
      if (hasAnyBoundaryTerm(mSpace, ['1 mic', '2 mic', '1 micro', '2 micro', 'de ban', '2m1', '2.1m'])) {
        chunks.push(body);
        break;
      }
    }
  }
  return chunks.join(' ');
}

function formatBuyCtaLink({ prod, variant, displayName }) {
  const slug = String(prod?.slug || '').toLowerCase();
  const priceNum = variant && Number.isFinite(Number(variant.priceVnd)) ? Number(variant.priceVnd) : null;
  const priceText = priceNum !== null ? ` (${formatVnd(priceNum)})` : '';
  const varName = variant?.name ? String(variant.name).trim() : '';
  const fullTitle = varName && varName.toLowerCase() !== displayName.toLowerCase()
    ? `${displayName} · ${varName}`
    : displayName;
  const href = variant?.id
    ? `/thanh-toan?variant=${encodeURIComponent(variant.id)}`
    : `/san-pham/${encodeURIComponent(slug)}`;
  return `- 👉 [Mua ngay ${fullTitle}${priceText}](${href})`;
}

function formatBundleDiscountText(bundle) {
  if (!bundle) return '';
  if (bundle.discount_type === 'percent' && Number(bundle.discount_value) > 0) {
    return `Giảm ${Number(bundle.discount_value)}%`;
  }
  if (Number(bundle.discount_value) > 0) {
    return `Giảm ${formatVnd(bundle.discount_value)}`;
  }
  return 'Giá combo ưu đãi';
}

function resolveBundleMatchForProduct(webKnowledge, slug) {
  const bundles = Array.isArray(webKnowledge?.activeBundles) ? webKnowledge.activeBundles : [];
  if (!bundles.length || !slug) return null;
  return bundles.find(b => Array.isArray(b.items) && b.items.some(it => String(it.productSlug || '').toLowerCase() === slug)) || null;
}

function buildClosingRecommendation({ prodEntry, question, space, history = [], catalog = [], webKnowledge = null, isDirectClose = false, alreadyExplainedVariant = false }) {
  const slug = prodEntry.key;
  const liveProd = prodEntry.product;
  const spec = PRODUCT_SPECS[slug];
  const displayName = liveProd?.name || spec?.name || slug.toUpperCase();
  const activeVariants = Array.isArray(liveProd?.variants)
    ? liveProd.variants.filter(v => v && v.active !== false)
    : [];

  const inferredPorts = inferDevicePortsFromText(space, history);
  const variantHintText = collectSameProductVariantHints({
    rawQuestion: question,
    prodKey: slug,
    mentionedSource: prodEntry.source,
    history
  });

  let candidates = matchProductVariants(variantHintText, activeVariants, { ports: inferredPorts });
  if (!candidates.length && activeVariants.length === 1) {
    candidates = activeVariants;
  }

  const targetPool = candidates.length ? candidates : activeVariants;
  const inStockPool = targetPool.filter(v => v.stockQuantity === undefined || Number(v.stockQuantity) > 0);
  const allActiveOutOfStock = activeVariants.length > 0 && activeVariants.every(v => Number(v.stockQuantity) <= 0);

  if ((targetPool.length > 0 && inStockPool.length === 0) || allActiveOutOfStock) {
    const outLabel = targetPool.length === 1 && targetPool[0]?.name ? ` (${targetPool[0].name})` : '';
    const altProd = (catalog || []).find(p =>
      p.slug !== slug &&
      p.active !== false &&
      Array.isArray(p.variants) &&
      p.variants.some(v => v.active !== false && (v.stockQuantity === undefined || Number(v.stockQuantity) > 0))
    );
    const altHint = altProd
      ? ` Bạn có thể tham khảo **${altProd.name}** hiện đang sẵn hàng ([Xem ${altProd.name}](/san-pham/${encodeURIComponent(altProd.slug)})), hoặc bấm **Gặp nhân viên** để báo lịch về hàng nhé.`
      : ' Bạn bấm **Gặp nhân viên** hoặc gọi hotline **082 919 1080** để kiểm tra lịch nhập hàng nhé.';
    return `Hiện **${displayName}**${outLabel} đang **tạm hết hàng** trên hệ thống nên chưa thể đặt mua ngay.${altHint}`;
  }

  const nationwideShipFee = webKnowledge?.shippingRates ? shippingFee(webKnowledge.shippingRates, 'Toàn quốc') : undefined;
  const matchedBundle = isDirectClose ? resolveBundleMatchForProduct(webKnowledge, slug) : null;

  if (inStockPool.length >= 1 && inStockPool.length <= 3) {
    const lines = [];
    if (isDirectClose && !alreadyExplainedVariant) {
      if (inStockPool.length === 1) {
        const v = inStockPool[0];
        const hasDiscount = Number(v.originalPriceVnd) > Number(v.priceVnd);
        const priceNote = hasDiscount
          ? `**${formatVnd(v.priceVnd)}** (giá gốc ${formatVnd(v.originalPriceVnd)})`
          : `**${formatVnd(v.priceVnd)}**`;
        const isFreeShip = nationwideShipFee === 0 || (nationwideShipFee === undefined && Number(v.priceVnd) >= 500000);
        const shipNote = isFreeShip ? 'Freeship toàn quốc, ' : '';
        lines.push(`Xác nhận chốt **${displayName}** · **${v.name}** (${priceNote} — **Còn hàng**, ${shipNote}bảo hành 12 tháng, đổi mới 1:1 trong 7 ngày lỗi NSX).`);
      } else {
        lines.push(`**${displayName}** hiện có các lựa chọn phù hợp đang **Còn hàng**, bạn chọn đúng phân loại bên dưới để đặt mua ngay:`);
      }
    }
    const maxButtons = isDirectClose ? 3 : 2;
    for (const v of inStockPool.slice(0, maxButtons)) {
      lines.push(formatBuyCtaLink({ prod: liveProd || { slug, name: displayName }, variant: v, displayName }));
    }
    if (matchedBundle) {
      const otherNames = (matchedBundle.items || []).filter(i => i.productSlug !== slug).map(i => i.productName).filter(Boolean);
      const comboWith = otherNames.length ? ` (mua kèm ${otherNames.join(' + ')})` : '';
      lines.push(`- 💡 Đang có gói combo **${matchedBundle.title}**${comboWith}: **${formatBundleDiscountText(matchedBundle)}** — tiết kiệm hơn khi đặt chung giỏ hàng!`);
    }
    return lines.join('\n');
  }

  const lines = [];
  if (isDirectClose && !alreadyExplainedVariant) {
    lines.push(`Để đặt mua đúng phiên bản **${displayName}**, bạn cho mình biết thêm **thiết bị đang dùng** (Type-C / Lightning / Micro-USB / USB-A) và chọn **1 mic hay 2 mic** — hoặc bấm trực tiếp bên dưới để chọn phân loại & mua ngay:`);
  }
  lines.push(`- 👉 [Chọn phân loại & Mua ngay ${displayName}](/san-pham/${encodeURIComponent(slug)})`);
  return lines.join('\n');
}

function formatOrderLookupReply(orderLookup, questionNorm) {
  if (orderLookup.queryType === 'phone' && !orderLookup.isOwner) {
    return {
      handoff: false,
      answer: 'Để bảo vệ quyền riêng tư, bạn vui lòng đăng nhập đúng tài khoản mua hàng hoặc nhắn chính xác **Mã đơn hàng (dạng GR-... hoặc GAE-...)** để mình tra cứu nhé.',
      orderLookup: { found: false, protected: true }
    };
  }

  if (!orderLookup.found) {
    return {
      handoff: false,
      answer: `Chưa tìm thấy đơn hàng với thông tin "${orderLookup.query}". Bạn kiểm tra lại đúng mã đơn (dạng GR-... hoặc GAE-...) giúp mình nhé.`,
      orderLookup: { found: false }
    };
  }

  const o = orderLookup.order;
  const s = orderLookup.shipment;
  const isLegacyMockWithoutContext = !orderLookup.hasThreadContext && !orderLookup.hasCustomerIdCol;

  if (!orderLookup.isOwner && !isLegacyMockWithoutContext) {
    const redactedAnswer = `Mã đơn **${o.order_number}** đã được ghi nhận trên hệ thống GAERU.\n\n` +
      `- Khách hàng / Trạng thái / Thanh toán: *** (Đã ẩn để bảo mật)\n` +
      `- Địa chỉ giao hàng: *** (Đã ẩn địa chỉ chi tiết vì lý do bảo mật)\n` +
      `Vui lòng đăng nhập đúng tài khoản đặt hàng hoặc tra cứu tại trang **Theo dõi đơn hàng** kèm số điện thoại đặt hàng.`;
    return { handoff: false, answer: redactedAnswer, orderLookup: { found: true, isOwner: false, protected: true } };
  }

  const statusMap = {
    pending: 'Chờ xác nhận',
    confirmed: 'Đã xác nhận đơn hàng',
    processing: 'Đang đóng gói và chuẩn bị hàng',
    shipped: 'Đang vận chuyển giao cho khách',
    completed: 'Giao hàng thành công',
    cancelled: 'Đã hủy đơn hàng'
  };
  const payMap = {
    cod: 'COD (thanh toán khi nhận hàng)',
    vietqr: 'Chuyển khoản VietQR',
    vnpay: 'VNPAY',
    momo: 'Ví MoMo',
    zalopay: 'ZaloPay'
  };

  const displayAddress = (orderLookup.isOwner || isLegacyMockWithoutContext)
    ? [o.address, o.city].filter(Boolean).join(', ')
    : '*** (Đã ẩn địa chỉ chi tiết vì lý do bảo mật)';
  const shipLine = s && s.tracking_number
    ? `${s.carrier_name || 'Viettel Post'} · Mã vận đơn: \`${s.tracking_number}\` (${s.status || 'Đang giao'})`
    : 'Đang chuẩn bị bàn giao đơn vị vận chuyển';

  if (hasAnyBoundaryTerm(questionNorm, ['van don', 'ma van don', 'buu cuc', 'shiper', 'shipper', 'den dau', 'o dau', 'chua giao'])) {
    return {
      handoff: false,
      answer: `Đơn **${o.order_number}** (${o.customer_name}): **${statusMap[o.status] || o.status}**.\n- Vận chuyển: ${shipLine}${displayAddress ? `\n- Địa chỉ: ${displayAddress}` : ''}`,
      orderLookup: { found: true, isOwner: orderLookup.isOwner }
    };
  }

  const answer = `Thông tin đơn hàng **${o.order_number}**:\n` +
    `- Khách hàng: ${o.customer_name}\n` +
    `- Trạng thái: **${statusMap[o.status] || o.status}**\n` +
    `- Thanh toán: ${payMap[o.payment_method] || o.payment_method} (${o.payment_status === 'paid' ? 'Đã thanh toán' : 'Chờ thanh toán'}) — **${formatVnd(o.total_vnd)}**\n` +
    `- Địa chỉ: ${displayAddress}\n` +
    `- Vận chuyển: ${shipLine}`;
  return { handoff: false, answer, orderLookup: { found: true, isOwner: orderLookup.isOwner } };
}

const DEVICE_COMPAT_TERMS = Object.freeze(Array.from(new Set([
  'tuong thich', 'dung duoc', 'cam duoc', 'ket noi', 'cong cam', 'chan cam', 'chan sac', 'cong sac',
  'iphone', 'ipad', 'macbook', 'mb pro', 'mb air', 'mac air', 'mac pro', 'ios', 'apple', 'android',
  'otg', 'bat otg', 'mo otg', 'ket noi otg',
  'go loi usb', 'bat go loi usb', 'mo go loi usb', 'nha phat trien', 'tuy chon nha phat trien', 'developer options', 'dinh tuyen am thanh usb', 'disable usb audio routing',
  'ios 18', 'ios 19', 'ios 26', 'ios 17', 'ios 16', 'ios 15', 'ios 14', 'ios moi', 'ios duoi 18', 'ios cu',
  'mic ngoai', 'mic gan ngoai', 'micro ngoai', 'micro gan ngoai', 'chon mic', 'dau vao am thanh', 'trung tam dieu khien', 'mic may', 'mic iphone',
  'type c', 'lightning', 'micro usb', 'usb a', 'chuyen usb', 'usb thuong',
  'khong nhan', 'chua nhan', 'chua sang', 'den khong sang', 'mat tieng', 'khong co tieng', '3.5mm', 'jack 3.5',
  'tieng vang', 'bi vang', 'bi nhai', 'reverb', 'tieng vong', 'echo', 'giong ao',
  '1 mic khong len', 'chi co 1 mic', 'chi thu 1 mic', '1 ben khong', '1 mic bi mat', 'ghep doi lai', 'ket noi 2 mic',
  'bi re', 'tieng re', 'vo tieng', 'vo am', 'tieng nho', 'nho tieng', 'co ao', 'u gio', 'gio giat', 'tieng gio', 'nhieu gio', 'gio to', 'loc gio', 'thu ro', 'deadcat',
  'den nhap nhay', 'nhap nhay cham', 'den do', 'den xanh', 'lech pin', 'khong sac', 'chan tiep xuc', 'hop sac khong sac', 'sac khong vao',
  'vua sac vua dung', 'vua sac vua live', 'vua sac vua quay', 'cong chia', 'cap chia', 'hub chia', 'splitter',
  'nghe lai video', 'phat lai video', 'nghe loa ngoai', 'khong nghe thay loa', 'cam vao bi mat loa',
  'gopro', 'media mod', 'dji osmo', 'osmo pocket', 'osmo action', 'action cam', 'zv e10', 'zv-e10', 'zv1', 'zv-1', 'trs', 'trrs', 'canon', 'fujifilm', 'nikon',
  'may tinh bang', 'tablet', 'mtb', 'may anh', 'camera', 'tiktok', 'capcut', 'zoom', 'obs', 'open camera',
  'cac loai dien thoai', 'cac dong dien thoai', 'cac hang dien thoai', 'tat ca dien thoai', 'dien thoai nao dung', 'hang dien thoai nao',
  'tat ca thiet bi', 'nhung thiet bi nao', 'cac thiet bi ho tro',
  ...BRAND_PROFILES.flatMap(b => b.triggers),
  ...TABLET_PROFILES.flatMap(t => t.triggers),
  ...WINDOWS_LAPTOP_BRANDS,
  ...DESKTOP_PC_TRIGGERS
])));

function buildDeviceCompatibilityAnswer(space, rawQuestion, matchedProdKey) {
  return buildComprehensiveCompatibilityAnswer(space, rawQuestion, matchedProdKey);
}

function buildProductGuideAnswer({ slug, displayName, space }) {
  const guide = PRODUCT_GUIDE_CONTENT?.[slug];
  const guideLink = `/huong-dan/${encodeURIComponent(slug)}`;

  // 1. P185 Bluetooth remote pairing
  if (slug === 'gaeru-p185' && hasAnyBoundaryTerm(space, ['remote', 'bluetooth', 'dieu khien', 'chup tu xa', 'ghep noi', 'ket noi'])) {
    return (
      `**Hướng dẫn kết nối remote Bluetooth ${displayName}:**\n` +
      '1. **Bật nguồn remote:** Tháo điều khiển từ xa khỏi thân gậy, gạt công tắc / giữ nút nguồn cho tới khi đèn báo nhấp nháy (pin tích hợp **55 mAh**, sạc lại qua cổng **Type-C**).\n' +
      '2. **Ghép nối Bluetooth:** Mở **Cài đặt → Bluetooth** trên điện thoại, chọn tên thiết bị remote P185 để ghép đôi.\n' +
      '3. **Thử bấm chụp:** Mở ứng dụng Camera mặc định và bấm thử ở cự ly gần (nếu bấm không chụp, kiểm tra pin remote và bật tùy chọn *Dùng nút âm lượng để chụp* trong cài đặt Camera).\n' +
      `- 📖 [Xem hướng dẫn đầy đủ ${displayName}](${guideLink})`
    );
  }

  // 2. LED indicator / blinking red-green / pairing light
  if (hasAnyBoundaryTerm(space, ['den nhap nhay', 'nhap nhay', 'den bao', 'den do', 'den xanh', 'nhay do', 'nhay xanh', 'bao den']) &&
      ['gaeru-k9', 'gaeru-m3', 'gaeru-g1-ultra'].includes(slug)) {
    return (
      `**Ý nghĩa đèn báo trên ${displayName}:**\n` +
      '- **Đèn nhấp nháy luân phiên (đỏ/xanh) hoặc nháy chậm:** Micro đang **chờ ghép nối với đầu thu RX** — hãy cắm sát đầu thu vào điện thoại (tháo ốp dày; với OPPO/Realme/Vivo/Tecno/Infinix nhớ bật **Kết nối OTG** trong Cài đặt).\n' +
      '- **Đèn sáng đứng ổn định:** Micro và đầu thu đã kết nối thành công, sẵn sàng thu âm.\n' +
      '- **Đèn nháy đỏ liên tục / tắt nhanh:** Micro đang **pin yếu** — hãy sạc lại bằng nguồn **5V/1A – 5V/2A** (với hộp sạc **M3 / G1 ULTRA**, lau khô sạch chân tiếp xúc đồng trước khi đặt vào hộp).\n' +
      `- 📖 [Xem hướng dẫn xử lý lỗi ${displayName}](${guideLink})`
    );
  }

  // 3. How to toggle noise reduction / button operation
  if (hasAnyBoundaryTerm(space, ['cach bat', 'bat che do', 'chuyen che do', 'nut bam', 'nut loc on', 'bam nut', 'tat loc on']) &&
      hasAnyBoundaryTerm(space, ['loc on', 'giam on', 'chong on', 'khu on', 'che do', 'mute', 'tat tieng', 'reverb', 'tieng vang']) &&
      ['gaeru-k9', 'gaeru-m3', 'gaeru-g1-ultra'].includes(slug)) {
    return (
      `**Cách bật/chuyển chế độ lọc ồn trên ${displayName}:**\n` +
      '- **Bước 1:** Cắm đầu thu RX vào máy và bật nguồn micro cho tới khi **đèn kết nối sáng đứng**.\n' +
      '- **Bước 2:** Bấm nhanh **nút nguồn / nút chức năng** trên thân micro theo ký hiệu trong tờ hướng dẫn đi kèm hộp để bật hoặc chuyển mức giảm ồn (tránh nhấn giữ lâu vì nhấn giữ là tắt nguồn).\n' +
      '- **Bước 3:** Gắn kèm **bông lọc gió** khi quay ngoài trời, kẹp mic cách miệng **10–15 cm** và thu thử 5 giây để kiểm tra trực tiếp âm thanh (không chỉ nhìn đèn báo).\n' +
      `- 📖 [Xem hướng dẫn đầy đủ ${displayName}](${guideLink})`
    );
  }

  // 4. General step-by-step usage guide from src/product-guides.js
  if (guide && Array.isArray(guide.steps) && guide.steps.length) {
    const stepLines = guide.steps.slice(0, 5).map(([title, text], idx) => `${idx + 1}. **${title}:** ${text}`);
    const androidNote = ['gaeru-k9', 'gaeru-m3', 'gaeru-g1-ultra'].includes(slug)
      ? '\n- **Lưu ý điện thoại Android:** Một số máy (**OPPO, Realme, Redmi/Xiaomi, vivo…**) cần bật **Kết nối OTG** (nếu máy yêu cầu) và quay bằng **app tải từ kho ứng dụng** (**Open Camera** chọn *Micro ngoài*, **TikTok**, **CapCut**) vì app Camera cài sẵn chỉ dùng mic của điện thoại.'
      : '';
    return `**Hướng dẫn sử dụng nhanh ${displayName}:**\n${stepLines.join('\n')}${androidNote}\n- 📖 [Xem đầy đủ hướng dẫn & xử lý lỗi ${displayName}](${guideLink})`;
  }

  return '';
}

function buildProductVersionSelectionAnswer({ slug, displayName, liveProd, spec }) {
  const variantLines = formatVariantSummaryLines(liveProd, '');
  const tips = {
    'gaeru-k9':
      '- **Chọn số lượng micro:** **Bộ 1 Micro** (từ `289.000 ₫`) phù hợp tự quay 1 người/dạy học; **Bộ 2 Micro** (từ `409.000 ₫`) phù hợp phỏng vấn, quay 2 người hoặc luân phiên thay nhau khi quay lâu.\n' +
      '- **Chọn đúng chân cắm:** iPhone 15–18 / Android mới / MacBook chọn **Chân Type C**; iPhone 14 trở xuống chọn **Chân Lightning** (hoặc **Chân Type C + Chuyển Lightning** để dùng được cả 2 máy); PC/Laptop cổng USB chữ nhật chọn **+ Chuyển USB**; Android đời cũ chọn **+ Chuyển Micro USB**.',
    'gaeru-m3':
      '- **GAERU M3** mặc định là bộ **2 Micro + hộp sạc hiển thị % pin** (đồng giá `1.200.000 ₫`), khác nhau ở **đầu chuyển đi kèm**:\n' +
      '- **Type C:** Cắm trực tiếp iPhone 15–18, Android đời mới, iPad/MacBook Type-C.\n' +
      '- **Type C + đầu chuyển Lightning:** Dùng thêm cho iPhone 14 trở xuống & iPad Lightning.\n' +
      '- **Type C + chuyển USB / Micro usb:** Dùng cho Laptop/PC cổng USB-A chữ nhật hoặc Android đời cũ.',
    'gaeru-p01':
      '- **Bản để bàn** (`550.000 ₫`): Gọn nhẹ đặt trực tiếp trên bàn làm việc, bàn học, quầy livestream.\n' +
      '- **Bản kèm chân 2m1** (`650.000 ₫`): Đặt dưới sàn quay đứng toàn thân, linh hoạt chiều cao khi bán hàng hoặc tập luyện.',
    'gaeru-p185':
      '- **GAERU P185** có 1 phiên bản tiêu chuẩn (`450.000 ₫`) tích hợp sẵn tripod 4 chân kéo dài **29,5–180 cm** và remote Bluetooth tháo rời, tương thích mọi dòng iPhone & Android.',
    'gaeru-g1-ultra':
      '- **GAERU G1 ULTRA** (`2.100.000 ₫`) là bộ 2 micro đa thiết bị kèm hộp sạc, hỗ trợ điện thoại (Type-C/Lightning), máy ảnh (3.5mm TRS) và PC/Laptop.'
  };
  const body = tips[slug] || (spec?.variantsGuide ? `- ${spec.variantsGuide}` : '');
  const lines = [`**Hướng dẫn chọn phiên bản ${displayName} phù hợp:**`];
  if (body) lines.push(body);
  if (variantLines) lines.push(`**Phân loại & tồn kho hiện tại:**\n${variantLines}`);
  lines.push('Bạn nhắn tên máy đang dùng để mình chốt chính xác phân loại cho bạn nhé!');
  return lines.join('\n');
}

function buildInternalVariantComparisonAnswer(slug, liveProd, space) {
  if (slug === 'gaeru-k9') {
    const vars = Array.isArray(liveProd?.variants) ? liveProd.variants : [];
    const v1 = vars.find(v => /1\s*mic|k9ip1m|k9tc1m$/i.test(`${v.name} ${v.sku}`));
    const v2 = vars.find(v => /2\s*mic|k9ip2m|k9tc2m$/i.test(`${v.name} ${v.sku}`));
    const p1 = v1 ? formatVnd(v1.priceVnd) : '289.000 ₫';
    const p2 = v2 ? formatVnd(v2.priceVnd) : '409.000 ₫';
    return (
      '**So sánh GAERU K9 Bộ 1 Micro và Bộ 2 Micro:**\n' +
      `- **Bộ 1 Micro (từ ${p1}):** Gồm **1 micro cài áo (TX) + 1 đầu thu (RX)** — phù hợp tự quay vlog 1 người, dạy học, livestream cá nhân, tối ưu chi phí.\n` +
      `- **Bộ 2 Micro (từ ${p2}):** Gồm **2 micro cài áo (2 TX) + 1 đầu thu (RX)** — thu song song **2 người nói cùng lúc** (phỏng vấn, quay đôi, bán hàng 2 người) hoặc **dùng luân phiên từng mic** để kéo dài gấp đôi thời gian quay (~5 giờ).\n` +
      '- **Điểm giống nhau:** Chất lượng thu âm 360°, lọc ồn DSP, tầm thu 20m và pin ~2,5 giờ/mic hoàn toàn như nhau; các phân loại kèm đầu chuyển (Lightning / USB-A / Micro-USB) chênh thêm `50.000 ₫` so với bản chân tiêu chuẩn.'
    );
  }
  if (slug === 'gaeru-p01') {
    return (
      '**So sánh 2 phiên bản Gimbal AI GAERU P01:**\n' +
      '- **Bản để bàn (`550.000 ₫`):** Gồm thân gimbal xoay AI 360° + đế tròn để bàn — gọn nhẹ khi quay trên bàn làm việc, bàn trang điểm hoặc bàn livestream.\n' +
      '- **Bản kèm chân 2m1 (`650.000 ₫`):** Giống hệt thân gimbal P01 nhưng đi kèm thêm **chân đứng 2m1 (ren 1/4")** để đặt dưới sàn quay đứng toàn thân hoặc không gian rộng (chênh `100.000 ₫`).'
    );
  }
  return '';
}

function buildWaterproofAnswer(displayName = 'các thiết bị GAERU') {
  return (
    `**Khả năng chống nước (${displayName}):**\n` +
    '- Sản phẩm điện tử GAERU (**K9, M3, G1 ULTRA, P01**) **không có chuẩn chống nước IP**, vì vậy **không nên sử dụng dưới trời mưa** hoặc môi trường ẩm ướt.\n' +
    '- Sau khi dùng ngoài trời ẩm/mồ hôi, hãy lau khô thân máy và chân tiếp xúc sạc bằng khăn mềm khô trước khi cất hộp (bảo hành không áp dụng cho thiết bị ngấm nước).'
  );
}

function buildProductSpecificAnswer({ prodEntry, question, space, detailed, history = [], catalog = [], buyIntent = null, webKnowledge = null }) {
  const slug = prodEntry.key;
  const liveProd = prodEntry.product;
  const spec = PRODUCT_SPECS[slug];
  const displayName = liveProd?.name || spec?.name || slug.toUpperCase();

  // Nhận diện trường hợp khách gọi nhầm P01 là "micro" khi DB thực tế hoặc mô tả mặc định cho thấy P01 là Gimbal
  const callsP01AsMic = slug === 'gaeru-p01' && hasAnyBoundaryTerm(space, ['micro', 'mic']) && !hasAnyBoundaryTerm(space, ['gimbal', 'quay theo', 'khung hinh']);
  if (callsP01AsMic) {
    const priceRange = getPriceSummaryFromProduct(liveProd, spec);
    const variantLines = formatVariantSummaryLines(liveProd, question);
    return `Lưu ý nhỏ: **${displayName}** thực chất là **Gimbal AI tự động quay theo người xoay 360°** (không phải micro thu âm), giá **${priceRange}**.\n` +
      (variantLines ? `${variantLines}\n` : '') +
      `Nếu bạn đang tìm micro thu âm có **Khử ồn chủ động** / giảm ồn DSP thì tham khảo **GAERU K9**, **GAERU M3** hoặc **GAERU G1 ULTRA** nhé.`;
  }

  const hasDimensionOrMeasureQuestion = /\bbao nhieu\s*(?:tieng|gio|phut|ngay|met|cm|mm|gam|gram|g|kg|mah|w|hz|db|phan|nguoi|mic|cai)\b/.test(space);
  const asksWaterproof = hasAnyBoundaryTerm(space, ['chong nuoc', 'di mua', 'nuoc mua', 'ngam nuoc', 'khang nuoc', 'chuan ip', 'ipx', 'ip6', 'roi nuoc']);
  const asksVersionSelectionOnProd = hasAnyBoundaryTerm(space, ['chon phien ban', 'chon ban nao', 'tu van chon', 'phien ban phu hop', 'nen chon ban nao']);
  const asksLedOrModeOrGuide = hasAnyBoundaryTerm(space, [
    'huong dan su dung', 'huong dan dung', 'huong dan', 'cach dung', 'cach su dung', 'thiet lap',
    'den nhap nhay', 'nhap nhay', 'den bao', 'den do', 'den xanh', 'nhay do', 'nhay xanh',
    'cach bat', 'bat che do', 'chuyen che do', 'nut loc on', 'bam nut', 'tat loc on'
  ]) || (slug === 'gaeru-p185' && hasAnyBoundaryTerm(space, ['remote', 'bluetooth', 'dieu khien']));
  const asksConnectGuideQuick = hasAnyBoundaryTerm(space, ['huong dan ket noi', 'ket noi thiet bi', 'cach ket noi']) &&
    !hasAnyBoundaryTerm(space, ['iphone', 'ipad', 'samsung', 'oppo', 'realme', 'xiaomi', 'redmi', 'vivo', 'laptop', 'pc', 'macbook', 'may anh', 'remote']);
  const asksPrice = hasAnyBoundaryTerm(space, ['gia', 'gia ban', 'may tien', 'tam gia']) ||
    (hasBoundaryTerm(space, 'bao nhieu') && !hasDimensionOrMeasureQuestion && !hasAnyBoundaryTerm(space, ['pin', 'khoang cach', 'trong luong', 'nang', 'chieu dai', 'chieu cao', 'keo dai', 'dung luong', 'bao xa', 'bao lau']));
  const asksStock = hasAnyBoundaryTerm(space, ['con hang', 'het hang', 'san hang', 'ton kho', 'con khong', 'con may', 'co san']);
  const asksBattery = hasAnyBoundaryTerm(space, ['pin', 'thoi luong', 'bao lau', 'may gio', 'may tieng', 'hop sac', 'sac', 'mah']);
  const asksRange = hasAnyBoundaryTerm(space, ['khoang cach', 'bao xa', 'may met', 'tam thu', 'cu ly', 'bat song']);
  const asksAudio = hasAnyBoundaryTerm(space, ['loc am', 'loc on', 'loc tieng on', 'chong on', 'khu on', 'tieng on', 'tap am', 'anc', 'dsp', 'am thanh', '360', '24 bit', '48khz', 'kiem am']);
  const asksAccessories = hasAnyBoundaryTerm(space, ['phu kien', 'trong hop', 'goi gom', 'bao gom', 'co nhung gi', 'gom gi', 'di kem']);
  const asksWeightOrSize = hasAnyBoundaryTerm(space, ['trong luong', 'nang bao nhieu', 'may gam', 'kich thuoc', 'chieu cao', 'chieu dai', 'keo dai', 'dai bao nhieu', 'bao nhieu cm', 'bao nhieu m']);
  const asksOverview = hasAnyBoundaryTerm(space, ['la gi', 'de lam gi', 'dung de lam gi', 'cong dung', 'chuc nang', 'la loai nao', 'tac dung']);
  const asksMarketplaceLink = hasAnyBoundaryTerm(space, ['shopee', 'tiktok shop', 'tiktokshop', 'san thuong mai', 'lazada', 'link shopee', 'link tiktok', 'gian hang']);
  const compatPool = asksMarketplaceLink && !hasAnyBoundaryTerm(space, ['tuong thich', 'dung duoc', 'cam duoc', 'ket noi', 'quay', 'thu am', 'livestream', 'app'])
    ? DEVICE_COMPAT_TERMS.filter(t => t !== 'tiktok')
    : DEVICE_COMPAT_TERMS;
  const nonVariantPortCompatTerms = compatPool.filter(t => !['type c', 'lightning', 'micro usb', 'usb a', 'chuyen usb', 'usb thuong'].includes(t));
  const asksCompat = hasAnyBoundaryTerm(space, compatPool) &&
    !((asksPrice || asksStock || buyIntent?.isDirectClose) && !hasAnyBoundaryTerm(space, nonVariantPortCompatTerms));

  const inferredPorts = inferDevicePortsFromText(space, history);
  const parts = [];
  const matchedVars = matchProductVariants(question, liveProd?.variants || [], { ports: inferredPorts });
  const priceText = getPriceSummaryFromProduct(matchedVars.length ? { variants: matchedVars } : liveProd, spec);

  // 0. Trả lời trực diện các câu hỏi vận hành đặc thù (chống nước, chọn phiên bản trên trang SP, hướng dẫn sử dụng / đèn LED / nút lọc ồn / remote P185)
  if (asksWaterproof) {
    parts.push(buildWaterproofAnswer(displayName));
  }

  if (asksVersionSelectionOnProd && !asksPrice && !asksStock) {
    parts.push(buildProductVersionSelectionAnswer({ slug, displayName, liveProd, spec }));
  }

  const handledGuide = asksLedOrModeOrGuide && !asksConnectGuideQuick;
  if (handledGuide) {
    const guideAns = buildProductGuideAnswer({ slug, displayName, space });
    if (guideAns) parts.push(guideAns);
  }

  // 1. Trả lời trực tiếp từng khía cạnh được hỏi
  if (asksOverview) {
    const roleDesc = spec?.role || liveProd?.descriptor || liveProd?.cardSummary || liveProd?.description?.slice(0, 180) || '';
    if (roleDesc) parts.push(`**${displayName}** là ${roleDesc.charAt(0) === '*' ? roleDesc : roleDesc}`);
  }

  if (asksPrice || asksStock) {
    const matchedVarLines = formatVariantSummaryLines(liveProd, question, inferredPorts);
    if (matchedVarLines) {
      parts.push(`**${displayName}** (${priceText}):\n${matchedVarLines}`);
    } else {
      parts.push(`**${displayName}** hiện có giá **${priceText}** (bảo hành 12 tháng, đổi mới 1:1 trong 7 ngày lỗi NSX).`);
    }
  }

  if (asksBattery && !handledGuide) {
    if (spec?.battery) parts.push(`- **Pin & sạc (${displayName}):** ${spec.battery}`);
    else if (liveProd?.description) parts.push(`- **Thông tin (${displayName}):** ${liveProd.description.slice(0, 240)}`);
  }

  if (asksRange) {
    if (spec?.range) parts.push(`- **Cự ly / phạm vi:** ${spec.range}`);
  }

  if (asksAudio && !handledGuide) {
    if (spec?.audio) parts.push(`- **Âm thanh & lọc ồn:** ${spec.audio}`);
  }

  if (asksAccessories) {
    const accMap = {
      'gaeru-k9': 'Micro cài áo (1 hoặc 2 mic theo phiên bản), đầu thu Type-C/Lightning, cáp sạc Type-C và bông lọc gió.',
      'gaeru-m3': '2 micro cài áo, 1 đầu thu Type-C, hộp sạc hiển thị % pin, bông lọc gió và cáp sạc.',
      'gaeru-g1-ultra': '2 micro cài áo, đầu thu đa thiết bị, hộp sạc và bộ dây kết nối điện thoại/máy ảnh 3.5mm/PC theo phân loại.',
      'gaeru-p01': 'Thân Gimbal AI xoay 360°, ngàm kẹp điện thoại, dây sạc (bản chân 2m1 có thêm chân đứng).',
      'gaeru-p185': 'Gậy selfie tripod 4 chấu hợp kim gập gọn và remote Bluetooth tháo rời.'
    };
    if (accMap[slug]) parts.push(`- **Trong hộp (${displayName}):** ${accMap[slug]}`);
  }

  if (asksWeightOrSize) {
    if (slug === 'gaeru-p185') parts.push('- **Kích thước & trọng lượng GAERU P185:** Kéo dài **29,5–180 cm**, nặng **423 g**, khớp ren 1/4".');
    else if (slug === 'gaeru-k9') parts.push('- **Trọng lượng GAERU K9:** Micro cài áo siêu nhẹ chỉ khoảng **7g**.');
    else if (slug === 'gaeru-m3') parts.push('- **Kích thước GAERU M3:** Bộ phát 28 × 28 × 14,1 mm; hộp sạc 82 × 45 × 39 mm.');
  }

  if (asksCompat && !(handledGuide && slug === 'gaeru-p185') && !(handledGuide && hasAnyBoundaryTerm(space, ['den nhap nhay', 'nhap nhay', 'den bao', 'den do', 'den xanh']))) {
    const compatAnswer = buildDeviceCompatibilityAnswer(space, question, slug);
    if (compatAnswer) parts.push(compatAnswer);
    else if (spec?.compatibility) parts.push(`- **Tương thích:** ${spec.compatibility}`);
  }

  // Đề xuất bấm Mua ngay nếu người mua đã chốt hoặc đang chọn để mua sản phẩm này
  const closingIntent = buyIntent || detectPurchaseClosingIntent(question, space);
  if (closingIntent.isClosing) {
    const closingBlock = buildClosingRecommendation({
      prodEntry,
      question,
      space,
      history,
      catalog,
      webKnowledge,
      isDirectClose: closingIntent.isDirectClose,
      alreadyExplainedVariant: Boolean(asksPrice || asksStock)
    });
    if (closingBlock) parts.push(closingBlock);
    if (parts.length > 0 && !detailed) {
      return parts.join('\n');
    }
  }

  // Nếu có câu trả lời trúng đích rồi (hoặc chỉ hỏi 1-2 ý), dừng ngay — KHÔNG xả nguyên brochure!
  if (parts.length > 0 && !detailed) {
    return parts.join('\n');
  }

  // Nếu câu hỏi chỉ tập trung vào sàn TMĐT / combo / chính sách / bài viết mà không hỏi thông số chung -> không chèn brochure thừa
  const isPureCommerceOrPolicy = !detailed && !closingIntent.isClosing && !asksOverview &&
    !hasAnyBoundaryTerm(space, ['thong so', 'chi tiet', 'tu van', 'gioi thieu', 'review', 'the nao', 'ra sao', 'la gi', 'phan loai']) &&
    hasAnyBoundaryTerm(space, [
      'shopee', 'tiktok shop', 'tiktokshop', 'san thuong mai', 'lazada', 'link shopee', 'link tiktok', 'gian hang',
      'combo', 'mua kem', 'tron bo', 'bo combo', 'goi combo',
      'gaeru xu', 'tich xu', 'doi xu', 'hoan xu', 'diem thuong',
      'giao hang', 'van chuyen', 'phi ship', 'ship', 'freeship', 'mien phi van chuyen', 'dong kiem',
      'thanh toan', 'cod', 'vietqr', 'vnpay', 'momo', 'zalopay',
      'ma giam gia', 'voucher', 'coupon', 'khuyen mai', 'uu dai', 'code giam',
      'bao hanh', 'doi tra', '1 doi 1', 'care+', 'care plus', 'kich hoat bao hanh',
      'bai viet', 'tin tuc', 'blog', 'bai huong dan', 'doc bai'
    ]);
  if (parts.length === 0 && isPureCommerceOrPolicy) {
    return '';
  }

  // Trường hợp khách hỏi chung chung về sản phẩm (VD: "Tư vấn K9", "M3 là gì?", "Thông số P185")
  const descLine = (liveProd?.cardSummary || liveProd?.descriptor || '').trim();
  const variantLines = formatVariantSummaryLines(liveProd, question);
  const lines = [];
  lines.push(`**${displayName}**${priceText ? ` — Giá: **${priceText}**` : ''}`);
  if (spec?.role) lines.push(`- **Tổng quan:** ${spec.role}`);
  else if (descLine) lines.push(`- **Tổng quan:** ${descLine}`);
  if (spec?.battery) lines.push(`- **Pin:** ${spec.battery}`);
  if (spec?.range) lines.push(`- **Phạm vi:** ${spec.range}`);
  if (spec?.compatibility && !asksCompat) lines.push(`- **Tương thích:** ${spec.compatibility}`);
  if (variantLines && !asksPrice && !asksStock) lines.push(`**Phân loại hiện có:**\n${variantLines}`);
  if (parts.length) {
    for (const p of parts) {
      if (!lines.some(l => l.includes(p.slice(0, 24)))) lines.push(p);
    }
  }
  return lines.join('\n');
}

function buildComparisonAnswer(matchedItems, questionNorm, catalog = []) {
  const keys = matchedItems.length >= 2
    ? matchedItems.map(m => m.key)
    : hasAnyBoundaryTerm(questionNorm, ['gimbal', 'p01', 'gay', 'p185'])
      ? ['gaeru-p01', 'gaeru-p185']
      : ['gaeru-k9', 'gaeru-m3', 'gaeru-g1-ultra'];

  const rows = [];
  for (const key of keys.slice(0, 3)) {
    const prod = catalog.find(p => String(p.slug || '').toLowerCase() === key || normalizeSearchSpace(p.name).includes(normalizeSearchSpace(key.replace('gaeru-', ''))));
    const spec = PRODUCT_SPECS[key];
    if (!spec && !prod) continue;
    const priceStr = getPriceSummaryFromProduct(prod, spec);
    if (key === 'gaeru-k9') rows.push(`- **GAERU K9 (${priceStr}):** Nhỏ gọn nhất, không hộp sạc, không cần Bluetooth (một số máy Android cần bật OTG / quay qua app tải từ kho ứng dụng), pin **2,5h/mic**, cự ly 20m — hợp quay vlog ngắn, dạy học, tối ưu chi phí.`);
    else if (key === 'gaeru-m3') rows.push(`- **GAERU M3 (${priceStr}):** Kèm **hộp sạc hiển thị % pin** (tổng tới 24h), 24-bit/48kHz, giảm ồn AI, đầu thu Type-C — hợp quay/live nhiều giờ cần pin bền.`);
    else if (key === 'gaeru-g1-ultra') rows.push(`- **GAERU G1 ULTRA (${priceStr}):** Micro đa thiết bị chuyên nghiệp (điện thoại + máy ảnh 3.5mm + PC), có tai nghe kiểm âm & nhạc nền Bluetooth.`);
    else if (key === 'gaeru-p01') rows.push(`- **GAERU P01 (${priceStr}):** Gimbal AI **tự động xoay 360° quay theo người** (pin ~6–8h), hợp tự quay/livestream rảnh tay.`);
    else if (key === 'gaeru-p185') rows.push(`- **GAERU P185 (${priceStr}):** Gậy selfie tripod 4 chân kéo dài tới **1m8** kèm remote Bluetooth, giữ máy cố định góc cao.`);
    else if (prod) rows.push(`- **${prod.name} (${priceStr}):** ${prod.descriptor || prod.cardSummary || prod.description?.slice(0, 120) || ''}`);
  }

  if (!rows.length) return '';
  return `So sánh nhanh các dòng bạn quan tâm:\n${rows.join('\n')}`;
}

function findWebKnowledgeAnswer(question, webKnowledge, catalog = []) {
  if (!webKnowledge && !catalog.length) return '';
  const qTokens = tokenizeMeaningful(question);
  if (!qTokens.length) return '';

  // 1. Admin curated approvedSources (đã được lọc theo trigger khớp trực tiếp với câu hỏi)
  const approved = webKnowledge?.externalKnowledge?.approvedSources || [];
  let bestFact = '';
  let bestScore = 0;

  for (const src of approved) {
    const facts = Array.isArray(src.facts) ? src.facts.filter(Boolean) : [];
    for (const fact of facts) {
      const score = tokenOverlapScore(qTokens, tokenizeMeaningful(`${src.title || ''} ${fact}`));
      if (score > bestScore) {
        bestScore = score;
        bestFact = fact;
      }
    }
  }
  if (approved.length > 0 && bestScore > 0 && bestFact) return bestFact;

  // 2. Crisp matched lines from storefront web pages & published guides (/tin-tuc/...)
  const { isNoiseKnowledgeLine } = require('./chat-web-knowledge');
  const snippets = (webKnowledge?.relevantSnippets || []).filter(s => s?.line && !isNoiseKnowledgeLine(s.line));
  const topSnippetScore = snippets.length ? Number(snippets[0].score || 0) : 0;

  const qSpace = normalizeSearchSpace(expandQueryVi(question));
  const isPolicyOrStoreQuery = hasAnyBoundaryTerm(qSpace, [
    'dong kiem', 'kiem tra hang', 'test thu', 'mo ra', 'doi tra', 'hoan tien',
    'bao hanh', 'hoa don', 'vat', 'hotline', 'so dien thoai', 'dia chi', 'cua hang', 'giao hang', 'phi ship'
  ]);
  const newsList = Array.isArray(webKnowledge?.latestNews) ? webKnowledge.latestNews : [];
  let bestNews = null;
  let bestNewsScore = 0;
  for (const item of newsList) {
    if (isPolicyOrStoreQuery && /affiliate|kich-ban-video|tam-the-nha-sang-tao|thu-nhap-thu-dong|xay-kenh/i.test(`${item.url || ''} ${normalize(item.title || '')}`)) {
      continue;
    }
    const score = tokenOverlapScore(qTokens, tokenizeMeaningful(`${item.title || ''} ${item.summary || ''}`));
    if (score > bestNewsScore) {
      bestNewsScore = score;
      bestNews = item;
    }
  }

  if (bestNews && bestNewsScore >= 0.38 && bestNewsScore >= topSnippetScore) {
    return `Bài hướng dẫn liên quan trên GAERU:\n- [${bestNews.title}](${bestNews.url})${bestNews.summary ? ` — ${bestNews.summary}` : ''}`;
  }

  if (snippets.length && topSnippetScore >= 0.42) {
    const deduped = [];
    const seen = new Set();
    for (const s of snippets) {
      const k = normalize(s.line);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      deduped.push(`- ${s.line}`);
      if (deduped.length >= 2) break;
    }
    if (deduped.length) return deduped.join('\n');
  }

  // 3. Active campaigns if matching user query
  const campaigns = Array.isArray(webKnowledge?.activeCampaigns) ? webKnowledge.activeCampaigns : [];
  for (const c of campaigns) {
    const score = tokenOverlapScore(qTokens, tokenizeMeaningful(`${c.title || ''} ${c.summary || ''}`));
    if (score >= 0.4) {
      return `**Chương trình hiện hành — ${c.title}:** ${c.summary}`;
    }
  }

  // 4. External curated ecosystem facts / live search snippets
  const ecoFacts = webKnowledge?.externalKnowledge?.ecosystemFacts || [];
  for (const f of ecoFacts) {
    const score = tokenOverlapScore(qTokens, tokenizeMeaningful(f));
    if (score > bestScore) {
      bestScore = score;
      bestFact = f;
    }
  }
  if (bestScore >= 0.45 && bestFact) return bestFact;

  const searchSnips = webKnowledge?.externalKnowledge?.searchSnippets || [];
  if (searchSnips.length) {
    return searchSnips[0];
  }

  return '';
}

function formatViPercent(num) {
  return `${String(Number(num || 0)).replace('.', ',')}%`;
}

async function lookupAuthenticatedCustomerData(pool, thread, space) {
  if (!pool || typeof pool.query !== 'function' || !thread?.customer_id) return null;
  const cid = thread.customer_id;
  const asksXu = hasAnyBoundaryTerm(space, ['gaeru xu', 'tich xu', 'doi xu', 'hoan xu', 'diem thuong', 'hang thanh vien']);
  const asksWarranty = hasAnyBoundaryTerm(space, ['bao hanh', 'kich hoat bao hanh', 'serial', 'phieu bao hanh', 'han bao hanh']);
  const asksCare = hasAnyBoundaryTerm(space, ['care+', 'care plus', 'gaeru care', 'yeu cau care', 'yeu cau ho tro', 'phieu ho tro', 'ho tro bao hanh', 'trang thai ho tro', 'khieu nai']) || /\bcare\+/i.test(space);

  const out = {};
  const tasks = [];

  if (asksXu) {
    tasks.push(
      pool.query('SELECT points_balance, lifetime_earned, tier FROM customer_loyalty WHERE customer_id = $1 LIMIT 1', [cid])
        .then(r => { if (r.rows?.[0]) out.loyalty = r.rows[0]; })
        .catch(() => {})
    );
  }
  if (asksWarranty) {
    tasks.push(
      pool.query(
        'SELECT serial, status, expires_on, channel, external_order_number, external_product_name, reason FROM warranty_activations WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 3',
        [cid]
      )
        .then(r => { if (r.rows?.length) out.warranties = r.rows; })
        .catch(() => {})
    );
  }
  if (asksCare) {
    tasks.push(
      pool.query(
        'SELECT subject, status, response, channel, external_order_number FROM care_requests WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 3',
        [cid]
      )
        .then(r => { if (r.rows?.length) out.careRequests = r.rows; })
        .catch(() => {})
    );
  }

  if (tasks.length) await Promise.all(tasks);
  return Object.keys(out).length ? out : null;
}

function getLoyaltyPolicyRangeText(webKnowledge) {
  const policy = webKnowledge?.loyaltyPolicy?.tiers?.length ? webKnowledge.loyaltyPolicy : DEFAULT_LOYALTY_POLICY;
  const rates = policy.tiers.map(t => Number(t.earnBasisPoints || 0) / 100);
  const minR = Math.min(...rates);
  const maxR = Math.max(...rates);
  return { policy, rangeText: minR === maxR ? formatViPercent(minR) : `${formatViPercent(minR)}–${formatViPercent(maxR)}` };
}

function buildLoyaltyAnswer({ webKnowledge, authData }) {
  const { policy, rangeText } = getLoyaltyPolicyRangeText(webKnowledge);
  const benefits = tierBenefits(policy);
  const tierSummary = ['bronze', 'silver', 'gold', 'platinum']
    .map(id => benefits[id])
    .filter(Boolean)
    .map(b => `${b.name.replace('Thành viên ', '')} (${String(b.earnRate).replace('.', ',')})`)
    .join(', ');

  const lines = [
    '**Chính sách GAERU Xu:**',
    '- Quy đổi: **1 GAERU Xu = 1 VNĐ**, dùng giảm tối đa **50%** giá trị đơn hàng (tuân thủ Nghị định 81/2018/NĐ-CP).',
    `- Tích **${rangeText}** giá trị đơn thành công theo hạng thành viên (${tierSummary}); là điểm thưởng nội bộ không quy đổi tiền mặt (Nghị định 52/2024/NĐ-CP).`
  ];

  if (authData?.loyalty) {
    const bal = Number(authData.loyalty.points_balance || 0);
    const tierInfo = benefits[authData.loyalty.tier] || benefits.bronze;
    const formattedBal = new Intl.NumberFormat('vi-VN').format(Math.round(bal));
    lines.push(`- **Tài khoản của bạn:** Đang ở **${tierInfo?.name || 'Thành viên Đồng'}** · Số dư hiện tại: **${formattedBal} GAERU Xu**.`);
  }

  return lines.join('\n');
}

function buildAuthenticatedWarrantyStatusLines(authData) {
  const statusMap = {
    pending: 'Chờ duyệt',
    active: 'Đang hiệu lực',
    rejected: 'Từ chối',
    revoked: 'Đã thu hồi',
    submitted: 'Đã tiếp nhận',
    reviewing: 'Đang kiểm tra',
    waiting_customer: 'Chờ khách phản hồi',
    resolved: 'Đã xử lý',
    closed: 'Đã đóng'
  };
  const lines = [];
  if (Array.isArray(authData?.warranties) && authData.warranties.length) {
    lines.push('**Phiếu bảo hành của tài khoản bạn:**');
    for (const w of authData.warranties) {
      const exp = w.expires_on ? ` · Hết hạn: ${new Date(w.expires_on).toLocaleDateString('vi-VN')}` : '';
      const serialTag = w.serial ? ` · Serial \`${w.serial}\`` : '';
      const label = `${w.external_product_name || 'Đơn hàng website'}${serialTag}`;
      lines.push(`- ${label} (${w.channel || 'website'}): **${statusMap[w.status] || w.status}**${exp}`);
    }
  }
  if (Array.isArray(authData?.careRequests) && authData.careRequests.length) {
    lines.push('**Yêu cầu GAERU Care+ gần đây của bạn:**');
    for (const c of authData.careRequests) {
      lines.push(`- ${c.subject}: **${statusMap[c.status] || c.status}**${c.response ? ` — ${c.response}` : ''}`);
    }
  }
  return lines.join('\n');
}

function buildShippingAnswer({ webKnowledge, space }) {
  const rates = webKnowledge?.shippingRates;
  const note = String(webKnowledge?.shippingNote || '').trim();
  const isHnOrHcm = hasAnyBoundaryTerm(space, ['ha noi', 'hn', 'tp hcm', 'tphcm', 'ho chi minh', 'sai gon', 'hcm']);
  const isRemote = hasAnyBoundaryTerm(space, ['huyen dao', 'vung sau', 'vung xa', 'phu quoc', 'con dao']);
  const etaText = isHnOrHcm
    ? 'dự kiến **1–2 ngày** làm việc (nội thành Hà Nội & TP.HCM)'
    : isRemote
      ? 'dự kiến **3–5 ngày** làm việc (khu vực huyện đảo / vùng sâu vùng xa)'
      : 'dự kiến **1–2 ngày** (nội thành HN/HCM), **2–4 ngày** (tỉnh/thành khác), **3–5 ngày** (vùng xa/huyện đảo)';
  const carriers = 'Viettel Post / SPX / J&T Express';
  const inspectNote = 'được **mở hộp đồng kiểm ngoại quan** trước khi thanh toán (không cắm thử)';

  if (rates && typeof rates === 'object' && Object.keys(rates).length > 0) {
    const matchedProvinceKey = Object.keys(rates).find(k => {
      const kNorm = normalizeSearchSpace(k);
      return kNorm && kNorm !== 'toan quoc' && hasBoundaryTerm(space, kNorm);
    });
    if (matchedProvinceKey) {
      const fee = shippingFee(rates, matchedProvinceKey);
      if (fee === 0) {
        return `**Vận chuyển & Giao hàng:**\n- Khu vực **${matchedProvinceKey}** hiện được **Freeship (Miễn phí vận chuyển 0 ₫)**, giao ${etaText} (${carriers}), ${inspectNote}.`;
      }
      if (Number.isFinite(fee)) {
        return `**Vận chuyển & Giao hàng:**\n- Phí ship tới **${matchedProvinceKey}** hiện là **${formatVnd(fee)}**, giao ${etaText} (${carriers}), ${inspectNote}.`;
      }
    }

    const nationwideFee = shippingFee(rates, 'Toàn quốc');
    if (nationwideFee === 0) {
      const shipLabel = note ? `**Freeship** — ${note}` : '**Freeship (Miễn phí vận chuyển toàn quốc 0 ₫)**';
      return `**Vận chuyển & Giao hàng:**\n- ${shipLabel}, giao ${etaText} (${carriers}), ${inspectNote}.`;
    }
    if (Number.isFinite(nationwideFee)) {
      const noteText = note ? ` (${note})` : '';
      return `**Vận chuyển & Giao hàng:**\n- Phí vận chuyển toàn quốc là **${formatVnd(nationwideFee)}**${noteText}, giao ${etaText} (${carriers}), ${inspectNote}.`;
    }
  }

  const rateNote = note ? ` (${note})` : '';
  return '**Vận chuyển & Giao hàng:**\n' +
    `- **Freeship** toàn quốc cho đơn từ **500.000 ₫**, giao ${etaText} (${carriers}), ${inspectNote}.${rateNote}`;
}

function buildCodInspectionAnswer() {
  return (
    '**Chính sách đồng kiểm khi nhận hàng GAERU:**\n' +
    '- Bạn **được quyền mở hộp kiểm tra ngoại quan** cùng nhân viên giao hàng trước khi thanh toán (đúng mẫu mã, số lượng, cổng cắm, phụ kiện đi kèm và tình trạng nguyên vẹn).\n' +
    '- **Không được cắm thử hoặc sử dụng thử** trong quá trình đồng kiểm. Nếu hàng bị vỡ hỏng, thiếu phụ kiện hoặc giao sai phân loại, bạn có quyền từ chối nhận ngay và không mất bất kỳ chi phí nào.\n' +
    '- Sau khi nhận hàng, sản phẩm vẫn được bảo vệ bằng chính sách **đổi mới 1:1 trong 7 ngày** (lỗi kỹ thuật NSX / giao sai, GAERU chịu 100% phí ship 2 chiều) và **bảo hành chính hãng 12 tháng**.'
  );
}

function buildReturnPolicyAnswer() {
  return (
    '**Chính sách Đổi trả & Hoàn tiền GAERU:**\n' +
    '- **Đổi mới 1:1 trong 7 ngày** kể từ khi ký nhận nếu sản phẩm có lỗi kỹ thuật từ nhà sản xuất (không lên nguồn, lỗi kết nối, lỗi sạc, rè phần cứng) hoặc giao sai mẫu mã/cổng kết nối — GAERU chịu **100% phí vận chuyển 2 chiều** (yêu cầu còn đủ hộp, phụ kiện, không va đập/ngấm nước).\n' +
    '- **Hoàn tiền 100%** (trong **3–5 ngày** làm việc về đúng tài khoản/phương thức đã thanh toán) nếu sản phẩm đủ điều kiện đổi mới nhưng hết hàng, đơn hủy hợp lệ trước khi giao hoặc trả hàng đúng quy định.\n' +
    '- Nếu bạn lỡ chọn nhầm chân cắm hoặc cần đổi phân loại phù hợp hơn, hãy nhắn **mã đơn hàng** hoặc liên hệ Hotline **082 919 1080** để đội ngũ GAERU hỗ trợ trực tiếp nhé.'
  );
}

function buildVatInvoiceAnswer() {
  return (
    'Hiện **GAERU không hỗ trợ xuất hóa đơn VAT điện tử (hóa đơn đỏ)**.\n' +
    '- Mọi đơn hàng đặt tại **gaeru.com** đều có **thông tin xác nhận đơn hàng** đầy đủ trên hệ thống và được **kích hoạt / tra cứu bảo hành điện tử** theo mã đơn hàng hoặc số điện thoại.'
  );
}

function buildContactAndStoreAnswer() {
  return (
    '**Thông tin liên hệ & kênh mua hàng GAERU:**\n' +
    '- **Hotline:** **082 919 1080** · **Email:** `business@gaeru.com`\n' +
    '- **Giờ làm việc:** Thứ 2 – Thứ 6: **10:00 – 17:00** · Thứ 7, Chủ nhật & ngày lễ: **10:00 – 16:00**\n' +
    '- **Mua hàng:** GAERU phục vụ đặt hàng trực tuyến tại **[gaeru.com](/shop)** và giao hàng toàn quốc (được mở hộp đồng kiểm ngoại quan trước khi thanh toán).\n' +
    '- **Trụ sở đăng ký kinh doanh:** Thôn 2, Xã Rạng Đông, Tỉnh Ninh Bình.'
  );
}

function buildBulkDiscountAnswer(webKnowledge) {
  const { rangeText } = getLoyaltyPolicyRangeText(webKnowledge);
  return (
    '**Ưu đãi khi mua số lượng nhiều / mua sỉ:**\n' +
    `- Đơn đặt tại **gaeru.com** được **Freeship** (theo chính sách hiện hành) và tích **${rangeText} GAERU Xu** theo hạng thành viên.\n` +
    '- Với nhu cầu đặt **nhiều bộ / mua sỉ / đặt cho công ty hoặc đội nhóm**, bạn nhắn rõ mẫu sản phẩm & số lượng dự kiến, hoặc bấm **Gặp nhân viên** / gọi Hotline **082 919 1080** để chuyên viên GAERU báo chiết khấu trực tiếp nhé!'
  );
}

function buildGenericGuidesAnswer() {
  return (
    '**Hướng dẫn sử dụng & xử lý lỗi thiết bị GAERU:**\n' +
    '- **GAERU K9** (Micro cài áo không dây): [Xem hướng dẫn GAERU K9](/huong-dan/gaeru-k9)\n' +
    '- **GAERU M3** (2 Micro + Hộp sạc 24h): [Xem hướng dẫn GAERU M3](/huong-dan/gaeru-m3)\n' +
    '- **GAERU G1 ULTRA** (Micro đa thiết bị + máy ảnh 3.5mm): [Xem hướng dẫn GAERU G1 ULTRA](/huong-dan/gaeru-g1-ultra)\n' +
    '- **GAERU P01** (Gimbal AI tự xoay 360°): [Xem hướng dẫn GAERU P01](/huong-dan/gaeru-p01)\n' +
    '- **GAERU P185** (Gậy selfie tripod 4 chân + remote Bluetooth): [Xem hướng dẫn GAERU P185](/huong-dan/gaeru-p185)\n' +
    'Bạn đang dùng mẫu nào và thiết bị gì (iPhone / Android / Laptop) để mình hướng dẫn từng bước ngay nhé?'
  );
}

function buildMetaComplaintAnswer(primaryProd) {
  const prodHint = primaryProd?.product?.name || PRODUCT_SPECS[primaryProd?.key]?.name || '';
  const scopeText = prodHint
    ? `về **${prodHint}** (như **hướng dẫn sử dụng**, **giá & phân loại**, **tương thích điện thoại**, hay **xử lý lỗi kết nối**)`
    : 'như **tên sản phẩm (K9, M3, G1 ULTRA, P01, P185)**, **hướng dẫn kết nối**, **chính sách đổi trả/bảo hành** hay **mã đơn hàng**';
  return (
    `Xin lỗi bạn vì phản hồi trước chưa đúng ý hoặc bị trùng lặp ạ! Bạn nhắn rõ điều bạn cần hỗ trợ ${scopeText} để mình trả lời chính xác ngay — hoặc bấm **Gặp nhân viên** / gọi Hotline **082 919 1080** để được hỗ trợ trực tiếp nhé.`
  );
}

function applyAntiRepeatGuard(result, rawQuestion, history = [], primaryProd = null) {
  if (!result || result.handoff || result.orderLookup || !result.answer || !Array.isArray(history) || !history.length) {
    return result;
  }
  const prevAi = [...history].reverse().find(m => m && (m.sender === 'ai' || m.sender === 'admin'));
  if (!prevAi) return result;
  const prevAiNorm = normalize(prevAi.body || prevAi.content || '');
  const currAnsNorm = normalize(result.answer);
  if (!prevAiNorm || prevAiNorm !== currAnsNorm) return result;

  // Check if customer sent a different question than their last turn
  const prevCustomers = history.filter(m => m && m.sender === 'customer');
  const prevCustText = prevCustomers.length >= 2
    ? prevCustomers[prevCustomers.length - 2]?.body
    : prevCustomers[prevCustomers.length - 1]?.body;
  const sameQuestion = prevCustText && normalize(prevCustText) === normalize(rawQuestion);
  if (sameQuestion) return result;

  const prodName = primaryProd?.product?.name || PRODUCT_SPECS[primaryProd?.key]?.name || '';
  return {
    ...result,
    answer:
      `Mình thấy nội dung này khá giống câu trả lời trước${prodName ? ` về **${prodName}**` : ''}. ` +
      'Để tránh lặp lại thông tin cũ, bạn nói rõ thêm chi tiết bạn đang vướng (ví dụ: *tên dòng điện thoại đang dùng*, *bước thao tác đang gặp lỗi*, hoặc *cần gặp nhân viên*) để mình hỗ trợ trúng ý hơn nhé!'
  };
}

function buildMarketplaceAnswer({ primaryProd, catalog = [] }) {
  const poolList = primaryProd?.product ? [primaryProd.product] : (catalog || []);
  const lines = [];
  for (const p of poolList) {
    if (!p || (!p.shopeeUrl && !p.tiktokShopUrl)) continue;
    const links = [];
    if (p.shopeeUrl) links.push(`[Shopee chính hãng — ${p.name}](${p.shopeeUrl})`);
    if (p.tiktokShopUrl) links.push(`[TikTok Shop — ${p.name}](${p.tiktokShopUrl})`);
    lines.push(`- **${p.name}:** ${links.join(' · ')}`);
  }
  if (!lines.length) {
    return 'GAERU hiện phân phối chính hãng trực tiếp tại **gaeru.com** (hỗ trợ đồng kiểm, áp voucher và tích **GAERU Xu**) cùng các gian hàng chính thức trên **Shopee** và **TikTok Shop**. Bạn chọn mẫu sản phẩm cụ thể để mình gửi đúng link hoặc đặt nhanh ngay tại web nhé!';
  }
  return `**Gian hàng chính hãng GAERU (Shopee & TikTok Shop):**\n${lines.slice(0, 5).join('\n')}\n- Đặt trực tiếp tại **gaeru.com** sẽ được tích thêm **GAERU Xu**, áp voucher tại web và hỗ trợ kích hoạt bảo hành nhanh theo đơn hàng.`;
}

function buildBundlesAnswer({ webKnowledge, primaryProd }) {
  const bundles = Array.isArray(webKnowledge?.activeBundles) ? webKnowledge.activeBundles : [];
  const relevant = primaryProd?.key
    ? bundles.filter(b => Array.isArray(b.items) && b.items.some(it => String(it.productSlug || '').toLowerCase() === primaryProd.key))
    : bundles;
  const list = relevant.length ? relevant : bundles;
  if (!list.length) {
    return 'Hiện hệ thống chưa có gói combo mua kèm mới được bật; bạn có thể kiểm tra **mã giảm giá (voucher)** đang mở hoặc đặt trực tiếp trên **gaeru.com** để được **Freeship** và tích **GAERU Xu** nhé.';
  }
  const rows = list.slice(0, 3).map(b => {
    const itemNames = (b.items || []).map(i => i.productName).filter(Boolean).join(' + ');
    return `- **${b.title}** (**${formatBundleDiscountText(b)}**)${itemNames ? `: gồm ${itemNames}` : ''}`;
  });
  return `**Gói Combo mua kèm đang áp dụng:**\n${rows.join('\n')}`;
}

/**
 * Phân tích và sinh câu trả lời thông minh, chính xác, không lan man từ GAERU AI.
 */
async function generateGaeruAiResponse({ pool, thread, question, catalog = [], history = [], webKnowledge = null }) {
  const raw = String(question || '').trim();
  const effectiveRaw = resolveContextualFollowUp(raw, history);
  const expanded = expandQueryVi(effectiveRaw);
  const space = normalizeSearchSpace(expanded);
  const detailed = isExplicitDetailedRequest(space);

  // 1. Yêu cầu gặp nhân viên / người thật (có kiểm tra phủ định "không cần nhân viên")
  const explicitHuman = /(?:gap|chuyen|ket noi|noi chuyen|lien he|goi).{0,35}(?:nhan vien|nguoi that|tu van vien)|(?:human|live agent)|khong muon.{0,12}(?:ai|bot)/i.test(expanded) &&
    !/khong (?:can|muon) (?:gap |noi chuyen voi )?(?:nhan vien|nguoi that)/i.test(expanded) &&
    !isTermNegated(space, 'nhan vien');

  if (explicitHuman) {
    return {
      handoff: true,
      answer: 'Dạ GAERU AI đang chuyển bạn tới chuyên viên tư vấn GAERU. Nếu cần gấp, bạn có thể gọi Hotline **082 919 1080** (T2–T6: 10:00–17:00 · T7–CN & lễ: 10:00–16:00) nhé!'
    };
  }

  // Phân giải sản phẩm liên quan sớm để phục vụ cả phản hồi lỗi & định tuyến chính xác
  const mentioned = resolveMentionedProducts(effectiveRaw, catalog, { thread, history });
  const primaryProd = mentioned.items[0] ? { ...mentioned.items[0], source: mentioned.source } : null;

  // 1b. Khiếu nại chất lượng trả lời của bot (lặp lại, trả lời sai, không đúng ý) -> xin lỗi & định hướng rõ
  const isMetaComplaint = hasAnyBoundaryTerm(space, [
    'lap lai', 'tra loi lap', 'tra loi sai', 'noi lap', 'sai roi', 'khong dung y',
    'tra loi linh tinh', 'tra loi vo nghia', 'bot ngu', 'ai ngu', 'khong hieu gi'
  ]) || (/sao.*lap/.test(space) && !hasAnyBoundaryTerm(space, ['lap dat', 'lap dien thoai', 'lap mic', 'lap tripod']));
  if (isMetaComplaint) {
    return {
      handoff: false,
      answer: buildMetaComplaintAnswer(primaryProd)
    };
  }

  // 2. Tra cứu đơn hàng thời gian thực (GR-... / GAE-... / SĐT / tài khoản đang đăng nhập) với bảo mật Zero-Trust
  const orderLookup = await lookupOrderInfo(pool, raw, thread);
  if (orderLookup && orderLookup.searched) {
    return formatOrderLookupReply(orderLookup, space);
  }
  const asksOwnOrderWithoutIdentifier = !thread?.customer_id && isAskingOwnOrder(space);
  if (asksOwnOrderWithoutIdentifier) {
    return {
      handoff: false,
      answer: 'Để kiểm tra đúng đơn hàng của bạn, vui lòng **đăng nhập tài khoản** đã đặt hoặc nhắn chính xác **Mã đơn hàng (dạng GR-... / GAE-...)** để mình tra cứu trạng thái & mã vận đơn ngay nhé.'
    };
  }

  const buyIntent = detectPurchaseClosingIntent(effectiveRaw, space);

  const asksXu = hasAnyBoundaryTerm(space, ['gaeru xu', 'tich xu', 'doi xu', 'hoan xu', 'diem thuong', 'hang thanh vien']) || /(?:^|[^\p{L}])xu(?:$|[^\p{L}])/iu.test(raw);
  const asksVatInvoice = hasAnyBoundaryTerm(space, ['hoa don vat', 'hoa don do', 'hoa don dien tu', 'xuat hoa don', 'xuat vat', 'ma so thue', 'mst', 'gtgt']) ||
    (hasBoundaryTerm(space, 'vat') && hasAnyBoundaryTerm(space, ['hoa don', 'xuat', 'cong ty', 'doanh nghiep', 'co']));
  const asksContactOrStore = hasAnyBoundaryTerm(space, [
    'hotline', 'so dien thoai shop', 'so dien thoai cua shop', 'sdt shop', 'so hotline',
    'shop o dau', 'cua hang o dau', 'dia chi shop', 'dia chi cua hang', 'mua truc tiep',
    'den cua hang', 'showroom', 'chi nhanh', 'gio lam viec', 'lien he shop', 'email shop'
  ]) || (hasAnyBoundaryTerm(space, ['so dien thoai', 'lien he']) && hasAnyBoundaryTerm(space, ['hotline', 'shop', 'gaeru', 'tu van', 'tong dai', 'la gi']));
  const asksCodInspection = hasAnyBoundaryTerm(space, [
    'dong kiem', 'kiem tra hang', 'mo ra test', 'test thu', 'cam thu', 'xem hang truoc',
    'mo hop kiem tra', 'boc hang', 'thu truoc khi', 'kiem hang truoc', 'mo ra xem'
  ]);
  const asksReturnPolicy = hasAnyBoundaryTerm(space, [
    'doi tra', 'tra hang', 'hoan tien', 'mua ve khong hop', 'khong hop co doi', 'khong ung co doi', 'tra lai hang'
  ]);
  const asksWarrantyOrCare = hasAnyBoundaryTerm(space, [
    'bao hanh', '1 doi 1', 'care+', 'care plus', 'kich hoat bao hanh', 'bi loi', 'sua chua',
    'yeu cau ho tro', 'phieu ho tro', 'khieu nai'
  ]);
  const asksShip = hasAnyBoundaryTerm(space, ['giao hang', 'van chuyen', 'phi ship', 'ship', 'freeship', 'mien phi van chuyen', 'bao lau nhan']) ||
    (/may ngay/.test(space) && hasAnyBoundaryTerm(space, ['nhan', 'giao', 'toi', 'ship', 'hang', 'tinh', 'ha noi', 'hcm', 'sai gon']));
  const asksPay = hasAnyBoundaryTerm(space, ['thanh toan', 'cod', 'vietqr', 'vnpay', 'momo', 'zalopay', 'chuyen khoan']) && !asksCodInspection;
  const asksBulkOrder = /\b(?:mua|dat|lay)\s*(?:tu\s*)?(?:[3-9]|[1-9]\d+)\s*(?:bo|cai|chiec|mic|san pham|sp)\b/.test(space) ||
    hasAnyBoundaryTerm(space, ['mua si', 'gia si', 'so luong nhieu', 'so luong lon', 'dai ly', 'chiet khau si']);
  const asksVoucher = !asksBulkOrder && hasAnyBoundaryTerm(space, ['ma giam gia', 'voucher', 'coupon', 'khuyen mai', 'uu dai', 'code giam', 'giam gia']);
  const asksMarketplace = hasAnyBoundaryTerm(space, ['shopee', 'tiktok shop', 'tiktokshop', 'san thuong mai', 'lazada', 'link shopee', 'link tiktok', 'gian hang']);
  const asksBundles = hasAnyBoundaryTerm(space, ['combo', 'mua kem', 'tron bo', 'bo combo', 'goi combo']);
  const asksArticle = hasAnyBoundaryTerm(space, ['bai viet', 'tin tuc', 'blog', 'bai huong dan', 'doc bai']);
  const asksGlobalStock = !primaryProd && hasAnyBoundaryTerm(space, ['ton kho', 'con hang', 'san hang', 'het hang', 'kiem tra kho']);
  const asksWaterproofGlobal = !primaryProd && hasAnyBoundaryTerm(space, ['chong nuoc', 'di mua', 'nuoc mua', 'ngam nuoc', 'khang nuoc', 'chuan ip']);
  const asksGenericGuide = !primaryProd && hasAnyBoundaryTerm(space, ['huong dan su dung', 'huong dan dung', 'cach su dung']) ||
    (!primaryProd && /^(?:huong dan|cach dung|su dung)$/.test(space));

  // Xác định câu hỏi có yêu cầu tra cứu dữ liệu động (giá/kho/chính sách/vận chuyển/voucher/chốt đơn) không
  const isDynamicPolicyOrCommerce = hasAnyBoundaryTerm(space, [
    'gia', 'gia ban', 'bao nhieu tien', 'may tien', 'con hang', 'het hang', 'ton kho'
  ]) || asksXu || asksVatInvoice || asksContactOrStore || asksCodInspection || asksReturnPolicy ||
    asksWarrantyOrCare || asksShip || asksPay || asksBulkOrder || asksVoucher || asksMarketplace ||
    asksBundles || buyIntent.isClosing ||
    /(?:gia|tien|phi|giam).{0,12}bao nhieu|bao nhieu\s+(?:tien|nghin|ngan|dong|k\b|xu\b)/.test(space);

  // 3. Tri thức tự học đặc thù (chỉ ưu tiên trước khi KHÔNG phải câu hỏi giá/tồn kho/đơn/chính sách/chốt đơn)
  if (!isDynamicPolicyOrCommerce) {
    try {
      const learnedMatch = await matchLearnedKnowledge(pool, effectiveRaw, { minScore: 0.65 });
      if (learnedMatch && learnedMatch.entry) {
        const e = learnedMatch.entry;
        return applyAntiRepeatGuard({
          handoff: false,
          answer: e.learned_facts || e.sample_answer,
          learnedKnowledge: {
            id: e.id,
            topic: e.topic,
            confidence: e.confidence_score
          }
        }, raw, history, primaryProd);
      }
    } catch (_) {}
  }

  const asksUseCase = hasAnyBoundaryTerm(space, ['ngoai troi', 'ngoai canh', 'livestream', 'ban hang', 'day hoc', 'hop online', 'podcast', 'phong thu', 'phong van', '2 nguoi', 'hai nguoi', 'cap doi', 'vlog', 'tu quay', 'mot minh', 'quay video', 'thiet bi livestream']);
  let liveWeb = webKnowledge;
  if (!liveWeb && pool && typeof pool.query === 'function' && (isDynamicPolicyOrCommerce || primaryProd || asksUseCase)) {
    try {
      liveWeb = await loadLiveSiteFacts(pool);
    } catch (_) {}
  }

  const authData = thread?.customer_id && pool && (asksXu || asksWarrantyOrCare)
    ? await lookupAuthenticatedCustomerData(pool, thread, space)
    : null;

  // Thu thập các phần trả lời trực tiếp cho từng ý được hỏi (hỗ trợ câu hỏi đa ý)
  const sections = [];

  // 4. So sánh nội bộ phiên bản cùng 1 sản phẩm (VD: K9 1 mic vs 2 mic, P01 để bàn vs chân 2m1) TRƯỚC khi so sánh chéo
  const isInternalK9VariantCompare = primaryProd?.key === 'gaeru-k9' && mentioned.items.length === 1 &&
    hasAnyBoundaryTerm(space, ['1 mic', 'mot mic', '1 micro']) && hasAnyBoundaryTerm(space, ['2 mic', 'hai mic', '2 micro']);
  const isInternalP01VariantCompare = primaryProd?.key === 'gaeru-p01' && mentioned.items.length === 1 &&
    hasAnyBoundaryTerm(space, ['de ban']) && hasAnyBoundaryTerm(space, ['2m1', 'chan dung', 'chan 2m']);

  // So sánh chéo các dòng sản phẩm GAERU (không nhầm so sánh hệ điều hành / iOS / cổng kết nối thành so sánh sản phẩm)
  const isDeviceOrOsComparison = hasAnyBoundaryTerm(space, [
    'ios', 'otg', 'go loi usb', 'nha phat trien', 'mic ngoai', 'mic gan ngoai',
    'dau vao am thanh', 'trung tam dieu khien', 'type c', 'lightning', 'micro usb', 'usb a'
  ]) && mentioned.items.length < 2;
  const wantsCompare = !isInternalK9VariantCompare && !isInternalP01VariantCompare && !isDeviceOrOsComparison && (
    mentioned.items.length >= 2 ||
    hasAnyBoundaryTerm(space, ['nen mua loai nao', 'nen mua mau nao', 'chon loai nao']) ||
    (hasAnyBoundaryTerm(space, ['so sanh', 'khac nhau', 'khac gi', 'chon cai nao', 'giua']) &&
      ((mentioned.source === 'question' && mentioned.items.length >= 1) ||
        hasAnyBoundaryTerm(space, ['k9', 'm3', 'p01', 'p185', 'g1', 'cac dong', 'cac mau', 'hai mau', '2 mau', 'hai loai', '2 loai', 'mic nay', 'san pham'])))
  );

  if (isInternalK9VariantCompare || isInternalP01VariantCompare) {
    const internalCmp = buildInternalVariantComparisonAnswer(primaryProd.key, primaryProd.product, space);
    if (internalCmp) sections.push(internalCmp);
  } else if (wantsCompare) {
    const cmp = buildComparisonAnswer(mentioned.items, space, catalog);
    if (cmp) sections.push(cmp);
  } else if (primaryProd) {
    // 5. Trả lời đúng trọng tâm cho sản phẩm đang hỏi (chỉ trả lời khía cạnh được hỏi, không spam brochure)
    const isSpecificOrBroadProduct = hasAnyBoundaryTerm(space, [
      'gia', 'gia ban', 'bao nhieu', 'may tien', 'con hang', 'het hang', 'ton kho', 'con khong',
      'pin', 'thoi luong', 'bao lau', 'may gio', 'may tieng', 'hop sac', 'sac',
      'khoang cach', 'bao xa', 'may met', 'tam thu', 'cu ly', 'bat song',
      'loc am', 'loc on', 'chong on', 'khu on', 'tieng on', 'tap am', 'anc', 'dsp', 'am thanh',
      'trong luong', 'kich thuoc', 'chieu cao', 'chieu dai', 'keo dai', 'nang bao nhieu', 'dai bao nhieu', 'bao nhieu cm', 'mah',
      'phu kien', 'trong hop', 'goi gom', 'bao gom', 'co nhung gi', 'gom gi', 'di kem',
      'thong so', 'chi tiet', 'phan loai', '1 mic', '2 mic', 'la gi', 'de lam gi', 'tu van', 'gioi thieu', 'review', 'the nao', 'ra sao',
      'huong dan', 'cach dung', 'su dung', 'thiet lap', 'den bao', 'nhap nhay', 'cach bat', 'bat che do', 'chuyen che do', 'nut loc on',
      'remote', 'bluetooth', 'chong nuoc', 'di mua', 'nuoc mua', 'ngam nuoc',
      'chon phien ban', 'chon ban nao', 'tu van chon', 'phien ban phu hop', 'nen chon ban nao',
      ...DEVICE_COMPAT_TERMS
    ]) || buyIntent.isClosing || mentioned.source === 'question';

    if (isSpecificOrBroadProduct) {
      const prodAns = buildProductSpecificAnswer({ prodEntry: primaryProd, question: effectiveRaw, space, detailed, history, catalog, buyIntent, webKnowledge: liveWeb });
      if (prodAns) sections.push(prodAns);
    }
  } else {
    // 6. Tương thích thiết bị / xử lý lỗi chung (không gắn 1 model cụ thể)
    const compat = buildDeviceCompatibilityAnswer(space, effectiveRaw, null);
    if (compat) sections.push(compat);
  }

  // 7. Chính sách: VAT / Liên hệ & Cửa hàng / Đồng kiểm / Đổi trả / GAERU Xu / Bảo hành / Vận chuyển / Thanh toán / Mua sỉ / Voucher / Combo / Sàn TMĐT
  if (asksVatInvoice) {
    sections.push(buildVatInvoiceAnswer());
  }

  if (asksContactOrStore) {
    sections.push(buildContactAndStoreAnswer());
  }

  if (asksCodInspection) {
    sections.push(buildCodInspectionAnswer());
  }

  if (asksReturnPolicy) {
    sections.push(buildReturnPolicyAnswer());
  }

  if (asksWaterproofGlobal) {
    sections.push(buildWaterproofAnswer());
  }

  if (asksGenericGuide && sections.length === 0) {
    sections.push(buildGenericGuidesAnswer());
  }

  if (asksXu) {
    sections.push(buildLoyaltyAnswer({ webKnowledge: liveWeb, authData }));
  }

  if (asksWarrantyOrCare) {
    const authCareText = buildAuthenticatedWarrantyStatusLines(authData);
    sections.push(
      '**Chính sách Bảo hành & GAERU Care+:**\n' +
      '- Bảo hành chính hãng **12 tháng** đối với lỗi sản xuất; **1 đổi 1 trong 7 ngày** đầu nếu phát sinh lỗi kỹ thuật từ nhà sản xuất hoặc giao sai phân loại (GAERU chịu 100% phí vận chuyển 2 chiều).\n' +
      '- Tra cứu/kích hoạt bảo hành bằng SĐT tại [/ho-tro](/ho-tro) hoặc gửi yêu cầu hỗ trợ trực tiếp tại [GAERU Care+](/care) (chuẩn bị mã đơn, tên sản phẩm và mô tả lỗi).' +
      (authCareText ? `\n\n${authCareText}` : '')
    );
  }

  if (asksShip) {
    sections.push(buildShippingAnswer({ webKnowledge: liveWeb, space }));
  }

  if (asksPay) {
    sections.push(
      '**Phương thức thanh toán:** COD (tiền mặt khi nhận sau khi đồng kiểm ngoại quan), VietQR (xác nhận tự động), VNPAY, MoMo và ZaloPay.'
    );
  }

  if (asksBulkOrder) {
    sections.push(buildBulkDiscountAnswer(liveWeb));
  }

  if (asksMarketplace) {
    sections.push(buildMarketplaceAnswer({ primaryProd, catalog }));
  }

  if (asksBundles) {
    sections.push(buildBundlesAnswer({ webKnowledge: liveWeb, primaryProd }));
  }

  if (asksArticle && Array.isArray(liveWeb?.latestNews) && liveWeb.latestNews.length) {
    const newsAns = findWebKnowledgeAnswer(effectiveRaw, { latestNews: liveWeb.latestNews }, catalog);
    if (newsAns) sections.push(newsAns);
  }

  if (asksGlobalStock && Array.isArray(catalog) && catalog.length) {
    const stockRows = catalog.slice(0, 6).map(p => {
      const spec = PRODUCT_SPECS[p.slug];
      const priceStr = getPriceSummaryFromProduct(p, spec);
      const variants = Array.isArray(p.variants) ? p.variants.filter(v => v && v.active !== false) : [];
      const inStockCount = variants.filter(v => v.stockQuantity === undefined || Number(v.stockQuantity) > 0).length;
      const badge = !variants.length
        ? 'Sẵn hàng'
        : inStockCount > 0
          ? `**Còn hàng** (${inStockCount}/${variants.length} phân loại)`
          : '**Tạm hết hàng**';
      return `- **${p.name}** (${priceStr}): ${badge}`;
    }).join('\n');
    sections.push(`**Tình trạng tồn kho hiện tại:**\n${stockRows}`);
  }

  if (asksVoucher) {
    let activeVouchers = Array.isArray(liveWeb?.activeVouchers) ? liveWeb.activeVouchers : [];
    if (!activeVouchers.length && pool && typeof pool.query === 'function') {
      try {
        const vRes = await pool.query(`
          SELECT v.code, v.title, v.kind, v.amount, v.min_spend_vnd
          FROM marketing_vouchers v
          WHERE v.active = true
            AND v.public_claim = true
            AND NOW() BETWEEN v.starts_at AND v.ends_at
            AND (
              SELECT count(*)
              FROM voucher_redemptions r
              WHERE r.voucher_id = v.id AND r.released = false
            ) < v.total_limit
          ORDER BY v.created_at DESC, v.id
          LIMIT 5
        `);
        activeVouchers = vRes.rows || [];
      } catch (_) {}
    }

    if (activeVouchers.length > 0) {
      const voucherLines = activeVouchers.map(v => {
        const disc = v.discount || (v.kind === 'percent' ? `Giảm ${v.amount}%` : `Giảm ${formatVnd(v.amount)}`);
        const minSpend = (v.min_spend_vnd || v.minSpendVnd) > 0 ? ` (đơn từ ${formatVnd(v.min_spend_vnd || v.minSpendVnd)})` : '';
        return `- Mã \`${v.code}\`: **${disc}**${minSpend}${v.title ? ` — ${v.title}` : ''}`;
      }).join('\n');
      sections.push(`**Mã giảm giá đang áp dụng:**\n${voucherLines}`);
    } else {
      const { rangeText } = getLoyaltyPolicyRangeText(liveWeb);
      const nationwideFee = liveWeb?.shippingRates ? shippingFee(liveWeb.shippingRates, 'Toàn quốc') : undefined;
      const shipSentence = nationwideFee === 0
        ? 'vẫn đang **Freeship** toàn quốc'
        : 'đơn từ **500.000 ₫** vẫn được **Freeship** toàn quốc';
      sections.push(`Hiện chưa có mã voucher công khai mới, nhưng ${shipSentence} và tích **${rangeText} GAERU Xu**.`);
    }
  }

  // Nếu đã có câu trả lời trực tiếp cho câu hỏi (1 hoặc nhiều ý) -> trả gọn luôn (kèm chống lặp)
  if (sections.length > 0) {
    return applyAntiRepeatGuard({ handoff: false, answer: sections.join('\n\n') }, raw, history, primaryProd);
  }

  // 8. Báo giá chung hoặc đề xuất mua / chọn phiên bản phù hợp khi chưa chỉ định mẫu cụ thể
  const asksVersionSelection = hasAnyBoundaryTerm(space, ['chon phien ban', 'chon ban nao', 'tu van chon', 'phien ban phu hop', 'nen chon ban nao', 'phien ban nao']) && !primaryProd;
  if ((hasAnyBoundaryTerm(space, ['bang gia', 'gia', 'bao nhieu', 'cac mau', 'san pham nao', 'co nhung gi', 'ban gi']) || buyIntent.isClosing || asksVersionSelection) && !primaryProd) {
    const listSource = catalog.length ? catalog.slice(0, 6) : Object.entries(PRODUCT_SPECS).map(([slug, s]) => ({ slug, name: s.name, descriptor: s.role, variants: [] }));
    const inStockItems = listSource.filter(p => !Array.isArray(p.variants) || !p.variants.length || p.variants.some(v => v.stockQuantity === undefined || Number(v.stockQuantity) > 0));
    const displayList = (buyIntent.isDirectClose || asksVersionSelection) && inStockItems.length ? inStockItems : listSource;
    const lines = displayList.map(p => {
      const spec = PRODUCT_SPECS[p.slug];
      const priceStr = getPriceSummaryFromProduct(p, spec);
      const shortTag = p.descriptor || spec?.role?.split('.')[0] || '';
      const hasStock = !Array.isArray(p.variants) || !p.variants.length || p.variants.some(v => v.stockQuantity === undefined || Number(v.stockQuantity) > 0);
      if (buyIntent.isClosing && hasStock && p.slug) {
        return `- **${p.name}** (${priceStr})${shortTag ? `: ${shortTag}` : ''}\n  👉 [Chọn phân loại & Mua ngay ${p.name}](/san-pham/${encodeURIComponent(p.slug)})`;
      }
      return `- **${p.name}** (${priceStr})${shortTag ? `: ${shortTag}` : ''}`;
    }).join('\n');
    const portGuide = asksVersionSelection
      ? '\n- **Chọn đúng chân cắm:** iPhone 15–18 / Android mới / MacBook chọn **Type-C**; iPhone 14 trở xuống chọn **Lightning**; Laptop/PC cổng chữ nhật chọn **Type C + chuyển USB**; Android đời cũ chọn **Micro-USB**.\nBạn đang dùng thiết bị nào (điện thoại / iPad / Laptop / PC) và nhu cầu **1 mic hay 2 mic** để mình chốt đúng phiên bản nhé?'
      : '\nBạn đang dùng thiết bị nào (điện thoại / iPad / Laptop / PC) để mình chọn đúng chân cắm nhé?';
    return {
      handoff: false,
      answer: `**${buyIntent.isClosing ? 'Các thiết bị GAERU sẵn hàng để bạn đặt mua ngay:' : asksVersionSelection ? 'Hướng dẫn chọn dòng sản phẩm & phiên bản GAERU phù hợp:' : 'Bảng giá các thiết bị GAERU hiện có:'}**\n${lines}${portGuide}`
    };
  }

  // 9. Tư vấn theo nhu cầu sử dụng (Quay ngoài trời, Livestream, Dạy học, Podcast, Tự quay, 2 người)
  if (asksUseCase) {
    const pick = (slug, fallbackName) => {
      const p = catalog.find(item => item.slug === slug);
      const spec = PRODUCT_SPECS[slug];
      return `${p?.name || fallbackName} (${getPriceSummaryFromProduct(p, spec)})`;
    };
    let guideHint = '';
    if (Array.isArray(liveWeb?.latestNews) && liveWeb.latestNews.length) {
      const qToks = tokenizeMeaningful(effectiveRaw);
      let topArticle = null;
      let topScore = 0;
      const newsList = liveWeb.latestNews.slice(0, 80);
      let qVec = null;
      let newsVecs = null;
      if (pool && isGpuAiEnabled()) {
        try {
          const items = newsList.map((n, idx) => ({
            key: String(n.url || '').replace(/^\/tin-tuc\//, '') || `news_${idx}`,
            text: `${n.title || ''}. ${n.summary || ''}`.trim()
          }));
          const [qv, vm] = await Promise.all([
            embedText(effectiveRaw),
            ensureEmbeddings(pool, 'news', items)
          ]);
          qVec = qv;
          newsVecs = vm;
        } catch (_) {}
      }
      for (let i = 0; i < newsList.length; i++) {
        const n = newsList[i];
        const lex = tokenOverlapScore(qToks, tokenizeMeaningful(`${n.title || ''} ${n.summary || ''}`));
        let sem = 0;
        if (qVec && newsVecs) {
          const k = String(n.url || '').replace(/^\/tin-tuc\//, '') || `news_${i}`;
          const v = newsVecs.get(k);
          if (v) sem = Math.max(0, cosineSimilarity(qVec, v));
        }
        const combined = sem >= 0.30 ? Math.max(lex, lex * 0.45 + sem * 0.85) : lex;
        if (combined > topScore) { topScore = combined; topArticle = n; }
      }
      if (topArticle && topScore >= 0.36) {
        guideHint = `\n- 📖 Xem thêm hướng dẫn: [${topArticle.title}](${topArticle.url})`;
      }
    }
    return {
      handoff: false,
      answer:
        `Gợi ý nhanh từ **GAERU AI** theo nhu cầu của bạn:\n` +
        `- **Livestream / quay nhiều giờ:** ${pick('gaeru-m3', 'GAERU M3')} (2 mic + hộp sạc tới 24h, giảm ồn AI).\n` +
        `- **Vlog cơ bản / dạy học tiết kiệm:** ${pick('gaeru-k9', 'GAERU K9')} (bản 1 hoặc 2 mic, không cần Bluetooth, lọc ồn DSP).\n` +
        `- **Quay đa thiết bị (máy ảnh + điện thoại + PC):** ${pick('gaeru-g1-ultra', 'GAERU G1 ULTRA')}.\n` +
        `- **Tự quay rảnh tay cần máy xoay theo:** Gimbal AI ${pick('gaeru-p01', 'GAERU P01')}.` +
        guideHint
    };
  }

  // 10. Ưu tiên tri thức quản trị viên đã duyệt (approvedSources) -> P2 Semantic FAQ GPU AI -> webKnowledge dài đuôi
  const isShortSocial = hasAnyBoundaryTerm(space, ['cam on', 'thank', 'ok', 'oke', 'xin chao', 'hello', 'hi', 'alo', 'vay sao', 'the a', 'vay a']);
  if (webKnowledge?.externalKnowledge?.approvedSources?.length) {
    const preApprovedAns = findWebKnowledgeAnswer(effectiveRaw, { externalKnowledge: { approvedSources: webKnowledge.externalKnowledge.approvedSources } }, catalog);
    if (preApprovedAns) {
      return applyAntiRepeatGuard({ handoff: false, answer: preApprovedAns }, raw, history, primaryProd);
    }
  }

  // 10a. P2 Semantic FAQ Rescue qua gaeru-gpu-ai v2 (~40ms, ưu tiên trước đoạn trích HTML rời rạc)
  if (!isShortSocial) {
    try {
      const semFaq = await matchCustomerSemanticFaq(pool, effectiveRaw, { matchedProdKey: primaryProd?.key || null });
      if (semFaq && semFaq.answer) {
        return applyAntiRepeatGuard({ handoff: false, answer: semFaq.answer, semanticFaq: semFaq.key }, raw, history, primaryProd);
      }
    } catch (_) {}
  }

  let resolvedWeb = webKnowledge;
  if (!resolvedWeb && !isShortSocial) {
    try {
      resolvedWeb = await getRelevantWebKnowledge(pool, { question: effectiveRaw, selectedProduct: primaryProd?.product || null });
    } catch (_) {}
  }
  const webAns = findWebKnowledgeAnswer(effectiveRaw, resolvedWeb, catalog);
  if (webAns) {
    return applyAntiRepeatGuard({ handoff: false, answer: webAns }, raw, history, primaryProd);
  }

  // 11. Cảm ơn / phản ứng hội thoại ngắn / chào hỏi ngắn gọn — KHÔNG bắt nhầm từ đơn "rồi" trong câu phàn nàn
  const hasNegativeOrProblemWord = hasAnyBoundaryTerm(space, ['sai', 'lap', 'loi', 'hong', 'hu', 'khong dung', 'khong duoc', 'khong nhan', 'chan', 'te', 'mat', 'cham']);
  const isPoliteThanks = !hasNegativeOrProblemWord && (
    hasAnyBoundaryTerm(space, ['cam on', 'thank', 'hieu roi', 'duoc roi', 'ro roi']) ||
    /^(?:da|vang|ok|oke|okie|cam on(?: shop| ad| ban)?|tks|thanks?)$/.test(space)
  );
  if (isPoliteThanks) {
    return {
      handoff: false,
      answer: 'Dạ không có gì ạ! Khi nào cần kiểm tra thêm sản phẩm hoặc đơn hàng, bạn cứ nhắn **GAERU AI** nhé.'
    };
  }

  if (/^(?:vay sao|the a|vay a|that khong|that sao|ua vay a|o vay a|u|uh|um)$/.test(space)) {
    const prodHint = primaryProd?.product?.name || PRODUCT_SPECS[primaryProd?.key]?.name || '';
    return {
      handoff: false,
      answer: `Dạ đúng rồi ạ! Bạn muốn mình kiểm tra thêm chi tiết gì${prodHint ? ` về **${prodHint}**` : ''} (ví dụ: **tương thích điện thoại**, **hướng dẫn sử dụng**, **giá & phân loại**, hay **đặt mua**) thì cứ nhắn ngay nhé.`
    };
  }

  if (hasAnyBoundaryTerm(space, ['xin chao', 'chao', 'hello', 'hi', 'alo']) && tokenizeMeaningful(space).length <= 3) {
    return {
      handoff: false,
      answer: 'Chào bạn, mình là **GAERU AI**. Bạn đang cần tư vấn mẫu nào (**K9**, **M3**, **G1 ULTRA**, **P01**, **P185**), kiểm tra tương thích máy hay tra cứu đơn hàng ạ?'
    };
  }

  // 12. Fallback gọn gàng: không trích lại nguyên văn câu hỏi, không quảng cáo dàn trải
  return {
    handoff: false,
    isFallback: true,
    answer: 'Mình chưa rõ đúng ý bạn đang cần tìm. Bạn nhắn cụ thể tên sản phẩm (**K9, M3, G1 ULTRA, P01, P185**), dòng máy đang dùng hoặc mã đơn hàng (GR-... / GAE-...) để mình trả lời chính xác ngay nhé (hoặc nhắn **"gặp nhân viên"**).'
  };
}

/**
 * Trình xử lý chính giải đáp chat khách hàng bằng GAERU AI (Hoàn toàn độc lập, không phụ thuộc AI bên ngoài)
 */
async function answerCustomerChat({ pool, config, thread, question, history = [], product = null }) {
  let catalog = [];
  if (Array.isArray(product?.products) && product.products.length) {
    catalog = product.products;
  } else {
    try {
      if (pool && typeof pool.query === 'function') {
        catalog = await require('./store-api').loadProducts(pool);
      }
    } catch (_) {}
    if (product && product.slug && !catalog.some(p => p.slug === product.slug)) {
      catalog = [product, ...catalog];
    }
  }

  // Không tự thu hoạch câu trả lời cứng của chính GAERU AI vào ai_learned_knowledge (tránh vòng lặp echo-chamber;
  // tri thức tự học chỉ lấy từ phản hồi thật của nhân viên qua learnFromStaffResponse & quản trị viên duyệt).
  return generateGaeruAiResponse({
    pool,
    thread,
    question,
    catalog,
    history,
    webKnowledge: product?.webKnowledge || null
  });
}

module.exports = {
  answerCustomerChat,
  generateGaeruAiResponse,
  lookupOrderInfo
};
