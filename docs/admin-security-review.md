# Rà soát quản trị GAERU — 24/10/2026

## Phạm vi và giới hạn
Đọc cấu trúc Express/PostgreSQL, luồng quản trị, phân quyền, phiên, tải tệp và mã phía trình duyệt; chạy bộ kiểm tra tự động. Không thực hiện kiểm thử xâm nhập độc lập, kiểm tra hạ tầng nhà cung cấp hoặc thử gửi email/thanh toán thật. Giao diện chưa được kiểm tra bằng trình duyệt tự động trong phiên này.

## Phát hiện và xử lý
- Mức cao: express.static từng phục vụ toàn thư mục dự án; denylist không chặn đường dẫn mã hóa như /s%72c/server.js và /%64b/schema.sql. Tái hiện cục bộ trả 200. Đã chuyển sang danh sách tệp trình duyệt được duyệt; tệp nội bộ, docs và các dạng mã hóa trả 404. Không xác định được lịch sử truy cập trước đó từ phạm vi này; cần kiểm tra nhật ký hạ tầng nếu muốn đánh giá sự cố.
- API dữ liệu chưa có chính sách cache đồng nhất. Đã thêm no-store, Vary Cookie và noindex; quản trị và tài nguyên quản trị không lưu cache.
- Bổ sung CSRF tập trung cho toàn bộ thao tác ghi quản trị, ngoài kiểm tra tại từng nghiệp vụ; chặn biến thể viết hoa tiền tố API và kiểm tra quyền trước router cửa hàng.
- Phiên quản trị giới hạn 30 phút không hoạt động, tối đa 8 giờ. Polling thông báo/CARE không kéo dài phiên. Hoạt động tương tác gửi nhịp kiểm tra có CSRF và giới hạn tần suất. Phiên cũ được khởi tạo mốc một lần khi chuyển phiên bản.
- So sánh token kiểm tra độ dài byte trước timingSafeEqual, tránh lỗi với chuỗi Unicode. Nhật ký lỗi máy chủ chỉ ghi loại và mã lỗi, tránh ghi toàn bộ câu truy vấn hay dữ liệu cá nhân.

## Cấu trúc, dữ liệu và trải nghiệm
- Các chỉ mục dùng một danh mục tiêu đề/mô tả và nhãn vai trò thống nhất. Menu tìm kiếm không bỏ qua quyền ẩn chức năng; quyền vẫn được kiểm tra ở máy chủ.
- Điều hướng giữ hash, hỗ trợ quay lại và mở trực tiếp mục được cấp quyền. Chỉ tải dữ liệu mục đang mở; trạng thái tải và lỗi hiển thị rõ.
- Giữ nghiệp vụ phân quyền, lịch sử bất biến, kiểm soát phiên bản cập nhật đồng thời, tồn kho, thanh toán và bảo hành đã có kiểm tra hồi quy.
- Giá trị tiền chưa có dữ liệu hiển thị Chưa xác định; không tự chuyển thành 0 tại bộ định dạng chung.
- Giao diện dùng hệ chữ hệ thống, icon nét tự vẽ, nền sáng, nhóm chức năng, tiêu đề rõ, khoảng cách và trạng thái thống nhất. Lấy cảm hứng từ phân cấp/sidebar của Apple, giữ thương hiệu GAERU và không sử dụng tài sản Apple.

## Mã hóa và việc chưa xác minh
- Mật khẩu: bcrypt cost 12; đây là băm một chiều.
- Bí mật MFA: AES-256-GCM, IV ngẫu nhiên và authentication tag. Token phục hồi được băm. Nếu chưa có AUTH_ENCRYPTION_KEY, hệ thống dùng khóa phiên dự phòng; không thay khóa tùy tiện vì có thể mất khả năng giải mã MFA hiện có.
- Email, điện thoại, địa chỉ là trường ứng dụng chưa mã hóa riêng. Không tuyên bố toàn bộ thông tin khách hàng đã mã hóa ở cấp trường.
- Trang chủ doanh nghiệp hiển thị trạng thái cấu hình Turnstile/MFA/khóa riêng và kết quả pg_stat_ssl của kết nối đang dùng; thiếu quyền truy vấn hiển thị Chưa xác minh. Trạng thái cấu hình không chứng minh nhà cung cấp hoạt động đầy đủ.
- Cần kiểm tra riêng: mã hóa ổ đĩa và backup, chính sách giữ bản sao, thử khôi phục backup, truy cập vận hành, nhật ký truy cập cũ và xoay khóa có kế hoạch. MFA vẫn theo thiết lập tài khoản; chưa áp chính sách bắt buộc cho mọi nhân viên.

## Tài liệu đối chiếu
- https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html
- https://developer.apple.com/design/human-interface-guidelines/sidebars

## TLS — xác minh ngày 24/10/2026
Kết nối thử riêng trên hosting xác nhận stream.encrypted=true và stream.authorized=true. pg_stat_ssl đồng thời báo false; vì vậy không dùng riêng pg_stat_ssl để kết luận TLS của ứng dụng. Có thể có điểm kết nối trung gian; mã hóa chặng phía sau cần nhà cung cấp xác minh. Production bắt buộc TLS 1.2 trở lên, kiểm tra chứng chỉ và không cho query string sslmode ghi đè. Nếu không xác minh được TLS, không tự hạ xuống kết nối không mã hóa. Có thể cung cấp PGSSL_CA nếu nhà cung cấp dùng CA riêng. Giao diện chủ hiển thị riêng TLS ứng dụng/chứng chỉ và trạng thái pg_stat_ssl. Không thay toàn bộ biến môi trường vì API hosting chỉ đọc lại giá trị đã che.
