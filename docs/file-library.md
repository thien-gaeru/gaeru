# Thư viện tệp trong quản trị GAERU

Chủ doanh nghiệp mở **Thư viện tệp** trong menu quản trị, hoặc `/gaeru_ceo#file-library`.
Mục **Vị trí lưu trữ thực tế** cho biết MEDIA_ROOT được Node.js đọc trực tiếp; không phụ thuộc thư mục gốc mà File Manager của Hostinger hiển thị.

## Thao tác

- Duyệt các nhóm Sản phẩm, Bài viết, Banner, Video, Tệp hội thoại, Tài liệu, Tài liệu bài viết và Ảnh thu nhỏ; tìm tên tệp, lọc thư mục con và phân trang 36 tệp.
- Xem trước ảnh và video; tải tệp gốc xuống. PDF, TXT, CSV và các định dạng cũ không xem trước được sẽ tải xuống thay vì chạy trong trang quản trị.
- Tạo thư mục con, tải tối đa 10 tệp mỗi lượt; ảnh tối đa 8 MB, tài liệu 10 MB, MP4 25 MB. Tệp được đặt tên vật lý UUID; tên hiển thị lưu riêng trong PostgreSQL.
- Đổi tên hiển thị, di chuyển giữa thư mục con trong cùng nhóm, chuyển vào thùng rác và khôi phục đối với tệp do thư viện tải lên chưa có liên kết hệ thống.
- Xóa vĩnh viễn cần chọn tệp trong thùng rác và đánh dấu xác nhận. Không tự xóa theo thời gian.

Ảnh mới dùng bộ tối ưu WebP chung hiện có (quality 90, alpha 100, cạnh tối đa 1600, không phóng lớn). Bộ này không phải mã hóa lossless. Xem trước, tải xuống và di chuyển không mã hóa lại tệp. Việc chuyển dữ liệu cũ không được chạy lại.

Tệp tải vào thư viện chỉ dùng trong quản trị; không tự xuất bản, không tự đổi ảnh sản phẩm/bài viết. Tệp đã được liên kết qua các bảng ảnh sản phẩm, bài viết, banner, video, chat hoặc nằm trong danh sách chuyển kho được bảo vệ: xem/tải xuống được nhưng chỉnh sửa/xóa phải thực hiện trong chức năng nội dung liên quan. Thư viện không thay thế trình chỉnh sửa sản phẩm.

## Lưu trữ và bảo vệ

Tệp nằm dưới MEDIA_ROOT, thư mục con mới có mã UUID, quyền tạo mặc định 700/600. Metadata và trạng thái thùng rác nằm trong `media_library_files` và `media_library_folders` của cơ sở dữ liệu gốc. Thùng rác là trạng thái ẩn, không đổi đường dẫn file; khôi phục giữ nguyên byte. Cần sao lưu cả cơ sở dữ liệu và MEDIA_ROOT.

Chỉ tài khoản chủ doanh nghiệp bootstrap được truy cập, kể cả tải xuống/xem trước; nhân viên có vai trò admin không mặc nhiên đọc được tệp chat. Mọi thay đổi cần CSRF, giới hạn tần suất và ghi nhật ký. Không có `express.static(MEDIA_ROOT)`. Chặn traversal, symlink và tệp thực thi; tên thư mục/tệp do người dùng nhập không được dùng làm đường dẫn vật lý.

Xóa vĩnh viễn di chuyển tạm tệp vào tên ẩn, ghi thay đổi và nhật ký trong transaction, hoàn tác nếu transaction lỗi rồi mới dọn tệp tạm. Nếu tiến trình dừng đột ngột trong khoảng này, quản trị viên hệ thống cần đối chiếu tệp ẩn `.UUID.deleting` với metadata trước khi dọn. Di chuyển tệp cũng hoàn tác khi transaction thất bại; không sửa các tệp đang phục vụ nội dung.

Quét thư mục được giới hạn 10.000 mục và không đi theo symlink. Dung lượng thống kê là các tệp media hợp lệ trong các nhóm hỗ trợ, không phải toàn bộ ổ đĩa. Thư viện không đọc thư mục hệ thống hoặc mở quyền public cho tài liệu.

## Kiểm tra

`node --test test/file-library.integration.test.js test/file-library-ui.test.js test/filesystem-media.test.js` kiểm tra xác thực/quyền, CSRF, upload ảnh WebP/PDF/video, tải xuống riêng tư, byte range video, thư mục thật, di chuyển/đổi tên/thùng rác/khôi phục, rollback xóa, liên kết hệ thống, traversal/symlink và escape tên tệp. Toàn bộ bộ kiểm thử dùng `npm test`.

Ảnh giao diện đóng gói được lưu bền vững và phục vụ qua URL cũ theo [quy ước liên kết và ảnh](primary-links-and-assets.md).
