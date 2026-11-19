'use strict';

/**
 * Curated GAERU Customer Semantic FAQ Prototypes (P2 GPU AI Rescue Layer).
 *
 * Pre-indexed into PostgreSQL `ai_embedding_vectors` under namespace `customer_faqs`
 * so paraphrased / unconventional Vietnamese customer queries that bypass strict
 * deterministic rules can still be answered accurately in ~40ms via gaeru-gpu-ai v2
 * without risking off-topic hallucination.
 */

const { embedText, isGpuAiEnabled } = require('./gpu-ai-client');
const { ensureEmbeddings, rankByCosine } = require('./embedding-store');
const { tokenizeMeaningful } = require('./ai-nlu');

const CUSTOMER_SEMANTIC_FAQS = Object.freeze([
  {
    key: 'faq_vat_invoice',
    text: 'Xuất hóa đơn đỏ VAT điện tử cho công ty doanh nghiệp kê khai thuế mã số thuế',
    answer:
      'Hiện **GAERU không hỗ trợ xuất hóa đơn VAT điện tử (hóa đơn đỏ)**.\n' +
      '- Mọi đơn hàng đặt trên website đều có **thông tin xác nhận đơn hàng** đầy đủ trên hệ thống và được **kích hoạt/tra cứu bảo hành điện tử** theo mã đơn hàng hoặc số điện thoại.'
  },
  {
    key: 'faq_android_camera_app',
    text: 'Điện thoại Android OPPO Realme Redmi Xiaomi Samsung dòng A M vivo cắm mic không thu tiếng trong app máy ảnh cam thường mặc định có cần tải app TikTok CapCut Ulike WutaCam VutaCam B612 Open Camera không',
    answer:
      '**Lưu ý sử dụng micro GAERU trên điện thoại Android:**\n' +
      '1. **Bật OTG (OPPO, vivo, Realme/Redmi…):** Vào **Cài đặt → ô tìm kiếm → gõ `"OTG"` → chọn `"Kết nối OTG"` → kích hoạt mở lên** (hoặc tìm YouTube *"hướng dẫn mở OTG"*).\n' +
      '2. **Máy Android không có OTG hoặc Samsung:** Cần kích hoạt **"Gỡ lỗi USB"** trước khi sử dụng (tìm video *"Hướng dẫn mở gỡ lỗi usb"* trên TikTok / YouTube / Google).\n' +
      '3. **Chọn app Camera quay video (OPPO, Realme/Redmi, Samsung dòng A/M & một số máy Trung Quốc):** App **"Máy ảnh" (cam thường)** mặc định chỉ dùng mic có sẵn của điện thoại, không nhận mic ngoài — bạn hãy quay bằng **TikTok, CapCut, Ulike, WutaCam (VutaCam), B612** hoặc **Open Camera** (*Micro ngoài*).\n' +
      '- Chưa rõ bước nào hãy gọi trực tiếp **082 919 1080** để shop hướng dẫn ngay nhé!'
  },
  {
    key: 'faq_android_otg_usb_debug',
    text: 'Cách mở bật kích hoạt OTG trên OPPO vivo Realme Redmi máy Android không có OTG hoặc Samsung bật gỡ lỗi USB trước khi sử dụng tìm video hướng dẫn mở gỡ lỗi usb',
    answer:
      '**Hướng dẫn nhanh bật OTG & Gỡ lỗi USB trên Android:**\n' +
      '- **OPPO, vivo, Realme/Redmi… (có OTG):** Vào **Cài đặt điện thoại → ô tìm kiếm → gõ `"OTG"` → chọn `"Kết nối OTG"` → kích hoạt mở lên** (hoặc tìm YouTube *"hướng dẫn mở OTG"*).\n' +
      '- **Máy Android không có OTG hoặc Samsung:** Cần kích hoạt **"Gỡ lỗi USB"** trong *Tùy chọn nhà phát triển* trước khi sử dụng (xem video hướng dẫn trên TikTok / YouTube / Google với từ khóa *"Hướng dẫn mở gỡ lỗi usb"*, và đảm bảo mục *Tắt định tuyến âm thanh USB* đang TẮT).\n' +
      '- **Chú ý:** Với **OPPO, Realme/Redmi, Samsung dòng A/M** & máy Trung Quốc, hãy quay bằng **TikTok, CapCut, Ulike, WutaCam (VutaCam), B612** hoặc **Open Camera** (*Micro ngoài*) thay cho app Máy ảnh (cam thường). Cần hỗ trợ trực tiếp gọi **082 919 1080**!'
  },
  {
    key: 'faq_cod_inspect',
    text: 'Nhận hàng COD có được mở hộp kiểm tra đồng kiểm bóc ra xem hàng test cắm thử trước khi thanh toán trả tiền không',
    answer:
      '**Chính sách đồng kiểm khi nhận hàng GAERU:**\n' +
      '- Bạn **được mở hộp kiểm tra ngoại quan** cùng nhân viên giao hàng trước khi thanh toán (đối chiếu đúng mẫu mã, số lượng, cổng cắm, phụ kiện và tình trạng nguyên vẹn).\n' +
      '- **Không cắm thử hoặc sử dụng thử** trong lúc đồng kiểm; nếu phát hiện móp vỡ, thiếu phụ kiện hoặc giao sai phân loại, bạn có quyền từ chối nhận ngay không mất phí.\n' +
      '- Sau khi nhận hàng, nếu thiết bị phát sinh lỗi kỹ thuật vẫn được **đổi mới 1:1 trong 7 ngày** (GAERU chịu 100% phí ship 2 chiều) và **bảo hành chính hãng 12 tháng**.'
  },
  {
    key: 'faq_return_exchange',
    text: 'Chính sách đổi trả hàng hoàn tiền mua về không hợp nhầm cổng hoặc bị lỗi đổi mới 1 đổi 1 trong bao nhiêu ngày',
    answer:
      '**Chính sách Đổi trả & Hoàn tiền GAERU:**\n' +
      '- **Đổi mới 1:1 trong 7 ngày** kể từ khi ký nhận nếu sản phẩm có lỗi kỹ thuật từ nhà sản xuất hoặc giao sai mẫu mã/cổng kết nối (yêu cầu còn đủ hộp, phụ kiện, không va đập/ngấm nước; GAERU chịu **100% phí vận chuyển 2 chiều**).\n' +
      '- **Hoàn tiền 100%** trong **3–5 ngày làm việc** nếu hết hàng đổi, hủy đơn hợp lệ trước khi giao hoặc trả hàng đúng điều kiện.\n' +
      '- Nếu bạn lỡ chọn nhầm chân cắm hoặc cần đổi phân loại, nhắn **mã đơn hàng** hoặc gọi **082 919 1080** để nhân viên hỗ trợ xử lý nhanh nhé.'
  },
  {
    key: 'faq_contact_store',
    text: 'Số điện thoại hotline email giờ làm việc liên hệ địa chỉ trụ sở cửa hàng GAERU ở đâu có mua trực tiếp không',
    answer:
      '**Thông tin liên hệ & kênh mua hàng GAERU:**\n' +
      '- **Hotline:** **082 919 1080** · **Email:** `business@gaeru.com`\n' +
      '- **Giờ làm việc:** Thứ 2 – Thứ 6: **10:00 – 17:00** · Thứ 7, Chủ nhật & ngày lễ: **10:00 – 16:00**\n' +
      '- **Kênh mua hàng:** GAERU phục vụ đặt hàng trực tuyến tại **[gaeru.com](/shop)** và giao hàng toàn quốc (được mở hộp đồng kiểm ngoại quan trước khi thanh toán).\n' +
      '- **Trụ sở đăng ký:** Thôn 2, Xã Rạng Đông, Tỉnh Ninh Bình.'
  },
  {
    key: 'faq_waterproof',
    text: 'Micro GAERU K9 M3 G1 ULTRA gimbal P01 có chống nước đi mưa rơi xuống nước mồ hôi ẩm ướt được không',
    answer:
      '**Khả năng chống nước:** Các thiết bị điện tử GAERU (**K9, M3, G1 ULTRA, P01**) **không có chuẩn chống nước IP**, không nên sử dụng trực tiếp dưới trời mưa hoặc nơi ẩm ướt.\n' +
      '- Cần giữ khô đầu micro và các chân đồng tiếp xúc sạc trước khi cất vào hộp (bảo hành không áp dụng với thiết bị bị ngấm nước hoặc oxy hóa do ẩm).'
  },
  {
    key: 'faq_bulk_discount',
    text: 'Mua số lượng nhiều sỉ đại lý 3 bộ 5 bộ 10 bộ cho đội nhóm công ty trường học có giảm giá chiết khấu không',
    answer:
      '**Ưu đãi khi mua số lượng nhiều / mua sỉ:**\n' +
      '- Mọi đơn đặt tại **gaeru.com** đều được **Freeship toàn quốc** (theo chính sách hiện hành) và tích **1%–2% GAERU Xu** theo hạng thành viên.\n' +
      '- Với nhu cầu đặt **từ 3 bộ trở lên / mua sỉ / đặt cho doanh nghiệp hoặc đội nhóm**, bạn nhắn rõ số lượng + mẫu cần lấy hoặc bấm **Gặp nhân viên** / gọi Hotline **082 919 1080** để chuyên viên GAERU báo mức ưu đãi tốt nhất nhé!'
  },
  {
    key: 'faq_led_charging_m3_k9',
    text: 'Đèn báo trên micro K9 M3 nhấp nháy đỏ xanh sáng đứng ý nghĩa là gì sạc hộp sạc bao lâu đầy pin yếu',
    productScope: ['gaeru-k9', 'gaeru-m3', 'gaeru-g1-ultra'],
    answer:
      '**Ý nghĩa đèn báo & lưu ý sạc micro GAERU (K9 / M3 / G1 ULTRA):**\n' +
      '- **Đèn nhấp nháy luân phiên / nhấp nháy chậm:** Micro đang chờ ghép nối với đầu thu RX (hãy cắm sát RX vào máy, tháo ốp dày, bật OTG nếu là OPPO/Realme/Vivo) hoặc đang báo **pin yếu** (nháy đỏ).\n' +
      '- **Đèn sáng đứng ổn định:** Micro và đầu thu đã kết nối thành công và sẵn sàng thu âm.\n' +
      '- **Sạc pin an toàn:** Dùng cáp đi kèm và củ sạc chuẩn **5V/1A – 5V/2A** (tránh củ sạc siêu nhanh công suất cao). Với hộp sạc **M3 / G1 ULTRA**, lau khô sạch chân đồng tiếp xúc dưới đáy mic trước khi đặt vào hộp; thời gian sạc đầy tham khảo khoảng **1,5–2 giờ** tùy nguồn 5V (đối chiếu thêm đèn báo trên tờ hướng dẫn trong hộp).'
  },
  {
    key: 'faq_noise_mode_button',
    text: 'Cách bật tắt chế độ lọc ồn giảm tiếng ồn chống ồn AI nút bấm trên thân micro M3 K9 tiếng gió ngoài trời',
    productScope: ['gaeru-k9', 'gaeru-m3', 'gaeru-g1-ultra'],
    answer:
      '**Cách bật chế độ lọc ồn & kiểm tra âm thanh micro GAERU:**\n' +
      '- Sau khi cắm đầu thu và bật nguồn micro (đèn kết nối sáng đứng), bấm nhanh **nút nguồn / nút chức năng** trên thân micro theo ký hiệu hướng dẫn trong hộp để chuyển mức giảm ồn (tránh nhấn giữ lâu vì nhấn giữ là tắt nguồn).\n' +
      '- Khi quay ngoài trời hoặc gần quạt, gắn thêm **bông lọc gió (deadcat)**, kẹp micro cách miệng **10–15 cm** và thu thử 5 giây để nghe kiểm tra trực tiếp trước khi quay chính thức.'
  },
  {
    key: 'faq_p185_remote_bluetooth',
    text: 'Hướng dẫn cách kết nối ghép đôi ghép nối remote điều khiển chụp ảnh từ xa Bluetooth gậy selfie tripod GAERU P185 không bấm chụp được',
    productScope: ['gaeru-p185'],
    answer:
      '**Hướng dẫn kết nối & sử dụng remote Bluetooth GAERU P185:**\n' +
      '1. **Bật nguồn remote:** Tháo remote khỏi thân gậy, gạt công tắc/nhấn giữ nút nguồn cho đến khi đèn báo nhấp nháy (remote dùng pin sạc **55 mAh**, sạc lại qua cổng **Type-C**).\n' +
      '2. **Ghép nối Bluetooth:** Mở **Cài đặt → Bluetooth** trên điện thoại, tìm tên thiết bị remote P185 và bấm kết nối.\n' +
      '3. **Bấm chụp/quay thử:** Mở ứng dụng Camera mặc định và bấm thử ở cự ly gần (nếu bấm không chụp, kiểm tra pin remote và thiết lập nút âm lượng làm nút chụp trong cài đặt Camera).'
  },
  {
    key: 'faq_p01_tracking_setup',
    text: 'Hướng dẫn cách sử dụng bật chế độ tự động xoay theo dõi khuôn mặt gimbal AI GAERU P01 không xoay bị nghiêng mất cân bằng',
    productScope: ['gaeru-p01'],
    answer:
      '**Hướng dẫn sử dụng Gimbal AI GAERU P01 (xoay 360° theo người):**\n' +
      '1. **Đặt vững:** Đặt bản để bàn trên mặt phẳng chắc chắn (hoặc siết chặt ren 1/4" với chân đứng 2m1), kẹp điện thoại cân tâm không đè nút nguồn/âm lượng.\n' +
      '2. **Bật theo dõi AI:** Bật nguồn trực tiếp trên thân P01 — cảm biến quang học tự bám theo khuôn mặt/dáng người **không cần cài app hay ghép Bluetooth**, dùng được ngay với Camera gốc, TikTok, Facebook, CapCut, Zoom.\n' +
      '3. **Mẹo theo dõi mượt:** Đứng ở nơi đủ sáng, tránh vật che cảm biến và di chuyển vừa phải để trục xoay bám chính xác nhất.'
  },
  {
    key: 'faq_playback_no_speaker',
    text: 'Cắm đầu thu micro vào điện thoại xem lại phát lại video không nghe thấy tiếng loa ngoài bị mất loa',
    answer:
      '**Vì sao cắm đầu thu không nghe loa ngoài khi xem lại video?**\n' +
      '- Khi đầu thu RX còn đang cắm ở cổng sạc, điện thoại nhận diện đây là thiết bị âm thanh ngoài nên tạm ngắt loa ngoài.\n' +
      '- Bạn chỉ cần **rút đầu thu RX ra** khỏi điện thoại là phát lại video nghe loa ngoài bình thường ngay.'
  }
]);

