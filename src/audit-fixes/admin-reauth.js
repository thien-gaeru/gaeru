'use strict';
const bcrypt = require('bcryptjs');
const { withinBcryptLimit } = require('./password-rules');

/**
 * Resolves the active administrator's stored password hash for fallback
 * re-authentication when accountSecurity session authorize is unavailable.
 */
async function resolveAdminPasswordHash(req, pool, config) {
  if (config?.accountSecurity) {
    try {
      const key = req.admin?.source === 'bootstrap' ? 'owner' : ('staff:' + req.admin?.id);
      const account = await config.accountSecurity.account(key, pool);
      if (account?.passwordHash) return account.passwordHash;
    } catch (_) {}
  }
  if (req.admin?.source === 'bootstrap' || req.admin?.role === 'owner') {
    const effectiveConfig = config?.accountSecurity ? await config.accountSecurity.ownerConfig() : config;
    return effectiveConfig?.ADMIN_PASSWORD_HASH || config?.ADMIN_PASSWORD_HASH || null;
  }
  if (req.admin?.id) {
    const row = (await pool.query('SELECT password_hash FROM staff_accounts WHERE id = $1', [req.admin.id])).rows[0];
    return row?.password_hash || null;
  }
  return config?.ADMIN_PASSWORD_HASH || null;
}

/**
 * Enforces admin step-up authentication (password + full 2FA via accountSecurity
 * when session-backed, or password + fail-closed MFA-off check in fallback mode).
 * Runs optional onAuthorized(client) inside accountSecurity's transaction when available
 * so PGlite / PG callers never open nested transactions.
 */
async function verifyAdminStepUp(req, pool, config, onAuthorized) {
  const adminPassword = req.body?.password;
  if (!withinBcryptLimit(adminPassword)) {
    const err = new Error('Mật khẩu quản trị viên không chính xác.');
    err.status = 403;
    throw err;
  }

  if (config?.accountSecurity && req.session?.admin?.source) {
    try {
      return await config.accountSecurity.authorize(req, async (_account, client) =>
        (typeof onAuthorized === 'function' ? onAuthorized(client) : { authorized: true })
      );
    } catch (err) {
      if (err?.code === 'CURRENT_PASSWORD_INVALID') {
        const mapped = new Error('Mật khẩu quản trị viên không chính xác.');
        mapped.status = 403;
        throw mapped;
      }
      throw err;
    }
  }

  const adminHash = await resolveAdminPasswordHash(req, pool, config);
  if (!adminHash) {
    const err = new Error('Không thể xác thực danh tính quản trị viên.');
    err.status = 401;
    throw err;
  }

  const passwordMatches = await bcrypt.compare(adminPassword, adminHash);
  if (!passwordMatches) {
    const err = new Error('Mật khẩu quản trị viên không chính xác.');
    err.status = 403;
    throw err;
  }

  const secKey = (req.admin?.source === 'bootstrap' || req.admin?.role === 'owner')
    ? 'owner'
    : (req.admin?.id ? 'staff:' + req.admin.id : null);
  if (secKey) {
    let secRow = null;
    try {
      secRow = (await pool.query('SELECT method FROM account_security WHERE account_key = $1', [secKey])).rows[0];
    } catch (err) {
      if (err?.code !== '42P01') throw err;
    }
    if (secRow?.method && secRow.method !== 'off') {
      const err = new Error('Tài khoản đã bật xác thực hai yếu tố; vui lòng xác thực đầy đủ qua phiên bảo mật.');
      err.status = 403;
      throw err;
    }
  }

  if (typeof onAuthorized === 'function') {
    const { withTransaction } = require('../db');
    return withTransaction(pool, onAuthorized);
  }
  return { authorized: true };
}

module.exports = {
  verifyAdminStepUp
};
