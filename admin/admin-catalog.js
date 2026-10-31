// admin/admin-catalog.js — Quản lý danh mục sản phẩm, thùng rác, biến thể và hiển thị cửa hàng

function showProductAddedPopup(message = "Đã thêm sản phẩm mới thành công") {
  let popup = document.querySelector("#product-added-popup");
  if (!popup) {
    popup = document.createElement("div");
    popup.id = "product-added-popup";
    popup.className = "product-success-popup-backdrop";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-modal", "true");
    popup.innerHTML =
      '<div class="product-success-popup-card">' +
      '<div class="product-success-icon-wrap"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg></div>' +
      "<h2>" + escapeHtml(message) + "</h2>" +
      '<p class="product-success-sub">Sản phẩm đã được lưu và cập nhật vào danh sách quản lý sản phẩm.</p>' +
      '<div class="product-success-actions"><button type="button" class="primary-button product-success-btn" data-close-product-popup>Đóng thông báo</button></div>' +
      "</div>";
    popup.addEventListener("click", (e) => {
      if (e.target.closest("[data-close-product-popup]") || e.target === popup) {
        popup.remove();
      }
    });
    const container = document.body || document.querySelector("body") || document.documentElement || document;
    if (container && typeof container.appendChild === "function") container.appendChild(popup);
  } else {
    popup.hidden = false;
    const h2 = popup.querySelector("h2");
    if (h2) h2.textContent = message;
  }
  setTimeout(() => {
    try { popup?.remove(); } catch (_) {}
  }, 4000);
}

function checkProductAddedNotice() {
  try {
    const notice = sessionStorage.getItem("gaeru:product-added-notice");
    if (notice) {
      sessionStorage.removeItem("gaeru:product-added-notice");
      showProductAddedPopup(notice);
      showGlobal(notice);
    }
  } catch (_) {}
}

async function loadProducts(search = "") {
  if (!can("catalog.read")) return;
  const requestId = ++state.productRequest;
  const root = document.querySelector("#product-list");
  root.setAttribute("aria-busy", "true");
  document.querySelector("#product-list-status").textContent = "Đang tải sản phẩm…";
  try {
    const result = await request(`/api/gaeru_ceo/products?scope=${state.productScope}${search ? `&q=${encodeURIComponent(search)}` : ""}`);
    if (requestId !== state.productRequest || search !== document.querySelector("#product-search").value.trim()) return;
    state.products = result.products;
    renderProducts();
  } catch (error) {
    if (requestId === state.productRequest) {
      document.querySelector("#product-list-status").textContent = "Chưa tải được danh mục. Hãy thử tìm lại hoặc mở lại mục Sản phẩm & kho.";
    }
    throw error;
  } finally {
    if (requestId === state.productRequest) root.setAttribute("aria-busy", "false");
  }
}

function productStock(product) {
  const active = product.deletedAt ? product.variants : product.variants.filter((variant) => variant.active);
  return {
    active,
    total: active.reduce((sum, variant) => sum + variant.stockQuantity, 0),
    low: active.some((variant) => variant.stockQuantity <= 5)
  };
}

