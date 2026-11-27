'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Storefront display audit remediation (SF-01..SF-20)', () => {
  // SF-01: product-purchase.css does not re-hide .price-text-compact between 601px and 768px
  const purchaseCss = read('product-purchase.css');
  assert.ok(!purchaseCss.includes('.price-text-compact{display:none}'), 'product-purchase.css must not duplicate .price-text-compact{display:none}');
  const typographyCss = read('typography.css');
  assert.match(typographyCss, /@media\(max-width:768px\)\{\.price-text-full\{display:none\}\.price-text-compact\{display:inline\}\}/);

  // SF-02: .discover-light-page .button-outline is high-contrast on light hero/close backgrounds
  const stylesCss = read('styles.css');
  assert.match(stylesCss, /\.discover-page:not\(\.discover-light-page\)\s+\.button-outline/);
  const discoverCss = read('discover.css');
  assert.match(discoverCss, /\.discover-light-page\s+\.button-outline/);

  // SF-03 & SF-04: cart/checkout collapse cleanly <=960px and summary-total wraps without overflow
  assert.match(stylesCss, /@media\s*\(max-width:\s*960px\)/);
  assert.match(stylesCss, /\.cart-summary\s*>\s*p:not\(\.prototype-note\)[^}]*flex-wrap:\s*wrap/);
  assert.match(stylesCss, /\[data-checkout-total\][^}]*white-space:\s*normal/);

  // SF-05: mobile <=760px keeps right padding for .panel-close on search & mini-cart
  assert.match(stylesCss, /\.search-form\s*\{[^}]*padding-right:\s*54px/);
  assert.match(stylesCss, /\.cart-panel-heading\s*\{[^}]*padding-right:\s*54px/);

  // SF-06, SF-18, SF-19, SF-20: tracking.css mobile wrapping, contrast & minmax tracks
  const trackingCss = read('tracking.css');
  assert.match(trackingCss, /\.carrier-info\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(trackingCss, /\.result-header\s+h2\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(trackingCss, /\.pill-warning\s*\{[^}]*#9a5200/);
  assert.ok(!trackingCss.includes('#86868b'), 'tracking.css must not use low-contrast #86868b');
  assert.match(trackingCss, /\.summary-grid\s*\{[^}]*minmax\(0,\s*1fr\)/s);

  // SF-07 & SF-16: shopping-chat .chat-reference spans full grid, header fits 320px, lightbox wraps
  const chatCss = read('shopping-chat.css');
  assert.match(chatCss, /\.chat-reference\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  assert.match(chatCss, /@media\s*\(max-width:\s*390px\)/);
  assert.match(chatCss, /\.chat-lightbox-bar[^}]*flex-wrap:\s*wrap/s);

  // SF-08 & SF-14: account-security.css scopes 390px form away from modals & center-popup scrolls with dvh
  const accSecCss = read('account-security.css');
  assert.ok(!/^\.account-page\s+\.account-form\s*\{/m.test(accSecCss), 'Unscoped .account-page .account-form max-width:390px must not crush modals');
  assert.match(accSecCss, /\.center-popup-card[^}]*100dvh/s);
  assert.match(accSecCss, /\.center-popup-card[^}]*overflow-y:\s*auto/s);
  const accUpgradeCss = read('account-upgrade.css');
  assert.match(accUpgradeCss, /92dvh/);
  assert.match(accUpgradeCss, /calc\(100dvh\s*-\s*24px\)/);
  assert.ok(!accUpgradeCss.includes('background: inherit !important;'), 'Open security accordion icon must not inherit white header bg over white text');

  // SF-09 & SF-10: care.css responsive pills, bounded media & dropdowns below #site-header (z-index: 50)
  const careCss = read('care.css');
  assert.match(careCss, /max-width:\s*1040px/);
  assert.match(careCss, /\.care-msg-img\{[^}]*min\(240px,\s*100%\)/);
  assert.match(careCss, /\.care-msg-video\{[^}]*min\(280px,\s*100%\)/);
  assert.match(careCss, /#warranty-form\s+\.w-prod-dropdown\{[^}]*z-index:\s*40\b/);
  const vnAddrCss = read('vietnam-address.css');
  assert.match(vnAddrCss, /\.vn-address-panel\{[^}]*z-index:\s*45\b/);

  // SF-11: news recommendation CTAs rely on news.css without overriding inline styles
  const newsJs = read('news.js');
  const seoPagesJs = read('src/seo-pages.js');
  assert.ok(!/<div[^>]*class="article-product-recommend"[^>]*style=/.test(newsJs));
  assert.ok(!/<div[^>]*class="article-bottom-cta"[^>]*style=/.test(newsJs));
  assert.ok(!/<div[^>]*class="article-product-recommend"[^>]*style=/.test(seoPagesJs));
  assert.ok(!/<div[^>]*class="article-bottom-cta"[^>]*style=/.test(seoPagesJs));

  // SF-12: bundle cross-sell bounded on narrow mobile
  assert.match(purchaseCss, /\.bundle-item-info\{[^}]*min-width:\s*0/);

  // SF-13: buyer voucher currency badge nowrap & stacked on narrow screens
  const marketingCss = read('marketing.css');
  assert.match(marketingCss, /@media\s*\(max-width:\s*480px\)/);
  assert.match(marketingCss, /white-space:\s*nowrap/);

  // SF-15: product-local-subnav uses min-height & >=40px mobile CTA
  const expCss = read('product-experience.css');
  assert.match(expCss, /\.product-local-subnav-inner[^}]*min-height:\s*52px/s);
  assert.match(expCss, /\.product-local-subnav-btn[^}]*min-height:\s*40px/s);

  // SF-14/SF-19: action-feedback modal dvh + dark toast close button
  const afCss = read('action-feedback.css');
  assert.match(afCss, /\.gaeru-modal-card[^}]*100dvh/s);
  assert.match(afCss, /#52525b/);
  assert.ok(!stylesCss.includes('#86868b'), 'styles.css must not use low-contrast #86868b');
});

