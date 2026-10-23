(() => {
  "use strict";
  const admin = window.GAERUAdmin;
  const h = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const money = (value) => `${new Intl.NumberFormat("vi-VN").format(Number(value || 0))} ₫`;
  const number = (value) => new Intl.NumberFormat("vi-VN").format(Number(value || 0));
  const date = (value) => value ? new Date(value).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "—";
  const roleNames = { owner: "Chủ doanh nghiệp", admin: "Quản trị", manager: "Quản lý", sales: "Bán hàng", warehouse: "Kho", accountant: "Kế toán", viewer: "Chỉ xem" };
  const statusNames = { draft: "Bản nháp", submitted: "Chờ duyệt", approved: "Đã duyệt", posted: "Đã ghi nhận", partially_received: "Đã nhập một phần", received: "Đã nhập đủ", cancelled: "Đã hủy", pending: "Chờ xử lý", paid: "Đã thanh toán", confirmed: "Đã xác nhận", processing: "Đang xử lý", shipped: "Đang giao", completed: "Hoàn tất" };
  const entityNames = { staff: "Nhân viên", department: "Phòng ban", warehouse: "Kho hàng", supplier: "Nhà cung cấp", product: "Sản phẩm", variant: "Phiên bản", order: "Đơn hàng", purchase_order: "Đơn mua", goods_receipt: "Phiếu nhập", inventory: "Tồn kho", supplier_payments: "Trả nhà cung cấp", expense_requests: "Khoản chi", sales_receipt: "Thu tiền khách", settings: "Cài đặt" };
  const actionNames = { "staff.create": "Thêm nhân viên", "staff.update": "Cập nhật nhân viên", "department.create": "Thêm phòng ban", "department.update": "Cập nhật phòng ban", "warehouse.create": "Thêm kho hàng", "warehouse.update": "Cập nhật kho hàng", "supplier.create": "Thêm nhà cung cấp", "supplier.update": "Cập nhật nhà cung cấp", "purchase.create": "Lập đơn mua", "purchase.submit": "Trình duyệt đơn mua", "purchase.approve": "Duyệt đơn mua", "purchase.cancel": "Hủy đơn mua", "inventory.adjust": "Điều chỉnh tồn kho", "inventory.transfer": "Điều chuyển kho", "inventory.receive": "Nhập kho", "finance.receipt.post": "Ghi nhận thu tiền", "finance.request.create": "Tạo phiếu chi", "finance.request.approve": "Duyệt phiếu chi", "finance.request.cancel": "Hủy phiếu chi", "order.update": "Cập nhật đơn hàng", "product.create": "Thêm sản phẩm", "product.update": "Cập nhật sản phẩm", "variant.create": "Thêm phiên bản", "variant.update": "Cập nhật phiên bản", "variant.delete": "Xóa phiên bản", "settings.update": "Cập nhật cài đặt", "auth.login": "Đăng nhập", "auth.logout": "Đăng xuất" };
  const movementNames = { adjustment: "Điều chỉnh", transfer_in: "Nhận điều chuyển", transfer_out: "Xuất điều chuyển", purchase_receipt: "Nhập mua hàng", sale_reservation: "Phân bổ cho đơn bán", sale_release: "Hoàn kho do hủy đơn", legacy_sale_release: "Hoàn kho đơn cũ", receipt: "Nhập hàng", order: "Đặt hàng", order_sale: "Xuất bán", order_cancel: "Hoàn kho do hủy", opening: "Tồn đầu kỳ", catalog_adjustment: "Điều chỉnh danh mục" };
  Object.assign(actionNames, { "catalog.product.create": "Thêm sản phẩm", "catalog.product.update": "Cập nhật sản phẩm", "catalog.variant.create": "Thêm phiên bản", "catalog.variant.update": "Cập nhật phiên bản", "catalog.variant.delete": "Xóa phiên bản", "catalog.image.upload": "Tải ảnh sản phẩm", "customer.access.update": "Thay đổi truy cập khách hàng", "order.create": "Khách đặt hàng", "payment.vnpay.callback": "Đối soát VNPAY", "inventory.initialize": "Khởi tạo tồn kho", "inventory.set": "Điều chỉnh tổng tồn", "inventory.reserve": "Phân bổ tồn cho đơn", "inventory.release": "Hoàn kho do hủy", "inventory.legacy_release": "Hoàn kho đơn cũ", "purchase.receive": "Nhập hàng theo đơn mua" });
  Object.assign(entityNames, { customer: "Khách hàng", product_image: "Ảnh sản phẩm", store_settings: "Cài đặt cửa hàng" });
  for (const obsoleteAction of ["product.create", "product.update", "variant.create", "variant.update", "variant.delete"]) delete actionNames[obsoleteAction];
  const e = { views: {}, lookup: { warehouses: [], suppliers: [], variants: [], departments: [] }, activePurchase: null };
  const can = admin.can;
  const api = (path, options) => admin.request(`/api/admin${path}`, options);
  const key = () => crypto.randomUUID();
  const badge = (status) => `<span class="status-pill status-${h(status)}">${h(statusNames[status] || status)}</span>`;
  const empty = (text = "Chưa có dữ liệu phù hợp.") => `<div class="empty-message">${h(text)}</div>`;
  const options = (rows, value = "", label = (row) => row.name) => rows.map((row) => `<option value="${h(row.id)}" ${row.id === value ? "selected" : ""}>${h(label(row))}</option>`).join("");
  const field = (label, name, value = "", extra = "") => `<label>${label}<input name="${name}" value="${h(value)}" ${extra}></label>`;
  const select = (label, name, markup, extra = "") => `<label>${label}<select name="${name}" ${extra}>${markup}</select></label>`;
  const noteField = (value = "") => `<label class="span-all">Ghi chú<textarea name="note" rows="2" maxlength="1000">${h(value)}</textarea></label>`;
  const feedback = '<p class="feedback span-all" role="alert"></p>';
  const submit = (text) => `<div class="enterprise-form-actions span-all"><button class="primary-button" type="submit">${text}</button><button class="plain-button" type="button" data-e-close>Đóng</button></div>${feedback}`;
  const pager = (view, pagination) => `<div class="pagination"><button class="secondary-button" data-e-page="${view}" data-page="${Math.max(1, (pagination?.page || 1) - 1)}" ${!pagination || pagination.page <= 1 ? "disabled" : ""}>Trước</button><span>${number(pagination?.total)} kết quả · Trang ${pagination?.page || 1} / ${Math.max(1, pagination?.pageCount || 1)}</span><button class="secondary-button" data-e-page="${view}" data-page="${(pagination?.page || 1) + 1}" ${!pagination || pagination.page >= pagination.pageCount ? "disabled" : ""}>Tiếp</button></div>`;
  const table = (headers, rows, className = "") => `<div class="enterprise-table-wrap"><table class="enterprise-table ${className}"><thead><tr>${headers.map((label) => `<th scope="col">${label}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const row = (cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
  const editButton = (view, id) => `<button class="row-button" type="button" data-e-edit="${view}" data-id="${h(id)}">Chỉnh sửa</button>`;
  let confirmationQueue = Promise.resolve();
  function confirmAction(message, trigger = document.activeElement) {
    const review = () => new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "enterprise-confirm-dialog";
      dialog.setAttribute("aria-labelledby", "enterprise-confirm-title");
      dialog.setAttribute("aria-describedby", "enterprise-confirm-message");
      dialog.innerHTML = '<div class="enterprise-confirm-heading"><p class="eyebrow">Kiểm tra trước khi ghi nhận</p><h2 id="enterprise-confirm-title">Xác nhận thao tác</h2></div><p id="enterprise-confirm-message"></p><div class="enterprise-confirm-actions"><button class="secondary-button" type="button" data-confirm-cancel autofocus>Quay lại</button><button class="primary-button" type="button" data-confirm-accept>Xác nhận</button></div>';
      dialog.querySelector("#enterprise-confirm-message").textContent = String(message);
      let settled = false;
      const finish = (accepted) => {
        if (settled) return;
        settled = true;
        dialog.close();
        dialog.remove();
        document.body.classList.remove("enterprise-confirm-open");
        resolve(accepted);
        requestAnimationFrame(() => {
          if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
          else trigger?.closest("form")?.querySelector("input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled)")?.focus({ preventScroll: true });
        });
      };
      dialog.querySelector("[data-confirm-cancel]").addEventListener("click", () => finish(false));
      dialog.querySelector("[data-confirm-accept]").addEventListener("click", () => finish(true));
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
      dialog.addEventListener("close", () => finish(false));
      document.body.append(dialog);
      document.body.classList.add("enterprise-confirm-open");
      dialog.showModal();
      dialog.querySelector("[data-confirm-cancel]").focus({ preventScroll: true });
    });
    const result = confirmationQueue.then(review);
    confirmationQueue = result.catch(() => false);
    return result;
  }

  function viewState(view) { return e.views[view] ||= { page: 1, request: 0, mounted: false, rows: [] }; }
  function root(view) { return document.querySelector(`#${view}-view`); }
  function searchForm(view, extra = "", placeholder = "Tìm kiếm") {
    return `<form class="enterprise-filters" data-e-filter="${view}"><label class="enterprise-search"><span class="visually-hidden">${placeholder}</span><input name="q" type="search" placeholder="${placeholder}"></label>${extra}<button class="secondary-button" type="submit">Áp dụng</button><button class="plain-button" type="button" data-e-reset="${view}">Xóa lọc</button></form>`;
  }
  function mount(view, markup) {
    if (viewState(view).mounted) return;
    root(view).innerHTML = markup;
    viewState(view).mounted = true;
  }
  function formMessage(form, message) { form.querySelector('[role="alert"]').textContent = message; }
  function formValues(form) { return Object.fromEntries(new FormData(form)); }
  function queryFor(view) {
    const form = root(view).querySelector(`[data-e-filter="${view}"]`);
    const params = new URLSearchParams({ page: String(viewState(view).page) });
    if (form) for (const [name, value] of new FormData(form)) if (String(value).trim()) params.set(name, String(value).trim());
    return params;
  }
  async function loadList(view, endpoint, property, renderer) {
    const state = viewState(view), requestId = ++state.request;
    const target = root(view).querySelector("[data-e-list]");
    target.setAttribute("aria-busy", "true");
    root(view).querySelector("[data-e-status]").textContent = "Đang tải dữ liệu…";
    try {
      const result = await api(`${endpoint}?${queryFor(view)}`);
      if (requestId !== state.request) return;
      state.rows = result[property] || [];
      state.result = result;
      root(view).querySelector("[data-e-status]").textContent = `${number(result.pagination?.total ?? state.rows.length)} kết quả`;
      target.innerHTML = renderer(state.rows, result);
      const pagination = root(view).querySelector("[data-e-pagination]");
      if (pagination) pagination.innerHTML = result.pagination ? pager(view, result.pagination) : "";
      return result;
    } catch (error) {
      if (requestId === state.request) root(view).querySelector("[data-e-status]").textContent = error.message;
      throw error;
    } finally { if (requestId === state.request) target.setAttribute("aria-busy", "false"); }
  }
  function listShell(view, description, newButton = "", filters = "") {
    return `<div class="enterprise-intro"><p>${description}</p>${newButton}</div>${searchForm(view, filters)}<p class="list-status" data-e-status aria-live="polite"></p><div data-e-list></div><div data-e-pagination></div><section class="editor-card enterprise-editor" data-e-editor hidden></section>`;
  }
  async function lookups({ warehouses = false, suppliers = false, variants = false, departments = false } = {}) {
    const tasks = [];
    if (warehouses && can("inventory.read")) tasks.push(api("/warehouses").then((result) => { e.lookup.warehouses = result.warehouses || []; }));
    if (suppliers && can("suppliers.read")) tasks.push((async () => {
      const first = await api("/suppliers");
      const pages = [];
      for (let page = 2; page <= (first.pagination?.pageCount || 1); page++) pages.push(api(`/suppliers?page=${page}`));
      const remaining = await Promise.all(pages);
      e.lookup.suppliers = [first, ...remaining].flatMap((result) => result.suppliers || []);
    })());
    if (variants && can("catalog.read")) tasks.push(api("/products").then((result) => {
      e.lookup.variants = (result.products || []).flatMap((product) => product.variants.map((variant) => ({ ...variant, productName: product.name })));
    }));
    if (departments && can("staff.read")) tasks.push(api("/departments").then((result) => { e.lookup.departments = result.departments || []; }));
    await Promise.all(tasks);
  }
  function showEditor(view, html) {
    const editor = root(view).querySelector("[data-e-editor]");
    editor.innerHTML = html; editor.hidden = false;
    editor.scrollIntoView({ behavior: "smooth", block: "start" });
    editor.querySelector("input:not([type=hidden]),select")?.focus({ preventScroll: true });
  }

  const definitions = {
    warehouses: { path: "/warehouses", property: "warehouses", singular: "kho hàng", write: "inventory.approve", description: "Quản lý địa điểm lưu kho. Tồn kho từng SKU được theo dõi riêng tại mỗi kho.", fields: [{ name: "code", label: "Mã kho", required: true }, { name: "name", label: "Tên kho", required: true }, { name: "address", label: "Địa chỉ / vị trí" }] },
    suppliers: { path: "/suppliers", property: "suppliers", singular: "nhà cung cấp", write: "suppliers.write", description: "Thông tin liên hệ và trạng thái hợp tác với nhà cung cấp. Đơn mua và công nợ được lưu riêng.", fields: [{ name: "code", label: "Mã nhà cung cấp", required: true }, { name: "name", label: "Tên nhà cung cấp", required: true }, { name: "email", label: "Email", type: "email" }, { name: "phone", label: "Số điện thoại", type: "tel" }, { name: "address", label: "Địa chỉ" }] },
    departments: { path: "/departments", property: "departments", singular: "phòng ban", write: "staff.write", description: "Sắp xếp nhân viên theo phòng ban. Quyền thao tác được quyết định bởi vai trò của từng tài khoản.", fields: [{ name: "code", label: "Mã phòng ban", required: true }, { name: "name", label: "Tên phòng ban", required: true }] }
  };
  async function loadEntity(view) {
    const definition = definitions[view];
    mount(view, listShell(view, definition.description, can(definition.write) ? `<button class="primary-button" data-e-new="${view}">+ Thêm ${definition.singular}</button>` : ""));
    await loadList(view, definition.path, definition.property, (allRows) => {
      const query = String(root(view).querySelector('[name="q"]').value).trim().toLocaleLowerCase("vi");
      const rows = ["departments", "warehouses"].includes(view) && query ? allRows.filter((entry) => `${entry.code} ${entry.name} ${entry.address || ""}`.toLocaleLowerCase("vi").includes(query)) : allRows;
      if (["departments", "warehouses"].includes(view)) root(view).querySelector("[data-e-status]").textContent = `${rows.length} kết quả`;
      return rows.length ? table(["Mã / tên", "Thông tin", "Trạng thái", ""], rows.map((entry) => row([
      `<strong>${h(entry.name)}</strong><small>${h(entry.code)}</small>`,
      [entry.location, entry.address, entry.email, entry.phone].filter(Boolean).map(h).join("<br>") || "—",
      `<span class="status-pill ${entry.active === false ? "" : "status-active"}">${entry.active === false ? "Tạm ngừng" : "Đang hoạt động"}</span>`,
      can(definition.write) ? editButton(view, entry.id) : ""
    ]))) : empty(`Chưa có ${definition.singular} phù hợp.`);
    });
  }
  function entityEditor(view, entry = null) {
    const definition = definitions[view];
    if (!can(definition.write)) return;
    showEditor(view, `<h2>${entry ? "Chỉnh sửa" : "Thêm"} ${definition.singular}</h2><form class="form-grid" data-e-form="entity" data-view="${view}"><input type="hidden" name="id" value="${h(entry?.id || "")}"><input type="hidden" name="version" value="${h(entry?.version || "")}">${definition.fields.map((item) => field(item.label, item.name, entry?.[item.name] || "", `type="${item.type || "text"}" maxlength="${item.name === "code" ? 30 : item.name === "phone" ? 30 : item.name === "address" ? 500 : 120}" ${item.name === "code" ? 'minlength="2" pattern="[A-Z0-9_-]+" placeholder="Ví dụ: KHO_HCM"' : ""} ${entry && item.name === "code" && view !== "departments" ? "readonly" : ""} ${item.required ? "required" : ""}`)).join("")}${entry ? `<label class="checkbox-label"><input type="checkbox" name="active" ${entry.active !== false ? "checked" : ""}> Đang hoạt động</label>` : ""}${submit("Lưu thông tin")}</form>`);
  }

  async function loadInventory() {
    await lookups({ warehouses: true });
    mount("inventory", `<div class="enterprise-intro"><p>Tồn kho theo địa điểm, điều chỉnh có lý do và điều chuyển giữa các kho. Mỗi lần ghi nhận được lưu vào lịch sử.</p><div class="enterprise-actions">${can("inventory.approve") ? '<button class="primary-button" data-e-inventory="adjustment">Điều chỉnh tồn</button>' : ""}${can("inventory.write") ? '<button class="secondary-button" data-e-inventory="transfer">Điều chuyển kho</button>' : ""}</div></div>${searchForm("inventory", select("Kho hàng", "warehouseId", '<option value="">Tất cả kho</option>' + options(e.lookup.warehouses)), "Tìm tên sản phẩm hoặc SKU")}<p class="list-status" data-e-status aria-live="polite"></p><div data-e-list></div><div data-e-pagination></div><section class="editor-card" data-e-editor hidden></section><section class="enterprise-section"><div class="section-heading"><h2>Lịch sử biến động</h2><button class="secondary-button" data-e-movements>Tải lịch sử</button></div><div id="movement-list"></div></section>`);
    const result = await loadList("inventory", "/inventory", "stock", (rows) => rows.length ? table(["Sản phẩm / SKU", "Kho", "Số lượng", ""], rows.map((entry, index) => row([`<strong>${h(entry.productName)}</strong><small>${h(entry.variantName)} · ${h(entry.sku)}</small>`, h(entry.warehouseName), `<strong class="${entry.quantity <= 5 ? "stock-alert" : ""}">${number(entry.quantity)}</strong>`, can("inventory.approve") ? `<button class="row-button" data-e-adjust-row="${index}">Điều chỉnh</button>` : ""]))) : empty("Chưa có tồn kho phù hợp. Nhập hàng hoặc điều chỉnh để bổ sung tồn."));
    if (result?.warehouses) e.lookup.warehouses = result.warehouses;
    const warehouseFilter = root("inventory").querySelector('[name="warehouseId"]'), selected = warehouseFilter.value;
    warehouseFilter.innerHTML = '<option value="">Tất cả kho</option>' + options(e.lookup.warehouses, selected);
  }
  async function inventoryEditor(type, entry = null) {
    if (!can(type === "adjustment" ? "inventory.approve" : "inventory.write")) return;
    await lookups({ warehouses: true, variants: true });
    const stock = viewState("inventory").rows;
    const variants = e.lookup.variants.length ? e.lookup.variants : [...new Map(stock.map((item) => [item.variantId, { id: item.variantId, sku: item.sku, name: item.variantName, productName: item.productName }])).values()];
    const variantOptions = options(variants, entry?.variantId, (item) => `${item.sku} · ${item.productName} · ${item.name}`);
    const whOptions = options(e.lookup.warehouses.filter((item) => item.active !== false), entry?.warehouseId);
    showEditor("inventory", `<h2>${type === "adjustment" ? "Điều chỉnh tồn kho" : "Điều chuyển kho"}</h2><p class="help-text">${type === "adjustment" ? "Nhập chênh lệch tăng hoặc giảm so với tồn hiện tại. Phải kiểm tra số lượng trước khi ghi nhận." : "Kho nguồn sẽ giảm và kho đích sẽ tăng cùng số lượng trong một lần ghi nhận."}</p><form class="form-grid" data-e-form="${type}"><input type="hidden" name="requestKey" value="${key()}">${select("Phiên bản / SKU", "variantId", '<option value="">Chọn phiên bản</option>' + variantOptions, "required")}${select(type === "adjustment" ? "Kho hàng" : "Kho nguồn", type === "adjustment" ? "warehouseId" : "fromWarehouseId", '<option value="">Chọn kho</option>' + whOptions, "required")}${type === "transfer" ? select("Kho đích", "toWarehouseId", '<option value="">Chọn kho</option>' + whOptions, "required") : field("Tồn hiện tại đã kiểm tra", "expectedQuantity", entry?.quantity ?? "", 'type="number" min="0" step="1" required')}${field(type === "adjustment" ? "Chênh lệch (+ tăng / − giảm)" : "Số lượng chuyển", type === "adjustment" ? "delta" : "quantity", "", `type="number" ${type === "transfer" ? 'min="1"' : ""} step="1" required`)}<label class="span-all">Lý do<textarea name="reason" maxlength="1000" required rows="2"></textarea></label>${submit(type === "adjustment" ? "Kiểm tra & ghi nhận" : "Kiểm tra & điều chuyển")}</form>`);
  }
  async function loadMovements(page = 1) {
    const params = queryFor("inventory"); params.set("page", String(page));
    const target = document.querySelector("#movement-list"); target.textContent = "Đang tải lịch sử…";
    try {
      const result = await api(`/inventory/movements?${params}`);
      target.innerHTML = result.movements?.length ? table(["Thời gian / người ghi", "SKU / kho", "Biến động", "Lý do"], result.movements.map((entry) => row([`${date(entry.createdAt)}<small>${h(entry.actorUsername || "Hệ thống")}</small>`, `${h(entry.sku)}<small>${h(entry.warehouseName)}</small>`, `<strong>${entry.delta > 0 ? "+" : ""}${number(entry.delta)}</strong><small>${number(entry.quantityBefore)} → ${number(entry.quantityAfter)}</small>`, `${h(movementNames[entry.type] || entry.type)}<small>${h(entry.reason || "")}</small>`]))) + (result.pagination ? pager("movements", result.pagination) : "") : empty("Chưa có biến động trong phạm vi đã chọn.");
    } catch (error) { target.textContent = error.message; }
  }

  async function loadPurchases() {
    mount("purchases", listShell("purchases", "Lập đơn mua, trình duyệt, sau đó nhập một phần hoặc toàn bộ hàng vào kho đã chọn.", can("purchases.write") ? '<button class="primary-button" data-e-new="purchase">+ Lập đơn mua</button>' : "", select("Trạng thái", "status", '<option value="">Tất cả</option>' + ["draft", "submitted", "approved", "partially_received", "received", "cancelled"].map((status) => `<option value="${status}">${statusNames[status]}</option>`).join(""))) + '<section class="enterprise-section"><div class="section-heading"><h2>Phiếu nhập hàng</h2><button class="secondary-button" data-e-receipts>Tải phiếu nhập</button></div><div id="receipt-list"></div></section>');
    await loadList("purchases", "/purchase-orders", "purchaseOrders", (rows) => rows.length ? table(["Đơn mua", "Nhà cung cấp / kho", "Giá trị", "Trạng thái", ""], rows.map((entry) => row([`<strong>${h(entry.number)}</strong><small>${date(entry.createdAt)}</small>`, `${h(entry.supplierName)}<small>${h(entry.warehouseName)}</small>`, money(entry.totalVnd), badge(entry.status), `<button class="row-button" data-e-purchase="${h(entry.id)}">Chi tiết</button>`]))) : empty("Chưa có đơn mua phù hợp."));
  }
  function purchaseLine() {
    return `<div class="purchase-line">${select("Phiên bản / SKU", "variantId", '<option value="">Chọn phiên bản</option>' + options(e.lookup.variants, "", (item) => `${item.sku} · ${item.productName} · ${item.name}`), "required")}${field("Số lượng đặt", "quantity", "1", 'type="number" min="1" step="1" required')}${field("Đơn giá nhập (₫)", "unitCostVnd", "", 'type="number" min="0" step="1" required')}<button type="button" class="plain-button" data-e-remove-line>Xóa dòng</button></div>`;
  }
  async function purchaseEditor() {
    if (!can("purchases.write")) return;
    await lookups({ suppliers: true, warehouses: true, variants: true });
    showEditor("purchases", `<h2>Lập đơn mua hàng</h2><form class="form-grid" data-e-form="purchase">${select("Nhà cung cấp", "supplierId", '<option value="">Chọn nhà cung cấp</option>' + options(e.lookup.suppliers.filter((item) => item.active !== false)), "required")}${select("Kho nhận hàng", "warehouseId", '<option value="">Chọn kho</option>' + options(e.lookup.warehouses.filter((item) => item.active !== false)), "required")}${field("Số tham chiếu nhà cung cấp", "reference", "", 'maxlength="120"')}${noteField()}<div class="span-all purchase-lines">${purchaseLine()}</div><button class="secondary-button span-all" data-e-add-line type="button">+ Thêm dòng sản phẩm</button>${submit("Lưu bản nháp")}</form>`);
  }
  async function purchaseDetail(id) {
    const result = await api(`/purchase-orders/${encodeURIComponent(id)}`), order = result.purchaseOrder;
    e.activePurchase = order;
    const actions = [];
    if (order.status === "draft" && can("purchases.write")) actions.push('<button class="primary-button" data-e-po-action="submit">Trình duyệt</button>');
    const selfApproval = !["owner", "admin"].includes(admin.user?.role) && [order.createdByUsername, order.submittedByUsername].includes(admin.user?.username);
    if (order.status === "submitted" && can("purchases.approve") && !selfApproval) actions.push('<button class="primary-button" data-e-po-action="approve">Duyệt đơn mua</button>');
    if (["draft", "submitted", "approved"].includes(order.status) && can("purchases.write")) actions.push('<button class="plain-button danger-text" data-e-po-action="cancel">Hủy đơn mua</button>');
    const receive = ["approved", "partially_received"].includes(order.status) && can("inventory.write");
    showEditor("purchases", `<div class="section-heading"><div><p class="eyebrow">Đơn mua hàng</p><h2>${h(order.number)}</h2></div>${badge(order.status)}</div><div class="enterprise-detail-grid"><p>Nhà cung cấp<strong>${h(order.supplierName)}</strong></p><p>Kho nhận<strong>${h(order.warehouseName)}</strong></p><p>Người lập<strong>${h(order.createdByUsername || "—")}</strong></p><p>Người duyệt<strong>${h(order.approvedByUsername || "—")}</strong></p></div>${order.reference ? `<p class="help-text">Tham chiếu: ${h(order.reference)}</p>` : ""}${order.note ? `<p class="help-text">${h(order.note)}</p>` : ""}${table(["Sản phẩm / SKU", "Đặt mua", "Đã nhập", "Đơn giá", "Thành tiền"], (order.items || []).map((item) => row([`${h(item.productName)}<small>${h(item.variantName)} · ${h(item.sku)}</small>`, number(item.quantity), number(item.receivedQuantity), money(item.unitCostVnd), money(item.lineTotalVnd)])))}<p class="enterprise-total">Tổng giá trị đơn mua <strong>${money(order.totalVnd)}</strong></p><div class="enterprise-actions">${actions.join("")}<button class="plain-button" data-e-close>Đóng</button></div>${receive ? `<form class="form-grid receipt-form" data-e-form="receipt"><h3 class="span-all">Ghi nhận hàng thực nhận</h3><p class="help-text span-all">Chỉ ghi số lượng đã kiểm đếm. Có thể nhập nhiều đợt; số lượng còn lại sẽ tiếp tục chờ nhập.</p><input type="hidden" name="requestKey" value="${key()}">${field("Số phiếu / chứng từ", "reference", "", 'maxlength="120"')}${noteField()}<div class="span-all">${(order.items || []).filter((item) => item.quantity > item.receivedQuantity).map((item) => `<label class="receipt-line">${h(item.sku)} · ${h(item.variantName)}<span class="help-text">Còn chờ nhập: ${number(item.quantity - item.receivedQuantity)}</span><input type="number" data-receipt-item="${h(item.id)}" min="0" max="${item.quantity - item.receivedQuantity}" step="1" value="0"></label>`).join("")}</div>${submit("Kiểm tra & ghi nhận nhập kho")}</form>` : ""}`);
  }
  async function loadReceipts(page = 1) {
    const result = await api(`/goods-receipts?page=${page}`);
    document.querySelector("#receipt-list").innerHTML = result.receipts?.length ? table(["Phiếu nhập", "Đơn mua / kho", "Thời gian / người ghi", "Giá trị"], result.receipts.map((entry) => row([h(entry.number || entry.reference || "Phiếu nhập"), `${h(entry.purchaseOrderNumber || entry.purchaseNumber || "—")}<small>${h(entry.warehouseName)}</small>`, `${date(entry.createdAt)}<small>${h(entry.createdByUsername || entry.actorUsername || "—")}</small>`, money(entry.totalVnd)]))) + (result.pagination ? pager("receipts", result.pagination) : "") : empty("Chưa có phiếu nhập hàng.");
  }

  async function loadFinance() {
    mount("finance", `<div class="enterprise-intro"><p>Theo dõi tiền đã thu, tiền còn phải thu và công nợ nhà cung cấp. Các phiếu thu/chi chỉ ghi nhận giao dịch đã thực hiện bên ngoài hệ thống; không chuyển tiền qua ngân hàng.</p><button class="secondary-button" data-e-reload="finance">Tải lại số liệu</button></div><div class="enterprise-metrics" id="finance-metrics"></div><section class="editor-card" data-e-editor hidden></section><div id="finance-sections"></div>`);
    const [summaryResult, receivables, payables, payments, expenses, collections] = await Promise.all([
      api("/finance/summary"), api("/finance/receivables"), api("/finance/payables"), api("/finance/supplier-payments"), api("/finance/expenses"), api("/finance/customer-payments")
    ]);
    e.finance = { receivables: receivables.receivables || [], payables: payables.payables || [], payments: payments.payments || [], expenses: expenses.expenses || [], collections: collections.payments || [] };
    const summary = summaryResult.summary;
    document.querySelector("#finance-metrics").innerHTML = metricCards([
      ["Tiền khách đã trả", money(summary.salesPaidVnd)], ["Còn phải thu khách", money(summary.salesOutstandingVnd)], ["Giá trị hàng đã nhập", money(summary.purchasesReceivedVnd)], ["Đã trả nhà cung cấp", money(summary.supplierPaidVnd)], ["Còn phải trả nhà cung cấp", money(summary.supplierOutstandingVnd)]
    ]);
    document.querySelector("#finance-sections").innerHTML = `<section class="enterprise-section"><h2>Đơn hàng còn phải thu</h2><p class="help-text">Số dư trên các đơn chưa hủy. Thanh toán trực tuyến được cập nhật qua cổng thanh toán.</p>${renderReceivables(e.finance.receivables)}${receivables.pagination ? pager("receivables", receivables.pagination) : ""}</section><section class="enterprise-section"><div class="section-heading"><h2>Công nợ nhà cung cấp</h2>${can("finance.write") ? '<button class="primary-button" data-e-finance-new="supplier-payment">Ghi nhận trả nhà cung cấp</button>' : ""}</div>${e.finance.payables.length ? table(["Nhà cung cấp", "Hàng đã nhận", "Đã trả", "Còn phải trả"], e.finance.payables.map((entry) => row([h(entry.supplierName), money(entry.receivedVnd), money(entry.paidVnd), `<strong>${money(entry.outstandingVnd)}</strong>`]))) : empty("Chưa có công nợ nhà cung cấp.")}</section><section class="enterprise-section"><h2>Phiếu trả nhà cung cấp</h2><div id="supplier-payment-list">${renderPayments(e.finance.payments, "supplier-payment")}</div>${payments.pagination ? pager("supplier-payments", payments.pagination) : ""}</section><section class="enterprise-section"><div class="section-heading"><h2>Khoản chi vận hành</h2>${can("finance.write") ? '<button class="primary-button" data-e-finance-new="expense">Tạo phiếu chi</button>' : ""}</div><p class="help-text">Ghi nhận khoản chi thực tế; nhóm chi lương không thay thế nghiệp vụ tính lương.</p><div id="expense-list">${renderPayments(e.finance.expenses, "expense")}</div>${expenses.pagination ? pager("expenses", expenses.pagination) : ""}</section><section class="enterprise-section"><h2>Lịch sử thu tiền khách</h2><div id="collection-list">${renderPayments(e.finance.collections, "collection")}</div>${collections.pagination ? pager("collections", collections.pagination) : ""}</section>`;
  }
  function metricCards(entries) { return entries.map(([label, value]) => `<article class="stat-card"><span>${label}</span><strong>${value}</strong></article>`).join(""); }
  function renderReceivables(rows) {
    return rows.length ? table(["Đơn / khách hàng", "Tổng đơn", "Đã thu", "Còn phải thu", ""], rows.map((entry) => row([`<strong>${h(entry.orderNumber)}</strong><small>${h(entry.customerName)} · ${h(entry.phone)}</small><small>${h(statusNames[entry.status] || entry.status)}</small>`, money(entry.totalVnd), money(entry.receivedVnd), `<strong>${money(entry.outstandingVnd)}</strong>`, can("payments.write") && !["vnpay", "9pay"].includes(entry.paymentMethod) && (entry.paymentMethod !== "cod" || ["shipped", "completed"].includes(entry.status)) ? `<button class="row-button" data-e-collect="${h(entry.id)}">Ghi nhận thu</button>` : `<small>${["vnpay", "9pay"].includes(entry.paymentMethod) ? "Thu qua cổng thanh toán" : "Chờ giao hàng"}</small>`]))) : empty("Không có đơn hàng còn phải thu.");
  }
  function renderPayments(rows, type) {
    return rows.length ? table(["Phiếu / nội dung", "Số tiền", "Ngày / người lập", "Trạng thái", ""], rows.map((entry) => {
      const creator = entry.createdByUsername || entry.recordedByUsername || entry.createdBy || "—";
      const selfApproval = creator === admin.user?.username && !["owner", "admin"].includes(admin.user?.role);
      return row([`<strong>${h(entry.number || entry.reference || "Phiếu ghi nhận")}</strong><small>${h(entry.supplierName || entry.payee || entry.customerName || entry.orderNumber || "")}</small><small>${h(entry.method === "cash" ? "Tiền mặt" : "Chuyển khoản")}${entry.category ? ` · ${h(({ operations: "Vận hành", marketing: "Marketing", payroll: "Chi lương", other: "Khác" })[entry.category] || "Khoản chi")}` : ""}</small>${entry.note ? `<small>${h(entry.note)}</small>` : ""}`, money(entry.amountVnd), `${date(entry.createdAt)}<small>${h(creator)}</small>`, badge(entry.status || "posted"), type !== "collection" && entry.status === "submitted" && can("finance.approve") ? (selfApproval ? '<small>Chờ người khác duyệt</small>' : `<button class="row-button" data-e-finance-approve="${type}" data-id="${h(entry.id)}">Duyệt ghi nhận</button>`) : ""]);
    })) : empty("Chưa có phiếu ghi nhận.");
  }
  async function financeEditor(type, orderId = "") {
    if (!can(type === "collection" ? "payments.write" : "finance.write")) return;
    if (type === "supplier-payment") await lookups({ suppliers: true });
    const order = e.finance.receivables.find((entry) => entry.id === orderId);
    const suppliers = e.lookup.suppliers.length ? e.lookup.suppliers : e.finance.payables.map((entry) => ({ id: entry.supplierId, name: entry.supplierName }));
    const title = { "supplier-payment": "Ghi nhận trả nhà cung cấp", expense: "Ghi nhận khoản chi", collection: "Ghi nhận thu tiền khách" }[type];
    showEditor("finance", `<h2>${title}</h2><p class="editor-guidance">Chỉ ghi số tiền đã thực thu hoặc thực chi bên ngoài hệ thống. Thao tác này không thực hiện chuyển tiền.${type !== "collection" ? " Phiếu sẽ được trình duyệt trước khi ghi nhận vào số liệu." : ""}</p><form class="form-grid" data-e-form="${type}"><input type="hidden" name="requestKey" value="${key()}">${type === "supplier-payment" ? select("Nhà cung cấp", "supplierId", '<option value="">Chọn nhà cung cấp</option>' + options(suppliers), "required") : type === "expense" ? select("Nhóm chi", "category", '<option value="operations">Vận hành</option><option value="marketing">Marketing</option><option value="payroll">Chi lương đã thanh toán</option><option value="other">Khác</option>') + field("Người / đơn vị nhận", "payee", "", 'required maxlength="160"') : `<input name="orderId" type="hidden" value="${h(orderId)}"><p class="span-all"><strong>${h(order?.orderNumber)} · ${h(order?.customerName)}</strong><br>Còn phải thu: ${money(order?.outstandingVnd)}</p>`}${field("Số tiền thực tế (₫)", "amountVnd", type === "collection" ? order?.outstandingVnd : "", `type="number" min="1" step="1" required ${type === "collection" ? `max="${Number(order?.outstandingVnd || 0)}"` : ""}`)}${select("Phương thức thực tế", "method", '<option value="bank_transfer">Chuyển khoản</option><option value="cash">Tiền mặt</option>')}${field("Số chứng từ / tham chiếu", "reference", "", 'maxlength="160"')}${noteField()}${submit(type === "collection" ? "Xác nhận tiền đã thu" : "Lưu & trình duyệt")}</form>`);
  }
  async function financePage(type, page) {
    const definitions = { receivables: ["/finance/receivables", "receivables", renderReceivables], "supplier-payments": ["/finance/supplier-payments", "payments", (rows) => renderPayments(rows, "supplier-payment")], expenses: ["/finance/expenses", "expenses", (rows) => renderPayments(rows, "expense")], collections: ["/finance/customer-payments", "payments", (rows) => renderPayments(rows, "collection")] };
    const [path, property, render] = definitions[type], result = await api(`${path}?page=${page}`);
    const selectors = { receivables: null, "supplier-payments": "#supplier-payment-list", expenses: "#expense-list", collections: "#collection-list" };
    if (type === "receivables") {
      e.finance.receivables = result.receivables || [];
      const section = document.querySelector("#finance-sections .enterprise-section");
      section.querySelector(".enterprise-table-wrap,.empty-message").outerHTML = renderReceivables(e.finance.receivables);
      section.querySelector(".pagination").outerHTML = pager(type, result.pagination);
      return;
    }
    const target = document.querySelector(selectors[type]); target.innerHTML = render(result[property] || []);
    target.nextElementSibling.outerHTML = pager(type, result.pagination);
  }

  async function loadStaff() {
    await lookups({ departments: true });
    mount("staff", listShell("staff", "Tài khoản riêng cho từng nhân viên. Vai trò quyết định quyền truy cập; khóa tài khoản sẽ chặn các phiên làm việc của nhân viên.", can("staff.write") ? '<button class="primary-button" data-e-new="staff">+ Thêm nhân viên</button>' : ""));
    await loadList("staff", "/staff", "staff", (rows, result) => {
      e.roles = result.roles || [];
      return rows.length ? table(["Nhân viên", "Phòng ban / vai trò", "Trạng thái", ""], rows.map((entry) => row([`<strong>${h(entry.fullName)}</strong><small>${h(entry.username)}</small>`, `${h(entry.departmentName || "Chưa phân phòng ban")}<small>${h(roleNames[entry.role] || entry.role)}</small>`, `<span class="status-pill ${entry.active ? "status-active" : "status-cancelled"}">${entry.active ? "Đang làm việc" : "Đã khóa"}</span>`, can("staff.write") ? editButton("staff", entry.id) : ""]))) : empty("Chưa có nhân viên phù hợp.");
    });
  }
  function staffEditor(entry = null) {
    if (!can("staff.write")) return;
    const roles = Array.isArray(e.roles) ? e.roles.filter((item) => item.assignable !== false).map((item) => typeof item === "string" ? { value: item, label: roleNames[item] || item } : { value: item.key || item.role || item.id || item.name, label: item.label || roleNames[item.key || item.role || item.id || item.name] || item.name }) : Object.entries(e.roles).map(([value, item]) => ({ value, label: typeof item === "string" ? item : item.label || roleNames[value] || value }));
    showEditor("staff", `<h2>${entry ? "Chỉnh sửa nhân viên" : "Thêm nhân viên"}</h2><form class="form-grid" data-e-form="staff"><input type="hidden" name="id" value="${h(entry?.id || "")}"><input type="hidden" name="version" value="${h(entry?.version || "")}">${field("Họ và tên", "fullName", entry?.fullName || "", 'required maxlength="160"')}${entry ? `<p>Tên đăng nhập<strong class="display-value">${h(entry.username)}</strong></p>` : field("Tên đăng nhập", "username", "", 'required minlength="3" maxlength="80" autocomplete="off"')}${select("Vai trò", "role", roles.map((item) => `<option value="${h(item.value)}" ${entry?.role === item.value ? "selected" : ""}>${h(item.label)}</option>`).join(""), "required")}${select("Phòng ban", "departmentId", '<option value="">Chưa phân phòng ban</option>' + options(e.lookup.departments, entry?.departmentId))}${field(entry ? "Mật khẩu mới (để trống nếu giữ nguyên)" : "Mật khẩu ban đầu", "password", "", `type="password" minlength="12" maxlength="200" autocomplete="new-password" ${entry ? "" : "required"}`)}${entry ? `<label class="checkbox-label"><input type="checkbox" name="active" ${entry.active ? "checked" : ""}> Cho phép đăng nhập</label>` : ""}<p class="help-text span-all">Mật khẩu tối thiểu 12 ký tự. Thay đổi vai trò, mật khẩu hoặc khóa tài khoản có hiệu lực với các phiên đăng nhập đang hoạt động.</p>${submit("Lưu nhân viên")}</form>`);
    const form = root("staff").querySelector('[data-e-form="staff"]');
    form.querySelector('[name="role"]').closest("label").insertAdjacentHTML("afterend", '<div class="role-permissions span-all" data-role-permissions></div>');
    renderRolePermissions(form);
  }
  function renderRolePermissions(form) {
    const role = Array.isArray(e.roles) ? e.roles.find((item) => item.id === form.elements.role.value) : null;
    const scopes = { dashboard: "Tổng quan", catalog: "Sản phẩm", inventory: "Kho hàng", orders: "Đơn bán", payments: "Thu tiền khách", customers: "Khách hàng", suppliers: "Nhà cung cấp", purchases: "Mua hàng", finance: "Tài chính", reports: "Báo cáo", staff: "Nhân viên", audit: "Nhật ký", settings: "Cài đặt" };
    const grouped = {};
    for (const permission of role?.permissions || []) {
      const [scope, action] = permission.split(".");
      (grouped[scope] ||= []).push(({ read: "xem", write: "thao tác", approve: "duyệt" })[action]);
    }
    form.querySelector("[data-role-permissions]").innerHTML = `<strong>Quyền của vai trò</strong><div>${Object.entries(grouped).map(([scope, actions]) => `<span>${scopes[scope] || "Nghiệp vụ"}: ${actions.join(", ")}</span>`).join("")}</div>`;
  }

  async function loadReports() {
    mount("reports", `<div class="enterprise-intro"><p>Chỉ số vận hành từ đơn hàng và các phiếu đã ghi nhận. Đây không phải báo cáo kế toán theo chuẩn pháp định.</p></div><form class="enterprise-filters" data-e-filter="reports">${field("Từ ngày", "from", "", 'type="date" required')}${field("Đến ngày", "to", "", 'type="date" required')}<button class="primary-button">Xem báo cáo</button></form><p class="list-status" data-e-status aria-live="polite"></p><div id="report-content"></div>`);
    const form = root("reports").querySelector("form");
    if (!form.elements.from.value) {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      form.elements.to.value = today; form.elements.from.value = `${today.slice(0, 7)}-01`;
    }
    const params = new URLSearchParams(new FormData(form));
    if (form.elements.from.value > form.elements.to.value) throw new Error("Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.");
    root("reports").querySelector("[data-e-status]").textContent = "Đang tính báo cáo…";
    const result = await api(`/reports/overview?${params}`), summary = result.summary;
    root("reports").querySelector("[data-e-status]").textContent = `Từ ${form.elements.from.value} đến ${form.elements.to.value} · Múi giờ Việt Nam`;
    document.querySelector("#report-content").innerHTML = `<div class="enterprise-metrics">${metricCards([["Số đơn trong kỳ", number(summary.orderCount)], ["Giá trị đơn", money(summary.orderValueVnd)], ["Tiền khách đã trả", money(summary.collectedVnd)], ["Còn phải thu", money(summary.outstandingVnd)], ["Đơn hoàn tất", number(summary.completedCount)], ["Đơn đã hủy", number(summary.cancelledCount)], ["Giá trị hàng nhập", money(summary.purchaseReceivedVnd)], ["Đã trả nhà cung cấp", money(summary.supplierPaidVnd)]])}</div><section class="enterprise-section"><h2>Theo ngày</h2>${result.daily?.length ? table(["Ngày", "Số đơn", "Giá trị đơn", "Tiền đã thu"], result.daily.map((entry) => row([h(String(entry.date).slice(0, 10)), number(entry.orderCount), money(entry.orderValueVnd), money(entry.collectedVnd)]))) : empty("Không có dữ liệu trong kỳ.")}</section><section class="enterprise-section"><h2>Sản phẩm bán ra</h2>${result.topProducts?.length ? table(["Sản phẩm", "Số lượng", "Giá trị bán"], result.topProducts.map((entry) => row([h(entry.productName), number(entry.quantity), money(entry.salesVnd)]))) : empty("Chưa có sản phẩm bán ra trong kỳ.")}</section><section class="enterprise-section"><h2>Tồn kho hiện tại</h2><div class="enterprise-metrics">${metricCards([["Kho hàng", number(result.inventory?.warehouseCount)], ["Phiên bản", number(result.inventory?.variantCount)], ["Tổng số lượng", number(result.inventory?.availableQuantity)], ["Phiên bản tồn thấp", number(result.inventory?.lowStockCount)]])}</div></section>`;
  }
  async function loadAudit() {
    mount("audit", `<div class="enterprise-intro"><p>Theo dõi người thực hiện, thời điểm và nghiệp vụ. Nhật ký được lưu từ khi hệ thống bắt đầu ghi nhận.</p></div><form class="enterprise-filters" data-e-filter="audit">${select("Nghiệp vụ", "action", '<option value="">Tất cả nghiệp vụ</option>' + Object.entries(actionNames).map(([value, label]) => `<option value="${h(value)}">${h(label)}</option>`).join(""))}${select("Nhóm dữ liệu", "entityType", '<option value="">Tất cả nhóm</option>' + Object.entries(entityNames).map(([value, label]) => `<option value="${h(value)}">${h(label)}</option>`).join(""))}${field("Từ ngày", "from", "", 'type="date"')}${field("Đến ngày", "to", "", 'type="date"')}<button class="secondary-button" type="submit">Áp dụng</button><button class="plain-button" type="button" data-e-reset="audit">Xóa lọc</button></form><p class="list-status" data-e-status aria-live="polite"></p><div data-e-list></div><div data-e-pagination></div>`);
    await loadList("audit", "/audit-logs", "events", (rows) => rows.length ? table(["Thời điểm", "Người thực hiện", "Nghiệp vụ", "Bản ghi / nội dung"], rows.map((entry) => row([date(entry.createdAt), `${h(entry.actorName || entry.actorUsername || "Hệ thống")}<small>${h(entry.actorUsername || "")}</small>`, h(actionNames[entry.action] || "Nghiệp vụ hệ thống"), `${h(entityNames[entry.entityType] || "Bản ghi")}<small>${h(entry.entityId || "")}</small>${auditChanges(entry)}`]))) : empty("Chưa có nhật ký phù hợp."));
  }

  function auditChanges(entry) {
    const names = { fullName: "Họ và tên", username: "Tên đăng nhập", name: "Tên", code: "Mã", role: "Vai trò", active: "Hoạt động", status: "Trạng thái", paymentStatus: "Thanh toán", stockQuantity: "Tồn kho", quantity: "Số lượng", delta: "Chênh lệch", reason: "Lý do", amountVnd: "Số tiền", totalVnd: "Tổng tiền", priceVnd: "Giá bán", reference: "Tham chiếu", note: "Ghi chú", method: "Phương thức", departmentName: "Phòng ban", email: "Email", phone: "Điện thoại", address: "Địa chỉ" };
    const before = entry.before || {}, after = entry.after || entry.metadata || {};
    const display = (value, name) => value == null ? "—" : typeof value === "boolean" ? (value ? "Có" : "Không") : /Vnd$/.test(name) ? money(value) : name === "role" ? (roleNames[value] || value) : name === "status" ? (statusNames[value] || value) : name === "method" ? (value === "cash" ? "Tiền mặt" : "Chuyển khoản") : value;
    const changes = Object.keys(names).filter((name) => (Object.hasOwn(before, name) || Object.hasOwn(after, name)) && before[name] !== after[name]);
    if (!changes.length) return "";
    return `<details class="audit-changes"><summary>Xem nội dung</summary><dl>${changes.map((name) => `<div><dt>${names[name]}</dt><dd>${h(display(before[name], name))} → ${h(display(after[name], name))}</dd></div>`).join("")}</dl></details>`;
  }

  async function loadView(view) {
    if (definitions[view]) return loadEntity(view);
    if (view === "inventory") return loadInventory();
    if (view === "purchases") return loadPurchases();
    if (view === "finance") return loadFinance();
    if (view === "reports") return loadReports();
    if (view === "staff") return loadStaff();
    if (view === "audit") return loadAudit();
  }
  async function saveForm(form) {
    const action = form.dataset.eForm, values = formValues(form);
    if (action === "entity") {
      const view = form.dataset.view, definition = definitions[view];
      if (!can(definition.write)) throw new Error("Bạn chưa có quyền sửa thông tin này.");
      const payload = Object.fromEntries(definition.fields.map((item) => [item.name, String(values[item.name] || "").trim()]));
      payload.active = values.id ? Boolean(values.active) : true;
      if (view === "departments" && values.id) payload.version = Number(values.version);
      await api(`${definition.path}${values.id ? `/${encodeURIComponent(values.id)}` : ""}`, { method: values.id ? "PATCH" : "POST", body: JSON.stringify(payload) });
      form.closest("[data-e-editor]").hidden = true; await loadEntity(view);
    } else if (action === "staff") {
      if (!can("staff.write")) throw new Error("Bạn chưa có quyền quản lý nhân viên.");
      const payload = { fullName: values.fullName.trim(), role: values.role, departmentId: values.departmentId || null };
      if (values.id) { payload.version = Number(values.version); payload.active = Boolean(values.active); }
      else payload.username = values.username.trim();
      if (values.password) {
        if (new TextEncoder().encode(values.password).length > 72) throw new Error("Mật khẩu quá dài. Hãy dùng tối đa 72 byte; ký tự có dấu có thể chiếm nhiều byte.");
        payload.password = values.password;
      }
      if (values.id && (!payload.active || values.password) && !await confirmAction("Lưu thay đổi tài khoản? Các phiên đăng nhập hiện tại của nhân viên có thể bị kết thúc.", form.querySelector('[type="submit"]'))) return false;
      await api(`/staff${values.id ? `/${encodeURIComponent(values.id)}` : ""}`, { method: values.id ? "PATCH" : "POST", body: JSON.stringify(payload) });
      form.closest("[data-e-editor]").hidden = true; await loadStaff();
    } else if (["adjustment", "transfer"].includes(action)) {
      if (!can(action === "adjustment" ? "inventory.approve" : "inventory.write")) throw new Error("Bạn chưa có quyền thực hiện nghiệp vụ kho này.");
      if (values.reason.trim().length < 5) throw new Error("Nhập lý do rõ ràng, ít nhất 5 ký tự.");
      const payload = { variantId: values.variantId, reason: values.reason.trim(), requestKey: values.requestKey };
      if (action === "adjustment") {
        Object.assign(payload, { warehouseId: values.warehouseId, delta: Number(values.delta), expectedQuantity: Number(values.expectedQuantity) });
        if (!payload.delta) throw new Error("Chênh lệch phải khác 0.");
        if (payload.expectedQuantity + payload.delta < 0) throw new Error("Tồn kho sau điều chỉnh không thể âm.");
        if (!await confirmAction(`Ghi nhận điều chỉnh ${payload.delta > 0 ? "+" : ""}${payload.delta} sản phẩm? Tồn kho đã kiểm tra: ${payload.expectedQuantity} → ${payload.expectedQuantity + payload.delta}.`, form.querySelector('[type="submit"]'))) return false;
      } else {
        Object.assign(payload, { fromWarehouseId: values.fromWarehouseId, toWarehouseId: values.toWarehouseId, quantity: Number(values.quantity) });
        if (payload.fromWarehouseId === payload.toWarehouseId) throw new Error("Kho nguồn và kho đích phải khác nhau.");
        if (!await confirmAction(`Điều chuyển ${payload.quantity} sản phẩm? Tồn kho nguồn sẽ giảm và kho đích sẽ tăng tương ứng.`, form.querySelector('[type="submit"]'))) return false;
      }
      await api(`/inventory/${action === "adjustment" ? "adjustments" : "transfers"}`, { method: "POST", body: JSON.stringify(payload) });
      form.closest("[data-e-editor]").hidden = true; await loadInventory(); await loadMovements();
    } else if (action === "purchase") {
      if (!can("purchases.write")) throw new Error("Bạn chưa có quyền lập đơn mua.");
      if (values.reference.trim().length > 120) throw new Error("Số tham chiếu chỉ được dài tối đa 120 ký tự.");
      const items = [...form.querySelectorAll(".purchase-line")].map((line) => ({ variantId: line.querySelector('[name="variantId"]').value, quantity: Number(line.querySelector('[name="quantity"]').value), unitCostVnd: Number(line.querySelector('[name="unitCostVnd"]').value) }));
      if (!items.length) throw new Error("Thêm ít nhất một dòng sản phẩm.");
      if (new Set(items.map((item) => item.variantId)).size !== items.length) throw new Error("Mỗi phiên bản chỉ nên có một dòng. Gộp số lượng của các dòng trùng SKU.");
      const result = await api("/purchase-orders", { method: "POST", body: JSON.stringify({ supplierId: values.supplierId, warehouseId: values.warehouseId, reference: values.reference.trim(), note: values.note.trim(), items }) });
      await loadPurchases();
      const id = result.purchaseOrder?.id || result.id;
      if (id) await purchaseDetail(id); else form.closest("[data-e-editor]").hidden = true;
    } else if (action === "receipt") {
      if (!can("inventory.write")) throw new Error("Bạn chưa có quyền nhập kho.");
      if (values.reference.trim().length > 120) throw new Error("Số phiếu chỉ được dài tối đa 120 ký tự.");
      const items = [...form.querySelectorAll("[data-receipt-item]")].map((input) => ({ itemId: input.dataset.receiptItem, quantity: Number(input.value) })).filter((item) => item.quantity > 0);
      if (!items.length) throw new Error("Nhập số lượng thực nhận cho ít nhất một dòng.");
      if (!await confirmAction(`Ghi nhận ${items.reduce((sum, item) => sum + item.quantity, 0)} sản phẩm vào kho? Kiểm tra chứng từ và số lượng trước khi xác nhận.`, form.querySelector('[type="submit"]'))) return false;
      const id = e.activePurchase.id;
      await api(`/purchase-orders/${encodeURIComponent(id)}/receipts`, { method: "POST", body: JSON.stringify({ requestKey: values.requestKey, reference: values.reference.trim(), note: values.note.trim(), items }) });
      await loadPurchases(); await purchaseDetail(id); await loadReceipts();
    } else if (["supplier-payment", "expense", "collection"].includes(action)) {
      if (!can(action === "collection" ? "payments.write" : "finance.write")) throw new Error("Bạn chưa có quyền ghi nhận giao dịch này.");
      const payload = { amountVnd: Number(values.amountVnd), method: values.method, reference: values.reference.trim(), note: values.note.trim(), requestKey: values.requestKey };
      if (action === "supplier-payment") payload.supplierId = values.supplierId;
      if (action === "expense") Object.assign(payload, { category: values.category, payee: values.payee.trim() });
      if (action === "collection") payload.orderId = values.orderId;
      if (action === "collection") {
        const order = e.finance.receivables.find((item) => item.id === values.orderId);
        if (order?.paymentMethod === "cod" && payload.amountVnd !== Number(order.outstandingVnd)) throw new Error("Đơn COD cần ghi nhận đủ số tiền còn phải thu sau khi giao hàng.");
      }
      if (!await confirmAction(`${action === "collection" ? "Xác nhận đã thực thu" : "Trình duyệt ghi nhận khoản đã thực chi"} ${money(payload.amountVnd)}? Hệ thống chỉ lưu chứng từ, không chuyển tiền.`, form.querySelector('[type="submit"]'))) return false;
      const path = { "supplier-payment": "supplier-payments", expense: "expenses", collection: "customer-payments" }[action];
      await api(`/finance/${path}`, { method: "POST", body: JSON.stringify(payload) });
      form.closest("[data-e-editor]").hidden = true; await loadFinance();
    }
    return true;
  }

  document.addEventListener("submit", async (event) => {
    const form = event.target.closest(".enterprise-view form");
    if (!form) return;
    event.preventDefault();
    if (form.dataset.eFilter) {
      const view = form.dataset.eFilter; viewState(view).page = 1;
      try { await loadView(view); } catch (error) { admin.showGlobal(error.message, true); }
      return;
    }
    if (!form.dataset.eForm || form.dataset.saving) return;
    form.dataset.saving = "true";
    const buttons = [...form.querySelectorAll("button")];
    buttons.forEach((button) => { button.disabled = true; });
    formMessage(form, "");
    try { if (await saveForm(form)) admin.showGlobal("Đã lưu nghiệp vụ thành công."); }
    catch (error) { formMessage(form, error.message); }
    finally { delete form.dataset.saving; buttons.forEach((button) => { button.disabled = false; }); }
  });
  document.addEventListener("click", async (event) => {
    const button = event.target.closest(".enterprise-view button");
    if (!button || button.disabled || (button.type === "submit" && button.form)) return;
    const view = button.closest(".enterprise-view").id.replace(/-view$/, "");
    try {
      if (button.hasAttribute("data-e-close")) button.closest("[data-e-editor]").hidden = true;
      else if (button.dataset.eNew) {
        if (button.dataset.eNew === "purchase") await purchaseEditor();
        else if (button.dataset.eNew === "staff") staffEditor();
        else entityEditor(button.dataset.eNew);
      } else if (button.dataset.eEdit) {
        const entry = viewState(button.dataset.eEdit).rows.find((item) => item.id === button.dataset.id);
        if (button.dataset.eEdit === "staff") staffEditor(entry); else entityEditor(button.dataset.eEdit, entry);
      } else if (button.dataset.eReset) {
        root(view).querySelector(`[data-e-filter="${view}"]`).reset(); viewState(view).page = 1; await loadView(view);
      } else if (button.dataset.ePage) {
        const target = button.dataset.ePage, page = Number(button.dataset.page);
        if (target === "movements") await loadMovements(page);
        else if (target === "receipts") await loadReceipts(page);
        else if (["receivables", "supplier-payments", "expenses", "collections"].includes(target)) await financePage(target, page);
        else { viewState(target).page = page; await loadView(target); }
      } else if (button.dataset.eInventory) await inventoryEditor(button.dataset.eInventory);
      else if (button.hasAttribute("data-e-adjust-row")) await inventoryEditor("adjustment", viewState("inventory").rows[Number(button.dataset.eAdjustRow)]);
      else if (button.hasAttribute("data-e-movements")) await loadMovements();
      else if (button.hasAttribute("data-e-receipts")) await loadReceipts();
      else if (button.dataset.ePurchase) await purchaseDetail(button.dataset.ePurchase);
      else if (button.hasAttribute("data-e-add-line")) button.closest("form").querySelector(".purchase-lines").insertAdjacentHTML("beforeend", purchaseLine());
      else if (button.hasAttribute("data-e-remove-line")) button.closest(".purchase-line").remove();
      else if (button.dataset.ePoAction) {
        const action = button.dataset.ePoAction, id = e.activePurchase?.id;
        if (!id || !await confirmAction(({ submit: "Trình duyệt đơn mua này?", approve: "Duyệt đơn mua này để cho phép nhập hàng?", cancel: "Hủy đơn mua này? Đơn đã hủy không thể tiếp tục nhập hàng." })[action], button)) return;
        button.disabled = true;
        await api(`/purchase-orders/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" });
        await loadPurchases(); await purchaseDetail(id); admin.showGlobal("Đã cập nhật đơn mua.");
      } else if (button.dataset.eFinanceNew) await financeEditor(button.dataset.eFinanceNew);
      else if (button.dataset.eCollect) await financeEditor("collection", button.dataset.eCollect);
      else if (button.dataset.eFinanceApprove) {
        if (!can("finance.approve") || !await confirmAction("Duyệt ghi nhận khoản tiền đã thực chi? Kiểm tra chứng từ và người lập trước khi duyệt; thao tác này không chuyển tiền.", button)) return;
        button.disabled = true;
        await api(`/finance/${button.dataset.eFinanceApprove === "expense" ? "expenses" : "supplier-payments"}/${encodeURIComponent(button.dataset.id)}/approve`, { method: "POST", body: "{}" });
        await loadFinance(); admin.showGlobal("Đã duyệt và ghi nhận chứng từ.");
      } else if (button.dataset.eReload) await loadView(button.dataset.eReload);
    } catch (error) { button.disabled = false; admin.showGlobal(error.message, true); }
  });
  document.addEventListener("change", (event) => {
    if (event.target.matches('.enterprise-view [data-e-form="staff"] [name="role"]')) renderRolePermissions(event.target.closest("form"));
  });
  window.GAERUEnterprise = Object.freeze({ loadView });
})();
