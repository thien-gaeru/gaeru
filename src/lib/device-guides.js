'use strict';

/**
 * Cơ sở dữ liệu mở rộng & Hướng dẫn kỹ thuật chuyên sâu GAERU AI:
 * 1. Máy tính bảng (Tablets: iPad, Samsung Galaxy Tab, Xiaomi/Redmi Pad, OPPO Pad, vivo Pad, Huawei MatePad, HONOR Pad, Lenovo Tab, Microsoft Surface, Fire/Masstel).
 * 2. Laptop (MacBook Air/Pro Intel & Apple Silicon M1–M5, Dell, HP, ASUS, Lenovo, Acer, MSI, LG Gram, Huawei MateBook, Surface Laptop).
 * 3. PC / Máy tính để bàn & All-in-One (Windows Desktop/Mainboard/Case, iMac Intel & M1–M4, Mac mini, Mac Studio).
 * 4. Hướng dẫn bật Kết nối OTG chi tiết cho từng hãng Android cần bật OTG.
 * 5. Hướng dẫn bật Tùy chọn nhà phát triển → Gỡ lỗi USB + tắt định tuyến âm thanh USB từng hãng Android.
 * 6. Hướng dẫn chọn Mic gắn ngoài trên iOS mới (iOS 18+) và phân biệt rõ iOS dưới 18 không cần chọn thủ công.
 */

const { hasAnyBoundaryTerm, hasBoundaryTerm } = require('./ai-nlu');

const EXT_PORT_TYPES = Object.freeze({
  TYPE_C: 'type-c',
  LIGHTNING: 'lightning',
  MICRO_USB: 'micro-usb',
  USB_A: 'usb-a'
});

/**
 * Hồ sơ Máy tính bảng Android / Windows (ngoài iPad đã xử lý ở phone-compatibility).
 */