test('Admin Portal & Mi6 Server Console display audit remediation (AD-01..AD-20, MI6-01..MI6-04)', () => {
  // AD-01, AD-12, AD-14, AD-16, AD-19
  const adminMobile = read('admin/admin-mobile.css');
  assert.match(adminMobile, /\.admin-shell\s+\.sidebar\{[^}]*width:\s*100%;\s*min-width:\s*0/);
  assert.match(adminMobile, /\.admin-shell\s+\.filter-bar,\s*\.admin-shell\s+\.enterprise-filters\{[^}]*display:\s*grid/);
  assert.match(adminMobile, /home-banner-toggle-switch/);
  assert.match(adminMobile, /\.choice-chip\s+button/);
  assert.match(adminMobile, /\.admin-shell\s+\.chat-folder-close-btn/);

  // AD-02, AD-03, AD-09, AD-10
  const aiCss = read('admin/internal-ai.css');
  assert.match(aiCss, /\.copilot-container\.in-modal\s+\.copilot-header-info\s*>\s*:not\(\.copilot-mobile-threads-btn\)/);
  assert.match(aiCss, /\.copilot-sidebar\.is-mobile-open\s*\{[^}]*z-index:\s*10020/s);
  assert.match(aiCss, /body:has\(#shopping-chat-view:not\(\[hidden\]\)\)\s+\.floating-copilot-trigger/);
  assert.match(aiCss, /@media\s*\(max-width:\s*1024px\)/);

  // AD-04, AD-05, AD-06, AD-07, AD-08, AD-15, AD-18
  const ordersCss = read('admin/orders-workspace.css');
  assert.match(ordersCss, /#order-processing-dialog\.order-modal-compact\s*>\s*header\.order-modal-header\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(ordersCss, /top:\s*calc\(64px\s*\+\s*env\(safe-area-inset-top,\s*0px\)\)/);
  assert.ok(!ordersCss.includes('.page-manager-list{'), '.page-manager-list must live in eager admin-workspace.css, not lazy orders-workspace.css');
  assert.match(ordersCss, /#orders-view\s+\.order-action-cell\s+small/);
  assert.match(ordersCss, /@media\s*\(max-width:\s*960px\)/);

  // AD-06, AD-11, AD-13, AD-15, AD-20
  const wsCss = read('admin/admin-workspace.css');
  assert.match(wsCss, /\.page-manager-list\s*\{/);
  assert.match(wsCss, /\.list-toolbar\s*\{/);
  assert.match(wsCss, /\.card-actions\s*\{/);
  assert.match(wsCss, /\.barcode-form-grid/);
  assert.match(wsCss, /\.config-modal-dialog\s*\{[^}]*max-height:\s*90dvh/s);
  assert.match(wsCss, /\.config-url-row\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(wsCss, /\.danger-button:disabled/);

  // AD-11 & AD-17 JS
  const barcodeJs = read('admin/barcode.js');
  assert.match(barcodeJs, /class="barcode-form-grid"/);
  assert.match(barcodeJs, /minmax\(min\(260px,\s*100%\),\s*1fr\)/);
  const adminCareJs = read('admin/care.js');
  assert.match(adminCareJs, /max-width:min\(280px,100%\)/);
  assert.match(adminCareJs, /max-width:min\(240px,100%\)/);

  // MI6-01..MI6-04 + pure LF + valid inline JS syntax
  const mi6Html = read('infra/mi6/admin/public/index.html');
  assert.ok(!mi6Html.includes('\r'), 'infra/mi6/admin/public/index.html must remain pure LF');
  assert.match(mi6Html, /@media\s*\(max-width:\s*640px\)/);
  assert.match(mi6Html, /\.table-wrap\{[^}]*overflow-x:\s*auto/);
  assert.ok(!mi6Html.includes('grid-template-columns:1fr 1fr'), 'PG grid must use responsive .pg-grid class');
  assert.match(mi6Html, /dialog\{[^}]*90dvh/);
  assert.match(mi6Html, /#login\{[^}]*align-items:\s*flex-start/);
  assert.match(mi6Html, /resizeTerm/);
  assert.match(mi6Html, /ResizeObserver/);
  assert.match(mi6Html, /visualViewport/);
  assert.match(mi6Html, /min\(420px,\s*calc\(100vw\s*-\s*32px\)\)/);
  assert.match(mi6Html, /\.card\s+h3\{[^}]*flex-wrap:\s*wrap/);
  const scriptMatch = mi6Html.match(/<script>\n([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Mi6 inline script must be present');
  assert.doesNotThrow(() => new vm.Script(scriptMatch[1]), 'Mi6 inline script must parse cleanly');
});

test('All modified CSS and JS assets minify cleanly under production esbuild', () => {
  const cssAssets = [
    'product-purchase.css', 'product-experience.css', 'discover.css', 'styles.css',
    'typography.css', 'tracking.css', 'shopping-chat.css', 'news.css', 'guides.css',
    'action-feedback.css', 'account-security.css', 'account-upgrade.css', 'care.css',
    'vietnam-address.css', 'marketing.css', 'product-choices.css',
    'admin/admin-mobile.css', 'admin/internal-ai.css', 'admin/orders-workspace.css',
    'admin/admin-workspace.css'
  ];
  for (const rel of cssAssets) {
    const out = esbuild.transformSync(read(rel), { loader: 'css', minify: true, target: ['chrome90', 'safari14', 'firefox90'] });
    assert.equal(out.warnings.length, 0, `esbuild CSS warnings in ${rel}: ${JSON.stringify(out.warnings)}`);
  }
  const jsAssets = ['commerce.js', 'news.js', 'admin/barcode.js', 'admin/care.js'];
  for (const rel of jsAssets) {
    const out = esbuild.transformSync(read(rel), { loader: 'js', minify: true, target: ['es2020'] });
    assert.equal(out.warnings.length, 0, `esbuild JS warnings in ${rel}: ${JSON.stringify(out.warnings)}`);
  }
});
