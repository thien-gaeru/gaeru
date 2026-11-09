'use strict';

/**
 * GAERU AI Customer Assistant (Lõi trí tuệ nhân tạo hỗ trợ bán hàng & CSKH GAERU)
 * 
 * Hoạt động độc lập 100% nội bộ, không phụ thuộc vào AI bên ngoài.
 * Tích hợp kiến thức sâu về sản phẩm, tương thích thiết bị, tra cứu đơn hàng,
 * chính sách GAERU Xu, bảo hành và giao vận.
 */

const { getRelevantWebKnowledge } = require('./chat-web-knowledge');
const { getExternalWebKnowledge } = require('./chat-external-knowledge');
const { matchLearnedKnowledge, learnFromInteraction } = require('./ai-self-learning');

function formatVnd(num) {
  return new Intl.NumberFormat('vi-VN').format(Math.round(num || 0)) + ' ₫';
}

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .trim();
}

/**
 * Tra cứu thông tin đơn hàng từ database nếu khách cung cấp mã đơn hoặc số điện thoại
 */
async function lookupOrderInfo(pool, text) {
  if (!pool || typeof pool.query !== 'function') return null;

  const orderMatch = text.match(/gae-[a-z0-9-]+/i);
  const phoneMatch = text.match(/\b0\d{9}\b/);

  if (!orderMatch && !phoneMatch) return null;

  try {
    let row = null;
    if (orderMatch) {
      row = (await pool.query(
        `SELECT order_number, customer_name, phone, address, city, status, payment_method, payment_status, total_vnd, created_at 
         FROM orders 
         WHERE lower(order_number) = lower($1) 
         LIMIT 1`,
        [orderMatch[0].trim()]
      )).rows[0];
    } else if (phoneMatch) {
      row = (await pool.query(
        `SELECT order_number, customer_name, phone, address, city, status, payment_method, payment_status, total_vnd, created_at 
         FROM orders 
         WHERE phone = $1 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [phoneMatch[0].trim()]
      )).rows[0];
    }

    if (!row) return { searched: true, found: false, query: orderMatch ? orderMatch[0] : phoneMatch[0] };

    // Tra cứu thông tin vận chuyển
    let shipment = null;
    try {
      shipment = (await pool.query(
        `SELECT carrier_name, tracking_number, status, synced_at 
         FROM shipping_fulfillments 
         WHERE order_number = $1 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [row.order_number]
      )).rows[0];
    } catch (_) {}

    return {
      searched: true,
      found: true,
      order: row,
      shipment
    };
  } catch (err) {
    return null;
  }
}

/**
 * Phân tích và sinh câu trả lời thông minh từ GAERU AI
 */
