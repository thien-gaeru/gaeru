'use strict';
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { readMedia } = require('./stored-media');
const { createObjectCache } = require('./object-cache');
const { qualifiesForSelectiveAvif, encodeAvif, SAVINGS_RATIO } = require('./selective-avif');
const widths = [480, 800, 1200];
const cache = createObjectCache({ maxBytes: 32 * 1024 * 1024, maxEntryBytes: 4 * 1024 * 1024, ttl: 3600000, maxPending: 64 });
const poolRowCaches = new WeakMap();
let active = 0;
const waiting = [];
async function bounded(work) {
  if (active >= 1) await new Promise(resolve => waiting.push(resolve));
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
    state = { rows: new Map(), pending: new Map() };
    poolRowCaches.set(pool, state);
  }
  return state;
}
function clearImageLookupCache(pool) {
  if (pool && typeof pool === 'object') {
    const state = poolRowCaches.get(pool);
    if (state) {
      state.rows.clear();
      state.pending.clear();
    }
  }
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
  if (hit) state.rows.delete(key);
  if (state.pending.has(key)) return state.pending.get(key);
  const task = Promise.resolve().then(loader).then(row => {
    if (row) {
      if (row.content !== undefined && row.mime_type) {
        row._digest = createHash('sha256').update(row.content).update('\0').update(row.mime_type).digest('hex');
      }
      if (state.rows.size >= 512) state.rows.delete(state.rows.keys().next().value);
      state.rows.set(key, { row, until: Date.now() + 600000 });
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
async function warmPublicImage(row, targetWidths = [480, 800]) {
  if (!row || !row.content || !row.mime_type) return;
  if (!row._digest) {
    row._digest = createHash('sha256').update(row.content).update('\0').update(row.mime_type).digest('hex');
  }
  for (const width of targetWidths) {
    if (!widths.includes(width)) continue;
    const version = computeVersion(row, width);
    const webpBuffer = await cache.get(version, () => bounded(async () => {
      const original = await readMedia(row.content);
      return sharp(original, { limitInputPixels: 24000000 }).rotate().resize({ width, withoutEnlargement: true }).webp({ lossless: true, effort: 1 }).toBuffer();
    }));
    if (webpBuffer && webpBuffer.length >= 16 * 1024) {
      const avifVersion = computeVersion(row, width, 'avif');
      await cache.get(avifVersion, () => bounded(async () => {
        const original = await readMedia(row.content);
        return encodeAvif(original, { width, quality: width <= 480 ? 66 : 68, effort: 2 });
      }));
    }
  }
}
// Authorization belongs to the calling route and must run before this helper.
async function sendPublicImage(req, res, row, namespace) {
  const requested = req.query.w;
  const width = requested === undefined ? null : widths.find(value => String(value) === requested);
  if (requested !== undefined && !width) return res.status(400).json({ error: 'Kích thước ảnh không được hỗ trợ.' });
  const cacheControl = 'private, max-age=300, stale-while-revalidate=3600, must-revalidate';
  const version = computeVersion(row, width);
  res.vary('Accept');

  if (!width) {
    if (req.query?.format === 'avif' && row.mime_type.startsWith('image/')) {
      const avifVersion = computeVersion(row, null, 'avif');
      const avifBytes = await cache.get(avifVersion, () => bounded(async () => {
        const original = await readMedia(row.content);
        return encodeAvif(original, { quality: 70, effort: 2 });
      }));
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
    res.type(row.mime_type).set({
      'Cache-Control': cacheControl,
      'ETag': '"gaeru-' + namespace + '-' + req.params.id + '-' + version + '"',
      'X-Content-Type-Options': 'nosniff',
      'X-GAERU-Media-Storage': '2'
    });
    if (req.fresh) return res.status(304).end();
    const bytes = process.env.MEDIA_CACHE_ENABLED !== 'false' ? await cache.get(version, () => readMedia(row.content)) : await readMedia(row.content);
    return res.send(bytes);
  }

  const webpBytes = await cache.get(version, () => bounded(async () => {
    const original = await readMedia(row.content);
    return sharp(original, { limitInputPixels: 24000000 }).rotate().resize({ width, withoutEnlargement: true }).webp({ lossless: true, effort: 1 }).toBuffer();
  }));

  if (qualifiesForSelectiveAvif(req, webpBytes.length)) {
    const avifVersion = computeVersion(row, width, 'avif');
    const avifBytes = await cache.get(avifVersion, () => bounded(async () => {
      const original = await readMedia(row.content);
      return encodeAvif(original, { width, quality: width <= 480 ? 66 : 68, effort: 2 });
    }));
    if (avifBytes.length <= webpBytes.length * SAVINGS_RATIO) {
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
module.exports = { sendPublicImage, widths, getCachedImageRow, clearImageLookupCache, warmPublicImage };
