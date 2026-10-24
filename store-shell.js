const headerRoot = document.querySelector("#site-header");
const footerRoot = document.querySelector("#site-footer");
const escapeShellHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));
const anonymousEmptyCartMarkup = `
  <div class="mini-cart-empty">
    <p class="cart-signin-message"><a href="account.html">Đăng nhập</a> để xem tài khoản và đơn hàng của bạn.</p>
    <nav class="cart-profile-links" aria-label="Hồ sơ của tôi">
      <h3>Hồ Sơ Của Tôi</h3>
      <a href="account.html#customer-orders"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.3 7.6 7.7 4.3 7.7-4.3M12 12v9M8 5.3l8 4.5"/></svg><span>Đơn hàng</span></a>
      <a href="shop.html"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h12v17l-6-4-6 4v-17Z"/></svg><span>Mục Đã Lưu</span></a>
      <a href="account.html#register"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6.8 18a5.7 5.7 0 0 1 10.4 0"/></svg><span>Tạo tài khoản</span></a>
    </nav>
  </div>`;

Object.defineProperty(window,'GAERUEmptyCartMarkup',{get(){const customer=window.GAERUCustomerSession?.customer;if(!customer)return anonymousEmptyCartMarkup;return `<div class="mini-cart-empty"><p class="cart-signin-message">Xin chào, <a href="account.html">${escapeShellHtml(customer.fullName)}</a>.</p><nav class="cart-profile-links" aria-label="Hồ sơ của tôi"><h3>Hồ Sơ Của Tôi</h3><a href="account.html#customer-orders">Đơn hàng của bạn</a><a href="account.html">Tài khoản & địa chỉ</a><a href="care.html">GAERU CARE+</a></nav></div>`;}});
document.addEventListener('gaeru:customer-updated',()=>{const root=document.querySelector('[data-mini-cart]');if(root?.querySelector('.mini-cart-empty'))root.innerHTML=window.GAERUEmptyCartMarkup;});

if (headerRoot) {
  headerRoot.innerHTML = `
    <header class="site-header">
      <div class="nav-wrap">
        <a class="wordmark" href="index.html" aria-label="GAERU — Trang chủ"><span class="brand-window"><img class="brand-logo" src="assets/brand/gaeru-logo.png" alt="GAERU" width="375" height="375"></span></a>
        <button class="menu-toggle icon-button" type="button" aria-expanded="false" aria-controls="menu-panel" aria-label="Mở menu" data-open-label="Mở menu" data-close-label="Đóng menu">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path class="menu-icon-top" d="M4 8h16"/><path class="menu-icon-bottom" d="M4 16h16"/></svg>
        </button>
        <nav class="primary-nav" aria-label="Điều hướng chính">
          <button class="menu-nav-trigger" type="button" aria-expanded="false" aria-controls="menu-panel">Sản phẩm <span aria-hidden="true">⌄</span></button>
          <a href="story.html">Câu chuyện</a>
          <a href="care.html">GAERU CARE+</a>
          <a href="support.html">Hỗ trợ</a>
        </nav>
        <div class="nav-actions">
          <button class="search-toggle icon-button" type="button" aria-label="Tìm kiếm" aria-expanded="false" aria-controls="search-panel">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="5.4"/><path d="m14 14 5.5 5.5"/></svg>
          </button>
          <button class="icon-button bag-link" type="button" aria-label="Giỏ hàng, 0 sản phẩm" aria-expanded="false" aria-controls="cart-panel">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l1 13H4L5 8Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/></svg>
            <span class="cart-count" hidden>0</span>
          </button>
          <a class="account-link" href="account.html">Tài khoản</a>
        </div>
      </div>
    </header>`;
  headerRoot.insertAdjacentHTML("beforeend", `
    <button class="panel-scrim" type="button" aria-label="Đóng bảng điều hướng" hidden></button>
    <section class="nav-panel menu-panel" id="menu-panel" role="dialog" aria-modal="true" aria-labelledby="menu-title" hidden>
      <div class="panel-inner menu-inner">
        <button class="panel-close menu-panel-close" type="button" aria-label="Đóng menu">×</button>
        <nav class="menu-link-list" aria-label="Danh mục GAERU">
          <a class="menu-store-link" id="menu-title" href="shop.html">Cửa Hàng <span aria-hidden="true">›</span></a>
          <a href="product.html?id=k9">GAERU K9</a>
          <a href="product.html?id=p01">GAERU P01</a>
          <a href="product.html?id=g1-ultra">GAERU G1 Ultra</a>
          <a href="shop.html?category=accessory">Phụ kiện</a>
          <a class="mobile-menu-link" href="support.html">Hỗ trợ</a>
          <a class="mobile-menu-link" href="care.html">GAERU CARE+</a>
        </nav>
      </div>
    </section>
    <section class="nav-panel search-panel" id="search-panel" role="dialog" aria-modal="true" aria-labelledby="search-title" hidden>
      <div class="panel-inner search-inner">
        <button class="panel-close" type="button" aria-label="Đóng tìm kiếm">×</button>
        <form class="search-form" action="shop.html" method="get" role="search">
          <label class="visually-hidden" for="search-query">Tìm sản phẩm GAERU</label>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
          <input id="search-query" type="search" name="q" placeholder="Tìm kiếm" autocomplete="off" aria-controls="search-results">
        </form>
        <div class="search-suggestions">
          <h2 id="search-title">Liên Kết Nhanh</h2>
          <div class="search-quicklinks" data-search-quicklinks>
            <a href="shop.html">Mua Sắm GAERU Trực Tuyến</a>
            <a href="shop.html?category=accessory">Phụ Kiện</a>
            <a href="shop.html?q=GAERU%20K9">GAERU K9</a>
            <a href="shop.html?q=micro%20kh%C3%B4ng%20d%C3%A2y">Micro Không Dây</a>
            <a href="support.html">Hỗ Trợ GAERU</a>
          </div>
          <div class="search-results" id="search-results" aria-live="polite"></div>
        </div>
      </div>
    </section>
    <section class="nav-panel cart-panel" id="cart-panel" role="dialog" aria-modal="true" aria-labelledby="cart-panel-title" hidden>
      <div class="panel-inner cart-panel-inner">
        <button class="panel-close" type="button" aria-label="Đóng giỏ hàng">×</button>
        <div class="cart-panel-heading is-empty"><h2 id="cart-panel-title">Túi của bạn trống.</h2><span class="cart-panel-count" data-cart-panel-count hidden>0 sản phẩm</span></div>
        <div class="mini-cart-content" data-mini-cart aria-live="polite"></div>
        <div class="mini-cart-footer" data-mini-cart-footer hidden>
          <p class="mini-cart-total"><span>Tạm tính</span><strong data-mini-cart-total></strong></p>
          <p class="prototype-note">Tính theo giá khởi điểm tham khảo, chưa gồm vận chuyển.</p>
          <a class="button button-blue" href="cart.html">Xem giỏ hàng</a>
          <a class="mini-checkout" href="checkout.html">Chọn phiên bản &amp; tiếp tục <span aria-hidden="true">›</span></a>
        </div>
      </div>
    </section>`);
  headerRoot.querySelector("[data-mini-cart]").innerHTML = window.GAERUEmptyCartMarkup;
}

