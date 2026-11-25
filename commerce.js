const cartStorageKey = "gaeru-store-cart-v2";
let products = [];
let csrfToken = "";
let csrfFetchPromise = null;
let storeSettings = {
  shippingNote: "Phí giao hàng được tính theo tỉnh/thành phố đã chọn.",
  shippingRates: {}
};

const formatPrice = (price) => `${new Intl.NumberFormat("vi-VN").format(price)} ₫`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));
const normalizeSearchText = (value) => value.toLocaleLowerCase("vi").replace(/\bmic\b/g, "micro");
const normalizeExternalUrl = (url) => { if (!url) return ""; const trimmed = String(url).trim(); if (!trimmed) return ""; try { const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : "https://" + trimmed); if (u.protocol !== "https:" && u.protocol !== "http:") return ""; if (u.username || u.password) return ""; const h = u.hostname.toLowerCase(); const ok = h === "shopee.vn" || h.endsWith(".shopee.vn") || h === "shopee.com" || h.endsWith(".shopee.com") || h === "shp.ee" || h.endsWith(".shp.ee") || h === "shope.ee" || h.endsWith(".shope.ee") || h === "tiktok.com" || h.endsWith(".tiktok.com") || h === "tiktokshop.com" || h.endsWith(".tiktokshop.com"); if (!ok) return ""; if (u.protocol === "http:") u.protocol = "https:"; return u.href; } catch (_) { return ""; } };

function searchProducts(query) {
  const normalized = normalizeSearchText(query.trim());
  if (!normalized) return products;
  return products.filter((product) =>
    normalizeSearchText(`${product.name} ${product.slug} ${product.description} ${product.category} ${product.descriptor} ${(product.variants || []).map(variant => `${variant.name} ${variant.sku}`).join(" ")}`).includes(normalized)
  );
}

async function fetchCsrfToken(forceRefresh = false) {
  if (!forceRefresh && csrfToken) return csrfToken;
  if (!csrfFetchPromise) {
    csrfFetchPromise = fetch("/api/csrf", { credentials: "same-origin" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Không thể khởi tạo phiên bảo mật.");
        csrfToken = data.csrfToken ?? "";
        return csrfToken;
      })
      .finally(() => { csrfFetchPromise = null; });
  }
  return csrfFetchPromise;
}

async function apiRequest(url, options = {}, _retriedCsrf = false) {
  const {checkoutCsrf,...fetchOptions}=options;
  const isMutating = Boolean(options.method && options.method !== "GET");
  if (isMutating && !checkoutCsrf) await fetchCsrfToken(false);
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (isMutating) headers.set("X-CSRF-Token", checkoutCsrf || csrfToken);
  const response = await fetch(url, { ...fetchOptions, headers, credentials: "same-origin" });
  if (response.status === 403 && isMutating && !checkoutCsrf && !_retriedCsrf) {
    csrfToken = "";
    await fetchCsrfToken(true);
    return apiRequest(url, options, true);
  }
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Không thể hoàn tất yêu cầu (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

const cartPrefix = "gaeru-store-cart-v3:";
const cartStart = new WeakMap();
function cartOwner() { return window.GAERUCustomerSession?.customer?.id || "guest"; }
function storedCartValue(key, fallback) {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : fallback;
}
function validCartItems(value) {
  return Array.isArray(value) ? value.filter(i=>i && typeof i.variantId==="string" && Number.isInteger(i.quantity) && i.quantity>0 && i.quantity<=99) : [];
}
function cartOperations(owner) {
  const head = cartPrefix + owner + ":op:";
  const records = [];
  for (let i=0; i<localStorage.length; i++) {
    const key=localStorage.key(i);
    if (!key?.startsWith(head)) continue;
    const op=storedCartValue(key,null);
    if (op && Array.isArray(op.items)) records.push({key,op});
  }
  return records.sort((a,b)=>String(a.op.order).localeCompare(String(b.op.order)) || a.key.localeCompare(b.key));
}
function applyCartOperation(map, op) {
  for (const item of op.items) {
    const before=map.get(item.variantId)||0;
    const after=op.kind==="legacy" ? Math.max(before,item.quantity) : before+item.quantity;
    if (after>0) map.set(item.variantId,Math.min(99,after)); else map.delete(item.variantId);
  }
}
function cartFrom(items,records) {
  const map=new Map(items.map(i=>[i.variantId,i.quantity]));
  records.forEach(({op})=>applyCartOperation(map,op));
  return [...map].map(([variantId,quantity])=>({variantId,quantity}));
}
function readCart() {
  try {
    const owner=cartOwner();
    const base=owner==="guest" ? storedCartValue(cartStorageKey,[]) : storedCartValue(cartPrefix+owner+":snapshot",{}).items;
    const cart=cartFrom(validCartItems(base),cartOperations(owner));
    cartStart.set(cart,{owner,items:cart.map(i=>({...i}))});
    return cart;
  } catch (error) {
    console.error("Không thể đọc giỏ hàng GAERU:",error);
    return [];
  }
}
function quantityChanges(before,after) {
  const diff=new Map(before.map(i=>[i.variantId,-i.quantity]));
  for (const i of after) diff.set(i.variantId,(diff.get(i.variantId)||0)+i.quantity);
  return [...diff].filter(([,q])=>q!==0).map(([variantId,quantity])=>({variantId,quantity}));
}
async function cartHash(value) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,"0")).join("");
}
function saveCartOperation(owner,op) {
  localStorage.setItem(cartPrefix+owner+":op:"+op.order+":"+op.id,JSON.stringify(op));
}
async function adoptGuestCart(owner) {
  const hasShell=Boolean(window.GAERUDeviceCart);
  if(hasShell) window.GAERUDeviceCart.claim(owner);
  const legacyKey=hasShell ? cartPrefix+owner+":legacy" : cartStorageKey;
  const guestScope=hasShell ? owner+":guest" : "guest";
  const handoffKey=cartPrefix+owner+":handoff";
  let transfer=storedCartValue(handoffKey,null);
  if(!transfer) {
    const raw=localStorage.getItem(legacyKey);
    const legacy=validCartItems(raw ? JSON.parse(raw) : []);
    const records=cartOperations(guestScope);
    if(!legacy.length && !records.length) return;
    const old=new Map(legacy.map(i=>[i.variantId,i.quantity]));
    const mirrored=[],fresh=[];
    for(const item of cartFrom(legacy,records)){
      const oldQty=Math.min(old.get(item.variantId)||0,item.quantity);
      if(oldQty) mirrored.push({variantId:item.variantId,quantity:oldQty});
      if(item.quantity>oldQty) fresh.push({variantId:item.variantId,quantity:item.quantity-oldQty});
    }
    const signature=await cartHash(JSON.stringify([owner,legacy,records.map(r=>r.op.id)]));
    if(cartOwner()!==owner) return;
    const operations=[];
    for(const [kind,items,order] of [["legacy",mirrored,"0000000000000"],["import",fresh,"0000000000001"]]){
      // Keep old, unusually large carts transferable under the per-operation limit.
      for(let offset=0;offset<items.length;offset+=100) operations.push({
        kind,items:items.slice(offset,offset+100),order,id:kind+"-"+signature+"-"+(offset/100)
      });
    }
    transfer={raw,keys:records.map(r=>r.key),operations};
    localStorage.setItem(handoffKey,JSON.stringify(transfer));
  }
  // Replay the saved transfer even if the tab stopped midway through local cleanup.
  for(const op of transfer.operations) saveCartOperation(owner,op);
  if(transfer.raw && localStorage.getItem(legacyKey)===transfer.raw) localStorage.removeItem(legacyKey);
  for(const key of transfer.keys) localStorage.removeItem(key);
  localStorage.removeItem(handoffKey);
}
let cartSyncJob=null,cartSyncAgain=false,cartRetryTimer;
function announceCartChange(){
  document.dispatchEvent(new CustomEvent("gaeru:cart-updated"));
}
async function flushCart(owner) {
  if (owner!==cartOwner()||owner==="guest") return;
  const oldCart=JSON.stringify(readCart());
  await adoptGuestCart(owner);
  let more=true;
  while (more && owner===cartOwner()) {
    const pending=cartOperations(owner),batch=pending.slice(0,25);
    const operations=batch.map(({op})=>({id:op.id,kind:op.kind,items:op.items}));
    const result=await apiRequest("/api/customer/cart/sync",{
      method:"POST",body:JSON.stringify({customerId:owner,operations}),gaeruBackground:true,
      ...(typeof AbortSignal!=="undefined" && AbortSignal.timeout ? {signal:AbortSignal.timeout(15000)} : {})
    });
    if (result.customerId!==owner || !Array.isArray(result.items)) throw Error("Chưa đồng bộ được giỏ hàng.");
    const key=cartPrefix+owner+":snapshot",previous=storedCartValue(key,{});
    if ((previous.revision??-1)<=result.revision) {
      const value=JSON.stringify({revision:result.revision,items:result.items});
      if(localStorage.getItem(key)!==value)localStorage.setItem(key,value);
    }
    for(const row of batch)localStorage.removeItem(row.key);
    more=pending.length>batch.length;
    if(owner===cartOwner()) announceCartChange();
  }
  if(owner===cartOwner() && oldCart!==JSON.stringify(readCart()) && document.querySelector("#checkout-content")
      && !document.querySelector("#checkout-content .order-success") && !new URLSearchParams(location.search).has("variant")) {
    const form=document.querySelector("#checkout-form");
    if(!form || !form.querySelector('[data-user-dirty="1"]')) await renderCheckout();
  }
}
function mergeCartWithServer() {
  if (cartOwner()==="guest") return Promise.resolve();
  if (cartSyncJob) {cartSyncAgain=true;return cartSyncJob;}
  const owner=cartOwner();
  const run=()=>flushCart(owner);
  const job=Promise.resolve().then(()=>globalThis.navigator?.locks?.request
    ? navigator.locks.request("gaeru-cart-sync-v3",run) : run());
  cartSyncJob=job.catch(error=>{
    console.warn("Chưa đồng bộ được giỏ hàng:",error.message);
    clearTimeout(cartRetryTimer);
    if(cartOwner()===owner && error.status!==401 && error.status!==403 && error.status!==409)
      cartRetryTimer=setTimeout(()=>mergeCartWithServer(),10000);
  }).finally(()=>{
    cartSyncJob=null;
    if(cartSyncAgain){cartSyncAgain=false;void mergeCartWithServer();}
  });
  return cartSyncJob;
}
function syncCartToServer(){return mergeCartWithServer();}
function writeCart(cart) {
  try {
    const owner=cartOwner(),start=cartStart.get(cart);
    if (start && start.owner!==owner) throw Error("Tài khoản đã thay đổi.");
    const items=quantityChanges(start?.items || readCart(),cart);
    if (!items.length) return true;
    const op={id:crypto.randomUUID(),order:String(Date.now()).padStart(13,"0"),kind:"change",items};
    saveCartOperation(owner,op);
    announceCartChange();
    if(owner!=="guest") void mergeCartWithServer();
    return true;
  } catch (error) {
    console.error("Không thể lưu giỏ hàng GAERU:",error);
    const feedback=document.querySelector("[data-cart-feedback]");
    if (feedback) feedback.textContent="Không thể lưu giỏ hàng trên thiết bị này.";
    return false;
  }
}

function safeCheckoutPaymentUrl(value) {
  const rawPayUrl = String(value).trim();
  let safePayUrl = null;
  if (/^\/(?!\/)[^\s\\]*$/.test(rawPayUrl)) {
    safePayUrl = rawPayUrl;
  } else {
    try {
      const baseOrigin = (typeof location !== "undefined" && location.origin && location.origin !== "null") ? location.origin : "https://gaeru.com";
      const parsed = new URL(rawPayUrl, baseOrigin);
      const allowedHosts = new Set([
        "pay.vnpay.vn", "sandbox.vnpayment.vn",
        "payment.momo.vn", "test-payment.momo.vn",
        "gateway.zalopay.vn", "qcgateway.zalopay.vn", "sbgateway.zalopay.vn"
      ]);
      if ((parsed.origin === baseOrigin && (parsed.protocol === "http:" || parsed.protocol === "https:")) ||
    (parsed.protocol === "https:" && allowedHosts.has(parsed.hostname.toLowerCase()))) {
        safePayUrl = parsed.toString();
      }
    } catch (_) {}
  }
  return safePayUrl;
}
function pendingOrderKey(owner=cartOwner()) { return "gaeru-pending-checkout:"+owner; }
function pendingOrder() {
  try { return JSON.parse(sessionStorage.getItem(pendingOrderKey()) || "null"); } catch { return null; }
}
function postOrderCart(owner,key,items,direct) {
  if(direct || owner!==cartOwner()) return;
  if(owner!=="guest") { void mergeCartWithServer(); return; }
  const receiptKey=cartPrefix+"guest:op:paid:order-"+key;
  if(!localStorage.getItem(receiptKey)){
    const op={kind:"change",id:"order-"+key,order:String(Date.now()).padStart(13,"0"),
      items:items.map(i=>({variantId:i.variantId,quantity:-i.quantity}))};
    localStorage.setItem(receiptKey,JSON.stringify(op));
  }
  announceCartChange();
}
async function restorePendingOrder(root) {
  const owner=cartOwner(),record=pendingOrder();
  if(!record || !/^[a-f0-9]{64}$/.test(record.key) || !/^gaeru-checkout-v1:[a-f0-9]{64}$/.test(record.storageKey) || !Array.isArray(record.items)) return false;
  if(Date.now()-record.at>86400000){sessionStorage.removeItem(pendingOrderKey());return false;}
  let state;
  try { state=await apiRequest("/api/orders/checkout-attempt",{headers:{"X-Idempotency-Key":record.key},gaeruBackground:true}); }
  catch { state={status:"unavailable"}; }
  if(owner!==cartOwner() || pendingOrder()?.key!==record.key) return false;
  if(state.status==="unknown") return false;
  if(state.status!=="completed"){
    root.innerHTML='<p role="status">Chưa xác nhận được lần đặt hàng trước. Hãy kiểm tra lại trước khi gửi đơn.</p><button type="button" class="secondary-button">Kiểm tra lại</button>';
    root.querySelector("button").onclick=()=>renderCheckout();
    return true;
  }
  const bank=state.bankTransfer;
  const safe=state.paymentUrl && safeCheckoutPaymentUrl(state.paymentUrl);
  root.classList?.remove?.("checkout-two-col");
  root.innerHTML='<div class="order-success" role="status"><h2>Đã tiếp nhận đơn '+escapeHtml(state.orderNumber||"")+
    '</h2><p>'+escapeHtml(state.message||"GAERU đã lưu đơn hàng.")+'</p>'+
    (bank?'<p>Chuyển khoản tới '+escapeHtml(bank.bankName)+' · '+escapeHtml(bank.accountNumber)+' · '+escapeHtml(bank.accountHolder)+' · '+formatPrice(bank.amountVnd)+' · Nội dung '+escapeHtml(bank.transferContent)+'</p>':'')+
    '<div class="order-success-actions">'+(safe?'<a class="button button-blue" href="'+escapeHtml(safe)+'">Tiếp tục thanh toán</a>':'')+
    '<a class="button button-outline" href="/tra-cuu-don-hang?order='+encodeURIComponent(state.orderNumber||"")+'">Theo dõi đơn hàng</a></div></div>';
  postOrderCart(owner,record.key,record.items,record.direct);
  if(localStorage.getItem(record.storageKey)===record.generation || (!localStorage.getItem(record.storageKey)&&record.generation==="initial"))
    localStorage.setItem(record.storageKey,crypto.randomUUID());
  sessionStorage.removeItem(pendingOrderKey());
  return true;
}

async function checkoutIntent(payload) {
  const owner=cartOwner();
  const items=[...payload.items].sort((a,b)=>a.variantId.localeCompare(b.variantId));
  const digest=await cartHash(JSON.stringify([owner,{...payload,items}]));
  const storageKey="gaeru-checkout-v1:"+digest;
  const readGeneration=()=>localStorage.getItem(storageKey)||"initial";
  const generation=readGeneration();
  return {key:await cartHash(digest+"."+generation),storageKey,generation,complete(){
    if(readGeneration()===generation) localStorage.setItem(storageKey,crypto.randomUUID());
  }};
}

function cartRows(cart) {
  return cart.flatMap((item) => {
    for (const product of products) {
      const variant = product.variants.find((entry) => entry.id === item.variantId);
      if (variant) return [{ ...item, product, variant }];
    }
    return [];
  });
}

function updateCartBadge(cart = readCart()) {
  const quantity = cart.reduce((total, item) => total + item.quantity, 0);
  const badge = document.querySelector(".cart-count");
  const link = document.querySelector(".bag-link");
  if (!badge || !link) return;
  badge.textContent = String(quantity);
  badge.hidden = quantity === 0;
  link.setAttribute("aria-label", `Giỏ hàng, ${quantity} sản phẩm`);
}

function getPriceLabel(product, original = false) {
  const availableVariants = product.variants.filter((variant) => variant.active);
  if (!availableVariants.length) return "Chưa mở bán";
  const prices = availableVariants.map((variant) => original ? (variant.originalPriceVnd ?? variant.priceVnd) : variant.priceVnd);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return low === high ? formatPrice(low) : `Từ ${formatPrice(low)} đến ${formatPrice(high)}`;
}

function promotionLabel(product, includePrice = true){const sale=product.variants.filter(v=>v.active&&v.promotion);if(!sale.length)return '';const flash=sale.some(v=>v.promotion.type==='flash');const end=sale.filter(v=>!flash||v.promotion.type==='flash').map(v=>new Date(v.promotion.endsAt).getTime()).sort((a,b)=>a-b)[0];const salePrice=getPriceLabel(product,false);return `<p class="store-promotion-note ${flash?'is-flash':''}"><strong class="promotion-badge">${flash?'Flash Sale':'Ưu đãi'}</strong>${flash?` <span class="sale-countdown" data-sale-end="${new Date(end).toISOString()}"></span>`:''}${includePrice?` <span class="promotion-divider">·</span> <span class="promotion-sale-price">${escapeHtml(salePrice)}</span>`:''}</p>`;}
function formatDisplayLabel(value){return String(value??'').replace(/\bmicro\s*usb\b/gi,'Micro USB');}
function formatPriceRangeHTML(priceStr){if(!priceStr||typeof priceStr!=='string')return escapeHtml(priceStr);const match=/^Từ\s+(.+?)\s+đến\s+(.+)$/i.exec(priceStr.trim());if(!match)return `<span class="vnd-amount">${escapeHtml(priceStr)}</span>`;const low=match[1],high=match[2];return `<span class="price-text-full">Từ <span class="vnd-amount">${escapeHtml(low)}</span> đến <span class="vnd-amount">${escapeHtml(high)}</span></span><span class="price-text-compact"><span class="vnd-amount">${escapeHtml(low)}</span> – <span class="vnd-amount">${escapeHtml(high)}</span></span>`;}
function productCard(product, compact = false) {
  const variants = product.variants.filter((variant) => variant.active);
  const availableVariants = variants.filter((variant) => variant.stockQuantity > 0);
  const cardImage = window.GAERUProductArtwork?.image(product) || product.imageUrl;
  const pUrl = `/san-pham/${encodeURIComponent(product.slug)}`;
  const isK9 = product.slug === "gaeru-k9" || product.slug === "k9";
  const isG1Ultra = product.slug === "gaeru-g1-ultra" || product.slug === "g1-ultra";
  const cardClass = compact
    ? `product-card ${isG1Ultra ? "product-card-wide" : ""}`
    : "catalog-card";
  const wrapPrice = typeof formatPriceRangeHTML === "function" ? formatPriceRangeHTML : escapeHtml;
  return compact ? `
    <article class="${cardClass}" id="${escapeHtml(product.slug)}" data-kind="${escapeHtml(product.category)}" data-href="${pUrl}">
      <div class="product-copy">
        <p class="eyebrow">${escapeHtml(product.descriptor)}</p>
        <h3>${escapeHtml(product.cardTitle||product.name)}</h3>
        <p>${escapeHtml(String(product.cardSummary||'').replace(/\*\*|__/g,''))}</p>
        ${(()=>{const hasSale=product.variants.some(v=>v.active&&v.promotion);return hasSale?`<p class="price price-original"><span class="price-original-label">Giá gốc </span><del>${wrapPrice(getPriceLabel(product,true))}</del></p>${promotionLabel(product,true)}`:`<p class="price">${wrapPrice(getPriceLabel(product))}</p>`;})()}

      </div>
      ${(img=>window.GAERUProductArtwork?.picture?.(img,cardImage)||img)(`<img class="product-image" src="${escapeHtml(cardImage)}" ${window.GAERUProductArtwork?.attributes?.(cardImage)||''} alt="${escapeHtml(product.imageAlt||product.name)}" loading="lazy" decoding="async">`)}
        <div class="card-actions">
          <button class="button button-blue" type="button" data-choose-cart="${escapeHtml(product.slug)}" ${availableVariants.length?"":"disabled"}>Thêm vào giỏ hàng</button>
          <a class="button button-outline" href="${pUrl}">Mua ngay</a>
        </div>
    </article>` : `
    <article class="${cardClass}" data-href="${pUrl}">
      <a class="catalog-card-image" href="${pUrl}" aria-label="Xem chi tiết ${escapeHtml(product.cardTitle||product.name)}">
        ${(img=>window.GAERUProductArtwork?.picture?.(img,cardImage)||img)(`<img src="${escapeHtml(cardImage)}" ${window.GAERUProductArtwork?.attributes?.(cardImage)||''} alt="${escapeHtml(product.imageAlt||product.name)}" loading="lazy" decoding="async">`)}
      </a>
      <p class="eyebrow">${escapeHtml(product.descriptor)}</p>
      <h2><a href="${pUrl}">${escapeHtml(product.cardTitle||product.name)}</a></h2>
      <p class="catalog-description">${escapeHtml(String(product.cardSummary||'').replace(/\*\*|__/g,''))}</p>
      ${promotionLabel(product,false)}
      <div class="catalog-actions">
        <p class="catalog-price">${(()=>{const hasSale=product.variants.some(v=>v.active&&v.promotion);return (hasSale?`<del class="catalog-price-original">${wrapPrice(getPriceLabel(product,true))}</del><br>`:'')+wrapPrice(getPriceLabel(product));})()}</p>
        <a class="button button-blue" href="${pUrl}">Mua ngay</a>
      </div>
    </article>`;
}

