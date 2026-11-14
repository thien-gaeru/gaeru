'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { readMedia } = require('./stored-media');
const { createObjectCache } = require('./object-cache');
const { qualifiesForSelectiveAvif, encodeAvif, SAVINGS_RATIO } = require('./selective-avif');

const widths = [480, 800, 1200];
const MAX_ROW_CACHE_ENTRIES = 512;
const MAX_ROW_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_SINGLE_ROW_CACHE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_WARM_RSS_BYTES = process.arch === 'arm64'
  ? 600 * 1024 * 1024
  : Math.floor(2.2 * 1024 * 1024 * 1024);
const cache = createObjectCache({
  maxBytes: 48 * 1024 * 1024,
  maxEntryBytes: 4 * 1024 * 1024,
  ttl: 24 * 3600000,
  maxPending: 64
});
const poolRowCaches = new WeakMap();
const trackedPools = new Set();
let active = 0;
const waiting = [];
let getRuntimeEncodeCount = 0;
let warmEncodeCount = 0;
let skippedWarmByRssCount = 0;
let diskCacheHits = 0;

function isDiskRenditionCacheEnabled() {
  if (process.env.RENDITION_DISK_CACHE === 'false' || process.env.MEDIA_CACHE_ENABLED === 'false') return false;
  if (process.env.RENDITION_DISK_CACHE === 'true') return true;
  return process.env.NODE_ENV === 'production' && typeof process.env.MEDIA_ROOT === 'string' && process.env.MEDIA_ROOT.trim().length > 0;
}

function getRenditionFilePath(version) {
  const baseDir = process.env.RENDITION_CACHE_DIR || path.join(process.cwd(), '.local-data', 'renditions');
  return path.join(baseDir, version.slice(0, 2), version + '.bin');
}

async function readDiskRendition(version) {
  if (!isDiskRenditionCacheEnabled() || !/^[0-9a-f]{64}$/.test(version)) return null;
  try {
    const filePath = getRenditionFilePath(version);
    const bytes = await fs.readFile(filePath);
    if (bytes && bytes.length > 0 && bytes.length <= 4 * 1024 * 1024) {
      diskCacheHits++;
      return bytes;
    }
  } catch (_) {}
  return null;
}

async function writeDiskRendition(version, bytes) {
  if (!isDiskRenditionCacheEnabled() || !Buffer.isBuffer(bytes) || !bytes.length || !/^[0-9a-f]{64}$/.test(version)) return;
  try {
    const filePath = getRenditionFilePath(version);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tempPath = path.join(dir, '.' + version.slice(0, 12) + '-' + process.pid + '-' + randomUUID().slice(0, 8) + '.tmp');
    await fs.writeFile(tempPath, bytes, { mode: 0o600 });
    await fs.rename(tempPath, filePath).catch(async () => {
      await fs.unlink(tempPath).catch(() => {});
    });
  } catch (_) {}
}

async function loadDiskRenditionIntoCache(version) {
  if (!isDiskRenditionCacheEnabled()) return null;
  const hit = cache.peek(version);
  if (hit) return hit;
  const diskBytes = await readDiskRendition(version);
  if (!diskBytes) return null;
  return cache.get(version, () => diskBytes);
}

function estimateRowBytes(row) {
  if (!row || typeof row !== 'object') return 256;
  let bytes = 256;
  if (Buffer.isBuffer(row.content)) bytes += row.content.length;
  else if (typeof row.content === 'string') bytes += Buffer.byteLength(row.content, 'utf8');
  else if (row.content?.byteLength) bytes += Number(row.content.byteLength) || 0;
  if (typeof row.mime_type === 'string') bytes += row.mime_type.length;
  if (typeof row._digest === 'string') bytes += row._digest.length;
  return bytes;
}

