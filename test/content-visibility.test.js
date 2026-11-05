'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

test('CSS rules declare content-visibility: auto for below-the-fold components', () => {
  const stylesCss = fs.readFileSync(path.join(rootDir, 'styles.css'), 'utf8');
  assert.ok(stylesCss.includes('content-visibility: auto'));
  assert.ok(stylesCss.includes('contain-intrinsic-size'));

  const discoverCss = fs.readFileSync(path.join(rootDir, 'discover.css'), 'utf8');
  assert.ok(discoverCss.includes('content-visibility:auto'));
  assert.ok(discoverCss.includes('contain-intrinsic-size'));

  const ppCss = fs.readFileSync(path.join(rootDir, 'product-purchase.css'), 'utf8');
  assert.ok(ppCss.includes('content-visibility:auto'));

  const newsCss = fs.readFileSync(path.join(rootDir, 'news.css'), 'utf8');
  assert.ok(newsCss.includes('content-visibility:auto'));
});
