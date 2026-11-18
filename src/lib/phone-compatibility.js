'use strict';

/**
 * Cơ sở dữ liệu thiết bị di động & chuẩn chân cắm kết nối cập nhật (2025–2026)
 * Phục vụ hệ thống tư vấn tương thích thông minh GAERU AI.
 *
 * Bao phủ đầy đủ các dòng máy Apple (iPhone/iPad), Android (Samsung, Xiaomi/Redmi/POCO,
 * OPPO/OnePlus/Realme, vivo/iQOO, HONOR, Huawei, Google Pixel, Tecno, Infinix,
 * Nothing/CMF, ZTE/Nubia/RedMagic, ASUS ROG/Zenfone, Sony Xperia, Motorola, Nokia/HMD),
 * phân loại rõ chuẩn cổng vật lý (USB Type-C / Lightning / Micro-USB) và lưu ý OTG / App.
 */

const {
  normalizeSearchSpace,
  expandQueryVi,
  hasAnyBoundaryTerm
} = require('./ai-nlu');

const PORT_TYPES = Object.freeze({
  TYPE_C: 'type-c',
  LIGHTNING: 'lightning',
  MICRO_USB: 'micro-usb'
});

const APPLE_TYPE_C_SERIES = Object.freeze([
  'iphone 18', 'iphone 18 plus', 'iphone 18 pro', 'iphone 18 pro max',
  'iphone 17', 'iphone 17 air', 'iphone air', 'iphone 17e', 'iphone 17 plus', 'iphone 17 pro', 'iphone 17 pro max',
  'iphone 16', 'iphone 16 plus', 'iphone 16e', 'iphone 16 pro', 'iphone 16 pro max',
  'iphone 15', 'iphone 15 plus', 'iphone 15 pro', 'iphone 15 pro max'
]);

const APPLE_LIGHTNING_SERIES = Object.freeze([
  'iphone 14', 'iphone 14 plus', 'iphone 14 pro', 'iphone 14 pro max',
  'iphone 13', 'iphone 13 mini', 'iphone 13 pro', 'iphone 13 pro max',
  'iphone 12', 'iphone 12 mini', 'iphone 12 pro', 'iphone 12 pro max',
  'iphone 11', 'iphone 11 pro', 'iphone 11 pro max',
  'iphone xs', 'iphone xs max', 'iphone xr', 'iphone x',
  'iphone 8', 'iphone 8 plus', 'iphone 7', 'iphone 7 plus',
  'iphone 6s', 'iphone 6s plus', 'iphone 6', 'iphone 6 plus',
  'iphone 5s', 'iphone 5', 'iphone se', 'iphone se 2', 'iphone se 3'
]);

const IPAD_TYPE_C_MODELS = Object.freeze([
  'ipad gen 10', 'ipad 10', 'ipad gen 11', 'ipad 11', 'ipad a16',
  'ipad air 4', 'ipad air 5', 'ipad air m2', 'ipad air m3', 'ipad air m4',
  'ipad mini 6', 'ipad mini 7', 'ipad mini a17',
  'ipad pro m1', 'ipad pro m2', 'ipad pro m4', 'ipad pro m5', 'ipad pro 2018', 'ipad pro 2020', 'ipad pro 2021', 'ipad pro 2022', 'ipad pro 2024', 'ipad pro 2025'
]);

const IPAD_LIGHTNING_MODELS = Object.freeze([
  'ipad gen 9', 'ipad gen 8', 'ipad gen 7', 'ipad gen 6', 'ipad gen 5',
  'ipad 9', 'ipad 8', 'ipad 7', 'ipad 6',
  'ipad air 3', 'ipad air 2', 'ipad mini 5', 'ipad mini 4'
]);

