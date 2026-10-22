const supportSearch = document.querySelector("[data-support-search]");
const supportSearchInput = document.querySelector("#support-search-input");
const supportSearchStatus = document.querySelector("[data-support-search-status]");
let searchableSupportItems = [...document.querySelectorAll("[data-support-searchable]")];
const supportProducts = document.querySelector(".support-products");
const supportProductsStatus = document.querySelector("[data-support-products-status]");

function normalizeSupportText(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("vi")
    .trim();
}

function filterSupportTopics() {
  const query = normalizeSupportText(supportSearchInput.value);
  const terms = query.split(/\s+/).filter(Boolean);
  let visibleCount = 0;
  searchableSupportItems = [...document.querySelectorAll("[data-support-searchable]")];

  for (const item of searchableSupportItems) {
    const searchableText = normalizeSupportText(`${item.textContent} ${item.dataset.supportTerms || ""}`);
    const matches = terms.every((term) => searchableText.includes(term));
    item.hidden = !matches;
    if (matches) visibleCount += 1;
  }

  if (!terms.length) {
    supportSearchStatus.textContent = "";
  } else if (visibleCount) {
    supportSearchStatus.textContent = `Tìm thấy ${visibleCount} chủ đề hỗ trợ.`;
  } else {
    supportSearchStatus.textContent = "Chưa tìm thấy chủ đề phù hợp. Hãy thử từ khóa khác hoặc liên hệ GAERU.";
  }
}

function renderSupportProducts() {
  const products = window.GAERUStore?.products || [];
  if (!products.length) {
    supportProductsStatus.textContent = "Chưa có sản phẩm đang bán. Hãy xem lại sau hoặc liên hệ GAERU.";
    return;
  }

  supportProducts.innerHTML = `<h2 class="visually-hidden">Sản phẩm GAERU đang bán</h2>${products.map((product) => `
    <a class="support-product" href="product-support.html?id=${encodeURIComponent(product.slug)}" data-support-searchable data-support-terms="${escapeHtml(`${product.category} ${product.descriptor}`)}">
      <span class="support-product-image"><img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.imageAlt || product.name)}" loading="lazy"></span>
      <span class="support-product-name">${escapeHtml(product.name)}</span>
      <span class="support-product-link">Tìm hiểu thêm <span aria-hidden="true">›</span></span>
    </a>
  `).join("")}`;
  filterSupportTopics();
}

supportSearchInput?.addEventListener("input", filterSupportTopics);
supportSearch?.addEventListener("submit", (event) => event.preventDefault());
supportSearch?.addEventListener("reset", () => {
  requestAnimationFrame(filterSupportTopics);
});
document.addEventListener("gaeru:products-loaded", renderSupportProducts);
document.addEventListener("gaeru:products-load-error", () => {
  supportProductsStatus.textContent = "Không thể tải sản phẩm lúc này. Vui lòng tải lại trang hoặc liên hệ GAERU.";
});
if (window.GAERUStore?.products.length) renderSupportProducts();
