# Hướng Dẫn Tích Hợp & Vận Hành Phân Hệ Vận Chuyển GAERU (Shipping Carriers Integration Guide)

Tài liệu kỹ thuật và hướng dẫn vận hành cho 5 đối tác vận chuyển chính thức: **J&T Express, Viettel Post, Giao Hàng Nhanh (GHN), Giao Hàng Tiết Kiệm (GHTK) và Shopee Express (SPX)**.

---

## 1. Tổng quan Kiến trúc Vận chuyển (Architecture Overview)

Phân hệ vận chuyển của GAERU được thiết kế theo mô hình Adapter đa hãng độc lập (Unified Carrier Adapter Architecture), đảm bảo:
- **Idempotency tuyệt đối (Row-level Lock):** Chống tạo 2 vận đơn cho cùng một đơn hàng; kiểm tra trạng thái đơn trước khi tạo/hủy.
- **Đồng bộ tự động 2 chiều:** Nhận Webhook biến động lộ trình từ hãng và cung cấp worker chủ động tra cứu hành trình (`sync-tracking`).
- **Tự động chuyển trạng thái đơn & Quyết toán COD:** 
  - Trạng thái `delivering` ➔ Chuyển đơn sang `shipped` (Đang giao).
  - Trạng thái `delivered` ➔ Chuyển đơn sang `completed` (Hoàn tất).
  - Nếu đơn hàng thanh toán COD, tự động chuyển `payment_status = 'paid'` và kích hoạt hook kế toán `recordFullOrderPayment`.
- **Báo giá cước Realtime & Fallback có kiểm soát:** Quoting API với bộ nhớ đệm RAM LRU Cache (5 phút TTL); nếu API hãng gặp sự cố hoặc timeout, hệ thống tự động fallback mượt mà về bảng phí tỉnh/thành niêm yết trong cơ sở dữ liệu (`shipping_rates`), không làm gián đoạn trải nghiệm checkout của khách.
- **In nhãn vận đơn hãng (Carrier Label):** Hỗ trợ xuất và in trực tiếp nhãn vận đơn chính thức của hãng (A6/PDF) song song với tem nội bộ GAERU.

---

## 2. Danh sách Đối tác Vận chuyển & Thông số Kết nối

| Hãng vận chuyển | Mã hãng (`carrier_id`) | Cổng API chính thức | Thông số cấu hình bắt buộc |
| :--- | :--- | :--- | :--- |
| **J&T Express** | `jt` | `https://open.jtexpress.vn` | `accountId` (Mã KH / Customer Code), `secret` (Private Key / Secret), `pickupName`, `pickupPhone`, `pickupAddress` |
| **Viettel Post** | `viettel` | `https://partner.viettelpost.vn/v2` | `secret` (API Token Partner), `pickupName`, `pickupPhone`, `pickupAddress` |
| **GHN Express** | `ghn` | `https://online-gateway.ghn.vn/shiip/public-api/v2` | `accountId` (Shop ID GHN), `secret` (API Token), `pickupName`, `pickupPhone`, `pickupAddress` |
| **GHTK** | `ghtk` | `https://services.giaohangtietkiem.vn` | `secret` (API Token GHTK), `partnerCode` (Mã đối tác nếu có), `pickupName`, `pickupPhone`, `pickupAddress` |
| **Shopee Express** | `spx` | `https://spx.vn/api/v2` | `accountId` (Shop ID / Merchant ID), `secret` (SPX Token), `pickupName`, `pickupPhone`, `pickupAddress` |

---

## 3. Quy trình Vận hành & API Endpoints

### 3.1. Tạo Vận đơn Thật (Create Waybill)
- **Endpoint Admin:** `POST /api/gaeru_ceo/shipping/orders/:id/create-waybill`
- **Quyền:** `orders.write` + CSRF Token
- **Payload (JSON):**
  ```json
  {
    "carrierId": "jt", // Tùy chọn (mặc định lấy theo hãng khách chọn lúc checkout)
    "autoShip": false  // true nếu muốn chuyển trạng thái đơn sang 'shipped' ngay lập tức
  }
  ```
- **Xử lý Idempotency:**
  - Khóa hàng với `SELECT ... FOR UPDATE`.
  - Nếu đã có bản ghi trong bảng `carrier_shipments` với trạng thái khác `cancelled`, API trả về ngay thông tin vận đơn hiện tại mà không gọi lặp lại API của hãng.