function renderProducts() {
  const trash = state.productScope === "trash";
  const root = document.querySelector("#product-list");
  const summary = document.querySelector("[data-catalog-summary]");
  if (summary) {
    summary.innerHTML =
      `<article><span>Sản phẩm trong kết quả</span><strong>${state.products.length}</strong></article>` +
      `<article><span>Đang hiển thị</span><strong>${state.products.filter((p) => p.active).length}</strong></article>` +
      `<article><span>Biến thể bán hàng</span><strong>${state.products.reduce((n, p) => n + p.variants.length, 0)}</strong></article>`;
  }
  const category = document.querySelector("#product-category-filter").value;
  const publication = document.querySelector("#product-status-filter").value;
  const stockFilter = document.querySelector("#product-stock-filter").value;
  const matching = state.products.filter((product) => {
    const stock = productStock(product);
    return (!category || product.category === category)
      && (!publication || product.active === (publication === "active"))
      && (!stockFilter
        || (stockFilter === "low" && stock.low)
        || (stockFilter === "out" && stock.active.length > 0 && stock.total === 0)
        || (stockFilter === "missing" && stock.active.length === 0));
  });
  document.querySelector("#product-list-status").textContent =
    `${matching.length} sản phẩm${matching.length !== state.products.length ? ` / ${state.products.length} kết quả tìm kiếm` : ""}`;
  if (!matching.length) {
    const filtered = document.querySelector("#product-search").value.trim() || category || publication || stockFilter;
    root.innerHTML =
      `<div class="empty-message"><strong>${filtered ? "Không có sản phẩm phù hợp." : trash ? "Khu vực đã xóa đang trống." : "Danh mục đang trống."}</strong>` +
      `<p>${filtered ? "Thử từ khóa, SKU khác hoặc xóa bộ lọc để xem toàn bộ danh mục." : trash ? "Sản phẩm chuyển vào đây có thể chỉnh sửa, khôi phục hoặc kích hoạt lại." : "Thêm sản phẩm đầu tiên, sau đó bổ sung phiên bản, giá bán và tồn kho."}</p></div>`;
    return;
  }
  root.innerHTML = matching.map((product) => {
    const stock = productStock(product);
    const prices = stock.active.map((variant) => variant.priceVnd);
    const price = prices.length
      ? (Math.min(...prices) === Math.max(...prices)
          ? formatPrice(prices[0])
          : `${formatPrice(Math.min(...prices))} – ${formatPrice(Math.max(...prices))}`)
      : "Chưa có giá bán";
    const inventory = !stock.active.length
      ? '<span class="status-pill">Chưa có phiên bản bán</span>'
      : stock.total === 0
        ? '<span class="status-pill status-cancelled">Hết hàng</span>'
        : `${stock.low ? '<span class="status-pill status-warning">Có phiên bản tồn thấp</span>' : ""}<span class="stock-total">${stock.total} sản phẩm trong kho</span>`;
    return `<article class="product-row ${state.currentProduct?.id === product.id ? "is-selected" : ""}">
      <img src="${escapeHtml(window.GAERUAdminUI.imageUrl(product.imageUrl))}" alt="">
      <div class="product-row-copy"><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(categoryLabels[product.category] || product.category)} · ${stock.active.length} phiên bản đang bán</p><p class="product-row-price">${price}</p><div class="product-option-summary">${product.variants.slice(0, 3).map((v) => `<span>${escapeHtml(v.name)}</span>`).join("")}${product.variants.length > 3 ? `<span>+${product.variants.length - 3} biến thể</span>` : ""}</div><div class="product-stock">${inventory}</div></div>
      <span class="status-pill ${product.active ? "is-active" : ""}">${product.deletedAt ? "Đã xóa · " + escapeHtml(new Date(product.deletedAt).toLocaleDateString("vi-VN")) : product.active ? "Đang hiển thị" : "Bản nháp"}</span>
      <div class="product-row-actions"><button class="row-button" type="button" data-edit-product="${escapeHtml(product.id)}" aria-label="Quản lý ${escapeHtml(product.name)}">Chỉnh sửa</button>${can("catalog.write") ? trash ? `<button class="row-button" type="button" data-restore-product="${escapeHtml(product.id)}">Khôi phục</button><button class="row-button" type="button" data-activate-product="${escapeHtml(product.id)}">Khôi phục & kích hoạt</button>${["owner", "admin"].includes(state.session?.role) ? `<button class="row-button product-delete-button" type="button" data-purge-product="${escapeHtml(product.id)}">Xóa vĩnh viễn</button>` : ""}` : `${product.active ? `<button class="row-button product-visibility-button" type="button" data-toggle-visibility="${escapeHtml(product.id)}" data-set-active="false" aria-label="Ẩn ${escapeHtml(product.name)}">Ẩn sản phẩm</button>` : `<button class="row-button product-visibility-button" type="button" data-toggle-visibility="${escapeHtml(product.id)}" data-set-active="true" aria-label="Hiện ${escapeHtml(product.name)}">Hiện sản phẩm</button>`}<button class="row-button product-delete-button" type="button" data-delete-product="${escapeHtml(product.id)}" aria-label="Xóa ${escapeHtml(product.name)}">Xóa sản phẩm</button>` : ""}</div>
    </article>`;
  }).join("");
}

