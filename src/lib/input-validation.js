'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Check whether a value is a canonical UUID string.
 */
function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

/**
 * Validate a required UUID parameter or throw HTTP 400.
 */
function assertUuid(value, message = 'Mã định danh không hợp lệ.') {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!UUID_RE.test(normalized)) throw badRequest(message);
  return normalized;
}

/**
 * Validate an optional UUID query/body field, returning null when absent.
 */
function parseOptionalUuid(value, message = 'Mã định danh không hợp lệ.') {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return assertUuid(String(value), message);
}

/**
 * Parse a strictly positive integer parameter (rejects floats, Infinity, negatives, non-digits).
 */
function parseStrictPositiveInt(value, { defaultValue = 1, min = 1, max = 10000, message = 'Tham số trang không hợp lệ.' } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) {
    throw badRequest(message);
  }
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num < min || num > max) {
    throw badRequest(message);
  }
  return num;
}

module.exports = {
  UUID_RE,
  isUuid,
  assertUuid,
  parseOptionalUuid,
  parseStrictPositiveInt
};
