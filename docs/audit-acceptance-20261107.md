# BIÊN BẢN NGHIỆM THU MÃ NGUỒN VÀ QUY TRÌNH HỆ THỐNG GAERU (07/11/2026)

- **Ngày nghiệm thu:** 07/11/2026
- **Dự án:** GAERU Independent E-commerce & Admin Platform
- **Nhánh Git:** `gaeru`
- **Cam kết nghiệm thu:** Khắc phục triệt để lỗi vận hành Hostinger (503/500), chuẩn hóa quy trình đơn hàng 4 bước, hoàn thiện đối soát COD theo lô & đơn lẻ, bảo đảm an toàn dữ liệu và vượt qua 100% các bộ kiểm thử tự động.

---

## 1. Khắc Phục Các Sự Cố Thực Tế Trên Hostinger

1. **Lỗi 503 Service Unavailable khi thao tác "Đối soát COD theo lô":**
   - **Nguyên nhân:** Khối đo lường tài nguyên `resourceMonitor = setInterval(...)` định kỳ mỗi 60 giây trong `src/server.js` gọi các biến cục bộ ngoài scope của `buildFallbackPriorityController()`, làm tiến trình Node.js bị crash vì `ReferenceError`. Web server LiteSpeed của Hostinger lập tức ngắt kết nối và trả về 503.
   - **Xử lý:** Cung cấp phương thức `getStats()` chuẩn hóa cho cả controller chính và fallback; bọc toàn bộ khối thu thập metric trong `try / catch` bảo vệ tiến trình.

2. **Lỗi 500 khi bấm "Hoàn tất" & lưu mã đối soát:**
   - **Nguyên nhân:** Server restart gián đoạn do lỗi 503 và thiếu thứ tự khóa nhất quán giữa đối soát đơn lẻ và đối soát theo lô.
   - **Xử lý:** Trong `settleSingleCarrierCodInTx` (`src/shipping-management.js`), xin advisory lock `cod_batch:${carrier}:${txRef}` trước khi row-lock `orders FOR UPDATE` để triệt tiêu nguy cơ deadlock.

3. **Quy trình đơn hàng & vận đơn Viettel Post:**
   - Chuẩn hóa modal xử lý đơn hàng gồm đúng **4 bước**: `Chờ xác nhận` $\rightarrow$ `Đang xử lý` $\rightarrow$ `Đang giao` $\rightarrow$ `Hoàn tất`.
   - Bổ sung nút **Tra cứu trên cổng hãng ↗** và **Đối chiếu cổng hãng (Đã giao / Đã hủy)**.
   - Xử lý thông điệp `"Đơn hàng đã hủy!"` (mã 205) từ Viettel Post là hủy thành công; xử lý lỗi tra cứu 405 mà không làm gián đoạn giao diện.

---

## 2. Các Hạng Mục Kiểm Toán Đã Xử Lý (P0-01 đến P2-05)

- **P0-01:** Bảo vệ scope biến trong `resourceMonitor` của `src/server.js`.
- **P1-01:** Tự động tạo và cập nhật `cod_settlement_batches` và `cod_settlement_allocations` khi thanh toán đơn COD trong `src/finance-api.js`.
- **P1-02:** Đồng bộ thuộc tính `priceVnd` và `price_vnd` trong `src/product-promotions.js` cho báo giá vận chuyển và flash sale.
- **P1-03:** Trọng lượng tính cước trong `POST /shipping/quote` được xác thực từ CSDL, không phụ thuộc client.
- **P1-04:** Thiết lập `lock_timeout = 30s` trước khi xin khóa advisory lock trong `src/migrate.js`.
- **P1-05 & P1-07:** Bảo toàn nguyên vẹn 100% tệp migration `db/audit-hardening-20261107.sql`.
- **P1-06:** Xin advisory lock trước row lock trong `settleSingleCarrierCodInTx` để chống deadlock.
- **P1-08:** Thêm bộ test suite `test/audit-hotfix-20261107.test.js` (`FX01`–`FX08`).
- **P2-01:** Đặt lịch đồng bộ danh mục tỉnh thành Viettel Post tự động sau 32 giây khi server khởi động.
- **P2-02:** Concurrency semaphore bọc cả `pool.query()` và `pool.connect()`.
- **P2-03:** Form đối soát COD dùng placeholder gợi ý, không tự động điền đè số tiền thực nhận.
- **P2-04:** Priority query controller hỗ trợ truy vấn dạng callback `pool.query(sql, vals, cb)`.
- **P2-05:** Toàn bộ test suite vòng đời và hồi quy đạt 100% PASS.

---

## 3. Kết Quả Kiểm Thử Toàn Diện

- **Full test suite (`npm test`):** **995 / 995 PASS (100%)**, 0 fail, 0 skipped.
- **Tài nguyên tĩnh (`npm run verify:assets`):** Xác nhận đủ 20 phiên bản ảnh WebP + AVIF trên đĩa.
- **An toàn thư viện phụ thuộc (`npm audit --omit=dev --audit-level=high`):** 0 vulnerabilities.
- **Định dạng mã nguồn (`git diff --check`):** 0 lỗi khoảng trắng.
- **GitHub Actions Workflows:**
  - `Notify Mobile App on Web Changes`: **PASS**
  - `CodeQL Security Analysis`: **PASS** (0 cảnh báo bảo mật)
  - `Node.js CI (995 Tests)`: **PASS**

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
```