async function bounded(work) {
  const defaultConc = process.arch === 'arm64' ? 1 : 2;
  const maxConcurrentEncodes = Math.max(1, Number(process.env.MAX_CONCURRENT_IMAGE_ENCODES) || defaultConc);
  if (active >= maxConcurrentEncodes) await new Promise(resolve => waiting.push(resolve));
  else active++;
  try { return await work(); }
  finally { const resume = waiting.shift(); if (resume) resume(); else active--; }
}
function canUseRowCache(pool) {
  return Boolean(pool && pool.__gaeruCacheHooked) && process.env.MEDIA_CACHE_ENABLED !== 'false';
}
function getPoolState(pool) {
  let state = poolRowCaches.get(pool);
  if (!state) {
    state = { rows: new Map(), pending: new Map(), bytes: 0 };
    poolRowCaches.set(pool, state);
    if (!pool.__gaeruRenditionTracked) {
      trackedPools.add(new WeakRef(pool));
      Object.defineProperty(pool, '__gaeruRenditionTracked', { value: true });
    }
  }
  return state;
}
function clearImageLookupCache(pool, { broadcast = true } = {}) {
  if (pool && typeof pool === 'object') {
    const state = poolRowCaches.get(pool);
    if (state) {
      state.rows.clear();
      state.pending.clear();
      state.bytes = 0;
    }
  }
  if (broadcast && typeof process.send === 'function') {
    try {
      process.send({ type: 'RENDITION_CACHE_INVALIDATE', timestamp: Date.now() });
    } catch (_) {}
  }
}
function clearAllImageLookupCaches() {
  for (const ref of trackedPools) {
    const p = ref.deref();
    if (!p) {
      trackedPools.delete(ref);
      continue;
    }
    clearImageLookupCache(p, { broadcast: false });
  }
}
const RENDITION_IPC_KEY = Symbol.for('gaeru.imageRenditions.ipcRegistered');
if (typeof process.on === 'function' && !process[RENDITION_IPC_KEY]) {
  process[RENDITION_IPC_KEY] = true;
  process.on('message', (msg) => {
    if (msg && msg.type === 'RENDITION_CACHE_INVALIDATE') {
      clearAllImageLookupCaches();
    }
  });
}
async function getCachedImageRow(pool, key, loader) {
  if (!canUseRowCache(pool)) return loader();
  const state = getPoolState(pool);
  const now = Date.now();
  const hit = state.rows.get(key);
  if (hit && hit.until > now) {
    state.rows.delete(key);
    state.rows.set(key, hit);
    return hit.row;
  }
  if (hit) {
    state.bytes = Math.max(0, state.bytes - (hit.bytes || 0));
    state.rows.delete(key);
  }
  if (state.pending.has(key)) return state.pending.get(key);
  const task = Promise.resolve().then(loader).then(row => {
    if (row) {
      if (row.content !== undefined && row.mime_type) {
        row._digest = createHash('sha256').update(row.content).update('\0').update(row.mime_type).digest('hex');
      }
      const rowBytes = estimateRowBytes(row);
      if (rowBytes <= MAX_SINGLE_ROW_CACHE_BYTES) {
        if (state.rows.has(key)) {
          const prev = state.rows.get(key);
          state.bytes = Math.max(0, state.bytes - (prev?.bytes || 0));
          state.rows.delete(key);
        }
        while ((state.rows.size >= MAX_ROW_CACHE_ENTRIES || state.bytes + rowBytes > MAX_ROW_CACHE_BYTES) && state.rows.size > 0) {
          const oldestKey = state.rows.keys().next().value;
          const oldest = state.rows.get(oldestKey);
          state.bytes = Math.max(0, state.bytes - (oldest?.bytes || 0));
          state.rows.delete(oldestKey);
        }
        state.rows.set(key, { row, until: Date.now() + 600000, bytes: rowBytes });
        state.bytes += rowBytes;
      }
    }
    return row;
  }).finally(() => state.pending.delete(key));
  state.pending.set(key, task);
  return task;
}
function computeVersion(row, width, format = 'webp') {
  const digest = row._digest || createHash('sha256').update(row.content).update('\0').update(row.mime_type).digest('hex');
  return createHash('sha256').update(digest).update('\0lossless-display-v1:' + (width || 'original') + (format !== 'webp' ? ':' + format : '')).digest('hex');
}
let queuedWarmTasks = 0;
function getMaxWarmRssBytes() {
  const envCap = Number(process.env.MAX_IMAGE_WARM_RSS_BYTES);
  return Number.isFinite(envCap) && envCap > 0 ? envCap : DEFAULT_MAX_WARM_RSS_BYTES;
}
async function warmPublicImage(row, targetWidths = widths, rawBuffer = null) {
  if (!row || !row.content || !row.mime_type || !row.mime_type.startsWith('image/')) return;
  if (!row._digest) {
    row._digest = createHash('sha256').update(row.content).update('\0').update(row.mime_type).digest('hex');
  }
  let cachedOriginal = rawBuffer;
  const loadOriginal = async () => {
    if (!cachedOriginal) cachedOriginal = await readMedia(row.content);
    return cachedOriginal;
  };
  for (const width of targetWidths) {
    if (!widths.includes(width)) continue;
    await new Promise(resolve => setImmediate(resolve));
    if (process.memoryUsage().rss > getMaxWarmRssBytes()) {
      skippedWarmByRssCount++;
      break;
    }
    const version = computeVersion(row, width);
    const webpBuffer = await cache.get(version, async () => {
      const diskWebp = await readDiskRendition(version);
      if (diskWebp) return diskWebp;
      return bounded(async () => {
        warmEncodeCount++;
        const original = await loadOriginal();
        const encoded = await sharp(original, { limitInputPixels: 24000000 }).rotate().resize({ width, withoutEnlargement: true }).webp({ lossless: true, effort: 1 }).toBuffer();
        await writeDiskRendition(version, encoded);
        return encoded;
      });
    });
    if (webpBuffer && webpBuffer.length >= 16 * 1024) {
      await new Promise(resolve => setImmediate(resolve));
      if (process.memoryUsage().rss > getMaxWarmRssBytes()) {
        skippedWarmByRssCount++;
        break;
      }
      const avifVersion = computeVersion(row, width, 'avif');
      await cache.get(avifVersion, async () => {
        const diskAvif = await readDiskRendition(avifVersion);
        if (diskAvif) return diskAvif;
        return bounded(async () => {
          warmEncodeCount++;
          const original = await loadOriginal();
          const encoded = await encodeAvif(original, { width, quality: width <= 480 ? 66 : 68 });
          await writeDiskRendition(avifVersion, encoded);
          return encoded;
        });
      });
    }
  }
}
function enqueueImageWarm(row, rawBuffer = null) {
  if (process.env.MEDIA_CACHE_ENABLED === 'false' || !row || !row.content || !row.mime_type?.startsWith('image/')) return;
  if (queuedWarmTasks >= 64) return;
  if (process.memoryUsage().rss > getMaxWarmRssBytes()) {
    skippedWarmByRssCount++;
    return;
  }
  queuedWarmTasks++;
  const timer = setTimeout(() => {
    void warmPublicImage(row, widths, rawBuffer)
      .catch(() => {})
      .finally(() => { queuedWarmTasks = Math.max(0, queuedWarmTasks - 1); });
  }, 0);
  timer.unref?.();
}
// Authorization belongs to the calling route and must run before this helper.
// GAERU P1-08 & P2-06: HTTP GET never invokes Sharp or AVIF runtime encoding on cache miss;
// it serves precomputed renditions when available or falls back to raw original bytes with true MIME.
async function sendPublicImage(req, res, row, namespace) {
  const requested = req.query.w;
  const width = requested === undefined ? null : widths.find(value => String(value) === requested);
  if (requested !== undefined && !width) return res.status(400).json({ error: 'Kích thước ảnh không được hỗ trợ.' });
  const cacheControl = 'private, max-age=300, stale-while-revalidate=3600, must-revalidate';
  const rawVersion = computeVersion(row, null);
  res.vary('Accept');

  if (!width) {
    if (req.query?.format === 'avif' && row.mime_type.startsWith('image/')) {
      const avifVersion = computeVersion(row, null, 'avif');
      let avifBytes = cache.peek(avifVersion);
      if (!avifBytes) avifBytes = await loadDiskRenditionIntoCache(avifVersion);
      if (avifBytes) {
        const etag = '"gaeru-' + namespace + '-' + req.params.id + '-' + avifVersion + '-avif"';
        res.type('image/avif').set({
          'Cache-Control': cacheControl,
          'ETag': etag,
          'X-Content-Type-Options': 'nosniff',
          'X-GAERU-Media-Storage': '2'
        });
        if (req.fresh) return res.status(304).end();
        return res.send(avifBytes);
      }
    }
    res.type(row.mime_type).set({
      'Cache-Control': cacheControl,
      'ETag': '"gaeru-' + namespace + '-' + req.params.id + '-' + rawVersion + '"',
      'X-Content-Type-Options': 'nosniff',
      'X-GAERU-Media-Storage': '2'
    });
    if (req.fresh) return res.status(304).end();
    const bytes = process.env.MEDIA_CACHE_ENABLED !== 'false' ? await cache.get(rawVersion, () => readMedia(row.content)) : await readMedia(row.content);
    return res.send(bytes);
  }

  const version = computeVersion(row, width);
  let webpBytes = cache.peek(version);
  if (!webpBytes) webpBytes = await loadDiskRenditionIntoCache(version);
  if (!webpBytes) {
    if (isDiskRenditionCacheEnabled()) enqueueImageWarm(row);
    const missCacheControl = 'private, max-age=30, stale-while-revalidate=60, must-revalidate';
    res.type(row.mime_type).set({
      'Cache-Control': missCacheControl,
      'ETag': '"gaeru-' + namespace + '-' + req.params.id + '-' + rawVersion + '"',
      'X-Content-Type-Options': 'nosniff',
      'X-GAERU-Media-Storage': '2'
    });
    if (req.fresh) return res.status(304).end();
    const rawBytes = process.env.MEDIA_CACHE_ENABLED !== 'false' ? await cache.get(rawVersion, () => readMedia(row.content)) : await readMedia(row.content);
    return res.send(rawBytes);
  }

  if (qualifiesForSelectiveAvif(req, webpBytes.length)) {
    const avifVersion = computeVersion(row, width, 'avif');
    let avifBytes = cache.peek(avifVersion);
    if (!avifBytes) avifBytes = await loadDiskRenditionIntoCache(avifVersion);
    if (avifBytes && avifBytes.length <= webpBytes.length * SAVINGS_RATIO) {
      const etag = '"gaeru-' + namespace + '-' + req.params.id + '-' + avifVersion + '-avif"';
      res.type('image/avif').set({
        'Cache-Control': cacheControl,
        'ETag': etag,
        'X-Content-Type-Options': 'nosniff',
        'X-GAERU-Media-Storage': '2'
      });
      if (req.fresh) return res.status(304).end();
      return res.send(avifBytes);
    }
  }

  res.type('image/webp').set({
    'Cache-Control': cacheControl,
    'ETag': '"gaeru-' + namespace + '-' + req.params.id + '-' + version + '"',
    'X-Content-Type-Options': 'nosniff',
    'X-GAERU-Media-Storage': '2'
  });
  if (req.fresh) return res.status(304).end();
  return res.send(webpBytes);
}
function getImageRenditionStats(pool = null) {
  const state = pool && typeof pool === 'object' ? poolRowCaches.get(pool) : null;
  return {
    getRuntimeEncodeCount,
    warmEncodeCount,
    skippedWarmByRssCount,
    diskCacheHits,
    queuedWarmTasks,
    activeEncodes: active,
    rowCacheEntries: state ? state.rows.size : 0,
    rowCacheBytes: state ? state.bytes : 0,
    maxRowCacheBytes: MAX_ROW_CACHE_BYTES,
    maxSingleRowCacheBytes: MAX_SINGLE_ROW_CACHE_BYTES
  };
}
function resetImageRenditionStats() {
  getRuntimeEncodeCount = 0;
  warmEncodeCount = 0;
  skippedWarmByRssCount = 0;
  diskCacheHits = 0;
}
module.exports = {
  sendPublicImage,
  widths,
  getCachedImageRow,
  clearImageLookupCache,
  clearAllImageLookupCaches,
  warmPublicImage,
  enqueueImageWarm,
  getImageRenditionStats,
  resetImageRenditionStats,
  MAX_ROW_CACHE_BYTES,
  resetRenditionCache: () => cache.clear()
};
