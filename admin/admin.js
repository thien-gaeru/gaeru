const state = {
  session: null,
  viewRequest: 0,
  csrfToken: "",
  products: [],
  orders: [],
  customers: [],
  currentProduct: null,
  productRequest: 0,
  productScope: /(?:[?&])productScope=trash(?:&|$)/.test(location.search||'')?"trash":"catalog",
  productSearchTimer: 0,
  orderSearchTimer: 0,
  orderRequest: 0,
  openOrders: new Set(),
  selectedOrders: new Set(),
  imagePreviewRequest: 0,
  orderPage: 1,
  orderPagination: { page: 1, pageCount: 0, total: 0 },
  customerSearchTimer: 0,
  customerPage: 1,
  customerPagination: { page: 1, pageCount: 0, total: 0 }
};
const labels = {
  pending: "Chờ xác nhận",
  confirmed: "Đã xác nhận",
  processing: "Đang xử lý",
  shipped: "Đang giao",
  completed: "Hoàn tất",
  cancelled: "Đã hủy",
  cod: "Thanh toán khi nhận hàng",
  bank_transfer: "Chuyển khoản thủ công",
  vnpay: "VNPAY",
  "9pay": "9Pay"
};
const categoryLabels = { audio: "Thu âm", video: "Ghi hình", accessory: "Phụ kiện" };
const orderTransitions = {
  pending: ["confirmed", "cancelled"], confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"], shipped: ["completed"], completed: [], cancelled: []
};
const paymentAttemptLabels = {
  pending: "Đang chờ VNPAY xác nhận giao dịch.",
  failed: "Giao dịch VNPAY chưa thành công; khách có thể cần đặt lại đơn."
};
const formatPrice = (value) => value == null ? "Chưa xác định" : `${new Intl.NumberFormat("vi-VN").format(value)} ₫`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));
const can = (permission) => !state.session?.mfaEnrollmentRequired && Boolean(state.session?.permissions?.includes(permission) || state.session?.permissions?.includes("*"));

function applyPermissions() {
  document.querySelectorAll("[data-permission], [data-require]").forEach((element) => {
    element.hidden = !can(element.dataset.permission || element.dataset.require);
  });
  document.querySelectorAll(".nav-group").forEach((group) => { group.hidden = ![...group.querySelectorAll("[data-view]")].some((button) => !button.hidden); });
  document.querySelectorAll('[data-owner-only]').forEach(element=>{element.hidden=state.session?.role!=='owner'||state.session?.source!=='bootstrap';if(element.closest('.nav-group'))element.closest('.nav-group').hidden=element.hidden;});
  document.querySelectorAll("#settings-form input,#settings-form textarea,#settings-form button").forEach((element) => { element.disabled = !can("settings.write"); });
}

async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") headers.set("X-CSRF-Token", state.csrfToken);
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && state.session) { state.session = null; location.replace("/gaeru_ceo?expired=1"); }
  if (!response.ok) throw Object.assign(new Error(body.error || `Yêu cầu thất bại (${response.status}).`),{status:response.status,diagnostic:body.diagnostic,stage:body.stage});
  return body;
}

function showGlobal(message, isError = false) {
  const feedback = document.querySelector("#global-feedback");
  feedback.textContent = message;
  feedback.classList.toggle("is-error", isError);
}

function setFeedback(form, message) {
  form.querySelector('[role="alert"]')?.replaceChildren(document.createTextNode(message));
}

async function initialize() {
  try {
    const csrf = await request("/api/csrf");
    state.csrfToken = csrf.csrfToken;
    const session = await request("/api/auth/me");
    if (session.authenticated&&!new URLSearchParams(location.search).has("securityReset")) await showAdmin(session);
    else { document.querySelector("#login-panel").hidden = false; if (new URLSearchParams(location.search).has("expired")) document.querySelector("#login-feedback").textContent = "Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại."; }
  } catch (error) {
    document.querySelector("#login-panel").hidden = false;
    document.querySelector("#login-feedback").textContent = `Không thể kết nối máy chủ: ${error.message}`;
  }
}

