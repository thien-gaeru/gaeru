const products = [
  {
    id: "k9",
    name: "GAERU K9",
    category: "audio",
    descriptor: "Nhỏ mà có võ",
    description: "Mic cài áo nhỏ gọn. Cho những câu chuyện đầu tiên.",
    price: 189000,
    priceLabel: "189.000 ₫ – 299.000 ₫",
    image: "https://gaeru.com/wp-content/plugins/gaeru-k9/assets/images/k9-cutout.png",
    alt: "Micro cài áo GAERU K9",
    url: "https://gaeru.com/gaeru-k9/",
    className: "catalog-card-dark"
  },
  {
    id: "m3",
    name: "GAERU M3",
    category: "audio",
    descriptor: "Sẵn sàng cho điều tiếp theo",
    description: "Mic không dây kèm hộp sạc. Gọn gàng cho mọi hành trình.",
    price: 600000,
    priceLabel: "600.000 ₫ – 850.000 ₫",
    image: "https://gaeru.com/wp-content/uploads/2026/10/gaeru-m3-cutout-20261021-1024x683.png",
    alt: "Bộ micro không dây GAERU M3 và hộp sạc",
    url: "https://gaeru.com/cua-hang/?san-pham=2082",
    className: ""
  },
  {
    id: "p01",
    name: "GAERU P01",
    category: "video",
    descriptor: "Luôn trong khung hình",
    description: "Gimbal tự động theo người. Thêm linh hoạt cho khung hình.",
    price: 550000,
    priceLabel: "550.000 ₫ – 650.000 ₫",
    image: "https://gaeru.com/wp-content/uploads/2026/10/gaeru-p01-cutout-20261021-910x1024.png",
    alt: "Gimbal theo dõi tự động GAERU P01",
    url: "https://gaeru.com/cua-hang/?san-pham=2067",
    className: ""
  },
  {
    id: "g1",
    name: "GAERU G1 ULTRA",
    category: "audio",
    descriptor: "Linh hoạt không giới hạn",
    description: "Mic không dây đa thiết bị. Mở rộng không gian sáng tạo.",
    price: 2100000,
    priceLabel: "2.100.000 ₫",
    image: "https://gaeru.com/wp-content/uploads/2026/10/gaeru-g1-cutout-20261021-1024x1024.png",
    alt: "Bộ micro không dây đa thiết bị GAERU G1 ULTRA",
    url: "https://gaeru.com/cua-hang/?san-pham=2058",
    className: ""
  }
];

const cartStorageKey = "gaeru-store-cart";
const formatPrice = (price) => `${new Intl.NumberFormat("vi-VN").format(price)} ₫`;
const normalizeSearchText = (value) => value.toLocaleLowerCase("vi").replace(/\bmic\b/g, "micro");

function searchProducts(query) {
  const normalizedQuery = normalizeSearchText(query.trim());
  if (!normalizedQuery) return products;
  if (normalizedQuery === "thu âm" || normalizedQuery === "micro" || normalizedQuery === "micro không dây") {
    return products.filter((product) => product.category === "audio" &&
      (normalizedQuery !== "micro không dây" || normalizeSearchText(product.description).includes(normalizedQuery)));
  }
  if (normalizedQuery === "ghi hình" || normalizedQuery === "quay video") {
    return products.filter((product) => product.category === "video");
  }
  return products.filter((product) =>
    normalizeSearchText(`${product.name} ${product.description} ${product.category} ${product.descriptor}`).includes(normalizedQuery)
  );
}

function readCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(cartStorageKey) || "[]");
    if (!Array.isArray(saved)) throw new Error("Giỏ hàng không hợp lệ");
    return saved.filter((item) =>
      item &&
      products.some((product) => product.id === item.id) &&
      Number.isInteger(item.quantity) &&
      item.quantity > 0 &&
      item.quantity <= 99
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

function updateCartBadge(cart) {
  const quantity = cart.reduce((total, item) => total + item.quantity, 0);
  const badge = document.querySelector(".cart-count");
  const link = document.querySelector(".bag-link");
  if (!badge || !link) return;
  badge.textContent = String(quantity);
  badge.hidden = quantity === 0;
  link.setAttribute("aria-label", `Giỏ hàng, ${quantity} sản phẩm`);
}

function cartRows(cart) {
  return cart.map((item) => {
    const product = products.find((entry) => entry.id === item.id);
    return { ...item, product };
  });
}

function productCard(product) {
  return `
    <article class="catalog-card ${product.className}">
      <a class="catalog-card-image" href="product.html?id=${product.id}">
        <img src="${product.image}" alt="${product.alt}" loading="lazy">
      </a>
      <p class="eyebrow">${product.descriptor}</p>
      <h2><a href="product.html?id=${product.id}">${product.name}</a></h2>
      <p class="catalog-description">${product.description}</p>
      <p class="catalog-price">${product.priceLabel}</p>
      <div class="catalog-actions">
        <a class="button button-blue" href="product.html?id=${product.id}">Tìm hiểu thêm</a>
        <button class="text-link buy-link" type="button" data-add-to-cart="${product.id}">Thêm vào giỏ xem trước <span aria-hidden="true">›</span></button>
      </div>
    </article>`;
}

function renderCatalog() {
  const grid = document.querySelector("#catalog-grid");
  if (!grid) return;

  const queryInput = document.querySelector("#catalog-search");
  const count = document.querySelector("#catalog-count");
  const empty = document.querySelector("#catalog-empty");
  const initialQuery = new URLSearchParams(location.search).get("q") || "";
  const categoryParam = new URLSearchParams(location.search).get("category");
  let selectedCategory = ["audio", "video"].includes(categoryParam) ? categoryParam : "all";
  queryInput.value = initialQuery;
  document.querySelectorAll("[data-filter]").forEach((button) => {
    const selected = button.dataset.filter === selectedCategory;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  const applyFilters = () => {
    const query = queryInput.value.trim();
    const matching = searchProducts(query).filter((product) =>
      selectedCategory === "all" || product.category === selectedCategory
    );
    grid.innerHTML = matching.map(productCard).join("");
    count.textContent = `${matching.length} sản phẩm`;
    empty.hidden = matching.length > 0;
  };

  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedCategory = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((item) => {
        const selected = item === button;
        item.classList.toggle("is-active", selected);
        item.setAttribute("aria-pressed", String(selected));
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
  const product = products.find((item) => item.id === new URLSearchParams(location.search).get("id"));
  if (!product) {
    root.innerHTML = `
      <section class="not-found section-wrap">
        <p class="eyebrow">Không tìm thấy sản phẩm</p>
        <h1>Sản phẩm này chưa có trong danh mục.</h1>
        <a class="button button-blue" href="shop.html">Quay lại cửa hàng</a>
      </section>`;
    return;
  }

  document.title = `${product.name} — GAERU`;
  document.querySelector("#breadcrumb-product").textContent = product.name;
  root.innerHTML = `
    <section class="product-detail section-wrap">
      <div class="product-detail-art">
        <img src="${product.image}" alt="${product.alt}">
      </div>
      <div class="product-detail-copy">
        <p class="eyebrow">${product.descriptor}</p>
        <h1>${product.name}</h1>
        <p class="detail-description">${product.description}</p>
        <p class="detail-price">${product.priceLabel}</p>
        <p class="prototype-note">Giá và giỏ hàng trên bản xem trước chưa đồng bộ với cửa hàng. Hãy chọn phiên bản và kiểm tra giá hiện tại trên GAERU.com trước khi mua.</p>
        <div class="detail-actions">
          <button class="button button-blue" type="button" data-add-to-cart="${product.id}">Thêm vào giỏ xem trước</button>
          <a class="text-link" href="${product.url}" target="_blank" rel="noopener noreferrer">Chọn phiên bản &amp; mua trên GAERU.com <span aria-hidden="true">↗</span></a>
        </div>
        <p class="cart-feedback" data-cart-feedback aria-live="polite"></p>
        <div class="detail-benefits">
          <p><strong>Hỗ trợ sau mua</strong><span>Đăng ký bảo hành qua GAERU CARE+.</span></p>
          <p><strong>Tư vấn sản phẩm</strong><span>Liên hệ 082 919 1080 để được hỗ trợ.</span></p>
        </div>
      </div>
    </section>
    <section class="detail-more">
      <p class="eyebrow">Khám phá thêm</p>
      <h2>Thiết bị khác. Cùng cảm hứng.</h2>
      <a class="text-link" href="shop.html">Xem toàn bộ cửa hàng <span aria-hidden="true">›</span></a>
    </section>`;
}

function renderCart() {
  const root = document.querySelector("#cart-content");
  if (!root) return;
  const cart = readCart();
  if (cart.length === 0) {
    root.innerHTML = `
      <div class="empty-cart">
        <span class="empty-cart-icon" aria-hidden="true">◯</span>
        <h2>Giỏ hàng đang trống.</h2>
        <p>Khám phá các thiết bị GAERU và tìm người bạn đồng hành tiếp theo.</p>
        <a class="button button-blue" href="shop.html">Đi đến cửa hàng</a>
      </div>`;
    return;
  }

  const rows = cartRows(cart);
  const total = rows.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  root.innerHTML = `
    <div class="cart-items">
      ${rows.map(({ id, quantity, product }) => `
        <article class="cart-item">
          <a class="cart-item-image" href="product.html?id=${id}"><img src="${product.image}" alt="${product.alt}" loading="lazy"></a>
          <div class="cart-item-info">
            <h2><a href="product.html?id=${id}">${product.name}</a></h2>
            <p>${product.priceLabel}</p>
            <button class="remove-item" type="button" data-remove="${id}">Xóa</button>
          </div>
          <label class="visually-hidden" for="quantity-${id}">Số lượng ${product.name}</label>
          <input class="quantity-input" id="quantity-${id}" type="number" min="1" max="99" value="${quantity}" data-quantity="${id}">
          <strong class="cart-line-total">${formatPrice(product.price * quantity)}</strong>
        </article>`).join("")}
    </div>
    <aside class="cart-summary">
      <h2>Tóm tắt đơn hàng</h2>
      <p><span>Tạm tính</span><strong>${formatPrice(total)}</strong></p>
      <p><span>Giao hàng</span><span>Tính tại cửa hàng</span></p>
      <p class="summary-total"><span>Tổng tạm tính</span><strong>${formatPrice(total)}</strong></p>
      <p class="prototype-note">Tạm tính theo giá từ. Giá thực tế phụ thuộc phiên bản sản phẩm được chọn.</p>
      <a class="button button-blue" href="checkout.html">Chọn phiên bản &amp; tiếp tục</a>
      <a class="continue-shopping" href="shop.html">Tiếp tục mua sắm</a>
    </aside>`;
}

function renderCheckout() {
  const root = document.querySelector("#checkout-content");
  if (!root) return;
  const cart = readCart();
  if (cart.length === 0) {
    root.innerHTML = `
      <div class="empty-cart">
        <h2>Chưa có sản phẩm để thanh toán.</h2>
        <a class="button button-blue" href="shop.html">Quay lại cửa hàng</a>
      </div>`;
    return;
  }

  const rows = cartRows(cart);
  const total = rows.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  root.innerHTML = `
    <div class="checkout-notice" role="status"><strong>Giỏ hàng xem trước chưa đồng bộ với GAERU.com.</strong> Để mua hàng thật, mở từng sản phẩm bên dưới, chọn đúng phiên bản và thêm vào giỏ hàng trên cửa hàng GAERU. Không nhập thông tin cá nhân ở bản xem trước này.</div>
    <div class="checkout-handoff-items">
      <h2>Chọn phiên bản trên cửa hàng GAERU</h2>
      ${rows.map(({ id, quantity, product }) => `
        <article class="checkout-handoff-item">
          <a class="checkout-handoff-image" href="${product.url}" target="_blank" rel="noopener noreferrer">
            <img src="${product.image}" alt="" loading="lazy">
          </a>
          <div class="checkout-handoff-copy">
            <h3>${product.name}</h3>
            <p>Số lượng xem trước: ${quantity} · Giá tham khảo: ${product.priceLabel}</p>
            <a class="text-link" href="${product.url}" target="_blank" rel="noopener noreferrer">Chọn phiên bản &amp; mua <span aria-hidden="true">↗</span></a>
          </div>
        </article>`).join("")}
    </div>
    <aside class="checkout-summary cart-summary">
      <h2>Tạm tính tham khảo</h2>
      ${rows.map(({ quantity, product }) => `
        <p class="checkout-product"><span>${product.name} <b>× ${quantity}</b></span><strong>${formatPrice(product.price * quantity)}</strong></p>`).join("")}
      <p class="summary-total"><span>Tạm tính</span><strong>${formatPrice(total)}</strong></p>
      <p class="prototype-note">Dùng giá khởi điểm, chưa gồm vận chuyển. Giỏ xem trước và số lượng không được chuyển sang cửa hàng GAERU.</p>
    </aside>`;
}

function renderMiniCart() {
  const root = document.querySelector("[data-mini-cart]");
  if (!root) return;

  const cart = readCart();
  const rows = cartRows(cart);
  const count = cart.reduce((total, item) => total + item.quantity, 0);
  const total = rows.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  const panelCount = document.querySelector("[data-cart-panel-count]");
  const footer = document.querySelector("[data-mini-cart-footer]");
  const totalElement = document.querySelector("[data-mini-cart-total]");
  if (panelCount) panelCount.textContent = `${count} sản phẩm`;

  if (cart.length === 0) {
    root.innerHTML = `
      <div class="mini-cart-empty">
        <span class="mini-cart-empty-icon" aria-hidden="true">◯</span>
        <h3>Giỏ hàng đang trống.</h3>
        <p>Mỗi câu chuyện hay đều bắt đầu từ một ý tưởng.</p>
        <a class="button button-blue" href="shop.html">Khám phá sản phẩm</a>
      </div>`;
    if (footer) footer.hidden = true;
    return;
  }

  root.innerHTML = rows.map(({ id, quantity, product }, index) => `
    <article class="mini-cart-item" style="--item-index:${index}">
      <a class="mini-cart-image" href="product.html?id=${id}"><img src="${product.image}" alt="" loading="lazy"></a>
      <div class="mini-cart-info">
        <a class="mini-cart-name" href="product.html?id=${id}">${product.name}</a>
        <span class="mini-cart-price">${product.priceLabel}</span>
        <div class="mini-quantity" aria-label="Số lượng ${product.name}">
          <button type="button" data-mini-quantity="decrease" data-product="${id}" aria-label="Giảm số lượng ${product.name}" ${quantity <= 1 ? "disabled" : ""}>−</button>
          <span>${quantity}</span>
          <button type="button" data-mini-quantity="increase" data-product="${id}" aria-label="Tăng số lượng ${product.name}" ${quantity >= 99 ? "disabled" : ""}>+</button>
          <button class="mini-remove" type="button" data-mini-remove="${id}">Xóa</button>
        </div>
      </div>
      <strong class="mini-line-total">${formatPrice(product.price * quantity)}</strong>
    </article>`).join("");

  if (footer) footer.hidden = false;
  if (totalElement) totalElement.textContent = formatPrice(total);
}

function bindGlobalControls() {
  document.addEventListener("click", (event) => {
    const addButton = event.target.closest("[data-add-to-cart]");
    if (addButton) {
      const id = addButton.dataset.addToCart;
      const product = products.find((item) => item.id === id);
      if (!product) return;
      const cart = readCart();
      const existing = cart.find((item) => item.id === id);
      if (existing) existing.quantity = Math.min(existing.quantity + 1, 99);
      else cart.push({ id, quantity: 1 });
      if (!writeCart(cart)) return;
      const feedback = document.querySelector("[data-cart-feedback]");
      if (feedback) feedback.textContent = `${product.name} đã được thêm vào giỏ.`;
      addButton.setAttribute("aria-label", `${product.name} đã được thêm vào giỏ hàng`);
      document.dispatchEvent(new CustomEvent("gaeru:open-cart"));
      return;
    }

    const removeButton = event.target.closest("[data-remove]");
    if (removeButton) {
      const cart = readCart().filter((item) => item.id !== removeButton.dataset.remove);
      if (writeCart(cart)) renderCart();
      return;
    }

    const miniRemove = event.target.closest("[data-mini-remove]");
    if (miniRemove) {
      const removedId = miniRemove.dataset.miniRemove;
      const cart = readCart().filter((item) => item.id !== miniRemove.dataset.miniRemove);
      if (writeCart(cart)) {
        renderCart();
        const nextControl = document.querySelector("[data-mini-cart] .mini-remove, [data-mini-cart] .mini-cart-empty .button");
        nextControl?.focus();
      }
      return;
    }

    const quantityButton = event.target.closest("[data-mini-quantity]");
    if (quantityButton) {
      const productId = quantityButton.dataset.product;
      const action = quantityButton.dataset.miniQuantity;
      const cart = readCart();
      const item = cart.find((entry) => entry.id === productId);
      if (!item) return;
      const change = action === "increase" ? 1 : -1;
      item.quantity = Math.max(1, Math.min(99, item.quantity + change));
      writeCart(cart);
      const focusedAction = action === "decrease" && item.quantity === 1 ? "increase" : action;
      document.querySelector(`[data-mini-quantity="${focusedAction}"][data-product="${productId}"]`)?.focus();
    }
  });

  document.addEventListener("change", (event) => {
    const input = event.target.closest("[data-quantity]");
    if (!input) return;
    const quantity = Math.max(1, Math.min(99, Number.parseInt(input.value, 10) || 1));
    const cart = readCart();
    const item = cart.find((entry) => entry.id === input.dataset.quantity);
    if (!item) return;
    item.quantity = quantity;
    if (writeCart(cart)) {
      renderCart();
      document.querySelector(`[data-quantity="${input.dataset.quantity}"]`)?.focus();
    }
  });
}

updateCartBadge(readCart());
window.GAERUStore = Object.freeze({ products, formatPrice, searchProducts });
document.addEventListener("gaeru:cart-updated", renderMiniCart);
document.addEventListener("gaeru:cart-panel-open", renderMiniCart);
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== cartStorageKey) return;
  const cart = readCart();
  updateCartBadge(cart);
  renderMiniCart();
  renderCart();
});
bindGlobalControls();
renderCatalog();
renderProduct();
renderCart();
renderCheckout();
renderMiniCart();
