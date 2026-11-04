'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const vm = require('node:vm'), fs = require('node:fs');
function fixture() {
  const { window, document } = parseHTML('<section class="product-section"><button data-filter="all"></button><button data-filter="audio"></button><button data-filter="video"></button><div class="product-grid" tabindex="0"><article class="product-card" data-kind="audio"><a href="/san-pham/k9">K9</a></article><article class="product-card" data-category="video">P01</article><article class="product-card" data-kind="audio">M3</article></div><p class="filter-status"></p></section>');
  const rail = document.querySelector('.product-grid'), calls = [];
  Object.defineProperties(rail, { clientWidth: { value: 500 }, scrollWidth: { value: 950 } });
  rail.scrollLeft = 0; rail.scrollTo = options => { calls.push(options); rail.scrollLeft = Math.max(0, Math.min(450, options.left)); };
  for (const card of rail.children) card.getBoundingClientRect = () => ({ width: 440 });
  window.matchMedia = () => ({ matches: true });
  vm.runInNewContext(fs.readFileSync('script.js', 'utf8'), { window, document, getComputedStyle: () => ({ columnGap: '18px' }) });
  return { window, document, rail, calls };
}
function key(f, key, target = f.rail) { const event = new f.window.Event('keydown', { bubbles: true, cancelable: true }); event.key = key; target.dispatchEvent(event); return event; }
test('home product rail keeps two-row column navigation keyboard accessible without taking keys from child links', () => {
  const f = fixture();
  assert.equal(key(f, 'ArrowRight').defaultPrevented, true); assert.equal(f.calls.at(-1).left, 458);
  key(f, 'Home'); assert.equal(f.calls.at(-1).left, 0);
  key(f, 'End'); assert.equal(f.calls.at(-1).left, 450);
  key(f, 'ArrowLeft'); assert.equal(f.calls.at(-1).left, -8);
  const before = f.calls.length; assert.equal(key(f, 'ArrowRight', f.document.querySelector('a')).defaultPrevented, false); assert.equal(f.calls.length, before);
});
test('filtering a scrolled product rail returns to its first column and supports server-rendered category attributes', () => {
  const f = fixture(); key(f, 'End'); f.document.querySelector('[data-filter="video"]').click();
  assert.equal(f.rail.scrollLeft, 0); assert.equal(f.document.querySelectorAll('.product-card:not([hidden])').length, 1);
  assert.equal(f.document.querySelector('.product-card:not([hidden])').textContent, 'P01');
  assert.equal(f.document.querySelector('.filter-status').textContent, '1 sản phẩm');
  f.document.querySelector('[data-filter="all"]').click(); assert.equal(f.document.querySelectorAll('.product-card:not([hidden])').length, 3);
});
