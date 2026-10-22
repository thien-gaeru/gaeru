const headerRoot = document.querySelector("#site-header");
const footerRoot = document.querySelector("#site-footer");

if (headerRoot) {
  headerRoot.innerHTML = `
    <header class="site-header">
      <div class="nav-wrap">
        <a class="wordmark" href="index.html" aria-label="GAERU — Trang chủ">GAERU</a>
        <button class="menu-toggle icon-button" type="button" aria-expanded="false" aria-controls="menu-panel" aria-label="Mở menu">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16M4 16h16"/></svg>
        </button>
        <nav class="primary-nav" aria-label="Điều hướng chính">
          <button class="menu-nav-trigger" type="button" aria-expanded="false" aria-controls="menu-panel">Sản phẩm <span aria-hidden="true">⌄</span></button>
          <a href="index.html#story">Câu chuyện</a>
          <a href="https://gaeru.com/dang-ky-bao-hanh/">GAERU CARE+</a>
          <a href="https://gaeru.com/trung-tam-ho-tro/">Hỗ trợ</a>
        </nav>
        <div class="nav-actions">
          <button class="search-toggle icon-button" type="button" aria-label="Mở tìm kiếm" aria-expanded="false" aria-controls="search-panel">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
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
      <div class="panel-inner">
        <div class="panel-heading">
          <div><p class="eyebrow">Khám phá GAERU</p><h2 id="menu-title">Thiết bị sáng tạo<br>cho mọi câu chuyện.</h2></div>
          <button class="panel-close" type="button" aria-label="Đóng menu">×</button>
        </div>
        <div class="menu-content">
          <div class="menu-feature">
            <span class="menu-label">Chọn theo nhu cầu</span>
            <a href="shop.html?category=audio">Thu âm trong trẻo <span aria-hidden="true">↗</span></a>
            <a href="shop.html?category=video">Ghi hình tự do <span aria-hidden="true">↗</span></a>
            <a href="shop.html">Tất cả sản phẩm <span aria-hidden="true">↗</span></a>
          </div>
          <div class="menu-product-grid">
            <a class="menu-product" href="product.html?id=k9"><img src="https://gaeru.com/wp-content/plugins/gaeru-k9/assets/images/k9-cutout.png" alt="" loading="lazy"><span>GAERU K9</span><small>Micro không dây</small></a>
            <a class="menu-product" href="product.html?id=m3"><img src="https://gaeru.com/wp-content/uploads/2026/10/gaeru-m3-cutout-20261021-1024x683.png" alt="" loading="lazy"><span>GAERU M3</span><small>Micro kèm hộp sạc</small></a>
            <a class="menu-product" href="product.html?id=p01"><img src="https://gaeru.com/wp-content/uploads/2026/10/gaeru-p01-cutout-20261021-910x1024.png" alt="" loading="lazy"><span>GAERU P01</span><small>Gimbal theo dõi AI</small></a>
            <a class="menu-product" href="product.html?id=g1"><img src="https://gaeru.com/wp-content/uploads/2026/10/gaeru-g1-cutout-20261021-1024x1024.png" alt="" loading="lazy"><span>GAERU G1 ULTRA</span><small>Thu âm đa thiết bị</small></a>
          </div>
        </div>
        <div class="menu-footer"><a href="https://gaeru.com/dang-ky-bao-hanh/">GAERU CARE+ <span>Đăng ký và quản lý bảo hành</span></a><a href="https://gaeru.com/trung-tam-ho-tro/">Trung tâm hỗ trợ <span>Hướng dẫn và tư vấn sản phẩm</span></a><a href="account.html">Tài khoản của bạn <span>Đơn hàng và điểm thưởng</span></a></div>
      </div>
    </section>
    <section class="nav-panel search-panel" id="search-panel" role="dialog" aria-modal="true" aria-labelledby="search-title" hidden>
      <div class="panel-inner search-inner">
        <button class="panel-close" type="button" aria-label="Đóng tìm kiếm">×</button>
        <p class="eyebrow">Tìm kiếm GAERU</p>
        <form class="search-form" action="shop.html" method="get" role="search">
          <label class="visually-hidden" for="search-query">Tìm sản phẩm GAERU</label>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
          <input id="search-query" type="search" name="q" placeholder="Bạn đang tìm gì?" autocomplete="off" aria-controls="search-results">
          <button class="search-submit" type="submit" aria-label="Xem tất cả kết quả">Tìm</button>
        </form>
        <div class="search-suggestions">
          <h2 id="search-title">Gợi ý tìm kiếm</h2>
          <div class="search-quicklinks" data-search-quicklinks><a href="shop.html?q=GAERU%20K9">GAERU K9</a><a href="shop.html?q=micro%20kh%C3%B4ng%20d%C3%A2y">Micro không dây</a><a href="shop.html?q=gimbal">Gimbal</a></div>
          <div class="search-results" id="search-results" aria-live="polite"></div>
        </div>
      </div>
    </section>
    <section class="nav-panel cart-panel" id="cart-panel" role="dialog" aria-modal="true" aria-labelledby="cart-panel-title" hidden>
      <div class="panel-inner cart-panel-inner">
        <button class="panel-close" type="button" aria-label="Đóng giỏ hàng">×</button>
        <div class="cart-panel-heading"><div><p class="eyebrow">GAERU Store</p><h2 id="cart-panel-title">Giỏ hàng của bạn.</h2></div><span class="cart-panel-count" data-cart-panel-count>0 sản phẩm</span></div>
        <div class="mini-cart-content" data-mini-cart aria-live="polite"></div>
        <div class="mini-cart-footer" data-mini-cart-footer hidden>
          <p class="mini-cart-total"><span>Tạm tính</span><strong data-mini-cart-total></strong></p>
          <p class="prototype-note">Tính theo giá khởi điểm tham khảo, chưa gồm vận chuyển.</p>
          <a class="button button-blue" href="cart.html">Xem giỏ hàng</a>
          <a class="mini-checkout" href="checkout.html">Chọn phiên bản &amp; tiếp tục <span aria-hidden="true">›</span></a>
        </div>
      </div>
    </section>`);
}

