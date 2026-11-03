# Rà soát tích hợp và hàng đợi, 03/11/2026

## Lỗi đã sửa

| Mức | Nguyên nhân trước sửa | Hành vi sau sửa | Kiểm chứng cô lập |
| --- | --- | --- | --- |
| P0 | Webhook vận chuyển không bắt buộc xác thực; lỗi đọc/giải mã cấu hình bị nuốt, payload công khai có thể hoàn tất đơn và thu COD | Thiếu khóa trả 503, sai/thiếu header trả 401; lỗi cấu hình dừng xử lý trước mọi ghi; khóa riêng mã hóa, redacted và cấu hình được trong quản trị | `shipping-webhook-security.integration.test.js`: shipment, order, audit và finance không đổi khi bị từ chối; callback hợp lệ và gửi lặp chỉ quyết toán một lần |
| P0 | Webhook sàn không kiểm chữ ký, nhận SKU/số lượng từ payload công khai để trừ/hoàn tồn | Public webhook trả 501 trước đọc/ghi dữ liệu; giữ đồng bộ thủ công bằng token đã cấp | `marketplace-webhook-security.integration.test.js`: ba sàn × processing/cancel không tạo đơn/event hay đổi tồn |
| P1 | Tạo vận đơn bên trong DB transaction; timeout/rollback xóa mọi dấu vết trước khi thử lại | Claim commit trước gọi hãng; khóa gửi lại bền vững, lưu reference đã nhận; chỉ chủ đối soát chưa tạo bằng mật khẩu/MFA và bằng chứng mới được mở khóa | `shipment-attempt-fencing.integration.test.js`: đồng thời, timeout, rollback ghi nội bộ, claim cũ, config bị tắt, đối soát và callback trễ |
| P1 | J&T/SPX nhận dữ liệu lỗi thành xác minh; mã vận đơn/cước dự phòng được tự tạo; GHN bỏ qua lỗi từng mã khi hủy | Yêu cầu envelope thành công rõ ràng, mã thực và cước hợp lệ; GHN cần kết quả đúng mã; SPX cước dùng bảng website; trạng thái mơ hồ không thu COD | `carrier-response-integrity.test.js` cùng bộ kiểm thử vận chuyển cũ |
| P1 | Đồng bộ sàn bỏ qua mapping/thiếu tồn nhưng gắn stock_deducted=true cho cả đơn | Thiếu mapping, số lượng không hợp lệ hoặc tồn không đủ làm rollback toàn bộ đơn khi chọn trừ tồn | Regression trong `marketplace-webhook-security.integration.test.js` kiểm tra rollback cả mục đã trừ trước mục lỗi |
| P1 | MISA HTTP200 được coi verified; thiếu số hóa đơn/transaction ID được tự tạo; chưa có protocol và fencing phát hành | Probe/publish trả 501; tự động phát hành skip misa_protocol_unverified; lưu cấu hình là configured_unverified, không connected; giữ đơn và hồ sơ nội bộ | `misa-einvoice.test.js`: số gọi mạng bằng 0; đơn hoàn tất và hồ sơ được duyệt không sinh hóa đơn điện tử |
| P2 | Chat email mất thông báo khi lỗi trước DATA; handoff đã trả lời vẫn gửi; warranty thử lại cả AUTH535 | Tối đa 3 lần, cách 5 phút chỉ khi biết chưa gửi; DATA chưa rõ giữ unknown; handoff không còn chờ bị skipped; AUTH535 terminal | `chat-email-retry.integration.test.js`, shopping chat và warranty regressions |

Migration mới: integration-delivery-safety.sql tạo carrier_shipment_attempts và thêm attempts/next_attempt_at cho chat outbox. Dữ liệu đơn/tồn/khóa của đối tác không bị tự sửa. Chưa có rollout production trong lượt rà soát này.

## Giới hạn thực tế

- Không dùng token thật, gửi email, thu/hoàn tiền, tạo/hủy vận đơn, đổi tồn sàn hoặc phát hành hóa đơn thật. Không kiểm tra ghi lên production.
- OAuth callback và tự gia hạn token sàn chưa triển khai; token hết hạn phải nhập mới và xác minh lại. Mở webhook cần protocol xác thực/replay/raw-body đúng từng sàn.
- J&T/SPX cùng các carrier còn cần quyền API, shop/account binding, request/response thật, bảng mã và nhãn. Phản hồi giả lập không chứng minh partner đã chấp thuận.
- MISA eShop và meInvoice cần xác nhận dịch vụ, tài liệu giao thức, quyền ứng dụng và tài khoản được cấp. Không mở lại publish bằng thêm khóa hoặc bật checkbox; cần idempotency/fencing và nghiệm thu riêng.
- SMTP/TLS đã kiểm chứng cấu hình và phân loại lỗi bằng fixture, chưa chứng minh tiếp nhận SMTP thật hoặc thư đến hộp thư. sent chỉ là SMTP accepted; unknown cần kiểm tra trước khi gửi lại.
- Khóa nhiều tiến trình PostgreSQL, crash recovery với provider và phục hồi backup cần staging riêng. PGlite fixture không chứng minh hạ tầng production.

Hướng dẫn: [vận chuyển](shipping-carrier-integration-guide.md), [sàn](marketplace-sync-setup.md), [cấu hình](admin-configuration.md), [thanh toán](payment-providers.md).
