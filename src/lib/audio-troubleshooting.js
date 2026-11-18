'use strict';

/**
 * Ma trận kiến thức xử lý sự cố âm thanh, phụ kiện chia cổng OTG PD
 * và kết nối máy ảnh / Action Cam (TRS 3.5mm) cho GAERU AI.
 */

const { hasAnyBoundaryTerm, normalizeSearchSpace, expandQueryVi } = require('./ai-nlu');

function buildAudioSymptomAnswer(space, rawQuestion, matchedProdKey = null) {
  const q = space || normalizeSearchSpace(expandQueryVi(rawQuestion));
  const sections = [];

  // 1. Tiếng bị vang / nhái / hiệu ứng reverb
  if (hasAnyBoundaryTerm(q, ['tieng vang', 'bi vang', 'bi nhai', 'reverb', 'tieng vong', 'echo', 'giong ao'])) {
    const prodHint = matchedProdKey === 'gaeru-g1-ultra'
      ? 'Trên **GAERU G1 ULTRA**, kiểm tra nút chuyển chế độ trên micro/đầu thu và tắt **chế độ tiếng vang (Reverb)** nếu đèn reverb đang bật.'
      : 'Kiểm tra chế độ âm thanh trên mic/app: giữ ở mức thu bình thường và tránh bật nhầm hiệu ứng tiếng vang trong app live/karaoke.';
    sections.push(
      '**Cách khắc phục giọng thu bị vang / reverb lạ:**\n' +
      `- ${prodHint}\n` +
      '- **Trên iPhone (iOS):** Vuốt mở **Trung tâm điều khiển → Micrô**, kiểm tra đang để **Tiêu chuẩn (Standard)** (nếu bật *Tách lời nói* chồng lên bộ lọc của mic rất dễ bị méo/vang giọng).\n' +
      '- **Khi quay trong phòng kín ít đồ đạc:** Kẹp mic gần miệng hơn (**10–15 cm**) và giảm âm lượng loa ngoài/TV xung quanh để tránh vọng âm.'
    );
  }

  // 2. Bộ 2 mic chỉ thu tiếng 1 mic / 1 mic không lên
  if (hasAnyBoundaryTerm(q, ['1 mic khong len', 'chi co 1 mic', 'chi thu 1 mic', '1 ben khong', 'mot mic', '1 mic bi mat', 'mic thu 2', 'hai mic chi nghe mot', 'ghep doi lai', 'ket noi 2 mic'])) {
    sections.push(
      '**Khắc phục bộ 2 mic chỉ lên tiếng 1 mic (hoặc cần ghép nối 2 TX):**\n' +
      '- **Kiểm tra pin & công tắc từng bộ phát (TX):** Đảm bảo cả 2 micro TX đều đã bật nguồn và sạc đủ pin (trên **M3 / G1 ULTRA** lau khô chân tiếp xúc đồng trước khi đặt lại hộp sạc).\n' +
      '- **Kiểm tra đèn chỉ báo:** Chỉ mic nào có **đèn kết nối sáng đứng (không nhấp nháy)** mới truyền tiếng về 1 đầu thu RX duy nhất.\n' +
      '- **Thử từng mic riêng:** Tắt tạm TX1, chỉ bật TX2 ghi thử 5 giây trong app Camera/Ghi âm để xác định đúng bên đang ngắt kết nối hoặc hết pin.'
    );
  }

  // 3. Tiếng bị nhỏ, rè, vỡ âm (clipping), cọ áo hoặc ù gió
  if (hasAnyBoundaryTerm(q, ['bi re', 'tieng re', 'vo tieng', 'vo am', 'tieng nho', 'nho tieng', 'co ao', 'u gio', 'gio giat', 'tieng gio', 'deadcat'])) {
    sections.push(
      '**Mẹo kẹp mic & xử lý tiếng rè / nhỏ / gió giật:**\n' +
      '- **Vị trí gắn chuẩn:** Kẹp mic ở cổ áo cách miệng khoảng **10–15 cm**, hướng đầu lưới thu lên phía cằm và không để vải áo/trang sức cọ vào thân mic (không bọc mic trong tay).\n' +
      '- **Quay ngoài trời / trước quạt:** Gắn kèm **bông lọc gió (Deadcat)** vào đầu micro để triệt tiếng gió tạt vật lý kết hợp chế độ giảm ồn DSP / AI.\n' +
      '- **Nếu bị vỡ tiếng (clipping):** Khi nói giọng lớn hoặc hát livestream, giữ mic cách miệng **15–20 cm** hoặc giảm nhẹ gain đầu vào trên phần mềm (OBS / CapCut / TikTok Live Studio).'
    );
  }

  // 4. Trạng thái đèn RX/TX & lỗi hộp sạc / lệch % pin
  if (hasAnyBoundaryTerm(q, ['den nhap nhay', 'nhap nhay cham', 'den do', 'den xanh', 'lech pin', 'khong sac', 'chan tiep xuc', 'hop sac khong sac', 'sac khong vao'])) {
    sections.push(
      '**Kiểm tra trạng thái đèn & chân sạc micro GAERU:**\n' +
      '- **Đèn nháy chậm:** Micro TX chưa ghép được với đầu thu RX (hãy cắm sát RX vào máy — nhớ tháo ốp dày và bật OTG nếu là OPPO/Realme/Vivo).\n' +
      '- **Hộp sạc báo lệch % pin / không vào sạc (M3 / G1 ULTRA):** Dùng tăm bông khô lau sạch bụi/mồ hôi trên **điểm tiếp xúc đồng** dưới đáy mic và trong khay hộp sạc, đặt khít mic vào rãnh rồi cắm sạc hộp bằng củ **5V/1A – 5V/2A** (tránh sạc siêu nhanh công suất quá cao hoặc vừa ẩm vừa cất vào hộp).'
    );
  }

  // 5. Phụ kiện cáp chia OTG + Sạc vừa sạc vừa livestream
  if (hasAnyBoundaryTerm(q, ['vua sac vua dung', 'vua sac vua live', 'vua sac vua quay', 'cong chia', 'cap chia', 'hub chia', 'splitter', 'pin du phong'])) {
    sections.push(
      '**Lưu ý khi dùng bộ chia để vừa sạc vừa livestream bằng micro:**\n' +
      '- Rất nhiều cáp chia 2-trong-1 giá rẻ chỉ nối dây nguồn nên **cắm mic sẽ không sáng đèn / không nhận tiếng**.\n' +
      '- Nếu cần vừa sạc vừa cắm đầu thu RX: phải chọn **Hub / Bộ chuyển hỗ trợ cả USB Data (OTG) + Sạc PD** (trên đầu thu GAERU M3 / K9 nếu có cổng sạc phụ trên RX thì cắm dây sạc 5V qua cổng đó tiện và ổn định hơn qua hub rời).'
    );
  }

  // 6. Nghe lại video trên iPhone/Android khi vẫn đang cắm RX
  if (hasAnyBoundaryTerm(q, ['nghe lai video', 'phat lai video', 'nghe loa ngoai', 'khong nghe thay loa', 'cam vao bi mat loa'])) {
    sections.push(
      '**Lưu ý phát lại video (nghe loa ngoài):** Khi đầu thu RX đang cắm ở cổng sạc, điện thoại thường hiểu là thiết bị âm thanh ngoài đang gắn nên **tạm ngắt loa ngoài**. Bạn chỉ cần **rút đầu thu RX ra** là nghe lại bình thường qua loa máy ngay.'
    );
  }

  // 7. Kết nối chi tiết Máy ảnh & Action Cam (TRS vs TRRS, GoPro, DJI, Sony, Canon, Fujifilm)
  if (hasAnyBoundaryTerm(q, ['gopro', 'media mod', 'dji osmo', 'osmo pocket', 'osmo action', 'action cam', 'zv e10', 'zv-e10', 'zv1', 'zv-1', 'trs', 'trrs', 'canon', 'fujifilm', 'nikon', 'may anh'])) {
    const g1Text = '**GAERU G1 ULTRA** hỗ trợ kết nối **máy ảnh (Sony Alpha/ZV-E10, Canon, Fujifilm, Nikon)** qua **cáp 3.5mm TRS** (giắc 2 khấc đen dành riêng cho ngõ MIC màu đỏ trên máy ảnh; tránh nhầm với cáp TRRS 3 khấc đen). Với **GoPro** cần có *Media Mod* hoặc *Pro 3.5mm Mic Adapter*; với **DJI Osmo Action/Pocket** cắm được bản **Type-C** qua cổng USB-C của máy nếu không dùng ngõ 3.5mm.';
    const k9M3Note = matchedProdKey === 'gaeru-k9' || matchedProdKey === 'gaeru-m3'
      ? ` Lưu ý **${matchedProdKey === 'gaeru-m3' ? 'GAERU M3' : 'GAERU K9'}** là mic chuẩn kỹ thuật số **USB Type-C / Lightning**, **không** cắm được vào lỗ 3.5mm TRS của máy ảnh (chỉ cắm được các máy có nhận USB Audio Type-C như *DJI Osmo Action 4/5 / Pocket 3* nếu thiết bị hỗ trợ UAC Type-C).`
      : '';
    if (!sections.some(s => s.includes('G1 ULTRA'))) {
      sections.push(`- ${g1Text}${k9M3Note}`);
    }
  }

  return sections.join('\n\n');
}

module.exports = {
  buildAudioSymptomAnswer
};
