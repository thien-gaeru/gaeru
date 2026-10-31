// admin/product-editor.js — Bộ điều phối không gian làm việc sản phẩm (Product Workspace Controller)

(() => {
  const choices = window.GAERUVariantChoices;
  const form = document.querySelector("#workspace-form");
  const status = document.querySelector("#workspace-status");
  const esc = window.GAERUAdminShared.escapeHtml;
  const money = window.GAERUAdminShared.formatMoney;
  const slugify = (v) =>
    v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const editingTrash = /(?:[?&])trash=1(?:&|$)/.test(location.search || "");

  let model = {
    product: {
      name: "",
      slug: "",
      category: "audio",
      descriptor: "",
      cardTitle: "",
      cardSummary: "",
      description: "",
      imageUrl: "",
      imageAlt: "",
      active: false,
      sortOrder: 0
    },
    gallery: [],
    groups: [],
    variants: [],
    descriptionMedia: []
  };
  let user = null;
  let busy = false;
  let dirty = false;
  const disabledStates = new WeakMap();

  const can = (p) => user?.permissions?.includes(p);
  const imageUrl = (u) => {
    const path = u.startsWith("/api/catalog-images/")
      ? u.replace("/api/catalog-images/", "/api/gaeru_ceo/catalog-images/")
      : u.startsWith("/api/catalog-videos/")
        ? u.replace("/api/catalog-videos/", "/api/gaeru_ceo/catalog-videos/")
        : u;
    return window.GAERUAdminUI?.imageUrl(path) ?? path;
  };

  async function request(path, method = "GET", body) {
    const headers = {};
    if (method !== "GET") {
      const r = await fetch("/api/csrf", { credentials: "same-origin", cache: "no-store" });
      headers["X-CSRF-Token"] = (await r.json()).csrfToken;
      if (!(body instanceof FormData)) headers["Content-Type"] = "application/json";
    }
    const r = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {})
    });
    const data = await r.json();
    if (!r.ok) {
      const err = Error(data.error || "Không thể lưu thay đổi.");
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function lock(value) {
    busy = value;
    for (const element of form.querySelectorAll("input,select,textarea,button")) {
      if (value) {
        disabledStates.set(element, element.disabled);
        element.disabled = true;
      } else {
        element.disabled = disabledStates.has(element)
          ? disabledStates.get(element)
          : !can("catalog.write") || (element.matches("[data-field=stockQuantity]") && !can("inventory.approve"));
        disabledStates.delete(element);
      }
    }
    document.querySelectorAll("[data-save]").forEach((b) => { b.disabled = value || !can("catalog.write"); });
    const gf = document.querySelector("#gallery-files");
    if (gf) gf.disabled = value || !can("catalog.write");
    const bs = document.querySelector("#bulk-stock");
    if (bs) bs.disabled = value || !can("inventory.approve");
  }

  function feedback(message, isError = false) {
    if (status) {
      status.textContent = message;
      status.classList.toggle("is-error", isError);
    }
  }

  function showProductSuccessPopup(title = "Đã sửa sản phẩm thành công", redirectUrl = "/gaeru_ceo#products") {
    try { sessionStorage.setItem("gaeru:product-added-notice", title); } catch (_) {}
    let popup = document.querySelector("#product-success-popup");
    if (!popup) {
      popup = document.createElement("div");
      popup.id = "product-success-popup";
      popup.className = "product-success-popup-backdrop";
      popup.setAttribute("role", "dialog");
      popup.setAttribute("aria-modal", "true");
      popup.setAttribute("aria-labelledby", "product-success-title");
      popup.innerHTML =
        '<div class="product-success-popup-card">' +
        '<div class="product-success-icon-wrap"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg></div>' +
        '<h2 id="product-success-title">' + title + "</h2>" +
        '<p class="product-success-sub">Đang tự động chuyển hướng về trang quản lý sản phẩm…</p>' +
        '<div class="product-success-actions"><a href="' + redirectUrl + '" class="primary-button product-success-btn">Về trang quản lý sản phẩm</a></div>' +
        "</div>";
      const container = document.body || document.querySelector("body") || document.documentElement || document;
      if (container && typeof container.appendChild === "function") container.appendChild(popup);
    } else {
      const titleEl = popup.querySelector("#product-success-title") || popup.querySelector("h2");
      if (titleEl) titleEl.textContent = title;
      popup.hidden = false;
    }
    feedback(title + ". Đang tự động chuyển hướng về trang quản lý sản phẩm…");
    setTimeout(() => {
      if (typeof location !== "undefined") {
        if (typeof location.assign === "function") location.assign(redirectUrl);
        else location.href = redirectUrl;
      }
    }, 1000);
  }

  function product() {
    return {
      ...model.product,
      name: form.elements.name.value.trim(),
      slug: form.elements.slug.value.trim(),
      category: form.elements.category.value,
      descriptor: form.elements.descriptor.value,
      cardTitle: form.elements.cardTitle.value.trim(),
      cardSummary: form.elements.cardSummary.value.trim(),
      description: form.elements.description.value,
      imageUrl: model.gallery[0] || "",
      imageAlt: form.elements.imageAlt.value,
      sortOrder: Number(form.elements.sortOrder.value)
    };
  }

  function preview() {
    const p = product();
    const active = model.variants.filter((v) => v.active && v.priceVnd !== null);
    const prices = active.map((v) => v.priceVnd);
    const prev = document.querySelector("#product-preview");
    if (!prev) return;
    prev.innerHTML =
      `${model.gallery[0] ? `<img src="${esc(imageUrl(model.gallery[0]))}" alt="${esc(p.imageAlt || p.name)}">` : '<div class="preview-placeholder">Thêm ảnh sản phẩm</div>'}` +
      `<h3>${esc(p.cardTitle || p.name || "Tên sản phẩm")}</h3>` +
      `<p>${esc(p.cardSummary || p.descriptor || "Thông điệp giới thiệu ngắn")}</p>` +
      `<strong>${prices.length ? money(Math.min(...prices)) + (Math.min(...prices) !== Math.max(...prices) ? " – " + money(Math.max(...prices)) : "") : "Chưa có giá bán"}</strong>` +
      `<div class="preview-options">${model.groups.map((g) => `<p>${esc(g.name)}</p><div>${g.values.map((v) => `<span>${esc(v)}</span>`).join("")}</div>`).join("")}</div>` +
      `<small>${model.variants.length} biến thể · ${model.inTrash ? "Đã xóa" : model.product.active ? "Đang hiển thị" : "Bản nháp"}</small>`;
  }

  const editorBridge = {
    form,
    choices,
    esc,
    slugify,
    imageUrl,
    can,
    request,
    lock,
    feedback,
    preview,
    get model() { return model; },
    get busy() { return busy; },
    get dirty() { return dirty; },
    set dirty(v) { dirty = v; },
    readRows: () => variantsCtrl.readRows(),
    rows: () => variantsCtrl.rows()
  };

  const variantsCtrl = window.GAERUProductEditorVariants.createVariantsController(editorBridge);
  const mediaCtrl = window.GAERUProductEditorMedia.createMediaController(editorBridge);

  function render() {
    for (const key of ["name", "slug", "category", "descriptor", "cardTitle", "cardSummary", "description", "imageAlt", "sortOrder"]) {
      if (form.elements[key]) form.elements[key].value = model.product[key] ?? "";
    }
    const titleEl = document.querySelector("#editor-title");
    if (titleEl) {
      titleEl.textContent = model.inTrash
        ? "Chỉnh sửa sản phẩm đã xóa"
        : model.id
          ? "Chỉnh sửa sản phẩm"
          : "Thêm sản phẩm";
    }
    document.title = (titleEl?.textContent || "Sản phẩm") + " — GAERU";
    const pubBtn = document.querySelector("[data-save=publish]");
    if (pubBtn) {
      pubBtn.hidden = Boolean(model.inTrash);
      pubBtn.textContent = model.product.active ? "Lưu & tiếp tục hiển thị" : "Xuất bản sản phẩm";
    }
    const dftBtn = document.querySelector("[data-save=draft]");
    if (dftBtn) {
      dftBtn.textContent = model.inTrash
        ? "Lưu trong khu vực đã xóa"
        : (model.product.active ? "Ẩn sản phẩm (về bản nháp)" : "Lưu bản nháp");
    }
    const prefixEl = document.querySelector("#sku-prefix");
    if (prefixEl) prefixEl.value = model.product.slug.toUpperCase();
    const bsEl = document.querySelector("#bulk-stock");
    if (bsEl) bsEl.disabled = !can("inventory.approve");

    if (!model.variants.length) {
      model.variants = [{
        sku: (slugify(model.product.slug || model.product.name || "GAERU").toUpperCase() + "-01").slice(0, 50),
        name: "Phiên bản tiêu chuẩn",
        options: {},
        priceVnd: null,
        stockQuantity: 10,
        active: true,
        imageUrl: ""
      }];
    }

    const hasGroups = model.groups.length > 0 || model.variants.length > 1;
    variantsCtrl.setOptionMode(hasGroups ? "variants" : "simple");
    variantsCtrl.syncSimpleInputs();

    mediaCtrl.gallery();
    mediaCtrl.mediaEditor();
    variantsCtrl.groupEditor();
    variantsCtrl.rows();
    if (!can("catalog.write")) form.querySelectorAll("input,textarea,select,button").forEach((e) => { e.disabled = true; });
    lock(false);
  }

  form.addEventListener("input", () => { preview(); });
  if (form.elements.name) {
    form.elements.name.addEventListener("input", () => {
      if (!model.id && !form.elements.slug.dataset.manual) {
        form.elements.slug.value = slugify(form.elements.name.value);
      }
      const sSku = document.querySelector("#simple-sku");
      if (sSku && (!model.variants[0]?.sku || !sSku.dataset.manual)) {
        sSku.value = (slugify(form.elements.name.value || "GAERU").toUpperCase() + "-01").slice(0, 50);
        if (model.variants[0]) model.variants[0].sku = sSku.value;
      }
    });
  }
  if (form.elements.slug) {
    form.elements.slug.addEventListener("input", () => {
      form.elements.slug.dataset.manual = "true";
      const sSku = document.querySelector("#simple-sku");
      if (sSku && !sSku.dataset.manual) {
        sSku.value = (slugify(form.elements.slug.value || "GAERU").toUpperCase() + "-01").slice(0, 50);
        if (model.variants[0]) model.variants[0].sku = sSku.value;
      }
    });
  }

  document.querySelectorAll("[data-save]").forEach((button) => {
    button.onclick = async () => {
      if (busy || !can("catalog.write")) return;
      try {
        if (mediaCtrl.hasPendingUploads()) {
          throw Error("Chờ ảnh tải xong; thử lại hoặc bỏ ảnh bị lỗi trước khi lưu.");
        }
        mediaCtrl.readMedia();
        variantsCtrl.readRows();

        const isPublish = button.dataset.save === "publish";
        variantsCtrl.validateBeforeSave(isPublish);

        const p = product();
        p.active = !model.inTrash && isPublish;

        lock(true);
        feedback("Đang lưu sản phẩm và biến thể…");
        const payload = {
          ...(model.inTrash ? { inTrash: true } : {}),
          ...(model.id ? { id: model.id, updatedAt: model.updatedAt, version: model.version } : {}),
          product: p,
          gallery: model.gallery,
          descriptionMedia: model.descriptionMedia || [],
          groups: model.groups,
          variants: model.variants
        };

        const isNew = !model.id;
        model = await request("/api/gaeru_ceo/product-workspace", "POST", payload);
        dirty = false;
        variantsCtrl.clearValidationErrors();
        render();
        const notice = isNew
          ? "Đã thêm sản phẩm mới thành công"
          : (model.inTrash ? "Đã lưu thay đổi sản phẩm thành công" : "Đã sửa sản phẩm thành công");
        showProductSuccessPopup(notice);
      } catch (e) {
        if (e.data?.issues) {
          variantsCtrl.applyIssues(e.data.issues);
        } else if (e.data?.field) {
          if (e.data.field === "product.slug") variantsCtrl.showFieldError(form.elements.slug, e.message);
          else if (e.data.field === "sku") variantsCtrl.showFieldError(document.querySelector("#simple-sku") || document.querySelector('[data-field="sku"]'), e.message);
        } else {
          const firstInvalid = document.querySelector(".is-invalid");
          if (firstInvalid) {
            try { firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
            try { firstInvalid.focus(); } catch (_) {}
          }
        }
        feedback(e.message, true);
      } finally {
        lock(false);
      }
    };
  });

  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  (async () => {
    try {
      user = await request("/api/auth/me");
      if (!user.authenticated) {
        status.innerHTML = 'Vui lòng <a href="/gaeru_ceo">đăng nhập quản trị</a> trước khi tạo hoặc sửa sản phẩm.';
        return;
      }
      if (!can("catalog.read")) throw Error("Bạn không có quyền xem sản phẩm.");
      const match = location.pathname.match(/\/products\/([^/]+)\/edit$/);
      if (match) {
        model = await request("/api/gaeru_ceo/product-workspace/" + encodeURIComponent(match[1]) + (editingTrash ? "?trash=1" : ""));
      }
      if (model.inTrash) {
        const back = document.querySelector('a[href="/gaeru_ceo#products"]');
        if (back) back.href = "/gaeru_ceo?productScope=trash#products";
      }
      if (model.product.slug === "gaeru-m3" && !model.descriptionMedia?.length && window.renderM3?.isLegacyDescription(model.product.description)) {
        const defaults = window.renderM3.content();
        model.product.description = defaults.description;
        model.descriptionMedia = defaults.descriptionMedia;
      }
      if (!model.groups.length && model.variants.some((v) => Object.keys(v.options).length)) {
        model.groups = choices.groups(model.variants);
      }
      const ws = document.querySelector("#workspace");
      if (ws) ws.hidden = false;
      render();
      feedback(
        model.inTrash
          ? "Sản phẩm vẫn ở khu vực đã xóa. Lưu thay đổi tại đây; khôi phục hoặc kích hoạt lại trong danh sách sản phẩm đã xóa."
          : can("catalog.write")
            ? "Nhập thông tin sản phẩm; lưu nháp hoặc xuất bản khi đã kiểm tra xong."
            : "Bạn đang xem sản phẩm với quyền chỉ đọc."
      );
    } catch (e) {
      feedback(e.message, true);
    }
  })();
})();
