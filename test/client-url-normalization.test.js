const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

test('browser URL normalization rewrites responsive images and continues with later links', () => {
  const { document } = parseHTML('<html><body><img srcset="https://www.gaeru.com/assets/products/k9.webp 1x, https://gaeru.org/assets/products/k9.webp 2x"><a href="shop.html">Shop</a></body></html>');
  let observerCallback;
  const context = {
    window: {}, document, URL,
    location: { origin: 'https://gaeru.com', pathname: '/', search: '' },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
    }
  };
  assert.doesNotThrow(() => vm.runInNewContext(fs.readFileSync(require.resolve('../clean-urls.js'), 'utf8'), context));
  assert.equal(document.querySelector('img').getAttribute('srcset'), '/assets/products/k9.webp 1x, /assets/products/k9.webp 2x');
  assert.equal(document.querySelector('a').getAttribute('href'), '/cua-hang');
  assert.equal(typeof observerCallback, 'function');

  const image = document.createElement('img');
  image.setAttribute('srcset', 'https://www.gaeru.com/assets/products/m3.webp 480w');
  document.body.append(image);
  assert.doesNotThrow(() => observerCallback([{ type: 'attributes', target: image }]));
  assert.equal(image.getAttribute('srcset'), '/assets/products/m3.webp 480w');
});
