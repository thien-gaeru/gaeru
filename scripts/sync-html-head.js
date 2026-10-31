#!/usr/bin/env node
'use strict';

/**
 * scripts/sync-html-head.js — Công cụ đồng bộ partial <head> dùng chung và kiểm tra SEO / PWA / CSP
 * cho toàn bộ tệp HTML cửa hàng và quản trị.
 *
 * Cách dùng:
 *   node scripts/sync-html-head.js --check   (chỉ kiểm tra, trả exit code 1 nếu có lỗi)
 *   node scripts/sync-html-head.js           (đồng bộ partial thiếu + kiểm tra toàn diện)
 */

const fs = require('node:fs');
const path = require('node:path');
const { auditHtmlHeadAndAssets, syncSharedHeadInHtml } = require('../src/shared/html-head-contract');

const ROOT = path.join(__dirname, '..');
const checkOnly = process.argv.includes('--check');

function runHtmlAuditAndSync({ rootDir = ROOT, writeChanges = !checkOnly } = {}) {
  const storeHtmlFiles = fs.readdirSync(rootDir).filter((f) => f.endsWith('.html')).sort();
  const adminHtmlFiles = ['admin/index.html', 'admin/product-editor.html'].filter((rel) =>
    fs.existsSync(path.join(rootDir, rel))
  );

  const results = [];
  let syncedCount = 0;

  for (const file of storeHtmlFiles) {
    const full = path.join(rootDir, file);
    let html = fs.readFileSync(full, 'utf8');
    if (writeChanges) {
      const synced = syncSharedHeadInHtml(html);
      if (synced.changed) {
        fs.writeFileSync(full, synced.html, 'utf8');
        html = synced.html;
        syncedCount++;
      }
    }
    results.push(auditHtmlHeadAndAssets(file, html, { rootDir, isAdmin: false }));
  }

  for (const rel of adminHtmlFiles) {
    const full = path.join(rootDir, rel);
    let html = fs.readFileSync(full, 'utf8');
    if (writeChanges) {
      const synced = syncSharedHeadInHtml(html);
      if (synced.changed) {
        fs.writeFileSync(full, synced.html, 'utf8');
        html = synced.html;
        syncedCount++;
      }
    }
    results.push(auditHtmlHeadAndAssets(rel, html, { rootDir, isAdmin: true }));
  }

  const invalid = results.filter((r) => !r.valid);
  return { total: results.length, syncedCount, invalid, results };
}

if (require.main === module) {
  const summary = runHtmlAuditAndSync();
  if (summary.invalid.length > 0) {
    for (const item of summary.invalid) {
      console.error(`[FAIL] ${item.pageName}: ${item.issues.join(' | ')}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`[OK] Đã kiểm chứng SEO/PWA/CSP cho ${summary.total} trang HTML (đồng bộ ${summary.syncedCount} tệp).`);
  }
}

module.exports = { runHtmlAuditAndSync };
