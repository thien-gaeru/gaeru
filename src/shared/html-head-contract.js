'use strict';

/**
 * src/shared/html-head-contract.js — Nguồn chuẩn hóa partial <head> dùng chung và bộ kiểm toán SEO / PWA / CSP
 * cho toàn bộ 32 trang tĩnh cửa hàng và 2 trang quản trị GAERU.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { escapeHtml } = require('./format');

const SHARED_SECURITY_HEAD_PARTIAL = [
  '<script src="/bot-protection.js?v=20261024" defer></script>',
  '<script src="/action-feedback.js?v=20261028-validation" defer></script>',
  '<link rel="stylesheet" href="/action-feedback.css?v=20261028-validation">',
  '<link rel="stylesheet" href="/bot-protection.css?v=20261024">'
].join('');

const ALLOWED_EXTERNAL_SCRIPT_HOSTS = new Set([
  'challenges.cloudflare.com',
  'accounts.google.com',
  'apis.google.com',
  'ssl.gstatic.com'
]);

function renderHeadPartial({
  title = 'GAERU',
  description = '',
  canonicalUrl = '',
  themeColor = '#0055b8',
  stylesheets = [],
  scripts = []
} = {}) {
  const parts = [
    SHARED_SECURITY_HEAD_PARTIAL,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="theme-color" content="${escapeHtml(themeColor)}">`,
    `<title>${escapeHtml(title)}</title>`
  ];
  if (description) {
    parts.push(`<meta name="description" content="${escapeHtml(description)}">`);
  }
  if (canonicalUrl) {
    parts.push(`<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`);
  }
  for (const href of stylesheets) {
    parts.push(`<link rel="stylesheet" href="${escapeHtml(href)}">`);
  }
  for (const src of scripts) {
    parts.push(`<script src="${escapeHtml(src)}" defer></script>`);
  }
  return parts.join('\n    ');
}

function resolveLocalAssetPath(rawRef, rootDir) {
  const cleanRef = String(rawRef || '').split('#')[0].split('?')[0].trim();
  if (!cleanRef || /^(?:https?:|data:|blob:|mailto:|tel:|javascript:)/i.test(cleanRef)) {
    return null;
  }
  if (cleanRef.startsWith('/gaeru_ceo/assets/')) {
    return path.join(rootDir, 'admin', cleanRef.slice('/gaeru_ceo/assets/'.length));
  }
  if (cleanRef === '/gaeru_ceo/manifest.webmanifest' || cleanRef === '/gaeru_ceo/manifest.json') {
    return path.join(rootDir, 'admin', 'manifest.webmanifest');
  }
  if (cleanRef.startsWith('/')) {
    return path.join(rootDir, cleanRef.slice(1));
  }
  return path.join(rootDir, cleanRef);
}

function auditHtmlHeadAndAssets(pageName, html, {
  rootDir = path.join(__dirname, '..', '..'),
  isAdmin = false
} = {}) {
  const issues = [];
  const { document: doc } = parseHTML(html);

  if (!doc.head) {
    return { pageName, valid: false, issues: ['Thiếu thẻ <head>'] };
  }

  // 1. Ngôn ngữ & Meta nền tảng
  const lang = doc.documentElement?.getAttribute('lang');
  if (lang !== 'vi') issues.push(`Thuộc tính html[lang] phải là "vi" (hiện tại: "${lang || ''}")`);
  if (!doc.head.querySelector('meta[charset]')) issues.push('Thiếu <meta charset="utf-8">');
  if (!doc.head.querySelector('meta[name="viewport"]')) issues.push('Thiếu <meta name="viewport">');
  if (!doc.title || !doc.title.trim()) issues.push('Thiếu thẻ <title> hợp lệ');

  // 2. Partial bảo vệ bot & phản hồi thao tác dùng chung
  if (!html.includes('bot-protection.js') || !html.includes('action-feedback.js')) {
    issues.push('Thiếu partial dùng chung (bot-protection.js / action-feedback.js)');
  }

  // 3. Kiểm tra CSP nghiêm ngặt: cấm inline executable <script> và nguồn script ngoài danh sách cho phép
  for (const script of doc.querySelectorAll('script')) {
    const src = script.getAttribute('src');
    const type = (script.getAttribute('type') || '').trim().toLowerCase();
    if (!src) {
      if (type !== 'application/ld+json') {
        issues.push(`Phát hiện inline <script> vi phạm CSP script-src 'self' (type="${type || 'text/javascript'}")`);
      }
      continue;
    }
    if (/^https?:\/\//i.test(src) || src.startsWith('//')) {
      const host = new URL(src.startsWith('//') ? 'https:' + src : src).hostname;
      const allowed = ALLOWED_EXTERNAL_SCRIPT_HOSTS.has(host) || host.endsWith('.gstatic.com');
      if (!allowed) {
        issues.push(`Script ngoài miền CSP cho phép: ${src}`);
      }
      continue;
    }
    const diskPath = resolveLocalAssetPath(src, rootDir);
    if (diskPath && !fs.existsSync(diskPath)) {
      issues.push(`Không tìm thấy tệp script cục bộ: ${src}`);
    }
  }

  // 4. Kiểm tra đường dẫn stylesheet & manifest cục bộ
  for (const link of doc.head.querySelectorAll('link[rel="stylesheet"], link[rel="manifest"]')) {
    const href = link.getAttribute('href');
    const diskPath = resolveLocalAssetPath(href, rootDir);
    if (diskPath && !fs.existsSync(diskPath)) {
      issues.push(`Không tìm thấy tài nguyên link cục bộ: ${href}`);
    }
  }

  // 5. Kiểm tra SEO cho trang công khai hoặc PWA cho trang quản trị chính
  if (!isAdmin) {
    const desc = doc.head.querySelector('meta[name="description"]');
    if (!desc || !String(desc.getAttribute('content') || '').trim()) {
      // Các trang giao dịch nội bộ vẫn cần có thẻ mô tả hoặc được enrich bởi clean-routes
      if (!/^(?:payment|payment-result)\.html$/.test(pageName) && !doc.querySelector('main')) {
        issues.push('Trang công khai thiếu <meta name="description"> và <main>');
      }
    }
  } else if (pageName === 'admin/index.html') {
    if (!doc.head.querySelector('link[rel="manifest"]')) {
      issues.push('Trang quản trị thiếu liên kết PWA manifest');
    }
    if (!doc.head.querySelector('meta[name="theme-color"]')) {
      issues.push('Trang quản trị thiếu <meta name="theme-color">');
    }
  }

  return {
    pageName,
    valid: issues.length === 0,
    issues
  };
}

function syncSharedHeadInHtml(html) {
  if (html.includes('bot-protection.js') && html.includes('action-feedback.js')) {
    return { html, changed: false };
  }
  const updated = html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${SHARED_SECURITY_HEAD_PARTIAL}`);
  return { html: updated, changed: updated !== html };
}

module.exports = {
  SHARED_SECURITY_HEAD_PARTIAL,
  renderHeadPartial,
  resolveLocalAssetPath,
  auditHtmlHeadAndAssets,
  syncSharedHeadInHtml
};
