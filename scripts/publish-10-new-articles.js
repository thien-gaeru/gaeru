'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { Pool } = require('pg');
require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');
const FONT_FAMILY = 'Arial, Segoe UI, Liberation Sans, sans-serif';

const THEMES = {
  sky: {
    bgLight: '#f0f9ff',
    border: '#bae6fd',
    pillBg: '#e0f2fe',
    pillText: '#0284c7',
    iconColor: '#0284c7',
    titleColor: '#0369a1'
  },
  emerald: {
    bgLight: '#ecfdf5',
    border: '#a7f3d0',
    pillBg: '#dcfce7',
    pillText: '#15803d',
    iconColor: '#10b981',
    titleColor: '#166534'
  },
  purple: {
    bgLight: '#faf5ff',
    border: '#e9d5ff',
    pillBg: '#f3e8ff',
    pillText: '#7e22ce',
    iconColor: '#a855f7',
    titleColor: '#6b21a8'
  },
  amber: {
    bgLight: '#fffbeb',
    border: '#fde68a',
    pillBg: '#fef3c7',
    pillText: '#b45309',
    iconColor: '#d97706',
    titleColor: '#92400e'
  },
  rose: {
    bgLight: '#fff1f2',
    border: '#fecdd3',
    pillBg: '#ffe4e6',
    pillText: '#be123c',
    iconColor: '#e11d48',
    titleColor: '#9f1239'
  },
  teal: {
    bgLight: '#f0fdfa',
    border: '#99f6e4',
    pillBg: '#ccfbf1',
    pillText: '#0f766e',
    iconColor: '#0d9488',
    titleColor: '#115e59'
  }
};

function getIconSvg(name, strokeColor) {
  switch (name) {
    case 'otg':
      return `<rect x="3" y="8" width="18" height="16" rx="3" /><path d="M8 8V4a1 1 0 011-1h6a1 1 0 011 1v4M7 16h10" /><circle cx="12" cy="16" r="1.5" fill="${strokeColor}" />`;
    case 'cable':
      return `<rect x="4" y="10" width="24" height="12" rx="6" /><line x1="10" y1="16" x2="22" y2="16" stroke-width="2.5" /><circle cx="16" cy="16" r="2" fill="${strokeColor}" />`;
    case 'mic':
      return `<rect x="9" y="4" width="14" height="16" rx="6" /><path d="M5 14a11 11 0 0022 0M16 25v4M11 29h10" />`;
    case 'wind':
      return `<path d="M4 8h16a3 3 0 010 6H3M3 14h20a3 3 0 010 6H4M5 20h10a2.5 2.5 0 010 5H5" stroke-width="2.2" />`;
    case 'chip':
      return `<rect x="7" y="7" width="18" height="18" rx="3" /><rect x="11" y="11" width="10" height="10" rx="1" /><path d="M11 3v4M16 3v4M21 3v4M11 25v4M16 25v4M21 25v4M3 11h4M3 16h4M3 21h4M25 11h4M25 16h4M25 21h4" />`;
    case 'shield':
      return `<path d="M16 3l11 4v7c0 7-6 12-11 15-5-3-11-8-11-15V7l11-4z" stroke-width="2.2" /><polyline points="11 14 15 18 21 12" stroke-width="2.2" />`;
    case 'light':
      return `<circle cx="16" cy="16" r="6" /><path d="M16 3v4M16 25v4M3 16h4M25 16h4M6.8 6.8l2.8 2.8M22.4 22.4l2.8 2.8M6.8 25.2l2.8-2.8M22.4 9.6l2.8-2.8" />`;
    case 'waves':
      return `<path d="M4 16v-2m4 5V13m4 8V10m4 13V9m4 11V12m4 6v-2" stroke-width="2.5" />`;
    case 'tripod':
      return `<circle cx="16" cy="6" r="3" /><path d="M16 9v7M7 28l9-12 9 12M11 22h10" stroke-width="2.2" />`;
    case 'users':
      return `<circle cx="11" cy="9" r="4" /><path d="M4 25c0-4 3-7 7-7s7 3 7 7" /><circle cx="21" cy="9" r="3" /><path d="M18 19c2-.5 4 .5 5 2v4" />`;
    case 'sliders':
      return `<line x1="8" y1="4" x2="8" y2="28" /><circle cx="8" cy="12" r="3" fill="${strokeColor}" /><line x1="16" y1="4" x2="16" y2="28" /><circle cx="16" cy="20" r="3" fill="${strokeColor}" /><line x1="24" y1="4" x2="24" y2="28" /><circle cx="24" cy="10" r="3" fill="${strokeColor}" />`;
    case 'disc':
      return `<rect x="5" y="8" width="22" height="16" rx="4" /><circle cx="12" cy="16" r="3" /><line x1="18" y1="12" x2="23" y2="12" /><line x1="18" y1="16" x2="23" y2="16" /><line x1="18" y1="20" x2="21" y2="20" />`;
    case 'eye':
      return `<circle cx="16" cy="16" r="4" fill="${strokeColor}" /><path d="M3 16s5-9 13-9 13 9 13 9-5 9-13 9-13-9-13-9z" stroke-width="2.2" />`;
    case 'rotate':
      return `<path d="M27 16A11 11 0 1116 5c3.5 0 6.5 1.5 8.5 4" stroke-width="2.2" /><polyline points="21 9 25.5 9 25.5 4.5" stroke-width="2.2" />`;
    case 'hand':
      return `<path d="M12 15V6a2 2 0 014 0v9M16 11a2 2 0 014 0v5M8 14a2 2 0 00-2 2v2c0 5 4 8 9 8s9-3 9-8v-3a2 2 0 00-4 0" stroke-width="2.2" />`;
    case 'zap':
      return `<polygon points="17 2 6 16 15 16 13 30 26 14 17 14 17 2" fill="${strokeColor}" stroke="${strokeColor}" />`;
    case 'check':
      return `<circle cx="16" cy="16" r="12" stroke-width="2" /><polyline points="10 16 14 20 22 12" stroke-width="2.5" />`;
    case 'sparkle':
      return `<path d="M16 3l2 8 8 2-8 2-2 8-2-8-8-2 8-2z" stroke-width="2" fill="${strokeColor}" />`;
    case 'battery':
      return `<rect x="4" y="9" width="20" height="14" rx="3" stroke-width="2.2" /><path d="M26 13v6" stroke-width="2.5" /><rect x="7" y="12" width="7" height="8" rx="1.5" fill="${strokeColor}" />`;
    case 'search':
      return `<circle cx="13" cy="13" r="8" stroke-width="2.2" /><line x1="19" y1="19" x2="27" y2="27" stroke-width="2.5" />`;
    case 'truck':
      return `<rect x="3" y="7" width="14" height="12" rx="1.5" stroke-width="2" /><path d="M17 10h5l3 4v5h-8z" stroke-width="2" /><circle cx="8" cy="22" r="3" stroke-width="2" /><circle cx="20" cy="22" r="3" stroke-width="2" />`;
    default:
      return `<circle cx="16" cy="16" r="10" stroke-width="2" />`;
  }
}

