'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { Pool } = require('pg');
require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');

const articles = [
  {
    uuid: 'c0000000-0000-4000-8000-000000000001',
    slug: 'dien-thoai-khong-nhan-micro-thu-am-cach-khac-phuc',
    title: 'Cắm micro thu âm vào điện thoại nhưng không nhận tiếng: Nguyên nhân và cách khắc phục trong 3 phút',
    badge: 'XỬ LÝ KỸ THUẬT',
    badgeColor: '#38bdf8',
    subHeader: 'Khắc phục triệt để lỗi mất âm thanh trên Android & iPhone',
    bullet1: 'Hướng dẫn bật kết nối OTG trên Oppo, Vivo, Xiaomi, Realme',
    bullet2: 'Phân biệt chuẩn Type-C âm thanh số và quyền truy cập ứng dụng',
    bullet3: 'Checklist 3 bước thử bản thu gốc trước giờ bấm máy',
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
    badgeColor: '#10b981',
    subHeader: 'Làm chủ âm thanh dã ngoại – Chặn đứng tiếng gió rít',
    bullet1: 'Bản chất vật lý của tiếng gió giật và giới hạn của thuật toán',
    bullet2: 'Cơ chế tán khí của bông lông Deadcat chuyên dụng',
    bullet3: 'Kỹ thuật cài áo ngược chiều gió và kiểm soát mức Gain',
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
    badge: 'LIVESTREAM TIẾT KIỆM',
    badgeColor: '#f59e0b',
    subHeader: 'Giải pháp phòng live tại gia – Bứt phá đơn hàng chi phí tối thiểu',
    bullet1: 'Bố trí ánh sáng 2 điểm tận dụng bóng đèn gia dụng',
    bullet2: 'Tiêu âm phòng ngủ bằng rèm vải và thảm sàn',
    bullet3: 'Combo chân chống rung P185 và micro định hướng K9',
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
    badge: 'PODCAST & PHỎNG VẤN',
    badgeColor: '#8b5cf6',
    subHeader: 'Làm chủ âm thanh đối thoại – Không lo lệch tiếng',
    bullet1: 'Xử lý tình trạng người nói to át người nói nhỏ',
    bullet2: 'Khoảng cách cài áo chuẩn mực cho từng chất giọng nam/nữ',
    bullet3: 'Kỹ thuật thu âm 2 kênh độc lập với GAERU M3',
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
    badgeColor: '#ec4899',
    subHeader: 'Sáng tạo nội dung rảnh tay – Tự động theo dõi 360 độ',
    bullet1: 'Camera AI độc lập không cần kết nối Bluetooth hay cài app',
    bullet2: 'Điều khiển bằng cử chỉ bàn tay: Xòe tay dừng, OK tiếp tục',
    bullet3: 'Bố trí góc máy nấu ăn, làm bánh mượt mà không bị khuất',
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
    badgeColor: '#0ea5e9',
    subHeader: 'Xây dựng lòng tin tuyệt đối – Tối ưu tỷ lệ chốt đơn',
    bullet1: '3 giây đầu tiên: Đánh thức giác quan bằng âm thanh tệ hại',
    bullet2: '15 giây đối chiếu A/B Test chân thực không hiệu ứng',
    bullet3: 'Nói thẳng nhược điểm và giới hạn để tạo sự tin tưởng',
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
    badge: 'SO SÁNH CHỌN MUA',
    badgeColor: '#6366f1',
    subHeader: 'Đặt lên bàn cân 2 dòng mic bán chạy nhất GAERU',
    bullet1: 'Đối chiếu thời lượng pin, dải tần 24-bit và hộp sạc LED',
    bullet2: 'Ai chỉ cần GAERU K9 là đủ (tiết kiệm, nhu cầu cơ bản)',
    bullet3: 'Ai bắt buộc nên nâng cấp GAERU M3 (dã ngoại, livestream bền bỉ)',
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
    badge: 'PHỤ KIỆN GHI HÌNH',
    badgeColor: '#14b8a6',
    subHeader: 'Tối ưu công năng góc quay – Tránh nhầm lẫn khi đặt hàng',
    bullet1: 'GAERU P01: Trọng tâm là "Cử động & Tự động xoay theo người"',
    bullet2: 'GAERU P185: Trọng tâm là "Chiều cao & Cơ động chụp dã ngoại"',
    bullet3: 'Mẹo ghép nối tạo thành hệ thống camera bám đuổi di động',
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
    badge: 'BẢO QUẢN THIẾT BỊ',
    badgeColor: '#eab308',
    subHeader: 'Kéo dài tuổi thọ pin lithium – Giữ thiết bị luôn như mới',
    bullet1: 'Cảnh báo nguy cơ sốc nguồn khi dùng củ sạc siêu nhanh 65W/100W',
    bullet2: 'Vệ sinh định kỳ chân tiếp xúc pogo pin bằng tăm bông khô',
    bullet3: 'Bảo quản pin ở mức 50% - 70% khi không sử dụng thời gian dài',
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
    badgeColor: '#22c55e',
    subHeader: 'Quyền lợi minh bạch – Không cần giữ hóa đơn giấy',
    bullet1: 'Hệ thống bảo hành điện tử tra cứu theo số điện thoại',
    bullet2: 'Cam kết 1 đổi 1 nguyên thân máy mới khi có lỗi kỹ thuật',
    bullet3: 'Hỗ trợ chi phí vận chuyển 2 chiều tiện lợi tận nhà',
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

// Helper to generate sleek dark studio SVG banner
function generateBannerSvg(art) {
  const safeTitle = art.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeSub = art.subHeader.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeB1 = art.bullet1.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeB2 = art.bullet2.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeB3 = art.bullet3.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeBadge = art.badge.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Split title into 2 lines if long
  let tLine1 = safeTitle, tLine2 = '';
  if (safeTitle.length > 42) {
    const words = safeTitle.split(' ');
    const mid = Math.ceil(words.length / 2);
    tLine1 = words.slice(0, mid).join(' ');
    tLine2 = words.slice(mid).join(' ');
  }

  return `
  <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg-${art.uuid}" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0b1120" />
        <stop offset="50%" stop-color="#1e293b" />
        <stop offset="100%" stop-color="#0f172a" />
      </linearGradient>
      <linearGradient id="accent-${art.uuid}" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="${art.badgeColor}" />
        <stop offset="100%" stop-color="#38bdf8" />
      </linearGradient>
      <filter id="glow-${art.uuid}" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="60" result="blur" />
      </filter>
    </defs>

    <!-- Background -->
    <rect width="1200" height="630" fill="url(#bg-${art.uuid})" />

    <!-- Ambient light glow circles -->
    <circle cx="1060" cy="160" r="260" fill="${art.badgeColor}" opacity="0.08" filter="url(#glow-${art.uuid})" />
    <circle cx="140" cy="520" r="220" fill="#38bdf8" opacity="0.06" filter="url(#glow-${art.uuid})" />

    <!-- Subtle Tech Grid Lines -->
    <line x1="80" y1="0" x2="80" y2="630" stroke="#1e293b" stroke-width="0.8" opacity="0.4" />
    <line x1="1120" y1="0" x2="1120" y2="630" stroke="#1e293b" stroke-width="0.8" opacity="0.4" />

    <!-- Category Pill Badge -->
    <rect x="80" y="65" width="220" height="38" rx="19" fill="#1e293b" stroke="${art.badgeColor}" stroke-width="1.5" />
    <text x="190" y="89" fill="${art.badgeColor}" font-family="system-ui, -apple-system, sans-serif" font-size="14" font-weight="700" text-anchor="middle" letter-spacing="1.5">${safeBadge}</text>

    <!-- Title Lines -->
    <text x="80" y="165" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-size="36" font-weight="800">${tLine1}</text>
    ${tLine2 ? `<text x="80" y="220" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-size="36" font-weight="800">${tLine2}</text>` : ''}

    <!-- Highlight Subtitle -->
    <text x="80" y="${tLine2 ? 285 : 240}" fill="url(#accent-${art.uuid})" font-family="system-ui, -apple-system, sans-serif" font-size="26" font-weight="700">${safeSub}</text>

    <!-- Key Takeaway Bullets -->
    <text x="80" y="${tLine2 ? 365 : 330}" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="400">•  ${safeB1}</text>
    <text x="80" y="${tLine2 ? 410 : 375}" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="400">•  ${safeB2}</text>
    <text x="80" y="${tLine2 ? 455 : 420}" fill="#94a3b8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="400">•  ${safeB3}</text>

    <!-- Bottom Brand Divider & Metadata -->
    <line x1="80" y1="520" x2="1120" y2="520" stroke="#334155" stroke-width="1.2" />
    <text x="80" y="565" fill="#f8fafc" font-family="system-ui, -apple-system, sans-serif" font-size="24" font-weight="900" letter-spacing="3">GAERU</text>
    <text x="210" y="564" fill="#64748b" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="500">|   Thiết bị âm thanh &amp; sáng tạo di động</text>
    <text x="1120" y="564" fill="${art.badgeColor}" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="600" text-anchor="end">gaeru.com/tin-tuc</text>
  </svg>
  `;
}

async function main() {
  console.log(`[publish-10-articles] Preparing ${articles.length} new articles & generating high-res banners...`);

  const newsDir = path.join(ROOT, 'assets', 'news');
  if (!fs.existsSync(newsDir)) fs.mkdirSync(newsDir, { recursive: true });

  const generatedImages = [];
  const sqlInsertsImages = [];
  const sqlInsertsPosts = [];

  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    const svg = generateBannerSvg(art);
    const webpBuf = await sharp(Buffer.from(svg))
      .webp({ quality: 90, effort: 6 })
      .toBuffer();
    const avifBuf = await sharp(Buffer.from(svg))
      .avif({ quality: 86, effort: 8, chromaSubsampling: '4:4:4', tune: 'ssim' })
      .toBuffer();

    // Filenames for assets/news
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

    // Stagger publication times slightly (e.g. 1 minute apart)
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

  // 3. If local or database is reachable, apply migration directly
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

  console.log('[publish-10-articles] Done! Generated 10 articles, 20 image renditions (WebP+AVIF), SQL and JSON files.');
}

main().catch(err => {
  console.error('[publish-10-articles] Fatal error:', err);
  process.exitCode = 1;
});