const TABLET_PROFILES = Object.freeze([
  {
    id: 'galaxy_tab',
    label: 'Samsung Galaxy Tab',
    defaultPort: EXT_PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: [
      'galaxy tab', 'tab s11', 'tab s10', 'tab s9', 'tab s8', 'tab s7', 'tab s6',
      'tab a9', 'tab a8', 'tab a7', 'tab s10 fe', 'tab s9 fe', 'tab s6 lite',
      'tab e', 'tab a6', 'tab s2'
    ],
    modernModels: ['tab s11', 'tab s10', 'tab s9', 'tab s8', 'tab s7', 'tab s6', 'tab a9', 'tab a8', 'tab a7', 'tab s10 fe', 'tab s9 fe', 'tab s6 lite'],
    legacyMicroUsb: ['tab e', 'tab a6', 'tab a 2016', 'tab s2', 't561', 't285', 't585'],
    portNote: 'Các dòng **Samsung Galaxy Tab hiện đại** (Tab S6–S11, S9/S10 FE, Tab A7/A8/A9/A9+) đều dùng cổng **USB Type-C** và tự nhận mic không cần bật OTG (trừ các mẫu rất cũ như Tab E, Tab A6 2016 dùng **Micro-USB**).'
  },
  {
    id: 'xiaomi_pad',
    label: 'Xiaomi Pad / Redmi Pad / POCO Pad',
    defaultPort: EXT_PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: ['xiaomi pad', 'mi pad', 'redmi pad', 'poco pad', 'pad 7', 'pad 6s pro', 'pad 6', 'pad 5', 'redmi pad pro', 'redmi pad se'],
    legacyMicroUsb: [],
    portNote: 'Toàn bộ **Xiaomi Pad (5 / 6 / 6S Pro / 7)**, **Redmi Pad / SE / Pro** và **POCO Pad** dùng cổng **USB Type-C** (tự nhận OTG khi cắm trực tiếp; nếu app quay mặc định chưa nhận tiếng, chọn nguồn âm ngoài hoặc quay qua CapCut / TikTok / Open Camera).'
  },
  {
    id: 'oppo_tab',
    label: 'OPPO Pad / OnePlus Pad',
    defaultPort: EXT_PORT_TYPES.TYPE_C,
    requiresManualOtg: true,
    triggers: ['oppo pad', 'pad neo', 'pad air', 'pad se', 'oneplus pad'],
    legacyMicroUsb: [],
    portNote: 'Toàn bộ **OPPO Pad (Air / Neo / Pad 2 / Pad 3)** và **OnePlus Pad** dùng cổng **USB Type-C**. Lưu ý vào **Cài đặt → Cài đặt bổ sung → bật Kết nối OTG** trước khi cắm đầu thu.'
  },
  {
    id: 'vivo_tab',
    label: 'vivo Pad / iQOO Pad',
    defaultPort: EXT_PORT_TYPES.TYPE_C,
    requiresManualOtg: true,
    triggers: ['vivo pad', 'iqoo pad'],
    legacyMicroUsb: [],
    portNote: 'Các dòng **vivo Pad / Pad Air / Pad 3 Pro** và **iQOO Pad** dùng cổng **USB Type-C** (nhớ vào **Cài đặt → Bluetooth và thiết bị → bật OTG** nếu cắm đầu thu chưa sáng đèn).'
  },
  {
    id: 'huawei_honor_tab',
    label: 'Huawei MatePad / HONOR Pad',
    defaultPort: EXT_PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: ['matepad', 'huawei matepad', 'honor pad', 'magicpad'],
    legacyMicroUsb: [],
    portNote: '**Huawei MatePad (11 / 11.5 / Pro / Air / SE)** và **HONOR Pad (8 / 9 / X8a / X9 / MagicPad 2)** đều dùng cổng **USB Type-C**, tự nhận mic ngoài trực tiếp.'
  },
  {
    id: 'lenovo_tab',
    label: 'Lenovo Tab / Legion Tab',
    defaultPort: EXT_PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: ['lenovo tab', 'legion y700', 'legion tab', 'xiaoxin pad', 'tab p11', 'tab p12', 'tab m11', 'tab m10'],
    modernModels: ['legion y700', 'legion tab', 'xiaoxin pad', 'tab p11', 'tab p12', 'tab m11', 'tab m10'],
    legacyMicroUsb: ['lenovo tab 4', 'tab e7', 'tab e8', 'tab e10'],
    portNote: '**Lenovo Tab hiện đại** (M10 Plus Gen 3, M11, P11, P12, Xiaoxin Pad, Legion Y700) dùng cổng **USB Type-C** (chỉ vài dòng cũ trước 2019 như Tab 4 / Tab E7–E8 dùng **Micro-USB**).'
  },
  {
    id: 'surface_tablet',
    label: 'Microsoft Surface (Pro / Go)',
    defaultPort: EXT_PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: ['surface pro', 'surface go', 'surface book', 'microsoft surface', 'surface'],
    modernModels: ['surface pro 7', 'surface pro 8', 'surface pro 9', 'surface pro 10', 'surface pro 11', 'surface go 2', 'surface go 3', 'surface go 4'],
    legacyUsbAOnly: ['surface pro 4', 'surface pro 5', 'surface pro 6', 'surface pro 3'],
    portNote: '**Surface Pro 7 / 8 / 9 / 10 / 11** và **Surface Go 2 / 3 / 4** có cổng **USB Type-C** hỗ trợ dữ liệu/âm thanh (riêng Surface Pro 4 / 5 / 6 cũ chỉ có **USB-A**, nên chọn bản **Type C + chuyển USB**).'
  },
  {
    id: 'other_tablet',
    label: 'Máy tính bảng khác (Fire HD / Masstel / Teclast / Alldocube)',
    defaultPort: EXT_PORT_TYPES.TYPE_C,
    requiresManualOtg: false,
    triggers: ['fire hd', 'amazon fire', 'kindle fire', 'masstel', 'teclast', 'alldocube', 'blackview tab'],
    legacyMicroUsb: ['fire 7 2017', 'fire hd 8 2018', 'fire hd 10 2017', 'masstel tab 8'],
    portNote: 'Các mẫu máy tính bảng đời mới (từ 2020–2026) dùng cổng **USB Type-C**; riêng máy phổ thông/trẻ em sản xuất trước 2020 thường dùng **Micro-USB** — bạn nhìn kỹ hình dạng lỗ sạc dẹt (cân đối 2 đầu là **Type-C**, một mặt dẹt một mặt vát thang là **Micro-USB**).'
  }
]);

const APPLE_LAPTOP_TYPE_C_MODELS = Object.freeze([
  'macbook air m1', 'macbook air m2', 'macbook air m3', 'macbook air m4', 'macbook air m5',
  'macbook pro m1', 'macbook pro m2', 'macbook pro m3', 'macbook pro m4', 'macbook pro m5',
  'macbook m1', 'macbook m2', 'macbook m3', 'macbook m4', 'macbook m5',
  'macbook pro 14', 'macbook pro 16', 'macbook pro 13', 'macbook air 13', 'macbook air 15',
  'macbook 12', 'macbook 2018', 'macbook 2019', 'macbook 2020', 'macbook 2021', 'macbook 2022',
  'macbook 2023', 'macbook 2024', 'macbook 2025', 'macbook 2026'
]);

