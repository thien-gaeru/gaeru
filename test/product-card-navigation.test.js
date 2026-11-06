'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const fs = require('node:fs');
const vm = require('node:vm');
const { productCard: ssrProductCard } = require('../src/seo-pages');

const fixtureProducts = [
  {
    slug: 'gaeru-m3',
    name: 'GAERU M3',
    descriptor: 'MIC KHÔNG DÂY CÀI ÁO CÓ HỘP SẠC CAO CẤP',
    cardTitle: 'GAERU M3',
    cardSummary: 'Mic không dây hộp sạc màn hình hiển thị pin thông minh.',
    category: 'audio',
    imageUrl: '/assets/products/m3.webp',
    imageAlt: 'GAERU M3',
    variants: [{ id: 'm3-1', sku: 'M3-1', name: '1 Mic', priceVnd: 840000, active: true, stockQuantity: 10 }]
  },
  {
    slug: 'gaeru-k9',
    name: 'GAERU K9',
    descriptor: 'MIC KHÔNG DÂY NHỎ GỌN',
    cardTitle: 'GAERU K9',
    cardSummary: 'Ghi lại giọng nói trong trẻo.',
    category: 'audio',
    imageUrl: '/assets/products/k9.webp',
    imageAlt: 'GAERU K9',
    variants: [{ id: 'k9-1', sku: 'K9-1', name: '1 Mic', priceVnd: 237300, active: true, stockQuantity: 5 }]
  },
  {
    slug: 'gaeru-p01',
    name: 'GAERU P01',
    descriptor: 'GIMBAL THEO DÕI KHUÔN MẶT AI',
    cardTitle: 'GAERU P01',
    cardSummary: 'Tự động xoay theo chuyển động.',
    category: 'video',
    imageUrl: '/assets/products/p01.webp',
    imageAlt: 'GAERU P01',
    variants: [{ id: 'p01-1', sku: 'P01-1', name: 'Gimbal', priceVnd: 450000, active: true, stockQuantity: 8 }]
  }
];

test('SSR product cards provide data-href for all products on home rail and catalog grid', () => {
  for (const product of fixtureProducts) {
    const homeHtml = ssrProductCard(product, true);
    const homeDoc = parseHTML(homeHtml).document;
    const homeCard = homeDoc.querySelector('.product-card');
    assert.ok(homeCard, `Home card for ${product.name} must exist`);
    assert.equal(homeCard.getAttribute('data-href'), `/san-pham/${product.slug}`);

    const catalogHtml = ssrProductCard(product, false);
    const catalogDoc = parseHTML(catalogHtml).document;
    const catalogCard = catalogDoc.querySelector('.catalog-card');
    assert.ok(catalogCard, `Catalog card for ${product.name} must exist`);
    assert.equal(catalogCard.getAttribute('data-href'), `/san-pham/${product.slug}`);
  }
});

test('Client-side productCard in commerce.js renders data-href and valid product URLs for all products', () => {
  const commerceSource = fs.readFileSync('commerce.js', 'utf8');
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  const ctx = {
    window,
    document,
    escapeHtml: s => String(s || ''),
    getPriceLabel: () => '100.000 ₫',
    promotionLabel: () => '',
    formatPrice: n => n + ' ₫'
  };
  vm.createContext(ctx);
  // Extract productCard function
  const start = commerceSource.indexOf('function productCard(');
  const end = commerceSource.indexOf('function renderHomeProducts()');
  vm.runInContext(commerceSource.slice(start, end), ctx);

  for (const product of fixtureProducts) {
    const compactHtml = ctx.productCard(product, true);
    const compactDoc = parseHTML(compactHtml).document;
    const card = compactDoc.querySelector('.product-card');
    assert.equal(card.getAttribute('data-href'), `/san-pham/${product.slug}`);

    const fullHtml = ctx.productCard(product, false);
    const fullDoc = parseHTML(fullHtml).document;
    const catCard = fullDoc.querySelector('.catalog-card');
    assert.equal(catCard.getAttribute('data-href'), `/san-pham/${product.slug}`);
  }
});

