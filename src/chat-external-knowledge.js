const { createHash } = require('node:crypto');
const { normalizeVi, normalizeSearchSpace, expandQueryVi, hasAnyBoundaryTerm } = require('./lib/ai-nlu');
const { BRAND_PROFILES, buildComprehensiveCompatibilityAnswer } = require('./lib/phone-compatibility');

// In-memory cache for external knowledge lookups (TTL 30 mins, max 300 entries)
const externalCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 300;

// Curated technical compatibility & audio ecosystem knowledge (2025–2026 Updated)
const TECH_ECOSYSTEM_KNOWLEDGE = [
  {
    category: 'iphone_ios_devices',
    triggers: ['iphone', 'ios', 'lightning', 'type c iphone', 'ipad', 'macbook'],
    facts: [
      'iPhone 15, 16 (kể cả 16e), 17 (17, 17 Air, 17e, 17 Pro/Pro Max) và iPhone 18 series đều sử dụng cổng USB Type-C chuẩn quốc tế: Cắm đầu thu Type-C trực tiếp vào đáy máy là nhận mic ngay, không cần đầu chuyển.',
      'iPhone 14 series trở xuống (iPhone 14, 13, 12, 11, XS, XR, X, 8, 7, SE thế hệ 1–3): Sử dụng chân cắm Lightning. Khách nên chọn phân loại Chân Lightning (trên GAERU K9) hoặc bản Type-C kèm đầu chuyển Lightning (trên GAERU K9 / GAERU M3).',
      'iPad Type-C (iPad Gen 10/11, iPad Air 4/5/M2/M3+, iPad mini 6/7, iPad Pro 2018–M4/M5) và MacBook cắm đầu thu Type-C nhận ngay; iPad Gen 9 / Air 3 / mini 5 trở xuống dùng chân Lightning.'
    ]
  },
  {
    category: 'android_otg_compatibility',
    triggers: [
      'android', 'otg', 'micro usb', 'chua nhan', 'khong nhan', 'khong nhan mic', 'den khong sang',
      ...BRAND_PROFILES.flatMap(b => b.triggers)
    ],
    facts: [
      'Samsung Galaxy (S20–S26 Ultra, Z Fold 5–7, Z Flip 5–7, A15–A56, Tab S9–S11), Google Pixel (6–11), HONOR (Magic 6–8, 200–400), Xiaomi/Redmi/POCO (Xiaomi 14–18, Redmi Note 12–15, POCO X7–F8), Huawei (Pura 70–80, Mate 70), Nothing/CMF, ASUS ROG Phone 8–9, RedMagic/Nubia, Sony Xperia: Đều dùng cổng USB Type-C, tự nhận OTG & micro ngoài khi cắm trực tiếp.',
      'OPPO (Find X8–X10, Find N5, Reno12–16, A5/A60), Realme (12–16, GT 6–8, C65–C85), OnePlus, vivo/iQOO (X200–X300, V40–V60, Y19s–Y31d, iQOO 13–15), Tecno (Camon 30–40, Spark 30–40), Infinix (Note 40–50, Hot 40–50): Đều dùng cổng USB Type-C và thường cần vào Cài đặt -> bật Kết nối OTG trước khi cắm đầu thu.',
      'Điện thoại Android phổ thông đời cũ (Samsung J7/A10s, OPPO A3s/A12/A15, Redmi 9A/9C/10A, vivo Y11/Y12/Y20, Realme C11/C21Y): Sử dụng chân cắm Micro-USB, cần chọn phân loại Type-C + chuyển Micro-USB (có sẵn trên GAERU K9 và GAERU M3).'
    ]
  },
  {
    category: 'camera_apps_livestream',
    triggers: ['camera', 'quay video', 'tiktok', 'capcut', 'livestream', 'facebook', 'youtube', 'zoom', 'quay phim', 'app', 'ung dung'],
    facts: [
      'Tương thích 100% với các ứng dụng phổ biến: TikTok, CapCut, Facebook Live, YouTube, Shopee Live, Instagram Reels, Zoom, Google Meet.',
      'Nếu camera mặc định của một số máy Android chưa thu tiếng từ mic rời: Bạn có thể bật Micro ngoài trong cài đặt camera (Samsung Pro Video / Pixel Camera), quay trực tiếp trong app TikTok/CapCut hoặc tải ứng dụng miễn phí "Open Camera" chọn nguồn âm thanh "Microphone ngoài nếu có".'
    ]
  },
  {
    category: 'noise_reduction_technology',
    triggers: ['loc am', 'loc tieng on', 'tieng on', 'chong on', 'khu on', 'gio', 'tap am', 'ngoai duong', 'dsp', 'khoang cach', 'pin', 'song', '2.4ghz'],
    facts: [
      'Công nghệ lọc tiếng ồn thông minh Smart DSP / AI: Tự động tách giọng nói khỏi tạp âm xung quanh (tiếng gió, còi xe, tiếng quạt, tiếng ồn quán cafe).',
      'Sóng không dây 2.4GHz kỹ thuật số: Cho kết nối ổn định, độ trễ siêu thấp dưới 15–20ms, âm thanh không bị lệch hình khi quay video hay phát trực tiếp. Phạm vi hoạt động hiệu quả lên đến 20m trong môi trường mở.'
    ]
  },
  {
    category: 'computer_laptop_pc',
    triggers: ['may tinh', 'laptop', 'pc', 'windows', 'mac', 'obs'],
    facts: [
      'Sử dụng trên Máy tính / Laptop (Windows 10/11 & Mac): Cắm đầu thu Type-C trực tiếp (hoặc chọn phân loại kèm đầu chuyển USB-A nếu máy chỉ có cổng USB thường). Vào Settings -> Sound -> Chọn Input / Microphone là Wireless Microphone.',
      'Hoạt động mượt mà trên OBS Studio, Audacity, Premiere Pro, Camtasia, CapCut PC.'
    ]
  }
];

