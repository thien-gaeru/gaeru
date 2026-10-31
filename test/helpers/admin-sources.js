'use strict';
// Đọc/chạy các script quản trị đã được tách module theo đúng thứ tự nạp trong HTML.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN_DIR = path.join(__dirname, '..', '..', 'admin');

// Thứ tự giống admin/index.html (admin.js đóng băng window.GAERUAdmin sau khi các miền đã khai báo hàm).
const ADMIN_BUNDLE = ['admin-overview.js', 'admin-catalog.js', 'admin-orders.js', 'admin-customers-settings.js', 'admin.js'];
// Thứ tự giống admin/product-editor.html.
const PRODUCT_EDITOR_BUNDLE = ['format.js', 'product-editor-media.js', 'product-editor-variants.js', 'product-editor.js'];
// Thứ tự giống admin/index.html cho trang cấu hình.
const CONFIGURATION_BUNDLE = ['format.js', 'configuration-channels.js', 'configuration-ai-ops.js', 'configuration.js'];

function readAdminFile(name) {
  return fs.readFileSync(path.join(ADMIN_DIR, name), 'utf8');
}

function readAdminBundle(names) {
  return names.map(readAdminFile).join('\n');
}

function runAdminBundle(names, context) {
  if (!vm.isContext(context)) vm.createContext(context);
  for (const name of names) vm.runInContext(readAdminFile(name), context, { filename: name });
  return context;
}

module.exports = {
  ADMIN_BUNDLE,
  PRODUCT_EDITOR_BUNDLE,
  CONFIGURATION_BUNDLE,
  readAdminFile,
  readAdminBundle,
  runAdminBundle
};