test('Clicking product card navigates to product detail page, while choose-cart button is protected', () => {
  const commerceSource = fs.readFileSync('commerce.js', 'utf8');
  const html = `<!doctype html><html><body>
    <article class="product-card is-visible" id="gaeru-m3" data-category="audio" data-href="/san-pham/gaeru-m3">
      <div class="product-copy">
        <p class="eyebrow">MIC KHÔNG DÂY CÀI ÁO</p>
        <h3 class="product-title">GAERU M3</h3>
        <p class="product-summary">Mô tả sản phẩm</p>
        <p class="price">840.000 ₫</p>
      </div>
      <img class="product-image" src="/assets/products/m3.webp" alt="GAERU M3">
      <div class="card-actions">
        <button type="button" class="button button-blue" data-choose-cart="gaeru-m3">Thêm vào giỏ hàng</button>
        <a class="button button-outline" href="/san-pham/gaeru-m3">Mua ngay</a>
      </div>
    </article>
  </body></html>`;

  const { document, window } = parseHTML(html);
  let navigatedTo = null;
  let openedTab = null;
  const location = {
    assign(url) { navigatedTo = url; }
  };
  window.open = (url) => { openedTab = url; };

  const origCreateElement = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = origCreateElement(tag);
    if (tag.toLowerCase() === 'dialog') {
      el.showModal = function() { this.open = true; };
      el.close = function() { this.open = false; };
    }
    return el;
  };

  const products = fixtureProducts;
  const ctx = {
    window,
    document,
    location,
    products,
    escapeHtml: s => String(s || ''),
    formatPrice: n => n + ' ₫',
    cartRows: () => [],
    readCart: () => [],
    writeCart: () => true
  };
  vm.createContext(ctx);

  // Extract bindGlobalControls
  const bindStart = commerceSource.indexOf('function bindGlobalControls(');
  const bindEnd = commerceSource.indexOf('function updateSaleCountdowns()', bindStart);
  vm.runInContext(commerceSource.slice(bindStart, bindEnd) + '\nbindGlobalControls();', ctx);

  // 1. Click on card title
  navigatedTo = null;
  const title = document.querySelector('.product-title');
  const clickEvent1 = new window.Event('click', { bubbles: true, cancelable: true });
  clickEvent1.clientX = 100; clickEvent1.clientY = 100;
  title.dispatchEvent(clickEvent1);
  assert.equal(navigatedTo, '/san-pham/gaeru-m3', 'Clicking title must navigate to product page');

  // 2. Click on card image
  navigatedTo = null;
  const img = document.querySelector('.product-image');
  const clickEvent2 = new window.Event('click', { bubbles: true, cancelable: true });
  clickEvent2.clientX = 100; clickEvent2.clientY = 200;
  img.dispatchEvent(clickEvent2);
  assert.equal(navigatedTo, '/san-pham/gaeru-m3', 'Clicking product image must navigate to product page');

  // 3. Click on card background / article
  navigatedTo = null;
  const card = document.querySelector('.product-card');
  const clickEvent3 = new window.Event('click', { bubbles: true, cancelable: true });
  clickEvent3.clientX = 50; clickEvent3.clientY = 50;
  card.dispatchEvent(clickEvent3);
  assert.equal(navigatedTo, '/san-pham/gaeru-m3', 'Clicking card body must navigate to product page');

  // 4. Click on [Thêm vào giỏ hàng] button: should NOT navigate!
  navigatedTo = null;
  const chooseBtn = document.querySelector('[data-choose-cart]');
  const clickEvent4 = new window.Event('click', { bubbles: true, cancelable: true });
  chooseBtn.dispatchEvent(clickEvent4);
  assert.equal(navigatedTo, null, 'Clicking [data-choose-cart] must NOT navigate');
  assert.ok(document.querySelector('#quick-cart-dialog'), 'Clicking [data-choose-cart] must open quick-cart dialog');

  // 5. Drag/swipe gesture: pointerdown at (100, 100), click at (200, 100) -> distance 100px > 12px
  navigatedTo = null;
  const pdown = new window.Event('pointerdown', { bubbles: true });
  pdown.clientX = 100; pdown.clientY = 100;
  card.dispatchEvent(pdown);

  const swipeClick = new window.Event('click', { bubbles: true, cancelable: true });
  swipeClick.clientX = 200; swipeClick.clientY = 100;
  card.dispatchEvent(swipeClick);
  assert.equal(navigatedTo, null, 'Swipe / drag gesture must NOT navigate to product page');

  // 6. Middle-click or Ctrl-click opens new tab
  openedTab = null;
  navigatedTo = null;
  const pdown2 = new window.Event('pointerdown', { bubbles: true });
  pdown2.clientX = 100; pdown2.clientY = 100;
  card.dispatchEvent(pdown2);

  const ctrlClick = new window.Event('click', { bubbles: true, cancelable: true });
  ctrlClick.clientX = 102; ctrlClick.clientY = 101;
  ctrlClick.ctrlKey = true;
  title.dispatchEvent(ctrlClick);
  assert.equal(openedTab, '/san-pham/gaeru-m3', 'Ctrl+click must open product page in new tab');
  assert.equal(navigatedTo, null, 'Ctrl+click must not navigate current tab');
});

