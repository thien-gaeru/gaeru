const cartStorageKey = "gaeru-store-cart-v2";
let products = [];
let csrfToken = "";
let storeSettings = {
  shippingNote: "Phí giao hàng được tính theo tỉnh/thành phố đã chọn.",
  shippingRates: {}
};

const formatPrice = (price) => `${new Intl.NumberFormat("vi-VN").format(price)} ₫`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));
const normalizeSearchText = (value) => value.toLocaleLowerCase("vi").replace(/\bmic\b/g, "micro");

function searchProducts(query) {
  const normalized = normalizeSearchText(query.trim());
  if (!normalized) return products;
  return products.filter((product) =>
    normalizeSearchText(`${product.name} ${product.description} ${product.category} ${product.descriptor}`).includes(normalized)
  );
}

async function apiRequest(url, options = {}) {
  if (options.method && options.method !== "GET") csrfToken = (await apiRequest("/api/csrf")).csrfToken;
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Không thể hoàn tất yêu cầu (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function readCart() {
  try {
    const value = JSON.parse(localStorage.getItem(cartStorageKey) || "[]");
    if (!Array.isArray(value)) throw new Error("Giỏ hàng không hợp lệ");
    return value.filter((item) =>
      item && typeof item.variantId === "string" &&
      Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 99
    );
  } catch (error) {
    console.error("Không thể đọc giỏ hàng GAERU:", error);
    return [];
  }
}

function writeCart(cart) {
  try {
    localStorage.setItem(cartStorageKey, JSON.stringify(cart));
    updateCartBadge(cart);
    document.dispatchEvent(new CustomEvent("gaeru:cart-updated"));
    return true;
  } catch (error) {
    console.error("Không thể lưu giỏ hàng GAERU:", error);
    const feedback = document.querySelector("[data-cart-feedback]");
    if (feedback) feedback.textContent = "Không thể lưu giỏ hàng trên thiết bị này.";
    return false;
  }
}

function cartRows(cart) {
  return cart.flatMap((item) => {
    for (const product of products) {
      const variant = product.variants.find((entry) => entry.id === item.variantId);
      if (variant) return [{ ...item, product, variant }];
    }
    return [];
  });
}

function updateCartBadge(cart = readCart()) {
  const quantity = cart.reduce((total, item) => total + item.quantity, 0);
  const badge = document.querySelector(".cart-count");
  const link = document.querySelector(".bag-link");
  if (!badge || !link) return;
  badge.textContent = String(quantity);
  badge.hidden = quantity === 0;
  link.setAttribute("aria-label", `Giỏ hàng, ${quantity} sản phẩm`);
}

function getPriceLabel(product) {
  const availableVariants = product.variants.filter((variant) => variant.active);
  if (!availableVariants.length) return "Chưa mở bán";
  const prices = availableVariants.map((variant) => variant.priceVnd);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return low === high ? formatPrice(low) : `${formatPrice(low)} – ${formatPrice(high)}`;
}

function productCard(product, compact = false) {
  const discoverUrl = ["k9","m3","p01","g1-ultra"].includes(product.slug) ? "discover-"+product.slug+".html" : "product.html?id="+encodeURIComponent(product.slug);
  const variants = product.variants.filter((variant) => variant.active);
  const availableVariants = variants.filter((variant) => variant.stockQuantity > 0);
  const action = variants.length === 1 && availableVariants.length === 1
    ? `<button class="${compact ? "text-link buy-link" : "button button-blue"}" type="button" data-add-to-cart="${escapeHtml(availableVariants[0].id)}">Thêm vào giỏ</button>`
    : `<a class="${compact ? "text-link" : "button button-blue"}" href="product.html?id=${encodeURIComponent(product.slug)}">${variants.length ? "Chọn phiên bản" : "Tìm hiểu thêm"}</a>`;
  const cardClass = compact
    ? `product-card ${product.slug === "k9" ? "product-card-dark" : ""} ${product.slug === "g1-ultra" ? "product-card-wide" : ""}`
    : `catalog-card ${product.slug === "k9" ? "catalog-card-dark" : ""}`;
  return compact ? `
    <article class="${cardClass}" id="${escapeHtml(product.slug)}" data-kind="${escapeHtml(product.category)}">
      <div class="product-copy">
        <p class="eyebrow">${escapeHtml(product.descriptor)}</p>
        <h3>${escapeHtml(product.name)}</h3>
        <p>${escapeHtml(product.description)}</p>
        <p class="price">${escapeHtml(getPriceLabel(product))}</p>
        <div class="card-actions">
          <a class="button button-blue" href="${discoverUrl}">Khám phá sản phẩm</a>
          ${action}
        </div>
      </div>
      <img class="product-image" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.imageAlt)}" loading="lazy">
    </article>` : `
    <article class="${cardClass}">
      <a class="catalog-card-image" href="product.html?id=${encodeURIComponent(product.slug)}">
        <img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.imageAlt)}" loading="lazy">
      </a>
      <p class="eyebrow">${escapeHtml(product.descriptor)}</p>
      <h2><a href="product.html?id=${encodeURIComponent(product.slug)}">${escapeHtml(product.name)}</a></h2>
      <p class="catalog-description">${escapeHtml(product.description)}</p>
      <p class="catalog-price">${escapeHtml(getPriceLabel(product))}</p>
      <div class="catalog-actions">
        <a class="button button-blue" href="${discoverUrl}">Khám phá sản phẩm</a>
        ${action}
      </div>
    </article>`;
}

function renderHomeProducts() {
  const grid = document.querySelector(".product-grid");
  if (!grid) return;
  grid.innerHTML = products.length
    ? products.map((product) => productCard(product, true)).join("")
    : '<p class="empty-state">Chưa có sản phẩm được xuất bản.</p>';
  const k9 = products.find((product) => product.slug === "k9");
  if (k9) {
    const heroImage = document.querySelector(".hero-art img");
    if (heroImage) {
      heroImage.src = k9.imageUrl;
      heroImage.alt = k9.imageAlt;
    }
  }
}

function renderCatalog() {
  const grid = document.querySelector("#catalog-grid");
  if (!grid) return;
  const queryInput = document.querySelector("#catalog-search");
  const count = document.querySelector("#catalog-count");
  const empty = document.querySelector("#catalog-empty");
  const initialQuery = new URLSearchParams(location.search).get("q") || "";
  const categoryParam = new URLSearchParams(location.search).get("category");
  let selectedCategory = ["audio", "video", "accessory"].includes(categoryParam) ? categoryParam : "all";
  queryInput.value = initialQuery;
  document.querySelectorAll('[data-category-art]').forEach((art) => {
    const category = art.dataset.categoryArt;
    const representative = products.find(product => category === 'all' || product.category === category);
    art.innerHTML = representative ? `<img src="${escapeHtml(representative.imageUrl)}" alt="" loading="lazy">` : '<span class="category-placeholder" aria-hidden="true">◌</span>';
  });
  const updateRail = () => document.querySelectorAll('[data-store-scroll]').forEach(button => {
    button.disabled = Number(button.dataset.storeScroll) < 0 ? grid.scrollLeft <= 2 : grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 2;
  });
  document.querySelectorAll('[data-store-scroll]').forEach(button => button.addEventListener('click', () => grid.scrollBy({left: Number(button.dataset.storeScroll) * Math.max(280,grid.clientWidth * .8),behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'})));
  grid.addEventListener('scroll', updateRail, {passive:true});
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updateRail).observe(grid);

  const applyFilters = () => {
    const matching = searchProducts(queryInput.value.trim()).filter((product) =>
      selectedCategory === "all" || product.category === selectedCategory
    );
    grid.innerHTML = matching.map((product) => productCard(product)).join("");
    count.textContent = `${matching.length} sản phẩm`;
    empty.hidden = matching.length > 0;
    grid.scrollLeft = 0;
    updateRail();
  };

  document.querySelectorAll(".catalog [data-filter]").forEach((button) => {
    const selected = button.dataset.filter === selectedCategory;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.addEventListener("click", () => {
      selectedCategory = button.dataset.filter;
      document.querySelectorAll(".catalog [data-filter]").forEach((item) => {
        const isSelected = item === button;
        item.classList.toggle("is-active", isSelected);
        item.setAttribute("aria-pressed", String(isSelected));
      });
      applyFilters();
    });
  });
  queryInput.addEventListener("input", applyFilters);
  applyFilters();
}

function renderProduct() {
  const root = document.querySelector("#product-detail");
  if (!root) return;
  const slug = new URLSearchParams(location.search).get("id");
  const product = products.find((item) => item.slug === slug);
  if (!product) {
    root.innerHTML = `<section class="not-found section-wrap"><p class="eyebrow">Không tìm thấy sản phẩm</p><h1>Sản phẩm này chưa có hoặc đang được cập nhật.</h1><a class="button button-blue" href="shop.html">Quay lại cửa hàng</a></section>`;
    return;
  }
  const variants = product.variants.filter((variant) => variant.active);
  const selected = variants.find((variant) => variant.stockQuantity > 0) || variants[0];
  document.title = `${product.name} — GAERU`;
  const breadcrumb = document.querySelector("#breadcrumb-product");
  if (breadcrumb) breadcrumb.textContent = product.name;
  const optionGroups=window.GAERUVariantChoices?.groups(variants,product.optionGroups)||[];
  const visualOptions=optionGroups.length?optionGroups.map(g=>`<div class="product-choice-group"><p>${escapeHtml(g.name)}</p><div class="product-choice-buttons" role="group" aria-label="${escapeHtml(g.name)}">${g.values.map(value=>`<button type="button" data-option-group="${escapeHtml(g.name)}" data-option-value="${escapeHtml(value)}" aria-pressed="${selected?.options?.[g.name]===value}">${escapeHtml(value)}</button>`).join("")}</div></div>`).join(""):variants.map(v=>`<button class="product-variant-card" type="button" data-visual-variant="${escapeHtml(v.id)}" aria-pressed="${v.id===selected?.id}">${escapeHtml(v.name)}<small>${formatPrice(v.priceVnd)}${v.stockQuantity?"":" · Hết hàng"}</small></button>`).join("");
  const variantField = variants.length ? `${visualOptions}<details class="variant-list-toggle"><summary>Xem danh sách phiên bản</summary>
    <label class="variant-select-label" for="product-variant">Phiên bản
      <select id="product-variant">
        ${variants.map((variant) => {
          const options = Object.entries(variant.options || {}).map(([key, value]) => `${key}: ${value}`).join(" · ");
          const label = [variant.name, options, `SKU ${variant.sku}`, variant.stockQuantity ? "" : "Hết hàng"].filter(Boolean).join(" — ");
          return `<option value="${escapeHtml(variant.id)}" ${variant.id === selected?.id ? "selected" : ""} ${variant.stockQuantity ? "" : "disabled"}>${escapeHtml(label)} · ${formatPrice(variant.priceVnd)}</option>`;
        }).join("")}
      </select>
    </label></details>
    <p class="detail-price" data-selected-price>${formatPrice(selected.priceVnd)}</p>` : `
    <p class="detail-price">Chưa có phiên bản để đặt hàng</p>`;

  root.innerHTML = `
    <section class="product-detail section-wrap">
      <div class="product-detail-art"><img data-product-main-image src="${escapeHtml(selected?.imageUrl||product.imageUrl)}" alt="${escapeHtml(product.imageAlt||product.name)}"><div class="product-gallery-thumbnails">${[...new Set([product.imageUrl,...(product.gallery||[])])].map((url,i)=>`<button type="button" data-gallery-image="${escapeHtml(url)}" aria-label="Xem ảnh ${i+1}"><img src="${escapeHtml(url)}" alt="" loading="lazy"></button>`).join("")}</div></div>
      <div class="product-detail-copy">
        <p class="eyebrow">${escapeHtml(product.descriptor)}</p>
        <h1>${escapeHtml(product.name)}</h1>
        ${window.GAERUDescription?window.GAERUDescription.render(product):`<p class="detail-description">${escapeHtml(product.description)}</p>`}
        ${["k9","m3","p01","g1-ultra"].includes(product.slug)?`<a class="text-link" href="discover-${product.slug}.html">Khám phá ${escapeHtml(product.name)} ↗</a>`:""}
        ${variantField}
        <p class="stock-note" data-stock-note>${selected ? (selected.stockQuantity ? `Còn ${selected.stockQuantity} sản phẩm` : "Phiên bản hiện đã hết hàng") : "Sản phẩm chưa có phiên bản được mở bán."}</p>
        <div class="detail-actions">
          <button class="button button-blue" type="button" data-add-to-cart="${escapeHtml(selected?.id || "")}" ${selected?.stockQuantity ? "" : "disabled"}>Thêm vào giỏ</button>
        </div>
        <p class="cart-feedback" data-cart-feedback aria-live="polite"></p>
        <div class="detail-benefits">
          <p><strong>Đặt hàng trực tiếp</strong><span>Đơn hàng được quản lý bởi hệ thống GAERU.</span></p>
          <p><strong>Hỗ trợ</strong><span>Liên hệ <a href="tel:0829191080">082 919 1080</a> nếu cần tư vấn.</span></p>
        </div>
      </div>
    </section>
    <section class="detail-more"><p class="eyebrow">Khám phá thêm</p><h2>Thiết bị khác. Cùng cảm hứng.</h2><a class="text-link" href="shop.html">Xem toàn bộ cửa hàng <span aria-hidden="true">›</span></a></section>`;

  const selector = root.querySelector("#product-variant");
  selector?.addEventListener("change", () => {
    const variant = variants.find((item) => item.id === selector.value);
    if (!variant) return;
    root.querySelector("[data-selected-price]").textContent = formatPrice(variant.priceVnd);
    root.querySelector("[data-stock-note]").textContent = variant.stockQuantity ? `Còn ${variant.stockQuantity} sản phẩm` : "Phiên bản hiện đã hết hàng";
    const button = root.querySelector("[data-add-to-cart]");
    button.dataset.addToCart = variant.id;
    button.disabled = variant.stockQuantity === 0;
    root.querySelectorAll("[data-option-group]").forEach(b=>b.setAttribute("aria-pressed",String(variant.options?.[b.dataset.optionGroup]===b.dataset.optionValue)));
    root.querySelectorAll("[data-visual-variant]").forEach(b=>b.setAttribute("aria-pressed",String(variant.id===b.dataset.visualVariant)));
    const image=root.querySelector("[data-product-main-image]");image.src=variant.imageUrl||product.imageUrl;image.alt=variant.name+" · "+product.name;
  });
  root.addEventListener("click",e=>{const imageButton=e.target.closest("[data-gallery-image]");if(imageButton){root.querySelector("[data-product-main-image]").src=imageButton.dataset.galleryImage;return;}const option=e.target.closest("[data-option-group]"),direct=e.target.closest("[data-visual-variant]");if(!option&&!direct)return;const current=variants.find(v=>v.id===selector.value);const next=direct?variants.find(v=>v.id===direct.dataset.visualVariant):window.GAERUVariantChoices.choose(variants,current,option.dataset.optionGroup,option.dataset.optionValue);if(next){selector.value=next.id;selector.dispatchEvent(new Event("change"));}});
}

function renderCart() {
  const root = document.querySelector("#cart-content");
  if (!root) return;
  const rows = cartRows(readCart());
  if (!rows.length) {
    root.innerHTML = `<div class="empty-cart"><span class="empty-cart-icon" aria-hidden="true">◯</span><h2>Giỏ hàng đang trống.</h2><p>Khám phá các thiết bị GAERU và tìm người bạn đồng hành tiếp theo.</p><a class="button button-blue" href="shop.html">Đi đến cửa hàng</a></div>`;
    return;
  }
  const total = rows.reduce((sum, item) => sum + item.variant.priceVnd * item.quantity, 0);
  root.innerHTML = `
    <div class="cart-items">
      ${rows.map(({ variantId, quantity, product, variant }) => `
        <article class="cart-item">
          <a class="cart-item-image" href="product.html?id=${encodeURIComponent(product.slug)}"><img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.imageAlt)}" loading="lazy"></a>
          <div class="cart-item-info">
            <h2><a href="product.html?id=${encodeURIComponent(product.slug)}">${escapeHtml(product.name)}</a></h2>
              <p>${escapeHtml(variant.name)} · ${escapeHtml(variant.sku)} · ${formatPrice(variant.priceVnd)}${variant.stockQuantity ? "" : " · Hết hàng"}</p>
            <button class="remove-item" type="button" data-remove="${escapeHtml(variantId)}">Xóa</button>
          </div>
          <label class="visually-hidden" for="quantity-${escapeHtml(variantId)}">Số lượng ${escapeHtml(product.name)} ${escapeHtml(variant.name)}</label>
          <input class="quantity-input" id="quantity-${escapeHtml(variantId)}" type="number" min="1" max="${Math.max(1, Math.min(99, variant.stockQuantity))}" value="${quantity}" data-quantity="${escapeHtml(variantId)}" ${variant.stockQuantity ? "" : "disabled"}>
          <strong class="cart-line-total">${formatPrice(variant.priceVnd * quantity)}</strong>
        </article>`).join("")}
    </div>
    <aside class="cart-summary">
      <h2>Tóm tắt đơn hàng</h2>
      <p><span>Tạm tính</span><strong>${formatPrice(total)}</strong></p>
      <p><span>Giao hàng</span><span>Tính tại thanh toán</span></p>
      <p class="summary-total"><span>Tổng tạm tính</span><strong>${formatPrice(total)}</strong></p>
      <p class="prototype-note">Phí giao hàng được tính theo tỉnh/thành phố bạn chọn tại checkout. Giá lấy từ phiên bản đã chọn.</p>
      <a class="button button-blue" href="checkout.html">Nhập thông tin đặt hàng</a>
      <a class="continue-shopping" href="shop.html">Tiếp tục mua sắm</a>
    </aside>`;
}

async function renderCheckout() {
  const root = document.querySelector("#checkout-content");
  if (!root) return;
  const rows = cartRows(readCart());
  if (!rows.length) {
    root.innerHTML = `<div class="empty-cart"><h2>Chưa có sản phẩm để đặt hàng.</h2><a class="button button-blue" href="shop.html">Quay lại cửa hàng</a></div>`;
    return;
  }
  const total = rows.reduce((sum, item) => sum + item.variant.priceVnd * item.quantity, 0);
  let settingsError = "";
  try {
    storeSettings = await apiRequest("/api/settings/public");
  } catch (error) {
    settingsError = error.message;
  }
  const shippingRates = storeSettings.shippingRates || {};
  const provinces = Object.keys(shippingRates).sort((left, right) => left.localeCompare(right, "vi"));
  const paymentMethods = storeSettings.paymentMethods || ["cod"];
  if (settingsError || !storeSettings.ordersEnabled || !provinces.length) {
    const noticeTitle = settingsError
      ? "Chưa thể xác nhận trạng thái đặt hàng."
      : !storeSettings.ordersEnabled
        ? "GAERU đang tạm dừng tiếp nhận đơn hàng trực tuyến."
        : "Phí giao hàng chưa được cấu hình.";
    const noticeDescription = settingsError
      ? " Vui lòng thử lại sau hoặc liên hệ GAERU để được hỗ trợ."
      : !storeSettings.ordersEnabled
        ? " Việc đặt hàng sẽ được mở lại sau khi hoàn tất các thủ tục cần thiết. Sản phẩm trong giỏ vẫn được lưu trên thiết bị của bạn."
        : " GAERU đang cập nhật khu vực giao hàng. Sản phẩm trong giỏ vẫn được lưu trên thiết bị của bạn.";
    root.innerHTML = `
      <div class="checkout-layout">
        <div class="checkout-notice" role="${settingsError ? "alert" : "status"}">
          <strong>${noticeTitle}</strong>${noticeDescription}
          <p><a href="privacy.html">Chính sách quyền riêng tư</a> · <a href="support.html#contact">Liên hệ GAERU</a></p>
        </div>
        <aside class="checkout-summary cart-summary">
          <h2>Đơn hàng</h2>
          ${rows.map(({ quantity, product, variant }) => `
            <p class="checkout-product"><span>${escapeHtml(product.name)}<br><small>${escapeHtml(variant.name)} × ${quantity}</small></span><strong>${formatPrice(variant.priceVnd * quantity)}</strong></p>`).join("")}
          <p class="summary-total"><span>Tạm tính</span><strong>${formatPrice(total)}</strong></p>
          <p class="prototype-note">${escapeHtml(storeSettings.shippingNote || "Phí giao hàng được tính theo tỉnh/thành phố đã chọn.")}</p>
          <a class="continue-shopping" href="shop.html">Tiếp tục mua sắm</a>
        </aside>
      </div>`;
    return;
  }
  root.innerHTML = `
    <form class="checkout-form" id="checkout-form">
      <div class="checkout-notice" role="status"><strong>Đơn hàng được xử lý trực tiếp bởi GAERU.</strong> Phí giao hàng được tính theo tỉnh/thành phố bạn chọn.</div>
      <div class="form-section">
        <h2>Thông tin liên hệ</h2>
        <label>Họ và tên<input name="name" autocomplete="name" required maxlength="120"></label>
        <div class="form-row">
          <label>Email<input type="email" name="email" autocomplete="email" required maxlength="254"></label>
          <label>Số điện thoại<input type="tel" name="phone" autocomplete="tel" required maxlength="30"></label>
        </div>
      </div>
      <div class="form-section">
        <h2>Địa chỉ giao hàng</h2>
        <label>Địa chỉ<input name="address" autocomplete="street-address" required maxlength="250"></label>
        <div class="form-row">
          <label>Tỉnh / thành phố<select name="city" autocomplete="address-level1" required>
            <option value="" selected disabled>Chọn tỉnh/thành phố</option>
            ${provinces.map((province) => `<option value="${escapeHtml(province)}">${escapeHtml(province)}</option>`).join("")}
          </select></label>
          <label>Ghi chú <span>(không bắt buộc)</span><input name="note" maxlength="1000"></label>
        </div>
      </div>
      <div class="form-section">
        <h2>Phương thức thanh toán</h2>
        <label>Chọn phương thức
          <select name="paymentMethod">
            ${paymentMethods.includes("cod") ? '<option value="cod">Thanh toán khi nhận hàng (COD)</option>' : ""}
            ${paymentMethods.includes("vnpay") ? '<option value="vnpay">Thanh toán trực tuyến qua VNPAY</option>' : ""}
          </select>
        </label>
        <p class="payment-placeholder" data-payment-help>GAERU sẽ xác nhận đơn hàng trước khi gửi.</p>
      </div>
      <p class="checkout-privacy-notice">Thông tin bạn cung cấp được sử dụng để tiếp nhận và xử lý đơn hàng theo <a href="privacy.html">Chính sách quyền riêng tư</a>. <a href="terms.html">Điều khoản mua hàng</a>.</p>
      <button class="button button-blue" type="submit">Gửi yêu cầu đặt hàng</button>
      <p class="checkout-feedback" id="checkout-feedback" aria-live="polite"></p>
    </form>
    <aside class="checkout-summary cart-summary">
      <h2>Đơn hàng</h2>
      ${rows.map(({ quantity, product, variant }) => `
        <p class="checkout-product"><span>${escapeHtml(product.name)}<br><small>${escapeHtml(variant.name)} × ${quantity}</small></span><strong>${formatPrice(variant.priceVnd * quantity)}</strong></p>`).join("")}
      <p class="summary-total"><span>Tạm tính</span><strong>${formatPrice(total)}</strong></p>
      <p class="checkout-product"><span>Giao hàng</span><strong data-checkout-shipping>Chọn tỉnh/thành</strong></p>
      <p class="summary-total"><span>Tổng cộng</span><strong data-checkout-total>Chọn tỉnh/thành</strong></p>
      <p class="prototype-note">${escapeHtml(storeSettings.shippingNote || "Phí giao hàng được tính theo tỉnh/thành phố đã chọn.")}</p>
    </aside>`;

  const form = root.querySelector("#checkout-form");
  const paymentMethod = form.elements.paymentMethod;
  const paymentHelp = form.querySelector("[data-payment-help]");
  const updateShippingTotal = () => {
    const fee = shippingRates[form.elements.city.value];
    root.querySelector("[data-checkout-shipping]").textContent =
      fee === undefined ? "Chọn tỉnh/thành" : formatPrice(fee);
    root.querySelector("[data-checkout-total]").textContent =
      fee === undefined ? "Chọn tỉnh/thành" : formatPrice(total + fee);
  };
  form.elements.city.addEventListener("change", updateShippingTotal);
  updateShippingTotal();
  const updatePaymentHelp = () => {
    paymentHelp.textContent = paymentMethod.value === "cod"
      ? "Thanh toán trực tiếp khi nhận hàng."
      : "Bạn sẽ được chuyển tới VNPAY để hoàn tất thanh toán an toàn.";
  };
  paymentMethod.addEventListener("change", updatePaymentHelp);
  updatePaymentHelp();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const feedback = root.querySelector("#checkout-feedback");
    button.disabled = true;
    feedback.textContent = "Đang gửi yêu cầu đặt hàng…";
    try {
      if (!csrfToken) csrfToken = (await apiRequest("/api/csrf")).csrfToken;
      const result = await apiRequest("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          customer: {
            name: form.elements.name.value,
            email: form.elements.email.value,
            phone: form.elements.phone.value,
            address: form.elements.address.value,
            city: form.elements.city.value,
            note: form.elements.note.value
          },
          paymentMethod: paymentMethod.value,
          items: rows.map(({ variantId, quantity }) => ({ variantId, quantity }))
        })
      });
      writeCart([]);
      if (result.paymentUrl) {
        location.assign(result.paymentUrl);
        return;
      }
      root.innerHTML = `<div class="order-success" role="status"><p class="eyebrow">Đã tiếp nhận đơn</p><h2>Mã đơn ${escapeHtml(result.order.orderNumber)}</h2><p>${escapeHtml(result.message)}</p><p>Tạm tính ${formatPrice(result.order.subtotalVnd)} · Giao hàng ${formatPrice(result.order.shippingFeeVnd)} · Tổng cộng ${formatPrice(result.order.totalVnd)}</p><p>Đơn COD sẽ được GAERU xác nhận và thu tiền khi giao hàng.</p><a class="button button-blue" href="shop.html">Tiếp tục khám phá</a></div>`;
    } catch (error) {
      feedback.textContent = error.message;
      button.disabled = false;
    }
  });
}

