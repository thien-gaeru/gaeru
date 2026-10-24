# Cảnh báo và trải nghiệm quản trị

Thông báo nằm trong thanh điều hướng quản trị, có số lượng chưa đọc, xem mục xử lý, đánh dấu từng mục hoặc tất cả đã đọc. Tự kiểm tra mỗi 15 giây khi trang đang hiển thị và có mạng. Trạng thái đọc lưu theo tài khoản; nội dung thay đổi sẽ trở lại chưa đọc. Chỉ truy vấn nhóm dữ liệu theo quyền hiện tại. Mỗi nhóm hiển thị tối đa 25 công việc gần nhất (yêu cầu xóa tối đa 10), không phải tổng tất cả hồ sơ. Không gửi email hoặc thông báo ngoài trang cho các cảnh báo này.

Cảnh báo: đơn chờ xác nhận; yêu cầu mới hoặc khách đã trả lời lại; bảo hành chờ đối chiếu; biến thể đang bán tồn kho từ 5 trở xuống; thiếu cấu hình email/OpenAI (quyền cài đặt); khách đang chờ xác nhận xóa tài khoản (quyền xem khách hàng). Khi công việc không còn cần xử lý, cảnh báo tự biến mất.

Trang sản phẩm có 9 ô chờ tải ảnh, ảnh chính, ảnh mô tả và video MP4. Nội dung mô tả hỗ trợ 12 mục ảnh/video, đổi thứ tự, chú thích và mô tả thay thế. Ảnh tối đa 8 MB; video tối đa 25 MB/tệp, 15 video/giờ/IP, tối đa 2 lượt tải video đồng thời trên một tiến trình. Video lưu trong cơ sở dữ liệu, không có dịch vụ chuyển mã hay nén tự động. Trình duyệt cần hỗ trợ codec của video MP4 đã tải lên. Máy chủ hỗ trợ byte ranges để tua video. Nội dung sản phẩm nháp chỉ người quản trị có quyền xem danh mục mới đọc được. Nội dung xuất bản hiển thị dưới phần mô tả trên cửa hàng.

Biến thể: mẫu Cổng kết nối, Bộ micro, Màu sắc; có thể sửa lựa chọn trước khi tạo tổ hợp. Áp dụng giá/tồn kho chung cho các biến thể trong biểu mẫu rồi lưu; tồn kho vẫn yêu cầu quyền duyệt kho và kiểm tra phiên bản. Biến thể đã lưu không bị xóa khỏi lịch sử.

Khách yêu cầu xóa trong Cài đặt bảo mật tài khoản, cần mật khẩu và mã hai yếu tố nếu đã bật. Máy chủ gửi liên kết một lần, hiệu lực 30 phút, đến email đăng ký. Khách đăng nhập đúng tài khoản và bấm xác nhận trong trang liên kết. Không xóa bằng truy cập GET. Sai tài khoản, mật khẩu, liên kết hết hạn/đã dùng hoặc thông tin bảo mật thay đổi sẽ không xóa. Có chống CSRF và giới hạn yêu cầu. Email chưa gửi được không kích hoạt yêu cầu hợp lệ.

Xác nhận xóa chuyển tài khoản sang chờ xóa. Trong 30 ngày khách đăng nhập lại để tự khôi phục; từ sau 30 ngày đến trước 1 năm cần quản trị hỗ trợ; đủ 1 năm tài khoản bị xóa vĩnh viễn theo tác vụ định kỳ. Xem account-retention.md cho phạm vi dữ liệu và cách vận hành.

Kiểm thử dùng PostgreSQL nhúng, email giả lập và tệp media kiểm tra giao thức. Không gửi yêu cầu xóa hay email kiểm thử đến khách trên production. Kiểm tra giao diện trực tiếp và phát video thực chưa thực hiện khi trình duyệt điều khiển không khả dụng.