const BRAND_PROFILES = Object.freeze([
  {
    id: 'samsung',
    brand: 'Samsung Galaxy',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: [
      'samsung', 'galaxy',
      's26', 's26 ultra', 's26 plus', 's25', 's25 ultra', 's25 edge', 's25 plus', 's25 fe',
      's24', 's24 ultra', 's24 fe', 's23', 's23 ultra', 's23 fe', 's22', 's21', 's20',
      'z fold 7', 'z fold 6', 'z fold 5', 'z fold 4', 'fold 7', 'fold 6', 'fold 5',
      'z flip 7', 'z flip 7 fe', 'z flip 6', 'z flip 5', 'z flip 4', 'flip 7', 'flip 6', 'flip 5',
      'a56', 'a55', 'a54', 'a36', 'a35', 'a34', 'a26', 'a25', 'a17', 'a16', 'a15', 'a07', 'a06', 'a05',
      'm55', 'm35', 'm15', 'tab s11', 'tab s10', 'tab s9', 'galaxy note 20', 'galaxy note 10',
      'j7 prime', 'j7 pro', 'galaxy j7', 'galaxy j5', 'galaxy j4', 'galaxy j6', 'galaxy a10', 'a10s', 'a2 core', 'galaxy a02', 'a03 core'
    ],
    legacyMicroUsbModels: [
      'j7 prime', 'j7 pro', 'galaxy j7', 'galaxy j5', 'galaxy j4', 'galaxy j6', 'galaxy a10', 'a10s', 'a2 core', 'galaxy a02', 'a03 core'
    ],
    latestSummary: 'Galaxy S25 / S26 series, Z Fold 7 / Z Flip 7, Galaxy A56 / A36 / A26 / A16–A17, Tab S10 / S11',
    portNote: 'Tất cả dòng Galaxy hiện đại từ S8, A/M series (từ 2020–2026) đến Z Fold 7 / Flip 7 đều dùng cổng **USB Type-C** (chỉ các dòng cũ như J7 Prime, J7 Pro, A10s, A03 Core dùng **Micro-USB**).',
    osTip: 'Máy Samsung tự động nhận OTG & micro Type-C (cắm là dùng). Nếu app Camera mặc định chỉ dùng mic máy, bạn hãy chuyển sang chế độ **Video Chuyên Nghiệp (Pro Video) → Mic: USB**, hoặc quay bằng **TikTok / CapCut / Open Camera**.'
  },
  {
    id: 'oppo',
    brand: 'OPPO',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: true,
    triggers: [
      'oppo', 'find x10', 'find x9', 'find x8', 'find n5', 'find n3',
      'reno 16', 'reno 15', 'reno 14', 'reno 13', 'reno 12', 'reno 11', 'reno 10', 'reno 8',
      'reno16', 'reno15', 'reno14', 'reno13', 'reno12',
      'oppo a6 pro', 'oppo a5 pro', 'oppo a5', 'oppo a3 pro', 'oppo a3x', 'oppo a60', 'oppo a79', 'oppo a58', 'oppo a38', 'oppo f29', 'oppo f27',
      'oppo a3s', 'a3s', 'oppo a5s', 'a5s', 'a1k', 'oppo a12', 'oppo a15', 'a15s', 'a16k', 'oppo f7', 'oppo f9', 'oppo f11'
    ],
    legacyMicroUsbModels: ['oppo a3s', 'a3s', 'oppo a5s', 'a5s', 'a1k', 'oppo a12', 'oppo a15', 'a15s', 'a16k', 'oppo f7', 'oppo f9', 'oppo f11'],
    latestSummary: 'OPPO Find X9 / X10, Find N5, Reno13 / Reno14 / Reno15 / Reno16, OPPO A5 / A6 Pro / A60',
    portNote: 'Các dòng OPPO mới (Reno, Find X/N, A3/A5/A60 trở lên) dùng cổng **USB Type-C** (chỉ các máy cũ như A3s, A5s, A12, A15, F7/F9/F11 dùng **Micro-USB**).',
    osTip: '**Lưu ý quan trọng trên OPPO (ColorOS):** Vào **Cài đặt → Cài đặt bổ sung (hoặc Kết nối & chia sẻ) → bật Kết nối OTG** trước khi cắm đầu thu (OTG tự tắt sau 10 phút nếu không dùng).'
  },
  {
    id: 'realme',
    brand: 'Realme',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: true,
    triggers: [
      'realme', 'realme gt', 'realme gt 8', 'realme gt 7', 'gt 7 pro', 'realme gt 6',
      'realme 16', 'realme 15', 'realme 14', 'realme 13', 'realme 12', 'realme neo 7',
      'realme c85', 'realme c75', 'realme c71', 'realme c67', 'realme c65', 'realme c61', 'realme note 70', 'realme note 60',
      'realme c11', 'realme c12', 'realme c15', 'realme c20', 'realme c21', 'c21y', 'c25s', 'realme c30', 'c30s', 'realme c31', 'realme c33'
    ],
    legacyMicroUsbModels: ['realme c11', 'realme c12', 'realme c15', 'realme c20', 'realme c21', 'c21y', 'c25s', 'realme c30', 'c30s', 'realme c31', 'realme c33'],
    latestSummary: 'Realme GT 7 / GT 8, Realme 14 / 15 / 16 Pro, Realme C65 / C75 / Note 60–70',
    portNote: 'Các dòng Realme hiện đại dùng cổng **USB Type-C** (một số dòng phổ thông đời cũ như C11, C21Y, C30s, C33 dùng **Micro-USB**).',
    osTip: '**Lưu ý trên Realme UI:** Vào **Cài đặt → Cài đặt bổ sung → bật Kết nối OTG** trước khi cắm đầu thu micro.'
  },
  {
    id: 'oneplus',
    brand: 'OnePlus',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: true,
    triggers: ['oneplus', 'oneplus 15', 'oneplus 13', 'oneplus 12', 'oneplus 11', 'oneplus open', 'nord 5', 'nord 4', 'ace 5'],
    legacyMicroUsbModels: [],
    latestSummary: 'OnePlus 13 / 15, OnePlus Open, Nord 4 / 5, Ace 5',
    portNote: 'Toàn bộ dòng OnePlus đời mới đều sử dụng cổng **USB Type-C**.',
    osTip: 'Cắm trực tiếp đầu thu Type-C; nếu đầu thu chưa sáng đèn trên OxygenOS, vào **Cài đặt → Cài đặt bổ sung → bật Kết nối OTG**.'
  },
  {
    id: 'vivo',
    brand: 'vivo / iQOO',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: true,
    triggers: [
      'vivo', 'iqoo',
      'vivo x300', 'x300 ultra', 'x300 pro', 'vivo x200', 'x200 ultra', 'x200 pro', 'vivo x100',
      'vivo v60', 'vivo v50', 'vivo v40', 'vivo v30', 'vivo v29',
      'y31d', 'vivo y29', 'vivo y28', 'y19s', 'vivo y18', 'vivo y04', 'vivo t4', 'vivo t3',
      'iqoo 15', 'iqoo 13', 'iqoo 12', 'iqoo neo 10', 'iqoo z10', 'iqoo z9',
      'vivo y11', 'vivo y12', 'y12s', 'vivo y15', 'y15s', 'vivo y17', 'vivo y19', 'vivo y20', 'y20s', 'vivo y91'
    ],
    legacyMicroUsbModels: ['vivo y11', 'vivo y12', 'y12s', 'vivo y15', 'y15s', 'vivo y17', 'vivo y19', 'vivo y20', 'y20s', 'vivo y91'],
    latestSummary: 'vivo X200 / X300 Ultra, V40 / V50 / V60, Y19s / Y28 / Y29 / Y31d, iQOO 13 / 15 / Neo 10',
    portNote: 'Các dòng vivo V/X/T, Y mới (Y18/Y19s/Y28/Y29/Y31d) và iQOO dùng **USB Type-C** (các mẫu vivo cũ như Y11, Y12, Y15, Y20 dùng **Micro-USB**).',
    osTip: '**Lưu ý trên vivo (Funtouch OS / OriginOS):** Nếu cắm chưa sáng đèn, vào **Cài đặt → Bluetooth & thiết bị (hoặc Cài đặt khác) → bật OTG**.'
  },
  {
    id: 'xiaomi',
    brand: 'Xiaomi / Redmi / POCO',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: [
      'xiaomi', 'redmi', 'poco',
      'xiaomi 18', 'xiaomi 17', 'xiaomi 17 ultra', 'xiaomi 15', 'xiaomi 15 ultra', 'xiaomi 14', '15t', '14t', '13t',
      'redmi note 15', 'redmi note 14', 'redmi note 13', 'redmi note 12', 'redmi 15', 'redmi 14', 'redmi 14c', 'redmi 13', 'redmi 13c', 'redmi a5', 'redmi a3', 'redmi turbo 4', 'redmi k80', 'redmi k90',
      'poco f8', 'poco f7', 'poco f6', 'poco x8', 'poco x7', 'poco x6', 'poco m7', 'poco m6', 'poco c75',
      'redmi 9a', 'redmi 9c', 'redmi 10a', 'redmi a1', 'redmi a2', 'redmi s2', 'redmi note 5', 'redmi note 6'
    ],
    legacyMicroUsbModels: ['redmi 9a', 'redmi 9c', 'redmi 10a', 'redmi a1', 'redmi a2', 'redmi s2', 'redmi note 5', 'redmi note 6'],
    latestSummary: 'Xiaomi 15 / 17 / 18 series, 14T / 15T, Redmi Note 13–15, Redmi 13–15 / A3–A5, POCO X7 / F7 / F8',
    portNote: 'Các dòng Xiaomi, Redmi (từ Note 7, Redmi 9, A3/A5, 13–15 trở lên) và POCO đều dùng **USB Type-C** (chỉ dòng giá rẻ cũ như Redmi 9A, 9C, 10A, A1, A2 dùng **Micro-USB**).',
    osTip: 'HyperOS / MIUI hỗ trợ OTG tự nhận khi cắm. Nếu app Camera mặc định chưa ghi âm mic ngoài, chọn **Nguồn âm ngoài** trong cài đặt camera hoặc quay qua **TikTok / CapCut / Open Camera**.'
  },
  {
    id: 'honor',
    brand: 'HONOR',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: ['honor', 'magic 8', 'magic 7', 'magic 6', 'magic v5', 'magic v3', 'honor 400', 'honor 300', 'honor 200', 'honor x9c', 'honor x8c', 'honor x7c', 'honor power', 'honor 9a', 'honor 9s', 'honor 8x'],
    legacyMicroUsbModels: ['honor 9a', 'honor 9s', 'honor 8x'],
    latestSummary: 'HONOR Magic 7 / Magic 8 Pro, Magic V3 / V5, HONOR 200 / 400, X7c / X8c / X9c, HONOR Power',
    portNote: 'Toàn bộ điện thoại HONOR hiện đại đều dùng cổng **USB Type-C** (trừ mẫu rất cũ như HONOR 8X / 9A dùng **Micro-USB**).',
    osTip: 'MagicOS cắm đầu thu Type-C vào là nhận tự động; nên thử thu 10 giây trên ứng dụng quay (Camera / TikTok / CapCut) trước khi ghi hình chính.'
  },
  {
    id: 'huawei',
    brand: 'Huawei',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: ['huawei', 'pura 80', 'pura 70', 'mate 70', 'mate 60', 'mate xt', 'mate x6', 'mate x5', 'nova 14', 'nova 13', 'nova 12'],
    legacyMicroUsbModels: [],
    latestSummary: 'Huawei Pura 70 / 80, Mate 60 / 70 / Mate XT, Nova 12 / 13 / 14',
    portNote: 'Các dòng Huawei hiện đại (Pura, Mate, Nova) dùng chuẩn **USB Type-C** và hỗ trợ USB Audio OTG trực tiếp.',
    osTip: 'Cắm trực tiếp đầu thu Type-C; với các máy chạy HarmonyOS/EMUI, bạn có thể quay trên app Camera mặc định hoặc CapCut/TikTok và nghe thử lại bản thu.'
  },
  {
    id: 'pixel',
    brand: 'Google Pixel',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: ['pixel', 'google pixel', 'pixel 11', 'pixel 10', 'pixel 9', 'pixel 8', 'pixel 7', 'pixel 6', 'pixel 10a', 'pixel 9a'],
    legacyMicroUsbModels: [],
    latestSummary: 'Google Pixel 9 / 10 / 11 series, Pixel 9a / 10a, Pixel Fold',
    portNote: 'Toàn bộ điện thoại Google Pixel dùng cổng **USB Type-C** chuẩn USB Audio gốc của Android.',
    osTip: 'Cắm đầu thu Type-C nhận ngay. Trong app **Pixel Camera**, khi mở chế độ quay Video bạn có thể mở cài đặt nhanh và chọn **Micro có dây (Wired Microphone)**.'
  },
  {
    id: 'tecno',
    brand: 'Tecno Mobile',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: true,
    triggers: ['tecno', 'camon 40', 'camon 30', 'spark 40', 'spark 30', 'spark go', 'pova 7', 'pova 6', 'phantom v'],
    legacyMicroUsbModels: ['spark go 2020', 'spark go 2022', 'tecno spark 5', 'tecno spark 6'],
    latestSummary: 'Tecno Camon 30 / 40, Spark 30 / 40, Spark Go 1–3, Pova 6 / 7',
    portNote: 'Các dòng Tecno mới (Camon 30/40, Spark 30/40, Spark Go mới, Pova 6/7) đều dùng **USB Type-C** (chỉ dòng Spark đời rất cũ trước 2022 dùng Micro-USB).',
    osTip: '**Lưu ý trên Tecno (HiOS):** Nếu cắm chưa lên đèn đầu thu, hãy vuốt thanh thông báo hoặc vào **Cài đặt → Kết nối khác → bật OTG**.'
  },
  {
    id: 'infinix',
    brand: 'Infinix',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: true,
    triggers: ['infinix', 'infinix note 50', 'infinix note 40', 'infinix hot 50', 'infinix hot 40', 'infinix gt 30', 'infinix gt 20', 'zero 40'],
    legacyMicroUsbModels: [],
    latestSummary: 'Infinix Note 40 / 50, Hot 40 / 50, GT 20 / 30, Zero 40',
    portNote: 'Các dòng Infinix mới bán tại Việt Nam đều dùng cổng **USB Type-C**.',
    osTip: '**Lưu ý trên Infinix (XOS):** Nếu chưa nhận mic, vào **Cài đặt → Kết nối khác → bật OTG** rồi cắm lại sát chân.'
  },
  {
    id: 'nothing',
    brand: 'Nothing / CMF',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: ['nothing phone', 'cmf phone', 'dien thoai nothing'],
    legacyMicroUsbModels: [],
    latestSummary: 'Nothing Phone (2a) / (3a) / (3), CMF Phone 1 / Phone 2',
    portNote: 'Toàn bộ máy Nothing và CMF dùng cổng **USB Type-C**, Android thuần, tự nhận mic ngay không cần bật OTG.',
    osTip: 'Cắm trực tiếp đầu thu Type-C và chọn quay trong app Camera hoặc TikTok / CapCut.'
  },
  {
    id: 'nubia',
    brand: 'ZTE / Nubia / RedMagic',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: ['nubia', 'redmagic', 'zte', 'redmagic 11', 'redmagic 10', 'redmagic 9', 'nubia neo 3', 'nubia neo 2', 'z70 ultra'],
    legacyMicroUsbModels: [],
    latestSummary: 'RedMagic 9 / 10 / 11 Pro, Nubia Neo 2 / Neo 3 / Air / Focus / Z70 Ultra',
    portNote: 'Toàn bộ điện thoại Nubia, RedMagic và ZTE đời mới dùng cổng **USB Type-C**.',
    osTip: 'Cắm đầu thu Type-C tự nhận; ưu tiên tháo ốp tản nhiệt dày để chân cắm vào hết khớp.'
  },
  {
    id: 'asus',
    brand: 'ASUS (ROG Phone / Zenfone)',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: ['rog phone', 'zenfone', 'asus rog', 'rog 9', 'rog 8', 'rog 7', 'zenfone 12', 'zenfone 11'],
    legacyMicroUsbModels: [],
    latestSummary: 'ASUS ROG Phone 8 / 9 series, Zenfone 11 / 12 Ultra',
    portNote: 'Các dòng ASUS ROG Phone và Zenfone hiện đại đều dùng cổng **USB Type-C**.',
    osTip: 'Với dòng **ROG Phone có 2 cổng Type-C** (cạnh dưới và cạnh bên), hãy cắm đầu thu vào cổng hỗ trợ USB Data/OTG chính nếu một cổng chỉ ưu tiên sạc/phụ kiện.'
  },
  {
    id: 'sony',
    brand: 'Sony Xperia',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: ['xperia', 'sony xperia', 'dien thoai sony', 'xperia 1 vii', 'xperia 1 vi', 'xperia 1 v', 'xperia 5', 'xperia 10'],
    legacyMicroUsbModels: [],
    latestSummary: 'Sony Xperia 1 VI / 1 VII, Xperia 5 V, Xperia 10 VI',
    portNote: 'Sony Xperia hiện đại dùng cổng **USB Type-C** (không cắm đầu thu micro GAERU K9/M3 vào lỗ tai nghe 3.5mm trên máy; chỉ máy ảnh mới dùng dây 3.5mm của G1 ULTRA).',
    osTip: 'Trên Xperia Pro Video / Photography Pro, bật cấp nguồn mic ngoài hoặc quay qua TikTok / CapCut / Open Camera.'
  },
  {
    id: 'motorola_nokia',
    brand: 'Motorola / Nokia / HMD',
    defaultPort: PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: ['motorola', 'moto edge', 'razr', 'hmd', 'nokia', 'nokia c20', 'nokia c21', 'nokia g22', 'nokia g42'],
    legacyMicroUsbModels: ['nokia c20', 'nokia c21', 'nokia c10', 'nokia c1'],
    latestSummary: 'Motorola Edge 50 / 60, Razr 50 / 60, HMD Skyline, Nokia G22 / G42',
    portNote: 'Các mẫu Motorola Edge / Razr, HMD và Nokia đời mới dùng **USB Type-C** (một số mẫu Nokia cũ như C10, C20, C21 Plus dùng **Micro-USB**).',
    osTip: 'Cắm trực tiếp đầu thu tương thích; với các máy Android thuần có thể kiểm tra thêm bằng app **Open Camera** nếu app camera mặc định không chọn mic ngoài.'
  }
]);

