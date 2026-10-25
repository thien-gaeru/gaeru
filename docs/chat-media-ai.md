# Trợ giúp GAERU: media and AI configuration

Customers and staff can view JPEG/PNG/WebP images and play supported MP4/MOV/WebM videos directly in chat. Authenticated media endpoints retain thread ownership checks, no-store headers, safe MIME handling and attachment downloads. Videos support byte ranges for seeking. HEIC or unsupported codecs retain the download option. Local previews use temporary blob URLs; choosing a file does not upload it. Removed, sent and abandoned previews release their URLs.

When AI cannot continue, its response offers a staff connection. AI pauses until the customer chooses to connect. Explicit requests for a person connect immediately. The connection action disappears while waiting. The five-minute clock starts when the server records the handoff, survives reopening and does not restart on customer follow-ups. If no employee has replied since that handoff, the UI offers tel:0829191080, displayed as 082.919.1080. Staff replies and closing the conversation remove the reminder. Time passing is a local display update plus the existing live polling; no repeated reminder messages are stored.

Owner → Store settings → Chat AI supports separate encrypted API keys and model IDs for OpenAI/GPT, Google Gemini and Anthropic Claude. Blank key fields preserve existing keys. Only the selected provider is used; credentials are never sent to the browser or included in audit snapshots. The existing server OpenAI configuration remains active until an owner saves a replacement. Saving and testing require the existing owner reauthentication/MFA flow. Disabling AI offers staff support.

The test button uses the saved model/key and sends a synthetic greeting with fixture product information, not customer messages or attachments. It can consume provider API usage. A successful result means that the selected credentials/model returned a valid GAERU answer/handoff object at that time. Failures, refusal, truncation, invalid JSON or unavailable quota never report success. Model IDs and account availability vary; no account-specific compatibility is claimed without this check. Requests use fixed official endpoints and do not follow redirects. Attachments remain for staff and are not sent to the language model.

Official API references reviewed on 2026-10-25:

- OpenAI Responses/text: https://developers.openai.com/api/docs/guides/text
- Gemini generateContent: https://ai.google.dev/api/generate-content
- Gemini structured output: https://ai.google.dev/gemini-api/docs/structured-output
- Claude Messages: https://platform.claude.com/docs/en/api/messages/create

Validation uses real PostgreSQL-compatible PGlite for the role/CSRF/secret retention/handoff/media workflows and mocked provider transports for all three providers. Browser fixtures verify actual media decoding/playback, unsent previews, mobile layout and waiting/hotline transitions. No production customer data, provider key or paid model call is used by these tests.

Connection diagnostics (2026-10-25): owner probes now return the tested provider/model, a localized diagnostic category, the upstream HTTP status and a bounded request ID when available. They never return upstream error text, API keys, customer questions or response bodies. Categories distinguish invalid/restricted keys, API disabled, workspace requirements, permissions, billing/quota, unsupported model/request, service/network/TLS/timeout failures, incomplete output and invalid chat JSON. Authentication/configuration failures are reported before a provider request.

The UI refuses unsaved selection/model/key changes, includes its expected provider/model with the saved version, and keeps the AI panel open after saving. Save and probe remain separate reauthenticated operations. A provider failure clears already-consumed authentication fields before another attempt; it does not log the owner out when the upstream service returned 401.

Claude now requests constrained JSON using output_config.format. Gemini/Claude output ceilings increase from 1200 to 4096 tokens to leave room for model output/reasoning; this can increase maximum API usage. Timeouts remain 25 seconds, no automatic paid retries are introduced, and the existing chat request/rate limits remain. These changes do not prove a particular real account/key/model works. The owner must run the saved-configuration test after release to obtain the actual diagnosis.

Error references: https://ai.google.dev/gemini-api/docs/troubleshooting ; https://platform.claude.com/docs/en/api/errors ; https://developers.openai.com/api/docs/guides/error-codes . Claude JSON reference: https://platform.claude.com/docs/en/build-with-claude/structured-outputs .
