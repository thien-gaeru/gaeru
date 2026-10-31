// admin/format.js — Unified UMD (Browser + Node.js) formatting & sanitization utilities
(function (root, factory) {
  'use strict';
  var shared = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = shared;
  }
  if (root && typeof root === 'object') {
    root.GAERUAdminShared = Object.assign(root.GAERUAdminShared || {}, shared);
    if (!root.escapeHtml) root.escapeHtml = shared.escapeHtml;
    if (!root.escapeAttr) root.escapeAttr = shared.escapeAttr;
    if (!root.formatMoney) root.formatMoney = shared.formatMoney;
    if (!root.normalizePhone) root.normalizePhone = shared.normalizePhone;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, function (character) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[character];
    });
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function formatMoney(amountVnd, options) {
    var suffix = (options && options.suffix !== undefined) ? options.suffix : ' ₫';
    var n = Number(amountVnd);
    if (!Number.isFinite(n)) return '0' + suffix;
    return new Intl.NumberFormat('vi-VN').format(Math.round(n)) + suffix;
  }

  function normalizePhone(rawPhone) {
    if (rawPhone === null || rawPhone === undefined) return '';
    var str = String(rawPhone).trim();
    if (!str) return '';
    var cleaned = str.replace(/\D/g, '');
    if (cleaned.indexOf('0084') === 0 && cleaned.length >= 12) {
      cleaned = '0' + cleaned.slice(4).replace(/^0+/, '');
    } else if (cleaned.indexOf('84') === 0 && cleaned.length >= 10) {
      cleaned = '0' + cleaned.slice(2).replace(/^0+/, '');
    }
    return cleaned;
  }

  return {
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    formatMoney: formatMoney,
    normalizePhone: normalizePhone
  };
});