const APPLE_LAPTOP_LEGACY_USBA = Object.freeze([
  'macbook air 2017', 'macbook air 2016', 'macbook air 2015', 'macbook air 2014', 'macbook air 2013',
  'macbook pro 2015', 'macbook pro 2014', 'macbook pro 2013', 'macbook pro 2012'
]);

const WINDOWS_LAPTOP_BRANDS = Object.freeze([
  'laptop', 'may tinh xach tay', 'ultrabook', 'chromebook', 'thinkpad', 'ideapad', 'legion', 'yoga', 'loq',
  'zenbook', 'vivobook', 'tuf gaming', 'rog strix', 'rog zephyrus', 'dell xps', 'inspiron', 'latitude', 'vostro',
  'hp pavilion', 'hp envy', 'hp spectre', 'hp victus', 'hp probook', 'hp elitebook', 'omen',
  'acer swift', 'acer aspire', 'acer nitro', 'predator', 'msi modern', 'msi prestige', 'msi katana', 'msi thin',
  'lg gram', 'matebook', 'surface laptop', 'gigabyte aero'
]);

const DESKTOP_PC_TRIGGERS = Object.freeze([
  'pc', 'desktop', 'may tinh ban', 'may tinh de ban', 'case may tinh', 'cay may tinh', 'mainboard', 'bo mach chu',
  'imac', 'mac mini', 'mac studio', 'mac pro', 'all in one', 'optiplex', 'prodesk', 'thinkcentre', 'may tinh'
]);

/**
 * Nhận diện Máy tính bảng, Laptop và PC cùng cổng kết nối chính xác.
 */
