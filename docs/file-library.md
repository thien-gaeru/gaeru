# Thư viện tệp trong quản trị GAERU

Chủ doanh nghiệp mở **Thư viện tệp** trong menu quản trị, hoặc `/gaeru_ceo#file-library`.
Mục **Vị trí lưu trữ thực tế** cho biết MEDIA_ROOT được Node.js đọc trực tiếp; không phụ thuộc thư mục gốc mà File Manager của Hostinger hiển thị.

## Thao tác

- Duyệt các nhóm Sản phẩm, Bài viết, Banner, Video, Tệp hội thoại, Tài liệu, Tài liệu bài viết và Ảnh thu nhỏ; tìm tên tệp, lọc thư mục con và phân trang 36 tệp.
- Xem trước ảnh và video; tải tệp gốc xuống. PDF, TXT, CSV và các định dạng cũ không xem trước được sẽ tải xuống thay vì chạy trong trang quản trị.
- Tạo thư mục con, tải tối đa 10 tệp mỗi lượt; ảnh tối đa 8 MB, tài liệu 10 MB, MP4 25 MB. Tệp được đặt tên vật lý UUID; tên hiển thị lưu riêng trong PostgreSQL.
- Đổi tên hiển thị, di chuyển giữa thư mục con trong cùng nhóm, chuyển vào thùng rác và khôi phục đối với tệp do thư viện tải lên chưa có liên kết hệ thống.
- Xóa vĩnh viễn cần chọn tệp trong thùng rác và đánh dấu xác nhận. Các nhóm ngoài **Tệp hội thoại** không tự xóa theo thời gian.

Ảnh mới dùng bộ tối ưu WebP chung hiện có (quality 90, alpha 100, cạnh tối đa 1600, không phóng lớn). Bộ này không phải mã hóa lossless. Xem trước, tải xuống và di chuyển không mã hóa lại tệp. Việc chuyển dữ liệu cũ không được chạy lại.

Tệp tải vào thư viện chỉ dùng trong quản trị; không tự xuất bản, không tự đổi ảnh sản phẩm/bài viết. Tệp đã được liên kết qua các bảng ảnh sản phẩm, bài viết, banner, video, chat hoặc nằm trong danh sách chuyển kho được bảo vệ: xem/tải xuống được nhưng chỉnh sửa/xóa phải thực hiện trong chức năng nội dung liên quan. Ngoại lệ là thao tác **Xóa tệp hội thoại** được mô tả bên dưới; thao tác này không mở quyền đổi tên, di chuyển hay đưa tệp đang được liên kết vào thùng rác. Thư viện không thay thế trình chỉnh sửa sản phẩm.

## Tệp hội thoại: thời hạn và xóa

Tệp đính kèm hội thoại được lưu 30 ngày tính từ thời điểm tạo tệp (`shopping_chat_files.created_at`), kể cả khi hội thoại đã đóng. Từ mốc 30 ngày, đường tải tệp trong hội thoại trả trạng thái 410 và giao diện hiển thị **Tệp đã hết hạn lưu trữ 30 ngày.** Nội dung tin nhắn và thông tin tệp vẫn được giữ để đọc lại lịch sử.

Tác vụ dọn tệp chạy khi ứng dụng khởi động rồi mỗi giờ, xử lý theo từng đợt giới hạn. Tác vụ đánh dấu tệp hết hạn, xóa nội dung hoặc tham chiếu của tệp đính kèm và ghi nhật ký. Các bản sao trong nhóm `chat/` không còn được sử dụng cũng được dọn khi đã cũ ít nhất 30 ngày theo thời gian sửa đổi trên ổ đĩa. Vì vậy, việc giải phóng dung lượng có thể diễn ra sau thời điểm tệp hết hạn.

Quyền `chat.files.delete` mặc định thuộc chủ doanh nghiệp và vai trò admin; quyền quản lý khách hàng không tự cấp quyền này. Người có quyền và được phép mở hội thoại có thể chọn **Xóa tệp** trong chat trước hạn 30 ngày. Chủ doanh nghiệp còn có thể chọn **Xóa tệp hội thoại** trong thư viện, kể cả với tệp chat đang có liên kết hệ thống hoặc bản sao chat không còn liên kết. Cả hai thao tác đều yêu cầu xác nhận, kiểm tra quyền phía máy chủ, bảo vệ CSRF và ghi nhật ký. Tệp bị xóa thủ công hiển thị **Tệp đã được quản trị viên xóa.** trong lịch sử; thao tác này không đi qua thùng rác và không khôi phục được tệp đính kèm.

