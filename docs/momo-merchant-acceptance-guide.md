# Tích hợp và nghiệm thu thanh toán MoMo

Đối chiếu ngày 26/11/2026 với tài liệu kỹ thuật chính thức của MoMo: *MoMo Payment Platform — Technical Documentation (API & Integration Guide)*, trọn bộ **239 trang**. Phần áp dụng: Onboarding/M4B & môi trường (trang 13–18), chữ ký HMAC-SHA256 (trang 19), thanh toán một lần `captureWallet` (trang 22–30), truy vấn `query` (trang 215–216), mã kết quả (trang 226–229), IPN & Redirect (trang 230–232), bộ logo chính thức MoMo (trang 239).

Phạm vi triển khai là checkout website qua `captureWallet`, `autoCapture: true`, chuyển khách tới `payUrl` chính thức của MoMo (hỗ trợ Ví MoMo, AIO QR MoMo/Ngân hàng và Ví Trả Sau). Liên kết ví/tokenization, trừ tiền định kỳ, thẻ độc lập (`payWithMethod`/`payWithATM`/`payWithCC`), POS/EDC và hoàn tiền qua API (`/v2/gateway/api/refund`) là các luồng mở rộng riêng chưa bật trong bản này. Hoàn tiền tiếp tục được đối soát và thực hiện trong M4B Merchant Portal; ghi nhận trả hàng trong GAERU không tự gửi lệnh chuyển tiền sang MoMo.

Chưa có khóa merchant và chưa chạy giao dịch MoMo thật. Test/runner trong repository chạy mô phỏng giao thức chuẩn; kết quả đạt không thay thế SIT trên Sandbox thật, UAT trên Production và xác nhận go-live của MoMo.

## Hợp đồng API

| Nội dung | Triển khai tại GAERU |
| --- | --- |
| Sandbox / Production | `https://test-payment.momo.vn` / `https://payment.momo.vn` |
| Tạo phiên | `POST /v2/gateway/api/create` (`requestType: "captureWallet"`, `autoCapture: true`, `orderExpireTime: 15`) |
| Ngữ cảnh đơn hàng | Gửi kèm `storeName: "GAERU"`, `items` (tối đa 50 SKU đã khử trùng ID tránh mã `45`, `currency: "VND"`), `deliveryInfo`, `userInfo` |
| Tra cứu | `POST /v2/gateway/api/query` |
| Số tiền | Số nguyên VND từ `1.000` đến `50.000.000`, tính phía máy chủ và cảnh báo sớm trên Checkout UI |
| Định danh (`orderId` / `requestId`) | `orderId = GR-YYYYMMDD-XXXXXXXXXX` (22 byte, `< 64 byte`, không PII, khớp regex MoMo); `requestId` lưu ở `payment_attempts.provider_request_id` |
| Chữ ký | HMAC-SHA256 đúng chuỗi trường a–z MoMo quy định, đối chiếu bằng `timingSafeEqual` |
| Gọi API | Timeout mặc định `35s` (biên an toàn trên mức tối thiểu `30s` của MoMo, tối đa `60s`), giới hạn phản hồi `64 KiB` |
| IPN | `POST` JSON; bắt buộc `orderType === "momo_wallet"`, kiểm chữ ký 13 trường, `partnerCode`, `orderId`, `requestId`, `amount`; bỏ qua session middleware & CAPTCHA |
| Phản hồi IPN | `HTTP 204 No Content` ngay sau khi ghi dữ liệu (mục tiêu `< 15s`); `GET` trả `405` |
| Dữ liệu đối soát M4B | Trích xuất & ghi nhận `payType`, `paymentOption` (`momo`/`pay_later`), `userFee`, `promotionInfo` (`amountSponsor`…) vào nhật ký đối soát |
| Browser return | Chỉ xác thực chữ ký để cấp token xem đơn và hiển thị đủ **15/15** mã thất bại cuối cùng; tuyệt đối không tự ghi nhận tiền |
| Thương hiệu | Dùng logo chính thức MoMo (`assets/brand/momo-logo.webp` / `.png` từ `MoMo_Logo_Primary.zip`, tr. 239) ở Checkout và GAERU CEO |

URL lấy từ `PUBLIC_BASE_URL` (HTTPS), được GAERU tự động gửi trong từng yêu cầu `create`:

- Return: `https://gaeru.com/api/payments/momo/return`
- IPN: `https://gaeru.com/api/payments/momo/ipn`

> **Checklist Cloudflare / Tường lửa trước SIT & Go-Live:** Đảm bảo WAF / Bot Fight Mode / Rate Limit của Cloudflare không đặt JS Challenge, Managed Challenge hay CAPTCHA chặn `POST https://gaeru.com/api/payments/momo/ipn` từ máy chủ MoMo và thời gian phản hồi thực tế `< 15 giây`.

Chỉ chấp nhận `payUrl` HTTPS từ đúng host tương ứng môi trường; kiểm chữ ký phản hồi tạo phiên nếu MoMo cung cấp. `qrCodeUrl`/`deeplink`/`deeplinkMiniApp` cần xin MoMo cấp quyền ở production (trang 28); checkout hiện dùng `payUrl`.

## Kết quả và đối soát

