# Thời hạn xóa và khôi phục tài khoản

Ngày bắt đầu là thời điểm khách xác nhận liên kết xóa qua email. Gửi yêu cầu email chưa làm tài khoản bị khóa hoặc bắt đầu thời hạn.

Trong 30 ngày đầu, khách đăng nhập lại bằng đúng mật khẩu và mã hai yếu tố nếu đã bật thì tự khôi phục tài khoản. Không khôi phục chỉ vì mật khẩu đúng khi bước hai yếu tố chưa hoàn tất. Các phiên trước khi xác nhận xóa bị thu hồi. Mật khẩu, email, thông tin cá nhân, địa chỉ và thiết lập hai yếu tố được giữ trong thời gian chờ để khôi phục đầy đủ.

Từ hết 30 ngày đến trước 1 năm, khách không tự khôi phục được. Quản trị có quyền sửa khách hàng vào Khách hàng → Khôi phục tài khoản, nhập lý do và xác nhận. Thao tác được ghi nhận trong lịch sử quản trị, giữ nguyên mật khẩu và hai yếu tố. Nút Mở khóa thông thường không khôi phục được tài khoản đang chờ xóa.

Đủ 1 năm theo thời gian PostgreSQL, tài khoản không thể khôi phục kể cả qua quản trị. Ứng dụng chạy tác vụ dọn khi khởi động và mỗi 6 giờ, xử lý từng đợt 50 tài khoản, tiếp tục đến khi hết; có khóa để tránh hai tiến trình chạy trùng. Tác vụ xóa bản ghi khách hàng, sổ địa chỉ, liên kết đổi thông tin, mã khôi phục/xác minh, thiết lập bảo mật, hồ sơ bảo hành và hội thoại hỗ trợ gắn với tài khoản. Đơn hàng được bỏ liên kết tài khoản, thay tên, xóa email, điện thoại, địa chỉ và ghi chú; số liệu giao dịch và lịch sử kiểm toán vẫn giữ để đối chiếu. Không phải thao tác xóa số liệu tài chính hay nhật ký kiểm toán.

Chính sách mới áp dụng cho các xác nhận xóa sau bản cập nhật này. Những hồ sơ đã bị vô danh hóa theo cơ chế trước đây không thể tự phục dựng thông tin đã mất; trường deletion_recoverable=false ngăn báo khôi phục thành công sai.

Kiểm thử dùng dữ liệu giả trong PostgreSQL nhúng, bao gồm mốc 29 ngày, quá 30 ngày, hai yếu tố, quản trị khôi phục, CSRF và dọn tài khoản quá một năm. Không yêu cầu xóa hoặc khôi phục thử trên tài khoản khách thật.