function renderMiniCart() {
  const root = document.querySelector("[data-mini-cart]");
  if (!root) return;
  const rows = cartRows(readCart());
  const cart = readCart();
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  const total = rows.reduce((sum, item) => sum + item.variant.priceVnd * item.quantity, 0);
  const panelCount = document.querySelector("[data-cart-panel-count]");
  const footer = document.querySelector("[data-mini-cart-footer]");
  const totalElement = document.querySelector("[data-mini-cart-total]");
  const panelTitle = document.querySelector("#cart-panel-title");
  const cartHeading = document.querySelector(".cart-panel-heading");
  if (panelCount) {
    panelCount.textContent = `${count} sản phẩm`;
    panelCount.hidden = count === 0;
  }

  if (!rows.length) {
    if (panelTitle) panelTitle.textContent = "Túi của bạn trống.";
    cartHeading?.classList.add("is-empty");
    root.innerHTML = window.GAERUEmptyCartMarkup;
    if (footer) footer.hidden = true;
    return;
  }
  if (panelTitle) panelTitle.textContent = "Giỏ hàng của bạn.";
  cartHeading?.classList.remove("is-empty");
  root.innerHTML = rows.map(({ variantId, quantity, product, variant }) => `
    <article class="mini-cart-item">
      <a class="mini-cart-image" href="product.html?id=${encodeURIComponent(product.slug)}"><img src="${escapeHtml(product.imageUrl)}" alt="" loading="lazy"></a>
      <div class="mini-cart-info">
        <a class="mini-cart-name" href="product.html?id=${encodeURIComponent(product.slug)}">${escapeHtml(product.name)}</a>
        <span class="mini-cart-price">${escapeHtml(variant.name)} · ${formatPrice(variant.priceVnd)}</span>
        <div class="mini-quantity" aria-label="Số lượng ${escapeHtml(product.name)}">
          <button type="button" data-mini-quantity="decrease" data-product="${escapeHtml(variantId)}" aria-label="Giảm số lượng ${escapeHtml(product.name)}" ${quantity <= 1 ? "disabled" : ""}>−</button>
          <span>${quantity}</span>
          <button type="button" data-mini-quantity="increase" data-product="${escapeHtml(variantId)}" aria-label="Tăng số lượng ${escapeHtml(product.name)}" ${quantity >= Math.min(99, variant.stockQuantity) ? "disabled" : ""}>+</button>
          <button class="mini-remove" type="button" data-mini-remove="${escapeHtml(variantId)}">Xóa</button>
        </div>
      </div>
      <strong class="mini-line-total">${formatPrice(variant.priceVnd * quantity)}</strong>
    </article>`).join("");
  if (footer) footer.hidden = false;
  if (totalElement) totalElement.textContent = formatPrice(total);
}

