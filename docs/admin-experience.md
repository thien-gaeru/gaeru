# Cảnh báo và trải nghiệm quản trị

Thông báo nằm trong thanh điều hướng quản trị, có số lượng chưa đọc, xem mục xử lý, đánh dấu từng mục hoặc tất cả đã đọc. Tự kiểm tra mỗi 15 giây khi trang đang hiển thị và có mạng. Trạng thái đọc lưu theo tài khoản; nội dung thay đổi sẽ trở lại chưa đọc. Chỉ truy vấn nhóm dữ liệu theo quyền hiện tại. Mỗi nhóm hiển thị tối đa 25 công việc gần nhất, không phải tổng tất cả hồ sơ. Không gửi email hoặc thông báo ngoài trang cho các cảnh báo này.

Cảnh báo: đơn chờ xác nhận; yêu cầu mới hoặc khách đã trả lời lại; bảo hành chờ đối chiếu; biến thể đang bán tồn kho từ 5 trở xuống; thiếu cấu hình email/OpenAI (quyền cài đặt). Khi công việc không còn cần xử lý, cảnh báo tự biến mất.

Trang sản phẩm có ô ảnh chính cao bằng hai hàng ảnh nhỏ, một ô thêm ảnh và giới hạn 9 ảnh. Ảnh chọn xuất hiện tức thì qua bản xem trước cục bộ, tải ngầm theo hàng đợi; lỗi có thể thử lại hoặc bỏ. Không lưu sản phẩm khi còn ảnh chưa tải xong. Có ảnh mô tả và video MP4. Nội dung mô tả hỗ trợ 12 mục ảnh/video, đổi thứ tự, chú thích và mô tả thay thế. Ảnh tối đa 8 MB; video tối đa 25 MB/tệp, 15 video/giờ/IP, tối đa 2 lượt tải video đồng thời trên một tiến trình. Video lưu trong cơ sở dữ liệu, không có dịch vụ chuyển mã hay nén tự động. Trình duyệt cần hỗ trợ codec của video MP4 đã tải lên. Máy chủ hỗ trợ byte ranges để tua video. Nội dung sản phẩm nháp chỉ người quản trị có quyền xem danh mục mới đọc được. Nội dung xuất bản hiển thị dưới phần mô tả trên cửa hàng.

Biến thể: mẫu Cổng kết nối, Bộ micro, Màu sắc; có thể sửa lựa chọn trước khi tạo tổ hợp. Áp dụng giá/tồn kho chung cho các biến thể trong biểu mẫu rồi lưu; tồn kho vẫn yêu cầu quyền duyệt kho và kiểm tra phiên bản. Biến thể đã lưu không bị xóa khỏi lịch sử.


Khách liên hệ GAERU để xóa hoặc khôi phục tài khoản. Quản trị đối chiếu yêu cầu, ghi lý do và gửi email xác nhận. Khách đăng nhập đúng tài khoản rồi xác nhận mới ngừng hoạt động; đăng nhập không tự khôi phục. Sau 1 năm tài khoản bị xóa vĩnh viễn theo tác vụ định kỳ. Xem account-retention.md.

Kiểm thử dùng PostgreSQL nhúng, email giả lập và tệp media kiểm tra giao thức. Không gửi yêu cầu xóa hay email kiểm thử đến khách trên production. Kiểm tra giao diện trực tiếp và phát video thực chưa thực hiện khi trình duyệt điều khiển không khả dụng.
