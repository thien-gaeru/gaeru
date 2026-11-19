'use strict';

/**
 * Prototype Vietnamese admin queries for semantic intent rescue in Internal Enterprise AI.
 * Only invoked as a fallback when deterministic regex/keyword routing misses natural phrasing.
 */
const INTERNAL_AI_INTENT_PROTOTYPES = Object.freeze([
  {
    key: 'business_overview',
    text: 'Tổng quan tình hình kinh doanh doanh thu bán hàng lợi nhuận hiệu suất cửa hàng hôm nay tuần này tháng này'
  },
  {
    key: 'orders_list',
    text: 'Danh sách đơn hàng mới đặt chờ xác nhận đang đóng gói cần xử lý hoặc bị hủy gần đây'
  },
  {
    key: 'inventory_stock',
    text: 'Kiểm tra tồn kho số lượng hàng còn lại sản phẩm nào sắp hết hàng dưới ngưỡng an toàn cảnh báo nhập hàng'
  },
  {
    key: 'shipping_status',
    text: 'Tình trạng vận chuyển giao hàng vận đơn bưu cục Viettel Post J&T Express đơn nào đang giao chậm hoàn hàng'
  },
  {
    key: 'customers_insights',
    text: 'Thống kê khách hàng mới khách hàng thân thiết mua nhiều nhất top khách VIP điểm thưởng GAERU Xu'
  },
  {
    key: 'promotions_vouchers',
    text: 'Danh sách mã giảm giá voucher chương trình khuyến mãi chiến dịch ưu đãi đang chạy hiện tại'
  },
  {
    key: 'warranty_care',
    text: 'Yêu cầu bảo hành kích hoạt bảo hành phiếu hỗ trợ GAERU Care+ lỗi kỹ thuật đổi mới sản phẩm'
  },
  {
    key: 'system_health',
    text: 'Kiểm tra sức khỏe hệ thống máy chủ cơ sở dữ liệu bảo mật tường lửa WAF chống tấn công và GPU AI'
  }
]);

module.exports = { INTERNAL_AI_INTENT_PROTOTYPES };