function setProductForm(product = null, { scroll = true } = {}) {
  state.currentProduct = product;
  const form = document.querySelector("#product-form");
  form.reset();
  document.querySelector("#product-editor").hidden = false;
  form.elements.id.value = product?.id || "";
  form.elements.name.value = product?.name || "";
  form.elements.slug.value = product?.slug || "";
  form.elements.category.value = product?.category || "audio";
  form.elements.descriptor.value = product?.descriptor || "";
  form.elements.description.value = product?.description || "";
  form.elements.imageUrl.value = product?.imageUrl || "";
  form.elements.imageAlt.value = product?.imageAlt || "";
  form.elements.active.checked = Boolean(product?.active);
  form.elements.active.disabled = !product || (!product.active && !product.variants.some((variant) => variant.active));
  form.elements.sortOrder.value = product?.sortOrder ?? 0;
  document.querySelector("#product-form-title").textContent = product ? product.name : "Thêm sản phẩm";
  document.querySelector("#variant-manager").hidden = !product;
  document.querySelector("#variant-form").hidden = true;
  document.querySelector("#product-draft-guidance").textContent = !product
    ? "Lưu bản nháp trước, thêm phiên bản với giá và tồn kho đã xác minh, sau đó mở hiển thị trên cửa hàng."
    : !product.variants.some((variant) => variant.active)
      ? "Thêm ít nhất một phiên bản đang bán trước khi mở hiển thị sản phẩm trên cửa hàng."
      : "Giá và tồn kho được quản lý riêng cho từng phiên bản bên dưới.";
  form.querySelector('button[type="submit"]').textContent = product ? "Lưu sản phẩm" : "Lưu bản nháp & thêm phiên bản";
  updateImagePreview();
  setFeedback(form, "");
  if (product) renderVariants(product);
  form.querySelectorAll("input,select,textarea,button").forEach((element) => { if (!can("catalog.write")) element.disabled = true; });
  form.querySelector('button[type="submit"]').hidden = !can("catalog.write");
  renderProducts();
  if (scroll) {
    form.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    form.elements.name.focus({ preventScroll: true });
  }
}

function renderVariants(product) {
  const root = document.querySelector("#variant-list");
  if (!product.variants.length) {
    root.innerHTML = '<p class="empty-message">Chưa có phiên bản. Thêm giá bán và tồn kho đã xác minh để có thể xuất bản sản phẩm.</p>';
    return;
  }
  root.innerHTML = product.variants.map((variant) => `<div class="variant-row">
    <div class="variant-identity"><strong>${escapeHtml(variant.name)}</strong><br><span>SKU ${escapeHtml(variant.sku)} · ${variant.active ? "Đang bán" : "Tạm ẩn"}</span></div>
    <span>${formatPrice(variant.priceVnd)}</span>
    <span class="${variant.active && variant.stockQuantity <= 5 ? "stock-alert" : ""}">${variant.stockQuantity === 0 ? "Hết hàng" : `Tồn kho: ${variant.stockQuantity}`}</span>
    <div class="variant-actions"><button class="row-button" type="button" data-edit-variant="${escapeHtml(variant.id)}" aria-label="Xem ${escapeHtml(variant.name)}">${can("catalog.write") ? "Sửa" : "Xem"}</button>
    ${can("catalog.write") ? `<button class="plain-button" type="button" data-delete-variant="${escapeHtml(variant.id)}" aria-label="Xóa ${escapeHtml(variant.name)}">Xóa</button>` : ""}</div>
  </div>`).join("");
}

