# Review CodeQL payment alerts 85, 87, 121, 122 and 126

Reviewed 2026-11-03 against working branch `codex/final-acceptance-20261103`, starting at commit `e621683`. Both GitHub alerts were open on the full default-branch analysis of `9e517e9c4adcdf875fe486b4356f891b057a94a8`, analysis ID `2082527827`. The PR's incremental result does not establish that these default-branch findings are resolved.

## Alert 85: type confusion through parameter tampering

[GitHub alert 85](https://github.com/thien-gaeru/gaeru/security/code-scanning/85) identifies `payload.requestId.length` in `src/payment-channels.js:179` at the scanned commit. SARIF provides this location without a code-flow trace.

The scanned source already rejects non-string `requestId` through the preceding `textFields.some(field => typeof payload[field] !== 'string' || ...)` condition. Because `requestId` is in that field list, JavaScript short-circuits before reaching the length condition or signature verification for an array/object/null/number/boolean. No type-confusion bypass was reproduced.

The regression signs each malformed JSON value with the fixture merchant's correct HMAC, including a one-element array whose string coercion equals a legitimate request ID. It checks both the verifier and the actual HTTP IPN route: each is rejected, with zero database reads or transactions. String IDs of length 100 remain valid; length 101 is rejected. These checks passed before the patch.

Classification: false positive for the reviewed path. The patch makes the existing type and length requirements explicit at the `requestId` use site, preserving behavior and making the guard visible to static analysis. It does not introduce a new payment protocol or weaken signature checks.

## Alert 87: externally controlled format string

[GitHub alert 87](https://github.com/thien-gaeru/gaeru/security/code-scanning/87) traces `req.params.id` to the first argument of the invoice-error `console.error` in `src/store-api.js:2064` at the scanned commit.

The route already runs `requireUuidParam('id')` before its handler. Accepted UUID characters cannot contain `%` format directives. Actual HTTP requests containing `%s`, `%d`, `%j`, `%o`, `%%`, or a UUID plus `%s` return 400 before database work or invoice-error logging. These checks passed before the patch. The current invoice auto-issue function also returns a skipped result while its external protocol is disabled; that fact is additional context, not the primary guard.

Classification: false positive for the routed request path. As defense in depth, the patch changes the log to a constant format string and passes the validated order ID and error message as separate `%s` arguments.

## Alerts 121, 122 and 126: sensitive query credentials

[Alert 121](https://github.com/thien-gaeru/gaeru/security/code-scanning/121), [alert 122](https://github.com/thien-gaeru/gaeru/security/code-scanning/122) and [alert 126](https://github.com/thien-gaeru/gaeru/security/code-scanning/126) trace generic bank callback credential selection through request data. The reported browser GET return handler only permits MoMo/ZaloPay, so it cannot execute the bank branch. However, the actual bank POST webhook accepted shared secrets in `?token=` or `?secret=` and in legacy JSON token aliases. This was a real credential-transport weakness even though the described GET route is guarded: a secret used in a POST URL can still enter proxy/access logs.

The new regression demonstrated the defect before the fix: a correct query token authorized the verifier (`true`, expected `false`). The patch now reads bank webhook shared credentials only from supported HTTP authentication headers, or verifies the existing HMAC signature from `X-Signature`. It no longer reads query or JSON token aliases, and the IPN caller no longer passes query parameters as credential options. Header values must be strings; malformed arrays/objects fail closed. Official MoMo and ZaloPay signed callback envelopes are unchanged.

Bank webhook clients that previously put a secret in the URL or a JSON `token`/`secret` field must move it to `Secure-Token`, `X-API-Key`, another supported provider authentication header, or the existing `Authorization: Bearer ...` / `Authorization: Apikey ...` form. The HMAC path retains `X-Signature`. Secrets do not belong in callback URLs. Production logs should be reviewed for previously exposed query credentials, and any exposed credential rotated through owner configuration.

## Verification and remaining scan boundary

`node --test test/codeql-payment-and-logging-regression.test.js` passed 2/2 before either source change. The same regressions and the existing payment/store suites are rerun after the patch. No live gateway, production database, alert dismissal or deployment is involved.

The GitHub alert state is not automatically changed by these local checks. A fresh full CodeQL scan of the patched commit is required to determine whether the analyzer now recognizes the guards and removed credential paths. The other open default-branch alerts are outside this five-alert review; an incremental PR result must not be described as a clean full-repository security scan.