function detectTabletLaptopPcInfo(space, { hasPhoneMatch = false } = {}) {
  const ports = new Set();
  const lines = [];
  let matched = false;
  const manualOtgBrands = [];

  // 1. Máy tính bảng Android / Surface
  const matchedTablets = TABLET_PROFILES.filter(t => hasAnyBoundaryTerm(space, t.triggers));
  for (const tab of matchedTablets) {
    matched = true;
    const isLegacyMicro = Array.isArray(tab.legacyMicroUsb) && tab.legacyMicroUsb.some(m => hasBoundaryTerm(space, m));
    const isLegacyUsbA = Array.isArray(tab.legacyUsbAOnly) && tab.legacyUsbAOnly.some(m => hasBoundaryTerm(space, m));
    const hasModernExplicit = Array.isArray(tab.modernModels) && tab.modernModels.some(m => hasBoundaryTerm(space, m));
    if (isLegacyMicro || isLegacyUsbA) {
      if (isLegacyMicro) {
        ports.add(EXT_PORT_TYPES.MICRO_USB);
        lines.push(`- **${tab.label} đời cũ** dùng cổng **Micro-USB** → chọn bản **Type C + chuyển Micro USB** trên **GAERU K9** hoặc **GAERU M3**.`);
      }
      if (isLegacyUsbA) {
        ports.add(EXT_PORT_TYPES.USB_A);
        lines.push(`- **${tab.label} đời cũ** chỉ có cổng **USB-A (chữ nhật)** → chọn bản **Type C + chuyển USB** để cắm trực tiếp vào máy.`);
      }
      if (hasModernExplicit) {
        ports.add(tab.defaultPort);
        lines.push(`- **${tab.label} đời mới:** ${tab.portNote}`);
      }
    } else {
      ports.add(tab.defaultPort);
      lines.push(`- **${tab.label}:** ${tab.portNote}`);
      if (tab.requiresManualOtg) manualOtgBrands.push(tab.id === 'oppo_tab' ? 'oppo' : 'vivo');
    }
  }

  // Câu hỏi chung về máy tính bảng (tablet / mtb) khi chưa nêu hãng cụ thể
  if (!matchedTablets.length && hasAnyBoundaryTerm(space, ['may tinh bang', 'tablet', 'mtb']) && !hasBoundaryTerm(space, 'ipad')) {
    matched = true;
    ports.add(EXT_PORT_TYPES.TYPE_C);
    lines.push('- **Máy tính bảng (Tablet):** Các mẫu hiện đại (**Samsung Galaxy Tab S/A đời mới, Xiaomi/Redmi Pad, OPPO Pad, Huawei MatePad, HONOR Pad, Lenovo Tab, Surface Pro 7+/Go 2–4**) dùng **USB Type-C** (riêng **OPPO Pad / vivo Pad** nhớ bật **Kết nối OTG**). iPad từ **Gen 10 / Air 4 / mini 6 / Pro 2018+** dùng **Type-C**, iPad cũ hơn dùng **Lightning**; tablet giá rẻ trước 2019 dùng **Micro-USB**.');
  }

  // 2. Laptop Apple MacBook
  const isMacbook = hasAnyBoundaryTerm(space, ['macbook', 'mb pro', 'mb air', 'mac air', 'mac pro']);
  if (isMacbook) {
    matched = true;
    const isModernMac = APPLE_LAPTOP_TYPE_C_MODELS.some(m => hasBoundaryTerm(space, m));
    const isLegacyMac = APPLE_LAPTOP_LEGACY_USBA.some(m => hasBoundaryTerm(space, m));
    const hasExplicitUsbA = hasAnyBoundaryTerm(space, ['usb a', 'usb thuong', 'chuyen usb', 'khong co type c']);
    if (isLegacyMac || hasExplicitUsbA) {
      ports.add(EXT_PORT_TYPES.USB_A);
      lines.push('- **MacBook đời 2012–2017** (MacBook Air 2012–2017 / Pro 2012–2015) chỉ có cổng **USB-A** chữ nhật → chọn bản **Type C + chuyển USB** (`K9: Chân Type C + Chuyển USB` hoặc `M3: Type C + chuyển USB`).');
    }
    if (isModernMac || (!isLegacyMac && !hasExplicitUsbA)) {
      ports.add(EXT_PORT_TYPES.TYPE_C);
      lines.push('- **MacBook Air / MacBook Pro (2016 trở lên & dòng chip M1 / M2 / M3 / M4 / M5):** Toàn bộ dùng cổng **USB Type-C (Thunderbolt / USB4)** → cắm trực tiếp bản **Type C** là nhận ngay (vào *Cài đặt hệ thống → Âm thanh → Đầu vào* chọn **Wireless Microphone**).');
    }
  }

  // 3. Laptop Windows / Chromebook / Linux
  const isWinLaptop = hasAnyBoundaryTerm(space, WINDOWS_LAPTOP_BRANDS) && !isMacbook;
  if (isWinLaptop) {
    matched = true;
    const laptopExplicitTypeC = hasAnyBoundaryTerm(space, ['co type c', 'cong type c', 'cong c', 'thunderbolt', 'usb 4']);
    const laptopNoTypeC = hasAnyBoundaryTerm(space, ['usb a', 'usb thuong', 'chi co usb', 'khong co type c', 'laptop cu', 'doi cu']);
    if (laptopExplicitTypeC && !laptopNoTypeC) {
      ports.add(EXT_PORT_TYPES.TYPE_C);
      lines.push('- **Laptop Windows có cổng USB-C (Thunderbolt / USB 3.x truyền dữ liệu):** Có thể cắm trực tiếp đầu thu **Type-C** (nếu cổng Type-C trên máy chỉ hỗ trợ sạc mà không truyền âm thanh USB, hoặc muốn cắm ổn định qua cổng USB chữ nhật của Laptop/PC, chọn bản **Type C + chuyển USB**).');
    } else {
      ports.add(EXT_PORT_TYPES.USB_A);
      lines.push('- **Laptop Windows (Dell, HP, ASUS, Lenovo, Acer, MSI, Surface…):** Laptop mới thường có cả **USB Type-C** và **USB-A**, còn dòng phổ thông/đời cũ thường dùng **USB-A** (hoặc cổng C chỉ để sạc). An toàn và linh hoạt nhất là chọn phân loại **Type C + chuyển USB** (`K9: Chân Type C + Chuyển USB` hoặc `M3: Type C + chuyển USB`) để cắm vừa cổng USB chữ nhật của laptop lẫn cổng Type-C của điện thoại/laptop mới.');
    }
  }

  // 4. Desktop PC / iMac / Mac mini / Mac Studio
  const isAppleDesktop = hasAnyBoundaryTerm(space, ['imac', 'mac mini', 'mac studio']);
  const explicitDesktopOnly = DESKTOP_PC_TRIGGERS.filter(t => !['imac', 'mac mini', 'mac studio', 'mac pro', 'may tinh'].includes(t));
  const isDesktopPc = hasAnyBoundaryTerm(space, explicitDesktopOnly) ||
    (!isMacbook && !isWinLaptop && hasAnyBoundaryTerm(space, DESKTOP_PC_TRIGGERS));
  if (isAppleDesktop) {
    matched = true;
    const isModernMacMiniOrImac = hasAnyBoundaryTerm(space, ['imac m1', 'imac m3', 'imac m4', 'mac mini m4', 'm4 pro']);
    const isIntelOld = hasAnyBoundaryTerm(space, ['intel', 'cu', 'usb a', 'usb thuong']);
    if (isModernMacMiniOrImac) {
      ports.add(EXT_PORT_TYPES.TYPE_C);
      lines.push('- **iMac (M1/M3/M4) & Mac mini M4 (2024–2026):** Apple đã dùng chuẩn **USB-C / Thunderbolt**, nên cắm trực tiếp đầu thu **Type-C** không cần đầu chuyển.');
    } else if (isIntelOld) {
      ports.add(EXT_PORT_TYPES.USB_A);
      lines.push('- **iMac / Mac mini đời Intel cũ:** Dùng cổng **USB-A** phổ thông → chọn bản **Type C + chuyển USB** (`K9` hoặc `M3`).');
    } else {
      ports.add(EXT_PORT_TYPES.TYPE_C);
      ports.add(EXT_PORT_TYPES.USB_A);
      lines.push('- **iMac / Mac mini / Mac Studio:** Đời mới (iMac M1–M4, Mac mini M4) dùng **USB-C** trực tiếp; các đời Intel hoặc Mac mini M1–M2 có thêm cổng **USB-A** — chọn bản **Type C** (nếu máy có cổng C) hoặc **Type C + chuyển USB** nếu muốn cắm cổng USB-A.');
    }
  }
  if (isDesktopPc && !isAppleDesktop) {
    matched = true;
    const pcTypeC = hasAnyBoundaryTerm(space, ['co type c', 'cong type c', 'type c phia truoc']);
    if (pcTypeC) {
      ports.add(EXT_PORT_TYPES.TYPE_C);
      lines.push('- **PC / Máy tính để bàn có cổng Type-C truyền dữ liệu:** Cắm trực tiếp bản **Type-C** vào cổng USB-C của mainboard/case (hoặc chọn **Type C + chuyển USB** để cắm thêm vào cổng USB-A truyền thống phía sau máy).');
    } else {
      ports.add(EXT_PORT_TYPES.USB_A);
      lines.push('- **PC / Máy tính để bàn (Windows Case / Mainboard ASUS, Gigabyte, MSI, ASRock / All-in-One):** Hầu hết dùng cổng **USB-A chữ nhật** ở sau mainboard hoặc mặt trước case → bạn chọn phân loại **Type C + chuyển USB** (`K9: Chân Type C + Chuyển USB` hoặc `M3: Type C + chuyển USB`), cắm vào cổng USB phía sau mainboard sẽ ổn định nguồn và ít nhiễu nhất.');
    }
  }

  // Bổ sung hướng dẫn thiết lập âm thanh Windows/macOS nếu hỏi PC/Laptop/OBS/Zoom
  if ((isMacbook || isWinLaptop || isDesktopPc) && !hasPhoneMatch) {
    lines.push('- **Thiết lập nhận mic trên Windows / macOS:** Không cắm đầu thu K9/M3 vào lỗ jack mic 3.5mm màu hồng. Sau khi cắm qua USB-A/USB-C: vào **Sound Settings → Input (Windows)** hoặc **System Settings → Sound → Input (macOS)** chọn **Wireless Microphone** và cấp quyền Microphone trên **OBS, Zoom, CapCut PC, TikTok Live Studio**.');
  } else if (isMacbook || isWinLaptop || isDesktopPc) {
    lines.push('- **Lưu ý trên Laptop/PC:** Đầu thu K9/M3 kết nối qua cổng kỹ thuật số USB (Type-C hoặc qua đầu chuyển USB-A), không cắm vào lỗ tai nghe 3.5mm; chọn *Wireless Microphone* ở mục Microphone Input.');
  }

  return { matched, ports, lines, manualOtgBrands };
}

