'use strict';

const crypto = require('node:crypto');
const { open, seal } = require('../totp');

let warnedSharedSecret = false;

/**
 * Resolves dedicated secret-at-rest encryption key separate from SESSION_SECRET when configured,
 * falling back to HKDF-derived subkey + legacy SESSION_SECRET decryption for seamless migration.
 */
function resolveEncryptionKeys(config = {}) {
  const dedicated = String(process.env.AUTH_ENCRYPTION_KEY || config.AUTH_ENCRYPTION_KEY || '').trim();
  const sessionSecret = String(config.SESSION_SECRET || '').trim();
  const isProduction = (config.NODE_ENV === 'production' || (!config.NODE_ENV && process.env.NODE_ENV === 'production')) && process.env.NODE_ENV !== 'test';
  if (dedicated) {
    if (isProduction && sessionSecret && dedicated === sessionSecret) {
      throw new Error('[SECURITY] AUTH_ENCRYPTION_KEY must be distinct from SESSION_SECRET in production.');
    }
    return {
      primary: dedicated,
      legacy: sessionSecret && sessionSecret !== dedicated ? sessionSecret : null,
      dedicated: true
    };
  }
  if (isProduction && !config.ALLOW_LEGACY_SESSION_ENCRYPTION) {
    throw new Error('[SECURITY] AUTH_ENCRYPTION_KEY (>= 32 chars) must be set in production separate from SESSION_SECRET.');
  }
  if (config.NODE_ENV === 'production' && !warnedSharedSecret) {
    warnedSharedSecret = true;
    console.warn('[SECURITY] AUTH_ENCRYPTION_KEY is unset; using derived fallback because legacy mode is active.');
  }
  const derived = sessionSecret
    ? crypto.createHmac('sha256', sessionSecret).update('gaeru-auth-encryption-v1').digest('hex')
    : '';
  return {
    primary: derived,
    legacy: sessionSecret || null,
    dedicated: false
  };
}

function openWithKeyFallback(ciphertext, keys) {
  if (!ciphertext) return '';
  try {
    return open(ciphertext, keys.primary);
  } catch (primaryErr) {
    if (keys.legacy && keys.legacy !== keys.primary) {
      return open(ciphertext, keys.legacy);
    }
    throw primaryErr;
  }
}

function sealWithPrimaryKey(plaintext, keys) {
  return seal(plaintext, keys.primary);
}

module.exports = {
  resolveEncryptionKeys,
  openWithKeyFallback,
  sealWithPrimaryKey
};
