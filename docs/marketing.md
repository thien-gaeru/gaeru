# Marketing GAERU

Quản trị có mục Marketing với quyền marketing.read / marketing.write. Chủ, admin và quản lý có quyền theo vai trò hiện hành; vai trò Chỉ xem chỉ đọc. Cấp voucher vào tài khoản còn yêu cầu customers.read. Có audit khi tạo/sửa/cấp, phiên bản chống ghi đè, CSRF và truy vấn có tham số. Không xóa voucher/chiến dịch đã có lịch sử; tạm tắt bằng active.

Voucher giảm số tiền hoặc phần trăm, có giới hạn số tiền giảm, giá trị sản phẩm tối thiểu, thời gian bắt đầu/kết thúc, tổng lượt và lượt mỗi tài khoản. Một đơn chỉ dùng một voucher. Không giảm phí giao hàng. Người mua phải đăng nhập, lưu mã mở nhận hoặc được quản trị cấp vào ví. Mã voucher không đổi sau khi tạo. Khi sửa điều kiện, đơn đã đặt giữ snapshot khoản giảm và mã đã dùng.

Chiến dịch gồm tiêu đề, nội dung văn bản an toàn, thời gian và voucher đi kèm tùy chọn. Chỉ chiến dịch bật và trong thời hạn xuất hiện trong tài khoản. Trạng thái đã đọc lưu theo từng tài khoản và phiên bản chiến dịch. Không gửi email, SMS hay quảng cáo bên ngoài. Chưa triển khai giá sale tự động theo từng SKU, cộng dồn mã, vận chuyển miễn phí, phân khúc nâng cao hoặc gửi thông báo khi đóng website.

Ví voucher nằm tại Tài khoản → Ví voucher & ưu đãi, có mã đã lưu/được cấp, điều kiện, thời hạn, lượt sử dụng và khu vực nhận thông báo chương trình. Người mua có thể lưu mã hoặc khám phá voucher mở nhận. Khu vực có phân trang, nút tải lại. Quyền sở hữu lấy từ phiên đăng nhập, không tin customer_id từ trình duyệt. Bỏ phản hồi tải cũ khi chuyển tài khoản để tránh hiển thị nhầm dữ liệu.

Thanh toán có ô mã và nút Áp dụng. Bước báo giá tính từ giá sản phẩm trong DB, không giữ chỗ lượt dùng. Khi đặt hàng, kiểm tra lại tài khoản, ví, hiệu lực, đơn tối thiểu và lượt dùng dưới khóa dòng voucher, trong cùng transaction tạo đơn/giữ kho. Không nhận số tiền giảm do client gửi. Lưu discount_vnd và voucher_code trên đơn, voucher_redemptions theo order_id duy nhất. Đơn hủy thành công hoàn lượt đúng một lần; lỗi giao dịch rollback cả lượt và đơn. Hoàn tiền sau bán chưa có quy trình tự hoàn voucher.

Cập nhật phí giao hàng, công nợ và VNPAY dùng tổng sau giảm. Dòng sản phẩm và subtotal giữ giá gốc; discount hiển thị riêng. Không tự giảm lại khi quản trị đổi điều kiện voucher. Voucher phần trăm được làm tròn xuống theo đồng. Đơn VNPAY tổng bằng 0 bị từ chối theo giới hạn thanh toán hiện có.

Kiểm thử tích hợp dùng PostgreSQL nhúng: quyền quản trị, validation, lưu/cấp ví, không vượt quota, tính giảm/cap, chặn tái sử dụng, hủy đơn lặp, snapshot khi sửa voucher/phí giao hàng, công nợ sau giảm, không đọc chéo tài khoản, chiến dịch đã đọc và mã chưa đến hạn. Khóa dòng được dùng cho PostgreSQL thực, nhưng chưa thực hiện kiểm tra nhiều kết nối đồng thời trên production. Không tạo chiến dịch/voucher hoặc đơn thử thật trên website trong quá trình triển khai.
