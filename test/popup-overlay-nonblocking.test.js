"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.resolve(__dirname, "..");

test("account-security.css does not hide non-dialog .gaeru-center-popup or strip .gaeru-modal-backdrop background", () => {
  const securityCss = fs.readFileSync(path.join(rootDir, "account-security.css"), "utf8");
  const feedbackCss = fs.readFileSync(path.join(rootDir, "action-feedback.css"), "utf8");

  // Ensure the broken global rule `.gaeru-center-popup:not([open])` is replaced by dialog-scoped rule
  assert.equal(
    /(^|[\s,}])\.gaeru-center-popup:not\(\[open\]\)/.test(securityCss),
    false,
    "account-security.css must not globally hide non-dialog .gaeru-center-popup:not([open])"
  );
  assert.match(securityCss, /dialog\.gaeru-center-popup:not\(\[open\]\)/);
  assert.match(securityCss, /\.gaeru-center-popup\[hidden\]/);
  assert.match(securityCss, /\.gaeru-center-popup\.is-closing\s*\{[^}]*pointer-events:\s*none\s*!important/s);

  // Ensure .gaeru-modal-backdrop preserves its dimmed background and hides when [hidden]
  assert.match(feedbackCss, /\.gaeru-modal-backdrop\s*\{[^}]*background:\s*rgba\(15,\s*23,\s*42,\s*0\.55\)\s*!important/s);
  assert.match(feedbackCss, /\.gaeru-modal-backdrop\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
  assert.match(feedbackCss, /\.gaeru-action-notices:empty/);
});

