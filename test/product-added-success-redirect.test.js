const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ui = require('../admin/admin-ui');
const choices = require('../variant-choices');

test('product editor shows success popup and redirects to /gaeru_ceo#products after adding a new product', async () => {
  const nodes = new Map();
  function node(key) {
    if (!nodes.has(key)) {
      nodes.set(key, {
        value: '',
        textContent: '',
        innerHTML: '',
        children: [],
        dataset: {},
        disabled: false,
        hidden: false,
        listeners: {},
        classList: {
          classes: new Set(),
          add(c) { this.classes.add(c); },
          remove(c) { this.classes.delete(c); },
          contains(c) { return this.classes.has(c); },
          toggle(c, force) {
            if (force === undefined) {
              if (this.classes.has(c)) this.classes.delete(c);
              else this.classes.add(c);
            } else if (force) this.classes.add(c);
            else this.classes.delete(c);
          }
        },
        addEventListener(k, v) { (this.listeners[k] ||= []).push(v); },
        querySelector: k => node(k),
        querySelectorAll: () => [],
        closest: k => node(k),
        appendChild(child) { this.children.push(child); },
        scrollIntoView() {},
        focus() { this.focused = true; },
        click() {}
      });
    }
    return nodes.get(key);
  }

  const form = node('#workspace-form');
  form.elements = Object.fromEntries(
    ['name', 'slug', 'category', 'descriptor', 'cardTitle', 'cardSummary', 'description', 'imageAlt', 'sortOrder']
      .map(key => [key, node(key)])
  );
  form.reportValidity = () => true;

  const draft = node('[data-save=draft]'), publish = node('[data-save=publish]');
  draft.dataset.save = 'draft';
  publish.dataset.save = 'publish';

  const popupInit = node('#product-success-popup');
  popupInit.hidden = true;
  popupInit.innerHTML = '<div class="product-success-popup-card"><h2 id="product-success-title">Đã thêm sản phẩm mới thành công</h2><p class="product-success-sub">Đang tự động chuyển hướng về trang quản lý sản phẩm…</p></div>';

  const mockStorage = new Map();
  let redirectedUrl = null;

  const context = {
    document: {
      querySelector: node,
      getElementById: id => node('#' + id),
      querySelectorAll: selector => {
        if (selector === '[data-save]') return [draft, publish];
        return [];
      },
      createElement: tag => node(tag),
      body: node('body')
    },
    window: {
      GAERUVariantChoices: choices,
      GAERUAdminUI: ui,
      addEventListener() {}
    },
    location: {
      pathname: '/gaeru_ceo/products/new',
      search: '',
      assign: (url) => { redirectedUrl = url; },
      set href(url) { redirectedUrl = url; },
      get href() { return redirectedUrl; }
    },
    sessionStorage: {
      setItem: (k, v) => mockStorage.set(k, v),
      getItem: (k) => mockStorage.get(k),
      removeItem: (k) => mockStorage.delete(k)
    },
    history: { replaceState() {} },
    console,
    FormData: class { append() {} },
    WeakMap,
    setTimeout: (fn, ms) => { fn(); },
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    fetch: async (path, options = {}) => {
      if (path === '/api/auth/me') {
        return { ok: true, json: async () => ({ authenticated: true, permissions: ['catalog.read', 'catalog.write', 'inventory.approve'] }) };
      }
      if (path === '/api/csrf') {
        return { ok: true, json: async () => ({ csrfToken: 'fixture-csrf' }) };
      }
      if (path === '/api/gaeru_ceo/catalog-images') {
        return { ok: true, json: async () => ({ imageUrl: 'https://gaeru.vn/k9.webp' }) };
      }
      if (path === '/api/gaeru_ceo/product-workspace' && options.method === 'POST') {
        const payload = JSON.parse(options.body);
        return { ok: true, json: async () => ({ id: 'created-product-id', version: 1, product: payload.product, gallery: payload.gallery, variants: payload.variants, groups: payload.groups }) };
      }
      return { ok: true, json: async () => ({}) };
    }
  };

  const { readAdminBundle } = require('./helpers/admin-sources'); const scriptSource = readAdminBundle(['format.js', 'product-editor-media.js', 'product-editor-variants.js', 'product-editor.js']);
  vm.createContext(context);
  vm.runInContext(scriptSource, context);

  await new Promise(r => setTimeout(r, 20));

  // Fill in required valid product info
  form.elements.name.value = 'Micro GAERU K9';
  form.elements.slug.value = 'gaeru-k9';
  node('#simple-price').value = '250000';
  node('#simple-stock').value = '50';

  // Add at least one image in gallery
  const galleryFiles = node('#gallery-files');
  galleryFiles.listeners.change[0]({
    target: { files: [{ name: 'k9.webp', size: 1000 }] }
  });

  // Allow async upload worker to finish
  await new Promise(r => setTimeout(r, 50));

  // Click draft save
  await draft.onclick();

  // Verify popup was triggered and message saved
  assert.equal(mockStorage.get('gaeru:product-added-notice'), 'Đã thêm sản phẩm mới thành công');
  assert.equal(redirectedUrl, '/gaeru_ceo#products');

  const popupNode = node('#product-success-popup');
  assert.ok(popupNode.innerHTML.includes('Đã thêm sản phẩm mới thành công'), 'Popup must contain success text');
  assert.equal(popupNode.hidden, false, 'Popup must be visible');
});