async function showAdmin(session) {
  state.session = session;
  document.querySelector("#login-panel").hidden = true;
  document.querySelector("#admin-app").hidden = false;
  const identityName = session.fullName || session.username;
  const roleLabel = window.GAERUAdminUI.roleName(session.role);
  document.querySelector("#admin-identity").textContent = roleLabel && identityName !== roleLabel ? `${identityName} · ${roleLabel}` : identityName;
  applyPermissions();
  document.querySelectorAll('[data-product-scope]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.productScope===state.productScope)));
  document.querySelector('#product-trash-note').hidden=state.productScope!=='trash';
  if(session.mfaEnrollmentRequired){document.querySelectorAll('[data-view]').forEach(b=>{b.hidden=b.dataset.view!=='security';});document.querySelectorAll('.nav-group').forEach(g=>{g.hidden=![...g.querySelectorAll('[data-view]')].some(b=>!b.hidden);});}

  document.dispatchEvent(new CustomEvent("gaeru:admin-ready", { detail: session }));
  if(session.mfaEnrollmentRequired){await activateView('security');showGlobal('Bắt buộc bật xác thực hai yếu tố trước khi truy cập quản trị.');return;}
  let initialView = "";
  try { initialView = decodeURIComponent(location.hash.slice(1)); } catch {}
  const buttons = [...document.querySelectorAll('[data-view]')];
  const firstView = buttons.find(button => button.dataset.view === initialView && !button.hidden && can(button.dataset.permission)) || buttons.find(button => !button.hidden && can(button.dataset.permission));
  if (firstView) await activateView(firstView.dataset.view, { updateHistory: false });
  else showGlobal("Tài khoản chưa được cấp quyền truy cập chức năng. Liên hệ người quản trị.", true);
}

async function loadSummary() {
  if (!can("dashboard.read")) return;
  const summary = await request("/api/gaeru_ceo/summary");
  document.querySelector("#active-product-count").textContent = summary.products.active;
  document.querySelector("#product-count").textContent = summary.products.total;
  document.querySelector("#pending-order-count").textContent = summary.orders.needsAction;
  document.querySelector("#order-count").textContent = summary.orders.total;
  document.querySelector("#unpaid-order-count").textContent = summary.orders.paymentPending;
  document.querySelector("#low-stock-count").textContent = summary.products.lowStock;
  document.querySelector("#orders-gate-notice").hidden = summary.ordersEnabled;
  document.querySelector("#shipping-rates-notice").hidden = summary.shippingRatesConfigured;
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
    if (requestId === state.productRequest) document.querySelector("#product-list-status").textContent = "Chưa tải được danh mục. Hãy thử tìm lại hoặc mở lại mục Sản phẩm & kho.";
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
  const trash=state.productScope==="trash";
  const root = document.querySelector("#product-list");
  const summary=document.querySelector("[data-catalog-summary]");if(summary)summary.innerHTML=`<article><span>Sản phẩm trong kết quả</span><strong>${state.products.length}</strong></article><article><span>Đang hiển thị</span><strong>${state.products.filter(p=>p.active).length}</strong></article><article><span>Biến thể bán hàng</span><strong>${state.products.reduce((n,p)=>n+p.variants.length,0)}</strong></article>`;
  const category = document.querySelector("#product-category-filter").value;
  const publication = document.querySelector("#product-status-filter").value;
  const stockFilter = document.querySelector("#product-stock-filter").value;
  const matching = state.products.filter((product) => {
    const stock = productStock(product);
    return (!category || product.category === category)
      && (!publication || product.active === (publication === "active"))
      && (!stockFilter || (stockFilter === "low" && stock.low)
        || (stockFilter === "out" && stock.active.length > 0 && stock.total === 0)
        || (stockFilter === "missing" && stock.active.length === 0));
  });
  document.querySelector("#product-list-status").textContent = `${matching.length} sản phẩm${matching.length !== state.products.length ? ` / ${state.products.length} kết quả tìm kiếm` : ""}`;
  if (!matching.length) {
    const filtered = document.querySelector("#product-search").value.trim() || category || publication || stockFilter;
    root.innerHTML = `<div class="empty-message"><strong>${filtered ? "Không có sản phẩm phù hợp." : trash ? "Khu vực đã xóa đang trống." : "Danh mục đang trống."}</strong><p>${filtered ? "Thử từ khóa, SKU khác hoặc xóa bộ lọc để xem toàn bộ danh mục." : trash ? "Sản phẩm chuyển vào đây có thể chỉnh sửa, khôi phục hoặc kích hoạt lại." : "Thêm sản phẩm đầu tiên, sau đó bổ sung phiên bản, giá bán và tồn kho."}</p></div>`;
    return;
  }
  root.innerHTML = matching.map((product) => {
    const stock = productStock(product);
    const prices = stock.active.map((variant) => variant.priceVnd);
    const price = prices.length ? (Math.min(...prices) === Math.max(...prices) ? formatPrice(prices[0]) : `${formatPrice(Math.min(...prices))} – ${formatPrice(Math.max(...prices))}`) : "Chưa có giá bán";
    const inventory = !stock.active.length ? '<span class="status-pill">Chưa có phiên bản bán</span>'
      : stock.total === 0 ? '<span class="status-pill status-cancelled">Hết hàng</span>'
        : `${stock.low ? '<span class="status-pill status-warning">Có phiên bản tồn thấp</span>' : ""}<span class="stock-total">${stock.total} sản phẩm trong kho</span>`;
    return `<article class="product-row ${state.currentProduct?.id === product.id ? "is-selected" : ""}">
      <img src="${escapeHtml(window.GAERUAdminUI.imageUrl(product.imageUrl))}" alt="">
      <div class="product-row-copy"><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(categoryLabels[product.category] || product.category)} · ${stock.active.length} phiên bản đang bán</p><p class="product-row-price">${price}</p><div class="product-option-summary">${product.variants.slice(0,3).map(v=>`<span>${escapeHtml(v.name)}</span>`).join("")}${product.variants.length>3?`<span>+${product.variants.length-3} biến thể</span>`:""}</div><div class="product-stock">${inventory}</div></div>
      <span class="status-pill ${product.active ? "is-active" : ""}">${product.deletedAt ? "Đã xóa · "+escapeHtml(new Date(product.deletedAt).toLocaleDateString("vi-VN")) : product.active ? "Đang hiển thị" : "Bản nháp"}</span>
      <div class="product-row-actions"><button class="row-button" type="button" data-edit-product="${escapeHtml(product.id)}" aria-label="Quản lý ${escapeHtml(product.name)}">Chỉnh sửa</button>${can("catalog.write") ? trash ? `<button class="row-button" type="button" data-restore-product="${escapeHtml(product.id)}">Khôi phục</button><button class="row-button" type="button" data-activate-product="${escapeHtml(product.id)}">Khôi phục & kích hoạt</button>${['owner','admin'].includes(state.session?.role)?`<button class="row-button product-delete-button" type="button" data-purge-product="${escapeHtml(product.id)}">Xóa vĩnh viễn</button>`:''}` : `<button class="row-button product-delete-button" type="button" data-delete-product="${escapeHtml(product.id)}" aria-label="Xóa ${escapeHtml(product.name)}">Xóa sản phẩm</button>` : ""}</div>
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
  if (product && !document.querySelector("#product-editor").hidden
    && document.querySelector("#product-form").elements.id.value === originalEditorId) {
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
    } else setProductForm(product, { scroll: false });
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
      method: id ? "PUT" : "POST", body: JSON.stringify(payload)
    });
    await reloadSelectedProduct(id || result.id, id);
    showGlobal(id ? "Đã lưu thông tin sản phẩm." : "Đã lưu bản nháp. Thêm phiên bản với giá và tồn kho để tiếp tục.");
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
    await request(variantId ? `/api/gaeru_ceo/variants/${encodeURIComponent(variantId)}` : `/api/gaeru_ceo/products/${encodeURIComponent(productId)}/variants`, {
      method: variantId ? "PUT" : "POST", body: JSON.stringify(payload)
    });
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

function orderEditing() {
  return state.selectedOrders.size > 0 || Boolean(document.querySelector('dialog[open]'))
    || Boolean(document.activeElement?.closest('#orders-view input,#orders-view select,#orders-view textarea,#order-review,#after-sales-panel'));
}
let orderSnapshot = '';
async function loadOrders(page = state.orderPage, { background = false } = {}) {
  if (!can("orders.read")) return;
  const root = document.querySelector("#order-list");
  if (background && (root.getAttribute('aria-busy') === 'true' || document.querySelector('#orders-view').hidden)) return;
  const requestId = ++state.orderRequest;
  if (!background) {
    state.selectedOrders.clear();
    document.querySelectorAll('[data-select-order]').forEach(input => { input.checked = false; });
    updateOrderSelection();
  }
  const status = document.querySelector("#order-filter").value;
  const search = document.querySelector("#order-search").value.trim();
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (search) params.set("q", search);
  const paymentStatus = document.querySelector("#order-payment-filter").value;
  const paymentMethod = document.querySelector("#order-method-filter").value;
  if (paymentStatus) params.set("paymentStatus", paymentStatus);
  if (paymentMethod) params.set("paymentMethod", paymentMethod);
  params.set("page", String(page));
  params.set("sort", document.querySelector("#order-sort").value || "newest");
  params.set("pageSize", document.querySelector("#order-page-size").value || "25");
  params.set("overview", "1");
  root.setAttribute("aria-busy", "true");
  if (!background) document.querySelector("#order-list-status").textContent = "Đang tải đơn hàng…";
  try {
    const result = await request(`/api/gaeru_ceo/orders?${params}`);
    if (requestId !== state.orderRequest || status !== document.querySelector("#order-filter").value
      || search !== document.querySelector("#order-search").value.trim()
      || paymentStatus !== document.querySelector("#order-payment-filter").value
      || paymentMethod !== document.querySelector("#order-method-filter").value
      || params.get('sort') !== (document.querySelector('#order-sort').value || 'newest')
      || params.get('pageSize') !== (document.querySelector('#order-page-size').value || '25')) return;
    const snapshot = JSON.stringify(result);
    if (background) {
      if (document.hidden || document.querySelector('#orders-view').hidden) return;
      if (snapshot === orderSnapshot) return;
      if (orderEditing()) {
        document.querySelector('#order-live-status').textContent = 'Có cập nhật đơn hàng. Sẽ tự cập nhật sau khi bạn hoàn tất thao tác hoặc bỏ chọn đơn.';
        return;
      }
    }
    orderSnapshot = snapshot;
    state.orderPage = result.pagination.page;
    state.orderPagination = result.pagination;
    state.orders = result.orders;
    state.selectedOrders.clear();
    renderOrderOverview(result.overview || {});
    renderOrders();
    document.querySelector('#order-live-status').textContent = 'Tự cập nhật mỗi 15 giây' + (background ? ' · Đã cập nhật lúc ' + new Date().toLocaleTimeString('vi-VN') : '');
  } catch (error) {
    if (requestId === state.orderRequest) document.querySelector(background ? '#order-live-status' : '#order-list-status').textContent = background ? 'Mất kết nối cập nhật. Hệ thống sẽ tự thử lại.' : "Chưa tải được đơn hàng. Nhấn Tải lại để thử lại.";
    throw error;
  } finally {
    if (requestId === state.orderRequest) root.setAttribute("aria-busy", "false");
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const poll = window.GAERUCareLive.poll({
    delay: 15000,
    active: () => Boolean(state.session) && !document.querySelector('#admin-app').hidden && can('orders.read')
      && (!document.querySelector('#orders-view').hidden || !document.querySelector('#overview-view').hidden),
    run: () => document.querySelector('#orders-view').hidden ? loadSummary() : loadOrders(state.orderPage, { background: true }),
    status: message => { if (message.includes('Phiên')) document.querySelector('#order-live-status').textContent = message; }
  });
  window.addEventListener('focus', poll.refresh);
  window.addEventListener('pagehide', event => { if (!event.persisted) poll.stop(); });
  window.addEventListener('pageshow', poll.refresh);
});

function isLiveVnpayAttempt(order) {
  return order.paymentMethod === "vnpay" && order.paymentAttemptStatus === "pending"
    && (!order.paymentAttemptExpiresAt || new Date(order.paymentAttemptExpiresAt).getTime() > Date.now());
}

function canEditShipping(order) {
  return can("orders.write") && order.status === "pending" && order.paymentStatus !== "paid" && !(Number(order.receivedVnd) > 0)
    && !(order.paymentMethod === "vnpay" && (order.paymentProvider || order.paymentAttemptStatus));
}

function orderPaymentControl(order) {
  const paymentLabel = order.paymentStatus === "paid" ? "Đã thanh toán" : Number(order.receivedVnd) > 0 ? "Đã thu một phần" : "Chưa thanh toán";
  if (["vnpay", "9pay"].includes(order.paymentMethod)) return `<div class="order-payment-readonly"><span>Thanh toán</span><strong>${paymentLabel}</strong><small>Trạng thái được cập nhật từ cổng thanh toán.</small></div>`;
  if (!can("payments.write") || order.paymentStatus === "paid" || ["cancelled", "completed"].includes(order.status)) return `<div class="order-payment-readonly"><span>Thanh toán</span><strong>${paymentLabel}</strong><small>${order.paymentStatus === "paid" ? "Đã ghi nhận thu tiền." : "Trạng thái hiện tại của đơn hàng."}</small></div>`;
  return `<label>Thanh toán<select name="paymentStatus" ${order.paymentMethod === "cod" ? "disabled" : ""}><option value="pending">Chưa thanh toán</option><option value="paid">Đã thanh toán</option></select><span class="help-text" data-payment-guidance>${order.paymentMethod === "cod" ? "Chỉ ghi nhận thu tiền khi hoàn tất giao hàng." : "Chỉ xác nhận khi đã đối soát và nhận đủ tiền."}</span></label>`;
}

function changeOrderControl(event){
  if (!event.target.matches('select[name="status"]')) return;
  const form = event.target.closest("[data-order-form]");
  const order = state.orders.find((entry) => entry.id === form.dataset.orderForm);
  const paymentField = form.elements.paymentStatus;
  if (order?.paymentMethod === "cod" && paymentField) {
    paymentField.disabled = event.target.value !== "completed";
    if (paymentField.disabled) paymentField.value = "pending";
    form.querySelector("[data-payment-guidance]").textContent = paymentField.disabled
      ? "Chỉ ghi nhận thu tiền khi hoàn tất giao hàng."
      : "Chọn Đã thanh toán sau khi đã thu đủ tiền của khách.";
  }

}
async function startOrderReturn(id){const order=state.orders.find(o=>o.id===id);if(!can('orders.write')||!order||!['shipped','completed'].includes(order.status))return;closeOrderProcessing();try{await window.GAERUAfterSales.createReturn(order);}catch(error){showGlobal(error.message,true);}}
function closeOrderProcessing(){const dialog=document.getElementById('order-processing-dialog');if(!dialog)return;if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');dialog.remove();}
function openOrderProcessing(id,opener){
 const order=state.orders.find(o=>o.id===id),body=document.getElementById('order-body-'+id);if(!order||!body)return;
 closeOrderProcessing();const dialog=document.createElement('dialog');dialog.id='order-processing-dialog';dialog.className='order-processing-dialog';dialog.setAttribute('aria-labelledby','order-processing-title');
 const steps=['pending','confirmed','processing','shipped','completed'],current=steps.indexOf(order.status);
 dialog.innerHTML='<header><div><p>Xử lý đơn hàng</p><h2 id="order-processing-title">'+escapeHtml(order.orderNumber)+'</h2></div><button type="button" class="secondary-button" data-close-order aria-label="Đóng xử lý đơn">×</button></header><ol class="order-process-steps">'+steps.map((key,index)=>'<li class="'+(index===current?'current':index<current?'done':'')+'">'+escapeHtml(labels[key])+'</li>').join('')+'</ol><div class="order-processing-content">'+body.innerHTML+'</div>';
 if(can('orders.write')&&order.status==='completed'){const action=document.createElement('div');action.className='order-return-action';action.innerHTML='<button class="secondary-button" type="button" data-return-order="'+escapeHtml(order.id)+'">Ghi nhận hoàn trả hàng</button>';dialog.querySelector('.order-processing-content').prepend(action);}
 dialog.addEventListener('click',event=>{const button=event.target.closest('[data-return-order]');if(button)startOrderReturn(button.dataset.returnOrder);});
 const statusSelect=dialog.querySelector('select[name="status"]');
 if(statusSelect){
  const choices=document.createElement('fieldset');choices.className='order-status-buttons';choices.innerHTML='<legend>Bước tiếp theo</legend>'+[...statusSelect.options].filter(option=>option.value!==order.status).map(option=>'<button type="button" class="secondary-button" data-status-choice="'+escapeHtml(option.value)+'" aria-pressed="'+(option.value===statusSelect.value)+'" '+(statusSelect.disabled?'disabled':'')+'>'+escapeHtml(option.textContent)+'</button>').join('');
  choices.hidden=choices.querySelectorAll('button').length===0;
  statusSelect.closest('label').hidden=true;statusSelect.closest('label').after(choices);
  choices.addEventListener('click',event=>{const button=event.target.closest('[data-status-choice]');if(!button||statusSelect.closest('form').dataset.saving)return;statusSelect.value=button.dataset.statusChoice;statusSelect.dispatchEvent(new Event('change',{bubbles:true}));choices.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));});
 }
 dialog.addEventListener('submit',updateOrder);dialog.addEventListener('change',changeOrderControl);dialog.querySelector('[data-close-order]').addEventListener('click',closeOrderProcessing);dialog.addEventListener('close',()=>{dialog.remove();opener?.isConnected&&opener.focus();});document.body.append(dialog);if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
}
function openBulkProcessing(){
 const orders=state.orders.filter(o=>state.selectedOrders.has(o.id));if(!orders.length)return;
 document.getElementById('order-bulk-dialog')?.remove();const dialog=document.createElement('dialog');dialog.id='order-bulk-dialog';dialog.className='order-processing-dialog';
 dialog.innerHTML='<header><h2>Xử lý '+orders.length+' đơn đã chọn</h2><button type="button" data-close-bulk class="secondary-button" aria-label="Đóng">×</button></header><form class="bulk-process-form"><label>Bước xử lý<select name="action"><option value="confirm">Xác nhận đơn → Đã xác nhận</option><option value="prepare">Chuẩn bị hàng → Cần gửi</option><option value="ship">Xác nhận bàn giao → Đang giao</option><option value="complete">Hoàn tất giao hàng → Hoàn tất</option><option value="cancel">Hủy đơn chưa giao → Đã hủy</option></select></label><p data-bulk-hint></p><label data-bulk-money hidden><input type="checkbox" name="confirmReceived"> Tôi xác nhận đã thu đủ số tiền còn lại của các đơn COD đã giao.</label><p>Toàn bộ đơn đã chọn phải đủ điều kiện cho cùng một bước. Nếu có đơn không hợp lệ, hệ thống giữ nguyên toàn bộ.</p><button type="submit" class="primary-button">Xác nhận xử lý</button><p role="alert"></p></form>';
 const form=dialog.querySelector('form'),hint=dialog.querySelector('[data-bulk-hint]');const refresh=()=>{const target={confirm:'confirmed',prepare:'processing',ship:'shipped',complete:'completed',cancel:'cancelled'}[form.elements.action.value];const eligible=orders.filter(o=>(orderTransitions[o.status]||[]).includes(target)&&(target!=='confirmed'||o.shippingFeeVnd!=null)&&(target!=='cancelled'||o.paymentStatus!=='paid'&&!(Number(o.receivedVnd)>0)&&!isLiveVnpayAttempt(o))&&(target!=='completed'||o.paymentStatus==='paid'||can('payments.write')&&!['vnpay','9pay'].includes(o.paymentMethod)));hint.textContent=eligible.length+'/'+orders.length+' đơn đủ điều kiện cho bước đã chọn.';dialog.querySelector('[data-bulk-money]').hidden=target!=='completed';form.elements.confirmReceived.required=target==='completed'&&orders.some(o=>o.paymentStatus!=='paid');form.elements.confirmReceived.checked=false;form.querySelector('[type=submit]').disabled=eligible.length!==orders.length;};
 const common=orders.every(o=>o.status===orders[0].status)?orders[0].status:null;const next={pending:'confirm',confirmed:'prepare',processing:'ship',shipped:'complete'}[common];if(next)form.elements.action.value=next;form.elements.action.addEventListener('change',refresh);dialog.querySelector('[data-close-bulk]').addEventListener('click',()=>{if(typeof dialog.close==='function')dialog.close();dialog.remove();});dialog.addEventListener('close',()=>dialog.remove());
 form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('[type=submit]'),feedback=form.querySelector('[role=alert]');if(button.disabled)return;button.disabled=true;feedback.textContent='Đang kiểm tra và xử lý…';let saved=false;try{const result=await request('/api/gaeru_ceo/orders/bulk',{method:'POST',body:JSON.stringify({action:form.elements.action.value,confirmReceived:form.elements.confirmReceived.checked,orders:orders.map(o=>({id:o.id,expectedStatus:o.status,expectedPaymentStatus:o.paymentStatus,expectedTotalVnd:o.totalVnd}))})});saved=true;if(typeof dialog.close==='function')dialog.close();dialog.remove();document.querySelector('#order-filter').value=result.targetStatus;await Promise.all([loadOrders(1),loadSummary()]);showGlobal(result.message);}catch(error){if(saved)showGlobal('Đã lưu trạng thái nhưng chưa tải lại được danh sách. Nhấn Tải lại.',true);else feedback.textContent=error.message;button.disabled=false;}});
 document.body.append(dialog);refresh();if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
}

function renderOrders() {
  const root = document.querySelector("#order-list");
  const pagination = document.querySelector("#order-pagination");
  pagination.hidden = state.orderPagination.pageCount <= 1;
  document.querySelector("#previous-orders").disabled = state.orderPagination.page <= 1;
  document.querySelector("#next-orders").disabled = state.orderPagination.page >= state.orderPagination.pageCount;
  document.querySelector("#order-page-label").textContent =
    `${state.orderPagination.total} đơn · Trang ${state.orderPagination.page} / ${Math.max(1, state.orderPagination.pageCount)}`;
  document.querySelector("#order-list-status").textContent = `${state.orderPagination.total} đơn hàng${state.orderPagination.pageCount > 1 ? ` · Trang ${state.orderPagination.page} / ${state.orderPagination.pageCount}` : ""}`;
  if (!state.orders.length) {
    root.innerHTML = '<div class="empty-message"><strong>Không có đơn hàng phù hợp.</strong><p>Thử tìm theo mã đơn, tên, email, số điện thoại hoặc xóa bộ lọc.</p></div>';
    updateOrderSelection();
    return;
  }
  root.innerHTML = state.orders.map((order) => {
    const orderDate = new Date(order.createdAt).toLocaleString("vi-VN");
    const allowed = can("orders.write") ? (orderTransitions[order.status] || []).filter((status) => (status !== "cancelled" || (order.paymentStatus !== "paid" && !(Number(order.receivedVnd) > 0) && !isLiveVnpayAttempt(order)))
      && (status !== "completed" || order.paymentStatus === "paid" || (can("payments.write") && !["vnpay", "9pay"].includes(order.paymentMethod)))) : [];
    const optionMarkup = [order.status, ...allowed].map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(labels[key] || key)}</option>`).join("");
    const paymentStatus = order.paymentStatus === "paid" ? "Đã thanh toán" : Number(order.receivedVnd) > 0 ? "Đã thu một phần" : "Chưa thanh toán";
    const paymentNote = order.paymentProvider === "vnpay" ? (order.paymentAttemptStatus === "pending" && !isLiveVnpayAttempt(order) ? "Phiên thanh toán VNPAY đã hết hạn; kiểm tra đối soát trước khi xử lý đơn." : paymentAttemptLabels[order.paymentAttemptStatus]) : "";
    const latePaymentWarning = order.status === "cancelled" && order.paymentStatus === "paid"
      ? "Đơn đã hủy nhưng đã nhận tiền; cần đối soát/hoàn tiền thủ công trong merchant portal."
      : "";
    const phone = String(order.phone || "").replace(/[^+0-9]/g, "");
    const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
    const lockNote = order.paymentStatus === "paid" ? "Phí giao hàng và thanh toán đã được chốt. Đơn đã thanh toán cần xử lý hoàn tiền trước khi hủy."
      : Number(order.receivedVnd) > 0 ? "Đơn đã thu một phần tiền. Không thể thay đổi phí giao hàng hoặc hủy đơn khi chưa xử lý khoản tiền đã thu."
      : isLiveVnpayAttempt(order) ? "Phiên VNPAY đang chờ xác nhận. Chỉ có thể hủy sau khi phiên thanh toán hết hạn."
        : "";
    return `<article class="order-card" data-order-detail="${escapeHtml(order.id)}">
      <div class="order-card-summary order-table-row"><label class="order-select-cell"><input type="checkbox" data-select-order="${escapeHtml(order.id)}" aria-label="Chọn đơn ${escapeHtml(order.orderNumber)}" ${state.selectedOrders.has(order.id) ? "checked" : ""}></label><span class="order-cell"><strong>${escapeHtml(order.orderNumber)}</strong><small>${escapeHtml(orderDate)}</small></span><span class="order-cell"><strong>${escapeHtml(order.customerName)}</strong><small>${escapeHtml(order.phone)}</small></span><span class="order-cell"><strong>${itemCount} sản phẩm</strong><small>${escapeHtml(order.items.map(i => i.productName + ' · ' + i.variantName).join(', '))}</small></span><span class="order-cell"><span class="status-pill status-${escapeHtml(order.status)}">${escapeHtml(labels[order.status] || order.status)}</span></span><span class="order-cell"><strong title="${escapeHtml(labels[order.paymentMethod] || order.paymentMethod)}">${escapeHtml(order.paymentMethod==="cod"?"COD":labels[order.paymentMethod] || order.paymentMethod)}</strong><small>${paymentStatus}</small>${order.shippingCarrierName ? `<small>Vận chuyển: ${escapeHtml(order.shippingCarrierName)}</small>` : ""}</span><span class="order-cell order-amount"><strong>${order.totalVnd == null ? "Chưa chốt tổng" : formatPrice(order.totalVnd)}</strong></span><span class="order-cell order-action-cell"><button type="button" class="secondary-button order-process-button" data-process-order="${escapeHtml(order.id)}" aria-haspopup="dialog" aria-controls="order-processing-dialog">Xử lý</button>${can("orders.write") && order.status==="completed" ? `<button type="button" class="secondary-button order-return-button" data-return-order="${escapeHtml(order.id)}">Hoàn trả</button>` : ""}</span></div>
      <div class="order-card-body" id="order-body-${escapeHtml(order.id)}" hidden>
      <div class="order-meta">
        <p><strong>${escapeHtml(order.customerName)}</strong><br><a href="tel:${escapeHtml(phone)}">${escapeHtml(order.phone)}</a><br><a href="mailto:${escapeHtml(order.email)}">${escapeHtml(order.email)}</a></p>
        <p>${escapeHtml(order.address)}, ${escapeHtml(order.city)}${order.note ? `<br>Ghi chú: ${escapeHtml(order.note)}` : ""}</p>
      </div>
      <div class="order-lines">${order.items.map((item) => `<div class="order-line"><span>${escapeHtml(item.productName)} · ${escapeHtml(item.variantName)} × ${item.quantity}<small>SKU ${escapeHtml(item.sku || "—")}</small></span><strong>${formatPrice(item.lineTotalVnd)}</strong></div>`).join("")}</div>
      <dl class="order-totals">${order.discountVnd?`<div><dt>Voucher ${escapeHtml(order.voucherCode)}</dt><dd>−${formatPrice(order.discountVnd)}</dd></div>`:""}<div><dt>Tạm tính</dt><dd>${formatPrice(order.subtotalVnd)}</dd></div><div><dt>Phí giao hàng</dt><dd>${order.shippingFeeVnd == null ? "Chưa chốt" : formatPrice(order.shippingFeeVnd)}</dd></div>${Number(order.receivedVnd) > 0 ? `<div><dt>Đã thu</dt><dd>${formatPrice(order.receivedVnd)}</dd></div><div><dt>Còn phải thu</dt><dd>${formatPrice(order.outstandingVnd ?? Math.max(0, order.totalVnd - order.receivedVnd))}</dd></div>` : ""}<div><dt>Tổng cộng</dt><dd>${order.totalVnd == null ? "Chưa chốt tổng" : formatPrice(order.totalVnd)}</dd></div></dl>
      ${paymentNote ? `<p class="help-text">${escapeHtml(paymentNote)}</p>` : ""}
      ${latePaymentWarning ? `<p class="feedback">${escapeHtml(latePaymentWarning)}</p>` : ""}
      ${lockNote ? `<p class="editor-guidance">${lockNote}</p>` : ""}
      <form class="order-controls" data-order-form="${escapeHtml(order.id)}">
        <label>Trạng thái đơn<select name="status" ${allowed.length ? "" : "disabled"}>${optionMarkup}</select></label>
        <label>Phí giao hàng (₫)<input name="shippingFeeVnd" type="number" min="0" max="1000000000" step="1" inputmode="numeric" value="${order.shippingFeeVnd ?? ""}" placeholder="Nhập để chốt tổng" ${canEditShipping(order) ? "" : "disabled"}></label>
        ${orderPaymentControl(order)}
        <button class="primary-button" type="submit" ${!allowed.length && !canEditShipping(order) && (!orderPaymentControl(order).includes('name="paymentStatus"')) ? "disabled" : ""}>Lưu cập nhật</button>
        <p class="feedback order-feedback" role="alert"></p>
      </form>
      </div></article>`;
  }).join("");
  updateOrderSelection();
}

