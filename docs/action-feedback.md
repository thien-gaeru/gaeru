# Phản hồi thao tác dùng chung

action-feedback.js và action-feedback.css được tải sau lớp Turnstile, trước các script ứng dụng trên toàn bộ HTML công khai, trang quản trị và trình chỉnh sửa sản phẩm.

Các sự kiện click/submit bất đồng bộ, kể cả onclick/onsubmit và các lệnh fetch khởi chạy trực tiếp, được theo dõi đến khi hoàn tất. Nút giữ nguyên nội dung và có vòng quay, aria-busy cùng aria-disabled. Chặn bấm lặp và gửi lại bằng Enter trong lúc xử lý. Không ghi đè thuộc tính disabled của ứng dụng vì một số nút phải tiếp tục bị khóa theo quyền, hạn gửi lại hoặc trạng thái nghiệp vụ.

Thông báo dùng phản hồi máy chủ hoặc nội dung trạng thái có sẵn của biểu mẫu. Yêu cầu lỗi không hiển thị thông báo thành công. Lỗi kết nối nhắc kiểm tra kết quả trước khi gửi lại, không tự thử lại thao tác ghi. Chuỗi CAPTCHA được xử lý trong lớp fetch phía dưới, vì vậy nút tiếp tục chờ trong lúc xác minh. Thông báo được đặt trong hộp thoại đang mở nếu có, để vẫn đọc và đóng được khi xác thực hai yếu tố.

Không thêm thông báo cho thăm dò nền. Thao tác đồng bộ chỉ mở/đóng giao diện hoặc chọn tệp không cần trạng thái chờ giả. Lỗi kiểm tra biểu mẫu được thông báo, không gửi dữ liệu thiếu. Không sửa URL API, nội dung yêu cầu, giá trị trường nhập hay quy tắc thành công của nghiệp vụ.

Kiểm thử mô phỏng DOM bao gồm: gửi biểu mẫu/onclick, ngăn bấm lặp và Enter, chuỗi CSRF→ghi, giữ trạng thái disabled do ứng dụng đặt, lỗi máy chủ, mất kết nối, xác thực nội bộ và khôi phục sau lỗi do ứng dụng tự xử lý. Kiểm thử này không thay thế kiểm tra giao diện trực tiếp trên trình duyệt.
