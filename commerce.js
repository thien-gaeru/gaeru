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
    normalizeSearchText(`${product.name} ${product.slug} ${product.description} ${product.category} ${product.descriptor} ${(product.variants || []).map(variant => `${variant.name} ${variant.sku}`).join(" ")}`).includes(normalized)
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
  return low === high ? formatPrice(low) : `Từ ${formatPrice(low)} đến ${formatPrice(high)}`;
}

function promotionLabel(product){const sale=product.variants.filter(v=>v.active&&v.promotion);if(!sale.length)return '';const flash=sale.some(v=>v.promotion.type==='flash');const end=sale.filter(v=>!flash||v.promotion.type==='flash').map(v=>new Date(v.promotion.endsAt).getTime()).sort((a,b)=>a-b)[0];return `<p class="store-promotion-note"><strong>${flash?'Flash Sale':'Ưu đãi sản phẩm'}</strong>${flash?` <span data-sale-end="${new Date(end).toISOString()}"></span>`:''} · Giá gốc ${escapeHtml(getPriceLabel({...product,variants:product.variants.map(v=>({...v,priceVnd:v.originalPriceVnd??v.priceVnd}))}))}</p>`;}
function productCard(product, compact = false) {
  const variants = product.variants.filter((variant) => variant.active);
  const availableVariants = variants.filter((variant) => variant.stockQuantity > 0);
  const cardImage = window.GAERUProductArtwork?.image(product) || product.imageUrl;
  const cardClass = compact
    ? `product-card ${product.slug === "k9" ? "product-card-dark" : ""} ${product.slug === "g1-ultra" ? "product-card-wide" : ""}`
    : `catalog-card ${product.slug === "k9" ? "catalog-card-dark" : ""}`;
  return compact ? `
    <article class="${cardClass}" id="${escapeHtml(product.slug)}" data-kind="${escapeHtml(product.category)}">
      <div class="product-copy">
        <p class="eyebrow">${escapeHtml(product.descriptor)}</p>
        <h3>${escapeHtml(product.cardTitle||product.name)}</h3>
        <p>${escapeHtml(String(product.cardSummary||'').replace(/\*\*|__/g,''))}</p>
        <p class="price">${escapeHtml(getPriceLabel(product))}</p>${promotionLabel(product)}

      </div>
      <img class="product-image" src="${escapeHtml(cardImage)}" alt="${escapeHtml(product.imageAlt)}" loading="lazy" decoding="async">
        <div class="card-actions">
          <button class="button button-blue" type="button" data-choose-cart="${escapeHtml(product.slug)}" ${availableVariants.length?"":"disabled"}>Thêm vào giỏ hàng</button>
          <a class="button button-outline" href="product.html?id=${encodeURIComponent(product.slug)}">${product.slug === "gaeru-m3" ? "Mua Ngay" : "Mua ngay"}</a>
        </div>
    </article>` : `
    <article class="${cardClass}">
      <a class="catalog-card-image" href="product.html?id=${encodeURIComponent(product.slug)}">
        <img src="${escapeHtml(cardImage)}" alt="${escapeHtml(product.imageAlt)}" loading="lazy" decoding="async">
      </a>
      <p class="eyebrow">${escapeHtml(product.descriptor)}</p>
      <h2><a href="product.html?id=${encodeURIComponent(product.slug)}">${escapeHtml(product.cardTitle||product.name)}</a></h2>
      <p class="catalog-description">${escapeHtml(String(product.cardSummary||'').replace(/\*\*|__/g,''))}</p>
      ${promotionLabel(product)}
      <div class="catalog-actions">
        <p class="catalog-price">${escapeHtml(getPriceLabel(product))}</p>
        <a class="button button-blue" href="product.html?id=${encodeURIComponent(product.slug)}">Mua Ngay</a>
      </div>
    </article>`;
}

function renderHomeProducts() {
  const grid = document.querySelector(".product-grid");
  if (!grid) return;
  grid.innerHTML = products.length
    ? products.map((product) => productCard(product, true)).join("")
    : '<p class="empty-state">Chưa có sản phẩm được xuất bản.</p>';
  const k9 = products.find((product) => ["k9","gaeru-k9"].includes(product.slug));
  if (k9) {
    const heroImage = document.querySelector(".hero-art img");
    if (heroImage) {
      heroImage.src = "/assets/products/k9.webp";
      heroImage.alt = k9.imageAlt;
    }
  }
  window.GAERUK9Loop?.mountHome();
}