function recommendVariantForPorts(ports, matchedProdKey = null) {
  const hasTypeC = ports.has(PORT_TYPES.TYPE_C);
  const hasLightning = ports.has(PORT_TYPES.LIGHTNING);
  const hasMicroUsb = ports.has(PORT_TYPES.MICRO_USB);

  if (matchedProdKey === 'gaeru-m3') {
    if (hasLightning && hasTypeC) return 'Trên **GAERU M3**, chọn phân loại **Type C + đầu chuyển Lightning** (`1.200.000 ₫`) để dùng cho cả hai máy.';
    if (hasLightning) return 'Trên **GAERU M3**, chọn phân loại **Type C + đầu chuyển Lightning** (`1.200.000 ₫`).';
    if (hasMicroUsb) return 'Trên **GAERU M3**, chọn phân loại **Type C + chuyển Micro usb** (`1.200.000 ₫`).';
    return 'Trên **GAERU M3**, chọn phân loại chuẩn **Type C** (`1.200.000 ₫`) — cắm trực tiếp không cần đầu chuyển.';
  }

  if (matchedProdKey === 'gaeru-k9') {
    if (hasLightning && hasTypeC) return 'Trên **GAERU K9**, chọn phân loại **Chân Type C + Chuyển Lightning** (bộ 1 mic `339.000 ₫` hoặc 2 mic `459.000 ₫`) để dùng chung được cho cả hai chuẩn chân cắm.';
    if (hasLightning) return 'Trên **GAERU K9**, chọn phân loại **Chân Lightning** (bộ 1 mic `289.000 ₫` hoặc 2 mic `409.000 ₫`) để cắm trực tiếp, hoặc **Chân Type C + Chuyển Lightning** nếu muốn dùng thêm với máy Type-C.';
    if (hasMicroUsb) return 'Trên **GAERU K9**, chọn phân loại **Chân Type C + Chuyển Micro USB** (bộ 1 mic `339.000 ₫` hoặc 2 mic `459.000 ₫`).';
    return 'Trên **GAERU K9**, chọn phân loại **Chân Type C** (bộ 1 mic `289.000 ₫` hoặc 2 mic `409.000 ₫`) — cắm trực tiếp không cần đầu chuyển.';
  }

  if (matchedProdKey === 'gaeru-g1-ultra') {
    return 'Trên **GAERU G1 ULTRA**, bộ đa thiết bị đi kèm cáp/đầu chuyển theo phân loại cho điện thoại **Type-C / Lightning**, **máy ảnh 3.5mm** và **PC**.';
  }

  // General recommendation across GAERU mics when product not specified
  if (hasLightning && hasTypeC) {
    return '**Gợi ý chọn phân loại GAERU:** Chọn **Chân Type C + Chuyển Lightning** (trên **GAERU K9** hoặc **GAERU M3**) để cắm được cho cả hai loại máy.';
  }
  if (hasLightning) {
    return '**Gợi ý chọn phân loại GAERU:** Chọn bản **Chân Lightning** (trên **GAERU K9** từ `289.000 ₫`) hoặc **Type C + đầu chuyển Lightning** (trên **GAERU M3** `1.200.000 ₫` / **K9** `339.000 ₫`).';
  }
  if (hasMicroUsb) {
    return '**Gợi ý chọn phân loại GAERU:** Chọn phân loại **Type C + chuyển Micro USB** (có sẵn trên **GAERU K9** và **GAERU M3**).';
  }
  if (hasTypeC) {
    return '**Gợi ý chọn phân loại GAERU:** Chọn bản chuẩn **Chân Type-C** (có sẵn trên **GAERU K9** từ `289.000 ₫` và **GAERU M3** `1.200.000 ₫`) — cắm trực tiếp nhận ngay.';
  }
  return '';
}

