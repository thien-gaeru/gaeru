#!/usr/bin/env node
'use strict';

/**
 * scripts/generate-html-layouts.js
 * 
 * Script quản lý và chuẩn hóa các layout HTML dùng chung (<head>, meta tags, core scripts, stylesheets).
 * Đảm bảo các trang static HTML (terms, legal, privacy, delivery-returns, cart, payment)
 * giữ tính nhất quán cao, giảm thiểu trùng lặp thủ công nhưng vẫn sinh mã tĩnh chuẩn SEO.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

const SHARED_HEAD_PREFIX = [
  '<script src="/bot-protection.js?v=20261024" defer></script>',
  '<script src="/action-feedback.js?v=20261028-validation" defer></script>',
  '<link rel="stylesheet" href="/action-feedback.css?v=20261028-validation">',
  '<link rel="stylesheet" href="/bot-protection.css?v=20261024">'
].join('');

const CORE_SCRIPTS = [
  '<script src="customer-session.js?v=20261030-v5b" defer></script>',
  '<script src="/footer-products.js?v=20261027-all-products" defer></script>',
  '<script src="store-shell.js?v=20261030-v5b" defer></script>'
].join('');

const PAGES_TO_VERIFY = [
  'terms.html',
  'legal.html',
  'privacy.html',
  'delivery-returns.html'
];

function verifyPageIntegrity(pageName) {
  const filePath = path.join(ROOT_DIR, pageName);
  if (!fs.existsSync(filePath)) {
    return { pageName, status: 'missing' };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const hasSharedHead = content.includes('bot-protection.js') && content.includes('action-feedback.js');
  const hasMeta = content.includes('charset="utf-8"') && content.includes('name="viewport"');
  return { pageName, status: (hasSharedHead && hasMeta) ? 'valid' : 'inconsistent' };
}

function runAudit() {
  console.log('--- GAERU HTML Layouts Audit ---');
  let validCount = 0;
  for (const page of PAGES_TO_VERIFY) {
    const res = verifyPageIntegrity(page);
    console.log(`- ${res.pageName}: [${res.status.toUpperCase()}]`);
    if (res.status === 'valid') validCount++;
  }
  console.log(`\nVerified ${validCount}/${PAGES_TO_VERIFY.length} pages adhering to unified layout contracts.`);
}

if (require.main === module) {
  runAudit();
}

module.exports = {
  SHARED_HEAD_PREFIX,
  CORE_SCRIPTS,
  verifyPageIntegrity
};