| Kết quả MoMo | Xử lý GAERU |
| --- | --- |
| `0` | Ghi nhận tiền 1 lần, chuyển đơn sang `processing`, xóa lịch truy vấn, gửi email `payment_confirmed` + Web Push Admin |
| `9000` | Thành công vì GAERU luôn dùng 1 bước `autoCapture: true` (trang 229) |
| `1000`, `7000`, `7002` | Giữ `pending`, khóa hủy đơn trong cửa sổ 72 giờ, tiếp tục tra cứu ngầm |
| 15 mã thất bại cuối (`98, 99, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1017, 1026, 2019, 4001, 4002, 4100`) | Chốt phiên `failed`, xóa lịch truy vấn (`next_status_check_at = NULL`), hiển thị hướng dẫn tiếng Việt riêng cho từng mã |
| Lỗi API/hệ thống (`10–47`), không tìm thấy, mã chưa biết, timeout | Giữ chưa xác định; không suy diễn đã trả tiền hoặc thất bại |
| Callback trùng / đến sai thứ tự | Không hạ trạng thái đã trả tiền, không tạo phiếu thu trùng, trả `HTTP 204` |
| Callback hợp lệ nhưng không khớp đơn/requestId | Trả `HTTP 409`, ghi `audit_events` (`unmatched_callback`/`mismatched_callback`) và gửi cảnh báo SSE + Push Admin |
| Tiền đến sau hủy đơn | Ghi nhận tiền, giữ đơn `cancelled` và tạo mục `order_reviews` (`late_payment_on_cancelled_order`) |

Worker đối soát trong `src/server.js` (`startMomoReconciliationWorker`) chạy khi `BACKGROUND_JOBS_ENABLED !== 'false'` ở worker 0:

- Lần đầu sau 30 giây; nhịp tiếp theo 30 giây trong giờ đầu, 5 phút trong ngày đầu, rồi mỗi giờ; cửa sổ đối soát tối đa **72 giờ** kể từ `expires_at`.
- Phiên bỏ dở không có giao dịch phía MoMo (`resultCode: 42`, chưa có `response_code`) quá **2 giờ** sau `expires_at` được đóng tự động (`PAYMENT_SESSION_EXPIRED`, `next_status_check_at = NULL`) để không khóa xoay vòng cấu hình.
- Claim DB có lease 60 giây, giải phóng hoàn toàn kết nối DB khi chờ HTTP MoMo; chỉ áp dụng kết quả khi claim còn hiệu lực và merchant chưa đổi.
- Nếu `refundTrans` có giao dịch hoàn tiền thành công/đang xử lý, giữ lại trạng thái `PAYMENT_QUERY_REFUNDED` để quản trị viên đối chiếu (hiển thị cảnh báo trên đơn hàng GAERU CEO).

## Cài đặt, dữ liệu test (tr. 17–18) và nghiệm thu 7 bước (tr. 13–16)

1. Sao lưu DB, chạy `npm run db:migrate` (`momo-payment-recovery.sql` đã có sẵn trong chuỗi migration chuẩn).
2. Đăng ký tại [MoMo Business (M4B)](https://business.momo.vn), lấy bộ Sandbox tại [Trung tâm tích hợp](https://business.momo.vn/sanpham/portal/payment-integration-center).
3. Trong GAERU CEO, mở cấu hình MoMo, nhập `Partner Code`, `Access Key`, `Secret Key`, chọn `Sandbox` trên môi trường thử nghiệm (không bật Sandbox trên website `NODE_ENV=production`).
4. Chạy kiểm thử tự động mô phỏng:

```powershell
node --test test/payment-provider-clients.test.js test/momo-merchant-acceptance.test.js test/momo-recovery.integration.test.js test/payment-channels.test.js test/payment-return-access.test.js test/payment-result-status.test.js
node scripts/momo-sandbox-runner.js
```

5. Khi đã có bộ khóa Sandbox thật từ M4B, chạy thử tạo & truy vấn phiên thật với MoMo Test:

```powershell
$env:MOMO_PARTNER_CODE="..."; $env:MOMO_ACCESS_KEY="..."; $env:MOMO_SECRET_KEY="..."
node scripts/momo-sandbox-runner.js --live-sandbox
```

6. Thực hiện SIT bằng **MoMo Test App** (trang 17–18):
   - Tạo ví test bằng SĐT 10 số hợp lệ tại VN, mật khẩu `000000`, OTP mặc định `000000` (hoặc `0000`).
   - Liên kết thẻ Agribank test `9704 05XX XXXX XXXX` để nạp tiền thử nghiệm.
   - *(Tham khảo nếu sau này bật `payWithMethod`/ATM/CC)*: Thẻ ATM test (`NGUYEN VAN A`, `03/07`): `9704 0000 0000 0018` (thành công), `...0026` (khóa), `...0034` (không đủ số dư), `...0042` (vượt hạn mức); Thẻ Credit test (`NGUYEN VAN A`, `05/26`, CVC `111`): `5200 0000 0000 1096` (3DS thành công), `...1104` (thất bại), `4111 1111 1111 1111` (không OTP thành công).
   - Chạy đủ các ca: thành công (`0`), hủy (`1006`), thiếu số dư (`1001`), hết hạn 15 phút (`1005`), đóng trình duyệt trước khi redirect, mất IPN rồi worker `query` tự phục hồi, callback trùng, tiền đến sau hủy đơn. Đo thời gian phản hồi IPN `< 15 giây`.
7. Gửi kết quả SIT cho MoMo duyệt, hoàn tất xác minh hồ sơ M4B, nhận khóa Production, chạy UAT trên Production và nhận xác nhận go-live của MoMo trước khi bật kênh cho khách hàng.

## Tài liệu chính thức

- [Thanh toán một lần (`captureWallet`)](https://developers.momo.vn/v3/docs/payment/api/wallet/onetime/)
- [Truy vấn giao dịch (`query`)](https://developers.momo.vn/v3/docs/payment/api/payment-api/query/)
- [Mã kết quả (`resultCode`)](https://developers.momo.vn/v3/docs/payment/api/result-handling/resultcode/)
- [Thông báo thanh toán (`IPN`)](https://developers.momo.vn/v3/docs/payment/api/result-handling/notification/)
