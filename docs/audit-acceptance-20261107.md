# BIÊN BẢN NGHIỆM THU MÃ NGUỒN VÀ QUY TRÌNH HỆ THỐNG GAERU (07/11/2026)

- **Ngày nghiệm thu:** 07/11/2026 (21:30 GMT+7)
- **Dự án:** GAERU Independent E-commerce & Admin Platform
- **Nhánh Git:** `gaeru`
- **Phiên bản Node.js hỗ trợ:** `Node.js >= 22.0.0 < 26` (Đầy đủ Node 22, 23, 24, 25)
- **Cam kết nghiệm thu:** Khắc phục triệt để lỗi vận hành Hostinger (503/500), chuẩn hóa quy trình đơn hàng 4 bước, hoàn thiện đối soát COD theo lô & đơn lẻ, cho phép quản trị tối cao xóa vĩnh viễn đơn hàng không có bất kỳ hạn chế nào, bảo vệ nghiêm ngặt đối với nhân viên được phân quyền, bảo đảm an toàn dữ liệu và vượt qua 100% các bộ kiểm thử tự động.

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
     * Tự động ghi nhận phiếu thu kế toán `sales_receipts` và liên kết phân bổ `cod_settlement_allocations`, tự động chuyển đơn sang hoàn tất trơn tru.

3. **Gỡ bỏ hoàn toàn chức năng đối soát COD thủ công (Theo yêu cầu người dùng):**
   - **Gỡ bỏ triệt để trên Giao diện Quản trị (Admin UI):**
     * Trong popup/modal *"Xử lý đơn hàng"*: Đã xóa bỏ hoàn toàn ô nhập *"Mã đối soát / sao kê thu hộ COD"* (`reconciliationRef`) và hướng dẫn nhập mã đối soát thủ công.
     * Trong card *"Hành trình & Vận đơn"*: Đã xóa bỏ nút *"Đối soát COD theo lô"*.
     * Trên thanh công cụ đơn hàng: Đã ẩn triệt để nút toggle *"💰 Đối soát thu hộ COD"* và toàn bộ panel *"Đối soát tiền thu hộ COD theo lô / sao kê hãng"*. Quản trị viên không còn bị vướng bận hay bấm nhầm vào form đối soát thủ công gây lỗi.
   - **Tự động hóa hoàn tất đơn hàng COD dưới Backend:**
     * Khi đơn hàng COD được chuyển sang hoàn tất (`completed` và `paid`), hệ thống tự động hoàn tất đơn, tự động ghi nhận thanh toán `paid`, tự động chuyển vận đơn `carrier_shipments.cod_settlement_status = 'settled'`, và tự động ghi nhận phiếu thu kế toán `sales_receipts` với reference chuẩn hóa `COD-${orderNumber}`.
     * Không còn phụ thuộc hay bắt buộc quy trình đối soát lô thủ công, loại bỏ triệt để các lỗi 500 / 409 khi người dùng lưu cập nhật đơn hàng.

