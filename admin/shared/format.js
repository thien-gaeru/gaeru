// admin/shared/format.js — Shared browser formatting & sanitization utilities
(function () {
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
    if (!rawPhone || typeof rawPhone !== 'string') return '';
    var cleaned = rawPhone.replace(/\D/g, '');
    if (cleaned.indexOf('84') === 0) {
      cleaned = '0' + cleaned.slice(2);
    }
    return cleaned;
  }

  var shared = {
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    formatMoney: formatMoney,
    normalizePhone: normalizePhone
  };

  window.GAERUAdminShared = Object.assign(window.GAERUAdminShared || {}, shared);

  if (!window.escapeHtml) window.escapeHtml = escapeHtml;
  if (!window.escapeAttr) window.escapeAttr = escapeAttr;
  if (!window.formatMoney) window.formatMoney = formatMoney;
  if (!window.normalizePhone) window.normalizePhone = normalizePhone;
})();