function normalize(text) {
  return normalizeVi(text);
}

/**
 * Perform live web search using DuckDuckGo HTML Lite
 */
async function searchLiveWeb(query, { transport = fetch, timeoutMs = 3500 } = {}) {
  const cleanQuery = String(query || '').replace(/[^\p{L}\p{N}\s_+-]/gu, ' ').trim();
  if (!cleanQuery || cleanQuery.length < 3) return [];

  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(cleanQuery);
  try {
    const res = await transport(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!res.ok) return [];
    const { readBoundedText } = require('./lib/http-response');
    const html = await readBoundedText(res, 262144);
    const snippets = [];
    const re = /<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = re.exec(html)) !== null && snippets.length < 3) {
      const cleanSnippet = match[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleanSnippet.length > 25) {
        snippets.push(cleanSnippet);
      }
    }
    return snippets;
  } catch {
    // Graceful fallback on network timeout or offline
    return [];
  }
}

/**
 * Get relevant external technical knowledge & live search insights
 */
async function getExternalWebKnowledge({ question = '', selectedProduct = null, transport = fetch, webSearchEnabled = true, curatedEnabled = true } = {}) {
  const text = typeof question === 'string' ? question : question?.current || '';
  const qNorm = expandQueryVi(text);
  const prodNorm = selectedProduct ? normalize(`${selectedProduct.name} ${selectedProduct.slug || ''}`) : '';

  // 1. Match curated technology ecosystem facts using token boundaries
  const matchedFacts = [];
  if (curatedEnabled) {
    const specificCompat = buildComprehensiveCompatibilityAnswer(
      normalizeSearchSpace(qNorm),
      text,
      selectedProduct?.slug || null
    );
    if (specificCompat) {
      for (const line of specificCompat.split('\n').map(l => l.replace(/\*\*/g, '').replace(/^-\s*/, '').trim()).filter(Boolean)) {
        if (!matchedFacts.includes(line)) matchedFacts.push(line);
      }
    }
    for (const entry of TECH_ECOSYSTEM_KNOWLEDGE) {
      const isTriggered = hasAnyBoundaryTerm(qNorm, entry.triggers) ||
        (prodNorm && !/noise_reduction/.test(entry.category) && hasAnyBoundaryTerm(prodNorm, entry.triggers));
      if (isTriggered) {
        for (const f of entry.facts) {
          if (!matchedFacts.includes(f)) matchedFacts.push(f);
        }
      }
    }
  }

  // 2. Perform live web search if question involves specific devices, apps, or comparisons
  const needsWebSearch = /\b(?:iphone|samsung|oppo|xiaomi|redmi|poco|vivo|iqoo|realme|oneplus|honor|huawei|pixel|tecno|infinix|nothing|rog|redmagic|nubia|xperia|motorola|nokia|ipad|laptop|pc|macbook|mac|otg|capcut|tiktok|livestream|live|so sanh|dung duoc|tuong thich|tai sao|huong dan|cai dat|khoang cach)\b/.test(qNorm);

  let searchSnippets = [];
  if (webSearchEnabled && needsWebSearch && transport) {
    const cacheKey = createHash('md5').update(`${prodNorm}\0${qNorm}`).digest('hex');
    const cached = externalCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      searchSnippets = cached.snippets;
    } else {
      const { sanitizePii } = require('./ai-self-learning');
      const scrubbedQuestion = sanitizePii(text).replace(/\[[^\]]+\]/g, '').trim().slice(0, 80);
      const searchQuery = (selectedProduct ? `${selectedProduct.name} ` : 'mic thu am ') + scrubbedQuestion;
      searchSnippets = scrubbedQuestion.length >= 3 ? await searchLiveWeb(searchQuery, { transport }) : [];
      if (searchSnippets.length) {
        if (externalCache.size >= MAX_CACHE_ENTRIES) {
          const firstKey = externalCache.keys().next().value;
          if (firstKey) externalCache.delete(firstKey);
        }
        externalCache.set(cacheKey, { snippets: searchSnippets, expiresAt: Date.now() + CACHE_TTL_MS });
      }
    }
  }

  return {
    ecosystemFacts: matchedFacts.slice(0, 4),
    searchSnippets: searchSnippets.slice(0, 2)
  };
}

module.exports = {
  searchLiveWeb,
  getExternalWebKnowledge,
  TECH_ECOSYSTEM_KNOWLEDGE
};
