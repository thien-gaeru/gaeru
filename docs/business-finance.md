# Quản trị lương, đối chiếu thuế, hồ sơ hóa đơn và sàn TMĐT

## Những phần đang sử dụng được

| Mục quản trị | Chức năng |
| --- | --- |
| Tính lương | Lương tháng, lương giờ hoặc kết hợp; ngày công/định mức tự khai; phụ cấp, thưởng, hoa hồng; BH/TNCN/tạm ứng/khấu trừ đã đối chiếu; duyệt và ghi nhận chứng từ chi thực tế |
| Đối chiếu thuế | Chứng từ đầu vào/đầu ra theo tháng, VAT thực tế, VAT đủ điều kiện khấu trừ do kế toán xác nhận; tổng hợp chứng từ đã duyệt |
| Hóa đơn điện tử | Hồ sơ yêu cầu từ đơn website đã hoàn tất và thanh toán; thông tin người mua và bản chụp chi tiết đơn; kiểm tra/duyệt hồ sơ trước khi kết nối nhà cung cấp |
| Sàn TMĐT & lợi nhuận | Đối soát nhập thủ công theo Shopee/TikTok Shop/Lazada, gian hàng và mã đơn; doanh thu thuần, hoàn tiền để đối chiếu, phí và giá vốn; lợi nhuận đóng góp chỉ khi đủ số liệu |

Bản nâng cấp **chưa kết nối API thật với MISA eShop hoặc các sàn**, vì doanh nghiệp chưa cấp quyền. Không có tác vụ nền tự tải đơn, webhook, token hay trạng thái kết nối giả. Dữ liệu thủ công không tạo đơn website, không trừ tồn và không gọi ngân hàng. Hồ sơ hóa đơn không có số hóa đơn pháp định, chưa ký số/phát hành; API phát hành trả lỗi chưa cấu hình. MISA eShop không được tự coi là đã có quyền đối với MISA AMIS Kế toán hoặc dịch vụ hóa đơn điện tử.

## Cách tính và giới hạn

- Lương tháng tính theo lương thỏa thuận × ngày công / định mức; lương giờ tính đơn giá đã xác nhận × số phút / 60. Làm tròn từng phần đến VND bằng số nguyên, sau đó cộng phụ cấp/thưởng/hoa hồng và trừ các khoản đã đối chiếu. Không tự tính thuế TNCN lũy tiến, giảm trừ gia cảnh, tỷ lệ bảo hiểm hoặc hệ số tăng ca pháp định. Với lương giờ, phần lương tháng/ngày công tháng bằng 0; với lương tháng, phần giờ bằng 0. Chưa có chấm công, hợp đồng, bảng lương hàng loạt hoặc phiếu lương tự gửi nhân viên.
- Thu nhập thực lĩnh không được âm. Chi phí nhân sự = tổng thu nhập trước khấu trừ + khoản đóng góp riêng của doanh nghiệp. Ghi “đã chi” cần mã chứng từ thực tế, chỉ ghi nhận sổ và không chuyển tiền. Module không tự tạo thêm phiếu chi ở sổ cũ để tránh trùng số liệu; báo cáo tài chính cũ chưa tự cộng chi phí lương mới.
- VAT chênh lệch = VAT đầu ra đã duyệt − VAT đầu vào đã xác nhận được khấu trừ. Đây là đối chiếu chứng từ, chưa bao gồm số dư chuyển kỳ, điều chỉnh, các sắc thuế khác, tờ khai hoặc nghĩa vụ thuế phải nộp. Thuế suất và điều kiện khấu trừ không được tự suy đoán.
- Doanh thu thuần sàn là số đã trừ giảm giá/hoàn tiền, chưa gồm VAT, do người đối soát nhập. Tiền hoàn là số tham chiếu và không trừ lần thứ hai. Lợi nhuận đóng góp = doanh thu thuần − phí sàn − giá vốn − quảng cáo phân bổ − giao nhận − chi phí khác. Chỉ tổng hợp chứng từ đã duyệt và đã đối soát; để trống bất kỳ chi phí nào thì kết quả lợi nhuận là **chưa đủ dữ liệu**, không mặc định bằng 0. Đây chưa phải lợi nhuận sau thuế toàn doanh nghiệp và không cộng lẫn doanh thu website chưa có giá vốn.
- Mỗi mã nhân viên chỉ có một chứng từ lương còn hiệu lực trong một tháng. Mã đơn sàn không trùng trong cùng sàn/gian hàng, kể cả nhập sang tháng khác. Một đơn website chỉ có một hồ sơ hóa đơn còn hiệu lực. Số tiền mỗi trường tối đa 1.000 tỷ VND, tổng tính toán tối đa 9.000 tỷ VND. Thử lại cùng mã yêu cầu phải có cùng nội dung và người tạo.

