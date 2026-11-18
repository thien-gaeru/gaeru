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

test('PageSpeed Perf: cache-warmup warms 160w and cold miss emits no-store CDN cache headers with 480w AVIF fallback', async () => {
  const cacheWarmupSrc = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'cache-warmup.js'), 'utf8');
  assert.match(cacheWarmupSrc, /warmPublicImage\(row,\s*supportedServeWidths\)/);

  const sharp = require('sharp');
  const express = require('express');
  const renditions = require('../src/lib/image-renditions');
  renditions.resetRenditionCache();

  const w = 960, h = 600;
  const rawPixels = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 3;
      rawPixels[idx] = (x * 7 + y * 3) & 255;
      rawPixels[idx + 1] = ((x ^ y) * 5) & 255;
      rawPixels[idx + 2] = (y * 11) & 255;
    }
  }
  const img = await sharp(rawPixels, { raw: { width: w, height: h, channels: 3 } }).webp({ quality: 88 }).toBuffer();
  const row = { content: img, mime_type: 'image/webp' };
  await renditions.warmPublicImage(row, [480]);

  const app = express();
  app.get('/api/catalog-images/:id', (req, res, next) => renditions.sendPublicImage(req, res, row, 'catalog-image').catch(next));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/catalog-images/test-thumb?v=webp-20261025&format=avif&w=160`);
    const body = await res.arrayBuffer();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/avif');
    assert.match(res.headers.get('cache-control') || '', /^public,\s*max-age=0,\s*s-maxage=0,\s*must-revalidate/i);
    assert.equal(res.headers.get('cdn-cache-control'), 'no-store');
    assert.equal(res.headers.get('cloudflare-cdn-cache-control'), 'no-store');
    assert.ok(body.byteLength < img.byteLength, `Expected compact 480w AVIF fallback (${body.byteLength}B) < raw (${img.byteLength}B)`);
  } finally {
    await new Promise((r) => server.close(r));
  }

  // Compact <16KB 160w WebP intentionally has no AVIF rendition and should cache publicly with long TTL
  const smallImg = await sharp({
    create: { width: 480, height: 480, channels: 4, background: { r: 24, g: 112, b: 196, alpha: 1 } }
  }).webp().toBuffer();
  const smallRow = { content: smallImg, mime_type: 'image/webp' };
  await renditions.warmPublicImage(smallRow, [160]);
  const app2 = express();
  app2.get('/api/catalog-images/:id', (req, res, next) => renditions.sendPublicImage(req, res, smallRow, 'catalog-image').catch(next));
  const server2 = app2.listen(0, '127.0.0.1');
  await new Promise((r) => server2.once('listening', r));
  try {
    const res2 = await fetch(`http://127.0.0.1:${server2.address().port}/api/catalog-images/small-thumb?v=webp-20261025&format=avif&w=160`);
    await res2.arrayBuffer();
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get('content-type'), 'image/webp');
    assert.match(res2.headers.get('cache-control') || '', /^public,\s*max-age=3600/i);
  } finally {
    await new Promise((r) => server2.close(r));
  }
});
