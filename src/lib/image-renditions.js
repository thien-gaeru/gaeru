'use strict';
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { readMedia } = require('./stored-media');
const { createObjectCache } = require('./object-cache');
const widths = [480, 800, 1200];
const cache = createObjectCache({ maxBytes: 32 * 1024 * 1024, maxEntryBytes: 5 * 1024 * 1024, maxPending: 8 });
let active = 0;
const waiting = [];
async function bounded(work) {
  if (active >= 2) await new Promise(resolve => waiting.push(resolve));
  else active++;
  try { return await work(); }
  finally { const resume = waiting.shift(); if (resume) resume(); else active--; }
}
// Authorization belongs to the calling route and must run before this helper.
async function sendPublicImage(req, res, row, namespace) {
  const requested = req.query.w;
  const width = requested === undefined ? null : widths.find(value => String(value) === requested);
  if (requested !== undefined && !width) return res.status(400).json({ error: 'Kích thước ảnh không được hỗ trợ.' });
  const version = createHash('sha256').update(row.content).update('\0').update(row.mime_type).update('\0lossless-display-v1:' + (width || 'original')).digest('hex');
  res.type(width ? 'image/webp' : row.mime_type).set({
    'Cache-Control': 'private, max-age=60, must-revalidate',
    'ETag': '"gaeru-' + namespace + '-' + req.params.id + '-' + version + '"',
    'X-Content-Type-Options': 'nosniff',
    'X-GAERU-Media-Storage': '2'
  });
  if (req.fresh) return res.status(304).end();
  const bytes = width ? await cache.get(version, () => bounded(async () => {
    const original = await readMedia(row.content);
    return sharp(original, { limitInputPixels: 24000000 }).rotate().resize({ width, withoutEnlargement: true }).webp({ lossless: true, effort: 5 }).toBuffer();
  })) : await readMedia(row.content);
  return res.send(bytes);
}
module.exports = { sendPublicImage, widths };
