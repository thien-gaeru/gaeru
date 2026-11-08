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
const normalizeExternalUrl = (url) => { if (!url) return ""; const trimmed = String(url).trim(); return /^https?:\/\//i.test(trimmed) ? trimmed : "https://" + trimmed; };

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

let serverCartSyncTimer = null;
function syncCartToServer(cart) {
  if (typeof window === "undefined" || !window.GAERUCustomerSession?.customer) return;
  clearTimeout(serverCartSyncTimer);
  serverCartSyncTimer = setTimeout(async () => {
    try {
      await apiRequest("/api/customer/cart", {
        method: "PUT",
        body: JSON.stringify({ items: cart.map(i => ({ variantId: i.variantId, quantity: i.quantity })) })
      });
    } catch (_) {}
  }, 300);
}

let isMergingCart = false;
async function mergeCartWithServer() {
  if (isMergingCart || typeof window === "undefined" || !window.GAERUCustomerSession?.customer) return;
  isMergingCart = true;
  try {
    const local = readCart();
    const result = await apiRequest("/api/customer/cart/merge", {
      method: "POST",
      body: JSON.stringify({ localItems: local.map(i => ({ variantId: i.variantId, quantity: i.quantity })) })
    });
    if (result && Array.isArray(result.items)) {
      const merged = result.items.map(i => ({ variantId: i.variantId, quantity: i.quantity }));
      localStorage.setItem(cartStorageKey, JSON.stringify(merged));
      updateCartBadge(merged);
      document.dispatchEvent(new CustomEvent("gaeru:cart-updated"));
    syncCartToServer(cart);
      renderCart();
      renderMiniCart();
      renderCheckout();
    }
  } catch (_) {}
  finally {
    isMergingCart = false;
  }
}

function writeCart(cart) {
  try {
    localStorage.setItem(cartStorageKey, JSON.stringify(cart));
    updateCartBadge(cart);
    document.dispatchEvent(new CustomEvent("gaeru:cart-updated"));
    syncCartToServer(cart);
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

function getPriceLabel(product, original = false) {
  const availableVariants = product.variants.filter((variant) => variant.active);
  if (!availableVariants.length) return "Chưa mở bán";
  const prices = availableVariants.map((variant) => original ? (variant.originalPriceVnd ?? variant.priceVnd) : variant.priceVnd);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return low === high ? formatPrice(low) : `Từ ${formatPrice(low)} đến ${formatPrice(high)}`;
}

function promotionLabel(product){const sale=product.variants.filter(v=>v.active&&v.promotion);if(!sale.length)return '';const flash=sale.some(v=>v.promotion.type==='flash');const end=sale.filter(v=>!flash||v.promotion.type==='flash').map(v=>new Date(v.promotion.endsAt).getTime()).sort((a,b)=>a-b)[0];const salePrice=getPriceLabel(product,false);return `<p class="store-promotion-note ${flash?'is-flash':''}"><strong class="promotion-badge">${flash?'Flash Sale':'Ưu đãi'}</strong>${flash?` <span class="sale-countdown" data-sale-end="${new Date(end).toISOString()}"></span>`:''} <span class="promotion-divider">·</span> <span class="promotion-sale-price">${escapeHtml(salePrice)}</span></p>`;}
function formatPriceRangeHTML(priceStr){if(!priceStr||typeof priceStr!=='string')return escapeHtml(priceStr);const match=/^Từ\s+(.+?)\s+đến\s+(.+)$/i.exec(priceStr.trim());if(!match)return escapeHtml(priceStr);const low=match[1],high=match[2];return `<span class="price-text-full">Từ ${escapeHtml(low)} đến ${escapeHtml(high)}</span><span class="price-text-compact">${escapeHtml(low)} – ${escapeHtml(high)}</span>`;}
function productCard(product, compact = false) {
  const variants = product.variants.filter((variant) => variant.active);
  const availableVariants = variants.filter((variant) => variant.stockQuantity > 0);
  const cardImage = window.GAERUProductArtwork?.image(product) || product.imageUrl;
  const pUrl = `/san-pham/${encodeURIComponent(product.slug)}`;
  const cardClass = compact
    ? `product-card ${product.slug === "k9" ? "product-card-dark" : ""} ${product.slug === "g1-ultra" ? "product-card-wide" : ""}`
    : `catalog-card ${product.slug === "k9" ? "catalog-card-dark" : ""}`;
  return compact ? `
    <article class="${cardClass}" id="${escapeHtml(product.slug)}" data-kind="${escapeHtml(product.category)}" data-href="${pUrl}" tabindex="0" role="link" aria-label="${escapeHtml(product.cardTitle||product.name)}">
      <div class="product-copy">
        <p class="eyebrow">${escapeHtml(product.descriptor)}</p>
        <h3>${escapeHtml(product.cardTitle||product.name)}</h3>
        <p>${escapeHtml(String(product.cardSummary||'').replace(/\*\*|__/g,''))}</p>
        ${(()=>{const hasSale=product.variants.some(v=>v.active&&v.promotion);return hasSale?`<p class="price price-original"><span class="price-original-label">Giá gốc </span><del>${escapeHtml(getPriceLabel(product,true))}</del></p>${promotionLabel(product)}`:`<p class="price">${escapeHtml(getPriceLabel(product))}</p>`;})()}

      </div>
      <img class="product-image" src="${escapeHtml(cardImage)}" ${window.GAERUProductArtwork?.attributes?.(cardImage)||''} alt="${escapeHtml(product.imageAlt)}" loading="lazy" decoding="async">
        <div class="card-actions">
          <button class="button button-blue" type="button" data-choose-cart="${escapeHtml(product.slug)}" ${availableVariants.length?"":"disabled"}>Thêm vào giỏ hàng</button>
          <a class="button button-outline" href="${pUrl}">Mua ngay</a>
        </div>
    </article>` : `
    <article class="${cardClass}" data-href="${pUrl}" tabindex="0" role="link" aria-label="${escapeHtml(product.cardTitle||product.name)}">
      <a class="catalog-card-image" href="${pUrl}">
        <img src="${escapeHtml(cardImage)}" ${window.GAERUProductArtwork?.attributes?.(cardImage)||''} alt="${escapeHtml(product.imageAlt)}" loading="lazy" decoding="async">
      </a>
      <p class="eyebrow">${escapeHtml(product.descriptor)}</p>
      <h2><a href="${pUrl}">${escapeHtml(product.cardTitle||product.name)}</a></h2>
      <p class="catalog-description">${escapeHtml(String(product.cardSummary||'').replace(/\*\*|__/g,''))}</p>
      ${promotionLabel(product)}
      <div class="catalog-actions">
        <p class="catalog-price">${escapeHtml(getPriceLabel(product))}</p>
        <a class="button button-blue" href="${pUrl}">Mua Ngay</a>
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
  if(navigation)navigation.innerHTML=products.length?products.map(product=>`<a class="store-category" href="product.html?id=${encodeURIComponent(product.slug)}"><span class="category-art"><img ${product.slug==='gaeru-k9'?'data-k9-animate':''} src="${escapeHtml(categoryArtwork(product))}" ${window.GAERUProductArtwork?.attributes?.(categoryArtwork(product))||''} alt="" width="144" height="120" loading="lazy" decoding="async"></span><span>${escapeHtml(product.name)}</span></a>`).join(''):'<p class="store-navigation-status">Chưa có sản phẩm đang được đăng bán.</p>';
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

async function loadAndRenderBundles(product, currentVariantId) {
  const container = document.querySelector("[data-product-bundles-wrap]");
  if (!container) return;
  try {
    const res = await fetch(`/api/products/${encodeURIComponent(product.slug)}/bundles`);
    if (!res.ok) return;
    const { bundles } = await res.json();
    if (!bundles || !bundles.length) {
      container.innerHTML = "";
      return;
    }
    window.__currentBundles = bundles;
    renderBundlesHtml(container, bundles, currentVariantId);
  } catch (_) {}
}

function updateBundleCardPricing(card, bundle) {
  const currentSelector = document.querySelector("#product-variant");
  const primaryItem = bundle.primaryItems?.find(p => p.variantId === currentSelector?.value) || bundle.primaryItems?.[0];
  const primaryPrice = primaryItem ? primaryItem.priceVnd : 0;
  
  const checkedBoxes = [...(card.querySelectorAll("[data-bundle-accessory]:checked") || [])];
  let secondaryTotal = 0;
  for (const box of checkedBoxes) {
    const secItem = bundle.bundledItems?.find(it => it.variantId === box.dataset.bundleAccessory);
    if (secItem) secondaryTotal += secItem.priceVnd * (secItem.minQuantity || 1);
  }
  const originalTotal = primaryPrice + secondaryTotal;
  let discount = 0;
  if (checkedBoxes.length > 0) {
    if (bundle.discountType === 'percent') {
      discount = Math.floor(secondaryTotal * bundle.discountValue / 100);
    } else {
      discount = Math.min(originalTotal, bundle.discountValue);
    }
  }
  const finalTotal = Math.max(0, originalTotal - discount);
  const origEl = card.querySelector(`[data-bundle-orig="${bundle.id}"]`);
  const finalEl = card.querySelector(`[data-bundle-final="${bundle.id}"]`);
  if (origEl) origEl.textContent = formatPrice(originalTotal);
  if (finalEl) finalEl.textContent = formatPrice(finalTotal);
  const addBtn = card.querySelector(`[data-add-bundle="${bundle.id}"]`);
  if (addBtn) addBtn.disabled = checkedBoxes.length === 0;
}

function updateAllBundleCards(selectedVariantId) {
  const container = document.querySelector("[data-product-bundles-wrap]");
  if (!container || !window.__currentBundles) return;
  for (const bundle of window.__currentBundles) {
    const card = container.querySelector(`[data-bundle-id="${bundle.id}"]`);
    if (card) updateBundleCardPricing(card, bundle);
  }
}

function renderBundlesHtml(container, bundles, currentVariantId) {
  if (!container || !bundles) return;
  container.innerHTML = bundles.map(b => {
    const primaryItem = b.primaryItems?.find(p => p.variantId === currentVariantId) || b.primaryItems?.[0];
    const bundledItems = b.bundledItems || [];
    if (!primaryItem || !bundledItems.length) return "";
    return `
      <section class="product-bundle-cross-sell" data-bundle-id="${escapeHtml(b.id)}">
        <div class="bundle-header">
          <h3 class="bundle-title">
            <span>Ưu đãi mua kèm: ${escapeHtml(b.title)}</span>
            <span class="bundle-badge">-${b.discountType === 'percent' ? b.discountValue + '%' : formatPrice(b.discountValue)}</span>
          </h3>
          ${b.description ? `<p class="bundle-desc">${escapeHtml(b.description)}</p>` : ''}
        </div>
        <div class="bundle-items-flow">
          <div class="bundle-item-card primary-card">
            <img src="${escapeHtml(safeProductImage(primaryItem.imageUrl))}" alt="${escapeHtml(primaryItem.productName)}" loading="lazy">
            <div class="bundle-item-info">
              <strong>${escapeHtml(primaryItem.productName)}</strong>
              <small>${escapeHtml(primaryItem.variantName)}</small>
              <span class="item-price">${formatPrice(primaryItem.priceVnd)}</span>
            </div>
          </div>
          <span class="bundle-plus-icon" aria-hidden="true">+</span>
          ${bundledItems.map(item => `
            <div class="bundle-item-card secondary-card">
              <label class="bundle-accessory-choice">
                <input type="checkbox" data-bundle-accessory="${escapeHtml(item.variantId)}" checked>
                <img src="${escapeHtml(safeProductImage(item.imageUrl))}" alt="${escapeHtml(item.productName)}" loading="lazy">
                <div class="bundle-item-info">
                  <strong>${escapeHtml(item.productName)}</strong>
                  <small>${escapeHtml(item.variantName)}</small>
                  <span class="item-price">${formatPrice(item.priceVnd)}</span>
                </div>
              </label>
            </div>
          `).join('<span class="bundle-plus-icon" aria-hidden="true">+</span>')}
        </div>
        <div class="bundle-footer">
          <div class="bundle-price-box">
            <span class="bundle-original-price" data-bundle-orig="${escapeHtml(b.id)}">${formatPrice(b.originalComboTotal)}</span>
            <strong class="bundle-final-price" data-bundle-final="${escapeHtml(b.id)}">${formatPrice(b.discountedComboTotal)}</strong>
          </div>
          <button type="button" class="button button-blue bundle-add-button" data-add-bundle="${escapeHtml(b.id)}">
            Thêm combo vào giỏ
          </button>
        </div>
        <p class="bundle-feedback" data-bundle-feedback="${escapeHtml(b.id)}" role="status" aria-live="polite"></p>
      </section>
    `;
  }).join("");
}

function renderProduct() {
  const root = document.querySelector("#product-detail");
  if (!root) return;
  const searchParams = new URLSearchParams(location.search);
  const slug = (searchParams.get("id") || searchParams.get("slug") || (location.pathname.startsWith("/san-pham/") ? decodeURIComponent(location.pathname.split("/").pop()) : null));
  const product = products.find((item) => item.slug === slug || item.slug === "gaeru-"+slug);
  if (!product) {
    root.innerHTML = `<section class="not-found section-wrap"><p class="eyebrow">Không tìm thấy sản phẩm</p><h1>Sản phẩm này chưa có hoặc đang được cập nhật.</h1><a class="button button-blue" href="shop.html">Quay lại cửa hàng</a></section>`;
    return;
  }
  const variants = product.variants.filter((variant) => variant.active);
  const selected = null;
  const saleVariants = variants.filter(v => v.promotion);
  const flashVariants = saleVariants.filter(v => v.promotion.type === 'flash');
  const hasFlash = flashVariants.length > 0;
  const hasSale = saleVariants.length > 0;
  const initialFlashEnd = flashVariants.map(v => new Date(v.promotion.endsAt).getTime()).sort((a,b)=>a-b)[0];
  const initialSalePrice = getPriceLabel(product, false);
  const initialOriginalPrice = getPriceLabel(product, true);
  let initialDiscountPercent = 0;
  if (hasSale) {
    // GAERU F-17: Compute exact discount percentage per individual variant to prevent mismatched cross-SKU mixing
    const discounts = saleVariants.map(v => {
      const orig = v.originalPriceVnd ?? v.priceVnd;
      return orig > v.priceVnd ? Math.round((1 - v.priceVnd / orig) * 100) : 0;
    });
    initialDiscountPercent = Math.max(0, ...discounts);
  }
  const priceBoxHtml = `<div class="product-price-box ${hasFlash ? 'is-flash' : ''}" data-price-box><div class="product-flash-header" data-flash-header ${hasFlash ? '' : 'hidden'}><div class="flash-badge-wrap"><span class="flash-badge-icon" aria-hidden="true">⚡</span><strong class="promotion-badge flash-badge-pill">FLASH SALE</strong></div><div class="flash-timer-wrap"><span class="flash-timer-label">Kết thúc sau</span><span class="sale-countdown store-sale-countdown" data-selected-countdown ${initialFlashEnd ? `data-sale-end="${new Date(initialFlashEnd).toISOString()}"` : ''}></span></div></div><div class="product-price-body"><div class="product-price-main"><span class="detail-price ${hasFlash ? 'detail-price-flash' : ''}" data-selected-price>${formatPriceRangeHTML(initialSalePrice)}</span><span class="flash-price-tag" data-flash-tag ${hasFlash ? '' : 'hidden'}>Giá Flash Sale</span></div><div class="product-price-sub" data-price-sub ${hasSale ? '' : 'hidden'}><span class="price-original" data-selected-original><span class="price-original-label">Giá gốc: </span><del data-selected-original-price>${escapeHtml(initialOriginalPrice)}</del></span><span class="promotion-discount-badge" data-selected-discount ${initialDiscountPercent ? '' : 'hidden'}>-${initialDiscountPercent}%</span></div></div></div>`;
  const seoDescriptor=String(product.descriptor||'').replace(/\*\*/g,'').replace(/\s+/g,' ').trim();
  const seoLabel=(seoDescriptor||'Thiết bị sáng tạo GAERU').toLocaleLowerCase('vi').replace(/\bai\b/g,'AI');
  document.title=product.name+' — '+seoLabel.charAt(0).toLocaleUpperCase('vi')+seoLabel.slice(1);
  const breadcrumb = document.querySelector("#breadcrumb-product");
  if (breadcrumb) breadcrumb.textContent = product.name;
  const optionGroups=window.GAERUVariantChoices?.groups(variants,product.optionGroups)||[];
  const visualOptions=optionGroups.length?optionGroups.map(g=>`<div class="product-choice-group"><p>${escapeHtml(g.name)}</p><div class="product-choice-buttons" role="group" aria-label="${escapeHtml(g.name)}">${g.values.map(value=>`<button type="button" data-option-group="${escapeHtml(g.name)}" data-option-value="${escapeHtml(value)}" aria-pressed="false">${escapeHtml(value)}</button>`).join("")}</div></div>`).join(""):variants.map(v=>`<button class="product-variant-card" type="button" data-visual-variant="${escapeHtml(v.id)}" aria-pressed="false">${escapeHtml(v.name)}<small>${formatPrice(v.priceVnd)}${v.stockQuantity?"":" · Hết hàng"}</small></button>`).join("");
  const variantField = variants.length ? `${visualOptions}<label class="variant-select-label variant-select-internal" for="product-variant">Phiên bản
      <select id="product-variant">
        <option value="" disabled selected>Chọn phiên bản</option>
        ${variants.map((variant) => {
          const options = Object.entries(variant.options || {}).map(([key, value]) => `${key}: ${value}`).join(" · ");
          const label = [variant.name, options, `SKU ${variant.sku}`, variant.stockQuantity ? "" : "Hết hàng"].filter(Boolean).join(" — ");
          return `<option value="${escapeHtml(variant.id)}"  ${variant.stockQuantity ? "" : "disabled"}>${escapeHtml(label)} · ${formatPrice(variant.priceVnd)}</option>`;
        }).join("")}
      </select>
    </label>
    ${priceBoxHtml}` : `
    <p class="detail-price">Chưa có phiên bản để đặt hàng</p>`;

  root.innerHTML = `
    <header class="product-purchase-heading section-wrap"><p class="eyebrow">${escapeHtml(product.descriptor)}</p><h1>Mua ${escapeHtml(product.name)}</h1>${hasFlash ? `<div class="product-heading-flash-badge"><span class="flash-badge-icon" aria-hidden="true">⚡</span><span class="flash-badge-text">FLASH SALE ĐANG DIỄN RA ${initialDiscountPercent ? `· Tiết kiệm tới ${initialDiscountPercent}%` : ''}</span></div>` : ''}${product.cardSummary?`<p class="product-purchase-intro">${escapeHtml(product.cardSummary)}</p>`:''}<div class="purchase-intro-links"><a class="text-link" href="#product-information">Thông tin chi tiết ↓</a></div></header>
    <section class="product-detail section-wrap" aria-label="Chọn phiên bản ${escapeHtml(product.name)}">
      <div class="product-detail-art"><img loading="eager" fetchpriority="high" decoding="async" data-product-main-image src="${escapeHtml(safeProductImage(product.imageUrl))}" ${window.GAERUProductArtwork?.attributes?.(safeProductImage(product.imageUrl),true)||''} alt="${escapeHtml(product.imageAlt||product.name)}"><div class="product-gallery-thumbnails">${[...new Set([product.imageUrl,...(product.gallery||[])])].map((url,i)=>`<button type="button" data-gallery-image="${escapeHtml(url)}" aria-label="Xem ảnh ${i+1}" aria-pressed="${url===product.imageUrl}"><img src="${escapeHtml(url)}" ${window.GAERUProductArtwork?.attributes?.(url,'thumb')||''} alt="" loading="lazy" decoding="async"></button>`).join("")}</div></div>
      <div class="product-detail-copy">
        <h2 class="product-config-heading">Phiên bản. <span>Chọn kết nối phù hợp với bạn.</span></h2>
        ${variantField}<p data-selected-promotion class="store-promotion-note" hidden></p>
        <section class="product-delivery" aria-label="Thông tin giao hàng"><svg viewBox="0 0 32 28" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 3h18v18H2zM20 10h6l4 6v5H20"/><circle cx="8" cy="22" r="3" fill="white"/><circle cx="25" cy="22" r="3" fill="white"/></svg><div><h3>Giao hàng</h3><p class="stock-note" data-stock-note>Vui lòng chọn phiên bản</p><p>Phí vận chuyển tính theo địa chỉ.</p><details data-delivery-details><summary>Nhận thông tin giao hàng ⊕</summary><div data-delivery-content>Đang tải thông tin…</div></details></div></section>
        <div class="detail-actions">
          <button class="button button-blue buy-now-button" type="button" data-buy-now="" disabled>Mua ngay</button>
          <button class="button button-blue" type="button" data-add-to-cart="" disabled>Thêm vào giỏ</button>
        </div>
        <p class="cart-feedback" data-cart-feedback aria-live="polite"></p>
        ${(product.shopeeUrl || product.tiktokShopUrl) ? `
        <div class="product-marketplace-actions" aria-label="Đặt mua qua sàn thương mại điện tử">
          <div class="marketplace-divider"><span>Hoặc đặt mua chính hãng tại</span></div>
          <div class="marketplace-buttons">
            ${product.shopeeUrl ? `<a class="button button-marketplace button-shopee" href="${escapeHtml(normalizeExternalUrl(product.shopeeUrl))}" target="_blank" rel="noopener noreferrer"><svg class="marketplace-icon shopee-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M19.467 7.424A3.01 3.01 0 0 0 16.5 5.002H15V4a3 3 0 0 0-6 0v1.002H7.5a3.01 3.01 0 0 0-2.967 2.422L3.05 18.25A2 2 0 0 0 5.016 20.5h13.968a2 2 0 0 0 1.966-2.25l-1.483-10.826ZM10.5 4a1.5 1.5 0 0 1 3 0v1.002h-3V4Zm-3 3.002h1.5v1.5a.75.75 0 0 0 1.5 0v-1.5h3v1.5a.75.75 0 0 0 1.5 0v-1.5H16.5a1.505 1.505 0 0 1 1.483 1.21l1.322 9.645a.5.5 0 0 1-.492.563H5.187a.5.5 0 0 1-.492-.563l1.322-9.645A1.505 1.505 0 0 1 7.5 7.002Zm5.714 5.344a.75.75 0 0 0-.964.44c-.31.815-.815 1.134-1.41 1.134-.73 0-1.2-.42-1.2-1.04 0-.825.962-1.205 2.1-1.458.12-.027.24-.055.362-.085a.75.75 0 1 0-.36-1.456c-.097.024-.194.047-.291.068-1.57.348-3.31 1.055-3.31 2.931 0 1.58 1.233 2.54 2.7 2.54 1.348 0 2.274-.755 2.813-1.63a.75.75 0 0 0-.44-.944Z"/></svg><span>Mua ở Shopee</span></a>` : ''}
            ${product.tiktokShopUrl ? `<a class="button button-marketplace button-tiktok" href="${escapeHtml(normalizeExternalUrl(product.tiktokShopUrl))}" target="_blank" rel="noopener noreferrer"><svg class="marketplace-icon tiktok-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#25F4EE" d="M19.321 5.562a5.122 5.122 0 0 1-.443-.258 6.228 6.228 0 0 1-1.137-.966c-.349-.387-.714-.852-.892-1.338h-2.147v13.435a2.53 2.53 0 0 1-2.529 2.529 2.53 2.53 0 0 1-2.529-2.529 2.53 2.53 0 0 1 2.529-2.529c.348 0 .678.071.979.198v-3.136a5.67 5.67 0 0 0-.979-.086 5.666 5.666 0 0 0-5.666 5.666 5.666 5.666 0 0 0 5.666 5.666 5.666 5.666 0 0 0 5.666-5.666V8.918a8.963 8.963 0 0 0 5.257 1.677V7.459a5.792 5.792 0 0 1-3.775-1.897z"/><path fill="#FE2C55" d="M20.485 6.687c-.38-.073-.78-.124-1.164-.124a5.79 5.79 0 0 1-3.619-1.258 5.76 5.76 0 0 1-1.428-1.743h-2.147v13.435a2.53 2.53 0 0 1-2.529 2.529 2.53 2.53 0 0 1-2.529-2.529 2.53 2.53 0 0 1 2.529-2.529c.348 0 .678.071.979.198v-3.136a5.67 5.67 0 0 0-.979-.086 5.666 5.666 0 0 0-5.666 5.666 5.666 5.666 0 0 0 5.666 5.666 5.666 5.666 0 0 0 5.666-5.666V8.918a8.963 8.963 0 0 0 5.257 1.677V7.459c-.43 0-.853-.081-1.265-.245a5.77 5.77 0 0 1-2.434-1.527z"/><path fill="#FFFFFF" d="M19.589 6.686a4.793 4.793 0 0 1-3.77-4.245V2h-3.445v13.672a2.896 2.896 0 0 1-5.201 1.743 2.897 2.897 0 0 1 2.317-4.639c.33 0 .647.055.943.157V9.42a6.36 6.36 0 0 0-.943-.073 6.34 6.34 0 0 0-6.34 6.341 6.34 6.34 0 0 0 6.34 6.34 6.341 6.341 0 0 0 6.34-6.34V9.043a8.163 8.163 0 0 0 4.758 1.517V7.114a4.82 4.82 0 0 1-1-.428Z"/></svg><span>Mua ở TikTok Shop</span></a>` : ''}
          </div>
        </div>` : ''}
        <div data-product-bundles-wrap></div>
        <section class="product-save-later"><h3>Vẫn chưa thể quyết định?</h3><p>Lưu sản phẩm để dễ dàng quay lại xem trên trình duyệt này.</p><button type="button" class="save-product-button" data-save-product="${escapeHtml(product.slug)}" aria-pressed="false">Lưu để xem lại sau</button><a href="shop.html?saved=1">Xem sản phẩm đã lưu ↗</a><p role="status" aria-live="polite"></p></section>
        <section class="product-shopping-help"><svg viewBox="0 0 32 30" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 3h20v17H10l-6 6v-6H3zM23 10h6v15h-7l-4 4v-9"/></svg><div><h3>Trợ giúp mua sắm.</h3><p><button type="button" class="chat-product-button" data-product-chat="${escapeHtml(product.slug)}">Chat ngay ↗</button> hoặc gọi <a href="tel:0829191080">082 919 1080</a>.</p><small>AI hỗ trợ trước; chọn Gặp nhân viên khi cần.</small></div></section>
      </div>
    </section>
    <section class="product-information section-wrap" id="product-information"><header><p class="eyebrow">TÌM HIỂU SẢN PHẨM</p><h2>${escapeHtml(product.name)}. <span>Chi tiết cho lựa chọn của bạn.</span></h2></header>${window.GAERUDescription?window.GAERUDescription.render(product):`<p class="detail-description">${escapeHtml(product.description)}</p>`}</section>
    <section class="detail-more"><p class="eyebrow">Khám phá thêm</p><h2>Thiết bị khác. Cùng cảm hứng.</h2><a class="text-link" href="shop.html">Xem toàn bộ cửa hàng <span aria-hidden="true">›</span></a></section>`;

  const selector = root.querySelector("#product-variant");
  const countdown=root.querySelector('[data-selected-countdown]');
  const setCountdown = variant => {
    if (!countdown) return;
    if (variant?.promotion?.type === 'flash') countdown.dataset.saleEnd = new Date(variant.promotion.endsAt).toISOString();
    else if (!variant && hasFlash && initialFlashEnd) countdown.dataset.saleEnd = new Date(initialFlashEnd).toISOString();
    else { delete countdown.dataset.saleEnd; countdown.textContent = ''; }
  };
  setCountdown(selected);
  if (typeof updateSaleCountdowns === 'function') updateSaleCountdowns();
  selector?.addEventListener("change", () => {
    const variant = variants.find((item) => item.id === selector.value);
    if (!variant) return;
    setCountdown(variant);
    if (typeof updateSaleCountdowns === 'function') updateSaleCountdowns();
    const priceNode = root.querySelector("[data-selected-price]");
    if (priceNode) priceNode.textContent = formatPrice(variant.priceVnd);
    const isFlash = variant.promotion?.type === 'flash';
    const hasPromo = Boolean(variant.promotion);
    const flashHeader = root.querySelector("[data-flash-header]");
    const flashTag = root.querySelector("[data-flash-tag]");
    const priceSub = root.querySelector("[data-price-sub]");
    const origPriceNode = root.querySelector("[data-selected-original-price]");
    const discountNode = root.querySelector("[data-selected-discount]");
    const priceBox = root.querySelector("[data-price-box]");
    if (flashHeader) flashHeader.hidden = !isFlash;
    if (flashTag) flashTag.hidden = !isFlash;
    if (priceSub) priceSub.hidden = !hasPromo;
    if (hasPromo && variant.originalPriceVnd) {
      if (origPriceNode) origPriceNode.textContent = formatPrice(variant.originalPriceVnd);
      if (discountNode) {
        if (variant.originalPriceVnd > variant.priceVnd) {
          const pct = Math.round((1 - variant.priceVnd / variant.originalPriceVnd) * 100);
          discountNode.textContent = `-${pct}%`;
          discountNode.hidden = false;
        } else {
          discountNode.hidden = true;
        }
      }
    } else {
      if (discountNode) discountNode.hidden = true;
    }
    if (priceBox?.classList) priceBox.classList.toggle("is-flash", isFlash);
    if (priceNode?.classList) priceNode.classList.toggle("detail-price-flash", isFlash);
    const promoNote = root.querySelector("[data-selected-promotion]");
    if (promoNote) promoNote.innerHTML = variant.promotion ? `<strong class="promotion-badge">${variant.promotion.type==='flash'?'Flash Sale':'Ưu đãi'}</strong> · Giá bán: <span class="promotion-sale-price">${formatPrice(variant.priceVnd)}</span> (Giá gốc: <del>${formatPrice(variant.originalPriceVnd)}</del>) · Kết thúc ${new Date(variant.promotion.endsAt).toLocaleString('vi-VN')}` : '';
    root.querySelector("[data-stock-note]").textContent = Number(variant.stockQuantity) > 0 ? "Còn hàng" : "Hết hàng";
    const button = root.querySelector("[data-add-to-cart]");
    button.dataset.addToCart = variant.id;
    button.disabled = variant.stockQuantity === 0;
    const buyNow=root.querySelector("[data-buy-now]");buyNow.dataset.buyNow=variant.id;buyNow.disabled=variant.stockQuantity===0;
    root.querySelectorAll("[data-option-group]").forEach(b=>b.setAttribute("aria-pressed",String(variant.options?.[b.dataset.optionGroup]===b.dataset.optionValue)));
    root.querySelectorAll("[data-visual-variant]").forEach(b=>b.setAttribute("aria-pressed",String(variant.id===b.dataset.visualVariant)));
    const image=root.querySelector("[data-product-main-image]"),art=window.GAERUProductArtwork?.variantImage?.(product,variant)||{url:variant.imageUrl||product.imageUrl};if(window.GAERUProductArtwork?.updateImage)window.GAERUProductArtwork.updateImage(image,safeProductImage(art.url),{micCount:art.micCount});else image.src=safeProductImage(art.url);image.alt=variant.name+" · "+product.name;root.querySelectorAll("[data-gallery-image]").forEach(b=>b.setAttribute("aria-pressed",String(art.micCount!==1&&b.dataset.galleryImage===art.url))); updateAllBundleCards(variant.id);
  });
  let galleryTouch=null;
  root.addEventListener('touchstart',event=>{galleryTouch=event.touches.length===1&&event.target.closest('[data-product-main-image]')?{x:event.touches[0].clientX,y:event.touches[0].clientY}:null;},{passive:true});
  root.addEventListener('touchcancel',()=>{galleryTouch=null;},{passive:true});
  root.addEventListener('touchend',event=>{const start=galleryTouch;galleryTouch=null;if(!start||event.changedTouches.length!==1)return;const dx=event.changedTouches[0].clientX-start.x,dy=event.changedTouches[0].clientY-start.y;if(Math.abs(dx)<40||Math.abs(dx)<Math.abs(dy)*1.5)return;const buttons=[...root.querySelectorAll('[data-gallery-image]')];if(buttons.length<2)return;const current=buttons.findIndex(b=>b.getAttribute('aria-pressed')==='true');const next=buttons[(Math.max(0,current)+(dx<0?1:-1)+buttons.length)%buttons.length];next.click();const rail=next.parentElement;rail.scrollTo({left:Math.max(0,next.offsetLeft-rail.offsetLeft-(rail.clientWidth-next.offsetWidth)/2),behavior:'smooth'});},{passive:true});
  root.addEventListener("click",e=>{const imageButton=e.target.closest("[data-gallery-image]");if(imageButton){const mainImage=root.querySelector("[data-product-main-image]");if(window.GAERUProductArtwork?.updateImage)window.GAERUProductArtwork.updateImage(mainImage,safeProductImage(imageButton.dataset.galleryImage));else mainImage.src=safeProductImage(imageButton.dataset.galleryImage);root.querySelectorAll("[data-gallery-image]").forEach(b=>b.setAttribute("aria-pressed",String(b===imageButton)));return;}const option=e.target.closest("[data-option-group]"),direct=e.target.closest("[data-visual-variant]");if(!option&&!direct)return;const current=variants.find(v=>v.id===selector.value);const next=direct?variants.find(v=>v.id===direct.dataset.visualVariant):window.GAERUVariantChoices.choose(variants,current,option.dataset.optionGroup,option.dataset.optionValue);if(next){selector.value=next.id;selector.dispatchEvent(new Event("change"));}}); window.GAERUK9Loop?.mountHome(); void loadAndRenderBundles(product, selector?.value);
  try {
    const curVariant = variants.find(v => v.id === selector?.value) || variants[0];
    window.GAERUAnalytics?.trackViewItem?.(product, curVariant);
  } catch (_) {}
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
          <a class="cart-item-image" href="product.html?id=${encodeURIComponent(product.slug)}"><img src="${escapeHtml(product.imageUrl)}" ${window.GAERUProductArtwork?.attributes?.(product.imageUrl,'thumb')||''} alt="${escapeHtml(product.imageAlt)}" loading="lazy" decoding="async"></a>
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

async function ensureCheckoutDependencies() {
  if (typeof document === "undefined" || !document.head) return;
  const ensureCss = (href) => {
    if (document.querySelector(`link[href^="${href.split("?")[0]}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
  };
  const ensureJs = (src, check) => {
    if (check()) return Promise.resolve();
    return new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = src;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => resolve();
      document.head.append(s);
    });
  };
  if (typeof window !== "undefined" && !window.GAERUCheckout && typeof navigator !== "undefined") {
    await ensureJs("/checkout-flow.js?v=20261026-ward-picker", () => Boolean(window.GAERUCheckout));
  }
  if (typeof window !== "undefined" && !window.GAERUAddress && typeof navigator !== "undefined") {
    ensureCss("/vietnam-address.css?v=20261026-unified-ui");
    await ensureJs("/vietnam-address.js?v=20261026-unified-ui", () => Boolean(window.GAERUAddress));
  }
}

async function renderCheckout() {
  const root = document.querySelector("#checkout-content");
  if (!root) return;
  await ensureCheckoutDependencies();

  const urlParams = typeof window !== "undefined" && window.location ? new URLSearchParams(window.location.search) : null;
  const recoveryToken = urlParams ? urlParams.get("recovery_token") : null;
  let recoveredCart = null;
  if (recoveryToken) {
    try {
      const resp = await apiRequest(`/api/abandoned-cart/recover/${encodeURIComponent(recoveryToken)}`);
      if (resp?.cart) {
        recoveredCart = resp.cart;
        if (Array.isArray(resp.cart.items) && resp.cart.items.length > 0) {
          const currentCart = readCart();
          if (!currentCart.length) {
            writeCart(resp.cart.items.map(it => ({ variantId: it.variantId, quantity: it.quantity })));
          }
        }
      }
    } catch (e) {
      console.warn("Khôi phục giỏ hàng qua recovery_token thất bại:", e);
    }
  }

  const purchase=window.GAERUCheckout.selection(products,location.search);
  const rows = cartRows(purchase.direct?purchase.items:readCart());
  if (!rows.length) {
    root.innerHTML = `<div class="empty-cart"><h2>${purchase.direct?"Phiên bản này hiện không còn hàng hoặc không còn được bán.":"Chưa có sản phẩm để đặt hàng."}</h2><a class="button button-blue" href="shop.html">Quay lại cửa hàng</a></div>`;
    return;
  }
  const total = rows.reduce((sum, item) => sum + item.variant.priceVnd * item.quantity, 0);
  try {
    window.GAERUAnalytics?.trackBeginCheckout?.(
      rows.map(r => ({
        variantId: r.variant.id,
        sku: r.variant.sku,
        name: `${r.product.name} - ${r.variant.name}`,
        category: r.product.category,
        priceVnd: r.variant.priceVnd,
        quantity: r.quantity
      })),
      total
    );
  } catch (_) {}
  let settingsError = "";
  try {
    storeSettings = await apiRequest("/api/settings/public");
  } catch (error) {
    settingsError = error.message;
  }
  const shippingRates = storeSettings.shippingRates || {};
  const isNationwide = name => Boolean(name && (window.GAERUCheckout?.cityKey ? window.GAERUCheckout.cityKey(name) === 'toan quoc' : /toàn\s*quốc/i.test(name)));
  const hasNationwide = Object.keys(shippingRates).some(isNationwide);
  let provinces = Object.keys(shippingRates).filter(p => !isNationwide(p)).sort((left, right) => left.localeCompare(right, "vi"));
  if (hasNationwide && !provinces.length) {
    provinces = ['Hà Nội','Hải Phòng','Huế','Đà Nẵng','Hồ Chí Minh','Cần Thơ','An Giang','Bắc Ninh','Cà Mau','Cao Bằng','Đắk Lắk','Điện Biên','Đồng Nai','Đồng Tháp','Gia Lai','Hà Tĩnh','Hưng Yên','Khánh Hòa','Lai Châu','Lâm Đồng','Lạng Sơn','Lào Cai','Nghệ An','Ninh Bình','Phú Thọ','Quảng Ngãi','Quảng Ninh','Quảng Trị','Sơn La','Tây Ninh','Thái Nguyên','Thanh Hóa','Tuyên Quang','Vĩnh Long'].sort((a,b)=>a.localeCompare(b,'vi'));
  }
  const paymentMethods = storeSettings.paymentMethods || ["cod"];
  const shippingCarriers=storeSettings.shippingCarriers||[];
  if (settingsError || !storeSettings.ordersEnabled || (!provinces.length && !hasNationwide)) {
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
    ${recoveredCart ? '<div class="checkout-recovered-banner" role="status" style="background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;padding:12px 16px;border-radius:10px;margin-bottom:18px;font-size:13.5px;display:flex;align-items:center;gap:10px;"><span style="font-size:18px;font-weight:bold;">✓</span><span><strong>Giỏ hàng của bạn đã được khôi phục thành công!</strong> GAERU đã tải lại sản phẩm và thông tin của bạn.</span></div>' : ''}
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
          <label>Tỉnh / thành phố<input name="city" autocomplete="address-level1" required maxlength="120" list="checkout-cities" placeholder="Nhập tỉnh/thành phố"><datalist id="checkout-cities">${provinces.filter(p=>!isNationwide(p)).map(p=>`<option value="${escapeHtml(p)}"></option>`).join('')}</datalist></label>
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
      <p class="checkout-product"><span>Giao hàng</span><strong data-checkout-shipping>Chưa tính phí</strong></p>
      <section class="checkout-voucher"><label class="visually-hidden" for="checkout-voucher-code">Mã voucher</label><input id="checkout-voucher-code" maxlength="40" placeholder="Nhập mã voucher" autocomplete="off"><button class="secondary-button" type="button" data-voucher-apply aria-label="Kiểm tra voucher" title="Kiểm tra voucher">✓</button><button class="secondary-button" type="button" data-voucher-wallet>Ví mã ↗</button><p role="status" data-voucher-feedback></p></section><p class="checkout-product checkout-discount"><span>Giảm giá voucher</span><strong data-checkout-discount>0 ₫</strong></p>
      <section class="checkout-loyalty" data-checkout-loyalty hidden><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px dashed #d2d2d7;margin-top:8px;"><label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;"><input type="checkbox" id="checkout-use-loyalty"><span>Dùng <strong data-loyalty-available>0</strong> GAERU Xu</span></label><span style="font-size:12px;color:#15803d;font-weight:600;" data-loyalty-discount-text>−0 ₫</span></div></section>
      <p class="summary-total"><span>Tổng cộng</span><strong data-checkout-total>${formatPrice(total)} + phí giao hàng</strong></p>
      <p class="prototype-note">${escapeHtml(storeSettings.shippingNote || "Phí giao hàng được tính theo tỉnh/thành phố đã chọn.")}</p>
    </aside><div class="form-section">
        <h2>Phương thức thanh toán</h2>
        <label>
          <select name="paymentMethod" aria-label="Phương thức thanh toán">
            ${paymentMethods.includes("cod") ? '<option value="cod">Thanh toán khi nhận hàng (COD)</option>' : ""}
            ${paymentMethods.includes("bank_transfer") ? '<option value="bank_transfer">Chuyển khoản ngân hàng</option>' : ""}
            ${paymentMethods.includes("vnpay") ? '<option value="vnpay">Thanh toán trực tuyến qua VNPAY</option>' : ""}
            ${paymentMethods.includes("momo") ? '<option value="momo">Ví điện tử MoMo</option>' : ""}
            ${paymentMethods.includes("zalopay") ? '<option value="zalopay">Ví điện tử ZaloPay</option>' : ""}

          </select>
        </label>
        <p class="payment-placeholder" data-payment-help>GAERU sẽ xác nhận đơn hàng trước khi gửi.</p>
      </div>
      <p class="checkout-account-notice">Khi đặt hàng, GAERU tạo tài khoản theo email nếu bạn chưa có tài khoản và gửi hướng dẫn đặt mật khẩu. Bạn không tự động đăng ký nhận tin quảng cáo.</p><p class="checkout-privacy-notice">Thông tin bạn cung cấp được sử dụng để tiếp nhận và xử lý đơn hàng theo <a href="privacy.html">Chính sách quyền riêng tư</a>. <a href="terms.html">Điều khoản mua hàng</a>.</p>
      <label class="checkout-recovery-consent"><input type="checkbox" name="recoveryConsent" id="checkout-recovery-consent" checked><span>Lưu liên hệ và giỏ hàng để nhận nhắc nhở nếu chưa hoàn tất thanh toán.</span></label>
      <button class="button button-blue" type="submit">Đặt hàng</button>
      <p class="checkout-feedback" id="checkout-feedback" aria-live="polite"></p>
    </form>
`;

  window.GAERUAddress?.enhance(root);
  const form = root.querySelector("#checkout-form");
  if (recoveredCart) {
    if (recoveredCart.customerName && form.elements.name && !form.elements.name.value) {
      form.elements.name.value = recoveredCart.customerName;
    }
    if (recoveredCart.email && form.elements.email && !form.elements.email.value) {
      form.elements.email.value = recoveredCart.email;
    }
    if (recoveredCart.phone && form.elements.phone && !form.elements.phone.value) {
      form.elements.phone.value = recoveredCart.phone;
    }
  }

  let captureDebounceTimer = null;
  const triggerAbandonedCartCapture = () => {
    clearTimeout(captureDebounceTimer);
    captureDebounceTimer = setTimeout(async () => {
      const email = form.elements.email?.value?.trim();
      const phone = form.elements.phone?.value?.trim();
      const name = form.elements.name?.value?.trim();
      const consent = form.elements.recoveryConsent ? form.elements.recoveryConsent.checked : true;
      if (!email || !/.+@.+\..+/.test(email)) return;
      const checkoutItems = rows.map(({ variantId, quantity }) => ({ variantId, quantity }));
      if (!checkoutItems.length) return;

      try {
        await apiRequest("/api/abandoned-cart/capture", {
          method: "POST",
          body: JSON.stringify({
            email,
            customerName: name || undefined,
            phone: phone || undefined,
            items: checkoutItems,
            recoveryConsent: consent
          })
        });
      } catch (_) {
        // Non-blocking background capture
      }
    }, 1000);
  };

  form.elements.email?.addEventListener("blur", triggerAbandonedCartCapture);
  form.elements.email?.addEventListener("change", triggerAbandonedCartCapture);
  form.elements.phone?.addEventListener("blur", triggerAbandonedCartCapture);
  form.elements.name?.addEventListener("blur", triggerAbandonedCartCapture);
  form.elements.recoveryConsent?.addEventListener("change", triggerAbandonedCartCapture);
  const paymentMethod = form.elements.paymentMethod;
  const paymentHelp = form.querySelector("[data-payment-help]");
  let voucherDiscount=0,appliedVoucher="";
  const updateShippingTotal = () => {
    const fee = window.GAERUCheckout.shippingFee(shippingRates,form.elements.city.value);
    root.querySelector("[data-checkout-shipping]").textContent =
      fee === undefined ? "Chưa tính phí" : formatPrice(fee);
    root.querySelector("[data-checkout-total]").textContent =
      fee === undefined ? formatPrice(Math.max(0,total-voucherDiscount-(loyaltyDiscount||0)))+" + phí giao hàng" : formatPrice(Math.max(0, total + fee - voucherDiscount - (loyaltyDiscount || 0)));
  };
  const voucherInput=root.querySelector('#checkout-voucher-code'),voucherFeedback=root.querySelector('[data-voucher-feedback]');
  const resetVoucher=()=>{voucherDiscount=0;appliedVoucher='';root.querySelector('[data-checkout-discount]').textContent=formatPrice(0);updateShippingTotal();};
  let voucherRevision=0,voucherTimer;
  const validateVoucher=async()=>{const revision=++voucherRevision,code=voucherInput.value.trim().toUpperCase();if(!code)return false;try{const quote=await apiRequest('/api/customer/marketing/quote',{method:'POST',body:JSON.stringify({code,items:rows.map(({variantId,quantity})=>({variantId,quantity}))})});if(revision!==voucherRevision||voucherInput.value.trim().toUpperCase()!==code)return false;if(quote.subtotalVnd!==total)throw Error('Giá đã thay đổi. Tải lại trang trước khi áp dụng.');appliedVoucher=quote.code;voucherDiscount=quote.discountVnd;root.querySelector('[data-checkout-discount]').textContent='−'+formatPrice(voucherDiscount);voucherFeedback.textContent=quote.message;if(window.GAERUNotify?.toast)window.GAERUNotify.toast(quote.message,'success');updateShippingTotal();return true;}catch(error){if(revision===voucherRevision){resetVoucher();voucherFeedback.textContent=error.message;if(window.GAERUNotify?.toast)window.GAERUNotify.toast(error.message,'error');}return false;}};
  voucherInput.addEventListener('input',()=>{voucherRevision++;clearTimeout(voucherTimer);resetVoucher();voucherFeedback.textContent='';if(voucherInput.value.trim())voucherTimer=setTimeout(()=>validateVoucher(),650);});
  voucherInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();clearTimeout(voucherTimer);void validateVoucher();}});
  root.querySelector('[data-voucher-wallet]').addEventListener('click',event=>{window.GAERUVoucherWallet?.open({request:apiRequest,total,opener:event.currentTarget,onSelect:async code=>{voucherRevision++;clearTimeout(voucherTimer);voucherInput.value=code;resetVoucher();voucherFeedback.textContent='';if(!code)return {ok:true};const ok=await validateVoucher();return {ok,message:voucherFeedback.textContent};}});});
  root.querySelector('[data-voucher-apply]').addEventListener('click',()=>{clearTimeout(voucherTimer);void validateVoucher();});
  let loyaltyPoints = 0, loyaltyDiscount = 0;
  const loyaltySection = root.querySelector("[data-checkout-loyalty]");
  const loyaltyCheckbox = root.querySelector("#checkout-use-loyalty");
  const loyaltyAvailable = root.querySelector("[data-loyalty-available]");
  const loyaltyText = root.querySelector("[data-loyalty-discount-text]");
  if (window.GAERUCustomerSession?.customer) {
    apiRequest("/api/customer/loyalty").then(data => {
      if (data?.loyalty?.pointsBalance > 0) {
        loyaltyPoints = data.loyalty.pointsBalance;
        if (loyaltySection) loyaltySection.hidden = false;
        if (loyaltyAvailable) loyaltyAvailable.textContent = new Intl.NumberFormat('vi-VN').format(loyaltyPoints);
      }
    }).catch(() => {});
  }
  const updateLoyaltyDiscount = () => {
    if (loyaltyCheckbox?.checked && loyaltyPoints > 0) {
      const maxAllowed = Math.floor(total * 0.5);
      loyaltyDiscount = Math.min(loyaltyPoints, maxAllowed);
      if (loyaltyText) loyaltyText.textContent = "−" + formatPrice(loyaltyDiscount);
    } else {
      loyaltyDiscount = 0;
      if (loyaltyText) loyaltyText.textContent = "−0 ₫";
    }
  };
  if (loyaltyCheckbox) {
    loyaltyCheckbox.addEventListener("change", () => {
      updateLoyaltyDiscount();
      updateShippingTotal();
    });
  }
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
          loyaltyPointsToRedeem: (loyaltyCheckbox?.checked && loyaltyDiscount > 0) ? loyaltyDiscount : undefined,
          paymentMethod: paymentMethod.value,
          expectedSubtotalVnd:total,
          items: rows.map(({ variantId, quantity }) => ({ variantId, quantity }))
        })
      });
      try {
        if (result?.order) {
          window.GAERUAnalytics?.trackPurchase?.({
            orderNumber: result.order.orderNumber,
            totalVnd: result.order.totalVnd,
            shippingFeeVnd: result.order.shippingFeeVnd,
            items: rows.map(r => ({
              variantId: r.variant.id,
              sku: r.variant.sku,
              name: `${r.product.name} - ${r.variant.name}`,
              category: r.product.category,
              priceVnd: r.variant.priceVnd,
              quantity: r.quantity
            }))
          });
        }
      } catch (_) {}
      if(!purchase.direct)writeCart([]);
      if (result.paymentUrl) {
        location.assign(result.paymentUrl);
        return;
      }
      const bt = result.bankTransfer;
      root.innerHTML = `<div class="order-success" role="status"><p class="eyebrow">Đã tiếp nhận đơn</p><h2>Mã đơn ${escapeHtml(result.order.orderNumber)}</h2><p>${escapeHtml(result.message)}</p><p>Thông tin đơn hàng và hướng dẫn tài khoản, nếu cần, sẽ được gửi tới email bạn đã nhập. Nếu chưa thấy thư, kiểm tra thư rác hoặc liên hệ GAERU.</p><p>Tạm tính ${formatPrice(result.order.subtotalVnd)} ${result.order.discountVnd?`· Giảm giá −${formatPrice(result.order.discountVnd)}`:""} · Giao hàng ${formatPrice(result.order.shippingFeeVnd)} · Tổng cộng ${formatPrice(result.order.totalVnd)}</p>${result.order.shippingCarrierName?`<p>Đơn vị vận chuyển: <strong>${escapeHtml(result.order.shippingCarrierName)}</strong></p>`:""}${bt?`<div class="checkout-notice bank-transfer-notice"><strong>Thông tin chuyển khoản ngân hàng</strong>${bt.qrUrl?`<div class="vietqr-box" style="text-align:center;margin:12px 0;"><img src="${escapeHtml(bt.qrUrl)}" alt="Mã VietQR" style="max-width:240px;width:100%;height:auto;border-radius:8px;border:1px solid #e5e7eb;box-shadow:0 2px 8px rgba(0,0,0,0.06);" loading="lazy"><p style="font-size:12px;color:#6b7280;margin:6px 0 0;">Quét mã VietQR bằng app ngân hàng bất kỳ để tự động khớp thông tin &amp; số tiền.</p></div>`:''}<p>Ngân hàng: <strong>${escapeHtml(bt.bankName)}</strong>${bt.branch?` (${escapeHtml(bt.branch)})`:""}<br>Số tài khoản: <strong>${escapeHtml(bt.accountNumber)}</strong><br>Chủ tài khoản: <strong>${escapeHtml(bt.accountHolder)}</strong><br>Số tiền: <strong>${formatPrice(bt.amountVnd ?? result.order.totalVnd)}</strong><br>Nội dung chuyển khoản: <strong>${escapeHtml(bt.transferContent)}</strong></p><p data-prepaid-live-status>Hệ thống đang tự động kiểm tra và so khớp giao dịch của bạn…</p></div>`:`<p>Đơn COD sẽ được GAERU xác nhận và thu tiền khi giao hàng.</p>`}<a class="button button-blue" href="shop.html">Tiếp tục khám phá</a></div>`;
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
  let pointerStartX = 0, pointerStartY = 0;
  document.addEventListener("pointerdown", (e) => {
    pointerStartX = e.clientX;
    pointerStartY = e.clientY;
  }, { passive: true });

  document.addEventListener("click", (event) => {
    const buyNow=event.target.closest('[data-buy-now]');
    if(buyNow){if(buyNow.disabled)return;const row=cartRows([{variantId:buyNow.dataset.buyNow,quantity:1}])[0];if(row?.variant.active&&row.variant.stockQuantity>0){location.assign('/thanh-toan?variant='+encodeURIComponent(row.variant.id));}return;}
    const choose=event.target.closest('[data-choose-cart]');
    if(choose){if(choose.disabled)return;const product=products.find(p=>p.slug===choose.dataset.chooseCart);if(!product)return;let dialog=document.querySelector('#quick-cart-dialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='quick-cart-dialog';dialog.className='quick-cart-dialog';document.body.append(dialog);}dialog.innerHTML=`<header><h2>Thêm ${escapeHtml(product.name)} vào giỏ</h2><button type="button" data-close-quick-cart aria-label="Đóng">×</button></header><label>Chọn phiên bản<select data-quick-variant><option value="">Chọn phiên bản phù hợp</option>${product.variants.filter(v=>v.active).map(v=>`<option value="${escapeHtml(v.id)}" ${v.stockQuantity>0?'':'disabled'}>${escapeHtml(v.name)} · ${formatPrice(v.priceVnd)}${v.stockQuantity>0?'':' · Hết hàng'}</option>`).join('')}</select></label><button type="button" class="button button-blue" data-add-to-cart="" disabled>Thêm vào giỏ hàng</button><p data-cart-feedback role="status"></p>`;dialog.querySelector('[data-close-quick-cart]').onclick=()=>dialog.close();const picker=dialog.querySelector('[data-quick-variant]'),button=dialog.querySelector('[data-add-to-cart]');picker.onchange=()=>{button.dataset.addToCart=picker.value;button.disabled=!picker.value;};dialog.showModal();return;}
    const bundleBtn = event.target.closest("[data-add-bundle]");
    if (bundleBtn) {
      const bundleId = bundleBtn.dataset.addBundle;
      const bundleCard = bundleBtn.closest("[data-bundle-id]");
      const bundle = (window.__currentBundles || []).find(b => b.id === bundleId);
      if (bundle) {
        const currentSelector = document.querySelector("#product-variant");
        const primaryVariantId = currentSelector?.value || bundle.primaryItems?.[0]?.variantId;
        const checkedAccessories = [...(bundleCard?.querySelectorAll("[data-bundle-accessory]:checked") || [])].map(cb => cb.dataset.bundleAccessory);
        const allToAdd = [primaryVariantId, ...checkedAccessories].filter(Boolean);
        const cart = readCart();
        for (const vId of allToAdd) {
          const existing = cart.find(i => i.variantId === vId);
          if (existing) existing.quantity += 1;
          else cart.push({ variantId: vId, quantity: 1 });
        }
        if (writeCart(cart)) {
          const fb = bundleCard?.querySelector(`[data-bundle-feedback="${bundleId}"]`);
          if (fb) fb.textContent = `Đã thêm combo ${bundle.title} vào giỏ hàng!`;
          document.dispatchEvent(new CustomEvent("gaeru:open-cart"));
        }
      }
      return;
    }
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
      try {
        window.GAERUAnalytics?.trackAddToCart?.({
          variantId: selected.variant.id,
          sku: selected.variant.sku,
          name: `${selected.product.name} - ${selected.variant.name}`,
          category: selected.product.category,
          priceVnd: selected.variant.priceVnd,
          quantity: 1
        });
      } catch (_) {}
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
      const currentCart = readCart();
      const removedItem = currentCart.find((item) => item.variantId === variantId);
      if (removedItem) {
        const row = cartRows([removedItem])[0];
        if (row) {
          try {
            window.GAERUAnalytics?.trackRemoveFromCart?.({
              variantId: row.variant.id,
              sku: row.variant.sku,
              name: `${row.product.name} - ${row.variant.name}`,
              category: row.product.category,
              priceVnd: row.variant.priceVnd,
              quantity: removedItem.quantity
            });
          } catch (_) {}
        }
      }
      const cart = currentCart.filter((item) => item.variantId !== variantId);
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
      return;
    }

    const card = event.target.closest(".product-card, .catalog-card");
    if (card) {
      if (event.target.closest(".card-actions, button, a, input, select, textarea, label, dialog")) return;
      if (typeof event.clientX === "number" && typeof event.clientY === "number" && (pointerStartX || pointerStartY)) {
        const dist = Math.hypot(event.clientX - pointerStartX, event.clientY - pointerStartY);
        if (dist > 12) return;
      }
      const targetUrl = card.dataset.href || card.querySelector('a.button-outline, a.button-blue, a[href*="/san-pham/"], a[href*="product.html?id="]')?.getAttribute("href");
      if (targetUrl) {
        if (event.button === 1 || event.ctrlKey || event.metaKey) {
          window.open(targetUrl, "_blank", "noopener,noreferrer");
        } else if (event.button === 0 || event.button === undefined) {
          location.assign(targetUrl);
        }
      }
      return;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(".product-card[data-href], .catalog-card[data-href]");
    if (!card || event.target.closest("button, a, input, select, textarea")) return;
    if (event.target === card) {
      if (event.key === " ") event.preventDefault();
      const targetUrl = card.dataset.href;
      if (targetUrl) {
        if (event.ctrlKey || event.metaKey) {
          window.open(targetUrl, "_blank", "noopener,noreferrer");
        } else {
          location.assign(targetUrl);
        }
      }
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
    const response = embedded ? JSON.parse(embedded.textContent) : await (typeof window === "object" && window ? (window.__gaeruProductsPromise ||= apiRequest("/api/products").catch((err) => { delete window.__gaeruProductsPromise; throw err; })) : apiRequest("/api/products"));
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
    if (typeof window !== "undefined" && window.GAERUCustomerSession?.customer) { void mergeCartWithServer(); }
    renderMiniCart();
  } catch (error) {
    showStoreError(error);
    document.dispatchEvent(new CustomEvent("gaeru:products-load-error"));
  }
}

window.GAERUStore = Object.freeze({
  get products() { return products; },
  formatPrice,
  searchProducts,
  mergeCartWithServer,
  syncCartToServer
});
window.GAERUBundles = Object.freeze({
  loadAndRenderBundles,
  renderBundlesHtml,
  updateBundleCardPricing,
  updateAllBundleCards
});
document.addEventListener("change", (e) => {
  const cb = e.target.closest("[data-bundle-accessory]");
  if (cb) {
    const card = cb.closest("[data-bundle-id]");
    const bundle = (window.__currentBundles || []).find(b => b.id === card?.dataset.bundleId);
    if (bundle && card) updateBundleCardPricing(card, bundle);
  }
});
document.addEventListener("gaeru:cart-updated", () => { updateCartBadge(); renderMiniCart(); renderCart(); });
document.addEventListener("gaeru:cart-panel-open", renderMiniCart);
document.addEventListener("gaeru:customer-updated", () => {
  if (typeof window !== "undefined" && window.GAERUCustomerSession?.customer) {
    void mergeCartWithServer();
  }
});
window.addEventListener("storage", (event) => {
  if (event.key !== null && event.key !== cartStorageKey) return;
  updateCartBadge();
  renderMiniCart();
  renderCart();
});
bindGlobalControls();
initializeStore();
