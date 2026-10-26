# Rà soát yêu cầu GAERU — 26/10/2026

Kết luận: **chưa hoàn tất toàn bộ yêu cầu**. Báo cáo phân biệt mã đã có, kết quả công khai đo được và tác vụ cần tài khoản/dịch vụ thật. Không dùng việc có nút hoặc có mã làm bằng chứng kết nối thành công.

## Đã đối chiếu trên website công khai

- gaeru.com là miền chính; gaeru.org chuyển hướng 301 sang gaeru.com với trang sản phẩm đã kiểm tra. API và trang quản trị miền phụ được giữ để tương thích phiên đăng nhập/callback.
- 51 URL sitemap trả 200; canonical dùng miền chính và URL sạch; đủ lastmod. robots.txt khai báo sitemap. Chuyển hướng URL HTML cũ đã kiểm tra.
- HTML có lang=vi, Open Graph, Twitter Card, Organization, BreadcrumbList. Các trang sản phẩm có Product; bài viết có NewsArticle; FAQPage được kiểm tra ở phần FAQ K9 có nội dung hiển thị.
- Nội dung sản phẩm, giá, bài viết và liên kết cốt lõi có trong HTML trả về; không cần đợi JavaScript để crawler đọc. Không suy ra Google đã index/xếp hạng tốt từ kết quả này.
- Có 4 sản phẩm: M3 (4 phiên bản), K9 (10), P01 (2), G1 ULTRA (1). Giá/tồn kho hiện tại giữ theo dữ liệu quản trị, không ghi đè bằng tồn kho 0 từng dùng lúc nhập mới.
- Đủ 25 bài công khai: 10 bài GAERU ban đầu, 5 bài công nghệ, 10 bài affiliate TikTok Shop/Shopee. Kiểm tra đầy đủ phân trang, không chỉ 12 bài ở trang đầu.
- Ảnh chính bốn sản phẩm trả image/webp. Ảnh G1 dùng ở khối trang chủ có file tĩnh định danh nội dung, cache immutable một năm. Đường dẫn ảnh API vẫn hợp lệ cho danh mục và không đồng nghĩa mất khả năng cache.
- Không còn nút “Gọi tư vấn 082 919 1080” trong đầu trang sản phẩm/cửa hàng và mã render mới. Thông tin hỗ trợ gốc vẫn tồn tại.
- Danh sách hãng vận chuyển công khai đang rỗng: **hiện chưa có hãng đủ điều kiện được bật cho người mua chọn**. Không suy đoán tài khoản đã kết nối chỉ vì người dùng có tài khoản.

## Đã có mã và kiểm thử, còn giới hạn xác minh vận hành