function fillVariantForm(variant = null) {
  const form = document.querySelector("#variant-form");
  form.reset();
  form.hidden = false;
  form.elements.id.value = variant?.id || "";
  form.elements.sku.value = variant?.sku || "";
  form.elements.name.value = variant?.name || "";
  form.elements.priceVnd.value = variant?.priceVnd ?? "";
  form.elements.stockQuantity.value = variant?.stockQuantity ?? 0;
  form.querySelectorAll("input,select,textarea,button").forEach((element) => { element.disabled = !can("catalog.write"); });
  form.elements.stockQuantity.disabled = !can("inventory.approve");
  form.querySelector('button[type="submit"]').hidden = !can("catalog.write");
  renderAttributes(variant?.options || {});
  form.elements.active.checked = Boolean(variant?.active);
  setFeedback(form, "");
  form.elements.sku.focus();
}

function renderAttributes(options) {
  const entries = Object.entries(options);
  document.querySelector("#variant-attributes").innerHTML = entries.map(([key, value]) => attributeRow(key, value)).join("");
}

function attributeRow(key = "", value = "") {
  return `<div class="attribute-row"><label>Tên thuộc tính<input data-attribute-key value="${escapeHtml(key)}" placeholder="Ví dụ: Cổng kết nối"></label><label>Giá trị<input data-attribute-value value="${escapeHtml(value)}" placeholder="Ví dụ: Type-C"></label><button class="plain-button" type="button" data-remove-attribute aria-label="Xóa thuộc tính">Xóa</button></div>`;
}

function readAttributes() {
  const options = Object.create(null);
  for (const row of document.querySelectorAll("#variant-attributes .attribute-row")) {
    const key = row.querySelector("[data-attribute-key]").value.trim();
    const value = row.querySelector("[data-attribute-value]").value.trim();
    if (!key && !value) continue;
    if (!key || !value) throw new Error("Nhập đủ tên và giá trị cho mỗi thuộc tính, hoặc xóa dòng chưa dùng.");
    if (Object.hasOwn(options, key)) throw new Error(`Thuộc tính “${key}” đang bị trùng tên.`);
    options[key] = value;
  }
  return options;
}

function validateImage(file) {
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Chọn ảnh PNG, JPEG hoặc WebP.");
  if (file.size > 8 * 1024 * 1024) throw new Error("Ảnh vượt quá 8 MB. Hãy chọn ảnh có dung lượng nhỏ hơn.");
}

function updateImagePreview() {
  const form = document.querySelector("#product-form");
  const file = form.elements.imageFile.files[0];
  const preview = document.querySelector("#product-image-preview");
  const image = document.querySelector("#product-preview-image");
  const caption = document.querySelector("#product-preview-caption");
  const requestId = ++state.imagePreviewRequest;
  form.elements.imageUrl.required = !file;
  if (file) form.elements.imageUrl.removeAttribute("pattern");
  else form.elements.imageUrl.setAttribute("pattern", "/assets/products/[a-zA-Z0-9._-]+");
  form.elements.imageFile.setCustomValidity("");
  try {
    validateImage(file);
  } catch (error) {
    form.elements.imageFile.setCustomValidity(error.message);
    setFeedback(form, error.message);
    preview.hidden = true;
    return;
  }
  setFeedback(form, "");
  if (file) {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (requestId !== state.imagePreviewRequest) return;
      image.src = reader.result;
      caption.textContent = `${file.name} · ${(file.size / 1024 / 1024).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} MB · Chưa lưu`;
      preview.hidden = false;
    });
    reader.addEventListener("error", () => {
      if (requestId !== state.imagePreviewRequest) return;
      preview.hidden = true;
      setFeedback(form, "Không đọc được ảnh xem trước. Hãy chọn lại tệp.");
    });
    reader.readAsDataURL(file);
  } else {
    const path = form.elements.imageUrl.value.trim();
    preview.hidden = !/^\/assets\/products\/[a-zA-Z0-9._-]+$/.test(path);
    if (!preview.hidden) {
      image.src = window.GAERUAdminUI.imageUrl(path);
      caption.textContent = "Ảnh đang lưu trên cửa hàng";
    }
  }
}