function formatAppleLabel(raw) {
  return String(raw || '')
    .replace(/\biphone\b/i, 'iPhone')
    .replace(/\bipad\b/i, 'iPad')
    .replace(/\b(plus|pro|max|mini|air)\b/gi, m => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase())
    .replace(/\b(xs|xr|x|se)\b/gi, m => m.toUpperCase());
}

function detectAppleDeviceInfo(space, hasAndroidMatch = false) {
  const matchedTypeC = APPLE_TYPE_C_SERIES.filter(m => hasAnyBoundaryTerm(space, [m]));
  const matchedLightning = APPLE_LIGHTNING_SERIES.filter(m => hasAnyBoundaryTerm(space, [m]));
  const matchedIpadC = IPAD_TYPE_C_MODELS.filter(m => hasAnyBoundaryTerm(space, [m]));
  const matchedIpadL = IPAD_LIGHTNING_MODELS.filter(m => hasAnyBoundaryTerm(space, [m]));

  const hasExplicitApple = hasAnyBoundaryTerm(space, ['iphone', 'ipad', 'ios', 'apple']) ||
    (!hasAndroidMatch && hasAnyBoundaryTerm(space, ['lightning']));
  const ports = new Set();
  const lines = [];

  if (matchedTypeC.length) {
    ports.add(PORT_TYPES.TYPE_C);
    const label = formatAppleLabel(matchedTypeC[matchedTypeC.length - 1]);
    lines.push(`- **${label}** dùng cổng **USB Type-C** (toàn bộ iPhone 15, 16, 16e, 17, 17 Air và iPhone 18 series): Cắm trực tiếp đầu thu **Type-C** nhận ngay không cần đầu chuyển (khác với **iPhone 14 trở xuống** dùng chân **Lightning**).`);
  }

  if (matchedLightning.length) {
    ports.add(PORT_TYPES.LIGHTNING);
    const label = formatAppleLabel(matchedLightning[matchedLightning.length - 1]);
    lines.push(`- **${label}** dùng chân cắm **Lightning** (áp dụng cho iPhone 14 series trở xuống): Chọn phân loại **Chân Lightning** hoặc bản **Type-C + đầu chuyển Lightning** nếu muốn dùng chung với máy đời mới.`);
  }

  if (matchedIpadC.length) {
    ports.add(PORT_TYPES.TYPE_C);
    lines.push('- **iPad đời mới** (iPad Gen 10/11, Air 4/5/M2/M3+, mini 6/7, iPad Pro 2018–M4/M5) dùng cổng **USB Type-C** — cắm trực tiếp đầu thu Type-C.');
  } else if (matchedIpadL.length) {
    ports.add(PORT_TYPES.LIGHTNING);
    lines.push('- **iPad đời cũ** (iPad Gen 9 trở xuống, Air 3 trở xuống, mini 5 trở xuống) dùng chân **Lightning** — chọn đầu thu hoặc đầu chuyển Lightning.');
  } else if (hasAnyBoundaryTerm(space, ['ipad'])) {
    ports.add(PORT_TYPES.TYPE_C);
    ports.add(PORT_TYPES.LIGHTNING);
    lines.push('- **iPad:** Các mẫu mới (Gen 10/11, Air 4+, mini 6+, Pro 2018+) dùng **Type-C**; các mẫu cũ (Gen 9 trở xuống, mini 5 trở xuống, Air 3 trở xuống) dùng **Lightning**.');
  }

  if (!matchedTypeC.length && !matchedLightning.length && hasExplicitApple) {
    if (hasAnyBoundaryTerm(space, ['type c']) && !hasAnyBoundaryTerm(space, ['lightning'])) {
      ports.add(PORT_TYPES.TYPE_C);
    } else if (hasAnyBoundaryTerm(space, ['lightning']) && !hasAnyBoundaryTerm(space, ['type c'])) {
      ports.add(PORT_TYPES.LIGHTNING);
    } else {
      ports.add(PORT_TYPES.TYPE_C);
      ports.add(PORT_TYPES.LIGHTNING);
    }
    lines.push('- **iPhone 15 / 16 / 16e / 17 / 17 Air / 18 series** dùng cổng **USB Type-C** (cắm trực tiếp); **iPhone 14 trở xuống** (14, 13, 12, 11, XS/XR/X, 8, SE 1–3) dùng chân **Lightning**.');
  }

  return { matched: hasExplicitApple || lines.length > 0, ports, lines };
}