async function matchCustomerSemanticFaq(pool, rawQuestion, { matchedProdKey = null, transport } = {}) {
  if (!isGpuAiEnabled() && typeof transport !== 'function') return null;
  const q = String(rawQuestion || '').trim();
  if (q.length < 8) return null;
  const tokens = tokenizeMeaningful(q);
  if (tokens.length < 2) return null;

  const candidates = CUSTOMER_SEMANTIC_FAQS.filter(item => {
    if (!matchedProdKey || !Array.isArray(item.productScope)) return true;
    return item.productScope.includes(matchedProdKey);
  });
  if (!candidates.length) return null;

  const embedItems = candidates.map(c => ({ key: c.key, text: c.text }));
  const embedOpts = typeof transport === 'function' ? { transport, skipDb: true } : {};

  const [qVec, vecMap] = await Promise.all([
    embedText(q, typeof transport === 'function' ? { transport } : {}),
    ensureEmbeddings(pool, 'customer_faqs', embedItems, embedOpts)
  ]);

  if (!qVec || !vecMap || vecMap.size === 0) return null;

  const itemsWithVec = [];
  for (const c of candidates) {
    const vec = vecMap.get(c.key);
    if (vec) itemsWithVec.push({ key: c.key, vec, item: c });
  }
  if (!itemsWithVec.length) return null;

  const ranked = rankByCosine(qVec, itemsWithVec, { topK: 2, minCos: 0.55 });
  const best = ranked.best;
  if (!best) return null;

  // Calibrated strict acceptance gate to avoid false positives on off-topic queries
  const accepted = best.cos >= 0.64 || (best.cos >= 0.56 && ranked.margin >= 0.06);
  if (!accepted) return null;

  return {
    key: best.key,
    score: Number(best.cos.toFixed(4)),
    margin: Number(ranked.margin.toFixed(4)),
    answer: best.item.answer
  };
}

module.exports = {
  CUSTOMER_SEMANTIC_FAQS,
  matchCustomerSemanticFaq
};
