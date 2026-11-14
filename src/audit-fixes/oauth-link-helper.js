'use strict';

/**
 * Links a verified OAuth identity to a customer ONLY after full authentication succeeds.
 */
async function applyPendingOAuthLink(pool, customer, pending) {
  if (!pending || pending.provider !== 'google' || !pending.googleSub || !pending.email) {
    return false;
  }
  const customerEmail = String(customer?.email || '').trim().toLowerCase();
  const pendingEmail = String(pending.email || '').trim().toLowerCase();
  if (!customer?.id || !customerEmail || customerEmail !== pendingEmail) {
    return false;
  }

  try {
    await pool.query(
      `INSERT INTO auth_identities (customer_id, provider, issuer, provider_subject, email_at_link)
       VALUES ($1, 'google', 'https://accounts.google.com', $2, $3)
       ON CONFLICT (provider, issuer, provider_subject)
       DO UPDATE SET customer_id = $1, email_at_link = $3, linked_at = now()`,
      [customer.id, pending.googleSub, customer.email]
    );
    await pool.query(
      `UPDATE customers
       SET google_id = COALESCE(google_id, $1),
           avatar_url = COALESCE(avatar_url, $2),
           email_verified_at = COALESCE(email_verified_at, now()),
           updated_at = now()
       WHERE id = $3 AND deleted_at IS NULL`,
      [pending.googleSub, pending.picture || null, customer.id]
    );
    customer.googleId = pending.googleSub;
    customer.emailVerified = true;
    return true;
  } catch (linkErr) {
    console.warn('Auto-linking pending OAuth failed:', linkErr.message);
    return false;
  }
}

module.exports = { applyPendingOAuthLink };
