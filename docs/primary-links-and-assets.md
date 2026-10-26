# Quy ước liên kết và ảnh GAERU

Miền công khai chính: `https://gaeru.com`. Liên kết nội bộ trong HTML và phần JavaScript bổ sung dùng đường dẫn gốc như `/cua-hang`, `/san-pham/gaeru-k9`, `/dang-ky-bao-hanh`. Canonical, Open Graph, Twitter và sitemap dùng URL tuyệt đối của miền chính. Query và fragment phục vụ giỏ hàng, xác thực và chiến dịch được giữ nguyên.

Các liên kết tuyệt đối thuộc `gaeru.org`, `www.gaeru.org`, `www.gaeru.com` hoặc HTTP được chuẩn hóa khi dựng HTML và khi thêm phần tử mới trên trình duyệt. Miền ngoài, mailto và tel được giữ nguyên. Miền phụ chuyển hướng các lượt đọc trang công khai; API, callback thanh toán và phiên quản trị cũ tiếp tục hoạt động để không làm hỏng các yêu cầu đang chạy. Không thay đổi cấu hình DNS trong bản này.

## URL ảnh và nơi lưu

Giữ URL tương thích, thống nhất nơi đọc dữ liệu:

- `/api/catalog-images/:id`, `/api/news-images/:id`, API banner/video/chat: đọc tham chiếu có kiểm tra kích thước và SHA-256 trong MEDIA_ROOT. Quyền xuất bản và quyền truy cập riêng tư vẫn áp dụng.
- `/media/products/:filename`: bí danh tương thích của ảnh sản phẩm đã xuất bản; không phải static mount cho toàn bộ MEDIA_ROOT.
- `/assets/brand/...` và `/assets/products/...`: ảnh đóng gói được sao chép nguyên byte khi khởi động vào `MEDIA_ROOT/site-assets/<sha256>.<ext>`, kiểm tra lại dữ liệu rồi ghi ánh xạ URL cũ vào bảng PostgreSQL `site_asset_snapshots`. Request ảnh đọc bản lưu này; không phụ thuộc file nằm trong hbuilds/public_html.

Ảnh tĩnh mới trong các thư mục nguồn assets được đồng bộ khi triển khai tiếp theo. Khi thay ảnh cùng URL, ánh xạ đổi sang snapshot mới; bản cũ được giữ lại. Khi ảnh biến mất khỏi gói deploy, ánh xạ và tệp cũ vẫn còn. Không có tác vụ xóa tự động. Khi đã cấu hình MEDIA_ROOT, ảnh chưa được đăng ký trả 404; bản đã đăng ký bị thiếu trả lỗi, không âm thầm đọc bản deploy hoặc Neon khác.

Nếu MEDIA_ROOT chưa cấu hình, chế độ cũ/cục bộ vẫn phục vụ assets trong gói nguồn. Mã JavaScript, CSS, dữ liệu hành chính và font tiếp tục là tài nguyên của bản triển khai, không phải media do người dùng tải lên. SVG mã nguồn không nằm trong nhóm snapshot raster của bản này.

URL ảnh có tên gắn mã nội dung được cache dài hạn; URL có thể thay đổi nội dung dùng ETag SHA-256 và cache một giờ, cần kiểm tra lại. Bộ nhớ đệm phía máy chủ có giới hạn. Sao chép và phục vụ ảnh không chuyển mã, cắt ảnh hay thay đổi chi tiết ảnh gốc.

Trong Thư viện tệp, nhóm **Ảnh giao diện (chỉ đọc)** hiển thị các snapshot, cho xem và tải xuống. Tên hiển thị dùng đường dẫn assets gốc cho bản còn ánh xạ. Các bản cũ không bị ghi đè. Cần sao lưu cả MEDIA_ROOT và cơ sở dữ liệu chứa ánh xạ.

## Kiểm tra

`test/persistent-assets.test.js` xác minh giữ nguyên byte, ảnh vẫn mở sau khi bỏ nguồn deploy, cập nhật ánh xạ không xóa snapshot cũ, ETag/304, chặn traversal/symlink, từ chối dữ liệu không toàn vẹn và API catalog/news vẫn đọc filesystem khi S3 không hoạt động.

`test/primary-link-audit.test.js` xác minh chuẩn hóa miền/đường dẫn ở href, action, src, srcset, poster, canonical/social; giữ query/fragment và miền ngoài; giá đầy đủ từ thấp đến cao; CTA đăng ký bảo hành đúng trang. Kiểm tra footer xác nhận tất cả sản phẩm xuất hiện mà không cần mở Xem thêm.
