const result = new URLSearchParams(location.search);
const content = document.querySelector("#payment-result");
const orderNumber = result.get("order");
const messages = {
  processing: {
    title: "VNPAY đã gửi kết quả thanh toán.",
    detail: "GAERU đang xác nhận giao dịch qua thông báo bảo mật từ VNPAY. Trạng thái đơn hàng chỉ được cập nhật sau khi máy chủ xác minh."
  },
  failed: {
    title: "Giao dịch chưa hoàn tất.",
    detail: "Đơn hàng chưa được xác nhận đã thanh toán. Liên hệ GAERU để được hỗ trợ hoặc đặt lại đơn hàng."
  },
  invalid: {
    title: "Không thể xác minh kết quả giao dịch.",
    detail: "Không sử dụng trang chuyển hướng này làm xác nhận thanh toán. Liên hệ GAERU để kiểm tra đơn hàng."
  }
};
const message = messages[result.get("result")] || messages.invalid;
const title = document.createElement("h2");
title.textContent = message.title;
const detail = document.createElement("p");
detail.textContent = message.detail;
content.replaceChildren(title, detail);
if (orderNumber) {
  const order = document.createElement("p");
  order.textContent = `Mã đơn: ${orderNumber}`;
  content.append(order);
}
