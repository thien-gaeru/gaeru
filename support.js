const escapeHtml = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  const query = normalizeSupportText(supportSearchInput?.value || "");
  const terms = query.split(/\s+/).filter(Boolean);
  let visibleCount = 0;
  searchableSupportItems = [...document.querySelectorAll("[data-support-searchable]")];

  for (const item of searchableSupportItems) {
    const searchableText = normalizeSupportText(`${item.textContent} ${item.dataset.supportTerms || ""}`);
    const matches = terms.every((term) => searchableText.includes(term));
    item.hidden = !matches;
    if (matches) visibleCount += 1;
  }

  if (!supportSearchStatus) return;
  if (!terms.length) {
    supportSearchStatus.textContent = "";
  } else if (visibleCount) {
    supportSearchStatus.textContent = `Tìm thấy ${visibleCount} chủ đề hỗ trợ.`;
  } else {
    supportSearchStatus.textContent = "Chưa tìm thấy chủ đề phù hợp. Hãy thử từ khóa khác hoặc liên hệ GAERU.";
  }
}

function renderSupportProducts(customProducts) {
  const products = (Array.isArray(customProducts) && customProducts.length) ? customProducts : (window.GAERUStore?.products || []);
  if (!products.length) {
    if (supportProductsStatus) {
      supportProductsStatus.textContent = "Chưa có sản phẩm đang bán. Hãy xem lại sau hoặc liên hệ GAERU.";
    }
    return;
  }

  if (supportProducts) {
    supportProducts.innerHTML = `<h2 class="visually-hidden">Sản phẩm GAERU đang bán</h2>${products.map((product) => `
      <a class="support-product" href="/huong-dan/${encodeURIComponent(product.slug)}" data-support-searchable data-support-terms="${escapeHtml(`${product.category || ''} ${product.descriptor || ''}`)}">
        <span class="support-product-image"><img src="${escapeHtml(window.GAERUProductArtwork?.image(product) || product.imageUrl)}" alt="${escapeHtml(product.imageAlt || product.name)}" loading="lazy"></span>
        <span class="support-product-name">${escapeHtml(product.name)}</span>
        <span class="support-product-link">Hướng dẫn sử dụng <span aria-hidden="true">›</span></span>
      </a>
    `).join("")}`;
  }
  filterSupportTopics();
}

async function initSupportProducts() {
  // 1. Nếu đã có sản phẩm rendered từ SSR trong HTML
  if (supportProducts && supportProducts.querySelectorAll('.support-product').length > 0) {
    filterSupportTopics();
    return;
  }

  // 2. Kiểm tra thẻ bootstrap JSON
  const embedded = document.querySelector('#store-bootstrap');
  if (embedded) {
    try {
      const data = JSON.parse(embedded.textContent);
      if (data?.products?.length) {
        renderSupportProducts(data.products);
        return;
      }
    } catch (_) {}
  }

  // 3. Kiểm tra window.GAERUStore
  if (window.GAERUStore?.products?.length) {
    renderSupportProducts(window.GAERUStore.products);
    return;
  }

  // 4. Tự chủ fetch ngầm fallback
  try {
    const promise = (typeof window === "object" && window)
      ? (window.__gaeruProductsPromise ||= fetch('/api/products', { cache: 'no-store' }).then(r => {
          if (!r.ok) throw new Error('Catalog unavailable');
          return r.json();
        }).catch(err => {
          delete window.__gaeruProductsPromise;
          throw err;
        }))
      : fetch('/api/products').then(r => r.json());

    const data = await promise;
    if (data?.products?.length) {
      renderSupportProducts(data.products);
    } else if (supportProductsStatus) {
      supportProductsStatus.textContent = "Chưa có sản phẩm đang bán. Hãy xem lại sau hoặc liên hệ GAERU.";
    }
  } catch (_) {
    if (supportProductsStatus && !supportProducts?.querySelectorAll('.support-product').length) {
      supportProductsStatus.textContent = "Không thể tải sản phẩm lúc này. Vui lòng tải lại trang hoặc liên hệ GAERU.";
    }
  }
}

supportSearchInput?.addEventListener("input", filterSupportTopics);
supportSearch?.addEventListener("submit", (event) => event.preventDefault());
supportSearch?.addEventListener("reset", () => {
  requestAnimationFrame(filterSupportTopics);
});
document.addEventListener("gaeru:products-loaded", () => {
  if (window.GAERUStore?.products?.length) {
    renderSupportProducts(window.GAERUStore.products);
  }
});
document.addEventListener("gaeru:products-load-error", () => {
  if (!supportProducts?.querySelectorAll('.support-product').length && supportProductsStatus) {
    supportProductsStatus.textContent = "Không thể tải sản phẩm lúc này. Vui lòng tải lại trang hoặc liên hệ GAERU.";
  }
});

initSupportProducts();
