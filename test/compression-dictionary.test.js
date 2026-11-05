'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const zlib = require('node:zlib');
const { once } = require('node:events');
const {
  DCB_MAGIC,
  getDictionaryInfo,
  isDcbEligible,
  compressDcb,
  serveDictionaryRoute
} = require('../src/lib/compression-dictionary');
const { cleanRoutes } = require('../src/clean-routes');

test('compression dictionary provides valid sha256 hash, magic header and RFC 9682 wire format', () => {
  const info = getDictionaryInfo();
  assert.ok(Buffer.isBuffer(info.buffer));
  assert.ok(info.buffer.length > 1000);
  assert.equal(info.hash.length, 32);
  assert.ok(info.hashBase64Formatted.startsWith(':'));
  assert.ok(info.hashBase64Formatted.endsWith(':'));

  const raw = Buffer.from('<!doctype html><html lang="vi"><head><title>Test DCB</title></head><body><div id="site-header"></div><h1>Sản phẩm K9</h1></body></html>', 'utf8');
  const dcbPayload = compressDcb(raw);

  assert.ok(dcbPayload.subarray(0, 4).equals(DCB_MAGIC));
  assert.ok(dcbPayload.subarray(4, 36).equals(info.hash));

  const compressedBody = dcbPayload.subarray(36);
  const decompressed = zlib.brotliDecompressSync(compressedBody, { dictionary: info.buffer });
  assert.ok(decompressed.equals(raw));
});

test('serveDictionaryRoute sets Use-As-Dictionary and supports 304 caching', async (t) => {
  const app = express();
  app.get('/dict/shared-template.dict', serveDictionaryRoute);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(r => server.close(r)));

  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/dict/shared-template.dict`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.ok(res.headers.get('use-as-dictionary')?.includes('match="/san-pham/*"'));
  assert.ok(res.headers.get('cache-control')?.includes('immutable'));

  const etag = res.headers.get('etag');
  assert.ok(etag);

  // Conditional 304 test
  const reval = await fetch(`${base}/dict/shared-template.dict`, {
    headers: { 'If-None-Match': etag }
  });
  assert.equal(reval.status, 304);
});

test('cleanRoutes negotiates dcb when Available-Dictionary matches and falls back otherwise', async (t) => {
  const info = getDictionaryInfo();
  const app = express();
  app.use(cleanRoutes('https://gaeru.com'));
  app.get('/product.html', (req, res) => {
    res.type('html').send('<!doctype html><html lang="vi"><head><title>Fixture</title></head><body><main><h1>Fixture Product</h1><div id="site-footer"></div></main></body></html>');
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(r => server.close(r)));

  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. Without Available-Dictionary header -> standard response
  const standardRes = await fetch(`${base}/san-pham/test-product`);
  assert.equal(standardRes.status, 200);
  assert.notEqual(standardRes.headers.get('content-encoding'), 'dcb');
  const standardHtml = await standardRes.text();
  assert.ok(standardHtml.includes('Fixture Product'));
  assert.ok(standardHtml.includes('rel="compression-dictionary"'));

  // 2. With dcb accept and matching Available-Dictionary header
  const dcbRes = await fetch(`${base}/san-pham/test-product`, {
    headers: {
      'Accept-Encoding': 'dcb, br, gzip',
      'Available-Dictionary': info.hashBase64Formatted
    }
  });
  assert.equal(dcbRes.status, 200);
  assert.equal(dcbRes.headers.get('content-encoding'), 'dcb');
  assert.ok(dcbRes.headers.get('vary')?.includes('Available-Dictionary'));
  assert.ok(dcbRes.headers.get('etag')?.endsWith('-dcb"'));

  const dcbBuffer = Buffer.from(await dcbRes.arrayBuffer());
  assert.ok(dcbBuffer.subarray(0, 4).equals(DCB_MAGIC));
  assert.ok(dcbBuffer.subarray(4, 36).equals(info.hash));

  // Decompress and verify
  const decompressed = zlib.brotliDecompressSync(dcbBuffer.subarray(36), { dictionary: info.buffer });
  assert.ok(decompressed.toString('utf8').includes('Fixture Product'));

  // 3. Conditional 304 revalidation with -dcb ETag
  const etag = dcbRes.headers.get('etag');
  const revalRes = await fetch(`${base}/san-pham/test-product`, {
    headers: {
      'Accept-Encoding': 'dcb, br, gzip',
      'Available-Dictionary': info.hashBase64Formatted,
      'If-None-Match': etag
    }
  });
  assert.equal(revalRes.status, 304);
});