function detectAndroidBrandMatches(space) {
  const matches = [];
  for (const profile of BRAND_PROFILES) {
    if (hasAnyBoundaryTerm(space, profile.triggers)) {
      const legacyHits = profile.legacyMicroUsbModels.filter(m => hasAnyBoundaryTerm(space, [m]));
      const detectedPort = legacyHits.length > 0 ? PORT_TYPES.MICRO_USB : profile.defaultPort;
      matches.push({ profile, detectedPort, legacyHits });
    }
  }
  return matches;
}

function buildPhoneDirectorySummary() {
  return [
    '**Tổng hợp chuẩn chân cắm các dòng điện thoại mới nhất (2025–2026) khi chọn mic GAERU:**',
    '- **Chân USB Type-C (cắm trực tiếp không cần đầu chuyển):** Toàn bộ **iPhone 15 / 16 / 16e / 17 / 17 Air / 18**, iPad Gen 10+/Air 4+/Pro, và hầu hết Android mới (**Samsung S24–S26 / Z Fold 7 / Flip 7 / A36–A56**, **Xiaomi 14–18 / Redmi Note 13–15 / POCO X7–F8**, **OPPO Find X8–X10 / Reno12–16**, **Realme 14–16 / GT7**, **vivo X200–X300 / V40–V60**, **HONOR Magic 7–8 / 200–400**, **Huawei Pura 70–80 / Mate 70**, **Google Pixel 8–11**, **Tecno Camon 30–40**, **Infinix Note 40–50**, **Nothing Phone**, **ROG Phone / RedMagic / Sony Xperia**).',
    '- **Chân Lightning:** **iPhone 14 series trở xuống** (14, 13, 12, 11, X/XS/XR, 8, SE 1–3) và iPad Gen 9 / Air 3 / mini 5 trở xuống (chọn bản **Chân Lightning** hoặc **Type C + đầu chuyển Lightning**).',
    '- **Chân Micro-USB (máy Android phổ thông đời cũ trước 2020):** Samsung J7 Prime / A10s, OPPO A3s / A12 / A15, Redmi 9A / 9C / 10A, vivo Y11 / Y12 / Y20 (chọn bản **Type C + chuyển Micro USB** trên GAERU K9 hoặc M3).',
    '- **Lưu ý bật OTG:** Các máy **OPPO, Realme, Vivo, OnePlus, Tecno, Infinix** cần vào **Cài đặt → bật Kết nối OTG** trước khi cắm đầu thu micro.'
  ].join('\n');
}

