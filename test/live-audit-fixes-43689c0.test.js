'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const ROOT = path.join(__dirname, '..');

test('Header search in store-shell.js matches "micro", Vietnamese diacritic-free queries, and clears on panel close', async () => {
  const { window, document } = parseHTML('<!doctype html><html lang="vi"><body><div id="site-header"></div><main></main><div id="site-footer"></div></body></html>');
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = (fn) => { fn(); return 1; };
  window.scrollTo = () => {};
  window.GAERUStore = { searchProducts: () => [] };

  const sampleIndex = [
    { name: 'GAERU M3', slug: 'gaeru-m3', sku: 'M3-01', desc: 'mic không dây cài áo có hộp sạc cao cấp', category: 'audio', imageUrl: '/assets/products/m3-home-cutout.webp', tags: ['GAERU M3', 'audio'] },
    { name: 'GAERU K9', slug: 'gaeru-k9', sku: 'K9IP1M', desc: 'Mic không dây cài áo hỗ trợ giảm ồn tạp âm', category: 'audio', imageUrl: '/assets/products/k9.webp', tags: ['GAERU K9', 'audio'] },
    { name: 'GAERU P01', slug: 'gaeru-p01', sku: 'P01TP', desc: 'Gimbal AI tự động quay theo người', category: 'video', imageUrl: '/assets/products/p01.webp', tags: ['GAERU P01', 'video'] },
    { name: 'GAERU P185', slug: 'gaeru-p185', sku: 'P185', desc: 'Gậy chụp hình selfie nhỏ gọn cầm tay', category: 'accessory', imageUrl: '/assets/products/p185-cutout-1cc9dfde9fa3.webp', tags: ['GAERU P185', 'accessory'] }
  ];

  const src = fs.readFileSync(path.join(ROOT, 'store-shell.js'), 'utf8');
  const ctx = {
    window,
    document,
    location: { pathname: '/', search: '', hash: '', origin: 'https://gaeru.com' },
    history: { replaceState() {} },
    navigator: { userAgent: 'test' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    CustomEvent: window.CustomEvent,
    Event: window.Event,
    Node: window.Node,
    HTMLScriptElement: { supports: () => false },
    URLSearchParams,
    requestAnimationFrame: window.requestAnimationFrame,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout() {},
    fetch: async (url) => ({
      ok: true,
      json: async () => (String(url).includes('search-index') ? sampleIndex : { products: [] })
    })
  };
  ctx.window.setTimeout = ctx.setTimeout;
  ctx.window.clearTimeout = ctx.clearTimeout;
  ctx.globalThis = ctx;

  vm.runInNewContext(src, ctx);

  const searchToggle = document.querySelector('.search-toggle');
  const searchInput = document.querySelector('#search-query');
  const searchResults = document.querySelector('#search-results');
  const searchQuicklinks = document.querySelector('[data-search-quicklinks]');

  searchToggle.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setImmediate(r));

  // Typing "micro" must match microphone products even when desc only contains "mic"
  searchInput.value = 'micro';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.match(searchResults.innerHTML, /GAERU M3/);
  assert.match(searchResults.innerHTML, /GAERU K9/);
  assert.equal(searchQuicklinks.hidden, true);

  // Diacritic-free query "gay selfie" must match GAERU P185
  searchInput.value = 'gay selfie';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.match(searchResults.innerHTML, /GAERU P185/);

  // Closing the search panel resets query, results, and restores quicklinks
  document.querySelector('#search-panel .panel-close').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(searchInput.value, '');
  assert.equal(searchResults.innerHTML, '');
  assert.equal(searchQuicklinks.hidden, false);
});

test('src/store-api.js enriches /api/search-index.json tags with category search keywords', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/store-api.js'), 'utf8');
  assert.match(src, /CATEGORY_SEARCH_KEYWORDS/);
  assert.match(src, /"micro"/);
  assert.match(src, /"gimbal"/);
  assert.match(src, /"gậy selfie"/);
});

test('checkout.html includes initial loading placeholder to avoid white flash before hydration', () => {
  const html = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');
  assert.match(html, /id="checkout-content"[^>]*aria-live="polite"[^>]*><p class="cart-loading">Đang tải thông tin thanh toán…<\/p>/);
});

test('SSR responsive-images restricts .news-card srcset to 480w/800w while keeping .news-cover up to 1600w', () => {
  const responsive = require('../src/responsive-images');
  const newsId = 'c0000000-0000-4000-8000-000000000010';
  const { document } = parseHTML(`<!doctype html><html><head></head><body>
    <a class="news-card" href="/tin-tuc/sample"><img src="/api/news-images/${newsId}?v=1" alt="Card"></a>
    <article><img class="news-cover" src="/api/news-images/${newsId}?v=1" alt="Cover"></article>
  </body></html>`);

  responsive.apply(document);

  const cardImg = document.querySelector('.news-card img');
  const cardAvif = cardImg.parentElement.querySelector('source[type="image/avif"]');
  assert.match(cardAvif.getAttribute('srcset'), /\b480w\b/);
  assert.match(cardAvif.getAttribute('srcset'), /\b800w\b/);
  assert.doesNotMatch(cardAvif.getAttribute('srcset'), /\b1200w\b/);
  assert.doesNotMatch(cardAvif.getAttribute('srcset'), /\b1600w\b/);

  const coverImg = document.querySelector('.news-cover');
  const coverAvif = coverImg.parentElement.querySelector('source[type="image/avif"]');
  assert.match(coverAvif.getAttribute('srcset'), /\b1200w\b/);
  assert.match(coverAvif.getAttribute('srcset'), /\b1600w\b/);
});

test('All visible form inputs across all 36 HTML files have accessible labels and Google OAuth button uses light color-scheme', () => {
  const htmlFiles = [
    ...fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).map((f) => path.join(ROOT, f)),
    ...fs.readdirSync(path.join(ROOT, 'admin')).filter((f) => f.endsWith('.html')).map((f) => path.join(ROOT, 'admin', f))
  ];
  const unlabeled = [];
  for (const full of htmlFiles) {
    const { document } = parseHTML(fs.readFileSync(full, 'utf8'));
    for (const inp of document.querySelectorAll('input:not([type="hidden"]), select, textarea')) {
      if (inp.hasAttribute('hidden')) continue;
      const id = inp.getAttribute('id');
      const hasLabel = Boolean(
        inp.closest('label') ||
        (id && document.querySelector(`label[for="${id}"]`)) ||
        inp.getAttribute('aria-label') ||
        inp.getAttribute('aria-labelledby') ||
        inp.getAttribute('title')
      );
      if (!hasLabel) unlabeled.push(path.relative(ROOT, full) + '#' + (id || inp.getAttribute('name') || inp.tagName));
    }
  }
  assert.deepEqual(unlabeled, []);

  const styles = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.match(styles, /\.google-signin-button\{[^}]*color-scheme:light/);
  const accountJs = fs.readFileSync(path.join(ROOT, 'account.js'), 'utf8');
  assert.match(accountJs, /host\.childElementCount>0/);
});
