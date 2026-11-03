'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const sharp = require('sharp');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { createProductWorkspace } = require('../src/product-workspace');
const { uploadAsset } = require('../src/lib/filesystem-media');
const { pointer } = require('../src/lib/stored-media');

test('deleted catalog rows stay private through canonical images, cached renditions and filesystem aliases even with legacy active flags', async t => {
  const db = await PGlite.create();
  const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gaeru-deleted-image-'));
  const previousRoot = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = mediaRoot;
  t.after(async () => {
    await db.close();
    if (previousRoot === undefined) delete process.env.MEDIA_ROOT; else process.env.MEDIA_ROOT = previousRoot;
    await fs.rm(mediaRoot, { recursive: true, force: true });
  });
  async function query(sql, args) {
    const result = !args && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, args);
    return { ...result, rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  }
  const pool = { query, connect: async () => ({ query, release() {} }) };
  await migrateDatabase(pool);
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#3868a080' } }).png().toBuffer();
  const { key } = await uploadAsset('products', bytes, 'image/png');
  const image = (await query("INSERT INTO catalog_images(content,mime_type) VALUES($1,'image/png') RETURNING id", [pointer(key, bytes)])).rows[0];
  const canonical = '/api/catalog-images/' + image.id;
  const product = (await query("INSERT INTO products(name,slug,category,active,image_url) VALUES('Deletion privacy fixture','deletion-privacy-fixture','audio',true,$1) RETURNING id", [canonical])).rows[0];
  const app = express(), workspace = createProductWorkspace(pool);
  app.use('/api', workspace.publicApi);
  app.use('/media', workspace.publicMedia);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const aliases = [canonical, '/media/' + key];
  const validators = new Map();
  for (const url of aliases) {
    const original = await fetch(base + url);
    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
    const rendition = await fetch(base + url + '?w=480');
    assert.equal(rendition.status, 200);
    await rendition.arrayBuffer();
    validators.set(url, rendition.headers.get('etag'));
  }
  // Simulate legacy or inconsistent stored data, independently of editor guards.
  await query('UPDATE products SET deleted_at=now() WHERE id=$1', [product.id]);
  assert.equal((await query('SELECT active FROM products WHERE id=$1', [product.id])).rows[0].active, true);
  for (const url of aliases) {
    assert.equal((await fetch(base + url)).status, 404);
    assert.equal((await fetch(base + url + '?w=480', { headers: { 'If-None-Match': validators.get(url), 'Cache-Control': 'max-age=0' } })).status, 404);
  }
});
