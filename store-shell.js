if (typeof document !== 'undefined' && typeof document.createElement === 'function' && document.head && !window.GAERUAnalytics && !document.querySelector?.('script[src*="google-analytics.js"]')) {
  const gaScript = document.createElement('script');
  gaScript.src = '/google-analytics.js';
  gaScript.defer = true;
  document.head.appendChild(gaScript);
}

const headerRoot = document.querySelector("#site-header");
const footerRoot = document.querySelector("#site-footer");
const escapeShellHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));
const anonymousEmptyCartMarkup = `
  <div class="mini-cart-empty">
    <p class="cart-signin-message"><a href="account.html">Đăng nhập</a> để xem tài khoản và đơn hàng của bạn.</p>
    <nav class="cart-profile-links" aria-label="Hồ sơ của bạn">
      <h3>Hồ Sơ Của Bạn</h3>
      <a href="account.html#customer-orders"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.3 7.6 7.7 4.3 7.7-4.3M12 12v9M8 5.3l8 4.5"/></svg><span>Đơn hàng</span></a>
      <a href="shop.html?saved=1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h12v17l-6-4-6 4v-17Z"/></svg><span>Mục Đã Lưu</span></a>
      <a href="account.html#register"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6.8 18a5.7 5.7 0 0 1 10.4 0"/></svg><span>Tạo tài khoản</span></a>
    </nav>
  </div>`;

Object.defineProperty(window,'GAERUEmptyCartMarkup',{get(){const customer=window.GAERUCustomerSession?.customer;if(!customer)return anonymousEmptyCartMarkup;return `<div class="mini-cart-empty"><p class="cart-signin-message">Xin chào, <a href="account.html">${escapeShellHtml(customer.fullName)}</a>.</p><nav class="cart-profile-links" aria-label="Hồ sơ của bạn"><h3>Hồ Sơ Của Bạn</h3><a href="account.html#customer-orders">Đơn hàng của bạn</a><a href="account.html">Tài khoản & địa chỉ</a><a href="care.html">GAERU Care+</a></nav></div>`;}});
document.addEventListener('gaeru:customer-updated',()=>{claimDeviceCartForSession();const root=document.querySelector('[data-mini-cart]');if(root?.querySelector('.mini-cart-empty'))root.innerHTML=window.GAERUEmptyCartMarkup;});

// Isolate the guest's device entries as soon as login resolves, including on
// the account page where the commerce bundle is not loaded.
window.GAERUDeviceCart=Object.freeze({
  claim(owner) {
    if(!owner || owner==="guest") return;
    const oldKey="gaeru-store-cart-v2",prefix="gaeru-store-cart-v3:";
    const legacy=localStorage.getItem(oldKey);
    if(legacy) {
      localStorage.setItem(prefix+owner+":legacy",legacy);
      localStorage.removeItem(oldKey);
    }
    const guestKeys=[];
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);
      if(key?.startsWith(prefix+"guest:op:")) guestKeys.push(key);
    }
    for(const key of guestKeys){
      const value=localStorage.getItem(key);
      if(value!==null){localStorage.setItem(prefix+owner+":"+key.slice(prefix.length),value);localStorage.removeItem(key);}
    }
  }
});
const claimDeviceCartForSession=()=>{
  try {window.GAERUDeviceCart.claim(window.GAERUCustomerSession?.customer?.id);} catch {}
};

claimDeviceCartForSession();

