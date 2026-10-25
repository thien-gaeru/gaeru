const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const { createProductWorkspace } = require('../src/product-workspace');

const imageId = '8467673c-8a88-41f9-a6b1-ada46e04dec3';
const canonical = '/api/catalog-images/' + imageId;

function get(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + path, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function start(t) {
  const fixture = { visible: true, content: Buffer.from('original image bytes'), mime: 'image/png', reads: 0 };
  const pool = {
    async query(sql, values) {
      fixture.reads++;
      assert.match(sql, /SELECT content,mime_type FROM catalog_images/);
      assert.match(sql, /EXISTS\(SELECT 1 FROM products/);
      assert.deepEqual(values, [
        imageId,
        canonical,
        JSON.stringify([canonical]),
        JSON.stringify([{ type: 'image', url: canonical }])
      ], 'authorization must use canonical references even when the requested URL has a cache version');
      return { rows: fixture.visible ? [{ content: fixture.content, mime_type: fixture.mime }] : [] };
    }
  };
  const app = express();
  app.use('/api', createProductWorkspace(pool).publicApi);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { fixture, base: 'http://127.0.0.1:' + server.address().port };
}

test('catalog cache revalidation checks current visibility and canonical references before returning 304', async t => {
  const { fixture, base } = await start(t);
  const requested = canonical + '?v=webp-20261025';
  const oldValidator = '"gaeru-catalog-image-' + imageId + '-v1"';
  const fresh = await get(base, requested, { 'If-None-Match': oldValidator });
  assert.equal(fresh.status, 200, 'the old ID-only validator must not validate the new image representation');
  assert.equal(fresh.headers['content-type'], 'image/png');
  assert.ok(fresh.headers.etag);
  assert.notEqual(fresh.headers.etag, oldValidator);
  assert.deepEqual(fresh.body, fixture.content);

  const unchanged = await get(base, requested, { 'If-None-Match': fresh.headers.etag });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body.length, 0);
  assert.equal(unchanged.headers.etag, fresh.headers.etag);

  fixture.visible = false;
  const revoked = await get(base, requested, { 'If-None-Match': fresh.headers.etag });
  assert.equal(revoked.status, 404, 'a matching validator must not bypass publication authorization');
  assert.equal(fixture.reads, 3, 'every request must recheck the database publication predicate');
});

test('catalog validators change for either image bytes or MIME while the image ID stays the same', async t => {
  const { fixture, base } = await start(t);
  const before = await get(base, canonical);
  assert.equal(before.status, 200);

  fixture.content = Buffer.from('converted image bytes');
  const changedBytes = await get(base, canonical, { 'If-None-Match': before.headers.etag });
  assert.equal(changedBytes.status, 200);
  assert.notEqual(changedBytes.headers.etag, before.headers.etag);
  assert.deepEqual(changedBytes.body, fixture.content);

  fixture.mime = 'image/webp';
  const changedMime = await get(base, canonical, { 'If-None-Match': changedBytes.headers.etag });
  assert.equal(changedMime.status, 200);
  assert.equal(changedMime.headers['content-type'], 'image/webp');
  assert.notEqual(changedMime.headers.etag, changedBytes.headers.etag);
  assert.deepEqual(changedMime.body, fixture.content);

  const unchanged = await get(base, canonical, { 'If-None-Match': changedMime.headers.etag });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body.length, 0);
});
