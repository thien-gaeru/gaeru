// admin/admin-customers-settings.js — Quản lý tài khoản khách hàng (CRM) và cài đặt phí giao hàng cửa hàng

async function loadCustomers(page = state.customerPage) {
  if (!can("customers.read")) return;
  const search = document.querySelector("#customer-search").value.trim();
  const params = new URLSearchParams({ page: String(page) });
  if (search) params.set("q", search);
  const statusSelect = document.querySelector("#customer-status");
  params.set("status", statusSelect?.value || "all");
  params.set("verification", document.querySelector("#customer-verification")?.value || "all");
  const result = await request(`/api/gaeru_ceo/customers?${params}`);
  const statusCounts = result.statusCounts || result.filterCounts;
  if (statusSelect && statusCounts) {
    for (const option of statusSelect.options) {
      const statusLabels = {
        all: "Tất cả tài khoản",
        active: "Đang hoạt động",
        warning: "Cảnh báo SĐT (12h)",
        locked: "Bị khóa",
        spam: "Tài khoản rác / Spam",
        trash: "Thùng rác (Xóa tạm thời)"
      };
      if (statusLabels[option.value]) {
        option.textContent = statusLabels[option.value] + " (" + (statusCounts[option.value] ?? 0) + ")";
      }
    }
  }
  const select = document.querySelector("#customer-verification");
  if (select && result.verificationCounts) {
    for (const option of select.options) {
      const verifyLabels = { all: "Tất cả tài khoản", verified: "Đã xác minh", unverified: "Chưa xác minh" };
      option.textContent = verifyLabels[option.value] + " (" + result.verificationCounts[option.value] + ")";
    }
  }
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
        <span class="status-pill ${customer.deletedAt ? "status-cancelled" : customer.active ? (customer.phoneWarning || customer.regEmailWarning ? "status-warning" : "status-active") : "status-cancelled"}">${customer.deletedAt ? (customer.deletionRecoverable ? "Thùng rác (Chờ xóa)" : "Đã xóa vĩnh viễn") : !customer.active ? (customer.lockReason === "spam_email" ? "Khóa: Email rác" : customer.lockReason === "invalid_phone_timeout" ? "Khóa: SĐT quá 12h" : customer.lockReason === "reg_email_failed_timeout" ? "Khóa: Email ĐK lỗi (>12h)" : "Đã khóa") : customer.phoneWarning ? `⚠️ Cảnh báo SĐT (còn ${customer.phoneWarningRemainingHours || customer.phoneWarningHours || 12}h)` : customer.regEmailWarning ? `⚠️ Cảnh báo Email ĐK (còn ${customer.regEmailWarningRemainingHours || customer.regEmailWarningHours || 12}h)` : "Đang hoạt động"}</span>
      </div>
      <div class="customer-meta"><span>${customer.emailVerified ? "Đã xác minh" : "Chưa xác minh"}</span><span>${customer.orderCount} đơn hàng</span><span>Tham gia ${new Date(customer.createdAt).toLocaleDateString("vi-VN")}</span></div>
      <div class="customer-actions"><button class="secondary-button" type="button" data-customer-detail="${escapeHtml(customer.id)}">Xem đơn hàng</button>${can("customers.write") && !customer.deletedAt ? `<button class="${customer.active ? "plain-button" : "primary-button"}" type="button" data-customer-toggle="${escapeHtml(customer.id)}" data-active="${customer.active}">${customer.active ? "Khóa tài khoản" : "Mở khóa tài khoản"}</button>` : ""}${can("customers.write") && !customer.deletedAt ? `<button class="plain-button" type="button" data-customer-soft-delete="${escapeHtml(customer.id)}">Xóa tạm thời</button>` : ""}${can("customers.write") && customer.deletedAt ? `<button class="primary-button" type="button" data-customer-restore-direct="${escapeHtml(customer.id)}">Khôi phục</button>` : ""}${can("customers.write") ? `<button class="danger-button" type="button" data-customer-permanent-delete="${escapeHtml(customer.id)}">Xóa vĩnh viễn</button>` : ""}</div>
      ${!customer.deletedAt && can("customers.write") ? `<details class="customer-restore"><summary>Xử lý yêu cầu xóa tài khoản</summary><form data-customer-delete="${escapeHtml(customer.id)}"><p>Chỉ thực hiện sau khi khách liên hệ và đã đối chiếu thông tin. Hệ thống gửi email xác nhận; tài khoản chỉ ngừng hoạt động sau khi khách xác nhận.</p><label>Lý do xóa<textarea name="reason" required minlength="10" maxlength="500" rows="2"></textarea></label><label class="deletion-consent"><input type="checkbox" name="confirmed" required> Đã đối chiếu yêu cầu xóa của khách</label><button class="secondary-button">Gửi email xác nhận xóa</button><p role="status"></p></form></details>` : ""}
      ${customer.deletedAt && customer.deletionRecoverable && customer.canRestore && can("customers.write") ? `<details class="customer-restore"><summary>Khôi phục tài khoản</summary><form data-customer-restore="${escapeHtml(customer.id)}"><p>Ngày xác nhận xóa: ${new Date(customer.deletedAt).toLocaleDateString("vi-VN")}. Khôi phục giữ nguyên mật khẩu và xác thực hai yếu tố.</p><label>Lý do khôi phục<textarea name="reason" required minlength="10" maxlength="500" rows="2"></textarea></label><button class="secondary-button">Xác nhận khôi phục</button><p role="status"></p></form></details>` : ""}
      <div class="customer-detail" data-customer-detail-panel="${escapeHtml(customer.id)}" hidden></div>
    </article>`).join("");
  pagination.hidden = state.customerPagination.pageCount <= 1;
  document.querySelector("#customer-page-label").textContent =
    `Trang ${state.customerPage}/${state.customerPagination.pageCount} · ${state.customerPagination.total} khách hàng`;
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
  panel.innerHTML = result.orders
    .map((order) => `<div class="customer-order-row"><strong>${escapeHtml(order.orderNumber)}</strong><span>${escapeHtml(labels[order.status] || order.status)}</span><span>${formatPrice(order.totalVnd || 0)}</span></div>`)
    .join("");
}

async function toggleCustomer(id, active) {
  await request(`/api/gaeru_ceo/customers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ active: !active })
  });
  await loadCustomers();
  showGlobal(!active ? "Đã mở khóa tài khoản khách hàng." : "Đã khóa tài khoản khách hàng.");
}