const articles = [
  {
    uuid: 'c0000000-0000-4000-8000-000000000001',
    slug: 'dien-thoai-khong-nhan-micro-thu-am-cach-khac-phuc',
    title: 'Cắm micro thu âm vào điện thoại nhưng không nhận tiếng: Nguyên nhân và cách khắc phục trong 3 phút',
    badge: 'XỬ LÝ KỸ THUẬT',
    subHeader: 'Quy trình xử lý nhanh trong 3 phút trên Android & iPhone – Thu âm rõ nét ngay',
    type: 'cards',
    cards: [
      {
        theme: 'sky',
        tag: 'BƯỚC 1: KẾT NỐI',
        title: 'Kích Hoạt OTG',
        desc: [
          'Vào Cài đặt > Cài đặt bổ sung',
          'Bật công tắc "Kết nối OTG"',
          '(Áp dụng Oppo, Vivo, Realme)'
        ],
        tip: '✓ Đèn đầu thu sáng đứng yên',
        icon: 'otg'
      },
      {
        theme: 'emerald',
        tag: 'BƯỚC 2: PHẦN CỨNG',
        title: 'Chuẩn Tiếp Xúc',
        desc: [
          'Tháo bỏ ốp lưng chống sốc dày',
          'Cắm khít chân Type-C vào đáy',
          'Đảm bảo chân dữ liệu số ăn khớp'
        ],
        tip: '✓ Tránh nghẽn tín hiệu cơ học',
        icon: 'cable'
      },
      {
        theme: 'purple',
        tag: 'BƯỚC 3: ỨNG DỤNG',
        title: 'Cấp Quyền Nguồn Âm',
        desc: [
          'Mở Camera > Nguồn âm ngoài',
          'Hoặc dùng CapCut / Open Camera',
          'Thử ghi âm 10s trước khi quay'
        ],
        tip: '✓ Âm thanh trầm ấm, rõ nét',
        icon: 'mic'
      }
    ],
    excerpt: 'Hướng dẫn từng bước kiểm tra kết nối OTG trên điện thoại Android, phân biệt cổng cắm Type-C và xử lý quyền micro trong ứng dụng quay video để thu âm rõ nét ngay lập tức.',
    imageAlt: 'Hướng dẫn khắc phục lỗi cắm micro thu âm vào điện thoại nhưng không nhận tiếng',
    body: `Bạn vừa mở hộp chiếc micro thu âm không dây, háo hức cắm đầu thu vào điện thoại, bật micro và quay thử một đoạn video. Nhưng khi xem lại, âm thanh vẫn là tiếng micro tích hợp của điện thoại đầy tạp âm, hoặc tệ hơn là hoàn toàn không có tiếng.

Đây là tình huống mà hơn 70% người mới sử dụng micro ngoài gặp phải trong lần đầu tiên. Tin vui là thiết bị của bạn không hề bị hỏng. Dưới đây là 4 nguyên nhân phổ biến nhất và cách khắc phục nhanh chóng trong vòng 3 phút.

## 1. Chưa bật tính năng OTG (Áp dụng cho dòng máy Oppo, Vivo, Realme, OnePlus)
Khác với iPhone hay Samsung (tự động cấp nguồn cho thiết bị ngoại vi qua cổng sạc), các dòng điện thoại Android như Oppo, Vivo, Realme mặc định **tắt kết nối OTG** (On-The-Go) để tiết kiệm pin. Khi đầu thu không có điện, đèn tín hiệu sẽ không sáng và điện thoại không thể nhận tín hiệu âm thanh.

**Cách khắc phục:**
1. Vào **Cài đặt (Settings)** trên điện thoại.
2. Tìm kiếm từ khóa **"OTG"** hoặc vào mục **Cài đặt bổ sung / Cài đặt hệ thống**.
3. Bật công tắc **Kết nối OTG (OTG Connection)** lên.
4. Rút đầu thu ra và cắm lại. Khi đèn trên đầu thu nhấp nháy hoặc sáng xanh đứng yên, thiết bị đã sẵn sàng hoạt động.
*(Lưu ý: Nếu không sử dụng trong 10 phút, một số máy sẽ tự tắt OTG. Bạn chỉ cần bật lại trước mỗi buổi quay).*

## 2. Ứng dụng Camera mặc định chưa cho phép nhận nguồn âm ngoài
Trên một số dòng điện thoại Android đời cũ, ứng dụng Máy ảnh gốc (Camera mặc định) bị nhà sản xuất khóa chức năng thu âm qua thiết bị Type-C ngoài, chỉ cho phép dùng micro tích hợp.

**Cách khắc phục:**
- **Cách 1: Kiểm tra cài đặt Camera:** Mở Máy ảnh > Cài đặt máy ảnh > Cài đặt nâng cao > Tìm mục **Nguồn âm thanh (Audio Source)** > Đổi từ "Mặc định" sang **"Thiết bị ngoại vi / Micro ngoài"**.
- **Cách 2: Sử dụng ứng dụng quay chuyên dụng:** Tải ứng dụng **Open Camera** (miễn phí) hoặc sử dụng tính năng quay trực tiếp trong **CapCut** hay **TikTok**. Trong Open Camera: vào Cài đặt > Video settings > Audio source > chọn **External mic (if present)**.

## 3. Ốp lưng điện thoại quá dày khiến chân cắm chưa tiếp xúc hết
Đây là lỗi ngớ ngẩn nhưng cực kỳ phổ biến. Nhiều loại ốp lưng chống sốc hoặc ốp viền dày khiến đầu cắm Type-C hoặc Lightning chỉ chạm được một nửa vào cổng sạc, chưa ăn khớp hoàn toàn với các chân tiếp xúc dữ liệu bên trong.

**Cách khắc phục:** Tháo hẳn ốp lưng ra, cắm đầu thu vào cho đến khi nghe thấy tiếng "tách" nhẹ và đầu cắm nằm sát với cạnh đáy điện thoại.

## 4. Quy trình thử nhanh 30 giây trước khi quay thật
Đừng bao giờ quay một đoạn video dài 10 phút rồi mới kiểm tra lại âm thanh. Hãy tập thói quen:
1. Mở ứng dụng **Ghi âm (Voice Recorder)** có sẵn trên máy.
2. Đeo micro, đi ra xa 3 mét, gõ nhẹ vào đầu micro và nói: "Thử âm thanh 1, 2, 3".
3. Rút đầu thu ra (hoặc tắt nguồn đầu thu) để loa ngoài điện thoại phát lại tiếng. Nếu tiếng nói to rõ, trầm ấm và không nghe thấy tiếng quạt xung quanh, bạn đã thiết lập thành công.

Với các dòng micro chuẩn mực như **GAERU K9** hay **GAERU M3**, đầu thu được trang bị chip điều khiển kỹ thuật số tự tương thích cao, giảm thiểu tối đa hiện tượng kén máy. Nếu bạn vẫn gặp khó khăn khi kết nối, hãy liên hệ đội ngũ kỹ thuật GAERU tại https://gaeru.com/ho-tro để được hỗ trợ kiểm tra chi tiết theo từng dòng máy.`
  },
  {
    uuid: 'c0000000-0000-4000-8000-000000000002',
    slug: 'thu-am-ngoai-troi-khong-bi-gio-giat-deadcat-loc-ai',
    title: 'Bí quyết thu âm ngoài trời không bị gió giật: Khi nào dùng lọc ồn AI, khi nào cần bông lọc gió Deadcat?',
    badge: 'KỸ THUẬT NGOẠI CẢNH',
    subHeader: 'Làm chủ âm thanh dã ngoại – Chặn đứng tiếng gió rít bằng 3 lớp bảo vệ chuẩn studio',
    type: 'cards',
    cards: [
      {
        theme: 'amber',
        tag: 'LỚP 1: CƠ HỌC',
        title: 'Bông Lông Deadcat',
        desc: [
          'Hàng nghìn sợi lông nhân tạo mịn',
          'Tán nhỏ luồng gió trước khi chạm mic',
          'Triệt tiêu tiếng phù phù, bụp bụp'
        ],
        tip: '✓ Chống gió cấp 4 - 5 ngoài trời',
        icon: 'wind'
      },
      {
        theme: 'sky',
        tag: 'LỚP 2: THUẬT TOÁN',
        title: 'Chip Lọc Ồn AI ENC',
        desc: [
          'Bật chế độ khử ồn mức vừa',
          'Lọc tạp âm xa xăm, tiếng xe cộ',
          'Không ép quá mức tránh nghẹt giọng'
        ],
        tip: '✓ Giữ giọng ấm áp tự nhiên',
        icon: 'chip'
      },
      {
        theme: 'emerald',
        tag: 'LỚP 3: VỊ TRÍ GÀI',
        title: 'Cài Áo Chắn Gió',
        desc: [
          'Gài mic cách miệng 15 - 20cm',
          'Quay đầu thu chếch vào vạt áo',
          'Dùng cơ thể làm lá chắn gió tự nhiên'
        ],
        tip: '✓ Tối ưu biên độ âm thanh',
        icon: 'shield'
      }
    ],
    excerpt: 'Phân biệt cơ chế cản gió vật lý của bông lông Deadcat và thuật toán lọc ồn AI ENC để giữ trọn giọng nói ấm áp tự nhiên khi quay vlog dã ngoại hay phỏng vấn ngoài phố.',
    imageAlt: 'So sánh hiệu quả chống gió của bông lọc lông Deadcat và lọc ồn AI khi quay ngoài trời',
    body: `Khi quay video ngoại cảnh, kẻ thù số một của mọi nhà sáng tạo không phải là tiếng còi xe hay tiếng người nói chuyện, mà chính là **tiếng gió**. Gió lùa qua màng thu tạo nên những tiếng "phù phù", "bụp bụp" chói tai làm méo mó toàn bộ giọng đọc.

Nhiều người lầm tưởng rằng chỉ cần bật chế độ "Lọc ồn AI" trên micro là gió sẽ biến mất. Tuy nhiên, âm học vật lý có những giới hạn mà phần mềm không thể tự giải quyết một mình.

## 1. Tại sao chip AI không thể lọc sạch tiếng gió giật mạnh?
Tiếng gió ngoài trời có năng lượng tần số cực thấp (Low-frequency Rumble dưới 100Hz) với biên độ áp suất khí rất lớn. Khi một cơn gió mạnh thổi trực tiếp vào màng rung của micro, nó tạo ra hiện tượng **bão hòa cơ học (Clipping)** ngay tại phần cứng trước khi tín hiệu kịp chuyển thành dữ liệu số.

Nếu bạn lạm dụng thuật toán AI để ép lọc tiếng gió quá mức, giọng nói của bạn sẽ bị "bóp nghẹt", nghe như đang nói trong ống bơ hoặc nghẹt mũi. Do đó, **bảo vệ màng thu bằng biện pháp cơ học luôn là bước bắt buộc đầu tiên**.

## 2. Sức mạnh của bông lọc lông Deadcat
Bông lọc lông (thường gọi là Deadcat hay Wind Muff) được cấu tạo từ hàng nghìn sợi lông nhân tạo siêu mịn với mật độ được tính toán kỹ lưỡng:
- **Nguyên lý tán khí:** Khi luồng gió đập vào các sợi lông, năng lượng gió bị phân tán thành hàng triệu vi luồng khí nhỏ li ti và triệt tiêu trước khi chạm tới màng thu âm.
- **Bảo tồn tần số âm thanh:** Trong khi cản gió cực tốt, các sợi lông này lại cho phép sóng âm của giọng nói (có bước sóng ngắn hơn) đi xuyên qua mà không làm suy hao dải trầm (Bass) hay dải cao (Treble).

Một chiếc micro được gắn Deadcat có thể chống chịu sức gió lên đến cấp 4 – cấp 5 ngoài trời mà tiếng nói vẫn êm dịu, không hề bị rách tiếng.

## 3. Công thức phối hợp nhịp nhàng giữa Lọc AI và Bông Deadcat
Để có bản thu hoàn hảo nhất khi quay dã ngoại:
1. **Lớp 1 (Cơ học):** Luôn bọc bông lọc lông Deadcat lên đầu củ mic. Dòng micro **GAERU M3** được trang bị sẵn ngàm khóa Deadcat chắc chắn, không lo bị rơi rớt khi vận động mạnh.
2. **Lớp 2 (Vị trí cài):** Ghim micro cách miệng khoảng 15 - 20cm, hơi chếch về bên trong cổ áo hoặc quay đầu mic hướng xuống đất để tận dụng cơ thể làm tấm lá chắn gió tự nhiên.
3. **Lớp 3 (Thuật toán AI):** Bật chế độ giảm ồn ENC trên thân máy ở mức nhẹ hoặc trung bình để làm sạch nốt những tạp âm nền xa xăm như tiếng xe cộ hay sóng biển.

Sự kết hợp giữa công nghệ AI hiện đại và phụ kiện khí động học chuẩn mực sẽ mang lại bản thu trong trẻo chuẩn studio cho mọi hành trình khám phá của bạn. Xem chi tiết bộ phụ kiện lọc gió GAERU M3 tại https://gaeru.com/san-pham/gaeru-m3.`
  },
  {
    uuid: 'c0000000-0000-4000-8000-000000000003',
    slug: 'setup-goc-quay-livestream-tai-nha-duoi-1-trieu',
    title: 'Setup góc quay livestream bán hàng tại nhà dưới 1 triệu đồng: Đủ sáng, chuẩn âm, không cần phòng cách âm',
    badge: 'SETUP TIẾT KIỆM',
    subHeader: 'Giải pháp phòng live tại gia – Bứt phá đơn hàng với chi phí đầu tư tối thiểu',
    type: 'cards',
    cards: [
      {
        theme: 'amber',
        tag: 'BƯỚC 1: ÁNH SÁNG',
        title: 'Đèn 2 Điểm Tự Chế',
        desc: [
          'Đèn LED bàn làm việc 15W - 20W',
          'Tản sáng bằng giấy nến chống chói',
          'Đèn vàng hắt phông tạo chiều sâu'
        ],
        tip: '✓ Chi phí chỉ ~200.000 VNĐ',
        icon: 'light'
      },
      {
        theme: 'sky',
        tag: 'BƯỚC 2: TIÊU ÂM',
        title: 'Triệt Tiêu Âm Vang',
        desc: [
          'Đóng kín cửa, kéo rèm vải dày',
          'Trải thảm sàn hấp thụ tiếng vang',
          'Ngồi cách tường sau ít nhất 1m'
        ],
        tip: '✓ Khắc phục vang vọng 0 đồng',
        icon: 'waves'
      },
      {
        theme: 'emerald',
        tag: 'BƯỚC 3: THIẾT BỊ',
        title: 'Bộ Đôi K9 & P185',
        desc: [
          'Chân đỡ nhôm P185 cao 1m8',
          'Micro cài áo GAERU K9 cự ly gần',
          'Hỗ trợ sạc bypass live liên tục 4h'
        ],
        tip: '✓ Combo hoàn thiện ~700.000 VNĐ',
        icon: 'tripod'
      }
    ],
    excerpt: 'Cẩm nang tối ưu không gian nhỏ: kết hợp ánh sáng tự nhiên, chân đỡ chống rung P185 và micro định hướng K9 tạo phòng live chuyên nghiệp chi phí thấp cho chủ shop khởi nghiệp.',
    imageAlt: 'Hướng dẫn setup góc livestream bán hàng tại nhà chi phí thấp với GAERU K9 và P185',
    body: `Nhiều bạn trẻ và chủ shop khởi nghiệp thường ngần ngại bắt đầu livestream vì nghĩ rằng phải có phòng studio chuyên nghiệp, dàn đèn hàng chục triệu và micro đắt đỏ. Thực tế, bạn hoàn toàn có thể tạo nên một khung hình livestream sáng rõ, âm thanh cuốn hút với tổng chi phí chưa đến 1 triệu đồng.

## 1. Ánh sáng: Tận dụng nguyên lý 2 điểm (Chi phí: ~200.000 VNĐ)
Khuôn mặt tối hoặc ám vàng là nguyên nhân hàng đầu khiến khách hàng lướt qua phiên live của bạn:
- **Đèn chính (Key Light):** Tận dụng một chiếc đèn bàn LED ánh sáng trắng (công suất 15W - 20W). Đặt đèn chếch góc 45 độ so với mặt bạn. Để ánh sáng không bị chói gắt, hãy dán một tờ giấy nến (giấy nướng bánh) hoặc treo một mảnh vải trắng mỏng phía trước bóng đèn để làm mềm ánh sáng.
- **Đèn hắt phông (Background Light):** Đặt một bóng đèn vàng nhỏ phía sau lưng rọi vào góc tường hoặc kệ trưng bày sản phẩm để tạo chiều sâu không gian, giúp bạn tách biệt nổi bật khỏi phông nền.

## 2. Xử lý âm thanh: Khắc phục tiếng dội phòng hẹp (Chi phí: 0 đồng)
Phòng ngủ hoặc phòng trọ có tường gạch trơn láng thường tạo ra tiếng vang (Echo) như đang nói trong thùng rỗng:
- **Tiêu âm tức thì:** Đóng kín cửa sổ, kéo rèm vải dày, trải một tấm thảm hoặc chăn len xuống nền nhà dưới chân bạn. Vải mềm sẽ hấp thụ sóng âm phản xạ cực tốt, triệt tiêu tiếng vang ngay lập tức.
- **Không ngồi sát tường:** Ngồi cách tường phía sau ít nhất 1 mét để giọng nói không bị dội ngược lại vào máy quay.

## 3. Thiết bị ghi hình & âm thanh: Bộ đôi GAERU K9 + P185 (Chi phí: ~600.000 - 800.000 VNĐ)
- **Góc máy vững chãi với chân đỡ GAERU P185:** Chân tripod hợp kim nhôm nhỏ gọn, kéo dài linh hoạt từ để bàn lên đến 1,8m. Giúp điện thoại đặt thẳng tầm mắt người xem, không bị rung lắc khi bạn bấm chọn sản phẩm trên màn hình. Kèm theo remote Bluetooth bấm chụp hoặc quay từ xa rảnh tay.
- **Âm thanh trong trẻo với micro GAERU K9:** Micro cài áo bắt trọn giọng nói cự ly gần, loại bỏ hoàn toàn tiếng ồn quạt máy hay xe cộ ngoài ngõ. Đầu thu cắm trực tiếp vào điện thoại và hỗ trợ sạc truyền tiếp (Bypass charging), giúp điện thoại không bao giờ sập nguồn suốt phiên live 3 - 4 tiếng.

Chỉ với sự sắp xếp khéo léo và lựa chọn công cụ đúng chỗ, bạn đã có ngay một phòng phát sóng chuyên nghiệp để tự tin bùng nổ doanh số mỗi ngày. Khám phá các thiết bị livestream chính hãng tại https://gaeru.com/cua-hang.`
  },
  {
    uuid: 'c0000000-0000-4000-8000-000000000004',
    slug: 'thu-am-podcast-phong-van-hai-nguoi-can-bang-am-luong',
    title: 'Bắt đầu kênh Podcast / Phỏng vấn 2 người từ con số 0: Cách giữ cân bằng âm lượng hai giọng nói',
    badge: 'PODCAST & TALKSHOW',
    subHeader: 'Làm chủ âm thanh đối thoại – Giữ sự dễ chịu, cân bằng giữa hai chất giọng',
    type: 'cards',
    cards: [
      {
        theme: 'rose',
        tag: 'NGUYÊN TẮC 1',
        title: '2 Micro Độc Lập',
        desc: [
          'Không dùng 1 mic chung giữa bàn',
          'Tránh thu tạp âm cốc nước, giấy tờ',
          'Giữ âm lượng chuẩn khi xoay mặt'
        ],
        tip: '✓ Tách bạch 2 luồng âm thanh',
        icon: 'users'
      },
      {
        theme: 'sky',
        tag: 'NGUYÊN TẮC 2',
        title: 'Vị Trí Cài Áo Chuẩn',
        desc: [
          'Cách khóe miệng chuẩn 15 - 20cm',
          'Người nói to: gài thấp 20cm lệch ngực',
          'Người nói nhỏ: gài cao 15cm cúc trên'
        ],
        tip: '✓ Tự cân bằng cơ học tức thì',
        icon: 'sliders'
      },
      {
        theme: 'purple',
        tag: 'NGUYÊN TẮC 3',
        title: 'Đầu Thu GAERU M3',
        desc: [
          'Cắm 1 đầu thu, kết nối 2 mic',
          'Tự động mix 2 kênh đồng pha',
          'Màn hình LED kiểm soát pin cả hai'
        ],
        tip: '✓ Hoạt động đồng bộ 1 chạm',
        icon: 'disc'
      }
    ],
    excerpt: 'Bí quyết ghi âm cuộc trò chuyện hai người: bố trí vị trí micro GAERU M3, kiểm soát mức gain độc lập và xử lý âm dội phòng chi phí 0 đồng cho podcast và talkshow.',
    imageAlt: 'Kỹ thuật thu âm podcast và phỏng vấn hai người với micro GAERU M3',
    body: `Một cuộc trò chuyện truyền cảm hứng, một buổi phỏng vấn sâu sắc hay một tập podcast tâm tình... Điều giữ chân người nghe suốt 30 - 45 phút không phải là hiệu ứng âm thanh cầu kỳ, mà là **sự dễ chịu và cân bằng của hai giọng nói**.

Tuy nhiên, hầu hết các kênh podcast mới bắt đầu đều gặp phải một lỗi nghiêm trọng: Host (người dẫn) nói to rõ nhưng Khách mời nói quá nhỏ; hoặc khi một người cười lớn thì âm thanh bị chói gắt, người nghe phải liên tục tăng giảm âm lượng tai nghe.

## 1. Tại sao dùng 1 micro chung ở giữa bàn lại thất bại?
Nhiều người tiết kiệm bằng cách đặt 1 chiếc micro định hướng ở giữa bàn cho cả hai người nói. Đây là sai lầm phổ biến nhất:
- Micro sẽ thu luôn cả tiếng cốc nước chạm bàn, tiếng giấy tờ xáo trộn và tiếng quạt.
- Ai ngồi gần micro hơn hoặc giọng khỏe hơn sẽ lấn át hoàn toàn người đối diện.
- Người nói hơi quay mặt đi chỗ khác là âm lượng tụt dốc không phanh.

**Giải pháp:** Bắt buộc sử dụng hệ thống **2 micro cài áo riêng biệt** cho từng người.

## 2. Kỹ thuật cân bằng âm lượng ngay từ khâu gài micro
- **Nguyên tắc khoảng cách:** Vị trí vàng để gài micro là cách khóe miệng từ 15 đến 20cm (ngang tầm xương ức).
- **Với người có chất giọng to, nội lực:** Gài micro thấp hơn một chút (khoảng 20cm) và chếch sang một bên vạt áo để tránh hơi thở phà thẳng vào màng thu.
- **Với khách mời có giọng nói nhỏ, rụt rè:** Gài micro cao hơn (khoảng 15cm), cài ở cúc áo trên cùng gần cổ áo để bắt trọn từng âm tiết mà không cần tăng âm lượng lên quá cao gây sôi nền.

## 3. Khai thác sức mạnh bộ đôi GAERU M3 hộp sạc 2 micro
Hệ thống **GAERU M3** được thiết kế đặc thù cho các cuộc đối thoại 2 người:
- **Đầu thu 1 cổng cắm điều khiển 2 bộ phát:** Cắm trực tiếp đầu thu Type-C vào điện thoại hoặc máy tính bảng. Cả hai micro tự động đồng bộ tức thì không cần cài đặt.
- **Khử ồn thông minh:** Tự động cô lập giọng của từng người, tránh hiện tượng tiếng của Host lọt vào mic của Khách mời gây âm trễ (Phasing).
- **Thời lượng pin bền bỉ 24 giờ:** Hộp sạc màn hình LED hiển thị rõ ràng phần trăm pin, giúp bạn an tâm thực hiện các buổi trò chuyện kéo dài mà không lo gián đoạn cảm xúc.

Học viên và thính giả luôn đánh giá cao những nội dung có âm thanh chuẩn mực. Xem thông số chi tiết của GAERU M3 tại https://gaeru.com/san-pham/gaeru-m3.`
  },
  {
    uuid: 'c0000000-0000-4000-8000-000000000005',
    slug: 'tu-quay-video-nau-an-diy-mot-minh-gimbal-ai-p01',
    title: 'Tự quay video nấu ăn và làm đồ thủ công một mình: Góc máy rảnh tay với giá đỡ xoay AI GAERU P01',
    badge: 'CREATIVE DIY & FOOD',
    subHeader: 'Giải phóng đôi tay – Camera tự lia mượt mà theo từng bước di chuyển quanh căn bếp',
    type: 'cards',
    cards: [
      {
        theme: 'teal',
        tag: 'TÍNH NĂNG 1',
        title: 'Mắt Thần AI Độc Lập',
        desc: [
          'Cảm biến quang học tích hợp sẵn',
          'Tự nhận diện khuôn mặt và dáng người',
          'Hoạt động 100% không cần App'
        ],
        tip: '✓ Tương thích mọi app quay chụp',
        icon: 'eye'
      },
      {
        theme: 'sky',
        tag: 'TÍNH NĂNG 2',
        title: 'Xoay Lia 360° Mượt',
        desc: [
          'Động cơ bước phản hồi cực êm',
          'Bám theo người nấu từ bếp tới bàn',
          'Không giật khựng, giữ khung chuẩn'
        ],
        tip: '✓ Tự nhiên như có quay phim riêng',
        icon: 'rotate'
      },
      {
        theme: 'amber',
        tag: 'TÍNH NĂNG 3',
        title: 'Cử Chỉ Ra Lệnh',
        desc: [
          'Giơ tay OK để gimbal bám theo',
          'Xòe bàn tay để tạm dừng bám',
          'Không chạm máy khi tay dính bột'
        ],
        tip: '✓ Rảnh tay làm việc tuyệt đối',
        icon: 'hand'
      }
    ],
    excerpt: 'Hướng dẫn một mình sản xuất video nấu ăn, làm bánh, handmade: tận dụng camera AI theo dõi 360 độ của P01 và cử chỉ bàn tay thông minh không cần chạm máy.',
    imageAlt: 'Cách tự quay video nấu ăn và làm đồ thủ công với giá đỡ thông minh GAERU P01',
    body: `Bạn đam mê nấu ăn, làm bánh, thêu thùa hay làm đồ thủ công và muốn xây dựng một kênh TikTok / YouTube để chia sẻ? Thách thức lớn nhất khi "tác chiến một mình" chính là:
- Đôi bàn tay dính đầy dầu mỡ, bột mì hay sơn màu, không thể chạm vào màn hình điện thoại để bấm góc quay.
- Bạn bước sang tủ lạnh lấy đồ hay quay sang bếp đảo thức ăn là lọt ra ngoài khung hình.
- Nhờ người thân quay hộ thì góc máy không đúng ý, dễ nảy sinh bất đồng.

Chiếc giá đỡ theo dõi khuôn mặt thông minh **GAERU P01** ra đời chính là giải pháp "quay phim phụ tá ảo" hoàn hảo cho bạn.

## 1. Camera AI độc lập: Cắm là chạy, không phụ thuộc Bluetooth
Khác với các dòng gimbal phức tạp đòi hỏi phải tải ứng dụng bên ngoài và kết nối Bluetooth chập chờn:
- **GAERU P01** tích hợp sẵn một mắt camera AI và chip nhận diện thị giác máy tính ngay trên thân máy.
- Thiết bị tự động nhận diện khuôn mặt và nửa thân trên của bạn để xoay mượt mà theo 360 độ, hoàn toàn không can thiệp vào điện thoại của bạn. Bạn có thể dùng bất kỳ ứng dụng nào: Camera mặc định, TikTok, CapCut hay Livestream.

## 2. Điều khiển cử chỉ không chạm: Cứu cánh cho đôi tay bận rộn
Khi đang xào nấu hay nhào bột, bạn chỉ cần ra hiệu bằng cử chỉ trước mắt camera:
- **Cử chỉ "OK" (ngón cái chạm ngón trỏ):** Đèn chuyển sang màu xanh lá cây, giá đỡ bắt đầu bám theo bạn.
- **Cử chỉ "Bàn tay mở" (xòe cả bàn tay):** Đèn chuyển sang màu đỏ, giá đỡ khóa góc máy đứng yên để bạn tập trung quay cận cảnh chiếc chảo hoặc đĩa thức ăn.

## 3. Cách bố trí góc máy nấu ăn chuẩn Food Vlogger
1. **Góc ngang bàn bếp (Eye Level):** Đặt GAERU P01 trên bàn bếp cách khu vực thao tác khoảng 1,2m. Giá đỡ sẽ xoay theo bạn khi bạn di chuyển lấy dao, lấy gia vị hay bước sang bồn rửa.
2. **Gắn chân nối dài:** Đáy của P01 có sẵn lỗ ốc chuẩn 1/4 inch tiêu chuẩn, dễ dàng gắn lên chân tripod **GAERU P185** để nâng cao góc máy nhìn hơi chúi xuống, bao quát trọn vẹn bề mặt nấu ăn.
3. **Âm thanh ASMR chân thực:** Kết hợp với micro cài áo **GAERU M3** để thu trọn tiếng dầu sôi tí tách, tiếng cắt rau củ giòn rụm giúp video kích thích vị giác người xem gấp bội.

Khám phá trợ thủ đắc lực GAERU P01 tại https://gaeru.com/cua-hang.`
  },
  {
    uuid: 'c0000000-0000-4000-8000-000000000006',
    slug: 'kich-ban-video-ngan-45-giay-chuyen-doi-cao-affiliate',
    title: 'Kịch bản video ngắn 45 giây đập tan nỗi sợ mua hàng: Công thức "Vấn đề – Thử nghiệm thật – Giới hạn sản phẩm"',
    badge: 'KỊCH BẢN CHUYỂN ĐỔI',
    subHeader: 'Công thức 3 phần giữ chân người xem và kích thích chốt đơn tự nhiên không gượng ép',
    type: 'cards',
    cards: [
      {
        theme: 'rose',
        tag: '0 - 3 GIÂY ĐẦU',
        title: 'Hook Trực Diện',
        desc: [
          'Vào thẳng cảnh âm thanh bị lỗi',
          'Hoặc câu hỏi đánh trúng nỗi đau',
          'Giữ ngón tay người xem không lướt'
        ],
        tip: '✓ Tăng tỷ lệ xem tiếp >70%',
        icon: 'zap'
      },
      {
        theme: 'sky',
        tag: '4 - 30 GIÂY GIỮA',
        title: 'Test Âm Thanh Thật',
        desc: [
          'Bật quạt thổi gió hoặc ra ngoài đường',
          'Tắt bật micro để người xem so sánh',
          'Chứng minh hiệu quả không nhạc nền'
        ],
        tip: '✓ Xây dựng niềm tin chân thực',
        icon: 'waves'
      },
      {
        theme: 'emerald',
        tag: '31 - 45 GIÂY CUỐI',
        title: 'Khuyết Điểm + CTA',
        desc: [
          'Nêu 1 lưu ý nhỏ (ví dụ máy Oppo)',
          'Khẳng định giá trị thực tế vượt trội',
          'Kêu gọi bấm giỏ hàng nhận ưu đãi'
        ],
        tip: '✓ Tối đa hóa tỷ lệ chuyển đổi',
        icon: 'check'
      }
    ],
    excerpt: 'Khung kịch bản chuyển đổi cao cho nhà sáng tạo affiliate: mở đầu giật hook trực diện, đối chiếu âm thanh thật và thẳng thắn chỉ ra đối tượng phù hợp để giữ trọn niềm tin.',
    imageAlt: 'Cấu trúc kịch bản video ngắn 45 giây tối ưu tỷ lệ chuyển đổi cho nhà sáng tạo tiếp thị liên kết',
    body: `Người xem video ngắn trên TikTok hay Reels ngày nay cực kỳ thông minh. Những lời quảng cáo tâng bốc kiểu *"Chiếc micro thần thánh nhất phân khúc"* hay *"Lọc sạch 100% tiếng ồn xung quanh"* chỉ khiến họ lướt qua ngay lập tức vì mùi "quảng cáo lố".

Cách duy nhất để tạo ra đơn hàng bền vững và xây dựng uy tín cá nhân là: **Truyền thông trung thực, chỉ rõ cả điểm mạnh lẫn giới hạn của thiết bị**. Dưới đây là công thức kịch bản 45 giây đạt tỷ lệ chuyển đổi hàng đầu dành cho đối tác GAERU Creator.

## Cấu trúc kịch bản 4 phần chuẩn xác

### 1. Hook trực diện bằng âm thanh (0 - 3 giây)
- **Hình ảnh:** Bạn đứng ở nơi ồn ào (quán cà phê đông người hoặc ngoài ngõ có tiếng xe).
- **Âm thanh:** Dùng micro mặc định của điện thoại đầy tiếng ồn.
- **Lời thoại:** *"Đừng mua chiếc micro thu âm này... nếu như bạn chỉ quay video trong phòng ngủ yên tĩnh."* (Kích thích sự tò mò).

### 2. Thử nghiệm đối chiếu A/B thật (3 - 18 giây)
- **Hành động:** Bạn cầm chiếc micro **GAERU K9** hoặc **GAERU M3** đưa lên cài vào cổ áo và cắm đầu thu vào điện thoại. Không sử dụng bất kỳ nhạc nền nào.
- **Lời thoại:** *"Đây là âm thanh thu trực tiếp từ điện thoại khi chưa cắm mic... Còn bây giờ, mình vừa cắm chiếc GAERU K9 vào. Các bạn nghe xem: tiếng xe cộ và tiếng quạt gió đã được chip lọc ồn xử lý như thế nào?"*

### 3. Thẳng thắn nêu nhược điểm & giới hạn (18 - 33 giây)
*(Đây là phần mấu chốt biến người xem từ hoài nghi thành tin tưởng tuyệt đối)*
- **Lời thoại:** *"Nhưng chiếc mic này có 2 điểm bạn cần lưu ý trước khi bấm mua:
Thứ nhất, nếu dùng máy Android như Oppo hay Vivo, bắt buộc phải vào Cài đặt bật OTG lên thì máy mới nhận.
Thứ hai, nó chỉ phù hợp cho cự ly phỏng vấn từ 10 - 20 mét; nếu bạn đứng quá xa qua 2 bức tường bê tông dày thì tín hiệu sẽ chập chờn."*

### 4. Kêu gọi hành động văn minh (33 - 45 giây)
- **Hình ảnh:** Cầm hộp sản phẩm, chỉ vào logo GAERU và tem bảo hành.
- **Lời thoại:** *"Nếu bạn đang cần một bộ mic nhỏ gọn để quay vlog hay bán hàng online, bạn có thể tham khảo link mình ghim ở góc trái. Hãng có chính sách bảo hành 1 đổi 1 trong 12 tháng và hỗ trợ dùng thử 7 ngày nên hoàn toàn yên tâm thử nghiệm nhé."*

Sự chân thành không làm giảm doanh số; ngược lại, nó giúp khách hàng mua đúng phiên bản họ cần và không bao giờ hoàn hàng. Đăng ký tham gia mạng lưới đối tác sáng tạo tại https://gaeru.com/tin-tuc/gaeru-affiliate-hop-tac-sang-tao.`
  },
  {
    uuid: 'c0000000-0000-4000-8000-000000000007',
    slug: 'so-sanh-chi-tiet-micro-gaeru-k9-va-gaeru-m3',
    title: 'Nên chọn GAERU K9 hay GAERU M3? Bảng so sánh chi tiết giúp bạn không mua thừa tính năng',
    badge: 'SO SÁNH SẢN PHẨM',
    subHeader: 'Phân tích chuyên sâu về tính năng, thời lượng pin, công nghệ lọc ồn và nhu cầu sử dụng thực tế',
    type: 'comparison',
    comparison: {
      left: {
        theme: 'sky',
        tag: 'CẮM LÀ DÙNG NGAY',
        model: 'GAERU K9',
        sub: 'TỐI ƯU CHI PHÍ',
        features: [
          { f: 'Cực kỳ nhỏ gọn (8.2g)', sub: 'Kẹp áo thoải mái, không làm trễ cổ áo thun' },
          { f: 'Cắm trực tiếp Type-C / Lightning', sub: 'Không cần cài app thứ 3, nhận ngay trong 3s' },
          { f: 'Pin liên tục 5 - 6 giờ', sub: 'Hỗ trợ cổng sạc bypass vừa sạc vừa live cả ngày' }
        ],
        verdictTag: 'Phù hợp nhất:',
        verdictText: 'Livestream bán hàng, quay video phòng kín, TikToker mới'
      },
      right: {
        theme: 'purple',
        tag: 'HỘP SẠC THÔNG MINH',
        model: 'GAERU M3',
        sub: 'CHUYÊN NGHIỆP ĐA NĂNG',
        features: [
          { f: 'Hộp sạc Màn hình LED % pin', sub: 'Kiểm soát chính xác pin từng mic, thời lượng 24h+' },
          { f: 'Lọc ồn AI 3 cấp độ + Deadcat', sub: 'Chống gió giật ngoài trời, giữ giọng nói ấm tự nhiên' },
          { f: 'Bộ 2 micro độc lập', sub: 'Thu đồng thời 2 người, tự cân bằng âm lượng thông minh' }
        ],
        verdictTag: 'Phù hợp nhất:',
        verdictText: 'Quay ngoại cảnh, podcast, phỏng vấn, sự kiện'
      },
      vsText: 'VS'
    },
    excerpt: 'Đặt lên bàn cân hai dòng micro thu âm không dây bán chạy nhất của GAERU: phân tích thời lượng pin, chất âm 24-bit, hộp sạc LED và chân dung người dùng phù hợp.',
    imageAlt: 'Bảng so sánh chi tiết thông số và tính năng giữa micro GAERU K9 và GAERU M3',
    body: `Khi tìm kiếm một chiếc micro thu âm không dây cài áo cho điện thoại, hai cái tên phổ biến nhất mà bạn bắt gặp tại GAERU chính là **GAERU K9** và **GAERU M3**.

Chênh lệch mức giá khiến nhiều người băn khoăn: *"Liệu bỏ thêm chi phí để mua M3 có thực sự đáng tiền? Hay chỉ cần một bộ K9 là đã đủ dùng?"* Dưới đây là bài phân tích công tâm giúp bạn chọn đúng sản phẩm theo nhu cầu thực tế.

## 1. Bảng đối chiếu thông số cốt lõi

| Tiêu chí so sánh | GAERU K9 | GAERU M3 |
| :--- | :--- | :--- |
| **Phân khúc** | Phổ thông – Khởi đầu dễ dàng | Bán chuyên – Đa dụng cao cấp |
| **Hộp sạc đi kèm** | Không có (sạc cáp trực tiếp vào mic) | Hộp sạc thông minh màn hình LED hiển thị % pin |
| **Thời lượng pin 1 lần sạc** | 4 – 5 giờ liên tục | 4 – 5 giờ (Mở rộng lên 24 giờ với hộp sạc) |
| **Công nghệ lọc ồn** | Chip DSP lọc tiếng ồn tiêu chuẩn | Mạng nơ-ron AI ENC đa tầng + Bông lọc lông Deadcat |
| **Chất lượng âm thanh** | 16-bit / 48 kHz (Rõ tiếng, trong trẻo) | 24-bit / 48 kHz (Dày dặn, bắt trọn âm sắc) |
| **Cổng kết nối** | Chọn bản Type-C hoặc Lightning riêng | Đầu thu Type-C (hỗ trợ đầu chuyển Lightning/USB) |
| **Khoảng cách truyền** | 10 – 15 mét ổn định | Lên đến 20 mét không vật cản |

## 2. Khi nào bạn CHỈ CẦN chọn GAERU K9?
**GAERU K9** là lựa chọn số một nếu bạn thuộc các nhóm sau:
- **Người mới bắt đầu:** Bạn vừa lập kênh, muốn thử nghiệm quay video ngắn mà không muốn đầu tư ngân sách lớn.
- **Nhu cầu quay ngắn trong nhà:** Các thầy cô giáo dạy học online, nhân viên văn phòng họp trực tuyến, người quay video review tĩnh tại bàn làm việc từ 1 - 2 tiếng mỗi ngày.
- **Tính cơ động tối giản:** K9 cực kỳ gọn nhẹ, bỏ trực tiếp vào túi áo mà không cần mang theo hộp sạc.

## 3. Khi nào bạn BẮT BUỘC nên nâng cấp lên GAERU M3?
Bạn nên đầu tư ngay vào **GAERU M3** nếu công việc của bạn có những đặc thù sau:
- **Quay ngoại cảnh và sự kiện cả ngày:** Bạn đi du lịch, quay phóng sự đường phố, quay vlog ẩm thực dã ngoại. Hộp sạc dung lượng 500mAh cho phép bạn sạc lại micro từ 4 - 5 lần bất cứ lúc nào mà không cần ổ điện.
- **Phỏng vấn 2 người chuyên nghiệp:** M3 quản lý 2 micro cùng lúc cực kỳ ổn định, màn hình hiển thị chính xác dung lượng pin từng chiếc giúp bạn làm chủ buổi quay.
- **Môi trường nhiều gió:** M3 đi kèm sẵn bông lọc lông Deadcat chuyên dụng giúp triệt tiêu tiếng gió lùa ngoài trời mà K9 không có sẵn.

Cả hai sản phẩm đều được áp dụng chính sách bảo hành 12 tháng 1 đổi 1 và 7 ngày trải nghiệm đổi trả an tâm. Xem chi tiết [GAERU K9](https://gaeru.com/san-pham/gaeru-k9) và [GAERU M3](https://gaeru.com/san-pham/gaeru-m3).`
  },
  {
    uuid: 'c0000000-0000-4000-8000-000000000008',
    slug: 'phan-biet-gimbal-ai-gaeru-p01-va-tripod-p185',
    title: 'Phân biệt Gimbal xoay theo dõi AI GAERU P01 và Chân tripod GAERU P185: Đâu là thiết bị bạn thực sự cần?',
    badge: 'TƯ VẤN THIẾT BỊ',
    subHeader: 'Khi nào nên chọn gimbal bám người tự động, khi nào nên chọn chân đỡ 4 chân 1m8 siêu vững?',
    type: 'comparison',
    comparison: {
      left: {
        theme: 'teal',
        tag: 'CHỦ ĐỘNG BÁM NGƯỜI',
        model: 'GIMBAL AI P01',
        sub: 'TỰ DO DI CHUYỂN',
        features: [
          { f: 'Mắt thần AI xoay 360°', sub: 'Tự nhận diện dáng người, không cần app hay bluetooth' },
          { f: 'Điều khiển cử chỉ tay OK', sub: 'Bật/dừng bám theo rảnh tay khi nấu ăn, làm việc' },
          { f: 'Thiết kế để bàn hoặc gắn chân', sub: 'Đế tròn vững chắc, có lỗ ốc 1/4 inch đa năng' }
        ],
        verdictTag: 'Phù hợp nhất:',
        verdictText: 'Tự quay nấu ăn, dạy học online, DIY di chuyển nhiều'
      },
      right: {
        theme: 'amber',
        tag: 'VỮNG VÀNG LINH HOẠT',
        model: 'TRIPOD P185',
        sub: 'CHIỀU CAO 1M8 VƯỢT TRỘI',
        features: [
          { f: 'Hợp kim nhôm 4 chân siêu vững', sub: 'Chống gió lật, đứng vững trên mọi mặt phẳng gồ ghề' },
          { f: 'Chiều cao tối đa 1,8 mét', sub: 'Góc quay ngang tầm mắt, chuẩn tỷ lệ vàng khung hình' },
          { f: 'Remote Bluetooth bấm từ xa 10m', sub: 'Chụp ảnh nhóm, quay video không cần nhờ người' }
        ],
        verdictTag: 'Phù hợp nhất:',
        verdictText: 'Livestream cố định, chụp ảnh du lịch nhóm, dã ngoại'
      },
      vsText: 'VS'
    },
    excerpt: 'Rõ ràng công năng giữa đế tracking tự động trong nhà và gậy chụp tripod dã ngoại: chọn thiết bị tối ưu cho phong cách quay video và góc máy của bạn.',
    imageAlt: 'So sánh sự khác biệt giữa gimbal xoay AI GAERU P01 và chân tripod GAERU P185',
    body: `Khi dạo quanh danh mục phụ kiện ghi hình của GAERU, rất nhiều khách hàng đặt câu hỏi: *"GAERU P01 và GAERU P185 khác nhau ở điểm nào? Tôi nên mua chiếc nào để quay video trên điện thoại?"*

Dù cùng hỗ trợ giữ điện thoại để ghi hình, hai sản phẩm này được thiết kế cho hai **mục đích hoàn toàn khác biệt**.

## 1. GAERU P01: Đế xoay thông minh bám theo chuyển động (Smart AI Tracking Mount)
- **Bản chất:** Là một chiếc đế xoay tự động gắn camera AI 360 độ.
- **Thế mạnh lớn nhất:** Nó đóng vai trò như một "người quay phim cá nhân". Khi bạn đứng một chỗ và di chuyển qua lại trong phòng, P01 sẽ tự động lia máy quay theo từng bước chân của bạn.
- **Phù hợp nhất cho:** 
  - Người livestream bán hàng, giới thiệu thời trang trong shop.
  - Giáo viên, giảng viên đứng giảng bài trước bảng hoặc màn hình chiếu.
  - Người tập yoga, gym, vũ đạo cần máy tự xoay theo động tác.
  - Vlogger nấu ăn, làm đồ handmade tại bàn bếp.

## 2. GAERU P185: Gậy chụp ảnh kiêm Chân đế Tripod nối dài (Multi-function Tripod)
- **Bản chất:** Là một chiếc chân đỡ cơ học 3 chân bằng hợp kim nhôm, có thể kéo dài lên đến 1,85m và gấp gọn thành gậy cầm tay.
- **Thế mạnh lớn nhất:** Độ vững chãi, linh hoạt về chiều cao và góc nhìn bao quát.
- **Phù hợp nhất cho:**
  - Chụp ảnh nhóm, chụp ảnh gia đình đông người khi đi du lịch nhờ remote Bluetooth bấm chụp từ xa.
  - Quay video góc toàn cảnh ngoài trời, góc máy ngang tầm mắt người đứng thẳng.
  - Tự quay vlog dã ngoại, chụp ảnh check-in phong cảnh khi đi một mình.

## 3. Gợi ý phối hợp: Combo "bất khả chiến bại" P01 + P185
Bạn có biết rằng hai thiết bị này được thiết kế để có thể **kết hợp hoàn hảo với nhau**?
- Đáy của GAERU P01 được trang bị ren ốc tiêu chuẩn 1/4 inch.
- Bạn có thể tháo đầu kẹp của chân P185 và vặn trực tiếp chiếc gimbal xoay P01 lên đỉnh chân tripod P185.
- **Kết quả:** Bạn có ngay một hệ thống camera AI theo dõi thông minh có thể tùy chỉnh độ cao từ 50cm đến 1,85m, tự động xoay theo bạn ở bất kỳ không gian nào từ trong nhà ra đến sân vườn.

Khám phá ngay bộ đôi phụ kiện hỗ trợ quay phim tại https://gaeru.com/cua-hang.`
  },
  {
    uuid: 'c0000000-0000-4000-8000-000000000009',
    slug: 'huong-dan-sac-va-bao-quan-micro-thu-am-khong-day',
    title: 'Cách sạc và bảo quản thiết bị thu âm không dây: Tránh chai pin và hỏng chân tiếp xúc hộp sạc',
    badge: 'CHĂM SÓC THIẾT BỊ',
    subHeader: '3 nguyên tắc vàng kéo dài tuổi thọ cell pin lithium và giữ linh kiện luôn như mới',
    type: 'cards',
    cards: [
      {
        theme: 'amber',
        tag: 'NGUYÊN TẮC 1',
        title: 'Tránh Củ Sạc >15W',
        desc: [
          'Chỉ dùng nguồn 5V-1A hoặc 5V-2A',
          'Tránh sạc nhanh 65W/100W laptop',
          'Bảo vệ IC nguồn nhỏ không sốc điện'
        ],
        tip: '✓ Ngăn ngừa chai phồng pin',
        icon: 'zap'
      },
      {
        theme: 'sky',
        tag: 'NGUYÊN TẮC 2',
        title: 'Lau Chân Pogo Pin',
        desc: [
          'Dùng tăm bông khô hoặc cồn nhẹ',
          'Lau sạch mồ hôi và bụi ở điểm đồng',
          'Tránh oxy hóa làm tiếp xúc chập chờn'
        ],
        tip: '✓ Dòng sạc luôn ổn định 100%',
        icon: 'sparkle'
      },
      {
        theme: 'emerald',
        tag: 'NGUYÊN TẮC 3',
        title: 'Lưu Trữ 50% - 70%',
        desc: [
          'Không cất tủ khi pin cạn kiệt 0%',
          'Sạc lại định kỳ 2 tháng một lần',
          'Tránh pin ngủ sâu hỏng cell vĩnh viễn'
        ],
        tip: '✓ Tối đa hóa chu kỳ nạp xả',
        icon: 'battery'
      }
    ],
    excerpt: 'Quy tắc vàng bảo vệ pin lithium nhỏ: tránh củ sạc siêu nhanh công suất lớn, vệ sinh chân tiếp xúc pogo pin và lưu trữ đúng cách khi ít sử dụng để thiết bị bền bỉ nhiều năm.',
    imageAlt: 'Hướng dẫn sạc pin an toàn và vệ sinh chân tiếp xúc hộp sạc micro không dây GAERU',
    body: `Các thiết bị âm thanh không dây như micro cài áo hay hộp sạc thông minh sử dụng pin lithium polymer dung lượng nhỏ (khoảng 70mAh trên thân mic và 500mAh trên hộp sạc). Mặc dù mạch sạc của GAERU đều có chip bảo vệ quá nhiệt và quá dòng, việc sạc sai cách trong thời gian dài vẫn là nguyên nhân hàng đầu khiến pin nhanh chai hoặc chập chân tiếp xúc.

Dưới đây là 3 nguyên tắc sống còn giúp thiết bị của bạn luôn bền bỉ như mới sau nhiều năm sử dụng.

## 1. Nói KHÔNG với củ sạc nhanh công suất lớn (65W, 100W, sạc laptop)
Nhiều người có thói quen tiện tay dùng củ sạc nhanh của laptop hoặc củ sạc siêu nhanh 65W - 120W của điện thoại để cắm sạc cho hộp micro qua đêm.
- **Nguy cơ tiềm ẩn:** Mặc dù sạc Type-C có giao thức bắt tay nguồn điện (Power Delivery), một số củ sạc kém chất lượng hoặc sạc đa cổng khi cắm rút đột ngột có thể sinh ra xung điện áp cao (Voltage Spike), làm sốc IC nguồn của thiết bị nhỏ.
- **Khuyến nghị chuẩn mực:** Hãy sử dụng củ sạc tiêu chuẩn **5V/1A hoặc 5V/2A** (công suất từ 5W đến 10W), hoặc cắm sạc qua cổng USB của máy tính/cục sạc dự phòng. Dòng điện ổn định sẽ giúp các cell pin tích điện mát mẻ và kéo dài tuổi thọ tối đa.

## 2. Vệ sinh định kỳ các chân tiếp xúc kim loại (Pogo Pin)
Sau nhiều tuần sử dụng, mồ hôi cơ thể, bụi vải cổ áo và dầu nhờn có thể bám vào các điểm đồng tiếp xúc ở đáy micro hoặc chân lò xo bên trong hộp sạc **GAERU M3**:
- Dẫn đến hiện tượng: Đặt micro vào hộp nhưng đèn không báo sạc, hoặc một bên mic sạc không đầy.
- **Cách vệ sinh:** Dùng một chiếc tăm bông khô (hoặc thấm một giọt cồn y tế 70 độ vắt thật ráo), nhẹ nhàng lau sạch các chấm đồng ở đáy micro và bên trong lòng hộp sạc. Thực hiện việc này mỗi tháng một lần.

## 3. Cách bảo quản khi không có lịch quay trong thời gian dài
Nếu bạn nghỉ quay video từ 1 đến vài tháng:
- **Tuyệt đối không để pin cạn kiệt 0%:** Pin lithium để cạn kiệt lâu ngày sẽ rơi vào trạng thái "chết lâm sàng" (Deep Discharge) và không thể nhận sạc lại được.
- **Mức pin lý tưởng:** Hãy sạc thiết bị đến khoảng **50% - 70%** pin (hộp sạc GAERU M3 hiển thị khoảng 2 - 3 vạch) trước khi cất vào hộp bảo quản. Cất giữ ở nơi khô ráo, thoáng mát, tránh ánh nắng trực tiếp hoặc cốp xe máy nóng bức.

Nếu thiết bị của bạn gặp bất kỳ vấn đề nào về pin hoặc nguồn sạc trong thời hạn 12 tháng, GAERU cam kết hỗ trợ đổi mới chính hãng tại https://gaeru.com/dang-ky-bao-hanh.`
  },
  {
    uuid: 'c0000000-0000-4000-8000-000000000010',
    slug: 'chinh-sach-bao-hanh-dien-tu-mot-doi-mot-gaeru',
    title: 'Mua hàng online an tâm với Bảo hành điện tử 1 đổi 1 trong 12 tháng: Cách kiểm tra và quy trình xử lý tại GAERU',
    badge: 'CHÍNH SÁCH BẢO HÀNH',
    subHeader: 'Minh bạch, tốc độ và an tâm tuyệt đối – Quyền lợi khách hàng luôn đặt lên hàng đầu',
    type: 'cards',
    cards: [
      {
        theme: 'sky',
        tag: 'QUY TRÌNH 1',
        title: 'Tra Cứu Tự Động',
        desc: [
          'Bảo hành điện tử theo Số điện thoại',
          'Không cần lưu giữ hóa đơn giấy',
          'Tra cứu tức thì tại gaeru.com'
        ],
        tip: '✓ Minh bạch thời hạn 100%',
        icon: 'search'
      },
      {
        theme: 'emerald',
        tag: 'QUY TRÌNH 2',
        title: '1 Đổi 1 Thân Máy',
        desc: [
          'Lỗi kỹ thuật do NSX được đổi ngay',
          'Thân máy mới nguyên seal 100%',
          'Không sửa chữa chắp vá'
        ],
        tip: '✓ An tâm chất lượng chuẩn mực',
        icon: 'shield'
      },
      {
        theme: 'purple',
        tag: 'QUY TRÌNH 3',
        title: 'Thu Đổi Tận Nhà',
        desc: [
          'Shipper đến tận nhà nhận máy lỗi',
          'Giao máy mới tận tay khách hàng',
          'GAERU miễn phí ship 2 chiều'
        ],
        tip: '✓ Tiết kiệm thời gian tối đa',
        icon: 'truck'
      }
    ],
    excerpt: 'Khám phá quy trình bảo hành minh bạch không cần giữ hóa đơn giấy: tra cứu theo số điện thoại, đổi mới nguyên thân máy và hỗ trợ phí ship 2 chiều cho người mua hàng tại GAERU.',
    imageAlt: 'Quy trình kích hoạt và tra cứu bảo hành điện tử chính hãng 1 đổi 1 tại GAERU',
    body: `Nỗi lo lớn nhất của người tiêu dùng khi mua thiết bị công nghệ trực tuyến là: *"Lúc mua thì dễ, lúc hỏng thì không biết tìm ai; mất tờ phiếu bảo hành giấy là bị từ chối phục vụ"*.

Tại GAERU, chúng tôi tin rằng trải nghiệm sau bán hàng mới là thước đo chân thực nhất cho sự tử tế của một thương hiệu. Đó là lý do hệ sinh thái **Bảo hành điện tử 1 đổi 1** được xây dựng nhằm mang lại sự an tâm tuyệt đối cho khách hàng trên toàn quốc.

## 1. Bảo hành điện tử là gì? Tạm biệt nỗi lo mất giấy tờ
Mọi đơn hàng đặt mua qua website chính thức GAERU hoặc các gian hàng đối tác được ủy quyền đều được tự động đồng bộ lên hệ thống dữ liệu trung tâm:
- **Định danh bằng Số điện thoại:** Thông tin bảo hành được gắn liền với số điện thoại nhận hàng của bạn. Bạn không cần phải giữ lại vỏ hộp hay bất kỳ tờ hóa đơn giấy nào.
- **Tra cứu trực tuyến 24/7:** Bất cứ lúc nào, bạn chỉ cần truy cập vào cổng **https://gaeru.com/dang-ky-bao-hanh**, nhập số điện thoại hoặc mã đơn hàng là toàn bộ thời hạn bảo hành, lịch sử kích hoạt sẽ hiển thị minh bạch.

## 2. Cam kết "1 đổi 1 trong 12 tháng": Đổi mới, không sửa chữa chắp vá
Khi thiết bị gặp lỗi kỹ thuật từ nhà sản xuất (như không nhận sạc, mất kết nối không dây, lỗi micro thu âm):
- GAERU áp dụng chính sách **đổi mới nguyên thân máy** cho khách hàng, thay vì giữ máy lại để tháo mở sửa chữa chắp vá làm mất giá trị thiết bị.
- Thời gian xử lý thần tốc trong vòng **24 - 48 giờ** làm việc kể từ khi tiếp nhận sản phẩm.

## 3. Quy trình bảo hành 3 bước cực kỳ đơn giản ngay tại nhà
Bạn không cần phải mang máy đi đâu xa:
1. **Bước 1:** Gửi yêu cầu hỗ trợ qua cổng trực tuyến https://gaeru.com/ho-tro hoặc nhắn tin trực tiếp trên website.
2. **Bước 2:** Chuyên viên kỹ thuật GAERU hỗ trợ hướng dẫn kiểm tra nhanh từ xa (để loại trừ trường hợp quên bật OTG hoặc cài đặt ứng dụng).
3. **Bước 3:** Nếu xác định lỗi do thiết bị, GAERU sẽ điều phối nhân viên bưu tá đến tận nhà nhận lại sản phẩm và gửi thiết bị đổi mới đến tận tay bạn hoàn toàn miễn phí vận chuyển.

Bên cạnh đó, khách hàng luôn có quyền lợi **7 ngày dùng thử trải nghiệm đổi trả minh bạch**. Sự hài lòng của bạn là cam kết bền vững nhất của GAERU. Khám phá toàn bộ sản phẩm chính hãng tại https://gaeru.com/cua-hang.`
  }
];