async function updateOrder(event) {
  event.preventDefault();
  const form = event.target.closest("[data-order-form]");
  if (!form) return;
  const submitButton = form.querySelector('button[type="submit"]');
  if (form.dataset.saving) return;
  const order = state.orders.find((entry) => entry.id === form.dataset.orderForm);
  if (!order) return;
  if (form.elements.status.value === "cancelled" && order.status !== "cancelled"
    && !window.confirm(`Hủy đơn ${order.orderNumber}? Số lượng sản phẩm trong đơn sẽ được hoàn lại vào tồn kho. Đơn đã hủy không thể mở lại.`)) return;
  const feedback = form.querySelector('[role="alert"]');
  submitButton.disabled = true;
  form.dataset.saving = "true";
  submitButton.textContent = "Đang cập nhật…";
  feedback.textContent = "";
  const payload = {};
  const targetStatus = form.elements.status.value;
  let saved=false;
  if (targetStatus !== order.status) payload.status = targetStatus;
  const paymentField = form.elements.paymentStatus;
  if (paymentField && !paymentField.disabled && paymentField.value !== order.paymentStatus) payload.paymentStatus = paymentField.value;
  if (!form.elements.shippingFeeVnd.disabled && form.elements.shippingFeeVnd.value !== "" && Number(form.elements.shippingFeeVnd.value) !== order.shippingFeeVnd) payload.shippingFeeVnd = Number(form.elements.shippingFeeVnd.value);
  try {
    if (!Object.keys(payload).length) throw new Error("Chưa có thay đổi để lưu.");
    if (targetStatus === "completed" && (payload.paymentStatus || order.paymentStatus) !== "paid") throw new Error("Xác nhận đã thu đủ tiền trước khi hoàn tất đơn hàng.");
    await request(`/api/gaeru_ceo/orders/${encodeURIComponent(form.dataset.orderForm)}`, { method: "PATCH", body: JSON.stringify(payload) });
    saved=true;closeOrderProcessing();
    if(targetStatus!==order.status)document.querySelector("#order-filter").value=targetStatus;
    await Promise.all([loadOrders(1), loadSummary()]);
    showGlobal("Đã cập nhật đơn hàng.");
  } catch (error) {
    if(saved)showGlobal("Đã lưu đơn hàng nhưng chưa tải lại được danh sách. Nhấn Tải lại.",true);else feedback.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    delete form.dataset.saving;
    submitButton.textContent = "Lưu cập nhật";
  }
}

