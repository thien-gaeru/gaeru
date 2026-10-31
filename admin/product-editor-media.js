// admin/product-editor-media.js — Quản lý bộ ảnh sản phẩm (Gallery) & trình soạn thảo mô tả đa phương tiện

window.GAERUProductEditorMedia = {
  createMediaController(editor) {
    const { form, esc, imageUrl, can, request, lock, feedback, preview } = editor;
    const imageUploads = [];
    let uploadWorker = null;
    let insertionAfter = null;

    function gallery() {
      const m = editor.model;
      const gHost = document.querySelector("#gallery");
      if (!gHost) return;
      gHost.innerHTML =
        m.gallery
          .map((url, i) =>
            '<article class="gallery-item"><img src="' + esc(imageUrl(url)) + '" alt="Ảnh sản phẩm ' + (i + 1) + '"><span>' +
            (i === 0 ? "Ảnh chính" : "Ảnh " + (i + 1)) + "</span><div>" +
            (i ? '<button type="button" data-main-image="' + i + '">Đặt ảnh chính</button>' : "") +
            '<button type="button" data-remove-image="' + i + '" aria-label="Bỏ ảnh ' + (i + 1) + '">×</button></div></article>'
          )
          .join("") +
        imageUploads
          .map((item) =>
            '<article class="gallery-item upload-pending" aria-busy="' + (item.error ? "false" : "true") + '"><img src="' +
            esc(item.preview) + '" alt="' + esc(item.file.name) + '"><span>' +
            (item.error ? "Tải chưa thành công" : "Đang tải ảnh…") + "</span><div>" +
            (item.error
              ? '<button type="button" data-retry-upload="' + item.id + '">Thử lại</button><button type="button" data-discard-upload="' + item.id + '">Bỏ</button>'
              : "<small>Có thể tiếp tục nhập sản phẩm</small>") +
            "</div></article>"
          )
          .join("") +
        (!m.gallery.length && !imageUploads.length
          ? '<button type="button" class="gallery-slot is-main" data-upload-slot aria-label="Tải ảnh chính"><span aria-hidden="true">＋</span>Ảnh chính</button>'
          : "") +
        (m.gallery.length + imageUploads.length < 9
          ? '<button type="button" class="gallery-slot" data-upload-slot aria-label="Thêm ảnh sản phẩm"><span aria-hidden="true">＋</span>Thêm ảnh · ' + (m.gallery.length + imageUploads.length) + "/9</button>"
          : "");
      preview();
    }

    function upload(files) {
      if (editor.busy || !can("catalog.write")) return Promise.resolve();
      const gf = document.querySelector("#gallery-files");
      if (gf) gf.value = "";
      if (editor.model.gallery.length + imageUploads.length + files.length > 9) {
        feedback("Tối đa 9 ảnh cho mỗi sản phẩm.", true);
        return Promise.resolve();
      }
      if (files.some((file) => file.size > 8 * 1024 * 1024 || !/\.(png|jpe?g|webp)$/i.test(file.name))) {
        feedback("Chọn ảnh PNG, JPG hoặc WebP, tối đa 8 MB/ảnh.", true);
        return Promise.resolve();
      }
      for (const file of files) {
        imageUploads.push({ id: ++upload.sequence, file, preview: URL.createObjectURL(file), error: false });
      }
      editor.dirty = true;
      gallery();
      return runUploads();
    }
    upload.sequence = 0;

    function runUploads() {
      if (uploadWorker) return uploadWorker;
      uploadWorker = (async () => {
        let item;
        while ((item = imageUploads.find((v) => !v.error))) {
          feedback("Đang tải ảnh… Bạn có thể tiếp tục nhập hoặc thêm ảnh.");
          try {
            const data = new FormData();
            data.append("image", item.file);
            const result = await request("/api/gaeru_ceo/catalog-images", "POST", data);
            editor.readRows();
            editor.model.gallery.push(result.imageUrl);
            imageUploads.splice(imageUploads.indexOf(item), 1);
            URL.revokeObjectURL(item.preview);
            editor.rows();
          } catch (error) {
            item.error = true;
            item.message = error.message;
          }
          gallery();
        }
        feedback(
          imageUploads.length
            ? "Có ảnh chưa tải được. Bấm Thử lại hoặc Bỏ trước khi lưu."
            : "Đã tải ảnh. Lưu sản phẩm để áp dụng bộ ảnh.",
          Boolean(imageUploads.length)
        );
      })().finally(() => { uploadWorker = null; });
      return uploadWorker;
    }

    function readMedia() {
      const activeModel = typeof editor !== "undefined" ? editor.model : model;
      const activeForm = typeof editor !== "undefined" ? editor.form : form;
      const host = document.querySelector("#description-media");
      if (!host || !host.dataset.ready) return;
      const paragraphs = [];
      const media = [];
      for (const row of host.children) {
        const text = row.querySelector("[data-description-text]");
        if (text) {
          paragraphs.push(...text.value.split(/\n\s*\n/).map((v) => v.trim()).filter(Boolean));
          continue;
        }
        const item = activeModel.descriptionMedia[Number(row.dataset.descriptionIndex)];
        if (!item) continue;
        const altInput = row.querySelector("[data-media-alt]");
        const captionInput = row.querySelector("[data-media-caption]");
        media.push({
          ...item,
          alt: altInput ? altInput.value : item.alt,
          caption: captionInput ? captionInput.value : item.caption,
          afterParagraph: paragraphs.length
        });
      }
      activeForm.elements.description.value = paragraphs.join("\n\n");
      activeModel.descriptionMedia = media;
      countDescription();
      [...host.querySelectorAll("[data-description-index]")].forEach((row, i) => { row.dataset.descriptionIndex = i; });
    }

    function fitText(field) {
      if (!field?.style) return;
      field.style.height = "auto";
      field.style.height = Math.max(120, field.scrollHeight || 120) + "px";
    }

    function handle() {
      return '<button type="button" class="description-drag-handle" data-block-handle aria-label="Di chuyển mục này. Giữ và kéo để đổi vị trí">⋮⋮ <span>Kéo thả vị trí</span></button>';
    }

    function countDescription() {
      const n = form.elements.description?.value.length || 0;
      const counter = document.querySelector("[data-description-count]");
      if (counter) {
        counter.textContent = n + " / 3000 ký tự · " + (editor.model.descriptionMedia || []).length + " / 12 ảnh hoặc video";
        counter.classList.toggle("is-over-limit", n > 3000);
      }
    }

    function blockTools(text = false) {
      return (
        '<div class="description-block-actions">' +
        (text ? '<button type="button" data-block-action="bold">Đậm</button>' : "") +
        '<button type="button" data-block-action="up" aria-label="Đưa nội dung lên">↑</button>' +
        '<button type="button" data-block-action="down" aria-label="Đưa nội dung xuống">↓</button>' +
        '<button type="button" data-block-action="text">+ Chữ sau</button>' +
        '<button type="button" data-block-action="image">+ Ảnh sau</button>' +
        '<button type="button" data-block-action="video">+ Video sau</button>' +
        '<button type="button" data-block-action="remove" class="plain-button" aria-label="Xóa mục">🗑️ Xóa</button>' +
        "</div>"
      );
    }

    function textBlock(value = "") {
      return `<article class="description-text-card" data-description-block draggable="true">${handle()}<label>Đoạn mô tả<textarea data-description-text lang="vi" dir="auto" spellcheck="true" rows="4" maxlength="3000" placeholder="Nhập nội dung mô tả…">${esc(value)}</textarea></label>${blockTools(true)}</article>`;
    }

    function attachBlockDrag(host) {
      if (!host) return;
      let dragging = null;
      host.querySelectorAll("[data-description-block]").forEach((block) => {
        block.setAttribute("draggable", "true");
        block.ondragstart = (e) => {
          if (e.target.closest("input,textarea,select,button:not([data-block-handle])")) {
            if (!e.target.closest("[data-block-handle]")) {
              e.preventDefault();
              return;
            }
          }
          dragging = block;
          block.classList.add("is-dragging");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", "block");
        };
        block.ondragend = () => {
          block.classList.remove("is-dragging");
          host.querySelectorAll(".drop-target-before, .drop-target-after").forEach((el) =>
            el.classList.remove("drop-target-before", "drop-target-after")
          );
          dragging = null;
        };
        block.ondragover = (e) => {
          if (!dragging || dragging === block) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const rect = block.getBoundingClientRect();
          const isTop = e.clientY < rect.top + rect.height / 2;
          block.classList.toggle("drop-target-before", isTop);
          block.classList.toggle("drop-target-after", !isTop);
        };
        block.ondragleave = () => {
          block.classList.remove("drop-target-before", "drop-target-after");
        };
        block.ondrop = (e) => {
          if (!dragging || dragging === block) return;
          e.preventDefault();
          const rect = block.getBoundingClientRect();
          const isTop = e.clientY < rect.top + rect.height / 2;
          if (isTop) block.before(dragging);
          else block.after(dragging);
          block.classList.remove("drop-target-before", "drop-target-after");
          readMedia();
          editor.dirty = true;
          preview();
        };
      });
    }

    function mediaEditor() {
      const m = editor.model;
      m.descriptionMedia ||= [];
      const parts = form.elements.description.value.split(/\n\s*\n/).map((v) => v.trim()).filter(Boolean);
      const host = document.querySelector("#description-media");
      if (!host) return;
      const at = (n) =>
        m.descriptionMedia
          .map((item, i) => ({ m: item, i }))
          .filter(({ m: item }) => (item.afterParagraph == null ? parts.length : Math.min(parts.length, item.afterParagraph)) === n)
          .map(({ m: item, i }) =>
            `<article class="description-media-card" data-description-block data-description-index="${i}" draggable="true">${handle()}${item.type === "image" ? `<img src="${esc(imageUrl(item.url))}" alt="${esc(item.alt)}">` : `<video controls preload="metadata" src="${esc(imageUrl(item.url))}" aria-label="${esc(item.alt)}"></video>`}<label>Mô tả ảnh/video<input data-media-alt required minlength="3" maxlength="250" value="${esc(item.alt)}"></label><label>Chú thích hiển thị<input data-media-caption maxlength="300" value="${esc(item.caption || "")}"></label>${blockTools()}</article>`
          )
          .join("");
      const oldTop = host.scrollTop || 0;
      host.innerHTML = at(0) + parts.map((part, i) => textBlock(part) + at(i + 1)).join("") + (!parts.length && !m.descriptionMedia.length ? textBlock() : "");
      host.dataset.ready = "true";
      host.querySelectorAll("[data-description-text]").forEach(fitText);
      host.scrollTop = oldTop;
      attachBlockDrag(host);
      countDescription();
    }

    function descriptionPosition() {
      if (!insertionAfter) return null;
      let count = 0;
      const host = document.querySelector("#description-media");
      if (!host) return null;
      for (const row of host.children) {
        const t = row.querySelector("[data-description-text]");
        if (t) count += t.value.split(/\n\s*\n/).filter((v) => v.trim()).length;
        if (row === insertionAfter) break;
      }
      return count;
    }

    function uploadDescription(files, type) {
      if (editor.busy || imageUploads.length || !can("catalog.write")) return;
      editor.model.descriptionMedia ||= [];
      if (editor.model.descriptionMedia.length + files.length > 12) {
        return feedback("Tối đa 12 ảnh/video mô tả.", true);
      }
      editor.readRows();
      readMedia();
      const position = descriptionPosition();
      const host = document.querySelector("#description-media");
      let insertAt = insertionAfter
        ? [...host.children].slice(0, [...host.children].indexOf(insertionAfter) + 1).filter((row) => row.hasAttribute("data-description-index")).length
        : editor.model.descriptionMedia.length;
      lock(true);
      feedback("Đang tải tệp vào chi tiết sản phẩm…");
      return (async () => {
        try {
          for (const file of files) {
            if (file.size > (type === "image" ? 8 : 25) * 1024 * 1024) {
              throw Error(type === "image" ? "Ảnh tối đa 8 MB." : "Video tối đa 25 MB.");
            }
            const data = new FormData();
            data.append(type, file);
            const result = await request("/api/gaeru_ceo/" + (type === "image" ? "catalog-images" : "catalog-videos"), "POST", data);
            editor.model.descriptionMedia.splice(insertAt++, 0, {
              type,
              url: result.imageUrl || result.url,
              alt: ("Mô tả " + file.name.replace(/\.[^.]+$/, "")).slice(0, 250),
              caption: "",
              afterParagraph: position
            });
            editor.dirty = true;
          }
          mediaEditor();
          feedback("Đã tải nội dung minh họa. Kéo thả để đổi vị trí nếu cần.");
        } catch (error) {
          mediaEditor();
          feedback(error.message, true);
        } finally {
          lock(false);
        }
      })();
    }

    const descShell = document.querySelector(".description-editor-shell");
    if (descShell) {
      ["dragenter", "dragover"].forEach((evt) => {
        descShell.addEventListener(evt, (e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            e.stopPropagation();
            descShell.classList.add("file-drag-active");
          }
        });
      });
      ["dragleave", "drop"].forEach((evt) => {
        descShell.addEventListener(evt, (e) => {
          if (!descShell.contains(e.relatedTarget) || evt === "drop") {
            descShell.classList.remove("file-drag-active");
          }
        });
      });
      descShell.addEventListener("drop", async (e) => {
        if (e.dataTransfer.files && e.dataTransfer.files.length) {
          e.preventDefault();
          e.stopPropagation();
          descShell.classList.remove("file-drag-active");
          const files = [...e.dataTransfer.files];
          const imgs = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
          const vids = files.filter((f) => /\.(mp4)$/i.test(f.name));
          if (imgs.length) await uploadDescription(imgs, "image");
          if (vids.length) await uploadDescription(vids, "video");
        }
      });
    }

    const gBox = document.querySelector("#gallery");
    if (gBox) {
      ["dragenter", "dragover"].forEach((evt) => {
        gBox.addEventListener(evt, (e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            gBox.style.borderColor = "#0284c7";
          }
        });
      });
      ["dragleave", "drop"].forEach((evt) => {
        gBox.addEventListener(evt, () => { gBox.style.borderColor = ""; });
      });
      gBox.addEventListener("drop", async (e) => {
        if (e.dataTransfer.files && e.dataTransfer.files.length) {
          e.preventDefault();
          const imgs = [...e.dataTransfer.files].filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
          if (imgs.length) await upload(imgs);
        }
      });
    }

    form.addEventListener("click", (e) => {
      const b = e.target.closest("[data-block-action]");
      if (!b?.dataset.blockAction || editor.busy || !can("catalog.write")) return;
      const row = b.closest("[data-description-block]");
      const host = row.parentElement;
      const action = b.dataset.blockAction;
      if (action === "bold") {
        const field = row.querySelector("[data-description-text]");
        if (!field) return;
        const start = field.selectionStart;
        const end = field.selectionEnd;
        field.setRangeText("**" + (field.value.slice(start, end) || "chữ nhấn mạnh") + "**", start, end, "select");
        field.focus();
        fitText(field);
        readMedia();
        editor.dirty = true;
        return;
      }
      if (action === "image") { readMedia(); insertionAfter = row; document.querySelector("#description-images")?.click(); return; }
      if (action === "video") { readMedia(); insertionAfter = row; document.querySelector("#description-video")?.click(); return; }
      if (action === "text") {
        row.insertAdjacentHTML("afterend", textBlock());
        attachBlockDrag(host);
        row.nextElementSibling.querySelector("textarea")?.focus();
      }
      if (action === "up" && row.previousElementSibling) host.insertBefore(row, row.previousElementSibling);
      if (action === "down" && row.nextElementSibling) host.insertBefore(row.nextElementSibling, row);
      if (action === "remove") row.remove();
      readMedia();
      editor.dirty = true;
      preview();
    });

    const addDescText = document.querySelector("#add-description-text");
    if (addDescText) {
      addDescText.onclick = () => {
        if (editor.busy || !can("catalog.write")) return;
        const host = document.querySelector("#description-media");
        if (!host) return;
        host.insertAdjacentHTML("beforeend", textBlock());
        attachBlockDrag(host);
        const field = host.lastElementChild?.querySelector("textarea");
        if (field) {
          field.focus({ preventScroll: true });
          field.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
        editor.dirty = true;
      };
    }

    const addDescImgs = document.querySelector("#add-description-images");
    if (addDescImgs) addDescImgs.onclick = () => { insertionAfter = null; document.querySelector("#description-images")?.click(); };
    const addDescVid = document.querySelector("#add-description-video");
    if (addDescVid) addDescVid.onclick = () => { insertionAfter = null; document.querySelector("#description-video")?.click(); };

    for (const [id, type] of [["description-images", "image"], ["description-video", "video"]]) {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", async (e) => { await uploadDescription([...e.target.files], type); e.target.value = ""; });
    }

    window.GAERUDescriptionEditor?.mount(document.querySelector("#description-media"), {
      canEdit: () => !editor.busy && can("catalog.write"),
      changed: () => { readMedia(); editor.dirty = true; },
      announce: (text) => {
        const a = document.querySelector("[data-description-announcement]");
        if (a) a.textContent = text;
      }
    });

    const gfInput = document.querySelector("#gallery-files");
    if (gfInput) gfInput.addEventListener("change", (e) => upload([...e.target.files]));

    form.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || editor.busy || !can("catalog.write")) return;
      if (b.dataset.retryUpload !== undefined) {
        const item = imageUploads.find((v) => v.id === Number(b.dataset.retryUpload));
        if (item) { item.error = false; gallery(); runUploads(); }
        return;
      }
      if (b.dataset.discardUpload !== undefined) {
        const i = imageUploads.findIndex((v) => v.id === Number(b.dataset.discardUpload));
        if (i >= 0) { URL.revokeObjectURL(imageUploads[i].preview); imageUploads.splice(i, 1); gallery(); }
        return;
      }
      if (b.hasAttribute("data-upload-slot")) {
        document.querySelector("#gallery-files")?.click();
        return;
      }
      if (b.dataset.mainImage !== undefined) {
        editor.readRows();
        const [url] = editor.model.gallery.splice(Number(b.dataset.mainImage), 1);
        editor.model.gallery.unshift(url);
        gallery();
        editor.rows();
        editor.dirty = true;
      } else if (b.dataset.removeImage !== undefined) {
        editor.readRows();
        editor.model.gallery.splice(Number(b.dataset.removeImage), 1);
        gallery();
        editor.rows();
        editor.dirty = true;
      }
    });

    form.addEventListener("change", (e) => {
      if (e.target.matches("[data-media-position]")) { readMedia(); editor.dirty = true; }
      if (e.target === form.elements.description) { readMedia(); mediaEditor(); }
    });

    return {
      gallery,
      upload,
      runUploads,
      readMedia,
      countDescription,
      mediaEditor,
      uploadDescription,
      hasPendingUploads: () => imageUploads.length > 0
    };
  }
};