async function generateGaeruAiResponse({ pool, thread, question, catalog = [], history = [] }) {
  const norm = normalize(question);
  const raw = String(question || '').trim();

  // 1. Kiểm tra yêu cầu gặp người thật / nhân viên
  const isHumanReq = /(?:gap|chuyen|ket noi|noi chuyen|lien he|goi).{0,35}(?:nhan vien|nguoi that|tu van vien)|(?:human|live agent)|khong muon.{0,12}(?:ai|bot)/i.test(norm) &&
                    !/khong (?:can|muon) (?:gap |noi chuyen voi )?nhan vien/i.test(norm);

  if (isHumanReq) {
    return {
      handoff: true,
      answer: 'Dạ GAERU AI đã tiếp nhận và đang kết nối bạn với chuyên viên tư vấn của GAERU. Bạn cũng có thể liên hệ trực tiếp qua Hotline 082 919 1080 (10:00 – 17:00 các ngày trong tuần) hoặc để lại số điện thoại để được hỗ trợ ngay nhé!'
    };
  }

  // 2. Tra cứu đơn hàng nếu có mã đơn hoặc số điện thoại
  const orderLookup = await lookupOrderInfo(pool, raw);
  if (orderLookup && orderLookup.searched) {
    if (orderLookup.found) {
      const o = orderLookup.order;
      const s = orderLookup.shipment;
      const statusMap = {
        pending: 'Chờ xác nhận',
        confirmed: 'Đã xác nhận đơn hàng',
        processing: 'Đang đóng gói và chuẩn bị hàng',
        shipped: 'Đang vận chuyển giao cho khách',
        completed: 'Giao hàng thành công',
        cancelled: 'Đã hủy đơn hàng'
      };
      const payMap = {
        cod: 'Thanh toán khi nhận hàng (COD)',
        vietqr: 'Chuyển khoản VietQR',
        vnpay: 'Cổng VNPAY',
        momo: 'Ví MoMo',
        zalopay: 'Ví ZaloPay'
      };

      let answer = `Chào bạn! GAERU AI đã tra cứu thông tin đơn hàng **${o.order_number}** của bạn:\n\n` +
                   `- **Khách hàng:** ${o.customer_name}\n` +
                   `- **Trạng thái đơn hàng:** ${statusMap[o.status] || o.status}\n` +
                   `- **Hình thức thanh toán:** ${payMap[o.payment_method] || o.payment_method} (${o.payment_status === 'paid' ? 'Đã thanh toán' : 'Chờ thanh toán'})\n` +
                   `- **Tổng giá trị:** **${formatVnd(o.total_vnd)}**\n` +
                   `- **Địa chỉ giao hàng:** ${o.address}, ${o.city}\n`;

      if (s && s.tracking_number) {
        answer += `- **Vận chuyển:** ${s.carrier_name || 'Viettel Post'} · Mã vận đơn: \`${s.tracking_number}\` (Trạng thái: ${s.status || 'Đang giao'})\n`;
      } else {
        answer += `- **Vận chuyển:** Đơn hàng đang được chuẩn bị để giao cho đơn vị vận chuyển Viettel Post.\n`;
      }

      answer += `\nNếu bạn cần thay đổi địa chỉ hoặc hỗ trợ gấp về đơn hàng, bạn có thể nhắn ngay tại đây hoặc gọi hotline **082 919 1080** nhé!`;
      return { handoff: false, answer };
    } else {
      return {
        handoff: false,
        answer: `Dạ GAERU AI chưa tìm thấy đơn hàng với thông tin "${orderLookup.query}". Bạn vui lòng kiểm tra lại chính xác mã đơn hàng (dạng GAE-xxxxxx) hoặc số điện thoại dùng khi đặt hàng để mình tra cứu ngay giúp bạn nhé!`
      };
    }
  }

  // 3. Tra cứu tri thức tự học tích lũy từ các cuộc hội thoại trước (Autonomous Continuous Learning)
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

  // 4. Tư vấn tương thích thiết bị & Hướng dẫn kỹ thuật
  const isIphone = norm.includes('iphone') || norm.includes('ios') || norm.includes('apple') || norm.includes('lightning') || norm.includes('ipad');
  const isAndroid = norm.includes('android') || norm.includes('samsung') || norm.includes('oppo') || norm.includes('xiaomi') || norm.includes('vivo') || norm.includes('realme') || norm.includes('redmi') || norm.includes('otg');
  const isPc = norm.includes('may tinh') || norm.includes('laptop') || norm.includes('pc') || norm.includes('macbook') || norm.includes('windows');
  const isApp = norm.includes('tiktok') || norm.includes('capcut') || norm.includes('livestream') || norm.includes('quay video') || norm.includes('zoom') || norm.includes('facebook');
  const isNoise = norm.includes('loc am') || norm.includes('chong on') || norm.includes('tieng on') || norm.includes('anc') || norm.includes('tap am');

  if (isIphone && (norm.includes('tuong thich') || norm.includes('dung duoc') || norm.includes('cam') || norm.includes('cong') || norm.includes('15') || norm.includes('16') || norm.includes('chan'))) {
    let ans = `Dạ các dòng micro thu âm GAERU tương thích hoàn hảo với điện thoại iPhone:\n\n` +
              `1. **Dòng iPhone 15 & iPhone 16 series:** Đã chuyển sang cổng Type-C chuẩn quốc tế. Bạn chỉ cần cắm trực tiếp đầu thu Type-C vào đáy máy là nhận mic và thu âm được ngay lập tức, không cần đầu chuyển.\n` +
              `2. **Dòng iPhone 14 trở về trước (14, 13, 12, 11, X, 8, 7):** Dùng chân cắm Lightning. Khi đặt mua, bạn chỉ cần chọn phân loại chân Lightning (hoặc dùng cáp OTG Lightning sang Type-C chính hãng đạt chuẩn MFi) là sử dụng mượt mà.\n` +
              `3. **iPad:** Với các dòng iPad cổng Type-C (iPad Pro, iPad Air, iPad Gen 10), cắm đầu thu Type-C máy sẽ tự nhận diện làm mic chính ngay.\n\n` +
              `Bạn đang dùng dòng iPhone nào để GAERU AI tư vấn phiên bản chân cắm chuẩn nhất cho bạn ạ?`;
    return { handoff: false, answer: ans };
  }

  if (isAndroid && (norm.includes('otg') || norm.includes('khong nhan') || norm.includes('chua sang') || norm.includes('huong dan') || norm.includes('cai dat') || norm.includes('cam'))) {
    let ans = `Dạ để sử dụng micro GAERU trên các dòng máy Android chuẩn nhất, bạn lưu ý các bước đơn giản sau nhé:\n\n` +
              `1. **Kích hoạt kết nối OTG (rất quan trọng với OPPO, Realme, Vivo, OnePlus):**\n` +
              `   - Bạn vào **Cài đặt** (Settings) trên máy -> tìm kiếm chữ **"OTG"** -> Bật mục **"Kết nối OTG"**.\n` +
              `   - Sau khi bật, cắm đầu thu vào điện thoại đèn tín hiệu sẽ sáng ngay.\n` +
              `2. **Đối với Samsung, Xiaomi, Google Pixel:** Cắm trực tiếp đầu thu Type-C máy sẽ tự động nhận micro mà không cần cài đặt thêm.\n` +
              `3. **Khi quay video:** Micro tương thích 100% với TikTok, CapCut, Facebook Live. Nếu camera mặc định của một số dòng máy cũ chưa nhận mic ngoài, bạn có thể quay trực tiếp trong app CapCut/TikTok hoặc tải app miễn phí "Open Camera" (chọn Nguồn âm thanh: Micro ngoài).\n\n` +
              `Bạn thử kiểm tra tính năng OTG trên máy của mình xem đèn trên đầu thu đã sáng xanh chưa nhé!`;
    return { handoff: false, answer: ans };
  }

  if (isPc && (norm.includes('dung duoc') || norm.includes('cam') || norm.includes('ket noi') || norm.includes('huong dan'))) {
    let ans = `Dạ micro thu âm GAERU sử dụng hoàn toàn tốt trên Máy tính, Laptop (Windows 10/11) và MacBook:\n\n` +
              `- **Kết nối:** Cắm đầu thu Type-C trực tiếp vào cổng Type-C trên laptop, hoặc dùng đầu chuyển USB-A sang Type-C nếu máy tính chỉ có cổng USB thông thường.\n` +
              `- **Thiết lập:** Máy sẽ tự nhận diện dạng Plug & Play. Bạn vào **Settings** -> **Sound** -> chọn Input/Microphone là **Wireless Microphone**.\n` +
              `- **Ứng dụng:** Hoạt động rất tốt cho họp trực tuyến (Zoom, Google Meet, MS Teams), livestream OBS Studio, ghi âm podcast và dựng phim trên CapCut PC.\n\n` +
              `Bạn cần GAERU AI hướng dẫn thêm chi tiết ở bước nào không ạ?`;
    return { handoff: false, answer: ans };
  }

  if (isNoise) {
    let ans = `Dạ các dòng micro thu âm GAERU đều được trang bị chip xử lý âm thanh **DSP (Digital Signal Processor) thế hệ mới** với khả năng lọc tiếng ồn chủ động vượt trội:\n\n` +
              `- **Khử ồn thông minh:** Tự động nhận diện và loại bỏ tạp âm môi trường (tiếng gió rít, còi xe ngoài phố, tiếng quạt gió, tiếng ồn quán cafe) mà vẫn giữ được giọng nói ấm, trong trẻo và tự nhiên.\n` +
              `- **Đặc biệt trên GAERU P01:** Có phím bấm chuyển đổi 3 cấp độ chống ồn linh hoạt ngay trên thân mic, phù hợp từ phòng yên tĩnh cho tới môi trường quay ngoại cảnh ồn ào.\n` +
              `- **Cự ly thu ổn định:** Công nghệ truyền dẫn sóng kỹ thuật số 2.4GHz với tầm hoạt động 20m - 50m không bị đứt đoạn hay trễ tiếng.\n\n` +
              `Bạn định sử dụng micro cho mục đích gì (quay ngoài trời, livestream bán hàng, hay dạy học/họp online) để mình tư vấn dòng tối ưu nhất ạ?`;
    return { handoff: false, answer: ans };
  }

  // 4. Tư vấn chính sách GAERU Xu, Bảo hành, Vận chuyển, Thanh toán
  if (norm.includes('gaeru xu') || norm.includes('tich xu') || norm.includes('diem thuong') || norm.includes('doi xu') || norm.includes('xu la gi')) {
    let ans = `Dạ **GAERU Xu** là chương trình khách hàng thân thiết chính thức của GAERU với các quyền lợi vượt trội:\n\n` +
              `- **Tích lũy:** Tích từ 1% đến 5% giá trị đơn hàng thành công tùy theo hạng thành viên (Đồng, Bạc, Vàng, Kim Cương).\n` +
              `- **Giá trị quy đổi:** 1 GAERU Xu = 1 VNĐ khi giảm trừ thanh toán đơn hàng tiếp theo.\n` +
              `- **Mức giảm tối đa:** Giảm đến **50%** tổng giá trị đơn hàng (tuân thủ nghiêm ngặt Nghị định 81/2018/NĐ-CP về xúc tiến thương mại).\n` +
              `- **Tính chất pháp lý:** Xu là điểm thưởng ghi nhận nội bộ, không phải tiền tệ và không quy đổi ra tiền mặt theo Nghị định 52/2024/NĐ-CP.\n` +
              `- **Cách dùng:** Số dư GAERU Xu sẽ tự động hiển thị trong trang thanh toán khi bạn đăng nhập tài khoản mua hàng.\n\n` +
              `Bạn có thể xem chi tiết điều khoản tại trang [Chính sách GAERU Xu](/chinh-sach/gaeru-xu) nhé!`;
    return { handoff: false, answer: ans };
  }

  if (norm.includes('bao hanh') || norm.includes('doi tra') || norm.includes('loi') || norm.includes('care+')) {
    let ans = `Dạ GAERU áp dụng chính sách bảo hành và hậu mãi chính hãng tốt nhất hiện nay:\n\n` +
              `- **Thời hạn bảo hành:** Bảo hành chính hãng **12 tháng** cho toàn bộ thân máy và dock sạc.\n` +
              `- **Chính sách 1 đổi 1:** Trong **30 ngày đầu tiên** nếu sản phẩm phát sinh lỗi kỹ thuật từ nhà sản xuất, GAERU đổi mới nguyên seal ngay lập tức.\n` +
              `- **Bảo hành điện tử:** Kích hoạt và tra cứu bảo hành 1 chạm trực tuyến qua số điện thoại mua hàng tại trang [Tra cứu bảo hành](/ho-tro).\n` +
              `- **Gói mở rộng GAERU Care+:** Hỗ trợ bảo vệ toàn diện ngay cả khi rơi vỡ hoặc vào nước, ưu tiên đổi mới nhanh chóng.\n\n` +
              `Bạn hoàn toàn an tâm khi mua sắm và sử dụng thiết bị tại GAERU ạ!`;
    return { handoff: false, answer: ans };
  }

  if (norm.includes('giao hang') || norm.includes('van chuyen') || norm.includes('ship') || norm.includes('phi ship') || norm.includes('may ngay')) {
    let ans = `Dạ về chính sách giao nhận và vận chuyển tại GAERU:\n\n` +
              `- **Phí vận chuyển:** **Miễn phí giao hàng toàn quốc (Freeship)** cho các đơn hàng từ 500.000 ₫.\n` +
              `- **Thời gian nhận hàng:** Từ **2 - 4 ngày làm việc** tùy theo tỉnh thành qua đối tác vận chuyển chuyên nghiệp Viettel Post / SPX.\n` +
              `- **Quyền đồng kiểm:** Khách hàng được quyền **mở hộp kiểm tra sản phẩm** trước khi thanh toán cho shipper (tuân thủ Nghị định 85/2021/NĐ-CP).\n\n` +
              `Bạn ở tỉnh/thành phố nào để GAERU AI ước tính chính xác thời gian giao hàng cho bạn ạ?`;
    return { handoff: false, answer: ans };
  }

  if (norm.includes('thanh toan') || norm.includes('cod') || norm.includes('vietqr') || norm.includes('vnpay') || norm.includes('momo') || norm.includes('zalopay') || norm.includes('chuyen khoan')) {
    let ans = `Dạ GAERU hỗ trợ đa dạng phương thức thanh toán an toàn, bảo mật đạt chuẩn quốc tế:\n\n` +
              `1. **Thanh toán khi nhận hàng (COD):** Nhận hàng, kiểm tra sản phẩm rồi mới thanh toán tiền mặt cho nhân viên giao hàng.\n` +
              `2. **Chuyển khoản VietQR:** Quét mã QR thanh toán qua ứng dụng ngân hàng, hệ thống tự động xác nhận giao dịch trong 3 giây.\n` +
              `3. **Cổng thanh toán trực tuyến:** Hỗ trợ thanh toán qua VNPAY, Ví MoMo và ZaloPay an toàn bảo mật PCI-DSS.\n\n` +
              `Tất cả các giao dịch đều có hóa đơn điện tử minh bạch gửi về email của Quý khách ạ!`;
    return { handoff: false, answer: ans };
  }

  // 5. Tư vấn sản phẩm cụ thể
  const currentSlug = thread?.product_id ? (catalog.find(p => p.id === thread.product_id)?.slug || '') : '';
  const isP01 = norm.includes('p01') || currentSlug === 'gaeru-p01';
  const isK9 = norm.includes('k9') || currentSlug === 'gaeru-k9';
  const isM3 = norm.includes('m3') || currentSlug === 'gaeru-m3';
  const isP185 = norm.includes('p185') || currentSlug === 'gaeru-p185';
  const isG1 = norm.includes('g1') || currentSlug === 'gaeru-g1-ultra';

  if (isP01) {
    const prod = catalog.find(p => (p.slug && p.slug.includes('p01')) || (p.name && p.name.includes('P01')));
    const priceText = prod && prod.variants?.length ? formatVnd(prod.variants[0].priceVnd) : '1.250.000 ₫';
    let ans = `Dạ **Micro thu âm không dây GAERU P01** là dòng mic cao cấp bán chạy nhất tại GAERU:\n\n` +
              `- **Tính năng nổi bật:** Khử ồn chủ động 3 cấp độ (Active Noise Cancellation - ANC), chip DSP lọc tạp âm trong trẻo.\n` +
              `- **Thời lượng pin:** 8 giờ sử dụng liên tục trên thân mic, kèm dock sạc nâng tổng thời gian lên đến 32 giờ.\n` +
              `- **Cự ly truyền dẫn:** Lên tới 50 mét ổn định với sóng 2.4GHz độ trễ siêu thấp (< 15ms).\n` +
              `- **Kết nối:** Hỗ trợ cả cổng Type-C và Lightning (cho iPhone, Android, PC).\n` +
              `- **Giá ưu đãi hiện tại:** từ **${priceText}** kèm bảo hành 12 tháng 1 đổi 1 và Freeship toàn quốc.\n\n` +
              `Bạn đang quan tâm bản 1 mic hay 2 mic để mình báo giá chi tiết nhé!`;
    return { handoff: false, answer: ans };
  }

  if (isK9) {
    const prod = catalog.find(p => (p.slug && p.slug.includes('k9')) || (p.name && p.name.includes('K9')));
    const priceText = prod && prod.variants?.length ? formatVnd(prod.variants[0].priceVnd) : '450.000 ₫';
    let ans = `Dạ **Micro thu âm GAERU K9** là lựa chọn quốc dân cực kỳ gọn nhẹ và tiết kiệm:\n\n` +
              `- **Đặc điểm:** Thiết kế nhỏ gọn, cắm là chạy ngay (Plug & Play) không cần cài đặt phần mềm.\n` +
              `- **Thu âm:** Đa hướng 360 độ, độ nhạy cao, âm thanh rõ ràng trung thực.\n` +
              `- **Phù hợp:** Quay video TikTok, làm vlog cơ bản, dạy học online, họp trực tuyến qua Zoom/Teams.\n` +
              `- **Giá bán ưu đãi:** Chỉ từ **${priceText}**.\n\n` +
              `Bạn dự định dùng cho điện thoại cổng Type-C hay iPhone chân cắm Lightning ạ?`;
    return { handoff: false, answer: ans };
  }

  if (isM3) {
    const prod = catalog.find(p => (p.slug && p.slug.includes('m3')) || (p.name && p.name.includes('M3')));
    const priceText = prod && prod.variants?.length ? formatVnd(prod.variants[0].priceVnd) : '1.850.000 ₫';
    let ans = `Dạ **Micro thu âm chuyên nghiệp GAERU M3** là dòng mic chuyên dụng cho phòng thu và podcast:\n\n` +
              `- **Chất âm:** Màng thu Condenser cao cấp, xử lý âm thanh 24-bit/48kHz chi tiết, giữ trọn vẹn dải tần giọng nói.\n` +
              `- **Tính năng:** Tích hợp nút chỉnh Gain độ nhạy, phím tắt tiếng nhanh (Mute), cổng cắm tai nghe kiểm âm trực tiếp 0 độ trễ.\n` +
              `- **Thiết kế:** Chân đế kim loại chống rung vững chắc, cổng kết nối Type-C đa năng tương thích PC/Mac/Smartphone.\n` +
              `- **Giá bán:** Từ **${priceText}**.\n\n` +
              `Bạn cần GAERU AI tư vấn thêm về cách kết nối hoặc test âm thanh của M3 không ạ?`;
    return { handoff: false, answer: ans };
  }

  if (isP185) {
    let ans = `Dạ **Gậy chống rung & Chân quay phim GAERU P185** là phụ kiện đa năng không thể thiếu khi quay video:\n\n` +
              `- **Đa năng 3 trong 1:** Gậy selfie kéo dài hợp kim nhôm, tripod 3 chân đứng vững chắc và gimbal chống rung cân bằng tay cầm.\n` +
              `- **Điều khiển:** Remote Bluetooth tháo rời chụp và quay từ xa lên đến 10 mét.\n` +
              `- **Xoay linh hoạt:** Xoay ngang - dọc 360 độ mượt mà theo góc quay sáng tạo.\n\n` +
              `Bạn muốn đặt mua sản phẩm này kèm micro để nhận ưu đãi combo không ạ?`;
    return { handoff: false, answer: ans };
  }

  if (isG1) {
    let ans = `Dạ **Thiết bị ghi hình chống rung GAERU G1 ULTRA** là dòng camera hành trình và vlog cao cấp nhất:\n\n` +
              `- **Hình ảnh:** Cảm biến lớn ghi hình 4K 60fps siêu nét, chống rung quang học kết hợp EIS 6 trục mượt mà.\n` +
              `- **Đặc tính:** Kháng nước, tản nhiệt tốt, pin quay liên tục 120 phút và kết nối app truyền file tốc độ cao.\n\n` +
              `Bạn cần thông tin về phụ kiện kèm theo hay quà tặng của G1 ULTRA không ạ?`;
    return { handoff: false, answer: ans };
  }

  // 6. Chào hỏi hoặc câu hỏi tư vấn chung
  if (norm.includes('chao') || norm.includes('hello') || norm.includes('hi') || norm.includes('alo') || norm === 'xin chao' || norm.includes('tu van') || norm.includes('can giup')) {
    let ans = `Xin chào bạn! Mình là **GAERU AI** - Trợ lý thông minh hỗ trợ trực tuyến 24/7 của GAERU.\n\n` +
              `GAERU AI có thể giúp bạn ngay các nội dung sau:\n` +
              `1. 🎙️ **Tư vấn micro & thiết bị ghi hình:** Chọn dòng máy phù hợp (GAERU P01 cao cấp, K9 nhỏ gọn, M3 phòng thu, G1 ULTRA...).\n` +
              `2. 📱 **Kiểm tra độ tương thích & Hướng dẫn kỹ thuật:** Kết nối với iPhone (Type-C / Lightning), Android (bật OTG), PC/Laptop, TikTok/CapCut.\n` +
              `3. 📦 **Tra cứu đơn hàng:** Kiểm tra tiến độ vận chuyển đơn hàng qua mã đơn \`GAE-xxxxxx\` hoặc số điện thoại.\n` +
              `4. 🎁 **Ưu đãi & Chính sách:** GAERU Xu tích lũy, bảo hành 1 đổi 1 12 tháng, miễn phí vận chuyển toàn quốc.\n\n` +
              `Bạn cần mình hỗ trợ về vấn đề gì hôm nay ạ?`;
    return { handoff: false, answer: ans };
  }

  // 7. Câu hỏi chung khác: Tóm tắt thông tin sản phẩm và chính sách
  const catalogSummary = catalog.slice(0, 4).map(p => `- **${p.name}:** ${p.variants?.[0]?.priceVnd ? formatVnd(p.variants[0].priceVnd) : 'Chính hãng'} (Bảo hành 12 tháng, 1 đổi 1)`).join('\n');
  let fallbackAns = `Dạ GAERU AI đã ghi nhận câu hỏi của bạn: *"${raw}"*.\n\n` +
                    `Hiện tại GAERU đang phân phối chính hãng các dòng thiết bị thu âm và ghi hình chuyên nghiệp:\n` +
                    `${catalogSummary}\n\n` +
                    `- **Ưu đãi hôm nay:** Miễn phí vận chuyển toàn quốc cho đơn từ 500.000 ₫, tích lũy điểm thưởng **GAERU Xu** giảm đến 50% đơn hàng.\n` +
                    `- **Hỗ trợ kỹ thuật & Kiểm tra đơn:** Bạn có thể nhắn mã đơn hàng, số điện thoại hoặc thiết bị điện thoại đang dùng để mình hỗ trợ tức thì.\n\n` +
                    `Nếu bạn cần trao đổi trực tiếp với nhân viên tư vấn, bạn hãy nhắn "gặp nhân viên" hoặc gọi Hotline **082 919 1080** nhé!`;

  return { handoff: false, answer: fallbackAns };
}

/**
 * Trình xử lý chính giải đáp chat khách hàng bằng GAERU AI (Hoàn toàn độc lập, không phụ thuộc AI bên ngoài)
 */
async function answerCustomerChat({ pool, config, thread, question, history = [], product = null }) {
  // Đảm bảo có danh sách sản phẩm thực tế từ DB
  let catalog = [];
  try {
    if (pool && typeof pool.query === 'function') {
      catalog = await require('./store-api').loadProducts(pool);
    }
  } catch (_) {}

  // Chạy Lõi Trí Tuệ Nhân Tạo Nội Bộ GAERU AI (Tốc độ cao, zero hallucination, thấu hiểu ngữ cảnh nghiệp vụ)
  const result = await generateGaeruAiResponse({
    pool,
    thread,
    question,
    catalog,
    history
  });

  // Tự động ghi nhớ và củng cố tri thức từ cuộc hội thoại nếu có giá trị thông tin
  try {
    const raw = String(question || '').trim();
    if (pool && !result.handoff && result.answer && raw && raw.length >= 6) {
      void learnFromInteraction(pool, {
        sourceType: 'customer_chat',
        question: raw,
        answer: result.answer,
        confidence: 0.85,
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
