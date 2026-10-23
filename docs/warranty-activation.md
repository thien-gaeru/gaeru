# Kích hoạt GAERU CARE+

- Liên kết `care.html#warranty-activation` mở đúng biểu mẫu, kể cả khi chưa đăng nhập.
- Khách đã đăng nhập chọn đơn website và từng sản phẩm trong lịch sử tài khoản. Tên/điện thoại từ tài khoản và địa chỉ mặc định được điền sẵn; khi chọn đơn, thông tin giao hàng của đơn được dùng. Khách có thể kiểm tra, sửa trước khi gửi. Mỗi hồ sơ ứng với một sản phẩm; số đăng ký liên kết không vượt số lượng mua.
- Khách chọn Shopee, TikTok Shop, Lazada hoặc đơn website chưa nằm trong tài khoản có thể nhập mã đơn, tên sản phẩm/phiên bản và serial tùy chọn. Họ tên, điện thoại, địa chỉ và tỉnh/thành phố là bắt buộc. Không cần đăng ký tài khoản mới.
- Các đăng ký đều chờ xác nhận. Hệ thống không tự kiểm tra đơn sàn hoặc tự kích hoạt từ dữ liệu người gửi. Quản trị kiểm tra kênh mua, chứng từ, người mua, sản phẩm và ngày mua trước khi duyệt. Thời hạn vẫn tính 12 tháng từ ngày mua đã xác nhận; không tự kéo dài khi khách đăng ký muộn.
- Đăng ký có tài khoản xuất hiện trong hồ sơ riêng của tài khoản đó. Khách vãng lai nhận mã hồ sơ để lưu và liên hệ hỗ trợ, không có tra cứu công khai bằng mã đơn/số điện thoại. Đăng nhập sau này không tự nhận hồ sơ khách vãng lai.
- Chống gửi trùng theo khóa yêu cầu và nội dung, gắn phiên cho đăng ký vãng lai; CSRF và giới hạn yêu cầu được áp dụng. Chưa hỗ trợ tải chứng từ lên biểu mẫu hoặc gửi email thông báo tự động.

## Cơ sở dữ liệu và triển khai

`warranty-channels.sql` mở rộng bảng bảo hành hiện có, cho phép hồ sơ ngoài đơn website và lưu bản chụp thông tin liên hệ. Các hồ sơ cũ và quy trình duyệt đơn website được giữ lại.

Máy chủ `src/server.js` áp dụng các migration chưa chạy trước khi nhận kết nối. Migration chạy trong transaction với khóa chống chạy đồng thời, ghi nhận trong `schema_migrations`; lỗi migration khiến máy chủ không mở cổng thay vì chạy với cấu trúc thiếu. Có thể chạy trước bằng `npm run db:migrate`. Cần quyền DDL cho tài khoản database khi triển khai. Không thay mật khẩu, SMTP hoặc tồn kho.