Tệp vật lý chỉ bị xóa khi không còn tham chiếu đang sử dụng từ sản phẩm, bài viết, banner, video, tệp hội thoại, thư viện hoặc ảnh giao diện. Tệp còn trong thùng rác của thư viện cũng được giữ để có thể khôi phục. Nếu có bản dùng chung, liên kết trong hội thoại vẫn bị gỡ nhưng bản dùng chung được giữ. Khi xóa trên ổ đĩa thất bại, yêu cầu được lưu để thử lại mỗi giờ; tệp đã hết hạn hoặc đã xóa vẫn không tải được qua hội thoại. Gửi lại yêu cầu xóa không làm tệp xuất hiện lại.

## Lưu trữ và bảo vệ

Tệp nằm dưới MEDIA_ROOT, thư mục con mới có mã UUID, quyền tạo mặc định 700/600. Metadata và trạng thái thùng rác nằm trong `media_library_files` và `media_library_folders` của cơ sở dữ liệu gốc. Thùng rác là trạng thái ẩn, không đổi đường dẫn file; khôi phục giữ nguyên byte. Cần sao lưu cả cơ sở dữ liệu và MEDIA_ROOT.

Chỉ tài khoản chủ doanh nghiệp bootstrap được truy cập thư viện, kể cả tải xuống/xem trước. Quyền `chat.files.delete` của vai trò admin cho phép xóa trong hội thoại được phép truy cập, không cấp quyền mở toàn bộ thư viện. Mọi thay đổi cần CSRF, giới hạn tần suất và ghi nhật ký. Không có `express.static(MEDIA_ROOT)`. Chặn traversal, symlink và tệp thực thi; tên thư mục/tệp do người dùng nhập không được dùng làm đường dẫn vật lý.

Xóa vĩnh viễn từ thùng rác di chuyển tạm tệp vào tên ẩn, ghi thay đổi và nhật ký trong transaction, hoàn tác nếu transaction lỗi rồi mới dọn tệp tạm. Nếu tiến trình dừng đột ngột trong khoảng này, quản trị viên hệ thống cần đối chiếu tệp ẩn `.UUID.deleting` với metadata trước khi dọn. Di chuyển tệp cũng hoàn tác khi transaction thất bại; không sửa các tệp đang phục vụ nội dung. Riêng xóa tệp hội thoại dùng hàng đợi dọn tệp sau khi thay đổi cơ sở dữ liệu đã được lưu thành công.

Quét thư mục được giới hạn 10.000 mục và không đi theo symlink. Dung lượng thống kê là các tệp media hợp lệ trong các nhóm hỗ trợ, không phải toàn bộ ổ đĩa. Thư viện không đọc thư mục hệ thống hoặc mở quyền public cho tài liệu.

## Kiểm tra

`node --test test/file-library.integration.test.js test/file-library-ui.test.js test/filesystem-media.test.js test/chat-file-retention.integration.test.js test/chat-retention-ui.test.js` kiểm tra xác thực/quyền, CSRF, upload ảnh WebP/PDF/video, tải xuống riêng tư, byte range video, thư mục thật, di chuyển/đổi tên/thùng rác/khôi phục, rollback xóa, liên kết hệ thống, traversal/symlink và escape tên tệp. Các kiểm thử hội thoại còn kiểm tra mốc hết hạn 30 ngày, quyền xóa, xóa lặp, bản dùng chung, thử lại sau lỗi, tệp GIF, thông báo thay tệp đã xóa và việc nén không làm tệp xuất hiện lại. Toàn bộ bộ kiểm thử dùng `npm test`.

Ảnh giao diện đóng gói được lưu bền vững và phục vụ qua URL cũ theo [quy ước liên kết và ảnh](primary-links-and-assets.md).