| Nhóm yêu cầu | Kết quả và giới hạn |
| --- | --- |
| Thêm/xóa sản phẩm, xóa trong tồn kho, khu vực đã xóa | Có chuyển vào thùng rác, sửa, khôi phục nháp, khôi phục và kích hoạt. Xóa vĩnh viễn chỉ khi không có tồn kho hoặc lịch sử liên quan; không xóa mất lịch sử đơn/kho. |
| WebP hợp nhất khi tải lên | Có bộ mã hóa Sharp dùng chung cho ảnh sản phẩm, mô tả, tin tức, banner, chat; giữ tỉ lệ/alpha, giới hạn tài nguyên. Chưa phải công cụ AI tách nền tự động. |
| Neon lưu media, dữ liệu quan trọng giữ DB gốc | Có luồng lưu đối tượng và tham chiếu có kiểm tra hash; production không âm thầm quay về lưu byte mới trong DB khi storage lỗi. Chưa kiểm kê độc lập toàn bộ object cũ/bản sao lưu để kết luận mọi byte cũ đã chuyển. Header bộ đọc storage không tự chứng minh tất cả dữ liệu đã di trú. |
| Mô tả sản phẩm thành khối chữ/ảnh | Có canvas cuộn, kéo đổi thứ tự, phím tắt, chú thích, chữ xen ảnh, kiểm tra phiên bản. Không phải bản dịch đa ngôn ngữ riêng (người dùng đã chọn chữ xen ảnh). |
| Cache/tốc độ | Có nén, cache ảnh, URL phiên bản, high priority hero, kích thước ảnh, preload none cho audio/video. Chưa đo LCP/CLS/INP trên điện thoại thật; không cam kết tốc độ chỉ từ kiểm thử mã. |
| Chat media/preview/Enter/cuộn | Có ảnh/video inline, preview trước gửi, Enter gửi, Shift+Enter xuống dòng, xử lý vùng cuộn. Tệp/codec không hỗ trợ vẫn có tải xuống. Chưa xác nhận lại thao tác thật trên điện thoại hiện tại. |
| Chat AI | Có OpenAI/Gemini/Claude, khóa mã hóa, lưu/kiểm tra tách biệt, chẩn đoán model/quyền/quota. Chưa có bằng chứng khóa/model thực của người dùng đã gọi thành công; không cần gửi khóa vào chat. |
| Chuyển nhân viên và hotline 5 phút | Có luồng chờ, AI dừng, nhắc hotline nếu chưa có nhân viên phản hồi; nội dung theo provider đang chọn. Kiểm thử mô phỏng không phải phiên hỗ trợ khách thật. |
| Mua ngay/giỏ hàng/checkout/voucher | Có mua SKU trực tiếp, giữ giỏ hiện có, địa chỉ lưu, đơn hàng trước thanh toán, chọn voucher trong ví, tự kiểm tra mã, bỏ dòng Chọn phương thức, giảm khoảng cách. |
| Tạo tài khoản khi mua/email đặt mật khẩu/email đơn | Có tạo tài khoản phù hợp, hàng đợi email, token đặt mật khẩu và email quản trị. Chưa xác minh hộp thư người mua/quản trị thật nhận thư hoặc cấu hình SMTP hiện tại. |
| Chống đơn ảo/đơn rác | Có giới hạn, kiểm tra miền email, phân loại email thất bại/chưa rõ/chậm, quy trình gọi xác nhận thủ công. SMTP nhận thư không chứng minh hộp thư thật tồn tại; không có hệ thống tự gọi điện. |
| Quản trị đơn hàng | Có tab trạng thái, tìm/lọc/phân trang, xử lý popup, bước tiếp theo, xử lý hàng loạt, cập nhật nền mỗi 15 giây, xuất XLSX thật và CSV. Không tự hủy hàng loạt theo đồng hồ của sàn. |
| Hủy/hoàn trả sau hoàn tất | Có tạo và xử lý hồ sơ hoàn trả riêng, kể cả đơn hoàn tất. Hoàn tiền và nhập kho cần đối soát/chứng từ; đóng hồ sơ không tự chuyển tiền. |
| In đơn/tem hàng loạt | Có phiếu A4 và tem giao hàng nội bộ 100×150. **Chưa phải tem vận đơn chính thức lấy từ hãng**, chưa có mã vạch/mã vận đơn được hãng cấp. |
| Quản lý vận chuyển/xác minh | Có cấu hình và kiểm tra GHN/GHTK/Viettel, bằng chứng phiên bản, cho phép bật hãng đã xác minh. J&T mới có khu vực cấu hình; chưa hoàn tất tích hợp theo hợp đồng đối tác. |
| Bảo hành/email kích hoạt | Có tự động cho đơn hoàn tất và thanh toán đủ, hồ sơ ngoài cần đối chiếu, hàng đợi email kích hoạt; chưa kiểm tra thư thật trên production. |
| Menu/tài khoản/CARE+/chọn địa chỉ | Có liên kết tài khoản, Chat ngay, nhãn Care+, tỉnh→xã cùng panel, dữ liệu hành chính 34 tỉnh/thành, bảo toàn địa chỉ cũ. Không tự đoán xã/phường từ tên tỉnh cũ đã sáp nhập. |
| Footer sản phẩm/sitemap tự cập nhật | Footer dựa danh mục công khai, bốn dòng đầu và Xem thêm; sitemap theo dữ liệu công khai. Xóa/ẩn sản phẩm được lọc theo trạng thái. |
| Quản lý trang | Có nháp/xuất bản/lưu trữ trang nội dung và SEO trang cố định. Chưa phải bộ kéo thả thay mọi cấu trúc chức năng checkout/admin. |
| Popup tồn kho/tác vụ và nút bo tròn | Có editor dialog dùng chung cho kho/điều chuyển/nhà cung cấp/nhân sự/mua hàng/tài chính; kiểm thử mở, lưu, lỗi và bảo toàn dữ liệu. |
| Dependency cũ | Đã thay thư viện Excel kéo theo inflight/rimraf2/lodash.isequal/fstream/glob7. Bộ khóa hiện tại không còn nhóm đó; kết quả audit/outdated của đợt nâng cấp đã lưu riêng. Không coi mọi cảnh báo bảo trì tương lai đã biến mất vĩnh viễn. |

## Sửa bổ sung trong đợt rà soát này