if (headerRoot) {
  headerRoot.innerHTML = `
    <header class="site-header">
      <div class="nav-wrap">
        <a class="wordmark" href="/" aria-label="GAERU — Trang chủ"><span class="brand-window"><picture><source srcset="/assets/brand/gaeru-logo.avif" type="image/avif"><source srcset="/assets/brand/gaeru-logo.webp?format=webp" type="image/webp"><img class="brand-logo" src="/assets/brand/gaeru-logo.png" alt="GAERU" width="375" height="375" decoding="async"></picture></span></a>
        <button class="menu-toggle icon-button" type="button" aria-expanded="false" aria-controls="menu-panel" aria-label="Mở menu" data-open-label="Mở menu" data-close-label="Đóng menu">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path class="menu-icon-top" d="M4 8h16"/><path class="menu-icon-bottom" d="M4 16h16"/></svg>
        </button>
        <nav class="primary-nav" aria-label="Điều hướng chính">
          <button class="menu-nav-trigger" type="button" aria-expanded="false" aria-controls="menu-panel">Sản phẩm <span aria-hidden="true">⌄</span></button>
          <a href="story.html">Câu chuyện</a>
          <a href="care.html">GAERU Care+</a>
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
          <div data-menu-products aria-live="polite"></div>
          <a class="mobile-menu-link" href="support.html">Hỗ trợ</a>
          <a class="mobile-menu-link" href="care.html">GAERU Care+</a>
          <a class="mobile-menu-link" href="account.html">Tài khoản</a>
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
  const syncFallbackCartBadge = () => {
    if (window.GAERUStore) return;
    try {
      const owner=window.GAERUCustomerSession?.customer?.id||"guest",prefix="gaeru-store-cart-v3:"+owner;
      const parsed=owner==="guest" ? JSON.parse(localStorage.getItem("gaeru-store-cart-v2")||"[]") : JSON.parse(localStorage.getItem(prefix+":snapshot")||"{}").items;
      const quantities=new Map((Array.isArray(parsed)?parsed:[]).map(i=>[i.variantId,i.quantity]));
      const keys=[];
      for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k?.startsWith(prefix+":op:")) keys.push(k);}
      const operations=keys.map(k=>JSON.parse(localStorage.getItem(k)||"{}"))
        .sort((a,b)=>String(a.order).localeCompare(String(b.order)) || String(a.id).localeCompare(String(b.id)));
      for(const op of operations){
        for(const item of op.items||[]){
          const previous=quantities.get(item.variantId)||0;
          quantities.set(item.variantId,Math.min(99,Math.max(0,op.kind==="legacy"?Math.max(previous,item.quantity):previous+item.quantity)));
        }
      }
      // Before commerce.js opens, a newly claimed guest basket may still await server import.
      if(owner!=="guest"){
        const rawLegacy=JSON.parse(localStorage.getItem(prefix+":legacy")||"[]");
        const legacy=new Map((Array.isArray(rawLegacy)?rawLegacy:[]).map(i=>[i.variantId,i.quantity]));
        const guest=new Map(legacy),staged=[];
        for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k?.startsWith(prefix+":guest:op:")) staged.push(JSON.parse(localStorage.getItem(k)||"{}"));}
        staged.sort((a,b)=>String(a.order).localeCompare(String(b.order))||String(a.id).localeCompare(String(b.id)));
        for(const op of staged)for(const item of op.items||[]) guest.set(item.variantId,Math.max(0,Math.min(99,(guest.get(item.variantId)||0)+item.quantity)));
        for(const [id,q] of guest){
          const mirrored=Math.min(legacy.get(id)||0,q);
          quantities.set(id,Math.min(99,Math.max(quantities.get(id)||0,mirrored)+q-mirrored));
        }
      }
      const qty=[...quantities.values()].reduce((a,b)=>a+b,0);
      const badge = headerRoot.querySelector(".cart-count");
      const link = headerRoot.querySelector(".bag-link");
      if (badge) {
        badge.textContent = String(qty);
        badge.hidden = qty === 0;
      }
      if (link) link.setAttribute("aria-label", `Giỏ hàng, ${qty} sản phẩm`);
    } catch (_) {}
  };
  syncFallbackCartBadge();
  document.addEventListener("gaeru:cart-updated", syncFallbackCartBadge);
  document.addEventListener("gaeru:customer-updated",syncFallbackCartBadge);
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === "gaeru-store-cart-v2" || e.key?.startsWith("gaeru-store-cart-v3:")) syncFallbackCartBadge();
  });
}

document.querySelectorAll('link[rel="stylesheet"][data-deferred-css]').forEach((link) => { const activate = () => { if (!link.hasAttribute("data-deferred-css")) return; link.media = "all"; link.removeAttribute("data-deferred-css"); }; if (link.sheet) activate(); else { link.addEventListener("load", activate, { once: true }); setTimeout(activate, 1500); } });
let menuProductsRequest = null;
async function refreshMenuProducts({fresh=false}={}) {
  const target = document.querySelector('[data-menu-products]');
  const footer=document.querySelector('[data-footer-products]');
  if ((!target&&!footer) || menuProductsRequest) return menuProductsRequest;
  menuProductsRequest = (async () => {
    try {
      const embedded=!fresh&&document.querySelector('#store-bootstrap');
      let data;if(embedded)data=await Promise.resolve(JSON.parse(embedded.textContent));else if(!fresh&&Array.isArray(window.GAERUStore?.products)&&window.GAERUStore.products.length)data={products:window.GAERUStore.products};else if(!fresh&&typeof window==='object'&&window){if(!window.__gaeruProductsPromise)window.__gaeruProductsPromise=fetch('/api/products',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('Catalog unavailable');return r.json();}).catch(err=>{delete window.__gaeruProductsPromise;throw err;});data=await window.__gaeruProductsPromise;}else{const response=await fetch('/api/products',{cache:'no-store'});if(!response.ok)throw Error('Catalog unavailable');data=await response.json();if(typeof window==='object'&&window)window.__gaeruProductsPromise=Promise.resolve(data);}
      const {products}=data;
      if (!Array.isArray(products)) throw new Error('Invalid catalog');
      const links = products.filter(product => product.active !== false && product.slug && product.name)
        .map(product => `<a href="product.html?id=${encodeURIComponent(product.slug)}">${escapeShellHtml(product.name)}</a>`).join('');
      if (target&&target.innerHTML !== links) target.innerHTML = links;
      window.GAERUFooterProducts?.render(document.querySelector('[data-footer-products]'),products);
    } catch {
      // Keep the store link available when the catalog is temporarily unavailable.
    } finally { menuProductsRequest = null; }
  })();
  return menuProductsRequest;
}


if (footerRoot) {
  if (!footerRoot.querySelector('.site-footer')) {
    footerRoot.innerHTML = `

    <footer class="site-footer">
      <div class="footer-main">
        <div class="footer-brand">
          <a class="wordmark" href="/"><span class="brand-window"><picture><source srcset="/assets/brand/gaeru-logo.avif" type="image/avif"><source srcset="/assets/brand/gaeru-logo.webp?format=webp" type="image/webp"><img class="brand-logo" src="/assets/brand/gaeru-logo.png" alt="GAERU" width="375" height="375" loading="lazy" decoding="async"></picture></span></a>
          <p>Nhỏ gọn để bắt đầu.<br>Tự do để sáng tạo.</p>
        </div>
        <details class="footer-column" open>
          <summary>Khám phá GAERU</summary>
          <div class="footer-links" data-footer-products data-footer-signature="[[&quot;gaeru-m3&quot;,&quot;GAERU M3&quot;],[&quot;gaeru-k9&quot;,&quot;GAERU K9&quot;],[&quot;gaeru-p185&quot;,&quot;GAERU P185&quot;],[&quot;gaeru-p01&quot;,&quot;GAERU P01&quot;],[&quot;gaeru-g1-ultra&quot;,&quot;GAERU G1 ULTRA&quot;]]"><a href="/cua-hang">Cửa hàng</a><a href="/san-pham/gaeru-m3">GAERU M3</a><a href="/san-pham/gaeru-k9">GAERU K9</a><a href="/san-pham/gaeru-p185">GAERU P185</a><a href="/san-pham/gaeru-p01">GAERU P01</a><a href="/san-pham/gaeru-g1-ultra">GAERU G1 ULTRA</a></div>
        </details>
        <details class="footer-column" open>
          <summary>Hỗ trợ &amp; tài khoản</summary>
          <div class="footer-links">
            <a href="/care">GAERU Care+</a>
            <a href="/ho-tro#guide">Hướng dẫn</a>
            <a href="/ho-tro">Trung tâm hỗ trợ</a>
            <a href="/tra-cuu-don-hang">Tra cứu đơn hàng</a>
            <a href="/tai-khoan">Tài khoản</a>
          </div>
        </details>
        <details class="footer-column" open>
          <summary>Về GAERU</summary>
          <div class="footer-links">
            <a href="/cau-chuyen">Câu chuyện GAERU</a>
          </div>
        </details>
        <div class="footer-column footer-newsletter-column">
          <span class="footer-column-heading">Bản tin GAERU</span>
          <p class="footer-newsletter-note">Cập nhật sản phẩm &amp; ưu đãi mới nhất.</p>
          <form class="footer-newsletter-compact-form" data-newsletter-form data-source="web_footer">
            <div class="footer-newsletter-field">
              <input type="email" name="email" class="footer-newsletter-compact-input" placeholder="Nhập địa chỉ email" aria-label="Địa chỉ email nhận bản tin" required maxlength="254" autocomplete="email">
              <button type="submit" class="footer-newsletter-compact-submit" aria-label="Đăng ký nhận tin">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </button>
            </div>
            <label class="footer-newsletter-consent">
              <input type="checkbox" name="consent" required>
              <span>Tôi đồng ý nhận email từ GAERU.</span>
            </label>
            <div class="footer-newsletter-feedback" data-newsletter-feedback role="status" aria-live="polite"></div>
          </form>
        </div>
      </div>
      <div class="footer-help">
        <p>Cần hỗ trợ? <button type="button" class="chat-product-button footer-chat-link" data-product-chat="">Chat ngay ↗</button>, email <a href="mailto:business@gaeru.com">business@gaeru.com</a> hoặc gọi <a href="tel:0829191080">082 919 1080</a>. Giờ hỗ trợ: Thứ Hai–Thứ Sáu 10:00–17:00, cuối tuần và ngày lễ 10:00–16:00.</p>
      </div>
      <div class="footer-bottom">
        <span class="footer-region">Việt Nam</span>
        <div class="footer-legal">
          <span>Bản quyền GAERU © 2026 · GAERU</span>
          <nav aria-label="Chính sách và pháp lý">
            <a href="/chinh-sach/quyen-rieng-tu">Chính sách quyền riêng tư</a>
            <a href="/chinh-sach/dieu-khoan">Điều khoản sử dụng</a>
            <a href="/chinh-sach/gia">Chính sách giá</a>
            <a href="/chinh-sach/thanh-toan">Chính sách thanh toán</a>
            <a href="/chinh-sach/giao-hang-doi-tra">Bán hàng và hoàn tiền</a>
            <a href="/khieu-nai">Giải quyết khiếu nại</a>
            <a href="/phap-ly">Pháp lý</a>
            <a href="/so-do-trang-web">Sơ đồ trang web</a>
          </nav>
        </div>
        <p class="footer-business-info">
          GAERU · Mã số đăng ký &amp; Mã số thuế: 8836293843-002 do Phòng Kinh tế UBND Xã Rạng Đông cấp ngày 05/01/2024.<br>
          Địa chỉ: Thôn 2, Xã Rạng Đông, Tỉnh Ninh Bình · Hotline: 082 919 1080 · Email: business@gaeru.com<br>
          Website thương mại điện tử bán hàng tuân thủ Nghị định 52/2013/NĐ-CP và Nghị định 85/2021/NĐ-CP.
        </p>
      </div>
    </footer>`;
  }
  const footerAccordion = window.matchMedia("(max-width: 760px)");
  const syncFooterAccordion = () => {
    footerRoot.querySelectorAll("details.footer-column").forEach((column) => {
      column.open = !footerAccordion.matches;
    });
  };
  syncFooterAccordion();
  footerAccordion.addEventListener("change", syncFooterAccordion);
}


const policyCommerceUrl = document.body?.dataset?.policyCommerce;
let policyCatalogUsed = false;
if (!policyCommerceUrl) refreshMenuProducts();
const lazyCartUrl=policyCommerceUrl || (!document.querySelector('script[src^="commerce.js"],script[src^="/commerce.js"]') ? "/commerce.js" : null);
if(lazyCartUrl){
  let cartScript;
  document.addEventListener('gaeru:cart-panel-open', () => {
    if (window.GAERUStore || cartScript) return;
    const cart = document.querySelector('[data-mini-cart]');
    if (cart) cart.textContent = 'Đang tải giỏ hàng…';
    cartScript = document.createElement('script');
    cartScript.src = lazyCartUrl;
    cartScript.onerror = () => {
      cartScript.remove();
      cartScript = null;
      if (cart) {
        const link = document.createElement('a');
        link.href = '/gio-hang';
        link.textContent = 'Mở trang giỏ hàng';
        cart.replaceChildren(link);
      }
    };
    document.head.append(cartScript);
  });
}
if(policyCommerceUrl){
  const footerProducts = document.querySelector('[data-footer-products]');
  if (footerProducts && typeof IntersectionObserver === 'function') {
    const footerObserver = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      footerObserver.disconnect();
      policyCatalogUsed = true;
      refreshMenuProducts();
    });
    footerObserver.observe(footerProducts);
  }
}
function populateCustomerNewsletterEmail() {
  const customerEmail = window.GAERUCustomer?.session?.customer?.email ||
                        window.GAERUCustomerSession?.customer?.email ||
                        window.__GAERU_CUSTOMER__?.email;
  if (customerEmail) {
    document.querySelectorAll("[data-newsletter-form] input[name=email]").forEach(input => {
      if (!input.value) input.value = customerEmail;
    });
  }
}
window.addEventListener("gaeru:customer-session-ready", populateCustomerNewsletterEmail);
document.addEventListener("gaeru:customer-updated", populateCustomerNewsletterEmail);
window.addEventListener("DOMContentLoaded", populateCustomerNewsletterEmail);

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-newsletter-form]");
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector("input[name=email]");
  const consent = form.querySelector("input[name=consent]");
  const feedback = form.querySelector("[data-newsletter-feedback]");
  const btn = form.querySelector("button[type=submit]");
  if (!input || !consent || !feedback) return;
  if (!consent.checked) {
    feedback.innerHTML = '<span style="color:#d32f2f;">Vui lòng tích đồng ý nhận tin trước khi đăng ký.</span>';
    return;
  }
  btn.disabled = true;
  feedback.innerHTML = '<span style="color:#86868b;">Đang gửi thông tin đăng ký...</span>';
  try {
    const res = await fetch("/api/marketing-email/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: input.value.trim(),
        consent: true,
        source: form.dataset.source || "web_footer"
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Không thể đăng ký lúc này. Vui lòng thử lại sau.");
    feedback.innerHTML = '<span style="color:#2e7d32;font-weight:600;">' + escapeShellHtml(data.message || "Vui lòng kiểm tra hộp thư để xác nhận đăng ký.") + '</span>';
    form.reset();
  } catch (err) {
    feedback.innerHTML = '<span style="color:#d32f2f;">' + escapeShellHtml(err.message) + '</span>';
  } finally {
    btn.disabled = false;
  }
});

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
  if (menuToggle && menuToggle !== trigger) {
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.setAttribute("aria-label", menuToggle.dataset.openLabel || "Mở menu");
  }
  if (panel.id === "search-panel") {
    const qInput = panel.querySelector("#search-query");
    const qResults = panel.querySelector("#search-results");
    const qQuicklinks = panel.querySelector("[data-search-quicklinks]");
    if (qInput) qInput.value = "";
    if (qResults) qResults.innerHTML = "";
    if (qQuicklinks) qQuicklinks.hidden = false;
  }
  if (immediate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    panel.hidden = true;
    panelScrim.hidden = true;
  } else {
    closeTimer = window.setTimeout(() => {
      if (activePanel !== panel) panel.hidden = true;
      if (!activePanel) panelScrim.hidden = true;
    }, 380);
  }
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

function openPanel(panel, trigger) {
  if (!panel || !trigger) return;
  if (activePanel === panel) {
    closeActivePanel();
    return;
  }
  const switchingPanels = Boolean(activePanel && activePanel !== panel);
  closeActivePanel({ restoreFocus: false, immediate: true });
  clearTimeout(closeTimer);
  if (panel.id === "menu-panel") { policyCatalogUsed = true; refreshMenuProducts(); }
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
  if (menuToggle && menuToggle !== trigger) {
    menuToggle.setAttribute("aria-expanded", "true");
    menuToggle.setAttribute("aria-label", "Đóng");
  }
  panelScrim.hidden = false;
  panel.hidden = false;
  if (switchingPanels) panelScrim.classList.add("is-visible");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (activePanel !== panel) return;
      panel.classList.add("is-open");
      panelScrim.classList.add("is-visible");
      const isElVisible = (el) => Boolean(el && (typeof el.getClientRects === "function" ? el.getClientRects().length > 0 : !el.hidden && el.style?.display !== "none"));
      const searchBox = panel.id === "search-panel" ? panel.querySelector("input[type=search]") : null;
      const focusTarget = (isElVisible(searchBox) ? searchBox : null) ||
        [...panel.querySelectorAll('.panel-close, a[href], button:not(:disabled), input:not(:disabled)')].find(isElVisible);
      focusTarget?.focus({ preventScroll: true });
    });
  });
  if (panel.id === "cart-panel") {
    document.dispatchEvent(new CustomEvent("gaeru:cart-panel-open"));
  }
}

menuToggle?.addEventListener("click", () => {
  if (activePanel) {
    closeActivePanel();
  } else {
    openPanel(document.querySelector("#menu-panel"), menuToggle);
  }
});
menuNavTrigger?.addEventListener("click", () => openPanel(document.querySelector("#menu-panel"), menuNavTrigger));
searchToggle?.addEventListener("click", () => openPanel(document.querySelector("#search-panel"), searchToggle));
bagToggle?.addEventListener("click", () => openPanel(document.querySelector("#cart-panel"), bagToggle));
document.addEventListener("gaeru:open-cart", () => openPanel(document.querySelector("#cart-panel"), bagToggle));
panelScrim?.addEventListener("click", () => closeActivePanel());
document.querySelectorAll(".panel-close").forEach((button) => button.addEventListener("click", () => closeActivePanel()));

document.querySelectorAll(".nav-panel").forEach((panel) => panel.addEventListener("click", (event) => {
  if (event.target === panel) {
    closeActivePanel();
    return;
  }
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

// Tầng Tìm kiếm Tức thì (Client-Side Edge Index: tải ngầm 1 lần khi chạm vào ô tìm kiếm)
let edgeSearchIndex = null;
let edgeSearchLoading = false;
function loadSearchIndex() {
  if (edgeSearchIndex || edgeSearchLoading) return;
  edgeSearchLoading = true;
  fetch('/api/search-index.json', { cache: 'default' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => { if (Array.isArray(data)) edgeSearchIndex = data; })
    .catch(() => {})
    .finally(() => { edgeSearchLoading = false; });
}
searchInput?.addEventListener("focus", loadSearchIndex, { once: true });
searchToggle?.addEventListener("click", loadSearchIndex, { once: true });

const SHELL_SEARCH_CATEGORY_ALIASES = {
  audio: "micro microphone mic thu am",
  video: "gimbal quay video chong rung",
  accessory: "phu kien gay selfie chup hinh tripod"
};
function normalizeShellSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/\bmicro(?:phone)?\b/g, "mic")
    .replace(/\s+/g, " ")
    .trim();
}

function filterSearchProducts(query) {
  const needle = normalizeShellSearchText(query);
  if (!needle) return [];
  if (edgeSearchIndex && Array.isArray(edgeSearchIndex)) {
    const tokens = needle.split(" ").filter(Boolean);
    return edgeSearchIndex.filter((p) => {
      const tags = Array.isArray(p.tags) ? p.tags.join(" ") : "";
      const aliases = SHELL_SEARCH_CATEGORY_ALIASES[p.category] || "";
      const hay = normalizeShellSearchText([p.name, p.slug, p.sku, p.desc, p.category, tags, aliases].join(" "));
      return tokens.every((tok) => hay.includes(tok));
    });
  }
  return window.GAERUStore?.searchProducts(query) ?? [];
}

let semanticSearchTimer;
let semanticSearchAbort = null;

function renderSearchResultRows(matches, articles = [], isSemantic = false) {
  let html = '';
  if (matches.length > 0) {
    html += '<p class="search-results-label">' + (isSemantic ? 'Gợi ý thông minh GAERU AI' : 'Sản phẩm phù hợp') + '</p>' + matches.map((product) => (
      '<a class="search-result" href="product.html?id=' + encodeURIComponent(product.slug) + '">' +
        (product.imageUrl ? '<img src="' + escapeShellHtml(product.imageUrl) + '" alt="" width="62" height="56" loading="lazy" decoding="async">' : '') +
        '<span><strong>' + escapeShellHtml(product.name) + '</strong><small>' + escapeShellHtml(product.desc || product.description || '') + '</small></span>' +
        '<b aria-hidden="true">›</b>' +
      '</a>'
    )).join('');
  }
  if (Array.isArray(articles) && articles.length > 0) {
    html += '<p class="search-results-label">Hướng dẫn &amp; Bài viết liên quan</p>' + articles.slice(0, 3).map((art) => (
      '<a class="search-result search-result-article" href="' + escapeShellHtml(art.url || ('/tin-tuc/' + encodeURIComponent(art.slug || ''))) + '">' +
        '<span><strong>' + escapeShellHtml(art.title || '') + '</strong><small>' + escapeShellHtml(art.excerpt || '') + '</small></span>' +
        '<b aria-hidden="true">›</b>' +
      '</a>'
    )).join('');
  }
  return html;
}

searchInput?.addEventListener("input", () => {
  clearTimeout(searchRenderTimer);
  clearTimeout(semanticSearchTimer);
  if (semanticSearchAbort) {
    try { semanticSearchAbort.abort(); } catch (_) {}
    semanticSearchAbort = null;
  }
  searchRenderTimer = window.setTimeout(() => {
    const query = searchInput.value.trim();
    if (!query) {
      searchResults.innerHTML = "";
      searchQuicklinks.hidden = false;
      return;
    }
    const matches = filterSearchProducts(query).slice(0, 4);
    searchQuicklinks.hidden = true;
    if (matches.length > 0) {
      searchResults.innerHTML = renderSearchResultRows(matches, [], false);
    } else if (query.length < 4) {
      searchResults.innerHTML = '<p class="search-no-results">Không tìm thấy sản phẩm phù hợp. Thử “micro” hoặc “gimbal”.</p>';
      return;
    } else {
      searchResults.innerHTML = '<p class="search-no-results">Đang tìm gợi ý thông minh GAERU AI…</p>';
    }

    // Tier 3.1: Semantic storefront search rescue for natural-language queries or sparse lexical hits
    if (query.length >= 4 && matches.length < 2) {
      semanticSearchTimer = window.setTimeout(() => {
        if (searchInput.value.trim() !== query) return;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        semanticSearchAbort = controller;
        fetch('/api/search/semantic?q=' + encodeURIComponent(query) + '&limit=4', {
          cache: 'default',
          signal: controller ? controller.signal : undefined
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (!data || searchInput.value.trim() !== query) return;
            const seenSlugs = new Set(matches.map((m) => m.slug));
            const mergedProducts = [...matches];
            for (const p of (Array.isArray(data.products) ? data.products : [])) {
              if (p && p.slug && !seenSlugs.has(p.slug) && mergedProducts.length < 4) {
                seenSlugs.add(p.slug);
                mergedProducts.push(p);
              }
            }
            const articles = Array.isArray(data.articles) ? data.articles : [];
            if (mergedProducts.length > 0 || articles.length > 0) {
              searchResults.innerHTML = renderSearchResultRows(mergedProducts, articles, matches.length === 0 && Boolean(data.semantic));
            } else if (matches.length === 0) {
              searchResults.innerHTML = '<p class="search-no-results">Không tìm thấy sản phẩm phù hợp. Thử “micro” hoặc “gimbal”.</p>';
            }
          })
          .catch(() => {
            if (matches.length === 0 && searchInput.value.trim() === query) {
              searchResults.innerHTML = '<p class="search-no-results">Không tìm thấy sản phẩm phù hợp. Thử “micro” hoặc “gimbal”.</p>';
            }
          });
      }, 220);
    }
  }, 50);
});

// Tầng Trình duyệt: Speculative Preloading (0ms)
(function initSpeculationRules() {
  if (typeof document === 'undefined') return;
  const isSupported = typeof HTMLScriptElement !== 'undefined' && HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules');
  if (isSupported && !document.querySelector('script[type="speculationrules"]')) {
    const spec = document.createElement('script');
    spec.type = 'speculationrules';
    spec.textContent = JSON.stringify({
      prerender: [{
        where: {
          and: [
            { href_matches: "/*" },
            { not: { href_matches: "/tai-khoan*" } },
            { not: { href_matches: "/gio-hang*" } },
            { not: { href_matches: "/thanh-toan*" } },
            { not: { href_matches: "/ket-qua-thanh-toan*" } },
            { not: { href_matches: "/account.html*" } },
            { not: { href_matches: "/cart.html*" } },
            { not: { href_matches: "/checkout.html*" } },
            { not: { href_matches: "/payment-result.html*" } },
            { not: { href_matches: "/admin*" } },
            { not: { href_matches: "/gaeru_ceo*" } },
            { not: { href_matches: "/api/*" } }
          ]
        },
        eagerness: "moderate"
      }]
    });
    document.head.appendChild(spec);
  }

  if (isSupported) return;
  const prefetchedUrls = new Set();
  document.addEventListener('pointerenter', (e) => {
    if (prefetchedUrls.size >= 12) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || !a.href || prefetchedUrls.has(a.href)) return;
    try {
      const url = new URL(a.href, location.origin);
      if (url.origin !== location.origin) return;
      if (/^\/(?:tai-khoan|gio-hang|thanh-toan|ket-qua-thanh-toan|account\.html|cart\.html|checkout\.html|payment-result\.html|admin|gaeru_ceo|api)/.test(url.pathname)) return;
      prefetchedUrls.add(a.href);
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = a.href;
      document.head.appendChild(link);
    } catch (_) {}
  }, { capture: true, passive: true });
})();

function initializeMotion() {
  document.body.classList.add("motion-ready");

  const progress = document.createElement("div");
  progress.className = "scroll-progress";
  progress.setAttribute("aria-hidden", "true");
  document.body.prepend(progress);

  const revealTargets = [
    ".home-showcase-grid > section",
    ".section-heading",
    ".filter-row",
    ".product-card",
    ".story-copy",
    ".story-art",
    ".home-m3-copy",
    ".home-m3-art",
    ".care-intro",
    ".care-card",
    ".news-heading",
    ".news-card",
    ".closing-banner > *",
    ".page-intro > *",
    ".store-welcome > *",
    ".store-section-heading",
    ".catalog-card",
    ".store-story",
    ".store-benefit-grid > a",
    ".store-quick",
    ".story-page-intro",
    ".story-complete-products > article",
    ".story-product-feature",
    ".discover-highlights > div",
    ".discover-section",
    ".discover-features > *",
    ".discover-uses > *",
    ".m3-discover-images > figure",
    ".discover-split-grid",
    ".product-feature-intro",
    ".product-feature-chapter",
    ".product-feature-specs",
    ".support-topic",
    ".support-feature",
    ".product-detail-art",
    ".cart-item",
    ".cart-summary",
    ".account-copy > *",
    ".account-shortcuts > *"
  ].join(",");

  let revealObserver;
  const computeRevealDelay = (element, fallbackIndex) => {
    if (element.matches?.(".home-m3-copy, .story-copy")) {
      const tile = element.closest(".home-showcase-grid > section");
      const siblings = tile?.parentElement ? [...tile.parentElement.children] : [];
      const col = siblings.indexOf(tile) % 2;
      return `${Math.max(0, col) * 85}ms`;
    }
    if (element.matches?.(".home-m3-art, .story-art")) {
      const tile = element.closest(".home-showcase-grid > section");
      const siblings = tile?.parentElement ? [...tile.parentElement.children] : [];
      const col = siblings.indexOf(tile) % 2;
      return `${Math.max(0, col) * 85 + 95}ms`;
    }
    if (element.parentElement?.classList?.contains("home-showcase-grid")) {
      const siblings = [...element.parentElement.children];
      const col = siblings.indexOf(element) % 2;
      return `${Math.max(0, col) * 85}ms`;
    }
    const parent = element.parentElement;
    if (parent) {
      const peers = [...parent.children].filter((child) => child.matches?.(revealTargets));
      const pos = peers.indexOf(element);
      if (pos >= 0) return `${Math.min(pos % 4, 3) * 75}ms`;
    }
    return `${Math.min(fallbackIndex % 4, 3) * 70}ms`;
  };

  const reveal = (root) => {
    const targets = [...(root.matches?.(revealTargets) ? [root] : []), ...(root.querySelectorAll?.(revealTargets) ?? [])];
    const vh = typeof window !== "undefined" ? window.innerHeight || 800 : 800;
    const pending = [];
    for (let index = 0; index < targets.length; index++) {
      const element = targets[index];
      if (element.dataset.revealReady) continue;
      const delay = computeRevealDelay(element, index);
      const rect = revealObserver ? element.getBoundingClientRect?.() : null;
      pending.push({ element, delay, visible: !revealObserver || Boolean(rect && rect.top < vh * 0.92 && rect.bottom > 0) });
    }
    for (const item of pending) {
      const { element, delay, visible } = item;
      element.dataset.revealReady = "true";
      element.style.setProperty("--reveal-delay", delay);
      if (visible) {
        element.classList.add("is-visible");
      } else {
        element.classList.remove("is-visible");
        revealObserver.observe(element);
      }
    }
  };

  if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const target = entry.target;
        target.classList.add("is-visible");
        observer.unobserve(target);
        const rail = target.closest?.(".product-grid, .news-strip, .catalog-grid, .store-help-grid, .store-benefit-grid");
        if (rail) {
          [...rail.querySelectorAll("[data-reveal-ready]:not(.is-visible)")].forEach((peer, idx) => {
            peer.style.setProperty("--reveal-delay", `${Math.min(idx + 1, 5) * 75}ms`);
            peer.classList.add("is-visible");
            observer.unobserve(peer);
          });
        }
      });
    }, { threshold: 0.06, rootMargin: "0px 0px 32px 0px" });
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
  let measurePending = false;
  let cachedMaxScroll = 0;
  let cachedHeroHeight = 0;
  let heroEl = document.querySelector(".hero");
  let heroArtEl = document.querySelector(".hero-art img, .hero-art .k9-loop");
  let lastProgress = -1;
  let lastHeroOffset = -1;

  const measureScrollMetrics = () => {
    cachedMaxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    heroEl = document.querySelector(".hero");
    heroArtEl = document.querySelector(".hero-art img, .hero-art .k9-loop");
    cachedHeroHeight = heroEl ? heroEl.offsetHeight : 0;
  };
  const scheduleMeasureScrollMetrics = () => {
    if (measurePending) return;
    measurePending = true;
    requestAnimationFrame(() => {
      measurePending = false;
      measureScrollMetrics();
    });
  };

  const updateScrollEffects = () => {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      const progressValue = cachedMaxScroll > 0 ? Math.min(1, Math.max(0, y / cachedMaxScroll)) : 0;
      if (Math.abs(progressValue - lastProgress) > 0.001) {
        progress.style.transform = `scaleX(${progressValue})`;
        lastProgress = progressValue;
      }
      if (heroArtEl && heroArtEl.isConnected && cachedHeroHeight > 0 && y <= cachedHeroHeight + 120) {
        const travel = Math.max(0, Math.min(1, y / cachedHeroHeight));
        const px = Math.round(travel * 240) / 10;
        if (px !== lastHeroOffset) {
          heroArtEl.style.transform = `translate3d(0, ${px}px, 0) scale(.94)`;
          lastHeroOffset = px;
        }
      }
      framePending = false;
    });
  };
  measureScrollMetrics();
  window.addEventListener("scroll", updateScrollEffects, { passive: true });
  window.addEventListener("resize", () => { scheduleMeasureScrollMetrics(); updateScrollEffects(); }, { passive: true });
  if ("ResizeObserver" in window && document.body) {
    new ResizeObserver(scheduleMeasureScrollMetrics).observe(document.body);
  }
  updateScrollEffects();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeMotion, { once: true });
} else {
  initializeMotion();
}

document.addEventListener('gaeru:products-loaded',()=>window.GAERUFooterProducts?.render(document.querySelector('[data-footer-products]'),window.GAERUStore?.products));

// Kênh lắng nghe Realtime SSE (/api/realtime) chỉ kết nối trên trang thương mại đang hiển thị (tránh mở socket thừa cho 100% khách đọc tĩnh)
(function initRealtimeSSE() {
  if (typeof window === 'undefined' || typeof window.EventSource !== 'function') return;
  const hasLocation = typeof window.location?.pathname === 'string' && window.location.pathname.length > 0;
  const pathname = hasLocation ? window.location.pathname : '';
  const needsLiveStock = !hasLocation || /^\/(?:san-pham\/|gio-hang|thanh-toan|product\.html|cart\.html|checkout\.html)/i.test(pathname);
  if (!needsLiveStock) return;

  let evtSource = null;
  let reconnectTimer = null;
  let backoffMs = 5000;

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (evtSource) {
      try { evtSource.close(); } catch (_) {}
      evtSource = null;
    }
  }

  function connect() {
    if (document.visibilityState === 'hidden') return;
    if (evtSource && evtSource.readyState !== 2) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      evtSource = new EventSource('/api/realtime');

      evtSource.onopen = () => {
        backoffMs = 5000;
      };

      evtSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload?.type === 'CACHE_INVALIDATED') {
            const tags = Array.isArray(payload.tags) ? payload.tags : [];

            if (tags.some(t => ['catalog', 'product:list', 'products', 'promotions', 'search-index', '*'].includes(t))) {
              edgeSearchIndex = null;
              if (typeof refreshMenuProducts === 'function' && (!document.body?.dataset?.policyCommerce || policyCatalogUsed)) {
                refreshMenuProducts({ fresh: true });
              }
            }

            window.dispatchEvent(new CustomEvent('gaeru:cache-invalidated', { detail: payload }));
          }
        } catch (_) {}
      };

      evtSource.onerror = () => {
        if (evtSource) {
          evtSource.close();
          evtSource = null;
        }
        if (document.visibilityState === 'hidden') return;
        if (!reconnectTimer) {
          const delay = backoffMs;
          backoffMs = Math.min(60000, backoffMs * 2);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, delay);
        }
      };
    } catch (_) {}
  }

  const start = () => {
    if (document.visibilityState !== 'hidden') connect();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') disconnect();
    else connect();
  });
  window.addEventListener('pagehide', disconnect);
  window.addEventListener('pageshow', (e) => {
    if (e?.persisted) start();
  });
})();