- **Phản hồi mẫu:**
  ```json
  {
    "success": true,
    "existing": false,
    "message": "Đã tạo vận đơn J&T Express thành công: 840012345678",
    "shipment": {
      "trackingNumber": "840012345678",
      "carrierId": "jt",
      "carrierName": "J&T Express",
      "status": "created",
      "shippingFeeVnd": 25000,
      "codAmountVnd": 275000,
      "labelUrl": "https://open.jtexpress.vn/api/order/print?billcode=840012345678"
    }
  }
  ```

### 3.2. Hủy Vận đơn Hãng (Cancel Waybill)
- **Endpoint Admin:** `POST /api/gaeru_ceo/shipping/orders/:id/cancel-waybill`
- **Quyền:** `orders.write` + CSRF Token
- **Payload (JSON):**
  ```json
  {
    "reason": "Khách hàng đổi địa chỉ nhận hàng"
  }
  ```
- **Hành vi:** Gửi yêu cầu hủy sang API của hãng, chuyển trạng thái trong `carrier_shipments` thành `cancelled`, ghi nhận nhật ký kiểm toán `appendAudit`.

### 3.3. In Nhãn Vận đơn Hãng (Print Carrier Label)
- **Endpoint Admin:** `GET /api/gaeru_ceo/orders/:id/carrier-label`
- **Quyền:** `orders.read`
- **Hành vi:** Chuyển hướng (HTTP 302 Redirect) trực tiếp đến trang in nhãn tem A6/A5 chính thức của hãng vận chuyển.

### 3.4. Đồng bộ Hành trình Thủ công (Sync Tracking)
- **Endpoint Admin:** `POST /api/gaeru_ceo/shipping/orders/:id/sync-tracking`
- **Quyền:** `orders.read` + CSRF Token
- **Hành vi:** Gọi API tra cứu lộ trình của hãng, cập nhật `tracking_history`, chuyển trạng thái đơn hàng nếu hãng báo đã giao.

### 3.5. Webhook Hành trình Tự động (Carrier Webhooks)
- **Endpoint Public:** `POST /api/shipping/:carrier/webhook` (ví dụ: `/api/shipping/jt/webhook`, `/api/shipping/viettel/webhook`, `/api/shipping/ghn/webhook`, `/api/shipping/ghtk/webhook`, `/api/shipping/spx/webhook`)
- **Đặc điểm:** Tự động trích xuất mã vận đơn, chuẩn hóa trạng thái về `picking`, `delivering`, `delivered`, `returned`, `cancelled`, và ghi sổ doanh thu tự động khi khách nhận hàng COD.

### 3.6. Báo giá Cước Realtime & Fallback
- **Endpoint Public:** `POST /api/shipping/quote`
- **Payload (JSON):**
  ```json
  {
    "carrierId": "jt",
    "city": "Hà Nội",
    "district": "Nam Từ Liêm",
    "address": "Đại Mỗ",
    "weightGrams": 500,
    "totalVnd": 350000
  }
  ```
- **Phản hồi:**
  - Nếu kết nối carrier thành công: `{ "feeVnd": 25000, "carrierId": "jt", "carrierName": "J&T Express", "source": "carrier_realtime" }`
  - Nếu carrier timeout / lỗi: `{ "feeVnd": 20000, "carrierId": "jt", "carrierName": "J&T Express", "source": "fallback_rate_table", "warning": "Hãng vận chuyển phản hồi chậm, áp dụng bảng phí niêm yết theo tỉnh/thành." }`

---

## 4. Kiểm thử Chấp nhận Kỹ thuật (Acceptance Testing)

Toàn bộ các kịch bản kiểm thử đã được tích hợp trong file `test/shipping-carriers-acceptance.test.js`:
- `SC-SH-01`: Xác thực kết nối J&T Express (`verifyCarrier` và HMAC-MD5 signature).
- `SC-SH-02`: Tạo vận đơn thật qua API hãng và kiểm tra Idempotency chống lặp vận đơn.
- `SC-SH-03`: Webhook đồng bộ lộ trình, tự động chuyển đơn sang `shipped` và `completed`, tự động thu tiền COD.
- `SC-SH-04`: Hủy vận đơn hãng và chuyển hướng in nhãn vận đơn A6.
- `SC-SH-05`: Báo giá cước thời gian thực kèm LRU Cache và Fallback bảng phí tỉnh/thành.

Chạy kiểm thử:
```bash
node --test test/shipping-carriers-acceptance.test.js
```
Kết quả: **100% PASS (5/5 tests)**.
