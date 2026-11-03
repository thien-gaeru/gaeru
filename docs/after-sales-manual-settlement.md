# Đối soát hoàn tiền và giới hạn đổi hàng RMA

Hệ thống không chuyển tiền qua ngân hàng hoặc cổng thanh toán khi đóng RMA. Nhân sự có quyền `orders.write` và `payments.write` chỉ ghi nhận chứng từ của giao dịch hoàn tiền đã thực hiện, sau khi đối chiếu với ngân hàng hoặc phiếu chi tiền mặt.

## Đóng hồ sơ trả hàng

1. Duyệt yêu cầu và xác nhận đã nhận hàng trả. Ghi kết quả thẩm định, chọn tái nhập kho trước khi đóng hồ sơ nếu hàng đủ điều kiện.
2. Đối chiếu số tiền đã thu. API danh sách hồ sơ trả về `refundable_amount_vnd`: tổng đơn nếu đã thanh toán đủ; tổng phiếu thu nếu chỉ thu một phần. Quy trình hiện tại áp dụng trả toàn bộ đơn.
3. Thực hiện hoàn tiền ngoài hệ thống. Kiểm tra giao dịch đã thành công và lưu mã giao dịch hoặc số phiếu chi.
4. Gửi `PATCH /api/gaeru_ceo/orders/after-sales/:id` với phiên bản hiện tại, trạng thái `resolved`, ghi chú xử lý và chứng từ:

```json
{
  "version": 3,
  "status": "resolved",
  "resolution": "Đã đối chiếu giao dịch hoàn tiền với chứng từ ngân hàng",
  "manualRefund": {
    "amountVnd": 200000,
    "method": "bank_transfer",
    "reference": "Mã giao dịch ngân hàng thực tế",
    "confirmedSent": true
  }
}
```

`method` nhận `cash` hoặc `bank_transfer`. Số tiền phải khớp toàn bộ số tiền đã thu; mã chứng từ có từ 5 đến 160 ký tự. Không gửi `manualRefund` cho đơn chưa thu tiền. API từ chối thiếu chứng từ, sai số tiền hoặc thiếu quyền thanh toán và giữ hồ sơ ở trạng thái đang xử lý.

Số tiền được lưu ở `refund_amount_vnd`; mã chứng từ, phương thức và xác nhận của người thao tác được lưu trong nhật ký kiểm toán. Phản hồi `settlementScope: manual_refund_recorded` có nghĩa đã ghi nhận chứng từ thủ công, không phải xác nhận giao dịch trực tiếp từ ngân hàng. API chưa kiểm chứng tính xác thực của mã chứng từ với ngân hàng.

Việc đóng hồ sơ, hoàn/thu hồi GAERU Xu, tái nhập kho đủ điều kiện và ghi kiểm toán nằm trong cùng giao dịch cơ sở dữ liệu. Nếu một bước thất bại, hồ sơ chưa được đóng; người thao tác phải kiểm tra giao dịch hoàn tiền bên ngoài trước khi gửi lại để tránh chuyển tiền lần hai. Hồ sơ đã đóng không cho sửa điều phối hoặc kết quả thẩm định.

Đánh dấu hàng đủ điều kiện tái nhập tồn bán và đóng hồ sơ có cờ này đều cần `inventory.approve`. Nhân sự chỉ có quyền xử lý đơn không tự duyệt hàng lỗi thành hàng bán được.

## Đổi mới 1:1 có chứng từ xuất kho

Hệ thống hỗ trợ đổi toàn bộ đơn, giữ đúng số lượng từng dòng hàng. Phiên bản thay thế phải cùng sản phẩm; cho phép đổi đúng phiên bản đã mua hoặc phiên bản khác có đơn giá bằng đơn giá mua của dòng hàng. Không hỗ trợ đổi một phần đơn, đổi sang sản phẩm khác, thu thêm hoặc hoàn chênh lệch giá. Nếu danh mục đã đổi giá, quyền đổi đúng phiên bản gốc vẫn giữ theo đơn đã mua.