async function loadCustomers(page = state.customerPage) {
  if (!can("customers.read")) return;
  const search = document.querySelector("#customer-search").value.trim();
  const params = new URLSearchParams({ page: String(page) });
  if (search) params.set("q", search);
  const result = await request(`/api/gaeru_ceo/customers?${params}`);
  state.customers = result.customers;
  state.customerPage = result.pagination.page;
  state.customerPagination = result.pagination;
  renderCustomers();
}

function renderCustomers() {
  const root = document.querySelector("#customer-list");
  const pagination = document.querySelector("#customer-pagination");
  if (!state.customers.length) {
    root.innerHTML = '<p class="empty-message">Chưa có khách hàng phù hợp.</p>';
    pagination.hidden = true;
    return;
  }
  root.innerHTML = state.customers.map((customer) => `
    <article class="customer-card">
      <div class="customer-card-header">
        <div><h3>${escapeHtml(customer.fullName)}</h3><p>${escapeHtml(customer.email)} · ${escapeHtml(customer.phone)}</p></div>
        <span class="status-pill ${customer.active ? "status-active" : "status-cancelled"}">${customer.deletedAt ? (customer.deletionRecoverable?"Chờ xóa tài khoản":"Đã xóa hồ sơ") : customer.active ? "Đang hoạt động" : "Đã khóa"}</span>
      </div>
      <div class="customer-meta"><span>${customer.emailVerified ? "Đã xác minh email" : "Chưa xác minh email"}</span><span>${customer.orderCount} đơn hàng</span><span>Tham gia ${new Date(customer.createdAt).toLocaleDateString("vi-VN")}</span></div>
      <div class="customer-actions"><button class="secondary-button" type="button" data-customer-detail="${escapeHtml(customer.id)}">Xem đơn hàng</button>${can("customers.write") && !customer.deletedAt ? `<button class="${customer.active ? "plain-button" : "primary-button"}" type="button" data-customer-toggle="${escapeHtml(customer.id)}" data-active="${customer.active}">${customer.active ? "Khóa tài khoản" : "Mở khóa tài khoản"}</button>` : ""}</div>
      ${!customer.deletedAt&&can('customers.write')?`<details class="customer-restore"><summary>Xử lý yêu cầu xóa tài khoản</summary><form data-customer-delete="${escapeHtml(customer.id)}"><p>Chỉ thực hiện sau khi khách liên hệ và đã đối chiếu thông tin. Hệ thống gửi email xác nhận; tài khoản chỉ ngừng hoạt động sau khi khách xác nhận.</p><label>Lý do xóa<textarea name="reason" required minlength="10" maxlength="500" rows="2"></textarea></label><label class="deletion-consent"><input type="checkbox" name="confirmed" required> Đã đối chiếu yêu cầu xóa của khách</label><button class="secondary-button">Gửi email xác nhận xóa</button><p role="status"></p></form></details>`:''}
      ${customer.deletedAt&&customer.deletionRecoverable&&customer.canRestore&&can('customers.write')?`<details class="customer-restore"><summary>Khôi phục tài khoản</summary><form data-customer-restore="${escapeHtml(customer.id)}"><p>Ngày xác nhận xóa: ${new Date(customer.deletedAt).toLocaleDateString('vi-VN')}. Khôi phục giữ nguyên mật khẩu và xác thực hai yếu tố.</p><label>Lý do khôi phục<textarea name="reason" required minlength="10" maxlength="500" rows="2"></textarea></label><button class="secondary-button">Xác nhận khôi phục</button><p role="status"></p></form></details>`:''}
      <div class="customer-detail" data-customer-detail-panel="${escapeHtml(customer.id)}" hidden></div>
    </article>`).join("");
  pagination.hidden = state.customerPagination.pageCount <= 1;
  document.querySelector("#customer-page-label").textContent = `Trang ${state.customerPage}/${state.customerPagination.pageCount} · ${state.customerPagination.total} khách hàng`;
  document.querySelector("#previous-customers").disabled = state.customerPage <= 1;
  document.querySelector("#next-customers").disabled = state.customerPage >= state.customerPagination.pageCount;
}

