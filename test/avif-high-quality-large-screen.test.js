'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { parseHTML } = require('linkedom');

const { encodeAvif } = require('../src/lib/selective-avif');
const {
  widths,
  warmPublicImage,
  sendPublicImage,
  resetRenditionCache,
  getImageRenditionStats,
  resetImageRenditionStats
} = require('../src/lib/image-renditions');
const responsiveImages = require('../src/responsive-images');
const productArt = require('../product-art');

const ROOT = path.resolve(__dirname, '..');

test('responsive-images.json & static AVIF assets expose crisp 1200w and full-res files without breaking tracked 480w bounds', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'responsive-images.json'), 'utf8'));

  for (const key of ['/assets/products/k9.webp', '/assets/products/m3-home-cutout.webp', '/assets/products/g1-ultra-874bf1d3db77.webp', '/assets/products/p185-cutout-1cc9dfde9fa3.webp']) {
    const entries = manifest[key];
    assert.ok(Array.isArray(entries), `${key} must exist in manifest`);
    const entryWidths = entries.map((e) => e.width);
    assert.deepEqual(entryWidths, [480, 800, 1200], `${key} must include 480, 800, and 1200w renditions`);
    for (const entry of entries) {
      const webpDisk = path.join(ROOT, entry.url.replace(/^\/+/, ''));
      const avifDisk = path.join(ROOT, entry.avifUrl.replace(/^\/+/, ''));
      assert.equal(fs.existsSync(webpDisk), true, `Missing WebP rendition ${entry.url}`);
      assert.equal(fs.existsSync(avifDisk), true, `Missing AVIF rendition ${entry.avifUrl}`);
    }
  }

  // Tracked 480w filename must remain intact and < 20 KB for selective-avif mobile bound
  const k9Entries = manifest['/assets/products/k9.webp'];
  assert.equal(k9Entries[0].url, '/assets/products/k9-display-480-f7433a67675b.webp');
  assert.equal(k9Entries[0].avifUrl, '/assets/products/k9-display-480-f7433a67675b.avif');
  assert.ok(k9Entries[0].avifBytes < 20 * 1024, `Expected k9 480w AVIF < 20KB, got ${k9Entries[0].avifBytes}`);

  // Large-screen 800w / 1200w / base AVIF must be re-encoded at high quality with clear metadata
  const k9FullMeta = await sharp(path.join(ROOT, 'assets/products/k9.avif')).metadata();
  const k91200Meta = await sharp(path.join(ROOT, k9Entries[2].avifUrl.replace(/^\/+/, ''))).metadata();
  assert.equal(k9FullMeta.width, 1254);
  assert.equal(k91200Meta.width, 1200);
  assert.ok(fs.statSync(path.join(ROOT, 'assets/products/k9.avif')).size > 90000, 'Full-res k9.avif should preserve high-detail bitrate');

  const m3Desc1Meta = await sharp(path.join(ROOT, 'assets/products/m3-description/1.avif')).metadata();
  assert.equal(m3Desc1Meta.width, 842);
  assert.ok(fs.statSync(path.join(ROOT, 'assets/products/m3-description/1.avif')).size > 70000, 'Full-res m3-description/1.avif should preserve sharp detail');
});