document.querySelector("#settings-form").addEventListener("invalid", () => {
  const details = document.querySelector("#settings-form").closest("details");
  if (details) details.open = true;
}, true);

async function loadSettings() {
  if (!can("settings.read")) return;
  const settings = await request("/api/gaeru_ceo/settings");
  const form = document.querySelector("#settings-form");
  form.elements.shippingNote.value = settings.shipping_note || "";
  document.querySelector("#payment-provider-status").textContent =
    `Đang kích hoạt tại trang đặt hàng: ${settings.paymentMethods.map((method) => method === "cod" ? "COD" : (labels[method] || method.toUpperCase())).join(", ")}.`;
  renderShippingRates(settings.shipping_rates || {});
  if (window.GAERUConfiguration) await window.GAERUConfiguration.load();
  applyPermissions();
}

function renderShippingRates(rates) {
  const root = document.querySelector("#shipping-rate-list");
  const entries = Object.entries(rates).sort(([left], [right]) => left.localeCompare(right, "vi"));
  root.innerHTML = entries.length
    ? entries.map(([province, fee]) => `
    <div class="shipping-rate-row">
      <label>Tỉnh/thành phố<input data-shipping-province required maxlength="120" value="${escapeHtml(province)}"></label>
      <label>Phí giao hàng (₫)<input data-shipping-fee type="number" required min="0" max="1000000000" step="1" value="${escapeHtml(fee)}"></label>
      <button class="plain-button" type="button" data-remove-shipping-rate>Xóa tỉnh/thành</button>
    </div>`).join("")
    : '<p class="shipping-rate-empty">Chưa có bảng phí. Thêm các tỉnh/thành phố GAERU đang giao hàng.</p>';
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
      if (!province || Object.keys(shippingRates).some((name) => name.normalize("NFC").toLocaleLowerCase("vi") === normalizedProvince)) {
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

document.querySelector("#customer-search").addEventListener("input", (event) => {
  window.clearTimeout(state.customerSearchTimer);
  const value = event.currentTarget.value;
  state.customerSearchTimer = window.setTimeout(() => {
    if (value !== document.querySelector("#customer-search").value) return;
    state.customerPage = 1;
    loadCustomers(1).catch((error) => showGlobal(error.message, true));
  }, 200);
});
document.querySelector("#customer-status")?.addEventListener("change", () => loadCustomers(1).catch((error) => showGlobal(error.message, true)));
document.querySelector("#customer-verification")?.addEventListener("change", () => loadCustomers(1).catch((error) => showGlobal(error.message, true)));
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
      if (!can("customers.write")) return;
      const active = toggleButton.dataset.active === "true";
      if (active && !window.confirm("Khóa tài khoản này? Khách hàng sẽ không thể đăng nhập.")) return;
      await toggleCustomer(toggleButton.dataset.customerToggle, active);
      return;
    }
    const softDeleteBtn = event.target.closest("[data-customer-soft-delete]");
    if (softDeleteBtn) {
      if (!can("customers.write")) return;
      if (!window.confirm("Xóa tạm thời tài khoản này? Tài khoản sẽ chuyển vào thùng rác và bị khóa đăng nhập.")) return;
      await request(`/api/gaeru_ceo/customers/${encodeURIComponent(softDeleteBtn.dataset.customerSoftDelete)}/soft-delete`, {
        method: "POST",
        body: JSON.stringify({ reason: "Quản trị viên xóa tạm thời" })
      });
      await loadCustomers();
      showGlobal("Đã chuyển tài khoản vào thùng rác (xóa tạm thời).");
      return;
    }
    const restoreDirectBtn = event.target.closest("[data-customer-restore-direct]");
    if (restoreDirectBtn) {
      if (!can("customers.write")) return;
      await request(`/api/gaeru_ceo/customers/${encodeURIComponent(restoreDirectBtn.dataset.customerRestoreDirect)}/restore`, {
        method: "POST",
        body: JSON.stringify({ reason: "Quản trị viên khôi phục tài khoản từ thùng rác" })
      });
      await loadCustomers();
      showGlobal("Đã khôi phục tài khoản khách hàng thành công.");
      return;
    }
    const permDeleteBtn = event.target.closest("[data-customer-permanent-delete]");
    if (permDeleteBtn) {
      if (!can("customers.write")) return;
      const password = window.prompt(
        "CẢNH BÁO: Xóa vĩnh viễn tài khoản này?\nToàn bộ dữ liệu hồ sơ, bảo hành, voucher và thông tin tài khoản sẽ bị xóa hoàn toàn và KHÔNG thể khôi phục!\n\nNhập mật khẩu quản trị viên để xác thực:"
      );
      if (!password || !password.trim()) return;
      await request(`/api/gaeru_ceo/customers/${encodeURIComponent(permDeleteBtn.dataset.customerPermanentDelete)}/permanent-delete`, {
        method: "POST",
        body: JSON.stringify({ password: password.trim(), reason: "Quản trị viên xác thực xóa vĩnh viễn" })
      });
      await loadCustomers();
      showGlobal("Đã xóa vĩnh viễn tài khoản khách hàng.");
      return;
    }
  } catch (error) {
    showGlobal(error.message, true);
  }
});
document.querySelector("#customer-list").addEventListener("submit", async (e) => {
  if (!e.target.matches("[data-customer-restore]")) return;
  e.preventDefault();
  if (!can("customers.write")) return;
  const form = e.target;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await request("/api/gaeru_ceo/customers/" + encodeURIComponent(form.dataset.customerRestore) + "/restore", {
      method: "POST",
      body: JSON.stringify({ reason: form.elements.reason.value })
    });
    await loadCustomers();
    showGlobal("Đã khôi phục tài khoản.");
  } catch (error) {
    form.querySelector("[role=status]").textContent = error.message;
    button.disabled = false;
  }
});
document.querySelector("#customer-list").addEventListener("submit", async (e) => {
  if (!e.target.matches("[data-customer-delete]")) return;
  e.preventDefault();
  if (!can("customers.write")) return;
  const form = e.target;
  const button = form.querySelector("button");
  if (!form.reportValidity()) return;
  button.disabled = true;
  try {
    await request("/api/gaeru_ceo/customers/" + encodeURIComponent(form.dataset.customerDelete) + "/delete", {
      method: "POST",
      body: JSON.stringify({ reason: form.elements.reason.value, confirmed: form.elements.confirmed.checked })
    });
    await loadCustomers();
    showGlobal("Đã gửi email xác nhận xóa; tài khoản vẫn hoạt động đến khi khách xác nhận.");
  } catch (error) {
    form.querySelector("[role=status]").textContent = error.message;
    button.disabled = false;
  }
});