const OTG_BRAND_STEPS = Object.freeze({
  oppo: {
    title: 'OPPO / OPPO Pad (ColorOS)',
    step: '**Cài đặt (Settings) → Cài đặt hệ thống / Cài đặt bổ sung (System / Additional settings) → bật Kết nối OTG (OTG connection)** (hoặc gõ `OTG` vào thanh tìm kiếm đầu trang Cài đặt). *Lưu ý: Tự tắt sau 10 phút nếu rút đầu thu.*'
  },
  realme: {
    title: 'Realme (Realme UI)',
    step: '**Cài đặt → Cài đặt bổ sung / Cài đặt hệ thống → bật Kết nối OTG** (cần bật lại nếu để quá 10 phút không cắm thiết bị).'
  },
  oneplus: {
    title: 'OnePlus (OxygenOS)',
    step: '**Cài đặt → Cài đặt bổ sung → bật Kết nối OTG** trước khi cắm đầu thu.'
  },
  vivo: {
    title: 'vivo / iQOO & vivo Pad (Funtouch OS / OriginOS)',
    step: '**Cài đặt → Bluetooth và thiết bị (Bluetooth & devices)** [trên máy cũ là *Mạng & kết nối khác*] **→ bật OTG** (*Lưu ý: Tự động tắt sau 5 phút nếu không có thiết bị gắn vào*).'
  },
  tecno: {
    title: 'Tecno / Itel (HiOS)',
    step: '**Cài đặt → Thêm kết nối (More connections) [hoặc Cài đặt đặc biệt] → bật OTG** (một số máy có nút bật nhanh **OTG** khi vuốt thanh thông báo từ trên xuống).'
  },
  infinix: {
    title: 'Infinix (XOS)',
    step: '**Cài đặt → Thêm kết nối / Kết nối khác → bật OTG** rồi cắm chặt lại đầu thu vào đáy máy.'
  }
});

