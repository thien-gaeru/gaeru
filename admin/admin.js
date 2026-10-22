const state = {
  csrfToken: "",
  products: [],
  orders: [],
  customers: [],
  currentProduct: null,
  productRequest: 0,
  productSearchTimer: 0,
  orderSearchTimer: 0,
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
  bank_transfer: "Chuyển khoản thủ công"
};
const paymentAttemptLabels = {
  pending: "Đang chờ VNPAY xác nhận giao dịch.",
  failed: "Giao dịch VNPAY chưa thành công; khách có thể cần đặt lại đơn."
};
const formatPrice = (value) => `${new Intl.NumberFormat("vi-VN").format(value)} ₫`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));

async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") headers.set("X-CSRF-Token", state.csrfToken);
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Yêu cầu thất bại (${response.status}).`);
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
    if (session.authenticated) await showAdmin(session.username);
    else document.querySelector("#login-panel").hidden = false;
  } catch (error) {
    document.querySelector("#login-panel").hidden = false;
    document.querySelector("#login-feedback").textContent = `Không thể kết nối máy chủ: ${error.message}`;
  }
}

async function showAdmin(username) {
  document.querySelector("#login-panel").hidden = true;
  document.querySelector("#admin-app").hidden = false;
  document.querySelector("#admin-identity").textContent = username;
  const results = await Promise.allSettled([loadSummary(), loadProducts(), loadOrders(), loadSettings()]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) showGlobal(`Đã đăng nhập nhưng một số dữ liệu chưa tải được: ${failed.reason.message}`, true);
}

async function loadSummary() {
  const summary = await request("/api/admin/summary");
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
  const requestId = ++state.productRequest;
  const result = await request(`/api/admin/products${search ? `?q=${encodeURIComponent(search)}` : ""}`);
  if (requestId !== state.productRequest || search !== document.querySelector("#product-search").value.trim()) return;
  state.products = result.products;
  renderProducts();
}

function renderProducts() {
  const root = document.querySelector("#product-list");
  if (!state.products.length) {
    root.innerHTML = '<p class="empty-message">Chưa có sản phẩm trong danh mục.</p>';
    return;
  }
  root.innerHTML = state.products.map((product) => {
    const activeVariants = product.variants.filter((variant) => variant.active).length;
    return `<article class="product-row">
      <img src="${escapeHtml(product.imageUrl)}" alt="">
      <div><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.slug)} · ${activeVariants} phiên bản đang bán</p></div>
      <span class="status-pill ${product.active ? "is-active" : ""}">${product.active ? "Đang bán" : "Bản nháp"}</span>
      <button class="row-button" type="button" data-edit-product="${escapeHtml(product.id)}">Quản lý</button>
    </article>`;
  }).join("");
}

function setProductForm(product = null) {
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
  form.elements.sortOrder.value = product?.sortOrder ?? 0;
  document.querySelector("#product-form-title").textContent = product ? product.name : "Thêm sản phẩm";
  document.querySelector("#variant-manager").hidden = !product;
  document.querySelector("#variant-form").hidden = true;
  setFeedback(form, "");
  if (product) renderVariants(product);
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderVariants(product) {
  const root = document.querySelector("#variant-list");
  if (!product.variants.length) {
    root.innerHTML = '<p class="empty-message">Chưa có phiên bản. Thêm giá bán và tồn kho đã xác minh để có thể xuất bản sản phẩm.</p>';
    return;
  }
  root.innerHTML = product.variants.map((variant) => `<div class="variant-row">
    <div><strong>${escapeHtml(variant.name)}</strong><br><span>SKU ${escapeHtml(variant.sku)} · ${variant.active ? "Đang bán" : "Tạm ẩn"}</span></div>
    <span>${formatPrice(variant.priceVnd)}</span>
    <span>Tồn kho: ${variant.stockQuantity}</span>
    <button class="row-button" type="button" data-edit-variant="${escapeHtml(variant.id)}">Sửa</button>
    <button class="plain-button" type="button" data-delete-variant="${escapeHtml(variant.id)}">Xóa</button>
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
  form.elements.options.value = JSON.stringify(variant?.options || {}, null, 2);
  form.elements.active.checked = Boolean(variant?.active);
  setFeedback(form, "");
}

