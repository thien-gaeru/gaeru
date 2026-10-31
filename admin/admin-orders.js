// admin/admin-orders.js — Quản lý đơn hàng, cập nhật thời gian thực, xử lý/hoàn trả/khôi phục/xóa đơn, in & xuất tệp

function orderEditing() {
  return state.selectedOrders.size > 0
    || Boolean(document.querySelector("dialog[open]"))
    || Boolean(document.activeElement?.closest("#orders-view input,#orders-view select,#orders-view textarea,#order-review,#after-sales-panel"));
}

let orderSnapshot = "";

async function loadOrders(page = state.orderPage, { background = false } = {}) {
  if (!can("orders.read")) return;
  const root = document.querySelector("#order-list");
  if (background && (root.getAttribute("aria-busy") === "true" || document.querySelector("#orders-view").hidden)) return;
  const requestId = ++state.orderRequest;
  if (!background) {
    state.selectedOrders.clear();
    document.querySelectorAll("[data-select-order]").forEach((input) => { input.checked = false; });
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
    if (
      requestId !== state.orderRequest
      || status !== document.querySelector("#order-filter").value
      || search !== document.querySelector("#order-search").value.trim()
      || paymentStatus !== document.querySelector("#order-payment-filter").value
      || paymentMethod !== document.querySelector("#order-method-filter").value
      || params.get("sort") !== (document.querySelector("#order-sort").value || "newest")
      || params.get("pageSize") !== (document.querySelector("#order-page-size").value || "25")
    ) return;
    const snapshot = JSON.stringify(result);
    if (background) {
      if (document.hidden || document.querySelector("#orders-view").hidden) return;
      if (snapshot === orderSnapshot) return;
      if (orderEditing()) {
        document.querySelector("#order-live-status").textContent =
          "Có cập nhật đơn hàng. Sẽ tự cập nhật sau khi bạn hoàn tất thao tác hoặc bỏ chọn đơn.";
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
    if (typeof document?.dispatchEvent === "function") {
      try {
        const ev = typeof CustomEvent === "function"
          ? new CustomEvent("gaeru:orders-loaded")
          : (typeof Event === "function" ? new Event("gaeru:orders-loaded") : null);
        if (ev) document.dispatchEvent(ev);
      } catch {}
    }
    document.querySelector("#order-live-status").textContent =
      "Tự cập nhật mỗi 15 giây" + (background ? " · Đã cập nhật lúc " + new Date().toLocaleTimeString("vi-VN") : "");
  } catch (error) {
    if (requestId === state.orderRequest) {
      document.querySelector(background ? "#order-live-status" : "#order-list-status").textContent =
        background ? "Mất kết nối cập nhật. Hệ thống sẽ tự thử lại." : "Chưa tải được đơn hàng. Nhấn Tải lại để thử lại.";
    }
    throw error;
  } finally {
    if (requestId === state.orderRequest) root.setAttribute("aria-busy", "false");
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const poll = window.GAERUCareLive.poll({
    delay: 15000,
    active: () => Boolean(state.session) && !document.querySelector("#admin-app").hidden && can("orders.read")
      && (!document.querySelector("#orders-view").hidden || !document.querySelector("#overview-view").hidden),
    run: () => document.querySelector("#orders-view").hidden
      ? loadSummary()
      : Promise.all([loadOrders(state.orderPage, { background: true }), loadSummary()]),
    status: (message) => {
      if (message.includes("Phiên")) document.querySelector("#order-live-status").textContent = message;
    }
  });
  window.addEventListener("focus", poll.refresh);
  window.addEventListener("pagehide", (event) => { if (!event.persisted) poll.stop(); });
  window.addEventListener("pageshow", poll.refresh);
});

function isLiveVnpayAttempt(order) {
  return ["vnpay", "9pay", "momo", "zalopay"].includes(order.paymentMethod)
    && order.paymentAttemptStatus === "pending"
    && (!order.paymentAttemptExpiresAt || new Date(order.paymentAttemptExpiresAt).getTime() > Date.now());
}

function canEditShipping(order) {
  return can("orders.write")
    && order.status === "pending"
    && order.paymentStatus !== "paid"
    && !(Number(order.receivedVnd) > 0)
    && !(order.paymentMethod === "vnpay" && (order.paymentProvider || order.paymentAttemptStatus));
}

function orderPaymentControl(order) {
  const paymentLabel = order.paymentStatus === "paid"
    ? "Đã thanh toán"
    : Number(order.receivedVnd) > 0
      ? "Đã thu một phần"
      : "Chưa thanh toán";
  if (["vnpay", "9pay", "momo", "zalopay"].includes(order.paymentMethod)) {
    return `<div class="order-payment-readonly"><span>Thanh toán</span><strong>${paymentLabel}</strong><small>Trạng thái được cập nhật tự động từ cổng thanh toán.</small></div>`;
  }
  if (!can("payments.write") || order.paymentStatus === "paid" || ["cancelled", "completed"].includes(order.status)) {
    return `<div class="order-payment-readonly"><span>Thanh toán</span><strong>${paymentLabel}</strong><small>${order.paymentStatus === "paid" ? "Đã ghi nhận thu tiền." : "Trạng thái hiện tại của đơn hàng."}</small></div>`;
  }
  return `<label>Thanh toán<select name="paymentStatus" ${order.paymentMethod === "cod" ? "disabled" : ""}><option value="pending">Chưa thanh toán</option><option value="paid">Đã thanh toán</option></select><span class="help-text" data-payment-guidance>${order.paymentMethod === "cod" ? "Chỉ ghi nhận thu tiền khi hoàn tất giao hàng." : "Chỉ xác nhận khi đã đối soát và nhận đủ tiền."}</span></label>`;
}

function changeOrderControl(event) {
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

async function startOrderReturn(id) {
  const order = state.orders.find((o) => o.id === id);
  if (!can("orders.write") || !order || !["shipped", "completed"].includes(order.status)) return;
  closeOrderProcessing();
  try {
    await window.GAERUAfterSales.createReturn(order);
  } catch (error) {
    showGlobal(error.message, true);
  }
}

function closeOrderProcessing() {
  const dialog = document.getElementById("order-processing-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  dialog.remove();
}

function openOrderProcessing(id, opener) {
  const order = state.orders.find((o) => o.id === id);
  const body = document.getElementById("order-body-" + id);
  if (!order || !body) return;
  if (order.returnStatus === "returned" || order.returnedAt) {
    return showGlobal("Đơn đã hoàn trả xong; không thể xử lý lại.", true);
  }
  closeOrderProcessing();
  const dialog = document.createElement("dialog");
  dialog.id = "order-processing-dialog";
  dialog.className = "order-processing-dialog";
  dialog.setAttribute("aria-labelledby", "order-processing-title");
  const steps = ["pending", "confirmed", "processing", "shipped", "completed"];
  const current = steps.indexOf(order.status);
  dialog.innerHTML =
    '<header><div><p>Xử lý đơn hàng</p><h2 id="order-processing-title">' + escapeHtml(order.orderNumber) + '</h2></div><button type="button" class="secondary-button" data-close-order aria-label="Đóng xử lý đơn">×</button></header>' +
    '<ol class="order-process-steps">' + steps.map((key, index) => '<li class="' + (index === current ? "current" : index < current ? "done" : "") + '">' + escapeHtml(labels[key]) + "</li>").join("") + "</ol>" +
    '<div class="order-processing-content">' + body.innerHTML + "</div>";
  if (order.reviewReason) {
    const callout = document.createElement("div");
    callout.className = "order-review-callout";
    callout.style.cssText = "background:#fff8ed;border:1px solid #f0dfbd;border-radius:8px;padding:12px;margin:12px 0;font-size:13px;color:#856404;";
    callout.innerHTML =
      "<strong>⚠️ Đơn đang chờ xác minh qua điện thoại:</strong> " + escapeHtml(reviewReasonLabels[order.reviewReason] || order.reviewReason) +
      ".<br>Vui lòng gọi khách <strong>" + escapeHtml(order.phone) + "</strong> trước khi xác nhận đơn." +
      '<div style="margin-top:8px"><button type="button" class="secondary-button" data-focus-review="' + escapeHtml(order.id) + '">Mở mục xác minh để ghi kết quả</button></div>';
    dialog.querySelector(".order-processing-content").prepend(callout);
  }
  if (can("orders.write") && order.status === "completed" && order.returnStatus !== "open") {
    const action = document.createElement("div");
    action.className = "order-return-action";
    action.innerHTML = '<button class="secondary-button" type="button" data-return-order="' + escapeHtml(order.id) + '">Ghi nhận hoàn trả hàng</button>';
    dialog.querySelector(".order-processing-content").prepend(action);
  }
  if (can("orders.write")) {
    const dangerZone = document.createElement("div");
    dangerZone.className = "order-danger-zone";
    dangerZone.style.cssText = "margin-top:16px;padding-top:14px;border-top:1px solid #fee4e2;display:flex;justify-content:flex-end";
    dangerZone.innerHTML = '<button type="button" class="order-delete-button" data-permanent-delete-order="' + escapeHtml(order.id) + '">Xóa vĩnh viễn đơn hàng</button>';
    dialog.querySelector(".order-processing-content").append(dangerZone);
  }
  dialog.addEventListener("click", (event) => {
    const button = event.target.closest("[data-return-order]");
    if (button) startOrderReturn(button.dataset.returnOrder);
    const focusReview = event.target.closest("[data-focus-review]");
    if (focusReview) {
      closeOrderProcessing();
      const reviewDetails = document.querySelector("#order-review");
      if (reviewDetails) {
        reviewDetails.open = true;
        reviewDetails.scrollIntoView({ behavior: "smooth", block: "start" });
        reviewDetails.dispatchEvent(new Event("toggle"));
      }
    }
    const del = event.target.closest("[data-permanent-delete-order]");
    if (del) {
      closeOrderProcessing();
      handleOrderPermanentDeleteUI(del.dataset.permanentDeleteOrder);
    }
  });
  const statusSelect = dialog.querySelector('select[name="status"]');
  if (statusSelect) {
    const choices = document.createElement("fieldset");
    choices.className = "order-status-buttons";
    choices.innerHTML =
      "<legend>Bước tiếp theo</legend>" +
      [...statusSelect.options]
        .filter((option) => option.value !== order.status)
        .map((option) => '<button type="button" class="secondary-button" data-status-choice="' + escapeHtml(option.value) + '" aria-pressed="' + (option.value === statusSelect.value) + '" ' + (statusSelect.disabled ? "disabled" : "") + ">" + escapeHtml(option.textContent) + "</button>")
        .join("");
    choices.hidden = choices.querySelectorAll("button").length === 0;
    statusSelect.closest("label").hidden = true;
    statusSelect.closest("label").after(choices);
    choices.addEventListener("click", (event) => {
      const button = event.target.closest("[data-status-choice]");
      if (!button || statusSelect.closest("form").dataset.saving) return;
      statusSelect.value = button.dataset.statusChoice;
      statusSelect.dispatchEvent(new Event("change", { bubbles: true }));
      choices.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    });
  }
  dialog.addEventListener("submit", updateOrder);
  dialog.addEventListener("change", changeOrderControl);
  dialog.querySelector("[data-close-order]").addEventListener("click", closeOrderProcessing);
  dialog.addEventListener("close", () => {
    dialog.remove();
    opener?.isConnected && opener.focus();
  });
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function openBulkProcessing() {
  const orders = state.orders.filter((o) => state.selectedOrders.has(o.id));
  if (!orders.length) return;
  document.getElementById("order-bulk-dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "order-bulk-dialog";
  dialog.className = "order-processing-dialog";
  dialog.innerHTML =
    "<header><h2>Xử lý " + orders.length + ' đơn đã chọn</h2><button type="button" data-close-bulk class="secondary-button" aria-label="Đóng">×</button></header>' +
    '<form class="bulk-process-form"><label>Bước xử lý<select name="action"><option value="confirm">Xác nhận đơn → Đã xác nhận</option><option value="prepare">Chuẩn bị hàng → Cần gửi</option><option value="ship">Xác nhận bàn giao → Đang giao</option><option value="complete">Hoàn tất giao hàng → Hoàn tất</option><option value="cancel">Hủy đơn chưa giao → Đã hủy</option></select></label><p data-bulk-hint></p><label data-bulk-money hidden><input type="checkbox" name="confirmReceived"> Tôi xác nhận đã thu đủ số tiền còn lại của các đơn COD đã giao.</label><p>Toàn bộ đơn đã chọn phải đủ điều kiện cho cùng một bước. Nếu có đơn không hợp lệ, hệ thống giữ nguyên toàn bộ.</p><button type="submit" class="primary-button">Xác nhận xử lý</button><p role="alert"></p></form>';
  const form = dialog.querySelector("form");
  const hint = dialog.querySelector("[data-bulk-hint]");
  const refresh = () => {
    const target = { confirm: "confirmed", prepare: "processing", ship: "shipped", complete: "completed", cancel: "cancelled" }[form.elements.action.value];
    const eligible = orders.filter((o) =>
      (orderTransitions[o.status] || []).includes(target)
      && (target !== "confirmed" || o.shippingFeeVnd != null)
      && (target !== "cancelled" || (o.paymentStatus !== "paid" && !(Number(o.receivedVnd) > 0) && !isLiveVnpayAttempt(o)))
      && (target !== "completed" || o.paymentStatus === "paid" || (can("payments.write") && !["vnpay", "9pay", "momo", "zalopay"].includes(o.paymentMethod)))
    );
    hint.textContent = eligible.length + "/" + orders.length + " đơn đủ điều kiện cho bước đã chọn.";
    dialog.querySelector("[data-bulk-money]").hidden = target !== "completed";
    form.elements.confirmReceived.required = target === "completed" && orders.some((o) => o.paymentStatus !== "paid");
    form.elements.confirmReceived.checked = false;
    form.querySelector("[type=submit]").disabled = eligible.length !== orders.length;
  };
  const common = orders.every((o) => o.status === orders[0].status) ? orders[0].status : null;
  const next = { pending: "confirm", confirmed: "prepare", processing: "ship", shipped: "complete" }[common];
  if (next) form.elements.action.value = next;
  form.elements.action.addEventListener("change", refresh);
  dialog.querySelector("[data-close-bulk]").addEventListener("click", () => {
    if (typeof dialog.close === "function") dialog.close();
    dialog.remove();
  });
  dialog.addEventListener("close", () => dialog.remove());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("[type=submit]");
    const feedback = form.querySelector("[role=alert]");
    if (button.disabled) return;
    button.disabled = true;
    feedback.textContent = "Đang kiểm tra và xử lý…";
    let saved = false;
    try {
      const result = await request("/api/gaeru_ceo/orders/bulk", {
        method: "POST",
        body: JSON.stringify({
          action: form.elements.action.value,
          confirmReceived: form.elements.confirmReceived.checked,
          orders: orders.map((o) => ({
            id: o.id,
            expectedStatus: o.status,
            expectedPaymentStatus: o.paymentStatus,
            expectedTotalVnd: o.totalVnd
          }))
        })
      });
      saved = true;
      if (typeof dialog.close === "function") dialog.close();
      dialog.remove();
      document.querySelector("#order-filter").value = result.targetStatus;
      await Promise.all([loadOrders(1), loadSummary()]);
      showGlobal(result.message);
    } catch (error) {
      if (saved) showGlobal("Đã lưu trạng thái nhưng chưa tải lại được danh sách. Nhấn Tải lại.", true);
      else feedback.textContent = error.message;
      button.disabled = false;
    }
  });
  document.body.append(dialog);
  refresh();
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function orderRestoreReason(order) {
  if (order.returnStatus === "returned" || order.returnedAt) return "Đơn đã hoàn trả xong; không xử lý lại.";
  if (!["cod", "bank_transfer"].includes(order.paymentMethod)) return "Đơn cổng thanh toán cần tạo đơn và phiên thanh toán mới.";
  if (order.paymentStatus === "paid" || Number(order.receivedVnd) > 0) return "Đơn đã ghi nhận tiền; cần đối soát riêng trước.";
  return "";
}

function openOrderRestoration(id) {
  const order = state.orders.find((o) => o.id === id);
  if (!order || order.status !== "cancelled" || !can("orders.write")) return;
  const blocked = orderRestoreReason(order);
  if (blocked) return showGlobal(blocked, true);
  document.getElementById("order-restoration-dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "order-restoration-dialog";
  dialog.className = "order-processing-dialog";
  dialog.setAttribute("aria-labelledby", "order-restoration-title");
  dialog.innerHTML =
    '<header><h2 id="order-restoration-title">Khôi phục ' + escapeHtml(order.orderNumber) + '</h2><button type="button" class="secondary-button" data-close-restoration aria-label="Đóng khôi phục đơn">×</button></header>' +
    '<form><p>Đơn sẽ về Chờ xác nhận. Máy chủ kiểm tra lại tồn kho và voucher trước khi giữ hàng; không tự ghi nhận tiền hoặc gửi hàng.</p><label>Lý do khôi phục<textarea name="reason" required minlength="5" maxlength="1000"></textarea></label><label><input type="checkbox" name="confirmedUnpaid" required> Tôi đã đối chiếu chưa nhận tiền và khách vẫn muốn tiếp tục đơn hàng.</label><button type="submit" class="primary-button">Kiểm tra & khôi phục đơn</button><p role="alert"></p></form>';
  document.body.append(dialog);
  const form = dialog.querySelector("form");
  const requestKey = crypto.randomUUID();
  dialog.querySelector("[data-close-restoration]").addEventListener("click", () => {
    if (!form.dataset.saving) {
      dialog.close();
      dialog.remove();
    }
  });
  dialog.addEventListener("cancel", (event) => { if (form.dataset.saving) event.preventDefault(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.saving) return;
    const button = form.querySelector("[type=submit]");
    const feedback = form.querySelector("[role=alert]");
    form.dataset.saving = "true";
    button.disabled = true;
    let saved = false;
    try {
      const result = await request("/api/gaeru_ceo/orders/" + encodeURIComponent(order.id) + "/restore", {
        method: "POST",
        body: JSON.stringify({
          version: order.version,
          requestKey,
          reason: form.elements.reason.value,
          confirmedUnpaid: form.elements.confirmedUnpaid.checked
        })
      });
      saved = true;
      dialog.close();
      dialog.remove();
      document.querySelector("#order-filter").value = "pending";
      await Promise.all([loadOrders(1), loadSummary()]);
      showGlobal(result.message);
    } catch (error) {
      if (saved) showGlobal("Đã khôi phục nhưng chưa tải lại danh sách. Nhấn Tải lại.", true);
      else feedback.textContent = error.message;
    } finally {
      delete form.dataset.saving;
      button.disabled = false;
    }
  });
  dialog.showModal();
  form.elements.reason.focus();
}

function renderOrders() {
  const root = document.querySelector("#order-list");
  const pagination = document.querySelector("#order-pagination");
  pagination.hidden = state.orderPagination.pageCount <= 1;
  document.querySelector("#previous-orders").disabled = state.orderPagination.page <= 1;
  document.querySelector("#next-orders").disabled = state.orderPagination.page >= state.orderPagination.pageCount;
  document.querySelector("#order-page-label").textContent =
    `${state.orderPagination.total} đơn · Trang ${state.orderPagination.page} / ${Math.max(1, state.orderPagination.pageCount)}`;
  document.querySelector("#order-list-status").textContent =
    `${state.orderPagination.total} đơn hàng${state.orderPagination.pageCount > 1 ? ` · Trang ${state.orderPagination.page} / ${state.orderPagination.pageCount}` : ""}`;
  if (!state.orders.length) {
    root.innerHTML = '<div class="empty-message"><strong>Không có đơn hàng phù hợp.</strong><p>Thử tìm theo mã đơn, tên, email, số điện thoại hoặc xóa bộ lọc.</p></div>';
    updateOrderSelection();
    return;
  }
  root.innerHTML = state.orders.map((order) => {
    const orderDate = new Date(order.createdAt).toLocaleString("vi-VN");
    const returned = order.returnStatus === "returned" || Boolean(order.returnedAt);
    const allowed = can("orders.write") && !returned
      ? (orderTransitions[order.status] || []).filter((status) =>
          (status !== "cancelled" || (order.paymentStatus !== "paid" && !(Number(order.receivedVnd) > 0) && !isLiveVnpayAttempt(order)))
          && (status !== "completed" || order.paymentStatus === "paid" || (can("payments.write") && !["vnpay", "9pay", "momo", "zalopay"].includes(order.paymentMethod)))
        )
      : [];
    const optionMarkup = [order.status, ...allowed].map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(labels[key] || key)}</option>`).join("");
    const paymentStatus = order.paymentStatus === "paid" ? "Đã thanh toán" : Number(order.receivedVnd) > 0 ? "Đã thu một phần" : "Chưa thanh toán";
    const paymentNote = order.paymentProvider === "vnpay"
      ? (order.paymentAttemptStatus === "pending" && !isLiveVnpayAttempt(order)
          ? "Phiên thanh toán VNPAY đã hết hạn; kiểm tra đối soát trước khi xử lý đơn."
          : paymentAttemptLabels[order.paymentAttemptStatus])
      : "";
    const latePaymentWarning = order.status === "cancelled" && order.paymentStatus === "paid"
      ? "Đơn đã hủy nhưng đã nhận tiền; cần đối soát/hoàn tiền thủ công trong merchant portal."
      : "";
    const phone = String(order.phone || "").replace(/[^+0-9]/g, "");
    const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
    const lockNote = order.paymentStatus === "paid"
      ? "Phí giao hàng và thanh toán đã được chốt. Đơn đã thanh toán cần xử lý hoàn tiền trước khi hủy."
      : Number(order.receivedVnd) > 0
        ? "Đơn đã thu một phần tiền. Không thể thay đổi phí giao hàng hoặc hủy đơn khi chưa xử lý khoản tiền đã thu."
        : isLiveVnpayAttempt(order)
          ? "Phiên VNPAY đang chờ xác nhận. Chỉ có thể hủy sau khi phiên thanh toán hết hạn."
          : "";
    return `<article class="order-card" data-order-detail="${escapeHtml(order.id)}">
      <div class="order-card-summary order-table-row"><label class="order-select-cell"><input type="checkbox" data-select-order="${escapeHtml(order.id)}" aria-label="Chọn đơn ${escapeHtml(order.orderNumber)}" ${state.selectedOrders.has(order.id) ? "checked" : ""}></label><span class="order-cell"><strong>${escapeHtml(order.orderNumber)}</strong><small>${escapeHtml(orderDate)}</small></span><span class="order-cell"><strong>${escapeHtml(order.customerName)}</strong><small>${escapeHtml(order.phone)}</small></span><span class="order-cell"><strong>${itemCount} sản phẩm</strong><small>${escapeHtml(order.items.map((i) => i.productName + " · " + i.variantName).join(", "))}</small></span><span class="order-cell"><span class="status-pill status-${escapeHtml(order.status)}">${returned ? "Đã hoàn trả" : escapeHtml(labels[order.status] || order.status)}</span>${order.reviewReason ? `<span class="status-pill status-warning" style="background:#fff3cd;color:#856404;border:1px solid #ffeeba;margin-top:4px;display:inline-block;font-size:11px" title="${escapeHtml(reviewReasonLabels[order.reviewReason] || "Cần gọi xác nhận qua điện thoại")}">⚠️ Chờ xác minh SĐT</span>` : ""}</span><span class="order-cell"><strong title="${escapeHtml(labels[order.paymentMethod] || order.paymentMethod)}">${escapeHtml(order.paymentMethod === "cod" ? "COD" : labels[order.paymentMethod] || order.paymentMethod)}</strong><small>${paymentStatus}</small>${order.shippingCarrierName ? `<small>Vận chuyển: ${escapeHtml(order.shippingCarrierName)}</small>` : ""}</span><span class="order-cell order-amount"><strong>${order.totalVnd == null ? "Chưa chốt tổng" : formatPrice(order.totalVnd)}</strong></span><span class="order-cell order-action-cell">${returned ? '<span class="status-pill">Đã hoàn trả</span>' : `<button type="button" class="secondary-button order-process-button" data-process-order="${escapeHtml(order.id)}" aria-haspopup="dialog" aria-controls="order-processing-dialog">Xử lý</button>`}${can("orders.write") && order.status === "completed" && !returned && order.returnStatus !== "open" ? `<button type="button" class="secondary-button order-return-button" data-return-order="${escapeHtml(order.id)}">Hoàn trả</button>` : ""}${can("orders.write") && order.status === "cancelled" && !returned ? `<button type="button" class="secondary-button order-restore-button" style="white-space:nowrap" data-restore-order="${escapeHtml(order.id)}" ${orderRestoreReason(order) ? "disabled" : ""}>Khôi phục xử lý</button>${orderRestoreReason(order) ? `<small>${escapeHtml(orderRestoreReason(order))}</small>` : ""}` : ""}${can("orders.write") ? `<button type="button" class="order-delete-button" data-permanent-delete-order="${escapeHtml(order.id)}" title="Xóa vĩnh viễn đơn hàng này">Xóa vĩnh viễn</button>` : ""}</span></div>
      <div class="order-card-body" id="order-body-${escapeHtml(order.id)}" hidden>
      <div class="order-meta">
        <p><strong>${escapeHtml(order.customerName)}</strong><br><a href="tel:${escapeHtml(phone)}">${escapeHtml(order.phone)}</a><br><a href="mailto:${escapeHtml(order.email)}">${escapeHtml(order.email)}</a></p>
        <p>${escapeHtml(order.address)}, ${escapeHtml(order.city)}${order.note ? `<br>Ghi chú: ${escapeHtml(order.note)}` : ""}</p>
      </div>
      <div class="order-lines">${order.items.map((item) => `<div class="order-line"><span>${escapeHtml(item.productName)} · ${escapeHtml(item.variantName)} × ${item.quantity}<small>SKU ${escapeHtml(item.sku || "—")}</small></span><strong>${formatPrice(item.lineTotalVnd)}</strong></div>`).join("")}</div>
      <dl class="order-totals">${order.discountVnd ? `<div><dt>Voucher ${escapeHtml(order.voucherCode)}</dt><dd>−${formatPrice(order.discountVnd)}</dd></div>` : ""}<div><dt>Tạm tính</dt><dd>${formatPrice(order.subtotalVnd)}</dd></div><div><dt>Phí giao hàng</dt><dd>${order.shippingFeeVnd == null ? "Chưa chốt" : formatPrice(order.shippingFeeVnd)}</dd></div>${Number(order.receivedVnd) > 0 ? `<div><dt>Đã thu</dt><dd>${formatPrice(order.receivedVnd)}</dd></div><div><dt>Còn phải thu</dt><dd>${formatPrice(order.outstandingVnd ?? Math.max(0, order.totalVnd - order.receivedVnd))}</dd></div>` : ""}<div><dt>Tổng cộng</dt><dd>${order.totalVnd == null ? "Chưa chốt tổng" : formatPrice(order.totalVnd)}</dd></div></dl>
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
  if (
    form.elements.status.value === "cancelled" &&
    order.status !== "cancelled" &&
    !window.confirm(`Hủy đơn ${order.orderNumber}? Số lượng sản phẩm trong đơn sẽ được hoàn lại vào tồn kho. Muốn khôi phục phải kiểm tra lại kho và thanh toán.`)
  ) return;
  const feedback = form.querySelector('[role="alert"]');
  submitButton.disabled = true;
  form.dataset.saving = "true";
  submitButton.textContent = "Đang cập nhật…";
  feedback.textContent = "";
  const payload = {};
  const targetStatus = form.elements.status.value;
  let saved = false;
  if (targetStatus !== order.status) payload.status = targetStatus;
  const paymentField = form.elements.paymentStatus;
  if (paymentField && !paymentField.disabled && paymentField.value !== order.paymentStatus) payload.paymentStatus = paymentField.value;
  if (!form.elements.shippingFeeVnd.disabled && form.elements.shippingFeeVnd.value !== "" && Number(form.elements.shippingFeeVnd.value) !== order.shippingFeeVnd) {
    payload.shippingFeeVnd = Number(form.elements.shippingFeeVnd.value);
  }
  try {
    if (!Object.keys(payload).length) throw new Error("Chưa có thay đổi để lưu.");
    if (targetStatus === "completed" && (payload.paymentStatus || order.paymentStatus) !== "paid") {
      throw new Error("Xác nhận đã thu đủ tiền trước khi hoàn tất đơn hàng.");
    }
    await request(`/api/gaeru_ceo/orders/${encodeURIComponent(form.dataset.orderForm)}`, { method: "PATCH", body: JSON.stringify(payload) });
    saved = true;
    closeOrderProcessing();
    if (targetStatus !== order.status) document.querySelector("#order-filter").value = targetStatus;
    await Promise.all([loadOrders(1), loadSummary()]);
    showGlobal("Đã cập nhật đơn hàng.");
  } catch (error) {
    if (saved) showGlobal("Đã lưu đơn hàng nhưng chưa tải lại được danh sách. Nhấn Tải lại.", true);
    else feedback.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    delete form.dataset.saving;
    submitButton.textContent = "Lưu cập nhật";
  }
}

document.querySelectorAll(".order-filters select").forEach((select) => select.addEventListener("change", () => {
  state.orderPage = 1;
  loadOrders(1).catch((error) => showGlobal(error.message, true));
}));
document.querySelector("#reset-order-filters").addEventListener("click", () => {
  document.querySelector("#order-search").value = "";
  document.querySelector("#order-filter").value = "";
  document.querySelectorAll(".order-filters select").forEach((select) => {
    select.value = select.id === "order-sort" ? "newest" : select.id === "order-page-size" ? "25" : "";
  });
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
document.querySelector("#order-list").addEventListener("click", (event) => {
  const back = event.target.closest("[data-return-order]");
  if (back) { startOrderReturn(back.dataset.returnOrder); return; }
  const button = event.target.closest("[data-process-order]");
  if (button) { openOrderProcessing(button.dataset.processOrder, button); return; }
  const del = event.target.closest("[data-permanent-delete-order]");
  if (del) { handleOrderPermanentDeleteUI(del.dataset.permanentDeleteOrder); return; }
});
document.querySelector("#order-list").addEventListener("change", changeOrderControl);

function renderOrderOverview(counts) {
  const tabs = [
    ["", "Tất cả"],
    ["payment_pending", "Đơn chờ thanh toán"],
    ["pending", "Chờ xác nhận"],
    ["ready_to_ship", "chờ gửi hàng"],
    ["shipped", "Đã giao hàng"],
    ["completed", "Hoàn Tất"],
    ["cancelled_or_returned", "Hủy & Hoàn trả"]
  ];
  const total = ["pending", "confirmed", "processing", "shipped", "completed", "cancelled", "returned"]
    .reduce((sum, key) => sum + Number(counts[key] || 0), 0);
  const afterSalesOpen = !document.querySelector("#after-sales-panel").hidden;
  const currentFilter = document.querySelector("#order-filter")?.value || "";
  const values = {
    ...counts,
    ready_to_ship: Number(counts.confirmed || 0) + Number(counts.processing || 0),
    payment_pending: Number(
      counts.payment_pending
      ?? counts.paymentPending
      ?? (currentFilter === "payment_pending" ? state.orderPagination?.total : undefined)
      ?? state.paymentPending
      ?? 0
    )
  };
  document.querySelector("#order-tabs").innerHTML = tabs
    .map(([key, title]) => `<button type="button" data-order-tab="${key}" ${key === "shipped" ? 'title="Đơn đã bàn giao cho hãng vận chuyển"' : ""} aria-pressed="${!afterSalesOpen && currentFilter === key}">${title} <span>${key ? Number(values[key] || 0) : total}</span></button>`)
    .join("");
  const unpaidBtn = document.querySelector("#btn-unpaid-orders");
  if (unpaidBtn) {
    unpaidBtn.setAttribute("aria-pressed", String(!afterSalesOpen && currentFilter === "payment_pending"));
    const countSpan = document.querySelector("#unpaid-orders-count");
    if (countSpan) countSpan.textContent = values.payment_pending;
  }
  const unpaidStat = document.querySelector("#unpaid-order-count");
  if (unpaidStat && values.payment_pending !== undefined) unpaidStat.textContent = values.payment_pending;
}

document.addEventListener("gaeru:after-sales-updated", () => {
  loadOrders(state.orderPage).catch((error) => showGlobal(error.message, true));
});
document.querySelector("#order-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-restore-order]");
  if (button && !button.disabled) openOrderRestoration(button.dataset.restoreOrder);
});
document.querySelector("#orders-view").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-order-tab]");
  if (!tab) return;
  window.GAERUAfterSales?.close();
  document.querySelector("#order-filter").value = tab.dataset.orderTab;
  if (tab.dataset.orderTab === "payment_pending") document.querySelector("#order-payment-filter").value = "";
  loadOrders(1).catch((error) => showGlobal(error.message, true));
});

function updateOrderSelection() {
  const count = state.selectedOrders.size;
  document.querySelector("#selected-order-count").textContent = "Đã chọn " + count + " đơn";
  const all = document.querySelector("#select-order-page");
  all.checked = Boolean(state.orders.length) && count === state.orders.length;
  all.indeterminate = count > 0 && count < state.orders.length;
  all.disabled = !state.orders.length;
  const returnedSelected = state.orders.some((order) => state.selectedOrders.has(order.id) && (order.returnStatus === "returned" || order.returnedAt));
  document.querySelectorAll("[data-print-orders],[data-bulk-process]").forEach((button) => {
    button.disabled = count === 0 || (button.hasAttribute("data-bulk-process") && (!can("orders.write") || returnedSelected));
  });
}

document.querySelector("#select-order-page").addEventListener("change", (event) => {
  state.selectedOrders = new Set(event.target.checked ? state.orders.map((order) => order.id) : []);
  document.querySelectorAll("[data-select-order]").forEach((input) => { input.checked = event.target.checked; });
  updateOrderSelection();
});
document.querySelector("#order-list").addEventListener("change", (event) => {
  const input = event.target.closest("[data-select-order]");
  if (!input) return;
  if (input.checked) state.selectedOrders.add(input.dataset.selectOrder);
  else state.selectedOrders.delete(input.dataset.selectOrder);
  updateOrderSelection();
});
document.querySelector("#order-bulk-actions").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-print-orders]");
  if (!button || !state.selectedOrders.size) return;
  const ids = state.orders.filter((order) => state.selectedOrders.has(order.id)).map((order) => order.id);
  if (!ids.length) return;
  const printWindow = window.open("", "_blank");
  if (!printWindow) return showGlobal("Cho phép mở cửa sổ mới để xem và in đơn hàng.", true);
  printWindow.opener = null;
  printWindow.document.title = "Chuẩn bị bản in GAERU";
  printWindow.document.body.textContent = "Đang chuẩn bị bản in…";
  button.disabled = true;
  try {
    const csrf = await request("/api/csrf");
    state.csrfToken = csrf.csrfToken;
    const response = await fetch("/api/gaeru_ceo/orders/print", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrfToken },
      body: JSON.stringify({ ids, format: button.dataset.printOrders })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Error(data.error || "Không thể chuẩn bị bản in. Tải lại danh sách và thử lại.");
    }
    const html = await response.text();
    if (printWindow.closed) throw Error("Cửa sổ in đã đóng. Chọn In đơn hoặc In tem để mở lại.");
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
  } catch (error) {
    if (!printWindow.closed) printWindow.close();
    showGlobal(error.message, true);
  } finally {
    updateOrderSelection();
  }
});
document.querySelector('#export-order-page').addEventListener('click', () => {
  if (!state.orders.length) return showGlobal("Không có đơn hàng để xuất.", true);
  const cell = (value) => '"' + String(value ?? "").replace(/^(\s*[=+@-])/, "'$1").replace(/"/g, '""') + '"';
  const rows = [
    ["Mã đơn", "Khách hàng", "Điện thoại", "Email", "Trạng thái", "Thanh toán", "Tổng tiền"],
    ...state.orders.map((o) => [o.orderNumber, o.customerName, o.phone, o.email, labels[o.status] || o.status, labels[o.paymentMethod] || o.paymentMethod, o.totalVnd ?? ""])
  ];
  const url = URL.createObjectURL(new Blob(["\ufeff" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "gaeru-don-hang-trang-" + state.orderPage + ".csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.querySelector("#export-order-excel").addEventListener("click", () => {
  const params = new URLSearchParams({
    format: "xlsx",
    scope: document.querySelector("#order-export-scope").value,
    page: String(state.orderPage)
  });
  for (const [key, id] of [["status", "order-filter"], ["q", "order-search"], ["paymentStatus", "order-payment-filter"], ["paymentMethod", "order-method-filter"], ["sort", "order-sort"], ["pageSize", "order-page-size"]]) {
    params.set(key, document.getElementById(id).value);
  }
  window.open("/api/gaeru_ceo/orders?" + params, "_blank", "noopener");
});

document.querySelector("[data-bulk-process]").addEventListener("click", openBulkProcessing);

function confirmOrderPermanentDeletion(order) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "enterprise-confirm-dialog";
    dialog.setAttribute("aria-labelledby", "order-delete-title");
    const orderNumber = String(order?.orderNumber || order?.id || "").trim();
    const customer = order?.customerName ? (order.customerName + (order.phone ? " (" + order.phone + ")" : "")) : "";
    const total = order?.totalVnd != null ? formatPrice(order.totalVnd) : "";

    dialog.innerHTML =
      '<h2 id="order-delete-title" style="color:#b42318;margin-top:0">Xác nhận xóa vĩnh viễn đơn hàng</h2>' +
      '<div style="background:#fef3f2;border:1px solid #fecdca;border-radius:10px;padding:12px;margin:12px 0;font-size:13px;color:#b42318;line-height:1.5">' +
        "<strong>⚠️ CẢNH BÁO QUAN TRỌNG:</strong><br>" +
        "Đơn hàng sẽ bị xóa hoàn toàn khỏi hệ thống, giải phóng tồn kho (nếu đơn chưa hủy), và các khoản thu liên quan sẽ <strong>tự động loại khỏi dữ liệu doanh số và lịch sử đơn hàng</strong>.<br>" +
        "Thao tác này <strong>KHÔNG THỂ hoàn tác</strong>." +
      "</div>" +
      '<div style="margin:12px 0;font-size:13px;line-height:1.6">' +
        '<div><strong>Mã đơn hàng:</strong> <code style="font-weight:700;color:#0055b8">' + escapeHtml(orderNumber) + "</code></div>" +
        (customer ? "<div><strong>Khách hàng:</strong> " + escapeHtml(customer) + "</div>" : "") +
        (total ? "<div><strong>Tổng tiền:</strong> " + escapeHtml(total) + "</div>" : "") +
      "</div>" +
      '<label style="display:block;margin:14px 0 6px;font-size:13px;font-weight:600">' +
        'Nhập chính xác mã đơn <span style="color:#b42318">' + escapeHtml(orderNumber) + "</span> để xác nhận:" +
        '<input type="text" data-order-delete-input autocomplete="off" placeholder="' + escapeHtml(orderNumber) + '" style="margin-top:6px;width:100%;box-sizing:border-box">' +
      "</label>" +
      '<div class="enterprise-confirm-actions" style="margin-top:20px;display:flex;justify-content:flex-end;gap:10px">' +
        '<button type="button" data-order-delete-cancel autofocus>Quay lại</button>' +
        '<button type="button" class="danger-button" data-order-delete-accept disabled style="background:#d92d20;color:#fff;border-color:#d92d20">Xác nhận xóa vĩnh viễn</button>' +
      "</div>";

    let done = false;
    function finish(value) {
      if (done) return;
      done = true;
      if (typeof dialog.close === "function") dialog.close();
      dialog.remove();
      previous?.focus();
      resolve(value);
    }

    const input = dialog.querySelector("[data-order-delete-input]");
    const acceptBtn = dialog.querySelector("[data-order-delete-accept]");
    const cancelBtn = dialog.querySelector("[data-order-delete-cancel]");

    if (input && acceptBtn) {
      input.addEventListener("input", () => {
        const typed = input.value.trim().toUpperCase();
        const expected = orderNumber.toUpperCase();
        acceptBtn.disabled = Boolean(!typed || typed !== expected);
      });
      acceptBtn.onclick = () => {
        if (!acceptBtn.disabled) finish(true);
      };
    }
    if (cancelBtn) cancelBtn.onclick = () => finish(false);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener("close", () => finish(false));

    document.body.append(dialog);
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      const confirmed = window.prompt(
        "XÁC NHẬN CỦA QUẢN TRỊ: Xóa vĩnh viễn đơn " + orderNumber + '?\n\nNhập chính xác "' + orderNumber + '" để xác nhận:'
      );
      finish(Boolean(confirmed && confirmed.trim().toUpperCase() === orderNumber.toUpperCase()));
    }
  });
}

async function handleOrderPermanentDeleteUI(orderId) {
  if (!can("orders.write")) return;
  const order = state.orders.find((o) => o.id === orderId) || { id: orderId, orderNumber: orderId };
  const confirmed = await confirmOrderPermanentDeletion(order);
  if (!confirmed) return;
  try {
    const csrf = await request("/api/csrf");
    state.csrfToken = csrf.csrfToken;
    const res = await request("/api/gaeru_ceo/orders/" + encodeURIComponent(orderId) + "/permanent-delete", {
      method: "POST",
      body: JSON.stringify({ reason: "Quản trị viên xác nhận xóa vĩnh viễn đơn " + (order.orderNumber || orderId) })
    });
    await Promise.all([loadOrders(state.orderPage), loadSummary()]);
    showGlobal(res.message || "Đã xóa vĩnh viễn đơn hàng và loại khỏi dữ liệu doanh số.");
  } catch (error) {
    showGlobal(error.message, true);
  }
}
