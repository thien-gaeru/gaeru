# CodeQL: rà soát sáu cảnh báo tích hợp trước merge

Đọc từng alert bằng GitHub API ngày 03/11/2026. Cả sáu instance gần nhất thuộc default branch `refs/heads/gaeru`, commit `9e517e9c4adcdf875fe486b4356f891b057a94a8`, CodeQL 2.27.3. Không lấy PR incremental scan không có kết quả làm bằng chứng full scan đã sạch. Chưa dismiss hoặc suppress cảnh báo nào.

| Alert | Đánh giá | Xử lý mã nguồn |
| --- | --- | --- |
| [78](https://github.com/thien-gaeru/gaeru/security/code-scanning/78), [79](https://github.com/thien-gaeru/gaeru/security/code-scanning/79): js/redos trong payment-provider-clients.js | Lỗi thật: regex lặp lồng nhau có thể backtrack theo cấp số nhân. Giới hạn 40–50 ký tự vẫn đủ gây treo khi chuỗi alphanumeric dài kết thúc bằng ký tự sai | Thay bằng kiểm tra tập ký tự và ký tự đầu/cuối tuyến tính, giữ nguyên giới hạn và ngữ nghĩa ID hợp lệ. Regression chạy trong tiến trình con có watchdog, kiểm cả txnRef và requestId, xác nhận không gọi provider; kiểm cả ID một ký tự, separator lặp và độ dài tối đa |
| [75](https://github.com/thien-gaeru/gaeru/security/code-scanning/75): js/bad-tag-filter | Lỗi trích xuất thật: script/style có end tag whitespace không bị loại hoàn toàn. Đây là đường lấy text cho AI từ HTML nội bộ, chưa có bằng chứng về một sink render HTML/XSS | Dùng parser linkedom đã có trong runtime, bỏ các node script/style/nav/footer/dialog/svg/template/noscript/head trước lấy text. Regression kiểm mixed-case và end tag có khoảng trắng/tab, nội dung bị loại không vào knowledge |
| [76](https://github.com/thien-gaeru/gaeru/security/code-scanning/76): js/double-escaping | Lỗi dữ liệu thật: chuỗi thay thế nhiều lượt giải mã entity lồng nhau nhiều hơn một lần, có thể làm đổi nội dung literal | Lấy text/attribute đã giải mã một lượt từ DOM; không có chuỗi replace giải mã lại. Regression giữ literal &amp;lt; dạng text sau một lượt và kiểm numeric Unicode ngoài BMP |
| [123](https://github.com/thien-gaeru/gaeru/security/code-scanning/123), [124](https://github.com/thien-gaeru/gaeru/security/code-scanning/124): js/weak-cryptographic-algorithm ở J&T | MD5 là thuật toán yếu thật; chưa đủ chứng cứ để gọi false positive hoặc xác nhận protocol Việt Nam bắt buộc chính encoding hiện có | Giữ nguyên wire bytes để không tự ý phá giao thức đang mô tả. Thêm chú thích rủi ro và known digest vector. Cảnh báo vẫn cần được xử lý như phụ thuộc giao thức chưa nghiệm thu, không được báo đã sạch |

## Bằng chứng và giới hạn J&T

[Tài liệu first-party J&T Indonesia](https://developer.jet.co.id/documentation) mô tả chữ ký ghép dữ liệu với key rồi MD5 và Base64, đồng thời yêu cầu thỏa thuận đối tác, sandbox, mapping và bước xác nhận production. Điều này chứng minh MD5 có xuất hiện trong một giao thức J&T; không chứng minh endpoint, trường hay encoding của J&T Việt Nam là cùng giao thức.

Tài liệu Indonesia dùng trường data_param/data_sign và ví dụ PHP Base64 trên chuỗi hex MD5. Adapter hiện có dùng logistics_interface/data_digest và Base64 trên 16 byte MD5. Sự khác biệt này được ghi rõ; không thay sang SHA-256, không đổi binary/hex encoding dựa trên suy đoán. Known vector chỉ khóa hành vi phần mềm hiện tại, không phải nghiệm thu nhà cung cấp.

Cần nhận spec đúng tài khoản/phiên bản J&T Việt Nam và approved test vector, xác nhận endpoint, digest input/encoding, account binding, idempotency và quyền API. Nếu hãng có giao thức chữ ký mạnh hơn thì triển khai theo hợp đồng đó rồi nghiệm thu. Hiện đường gọi dùng HTTPS cố định, không theo redirect; MD5 không được dùng cho mật khẩu, mã hóa khóa lưu trữ hoặc xác thực webhook nội bộ.

## Phạm vi kiểm chứng

`test/codeql-integration-boundaries.test.js` cùng các kiểm thử payment provider, web knowledge, shipping choice/carriers là fixture phần mềm. Không dùng khóa thật, không gửi tiền, vận đơn hoặc thay đổi trạng thái alert GitHub. Các sửa mã cần scan lại commit mới; trạng thái alert default branch chỉ đổi sau khi CodeQL phân tích mã đã cập nhật.

## Cập nhật sau khi tìm được tài liệu J&T Việt Nam công khai

Phần mô tả adapter legacy ở trên là bằng chứng trước lần sửa tiếp theo trong ngày. Đã tìm được [tài liệu J&T Việt Nam](https://open.jtexpress.vn/apiDoc/index), đối chiếu bundle công khai của portal và thay wire contract cũ bằng form `bizContent`, header `apiAccount/digest/timestamp`, base demo/production riêng. Tài liệu Việt Nam xác nhận MD5 bytes rồi Base64; không còn cần lấy tài liệu Indonesia làm cơ sở cho encoding này. MD5 vẫn là thuật toán yếu; không suppress/dismiss cảnh báo.

[Bản rà soát mới](jt-vietnam-open-platform.md) ghi rõ các mâu thuẫn còn lại về password salt, bảng trạng thái, nguồn địa chỉ, nhãn và callback. Probe chỉ xác thực tài khoản, không nghiệm thu fulfillment hay bật checkout. Chưa có cuộc gọi dùng khóa GAERU hoặc nghiệm thu API thật của J&T. Known-vector/fixture chỉ xác minh mã nguồn; vẫn cần approved vectors và SIT của tài khoản.