if (footerRoot) {
  footerRoot.innerHTML = `
    <footer class="site-footer">
      <div class="footer-main">
        <div class="footer-brand">
          <a class="wordmark" href="index.html">GAERU</a>
          <p>Nhỏ gọn để bắt đầu.<br>Tự do để sáng tạo.</p>
        </div>
        <div class="footer-column">
          <h2>Khám phá</h2>
          <a href="shop.html">Cửa hàng</a>
          <a href="product.html?id=k9">GAERU K9</a>
          <a href="product.html?id=m3">GAERU M3</a>
          <a href="product.html?id=p01">GAERU P01</a>
        </div>
        <div class="footer-column">
          <h2>Đồng hành</h2>
          <a href="https://gaeru.com/dang-ky-bao-hanh/">GAERU CARE+</a>
          <a href="https://gaeru.com/huong-dan/">Hướng dẫn</a>
          <a href="https://gaeru.com/trung-tam-ho-tro/">Trung tâm hỗ trợ</a>
          <a href="account.html">Tài khoản</a>
        </div>
        <div class="footer-column">
          <h2>Liên hệ</h2>
          <a href="tel:0829191080">082 919 1080</a>
          <a href="mailto:business@gaeru.com">business@gaeru.com</a>
          <p>Thứ Hai–Thứ Sáu: 10:00–17:00<br>Cuối tuần & ngày lễ: 10:00–16:00</p>
        </div>
      </div>
      <div class="footer-bottom">
        <span>Bản quyền GAERU © 2026 · GAERU HOSEHOLD BUSINESS</span>
        <a href="https://gaeru.com/chinhsach/">Chính sách bảo mật</a>
      </div>
    </footer>`;
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
  trigger?.setAttribute("aria-expanded", "false");
  if (immediate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    panel.hidden = true;
    panelScrim.hidden = true;
  } else {
    closeTimer = window.setTimeout(() => {
      panel.hidden = true;
      panelScrim.hidden = true;
    }, 350);
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
  panelScrim.hidden = false;
  panel.hidden = false;
  requestAnimationFrame(() => {
    panel.classList.add("is-open");
    panelScrim.classList.add("is-visible");
    const focusTarget = panel === document.querySelector("#search-panel")
      ? panel.querySelector("input[type=search]")
      : panel.querySelector(".panel-close");
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
      <a class="search-result" href="product.html?id=${product.id}" style="--result-index:${index}">
        <img src="${product.image}" alt="" loading="lazy">
        <span><strong>${product.name}</strong><small>${product.description}</small></span>
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
