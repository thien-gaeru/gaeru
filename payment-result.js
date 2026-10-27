const result = new URLSearchParams(location.search);
const content = document.querySelector("#payment-result");
const orderNumber = result.get("order");
const providerKey = String(result.get("provider") || "vnpay").toLowerCase();
const providerNames = {
  vnpay: "VNPAY",
  "9pay": "9Pay",
  momo: "MoMo",
  zalopay: "ZaloPay",
  bank_transfer: "Chuyển khoản ngân hàng"
};
const providerLabel = providerNames[providerKey] || "Cổng thanh toán";
const messages = {
  processing: {
    title: `${providerLabel} đã gửi kết quả thanh toán.`,
    detail: `GAERU đang tự động đối soát giao dịch bảo mật từ ${providerLabel}. Ngay khi so khớp thành công, đơn hàng sẽ tự động duyệt sang trạng thái Chờ gửi hàng.`
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
  if (result.get("result") === "processing") {
    fetch(`/api/payments/order-status?order=${encodeURIComponent(orderNumber)}`, { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (body?.order?.paymentStatus === "paid") {
          title.textContent = `Đã thanh toán thành công qua ${providerNames[body.order.paymentMethod] || providerLabel}.`;
          detail.textContent = "Giao dịch đã được hệ thống so khớp tự động. Đơn hàng của bạn đã được duyệt thẳng sang trạng thái Chờ gửi hàng.";
        }
      })
      .catch(() => {});
  }
}
