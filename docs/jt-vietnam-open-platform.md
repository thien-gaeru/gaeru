# J&T Việt Nam Open Platform — trạng thái tích hợp ngày 03/11/2026

Đã tìm và đọc được tài liệu công khai của chính J&T Việt Nam. Không cần lấy giao thức Indonesia để suy luận giao thức Việt Nam. Nội dung trang dùng JavaScript; lần kiểm tra này đọc HTML và các bundle tài liệu đang được HTML công khai tham chiếu. Không đăng nhập, không dùng khóa tài khoản GAERU và không gọi API nghiệp vụ của hãng.

## Nguồn first-party

- [Giới thiệu và chữ ký](https://open.jtexpress.vn/apiDoc/index).
- [Kiểm tra tài khoản](https://open.jtexpress.vn/apiDoc/vip/query).
- [Tạo đơn](https://open.jtexpress.vn/apiDoc/orderserve/create), [hủy đơn](https://open.jtexpress.vn/apiDoc/orderserve/cancel).
- [Tra cứu hành trình](https://open.jtexpress.vn/apiDoc/logistics/query).
- [Tính cước](https://open.jtexpress.vn/apiDoc/fees/calculatingFees).
- [In nhãn](https://open.jtexpress.vn/apiDoc/vip/printOrder).
- [Công cụ ký và hướng dẫn đăng ký](https://open.jtexpress.vn/helpCenter).
- [Kênh liên hệ chính thức](https://jtexpress.vn/vi/contact): 1900 1088, cskh@jtexpress.vn. Chưa liên hệ thay người dùng.

Bundle được kiểm tra có suffix `9c08570a`; suffix không phải ngày phát hành hay cam kết phiên bản tài khoản. Bản ghi URL/SHA-256 được lưu ở `outputs/continuation-20261103/jt/official-evidence.json` của workspace nghiệm thu.

## Hợp đồng truyền dữ liệu đã xác minh từ tài liệu công khai

Tài liệu Việt Nam chỉ định POST form UTF-8, trường `bizContent` chứa chuỗi JSON; header `apiAccount`, `digest`, `timestamp` tính bằng mili giây. `apiAccount` phải giữ dạng chuỗi vì các ID minh họa vượt giới hạn số nguyên chính xác của JavaScript. Chữ ký header là Base64 của byte MD5 trên chuỗi JSON chính xác ghép `privateKey`.

Hai môi trường có base riêng:

| Môi trường | Base cố định |
| --- | --- |
| Thử nghiệm | `https://demoopenapi.jtexpress.vn/webopenplatformapi/api/` |
| Chính thức | `https://ylopenapi.jtexpress.vn/webopenplatformapi/api/` |

Các path công khai gồm `vip/checkCusPwd`, `order/addOrder`, `order/cancelOrder`, `logistics/trace`, `spmComCost/getComCost`, `order/printOrder`. API nghiệp vụ dùng `customerCode` và password nghiệp vụ riêng; chúng không phải `apiAccount`/`privateKey`. Kiểm tra tài khoản dùng business digest riêng theo công thức tại trang `vip/query`. Phản hồi phải có code `1`; HTTP 200, `success:true` đơn lẻ hoặc chuỗi thông báo không thay thế được code nghiệp vụ.

Adapter cũ gửi JSON `logistics_interface/data_digest/msg_type/eccompanyid` tới `open.jtexpress.vn/api/order/...`; hợp đồng đó đã được bỏ khỏi đường gọi J&T. Không đổi chữ ký sang SHA-256 tùy ý, không gọi thử một tracking number bịa để xác minh tài khoản.

## Mâu thuẫn tài liệu và phần đang khóa

1. Trang kiểm tra tài khoản mô tả salt `jadada236t2`; Help/Signature Tool mô tả `jadada369t3`. Hệ thống không tự băm mật khẩu dạng rõ hoặc chọn một salt. Quản trị phải nhập **password nghiệp vụ 32 HEX viết hoa đã được công cụ ký của J&T tạo/xác nhận**. Đổi môi trường/giao thức phải nhập lại privateKey và password nghiệp vụ; không tự mang khóa thử nghiệm sang production.
2. Ví dụ hành trình dùng mã 100/94 trong khi FAQ nêu 113/112. Chưa chọn một bảng trạng thái để tự hoàn tất đơn hay thu COD. Adapter đọc đúng billCode, giữ thông tin raw, trả trạng thái chưa ánh xạ. Callback J&T đang trả 501 để không cập nhật đơn theo hợp đồng callback cũ chưa được xác minh.
3. Đơn hiện lưu `address` và `city` dạng chuỗi, chưa có nguồn cấu trúc xã/phường J&T đã đối chiếu. Create/quote yêu cầu `receiver` có `prov`, `area`, địa chỉ chi tiết; không tách chuỗi theo suy đoán, không gán Hà Nội hoặc số điện thoại giả. Địa chỉ mới hai cấp có thể bỏ `city` theo trang tạo đơn; vẫn phải xác minh mã/tên `prov/area` của tài khoản.
4. In nhãn là POST có chữ ký. Kết quả tạo đơn trả `labelUrl:null`; không dựng đường dẫn GET chứa mã khách hàng. Chưa nghiệm thu phục vụ PDF/ảnh nhãn từ phản hồi in nhãn.

## Trạng thái trong quản trị

Migration `jt-vietnam-protocol.sql` hủy verified/enabled J&T legacy chưa có marker giao thức. Lần migrate sau không xóa proof tài khoản đã được kiểm tra theo giao thức mới.

Kiểm tra J&T chỉ gọi `vip/checkCusPwd`, lưu marker protocol/môi trường/config version và phạm vi `account_lookup`. Một phản hồi thành công được hiển thị là **đã xác thực tài khoản**, không phải nghiệm thu vận đơn. Kết quả không bật hãng, không đưa hãng ra checkout. Nút bật J&T bị khóa và API bật trả 501 cho đến khi hoàn tất nghiệm thu luồng vận đơn, địa chỉ và trạng thái.

Khóa và password nghiệp vụ được lưu trong cấu hình mã hóa. API chỉ trả cờ đã cấu hình; không trả lại password/privateKey/webhookSecret hoặc đưa chúng vào audit/log. Lỗi từ hãng được thay bằng thông báo cố định vì thông báo từ xa có thể lặp lại dữ liệu gửi đi. Các mutation không có xác nhận rõ, kể cả HTTP lỗi, được gắn `ambiguous` để đối soát trước khi thử lại.

## Điều kiện nghiệm thu còn lại

- Xác nhận ứng dụng Open Platform của GAERU đã được J&T duyệt và cấp quyền đúng môi trường; tài liệu portal mô tả quy trình đăng ký, chứng thực developer, liên kiểm thử và duyệt lên production.
- Nhập customerCode, apiAccount, privateKey và prepared business password trong quản trị; không gửi bí mật qua chat.
- J&T xác nhận approved signature vector và bảng status/callback đúng tài khoản, bao gồm lỗi, replay, thứ tự sự kiện và điều kiện hoàn trả/COD.
- Hoàn thiện nguồn địa chỉ và thông số kiện hàng thực tế, rồi chạy thử tạo/hủy/in/tra cứu/báo giá trên sandbox của GAERU; không dùng account mẫu công khai làm bằng chứng quyền tài khoản.
- Xác nhận kết quả tại hệ thống hãng trước khi mở production; kiểm tra tài khoản riêng lẻ không chứng minh quyền tạo/hủy hoặc thanh toán COD.

Các kiểm thử J&T lần này dùng provider giả lập và PGlite trong bộ kiểm thử riêng; chưa phải nghiệm thu J&T trên máy chủ PostgreSQL hoặc API thật. Không có vận đơn, thu tiền, thay đổi đơn GAERU hoặc phiên đăng nhập nhà cung cấp được thực hiện trong lần kiểm tra này. Không dismiss/suppress cảnh báo CodeQL MD5; đây vẫn là giới hạn mật mã của giao thức bên ngoài cần quản lý.
