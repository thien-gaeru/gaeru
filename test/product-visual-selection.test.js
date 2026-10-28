const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const choices = require('../variant-choices');

test('entering product page displays primary product image and does not pre-select purchasing options', () => {
  const full = fs.readFileSync(require('node:path').join(__dirname, '../commerce.js'), 'utf8');
  const source = full.split('function renderProduct() {')[1].split('function renderCart() {')[0];
  const safeImage = full.slice(full.indexOf('function getPriceLabel'), full.indexOf('function renderProduct'));
  const variants = [
    { id: 'v1', name: 'Màu Đen', sku: 'BLACK', active: true, stockQuantity: 5, priceVnd: 200000, options: { 'Màu': 'Đen' }, imageUrl: '/assets/products/black.webp' },
    { id: 'v2', name: 'Màu Trắng', sku: 'WHITE', active: true, stockQuantity: 2, priceVnd: 220000, options: { 'Màu': 'Trắng' }, imageUrl: '/assets/products/white.webp' }
  ];
  const nodes = new Map();
  const node = s => {
    if (!nodes.has(s)) nodes.set(s, { value: '', textContent: '', dataset: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, dispatchEvent(event) { this.listeners[event.type]?.(); } });
    return nodes.get(s);
  };
  const root = node('#product-detail');
  root.querySelector = node;
  root.querySelectorAll = () => [];
  const document = { title: '', querySelector: node };

  vm.runInNewContext(safeImage + 'function renderProduct(){' + source + '\nrenderProduct();', {
    document,
    products: [{
      slug: 'micro-gaeru',
      name: 'Micro GAERU K9',
      descriptor: 'Thu âm',
      description: 'Mô tả',
      imageUrl: '/assets/products/primary-k9.webp',
      imageAlt: 'Micro GAERU K9',
      variants,
      gallery: ['/assets/products/primary-k9.webp', '/assets/products/gallery-2.webp']
    }],
    location: { search: '?id=micro-gaeru' },
    URLSearchParams,
    escapeHtml: v => String(v ?? ''),
    formatPrice: v => String(v) + ' ₫',
    window: { GAERUVariantChoices: choices },
    Event: class { constructor(type) { this.type = type; } }
  });

  // 1. Main image is the primary product image, NOT the first variant image
  assert.ok(root.innerHTML.includes('data-product-main-image src="/assets/products/primary-k9.webp"'), 'Main image must be product primary image');
  assert.ok(!root.innerHTML.includes('data-product-main-image src="/assets/products/black.webp"'), 'Main image must not be auto-selected to variant image');

  // 2. Main image thumbnail has aria-pressed="true", variant-specific or other thumbnails have aria-pressed="false"
  assert.ok(root.innerHTML.includes('data-gallery-image="/assets/products/primary-k9.webp" aria-label="Xem ảnh 1" aria-pressed="true"'), 'Primary image thumb must be pressed');
  assert.ok(root.innerHTML.includes('data-gallery-image="/assets/products/gallery-2.webp" aria-label="Xem ảnh 2" aria-pressed="false"'), 'Other thumbs must not be pressed');

  // 3. Purchase options are NOT pre-selected: all aria-pressed="false"
  assert.ok(root.innerHTML.includes('data-option-group="Màu" data-option-value="Đen" aria-pressed="false"'), 'Option Đen must not be pre-selected');
  assert.ok(root.innerHTML.includes('data-option-group="Màu" data-option-value="Trắng" aria-pressed="false"'), 'Option Trắng must not be pre-selected');

  // 4. Default select has placeholder
  assert.ok(root.innerHTML.includes('<option value="" disabled selected>Chọn phiên bản</option>'), 'Variant selector must prompt user to choose');

  // 5. Action buttons are disabled initially
  assert.ok(root.innerHTML.includes('buy-now-button" type="button" data-buy-now="" disabled>Mua ngay</button>'), 'Buy now must be disabled initially');
  assert.ok(root.innerHTML.includes('type="button" data-add-to-cart="" disabled>Thêm vào giỏ</button>'), 'Add to cart must be disabled initially');
  assert.ok(root.innerHTML.includes('data-stock-note>Vui lòng chọn phiên bản</p>'), 'Stock note must prompt to choose variant');
});

