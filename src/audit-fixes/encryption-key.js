'use strict';

const crypto = require('node:crypto');
const { open, seal } = require('../totp');

let warnedSharedSecret = false;

/**
 * Resolves dedicated secret-at-rest encryption key separate from SESSION_SECRET when configured,
 * falling back to HKDF-derived subkey + legacy SESSION_SECRET decryption for seamless migration.
 */
function resolveEncryptionKeys(config = {}) {
  const rawDedicated = config.AUTH_ENCRYPTION_KEY !== undefined ? config.AUTH_ENCRYPTION_KEY : process.env.AUTH_ENCRYPTION_KEY;
  const dedicated = String(rawDedicated || '').trim();
  const sessionSecret = String(config.SESSION_SECRET || '').trim();
  const isProduction = (config.NODE_ENV === 'production' || (!config.NODE_ENV && process.env.NODE_ENV === 'production')) && process.env.NODE_ENV !== 'test';
  const derived = sessionSecret
    ? crypto.createHmac('sha256', sessionSecret).update('gaeru-auth-encryption-v1').digest('hex')
    : '';
  if (dedicated) {
    if (isProduction && sessionSecret && dedicated === sessionSecret) {
      throw new Error('[SECURITY] AUTH_ENCRYPTION_KEY must be distinct from SESSION_SECRET in production.');
    }
    return {
      primary: dedicated,
      legacyDerived: derived || null,
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
  return {
    primary: derived,
    legacy: sessionSecret || null,
    dedicated: false
  };
}

function openWithKeyFallbackMeta(ciphertext, keys) {
  if (!ciphertext) return { plaintext: '', usedPrimary: true };
  let firstError;
  for (const key of new Set([keys.primary, keys.legacyDerived, keys.legacy])) {
    if (!key) continue;
    try {
      return { plaintext: open(ciphertext, key), usedPrimary: key === keys.primary };
    } catch (error) {
      firstError ||= error;
    }
  }
  throw firstError || new Error('Missing encryption key');
}

function openWithKeyFallback(ciphertext, keys) {
  return openWithKeyFallbackMeta(ciphertext, keys).plaintext;
}

function sealWithPrimaryKey(plaintext, keys) {
  return seal(plaintext, keys.primary);
}

module.exports = {
  resolveEncryptionKeys,
  openWithKeyFallback,
  openWithKeyFallbackMeta,
  sealWithPrimaryKey
};
