'use strict';
function failureStatus(error, attempts, maxAttempts = 3) {
  const code = Number(error?.responseCode);
  const rejected = Number.isInteger(code) && code >= 400 && code < 600;
  const beforeData = !error?.responseCode && ['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH', 'MAIL FROM', 'RCPT TO'].includes(error?.command);
  const retryable = (rejected && code < 500) || beforeData;
  if (retryable && attempts < maxAttempts) return 'pending';
  return rejected || beforeData ? 'failed' : 'unknown';
}
module.exports = { failureStatus };
