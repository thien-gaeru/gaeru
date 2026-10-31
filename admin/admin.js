// admin/admin.js — Nhân điều phối quản trị (Session, CSRF, RBAC, View Router & window.GAERUAdmin)

const reviewReasonLabels = {
  domain_missing: "Email tên miền không tồn tại · Cần gọi xác nhận",
  recipient_rejected: "Email người mua bị từ chối · Cần gọi xác nhận",
  delivery_failed: "Gửi email lỗi · Cần gọi xác nhận",
  delivery_unknown: "Chưa rõ kết quả email · Cần gọi xác nhận",
  delivery_delayed: "Email gửi chậm > 15 phút · Cần gọi xác nhận"
};

const state = {
  session: null,
  viewRequest: 0,
  csrfToken: "",
  products: [],
  orders: [],
  customers: [],
  currentProduct: null,
  productRequest: 0,
  productScope: /(?:[?&])productScope=trash(?:&|$)/.test(location.search || "") ? "trash" : "catalog",
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
  "9pay": "9Pay",
  momo: "MoMo",
  zalopay: "ZaloPay"
};
const categoryLabels = { audio: "Thu âm", video: "Ghi hình", accessory: "Phụ kiện" };
const orderTransitions = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["completed"],
  completed: [],
  cancelled: []
};
const paymentAttemptLabels = {
  pending: "Đang chờ VNPAY xác nhận giao dịch.",
  failed: "Giao dịch VNPAY chưa thành công; khách có thể cần đặt lại đơn."
};

const formatPrice = (value) =>
  value == null ? "Chưa xác định" : window.GAERUAdminShared.formatMoney(value);
const escapeHtml = (value) =>
  window.GAERUAdminShared.escapeHtml(value);
const can = (permission) =>
  !state.session?.mfaEnrollmentRequired
  && Boolean(state.session?.permissions?.includes(permission) || state.session?.permissions?.includes("*"));

function applyPermissions() {
  document.querySelectorAll("[data-permission], [data-require]").forEach((element) => {
    element.hidden = !can(element.dataset.permission || element.dataset.require);
  });
  document.querySelectorAll("[data-owner-only]").forEach((element) => {
    element.hidden = state.session?.role !== "owner" || state.session?.source !== "bootstrap";
  });
  document.querySelectorAll(".nav-group").forEach((group) => {
    group.hidden = ![...group.querySelectorAll("[data-view]")].some((button) => !button.hidden);
  });
  document.querySelectorAll("#settings-form input,#settings-form textarea,#settings-form button").forEach((element) => {
    element.disabled = !can("settings.write");
  });
}

