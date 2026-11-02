# Tạo và xác minh thanh toán

MoMo và ZaloPay tạo phiên ở máy chủ qua API chính thức. Checkout chỉ trả URL do nhà cung cấp gửi về sau khi xác nhận mã kết quả, merchant/request/số tiền khi có trường đối chiếu và host thanh toán được cho phép. Không tự ghép URL thay cho phiên thanh toán.

## Cấu hình và các kênh khả dụng

- COD và chuyển khoản ngân hàng kiểm tra cấu hình tại chỗ; không gọi đây là xác minh tài khoản ngân hàng hoặc kết nối với hãng vận chuyển. Chuyển khoản cần chủ doanh nghiệp đối soát trước khi ghi nhận đã thu tiền.
- VNPAY giữ luồng URL thanh toán có chữ ký và IPN. HTTP 200 của trang công khai chỉ chứng minh nhận được phản hồi HTTP, không xác thực merchant hoặc khóa.
- MoMo dùng POST `/v2/gateway/api/create`, truy vấn `/v2/gateway/api/query`, thông báo JSON có chữ ký đầy đủ; xác nhận IPN khớp đơn bằng HTTP 204.
- ZaloPay dùng POST `/v2/create`, truy vấn `/v2/query`, callback JSON có MAC và merchant khớp. `app_trans_id` lấy ngày theo múi giờ Việt Nam, được giữ trong payment attempt và dùng lại khi truy vấn/callback.
- 9Pay chưa có adapter được đối chiếu với hợp đồng merchant. Không cho bật, tạo checkout hoặc tự ghi nhận callback theo định dạng suy đoán. Cấu hình tắt vẫn có thể lưu; giao dịch lịch sử chỉ được đối soát bởi chủ doanh nghiệp.

Khóa được lưu mã hóa trong cấu hình chủ hiện có. Không có biến môi trường mới để nhập khóa vào mã nguồn. Trên production không cho bật cấu hình sandbox. Không tự bật nhận đơn hoặc kênh thanh toán khi khởi động.

## Ý nghĩa trạng thái xác minh

| Trạng thái | Bằng chứng |
| --- | --- |
| Đã kiểm tra cấu hình | Giá trị cấu hình đúng định dạng; chưa chứng minh tài khoản bên ngoài. |
| Liên lạc được máy chủ | Nhận được phản hồi HTTP/API; không chứng minh merchant hoặc secret hợp lệ. |
| Đã xác thực API | Nhà cung cấp đã tạo phiên hợp lệ hoặc truy vấn đối chiếu đúng đơn đã có và số tiền. Không xác nhận callback Key 2 của ZaloPay. |
| Đã xác thực phản hồi thanh toán | Callback được kiểm tra chữ ký, merchant, request ID và số tiền rồi đối chiếu thành công với đơn. |

Probe mã đơn không tồn tại luôn giữ `verified:false`. Bằng chứng có phương thức, phạm vi và phiên bản cấu hình; timestamp hoặc cờ `gateway_handshake` cũ không đủ để báo đã xác minh. Hết thời gian, HTTP 404, redirect, JSON sai, body quá lớn, mã lỗi, số tiền/ID không khớp hoặc URL sai host không được trả thành phiên thanh toán thành công. Không trả chi tiết secret hoặc body lỗi của nhà cung cấp ra trình duyệt/log.

## Đơn đang chờ và callback

Tắt kênh chỉ chặn đơn mới; callback tiếp tục dùng cấu hình merchant để xử lý đơn đang chờ. Không đổi tài khoản, khóa hoặc môi trường khi còn payment attempt đang chờ. Khóa giao dịch phối hợp giữa tạo đơn và thay cấu hình để tránh đổi khóa giữa chừng.

Chỉ IPN có chữ ký hợp lệ hoặc thao tác đối soát được chủ xác thực ghi nhận tiền. Browser return chỉ hiển thị; tham số `result`, `status` hoặc URL không làm đơn thành đã thanh toán. Trang kết quả đọc trạng thái máy chủ tối đa 6 lần trong 30 giây, có timeout và kiểm tra lại thủ công. Đơn đã hủy nhận thanh toán muộn vẫn giữ trạng thái hủy và cần đối chiếu; không tự chuyển sang giao hàng.

Callback lặp không ghi thêm phiếu thu. Lỗi tạo phiên làm rollback giao dịch cục bộ gồm đơn, giữ kho và hàng đợi email. Client không tự retry API tạo phiên khi kết quả nhà cung cấp chưa rõ. Lời gọi tạo phiên được giới hạn 30 giây/64 KiB; hiện còn nằm trong giao dịch tạo đơn, nên thời gian giữ khóa DB phụ thuộc độ trễ nhà cung cấp. Kiểm thử tải và cải tiến điều phối giao dịch là việc riêng trước khi mở rộng lưu lượng.

## Migration và điều kiện phát hành

Migration mới `db/payment-provider-verification.sql` được thêm vào danh sách chuẩn của `src/migrate.js`. Nó thêm provider request ID/trạng thái bằng chứng và thu hồi dấu xác minh cũ vốn chỉ dựa vào probe công khai. Giữ cấu hình mã hóa, lựa chọn bật/tắt và lịch sử thanh toán; không tự xác nhận tài khoản hoặc đổi bí mật.

Kiểm thử dùng PGlite và phản hồi provider mô phỏng theo đặc tả. Chưa chạy migration production, giao dịch merchant sandbox thật, chuyển tiền hoặc kiểm tra Key 2/callback thực của chủ doanh nghiệp. Trước phát hành: sao lưu DB, chạy migration trong staging, kiểm tra URL Return/IPN đã đăng ký và nghiệm thu giao dịch sandbox nhận callback đúng. Không xoay khóa mã hóa/MFA trong quá trình này.

## Tài liệu chính thức

- [MoMo tạo thanh toán](https://developers.momo.vn/v3/docs/payment/api/wallet/onetime/)
- [MoMo truy vấn](https://developers.momo.vn/v3/docs/payment/api/payment-api/query/)
- [MoMo IPN](https://developers.momo.vn/v3/docs/payment/api/result-handling/notification/)
- [ZaloPay tạo đơn](https://docs.zalopay.vn/vi/docs/specs/order-create/)
- [ZaloPay truy vấn](https://docs.zalopay.vn/vi/docs/specs/order-query/)
- [ZaloPay callback](https://docs.zalopay.vn/vi/docs/specs/callback-api/)
