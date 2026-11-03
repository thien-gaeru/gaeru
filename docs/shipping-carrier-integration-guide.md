# Vận chuyển: ranh giới phần mềm và nghiệm thu đối tác

Các adapter J&T, Viettel Post, GHN, GHTK và SPX có kiểm thử bằng phản hồi giả lập. Các bài này không tạo vận đơn thật, không xác nhận tài khoản được hãng cấp quyền, endpoint đúng gói dịch vụ, nhãn in hợp lệ hoặc phí thực tế. Không gọi đây là nghiệm thu đối tác.

## Tạo vận đơn và chống gửi lặp

`POST /api/gaeru_ceo/shipping/orders/:id/create-waybill` cần `orders.write` và CSRF. Đơn bị hủy, hoàn trả xong, hoàn tất, đang chờ xét duyệt hoặc đơn trả trước chưa thanh toán bị chặn. Chỉ carrier đã xác minh đúng phiên bản và được bật mới được tạo vận đơn, kể cả khi gửi carrierId trực tiếp.

Yêu cầu được commit vào `carrier_shipment_attempts` trước khi gọi hãng. Timeout, mất kết nối, tiến trình dừng hoặc giao dịch ghi kết quả thất bại giữ claim sending/unknown và khóa gửi lại. Claim không tự hết hạn để tạo lần nữa. Mã hãng đã nhận được được lưu trước giao dịch ghi vận đơn; không tự tạo mã tracking dự phòng. Phí chưa có là null, phí bằng 0 được giữ nguyên.

Trong Cài đặt vận chuyển, chủ thấy tối đa 50 yêu cầu chưa rõ kết quả. Sau khi kiểm tra mã đơn tại cổng hãng và xác nhận chưa có vận đơn, chủ nhập bằng chứng, mật khẩu/MFA mới và ghi nhận đối soát. API `POST /api/gaeru_ceo/shipping/attempts/:id/reconcile` cần confirmedNoWaybill=true và lý do ít nhất 20 ký tự; không tự gọi hãng hoặc tự gửi lại. Yêu cầu đang gửi chưa đủ 5 phút và yêu cầu đã có mã hãng không được mở khóa. Mã hãng đã có nhưng chưa ghi nội bộ cần khôi phục vận đơn đó, không tạo mã mới; chưa có tự động truy vấn/khôi phục theo mã đơn từng hãng.

## Hủy, hành trình và callback

Hủy/tra cứu phải có xác nhận thành công; HTTP200 với payload lỗi không được coi thành công. GHN hủy cần đúng data[].order_code và result=true, theo [tài liệu GHN](https://developer.ghn.vn/vi/docs/order/cancel). Callback trễ của vận đơn đã hủy bị bỏ qua.

Public `/api/shipping/:carrier/webhook` bị khóa khi chưa có webhookSecret riêng. Khóa ít nhất 32 ký tự, được mã hóa và không trả về trình duyệt. Callback cần header X-Webhook-Secret hoặc Authorization: Bearer; token trong payload không được chấp nhận. Lỗi đọc/giải mã cấu hình dừng xử lý. Đây chỉ là cơ chế shared-secret có điều kiện; phải xác nhận hãng hỗ trợ gửi đúng header. Hãng không hỗ trợ cần adapter xác thực riêng trước khi bật callback.

Trạng thái không nhận diện không thay đổi đơn hoặc tiền. Các từ chung success, received, finish hoặc trạng thái phủ định không được suy ra là giao thành công. Bảng mã số/trạng thái thật từng gói dịch vụ còn cần đối chiếu. Lỗi ghi sổ Xu khiến giao dịch hoàn tất đơn/tiền rollback.

## Báo giá và nhãn

`POST /api/shipping/quote` chỉ gắn carrier_realtime khi nhận cước hợp lệ. Lỗi hoặc thiếu cước dùng fallback_rate_table theo bảng website; không tạo giá giả. SPX chưa tích hợp API báo giá nên dùng bảng phí. URL in nhãn chưa được xác minh bằng tài khoản hoặc máy in thật.

## Trước khi dùng vận hành

- Cần tài khoản/token hoặc sandbox được hãng cấp quyền, đúng gói dịch vụ và phiên bản API.
- Đối chiếu địa chỉ tỉnh/phường, trọng lượng/kích thước, dịch vụ, COD, tiền tệ, phí, idempotency mã đơn và quy trình hủy/tạo lại.
- Nghiệm thu truy vấn theo mã đơn, xác thực/replay callback, bảng mã số, quyền tải nhãn và in nhãn thật.
- Thử hãng đã nhận nhưng timeout, đối soát và khôi phục; không tự mở khóa khi chưa biết kết quả.
- Chạy integration-delivery-safety.sql qua cơ chế migration trước mở listener. PGlite kiểm chứng logic fixture; khóa nhiều kết nối PostgreSQL và crash recovery với provider cần staging riêng.