test("hidden backdrops and closed accordions enforce display:none and pointer-events:none across all stylesheets", () => {
  const upgradeCss = fs.readFileSync(path.join(rootDir, "account-upgrade.css"), "utf8");
  const workspaceCss = fs.readFileSync(path.join(rootDir, "admin", "admin-workspace.css"), "utf8");
  const internalAiCss = fs.readFileSync(path.join(rootDir, "admin", "internal-ai.css"), "utf8");
  const opsCss = fs.readFileSync(path.join(rootDir, "admin", "operational-tools.css"), "utf8");

  assert.match(upgradeCss, /\.security-accordion-item:not\(\[open\]\)\s*>\s*\.security-accordion-body/);
  assert.match(upgradeCss, /\.security-accordion-item:not\(\[open\]\)\s+\.security-modal-backdrop/);
  assert.match(workspaceCss, /\.config-modal-backdrop\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
  assert.match(internalAiCss, /\.gaeru-ai-modal-backdrop\[hidden\]\s*\{[^}]*pointer-events:\s*none\s*!important/s);
  assert.match(internalAiCss, /body:has\(dialog\[open\]\)\s+\.floating-copilot-trigger/);
  assert.match(opsCss, /\.operations-dialog:not\(\[open\]\)\s*,\s*\.operations-dialog\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
});

test("GAERUNotify modal sets [open], resolves on backdrop click or Escape, and survives parent dialog close", async () => {
  const code = fs.readFileSync(path.join(rootDir, "action-feedback.js"), "utf8");

  const docListeners = new Map();

  class Target {
    addEventListener(type, fn) {
      if (!this._listeners) this._listeners = new Map();
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      if (!this._listeners) return;
      const arr = this._listeners.get(type) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
    dispatchEvent(ev) {
      if (!this._listeners) return;
      const arr = [...(this._listeners.get(ev.type) || [])];
      for (const fn of arr) fn.call(this, ev);
    }
  }

  class Element extends Target {
    constructor(tag = "div") {
      super();
      this.tagName = String(tag).toUpperCase();
      this.className = "";
      this.id = "";
      this.hidden = false;
      this.open = false;
      this.style = {};
      this.dataset = {};
      this.isConnected = true;
      this.parentElement = null;
      this.children = [];
      this._attrs = new Map();
      this._classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((n) => this._classes.add(n)),
        remove: (...names) => names.forEach((n) => this._classes.delete(n)),
        contains: (n) => this._classes.has(n) || String(this.className).split(/\s+/).includes(n),
        toggle: (n, force) => {
          const shouldAdd = force === undefined ? !this._classes.has(n) : Boolean(force);
          if (shouldAdd) this._classes.add(n);
          else this._classes.delete(n);
          return shouldAdd;
        }
      };
    }
    setAttribute(k, v) {
      this._attrs.set(k, String(v));
      if (k === "open") this.open = true;
      if (k === "hidden") this.hidden = true;
    }
    getAttribute(k) {
      return this._attrs.has(k) ? this._attrs.get(k) : null;
    }
    hasAttribute(k) {
      return this._attrs.has(k);
    }
    removeAttribute(k) {
      this._attrs.delete(k);
      if (k === "open") this.open = false;
      if (k === "hidden") this.hidden = false;
    }
    append(...items) {
      for (const item of items) {
        if (item && typeof item === "object") {
          item.parentElement = this;
          item.isConnected = true;
          this.children.push(item);
        }
      }
    }
    appendChild(item) {
      this.append(item);
      return item;
    }
    remove() {
      this.isConnected = false;
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
        this.parentElement = null;
      }
    }
    querySelector(sel) {
      if (sel.includes(".gaeru-modal-btn-confirm")) return this._confirmBtn;
      if (sel.includes(".gaeru-modal-btn-cancel")) return this._cancelBtn;
      if (sel.includes(".gaeru-modal-input")) return this._inputEl;
      return null;
    }
    set innerHTML(val) {
      this._html = val;
      this._confirmBtn = new Element("button");
      this._cancelBtn = new Element("button");
      this._inputEl = val.includes("gaeru-modal-input") ? Object.assign(new Element("input"), { value: "Khách đổi ý" }) : null;
    }
    get innerHTML() {
      return this._html || "";
    }
  }

  for (const name of ["onclick", "onsubmit"]) {
    Object.defineProperty(Element.prototype, name, {
      configurable: true,
      get() { return this["native_" + name]; },
      set(value) { this["native_" + name] = value; }
    });
  }

  const body = new Element("body");
  let openDialog = null;

  const document = {
    body,
    createElement: (tag) => new Element(tag),
    querySelector: (sel) => {
      if (sel === "dialog[open]" && openDialog?.open) return openDialog;
      const activeBackdrop = body.children.find((c) => String(c.className).includes("gaeru-center-popup") && !c.hidden);
      if (sel.includes(".gaeru-center-popup") && activeBackdrop) return activeBackdrop;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === "dialog[open]") return openDialog?.open ? [openDialog] : [];
      return [];
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = docListeners.get(type) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
  };

  const windowObj = {
    document,
    EventTarget: Target,
    HTMLElement: Element,
    MutationObserver: class { observe() {} },
    getComputedStyle: (el) => ({
      display: el.hidden ? "none" : "flex",
      visibility: "visible"
    }),
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    fetch: async () => ({ ok: true, status: 200, clone() { return this; }, json: async () => ({}) })
  };

  const sandbox = {
    window: windowObj,
    document,
    EventTarget: Target,
    HTMLElement: Element,
    MutationObserver: windowObj.MutationObserver,
    URL,
    Request,
    Promise,
    location: { href: "https://gaeru.example/gaeru_ceo", origin: "https://gaeru.example" },
    queueMicrotask,
    setTimeout: windowObj.setTimeout,
    clearTimeout: windowObj.clearTimeout,
    fetch: windowObj.fetch
  };

  vm.runInNewContext(code, sandbox);

  assert.ok(windowObj.GAERUNotify, "GAERUNotify must be exposed on window");

  // 1. Confirm modal sets open="" attribute and resolves false on backdrop click
  const confirmPromise = windowObj.GAERUNotify.confirm("Xác nhận xóa đơn hàng?");
  const backdrop = body.children.find((c) => String(c.className).includes("gaeru-modal-backdrop"));
  assert.ok(backdrop, "Confirm modal backdrop must be mounted in body");
  assert.equal(backdrop.getAttribute("open"), "", "Confirm modal backdrop must have open attribute set");
  backdrop.onclick({ target: backdrop });
  const confirmResult = await confirmPromise;
  assert.equal(confirmResult, false, "Clicking backdrop must resolve confirm(false)");
  assert.equal(backdrop.isConnected, false, "Backdrop must be removed after closing");

  // 2. Prompt modal inside an open <dialog> survives if the parent <dialog> closes before user responds
  openDialog = new Element("dialog");
  openDialog.open = true;
  const promptPromise = windowObj.GAERUNotify.prompt("Nhập lý do hủy:", "Khách đổi ý");
  const dialogBackdrop = openDialog.children.find((c) => String(c.className).includes("gaeru-modal-backdrop"));
  assert.ok(dialogBackdrop, "Modal must mount inside active dialog when open");

  // Simulate parent dialog closing unexpectedly
  openDialog.open = false;
  openDialog.dispatchEvent({ type: "close" });
  assert.equal(dialogBackdrop.parentElement, body, "Modal backdrop must re-mount to document.body when parent dialog closes");

  // Press Escape to cancel prompt
  const keyHandlers = [...(docListeners.get("keydown") || [])];
  for (const fn of keyHandlers) {
    fn({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  }
  const promptResult = await promptPromise;
  assert.equal(promptResult, null, "Escape must resolve prompt(null) and clean up");
});
