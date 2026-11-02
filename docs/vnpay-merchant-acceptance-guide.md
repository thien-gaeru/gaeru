# Hướng dẫn Nghiệm thu Kỹ thuật & Đấu nối Chính thức Cổng VNPAY (100% Compliance)

Tài liệu này cung cấp toàn bộ quy chuẩn kỹ thuật, danh mục kịch bản kiểm thử bắt buộc (Merchant Acceptance Testing) và quy trình chuyển đổi môi trường (Production Cutover) cho cổng thanh toán điện tử **VNPAY 2.1.0** trên hệ thống **GAERU**.

---

## 1. Thông số kỹ thuật tích hợp

- **Phiên bản chuẩn**: VNPAY Payment Gateway `2.1.0`
- **Thuật toán mã hóa & băm chữ ký**: HMAC-SHA512 (`timingSafeEqual` chống tấn công Timing Attack)
- **Cơ chế sắp xếp tham số**: Sắp xếp alphabet URL-encoded trước khi tạo chuỗi băm
- **Bảo mật cơ sở dữ liệu**: Khóa dòng cấp dữ liệu PostgreSQL (`FOR UPDATE OF p, o`)
- **Cơ chế chống thanh toán trùng lặp (Idempotency)**: Khi nhận nhiều IPN cùng giao dịch, hệ thống bảo lưu trạng thái và trả về `{"RspCode":"02","Message":"Order already confirmed"}` mà không hạch toán kế toán lần 2.

### URL Đăng ký trên Merchant Admin VNPAY
| Kênh giao tiếp | Đường dẫn (URL) | Mục đích |
| --- | --- | --- |
| **Return URL** | `https://gaeru.vn/api/payments/vnpay/return` | Tiếp nhận khách hàng quay lại từ cổng VNPAY, hiển thị kết quả giao dịch và mã phản hồi chi tiết. |
| **IPN URL** | `https://gaeru.vn/api/payments/vnpay/ipn` | Tiếp nhận thông báo tức thì từ máy chủ VNPAY (Server-to-Server) để cập nhật trạng thái đơn sang `paid` và `processing`. |

---

## 2. Thông tin môi trường thử nghiệm (Sandbox)

- **Cổng thanh toán Sandbox**: `https://sandbox.vnpayment.vn/paymentv2/vpcpay.html`
- **Thẻ ATM nội địa thử nghiệm (Ngân hàng NCB)**:
  - Ngân hàng: **NCB**
  - Số thẻ: `9704198526191432198`
  - Tên chủ thẻ: `NGUYEN VAN A`
  - Ngày phát hành: `07/15`
  - Mã xác thực OTP: `123456`

---

## 3. Bảng kịch bản nghiệm thu kỹ thuật (Merchant Acceptance Checklist)

Hệ thống GAERU đã hoàn thiện và vượt qua 100% các kịch bản nghiệm thu tiêu chuẩn:

| Mã | Tên kịch bản | Thao tác trên VNPAY | `vnp_ResponseCode` | Phản hồi IPN (`RspCode`) | Trạng thái đơn GAERU |
|---|---|---|---|---|---|
| **SC-01** | Thanh toán thành công | Nhập OTP `123456` và bấm Xác nhận | `00` | `00` (Confirm Success) | `paymentStatus: paid`<br>`status: processing` |
| **SC-02** | Khách hàng hủy giao dịch | Bấm nút **"Hủy giao dịch"** trên màn hình VNPAY | `24` | `00` (Confirm Success) | `paymentStatus: pending`<br>`payment_attempt: failed` |
| **SC-03** | Thẻ chưa đăng ký Internet Banking | Mô phỏng thẻ chưa kích hoạt thanh toán trực tuyến | `09` | `00` (Confirm Success) | `paymentStatus: pending`<br>`payment_attempt: failed` |
| **SC-04** | Sai OTP hoặc thẻ hết hạn | Nhập sai OTP quá 3 lần hoặc thẻ quá hạn | `10` | `00` (Confirm Success) | `paymentStatus: pending`<br>`payment_attempt: failed` |
| **SC-05** | Giả mạo chữ ký (Signature Tampering) | Giả mạo hoặc sửa đổi tham số trên URL callback | Bất kỳ | `97` (Invalid signature) | Từ chối cập nhật đơn hàng |
| **SC-06** | Gian lận số tiền (Amount Tampering) | Sửa đổi số tiền `vnp_Amount` lệch với hệ thống | Bất kỳ | `04` (Invalid amount) | Từ chối cập nhật đơn hàng |
| **SC-07** | Đơn hàng không tồn tại | Gửi IPN với `vnp_TxnRef` không có trên GAERU | Bất kỳ | `01` (Order not found) | Từ chối cập nhật đơn hàng |
| **SC-08** | IPN trùng lặp (Idempotency) | VNPAY gửi lại IPN cho đơn đã xác nhận | `00` | `02` (Order already confirmed) | Giữ nguyên trạng thái đã thanh toán |

---

## 4. Chạy bộ kiểm thử nghiệm thu tự động

Kỹ sư hoặc chủ doanh nghiệp có thể thực thi bộ kiểm thử nghiệm thu kỹ thuật bất kỳ lúc nào bằng lệnh:

```bash
# Chạy bộ kịch bản nghiệm thu và xuất bảng báo cáo:
node scripts/vnpay-sandbox-runner.js

# Hoặc chạy kiểm thử tự động toàn diện qua Node test runner:
node --test test/vnpay-merchant-acceptance.test.js
```

---

## 5. Quy trình chuyển đổi sang môi trường Production (Go-Live Cutover)

Sau khi VNPAY phê duyệt tài liệu nghiệm thu kỹ thuật, thực hiện theo các bước sau để mở cổng chính thức:

1. **Nhận thông tin Production từ VNPAY**:
   - `vnp_TmnCode` (Mã website chính thức do VNPAY cấp).
   - `vnp_HashSecret` (Khóa bí mật mã hóa chính thức).
2. **Cấu hình trên giao diện quản trị GAERU CEO**:
   - Truy cập trang Admin: `https://gaeru.vn/admin` ➔ vào mục **Cấu hình hệ thống & Khóa API** ➔ chọn **Cổng thanh toán VNPAY**.
   - Cập nhật **Mã website (TmnCode)** và **Hash Secret**.
   - Chuyển trường **Môi trường** sang `Chính thức (Production)`.
   - Nhập mật khẩu hiện tại của chủ doanh nghiệp cùng mã xác thực OTP/MFA để ký lưu thay đổi.
   - Bấm nút **Bật kênh VNPAY**.
3. **Kiểm tra thông luồng thực tế (Live Sanity Check)**:
   - Tạo một đơn hàng thực tế giá trị nhỏ (ví dụ: 10.000₫) trên website.
   - Tiến hành thanh toán qua ứng dụng ngân hàng hoặc quét VNPAY-QR thật.
   - Kiểm tra đơn hàng tự động chuyển sang trạng thái **Đang xử lý / Đã thanh toán** và hệ thống ghi nhận đúng số dư kế toán.