// Helper to wrap text into lines
function wrapText(text, maxChars = 56) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const w of words) {
    if (!current) current = w;
    else if ((current + ' ' + w).length <= maxChars) current += ' ' + w;
    else { lines.push(current); current = w; }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function generateEditorialCoverSvg(art) {
  const safeBadge = escapeXml(art.badge);
  const safeHeadline = escapeXml(art.title);
  const safeSubHeader = escapeXml(art.subHeader);

  // Split headline if needed
  const headlineLines = wrapText(safeHeadline, 52);
  const hlLine1 = headlineLines[0] || '';
  const hlLine2 = headlineLines.slice(1).join(' ') || '';

  // Background and ambient accents
  const bgSvg = `
    <defs>
      <linearGradient id="bg-${art.uuid}" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#f8fafc" />
        <stop offset="100%" stop-color="#f1f5f9" />
      </linearGradient>
      <linearGradient id="vs-grad-${art.uuid}" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0284c7" />
        <stop offset="100%" stop-color="#2563eb" />
      </linearGradient>
      <filter id="card-shadow-${art.uuid}" x="-10%" y="-10%" width="120%" height="120%">
        <feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#0f172a" flood-opacity="0.07" />
      </filter>
      <filter id="vs-shadow-${art.uuid}" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#0284c7" flood-opacity="0.35" />
      </filter>
    </defs>

    <rect width="1200" height="750" fill="url(#bg-${art.uuid})" />
    <circle cx="1120" cy="120" r="280" fill="#38bdf8" opacity="0.08" />
    <circle cx="80" cy="650" r="260" fill="#818cf8" opacity="0.06" />

    <!-- Top Eyebrow & Headline -->
    <text x="80" y="70" fill="#0284c7" font-family="${FONT_FAMILY}" font-size="13" font-weight="bold" letter-spacing="2">GAERU / ${safeBadge}</text>
    <text x="80" y="112" fill="#0f172a" font-family="${FONT_FAMILY}" font-size="${hlLine2 ? '30' : '32'}" font-weight="bold">${hlLine1}</text>
    ${hlLine2 ? `<text x="80" y="148" fill="#0f172a" font-family="${FONT_FAMILY}" font-size="28" font-weight="bold">${hlLine2}</text>` : ''}
    <text x="80" y="${hlLine2 ? '182' : '148'}" fill="#64748b" font-family="${FONT_FAMILY}" font-size="15" font-weight="500">${safeSubHeader}</text>
  `;

  // Content Area: either 3 cards or 2 comparison cards
  let contentSvg = '';
  const cardStartY = hlLine2 ? 205 : 175;
  const cardHeight = hlLine2 ? 440 : 465;

  if (art.type === 'comparison' && art.comparison) {
    const comp = art.comparison;
    const leftTheme = THEMES[comp.left.theme] || THEMES.sky;
    const rightTheme = THEMES[comp.right.theme] || THEMES.purple;

    contentSvg = `
      <!-- Left Card: ${escapeXml(comp.left.model)} -->
      <g transform="translate(80, ${cardStartY})">
        <rect width="490" height="${cardHeight}" rx="20" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5" filter="url(#card-shadow-${art.uuid})" />
        
        <!-- Header banner -->
        <path d="M 0 20 Q 0 0 20 0 L 470 0 Q 490 0 490 20 L 490 92 L 0 92 Z" fill="${leftTheme.bgLight}" />
        <line x1="0" y1="92" x2="490" y2="92" stroke="${leftTheme.border}" stroke-width="1.2" />

        <!-- Tag Pill -->
        <rect x="25" y="18" width="160" height="24" rx="12" fill="${leftTheme.pillBg}" />
        <text x="105" y="34" fill="${leftTheme.pillText}" font-family="${FONT_FAMILY}" font-size="11" font-weight="bold" text-anchor="middle" letter-spacing="1">${escapeXml(comp.left.tag)}</text>
        
        <!-- Model Title -->
        <text x="25" y="74" fill="${leftTheme.titleColor}" font-family="${FONT_FAMILY}" font-size="26" font-weight="bold">${escapeXml(comp.left.model)}</text>
        <text x="465" y="70" fill="${leftTheme.pillText}" font-family="${FONT_FAMILY}" font-size="13" font-weight="bold" text-anchor="end">${escapeXml(comp.left.sub)}</text>

        <!-- Feature Rows -->
        <g transform="translate(25, 120)">
          ${comp.left.features.map((feat, idx) => `
            <g transform="translate(0, ${idx * 64})">
              <circle cx="14" cy="14" r="14" fill="${leftTheme.bgLight}" stroke="${leftTheme.border}" />
              <path d="M9 14l3.5 3.5 7-7" stroke="${leftTheme.iconColor}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
              <text x="42" y="14" fill="#0f172a" font-family="${FONT_FAMILY}" font-size="16" font-weight="bold">${escapeXml(feat.f)}</text>
              <text x="42" y="34" fill="#64748b" font-family="${FONT_FAMILY}" font-size="13.5">${escapeXml(feat.sub)}</text>
            </g>
          `).join('')}
        </g>

        <!-- Bottom Verdict Pill -->
        <rect x="20" y="${cardHeight - 55}" width="450" height="38" rx="12" fill="#f8fafc" stroke="#e2e8f0" />
        <text x="35" y="${cardHeight - 31}" fill="${leftTheme.titleColor}" font-family="${FONT_FAMILY}" font-size="12.5" font-weight="bold">${escapeXml(comp.left.verdictTag)}</text>
        <text x="125" y="${cardHeight - 31}" fill="#334155" font-family="${FONT_FAMILY}" font-size="12" font-weight="500">${escapeXml(comp.left.verdictText)}</text>
      </g>

      <!-- Right Card: ${escapeXml(comp.right.model)} -->
      <g transform="translate(630, ${cardStartY})">
        <rect width="490" height="${cardHeight}" rx="20" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5" filter="url(#card-shadow-${art.uuid})" />
        
        <!-- Header banner -->
        <path d="M 0 20 Q 0 0 20 0 L 470 0 Q 490 0 490 20 L 490 92 L 0 92 Z" fill="${rightTheme.bgLight}" />
        <line x1="0" y1="92" x2="490" y2="92" stroke="${rightTheme.border}" stroke-width="1.2" />

        <!-- Tag Pill -->
        <rect x="25" y="18" width="165" height="24" rx="12" fill="${rightTheme.pillBg}" />
        <text x="107" y="34" fill="${rightTheme.pillText}" font-family="${FONT_FAMILY}" font-size="11" font-weight="bold" text-anchor="middle" letter-spacing="1">${escapeXml(comp.right.tag)}</text>
        
        <!-- Model Title -->
        <text x="25" y="74" fill="${rightTheme.titleColor}" font-family="${FONT_FAMILY}" font-size="26" font-weight="bold">${escapeXml(comp.right.model)}</text>
        <text x="465" y="70" fill="${rightTheme.pillText}" font-family="${FONT_FAMILY}" font-size="13" font-weight="bold" text-anchor="end">${escapeXml(comp.right.sub)}</text>

        <!-- Feature Rows -->
        <g transform="translate(25, 120)">
          ${comp.right.features.map((feat, idx) => `
            <g transform="translate(0, ${idx * 64})">
              <circle cx="14" cy="14" r="14" fill="${rightTheme.bgLight}" stroke="${rightTheme.border}" />
              <path d="M9 14l3.5 3.5 7-7" stroke="${rightTheme.iconColor}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
              <text x="42" y="14" fill="#0f172a" font-family="${FONT_FAMILY}" font-size="16" font-weight="bold">${escapeXml(feat.f)}</text>
              <text x="42" y="34" fill="#64748b" font-family="${FONT_FAMILY}" font-size="13.5">${escapeXml(feat.sub)}</text>
            </g>
          `).join('')}
        </g>

        <!-- Bottom Verdict Pill -->
        <rect x="20" y="${cardHeight - 55}" width="450" height="38" rx="12" fill="#f8fafc" stroke="#e2e8f0" />
        <text x="35" y="${cardHeight - 31}" fill="${rightTheme.titleColor}" font-family="${FONT_FAMILY}" font-size="12.5" font-weight="bold">${escapeXml(comp.right.verdictTag)}</text>
        <text x="125" y="${cardHeight - 31}" fill="#334155" font-family="${FONT_FAMILY}" font-size="12" font-weight="500">${escapeXml(comp.right.verdictText)}</text>
      </g>

      <!-- Central VS Badge -->
      <g transform="translate(600, ${cardStartY + (cardHeight / 2)})">
        <circle cx="0" cy="0" r="34" fill="url(#vs-grad-${art.uuid})" stroke="#ffffff" stroke-width="4" filter="url(#vs-shadow-${art.uuid})" />
        <text x="0" y="8" fill="#ffffff" font-family="${FONT_FAMILY}" font-size="20" font-weight="900" text-anchor="middle" font-style="italic">VS</text>
      </g>
    `;
  } else {
    // 3 Cards Layout
    const cards = art.cards || [];
    const cardWidth = 340;
    const cardGap = 10;
    const startX = 80;

    contentSvg = cards.map((c, idx) => {
      const theme = THEMES[c.theme] || THEMES.sky;
      const x = startX + idx * (cardWidth + 10);
      const iconSvg = getIconSvg(c.icon, theme.iconColor);

      return `
        <g transform="translate(${x}, ${cardStartY})">
          <rect width="${cardWidth}" height="${cardHeight}" rx="20" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5" filter="url(#card-shadow-${art.uuid})" />
          
          <!-- Circle Icon Badge -->
          <circle cx="170" cy="65" r="36" fill="${theme.bgLight}" stroke="${theme.border}" stroke-width="1.5" />
          <g transform="translate(150, 45) scale(1.25)" stroke="${theme.iconColor}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
            ${iconSvg}
          </g>

          <!-- Step Tag Pill -->
          <rect x="105" y="120" width="130" height="24" rx="12" fill="${theme.pillBg}" />
          <text x="170" y="136" fill="${theme.pillText}" font-family="${FONT_FAMILY}" font-size="11" font-weight="bold" text-anchor="middle" letter-spacing="1.2">${escapeXml(c.tag)}</text>

          <!-- Card Title -->
          <text x="170" y="175" fill="#0f172a" font-family="${FONT_FAMILY}" font-size="19" font-weight="bold" text-anchor="middle">${escapeXml(c.title)}</text>
          
          <line x1="40" y1="202" x2="300" y2="202" stroke="#f1f5f9" stroke-width="1.5" />

          <!-- Desc Lines -->
          ${c.desc.map((dLine, dIdx) => `
            <text x="170" y="${236 + dIdx * 28}" fill="#475569" font-family="${FONT_FAMILY}" font-size="14" font-weight="500" text-anchor="middle">${escapeXml(dLine)}</text>
          `).join('')}

          <!-- Bottom Tip Pill -->
          <rect x="25" y="${cardHeight - 55}" width="290" height="36" rx="18" fill="#f8fafc" stroke="#e2e8f0" />
          <text x="170" y="${cardHeight - 32}" fill="${theme.pillText}" font-family="${FONT_FAMILY}" font-size="12" font-weight="bold" text-anchor="middle">${escapeXml(c.tip)}</text>
        </g>
      `;
    }).join('\n');
  }

  // Footer bar
  const footerSvg = `
    <line x1="80" y1="680" x2="1120" y2="680" stroke="#e2e8f0" stroke-width="1.2" />
    <text x="80" y="718" fill="#0f172a" font-family="${FONT_FAMILY}" font-size="22" font-weight="bold" letter-spacing="2">GAERU</text>
    <text x="190" y="717" fill="#64748b" font-family="${FONT_FAMILY}" font-size="14.5" font-weight="500">|   Hệ sinh thái thiết bị sáng tạo nội dung &amp; âm thanh di động</text>
    <text x="1120" y="717" fill="#0284c7" font-family="${FONT_FAMILY}" font-size="15" font-weight="bold" text-anchor="end">gaeru.com/tin-tuc</text>
  `;

  return `
    <svg width="1200" height="750" viewBox="0 0 1200 750" xmlns="http://www.w3.org/2000/svg">
      ${bgSvg}
      ${contentSvg}
      ${footerSvg}
    </svg>
  `;
}

async function main() {
  console.log(`[publish-10-articles] Preparing ${articles.length} new articles with tailored visual infographic covers...`);

  const newsDir = path.join(ROOT, 'assets', 'news');
  if (!fs.existsSync(newsDir)) fs.mkdirSync(newsDir, { recursive: true });

  const generatedImages = [];
  const sqlInsertsImages = [];
  const sqlInsertsPosts = [];

  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    const svg = generateEditorialCoverSvg(art);

    const webpBuf = await sharp(Buffer.from(svg))
      .webp({ quality: 90, effort: 6 })
      .toBuffer();
    const avifBuf = await sharp(Buffer.from(svg))
      .avif({ quality: 86, effort: 8, chromaSubsampling: '4:4:4', tune: 'ssim' })
      .toBuffer();

    // Write to assets/news
    const webpPath = path.join(newsDir, `${art.slug}.webp`);
    const avifPath = path.join(newsDir, `${art.slug}.avif`);
    fs.writeFileSync(webpPath, webpBuf);
    fs.writeFileSync(avifPath, avifBuf);

    generatedImages.push({
      uuid: art.uuid,
      slug: art.slug,
      webpBytes: webpBuf.length,
      avifBytes: avifBuf.length
    });

    const hexWebp = webpBuf.toString('hex');
    sqlInsertsImages.push(
      `INSERT INTO news_images(id, content, mime_type, created_at)\nVALUES('${art.uuid}'::uuid, decode('${hexWebp}', 'hex'), 'image/webp', now())\nON CONFLICT(id) DO UPDATE SET content=EXCLUDED.content, mime_type=EXCLUDED.mime_type;`
    );

    const safeTitle = art.title.replace(/'/g, "''");
    const safeExcerpt = art.excerpt.replace(/'/g, "''");
    const safeBody = art.body.replace(/'/g, "''");
    const safeAlt = art.imageAlt.replace(/'/g, "''");

    const minutesAgo = (articles.length - i) * 2;
    sqlInsertsPosts.push(`INSERT INTO news_posts(slug, title, excerpt, body, cover_id, image_alt, status, published_at, updated_at)
VALUES(
  '${art.slug}',
  '${safeTitle}',
  '${safeExcerpt}',
  '${safeBody}',
  '${art.uuid}'::uuid,
  '${safeAlt}',
  'published',
  now() - interval '${minutesAgo} minutes',
  now()
)
ON CONFLICT (slug) DO UPDATE SET
  title = EXCLUDED.title,
  excerpt = EXCLUDED.excerpt,
  body = EXCLUDED.body,
  cover_id = EXCLUDED.cover_id,
  image_alt = EXCLUDED.image_alt,
  status = EXCLUDED.status,
  updated_at = now();`);
  }

  // 1. Write SQL Migration file
  const sqlFile = path.join(ROOT, 'db', 'practical-guides-and-comparisons-20261117.sql');
  const fullSql = [
    '-- Migration: 10 Practical Guides, Comparisons & Policy Articles with WebP/AVIF Covers',
    '-- Conforms to news_images(id, content, mime_type) and news_posts(...) schema.\n',
    '-- 1. Insert/Update cover images in news_images',
    sqlInsertsImages.join('\n\n'),
    '\n-- 2. Insert/Update articles in news_posts',
    sqlInsertsPosts.join('\n\n')
  ].join('\n');
  fs.writeFileSync(sqlFile, fullSql, 'utf8');
  console.log(`[publish-10-articles] Wrote SQL migration to ${sqlFile}`);

  // 2. Write JSON content backup
  const jsonFile = path.join(ROOT, 'content', 'practical-guides-and-comparisons-20261117.json');
  fs.writeFileSync(
    jsonFile,
    JSON.stringify(
      articles.map(a => ({
        slug: a.slug,
        title: a.title,
        excerpt: a.excerpt,
        body: a.body,
        coverId: a.uuid,
        imageUrl: `/api/news-images/${a.uuid}`,
        imageAlt: a.imageAlt,
        status: 'published'
      })),
      null,
      2
    ) + '\n',
    'utf8'
  );
  console.log(`[publish-10-articles] Wrote content JSON backup to ${jsonFile}`);

  // 3. If local database is reachable, apply migration directly
  try {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://gaeru:gaeru@127.0.0.1:5432/gaeru'
    });
    console.log('[publish-10-articles] Attempting database connection...');
    await pool.query(fullSql);
    console.log('[publish-10-articles] Applied SQL migration successfully to local database!');
    await pool.end();
  } catch (dbErr) {
    console.log('[publish-10-articles] Local DB not available or offline:', dbErr.message);
  }

  console.log('[publish-10-articles] Done! Successfully re-rendered all 10 visual editorial covers (WebP + AVIF)!');
  console.table(generatedImages);
}

main().catch(err => {
  console.error('[publish-10-articles] Fatal error:', err);
  process.exitCode = 1;
});