test('product editor shows success popup and redirects to /gaeru_ceo#products after editing an existing product', async () => {
  const nodes = new Map();
  function node(key) {
    if (!nodes.has(key)) {
      nodes.set(key, {
        value: '',
        textContent: '',
        innerHTML: '',
        children: [],
        dataset: {},
        disabled: false,
        hidden: false,
        listeners: {},
        classList: {
          classes: new Set(),
          add(c) { this.classes.add(c); },
          remove(c) { this.classes.delete(c); },
          contains(c) { return this.classes.has(c); },
          toggle(c, force) {}
        },
        addEventListener(k, v) { (this.listeners[k] ||= []).push(v); },
        querySelector: k => node(k),
        querySelectorAll: () => [],
        closest: k => node(k),
        appendChild(child) { this.children.push(child); },
        scrollIntoView() {},
        focus() { this.focused = true; },
        click() {}
      });
    }
    return nodes.get(key);
  }

  const form = node('#workspace-form');
  form.elements = Object.fromEntries(
    ['name', 'slug', 'category', 'descriptor', 'cardTitle', 'cardSummary', 'description', 'imageAlt', 'sortOrder']
      .map(key => [key, node(key)])
  );
  form.reportValidity = () => true;

  const draft = node('[data-save=draft]'), publish = node('[data-save=publish]');
  draft.dataset.save = 'draft';
  publish.dataset.save = 'publish';

  const popupInit = node('#product-success-popup');
  popupInit.hidden = true;
  popupInit.innerHTML = '<div class="product-success-popup-card"><h2 id="product-success-title">Đã lưu sản phẩm thành công</h2><p class="product-success-sub">Đang tự động chuyển hướng về trang quản lý sản phẩm…</p></div>';

  const mockStorage = new Map();
  let redirectedUrl = null;
  const existingId = 'prod-123-abc';

  const existingProduct = {
    id: existingId,
    version: 2,
    updatedAt: '2026-10-28T00:00:00.000Z',
    product: {
      name: 'Micro GAERU K9 Pro',
      slug: 'gaeru-k9-pro',
      category: 'audio',
      descriptor: 'Thu âm',
      cardTitle: 'K9 Pro',
      cardSummary: 'Chống ồn',
      description: 'Mô tả',
      imageUrl: '/assets/products/k9.webp',
      imageAlt: 'Micro K9',
      active: true,
      sortOrder: 1
    },
    gallery: ['/assets/products/k9.webp'],
    groups: [],
    variants: [{
      id: 'var-1',
      sku: 'K9-PRO-01',
      name: 'Tiêu chuẩn',
      options: {},
      priceVnd: 350000,
      stockQuantity: 20,
      active: true,
      imageUrl: ''
    }]
  };

  const context = {
    document: {
      querySelector: node,
      getElementById: id => node('#' + id),
      querySelectorAll: selector => selector === '[data-save]' ? [draft, publish] : [],
      createElement: tag => node(tag),
      body: node('body')
    },
    window: {
      GAERUVariantChoices: choices,
      GAERUAdminUI: ui,
      addEventListener() {}
    },
    location: {
      pathname: `/gaeru_ceo/products/${existingId}/edit`,
      search: '',
      assign: (url) => { redirectedUrl = url; },
      set href(url) { redirectedUrl = url; },
      get href() { return redirectedUrl; }
    },
    sessionStorage: {
      setItem: (k, v) => mockStorage.set(k, v),
      getItem: (k) => mockStorage.get(k),
      removeItem: (k) => mockStorage.delete(k)
    },
    history: { replaceState() {} },
    console,
    FormData: class { append() {} },
    WeakMap,
    setTimeout: (fn, ms) => { fn(); },
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    fetch: async (path, options = {}) => {
      if (path === '/api/auth/me') {
        return { ok: true, json: async () => ({ authenticated: true, permissions: ['catalog.read', 'catalog.write', 'inventory.approve'] }) };
      }
      if (path === '/api/csrf') {
        return { ok: true, json: async () => ({ csrfToken: 'fixture-csrf' }) };
      }
      if (path === `/api/gaeru_ceo/product-workspace/${existingId}`) {
        return { ok: true, json: async () => structuredClone(existingProduct) };
      }
      if (path === '/api/gaeru_ceo/product-workspace' && options.method === 'POST') {
        const payload = JSON.parse(options.body);
        return { ok: true, json: async () => ({ ...existingProduct, ...payload, version: 3 }) };
      }
      return { ok: true, json: async () => ({}) };
    }
  };

  const { readAdminBundle } = require('./helpers/admin-sources');
  const scriptSource = readAdminBundle(['format.js', 'product-editor-media.js', 'product-editor-variants.js', 'product-editor.js']);
  vm.createContext(context);
  vm.runInContext(scriptSource, context);

  await new Promise(r => setTimeout(r, 30));

  // Save the edited product
  await draft.onclick();

  // Verify popup and redirect to /gaeru_ceo#products
  assert.equal(mockStorage.get('gaeru:product-added-notice'), 'Đã sửa sản phẩm thành công');
  assert.equal(redirectedUrl, '/gaeru_ceo#products');

  const popupNode = node('#product-success-popup');
  assert.equal(popupNode.querySelector('#product-success-title').textContent, 'Đã sửa sản phẩm thành công');
  assert.equal(popupNode.hidden, false, 'Popup must be visible');
});

test('admin.js includes showProductAddedPopup and checkProductAddedNotice for product management', () => {
  const { readAdminBundle } = require('./helpers/admin-sources'); const adminJs = readAdminBundle(['admin.js', 'admin-catalog.js']);
  assert.ok(adminJs.includes('function showProductAddedPopup'), 'Must define showProductAddedPopup');
  assert.ok(adminJs.includes('function checkProductAddedNotice'), 'Must define checkProductAddedNotice');
  assert.ok(adminJs.includes('checkProductAddedNotice()'), 'Must call checkProductAddedNotice in products view');
  assert.ok(adminJs.includes('showProductAddedPopup("Đã thêm sản phẩm mới thành công")'), 'Must show popup on new product save');
  assert.ok(adminJs.includes('showProductAddedPopup("Đã sửa sản phẩm thành công")'), 'Must show popup on edit product save');
});
