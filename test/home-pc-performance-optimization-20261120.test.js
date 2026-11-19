const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('styles.css eliminates heavy blur(65px/90px/24px), animated backdrop-filter, and per-pixel pointermove radial paint', () => {
  const css = read('styles.css');
  assert.doesNotMatch(css, /filter:\s*blur\((?:48|65|90)px\)/, 'Glow accents must use zero-cost radial-gradient instead of GPU blur');
  assert.doesNotMatch(css, /backdrop-filter:\s*saturate\(180%\)\s*blur\((?:20|24)px\)/, 'Must not run heavy 20-24px backdrop-filter on sticky header or opaque panels');
  assert.doesNotMatch(css, /transition:[^;]*backdrop-filter/, 'Must never animate backdrop-filter radius across frames');
  assert.doesNotMatch(css, /var\(--pointer-x/, 'Cards must not mutate per-pixel CSS variables to repaint radial gradients on mouse move');
  assert.match(css, /scrollbar-gutter:\s*stable;/, 'Prevent Windows scrollbar hide/show layout reflow when opening panels');
});

test('home-responsive.css applies content-visibility:auto to below-the-fold homepage sections', () => {
  const css = read('home-responsive.css');
  assert.match(css, /content-visibility:\s*auto;/);
  assert.match(css, /contain-intrinsic-size:/);
});

test('store-shell.js removes unthrottled pointermove storm, forced panel reflow, and per-scroll getBoundingClientRect', () => {
  const js = read('store-shell.js');
  assert.doesNotMatch(js, /addEventListener\("pointermove"/, 'Must not attach document-level pointermove card repaint storm');
  assert.doesNotMatch(js, /void panel\.offsetWidth/, 'Must not force synchronous reflow when opening header panels');
  assert.doesNotMatch(js, /--hero-parallax/, 'Hero scroll effect must use cached metrics + direct transform');
  assert.match(js, /measureScrollMetrics/);
});

test('seo-pages.js lazy-loads all offscreen homepage news cards while keeping /news.html first 3 cards eager', () => {
  const { newsCards } = require('../src/seo-pages');
  const sample = Array.from({ length: 5 }, (_, i) => ({
    slug: `post-${i}`,
    coverId: `c0000000-0000-4000-8000-00000000000${i}`,
    title: `Bài ${i}`,
    excerpt: `Tóm tắt ${i}`,
    imageAlt: `Ảnh ${i}`,
    publishedAt: '2026-11-19T00:00:00Z'
  }));
  const homeHtml = newsCards(sample, false, { allLazy: true });
  assert.equal((homeHtml.match(/loading="lazy"/g) || []).length, 5, 'All homepage offscreen news images must be lazy');
  assert.equal(homeHtml.includes('fetchpriority="high"'), false, 'Offscreen homepage news must never compete with Hero LCP');

  const newsPageHtml = newsCards(sample, false, { allLazy: false });
  assert.equal((newsPageHtml.match(/loading="lazy"/g) || []).length, 2, 'News page keeps first 3 cards eager and rest lazy');
  assert.equal(newsPageHtml.includes('fetchpriority="high"'), true, 'News page card #0 keeps high fetchpriority');
});

test('google-analytics.js defers bootstrap to post-load idle without blocking first scroll/click', () => {
  const js = read('google-analytics.js');
  assert.doesNotMatch(js, /\['pointerdown',\s*'keydown',\s*'touchstart',\s*'scroll'\]/, 'Must not evaluate 195KB gtag.js synchronously on first interaction');
  assert.match(js, /requestIdleCallback/);
});

test('product-services.js caches saved list, debounces MutationObserver with rAF, and defers CSRF prefetch to idle', () => {
  const js = read('product-services.js');
  assert.match(js, /let savedCache=null/);
  assert.match(js, /function scheduleUpdate\(\)/);
  assert.match(js, /new MutationObserver\(scheduleUpdate\)/);
  assert.match(js, /scheduleCsrfPrefetch/);
});
