# Quản trị GAERU cho một doanh nghiệp, nhiều nhân viên và kho

Bản nâng cấp giữ nguyên cửa hàng Node.js/PostgreSQL và bổ sung các nghiệp vụ vận hành có lưu dữ liệu thật. Không dùng dữ liệu minh họa làm giá, tồn kho hoặc chứng từ của doanh nghiệp; bản xem trước được chạy trên cơ sở dữ liệu mẫu riêng.

## Các nghiệp vụ đã triển khai

| Nhóm | Chức năng |
| --- | --- |
| Bán hàng | Sản phẩm, phiên bản/SKU, giá, ảnh, trạng thái hiển thị; khách hàng; tìm kiếm và xử lý đơn; thu tiền COD và chuyển khoản thủ công |
| Nhiều kho | Tồn khả dụng theo kho; điều chuyển; điều chỉnh có quyền duyệt, lý do và số lượng đối chiếu; sổ biến động bất biến |
| Mua hàng | Nhà cung cấp; đơn mua nháp → trình duyệt → phê duyệt; nhận từng phần hoặc nhận đủ; phiếu nhập bất biến |
| Công nợ và thu chi | Phải thu theo đơn; phiếu thu từng phần; phải trả theo giá trị hàng thực nhận; đề nghị chi nhà cung cấp và chi phí cần phê duyệt |
| Tổ chức | Phòng ban, tài khoản nhân viên, vai trò, khóa tài khoản, đổi mật khẩu và thu hồi phiên đăng nhập khi thay đổi quyền |
| Kiểm soát | Phân quyền ở API và giao diện; tách người lập/người duyệt; chống ghi nhận lặp; đối chiếu tồn; nhật ký thao tác có người thực hiện |
| Báo cáo | Đơn bán theo ngày, số đã thu/còn phải thu, mặt hàng, nhập hàng, khoản đã chi và tổng tồn khả dụng |

## Vai trò

- **Chủ doanh nghiệp:** tài khoản khởi tạo từ cấu hình máy chủ, giữ quyền quản trị khi chưa có nhân viên. Không sửa hoặc xóa tài khoản này bằng API nhân viên.
- **Quản trị viên:** toàn quyền vận hành và quản lý nhân viên.
- **Quản lý:** điều phối, phê duyệt kho/mua hàng/thu chi và đọc báo cáo; không tự cấp quyền nhân viên hoặc thay cấu hình cửa hàng.
- **Kinh doanh:** sản phẩm, tồn, khách hàng và xử lý đơn; không tự ghi nhận thanh toán.
- **Nhân viên kho:** xem tồn, điều chuyển, lập đơn mua và nhận hàng đã được duyệt; không tự duyệt điều chỉnh hoặc đơn mua.
- **Kế toán:** công nợ, phiếu thu, đề nghị chi, báo cáo; không tự duyệt chi.
- **Chỉ xem:** tra cứu số liệu, không thay đổi dữ liệu.

Người lập hoặc người trình duyệt không được tự duyệt đơn mua của mình; người lập đề nghị chi không được tự duyệt. Chủ doanh nghiệp và quản trị viên có quyền xử lý ngoại lệ này và mọi thao tác đều được ghi nhật ký. Thay đổi vai trò, mật khẩu hoặc trạng thái tài khoản làm phiên cũ hết hiệu lực ở yêu cầu tiếp theo.

## Quy tắc kho

`product_variants.stock_quantity` là tổng **tồn có thể bán**, khớp tổng các số dư `warehouse_stock`. Đặt hàng giữ hàng theo phân bổ từng kho và giảm tồn khả dụng ngay; chuyển trạng thái giao hàng không trừ tồn lần nữa. Hủy đơn chưa thu tiền hoàn đúng phân bổ, một lần. Kho đang có tồn, đơn đang phân bổ hoặc đơn mua đang mở không thể bị ngừng hoạt động.

Lần chuyển đổi đầu tiên đưa số tồn tổng đang có vào kho `MAIN` và lập số dư mở đầu. Không tạo lịch sử kho giả trước thời điểm chuyển đổi. Đơn cũ chưa có phân bổ được hoàn vào `MAIN` bằng sự kiện `legacy_sale_release`, với ghi chú quy tắc chuyển đổi riêng. Cần đối chiếu số dư và đơn đang mở với thực tế trước khi đưa bản nâng cấp vào vận hành.

