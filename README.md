# GAERU — cửa hàng độc lập

Trang quản trị đã được mở rộng cho một doanh nghiệp với nhiều nhân viên và kho hàng. Xem [hướng dẫn quản trị doanh nghiệp](docs/enterprise-admin.md) để biết nghiệp vụ, quyền, quy tắc tồn kho/công nợ và quy trình nâng cấp cơ sở dữ liệu.

Cửa hàng GAERU độc lập chạy bằng Node.js, Express và PostgreSQL; không dùng WordPress hoặc WooCommerce. Giao diện responsive lấy cảm hứng từ cách Apple giới thiệu sản phẩm, nhưng nội dung, thương hiệu và quản trị thuộc GAERU.

## Tính năng

- Cửa hàng công khai: trang chủ, danh mục, tìm kiếm, chi tiết sản phẩm, giỏ hàng và đặt hàng.
- Giỏ hàng lưu trên trình duyệt; giá, phiên bản và tồn kho được đọc từ PostgreSQL.
- Checkout có COD và hỗ trợ VNPAY khi merchant cấu hình đủ secrets trên máy chủ; phí giao hàng theo tỉnh/thành được áp dụng phía server. Tài liệu merchant 9Pay chưa có trong workspace nên phương thức này chưa được bật.
- Khu vực `/admin`: quản lý sản phẩm, phiên bản/SKU, giá, tồn kho; dashboard có số đơn cần xử lý, đơn chờ thanh toán và cảnh báo tồn thấp; tra cứu/lọc/phân trang lịch sử đơn, cập nhật trạng thái và cấu hình phí giao hàng theo tỉnh/thành.
- Đăng nhập quản trị bằng mật khẩu băm; phiên lưu trong PostgreSQL, có CSRF token, giới hạn đăng nhập và giới hạn đặt hàng.
- Khách hàng có thể đăng ký/đăng nhập bằng email và mật khẩu, lưu số điện thoại liên hệ; tài khoản chưa xác minh vẫn đăng nhập và mua hàng bình thường. Trong tài khoản, khách có thể yêu cầu gửi email xác minh với liên kết dùng một lần (hiệu lực 30 phút); trạng thái chưa xác minh biến mất sau khi xác nhận. Khôi phục mật khẩu đối chiếu email và số điện thoại rồi gửi liên kết dùng một lần qua email (hiệu lực 30 phút).
- Các ảnh sản phẩm ban đầu được lưu trong `assets/products/`. Catalog seed ở trạng thái nháp, không tự đặt giá hay tồn kho chưa được xác minh.

## Quản trị sản phẩm và đơn hàng

Mở `/admin/` và đăng nhập bằng tài khoản đã cấu hình trên máy chủ.

- **Sản phẩm & kho:** tìm theo tên, slug hoặc SKU; kết hợp bộ lọc danh mục, hiển thị và tồn kho để tìm sản phẩm cần xử lý. Giá và tồn kho trên danh sách được tính từ các phiên bản đang bán.
- **Thêm sản phẩm:** nhập thông tin và chọn ảnh PNG/JPEG/WebP tối đa 8 MB, lưu bản nháp, rồi thêm phiên bản với SKU, giá và tồn kho đã xác minh. Thuộc tính phiên bản được nhập theo từng cặp tên/giá trị. Sau khi có ít nhất một phiên bản đang bán, mở lại thông tin sản phẩm và bật hiển thị.
- **Bảo toàn danh mục:** muốn ẩn hoặc xóa phiên bản đang bán cuối cùng, phải tạm ẩn sản phẩm trước. Phiên bản đã có trong đơn hàng được giữ lại để bảo toàn lịch sử; có thể tạm ẩn thay cho xóa.
- **Đơn hàng:** kết hợp tìm kiếm, trạng thái xử lý, trạng thái thanh toán và phương thức thanh toán; mở chi tiết để xem liên hệ, địa chỉ, sản phẩm và tổng tiền. Phân trang giữ nguyên các bộ lọc đang chọn.
- **Xử lý đơn:** giao diện chỉ cung cấp trạng thái hiện tại và các bước tiếp theo hợp lệ. COD chỉ được ghi nhận đã thu tiền khi hoàn tất giao hàng. Hủy đơn chưa thanh toán sẽ hoàn lại tồn kho một lần.
- **Đối soát thanh toán:** trạng thái VNPAY/9Pay được cập nhật từ cổng thanh toán, không sửa thủ công. Bộ lọc 9Pay chỉ hỗ trợ tra cứu dữ liệu lịch sử; không bật tích hợp 9Pay mới. Đơn đã thanh toán không được chuyển về chưa thanh toán hoặc đổi phí giao hàng; cần xử lý hoàn tiền riêng trước khi hủy. Phí của phiên VNPAY đã tạo cũng được khóa.

