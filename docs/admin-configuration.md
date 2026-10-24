# Quản lý cấu hình quản trị

Chỉ tài khoản chủ nguồn bootstrap được đọc và sửa phần cấu hình riêng. Nhân viên kể cả vai trò admin không có quyền. Hồ sơ chủ gồm họ tên, doanh nghiệp, chức danh, mã số thuế, địa chỉ; dùng chung ở Quản trị tối cao và Bảo mật. Hồ sơ không thay đổi thông tin đăng nhập hoặc email khôi phục đã xác minh.

Thông tin hồ sơ và cấu hình lưu trong store_settings với tiền tố private_admin:, mã hóa AES-256-GCM bằng AUTH_ENCRYPTION_KEY hoặc khóa dự phòng SESSION_SECRET giống MFA hiện có. Không xoay khóa tùy tiện; phải lập kế hoạch giải mã và mã hóa lại toàn bộ các bản ghi cùng bí mật MFA. API không trả lại hash secret/partner key/app secret. Để trống trường bí mật giữ khóa cũ. Audit chỉ ghi tên trường và phiên bản, không ghi giá trị. Dùng phiên bản chống ghi đè, CSRF và phân quyền phía máy chủ. Cập nhật hệ thống cần nhập lại mật khẩu và MFA nếu tài khoản đã bật.

VNPAY: lưu TmnCode, secret, môi trường và trạng thái sử dụng. Dùng các endpoint cố định, không chấp nhận địa chỉ tùy ý. Cấu hình mới áp dụng cho yêu cầu tiếp theo và tồn tại qua khởi động lại; cấu hình môi trường cũ tiếp tục dùng khi chưa có bản ghi DB. Lưu bản ghi với trạng thái tắt sẽ ngừng đề xuất VNPAY cho đơn mới. Chặn thay đổi khi còn payment_attempt pending; khóa giao dịch chung giữa tạo đơn VNPAY và đổi cấu hình tránh race. Trên production không cho bật sandbox. Chưa kiểm tra giao dịch thật; cần xác nhận merchant, URL Return/IPN và thử giao dịch trên môi trường phù hợp. COD và cờ nhận đơn máy chủ không thay đổi.

MISA eShop/Shopee/TikTok Shop: hiện lưu hồ sơ ứng dụng và khóa mã hóa; chưa có OAuth callback, quản lý token, webhooks hoặc đồng bộ đơn/tồn kho. Giao diện ghi rõ chưa cấp quyền và chưa đồng bộ; không gắn trạng thái kết nối giả. Cần ứng dụng được phê duyệt và thông tin cửa hàng trước khi triển khai bước cấp quyền theo API của từng nền tảng.

Bảo mật hệ thống: chỉnh thời gian không hoạt động 5–60 phút và phiên tối đa 1–8 giờ, áp dụng phía máy chủ ở yêu cầu tiếp theo. Polling thông báo/CARE không kéo dài phiên. Hiển thị trạng thái Turnstile và email; khóa CAPTCHA/mã hóa vẫn quản lý tại máy chủ.

Thông báo: người dùng tự bấm cấp quyền trình duyệt; âm thanh là tùy chọn trên từng thiết bị. Không xin quyền tự động. Chỉ báo công việc mới sau lần tải đầu, nội dung thông báo hệ điều hành không chứa tên khách hay chi tiết hồ sơ. Cập nhật hoạt động khi quản trị mở, kể cả tab nền tùy chính sách trình duyệt. Không phải Web Push khi đã đóng trang; chưa triển khai VAPID, push subscription và tác vụ gửi nền. Trình duyệt/thiết bị có thể chặn thông báo hoặc âm thanh.

Tài liệu nhà cung cấp:
- https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html
- https://helpeshop.misa.vn/kb/ket-noi-voi-cac-ung-dung-khac-qua-open-api-tren-may-tinh
- https://partner.tiktokshop.com/docv2/page/create-your-app
- https://open.shopee.com/
