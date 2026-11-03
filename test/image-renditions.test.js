'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sharp = require('sharp');
const { createNewsPublicApi } = require('../src/news-api');
const { createProductWorkspace } = require('../src/product-workspace');
const { parseHTML } = require('linkedom');
const id = '8467673c-8a88-41f9-a6b1-ada46e04dec3';
async function start(t, kind) {
  const raw = Buffer.alloc(1200 * 800 * 4);
  for (let i = 0; i < raw.length; i += 4) { raw[i] = i % 251; raw[i + 1] = (i >> 8) % 251; raw[i + 2] = (i >> 12) % 251; raw[i + 3] = i % 256; }
  const fixture = { visible: true, reads: 0, content: await sharp(raw, { raw: { width: 1200, height: 800, channels: 4 } }).png().toBuffer() };
  const pool = { async query(sql) {
    assert.match(sql, /EXISTS\(SELECT 1 FROM (products|news_posts)/);
    fixture.reads++;
    return { rows: fixture.visible ? [{ content: fixture.content, mime_type: 'image/png' }] : [] };
  } };
  const app = express();
  app.use('/api', kind === 'news' ? createNewsPublicApi(pool) : createProductWorkspace(pool).publicApi);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { fixture, url: 'http://127.0.0.1:' + server.address().port + '/api/' + kind + '-images/' + id };
}
for (const kind of ['news', 'catalog']) test(kind + ' lossless display renditions preserve originals, alpha, authorization and validators', async t => {
  const { fixture, url } = await start(t, kind);
  const source = await fetch(url);
  assert.deepEqual(Buffer.from(await source.arrayBuffer()), fixture.content);
  const image = await fetch(url + '?w=480');
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type'), /image\/webp/);
  const bytes = Buffer.from(await image.arrayBuffer());
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.width, 480);
  assert.equal(metadata.hasAlpha, true);
  const expected = await sharp(fixture.content).rotate().resize({ width: 480, withoutEnlargement: true }).raw().toBuffer();
  assert.deepEqual(await sharp(bytes).raw().toBuffer(), expected, 'lossless rendition retains every resized pixel including alpha');
  assert.notEqual(source.headers.get('etag'), image.headers.get('etag'));
  assert.equal((await fetch(url + '?w=480', { headers: { 'Cache-Control': 'max-age=0', 'If-None-Match': image.headers.get('etag') } })).status, 304);
  assert.equal((await fetch(url + '?w=800', { headers: { 'If-None-Match': image.headers.get('etag') } })).status, 200);
  for (const value of ['1', '479', '480.1', '99999999', '480&w=800']) assert.equal((await fetch(url + '?w=' + value)).status, 400);
  fixture.visible = false;
  assert.equal((await fetch(url + '?w=480', { headers: { 'If-None-Match': image.headers.get('etag') } })).status, 404, 'cached bytes/ETag cannot bypass publication revocation');
  assert.ok(fixture.reads >= 10);
});
test('SSR and client artwork expose responsive uploaded images without rewriting source URLs', () => {
  const { document } = parseHTML('<html><head></head><body><img src="/api/news-images/' + id + '"><img class="news-cover" src="/api/news-images/' + id + '"><img src="/api/catalog-images/' + id + '?v=webp-20261025"></body></html>');
  require('../src/responsive-images').apply(document);
  for (const img of document.querySelectorAll('img')) {
    assert.match(img.getAttribute('srcset'), /w=480 480w/);
    assert.match(img.getAttribute('srcset'), /w=1200 1200w/);
    assert.doesNotMatch(img.getAttribute('src'), /[?&]w=/);
  }
  const attrs = require('../product-art').attributes('/api/catalog-images/' + id, true);
  assert.match(attrs, /w=480 480w/);
  assert.match(attrs, /640px/);
});