/**
 * Hướng dẫn bật OTG chi tiết cho từng hãng máy cần mở OTG để kết nối mic.
 */
function buildOtgGuide(space, matchedBrandIds = []) {
  const targetedIds = matchedBrandIds.filter(id => OTG_BRAND_STEPS[id]);
  const asksAllOtg = hasAnyBoundaryTerm(space, [
    'tung loai may', 'cac loai may', 'cac hang', 'may nao can', 'huong dan mo otg', 'bat otg', 'mo otg', 'cach bat otg', 'cach mo otg'
  ]) && targetedIds.length === 0;

  if (targetedIds.length > 0 && !asksAllOtg) {
    const out = ['**Hướng dẫn bật OTG để kết nối micro:**'];
    for (const id of targetedIds) {
      out.push(`- **${OTG_BRAND_STEPS[id].title}:** ${OTG_BRAND_STEPS[id].step}`);
    }
    out.push('- **Mẹo kiểm tra nhanh:** Tháo ốp lưng dày để chân đầu thu cắm sát nấc → kiểm tra đèn đầu thu RX sáng ổn định → quay thử trên **TikTok / CapCut / Open Camera** (chọn *Nguồn âm thanh: Micro ngoài*).');
    return out.join('\n');
  }

  return [
    '**Hướng dẫn mở OTG cho từng dòng máy cần bật OTG để nhận micro:**',
    `- **${OTG_BRAND_STEPS.oppo.title}:** ${OTG_BRAND_STEPS.oppo.step}`,
    `- **${OTG_BRAND_STEPS.realme.title}:** ${OTG_BRAND_STEPS.realme.step}`,
    `- **${OTG_BRAND_STEPS.oneplus.title}:** ${OTG_BRAND_STEPS.oneplus.step}`,
    `- **${OTG_BRAND_STEPS.vivo.title}:** ${OTG_BRAND_STEPS.vivo.step}`,
    `- **${OTG_BRAND_STEPS.tecno.title} / Infinix:** ${OTG_BRAND_STEPS.tecno.step}`,
    '- **Nhóm máy TỰ ĐỘNG mở OTG (không có nút gạt riêng):** **Samsung, Xiaomi / Redmi / POCO, HONOR, Huawei, Google Pixel, Nothing, Sony Xperia, ASUS ROG, iPhone/iPad, Laptop/PC** tự cấp nguồn OTG ngay khi cắm sát chân. Nếu vẫn không thu được tiếng mic, kiểm tra mục **Gỡ lỗi USB / Tắt định tuyến âm thanh USB** (Android), thử app **Open Camera** (*Micro ngoài*) hoặc kiểm tra lại chân cắm/ốp lưng.'
  ].join('\n');
}