1. Xác nhận hồ sơ đã nhận hàng (`received`), hàng đã tới kho (`delivered_to_warehouse`) và nhập kết quả thẩm định ít nhất 5 ký tự. Nhân sự xuất hàng cần cả `orders.write` và `inventory.approve`; xem lựa chọn kho cần `orders.read` và `inventory.read`.
2. Mở chứng từ hàng đổi, chọn kho đang hoạt động và phiên bản thay thế cho mọi dòng hàng. API `GET /api/gaeru_ceo/orders/after-sales/:id/exchange-options` trả dòng gốc, số lượng, phiên bản hợp lệ, tồn từng kho và chứng từ đang hiệu lực.
3. Gửi `POST /api/gaeru_ceo/orders/after-sales/:id/exchange-issue` với `version`, `requestKey` UUID ổn định, `warehouseId`, `reason`, `confirmedReceivedAll: true` và toàn bộ `items: [{orderItemId, replacementVariantId, quantity}]`. Gửi CSRF như các thao tác quản trị khác.
4. Hệ thống khóa dữ liệu, kiểm tra lại phiên bản và tồn kho, trừ tồn khả dụng ở đúng kho và tồn tổng, lập chứng từ có liên kết biến động kho cho từng dòng hàng, ghi kiểm toán rồi tăng phiên bản hồ sơ. Các dòng dùng cùng phiên bản được cộng số lượng trước khi xuất. Nếu thiếu kho, sai giá/số lượng hoặc lỗi kiểm toán thì toàn bộ giao dịch hoàn tác. Gửi lại cùng mã và nội dung trả kết quả cũ; không trừ kho lần hai. Không đổi nội dung rồi tái dùng mã yêu cầu đã thành công.
5. Chứng từ xuất thành công đưa hàng đổi về `preparing`. Khi đã bàn giao thực tế, nhập đơn vị vận chuyển và mã vận đơn tối thiểu 4 ký tự rồi ghi `in_transit`. Sau khi đối soát khách nhận đủ hàng, ghi `delivered`; sau đó mới được đóng hồ sơ. Mỗi cập nhật logistics yêu cầu `version` hiện tại. Không được bỏ bước hoặc thay vận đơn sau khi đã bàn giao.

Chứng từ là nghiệp vụ xuất kho thật, không chỉ là ghi chú vận chuyển. API không tự tạo vận đơn hãng. Nhân sự đối soát trạng thái giao hàng từ chứng từ/vận đơn thực tế trước khi nhập.

Trước khi bàn giao vận chuyển, có thể hủy chứng từ bằng `POST /api/gaeru_ceo/orders/after-sales/:id/exchange-issue/void` với `version`, `requestKey`, `issueId`, `reason`. Hệ thống hoàn hàng về đúng kho xuất, giữ lịch sử chứng từ đã hủy, xóa thông tin giao chưa thực hiện và tăng phiên bản. Có thể lập chứng từ mới sau khi điều chỉnh. Mã yêu cầu hủy cũng chống lặp; không được hủy khi đã ghi đang giao hoặc đã giao. Kho phải còn hoạt động khi hoàn lại chứng từ.

Đóng hồ sơ đổi không đổi tổng tiền, trạng thái thanh toán hoặc GAERU Xu của đơn gốc. Hàng gốc trả về chỉ tăng tồn khả dụng khi đã đánh dấu đủ điều kiện tái nhập kho; hàng lỗi không tự tăng tồn bán. Tái nhập dùng nghiệp vụ hoàn phân bổ đơn hiện có, về kho phân bổ gốc hoặc Kho chính cho đơn lịch sử; nếu hàng thực tế ở kho khác, cần đối soát và chuyển kho phù hợp. Hệ thống không hỗ trợ tự hủy giao hàng hoặc tự hoàn kho sau khi đã bàn giao vận chuyển.

Không xóa vĩnh viễn đơn gốc khi còn chứng từ xuất hàng đổi đang hiệu lực và hồ sơ chưa đóng. Cần hủy chứng từ trước bàn giao, hoặc hoàn tất giao đổi và đóng hồ sơ trước; quy tắc này giữ chứng từ quản lý số hàng đã xuất.

Quy tắc xóa đơn cũng bảo vệ vận chuyển của đơn gốc: yêu cầu tạo vận đơn đang xử lý/chưa rõ kết quả, mã hãng đã trả nhưng chưa gắn được vào hồ sơ vận chuyển, và vận đơn đang chờ lấy/đang lấy/đang giao đều chặn xóa. Đối soát hoặc hủy vận đơn với hãng trước; lịch sử vận đơn đã giao, đã trả hoặc đã hủy vẫn theo chính sách xóa lịch sử được quản trị viên yêu cầu.
