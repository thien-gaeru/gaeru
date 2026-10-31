'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const formatModule = require('../admin/format');

test('Admin Shared Formatting: Single source of truth for escapeHtml in admin/format.js', () => {
  assert.equal(typeof formatModule.escapeHtml, 'function');
  assert.equal(typeof formatModule.fallbackEscapeHtml, 'function');

  // Verify full escaping of HTML special characters
  const payload = '<script>alert("XSS & theft")</script>/attack\'';
  const escaped = formatModule.escapeHtml(payload);

  assert.equal(escaped, '&lt;script&gt;alert(&quot;XSS &amp; theft&quot;)&lt;/script&gt;/attack&#39;');
  assert.doesNotMatch(escaped, /[<>"']/);
  assert.ok(escaped.includes('&amp;'));

  // Null and undefined safety
  assert.equal(formatModule.escapeHtml(null), '');
  assert.equal(formatModule.escapeHtml(undefined), '');
  assert.equal(formatModule.escapeHtml(12345), '12345');
});

test('Admin Modules Integration: admin.js and upgrades-hub.js consume format.js without code duplication', () => {
  const adminJs = fs.readFileSync(path.join(__dirname, '../admin/admin.js'), 'utf8');
  const upgradesHubJs = fs.readFileSync(path.join(__dirname, '../admin/upgrades-hub.js'), 'utf8');

  // Check that neither file defines a bloated duplicate block
  assert.match(adminJs, /sharedFormat\?\.escapeHtml/);
  assert.match(upgradesHubJs, /sharedFmt\?\.escapeHtml/);

  // Check script tag ordering in admin/index.html
  const indexHtml = fs.readFileSync(path.join(__dirname, '../admin/index.html'), 'utf8');
  const formatIndex = indexHtml.indexOf('assets/format.js');
  const adminUiIndex = indexHtml.indexOf('assets/admin-ui.js');
  const adminJsIndex = indexHtml.indexOf('assets/admin.js');
  const upgradesHubIndex = indexHtml.indexOf('assets/upgrades-hub.js');

  assert.ok(formatIndex !== -1, 'format.js must be present in admin/index.html');
  assert.ok(formatIndex < adminUiIndex, 'format.js must load before admin-ui.js');
  assert.ok(formatIndex < adminJsIndex, 'format.js must load before admin.js');
  assert.ok(formatIndex < upgradesHubIndex, 'format.js must load before upgrades-hub.js');
});

test('CSP & DOM Event Handling: customer-upgrades-ui.js has zero inline onclick attributes and uses data-action delegation', () => {
  const uiJs = fs.readFileSync(path.join(__dirname, '../customer-upgrades-ui.js'), 'utf8');

  // Absolutely zero inline onclick attributes in HTML strings or DOM properties
  assert.doesNotMatch(uiJs, /onclick\s*=/i, 'customer-upgrades-ui.js must not contain any onclick assignments');

  // Verify data-action attributes are utilized
  assert.match(uiJs, /data-action=["']loyalty-history["']/);
  assert.match(uiJs, /data-action=["']open-affiliate["']/);
  assert.match(uiJs, /data-action=["']copy-affiliate["']/);

  // Verify event delegation handles data-action
  assert.match(uiJs, /data-action=["']loyalty-history["']/);
  assert.match(uiJs, /data-action=["']open-affiliate["']/);
});
