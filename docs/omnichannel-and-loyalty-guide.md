# Hướng dẫn Vận hành Phân hệ Sàn TMĐT Đa Kênh (Omnichannel Marketplace) & GAERU Xu (Loyalty Program)

Tài liệu này hướng dẫn chi tiết quy trình kết nối, đồng bộ đơn hàng, đối soát tồn kho tự động và quản lý chương trình điểm thưởng GAERU Xu trên hệ thống GAERU Independent Store.

---

## 1. Phân hệ Sàn TMĐT Đa Kênh (Omnichannel Marketplace)

GAERU hỗ trợ kết nối trực tiếp với 3 sàn thương mại điện tử lớn nhất Việt Nam qua Open Platform APIs:
- **Shopee Open Platform v2**
- **TikTok Shop Open API (202309 / 2024)**
- **Lazada Open Platform (Lazada Partner)**

### 1.1 Shopee Open Platform v2 (End-to-End)
- **Tài liệu API:** [Shopee Open Platform API v2](https://open.shopee.com/)
- **Cấu hình (`store_settings` qua `admin-configuration`):**
  - `partnerId`: ID đối tác nhà phát triển Shopee.
  - `shopId`: Mã gian hàng chính thức của GAERU trên Shopee.
  - `secret`: Partner Key bí mật dùng để ký HMAC-SHA256.
- **Cơ chế chữ ký HMAC:**
  - Base string: `${partnerId}${path}${timestamp}${accessToken}${shopId}`
  - Signature: `HMAC_SHA256(baseStr, partnerKey)`
- **Các luồng nghiệp vụ:**
  1. **OAuth Flow:** Sinh URL ủy quyền `shopeeConnector.getAuthUrl` ➔ Trao đổi Auth Code lấy Access Token & Refresh Token qua `shopeeConnector.exchangeToken`.
  2. **Order Sync:** Truy vấn danh sách đơn hàng qua `/api/v2/order/get_order_list`, chuẩn hóa dữ liệu về schema thống nhất của GAERU.
  3. **SKU Mapping:** Ánh xạ linh hoạt mã model_sku/item_sku của Shopee sang `variant_id` của GAERU qua bảng `marketplace_sku_mappings`, có fallback đối soát trực tiếp theo `product_variants.sku`.
  4. **Stock Sync:** Cập nhật tồn kho khả dụng lên Shopee qua `/api/v2/product/update_stock`.
  5. **Fulfillment:** Chuẩn bị hàng và tạo vận đơn hãng sàn qua `/api/v2/logistics/ship_order`.
  6. **Webhook Verification:** Xác minh chữ ký `shopeeConnector.verifyWebhookSignature` bằng `crypto.timingSafeEqual` chống giả mạo URL.

---

### 1.2 TikTok Shop Open API
- **Tài liệu API:** [TikTok Shop Partner Center](https://partner.tiktokshop.com/)
- **Cấu hình:**
  - `appKey`: Khóa ứng dụng TikTok Shop Developer.
  - `shopId`: Shop Cipher / Open ID của gian hàng.
  - `secret`: App Secret bí mật.
- **Các luồng nghiệp vụ:**
  1. **OAuth Flow:** Cấp phép qua `tiktokConnector.getAuthUrl` ➔ Lấy Access Token qua `/api/v2/token/get`.
  2. **Order Search:** Tìm kiếm và đồng bộ đơn hàng qua `/order/202309/orders/search` kèm chữ ký HMAC.
  3. **Stock Update:** Cập nhật số lượng khả dụng qua `/product/202309/products/{id}/stocks/update`.
  4. **Fulfillment:** Xác nhận giao kiện hàng qua `/fulfillment/202309/packages/{id}/ship`.
  5. **Webhook Verification:** Kiểm tra chữ ký webhook qua HMAC-SHA256 với `appSecret`.

---

### 1.3 Lazada Open Platform
- **Tài liệu API:** [Lazada Open Platform](https://open.lazada.com/)
- **Cấu hình:**
  - `appKey`: App Key của ứng dụng Lazada.
  - `sellerId`: Mã người bán gian hàng GAERU.
  - `secret`: App Secret.
- **Quy tắc ký HMAC:**
  - Sắp xếp tất cả tham số query theo thứ tự chữ cái (Alphabetical sort).
  - Ghép chuỗi: `${path}${key1}${val1}${key2}${val2}...`
  - Băm HMAC-SHA256 và chuyển thành ký tự in hoa (Uppercase Hex).
- **Các luồng nghiệp vụ:**
  1. **OAuth Flow:** Ủy quyền qua `lazadaConnector.getAuthUrl` ➔ Lấy token qua `/auth/token/create`.
  2. **Order Fetch:** Tải đơn hàng qua `/orders/get`.
  3. **Stock Update:** Cập nhật tồn kho bằng gói tin XML qua `/product/price_quantity/update`.
  4. **Fulfillment (Ready To Ship):** Kích hoạt vận chuyển qua `/order/package/rts`.
  5. **Webhook:** Tiếp nhận sự kiện trạng thái đơn và xác minh chữ ký chuẩn Lazada.

---

### 1.4 Cơ chế Hoàn tồn kho tự động (Idempotent Stock Ledger Reverse)
Một trong những rủi ro lớn nhất của bán hàng đa kênh là lệch tồn kho khi đơn hàng sàn bị hủy hoặc khách trả hàng:
1. **Khi đơn mới được xác nhận / giao (`confirmed`, `processing`, `shipped`):**
   - Hệ thống tự động trừ tồn kho thực tế trong `product_variants`.
   - Đánh dấu cờ `stock_deducted = true`.
   - Ghi nhận sự kiện vào `marketplace_sync_events` với `event_key` duy nhất (`marketplace-sale:...`).
2. **Khi đơn hàng bị hủy hoặc trả hàng (`cancelled`, `returned`):**
   - Hệ thống tự động hoàn trả số lượng về `product_variants`.
   - Đánh dấu cờ `stock_reversed = true`.
   - Ghi nhận sự kiện hoàn tồn vào `marketplace_sync_events` (`marketplace-reverse:...`).
   - Ghi vết kiểm toán đầy đủ trong `audit_logs` (`marketplace.stock_reverse`).
3. **Idempotency Chống Trùng Lặp:**
   - Dù webhook của sàn gửi lại nhiều lần hoặc admin bấm đồng bộ nhiều lần, các cờ `stock_deducted` và `stock_reversed` kết hợp với ràng buộc khóa duy nhất `UNIQUE (channel, shop_id, external_order_id)` và `UNIQUE (event_key)` đảm bảo tuyệt đối không bao giờ hoàn tồn kho 2 lần cho cùng 1 đơn hàng.

---

## 2. Phân hệ GAERU Xu (Loyalty Program)

### 2.1 Nguyên tắc vận hành
- **Tỷ lệ tích điểm:** 1% giá trị đơn hàng thanh toán thành công (1 Xu = 1 VND).
- **Hạn mức sử dụng:** Khách hàng được dùng Xu để trừ tiền trực tiếp khi mua hàng (tối đa 50% tổng giá trị sản phẩm trong đơn).
- **Bảo toàn tính toàn vẹn (Concurrency Safety):**
  - Mọi thao tác đọc và cập nhật số dư Xu đều sử dụng PostgreSQL Row-Level Lock: `SELECT ... FOR UPDATE` trên bảng `customer_loyalty`.
  - Chống race-condition khi khách mở nhiều tab hoặc bấm submit liên tục.

### 2.2 Phân hạng thành viên động (Tiers)
Dựa trên tổng số Xu tích lũy trọn đời (`lifetime_earned`):
- **Bronze (Đồng):** Dưới 100,000 Xu.
- **Silver (Bạc):** Từ 100,000 Xu đến dưới 500,000 Xu.
- **Gold (Vàng):** Từ 500,000 Xu đến dưới 2,000,000 Xu.
- **Platinum (Bạch Kim):** Từ 2,000,000 Xu trở lên.

### 2.3 Vòng đời điểm thưởng gắn với đơn hàng
1. **Tích điểm (`earnPoints`):** Tự động kích hoạt khi đơn hàng chuyển sang trạng thái `completed` và `paid`.
2. **Tiêu điểm (`redeemPoints`):** Khấu trừ Xu tại trang Checkout, giảm trực tiếp vào `total_vnd` và ghi nhận vào `discount_vnd`.
3. **Hoàn điểm khi hủy đơn (`refundPoints`):**
   - Nếu đơn hàng có dùng Xu: Tự động hoàn trả toàn bộ số Xu đã dùng về tài khoản khách hàng.
   - Nếu đơn hàng đã tích Xu (đơn hoàn tất trước đó bị trả hàng): Thu hồi số Xu đã cộng để tránh trục lợi.
4. **Điều chỉnh thủ công từ Admin (`adjustPoints`):** Cho phép CEO / CSKH cộng hoặc trừ Xu kèm lý do và ghi nhận audit log an toàn.

---

## 3. Danh sách Endpoints API

### 3.1 Omnichannel Marketplace Endpoints
| Phương thức | Đường dẫn | Phân quyền | Mục đích |
|---|---|---|---|
| `POST` | `/api/gaeru_ceo/marketplace/:channel/sync-orders` | `marketplace.write` | Kích hoạt đồng bộ đơn hàng từ sàn về |
| `POST` | `/api/gaeru_ceo/marketplace/:channel/sync-stock` | `marketplace.write` | Kích hoạt đẩy tồn kho lên sàn |
| `GET` | `/api/gaeru_ceo/marketplace/orders` | `marketplace.read` | Xem danh sách đơn sàn kèm trạng thái tồn kho |
| `POST` | `/api/gaeru_ceo/marketplace/orders/:id/reverse-stock` | `marketplace.write` | Hoàn tồn kho thủ công cho đơn sàn hủy/trả |
| `GET` | `/api/gaeru_ceo/marketplace/mappings` | `marketplace.read` | Xem danh sách SKU mapping giữa sàn và GAERU |
| `POST` | `/api/gaeru_ceo/marketplace/mappings` | `marketplace.write` | Tạo hoặc cập nhật SKU mapping |
| `POST` | `/api/marketplace/:channel/webhook` | Công khai | Tiếp nhận Webhook biến động đơn hàng từ sàn |

### 3.2 GAERU Xu (Loyalty) Endpoints
| Phương thức | Đường dẫn | Phân quyền | Mục đích |
|---|---|---|---|
| `GET` | `/api/customer/loyalty` | Customer Auth | Lấy số dư Xu, hạng thành viên và lịch sử sổ cái |
| `POST` | `/api/customer/loyalty/quote` | Customer Auth | Dự toán số Xu tối đa có thể tiêu cho đơn hàng |
| `GET` | `/api/gaeru_ceo/customers/:id/loyalty` | `customers.read` | Admin xem chi tiết Xu và sổ cái của khách hàng |
| `POST` | `/api/gaeru_ceo/customers/:id/loyalty/adjust` | `customers.write` | Admin cộng/trừ Xu kèm lý do bắt buộc |