async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") headers.set("X-CSRF-Token", state.csrfToken);
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && state.session) {
    state.session = null;
    location.replace("/gaeru_ceo?expired=1");
  }
  if (!response.ok) {
    throw Object.assign(new Error(body.error || `Yêu cầu thất bại (${response.status}).`), {
      status: response.status,
      diagnostic: body.diagnostic,
      stage: body.stage
    });
  }
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
    if (session.authenticated && !new URLSearchParams(location.search).has("securityReset")) {
      await showAdmin(session);
    } else {
      document.querySelector("#login-panel").hidden = false;
      if (new URLSearchParams(location.search).has("expired")) {
        document.querySelector("#login-feedback").textContent = "Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.";
      }
    }
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
  document.querySelector("#admin-identity").textContent =
    roleLabel && identityName !== roleLabel ? `${identityName} · ${roleLabel}` : identityName;
  applyPermissions();
  document.querySelectorAll("[data-product-scope]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.productScope === state.productScope))
  );
  document.querySelector("#product-trash-note").hidden = state.productScope !== "trash";
  if (session.mfaEnrollmentRequired) {
    document.querySelectorAll("[data-view]").forEach((b) => { b.hidden = b.dataset.view !== "security"; });
    document.querySelectorAll(".nav-group").forEach((g) => {
      g.hidden = ![...g.querySelectorAll("[data-view]")].some((b) => !b.hidden);
    });
  }

  document.dispatchEvent(new CustomEvent("gaeru:admin-ready", { detail: session }));
  if (session.mfaEnrollmentRequired) {
    await activateView("security");
    showGlobal("Bắt buộc bật xác thực hai yếu tố trước khi truy cập quản trị.");
    return;
  }
  let initialView = "";
  try { initialView = decodeURIComponent(location.hash.slice(1)); } catch {}
  const buttons = [...document.querySelectorAll("[data-view]")];
  const firstView =
    buttons.find((button) => button.dataset.view === initialView && !button.hidden && can(button.dataset.permission))
    || buttons.find((button) => !button.hidden && can(button.dataset.permission));
  if (firstView) await activateView(firstView.dataset.view, { updateHistory: false });
  else showGlobal("Tài khoản chưa được cấp quyền truy cập chức năng. Liên hệ người quản trị.", true);
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
    if (result.mfaRequired) result = await window.GAERUSecurity.loginChallenge(result);
    state.csrfToken = result.csrfToken;
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
  if (view === "owner") return activateView("overview", { updateHistory });
  const button = [...document.querySelectorAll("[data-view]")].find((item) => item.dataset.view === view);
  if (!button || button.hidden || (!can(button.dataset.permission) && !(view === "security" && state.session?.mfaEnrollmentRequired))) return;
  const requestId = ++state.viewRequest;
  if (updateHistory && location.hash !== "#" + view) history.pushState(null, "", "#" + view);
  showGlobal("");
  const panel = document.getElementById(view + "-view");
  const loading = document.getElementById("admin-view-state");
  panel?.setAttribute("aria-busy", "true");
  if (loading) loading.textContent = "Đang tải dữ liệu…";
  document.querySelectorAll("[data-view]").forEach((item) => item.classList.toggle("is-active", item === button));
  document.querySelectorAll(".view-panel").forEach((p) => { p.hidden = p.id !== `${button.dataset.view}-view`; });
  document.querySelector("#view-title").textContent = window.GAERUAdminUI.title(view);
  document.querySelector("#view-description").textContent = window.GAERUAdminUI.description(view);
  document.querySelectorAll("[data-view]").forEach((item) => item.setAttribute("aria-current", item === button ? "page" : "false"));
  document.querySelector(".sidebar").classList.remove("navigation-open");
  document.querySelector(".sidebar-toggle").setAttribute("aria-expanded", "false");
  try {
    if (button.dataset.view === "products") {
      await loadProducts(document.querySelector("#product-search").value.trim());
      checkProductAddedNotice();
    }
    if (button.dataset.view === "orders") await Promise.all([loadOrders(), loadSummary()]);
    if (view === "payments") await window.GAERUConfiguration.mountPayments();
    if (view === "oauth" && window.GAERUConfiguration) await window.GAERUConfiguration.mountOAuth();
    if (view === "shipping") await window.GAERUConfiguration.mountShipping();
    if (button.dataset.view === "customers") await loadCustomers();
    if (button.dataset.view === "settings") {
      await loadSettings();
      if (window.GAERUTikTokAds) await window.GAERUTikTokAds.mount();
    }
    if (button.dataset.view === "overview") {
      await loadSummary();
      if (typeof loadSystemHealth === "function") await loadSystemHealth();
      if (window.GAERUOwner && (state.session?.role === "owner" || state.user?.role === "owner")) await window.GAERUOwner.load();
    }
    if (view === "notifications" && window.GAERUNotifications) await window.GAERUNotifications.load();
    if (view === "security" && window.GAERUSecurity) await window.GAERUSecurity.render(document.querySelector("#security-view"));
    if (view === "marketing" && window.GAERUMarketing) await window.GAERUMarketing.load();
    if (view === "pages") await window.GAERUPages.load();
    if (view === "file-library") await window.GAERUFileLibrary.load();
    if (view === "news" && window.GAERUNewsAdmin) await window.GAERUNewsAdmin.load();
    if (view === "shopping-chat" && window.GAERUShoppingChat) await window.GAERUShoppingChat.load();
    if (view === "care" && window.GAERUCare) await window.GAERUCare.load();
    if (view === "owner" && window.GAERUOwner) await window.GAERUOwner.load();
    if (view === "warranty" && window.GAERUWarranty) await window.GAERUWarranty.load();
    if (view === "platform-upgrades" && window.GAERUUpgradesHub) window.GAERUUpgradesHub.renderMatrix("all");
    if (["payroll", "tax", "invoice", "marketplace"].includes(view) && window.GAERUBusiness) await window.GAERUBusiness.load(view);
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
  } else if (button.dataset.shortcut === "unpaid") {
    document.querySelector("#order-search").value = "";
    document.querySelector("#order-filter").value = "payment_pending";
    document.querySelector("#order-payment-filter").value = "";
    document.querySelector("#order-method-filter").value = "";
    state.orderPage = 1;
    activateView("orders");
  } else {
    document.querySelector("#order-search").value = "";
    document.querySelector("#order-filter").value = button.dataset.shortcut === "pending" ? "pending" : "";
    document.querySelector("#order-payment-filter").value = "";
    document.querySelector("#order-method-filter").value = "";
    state.orderPage = 1;
    activateView("orders");
  }
}));
document.querySelector("#card-unpaid-orders")?.addEventListener("click", () => {
  document.querySelector("#order-search").value = "";
  document.querySelector("#order-filter").value = "payment_pending";
  document.querySelector("#order-payment-filter").value = "";
  document.querySelector("#order-method-filter").value = "";
  state.orderPage = 1;
  activateView("orders");
});
document.querySelector(".sidebar-toggle").addEventListener("click", (event) => {
  const open = document.querySelector(".sidebar").classList.toggle("navigation-open");
  event.currentTarget.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (event) => {
  if (event.target.closest("[data-open-security-settings]")) {
    activateView("security");
  }
});

window.GAERUAdmin = Object.freeze({
  loadSystemHealth,
  request,
  confirmProductAction,
  confirmOrderPermanentDeletion,
  handleOrderPermanentDeleteUI,
  async refreshSession() { await showAdmin(await request("/api/auth/me")); },
  setCsrf(value) { state.csrfToken = value; },
  can,
  showGlobal,
  showProductAddedPopup,
  activateView,
  get user() { return state.session; }
});
initialize();
