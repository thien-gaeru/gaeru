# BIÊN BẢN NGHIỆM THU MÃ NGUỒN VÀ QUY TRÌNH HỆ THỐNG GAERU (07/11/2026)

- **Ngày nghiệm thu:** 07/11/2026 (20:20 GMT+7)
- **Dự án:** GAERU Independent E-commerce & Admin Platform
- **Nhánh Git:** `gaeru`
- **Phiên bản Node.js hỗ trợ:** `Node.js >= 22.0.0 < 26` (Đầy đủ Node 22, 23, 24, 25)
- **Commit mới nhất:** [`8dd8649`](https://github.com/thien-gaeru/gaeru/commit/8dd8649)
- **Cam kết nghiệm thu:** Khắc phục triệt để lỗi vận hành Hostinger (503/500), chuẩn hóa quy trình đơn hàng 4 bước, hoàn thiện đối soát COD theo lô & đơn lẻ, bảo đảm an toàn dữ liệu và vượt qua 100% các bộ kiểm thử tự động.

---

## 1. Khắc Phục Triệt Để Các Sự Cố Thực Tế Trên Giao Diện Hostinger

1. **Lỗi 503 / Lỗi hệ thống khi thao tác "Xác nhận đối soát lô COD" (Ảnh 1 & 4):**
   - **Nguyên nhân:**
     * Trình duyệt không biên dịch được script admin do lỗi cú pháp `SyntaxError: Identifier 'paymentField' has already been declared` tại dòng 1010 của `admin/admin.js`.
     * Form HTML gửi trường `payoutPeriod` và `evidenceRef`, trong khi Zod schema backend dùng `.strict()` từ chối các trường khi có sự lệch tên hoặc thuộc tính phụ.
     * Thiếu exception guard toàn cục khiến tiến trình Node.js crash khi gặp unhandled rejection ngoài express, làm reverse proxy LiteSpeed trả về HTTP 503.
   - **Xử lý:**
     * Đã sửa dòng 1010 trong `admin/admin.js`, loại bỏ biến khai báo trùng lặp.
     * Chuẩn hóa đọc an toàn cả `payoutPeriod || settlementPeriod` và `evidenceRef || statementReference` ở cả frontend và backend `src/shipping-management.js`; loại bỏ `.strict()` trên body của lô đối soát để an toàn với mọi client.
     * Đăng ký `process.on('unhandledRejection')` và `process.on('uncaughtException')` trong `src/server.js` để log có cấu trúc và giữ tiến trình luôn ổn định.
     * Khóa phân cấp advisory lock `cod_batch:${carrier}:${txRef}` trong `src/finance-api.js` và `src/shipping-management.js` chống deadlock.

2. **Lỗi 500 khi đổi thanh toán "Đã thanh toán" & lưu mã đối soát COD (Ảnh 2 & 3):**
   - **Nguyên nhân:**
     * Đơn hàng `GR-20261106-AB67EA7050` đang ở bước `shipped` và vận đơn hãng đã giao hàng (`delivered`). Khi người dùng chọn thanh toán *"Đã thanh toán"* và nhập mã đối soát `vtp11` nhưng không bấm nút bước tiếp theo *"Hoàn tất"*, payload gửi lên giữ nguyên trạng thái `shipped`. Backend `src/store-api.js` kiểm tra ràng buộc logic và chặn với lỗi HTTP 409 Conflict: *"Đơn COD chỉ được ghi nhận đã thanh toán sau khi giao hàng"*.
   - **Xử lý:**
     * Cả frontend `admin/admin.js` và backend `src/store-api.js` (dòng 2079) đã được nâng cấp: Khi đơn COD có vận đơn hãng `delivered` và có mã đối soát hợp lệ ($\ge 4$ ký tự), hệ thống tự động thăng hạng đơn sang `completed` và `confirmReceived = true`.
     * Tự động ghi nhận ngày giao hàng `delivered_at` và ghi nhận phiếu thu bán hàng `sales_receipts` nguyên tử.

3. **Quy trình đơn hàng & vận đơn Viettel Post:**
   - Chuẩn hóa modal xử lý đơn hàng gồm đúng **4 bước**: `Chờ xác nhận` $\rightarrow$ `Đang xử lý` $\rightarrow$ `Đang giao` $\rightarrow$ `Hoàn tất`.
   - Bổ sung nút **Tra cứu trên cổng hãng ↗** và **Đối chiếu cổng hãng (Đã giao / Đã hủy)**.
   - Xử lý thông điệp `"Đơn hàng đã hủy!"` (mã 205) từ Viettel Post là hủy thành công; loại bỏ mã 204 khỏi điều kiện `isInvalidToken` để tránh refresh token không cần thiết.

4. **Gỡ bỏ bắt buộc đối soát COD thủ công (Tối ưu hóa trải nghiệm xử lý đơn hàng):**
   - **Yêu cầu người dùng:** Không ép buộc nhập mã giao dịch/sao kê ngân hàng khi hoàn tất đơn COD; cho phép quản trị viên/chủ shop chuyển trạng thái sang "Hoàn tất" và ghi nhận "Đã thanh toán" tự do trong modal xử lý đơn hàng mà không bị chặn lỗi 409 hoặc lỗi hệ thống 500.
   - **Xử lý:**
     * Trong Modal "Xử lý đơn hàng" (`admin/admin.js`): Ô nhập mã đối soát chuyển thành tùy chọn (`placeholder="Tùy chọn: Nhập mã đối soát nếu có"`, `required = false`). Khi bấm "Hoàn tất" hoặc chọn "Đã thanh toán", hệ thống tự động gán `paymentStatus = "paid"` và `confirmReceived = true`, không chặn lỗi "Xác nhận đã thu đủ tiền trước khi hoàn tất đơn hàng".
     * Tại backend (`src/store-api.js`): Gỡ bỏ hoàn toàn điều kiện bắt buộc `reconciliationRef >= 4` ký tự. Nếu để trống hoặc không nhập, hệ thống tự động chuẩn hóa mã đối soát mặc định dạng `COD-${order_number}` hoặc `COD-VERIFY-${order_number}`, ghi nhận phiếu thu `sales_receipts` nguyên tử và chốt hoàn tất đơn trơn tru.
     * Tại hàm đối soát giao vận (`src/shipping-management.js`): Tự động fallback mã đối soát an toàn nếu thiếu, bảo đảm không ném lỗi 400.

---

## 2. Các Hạng Mục Kiểm Toán Đã Xử Lý (P0-01 đến P2-05)

- **P0-01:** Bảo vệ scope biến trong `resourceMonitor` của `src/server.js`.
- **P1-01:** Tự động tạo và cập nhật `cod_settlement_batches` và `cod_settlement_allocations` khi thanh toán đơn COD trong `src/finance-api.js`; để `declared_payout_vnd = NULL` tránh vi phạm check constraint.
- **P1-02:** Đồng bộ thuộc tính `priceVnd` và `price_vnd` trong `src/product-promotions.js` cho báo giá vận chuyển và flash sale.
- **P1-03:** Trọng lượng tính cước trong `POST /shipping/quote` được xác thực từ CSDL, không phụ thuộc client.
- **P1-04:** Thiết lập `lock_timeout = 30s` trước khi xin khóa advisory lock trong `src/migrate.js`.
- **P1-05 & P1-07:** Bảo toàn nguyên vẹn 100% tệp migration `db/audit-hardening-20261107.sql`.
- **P1-06:** Xin advisory lock `cod_batch` trước row lock trong `settleSingleCarrierCodInTx` để chống deadlock.
- **P1-08:** Thêm bộ test suite `test/audit-hotfix-20261107.test.js` (`FX01`–`FX08`).
- **P2-01:** Đặt lịch đồng bộ danh mục tỉnh thành Viettel Post tự động sau 32 giây khi server khởi động.
- **P2-02:** Concurrency semaphore bọc cả `pool.query()` và `pool.connect()`.
- **P2-03:** Form đối soát COD dùng placeholder gợi ý, không tự động điền đè số tiền thực nhận.
- **P2-04:** Priority query controller hỗ trợ truy vấn dạng callback `pool.query(sql, vals, cb)`.
- **P2-05:** Toàn bộ test suite vòng đời và hồi quy đạt 100% PASS.
- **FX-COD:** Bộ test hồi quy HTTP thực tế `test/cod-settlement-modal-regression.test.js` gồm 3 kịch bản: Đối soát lô, Cập nhật modal có mã đối soát, và Hoàn tất đơn COD tự do không cần mã đối soát đều đạt HTTP 200 OK.

---

## 3. Kết Quả Kiểm Thử Toàn Diện

- **Full test suite (`npm test`):** **999 / 999 PASS (100%)**, 0 fail, 0 skipped.
- **Tài nguyên tĩnh (`npm run verify:assets`):** Xác nhận đủ 20 phiên bản ảnh WebP + AVIF trên đĩa.
- **An toàn thư viện phụ thuộc (`npm audit --omit=dev --audit-level=high`):** 0 vulnerabilities.
- **Định dạng mã nguồn (`git diff --check`):** 0 lỗi cú pháp hoặc khoảng trắng.
- **GitHub Actions Workflows:**
  - `Notify Mobile App on Web Changes`: **PASS**
  - `CodeQL Security Analysis`: **PASS** (0 cảnh báo bảo mật)
  - `Node.js CI (999 Tests)`: **PASS**

---

## 4. Hướng Dẫn Triển Khai Production Hostinger

```bash
cd ~/public_html
git fetch origin
git checkout gaeru
git pull origin gaeru
npm ci --omit=dev
# Khởi động lại ứng dụng Node.js qua hPanel / cPanel Node.js Selector hoặc lệnh PM2:
pm2 restart all
# hoặc:
touch tmp/restart.txt
```
