# Hoàn thiện sau rà soát 03/11/2026

## Các thay đổi

- GET kiểm tra phiên/cấu hình tài khoản không còn bị tính vào chống dò mật khẩu. Các lần xác thực thất bại vẫn bị giới hạn; đăng nhập thành công được giải phóng khỏi bộ đếm.
- Cache lưu HTML cuối cùng sau chuẩn hóa: canonical, Open Graph, Twitter và schema giống nhau giữa phản hồi lạnh, identity, gzip và Brotli. Trang tài khoản/giỏ/checkout/kết quả thanh toán không lọt cache sau rewrite sang `.html`. ETag dựa trên cùng nội dung và phản hồi khai báo Vary.
- Editor sản phẩm tự xuống dòng nhóm chọn chế độ trên màn nhỏ; header quản trị và checkbox checkout được sửa. Sitemap có ngày sửa từ lịch sử của trang tra cứu.
- Chính sách GAERU Xu có ngưỡng/tỷ lệ cho 4 hạng, chỉnh trong Khách hàng với quyền settings.write và kiểm phiên bản. Tích Xu dùng hạng trước đơn hàng, giữ nguyên lịch sử đã ghi. Có popup điều chỉnh kèm lý do/chống gửi lặp và sổ Xu phân trang.
- Popup Lazada hoạt động. Ba sàn hỗ trợ lưu token mã hóa, hạn token, xác minh quyền đọc, mapping SKU theo đúng gian hàng và ID thực, nhận đơn và gửi tồn có xác nhận. Không dùng token giả dự phòng. Danh sách đơn đồng bộ và nhật ký hiện trong quản trị. Xem [hướng dẫn sàn](marketplace-sync-setup.md).
- Hàng đợi nén chat có lease, heartbeat, thu hồi tác vụ treo, thử lại giới hạn và trạng thái/lỗi trong Chat trực tuyến. Gửi tệp vẫn tách khỏi thao tác nhắn tin. Giữ giới hạn tài nguyên; không hứa dung lượng vô hạn.
- Ảnh mới có bản gốc giữ nguyên byte cùng metadata/checksum trên MEDIA_ROOT và ảnh WebP hiển thị riêng. Thư viện tệp có chế độ xem/tải bản gốc; chặn xóa bản còn được tham chiếu. Chat giữ nguồn gốc đến khi chính sách xóa/hết hạn tệp chạy. Không thể khôi phục chi tiết đã mất từ các bản gốc cũ không còn tồn tại.
- Khách có thể xem RMA/địa chỉ kho và khai báo vận đơn gửi về từ tài khoản; yêu cầu đổi/trả có form thay cho prompt. Đơn khách vãng lai có luồng tra cứu/đề nghị hoàn trên trang tracking. Quyền sở hữu, capability token và CSRF được tách rõ.
- Cài đặt có trình biên tập tri thức AI đã duyệt, từ khóa, nguồn HTTPS tham chiếu và bật/tắt tìm web. Tìm web mặc định tắt cho đến khi quản trị chủ động bật. Giá/tồn kho tiếp tục lấy từ cơ sở dữ liệu, không bị ghi đè bởi tri thức.
- Tổng quan phân biệt trạng thái database, hàng đợi email, khả năng truy cập storage và cấu hình chưa nghiệm thu; không suy diễn TLS/SMTP/đối tác thành công từ việc lưu cấu hình.

## Migration và phát hành

Ba migration bổ sung, qua cơ chế migration hiện có trước khi mở listener:

1. `marketplace-sync-completion.sql`: định danh sản phẩm/biến thể sàn trên mapping hiện có.
2. `chat-compression-leases.sql`: lease, retry, nguồn chat.
3. `media-upload-originals.sql`: metadata bản gốc ảnh.

Không xóa hoặc tự tạo đơn vận hành, không đổi tồn, cấu hình nhận tiền hoặc credential của nhà cung cấp khi chỉ nâng cấp. Chỉ chọn trừ tồn khi đồng bộ đơn sàn sau khi đã đối chiếu quy trình. Asset thay đổi được tăng version tránh dùng JS/CSS cũ. Sao lưu database và MEDIA_ROOT theo quy trình vận hành trước phát hành; bản sao Git không chứa file upload hay database.

## Kiểm chứng

- 762/762 kiểm thử trên Node.js 24, không fail/skip.
- 180 lượt trình duyệt fixture: 13 trang khách, 31 mục quản trị và editor × 360/390/768/1440px; sau cuộn không tràn ngang toàn trang, không lỗi JavaScript khi mở view.
- Fixture Thư viện tệp không đặt MEDIA_ROOT trả 503 đúng cơ chế đóng an toàn; test storage riêng dùng thư mục tạm kiểm tra upload/ảnh gốc/retention. Không kết luận quyền ghi production từ fixture.
- Có kiểm thử thay đổi số Xu thực, tỷ lệ theo hạng, metadata cold/warm/nén, token/permission/CSRF, phân trang sàn, lease fencing và byte gốc ảnh.

## Phần còn cần nghiệm thu vận hành

Chưa dùng bí mật production, gửi email thật, thu/hoàn tiền, tạo vận đơn thật, sửa tồn sàn hoặc phát hành hóa đơn thật trong đợt sửa mã. Provider API approval, token chính thức, sandbox và callback từng nhà cung cấp vẫn cần kiểm tra. Bản này cho nhập/cập nhật token sàn thủ công và kiểm quyền đọc; chưa tự chạy OAuth hoặc tự gia hạn refresh token. Tài khoản sàn hết hạn phải nhập token mới rồi xác minh lại.

Chưa thử iPhone/Safari/Android và máy quét/máy in thật. WebP hiển thị vẫn là rendition tối ưu có thể giảm kích thước; bản gốc tải xuống mới là bản nguyên vẹn. Video lớn chuyển mã bằng khả năng trình duyệt, phụ thuộc codec và thiết bị. Không coi kiểm thử giả lập là hoàn thiện 100% tất cả dịch vụ bên ngoài.
