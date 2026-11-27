'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const ROOT = path.resolve(__dirname, '..');

test('Shop page Option A + Style 2: PC 3-col Grid, Tablet 2-col Grid, Mobile swipe carousel with snap & dots', () => {
  const css = fs.readFileSync(path.join(ROOT, 'shop-store.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'shop.html'), 'utf8');

  // Cache-busting bumped & pagination dots container present
  assert.match(html, /\/shop-store\.css\?v=20261128-shop-grid-a2/);
  assert.match(html, /data-store-dots/);

  // Desktop 3-column grid, toolbar arrows & dots hidden on PC
  assert.match(css, /\.shop-page \.catalog-grid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /\.store-rail-toolbar>div\{display:none/);
  assert.match(css, /\.store-rail-dots\{display:none\}/);

  // Style 2 order preserved inside card (eyebrow -> h2 -> description -> pricing -> image -> actions)
  assert.match(css, /\.shop-page \.catalog-card \.eyebrow\{order:0/);
  assert.match(css, /\.shop-page \.catalog-card h2\{order:1/);
  assert.match(css, /\.shop-page \.catalog-description\{order:2;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2/);
  assert.match(css, /\.shop-page \.catalog-pricing\{order:3/);
  assert.match(css, /\.shop-page \.catalog-card-image\{order:4/);
  assert.match(css, /\.shop-page \.catalog-actions\{order:5/);

  // Tablet 2-column grid
  assert.match(css, /@media\(max-width:1024px\)\{\.shop-page \.catalog-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);

  // Mobile horizontal swipe rail with touch-friendly snap, peek width & dots
  assert.match(css, /@media\(max-width:734px\)\{[\s\S]*\.store-rail-toolbar>div\{display:flex\}/);
  assert.match(css, /@media\(max-width:734px\)\{[\s\S]*\.shop-page \.catalog-grid\{display:flex;flex-wrap:nowrap;gap:14px;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scroll-padding-inline:20px;overscroll-behavior-x:contain;touch-action:pan-x pan-y/);
  assert.match(css, /@media\(max-width:734px\)\{[\s\S]*\.shop-page \.catalog-card\{flex:0 0 min\(296px,calc\(100vw - 56px\)\);min-height:0;padding:18px 16px 16px;scroll-snap-align:start;scroll-snap-stop:always\}/);
  assert.match(css, /@media\(max-width:734px\)\{[\s\S]*\.store-rail-dots\{display:flex/);
});

test('Shop catalog rail dots and 1-card stepping work on mobile overflow and auto-hide on PC Grid', () => {
  const commerceSrc = fs.readFileSync(path.join(ROOT, 'commerce.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'shop.html'), 'utf8');
  const { document, window } = parseHTML(html);

  const sampleProducts = Array.from({ length: 6 }, (_, i) => ({
    id: `p-${i + 1}`,
    slug: `gaeru-p${i + 1}`,
    name: `GAERU P${i + 1}`,
    cardTitle: `GAERU P${i + 1}`,
    descriptor: 'THIẾT BỊ THU ÂM',
    cardSummary: `Mô tả ngắn cho sản phẩm số ${i + 1} tối ưu quay dựng.`,
    category: 'audio',
    imageUrl: '/assets/products/k9.webp',
    variants: [{ id: `v-${i + 1}`, sku: `SKU-${i + 1}`, name: 'Standard', priceVnd: 500000, stockQuantity: 10, active: true }]
  }));

  const grid = document.querySelector('#catalog-grid');
  let mockClientWidth = 390;
  let mockScrollWidth = 1886; // Mobile overflowing carousel
  let mockScrollLeft = 0;
  Object.defineProperties(grid, {
    clientWidth: { get: () => mockClientWidth, configurable: true },
    scrollWidth: { get: () => mockScrollWidth, configurable: true },
    scrollLeft: { get: () => mockScrollLeft, set: (v) => { mockScrollLeft = v; }, configurable: true }
  });
  grid.scrollTo = ({ left }) => { mockScrollLeft = left; };

  const startIdx = commerceSrc.indexOf('function renderCatalog()');
  const endIdx = commerceSrc.indexOf('function safeProductImage(');
  assert.ok(startIdx > 0 && endIdx > startIdx);

  const ctx = {
    document,
    window,
    location: { search: '' },
    localStorage: { getItem: () => '[]' },
    matchMedia: () => ({ matches: false }),
    products: sampleProducts,
    searchProducts: (q) => q ? sampleProducts.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : sampleProducts,
    productCard: (p) => `<article class="catalog-card" data-href="/san-pham/${p.slug}"><h2>${p.name}</h2></article>`,
    escapeHtml: (s) => String(s ?? ''),
    URLSearchParams
  };
  vm.createContext(ctx);
  vm.runInContext(commerceSrc.slice(startIdx, endIdx) + '\nrenderCatalog();', ctx);

  // Give rendered cards realistic mobile offsetLeft positions (step = 310px)
  const cards = [...grid.children].filter((el) => el.classList.contains('catalog-card'));
  assert.equal(cards.length, 6);
  cards.forEach((card, i) => Object.defineProperty(card, 'offsetLeft', { value: 20 + i * 310, configurable: true }));

  // Trigger scroll sync in mobile overflowing state
  grid.dispatchEvent(new window.Event('scroll'));
  const dotsRoot = document.querySelector('[data-store-dots]');
  assert.equal(dotsRoot.hidden, false, 'Dots must be visible when overflowing on mobile');
  assert.equal(dotsRoot.querySelectorAll('.store-rail-dot').length, 6);
  assert.equal(dotsRoot.querySelector('.store-rail-index').textContent, '1 / 6');

  // Click next arrow -> advances cleanly by 1 card (310px)
  const nextBtn = document.querySelector('[data-store-scroll="1"]');
  nextBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(mockScrollLeft, 310);
  grid.dispatchEvent(new window.Event('scroll'));
  assert.equal(dotsRoot.querySelector('.store-rail-index').textContent, '2 / 6');
  assert.equal(dotsRoot.querySelectorAll('.store-rail-dot')[1].classList.contains('is-active'), true);

  // Click dot #5 (index 4) -> jumps to card 5 (1240px)
  dotsRoot.querySelectorAll('.store-rail-dot')[4].dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(mockScrollLeft, 1240);
  grid.dispatchEvent(new window.Event('scroll'));
  assert.equal(dotsRoot.querySelector('.store-rail-index').textContent, '5 / 6');

  // Switch to PC Grid dimensions (no horizontal overflow) -> dots auto-hide
  mockClientWidth = 1240;
  mockScrollWidth = 1240;
  mockScrollLeft = 0;
  grid.dispatchEvent(new window.Event('scroll'));
  assert.equal(dotsRoot.hidden, true, 'Dots must auto-hide when grid does not overflow on PC');
});