test('visual product selection updates the exact cart variant, price, stock and picture together', () => {
  const full = fs.readFileSync(require('node:path').join(__dirname, '../commerce.js'), 'utf8');
  const source = full.split('function renderProduct() {')[1].split('function renderCart() {')[0];
  const safeImage = full.slice(full.indexOf('function getPriceLabel'), full.indexOf('function renderProduct'));
  const variants = [{ id: 'one', name: 'Type-C', sku: 'TYPEC', active: true, stockQuantity: 3, priceVnd: 100000, options: { Cổng: 'Type-C' }, imageUrl: '/assets/products/one.webp' }, { id: 'two', name: 'Lightning', sku: 'LIGHTNING', active: true, stockQuantity: 0, priceVnd: 120000, options: { Cổng: 'Lightning' }, imageUrl: '/assets/products/two.webp' }];
  const nodes = new Map();
  const node = s => {
    if (!nodes.has(s)) nodes.set(s, { value: 'one', textContent: '', dataset: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, dispatchEvent(event) { this.listeners[event.type]?.(); } });
    return nodes.get(s);
  };
  const root = node('#product-detail');
  root.querySelector = node;
  root.querySelectorAll = () => [];
  const document = { title: '', querySelector: node };
  vm.runInNewContext(safeImage + 'function renderProduct(){' + source + '\nrenderProduct();', { document, products: [{ slug: 'fixture', name: 'Fixture', descriptor: 'Test', description: 'Description', imageUrl: '/assets/products/cover.webp', imageAlt: 'Cover', variants, gallery: ['/assets/products/cover.webp'] }], location: { search: '?id=fixture' }, URLSearchParams, escapeHtml: v => String(v ?? ''), formatPrice: v => String(v), window: { GAERUVariantChoices: choices }, Event: class { constructor(type) { this.type = type; } } });
  assert.match(root.innerHTML, /data-option-value="Lightning"/);
  root.listeners.click({ target: { closest: s => s === '[data-option-group]' ? { dataset: { optionGroup: 'Cổng', optionValue: 'Lightning' } } : null } });
  assert.equal(node('[data-add-to-cart]').dataset.addToCart, 'two');
  assert.equal(node('[data-add-to-cart]').disabled, true);
  assert.equal(node('[data-selected-price]').textContent, '120000');
  assert.equal(node('[data-product-main-image]').src, '/assets/products/two.webp');
  assert.equal(node('[data-stock-note]').textContent, 'Hết hàng');
  root.listeners.click({ target: { closest: s => s === '[data-option-group]' ? { dataset: { optionGroup: 'Cổng', optionValue: 'Type-C' } } : null } });
  assert.equal(node('[data-add-to-cart]').dataset.addToCart, 'one');
  assert.equal(node('[data-add-to-cart]').disabled, false);
  assert.equal(node('[data-product-main-image]').src, '/assets/products/one.webp');
  assert.equal(node('[data-stock-note]').textContent, 'Còn hàng');
  const pressed = new Map();
  const rail = { offsetLeft: 0, clientWidth: 200, scrollTo() { } };
  const gallery = ['/assets/products/one.webp', '/assets/products/two.webp'].map((url, index) => ({ dataset: { galleryImage: url }, parentElement: rail, offsetLeft: index * 80, offsetWidth: 70, getAttribute() { return pressed.get(url) || 'false'; }, setAttribute(name, value) { pressed.set(url, value); }, click() { root.listeners.click({ target: { closest: s => s === '[data-gallery-image]' ? this : null } }); } }));
  pressed.set('/assets/products/one.webp', 'true');
  root.querySelectorAll = s => s === '[data-gallery-image]' ? gallery : [];
  const start = (x, y) => root.listeners.touchstart({ touches: [{ clientX: x, clientY: y }], target: { closest: () => node('[data-product-main-image]') } });
  const end = (x, y) => root.listeners.touchend({ changedTouches: [{ clientX: x, clientY: y }] });
  start(200, 100);
  end(100, 105);
  assert.equal(node('[data-product-main-image]').src, '/assets/products/two.webp');
  assert.equal(node('[data-add-to-cart]').dataset.addToCart, 'one');
  start(100, 100);
  end(105, 220);
  assert.equal(node('[data-product-main-image]').src, '/assets/products/two.webp');
  start(100, 100);
  end(200, 105);
  assert.equal(node('[data-product-main-image]').src, '/assets/products/one.webp');
});