/**
 * Sinh câu trả lời chuyên sâu về tương thích điện thoại, hãng máy & chân cắm kết nối.
 */
function buildComprehensiveCompatibilityAnswer(space, rawQuestion, matchedProdKey = null) {
  const qNorm = space || normalizeSearchSpace(expandQueryVi(rawQuestion));

  // Trường hợp sản phẩm là Gimbal P01 hoặc Gậy chụp hình P185 (không phụ thuộc cổng sạc/âm thanh)
  if (matchedProdKey === 'gaeru-p01' || matchedProdKey === 'gaeru-p185') {
    const productName = matchedProdKey === 'gaeru-p01' ? 'GAERU P01' : 'GAERU P185';
    const extra = matchedProdKey === 'gaeru-p185'
      ? 'Chụp/quay từ xa qua **Bluetooth** (remote sạc Type-C độc lập).'
      : 'Gimbal AI nhận diện khuôn mặt độc lập bằng cảm biến trên thân máy, không cần cắm dây vào điện thoại.';
    return `**${productName}** kẹp giữ thân máy trực tiếp nên **tương thích 100% mọi dòng iPhone (5 đến 18 series) và mọi hãng Android** (Samsung, OPPO, Xiaomi, vivo, HONOR, Pixel…), không phân biệt chân cắm Type-C hay Lightning. ${extra}`;
  }

  // Trường hợp khách hỏi tổng quát danh sách các hãng/đời máy và chân cắm hiện nay
  const asksDirectory = hasAnyBoundaryTerm(qNorm, [
    'cac loai dien thoai', 'cac dong dien thoai', 'cac hang dien thoai', 'tat ca dien thoai',
    'danh sach dien thoai', 'nhung dong may nao', 'dien thoai nao dung', 'hang dien thoai nao'
  ]);
  if (asksDirectory) {
    return buildPhoneDirectorySummary();
  }

  const sections = [];
  const portsFound = new Set();

  const brandMatches = detectAndroidBrandMatches(qNorm);
  const appleInfo = detectAppleDeviceInfo(qNorm, brandMatches.length > 0);
  if (appleInfo.matched) {
    appleInfo.ports.forEach(p => portsFound.add(p));
    sections.push(...appleInfo.lines);
  }
  const asksGenericAndroid = hasAnyBoundaryTerm(qNorm, ['android', 'otg', 'khong nhan', 'chua sang', 'den khong sang', 'mat tieng', 'khong co tieng', 'micro usb']);

  if (brandMatches.length > 0) {
    for (const m of brandMatches) {
      portsFound.add(m.detectedPort);
      if (m.detectedPort === PORT_TYPES.MICRO_USB) {
        sections.push(`- **${m.profile.brand} (${m.legacyHits.join(', ').toUpperCase()})** dùng chân sạc **Micro-USB** đời cũ (không phải Type-C) → bạn chọn phân loại **Type C + chuyển Micro USB** trên **GAERU K9** hoặc **GAERU M3**.`);
      } else {
        sections.push(`- **${m.profile.brand}:** ${m.profile.portNote}`);
      }
      if (m.profile.osTip) {
        sections.push(`  ${m.profile.osTip}`);
      }
    }
  } else if (asksGenericAndroid) {
    if (hasAnyBoundaryTerm(qNorm, ['micro usb'])) {
      portsFound.add(PORT_TYPES.MICRO_USB);
      sections.push('- Điện thoại Android đời cũ cổng **Micro-USB** (như Samsung J7, OPPO A3s/A12, Redmi 9A/9C, vivo Y11/Y12): chọn phân loại **Type C + chuyển Micro USB** có sẵn trên **GAERU K9** và **GAERU M3** (lưu ý bật OTG nếu máy OPPO/Realme/Vivo).');
    } else {
      portsFound.add(PORT_TYPES.TYPE_C);
      sections.push('- **Android (Samsung, Xiaomi, HONOR, Pixel, Nothing…):** Các dòng hiện đại dùng cổng **USB Type-C** tự nhận khi cắm; riêng **OPPO, Realme, Vivo, OnePlus, Tecno, Infinix** cần vào **Cài đặt → bật Kết nối OTG** trước khi cắm đầu thu (tháo ốp dày nếu cấn chân).');
      sections.push('- Nếu app Camera mặc định chưa lấy tiếng mic ngoài, hãy quay bằng **TikTok / CapCut** hoặc tải **Open Camera** (chọn *Nguồn âm thanh: Micro ngoài*).');
    }
  }

  // Cảnh báo nếu khách nhắc tới cổng 3.5mm trên điện thoại
  if (hasAnyBoundaryTerm(qNorm, ['3.5mm', 'jack 3.5', 'lo tron', 'tai nghe']) && !hasAnyBoundaryTerm(qNorm, ['may anh', 'camera', 'canon', 'sony alpha', 'fujifilm', 'nikon'])) {
    sections.push('- **Lưu ý cổng 3.5mm trên điện thoại:** Đầu thu mic GAERU K9 và M3 cắm vào **cổng sạc (Type-C / Lightning / chuyển Micro-USB)**, không cắm vào lỗ tai nghe 3.5mm trên điện thoại (cáp 3.5mm TRS chỉ dùng cho **máy ảnh** trên dòng G1 ULTRA).');
  }

  const asksPc = hasAnyBoundaryTerm(qNorm, ['may tinh', 'laptop', 'pc', 'macbook', 'windows', 'obs']);
  if (asksPc) {
    if (matchedProdKey === 'gaeru-g1-ultra') {
      sections.push('- **Máy tính / Laptop:** **GAERU G1 ULTRA** hỗ trợ cắm trực tiếp PC/Laptop và nhận làm nguồn mic mặc định trên Zoom, OBS Studio, CapCut PC.');
    } else {
      sections.push('- **Máy tính / Laptop (Windows, MacBook):** Cắm đầu thu **Type-C** trực tiếp vào cổng USB-C, hoặc chọn bản **Type C + chuyển USB (USB-A)** trên K9/M3 để cắm vào cổng USB thường trên máy tính → chọn *Wireless Microphone* trong Sound Input.');
    }
  }

  const asksCamera = hasAnyBoundaryTerm(qNorm, ['may anh', 'camera', 'sony', 'canon', 'fujifilm', 'nikon', '3.5mm', 'jack 3.5']) &&
    !hasAnyBoundaryTerm(qNorm, ['xperia', 'open camera', 'app camera']);
  if (asksCamera) {
    if (matchedProdKey === 'gaeru-g1-ultra') {
      sections.push('- **GAERU G1 ULTRA** kết nối trực tiếp với **máy ảnh** qua dây âm thanh **3.5mm TRS** đi kèm.');
    } else if (hasAnyBoundaryTerm(qNorm, ['may anh', 'canon', 'fujifilm', 'nikon', 'sony'])) {
      sections.push('- Để cắm trực tiếp **máy ảnh (ngõ Mic 3.5mm)**, dòng phù hợp nhất là **GAERU G1 ULTRA** (K9 và M3 tiêu chuẩn thiết kế cho cổng Type-C / Lightning / USB của điện thoại và PC).');
    }
  }

  const asksNoise = hasAnyBoundaryTerm(qNorm, ['loc am', 'loc on', 'loc tieng on', 'chong on', 'khu on', 'tieng on', 'tap am', 'anc', 'dsp']);
  if (asksNoise && sections.length === 0 && !matchedProdKey) {
    sections.push('- Các dòng micro GAERU (**K9**, **M3**, **G1 ULTRA**) đều tích hợp xử lý giảm ồn **DSP / AI** + bông lọc gió giúp lọc tạp âm, gió và tiếng ồn môi trường.');
  }

  const asksAppCompat = hasAnyBoundaryTerm(qNorm, ['tiktok', 'capcut', 'facebook', 'youtube', 'zoom', 'shopee', 'app', 'open camera']) ||
    (hasAnyBoundaryTerm(qNorm, ['livestream']) && hasAnyBoundaryTerm(qNorm, ['dung duoc', 'tuong thich', 'ho tro', 'ket noi']) && !hasAnyBoundaryTerm(qNorm, ['thiet bi']));
  if (asksAppCompat && sections.length === 0) {
    sections.push('- Thiết bị GAERU tương thích trực tiếp với **TikTok, CapCut, Facebook Live, YouTube, Shopee Live, Zoom** (cắm đầu thu vào máy là dùng ngay trên app, không cần ghép Bluetooth để thu tiếng).');
  }

  // Bổ sung gợi ý phân loại chân cắm chính xác theo thiết bị khách đang hỏi
  if (portsFound.size > 0 && sections.length > 0) {
    const rec = recommendVariantForPorts(portsFound, matchedProdKey);
    if (rec && !sections.some(s => s.includes('Gợi ý chọn phân loại'))) {
      sections.push(`- ${rec}`);
    }
  }

  return sections.join('\n');
}

module.exports = {
  PORT_TYPES,
  APPLE_TYPE_C_SERIES,
  APPLE_LIGHTNING_SERIES,
  IPAD_TYPE_C_MODELS,
  IPAD_LIGHTNING_MODELS,
  BRAND_PROFILES,
  detectAppleDeviceInfo,
  detectAndroidBrandMatches,
  recommendVariantForPorts,
  buildPhoneDirectorySummary,
  buildComprehensiveCompatibilityAnswer
};