if (footerRoot) {
  footerRoot.innerHTML = `
    <footer class="site-footer">
      <div class="footer-main">
        <div class="footer-brand">
          <a class="wordmark" href="index.html"><span class="brand-window"><img class="brand-logo" src="assets/brand/gaeru-logo.png" alt="GAERU" width="375" height="375"></span></a>
          <p>Nhỏ gọn để bắt đầu.<br>Tự do để sáng tạo.</p>
        </div>
        <details class="footer-column" open>
          <summary>Khám phá GAERU</summary>
          <div class="footer-links">
            <a href="shop.html">Cửa hàng</a>
            <a href="product.html?id=k9">GAERU K9</a>
            <a href="product.html?id=p01">GAERU P01</a>
          </div>
        </details>
        <details class="footer-column" open>
          <summary>Hỗ trợ &amp; tài khoản</summary>
          <div class="footer-links">
            <a href="care.html">GAERU CARE+</a>
            <a href="support.html#guide">Hướng dẫn</a>
            <a href="support.html">Trung tâm hỗ trợ</a>
            <a href="account.html">Tài khoản</a>
          </div>
        </details>
        <details class="footer-column" open>
          <summary>Về GAERU</summary>
          <div class="footer-links">
            <a href="story.html">Câu chuyện GAERU</a>
          </div>
        </details>
      </div>
      <div class="footer-help">
        <p>Cần hỗ trợ? Email <a href="mailto:business@gaeru.com">business@gaeru.com</a> hoặc gọi <a href="tel:0829191080">082 919 1080</a>. Giờ hỗ trợ: Thứ Hai–Thứ Sáu 10:00–17:00, cuối tuần và ngày lễ 10:00–16:00.</p>
      </div>
      <div class="footer-bottom">
        <span class="footer-region">Việt Nam</span>
        <div class="footer-legal">
          <span>Bản quyền GAERU © 2026 · GAERU HOUSEHOLD BUSINESS (GAERU)</span>
          <nav aria-label="Chính sách và pháp lý">
            <a href="privacy.html">Chính sách quyền riêng tư</a>
            <a href="terms.html">Điều khoản sử dụng</a>
            <a href="pricing.html">Chính sách giá</a>
            <a href="payment.html">Chính sách thanh toán</a>
            <a href="delivery-returns.html">Bán hàng và hoàn tiền</a>
            <a href="complaints.html">Giải quyết khiếu nại</a>
            <a href="legal.html">Pháp lý</a>
            <a href="sitemap.html">Sơ đồ trang web</a>
          </nav>
        </div>
        <p class="footer-business-info">
          GAERU HOUSEHOLD BUSINESS (GAERU) · Mã số đăng ký 8836293843-002 do Phòng Kinh tế UBND Xã Rạng Đông cấp ngày 05/01/2024.<br>
          Địa chỉ: Thôn 2, Xã Rạng Đông, Tỉnh Ninh Bình.
        </p>
      </div>
    </footer>`;
  const footerAccordion = window.matchMedia("(max-width: 760px)");
  const syncFooterAccordion = () => {
    footerRoot.querySelectorAll(".footer-column").forEach((column) => {
      column.open = !footerAccordion.matches;
    });
  };
  syncFooterAccordion();
  footerAccordion.addEventListener("change", syncFooterAccordion);
}