Các phiếu nhập, biến động kho và phiếu thu đã ghi nhận không được sửa/xóa qua API. Thử lại cùng mã yêu cầu không được làm tăng tồn hoặc số tiền lần thứ hai; đổi nội dung nhưng dùng lại mã bị từ chối.

## Quy tắc tiền và báo cáo

Phiếu thu/chi chỉ **ghi nhận giao dịch đã diễn ra bên ngoài**; hệ thống không chuyển tiền ngân hàng. VNPAY/9Pay không nhận phiếu thu thủ công. 9Pay trong bộ lọc chỉ phục vụ dữ liệu lịch sử; chưa có tích hợp thanh toán 9Pay mới.

Đơn thu một phần được giữ số dư còn phải thu. Khi thu đủ, trạng thái thanh toán được cập nhật; COD chỉ ghi nhận sau bước giao hàng. Đơn đã có phiếu thu không được hủy hoặc đổi phí giao hàng khi chưa xử lý đối soát/hoàn tiền. Các khoản đã thanh toán trước bản nâng cấp tiếp tục được tính từ đơn hàng; danh sách phiếu thu chỉ liệt kê các phiếu mới có sổ chi tiết.

Phải trả nhà cung cấp được tính từ hàng thực nhận trừ khoản chi đã được duyệt, không từ toàn bộ giá trị đơn mua chưa nhập. Hệ thống kiểm tra lại số dư lúc duyệt để không chi vượt công nợ. Đề nghị chưa duyệt không được tính là đã chi.

Báo cáo bán hàng dùng ngày tạo đơn theo múi giờ Việt Nam; số đã thu là số được ghi nhận đến hiện tại của nhóm đơn trong kỳ. Đây là báo cáo vận hành, không phải báo cáo lợi nhuận, dòng tiền đầy đủ hoặc sổ kế toán pháp định. Chưa tính giá vốn lịch sử, thuế hoặc xuất hóa đơn điện tử.

## Cài đặt và kiểm tra

1. Sao lưu mã nguồn và PostgreSQL, rồi triển khai nhánh này lên môi trường kiểm thử.
2. Chạy `npm ci` và `npm run db:migrate`. Bốn tập lệnh được áp dụng trong một giao dịch; `schema_migrations` ghi phiên bản và ngăn chạy lặp các chuyển đổi đã áp dụng.
3. Chạy `npm test`. Bộ kiểm tra tích hợp dùng PostgreSQL nhúng PGlite, tạo dữ liệu riêng, chạy các luồng liên phòng ban và kiểm tra dữ liệu sau mỗi thao tác.
4. Chạy `npm start`, đăng nhập tài khoản chủ cấu hình bằng biến môi trường, đối chiếu số dư kho `MAIN`, rồi tạo phòng ban, nhân viên và các kho thực tế.

Các kiểm tra PGlite không thay thế kiểm thử nhiều kết nối PostgreSQL thật, tải đồng thời, khôi phục sao lưu hoặc thanh toán merchant. Cấu hình máy chủ, secrets và dữ liệu production không được đưa vào Git.

## Phạm vi cần mở rộng theo quy trình doanh nghiệp

Tính lương, đối chiếu VAT, hồ sơ hóa đơn và đối soát sàn thủ công đã bổ sung ở [module tài chính mở rộng](business-finance.md); kết nối API đang chờ cấp quyền. Chưa có chấm công, quản lý hợp đồng lao động, đổi trả/hoàn tiền tự động, giá vốn theo lô, kế toán thuế, hóa đơn điện tử, kết nối hãng vận chuyển, MFA/SSO hoặc giới hạn quyền riêng theo từng kho. Vai trò kho trong bản này thao tác trên các kho của cùng doanh nghiệp; chưa có mô hình nhiều doanh nghiệp độc lập. Những nghiệp vụ này cần chính sách, dữ liệu đầu vào và thông số tích hợp riêng trước khi có thể triển khai và nghiệm thu.