async function reloadSelectedProduct(productId, originalEditorId = productId, { preserveDraft = false } = {}) {
  const result = await request("/api/gaeru_ceo/products");
  const product = result.products.find((item) => item.id === productId);
  if (
    product &&
    !document.querySelector("#product-editor").hidden &&
    document.querySelector("#product-form").elements.id.value === originalEditorId
  ) {
    if (preserveDraft) {
      state.currentProduct = product;
      renderVariants(product);
      document.querySelector("#variant-form").hidden = true;
      const activeField = document.querySelector("#product-form").elements.active;
      activeField.disabled = !product.active && !product.variants.some((variant) => variant.active);
      if (activeField.disabled) activeField.checked = false;
      document.querySelector("#product-draft-guidance").textContent = activeField.disabled
        ? "Thêm ít nhất một phiên bản đang bán trước khi mở hiển thị sản phẩm trên cửa hàng."
        : "Phiên bản đã được cập nhật. Lưu sản phẩm để áp dụng các thay đổi về nội dung hoặc hiển thị.";
    } else {
      setProductForm(product, { scroll: false });
    }
  }
  await Promise.all([loadProducts(document.querySelector("#product-search").value.trim()), loadSummary()]);
}

async function saveProduct(event) {
  event.preventDefault();
  if (!can("catalog.write")) return;
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  if (form.dataset.saving) return;
  form.dataset.saving = "true";
  submitButton.disabled = true;
  submitButton.textContent = "Đang lưu…";
  setFeedback(form, "");
  try {
    const file = form.elements.imageFile.files[0];
    validateImage(file);
    const id = form.elements.id.value;
    const payload = {
      name: form.elements.name.value.trim(),
      slug: form.elements.slug.value.trim(),
      category: form.elements.category.value,
      descriptor: form.elements.descriptor.value.trim(),
      description: form.elements.description.value.trim(),
      imageUrl: form.elements.imageUrl.value.trim(),
      imageAlt: form.elements.imageAlt.value.trim(),
      active: Boolean(id) && form.elements.active.checked,
      sortOrder: Number(form.elements.sortOrder.value)
    };
    if (file) {
      const upload = new FormData();
      upload.append("image", file);
      const result = await request("/api/gaeru_ceo/uploads", { method: "POST", body: upload });
      payload.imageUrl = result.imageUrl;
      if (form.elements.id.value === id) form.elements.imageUrl.value = result.imageUrl;
    }
    const result = await request(id ? `/api/gaeru_ceo/products/${encodeURIComponent(id)}` : "/api/gaeru_ceo/products", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload)
    });
    await reloadSelectedProduct(id || result.id, id);
    if (!id) {
      showProductAddedPopup("Đã thêm sản phẩm mới thành công");
      showGlobal("Đã thêm sản phẩm mới thành công");
    } else {
      showProductAddedPopup("Đã sửa sản phẩm thành công");
      showGlobal("Đã sửa sản phẩm thành công");
    }
    const editor = document.querySelector("#product-editor");
    if (editor) editor.hidden = true;
  } catch (error) {
    setFeedback(form, error.message);
  } finally {
    submitButton.disabled = false;
    delete form.dataset.saving;
    submitButton.textContent = form.elements.id.value ? "Lưu sản phẩm" : "Lưu bản nháp & thêm phiên bản";
  }
}