const menuToggle = document.querySelector(".menu-toggle");
const menuNavTrigger = document.querySelector(".menu-nav-trigger");
const searchToggle = document.querySelector(".search-toggle");
const bagToggle = document.querySelector(".bag-link");
const panelScrim = document.querySelector(".panel-scrim");
let activePanel = null;
let panelOrigin = null;
let savedBodyOverflow = "";
let inertElements = [];
let closeTimer;

function closeActivePanel({ restoreFocus = true, immediate = false } = {}) {
  if (!activePanel) return;
  const panel = activePanel;
  const trigger = panelOrigin;
  activePanel = null;
  panelOrigin = null;
  clearTimeout(closeTimer);
  panel.classList.remove("is-open");
  panelScrim.classList.remove("is-visible");
  document.body.classList.remove("panel-active");
  document.body.style.overflow = savedBodyOverflow;
  inertElements.forEach(([element, wasInert]) => { element.inert = wasInert; });
  inertElements = [];
  if (trigger) {
    trigger.setAttribute("aria-expanded", "false");
    if (trigger.dataset.openLabel) trigger.setAttribute("aria-label", trigger.dataset.openLabel);
  }
  if (immediate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    panel.hidden = true;
    panelScrim.hidden = true;
  } else {
    closeTimer = window.setTimeout(() => {
      panel.hidden = true;
      panelScrim.hidden = true;
    }, 700);
  }
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

function openPanel(panel, trigger) {
  if (activePanel === panel) {
    closeActivePanel();
    return;
  }
  closeActivePanel({ restoreFocus: false, immediate: true });
  clearTimeout(closeTimer);
  panelOrigin = trigger;
  activePanel = panel;
  savedBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  document.body.classList.add("panel-active");
  [document.querySelector("main"), document.querySelector("#site-footer")].filter(Boolean).forEach((element) => {
    inertElements.push([element, element.inert]);
    element.inert = true;
  });
  trigger.setAttribute("aria-expanded", "true");
  if (trigger.dataset.closeLabel) {
    trigger.setAttribute("aria-label", trigger.dataset.closeLabel);
  }
  if (trigger.dataset.closeLabel) trigger.setAttribute("aria-label", trigger.dataset.closeLabel);
  panelScrim.hidden = false;
  panel.hidden = false;
  requestAnimationFrame(() => {
    panel.classList.add("is-open");
    panelScrim.classList.add("is-visible");
    const focusTarget = panel === document.querySelector("#search-panel")
      ? panel.querySelector("input[type=search]")
      : panel.querySelector(".panel-close, a[href], button:not(:disabled)");
    focusTarget?.focus({ preventScroll: true });
  });
  document.dispatchEvent(new CustomEvent("gaeru:cart-panel-open"));
}

menuToggle?.addEventListener("click", () => openPanel(document.querySelector("#menu-panel"), menuToggle));
menuNavTrigger?.addEventListener("click", () => openPanel(document.querySelector("#menu-panel"), menuNavTrigger));
searchToggle?.addEventListener("click", () => openPanel(document.querySelector("#search-panel"), searchToggle));
bagToggle?.addEventListener("click", () => openPanel(document.querySelector("#cart-panel"), bagToggle));
document.addEventListener("gaeru:open-cart", () => openPanel(document.querySelector("#cart-panel"), bagToggle));
panelScrim?.addEventListener("click", () => closeActivePanel());
document.querySelectorAll(".panel-close").forEach((button) => button.addEventListener("click", () => closeActivePanel()));

document.querySelectorAll(".nav-panel").forEach((panel) => panel.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (link) closeActivePanel({ restoreFocus: false });
}));

