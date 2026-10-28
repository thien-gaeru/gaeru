# Rà soát mã nguồn GAERU ngày 28 tháng 10 năm 2026

Đã đồng bộ mã nguồn mới nhất từ nhánh mặc định `gaeru` của [thien-gaeru/gaeru](https://github.com/thien-gaeru/gaeru) và rà soát trên nhánh riêng `audit/2026-10-28`. Xác nhận 12 lỗi: đã vá 10, còn 2 liên quan tích hợp thanh toán. Bộ kiểm thử sau vá đạt **422/422**, không bỏ qua test, trên **Node.js 24.22.1**.

| Mức độ | Tổng lỗi xác nhận | Đã vá | Còn lại |
| --- | ---: | ---: | ---: |
| Critical | 0 | 0 | 0 |
| High | 2 | 1 | 1 |
| Medium | 9 | 8 | 1 |
| Low | 1 | 1 | 0 |
| Tổng | 12 | 10 | 2 |

Không có thao tác push, deploy, thay khóa, chỉnh cơ sở dữ liệu production, gửi email thật hoặc thanh toán thật trong đợt này. Các kết quả HTTP và giao diện dưới đây dùng máy chủ riêng trên `127.0.0.1`, PostgreSQL nhúng trong bộ nhớ và dữ liệu thử nghiệm; chúng không xác nhận trạng thái vận hành production.

## Nguồn mã và khả năng khôi phục

- Repository: `https://github.com/thien-gaeru/gaeru.git`; GitHub xác nhận nhánh mặc định là `gaeru`.
- Commit nền: `3b4df5d637b0a115d24f3bae4277b2332635d185`, ngày **28/10/2026 14:49:42 giờ Việt Nam**, thông điệp `feat(admin): interactive modal popup for payment/shipping configuration and fix invalid request errors`.
- Bản tải mới ban đầu sạch; nhánh làm việc `audit/2026-10-28` được tạo trực tiếp từ commit này. Không merge đè hoặc reset bản checkout cũ.
- Bản checkout cũ ở thư mục ngày 23/10 sạch, đang ở `gaeru`, commit `d191871fcf69b3315d34914dfe218a2ebc0e8637`.
- Có Git bundle của lịch sử nhánh mặc định trước vá tại thư mục làm việc riêng, ngoài repository. Các bản vá được giữ trên nhánh audit để có thể xem diff và hoàn tác theo Git.
- Phạm vi nền: **447 tệp được Git theo dõi**, trong đó **251 tệp JavaScript/CJS**, **33 HTML**. Clone một nhánh mặc định cùng lịch sử; không kiểm tra những nhánh remote chưa merge.

## Những lỗi đã vá

Các số dòng dưới đây theo bản mã sau vá. Mỗi nhóm có test thực thi kiểm tra hành vi; không chỉ kiểm tra chuỗi văn bản trong mã.

| ID | Mức độ | File và dòng | Nguyên nhân và tác động | Bản vá và bằng chứng |
| --- | --- | --- | --- | --- |
| G01 | High | `src/store-api.js:190` | Handler IPN bắt buộc `vnp_Command=pay`, trong khi callback thanh toán VNPAY chính thức không yêu cầu trường chỉ dùng khi tạo URL thanh toán này. Callback ký đúng có thể bị trả `99 Unsupported command`, để đơn vẫn chưa thanh toán. Fixture cũ có thêm trường này nên bỏ sót lỗi. | Chấp nhận trường bị thiếu; vẫn từ chối giá trị được gửi rõ nhưng khác `pay`. Giữ kiểm tra chữ ký, merchant, số tiền, khóa giao dịch và chống xử lý lặp. Test callback không có command thất bại trước vá, đạt sau vá; vẫn thử sai chữ ký/merchant/số tiền/command và callback lặp. `test/store-api.test.js:355`. |
| G02 | Medium | `src/admin-session-policy.js:21` | Polling tổng quan/đơn mỗi 15 giây và chat mỗi 5 giây cập nhật thời điểm hoạt động. Trang mở nhưng không có người dùng thao tác vẫn vượt qua thời hạn nhàn rỗi 30 phút; giới hạn tuyệt đối 8 giờ còn hiệu lực. | Phân loại các GET nền `orders`, `summary`, `shopping-chat` là thụ động; giữ heartbeat `/api/auth/activity` từ click/bàn phím. Test mô phỏng đến phút 31 tái hiện trước vá và hết phiên đúng sau vá. `test/admin-session-policy.test.js:10`. |
| G03 | Medium | `src/catalog-videos.js:4`, `:8` | Ngắt kết nối giải phóng slot upload ngay cả khi tác vụ lưu vẫn giữ buffer video. Có thể vượt giới hạn hai upload đang xử lý bằng cách ngắt các yêu cầu trước. | Dùng `createUploadGate(2)` và `withUploadWork` đã có để giữ slot đến khi lưu kết thúc. HTTP regression giữ hai tác vụ lưu, ngắt client rồi thử upload thứ ba: trước vá yêu cầu lọt vào DB, sau vá trả 429. `test/catalog-video-upload-gate.test.js`. |
| G04 | Medium | `src/db.js:88` | Chẩn đoán TLS suy ra kết nối phía database được mã hóa từ `ssl=on` hoặc TLS phía ứng dụng đến pooler, ngay cả khi `pg_stat_ssl.ssl=false`; còn có đường suy ra chứng chỉ đã xác minh chỉ từ cấu hình. | Hiển thị bằng chứng từng chặng riêng; trạng thái thiếu dữ liệu giữ `null`. Kết nối ứng dụng chỉ báo chứng chỉ hợp lệ khi quan sát socket được xác thực. Không thay đổi yêu cầu TLS trong pool. Thêm test mâu thuẫn/thiếu bằng chứng trong `test/database-tls.test.js`. |
| G05 | Medium | `src/media-filesystem-migration.js:10`, `:23` | Migration dùng `readMedia` đã giải nén nhưng đối chiếu SHA/size của object nén. Tệp chat 19.000 byte được lưu trong envelope 220 byte làm migration dừng `MIGRATION_SOURCE_CHECKSUM`. Pointer gốc vẫn được giữ; chưa có bằng chứng mất dữ liệu. | Đọc và sao chép byte object gốc từ `source.downloadProductImage(key)`, giữ envelope nén và checksum. Hai test PGlite mới bao phủ pointer V2/V1, byte nén nguyên vẹn, đọc lại đã giải nén, backup pointer, metadata, chạy lặp, chặn hỏng dữ liệu và khôi phục. `test/media-filesystem-migration.test.js:26`, `:52`. |
| G06 | Medium | `clean-urls.js:18` | Nhánh chuẩn hóa `srcset` dùng biến `key` ngoài phạm vi khai báo. Khi URL ảnh cần chuyển đổi, `ReferenceError` dừng khởi tạo và ngăn cài MutationObserver. | Ghi trực tiếp thuộc tính `srcset`. Test thực thi mã trình duyệt kiểm tra nhiều nguồn ảnh, chuẩn hóa liên kết tiếp theo và cập nhật DOM mới; đỏ trước vá, xanh sau vá. `test/client-url-normalization.test.js`. |
| G07 | Medium | `admin/configuration.js:294`, `:413`, `:602`, `:665` | Biến `sessionOwnerPassword` giữ mật khẩu chủ nguyên văn giữa nhiều thao tác, điền lại popup và tái sử dụng sau khi ô hiển thị đã bị xóa. | Xóa cache mật khẩu; chỉ dùng mật khẩu trong form hiện tại, xóa mật khẩu/mã xác thực sau yêu cầu. Nút Bật/Tắt mở popup có nút xác nhận rõ để giữ chức năng với xác thực mới. Test bảo đảm yêu cầu sau không tái dùng mật khẩu cũ và xác nhận gửi đúng version/trạng thái. `test/configuration-reauth-ui.test.js`. |
| G08 | Medium | `admin/configuration.js:140`, `:173`, `:348` | Popup `aria-modal` cho Tab thoát ra nền, không trả focus về nút mở; Escape còn thay trạng thái cuộn khi popup không mở. | Giữ focus trong popup, hỗ trợ Shift+Tab, trả focus và trạng thái cuộn đúng khi đóng. Test DOM hai chiều; kiểm tra trình duyệt 390×844 xác nhận Tab từ nút lưu quay về Đóng, Escape trả về nút cấu hình VNPAY. |
| G09 | Medium | `src/server.js:23`, `:45`, `:57`, `:63` | Startup thất bại không đóng pool/session store; SIGTERM trước khi listener được tạo gọi `server.close` trên undefined; lỗi listener chưa có handler. Log lỗi đầy đủ có thể chứa ngữ cảnh nhạy cảm. | Đợi startup đang chạy kết thúc trước cleanup, ngăn mở listener khi đang dừng, đóng tài nguyên một lần khi lỗi, bắt lỗi listener và chỉ ghi loại/mã lỗi đã lọc. Ba regression đỏ trước vá và xanh sau vá cho migration lỗi, dừng sớm và lỗi listener; kiểm tra không ghi mật khẩu giả lập vào log. `test/server-lifecycle.test.js`. |
| G10 | Low | `src/customer-auth.js:107`, `src/account-security.js:43`, `src/contact-change-api.js:23` | bcrypt chỉ so sánh 72 byte đầu. Đăng ký/reset/admin login đã giới hạn byte, nhưng login khách và hai bước xác nhận mật khẩu chưa giới hạn nên chấp nhận hậu tố bị bỏ qua. Không phải đường đăng nhập khi chưa biết 72 byte mật khẩu. | Dùng `withinBcryptLimit` nhất quán. Test ASCII và Unicode giữ mật khẩu đúng 72 byte hợp lệ, từ chối hậu tố bằng 401/403 trước khi thực hiện tác vụ nhạy cảm. `test/password-boundary.test.js:12`, `:38`, `:56`. |

G01 dựa trên [đặc tả thanh toán VNPAY](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html). Fixture chữ ký hợp lệ trong test không thay thế giao dịch merchant sandbox thực tế.

## Lỗi còn lại và cách sửa

### G11 High Luồng tạo phiên thanh toán MoMo và ZaloPay chưa đúng

**Vị trí:** `src/payment-channels.js:103` và `:126`; nơi dùng `src/store-api.js:451`.

Hai builder tự ghép URL GET tại `/v2/gateway/pay` và `/v2/pay`; chưa gọi API xác thực phía máy chủ để tạo đơn tại nhà cung cấp và dùng `payUrl` hoặc `order_url` trả về. Vì các kênh có thể được bật trong cấu hình, checkout có thể tạo đơn chờ và giữ hàng cục bộ rồi đưa khách sang URL chưa phải phiên thanh toán do nhà cung cấp cấp. Test hiện tại kiểm tra URL tự ghép và callback mô phỏng, nên vẫn đạt dù luồng tích hợp này thiếu.

[MoMo](https://developers.momo.vn/v3/vi/docs/payment/api/wallet/onetime/) yêu cầu API tạo thanh toán `/v2/gateway/api/create`; [ZaloPay](https://docs.zalopay.vn/vi/docs/specs/order-create/) có API tạo đơn, và [luồng cổng thanh toán ZaloPay](https://developers.zalopay.vn/v2/docs/gateway/guide.html) chuyển hướng bằng URL trả về sau khi tạo đơn thành công.

**Cách sửa:** adapter riêng theo hợp đồng từng nhà cung cấp; kiểm tra chữ ký, mã kết quả và host URL trả về; lưu request ID/provider ID phục vụ truy vấn và xử lý callback lặp; test contract với merchant sandbox trước khi mở checkout. Giữ những kênh chưa có adapter được xác minh ở trạng thái không khả dụng cho người mua. Chưa tự đổi endpoint hoặc vô hiệu hóa cấu hình thật vì chưa có dữ liệu merchant và cần kiểm tra toàn bộ luồng. 9Pay cũng có builder cục bộ, nhưng chưa có hợp đồng merchant đủ để kết luận cùng một lỗi giao thức.

### G12 Medium Kiểm tra gateway có thể báo xác minh thành công với HTTP 404 và khóa giả

**Vị trí:** `src/payment-channels.js:371`; điều kiện HTTP tại `:423`, `:449`, `:475`, `:501`; ghi `verified_at` tại `:534`.

Luồng kiểm tra xác thực định dạng chuỗi, tự tính HMAC, rồi GET một URL công khai không mang thông tin xác thực. Mọi HTTP status dưới 500 được coi là thành công. Tái hiện bằng credentials giả và fetch double trả `{ok:false,status:404}` cho VNPAY, 9Pay, MoMo và ZaloPay: cả bốn trả `verified:true`, `method:gateway_handshake`. HTTP 200 của trang công khai cũng không chứng minh merchant hoặc khóa hợp lệ.

**Cách sửa:** tách trạng thái liên lạc được máy chủ khỏi trạng thái xác thực tài khoản; public probe chỉ trả reachability, `verified:false` và không ghi `verified_at`. Chỉ đánh dấu xác minh khi có phản hồi API được xác thực hoặc giao dịch sandbox đã đối soát. Đổi điều kiện sang `response.ok` là cần thiết nhưng chưa đủ. Kiểm tra chuỗi thông tin chuyển khoản cũng phải ghi rõ là kiểm tra định dạng, không phải xác minh quyền sở hữu tài khoản ngân hàng. Chưa thay hành vi xác minh/bật kênh trong đợt vá nhỏ này vì cần đồng bộ API, dữ liệu xác minh cũ và giao diện.

## Kết quả kiểm tra

| Hạng mục | Kết quả và giới hạn |
| --- | --- |
| Dependency và lockfile | `npm ci` sạch bằng Node 24.22.1 thành công, 193 package được cài trên Windows; không thay `package.json` hoặc `package-lock.json`, không dùng force/overrides. `npm ls --depth=0` không báo cây dependency lỗi. |
| Audit dependency | `npm audit --json`: **0 Critical, 0 High, 0 Moderate, 0 Low**, theo cơ sở dữ liệu npm tại lúc kiểm tra. Đây là lỗ hổng đã công bố của dependency, không bao hàm lỗi logic ứng dụng. |
| Phiên bản mới | `@aws-sdk/client-s3` 3.1156.0 có patch 3.1158.0; PGlite ghim 0.5.11 có 0.5.12. Ghi nhận để bảo trì; không tự nâng khi chưa cần cho bản vá. |
| Runtime đúng phiên bản | Tải Node 24.22.1 từ nodejs.org và đối chiếu SHA-256 với manifest chính thức; không thay Node toàn máy. Node cài sẵn 24.21.0 nằm trong engines nhưng khác bản ghim. |
| Test trước vá | **405/405**, Node 24.21.0, thời gian khoảng 52,8 giây; vẫn bỏ sót các lỗi đã tái hiện riêng. |
| Test sau vá | **422/422**, 0 fail, 0 skip, 0 cancelled; Node 24.22.1, khoảng **54,1 giây**, `node --test --test-concurrency=2`. |
| Cú pháp và import | Kiểm tra mọi JS/CJS nền bằng `node --check`; không có lỗi cú pháp hoặc relative `require` tĩnh bị thiếu. Các file test mới cũng được thực thi trong toàn bộ suite. Quét tĩnh không chứng minh mọi import/URL tạo động đều đúng. |
| Build lint typecheck | Dự án CommonJS/HTML/CSS không có bước đóng gói, không có TypeScript hoặc script `build`, `lint`, `typecheck`. Không báo các bước này là đã chạy/đạt. Thay thế phù hợp cho cấu trúc hiện tại là syntax, dependency resolution, startup HTTP và test; chưa có kiểm tra lint/type toàn codebase. |
| Database và storage | Test PGlite chạy migration, giao dịch, ràng buộc, sở hữu dữ liệu, xử lý lặp, kho, đơn, tài chính và các nhánh media. Mock S3/SMTP/provider. Không đối chiếu schema/index/backup/quyền hoặc dữ liệu DB production. |
| HTTP route và SEO | Máy chủ local trả **200 cho 26/26 URL sitemap** từ fixture; mỗi trang có `lang`, title, description, canonical và một H1. Test có server render, schema, robots, URL sạch, draft không công khai, DB lỗi trả 503. Không xác nhận index Google. |
| Tài nguyên giao diện | Đối chiếu 33 HTML: không thấy tệp JS/CSS/ảnh/poster cục bộ được tham chiếu bị thiếu sau khi ánh xạ đúng `/gaeru_ceo/assets/`; không thấy ID trùng hoặc ảnh tĩnh thiếu alt, HTML thiếu viewport/lang. Dynamic DOM và toàn bộ tiêu chí WCAG chưa được chứng nhận. |
| Responsive và accessibility thực tế | Kiểm tra bằng trình duyệt trang chủ, cửa hàng, sản phẩm sau cuộn và popup thanh toán ở **390×844**; checkout khóa ở **320×740**. Mẫu đo không có tràn ngang; popup 358×760 nằm trong viewport, dùng được Tab/Escape. Chưa xác minh mọi trang, hướng xoay, thiết bị thật hoặc đầy đủ form checkout đang bật. |
| Security API auth input | Suite bao phủ CSRF, role/permission, MFA, token một lần, replay, sở hữu đơn/địa chỉ, version check và đầu vào; đã sửa G02/G07/G10. Đọc mã các router và SQL tham số hóa; không gọi đây là chứng nhận penetration test. |
| Secrets | Quét 261 commit, 4.298 Git object, 3.072 text blob lịch sử theo 9 nhóm chữ ký. 8 ứng viên hiện tại/13 lịch sử đều là URL PostgreSQL mẫu/test; **không xác nhận credential thật**. Bỏ qua binary và text blob trên 2 MiB; không quét cấu hình hosting/log/nhánh chưa tải, không bảo đảm bắt được secret định dạng tùy ý. |
| Runtime error handling logging | Thử HTTP, lỗi JSON/DB, upload ngắt, startup/listener lỗi, shutdown sớm và làm sạch log. Test local không chứng minh máy chủ production không có lỗi hoặc hết tài nguyên dưới tải. |
| Performance | Test có compression, cache public/versioned assets, no-store dữ liệu riêng và bộ nhớ upload. Đọc toàn buffer khi phục vụ media/range vẫn là cơ hội tối ưu; chưa có số đo tải production hay LCP/CLS/INP trên điện thoại thật. |
| Dead code | Kiểm tra liên kết/import, phạm vi script storefront, các module dùng chung và handler mới; chưa có bằng chứng đủ để xóa nhánh mã an toàn. Không xóa code chỉ vì tìm kiếm tĩnh không thấy nơi gọi. |
| Environment và deployment | `.node-version`, `.nvmrc`, README, CI và Render cùng ghim 24.22.1. Production bắt buộc TLS trong `poolOptions`, kể cả Render khai báo `PGSSL=disable`; cần xác minh CA/kết nối thật theo nhà cung cấp. Các workflow Pages chỉ chạy thủ công; `static.yml` còn đóng gói toàn repo và không thể thay runtime API Node. Không chạy/deploy các workflow này. |

## Đối chiếu lần kiểm tra trước

Đã đọc `docs/admin-security-review.md` và `docs/request-audit-20261026.md`. Cuộc trò chuyện tham chiếu chỉ chứa yêu cầu rà soát, chưa có kết quả hoặc bản vá để tái dùng.

- **Chặn lộ mã nguồn bằng đường dẫn mã hóa:** còn hiệu lực. Local `/s%72c/server.js`, `/%64b/schema.sql`, `/.env`, `/.git/config`, `/package-lock.json`, `/README.md` trả 404; API quản trị chưa đăng nhập trả 401.
- **CSRF, cache/noindex của API và quyền:** các kiểm tra hồi quy tiếp tục đạt. Không chuyển lại sang phục vụ toàn thư mục dự án.
- **Thời hạn phiên nhàn rỗi:** phát hiện polling mới làm suy yếu quy tắc cũ; đã vá G02.
- **TLS:** yêu cầu kết nối có xác minh vẫn được giữ; sửa phần chẩn đoán G04 vốn suy diễn quá mức so với giới hạn trong báo cáo cũ.
- **Mobile:** đã bổ sung kiểm tra trình duyệt sau cuộn trên các trang mẫu, cùng kiểm tra bàn phím popup; chưa đóng yêu cầu kiểm tra mọi trang/điện thoại.
- **Tích hợp nhà cung cấp:** chưa thể coi hoàn tất AI thật, email đến hộp thư, vận đơn/tem/webhook hãng, toàn bộ object lưu trữ, Core Web Vitals hoặc index Google. G11/G12 còn là lỗi mã được xác nhận, bên cạnh các giới hạn vận hành đó.
- **Các yêu cầu tính năng/nội dung ngày 26/10:** banner trang chủ đúng vị trí, khôi phục đơn hủy an toàn, ảnh K9/G1 thực tế, tách nền và tính nguyên bản nội dung không được coi là đã hoàn tất bởi đợt audit này. Không thấy bằng chứng đủ để đóng các mục cũ; cần kiểm tra theo yêu cầu riêng và dữ liệu catalog/asset thật. Không tự triển khai thêm tính năng trong phạm vi bản vá lỗi.

## Các file thay đổi

**11 file ứng dụng:** `admin/configuration.js`, `clean-urls.js`, `src/account-security.js`, `src/admin-session-policy.js`, `src/catalog-videos.js`, `src/contact-change-api.js`, `src/customer-auth.js`, `src/db.js`, `src/media-filesystem-migration.js`, `src/server.js`, `src/store-api.js`.

**9 file kiểm thử:** sửa `test/admin-session-policy.test.js`, `test/database-tls.test.js`, `test/media-filesystem-migration.test.js`, `test/store-api.test.js`; thêm `test/catalog-video-upload-gate.test.js`, `test/client-url-normalization.test.js`, `test/configuration-reauth-ui.test.js`, `test/password-boundary.test.js`, `test/server-lifecycle.test.js`.

**Tài liệu:** báo cáo này. Dependency/lockfile, migration SQL và cấu hình deploy không đổi.

Các bằng chứng bàn giao nằm trong thư mục `audit-evidence` cạnh repository: log test đầy đủ, kết quả npm audit/outdated, quét secret đã che giá trị, kiểm tra HTTP/tài nguyên và ảnh popup/checkout. Ưu tiên tiếp theo là sửa G11/G12 trong một thay đổi tích hợp có kiểm thử sandbox; sau đó mới xác nhận phát hành trên hosting.