function renderHomeProducts() {
  const grid = document.querySelector(".product-grid");
  if (!grid) return;
  grid.innerHTML = products.length
    ? products.map((product) => productCard(product, true)).join("")
    : '<p class="empty-state">Chưa có sản phẩm được xuất bản.</p>';
  const k9 = products.find((product) => ["k9","gaeru-k9"].includes(product.slug));
  if (k9) {
    const heroImage = document.querySelector(".hero-art img");
    if (heroImage) {
      heroImage.src = "/assets/products/k9.webp";
      heroImage.alt = k9.imageAlt;
    }
  }
  window.GAERUK9Loop?.mountHome();
}

function renderCatalog() {
  window.GAERUProductArtwork?.mountStory();
  const grid = document.querySelector("#catalog-grid");
  if (!grid) return;
  const queryInput = document.querySelector("#catalog-search");
  const count = document.querySelector("#catalog-count");
  const empty = document.querySelector("#catalog-empty");
  const initialQuery = new URLSearchParams(location.search).get("q") || "";
  const categoryParam = new URLSearchParams(location.search).get("category");
  const savedOnly=new URLSearchParams(location.search).get("saved")==="1";
  let selectedCategory = ["audio", "video", "accessory"].includes(categoryParam) ? categoryParam : "all";
  queryInput.value = initialQuery;
  const navigation=document.querySelector('[data-store-products]');
  const categoryArtwork=product=>window.GAERUProductArtwork?.image(product)||product.imageUrl;
  if(navigation)navigation.innerHTML=products.length?products.map(product=>`<a class="store-category" href="/san-pham/${encodeURIComponent(product.slug)}"><span class="category-art">${(img=>window.GAERUProductArtwork?.picture?.(img,categoryArtwork(product))||img)(`<img ${product.slug==='gaeru-k9'?'data-k9-animate':''} src="${escapeHtml(categoryArtwork(product))}" ${window.GAERUProductArtwork?.attributes?.(categoryArtwork(product))||''} alt="" width="144" height="120" decoding="async">`)}</span><span>${escapeHtml(product.name)}</span></a>`).join(''):'<p class="store-navigation-status">Chưa có sản phẩm đang được đăng bán.</p>';
  const savedLinks = document.querySelectorAll("[data-saved-count]");
  const syncSavedVisibility = () => {
    let savedLen = 0;
    try {
      const rawSaved = JSON.parse(localStorage.getItem("gaeru.saved.products.v1") || "[]");
      if (Array.isArray(rawSaved)) savedLen = rawSaved.length;
    } catch (_) {}
    savedLinks.forEach((el) => {
      const m = /\((\d+)\)/.exec(el.textContent || "");
      const n = m ? Number.parseInt(m[1], 10) : savedLen;
      el.hidden = !savedOnly && !(n > 0);
    });
  };
  syncSavedVisibility();
  if (savedLinks.length && typeof MutationObserver === "function") {
    const savedMo = new MutationObserver(syncSavedVisibility);
    savedLinks.forEach((el) => savedMo.observe(el, { childList: true, characterData: true, subtree: true }));
  }
  window.addEventListener?.("storage", syncSavedVisibility);
  window.GAERUK9Loop?.mountHome();
  const updateRail = () => document.querySelectorAll('[data-store-scroll]').forEach(button => {
    button.disabled = Number(button.dataset.storeScroll) < 0 ? grid.scrollLeft <= 2 : grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 2;
  });
  document.querySelectorAll('[data-store-scroll]').forEach(button => button.addEventListener('click', () => grid.scrollBy({left: Number(button.dataset.storeScroll) * Math.max(280,grid.clientWidth * .8),behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'})));
  grid.addEventListener('scroll', updateRail, {passive:true});
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updateRail).observe(grid);

  const applyFilters = () => {
    const matching = searchProducts(queryInput.value.trim()).filter((product) =>
      (selectedCategory === "all" || product.category === selectedCategory || (selectedCategory === "video" && product.slug === "gaeru-p185")) && (!savedOnly||window.GAERUSavedProducts?.has(product.slug))
    );
    grid.innerHTML = matching.map((product) => productCard(product)).join("");
    count.textContent = `${matching.length} sản phẩm`;
    empty.hidden = matching.length > 0;
    if(savedOnly)empty.textContent="Chưa có sản phẩm đã lưu phù hợp trên trình duyệt này.";
    grid.scrollLeft = 0;
    updateRail();
    window.GAERUAutoRail?.mount();
  };

  queryInput.addEventListener("input", applyFilters);
  applyFilters();
}

function safeProductImage(value) {
 const image=String(value||'').replace(/^https?:\/\/(?:www\.)?gaeru\.com(?=\/)/i,'').replace(/^assets\//,'/assets/');
 return /^\/(?:assets\/products\/|api\/catalog-images\/|media\/products\/)[a-zA-Z0-9/_.?=&%+-]+$/.test(image) ? image : '/assets/products/k9.webp';
}

async function loadAndRenderBundles(product, currentVariantId) {
  const container = document.querySelector("[data-product-bundles-wrap]");
  if (!container) return;
  try {
    const res = await fetch(`/api/products/${encodeURIComponent(product.slug)}/bundles`);
    if (!res.ok) return;
    const { bundles } = await res.json();
    if (!bundles || !bundles.length) {
      container.innerHTML = "";
      return;
    }
    window.__currentBundles = bundles;
    renderBundlesHtml(container, bundles, currentVariantId);
  } catch (_) {}
}

function updateBundleCardPricing(card, bundle) {
  const currentSelector = document.querySelector("#product-variant");
  const primaryItem = bundle.primaryItems?.find(p => p.variantId === currentSelector?.value) || bundle.primaryItems?.[0];
  const primaryMinQty = Math.max(1, Number(primaryItem?.minQuantity) || 1);
  const primaryPrice = primaryItem ? primaryItem.priceVnd * primaryMinQty : 0;

  const primaryCard = card.querySelector(".primary-card");
  if (primaryCard && primaryItem) {
    const imgEl = primaryCard.querySelector("img");
    if (imgEl && primaryItem.imageUrl) imgEl.src = safeProductImage(primaryItem.imageUrl);
    const titleEl = primaryCard.querySelector("strong");
    if (titleEl) titleEl.textContent = primaryItem.productName;
    const varEl = primaryCard.querySelector("small");
    if (varEl) varEl.textContent = formatDisplayLabel(primaryItem.variantName);
    const priceEl = primaryCard.querySelector(".item-price");
    if (priceEl) priceEl.textContent = formatPrice(primaryItem.priceVnd);
  }

  const checkedBoxes = [...(card.querySelectorAll("[data-bundle-accessory]:checked") || [])];
  let secondaryTotal = 0;
  for (const box of checkedBoxes) {
    const secItem = bundle.bundledItems?.find(it => it.variantId === box.dataset.bundleAccessory);
    if (secItem) secondaryTotal += secItem.priceVnd * (secItem.minQuantity || 1);
  }
  const originalTotal = primaryPrice + secondaryTotal;
  let discount = 0;
  if (checkedBoxes.length > 0) {
    if (bundle.discountType === 'percent') {
      discount = Math.floor(secondaryTotal * bundle.discountValue / 100);
    } else {
      discount = Math.min(originalTotal, bundle.discountValue);
    }
  }
  const finalTotal = Math.max(0, originalTotal - discount);
  const origEl = card.querySelector(`[data-bundle-orig="${bundle.id}"]`);
  const finalEl = card.querySelector(`[data-bundle-final="${bundle.id}"]`);
  if (origEl) origEl.textContent = formatPrice(originalTotal);
  if (finalEl) finalEl.textContent = formatPrice(finalTotal);
  const addBtn = card.querySelector(`[data-add-bundle="${bundle.id}"]`);
  if (addBtn) addBtn.disabled = checkedBoxes.length === 0;
}

function updateAllBundleCards(selectedVariantId) {
  const container = document.querySelector("[data-product-bundles-wrap]");
  if (!container || !window.__currentBundles) return;
  for (const bundle of window.__currentBundles) {
    const card = container.querySelector(`[data-bundle-id="${bundle.id}"]`);
    if (card) updateBundleCardPricing(card, bundle);
  }
}

function renderBundlesHtml(container, bundles, currentVariantId) {
  if (!container || !bundles) return;
  container.innerHTML = bundles.map(b => {
    const primaryItem = b.primaryItems?.find(p => p.variantId === currentVariantId) || b.primaryItems?.[0];
    const bundledItems = b.bundledItems || [];
    if (!primaryItem || !bundledItems.length) return "";
    return `
      <section class="product-bundle-cross-sell" data-bundle-id="${escapeHtml(b.id)}">
        <div class="bundle-header">
          <h3 class="bundle-title">
            <span>Ưu đãi mua kèm: ${escapeHtml(b.title)}</span>
            <span class="bundle-badge">-${b.discountType === 'percent' ? b.discountValue + '%' : formatPrice(b.discountValue)}</span>
          </h3>
          ${b.description ? `<p class="bundle-desc">${escapeHtml(b.description)}</p>` : ''}
        </div>
        <div class="bundle-items-flow">
          <div class="bundle-item-card primary-card">
            <img src="${escapeHtml(safeProductImage(primaryItem.imageUrl))}" alt="${escapeHtml(primaryItem.productName)}" width="52" height="52" loading="lazy" fetchpriority="low">
            <div class="bundle-item-info">
              <strong>${escapeHtml(primaryItem.productName)}</strong>
              <small>${escapeHtml(formatDisplayLabel(primaryItem.variantName))}</small>
              <span class="item-price">${formatPrice(primaryItem.priceVnd)}</span>
            </div>
          </div>
          <span class="bundle-plus-icon" aria-hidden="true">+</span>
          ${bundledItems.map(item => `
            <div class="bundle-item-card secondary-card">
              <label class="bundle-accessory-choice">
                <input type="checkbox" data-bundle-accessory="${escapeHtml(item.variantId)}" checked>
                <img src="${escapeHtml(safeProductImage(item.imageUrl))}" alt="${escapeHtml(item.productName)}" width="52" height="52" loading="lazy" fetchpriority="low">
                <div class="bundle-item-info">
                  <strong>${escapeHtml(item.productName)}</strong>
                  <small>${escapeHtml(formatDisplayLabel(item.variantName))}</small>
                  <span class="item-price">${formatPrice(item.priceVnd)}</span>
                </div>
              </label>
            </div>
          `).join('<span class="bundle-plus-icon" aria-hidden="true">+</span>')}
        </div>
        <div class="bundle-footer">
          <div class="bundle-price-box">
            <span class="bundle-original-price" data-bundle-orig="${escapeHtml(b.id)}">${formatPrice(b.originalComboTotal)}</span>
            <strong class="bundle-final-price" data-bundle-final="${escapeHtml(b.id)}">${formatPrice(b.discountedComboTotal)}</strong>
          </div>
          <button type="button" class="button button-blue bundle-add-button" data-add-bundle="${escapeHtml(b.id)}">
            Thêm combo vào giỏ
          </button>
        </div>
        <p class="bundle-feedback" data-bundle-feedback="${escapeHtml(b.id)}" role="status" aria-live="polite"></p>
      </section>
    `;
  }).join("");
}

function renderProduct() {
  const root = document.querySelector("#product-detail");
  if (!root) return;
  const searchParams = new URLSearchParams(location.search);
  const slug = (searchParams.get("id") || searchParams.get("slug") || (location.pathname.startsWith("/san-pham/") ? decodeURIComponent(location.pathname.split("/").pop()) : null));
  const product = products.find((item) => item.slug === slug || item.slug === "gaeru-"+slug);
  if (!product) {
    root.innerHTML = `<section class="not-found section-wrap"><p class="eyebrow">Không tìm thấy sản phẩm</p><h1>Sản phẩm này chưa có hoặc đang được cập nhật.</h1><a class="button button-blue" href="/cua-hang">Quay lại cửa hàng</a></section>`;
    return;
  }
  const variants = product.variants.filter((variant) => variant.active);
  const selected = null;
  const saleVariants = variants.filter(v => v.promotion);
  const flashVariants = saleVariants.filter(v => v.promotion.type === 'flash');
  const hasFlash = flashVariants.length > 0;
  const hasSale = saleVariants.length > 0;
  const initialFlashEnd = flashVariants.map(v => new Date(v.promotion.endsAt).getTime()).sort((a,b)=>a-b)[0];
  const initialSalePrice = getPriceLabel(product, false);
  const initialOriginalPrice = getPriceLabel(product, true);
  let initialDiscountPercent = 0;
  if (hasSale) {
    // GAERU F-17: Compute exact discount percentage per individual variant to prevent mismatched cross-SKU mixing
    const discounts = saleVariants.map(v => {
      const orig = v.originalPriceVnd ?? v.priceVnd;
      return orig > v.priceVnd ? Math.round((1 - v.priceVnd / orig) * 100) : 0;
    });
    initialDiscountPercent = Math.max(0, ...discounts);
  }
  const priceBoxHtml = `<div class="product-price-box ${hasFlash ? 'is-flash' : ''}" data-price-box><div class="product-flash-header" data-flash-header ${hasFlash ? '' : 'hidden'}><div class="flash-badge-wrap"><span class="flash-badge-icon" aria-hidden="true">⚡</span><strong class="promotion-badge flash-badge-pill">FLASH SALE</strong></div><div class="flash-timer-wrap"><span class="flash-timer-label">Kết thúc sau</span><span class="sale-countdown store-sale-countdown" data-selected-countdown ${initialFlashEnd ? `data-sale-end="${new Date(initialFlashEnd).toISOString()}"` : ''}></span></div></div><div class="product-price-body"><div class="product-price-main"><span class="detail-price ${hasFlash ? 'detail-price-flash' : ''}" data-selected-price>${formatPriceRangeHTML(initialSalePrice)}</span><span class="flash-price-tag" data-flash-tag ${hasFlash ? '' : 'hidden'}>Giá Flash Sale</span></div><div class="product-price-sub" data-price-sub ${hasSale ? '' : 'hidden'}><span class="price-original" data-selected-original><span class="price-original-label">Giá gốc: </span><del data-selected-original-price>${escapeHtml(initialOriginalPrice)}</del></span><span class="promotion-discount-badge" data-selected-discount ${initialDiscountPercent ? '' : 'hidden'}>-${initialDiscountPercent}%</span></div></div></div>`;
  const seoDescriptor=String(product.descriptor||'').replace(/\*\*/g,'').replace(/\s+/g,' ').trim();
  const seoLabel=(seoDescriptor||'Thiết bị sáng tạo GAERU').toLocaleLowerCase('vi').replace(/\bai\b/g,'AI');
  document.title=product.name+' — '+seoLabel.charAt(0).toLocaleUpperCase('vi')+seoLabel.slice(1);
  const breadcrumb = document.querySelector("#breadcrumb-product");
  if (breadcrumb) breadcrumb.textContent = product.name;
  const optionGroups=window.GAERUVariantChoices?.groups(variants,product.optionGroups)||[];
  const visualOptions=optionGroups.length?optionGroups.map(g=>`<div class="product-choice-group"><p>${escapeHtml(g.name)}</p><div class="product-choice-buttons" role="group" aria-label="${escapeHtml(g.name)}">${g.values.map(value=>`<button type="button" data-option-group="${escapeHtml(g.name)}" data-option-value="${escapeHtml(value)}" aria-pressed="false">${escapeHtml(formatDisplayLabel(value))}</button>`).join("")}</div></div>`).join(""):`<div class="product-variant-grid">${variants.map(v=>`<button class="product-variant-card" type="button" data-visual-variant="${escapeHtml(v.id)}" aria-pressed="false">${escapeHtml(formatDisplayLabel(v.name))}<small>${formatPrice(v.priceVnd)}${v.stockQuantity?"":" · Hết hàng"}</small></button>`).join("")}</div>`;
  const variantField = variants.length ? `${visualOptions}<label class="variant-select-label variant-select-internal" for="product-variant">Phiên bản
      <select id="product-variant">
        <option value="" disabled selected>Chọn phiên bản</option>
        ${variants.map((variant) => {
          const options = Object.entries(variant.options || {}).map(([key, value]) => `${key}: ${formatDisplayLabel(value)}`).join(" · ");
          const label = [formatDisplayLabel(variant.name), options, `SKU ${variant.sku}`, variant.stockQuantity ? "" : "Hết hàng"].filter(Boolean).join(" — ");
          return `<option value="${escapeHtml(variant.id)}"  ${variant.stockQuantity ? "" : "disabled"}>${escapeHtml(label)} · ${formatPrice(variant.priceVnd)}</option>`;
        }).join("")}
      </select>
    </label>
    ${priceBoxHtml}` : `
    <p class="detail-price">Chưa có phiên bản để đặt hàng</p>`;

  const existingHeroNode = root.querySelector('.product-detail-art > picture, .product-detail-art > [data-product-main-image]');
  const existingHeroImg = existingHeroNode?.matches?.('img') ? existingHeroNode : existingHeroNode?.querySelector?.('[data-product-main-image]');
  const expectedHeroPath = safeProductImage(product.imageUrl).split('?')[0];
  const existingHeroPath = (existingHeroImg?.getAttribute?.('src') || '').split('?')[0];
  const reuseHeroNode = Boolean(existingHeroNode && existingHeroImg && existingHeroPath && existingHeroPath === expectedHeroPath);
  if (reuseHeroNode) existingHeroNode.remove?.();

  root.innerHTML = `
    <header class="product-purchase-heading section-wrap"><p class="eyebrow">${escapeHtml(product.descriptor)}</p><h1>Mua ${escapeHtml(product.name)}</h1>${hasFlash ? `<div class="product-heading-flash-badge"><span class="flash-badge-icon" aria-hidden="true">⚡</span><span class="flash-badge-text">FLASH SALE ĐANG DIỄN RA ${initialDiscountPercent ? `· Tiết kiệm tới ${initialDiscountPercent}%` : ''}</span></div>` : ''}${product.cardSummary?`<p class="product-purchase-intro">${escapeHtml(product.cardSummary)}</p>`:''}<div class="purchase-intro-links"><a class="text-link" href="#product-information">Thông tin chi tiết ↓</a></div></header>
    <section class="product-detail section-wrap" aria-label="Chọn phiên bản ${escapeHtml(product.name)}">
      <div class="product-detail-art">${(img=>window.GAERUProductArtwork?.picture?.(img,safeProductImage(product.imageUrl),true)||img)(`<img loading="eager" fetchpriority="high" decoding="async" width="800" height="800" data-product-main-image src="${escapeHtml(safeProductImage(product.imageUrl))}" ${window.GAERUProductArtwork?.attributes?.(safeProductImage(product.imageUrl),true)||''} alt="${escapeHtml(product.imageAlt||product.name)}">`)}<div class="product-gallery-thumbnails product-thumbs">${[...new Set([product.imageUrl,...(product.gallery||[])])].map((url,i)=>`<button type="button" data-gallery-image="${escapeHtml(url)}" aria-label="Xem ảnh ${i+1}" aria-pressed="${url===product.imageUrl}">${(img=>window.GAERUProductArtwork?.picture?.(img,url,'thumb')||img)(`<img src="${escapeHtml(url)}" ${window.GAERUProductArtwork?.attributes?.(url,'thumb')||''} alt="" width="74" height="74" loading="lazy" fetchpriority="low" decoding="async">`)}</button>`).join("")}</div></div>
      <div class="product-detail-copy">
        <h2 class="product-config-heading">Phiên bản. <span>${(product.variants || []).some(v => /type-?c|lightning|usb|3\.5mm|chân cắm|kết nối/i.test(`${v.name || ""} ${JSON.stringify(v.options || {})}`)) ? "Chọn kết nối phù hợp với bạn." : "Chọn cấu hình phù hợp với bạn."}</span></h2>
        ${variantField}<p data-selected-promotion class="store-promotion-note" hidden></p>
        <div class="detail-actions">
          <button class="button button-blue buy-now-button" type="button" data-buy-now="" disabled>Mua ngay</button>
          <button class="button button-blue" type="button" data-add-to-cart="" disabled>Thêm vào giỏ</button>
        </div>
        <p class="cart-feedback" data-cart-feedback aria-live="polite"></p>
        <section class="product-delivery" aria-label="Thông tin giao hàng"><svg viewBox="0 0 32 28" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 3h18v18H2zM20 10h6l4 6v5H20"/><circle cx="8" cy="22" r="3" fill="white"/><circle cx="25" cy="22" r="3" fill="white"/></svg><div><h3>Giao hàng</h3><p class="stock-note" data-stock-note>Vui lòng chọn phiên bản</p><p>Xem phí giao hàng khi thanh toán.</p><details data-delivery-details><summary>Nhận thông tin giao hàng ⊕</summary><div data-delivery-content>Đang tải thông tin…</div></details></div></section>
        ${(product.shopeeUrl || product.tiktokShopUrl) ? `
        <div class="product-marketplace-actions" aria-label="Đặt mua qua sàn thương mại điện tử">
          <div class="marketplace-divider"><span>Hoặc đặt mua chính hãng tại</span></div>
          <div class="marketplace-buttons">
            ${product.shopeeUrl ? `<a class="button button-marketplace button-shopee" href="${escapeHtml(normalizeExternalUrl(product.shopeeUrl))}" target="_blank" rel="noopener noreferrer"><svg class="marketplace-icon shopee-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M19.467 7.424A3.01 3.01 0 0 0 16.5 5.002H15V4a3 3 0 0 0-6 0v1.002H7.5a3.01 3.01 0 0 0-2.967 2.422L3.05 18.25A2 2 0 0 0 5.016 20.5h13.968a2 2 0 0 0 1.966-2.25l-1.483-10.826ZM10.5 4a1.5 1.5 0 0 1 3 0v1.002h-3V4Zm-3 3.002h1.5v1.5a.75.75 0 0 0 1.5 0v-1.5h3v1.5a.75.75 0 0 0 1.5 0v-1.5H16.5a1.505 1.505 0 0 1 1.483 1.21l1.322 9.645a.5.5 0 0 1-.492.563H5.187a.5.5 0 0 1-.492-.563l1.322-9.645A1.505 1.505 0 0 1 7.5 7.002Zm5.714 5.344a.75.75 0 0 0-.964.44c-.31.815-.815 1.134-1.41 1.134-.73 0-1.2-.42-1.2-1.04 0-.825.962-1.205 2.1-1.458.12-.027.24-.055.362-.085a.75.75 0 1 0-.36-1.456c-.097.024-.194.047-.291.068-1.57.348-3.31 1.055-3.31 2.931 0 1.58 1.233 2.54 2.7 2.54 1.348 0 2.274-.755 2.813-1.63a.75.75 0 0 0-.44-.944Z"/></svg><span>Mua ở Shopee</span></a>` : ''}
            ${product.tiktokShopUrl ? `<a class="button button-marketplace button-tiktok" href="${escapeHtml(normalizeExternalUrl(product.tiktokShopUrl))}" target="_blank" rel="noopener noreferrer"><svg class="marketplace-icon tiktok-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#25F4EE" d="M19.321 5.562a5.122 5.122 0 0 1-.443-.258 6.228 6.228 0 0 1-1.137-.966c-.349-.387-.714-.852-.892-1.338h-2.147v13.435a2.53 2.53 0 0 1-2.529 2.529 2.53 2.53 0 0 1-2.529-2.529 2.53 2.53 0 0 1 2.529-2.529c.348 0 .678.071.979.198v-3.136a5.67 5.67 0 0 0-.979-.086 5.666 5.666 0 0 0-5.666 5.666 5.666 5.666 0 0 0 5.666 5.666 5.666 5.666 0 0 0 5.666-5.666V8.918a8.963 8.963 0 0 0 5.257 1.677V7.459a5.792 5.792 0 0 1-3.775-1.897z"/><path fill="#FE2C55" d="M20.485 6.687c-.38-.073-.78-.124-1.164-.124a5.79 5.79 0 0 1-3.619-1.258 5.76 5.76 0 0 1-1.428-1.743h-2.147v13.435a2.53 2.53 0 0 1-2.529 2.529 2.53 2.53 0 0 1-2.529-2.529 2.53 2.53 0 0 1 2.529-2.529c.348 0 .678.071.979.198v-3.136a5.67 5.67 0 0 0-.979-.086 5.666 5.666 0 0 0-5.666 5.666 5.666 5.666 0 0 0 5.666 5.666 5.666 5.666 0 0 0 5.666-5.666V8.918a8.963 8.963 0 0 0 5.257 1.677V7.459c-.43 0-.853-.081-1.265-.245a5.77 5.77 0 0 1-2.434-1.527z"/><path fill="#FFFFFF" d="M19.589 6.686a4.793 4.793 0 0 1-3.77-4.245V2h-3.445v13.672a2.896 2.896 0 0 1-5.201 1.743 2.897 2.897 0 0 1 2.317-4.639c.33 0 .647.055.943.157V9.42a6.36 6.36 0 0 0-.943-.073 6.34 6.34 0 0 0-6.34 6.341 6.34 6.34 0 0 0 6.34 6.34 6.341 6.341 0 0 0 6.34-6.34V9.043a8.163 8.163 0 0 0 4.758 1.517V7.114a4.82 4.82 0 0 1-1-.428Z"/></svg><span>Mua ở TikTok Shop</span></a>` : ''}
          </div>
        </div>` : ''}
        <div data-product-bundles-wrap></div>
        <section class="product-save-later"><h3>Vẫn chưa thể quyết định?</h3><p>Lưu sản phẩm để dễ dàng quay lại xem trên trình duyệt này.</p><button type="button" class="save-product-button" data-save-product="${escapeHtml(product.slug)}" aria-pressed="false">Lưu để xem lại sau</button><a href="/cua-hang?saved=1">Xem sản phẩm đã lưu ↗</a><p role="status" aria-live="polite"></p></section>
        <section class="product-shopping-help"><svg viewBox="0 0 32 30" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 3h20v17H10l-6 6v-6H3zM23 10h6v15h-7l-4 4v-9"/></svg><div><h3>Trợ giúp mua sắm.</h3><p><button type="button" class="chat-product-button" data-product-chat="${escapeHtml(product.slug)}">Chat ngay ↗</button> hoặc gọi <a href="tel:0829191080">082 919 1080</a>.</p><small>AI hỗ trợ trước; chọn Gặp nhân viên khi cần.</small></div></section>
      </div>
    </section>
    <section class="product-information section-wrap" id="product-information">${window.GAERUDescription?.informationHeader?.(product.slug)||`<header><p class="eyebrow">TÌM HIỂU SẢN PHẨM</p><h2>${escapeHtml(product.name)}. <span>Chi tiết cho lựa chọn của bạn.</span></h2></header>`}${window.GAERUDescription?window.GAERUDescription.render(product):`<p class="detail-description">${escapeHtml(product.description)}</p>`}</section>
    <section class="detail-more"><p class="eyebrow">Khám phá thêm</p><h2>Thiết bị khác. Cùng cảm hứng.</h2><a class="text-link" href="/cua-hang">Xem toàn bộ cửa hàng <span aria-hidden="true">›</span></a></section>`;
  if (reuseHeroNode && existingHeroNode) {
    const freshHeroNode = root.querySelector('.product-detail-art > picture, .product-detail-art > [data-product-main-image]');
    if (freshHeroNode && typeof freshHeroNode.replaceWith === 'function') {
      existingHeroImg.setAttribute('loading', 'eager');
      existingHeroImg.setAttribute('fetchpriority', 'high');
      existingHeroImg.setAttribute('width', '800');
      existingHeroImg.setAttribute('height', '800');
      freshHeroNode.replaceWith(existingHeroNode);
    }
  }

  const selector = root.querySelector("#product-variant");
  const countdown=root.querySelector('[data-selected-countdown]');
  const setCountdown = variant => {
    if (!countdown) return;
    if (variant?.promotion?.type === 'flash') countdown.dataset.saleEnd = new Date(variant.promotion.endsAt).toISOString();
    else if (!variant && hasFlash && initialFlashEnd) countdown.dataset.saleEnd = new Date(initialFlashEnd).toISOString();
    else { delete countdown.dataset.saleEnd; countdown.textContent = ''; }
  };
  setCountdown(selected);
  if (typeof updateSaleCountdowns === 'function') updateSaleCountdowns();
  selector?.addEventListener("change", () => {
    const variant = variants.find((item) => item.id === selector.value);
    if (!variant) return;
    setCountdown(variant);
    if (typeof updateSaleCountdowns === 'function') updateSaleCountdowns();
    const priceNode = root.querySelector("[data-selected-price]");
    if (priceNode) priceNode.textContent = formatPrice(variant.priceVnd);
    const isFlash = variant.promotion?.type === 'flash';
    const hasPromo = Boolean(variant.promotion);
    const flashHeader = root.querySelector("[data-flash-header]");
    const flashTag = root.querySelector("[data-flash-tag]");
    const priceSub = root.querySelector("[data-price-sub]");
    const origPriceNode = root.querySelector("[data-selected-original-price]");
    const discountNode = root.querySelector("[data-selected-discount]");
    const priceBox = root.querySelector("[data-price-box]");
    if (flashHeader) flashHeader.hidden = !isFlash;
    if (flashTag) flashTag.hidden = !isFlash;
    if (priceSub) priceSub.hidden = !hasPromo;
    if (hasPromo && variant.originalPriceVnd) {
      if (origPriceNode) origPriceNode.textContent = formatPrice(variant.originalPriceVnd);
      if (discountNode) {
        if (variant.originalPriceVnd > variant.priceVnd) {
          const pct = Math.round((1 - variant.priceVnd / variant.originalPriceVnd) * 100);
          discountNode.textContent = `-${pct}%`;
          discountNode.hidden = false;
        } else {
          discountNode.hidden = true;
        }
      }
    } else {
      if (discountNode) discountNode.hidden = true;
    }
    if (priceBox?.classList) priceBox.classList.toggle("is-flash", isFlash);
    if (priceNode?.classList) priceNode.classList.toggle("detail-price-flash", isFlash);
    const promoNote = root.querySelector("[data-selected-promotion]");
    if (promoNote) { promoNote.innerHTML = variant.promotion ? `<strong class="promotion-badge">${variant.promotion.type==='flash'?'Flash Sale':'Ưu đãi'}</strong> · Giá bán: <span class="promotion-sale-price">${formatPrice(variant.priceVnd)}</span> (Giá gốc: <del>${formatPrice(variant.originalPriceVnd)}</del>) · Kết thúc ${new Date(variant.promotion.endsAt).toLocaleString('vi-VN')}` : ''; promoNote.hidden = !variant.promotion; }
    root.querySelector("[data-stock-note]").textContent = Number(variant.stockQuantity) > 0 ? "Còn hàng" : "Hết hàng";
    const button = root.querySelector("[data-add-to-cart]");
    button.dataset.addToCart = variant.id;
    button.disabled = variant.stockQuantity === 0;
    const buyNow=root.querySelector("[data-buy-now]");buyNow.dataset.buyNow=variant.id;buyNow.disabled=variant.stockQuantity===0;
    root.querySelectorAll("[data-option-group]").forEach(b=>b.setAttribute("aria-pressed",String(variant.options?.[b.dataset.optionGroup]===b.dataset.optionValue)));
    root.querySelectorAll("[data-visual-variant]").forEach(b=>b.setAttribute("aria-pressed",String(variant.id===b.dataset.visualVariant)));
    const image=root.querySelector("[data-product-main-image]"),art=window.GAERUProductArtwork?.variantImage?.(product,variant)||{url:variant.imageUrl||product.imageUrl};if(window.GAERUProductArtwork?.updateImage)window.GAERUProductArtwork.updateImage(image,safeProductImage(art.url),{micCount:art.micCount});else image.src=safeProductImage(art.url);image.alt=variant.name+" · "+product.name;root.querySelectorAll("[data-gallery-image]").forEach(b=>b.setAttribute("aria-pressed",String(art.micCount!==1&&b.dataset.galleryImage===art.url))); updateAllBundleCards(variant.id);
  });
  const targetVariantId = searchParams.get("variant");
  const initialVariant = targetVariantId ? variants.find(v => v.id === targetVariantId) : null;
  if (initialVariant && selector && typeof selector.dispatchEvent === 'function') {
    selector.value = initialVariant.id;
    try {
      const evt = typeof Event === 'function' ? new Event("change") : { type: "change" };
      selector.dispatchEvent(evt);
    } catch (_) {}
  }
  let galleryTouch=null;
  root.addEventListener('touchstart',event=>{galleryTouch=event.touches.length===1&&event.target.closest('[data-product-main-image]')?{x:event.touches[0].clientX,y:event.touches[0].clientY}:null;},{passive:true});
  root.addEventListener('touchcancel',()=>{galleryTouch=null;},{passive:true});
  root.addEventListener('touchend',event=>{const start=galleryTouch;galleryTouch=null;if(!start||event.changedTouches.length!==1)return;const dx=event.changedTouches[0].clientX-start.x,dy=event.changedTouches[0].clientY-start.y;if(Math.abs(dx)<40||Math.abs(dx)<Math.abs(dy)*1.5)return;const buttons=[...root.querySelectorAll('[data-gallery-image]')];if(buttons.length<2)return;const current=buttons.findIndex(b=>b.getAttribute('aria-pressed')==='true');const next=buttons[(Math.max(0,current)+(dx<0?1:-1)+buttons.length)%buttons.length];next.click();const rail=next.parentElement;rail.scrollTo({left:Math.max(0,next.offsetLeft-rail.offsetLeft-(rail.clientWidth-next.offsetWidth)/2),behavior:'smooth'});},{passive:true});
  root.addEventListener("click",e=>{const imageButton=e.target.closest("[data-gallery-image]");if(imageButton){const mainImage=root.querySelector("[data-product-main-image]");if(window.GAERUProductArtwork?.updateImage)window.GAERUProductArtwork.updateImage(mainImage,safeProductImage(imageButton.dataset.galleryImage));else mainImage.src=safeProductImage(imageButton.dataset.galleryImage);root.querySelectorAll("[data-gallery-image]").forEach(b=>b.setAttribute("aria-pressed",String(b===imageButton)));return;}const option=e.target.closest("[data-option-group]"),direct=e.target.closest("[data-visual-variant]");if(!option&&!direct)return;const current=variants.find(v=>v.id===selector.value);const next=direct?variants.find(v=>v.id===direct.dataset.visualVariant):window.GAERUVariantChoices.choose(variants,current,option.dataset.optionGroup,option.dataset.optionValue);if(next){selector.value=next.id;selector.dispatchEvent(new Event("change"));}}); window.GAERUK9Loop?.mountHome(); void loadAndRenderBundles(product, selector?.value);
  try {
    const curVariant = variants.find(v => v.id === selector?.value) || variants[0];
    window.GAERUAnalytics?.trackViewItem?.(product, curVariant);
  } catch (_) {}
  try { document.dispatchEvent(new CustomEvent("gaeru:products-rendered", { detail: { product } })); } catch (_) {}
}

function shippingPresentation(settings) {
  const rates=settings?.shippingRates || {};
  const isNationwide=name=>window.GAERUCheckout?.cityKey
    ? window.GAERUCheckout.cityKey(name)==="toan quoc"
    : /^toàn\s+quốc$/i.test(String(name).trim());
  const hasNationwide=Object.keys(rates).some(isNationwide);
  const freeNationwide=hasNationwide && Object.values(rates).every(fee=>fee===0);
  const note=String(settings?.shippingNote||"").trim();
  const base=freeNationwide ? "Miễn phí giao hàng toàn quốc." : "Phí giao hàng được tính theo tỉnh/thành phố đã chọn.";
  const freePolicy=/^miễn phí (?:vận chuyển|giao hàng) (?:trên )?toàn quốc[.!;]*$/iu;
  const regionalPolicy=/^phí (?:vận chuyển|giao hàng) (?:được )?tính theo tỉnh\/thành phố(?: đã chọn)?[.!;]*$/iu;
  // Discard only whole stock phrases. Keep merchant instructions and qualified offers.
  const details=note.replace(/([.!?;])[^\S\r\n]+/gu,"$1\n").split(/[\r\n]+/).filter(sentence=>{
    const normalized=sentence.trim().normalize("NFC").replace(/\s+/gu," ");
    return normalized && !freePolicy.test(normalized) && !regionalPolicy.test(normalized);
  }).join(" ").trim();
  const helper=details ? (freeNationwide ? base+" "+details : details) : base;
  return {isNationwide,hasNationwide,freeNationwide,helper,badge:freeNationwide ? "Miễn phí · 0 ₫" : "Tính tại thanh toán"};
}
let cartShippingRequest=null,cartShippingExpires=0;
function updateCartShipping(root) {
  const badge=root.querySelector("[data-cart-shipping]"),helper=root.querySelector("[data-cart-shipping-note]");
  if(!badge || !helper) return;
  if(!cartShippingRequest || Date.now()>=cartShippingExpires) {
    cartShippingExpires=Date.now()+60000;
    cartShippingRequest=apiRequest("/api/settings/public",{gaeruBackground:true})
      .catch(error=>{cartShippingRequest=null;throw error;});
  }
  const apply=settings=>{
    if(!root.contains(badge)) return;
    const shipping=shippingPresentation(settings);
    badge.textContent=shipping.badge;
    helper.textContent=shipping.helper;
  };
  cartShippingRequest.then(apply).catch(()=>apply({}));
}

function renderCart() {
  const root = document.querySelector("#cart-content");
  if (!root) return;
  const rows = cartRows(readCart());
  const pageHeading = document.querySelector("[data-cart-page-heading]") || document.querySelector(".page-intro h1");
  if (!rows.length) {
    if (pageHeading) pageHeading.textContent = "Giỏ hàng của bạn đang trống";
    const quickItems = (Array.isArray(products) && products.length
      ? products.filter((p) => p.active !== false && p.slug).slice(0, 5).map((p) => ({ slug: p.slug, label: p.cardTitle || p.name }))
      : [
          { slug: "gaeru-m3", label: "GAERU M3" },
          { slug: "gaeru-k9", label: "GAERU K9" },
          { slug: "gaeru-g1-ultra", label: "GAERU G1 ULTRA" },
          { slug: "gaeru-p01", label: "GAERU P01" },
          { slug: "gaeru-p185", label: "GAERU P185" }
        ]);
    root.innerHTML = `<div class="empty-cart"><span class="empty-cart-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg></span><h2>Chưa có thiết bị nào trong giỏ hàng.</h2><p>Khám phá các thiết bị thu âm &amp; ghi hình GAERU chính hãng để bắt đầu câu chuyện tiếp theo của bạn.</p><a class="button button-blue" href="/cua-hang">Đi đến cửa hàng</a><nav class="empty-cart-quicklinks" aria-label="Gợi ý thiết bị nổi bật"><span>Gợi ý thiết bị nổi bật</span>${quickItems.map((it) => `<a href="/san-pham/${encodeURIComponent(it.slug)}">${escapeHtml(it.label)}</a>`).join("")}</nav></div>`;
    return;
  }
  if (pageHeading) pageHeading.textContent = "Gần xong rồi.";
  const availableRows = rows.filter(item => item.variant.stockQuantity > 0);
  const hasOutOfStock = availableRows.length < rows.length;
  const total = availableRows.reduce((sum, item) => sum + item.variant.priceVnd * item.quantity, 0);
  root.innerHTML = `
    <div class="cart-items">
      ${rows.map(({ variantId, quantity, product, variant }) => {
        const itemImg = variant.imageUrl || product.imageUrl;
        const pHref = `/san-pham/${encodeURIComponent(product.slug)}`;
        return `
        <article class="cart-item${variant.stockQuantity ? "" : " is-out-of-stock"}">
          <a class="cart-item-image" href="${pHref}">${(img=>window.GAERUProductArtwork?.picture?.(img,itemImg,'thumb')||img)(`<img src="${escapeHtml(itemImg)}" ${window.GAERUProductArtwork?.attributes?.(itemImg,'thumb')||''} alt="${escapeHtml(product.imageAlt||product.name)}" width="120" height="120" loading="lazy" decoding="async">`)}</a>
          <div class="cart-item-info">
            <h2><a href="${pHref}">${escapeHtml(product.cardTitle||product.name)}</a></h2>
              <p>${escapeHtml(formatDisplayLabel(variant.name))} · ${escapeHtml(variant.sku)} · <span class="vnd-amount">${formatPrice(variant.priceVnd)}</span>${variant.stockQuantity ? "" : " · Hết hàng"}</p>
            <button class="remove-item" type="button" data-remove="${escapeHtml(variantId)}">Xóa</button>
          </div>
          <label class="visually-hidden" for="quantity-${escapeHtml(variantId)}">Số lượng ${escapeHtml(product.name)} ${escapeHtml(formatDisplayLabel(variant.name))}</label>
          <input class="quantity-input" id="quantity-${escapeHtml(variantId)}" type="number" min="1" max="${Math.max(1, Math.min(99, variant.stockQuantity))}" value="${quantity}" data-quantity="${escapeHtml(variantId)}" ${variant.stockQuantity ? "" : "disabled"}>
          <strong class="cart-line-total">${variant.stockQuantity ? formatPrice(variant.priceVnd * quantity) : "Hết hàng"}</strong>
        </article>`;
      }).join("")}
    </div>
    <aside class="cart-summary">
      <h2>Tóm tắt đơn hàng</h2>
      <p><span>Tạm tính</span><strong>${formatPrice(total)}</strong></p>
      <p data-cart-bundle-row hidden><span>Ưu đãi combo</span><strong data-cart-bundle-discount>−0 ₫</strong></p>
      <p><span>Giao hàng</span><span data-cart-shipping aria-live="polite">Đang kiểm tra…</span></p>
      <p class="summary-total"><span>Tổng tạm tính</span><strong data-cart-subtotal-final>${formatPrice(total)}</strong></p>
      ${hasOutOfStock ? '<p class="prototype-note" style="color:#c14343;">Một số sản phẩm trong giỏ đã hết hàng và sẽ không được tính vào đơn thanh toán.</p>' : ''}
      <p class="prototype-note" data-cart-shipping-note></p>
      ${availableRows.length ? '<a class="button button-blue" href="/thanh-toan">Nhập thông tin đặt hàng</a>' : '<button class="button button-blue" type="button" disabled>Chưa có sản phẩm còn hàng</button>'}
      <a class="continue-shopping" href="/cua-hang">Tiếp tục mua sắm</a>
    </aside>`;
  updateCartShipping(root);
  if (availableRows.length >= 2) {
    apiRequest("/api/bundles/quote", {
      method: "POST",
      body: JSON.stringify({ items: availableRows.map(({ variantId, quantity }) => ({ variantId, quantity })) }),
      gaeruBackground: true
    }).then(q => {
      const disc = Number(q?.totalBundleDiscountVnd || 0);
      if (disc > 0) {
        const rowEl = root.querySelector("[data-cart-bundle-row]");
        const discEl = root.querySelector("[data-cart-bundle-discount]");
        const finalEl = root.querySelector("[data-cart-subtotal-final]");
        if (rowEl) rowEl.hidden = false;
        if (discEl) discEl.textContent = "−" + formatPrice(disc);
        if (finalEl) finalEl.textContent = formatPrice(Math.max(0, total - disc));
      }
    }).catch(() => {});
  }
}

async function ensureCheckoutDependencies() {
  if (typeof document === "undefined" || !document.head) return;
  const ensureCss = (href) => {
    if (document.querySelector(`link[href^="${href.split("?")[0]}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
  };
  const ensureJs = (src, check) => {
    if (check()) return Promise.resolve();
    return new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = src;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => resolve();
      document.head.append(s);
    });
  };
  if (typeof window !== "undefined" && !window.GAERUCheckout && typeof navigator !== "undefined") {
    await ensureJs("/checkout-flow.js?v=20261124-quick-cart-v2", () => Boolean(window.GAERUCheckout));
  }
  if (typeof window !== "undefined" && !window.GAERUAddress && typeof navigator !== "undefined") {
    ensureCss("/vietnam-address.css?v=20261026-unified-ui");
    await ensureJs("/vietnam-address.js?v=20261026-unified-ui", () => Boolean(window.GAERUAddress));
  }
}

let displayedCheckoutOwner=null, checkoutIdentityVersion=0;
function resetCheckoutForNewOwner(){
  const next=cartOwner();
  if(displayedCheckoutOwner===null || next===displayedCheckoutOwner) return;
  displayedCheckoutOwner=next;
  checkoutIdentityVersion++;
  const root=document.querySelector("#checkout-content");
  if(root){root.replaceChildren();void renderCheckout().catch(showStoreError);}
}
async function renderCheckout() {
  const root = document.querySelector("#checkout-content");
  if (!root) return;
  const formOwner=cartOwner(),identityVersion=checkoutIdentityVersion;
  const belongsToFormOwner=()=>cartOwner()===formOwner && checkoutIdentityVersion===identityVersion;
  displayedCheckoutOwner=formOwner;
  await ensureCheckoutDependencies();
  if(!belongsToFormOwner() || await restorePendingOrder(root) || !belongsToFormOwner()) return;

  const urlParams = typeof window !== "undefined" && window.location ? new URLSearchParams(window.location.search) : null;
  const recoveryToken = urlParams ? urlParams.get("recovery_token") : null;
  let recoveredCart = null;
  let recoveredItemsApplied = false;
  if (recoveryToken) {
    try {
      const resp = await apiRequest(`/api/abandoned-cart/recover/${encodeURIComponent(recoveryToken)}`);
      if (!belongsToFormOwner()) return;
      if (resp?.cart) {
        recoveredCart = resp.cart;
        if (Array.isArray(resp.cart.items) && resp.cart.items.length > 0) {
          const currentCart = readCart();
          if (!currentCart.length) {
            writeCart(resp.cart.items.map(it => ({ variantId: it.variantId, quantity: it.quantity })));
            recoveredItemsApplied = true;
          }
        }
      }
    } catch (e) {
      console.warn("Khôi phục giỏ hàng qua recovery_token thất bại:", e);
    }
  }

  if(!belongsToFormOwner()) return;
  const purchase=window.GAERUCheckout.selection(products,location.search);
  const allRows = cartRows(purchase.direct?purchase.items:readCart());
  const rows = allRows.filter(item => item.variant.stockQuantity > 0);
  const skippedOutOfStock = allRows.length - rows.length;
  if (!rows.length) {
    root.innerHTML = `<div class="empty-cart"><h2>${purchase.direct?"Phiên bản này hiện không còn hàng hoặc không còn được bán.":(skippedOutOfStock?"Các sản phẩm trong giỏ hàng hiện đã tạm hết hàng.":"Chưa có sản phẩm để đặt hàng.")}</h2><a class="button button-blue" href="shop.html">Quay lại cửa hàng</a></div>`;
    return;
  }
  const total = rows.reduce((sum, item) => sum + item.variant.priceVnd * item.quantity, 0);
  try {
    window.GAERUAnalytics?.trackBeginCheckout?.(
      rows.map(r => ({
        variantId: r.variant.id,
        sku: r.variant.sku,
        name: `${r.product.name} - ${r.variant.name}`,
        category: r.product.category,
        priceVnd: r.variant.priceVnd,
        quantity: r.quantity
      })),
      total
    );
  } catch (_) {}
  // Bind this form to the actual cookie session, including anonymous sessions.
  // A CSRF token from a regenerated session must never be substituted on retry.
  const formCsrf=apiRequest("/api/csrf",{gaeruBackground:true}).then(data=>data.csrfToken||null).catch(()=>null);
  let settingsError = "";
  try {
    storeSettings = await apiRequest("/api/settings/public");
  } catch (error) {
    settingsError = error.message;
  }
  if(!belongsToFormOwner()) return;
  const shippingRates = storeSettings.shippingRates || {};
  const {isNationwide,hasNationwide,freeNationwide,helper:shippingHelp}=shippingPresentation(storeSettings);
  let provinces = Object.keys(shippingRates).filter(p => !isNationwide(p)).sort((left, right) => left.localeCompare(right, "vi"));
  if (hasNationwide && !provinces.length) {
    provinces = ['Hà Nội','Hải Phòng','Huế','Đà Nẵng','Hồ Chí Minh','Cần Thơ','An Giang','Bắc Ninh','Cà Mau','Cao Bằng','Đắk Lắk','Điện Biên','Đồng Nai','Đồng Tháp','Gia Lai','Hà Tĩnh','Hưng Yên','Khánh Hòa','Lai Châu','Lâm Đồng','Lạng Sơn','Lào Cai','Nghệ An','Ninh Bình','Phú Thọ','Quảng Ngãi','Quảng Ninh','Quảng Trị','Sơn La','Tây Ninh','Thái Nguyên','Thanh Hóa','Tuyên Quang','Vĩnh Long'].sort((a,b)=>a.localeCompare(b,'vi'));
  }
  const paymentMethods = storeSettings.paymentMethods || ["cod"];
  const shippingCarriers=storeSettings.shippingCarriers||[];
  if (settingsError || !storeSettings.ordersEnabled || (!provinces.length && !hasNationwide)) {
    const noticeTitle = settingsError
      ? "Chưa thể xác nhận trạng thái đặt hàng."
      : !storeSettings.ordersEnabled
        ? "GAERU đang tạm dừng tiếp nhận đơn hàng trực tuyến."
        : "Phí giao hàng chưa được cấu hình.";
    const noticeDescription = settingsError
      ? " Vui lòng thử lại sau hoặc liên hệ GAERU để được hỗ trợ."
      : !storeSettings.ordersEnabled
        ? " Việc đặt hàng sẽ được mở lại sau khi hoàn tất các thủ tục cần thiết. Sản phẩm trong giỏ vẫn được lưu trên thiết bị của bạn."
        : " GAERU đang cập nhật khu vực giao hàng. Sản phẩm trong giỏ vẫn được lưu trên thiết bị của bạn.";
    root.innerHTML = `
      <div class="checkout-layout">
        <div class="checkout-notice" role="${settingsError ? "alert" : "status"}">
          <strong>${noticeTitle}</strong>${noticeDescription}
          <p><a href="privacy.html">Chính sách quyền riêng tư</a> · <a href="support.html#contact">Liên hệ GAERU</a></p>
        </div>
        <aside class="checkout-summary cart-summary">
          <h2>Đơn hàng</h2>
          ${rows.map(({ quantity, product, variant }) => `
            <p class="checkout-product"><span>${escapeHtml(product.name)}<br><small>${escapeHtml(variant.name)} × ${quantity}</small></span><strong>${formatPrice(variant.priceVnd * quantity)}</strong></p>`).join("")}
          <p class="summary-total"><span>Tạm tính</span><strong>${formatPrice(total)}</strong></p>
          <p class="prototype-note">${escapeHtml(shippingHelp)}</p>
          <a class="continue-shopping" href="shop.html">Tiếp tục mua sắm</a>
        </aside>
      </div>`;
    return;
  }
  root.classList.remove("checkout-single");
  root.classList.add("checkout-two-col");
  const PAYMENT_CARD_META = {
    cod: {
      title: "Thanh toán khi nhận hàng (COD)",
      sub: "Kiểm tra sản phẩm và thanh toán tiền mặt khi nhận hàng",
      badge: "",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7h13v10H2z"/><path d="M15 10h4l3 3v4h-7z"/><circle cx="6.5" cy="18" r="2"/><circle cx="18.5" cy="18" r="2"/></svg>'
    },
    bank_transfer: {
      title: "Chuyển khoản nhanh VietQR",
      sub: "Quét mã QR ngân hàng, hệ thống tự động duyệt đơn tức thì",
      badge: "Tự động",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M20 14v3h-2"/><path d="M14 20h7"/></svg>'
    },
    vnpay: {
      title: "Cổng thanh toán VNPAY",
      sub: "Thẻ ATM nội địa, Visa/Mastercard &amp; quét VNPAY-QR",
      badge: "",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/></svg>'
    },
    momo: {
      title: "Ví điện tử MoMo",
      sub: "Chuyển hướng an toàn sang ứng dụng Ví MoMo",
      badge: "",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M16 12h2"/><path d="M3 9h18"/></svg>'
    },
    zalopay: {
      title: "Ví điện tử ZaloPay",
      sub: "Thanh toán nhanh chóng qua ứng dụng ZaloPay",
      badge: "",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>'
    }
  };
  const enabledPayList = ["cod", "bank_transfer", "vnpay", "momo", "zalopay"].filter((m) => paymentMethods.includes(m));
  const initialPayMethod = enabledPayList[0] || "cod";
  root.innerHTML = `
    ${recoveredItemsApplied ? '<div class="checkout-recovered-banner" role="status" style="background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;padding:12px 16px;border-radius:10px;margin-bottom:4px;font-size:13.5px;display:flex;align-items:center;gap:10px;"><span style="font-size:18px;font-weight:bold;">✓</span><span><strong>Giỏ hàng của bạn đã được khôi phục thành công!</strong> GAERU đã tải lại sản phẩm và thông tin của bạn.</span></div>' : ''}
    ${skippedOutOfStock > 0 ? '<div class="checkout-notice" role="status" style="color:#9a3412;border-color:#fed7aa;background:#fff7ed;">Một số phiên bản đã hết hàng trong giỏ đã được bỏ qua khỏi đơn thanh toán này.</div>' : ''}
    <form class="checkout-form" id="checkout-form">
      <div class="checkout-notice" role="status"><strong>Đơn hàng được xử lý trực tiếp bởi GAERU.</strong>${freeNationwide ? "" : " Chọn tỉnh/thành phố để xem phí giao hàng."}</div>
      <label class="saved-address-label" data-saved-address-label hidden>Địa chỉ đã lưu<select data-saved-address><option value="">Nhập địa chỉ mới</option></select></label><p class="address-status" data-address-status role="status"></p>
      <details class="checkout-contact-details" data-contact-details open><summary>Thông tin giao hàng<span data-contact-summary></span></summary>
      <div class="form-section">
        <h2>Thông tin liên hệ</h2>
        <label>Họ và tên<input name="name" autocomplete="name" required maxlength="120" placeholder="Họ và tên người nhận"></label>
        <div class="form-row">
          <label>Email<input type="email" name="email" autocomplete="email" required maxlength="254" placeholder="Ví dụ: ban@email.com"></label>
          <label>Số điện thoại<input type="tel" name="phone" autocomplete="tel" required maxlength="20" placeholder="Ví dụ: 0912 345 678"></label>
        </div>

      </div>
      <div class="form-section">
        <h2>Địa chỉ giao hàng</h2>
        <label>Địa chỉ<input name="address" autocomplete="street-address" required maxlength="250" placeholder="Số nhà, tên đường, thôn / tổ dân phố"></label>
        <div class="form-row">
          <label>Tỉnh / thành phố<input name="city" autocomplete="address-level1" required maxlength="120" list="checkout-cities" placeholder="Chọn tỉnh / thành, phường / xã"><datalist id="checkout-cities">${provinces.filter(p=>!isNationwide(p)).map(p=>`<option value="${escapeHtml(p)}"></option>`).join('')}</datalist></label>
          <label class="checkout-note"><span class="checkout-field-title">Ghi chú <small>(không bắt buộc)</small></span><input name="note" maxlength="1000" placeholder="Ghi chú giao hàng (nếu có)"></label>
        </div>
      </div>
      </details>
      ${shippingCarriers.length?`<section class="form-section checkout-carrier"><h2>Đơn vị vận chuyển</h2><label>Chọn hãng giao hàng<select name="shippingCarrierId" required><option value="">Chọn đơn vị vận chuyển</option>${shippingCarriers.map(carrier=>`<option value="${escapeHtml(carrier.id)}">${escapeHtml(carrier.name)}</option>`).join('')}</select></label>${freeNationwide ? "" : '<p class="prototype-note">Phí giao hàng hiển thị theo địa chỉ và bảng phí của GAERU.</p>'}</section>`:''}
      <div class="form-section">
        <h2>Phương thức thanh toán</h2>
        <div class="payment-method-cards" role="radiogroup" aria-label="Chọn phương thức thanh toán">
          ${enabledPayList.map((code) => {
            const meta = PAYMENT_CARD_META[code];
            const active = code === initialPayMethod;
            return `<button type="button" class="payment-method-card${active ? " is-selected" : ""}" role="radio" aria-checked="${active ? "true" : "false"}" data-payment-card="${code}"><span class="payment-card-icon" aria-hidden="true">${meta.icon}</span><span class="payment-card-body"><span class="payment-card-title">${meta.title}${meta.badge ? `<span class="payment-card-badge">${meta.badge}</span>` : ""}</span><span class="payment-card-sub">${meta.sub}</span></span><span class="payment-card-radio" aria-hidden="true">✓</span></button>`;
          }).join("")}
        </div>
        <label class="visually-hidden">
          Phương thức thanh toán
          <select name="paymentMethod" class="visually-hidden-select" aria-label="Phương thức thanh toán">
            ${paymentMethods.includes("cod") ? '<option value="cod">Thanh toán khi nhận hàng (COD)</option>' : ""}
            ${paymentMethods.includes("bank_transfer") ? '<option value="bank_transfer">Chuyển khoản nhanh VietQR</option>' : ""}
            ${paymentMethods.includes("vnpay") ? '<option value="vnpay">Thanh toán trực tuyến qua VNPAY</option>' : ""}
            ${paymentMethods.includes("momo") ? '<option value="momo">Ví điện tử MoMo</option>' : ""}
            ${paymentMethods.includes("zalopay") ? '<option value="zalopay">Ví điện tử ZaloPay</option>' : ""}
          </select>
        </label>
        <p class="payment-placeholder" data-payment-help>GAERU sẽ xác nhận đơn hàng trước khi gửi.</p>
      </div>
      <p class="checkout-account-notice">Khi đặt hàng, GAERU tạo tài khoản theo email nếu bạn chưa có tài khoản và gửi hướng dẫn đặt mật khẩu. Bạn không tự động đăng ký nhận tin quảng cáo.</p><p class="checkout-privacy-notice">Thông tin bạn cung cấp được sử dụng để tiếp nhận và xử lý đơn hàng theo <a href="/chinh-sach/quyen-rieng-tu">Chính sách quyền riêng tư</a>. <a href="/chinh-sach/dieu-khoan">Điều khoản mua hàng</a>.</p>
      <label class="checkout-recovery-consent"><input type="checkbox" name="recoveryConsent" id="checkout-recovery-consent"><span>Tôi đồng ý lưu tên, email, số điện thoại và sản phẩm trong giỏ để GAERU gửi email nhắc khi chưa hoàn tất đơn.</span></label>
      <p role="status" data-recovery-status></p><button type="button" class="secondary-button" data-recovery-retry hidden>Thử lại yêu cầu nhắc giỏ</button>
      <button class="button button-blue" type="submit">Đặt hàng</button>
      <p class="checkout-feedback" id="checkout-feedback" aria-live="polite"></p>
    </form>
    <aside class="checkout-summary cart-summary" aria-label="Tóm tắt đơn hàng">
      <h2>Đơn hàng</h2>
      <div class="checkout-item-list">
        ${rows.map(({ quantity, product, variant }) => {
          const thumbUrl = safeProductImage(variant.imageUrl || product.imageUrl);
          return `<div class="checkout-item-row"><span class="checkout-item-thumb"><img src="${escapeHtml(thumbUrl)}" alt="" width="44" height="44" loading="lazy" decoding="async"></span><span class="checkout-item-meta"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(formatDisplayLabel(variant.name))} × ${quantity}</small></span><strong class="checkout-item-total">${formatPrice(variant.priceVnd * quantity)}</strong></div>`;
        }).join("")}
      </div>
      <p class="summary-total"><span>Tạm tính</span><strong>${formatPrice(total)}</strong></p>
      <p class="checkout-product checkout-bundle-discount" data-checkout-bundle-row hidden><span>Giảm giá combo</span><strong data-checkout-bundle-discount>−0 ₫</strong></p>
      <p class="checkout-product"><span>Giao hàng</span><strong data-checkout-shipping>${freeNationwide ? "0 ₫" : "Chưa tính phí"}</strong></p>
      <section class="checkout-voucher"><label class="visually-hidden" for="checkout-voucher-code">Mã giảm giá</label><input id="checkout-voucher-code" maxlength="40" placeholder="Nhập mã giảm giá" autocomplete="off"><button class="secondary-button" type="button" data-voucher-apply aria-label="Kiểm tra voucher" title="Kiểm tra voucher">✓</button><button class="secondary-button" type="button" data-voucher-wallet>Ví mã ↗</button><p role="status" data-voucher-feedback></p></section><p class="checkout-product checkout-discount"><span>Giảm giá voucher</span><strong data-checkout-discount>0 ₫</strong></p>
      <section class="checkout-loyalty" data-checkout-loyalty hidden><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px dashed #d2d2d7;margin-top:8px;"><label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;"><input type="checkbox" id="checkout-use-loyalty"><span>Dùng <strong data-loyalty-available>0</strong> GAERU Xu</span></label><span style="font-size:12px;color:#15803d;font-weight:600;" data-loyalty-discount-text>−0 ₫</span></div></section>
      <p class="summary-total"><span>Tổng cộng</span><strong data-checkout-total>${formatPrice(total)}${freeNationwide ? "" : " + phí giao hàng"}</strong></p>
      <p class="prototype-note">${escapeHtml(shippingHelp)}</p>
    </aside>
`;

  window.GAERUAddress?.enhance(root);
  const shortenAddressPlaceholder = () => {
    root.querySelectorAll?.(".vn-address-choice").forEach((inp) => {
      if (inp.placeholder && inp.placeholder.length > 28) inp.placeholder = "Chọn tỉnh / thành, phường / xã";
    });
  };
  shortenAddressPlaceholder();
  window.GAERUAddress?.loadData?.().then(shortenAddressPlaceholder).catch(() => {});
  const form = root.querySelector("#checkout-form");
  if (recoveredCart) {
    if (recoveredCart.customerName && form.elements.name && !form.elements.name.value) {
      form.elements.name.value = recoveredCart.customerName;
    }
    if (recoveredCart.email && form.elements.email && !form.elements.email.value) {
      form.elements.email.value = recoveredCart.email;
    }
    if (recoveredCart.phone && form.elements.phone && !form.elements.phone.value) {
      form.elements.phone.value = recoveredCart.phone;
    }
  }

  window.GAERUCheckout.bindRecoveryConsent(form, rows.map(({variantId, quantity}) => ({variantId, quantity})), apiRequest);
  const paymentMethod = form.elements.paymentMethod;
  const paymentHelp = form.querySelector("[data-payment-help]");
  let voucherDiscount=0,appliedVoucher="",bundleDiscount=0;
  let loyaltyPoints = 0, loyaltyDiscount = 0, loyaltyLoadedForId = null;
  const loyaltySection = root.querySelector("[data-checkout-loyalty]");
  const loyaltyCheckbox = root.querySelector("#checkout-use-loyalty");
  const loyaltyAvailable = root.querySelector("[data-loyalty-available]");
  const loyaltyText = root.querySelector("[data-loyalty-discount-text]");
  const updateLoyaltyDiscount = () => {
    const remainingProductSubtotal = Math.max(0, total - bundleDiscount - voucherDiscount);
    if (loyaltyCheckbox?.checked && loyaltyPoints > 0 && remainingProductSubtotal > 0) {
      const maxAllowed = Math.floor(total * 0.5);
      loyaltyDiscount = Math.min(loyaltyPoints, maxAllowed, remainingProductSubtotal);
      if (loyaltyText) loyaltyText.textContent = "−" + formatPrice(loyaltyDiscount);
    } else {
      loyaltyDiscount = 0;
      if (loyaltyText) loyaltyText.textContent = "−0 ₫";
    }
  };
  const updateShippingTotal = () => {
    updateLoyaltyDiscount();
    const fee = freeNationwide ? 0 : window.GAERUCheckout.shippingFee(shippingRates,form.elements.city.value);
    const netProductTotal = Math.max(0, total - bundleDiscount - voucherDiscount - loyaltyDiscount);
    root.querySelector("[data-checkout-shipping]").textContent =
      fee === undefined ? "Chưa tính phí" : formatPrice(fee);
    root.querySelector("[data-checkout-total]").textContent =
      fee === undefined ? formatPrice(netProductTotal)+" + phí giao hàng" : formatPrice(netProductTotal + fee);
  };
  if (rows.length >= 2) {
    apiRequest("/api/bundles/quote", {
      method: "POST",
      body: JSON.stringify({ items: rows.map(({ variantId, quantity }) => ({ variantId, quantity })) }),
      gaeruBackground: true
    }).then(q => {
      const disc = Number(q?.totalBundleDiscountVnd || 0);
      if (disc > 0) {
        bundleDiscount = disc;
        const bRow = root.querySelector("[data-checkout-bundle-row]");
        const bEl = root.querySelector("[data-checkout-bundle-discount]");
        if (bRow) bRow.hidden = false;
        if (bEl) bEl.textContent = "−" + formatPrice(bundleDiscount);
        updateShippingTotal();
      }
    }).catch(() => {});
  }
  const voucherInput=root.querySelector('#checkout-voucher-code'),voucherFeedback=root.querySelector('[data-voucher-feedback]');
  const resetVoucher=()=>{voucherDiscount=0;appliedVoucher='';root.querySelector('[data-checkout-discount]').textContent=formatPrice(0);updateShippingTotal();};
  let voucherRevision=0,voucherTimer;
  const validateVoucher=async({silentError=false}={})=>{const revision=++voucherRevision,code=voucherInput.value.trim().toUpperCase();if(!code)return false;try{const quote=await apiRequest('/api/customer/marketing/quote',{method:'POST',body:JSON.stringify({code,items:rows.map(({variantId,quantity})=>({variantId,quantity}))}),...(silentError?{gaeruBackground:true}:{})});if(revision!==voucherRevision||voucherInput.value.trim().toUpperCase()!==code)return false;if(quote.subtotalVnd!==total)throw Error('Giá đã thay đổi. Tải lại trang trước khi áp dụng.');appliedVoucher=quote.code;voucherDiscount=quote.discountVnd;root.querySelector('[data-checkout-discount]').textContent='−'+formatPrice(voucherDiscount);voucherFeedback.textContent=quote.message;if(window.GAERUNotify?.toast)window.GAERUNotify.toast(quote.message,'success');updateShippingTotal();return true;}catch(error){if(revision===voucherRevision){resetVoucher();voucherFeedback.textContent=error.message;if(!silentError&&window.GAERUNotify?.toast)window.GAERUNotify.toast(error.message,'error');}return false;}};
  voucherInput.addEventListener('input',()=>{voucherRevision++;clearTimeout(voucherTimer);resetVoucher();voucherFeedback.textContent='';if(voucherInput.value.trim())voucherTimer=setTimeout(()=>validateVoucher({silentError:true}),650);});
  voucherInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();clearTimeout(voucherTimer);void validateVoucher();}});
  root.querySelector('[data-voucher-wallet]').addEventListener('click',event=>{window.GAERUVoucherWallet?.open({request:apiRequest,total,opener:event.currentTarget,onSelect:async code=>{voucherRevision++;clearTimeout(voucherTimer);voucherInput.value=code;resetVoucher();voucherFeedback.textContent='';if(!code)return {ok:true};const ok=await validateVoucher();return {ok,message:voucherFeedback.textContent};}});});
  root.querySelector('[data-voucher-apply]').addEventListener('click',async()=>{clearTimeout(voucherTimer);return validateVoucher();});
  let loyaltyRequestVersion=0;
  const loadCheckoutLoyalty = () => {
    const custId=window.GAERUCustomerSession?.customer?.id || null;
    if(custId===loyaltyLoadedForId) return;
    const version=++loyaltyRequestVersion;
    loyaltyLoadedForId=custId;
    loyaltyPoints=0;
    if(loyaltyCheckbox) loyaltyCheckbox.checked=false;
    if(loyaltySection) loyaltySection.hidden=true;
    if(loyaltyAvailable) loyaltyAvailable.textContent="0";
    updateShippingTotal();
    if(!custId) return;
    apiRequest("/api/customer/loyalty",{gaeruBackground:true}).then(data=>{
      if(!form.isConnected || version!==loyaltyRequestVersion || window.GAERUCustomerSession?.customer?.id!==custId) return;
      loyaltyPoints=Math.max(0,Number(data?.loyalty?.pointsBalance)||0);
      if(loyaltySection) loyaltySection.hidden=loyaltyPoints===0;
      if(loyaltyAvailable) loyaltyAvailable.textContent=new Intl.NumberFormat('vi-VN').format(loyaltyPoints);
      updateShippingTotal();
    }).catch(()=>{if(version===loyaltyRequestVersion) loyaltyLoadedForId=null;});
  };
  loadCheckoutLoyalty();
  const onLoyaltyCustomerUpdated = () => { if (!form.isConnected) { document.removeEventListener("gaeru:customer-updated", onLoyaltyCustomerUpdated); return; } loadCheckoutLoyalty(); };
  document.addEventListener("gaeru:customer-updated", onLoyaltyCustomerUpdated);
  if (loyaltyCheckbox) {
    loyaltyCheckbox.addEventListener("change", () => {
      updateShippingTotal();
    });
  }
  form.addEventListener("input", (e) => { if (e.target?.name) e.target.dataset.userDirty = "1"; });
  form.elements.city.addEventListener("change", updateShippingTotal);
  form.elements.city.addEventListener("input", updateShippingTotal);
  root.shippingRates=shippingRates;
  window.GAERUCheckout.hydrateContact({root,form,request:apiRequest,updateTotal:updateShippingTotal});
  updateShippingTotal();
  const updatePaymentHelp = () => {
    const bank = storeSettings.bankTransfer;
    const map = {
      cod: storeSettings.cod?.instructions || "Thanh toán trực tiếp khi nhận hàng. GAERU sẽ xác nhận đơn trước khi gửi.",
      bank_transfer: bank
        ? `Chuyển khoản tới ${bank.bankName} · STK ${bank.accountNumber} (${bank.accountHolder}) với nội dung theo cú pháp ${bank.transferSyntax}. Giao dịch khớp tự động sẽ duyệt đơn sang Chờ gửi hàng, bỏ qua bước xác nhận.`
        : "Chuyển khoản ngân hàng theo cú pháp mã đơn. Đơn được duyệt tự động sang Chờ gửi hàng ngay khi khớp giao dịch.",
      vnpay: "Bạn sẽ được chuyển tới VNPAY để thanh toán an toàn. Giao dịch thành công sẽ tự động duyệt đơn sang Chờ gửi hàng.",
      momo: "Bạn sẽ được chuyển tới Ví MoMo để thanh toán. Giao dịch thành công sẽ tự động duyệt đơn sang Chờ gửi hàng.",
      zalopay: "Bạn sẽ được chuyển tới Ví ZaloPay để thanh toán. Giao dịch thành công sẽ tự động duyệt đơn sang Chờ gửi hàng."
    };
    paymentHelp.textContent = map[paymentMethod.value] || map.cod;
  };



  const paymentCards = [...(form.querySelectorAll?.("[data-payment-card]") || [])];
  const syncPaymentCards = () => {
    const activeVal = paymentMethod.value;
    for (const cardBtn of paymentCards) {
      const selected = cardBtn.dataset.paymentCard === activeVal;
      cardBtn.classList?.toggle("is-selected", selected);
      cardBtn.setAttribute?.("aria-checked", String(selected));
    }
  };
  for (const cardBtn of paymentCards) {
    cardBtn.addEventListener("click", () => {
      const nextMethod = cardBtn.dataset.paymentCard;
      if (!nextMethod || paymentMethod.value === nextMethod) return;
      paymentMethod.value = nextMethod;
      syncPaymentCards();
      updatePaymentHelp();
      try {
        const Evt = form.ownerDocument?.defaultView?.Event || (typeof Event === "function" ? Event : null);
        if (Evt) paymentMethod.dispatchEvent(new Evt("change", { bubbles: true }));
      } catch (_) {}
    });
    cardBtn.addEventListener("keydown", (e) => {
      if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key) || !paymentCards.length) return;
      e.preventDefault();
      const idx = paymentCards.indexOf(cardBtn);
      const step = (e.key === "ArrowDown" || e.key === "ArrowRight") ? 1 : -1;
      const targetCard = paymentCards[(idx + step + paymentCards.length) % paymentCards.length];
      targetCard?.focus?.();
      targetCard?.click?.();
    });
  }
  // bind paymentMethod change
  paymentMethod.addEventListener("change", () => {
    syncPaymentCards();
    updatePaymentHelp();
  });
  syncPaymentCards();
  updatePaymentHelp();

  let sending=false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if(sending || !belongsToFormOwner())return;
    const submittingOwner=formOwner;
    sending=true;
    const button = form.querySelector('button[type="submit"]');
    const feedback = root.querySelector("#checkout-feedback");
    button.disabled = true;
    feedback.textContent = "Đang gửi yêu cầu đặt hàng…";
    try {
      if (window.GAERUCheckout.shippingFee(shippingRates,form.elements.city.value)===undefined)throw Error("Chưa có phí giao hàng cho tỉnh/thành phố này. Kiểm tra lại địa chỉ.");
      if(shippingCarriers.length&&!form.elements.shippingCarrierId?.value)throw Error('Vui lòng chọn đơn vị vận chuyển.');
      const checkoutCsrf=await formCsrf;
      if(!belongsToFormOwner()) return;
      if(!checkoutCsrf) throw Error("Phiên đặt hàng chưa sẵn sàng. Vui lòng tải lại trang.");
      if(voucherInput.value.trim()&&appliedVoucher!==voucherInput.value.trim().toUpperCase()){clearTimeout(voucherTimer);if(!await validateVoucher())throw Error('Voucher chưa hợp lệ. Kiểm tra hoặc bỏ mã để tiếp tục.');}
      if(!belongsToFormOwner()) return;
      const payload = {
          cartSource:purchase.direct?"direct":"cart",
          customer: {
            name: form.elements.name.value,
            email: form.elements.email.value,
            phone: form.elements.phone.value,
            address: window.GAERUAddress?.getAddress?.(form) || form.elements.address.value,
            city: form.elements.city.value,
            note: form.elements.note.value
          },
          shippingCarrierId:form.elements.shippingCarrierId?.value||undefined,
          expectedShippingFeeVnd:window.GAERUCheckout.shippingFee(shippingRates,form.elements.city.value),
          voucherCode:appliedVoucher||undefined,
          loyaltyPointsToRedeem: (loyaltyCheckbox?.checked && loyaltyDiscount > 0) ? loyaltyDiscount : undefined,
          paymentMethod: paymentMethod.value,
          expectedSubtotalVnd:total,
          items: rows.map(({ variantId, quantity }) => ({ variantId, quantity }))
      };
      const intent=await checkoutIntent(payload);
      if(submittingOwner!=="guest" && !purchase.direct && pendingOrder()?.key!==intent.key) {
        await mergeCartWithServer();
        if(cartOwner()!==submittingOwner || cartOperations(submittingOwner).length) throw Error("Giỏ hàng chưa đồng bộ. Vui lòng thử lại.");
        const currentRows=cartRows(readCart()).filter(i=>i.variant.stockQuantity>0);
        if(quantityChanges(rows,currentRows).length) throw Error("Giỏ hàng đã thay đổi. Vui lòng tải lại trước khi đặt đơn.");
      }
      if(!belongsToFormOwner()) return;
      const pending={key:intent.key,storageKey:intent.storageKey,generation:intent.generation,at:Date.now(),direct:purchase.direct,items:payload.items};
      try { sessionStorage.setItem(pendingOrderKey(submittingOwner),JSON.stringify(pending)); } catch {}
      let result;
      try {
        result=await apiRequest("/api/orders",{method:"POST",headers:{"X-Idempotency-Key":intent.key,"X-Checkout-Customer":submittingOwner},checkoutCsrf,body:JSON.stringify(payload)});
      } catch(error){
        if(error.status && error.status<500 && ![408,409,429].includes(error.status)){
          try {sessionStorage.removeItem(pendingOrderKey(submittingOwner));} catch {}
        }
        throw error;
      }
      await window.GAERUCustomerSession?.refresh?.();
      if(!belongsToFormOwner()) return;
      function finishOrder() {
        intent.complete();
        postOrderCart(submittingOwner,intent.key,rows,purchase.direct);
        try{if(pendingOrder()?.key===intent.key)sessionStorage.removeItem(pendingOrderKey());}catch{}
      }
      if (result.paymentUrl) {
        const safePayUrl=safeCheckoutPaymentUrl(result.paymentUrl);
        if (!safePayUrl) {
          throw new Error("Liên kết cổng thanh toán không hợp lệ.");
        }
        finishOrder();
        location.assign(safePayUrl);
        return;
      }
      finishOrder();
      root.classList.remove("checkout-two-col");
      const bt = result.bankTransfer;
      const btAmount = bt ? (bt.amountVnd ?? result.order.totalVnd) : result.order.totalVnd;
      const trackHref = "/tra-cuu-don-hang?order=" + encodeURIComponent(result.order.orderNumber);
      root.innerHTML = `<div class="order-success" role="status"><p class="eyebrow">Đã tiếp nhận đơn</p><h2>Mã đơn ${escapeHtml(result.order.orderNumber)}</h2><p>${escapeHtml(result.message)}</p><p>Thông tin đơn hàng và hướng dẫn tài khoản, nếu cần, sẽ được gửi tới email bạn đã nhập. Nếu chưa thấy thư, kiểm tra thư rác hoặc liên hệ GAERU.</p><p>Tạm tính ${formatPrice(result.order.subtotalVnd)} ${result.order.discountVnd?`· Giảm giá −${formatPrice(result.order.discountVnd)}`:""} · Giao hàng ${formatPrice(result.order.shippingFeeVnd)} · Tổng cộng <strong>${formatPrice(result.order.totalVnd)}</strong></p>${result.order.shippingCarrierName?`<p>Đơn vị vận chuyển: <strong>${escapeHtml(result.order.shippingCarrierName)}</strong></p>`:""}${bt?`<div class="vietqr-payment-card bank-transfer-notice" data-vietqr-card><div class="vietqr-card-header"><strong>Chuyển khoản nhanh VietQR</strong><span class="vietqr-timer-badge" data-vietqr-countdown>⏱ Còn 30:00</span></div><div class="vietqr-body-grid">${bt.qrUrl?`<div class="vietqr-qr-col"><img src="${escapeHtml(bt.qrUrl)}" alt="Mã VietQR thanh toán đơn ${escapeHtml(result.order.orderNumber)}" width="200" height="200" loading="eager"><button type="button" class="vietqr-download-btn" data-download-qr="${escapeHtml(bt.qrUrl)}" data-qr-filename="GAERU-VietQR-${escapeHtml(result.order.orderNumber)}.png">⬇ Tải mã QR</button><p class="vietqr-qr-caption">Quét bằng ứng dụng ngân hàng để tự động điền số tiền &amp; nội dung.</p></div>`:""}<div class="vietqr-info-rows"><div class="vietqr-info-row"><div class="vietqr-info-text"><span>Ngân hàng thụ hưởng</span><strong>${escapeHtml(bt.bankName)}${bt.branch?` (${escapeHtml(bt.branch)})`:""}</strong></div></div><div class="vietqr-info-row"><div class="vietqr-info-text"><span>Chủ tài khoản</span><strong>${escapeHtml(bt.accountHolder)}</strong></div></div><div class="vietqr-info-row"><div class="vietqr-info-text"><span>Số tài khoản</span><strong>${escapeHtml(bt.accountNumber)}</strong></div><button type="button" class="vietqr-copy-btn" data-copy-value="${escapeHtml(bt.accountNumber)}">Sao chép</button></div><div class="vietqr-info-row"><div class="vietqr-info-text"><span>Số tiền chuyển khoản</span><strong>${formatPrice(btAmount)}</strong></div><button type="button" class="vietqr-copy-btn" data-copy-value="${escapeHtml(String(btAmount))}">Sao chép</button></div><div class="vietqr-info-row"><div class="vietqr-info-text"><span>Nội dung chuyển khoản (chính xác)</span><strong>${escapeHtml(bt.transferContent)}</strong></div><button type="button" class="vietqr-copy-btn" data-copy-value="${escapeHtml(bt.transferContent)}">Sao chép</button></div></div></div><p class="vietqr-live-status" data-prepaid-live-status>Hệ thống đang tự động kiểm tra và so khớp giao dịch của bạn…</p></div>`:`<p>Đơn COD sẽ được GAERU xác nhận và thu tiền khi giao hàng.</p>`}<div class="order-success-actions"><a class="button button-outline" href="${escapeHtml(trackHref)}">Theo dõi đơn hàng</a><a class="button button-blue" href="/cua-hang">Tiếp tục khám phá</a></div></div>`;
      if (bt) {
        const qrCard = root.querySelector("[data-vietqr-card]");
        const countdownBadge = root.querySelector("[data-vietqr-countdown]");
        const qrDeadline = Date.now() + 30 * 60 * 1000;
        const copyTextFallback = (text) => {
          if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            return navigator.clipboard.writeText(text).catch(() => false).then((v) => v !== false);
          }
          try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.setAttribute("readonly", "");
            ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand && document.execCommand("copy");
            ta.remove();
            return Promise.resolve(Boolean(ok));
          } catch (_) {
            return Promise.resolve(false);
          }
        };
        qrCard?.addEventListener("click", (ev) => {
          const copyBtn = ev.target.closest?.("[data-copy-value]");
          if (copyBtn) {
            const val = copyBtn.dataset.copyValue || "";
            void copyTextFallback(val).then(() => {
              copyBtn.textContent = "✓ Đã chép";
              copyBtn.classList?.add("is-copied");
              clearTimeout(copyBtn._copyTimer);
              copyBtn._copyTimer = setTimeout(() => {
                copyBtn.textContent = "Sao chép";
                copyBtn.classList?.remove("is-copied");
              }, 2000);
              window.GAERUNotify?.toast?.("Đã sao chép vào bộ nhớ tạm", "success");
            });
            return;
          }
          const dlBtn = ev.target.closest?.("[data-download-qr]");
          if (dlBtn) {
            const qrSrc = dlBtn.dataset.downloadQr || "";
            const fileName = dlBtn.dataset.qrFilename || "GAERU-VietQR.png";
            if (!qrSrc) return;
            dlBtn.disabled = true;
            const origText = dlBtn.textContent;
            dlBtn.textContent = "Đang tải…";
            fetch(qrSrc, { mode: "cors" })
              .then((r) => {
                if (!r.ok) throw Error("QR fetch failed");
                return r.blob();
              })
              .then((blob) => {
                const objUrl = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = objUrl;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
              })
              .catch(() => {
                const a = document.createElement("a");
                a.href = qrSrc;
                a.download = fileName;
                a.target = "_blank";
                a.rel = "noopener noreferrer";
                document.body.appendChild(a);
                a.click();
                a.remove();
              })
              .finally(() => {
                dlBtn.disabled = false;
                dlBtn.textContent = origText;
              });
          }
        });
        let qrCountdownTimer = null;
        if (countdownBadge && typeof setInterval === "function") {
          const tickQr = () => {
            if (!countdownBadge.isConnected) {
              clearInterval(qrCountdownTimer);
              return;
            }
            const remSec = Math.max(0, Math.floor((qrDeadline - Date.now()) / 1000));
            const mm = String(Math.floor(remSec / 60)).padStart(2, "0");
            const ss = String(remSec % 60).padStart(2, "0");
            countdownBadge.textContent = remSec > 0 ? `⏱ Còn ${mm}:${ss}` : "Đã hết 30:00 tự động kiểm tra";
            if (remSec <= 0) clearInterval(qrCountdownTimer);
          };
          qrCountdownTimer = setInterval(tickQr, 1000);
        }
        const liveNode = root.querySelector("[data-prepaid-live-status]");
        window.GAERUCheckout.watchBankTransfer(liveNode, result.order.orderNumber, result.trackingToken, apiRequest, order => {
          if (qrCountdownTimer) clearInterval(qrCountdownTimer);
          if (qrCard && order.status !== "cancelled") {
            qrCard.className = "vietqr-paid-card bank-transfer-notice";
            qrCard.innerHTML = `<div class="vietqr-paid-icon" aria-hidden="true">✓</div><h3>✓ Đã nhận thanh toán thành công</h3><p>GAERU đã ghi nhận khoản chuyển khoản <strong>${formatPrice(order.totalVnd ?? btAmount)}</strong> cho đơn <strong>${escapeHtml(order.orderNumber)}</strong>.</p><p>Đơn hàng đã tự động chuyển sang trạng thái chuẩn bị gửi hàng.</p>`;
          }
          window.GAERUAnalytics?.trackPurchase?.({
            orderNumber:order.orderNumber, totalVnd:order.totalVnd,
            shippingFeeVnd:order.shippingFeeVnd, subtotalVnd:order.subtotalVnd,
            items:order.items || rows.map(({variant,product,quantity}) => ({
              variantId:variant.id, sku:variant.sku, name:product.name + " - " + variant.name,
              category:product.category, priceVnd:variant.priceVnd, quantity
            }))
          });
        });
      }
    } catch (error) {
      feedback.textContent = error.message;
      button.disabled = false;
      sending=false;
    }
  });
}

function renderMiniCart() {
  const root = document.querySelector("[data-mini-cart]");
  if (!root) return;
  const rows = cartRows(readCart());
  const cart = readCart();
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  const total = rows.reduce((sum, item) => sum + item.variant.priceVnd * item.quantity, 0);
  const panelCount = document.querySelector("[data-cart-panel-count]");
  const footer = document.querySelector("[data-mini-cart-footer]");
  const totalElement = document.querySelector("[data-mini-cart-total]");
  const panelTitle = document.querySelector("#cart-panel-title");
  const cartHeading = document.querySelector(".cart-panel-heading");
  if (panelCount) {
    panelCount.textContent = `${count} sản phẩm`;
    panelCount.hidden = count === 0;
  }

  if (!rows.length) {
    if (panelTitle) panelTitle.textContent = "Giỏ hàng của bạn trống.";
    cartHeading?.classList.add("is-empty");
    root.innerHTML = window.GAERUEmptyCartMarkup;
    if (footer) footer.hidden = true;
    return;
  }
  if (panelTitle) panelTitle.textContent = "Giỏ hàng của bạn.";
  cartHeading?.classList.remove("is-empty");
  root.innerHTML = rows.map(({ variantId, quantity, product, variant }) => `
    <article class="mini-cart-item">
      <a class="mini-cart-image" href="/san-pham/${encodeURIComponent(product.slug)}"><img src="${escapeHtml(product.imageUrl)}" alt="" loading="lazy" decoding="async"></a>
      <div class="mini-cart-info">
        <a class="mini-cart-name" href="/san-pham/${encodeURIComponent(product.slug)}">${escapeHtml(product.name)}</a>
        <span class="mini-cart-price">${escapeHtml(formatDisplayLabel(variant.name))} · ${formatPrice(variant.priceVnd)}</span>
        <div class="mini-quantity" aria-label="Số lượng ${escapeHtml(product.name)}">
          <button type="button" data-mini-quantity="decrease" data-product="${escapeHtml(variantId)}" aria-label="Giảm số lượng ${escapeHtml(product.name)}" ${quantity <= 1 ? "disabled" : ""}>−</button>
          <span>${quantity}</span>
          <button type="button" data-mini-quantity="increase" data-product="${escapeHtml(variantId)}" aria-label="Tăng số lượng ${escapeHtml(product.name)}" ${quantity >= Math.min(99, variant.stockQuantity) ? "disabled" : ""}>+</button>
          <button class="mini-remove" type="button" data-mini-remove="${escapeHtml(variantId)}">Xóa</button>
        </div>
      </div>
      <strong class="mini-line-total">${formatPrice(variant.priceVnd * quantity)}</strong>
    </article>`).join("");
  if (footer) footer.hidden = false;
  if (totalElement) totalElement.textContent = formatPrice(total);
}

function bindGlobalControls() {
  let pointerStartX = 0, pointerStartY = 0;
  const quickBundleCache = new Map();
  let quickPublicSettingsPromise = null;

  const qcSafeImg = (value) => {
    if (typeof safeProductImage === "function") return safeProductImage(value);
    const img = String(value || "").trim();
    return img || "/assets/products/k9.webp";
  };

  const qcResolveVariantImage = (product, variant) => {
    const art = typeof window !== "undefined" && window.GAERUProductArtwork?.variantImage?.(product, variant);
    return qcSafeImg(art?.url || variant?.imageUrl || product?.imageUrl);
  };

  const qcBuildGroups = (variants, preferred = []) => {
    if (typeof window !== "undefined" && window.GAERUVariantChoices?.groups) {
      return window.GAERUVariantChoices.groups(variants, preferred);
    }
    const map = new Map();
    for (const g of preferred || []) {
      const vals = (g.values || []).filter((val) => variants.some((v) => v.options?.[g.name] === val));
      if (vals.length) map.set(g.name, vals);
    }
    for (const v of variants) {
      for (const [k, val] of Object.entries(v.options || {})) {
        if (!map.has(k)) map.set(k, []);
        if (!map.get(k).includes(val)) map.get(k).push(val);
      }
    }
    return [...map].filter(([, vals]) => vals.length).map(([name, values]) => ({ name, values }));
  };

  const qcChooseOption = (variants, current, group, value) => {
    if (typeof window !== "undefined" && window.GAERUVariantChoices?.choose) {
      return window.GAERUVariantChoices.choose(variants, current, group, value);
    }
    const candidates = variants.filter((v) => v.options?.[group] === value);
    return candidates.find((v) => Object.entries(current?.options || {}).every(([k, sel]) => k === group || v.options?.[k] === sel))
      || candidates.find((v) => Number(v.stockQuantity) > 0)
      || candidates[0]
      || null;
  };

  const qcFormatEndDate = (iso) => {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" });
    } catch (_) {
      return "";
    }
  };

  const qcFetchPublicSettings = () => {
    if (typeof fetch !== "function") return Promise.resolve(null);
    if (!quickPublicSettingsPromise) {
      quickPublicSettingsPromise = fetch("/api/settings/public", { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    }
    return quickPublicSettingsPromise;
  };

  const qcFetchBundles = (slug) => {
    if (typeof fetch !== "function" || !slug) return Promise.resolve([]);
    if (!quickBundleCache.has(slug)) {
      quickBundleCache.set(
        slug,
        fetch(`/api/products/${encodeURIComponent(slug)}/bundles`, { credentials: "same-origin" })
          .then((r) => (r.ok ? r.json() : { bundles: [] }))
          .then((d) => (Array.isArray(d?.bundles) ? d.bundles : []))
          .catch(() => [])
      );
    }
    return quickBundleCache.get(slug);
  };

  function openQuickCartDialog(product) {
    const activeVariants = (product.variants || []).filter((v) => v.active);
    if (!activeVariants.length) return;
    const inStockVariants = activeVariants.filter((v) => Number(v.stockQuantity) > 0);
    const mainCoverImg = qcSafeImg((typeof window !== "undefined" && window.GAERUProductArtwork?.image?.(product)) || product.imageUrl);
    let selectedVariant = activeVariants.length === 1 ? activeVariants[0] : null;
    const selectedOptions = {};
    if (selectedVariant && selectedVariant.options) {
      for (const [k, val] of Object.entries(selectedVariant.options)) selectedOptions[k] = val;
    }
    let selectedQty = 1;

    let dialog = document.querySelector("#quick-cart-dialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "quick-cart-dialog";
      dialog.className = "quick-cart-dialog quick-cart-premium";
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) dialog.close();
      });
      document.body.append(dialog);
    } else {
      dialog.className = "quick-cart-dialog quick-cart-premium";
    }
    dialog.setAttribute("aria-labelledby", "qc-dialog-title");

    const pUrl = `/san-pham/${encodeURIComponent(product.slug)}`;
    const optionGroups = qcBuildGroups(activeVariants, product.optionGroups || []);
    const useMultiGroupPills = optionGroups.length >= 2;
    const distinctVariantImgs = new Set(activeVariants.map((v) => String(v.imageUrl || "").trim()).filter(Boolean));
    const showVariantCardThumbs = distinctVariantImgs.size >= 2;

    const galleryThumbs = [];
    const seenImgs = new Set();
    const pushThumb = (rawUrl, label) => {
      const safe = qcSafeImg(rawUrl);
      if (!safe || seenImgs.has(safe)) return;
      seenImgs.add(safe);
      galleryThumbs.push({ url: safe, label: label || product.name });
    };
    // Always place the main product cover image first
    pushThumb(mainCoverImg, product.name);
    for (const v of activeVariants) {
      if (v.imageUrl) pushThumb(v.imageUrl, v.name);
    }
    for (const gUrl of product.gallery || []) {
      if (galleryThumbs.length >= 5) break;
      pushThumb(gUrl, product.name);
    }

    const qcDisplayLabel = (s) => String(s ?? "").replace(/\bmicro\s*usb\b/gi, "Micro USB");
    let optionsMarkup = "";
    if (useMultiGroupPills) {
      optionsMarkup = optionGroups.map((g) => `
        <div class="qc-option-group" data-qc-group="${escapeHtml(g.name)}">
          <div class="qc-option-label">
            <span>${escapeHtml(g.name)}</span>
            <strong class="is-unselected" data-qc-group-selected="${escapeHtml(g.name)}">Chưa chọn</strong>
          </div>
          <div class="qc-pill-list" role="group" aria-label="${escapeHtml(g.name)}">
            ${g.values.map((val) => {
              const anyInStock = activeVariants.some((v) => v.options?.[g.name] === val && Number(v.stockQuantity) > 0);
              return `<button type="button" class="qc-pill-btn${anyInStock ? "" : " is-oos"}" data-qc-opt-group="${escapeHtml(g.name)}" data-qc-opt-value="${escapeHtml(val)}" aria-pressed="false">${escapeHtml(qcDisplayLabel(val))}</button>`;
            }).join("")}
          </div>
        </div>
      `).join("");
    } else if (activeVariants.length > 1) {
      const singleGroupTitle = optionGroups[0]?.name || "Phiên bản";
      optionsMarkup = `
        <div class="qc-option-group">
          <div class="qc-option-label">
            <span>${escapeHtml(singleGroupTitle)}</span>
            <strong class="is-unselected" data-qc-single-selected>Chưa chọn</strong>
          </div>
          <div class="qc-variant-grid${showVariantCardThumbs ? " has-thumbs" : ""}" role="group" aria-label="${escapeHtml(singleGroupTitle)}">
            ${activeVariants.map((v) => {
              const oos = Number(v.stockQuantity) <= 0;
              const vOrig = Number(v.originalPriceVnd || v.priceVnd);
              const hasDisc = vOrig > v.priceVnd;
              const vThumb = showVariantCardThumbs ? qcResolveVariantImage(product, v) : "";
              return `
                <button type="button" class="qc-variant-card${oos ? " is-oos" : ""}" data-qc-variant-id="${escapeHtml(v.id)}" aria-pressed="false" ${oos ? "disabled" : ""}>
                  ${vThumb ? `<span class="qc-variant-thumb"><img src="${escapeHtml(vThumb)}" alt="" width="36" height="36" loading="lazy" decoding="async"></span>` : ""}
                  <span class="qc-variant-meta">
                    <span class="qc-variant-name">${escapeHtml(qcDisplayLabel(v.name))}</span>
                    <span class="qc-variant-price-row">
                      <strong class="qc-variant-price">${oos ? "Hết hàng" : escapeHtml(formatPrice(v.priceVnd))}</strong>
                      ${!oos && hasDisc ? `<del class="qc-variant-orig">${escapeHtml(formatPrice(vOrig))}</del>` : ""}
                    </span>
                  </span>
                  <span class="qc-variant-check" aria-hidden="true">✓</span>
                </button>`;
            }).join("")}
          </div>
        </div>
      `;
    } else {
      const only = activeVariants[0];
      optionsMarkup = `
        <div class="qc-single-edition">
          <span class="qc-single-edition-label">Phiên bản tiêu chuẩn</span>
          <strong>${escapeHtml(qcDisplayLabel(only.name))}</strong>
        </div>
      `;
    }

    const summaryText = String(product.cardSummary || "").replace(/\*\*|__/g, "").trim();

    dialog.innerHTML = `
      <div class="qc-shell">
        <header class="qc-header">
          <div class="qc-header-copy">
            ${product.descriptor ? `<p class="qc-eyebrow">${escapeHtml(product.descriptor)}</p>` : ""}
            <h2 id="qc-dialog-title">${escapeHtml(product.cardTitle || product.name)}</h2>
          </div>
          <div class="qc-header-actions">
            <a class="qc-detail-link" href="${pUrl}">Chi tiết ↗</a>
            <button type="button" class="qc-close-btn" data-close-quick-cart aria-label="Đóng">×</button>
          </div>
        </header>

        <div class="qc-body">
          <div class="qc-media-col">
            <div class="qc-stage">
              <img class="qc-stage-img" data-qc-image src="${escapeHtml(mainCoverImg)}" alt="${escapeHtml(product.name)}" width="320" height="320" decoding="async">
              <div class="qc-stage-bar">
                <span class="qc-stock-pill" data-qc-stock-pill></span>
                <span class="qc-stage-badge" data-qc-stage-badge hidden></span>
              </div>
            </div>
            <div class="qc-mobile-hero-meta">
              <div class="qc-mobile-price-row">
                <strong class="qc-mobile-price" data-qc-mobile-price></strong>
                <del class="qc-mobile-orig" data-qc-mobile-orig hidden></del>
                <span class="qc-discount-tag" data-qc-mobile-discount hidden></span>
              </div>
              <p class="qc-mobile-variant-name" data-qc-mobile-variant></p>
              <span class="qc-mobile-stock" data-qc-mobile-stock></span>
            </div>
            ${galleryThumbs.length > 1 ? `
              <div class="qc-thumbs" role="group" aria-label="Xem nhanh hình ảnh sản phẩm">
                ${galleryThumbs.slice(0, 5).map((t, idx) => `
                  <button type="button" class="qc-thumb-btn" data-qc-thumb="${escapeHtml(t.url)}" aria-label="Xem ảnh ${idx + 1}" aria-pressed="${idx === 0 ? "true" : "false"}">
                    <img src="${escapeHtml(t.url)}" alt="" width="44" height="44" loading="lazy" decoding="async">
                  </button>
                `).join("")}
              </div>
            ` : ""}
            ${summaryText ? `<p class="qc-media-summary">${escapeHtml(summaryText)}</p>` : ""}
          </div>

          <div class="qc-config-col">
            <section class="qc-price-panel" data-qc-price-panel aria-label="Giá bán và khuyến mại">
              <div class="qc-sale-bar" data-qc-sale-bar hidden>
                <div class="qc-sale-bar-left">
                  <span class="qc-sale-pill" data-qc-sale-pill>⚡ FLASH SALE</span>
                  <span class="qc-sale-title" data-qc-sale-title></span>
                </div>
                <span class="qc-sale-timer" data-qc-countdown></span>
              </div>
              <div class="qc-price-content">
                <div class="qc-price-row">
                  <strong class="qc-price-now" data-qc-price></strong>
                  <del class="qc-price-orig" data-qc-orig hidden></del>
                  <span class="qc-discount-tag" data-qc-discount hidden></span>
                </div>
                <div class="qc-price-meta">
                  <span class="qc-savings-tag" data-qc-savings hidden></span>
                  <span class="qc-sku-tag" data-qc-sku hidden></span>
                </div>
              </div>
            </section>

            <section class="qc-promo-card qc-promo-strip" data-qc-promo-card aria-label="Chương trình khuyến mại và ưu đãi">
              <a class="qc-perk-chip is-combo" data-qc-bundle-row href="${pUrl}" hidden>
                <span class="qc-perk-ico" aria-hidden="true">🎁</span>
                <span data-qc-bundle-text>Combo</span>
              </a>
              <span class="qc-perk-chip is-ship" data-qc-shipping-row title="Giao hàng nhanh toàn quốc">
                <span class="qc-perk-ico" aria-hidden="true">🚚</span>
                <span data-qc-ship-text>Giao toàn quốc</span>
              </span>
              <span class="qc-perk-chip is-perk" title="Hỗ trợ mã giảm giá &amp; đổi điểm GAERU XU tại thanh toán">
                <span class="qc-perk-ico" aria-hidden="true">🎟️</span>
                <span>Voucher &amp; Xu</span>
              </span>
              ${(product.category === "accessory" || product.slug === "gaeru-p185" || product.slug === "dau-chuyen-doi-micro-gaeru") ? `<span class="qc-perk-chip is-perk" title="Đổi mới 1:1 trong 7 ngày nếu lỗi nhà sản xuất hoặc giao sai hàng"><span class="qc-perk-ico" aria-hidden="true">🛡️</span><span>Đổi lỗi 7N</span></span>` : `<span class="qc-perk-chip is-perk" title="Bảo hành chính hãng GAERU 12 tháng"><span class="qc-perk-ico" aria-hidden="true">🛡️</span><span>BH 12T</span></span>`}
            </section>

            <div class="qc-options-section">
              ${optionsMarkup}
              <label class="visually-hidden">
                Chọn phiên bản
                <select data-quick-variant>
                  <option value="" ${!selectedVariant ? "selected" : ""}>Chọn phiên bản phù hợp</option>
                  ${activeVariants.map((v) => `<option value="${escapeHtml(v.id)}" ${Number(v.stockQuantity) > 0 ? "" : "disabled"} ${selectedVariant && v.id === selectedVariant.id ? "selected" : ""}>${escapeHtml(v.name)} · ${escapeHtml(formatPrice(v.priceVnd))}${Number(v.stockQuantity) > 0 ? "" : " · Hết hàng"}</option>`).join("")}
                </select>
              </label>
            </div>

            <div class="qc-qty-row">
              <div class="qc-qty-label">
                <span>Số lượng</span>
                <small data-qc-qty-note></small>
              </div>
              <div class="qc-stepper" role="group" aria-label="Chọn số lượng">
                <button type="button" class="qc-step-btn" data-qc-qty-dec aria-label="Giảm số lượng">−</button>
                <span class="qc-step-value" data-qc-qty-value aria-live="polite">1</span>
                <button type="button" class="qc-step-btn" data-qc-qty-inc aria-label="Tăng số lượng">+</button>
              </div>
            </div>
          </div>
        </div>

        <footer class="qc-footer">
          <div class="qc-footer-summary">
            <span class="qc-footer-label" data-qc-footer-label>Chọn phiên bản để đặt mua</span>
            <div class="qc-footer-totals">
              <strong class="qc-footer-subtotal" data-qc-subtotal></strong>
              <span class="qc-footer-saved" data-qc-footer-saved hidden></span>
            </div>
          </div>
          <div class="qc-footer-actions">
            <button type="button" class="qc-btn-buy" data-quick-buy-now="" data-quick-buy-qty="1">Mua ngay</button>
            <button type="button" class="button button-blue qc-btn-add" data-add-to-cart="" data-add-qty="1">
              <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                <path d="M3 4h2l1.6 8.2a1 1 0 0 0 1 .8h7.5a1 1 0 0 0 1-.8L17.5 6.5H5.5"/>
                <circle cx="8" cy="16.5" r="1.2" fill="currentColor" stroke="none"/>
                <circle cx="14.5" cy="16.5" r="1.2" fill="currentColor" stroke="none"/>
              </svg>
              <span data-qc-add-label>Thêm vào giỏ hàng</span>
            </button>
          </div>
          <p class="qc-feedback" data-cart-feedback role="status" aria-live="polite"></p>
        </footer>
      </div>
    `;

    const picker = dialog.querySelector("[data-quick-variant]");
    const addBtn = dialog.querySelector("[data-add-to-cart]");
    const buyBtn = dialog.querySelector("[data-quick-buy-now]");
    const addLabel = dialog.querySelector("[data-qc-add-label]");
    const stageImg = dialog.querySelector("[data-qc-image]");
    const stageBadge = dialog.querySelector("[data-qc-stage-badge]");
    const stockPill = dialog.querySelector("[data-qc-stock-pill]");
    const mobilePrice = dialog.querySelector("[data-qc-mobile-price]");
    const mobileOrig = dialog.querySelector("[data-qc-mobile-orig]");
    const mobileDisc = dialog.querySelector("[data-qc-mobile-discount]");
    const mobileVar = dialog.querySelector("[data-qc-mobile-variant]");
    const mobileStock = dialog.querySelector("[data-qc-mobile-stock]");
    const pricePanel = dialog.querySelector("[data-qc-price-panel]");
    const saleBar = dialog.querySelector("[data-qc-sale-bar]");
    const salePill = dialog.querySelector("[data-qc-sale-pill]");
    const saleTitle = dialog.querySelector("[data-qc-sale-title]");
    const countdownEl = dialog.querySelector("[data-qc-countdown]");
    const priceNowEl = dialog.querySelector("[data-qc-price]");
    const priceOrigEl = dialog.querySelector("[data-qc-orig]");
    const discountEl = dialog.querySelector("[data-qc-discount]");
    const savingsEl = dialog.querySelector("[data-qc-savings]");
    const skuEl = dialog.querySelector("[data-qc-sku]");
    const promoCard = dialog.querySelector("[data-qc-promo-card]");
    const qtyDecBtn = dialog.querySelector("[data-qc-qty-dec]");
    const qtyIncBtn = dialog.querySelector("[data-qc-qty-inc]");
    const qtyValEl = dialog.querySelector("[data-qc-qty-value]");
    const qtyNoteEl = dialog.querySelector("[data-qc-qty-note]");
    const footerLabel = dialog.querySelector("[data-qc-footer-label]");
    const subtotalEl = dialog.querySelector("[data-qc-subtotal]");
    const footerSavedEl = dialog.querySelector("[data-qc-footer-saved]");
    const feedbackEl = dialog.querySelector("[data-cart-feedback]");

    // Aggregate metrics for initial unselected state
    const allPrices = activeVariants.map((item) => Number(item.priceVnd || 0));
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const allOrigPrices = activeVariants.map((item) => Number(item.originalPriceVnd ?? item.priceVnd ?? 0));
    const minOrig = Math.min(...allOrigPrices);
    const maxOrig = Math.max(...allOrigPrices);
    const maxSavedAll = Math.max(0, ...activeVariants.map((item) => Math.max(0, Number(item.originalPriceVnd ?? item.priceVnd ?? 0) - Number(item.priceVnd || 0))));
    const maxPctAll = Math.max(0, ...activeVariants.map((item) => {
      const o = Number(item.originalPriceVnd ?? item.priceVnd ?? 0);
      return o > item.priceVnd && o > 0 ? Math.round(((o - item.priceVnd) / o) * 100) : 0;
    }));
    const salePool = activeVariants.filter((item) => item.promotion);
    const flashPool = salePool.filter((item) => item.promotion?.type === "flash");
    const defaultPromo = flashPool[0]?.promotion || salePool[0]?.promotion || null;

    const syncUi = (updateImage = true, forceCover = false) => {
      const v = selectedVariant;
      const isSelected = Boolean(v);
      const stock = isSelected ? Math.max(0, Number(v.stockQuantity) || 0) : (inStockVariants.length > 0 ? Math.max(...inStockVariants.map((x) => Number(x.stockQuantity) || 0)) : 0);
      const maxQty = Math.max(1, Math.min(99, stock || 1));
      selectedQty = isSelected ? Math.max(1, Math.min(maxQty, selectedQty)) : 1;

      const price = isSelected ? Number(v.priceVnd || 0) : minPrice;
      const orig = isSelected ? Number(v.originalPriceVnd ?? price) : minOrig;
      const savedUnit = isSelected ? Math.max(0, orig - price) : maxSavedAll;
      const pct = isSelected ? (orig > price && orig > 0 ? Math.round((savedUnit / orig) * 100) : 0) : maxPctAll;
      const promo = isSelected ? (v.promotion || null) : defaultPromo;
      const isFlash = promo?.type === "flash";
      const hasDiscount = savedUnit > 0;

      const priceDisplay = isSelected
        ? formatPrice(price)
        : (minPrice === maxPrice ? formatPrice(minPrice) : `${formatPrice(minPrice)} – ${formatPrice(maxPrice)}`);
      const origDisplay = isSelected
        ? formatPrice(orig)
        : (minOrig === maxOrig ? formatPrice(minOrig) : `${formatPrice(minOrig)} – ${formatPrice(maxOrig)}`);

      if (picker) picker.value = isSelected ? v.id : "";

      // Update main stage image & thumbnail highlight
      if (updateImage && stageImg) {
        const nextUrl = (forceCover || !isSelected) ? mainCoverImg : qcResolveVariantImage(product, v);
        if (stageImg.getAttribute("src") !== nextUrl) {
          stageImg.classList.add("is-swapping");
          stageImg.src = nextUrl;
          stageImg.alt = isSelected ? `${product.name} · ${v.name}` : product.name;
          setTimeout(() => stageImg.classList.remove("is-swapping"), 180);
        }
        dialog.querySelectorAll("[data-qc-thumb]").forEach((btn) => {
          btn.setAttribute("aria-pressed", String(btn.dataset.qcThumb === nextUrl));
        });
      }

      // Discount badge in stage bar
      if (stageBadge) {
        if (pct > 0) {
          stageBadge.textContent = isFlash ? `⚡ -${pct}%` : `-${pct}%`;
          stageBadge.className = `qc-stage-badge${isFlash ? " is-flash" : ""}`;
          stageBadge.hidden = false;
        } else {
          stageBadge.hidden = true;
        }
      }

      // Stock pills (desktop stage + mobile hero)
      const stockText = stock <= 0 ? "Tạm hết hàng" : (isSelected && stock <= 10 ? `Chỉ còn ${stock} sp` : "Còn hàng");
      const stockClass = stock <= 0 ? "is-oos" : (isSelected && stock <= 10 ? "is-low" : "is-ok");
      if (stockPill) {
        stockPill.className = `qc-stock-pill ${stockClass}`;
        stockPill.innerHTML = `<span class="qc-stock-dot" aria-hidden="true"></span>${escapeHtml(stockText)}`;
      }
      if (mobileStock) {
        mobileStock.className = `qc-mobile-stock ${stockClass}`;
        mobileStock.textContent = stockText + (isSelected && v.sku ? ` · SKU ${v.sku}` : "");
      }

      // Mobile compact hero summary
      if (mobilePrice) {
        mobilePrice.textContent = priceDisplay;
        mobilePrice.classList.toggle("is-sale", hasDiscount || Boolean(promo));
      }
      if (mobileOrig) {
        mobileOrig.textContent = origDisplay;
        mobileOrig.hidden = !hasDiscount;
      }
      if (mobileDisc) {
        mobileDisc.textContent = `-${pct}%`;
        mobileDisc.hidden = pct <= 0;
      }
      if (mobileVar) {
        mobileVar.textContent = isSelected ? (v.name || "") : "Vui lòng chọn phiên bản";
        mobileVar.classList.toggle("is-prompt", !isSelected);
      }

      // Main price panel & Flash Sale countdown
      if (pricePanel) {
        pricePanel.classList.toggle("is-flash", isFlash);
        pricePanel.classList.toggle("is-promo", Boolean(promo) && !isFlash);
      }
      if (saleBar) {
        if (promo) {
          saleBar.hidden = false;
          if (salePill) salePill.textContent = isFlash ? "⚡ FLASH SALE" : "🏷️ ƯU ĐÃI";
          if (saleTitle) saleTitle.textContent = promo.title || (isFlash ? "Giá sốc có hạn" : "Khuyến mại");
          if (countdownEl) {
            if (promo.endsAt) {
              countdownEl.dataset.saleEnd = new Date(promo.endsAt).toISOString();
              countdownEl.hidden = false;
            } else {
              delete countdownEl.dataset.saleEnd;
              countdownEl.textContent = "";
              countdownEl.hidden = true;
            }
          }
        } else {
          saleBar.hidden = true;
          if (countdownEl) {
            delete countdownEl.dataset.saleEnd;
            countdownEl.textContent = "";
          }
        }
      }
      if (priceNowEl) {
        priceNowEl.textContent = priceDisplay;
        priceNowEl.classList.toggle("is-sale", hasDiscount || Boolean(promo));
      }
      if (priceOrigEl) {
        priceOrigEl.textContent = origDisplay;
        priceOrigEl.hidden = !hasDiscount;
      }
      if (discountEl) {
        discountEl.textContent = `-${pct}%`;
        discountEl.hidden = pct <= 0;
      }
      if (savingsEl) {
        const isRangeSavings = !isSelected && minPrice !== maxPrice;
        savingsEl.textContent = `${isRangeSavings ? "Tiết kiệm tới" : "Tiết kiệm"} ${formatPrice(savedUnit)}`;
        savingsEl.hidden = !hasDiscount;
      }
      if (skuEl) {
        skuEl.textContent = isSelected && v.sku ? `SKU: ${v.sku}` : "";
        skuEl.hidden = !(isSelected && v.sku);
      }

      if (promoCard) promoCard.classList.toggle("has-active-promo", Boolean(promo) || hasDiscount);

      // Option buttons / variant cards visual state
      if (useMultiGroupPills) {
        dialog.querySelectorAll("[data-qc-opt-group]").forEach((btn) => {
          const gName = btn.dataset.qcOptGroup;
          const gVal = btn.dataset.qcOptValue;
          const activeVal = isSelected ? v.options?.[gName] : selectedOptions[gName];
          btn.setAttribute("aria-pressed", String(activeVal === gVal));
        });
        for (const g of optionGroups) {
          const selEl = dialog.querySelector(`[data-qc-group-selected="${g.name.replace(/"/g, '\\"')}"]`);
          const activeVal = isSelected ? v.options?.[g.name] : selectedOptions[g.name];
          if (selEl) {
            selEl.textContent = activeVal || "Chưa chọn";
            selEl.classList.toggle("is-unselected", !activeVal);
          }
        }
      } else {
        dialog.querySelectorAll("[data-qc-variant-id]").forEach((btn) => {
          btn.setAttribute("aria-pressed", String(isSelected && btn.dataset.qcVariantId === v.id));
        });
        const singleSelEl = dialog.querySelector("[data-qc-single-selected]");
        if (singleSelEl) {
          singleSelEl.textContent = isSelected ? (v.name || "") : "Chưa chọn";
          singleSelEl.classList.toggle("is-unselected", !isSelected);
        }
      }

      // Stepper & footer totals
      if (qtyValEl) qtyValEl.textContent = String(selectedQty);
      if (qtyDecBtn) qtyDecBtn.disabled = !isSelected || stock <= 0 || selectedQty <= 1;
      if (qtyIncBtn) qtyIncBtn.disabled = !isSelected || stock <= 0 || selectedQty >= maxQty;
      if (qtyNoteEl) {
        qtyNoteEl.textContent = !isSelected
          ? "Chọn phiên bản trước"
          : (stock <= 0 ? "Tạm hết hàng" : (stock <= 10 ? `Còn ${stock} sản phẩm` : "Sẵn hàng giao ngay"));
      }

      const canPurchase = isSelected && stock > 0;
      const subtotal = price * selectedQty;
      const totalSaved = savedUnit * selectedQty;
      if (footerLabel) {
        footerLabel.textContent = isSelected ? `Tạm tính (${selectedQty} sản phẩm)` : "Chọn phiên bản để đặt mua";
      }
      if (subtotalEl) {
        subtotalEl.textContent = isSelected
          ? formatPrice(subtotal)
          : (minPrice === maxPrice ? formatPrice(minPrice) : `Từ ${formatPrice(minPrice)}`);
      }
      if (footerSavedEl) {
        footerSavedEl.textContent = isSelected ? `Tiết kiệm ${formatPrice(totalSaved)}` : "";
        footerSavedEl.hidden = !(isSelected && totalSaved > 0);
      }

      if (addBtn) {
        addBtn.dataset.addToCart = canPurchase ? v.id : "";
        addBtn.dataset.addQty = String(selectedQty);
        addBtn.disabled = !canPurchase;
      }
      if (addLabel) addLabel.textContent = (isSelected && stock <= 0) ? "Tạm hết hàng" : "Thêm vào giỏ hàng";
      if (buyBtn) {
        buyBtn.dataset.quickBuyNow = canPurchase ? v.id : "";
        buyBtn.dataset.quickBuyQty = String(selectedQty);
        buyBtn.disabled = !canPurchase;
      }
      if (feedbackEl) feedbackEl.textContent = "";

      if (typeof updateSaleCountdowns === "function") updateSaleCountdowns();
    };

    dialog.querySelector("[data-close-quick-cart]").onclick = () => dialog.close();

    dialog.querySelectorAll("[data-qc-thumb]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!stageImg) return;
        const url = btn.dataset.qcThumb;
        if (!url) return;
        stageImg.src = url;
        dialog.querySelectorAll("[data-qc-thumb]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      });
    });

    dialog.querySelectorAll("[data-qc-variant-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = activeVariants.find((item) => item.id === btn.dataset.qcVariantId);
        if (next) {
          selectedVariant = next;
          syncUi(true, false);
        }
      });
    });

    dialog.querySelectorAll("[data-qc-opt-group]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const gName = btn.dataset.qcOptGroup;
        const gVal = btn.dataset.qcOptValue;
        selectedOptions[gName] = gVal;
        const allChosen = optionGroups.every((g) => Boolean(selectedOptions[g.name]));
        if (allChosen) {
          const exact = activeVariants.find((item) => optionGroups.every((g) => item.options?.[g.name] === selectedOptions[g.name]))
            || qcChooseOption(activeVariants, selectedVariant, gName, gVal);
          if (exact) {
            selectedVariant = exact;
            for (const [k, val] of Object.entries(exact.options || {})) selectedOptions[k] = val;
          }
          syncUi(true, false);
        } else {
          selectedVariant = null;
          syncUi(false, false);
        }
      });
    });

    if (picker) {
      picker.onchange = () => {
        const next = activeVariants.find((item) => item.id === picker.value);
        selectedVariant = next || null;
        if (next && next.options) {
          for (const [k, val] of Object.entries(next.options)) selectedOptions[k] = val;
        }
        syncUi(true, !next);
      };
    }

    if (qtyDecBtn) {
      qtyDecBtn.addEventListener("click", () => {
        if (selectedVariant && selectedQty > 1) {
          selectedQty -= 1;
          syncUi(false, false);
        }
      });
    }
    if (qtyIncBtn) {
      qtyIncBtn.addEventListener("click", () => {
        if (!selectedVariant) return;
        const maxQty = Math.max(1, Math.min(99, Number(selectedVariant.stockQuantity) || 1));
        if (selectedQty < maxQty) {
          selectedQty += 1;
          syncUi(false, false);
        }
      });
    }

    // Initial render always keeps main product cover image first
    syncUi(true, true);
    dialog.showModal();

    // Hydrate live shipping policy & active combo bundles asynchronously as compact icon chips
    qcFetchPublicSettings().then((settings) => {
      if (!settings || !dialog.isConnected) return;
      const shipRow = dialog.querySelector("[data-qc-shipping-row]");
      const shipText = dialog.querySelector("[data-qc-ship-text]");
      if (!shipRow || !shipText) return;
      const rates = settings.shippingRates || {};
      const keys = Object.keys(rates);
      const hasNationwide = keys.some((k) => /^toàn\s+quốc$/i.test(String(k).trim()));
      const freeNationwide = hasNationwide && Object.values(rates).every((fee) => Number(fee) === 0);
      if (freeNationwide) {
        shipRow.className = "qc-perk-chip is-free";
        shipText.textContent = "Freeship 0 ₫";
        shipRow.title = "Miễn phí giao hàng toàn quốc · 0 ₫" + (settings.shippingCarriers?.[0]?.name ? ` (${settings.shippingCarriers[0].name})` : "");
      } else if (settings.shippingNote) {
        shipText.textContent = "Giao toàn quốc";
        shipRow.title = String(settings.shippingNote);
      }
    }).catch(() => {});

    qcFetchBundles(product.slug).then((bundles) => {
      if (!Array.isArray(bundles) || !bundles.length || !dialog.isConnected) return;
      const b = bundles[0];
      const row = dialog.querySelector("[data-qc-bundle-row]");
      const txt = dialog.querySelector("[data-qc-bundle-text]");
      if (!row || !txt || !b) return;
      const discLabel = b.discountType === "percent" ? `-${b.discountValue}%` : `-${formatPrice(b.discountValue)}`;
      txt.textContent = `Combo ${discLabel}`;
      row.title = `Mua kèm ${b.title} giảm thêm ${discLabel}`;
      row.hidden = false;
    }).catch(() => {});
  }

  document.addEventListener("pointerdown", (e) => {
    pointerStartX = e.clientX;
    pointerStartY = e.clientY;
  }, { passive: true });

  document.addEventListener("click", (event) => {
    const buyNow=event.target.closest('[data-buy-now]');
    if(buyNow){if(buyNow.disabled)return;const row=cartRows([{variantId:buyNow.dataset.buyNow,quantity:1}])[0];if(row?.variant.active&&row.variant.stockQuantity>0){location.assign('/thanh-toan?variant='+encodeURIComponent(row.variant.id));}return;}
    const quickBuy=event.target.closest('[data-quick-buy-now]');
    if(quickBuy){if(quickBuy.disabled)return;const vId=quickBuy.dataset.quickBuyNow;const qty=Math.max(1,Math.min(99,Number.parseInt(quickBuy.dataset.quickBuyQty||'1',10)||1));const row=cartRows([{variantId:vId,quantity:1}])[0];if(row?.variant.active&&row.variant.stockQuantity>0){const clampedQty=Math.min(qty,Math.min(99,row.variant.stockQuantity));quickBuy.closest('#quick-cart-dialog')?.close();location.assign('/thanh-toan?variant='+encodeURIComponent(row.variant.id)+(clampedQty>1?'&qty='+clampedQty:''));}return;}
    const choose=event.target.closest('[data-choose-cart]');
    if(choose){if(choose.disabled)return;const product=products.find(p=>p.slug===choose.dataset.chooseCart);if(!product)return;openQuickCartDialog(product);return;}
    const bundleBtn = event.target.closest("[data-add-bundle]");
    if (bundleBtn) {
      if (bundleBtn.disabled || bundleBtn.dataset.addingLock === "1") return;
      bundleBtn.dataset.addingLock = "1";
      setTimeout(() => { delete bundleBtn.dataset.addingLock; }, 350);
      const bundleId = bundleBtn.dataset.addBundle;
      const bundleCard = bundleBtn.closest("[data-bundle-id]");
      const bundle = (window.__currentBundles || []).find(b => b.id === bundleId);
      if (bundle) {
        const currentSelector = document.querySelector("#product-variant");
        const matchedPrimary = bundle.primaryItems?.find(p => p.variantId === currentSelector?.value) || bundle.primaryItems?.[0];
        const primaryVariantId = matchedPrimary?.variantId || currentSelector?.value;
        const primaryQty = Math.max(1, Number(matchedPrimary?.minQuantity) || 1);
        const checkedAccessories = [...(bundleCard?.querySelectorAll("[data-bundle-accessory]:checked") || [])].map(cb => {
          const vId = cb.dataset.bundleAccessory;
          const secItem = bundle.bundledItems?.find(it => it.variantId === vId);
          return { variantId: vId, qty: Math.max(1, Number(secItem?.minQuantity) || 1) };
        });
        const allToAdd = primaryVariantId ? [{ variantId: primaryVariantId, qty: primaryQty }, ...checkedAccessories] : checkedAccessories;
        const cart = readCart();
        const fb = bundleCard?.querySelector(`[data-bundle-feedback="${bundleId}"]`);
        let addedAny = false;
        let cappedMsg = "";
        for (const { variantId: vId, qty } of allToAdd) {
          const selected = cartRows([{ variantId: vId, quantity: 1 }])[0];
          if (!selected || selected.variant.stockQuantity < 1) {
            if (!cappedMsg) cappedMsg = "Một số sản phẩm trong combo hiện đã hết hàng.";
            continue;
          }
          const cartMaximum = Math.min(99, selected.variant.stockQuantity);
          const existing = cart.find(i => i.variantId === vId);
          if (existing && existing.quantity >= cartMaximum) {
            cappedMsg = `Phiên bản ${selected.variant.name || selected.product.name} đã đạt giới hạn tối đa ${cartMaximum} sản phẩm trong giỏ.`;
            continue;
          }
          if (existing) existing.quantity = Math.min(cartMaximum, existing.quantity + qty);
          else cart.push({ variantId: vId, quantity: Math.min(cartMaximum, qty) });
          addedAny = true;
        }
        if (!addedAny) {
          if (fb && cappedMsg) fb.textContent = cappedMsg;
          return;
        }
        if (writeCart(cart)) {
          if (fb) fb.textContent = cappedMsg ? `Đã thêm combo ${bundle.title} vào giỏ (lưu ý: ${cappedMsg})` : `Đã thêm combo ${bundle.title} vào giỏ hàng!`;
          document.dispatchEvent(new CustomEvent("gaeru:open-cart"));
        }
      }
      return;
    }
    const addButton = event.target.closest("[data-add-to-cart]");
    if (addButton) {
      if (addButton.disabled || addButton.dataset.addingLock === "1") return;
      addButton.dataset.addingLock = "1";
      setTimeout(() => { delete addButton.dataset.addingLock; }, 350);
      const variantId = addButton.dataset.addToCart;
      const requestedQty = Math.max(1, Math.min(99, Number.parseInt(addButton.dataset.addQty || "1", 10) || 1));
      const selected = cartRows([{ variantId, quantity: 1 }])[0];
      if (!selected || selected.variant.stockQuantity < 1) return;
      const cart = readCart();
      const existing = cart.find((item) => item.variantId === variantId);
      const cartMaximum = Math.min(99, selected.variant.stockQuantity);
      const feedback = addButton.closest("#quick-cart-dialog")?.querySelector("[data-cart-feedback]") || document.querySelector("[data-cart-feedback]");
      const currentQty = existing ? existing.quantity : 0;
      const remainingAllowance = Math.max(0, cartMaximum - currentQty);
      if (remainingAllowance <= 0) {
        if (feedback) feedback.textContent = `Bạn đã đạt giới hạn ${cartMaximum} sản phẩm có thể đặt cho phiên bản này.`;
        return;
      }
      const addedQty = Math.min(requestedQty, remainingAllowance);
      if (existing) existing.quantity += addedQty;
      else cart.push({ variantId, quantity: addedQty });
      if (!writeCart(cart)) return;
      try {
        window.GAERUAnalytics?.trackAddToCart?.({
          variantId: selected.variant.id,
          sku: selected.variant.sku,
          name: `${selected.product.name} - ${selected.variant.name}`,
          category: selected.product.category,
          priceVnd: selected.variant.priceVnd,
          quantity: addedQty
        });
      } catch (_) {}
      addButton.closest("#quick-cart-dialog")?.close();
      const pageFeedback = document.querySelector("[data-cart-feedback]");
      if (pageFeedback) pageFeedback.textContent = `${selected.product.name}${addedQty > 1 ? ` (×${addedQty})` : ""} đã được thêm vào giỏ.`;
      addButton.setAttribute("aria-label", `${selected.product.name} đã được thêm vào giỏ hàng`);
      document.dispatchEvent(new CustomEvent("gaeru:open-cart"));
      return;
    }

    const removeButton = event.target.closest("[data-remove], [data-mini-remove]");
    if (removeButton) {
      const variantId = removeButton.dataset.remove || removeButton.dataset.miniRemove;
      const currentCart = readCart();
      const removedItem = currentCart.find((item) => item.variantId === variantId);
      if (removedItem) {
        const row = cartRows([removedItem])[0];
        if (row) {
          try {
            window.GAERUAnalytics?.trackRemoveFromCart?.({
              variantId: row.variant.id,
              sku: row.variant.sku,
              name: `${row.product.name} - ${row.variant.name}`,
              category: row.product.category,
              priceVnd: row.variant.priceVnd,
              quantity: removedItem.quantity
            });
          } catch (_) {}
        }
      }
      const cart = currentCart.filter((item) => item.variantId !== variantId);
      if (writeCart(cart)) renderCart();
      return;
    }

    const quantityButton = event.target.closest("[data-mini-quantity]");
    if (quantityButton) {
      const variantId = quantityButton.dataset.product;
      const cart = readCart();
      const item = cart.find((entry) => entry.variantId === variantId);
      if (!item) return;
      const variant = cartRows([item])[0]?.variant;
      const maximum = Math.max(1, Math.min(99, variant?.stockQuantity ?? 99));
      item.quantity = Math.max(1, Math.min(maximum, item.quantity + (quantityButton.dataset.miniQuantity === "increase" ? 1 : -1)));
      writeCart(cart);
      document.querySelector(`[data-mini-quantity="increase"][data-product="${CSS.escape(variantId)}"]`)?.focus();
      return;
    }

    const card = event.target.closest(".product-card, .catalog-card");
    if (card) {
      if (event.target.closest(".card-actions, button, a, input, select, textarea, label, dialog")) return;
      if (typeof event.clientX === "number" && typeof event.clientY === "number" && (pointerStartX || pointerStartY)) {
        const dist = Math.hypot(event.clientX - pointerStartX, event.clientY - pointerStartY);
        if (dist > 12) return;
      }
      const isSafeCardUrl = (raw) => {
        const val = String(raw || "").trim();
        if (!val || /[\u0000-\u001f\u007f\\]/.test(val)) return false;
        if (/^\/(?!\/)/.test(val)) return true;
        if (/^[a-z0-9._-]+\.html(?:[?#]|$)/i.test(val)) return true;
        try {
          const baseOrigin = (typeof location !== "undefined" && location.origin && location.origin !== "null") ? location.origin : "https://gaeru.com";
          const u = new URL(val, baseOrigin);
          if (u.protocol !== "http:" && u.protocol !== "https:") return false;
          const host = u.hostname.toLowerCase();
          return u.origin === baseOrigin || host === "gaeru.com" || host.endsWith(".gaeru.com") || host === "gaeru.org" || host.endsWith(".gaeru.org");
        } catch (_) {
          return false;
        }
      };
      const rawTargetUrl = card.dataset.href || card.querySelector('a.button-outline, a.button-blue, a[href*="/san-pham/"], a[href*="product.html?id="]')?.getAttribute("href");
      const targetUrl = isSafeCardUrl(rawTargetUrl) ? String(rawTargetUrl).trim() : null;
      if (targetUrl) {
        if (event.button === 1 || event.ctrlKey || event.metaKey) {
          window.open(targetUrl, "_blank", "noopener,noreferrer");
        } else if (event.button === 0 || event.button === undefined) {
          location.assign(targetUrl);
        }
      }
      return;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(".product-card[data-href], .catalog-card[data-href]");
    if (!card || event.target.closest("button, a, input, select, textarea")) return;
    if (event.target === card) {
      if (event.key === " ") event.preventDefault();
      const rawKeyUrl = String(card.dataset.href || "").trim();
      const targetUrl = rawKeyUrl && (/^\/(?!\/)/.test(rawKeyUrl) || /^[a-z0-9._-]+\.html(?:[?#]|$)/i.test(rawKeyUrl)) ? rawKeyUrl : null;
      if (targetUrl) {
        if (event.ctrlKey || event.metaKey) {
          window.open(targetUrl, "_blank", "noopener,noreferrer");
        } else {
          location.assign(targetUrl);
        }
      }
    }
  });

  document.addEventListener("change", (event) => {
    const input = event.target.closest("[data-quantity]");
    if (!input) return;
    const cartItem = readCart().find((entry) => entry.variantId === input.dataset.quantity);
    const variant = cartItem ? cartRows([cartItem])[0]?.variant : null;
    const maximum = Math.max(1, Math.min(99, variant?.stockQuantity ?? 99));
    const quantity = Math.max(1, Math.min(maximum, Number.parseInt(input.value, 10) || 1));
    const cart = readCart();
    const item = cart.find((entry) => entry.variantId === input.dataset.quantity);
    if (!item) return;
    item.quantity = quantity;
    if (writeCart(cart)) {
      renderCart();
      document.querySelector(`[data-quantity="${CSS.escape(input.dataset.quantity)}"]`)?.focus();
    }
  });
}

function updateSaleCountdowns(){if(typeof document==='undefined'||document.hidden)return;const nodes=document.querySelectorAll('[data-sale-end]');if(!nodes.length)return;nodes.forEach(node=>{const seconds=Math.max(0,Math.floor((new Date(node.dataset.saleEnd)-Date.now())/1000));if(!seconds){node.textContent='Đã kết thúc · tải lại để cập nhật giá';return;}const days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60);node.textContent='Còn '+(days?days+' ngày ':'')+String(hours).padStart(2,'0')+':'+String(minutes).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');});}
if (!document.body?.hasAttribute?.("data-policy-commerce")) setInterval(updateSaleCountdowns,1000);
function showStoreError(error) {
  console.error("Không thể tải dữ liệu cửa hàng GAERU:", error);
  const message = document.createElement("p");
  message.className = "store-error";
  message.setAttribute("role", "alert");
  message.textContent = "Không thể kết nối máy chủ cửa hàng. Hãy thử tải lại trang hoặc gọi 082 919 1080 để được hỗ trợ.";
  const call=document.createElement("a");call.href="tel:0829191080";call.textContent=" Gọi GAERU 082 919 1080";message.append(call);
  document.querySelector("main")?.prepend(message);
  const grid = document.querySelector(".product-grid, #catalog-grid");
  if (grid && !grid.hasAttribute("data-ssr")) grid.replaceChildren();
}

async function initializeStore() {
  renderMiniCart();
  try {
    const embedded=document.querySelector('#store-bootstrap');
    const response = embedded ? JSON.parse(embedded.textContent) : await (typeof window === "object" && window ? (window.__gaeruProductsPromise || (window.__gaeruProductsPromise = apiRequest("/api/products").catch((err) => { delete window.__gaeruProductsPromise; throw err; }))) : apiRequest("/api/products"));
    products = response.products;
    document.dispatchEvent(new CustomEvent("gaeru:products-loaded"));
    const validVariantIds = new Set(products.flatMap((product) => product.variants.map((variant) => variant.id)));
    const cart = readCart().filter((item) => validVariantIds.has(item.variantId));
    if (cart.length !== readCart().length) writeCart(cart);
    else updateCartBadge(cart);
    renderHomeProducts();
    renderCatalog();
    renderProduct();
    renderCart();
    await renderCheckout();
    if (typeof window !== "undefined" && window.GAERUCustomerSession?.customer) { void mergeCartWithServer(); }
    renderMiniCart();
  } catch (error) {
    showStoreError(error);
    document.dispatchEvent(new CustomEvent("gaeru:products-load-error"));
  }
}

window.GAERUStore = Object.freeze({
  get products() { return products; },
  formatPrice,
  searchProducts,
  readCart,
  writeCart,
  shippingPresentation,
  mergeCartWithServer,
  syncCartToServer
});
window.GAERUBundles = Object.freeze({
  loadAndRenderBundles,
  renderBundlesHtml,
  updateBundleCardPricing,
  updateAllBundleCards
});
document.addEventListener("change", (e) => {
  const cb = e.target.closest("[data-bundle-accessory]");
  if (cb) {
    const card = cb.closest("[data-bundle-id]");
    const bundle = (window.__currentBundles || []).find(b => b.id === card?.dataset.bundleId);
    if (bundle && card) updateBundleCardPricing(card, bundle);
  }
});
document.addEventListener("gaeru:cart-updated", () => { updateCartBadge(); renderMiniCart(); renderCart(); });
document.addEventListener("gaeru:cart-panel-open", renderMiniCart);
document.addEventListener("gaeru:customer-updated", () => {
  resetCheckoutForNewOwner();
  announceCartChange();
  if (typeof window !== "undefined" && window.GAERUCustomerSession?.customer) {
    void mergeCartWithServer();
  }
});
window.addEventListener("storage", (event) => {
  const scope=cartOwner();
  if(event.key!==null && event.key!==cartStorageKey && !event.key.startsWith(cartPrefix+scope+":")) return;
  if(scope!=="guest" && event.newValue && event.key?.startsWith(cartPrefix+scope+":op:")) void mergeCartWithServer();
  updateCartBadge();
  renderMiniCart();
  renderCart();
});
window.addEventListener("online",()=>{if(cartOwner()!=="guest") void mergeCartWithServer();});
bindGlobalControls();
initializeStore();
