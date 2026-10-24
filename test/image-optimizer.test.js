'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { optimizeProductImage } = require('../src/lib/image-optimizer');

test('GAERU: convert PNG to resized WebP', async () => {
  const png = await sharp({
    create: { width: 2000, height: 1200, channels: 3,
      background: { r: 120, g: 170, b: 210 } }
  }).png().toBuffer();
  const result = await optimizeProductImage(png, 'image/png');
  const meta = await sharp(result.buffer).metadata();
  assert.equal(result.mimeType, 'image/webp');
  assert.equal(meta.format, 'webp');
  assert.ok(meta.width <= 1600 && meta.height <= 1600);
});

test('GAERU: reject corrupt images and fake MIME types', async () => {
  const jpeg = await sharp({
    create: { width: 40, height: 40, channels: 3,
      background: { r: 255, g: 0, b: 0 } }
  }).jpeg().toBuffer();
  await assert.rejects(
    optimizeProductImage(jpeg, 'image/png'), { status: 400 });
  await assert.rejects(
    optimizeProductImage(Buffer.from('invalid'), 'image/png'), { status: 400 });
});