async function saveVariant(event) {
  event.preventDefault();
  if (!can("catalog.write")) return;
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  if (form.dataset.saving) return;
  form.dataset.saving = "true";
  submitButton.disabled = true;
  submitButton.textContent = "Đang lưu…";
  setFeedback(form, "");
  try {
    const options = readAttributes();
    const payload = {
      sku: form.elements.sku.value.trim(),
      name: form.elements.name.value.trim(),
      options,
      priceVnd: Number(form.elements.priceVnd.value),
      stockQuantity: Number(form.elements.stockQuantity.value),
      active: form.elements.active.checked
    };
    const variantId = form.elements.id.value;
    const productId = state.currentProduct.id;
    await request(
      variantId
        ? `/api/gaeru_ceo/variants/${encodeURIComponent(variantId)}`
        : `/api/gaeru_ceo/products/${encodeURIComponent(productId)}/variants`,
      { method: variantId ? "PUT" : "POST", body: JSON.stringify(payload) }
    );
    await reloadSelectedProduct(productId, productId, { preserveDraft: true });
    showGlobal("Đã lưu phiên bản và cập nhật tồn kho.");
  } catch (error) {
    setFeedback(form, error.message);
  } finally {
    submitButton.disabled = false;
    delete form.dataset.saving;
    submitButton.textContent = "Lưu phiên bản";
  }
}

function confirmProductAction(product, { permanent = false, message } = {}) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "enterprise-confirm-dialog";
    dialog.setAttribute("aria-labelledby", "product-action-title");
    dialog.innerHTML =
      '<h2 id="product-action-title">' + (permanent ? "Xóa vĩnh viễn sản phẩm" : "Xác nhận thao tác") + "</h2>" +
      "<p data-product-action-name></p><p data-product-action-message></p>" +
      (permanent ? '<label>Nhập đường dẫn sản phẩm để xác nhận<input data-product-action-input autocomplete="off"></label><p data-product-action-slug></p>' : "") +
      '<div class="enterprise-confirm-actions"><button type="button" data-product-action-cancel autofocus>Quay lại</button><button type="button" class="primary-button" data-product-action-accept ' + (permanent ? "disabled" : "") + ">Xác nhận</button></div>";
    dialog.querySelector("[data-product-action-name]").textContent = product.name;
    dialog.querySelector("[data-product-action-message]").textContent = message;
    let done = false;
    function finish(value) {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      previous?.focus();
      resolve(value);
    }
    const accept = dialog.querySelector("[data-product-action-accept]");
    if (permanent) {
      dialog.querySelector("[data-product-action-slug]").textContent = product.slug;
      dialog.querySelector("input").addEventListener("input", (event) => {
        accept.disabled = event.target.value !== product.slug;
      });
    }
    accept.onclick = () => {
      if (!permanent || dialog.querySelector("input").value === product.slug) finish(true);
    };
    dialog.querySelector("[data-product-action-cancel]").onclick = () => finish(false);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener("close", () => finish(false));
    document.body.append(dialog);
    dialog.showModal();
  });
}