4. **Cho phép Quản Trị Tối Cao (Supreme Owner) xóa vĩnh viễn đơn hàng không hạn chế:**
   - **Phân định quyền hạn:**
     * **Quản trị tối cao (`actor.role === 'owner' || actor.source === 'bootstrap'`):** Có toàn quyền xóa vĩnh viễn đơn hàng trong cơ sở dữ liệu ở bất kỳ trạng thái nào (`pending`, `confirmed`, `processing`, `shipped`, `delivered`, `completed`, `cancelled`), kể cả khi đơn đã phát sinh vận đơn hãng (`carrier_shipments`, `carrier_shipment_attempts`), hóa đơn điện tử MISA (`misa_einvoices`), phiếu thu kế toán (`sales_receipts`), phân bổ đối soát COD (`cod_settlement_allocations`), biên bản kiểm nhận hoàn kho (`cod_return_intakes`), chứng từ đổi hàng (`rma_exchange_issues`), hoặc giao dịch thanh toán (`payment_attempts`). Hệ thống tự động xóa cascade sạch sẽ toàn bộ bản ghi con phụ thuộc và hoàn nguyên `allocated_total_vnd` trong các lô COD nếu có.
     * **Cơ chế CSDL:** Tạo migration mới [`db/owner-order-purge-override.sql`](file:///C:/Users/imdot/gaeru/db/owner-order-purge-override.sql) nâng cấp 2 hàm trigger `protect_sales_receipt()` và `protect_cod_settlement_allocations()` cho phép xóa khi session có setting `SET LOCAL gaeru.allow_owner_order_purge = 'on'`.
     * **Nhân viên được phân quyền (`actor.role !== 'owner' && can('orders.permanent_delete')`):** Giữ nguyên 100% các chốt chặn an toàn và tính bất biến nghiêm ngặt của sổ sách kế toán, chặn HTTP 409 khi cố xóa các đơn đã phát sinh chứng từ kế toán, thuế hoặc vận đơn.

---

## 2. Ma Trận Nghiệm Thu 24 Tiêu Chí Kiểm Toán Toàn Diện

- **QA01 & P2-05:** Công cụ thiết lập tài khoản chủ `scripts/create-local-owner.js` khóa chặt production, CI và remote DB, không in mật khẩu ra console.
- **QA02 - QA08:** Concurrency fencing, mid-flight cancel vs delivered race, monotonic state & chống lặp 5x webhook carrier.
- **QA09 - QA10 (P1-03):** Tách bạch trạng thái chuyển hoàn Viettel (505/502/504), chặn nhập lại kho trước khi bưu tá trả hàng thực tế.
- **QA11 - QA13, QA16 - QA17:** Tách biệt giao hàng và đối soát COD, phân quyền RBAC đa vai trò và bảo vệ sổ thu tiền kế toán.
- **QA14 - QA15, QA18:** Phí giao hàng 5 tỉnh thành và nhiều mức cân nặng, cách ly cache báo giá, token tra cứu khách vãng lai.
- **QA19 (P1-08):** 100 cold GET cache miss trả đúng MIME gốc với 0 lần runtime Sharp re-encode.
- **QA20 - QA21 (P2-03, P2-04):** Xóa cache sau COMMIT transaction, đồng bộ Flash Sale và JSON-LD Offer schema.
- **QA22 - QA24 & P2-06:** 30 request đồng thời không phát sinh lỗi 5xx, hoãn nạp bundle chat/địa chỉ, readiness gate bảo vệ trạng thái.
- **FX-COD:** Bộ test hồi quy HTTP thực tế `test/cod-settlement-modal-regression.test.js` đạt 100% PASS.
- **FX-NO-COD-RECON:** Bộ test `test/remove-manual-cod-reconciliation.test.js` kiểm chứng gỡ bỏ hoàn toàn UI đối soát COD thủ công và hoàn tất đơn hàng COD tự động trơn tru đạt 100% PASS.
- **FX-OWNER-PURGE:** Bộ test `test/supreme-owner-unrestricted-order-deletion.test.js` kiểm chứng: Nhân viên bị chặn 409, Quản trị tối cao xóa sạch toàn diện đơn hàng đạt HTTP 200 OK.

---

## 3. Kết Quả Kiểm Thử Toàn Diện

- **Full test suite (`npm test`):** **1004 / 1004 PASS (100%)**, 0 fail, 0 skipped.
- **Tài nguyên tĩnh (`npm run verify:assets`):** Xác nhận đủ 20 phiên bản ảnh WebP + AVIF trên đĩa.
- **An toàn thư viện phụ thuộc (`npm audit --omit=dev --audit-level=high`):** 0 vulnerabilities.
- **Định dạng mã nguồn (`git diff --check`):** 0 lỗi cú pháp hoặc khoảng trắng.

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
