# Tích hợp và nghiệm thu thanh toán MoMo

Đối chiếu ngày 26/11/2026 với tài liệu người dùng cung cấp: `2026_MoMo_Payment_Platform_Technical_Documentation.docx.pdf`, 239 trang. Phần áp dụng: môi trường/merchant (trang 15–16), thanh toán một lần (24–30), truy vấn (215–216), mã kết quả (226–229), IPN (230–232).

Phạm vi triển khai là checkout website qua `captureWallet`, `autoCapture: true`, chuyển khách tới `payUrl` của MoMo. Liên kết ví, trừ tiền định kỳ, thẻ, POS và hoàn tiền qua API là các luồng riêng chưa được bật bởi tích hợp này. Hoàn tiền tiếp tục được đối soát và thực hiện trong Merchant Portal; ghi nhận trả hàng trong GAERU không phải lệnh chuyển tiền từ MoMo.

Chưa có khóa merchant và chưa chạy giao dịch MoMo thật. Test/runner trong repository dùng dữ liệu mô phỏng. Kết quả đạt không thay thế Sandbox, UAT hay xác nhận go-live của MoMo.

## Hợp đồng API

| Nội dung | Triển khai |
| --- | --- |
| Sandbox | `https://test-payment.momo.vn` |
| Production | `https://payment.momo.vn` |
| Tạo phiên | `POST /v2/gateway/api/create` |
| Tra cứu | `POST /v2/gateway/api/query` |
| Số tiền | Số nguyên VND từ 1.000 đến 50.000.000, tính từ đơn phía máy chủ |
| Request ID | Lưu cùng payment attempt; không lấy từ trình duyệt |
| Chữ ký | HMAC-SHA256 với chuỗi trường theo thứ tự MoMo quy định |
| Gọi API | Timeout 30 giây; giới hạn phản hồi 64 KiB |
| IPN | POST JSON; kiểm chữ ký, partner, mã đơn, request ID, số tiền trước ghi nhận |
| Phản hồi IPN | HTTP 204 không nội dung sau khi ghi dữ liệu; tài liệu yêu cầu trong 15 giây |
| Browser return | Điều hướng/hiển thị; không tự ghi nhận tiền |

URL lấy từ `PUBLIC_BASE_URL` (HTTPS):

- Return: `https://<domain>/api/payments/momo/return`
- IPN: `https://<domain>/api/payments/momo/ipn`

Với domain `gaeru.com`, thay `<domain>` bằng `gaeru.com`. Hai đường dẫn cần truy cập công khai qua HTTPS; IPN không yêu cầu cookie đăng nhập, không đặt CAPTCHA phía trước. Payload giả vẫn bị từ chối; GET vào IPN trả 405.

Chỉ chấp nhận `payUrl` HTTPS từ đúng host tương ứng môi trường; kiểm chữ ký phản hồi tạo phiên nếu MoMo cung cấp. QR/deeplink tùy chọn cần được MoMo cấp quyền ở production (trang 28); checkout hiện dùng `payUrl`.

## Kết quả và đối soát

| Kết quả MoMo | Xử lý GAERU |
| --- | --- |
| `0` | Ghi nhận tiền, chuyển đơn đang chờ sang chờ gửi hàng |
| `9000` | Thành công vì GAERU luôn dùng một bước `autoCapture: true` (trang 229) |
| `1000`, `7000`, `7002` | Giữ chờ, tiếp tục tra cứu |
| `1001`, `1005`, `1006` và mã thất bại cuối cùng khác được tài liệu liệt kê | Lần thanh toán thất bại, không ghi thu tiền |
| Lỗi API, không tìm thấy, mã chưa biết, timeout | Chưa xác định; không suy diễn đã trả tiền hoặc thất bại |
| Callback trùng/đến sai thứ tự | Không hạ trạng thái đã trả tiền, không tạo phiếu thu trùng |
| Tiền đến sau hủy đơn | Ghi nhận tiền, giữ đơn đã hủy và tạo yêu cầu đối chiếu |

