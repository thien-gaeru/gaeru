# Tin tức AI và hội thoại hỗ trợ

Trong quản trị, vào Tin tức → Viết bài mới (hoặc Chỉnh sửa) → Viết bài bằng AI. Nhập chủ đề và dữ kiện đã kiểm chứng, chọn giọng văn/độ dài, bấm Soạn bản đề xuất. Đọc bản đề xuất trước khi bấm Dùng bản đề xuất. Thao tác này điền biểu mẫu và chọn trạng thái Bản nháp, chưa lưu hoặc xuất bản. Chọn ảnh bìa thực, kiểm tra mô tả ảnh, sửa bài rồi lưu. Muốn xuất bản phải chọn trạng thái Xuất bản và lưu.

## Cấu hình OpenAI trên Hostinger

Trong cấu hình biến môi trường của ứng dụng Node.js gaeru.org, bổ sung OPENAI_API_KEY bằng khóa riêng của tài khoản OpenAI API. Giữ nguyên toàn bộ biến đang có, lưu và khởi động lại/triển khai lại ứng dụng. Có thể thêm OPENAI_NEWS_MODEL (mặc định gpt-4.1-mini). Không đặt khóa trong bài viết, HTML, JavaScript trình duyệt hoặc Git. Giao diện chỉ báo đã có cấu hình, không hiển thị khóa. Khóa phải có quyền gọi mô hình và tài khoản còn hạn mức API.

Dữ kiện được gửi đến OpenAI theo hành động của người soạn; không nhập dữ liệu khách hàng vào phần này. Ứng dụng gọi Responses API từ máy chủ với store:false và định dạng JSON cố định; không tự truy cập liên kết hoặc tự xuất bản. Mỗi yêu cầu giới hạn 6000 output tokens, chờ tối đa 60 giây; tối đa 2 yêu cầu đang xử lý và 20 lần mỗi giờ theo IP trên mỗi tiến trình. Bộ đếm này đặt lại khi khởi động lại.

## Hỗ trợ và tài khoản

Quản trị CARE+ hiển thị danh sách hội thoại và khung tin nhắn. Chọn yêu cầu, nhập phản hồi mới và chọn trạng thái. Tin nhắn cũ được giữ; phản hồi trước khi nâng cấp được chuyển vào lịch sử. Khách mở Xem hội thoại với GAERU trên trang CARE+ để đọc và trả lời sau phản hồi đầu tiên. Tin nhắn mới của khách chuyển yêu cầu về Đang kiểm tra. Yêu cầu đã đóng không nhận thêm tin; khách tạo yêu cầu mới. Dùng Tải lại để nhận cập nhật, đây chưa phải kết nối thời gian thực. Lịch sử tải 50 tin gần nhất và có nút xem tin trước; chống gửi trùng bằng phiên bản yêu cầu, giới hạn 30 tin khách mỗi giờ trên từng yêu cầu.

Trang tài khoản có thẻ Sản phẩm đã đăng ký bảo hành dưới lịch sử đơn hàng. Chỉ hiển thị dữ liệu của tài khoản đang đăng nhập, ngày mua/hạn bảo hành chưa xác nhận không được tự suy ra.

Các thao tác bảo mật thiếu/sai mật khẩu hiện tại tự cuộn và đưa con trỏ về trường mật khẩu; lỗi mã hai yếu tố không bị nhận nhầm là lỗi mật khẩu.

## Kiểm tra

Bộ kiểm thử dùng PostgreSQL nhúng và phản hồi OpenAI giả lập; không gửi dữ liệu khách hàng, email hoặc yêu cầu OpenAI có tính phí trong kiểm thử. Cần khóa API hợp lệ để xác nhận soạn bài thực trên máy chủ. Chưa kiểm tra giao diện trực tiếp trong trình duyệt khi điều khiển trình duyệt không khả dụng.
