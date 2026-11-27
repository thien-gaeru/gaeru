'use strict';

const crypto = require('node:crypto');

const DEFAULT_GPU_AI_URL = (process.env.GAERU_GPU_AI_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const CIRCUIT_OPEN_MS = 15000;
const EMBED_CACHE_MAX = 1024;
const EMBED_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_EMBED_TEXT_CHARS = 320;
const DEFAULT_EMBED_BATCH_SIZE = 8;
const DEFAULT_EMBED_TIMEOUT_MS = 12000;
const DEFAULT_RMBG_TIMEOUT_MS = 10000;

let circuitOpenUntil = 0;
let consecutiveFailures = 0;
let halfOpenProbeInFlight = false;
let cacheHits = 0;
let cacheMisses = 0;
let thermalSheds = 0;
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
  halfOpenProbeInFlight = false;
  cacheHits = 0;
  cacheMisses = 0;
  thermalSheds = 0;
  embedCache.clear();
}

function getGpuAiRuntimeStats() {
  return {
    enabled: isGpuAiEnabled(),
    baseUrl: DEFAULT_GPU_AI_URL,
    circuitOpen: isCircuitOpen(),
    consecutiveFailures,
    embedCacheSize: embedCache.size,
    embedCacheMax: EMBED_CACHE_MAX,
    cacheHits,
    cacheMisses,
    thermalSheds
  };
}

function isCircuitOpen() {
  return Date.now() < circuitOpenUntil;
}

function tryEnterHalfOpenSlot() {
  if (circuitOpenUntil === 0) return { allowed: true, isHalfOpenProbe: false };
  if (Date.now() < circuitOpenUntil) return { allowed: false, isHalfOpenProbe: false };
  if (halfOpenProbeInFlight) return { allowed: false, isHalfOpenProbe: false };
  halfOpenProbeInFlight = true;
  return { allowed: true, isHalfOpenProbe: true };
}