test('SSR responsive-images, product-art, m3-description & news upgrade desktop sizes and unlock 1200w/1600w', async () => {
  const { document } = parseHTML(`<!DOCTYPE html><html><head></head><body>
    <div class="product-detail-art"><img src="/assets/products/k9.webp" alt="K9"></div>
    <div class="product-card"><img src="/assets/products/m3-home-cutout.webp" alt="M3"></div>
    <div class="product-detail-art"><img src="/api/catalog-images/11111111-1111-4111-8111-111111111111" alt="API Hero"></div>
    <article><img class="news-cover" src="/api/news-images/22222222-2222-4222-8222-222222222222" alt="News"></article>
    <div class="story-media"><img src="/assets/products/m3-description/1.webp" alt="M3 Spec"></div>
  </body></html>`);

  responsiveImages.apply(document);

  const pictures = [...document.querySelectorAll('picture')];
  assert.equal(pictures.length, 5);

  const heroAvif = pictures[0].querySelector('source[type="image/avif"]');
  assert.match(heroAvif.getAttribute('srcset'), /\b1200w\b/);
  assert.match(heroAvif.getAttribute('srcset'), /\b1254w\b/);
  assert.match(heroAvif.getAttribute('sizes'), /\b900px\b/);

  const cardAvif = pictures[1].querySelector('source[type="image/avif"]');
  assert.match(cardAvif.getAttribute('srcset'), /\b1200w\b/);
  assert.match(cardAvif.getAttribute('sizes'), /\b560px\b/);

  const apiHeroAvif = pictures[2].querySelector('source[type="image/avif"]');
  assert.match(apiHeroAvif.getAttribute('srcset'), /\b1200w\b/);
  assert.match(apiHeroAvif.getAttribute('srcset'), /\b1600w\b/);
  assert.match(apiHeroAvif.getAttribute('sizes'), /\b840px\b/);

  const newsAvif = pictures[3].querySelector('source[type="image/avif"]');
  assert.match(newsAvif.getAttribute('srcset'), /\b1600w\b/);
  assert.match(newsAvif.getAttribute('sizes'), /\b1100px\b/);

  const m3Avif = pictures[4].querySelector('source[type="image/avif"]');
  assert.match(m3Avif.getAttribute('srcset'), /1-w480\.avif 480w, \/assets\/products\/m3-description\/1-w800\.avif 800w, \/assets\/products\/m3-description\/1\.avif 842w/);
  assert.match(m3Avif.getAttribute('sizes'), /\b660px\b/);

  // Client product-art attributes keep /640px/ while exposing 1200w/1600w & larger desktop sizes
  const staticHeroAttrs = productArt.attributes('/assets/products/k9.webp', true);
  assert.match(staticHeroAttrs, /640px/);
  assert.match(staticHeroAttrs, /900px/);
  assert.match(staticHeroAttrs, /\b1200w\b/);

  const apiCardAttrs = productArt.attributes('/api/catalog-images/11111111-1111-4111-8111-111111111111', false);
  assert.match(apiCardAttrs, /\b1200w\b/);
  assert.match(apiCardAttrs, /\b1600w\b/);
  assert.match(apiCardAttrs, /\b560px\b/);

  // Client m3-description.js & news.js contain upgraded desktop breakpoints/sizes
  const m3ClientSrc = fs.readFileSync(path.join(ROOT, 'm3-description.js'), 'utf8');
  assert.match(m3ClientSrc, /660px/);
  const newsClientSrc = fs.readFileSync(path.join(ROOT, 'news.js'), 'utf8');
  assert.match(newsClientSrc, /1100px/);
  assert.match(newsClientSrc, /1600/);
});

test('image-renditions supports 1600w dynamic AVIF with lossless-display-v2 cache invalidation & high default encode quality', async (t) => {
  assert.deepEqual(widths, [480, 800, 1200, 1600]);
  const irSource = fs.readFileSync(path.join(ROOT, 'src/lib/image-renditions.js'), 'utf8');
  assert.match(irSource, /lossless-display-v2:/);

  resetRenditionCache();
  resetImageRenditionStats();
  t.after(() => {
    resetRenditionCache();
    resetImageRenditionStats();
  });

  // High-res noisy photographic PNG source (1800x1200) to exercise 1600w AVIF rendition & selective encode quality
  const w = 1800, h = 1200;
  const raw = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const grain = ((x * 73856093) ^ (y * 19349663)) & 31;
      raw[idx] = ((x * 255) / w + grain) & 255;
      raw[idx + 1] = ((y * 255) / h + grain) & 255;
      raw[idx + 2] = (((x + y) * 127) / (w + h) + grain) & 255;
      raw[idx + 3] = 255;
    }
  }
  const srcPng = await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

  const defaultAvif = await encodeAvif(srcPng);
  assert.ok(defaultAvif && defaultAvif.length > 0, 'encodeAvif default quality should produce AVIF buffer');

  const row = {
    id: randomUUID(),
    mime_type: 'image/png',
    updated_at: '2026-11-17T00:00:00Z',
    content: srcPng
  };

  await warmPublicImage(row, [1600]);
  assert.equal(getImageRenditionStats().warmEncodeCount, 2, 'Should warm 1600w WebP and 1600w high-quality AVIF');

  const req = {
    params: { id: row.id },
    query: { w: '1600', format: 'avif' },
    headers: { accept: 'image/avif,image/webp,*/*' },
    get(h) { return this.headers[h.toLowerCase()]; },
    socket: { remoteAddress: '127.0.0.1' }
  };

  const sent = await new Promise((resolve) => {
    const chunks = [];
    const res = new PassThrough();
    res.headers = {};
    res.statusCode = 200;
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    res.set = (k, v) => {
      if (k && typeof k === 'object') {
        for (const [hk, hv] of Object.entries(k)) res.headers[hk.toLowerCase()] = hv;
      } else {
        res.headers[String(k).toLowerCase()] = v;
      }
      return res;
    };
    res.type = (v) => { res.headers['content-type'] = v; return res; };
    res.getHeader = (k) => res.headers[k.toLowerCase()];
    res.status = (code) => { res.statusCode = code; return res; };
    res.send = (chunk) => res.end(chunk);
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
    };
    sendPublicImage(req, res, row, 'catalog').catch((err) => resolve({ err }));
  });

  assert.equal(sent.err, undefined);
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.headers['content-type'], 'image/avif');
  const meta1600 = await sharp(sent.body).metadata();
  assert.equal(meta1600.width, 1600);
  assert.equal(meta1600.format, 'heif');
});
