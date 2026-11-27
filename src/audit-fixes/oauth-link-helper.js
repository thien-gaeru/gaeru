'use strict';

const { withTransaction } = require('../db');

/**
 * Links a verified OAuth identity to a customer ONLY after full authentication succeeds.
 */
async function applyPendingOAuthLink(pool, customer, pending) {
  if (!pending || pending.provider !== 'google' || !pending.googleSub || !pending.email) {
    return false;
  }
  const createdAt = Number(pending.createdAt);
  if (Number.isFinite(createdAt) && (Date.now() - createdAt > 15 * 60 * 1000 || Date.now() < createdAt - 60000)) {
    return false;
  }
  const customerEmail = String(customer?.email || '').trim().toLowerCase();
  const pendingEmail = String(pending.email || '').trim().toLowerCase();
  if (!customer?.id || !customerEmail || customerEmail !== pendingEmail) {
    return false;
  }

  const runLink = async (client) => {
    await client.query(
      `INSERT INTO auth_identities (customer_id, provider, issuer, provider_subject, email_at_link)
       VALUES ($1, 'google', 'https://accounts.google.com', $2, $3)
       ON CONFLICT (provider, issuer, provider_subject) DO NOTHING`,
      [customer.id, pending.googleSub, customer.email]
    );
    const existing = (await client.query(
      `SELECT customer_id FROM auth_identities
       WHERE provider = 'google' AND issuer = 'https://accounts.google.com' AND provider_subject = $1
       FOR UPDATE`,
      [pending.googleSub]
    )).rows[0];
    if (!existing || existing.customer_id !== customer.id) {
      return false;
    }
    const upd = await client.query(
      `UPDATE customers
       SET google_id = COALESCE(google_id, $1),
           avatar_url = COALESCE(NULLIF(avatar_url, ''), $2),
           email_verified_at = COALESCE(email_verified_at, now()),
           updated_at = now()
       WHERE id = $3 AND deleted_at IS NULL AND active = true`,
      [pending.googleSub, pending.picture || null, customer.id]
    );
    if (!upd.rowCount) return false;
    customer.googleId = customer.googleId || pending.googleSub;
    customer.emailVerified = true;
    return true;
  };

  try {
    if (typeof pool?.connect === 'function') {
      return await withTransaction(pool, runLink);
    }
    await pool.query('SAVEPOINT sp_apply_pending_oauth_link');
    try {
      const ok = await runLink(pool);
      await pool.query('RELEASE SAVEPOINT sp_apply_pending_oauth_link');
      return ok;
    } catch (innerErr) {
      await pool.query('ROLLBACK TO SAVEPOINT sp_apply_pending_oauth_link').catch(() => {});
      throw innerErr;
    }
  } catch (linkErr) {
    console.warn('Auto-linking pending OAuth failed:', linkErr.message);
    return false;
  }
}

module.exports = { applyPendingOAuthLink };
