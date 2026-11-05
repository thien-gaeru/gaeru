'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

test('Home banner admin UI layout structure and control attributes', async () => {
  const scriptContent = fs.readFileSync(path.join(__dirname, '../admin/marketing-home-banner.js'), 'utf8');

  // Verify critical selectors and attributes exist in the script
  assert.ok(scriptContent.includes('dataset.homeBanner'), 'Mounts home banner details panel');
  assert.ok(scriptContent.includes('data-home-banner-form'), 'Form selector exists');
  assert.ok(scriptContent.includes('data-home-banner-status'), 'Status indicator selector exists');
  assert.ok(scriptContent.includes('data-home-banner-summary-status'), 'Summary badge selector exists');
  assert.ok(scriptContent.includes('data-home-banner-upload="desktop"'), 'Desktop upload input exists');
  assert.ok(scriptContent.includes('data-home-banner-upload="mobile"'), 'Mobile upload input exists');
  assert.ok(scriptContent.includes('data-home-banner-preview="desktop"'), 'Desktop preview img exists');
  assert.ok(scriptContent.includes('data-home-banner-preview="mobile"'), 'Mobile preview img exists');
  assert.ok(scriptContent.includes('data-home-banner-clear-mobile'), 'Clear mobile button exists');
  assert.ok(scriptContent.includes('data-sim-tab="desktop"'), 'Desktop simulator tab exists');
  assert.ok(scriptContent.includes('data-sim-tab="mobile"'), 'Mobile simulator tab exists');

  // Verify DOM simulation
  const { document, window } = parseHTML('<!doctype html><html><body><div id="marketing-view"></div></body></html>');
  global.window = window;
  global.document = document;
  global.FormData = class {
    constructor() { this.data = {}; }
    append(k, v) { this.data[k] = v; }
  };
  global.MutationObserver = class {
    observe() {}
    disconnect() {}
  };

  let mockBannerSetting = {
    version: 1,
    enabled: true,
    desktopImageId: '11111111-1111-1111-1111-111111111111',
    mobileImageId: null,
    alt: 'GAERU Banner',
    href: '/cua-hang'
  };

  window.GAERUAdmin = {
    can: () => true,
    request: async (url, opts) => {
      if (url.includes('/home-banner') && opts?.method === 'PUT') {
        const body = JSON.parse(opts.body);
        mockBannerSetting = { ...mockBannerSetting, ...body, version: mockBannerSetting.version + 1 };
        return mockBannerSetting;
      }
      return mockBannerSetting;
    }
  };

  // Execute the script
  new Function('window', 'document', 'FormData', 'MutationObserver', scriptContent)(window, document, global.FormData, global.MutationObserver);

  const panel = document.querySelector('details.configuration-panel[data-home-banner]');
  assert.ok(panel, 'Configuration panel mounted in DOM');

  const summary = panel.querySelector('summary');
  assert.ok(summary, 'Summary element exists');
  assert.ok(summary.textContent.includes('Banner Trang Chủ'), 'Summary title is clear');

  const form = panel.querySelector('form[data-home-banner-form]');
  assert.ok(form, 'Form exists');

  // Trigger open to load
  panel.open = true;
  panel.dispatchEvent(new window.Event('toggle'));

  // Allow microtasks to resolve
  await new Promise(r => setTimeout(r, 50));

  const enabledInput = form.querySelector('[name="enabled"]');
  const altInput = form.querySelector('[name="alt"]');
  const hrefInput = form.querySelector('[name="href"]');

  assert.equal(enabledInput.checked, true, 'Enabled toggle synced');
  assert.equal(altInput.value, 'GAERU Banner', 'Alt field synced');
  assert.equal(hrefInput.value, '/cua-hang', 'Href field synced');

  const desktopImg = panel.querySelector('[data-home-banner-preview="desktop"]');
  assert.ok(desktopImg && !desktopImg.hidden, 'Desktop preview visible when image exists');
  assert.ok(desktopImg.src.includes('11111111-1111-1111-1111-111111111111'), 'Desktop image src set');

  const mobileClearBtn = panel.querySelector('[data-home-banner-clear-mobile]');
  assert.ok(mobileClearBtn.hidden, 'Clear mobile button hidden when no separate mobile image');

  // Verify switch toggle class
  const toggleSwitch = panel.querySelector('.home-banner-toggle-switch');
  assert.ok(toggleSwitch, 'iOS style toggle switch exists');

  // Verify dropzones
  assert.ok(panel.querySelector('[data-dropzone="desktop"]'), 'Desktop dropzone exists');
  assert.ok(panel.querySelector('[data-dropzone="mobile"]'), 'Mobile dropzone exists');
});