## Quyền và kiểm soát

Chủ/quản trị viên có toàn quyền. Kế toán được lập và xem các chứng từ nhưng không tự duyệt. Quản lý được đối soát/duyệt sàn, xem thuế/hồ sơ hóa đơn; không đọc lương hoặc duyệt thuế/hóa đơn. Người lập không tự duyệt, trừ chủ/quản trị viên được xử lý ngoại lệ. Các vai trò kinh doanh, kho và chỉ xem không được truy cập những mục mới này.

Chứng từ lưu bản chụp dữ liệu, không sửa trực tiếp. Sai bản nháp thì hủy có lý do và tạo lại; hủy chứng từ đã duyệt cần quyền duyệt. Lương đã ghi nhận chi không thể hủy/sửa; cần quy trình điều chỉnh riêng. Không xóa lịch sử; kiểm tra phiên bản để chặn hai người ghi đè nhau. Nhật ký chung chỉ ghi mã chứng từ/kỳ/thao tác, không ghi số lương chi tiết để tránh lộ qua quyền đọc nhật ký.

## Điều kiện để làm kết nối tự động

1. Xác định hosting và IP máy chủ gọi API. Trong MISA eShop, chuẩn bị kết nối tại **Ứng dụng → Open API**, đăng ký thông tin ứng dụng/IP và xác thực liên hệ theo [hướng dẫn MISA](https://helpeshop.misa.vn/kb/ket-noi-voi-cac-ung-dung-khac-qua-open-api-tren-may-tinh). Kiểm tra kết nối hiện có trước vì mỗi cửa hàng chỉ hỗ trợ một kết nối. Tài liệu công khai hiện mô tả khách hàng/đơn hàng; phạm vi dữ liệu phí, giá vốn và đối soát phải được xác nhận riêng.
2. Cấp quyền ứng dụng cho từng gian hàng Shopee, TikTok Shop và Lazada; xác nhận quyền đọc đơn, hoàn trả và đối soát tài chính. Không chỉ dựa vào doanh số hiển thị để tính tiền thực nhận/lợi nhuận. Tham khảo [TikTok Shop Partner Center](https://partner.tiktokshop.com/docv2/api-document) và [ủy quyền Lazada](https://open.lazada.com/apps/doc/doc?docId=108260&nodeId=10533).
3. Xác nhận dịch vụ hóa đơn điện tử, mẫu/ký hiệu, dữ liệu thuế, chữ ký số và môi trường thử nghiệm. Cấu hình thông tin bí mật trên máy chủ; không đưa vào Git, chat hay biểu mẫu nhập chứng từ.
4. Sau khi có quyền, còn phải viết/kiểm thử adapter theo tài liệu được cấp, ánh xạ SKU/đơn và số liệu phí, bảo vệ token, phân trang/gọi lại, kiểm tra webhook và chống đồng bộ lặp. Nghiệm thu trên dữ liệu thử trước khi bật tự động hoặc phát hành hóa đơn thật.

## Cập nhật

Chạy `npm run db:migrate` để áp dụng `business.sql` (bản cục bộ tự áp dụng khi mở lại). Chạy `npm test` để kiểm tra tính toán, quyền riêng tư lương, chứng từ bất biến, hồ sơ hóa đơn chưa phát hành và thiếu giá vốn. Chưa thực hiện triển khai/migration production hoặc kết nối tài khoản nhà cung cấp trong lần cập nhật này.