document.addEventListener("keydown", (event) => {
  if (!activePanel) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeActivePanel();
  }
  if (event.key !== "Tab") return;
  const focusable = [...activePanel.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled)')].filter((element) => element.getClientRects().length);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

const searchInput = document.querySelector("#search-query");
const searchResults = document.querySelector("#search-results");
const searchQuicklinks = document.querySelector("[data-search-quicklinks]");
let searchRenderTimer;
searchInput?.addEventListener("input", () => {
  clearTimeout(searchRenderTimer);
  searchRenderTimer = window.setTimeout(() => {
    const query = searchInput.value.trim();
    if (!query) {
      searchResults.innerHTML = "";
      searchQuicklinks.hidden = false;
      return;
    }
    const matches = (window.GAERUStore?.searchProducts(query) ?? []).slice(0, 4);
    searchQuicklinks.hidden = true;
    if (matches.length === 0) {
      searchResults.innerHTML = '<p class="search-no-results">Không tìm thấy sản phẩm phù hợp. Thử “micro” hoặc “gimbal”.</p>';
      return;
    }
    searchResults.innerHTML = `<p class="search-results-label">Sản phẩm phù hợp</p>${matches.map((product, index) => `
      <a class="search-result" href="product.html?id=${encodeURIComponent(product.slug)}">
        <img src="${escapeShellHtml(product.imageUrl)}" alt="" loading="lazy">
        <span><strong>${escapeShellHtml(product.name)}</strong><small>${escapeShellHtml(product.description)}</small></span>
        <b aria-hidden="true">›</b>
      </a>`).join("")}`;
  }, 100);
});

function initializeMotion() {
  document.body.classList.add("motion-ready");

  const progress = document.createElement("div");
  progress.className = "scroll-progress";
  progress.setAttribute("aria-hidden", "true");
  document.body.prepend(progress);

  const revealTargets = [
    ".section-heading",
    ".filter-row",
    ".product-card",
    ".story-copy",
    ".story-art",
    ".care-intro",
    ".care-card",
    ".closing-banner > *",
    ".page-intro > *",
    ".catalog-card",
    ".product-detail-art",
    ".product-detail-copy > *",
    ".cart-item",
    ".cart-summary",
    ".account-copy > *",
    ".account-card",
    ".account-shortcuts > *"
  ].join(",");

  let revealObserver;
  const reveal = (root) => {
    const targets = [...(root.matches?.(revealTargets) ? [root] : []), ...(root.querySelectorAll?.(revealTargets) ?? [])];
    targets.forEach((element, index) => {
      if (element.dataset.revealReady) return;
      element.dataset.revealReady = "true";
      element.style.setProperty("--reveal-delay", `${Math.min(index % 4, 3) * 75}ms`);
      if (revealObserver) revealObserver.observe(element);
      else element.classList.add("is-visible");
    });
  };

  if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -35px 0px" });
  }

  reveal(document);
  const content = document.querySelector("main");
  if (content && "MutationObserver" in window) {
    new MutationObserver((records) => {
      records.forEach((record) => {
        record.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) reveal(node);
        });
      });
    }).observe(content, { childList: true, subtree: true });
  }

  let framePending = false;
  const updateScrollEffects = () => {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const progressValue = maxScroll > 0 ? window.scrollY / maxScroll : 0;
      progress.style.transform = `scaleX(${progressValue})`;
      const heroArt = document.querySelector(".hero-art img");
      if (heroArt) {
        const heroBottom = document.querySelector(".hero")?.getBoundingClientRect().bottom ?? 0;
        const travel = Math.max(0, Math.min(1, (window.innerHeight - heroBottom) / window.innerHeight));
        heroArt.style.setProperty("--hero-parallax", `${travel * 28}px`);
      }
      framePending = false;
    });
  };
  window.addEventListener("scroll", updateScrollEffects, { passive: true });
  window.addEventListener("resize", updateScrollEffects, { passive: true });
  updateScrollEffects();

  document.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    const card = event.target.closest(".product-card, .catalog-card, .care-card");
    if (!card) return;
    const bounds = card.getBoundingClientRect();
    card.style.setProperty("--pointer-x", `${event.clientX - bounds.left}px`);
    card.style.setProperty("--pointer-y", `${event.clientY - bounds.top}px`);
  }, { passive: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeMotion, { once: true });
} else {
  initializeMotion();
}
