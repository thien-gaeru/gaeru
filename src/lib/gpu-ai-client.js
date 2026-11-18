'use strict';

const crypto = require('node:crypto');

const DEFAULT_GPU_AI_URL = (process.env.GAERU_GPU_AI_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const CIRCUIT_OPEN_MS = 15000;
const EMBED_CACHE_MAX = 512;
const EMBED_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_EMBED_TEXT_CHARS = 320;
const DEFAULT_EMBED_BATCH_SIZE = 8;
const DEFAULT_EMBED_TIMEOUT_MS = 12000;
const DEFAULT_RMBG_TIMEOUT_MS = 10000;

let circuitOpenUntil = 0;
let consecutiveFailures = 0;
const embedCache = new Map();

function isGpuAiEnabled() {
  const flag = process.env.GAERU_GPU_AI_ENABLED;
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (flag === '1' || flag === 'true' || flag === 'on') return true;
  if ((process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) && process.env.GAERU_GPU_AI_TEST !== '1') {
    return false;
  }
  return true;
}

function resetGpuAiState() {
  circuitOpenUntil = 0;
  consecutiveFailures = 0;
  embedCache.clear();
}

function isCircuitOpen() {
  return Date.now() < circuitOpenUntil;
}

function recordSuccess() {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

function recordFailure({ hard = false } = {}) {
  consecutiveFailures += 1;
  if (hard || consecutiveFailures >= 2) {
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
  }
}

function hashKey(text) {
  return crypto.createHash('sha1').update(text).digest('base64url');
}

function getCachedEmbedding(key) {
  const hit = embedCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    embedCache.delete(key);
    return null;
  }
  embedCache.delete(key);
  embedCache.set(key, hit);
  return hit.vec;
}

function setCachedEmbedding(key, vec) {
  if (embedCache.size >= EMBED_CACHE_MAX) {
    const oldestKey = embedCache.keys().next().value;
    if (oldestKey !== undefined) embedCache.delete(oldestKey);
  }
  embedCache.set(key, {
    vec,
    expiresAt: Date.now() + EMBED_CACHE_TTL_MS
  });
}

function normalizeUnitVector(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const out = new Float32Array(arr.length);
  let normSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = Number(arr[i]) || 0;
    out[i] = v;
    normSq += v * v;
  }
  if (!Number.isFinite(normSq) || normSq <= 1e-12) return null;
  const inv = 1 / Math.sqrt(normSq);
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000, transport = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await transport(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkGpuHealth({ baseUrl = DEFAULT_GPU_AI_URL, timeoutMs = 1500, transport = fetch } = {}) {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/health`, { method: 'GET' }, timeoutMs, transport);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function segmentForegroundMask(rgbBuffer, {
  width = 320,
  height = 320,
  baseUrl = DEFAULT_GPU_AI_URL,
  timeoutMs = DEFAULT_RMBG_TIMEOUT_MS,
  transport = fetch
} = {}) {
  if (!isGpuAiEnabled() && transport === fetch) return null;
  if (isCircuitOpen() && transport === fetch) return null;
  if (!Buffer.isBuffer(rgbBuffer) || rgbBuffer.length !== width * height * 3) return null;

  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/v1/remove-bg?w=${width}&h=${height}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: rgbBuffer
      },
      timeoutMs,
      transport
    );
    if (!res.ok) {
      if (res.status >= 500 && transport === fetch) recordFailure({ hard: false });
      return null;
    }
    const ab = await res.arrayBuffer();
    const alpha = Buffer.from(ab);
    if (alpha.length !== width * height) return null;

    if (transport === fetch) recordSuccess();
    const fgRatio = parseFloat(res.headers?.get?.('x-foreground-ratio') || '0');
    const rawMin = parseFloat(res.headers?.get?.('x-raw-min') || '0');
    const rawMax = parseFloat(res.headers?.get?.('x-raw-max') || '0');
    const inferenceMs = parseFloat(res.headers?.get?.('x-inference-ms') || '0');
    return { alpha, fgRatio, rawMin, rawMax, inferenceMs };
  } catch (err) {
    if (transport === fetch) {
      const hard = err?.name !== 'AbortError' && err?.name !== 'TimeoutError';
      recordFailure({ hard });
    }
    return null;
  }
}

async function embedTexts(texts, {
  baseUrl = DEFAULT_GPU_AI_URL,
  timeoutMs = DEFAULT_EMBED_TIMEOUT_MS,
  batchSize = DEFAULT_EMBED_BATCH_SIZE,
  transport = fetch
} = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (!isGpuAiEnabled() && transport === fetch) return null;
  if (isCircuitOpen() && transport === fetch) return null;

  const cleaned = texts.map(t => String(t || '').trim().slice(0, MAX_EMBED_TEXT_CHARS));
  const results = new Array(cleaned.length).fill(null);
  const missing = [];
  const seenMissing = new Map();

  for (let i = 0; i < cleaned.length; i++) {
    const txt = cleaned[i];
    if (!txt) continue;
    const key = hashKey(txt);
    const cached = getCachedEmbedding(key);
    if (cached) {
      results[i] = cached;
      continue;
    }
    if (seenMissing.has(key)) {
      seenMissing.get(key).indices.push(i);
    } else {
      const entry = { key, text: txt, indices: [i] };
      seenMissing.set(key, entry);
      missing.push(entry);
    }
  }

  for (let start = 0; start < missing.length; start += batchSize) {
    const chunk = missing.slice(start, start + batchSize);
    try {
      const res = await fetchWithTimeout(
        `${baseUrl}/v1/embed`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: chunk.map(item => item.text) })
        },
        timeoutMs,
        transport
      );
      if (!res.ok) {
        if (res.status >= 500 && transport === fetch) recordFailure({ hard: false });
        return null;
      }
      const payload = await res.json();
      const data = Array.isArray(payload?.data) ? payload.data : [];
      if (data.length !== chunk.length) return null;

      for (let j = 0; j < chunk.length; j++) {
        const vec = normalizeUnitVector(data[j]?.embedding);
        if (!vec) return null;
        setCachedEmbedding(chunk[j].key, vec);
        for (const idx of chunk[j].indices) results[idx] = vec;
      }
      if (transport === fetch) recordSuccess();
    } catch (err) {
      if (transport === fetch) {
        const hard = err?.name !== 'AbortError' && err?.name !== 'TimeoutError';
        recordFailure({ hard });
      }
      return null;
    }
  }

  return results;
}

module.exports = {
  DEFAULT_GPU_AI_URL,
  DEFAULT_EMBED_BATCH_SIZE,
  DEFAULT_EMBED_TIMEOUT_MS,
  DEFAULT_RMBG_TIMEOUT_MS,
  MAX_EMBED_TEXT_CHARS,
  isGpuAiEnabled,
  resetGpuAiState,
  isCircuitOpen,
  checkGpuHealth,
  segmentForegroundMask,
  embedTexts,
  cosineSimilarity
};