const USB_DEBUG_BRAND_STEPS = Object.freeze({
  xiaomi: {
    title: 'Xiaomi / Redmi / POCO (MIUI & HyperOS)',
    step: '**Bước 1:** Vào *Cài đặt → Giới thiệu điện thoại* → chạm **7 lần liên tiếp** vào **Phiên bản MIUI / Phiên bản HyperOS (OS version)**.\n  **Bước 2:** Quay lại *Cài đặt → Cài đặt bổ sung (Additional settings) → Tùy chọn nhà phát triển (Developer options)* → gạt bật **Gỡ lỗi USB (USB debugging)** (chờ hết đếm ngược xác nhận nếu máy hỏi).'
  },
  samsung: {
    title: 'Samsung Galaxy (One UI)',
    step: '*Cài đặt → Thông tin điện thoại → Thông tin phần mềm* → chạm **7 lần** vào **Số hiệu bản tạo (Build number)** → quay lại *Cài đặt → Cài đặt cho người phát triển (Developer options)* → bật **Gỡ lỗi USB (USB debugging)**.'
  },
  oppo_realme: {
    title: 'OPPO / Realme / OnePlus (ColorOS / Realme UI / OxygenOS)',
    step: '*Cài đặt → Giới thiệu về thiết bị → Phiên bản (Version)* → chạm **7 lần** vào **Số bản dựng / Số phiên bản (Build number)** → quay lại *Cài đặt hệ thống / Cài đặt bổ sung → Tùy chọn nhà phát triển* → bật **Gỡ lỗi USB** (đồng thời nhớ bật **Kết nối OTG**).'
  },
  vivo: {
    title: 'vivo / iQOO (Funtouch OS / OriginOS)',
    step: '*Cài đặt → Giới thiệu về điện thoại → Thông tin phần mềm* → chạm **7 lần** vào **Số bản dựng / Phiên bản phần mềm** → quay lại *Cài đặt → Hệ thống → Tùy chọn nhà phát triển* → bật **Gỡ lỗi USB** (cùng với bật **OTG** ở *Bluetooth và thiết bị*).'
  },
  general_android: {
    title: 'HONOR / Huawei / Tecno / Infinix / Google Pixel / Sony / Motorola / Nothing',
    step: '*Cài đặt → Giới thiệu điện thoại (About phone)* → chạm **7 lần** vào **Số hiệu bản tạo / Số bản dựng (Build number)** → vào *Hệ thống (System) → Tùy chọn nhà phát triển* → bật **Gỡ lỗi USB (USB debugging)**.'
  }
});

/**
 * Hướng dẫn mở Gỡ lỗi USB (USB Debugging) theo từng hãng Android.
 */
function buildUsbDebuggingGuide(space, matchedBrandIds = []) {
  const targeted = [];
  if (matchedBrandIds.includes('xiaomi')) targeted.push(USB_DEBUG_BRAND_STEPS.xiaomi);
  if (matchedBrandIds.includes('samsung')) targeted.push(USB_DEBUG_BRAND_STEPS.samsung);
  if (matchedBrandIds.some(id => ['oppo', 'realme', 'oneplus'].includes(id))) targeted.push(USB_DEBUG_BRAND_STEPS.oppo_realme);
  if (matchedBrandIds.includes('vivo')) targeted.push(USB_DEBUG_BRAND_STEPS.vivo);
  if (matchedBrandIds.some(id => ['honor', 'huawei', 'tecno', 'infinix', 'pixel', 'sony', 'motorola_nokia', 'nothing', 'nubia', 'asus'].includes(id))) {
    targeted.push(USB_DEBUG_BRAND_STEPS.general_android);
  }

  const lines = [];
  if (targeted.length > 0) {
    lines.push('**Hướng dẫn bật Gỡ lỗi USB (USB Debugging) để kết nối mic ổn định:**');
    for (const item of targeted) {
      lines.push(`- **${item.title}:** ${item.step}`);
    }
  } else {
    lines.push('**Hướng dẫn mở Gỡ lỗi USB (USB Debugging) cho từng hãng Android (một số máy Android/nội địa cần bước này khi chưa nhận tín hiệu âm thanh USB từ đầu thu):**');
    lines.push(`- **${USB_DEBUG_BRAND_STEPS.xiaomi.title}:** ${USB_DEBUG_BRAND_STEPS.xiaomi.step}`);
    lines.push(`- **${USB_DEBUG_BRAND_STEPS.samsung.title}:** ${USB_DEBUG_BRAND_STEPS.samsung.step}`);
    lines.push(`- **${USB_DEBUG_BRAND_STEPS.oppo_realme.title}:** ${USB_DEBUG_BRAND_STEPS.oppo_realme.step}`);
    lines.push(`- **${USB_DEBUG_BRAND_STEPS.vivo.title}:** ${USB_DEBUG_BRAND_STEPS.vivo.step}`);
    lines.push(`- **${USB_DEBUG_BRAND_STEPS.general_android.title}:** ${USB_DEBUG_BRAND_STEPS.general_android.step}`);
  }

  lines.push('- **Kiểm tra quan trọng ngay trong Tùy chọn nhà phát triển:** Tìm mục **Tắt định tuyến âm thanh USB (Disable USB audio routing)** và đảm bảo công tắc này **ĐANG TẮT (OFF)** — nếu lỡ gạt bật sẽ bị mất tiếng mic rời. Nếu có *Cấu hình USB mặc định*, chọn *Truyền tệp / MIDI*.');
  lines.push('- *(Lưu ý: **iPhone / iPad / MacBook** không dùng chế độ Gỡ lỗi USB.)*');
  return lines.join('\n');
}

