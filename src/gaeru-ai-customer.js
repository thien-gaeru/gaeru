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
const { matchLearnedKnowledge, learnFromInteraction } = require('./ai-self-learning');
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
  matchProductVariants
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
    role: 'Micro thu âm cài áo không dây nhỏ gọn (~7g), cắm là dùng (Plug & Play, không cần app/Bluetooth).',
    audio: 'Thu đa hướng 360°, tần số 2.4GHz độ trễ < 15ms, chip DSP lọc ồn + bông lọc gió.',
    battery: 'Pin micro dùng liên tục khoảng **2,5 giờ**, sạc qua cổng Type-C (5V/1A).',
    range: 'Phạm vi thu ổn định lên đến **20 mét** (môi trường mở, tầm nhìn thẳng).',
    variantsGuide: 'Có phân loại bộ **1 Micro** / **2 Micro**, chân cắm **Lightning**, **Type-C**, hoặc **Type-C kèm đầu chuyển (Lightning / Micro-USB / USB-A)**.',
    compatibility: 'Tương thích trực tiếp **iPhone 15 / 16 / 17 / 18**, **iPad / Android / MacBook Type-C** (bản **Type-C**), **iPhone 14 trở xuống & iPad Lightning** (bản **Lightning**), máy Android cũ (bản **Type-C + chuyển Micro-USB**) và **Laptop/PC Windows** (bản **Type-C + chuyển USB-A**).',
    fit: 'quay TikTok/Vlog cơ bản, livestream bán hàng, dạy học online, phỏng vấn 2 người tiết kiệm chi phí',
    defaultPrice: 'Từ 289.000 ₫'
  },
  'gaeru-m3': {
    name: 'GAERU M3',
    kind: 'mic',
    role: 'Bộ micro thu âm cài áo không dây (2 mic + 1 đầu thu Type-C + hộp sạc hiển thị % pin).',
    audio: 'Thu đa hướng 360°, chất lượng **24-bit / 48kHz**, SNR 100 dB, Max SPL 120 dB, giảm ồn AI thông minh + tự động cân bằng âm lượng.',
    battery: 'Một bộ phát dùng tới **3,5 giờ** liên tục; tổng thời lượng tới **24 giờ** khi luân phiên 2 mic cùng hộp sạc 500 mAh.',
    range: 'Khoảng cách truyền lên đến **20 mét** trong môi trường mở không vật cản.',
    variantsGuide: 'Bộ **2 Micro + hộp sạc**, đầu thu **Type-C** kèm tùy chọn **đầu chuyển Lightning**, **chuyển Micro-USB** hoặc **chuyển USB-A**.',
    compatibility: 'Tương thích trực tiếp thiết bị cổng **Type-C** (**iPhone 15–18, Android mới, iPad / Tablet Type-C, MacBook / Laptop USB-C**); có sẵn phân loại kèm **đầu chuyển Lightning** (iPhone 14 trở xuống), **Micro-USB** (máy cũ) và **chuyển USB (USB-A)** cho **PC / Laptop Windows**.',
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
        lines.push(`Xác nhận chốt **${displayName}** · **${v.name}** (${priceNote} — **Còn hàng**, ${shipNote}bảo hành 12 tháng, 1 đổi 1 trong 30 ngày).`);
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
  'bi re', 'tieng re', 'vo tieng', 'vo am', 'tieng nho', 'nho tieng', 'co ao', 'u gio', 'gio giat', 'tieng gio', 'deadcat',
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
  const asksPrice = hasAnyBoundaryTerm(space, ['gia', 'gia ban', 'may tien', 'tam gia']) ||
    (hasBoundaryTerm(space, 'bao nhieu') && !hasDimensionOrMeasureQuestion && !hasAnyBoundaryTerm(space, ['pin', 'khoang cach', 'trong luong', 'nang', 'chieu dai', 'chieu cao', 'keo dai', 'dung luong', 'bao xa', 'bao lau']));
  const asksStock = hasAnyBoundaryTerm(space, ['con hang', 'het hang', 'san hang', 'ton kho', 'con khong', 'con may', 'co san']);
  const asksBattery = hasAnyBoundaryTerm(space, ['pin', 'thoi luong', 'bao lau', 'may gio', 'may tieng', 'hop sac', 'sac', 'mah']);
  const asksRange = hasAnyBoundaryTerm(space, ['khoang cach', 'bao xa', 'may met', 'tam thu', 'cu ly', 'bat song']);
  const asksAudio = hasAnyBoundaryTerm(space, ['loc am', 'loc on', 'loc tieng on', 'chong on', 'khu on', 'tieng on', 'tap am', 'anc', 'dsp', 'am thanh', '360', '24 bit', '48khz', 'kiem am']);
  const asksAccessories = hasAnyBoundaryTerm(space, ['phu kien', 'trong hop', 'goi gom', 'bao gom', 'co nhung gi', 'gom gi', 'di kem']);
  const asksWeightOrSize = hasAnyBoundaryTerm(space, ['trong luong', 'nang bao nhieu', 'may gam', 'kich thuoc', 'chieu cao', 'chieu dai', 'keo dai', 'dai bao nhieu', 'bao nhieu cm', 'bao nhieu m']);
  const asksOverview = hasAnyBoundaryTerm(space, ['la gi', 'de lam gi', 'dung de lam gi', 'cong dung', 'chuc nang', 'la loai nao', 'tac dung']);
  const nonVariantPortCompatTerms = DEVICE_COMPAT_TERMS.filter(t => !['type c', 'lightning', 'micro usb', 'usb a', 'chuyen usb', 'usb thuong'].includes(t));
  const asksCompat = hasAnyBoundaryTerm(space, DEVICE_COMPAT_TERMS) &&
    !((asksPrice || asksStock || buyIntent?.isDirectClose) && !hasAnyBoundaryTerm(space, nonVariantPortCompatTerms));

  const inferredPorts = inferDevicePortsFromText(space, history);
  const parts = [];
  const matchedVars = matchProductVariants(question, liveProd?.variants || [], { ports: inferredPorts });
  const priceText = getPriceSummaryFromProduct(matchedVars.length ? { variants: matchedVars } : liveProd, spec);

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
      parts.push(`**${displayName}** hiện có giá **${priceText}** (bảo hành 12 tháng, 1 đổi 1 trong 30 ngày).`);
    }
  }

  if (asksBattery) {
    if (spec?.battery) parts.push(`- **Pin & sạc (${displayName}):** ${spec.battery}`);
    else if (liveProd?.description) parts.push(`- **Thông tin (${displayName}):** ${liveProd.description.slice(0, 240)}`);
  }

  if (asksRange) {
    if (spec?.range) parts.push(`- **Cự ly / phạm vi:** ${spec.range}`);
  }

  if (asksAudio) {
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

  if (asksCompat) {
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
    if (key === 'gaeru-k9') rows.push(`- **GAERU K9 (${priceStr}):** Nhỏ gọn nhất, cắm là dùng không hộp sạc, pin **2,5h/mic**, cự ly 20m — hợp quay vlog ngắn, dạy học, tối ưu chi phí.`);
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
  const snippets = webKnowledge?.relevantSnippets || [];
  const topSnippetScore = snippets.length ? Number(snippets[0].score || 0) : 0;

  const newsList = Array.isArray(webKnowledge?.latestNews) ? webKnowledge.latestNews : [];
  let bestNews = null;
  let bestNewsScore = 0;
  for (const item of newsList) {
    const score = tokenOverlapScore(qTokens, tokenizeMeaningful(`${item.title || ''} ${item.summary || ''}`));
    if (score > bestNewsScore) {
      bestNewsScore = score;
      bestNews = item;
    }
  }

  if (bestNews && bestNewsScore >= 0.4 && bestNewsScore >= topSnippetScore) {
    return `Bài hướng dẫn liên quan trên GAERU:\n- [${bestNews.title}](${bestNews.url})${bestNews.summary ? ` — ${bestNews.summary}` : ''}`;
  }

  if (snippets.length && topSnippetScore >= 0.45) {
    return snippets.slice(0, 2).map(s => `- ${s.line}`).join('\n');
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

  if (rates && typeof rates === 'object' && Object.keys(rates).length > 0) {
    const matchedProvinceKey = Object.keys(rates).find(k => {
      const kNorm = normalizeSearchSpace(k);
      return kNorm && kNorm !== 'toan quoc' && hasBoundaryTerm(space, kNorm);
    });
    if (matchedProvinceKey) {
      const fee = shippingFee(rates, matchedProvinceKey);
      if (fee === 0) {
        return `**Vận chuyển & Giao hàng:**\n- Khu vực **${matchedProvinceKey}** hiện được **Freeship (Miễn phí vận chuyển 0 ₫)**, giao dự kiến **2–4 ngày** làm việc, hỗ trợ **đồng kiểm** trước khi thanh toán.`;
      }
      if (Number.isFinite(fee)) {
        return `**Vận chuyển & Giao hàng:**\n- Phí ship tới **${matchedProvinceKey}** hiện là **${formatVnd(fee)}**, giao dự kiến **2–4 ngày** làm việc, hỗ trợ **đồng kiểm** trước khi thanh toán.`;
      }
    }

    const nationwideFee = shippingFee(rates, 'Toàn quốc');
    if (nationwideFee === 0) {
      const shipLabel = note ? `**Freeship** — ${note}` : '**Freeship (Miễn phí vận chuyển toàn quốc 0 ₫)**';
      return `**Vận chuyển & Giao hàng:**\n- ${shipLabel}, giao dự kiến **2–4 ngày** làm việc (Viettel Post / SPX), được **đồng kiểm** trước khi thanh toán.`;
    }
    if (Number.isFinite(nationwideFee)) {
      const noteText = note ? ` (${note})` : '';
      return `**Vận chuyển & Giao hàng:**\n- Phí vận chuyển toàn quốc là **${formatVnd(nationwideFee)}**${noteText}, giao dự kiến **2–4 ngày** làm việc (Viettel Post / SPX), được **đồng kiểm** trước khi thanh toán.`;
    }
  }

  const rateNote = note ? ` (${note})` : '';
  return '**Vận chuyển & Giao hàng:**\n' +
    `- **Freeship** toàn quốc cho đơn từ **500.000 ₫**, giao dự kiến **2–4 ngày** làm việc (Viettel Post / SPX), được **đồng kiểm** trước khi thanh toán.${rateNote}`;
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
  const expanded = expandQueryVi(raw);
  const space = normalizeSearchSpace(expanded);
  const detailed = isExplicitDetailedRequest(space);

  // 1. Yêu cầu gặp nhân viên / người thật (có kiểm tra phủ định "không cần nhân viên")
  const explicitHuman = /(?:gap|chuyen|ket noi|noi chuyen|lien he|goi).{0,35}(?:nhan vien|nguoi that|tu van vien)|(?:human|live agent)|khong muon.{0,12}(?:ai|bot)/i.test(expanded) &&
    !/khong (?:can|muon) (?:gap |noi chuyen voi )?(?:nhan vien|nguoi that)/i.test(expanded) &&
    !isTermNegated(space, 'nhan vien');

  if (explicitHuman) {
    return {
      handoff: true,
      answer: 'Dạ GAERU AI đang chuyển bạn tới chuyên viên tư vấn GAERU. Nếu cần gấp, bạn có thể gọi Hotline **082 919 1080** (10:00 – 17:00) nhé!'
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

  // Phân giải sản phẩm liên quan (câu hiện tại hoặc ngữ cảnh các lượt trước / thread)
  const mentioned = resolveMentionedProducts(raw, catalog, { thread, history });
  const primaryProd = mentioned.items[0] ? { ...mentioned.items[0], source: mentioned.source } : null;
  const buyIntent = detectPurchaseClosingIntent(raw, space);

  const asksXu = hasAnyBoundaryTerm(space, ['gaeru xu', 'tich xu', 'doi xu', 'hoan xu', 'diem thuong', 'hang thanh vien']) || /(?:^|[^\p{L}])xu(?:$|[^\p{L}])/iu.test(raw);
  const asksWarrantyOrCare = hasAnyBoundaryTerm(space, ['bao hanh', 'doi tra', '1 doi 1', 'care+', 'care plus', 'kich hoat bao hanh', 'bi loi', 'sua chua', 'yeu cau ho tro', 'phieu ho tro', 'khieu nai']);
  const asksShip = hasAnyBoundaryTerm(space, ['giao hang', 'van chuyen', 'phi ship', 'ship', 'freeship', 'mien phi van chuyen', 'dong kiem', 'kiem tra hang', 'bao lau nhan']) ||
    (/may ngay/.test(space) && hasAnyBoundaryTerm(space, ['nhan', 'giao', 'toi', 'ship', 'hang', 'tinh']));
  const asksPay = hasAnyBoundaryTerm(space, ['thanh toan', 'cod', 'vietqr', 'vnpay', 'momo', 'zalopay', 'chuyen khoan']);
  const asksVoucher = hasAnyBoundaryTerm(space, ['ma giam gia', 'voucher', 'coupon', 'khuyen mai', 'uu dai', 'code giam', 'giam gia']);
  const asksMarketplace = hasAnyBoundaryTerm(space, ['shopee', 'tiktok shop', 'tiktokshop', 'san thuong mai', 'lazada', 'link shopee', 'link tiktok', 'gian hang']);
  const asksBundles = hasAnyBoundaryTerm(space, ['combo', 'mua kem', 'tron bo', 'bo combo', 'goi combo']);
  const asksArticle = hasAnyBoundaryTerm(space, ['bai viet', 'tin tuc', 'blog', 'bai huong dan', 'doc bai']);

  // Xác định câu hỏi có yêu cầu tra cứu dữ liệu động (giá/kho/chính sách/vận chuyển/voucher/chốt đơn) không
  const isDynamicPolicyOrCommerce = hasAnyBoundaryTerm(space, [
    'gia', 'gia ban', 'bao nhieu tien', 'may tien', 'con hang', 'het hang', 'ton kho'
  ]) || asksXu || asksWarrantyOrCare || asksShip || asksPay || asksVoucher || asksMarketplace || asksBundles ||
    buyIntent.isClosing || /(?:gia|tien|phi|giam).{0,12}bao nhieu|bao nhieu\s+(?:tien|nghin|ngan|dong|k\b|xu\b)/.test(space);

  // 3. Tri thức tự học đặc thù (chỉ ưu tiên trước khi KHÔNG phải câu hỏi giá/tồn kho/đơn/chính sách/chốt đơn)
  if (!isDynamicPolicyOrCommerce) {
    try {
      const learnedMatch = await matchLearnedKnowledge(pool, raw, { minScore: 0.65 });
      if (learnedMatch && learnedMatch.entry) {
        const e = learnedMatch.entry;
        return {
          handoff: false,
          answer: e.learned_facts || e.sample_answer,
          learnedKnowledge: {
            id: e.id,
            topic: e.topic,
            confidence: e.confidence_score
          }
        };
      }
    } catch (_) {}
  }

  let liveWeb = webKnowledge;
  if (!liveWeb && pool && typeof pool.query === 'function' && (isDynamicPolicyOrCommerce || primaryProd)) {
    try {
      liveWeb = await loadLiveSiteFacts(pool);
    } catch (_) {}
  }

  const authData = thread?.customer_id && pool && (asksXu || asksWarrantyOrCare)
    ? await lookupAuthenticatedCustomerData(pool, thread, space)
    : null;

  // Thu thập các phần trả lời trực tiếp cho từng ý được hỏi (hỗ trợ câu hỏi đa ý)
  const sections = [];

  // 4. So sánh hoặc chọn dòng sản phẩm GAERU (không nhầm so sánh hệ điều hành / iOS / cổng kết nối thành so sánh sản phẩm)
  const isDeviceOrOsComparison = hasAnyBoundaryTerm(space, [
    'ios', 'otg', 'go loi usb', 'nha phat trien', 'mic ngoai', 'mic gan ngoai',
    'dau vao am thanh', 'trung tam dieu khien', 'type c', 'lightning', 'micro usb', 'usb a'
  ]) && mentioned.items.length < 2;
  const wantsCompare = !isDeviceOrOsComparison && (
    mentioned.items.length >= 2 ||
    hasAnyBoundaryTerm(space, ['nen mua loai nao', 'nen mua mau nao', 'chon loai nao']) ||
    (hasAnyBoundaryTerm(space, ['so sanh', 'khac nhau', 'khac gi', 'chon cai nao', 'giua']) &&
      ((mentioned.source === 'question' && mentioned.items.length >= 1) ||
        hasAnyBoundaryTerm(space, ['k9', 'm3', 'p01', 'p185', 'g1', 'cac dong', 'cac mau', 'hai mau', '2 mau', 'hai loai', '2 loai', 'mic nay', 'san pham'])))
  );

  if (wantsCompare) {
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
      ...DEVICE_COMPAT_TERMS
    ]) || buyIntent.isClosing || mentioned.source === 'question';

    if (isSpecificOrBroadProduct) {
      sections.push(buildProductSpecificAnswer({ prodEntry: primaryProd, question: raw, space, detailed, history, catalog, buyIntent, webKnowledge: liveWeb }));
    }
  } else {
    // 6. Tương thích thiết bị / xử lý lỗi chung (không gắn 1 model cụ thể)
    const compat = buildDeviceCompatibilityAnswer(space, raw, null);
    if (compat) sections.push(compat);
  }

  // 7. Chính sách GAERU Xu / Bảo hành / Vận chuyển / Thanh toán / Khuyến mãi / Combo / Sàn TMĐT
  if (asksXu) {
    sections.push(buildLoyaltyAnswer({ webKnowledge: liveWeb, authData }));
  }

  if (asksWarrantyOrCare) {
    const authCareText = buildAuthenticatedWarrantyStatusLines(authData);
    sections.push(
      '**Chính sách Bảo hành GAERU:**\n' +
      '- Bảo hành chính hãng **12 tháng**, lỗi kỹ thuật **1 đổi 1 trong 30 ngày** đầu (tra cứu/kích hoạt bằng SĐT tại `/ho-tro`; có gói mở rộng Care+).' +
      (authCareText ? `\n\n${authCareText}` : '')
    );
  }

  if (asksShip) {
    sections.push(buildShippingAnswer({ webKnowledge: liveWeb, space }));
  }

  if (asksPay) {
    sections.push(
      '**Phương thức thanh toán:** COD (tiền mặt khi nhận), VietQR (xác nhận tự động), VNPAY, MoMo và ZaloPay.'
    );
  }

  if (asksMarketplace) {
    sections.push(buildMarketplaceAnswer({ primaryProd, catalog }));
  }

  if (asksBundles) {
    sections.push(buildBundlesAnswer({ webKnowledge: liveWeb, primaryProd }));
  }

  if (asksArticle && Array.isArray(liveWeb?.latestNews) && liveWeb.latestNews.length) {
    const newsAns = findWebKnowledgeAnswer(raw, { latestNews: liveWeb.latestNews }, catalog);
    if (newsAns) sections.push(newsAns);
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

  // Nếu đã có câu trả lời trực tiếp cho câu hỏi (1 hoặc nhiều ý) -> trả gọn luôn
  if (sections.length > 0) {
    return { handoff: false, answer: sections.join('\n\n') };
  }

  // 8. Báo giá chung hoặc đề xuất mua khi khách hỏi danh mục / chốt mua chung mà chưa chỉ định mẫu
  if ((hasAnyBoundaryTerm(space, ['bang gia', 'gia', 'bao nhieu', 'cac mau', 'san pham nao', 'co nhung gi', 'ban gi']) || buyIntent.isClosing) && !primaryProd) {
    const listSource = catalog.length ? catalog.slice(0, 6) : Object.entries(PRODUCT_SPECS).map(([slug, s]) => ({ slug, name: s.name, descriptor: s.role, variants: [] }));
    const inStockItems = listSource.filter(p => !Array.isArray(p.variants) || !p.variants.length || p.variants.some(v => v.stockQuantity === undefined || Number(v.stockQuantity) > 0));
    const displayList = buyIntent.isDirectClose && inStockItems.length ? inStockItems : listSource;
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
    return {
      handoff: false,
      answer: `**${buyIntent.isClosing ? 'Các thiết bị GAERU sẵn hàng để bạn đặt mua ngay:' : 'Bảng giá các thiết bị GAERU hiện có:'}**\n${lines}\nBạn đang dùng thiết bị nào (điện thoại / iPad / Laptop / PC) để mình chọn đúng chân cắm nhé?`
    };
  }

  // 9. Tư vấn theo nhu cầu sử dụng (Quay ngoài trời, Livestream, Dạy học, Podcast, Tự quay, 2 người)
  if (hasAnyBoundaryTerm(space, ['ngoai troi', 'ngoai canh', 'livestream', 'ban hang', 'day hoc', 'hop online', 'podcast', 'phong thu', 'phong van', '2 nguoi', 'hai nguoi', 'cap doi', 'vlog', 'tu quay', 'mot minh', 'quay video', 'thiet bi livestream'])) {
    const pick = (slug, fallbackName) => {
      const p = catalog.find(item => item.slug === slug);
      const spec = PRODUCT_SPECS[slug];
      return `${p?.name || fallbackName} (${getPriceSummaryFromProduct(p, spec)})`;
    };
    return {
      handoff: false,
      answer:
        `Gợi ý nhanh từ **GAERU AI** theo nhu cầu của bạn:\n` +
        `- **Livestream / quay nhiều giờ:** ${pick('gaeru-m3', 'GAERU M3')} (2 mic + hộp sạc tới 24h, giảm ồn AI).\n` +
        `- **Vlog cơ bản / dạy học tiết kiệm:** ${pick('gaeru-k9', 'GAERU K9')} (bản 1 hoặc 2 mic, cắm là dùng, lọc ồn DSP).\n` +
        `- **Quay đa thiết bị (máy ảnh + điện thoại + PC):** ${pick('gaeru-g1-ultra', 'GAERU G1 ULTRA')}.\n` +
        `- **Tự quay rảnh tay cần máy xoay theo:** Gimbal AI ${pick('gaeru-p01', 'GAERU P01')}.`
    };
  }

  // 10. Khai thác thêm webKnowledge / trang sản phẩm nếu câu hỏi nằm ở kiến thức dài đuôi
  let resolvedWeb = webKnowledge;
  if (!resolvedWeb && !hasAnyBoundaryTerm(space, ['cam on', 'thank', 'ok', 'oke', 'xin chao', 'hello', 'hi', 'alo'])) {
    try {
      resolvedWeb = await getRelevantWebKnowledge(pool, { question: raw, selectedProduct: primaryProd?.product || null });
    } catch (_) {}
  }
  const webAns = findWebKnowledgeAnswer(raw, resolvedWeb, catalog);
  if (webAns) {
    return { handoff: false, answer: webAns };
  }

  // 11. Cảm ơn / chào hỏi ngắn gọn — không xả menu quảng cáo dài dòng
  if (hasAnyBoundaryTerm(space, ['cam on', 'thank', 'ok', 'oke', 'roi', 'hieu roi']) || /^(?:da|vang|ok|oke)$/.test(space)) {
    return {
      handoff: false,
      answer: 'Dạ không có gì ạ! Khi nào cần kiểm tra thêm sản phẩm hoặc đơn hàng, bạn cứ nhắn **GAERU AI** nhé.'
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

  const result = await generateGaeruAiResponse({
    pool,
    thread,
    question,
    catalog,
    history,
    webKnowledge: product?.webKnowledge || null
  });

  // Tự động ghi nhớ tri thức có giá trị, tuyệt đối bỏ qua đơn hàng / PII / câu hỏi ngắn / fallback
  try {
    const raw = String(question || '').trim();
    const normRaw = normalize(raw);
    const isOrderOrPersonal = result.orderLookup || /\b(?:gr|gae)-|[0-9]{9,}|tra cuu|don hang|dia chi|van don|so dien thoai/i.test(normRaw);
    if (pool && !result.handoff && !result.isFallback && !result.learnedKnowledge && result.answer && raw && raw.length >= 8 && !isOrderOrPersonal) {
      void learnFromInteraction(pool, {
        sourceType: 'customer_chat',
        question: raw,
        answer: result.answer,
        confidence: 0.65,
        status: 'pending_review',
        metadata: { threadId: thread?.id, productId: thread?.product_id }
      }).catch?.(() => {});
    }
  } catch (_) {}

  return result;
}

module.exports = {
  answerCustomerChat,
  generateGaeruAiResponse,
  lookupOrderInfo
};
