# Kiểm tra thành phần website — 24/10/2026

Đã đối chiếu tất cả dependencies và devDependencies với bản ổn định latest trên npm. Các mức phiên bản tối thiểu trong package.json được cập nhật tương ứng; package-lock.json khóa chính xác bản triển khai.

Thay đổi phiên bản cài thực tế:
- dotenv: 16.6.1 → 18.0.9. Đã kiểm tra changelog: dự án dùng config()/parse(), không dùng preload hoặc .env.vault đã bị loại bỏ ở phiên bản 18.
- nodemailer: 10.2.0 → 10.2.1.
- on-finished (gián tiếp): 2.4.1 → 2.4.2.

Các thư viện trực tiếp còn lại đã ở bản latest tại thời điểm kiểm tra: bcryptjs 3.0.3, connect-pg-simple 10.0.0, express 5.3.0, express-rate-limit 8.7.1, express-session 1.19.0, helmet 8.3.0, multer 2.5.0, pg 8.23.1, qrcode 1.5.4, zod 4.6.7, @electric-sql/pglite 0.5.11 và jsqr 1.4.0. body-parser giữ bản 2.4.0 của đợt trước.

Đã cập nhật phụ thuộc gián tiếp trong phạm vi tương thích do thư viện cha khai báo. Một số thư viện cha cố định phiên bản hoặc major cũ; không ép overrides vượt hợp đồng phụ thuộc chỉ để xóa danh sách outdated --all. Kiểm tra npm audit không ghi nhận lỗ hổng đã công bố.

Node.js ghim 24.22.2, LTS mới nhất theo nodejs.org/dist/index.json. Nhánh Current 26.12.1 không được chuyển sang trong đợt này. Các workflow dùng ubuntu-latest được nâng actions/checkout 7.0.1 và actions/setup-node 7.1.0. Cấu hình Node ứng dụng vẫn theo .node-version.

Không tìm thấy thư viện JavaScript phía trình duyệt lấy từ CDN trong mã HTML/JS. Giao diện sử dụng mã nguồn nội bộ. Đợt này cập nhật phần mềm trong kho mã nguồn; không nâng phiên bản máy chủ PostgreSQL, hệ điều hành hay hạ tầng do nhà cung cấp quản lý.

Xác minh: cài sạch npm ci và chạy kiểm thử trên Node.js 24.22.2; email dùng giả lập, không gửi thư thật. Cần kiểm tra trạng thái triển khai và các tuyến HTTP sau khi đẩy mã.

Các workflow Pages hiện có cũng được nâng checkout 7.0.1, configure-pages 6.0.0, jekyll-build-pages 1.0.13, upload-pages-artifact 5.0.0 và deploy-pages 5.0.1 theo bản phát hành ổn định của từng dự án.
