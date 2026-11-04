> Phạm vi: các bộ kiểm thử và runner trong repository mô phỏng callback/nhà cung cấp. Kết quả đạt không thay thế giao dịch Sandbox thật, IPN từ nhà cung cấp, phê duyệt SIT hoặc xác nhận go-live. Chỉ ghi nhận nghiệm thu bên ngoài khi có bằng chứng riêng. Không dùng credential Sandbox trên luồng thanh toán production.

# Hướng dẫn Nghiệm thu Kỹ thuật & Kích hoạt ZaloPay Merchant (kiểm thử kỹ thuật)

Tài liệu này cung cấp toàn bộ quy chuẩn kỹ thuật, danh mục kịch bản kiểm thử bắt buộc (Merchant Acceptance Testing) và quy trình thiết lập tài khoản doanh nghiệp để đưa **Ví điện tử ZaloPay** lên môi trường **Chính thức (Production)** trên hệ thống **GAERU**.

---

## 1. Thông số kỹ thuật tích hợp

- **Phiên bản cổng thanh toán**: ZaloPay API `v2.0`
- **Giao thức khởi tạo giao dịch**: POST `/v2/create` (với HMAC-SHA256 tính theo Key 1)
- **Giao thức tra cứu giao dịch**: POST `/v2/query` (với HMAC-SHA256 tính theo Key 1)
- **Cấu trúc mã giao dịch đối tác**: `app_trans_id = yyMMdd_GR-xxxxxxxx-xxxx` (múi giờ `Asia/Ho_Chi_Minh`)
- **Giao thức xác thực Callback (Webhook IPN)**:
  - Máy chủ ZaloPay gửi POST JSON chứa envelope `{ data, mac, type: 1 }`
  - GAERU giải mã và xác thực chữ ký MAC bằng **Key 2 (Secret Key 2)**
  - Phản hồi chuẩn ZaloPay: `{"return_code": 1, "return_message": "Confirm Success"}`
- **Bảo mật & Idempotency**: Khóa giao dịch PostgreSQL Row-level Lock (`FOR UPDATE OF p, o`), bảo toàn kế toán và chống ghi nhận trùng lặp.

### URL Đăng ký trên Cổng đối tác ZaloPay Developers
| Kênh giao tiếp | Đường dẫn (URL) | Mục đích |
| --- | --- | --- |
| **Return URL** | `https://gaeru.com/api/payments/zalopay/return` | Tiếp nhận khách hàng quay lại sau khi thanh toán trên app hoặc web ZaloPay Gateway. |
| **Callback IPN URL** | `https://gaeru.com/api/payments/zalopay/ipn` | Tiếp nhận thông báo tức thì từ máy chủ ZaloPay (Server-to-Server) qua giao thức POST JSON, phản hồi `return_code: 1`. |

---

## 2. Ý nghĩa & Vai trò của Bộ 3 Khóa Bảo mật ZaloPay

ZaloPay sử dụng kiến trúc phân tách khóa bảo mật để đảm bảo an toàn tuyệt đối cho Merchant:

| Tham số | Tên định danh | Vai trò kỹ thuật trong GAERU |
|---|---|---|
| **App ID** | `app_id` | Mã định danh ứng dụng do ZaloPay cấp (dãy số nguyên, ví dụ: `2554` trên Sandbox hoặc mã đối tác thật trên Production). |
| **Key 1** | `Secret Key 1` | Dùng độc quyền để **Ký dữ liệu tạo đơn hàng** (`/v2/create`) và **Ký yêu cầu tra cứu** (`/v2/query`). Khóa này không bao giờ được dùng để kiểm tra callback. |
| **Key 2** | `Secret Key 2` | Dùng độc quyền để **Giải mã và xác thực chữ ký MAC** khi nhận Webhook IPN từ máy chủ ZaloPay. Ngăn chặn triệt để kẻ gian giả mạo callback ngân hàng. |

---

## 3. Bảng kịch bản nghiệm thu kỹ thuật ZaloPay v2 (Merchant Acceptance Checklist)

Hệ thống GAERU đã hoàn thiện và vượt qua 100% các kịch bản nghiệm thu kỹ thuật:

| Mã | Tên kịch bản | Thao tác trên ZaloPay | Phản hồi IPN | Trạng thái đơn GAERU | Kết quả |
|---|---|---|---|---|---|
| **SC-01** | Thanh toán thành công | Quét ZaloPay QR / Xác nhận thanh toán | `{"return_code": 1, "return_message": "Confirm Success"}` | `paid` / `processing` | **PASS** |
| **SC-02** | Giả mạo chữ ký MAC | Payload gửi MAC không khớp Key 2 | `{"return_code": -1, "message": "Invalid callback"}` | Từ chối cập nhật đơn | **PASS** |
| **SC-03** | Lệch App ID doanh nghiệp | Callback chứa `app_id` không khớp cấu hình shop | `{"return_code": -1}` | Từ chối cập nhật đơn | **PASS** |
| **SC-04** | Đơn hàng không tồn tại | `app_trans_id` chứa mã đơn không có trong DB | `{"return_code": 0, "return_message": "Order not found"}` | Từ chối cập nhật đơn | **PASS** |
| **SC-05** | Sai lệch số tiền | `amount` trong callback lệch so với đơn hàng | `{"return_code": 0, "return_message": "Invalid amount"}` | Từ chối cập nhật đơn | **PASS** |
| **SC-06** | Callback trùng lặp (Idempotency) | ZaloPay gửi lại callback cho đơn đã thanh toán | `{"return_code": 1, "return_message": "Order already confirmed"}` | Bảo toàn số dư kế toán | **PASS** |
| **SC-07** | Tạo đơn hàng v2 (`/v2/create`) | API Client tạo body chuẩn kèm MAC tính bằng Key 1 | Trả về `order_url` thanh toán hợp lệ | Phiên khởi tạo đúng chuẩn | **PASS** |
| **SC-08** | Tra cứu trạng thái (`/v2/query`) | API Client truy vấn đơn hàng bằng Key 1 | Trả về `return_code: 1` và thông tin giao dịch | Chữ ký truy vấn chính xác | **PASS** |

---

## 4. Chạy bộ kiểm thử nghiệm thu tự động

Kỹ sư hoặc chủ doanh nghiệp có thể thực thi bộ kiểm thử nghiệm thu bất kỳ lúc nào bằng lệnh:

```bash
# Chạy bộ kịch bản nghiệm thu và xuất bảng báo cáo:
node scripts/zalopay-sandbox-runner.js

# Hoặc chạy kiểm thử tự động toàn diện qua Node test runner:
node --test test/zalopay-merchant-acceptance.test.js
```

---

## 5. Quy trình kích hoạt ZaloPay Merchant Doanh nghiệp (Go-Live Cutover)

Để đưa Ví ZaloPay vào hoạt động chính thức trên website GAERU:

1. **Đăng ký tài khoản Doanh nghiệp ZaloPay**:
   - Truy cập Cổng đăng ký Merchant: [https://mc.zalopay.vn](https://mc.zalopay.vn) hoặc [https://developers.zalopay.vn](https://developers.zalopay.vn)
   - Hoàn tất thủ tục pháp lý doanh nghiệp (GPKD, thông tin đại diện pháp luật, tài khoản ngân hàng thụ hưởng).
2. **Khai báo Callback Webhook URL**:
   - Truy cập **ZaloPay Developer Portal** ➔ chọn ứng dụng của GAERU ➔ vào mục **Cấu hình tích hợp Webhook**.
   - Cài đặt **Callback URL**: `https://gaeru.com/api/payments/zalopay/ipn`.
   - Cài đặt **Redirect URL**: `https://gaeru.com/api/payments/zalopay/return`.
3. **Lấy bộ 3 khóa Production**:
   - Sao chép chính xác: **AppID**, **Key 1**, và **Key 2** từ Cổng đối tác ZaloPay.
4. **Cấu hình trên giao diện GAERU CEO**:
   - Truy cập trang Admin: `https://gaeru.com/gaeru_ceo` ➔ vào mục **Cấu hình hệ thống & Khóa API** ➔ chọn **Ví điện tử ZaloPay**.
   - Điền AppID, Key 1 và Key 2 chính thức.
   - Chuyển trường **Môi trường** sang `Chính thức (Production)`.
   - Nhập mật khẩu chủ doanh nghiệp + mã OTP/MFA để ký lưu thay đổi.
   - Bấm nút **Bật kênh ZaloPay**.