## Yêu cầu

- Node.js **24.22.1** (LTS), đồng bộ trong `.nvmrc`, `.node-version`, GitHub Actions và Render. `package.json` yêu cầu `>=24.0.0 <25`; cập nhật các tệp ghim phiên bản cùng nhau khi nâng cấp. Bản nâng cấp này không thay Node.js toàn máy hoặc tự triển khai hosting.
- PostgreSQL 13 trở lên.
- Lưu trữ bền vững cho thư mục `assets/products/` và kế hoạch sao lưu cơ sở dữ liệu/ảnh.

## Cài đặt phát triển (PowerShell)

```powershell
npm install
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Lệnh cuối tạo giá trị ngẫu nhiên để đặt vào `SESSION_SECRET`. Tạo database PostgreSQL `gaeru_store`, sau đó chỉnh `.env`:

- `DATABASE_URL`: chuỗi kết nối PostgreSQL.
- `SESSION_SECRET`: chuỗi bí mật ngẫu nhiên tối thiểu 32 ký tự.
- `ADMIN_USERNAME`: tên đăng nhập quản trị.
- `ADMIN_PASSWORD_HASH`: giá trị băm bcrypt được tạo bởi `npm run admin:hash-password` trong terminal tương tác; lệnh yêu cầu mật khẩu dài ít nhất 12 ký tự và không hiển thị mật khẩu khi nhập.
- `PGSSL=require` nếu dịch vụ PostgreSQL yêu cầu TLS có xác minh chứng chỉ; nếu không, giữ `disable`.
- `STORE_ORDERS_ENABLED=false` giữ checkout khóa theo mặc định. Chỉ bật thành `true` sau khi xác định và hoàn tất nghĩa vụ pháp lý hiện hành, xác minh chính sách/thông tin website khớp vận hành production, và kiểm thử end-to-end các phương thức thanh toán thật.
- Để bật xác minh email và khôi phục mật khẩu khách hàng, cấu hình `PUBLIC_BASE_URL` (HTTPS origin) cùng `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` trong secrets của máy chủ. Nếu chưa cấu hình SMTP, khách vẫn đăng ký/đăng nhập và mua hàng được nhưng yêu cầu gửi email sẽ báo dịch vụ chưa sẵn sàng.
- Để bật VNPAY, đặt đủ `PUBLIC_BASE_URL` (HTTPS), `VNPAY_TMN_CODE`, `VNPAY_HASH_SECRET` và `VNPAY_PAYMENT_URL` trong secrets của máy chủ. Phải khai báo rõ URL sandbox hoặc production do VNPAY cấp; ứng dụng không tự chọn sandbox hay production. Cấu hình URL IPN trên merchant portal thành `https://<domain>/api/payments/vnpay/ipn`; Return URL được tạo tự động.

Khởi tạo schema và catalog nháp, rồi chạy ứng dụng:

```powershell
npm run db:migrate
npm run db:seed
npm start
```

Mở `http://localhost:3000` để xem cửa hàng và `http://localhost:3000/admin/` để đăng nhập quản trị. Thêm và xác minh biến thể, giá, tồn kho trước khi bật bán sản phẩm. Không sử dụng mật khẩu mẫu, không đưa `.env` vào Git.

Để phát triển với tự khởi động lại:

```powershell
npm run dev
```

## Kiểm thử

```powershell
npm test
```

Các bài kiểm thử tự động không yêu cầu PostgreSQL thật. Trước khi vận hành, vẫn cần kiểm tra migration và các luồng quản trị/đặt hàng trên một database staging PostgreSQL.

## Triển khai

Ứng dụng cần một máy chủ có thể chạy Node.js và kết nối PostgreSQL; GitHub Pages chỉ phục vụ tệp tĩnh nên không thể chạy API hoặc quản trị. Thiết lập `NODE_ENV=production`, TLS/HTTPS, `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` và `PGSSL` trong phần quản lý secrets của máy chủ. Đặt proxy tin cậy đúng với hạ tầng triển khai trước khi bật `trust proxy` nếu kiến trúc không chỉ có một proxy.

Chạy `npm ci`, `npm run db:migrate`, rồi `npm start`. Dùng ổ lưu trữ bền vững cho ảnh tải lên và sao lưu PostgreSQL cùng ảnh; lên lịch sao lưu và kiểm thử khôi phục. Blueprint Render đã được chuẩn bị nhưng chưa tạo dịch vụ hoặc triển khai staging/production. Nhánh hiện tại đang cấp GitHub Pages preview; không đẩy mã standalone lên nhánh đó cho đến khi có kế hoạch giữ nguyên preview hoặc staging Render đã được triển khai và xác minh.

### Render Free (staging tạm thời)

