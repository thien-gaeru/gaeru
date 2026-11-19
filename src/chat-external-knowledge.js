const { createHash } = require('node:crypto');
const { normalizeVi, normalizeSearchSpace, expandQueryVi, hasAnyBoundaryTerm } = require('./lib/ai-nlu');
const {
  BRAND_PROFILES,
  TABLET_PROFILES,
  WINDOWS_LAPTOP_BRANDS,
  DESKTOP_PC_TRIGGERS,
  buildComprehensiveCompatibilityAnswer
} = require('./lib/phone-compatibility');

// In-memory cache for external knowledge lookups (TTL 30 mins, max 300 entries)
const externalCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 300;

// Curated technical compatibility & audio ecosystem knowledge (2025–2026 Updated)
const TECH_ECOSYSTEM_KNOWLEDGE = [
  {
    category: 'iphone_ios_devices',
    triggers: ['iphone', 'ios', 'lightning', 'type c iphone', 'ipad', 'macbook', 'imac', 'mac mini', 'ios 18', 'ios 17', 'mic ngoai', 'mic gan ngoai'],
    facts: [
      'iPhone 15, 16 (kể cả 16e), 17 (17, 17 Air, 17e, 17 Pro/Pro Max) và iPhone 18 series đều sử dụng cổng USB Type-C chuẩn quốc tế: Cắm đầu thu Type-C trực tiếp vào đáy máy là nhận mic ngay.',
      'iPhone 14 series trở xuống (iPhone 14, 13, 12, 11, XS, XR, X, 8, 7, SE thế hệ 1–3) và iPad Gen 9 / Air 3 / mini 5 trở xuống dùng chân Lightning: Chọn phân loại Chân Lightning hoặc bản Type-C + đầu chuyển Lightning.',
      'iPad Gen 10/11, Air 4/5/M2/M3/M4, mini 6/7, iPad Pro 2018–M4/M5 và MacBook Air/Pro 2016+ (Apple Silicon M1–M5), iMac M1–M4, Mac mini M4 dùng USB Type-C trực tiếp.',
      'Từ iOS 18 trở lên (iOS mới), mở Trung tâm điều khiển (Control Center) khi đang quay/thu âm → chạm khung Micrô/Ứng dụng để kiểm tra chọn Đầu vào là mic gắn ngoài và giữ Chế độ micrô Tiêu chuẩn. Riêng iOS dưới 18 (iOS 17 trở xuống) tự động nhận mic ngoài ngay khi cắm, KHÔNG cần thực hiện bước chọn thủ công.'
    ]
  },
  {
    category: 'android_tablets_laptops_pc',
    triggers: [
      'android', 'otg', 'micro usb', 'go loi usb', 'nha phat trien', 'may tinh bang', 'tablet',
      'usb a', 'chuyen usb', 'chua nhan', 'khong nhan', 'khong nhan mic', 'den khong sang',
      ...BRAND_PROFILES.flatMap(b => b.triggers),
      ...TABLET_PROFILES.flatMap(t => t.triggers),
      ...WINDOWS_LAPTOP_BRANDS,
      ...DESKTOP_PC_TRIGGERS
    ],
    facts: [
      'Samsung Galaxy (S20–S26 Ultra, Z Fold 5–7, Z Flip 5–7, A15–A56, Galaxy Tab S6–S11 / A7–A9+), Google Pixel, HONOR (Magic 6–8, HONOR Pad), Xiaomi/Redmi/POCO (Xiaomi 14–18, Redmi Note 12–15, Xiaomi/Redmi Pad), Huawei (Pura 70–80, MatePad), Lenovo Tab mới, Nothing/CMF, ASUS ROG, Sony Xperia: Dùng cổng USB Type-C. Lưu ý một số máy Android (đặc biệt OPPO, Realme, Redmi/Xiaomi, vivo…) app Camera cài sẵn chỉ thu mic tích hợp của máy nên cần dùng ứng dụng tải từ kho ứng dụng (Open Camera chọn Micro ngoài, TikTok, CapCut, Facebook) để thu bằng mic rời.',
      'OPPO (Find X8–X10, Reno12–16, OPPO Pad), Realme (12–16, GT 6–8), OnePlus, vivo/iQOO (X200–X300, V40–V60, vivo Pad), Tecno, Infinix: Dùng USB Type-C, cần vào Cài đặt → bật Kết nối OTG trước khi cắm đầu thu, và quay bằng ứng dụng tải từ kho ứng dụng (như Open Camera chọn nguồn Micro ngoài, TikTok, CapCut) vì app Camera mặc định của máy thường chỉ dùng micro tích hợp.',
      'Nếu Android đã bật OTG mà vẫn chưa nhận tín hiệu mic USB: Mở Tùy chọn nhà phát triển (chạm 7 lần Phiên bản OS / Số bản dựng) → bật Gỡ lỗi USB (USB debugging) và đảm bảo công tắc Tắt định tuyến âm thanh USB đang TẮT; đồng thời thử quay trên ứng dụng tải từ kho ứng dụng (Open Camera chọn Micro ngoài, TikTok, CapCut).',
      'Laptop Windows phổ thông/cũ, MacBook Air/Pro trước 2017, Surface Pro 4–6 và PC để bàn (USB-A): Chọn phân loại Type-C + chuyển USB để cắm cổng USB chữ nhật rồi chọn Wireless Microphone trong Sound Input. Máy Android cũ (J7, OPPO A3s, Redmi 9A, vivo Y11) dùng phân loại + chuyển Micro USB.'
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
    const html = await readBoundedText(res, { maxBytes: 262144, label: 'Web knowledge' });
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

  // 2. Perform live web search only when question names specific devices/apps/OS (avoid noisy generic triggers)
  const needsWebSearch = /\b(?:iphone|samsung|oppo|xiaomi|redmi|poco|vivo|iqoo|realme|oneplus|honor|huawei|pixel|tecno|infinix|nothing|rog|redmagic|nubia|xperia|motorola|nokia|ipad|tablet|may tinh bang|galaxy tab|xiaomi pad|matepad|surface|laptop|pc|macbook|imac|mac mini|otg|go loi usb|usb debugging|ios 18|ios 17|mic ngoai|capcut|tiktok|obs|open camera)\b/.test(qNorm);

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
    ecosystemFacts: matchedFacts.slice(0, 6),
    searchSnippets: searchSnippets.slice(0, 2)
  };
}

module.exports = {
  searchLiveWeb,
  getExternalWebKnowledge,
  TECH_ECOSYSTEM_KNOWLEDGE
};
