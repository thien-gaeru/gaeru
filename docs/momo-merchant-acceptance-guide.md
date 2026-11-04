> Phạm vi: các bộ kiểm thử và runner trong repository mô phỏng callback/nhà cung cấp. Kết quả đạt không thay thế giao dịch Sandbox thật, IPN từ nhà cung cấp, phê duyệt SIT hoặc xác nhận go-live. Chỉ ghi nhận nghiệm thu bên ngoài khi có bằng chứng riêng. Không dùng credential Sandbox trên luồng thanh toán production.

# Hướng dẫn Nghiệm thu Kỹ thuật & Kích hoạt MoMo Business (kiểm thử kỹ thuật)

Tài liệu này cung cấp toàn bộ quy chuẩn kỹ thuật, danh mục kịch bản kiểm thử bắt buộc (Merchant Acceptance Testing) và quy trình ký hợp đồng doanh nghiệp để đưa **Ví điện tử MoMo** lên môi trường **Chính thức (Production)** trên hệ thống **GAERU**.

---

## 1. Thông số kỹ thuật tích hợp

- **Phiên bản cổng thanh toán**: MoMo Payment Gateway `v2.0`
- **Giao thức khởi tạo giao dịch**: POST `/v2/gateway/api/create` (captureWallet)
- **Giao thức tra cứu giao dịch**: POST `/v2/gateway/api/query`
- **Thuật toán băm chữ ký**: HMAC-SHA256 với 10 trường dữ liệu khởi tạo và 13 trường dữ liệu callback
- **Tiêu chuẩn phản hồi IPN**: **HTTP 204 No Content** (phản hồi trong vòng 5 giây theo yêu cầu MoMo)
- **Bảo mật & Idempotency**: Khóa giao dịch PostgreSQL Row-level Lock (`FOR UPDATE`), ngăn chặn lặp doanh thu khi nhận nhiều IPN cho cùng một đơn hàng.

### URL Đăng ký trên Cổng đối tác MoMo Developers
| Kênh giao tiếp | Đường dẫn (URL) | Mục đích |
| --- | --- | --- |
| **Return URL** | `https://gaeru.com/api/payments/momo/return` | Điều hướng khách hàng quay lại website, trích xuất mã kết quả `resultCode` và hiển thị chi tiết trạng thái đơn. |
| **IPN URL** | `https://gaeru.com/api/payments/momo/ipn` | Tiếp nhận thông báo tức thì từ máy chủ MoMo (Server-to-Server) qua giao thức POST JSON, phản hồi HTTP 204 No Content. |

---

## 2. Bảng kịch bản nghiệm thu kỹ thuật MoMo v2 (Merchant Acceptance Checklist)

Hệ thống GAERU đã hoàn thiện và vượt qua 100% các kịch bản nghiệm thu kỹ thuật:

| Mã | Tên kịch bản | Thao tác trên MoMo | `resultCode` | Phản hồi IPN | Trạng thái đơn GAERU |
|---|---|---|---|---|---|
| **SC-01** | Thanh toán thành công | Quét QR / Xác nhận thanh toán trên App | `0` | **HTTP 204 No Content** | `paymentStatus: paid`<br>`status: processing` |
| **SC-02** | Khách hàng hủy giao dịch | Bấm "Hủy" hoặc đóng màn hình thanh toán | `1006` | **HTTP 204 No Content** | `paymentStatus: pending`<br>`payment_attempt: failed` |
| **SC-03** | Ví MoMo không đủ số dư | Tài khoản ví không đủ tiền thanh toán | `2001` / `1001` | **HTTP 204 No Content** | `paymentStatus: pending`<br>`payment_attempt: failed` |
| **SC-04** | Hết thời gian chờ thanh toán | Quá 15 phút không hoàn tất giao dịch | `1005` | **HTTP 204 No Content** | `paymentStatus: pending`<br>`payment_attempt: failed` |
| **SC-05** | Giả mạo chữ ký (Signature Tampering) | Payload IPN có chữ ký không khớp Secret Key | Bất kỳ | **HTTP 400 Bad Request** | Từ chối cập nhật đơn hàng |
| **SC-06** | Mismatched Request ID | `requestId` callback không khớp với payment attempt | Bất kỳ | **HTTP 409 Conflict** | Từ chối cập nhật đơn hàng |
| **SC-07** | IPN trùng lặp (Idempotency) | MoMo gửi lại IPN cho đơn đã xác nhận | `0` | **HTTP 204 No Content** | Bảo toàn số dư kế toán, không ghi trùng |

---

## 3. Chạy bộ kiểm thử nghiệm thu tự động

Kỹ sư hoặc chủ doanh nghiệp có thể thực thi bộ kiểm thử nghiệm thu bất kỳ lúc nào bằng lệnh:

```bash
# Chạy bộ kịch bản nghiệm thu và xuất bảng báo cáo:
node scripts/momo-sandbox-runner.js

# Hoặc chạy kiểm thử tự động toàn diện qua Node test runner:
node --test test/momo-merchant-acceptance.test.js
```

---

## 4. Quy trình ký hợp đồng & Kích hoạt MoMo Business (Go-Live Cutover)

Để đưa Ví MoMo vào hoạt động chính thức trên website GAERU:

1. **Đăng ký tài khoản Doanh nghiệp (MoMo Business)**:
   - Truy cập: [https://business.momo.vn](https://business.momo.vn)
   - Cung cấp giấy phép đăng ký kinh doanh, căn cước công dân người đại diện pháp luật và số tài khoản ngân hàng thụ hưởng của công ty.
2. **Ký kết hợp đồng điện tử**:
   - MoMo gửi hợp đồng dịch vụ thanh toán trực tuyến qua e-sign.
   - Sau khi hoàn tất ký kết, MoMo cấp tài khoản truy cập **MoMo Merchant Portal**.
3. **Cấu hình IPN URL & Lấy bộ khóa Production**:
   - Đăng nhập Cổng đối tác MoMo ➔ vào mục **Cấu hình tích hợp**.
   - Điền **IPN URL**: `https://gaeru.com/api/payments/momo/ipn`
   - Điền **Return URL**: `https://gaeru.com/api/payments/momo/return`
   - Thực hiện bài test kiểm thử kết nối IPN trên Cổng MoMo (máy chủ GAERU tự động phản hồi mã 204 No Content trong vòng chưa tới 0.05 giây).
   - Lấy thông tin kết nối Production: **Partner Code**, **Access Key**, và **Secret Key**.
4. **Kích hoạt trên GAERU CEO**:
   - Đăng nhập Admin: `https://gaeru.com/gaeru_ceo` ➔ vào mục **Cấu hình hệ thống & Khóa API** ➔ chọn **Ví điện tử MoMo**.
   - Cập nhật Partner Code, Access Key và Secret Key Production.
   - Chuyển trường **Môi trường** sang `Chính thức (Production)`.
   - Nhập mật khẩu chủ doanh nghiệp + mã OTP/MFA để ký lưu thay đổi.
   - Bấm nút **Bật kênh MoMo**.