async function showCustomerDetail(id, panel) {
  panel.hidden = false;
  panel.textContent = "Đang tải lịch sử đơn hàng…";
  const result = await request(`/api/gaeru_ceo/customers/${encodeURIComponent(id)}`);
  if (!result.orders.length) {
    panel.innerHTML = '<p class="help-text">Khách hàng chưa có đơn hàng.</p>';
    return;
  }
  panel.innerHTML = result.orders.map((order) => `<div class="customer-order-row"><strong>${escapeHtml(order.orderNumber)}</strong><span>${escapeHtml(labels[order.status] || order.status)}</span><span>${formatPrice(order.totalVnd || 0)}</span></div>`).join("");
}

async function toggleCustomer(id, active) {
  await request(`/api/gaeru_ceo/customers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ active: !active }) });
  await loadCustomers();
  showGlobal(!active ? "Đã mở khóa tài khoản khách hàng." : "Đã khóa tài khoản khách hàng.");
}

document.querySelector('#settings-form').addEventListener('invalid',()=>{const details=document.querySelector('#settings-form').closest('details');if(details)details.open=true;},true);
async function loadSettings() {
  if (!can("settings.read")) return;
  const settings = await request("/api/gaeru_ceo/settings");
  const form = document.querySelector("#settings-form");
  form.elements.shippingNote.value = settings.shipping_note || "";
  document.querySelector("#payment-provider-status").textContent =
    `Đang khả dụng: ${settings.paymentMethods.map((method) => method === "cod" ? "COD" : method.toUpperCase()).join(", ")}. 9Pay chưa được cấu hình.`;
  renderShippingRates(settings.shipping_rates || {});
  if(window.GAERUConfiguration)await window.GAERUConfiguration.load();
  applyPermissions();
}

function renderShippingRates(rates) {
  const root = document.querySelector("#shipping-rate-list");
  const entries = Object.entries(rates).sort(([left], [right]) => left.localeCompare(right, "vi"));
  root.innerHTML = entries.length ? entries.map(([province, fee]) => `
    <div class="shipping-rate-row">
      <label>Tỉnh/thành phố<input data-shipping-province required maxlength="120" value="${escapeHtml(province)}"></label>
      <label>Phí giao hàng (₫)<input data-shipping-fee type="number" required min="0" max="1000000000" step="1" value="${fee}"></label>
      <button class="plain-button" type="button" data-remove-shipping-rate>Xóa tỉnh/thành</button>
    </div>`).join("") : '<p class="shipping-rate-empty">Chưa có bảng phí. Thêm các tỉnh/thành phố GAERU đang giao hàng.</p>';
}

async function saveSettings(event) {
  event.preventDefault();
  if (!can("settings.write")) return;
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Đang lưu…";
  setFeedback(form, "");
  try {
    const shippingRates = {};
    for (const row of document.querySelectorAll(".shipping-rate-row")) {
      const province = row.querySelector("[data-shipping-province]").value.trim();
      const fee = Number(row.querySelector("[data-shipping-fee]").value);
      const normalizedProvince = province.normalize("NFC").toLocaleLowerCase("vi");
      if (!province || Object.keys(shippingRates).some((name) =>
        name.normalize("NFC").toLocaleLowerCase("vi") === normalizedProvince
      )) {
        throw new Error("Tên tỉnh/thành phố không được để trống hoặc trùng lặp.");
      }
      if (!Number.isSafeInteger(fee) || fee < 0 || fee > 1_000_000_000) {
        throw new Error(`Phí giao hàng của ${province} chưa hợp lệ.`);
      }
      shippingRates[province] = fee;
    }
    await request("/api/gaeru_ceo/settings", {
      method: "PUT",
      body: JSON.stringify({
        shippingNote: form.elements.shippingNote.value,
        shippingRates
      })
    });
    showGlobal("Đã lưu cài đặt cửa hàng.");
  } catch (error) {
    setFeedback(form, error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Lưu cài đặt";
  }
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = document.querySelector("#login-feedback");
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  feedback.textContent = "";
  try {
    let result = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value })
    });
    state.csrfToken = result.csrfToken;
    if(result.mfaRequired)result=await window.GAERUSecurity.loginChallenge(result);
    state.csrfToken=result.csrfToken;
    form.reset();
    await showAdmin(result);
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await request("/api/auth/logout", { method: "POST", body: "{}" });
    location.reload();
  } catch (error) {
    showGlobal(error.message, true);
  }
});

async function activateView(view, { updateHistory = true } = {}) {
  const button = [...document.querySelectorAll('[data-view]')].find(item => item.dataset.view === view);
  if (!button || button.hidden || (!can(button.dataset.permission)&&!(view==='security'&&state.session?.mfaEnrollmentRequired))) return;
  const requestId = ++state.viewRequest;
  if (updateHistory && location.hash !== '#' + view) history.pushState(null, '', '#' + view);
  showGlobal('');
  const panel = document.getElementById(view + '-view');
  const loading = document.getElementById('admin-view-state');
  panel?.setAttribute('aria-busy', 'true');
  if (loading) loading.textContent = 'Đang tải dữ liệu…';
  document.querySelectorAll("[data-view]").forEach((item) => item.classList.toggle("is-active", item === button));
  document.querySelectorAll(".view-panel").forEach((panel) => { panel.hidden = panel.id !== `${button.dataset.view}-view`; });
  document.querySelector("#view-title").textContent = window.GAERUAdminUI.title(view);
  document.querySelector("#view-description").textContent = window.GAERUAdminUI.description(view);
  document.querySelectorAll("[data-view]").forEach((item) => item.setAttribute("aria-current", item === button ? "page" : "false"));
  document.querySelector(".sidebar").classList.remove("navigation-open");
  document.querySelector(".sidebar-toggle").setAttribute("aria-expanded", "false");
  try {
    if (button.dataset.view === "products") await loadProducts(document.querySelector("#product-search").value.trim());
    if (button.dataset.view === "orders") await loadOrders();
    if (view === "shipping") await window.GAERUConfiguration.mountShipping();
    if (button.dataset.view === "customers") await loadCustomers();
    if (button.dataset.view === "settings") await loadSettings();
    if (button.dataset.view === "overview") await loadSummary();
    if (view === "notifications" && window.GAERUNotifications) await window.GAERUNotifications.load();
    if (view === "security" && window.GAERUSecurity) await window.GAERUSecurity.render(document.querySelector("#security-view"));
    if (view === "marketing" && window.GAERUMarketing) await window.GAERUMarketing.load();
    if (view === "pages") await window.GAERUPages.load();
    if (view === "news" && window.GAERUNewsAdmin) await window.GAERUNewsAdmin.load();
    if (view === "shopping-chat" && window.GAERUShoppingChat) await window.GAERUShoppingChat.load();
    if (view === "care" && window.GAERUCare) await window.GAERUCare.load();
    if (view === "owner" && window.GAERUOwner) await window.GAERUOwner.load();
    if (view === "warranty" && window.GAERUWarranty) await window.GAERUWarranty.load();
    if (["payroll","tax","invoice","marketplace"].includes(view) && window.GAERUBusiness) await window.GAERUBusiness.load(view);
    if (window.GAERUEnterprise) await window.GAERUEnterprise.loadView(view);
  } catch (error) {
    if (requestId === state.viewRequest) showGlobal(error.message, true);
  } finally {
    panel?.setAttribute("aria-busy", "false");
    if (requestId === state.viewRequest && loading) loading.textContent = "";
  }
}
window.addEventListener("hashchange", () => {
  if (!state.session) return;
  try { activateView(decodeURIComponent(location.hash.slice(1)), { updateHistory: false }); } catch {}
});
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)));
document.querySelectorAll("[data-shortcut]").forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.shortcut === "stock") {
    activateView("inventory");
  } else {
    document.querySelector("#order-search").value = "";
    document.querySelector("#order-filter").value = button.dataset.shortcut === "pending" ? "pending" : "";
    document.querySelector("#order-payment-filter").value = button.dataset.shortcut === "unpaid" ? "pending" : "";
    document.querySelector("#order-method-filter").value = "";
    state.orderPage = 1;
    activateView("orders");
  }
}));

document.querySelector("#product-search").addEventListener("input", async (event) => {
  window.clearTimeout(state.productSearchTimer);
  const searchValue = event.currentTarget.value;
  state.productSearchTimer = window.setTimeout(() => {
    if (searchValue !== document.querySelector("#product-search").value) return;
    loadProducts(searchValue.trim()).catch((error) => showGlobal(error.message, true));
  }, 180);
});
document.querySelector("#new-product-button").addEventListener("click", () => { if (can("catalog.write")) location.href="/gaeru_ceo/products/new"; });
document.querySelectorAll(".product-filters select").forEach((select) => select.addEventListener("change", renderProducts));
document.querySelector("#reset-product-filters").addEventListener("click", () => {
  document.querySelector("#product-search").value = "";
  document.querySelectorAll(".product-filters select").forEach((select) => { select.value = select.id === "order-sort" ? "newest" : select.id === "order-page-size" ? "25" : ""; });
  loadProducts().catch((error) => showGlobal(error.message, true));
});
document.querySelectorAll('[data-product-scope]').forEach(button=>button.addEventListener('click',async()=>{
  state.productScope=button.dataset.productScope;const address=new URL(location.href);if(state.productScope==='trash')address.searchParams.set('productScope','trash');else address.searchParams.delete('productScope');history.replaceState(null,'',address.pathname+address.search+address.hash);
  document.querySelectorAll('[data-product-scope]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
  document.querySelector('#product-status-filter').value='';document.querySelector('#product-stock-filter').value='';
  document.querySelector('#product-trash-note').hidden=state.productScope!=='trash';
  try{await loadProducts(document.querySelector('#product-search').value.trim());}catch(e){showGlobal(e.message,true);}
}));
document.querySelector("#product-list").addEventListener("click", async (event) => {
  const recover=event.target.closest('[data-restore-product],[data-activate-product],[data-purge-product]');
  if(recover){
    const product=state.products.find(p=>p.id===(recover.dataset.restoreProduct||recover.dataset.activateProduct||recover.dataset.purgeProduct));
    if(!product||!can('catalog.write')||recover.disabled)return;
    const purge=Boolean(recover.dataset.purgeProduct),activate=Boolean(recover.dataset.activateProduct);
    if(!await confirmProductAction(product,{permanent:purge,message:purge?'Xóa vĩnh viễn sản phẩm này? Không thể khôi phục. Sản phẩm còn tồn hoặc có chứng từ sẽ được giữ lại.':activate?'Khôi phục sản phẩm và các biến thể đã chọn để hiển thị trên cửa hàng?':'Khôi phục sản phẩm về bản nháp để tiếp tục chỉnh sửa?'}))return;
    recover.disabled=true;
    try{await request('/api/gaeru_ceo/products/'+encodeURIComponent(product.id)+(purge?'/permanent':'/restore'),{method:purge?'DELETE':'POST',body:JSON.stringify(purge?{version:product.version,confirmation:product.slug}:{version:product.version,activate})});await Promise.all([loadProducts(document.querySelector('#product-search').value.trim()),loadSummary()]);showGlobal(purge?'Đã xóa vĩnh viễn sản phẩm.':activate?'Đã khôi phục và kích hoạt sản phẩm.':'Đã khôi phục về bản nháp.');}
    catch(error){showGlobal(error.message,true);recover.disabled=false;}return;
  }
  const remove=event.target.closest('[data-delete-product]');
  if(remove){
    const product=state.products.find(item=>item.id===remove.dataset.deleteProduct);
    if(!product||!can('catalog.write')||remove.disabled)return;
    if(!await confirmProductAction(product,{message:'Chuyển sản phẩm vào khu vực đã xóa? Lịch sử đơn hàng và tồn kho được giữ lại.'}))return;
    remove.disabled=true;
    try{
      await request('/api/gaeru_ceo/products/'+encodeURIComponent(product.id),{method:'DELETE',body:JSON.stringify({version:product.version,confirmation:'DELETE_PRODUCT'})});
      if(state.currentProduct?.id===product.id){state.currentProduct=null;document.querySelector('#product-editor').hidden=true;}
      await Promise.all([loadProducts(document.querySelector('#product-search').value.trim()),loadSummary()]);
      showGlobal('Đã xóa sản phẩm khỏi danh mục. Lịch sử đơn hàng và kho được giữ lại.');
    }catch(error){showGlobal(error.message,true);remove.disabled=false;}
    return;
  }
  const button = event.target.closest("[data-edit-product]");
  if (button) location.href="/gaeru_ceo/products/"+encodeURIComponent(button.dataset.editProduct)+"/edit"+(state.productScope==='trash'?'?trash=1':'');
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
document.querySelectorAll(".order-filters select").forEach((select) => select.addEventListener("change", () => {
  state.orderPage = 1;
  loadOrders(1).catch((error) => showGlobal(error.message, true));
}));
document.querySelector("#reset-order-filters").addEventListener("click", () => {
  document.querySelector("#order-search").value = "";
  document.querySelector("#order-filter").value = "";
  document.querySelectorAll(".order-filters select").forEach((select) => { select.value = select.id === "order-sort" ? "newest" : select.id === "order-page-size" ? "25" : ""; });
  state.orderPage = 1;
  loadOrders(1).catch((error) => showGlobal(error.message, true));
});
document.querySelector("#order-search").addEventListener("input", (event) => {
  window.clearTimeout(state.orderSearchTimer);
  const searchValue = event.currentTarget.value;
  state.orderSearchTimer = window.setTimeout(() => {
    if (searchValue !== document.querySelector("#order-search").value) return;
    state.orderPage = 1;
    loadOrders(1).catch((error) => showGlobal(error.message, true));
  }, 200);
});
document.querySelector("#refresh-orders").addEventListener("click", () => loadOrders().catch((error) => showGlobal(error.message, true)));
document.querySelector("#previous-orders").addEventListener("click", () => {
  if (state.orderPage > 1) loadOrders(state.orderPage - 1).catch((error) => showGlobal(error.message, true));
});
document.querySelector("#next-orders").addEventListener("click", () => {
  if (state.orderPage < state.orderPagination.pageCount) loadOrders(state.orderPage + 1).catch((error) => showGlobal(error.message, true));
});
document.querySelector("#order-list").addEventListener("submit", updateOrder);
document.querySelector("#order-list").addEventListener("click",event=>{const back=event.target.closest('[data-return-order]');if(back){startOrderReturn(back.dataset.returnOrder);return;}const button=event.target.closest('[data-process-order]');if(button)openOrderProcessing(button.dataset.processOrder,button);});

document.querySelector("#order-list").addEventListener("change", changeOrderControl);
document.querySelector("#customer-search").addEventListener("input", (event) => {
  window.clearTimeout(state.customerSearchTimer);
  const value = event.currentTarget.value;
  state.customerSearchTimer = window.setTimeout(() => {
    if (value !== document.querySelector("#customer-search").value) return;
    state.customerPage = 1;
    loadCustomers(1).catch((error) => showGlobal(error.message, true));
  }, 200);
});
document.querySelector("#refresh-customers").addEventListener("click", () => loadCustomers().catch((error) => showGlobal(error.message, true)));
document.querySelector("#previous-customers").addEventListener("click", () => {
  if (state.customerPage > 1) loadCustomers(state.customerPage - 1).catch((error) => showGlobal(error.message, true));
});
document.querySelector("#next-customers").addEventListener("click", () => {
  if (state.customerPage < state.customerPagination.pageCount) loadCustomers(state.customerPage + 1).catch((error) => showGlobal(error.message, true));
});
document.querySelector("#customer-list").addEventListener("click", async (event) => {
  const detailButton = event.target.closest("[data-customer-detail]");
  const toggleButton = event.target.closest("[data-customer-toggle]");
  try {
    if (detailButton) {
      const panel = document.querySelector(`[data-customer-detail-panel="${CSS.escape(detailButton.dataset.customerDetail)}"]`);
      await showCustomerDetail(detailButton.dataset.customerDetail, panel);
    }
    if (toggleButton) {
      const active = toggleButton.dataset.active === "true";
      if (active && !window.confirm("Khóa tài khoản này? Khách hàng sẽ không thể đăng nhập.")) return;
      await toggleCustomer(toggleButton.dataset.customerToggle, active);
    }
  } catch (error) {
    showGlobal(error.message, true);
  }
});
document.querySelector("#settings-form").addEventListener("submit", saveSettings);
document.querySelector("#add-shipping-rate").addEventListener("click", () => {
  const rates = Object.fromEntries([...document.querySelectorAll(".shipping-rate-row")].map((row, index) => [
    row.querySelector("[data-shipping-province]").value || `Tỉnh/thành ${index + 1}`,
    Number(row.querySelector("[data-shipping-fee]").value) || 0
  ]));
  rates[`Tỉnh/thành ${Object.keys(rates).length + 1}`] = 0;
  renderShippingRates(rates);
  const inputs = document.querySelectorAll("[data-shipping-province]");
  inputs[inputs.length - 1].focus();
});
document.querySelector("#shipping-rate-list").addEventListener("click", (event) => {
  if (!event.target.closest("[data-remove-shipping-rate]")) return;
  const row = event.target.closest(".shipping-rate-row");
  const rates = Object.fromEntries([...document.querySelectorAll(".shipping-rate-row")]
    .filter((item) => item !== row)
    .map((item) => [
      item.querySelector("[data-shipping-province]").value,
      Number(item.querySelector("[data-shipping-fee]").value) || 0
    ]));
  renderShippingRates(rates);
});

document.querySelector(".sidebar-toggle").addEventListener("click", (event) => {
  const open = document.querySelector(".sidebar").classList.toggle("navigation-open");
  event.currentTarget.setAttribute("aria-expanded", String(open));
});
function confirmProductAction(product,{permanent=false,message}={}){
 return new Promise(resolve=>{
  const previous=document.activeElement,dialog=document.createElement('dialog');dialog.className='enterprise-confirm-dialog';dialog.setAttribute('aria-labelledby','product-action-title');
  dialog.innerHTML='<h2 id="product-action-title">'+(permanent?'Xóa vĩnh viễn sản phẩm':'Xác nhận thao tác')+'</h2><p data-product-action-name></p><p data-product-action-message></p>'+(permanent?'<label>Nhập đường dẫn sản phẩm để xác nhận<input data-product-action-input autocomplete="off"></label><p data-product-action-slug></p>':'')+'<div class="enterprise-confirm-actions"><button type="button" data-product-action-cancel autofocus>Quay lại</button><button type="button" class="primary-button" data-product-action-accept '+(permanent?'disabled':'')+'>Xác nhận</button></div>';
  dialog.querySelector('[data-product-action-name]').textContent=product.name;
  dialog.querySelector('[data-product-action-message]').textContent=message;
  let done=false;function finish(value){if(done)return;done=true;dialog.close();dialog.remove();previous?.focus();resolve(value);}
  const accept=dialog.querySelector('[data-product-action-accept]');
  if(permanent){dialog.querySelector('[data-product-action-slug]').textContent=product.slug;dialog.querySelector('input').addEventListener('input',event=>{accept.disabled=event.target.value!==product.slug;});}
  accept.onclick=()=>{if(!permanent||dialog.querySelector('input').value===product.slug)finish(true);};
  dialog.querySelector('[data-product-action-cancel]').onclick=()=>finish(false);dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});dialog.addEventListener('close',()=>finish(false));document.body.append(dialog);dialog.showModal();
 });
}
window.GAERUAdmin = Object.freeze({ request, confirmProductAction, async refreshSession(){await showAdmin(await request('/api/auth/me'));}, setCsrf(value){state.csrfToken=value;}, can, showGlobal, activateView, get user() { return state.session; } });
initialize();

document.querySelector('#customer-list').addEventListener('submit',async e=>{if(!e.target.matches('[data-customer-restore]'))return;e.preventDefault();const form=e.target,button=form.querySelector('button');button.disabled=true;try{await request('/api/gaeru_ceo/customers/'+form.dataset.customerRestore+'/restore',{method:'POST',body:JSON.stringify({reason:form.elements.reason.value})});await loadCustomers();showGlobal('Đã khôi phục tài khoản.');}catch(error){form.querySelector('[role=status]').textContent=error.message;button.disabled=false;}});

document.querySelector('#customer-list').addEventListener('submit',async e=>{if(!e.target.matches('[data-customer-delete]'))return;e.preventDefault();const form=e.target,button=form.querySelector('button');if(!form.reportValidity())return;button.disabled=true;try{await request('/api/gaeru_ceo/customers/'+form.dataset.customerDelete+'/delete',{method:'POST',body:JSON.stringify({reason:form.elements.reason.value,confirmed:form.elements.confirmed.checked})});await loadCustomers();showGlobal('Đã gửi email xác nhận xóa; tài khoản vẫn hoạt động đến khi khách xác nhận.');}catch(error){form.querySelector('[role=status]').textContent=error.message;button.disabled=false;}});

function renderOrderOverview(counts) {
  const tabs = [['','Tất cả'],['pending','Chờ xác nhận'],['confirmed','Đã xác nhận'],['processing','Cần gửi'],['shipped','Đang giao'],['completed','Hoàn tất'],['cancelled','Đã hủy']];
  const total = Object.values(counts).reduce((sum,n)=>sum+Number(n),0);
  const afterSalesOpen = !document.querySelector('#after-sales-panel').hidden;
  document.querySelector('#order-tabs').innerHTML = tabs.map(([key,title])=>`<button type="button" data-order-tab="${key}" aria-pressed="${!afterSalesOpen && document.querySelector('#order-filter').value===key}">${title} <span>${key ? Number(counts[key]||0) : total}</span></button>`).join('') + `<button type="button" id="after-sales-toggle" aria-expanded="${afterSalesOpen}" aria-controls="after-sales-panel">Hủy / trả hàng</button>`;
}
document.querySelector('#orders-view').addEventListener('click',event=>{
  const tab=event.target.closest('[data-order-tab]'); if(!tab)return;
  window.GAERUAfterSales?.close();
  document.querySelector('#order-filter').value=tab.dataset.orderTab;
  loadOrders(1).catch(error=>showGlobal(error.message,true));
});
function updateOrderSelection() {
  const count = state.selectedOrders.size;
  document.querySelector('#selected-order-count').textContent = 'Đã chọn ' + count + ' đơn';
  const all = document.querySelector('#select-order-page');
  all.checked = Boolean(state.orders.length) && count === state.orders.length;
  all.indeterminate = count > 0 && count < state.orders.length;
  all.disabled = !state.orders.length;
  document.querySelectorAll('[data-print-orders],[data-bulk-process]').forEach(button => { button.disabled = count === 0 || button.hasAttribute('data-bulk-process')&&!can('orders.write'); });
}
document.querySelector('#select-order-page').addEventListener('change', event => {
  state.selectedOrders = new Set(event.target.checked ? state.orders.map(order => order.id) : []);
  document.querySelectorAll('[data-select-order]').forEach(input => { input.checked = event.target.checked; });
  updateOrderSelection();
});
document.querySelector('#order-list').addEventListener('change', event => {
  const input=event.target.closest('[data-select-order]'); if(!input)return;
  if(input.checked)state.selectedOrders.add(input.dataset.selectOrder);else state.selectedOrders.delete(input.dataset.selectOrder);
  updateOrderSelection();
});
document.querySelector('#order-bulk-actions').addEventListener('click',async event=>{
  const button=event.target.closest('[data-print-orders]');if(!button||!state.selectedOrders.size)return;
  const ids=state.orders.filter(order=>state.selectedOrders.has(order.id)).map(order=>order.id);
  if(!ids.length)return;
  const printWindow=window.open('', '_blank');
  if(!printWindow)return showGlobal('Cho phép mở cửa sổ mới để xem và in đơn hàng.',true);
  printWindow.opener=null;
  printWindow.document.title='Chuẩn bị bản in GAERU';
  printWindow.document.body.textContent='Đang chuẩn bị bản in…';
  button.disabled=true;
  try{
    const csrf=await request('/api/csrf');state.csrfToken=csrf.csrfToken;
    const response=await fetch('/api/gaeru_ceo/orders/print',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrfToken},body:JSON.stringify({ids,format:button.dataset.printOrders})});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw Error(data.error||'Không thể chuẩn bị bản in. Tải lại danh sách và thử lại.');}
    const html=await response.text();
    if(printWindow.closed)throw Error('Cửa sổ in đã đóng. Chọn In đơn hoặc In tem để mở lại.');
    printWindow.document.open();printWindow.document.write(html);printWindow.document.close();
  }catch(error){if(!printWindow.closed)printWindow.close();showGlobal(error.message,true);}
  finally{updateOrderSelection();}
});
document.querySelector('#export-order-page').addEventListener('click',()=>{
  if(!state.orders.length)return showGlobal('Không có đơn hàng để xuất.',true);
  const cell=value=>'"'+String(value??'').replace(/^(\s*[=+@-])/ ,"'$1").replace(/"/g,'""')+'"';
  const rows=[['Mã đơn','Khách hàng','Điện thoại','Email','Trạng thái','Thanh toán','Tổng tiền'],...state.orders.map(o=>[o.orderNumber,o.customerName,o.phone,o.email,labels[o.status]||o.status,labels[o.paymentMethod]||o.paymentMethod,o.totalVnd??''])];
  const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download='gaeru-don-hang-trang-'+state.orderPage+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});

document.querySelector('#export-order-excel').addEventListener('click',()=>{
 const params=new URLSearchParams({format:'xlsx',scope:document.querySelector('#order-export-scope').value,page:String(state.orderPage)});
 for(const [key,id] of [['status','order-filter'],['q','order-search'],['paymentStatus','order-payment-filter'],['paymentMethod','order-method-filter'],['sort','order-sort'],['pageSize','order-page-size']])params.set(key,document.getElementById(id).value);
 window.open('/api/gaeru_ceo/orders?'+params,'_blank','noopener');
});

document.querySelector('[data-bulk-process]').addEventListener('click',openBulkProcessing);
