# Theo dõi hàng đợi vận hành

Chủ doanh nghiệp đăng nhập tài khoản chủ, mở **Trang tổng quan → Hàng đợi hệ thống**. Nút **Kiểm tra lại** đọc dữ liệu hiện tại, không gửi email hoặc gọi nhà vận chuyển. Chọn **Xem tác vụ** để lọc trạng thái, xem lần thử và các mốc thời gian; mỗi trang có tối đa 20 tác vụ. **Mở nghiệp vụ** dẫn tới nơi quản lý tương ứng.

Phạm vi hiện tại gồm email đơn hàng/tạo tài khoản, email báo đơn quản trị, email hội thoại, email Care+, email bảo hành, email chiến dịch, tối ưu tệp hội thoại và yêu cầu tạo vận đơn. Chỉ tài khoản chủ gốc được xem chi tiết. Các tài khoản có quyền xem tổng quan vẫn xem được kiểm tra hạ tầng tổng hợp. API và tài nguyên quản trị dùng `Cache-Control: no-store`.

| Trạng thái hiển thị | Ý nghĩa |
| --- | --- |
| Chờ xử lý | Tác vụ mới đang chờ theo trạng thái trong cơ sở dữ liệu. |
| Chờ thử lại | Tác vụ đang chờ và đã có lần xử lý trước; xem lịch xử lý tiếp theo. |
| Đang xử lý | Email đang chuyển giao, yêu cầu vận đơn đang gửi hoặc tệp đang tối ưu. |
| Chưa rõ kết quả | Kết quả bên ngoài chưa xác định. Phải đối soát tại dịch vụ trước khi xử lý tiếp. |
| Đã dừng do lỗi | Trạng thái lỗi cuối của hàng đợi. Không tự mở lại email hay vận đơn. |
| Đã xử lý | SMTP đã tiếp nhận thư, hoặc tác vụ nội bộ/ghi nhận vận đơn đã kết thúc. Không chứng minh email tới hộp thư hay kiện hàng đã giao. |
| Đã bỏ qua | Không còn đủ điều kiện xử lý theo nghiệp vụ. |

Nhãn quá thời gian dựa trên các mốc đã có trong worker: email đang gửi quá 2 phút, nén tệp hết hạn giữ tác vụ, tạo vận đơn đang gửi quá 5 phút. Chưa có phép đo nhịp hoạt động của tiến trình nền. Bảng không kết luận worker đang chạy chỉ vì đọc được cơ sở dữ liệu. Hàng đợi không đọc được được ghi rõ “chưa xác định”, không hiển thị thành số 0. Mốc thời gian và số lần thử chưa được nguồn ghi nhận được để trống rõ ràng.

Nút **Thử lại nén tệp** chỉ xuất hiện khi có quyền chỉnh sửa khách hàng, tệp chưa bị xóa, còn trong 30 ngày đầu và tác vụ đã lỗi hoặc hết hạn giữ tác vụ. Máy chủ kiểm tra lại điều kiện, CSRF và ghi nhật ký. Tệp quá thời hạn hoặc tác vụ còn hoạt động bị từ chối với mã 409. Thao tác này đưa tệp vào hàng đợi, không chứng minh đã nén xong. Nén là tác vụ nội bộ, không gửi lại nội dung cho người nhận.

Không có nút gửi lại email hoặc tạo lại vận đơn ở bảng theo dõi. Không trả nội dung thư, địa chỉ người nhận, dữ liệu khách hàng, phản hồi thô của nhà cung cấp hay khóa bí mật trong API này. Các phép kiểm tra nhà cung cấp và gửi thư thật phải được nghiệm thu riêng.
