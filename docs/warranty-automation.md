# Bảo hành tự động và chống trùng

Mỗi sản phẩm trong đơn website có một hồ sơ cho mỗi đơn vị số lượng, tạo trong cùng giao dịch lúc thêm dòng đơn. Khi đơn hoàn tất và payment_status=paid, tự kích hoạt; thời hạn 12 tháng tính từ ngày tạo đơn theo giờ Việt Nam, không tính lại theo ngày đăng ký. Hủy đơn từ chối hồ sơ chờ hoặc thu hồi hồ sơ đang hoạt động. Không tự kích hoạt lại hồ sơ bị từ chối/thu hồi. Dữ liệu đơn cũ được tạo bù khi migration; hồ sơ đang hoạt động không bị gia hạn lại.

Hồ sơ automatic không hiện hành động duyệt thủ công hoặc cảnh báo chờ đối chiếu. Quản trị vẫn tìm kiếm, xem và thu hồi hồ sơ đang hoạt động. API đăng ký đơn website trả 409 kèm thông báo không cần đăng ký lại. Đơn khách vãng lai vẫn có hồ sơ, không công khai dữ liệu riêng tư qua mã đơn.

Đơn ngoài hệ thống: chặn mã website đã có dữ liệu, chặn trùng theo kênh và mã đơn đã bỏ khoảng trắng/đổi chữ hoa, kể cả requestKey hoặc phiên khác và sau khi đã kích hoạt. Khóa chính bảng claims đảm bảo không nhận hai yêu cầu đồng thời. Gửi lại đúng requestKey/nội dung/phiên trả kết quả cũ để an toàn khi mạng lỗi. Yêu cầu bị từ chối muốn điều chỉnh cần liên hệ GAERU, không gửi mã đơn lại. Hồ sơ trùng đã tồn tại trước migration được giữ nguyên để không mất lịch sử, nhưng không nhận thêm bản mới.

Quản trị phân trang theo 25 mã đơn, giữ đầy đủ các sản phẩm trong cùng một đơn. Mỗi dòng đơn được thu gọn, xổ xuống để xem chi tiết. Ngày mua khách tự cung cấp lưu claimed_purchase_date, không đồng nghĩa đã xác nhận; quản trị đối chiếu rồi chọn ngày mua thực tế khi duyệt. Lý do có mẫu theo thao tác, có thể nhập nội dung riêng.