test('Keyboard navigation (Enter / Space) on product card navigates to product detail page (A14)', () => {
  const commerceSource = fs.readFileSync('commerce.js', 'utf8');
  const html = `<!doctype html><html><body>
    <article class="product-card is-visible" id="gaeru-m3" data-category="audio" data-href="/san-pham/gaeru-m3" tabindex="0" role="link" aria-label="GAERU M3">
      <div class="product-copy">
        <h3 class="product-title">GAERU M3</h3>
      </div>
      <div class="card-actions">
        <button class="button button-blue" type="button" data-choose-cart="gaeru-m3">Thêm vào giỏ hàng</button>
        <a class="button button-outline" href="/san-pham/gaeru-m3">Mua ngay</a>
      </div>
    </article>
  </body></html>`;

  const { document, window } = parseHTML(html);
  let navigatedTo = null;
  let openedTab = null;

  const ctx = {
    window,
    document,
    location: { assign: (url) => { navigatedTo = url; } },
    escapeHtml: (s) => String(s || ''),
    getPriceLabel: () => '840.000 ₫',
    promotionLabel: () => '',
    formatPrice: (n) => n + ' ₫',
    renderMiniCart: () => {},
    renderCart: () => {},
    readCart: () => [],
    writeCart: () => true,
    cartRows: () => [],
    products: fixtureProducts,
    toast: () => {}
  };
  ctx.window.open = (url) => { openedTab = url; return {}; };
  vm.createContext(ctx);

  const startBind = commerceSource.indexOf('function bindGlobalControls() {');
  const endBind = commerceSource.indexOf('function updateSaleCountdowns()');
  vm.runInContext(commerceSource.slice(startBind, endBind), ctx);
  ctx.bindGlobalControls();

  const card = document.querySelector('.product-card');
  assert.equal(card.getAttribute('tabindex'), '0');
  assert.equal(card.getAttribute('role'), 'link');
  assert.equal(card.getAttribute('aria-label'), 'GAERU M3');

  // 1. Enter key on card navigates
  navigatedTo = null;
  const enterEvent = new window.Event('keydown', { bubbles: true, cancelable: true }); enterEvent.key = 'Enter';
  card.dispatchEvent(enterEvent);
  assert.equal(navigatedTo, '/san-pham/gaeru-m3', 'Enter key on focused card must navigate to product page');

  // 2. Space key on card navigates
  navigatedTo = null;
  const spaceEvent = new window.Event('keydown', { bubbles: true, cancelable: true }); spaceEvent.key = ' ';
  card.dispatchEvent(spaceEvent);
  assert.equal(navigatedTo, '/san-pham/gaeru-m3', 'Space key on focused card must navigate to product page');

  // 3. Ctrl+Enter opens in new tab
  openedTab = null;
  navigatedTo = null;
  const ctrlEnter = new window.Event('keydown', { bubbles: true, cancelable: true }); ctrlEnter.key = 'Enter'; ctrlEnter.ctrlKey = true;
  card.dispatchEvent(ctrlEnter);
  assert.equal(openedTab, '/san-pham/gaeru-m3', 'Ctrl+Enter must open in new tab');
  assert.equal(navigatedTo, null);

  // 4. Enter on internal button does not trigger card navigation
  navigatedTo = null;
  const btn = document.querySelector('[data-choose-cart]');
  const btnEnter = new window.Event('keydown', { bubbles: true, cancelable: true }); btnEnter.key = 'Enter';
  btn.dispatchEvent(btnEnter);
  assert.equal(navigatedTo, null, 'Enter on button inside card must NOT navigate card');
});
