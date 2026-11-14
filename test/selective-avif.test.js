'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const sharp = require('sharp');
const { clientSupportsAvif, qualifiesForSelectiveAvif, encodeAvif, encodeWebp, SAVINGS_RATIO } = require('../src/lib/selective-avif');
const { createProductWorkspace } = require('../src/product-workspace');
const { serveAssets } = require('../src/persistent-assets');

test('clientSupportsAvif accurately detects AVIF support and explicit query overrides', () => {
  assert.equal(clientSupportsAvif(null), false);
  assert.equal(clientSupportsAvif({}), false);
  assert.equal(clientSupportsAvif({ headers: { accept: '*/*' } }), false);
  assert.equal(clientSupportsAvif({ headers: { accept: 'image/webp,*/*' } }), false);
  assert.equal(clientSupportsAvif({ headers: { accept: 'image/avif,image/webp,*/*' } }), true);
  assert.equal(clientSupportsAvif({ headers: { accept: 'IMAGE/AVIF' } }), true);

  // Explicit format override
  assert.equal(clientSupportsAvif({ query: { format: 'avif' } }), true);
  assert.equal(clientSupportsAvif({ headers: { accept: 'image/avif' }, query: { format: 'webp' } }), false);
});

test('qualifiesForSelectiveAvif rejects small assets below 16KB threshold to prevent file inflation', () => {
  const reqAvif = { headers: { accept: 'image/avif' } };
  assert.equal(qualifiesForSelectiveAvif(reqAvif, 1024), false, '1 KB is too small for AVIF container efficiency');
  assert.equal(qualifiesForSelectiveAvif(reqAvif, 15 * 1024), false, '15 KB is below 16 KB threshold');
  assert.equal(qualifiesForSelectiveAvif(reqAvif, 16 * 1024), true, '16 KB meets threshold');
  assert.equal(qualifiesForSelectiveAvif(reqAvif, 250 * 1024), true, '250 KB qualifies');
});

test('encodeAvif preserves transparency, sharp lettering and delivers superior compression on product art', async () => {
  const inputBuffer = await fs.readFile(path.join(__dirname, '..', 'assets', 'products', 'k9.webp'));

  const webpBuffer = await encodeWebp(inputBuffer, { width: 480, lossless: true });
  const avifBuffer = await encodeAvif(inputBuffer, { width: 480, quality: 66, effort: 2 });

  const avifMeta = await sharp(avifBuffer).metadata();
  assert.equal(avifMeta.format, 'heif');
  assert.equal(avifMeta.width, 480);
  assert.equal(avifMeta.hasAlpha, true, 'AVIF retains alpha transparency channel');

  // Verify that AVIF achieves significant compression vs lossless WebP (e.g. 15 KB vs 120 KB)
  assert.ok(avifBuffer.length <= webpBuffer.length * SAVINGS_RATIO, 'AVIF is significantly smaller than lossless WebP');
});

