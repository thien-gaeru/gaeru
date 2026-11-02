# Cloudflare Turnstile

Tạo widget Managed tại https://dash.cloudflare.com/ → Turnstile → Add widget. Cho phép hostname gaeru.com (và www.gaeru.com nếu website thực sự dùng). Trong cấu hình môi trường Node.js tại Hostinger, thêm TURNSTILE_SITE_KEY (công khai), TURNSTILE_SECRET_KEY (bí mật) và giữ PUBLIC_BASE_URL=https://gaeru.com. Bấm Apply changes rồi khởi động lại ứng dụng để áp dụng biến chạy lúc khởi động; có thể dùng Redeploy nếu không thấy thay đổi. Không đưa Secret key vào trình duyệt, kho Git hoặc ảnh chụp công khai. Không dùng khóa thử nghiệm trên production.

Nếu thiếu khóa, CAPTCHA chưa được bật; thông báo quản trị nhắc cần cấu hình. Không tự lấy khóa hoặc tạo tài khoản Cloudflare thay khách. Các giới hạn yêu cầu hiện hữu vẫn hoạt động.

Khi đủ cấu hình: máy chủ đếm lỗi nhập liệu/xác thực 400/401/403/422 cho các API POST/PUT/PATCH/DELETE, gộp theo IP (IPv6 theo subnet) đã băm HMAC, trong cửa sổ 15 phút. Từ lần thử thứ tư sau 3 lỗi cần CAPTCHA. Bộ đếm nằm trong PostgreSQL, không phụ thuộc cookie/session hoặc bộ nhớ tiến trình. Không đếm GET, lỗi chưa đăng nhập khi xem tài nguyên, quyền truy cập hay CSRF. Callback thanh toán được loại khỏi CAPTCHA và tiếp tục dùng chữ ký xác minh riêng. Biểu mẫu cố ý trả kết quả trung lập như quên mật khẩu vẫn dùng giới hạn tần suất hiện có, không tiết lộ tài khoản có tồn tại.

Token được kiểm tra qua Siteverify tại máy chủ, đối chiếu hostname, action guarded_form và thời gian tối đa 5 phút. Mỗi token chỉ dùng một lần theo Cloudflare. Dịch vụ xác minh lỗi thì từ chối thao tác đang cần CAPTCHA. Xác minh hợp lệ kèm thao tác thành công mới xóa bộ đếm; nhập sai tiếp vẫn cần CAPTCHA mới. Có giới hạn bổ sung 300 yêu cầu ghi /15 phút/IP khi bật Turnstile. Các bộ đếm hết hạn được dọn cùng tác vụ định kỳ tài khoản.

Giao diện tải widget chỉ khi cần, không làm mất dữ liệu biểu mẫu và cho phép hủy. API phải được bảo vệ ở máy chủ, không chỉ dựa vào widget. Chưa có khóa thật nên kiểm thử dùng bộ xác minh giả lập; chưa kiểm thử CAPTCHA thật trên production.

Nguồn: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ và https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
