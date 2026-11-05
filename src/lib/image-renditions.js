'use strict';
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { readMedia } = require('./stored-media');
const { createObjectCache } = require('./object-cache');
const widths = [480, 800, 1200];
const cache = createObjectCache({ maxBytes: 96 * 1024 * 1024, maxEntryBytes: 8 * 1024 * 1024, ttl: 3600000, maxPending: 64 });
const poolRowCaches = new WeakMap();
let active = 0;
const waiting = [];
async function bounded(work) {
  if (active >= 4) await new Promise(resolve => waiting.push(resolve));
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
function computeVersion(row, width) {
  const digest = row._digest || createHash('sha256').update(row.content).update('\0').update(row.mime_type).digest('hex');
  return createHash('sha256').update(digest).update('\0lossless-display-v1:' + (width || 'original')).digest('hex');
}
async function warmPublicImage(row, targetWidths = [480, 800]) {
  if (!row || !row.content || !row.mime_type) return;
  if (!row._digest) {
    row._digest = createHash('sha256').update(row.content).update('\0').update(row.mime_type).digest('hex');
  }
  for (const width of targetWidths) {
    if (!widths.includes(width)) continue;
    const version = computeVersion(row, width);
    await cache.get(version, () => bounded(async () => {
      const original = await readMedia(row.content);
      return sharp(original, { limitInputPixels: 24000000 }).rotate().resize({ width, withoutEnlargement: true }).webp({ lossless: true, effort: 1 }).toBuffer();
    }));
  }
}
// Authorization belongs to the calling route and must run before this helper.
async function sendPublicImage(req, res, row, namespace) {
  const requested = req.query.w;
  const width = requested === undefined ? null : widths.find(value => String(value) === requested);
  if (requested !== undefined && !width) return res.status(400).json({ error: 'Kích thước ảnh không được hỗ trợ.' });
  const version = computeVersion(row, width);
  res.type(width ? 'image/webp' : row.mime_type).set({
    'Cache-Control': 'private, max-age=300, stale-while-revalidate=3600, must-revalidate',
    'ETag': '"gaeru-' + namespace + '-' + req.params.id + '-' + version + '"',
    'X-Content-Type-Options': 'nosniff',
    'X-GAERU-Media-Storage': '2'
  });
  if (req.fresh) return res.status(304).end();
  const bytes = width ? await cache.get(version, () => bounded(async () => {
    const original = await readMedia(row.content);
    return sharp(original, { limitInputPixels: 24000000 }).rotate().resize({ width, withoutEnlargement: true }).webp({ lossless: true, effort: 1 }).toBuffer();
  })) : (process.env.MEDIA_CACHE_ENABLED !== 'false' ? await cache.get(version, () => readMedia(row.content)) : await readMedia(row.content));
  return res.send(bytes);
}
module.exports = { sendPublicImage, widths, getCachedImageRow, clearImageLookupCache, warmPublicImage };