/**
 * Hướng dẫn chọn Mic gắn ngoài trên iOS mới (từ iOS 18+) và phân biệt iOS dưới 18.
 */
function buildIosMicSelectionGuide(space = '') {
  const mentionsUnder18Only = hasAnyBoundaryTerm(space, ['ios duoi 18', 'duoi 18', 'ios 17', 'ios 16', 'ios 15', 'ios 14', 'ios cu']);
  const mentions18PlusOnly = hasAnyBoundaryTerm(space, ['ios 18', 'ios 19', 'ios 26', 'ios moi', 'ios hien tai', 'ios moi nhat']);

  if (mentionsUnder18Only && !mentions18PlusOnly) {
    return [
      '**Lưu ý thiết lập micro gắn ngoài trên iOS dưới 18 (iOS 17, 16, 15, 14 trở xuống):**',
      '- **iOS dưới 18 KHÔNG cần (và không có bước) chọn thiết bị mic gắn ngoài thủ công** như các bản iOS mới từ iOS 18 trở lên.',
      '- Bạn chỉ cần cắm chặt đầu thu GAERU đúng chân (**Lightning** cho iPhone 14 trở xuống hoặc **Type-C** cho iPhone 15 chạy iOS 17) sát khớp (tháo ốp nếu vướng), bật TX cho đèn báo kết nối sáng ổn định và cấp quyền **Micro** cho ứng dụng quay (Camera / TikTok / CapCut) — máy sẽ **tự động thu âm qua mic ngoài**. *(Mẹo: khi mở lại video để nghe thử trên loa ngoài iPhone, nhớ rút đầu thu RX ra trước.)*'
    ].join('\n');
  }

  return [
    '**Hướng dẫn lựa chọn mic gắn ngoài trên iOS mới (iOS 18 trở lên) & Lưu ý cho iOS dưới 18:**',
    '- **Với iOS mới (từ iOS 18 trở lên — iOS 18 / iOS mới nhất):** Khi đang mở ứng dụng quay/thu (**Camera, TikTok, Facebook, Ghi âm…**) và đã cắm đầu thu micro GAERU, bạn **vuốt từ góc trên bên phải xuống để mở Trung tâm điều khiển (Control Center)** → chạm vào **thanh điều khiển Micrô / Tên ứng dụng ở trên cùng** → kiểm tra mục **Đầu vào (Input)** và **chọn đúng micro gắn ngoài (thay vì Microphone iPhone)**, đồng thời giữ **Chế độ micrô: Tiêu chuẩn (Standard)** để giọng thu tự nhiên, không bị lọc chồng méo tiếng.',
    '- **Chú ý với iOS dưới 18 (iOS 17, 16, 15 trở xuống):** **KHÔNG cần thực hiện thao tác lựa chọn mic ngoài thủ công** như iOS 18+! Chỉ cần cắm sát khớp đúng chân cắm và đèn TX/RX sáng kết nối ổn định là iPhone/iPad tự động nhận micro gắn ngoài ngay.',
    '- **Mẹo chung trên iPhone / iPad:** Khi muốn nghe lại tiếng video vừa quay bằng loa ngoài của máy, nhớ **rút đầu thu RX ra** khỏi cổng sạc.'
  ].join('\n');
}

module.exports = {
  EXT_PORT_TYPES,
  TABLET_PROFILES,
  APPLE_LAPTOP_TYPE_C_MODELS,
  APPLE_LAPTOP_LEGACY_USBA,
  WINDOWS_LAPTOP_BRANDS,
  DESKTOP_PC_TRIGGERS,
  detectTabletLaptopPcInfo,
  buildOtgGuide,
  buildUsbDebuggingGuide,
  buildIosMicSelectionGuide
};
