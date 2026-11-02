const { createHash } = require('node:crypto');

// In-memory cache for external knowledge lookups (TTL 30 mins, max 300 entries)
const externalCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 300;

// Curated technical compatibility & audio ecosystem knowledge
const TECH_ECOSYSTEM_KNOWLEDGE = [
  {
    category: 'iphone_apple',
    triggers: ['iphone', 'apple', 'ios', 'lightning', 'type c iphone', 'ipad', 'macbook'],
    facts: [
      'iPhone 15, 15 Plus, 15 Pro, 15 Pro Max và toàn bộ dòng iPhone 16 series đã chuyển sang cổng Type-C (USB-C) chuẩn quốc tế: Cắm đầu thu Type-C trực tiếp vào đáy máy là nhận mic ngay, không cần bất kỳ đầu chuyển nào.',
      'Dòng iPhone 14 trở xuống (iPhone 14, 13, 12, 11, XS, XR, X, 8, 7): Sử dụng chân cắm Lightning. Khi mua mic GAERU, khách nên chọn phân loại chân Lightning (hoặc dùng cáp OTG Lightning sang Type-C chính hãng chuẩn Apple).',
      'iPad Type-C (iPad Pro M1/M2/M4, iPad Air 4/5/6, iPad mini 6, iPad Gen 10) và máy tính MacBook: Cắm đầu thu Type-C nhận ngay làm micro thu âm mặc định.'
    ]
  },
  {
    category: 'android_otg_compatibility',
    triggers: ['android', 'samsung', 'oppo', 'xiaomi', 'redmi', 'vivo', 'realme', 'otg', 'chua nhan', 'khong nhan mic', 'den khong sang'],
    facts: [
      'Samsung Galaxy, Google Pixel: Cắm đầu thu Type-C vào là tự động nhận diện và kích hoạt micro thu âm ngay lập tức.',
      'Oppo, Realme, Vivo, OnePlus: Mặc định cổng Type-C có thể khóa OTG để tiết kiệm pin. Người dùng cần vào Cài đặt (Settings) -> tìm "OTG" -> Bật "Kết nối OTG" trước khi cắm đầu thu mic. Nếu sau 10 phút không sử dụng, tính năng này sẽ tự tắt.',
      'Xiaomi, Redmi, POCO: Đa phần cắm tự nhận. Nếu camera mặc định chưa nhận tiếng từ mic rời, hãy vào Cài đặt Camera -> Bật nguồn âm thanh micro ngoài.'
    ]
  },
  {
    category: 'camera_apps_livestream',
    triggers: ['camera', 'quay video', 'tiktok', 'capcut', 'livestream', 'facebook', 'youtube', 'zoom', 'quay phim', 'app', 'ung dung'],
    facts: [
      'Tương thích 100% với các ứng dụng phổ biến: TikTok, CapCut, Facebook Live, YouTube, Shopee Live, Instagram Reels, Zoom, Google Meet.',
      'Nếu camera mặc định của một số máy Android cũ không thu tiếng từ mic rời: Người dùng có thể quay trực tiếp trong app TikTok/CapCut hoặc tải ứng dụng miễn phí "Open Camera" (Vào Cài đặt video -> Cài đặt âm thanh -> Nguồn âm thanh -> Chọn "Microphone ngoài nếu có").'
    ]
  },
  {
    category: 'noise_reduction_technology',
    triggers: ['loc am', 'loc tieng on', 'on', 'gio', 'tap am', 'ngoai duong', 'dsp', 'khoang cach', 'pin', 'song', '2.4ghz'],
    facts: [
      'Công nghệ lọc tiếng ồn thông minh Smart DSP: Tự động tách giọng nói khỏi tạp âm xung quanh (tiếng gió, còi xe, tiếng quạt, tiếng ồn quán cafe). Có thể bật/tắt hoặc điều chỉnh mức lọc ồn dễ dàng.',
      'Sóng không dây 2.4GHz kỹ thuật số: Cho kết nối ổn định, độ trễ siêu thấp dưới 20ms, âm thanh không bị lệch hình khi quay video hay phát trực tiếp. Phạm vi hoạt động hiệu quả lên đến 15-25m trong môi trường mở.'
    ]
  },
  {
    category: 'computer_laptop_pc',
    triggers: ['may tinh', 'laptop', 'pc', 'windows', 'mac', 'obs'],
    facts: [
      'Sử dụng trên Máy tính / Laptop (Windows 10/11 & Mac): Cắm đầu thu Type-C (hoặc dùng đầu chuyển USB-A sang Type-C nếu máy không có cổng C). Vào Settings -> Sound -> Chọn Input / Microphone là Wireless Microphone.',
      'Hoạt động mượt mà trên OBS Studio, Audacity, Premiere Pro, Camtasia, CapCut PC.'
    ]
  }
];

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
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
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!res.ok) return [];
    const html = await res.text();
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
async function getExternalWebKnowledge({ question = '', selectedProduct = null, transport = fetch } = {}) {
  const text = typeof question === 'string' ? question : question?.current || '';
  const qNorm = normalize(text);
  const prodNorm = selectedProduct ? normalize(`${selectedProduct.name} ${selectedProduct.slug || ''}`) : '';

  // 1. Match curated technology ecosystem facts
  const matchedFacts = [];
  for (const entry of TECH_ECOSYSTEM_KNOWLEDGE) {
    const isTriggered = entry.triggers.some(trigger => {
      const tNorm = normalize(trigger);
      return qNorm.includes(tNorm) || prodNorm.includes(tNorm);
    });
    if (isTriggered) {
      matchedFacts.push(...entry.facts);
    }
  }

  // 2. Perform live web search if question involves specific devices, apps, or comparisons
  const needsWebSearch = /(?:iphone|samsung|oppo|xiaomi|vivo|ipad|laptop|pc|mac|otg|capcut|tiktok|live|so sanh|dung duoc|tuong thich|tai sao|huong dan|cai dat|khoang cach)/.test(qNorm);

  let searchSnippets = [];
  if (needsWebSearch && transport) {
    const cacheKey = createHash('md5').update(qNorm).digest('hex');
    const cached = externalCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      searchSnippets = cached.snippets;
    } else {
      // Build a concise search query
      const searchQuery = (selectedProduct ? `${selectedProduct.name} ` : 'mic thu am ') + text.slice(0, 80);
      searchSnippets = await searchLiveWeb(searchQuery, { transport });
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