function bindGlobalControls() {
  document.addEventListener("click", (event) => {
    const addButton = event.target.closest("[data-add-to-cart]");
    if (addButton) {
      const variantId = addButton.dataset.addToCart;
      const selected = cartRows([{ variantId, quantity: 1 }])[0];
      if (!selected || selected.variant.stockQuantity < 1) return;
      const cart = readCart();
      const existing = cart.find((item) => item.variantId === variantId);
      const cartMaximum = Math.min(99, selected.variant.stockQuantity);
      if (existing && existing.quantity >= cartMaximum) {
        const feedback = document.querySelector("[data-cart-feedback]");
        if (feedback) feedback.textContent = `Bạn đã đạt giới hạn ${cartMaximum} sản phẩm có thể đặt cho phiên bản này.`;
        return;
      }
      if (existing) existing.quantity += 1;
      else cart.push({ variantId, quantity: 1 });
      if (!writeCart(cart)) return;
      const feedback = document.querySelector("[data-cart-feedback]");
      if (feedback) feedback.textContent = `${selected.product.name} đã được thêm vào giỏ.`;
      addButton.setAttribute("aria-label", `${selected.product.name} đã được thêm vào giỏ hàng`);
      document.dispatchEvent(new CustomEvent("gaeru:open-cart"));
      return;
    }

    const removeButton = event.target.closest("[data-remove], [data-mini-remove]");
    if (removeButton) {
      const variantId = removeButton.dataset.remove || removeButton.dataset.miniRemove;
      const cart = readCart().filter((item) => item.variantId !== variantId);
      if (writeCart(cart)) renderCart();
      return;
    }

    const quantityButton = event.target.closest("[data-mini-quantity]");
    if (quantityButton) {
      const variantId = quantityButton.dataset.product;
      const cart = readCart();
      const item = cart.find((entry) => entry.variantId === variantId);
      if (!item) return;
      const variant = cartRows([item])[0]?.variant;
      const maximum = Math.max(1, Math.min(99, variant?.stockQuantity ?? 99));
      item.quantity = Math.max(1, Math.min(maximum, item.quantity + (quantityButton.dataset.miniQuantity === "increase" ? 1 : -1)));
      writeCart(cart);
      document.querySelector(`[data-mini-quantity="increase"][data-product="${CSS.escape(variantId)}"]`)?.focus();
    }
  });

  document.addEventListener("change", (event) => {
    const input = event.target.closest("[data-quantity]");
    if (!input) return;
    const cartItem = readCart().find((entry) => entry.variantId === input.dataset.quantity);
    const variant = cartItem ? cartRows([cartItem])[0]?.variant : null;
    const maximum = Math.max(1, Math.min(99, variant?.stockQuantity ?? 99));
    const quantity = Math.max(1, Math.min(maximum, Number.parseInt(input.value, 10) || 1));
    const cart = readCart();
    const item = cart.find((entry) => entry.variantId === input.dataset.quantity);
    if (!item) return;
    item.quantity = quantity;
    if (writeCart(cart)) {
      renderCart();
      document.querySelector(`[data-quantity="${CSS.escape(input.dataset.quantity)}"]`)?.focus();
    }
  });
}

