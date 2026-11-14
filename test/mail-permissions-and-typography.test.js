'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Outbound email workers expose fast polling and immediate nudge triggers', () => {
  const orderEmail = require('../src/order-email');
  const warrantyEmail = require('../src/warranty-email');
  const careApi = require('../src/care-api');
  const chatEmail = require('../src/shopping-chat-email');

  assert.equal(typeof orderEmail.nudgeOrderEmailWorker, 'function');
  assert.equal(typeof warrantyEmail.nudgeWarrantyEmailWorker, 'function');
  assert.equal(typeof careApi.nudgeCareEmailWorker, 'function');
  assert.equal(typeof chatEmail.nudgeChatEmailWorker, 'function');

  // Calling nudge when worker is not running must be a safe no-op
  assert.doesNotThrow(() => {
    orderEmail.nudgeOrderEmailWorker();
    warrantyEmail.nudgeWarrantyEmailWorker();
    careApi.nudgeCareEmailWorker();
    chatEmail.nudgeChatEmailWorker();
  });
});

test('Responsive Vietnamese typography is configured for both mobile phones and desktop PCs', () => {
  const rootDir = path.resolve(__dirname, '..');
  const typoCss = fs.readFileSync(path.join(rootDir, 'typography.css'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(rootDir, 'styles.css'), 'utf8');
  const adminCss = fs.readFileSync(path.join(rootDir, 'admin', 'admin.css'), 'utf8');
  const adminMobileCss = fs.readFileSync(path.join(rootDir, 'admin', 'admin-mobile.css'), 'utf8');

  // 1. Full cross-platform font stack with Roboto & SF Pro for Android/iOS/Windows/macOS
  assert.match(stylesCss, /Roboto/);
  assert.match(adminCss, /Roboto/);
  assert.match(typoCss, /Roboto/);

  // 2. Fluid clamp() typography and Vietnamese diacritic line-height protection
  assert.match(typoCss, /clamp\(/);
  assert.match(typoCss, /font-kerning:\s*normal/);
  assert.match(typoCss, /text-wrap:\s*balance/);
  assert.match(typoCss, /tabular-nums/);

  // 3. Mobile 16px input rule to prevent iOS/Android auto-zoom on focus
  assert.match(typoCss, /@media\(max-width:734px\)/);
  assert.match(typoCss, /font-size:16px!important/);
  assert.match(adminMobileCss, /tabular-nums/);
});
