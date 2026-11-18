'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { productCard: ssrProductCard } = require('../src/seo-pages');

const ROOT = path.resolve(__dirname, '..');

test('PageSpeed A11y & CLS: #site-header reserves height, discover-k9 video has captions track, news has h2, cards avoid nested interactive role=link', () => {
  const styles = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.match(styles, /#site-header\s*\{[^}]*min-height:\s*52px/);
  assert.match(styles, /#site-header\s*\{\s*min-height:\s*50px/);
  assert.match(styles, /--blue:\s*#0060c7/);
  assert.match(styles, /--teal:\s*#066873/);
  assert.match(styles, /\.cart-loading\s*\{[^}]*min-height:\s*360px/);

  const discoverCss = fs.readFileSync(path.join(ROOT, 'discover.css'), 'utf8');
  assert.match(discoverCss, /\.discover-light-page \.discover-hero>\.k9-loop/);

  const discoverK9 = fs.readFileSync(path.join(ROOT, 'discover-k9.html'), 'utf8');
  assert.match(discoverK9, /<track[^>]*kind="captions"[^>]*src="\/assets\/videos\/k9-captions\.vtt"/);
  assert.equal(fs.existsSync(path.join(ROOT, 'assets', 'videos', 'k9-captions.vtt')), true);

  const newsHtml = fs.readFileSync(path.join(ROOT, 'news.html'), 'utf8');
  assert.match(newsHtml, /<h1[\s\S]*?<h2[\s\S]*?data-news-list/);

  const cardHtml = ssrProductCard({
    slug: 'gaeru-k9',
    name: 'GAERU K9',
    descriptor: 'MICRO KHÔNG DÂY',
    cardTitle: 'GAERU K9',
    cardSummary: 'Thu âm rõ nét.',
    category: 'audio',
    imageUrl: '/assets/products/k9.webp',
    imageAlt: 'GAERU K9',
    variants: [{ id: 'k9-1', sku: 'K9-1', name: '1 Mic', priceVnd: 237300, active: true, stockQuantity: 5 }]
  }, false);
  const cardDoc = parseHTML(cardHtml).document;
  const article = cardDoc.querySelector('article.catalog-card');
  assert.equal(article.getAttribute('role'), null);
  assert.equal(article.getAttribute('tabindex'), null);
  assert.ok(cardDoc.querySelector('a.catalog-card-image').getAttribute('aria-label'));
});

test('PageSpeed Perf: storefront HTML defers chat client JS/CSS and k9-loop prefers AVIF renditions inside <picture>', () => {
  for (const htmlFile of fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(ROOT, htmlFile), 'utf8');
    assert.equal(html.includes('shopping-chat-client.js'), false, `${htmlFile} should lazy-load shopping-chat-client.js via product-services.js`);
    assert.equal(html.includes('shopping-chat.css'), false, `${htmlFile} should lazy-load shopping-chat.css via product-services.js`);
  }

  const { window, document } = parseHTML('<!doctype html><html><body><div style="width:360px"><picture><source type="image/avif" srcset="/assets/products/k9-display-480-f7433a67675b.avif 480w, /assets/products/k9-display-800-19cce68491be.avif 800w"><img data-k9-animate src="/assets/products/k9.webp" alt="GAERU K9" width="750" height="650"></picture></div></body></html>');
  window.innerWidth = 412;
  window.devicePixelRatio = 2.625;
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  const k9Loop = require('../k9-loop');
  const ctrl = k9Loop.createController({ window, document });
  ctrl.scan();
  const img = document.querySelector('[data-k9-loop] image.k9-double');
  assert.equal(img.getAttribute('href'), '/assets/products/k9-display-480-f7433a67675b.avif');
  ctrl.destroy();
});
