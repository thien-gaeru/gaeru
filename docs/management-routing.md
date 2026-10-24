# Đường dẫn quản trị GAERU

Điểm vào quản trị: /gaeru_ceo. Trang thêm/chỉnh sửa sản phẩm nằm dưới /gaeru_ceo/products/. Tài nguyên quản trị được cấp theo danh sách cho phép tại /gaeru_ceo/assets/. Các HTML nội bộ không được cấp qua tuyến tài nguyên này.

API quản trị dùng /api/gaeru_ceo. Toàn bộ giao diện đã dùng tuyến mới; kiểm tra phiên đăng nhập, phân quyền và CSRF vẫn áp dụng. Đường dẫn /admin cùng tất cả đường dẫn con và /api/admin trả 404 cho mọi phương thức, không chuyển hướng. Bộ chặn chạy trước xử lý API và máy chủ tệp tĩnh, bao gồm các biến thể mã hóa và chữ hoa.

Sau cập nhật, tải lại các tab quản trị đang mở để tải đường dẫn tài nguyên/API mới. Tài nguyên quản trị dùng Cache-Control: no-store.

Đổi tên đường dẫn không thay thế kiểm tra đăng nhập, phân quyền hoặc xác thực hai yếu tố.