`render.yaml` khai báo một web service Node.js và PostgreSQL miễn phí tại Singapore. Từ Render Dashboard, tạo Blueprint mới từ repository và nhánh chứa file này; khi Render hỏi, nhập `ADMIN_USERNAME` và `ADMIN_PASSWORD_HASH` (tạo hash bằng `npm run admin:hash-password` trong terminal tương tác). `SESSION_SECRET` được Render tự sinh, kiểm thử chạy trong build, còn migration/seed chạy idempotent khi dịch vụ khởi động. Deploy tự động khi commit được tắt để tránh phát hành ngoài ý muốn.

Render Free phù hợp cho bản xem thử, không phải dữ liệu cửa hàng vận hành: web service có thể ngủ khi không hoạt động, PostgreSQL Free hết hạn sau thời hạn miễn phí hiện hành của Render, và ảnh tải lên nằm trên ổ đĩa tạm nên có thể mất sau khi khởi động lại hoặc triển khai lại. Sao lưu/khôi phục và lưu trữ ảnh bền vững cần được thiết lập trước khi dùng dữ liệu thật. Blueprint chỉ khai báo cấu hình, không tạo dịch vụ hoặc triển khai cho đến khi được kết nối/tạo trong tài khoản Render.

## Giới hạn hiện tại

- Checkout bị khóa theo mặc định bằng `STORE_ORDERS_ENABLED=false`; API cũng từ chối tạo đơn khi cờ này tắt. Việc bật cờ không thay thế thủ tục pháp lý áp dụng hay rà soát pháp lý.
- VNPAY đã có luồng tạo giao dịch, xác minh chữ ký/IPN và cập nhật thanh toán idempotent; cần thông số merchant sandbox để kiểm thử thực tế trước khi production. 9Pay chưa được tích hợp vì chưa có tài liệu API merchant chính thức. Không nhập secret vào Git, chat hoặc giao diện quản trị.
- Giá, phiên bản, tồn kho, bảng phí giao hàng theo tỉnh/thành và thông tin nhận chuyển khoản cần được xác minh/cập nhật qua `/admin`. Phí theo tỉnh được đọc và áp dụng tại máy chủ; checkout chỉ mở khi có ít nhất một mức phí hợp lệ.
- Upload ảnh được lưu trên ổ đĩa cục bộ; Render Free không giữ ảnh tải lên sau khi dịch vụ khởi động lại hoặc triển khai lại.
# Tài khoản và mua hàng

## Quản trị tối cao và bản chạy cục bộ

Tài khoản chủ (`owner`, nguồn `bootstrap`) có mục **Quản trị tối cao**: xem nhân viên/đơn/CARE+ đang xử lý, trạng thái cấu hình hệ thống và thu hồi toàn bộ phiên nhân viên có xác nhận. Quản trị viên thường không truy cập được API này. Không thể cấp vai trò chủ hoặc khóa tài khoản chủ qua API nhân viên. Thu hồi phiên không khóa tài khoản nhân viên; họ có thể đăng nhập lại. Việc đổi tên/mật khẩu chủ làm phiên cũ hết hiệu lực sau khi cấu hình mới được ứng dụng nạp lại.

Để tạo tài khoản chủ `gaeru` trên máy tính: cài Node.js 24 và `npm ci`, chạy `npm run owner:setup -- gaeru`, tự nhập mật khẩu hai lần trong terminal. Mật khẩu không hiển thị và không lưu nguyên văn; công cụ ghi bcrypt hash cùng khóa phiên vào `.env.local-owner` (đã loại khỏi Git). Nếu đã có tài khoản, công cụ yêu cầu nhập `THAY DOI` trước khi ghi thay thế. Cấu hình `.env` của hosting không bị thay đổi.

Chạy `npm run dev:local`, mở `http://127.0.0.1:3000/admin/` và đăng nhập. Dữ liệu PostgreSQL nhúng lưu ở `.local-data/`, không bị mất khi dừng và mở lại; có thể đặt `LOCAL_PORT` nếu cổng 3000 bận. Bản cục bộ chỉ lắng nghe trên `127.0.0.1`, không nhận đơn, không gọi VNPAY hoặc SMTP, không thêm dữ liệu kinh doanh giả. Phiên đăng nhập cục bộ dùng bộ nhớ và kết thúc khi khởi động lại. Bản này dùng cho thiết lập/thử nghiệm cá nhân, chưa thay thế hosting production/PostgreSQL nhiều kết nối. Dừng bằng Ctrl+C; sao lưu `.local-data/` khi ứng dụng đã dừng. Không chia sẻ `.env.local-owner` hoặc thư mục dữ liệu.