function showStoreError(error) {
  console.error("Không thể tải dữ liệu cửa hàng GAERU:", error);
  const message = document.createElement("p");
  message.className = "store-error";
  message.setAttribute("role", "alert");
  message.textContent = "Không thể kết nối máy chủ cửa hàng. Hãy thử tải lại trang hoặc liên hệ GAERU để được hỗ trợ.";
  document.querySelector("main")?.prepend(message);
  const grid = document.querySelector(".product-grid, #catalog-grid");
  if (grid) grid.replaceChildren();
}

async function initializeStore() {
  renderMiniCart();
  try {
    const response = await apiRequest("/api/products");
    products = response.products;
    document.dispatchEvent(new CustomEvent("gaeru:products-loaded"));
    const validVariantIds = new Set(products.flatMap((product) => product.variants.map((variant) => variant.id)));
    const cart = readCart().filter((item) => validVariantIds.has(item.variantId));
    if (cart.length !== readCart().length) writeCart(cart);
    else updateCartBadge(cart);
    renderHomeProducts();
    renderCatalog();
    renderProduct();
    renderCart();
    await renderCheckout();
    renderMiniCart();
  } catch (error) {
    showStoreError(error);
    document.dispatchEvent(new CustomEvent("gaeru:products-load-error"));
  }
}

window.GAERUStore = Object.freeze({
  get products() { return products; },
  formatPrice,
  searchProducts
});
document.addEventListener("gaeru:cart-updated", () => { updateCartBadge(); renderMiniCart(); renderCart(); });
document.addEventListener("gaeru:cart-panel-open", renderMiniCart);
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== cartStorageKey) return;
  updateCartBadge();
  renderMiniCart();
  renderCart();
});
bindGlobalControls();
initializeStore();