Worker trong `src/server.js` tự tra cứu các payment attempt MoMo chưa kết thúc. Chạy ở host bật `BACKGROUND_JOBS_ENABLED` và worker số 0 khi dùng cluster. Tắt checkout vẫn xử lý các giao dịch đang chờ.

Lần đầu được lên lịch sau 30 giây. Nhịp tiếp theo: 30 giây trong giờ đầu, 5 phút trong ngày đầu, rồi mỗi giờ; lỗi mạng/cấu hình chờ 5 phút. Mỗi đợt tối đa 20 giao dịch; thời gian thực tế phụ thuộc độ trễ và lượng đơn. Claim DB có thời hạn 60 giây; không giữ kết nối DB khi gọi MoMo. Chỉ áp dụng kết quả khi claim còn thuộc worker và merchant chưa đổi.

Query phải khớp merchant, mã đơn, request ID truy vấn, số tiền và có transaction ID hợp lệ khi thành công. Nếu `refundTrans` có hoàn tiền thành công/đang xử lý, giữ lại để đối chiếu, không tự ghi phiếu thu đủ giá trị và cho giao hàng.

Theo dõi ở `payment_attempts.last_status_check_at`, `next_status_check_at`, `status_check_error`. Chỉ lưu mã lỗi đã lọc, không lưu secret hay phản hồi lỗi nguyên bản. Nhật ký phân biệt `payment.momo.query` và `payment.momo.callback`.

Không đổi partner/key/môi trường khi còn checkout đang tạo hoặc giao dịch chưa đối soát/còn thời hạn. Bật/tắt kênh vẫn được phép. Không tự retry tạo phiên khi kết quả chưa rõ; hết thời hạn giữ hàng cục bộ không chứng minh hết hạn ở MoMo.

## Cài đặt và nghiệm thu

1. Sao lưu DB, chạy `npm run db:migrate` trên staging. `momo-payment-recovery.sql` thêm lịch tra cứu và đưa các attempt bị bản cũ đánh dấu thất bại do mã chờ về chờ tra cứu. Migration không đánh dấu đơn đã trả tiền.
2. Đăng ký tại [MoMo Business](https://business.momo.vn), lấy bộ Sandbox riêng trong [trung tâm tích hợp](https://business.momo.vn/sanpham/portal/payment-integration-center).
3. Trong GAERU CEO, mở cấu hình MoMo, nhập Partner Code, Access Key, Secret Key, chọn Sandbox trên môi trường thử nghiệm. Không gửi Secret Key qua chat/Git. Không bật Sandbox trên website chạy `NODE_ENV=production`.
4. Chạy kiểm thử tự động:

```powershell
node --test test/payment-provider-clients.test.js test/momo-merchant-acceptance.test.js test/momo-recovery.integration.test.js test/payment-channels.test.js test/payment-return-access.test.js test/payment-result-status.test.js
node scripts/momo-sandbox-runner.js
```

5. Khi có khóa, thử MoMo Test: thành công, hủy, thiếu số dư, hết hạn, đóng trình duyệt, mất IPN rồi query phục hồi, callback trùng, tiền đến sau hủy. Mỗi đơn chỉ có một phiếu thu; đo IPN dưới 15 giây trên hạ tầng thật.
6. Gửi kết quả cho MoMo. Sau khi được cấp Production, hoàn tất UAT và xác nhận go-live theo trang 16 trước mở cho khách.

Nút “Kiểm tra kết nối” chỉ xác thực merchant khi query đối chiếu được giao dịch đã tồn tại. HTTP từ mã đơn probe không chứng minh khóa đúng và không nghiệm thu IPN.

## Tài liệu chính thức

- [Thanh toán một lần](https://developers.momo.vn/v3/docs/payment/api/wallet/onetime/)
- [Truy vấn giao dịch](https://developers.momo.vn/v3/docs/payment/api/payment-api/query/)
- [Mã kết quả](https://developers.momo.vn/v3/docs/payment/api/result-handling/resultcode/)
- [IPN](https://developers.momo.vn/v3/docs/payment/api/result-handling/notification/)
