# URL sạch, quản lý trang và rà soát SEO

## Đường dẫn
- Sản phẩm: `/san-pham/:slug`
- Tin tức: `/tin-tuc`; bài viết: `/tin-tuc/:slug`
- Cửa hàng: `/cua-hang`
- Khám phá: `/kham-pha/gaeru-k9` (tương tự M3, P01, G1 ULTRA)
- Hướng dẫn: `/huong-dan`, `/huong-dan/gaeru-k9`
- Tài khoản: `/tai-khoan`; giỏ: `/gio-hang`; thanh toán: `/thanh-toan`
- Chính sách: `/chinh-sach/...`; sơ đồ: `/so-do-trang-web`

URL HTML/query cũ chuyển hướng 301, giữ tham số thanh toán, chiến dịch và phân trang. URL API và khu vực quản trị được giữ nguyên. Canonical và sitemap dùng URL sạch. Thẻ base giữ tài nguyên tương đối hoạt động; liên kết trong trang được chuẩn hóa về đúng trang hiện tại.

## Quản lý trang
Trong quản trị, mở **Quản lý trang**. Quyền xem: `settings.read`; lưu: `settings.write`, kèm CSRF và nhật ký. Trang mới có đường dẫn `/trang/ten-trang`, xem trước tại trình soạn, bản nháp, xuất bản và lưu trữ. Bản nháp/trang lưu trữ không công khai và không vào sitemap. Kiểm tra phiên bản ngăn ghi đè thay đổi đồng thời.

Trang hệ thống cho phép chỉnh tiêu đề và mô tả SEO. Nội dung nghiệp vụ mua hàng và các khối sản phẩm/tin tức được bảo vệ, chỉnh trong chức năng riêng. Nội dung trang mới là văn bản an toàn với tiêu đề phụ `##`, không thực thi HTML hoặc JavaScript.

## SEO và tải trang
SSR đã có trước thay đổi này: trang chủ, cửa hàng, sản phẩm, danh sách tin và bài viết trả nội dung trong HTML. Product, NewsArticle, ItemList, robots.txt và sitemap lastmod cũng đã có. Bổ sung metadata đồng bộ cho trang tĩnh; Organization, BreadcrumbList và FAQPage lấy từ câu hỏi/đáp đang hiển thị. Không tạo đánh giá hoặc thông số giả.

Dữ liệu sản phẩm công khai được nhúng JSON an toàn vào HTML để khởi tạo tương tác không phải chờ thêm API sản phẩm. Audio/video K9 đã có `preload="none"`; hero K9 đã có `fetchpriority="high"`, nay bổ sung kích thước để giữ chỗ. Ảnh G1 do người dùng cung cấp được giữ nguyên WebP 82.064 byte, xuất ra đường dẫn tĩnh có hash và cache immutable; đường dẫn API cũ chuyển hướng.

Bản ghi âm/video minh họa K9 vẫn dẫn nguồn gaeru.com. Nội dung giới thiệu/lựa chọn đã viết lại; không tuyên bố đã có bản ghi tự sản xuất. Chưa đo LCP/CLS trong trình duyệt thực tế, không suy ra chỉ số đó từ kiểm tra HTTP.

## Bảo trì thư viện
Kiểm tra registry ngày 26/10/2026: ExcelJS 4.4.0 vẫn mới nhất nhưng kéo theo inflight, rimraf 2, lodash.isequal, fstream và glob 7. Thay bằng write-excel-file 4.1.1 và fflate 0.8.3, bỏ override ExcelJS. Cài đặt sạch giảm 169 gói; audit 0 lỗ hổng; outdated không có gói trực tiếp lỗi thời. Excel thật vẫn giữ literal text chống công thức, điện thoại dạng chuỗi, tiền dạng số, tên cột, đóng băng dòng đầu và autoFilter.

Kiểm thử: 315 kiểm thử thành công; bổ sung kiểm tra URL/chuyển hướng/fragment, schema, SSR JSON an toàn, phân quyền/CSRF/trạng thái và phiên bản trang. Không tạo đơn thật, gửi mail thật, thay khóa hoặc gọi tạo vận đơn trong kiểm thử.
