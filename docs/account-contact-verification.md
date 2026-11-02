# Account contact changes

- The profile editor allows name, email and phone edits. Name updates apply immediately.
- Contact changes require the current password and confirmation through the existing email. A new email also requires confirmation through the new mailbox. Phone changes are authorized by email; no SMS ownership verification is claimed.
- Contacts remain unchanged until all required confirmations finish. Links expire after 30 minutes, are stored as SHA-256 hashes, belong to one authenticated customer and cannot be replayed. A new request cancels previous pending requests.
- Password changes invalidate pending requests through a password-hash fingerprint. Successful contact changes invalidate outstanding password-reset and email-verification tokens.
- The direct profile endpoint rejects email/phone changes so it cannot bypass verification. Delivery-address contact details remain separate from account credentials.
- SMTP must be configured. A send failure cancels the pending request and returns an error. Mail-provider acceptance does not prove inbox delivery.
- Migration `contact-changes.sql` is additive and runs before the server accepts requests. PostgreSQL transactions lock the customer before the request record.

## Validation

`node --test test/contact-change.integration.test.js` exercises real embedded PostgreSQL statements with a stub mail provider: password checks, direct-update bypass, two-mailbox verification, phone-only verification, account binding, replay, expiry and delivery failure. No production customer or email is created by these tests.

Product setup articles are separate public HTML pages linked from `guides.html` and CARE+. They use existing product images and avoid unsupported model-specific button sequences. Exact controls and accessories must be checked against the supplied manual for the purchased version.