Logo thương hiệu dùng chung: `assets/brand/gaeru-logo.png`, chuyển định dạng từ ảnh thương hiệu do chủ dự án cung cấp, giữ nguyên nội dung và nền trắng 375 × 375. `brand.css` điều chỉnh vùng hiển thị bằng CSS cho header, footer, trang cửa hàng, CARE+ và quản trị; không thay đổi tệp gốc bằng thao tác tạo ảnh. Các trang HTML dùng cùng PNG làm favicon. Khi thay logo, cập nhật tài nguyên dùng chung này và kiểm tra các kích thước hiển thị tương ứng.

## GAERU CARE+

`care.html` là trang hỗ trợ sau mua riêng; menu, footer và liên kết tài khoản trỏ về trang này. Giữ nguyên chính sách đã công bố ở `delivery-returns.html`; không tự xác nhận quyền lợi bảo hành. Khách đăng nhập chọn đơn thuộc tài khoản, gửi yêu cầu và theo dõi trạng thái/phản hồi. Đơn mua ngoài tài khoản được hướng dẫn liên hệ trực tiếp, không tra cứu công khai bằng email hoặc số điện thoại. API chống gửi lặp theo mã yêu cầu, giới hạn 10 yêu cầu mới/24 giờ/tài khoản. Quản trị có mục GAERU CARE+: quyền `orders.read` để xem và `orders.write` để phản hồi. Cập nhật kiểm tra phiên bản, ghi nhật ký cùng giao dịch; yêu cầu đã đóng không chỉnh sửa. Phản hồi hiện là phản hồi mới nhất, chưa có hội thoại, đính kèm hoặc thông báo email tự động.

Chạy `npm run db:migrate` để áp dụng `care.sql` trên môi trường kiểm thử trước khi triển khai. Việc xem tệp HTML trực tiếp chỉ hiển thị nội dung tĩnh; đăng nhập, gửi yêu cầu và quản trị cần máy chủ Node.js/PostgreSQL của dự án. Chưa thực hiện migration hoặc triển khai production.

Trang `shop.html` dùng bố cục cửa hàng mới: tiêu đề lớn, danh mục hình ảnh cuộn ngang, tìm kiếm theo sản phẩm/phiên bản/SKU, thẻ sản phẩm cuộn ngang và các khối hỗ trợ mua hàng. `shop-store.css` chỉ áp dụng trong `.shop-page`. Sản phẩm, giá và phiên bản vẫn lấy từ API; không thêm giá hoặc huy hiệu sản phẩm mới giả. Điều hướng bằng bàn phím và tùy chọn giảm chuyển động được hỗ trợ. Dùng hình ảnh GAERU có sẵn.

Trang tài khoản hỗ trợ cập nhật họ tên/số điện thoại, sửa địa chỉ đã lưu, xem chi tiết từng đơn gồm sản phẩm, số lượng, địa chỉ nhận và các khoản tiền. Các API luôn đối chiếu chủ sở hữu; thay đổi hồ sơ không sửa email, trạng thái xác minh hoặc địa chỉ trên đơn cũ. Khi sửa địa chỉ mặc định, địa chỉ đó vẫn là mặc định cho đến khi chọn địa chỉ khác. Khách chỉ xem được đơn đã gắn với tài khoản của mình.

Migration `customer-experience.sql` bổ sung sổ địa chỉ riêng cho từng khách (tối đa 20), địa chỉ mặc định và liên kết đơn mới với tài khoản đang đăng nhập. Chạy `npm run db:migrate` trước khi dùng bản này. Trang tài khoản cho phép thêm/xóa/chọn địa chỉ mặc định và xem đơn mới; checkout tự điền thông tin khách, chọn địa chỉ đã lưu, vẫn cho nhập địa chỉ khác. Đơn khách vãng lai và đơn lịch sử không tự gắn bằng email để tránh lộ dữ liệu. Tỉnh/thành phải khớp vùng giao hàng được cấu hình; địa chỉ ngoài vùng yêu cầu chọn lại tỉnh/thành.

Nhà cung cấp được chọn: VNPAY, J&T Express và Viettel Post. VNPAY đã có ký URL và kiểm tra IPN ở máy chủ; cần cấu hình merchant và nghiệm thu sandbox trước production. Bản này **chưa có adapter tạo vận đơn hoặc đồng bộ trạng thái J&T/Viettel Post**. Cần tài liệu API của hợp đồng GAERU (môi trường thử nghiệm, cách ký/xác thực, tạo/tra cứu/hủy vận đơn, webhook, mã dịch vụ, địa chỉ lấy hàng và thông số kiện hàng) trước khi triển khai. Không nhập khóa bí mật vào Git hoặc chat. Tham khảo cổng chính thức: https://open.jtexpress.vn/ và https://partner2.viettelpost.vn/document/detail-instructions.