document.querySelector("#settings-form").addEventListener("submit", saveSettings);
document.querySelector("#add-shipping-rate").addEventListener("click", () => {
  if (!can("settings.write")) return;
  const root = document.querySelector("#shipping-rate-list");
  const emptyNote = root.querySelector(".shipping-rate-empty");
  if (emptyNote) emptyNote.remove();
  const nextNum = root.querySelectorAll(".shipping-rate-row").length + 1;
  const newRowHtml = `
    <div class="shipping-rate-row">
      <label>Tỉnh/thành phố<input data-shipping-province required maxlength="120" value="" placeholder="Ví dụ: Tỉnh/thành ${nextNum}"></label>
      <label>Phí giao hàng (₫)<input data-shipping-fee type="number" required min="0" max="1000000000" step="1" value="0"></label>
      <button class="plain-button" type="button" data-remove-shipping-rate>Xóa tỉnh/thành</button>
    </div>`;
  root.insertAdjacentHTML("beforeend", newRowHtml);
  const newRow = root.lastElementChild;
  newRow?.querySelector("[data-shipping-province]")?.focus();
});
document.querySelector("#shipping-rate-list").addEventListener("click", (event) => {
  if (!can("settings.write")) return;
  if (!event.target.closest("[data-remove-shipping-rate]")) return;
  const row = event.target.closest(".shipping-rate-row");
  row?.remove();
  const root = document.querySelector("#shipping-rate-list");
  if (!root.querySelectorAll(".shipping-rate-row").length) {
    root.innerHTML = '<p class="shipping-rate-empty">Chưa có bảng phí. Thêm các tỉnh/thành phố GAERU đang giao hàng.</p>';
  }
});
