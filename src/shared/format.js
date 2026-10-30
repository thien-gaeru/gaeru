'use strict';

/**
 * Shared formatting and sanitization utilities for GAERU Backend
 */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function formatMoney(amountVnd, { suffix = ' ₫' } = {}) {
  const n = Number(amountVnd);
  if (!Number.isFinite(n)) return '0' + suffix;
  return new Intl.NumberFormat('vi-VN').format(Math.round(n)) + suffix;
}

function normalizePhone(rawPhone) {
  if (!rawPhone || typeof rawPhone !== 'string') return '';
  let cleaned = rawPhone.replace(/\D/g, '');
  if (cleaned.startsWith('84')) {
    cleaned = '0' + cleaned.slice(2);
  }
  return cleaned;
}

module.exports = {
  escapeHtml,
  escapeAttr,
  formatMoney,
  normalizePhone
};
