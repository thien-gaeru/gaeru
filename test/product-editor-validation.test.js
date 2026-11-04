'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ui = require('../admin/admin-ui');
const choices = require('../variant-choices');

test('product editor highlights invalid fields with red borders and specific error notices', async () => {
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

  let postPayload = null;
  const context = {
    document: {
      querySelector: node,
      getElementById: id => node('#' + id),
      querySelectorAll: selector => {
        if (selector === '[data-save]') return [draft, publish];
        if (selector === '.is-invalid') return [...nodes.values()].filter(n => n.classList.contains('is-invalid'));
        return [];
      },
      createElement: tag => node(tag)
    },
    window: {
      GAERUVariantChoices: choices,
      GAERUAdminUI: ui,
      addEventListener() {}
    },
    location: { pathname: '/gaeru_ceo/products/new', search: '' },
    history: { replaceState() {} },
    FormData: class {},
    WeakMap,
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    fetch: async (path, options = {}) => {
      if (path === '/api/auth/me') {
        return { ok: true, json: async () => ({ authenticated: true, permissions: ['catalog.read', 'catalog.write', 'inventory.approve'] }) };
      }
      if (path === '/api/csrf') {
        return { ok: true, json: async () => ({ csrfToken: 'fixture-csrf' }) };
      }
      if (path === '/api/gaeru_ceo/product-workspace' && options.method === 'POST') {
        postPayload = JSON.parse(options.body);
        return { ok: true, json: async () => ({ id: 'new-product-id', version: 1, product: postPayload.product, gallery: postPayload.gallery, variants: postPayload.variants, groups: postPayload.groups }) };
      }
      return { ok: true, json: async () => ({}) };
    }
  };

  const scriptSource = fs.readFileSync(require.resolve('../admin/product-editor.js'), 'utf8');
  vm.createContext(context);
  vm.runInContext(scriptSource, context);

  // Wait for initial load
  await new Promise(r => setTimeout(r, 20));

  // 1. Try to save with empty name -> should highlight name with .is-invalid
  form.elements.name.value = 'a'; // too short (< 2)
  await draft.onclick();
  assert.ok(form.elements.name.classList.contains('is-invalid'), 'Name input must have is-invalid class');

  // Fix name
  form.elements.name.value = 'Micro Thu Âm GAERU K9';
  form.elements.slug.value = 'micro-thu-am-gaeru-k9';

  // 2. Try to save without gallery -> should highlight #gallery
  const galleryNode = node('#gallery');
  await draft.onclick();
  assert.ok(galleryNode.classList.contains('is-invalid'), 'Gallery must have is-invalid class when empty');
});
