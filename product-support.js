const supportContent = document.querySelector("[data-product-support-content]");
const supportProductSlug = new URLSearchParams(window.location.search).get("id");

const supportGuidesByCategory = {
  audio: {
    eyebrow: "THU ÂM",
    title: "Kiểm tra kết nối micro",
    description: "Chọn đúng cổng kết nối cho thiết bị. Trong ứng dụng ghi âm, kiểm tra nguồn đầu vào âm thanh và ghi thử một đoạn ngắn trước khi sử dụng.",
    checklist: ["Đối chiếu cổng kết nối trên thiết bị với hướng dẫn đi kèm sản phẩm.", "Kiểm tra ứng dụng đang dùng đúng nguồn âm thanh.", "Ghi thử và nghe lại để xác nhận âm thanh trước khi bắt đầu."]
  },
  video: {
    eyebrow: "GHI HÌNH",
    title: "Bắt đầu với thiết bị ghi hình",
    description: "Kiểm tra khả năng tương thích của thiết bị, làm theo hướng dẫn lắp đặt đi kèm và thử khung hình trước khi ghi.",
    checklist: ["Xác nhận thiết bị ghi hình phù hợp với hướng dẫn sản phẩm.", "Lắp thiết bị chắc chắn theo hướng dẫn đi kèm.", "Thử khung hình và thao tác điều khiển trước khi ghi hình."]
  },
  accessory: {
    eyebrow: "PHỤ KIỆN",
    title: "Kiểm tra phụ kiện và khả năng tương thích",
    description: "Đối chiếu loại cổng và thiết bị được hỗ trợ trong mô tả sản phẩm. Sử dụng phụ kiện theo hướng dẫn đi kèm.",
    checklist: ["Đối chiếu cổng kết nối với thiết bị bạn sẽ sử dụng.", "Kiểm tra thành phần và hướng dẫn đi kèm trong hộp.", "Thử kết nối trước khi sử dụng trong công việc quan trọng."]
  }
};

function escapeSupportHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function renderProductSupport(product) {
  const guide = supportGuidesByCategory[product.category] || {
    eyebrow: "HỖ TRỢ SẢN PHẨM",
    title: "Bắt đầu sử dụng sản phẩm",
    description: "Tham khảo hướng dẫn đi kèm sản phẩm để thiết lập và sử dụng phù hợp với thiết bị của bạn.",
    checklist: ["Kiểm tra thành phần và hướng dẫn trong hộp.", "Đối chiếu khả năng tương thích với thiết bị.", "Liên hệ GAERU nếu cần hỗ trợ thêm."]
  };
  const safeName = escapeSupportHtml(product.name);
  const safeDescription = escapeSupportHtml(product.description);
  const safeImage = escapeSupportHtml(product.imageUrl);
  const safeImageAlt = escapeSupportHtml(product.imageAlt || product.name);

  document.title = `Hỗ trợ ${product.name} — GAERU`;
  supportContent.innerHTML = `
    <section class="product-support-hero">
      <div class="product-support-hero-copy">
        <p class="eyebrow">${escapeSupportHtml(guide.eyebrow)} · HỖ TRỢ GAERU</p>
        <h1>Hỗ trợ về ${safeName}</h1>
        <p>${safeDescription}</p>
        <a class="button button-blue" href="#product-support-guides">Xem hướng dẫn</a>
      </div>
      <div class="product-support-hero-image"><img src="${safeImage}" alt="${safeImageAlt}"></div>
    </section>
    <section class="product-support-guides section-wrap" id="product-support-guides" aria-labelledby="product-support-guides-title">
      <div class="product-support-section-heading">
        <p class="eyebrow">${escapeSupportHtml(product.name)}</p>
        <h2 id="product-support-guides-title">${escapeSupportHtml(guide.title)}</h2>
        <p>${escapeSupportHtml(guide.description)}</p>
      </div>
      <ol class="product-support-checklist">
        ${guide.checklist.map((step, index) => `
          <li><span class="product-support-step">${String(index + 1).padStart(2, "0")}</span><span>${escapeSupportHtml(step)}</span></li>
        `).join("")}
      </ol>
    </section>
    <section class="product-support-service">
      <div class="section-wrap product-support-service-inner">
        <article>
          <p class="eyebrow">GAERU CARE+</p>
          <h2>Cần hỗ trợ thêm?</h2>
          <p>Liên hệ GAERU về cách sử dụng, tình trạng sản phẩm hoặc bảo hành. Vui lòng chuẩn bị mã đơn hoặc thông tin mua hàng.</p>
          <a class="text-link" href="support.html#contact">Liên hệ đội ngũ GAERU <span aria-hidden="true">›</span></a>
        </article>
        <article>
          <p class="eyebrow">BẢO HÀNH</p>
          <h2>12 tháng cho lỗi sản xuất.</h2>
          <p>Phạm vi và cách tiếp nhận được xác nhận khi khách liên hệ. Quyền lợi bắt buộc theo pháp luật vẫn được bảo đảm.</p>
          <a class="text-link" href="delivery-returns.html">Xem chính sách bán hàng và bảo hành <span aria-hidden="true">›</span></a>
        </article>
      </div>
    </section>
    <p class="product-support-back"><a href="support.html">‹ Quay lại Trung tâm hỗ trợ</a></p>
  `;
}

function showProductUnavailable(message) {
  supportContent.innerHTML = `
    <section class="product-support-unavailable section-wrap">
      <p class="eyebrow">TRUNG TÂM HỖ TRỢ GAERU</p>
      <h1>Không tìm thấy trang hỗ trợ sản phẩm.</h1>
      <p>${escapeSupportHtml(message)}</p>
      <a class="button button-blue" href="support.html">Quay lại Trung tâm hỗ trợ</a>
    </section>
  `;
}

function loadProductSupport() {
  const product = window.GAERUStore?.products.find((item) => item.slug === supportProductSlug);
  if (!supportProductSlug) {
    showProductUnavailable("Vui lòng chọn sản phẩm từ danh sách hỗ trợ GAERU.");
  } else if (!product) {
    showProductUnavailable("Sản phẩm có thể đã ngừng kinh doanh hoặc hiện chưa có trong danh sách hỗ trợ.");
  } else {
    renderProductSupport(product);
  }
}

document.addEventListener("gaeru:products-loaded", loadProductSupport);
document.addEventListener("gaeru:products-load-error", () => {
  showProductUnavailable("Không thể tải thông tin sản phẩm lúc này. Hãy tải lại trang hoặc liên hệ GAERU.");
});
if (window.GAERUStore) loadProductSupport();