1. Nhãn “Ghi chú (không bắt buộc)” nằm trong một khối nhãn; ô nhập không bị thêm một dòng nhãn độc lập đẩy lệch so với tỉnh/xã.
2. Gộp địa chỉ: một ô địa chỉ nhận hàng ở trên tỉnh/xã; trường tên địa chỉ cũ được giữ ẩn để không mất dữ liệu tương thích. Không bỏ số nhà/đường.
3. Dải bài viết tự chuyển sau 6 giây; thao tác tay tạm dừng 8 giây rồi chạy lại. Tôn trọng giảm chuyển động, tab nền, popup và focus vào nội dung.
4. Bỏ nút tạm dừng ảnh K9 trên các vị trí dùng chung; vẫn tự đổi một/hai mic, dừng khi ngoài màn hình/tab nền hoặc giảm chuyển động.

Các mục này cần đối chiếu thêm với phiên bản phát hành cuối đợt; xem release-evidence.json. Bộ kiểm thử sau sửa: 331/331 đạt. Không tạo đơn, thu tiền, gửi email, chỉnh tồn kho hay tạo vận đơn thật để kiểm tra.

## Còn thiếu, chưa thể gọi là hoàn tất

1. **Banner trang chủ quản lý trong admin, chỉ hiện sau lưu/bật**: chưa có module cài đặt và vị trí công khai đúng yêu cầu. Banner chiến dịch thông báo tài khoản không thay thế tính năng này.
2. **Khôi phục đơn đã hủy**: hiện chuyển trạng thái cancelled vẫn bị khóa; chưa có thao tác giữ lại tồn kho an toàn và kiểm tra đối soát tiền khi khôi phục. Không nên mở khóa bằng một nút đổi trạng thái đơn thuần.
3. **Ảnh mới Shopee K9**: đã có ảnh nguồn chuẩn bị bên ngoài repository, nhưng danh mục công khai K9 vẫn chỉ có 1 ảnh gallery; chưa bổ sung vào Neon/danh mục.
4. **Tích hợp vận chuyển đầy đủ như mẫu**: chưa tạo/hủy vận đơn tự động, nhận trạng thái hãng/webhook, lấy tem hãng, tính giá trực tiếp theo dịch vụ; J&T chưa tích hợp hoàn chỉnh. Hiện chưa có hãng công khai được bật.
5. **Tách nền thông minh cho mọi ảnh mới**: WebP không đồng nghĩa xóa nền. Chưa có bộ tách nền tự động cho mọi ảnh đăng mới.
6. **Thay toàn hệ thống bằng ảnh G1 đính kèm**: khối trang chủ/hướng dẫn có asset mới, nhưng main image của catalog G1 vẫn là /api/catalog-images/c505fa34-697e-4c8b-90aa-6060e0f4a308; chưa xác nhận đã thay tất cả ảnh cũ, bỏ hết chữ/khung theo từng yêu cầu.
7. **Kiểm tra bố cục thực tế mọi trang/điện thoại**: chưa đủ bằng chứng sau cuộn ở mọi viewport; quyền kiểm tra trình duyệt trước đó đang tắt và người dùng đã chọn kiểm thử/bản xem trước. CSS và DOM tests không thay thế kiểm tra hình ảnh thực tế.
8. **Xác thực vận hành ngoài hệ thống**: AI thật, email đến hộp thư, API hãng, kiểm kê toàn Neon, Core Web Vitals và index Google chưa được xác nhận. Cần cấu hình/quyền và kết quả kiểm tra tương ứng; không suy đoán thành công.
9. **Nội dung nguyên bản/ảnh mới cho từng bài**: đã có 25 bài và ảnh bìa công khai, nhưng chưa đánh giá trực quan từng ảnh hoặc xác nhận toàn bộ âm thanh/video được tự sản xuất mới. Nguồn tham khảo cũ không phải bằng chứng nội dung độc quyền.

## Bằng chứng

- public-evidence.json: danh mục, số bài đủ phân trang, hãng đang công khai, WebP, chuyển hướng miền phụ.
- ../gaeru-clean-seo/live-audit.json: 51 URL, schema/canonical/lang/robots/redirect/cache G1, admin API trả 401 khi chưa đăng nhập.
- Mã và test trong repository: src/seo-pages.js, src/clean-routes.js, src/site-pages.js, src/shipping-choice.js, src/order-print.js, src/order-review.js, src/order-after-sales.js, src/lib/stored-media.js, src/lib/image-optimizer.js; test/*.
- Kiểm tra quản trị trong báo cáo chủ yếu là mã + fixture PostgreSQL tương thích, không phải đăng nhập và thao tác vào dữ liệu thật.