function recordSuccess() {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

function recordFailure({ hard = false } = {}) {
  consecutiveFailures += 1;
  if (hard || consecutiveFailures >= 2 || circuitOpenUntil > 0) {
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

async function runWithFetchTimeout(url, options = {}, timeoutMs = 4000, transport = fetch, onResponse = null) {
  const controller = new AbortController();
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const abortErr = Object.assign(new Error(`GPU AI request timed out after ${timeoutMs}ms`), { name: 'AbortError' });
      controller.abort(abortErr);
      reject(abortErr);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    const res = await Promise.race([
      transport(url, { ...options, signal: controller.signal }),
      timeoutPromise
    ]);
    if (typeof onResponse !== 'function') return res;
    return await Promise.race([
      Promise.resolve().then(() => onResponse(res, controller.signal)),
      timeoutPromise
    ]);
  } catch (err) {
    try { controller.abort(); } catch (_) {}
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkGpuHealth({ baseUrl = DEFAULT_GPU_AI_URL, timeoutMs = 1500, transport = fetch } = {}) {
  try {
    return await runWithFetchTimeout(
      `${baseUrl}/health`,
      { method: 'GET' },
      timeoutMs,
      transport,
      async (res) => {
        if (!res.ok) {
          try { await res.body?.cancel?.(); } catch (_) {}
          return null;
        }
        return await res.json();
      }
    );
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
  let probeToken = false;
  if (transport === fetch) {
    const gate = tryEnterHalfOpenSlot();
    if (!gate.allowed) return null;
    probeToken = gate.isHalfOpenProbe;
  }
  if (!Buffer.isBuffer(rgbBuffer) || rgbBuffer.length !== width * height * 3) {
    if (probeToken) halfOpenProbeInFlight = false;
    return null;
  }

  try {
    const out = await runWithFetchTimeout(
      `${baseUrl}/v1/remove-bg?w=${width}&h=${height}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: rgbBuffer
      },
      timeoutMs,
      transport,
      async (res) => {
        if (!res.ok) {
          try { await res.body?.cancel?.(); } catch (_) {}
          if (res.status >= 500 && transport === fetch) recordFailure({ hard: false });
          return null;
        }
        const ab = await res.arrayBuffer();
        const alpha = Buffer.from(ab);
        if (alpha.length !== width * height) {
          if (transport === fetch) recordFailure({ hard: false });
          return null;
        }

        if (transport === fetch) recordSuccess();
        const fgRatio = parseFloat(res.headers?.get?.('x-foreground-ratio') || '0');
        const rawMin = parseFloat(res.headers?.get?.('x-raw-min') || '0');
        const rawMax = parseFloat(res.headers?.get?.('x-raw-max') || '0');
        const inferenceMs = parseFloat(res.headers?.get?.('x-inference-ms') || '0');
        return { alpha, fgRatio, rawMin, rawMax, inferenceMs };
      }
    );
    return out;
  } catch (err) {
    if (transport === fetch) {
      const hard = err?.name !== 'AbortError' && err?.name !== 'TimeoutError';
      recordFailure({ hard });
    }
    return null;
  } finally {
    if (probeToken) halfOpenProbeInFlight = false;
  }
}

async function embedTexts(texts, {
  baseUrl = DEFAULT_GPU_AI_URL,
  timeoutMs = DEFAULT_EMBED_TIMEOUT_MS,
  batchSize = DEFAULT_EMBED_BATCH_SIZE,
  priority = 'normal',
  transport = fetch
} = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (!isGpuAiEnabled() && transport === fetch) return null;
  const isBackground = priority === 'background';
  let probeToken = false;
  if (transport === fetch) {
    if (isBackground && isCircuitOpen()) return null;
    const gate = tryEnterHalfOpenSlot();
    if (!gate.allowed) return null;
    probeToken = gate.isHalfOpenProbe;
  }

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
      cacheHits++;
      results[i] = cached;
      continue;
    }
    cacheMisses++;
    if (seenMissing.has(key)) {
      seenMissing.get(key).indices.push(i);
    } else {
      const entry = { key, text: txt, indices: [i] };
      seenMissing.set(key, entry);
      missing.push(entry);
    }
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (isBackground) headers['X-AI-Priority'] = 'background';
    for (let start = 0; start < missing.length; start += batchSize) {
      const chunk = missing.slice(start, start + batchSize);
      try {
        const payload = await runWithFetchTimeout(
          `${baseUrl}/v1/embed`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ input: chunk.map(item => item.text) })
          },
          timeoutMs,
          transport,
          async (res) => {
            if (!res.ok) {
              try { await res.body?.cancel?.(); } catch (_) {}
              // Background thermal/busy shed (503) must NOT trip live circuit breaker
              if (isBackground && res.status === 503) {
                thermalSheds++;
                return null;
              }
              if (res.status >= 500 && transport === fetch) recordFailure({ hard: false });
              return null;
            }
            return await res.json();
          }
        );
        if (!payload) return null;
        const data = Array.isArray(payload?.data) ? payload.data : [];
        if (data.length !== chunk.length) {
          if (transport === fetch) recordFailure({ hard: false });
          return null;
        }

        for (let j = 0; j < chunk.length; j++) {
          const vec = normalizeUnitVector(data[j]?.embedding);
          if (!vec) {
            if (transport === fetch) recordFailure({ hard: false });
            return null;
          }
          setCachedEmbedding(chunk[j].key, vec);
          for (const idx of chunk[j].indices) results[idx] = vec;
        }
        if (transport === fetch) recordSuccess();
      } catch (err) {
        if (transport === fetch && !isBackground) {
          const hard = err?.name !== 'AbortError' && err?.name !== 'TimeoutError';
          recordFailure({ hard });
        }
        return null;
      }
    }
  } finally {
    if (probeToken) halfOpenProbeInFlight = false;
  }

  return results;
}

async function embedText(text, options = {}) {
  const vecs = await embedTexts([text], options);
  return Array.isArray(vecs) ? (vecs[0] || null) : null;
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
  getGpuAiRuntimeStats,
  hashEmbeddingText: hashKey,
  checkGpuHealth,
  segmentForegroundMask,
  embedText,
  embedTexts,
  cosineSimilarity
};