test('HTTP Content Negotiation serves AVIF when accepted and falls back to WebP when not for API renditions', async (t) => {
  const raw = Buffer.alloc(1200 * 800 * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = i % 251;
    raw[i + 1] = (i >> 8) % 251;
    raw[i + 2] = (i >> 12) % 251;
    raw[i + 3] = i % 256;
  }
  const fixture = {
    content: await sharp(raw, { raw: { width: 1200, height: 800, channels: 4 } }).png().toBuffer()
  };

  const { warmPublicImage } = require('../src/lib/image-renditions');
  await warmPublicImage({ content: fixture.content, mime_type: 'image/png' }, [480]);
  const id = '8467673c-8a88-41f9-a6b1-ada46e04dec3';
  const pool = {
    async query(sql) {
      assert.match(sql, /EXISTS\(SELECT 1 FROM products/);
      return { rows: [{ content: fixture.content, mime_type: 'image/png' }] };
    }
  };

  const app = express();
  app.use('/api', createProductWorkspace(pool).publicApi);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/api/catalog-images/${id}?w=480`;

  // 1. Default request (no Accept: image/avif, typical Node fetch / legacy browser)
  const legacyResp = await fetch(url);
  assert.equal(legacyResp.status, 200);
  assert.match(legacyResp.headers.get('content-type'), /image\/webp/);
  assert.match(legacyResp.headers.get('vary'), /Accept/);
  const legacyEtag = legacyResp.headers.get('etag');
  assert.ok(legacyEtag && !legacyEtag.includes('-avif'));

  // 2. Modern browser request (sends Accept: image/avif)
  const avifResp = await fetch(url, {
    headers: { Accept: 'image/avif,image/webp,image/apng,*/*;q=0.8' }
  });
  assert.equal(avifResp.status, 200);
  assert.match(avifResp.headers.get('content-type'), /image\/avif/);
  assert.match(avifResp.headers.get('vary'), /Accept/);
  const avifEtag = avifResp.headers.get('etag');
  assert.ok(avifEtag && avifEtag.includes('-avif'), 'AVIF response has distinctive ETag');

  // 3. Conditional validation (304 Not Modified) with AVIF ETag
  const notModifiedResp = await fetch(url, {
    headers: {
      'Cache-Control': 'max-age=0',
      Accept: 'image/avif',
      'If-None-Match': avifEtag
    }
  });
  assert.equal(notModifiedResp.status, 304);

  // 4. Explicit format=webp parameter forces WebP even if browser accepts AVIF
  const forcedWebpResp = await fetch(url + '&format=webp', {
    headers: { Accept: 'image/avif' }
  });
  assert.equal(forcedWebpResp.status, 200);
  assert.match(forcedWebpResp.headers.get('content-type'), /image\/webp/);
});

test('persistent assets serve selective AVIF on /assets/ when accepted and preserve WebP for small or legacy assets', async (t) => {
  const app = express();
  // Using null pool operates in local filesystem mode (!filesystem.configured())
  app.use('/assets', serveAssets(null));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. Large product image with ?w=480 without AVIF Accept header -> serves WebP
  const rLegacy = await fetch(`${base}/assets/products/k9.webp?w=480`);
  assert.equal(rLegacy.status, 200);
  assert.match(rLegacy.headers.get('content-type'), /image\/webp/);

  // 2. Large product image with ?w=480 and Accept: image/avif -> serves AVIF
  const rAvif = await fetch(`${base}/assets/products/k9.webp?w=480`, {
    headers: { Accept: 'image/avif,image/webp,*/*' }
  });
  assert.equal(rAvif.status, 200);
  assert.match(rAvif.headers.get('content-type'), /image\/avif/);
  const avifBytes = Buffer.from(await rAvif.arrayBuffer());
  const webpBytes = Buffer.from(await rLegacy.arrayBuffer());
  assert.ok(avifBytes.length <= webpBytes.length * SAVINGS_RATIO, 'AVIF is significantly smaller than WebP on /assets/');

  // 3. Conditional 304 on /assets/
  const avifEtag = rAvif.headers.get('etag');
  assert.ok(avifEtag && avifEtag.includes('-avif'));
  const r304 = await fetch(`${base}/assets/products/k9.webp?w=480`, {
    headers: { 'Cache-Control': 'max-age=0', Accept: 'image/avif', 'If-None-Match': avifEtag }
  });
  assert.equal(r304.status, 304);
});

test('persistent assets serve pre-generated AVIF Ultra with X-GAERU-AVIF-Source: avif-ultra-pregen without runtime encoding', async (t) => {
  const app = express();
  app.use('/assets', serveAssets(null));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}`;

  // Requesting pre-generated variant k9-display-480 with Accept: image/avif
  const res = await fetch(`${base}/assets/products/k9-display-480-f7433a67675b.webp`, {
    headers: { Accept: 'image/avif,image/webp,*/*' }
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/avif/);
  assert.equal(res.headers.get('x-gaeru-avif-source'), 'avif-ultra-pregen');
  assert.ok(Number(res.headers.get('content-length')) < 20 * 1024, 'Pre-generated AVIF is extremely compact');

  // Verify m3-description, k9-description, and news assets also serve pre-generated AVIF Ultra
  for (const pathItem of [
    '/assets/products/m3-description/1.webp?w=480',
    '/assets/products/k9-description/1.webp',
    '/assets/products/k9-description/1.webp?w=480',
    '/assets/news/affiliate-bo-tai-nguyen-so.webp'
  ]) {
    const r = await fetch(`${base}${pathItem}`, {
      headers: { Accept: 'image/avif,image/webp,*/*' }
    });
    assert.equal(r.status, 200, pathItem);
    assert.match(r.headers.get('content-type'), /image\/avif/, pathItem);
    assert.equal(r.headers.get('x-gaeru-avif-source'), 'avif-ultra-pregen', pathItem);
  }
});

test('persistent disk rendition cache shares pre-encoded AVIF across cluster workers and restarts with zero runtime Sharp encodes', async (t) => {
  const os = require('node:os');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gaeru-renditions-disk-'));
  const prevDiskFlag = process.env.RENDITION_DISK_CACHE;
  const prevDiskDir = process.env.RENDITION_CACHE_DIR;
  process.env.RENDITION_DISK_CACHE = 'true';
  process.env.RENDITION_CACHE_DIR = tempDir;

  const {
    warmPublicImage,
    sendPublicImage,
    resetRenditionCache,
    resetImageRenditionStats,
    getImageRenditionStats
  } = require('../src/lib/image-renditions');

  t.after(async () => {
    if (prevDiskFlag === undefined) delete process.env.RENDITION_DISK_CACHE;
    else process.env.RENDITION_DISK_CACHE = prevDiskFlag;
    if (prevDiskDir === undefined) delete process.env.RENDITION_CACHE_DIR;
    else process.env.RENDITION_CACHE_DIR = prevDiskDir;
    resetRenditionCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const inputBuffer = await fs.readFile(path.join(__dirname, '..', 'assets', 'products', 'k9.webp'));
  const row = { content: inputBuffer, mime_type: 'image/webp' };

  resetRenditionCache();
  resetImageRenditionStats();
  await warmPublicImage(row, [480]);
  const encodesAfterFirstWarm = getImageRenditionStats().warmEncodeCount;
  assert.ok(encodesAfterFirstWarm >= 2, 'First warm encodes WebP and AVIF');

  // Clear in-memory cache to simulate a fresh cluster worker or process restart
  resetRenditionCache();
  resetImageRenditionStats();

  const app = express();
  app.get('/api/catalog-images/:id', (req, res, next) => sendPublicImage(req, res, row, 'catalog').catch(next));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/catalog-images/test-id?w=480`, {
    headers: { Accept: 'image/avif,image/webp,*/*' }
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/avif/);
  const stats = getImageRenditionStats();
  assert.equal(stats.getRuntimeEncodeCount, 0, 'Zero runtime encodes');
  assert.equal(stats.warmEncodeCount, 0, 'Zero warm encodes when loading from disk cache');
  assert.ok(stats.diskCacheHits >= 2, 'Loaded both WebP and AVIF renditions from persistent disk cache');
});