async function saveProduct(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Đang lưu…";
  setFeedback(form, "");
  try {
    const file = form.elements.imageFile.files[0];
    if (file) {
      const upload = new FormData();
      upload.append("image", file);
      const result = await request("/api/admin/uploads", { method: "POST", body: upload });
      form.elements.imageUrl.value = result.imageUrl;
    }
    const payload = {
      name: form.elements.name.value.trim(),
      slug: form.elements.slug.value.trim(),
      category: form.elements.category.value,
      descriptor: form.elements.descriptor.value.trim(),
      description: form.elements.description.value.trim(),
      imageUrl: form.elements.imageUrl.value.trim(),
      imageAlt: form.elements.imageAlt.value.trim(),
      active: form.elements.active.checked,
      sortOrder: Number(form.elements.sortOrder.value)
    };
    const id = form.elements.id.value;
    const result = await request(id ? `/api/admin/products/${encodeURIComponent(id)}` : "/api/admin/products", {
      method: id ? "PUT" : "POST", body: JSON.stringify(payload)
    });
    await loadProducts(document.querySelector("#product-search").value.trim());
    await loadSummary();
    const product = state.products.find((item) => item.id === (id || result.id));
    if (product) setProductForm(product);
    else setProductForm();
    showGlobal("Đã lưu thông tin sản phẩm.");
  } catch (error) {
    setFeedback(form, error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Lưu sản phẩm";
  }
}

async function saveVariant(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Đang lưu…";
  setFeedback(form, "");
  try {
    const options = JSON.parse(form.elements.options.value || "{}");
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
    await request(variantId ? `/api/admin/variants/${encodeURIComponent(variantId)}` : `/api/admin/products/${encodeURIComponent(productId)}/variants`, {
      method: variantId ? "PUT" : "POST", body: JSON.stringify(payload)
    });
    await loadProducts(document.querySelector("#product-search").value.trim());
    state.currentProduct = state.products.find((item) => item.id === productId);
    setProductForm(state.currentProduct);
    showGlobal("Đã lưu phiên bản và cập nhật tồn kho.");
  } catch (error) {
    setFeedback(form, error instanceof SyntaxError ? "Thuộc tính phải là JSON hợp lệ." : error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Lưu phiên bản";
  }
}

async function loadOrders(page = state.orderPage) {
  const status = document.querySelector("#order-filter").value;
  const search = document.querySelector("#order-search").value.trim();
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (search) params.set("q", search);
  params.set("page", String(page));
  const result = await request(`/api/admin/orders?${params}`);
  state.orderPage = result.pagination.page;
  state.orderPagination = result.pagination;
  state.orders = result.orders;
  renderOrders();
}

function renderOrders() {
  const root = document.querySelector("#order-list");
  const pagination = document.querySelector("#order-pagination");
  pagination.hidden = state.orderPagination.pageCount <= 1;
  document.querySelector("#previous-orders").disabled = state.orderPagination.page <= 1;
  document.querySelector("#next-orders").disabled = state.orderPagination.page >= state.orderPagination.pageCount;
  document.querySelector("#order-page-label").textContent =
    `${state.orderPagination.total} đơn · Trang ${state.orderPagination.page} / ${Math.max(1, state.orderPagination.pageCount)}`;
  if (!state.orders.length) {
    root.innerHTML = '<p class="empty-message">Chưa có đơn hàng phù hợp.</p>';
    return;
  }
  root.innerHTML = state.orders.map((order) => {
    const orderDate = new Date(order.createdAt).toLocaleString("vi-VN");
    const optionMarkup = Object.entries(labels)
      .filter(([key]) => ["pending", "confirmed", "processing", "shipped", "completed", "cancelled"].includes(key))
      .map(([key, label]) => `<option value="${key}" ${order.status === key ? "selected" : ""}>${label}</option>`).join("");
    const paymentStatus = order.paymentStatus === "paid" ? "Đã thanh toán" : "Chưa thanh toán";
    const paymentNote = order.paymentProvider === "vnpay" ? paymentAttemptLabels[order.paymentAttemptStatus] : "";
    const latePaymentWarning = order.status === "cancelled" && order.paymentStatus === "paid"
      ? "Đơn đã hủy nhưng đã nhận tiền; cần đối soát/hoàn tiền thủ công trong merchant portal."
      : "";
    return `<article class="order-card">
      <div class="order-card-header"><div><h3>${escapeHtml(order.orderNumber)}</h3><p>${escapeHtml(orderDate)} · ${escapeHtml(labels[order.paymentMethod])}</p></div><span class="status-pill">${escapeHtml(labels[order.status])}</span></div>
      <div class="order-meta">
        <p><strong>${escapeHtml(order.customerName)}</strong><br>${escapeHtml(order.phone)} · ${escapeHtml(order.email)}</p>
        <p>${escapeHtml(order.address)}, ${escapeHtml(order.city)}${order.note ? `<br>Ghi chú: ${escapeHtml(order.note)}` : ""}</p>
      </div>
      <div class="order-lines">${order.items.map((item) => `<div class="order-line"><span>${escapeHtml(item.productName)} · ${escapeHtml(item.variantName)} × ${item.quantity}</span><strong>${formatPrice(item.lineTotalVnd)}</strong></div>`).join("")}</div>
      <p>Tạm tính ${formatPrice(order.subtotalVnd)} · ${order.totalVnd == null ? "Chưa chốt phí giao hàng" : `Tổng ${formatPrice(order.totalVnd)}`} · Thanh toán: ${escapeHtml(paymentStatus)}</p>
      ${paymentNote ? `<p class="help-text">${escapeHtml(paymentNote)}</p>` : ""}
      ${latePaymentWarning ? `<p class="feedback">${escapeHtml(latePaymentWarning)}</p>` : ""}
      <form class="order-controls" data-order-form="${escapeHtml(order.id)}">
        <label>Trạng thái<select name="status">${optionMarkup}</select></label>
        <label>Phí giao hàng (₫)<input name="shippingFeeVnd" type="number" min="0" max="1000000000" step="1000" value="${order.shippingFeeVnd ?? ""}" placeholder="Nhập để chốt tổng" ${order.status === "pending" ? "" : "disabled"}></label>
        <label>Thanh toán<select name="paymentStatus"><option value="pending" ${order.paymentStatus === "pending" ? "selected" : ""}>Chưa thanh toán</option><option value="paid" ${order.paymentStatus === "paid" ? "selected" : ""}>Đã thanh toán</option></select></label>
        <button class="primary-button" type="submit">Cập nhật</button>
        <p class="feedback order-feedback" role="alert"></p>
      </form>
    </article>`;
  }).join("");
}

async function updateOrder(event) {
  event.preventDefault();
  const form = event.target.closest("[data-order-form]");
  if (!form) return;
  const submitButton = form.querySelector('button[type="submit"]');
  const feedback = form.querySelector('[role="alert"]');
  submitButton.disabled = true;
  submitButton.textContent = "Đang cập nhật…";
  feedback.textContent = "";
  const payload = {
    status: form.elements.status.value,
    paymentStatus: form.elements.paymentStatus.value
  };
  if (form.elements.shippingFeeVnd.value !== "") payload.shippingFeeVnd = Number(form.elements.shippingFeeVnd.value);
  try {
    await request(`/api/admin/orders/${encodeURIComponent(form.dataset.orderForm)}`, { method: "PATCH", body: JSON.stringify(payload) });
    await Promise.all([loadOrders(), loadSummary()]);
    showGlobal("Đã cập nhật đơn hàng.");
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Cập nhật";
  }
}

async function loadCustomers(page = state.customerPage) {
  const search = document.querySelector("#customer-search").value.trim();
  const params = new URLSearchParams({ page: String(page) });
  if (search) params.set("q", search);
  const result = await request(`/api/admin/customers?${params}`);
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
        <span class="status-pill ${customer.active ? "status-active" : "status-cancelled"}">${customer.active ? "Đang hoạt động" : "Đã khóa"}</span>
      </div>
      <div class="customer-meta"><span>${customer.emailVerified ? "Đã xác minh email" : "Chưa xác minh email"}</span><span>${customer.orderCount} đơn hàng</span><span>Tham gia ${new Date(customer.createdAt).toLocaleDateString("vi-VN")}</span></div>
      <div class="customer-actions"><button class="secondary-button" type="button" data-customer-detail="${escapeHtml(customer.id)}">Xem đơn hàng</button><button class="${customer.active ? "plain-button" : "primary-button"}" type="button" data-customer-toggle="${escapeHtml(customer.id)}" data-active="${customer.active}">${customer.active ? "Khóa tài khoản" : "Mở khóa tài khoản"}</button></div>
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
  const result = await request(`/api/admin/customers/${encodeURIComponent(id)}`);
  if (!result.orders.length) {
    panel.innerHTML = '<p class="help-text">Khách hàng chưa có đơn hàng.</p>';
    return;
  }
  panel.innerHTML = result.orders.map((order) => `<div class="customer-order-row"><strong>${escapeHtml(order.orderNumber)}</strong><span>${escapeHtml(labels[order.status] || order.status)}</span><span>${formatPrice(order.totalVnd || 0)}</span></div>`).join("");
}

async function toggleCustomer(id, active) {
  await request(`/api/admin/customers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ active: !active }) });
  await loadCustomers();
  showGlobal(!active ? "Đã mở khóa tài khoản khách hàng." : "Đã khóa tài khoản khách hàng.");
}

async function loadSettings() {
  const settings = await request("/api/admin/settings");
  const form = document.querySelector("#settings-form");
  form.elements.shippingNote.value = settings.shipping_note || "";
  document.querySelector("#payment-provider-status").textContent =
    `Đang khả dụng: ${settings.paymentMethods.map((method) => method === "cod" ? "COD" : method.toUpperCase()).join(", ")}. 9Pay chưa được cấu hình.`;
  renderShippingRates(settings.shipping_rates || {});
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
    await request("/api/admin/settings", {
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
    const result = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value })
    });
    state.csrfToken = result.csrfToken;
    form.reset();
    await showAdmin(result.username);
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

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", async () => {
  document.querySelectorAll("[data-view]").forEach((item) => item.classList.toggle("is-active", item === button));
  document.querySelectorAll(".view-panel").forEach((panel) => { panel.hidden = panel.id !== `${button.dataset.view}-view`; });
  document.querySelector("#view-title").textContent = button.textContent;
  try {
    if (button.dataset.view === "products") await loadProducts(document.querySelector("#product-search").value.trim());
    if (button.dataset.view === "orders") await loadOrders();
    if (button.dataset.view === "customers") await loadCustomers();
    if (button.dataset.view === "settings") await loadSettings();
  } catch (error) {
    showGlobal(error.message, true);
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
document.querySelector("#new-product-button").addEventListener("click", () => setProductForm());
document.querySelector("#product-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-product]");
  if (button) setProductForm(state.products.find((product) => product.id === button.dataset.editProduct));
});
document.querySelector("#product-form").addEventListener("submit", saveProduct);
document.querySelectorAll("[data-close-editor]").forEach((button) => button.addEventListener("click", () => {
  document.querySelector("#product-editor").hidden = true;
  state.currentProduct = null;
}));
document.querySelector("#new-variant-button").addEventListener("click", () => fillVariantForm());
document.querySelector("#variant-form").addEventListener("submit", saveVariant);
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
    try {
      await request(`/api/admin/variants/${encodeURIComponent(remove.dataset.deleteVariant)}`, { method: "DELETE" });
      const productId = state.currentProduct.id;
      await loadProducts(document.querySelector("#product-search").value.trim());
      state.currentProduct = state.products.find((product) => product.id === productId);
      setProductForm(state.currentProduct);
      showGlobal("Đã xóa phiên bản.");
    } catch (error) {
      showGlobal(error.message, true);
    }
  }
});
document.querySelector("#order-filter").addEventListener("change", () => {
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

initialize();