function renderCatalog() {
  window.GAERUProductArtwork?.mountStory();
  const grid = document.querySelector("#catalog-grid");
  if (!grid) return;
  const queryInput = document.querySelector("#catalog-search");
  const count = document.querySelector("#catalog-count");
  const empty = document.querySelector("#catalog-empty");
  const initialQuery = new URLSearchParams(location.search).get("q") || "";
  const categoryParam = new URLSearchParams(location.search).get("category");
  const savedOnly=new URLSearchParams(location.search).get("saved")==="1";
  let selectedCategory = ["audio", "video", "accessory"].includes(categoryParam) ? categoryParam : "all";
  queryInput.value = initialQuery;
  const navigation=document.querySelector('[data-store-products]');
  const categoryArtwork=product=>window.GAERUProductArtwork?.image(product)||product.imageUrl;
  if(navigation)navigation.innerHTML=products.length?products.map(product=>`<a class="store-category" href="product.html?id=${encodeURIComponent(product.slug)}"><span class="category-art"><img ${product.slug==='gaeru-k9'?'data-k9-animate':''} src="${escapeHtml(categoryArtwork(product))}" alt="" width="144" height="120" loading="lazy" decoding="async"></span><span>${escapeHtml(product.name)}</span></a>`).join(''):'<p class="store-navigation-status">Chưa có sản phẩm đang được đăng bán.</p>';
  window.GAERUK9Loop?.mountHome();
  const updateRail = () => document.querySelectorAll('[data-store-scroll]').forEach(button => {
    button.disabled = Number(button.dataset.storeScroll) < 0 ? grid.scrollLeft <= 2 : grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 2;
  });
  document.querySelectorAll('[data-store-scroll]').forEach(button => button.addEventListener('click', () => grid.scrollBy({left: Number(button.dataset.storeScroll) * Math.max(280,grid.clientWidth * .8),behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'})));
  grid.addEventListener('scroll', updateRail, {passive:true});
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updateRail).observe(grid);

  const applyFilters = () => {
    const matching = searchProducts(queryInput.value.trim()).filter((product) =>
      (selectedCategory === "all" || product.category === selectedCategory) && (!savedOnly||window.GAERUSavedProducts?.has(product.slug))
    );
    grid.innerHTML = matching.map((product) => productCard(product)).join("");
    count.textContent = `${matching.length} sản phẩm`;
    empty.hidden = matching.length > 0;
    if(savedOnly)empty.textContent="Chưa có sản phẩm đã lưu phù hợp trên trình duyệt này.";
    grid.scrollLeft = 0;
    updateRail();
    window.GAERUAutoRail?.mount();
  };

  queryInput.addEventListener("input", applyFilters);
  applyFilters();
}

function safeProductImage(value) {
 const image=String(value||'').replace(/^https?:\/\/(?:www\.)?gaeru\.com(?=\/)/i,'').replace(/^assets\//,'/assets/');
 return /^\/(?:assets\/products\/|api\/catalog-images\/|media\/products\/)[a-zA-Z0-9/_.?=&%+-]+$/.test(image) ? image : '/assets/products/k9.webp';
}

function renderProduct() {
  const root = document.querySelector("#product-detail");
  if (!root) return;
  const slug = (new URLSearchParams(location.search).get("id") || (location.pathname.startsWith("/san-pham/") ? decodeURIComponent(location.pathname.split("/").pop()) : null));
  const product = products.find((item) => item.slug === slug || item.slug === "gaeru-"+slug);
  if (!product) {
    root.innerHTML = `<section class="not-found section-wrap"><p class="eyebrow">Không tìm thấy sản phẩm</p><h1>Sản phẩm này chưa có hoặc đang được cập nhật.</h1><a class="button button-blue" href="shop.html">Quay lại cửa hàng</a></section>`;
    return;
  }
  const variants = product.variants.filter((variant) => variant.active);
  const selected = variants.find((variant) => variant.stockQuantity > 0) || variants[0];
  const seoDescriptor=String(product.descriptor||'').replace(/\*\*/g,'').replace(/\s+/g,' ').trim();
  const seoLabel=(seoDescriptor||'Thiết bị sáng tạo GAERU').toLocaleLowerCase('vi').replace(/\bai\b/g,'AI');
  document.title=product.name+' — '+seoLabel.charAt(0).toLocaleUpperCase('vi')+seoLabel.slice(1);
  const breadcrumb = document.querySelector("#breadcrumb-product");
  if (breadcrumb) breadcrumb.textContent = product.name;
  const optionGroups=window.GAERUVariantChoices?.groups(variants,product.optionGroups)||[];
  const visualOptions=optionGroups.length?optionGroups.map(g=>`<div class="product-choice-group"><p>${escapeHtml(g.name)}</p><div class="product-choice-buttons" role="group" aria-label="${escapeHtml(g.name)}">${g.values.map(value=>`<button type="button" data-option-group="${escapeHtml(g.name)}" data-option-value="${escapeHtml(value)}" aria-pressed="${selected?.options?.[g.name]===value}">${escapeHtml(value)}</button>`).join("")}</div></div>`).join(""):variants.map(v=>`<button class="product-variant-card" type="button" data-visual-variant="${escapeHtml(v.id)}" aria-pressed="${v.id===selected?.id}">${escapeHtml(v.name)}<small>${formatPrice(v.priceVnd)}${v.stockQuantity?"":" · Hết hàng"}</small></button>`).join("");
  const variantField = variants.length ? `${visualOptions}<label class="variant-select-label variant-select-internal" for="product-variant">Phiên bản
      <select id="product-variant">
        ${variants.map((variant) => {
          const options = Object.entries(variant.options || {}).map(([key, value]) => `${key}: ${value}`).join(" · ");
          const label = [variant.name, options, `SKU ${variant.sku}`, variant.stockQuantity ? "" : "Hết hàng"].filter(Boolean).join(" — ");
          return `<option value="${escapeHtml(variant.id)}" ${variant.id === selected?.id ? "selected" : ""} ${variant.stockQuantity ? "" : "disabled"}>${escapeHtml(label)} · ${formatPrice(variant.priceVnd)}</option>`;
        }).join("")}
      </select>
    </label>
    <p class="detail-price" data-selected-price>${formatPrice(selected.priceVnd)}</p>` : `
    <p class="detail-price">Chưa có phiên bản để đặt hàng</p>`;

  root.innerHTML = `
    <header class="product-purchase-heading section-wrap"><p class="eyebrow">${escapeHtml(product.descriptor)}</p><h1>Mua ${escapeHtml(product.name)}</h1>${product.cardSummary?`<p class="product-purchase-intro">${escapeHtml(product.cardSummary)}</p>`:''}<div class="purchase-intro-links"><a class="text-link" href="#product-information">Thông tin chi tiết ↓</a></div></header>
    <section class="product-detail section-wrap" aria-label="Chọn phiên bản ${escapeHtml(product.name)}">
      <div class="product-detail-art"><img loading="eager" fetchpriority="high" decoding="async" data-product-main-image src="${escapeHtml(selected?.imageUrl||product.imageUrl)}" alt="${escapeHtml(product.imageAlt||product.name)}"><div class="product-gallery-thumbnails">${[...new Set([product.imageUrl,...(product.gallery||[])])].map((url,i)=>`<button type="button" data-gallery-image="${escapeHtml(url)}" aria-label="Xem ảnh ${i+1}" aria-pressed="${url===(selected?.imageUrl||product.imageUrl)}"><img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async"></button>`).join("")}</div></div>
      <div class="product-detail-copy">
        <h2 class="product-config-heading">Phiên bản. <span>Chọn kết nối phù hợp với bạn.</span></h2>
        ${variantField}<p data-selected-countdown class="store-sale-countdown"></p><p data-selected-promotion class="store-promotion-note">${selected?.promotion?escapeHtml((selected.promotion.type==='flash'?'Flash Sale':'Ưu đãi')+' · Giá gốc '+formatPrice(selected.originalPriceVnd)+' · Kết thúc '+new Date(selected.promotion.endsAt).toLocaleString('vi-VN')):''}</p>
        <section class="product-delivery" aria-label="Thông tin giao hàng"><svg viewBox="0 0 32 28" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 3h18v18H2zM20 10h6l4 6v5H20"/><circle cx="8" cy="22" r="3" fill="white"/><circle cx="25" cy="22" r="3" fill="white"/></svg><div><h3>Giao hàng</h3><p class="stock-note" data-stock-note>${selected ? (Number(selected.stockQuantity) > 0 ? "Còn hàng" : "Hết hàng") : "Hết hàng"}</p><p>Phí vận chuyển tính theo địa chỉ.</p><details data-delivery-details><summary>Nhận thông tin giao hàng ⊕</summary><div data-delivery-content>Đang tải thông tin…</div></details></div></section>
        <div class="detail-actions">
          <button class="button button-blue buy-now-button" type="button" data-buy-now="${escapeHtml(selected?.id || "")}" ${selected?.stockQuantity ? "" : "disabled"}>Mua ngay</button>
          <button class="button button-blue" type="button" data-add-to-cart="${escapeHtml(selected?.id || "")}" ${selected?.stockQuantity ? "" : "disabled"}>Thêm vào giỏ</button>
        </div>
        <p class="cart-feedback" data-cart-feedback aria-live="polite"></p>
        <section class="product-save-later"><h3>Vẫn chưa thể quyết định?</h3><p>Lưu sản phẩm để dễ dàng quay lại xem trên trình duyệt này.</p><button type="button" class="save-product-button" data-save-product="${escapeHtml(product.slug)}" aria-pressed="false">Lưu để xem lại sau</button><a href="shop.html?saved=1">Xem sản phẩm đã lưu ↗</a><p role="status" aria-live="polite"></p></section>
        <section class="product-shopping-help"><svg viewBox="0 0 32 30" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 3h20v17H10l-6 6v-6H3zM23 10h6v15h-7l-4 4v-9"/></svg><div><h3>Trợ giúp mua sắm.</h3><p><button type="button" class="chat-product-button" data-product-chat="${escapeHtml(product.slug)}">Chat ngay ↗</button> hoặc gọi <a href="tel:0829191080">082 919 1080</a>.</p><small>AI hỗ trợ trước; chọn Gặp nhân viên khi cần.</small></div></section>
      </div>
    </section>
    <section class="product-information section-wrap" id="product-information"><header><p class="eyebrow">TÌM HIỂU SẢN PHẨM</p><h2>${escapeHtml(product.name)}. <span>Chi tiết cho lựa chọn của bạn.</span></h2></header>${window.GAERUDescription?window.GAERUDescription.render(product):`<p class="detail-description">${escapeHtml(product.description)}</p>`}</section>
    <section class="detail-more"><p class="eyebrow">Khám phá thêm</p><h2>Thiết bị khác. Cùng cảm hứng.</h2><a class="text-link" href="shop.html">Xem toàn bộ cửa hàng <span aria-hidden="true">›</span></a></section>`;

  const selector = root.querySelector("#product-variant");
  const countdown=root.querySelector('[data-selected-countdown]');
  const setCountdown=variant=>{if(variant?.promotion?.type==='flash')countdown.dataset.saleEnd=new Date(variant.promotion.endsAt).toISOString();else{delete countdown.dataset.saleEnd;countdown.textContent='';}};
  setCountdown(selected);
  selector?.addEventListener("change", () => {
    const variant = variants.find((item) => item.id === selector.value);
    if (!variant) return;
    setCountdown(variant);
    root.querySelector("[data-selected-price]").textContent = formatPrice(variant.priceVnd);
    root.querySelector("[data-selected-promotion]").textContent=variant.promotion?(variant.promotion.type==='flash'?'Flash Sale':'Ưu đãi')+' · Giá gốc '+formatPrice(variant.originalPriceVnd)+' · Kết thúc '+new Date(variant.promotion.endsAt).toLocaleString('vi-VN'):'';
    root.querySelector("[data-stock-note]").textContent = Number(variant.stockQuantity) > 0 ? "Còn hàng" : "Hết hàng";
    const button = root.querySelector("[data-add-to-cart]");
    button.dataset.addToCart = variant.id;
    button.disabled = variant.stockQuantity === 0;
    const buyNow=root.querySelector("[data-buy-now]");buyNow.dataset.buyNow=variant.id;buyNow.disabled=variant.stockQuantity===0;
    root.querySelectorAll("[data-option-group]").forEach(b=>b.setAttribute("aria-pressed",String(variant.options?.[b.dataset.optionGroup]===b.dataset.optionValue)));
    root.querySelectorAll("[data-visual-variant]").forEach(b=>b.setAttribute("aria-pressed",String(variant.id===b.dataset.visualVariant)));
    const image=root.querySelector("[data-product-main-image]");image.src=safeProductImage(variant.imageUrl||product.imageUrl);image.alt=variant.name+" · "+product.name;root.querySelectorAll("[data-gallery-image]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.galleryImage===(variant.imageUrl||product.imageUrl))));
  });
  let galleryTouch=null;
  root.addEventListener('touchstart',event=>{galleryTouch=event.touches.length===1&&event.target.closest('[data-product-main-image]')?{x:event.touches[0].clientX,y:event.touches[0].clientY}:null;},{passive:true});
  root.addEventListener('touchcancel',()=>{galleryTouch=null;},{passive:true});
  root.addEventListener('touchend',event=>{const start=galleryTouch;galleryTouch=null;if(!start||event.changedTouches.length!==1)return;const dx=event.changedTouches[0].clientX-start.x,dy=event.changedTouches[0].clientY-start.y;if(Math.abs(dx)<40||Math.abs(dx)<Math.abs(dy)*1.5)return;const buttons=[...root.querySelectorAll('[data-gallery-image]')];if(buttons.length<2)return;const current=buttons.findIndex(b=>b.getAttribute('aria-pressed')==='true');const next=buttons[(Math.max(0,current)+(dx<0?1:-1)+buttons.length)%buttons.length];next.click();const rail=next.parentElement;rail.scrollTo({left:Math.max(0,next.offsetLeft-rail.offsetLeft-(rail.clientWidth-next.offsetWidth)/2),behavior:'smooth'});},{passive:true});
  root.addEventListener("click",e=>{const imageButton=e.target.closest("[data-gallery-image]");if(imageButton){root.querySelector("[data-product-main-image]").src=safeProductImage(imageButton.dataset.galleryImage);root.querySelectorAll("[data-gallery-image]").forEach(b=>b.setAttribute("aria-pressed",String(b===imageButton)));return;}const option=e.target.closest("[data-option-group]"),direct=e.target.closest("[data-visual-variant]");if(!option&&!direct)return;const current=variants.find(v=>v.id===selector.value);const next=direct?variants.find(v=>v.id===direct.dataset.visualVariant):window.GAERUVariantChoices.choose(variants,current,option.dataset.optionGroup,option.dataset.optionValue);if(next){selector.value=next.id;selector.dispatchEvent(new Event("change"));}});
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
          <a class="cart-item-image" href="product.html?id=${encodeURIComponent(product.slug)}"><img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.imageAlt)}" loading="lazy" decoding="async"></a>
          <div class="cart-item-info">
            <h2><a href="product.html?id=${encodeURIComponent(product.slug)}">${escapeHtml(product.cardTitle||product.name)}</a></h2>
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
  const purchase=window.GAERUCheckout.selection(products,location.search);
  const rows = cartRows(purchase.direct?purchase.items:readCart());
  if (!rows.length) {
    root.innerHTML = `<div class="empty-cart"><h2>${purchase.direct?"Phiên bản này hiện không còn hàng hoặc không còn được bán.":"Chưa có sản phẩm để đặt hàng."}</h2><a class="button button-blue" href="shop.html">Quay lại cửa hàng</a></div>`;
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
  const shippingCarriers=storeSettings.shippingCarriers||[];
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
  root.classList.add("checkout-single");
  root.innerHTML = `
    <form class="checkout-form" id="checkout-form">
      <div class="checkout-notice" role="status"><strong>Đơn hàng được xử lý trực tiếp bởi GAERU.</strong> Phí giao hàng được tính theo tỉnh/thành phố bạn chọn.</div>
      <label class="saved-address-label" data-saved-address-label hidden>Địa chỉ đã lưu<select data-saved-address><option value="">Nhập địa chỉ mới</option></select></label><p class="address-status" data-address-status role="status"></p>
      <details class="checkout-contact-details" data-contact-details open><summary>Thông tin giao hàng<span data-contact-summary></span></summary>
      <div class="form-section">
        <h2>Thông tin liên hệ</h2>
        <label>Họ và tên<input name="name" autocomplete="name" required maxlength="120"></label>
        <div class="form-row">
          <label>Email<input type="email" name="email" autocomplete="email" required maxlength="254" placeholder="Ví dụ: hotro@gaeru.com"></label>
          <label>Số điện thoại<input type="tel" name="phone" autocomplete="tel" required maxlength="20" placeholder="10 số di động (Ví dụ: 0912345678)"></label>
        </div>
      </div>
      <div class="form-section">
        <h2>Địa chỉ giao hàng</h2>
        <label>Địa chỉ<input name="address" autocomplete="street-address" required maxlength="250"></label>
        <div class="form-row">
          <label>Tỉnh / thành phố<input name="city" autocomplete="address-level1" required maxlength="120" list="checkout-cities" placeholder="Nhập tỉnh/thành phố"><datalist id="checkout-cities">${provinces.filter(p=>p!=='Toàn quốc').map(p=>`<option value="${escapeHtml(p)}"></option>`).join('')}</datalist></label>
          <label class="checkout-note"><span class="checkout-field-title">Ghi chú <small>(không bắt buộc)</small></span><input name="note" maxlength="1000"></label>
        </div>
      </div>
      </details>
      ${shippingCarriers.length?`<section class="form-section checkout-carrier"><h2>Đơn vị vận chuyển</h2><label>Chọn hãng giao hàng<select name="shippingCarrierId" required><option value="">Chọn đơn vị vận chuyển</option>${shippingCarriers.map(carrier=>`<option value="${escapeHtml(carrier.id)}">${escapeHtml(carrier.name)}</option>`).join('')}</select></label><p class="prototype-note">Phí giao hàng hiển thị theo địa chỉ và bảng phí của GAERU.</p></section>`:''}
      <aside class="checkout-summary cart-summary">
      <h2>Đơn hàng</h2>
      ${rows.map(({ quantity, product, variant }) => `
        <p class="checkout-product"><span>${escapeHtml(product.name)}<br><small>${escapeHtml(variant.name)} × ${quantity}</small></span><strong>${formatPrice(variant.priceVnd * quantity)}</strong></p>`).join("")}
      <p class="summary-total"><span>Tạm tính</span><strong>${formatPrice(total)}</strong></p>
      <p class="checkout-product"><span>Giao hàng</span><strong data-checkout-shipping>Chọn tỉnh/thành</strong></p>
      <section class="checkout-voucher"><label class="visually-hidden" for="checkout-voucher-code">Mã voucher</label><input id="checkout-voucher-code" maxlength="40" placeholder="Nhập mã voucher" autocomplete="off"><button class="secondary-button" type="button" data-voucher-apply aria-label="Kiểm tra voucher" title="Kiểm tra voucher">✓</button><button class="secondary-button" type="button" data-voucher-wallet>Ví mã ↗</button><p role="status" data-voucher-feedback></p></section><p class="checkout-product checkout-discount"><span>Giảm giá voucher</span><strong data-checkout-discount>0 ₫</strong></p>
      <p class="summary-total"><span>Tổng cộng</span><strong data-checkout-total>Chọn tỉnh/thành</strong></p>
      <p class="prototype-note">${escapeHtml(storeSettings.shippingNote || "Phí giao hàng được tính theo tỉnh/thành phố đã chọn.")}</p>
    </aside><div class="form-section">
        <h2>Phương thức thanh toán</h2>
        <label>
          <select name="paymentMethod" aria-label="Phương thức thanh toán">
            ${paymentMethods.includes("cod") ? '<option value="cod">Thanh toán khi nhận hàng (COD)</option>' : ""}
            ${paymentMethods.includes("bank_transfer") ? '<option value="bank_transfer">Chuyển khoản ngân hàng</option>' : ""}
            ${paymentMethods.includes("vnpay") ? '<option value="vnpay">Thanh toán trực tuyến qua VNPAY</option>' : ""}

            ${paymentMethods.includes("9pay") ? '<option value="9pay">Thanh toán trực tuyến qua 9Pay</option>' : ""}
            ${paymentMethods.includes("momo") ? '<option value="momo">Ví điện tử MoMo</option>' : ""}
            ${paymentMethods.includes("zalopay") ? '<option value="zalopay">Ví điện tử ZaloPay</option>' : ""}

          </select>
        </label>
        <p class="payment-placeholder" data-payment-help>GAERU sẽ xác nhận đơn hàng trước khi gửi.</p>
      </div>
      <p class="checkout-account-notice">Khi đặt hàng, GAERU tạo tài khoản theo email nếu bạn chưa có tài khoản và gửi hướng dẫn đặt mật khẩu. Bạn không tự động đăng ký nhận tin quảng cáo.</p><p class="checkout-privacy-notice">Thông tin bạn cung cấp được sử dụng để tiếp nhận và xử lý đơn hàng theo <a href="privacy.html">Chính sách quyền riêng tư</a>. <a href="terms.html">Điều khoản mua hàng</a>.</p>
      <button class="button button-blue" type="submit">Đặt hàng</button>
      <p class="checkout-feedback" id="checkout-feedback" aria-live="polite"></p>
    </form>
`;

  window.GAERUAddress?.enhance(root);
  const form = root.querySelector("#checkout-form");
  const paymentMethod = form.elements.paymentMethod;
  const paymentHelp = form.querySelector("[data-payment-help]");
  let voucherDiscount=0,appliedVoucher="";
  const updateShippingTotal = () => {
    const fee = window.GAERUCheckout.shippingFee(shippingRates,form.elements.city.value);
    root.querySelector("[data-checkout-shipping]").textContent =
      fee === undefined ? "Chọn tỉnh/thành" : formatPrice(fee);
    root.querySelector("[data-checkout-total]").textContent =
      fee === undefined ? "Chọn tỉnh/thành" : formatPrice(total + fee - voucherDiscount);
  };
  const voucherInput=root.querySelector('#checkout-voucher-code'),voucherFeedback=root.querySelector('[data-voucher-feedback]');
  const resetVoucher=()=>{voucherDiscount=0;appliedVoucher='';root.querySelector('[data-checkout-discount]').textContent=formatPrice(0);updateShippingTotal();};
  let voucherRevision=0,voucherTimer;
  const validateVoucher=async()=>{const revision=++voucherRevision,code=voucherInput.value.trim().toUpperCase();if(!code)return false;try{const quote=await apiRequest('/api/customer/marketing/quote',{method:'POST',body:JSON.stringify({code,items:rows.map(({variantId,quantity})=>({variantId,quantity}))})});if(revision!==voucherRevision||voucherInput.value.trim().toUpperCase()!==code)return false;if(quote.subtotalVnd!==total)throw Error('Giá đã thay đổi. Tải lại trang trước khi áp dụng.');appliedVoucher=quote.code;voucherDiscount=quote.discountVnd;root.querySelector('[data-checkout-discount]').textContent='−'+formatPrice(voucherDiscount);voucherFeedback.textContent=quote.message;updateShippingTotal();return true;}catch(error){if(revision===voucherRevision){resetVoucher();voucherFeedback.textContent=error.message;}return false;}};
  voucherInput.addEventListener('input',()=>{voucherRevision++;clearTimeout(voucherTimer);resetVoucher();voucherFeedback.textContent='';if(voucherInput.value.trim())voucherTimer=setTimeout(()=>validateVoucher(),650);});
  voucherInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();clearTimeout(voucherTimer);void validateVoucher();}});
  root.querySelector('[data-voucher-wallet]').addEventListener('click',event=>{window.GAERUVoucherWallet?.open({request:apiRequest,total,opener:event.currentTarget,onSelect:async code=>{voucherRevision++;clearTimeout(voucherTimer);voucherInput.value=code;resetVoucher();voucherFeedback.textContent='';if(!code)return {ok:true};const ok=await validateVoucher();return {ok,message:voucherFeedback.textContent};}});});
  root.querySelector('[data-voucher-apply]').addEventListener('click',()=>{clearTimeout(voucherTimer);void validateVoucher();});
  form.elements.city.addEventListener("change", updateShippingTotal);
  form.elements.city.addEventListener("input", updateShippingTotal);
  root.shippingRates=shippingRates;
  window.GAERUCheckout.hydrateContact({root,form,request:apiRequest,updateTotal:updateShippingTotal});
  updateShippingTotal();
  const updatePaymentHelp = () => {
    const bank = storeSettings.bankTransfer;
    const map = {
      cod: storeSettings.cod?.instructions || "Thanh toán trực tiếp khi nhận hàng. GAERU sẽ xác nhận đơn trước khi gửi.",
      bank_transfer: bank
        ? `Chuyển khoản tới ${bank.bankName} · STK ${bank.accountNumber} (${bank.accountHolder}) với nội dung theo cú pháp ${bank.transferSyntax}. Giao dịch khớp tự động sẽ duyệt đơn sang Chờ gửi hàng, bỏ qua bước xác nhận.`
        : "Chuyển khoản ngân hàng theo cú pháp mã đơn. Đơn được duyệt tự động sang Chờ gửi hàng ngay khi khớp giao dịch.",
      vnpay: "Bạn sẽ được chuyển tới VNPAY để thanh toán an toàn. Giao dịch thành công sẽ tự động duyệt đơn sang Chờ gửi hàng.",
      "9pay": "Bạn sẽ được chuyển tới cổng 9Pay để thanh toán. Giao dịch thành công sẽ tự động duyệt đơn sang Chờ gửi hàng.",
      momo: "Bạn sẽ được chuyển tới Ví MoMo để thanh toán. Giao dịch thành công sẽ tự động duyệt đơn sang Chờ gửi hàng.",
      zalopay: "Bạn sẽ được chuyển tới Ví ZaloPay để thanh toán. Giao dịch thành công sẽ tự động duyệt đơn sang Chờ gửi hàng."
    };
    paymentHelp.textContent = map[paymentMethod.value] || map.cod;
  };



  // bind paymentMethod change
  paymentMethod.addEventListener("change", updatePaymentHelp);
  updatePaymentHelp();

  let sending=false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if(sending)return;
    sending=true;
    const button = form.querySelector('button[type="submit"]');
    const feedback = root.querySelector("#checkout-feedback");
    button.disabled = true;
    feedback.textContent = "Đang gửi yêu cầu đặt hàng…";
    try {
      if (window.GAERUCheckout.shippingFee(shippingRates,form.elements.city.value)===undefined)throw Error("Chưa có phí giao hàng cho tỉnh/thành phố này. Kiểm tra lại địa chỉ.");
      if(shippingCarriers.length&&!form.elements.shippingCarrierId?.value)throw Error('Vui lòng chọn đơn vị vận chuyển.');
      if (!csrfToken) csrfToken = (await apiRequest("/api/csrf")).csrfToken;
      if(voucherInput.value.trim()&&appliedVoucher!==voucherInput.value.trim().toUpperCase()){clearTimeout(voucherTimer);if(!await validateVoucher())throw Error('Voucher chưa hợp lệ. Kiểm tra hoặc bỏ mã để tiếp tục.');}
      const result = await apiRequest("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          customer: {
            name: form.elements.name.value,
            email: form.elements.email.value,
            phone: form.elements.phone.value,
            address: window.GAERUAddress?.getAddress?.(form) || form.elements.address.value,
            city: form.elements.city.value,
            note: form.elements.note.value
          },
          shippingCarrierId:form.elements.shippingCarrierId?.value||undefined,
          expectedShippingFeeVnd:window.GAERUCheckout.shippingFee(shippingRates,form.elements.city.value),
          voucherCode:appliedVoucher||undefined,
          paymentMethod: paymentMethod.value,
          expectedSubtotalVnd:total,
          items: rows.map(({ variantId, quantity }) => ({ variantId, quantity }))
        })
      });
      if(!purchase.direct)writeCart([]);
      if (result.paymentUrl) {
        location.assign(result.paymentUrl);
        return;
      }
      const bt = result.bankTransfer;
      root.innerHTML = `<div class="order-success" role="status"><p class="eyebrow">Đã tiếp nhận đơn</p><h2>Mã đơn ${escapeHtml(result.order.orderNumber)}</h2><p>${escapeHtml(result.message)}</p><p>Thông tin đơn hàng và hướng dẫn tài khoản, nếu cần, sẽ được gửi tới email bạn đã nhập. Nếu chưa thấy thư, kiểm tra thư rác hoặc liên hệ GAERU.</p><p>Tạm tính ${formatPrice(result.order.subtotalVnd)} ${result.order.discountVnd?`· Giảm giá −${formatPrice(result.order.discountVnd)}`:""} · Giao hàng ${formatPrice(result.order.shippingFeeVnd)} · Tổng cộng ${formatPrice(result.order.totalVnd)}</p>${result.order.shippingCarrierName?`<p>Đơn vị vận chuyển: <strong>${escapeHtml(result.order.shippingCarrierName)}</strong></p>`:""}${bt?`<div class="checkout-notice"><strong>Thông tin chuyển khoản ngân hàng</strong><p>Ngân hàng: <strong>${escapeHtml(bt.bankName)}</strong>${bt.branch?` (${escapeHtml(bt.branch)})`:""}<br>Số tài khoản: <strong>${escapeHtml(bt.accountNumber)}</strong><br>Chủ tài khoản: <strong>${escapeHtml(bt.accountHolder)}</strong><br>Số tiền: <strong>${formatPrice(bt.amountVnd ?? result.order.totalVnd)}</strong><br>Nội dung chuyển khoản: <strong>${escapeHtml(bt.transferContent)}</strong></p><p data-prepaid-live-status>Hệ thống đang tự động kiểm tra và so khớp giao dịch của bạn…</p></div>`:`<p>Đơn COD sẽ được GAERU xác nhận và thu tiền khi giao hàng.</p>`}<a class="button button-blue" href="shop.html">Tiếp tục khám phá</a></div>`;
      if (bt) {
        const pollTimer = setInterval(async () => {
          const liveNode = root.querySelector("[data-prepaid-live-status]");
          if (!liveNode) { clearInterval(pollTimer); return; }
          try {
            const check = await apiRequest(`/api/payments/order-status?order=${encodeURIComponent(result.order.orderNumber)}`);
            if (check.order?.paymentStatus === "paid") {
              liveNode.textContent = "Đã so khớp giao dịch thành công! Đơn hàng đã tự động duyệt sang trạng thái Chờ gửi hàng.";
              clearInterval(pollTimer);
            }
          } catch {}
        }, 4000);
      }
    } catch (error) {
      feedback.textContent = error.message;
      button.disabled = false;
      sending=false;
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
      <a class="mini-cart-image" href="product.html?id=${encodeURIComponent(product.slug)}"><img src="${escapeHtml(product.imageUrl)}" alt="" loading="lazy" decoding="async"></a>
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
    const buyNow=event.target.closest('[data-buy-now]');
    if(buyNow){if(buyNow.disabled)return;const row=cartRows([{variantId:buyNow.dataset.buyNow,quantity:1}])[0];if(row?.variant.active&&row.variant.stockQuantity>0)location.assign('/thanh-toan?variant='+encodeURIComponent(row.variant.id));return;}
    const choose=event.target.closest('[data-choose-cart]');
    if(choose){if(choose.disabled)return;const product=products.find(p=>p.slug===choose.dataset.chooseCart);if(!product)return;let dialog=document.querySelector('#quick-cart-dialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='quick-cart-dialog';dialog.className='quick-cart-dialog';document.body.append(dialog);}dialog.innerHTML=`<header><h2>Thêm ${escapeHtml(product.name)} vào giỏ</h2><button type="button" data-close-quick-cart aria-label="Đóng">×</button></header><label>Chọn phiên bản<select data-quick-variant><option value="">Chọn phiên bản phù hợp</option>${product.variants.filter(v=>v.active).map(v=>`<option value="${escapeHtml(v.id)}" ${v.stockQuantity>0?'':'disabled'}>${escapeHtml(v.name)} · ${formatPrice(v.priceVnd)}${v.stockQuantity>0?'':' · Hết hàng'}</option>`).join('')}</select></label><button type="button" class="button button-blue" data-add-to-cart="" disabled>Thêm vào giỏ hàng</button><p data-cart-feedback role="status"></p>`;dialog.querySelector('[data-close-quick-cart]').onclick=()=>dialog.close();const picker=dialog.querySelector('[data-quick-variant]'),button=dialog.querySelector('[data-add-to-cart]');picker.onchange=()=>{button.dataset.addToCart=picker.value;button.disabled=!picker.value;};dialog.showModal();return;}
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
      addButton.closest("#quick-cart-dialog")?.close();
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

function updateSaleCountdowns(){document.querySelectorAll('[data-sale-end]').forEach(node=>{const seconds=Math.max(0,Math.floor((new Date(node.dataset.saleEnd)-Date.now())/1000));if(!seconds){node.textContent='Đã kết thúc · tải lại để cập nhật giá';return;}const days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60);node.textContent='Còn '+(days?days+' ngày ':'')+String(hours).padStart(2,'0')+':'+String(minutes).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');});}
setInterval(updateSaleCountdowns,1000);
function showStoreError(error) {
  console.error("Không thể tải dữ liệu cửa hàng GAERU:", error);
  const message = document.createElement("p");
  message.className = "store-error";
  message.setAttribute("role", "alert");
  message.textContent = "Không thể kết nối máy chủ cửa hàng. Hãy thử tải lại trang hoặc gọi 082 919 1080 để được hỗ trợ.";
  const call=document.createElement("a");call.href="tel:0829191080";call.textContent=" Gọi GAERU 082 919 1080";message.append(call);
  document.querySelector("main")?.prepend(message);
  const grid = document.querySelector(".product-grid, #catalog-grid");
  if (grid && !grid.hasAttribute("data-ssr")) grid.replaceChildren();
}

async function initializeStore() {
  renderMiniCart();
  try {
    const embedded=document.querySelector('#store-bootstrap');
    const response = embedded ? JSON.parse(embedded.textContent) : await apiRequest("/api/products");
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
