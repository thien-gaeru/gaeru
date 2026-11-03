# Kết nối và đồng bộ sàn trong quản trị

## Cấu hình

Vào **Quản lý Sàn TMĐT** hoặc **Cài đặt cửa hàng**, mở cửa sổ cấu hình của Shopee, TikTok Shop hoặc Lazada. Lưu khóa ứng dụng, mã gian hàng và Access Token được cấp cho đúng ứng dụng/gian hàng. Với TikTok cần **Shop Cipher** từ API Get Authorized Shops; Open ID không thay thế được Shop Cipher. Có thể lưu ngày hết hạn token theo ISO 8601 và Refresh Token để giữ thông tin cấp quyền.

Khóa ứng dụng và token được mã hóa trong cơ sở dữ liệu. API quản trị chỉ trả cờ đã cấu hình; không điền lại khóa vào trình duyệt. Thay đổi cần mật khẩu và phương thức xác thực hiện tại của chủ. Bản này dùng token do đối tác cấp/đổi thông qua công cụ được nhà cung cấp cho phép, chưa tự chạy OAuth hoặc tự gia hạn Refresh Token. Khi hết hạn, nhập token mới và xác minh lại; không có token giả dự phòng.

Ở khối **Đồng bộ đơn hàng & tồn kho sàn**, mở **Xác minh quyền đọc**. Kiểm tra này gọi API đọc danh sách đơn, không tạo/sửa đơn sàn hoặc số lượng tồn. Trạng thái xác minh gắn với fingerprint của khóa, token và gian hàng; thay đổi cấu hình hoặc token hết hạn làm trạng thái cũ mất hiệu lực.

## Mapping và đồng bộ

1. Tìm biến thể theo SKU/tên nội bộ. Nhập Shop/Seller ID, SKU người bán trên sàn và định danh sản phẩm thực. Shopee dùng Item ID + Model ID (0 cho sản phẩm không model); TikTok dùng Product ID + SKU ID; Lazada dùng Seller SKU. ID sàn không được tự suy ra từ SKU nội bộ.
2. Lưu cùng channel/Shop ID/SKU sàn sẽ cập nhật mapping tương ứng. Có thể bỏ mapping; thao tác không xóa đơn hoặc sửa lịch sử kho đã ghi nhận.
3. **Lấy đơn** nhận các đơn trong 1–3 ngày gần nhất. Mặc định chỉ nhập để xem. Khi chọn trừ tồn, thiếu mapping hoặc thiếu tồn khiến toàn bộ thao tác của đơn đó rollback và trả lỗi; không trừ một phần rồi đánh dấu đã trừ xong. Chỉ chọn trừ tồn nội bộ nếu kho này đang dùng chung và đã đối chiếu quy trình với sàn. Phân trang có giới hạn an toàn 20 trang (50 đơn/trang); cursor lặp hoặc vượt giới hạn sẽ dừng và yêu cầu khoảng ngày ngắn hơn, không báo đã nhận hết.
4. **Gửi tồn lên sàn** yêu cầu xác minh đọc thành công với cấu hình hiện tại và có mapping đầy đủ của đúng gian hàng. Người quản trị xác nhận thao tác trước khi gửi. Các mục thiếu mapping được báo bỏ qua; mục bị sàn từ chối không được tính là cập nhật thành công.
5. Danh sách đơn, trạng thái trừ/hoàn tồn và các lần đồng bộ thủ công xuất hiện trong cùng khối. Chứng từ đối soát/lợi nhuận thủ công cũ được giữ nguyên.

Public `/api/marketplace/:channel/webhook` hiện trả 501 trước khi đọc/ghi dữ liệu. Các hàm chữ ký giả lập không đủ chứng minh giao thức callback thật. Chỉ mở lại sau khi có tài liệu, raw body, chữ ký/replay protection, shop binding và nghiệm thu theo từng sàn.

## Giới hạn nghiệm thu

Kiểm thử phần mềm dùng dịch vụ giả lập, không xác nhận ứng dụng đã được sàn phê duyệt quyền API. Cần token thật, sandbox hoặc cửa hàng thử của từng sàn để đối chiếu quyền, tiền tệ VND, ngày giờ, trạng thái, chi tiết từng sản phẩm, mapping, tồn và webhook trước khi dùng với kho vận hành. Không chuyển giá trị `success` từ việc lưu khóa thành trạng thái đã xác minh.

Tài liệu chính thức dùng để đối chiếu:

- [TikTok: Get Authorized Shops](https://partner.tiktokshop.com/docv2/page/6507ead7b99d5302be949ba9)
- [TikTok: tham số chung và chữ ký](https://partner.tiktokshop.com/docv2/page/common-parameters)
- [Lazada: đơn và chi tiết sản phẩm](https://open.lazada.com/apps/doc/doc?docId=121327&nodeId=29616)
- [Lazada: chữ ký API](https://open.lazada.com/apps/doc/doc?docId=108068&nodeId=10400)
- [Shopee Open Platform](https://open.shopee.com/developer-guide/16) (tài liệu chi tiết yêu cầu tài khoản; lần truy cập tự động của audit bị 403).
