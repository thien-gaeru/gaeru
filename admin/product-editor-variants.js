// admin/product-editor-variants.js — Phân loại lựa chọn, ma trận biến thể, kiểm tra hợp lệ & thao tác hàng loạt

window.GAERUProductEditorVariants = {
  createVariantsController(editor) {
    const { form, choices, esc, slugify, imageUrl, can, request, lock, feedback, preview } = editor;

    function clearValidationErrors() {
      document.querySelectorAll(".is-invalid").forEach((el) => el.classList.remove("is-invalid"));
      document.querySelectorAll(".field-error-msg").forEach((el) => el.remove());
      document.querySelectorAll(".workspace-card.has-error").forEach((el) => el.classList.remove("has-error"));
    }

    function showFieldError(element, message) {
      if (!element) return;
      element.classList.add("is-invalid");
      const card = element.closest(".workspace-card");
      if (card) card.classList.add("has-error");
      const parent = element.closest(".workspace-fields label") || element.closest(".option-value-cell") || element.parentElement;
      if (parent && !parent.querySelector(".field-error-msg")) {
        const errDiv = document.createElement("div");
        errDiv.className = "field-error-msg";
        errDiv.textContent = message;
        parent.appendChild(errDiv);
      }
    }

    function applyIssues(issues) {
      clearValidationErrors();
      for (const issue of issues) {
        const p = (issue.path || []).join(".");
        let target = null;
        if (p === "product.name") target = form.elements.name;
        else if (p === "product.slug") target = form.elements.slug;
        else if (p === "gallery" || p.startsWith("gallery")) target = document.querySelector("#gallery");
        else if (p === "product.descriptor") target = form.elements.descriptor;
        else if (p === "product.cardTitle") target = form.elements.cardTitle;
        else if (p === "product.cardSummary") target = form.elements.cardSummary;
        else if (p === "product.description") target = document.querySelector("#description-media");
        else if (p.includes("sku")) {
          const match = p.match(/variants\.(\d+)\.sku/);
          if (match) target = document.querySelector('[data-variant-index="' + match[1] + '"] [data-field="sku"]');
          else target = document.querySelector("#simple-sku");
        } else if (p.includes("priceVnd")) {
          const match = p.match(/variants\.(\d+)\.priceVnd/);
          if (match) target = document.querySelector('[data-variant-index="' + match[1] + '"] [data-field="priceVnd"]');
          else target = document.querySelector("#simple-price");
        } else if (p.includes("stockQuantity")) {
          const match = p.match(/variants\.(\d+)\.stockQuantity/);
          if (match) target = document.querySelector('[data-variant-index="' + match[1] + '"] [data-field="stockQuantity"]');
          else target = document.querySelector("#simple-stock");
        }
        if (target) showFieldError(target, issue.message || "Dữ liệu chưa hợp lệ.");
      }
      const first = document.querySelector(".is-invalid");
      if (first) {
        try { first.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
        try { first.focus(); } catch (_) {}
      }
    }

    ["input", "change"].forEach((evt) => {
      form.addEventListener(evt, (e) => {
        if (e.target.classList.contains("is-invalid")) {
          e.target.classList.remove("is-invalid");
          const p = e.target.closest(".workspace-fields label") || e.target.parentElement;
          p?.querySelectorAll(".field-error-msg").forEach((m) => m.remove());
        }
      });
    });

    function readRows() {
      const m = editor.model;
      for (const row of document.querySelectorAll("[data-variant-index]")) {
        const v = m.variants[Number(row.dataset.variantIndex)];
        if (!v) continue;
        for (const key of ["sku", "name", "imageUrl"]) {
          const field = row.querySelector('[data-field="' + key + '"]');
          if (field) v[key] = field.value;
        }
        for (const key of ["priceVnd", "stockQuantity"]) {
          const field = row.querySelector('[data-field="' + key + '"]');
          if (field) {
            const value = field.value;
            v[key] = value === "" ? null : Number(value);
          }
        }
        const act = row.querySelector("[data-field=active]");
        if (act) v.active = act.checked;
      }
    }

    function groupsFromForm() {
      const m = editor.model;
      const groups = [...document.querySelectorAll("[data-group-index]")].map((row) => ({
        name: row.querySelector("[data-group-name]").value.trim(),
        values: [...row.querySelectorAll("[data-group-value]")].map((input) => input.value.trim()).filter(Boolean)
      }));
      if (new Set(groups.map((g) => g.name.toLowerCase())).size !== groups.length) {
        throw Error("Tên nhóm phân loại không được trùng.");
      }
      for (const g of groups) {
        if (g.values.length > 20 || g.values.some((v) => v.length > 80)) {
          throw Error("Mỗi nhóm tối đa 20 lựa chọn, mỗi lựa chọn tối đa 80 ký tự.");
        }
        if (new Set(g.values.map((v) => v.toLowerCase())).size !== g.values.length) {
          throw Error("Lựa chọn trong một nhóm không được trùng.");
        }
        if (m.variants.some((v) => v.id && v.options[g.name] && !g.values.includes(v.options[g.name]))) {
          throw Error("Không bỏ lựa chọn đã có trong biến thể được lưu. Hãy tạm ẩn biến thể nếu ngừng bán.");
        }
      }
      return groups;
    }

    function syncSimpleInputs() {
      const v = editor.model.variants[0] || {};
      const sPrice = document.querySelector("#simple-price");
      const sStock = document.querySelector("#simple-stock");
      const sSku = document.querySelector("#simple-sku");
      if (sPrice && v.priceVnd !== undefined && v.priceVnd !== null) sPrice.value = v.priceVnd;
      if (sStock && v.stockQuantity !== undefined && v.stockQuantity !== null) sStock.value = v.stockQuantity;
      if (sSku) {
        if (v.sku) sSku.value = v.sku;
        else if (!sSku.value) {
          sSku.value = (slugify(form.elements.slug?.value || form.elements.name?.value || "GAERU").toUpperCase() + "-01").slice(0, 50);
          v.sku = sSku.value;
        }
      }
    }

    function setOptionMode(mode) {
      const btnSimple = document.querySelector("#btn-mode-simple");
      const btnVariants = document.querySelector("#btn-mode-variants");
      const simpleCard = document.querySelector("#simple-product-card");
      const variantsCard = document.querySelector("#variants-product-card");
      const varTableSection = document.querySelector("#variants");
      if (btnSimple) btnSimple.classList.toggle("is-active", mode === "simple");
      if (btnVariants) btnVariants.classList.toggle("is-active", mode === "variants");
      if (simpleCard) simpleCard.hidden = mode !== "simple";
      if (variantsCard) variantsCard.hidden = mode !== "variants";
      if (varTableSection) {
        const heading = varTableSection.querySelector("h2");
        if (heading) heading.textContent = mode === "simple" ? "Bảng chi tiết phiên bản" : "Giá bán & tồn kho từng biến thể";
      }
    }

    function groupEditor() {
      const m = editor.model;
      const gHost = document.querySelector("#option-groups");
      if (!gHost) return;
      gHost.innerHTML = m.groups
        .map((g, i) => {
          const existing = m.variants.some((v) => v.id && Object.hasOwn(v.options, g.name));
          const values = g.values.length ? g.values : [""];
          return (
            '<section class="option-group" data-group-index="' + i + '">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
            '<label style="flex:1;margin:0;"><strong>Tên nhóm ' + (i + 1) + '</strong><input data-group-name value="' + esc(g.name) + '" maxlength="50" ' + (existing ? "readonly" : "") + ' placeholder="Ví dụ: Cổng kết nối"></label>' +
            '<button type="button" class="plain-button" data-remove-group="' + i + '" ' + (existing ? "disabled" : "") + ' style="margin-left:14px;color:#dc2626;">Bỏ nhóm</button>' +
            "</div>" +
            '<div class="option-value-grid">' +
            values
              .map((value, n) => {
                const used = m.variants.some((v) => v.id && v.options[g.name] === value);
                return (
                  '<div class="option-value-cell"><input data-group-value aria-label="Lựa chọn ' + (n + 1) + " của nhóm " + (i + 1) + '" value="' + esc(value) + '" maxlength="80" placeholder="Nhập lựa chọn" ' + (used ? "readonly" : "") + ">" +
                  '<button type="button" data-remove-choice="' + i + ":" + n + '" ' + (used ? "disabled" : "") + ' aria-label="Bỏ lựa chọn ' + (n + 1) + '">×</button></div>'
                );
              })
              .join("") +
            '<button type="button" class="add-choice" data-add-choice="' + i + '" ' + (values.length >= 20 ? "disabled" : "") + ">＋ Thêm lựa chọn</button></div></section>"
          );
        })
        .join("");

      const addGroupBtn = document.querySelector("#add-group");
      if (addGroupBtn) addGroupBtn.disabled = m.groups.length >= 3 || !can("catalog.write");
    }

    function rows() {
      const m = editor.model;
      const countEl = document.querySelector("#variant-count");
      if (countEl) {
        countEl.textContent =
          m.variants.length + " biến thể · " +
          m.variants.filter((v) => v.active).length +
          (m.inTrash ? " được chọn để kích hoạt lại" : " đang bán");
      }
      const rHost = document.querySelector("#variant-rows");
      if (!rHost) return;
      rHost.innerHTML =
        m.variants
          .map((v, i) =>
            `<tr data-variant-index="${i}">` +
            `<td>${Object.entries(v.options).map(([key, value]) => `<span class="option-tag"><small>${esc(key)}</small>${esc(value)}</span>`).join("") || '<span class="option-tag">Tiêu chuẩn</span>'}</td>` +
            `<td><input data-field="sku" aria-label="SKU biến thể ${i + 1}" value="${esc(v.sku)}" maxlength="80" required placeholder="SKU"><input data-field="name" aria-label="Tên biến thể ${i + 1}" value="${esc(v.name)}" maxlength="160" required placeholder="Tên biến thể"></td>` +
            `<td><input type="number" data-field="priceVnd" aria-label="Giá biến thể ${i + 1}" value="${v.priceVnd ?? ""}" min="0" max="20000000" step="1" required placeholder="Giá (₫)"></td>` +
            `<td><input type="number" data-field="stockQuantity" aria-label="Tồn kho biến thể ${i + 1}" value="${v.stockQuantity ?? 0}" min="0" max="1000000" step="1" required ${can("inventory.approve") ? "" : "disabled"}></td>` +
            `<td><select data-field="imageUrl" aria-label="Ảnh biến thể ${i + 1}"><option value="">Dùng ảnh chính</option>${[...new Set([...m.gallery, ...(v.imageUrl ? [v.imageUrl] : [])])].map((url, n) => `<option value="${esc(url)}" ${url === v.imageUrl ? "selected" : ""}>${m.gallery.includes(url) ? "Ảnh " + (n + 1) : "Ảnh riêng"}</option>`).join("")}</select><button type="button" data-variant-upload="${i}">Tải ảnh riêng</button><input type="file" data-variant-file="${i}" accept="image/png,image/jpeg,image/webp" hidden>${v.imageUrl ? `<img class="variant-thumb" src="${esc(imageUrl(v.imageUrl))}" alt="${esc(v.name)}">` : ""}</td>` +
            `<td><input type="checkbox" data-field="active" aria-label="Bán biến thể ${i + 1}" ${v.active ? "checked" : ""}></td>` +
            `<td>${v.id ? "<small>Đã lưu</small>" : `<button type="button" class="plain-button" data-remove-variant="${i}">Bỏ</button>`}</td>` +
            `</tr>`
          )
          .join("") || '<tr><td colspan="7">Sản phẩm chưa có biến thể. Thêm lựa chọn hoặc nhập giá ở phía trên.</td></tr>';
      preview();
    }

    const btnSimple = document.querySelector("#btn-mode-simple");
    const btnVariants = document.querySelector("#btn-mode-variants");
    if (btnSimple && btnVariants) {
      btnSimple.onclick = () => {
        const m = editor.model;
        if (m.groups.length > 0 && m.variants.some((v) => v.id)) {
          if (!confirm("Sản phẩm đã có biến thể được lưu. Chuyển sang sản phẩm tiêu chuẩn sẽ đưa về 1 biến thể. Bạn có chắc không?")) return;
        }
        m.groups = [];
        const firstV = m.variants[0] || {};
        m.variants = [{
          ...firstV,
          sku: firstV.sku || (slugify(form.elements.slug?.value || form.elements.name?.value || "GAERU").toUpperCase() + "-01").slice(0, 50),
          name: "Phiên bản tiêu chuẩn",
          options: {},
          priceVnd: firstV.priceVnd ?? null,
          stockQuantity: firstV.stockQuantity ?? 10,
          active: true,
          imageUrl: firstV.imageUrl || ""
        }];
        setOptionMode("simple");
        syncSimpleInputs();
        groupEditor();
        rows();
        editor.dirty = true;
        preview();
      };

      btnVariants.onclick = () => {
        const m = editor.model;
        setOptionMode("variants");
        if (!m.groups.length) {
          m.groups = [{ name: "Màu sắc", values: ["Đen", "Trắng"] }];
          groupEditor();
          document.querySelector("#generate-variants")?.click();
        }
        editor.dirty = true;
        preview();
      };
    }

    const sPriceInp = document.querySelector("#simple-price");
    const sStockInp = document.querySelector("#simple-stock");
    const sSkuInp = document.querySelector("#simple-sku");
    const ensureFirstVariant = () => {
      if (!editor.model.variants.length) {
        editor.model.variants.push({ sku: "", name: "Phiên bản tiêu chuẩn", options: {}, priceVnd: null, stockQuantity: 0, active: true, imageUrl: "" });
      }
      return editor.model.variants[0];
    };
    if (sPriceInp) {
      sPriceInp.oninput = () => {
        ensureFirstVariant().priceVnd = sPriceInp.value === "" ? null : Number(sPriceInp.value);
        editor.dirty = true;
        preview();
      };
    }
    if (sStockInp) {
      sStockInp.oninput = () => {
        ensureFirstVariant().stockQuantity = sStockInp.value === "" ? 0 : Number(sStockInp.value);
        editor.dirty = true;
        preview();
      };
    }
    if (sSkuInp) {
      sSkuInp.oninput = () => {
        ensureFirstVariant().sku = sSkuInp.value.trim();
        editor.dirty = true;
        preview();
      };
      sSkuInp.addEventListener("input", () => { sSkuInp.dataset.manual = "true"; });
    }

    form.addEventListener("click", (e) => {
      const b = e.target.closest("[data-variant-upload]");
      if (b?.dataset.variantUpload !== undefined && !editor.busy && can("catalog.write")) {
        b.parentElement.querySelector("[data-variant-file]")?.click();
      }
    });

    form.addEventListener("change", async (e) => {
      if (e.target.matches("[data-variant-file]") && e.target.files.length) {
        const file = e.target.files[0];
        e.target.value = "";
        if (file.size > 8 * 1024 * 1024 || !/\.(png|jpe?g|webp)$/i.test(file.name)) {
          feedback("Chọn ảnh PNG, JPG hoặc WebP tối đa 8 MB.", true);
          return;
        }
        readRows();
        const row = e.target.closest("[data-variant-index]");
        const i = Number(row.dataset.variantIndex);
        feedback("Đang tải ảnh riêng cho biến thể…");
        lock(true);
        try {
          const data = new FormData();
          data.append("image", file);
          const result = await request("/api/gaeru_ceo/catalog-images", "POST", data);
          editor.model.variants[i].imageUrl = result.imageUrl;
          rows();
          feedback("Đã thêm ảnh riêng cho biến thể.");
        } catch (err) {
          feedback(err.message, true);
        } finally {
          lock(false);
        }
      }
    });

    form.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || editor.busy || !can("catalog.write")) return;
      const m = editor.model;
      if (b.dataset.addChoice !== undefined || b.dataset.removeChoice !== undefined) {
        try {
          const groupDomRows = [...document.querySelectorAll("[data-group-index]")];
          m.groups = groupDomRows.map((row) => ({
            name: row.querySelector("[data-group-name]").value.trim(),
            values: [...row.querySelectorAll("[data-group-value]")].map((input) => input.value)
          }));
          if (b.dataset.addChoice !== undefined) {
            const group = m.groups[Number(b.dataset.addChoice)];
            if (group.values.length >= 20) return;
            group.values.push("");
          } else {
            const [i, n] = b.dataset.removeChoice.split(":").map(Number);
            const g = m.groups[i];
            if (m.variants.some((v) => v.id && v.options[g.name] === g.values[n])) {
              throw Error("Không bỏ lựa chọn đã có trong biến thể lưu.");
            }
            g.values.splice(n, 1);
          }
          groupEditor();
          editor.dirty = true;
        } catch (error) {
          feedback(error.message, true);
        }
        return;
      }
      if (b.dataset.removeGroup !== undefined) {
        try {
          readRows();
          m.groups = groupsFromForm();
          m.groups.splice(Number(b.dataset.removeGroup), 1);
          groupEditor();
          editor.dirty = true;
        } catch (err) { feedback(err.message, true); }
        return;
      }
      if (b.dataset.removeVariant !== undefined) {
        readRows();
        m.variants.splice(Number(b.dataset.removeVariant), 1);
        rows();
        editor.dirty = true;
        return;
      }
      if (b.dataset.preset) {
        const presetMap = {
          color: { name: "Màu sắc", values: ["Đen", "Trắng"] },
          connector: { name: "Cổng kết nối", values: ["Type-C", "Lightning"] },
          mic: { name: "Bộ micro", values: ["1 Micro", "2 Micro"] }
        };
        const p = presetMap[b.dataset.preset];
        if (p) {
          if (m.groups.length >= 3) {
            feedback("Tối đa 3 nhóm phân loại cho mỗi sản phẩm.", true);
            return;
          }
          if (m.groups.some((g) => g.name.toLowerCase() === p.name.toLowerCase())) {
            feedback('Nhóm "' + p.name + '" đã có trong danh sách.', true);
            return;
          }
          m.groups.push(JSON.parse(JSON.stringify(p)));
          setOptionMode("variants");
          groupEditor();
          editor.dirty = true;
          preview();
          feedback("Đã thêm nhóm " + p.name + '. Bấm "⚡ Tạo các tổ hợp biến thể" để cập nhật bảng giá.');
        }
      }
    });

    form.addEventListener("keydown", (e) => {
      if (e.target.matches("[data-group-value]") && e.key === "Enter") {
        e.preventDefault();
        const groupSec = e.target.closest("[data-group-index]");
        if (groupSec) {
          const addBtn = groupSec.querySelector("[data-add-choice]");
          if (addBtn && !addBtn.disabled) {
            addBtn.click();
            const inputs = groupSec.querySelectorAll("[data-group-value]");
            const lastInput = inputs[inputs.length - 1];
            if (lastInput) lastInput.focus();
          }
        }
      }
    });

    form.addEventListener("change", (e) => {
      if (e.target.matches("[data-group-value],[data-group-name]")) {
        try { editor.model.groups = groupsFromForm(); preview(); } catch (err) { feedback(err.message, true); }
      }
      if (e.target.matches("[data-field]")) { readRows(); editor.dirty = true; preview(); }
    });

    const applyBulkBtn = document.querySelector("#apply-variant-bulk");
    if (applyBulkBtn) {
      applyBulkBtn.onclick = () => {
        readRows();
        const priceVal = document.querySelector("#bulk-price")?.value;
        const stockVal = document.querySelector("#bulk-stock")?.value;
        if (priceVal === "" && stockVal === "") return feedback("Nhập giá hoặc tồn kho cần áp dụng chung.", true);
        for (const v of editor.model.variants) {
          if (priceVal !== "") v.priceVnd = Number(priceVal);
          if (stockVal !== "" && can("inventory.approve")) v.stockQuantity = Number(stockVal);
        }
        rows();
        editor.dirty = true;
        feedback("Đã áp dụng thông số chung cho tất cả biến thể.");
      };
    }

    const addGroupBtn = document.querySelector("#add-group");
    if (addGroupBtn) {
      addGroupBtn.onclick = () => {
        try {
          editor.model.groups = groupsFromForm();
          if (editor.model.groups.length >= 3) throw Error("Tối đa 3 nhóm phân loại.");
          editor.model.groups.push({ name: "", values: [] });
          setOptionMode("variants");
          groupEditor();
          editor.dirty = true;
        } catch (e) { feedback(e.message, true); }
      };
    }

    const genVariantsBtn = document.querySelector("#generate-variants");
    if (genVariantsBtn) {
      genVariantsBtn.onclick = () => {
        try {
          const m = editor.model;
          readRows();
          m.groups = groupsFromForm();
          if (!m.groups.length) throw Error("Thêm ít nhất một nhóm phân loại trước.");
          for (const g of m.groups) {
            if (!g.values.length) throw Error('Nhóm "' + g.name + '" cần ít nhất một lựa chọn.');
          }
          const combos = choices.combinations(m.groups);
          const priceVal = document.querySelector("#default-price")?.value;
          const existing = m.variants.map((v) => ({
            ...v,
            options: Object.fromEntries(m.groups.map((g) => [g.name, v.options[g.name] || g.values[0]]))
          }));
          const used = new Set(existing.map((v) => v.sku));
          let number = 1;
          const prefix = slugify(document.querySelector("#sku-prefix")?.value || form.elements.slug?.value || "GAERU").toUpperCase().slice(0, 50);
          const generated = combos.map((options) => {
            const found = existing.find((v) => choices.signature(v.options) === choices.signature(options));
            if (found) return found;
            let sku;
            do { sku = prefix + "-" + String(number++).padStart(2, "0"); } while (used.has(sku));
            used.add(sku);
            return {
              sku,
              name: Object.values(options).join(" · ").slice(0, 160),
              options,
              priceVnd: priceVal === "" || priceVal === undefined ? null : Number(priceVal),
              stockQuantity: 0,
              active: true,
              imageUrl: ""
            };
          });
          for (const v of existing.filter((v) => v.id)) {
            if (!generated.some((n) => n.id === v.id)) generated.push(v);
          }
          m.variants = generated;
          rows();
          groupEditor();
          editor.dirty = true;
          feedback("Đã tạo " + generated.length + " biến thể. Kiểm tra giá, SKU và tồn kho bên dưới.");
          document.querySelector("#variants")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } catch (e) {
          feedback(e.message, true);
          showFieldError(document.querySelector("#options"), e.message);
        }
      };
    }

    const addSingleBtn = document.querySelector("#add-single");
    if (addSingleBtn) {
      addSingleBtn.onclick = () => {
        readRows();
        const nextIdx = editor.model.variants.length + 1;
        editor.model.variants.push({
          sku: (slugify(form.elements.slug?.value || form.elements.name?.value || "GAERU").toUpperCase() + "-" + String(nextIdx).padStart(2, "0")).slice(0, 50),
          name: "Phiên bản " + nextIdx,
          options: {},
          priceVnd: null,
          stockQuantity: 0,
          active: true,
          imageUrl: ""
        });
        rows();
        editor.dirty = true;
      };
    }

    function validateBeforeSave(isPublish) {
      const m = editor.model;
      clearValidationErrors();

      const nameVal = form.elements.name?.value.trim() || "";
      if (nameVal.length < 2) {
        showFieldError(form.elements.name, "Tên sản phẩm phải từ 2 đến 160 ký tự.");
        throw Error("Tên sản phẩm phải từ 2 đến 160 ký tự.");
      }

      const slugVal = form.elements.slug?.value.trim() || "";
      if (!slugVal || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slugVal)) {
        showFieldError(form.elements.slug, "Đường dẫn chỉ dùng chữ thường không dấu, số và dấu gạch nối (ví dụ: micro-k9).");
        throw Error("Đường dẫn sản phẩm chưa đúng định dạng.");
      }

      if (!m.gallery.length) {
        showFieldError(document.querySelector("#gallery"), "Vui lòng tải lên ít nhất một ảnh sản phẩm.");
        throw Error("Hãy thêm ít nhất một ảnh sản phẩm.");
      }

      if (form.elements.description?.value.length > 3000) {
        showFieldError(document.querySelector("#description-media"), "Mô tả chi tiết tối đa 3000 ký tự.");
        throw Error("Mô tả tối đa 3000 ký tự.");
      }

      if (m.groups.length) {
        m.groups = groupsFromForm();
      }

      if (!m.groups.length) {
        if (!m.variants.length) {
          m.variants = [{ sku: "", name: "Phiên bản tiêu chuẩn", options: {}, priceVnd: null, stockQuantity: 10, active: true, imageUrl: "" }];
        }
        const sP = document.querySelector("#simple-price");
        const sS = document.querySelector("#simple-stock");
        const sK = document.querySelector("#simple-sku");
        if (sP && sP.value !== "") m.variants[0].priceVnd = Number(sP.value);
        if (sS && sS.value !== "") m.variants[0].stockQuantity = Number(sS.value);
        if (sK && sK.value.trim() !== "") m.variants[0].sku = sK.value.trim();
        if (!m.variants[0].sku) {
          m.variants[0].sku = (slugify(slugVal || nameVal).toUpperCase() + "-01").slice(0, 50);
          if (sK) sK.value = m.variants[0].sku;
        }
        if (m.variants[0].priceVnd === null || isNaN(m.variants[0].priceVnd) || m.variants[0].priceVnd < 0) {
          if (sP) showFieldError(sP, "Vui lòng nhập giá bán cho sản phẩm (từ 0₫ đến 20.000.000₫).");
          throw Error("Vui lòng nhập giá bán cho sản phẩm.");
        }
        if (!/^[a-zA-Z0-9._-]+$/.test(m.variants[0].sku)) {
          if (sK) showFieldError(sK, "Mã SKU chỉ gồm chữ, số và dấu gạch nối/chấm.");
          throw Error("Mã SKU không hợp lệ.");
        }
      } else {
        if (!m.variants.length) {
          showFieldError(document.querySelector("#generate-variants") || document.querySelector("#options"), 'Vui lòng bấm "⚡ Tạo các tổ hợp biến thể" để hoàn tất thiết lập.');
          throw Error("Chưa có biến thể nào được tạo.");
        }
        for (let i = 0; i < m.variants.length; i++) {
          const v = m.variants[i];
          const row = document.querySelector('[data-variant-index="' + i + '"]');
          if (v.priceVnd === null || isNaN(v.priceVnd) || v.priceVnd < 0) {
            if (row) showFieldError(row.querySelector('[data-field="priceVnd"]'), "Nhập giá bán (từ 0₫ đến 20.000.000₫).");
            throw Error("Nhập giá cho tất cả biến thể trước khi lưu.");
          }
          if (!v.sku || !/^[a-zA-Z0-9._-]+$/.test(v.sku)) {
            if (row) showFieldError(row.querySelector('[data-field="sku"]'), "Nhập SKU hợp lệ (chữ, số, gạch nối).");
            throw Error("SKU của biến thể chưa đúng định dạng.");
          }
        }
      }

      if (!m.inTrash && isPublish && !m.variants.some((v) => v.active)) {
        showFieldError(document.querySelector("#variants"), "Cần ít nhất một biến thể đang bán trước khi xuất bản.");
        throw Error("Cần ít nhất một biến thể đang bán trước khi xuất bản.");
      }
    }

    return {
      clearValidationErrors,
      showFieldError,
      applyIssues,
      validateBeforeSave,
      readRows,
      groupsFromForm,
      syncSimpleInputs,
      setOptionMode,
      groupEditor,
      rows
    };
  }
};
