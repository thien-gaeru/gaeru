'use strict';

const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function payloadTooLarge(label, maxBytes) {
  const err = new Error(`${label} response exceeded ${maxBytes} bytes`);
  err.status = 502;
  return err;
}

/**
 * Reads an HTTP fetch response body with a strict streaming byte cap before parsing JSON.
 * Falls back cleanly to `.text()` or `.json()` on lightweight mock response objects in tests.
 */
async function readBoundedText(res, { maxBytes = DEFAULT_MAX_RESPONSE_BYTES, label = 'API' } = {}) {
  const declaredLength = Number(res?.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await res?.body?.cancel?.(); } catch (_) {}
    throw payloadTooLarge(label, maxBytes);
  }
  if (res?.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        total += buf.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw payloadTooLarge(label, maxBytes);
        }
        chunks.push(buf);
      }
      return Buffer.concat(chunks, total).toString('utf8');
    } finally {
      try { reader.releaseLock?.(); } catch (_) {}
    }
  }
  if (typeof res?.text === 'function') {
    const text = await res.text();
    if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw payloadTooLarge(label, maxBytes);
    }
    return text;
  }
  if (typeof res?.json === 'function') {
    return await res.json();
  }
  throw Object.assign(new Error(`${label} response reader unavailable`), { status: 502 });
}

async function readBoundedJson(res, options = {}) {
  const body = await readBoundedText(res, options);
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch (_) {
    const label = options?.label || 'API';
    throw Object.assign(new Error(`${label} returned invalid JSON`), { status: 502 });
  }
}

module.exports = {
  DEFAULT_MAX_RESPONSE_BYTES,
  readBoundedText,
  readBoundedJson
};