document.querySelector("#product-search").addEventListener("input", async (event) => {
  window.clearTimeout(state.productSearchTimer);
  const searchValue = event.currentTarget.value;
  state.productSearchTimer = window.setTimeout(() => {
    if (searchValue !== document.querySelector("#product-search").value) return;
    loadProducts(searchValue.trim()).catch((error) => showGlobal(error.message, true));
  }, 180);
});
document.querySelector("#new-product-button").addEventListener("click", () => {
  if (can("catalog.write")) location.href = "/gaeru_ceo/products/new";
});
document.querySelectorAll(".product-filters select").forEach((select) => select.addEventListener("change", renderProducts));
document.querySelector("#reset-product-filters").addEventListener("click", () => {
  document.querySelector("#product-search").value = "";
  document.querySelectorAll(".product-filters select").forEach((select) => { select.value = ""; });
  loadProducts().catch((error) => showGlobal(error.message, true));
});
document.querySelectorAll("[data-product-scope]").forEach((button) => button.addEventListener("click", async () => {
  state.productScope = button.dataset.productScope;
  const address = new URL(location.href);
  if (state.productScope === "trash") address.searchParams.set("productScope", "trash");
  else address.searchParams.delete("productScope");
  history.replaceState(null, "", address.pathname + address.search + address.hash);
  document.querySelectorAll("[data-product-scope]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
  document.querySelector("#product-status-filter").value = "";
  document.querySelector("#product-stock-filter").value = "";
  document.querySelector("#product-trash-note").hidden = state.productScope !== "trash";
  try {
    await loadProducts(document.querySelector("#product-search").value.trim());
  } catch (e) {
    showGlobal(e.message, true);
  }
}));
document.querySelector("#product-list").addEventListener("click", async (event) => {
  const recover = event.target.closest("[data-restore-product],[data-activate-product],[data-purge-product]");
  if (recover) {
    const product = state.products.find((p) => p.id === (recover.dataset.restoreProduct || recover.dataset.activateProduct || recover.dataset.purgeProduct));
    if (!product || !can("catalog.write") || recover.disabled) return;
    const purge = Boolean(recover.dataset.purgeProduct);
    const activate = Boolean(recover.dataset.activateProduct);
    const confirmed = await confirmProductAction(product, {
      permanent: purge,
      message: purge
        ? "Xóa vĩnh viễn sản phẩm này? Không thể khôi phục. Sản phẩm còn tồn hoặc có chứng từ sẽ được giữ lại."
        : activate
          ? "Khôi phục sản phẩm và các biến thể đã chọn để hiển thị trên cửa hàng?"
          : "Khôi phục sản phẩm về bản nháp để tiếp tục chỉnh sửa?"
    });
    if (!confirmed) return;
    recover.disabled = true;
    try {
      await request("/api/gaeru_ceo/products/" + encodeURIComponent(product.id) + (purge ? "/permanent" : "/restore"), {
        method: purge ? "DELETE" : "POST",
        body: JSON.stringify(purge ? { version: product.version, confirmation: product.slug } : { version: product.version, activate })
      });
      await Promise.all([loadProducts(document.querySelector("#product-search").value.trim()), loadSummary()]);
      showGlobal(purge ? "Đã xóa vĩnh viễn sản phẩm." : activate ? "Đã khôi phục và kích hoạt sản phẩm." : "Đã khôi phục về bản nháp.");
    } catch (error) {
      showGlobal(error.message, true);
      recover.disabled = false;
    }
    return;
  }
  const toggleVisibility = event.target.closest("[data-toggle-visibility]");
  if (toggleVisibility) {
    const product = state.products.find((item) => item.id === toggleVisibility.dataset.toggleVisibility);
    if (!product || !can("catalog.write") || toggleVisibility.disabled) return;
    const setActive = toggleVisibility.dataset.setActive === "true";
    if (setActive && (!product.variants || !product.variants.some((v) => v.active))) {
      showGlobal("Cần ít nhất một phiên bản đang bán trước khi mở hiển thị sản phẩm trên cửa hàng.", true);
      return;
    }
    const message = setActive
      ? "Mở hiển thị sản phẩm này lên cửa hàng để khách hàng có thể xem và đặt mua?"
      : "Ẩn sản phẩm này khỏi cửa hàng? Khách hàng sẽ không thấy sản phẩm trên gian hàng.";
    if (!(await confirmProductAction(product, { message }))) return;
    toggleVisibility.disabled = true;
    try {
      const res = await request('/api/gaeru_ceo/products/'+encodeURIComponent(product.id)+'/visibility', {
        method: "POST",
        body: JSON.stringify({ active: setActive })
      });
      if (state.currentProduct?.id === product.id) {
        state.currentProduct.active = setActive;
        const activeInput = document.querySelector('#product-form input[name="active"]');
        if (activeInput) activeInput.checked = setActive;
      }
      await Promise.all([loadProducts(document.querySelector("#product-search").value.trim()), loadSummary()]);
      showGlobal(res.message || (setActive ? "Đã hiển thị sản phẩm trên cửa hàng." : "Đã ẩn sản phẩm khỏi cửa hàng."));
    } catch (error) {
      showGlobal(error.message, true);
      toggleVisibility.disabled = false;
    }
    return;
  }
  const remove = event.target.closest("[data-delete-product]");
  if (remove) {
    const product = state.products.find((item) => item.id === remove.dataset.deleteProduct);
    if (!product || !can("catalog.write") || remove.disabled) return;
    if (!(await confirmProductAction(product, { message: "Chuyển sản phẩm vào khu vực đã xóa? Lịch sử đơn hàng và tồn kho được giữ lại." }))) return;
    remove.disabled = true;
    try {
      await request("/api/gaeru_ceo/products/" + encodeURIComponent(product.id), {
        method: "DELETE",
        body: JSON.stringify({ version: product.version, confirmation: "DELETE_PRODUCT" })
      });
      if (state.currentProduct?.id === product.id) {
        state.currentProduct = null;
        document.querySelector("#product-editor").hidden = true;
      }
      await Promise.all([loadProducts(document.querySelector("#product-search").value.trim()), loadSummary()]);
      showGlobal("Đã xóa sản phẩm khỏi danh mục. Lịch sử đơn hàng và kho được giữ lại.");
    } catch (error) {
      showGlobal(error.message, true);
      remove.disabled = false;
    }
    return;
  }
  const button = event.target.closest("[data-edit-product]");
  if (button) {
    location.href = "/gaeru_ceo/products/" + encodeURIComponent(button.dataset.editProduct) + "/edit" + (state.productScope === "trash" ? "?trash=1" : "");
  }
});
document.querySelector("#product-form").addEventListener("submit", saveProduct);
document.querySelector('#product-form input[name="imageFile"]').addEventListener("change", updateImagePreview);
document.querySelector('#product-form input[name="imageUrl"]').addEventListener("input", updateImagePreview);
document.querySelectorAll("[data-close-editor]").forEach((button) => button.addEventListener("click", () => {
  document.querySelector("#product-editor").hidden = true;
  state.currentProduct = null;
  renderProducts();
}));
document.querySelector("#new-variant-button").addEventListener("click", () => fillVariantForm());
document.querySelector("#variant-form").addEventListener("submit", saveVariant);
document.querySelector("#add-variant-attribute").addEventListener("click", () => {
  const list = document.querySelector("#variant-attributes");
  list.insertAdjacentHTML("beforeend", attributeRow());
  list.lastElementChild.querySelector("input").focus();
});
document.querySelector("#variant-attributes").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-attribute]");
  if (button) {
    button.closest(".attribute-row").remove();
    document.querySelector("#add-variant-attribute").focus();
  }
});
document.querySelectorAll("[data-close-variant]").forEach((button) => button.addEventListener("click", () => {
  document.querySelector("#variant-form").hidden = true;
}));
document.querySelector("#variant-list").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit-variant]");
  const remove = event.target.closest("[data-delete-variant]");
  if (edit) {
    fillVariantForm(state.currentProduct.variants.find((variant) => variant.id === edit.dataset.editVariant));
    return;
  }
  if (remove && window.confirm("Xóa phiên bản này? Phiên bản đã có trong đơn hàng cần được tạm ẩn thay vì xóa.")) {
    if (remove.disabled) return;
    remove.disabled = true;
    try {
      const productId = state.currentProduct.id;
      await request(`/api/gaeru_ceo/variants/${encodeURIComponent(remove.dataset.deleteVariant)}`, { method: "DELETE" });
      await reloadSelectedProduct(productId, productId, { preserveDraft: true });
      showGlobal("Đã xóa phiên bản.");
    } catch (error) {
      showGlobal(error.message, true);
    } finally {
      remove.disabled = false;
    }
  }
});
